//! TON data from TON Center's public API v3 (`toncenter.com` on mainnet,
//! `testnet.toncenter.com` on testnet), on the `ton` Tor family, never with a fallback.
//!
//! The keyless tier allows about **one request per second per IP** (checked 2026-11-01: the
//! third request within a second gets `429 Ratelimit exceed`). Every TON request of the app is
//! therefore paced (≥ [`PACE`] apart, one at a time) and a `429` is retried a few times after a
//! pause. An optional key (`KYRO_TONCENTER_API_KEY`, dev `.env`) is sent as `X-API-Key` to
//! TON Center only.
//!
//! Kyro builds the transfer itself (seqno and account state read here, cells written by
//! wallet-core): a server-built message is never signed. What the server can lie about is in
//! SECURITY.md (balance, seqno, account states, history, fee estimate).

use std::sync::OnceLock;
use std::time::{Duration, Instant};

use base64::Engine as _;
use serde::Serialize;
use serde_json::{json, Value};
use wallet_core::{Network, TonAddress};

use crate::error::{AppError, AppResult};
use crate::net::{Family, NetClient, ServerRequest};

/// Minimum spacing between two TON Center requests (keyless tier: 1 request / s).
pub const PACE: Duration = Duration::from_millis(1_100);
/// Retries of a `429` (after 1.5 s, 3 s, 4.5 s).
const RETRIES_429: u32 = 3;
const MAX_TXS: u32 = 50;
/// A transfer is valid this long after it is built (the wallet refuses it afterwards).
pub const VALID_FOR_SECS: u32 = 600;

pub struct TonCtx<'a> {
    pub net_client: &'a NetClient,
    pub network: Network,
    pub tor: bool,
    /// Optional TON Center key, sent (`X-API-Key`) to TON Center only.
    pub api_key: Option<String>,
}

fn bad(msg: impl Into<String>) -> AppError {
    AppError::ServerUnreachable(msg.into())
}

pub fn host(net: Network) -> &'static str {
    match net {
        Network::Mainnet => "toncenter.com",
        Network::Testnet => "testnet.toncenter.com",
    }
}

fn base_url(net: Network) -> String {
    format!("https://{}/api/v3/", host(net))
}

pub fn testnet(net: Network) -> bool {
    net == Network::Testnet
}

/// One TON request at a time, at least [`PACE`] after the previous one (all networks: the limit
/// is per IP, and both hosts are the same service).
fn pacer() -> &'static tokio::sync::Mutex<Option<Instant>> {
    static P: OnceLock<tokio::sync::Mutex<Option<Instant>>> = OnceLock::new();
    P.get_or_init(|| tokio::sync::Mutex::new(None))
}

/// Error text of a TON Center reply (`{"error": "…"}` or `{"detail": …}`), capped.
fn error_text(bytes: &[u8]) -> String {
    let v: Value = serde_json::from_slice(bytes).unwrap_or(Value::Null);
    let s = v["error"]
        .as_str()
        .map(str::to_owned)
        .or_else(|| v["detail"].as_str().map(str::to_owned))
        .or_else(|| (!v["detail"].is_null()).then(|| v["detail"].to_string()))
        .unwrap_or_else(|| String::from_utf8_lossy(bytes).into_owned());
    crate::dialog_text::sanitize(&s, 200)
}

/// `(status, body)` of a request, paced, `429` retried.
async fn send(ctx: &TonCtx<'_>, req: ServerRequest) -> AppResult<(u16, Vec<u8>)> {
    let mut attempt = 0;
    loop {
        let mut last = pacer().lock().await;
        if let Some(t) = *last {
            let wait = PACE.saturating_sub(t.elapsed());
            if !wait.is_zero() {
                tokio::time::sleep(wait).await;
            }
        }
        let r = ctx.net_client.server_request(req.clone(), ctx.tor).await;
        *last = Some(Instant::now());
        drop(last);
        let (status, bytes) = r?;
        if status == 429 && attempt < RETRIES_429 {
            attempt += 1;
            tokio::time::sleep(Duration::from_millis(1_500 * u64::from(attempt))).await;
            continue;
        }
        if status == 429 {
            return Err(bad(
                "TON Center : trop de requêtes (limite publique d'environ 1 par seconde, partagée par IP — via Tor, avec d'autres utilisateurs du même relais). Réessaie dans un moment.",
            ));
        }
        return Ok((status, bytes));
    }
}

