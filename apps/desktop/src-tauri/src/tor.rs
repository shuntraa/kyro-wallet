//! Embedded Tor (arti) and HTTPS over Tor.
//!
//! - Bootstraps in the background; progress is published as `tor-status` events.
//! - `send` performs one HTTPS request per Tor stream: `TorClient::connect((host, 443))` →
//!   tokio-rustls (webpki roots, SNI = host) → hyper 1 HTTP/1.1. Policy (allowlist, headers,
//!   redirects, size cap) lives in `net.rs` and is identical to the clear transport.
//! - **Fail closed**: if Tor is not ready within [`READY_WAIT`], the request fails with
//!   `TOR_UNAVAILABLE`; it is never retried in clear.
//! - Each activity family (bitcoin / litecoin / dogecoin / tron / xrp / cardano / kaspa / evm / solana / market / swap) uses its own
//!   `isolated_client()`, so their streams never share a circuit.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use arti_client::config::TorClientConfigBuilder;
use arti_client::TorClient;
use bytes::Bytes;
use futures_util::StreamExt;
use http_body_util::{BodyExt, Full};
use hyper_util::rt::TokioIo;
use serde::Serialize;
use tokio::sync::watch;
use tor_rtcompat::PreferredRuntime;

use crate::error::{AppError, AppResult};
use crate::net::{self, BodyCap, Family, Method, Prepared};

/// How long a request waits for an in-progress bootstrap before failing closed.
const READY_WAIT: Duration = Duration::from_secs(60);
/// A bootstrap that hangs (blocked network, censored guards) ends in `error` instead of
/// staying `bootstrapping` forever, so the UI can ask the user.
const BOOTSTRAP_TIMEOUT: Duration = Duration::from_secs(120);
/// Opening a Tor stream may first require building a 3-hop circuit (arti retries failed
/// extends itself); this bounds that phase. The HTTP exchange then gets `net::TIMEOUT`.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(45);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TorState {
    Off,
    Bootstrapping,
    Ready,
    Error,
}

/// Payload of the `tor-status` event and of the `tor_status` command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TorStatus {
    pub state: TorState,
    pub progress: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl TorStatus {
    fn new(state: TorState, progress: u8, message: Option<String>) -> Self {
        Self {
            state,
            progress,
            message,
        }
    }
}

type Client = Arc<TorClient<PreferredRuntime>>;
type Emitter = Box<dyn Fn(&TorStatus) + Send + Sync>;

pub struct TorManager {
    state_dir: PathBuf,
    cache_dir: PathBuf,
    status: watch::Sender<TorStatus>,
    base: Mutex<Option<Client>>,
    isolated: Mutex<HashMap<Family, Client>>,
    emitter: Mutex<Option<Emitter>>,
    /// Incremented on every start/stop so a stale bootstrap task cannot publish over a newer one.
    generation: Mutex<u64>,
    tls: tokio_rustls::TlsConnector,
}

/// rustls with the ring provider and Mozilla's root store (webpki-roots), TLS 1.2+.
fn tls_connector() -> AppResult<tokio_rustls::TlsConnector> {
    let roots = rustls::RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    };
    let config = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(|e| AppError::Internal(format!("TLS : {e}")))?
    .with_root_certificates(roots)
    .with_no_client_auth();
    Ok(tokio_rustls::TlsConnector::from(Arc::new(config)))
}

impl TorManager {
    /// `dir` = `<app data>/tor`; arti keeps its state and directory cache there.
    pub fn new(dir: PathBuf) -> AppResult<Self> {
        let (status, _) = watch::channel(TorStatus::new(TorState::Off, 0, None));
        Ok(Self {
            state_dir: dir.join("state"),
            cache_dir: dir.join("cache"),
            status,
            base: Mutex::new(None),
            isolated: Mutex::new(HashMap::new()),
            emitter: Mutex::new(None),
            generation: Mutex::new(0),
            tls: tls_connector()?,
        })
    }

    pub fn set_emitter(&self, f: impl Fn(&TorStatus) + Send + Sync + 'static) {
        *net::lock(&self.emitter) = Some(Box::new(f));
    }

    pub fn status(&self) -> TorStatus {
        self.status.borrow().clone()
    }

    fn publish(&self, generation: u64, status: TorStatus) {
        self.publish_if(generation, status, |_| true);
    }

