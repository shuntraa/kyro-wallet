//! Bitcoin Core JSON-RPC client (the user's own node) and its watch-only descriptor wallet.
//!
//! Typing: plain `serde_json::Value` plus a handful of explicit field reads, not `corepc-types`.
//! We use ~12 RPCs and a few fields of each; `corepc-types` models every field of every Core
//! version (one module per major version) and would add a large, version-coupled dependency for
//! no extra safety here — amounts are converted explicitly and every field is checked.
//!
//! Transport: a node on loopback/LAN is reached directly; anything else over HTTPS (Tor or
//! clear per settings) or a `.onion` over Tor (`net::NetClient::server_request`).
//! Auth: the `.cookie` file (re-read on every request) or rpcuser/rpcpassword.

use base64::Engine as _;
use serde_json::{json, Value};
use wallet_core::Network;

use crate::error::{AppError, AppResult};
use crate::net::{Family, NetClient, ServerRequest};
use crate::servers::{validate_http_url, CoreAuth};

/// Name of Kyro's watch-only wallet on the node.
pub fn wallet_name(fingerprint: &str) -> String {
    format!("kyro-watch-{fingerprint}")
}

/// `getblockchaininfo.chain` expected for the app's network.
pub fn expected_chain(net: Network) -> &'static str {
    match net {
        Network::Mainnet => "main",
        Network::Testnet => "testnet4",
    }
}

/// A JSON-RPC level failure reported by the node (`error.code`, `error.message`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
}

#[derive(Debug)]
pub enum CallError {
    Rpc(RpcError),
    App(AppError),
}

impl From<AppError> for CallError {
    fn from(e: AppError) -> Self {
        CallError::App(e)
    }
}

impl From<CallError> for AppError {
    fn from(e: CallError) -> Self {
        match e {
            CallError::App(e) => e,
            CallError::Rpc(r) => AppError::InvalidInput(format!(
                "Bitcoin Core : {} (code {})",
                r.message.chars().take(300).collect::<String>(),
                r.code
            )),
        }
    }
}

pub struct CoreClient<'a> {
    net: &'a NetClient,
    url: url::Url,
    auth: CoreAuth,
    tor: bool,
}

/// Parses a JSON-RPC 1.0 response body (Core answers RPC errors with HTTP 500 + JSON).
pub fn parse_response(status: u16, body: &[u8]) -> Result<Value, CallError> {
    if status == 401 || status == 403 {
        return Err(CallError::App(AppError::ServerInvalid(
            "Bitcoin Core : authentification RPC refusée".into(),
        )));
    }
    let v: Value = serde_json::from_slice(body).map_err(|_| {
        CallError::App(AppError::ServerUnreachable(format!(
            "Bitcoin Core : réponse non JSON (HTTP {status})"
        )))
    })?;
    if let Some(err) = v.get("error").filter(|e| !e.is_null()) {
        return Err(CallError::Rpc(RpcError {
            code: err.get("code").and_then(Value::as_i64).unwrap_or(0),
            message: err
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("erreur inconnue")
                .to_owned(),
        }));
    }
    Ok(v.get("result").cloned().unwrap_or(Value::Null))
}

/// BTC amount (JSON number with 8 decimals) → sats, refusing negative/NaN/absurd values.
pub fn btc_to_sats(v: &Value) -> AppResult<u64> {
    let f = v
        .as_f64()
        .ok_or_else(|| AppError::ServerUnreachable("Bitcoin Core : montant manquant".into()))?;
    if !f.is_finite() || !(0.0..=21_000_000.0).contains(&f) {
        return Err(AppError::ServerUnreachable(
            "Bitcoin Core : montant invalide".into(),
        ));
    }
    Ok((f * 100_000_000.0).round() as u64)
}

/// BTC/kvB fee rate → sat/vB (rounded up, at least 1).
pub fn btc_per_kvb_to_sat_per_vb(v: &Value) -> Option<u64> {
    let f = v.as_f64()?;
    if !f.is_finite() || f <= 0.0 {
        return None;
    }
    Some(((f * 100_000.0).ceil() as u64).max(1))
}

