//! `net_fetch`: the only way the app talks to the outside world.
//!
//! One policy, two transports:
//! - **policy** (this module): HTTPS only, allowlisted hosts (see docs/NETWORK.md), header
//!   filtering, API-key injection, redirects only to allowlisted hosts (max 3), 5 MB body cap,
//!   20 s timeout, CoinGecko cache and 429 backoff;
//! - **transport**: Tor (default, see `tor.rs`, fail closed) or clear (`reqwest`), chosen by
//!   the user's settings. There is never a silent fallback from Tor to clear.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use wallet_core::Network;

use crate::settings::{ApiKeys, Settings};
use crate::tor::TorManager;

pub const ALLOWED_HOSTS: &[&str] = &[
    "api.coingecko.com",
    "pro-api.coingecko.com",
    "mempool.space",
    // Litecoin (Esplora/mempool API, mainnet + testnet4): only Rust's `ltc_*` commands use it.
    "litecoinspace.org",
    // TRON (TronGrid, java-tron HTTP API): mainnet and Nile; only Rust's `tron_*` commands.
    "api.trongrid.io",
    "nile.trongrid.io",
    // XRP Ledger JSON-RPC (testnet :51234, mainnet): only Rust's `xrp_*` commands.
    "s.altnet.rippletest.net",
    "xrplcluster.com",
    // Cardano (Koios REST, keyless public tier): preprod and mainnet; only Rust's `ada_*` commands.
    "preprod.koios.rest",
    "api.koios.rest",
    "ethereum-sepolia-rpc.publicnode.com",
    "ethereum-rpc.publicnode.com",
    "arbitrum-one-rpc.publicnode.com",
    "optimism-rpc.publicnode.com",
    "base-rpc.publicnode.com",
    "polygon-bor-rpc.publicnode.com",
    "bsc-rpc.publicnode.com",
    "avalanche-c-chain-rpc.publicnode.com",
    "api.devnet.solana.com",
    "api.mainnet-beta.solana.com",
    "api.0x.org",
    "li.quest",
    "lite-api.jup.ag",
];

/// mempool.space's official onion service. Source: the `Onion-Location` response header
/// served by https://mempool.space/ (checked 2026-10-30), see docs/NETWORK.md.
pub const MEMPOOL_ONION: &str = "mempoolhqx4isw62xs7abwphsq7ldayuidyx2v2oethdhhj6mlo2r6ad.onion";

/// Onion services we may reach — ONLY over Tor, and only these. Plain `http://` is accepted
/// for them because the onion protocol authenticates the service key (the address *is* the
/// key) and encrypts end to end, which is what TLS provides for clearnet hosts.
pub const ONION_HOSTS: &[&str] = &[MEMPOOL_ONION];

/// Clearnet hosts that, in Tor mode, are transparently replaced by their onion service
/// (same scheme-less path and query), so no exit relay is involved at all.
const ONION_REWRITES: &[(&str, &str)] = &[("mempool.space", MEMPOOL_ONION)];

/// Request headers the webview may set. Everything else is dropped.
const ALLOWED_HEADERS: &[&str] = &["accept", "content-type", "0x-version"];

pub const MAX_BODY: usize = 5 * 1024 * 1024;
pub const TIMEOUT: Duration = Duration::from_secs(20);
pub const MAX_REDIRECTS: usize = 3;
const CACHE_TTL: Duration = Duration::from_secs(60);
const BACKOFF_429: Duration = Duration::from_secs(30);
pub const USER_AGENT: &str = concat!("Kyro/", env!("CARGO_PKG_VERSION"));

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchRequest {
    pub url: String,
    pub method: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default)]
    pub body: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FetchResponse {
    pub status: u16,
    pub body: String,
}

/// Env keys (dev) take precedence over keys saved in settings.
#[derive(Debug, Clone, Default)]
pub struct EnvKeys {
    pub coingecko: Option<String>,
    pub zerox: Option<String>,
    pub lifi: Option<String>,
    pub jupiter: Option<String>,
    pub trongrid: Option<String>,
}

impl EnvKeys {
    pub fn from_env() -> Self {
        let get = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());
        Self {
            coingecko: get("KYRO_COINGECKO_API_KEY"),
            zerox: get("KYRO_ZEROX_API_KEY"),
            lifi: get("KYRO_LIFI_API_KEY"),
            jupiter: get("KYRO_JUPITER_API_KEY"),
            trongrid: get("KYRO_TRONGRID_API_KEY"),
        }
    }
}

