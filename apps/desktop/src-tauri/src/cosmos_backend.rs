//! Cosmos Hub data from a public LCD (REST) endpoint — `cosmos-rest.publicnode.com` on mainnet,
//! the Hub testnet's official sentry `rest.provider-sentry-01.hub-testnet.polypore.xyz` — on the
//! `cosmos` Tor family, never with a fallback to another server or to clear net.
//!
//! Kyro builds the transaction itself: chain id and height (`blocks/latest`), `account_number`
//! and `sequence` (`auth/accounts`), gas from a simulation of the exact transaction, gas price
//! from the Hub's fee market (`feemarket/v1/gas_price/uatom`, with a margin), encoded by
//! wallet-core. A transaction built by the server is never signed.

use serde::Serialize;
use serde_json::{json, Value};
use wallet_core::Network;

use crate::error::{AppError, AppResult};
use crate::net::{Family, NetClient, ServerRequest};

/// `timeout_height` = latest height + this (≈ 10 min at ≈ 6 s per block).
pub const TIMEOUT_BLOCKS: u64 = 100;
/// Gas limit = simulated gas × 14 / 10 (cosmjs' "auto" multiplier).
const GAS_NUM: u64 = 14;
const GAS_DEN: u64 = 10;
/// A MsgSend simulates to ≈ 70 000–100 000 gas: more than this is refused.
pub const MAX_GAS: u64 = 500_000;
/// Gas price paid = fee-market price × 12 / 10 (the price can rise by 12.5 % per block).
const PRICE_NUM: u128 = 12;
const PRICE_DEN: u128 = 10;
/// Fee-market prices and gas prices are decimals with 18 digits (`sdk.Dec`).
const DEC: u128 = 1_000_000_000_000_000_000;
/// Hub `feemarket` `min_base_gas_price` (0.005 uatom/gas, read live on 2026-11-01 on mainnet
/// and testnet): used only if the endpoint does not answer 200.
const DEFAULT_GAS_PRICE: u128 = 5_000_000_000_000_000;
/// A gas price above 1 uatom/gas (200 × today's) from the server is refused.
const MAX_GAS_PRICE: u128 = DEC;
/// History: per query (sent, received), newest first.
const TXS_PER_QUERY: u32 = 25;

pub fn default_url(net: Network) -> &'static str {
    match net {
        Network::Mainnet => "https://cosmos-rest.publicnode.com",
        Network::Testnet => "https://rest.provider-sentry-01.hub-testnet.polypore.xyz",
    }
}

pub struct CosmosCtx<'a> {
    pub net_client: &'a NetClient,
    pub network: Network,
    pub tor: bool,
}

fn bad(msg: impl Into<String>) -> AppError {
    AppError::ServerUnreachable(msg.into())
}

fn snippet(bytes: &[u8]) -> String {
    crate::dialog_text::sanitize(&String::from_utf8_lossy(bytes), 200)
}

fn endpoint(ctx: &CosmosCtx<'_>, path: &str) -> AppResult<url::Url> {
    url::Url::parse(&format!("{}{path}", default_url(ctx.network)))
        .map_err(|_| AppError::Internal("invalid Cosmos URL".into()))
}

/// `(status, JSON)`; a body that is not JSON is an error whatever the status.
async fn call(ctx: &CosmosCtx<'_>, u: url::Url, body: Option<Value>) -> AppResult<(u16, Value)> {
    let path = u.path().to_owned();
    let req = match body {
        None => ServerRequest::get(u, Family::Cosmos),
        Some(b) => ServerRequest::post_json(u, Family::Cosmos, b.to_string()),
    };
    let (status, bytes) = ctx.net_client.server_request(req, ctx.tor).await?;
    let v = serde_json::from_slice(&bytes).map_err(|_| {
        bad(format!(
            "Cosmos: non-JSON response on {path} (HTTP {status}: {})",
            snippet(&bytes)
        ))
    })?;
    Ok((status, v))
}