    /// Publishes `status` if `generation` is current and `allowed(current state)` holds, atomically
    /// (the generation lock is held), so a late progress event can never overwrite `ready`.
    fn publish_if(&self, generation: u64, status: TorStatus, allowed: impl Fn(TorState) -> bool) {
        let current = net::lock(&self.generation);
        if *current != generation || !allowed(self.status.borrow().state) {
            return;
        }
        self.status.send_replace(status.clone());
        drop(current);
        if let Some(emit) = net::lock(&self.emitter).as_ref() {
            emit(&status);
        }
    }

    /// Starts bootstrapping in the background unless already bootstrapping or ready.
    pub fn start(self: &Arc<Self>) {
        if matches!(
            self.status().state,
            TorState::Bootstrapping | TorState::Ready
        ) {
            return;
        }
        self.restart();
    }

    /// (Re)starts bootstrapping from scratch, e.g. after an error (`tor_retry`).
    pub fn restart(self: &Arc<Self>) {
        let generation = self.next_generation();
        self.publish(generation, TorStatus::new(TorState::Bootstrapping, 0, None));
        let this = Arc::clone(self);
        tauri::async_runtime::spawn(async move { this.bootstrap(generation).await });
    }

    /// Tor disabled by the user: drop the clients and report `off`.
    pub fn stop(&self) {
        let generation = self.next_generation();
        *net::lock(&self.base) = None;
        net::lock(&self.isolated).clear();
        self.publish(generation, TorStatus::new(TorState::Off, 0, None));
    }

    fn next_generation(&self) -> u64 {
        let mut g = net::lock(&self.generation);
        *g += 1;
        *g
    }

    async fn bootstrap(self: Arc<Self>, generation: u64) {
        match self.try_bootstrap(generation).await {
            Ok(client) => {
                if *net::lock(&self.generation) == generation {
                    *net::lock(&self.base) = Some(client);
                    net::lock(&self.isolated).clear();
                }
                self.publish(generation, TorStatus::new(TorState::Ready, 100, None));
            }
            // Store the bare detail: `client_for` wraps it in `TorUnavailable` again.
            Err(e) => {
                let detail = match e {
                    AppError::TorUnavailable(m) => m,
                    other => other.to_string(),
                };
                self.publish(generation, TorStatus::new(TorState::Error, 0, Some(detail)))
            }
        }
    }

