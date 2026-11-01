//! Sui data from the public **GraphQL RPC** of the Sui Foundation (`graphql.testnet.sui.io` /
//! `graphql.mainnet.sui.io`, HTTPS POST of JSON), on the `sui` Tor family, never with a fallback.
//!
//! Why GraphQL: the JSON-RPC API of the public full nodes was switched off in July 2026
//! (`fullnode.*.sui.io` now answers « Method not found. JSON-RPC on public fullnodes has been
//! deprecated »); its successors are gRPC (HTTP/2 + protobuf, which `net.rs` does not speak) and
//! GraphQL (plain HTTPS JSON, same transport as every other Kyro backend).
//!
//! Every response is checked against the expected network (`chainIdentifier` = base58 digest of
//! the genesis checkpoint). Kyro picks the gas coins, reads the reference gas price and the epoch,
//! and wallet-core encodes the transaction; the server is only asked to simulate the exact bytes
//! Kyro built (estimate shown in the dialog) and to execute them once signed.

use serde::Serialize;
use serde_json::{json, Value};
use wallet_core::{Network, SuiObjectRef};

use crate::error::{AppError, AppResult};
use crate::net::{Family, NetClient, ServerRequest};

/// Base58 digest of the genesis checkpoint (`chainIdentifier`), mainnet.
pub const MAINNET_CHAIN_ID: &str = "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S";
/// Same for testnet (changes only if testnet is ever wiped).
pub const TESTNET_CHAIN_ID: &str = "69WiPg3DAQiwdxfncX6wYQ2siKwAe6L9BZthQea3JNMD";
/// Full Move type of a SUI coin object, as GraphQL prints it.
const SUI_COIN_REPR: &str = "0x0000000000000000000000000000000000000000000000000000000000000002::coin::Coin<0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI>";
const SUI_REPR: &str =
    "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
/// Coins read per page (server limit 50) and at most this many pages.
const COIN_PAGE: u32 = 50;
const MAX_COIN_PAGES: usize = 6;
/// Transactions shown in the history.
const MAX_TXS: u32 = 20;
/// Budget of the draft transaction that is simulated to estimate the real one (0.05 SUI).
pub const DRAFT_BUDGET: u64 = 50_000_000;
/// `GAS_SAFE_OVERHEAD` of the official SDK (gas units added to the computation cost).
const GAS_SAFE_OVERHEAD: u64 = 1000;

pub fn default_url(net: Network) -> &'static str {
    match net {
        Network::Mainnet => "https://graphql.mainnet.sui.io/graphql",
        Network::Testnet => "https://graphql.testnet.sui.io/graphql",
    }
}

pub fn chain_identifier(net: Network) -> &'static str {
    match net {
        Network::Mainnet => MAINNET_CHAIN_ID,
        Network::Testnet => TESTNET_CHAIN_ID,
    }
}

pub struct SuiCtx<'a> {
    pub net_client: &'a NetClient,
    pub network: Network,
    pub tor: bool,
    pub url: String,
    pub chain_id: String,
}

impl<'a> SuiCtx<'a> {
    pub fn new(net_client: &'a NetClient, network: Network, tor: bool) -> Self {
        Self {
            net_client,
            network,
            tor,
            url: default_url(network).into(),
            chain_id: chain_identifier(network).into(),
        }
    }
}

fn bad(msg: impl Into<String>) -> AppError {
    AppError::ServerUnreachable(msg.into())
}

fn short(s: &str) -> String {
    crate::dialog_text::sanitize(s, 200)
}

/// One GraphQL request. `errors` → `SERVER_UNREACHABLE` (or `INVALID_INPUT` for a request the
/// server rejected as bad user input, e.g. a refused transaction), with the server's message.
async fn gql(ctx: &SuiCtx<'_>, query: &str, variables: Value) -> AppResult<Value> {
    let u = url::Url::parse(&ctx.url)
        .map_err(|_| AppError::ServerInvalid("invalid Sui GraphQL URL".into()))?;
    let body = json!({ "query": query, "variables": variables }).to_string();
    let (status, bytes) = ctx
        .net_client
        .server_request(ServerRequest::post_json(u, Family::Sui, body), ctx.tor)
        .await?;
    let v: Value = serde_json::from_slice(&bytes).map_err(|_| {
        bad(format!(
            "Sui: HTTP {status}, non-JSON response ({})",
            short(&String::from_utf8_lossy(&bytes))
        ))
    })?;
    if let Some(e) = v["errors"].as_array().and_then(|a| a.first()) {
        let msg = short(e["message"].as_str().unwrap_or("error"));
        return Err(if e["extensions"]["code"] == "BAD_USER_INPUT" {
            AppError::InvalidInput(format!("Sui: {msg}"))
        } else {
            bad(format!("Sui: {msg}"))
        });
    }
    if status != 200 {
        return Err(bad(format!("Sui: HTTP {status}")));
    }
    Ok(v["data"].clone())
}