// ---------------------------------------------------------------- policy

/// Per-request network context derived from the settings and the app's network.
#[derive(Debug, Clone, Default)]
pub struct NetContext {
    /// Requests go over Tor (settings.tor.enabled).
    pub tor: bool,
    /// Custom HTTP servers' hosts (EVM/Solana RPC, Esplora), each with its own family only.
    pub custom: Vec<(String, Family)>,
    /// Default hosts replaced by a custom server: refused (`DEFAULT_SERVER_DISABLED`).
    pub disabled: Vec<&'static str>,
}

impl NetContext {
    pub fn from_settings(s: &Settings, net: Network) -> Self {
        Self {
            tor: s.tor.enabled,
            custom: s.servers.custom_http_hosts(),
            disabled: s.servers.disabled_defaults(net),
        }
    }

    fn custom_family(&self, host: &str) -> Option<Family> {
        self.custom.iter().find(|(h, _)| h == host).map(|(_, f)| *f)
    }
}

/// Scheme rule shared by requests and redirects: HTTPS for clearnet hosts; `.onion` only over
/// Tor, and only allowlisted ones (mempool's, plain `http://`; or a user's own onion server,
/// `http://` or `https://`); any `.onion` is refused in clear.
fn scheme_ok(url: &url::Url, host: &str, tor: bool, custom_onion: bool) -> Result<(), String> {
    if host.ends_with(".onion") {
        if !tor {
            return Err(format!("{host} (adresse .onion refusée hors Tor)"));
        }
        if ONION_HOSTS.contains(&host) {
            if url.scheme() != "http" {
                return Err(format!("{url} (service onion : http:// attendu)"));
            }
            return Ok(());
        }
        if custom_onion && matches!(url.scheme(), "http" | "https") {
            return Ok(());
        }
        return Err(host.to_owned());
    }
    if url.scheme() != "https" {
        return Err(format!("{url} (HTTPS obligatoire)"));
    }
    Ok(())
}

/// Redirects are followed only to allowlisted hosts (never to user RPC hosts), with the same
/// scheme rule as requests, at most [`MAX_REDIRECTS`] times. Shared by both transports.
pub fn redirect_allowed(next: &url::Url, hops_done: usize, tor: bool) -> bool {
    let Some(host) = next.host_str() else {
        return false;
    };
    hops_done < MAX_REDIRECTS
        && (ALLOWED_HOSTS.contains(&host) || ONION_HOSTS.contains(&host))
        && scheme_ok(next, host, tor, false).is_ok()
}

/// In Tor mode, rewrites `https://mempool.space/...` to `http://<mempool onion>/...`.
pub fn onion_rewrite(url: &mut url::Url) -> AppResult<()> {
    let Some(host) = url.host_str() else {
        return Ok(());
    };
    if url.scheme() != "https" || url.port().is_some() {
        return Ok(());
    }
    if let Some((_, onion)) = ONION_REWRITES.iter().find(|(clear, _)| *clear == host) {
        url.set_scheme("http")
            .and_then(|()| url.set_host(Some(onion)).map_err(|_| ()))
            .map_err(|()| AppError::Internal("réécriture .onion impossible".into()))?;
    }
    Ok(())
}

/// Activity family, used by Tor to put each family on its own isolated circuits so a server
/// (or an exit relay) cannot link, say, your Bitcoin and your Solana activity by circuit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Family {
    Bitcoin,
    Litecoin,
    Dogecoin,
    Tron,
    Xrp,
    Cardano,
    Evm,
    Solana,
    Market,
    Swap,
    Other,
}

pub fn family_for(host: &str, ctx: &NetContext) -> Family {
    if let Some(f) = ctx.custom_family(host) {
        return f;
    }
    if host == "mempool.space" || host == MEMPOOL_ONION {
        Family::Bitcoin
    } else if host == "litecoinspace.org" {
        Family::Litecoin
    } else if host.ends_with("trongrid.io") {
        Family::Tron
    } else if host == "s.altnet.rippletest.net" || host == "xrplcluster.com" {
        Family::Xrp
    } else if host == "preprod.koios.rest" || host == "api.koios.rest" {
        Family::Cardano
    } else if host.ends_with("-rpc.publicnode.com") {
        Family::Evm
    } else if host.ends_with(".solana.com") {
        Family::Solana
    } else if host.ends_with("coingecko.com") {
        Family::Market
    } else if matches!(host, "api.0x.org" | "li.quest" | "lite-api.jup.ag") {
        Family::Swap
    } else {
        Family::Other
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
}

impl Method {
    pub fn as_str(self) -> &'static str {
        match self {
            Method::Get => "GET",
            Method::Post => "POST",
        }
    }
}

