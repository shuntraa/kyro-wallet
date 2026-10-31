//! Minimal Electrum protocol client (newline-delimited JSON-RPC 2.0 over TLS or TCP).
//!
//! Why not the `electrum-client` crate: it is synchronous and owns its sockets/TLS (std::net,
//! optional SOCKS proxy), so it cannot run over our in-process arti stream. This is a wire
//! protocol only; TLS is rustls, hashing is sha2.
//!
//! Transport (see docs/NETWORK.md):
//! - loopback/LAN host → direct TCP (Tor cannot reach the user's LAN), TLS required;
//! - Tor enabled → arti stream on the chain family's isolated circuits (Bitcoin for the user's
//!   Bitcoin servers, Dogecoin for Kyro's default Dogecoin servers);
//! - Tor disabled → direct TCP; `.onion` refused.
//!
//! TLS: webpki validation (default) or a pinned SHA-256 of the server certificate. Plain TCP
//! only to a `.onion` host over Tor. An unvalidated, unpinned certificate is never accepted.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::client::WebPkiServerVerifier;
use rustls::crypto::{verify_tls12_signature, verify_tls13_signature, CryptoProvider};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::{
    AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader, ReadHalf, WriteHalf,
};

use crate::error::{AppError, AppResult};
use crate::net::{Family, NetClient};
use crate::servers::{is_private_host, ElectrumTls};

/// Longest accepted response line (a large raw transaction is ~2 MB of hex).
const MAX_LINE: usize = 8 * 1024 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(45);
const CALL_TIMEOUT: Duration = Duration::from_secs(30);
pub const PROTOCOL_VERSION: &str = "1.4";

/// Where and how to connect.
#[derive(Debug, Clone)]
pub struct Target {
    pub host: String,
    pub port: u16,
    pub tls: TlsMode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TlsMode {
    Webpki,
    Pinned([u8; 32]),
    None,
}

impl TlsMode {
    pub fn from_settings(tls: ElectrumTls, pin: Option<&str>) -> AppResult<Self> {
        Ok(match tls {
            ElectrumTls::Webpki => TlsMode::Webpki,
            ElectrumTls::None => TlsMode::None,
            ElectrumTls::Pinned => {
                TlsMode::Pinned(crate::servers::parse_fingerprint(pin.unwrap_or(""))?)
            }
        })
    }
}

pub trait Stream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Stream for T {}
pub type BoxStream = Box<dyn Stream>;

fn unreachable(host: &str, e: impl std::fmt::Display) -> AppError {
    AppError::ServerUnreachable(format!("{host} : {e}"))
}

/// Raw transport (no TLS yet), following the transport rules above.
async fn raw_stream(
    net: &NetClient,
    host: &str,
    port: u16,
    tor: bool,
    family: Family,
) -> AppResult<BoxStream> {
    let onion = host.ends_with(".onion");
    if is_private_host(host) {
        let s = tokio::time::timeout(
            CONNECT_TIMEOUT,
            tokio::net::TcpStream::connect((host, port)),
        )
        .await
        .map_err(|_| unreachable(host, "délai de connexion dépassé"))?
        .map_err(|e| unreachable(host, e))?;
        return Ok(Box::new(s));
    }
    if tor {
        let s = net
            .tor
            .connect_stream(family, host, port)
            .await
            .map_err(|e| match e {
                AppError::TorUnavailable(_) => e,
                other => unreachable(host, other),
            })?;
        return Ok(Box::new(s));
    }
    if onion {
        return Err(AppError::ServerInvalid(format!(
            "{host} : adresse .onion refusée hors Tor"
        )));
    }
    let s = tokio::time::timeout(
        CONNECT_TIMEOUT,
        tokio::net::TcpStream::connect((host, port)),
    )
    .await
    .map_err(|_| unreachable(host, "délai de connexion dépassé"))?
    .map_err(|e| unreachable(host, e))?;
    Ok(Box::new(s))
}

fn provider() -> Arc<CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

fn client_config(verifier: Arc<dyn ServerCertVerifier>) -> AppResult<rustls::ClientConfig> {
    Ok(rustls::ClientConfig::builder_with_provider(provider())
        .with_safe_default_protocol_versions()
        .map_err(|e| AppError::Internal(format!("TLS : {e}")))?
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_no_client_auth())
}

pub fn sha256_hex(der: &[u8]) -> String {
    hex::encode(Sha256::digest(der))
}

/// Accepts exactly the certificate whose SHA-256 equals the pin (handshake signatures are still
/// verified against that certificate's key).
#[derive(Debug)]
struct PinVerifier {
    pin: [u8; 32],
    provider: Arc<CryptoProvider>,
}

impl ServerCertVerifier for PinVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let got: [u8; 32] = Sha256::digest(end_entity.as_ref()).into();
        if got == self.pin {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::General(
                "certificate does not match the pinned SHA-256".into(),
            ))
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

/// TOFU helper: records the server certificate (and whether webpki would accept it), then
/// ABORTS the handshake. No data is ever sent over an unvalidated connection.
#[derive(Debug)]
struct CaptureVerifier {
    webpki: Arc<WebPkiServerVerifier>,
    seen: Mutex<Option<(String, bool)>>,
}

impl ServerCertVerifier for CaptureVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let valid = self
            .webpki
            .verify_server_cert(end_entity, intermediates, server_name, ocsp, now)
            .is_ok();
        *crate::net::lock(&self.seen) = Some((sha256_hex(end_entity.as_ref()), valid));
        Err(rustls::Error::General("certificate captured".into()))
    }

    fn verify_tls12_signature(
        &self,
        _m: &[u8],
        _c: &CertificateDer<'_>,
        _d: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Err(rustls::Error::General("capture only".into()))
    }

    fn verify_tls13_signature(
        &self,
        _m: &[u8],
        _c: &CertificateDer<'_>,
        _d: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Err(rustls::Error::General("capture only".into()))
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.webpki.supported_verify_schemes()
    }
}

