//! Native approval of every custom server host before Kyro contacts it (docs/NETWORK.md).
//!
//! A compromised webview can call `settings_set`, `server_test` or `electrum_fetch_cert` with
//! any host: once saved, a host is also reachable through `net_fetch`, and even a failed test
//! leaks data (the host name itself goes to DNS / a Tor exit, a LAN address can be probed).
//! So a host that is not already in the saved settings, and was not approved earlier in this
//! session, is shown in a native dialog — host and port, sanitised — BEFORE any request.
//!
//! The same module asks before Tor goes from enabled to disabled (all traffic in clear).

use std::collections::BTreeSet;

use tauri::{AppHandle, Manager};

use crate::error::AppResult;
use crate::servers::{
    BtcServer, CardanoServer, CoreAuth, Servers, TronServer, UtxoServer, XrpServer,
};
use crate::state::AppState;

/// One server Kyro would contact: what it is for, and where.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Endpoint {
    /// `host:port`, host lower-cased (IPv6 in brackets): the approval key.
    pub key: String,
    /// What the user reads, e.g. `Bitcoin (Esplora) — https://node.example:443`.
    pub label: String,
}

fn url_endpoint(what: &str, url: &str) -> Option<Endpoint> {
    let u = url::Url::parse(url.trim()).ok()?;
    let host = u.host()?;
    let port = u.port_or_known_default()?;
    let host = match host {
        url::Host::Ipv6(a) => format!("[{a}]"),
        other => other.to_string().to_ascii_lowercase(),
    };
    Some(Endpoint {
        key: format!("{host}:{port}"),
        label: format!("{what} — {}://{host}:{port}", u.scheme()),
    })
}

/// `host:port` endpoint (Electrum, P2P peer, certificate fetch).
pub fn host_port_endpoint(what: &str, host: &str, port: u16) -> Endpoint {
    let h = host
        .trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_ascii_lowercase();
    let h = if h.contains(':') { format!("[{h}]") } else { h };
    Endpoint {
        key: format!("{h}:{port}"),
        label: format!("{what} — {h}:{port}"),
    }
}

/// Every custom server of `s` (default servers are never listed: they are in the allowlist).
pub fn endpoints(s: &Servers) -> Vec<Endpoint> {
    let mut out = Vec::new();
    for (net, b) in [
        ("mainnet", &s.bitcoin.mainnet),
        ("testnet4", &s.bitcoin.testnet4),
    ] {
        match b {
            Some(BtcServer::Esplora { url }) => {
                out.extend(url_endpoint(&format!("Bitcoin {net} (Esplora)"), url));
            }
            Some(BtcServer::Core { url, auth }) => {
                let what = match auth {
                    CoreAuth::Cookie { .. } => "Bitcoin Core, fichier .cookie",
                    CoreAuth::Userpass { .. } => "Bitcoin Core, utilisateur RPC",
                };
                out.extend(url_endpoint(&format!("Bitcoin {net} ({what})"), url));
            }
            Some(BtcServer::Electrum { host, port, .. }) => {
                out.push(host_port_endpoint(
                    &format!("Bitcoin {net} (Electrum)"),
                    host,
                    *port,
                ));
            }
            Some(BtcServer::Cbf { peers, .. }) => {
                for p in peers {
                    if let Ok(peer) = crate::servers::parse_peer(p) {
                        out.push(host_port_endpoint(
                            &format!("Bitcoin {net} (pair P2P)"),
                            &peer.host_string(),
                            peer.port,
                        ));
                    }
                }
            }
            Some(BtcServer::Default) | None => {}
        }
    }
    for (coin, servers) in [("Litecoin", &s.litecoin), ("Dogecoin", &s.dogecoin)] {
        for (net, u) in servers.entries() {
            if let Some(UtxoServer::Esplora { url }) = u {
                out.extend(url_endpoint(&format!("{coin} {net} (Esplora)"), url));
            }
        }
    }
    for (net, t) in s.tron.entries() {
        if let Some(TronServer::Http { url }) = t {
            out.extend(url_endpoint(&format!("TRON {net} (java-tron)"), url));
        }
    }
    for (net, x) in s.xrp.entries() {
        if let Some(XrpServer::JsonRpc { url }) = x {
            out.extend(url_endpoint(&format!("XRP Ledger {net} (rippled)"), url));
        }
    }
    for (net, c) in s.cardano.entries() {
        if let Some(CardanoServer::Koios { url }) = c {
            out.extend(url_endpoint(&format!("Cardano {net} (Koios)"), url));
        }
    }
    for (chain, r) in &s.evm {
        out.extend(url_endpoint(&format!("EVM chaîne {chain} (RPC)"), &r.url));
    }
    for (cluster, r) in &s.solana {
        out.extend(url_endpoint(&format!("Solana {cluster} (RPC)"), &r.url));
    }
    out.sort();
    out.dedup_by(|a, b| a.key == b.key && a.label == b.label);
    out
}

