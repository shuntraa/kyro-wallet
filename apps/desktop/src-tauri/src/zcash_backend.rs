//! Zcash (transparent addresses only) data, from Kyro's default Electrum servers, in **the same
//! Esplora shapes** as the `ltc_*` / `doge_*` commands (docs/IPC.md §2.4), so the TypeScript side
//! reuses the UTXO logic for balances and history.
//!
//! | command               | Electrum calls |
//! |-----------------------|----------------|
//! | `zec_address_info`    | `scripthash.get_balance` + `get_history` |
//! | `zec_address_utxos`   | `scripthash.listunspent`, **each UTXO checked against its previous transaction** (parsed and re-hashed by `zcash_primitives`) |
//! | `zec_address_txs`     | `get_history` + `transaction.get` (+ prevouts) + `block.header` |
//! | `zec_tip_height`      | `headers.subscribe` |
//! | `zec_broadcast`       | `transaction.broadcast` (the returned txid must be ours) |
//! | sending (`zec_send_*`)| `headers.subscribe`, `transaction.id_from_pos` + `transaction.get` of a recent block (**consensus branch id read from the chain**), `transaction.get` of every coin |
//!
//! Servers: mainnet = Komodo Platform's public ElectrumX servers (`net::ELECTRUM_HOSTS`,
//! family `zcash`, TLS validated normally, genesis checked on every session; the second is
//! tried only if the first cannot be reached — same Tor family, never clear when Tor is on).
//! Testnet: no default (no public Zcash testnet Electrum server was found, see
//! docs/NETWORK.md): `zec_*` reads fail with `SERVER_INVALID`.

use std::collections::{HashMap, HashSet};

use serde_json::{json, Value};
use wallet_core::{BtcRawTx, Network, ZecRawTx};

use crate::btc_backend::{esplora_txs, stats_json, Detected};
use crate::electrum::{self, BoxStream, Conn, TlsMode};
use crate::error::{AppError, AppResult};
use crate::net::{electrum_default_allowed, Family, NetClient, ELECTRUM_HOSTS};

/// Most recent transactions returned per address (same cap as the other UTXO chains).
const MAX_TXS: usize = 50;
/// Most UTXOs of one address listed (each one is checked against its previous transaction).
const MAX_UTXOS: usize = 1_000;
/// Electrum requests pipelined per batch.
const CHUNK: usize = 25;
/// Blocks searched below the tip for a transaction that carries the consensus branch id.
const BRANCH_SEARCH_BLOCKS: u32 = 3;
/// Transactions tried per block for it (the coinbase first).
const BRANCH_SEARCH_POSITIONS: u32 = 4;

pub struct ZecCtx<'a> {
    pub net_client: &'a NetClient,
    pub network: Network,
    pub tor: bool,
}

fn bad(msg: impl Into<String>) -> AppError {
    AppError::ServerUnreachable(msg.into())
}

pub fn no_default_server() -> AppError {
    AppError::ServerInvalid(
        "Zcash testnet: no free public server (Kyro found no maintained public Zcash \
         testnet Electrum server). Zcash works on mainnet."
            .into(),
    )
}

/// Kyro's default servers for `net`, in the order they are tried.
pub fn default_targets(net: Network) -> Vec<electrum::Target> {
    match net {
        Network::Mainnet => ELECTRUM_HOSTS
            .iter()
            .filter(|(_, _, f)| *f == Family::Zcash)
            .map(|(host, port, _)| electrum::Target {
                host: (*host).to_owned(),
                port: *port,
                tls: TlsMode::Webpki,
            })
            .collect(),
        Network::Testnet => Vec::new(),
    }
}

/// Host shown to the user, `""` when there is none.
pub fn label(net: Network) -> String {
    default_targets(net)
        .first()
        .map(|t| t.host.clone())
        .unwrap_or_default()
}

