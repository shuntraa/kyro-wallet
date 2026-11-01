//! Aptos data from the Aptos Labs fullnode REST API (`api.mainnet.aptoslabs.com/v1`,
//! `api.testnet.aptoslabs.com/v1`, keyless public tier) and its indexer (`/v1/graphql`, same
//! host), on the `aptos` Tor family, never with a fallback.
//!
//! Kyro fills the sequence number, gas price, maximum gas and expiration itself (`/accounts`,
//! `/estimate_gas_price`, `/transactions/simulate`, ledger time) and encodes the transfer with
//! wallet-core: a server-built transaction is never signed.

use serde::Serialize;
use serde_json::{json, Value};
use wallet_core::Network;

use crate::error::{AppError, AppResult};
use crate::net::{Family, NetClient, ServerRequest};

/// Expiration = ledger time + this (10 min: time to read the dialog and type the password).
pub const EXPIRATION_SECS: u64 = 600;
/// A transaction expiring within this is refused at signing (rebuild it).
pub const MIN_REMAINING_SECS: u64 = 30;
/// `max_gas_amount` = simulated gas × 3 / 2, at least this (a transfer uses ≈ 10–60 units,
/// creating the recipient's account a few thousand).
pub const MIN_MAX_GAS: u64 = 200;
/// Never above this many gas units for a transfer.
pub const MAX_MAX_GAS: u64 = 20_000;
/// Gas unit prices above this (octas) are refused: the network's minimum is 100.
pub const MAX_GAS_UNIT_PRICE: u64 = 10_000;
const MAX_TXS: u32 = 50;
const APT_COIN: &str = "0x1::aptos_coin::AptosCoin";
const APT_FA: &str = "0x000000000000000000000000000000000000000000000000000000000000000a";
const BCS_SIGNED: &str = "application/x.aptos.signed_transaction+bcs";

pub fn default_url(network: Network) -> &'static str {
    match network {
        Network::Mainnet => "https://api.mainnet.aptoslabs.com/v1",
        Network::Testnet => "https://api.testnet.aptoslabs.com/v1",
    }
}

pub fn chain_id_of(network: Network) -> u8 {
    match network {
        Network::Mainnet => wallet_core::APTOS_MAINNET_CHAIN_ID,
        Network::Testnet => wallet_core::APTOS_TESTNET_CHAIN_ID,
    }
}

pub struct AptosCtx<'a> {
    pub net_client: &'a NetClient,
    pub tor: bool,
    /// REST base (`…/v1`). The app always uses [`default_url`]; the live test uses devnet.
    pub base: String,
    /// Expected chain id (1 mainnet, 2 testnet; devnet's changes at each reset).
    pub chain_id: u8,
}

fn bad(msg: impl Into<String>) -> AppError {
    AppError::ServerUnreachable(msg.into())
}

async fn send(ctx: &AptosCtx<'_>, req: ServerRequest, what: &str) -> AppResult<(u16, Value)> {
    let (status, bytes) = ctx.net_client.server_request(req, ctx.tor).await?;
    if status == 429 {
        return Err(bad(format!(
            "Aptos Labs rate-limits requests without a key{}: try again in a few minutes",
            if ctx.tor {
                " (the Tor exit relay's IP is shared with other users)"
            } else {
                ""
            }
        )));
    }
    let v: Value = serde_json::from_slice(&bytes).map_err(|_| {
        bad(format!(
            "Aptos: unreadable response on {what} (HTTP {status})"
        ))
    })?;
    Ok((status, v))
}

fn url(ctx: &AptosCtx<'_>, path: &str) -> AppResult<url::Url> {
    url::Url::parse(&format!("{}{path}", ctx.base))
        .map_err(|_| AppError::Internal("invalid Aptos URL".into()))
}

async fn get(ctx: &AptosCtx<'_>, path: &str) -> AppResult<(u16, Value)> {
    send(
        ctx,
        ServerRequest::get(url(ctx, path)?, Family::Aptos),
        path,
    )
    .await
}