async fn get_ok(ctx: &CosmosCtx<'_>, path: &str) -> AppResult<Value> {
    let (status, v) = call(ctx, endpoint(ctx, path)?, None).await?;
    if status != 200 {
        return Err(bad(format!(
            "Cosmos: HTTP {status} on {path} ({})",
            crate::dialog_text::sanitize(v["message"].as_str().unwrap_or(""), 200)
        )));
    }
    Ok(v)
}

fn u64_at(v: &Value) -> Option<u64> {
    match v {
        Value::String(s) => s.parse().ok(),
        Value::Number(n) => n.as_u64(),
        _ => None,
    }
}

fn u128_at(v: &Value) -> Option<u128> {
    match v {
        Value::String(s) if !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) => {
            s.parse().ok()
        }
        _ => None,
    }
}

/// `"0.005000000000000000"` → 5 × 10^15 (18 decimals), exactly.
pub fn parse_dec(s: &str) -> Option<u128> {
    let (int, frac) = s.split_once('.').unwrap_or((s, ""));
    if int.is_empty()
        || frac.len() > 18
        || !int.bytes().chain(frac.bytes()).all(|b| b.is_ascii_digit())
    {
        return None;
    }
    int.parse::<u128>()
        .ok()?
        .checked_mul(DEC)?
        .checked_add(format!("{frac:0<18}").parse().ok()?)
}

// ---------------------------------------------------------------- chain state

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CosmosChainInfo {
    pub chain_id: String,
    pub height: u64,
}

