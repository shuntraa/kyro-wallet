//! Kaspa data from the public REST API of the Kaspa developers (`kaspa-rest-server`):
//! `api.kaspa.org` (mainnet) and `api-tn10.kaspa.org` (testnet-10), on the `kaspa` Tor family,
//! never with a fallback. Endpoints checked live on 2026-11-01 (OpenAPI of both hosts).
//!
//! | Use | Endpoint |
//! |---|---|
//! | network check, virtual DAA score (coinbase maturity) | `GET /info/network` (`networkName`) |
//! | balances of our addresses (one request) | `POST /addresses/balances` |
//! | coins of our addresses (one request) | `POST /addresses/utxos` |
//! | priority fee rate (sompi/gram) | `GET /info/fee-estimate` (`normalBuckets[0].feerate`) |
//! | which addresses have history | `POST /addresses/active` |
//! | history of one address | `GET /addresses/{a}/full-transactions?resolve_previous_outpoints=light` |
//! | acceptance of a transaction | `GET /transactions/{id}` |
//! | broadcast | `POST /transactions` (`{ transaction, allowOrphan: false }`) |
//!
//! Kyro builds every transaction itself (wallet-core); a server-built transaction is never
//! signed. What the server can lie about: balances, coins (a coin that does not exist, or with
//! another amount, makes the signature invalid — the signature hash commits to each spent
//! coin's amount and script —, so the network rejects the transaction; a hidden coin only
//! lowers the balance), history, fee estimate (bounded, and the fee is shown before signing).
//! Every coin it returns must pay the exact script of one of our addresses, else the whole list
//! is refused.

use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;
use serde_json::{json, Value};
use wallet_core::{
    KaspaOutpoint, KaspaOwnKey, KaspaSpendable, KaspaUtxoEntry, Network, KASPA_COINBASE_MATURITY,
};

use crate::error::{AppError, AppResult};
use crate::net::{Family, NetClient, ServerRequest};

/// Most coins accepted in one answer (more = refused, consolidate first).
const MAX_UTXOS: usize = 5_000;
/// History: at most this many of our addresses are read (the most recently active first).
const MAX_HISTORY_ADDRESSES: usize = 10;
/// History: transactions per address, and in the merged list.
const MAX_TXS: usize = 50;

pub struct KaspaCtx<'a> {
    pub net_client: &'a NetClient,
    pub network: Network,
    pub tor: bool,
}

/// Default REST API of `net` (no custom server for Kaspa yet).
pub fn base_url(net: Network) -> &'static str {
    match net {
        Network::Mainnet => "https://api.kaspa.org",
        Network::Testnet => "https://api-tn10.kaspa.org",
    }
}

/// `networkName` the server must report.
pub fn network_name(net: Network) -> &'static str {
    match net {
        Network::Mainnet => "kaspa-mainnet",
        Network::Testnet => "kaspa-testnet-10",
    }
}

fn bad(msg: impl Into<String>) -> AppError {
    AppError::ServerUnreachable(msg.into())
}

fn snippet(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).chars().take(200).collect()
}

fn endpoint(ctx: &KaspaCtx<'_>, path: &str) -> AppResult<url::Url> {
    url::Url::parse(&format!("{}{path}", base_url(ctx.network)))
        .map_err(|_| AppError::Internal("invalid Kaspa URL".into()))
}

async fn send(ctx: &KaspaCtx<'_>, path: &str, body: Option<Value>) -> AppResult<(u16, Vec<u8>)> {
    let u = endpoint(ctx, path)?;
    let req = match body {
        None => ServerRequest::get(u, Family::Kaspa),
        Some(b) => ServerRequest::post_json(u, Family::Kaspa, b.to_string()),
    };
    ctx.net_client.server_request(req, ctx.tor).await
}