/// A `BigInt` / `UInt53` field (JSON string or number) as u64.
fn num(v: &Value) -> Option<u64> {
    match v {
        Value::String(s) => s.parse().ok(),
        Value::Number(n) => n.as_u64(),
        _ => None,
    }
}

/// A signed `BigInt` (balance change).
fn signed(v: &Value) -> Option<i128> {
    match v {
        Value::String(s) => s.parse().ok(),
        Value::Number(n) => n.as_i64().map(i128::from),
        _ => None,
    }
}

fn check_address(a: &str) -> AppResult<String> {
    Ok(wallet_core::sui_address_string(
        &wallet_core::sui_parse_address(a)?,
    ))
}

// ---------------------------------------------------------------- epoch, balance, coins

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SuiEpoch {
    pub epoch: u64,
    /// MIST per gas unit.
    pub reference_gas_price: u64,
}

fn check_chain(ctx: &SuiCtx<'_>, got: &Value) -> AppResult<()> {
    let got = got.as_str().unwrap_or("");
    if got != ctx.chain_id {
        let name = match got {
            MAINNET_CHAIN_ID => "mainnet".to_owned(),
            TESTNET_CHAIN_ID => "testnet".to_owned(),
            other => format!("another network ({})", short(other)),
        };
        return Err(AppError::ServerWrongNetwork(format!(
            "this Sui server is on {name}, not on {}",
            crate::servers::utxo_network_key(ctx.network)
        )));
    }
    Ok(())
}