/// Chain id and height of the latest block, checked against the network.
pub async fn chain_info(ctx: &CosmosCtx<'_>) -> AppResult<CosmosChainInfo> {
    let v = get_ok(ctx, "/cosmos/base/tendermint/v1beta1/blocks/latest").await?;
    let h = &v["block"]["header"];
    let chain_id = h["chain_id"].as_str().unwrap_or("").to_owned();
    let want = wallet_core::cosmos_chain_id(ctx.network);
    if chain_id != want {
        return Err(AppError::ServerWrongNetwork(format!(
            "this Cosmos server is on \"{}\", not on \"{want}\"",
            crate::dialog_text::sanitize(&chain_id, 64)
        )));
    }
    Ok(CosmosChainInfo {
        chain_id,
        height: u64_at(&h["height"]).ok_or_else(|| bad("Cosmos: height missing"))?,
    })
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CosmosAccountInfo {
    pub address: String,
    /// Known to the auth module (received something at least once).
    pub exists: bool,
    pub account_number: u64,
    pub sequence: u64,
    /// Public key recorded on chain (base64), once the account has sent a transaction.
    pub pub_key: Option<String>,
    /// uatom, decimal string.
    pub balance: String,
    /// uatom that can be spent now (balance minus what is still vesting).
    pub spendable: String,
}

/// The `BaseAccount` inside what `auth/accounts` returns: itself, or the base account of a
/// vesting account. Module accounts and other types are refused (Kyro cannot sign for them).
fn base_account(a: &Value) -> AppResult<&Value> {
    let t = a["@type"].as_str().unwrap_or("");
    match t {
        "/cosmos.auth.v1beta1.BaseAccount" => Ok(a),
        "/cosmos.vesting.v1beta1.ContinuousVestingAccount"
        | "/cosmos.vesting.v1beta1.DelayedVestingAccount"
        | "/cosmos.vesting.v1beta1.PeriodicVestingAccount"
        | "/cosmos.vesting.v1beta1.PermanentLockedAccount" => {
            Ok(&a["base_vesting_account"]["base_account"])
        }
        other => Err(AppError::InvalidInput(format!(
            "unsupported Cosmos account type: {}",
            crate::dialog_text::sanitize(other, 80)
        ))),
    }
}

async fn uatom(ctx: &CosmosCtx<'_>, kind: &str, address: &str) -> AppResult<u128> {
    let v = get_ok(
        ctx,
        &format!("/cosmos/bank/v1beta1/{kind}/{address}/by_denom?denom=uatom"),
    )
    .await?;
    let b = &v["balance"];
    if b.is_null() {
        return Ok(0);
    }
    u128_at(&b["amount"]).ok_or_else(|| bad("Cosmos: unreadable balance"))
}

pub async fn account(ctx: &CosmosCtx<'_>, address: &str) -> AppResult<CosmosAccountInfo> {
    let a = wallet_core::cosmos_normalize_address(address)?;
    let (status, v) = call(
        ctx,
        endpoint(ctx, &format!("/cosmos/auth/v1beta1/accounts/{a}"))?,
        None,
    )
    .await?;
    let balance = uatom(ctx, "balances", &a).await?;
    let spendable = uatom(ctx, "spendable_balances", &a).await?.min(balance);
    // gRPC NotFound (5) through the gateway: never seen by the auth module yet.
    if status == 404 && v["code"] == 5 {
        return Ok(CosmosAccountInfo {
            address: a,
            balance: balance.to_string(),
            spendable: spendable.to_string(),
            ..Default::default()
        });
    }
    if status != 200 {
        return Err(bad(format!(
            "Cosmos: HTTP {status} on auth/accounts ({})",
            crate::dialog_text::sanitize(v["message"].as_str().unwrap_or(""), 200)
        )));
    }
    let b = base_account(&v["account"])?;
    if b["address"].as_str() != Some(a.as_str()) {
        return Err(bad("Cosmos: the server answered for another address"));
    }
    Ok(CosmosAccountInfo {
        exists: true,
        account_number: u64_at(&b["account_number"])
            .ok_or_else(|| bad("Cosmos: account_number missing"))?,
        sequence: u64_at(&b["sequence"]).unwrap_or(0),
        pub_key: b["pub_key"]["key"].as_str().map(str::to_owned),
        address: a,
        balance: balance.to_string(),
        spendable: spendable.to_string(),
    })
}

/// Gas price in uatom per gas, 18 decimals: the fee-market price, or the Hub minimum if the
/// endpoint is not there (a node without `x/feemarket`).
pub async fn gas_price(ctx: &CosmosCtx<'_>) -> AppResult<u128> {
    let (status, v) = call(ctx, endpoint(ctx, "/feemarket/v1/gas_price/uatom")?, None).await?;
    if status != 200 {
        return Ok(DEFAULT_GAS_PRICE);
    }
    let p = v["price"]["amount"]
        .as_str()
        .and_then(parse_dec)
        .filter(|_| v["price"]["denom"] == "uatom")
        .ok_or_else(|| bad("Cosmos: unreadable gas price"))?;
    if p == 0 || p > MAX_GAS_PRICE {
        return Err(bad("Cosmos: abnormal gas price announced by the server"));
    }
    Ok(p)
}

/// `(gas limit, fee uatom)` for `gas_used` at `price` (18 decimals), margins included.
pub fn fee_for(gas_used: u64, price: u128) -> AppResult<(u64, u128)> {
    if gas_used == 0 || gas_used > MAX_GAS {
        return Err(bad(format!(
            "Cosmos: simulation at {gas_used} gas, outside the bounds of a send (≤ {MAX_GAS})"
        )));
    }
    let gas_limit = gas_used.saturating_mul(GAS_NUM).div_ceil(GAS_DEN);
    let paid = price.saturating_mul(PRICE_NUM).div_ceil(PRICE_DEN);
    let fee = u128::from(gas_limit).saturating_mul(paid).div_ceil(DEC);
    Ok((gas_limit, fee.max(1)))
}

/// Gas used by the exact transaction (`TxRaw` with an empty signature).
pub async fn simulate(ctx: &CosmosCtx<'_>, tx: &[u8]) -> AppResult<u64> {
    use base64::Engine as _;
    let b = base64::engine::general_purpose::STANDARD.encode(tx);
    let (status, v) = call(
        ctx,
        endpoint(ctx, "/cosmos/tx/v1beta1/simulate")?,
        Some(json!({ "tx_bytes": b })),
    )
    .await?;
    if status != 200 {
        // Typically "insufficient funds" or "account sequence mismatch": the user's problem.
        return Err(AppError::InvalidInput(format!(
            "simulation rejected by the Cosmos network: {}",
            crate::dialog_text::sanitize(v["message"].as_str().unwrap_or(""), 300)
        )));
    }
    u64_at(&v["gas_info"]["gas_used"]).ok_or_else(|| bad("Cosmos: gas_used missing"))
}

/// Broadcasts a signed `TxRaw` (sync mode: CheckTx passed = in the mempool). The server's hash
/// must be ours.
pub async fn broadcast(ctx: &CosmosCtx<'_>, tx_b64: &str, hash: &str) -> AppResult<String> {
    let (status, v) = call(
        ctx,
        endpoint(ctx, "/cosmos/tx/v1beta1/txs")?,
        Some(json!({ "tx_bytes": tx_b64, "mode": "BROADCAST_MODE_SYNC" })),
    )
    .await?;
    let r = &v["tx_response"];
    if status != 200 || r.is_null() {
        return Err(bad(format!(
            "Cosmos: broadcast HTTP {status} ({})",
            crate::dialog_text::sanitize(v["message"].as_str().unwrap_or(""), 200)
        )));
    }
    let got = r["txhash"].as_str().unwrap_or("");
    if !got.eq_ignore_ascii_case(hash) {
        return Err(bad(format!(
            "the server answered an unexpected hash ({})",
            crate::dialog_text::sanitize(got, 80)
        )));
    }
    let code = r["code"].as_u64().unwrap_or(u64::MAX);
    // 19 = ErrTxInMempoolCache: this very transaction is already in the mempool.
    if code != 0 && !(code == 19 && r["codespace"] == "sdk") {
        return Err(AppError::InvalidInput(format!(
            "Cosmos transaction rejected (code {code}): {}",
            crate::dialog_text::sanitize(r["raw_log"].as_str().unwrap_or(""), 300)
        )));
    }
    Ok(hash.to_uppercase())
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CosmosTxStatus {
    /// In a block.
    pub included: bool,
    /// Included and executed successfully (`code` 0).
    pub success: bool,
    pub code: Option<u64>,
    pub height: Option<u64>,
    pub log: String,
}

pub async fn tx_status(ctx: &CosmosCtx<'_>, hash: &str) -> AppResult<CosmosTxStatus> {
    let (status, v) = call(
        ctx,
        endpoint(ctx, &format!("/cosmos/tx/v1beta1/txs/{hash}"))?,
        None,
    )
    .await?;
    if status == 404 || (status == 400 && v["code"] == 5) {
        return Ok(CosmosTxStatus {
            included: false,
            success: false,
            code: None,
            height: None,
            log: String::new(),
        });
    }
    if status != 200 {
        return Err(bad(format!("Cosmos: HTTP {status} on txs/{{hash}}")));
    }
    let r = &v["tx_response"];
    if !r["txhash"]
        .as_str()
        .is_some_and(|h| h.eq_ignore_ascii_case(hash))
    {
        return Err(bad("Cosmos: response for another transaction"));
    }
    let code = r["code"].as_u64();
    Ok(CosmosTxStatus {
        included: true,
        success: code == Some(0),
        code,
        height: u64_at(&r["height"]),
        log: if code == Some(0) {
            String::new()
        } else {
            crate::dialog_text::sanitize(r["raw_log"].as_str().unwrap_or(""), 300)
        },
    })
}

/// `{ hash, height, time, from, to, amount, fee, memo, success }` for every `MsgSend` of uatom
/// touching `address` in one search result (other messages are left out).
fn history_entries(v: &Value, address: &str, out: &mut Vec<Value>) {
    let txs = v["txs"].as_array().cloned().unwrap_or_default();
    let resps = v["tx_responses"].as_array().cloned().unwrap_or_default();
    for (tx, r) in txs.iter().zip(resps.iter()) {
        let fee = tx["auth_info"]["fee"]["amount"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|c| c["denom"] == "uatom")
            .and_then(|c| c["amount"].as_str())
            .unwrap_or("0");
        let memo = crate::dialog_text::sanitize(tx["body"]["memo"].as_str().unwrap_or(""), 120);
        let time = r["timestamp"]
            .as_str()
            .and_then(chrono_millis)
            .map(Value::from)
            .unwrap_or(Value::Null);
        for m in tx["body"]["messages"].as_array().into_iter().flatten() {
            if m["@type"] != wallet_core::COSMOS_MSG_SEND {
                continue;
            }
            let (from, to) = (
                m["from_address"].as_str().unwrap_or(""),
                m["to_address"].as_str().unwrap_or(""),
            );
            if from != address && to != address {
                continue;
            }
            let Some(amount) = m["amount"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|c| c["denom"] == "uatom")
                .and_then(|c| c["amount"].as_str())
            else {
                continue;
            };
            out.push(json!({
                "hash": r["txhash"], "height": u64_at(&r["height"]), "time": time,
                "from": from, "to": to, "amount": amount,
                "fee": if from == address { fee } else { "0" },
                "memo": memo, "success": r["code"].as_u64() == Some(0),
            }));
        }
    }
}

/// RFC 3339 UTC timestamp (`2026-11-01T04:42:26Z`, fractional seconds allowed) → UNIX ms.
fn chrono_millis(t: &str) -> Option<i64> {
    let b = t.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || !t.ends_with('Z') {
        return None;
    }
    let n = |r: core::ops::Range<usize>| t.get(r)?.parse::<i64>().ok();
    let (y, mo, d) = (n(0..4)?, n(5..7)?, n(8..10)?);
    let (h, mi, s) = (n(11..13)?, n(14..16)?, n(17..19)?);
    // Days from civil (Howard Hinnant's algorithm).
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 24 + h) * 60 + mi) * 60_000 + s * 1000)
}

