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
use crate::settings::{ApiKeys, RpcOverrides, Settings};
use crate::tor::TorManager;

pub const ALLOWED_HOSTS: &[&str] = &[
    "api.coingecko.com",
    "pro-api.coingecko.com",
    "mempool.space",
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
    "api.1inch.dev",
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
    pub oneinch: Option<String>,
    pub lifi: Option<String>,
    pub jupiter: Option<String>,
}

impl EnvKeys {
    pub fn from_env() -> Self {
        let get = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());
        Self {
            coingecko: get("KYRO_COINGECKO_API_KEY"),
            zerox: get("KYRO_ZEROX_API_KEY"),
            oneinch: get("KYRO_ONEINCH_API_KEY"),
            lifi: get("KYRO_LIFI_API_KEY"),
            jupiter: get("KYRO_JUPITER_API_KEY"),
        }
    }
}

// ---------------------------------------------------------------- policy

pub fn host_allowed(host: &str, extra: &[String]) -> bool {
    ALLOWED_HOSTS.contains(&host) || extra.iter().any(|h| h == host)
}

/// Scheme rule shared by requests and redirects: HTTPS for clearnet hosts; plain HTTP only
/// for an allowlisted onion service and only over Tor; any `.onion` is refused in clear.
fn scheme_ok(url: &url::Url, host: &str, tor: bool) -> Result<(), String> {
    if host.ends_with(".onion") {
        if !tor {
            return Err(format!("{host} (adresse .onion refusée hors Tor)"));
        }
        if !ONION_HOSTS.contains(&host) {
            return Err(host.to_owned());
        }
        if url.scheme() != "http" {
            return Err(format!("{url} (service onion : http:// attendu)"));
        }
        return Ok(());
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
        && scheme_ok(next, host, tor).is_ok()
}

/// In Tor mode, rewrites `https://mempool.space/…` to `http://<mempool onion>/…`.
fn onion_rewrite(url: &mut url::Url) -> AppResult<()> {
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
    Evm,
    Solana,
    Market,
    Swap,
    Other,
}

pub fn family_for(host: &str, rpc: &RpcOverrides) -> Family {
    let user_host = |u: &Option<String>| {
        u.as_deref()
            .and_then(|u| url::Url::parse(u).ok())
            .and_then(|u| u.host_str().map(str::to_owned))
            .is_some_and(|h| h == host)
    };
    if host == "mempool.space" || host == MEMPOOL_ONION || user_host(&rpc.esplora) {
        Family::Bitcoin
    } else if host.ends_with("-rpc.publicnode.com") || user_host(&rpc.ethereum) {
        Family::Evm
    } else if host.ends_with(".solana.com") || user_host(&rpc.solana) {
        Family::Solana
    } else if host.ends_with("coingecko.com") {
        Family::Market
    } else if matches!(
        host,
        "api.0x.org" | "api.1inch.dev" | "li.quest" | "lite-api.jup.ag"
    ) {
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
    pub body: Option<String>,
}

/// `tor` = the request will go over Tor (settings.tor.enabled).
pub fn prepare(
    req: FetchRequest,
    extra_hosts: &[String],
    env: &EnvKeys,
    saved: &ApiKeys,
    tor: bool,
) -> AppResult<Prepared> {
    let mut url =
        url::Url::parse(&req.url).map_err(|_| AppError::InvalidInput("URL invalide".into()))?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err(AppError::InvalidInput(
            "URL avec identifiants refusée".into(),
        ));
    }
    if tor {
        onion_rewrite(&mut url)?;
    }
    let host = url.host_str().unwrap_or_default().to_owned();
    let is_onion = host.ends_with(".onion");
    if !is_onion && !host_allowed(&host, extra_hosts) {
        return Err(AppError::HostNotAllowed(host));
    }
    scheme_ok(&url, &host, tor).map_err(AppError::HostNotAllowed)?;
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
        url,
        host,
        method,
        headers,
        secret_headers,
        body: req.body,
    })
}

