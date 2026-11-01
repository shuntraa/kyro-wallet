//! Hedera data and submission, on the `hedera` Tor family, never with a fallback:

use serde::Serialize;
use serde_json::{json, Value};
use wallet_core::Network;

use crate::error::{AppError, AppResult};
use crate::net::{Family, NetClient, ServerRequest};

pub const MIRROR_MAINNET: &str = "https://mainnet-public.mirrornode.hedera.com";
pub const MIRROR_TESTNET: &str = "https://testnet.mirrornode.hedera.com";

/// gRPC-web proxies of consensus nodes, `(node account number, host)`, from the Hedera JS SDK
/// (`hiero-sdk-js` `src/constants/ClientConstants.js`, `MAINNET` and `WEB_TESTNET`, checked
/// 2026-11-01; each answered a gRPC-web request on 2026-11-01).
pub const MAINNET_NODES: &[(u64, &str)] = &[
    (3, "node00.swirldslabs.com"),
    (4, "node01-00-grpc.swirlds.com"),
    (7, "node04.swirldslabs.com"),
];
pub const TESTNET_NODES: &[(u64, &str)] = &[
    (3, "testnet-node00-00-grpc.hedera.com"),
    (4, "testnet-node01-00-grpc.hedera.com"),
    (5, "testnet-node02-00-grpc.hedera.com"),
];

/// Seconds a body stays valid (network maximum: 180).
pub const VALID_DURATION: i64 = 180;
/// The valid start is set this many seconds in the past (clock skew with the network).
pub const START_SKEW: i64 = 10;
const MAX_TXS: u32 = 50;
const FEE_HUNDREDTHS_OF_CENT: u64 = 50;
const FEE_CREATE_HUNDREDTHS_OF_CENT: u64 = 1_000;
/// Max fee bounds, tinybars: 0.01 HBAR … 5 HBAR.
pub const MIN_MAX_FEE: u64 = 1_000_000;
pub const MAX_MAX_FEE: u64 = 500_000_000;

pub struct HbarCtx<'a> {
    pub net_client: &'a NetClient,
    pub network: Network,
    pub tor: bool,
}

fn bad(msg: impl Into<String>) -> AppError {
    AppError::ServerUnreachable(msg.into())
}

pub fn mirror_base(net: Network) -> &'static str {
    match net {
        Network::Mainnet => MIRROR_MAINNET,
        Network::Testnet => MIRROR_TESTNET,
    }
}

pub fn nodes(net: Network) -> &'static [(u64, &'static str)] {
    match net {
        Network::Mainnet => MAINNET_NODES,
        Network::Testnet => TESTNET_NODES,
    }
}

pub fn node_ids(net: Network) -> Vec<u64> {
    nodes(net).iter().map(|(n, _)| *n).collect()
}

async fn mirror(ctx: &HbarCtx<'_>, path: &str) -> AppResult<Option<Value>> {
    let u = url::Url::parse(&format!("{}{path}", mirror_base(ctx.network)))
        .map_err(|_| AppError::Internal("invalid mirror node URL".into()))?;
    let (status, bytes) = ctx
        .net_client
        .server_request(ServerRequest::get(u, Family::Hedera), ctx.tor)
        .await?;
    if status == 404 {
        return Ok(None);
    }
    if status != 200 {
        return Err(bad(format!(
            "Hedera mirror node: HTTP {status} ({})",
            String::from_utf8_lossy(&bytes)
                .chars()
                .take(200)
                .collect::<String>()
        )));
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| bad("Hedera mirror node: invalid JSON"))
}

fn num_of(v: &Value) -> Option<u64> {
    v.as_str()?.strip_prefix("0.0.")?.parse().ok()
}

fn tinybars(v: &Value) -> Option<u64> {
    v.as_u64()
        .or_else(|| v.as_i64().and_then(|n| u64::try_from(n).ok()))
}

