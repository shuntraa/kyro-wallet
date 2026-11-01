//! Bitcoin data from the server the user chose (`settings.servers.bitcoin`), always returned in
//! **Esplora shapes**, so the TypeScript adapter is backend-agnostic:
//!
//! | command               | Esplora equivalent                 |
//! |-----------------------|------------------------------------|
//! | `btc_address_info`    | `GET /address/{a}`                 |
//! | `btc_address_utxos`   | `GET /address/{a}/utxo`            |
//! | `btc_address_txs`     | `GET /address/{a}/txs`             |
//! | `btc_fee_rates`       | `GET /v1/fees/recommended` (mempool) |
//! | `btc_tip_height`      | `GET /blocks/tip/height`           |
//! | `btc_broadcast`       | `POST /tx`                         |
//!
//! There is never a fallback: if the chosen server fails, the command fails
//! (`SERVER_UNREACHABLE`, `TOR_UNAVAILABLE`, ...).

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use serde::Serialize;
use serde_json::{json, Value};
use wallet_core::Network;

use crate::core_rpc::{self, btc_per_kvb_to_sat_per_vb, btc_to_sats, CallError, CoreClient};
use crate::electrum::{self, TlsMode};
use crate::error::{AppError, AppResult};
use crate::net::{Family, Method, NetClient, ServerRequest};
use crate::servers::{validate_http_url, BtcServer, CoreAuth};

const MAX_TXS: usize = 50;

pub fn esplora_default_base(net: Network) -> &'static str {
    match net {
        Network::Mainnet => "https://mempool.space/api",
        Network::Testnet => "https://mempool.space/testnet4/api",
    }
}

/// Everything a backend call needs, captured from the app state at call time.
pub struct Ctx<'a> {
    pub net_client: &'a NetClient,
    pub network: Network,
    pub tor: bool,
    pub server: BtcServer,
    /// Master fingerprint (8 hex), only needed for Bitcoin Core (`kyro-watch-<fp>`).
    pub fingerprint: Option<String>,
}

fn bad(msg: impl Into<String>) -> AppError {
    AppError::ServerUnreachable(msg.into())
}

async fn esplora_get(ctx: &Ctx<'_>, base: &str, path: &str) -> AppResult<Vec<u8>> {
    let url = url::Url::parse(&format!("{}{path}", base.trim_end_matches('/')))
        .map_err(|_| AppError::ServerInvalid("invalid Esplora URL".into()))?;
    let (status, body) = ctx
        .net_client
        .server_request(ServerRequest::get(url, Family::Bitcoin), ctx.tor)
        .await?;
    if status != 200 {
        return Err(bad(format!(
            "Esplora: HTTP {status} on {path} ({})",
            String::from_utf8_lossy(&body)
                .chars()
                .take(200)
                .collect::<String>()
        )));
    }
    Ok(body)
}

async fn esplora_json(ctx: &Ctx<'_>, base: &str, path: &str) -> AppResult<Value> {
    serde_json::from_slice(&esplora_get(ctx, base, path).await?)
        .map_err(|_| bad(format!("Esplora: invalid JSON on {path}")))
}

fn esplora_base(ctx: &Ctx<'_>) -> AppResult<Option<String>> {
    Ok(match &ctx.server {
        BtcServer::Default => Some(esplora_default_base(ctx.network).to_owned()),
        BtcServer::Esplora { url } => {
            validate_http_url(url, ctx.tor, false)?;
            Some(url.clone())
        }
        _ => None,
    })
}

fn check_address(a: &str, net: Network) -> AppResult<()> {
    wallet_core::btc_script_pubkey(a, net)
        .map(|_| ())
        .map_err(AppError::from)
}

const ESPLORA_CHAIN_PAGE: usize = 25;

/// Unconfirmed first, then confirmed newest first, at most `max`, following Esplora's
/// pagination (`fetch_after(last confirmed txid)` returns the next confirmed page).
pub async fn paginate_esplora<F, Fut>(
    first: Vec<Value>,
    max: usize,
    mut fetch_after: F,
) -> AppResult<Vec<Value>>
where
    F: FnMut(String) -> Fut,
    Fut: std::future::Future<Output = AppResult<Vec<Value>>>,
{
    let confirmed = |t: &Value| t["status"]["confirmed"] == true;
    let mut out: Vec<Value> = first.iter().filter(|t| !confirmed(t)).cloned().collect();
    let mut page: Vec<Value> = first.into_iter().filter(confirmed).collect();
    let mut seen = HashSet::new();
    for t in &out {
        seen.insert(t["txid"].as_str().unwrap_or_default().to_owned());
    }
    loop {
        let full = page.len() >= ESPLORA_CHAIN_PAGE;
        let last = page
            .last()
            .and_then(|t| t["txid"].as_str())
            .map(str::to_owned);
        let before = out.len();
        for t in page {
            if seen.insert(t["txid"].as_str().unwrap_or_default().to_owned()) {
                out.push(t);
            }
        }
        if out.len() >= max || !full || out.len() == before {
            break;
        }
        let Some(last) = last else { break };
        page = fetch_after(last).await?;
        if page.is_empty() {
            break;
        }
    }
    out.truncate(max);
    Ok(out)
}

pub(crate) fn fees_from_estimates(est: &Value) -> Value {
    let at = |n: &str| {
        est.get(n)
            .and_then(Value::as_f64)
            .map(|f| f.ceil().max(1.0) as u64)
    };
    let fastest = at("1").or(at("2")).unwrap_or(1);
    let half = at("3").unwrap_or(fastest);
    let hour = at("6").unwrap_or(half);
    let economy = at("25").or(at("144")).unwrap_or(hour);
    json!({ "fastestFee": fastest, "halfHourFee": half, "hourFee": hour,
            "economyFee": economy, "minimumFee": 1 })
}

fn electrum_target(server: &BtcServer) -> AppResult<Option<electrum::Target>> {
    Ok(match server {
        BtcServer::Electrum {
            host,
            port,
            tls,
            cert_sha256,
        } => Some(electrum::Target {
            host: host.trim().to_owned(),
            port: *port,
            tls: TlsMode::from_settings(*tls, cert_sha256.as_deref())?,
        }),
        _ => None,
    })
}

fn str_field<'v>(v: &'v Value, k: &str) -> AppResult<&'v str> {
    v.get(k)
        .and_then(Value::as_str)
        .ok_or_else(|| bad(format!("Electrum: missing field \"{k}\"")))
}

fn u64_field(v: &Value, k: &str) -> AppResult<u64> {
    v.get(k)
        .and_then(Value::as_u64)
        .ok_or_else(|| bad(format!("Electrum: missing field \"{k}\"")))
}

/// Block timestamp from an 80-byte header (hex): bytes 68..72, little-endian.
pub fn header_time(header_hex: &str) -> Option<u64> {
    let raw = hex::decode(header_hex).ok()?;
    let t: [u8; 4] = raw.get(68..72)?.try_into().ok()?;
    Some(u64::from(u32::from_le_bytes(t)))
}

/// Builds Esplora-shaped transactions from raw transactions plus their prevouts.
pub fn esplora_txs(
    order: &[(String, i64)],
    raws: &HashMap<String, wallet_core::BtcRawTx>,
    times: &HashMap<i64, u64>,
) -> Vec<Value> {
    let mut out = Vec::with_capacity(order.len());
    for (txid, height) in order {
        let Some(tx) = raws.get(txid) else { continue };
        let mut total_in: Option<u64> = Some(0);
        let vin: Vec<Value> = tx
            .inputs
            .iter()
            .map(|(prev, vout)| {
                let prevout = raws.get(prev).and_then(|p| p.outputs.get(*vout as usize));
                total_in = match (total_in, prevout) {
                    (Some(t), Some(o)) => t.checked_add(o.1),
                    _ => None,
                };
                json!({
                    "txid": prev,
                    "vout": vout,
                    "prevout": prevout.map(|(addr, value, spk)| json!({
                        "scriptpubkey": spk, "scriptpubkey_address": addr, "value": value })),
                })
            })
            .collect();
        let vout: Vec<Value> = tx
            .outputs
            .iter()
            .map(|(addr, value, spk)| json!({ "scriptpubkey": spk, "scriptpubkey_address": addr, "value": value }))
            .collect();
        let total_out: u64 = tx.outputs.iter().map(|o| o.1).sum();
        let confirmed = *height > 0;
        let mut status = json!({ "confirmed": confirmed });
        if confirmed {
            status["block_height"] = json!(height);
            if let Some(t) = times.get(height) {
                status["block_time"] = json!(t);
            }
        }
        let mut item = json!({ "txid": txid, "status": status, "vin": vin, "vout": vout });
        if !tx.inputs.is_empty() {
            if let Some(fee) = total_in.and_then(|i| i.checked_sub(total_out)) {
                item["fee"] = json!(fee);
            }
        }
        out.push(item);
    }
    out
}