/// API keys are injected here so they never need to live in the webview.
fn api_key_headers(host: &str, env: &EnvKeys, saved: &ApiKeys) -> Vec<(String, String)> {
    let pick = |e: &Option<String>, s: &Option<String>| e.clone().or_else(|| s.clone());
    let (name, value) = match host {
        "api.coingecko.com" => ("x-cg-demo-api-key", pick(&env.coingecko, &saved.coingecko)),
        "pro-api.coingecko.com" => ("x-cg-pro-api-key", pick(&env.coingecko, &saved.coingecko)),
        "api.0x.org" => ("0x-api-key", pick(&env.zerox, &saved.zerox)),
        "api.1inch.dev" => (
            "authorization",
            pick(&env.oneinch, &saved.oneinch).map(|k| format!("Bearer {k}")),
        ),
        "li.quest" => ("x-lifi-api-key", env.lifi.clone()),
        "lite-api.jup.ag" => ("x-api-key", env.jupiter.clone()),
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
    pub tor: Arc<TorManager>,
    cache: Mutex<HashMap<String, (Instant, FetchResponse)>>,
    backoff: Mutex<HashMap<String, Instant>>,
}

impl NetClient {
    pub fn new(tor_dir: PathBuf) -> AppResult<Self> {
        let clear = reqwest::Client::builder()
            .timeout(TIMEOUT)
            .https_only(true)
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
        Ok(Self {
            clear,
            tor: Arc::new(TorManager::new(tor_dir)?),
            cache: Mutex::new(HashMap::new()),
            backoff: Mutex::new(HashMap::new()),
        })
    }

    /// Applies the policy, then sends over Tor (if enabled in `settings`) or in clear.
    pub async fn fetch(
        &self,
        req: FetchRequest,
        settings: &Settings,
        env: &EnvKeys,
    ) -> AppResult<FetchResponse> {
        let p = prepare(
            req,
            &settings.rpc_hosts(),
            env,
            &settings.api_keys,
            settings.tor.enabled,
        )?;

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

        let (status, bytes) = if settings.tor.enabled {
            self.tor
                .send(&p, family_for(&p.host, &settings.rpc))
                .await?
        } else {
            self.send_clear(&p).await?
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

    async fn send_clear(&self, p: &Prepared) -> AppResult<(u16, Vec<u8>)> {
        let method = match p.method {
            Method::Get => reqwest::Method::GET,
            Method::Post => reqwest::Method::POST,
        };
        let mut builder = self.clear.request(method, p.url.clone());
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
                oneinch: Some("inch".into()),
                ..Default::default()
            },
        )
    }

    #[test]
    fn allowlist() {
        assert!(host_allowed("mempool.space", &[]));
        assert!(!host_allowed("evil.example", &[]));
        assert!(!host_allowed("mempool.space.evil.example", &[]));
        assert!(host_allowed("my-node.example", &["my-node.example".into()]));
    }

    #[test]
    fn prepare_enforces_policy() {
        let (env, saved) = keys();
        let ok = |r| prepare(r, &[], &env, &saved, false);
        assert!(matches!(
            ok(req("http://mempool.space/api", "GET", &[])),
            Err(AppError::HostNotAllowed(_))
        ));
        assert!(matches!(
            ok(req("https://evil.example/", "GET", &[])),
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
        // User RPC host is allowed only through `extra`.
        assert!(prepare(
            req("https://my-node.example/", "POST", &[]),
            &["my-node.example".into()],
            &env,
            &saved,
            false
        )
        .is_ok());
    }

    #[test]
    fn header_filtering_and_key_injection() {
        let (env, saved) = keys();
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
            &[],
            &env,
            &saved,
            false,
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
        let p = prepare(
            req("https://api.1inch.dev/swap", "GET", &[]),
            &[],
            &env,
            &saved,
            false,
        )
        .unwrap();
        assert_eq!(
            p.headers,
            vec![("authorization".to_string(), "Bearer inch".to_string())]
        );
        // No key for an unrelated host.
        let p = prepare(
            req("https://mempool.space/", "GET", &[]),
            &[],
            &env,
            &saved,
            false,
        )
        .unwrap();
        assert!(p.headers.is_empty() && p.secret_headers.is_empty());
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
            assert!(!redirect_allowed(&u("https://my-node.example/"), 0, tor));
        }
        // Onion redirect targets: only the allowlisted onion, http, and only over Tor.
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
        let (env, saved) = keys();
        let prep = |url: &str, tor: bool| prepare(req(url, "GET", &[]), &[], &env, &saved, tor);

        // Tor mode: the default Esplora host is rewritten to mempool's onion, path and query kept.
        let p = prep(
            "https://mempool.space/testnet4/api/address/tb1qx/utxo?x=1",
            true,
        )
        .unwrap();
        assert_eq!(
            p.url.as_str(),
            format!("http://{MEMPOOL_ONION}/testnet4/api/address/tb1qx/utxo?x=1")
        );
        assert_eq!(p.host, MEMPOOL_ONION);
        assert_eq!(
            family_for(&p.host, &RpcOverrides::default()),
            Family::Bitcoin
        );
        // Clear mode: untouched.
        let p = prep("https://mempool.space/api/blocks/tip/height", false).unwrap();
        assert_eq!(
            p.url.as_str(),
            "https://mempool.space/api/blocks/tip/height"
        );
        // Other hosts are never rewritten.
        let p = prep("https://api.coingecko.com/api/v3/ping", true).unwrap();
        assert_eq!(p.url.scheme(), "https");

        // The onion URL itself: allowed over Tor (http only), refused in clear.
        let onion = format!("http://{MEMPOOL_ONION}/api/blocks/tip/height");
        assert!(prep(&onion, true).is_ok());
        assert!(matches!(
            prep(&onion, false),
            Err(AppError::HostNotAllowed(_))
        ));
        assert!(matches!(
            prep(&format!("https://{MEMPOOL_ONION}/api"), true),
            Err(AppError::HostNotAllowed(_))
        ));
        // Any other onion: refused in both modes.
        for tor in [false, true] {
            assert!(matches!(
                prep(
                    "http://duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion/",
                    tor
                ),
                Err(AppError::HostNotAllowed(_))
            ));
        }
        // Plain http:// stays refused for every clearnet host, Tor or not (no rewrite of http).
        for tor in [false, true] {
            assert!(matches!(
                prep("http://mempool.space/api", tor),
                Err(AppError::HostNotAllowed(_))
            ));
            assert!(matches!(
                prep("http://api.coingecko.com/api/v3/ping", tor),
                Err(AppError::HostNotAllowed(_))
            ));
        }
        // A user RPC host can't smuggle an onion in clear mode.
        assert!(prepare(
            req(&onion, "GET", &[]),
            &[MEMPOOL_ONION.to_string()],
            &env,
            &saved,
            false
        )
        .is_err());
        // Non-default port: not rewritten (and still HTTPS). (`:443` is normalised away by `url`.)
        let p = prep("https://mempool.space:8443/api", true).unwrap();
        assert_eq!(p.url.scheme(), "https");
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
        let rpc = RpcOverrides {
            ethereum: Some("https://eth.my-node.example/rpc".into()),
            solana: None,
            esplora: Some("https://btc.my-node.example".into()),
        };
        assert_eq!(family_for("mempool.space", &rpc), Family::Bitcoin);
        assert_eq!(family_for("btc.my-node.example", &rpc), Family::Bitcoin);
        assert_eq!(
            family_for("ethereum-sepolia-rpc.publicnode.com", &rpc),
            Family::Evm
        );
        assert_eq!(family_for("eth.my-node.example", &rpc), Family::Evm);
        assert_eq!(family_for("api.devnet.solana.com", &rpc), Family::Solana);
        assert_eq!(family_for("api.coingecko.com", &rpc), Family::Market);
        assert_eq!(family_for("lite-api.jup.ag", &rpc), Family::Swap);
        assert_eq!(family_for("unknown.example", &rpc), Family::Other);
        // Every allowlisted host maps to a real family.
        for h in ALLOWED_HOSTS {
            assert_ne!(
                family_for(h, &RpcOverrides::default()),
                Family::Other,
                "{h}"
            );
        }
    }
}