/// A request that passed the policy: what the transport will actually send.
#[derive(Debug, Clone)]
pub struct Prepared {
    pub url: url::Url,
    pub host: String,
    pub method: Method,
    /// Filtered webview headers followed by injected API-key headers (lower-case names).
    pub headers: Vec<(String, String)>,
    /// Names of the injected API-key headers (dropped if a redirect changes host).
    pub secret_headers: Vec<String>,
    /// Raw request body (JSON text, hex text, or binary CBOR for Koios `submittx`).
    pub body: Option<Vec<u8>>,
    /// Tor family whose isolated circuits carry this request.
    pub family: Family,
    /// The host is a user-configured server: transport failures are `SERVER_UNREACHABLE`.
    pub custom: bool,
    /// Plain HTTP allowed for this (onion) host, over Tor only.
    pub allow_plain: bool,
}

pub fn prepare(
    req: FetchRequest,
    ctx: &NetContext,
    env: &EnvKeys,
    saved: &ApiKeys,
) -> AppResult<Prepared> {
    let mut url =
        url::Url::parse(&req.url).map_err(|_| AppError::InvalidInput("URL invalide".into()))?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err(AppError::InvalidInput(
            "URL avec identifiants refusée".into(),
        ));
    }
    if ctx.tor {
        onion_rewrite(&mut url)?;
    }
    let host = url.host_str().unwrap_or_default().to_owned();
    if let Some(d) = ctx.disabled.iter().find(|d| **d == host) {
        return Err(AppError::DefaultServerDisabled((*d).to_owned()));
    }
    let custom = ctx.custom_family(&host).is_some();
    let is_onion = host.ends_with(".onion");
    if !is_onion && !custom && !ALLOWED_HOSTS.contains(&host.as_str()) {
        return Err(AppError::HostNotAllowed(host));
    }
    scheme_ok(&url, &host, ctx.tor, custom).map_err(AppError::HostNotAllowed)?;
    let method = match req.method.to_ascii_uppercase().as_str() {
        "GET" => Method::Get,
        "POST" => Method::Post,
        _ => return Err(AppError::InvalidInput("méthode HTTP non autorisée".into())),
    };
    let mut headers: Vec<(String, String)> = req
        .headers
        .into_iter()
        .map(|(k, v)| (k.to_ascii_lowercase(), v))
        .filter(|(k, v)| ALLOWED_HEADERS.contains(&k.as_str()) && !v.contains(['\r', '\n']))
        .collect();
    headers.sort();
    let secrets = api_key_headers(&host, env, saved);
    let secret_headers = secrets.iter().map(|(k, _)| k.clone()).collect();
    headers.extend(secrets);
    Ok(Prepared {
        allow_plain: is_onion && url.scheme() == "http",
        family: family_for(&host, ctx),
        url,
        host,
        method,
        headers,
        secret_headers,
        body: req.body.map(String::into_bytes),
        custom,
    })
}

/// A request issued by Rust itself to a server (Esplora, Bitcoin Core, validation probes).
/// The caller has validated the URL with `servers::validate_http_url`.
#[derive(Debug, Clone)]
pub struct ServerRequest {
    pub url: url::Url,
    pub method: Method,
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
    pub family: Family,
    /// Bitcoin Core on loopback/LAN: reached directly (Tor cannot reach the user's LAN).
    pub direct_private: bool,
    /// Longer timeout (Bitcoin Core `importdescriptors` with rescan; direct connections only).
    pub long: bool,
}

impl ServerRequest {
    pub fn get(url: url::Url, family: Family) -> Self {
        Self {
            url,
            method: Method::Get,
            headers: Vec::new(),
            body: None,
            family,
            direct_private: false,
            long: false,
        }
    }

    pub fn post_json(url: url::Url, family: Family, body: String) -> Self {
        Self {
            url,
            method: Method::Post,
            headers: vec![("content-type".into(), "application/json".into())],
            body: Some(body.into_bytes()),
            family,
            direct_private: false,
            long: false,
        }
    }

    /// POST of raw bytes with an explicit content type (Koios `submittx`: `application/cbor`).
    pub fn post_bytes(url: url::Url, family: Family, content_type: &str, body: Vec<u8>) -> Self {
        Self {
            url,
            method: Method::Post,
            headers: vec![("content-type".into(), content_type.into())],
            body: Some(body),
            family,
            direct_private: false,
            long: false,
        }
    }
}