/// What the mirror node says about one account.
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HbarAccountInfo {
    /// The account exists.
    pub exists: bool,
    /// `0.0.x`.
    pub account_id: Option<String>,
    /// Its EVM address (alias, or long-zero form), lower case, as the mirror node says.
    pub evm_address: Option<String>,
    /// Tinybars, decimal string.
    pub balance: String,
    /// Hollow account (created by a transfer to an EVM address, no key yet): our first signed
    /// transfer sets its key.
    pub hollow: bool,
    pub deleted: bool,
    /// The account must sign incoming transfers: a plain transfer to it fails.
    pub receiver_sig_required: bool,
    /// How our own account was found: `alias` (EVM address = our key's) or `publicKey` (an
    /// account with our key but another EVM address: the EVM address must NOT be used to
    /// receive, it would create a different account).
    pub found_by: Option<&'static str>,
    /// `max_automatic_token_associations`: -1 = unlimited (accounts auto-created by a transfer
    /// to their EVM address), 0 = every token must be associated first.
    pub max_auto_associations: i64,
}

fn parse_account(v: &Value) -> HbarAccountInfo {
    HbarAccountInfo {
        exists: true,
        account_id: v["account"].as_str().map(str::to_owned),
        evm_address: v["evm_address"].as_str().map(str::to_ascii_lowercase),
        balance: tinybars(&v["balance"]["balance"]).unwrap_or(0).to_string(),
        hollow: v["key"].is_null(),
        deleted: v["deleted"] == true,
        receiver_sig_required: v["receiver_sig_required"] == true,
        found_by: None,
        max_auto_associations: v["max_automatic_token_associations"].as_i64().unwrap_or(0),
    }
}

fn not_found() -> HbarAccountInfo {
    HbarAccountInfo {
        balance: "0".into(),
        ..Default::default()
    }
}

fn key_is(v: &Value, pk_hex: &str) -> bool {
    v["key"]["_type"] == "ECDSA_SECP256K1" && v["key"]["key"].as_str() == Some(pk_hex)
}

/// Our account: first by EVM address (the alias auto-created by a transfer to it, or set by a
/// wallet), else by public key (an account created with our key and no alias). The mirror's
/// answer must match our EVM address or our key.
pub async fn our_account(
    ctx: &HbarCtx<'_>,
    evm: &str,
    pubkey: &[u8; 33],
) -> AppResult<HbarAccountInfo> {
    let evm = evm.to_ascii_lowercase();
    let pk_hex = hex::encode(pubkey);
    if let Some(v) = mirror(ctx, &format!("/api/v1/accounts/{evm}?transactions=false")).await? {
        let mut a = parse_account(&v);
        if a.evm_address.as_deref() != Some(evm.as_str()) {
            return Err(bad(
                "Hedera mirror node: the returned account does not have our EVM address",
            ));
        }
        if !a.hollow && !key_is(&v, &pk_hex) {
            return Err(bad(
                "this Hedera account has our EVM address but another key: Kyro cannot spend from it",
            ));
        }
        a.found_by = Some("alias");
        return Ok(a);
    }
    let list = mirror(
        ctx,
        &format!("/api/v1/accounts?account.publickey={pk_hex}&balance=true&limit=5&order=asc"),
    )
    .await?;
    let found = list
        .as_ref()
        .and_then(|l| l["accounts"].as_array())
        .and_then(|a| {
            a.iter()
                .find(|v| key_is(v, &pk_hex) && v["deleted"] != true)
        });
    Ok(match found {
        Some(v) => HbarAccountInfo {
            found_by: Some("publicKey"),
            ..parse_account(v)
        },
        None => not_found(),
    })
}