fn request(
    ctx: &TonCtx<'_>,
    path: &str,
    query: &[(&str, &str)],
    body: Option<Value>,
) -> AppResult<ServerRequest> {
    let mut u = url::Url::parse(&base_url(ctx.network))
        .and_then(|b| b.join(path))
        .map_err(|_| AppError::Internal("URL TON Center invalide".into()))?;
    if !query.is_empty() {
        u.query_pairs_mut().extend_pairs(query);
    }
    let mut r = match body {
        Some(b) => ServerRequest::post_json(u, Family::Ton, b.to_string()),
        None => ServerRequest::get(u, Family::Ton),
    };
    if let Some(k) = ctx.api_key.as_deref().filter(|k| !k.contains(['\r', '\n'])) {
        r.headers.push(("x-api-key".into(), k.to_owned()));
    }
    Ok(r)
}

async fn get(ctx: &TonCtx<'_>, path: &str, query: &[(&str, &str)]) -> AppResult<Value> {
    let (status, bytes) = send(ctx, request(ctx, path, query, None)?).await?;
    if status != 200 {
        return Err(bad(format!(
            "TON Center : HTTP {status} sur {path} ({})",
            error_text(&bytes)
        )));
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| bad(format!("TON Center : JSON invalide sur {path}")))
}

// ---------------------------------------------------------------- accounts

/// Account state, as TON Center reports it.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TonStatus {
    /// Deployed contract.
    Active,
    /// Never deployed (or deleted): may hold a balance.
    Uninit,
    /// Frozen (storage debt): cannot send.
    Frozen,
    /// Not on chain at all.
    Nonexist,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TonAccountInfo {
    /// Non-bounceable user-friendly form (testnet flag on testnet).
    pub address: String,
    pub raw: String,
    pub status: TonStatus,
    /// Nanotons, decimal string.
    pub balance: String,
    /// Wallet seqno (active wallets only).
    pub seqno: Option<u32>,
    /// Contract kind recognized by TON Center (`wallet v4 r2`…), if any.
    pub wallet_type: Option<String>,
}

fn u64_of(v: &Value) -> Option<u64> {
    match v {
        Value::String(s) => s.parse().ok(),
        Value::Number(n) => n.as_u64(),
        _ => None,
    }
}

pub fn parse_wallet_info(v: &Value, addr: &TonAddress, net: Network) -> AppResult<TonAccountInfo> {
    let status = match v["status"].as_str().unwrap_or("") {
        "active" => TonStatus::Active,
        "uninit" | "uninitialized" => TonStatus::Uninit,
        "frozen" => TonStatus::Frozen,
        "nonexist" | "nonexistent" => TonStatus::Nonexist,
        other => {
            return Err(bad(format!(
                "TON Center : état de compte inconnu « {} »",
                crate::dialog_text::sanitize(other, 40)
            )))
        }
    };
    let balance = u64_of(&v["balance"]).ok_or_else(|| bad("TON Center : solde absent"))?;
    let seqno = match status {
        TonStatus::Active => v["seqno"].as_u64().and_then(|s| u32::try_from(s).ok()),
        _ => None,
    };
    Ok(TonAccountInfo {
        address: addr.to_friendly(false, testnet(net)),
        raw: addr.to_raw(),
        status,
        balance: balance.to_string(),
        seqno,
        wallet_type: v["wallet_type"]
            .as_str()
            .map(|s| crate::dialog_text::sanitize(s, 40)),
    })
}