/// Opens a session on the first reachable default server (Zcash Tor family) and checks its
/// genesis hash. Only a transport failure moves on to the next server.
pub async fn session(ctx: &ZecCtx<'_>) -> AppResult<Conn<BoxStream>> {
    let targets = default_targets(ctx.network);
    if targets.is_empty() {
        return Err(no_default_server());
    }
    let mut last = None;
    for t in &targets {
        if !electrum_default_allowed(&t.host, t.port, Family::Zcash) {
            return Err(AppError::HostNotAllowed(format!("{}:{}", t.host, t.port)));
        }
        match electrum::connect_family(ctx.net_client, t, ctx.tor, Family::Zcash).await {
            Ok(mut conn) => {
                let features = conn.call("server.features", json!([])).await?;
                check_genesis(ctx.network, &features)?;
                return Ok(conn);
            }
            Err(e @ AppError::ServerUnreachable(_)) => last = Some(e),
            Err(e) => return Err(e),
        }
    }
    Err(last.unwrap_or_else(no_default_server))
}

fn check_genesis(net: Network, features: &Value) -> AppResult<String> {
    let expected = wallet_core::zec_genesis_hash(net);
    let genesis = features
        .get("genesis_hash")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if genesis != expected {
        return Err(AppError::ServerWrongNetwork(format!(
            "the server is not on Zcash {} (genesis {})",
            network_label(net),
            genesis.chars().take(64).collect::<String>()
        )));
    }
    Ok(genesis.to_owned())
}

pub fn network_label(net: Network) -> &'static str {
    match net {
        Network::Mainnet => "mainnet",
        Network::Testnet => "testnet",
    }
}

fn check_address(net: Network, a: &str) -> AppResult<(String, String, String)> {
    let spk = wallet_core::zec_script_pubkey(a, net)?;
    // Only our own kind of address is queried (t1… / t3…, never a TEX form).
    let canonical = wallet_core::zec_address_of_script(&spk, net)
        .ok_or_else(|| AppError::InvalidInput("invalid Zcash address".into()))?;
    if canonical != a.trim() {
        return Err(AppError::InvalidInput(
            "Zcash address: transparent form t1… / t3… expected".into(),
        ));
    }
    Ok((
        canonical,
        wallet_core::btc_scripthash_of_script(&spk),
        hex::encode(&spk),
    ))
}

fn is_txid(t: &str) -> bool {
    t.len() == 64 && t.bytes().all(|b| b.is_ascii_hexdigit())
}

/// `get_history` entries, strictly typed: `(txid, height)`; height ≤ 0 = unconfirmed.
fn parse_history(v: &Value) -> AppResult<Vec<(String, i64)>> {
    let list = v
        .as_array()
        .ok_or_else(|| bad("Zcash: invalid Electrum history"))?;
    let mut out = Vec::with_capacity(list.len());
    let mut seen = HashSet::new();
    for h in list {
        let txid = h
            .get("tx_hash")
            .and_then(Value::as_str)
            .filter(|t| is_txid(t))
            .ok_or_else(|| bad("Zcash: invalid tx_hash"))?
            .to_ascii_lowercase();
        let height = h
            .get("height")
            .and_then(Value::as_i64)
            .ok_or_else(|| bad("Zcash: invalid height"))?;
        if seen.insert(txid.clone()) {
            out.push((txid, height));
        }
    }
    Ok(out)
}

/// A UTXO as the server claims it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ClaimedUtxo {
    txid: String,
    vout: u32,
    value: u64,
    height: i64,
}

fn parse_listunspent(v: &Value) -> AppResult<Vec<ClaimedUtxo>> {
    let list = v
        .as_array()
        .ok_or_else(|| bad("Zcash: invalid listunspent"))?;
    let err = |k: &str| bad(format!("Zcash: listunspent, invalid field \"{k}\""));
    let mut out = Vec::with_capacity(list.len());
    for u in list {
        out.push(ClaimedUtxo {
            txid: u
                .get("tx_hash")
                .and_then(Value::as_str)
                .filter(|t| is_txid(t))
                .ok_or_else(|| err("tx_hash"))?
                .to_ascii_lowercase(),
            vout: u
                .get("tx_pos")
                .and_then(Value::as_u64)
                .and_then(|v| u32::try_from(v).ok())
                .ok_or_else(|| err("tx_pos"))?,
            value: u
                .get("value")
                .and_then(Value::as_u64)
                .ok_or_else(|| err("value"))?,
            height: u
                .get("height")
                .and_then(Value::as_i64)
                .ok_or_else(|| err("height"))?,
        });
    }
    Ok(out)
}