/// API keys are injected here so they never need to live in the webview. Also used for the
/// requests Rust issues itself to TronGrid (`tron_backend`).
pub fn api_key_headers(host: &str, env: &EnvKeys, saved: &ApiKeys) -> Vec<(String, String)> {
    let pick = |e: &Option<String>, s: &Option<String>| e.clone().or_else(|| s.clone());
    let (name, value) = match host {
        "api.coingecko.com" => ("x-cg-demo-api-key", pick(&env.coingecko, &saved.coingecko)),
        "pro-api.coingecko.com" => ("x-cg-pro-api-key", pick(&env.coingecko, &saved.coingecko)),
        "api.0x.org" => ("0x-api-key", pick(&env.zerox, &saved.zerox)),
        "li.quest" => ("x-lifi-api-key", env.lifi.clone()),
        "lite-api.jup.ag" => ("x-api-key", env.jupiter.clone()),
        "api.trongrid.io" | "nile.trongrid.io" => {
            ("tron-pro-api-key", pick(&env.trongrid, &saved.trongrid))
        }
        _ => return Vec::new(),
    };
    value
        .filter(|v| !v.contains(['\r', '\n']))
        .map(|v| vec![(name.to_owned(), v)])
        .unwrap_or_default()
}

/// Accumulates a response body, refusing anything over [`MAX_BODY`].
#[derive(Default)]
pub struct BodyCap {
    buf: Vec<u8>,
}

impl BodyCap {
    pub fn push(&mut self, chunk: &[u8]) -> AppResult<()> {
        if self.buf.len() + chunk.len() > MAX_BODY {
            return Err(AppError::Internal("réponse trop volumineuse".into()));
        }
        self.buf.extend_from_slice(chunk);
        Ok(())
    }

    pub fn into_inner(self) -> Vec<u8> {
        self.buf
    }
}

pub fn is_cacheable(p: &Prepared) -> bool {
    p.method == Method::Get && p.host.ends_with("coingecko.com")
}

// ---------------------------------------------------------------- client

pub struct NetClient {
    clear: reqwest::Client,
    /// For a Bitcoin Core node on loopback/LAN only: no proxy, no redirect, http allowed.
    local: reqwest::Client,
    pub tor: Arc<TorManager>,
    cache: Mutex<HashMap<String, (Instant, FetchResponse)>>,
    backoff: Mutex<HashMap<String, Instant>>,
}

const LONG_TIMEOUT: Duration = Duration::from_secs(6 * 3600);