async fn electrum_raw_with_prevouts(
    conn: &mut electrum::Conn<electrum::BoxStream>,
    txids: &[String],
    net: Network,
) -> AppResult<HashMap<String, wallet_core::BtcRawTx>> {
    let mut raws = HashMap::new();
    let mut want: Vec<String> = txids.to_vec();
    for _round in 0..2 {
        want.retain(|t| !raws.contains_key(t));
        want.sort();
        want.dedup();
        if want.is_empty() {
            break;
        }
        let calls: Vec<(&str, Value)> = want
            .iter()
            .map(|t| ("blockchain.transaction.get", json!([t, false])))
            .collect();
        let res = conn.batch(&calls).await?;
        for (txid, hex) in want.iter().zip(res) {
            let hex = hex
                .as_str()
                .ok_or_else(|| bad("Electrum: non-hexadecimal transaction"))?;
            let tx = wallet_core::btc_decode_raw_tx(hex, net)?;
            if &tx.txid != txid {
                return Err(bad(
                    "Electrum: transaction different from the one requested",
                ));
            }
            raws.insert(txid.clone(), tx);
        }
        want = txids
            .iter()
            .filter_map(|t| raws.get(t))
            .flat_map(|tx| tx.inputs.iter().map(|(p, _)| p.clone()))
            .collect();
    }
    Ok(raws)
}

fn core_client<'a>(ctx: &'a Ctx<'_>) -> AppResult<Option<(CoreClient<'a>, String)>> {
    let BtcServer::Core { url, auth } = &ctx.server else {
        return Ok(None);
    };
    let fp = ctx.fingerprint.as_deref().ok_or(AppError::Locked)?;
    Ok(Some((
        CoreClient::new(ctx.net_client, url, auth, ctx.tor)?,
        core_rpc::wallet_name(fp),
    )))
}

async fn core_wallet(c: &CoreClient<'_>, name: &str) -> AppResult<()> {
    if c.ensure_loaded(name).await? {
        Ok(())
    } else {
        Err(AppError::ServerInvalid(format!(
            "watch-only wallet \"{name}\" missing on the node: run the setup (btc_core_setup)"
        )))
    }
}

async fn core_call(c: &CoreClient<'_>, w: &str, method: &str, params: Value) -> AppResult<Value> {
    c.call(Some(w), method, params, false)
        .await
        .map_err(AppError::from)
}

async fn core_raw(
    c: &CoreClient<'_>,
    w: &str,
    txid: &str,
    net: Network,
    cache: &mut HashMap<String, Option<wallet_core::BtcRawTx>>,
) -> AppResult<Option<wallet_core::BtcRawTx>> {
    if let Some(hit) = cache.get(txid) {
        return Ok(hit.clone());
    }
    let tx = match c
        .call(Some(w), "gettransaction", json!([txid, true]), false)
        .await
    {
        Ok(v) => {
            let hex = v
                .get("hex")
                .and_then(Value::as_str)
                .ok_or_else(|| bad("gettransaction: missing hex"))?;
            Some(wallet_core::btc_decode_raw_tx(hex, net)?)
        }
        Err(CallError::Rpc(r)) if r.code == -5 => None,
        Err(e) => return Err(e.into()),
    };
    cache.insert(txid.to_owned(), tx.clone());
    Ok(tx)
}

/// `GET /address/{a}` shape: `{ address, chain_stats, mempool_stats }`.
pub async fn address_info(ctx: &Ctx<'_>, address: &str) -> AppResult<Value> {
    check_address(address, ctx.network)?;
    if let Some(base) = esplora_base(ctx)? {
        return esplora_json(ctx, &base, &format!("/address/{address}")).await;
    }
    if let Some(t) = electrum_target(&ctx.server)? {
        let sh = wallet_core::btc_scripthash(address, ctx.network)?;
        let mut conn = electrum::connect(ctx.net_client, &t, ctx.tor).await?;
        let r = conn
            .batch(&[
                ("blockchain.scripthash.get_balance", json!([sh])),
                ("blockchain.scripthash.get_history", json!([sh])),
            ])
            .await?;
        let confirmed = r[0].get("confirmed").and_then(Value::as_i64).unwrap_or(0);
        let unconfirmed = r[0].get("unconfirmed").and_then(Value::as_i64).unwrap_or(0);
        let history = r[1].as_array().cloned().unwrap_or_default();
        let conf_count = history
            .iter()
            .filter(|h| h.get("height").and_then(Value::as_i64).unwrap_or(0) > 0)
            .count();
        let mempool_count = history.len() - conf_count;
        return Ok(stats_json(
            address,
            confirmed,
            unconfirmed,
            conf_count,
            mempool_count,
        ));
    }
    if let Some((c, w)) = core_client(ctx)? {
        core_wallet(&c, &w).await?;
        let utxos = core_call(
            &c,
            &w,
            "listunspent",
            json!([0, 9_999_999, [address], true]),
        )
        .await?;
        let (mut confirmed, mut unconfirmed) = (0i64, 0i64);
        for u in utxos.as_array().into_iter().flatten() {
            let v = i64::try_from(btc_to_sats(&u["amount"])?).unwrap_or(i64::MAX);
            if u.get("confirmations").and_then(Value::as_u64).unwrap_or(0) > 0 {
                confirmed += v;
            } else {
                unconfirmed += v;
            }
        }
        let received = core_call(
            &c,
            &w,
            "listreceivedbyaddress",
            json!([0, true, true, address]),
        )
        .await?;
        let count = received
            .as_array()
            .and_then(|a| a.first())
            .and_then(|e| e.get("txids"))
            .and_then(Value::as_array)
            .map_or(0, Vec::len);
        return Ok(stats_json(address, confirmed, unconfirmed, count, 0));
    }
    Err(AppError::Internal("unknown Bitcoin backend".into()))
}

pub fn stats_json(
    address: &str,
    confirmed: i64,
    unconfirmed: i64,
    conf: usize,
    mempool: usize,
) -> Value {
    json!({
        "address": address,
        "chain_stats": { "funded_txo_sum": confirmed.max(0), "spent_txo_sum": (-confirmed).max(0), "tx_count": conf },
        "mempool_stats": { "funded_txo_sum": unconfirmed.max(0), "spent_txo_sum": (-unconfirmed).max(0), "tx_count": mempool },
    })
}

/// `GET /address/{a}/utxo` shape: `[{ txid, vout, value, status: { confirmed, block_height? } }]`.
pub async fn address_utxos(ctx: &Ctx<'_>, address: &str) -> AppResult<Value> {
    check_address(address, ctx.network)?;
    if let Some(base) = esplora_base(ctx)? {
        return esplora_json(ctx, &base, &format!("/address/{address}/utxo")).await;
    }
    if let Some(t) = electrum_target(&ctx.server)? {
        let sh = wallet_core::btc_scripthash(address, ctx.network)?;
        let mut conn = electrum::connect(ctx.net_client, &t, ctx.tor).await?;
        let list = conn
            .call("blockchain.scripthash.listunspent", json!([sh]))
            .await?;
        let mut out = Vec::new();
        for u in list.as_array().into_iter().flatten() {
            let height = u.get("height").and_then(Value::as_i64).unwrap_or(0);
            let mut status = json!({ "confirmed": height > 0 });
            if height > 0 {
                status["block_height"] = json!(height);
            }
            out.push(json!({
                "txid": str_field(u, "tx_hash")?,
                "vout": u64_field(u, "tx_pos")?,
                "value": u64_field(u, "value")?,
                "status": status,
            }));
        }
        return Ok(Value::Array(out));
    }
    if let Some((c, w)) = core_client(ctx)? {
        core_wallet(&c, &w).await?;
        let list = core_call(
            &c,
            &w,
            "listunspent",
            json!([0, 9_999_999, [address], true]),
        )
        .await?;
        let mut out = Vec::new();
        for u in list.as_array().into_iter().flatten() {
            out.push(json!({
                "txid": u.get("txid").and_then(Value::as_str).ok_or_else(|| bad("listunspent: txid"))?,
                "vout": u.get("vout").and_then(Value::as_u64).ok_or_else(|| bad("listunspent: vout"))?,
                "value": btc_to_sats(&u["amount"])?,
                "status": { "confirmed": u.get("confirmations").and_then(Value::as_u64).unwrap_or(0) > 0 },
            }));
        }
        return Ok(Value::Array(out));
    }
    Err(AppError::Internal("unknown Bitcoin backend".into()))
}