/// Decodes a raw transaction from the server; it must parse and hash to `txid`.
fn verified_raw(net: Network, txid: &str, raw: &Value) -> AppResult<(ZecRawTx, String)> {
    let hex_tx = raw
        .as_str()
        .ok_or_else(|| bad("Zcash: non-hexadecimal transaction"))?;
    let tx = wallet_core::zec_decode_raw_tx(hex_tx, net)
        .map_err(|_| bad(format!("Zcash: unreadable transaction {txid}")))?;
    if tx.txid != txid {
        return Err(bad(format!(
            "Zcash: the server returned a transaction different from {txid}"
        )));
    }
    Ok((tx, hex_tx.trim().to_owned()))
}

type Raws = HashMap<String, (ZecRawTx, String)>;

/// Fetches and verifies `txids` (chunked batches), skipping those already in `raws`.
async fn fetch_raws(
    net: Network,
    conn: &mut Conn<BoxStream>,
    txids: impl IntoIterator<Item = String>,
    raws: &mut Raws,
) -> AppResult<()> {
    let mut want: Vec<String> = txids
        .into_iter()
        .filter(|t| !raws.contains_key(t))
        .collect();
    want.sort();
    want.dedup();
    for chunk in want.chunks(CHUNK) {
        let calls: Vec<(&str, Value)> = chunk
            .iter()
            .map(|t| ("blockchain.transaction.get", json!([t, false])))
            .collect();
        let res = conn.batch(&calls).await?;
        for (txid, raw) in chunk.iter().zip(res) {
            raws.insert(txid.clone(), verified_raw(net, txid, &raw)?);
        }
    }
    Ok(())
}

/// Checks each claimed UTXO against its (verified) previous transaction: the output must exist,
/// pay **our** script and hold exactly the claimed amount; any mismatch rejects the whole list.
fn verified_utxos(claimed: &[ClaimedUtxo], raws: &Raws, our_spk: &str) -> AppResult<Value> {
    let mut out = Vec::with_capacity(claimed.len());
    for u in claimed {
        let (tx, _) = raws
            .get(&u.txid)
            .ok_or_else(|| bad(format!("Zcash: previous transaction {} not found", u.txid)))?;
        let (_, value, spk) = tx.outputs.get(u.vout as usize).ok_or_else(|| {
            bad(format!(
                "Zcash: the server reports an output {}:{} that does not exist",
                u.txid, u.vout
            ))
        })?;
        if spk != our_spk {
            return Err(bad(format!(
                "Zcash: the reported output {}:{} does not pay this address",
                u.txid, u.vout
            )));
        }
        if *value != u.value {
            return Err(bad(format!(
                "Zcash: the server reports {} for {}:{}, the transaction says {value}",
                u.value, u.txid, u.vout
            )));
        }
        let mut status = json!({ "confirmed": u.height > 0 });
        if u.height > 0 {
            status["block_height"] = json!(u.height);
        }
        out.push(
            json!({ "txid": u.txid, "vout": u.vout, "value": value, "status": status,
                         "coinbase": tx.coinbase }),
        );
    }
    Ok(Value::Array(out))
}

/// Keeps the history entries that really involve `our_spk`.
fn involving(order: Vec<(String, i64)>, raws: &Raws, our_spk: &str) -> Vec<(String, i64)> {
    order
        .into_iter()
        .filter(|(txid, _)| {
            raws.get(txid).is_some_and(|(tx, _)| {
                tx.outputs.iter().any(|o| o.2 == our_spk)
                    || tx.inputs.iter().any(|(p, v)| {
                        raws.get(p)
                            .and_then(|(p, _)| p.outputs.get(*v as usize))
                            .is_some_and(|o| o.2 == our_spk)
                    })
            })
        })
        .collect()
}