/// Last sends and receipts of uatom (`MsgSend`), newest first, at most 50. The public node only
/// indexes recent blocks: older transactions are not listed.
pub async fn txs(ctx: &CosmosCtx<'_>, address: &str) -> AppResult<Value> {
    let a = wallet_core::cosmos_normalize_address(address)?;
    let mut out = Vec::new();
    for q in [
        format!("message.sender='{a}'"),
        format!("transfer.recipient='{a}'"),
    ] {
        let mut u = endpoint(ctx, "/cosmos/tx/v1beta1/txs")?;
        u.query_pairs_mut()
            .append_pair("query", &q)
            .append_pair("order_by", "ORDER_BY_DESC")
            .append_pair("limit", &TXS_PER_QUERY.to_string())
            .append_pair("page", "1");
        let (status, v) = call(ctx, u, None).await?;
        if status != 200 {
            return Err(bad(format!(
                "Cosmos: history HTTP {status} ({})",
                crate::dialog_text::sanitize(v["message"].as_str().unwrap_or(""), 200)
            )));
        }
        history_entries(&v, &a, &mut out);
    }
    let mut seen = std::collections::HashSet::new();
    out.retain(|e| seen.insert(format!("{}|{}|{}", e["hash"], e["to"], e["amount"])));
    out.sort_by_key(|e| std::cmp::Reverse(e["height"].as_u64()));
    out.truncate(50);
    Ok(Value::Array(out))
}

