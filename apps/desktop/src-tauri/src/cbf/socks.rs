//! Loopback SOCKS5 bridge from bip157 to our embedded Tor (arti), locked down:

use std::collections::HashSet;
use std::future::Future;
use std::net::{Ipv4Addr, SocketAddr};
use std::pin::Pin;
use std::sync::Arc;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tor_socksproto::{
    Buffer, Handshake, NextStep, SocksAddr, SocksCmd, SocksProxyHandshake, SocksRequest,
    SocksStatus, SocksVersion,
};

use crate::electrum::BoxStream;
use crate::error::{AppError, AppResult};
use crate::net::Family;
use crate::tor::TorManager;

/// Where the bridge forwards an accepted CONNECT.
pub trait Upstream: Send + Sync + 'static {
    fn open(
        &self,
        host: String,
        port: u16,
    ) -> Pin<Box<dyn Future<Output = AppResult<BoxStream>> + Send + '_>>;
}

/// Production upstream: arti, on the Bitcoin family's isolated circuits.
pub struct TorUpstream(pub Arc<TorManager>);

impl Upstream for TorUpstream {
    fn open(
        &self,
        host: String,
        port: u16,
    ) -> Pin<Box<dyn Future<Output = AppResult<BoxStream>> + Send + '_>> {
        Box::pin(async move {
            let s = self.0.connect_stream(Family::Bitcoin, &host, port).await?;
            Ok(Box::new(s) as BoxStream)
        })
    }
}

/// Allowlist key: lowercase onion name or IP text, plus port.
pub type Allowed = HashSet<(String, u16)>;

pub struct SocksBridge {
    pub addr: SocketAddr,
    handle: tauri::async_runtime::JoinHandle<()>,
}

impl SocksBridge {
    pub async fn start<U: Upstream>(upstream: Arc<U>, allowed: Allowed) -> AppResult<Self> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(|e| AppError::Internal(format!("SOCKS bridge: {e}")))?;
        let addr = listener
            .local_addr()
            .map_err(|e| AppError::Internal(format!("SOCKS bridge: {e}")))?;
        let allowed = Arc::new(allowed);
        let handle = tauri::async_runtime::spawn(async move {
            loop {
                let Ok((stream, peer)) = listener.accept().await else {
                    continue;
                };
                if !peer.ip().is_loopback() {
                    continue; // unreachable with a loopback bind, kept as defence in depth
                }
                let (up, al) = (upstream.clone(), allowed.clone());
                tauri::async_runtime::spawn(async move {
                    let _ = serve(stream, up.as_ref(), &al).await;
                });
            }
        });
        Ok(Self { addr, handle })
    }
}