/// State, balance and (for an active wallet) seqno of any account.
pub async fn account(ctx: &TonCtx<'_>, addr: &TonAddress) -> AppResult<TonAccountInfo> {
    let raw = addr.to_raw();
    let v = get(
        ctx,
        "walletInformation",
        &[("address", raw.as_str()), ("use_v2", "false")],
    )
    .await?;
    parse_wallet_info(&v, addr, ctx.network)
}

// ---------------------------------------------------------------- fees

/// Fee estimate (nanotons) of an external message: TON Center emulates it (`estimateFee`, the
/// zero signature not checked). Sum of the source fees: import, storage, gas, forward.
pub async fn estimate_fee(
    ctx: &TonCtx<'_>,
    wallet: &TonAddress,
    parts: &wallet_core::TonEstimateParts,
) -> AppResult<u64> {
    emulate(ctx, wallet, parts, true).await
}

/// `estimateFee` with or without the signature check (`ignore_chksig`).
pub async fn emulate(
    ctx: &TonCtx<'_>,
    wallet: &TonAddress,
    parts: &wallet_core::TonEstimateParts,
    ignore_chksig: bool,
) -> AppResult<u64> {
    let mut body =
        json!({ "address": wallet.to_raw(), "body": parts.body, "ignore_chksig": ignore_chksig });
    if !parts.init_code.is_empty() {
        body["init_code"] = json!(parts.init_code);
        body["init_data"] = json!(parts.init_data);
    }
    let (status, bytes) = send(ctx, request(ctx, "estimateFee", &[], Some(body))?).await?;
    if status != 200 {
        return Err(bad(format!(
            "TON Center : estimation des frais impossible ({})",
            error_text(&bytes)
        )));
    }
    let v: Value =
        serde_json::from_slice(&bytes).map_err(|_| bad("TON Center : JSON invalide (frais)"))?;
    parse_fee(&v)
}

pub fn parse_fee(v: &Value) -> AppResult<u64> {
    let f = &v["source_fees"];
    let mut total = 0u64;
    for k in ["in_fwd_fee", "storage_fee", "gas_fee", "fwd_fee"] {
        total = total
            .checked_add(
                u64_of(&f[k]).ok_or_else(|| bad(format!("TON Center : frais {k} absents")))?,
            )
            .ok_or_else(|| bad("TON Center : frais invalides"))?;
    }
    Ok(total)
}

// ---------------------------------------------------------------- broadcast, status

fn b64_to_hex(s: &str) -> Option<String> {
    let s = s.trim();
    base64::engine::general_purpose::STANDARD
        .decode(s)
        .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(s))
        .ok()
        .filter(|b| b.len() == 32)
        .map(hex::encode)
}

/// Sends a signed external message (`POST /message`). TON Center returns the message hash and
/// the normalized hash: both must be ours. A message the node refuses (bad seqno, expired,
/// signature) comes back as an HTTP error: nothing was sent.
pub async fn submit(
    ctx: &TonCtx<'_>,
    boc: &str,
    hash: &str,
    normalized: &str,
) -> AppResult<String> {
    let (status, bytes) = send(
        ctx,
        request(ctx, "message", &[], Some(json!({ "boc": boc.trim() })))?,
    )
    .await?;
    if status != 200 {
        return Err(AppError::InvalidInput(format!(
            "transfert TON refusé par le nœud : {}",
            error_text(&bytes)
        )));
    }
    let v: Value =
        serde_json::from_slice(&bytes).map_err(|_| bad("TON Center : JSON invalide (envoi)"))?;
    check_submit_reply(&v, hash, normalized)
}

pub fn check_submit_reply(v: &Value, hash: &str, normalized: &str) -> AppResult<String> {
    let got = v["message_hash"].as_str().and_then(b64_to_hex);
    let got_norm = v["message_hash_norm"].as_str().and_then(b64_to_hex);
    if got.as_deref() != Some(hash) || got_norm.as_deref().is_some_and(|n| n != normalized) {
        return Err(bad(format!(
            "TON Center a répondu un hash inattendu ({})",
            crate::dialog_text::sanitize(&v.to_string(), 120)
        )));
    }
    Ok(normalized.to_owned())
}