/// A hardware (Ledger) account: an ED25519 account found by its public key (the mirror's key must
/// be exactly ours).
pub async fn our_account_ed25519(
    ctx: &HbarCtx<'_>,
    pubkey: &[u8; 32],
) -> AppResult<HbarAccountInfo> {
    let pk_hex = hex::encode(pubkey);
    let list = mirror(
        ctx,
        &format!("/api/v1/accounts?account.publickey={pk_hex}&balance=true&limit=5&order=asc"),
    )
    .await?;
    let found = list
        .as_ref()
        .and_then(|l| l["accounts"].as_array())
        .and_then(|a| {
            a.iter().find(|v| {
                v["key"]["_type"] == "ED25519"
                    && v["key"]["key"].as_str() == Some(pk_hex.as_str())
                    && v["deleted"] != true
            })
        });
    Ok(match found {
        Some(v) => HbarAccountInfo {
            found_by: Some("publicKey"),
            ..parse_account(v)
        },
        None => not_found(),
    })
}

/// A recipient (`0.0.x` or `0x…`).
pub async fn account(ctx: &HbarCtx<'_>, id: &str) -> AppResult<HbarAccountInfo> {
    Ok(
        match mirror(ctx, &format!("/api/v1/accounts/{id}?transactions=false")).await? {
            Some(v) => parse_account(&v),
            None => not_found(),
        },
    )
}

/// One account's relation to a known HTS token (mirror `/accounts/{id}/tokens?token.id=…`).
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HbarTokenHolding {
    /// `0.0.num` of the token.
    pub token_id: String,
    /// Associated: the account can hold and receive the token.
    pub associated: bool,
    /// Token units, decimal string.
    pub balance: String,
    /// Frozen by the token's freeze key: can neither send nor receive it.
    pub frozen: bool,
}

/// Parses the mirror's `tokens` list for token `0.0.num` (other rows are ignored).
pub fn parse_holding(v: Option<&Value>, num: u64) -> HbarTokenHolding {
    let id = format!("0.0.{num}");
    let row = v.and_then(|v| v["tokens"].as_array()).and_then(|a| {
        a.iter()
            .find(|t| t["token_id"].as_str() == Some(id.as_str()))
    });
    match row {
        Some(t) => HbarTokenHolding {
            token_id: id,
            associated: true,
            balance: tinybars(&t["balance"]).unwrap_or(0).to_string(),
            frozen: t["freeze_status"] == "FROZEN",
        },
        None => HbarTokenHolding {
            token_id: id,
            balance: "0".into(),
            ..Default::default()
        },
    }
}

/// `account` (`0.0.x`) and known token `0.0.num`.
pub async fn token_holding(
    ctx: &HbarCtx<'_>,
    account: &str,
    num: u64,
) -> AppResult<HbarTokenHolding> {
    let v = mirror(
        ctx,
        &format!("/api/v1/accounts/{account}/tokens?token.id=0.0.{num}&limit=1"),
    )
    .await?;
    Ok(parse_holding(v.as_ref(), num))
}

/// `(cent_equivalent, hbar_equivalent)` of the current exchange rate: `hbar_equivalent` HBAR
/// are worth `cent_equivalent` US cents.
pub async fn exchange_rate(ctx: &HbarCtx<'_>) -> AppResult<(u64, u64)> {
    let v = mirror(ctx, "/api/v1/network/exchangerate")
        .await?
        .ok_or_else(|| bad("Hedera mirror node: exchange rate missing"))?;
    let r = &v["current_rate"];
    match (r["cent_equivalent"].as_u64(), r["hbar_equivalent"].as_u64()) {
        (Some(c), Some(h)) if c > 0 && h > 0 => Ok((c, h)),
        _ => Err(bad("Hedera mirror node: invalid exchange rate")),
    }
}

/// Max fee for a transfer, tinybars, from the exchange rate (bounded 0.01 … 5 HBAR).
pub fn max_fee(rate: (u64, u64), creates_account: bool) -> u64 {
    let (cents, hbars) = rate;
    let budget = if creates_account {
        FEE_CREATE_HUNDREDTHS_OF_CENT
    } else {
        FEE_HUNDREDTHS_OF_CENT
    };
    let t = u128::from(budget) * u128::from(hbars) * u128::from(wallet_core::HBAR_TINYBARS)
        / (100 * u128::from(cents.max(1)));
    u64::try_from(t)
        .unwrap_or(u64::MAX)
        .clamp(MIN_MAX_FEE, MAX_MAX_FEE)
}