/// Block time of a Zcash block header (hex): version 4, previous hash 32, merkle root 32,
/// block commitments 32, then `nTime` (bytes 100..104, little-endian).
fn zec_header_time(header_hex: &str) -> Option<u64> {
    let raw = hex::decode(header_hex).ok()?;
    let t: [u8; 4] = raw.get(100..104)?.try_into().ok()?;
    Some(u64::from(u32::from_le_bytes(t)))
}

fn as_btc(tx: &ZecRawTx) -> BtcRawTx {
    BtcRawTx {
        txid: tx.txid.clone(),
        inputs: tx.inputs.clone(),
        outputs: tx.outputs.clone(),
    }
}

/// Esplora-shaped history. A transaction with shielded parts has no transparent "fee" (value
/// also moved to or from the shielded pools): it is marked `shielded: true`, without `fee`.
fn history_json(order: &[(String, i64)], raws: &Raws, times: &HashMap<i64, u64>) -> Vec<Value> {
    let btc: HashMap<String, BtcRawTx> = raws
        .iter()
        .map(|(k, (tx, _))| (k.clone(), as_btc(tx)))
        .collect();
    let mut out = esplora_txs(order, &btc, times);
    for item in &mut out {
        let shielded = item["txid"]
            .as_str()
            .and_then(|t| raws.get(t))
            .is_some_and(|(tx, _)| tx.shielded);
        if shielded {
            if let Some(o) = item.as_object_mut() {
                o.remove("fee");
                o.insert("shielded".into(), json!(true));
            }
        }
    }
    out
}

// ---------------------------------------------------------------- public API

/// `GET /address/{a}` shape (net balance in `funded_txo_sum`/`spent_txo_sum`).
pub async fn address_info(ctx: &ZecCtx<'_>, address: &str) -> AppResult<Value> {
    let (a, sh, _) = check_address(ctx.network, address)?;
    let mut conn = session(ctx).await?;
    let r = conn
        .batch(&[
            ("blockchain.scripthash.get_balance", json!([sh])),
            ("blockchain.scripthash.get_history", json!([sh])),
        ])
        .await?;
    electrum_info(&a, &r[0], &r[1])
}

fn electrum_info(address: &str, balance: &Value, history: &Value) -> AppResult<Value> {
    let field = |k: &str| {
        balance
            .get(k)
            .and_then(Value::as_i64)
            .ok_or_else(|| bad(format!("Zcash: invalid Electrum balance ({k})")))
    };
    let (confirmed, unconfirmed) = (field("confirmed")?, field("unconfirmed")?);
    if confirmed < 0 {
        return Err(bad("Zcash: negative confirmed balance"));
    }
    let history = parse_history(history)?;
    let conf = history.iter().filter(|(_, h)| *h > 0).count();
    Ok(stats_json(
        address,
        confirmed,
        unconfirmed,
        conf,
        history.len() - conf,
    ))
}

/// `GET /address/{a}/utxo` shape, every UTXO checked against its full previous transaction.
pub async fn address_utxos(ctx: &ZecCtx<'_>, address: &str) -> AppResult<Value> {
    let (a, sh, spk) = check_address(ctx.network, address)?;
    let mut conn = session(ctx).await?;
    let list = conn
        .call("blockchain.scripthash.listunspent", json!([sh]))
        .await?;
    let claimed = parse_listunspent(&list)?;
    if claimed.len() > MAX_UTXOS {
        return Err(AppError::InvalidInput(format!(
            "Zcash: more than {MAX_UTXOS} coins on {a} — Kyro checks each one"
        )));
    }
    let mut raws = HashMap::new();
    fetch_raws(
        ctx.network,
        &mut conn,
        claimed.iter().map(|u| u.txid.clone()),
        &mut raws,
    )
    .await?;
    verified_utxos(&claimed, &raws, &spk)
}