/// `GET /address/{a}/txs` shape (most recent first): `[{ txid, fee?, status: { confirmed,
/// block_height?, block_time? }, vin: [{ txid, vout, prevout: { scriptpubkey,
/// scriptpubkey_address?, value } | null }], vout: [{ scriptpubkey, scriptpubkey_address?, value }] }]`.
pub async fn address_txs(ctx: &Ctx<'_>, address: &str) -> AppResult<Value> {
    check_address(address, ctx.network)?;
    if let Some(base) = esplora_base(ctx)? {
        let first = esplora_json(ctx, &base, &format!("/address/{address}/txs")).await?;
        let first = first.as_array().cloned().unwrap_or_default();
        let txs = paginate_esplora(first, MAX_TXS, |last| {
            let (base, path) = (base.clone(), format!("/address/{address}/txs/chain/{last}"));
            async move {
                Ok(esplora_json(ctx, &base, &path)
                    .await?
                    .as_array()
                    .cloned()
                    .unwrap_or_default())
            }
        })
        .await?;
        return Ok(Value::Array(txs));
    }
    if let Some(t) = electrum_target(&ctx.server)? {
        let sh = wallet_core::btc_scripthash(address, ctx.network)?;
        let mut conn = electrum::connect(ctx.net_client, &t, ctx.tor).await?;
        let hist = conn
            .call("blockchain.scripthash.get_history", json!([sh]))
            .await?;
        let mut order: Vec<(String, i64)> = Vec::new();
        for h in hist.as_array().into_iter().flatten() {
            order.push((
                str_field(h, "tx_hash")?.to_owned(),
                h.get("height").and_then(Value::as_i64).unwrap_or(0),
            ));
        }
        order.sort_by_key(|(_, h)| if *h > 0 { -*h } else { i64::MIN });
        order.truncate(MAX_TXS);
        let txids: Vec<String> = order.iter().map(|(t, _)| t.clone()).collect();
        let raws = electrum_raw_with_prevouts(&mut conn, &txids, ctx.network).await?;
        let heights: Vec<i64> = order
            .iter()
            .map(|(_, h)| *h)
            .filter(|h| *h > 0)
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        let calls: Vec<(&str, Value)> = heights
            .iter()
            .map(|h| ("blockchain.block.header", json!([h])))
            .collect();
        let headers = conn.batch(&calls).await?;
        let times: HashMap<i64, u64> = heights
            .iter()
            .zip(headers)
            .filter_map(|(h, hex)| Some((*h, header_time(hex.as_str()?)?)))
            .collect();
        return Ok(Value::Array(esplora_txs(&order, &raws, &times)));
    }
    if let Some((c, w)) = core_client(ctx)? {
        core_wallet(&c, &w).await?;
        let list = core_call(&c, &w, "listtransactions", json!(["*", 1000, 0, true])).await?;
        let mut meta: Vec<(String, i64, Option<u64>)> = Vec::new();
        let mut seen = HashSet::new();
        for e in list.as_array().into_iter().flatten().rev() {
            let Some(txid) = e.get("txid").and_then(Value::as_str) else {
                continue;
            };
            if seen.insert(txid.to_owned()) {
                let height = e.get("blockheight").and_then(Value::as_i64).unwrap_or(0);
                meta.push((
                    txid.to_owned(),
                    height,
                    e.get("blocktime").and_then(Value::as_u64),
                ));
            }
        }
        let script = wallet_core::btc_script_pubkey(address, ctx.network)?;
        let spk = hex::encode(script.as_bytes());
        let mut cache = HashMap::new();
        let mut order = Vec::new();
        let mut raws = HashMap::new();
        let mut times = HashMap::new();
        for (txid, height, time) in meta {
            let Some(tx) = core_raw(&c, &w, &txid, ctx.network, &mut cache).await? else {
                continue;
            };
            let mut involved = tx.outputs.iter().any(|o| o.2 == spk);
            for (prev, vout) in &tx.inputs {
                if let Some(p) = core_raw(&c, &w, prev, ctx.network, &mut cache).await? {
                    involved |= p.outputs.get(*vout as usize).is_some_and(|o| o.2 == spk);
                    raws.insert(prev.clone(), p);
                }
            }
            if involved {
                if let Some(t) = time {
                    times.insert(height, t);
                }
                order.push((txid.clone(), height));
                raws.insert(txid, tx);
                if order.len() >= MAX_TXS {
                    break;
                }
            }
        }
        return Ok(Value::Array(esplora_txs(&order, &raws, &times)));
    }
    Err(AppError::Internal("unknown Bitcoin backend".into()))
}

/// `GET /v1/fees/recommended` shape (sat/vB): `{ fastestFee, halfHourFee, hourFee,
/// economyFee, minimumFee }`.
pub async fn fee_rates(ctx: &Ctx<'_>) -> AppResult<Value> {
    if let Some(base) = esplora_base(ctx)? {
        if ctx.server.is_default() {
            return esplora_json(ctx, &base, "/v1/fees/recommended").await;
        }
        return match esplora_json(ctx, &base, "/v1/fees/recommended").await {
            Ok(v) if v.get("fastestFee").is_some() => Ok(v),
            _ => Ok(fees_from_estimates(
                &esplora_json(ctx, &base, "/fee-estimates").await?,
            )),
        };
    }
    let sat = |v: &Value| btc_per_kvb_to_sat_per_vb(v);
    if let Some(t) = electrum_target(&ctx.server)? {
        let mut conn = electrum::connect(ctx.net_client, &t, ctx.tor).await?;
        let r = conn
            .batch(&[
                ("blockchain.estimatefee", json!([1])),
                ("blockchain.estimatefee", json!([3])),
                ("blockchain.estimatefee", json!([6])),
                ("blockchain.estimatefee", json!([25])),
                ("blockchain.relayfee", json!([])),
            ])
            .await?;
        return Ok(fees_json(
            sat(&r[0]),
            sat(&r[1]),
            sat(&r[2]),
            sat(&r[3]),
            sat(&r[4]),
        ));
    }
    if let Some((c, _)) = core_client(ctx)? {
        let mut rates = Vec::new();
        for n in [1, 3, 6, 25] {
            let r = c
                .call(None, "estimatesmartfee", json!([n]), false)
                .await
                .map_err(AppError::from)?;
            rates.push(sat(&r["feerate"]));
        }
        let pool = c
            .call(None, "getmempoolinfo", json!([]), false)
            .await
            .map_err(AppError::from)?;
        return Ok(fees_json(
            rates[0],
            rates[1],
            rates[2],
            rates[3],
            sat(&pool["mempoolminfee"]),
        ));
    }
    Err(AppError::Internal("unknown Bitcoin backend".into()))
}

fn fees_json(
    fastest: Option<u64>,
    half: Option<u64>,
    hour: Option<u64>,
    economy: Option<u64>,
    minimum: Option<u64>,
) -> Value {
    let minimum = minimum.unwrap_or(1).max(1);
    let economy = economy.unwrap_or(minimum).max(minimum);
    let hour = hour.unwrap_or(economy).max(economy);
    let half = half.unwrap_or(hour).max(hour);
    let fastest = fastest.unwrap_or(half).max(half);
    json!({ "fastestFee": fastest, "halfHourFee": half, "hourFee": hour,
            "economyFee": economy, "minimumFee": minimum })
}

/// `GET /blocks/tip/height`.
pub async fn tip_height(ctx: &Ctx<'_>) -> AppResult<u64> {
    if let Some(base) = esplora_base(ctx)? {
        let body = esplora_get(ctx, &base, "/blocks/tip/height").await?;
        return String::from_utf8_lossy(&body)
            .trim()
            .parse()
            .map_err(|_| bad("Esplora: invalid height"));
    }
    if let Some(t) = electrum_target(&ctx.server)? {
        let mut conn = electrum::connect(ctx.net_client, &t, ctx.tor).await?;
        let r = conn.call("blockchain.headers.subscribe", json!([])).await?;
        return u64_field(&r, "height");
    }
    if let Some((c, _)) = core_client(ctx)? {
        let r = c
            .call(None, "getblockcount", json!([]), false)
            .await
            .map_err(AppError::from)?;
        return r.as_u64().ok_or_else(|| bad("invalid getblockcount"));
    }
    Err(AppError::Internal("unknown Bitcoin backend".into()))
}