impl NetClient {
    pub fn new(tor_dir: PathBuf) -> AppResult<Self> {
        let clear = reqwest::Client::builder()
            .timeout(TIMEOUT)
            .https_only(true)
            .no_proxy()
            .user_agent(USER_AGENT)
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                // `previous()` includes the original URL: redirects already followed = len - 1.
                if redirect_allowed(
                    attempt.url(),
                    attempt.previous().len().saturating_sub(1),
                    false,
                ) {
                    attempt.follow()
                } else {
                    attempt.stop()
                }
            }))
            .build()
            .map_err(|e| AppError::Internal(e.to_string()))?;
        let local = reqwest::Client::builder()
            .timeout(TIMEOUT)
            .no_proxy()
            .user_agent(USER_AGENT)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| AppError::Internal(e.to_string()))?;
        Ok(Self {
            clear,
            local,
            tor: Arc::new(TorManager::new(tor_dir)?),
            cache: Mutex::new(HashMap::new()),
            backoff: Mutex::new(HashMap::new()),
        })
    }

    /// Webview requests (`net_fetch`): applies the policy, then sends over Tor (if enabled)
    /// or in clear.
    pub async fn fetch(
        &self,
        req: FetchRequest,
        settings: &Settings,
        env: &EnvKeys,
        net: Network,
    ) -> AppResult<FetchResponse> {
        let ctx = NetContext::from_settings(settings, net);
        let p = prepare(req, &ctx, env, &settings.api_keys)?;

        if let Some(until) = lock(&self.backoff).get(&p.host).copied() {
            let now = Instant::now();
            if until > now {
                return Err(AppError::RateLimited((until - now).as_secs().max(1)));
            }
        }
        let cacheable = is_cacheable(&p);
        let cache_key = p.url.to_string();
        if cacheable {
            if let Some((at, resp)) = lock(&self.cache).get(&cache_key) {
                if at.elapsed() < CACHE_TTL {
                    return Ok(resp.clone());
                }
            }
        }

        let sent = if ctx.tor {
            self.tor.send(&p).await
        } else {
            self.send_clear(&self.clear, &p, None).await
        };
        let (status, bytes) = match sent {
            Err(e) if p.custom && !matches!(e, AppError::TorUnavailable(_)) => {
                return Err(AppError::ServerUnreachable(format!("{} : {e}", p.host)))
            }
            other => other?,
        };

        if status == 429 {
            lock(&self.backoff).insert(p.host.clone(), Instant::now() + BACKOFF_429);
        }
        let out = FetchResponse {
            status,
            body: String::from_utf8_lossy(&bytes).into_owned(),
        };
        if cacheable && status == 200 {
            lock(&self.cache).insert(cache_key, (Instant::now(), out.clone()));
        }
        Ok(out)
    }

    /// Requests issued by Rust to a server (custom or default). Same transport rules:
    /// Tor when enabled (onion allowed), clear HTTPS otherwise; Bitcoin Core on a private
    /// address goes direct. Transport failures map to `SERVER_UNREACHABLE` (never a fallback).
    pub async fn server_request(&self, r: ServerRequest, tor: bool) -> AppResult<(u16, Vec<u8>)> {
        let mut url = r.url.clone();
        if tor {
            onion_rewrite(&mut url)?;
        }
        let host = url
            .host_str()
            .ok_or_else(|| AppError::ServerInvalid("URL sans hôte".into()))?
            .to_owned();
        let onion = host.ends_with(".onion");
        let private = crate::servers::is_private_host(&host);
        let p = Prepared {
            allow_plain: onion && url.scheme() == "http",
            url,
            host: host.clone(),
            method: r.method,
            headers: r.headers,
            secret_headers: Vec::new(),
            body: r.body,
            family: r.family,
            custom: true,
        };
        let result = if r.direct_private && private {
            let timeout = r.long.then_some(LONG_TIMEOUT);
            self.send_clear(&self.local, &p, timeout).await
        } else if onion {
            if !tor {
                return Err(AppError::ServerInvalid(format!(
                    "{host} : adresse .onion refusée hors Tor"
                )));
            }
            self.tor.send(&p).await
        } else {
            if p.url.scheme() != "https" {
                return Err(AppError::ServerInvalid(format!(
                    "{} : HTTPS obligatoire",
                    p.url
                )));
            }
            if tor {
                self.tor.send(&p).await
            } else {
                self.send_clear(&self.clear, &p, None).await
            }
        };
        result.map_err(|e| match e {
            AppError::TorUnavailable(_) | AppError::ServerInvalid(_) => e,
            other => AppError::ServerUnreachable(format!("{host} : {other}")),
        })
    }

    async fn send_clear(
        &self,
        client: &reqwest::Client,
        p: &Prepared,
        timeout: Option<Duration>,
    ) -> AppResult<(u16, Vec<u8>)> {
        let method = match p.method {
            Method::Get => reqwest::Method::GET,
            Method::Post => reqwest::Method::POST,
        };
        let mut builder = client.request(method, p.url.clone());
        if let Some(t) = timeout {
            builder = builder.timeout(t);
        }
        for (k, v) in &p.headers {
            builder = builder.header(k, v);
        }
        if let Some(body) = &p.body {
            builder = builder.body(body.clone());
        }
        let net_err =
            |e: reqwest::Error| AppError::Internal(format!("réseau : {}", e.without_url()));
        let mut resp = builder.send().await.map_err(net_err)?;
        let status = resp.status().as_u16();
        let mut cap = BodyCap::default();
        while let Some(chunk) = resp.chunk().await.map_err(net_err)? {
            cap.push(&chunk)?;
        }
        Ok((status, cap.into_inner()))
    }
}