fn memo_text(v: &Value) -> Option<String> {
    use base64::Engine;
    let b = base64::engine::general_purpose::STANDARD
        .decode(v.as_str()?)
        .ok()?;
    let s = String::from_utf8_lossy(&b);
    (!s.is_empty()).then(|| crate::dialog_text::sanitize(&s, 100))
}

/// Last 50 transactions of `0.0.num`, normalized:
/// `[{ id, name, result, time, fee, memo, delta, amount, counterparty, outgoing }]` (amounts as
/// decimal strings of tinybars) — `delta` is the
/// signed change of our balance (tinybars, fees included), `amount` the HBAR moved to / from the
/// counterparty (fees excluded for outgoing transfers).
pub async fn txs(ctx: &HbarCtx<'_>, num: u64) -> AppResult<Value> {
    let v = match mirror(
        ctx,
        &format!("/api/v1/transactions?account.id=0.0.{num}&limit={MAX_TXS}&order=desc"),
    )
    .await?
    {
        Some(v) => v,
        None => return Ok(json!([])),
    };
    let me = format!("0.0.{num}");
    let mut out = Vec::new();
    for t in v["transactions"].as_array().into_iter().flatten() {
        out.push(normalize_tx(t, &me));
    }
    Ok(Value::Array(out))
}

fn normalize_tx(t: &Value, me: &str) -> Value {
    let transfers: Vec<(String, i64)> = t["transfers"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|x| Some((x["account"].as_str()?.to_owned(), x["amount"].as_i64()?)))
        .collect();
    let delta: i64 = transfers
        .iter()
        .filter(|(a, _)| a == me)
        .map(|(_, n)| *n)
        .sum();
    let fee = t["charged_tx_fee"].as_i64().unwrap_or(0);
    let payer = t["transaction_id"]
        .as_str()
        .and_then(|s| s.split('-').next())
        .unwrap_or_default();
    let node = t["node"].as_str().unwrap_or_default();
    // System accounts that receive fees and rewards: never "the" counterparty if a real one exists.
    let system = |a: &str| a == node || num_of(&json!(a)).is_some_and(|n| n <= 1000);
    let others = transfers.iter().filter(|(a, _)| a != me);
    let pick = |positive: bool| {
        let cands: Vec<&(String, i64)> = others
            .clone()
            .filter(|(_, n)| if positive { *n > 0 } else { *n < 0 })
            .collect();
        let best = |v: &[&(String, i64)]| {
            v.iter()
                .max_by_key(|(_, n)| n.unsigned_abs())
                .map(|(a, _)| a.clone())
        };
        let real: Vec<&(String, i64)> = cands.iter().copied().filter(|(a, _)| !system(a)).collect();
        best(&real).or_else(|| best(&cands))
    };
    let (amount, counterparty) = if delta < 0 {
        let paid_fee = if payer == me { fee } else { 0 };
        ((-delta - paid_fee).max(0), pick(true))
    } else {
        (delta, pick(false))
    };
    let time = t["consensus_timestamp"]
        .as_str()
        .and_then(|s| s.split('.').next())
        .and_then(|s| s.parse::<i64>().ok())
        .map(|s| s * 1000);
    let mut tokens = Vec::new();
    for row in t["token_transfers"].as_array().into_iter().flatten() {
        let (Some(tid), Some(acc), Some(n)) = (
            row["token_id"].as_str(),
            row["account"].as_str(),
            row["amount"].as_i64(),
        ) else {
            continue;
        };
        if acc != me {
            continue;
        }
        match tokens
            .iter_mut()
            .find(|(id, _): &&mut (String, i64)| id == tid)
        {
            Some((_, d)) => *d += n,
            None => tokens.push((tid.to_owned(), n)),
        }
    }
    json!({
        "id": t["transaction_id"],
        "tokenTransfers": tokens.iter().map(|(id, d)| json!({ "tokenId": id, "delta": d.to_string() })).collect::<Vec<_>>(),
        "name": t["name"],
        "result": t["result"],
        "time": time,
        "fee": (if payer == me { fee } else { 0 }).to_string(),
        "memo": memo_text(&t["memo_base64"]),
        "delta": delta.to_string(),
        "amount": amount.to_string(),
        "counterparty": counterparty,
        "outgoing": delta < 0,
    })
}