    async fn try_bootstrap(self: &Arc<Self>, generation: u64) -> AppResult<Client> {
        // On Windows, fs-mistrust performs no permission checks (they are Unix-only), so the
        // per-user app data directory is accepted as is; no mistrust override is configured.
        let config = TorClientConfigBuilder::from_directories(&self.state_dir, &self.cache_dir)
            .build()
            .map_err(|e| AppError::Internal(format!("configuration Tor : {e}")))?;
        let client = TorClient::builder()
            .config(config)
            .create_unbootstrapped()
            .map_err(|e| AppError::Internal(format!("Tor : {e}")))?;
        let mut events = client.bootstrap_events();
        let this = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            while let Some(ev) = events.next().await {
                if this.status().state != TorState::Bootstrapping {
                    break;
                }
                let pct = (ev.as_frac().clamp(0.0, 1.0) * 100.0) as u8;
                this.publish_if(
                    generation,
                    TorStatus::new(TorState::Bootstrapping, pct.min(99), Some(ev.to_string())),
                    |state| state == TorState::Bootstrapping,
                );
            }
        });
        tokio::time::timeout(BOOTSTRAP_TIMEOUT, client.bootstrap())
            .await
            .map_err(|_| AppError::TorUnavailable("délai de démarrage dépassé".into()))?
            .map_err(|e| AppError::TorUnavailable(e.to_string()))?;
        Ok(client)
    }

    /// Waits (bounded) for Tor to be ready, then returns the isolated client for `family`.
    async fn client_for(&self, family: Family) -> AppResult<Client> {
        let mut rx = self.status.subscribe();
        let wait = tokio::time::timeout(READY_WAIT, async {
            loop {
                let s = rx.borrow_and_update().clone();
                match s.state {
                    TorState::Ready => return Ok(()),
                    TorState::Bootstrapping => {}
                    TorState::Off => {
                        return Err(AppError::TorUnavailable("Tor n'est pas démarré".into()))
                    }
                    TorState::Error => {
                        return Err(AppError::TorUnavailable(
                            s.message.unwrap_or_else(|| "échec du démarrage".into()),
                        ))
                    }
                }
                if rx.changed().await.is_err() {
                    return Err(AppError::TorUnavailable("Tor arrêté".into()));
                }
            }
        });
        wait.await
            .map_err(|_| AppError::TorUnavailable("délai de démarrage dépassé".into()))??;
        let base = net::lock(&self.base)
            .clone()
            .ok_or_else(|| AppError::TorUnavailable("Tor n'est pas prêt".into()))?;
        let mut isolated = net::lock(&self.isolated);
        Ok(Arc::clone(
            isolated
                .entry(family)
                .or_insert_with(|| base.isolated_client()),
        ))
    }

    /// Sends a request that already passed the policy, over Tor only, on `p.family`'s circuits.
    pub async fn send(&self, p: &Prepared) -> AppResult<(u16, Vec<u8>)> {
        let client = self.client_for(p.family).await?;
        self.send_following_redirects(&client, p).await
    }

    /// Opens a raw Tor stream to `host:port` on `family`'s isolated circuits (Electrum).
    pub async fn connect_stream(
        &self,
        family: Family,
        host: &str,
        port: u16,
    ) -> AppResult<arti_client::DataStream> {
        let client = self.client_for(family).await?;
        tokio::time::timeout(CONNECT_TIMEOUT, connect_with_retry(&client, host, port))
            .await
            .map_err(|_| AppError::Internal("réseau (Tor) : circuit non établi à temps".into()))?
            .map_err(|e| AppError::Internal(format!("réseau (Tor) : {e}")))
    }

    async fn send_following_redirects(
        &self,
        client: &Client,
        p: &Prepared,
    ) -> AppResult<(u16, Vec<u8>)> {
        let mut hop = net::Hop {
            url: p.url.clone(),
            method: p.method,
            headers: p.headers.clone(),
            body: p.body.clone(),
        };
        let mut hops = 0;
        loop {
            // Plain HTTP stays limited to the original onion host the policy approved.
            let allow_plain = p.allow_plain && hop.url.host_str() == Some(p.host.as_str());
            let (status, location, bytes) = self
                .one_request(
                    client,
                    &hop.url,
                    hop.method,
                    &hop.headers,
                    hop.body.as_deref(),
                    allow_plain,
                )
                .await?;
            // Same rule as the clear transport (`net::redirect_hop`): allowlisted hosts only,
            // API-key headers dropped when the host changes.
            match net::redirect_hop(
                status,
                location.as_deref(),
                &hop,
                &p.secret_headers,
                hops,
                true,
            ) {
                Some(next) => {
                    hop = next;
                    hops += 1;
                }
                None => return Ok((status, bytes)),
            }
        }
    }

    async fn one_request(
        &self,
        client: &Client,
        url: &url::Url,
        method: Method,
        headers: &[(String, String)],
        body: Option<&[u8]>,
        allow_plain: bool,
    ) -> AppResult<(u16, Option<String>, Vec<u8>)> {
        let host = url
            .host_str()
            .ok_or_else(|| AppError::InvalidInput("URL sans hôte".into()))?
            .to_owned();
        let port = url.port_or_known_default().unwrap_or(443);
        let net_err = |e: &dyn std::fmt::Display| AppError::Internal(format!("réseau (Tor) : {e}"));

        // Plain HTTP is only ever used for an allowlisted onion service (checked again here,
        // defence in depth): the onion protocol authenticates the service and encrypts.
        let plain = url.scheme() == "http";
        let onion_ok =
            net::ONION_HOSTS.contains(&host.as_str()) || (allow_plain && host.ends_with(".onion"));
        if plain && !onion_ok {
            return Err(AppError::HostNotAllowed(format!(
                "{url} (HTTPS obligatoire)"
            )));
        }
        let stream = tokio::time::timeout(CONNECT_TIMEOUT, connect_with_retry(client, &host, port))
            .await
            .map_err(|_| AppError::Internal("réseau (Tor) : circuit non établi à temps".into()))?
            .map_err(|e| net_err(&e))?;
        let exchange = async {
            if plain {
                http_exchange(stream, url, &host, method, headers, body).await
            } else {
                let server_name = rustls::pki_types::ServerName::try_from(host.clone())
                    .map_err(|_| AppError::InvalidInput("nom d'hôte invalide".into()))?;
                let tls = self
                    .tls
                    .connect(server_name, stream)
                    .await
                    .map_err(|e| net_err(&e))?;
                http_exchange(tls, url, &host, method, headers, body).await
            }
        };
        tokio::time::timeout(net::TIMEOUT, exchange)
            .await
            .map_err(|_| AppError::Internal("réseau (Tor) : délai dépassé".into()))?
    }
}