fn webpki_verifier() -> AppResult<Arc<WebPkiServerVerifier>> {
    let roots = rustls::RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    };
    WebPkiServerVerifier::builder_with_provider(Arc::new(roots), provider())
        .build()
        .map_err(|e| AppError::Internal(format!("TLS : {e}")))
}

fn server_name(host: &str) -> AppResult<ServerName<'static>> {
    ServerName::try_from(
        host.trim_start_matches('[')
            .trim_end_matches(']')
            .to_owned(),
    )
    .map_err(|_| AppError::ServerInvalid(format!("nom d'hôte invalide « {host} »")))
}

/// Certificate presented by an Electrum TLS server, for the UI's trust-on-first-use prompt.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CertInfo {
    /// SHA-256 of the DER certificate, lowercase hex (pin this as `certSha256`).
    pub sha256: String,
    /// Whether normal (webpki) validation would accept it for this host name.
    pub webpki_valid: bool,
}

pub async fn fetch_certificate(
    net: &NetClient,
    host: &str,
    port: u16,
    tor: bool,
) -> AppResult<CertInfo> {
    let raw = raw_stream(net, host, port, tor, Family::Bitcoin).await?;
    let verifier = Arc::new(CaptureVerifier {
        webpki: webpki_verifier()?,
        seen: Mutex::new(None),
    });
    let connector = tokio_rustls::TlsConnector::from(Arc::new(client_config(verifier.clone())?));
    let _ = tokio::time::timeout(CONNECT_TIMEOUT, connector.connect(server_name(host)?, raw)).await;
    let seen = crate::net::lock(&verifier.seen).clone();
    seen.map(|(sha256, webpki_valid)| CertInfo {
        sha256,
        webpki_valid,
    })
    .ok_or_else(|| unreachable(host, "aucun certificat TLS reçu"))
}