/// `{ found, success }` of the transaction that processed our external message (looked up by
/// its normalized hash).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TonTxStatus {
    pub found: bool,
    /// Compute and action phases succeeded and every message was sent.
    pub success: bool,
    /// Transaction hash (hex), once found.
    pub tx_hash: Option<String>,
}

pub fn tx_success(t: &Value) -> bool {
    let d = &t["description"];
    d["aborted"] != true
        && d["compute_ph"]["success"] == true
        && d["action"]["success"] == true
        && d["action"]["skipped_actions"].as_u64().unwrap_or(0) == 0
        && d["action"]["msgs_created"].as_u64().unwrap_or(0) >= 1
}

pub async fn tx_status(ctx: &TonCtx<'_>, normalized_hex: &str) -> AppResult<TonTxStatus> {
    let v = get(
        ctx,
        "transactionsByMessage",
        &[
            ("msg_hash", normalized_hex),
            ("direction", "in"),
            ("limit", "1"),
        ],
    )
    .await?;
    Ok(match v["transactions"].as_array().and_then(|a| a.first()) {
        None => TonTxStatus {
            found: false,
            success: false,
            tx_hash: None,
        },
        Some(t) => TonTxStatus {
            found: true,
            success: tx_success(t),
            tx_hash: t["hash"].as_str().and_then(b64_to_hex),
        },
    })
}

// ---------------------------------------------------------------- history

/// One history line: a transfer in or out of our wallet.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TonHistoryEntry {
    /// Transaction hash (hex).
    pub hash: String,
    /// ms epoch.
    pub time: Option<i64>,
    pub direction: &'static str,
    /// Counterparty (user-friendly, bounce flag as in the message), if any.
    pub counterparty: Option<String>,
    /// Nanotons.
    pub amount: String,
    /// Total fees of our transaction (nanotons), outgoing only.
    pub fee: Option<String>,
    /// Text comment (cleaned), if any.
    pub comment: Option<String>,
    /// Incoming funds that bounced back from a recipient (a failed earlier transfer).
    pub bounced: bool,
    pub success: bool,
}

fn friendly_of(raw: &Value, bounce: bool, net: Network) -> Option<String> {
    let a = wallet_core::ton_parse_raw_address(raw.as_str()?).ok()?;
    Some(a.to_friendly(bounce, testnet(net)))
}

fn comment_of(m: &Value) -> Option<String> {
    let d = &m["message_content"]["decoded"];
    (d["type"] == "text_comment")
        .then(|| d["comment"].as_str())
        .flatten()
        .map(|c| wallet_core::sanitize_text(c, 120).text)
}

/// Normalizes `/transactions` for our account `me`: an external message from us with its
/// outgoing messages, or an incoming internal message with a value.
pub fn parse_history(v: &Value, me: &TonAddress, net: Network) -> Vec<TonHistoryEntry> {
    let mut out = Vec::new();
    for t in v["transactions"].as_array().into_iter().flatten() {
        let Some(account) = t["account"]
            .as_str()
            .and_then(|a| wallet_core::ton_parse_raw_address(a).ok())
        else {
            continue;
        };
        if account != *me {
            continue;
        }
        let hash = t["hash"].as_str().and_then(b64_to_hex).unwrap_or_default();
        let time = t["now"].as_i64().map(|s| s * 1000);
        let success = tx_success(t);
        let in_msg = &t["in_msg"];
        let external = in_msg["source"].is_null();
        if external {
            let outs = t["out_msgs"].as_array().cloned().unwrap_or_default();
            if outs.is_empty() {
                // Our message was processed but nothing was sent (not enough funds…).
                out.push(TonHistoryEntry {
                    hash,
                    time,
                    direction: "out",
                    counterparty: None,
                    amount: "0".into(),
                    fee: u64_of(&t["total_fees"]).map(|f| f.to_string()),
                    comment: None,
                    bounced: false,
                    success: false,
                });
                continue;
            }
            for (i, m) in outs.iter().enumerate() {
                out.push(TonHistoryEntry {
                    hash: hash.clone(),
                    time,
                    direction: "out",
                    counterparty: friendly_of(&m["destination"], m["bounce"] == true, net),
                    amount: u64_of(&m["value"]).unwrap_or(0).to_string(),
                    fee: (i == 0)
                        .then(|| u64_of(&t["total_fees"]).map(|f| f.to_string()))
                        .flatten(),
                    comment: comment_of(m),
                    bounced: false,
                    success,
                });
            }
        } else {
            let value = u64_of(&in_msg["value"]).unwrap_or(0);
            if value == 0 {
                continue;
            }
            out.push(TonHistoryEntry {
                hash,
                time,
                direction: "in",
                counterparty: friendly_of(&in_msg["source"], in_msg["bounce"] == true, net),
                amount: value.to_string(),
                fee: None,
                comment: comment_of(in_msg),
                bounced: in_msg["bounced"] == true,
                success: t["description"]["aborted"] != true,
            });
        }
    }
    out
}