async fn call(ctx: &KaspaCtx<'_>, path: &str, body: Option<Value>) -> AppResult<Value> {
    let (status, bytes) = send(ctx, path, body).await?;
    if status != 200 {
        return Err(bad(format!(
            "Kaspa API: HTTP {status} on {} ({})",
            path.split('?').next().unwrap_or(path),
            snippet(&bytes)
        )));
    }
    serde_json::from_slice(&bytes).map_err(|_| bad(format!("Kaspa API: invalid JSON on {path}")))
}

/// Integer from a JSON number or a decimal string (the API uses both).
pub fn as_u64(v: &Value) -> Option<u64> {
    match v {
        Value::Number(n) => n.as_u64(),
        Value::String(s)
            if !s.is_empty() && s.len() <= 20 && s.bytes().all(|b| b.is_ascii_digit()) =>
        {
            s.parse().ok()
        }
        _ => None,
    }
}

fn is_txid(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Network check + virtual DAA score.
pub async fn network_info(ctx: &KaspaCtx<'_>) -> AppResult<u64> {
    let v = call(ctx, "/info/network", None).await?;
    let name = v["networkName"].as_str().unwrap_or_default();
    if name != network_name(ctx.network) {
        return Err(AppError::ServerWrongNetwork(format!(
            "the Kaspa API reports \"{}\" instead of \"{}\"",
            crate::dialog_text::field(name, 40),
            network_name(ctx.network)
        )));
    }
    as_u64(&v["virtualDaaScore"]).ok_or_else(|| bad("Kaspa API: virtualDaaScore missing"))
}

fn addresses(keys: &[KaspaOwnKey]) -> Vec<String> {
    keys.iter().map(|k| k.address.clone()).collect()
}

/// Sum of the balances of our addresses (`POST /addresses/balances`). Unknown addresses in the
/// answer are ignored; each of ours counts once.
pub async fn balance(ctx: &KaspaCtx<'_>, keys: &[KaspaOwnKey]) -> AppResult<u64> {
    let v = call(
        ctx,
        "/addresses/balances",
        Some(json!({ "addresses": addresses(keys) })),
    )
    .await?;
    parse_balances(&v, keys)
}

pub fn parse_balances(v: &Value, keys: &[KaspaOwnKey]) -> AppResult<u64> {
    let ours: BTreeSet<&str> = keys.iter().map(|k| k.address.as_str()).collect();
    let mut seen = BTreeSet::new();
    let mut total = 0u64;
    for e in v
        .as_array()
        .ok_or_else(|| bad("Kaspa API: list of balances expected"))?
    {
        let a = e["address"].as_str().unwrap_or_default();
        if !ours.contains(a) || !seen.insert(a.to_owned()) {
            continue;
        }
        let b = as_u64(&e["balance"]).ok_or_else(|| bad("Kaspa API: invalid balance"))?;
        total = total
            .checked_add(b)
            .ok_or_else(|| bad("Kaspa API: invalid balance"))?;
    }
    Ok(total)
}

/// Our coins (`POST /addresses/utxos`). Each must pay the exact P2PK script of the address it
/// is listed under, which must be one of ours; otherwise the whole list is refused.
pub async fn utxos(ctx: &KaspaCtx<'_>, keys: &[KaspaOwnKey]) -> AppResult<Vec<KaspaSpendable>> {
    let v = call(
        ctx,
        "/addresses/utxos",
        Some(json!({ "addresses": addresses(keys) })),
    )
    .await?;
    parse_utxos(&v, keys)
}

pub fn parse_utxos(v: &Value, keys: &[KaspaOwnKey]) -> AppResult<Vec<KaspaSpendable>> {
    let scripts: BTreeMap<&str, Vec<u8>> = keys
        .iter()
        .map(|k| (k.address.as_str(), k.script()))
        .collect();
    let list = v
        .as_array()
        .ok_or_else(|| bad("Kaspa API: list of coins expected"))?;
    if list.len() > MAX_UTXOS {
        return Err(AppError::InvalidInput(format!(
            "more than {MAX_UTXOS} coins: first send part of your balance to yourself to consolidate them"
        )));
    }
    let mut seen = BTreeSet::new();
    let mut out = Vec::with_capacity(list.len());
    for u in list {
        let address = u["address"].as_str().unwrap_or_default();
        let script = scripts
            .get(address)
            .ok_or_else(|| bad("Kaspa API: coin from an address that is not yours"))?;
        let txid = u["outpoint"]["transactionId"].as_str().unwrap_or_default();
        let index = u["outpoint"]["index"]
            .as_u64()
            .and_then(|i| u32::try_from(i).ok());
        let e = &u["utxoEntry"];
        let spk = e["scriptPublicKey"]["scriptPublicKey"]
            .as_str()
            .unwrap_or_default();
        let (Some(index), Some(amount), Some(daa), Some(coinbase)) = (
            index,
            as_u64(&e["amount"]),
            as_u64(&e["blockDaaScore"]),
            e["isCoinbase"].as_bool(),
        ) else {
            return Err(bad("Kaspa API: malformed coin"));
        };
        if !is_txid(txid) || amount == 0 {
            return Err(bad("Kaspa API: malformed coin"));
        }
        if hex::decode(spk).ok().as_ref() != Some(script) {
            return Err(bad("Kaspa API: a coin's script is not your address's"));
        }
        let mut tx_id = [0u8; 32];
        hex::decode_to_slice(txid, &mut tx_id).map_err(|_| bad("Kaspa API: malformed coin"))?;
        let outpoint = KaspaOutpoint { tx_id, index };
        if !seen.insert(outpoint) {
            continue;
        }
        out.push(KaspaSpendable {
            outpoint,
            entry: KaspaUtxoEntry {
                amount,
                script_version: 0,
                script: script.clone(),
                block_daa_score: daa,
                is_coinbase: coinbase,
            },
        });
    }
    Ok(out)
}

/// Coins that can be spent now: a coinbase output must be twice as old as the maturity.
pub fn mature(coins: Vec<KaspaSpendable>, virtual_daa: u64) -> Vec<KaspaSpendable> {
    coins
        .into_iter()
        .filter(|c| {
            !c.entry.is_coinbase
                || c.entry
                    .block_daa_score
                    .saturating_add(2 * KASPA_COINBASE_MATURITY)
                    <= virtual_daa
        })
        .collect()
}

/// Priority estimate of the server, sompi/gram (`normalBuckets[0].feerate`).
pub async fn fee_estimate(ctx: &KaspaCtx<'_>) -> AppResult<u64> {
    let v = call(ctx, "/info/fee-estimate", None).await?;
    parse_fee_estimate(&v)
}

pub fn parse_fee_estimate(v: &Value) -> AppResult<u64> {
    let f = v["normalBuckets"][0]["feerate"]
        .as_f64()
        .or_else(|| v["priorityBucket"]["feerate"].as_f64())
        .ok_or_else(|| bad("Kaspa API: fee estimate missing"))?;
    if !f.is_finite() || f < 0.0 {
        return Err(bad("Kaspa API: invalid fee estimate"));
    }
    // Rounded up, bounded by wallet-core (`kaspa_priority_feerate`).
    Ok(f.ceil().min(1e9) as u64)
}

/// Broadcast (`POST /transactions`). The id the server returns must be ours.
pub async fn submit(ctx: &KaspaCtx<'_>, tx_json: &str, expected_id: &str) -> AppResult<String> {
    let tx: Value = serde_json::from_str(tx_json)
        .map_err(|_| AppError::Internal("Kaspa transaction: invalid JSON".into()))?;
    let (status, bytes) = send(
        ctx,
        "/transactions",
        Some(json!({ "transaction": tx, "allowOrphan": false })),
    )
    .await?;
    let v: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    if status != 200 {
        let msg = v["error"]
            .as_str()
            .or(v["detail"].as_str())
            .map(|m| crate::dialog_text::field(m, 200))
            .unwrap_or_else(|| snippet(&bytes));
        return Err(if status == 400 || status == 422 {
            AppError::InvalidInput(format!("transaction rejected by the Kaspa node: {msg}"))
        } else {
            bad(format!("Kaspa API: HTTP {status} on broadcast ({msg})"))
        });
    }
    let id = v["transactionId"].as_str().unwrap_or_default();
    if id != expected_id {
        return Err(bad(format!(
            "Kaspa API: returned id \"{}\" differs from your transaction's",
            crate::dialog_text::field(id, 70)
        )));
    }
    Ok(id.to_owned())
}

/// `Some(accepted)` once the indexer knows the transaction, `None` before.
pub async fn tx_status(ctx: &KaspaCtx<'_>, txid: &str) -> AppResult<Option<bool>> {
    if !is_txid(txid) {
        return Err(AppError::InvalidInput(
            "id: 64 lowercase hexadecimal characters".into(),
        ));
    }
    let (status, bytes) = send(
        ctx,
        &format!("/transactions/{txid}?inputs=false&outputs=false"),
        None,
    )
    .await?;
    match status {
        404 => Ok(None),
        200 => {
            let v: Value = serde_json::from_slice(&bytes)
                .map_err(|_| bad("Kaspa API: invalid JSON on /transactions"))?;
            Ok(Some(v["is_accepted"].as_bool().unwrap_or(false)))
        }
        _ => Err(bad(format!("Kaspa API: HTTP {status} on /transactions"))),
    }
}

/// One line of history, seen from the account (all scanned addresses together).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KaspaHistoryEntry {
    pub txid: String,
    /// Block time, ms.
    pub time: u64,
    /// Received − spent by our addresses, sompi (negative = sent).
    pub delta: String,
    /// Inputs − outputs, sompi, when every input amount is known.
    pub fee: Option<String>,
    /// First other party: the first foreign output of an outgoing transaction, the first
    /// foreign input of an incoming one.
    pub counterparty: Option<String>,
    pub accepted: bool,
}