impl<'a> CoreClient<'a> {
    pub fn new(net: &'a NetClient, url: &str, auth: &CoreAuth, tor: bool) -> AppResult<Self> {
        let url = validate_http_url(url, tor, true)?;
        // Defence in depth (also checked by `servers::validate`): the cookie never leaves the
        // machine / local network.
        if matches!(auth, CoreAuth::Cookie { .. })
            && !url.host_str().is_some_and(crate::servers::is_private_host)
        {
            return Err(AppError::ServerInvalid(
                "Bitcoin Core : fichier .cookie refusé pour un nœud distant".into(),
            ));
        }
        Ok(Self {
            net,
            url,
            auth: auth.clone(),
            tor,
        })
    }

    fn authorization(&self) -> AppResult<String> {
        let creds = match &self.auth {
            // Strict read: `.cookie` name, no symlink, <= 256 bytes, `__cookie__:<64 hex>`.
            CoreAuth::Cookie { cookie_path } => crate::servers::read_cookie(cookie_path)?,
            CoreAuth::Userpass { user, password, .. } => zeroize::Zeroizing::new(format!(
                "{user}:{}",
                password.as_deref().ok_or_else(|| AppError::ServerInvalid(
                    "Bitcoin Core : mot de passe RPC manquant".into()
                ))?
            )),
        };
        Ok(format!(
            "Basic {}",
            base64::engine::general_purpose::STANDARD.encode(creds.as_bytes())
        ))
    }

    /// One RPC call. `wallet` targets `/wallet/<name>`; `long` allows a long rescan
    /// (direct connections only).
    pub async fn call(
        &self,
        wallet: Option<&str>,
        method: &str,
        params: Value,
        long: bool,
    ) -> Result<Value, CallError> {
        let mut url = self.url.clone();
        if let Some(w) = wallet {
            url.path_segments_mut()
                .map_err(|()| CallError::App(AppError::ServerInvalid("URL Core invalide".into())))?
                .pop_if_empty()
                .push("wallet")
                .push(w);
        }
        let body = json!({ "jsonrpc": "1.0", "id": "kyro", "method": method, "params": params });
        let mut req = ServerRequest::post_json(url, Family::Bitcoin, body.to_string());
        req.headers
            .push(("authorization".into(), self.authorization()?));
        req.direct_private = true;
        req.long = long;
        let (status, bytes) = self.net.server_request(req, self.tor).await?;
        parse_response(status, &bytes)
    }