/// Opens an Electrum session (transport + TLS + `server.version` handshake) on the Bitcoin
/// family's circuits (the user's Bitcoin Electrum server).
pub async fn connect(net: &NetClient, t: &Target, tor: bool) -> AppResult<Conn<BoxStream>> {
    connect_family(net, t, tor, Family::Bitcoin).await
}

/// Same as [`connect`], on `family`'s isolated Tor circuits.
pub async fn connect_family(
    net: &NetClient,
    t: &Target,
    tor: bool,
    family: Family,
) -> AppResult<Conn<BoxStream>> {
    if t.tls == TlsMode::None && !(tor && t.host.ends_with(".onion")) {
        return Err(AppError::ServerInvalid(
            "Electrum sans TLS : uniquement vers une adresse .onion via Tor".into(),
        ));
    }
    let raw = raw_stream(net, &t.host, t.port, tor, family).await?;
    let stream: BoxStream = match t.tls {
        TlsMode::None => raw,
        TlsMode::Webpki | TlsMode::Pinned(_) => {
            let config = match t.tls {
                TlsMode::Pinned(pin) => client_config(Arc::new(PinVerifier {
                    pin,
                    provider: provider(),
                }))?,
                _ => client_config(webpki_verifier()?)?,
            };
            let connector = tokio_rustls::TlsConnector::from(Arc::new(config));
            let tls = tokio::time::timeout(
                CONNECT_TIMEOUT,
                connector.connect(server_name(&t.host)?, raw),
            )
            .await
            .map_err(|_| unreachable(&t.host, "délai TLS dépassé"))?
            .map_err(|e| unreachable(&t.host, format!("TLS : {e}")))?;
            Box::new(tls)
        }
    };
    let mut conn = Conn::new(stream, t.host.clone());
    conn.call(
        "server.version",
        json!([
            concat!("Kyro ", env!("CARGO_PKG_VERSION")),
            PROTOCOL_VERSION
        ]),
    )
    .await?;
    Ok(conn)
}

/// One Electrum session over any byte stream.
pub struct Conn<S> {
    reader: BufReader<ReadHalf<S>>,
    writer: WriteHalf<S>,
    next_id: u64,
    host: String,
}

impl<S: AsyncRead + AsyncWrite> Conn<S> {
    pub fn new(stream: S, host: String) -> Self {
        let (r, w) = tokio::io::split(stream);
        Self {
            reader: BufReader::new(r),
            writer: w,
            next_id: 1,
            host,
        }
    }

    pub async fn call(&mut self, method: &str, params: Value) -> AppResult<Value> {
        let mut out = self.batch(&[(method, params)]).await?;
        out.pop()
            .ok_or_else(|| unreachable(&self.host, "réponse vide"))
    }

    /// Pipelines several requests and returns their results in order.
    pub async fn batch(&mut self, calls: &[(&str, Value)]) -> AppResult<Vec<Value>> {
        let host = self.host.clone();
        tokio::time::timeout(CALL_TIMEOUT, self.batch_inner(calls))
            .await
            .map_err(|_| unreachable(&host, "délai dépassé"))?
    }

    async fn batch_inner(&mut self, calls: &[(&str, Value)]) -> AppResult<Vec<Value>> {
        if calls.is_empty() {
            return Ok(Vec::new());
        }
        let first = self.next_id;
        let mut wire = String::new();
        for (i, (method, params)) in calls.iter().enumerate() {
            let req = json!({ "jsonrpc": "2.0", "id": first + i as u64, "method": method, "params": params });
            wire.push_str(&req.to_string());
            wire.push('\n');
        }
        self.next_id += calls.len() as u64;
        self.writer
            .write_all(wire.as_bytes())
            .await
            .map_err(|e| unreachable(&self.host, e))?;
        self.writer
            .flush()
            .await
            .map_err(|e| unreachable(&self.host, e))?;

        let mut results: Vec<Option<Value>> = vec![None; calls.len()];
        let mut pending = calls.len();
        while pending > 0 {
            let line = self.read_line().await?;
            let msg: Value = serde_json::from_slice(&line)
                .map_err(|_| unreachable(&self.host, "réponse JSON invalide"))?;
            // Notifications (no id) are ignored.
            let Some(id) = msg.get("id").and_then(Value::as_u64) else {
                continue;
            };
            let Some(slot) = id
                .checked_sub(first)
                .and_then(|i| usize::try_from(i).ok())
                .and_then(|i| results.get_mut(i))
            else {
                continue;
            };
            if slot.is_some() {
                continue;
            }
            if let Some(err) = msg.get("error").filter(|e| !e.is_null()) {
                let text = err
                    .get("message")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .unwrap_or_else(|| err.to_string());
                return Err(AppError::InvalidInput(format!(
                    "Electrum : {}",
                    truncate(&text)
                )));
            }
            *slot = Some(msg.get("result").cloned().unwrap_or(Value::Null));
            pending -= 1;
        }
        Ok(results.into_iter().map(Option::unwrap_or_default).collect())
    }