/// Endpoints of `new` whose host:port is neither in `old` nor in `approved`.
pub fn unapproved(
    new: &[Endpoint],
    old: &[Endpoint],
    approved: &BTreeSet<String>,
) -> Vec<Endpoint> {
    let known: BTreeSet<&str> = old.iter().map(|e| e.key.as_str()).collect();
    let mut out: Vec<Endpoint> = new
        .iter()
        .filter(|e| !known.contains(e.key.as_str()) && !approved.contains(&e.key))
        .cloned()
        .collect();
    out.dedup_by(|a, b| a.key == b.key);
    out
}

/// Text of the approval dialog.
pub fn approval_text(list: &[Endpoint]) -> String {
    let mut out =
        String::from("Kyro va contacter ce(s) serveur(s), choisi(s) dans les réglages :\n\n");
    for e in list.iter().take(12) {
        out += &format!("• {}\n", crate::dialog_text::sanitize(&e.label, 160));
    }
    if list.len() > 12 {
        out += &format!("• … et {} autre(s)\n", list.len() - 12);
    }
    out += "\nIl verra tes adresses publiques et tes transactions (et, sans Tor, ton adresse IP). \
            Si tu n'as pas saisi toi-même cette adresse, REFUSE : une interface compromise \
            pourrait s'en servir pour faire sortir des données.\n\nAutoriser ce serveur ?";
    out
}

/// Asks natively for every endpoint of `new` that the user has not approved yet (not in the
/// saved settings `saved`, not approved earlier this session). Nothing is sent before.
pub async fn confirm_endpoints(
    app: &AppHandle,
    new: &[Endpoint],
    saved: &Servers,
) -> AppResult<()> {
    let state = app.state::<AppState>();
    let pending = unapproved(new, &endpoints(saved), &state.approved_hosts());
    if pending.is_empty() {
        return Ok(());
    }
    crate::commands::confirm_native_with(
        app,
        "Nouveau serveur",
        approval_text(&pending),
        "Autoriser",
        "Refuser",
    )
    .await?;
    state.approve_hosts(pending.into_iter().map(|e| e.key));
    Ok(())
}

/// Native confirmation before Tor goes from enabled to disabled.
pub async fn confirm_tor_off(app: &AppHandle) -> AppResult<()> {
    crate::commands::confirm_native_with(
        app,
        "Désactiver Tor ?",
        "Sans Tor, chaque serveur contacté par Kyro verra ton adresse IP, et ton fournisseur \
         d'accès verra quels serveurs tu contactes.\n\nSi tu n'as pas toi-même demandé à \
         désactiver Tor, REFUSE.\n\nDésactiver Tor ?"
            .into(),
        "Désactiver Tor",
        "Garder Tor",
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::servers::{ElectrumTls, RpcServer};

    #[test]
    fn endpoints_and_approval() {
        let mut s = Servers::default();
        s.evm.insert(
            "1".into(),
            RpcServer {
                url: "https://RPC.Example/eth".into(),
            },
        );
        s.bitcoin.testnet4 = Some(BtcServer::Electrum {
            host: "electrum.example".into(),
            port: 50002,
            tls: ElectrumTls::Webpki,
            cert_sha256: None,
        });
        let e = endpoints(&s);
        let keys: Vec<&str> = e.iter().map(|e| e.key.as_str()).collect();
        assert_eq!(keys, ["electrum.example:50002", "rpc.example:443"]);
        assert!(e[1]
            .label
            .contains("EVM chaîne 1 (RPC) — https://rpc.example:443"));

        // A new host is pending; the same host already saved (another path) or approved is not.
        let mut n = s.clone();
        n.solana.insert(
            "devnet".into(),
            RpcServer {
                url: "https://evil.example:8443/x".into(),
            },
        );
        n.evm.insert(
            "1".into(),
            RpcServer {
                url: "https://rpc.example/other-path".into(),
            },
        );
        let p = unapproved(&endpoints(&n), &e, &BTreeSet::new());
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].key, "evil.example:8443");
        let approved: BTreeSet<String> = ["evil.example:8443".to_owned()].into();
        assert!(unapproved(&endpoints(&n), &e, &approved).is_empty());
        // Changing only the port is a new endpoint (LAN scan).
        let mut lan = Servers::default();
        lan.xrp.testnet = Some(XrpServer::JsonRpc {
            url: "https://192.168.1.10:22/".into(),
        });
        let p = unapproved(&endpoints(&lan), &[], &BTreeSet::new());
        assert_eq!(p[0].key, "192.168.1.10:22");
        let t = approval_text(&p);
        assert!(t.contains("XRP Ledger testnet (rippled) — https://192.168.1.10:22"));
        assert!(t.contains("REFUSE"));
    }

    #[test]
    fn hostile_host_text_stays_on_one_line() {
        let e = host_port_endpoint("Electrum (certificat)", "a.example\n• tout va bien", 1);
        let t = approval_text(&[e]);
        assert!(!t.contains("\n• tout va bien"), "{t}");
        let v6 = host_port_endpoint("x", "[::1]", 8332);
        assert_eq!(v6.key, "[::1]:8332");
    }
}