/// HTTP/1.1 exchange over `io` (a TLS stream, or a raw onion-service stream).
async fn http_exchange<S>(
    io: S,
    url: &url::Url,
    host: &str,
    method: Method,
    headers: &[(String, String)],
    body: Option<&[u8]>,
) -> AppResult<(u16, Option<String>, Vec<u8>)>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let net_err = |e: &dyn std::fmt::Display| AppError::Internal(format!("réseau (Tor) : {e}"));
    let host = host.to_owned();
    let (mut sender, conn) = hyper::client::conn::http1::handshake(TokioIo::new(io))
        .await
        .map_err(|e| net_err(&e))?;
    tauri::async_runtime::spawn(async move {
        let _ = conn.await;
    });

    let path = match url.query() {
        Some(q) => format!("{}?{q}", url.path()),
        None => url.path().to_owned(),
    };
    let authority = match url.port() {
        Some(p) => format!("{host}:{p}"),
        None => host.clone(),
    };
    let mut builder = http::Request::builder()
        .method(method.as_str())
        .uri(path)
        .header(http::header::HOST, authority)
        .header(http::header::USER_AGENT, net::USER_AGENT)
        .header(http::header::CONNECTION, "close");
    for (k, v) in headers {
        builder = builder.header(k.as_str(), v.as_str());
    }
    let request = builder
        .body(Full::new(Bytes::copy_from_slice(body.unwrap_or_default())))
        .map_err(|e| net_err(&e))?;
    let response = sender
        .send_request(request)
        .await
        .map_err(|e| net_err(&e))?;
    let status = response.status().as_u16();
    let location = response
        .headers()
        .get(http::header::LOCATION)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let mut incoming = response.into_body();
    let mut cap = BodyCap::default();
    while let Some(frame) = incoming.frame().await {
        let frame = frame.map_err(|e| net_err(&e))?;
        if let Ok(data) = frame.into_data() {
            cap.push(&data)?;
        }
    }
    Ok((status, location, cap.into_inner()))
}