fn api_error(what: &str, status: u16, v: &Value) -> AppError {
    bad(format!(
        "Aptos: HTTP {status} on {what} ({})",
        v["message"]
            .as_str()
            .or(v["error_code"].as_str())
            .unwrap_or("")
            .chars()
            .take(200)
            .collect::<String>()
    ))
}

fn u64_at(v: &Value) -> Option<u64> {
    match v {
        Value::String(s) => s.parse().ok(),
        Value::Number(n) => n.as_u64(),
        _ => None,
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AptosLedger {
    pub chain_id: u8,
    /// UNIX seconds of the last ledger.
    pub timestamp_secs: u64,
    pub block_height: u64,
}

pub async fn ledger(ctx: &AptosCtx<'_>) -> AppResult<AptosLedger> {
    let (status, v) = get(ctx, "").await?;
    if status != 200 {
        return Err(api_error("/v1", status, &v));
    }
    let chain_id = v["chain_id"]
        .as_u64()
        .and_then(|c| u8::try_from(c).ok())
        .ok_or_else(|| bad("Aptos: chain_id missing"))?;
    let ts =
        u64_at(&v["ledger_timestamp"]).ok_or_else(|| bad("Aptos: ledger_timestamp missing"))?;
    Ok(AptosLedger {
        chain_id,
        timestamp_secs: ts / 1_000_000,
        block_height: u64_at(&v["block_height"]).unwrap_or(0),
    })
}

/// The ledger, refused if it is not on the expected chain.
pub async fn checked_ledger(ctx: &AptosCtx<'_>) -> AppResult<AptosLedger> {
    let l = ledger(ctx).await?;
    if l.chain_id != ctx.chain_id {
        return Err(AppError::ServerWrongNetwork(format!(
            "this Aptos server is on chain {}, not on {} ({})",
            l.chain_id,
            ctx.chain_id,
            if ctx.chain_id == 1 {
                "mainnet"
            } else {
                "testnet"
            }
        )));
    }
    Ok(l)
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AptosAccountInfo {
    pub address: String,
    /// Octas (coin store + primary fungible store), decimal string.
    pub balance: String,
    pub sequence_number: String,
    /// `0x…`: equal to the address unless the key was rotated.
    pub authentication_key: String,
    /// The authentication key is still the one the address was derived from.
    pub key_matches: bool,
}

pub async fn account(ctx: &AptosCtx<'_>, address: &str) -> AppResult<AptosAccountInfo> {
    let a = wallet_core::aptos_address_string(&wallet_core::aptos_parse_address(address)?);
    let (status, v) = get(ctx, &format!("/accounts/{a}")).await?;
    let (seq, auth) = match status {
        200 => (
            u64_at(&v["sequence_number"]).ok_or_else(|| bad("Aptos: sequence_number missing"))?,
            v["authentication_key"]
                .as_str()
                .ok_or_else(|| bad("Aptos: authentication_key missing"))?
                .to_ascii_lowercase(),
        ),
        404 if v["error_code"] == "account_not_found" => (0, a.clone()),
        _ => return Err(api_error("/accounts", status, &v)),
    };
    let (status, b) = get(ctx, &format!("/accounts/{a}/balance/{APT_COIN}")).await?;
    let balance = match status {
        200 => u64_at(&b).ok_or_else(|| bad("Aptos: balance unreadable"))?,
        404 => 0,
        _ => return Err(api_error("/balance", status, &b)),
    };
    Ok(AptosAccountInfo {
        key_matches: auth == a,
        address: a,
        balance: balance.to_string(),
        sequence_number: seq.to_string(),
        authentication_key: auth,
    })
}

/// Balance of the fungible asset `metadata` (`0x` + 64 hex) in `address`'s primary store, in
/// token units (`/accounts/{a}/balance/{metadata}`, 0 when the store does not exist).
pub async fn fa_balance(ctx: &AptosCtx<'_>, address: &str, metadata: &str) -> AppResult<u64> {
    let a = wallet_core::aptos_address_string(&wallet_core::aptos_parse_address(address)?);
    let m = wallet_core::aptos_address_string(&wallet_core::aptos_parse_address(metadata)?);
    let (status, b) = get(ctx, &format!("/accounts/{a}/balance/{m}")).await?;
    match status {
        200 => u64_at(&b).ok_or_else(|| bad("Aptos: token balance unreadable")),
        404 => Ok(0),
        _ => Err(api_error("/balance", status, &b)),
    }
}

/// Movements of the known fungible assets for `address` (indexer `fungible_asset_activities`, asset
/// types = the known metadata objects only), merged per transaction and asset: `[{ version, hash,
/// time, metadata, direction, amount, counterparty, success }]`.
pub async fn token_txs(ctx: &AptosCtx<'_>, address: &str) -> AppResult<Value> {
    let a = wallet_core::aptos_address_string(&wallet_core::aptos_parse_address(address)?);
    let known: Vec<&str> = wallet_core::aptos_known_assets(ctx.chain_id)
        .iter()
        .map(|k| k.metadata)
        .collect();
    if known.is_empty() {
        return Ok(json!([]));
    }
    let query = "query($a:String!,$t:[String!]!,$n:Int!){fungible_asset_activities(where:{owner_address:{_eq:$a},asset_type:{_in:$t},is_gas_fee:{_eq:false}},limit:$n,order_by:{transaction_version:desc}){transaction_version transaction_timestamp type amount asset_type is_transaction_success}}";
    let body = json!({ "query": query, "variables": { "a": a, "t": known, "n": MAX_TXS * 2 } })
        .to_string();
    let req = ServerRequest::post_json(url(ctx, "/graphql")?, Family::Aptos, body);
    let (status, v) = send(ctx, req, "/graphql").await?;
    if status != 200 || v["errors"].is_array() {
        return Err(bad(format!(
            "Aptos: indexer unavailable (HTTP {status}) {}",
            v["errors"][0]["message"].as_str().unwrap_or("")
        )));
    }
    let (status, sent) = get(ctx, &format!("/accounts/{a}/transactions?limit=50")).await?;
    let sent = if status == 200 { sent } else { json!([]) };
    let mut by_version: std::collections::BTreeMap<u64, Value> = Default::default();
    for t in sent.as_array().into_iter().flatten() {
        if let Some(ver) = u64_at(&t["version"]) {
            by_version.insert(ver, t.clone());
        }
    }
    type Movement = (Option<String>, u128, u128, bool);
    let mut agg: std::collections::BTreeMap<(u64, String), Movement> = Default::default();
    for e in v["data"]["fungible_asset_activities"]
        .as_array()
        .into_iter()
        .flatten()
    {
        let (Some(ver), Some(m)) = (u64_at(&e["transaction_version"]), e["asset_type"].as_str())
        else {
            continue;
        };
        if !known.contains(&m) {
            continue;
        }
        let amt = u128::from(u64_at(&e["amount"]).unwrap_or(0));
        let g = agg.entry((ver, m.to_owned())).or_insert((
            e["transaction_timestamp"].as_str().map(str::to_owned),
            0,
            0,
            e["is_transaction_success"] == true,
        ));
        let ty = e["type"].as_str().unwrap_or("");
        if ty.ends_with("::Deposit") || ty.ends_with("::DepositEvent") {
            g.1 += amt;
        } else if ty.ends_with("::Withdraw") || ty.ends_with("::WithdrawEvent") {
            g.2 += amt;
        }
    }
    let mut out = Vec::new();
    for ((ver, m), (time, dep, wd, success)) in agg.into_iter().rev().take(MAX_TXS as usize) {
        let (direction, amount) = if wd > dep {
            ("out", wd - dep)
        } else if dep > wd {
            ("in", dep - wd)
        } else {
            ("self", 0)
        };
        let s = by_version.get(&ver);
        let counterparty = s
            .filter(|t| {
                t["payload"]["function"] == wallet_core::APTOS_FA_TRANSFER_FUNCTION
                    && t["payload"]["arguments"][0]["inner"].as_str() == Some(m.as_str())
            })
            .and_then(|t| t["payload"]["arguments"][1].as_str().map(str::to_owned));
        let time = s
            .and_then(|t| u64_at(&t["timestamp"]).map(|us| us / 1000))
            .or_else(|| time.as_deref().and_then(parse_utc_ms));
        out.push(json!({
            "version": ver.to_string(),
            "hash": s.and_then(|t| t["hash"].as_str()),
            "time": time,
            "metadata": m,
            "direction": direction,
            "amount": amount.to_string(),
            "counterparty": counterparty,
            "success": success,
        }));
    }
    Ok(Value::Array(out))
}

/// `gas_estimate` of `/estimate_gas_price` (octas per gas unit).
pub async fn gas_price(ctx: &AptosCtx<'_>) -> AppResult<u64> {
    let (status, v) = get(ctx, "/estimate_gas_price").await?;
    if status != 200 {
        return Err(api_error("/estimate_gas_price", status, &v));
    }
    let p = u64_at(&v["gas_estimate"]).ok_or_else(|| bad("Aptos: gas_estimate missing"))?;
    if p == 0 || p > MAX_GAS_UNIT_PRICE {
        return Err(bad(format!(
            "Aptos: gas price from the server out of bounds ({p} octas per unit)"
        )));
    }
    Ok(p)
}

/// Result of `/transactions/simulate` (the zero signature is never valid, so nothing can be
/// executed): `(success, vm_status, gas_used)`.
pub async fn simulate(ctx: &AptosCtx<'_>, body: Vec<u8>) -> AppResult<(bool, String, u64)> {
    let req = ServerRequest::post_bytes(
        url(ctx, "/transactions/simulate")?,
        Family::Aptos,
        BCS_SIGNED,
        body,
    );
    let (status, v) = send(ctx, req, "/transactions/simulate").await?;
    if status != 200 {
        return Err(api_error("/transactions/simulate", status, &v));
    }
    let r = &v[0];
    Ok((
        r["success"] == true,
        r["vm_status"]
            .as_str()
            .unwrap_or("")
            .chars()
            .take(200)
            .collect(),
        u64_at(&r["gas_used"]).ok_or_else(|| bad("Aptos: gas_used missing from the simulation"))?,
    ))
}

/// Submits signed BCS bytes. The node's hash must be ours.
pub async fn submit(ctx: &AptosCtx<'_>, signed: Vec<u8>, hash: &str) -> AppResult<String> {
    let req = ServerRequest::post_bytes(
        url(ctx, "/transactions")?,
        Family::Aptos,
        BCS_SIGNED,
        signed,
    );
    let (status, v) = send(ctx, req, "/transactions").await?;
    if status != 202 && status != 200 {
        return Err(AppError::InvalidInput(format!(
            "Aptos transaction rejected by the node (HTTP {status}): {}",
            v["message"]
                .as_str()
                .unwrap_or("")
                .chars()
                .take(300)
                .collect::<String>()
        )));
    }
    let got = v["hash"].as_str().unwrap_or("");
    if !got.eq_ignore_ascii_case(hash) {
        return Err(bad(format!(
            "the node returned an unexpected hash ({})",
            got.chars().take(80).collect::<String>()
        )));
    }
    Ok(hash.to_ascii_lowercase())
}

/// `/transactions/by_hash`: `(committed, success, vm_status)`; not found / pending =
/// `(false, false, "")`.
pub async fn tx_status(ctx: &AptosCtx<'_>, hash: &str) -> AppResult<(bool, bool, String)> {
    let (status, v) = get(ctx, &format!("/transactions/by_hash/{hash}")).await?;
    match status {
        200 if v["type"] == "pending_transaction" => Ok((false, false, String::new())),
        200 => Ok((
            true,
            v["success"] == true,
            v["vm_status"]
                .as_str()
                .unwrap_or("")
                .chars()
                .take(200)
                .collect(),
        )),
        404 => Ok((false, false, String::new())),
        _ => Err(api_error("/transactions/by_hash", status, &v)),
    }
}

/// Last APT movements of `address` from the indexer (`fungible_asset_activities`, coin and
/// fungible-asset forms), merged per transaction, and the recipients of our own transfers from
/// `/accounts/{a}/transactions`.
pub async fn txs(ctx: &AptosCtx<'_>, address: &str) -> AppResult<Value> {
    let a = wallet_core::aptos_address_string(&wallet_core::aptos_parse_address(address)?);
    let query = "query($a:String!,$t:[String!]!,$n:Int!){fungible_asset_activities(where:{owner_address:{_eq:$a},asset_type:{_in:$t}},limit:$n,order_by:{transaction_version:desc}){transaction_version transaction_timestamp type amount is_gas_fee is_transaction_success entry_function_id_str}}";
    let body = json!({ "query": query, "variables": { "a": a, "t": [APT_COIN, APT_FA], "n": MAX_TXS * 3 } }).to_string();
    let req = ServerRequest::post_json(url(ctx, "/graphql")?, Family::Aptos, body);
    let (status, v) = send(ctx, req, "/graphql").await?;
    if status != 200 || v["errors"].is_array() {
        return Err(bad(format!(
            "Aptos: indexer unavailable (HTTP {status}) {}",
            v["errors"][0]["message"].as_str().unwrap_or("")
        )));
    }
    let (status, sent) = get(ctx, &format!("/accounts/{a}/transactions?limit=50")).await?;
    let sent = if status == 200 { sent } else { json!([]) };
    let mut by_version: std::collections::BTreeMap<u64, Value> = Default::default();
    for t in sent.as_array().into_iter().flatten() {
        if let Some(ver) = u64_at(&t["version"]) {
            by_version.insert(ver, t.clone());
        }
    }
    struct Agg {
        time: Option<String>,
        deposit: u128,
        withdraw: u128,
        fee: u128,
        success: bool,
        function: Option<String>,
    }
    let mut agg: std::collections::BTreeMap<u64, Agg> = Default::default();
    for e in v["data"]["fungible_asset_activities"]
        .as_array()
        .into_iter()
        .flatten()
    {
        let Some(ver) = u64_at(&e["transaction_version"]) else {
            continue;
        };
        let amt = u128::from(u64_at(&e["amount"]).unwrap_or(0));
        let g = agg.entry(ver).or_insert(Agg {
            time: e["transaction_timestamp"].as_str().map(str::to_owned),
            deposit: 0,
            withdraw: 0,
            fee: 0,
            success: e["is_transaction_success"] == true,
            function: e["entry_function_id_str"].as_str().map(str::to_owned),
        });
        let ty = e["type"].as_str().unwrap_or("");
        if e["is_gas_fee"] == true {
            g.fee += amt;
        } else if ty.ends_with("::Deposit") || ty.ends_with("::DepositEvent") {
            g.deposit += amt;
        } else if ty.ends_with("::Withdraw") || ty.ends_with("::WithdrawEvent") {
            g.withdraw += amt;
        }
    }
    let mut out = Vec::new();
    for (ver, g) in agg.into_iter().rev().take(MAX_TXS as usize) {
        let (direction, amount) = if g.withdraw > g.deposit {
            ("out", g.withdraw - g.deposit)
        } else if g.deposit > g.withdraw {
            ("in", g.deposit - g.withdraw)
        } else {
            ("self", 0)
        };
        let s = by_version.get(&ver);
        let counterparty = s
            .filter(|t| t["payload"]["function"] == wallet_core::APTOS_TRANSFER_FUNCTION)
            .and_then(|t| t["payload"]["arguments"][0].as_str().map(str::to_owned));
        let time = s
            .and_then(|t| u64_at(&t["timestamp"]).map(|us| us / 1000))
            .or_else(|| g.time.as_deref().and_then(parse_utc_ms));
        out.push(json!({
            "version": ver.to_string(),
            "hash": s.and_then(|t| t["hash"].as_str()),
            "time": time,
            "direction": direction,
            "amount": amount.to_string(),
            "fee": g.fee.to_string(),
            "counterparty": counterparty,
            "success": g.success,
            "function": g.function,
            "sentByUs": s.is_some(),
        }));
    }
    Ok(Value::Array(out))
}

fn parse_utc_ms(s: &str) -> Option<u64> {
    let (date, time) = s.split_once('T')?;
    let mut d = date.split('-').map(|x| x.parse::<i64>().ok());
    let (y, m, day) = (d.next()??, d.next()??, d.next()??);
    let time = time.trim_end_matches('Z');
    let (hms, frac) = time.split_once('.').unwrap_or((time, ""));
    let mut t = hms.split(':').map(|x| x.parse::<i64>().ok());
    let (h, mi, sec) = (t.next()??, t.next()??, t.next()??);
    let y2 = if m <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let ms: i64 = format!("{frac:0<3}").get(..3)?.parse().ok()?;
    u64::try_from(((days * 86_400 + h * 3600 + mi * 60 + sec) * 1000) + ms).ok()
}

/// Network check: `/v1` chain id (live test; no custom Aptos server yet).
#[cfg(test)]
pub async fn probe(ctx: &AptosCtx<'_>) -> AppResult<crate::btc_backend::Detected> {
    let l = checked_ledger(ctx).await?;
    Ok(crate::btc_backend::Detected {
        network: Some(
            if l.chain_id == 1 {
                "mainnet"
            } else {
                "testnet"
            }
            .into(),
        ),
        chain_id: Some(u64::from(l.chain_id)),
        block_height: Some(l.block_height),
        ..Default::default()
    })
}

pub fn max_gas_for(gas_used: u64) -> AppResult<u64> {
    let g = gas_used.saturating_mul(3).div_ceil(2).max(MIN_MAX_GAS);
    if g > MAX_MAX_GAS {
        return Err(AppError::InvalidInput(format!(
            "Aptos transfer unusually expensive in the simulation ({gas_used} gas units): refused"
        )));
    }
    Ok(g)
}

pub fn check_transfer(ours: &AptosAccountInfo, amount: u64, max_fee: u64) -> AppResult<()> {
    if !ours.key_matches {
        return Err(AppError::InvalidInput(format!(
            "this Aptos account's key was changed (authentication key {}): Kyro can no longer sign for it",
            ours.authentication_key
        )));
    }
    let balance: u64 = ours.balance.parse().unwrap_or(0);
    let need = amount.saturating_add(max_fee);
    if need > balance {
        return Err(AppError::InvalidInput(format!(
            "insufficient balance: {} APT available, {} needed (amount + maximum fee, which the network requires up front)",
            crate::commands::format_units(&balance.to_string(), 8),
            crate::commands::format_units(&need.to_string(), 8)
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn max_gas_bounds() {
        assert_eq!(max_gas_for(10).unwrap(), MIN_MAX_GAS);
        assert_eq!(max_gas_for(1000).unwrap(), 1500);
        assert_eq!(max_gas_for(1001).unwrap(), 1502);
        assert!(max_gas_for(20_000).is_err());
    }

    #[test]
    fn utc_timestamps() {
        assert_eq!(parse_utc_ms("1970-01-01T00:00:00"), Some(0));
        assert_eq!(parse_utc_ms("2026-11-01T04:42:34"), Some(1_793_508_154_000));
        assert_eq!(
            parse_utc_ms("2026-11-01T04:42:34.5"),
            Some(1_793_508_154_500)
        );
        assert_eq!(parse_utc_ms("nope"), None);
    }

    #[test]
    fn transfer_checks() {
        let me = |balance: u64, key_matches: bool| AptosAccountInfo {
            balance: balance.to_string(),
            key_matches,
            ..Default::default()
        };
        assert!(check_transfer(&me(1_000_000, true), 900_000, 100_000).is_ok());
        assert!(
            matches!(check_transfer(&me(1_000_000, true), 900_001, 100_000), Err(AppError::InvalidInput(m)) if m.contains("insufficient"))
        );
        assert!(
            matches!(check_transfer(&me(10_000_000, false), 1, 1), Err(AppError::InvalidInput(m)) if m.contains("was changed"))
        );
    }
}