/// Addresses with history (`POST /addresses/active`), most recent first, at most 10.
pub async fn active(ctx: &KaspaCtx<'_>, keys: &[KaspaOwnKey]) -> AppResult<Vec<String>> {
    let v = call(
        ctx,
        "/addresses/active",
        Some(json!({ "addresses": addresses(keys) })),
    )
    .await?;
    let ours: BTreeSet<&str> = keys.iter().map(|k| k.address.as_str()).collect();
    let mut found: Vec<(u64, String)> = v
        .as_array()
        .ok_or_else(|| bad("Kaspa API: list expected on /addresses/active"))?
        .iter()
        .filter(|e| e["active"].as_bool() == Some(true))
        .filter_map(|e| {
            let a = e["address"].as_str()?;
            ours.contains(a)
                .then(|| (as_u64(&e["lastTxBlockTime"]).unwrap_or(0), a.to_owned()))
        })
        .collect();
    found.sort_by(|a, b| b.cmp(a));
    found.dedup_by(|a, b| a.1 == b.1);
    Ok(found
        .into_iter()
        .take(MAX_HISTORY_ADDRESSES)
        .map(|(_, a)| a)
        .collect())
}

/// Merged history of our active addresses, newest first, at most 50.
pub async fn history(
    ctx: &KaspaCtx<'_>,
    keys: &[KaspaOwnKey],
) -> AppResult<Vec<KaspaHistoryEntry>> {
    let mut txs: BTreeMap<String, Value> = BTreeMap::new();
    for a in active(ctx, keys).await? {
        let v = call(
            ctx,
            &format!(
                "/addresses/{a}/full-transactions?limit={MAX_TXS}&offset=0&resolve_previous_outpoints=light"
            ),
            None,
        )
        .await?;
        for t in v.as_array().into_iter().flatten() {
            if let Some(id) = t["transaction_id"].as_str().filter(|i| is_txid(i)) {
                txs.entry(id.to_owned()).or_insert_with(|| t.clone());
            }
        }
    }
    let ours: BTreeSet<&str> = keys.iter().map(|k| k.address.as_str()).collect();
    let mut out: Vec<KaspaHistoryEntry> = txs
        .values()
        .filter_map(|t| history_entry(t, &ours, ctx.network))
        .collect();
    out.sort_by(|a, b| b.time.cmp(&a.time).then(a.txid.cmp(&b.txid)));
    out.truncate(MAX_TXS);
    Ok(out)
}