/// Network check of the default server (chain id, height). Live tests only: no custom Cosmos
/// server yet, so nothing in the app probes.
#[cfg(test)]
pub async fn probe(ctx: &CosmosCtx<'_>) -> AppResult<crate::btc_backend::Detected> {
    let i = chain_info(ctx).await?;
    Ok(crate::btc_backend::Detected {
        network: Some(crate::commands::network_name(ctx.network).into()),
        block_height: Some(i.height),
        ..Default::default()
    })
}

/// Checks before building / signing, against live data. Errors are user-facing.
pub fn check_send(ours: &CosmosAccountInfo, amount: u128, fee: u128) -> AppResult<()> {
    if !ours.exists {
        return Err(AppError::InvalidInput(
            "your Cosmos account is not known to the network yet (no ATOM received)".into(),
        ));
    }
    let spendable: u128 = ours.spendable.parse().unwrap_or(0);
    if amount.saturating_add(fee) > spendable {
        return Err(AppError::InvalidInput(format!(
            "insufficient available balance: {} ATOM available, {} needed (amount + fees)",
            crate::commands::format_units(&spendable.to_string(), 6),
            crate::commands::format_units(&amount.saturating_add(fee).to_string(), 6)
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decimals_and_fees() {
        assert_eq!(
            parse_dec("0.005000000000000000"),
            Some(5_000_000_000_000_000)
        );
        assert_eq!(parse_dec("1"), Some(DEC));
        assert_eq!(parse_dec("0.0000000000000000001"), None);
        assert_eq!(parse_dec("-1"), None);
        assert_eq!(parse_dec(".5"), None);
        // 90 000 gas simulated → 126 000 limit; 0.005 × 1.2 = 0.006 uatom/gas → 756 uatom.
        assert_eq!(fee_for(90_000, DEFAULT_GAS_PRICE).unwrap(), (126_000, 756));
        assert_eq!(fee_for(1, 1).unwrap(), (2, 1));
        assert!(fee_for(0, DEFAULT_GAS_PRICE).is_err());
        assert!(fee_for(MAX_GAS + 1, DEFAULT_GAS_PRICE).is_err());
    }

    #[test]
    fn timestamps() {
        assert_eq!(chrono_millis("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(
            chrono_millis("2026-11-01T04:42:26Z"),
            Some(1_793_508_146_000)
        );
        assert_eq!(
            chrono_millis("2026-11-01T04:42:26.623263121Z"),
            Some(1_793_508_146_000)
        );
        assert_eq!(
            chrono_millis("2024-02-29T00:00:00Z"),
            Some(1_709_164_800_000)
        );
        assert_eq!(chrono_millis("garbage"), None);
    }

    #[test]
    fn spend_checks() {
        let acc = |exists: bool, spendable: u128| CosmosAccountInfo {
            exists,
            spendable: spendable.to_string(),
            ..Default::default()
        };
        assert!(check_send(&acc(true, 1_000_000), 999_000, 1_000).is_ok());
        assert!(
            matches!(check_send(&acc(true, 1_000_000), 999_001, 1_000), Err(AppError::InvalidInput(m)) if m.contains("insufficient"))
        );
        assert!(check_send(&acc(false, 0), 1, 1).is_err());
    }

    #[test]
    fn history_keeps_only_uatom_sends_of_the_address() {
        let me = "cosmos19rl4cm2hmr8afy4kldpxz3fka4jguq0auqdal4";
        let other = "cosmos1jhg0e7s6gn44tfc5k37kr04sznyhedtc9rzys5";
        let v = json!({
            "txs": [
                { "body": { "memo": "a\nb", "messages": [
                    { "@type": "/cosmos.bank.v1beta1.MsgSend", "from_address": me, "to_address": other,
                      "amount": [{ "denom": "uatom", "amount": "1000" }] },
                    { "@type": "/cosmos.gov.v1beta1.MsgVote", "voter": me } ] },
                  "auth_info": { "fee": { "amount": [{ "denom": "uatom", "amount": "600" }] } } },
                { "body": { "memo": "", "messages": [
                    { "@type": "/cosmos.bank.v1beta1.MsgSend", "from_address": other, "to_address": me,
                      "amount": [{ "denom": "ibc/ABC", "amount": "5" }] } ] },
                  "auth_info": { "fee": { "amount": [] } } }
            ],
            "tx_responses": [
                { "txhash": "AA", "height": "12", "code": 0, "timestamp": "1970-01-01T00:00:01Z" },
                { "txhash": "BB", "height": "11", "code": 0, "timestamp": "1970-01-01T00:00:01Z" }
            ]
        });
        let mut out = Vec::new();
        history_entries(&v, me, &mut out);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["amount"], "1000");
        assert_eq!(out[0]["fee"], "600");
        assert_eq!(out[0]["memo"], "a b");
        assert_eq!(out[0]["time"], 1000);
        assert_eq!(out[0]["height"], 12);
    }
}