pub async fn txs(ctx: &TonCtx<'_>, me: &TonAddress) -> AppResult<Vec<TonHistoryEntry>> {
    let raw = me.to_raw();
    let limit = MAX_TXS.to_string();
    let v = get(
        ctx,
        "transactions",
        &[
            ("account", raw.as_str()),
            ("limit", limit.as_str()),
            ("sort", "desc"),
        ],
    )
    .await?;
    Ok(parse_history(&v, me, ctx.network))
}

// ---------------------------------------------------------------- checks

/// What `ton_build_tx` and `ton_sign_tx` check against live data. Errors are user-facing.
pub struct TransferCheck<'a> {
    pub ours: &'a TonAccountInfo,
    /// Nanotons; `None` = whole balance (mode 130).
    pub amount: Option<u64>,
    pub fee: u64,
}

pub fn check_transfer(c: &TransferCheck<'_>) -> AppResult<()> {
    let balance: u64 = c.ours.balance.parse().unwrap_or(0);
    match c.ours.status {
        TonStatus::Frozen => return Err(AppError::InvalidInput(
            "ton portefeuille TON est gelé (frais de stockage impayés) : il ne peut rien envoyer"
                .into(),
        )),
        TonStatus::Nonexist => {
            return Err(AppError::InvalidInput(
                "ton portefeuille TON n'a encore rien reçu : il ne peut rien envoyer".into(),
            ))
        }
        TonStatus::Uninit if balance == 0 => {
            return Err(AppError::InvalidInput(
                "ton portefeuille TON n'a encore rien reçu : il ne peut rien envoyer".into(),
            ))
        }
        TonStatus::Active if c.ours.seqno.is_none() => {
            return Err(bad("TON Center : seqno du portefeuille absent"));
        }
        _ => {}
    }
    let need = c.amount.unwrap_or(0).saturating_add(c.fee);
    if need >= balance {
        return Err(AppError::InvalidInput(format!(
            "solde GRAM insuffisant : {} GRAM, il en faut plus de {} (montant + frais estimés{})",
            crate::commands::format_units(&balance.to_string(), 9),
            crate::commands::format_units(&need.to_string(), 9),
            if c.ours.status == TonStatus::Uninit {
                ", dont le déploiement du portefeuille"
            } else {
                ""
            }
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn me() -> TonAddress {
        wallet_core::ton_parse_raw_address(
            "0:d85bfd5e49c255c6d8ada01464b2fa15f5c098a38b8a1962d53481c1d49a9147",
        )
        .unwrap()
    }

    #[test]
    fn wallet_information_replies() {
        // Recorded from toncenter.com/api/v3/walletInformation (2026-11-01).
        let active = json!({"balance":"849","wallet_type":"wallet v4 r2","seqno":17,"wallet_id":698983191,"last_transaction_lt":"37392640000001","last_transaction_hash":"YRP/8lga7kP+KzpaSdSuszRDk+ILbWD+/RZovuqCdJo=","status":"active"});
        let a = parse_wallet_info(&active, &me(), Network::Mainnet).unwrap();
        assert_eq!(
            a.address,
            "UQDYW_1eScJVxtitoBRksvoV9cCYo4uKGWLVNIHB1JqRRyQx"
        );
        assert_eq!(
            (a.status, a.balance.as_str(), a.seqno),
            (TonStatus::Active, "849", Some(17))
        );
        assert_eq!(a.wallet_type.as_deref(), Some("wallet v4 r2"));
        let none = json!({"balance":"0","last_transaction_lt":"0","last_transaction_hash":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=","status":"uninit"});
        let n = parse_wallet_info(&none, &me(), Network::Testnet).unwrap();
        assert_eq!((n.status, n.seqno), (TonStatus::Uninit, None));
        assert!(n.address.starts_with("0Q"));
        assert!(parse_wallet_info(
            &json!({"status":"weird","balance":"1"}),
            &me(),
            Network::Mainnet
        )
        .is_err());
        assert!(parse_wallet_info(&json!({"status":"active"}), &me(), Network::Mainnet).is_err());
    }

    #[test]
    fn fee_reply() {
        // Recorded from toncenter.com/api/v3/estimateFee (2026-11-01).
        let v = json!({"source_fees":{"in_fwd_fee":105601,"storage_fee":24695655,"gas_fee":38134,"fwd_fee":0},"destination_fees":[]});
        assert_eq!(parse_fee(&v).unwrap(), 105_601 + 24_695_655 + 38_134);
        assert!(parse_fee(&json!({"source_fees":{}})).is_err());
    }

    #[test]
    fn submit_reply_hashes_must_be_ours() {
        let h = "2aa96a63ed257885e0826f2123f4cfd0bff7f8a9cbd31891f56877ff3f806e3c";
        let b64 = base64::engine::general_purpose::STANDARD.encode(hex::decode(h).unwrap());
        assert_eq!(
            check_submit_reply(
                &json!({"message_hash": b64, "message_hash_norm": b64}),
                h,
                h
            )
            .unwrap(),
            h
        );
        assert!(check_submit_reply(&json!({"message_hash": b64}), h, h).is_ok());
        let other = base64::engine::general_purpose::STANDARD.encode([7u8; 32]);
        assert!(check_submit_reply(&json!({"message_hash": other}), h, h).is_err());
        assert!(check_submit_reply(
            &json!({"message_hash": b64, "message_hash_norm": other}),
            h,
            h
        )
        .is_err());
        assert!(check_submit_reply(&json!({}), h, h).is_err());
    }

    #[test]
    fn history_lines() {
        // Shapes of toncenter.com/api/v3/transactions (2026-11-01), trimmed.
        let v = json!({"transactions":[
            {"account":"0:D85BFD5E49C255C6D8ADA01464B2FA15F5C098A38B8A1962D53481C1D49A9147","hash":"YRP/8lga7kP+KzpaSdSuszRDk+ILbWD+/RZovuqCdJo=","now":1683281528,"total_fees":"7390482",
             "description":{"aborted":false,"compute_ph":{"success":true},"action":{"success":true,"skipped_actions":0,"msgs_created":0}},
             "in_msg":{"source":null,"destination":"0:D85BFD5E49C255C6D8ADA01464B2FA15F5C098A38B8A1962D53481C1D49A9147","value":null},"out_msgs":[]},
            {"account":"0:D85BFD5E49C255C6D8ADA01464B2FA15F5C098A38B8A1962D53481C1D49A9147","hash":"EwQrGoehVYHsG3Ux1lKgz8FX2EZb4e+spxTvsp5aP+U=","now":1672770146,"total_fees":"93",
             "description":{"aborted":false,"compute_ph":{"skipped":true},"action":null},
             "in_msg":{"source":"0:D33A19EEBD8C0D359C69387C3EFBBDA828A30695C6CB2E5EDC5BF2629AD7CFC9","destination":"0:D85BFD5E49C255C6D8ADA01464B2FA15F5C098A38B8A1962D53481C1D49A9147","value":"10","bounce":true,"bounced":false,
                       "message_content":{"decoded":{"type":"text_comment","comment":"hi\nthere"}}},"out_msgs":[]},
            {"account":"0:D85BFD5E49C255C6D8ADA01464B2FA15F5C098A38B8A1962D53481C1D49A9147","hash":"EwQrGoehVYHsG3Ux1lKgz8FX2EZb4e+spxTvsp5aP+U=","now":1672770000,"total_fees":"2000000",
             "description":{"aborted":false,"compute_ph":{"success":true},"action":{"success":true,"skipped_actions":0,"msgs_created":1}},
             "in_msg":{"source":null,"value":null},
             "out_msgs":[{"destination":"0:66FBE3C5C03BF5C82792F904C9F8BF28894A6AA3D213D41C20569B654AADEDB3","value":"1500000000","bounce":false,"message_content":{"decoded":{"type":"text_comment","comment":"123456"}}}]},
            {"account":"0:0000000000000000000000000000000000000000000000000000000000000000","hash":"x","in_msg":{},"out_msgs":[]}
        ]});
        let h = parse_history(&v, &me(), Network::Mainnet);
        assert_eq!(h.len(), 3);
        assert_eq!(
            (h[0].direction, h[0].success, h[0].amount.as_str()),
            ("out", false, "0")
        );
        assert_eq!(
            h[0].hash,
            "6113fff2581aee43fe2b3a5a49d4aeb3344393e20b6d60fefd1668beea82749a"
        );
        assert_eq!(
            (h[1].direction, h[1].amount.as_str(), h[1].success),
            ("in", "10", true)
        );
        assert_eq!(
            h[1].counterparty.as_deref(),
            Some("EQDTOhnuvYwNNZxpOHw--72oKKMGlcbLLl7cW_JimtfPyW1C")
        );
        assert_eq!(h[1].comment.as_deref(), Some("hi there"));
        assert_eq!(
            (h[2].direction, h[2].amount.as_str(), h[2].success),
            ("out", "1500000000", true)
        );
        assert_eq!(
            h[2].counterparty.as_deref(),
            Some("UQBm--PFwDv1yCeS-QTJ-L8oiUpqo9IT1BwgVptlSq3ts4DV")
        );
        assert_eq!(h[2].fee.as_deref(), Some("2000000"));
        assert_eq!(h[2].comment.as_deref(), Some("123456"));
    }

    fn acc(status: TonStatus, balance: u64, seqno: Option<u32>) -> TonAccountInfo {
        TonAccountInfo {
            address: String::new(),
            raw: String::new(),
            status,
            balance: balance.to_string(),
            seqno,
            wallet_type: None,
        }
    }

    #[test]
    fn transfer_checks() {
        let ok = |a: &TonAccountInfo, amount: Option<u64>| {
            check_transfer(&TransferCheck {
                ours: a,
                amount,
                fee: 5_000_000,
            })
        };
        let active = acc(TonStatus::Active, 1_000_000_000, Some(3));
        assert!(ok(&active, Some(900_000_000)).is_ok());
        assert!(
            matches!(ok(&active, Some(995_000_000)), Err(AppError::InvalidInput(m)) if m.contains("insuffisant"))
        );
        assert!(ok(&active, None).is_ok());
        assert!(ok(&acc(TonStatus::Active, 4_000_000, Some(3)), None).is_err());
        assert!(ok(&acc(TonStatus::Active, 1_000_000_000, None), Some(1)).is_err());
        let uninit = acc(TonStatus::Uninit, 1_000_000_000, None);
        assert!(ok(&uninit, Some(500_000_000)).is_ok());
        assert!(
            matches!(ok(&uninit, Some(999_000_000)), Err(AppError::InvalidInput(m)) if m.contains("déploiement"))
        );
        assert!(ok(&acc(TonStatus::Uninit, 0, None), Some(1)).is_err());
        assert!(ok(&acc(TonStatus::Frozen, 1_000_000_000, None), Some(1)).is_err());
        assert!(ok(&acc(TonStatus::Nonexist, 0, None), Some(1)).is_err());
    }
}
