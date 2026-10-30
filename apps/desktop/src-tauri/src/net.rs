//! `net_fetch`: the only way the app talks to the outside world.
//! HTTPS only, allowlisted hosts (see docs/NETWORK.md), no redirect off the list,
//! capped size and duration, cache + backoff for rate-limited APIs. API keys are
//! injected here so they never need to live in the webview.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::settings::ApiKeys;

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

/// Request headers the webview may set. Everything else is dropped.
const ALLOWED_HEADERS: &[&str] = &["accept", "content-type", "0x-version"];

const MAX_BODY: usize = 5 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(20);
const CACHE_TTL: Duration = Duration::from_secs(60);
const BACKOFF_429: Duration = Duration::from_secs(30);

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

pub struct NetClient {
    http: reqwest::Client,
    cache: Mutex<HashMap<String, (Instant, FetchResponse)>>,
    backoff: Mutex<HashMap<String, Instant>>,
}

pub fn host_allowed(host: &str, extra: &[String]) -> bool {
    ALLOWED_HOSTS.contains(&host) || extra.iter().any(|h| h == host)
}

impl NetClient {
    pub fn new() -> AppResult<Self> {
        let http = reqwest::Client::builder()
            .timeout(TIMEOUT)
            .https_only(true)
            .user_agent(concat!("Kyro/", env!("CARGO_PKG_VERSION")))
            // Follow redirects only to allowlisted hosts (user RPC hosts are not followed).
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                let ok = attempt.previous().len() < 3
                    && attempt.url().scheme() == "https"
                    && attempt
                        .url()
                        .host_str()
                        .is_some_and(|h| ALLOWED_HOSTS.contains(&h));
                if ok {
                    attempt.follow()
                } else {
                    attempt.stop()
                }
            }))
            .build()
            .map_err(|e| AppError::Internal(e.to_string()))?;
        Ok(Self {
            http,
            cache: Mutex::new(HashMap::new()),
            backoff: Mutex::new(HashMap::new()),
        })
    }

    pub async fn fetch(
        &self,
        req: FetchRequest,
        extra_hosts: &[String],
        env: &EnvKeys,
        saved: &ApiKeys,
    ) -> AppResult<FetchResponse> {
        let url =
            url::Url::parse(&req.url).map_err(|_| AppError::InvalidInput("URL invalide".into()))?;
        if url.scheme() != "https" {
            return Err(AppError::HostNotAllowed(format!(
                "{} (HTTPS obligatoire)",
                url
            )));
        }
        let host = url.host_str().unwrap_or_default().to_owned();
        if !host_allowed(&host, extra_hosts) {
            return Err(AppError::HostNotAllowed(host));
        }
        let method = match req.method.to_ascii_uppercase().as_str() {
            "GET" => reqwest::Method::GET,
            "POST" => reqwest::Method::POST,
            _ => return Err(AppError::InvalidInput("méthode HTTP non autorisée".into())),
        };

        if let Some(until) = lock(&self.backoff).get(&host).copied() {
            let now = Instant::now();
            if until > now {
                return Err(AppError::RateLimited((until - now).as_secs().max(1)));
            }
        }

        let cacheable = method == reqwest::Method::GET && host.ends_with("coingecko.com");
        let cache_key = req.url.clone();
        if cacheable {
            if let Some((at, resp)) = lock(&self.cache).get(&cache_key) {
                if at.elapsed() < CACHE_TTL {
                    return Ok(resp.clone());
                }
            }
        }

        let mut builder = self.http.request(method, url.clone());
        for (k, v) in &req.headers {
            if ALLOWED_HEADERS.contains(&k.to_ascii_lowercase().as_str()) {
                builder = builder.header(k, v);
            }
        }
        builder = inject_api_key(builder, &host, env, saved);
        if let Some(body) = req.body {
            builder = builder.body(body);
        }

        let mut resp = builder
            .send()
            .await
            .map_err(|e| AppError::Internal(format!("réseau : {}", e.without_url())))?;
        let status = resp.status().as_u16();
        if status == 429 {
            lock(&self.backoff).insert(host.clone(), Instant::now() + BACKOFF_429);
        }

        let mut bytes = Vec::new();
        while let Some(chunk) = resp
            .chunk()
            .await
            .map_err(|e| AppError::Internal(format!("réseau : {}", e.without_url())))?
        {
            if bytes.len() + chunk.len() > MAX_BODY {
                return Err(AppError::Internal("réponse trop volumineuse".into()));
            }
            bytes.extend_from_slice(&chunk);
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
}

fn inject_api_key(
    builder: reqwest::RequestBuilder,
    host: &str,
    env: &EnvKeys,
    saved: &ApiKeys,
) -> reqwest::RequestBuilder {
    let pick = |e: &Option<String>, s: &Option<String>| e.clone().or_else(|| s.clone());
    match host {
        "api.coingecko.com" => match pick(&env.coingecko, &saved.coingecko) {
            Some(k) => builder.header("x-cg-demo-api-key", k),
            None => builder,
        },
        "pro-api.coingecko.com" => match pick(&env.coingecko, &saved.coingecko) {
            Some(k) => builder.header("x-cg-pro-api-key", k),
            None => builder,
        },
        "api.0x.org" => match pick(&env.zerox, &saved.zerox) {
            Some(k) => builder.header("0x-api-key", k),
            None => builder,
        },
        "api.1inch.dev" => match pick(&env.oneinch, &saved.oneinch) {
            Some(k) => builder.bearer_auth(k),
            None => builder,
        },
        "li.quest" => match &env.lifi {
            Some(k) => builder.header("x-lifi-api-key", k),
            None => builder,
        },
        "lite-api.jup.ag" => match &env.jupiter {
            Some(k) => builder.header("x-api-key", k),
            None => builder,
        },
        _ => builder,
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowlist() {
        assert!(host_allowed("mempool.space", &[]));
        assert!(!host_allowed("evil.example", &[]));
        assert!(!host_allowed("mempool.space.evil.example", &[]));
        assert!(host_allowed("my-node.example", &["my-node.example".into()]));
    }
}