    pub async fn chain(&self) -> AppResult<(String, u64)> {
        let info = self
            .call(None, "getblockchaininfo", json!([]), false)
            .await?;
        let chain = info
            .get("chain")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::ServerUnreachable("Bitcoin Core : chain manquant".into()))?
            .to_owned();
        let blocks = info.get("blocks").and_then(Value::as_u64).unwrap_or(0);
        Ok((chain, blocks))
    }

    /// Loads the watch-only wallet if needed. `Ok(false)` = it does not exist yet.
    pub async fn ensure_loaded(&self, name: &str) -> AppResult<bool> {
        let loaded = self.call(None, "listwallets", json!([]), false).await?;
        if loaded
            .as_array()
            .is_some_and(|a| a.iter().any(|w| w.as_str() == Some(name)))
        {
            return Ok(true);
        }
        match self.call(None, "loadwallet", json!([name]), false).await {
            Ok(_) => Ok(true),
            Err(CallError::Rpc(RpcError { code: -35, .. })) => Ok(true), // already loaded
            Err(CallError::Rpc(RpcError { code: -18, .. })) => Ok(false), // not found
            Err(e) => Err(e.into()),
        }
    }

    /// Creates (or loads) `name` as a blank, private-key-less descriptor wallet.
    pub async fn create_watch_wallet(&self, name: &str) -> AppResult<()> {
        // createwallet name disable_private_keys blank passphrase avoid_reuse descriptors load_on_startup
        let params = json!([name, true, true, "", false, true, true]);
        match self.call(None, "createwallet", params, false).await {
            Ok(_) => Ok(()),
            Err(CallError::Rpc(RpcError { code: -4, .. })) => {
                // Already exists: make sure it is loaded and really watch-only.
                self.ensure_loaded(name).await?;
                let info = self
                    .call(Some(name), "getwalletinfo", json!([]), false)
                    .await?;
                if info.get("private_keys_enabled").and_then(Value::as_bool) != Some(false) {
                    return Err(AppError::ServerInvalid(format!(
                        "le portefeuille « {name} » existe mais contient des clés privées"
                    )));
                }
                Ok(())
            }
            Err(e) => Err(e.into()),
        }
    }

    /// Adds the checksum Core computes (`getdescriptorinfo`).
    pub async fn with_checksum(&self, desc: &str) -> AppResult<String> {
        let info = self
            .call(None, "getdescriptorinfo", json!([desc]), false)
            .await?;
        let checksum = info
            .get("checksum")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                AppError::ServerUnreachable("getdescriptorinfo : checksum manquant".into())
            })?;
        if info.get("isrange").and_then(Value::as_bool) != Some(true)
            || info.get("hasprivatekeys").and_then(Value::as_bool) != Some(false)
        {
            return Err(AppError::Internal("descripteur inattendu".into()));
        }
        Ok(format!("{desc}#{checksum}"))
    }

    /// `importdescriptors` (rescan from `timestamp`, `None` = "now", i.e. no rescan).
    pub async fn import(
        &self,
        name: &str,
        descriptors: &[(String, bool)],
        timestamp: Option<u64>,
    ) -> AppResult<()> {
        let ts = timestamp.map_or(json!("now"), |t| json!(t));
        let reqs: Vec<Value> = descriptors
            .iter()
            .map(|(desc, internal)| {
                json!({ "desc": desc, "active": true, "range": [0, 999], "next_index": 0,
                        "timestamp": ts, "internal": internal })
            })
            .collect();
        let res = self
            .call(Some(name), "importdescriptors", json!([reqs]), true)
            .await?;
        let failures: Vec<String> = res
            .as_array()
            .map(|a| {
                a.iter()
                    .filter(|r| r.get("success").and_then(Value::as_bool) != Some(true))
                    .map(|r| r.get("error").map(Value::to_string).unwrap_or_default())
                    .collect()
            })
            .unwrap_or_else(|| vec!["réponse inattendue".into()]);
        if !failures.is_empty() {
            return Err(AppError::InvalidInput(format!(
                "importdescriptors : {}",
                failures.join("; ")
            )));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Recorded Bitcoin Core v28 JSON-RPC responses (shapes from the Core RPC docs).
    const GETBLOCKCHAININFO: &str = r#"{"result":{"chain":"testnet4","blocks":158172,"headers":158172,"bestblockhash":"00000000000000c5b3e8a6d3a6b1b0e1f0a2b3c4d5e6f708192a3b4c5d6e7f80","difficulty":1,"time":1793333429,"mediantime":1793333000,"verificationprogress":1,"initialblockdownload":false,"chainwork":"00","size_on_disk":1,"pruned":false,"warnings":[]},"error":null,"id":"kyro"}"#;
    const WALLET_NOT_FOUND: &str = r#"{"result":null,"error":{"code":-18,"message":"Requested wallet does not exist or is not loaded"},"id":"kyro"}"#;
    const ESTIMATESMARTFEE: &str =
        r#"{"result":{"feerate":0.00012345,"blocks":2},"error":null,"id":"kyro"}"#;
    const LISTUNSPENT: &str = r#"{"result":[{"txid":"a6c9c361bd0bc536d6a22648efbf8f9b200e425ef6c3a7a9669dc444c532a347","vout":1,"address":"tb1q6rz28mcfaxtmd6v789l9rrlrusdprr9pqcpvkl","amount":0.00100000,"confirmations":3,"spendable":false,"solvable":true,"safe":true}],"error":null,"id":"kyro"}"#;

    #[test]
    fn parses_recorded_responses() {
        let v = parse_response(200, GETBLOCKCHAININFO.as_bytes()).unwrap();
        assert_eq!(v["chain"], "testnet4");
        assert_eq!(v["blocks"], 158172);
        // Core reports RPC errors with HTTP 500 and a JSON body.
        match parse_response(500, WALLET_NOT_FOUND.as_bytes()) {
            Err(CallError::Rpc(RpcError { code: -18, .. })) => {}
            other => panic!("{other:?}"),
        }
        let fee = parse_response(200, ESTIMATESMARTFEE.as_bytes()).unwrap();
        assert_eq!(btc_per_kvb_to_sat_per_vb(&fee["feerate"]), Some(13));
        let utxos = parse_response(200, LISTUNSPENT.as_bytes()).unwrap();
        assert_eq!(btc_to_sats(&utxos[0]["amount"]).unwrap(), 100_000);
        assert!(matches!(
            parse_response(401, b""),
            Err(CallError::App(AppError::ServerInvalid(_)))
        ));
        assert!(matches!(
            parse_response(502, b"<html>bad gateway</html>"),
            Err(CallError::App(AppError::ServerUnreachable(_)))
        ));
    }

    #[test]
    fn amounts() {
        assert_eq!(btc_to_sats(&json!(0.1)).unwrap(), 10_000_000);
        assert_eq!(
            btc_to_sats(&json!(20999999.9769)).unwrap(),
            2_099_999_997_690_000
        );
        assert_eq!(btc_to_sats(&json!(0.00000001)).unwrap(), 1);
        assert!(btc_to_sats(&json!(-1)).is_err());
        assert!(btc_to_sats(&json!("1")).is_err());
        assert!(btc_to_sats(&json!(22000000)).is_err());
        assert_eq!(btc_per_kvb_to_sat_per_vb(&json!(0.00001)), Some(1));
        assert_eq!(btc_per_kvb_to_sat_per_vb(&json!(-1)), None);
    }

    #[test]
    fn names_and_chains() {
        assert_eq!(wallet_name("73c5da0a"), "kyro-watch-73c5da0a");
        assert_eq!(expected_chain(Network::Testnet), "testnet4");
        assert_eq!(expected_chain(Network::Mainnet), "main");
    }

    #[test]
    fn cookie_auth_is_read_fresh() {
        let dir = std::env::temp_dir().join(format!("kyro-cookie-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(".cookie");
        let first = format!("__cookie__:{}", "0f".repeat(32));
        let rotated = format!("__cookie__:{}", "e2".repeat(32));
        std::fs::write(&path, format!("{first}\n")).unwrap();
        let net = NetClient::new(dir.join("tor")).unwrap();
        let auth = CoreAuth::Cookie {
            cookie_path: path.to_string_lossy().into_owned(),
        };
        let c = CoreClient::new(&net, "http://127.0.0.1:48332", &auth, true).unwrap();
        let b64 = base64::engine::general_purpose::STANDARD;
        assert_eq!(
            c.authorization().unwrap(),
            format!("Basic {}", b64.encode(&first))
        );
        std::fs::write(&path, &rotated).unwrap();
        assert_eq!(
            c.authorization().unwrap(),
            format!("Basic {}", b64.encode(&rotated))
        );
        // Not a cookie: refused, nothing sent.
        std::fs::write(&path, "{\"apiKeys\":{}}").unwrap();
        assert!(matches!(c.authorization(), Err(AppError::ServerInvalid(_))));
        std::fs::remove_file(&path).unwrap();
        assert!(matches!(c.authorization(), Err(AppError::ServerInvalid(_))));
        // Remote plain http is refused at construction, and so is a remote HTTPS node with
        // cookie auth (CRITIQUE 1: the cookie would leave the machine).
        assert!(CoreClient::new(&net, "http://node.example:8332", &auth, true).is_err());
        assert!(CoreClient::new(&net, "https://node.example:8332", &auth, true).is_err());
    }
}