/// Opens a stream; if the *exit* fails (timeout, DNS failure, refused), retries on a fresh
/// circuit (new isolation token derived from the family client, so no cross-family linking).
async fn connect_with_retry(
    client: &Client,
    host: &str,
    port: u16,
) -> Result<arti_client::DataStream, arti_client::Error> {
    use arti_client::{ErrorKind, HasKind};
    const ATTEMPTS: usize = 3;
    let mut current = Arc::clone(client);
    let mut attempt = 1;
    loop {
        match current.connect((host, port)).await {
            Ok(s) => return Ok(s),
            Err(e)
                if attempt < ATTEMPTS
                    && matches!(
                        e.kind(),
                        ErrorKind::RemoteNetworkTimeout
                            | ErrorKind::RemoteHostNotFound
                            | ErrorKind::RemoteHostResolutionFailed
                            | ErrorKind::RemoteConnectionRefused
                            | ErrorKind::RemoteNetworkFailed
                            | ErrorKind::RemoteStreamError
                    ) =>
            {
                attempt += 1;
                current = current.isolated_client();
            }
            Err(e) => return Err(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::{prepare, EnvKeys, FetchRequest};
    use crate::settings::ApiKeys;

    #[test]
    fn status_payload_shape() {
        let s = TorStatus::new(TorState::Bootstrapping, 42, Some("x".into()));
        assert_eq!(
            serde_json::to_value(&s).unwrap(),
            serde_json::json!({ "state": "bootstrapping", "progress": 42, "message": "x" })
        );
        let off = TorStatus::new(TorState::Off, 0, None);
        assert_eq!(
            serde_json::to_value(&off).unwrap(),
            serde_json::json!({ "state": "off", "progress": 0 })
        );
    }

    fn manager() -> Arc<TorManager> {
        let dir = std::env::temp_dir().join(format!("kyro-tor-test-{}", std::process::id()));
        Arc::new(TorManager::new(dir).unwrap())
    }

    fn prepared(url: &str) -> Prepared {
        prepare(
            FetchRequest {
                url: url.into(),
                method: "GET".into(),
                headers: Default::default(),
                body: None,
            },
            &crate::net::NetContext {
                tor: true,
                ..Default::default()
            },
            &EnvKeys::default(),
            &ApiKeys::default(),
        )
        .unwrap()
    }

    /// Fail closed: with Tor off (or failed), a request errors with TOR_UNAVAILABLE and nothing
    /// is sent in clear.
    #[test]
    fn fails_closed_when_not_ready() {
        let m = manager();
        let p = prepared("https://mempool.space/testnet4/api/blocks/tip/height");
        let r = tauri::async_runtime::block_on(m.send(&p));
        assert!(matches!(r, Err(AppError::TorUnavailable(_))), "{r:?}");
        let generation = *net::lock(&m.generation);
        m.publish(
            generation,
            TorStatus::new(TorState::Error, 0, Some("boom".into())),
        );
        let r = tauri::async_runtime::block_on(m.send(&p));
        assert!(
            matches!(r, Err(AppError::TorUnavailable(ref m)) if m == "boom"),
            "{r:?}"
        );
    }

    /// Real network test: bootstraps Tor, then fetches through it. Run with
    /// `cargo test -p kyro-desktop -- --ignored --nocapture tor_real`
    /// (`KYRO_TOR_TRACE=info,tor_circmgr=debug` shows arti logs, `KYRO_TOR_URL` overrides).
    #[test]
    #[ignore]
    fn tor_real_fetch() {
        if let Ok(filter) = std::env::var("KYRO_TOR_TRACE") {
            let _ = tracing_subscriber::fmt()
                .with_env_filter(tracing_subscriber::EnvFilter::new(filter))
                .with_writer(std::io::stderr)
                .try_init();
        }
        let dir = std::env::temp_dir().join("kyro-tor-real-test");
        let m = Arc::new(TorManager::new(dir).unwrap());
        let started = std::time::Instant::now();
        // mempool.space is rewritten to its onion service by the policy (Tor mode).
        let urls = match std::env::var("KYRO_TOR_URL") {
            Ok(u) if !u.is_empty() => vec![u],
            _ => vec![
                "https://mempool.space/testnet4/api/blocks/tip/height".to_owned(),
                "https://mempool.space/api/blocks/tip/height".to_owned(),
                "https://api.coingecko.com/api/v3/ping".to_owned(),
                "https://api.devnet.solana.com/health".to_owned(),
            ],
        };
        let must_succeed = std::env::var("KYRO_TOR_URL").map_or(2, |_| 1);
        let ok = tauri::async_runtime::block_on(async {
            m.restart();
            let mut rx = m.status.subscribe();
            loop {
                let s = rx.borrow_and_update().clone();
                match s.state {
                    TorState::Ready => break,
                    TorState::Error => panic!("bootstrap failed: {:?}", s.message),
                    _ => {}
                }
                rx.changed().await.unwrap();
            }
            eprintln!("tor bootstrap: {:.1?}", started.elapsed());
            let mut onion_ok = 0;
            for url in &urls {
                let p = prepared(url);
                let t = std::time::Instant::now();
                match m.send(&p).await {
                    Ok((status, body)) => {
                        let text = String::from_utf8_lossy(&body);
                        eprintln!(
                            "{} -> {status} in {:.1?}: {}",
                            p.url,
                            t.elapsed(),
                            text.trim()
                        );
                        if status == 200 && p.host == net::MEMPOOL_ONION {
                            assert!(text.trim().parse::<u64>().unwrap() > 0);
                            onion_ok += 1;
                        }
                    }
                    Err(e) => eprintln!("{} -> FAILED in {:.1?}: {e}", p.url, t.elapsed()),
                }
            }
            onion_ok
        });
        // Both mempool onion requests (testnet4 + mainnet) must succeed by default.
        assert!(ok >= must_succeed, "mempool onion: {ok} success(es)");
    }
}