/// Current epoch and reference gas price, after checking the network.
pub async fn epoch(ctx: &SuiCtx<'_>) -> AppResult<SuiEpoch> {
    let d = gql(
        ctx,
        "{ chainIdentifier epoch { epochId referenceGasPrice } }",
        json!({}),
    )
    .await?;
    check_chain(ctx, &d["chainIdentifier"])?;
    Ok(SuiEpoch {
        epoch: num(&d["epoch"]["epochId"]).ok_or_else(|| bad("Sui: epoch missing"))?,
        reference_gas_price: num(&d["epoch"]["referenceGasPrice"])
            .filter(|p| *p > 0)
            .ok_or_else(|| bad("Sui: reference gas price missing"))?,
    })
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SuiBalance {
    pub address: String,
    /// MIST, decimal: `coin + addressBalance`.
    pub total: String,
    /// MIST held in coin objects: what Kyro can spend.
    pub coin: String,
    /// MIST held in the address balance accumulator (not spendable by Kyro yet).
    pub address_balance: String,
}

pub async fn balance(ctx: &SuiCtx<'_>, address: &str) -> AppResult<SuiBalance> {
    let a = check_address(address)?;
    let d = gql(
        ctx,
        "query($a: SuiAddress!) { chainIdentifier address(address: $a) { balance(coinType: \"0x2::sui::SUI\") { totalBalance coinBalance addressBalance } } }",
        json!({ "a": a }),
    )
    .await?;
    check_chain(ctx, &d["chainIdentifier"])?;
    let b = &d["address"]["balance"];
    let get = |k: &str| num(&b[k]).unwrap_or(0).to_string();
    Ok(SuiBalance {
        address: a,
        total: get("totalBalance"),
        coin: get("coinBalance"),
        address_balance: get("addressBalance"),
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SuiCoin {
    pub r: SuiObjectRef,
    /// MIST.
    pub balance: u64,
}

/// SUI coin objects owned by `address` (at most 300), largest first.
pub async fn coins(ctx: &SuiCtx<'_>, address: &str) -> AppResult<Vec<SuiCoin>> {
    coins_of(
        ctx,
        address,
        "0x2::coin::Coin<0x2::sui::SUI>",
        SUI_COIN_REPR,
    )
    .await
}

/// Coin objects of the known token `coin_type` owned by `address` (at most 300), largest first.
pub async fn token_coins(
    ctx: &SuiCtx<'_>,
    address: &str,
    coin: &wallet_core::SuiKnownCoin,
) -> AppResult<Vec<SuiCoin>> {
    let t = format!("0x2::coin::Coin<{}>", coin.coin_type);
    let repr = format!(
        "0x0000000000000000000000000000000000000000000000000000000000000002::coin::Coin<{}>",
        coin.coin_type
    );
    coins_of(ctx, address, &t, &repr).await
}

/// Coin objects whose Move type is `filter` (printed by the server as `repr`, checked on every
/// object), owned by `address` at the version and digest returned.
async fn coins_of(
    ctx: &SuiCtx<'_>,
    address: &str,
    filter: &str,
    repr: &str,
) -> AppResult<Vec<SuiCoin>> {
    let a = check_address(address)?;
    let mut out: Vec<SuiCoin> = Vec::new();
    let mut after: Option<String> = None;
    for _ in 0..MAX_COIN_PAGES {
        let d = gql(
            ctx,
            "query($a: SuiAddress!, $n: Int!, $after: String, $t: String!) { chainIdentifier address(address: $a) { objects(first: $n, after: $after, filter: { type: $t }) { pageInfo { hasNextPage endCursor } nodes { address version digest owner { __typename ... on AddressOwner { address { address } } } contents { type { repr } json } } } } }",
            json!({ "a": a, "n": COIN_PAGE, "after": after, "t": filter }),
        )
        .await?;
        check_chain(ctx, &d["chainIdentifier"])?;
        let objs = &d["address"]["objects"];
        for n in objs["nodes"].as_array().into_iter().flatten() {
            let c = &n["contents"];
            if c["type"]["repr"] != repr {
                return Err(bad("Sui: object of another type in the coin list"));
            }
            if n["owner"]["address"]["address"].as_str() != Some(a.as_str()) {
                return Err(bad("Sui: coin not owned by this account"));
            }
            let id = n["address"].as_str().unwrap_or("");
            if c["json"]["id"].as_str() != Some(id) {
                return Err(bad("Sui: inconsistent coin ID"));
            }
            out.push(SuiCoin {
                r: SuiObjectRef::parse(
                    id,
                    num(&n["version"]).ok_or_else(|| bad("Sui: coin version missing"))?,
                    n["digest"].as_str().unwrap_or(""),
                )
                .map_err(|e| bad(format!("Sui: invalid coin ({e})")))?,
                balance: num(&c["json"]["balance"])
                    .ok_or_else(|| bad("Sui: coin balance missing"))?,
            });
        }
        if objs["pageInfo"]["hasNextPage"] != true {
            break;
        }
        after = objs["pageInfo"]["endCursor"].as_str().map(str::to_owned);
        if after.is_none() {
            break;
        }
    }
    out.sort_by_key(|c| std::cmp::Reverse(c.balance));
    Ok(out)
}

/// Balance of each known token (coin objects + address balance), one line per known coin type.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SuiTokenBalance {
    pub coin_type: String,
    pub symbol: String,
    pub decimals: u8,
    /// Token units, decimal: `coin + addressBalance`.
    pub total: String,
    /// Units held in coin objects: what Kyro can send.
    pub coin: String,
    pub address_balance: String,
}

pub async fn token_balances(ctx: &SuiCtx<'_>, address: &str) -> AppResult<Vec<SuiTokenBalance>> {
    let a = check_address(address)?;
    let mut out = Vec::new();
    for k in wallet_core::sui_known_coins(ctx.network == Network::Testnet) {
        let d = gql(
            ctx,
            "query($a: SuiAddress!, $t: String!) { chainIdentifier address(address: $a) { balance(coinType: $t) { totalBalance coinBalance addressBalance } } }",
            json!({ "a": a, "t": k.coin_type }),
        )
        .await?;
        check_chain(ctx, &d["chainIdentifier"])?;
        let b = &d["address"]["balance"];
        let get = |f: &str| num(&b[f]).unwrap_or(0).to_string();
        out.push(SuiTokenBalance {
            coin_type: k.coin_type.into(),
            symbol: k.symbol.into(),
            decimals: k.decimals,
            total: get("totalBalance"),
            coin: get("coinBalance"),
            address_balance: get("addressBalance"),
        });
    }
    Ok(out)
}

/// Gas coins for a transfer: largest first until `need` MIST is covered (at most 256 coins).
/// Returns every coin (up to 256) when even that does not cover `need`.
pub fn select_coins(coins: &[SuiCoin], need: u64) -> Vec<SuiCoin> {
    select_up_to(coins, need, wallet_core::SUI_MAX_GAS_OBJECTS)
}

/// Same, with at most `max` coins.
pub fn select_up_to(coins: &[SuiCoin], need: u64, max: usize) -> Vec<SuiCoin> {
    let mut out = Vec::new();
    let mut sum: u64 = 0;
    for c in coins.iter().take(max) {
        out.push(*c);
        sum = sum.saturating_add(c.balance);
        if sum >= need {
            break;
        }
    }
    out
}

/// Gas budget for the simulated costs, as the official SDK computes it: computation cost +
/// 1000 gas units of margin, plus storage cost minus rebate when positive.
pub fn gas_budget(e: &SuiEstimate, price: u64) -> u64 {
    let base = e
        .computation_cost
        .saturating_add(GAS_SAFE_OVERHEAD.saturating_mul(price));
    base.saturating_add(e.storage_cost.saturating_sub(e.storage_rebate))
}

// ---------------------------------------------------------------- simulate, execute

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SuiEstimate {
    /// MIST.
    pub computation_cost: u64,
    pub storage_cost: u64,
    pub storage_rebate: u64,
    /// `computation + storage − rebate` (MIST, may be negative when objects are deleted).
    pub net_fee: i128,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SuiBalanceChange {
    pub owner: String,
    pub coin_type: String,
    pub amount: i128,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SuiSimulation {
    pub success: bool,
    pub error: Option<String>,
    pub digest: String,
    pub estimate: SuiEstimate,
    pub balance_changes: Vec<SuiBalanceChange>,
}

const EFFECTS: &str = "digest status executionError { message } gasEffects { gasSummary { computationCost storageCost storageRebate } } balanceChanges(first: 10) { nodes { owner { address } coinType { repr } amount } }";

fn parse_effects(e: &Value) -> AppResult<SuiSimulation> {
    if e.is_null() {
        return Err(bad("Sui: effects missing"));
    }
    let g = &e["gasEffects"]["gasSummary"];
    let c = num(&g["computationCost"]).unwrap_or(0);
    let s = num(&g["storageCost"]).unwrap_or(0);
    let r = num(&g["storageRebate"]).unwrap_or(0);
    Ok(SuiSimulation {
        success: e["status"] == "SUCCESS",
        error: e["executionError"]["message"].as_str().map(short),
        digest: e["digest"].as_str().unwrap_or("").to_owned(),
        estimate: SuiEstimate {
            computation_cost: c,
            storage_cost: s,
            storage_rebate: r,
            net_fee: i128::from(c) + i128::from(s) - i128::from(r),
        },
        balance_changes: e["balanceChanges"]["nodes"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|n| SuiBalanceChange {
                owner: n["owner"]["address"].as_str().unwrap_or("").to_owned(),
                coin_type: n["coinType"]["repr"].as_str().unwrap_or("").to_owned(),
                amount: signed(&n["amount"]).unwrap_or(0),
            })
            .collect(),
    })
}

/// Dry run of the exact BCS Kyro built (no signature needed). The digest must be ours.
pub async fn simulate(ctx: &SuiCtx<'_>, bcs_b64: &str, digest: &str) -> AppResult<SuiSimulation> {
    let q = format!(
        "query($t: JSON!) {{ chainIdentifier simulateTransaction(transaction: $t) {{ effects {{ {EFFECTS} }} }} }}"
    );
    let d = gql(ctx, &q, json!({ "t": { "bcs": { "value": bcs_b64 } } })).await?;
    check_chain(ctx, &d["chainIdentifier"])?;
    let sim = parse_effects(&d["simulateTransaction"]["effects"])?;
    if sim.digest != digest {
        return Err(bad("Sui: the simulation is for another transaction"));
    }
    Ok(sim)
}

/// Net SUI change of `owner` in a simulation.
pub fn sui_change(sim: &SuiSimulation, owner: &str) -> i128 {
    coin_change(sim, owner, SUI_REPR)
}

/// Net change of `owner` for the coin type printed `repr`.
pub fn coin_change(sim: &SuiSimulation, owner: &str, repr: &str) -> i128 {
    sim.balance_changes
        .iter()
        .filter(|c| c.owner == owner && c.coin_type == repr)
        .map(|c| c.amount)
        .sum()
}

/// Only SUI and the token `repr` moved, only between `a` and `b`; the SUI of `b` did not move.
pub fn only_token_between(sim: &SuiSimulation, a: &str, b: &str, repr: &str) -> bool {
    sim.balance_changes.iter().all(|c| {
        (c.coin_type == repr && (c.owner == a || c.owner == b))
            || (c.coin_type == SUI_REPR && c.owner == a)
    })
}

/// Only SUI moved, only between `a` and `b`.
pub fn only_sui_between(sim: &SuiSimulation, a: &str, b: &str) -> bool {
    sim.balance_changes
        .iter()
        .all(|c| c.coin_type == SUI_REPR && (c.owner == a || c.owner == b))
}

/// Executes a signed transaction and waits for finality. The digest of the effects must be the
/// one computed locally; a transaction that executed but failed (gas spent) is an error.
pub async fn execute(
    ctx: &SuiCtx<'_>,
    bcs_b64: &str,
    signature_b64: &str,
    digest: &str,
) -> AppResult<String> {
    let q = format!(
        "mutation($b: Base64!, $s: [Base64!]!) {{ executeTransaction(transactionDataBcs: $b, signatures: $s) {{ effects {{ {EFFECTS} }} }} }}"
    );
    let d = gql(ctx, &q, json!({ "b": bcs_b64, "s": [signature_b64] })).await?;
    let e = parse_effects(&d["executeTransaction"]["effects"])?;
    if e.digest != digest {
        return Err(bad(format!(
            "Sui: the server returned an unexpected digest ({})",
            short(&e.digest)
        )));
    }
    if !e.success {
        return Err(AppError::InvalidInput(format!(
            "Sui transaction {digest} executed but failed (gas fees charged): {}",
            e.error.unwrap_or_default()
        )));
    }
    Ok(digest.to_owned())
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SuiTxStatus {
    /// Known to the indexer.
    pub found: bool,
    pub success: bool,
    pub error: Option<String>,
    pub checkpoint: Option<u64>,
}

pub async fn tx_status(ctx: &SuiCtx<'_>, digest: &str) -> AppResult<SuiTxStatus> {
    let d = gql(
        ctx,
        "query($d: String!) { transaction(digest: $d) { effects { status executionError { message } checkpoint { sequenceNumber } } } }",
        json!({ "d": digest }),
    )
    .await?;
    let e = &d["transaction"]["effects"];
    if e.is_null() {
        return Ok(SuiTxStatus::default());
    }
    Ok(SuiTxStatus {
        found: true,
        success: e["status"] == "SUCCESS",
        error: e["executionError"]["message"].as_str().map(short),
        checkpoint: num(&e["checkpoint"]["sequenceNumber"]),
    })
}

/// Last 20 transactions touching `address`, most recent first, normalized:
/// `[{ digest, timestamp, checkpoint, success, sender, change, fee, counterparty, otherCoins }]`
/// — `change`: net SUI change of `address` in MIST (signed decimal, fees included);
/// `fee`: net gas paid when `address` sent it; `counterparty`: the other address whose SUI
/// balance moved; `otherCoins`: other coin types moved for `address` (not shown in detail).
pub async fn txs(ctx: &SuiCtx<'_>, address: &str) -> AppResult<Value> {
    let a = check_address(address)?;
    let d = gql(
        ctx,
        "query($a: SuiAddress!, $n: Int!) { chainIdentifier address(address: $a) { transactions(last: $n, relation: AFFECTED) { nodes { digest sender { address } effects { status timestamp checkpoint { sequenceNumber } gasEffects { gasSummary { computationCost storageCost storageRebate } } balanceChanges(first: 10) { nodes { owner { address } coinType { repr } amount } } } } } } }",
        json!({ "a": a, "n": MAX_TXS }),
    )
    .await?;
    check_chain(ctx, &d["chainIdentifier"])?;
    let mut out = Vec::new();
    for t in d["address"]["transactions"]["nodes"]
        .as_array()
        .into_iter()
        .flatten()
    {
        let e = parse_effects(&{
            let mut e = t["effects"].clone();
            e["digest"] = t["digest"].clone();
            e
        })?;
        let sender = t["sender"]["address"].as_str().unwrap_or("").to_owned();
        let change = sui_change(&e, &a);
        let counterparty = e
            .balance_changes
            .iter()
            .find(|c| c.owner != a && c.coin_type == SUI_REPR && (c.amount > 0) == (change < 0))
            .map(|c| c.owner.clone());
        let known = wallet_core::sui_known_coins(ctx.network == Network::Testnet);
        let other_coins = e.balance_changes.iter().any(|c| {
            c.owner == a
                && c.coin_type != SUI_REPR
                && !known.iter().any(|k| k.coin_type == c.coin_type)
        });
        // Known tokens only: their net change for us and who was on the other side.
        let tokens: Vec<Value> = known
            .iter()
            .filter_map(|k| {
                let ch = coin_change(&e, &a, k.coin_type);
                (ch != 0).then(|| {
                    let cp = e
                        .balance_changes
                        .iter()
                        .find(|c| {
                            c.owner != a && c.coin_type == k.coin_type && (c.amount > 0) == (ch < 0)
                        })
                        .map(|c| c.owner.clone());
                    json!({ "coinType": k.coin_type, "change": ch.to_string(), "counterparty": cp })
                })
            })
            .collect();
        out.push(json!({
            "digest": e.digest,
            "timestamp": t["effects"]["timestamp"],
            "checkpoint": num(&t["effects"]["checkpoint"]["sequenceNumber"]),
            "success": e.success,
            "sender": sender,
            "change": change.to_string(),
            "fee": if sender == a { Some(e.estimate.net_fee.to_string()) } else { None },
            "counterparty": counterparty,
            "otherCoins": other_coins,
            "tokens": tokens,
        }));
    }
    out.reverse();
    Ok(Value::Array(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn coin(b: u64, id: u8) -> SuiCoin {
        SuiCoin {
            r: SuiObjectRef {
                object_id: [id; 32],
                version: 1,
                digest: [0; 32],
            },
            balance: b,
        }
    }

    #[test]
    fn coin_selection_and_budget() {
        let cs = [coin(50, 1), coin(30, 2), coin(20, 3)];
        assert_eq!(select_coins(&cs, 10).len(), 1);
        assert_eq!(select_coins(&cs, 50).len(), 1);
        assert_eq!(select_coins(&cs, 51).len(), 2);
        assert_eq!(select_coins(&cs, 1000).len(), 3);
        let many: Vec<SuiCoin> = (0..300).map(|i| coin(1, i as u8)).collect();
        assert_eq!(select_coins(&many, 10_000).len(), 256);
        // SDK formula: computation + 1000 × price + max(0, storage − rebate).
        let e = SuiEstimate {
            computation_cost: 1_000_000,
            storage_cost: 1_976_000,
            storage_rebate: 978_120,
            net_fee: 0,
        };
        assert_eq!(gas_budget(&e, 1000), 1_000_000 + 1_000_000 + 997_880);
        let refund = SuiEstimate {
            storage_rebate: 5_000_000,
            ..e
        };
        assert_eq!(gas_budget(&refund, 1000), 2_000_000);
    }

    #[test]
    fn effects_parsing() {
        let e = json!({
            "digest": "D", "status": "SUCCESS", "executionError": null,
            "gasEffects": { "gasSummary": { "computationCost": 100000, "storageCost": 1976000, "storageRebate": 987901 } },
            "balanceChanges": { "nodes": [
                { "owner": { "address": "0xa" }, "coinType": { "repr": SUI_REPR }, "amount": "-3164099" },
                { "owner": { "address": "0xb" }, "coinType": { "repr": SUI_REPR }, "amount": "2076000" }
            ] }
        });
        let s = parse_effects(&e).unwrap();
        assert!(s.success);
        assert_eq!(s.estimate.net_fee, 100_000 + 1_976_000 - 987_901);
        assert_eq!(sui_change(&s, "0xa"), -3_164_099);
        assert_eq!(sui_change(&s, "0xb"), 2_076_000);
        assert!(only_sui_between(&s, "0xa", "0xb"));
        assert!(!only_sui_between(&s, "0xa", "0xc"));
        assert!(parse_effects(&Value::Null).is_err());
    }
}

/// Real-network test over Tor. Run with
/// `cargo test -p kyro-desktop -- --ignored --nocapture sui_live`.
/// - keys: a NEW random test mnemonic, generated once and kept in the gitignored
///   `.env.sui-testnet` at the repository root (test networks only);
/// - reads run on testnet and mainnet (network checks, reference gas price, balance, history);
/// - `KYRO_SUI_FAUCET=yes`: asks the **devnet** faucet for coins (the testnet faucet's HTTP API
///   answers « CI compatibility is disabled » since 2026: testnet coins only come from the web
///   faucet, which has a captcha). The transfer then runs on devnet, through exactly the same
///   code as testnet / mainnet (only the GraphQL URL and chain identifier differ). If the
///   testnet address holds coins (sent by hand from faucet.sui.io), the transfer runs on testnet;
/// - `KYRO_SUI_SEND=yes`: one transfer of an amount, then one « tout le solde » transfer back
///   from account 1 to account 0, through the real path (build, live checks, simulation, dialog
///   text, signature with identical summary, signed-transaction check, execute, digest check).
#[cfg(test)]
mod live {
    use super::*;
    use crate::tor::TorState;

    const DEVNET_URL: &str = "https://graphql.devnet.sui.io/graphql";
    const DEVNET_FAUCET: &str = "https://faucet.devnet.sui.io/v2/gas";

    fn test_seed() -> wallet_core::Seed {
        let path =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../.env.sui-testnet");
        let words = match std::fs::read_to_string(&path) {
            Ok(s) => s
                .lines()
                .find_map(|l| l.strip_prefix("KYRO_SUI_TEST_MNEMONIC="))
                .expect("mnemonic line")
                .trim()
                .to_owned(),
            Err(_) => {
                let m = wallet_core::Mnemonic::generate(wallet_core::WordCount::W12).unwrap();
                let w = m.words().join(" ");
                std::fs::write(
                    &path,
                    format!("# SUI TESTNET / DEVNET ONLY - random test mnemonic generated by Kyro's live test (sui_backend.rs).\n# Never use it for real funds. This file is gitignored (.env.*).\nKYRO_SUI_TEST_MNEMONIC={w}\n"),
                )
                .unwrap();
                eprintln!("new test mnemonic written to {}", path.display());
                w
            }
        };
        wallet_core::Mnemonic::parse(&words).unwrap().to_seed("")
    }

    async fn send(
        c: &SuiCtx<'_>,
        seed: &wallet_core::Seed,
        account: u32,
        to: &str,
        amount: Option<u64>,
    ) -> String {
        let me = wallet_core::sui_address(seed, account).unwrap();
        let built = crate::commands_sui::build(c, &me, to, amount)
            .await
            .unwrap();
        let (summary, context) = crate::commands_sui::prepare_sign(c, &me, &built.bcs, None)
            .await
            .unwrap();
        assert_eq!(summary, built.summary);
        eprintln!(
            "--- dialog ---\n{}---",
            crate::commands_sui::describe_sui(crate::i18n::Lang::Fr, &summary, &context, c.network)
        );
        if summary.requires_extra_confirmation {
            eprintln!(
                "--- extra ---\n{}---",
                crate::commands_sui::describe_sui_extra(crate::i18n::Lang::Fr, &summary)
            );
        }
        let (sig, again) = wallet_core::sui_sign(seed, account, &built.bcs).unwrap();
        assert_eq!(again, summary, "identical summary");
        let digest = crate::commands_sui::broadcast_checked(c, &me, &built.bcs, &sig)
            .await
            .unwrap();
        assert_eq!(digest, summary.digest);
        eprintln!("EXECUTED {digest}");
        for _ in 0..30 {
            let s = tx_status(c, &digest).await.unwrap();
            if s.found {
                eprintln!("status {s:?}");
                assert!(s.success);
                return digest;
            }
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
        panic!("{digest} not indexed");
    }

    #[test]
    #[ignore]
    fn sui_live_over_tor() {
        let net = NetClient::new(std::env::temp_dir().join("kyro-sui-live")).unwrap();
        let seed = test_seed();
        let a0 = wallet_core::sui_address(&seed, 0).unwrap();
        let a1 = wallet_core::sui_address(&seed, 1).unwrap();
        eprintln!("addresses: {a0} {a1}");
        tauri::async_runtime::block_on(async {
            net.tor.restart();
            while net.tor.status().state != TorState::Ready {
                assert_ne!(net.tor.status().state, TorState::Error);
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            }
            let testnet = SuiCtx::new(&net, Network::Testnet, true);
            let mainnet = SuiCtx::new(&net, Network::Mainnet, true);
            let t = std::time::Instant::now();
            eprintln!(
                "testnet epoch {:?} in {:.1?}",
                epoch(&testnet).await,
                t.elapsed()
            );
            eprintln!("mainnet epoch {:?}", epoch(&mainnet).await);
            // Wrong network: the mainnet server answered for a testnet wallet.
            let wrong = SuiCtx {
                url: default_url(Network::Mainnet).into(),
                ..SuiCtx::new(&net, Network::Testnet, true)
            };
            let e = epoch(&wrong).await;
            eprintln!("wrong network: {e:?}");
            assert!(matches!(e, Err(AppError::ServerWrongNetwork(_))));
            // History of a busy mainnet address (format check).
            let h = txs(
                &mainnet,
                "0x177a0f6b96e2c76703d97b39990a62106aee3bb048b5fbfa4fcfdfc671c54869",
            )
            .await
            .unwrap();
            eprintln!(
                "mainnet history: {} entries, first {}",
                h.as_array().map(Vec::len).unwrap_or(0),
                h[0]
            );

            let devnet_id = {
                let d = gql(
                    &SuiCtx {
                        url: DEVNET_URL.into(),
                        ..SuiCtx::new(&net, Network::Testnet, true)
                    },
                    "{ chainIdentifier }",
                    json!({}),
                )
                .await
                .unwrap();
                d["chainIdentifier"].as_str().unwrap().to_owned()
            };
            let devnet = SuiCtx {
                url: DEVNET_URL.into(),
                chain_id: devnet_id,
                ..SuiCtx::new(&net, Network::Testnet, true)
            };
            let tb = balance(&testnet, &a0).await.unwrap();
            eprintln!("testnet balance {tb:?}");
            let c = if tb.coin != "0" { &testnet } else { &devnet };
            let mut b = balance(c, &a0).await.unwrap();
            if b.coin == "0" && std::env::var("KYRO_SUI_FAUCET").as_deref() == Ok("yes") {
                let req = ServerRequest::post_json(
                    url::Url::parse(DEVNET_FAUCET).unwrap(),
                    Family::Sui,
                    json!({ "FixedAmountRequest": { "recipient": a0 } }).to_string(),
                );
                let (status, body) = net.server_request(req, true).await.unwrap();
                eprintln!(
                    "faucet: HTTP {status} {}",
                    short(&String::from_utf8_lossy(&body))
                );
                for _ in 0..30 {
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                    b = balance(c, &a0).await.unwrap();
                    if b.coin != "0" {
                        break;
                    }
                }
            }
            eprintln!(
                "{} balance {b:?}",
                if std::ptr::eq(c, &testnet) {
                    "testnet"
                } else {
                    "devnet"
                }
            );
            eprintln!("coins {:?}", coins(c, &a0).await.unwrap().len());
            eprintln!("history: {}", txs(c, &a0).await.unwrap());
            if std::env::var("KYRO_SUI_SEND").as_deref() != Ok("yes") || b.coin == "0" {
                eprintln!("KYRO_SUI_SEND != yes or no coins: no transfer");
                return;
            }
            // More than the balance: refused before anything is signed.
            let too_much = crate::commands_sui::build(c, &a0, &a1, Some(u64::MAX / 2)).await;
            eprintln!("too much: {:?}", too_much.as_ref().err());
            assert!(matches!(too_much, Err(AppError::InvalidInput(_))));
            let d1 = send(c, &seed, 0, &a1, Some(100_000_000)).await;
            eprintln!("TRANSFER 0.1 SUI: {d1}");
            // The indexer may lag behind finality: wait until account 1's coin is listed.
            for _ in 0..30 {
                if !coins(c, &a1).await.unwrap().is_empty() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            }
            let d2 = send(c, &seed, 1, &a0, None).await;
            eprintln!("TRANSFER ALL BACK: {d2}");
            eprintln!("history of account 1: {}", txs(c, &a1).await.unwrap());
        });
    }

    /// USDC transfers built by Kyro for real mainnet holders (no key: simulation only, which
    /// needs no signature): the server accepts the BCS layout, the live checks and the dialog
    /// pass, the simulation moves exactly the amount. `cargo test -p kyro-desktop --lib
    /// sui_token_simulation_mainnet -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn sui_token_simulation_mainnet() {
        let net = NetClient::new(std::env::temp_dir().join("kyro-sui-live")).unwrap();
        let usdc = wallet_core::sui_known_coins(false)[0];
        tauri::async_runtime::block_on(async {
            let c = SuiCtx::new(&net, Network::Mainnet, false);
            let d = gql(
                &c,
                "query($t: String!) { objects(first: 40, filter: { type: $t }) { nodes { owner { ... on AddressOwner { address { address } } } } } }",
                json!({ "t": format!("0x2::coin::Coin<{}>", usdc.coin_type) }),
            )
            .await
            .unwrap();
            let to = "0x1ada6e6f3f3e4055096f606c746690f1108fcc2ca479055cc434a3e1d3f758aa";
            let mut done = 0;
            for n in d["objects"]["nodes"].as_array().unwrap() {
                let Some(holder) = n["owner"]["address"]["address"].as_str() else {
                    continue;
                };
                let b = token_balances(&c, holder).await.unwrap();
                let coin: u64 = b[0].coin.parse().unwrap();
                let gas: u64 = balance(&c, holder).await.unwrap().coin.parse().unwrap();
                if coin < 2 || gas < 10_000_000 {
                    continue;
                }
                let tc = token_coins(&c, holder, &usdc).await.unwrap();
                let merge = (tc.len() > 1).then(|| tc[0].balance + 1);
                for amount in [Some(Some(1)), merge.map(Some), Some(None)]
                    .into_iter()
                    .flatten()
                {
                    match crate::commands_sui::build_token(&c, holder, to, usdc.coin_type, amount)
                        .await
                    {
                        Ok(built) => {
                            eprintln!(
                                "--- {holder} {amount:?} ---\n{}",
                                crate::commands_sui::describe_sui(
                                    crate::i18n::Lang::Fr,
                                    &built.summary,
                                    &built.context,
                                    Network::Mainnet
                                )
                            );
                            done += 1;
                        }
                        Err(e) => eprintln!("{holder} {amount:?}: {e}"),
                    }
                }
                if done >= 4 {
                    break;
                }
            }
            assert!(done >= 3);
        });
    }
}