    /// Reads one `\n`-terminated line, refusing lines longer than [`MAX_LINE`].
    async fn read_line(&mut self) -> AppResult<Vec<u8>> {
        let mut line = Vec::new();
        loop {
            let buf = self
                .reader
                .fill_buf()
                .await
                .map_err(|e| unreachable(&self.host, e))?;
            if buf.is_empty() {
                return Err(unreachable(&self.host, "connexion fermée par le serveur"));
            }
            let newline = buf.iter().position(|b| *b == b'\n');
            let take = newline.unwrap_or(buf.len());
            if line.len() + take > MAX_LINE {
                return Err(unreachable(&self.host, "réponse trop volumineuse"));
            }
            line.extend_from_slice(&buf[..take]);
            let consumed = newline.map_or(buf.len(), |i| i + 1);
            self.reader.consume(consumed);
            if newline.is_some() {
                return Ok(line);
            }
        }
    }
}

fn truncate(s: &str) -> String {
    s.chars().take(300).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncReadExt;

    /// A scripted fake server on an in-memory duplex pipe.
    async fn fake_server(mut io: tokio::io::DuplexStream, replies: Vec<String>) {
        let mut buf = vec![0u8; 65536];
        let mut seen = String::new();
        let mut replies = replies.into_iter();
        loop {
            let n = io.read(&mut buf).await.unwrap_or(0);
            if n == 0 {
                return;
            }
            seen.push_str(&String::from_utf8_lossy(&buf[..n]));
            while let Some(pos) = seen.find('\n') {
                let line: String = seen.drain(..=pos).collect();
                let req: Value = serde_json::from_str(line.trim()).unwrap();
                let id = req["id"].as_u64().unwrap();
                if let Some(r) = replies.next() {
                    let r = r.replace("$ID", &id.to_string());
                    io.write_all(r.as_bytes()).await.unwrap();
                }
            }
        }
    }

    fn run<F: std::future::Future>(f: F) -> F::Output {
        tauri::async_runtime::block_on(f)
    }

    #[test]
    fn pipelined_batch_with_notifications_and_out_of_order() {
        run(async {
            let (client, server) = tokio::io::duplex(1 << 20);
            // Reply to id N with N*10, after a notification; split writes arbitrarily.
            tauri::async_runtime::spawn(async move {
                let (mut r, mut w) = tokio::io::split(server);
                let mut buf = vec![0u8; 4096];
                let mut got = String::new();
                while got.matches('\n').count() < 3 {
                    let n = r.read(&mut buf).await.unwrap();
                    got.push_str(&String::from_utf8_lossy(&buf[..n]));
                }
                let ids: Vec<u64> = got
                    .lines()
                    .map(|l| {
                        serde_json::from_str::<Value>(l).unwrap()["id"]
                            .as_u64()
                            .unwrap()
                    })
                    .collect();
                let mut out = String::from(
                    "{\"jsonrpc\":\"2.0\",\"method\":\"blockchain.headers.subscribe\",\"params\":[{}]}\n",
                );
                for id in ids.iter().rev() {
                    out.push_str(&format!(
                        "{{\"jsonrpc\":\"2.0\",\"id\":{id},\"result\":{}}}\n",
                        id * 10
                    ));
                }
                let bytes = out.into_bytes();
                for chunk in bytes.chunks(7) {
                    w.write_all(chunk).await.unwrap();
                }
            });
            let mut c = Conn::new(client, "test".into());
            let r = c
                .batch(&[("a", json!([])), ("b", json!([1])), ("c", json!(["x"]))])
                .await
                .unwrap();
            assert_eq!(r, vec![json!(10), json!(20), json!(30)]);
        });
    }

    #[test]
    fn server_error_and_eof_and_garbage() {
        run(async {
            let (client, server) = tokio::io::duplex(1 << 16);
            tauri::async_runtime::spawn(fake_server(
                server,
                vec![
                    "{\"jsonrpc\":\"2.0\",\"id\":$ID,\"error\":{\"code\":1,\"message\":\"min relay fee not met\"}}\n".into(),
                    "not json\n".into(),
                ],
            ));
            let mut c = Conn::new(client, "test".into());
            let e = c
                .call("blockchain.transaction.broadcast", json!(["00"]))
                .await
                .unwrap_err();
            assert!(
                matches!(e, AppError::InvalidInput(ref m) if m.contains("min relay fee")),
                "{e:?}"
            );
            let e = c.call("x", json!([])).await.unwrap_err();
            assert!(matches!(e, AppError::ServerUnreachable(_)), "{e:?}");
        });
        run(async {
            let (client, server) = tokio::io::duplex(1 << 16);
            drop(server);
            let mut c = Conn::new(client, "test".into());
            assert!(matches!(
                c.call("x", json!([])).await,
                Err(AppError::ServerUnreachable(_))
            ));
        });
    }

    #[test]
    fn oversized_line_is_refused() {
        run(async {
            let (client, server) = tokio::io::duplex(1 << 16);
            tauri::async_runtime::spawn(async move {
                let (_r, mut w) = tokio::io::split(server);
                let chunk = vec![b'a'; 1 << 16];
                for _ in 0..(MAX_LINE / chunk.len() + 2) {
                    if w.write_all(&chunk).await.is_err() {
                        return;
                    }
                }
            });
            let mut c = Conn::new(client, "test".into());
            let e = c.call("x", json!([])).await.unwrap_err();
            assert!(
                matches!(e, AppError::ServerUnreachable(ref m) if m.contains("volumineuse")),
                "{e:?}"
            );
        });
    }

    #[test]
    fn pin_verifier_matches_only_the_pinned_certificate() {
        let cert = CertificateDer::from(vec![1u8, 2, 3, 4]);
        let pin: [u8; 32] = Sha256::digest([1u8, 2, 3, 4]).into();
        let v = PinVerifier {
            pin,
            provider: provider(),
        };
        let name = ServerName::try_from("electrum.example").unwrap();
        assert!(v
            .verify_server_cert(&cert, &[], &name, &[], UnixTime::now())
            .is_ok());
        let other = CertificateDer::from(vec![9u8]);
        assert!(v
            .verify_server_cert(&other, &[], &name, &[], UnixTime::now())
            .is_err());
        assert_eq!(sha256_hex(&[1, 2, 3, 4]), hex::encode(pin));
    }

    #[test]
    fn plaintext_only_to_onion_over_tor() {
        let dir = std::env::temp_dir().join("kyro-electrum-test");
        let net = NetClient::new(dir).unwrap();
        for (host, tor) in [
            ("electrum.example", true),
            ("x.onion", false),
            ("electrum.example", false),
        ] {
            let t = Target {
                host: host.into(),
                port: 50001,
                tls: TlsMode::None,
            };
            let r = run(connect(&net, &t, tor));
            assert!(matches!(r, Err(AppError::ServerInvalid(_))), "{host} {tor}");
        }
    }
}