pub fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(url: &str, method: &str, headers: &[(&str, &str)]) -> FetchRequest {
        FetchRequest {
            url: url.into(),
            method: method.into(),
            headers: headers
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            body: None,
        }
    }

    fn keys() -> (EnvKeys, ApiKeys) {
        (
            EnvKeys {
                coingecko: Some("cg-key".into()),
                ..Default::default()
            },
            ApiKeys {
                zerox: Some("zx".into()),
                ..Default::default()
            },
        )
    }

    fn ctx(tor: bool) -> NetContext {
        NetContext {
            tor,
            ..Default::default()
        }
    }

    fn prep(url: &str, c: &NetContext) -> AppResult<Prepared> {
        let (env, saved) = keys();
        prepare(req(url, "GET", &[]), c, &env, &saved)
    }

    #[test]
    fn allowlist() {
        let c = ctx(false);
        assert!(prep("https://mempool.space/api", &c).is_ok());
        assert!(matches!(
            prep("https://evil.example/", &c),
            Err(AppError::HostNotAllowed(_))
        ));
        assert!(matches!(
            prep("https://mempool.space.evil.example/", &c),
            Err(AppError::HostNotAllowed(_))
        ));
        let custom = NetContext {
            custom: vec![("my-node.example".into(), Family::Evm)],
            ..ctx(false)
        };
        let p = prep("https://my-node.example/rpc", &custom).unwrap();
        assert!(p.custom);
        assert_eq!(p.family, Family::Evm);
        assert!(!prep("https://mempool.space/api", &custom).unwrap().custom);
    }

    #[test]
    fn prepare_enforces_policy() {
        let (env, saved) = keys();
        let c = ctx(false);
        let ok = |r| prepare(r, &c, &env, &saved);
        assert!(matches!(
            ok(req("http://mempool.space/api", "GET", &[])),
            Err(AppError::HostNotAllowed(_))
        ));
        assert!(matches!(
            ok(req("https://mempool.space/", "DELETE", &[])),
            Err(AppError::InvalidInput(_))
        ));
        assert!(matches!(
            ok(req("https://user:pw@mempool.space/", "GET", &[])),
            Err(AppError::InvalidInput(_))
        ));
        assert!(ok(req("not a url", "GET", &[])).is_err());
        let p = ok(req("https://mempool.space/api", "get", &[])).unwrap();
        assert_eq!(p.method, Method::Get);
        assert_eq!(p.host, "mempool.space");
        assert_eq!(p.family, Family::Bitcoin);
    }

    #[test]
    fn header_filtering_and_key_injection() {
        let (env, saved) = keys();
        let c = ctx(false);
        let p = prepare(
            req(
                "https://api.coingecko.com/api/v3/ping",
                "GET",
                &[
                    ("Accept", "application/json"),
                    ("Cookie", "x=1"),
                    ("Authorization", "Bearer stolen"),
                    ("x-cg-demo-api-key", "from-ui"),
                    ("Content-Type", "a\r\nInjected: 1"),
                ],
            ),
            &c,
            &env,
            &saved,
        )
        .unwrap();
        assert_eq!(
            p.headers,
            vec![
                ("accept".to_string(), "application/json".to_string()),
                ("x-cg-demo-api-key".to_string(), "cg-key".to_string()),
            ]
        );
        assert_eq!(p.secret_headers, vec!["x-cg-demo-api-key".to_string()]);
        // A key saved in settings (no env key): 0x.
        let p = prep("https://api.0x.org/swap", &c).unwrap();
        assert_eq!(
            p.headers,
            vec![("0x-api-key".to_string(), "zx".to_string())]
        );
        // 1inch is gone: not on the allowlist any more.
        assert!(prep("https://api.1inch.dev/swap", &c).is_err());
        let p = prep("https://mempool.space/", &c).unwrap();
        assert!(p.headers.is_empty() && p.secret_headers.is_empty());
        // TronGrid key: TronGrid hosts only, from the env first, then the settings.
        let env = EnvKeys {
            trongrid: Some("tg-env".into()),
            ..Default::default()
        };
        let saved = ApiKeys {
            trongrid: Some("tg-saved".into()),
            ..Default::default()
        };
        assert_eq!(
            api_key_headers("nile.trongrid.io", &env, &saved),
            vec![("tron-pro-api-key".to_string(), "tg-env".to_string())]
        );
        assert_eq!(
            api_key_headers("api.trongrid.io", &EnvKeys::default(), &saved),
            vec![("tron-pro-api-key".to_string(), "tg-saved".to_string())]
        );
        assert!(api_key_headers("my-tron-node.example", &env, &saved).is_empty());
        assert!(api_key_headers("api.shasta.trongrid.io", &env, &saved).is_empty());
    }

    #[test]
    fn redirect_policy() {
        let u = |s: &str| url::Url::parse(s).unwrap();
        for tor in [false, true] {
            assert!(redirect_allowed(&u("https://mempool.space/x"), 0, tor));
            assert!(redirect_allowed(&u("https://mempool.space/x"), 2, tor));
            assert!(!redirect_allowed(&u("https://mempool.space/x"), 3, tor));
            assert!(!redirect_allowed(&u("http://mempool.space/x"), 0, tor));
            assert!(!redirect_allowed(&u("https://evil.example/x"), 0, tor));
            // User RPC hosts are never redirect targets.
            assert!(!redirect_allowed(&u("https://my-node.example/"), 0, tor));
        }
        let onion = format!("http://{MEMPOOL_ONION}/api");
        assert!(redirect_allowed(&u(&onion), 0, true));
        assert!(!redirect_allowed(&u(&onion), 0, false));
        assert!(!redirect_allowed(
            &u(&format!("https://{MEMPOOL_ONION}/api")),
            0,
            true
        ));
        assert!(!redirect_allowed(
            &u("http://duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion/"),
            0,
            true
        ));
    }

    #[test]
    fn onion_policy() {
        let tor = ctx(true);
        let clear = ctx(false);
        let p = prep(
            "https://mempool.space/testnet4/api/address/tb1qx/utxo?x=1",
            &tor,
        )
        .unwrap();
        assert_eq!(
            p.url.as_str(),
            format!("http://{MEMPOOL_ONION}/testnet4/api/address/tb1qx/utxo?x=1")
        );
        assert_eq!(p.host, MEMPOOL_ONION);
        assert_eq!(p.family, Family::Bitcoin);
        assert!(p.allow_plain);
        let p = prep("https://mempool.space/api/blocks/tip/height", &clear).unwrap();
        assert_eq!(
            p.url.as_str(),
            "https://mempool.space/api/blocks/tip/height"
        );
        assert!(!p.allow_plain);
        assert_eq!(
            prep("https://api.coingecko.com/api/v3/ping", &tor)
                .unwrap()
                .url
                .scheme(),
            "https"
        );

        let onion = format!("http://{MEMPOOL_ONION}/api/blocks/tip/height");
        assert!(prep(&onion, &tor).is_ok());
        assert!(matches!(
            prep(&onion, &clear),
            Err(AppError::HostNotAllowed(_))
        ));
        assert!(matches!(
            prep(&format!("https://{MEMPOOL_ONION}/api"), &tor),
            Err(AppError::HostNotAllowed(_))
        ));
        for c in [&clear, &tor] {
            assert!(matches!(
                prep(
                    "http://duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion/",
                    c
                ),
                Err(AppError::HostNotAllowed(_))
            ));
            assert!(matches!(
                prep("http://mempool.space/api", c),
                Err(AppError::HostNotAllowed(_))
            ));
            assert!(matches!(
                prep("http://api.coingecko.com/api/v3/ping", c),
                Err(AppError::HostNotAllowed(_))
            ));
        }
        let p = prep("https://mempool.space:8443/api", &tor).unwrap();
        assert_eq!(p.url.scheme(), "https");
    }

    #[test]
    fn custom_onion_server_only_over_tor_and_only_its_family() {
        let host = "abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuv.onion";
        let mk = |tor| NetContext {
            tor,
            custom: vec![(host.into(), Family::Bitcoin)],
            disabled: Vec::new(),
        };
        let p = prep(&format!("http://{host}/api/blocks/tip/height"), &mk(true)).unwrap();
        assert!(p.custom && p.allow_plain);
        assert_eq!(p.family, Family::Bitcoin);
        assert!(prep(&format!("https://{host}/api"), &mk(true)).is_ok());
        assert!(matches!(
            prep(&format!("http://{host}/api"), &mk(false)),
            Err(AppError::HostNotAllowed(_))
        ));
    }

    #[test]
    fn defaults_replaced_by_a_custom_server_are_refused() {
        let c = NetContext {
            tor: true,
            custom: vec![("my-esplora.example".into(), Family::Bitcoin)],
            disabled: vec![
                "mempool.space",
                MEMPOOL_ONION,
                "ethereum-sepolia-rpc.publicnode.com",
            ],
        };
        for url in [
            "https://mempool.space/testnet4/api/blocks/tip/height".to_string(),
            format!("http://{MEMPOOL_ONION}/api"),
            "https://ethereum-sepolia-rpc.publicnode.com/".to_string(),
        ] {
            assert!(
                matches!(prep(&url, &c), Err(AppError::DefaultServerDisabled(_))),
                "{url}"
            );
        }
        // Other defaults are untouched.
        assert!(prep("https://ethereum-rpc.publicnode.com/", &c).is_ok());
        assert!(prep("https://my-esplora.example/api", &c).is_ok());
    }

    #[test]
    fn body_cap() {
        let mut cap = BodyCap::default();
        cap.push(&vec![0u8; MAX_BODY - 1]).unwrap();
        cap.push(&[1]).unwrap();
        assert!(cap.push(&[2]).is_err());
        assert_eq!(cap.into_inner().len(), MAX_BODY);
    }

    #[test]
    fn families_are_isolated() {
        let c = NetContext {
            custom: vec![
                ("eth.my-node.example".into(), Family::Evm),
                ("btc.my-node.example".into(), Family::Bitcoin),
            ],
            ..ctx(true)
        };
        assert_eq!(family_for("mempool.space", &c), Family::Bitcoin);
        assert_eq!(family_for(MEMPOOL_ONION, &c), Family::Bitcoin);
        assert_eq!(family_for("btc.my-node.example", &c), Family::Bitcoin);
        assert_eq!(
            family_for("ethereum-sepolia-rpc.publicnode.com", &c),
            Family::Evm
        );
        assert_eq!(family_for("eth.my-node.example", &c), Family::Evm);
        assert_eq!(family_for("api.devnet.solana.com", &c), Family::Solana);
        assert_eq!(family_for("api.coingecko.com", &c), Family::Market);
        assert_eq!(family_for("lite-api.jup.ag", &c), Family::Swap);
        assert_eq!(family_for("litecoinspace.org", &c), Family::Litecoin);
        assert_eq!(family_for("nile.trongrid.io", &c), Family::Tron);
        assert_eq!(family_for("api.trongrid.io", &c), Family::Tron);
        assert_eq!(family_for("s.altnet.rippletest.net", &c), Family::Xrp);
        assert_eq!(family_for("xrplcluster.com", &c), Family::Xrp);
        assert_eq!(family_for("preprod.koios.rest", &c), Family::Cardano);
        assert_eq!(family_for("api.koios.rest", &c), Family::Cardano);
        let doge = NetContext {
            custom: vec![("doge.my-node.example".into(), Family::Dogecoin)],
            ..ctx(true)
        };
        assert_eq!(family_for("doge.my-node.example", &doge), Family::Dogecoin);
        assert_eq!(family_for("unknown.example", &c), Family::Other);
        for h in ALLOWED_HOSTS {
            assert_ne!(family_for(h, &NetContext::default()), Family::Other, "{h}");
        }
    }

    #[test]
    fn context_from_settings() {
        use crate::servers::{BtcServer, RpcServer};
        let mut s = Settings::default();
        s.servers.bitcoin.testnet4 = Some(BtcServer::Esplora {
            url: "https://esplora.example/api".into(),
        });
        s.servers.solana.insert(
            "devnet".into(),
            RpcServer {
                url: "https://sol.example".into(),
            },
        );
        let c = NetContext::from_settings(&s, Network::Testnet);
        assert!(c.tor);
        assert!(c.disabled.contains(&"mempool.space"));
        assert!(c.disabled.contains(&"api.devnet.solana.com"));
        assert_eq!(family_for("esplora.example", &c), Family::Bitcoin);
        assert_eq!(family_for("sol.example", &c), Family::Solana);
        // Mainnet app: bitcoin mainnet still on the default server.
        let m = NetContext::from_settings(&s, Network::Mainnet);
        assert!(!m.disabled.contains(&"mempool.space"));
    }

    #[test]
    fn server_request_refuses_plain_http_and_clear_onion() {
        let dir = std::env::temp_dir().join("kyro-net-test");
        let n = NetClient::new(dir).unwrap();
        let run = |u: &str, tor: bool| {
            let r = ServerRequest::get(url::Url::parse(u).unwrap(), Family::Bitcoin);
            tauri::async_runtime::block_on(n.server_request(r, tor))
        };
        assert!(matches!(
            run("http://node.example/api", false),
            Err(AppError::ServerInvalid(_))
        ));
        assert!(matches!(
            run("http://node.example/api", true),
            Err(AppError::ServerInvalid(_))
        ));
        assert!(matches!(
            run("http://x.onion/api", false),
            Err(AppError::ServerInvalid(_))
        ));
        // Private http is only direct when the caller asks for it (Bitcoin Core).
        assert!(matches!(
            run("http://127.0.0.1:9/", false),
            Err(AppError::ServerInvalid(_))
        ));
    }
}