impl Drop for SocksBridge {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

/// Decides whether a parsed request may be forwarded; returns the upstream target.
pub fn authorize(req: &SocksRequest, allowed: &Allowed) -> Option<(String, u16)> {
    if req.version() != SocksVersion::V5 || req.command() != SocksCmd::CONNECT {
        return None;
    }
    let host = match req.addr() {
        SocksAddr::Ip(ip) => ip.to_string(),
        SocksAddr::Hostname(h) => {
            let h = h.as_ref().to_ascii_lowercase();
            if !h.ends_with(".onion") {
                return None; // a DNS name: refused, we never resolve anything
            }
            h
        }
    };
    let key = (host, req.port());
    allowed.contains(&key).then_some(key)
}

async fn serve<U: Upstream + ?Sized>(
    mut stream: TcpStream,
    upstream: &U,
    allowed: &Allowed,
) -> Result<(), String> {
    let mut hs = SocksProxyHandshake::new();
    let mut buf = Buffer::new_precise();
    let req = loop {
        match hs.step(&mut buf).map_err(|e| e.to_string())? {
            NextStep::Send(data) => stream.write_all(&data).await.map_err(|e| e.to_string())?,
            NextStep::Recv(mut recv) => {
                let n = stream.read(recv.buf()).await.map_err(|e| e.to_string())?;
                if n == 0 {
                    return Err("eof".into());
                }
                recv.note_received(n).map_err(|e| e.to_string())?;
            }
            NextStep::Finished(done) => break done.into_output().map_err(|e| e.to_string())?,
        }
    };
    let reply = |status: SocksStatus| req.reply(status, None).map_err(|e| e.to_string());
    let Some((host, port)) = authorize(&req, allowed) else {
        let _ = stream.write_all(&reply(SocksStatus::NOT_ALLOWED)?).await;
        return Err("not allowed".into());
    };
    match upstream.open(host, port).await {
        Ok(mut up) => {
            stream
                .write_all(&reply(SocksStatus::SUCCEEDED)?)
                .await
                .map_err(|e| e.to_string())?;
            let _ = tokio::io::copy_bidirectional(&mut stream, &mut up).await;
            Ok(())
        }
        Err(e) => {
            let _ = stream
                .write_all(&reply(SocksStatus::GENERAL_FAILURE)?)
                .await;
            Err(e.to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Echo(AtomicUsize);

    impl Upstream for Echo {
        fn open(
            &self,
            _host: String,
            _port: u16,
        ) -> Pin<Box<dyn Future<Output = AppResult<BoxStream>> + Send + '_>> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Box::pin(async {
                let (a, b) = tokio::io::duplex(4096);
                tauri::async_runtime::spawn(async move {
                    let (mut r, mut w) = tokio::io::split(b);
                    let _ = tokio::io::copy(&mut r, &mut w).await;
                });
                Ok(Box::new(a) as BoxStream)
            })
        }
    }

    const ONION: &str = "a6yijgwn4vtmmhl7uybtbuyvtl7mtj7arld5f4csqsx4syeii4gt3vqd.onion";

    fn allowed() -> Allowed {
        HashSet::from([
            (ONION.to_string(), 48333),
            ("203.132.94.196".to_string(), 48333),
        ])
    }

    async fn socks5(addr: SocketAddr, target: &[u8], port: u16) -> (u8, Option<TcpStream>) {
        let mut s = TcpStream::connect(addr).await.unwrap();
        s.write_all(&[5, 1, 0]).await.unwrap();
        let mut m = [0u8; 2];
        s.read_exact(&mut m).await.unwrap();
        assert_eq!(m, [5, 0], "no-auth method selected");
        let mut req = vec![5, 1, 0];
        req.extend_from_slice(target);
        req.extend_from_slice(&port.to_be_bytes());
        s.write_all(&req).await.unwrap();
        let mut rep = [0u8; 10];
        s.read_exact(&mut rep).await.unwrap();
        (rep[1], (rep[1] == 0).then_some(s))
    }

    fn domain(name: &str) -> Vec<u8> {
        let mut v = vec![3, name.len() as u8];
        v.extend_from_slice(name.as_bytes());
        v
    }

    fn run<F: Future>(f: F) -> F::Output {
        tauri::async_runtime::block_on(f)
    }

    #[test]
    fn binds_loopback_on_a_random_port_and_closes_on_drop() {
        run(async {
            let up = Arc::new(Echo(AtomicUsize::new(0)));
            let a = SocksBridge::start(up.clone(), allowed()).await.unwrap();
            let b = SocksBridge::start(up, allowed()).await.unwrap();
            assert!(a.addr.ip().is_loopback());
            assert_ne!(a.addr.port(), 0);
            assert_ne!(a.addr.port(), b.addr.port());
            let addr = a.addr;
            drop(a);
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            assert!(
                TcpStream::connect(addr).await.is_err(),
                "listener must be gone"
            );
        });
    }

    #[test]
    fn only_the_exact_peer_set_is_reachable() {
        run(async {
            let up = Arc::new(Echo(AtomicUsize::new(0)));
            let bridge = SocksBridge::start(up.clone(), allowed()).await.unwrap();
            // Allowed onion: success, and bytes are relayed.
            let (code, s) = socks5(bridge.addr, &domain(ONION), 48333).await;
            assert_eq!(code, 0);
            let mut s = s.unwrap();
            s.write_all(b"ping").await.unwrap();
            let mut back = [0u8; 4];
            s.read_exact(&mut back).await.unwrap();
            assert_eq!(&back, b"ping");
            assert_eq!(
                socks5(bridge.addr, &[1, 203, 132, 94, 196], 48333).await.0,
                0
            );
            // Right host, wrong port; other IP; other onion: 0x02.
            assert_eq!(socks5(bridge.addr, &domain(ONION), 8333).await.0, 2);
            assert_eq!(socks5(bridge.addr, &[1, 8, 8, 8, 8], 48333).await.0, 2);
            let other = "fsijrllgzgeg4pa5ebq4qy3swmplxkzvuvji5swt36quy42dznq3t3ad.onion";
            assert_eq!(socks5(bridge.addr, &domain(other), 48333).await.0, 2);
            assert_eq!(
                socks5(bridge.addr, &domain("seed.testnet4.wiz.biz"), 48333)
                    .await
                    .0,
                2
            );
            assert_eq!(
                socks5(bridge.addr, &domain("mempool.space"), 443).await.0,
                2
            );
            assert_eq!(
                up.0.load(Ordering::SeqCst),
                2,
                "upstream opened only for allowed peers"
            );
        });
    }

    #[test]
    fn socks4_and_non_connect_are_refused() {
        run(async {
            let up = Arc::new(Echo(AtomicUsize::new(0)));
            let bridge = SocksBridge::start(up.clone(), allowed()).await.unwrap();
            let mut s = TcpStream::connect(bridge.addr).await.unwrap();
            s.write_all(&[4, 1, 0xbc, 0xcd, 203, 132, 94, 196, 0])
                .await
                .unwrap();
            let mut rep = [0u8; 8];
            s.read_exact(&mut rep).await.unwrap();
            assert_ne!(rep[1], 0x5a, "SOCKS4 must not succeed");
            for cmd in [2u8, 3u8] {
                let mut s = TcpStream::connect(bridge.addr).await.unwrap();
                s.write_all(&[5, 1, 0]).await.unwrap();
                let mut m = [0u8; 2];
                s.read_exact(&mut m).await.unwrap();
                s.write_all(&[5, cmd, 0, 1, 203, 132, 94, 196, 0xbc, 0xcd])
                    .await
                    .unwrap();
                let mut rep = [0u8; 10];
                let n = s.read(&mut rep).await.unwrap_or(0);
                assert!(n == 0 || rep[1] != 0, "cmd {cmd} must be refused");
            }
            assert_eq!(up.0.load(Ordering::SeqCst), 0);
        });
    }
}