fn check_txid(txid: &str) -> AppResult<String> {
    let t = txid.trim().to_ascii_lowercase();
    if t.len() != 64 || !t.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(AppError::InvalidInput(
            "txid: 64 hexadecimal characters".into(),
        ));
    }
    Ok(t)
}

/// A raw transaction from a server is kept only if it hashes to the requested txid.
pub fn verified_tx_hex(raw: &str, txid: &str, source: &str) -> AppResult<String> {
    let raw = raw.trim().to_owned();
    wallet_core::verify_tx_hex(&raw, txid).map_err(|_| {
        bad(format!(
            "{source}: transaction unreadable or different from {txid} (its hash does not match)"
        ))
    })?;
    Ok(raw)
}

/// Raw transaction (hex) by txid, from the configured backend — e.g. the full previous transaction
/// a hardware wallet needs as `non_witness_utxo`. Whatever the backend, the answer must hash to
/// `txid` ([`verified_tx_hex`]).
pub async fn tx_hex(ctx: &Ctx<'_>, txid: &str) -> AppResult<String> {
    let t = check_txid(txid)?;
    if let Some(base) = esplora_base(ctx)? {
        let body = esplora_get(ctx, &base, &format!("/tx/{t}/hex")).await?;
        return verified_tx_hex(&String::from_utf8_lossy(&body), &t, "Esplora");
    }
    if let Some(target) = electrum_target(&ctx.server)? {
        let mut conn = electrum::connect(ctx.net_client, &target, ctx.tor).await?;
        let r = conn
            .call("blockchain.transaction.get", json!([t, false]))
            .await?;
        let raw = r
            .as_str()
            .ok_or_else(|| bad("Electrum: non-hexadecimal transaction"))?;
        return verified_tx_hex(raw, &t, "Electrum");
    }
    if let Some((c, w)) = core_client(ctx)? {
        core_wallet(&c, &w).await?;
        let raw = match c
            .call(Some(&w), "gettransaction", json!([t, true]), false)
            .await
        {
            Ok(v) => v
                .get("hex")
                .and_then(Value::as_str)
                .ok_or_else(|| bad("gettransaction: missing hex"))?
                .to_owned(),
            Err(CallError::Rpc(r)) if r.code == -5 => {
                match c
                    .call(None, "getrawtransaction", json!([t, false]), false)
                    .await
                {
                    Ok(v) => v
                        .as_str()
                        .ok_or_else(|| bad("getrawtransaction: missing hex"))?
                        .to_owned(),
                    Err(CallError::Rpc(r)) if r.code == -5 => {
                        return Err(AppError::InvalidInput(format!(
                            "Bitcoin Core: transaction {t} not found — it is not in the \
                             watch-only wallet, and the node cannot find it (for a \
                             confirmed transaction outside the wallet, -txindex=1 is needed)"
                        )))
                    }
                    Err(e) => return Err(e.into()),
                }
            }
            Err(e) => return Err(e.into()),
        };
        return verified_tx_hex(&raw, &t, "Bitcoin Core");
    }
    Err(AppError::Internal("unknown Bitcoin backend".into()))
}

/// `POST /tx` (hex) → txid. The txid returned by the server must match the transaction.
pub async fn broadcast(ctx: &Ctx<'_>, hex_tx: &str) -> AppResult<String> {
    let decoded = wallet_core::btc_decode_raw_tx(hex_tx, ctx.network)?;
    let txid = if let Some(base) = esplora_base(ctx)? {
        let url = url::Url::parse(&format!("{}/tx", base.trim_end_matches('/')))
            .map_err(|_| AppError::ServerInvalid("invalid Esplora URL".into()))?;
        let req = ServerRequest {
            url,
            method: Method::Post,
            headers: vec![("content-type".into(), "text/plain".into())],
            body: Some(hex_tx.trim().as_bytes().to_vec()),
            family: Family::Bitcoin,
            direct_private: false,
            long: false,
            bulk: false,
        };
        let (status, body) = ctx.net_client.server_request(req, ctx.tor).await?;
        let text = String::from_utf8_lossy(&body).trim().to_owned();
        if status != 200 {
            return Err(AppError::InvalidInput(format!(
                "broadcast rejected: {}",
                text.chars().take(300).collect::<String>()
            )));
        }
        text
    } else if let Some(t) = electrum_target(&ctx.server)? {
        let mut conn = electrum::connect(ctx.net_client, &t, ctx.tor).await?;
        let r = conn
            .call("blockchain.transaction.broadcast", json!([hex_tx.trim()]))
            .await?;
        r.as_str().unwrap_or_default().to_owned()
    } else if let Some((c, _)) = core_client(ctx)? {
        let r = c
            .call(None, "sendrawtransaction", json!([hex_tx.trim()]), false)
            .await
            .map_err(AppError::from)?;
        r.as_str().unwrap_or_default().to_owned()
    } else {
        return Err(AppError::Internal("unknown Bitcoin backend".into()));
    };
    if txid != decoded.txid {
        return Err(bad(format!(
            "the server returned an unexpected txid ({})",
            txid.chars().take(80).collect::<String>()
        )));
    }
    Ok(txid)
}

/// What a connection test found.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Detected {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub network: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub genesis_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chain_id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub block_height: Option<u64>,
}

fn net_label(net: Network) -> &'static str {
    match net {
        Network::Mainnet => "mainnet",
        Network::Testnet => "testnet4",
    }
}

/// Checks that a Bitcoin server is reachable and on `net` (genesis hash / chain name).
pub async fn probe(ctx: &Ctx<'_>) -> AppResult<Detected> {
    let expected = wallet_core::btc_genesis_hash(ctx.network);
    let mismatch = |found: &str| {
        AppError::ServerWrongNetwork(format!(
            "the server is not on Bitcoin {} (found: {found})",
            net_label(ctx.network)
        ))
    };
    if let Some(base) = esplora_base(ctx)? {
        let genesis = String::from_utf8_lossy(&esplora_get(ctx, &base, "/block-height/0").await?)
            .trim()
            .to_owned();
        if genesis != expected {
            return Err(mismatch(&genesis));
        }
        let height = tip_height(ctx).await.ok();
        return Ok(Detected {
            network: Some(net_label(ctx.network).into()),
            genesis_hash: Some(genesis),
            block_height: height,
            ..Default::default()
        });
    }
    if let Some(t) = electrum_target(&ctx.server)? {
        let mut conn = electrum::connect(ctx.net_client, &t, ctx.tor).await?;
        let r = conn
            .batch(&[
                ("server.features", json!([])),
                ("blockchain.headers.subscribe", json!([])),
            ])
            .await?;
        let genesis = r[0]
            .get("genesis_hash")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        if genesis != expected {
            return Err(mismatch(&genesis));
        }
        return Ok(Detected {
            network: Some(net_label(ctx.network).into()),
            genesis_hash: Some(genesis),
            server_version: r[0]
                .get("server_version")
                .and_then(Value::as_str)
                .map(str::to_owned),
            block_height: r[1].get("height").and_then(Value::as_u64),
            ..Default::default()
        });
    }
    if let BtcServer::Core { url, auth } = &ctx.server {
        let c = CoreClient::new(ctx.net_client, url, auth, ctx.tor)?;
        let (chain, blocks) = c.chain().await?;
        if chain != core_rpc::expected_chain(ctx.network) {
            return Err(mismatch(&chain));
        }
        let version = c
            .call(None, "getnetworkinfo", json!([]), false)
            .await
            .ok()
            .and_then(|v| {
                v.get("subversion")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            });
        return Ok(Detected {
            network: Some(net_label(ctx.network).into()),
            server_version: version,
            block_height: Some(blocks),
            ..Default::default()
        });
    }
    if matches!(ctx.server, BtcServer::Cbf { .. }) {
        return Ok(Detected {
            network: Some(net_label(ctx.network).into()),
            ..Default::default()
        });
    }
    Err(AppError::Internal("unknown Bitcoin backend".into()))
}