/// `(found, result)` of a transaction by its mirror ID (`0.0.x-secs-nanos`): `result` is
/// `SUCCESS` once it reached consensus successfully.
pub async fn tx_status(ctx: &HbarCtx<'_>, mirror_id: &str) -> AppResult<(bool, String)> {
    match mirror(ctx, &format!("/api/v1/transactions/{mirror_id}")).await? {
        None => Ok((false, String::new())),
        Some(v) => {
            let list = v["transactions"].as_array().cloned().unwrap_or_default();
            let main = list
                .iter()
                .find(|t| t["nonce"].as_u64().unwrap_or(0) == 0 && t["scheduled"] != true)
                .or(list.first());
            Ok(match main {
                Some(t) => (true, t["result"].as_str().unwrap_or("").to_owned()),
                None => (false, String::new()),
            })
        }
    }
}

/// Result of one gRPC-web call: the node's precheck code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Precheck {
    pub code: u32,
}

/// Parses a gRPC-web response body: one data frame (flag 0) with the `TransactionResponse`, and a
/// trailer frame (flag 0x80) with `grpc-status`.
pub fn parse_grpc_web(body: &[u8]) -> AppResult<Precheck> {
    let mut b = body;
    let mut data = None;
    let mut status: Option<(String, String)> = None;
    while !b.is_empty() {
        if b.len() < 5 {
            return Err(bad("gRPC-web: truncated frame"));
        }
        let flag = b[0];
        let len = u32::from_be_bytes([b[1], b[2], b[3], b[4]]) as usize;
        if b.len() < 5 + len {
            return Err(bad("gRPC-web: truncated frame"));
        }
        let payload = &b[5..5 + len];
        b = &b[5 + len..];
        if flag & 0x80 != 0 {
            let text = String::from_utf8_lossy(payload);
            let get = |k: &str| {
                text.split("\r\n")
                    .find_map(|l| l.strip_prefix(k))
                    .map(|v| v.trim().to_owned())
            };
            status = Some((
                get("grpc-status:").unwrap_or_default(),
                get("grpc-message:").unwrap_or_default(),
            ));
        } else if flag == 0 {
            data = Some(payload.to_vec());
        } else {
            return Err(bad("gRPC-web: unexpected compressed frame"));
        }
    }
    if let Some((code, msg)) = &status {
        if code != "0" {
            return Err(bad(format!(
                "Hedera node: gRPC error {code} ({})",
                crate::dialog_text::sanitize(msg, 120)
            )));
        }
    }
    let data = data.ok_or_else(|| bad("Hedera node: empty response"))?;
    let (code, _) = wallet_core::hbar_decode_precheck(&data)?;
    Ok(Precheck { code })
}

/// Submits one signed `Transaction` to the gRPC-web proxy of node `node`.
pub async fn submit_to_node(ctx: &HbarCtx<'_>, node: u64, tx: &[u8]) -> AppResult<Precheck> {
    let host = nodes(ctx.network)
        .iter()
        .find(|(n, _)| *n == node)
        .map(|(_, h)| *h)
        .ok_or_else(|| AppError::InvalidInput(format!("node 0.0.{node} unknown to Kyro")))?;
    let u = url::Url::parse(&format!(
        "https://{host}/proto.CryptoService/cryptoTransfer"
    ))
    .map_err(|_| AppError::Internal("invalid node URL".into()))?;
    let mut framed = Vec::with_capacity(tx.len() + 5);
    framed.push(0);
    framed.extend_from_slice(&u32::try_from(tx.len()).unwrap_or(u32::MAX).to_be_bytes());
    framed.extend_from_slice(tx);
    let mut req =
        ServerRequest::post_bytes(u, Family::Hedera, "application/grpc-web+proto", framed);
    req.headers.push(("x-grpc-web".into(), "1".into()));
    let (status, body) = ctx.net_client.server_request(req, ctx.tor).await?;
    if status != 200 {
        return Err(bad(format!("Hedera node {host}: HTTP {status}")));
    }
    parse_grpc_web(&body)
}