/// `GET /address/{a}/txs` shape: unconfirmed first, then newest confirmed, 50 at most.
pub async fn address_txs(ctx: &ZecCtx<'_>, address: &str) -> AppResult<Value> {
    let (_, sh, spk) = check_address(ctx.network, address)?;
    let mut conn = session(ctx).await?;
    let hist = conn
        .call("blockchain.scripthash.get_history", json!([sh]))
        .await?;
    let mut order = parse_history(&hist)?;
    order.sort_by_key(|(_, h)| if *h > 0 { -*h } else { i64::MIN });
    order.truncate(MAX_TXS);
    let mut raws = HashMap::new();
    fetch_raws(
        ctx.network,
        &mut conn,
        order.iter().map(|(t, _)| t.clone()),
        &mut raws,
    )
    .await?;
    let prevs: Vec<String> = order
        .iter()
        .filter_map(|(t, _)| raws.get(t))
        .flat_map(|(tx, _)| tx.inputs.iter().map(|(p, _)| p.clone()))
        .collect();
    fetch_raws(ctx.network, &mut conn, prevs, &mut raws).await?;
    let order = involving(order, &raws, &spk);
    let heights: Vec<i64> = order
        .iter()
        .map(|(_, h)| *h)
        .filter(|h| *h > 0)
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let mut times = HashMap::new();
    for chunk in heights.chunks(CHUNK) {
        let calls: Vec<(&str, Value)> = chunk
            .iter()
            .map(|h| ("blockchain.block.header", json!([h])))
            .collect();
        for (h, hex) in chunk.iter().zip(conn.batch(&calls).await?) {
            if let Some(t) = hex.as_str().and_then(zec_header_time) {
                times.insert(*h, t);
            }
        }
    }
    Ok(Value::Array(history_json(&order, &raws, &times)))
}

async fn tip(conn: &mut Conn<BoxStream>) -> AppResult<u32> {
    let r = conn.call("blockchain.headers.subscribe", json!([])).await?;
    r.get("height")
        .and_then(Value::as_u64)
        .and_then(|h| u32::try_from(h).ok())
        .ok_or_else(|| bad("Zcash: invalid height"))
}

/// Chain tip height.
pub async fn tip_height(ctx: &ZecCtx<'_>) -> AppResult<u64> {
    let mut conn = session(ctx).await?;
    Ok(u64::from(tip(&mut conn).await?))
}

/// What a send needs from the chain: the tip, and the consensus branch id written in a recent
/// v5+ transaction (`(height, branch id)`), read **from the network** so that a network upgrade
/// this build does not know is detected (wallet-core refuses to sign then).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChainState {
    pub tip: u32,
    pub branch_height: u32,
    pub branch_id: u32,
}

pub async fn chain_state(conn: &mut Conn<BoxStream>) -> AppResult<ChainState> {
    let tip = tip(conn).await?;
    for height in (tip.saturating_sub(BRANCH_SEARCH_BLOCKS - 1)..=tip).rev() {
        for pos in 0..BRANCH_SEARCH_POSITIONS {
            // An error is "no transaction at this position": next block.
            let Ok(txid) = conn
                .call("blockchain.transaction.id_from_pos", json!([height, pos]))
                .await
            else {
                break;
            };
            let txid = txid
                .as_str()
                .filter(|t| is_txid(t))
                .ok_or_else(|| bad("Zcash: invalid id_from_pos"))?
                .to_ascii_lowercase();
            let raw = conn
                .call("blockchain.transaction.get", json!([txid, false]))
                .await?;
            let bytes = raw
                .as_str()
                .and_then(|h| hex::decode(h.trim()).ok())
                .ok_or_else(|| bad("Zcash: non-hexadecimal transaction"))?;
            if let Some(branch_id) = wallet_core::zec_header_branch_id(&bytes) {
                return Ok(ChainState {
                    tip,
                    branch_height: height,
                    branch_id,
                });
            }
        }
    }
    Err(bad(
        "Zcash: no recent transaction gives the current network upgrade (branch id)",
    ))
}