/// State of the Bitcoin Core watch-only wallet setup (`btc_core_status`).
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreStatus {
    pub wallet: String,
    /// `not-configured` | `idle` | `importing` | `ready` | `error`
    pub state: String,
    pub wallet_loaded: bool,
    /// Rescan progress 0..1 reported by `getwalletinfo.scanning`, if a scan is running.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scan_progress: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scan_duration_secs: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Default, Clone)]
struct Job {
    state: String,
    error: Option<String>,
}

static JOBS: Mutex<Option<HashMap<String, Job>>> = Mutex::new(None);

pub fn job_key(net: Network, url: &str, wallet: &str) -> String {
    format!(
        "{}|{}|{wallet}",
        net_label(net),
        url.trim().trim_end_matches('/')
    )
}

fn set_job(key: &str, state: &str, error: Option<String>) {
    crate::net::lock(&JOBS)
        .get_or_insert_with(HashMap::new)
        .insert(
            key.to_owned(),
            Job {
                state: state.into(),
                error,
            },
        );
}

fn get_job(key: &str) -> Option<Job> {
    crate::net::lock(&JOBS)
        .as_ref()
        .and_then(|m| m.get(key).cloned())
}

/// What the long-running import needs once the pre-flight succeeded.
pub struct CoreImport {
    pub key: String,
    pub wallet: String,
    pub descriptors: Vec<(String, bool)>,
    pub timestamp: Option<u64>,
}

/// Synchronous part of the setup, so obvious errors come back from `btc_core_setup` itself:
/// node reachable, auth accepted, right chain, wallet created or loaded (and watch-only),
/// descriptor checksums computed by the node.
pub async fn core_prepare(
    net_client: &NetClient,
    network: Network,
    url: &str,
    auth: &CoreAuth,
    tor: bool,
    fingerprint: &str,
    descriptors: &[wallet_core::BtcDescriptor],
) -> AppResult<CoreImport> {
    let c = CoreClient::new(net_client, url, auth, tor)?;
    let (chain, _) = c.chain().await?;
    if chain != core_rpc::expected_chain(network) {
        return Err(AppError::ServerWrongNetwork(format!(
            "the node is on \"{chain}\", not on Bitcoin {}",
            net_label(network)
        )));
    }
    let wallet = core_rpc::wallet_name(fingerprint);
    c.create_watch_wallet(&wallet).await?;
    let mut with_sums = Vec::with_capacity(descriptors.len());
    for d in descriptors {
        with_sums.push((c.with_checksum(&d.descriptor).await?, d.internal));
    }
    let key = job_key(network, url, &wallet);
    set_job(&key, "importing", None);
    Ok(CoreImport {
        key,
        wallet,
        descriptors: with_sums,
        timestamp: None,
    })
}

/// Background part: `importdescriptors` (and its rescan, possibly hours).
pub async fn core_import(
    net_client: &NetClient,
    url: &str,
    auth: &CoreAuth,
    tor: bool,
    job: CoreImport,
) -> AppResult<()> {
    let r = async {
        let c = CoreClient::new(net_client, url, auth, tor)?;
        c.import(&job.wallet, &job.descriptors, job.timestamp).await
    }
    .await;
    match &r {
        Ok(()) => set_job(&job.key, "ready", None),
        Err(e) => set_job(&job.key, "error", Some(e.to_string())),
    }
    r
}

/// `not-configured` when no Bitcoin Core node is set for the app's network.
pub fn core_not_configured() -> CoreStatus {
    CoreStatus {
        state: "not-configured".into(),
        ..Default::default()
    }
}

pub async fn core_status(
    net_client: &NetClient,
    network: Network,
    url: &str,
    auth: &CoreAuth,
    tor: bool,
    fingerprint: &str,
) -> AppResult<CoreStatus> {
    let c = CoreClient::new(net_client, url, auth, tor)?;
    let name = core_rpc::wallet_name(fingerprint);
    let job = get_job(&job_key(network, url, &name));
    let loaded = c.ensure_loaded(&name).await?;
    let mut st = CoreStatus {
        wallet: name.clone(),
        state: match &job {
            Some(j) => j.state.clone(),
            None if loaded => "ready".into(),
            None => "idle".into(),
        },
        wallet_loaded: loaded,
        error: job.and_then(|j| j.error),
        ..Default::default()
    };
    if loaded {
        let info = c
            .call(Some(&name), "getwalletinfo", json!([]), false)
            .await
            .map_err(AppError::from)?;
        if let Some(scan) = info.get("scanning").filter(|s| s.is_object()) {
            st.scan_progress = scan.get("progress").and_then(Value::as_f64);
            st.scan_duration_secs = scan.get("duration").and_then(Value::as_u64);
        }
    }
    Ok(st)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(
        txid: &str,
        inputs: Vec<(&str, u32)>,
        outputs: Vec<(Option<&str>, u64)>,
    ) -> wallet_core::BtcRawTx {
        wallet_core::BtcRawTx {
            txid: txid.into(),
            inputs: inputs.into_iter().map(|(t, v)| (t.into(), v)).collect(),
            outputs: outputs
                .into_iter()
                .map(|(a, v)| (a.map(str::to_owned), v, "0014ab".to_owned()))
                .collect(),
        }
    }

    #[test]
    fn esplora_shaped_history_and_fee() {
        let mut raws = HashMap::new();
        raws.insert(
            "prev".to_string(),
            raw("prev", vec![("x", 0)], vec![(Some("tb1qme"), 10_000)]),
        );
        raws.insert(
            "spend".to_string(),
            raw(
                "spend",
                vec![("prev", 0)],
                vec![(Some("tb1qother"), 7_000), (Some("tb1qme"), 2_500)],
            ),
        );
        raws.insert(
            "in".to_string(),
            raw("in", vec![("unknown", 3)], vec![(Some("tb1qme"), 1_000)]),
        );
        let order = vec![("spend".to_string(), 0), ("in".to_string(), 100)];
        let times = HashMap::from([(100, 1_793_333_429)]);
        let txs = esplora_txs(&order, &raws, &times);
        assert_eq!(txs.len(), 2);
        assert_eq!(txs[0]["txid"], "spend");
        assert_eq!(txs[0]["fee"], 500);
        assert_eq!(txs[0]["status"], json!({ "confirmed": false }));
        assert_eq!(
            txs[0]["vin"][0]["prevout"]["scriptpubkey_address"],
            "tb1qme"
        );
        assert_eq!(txs[0]["vin"][0]["prevout"]["value"], 10_000);
        assert_eq!(txs[0]["vout"][1]["value"], 2_500);
        assert_eq!(txs[1]["vin"][0]["prevout"], Value::Null);
        assert!(txs[1].get("fee").is_none());
        assert_eq!(txs[1]["status"]["block_time"], 1_793_333_429);
        assert_eq!(txs[1]["status"]["block_height"], 100);
    }

    #[test]
    fn stats_shape_matches_esplora() {
        let v = stats_json("tb1qx", 5_000, -1_200, 3, 1);
        assert_eq!(v["chain_stats"]["funded_txo_sum"], 5_000);
        assert_eq!(v["chain_stats"]["tx_count"], 3);
        assert_eq!(v["mempool_stats"]["spent_txo_sum"], 1_200);
        assert_eq!(v["mempool_stats"]["tx_count"], 1);
    }

    #[test]
    fn fee_ladder_is_monotonic_and_complete() {
        let v = fees_json(Some(20), None, Some(5), None, None);
        assert_eq!(
            v,
            json!({ "fastestFee": 20, "halfHourFee": 5, "hourFee": 5, "economyFee": 1, "minimumFee": 1 })
        );
        let v = fees_json(Some(2), Some(9), Some(4), Some(1), Some(3));
        assert_eq!(v["economyFee"], 3);
        assert_eq!(v["hourFee"], 4);
        assert_eq!(v["halfHourFee"], 9);
        assert_eq!(v["fastestFee"], 9);
        let est = json!({ "1": 30.2, "3": 12.0, "6": 8.5, "144": 1.0 });
        assert_eq!(fees_from_estimates(&est)["fastestFee"], 31);
        assert_eq!(fees_from_estimates(&est)["hourFee"], 9);
        assert_eq!(fees_from_estimates(&est)["economyFee"], 1);
    }

    fn page(prefix: &str, n: usize, confirmed: bool) -> Vec<Value> {
        (0..n)
            .map(
                |i| json!({ "txid": format!("{prefix}{i}"), "status": { "confirmed": confirmed } }),
            )
            .collect()
    }

    #[test]
    fn esplora_history_is_paginated_to_fifty() {
        tauri::async_runtime::block_on(async {
            let mut first = page("m", 3, false);
            first.extend(page("c0-", 25, true));
            let calls = std::cell::RefCell::new(Vec::new());
            let out = paginate_esplora(first, 50, |last| {
                calls.borrow_mut().push(last.clone());
                let n = calls.borrow().len();
                async move { Ok(page(&format!("c{n}-"), 25, true)) }
            })
            .await
            .unwrap();
            assert_eq!(out.len(), 50);
            assert!(
                out[..3].iter().all(|t| t["status"]["confirmed"] == false),
                "mempool first"
            );
            assert_eq!(
                *calls.borrow(),
                vec!["c0-24".to_string()],
                "one extra page was enough"
            );
            assert_eq!(out[49]["txid"], "c1-21");

            let calls = std::cell::RefCell::new(0);
            let out = paginate_esplora(page("c", 7, true), 50, |_| {
                *calls.borrow_mut() += 1;
                async { Ok(Vec::new()) }
            })
            .await
            .unwrap();
            assert_eq!((out.len(), *calls.borrow()), (7, 0));

            let out = paginate_esplora(page("c", 25, true), 50, |_| async { Ok(Vec::new()) })
                .await
                .unwrap();
            assert_eq!(out.len(), 25);

            let out = paginate_esplora(page("c", 25, true), 50, |_| async {
                Ok(page("c", 25, true))
            })
            .await
            .unwrap();
            assert_eq!(out.len(), 25);
        });
    }

    #[test]
    fn core_jobs_are_keyed_per_node_and_wallet() {
        let a = job_key(
            Network::Testnet,
            "http://127.0.0.1:48332/",
            "kyro-watch-73c5da0a",
        );
        let b = job_key(
            Network::Testnet,
            "http://192.168.1.5:48332",
            "kyro-watch-73c5da0a",
        );
        let c = job_key(
            Network::Mainnet,
            "http://127.0.0.1:48332",
            "kyro-watch-73c5da0a",
        );
        assert_eq!(
            a,
            job_key(
                Network::Testnet,
                "http://127.0.0.1:48332",
                "kyro-watch-73c5da0a"
            )
        );
        assert_ne!(a, b);
        assert_ne!(a, c);
        set_job(&a, "importing", None);
        assert_eq!(get_job(&a).unwrap().state, "importing");
        assert!(get_job(&b).is_none() && get_job(&c).is_none());
        set_job(&a, "error", Some("boom".into()));
        assert_eq!(get_job(&a).unwrap().error.as_deref(), Some("boom"));
        assert_eq!(core_not_configured().state, "not-configured");
    }

    async fn fake_core(answers: HashMap<&'static str, (u16, String)>) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        tauri::async_runtime::spawn(async move {
            loop {
                let Ok((mut s, _)) = listener.accept().await else {
                    return;
                };
                let answers = answers.clone();
                tauri::async_runtime::spawn(async move {
                    let mut buf = Vec::new();
                    let mut tmp = [0u8; 4096];
                    loop {
                        let n = s.read(&mut tmp).await.unwrap_or(0);
                        if n == 0 {
                            return;
                        }
                        buf.extend_from_slice(&tmp[..n]);
                        let text = String::from_utf8_lossy(&buf).to_string();
                        if let Some(i) = text.find("\r\n\r\n") {
                            let len = text[..i]
                                .lines()
                                .find_map(|l| {
                                    l.to_ascii_lowercase()
                                        .strip_prefix("content-length:")
                                        .map(|v| v.trim().parse::<usize>().unwrap_or(0))
                                })
                                .unwrap_or(0);
                            if buf.len() >= i + 4 + len {
                                let body: Value =
                                    serde_json::from_slice(&buf[i + 4..i + 4 + len]).unwrap();
                                let method = body["method"].as_str().unwrap_or("").to_owned();
                                let (status, reply) = answers
                                    .get(method.as_str())
                                    .cloned()
                                    .unwrap_or((500, r#"{"result":null,"error":{"code":-32601,"message":"Method not found"},"id":"kyro"}"#.into()));
                                let resp = format!("HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{reply}", reply.len());
                                let _ = s.write_all(resp.as_bytes()).await;
                                return;
                            }
                        }
                    }
                });
            }
        });
        url
    }

    fn ok(v: Value) -> (u16, String) {
        (
            200,
            json!({ "result": v, "error": null, "id": "kyro" }).to_string(),
        )
    }

    #[test]
    fn core_setup_preflight_errors_are_synchronous() {
        tauri::async_runtime::block_on(async {
            let net = NetClient::new(std::env::temp_dir().join("kyro-core-preflight")).unwrap();
            let auth = CoreAuth::Userpass {
                user: "kyro".into(),
                password: Some("pw".into()),
                has_password: true,
            };
            let seed = wallet_core::Mnemonic::parse(
                "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
            )
            .unwrap()
            .to_seed("");
            let descs = wallet_core::btc_descriptors(&seed, Network::Testnet, 0).unwrap();
            let prep = |url: String| {
                let (net, auth, descs) = (&net, auth.clone(), descs.clone());
                async move {
                    core_prepare(net, Network::Testnet, &url, &auth, true, "73c5da0a", &descs).await
                }
            };

            let url = fake_core(HashMap::from([(
                "getblockchaininfo",
                ok(json!({ "chain": "main", "blocks": 1 })),
            )]))
            .await;
            assert!(matches!(
                prep(url).await,
                Err(AppError::ServerWrongNetwork(_))
            ));
            let url = fake_core(HashMap::from([("getblockchaininfo", (401, String::new()))])).await;
            assert!(matches!(prep(url).await, Err(AppError::ServerInvalid(_))));
            // Existing wallet with private keys: refused.
            let url = fake_core(HashMap::from([
                (
                    "getblockchaininfo",
                    ok(json!({ "chain": "testnet4", "blocks": 1 })),
                ),
                (
                    "createwallet",
                    (
                        500,
                        r#"{"result":null,"error":{"code":-4,"message":"exists"},"id":"kyro"}"#
                            .into(),
                    ),
                ),
                ("listwallets", ok(json!(["kyro-watch-73c5da0a"]))),
                ("getwalletinfo", ok(json!({ "private_keys_enabled": true }))),
            ]))
            .await;
            assert!(matches!(prep(url).await, Err(AppError::ServerInvalid(_))));
            assert!(matches!(
                prep("http://127.0.0.1:9".into()).await,
                Err(AppError::ServerUnreachable(_))
            ));
            let url = fake_core(HashMap::from([
                (
                    "getblockchaininfo",
                    ok(json!({ "chain": "testnet4", "blocks": 1 })),
                ),
                ("createwallet", ok(json!({ "name": "kyro-watch-73c5da0a" }))),
                (
                    "getdescriptorinfo",
                    ok(json!({ "checksum": "abcdefgh", "isrange": true, "hasprivatekeys": false })),
                ),
            ]))
            .await;
            let job = prep(url.clone()).await.unwrap();
            assert_eq!(job.descriptors.len(), 4);
            assert!(job
                .descriptors
                .iter()
                .all(|(d, _)| d.ends_with("#abcdefgh")));
            assert_eq!(get_job(&job.key).unwrap().state, "importing");
            assert!(get_job(&job_key(Network::Mainnet, &url, &job.wallet)).is_none());
        });
    }

    #[test]
    fn raw_transactions_are_checked_against_their_txid() {
        let raw = "01000000019d53382244ce54a4129e041d0b29cedd293d1cfcd2cff7930d6e800332441876010000006a473044022020cdcc4c5072aca5e52f18d78d811308f8d79fd92e0198b998f06ac8dcacd6d2022053f6ca9c4e1f80dc8714c77914fad862e78064adbd4710dceb507b43fef3b6b7012103648adbede7ed318fc35e2b7d310046111f626e975d87e103a11e8cd84e5a1b76ffffffff02a23694fa010000001976a914e6c7989b8836301af965531c39865a73d745e46788acb0cc81d86c2b00001976a91498b24d9d9928caab02f40a57b9e7fdcc9dd8e34e88ac00000000";
        let txid = "386f6e9cc89fcc9d2ceb037677bdfd65d8ff2c46a371be688069784d1b3711c5";
        assert_eq!(
            verified_tx_hex(&format!("{raw}\n"), txid, "x").unwrap(),
            raw
        );
        assert!(matches!(
            verified_tx_hex(raw, &"ab".repeat(32), "x"),
            Err(AppError::ServerUnreachable(_))
        ));
        assert!(check_txid("../tx").is_err());
        assert_eq!(check_txid(&txid.to_uppercase()).unwrap(), txid);
    }

    #[test]
    fn core_tx_hex_paths() {
        let raw = "01000000019d53382244ce54a4129e041d0b29cedd293d1cfcd2cff7930d6e800332441876010000006a473044022020cdcc4c5072aca5e52f18d78d811308f8d79fd92e0198b998f06ac8dcacd6d2022053f6ca9c4e1f80dc8714c77914fad862e78064adbd4710dceb507b43fef3b6b7012103648adbede7ed318fc35e2b7d310046111f626e975d87e103a11e8cd84e5a1b76ffffffff02a23694fa010000001976a914e6c7989b8836301af965531c39865a73d745e46788acb0cc81d86c2b00001976a91498b24d9d9928caab02f40a57b9e7fdcc9dd8e34e88ac00000000";
        let txid = "386f6e9cc89fcc9d2ceb037677bdfd65d8ff2c46a371be688069784d1b3711c5";
        let not_wallet = (
            500,
            r#"{"result":null,"error":{"code":-5,"message":"Invalid or non-wallet transaction id"},"id":"kyro"}"#.to_string(),
        );
        let no_index = (
            500,
            r#"{"result":null,"error":{"code":-5,"message":"No such mempool transaction. Use -txindex or provide a block hash to enable blockchain transaction queries."},"id":"kyro"}"#.to_string(),
        );
        let loaded = ("listwallets", ok(json!(["kyro-watch-73c5da0a"])));
        tauri::async_runtime::block_on(async {
            let net = NetClient::new(std::env::temp_dir().join("kyro-core-txhex")).unwrap();
            let run = |answers: HashMap<&'static str, (u16, String)>| {
                let net = &net;
                async move {
                    let url = fake_core(answers).await;
                    let ctx = Ctx {
                        net_client: net,
                        network: Network::Testnet,
                        tor: false,
                        server: BtcServer::Core {
                            url,
                            auth: CoreAuth::Userpass {
                                user: "kyro".into(),
                                password: Some("pw".into()),
                                has_password: true,
                            },
                        },
                        fingerprint: Some("73c5da0a".into()),
                    };
                    tx_hex(&ctx, txid).await
                }
            };
            let r = run(HashMap::from([
                loaded.clone(),
                ("gettransaction", ok(json!({ "hex": raw }))),
            ]))
            .await;
            assert_eq!(r.unwrap(), raw);
            let r = run(HashMap::from([
                loaded.clone(),
                ("gettransaction", not_wallet.clone()),
                ("getrawtransaction", ok(json!(raw))),
            ]))
            .await;
            assert_eq!(r.unwrap(), raw);
            let r = run(HashMap::from([
                loaded.clone(),
                ("gettransaction", not_wallet.clone()),
                ("getrawtransaction", no_index),
            ]))
            .await;
            assert!(
                matches!(r, Err(AppError::InvalidInput(ref m)) if m.contains("-txindex=1")),
                "{r:?}"
            );
            let other = raw.replacen("a23694fa01", "a23694fa02", 1);
            let r = run(HashMap::from([
                loaded,
                ("gettransaction", ok(json!({ "hex": other }))),
            ]))
            .await;
            assert!(
                matches!(r, Err(AppError::ServerUnreachable(ref m)) if m.contains("hash")),
                "{r:?}"
            );
        });
    }

    #[test]
    fn header_timestamp() {
        let h = "0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d1dac2b7c";
        assert_eq!(header_time(h), Some(1_231_006_505));
        assert_eq!(header_time("00"), None);
    }
}