/// Codes after which another node may be tried with its own copy (same transaction ID).
pub fn retryable(code: u32) -> bool {
    matches!(code, 12 | 67 | 69 | 366) // BUSY, PLATFORM_NOT_ACTIVE, PLATFORM_TRANSACTION_NOT_CREATED, THROTTLED_AT_CONSENSUS
}

/// Network check: the mirror node of this network answers and has a node list (live test).
#[cfg(test)]
pub async fn probe(ctx: &HbarCtx<'_>) -> AppResult<u64> {
    let v = mirror(ctx, "/api/v1/network/nodes?limit=1")
        .await?
        .ok_or_else(|| bad("Hedera mirror node: node list missing"))?;
    v["nodes"][0]["node_account_id"]
        .as_str()
        .and_then(|s| s.strip_prefix("0.0."))
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| bad("Hedera mirror node: unexpected response"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fee_from_exchange_rate() {
        let r = (215_465, 30_000);
        assert_eq!(max_fee(r, false), 6_961_687); // 0.5 ¢ ≈ 0.0696 HBAR
        assert_eq!(max_fee(r, true), 139_233_750); // 10 ¢ ≈ 1.39 HBAR
        assert_eq!(max_fee((1_000_000_000, 1), false), MIN_MAX_FEE);
        assert_eq!(max_fee((1, 1_000_000), true), MAX_MAX_FEE);
    }

    #[test]
    fn grpc_web_frames() {
        let mut ok = vec![0, 0, 0, 0, 2, 0x08, 0x07];
        ok.extend_from_slice(&[0x80, 0, 0, 0, 0x0f]);
        ok.extend_from_slice(b"grpc-status:0\r\n");
        assert_eq!(parse_grpc_web(&ok).unwrap(), Precheck { code: 7 });
        let mut zero = vec![0, 0, 0, 0, 0];
        zero.extend_from_slice(&[0x80, 0, 0, 0, 0x0f]);
        zero.extend_from_slice(b"grpc-status:0\r\n");
        assert_eq!(parse_grpc_web(&zero).unwrap(), Precheck { code: 0 });
        let mut err = vec![0x80, 0, 0, 0, 0x22];
        err.extend_from_slice(b"grpc-status:14\r\ngrpc-message:down\r\n");
        assert!(parse_grpc_web(&err).is_err());
        assert!(parse_grpc_web(&[]).is_err());
        assert!(parse_grpc_web(&[0, 0, 0, 0, 9, 1]).is_err());
    }

    #[test]
    fn history_entries() {
        let out = json!({
            "transaction_id": "0.0.5005-1793508161-304559252",
            "name": "CRYPTOTRANSFER", "result": "SUCCESS", "node": "0.0.33",
            "consensus_timestamp": "1793508169.857440104", "charged_tx_fee": 90_000,
            "memo_base64": "ZmFjdHVyZSA0Mg==",
            "transfers": [
                { "account": "0.0.33", "amount": 4_000 },
                { "account": "0.0.98", "amount": 86_000 },
                { "account": "0.0.5005", "amount": -150_090_000 },
                { "account": "0.0.7007", "amount": 150_000_000 }
            ]
        });
        let n = normalize_tx(&out, "0.0.5005");
        assert_eq!(n["amount"], "150000000");
        assert_eq!(n["delta"], "-150090000");
        assert_eq!(n["counterparty"], "0.0.7007");
        assert_eq!(n["fee"], "90000");
        assert_eq!(n["memo"], "facture 42");
        assert_eq!(n["time"], 1_793_508_169_000i64);
        let n = normalize_tx(&out, "0.0.7007");
        assert_eq!(n["amount"], "150000000");
        assert_eq!(n["counterparty"], "0.0.5005");
        assert_eq!(n["fee"], "0");
        assert_eq!(n["outgoing"], false);
    }
}

/// Real-network checks over Tor. Run with `cargo test -p kyro-desktop -- --ignored --nocapture
/// hbar_live`. mirror node of mainnet and testnet: exchange rate, node list, account lookups; each
/// gRPC-web proxy of Kyro: a **correctly signed transfer from an account that is not ours**
/// (`0.0.98`'s key is not our key) is sent; the node must parse it and refuse it at precheck with
/// `INVALID_SIGNATURE` (or `INVALID_PAYER_SIGNATURE`) — precheck failures are not charged and
/// nothing is executed.
#[cfg(test)]
mod live {
    use super::*;
    use crate::tor::TorState;

    #[test]
    #[ignore]
    fn hbar_live_over_tor() {
        let net = NetClient::new(std::env::temp_dir().join("kyro-hbar-live")).unwrap();
        let seed = wallet_core::Mnemonic::parse(
            "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
        )
        .unwrap()
        .to_seed("");
        let pk = wallet_core::hbar_public_key(&seed, 0).unwrap();
        let evm = wallet_core::hbar_evm_address(&seed, 0).unwrap();
        let tor = std::env::var("KYRO_HBAR_CLEAR").as_deref() != Ok("yes");
        tauri::async_runtime::block_on(async {
            if tor {
                net.tor.restart();
                while net.tor.status().state != TorState::Ready {
                    assert_ne!(net.tor.status().state, TorState::Error);
                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                }
            }
            for network in [Network::Testnet, Network::Mainnet] {
                let c = HbarCtx {
                    net_client: &net,
                    network,
                    tor,
                };
                let t = std::time::Instant::now();
                eprintln!(
                    "{network:?} probe: first node 0.0.{:?} in {:.1?}",
                    probe(&c).await,
                    t.elapsed()
                );
                let rate = exchange_rate(&c).await.unwrap();
                eprintln!(
                    "rate {rate:?} → max fee {} / {} tinybars",
                    max_fee(rate, false),
                    max_fee(rate, true)
                );
                eprintln!(
                    "our account ({evm}): {:?}",
                    our_account(&c, &evm, &pk).await.unwrap()
                );
                eprintln!("0.0.98: {:?}", account(&c, "0.0.98").await.unwrap());
                let h = txs(&c, 98).await.unwrap();
                eprintln!(
                    "history 0.0.98: {} entries, first {}",
                    h.as_array().unwrap().len(),
                    h[0]
                );
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_secs() as i64;
                for (node, host) in nodes(network) {
                    let t = wallet_core::HbarTransfer {
                        payer: 98,
                        valid_start_secs: now - START_SKEW,
                        valid_start_nanos: 0,
                        node: *node,
                        max_fee: MIN_MAX_FEE,
                        valid_duration: VALID_DURATION,
                        memo: "kyro precheck test".into(),
                        to: wallet_core::HbarRecipient::Id(800),
                        amount: 1,
                        kind: wallet_core::HbarKind::Hbar,
                    };
                    let body = hex::encode(t.encode());
                    let (signed, _) =
                        wallet_core::hbar_sign(&seed, 0, 98, &[body], &node_ids(network)).unwrap();
                    let raw = hex::decode(&signed[0]).unwrap();
                    let r = submit_to_node(&c, *node, &raw).await;
                    let name = r.as_ref().map(|p| wallet_core::hbar_response_name(p.code));
                    eprintln!("{network:?} {host} (0.0.{node}): {name:?}");
                    let code = r.unwrap().code;
                    assert!(
                        matches!(code, 7 | 43),
                        "precheck {}",
                        wallet_core::hbar_response_name(code)
                    );
                }
            }
        });
    }
}