/// Full previous transactions of `txids` (hex), each one parsed and re-hashed.
pub async fn prev_txs(
    net: Network,
    conn: &mut Conn<BoxStream>,
    txids: &[String],
) -> AppResult<HashMap<String, String>> {
    for t in txids {
        if !is_txid(t) {
            return Err(AppError::InvalidInput(
                "txid: 64 hexadecimal characters".into(),
            ));
        }
    }
    let mut raws = HashMap::new();
    fetch_raws(
        net,
        conn,
        txids.iter().map(|t| t.to_ascii_lowercase()),
        &mut raws,
    )
    .await?;
    Ok(raws.into_iter().map(|(k, (_, hex))| (k, hex)).collect())
}

/// Broadcast → txid. The transaction is decoded first and the server's txid must equal ours.
pub async fn broadcast(ctx: &ZecCtx<'_>, hex_tx: &str) -> AppResult<String> {
    let decoded = wallet_core::zec_decode_raw_tx(hex_tx, ctx.network)?;
    if decoded.shielded {
        return Err(AppError::InvalidInput(
            "Zcash: Kyro only broadcasts transparent transactions".into(),
        ));
    }
    let mut conn = session(ctx).await?;
    let r = conn
        .call("blockchain.transaction.broadcast", json!([hex_tx.trim()]))
        .await?;
    check_broadcast_txid(r.as_str().unwrap_or_default(), &decoded.txid)
}

fn check_broadcast_txid(answer: &str, ours: &str) -> AppResult<String> {
    if answer.trim() != ours {
        return Err(bad(format!(
            "the server returned an unexpected txid ({})",
            answer.chars().take(80).collect::<String>()
        )));
    }
    Ok(ours.to_owned())
}