/// One transaction of `full-transactions` seen from `ours`; `None` if it does not touch them
/// (a server cannot add someone else's transactions to the history).
pub fn history_entry(t: &Value, ours: &BTreeSet<&str>, net: Network) -> Option<KaspaHistoryEntry> {
    let txid = t["transaction_id"]
        .as_str()
        .filter(|i| is_txid(i))?
        .to_owned();
    let mut received: i128 = 0;
    let mut spent: i128 = 0;
    let mut in_total: i128 = 0;
    let mut out_total: i128 = 0;
    let mut all_known = true;
    let mut touched = false;
    let mut foreign_in = None;
    let mut foreign_out = None;
    for i in t["inputs"].as_array().into_iter().flatten() {
        let a = i["previous_outpoint_address"].as_str();
        match as_u64(&i["previous_outpoint_amount"]) {
            Some(v) => in_total += i128::from(v),
            None => all_known = false,
        }
        match a {
            Some(a) if ours.contains(a) => {
                touched = true;
                spent += i128::from(as_u64(&i["previous_outpoint_amount"]).unwrap_or(0));
            }
            Some(a) => {
                foreign_in.get_or_insert_with(|| a.to_owned());
            }
            None => {}
        }
    }
    for o in t["outputs"].as_array().into_iter().flatten() {
        let v = i128::from(as_u64(&o["amount"]).unwrap_or(0));
        out_total += v;
        match o["script_public_key_address"].as_str() {
            Some(a) if ours.contains(a) => {
                touched = true;
                received += v;
            }
            Some(a) => {
                foreign_out.get_or_insert_with(|| a.to_owned());
            }
            None => {}
        }
    }
    if !touched {
        return None;
    }
    let delta = received - spent;
    let outgoing = spent > 0;
    let has_inputs = t["inputs"].as_array().is_some_and(|a| !a.is_empty());
    let fee = (outgoing && all_known && has_inputs && in_total >= out_total)
        .then(|| (in_total - out_total).to_string());
    // Only a well-formed address of this network is shown (the server's text is untrusted).
    let counterparty = if outgoing { foreign_out } else { foreign_in }
        .filter(|a| wallet_core::kaspa_address_decode(net, a).is_ok());
    Some(KaspaHistoryEntry {
        txid,
        time: as_u64(&t["block_time"]).unwrap_or(0),
        delta: delta.to_string(),
        fee,
        counterparty,
        accepted: t["is_accepted"].as_bool().unwrap_or(false),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use wallet_core::{Mnemonic, KASPA_SCAN_WINDOW};

    fn keys() -> Vec<KaspaOwnKey> {
        let s = Mnemonic::parse(
            "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
        )
        .unwrap()
        .to_seed("");
        wallet_core::kaspa_own_keys(&s, Network::Mainnet, 0, KASPA_SCAN_WINDOW).unwrap()
    }

    fn utxo(address: &str, script: &str, txid: &str, amount: &str, coinbase: bool) -> Value {
        json!({
            "address": address,
            "outpoint": { "transactionId": txid, "index": 1 },
            "utxoEntry": {
                "amount": amount,
                "scriptPublicKey": { "scriptPublicKey": script },
                "blockDaaScore": "1000",
                "isCoinbase": coinbase
            }
        })
    }

    #[test]
    fn utxos_must_pay_our_scripts() {
        let k = keys();
        let me = &k[0];
        let script = hex::encode(me.script());
        let txid = "2de30034c236ebc4d0c6beeb8b78add2d39f699fb943f5a132de793f462c3d23";
        let ok = json!([
            utxo(&me.address, &script, txid, "11160106612", false),
            utxo(&me.address, &script, txid, "11160106612", false)
        ]);
        let coins = parse_utxos(&ok, &k).unwrap();
        assert_eq!(coins.len(), 1, "duplicates counted once");
        assert_eq!(coins[0].entry.amount, 11_160_106_612);
        assert_eq!(coins[0].entry.script, me.script());
        // Someone else's address, a script that is not the address's, a malformed coin.
        let other = "kaspa:qr85gz7hvp76mtws6p236uv5xxdk57dzfe4p06ues0rlqhtqy3rtqqx7eeq3u";
        assert!(parse_utxos(&json!([utxo(other, &script, txid, "1", false)]), &k).is_err());
        let wrong = hex::encode(k[1].script());
        assert!(parse_utxos(&json!([utxo(&me.address, &wrong, txid, "1", false)]), &k).is_err());
        assert!(parse_utxos(&json!([utxo(&me.address, &script, "zz", "1", false)]), &k).is_err());
        assert!(parse_utxos(&json!([utxo(&me.address, &script, txid, "-1", false)]), &k).is_err());
        assert!(parse_utxos(&json!([utxo(&me.address, &script, txid, "0", false)]), &k).is_err());
        assert!(parse_utxos(&json!({}), &k).is_err());
        // Coinbase maturity.
        let cb = parse_utxos(&json!([utxo(&me.address, &script, txid, "5", true)]), &k).unwrap();
        assert!(mature(cb.clone(), 2_999).is_empty());
        assert_eq!(mature(cb, 3_000).len(), 1);
    }

    #[test]
    fn balances_count_only_ours_once() {
        let k = keys();
        let v = json!([
            { "address": k[0].address, "balance": 5 },
            { "address": k[0].address, "balance": 5 },
            { "address": k[21].address, "balance": "7" },
            { "address": "kaspa:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkx9awp4e", "balance": 1123066818175821u64 }
        ]);
        assert_eq!(parse_balances(&v, &k).unwrap(), 12);
        assert!(parse_balances(&json!([{ "address": k[0].address, "balance": -1 }]), &k).is_err());
    }

    #[test]
    fn fee_estimate_shapes() {
        let live = json!({"priorityBucket":{"feerate":100,"estimatedSeconds":0.0035},"normalBuckets":[{"feerate":100,"estimatedSeconds":0.0035}],"lowBuckets":[{"feerate":100,"estimatedSeconds":0.0035}]});
        assert_eq!(parse_fee_estimate(&live).unwrap(), 100);
        assert_eq!(
            parse_fee_estimate(&json!({"normalBuckets":[{"feerate":150.2}]})).unwrap(),
            151
        );
        assert!(parse_fee_estimate(&json!({})).is_err());
        assert!(parse_fee_estimate(&json!({"normalBuckets":[{"feerate":-1}]})).is_err());
    }

    /// A public mainnet address (2 coins on 2026-11-01) as if it were ours: watch-only key built
    /// from the address payload.
    fn public_key_of(address: &str) -> KaspaOwnKey {
        let (_, payload) = wallet_core::kaspa_address_decode(Network::Mainnet, address).unwrap();
        KaspaOwnKey {
            change: false,
            index: 0,
            xonly: payload.try_into().unwrap(),
            address: address.to_owned(),
        }
    }

    async fn live_reads(tor: bool) {
        let n = NetClient::new(std::env::temp_dir().join(format!("kyro-kas-live-{tor}"))).unwrap();
        let c = KaspaCtx {
            net_client: &n,
            network: Network::Mainnet,
            tor,
        };
        let k = vec![public_key_of(
            "kaspa:qr85gz7hvp76mtws6p236uv5xxdk57dzfe4p06ues0rlqhtqy3rtqqx7eeq3u",
        )];
        let daa = network_info(&c).await.unwrap();
        assert!(daa > 500_000_000, "virtual DAA score {daa}");
        let balance = balance(&c, &k).await.unwrap();
        let coins = utxos(&c, &k).await.unwrap();
        assert_eq!(coins.iter().map(|c| c.entry.amount).sum::<u64>(), balance);
        assert!(!coins.is_empty());
        let rate = fee_estimate(&c).await.unwrap();
        assert!(rate >= 1, "fee rate {rate}");
        let h = history(&c, &k).await.unwrap();
        assert!(!h.is_empty());
        assert!(h.iter().all(|e| e.txid.len() == 64));
        assert_eq!(tx_status(&c, &"00".repeat(32)).await.unwrap(), None);
        // testnet-10 host answers as testnet-10 (the name is checked on every read).
        let t = KaspaCtx {
            network: Network::Testnet,
            ..c
        };
        assert!(network_info(&t).await.unwrap() > 0);
        assert!(fee_estimate(&t).await.unwrap() >= 1);
    }

    /// Real reads from api.kaspa.org in clear (`cargo test -p kyro … kas_live -- --ignored`).
    #[test]
    #[ignore = "network"]
    fn kas_live_mainnet_reads_clear() {
        tauri::async_runtime::block_on(live_reads(false));
    }

    /// Same reads through the embedded Tor client (`kaspa` family circuits).
    #[test]
    #[ignore = "network (Tor bootstrap)"]
    fn kas_live_mainnet_reads_over_tor() {
        tauri::async_runtime::block_on(live_reads(true));
    }

    #[test]
    fn history_is_seen_from_our_addresses() {
        let k = keys();
        let ours: BTreeSet<&str> = k.iter().map(|x| x.address.as_str()).collect();
        let me = k[0].address.as_str();
        let change = k[20].address.as_str();
        let other = "kaspa:qr85gz7hvp76mtws6p236uv5xxdk57dzfe4p06ues0rlqhtqy3rtqqx7eeq3u";
        let id = "b3f792cef931a80ffd83799272301f9a26e75cd8b9ce21817197ad09a4deb505";
        let sent = json!({
            "transaction_id": id, "block_time": 1793508328612u64, "is_accepted": true,
            "inputs": [{ "previous_outpoint_address": me, "previous_outpoint_amount": 1000 }],
            "outputs": [
                { "amount": 600, "script_public_key_address": other },
                { "amount": 390, "script_public_key_address": change }
            ]
        });
        let n = Network::Mainnet;
        let e = history_entry(&sent, &ours, n).unwrap();
        assert_eq!(e.delta, "-610");
        assert_eq!(e.fee.as_deref(), Some("10"));
        assert_eq!(e.counterparty.as_deref(), Some(other));
        assert!(e.accepted);
        let received = json!({
            "transaction_id": id, "block_time": 1, "is_accepted": false,
            "inputs": [{ "previous_outpoint_address": other, "previous_outpoint_amount": 1000 }],
            "outputs": [{ "amount": 900, "script_public_key_address": me }]
        });
        let e = history_entry(&received, &ours, n).unwrap();
        assert_eq!((e.delta.as_str(), e.fee.as_deref()), ("900", None));
        assert_eq!(e.counterparty.as_deref(), Some(other));
        // A counterparty that is not a valid address of this network is not shown.
        let mut odd = received.clone();
        odd["inputs"][0]["previous_outpoint_address"] = json!("kaspa:\u{202e}evil");
        assert_eq!(history_entry(&odd, &ours, n).unwrap().counterparty, None);
        assert_eq!(
            history_entry(&received, &ours, Network::Testnet)
                .unwrap()
                .counterparty,
            None
        );
        // A transaction that does not touch us is dropped.
        let foreign = json!({
            "transaction_id": id, "inputs": [], "outputs": [{ "amount": 1, "script_public_key_address": other }]
        });
        assert!(history_entry(&foreign, &ours, n).is_none());
        assert!(history_entry(&json!({"transaction_id": "nope"}), &ours, n).is_none());
    }
}