/// Real-network differential test: a public **testnet4 Electrum** server over **Tor** versus
/// mempool's onion Esplora, on the same addresses.
#[cfg(test)]
mod live {
    use super::*;
    use crate::tor::TorState;
    use std::time::Instant;

    #[test]
    #[ignore]
    fn electrum_live_vs_esplora_over_tor() {
        let target =
            std::env::var("KYRO_ELECTRUM").unwrap_or_else(|_| "blackie.c3-soft.com:57010".into());
        let (host, port) = target.rsplit_once(':').expect("host:port");
        let port: u16 = port.parse().unwrap();
        let addresses = [
            // "abandon ... about" BIP84 testnet address (long public history).
            "tb1q6rz28mcfaxtmd6v789l9rrlrusdprr9pqcpvkl",
            "tb1qhrw7celkgk34q3p9jx0eqts2de746f24fxj0x9",
        ];
        let net = NetClient::new(std::env::temp_dir().join("kyro-electrum-live")).unwrap();
        tauri::async_runtime::block_on(async {
            let t0 = Instant::now();
            net.tor.restart();
            loop {
                match net.tor.status().state {
                    TorState::Ready => break,
                    TorState::Error => panic!("tor: {:?}", net.tor.status().message),
                    _ => tokio::time::sleep(std::time::Duration::from_millis(200)).await,
                }
            }
            eprintln!("tor ready in {:.1?}", t0.elapsed());

            let t = Instant::now();
            let cert = electrum::fetch_certificate(&net, host, port, true)
                .await
                .unwrap();
            eprintln!(
                "cert {} webpki_valid={} ({:.1?})",
                cert.sha256,
                cert.webpki_valid,
                t.elapsed()
            );
            let electrum = BtcServer::Electrum {
                host: host.into(),
                port,
                tls: if cert.webpki_valid {
                    crate::servers::ElectrumTls::Webpki
                } else {
                    crate::servers::ElectrumTls::Pinned
                },
                cert_sha256: (!cert.webpki_valid).then(|| cert.sha256.clone()),
            };
            let e = Ctx {
                net_client: &net,
                network: Network::Testnet,
                tor: true,
                server: electrum,
                fingerprint: None,
            };
            let d = Ctx {
                net_client: &net,
                network: Network::Testnet,
                tor: true,
                server: BtcServer::Default,
                fingerprint: None,
            };

            let t = Instant::now();
            let det = probe(&e).await.unwrap();
            eprintln!("probe {det:?} in {:.1?}", t.elapsed());
            assert_eq!(
                det.genesis_hash.as_deref(),
                Some(wallet_core::btc_genesis_hash(Network::Testnet).as_str())
            );
            let wrong = Ctx {
                server: BtcServer::Electrum {
                    host: host.into(),
                    port,
                    tls: crate::servers::ElectrumTls::Pinned,
                    cert_sha256: Some("00".repeat(32)),
                },
                net_client: &net,
                network: Network::Testnet,
                tor: true,
                fingerprint: None,
            };
            assert!(matches!(
                probe(&wrong).await,
                Err(AppError::ServerUnreachable(_))
            ));
            let mainnet = Ctx {
                network: Network::Mainnet,
                ..e_clone(&e)
            };
            assert!(matches!(
                probe(&mainnet).await,
                Err(AppError::ServerWrongNetwork(_))
            ));

            let (te, td) = (tip_height(&e).await.unwrap(), tip_height(&d).await.unwrap());
            eprintln!("tip electrum={te} esplora={td}");
            assert!(te.abs_diff(td) <= 2);
            eprintln!("fees electrum={}", fee_rates(&e).await.unwrap());

            for a in addresses {
                let t = Instant::now();
                let ie = address_info(&e, a).await.unwrap();
                eprintln!("{a} electrum info in {:.1?}", t.elapsed());
                let id = address_info(&d, a).await.unwrap();
                let bal = |v: &Value| {
                    ["chain_stats", "mempool_stats"]
                        .iter()
                        .map(|k| {
                            v[k]["funded_txo_sum"].as_i64().unwrap()
                                - v[k]["spent_txo_sum"].as_i64().unwrap()
                        })
                        .sum::<i64>()
                };
                let count = |v: &Value| {
                    v["chain_stats"]["tx_count"].as_u64().unwrap()
                        + v["mempool_stats"]["tx_count"].as_u64().unwrap()
                };
                eprintln!(
                    "  balance electrum={} esplora={}  txs electrum={} esplora={}",
                    bal(&ie),
                    bal(&id),
                    count(&ie),
                    count(&id)
                );
                assert_eq!(bal(&ie), bal(&id));
                assert_eq!(count(&ie), count(&id));

                let ue = address_utxos(&e, a).await.unwrap();
                let ud = address_utxos(&d, a).await.unwrap();
                let set = |v: &Value| {
                    let mut s: Vec<(String, u64, u64)> = v
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|u| {
                            (
                                u["txid"].as_str().unwrap().to_owned(),
                                u["vout"].as_u64().unwrap(),
                                u["value"].as_u64().unwrap(),
                            )
                        })
                        .collect();
                    s.sort();
                    s
                };
                assert_eq!(set(&ue), set(&ud));

                let t = Instant::now();
                let xe = address_txs(&e, a).await.unwrap();
                eprintln!(
                    "  electrum txs ({}) in {:.1?}",
                    xe.as_array().unwrap().len(),
                    t.elapsed()
                );
                let xd = address_txs(&d, a).await.unwrap();
                for tx in xd.as_array().unwrap().iter().take(10) {
                    let id = tx["txid"].as_str().unwrap();
                    let mine = xe
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|x| x["txid"] == id)
                        .unwrap_or_else(|| panic!("{id} missing from electrum history"));
                    assert_eq!(mine["fee"], tx["fee"], "fee {id}");
                    assert_eq!(mine["status"]["confirmed"], tx["status"]["confirmed"]);
                    if tx["status"]["confirmed"] == true {
                        assert_eq!(mine["status"]["block_height"], tx["status"]["block_height"]);
                        assert_eq!(mine["status"]["block_time"], tx["status"]["block_time"]);
                    }
                    let outs = |v: &Value| {
                        v["vout"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(|o| (o["scriptpubkey_address"].clone(), o["value"].clone()))
                            .collect::<Vec<_>>()
                    };
                    assert_eq!(outs(mine), outs(tx));
                    let ins = |v: &Value| {
                        v["vin"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(|i| {
                                (
                                    i["prevout"]["scriptpubkey_address"].clone(),
                                    i["prevout"]["value"].clone(),
                                )
                            })
                            .collect::<Vec<_>>()
                    };
                    assert_eq!(ins(mine), ins(tx));
                }
            }
        });
    }