/// Connection test: genesis, version, height. Not wired yet (no custom Zcash server in Réglages).
#[allow(dead_code)]
pub async fn probe(ctx: &ZecCtx<'_>) -> AppResult<Detected> {
    let mut conn = session(ctx).await?;
    let r = conn
        .batch(&[
            ("server.features", json!([])),
            ("blockchain.headers.subscribe", json!([])),
        ])
        .await?;
    Ok(Detected {
        network: Some(network_label(ctx.network).into()),
        genesis_hash: Some(check_genesis(ctx.network, &r[0])?),
        server_version: r[0]
            .get("server_version")
            .and_then(Value::as_str)
            .map(str::to_owned),
        block_height: r[1].get("height").and_then(Value::as_u64),
        ..Default::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Real, read-only answers of `zec.electrum1.cipig.net:20058` (ElectrumX 2.0.0), recorded
    /// 2026-11-01 (`server.features`, `headers.subscribe`, a v5 transparent transaction and its
    /// previous transaction, the tip coinbase, `get_balance` / `get_history` / `listunspent` /
    /// `transaction.get` / `block.header` for the address it pays). Nothing was broadcast.
    const RECORDED: &str = include_str!("testdata/zec_electrum_mainnet.json");

    fn recorded() -> (Value, Raws) {
        let v: Value = serde_json::from_str(RECORDED).unwrap();
        let mut raws = HashMap::new();
        for (txid, raw) in v["transactions"].as_object().unwrap() {
            raws.insert(
                txid.clone(),
                verified_raw(Network::Mainnet, txid, raw).unwrap(),
            );
        }
        for (txid, raw) in v["prev_txs"].as_object().unwrap() {
            raws.insert(
                txid.clone(),
                verified_raw(Network::Mainnet, txid, raw).unwrap(),
            );
        }
        (v, raws)
    }

    #[test]
    fn default_servers() {
        let t = default_targets(Network::Mainnet);
        assert_eq!(
            t.iter()
                .map(|t| (t.host.as_str(), t.port))
                .collect::<Vec<_>>(),
            vec![
                ("zec.electrum1.cipig.net", 20058),
                ("zec.electrum2.cipig.net", 20058)
            ]
        );
        assert!(t.iter().all(|t| t.tls == TlsMode::Webpki
            && electrum_default_allowed(&t.host, t.port, Family::Zcash)));
        // Not reachable as another family, nor on another port.
        assert!(!electrum_default_allowed(
            "zec.electrum1.cipig.net",
            20058,
            Family::Dogecoin
        ));
        assert!(!electrum_default_allowed(
            "zec.electrum1.cipig.net",
            10058,
            Family::Zcash
        ));
        assert_eq!(label(Network::Mainnet), "zec.electrum1.cipig.net");
        // Testnet: no default, a typed error.
        assert!(default_targets(Network::Testnet).is_empty());
        assert!(matches!(no_default_server(), AppError::ServerInvalid(_)));
        let n = NetClient::new(std::env::temp_dir().join("kyro-zec-test")).unwrap();
        let c = ZecCtx {
            net_client: &n,
            network: Network::Testnet,
            tor: true,
        };
        let tm = wallet_core::zec_address_of_script(
            &hex::decode(format!("76a914{}88ac", "00".repeat(20))).unwrap(),
            Network::Testnet,
        )
        .unwrap();
        let e = tauri::async_runtime::block_on(address_info(&c, &tm));
        assert!(matches!(e, Err(AppError::ServerInvalid(_))), "{e:?}");
    }

    #[test]
    fn addresses_are_checked_before_any_request() {
        let n = NetClient::new(std::env::temp_dir().join("kyro-zec-test2")).unwrap();
        let c = ZecCtx {
            net_client: &n,
            network: Network::Mainnet,
            tor: true,
        };
        tauri::async_runtime::block_on(async {
            for a in [
                // Sapling, unified, testnet, Bitcoin, a path injection, a TEX form.
                "zs1z7rejlpsa98s2rrrfkwmaxu53e4ue0ulcrw0h4x5g8jl04tak0d3mm47vdtahatqrlkngh9sly",
                "u1l8xunezsvhq8fgzfl7404m450nwnd76zshscn6nfys7vyz2ywyh4cc5daaq0c7q2su5lqfh23sp7fkf3kt27ve5948mzpfdvckzaect2jtte308mkwlycj2u0eac077wu70vqcetkxf",
                "tmBsTi2xWTjUdEXnuTceL7fecEQKeWaPDJd",
                "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2",
                "../../x",
                "tex1s2rt77ggv6q989lr49rkgzmh5slsksa9khdgte",
            ] {
                assert!(
                    matches!(address_info(&c, a).await, Err(AppError::InvalidInput(_))),
                    "{a}"
                );
            }
            assert!(matches!(
                broadcast(&c, "00").await,
                Err(AppError::InvalidInput(_))
            ));
        });
    }

    #[test]
    fn recorded_mainnet_identity_balance_and_utxos() {
        let (v, raws) = recorded();
        assert_eq!(
            check_genesis(Network::Mainnet, &v["server.features"]).unwrap(),
            wallet_core::zec_genesis_hash(Network::Mainnet)
        );
        assert!(matches!(
            check_genesis(Network::Testnet, &v["server.features"]),
            Err(AppError::ServerWrongNetwork(_))
        ));
        let spk = v["address_script"].as_str().unwrap();
        let addr = wallet_core::zec_address_of_script(&hex::decode(spk).unwrap(), Network::Mainnet)
            .unwrap();
        let (a, sh, s) = check_address(Network::Mainnet, &addr).unwrap();
        assert_eq!(
            (a.as_str(), sh.as_str(), s.as_str()),
            (addr.as_str(), v["scripthash"].as_str().unwrap(), spk)
        );

        let info = electrum_info(&addr, &v["get_balance"], &v["get_history"]).unwrap();
        let bal = v["get_balance"]["confirmed"].as_i64().unwrap();
        assert_eq!(info["chain_stats"]["funded_txo_sum"], bal);
        assert_eq!(
            info["chain_stats"]["tx_count"],
            v["get_history"].as_array().unwrap().len()
        );

        let claimed = parse_listunspent(&v["listunspent"]).unwrap();
        let ok = verified_utxos(&claimed, &raws, spk).unwrap();
        assert_eq!(ok.as_array().unwrap().len(), claimed.len());
        assert_eq!(ok[0]["value"].as_u64().unwrap(), claimed[0].value);
        assert_eq!(ok[0]["coinbase"], false);
        // A server lying about the amount, the output or the script: refused.
        let mut lie = claimed.clone();
        lie[0].value += 1;
        assert!(verified_utxos(&lie, &raws, spk).is_err());
        let mut lie = claimed.clone();
        lie[0].vout = 7;
        assert!(verified_utxos(&lie, &raws, spk).is_err());
        assert!(verified_utxos(&claimed, &raws, "76a914").is_err());
        // A transaction returned under another txid: refused before it can feed anything.
        let other = v["prev_txs"].as_object().unwrap().values().next().unwrap();
        assert!(verified_raw(Network::Mainnet, &claimed[0].txid, other).is_err());
        assert!(parse_listunspent(
            &json!([{ "tx_hash": "x", "tx_pos": 0, "value": 1, "height": 1 }])
        )
        .is_err());
        assert!(parse_listunspent(
            &json!([{ "tx_hash": claimed[0].txid, "tx_pos": 0, "value": 1.5, "height": 1 }])
        )
        .is_err());
    }

    #[test]
    fn recorded_mainnet_history() {
        let (v, raws) = recorded();
        let spk = v["address_script"].as_str().unwrap();
        let order = parse_history(&v["get_history"]).unwrap();
        let mut injected = order.clone();
        let prev = v["prev_txs"]
            .as_object()
            .unwrap()
            .keys()
            .next()
            .unwrap()
            .clone();
        injected.push((prev, 1));
        let kept = involving(injected, &raws, spk);
        assert_eq!(
            kept, order,
            "a transaction that does not touch the address is dropped"
        );
        let times: HashMap<i64, u64> = v["headers"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(h, hex)| {
                (
                    h.parse().unwrap(),
                    zec_header_time(hex.as_str().unwrap()).unwrap(),
                )
            })
            .collect();
        // Zcash headers: nTime at bytes 100..104 (2026-11-01 ≈ 1.79e9).
        assert!(
            times
                .values()
                .all(|t| (1_790_000_000..1_800_000_000).contains(t)),
            "{times:?}"
        );
        let txs = history_json(&kept, &raws, &times);
        assert_eq!(txs.len(), order.len());
        let t = &txs[0];
        assert_eq!(t["txid"], order[0].0);
        assert!(t["vout"]
            .as_array()
            .unwrap()
            .iter()
            .any(|o| o["scriptpubkey"] == spk));
        assert!(t["fee"].as_u64().unwrap() > 0, "transparent fee shown");
        assert!(t.get("shielded").is_none());
        assert!(t["status"]["block_time"].as_u64().is_some());
    }

    #[test]
    fn recorded_branch_id_and_broadcast_check() {
        let (v, _) = recorded();
        let cb = hex::decode(v["tip_coinbase"]["hex"].as_str().unwrap()).unwrap();
        // NU6.3 (0x37a5165b) on mainnet at the recorded tip.
        assert_eq!(wallet_core::zec_header_branch_id(&cb), Some(0x37a5_165b));
        let tip = u32::try_from(v["tip"]["height"].as_u64().unwrap()).unwrap();
        let c = wallet_core::zec_consensus(Network::Mainnet, tip, tip, 0x37a5_165b).unwrap();
        assert_eq!(c.upgrade, "NU6.3");
        assert_eq!(c.target_height, tip + 1);
        let t = "09062ef6f449e49f025c7b7c61badfccd652872bbf20ea5b861a7645d238b300";
        assert_eq!(check_broadcast_txid(&format!("{t}\n"), t).unwrap(), t);
        assert!(check_broadcast_txid(&"0".repeat(64), t).is_err());
    }
}