    fn e_clone<'a>(c: &Ctx<'a>) -> Ctx<'a> {
        Ctx {
            net_client: c.net_client,
            network: c.network,
            tor: c.tor,
            server: c.server.clone(),
            fingerprint: c.fingerprint.clone(),
        }
    }
}

/// Bitcoin testnet4 broadcast from the public "abandon … about" wallet (BIP84 and BIP86), in three
/// phases like Litecoin's: (1) Rust reads the wallet over Tor (the `btc_*` code, default backend =
/// mempool's onion) and dumps it to `$KYRO_BTC_DUMP`.
#[cfg(test)]
mod live_send {
    use super::*;
    use crate::tor::TorState;
    use serde_json::json;

    const ABANDON: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    const ALL: &str = "all all all all all all all all all all all all";
    const SCAN: u32 = 20;

    fn phrase() -> &'static str {
        match std::env::var("KYRO_BTC_WALLET").as_deref() {
            Ok("trezor") => ALL,
            _ => ABANDON,
        }
    }

    async fn wait_tor(net: &NetClient) {
        net.tor.restart();
        loop {
            match net.tor.status().state {
                TorState::Ready => break,
                TorState::Error => panic!("tor: {:?}", net.tor.status().message),
                _ => tokio::time::sleep(std::time::Duration::from_millis(200)).await,
            }
        }
    }

    fn ctx(net: &NetClient) -> Ctx<'_> {
        Ctx {
            net_client: net,
            network: Network::Testnet,
            tor: true,
            server: BtcServer::Default,
            fingerprint: None,
        }
    }

    fn addresses(seed: &wallet_core::Seed) -> Vec<String> {
        let mut out = Vec::new();
        for kind in [wallet_core::BtcKind::Segwit, wallet_core::BtcKind::Taproot] {
            for change in [false, true] {
                for i in 0..SCAN {
                    out.push(
                        wallet_core::btc_address(seed, Network::Testnet, kind, 0, change, i)
                            .unwrap(),
                    );
                }
            }
        }
        out
    }

    #[test]
    #[ignore]
    fn btc_broadcast_1_fetch() {
        let out = std::env::var("KYRO_BTC_DUMP").expect("KYRO_BTC_DUMP");
        let net = NetClient::new(std::env::temp_dir().join("kyro-btc-bcast")).unwrap();
        let seed = wallet_core::Mnemonic::parse(phrase()).unwrap().to_seed("");
        let acc = |k| {
            let a = wallet_core::btc_account(&seed, Network::Testnet, k, 0).unwrap();
            json!({
                "address": wallet_core::btc_address(&seed, Network::Testnet, k, 0, false, 0).unwrap(),
                "xpub": a.xpub, "fingerprint": a.fingerprint, "path": a.path
            })
        };
        let accounts = json!({
            "segwit": acc(wallet_core::BtcKind::Segwit),
            "taproot": acc(wallet_core::BtcKind::Taproot),
        });
        tauri::async_runtime::block_on(async {
            wait_tor(&net).await;
            let c = ctx(&net);
            let mut info = serde_json::Map::new();
            let mut utxos = serde_json::Map::new();
            for a in addresses(&seed) {
                let i = address_info(&c, &a).await.unwrap();
                let u = address_utxos(&c, &a).await.unwrap();
                if u.as_array().is_some_and(|x| !x.is_empty()) {
                    eprintln!("{a}: {u}");
                }
                info.insert(a.clone(), i);
                utxos.insert(a, u);
            }
            let fees = fee_rates(&c).await.unwrap();
            let tip = tip_height(&c).await.unwrap();
            let dump = json!({ "accounts": accounts, "info": info, "utxos": utxos, "fees": fees, "tip": tip });
            std::fs::write(&out, serde_json::to_string_pretty(&dump).unwrap()).unwrap();
            eprintln!("wrote {out}; fees {fees}; tip {tip}");
        });
    }

    #[test]
    #[ignore]
    fn btc_broadcast_2_sign_and_send() {
        use bitcoin::psbt::Psbt;
        use std::str::FromStr;
        let b64 = std::fs::read_to_string(std::env::var("KYRO_BTC_PSBT").expect("KYRO_BTC_PSBT"))
            .unwrap();
        let b64 = b64.trim();
        let seed = wallet_core::Mnemonic::parse(phrase()).unwrap().to_seed("");
        let net = Network::Testnet;

        let summary = wallet_core::btc_psbt_summary(&seed, net, 0, b64).unwrap();
        eprintln!(
            "--- native dialog text ---\n{}\n--------------------------",
            crate::commands::describe_btc(crate::i18n::Lang::Fr, &summary)
        );
        if summary.requires_extra_confirmation {
            eprintln!(
                "--- reinforced dialog ---\n{}",
                crate::commands::describe_btc_extra(crate::i18n::Lang::Fr, &summary)
            );
        }
        let ours = addresses(&seed);
        for (a, _, _) in &summary.outputs {
            assert!(ours.iter().any(|x| x == a), "{a} is not in the test wallet");
        }
        assert!(!summary.requires_extra_confirmation);

        let (signed, again) = wallet_core::btc_sign_psbt(&seed, net, 0, b64).unwrap();
        assert_eq!(again, summary, "same summary as the dialog");
        let mut p = Psbt::from_str(&signed).unwrap();
        for input in &mut p.inputs {
            if let Some(sig) = input.tap_key_sig {
                input.final_script_witness = Some(bitcoin::Witness::p2tr_key_spend(&sig));
                input.tap_key_sig = None;
                input.tap_key_origins.clear();
                input.tap_internal_key = None;
            } else {
                let (pk, sig) = input
                    .partial_sigs
                    .iter()
                    .next()
                    .map(|(k, s)| (*k, *s))
                    .expect("signed input");
                input.final_script_witness = Some(bitcoin::Witness::p2wpkh(&sig, &pk.inner));
                input.partial_sigs.clear();
                input.bip32_derivation.clear();
            }
        }
        let tx = p.extract_tx().expect("fee sane");
        let hex_tx = bitcoin::consensus::encode::serialize_hex(&tx);
        let txid = tx.compute_txid().to_string();
        eprintln!("signed tx {txid} ({} vB): {hex_tx}", tx.vsize());
        if std::env::var("KYRO_BTC_BROADCAST").as_deref() != Ok("yes") {
            eprintln!("KYRO_BTC_BROADCAST != yes: not broadcast");
            return;
        }
        let client = NetClient::new(std::env::temp_dir().join("kyro-btc-bcast")).unwrap();
        tauri::async_runtime::block_on(async {
            wait_tor(&client).await;
            let c = ctx(&client);
            let got = broadcast(&c, &hex_tx).await.unwrap();
            assert_eq!(got, txid);
            eprintln!("BROADCAST OK: {got}");
            let dest = summary.outputs[0].0.clone();
            for attempt in 0..30 {
                let txs = address_txs(&c, &dest).await.unwrap();
                if let Some(t) = txs
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|t| t["txid"] == txid.as_str())
                {
                    eprintln!(
                        "seen by btc_address_txs({dest}) after {attempt} retries: status {}",
                        t["status"]
                    );
                    return;
                }
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            }
            panic!("{txid} not seen");
        });
    }
}
