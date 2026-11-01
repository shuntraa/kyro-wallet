//! Litecoin and Dogecoin data, in **the same Esplora shapes** as the `btc_*` commands
//! (docs/IPC.md §2.2), so the TypeScript adapters reuse the Bitcoin logic.
//!
//! Two backends:
//!
//! | command                    | Esplora (litecoinspace.org, user's server) | Electrum (Dogecoin mainnet default) |
//! |----------------------------|---------------------------------------------|-------------------------------------|
//! | `{ltc,doge}_address_info`  | `GET /address/{a}`                          | `scripthash.get_balance` + `get_history` |
//! | `{ltc,doge}_address_utxos` | `GET /address/{a}/utxo`                     | `scripthash.listunspent`, **each UTXO checked against its previous transaction** |
//! | `{ltc,doge}_address_txs`   | `GET /address/{a}/txs` (+ `/txs/chain/{last}`, 50 max) | `get_history` + `transaction.get` (+ prevouts) + `block.header` |
//! | `{ltc,doge}_tx_hex`        | `GET /tx/{txid}/hex` (checked: it hashes to `txid`) | `transaction.get` (same check) |
//! | `{ltc,doge}_fee_rates`     | `GET /v1/fees/recommended`, else `GET /fee-estimates` | `estimatefee` 2/30/60/144 blocks + `relayfee` |
//! | `{ltc,doge}_tip_height`    | `GET /blocks/tip/height`                    | `headers.subscribe` |
//! | `{ltc,doge}_broadcast`     | `POST /tx` (returned txid must match)       | `transaction.broadcast` (same check) |
//!
//! Servers: Litecoin defaults to litecoinspace.org (mempool's Litecoin fork, mainnet and
//! testnet4). Dogecoin mainnet defaults to Komodo's public ElectrumX servers
//! (`net::ELECTRUM_HOSTS`, TLS validated normally, genesis checked on every session; the second
//! is tried only if the first cannot be reached — same Tor family, same transport, never clear
//! when Tor is on). Dogecoin testnet has no default (no free public server found, see
//! docs/NETWORK.md): the user sets an Esplora server. A user's server is never replaced by a
//! default: if it fails, the command fails.

use std::collections::{HashMap, HashSet};

use serde_json::{json, Value};
use wallet_core::{BtcRawTx, Network, UtxoCoin};

use crate::btc_backend::{
    esplora_txs, fees_from_estimates, header_time, paginate_esplora, stats_json, Detected,
};
use crate::electrum::{self, BoxStream, Conn, TlsMode};
use crate::error::{AppError, AppResult};
use crate::net::{electrum_default_allowed, Method, NetClient, ServerRequest};
use crate::servers::{
    host_of, utxo_default_base, utxo_default_electrum, utxo_family, validate_http_url, UtxoServer,
};

/// Most recent transactions returned per address (same cap as Bitcoin).
const MAX_TXS: usize = 50;

/// Most UTXOs of one address that the Electrum backend lists (each one is checked against its
/// previous transaction, so this bounds the work and the data downloaded).
const MAX_UTXOS: usize = 1_000;

/// Electrum requests pipelined per batch (keeps each batch well under the call timeout).
const ELECTRUM_CHUNK: usize = 25;

/// Dogecoin fee ladder bounds, koinus per byte: the recommended minimum (0.01 DOGE/kB, what
/// miners include by default) and 100× that. A server's estimate is clamped into this range so
/// a malicious server cannot push absurd fees (Rust's dialog would still show them).
const DOGE_FEE_FLOOR: u64 = wallet_core::DOGE_RECOMMENDED_FEE_PER_KB / 1_000;
const DOGE_FEE_CEIL: u64 = 100 * DOGE_FEE_FLOOR;

pub struct UtxoCtx<'a> {
    pub net_client: &'a NetClient,
    pub network: Network,
    pub coin: UtxoCoin,
    pub tor: bool,
    pub server: UtxoServer,
}

/// Where the data of a chain comes from, resolved from the settings at call time.
#[derive(Debug, Clone)]
pub enum Backend {
    /// Esplora base URL.
    Esplora(String),
    /// Kyro's default Electrum servers, in the order they are tried.
    Electrum(Vec<electrum::Target>),
}

impl Backend {
    /// Host shown to the user (first server for Electrum).
    pub fn label(&self) -> String {
        match self {
            Backend::Esplora(url) => host_of(url).unwrap_or_default(),
            Backend::Electrum(t) => t.first().map(|t| t.host.clone()).unwrap_or_default(),
        }
    }
}

fn bad(msg: impl Into<String>) -> AppError {
    AppError::ServerUnreachable(msg.into())
}

pub fn no_default_server(coin: UtxoCoin) -> AppError {
    AppError::ServerInvalid(format!(
        "{} : Kyro n'a pas de serveur public par défaut sur ce réseau (aucun serveur public \
         gratuit et maintenu n'a été trouvé). Configure ton serveur Esplora (electrs-{}) dans \
         Réglages → Réseaux.",
        coin.name(),
        coin.name().to_lowercase()
    ))
}

/// The configured (or default) backend.
pub fn backend(ctx: &UtxoCtx<'_>) -> AppResult<Backend> {
    match &ctx.server {
        UtxoServer::Default => {
            if let Some(base) = utxo_default_base(ctx.coin, ctx.network) {
                return Ok(Backend::Esplora(base.to_owned()));
            }
            let targets: Vec<electrum::Target> = utxo_default_electrum(ctx.coin, ctx.network)
                .into_iter()
                .map(|(host, port)| electrum::Target {
                    host: host.to_owned(),
                    port,
                    tls: TlsMode::Webpki,
                })
                .collect();
            if targets.is_empty() {
                return Err(no_default_server(ctx.coin));
            }
            Ok(Backend::Electrum(targets))
        }
        UtxoServer::Esplora { url } => {
            validate_http_url(url, ctx.tor, false)?;
            Ok(Backend::Esplora(url.trim().to_owned()))
        }
    }
}

fn url(base: &str, path: &str) -> AppResult<url::Url> {
    url::Url::parse(&format!("{}{path}", base.trim_end_matches('/')))
        .map_err(|_| AppError::ServerInvalid("URL Esplora invalide".into()))
}

async fn get(ctx: &UtxoCtx<'_>, base: &str, path: &str) -> AppResult<Vec<u8>> {
    let (status, body) = ctx
        .net_client
        .server_request(
            ServerRequest::get(url(base, path)?, utxo_family(ctx.coin)),
            ctx.tor,
        )
        .await?;
    if status != 200 {
        return Err(bad(format!(
            "{} : HTTP {status} sur {path} ({})",
            ctx.coin.name(),
            String::from_utf8_lossy(&body)
                .chars()
                .take(200)
                .collect::<String>()
        )));
    }
    Ok(body)
}

async fn get_json(ctx: &UtxoCtx<'_>, base: &str, path: &str) -> AppResult<Value> {
    serde_json::from_slice(&get(ctx, base, path).await?)
        .map_err(|_| bad(format!("{} : JSON invalide sur {path}", ctx.coin.name())))
}

fn check_address(ctx: &UtxoCtx<'_>, a: &str) -> AppResult<String> {
    wallet_core::utxo_script_pubkey(a, ctx.network, ctx.coin)?;
    Ok(a.trim().to_owned())
}

fn check_txid(txid: &str) -> AppResult<String> {
    let t = txid.trim().to_ascii_lowercase();
    if !is_txid(&t) {
        return Err(AppError::InvalidInput(
            "txid : 64 caractères hexadécimaux".into(),
        ));
    }
    Ok(t)
}

fn is_txid(t: &str) -> bool {
    t.len() == 64 && t.bytes().all(|b| b.is_ascii_hexdigit())
}

// ---------------------------------------------------------------- Electrum (Dogecoin default)

/// Opens a session on the first reachable default server, on the chain's Tor family, and
/// checks its genesis hash. Only a transport failure moves on to the next server (never Tor
/// unavailability: nothing is ever sent in clear when Tor is on).
async fn electrum_session(
    ctx: &UtxoCtx<'_>,
    targets: &[electrum::Target],
) -> AppResult<Conn<BoxStream>> {
    let family = utxo_family(ctx.coin);
    let mut last = None;
    for t in targets {
        if !electrum_default_allowed(&t.host, t.port, family) {
            return Err(AppError::HostNotAllowed(format!("{}:{}", t.host, t.port)));
        }
        match electrum::connect_family(ctx.net_client, t, ctx.tor, family).await {
            Ok(mut conn) => {
                let features = conn.call("server.features", json!([])).await?;
                check_genesis(ctx, &features)?;
                return Ok(conn);
            }
            Err(e @ AppError::ServerUnreachable(_)) => last = Some(e),
            Err(e) => return Err(e),
        }
    }
    Err(last.unwrap_or_else(|| no_default_server(ctx.coin)))
}

fn check_genesis(ctx: &UtxoCtx<'_>, features: &Value) -> AppResult<String> {
    let expected = wallet_core::utxo_genesis_hash(ctx.network, ctx.coin);
    let genesis = features
        .get("genesis_hash")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if genesis != expected {
        return Err(AppError::ServerWrongNetwork(format!(
            "le serveur n'est pas sur {} {} (genesis {})",
            ctx.coin.name(),
            network_label(ctx.coin, ctx.network),
            genesis.chars().take(64).collect::<String>()
        )));
    }
    Ok(genesis.to_owned())
}

fn scripthash(ctx: &UtxoCtx<'_>, address: &str) -> AppResult<(String, String)> {
    let spk = wallet_core::utxo_script_pubkey(address, ctx.network, ctx.coin)?;
    Ok((
        wallet_core::btc_scripthash_of_script(spk.as_bytes()),
        hex::encode(spk.as_bytes()),
    ))
}

/// `get_history` entries, strictly typed: `(txid, height)`; height ≤ 0 = unconfirmed.
fn parse_history(coin: UtxoCoin, v: &Value) -> AppResult<Vec<(String, i64)>> {
    let list = v
        .as_array()
        .ok_or_else(|| bad(format!("{} : historique Electrum invalide", coin.name())))?;
    let mut out = Vec::with_capacity(list.len());
    let mut seen = HashSet::new();
    for h in list {
        let txid = h
            .get("tx_hash")
            .and_then(Value::as_str)
            .filter(|t| is_txid(t))
            .ok_or_else(|| bad(format!("{} : tx_hash invalide", coin.name())))?
            .to_ascii_lowercase();
        let height = h
            .get("height")
            .and_then(Value::as_i64)
            .ok_or_else(|| bad(format!("{} : hauteur invalide", coin.name())))?;
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

fn parse_listunspent(coin: UtxoCoin, v: &Value) -> AppResult<Vec<ClaimedUtxo>> {
    let list = v
        .as_array()
        .ok_or_else(|| bad(format!("{} : listunspent invalide", coin.name())))?;
    let err = |k: &str| {
        bad(format!(
            "{} : listunspent, champ « {k} » invalide",
            coin.name()
        ))
    };
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

/// Checks each claimed UTXO against its previous transaction (already verified to hash to its
/// txid): the output must exist, pay **our** script, and hold exactly the claimed amount.
/// Returns the Esplora shape, amounts taken from the transactions. Any mismatch is an error:
/// a server that lies about one coin is not trusted for the others.
fn verified_utxos(
    coin: UtxoCoin,
    claimed: &[ClaimedUtxo],
    raws: &HashMap<String, BtcRawTx>,
    our_spk: &str,
) -> AppResult<Value> {
    let mut out = Vec::with_capacity(claimed.len());
    for u in claimed {
        let tx = raws.get(&u.txid).ok_or_else(|| {
            bad(format!(
                "{} : transaction précédente {} introuvable",
                coin.name(),
                u.txid
            ))
        })?;
        let (_, value, spk) = tx.outputs.get(u.vout as usize).ok_or_else(|| {
            bad(format!(
                "{} : le serveur annonce une sortie {}:{} qui n'existe pas",
                coin.name(),
                u.txid,
                u.vout
            ))
        })?;
        if spk != our_spk {
            return Err(bad(format!(
                "{} : la sortie {}:{} annoncée ne paie pas cette adresse",
                coin.name(),
                u.txid,
                u.vout
            )));
        }
        if *value != u.value {
            return Err(bad(format!(
                "{} : le serveur annonce {} pour {}:{}, la transaction dit {value}",
                coin.name(),
                u.value,
                u.txid,
                u.vout
            )));
        }
        let mut status = json!({ "confirmed": u.height > 0 });
        if u.height > 0 {
            status["block_height"] = json!(u.height);
        }
        out.push(json!({ "txid": u.txid, "vout": u.vout, "value": value, "status": status }));
    }
    Ok(Value::Array(out))
}

/// Decodes a raw transaction from the server; it must hash to `txid` and be a valid
/// transaction of this chain (no witness data for Dogecoin).
fn verified_raw(coin: UtxoCoin, net: Network, txid: &str, raw: &Value) -> AppResult<BtcRawTx> {
    let hex_tx = raw
        .as_str()
        .ok_or_else(|| bad(format!("{} : transaction non hexadécimale", coin.name())))?;
    let tx = wallet_core::utxo_decode_raw_tx(hex_tx, net, coin)
        .map_err(|_| bad(format!("{} : transaction {txid} illisible", coin.name())))?;
    if tx.txid != txid {
        return Err(bad(format!(
            "{} : le serveur a renvoyé une transaction différente de {txid}",
            coin.name()
        )));
    }
    Ok(tx)
}

/// Fetches and verifies `txids` (chunked batches), skipping those already in `raws`.
async fn fetch_raws(
    ctx: &UtxoCtx<'_>,
    conn: &mut Conn<BoxStream>,
    txids: impl IntoIterator<Item = String>,
    raws: &mut HashMap<String, BtcRawTx>,
) -> AppResult<()> {
    let mut want: Vec<String> = txids
        .into_iter()
        .filter(|t| !raws.contains_key(t))
        .collect();
    want.sort();
    want.dedup();
    for chunk in want.chunks(ELECTRUM_CHUNK) {
        let calls: Vec<(&str, Value)> = chunk
            .iter()
            .map(|t| ("blockchain.transaction.get", json!([t, false])))
            .collect();
        let res = conn.batch(&calls).await?;
        for (txid, raw) in chunk.iter().zip(res) {
            let tx = verified_raw(ctx.coin, ctx.network, txid, &raw)?;
            raws.insert(txid.clone(), tx);
        }
    }
    Ok(())
}

/// Keeps the history entries that really involve `our_spk` (an output paying it, or an input
/// spending it), so a server cannot inject unrelated transactions into the history.
fn involving(
    order: Vec<(String, i64)>,
    raws: &HashMap<String, BtcRawTx>,
    our_spk: &str,
) -> Vec<(String, i64)> {
    order
        .into_iter()
        .filter(|(txid, _)| {
            raws.get(txid).is_some_and(|tx| {
                tx.outputs.iter().any(|o| o.2 == our_spk)
                    || tx.inputs.iter().any(|(p, v)| {
                        raws.get(p)
                            .and_then(|p| p.outputs.get(*v as usize))
                            .is_some_and(|o| o.2 == our_spk)
                    })
            })
        })
        .collect()
}

/// Electrum `estimatefee` (coin per kB, `-1` = unknown) → smallest unit per byte.
fn per_kb_to_unit_per_byte(v: &Value) -> Option<f64> {
    v.as_f64()
        .filter(|f| f.is_finite() && *f > 0.0)
        .map(|f| (f * 100_000.0).ceil())
}

// ---------------------------------------------------------------- public API

/// `GET /address/{a}` shape: `{ address, chain_stats, mempool_stats }`. With Electrum,
/// `funded_txo_sum`/`spent_txo_sum` carry the *net* balance (as for Bitcoin's Electrum).
pub async fn address_info(ctx: &UtxoCtx<'_>, address: &str) -> AppResult<Value> {
    let a = check_address(ctx, address)?;
    match backend(ctx)? {
        Backend::Esplora(base) => {
            let v = get_json(ctx, &base, &format!("/address/{a}")).await?;
            for k in ["chain_stats", "mempool_stats"] {
                if !v[k]["funded_txo_sum"].is_u64() || !v[k]["tx_count"].is_u64() {
                    return Err(bad(format!(
                        "{} : réponse /address inattendue",
                        ctx.coin.name()
                    )));
                }
            }
            Ok(v)
        }
        Backend::Electrum(targets) => {
            let (sh, _) = scripthash(ctx, &a)?;
            let mut conn = electrum_session(ctx, &targets).await?;
            let r = conn
                .batch(&[
                    ("blockchain.scripthash.get_balance", json!([sh])),
                    ("blockchain.scripthash.get_history", json!([sh])),
                ])
                .await?;
            electrum_info(ctx.coin, &a, &r[0], &r[1])
        }
    }
}

fn electrum_info(
    coin: UtxoCoin,
    address: &str,
    balance: &Value,
    history: &Value,
) -> AppResult<Value> {
    let field = |k: &str| {
        balance
            .get(k)
            .and_then(Value::as_i64)
            .ok_or_else(|| bad(format!("{} : solde Electrum invalide ({k})", coin.name())))
    };
    let (confirmed, unconfirmed) = (field("confirmed")?, field("unconfirmed")?);
    if confirmed < 0 {
        return Err(bad(format!("{} : solde confirmé négatif", coin.name())));
    }
    let history = parse_history(coin, history)?;
    let conf = history.iter().filter(|(_, h)| *h > 0).count();
    Ok(stats_json(
        address,
        confirmed,
        unconfirmed,
        conf,
        history.len() - conf,
    ))
}

/// `GET /address/{a}/utxo`: `[{ txid, vout, value, status }]`. With Electrum, every UTXO is
/// checked against its full previous transaction (hash, output, our script, amount).
pub async fn address_utxos(ctx: &UtxoCtx<'_>, address: &str) -> AppResult<Value> {
    let a = check_address(ctx, address)?;
    match backend(ctx)? {
        Backend::Esplora(base) => {
            let v = get_json(ctx, &base, &format!("/address/{a}/utxo")).await?;
            if !v.is_array() {
                return Err(bad(format!(
                    "{} : réponse /utxo inattendue",
                    ctx.coin.name()
                )));
            }
            Ok(v)
        }
        Backend::Electrum(targets) => {
            let (sh, spk) = scripthash(ctx, &a)?;
            let mut conn = electrum_session(ctx, &targets).await?;
            let list = conn
                .call("blockchain.scripthash.listunspent", json!([sh]))
                .await?;
            let claimed = parse_listunspent(ctx.coin, &list)?;
            if claimed.len() > MAX_UTXOS {
                return Err(AppError::InvalidInput(format!(
                    "{} : plus de {MAX_UTXOS} pièces sur {a} — Kyro vérifie chacune ; utilise ton \
                     propre serveur pour une adresse aussi active",
                    ctx.coin.name()
                )));
            }
            let mut raws = HashMap::new();
            fetch_raws(
                ctx,
                &mut conn,
                claimed.iter().map(|u| u.txid.clone()),
                &mut raws,
            )
            .await?;
            verified_utxos(ctx.coin, &claimed, &raws, &spk)
        }
    }
}

/// `GET /address/{a}/txs`, paginated like Bitcoin: unconfirmed first, then newest confirmed,
/// 50 at most.
pub async fn address_txs(ctx: &UtxoCtx<'_>, address: &str) -> AppResult<Value> {
    let a = check_address(ctx, address)?;
    match backend(ctx)? {
        Backend::Esplora(base) => {
            let first = get_json(ctx, &base, &format!("/address/{a}/txs")).await?;
            let first = first.as_array().cloned().unwrap_or_default();
            let txs = paginate_esplora(first, MAX_TXS, |last| {
                let (base, path) = (base.clone(), format!("/address/{a}/txs/chain/{last}"));
                async move {
                    Ok(get_json(ctx, &base, &path)
                        .await?
                        .as_array()
                        .cloned()
                        .unwrap_or_default())
                }
            })
            .await?;
            Ok(Value::Array(txs))
        }
        Backend::Electrum(targets) => {
            let (sh, spk) = scripthash(ctx, &a)?;
            let mut conn = electrum_session(ctx, &targets).await?;
            let hist = conn
                .call("blockchain.scripthash.get_history", json!([sh]))
                .await?;
            let mut order = parse_history(ctx.coin, &hist)?;
            // Mempool first, then newest confirmed first; keep the most recent MAX_TXS.
            order.sort_by_key(|(_, h)| if *h > 0 { -*h } else { i64::MIN });
            order.truncate(MAX_TXS);
            let mut raws = HashMap::new();
            fetch_raws(
                ctx,
                &mut conn,
                order.iter().map(|(t, _)| t.clone()),
                &mut raws,
            )
            .await?;
            let prevs: Vec<String> = order
                .iter()
                .filter_map(|(t, _)| raws.get(t))
                .flat_map(|tx| tx.inputs.iter().map(|(p, _)| p.clone()))
                .collect();
            fetch_raws(ctx, &mut conn, prevs, &mut raws).await?;
            let order = involving(order, &raws, &spk);
            let heights: Vec<i64> = order
                .iter()
                .map(|(_, h)| *h)
                .filter(|h| *h > 0)
                .collect::<HashSet<_>>()
                .into_iter()
                .collect();
            let mut times = HashMap::new();
            for chunk in heights.chunks(ELECTRUM_CHUNK) {
                let calls: Vec<(&str, Value)> = chunk
                    .iter()
                    .map(|h| ("blockchain.block.header", json!([h])))
                    .collect();
                for (h, hex) in chunk.iter().zip(conn.batch(&calls).await?) {
                    if let Some(t) = hex.as_str().and_then(header_time) {
                        times.insert(*h, t);
                    }
                }
            }
            Ok(Value::Array(esplora_txs(&order, &raws, &times)))
        }
    }
}

/// The full previous transaction (Dogecoin PSBTs need it as `non_witness_utxo`). The answer
/// must decode and hash to `txid`.
pub async fn tx_hex(ctx: &UtxoCtx<'_>, txid: &str) -> AppResult<String> {
    let t = check_txid(txid)?;
    let hex_tx = match backend(ctx)? {
        Backend::Esplora(base) => {
            let body = get(ctx, &base, &format!("/tx/{t}/hex")).await?;
            String::from_utf8_lossy(&body).trim().to_owned()
        }
        Backend::Electrum(targets) => {
            let mut conn = electrum_session(ctx, &targets).await?;
            let r = conn
                .call("blockchain.transaction.get", json!([t, false]))
                .await?;
            r.as_str().unwrap_or_default().trim().to_owned()
        }
    };
    wallet_core::verify_tx_hex(&hex_tx, &t).map_err(|_| {
        bad(format!(
            "{} : le serveur a renvoyé une transaction illisible ou différente de {t}",
            ctx.coin.name()
        ))
    })?;
    // Dogecoin: no witness data (refused by the chain decoder).
    wallet_core::utxo_decode_raw_tx(&hex_tx, ctx.network, ctx.coin)
        .map_err(|_| bad(format!("{} : transaction illisible", ctx.coin.name())))?;
    Ok(hex_tx)
}

/// mempool shape `{ fastestFee, halfHourFee, hourFee, economyFee, minimumFee }`, in the chain's
/// smallest unit per vbyte (Litecoin: litoshis/vB; Dogecoin: koinus/byte, no SegWit).
///
/// Dogecoin: the ladder is clamped to [0.01, 1] DOGE/kB (Dogecoin Core's recommended minimum and
/// 100× it); if the server has no estimate, the policy value (0.01 DOGE/kB) is returned with
/// `source: "policy"`.
pub async fn fee_rates(ctx: &UtxoCtx<'_>) -> AppResult<Value> {
    let raw = match backend(ctx)? {
        // mempool-style servers (litecoinspace.org) first, then plain electrs. A 404 means "this
        // server has no such endpoint"; any other failure is the server's and is returned as is.
        Backend::Esplora(base) => match get_json_opt(ctx, &base, "/v1/fees/recommended").await? {
            Some(v) if v.get("fastestFee").is_some() => Some(v),
            _ => get_json_opt(ctx, &base, "/fee-estimates")
                .await?
                .filter(|est| est.as_object().is_some_and(|m| !m.is_empty()))
                .map(|est| fees_from_estimates(&est)),
        },
        // Dogecoin: one block a minute, so 2 / 30 / 60 / 144 blocks ≈ 2 min / ½ h / 1 h / day.
        Backend::Electrum(targets) => {
            let mut conn = electrum_session(ctx, &targets).await?;
            let r = conn
                .batch(&[
                    ("blockchain.estimatefee", json!([2])),
                    ("blockchain.estimatefee", json!([30])),
                    ("blockchain.estimatefee", json!([60])),
                    ("blockchain.estimatefee", json!([144])),
                    ("blockchain.relayfee", json!([])),
                ])
                .await?;
            electrum_fees(&r)
        }
    };
    Ok(match ctx.coin {
        UtxoCoin::Litecoin => {
            let v = raw.ok_or_else(|| bad("Litecoin : aucune estimation de frais"))?;
            ladder(&v, 1, u64::MAX)
        }
        UtxoCoin::Dogecoin => match raw {
            Some(v) => ladder(&v, DOGE_FEE_FLOOR, DOGE_FEE_CEIL),
            None => {
                let f = DOGE_FEE_FLOOR;
                json!({ "fastestFee": f, "halfHourFee": f, "hourFee": f, "economyFee": f,
                        "minimumFee": f, "source": "policy" })
            }
        },
    })
}

/// Electrum estimates (coin/kB) → mempool-shaped ladder input; `None` if none is known.
fn electrum_fees(r: &[Value]) -> Option<Value> {
    let keys = [
        "fastestFee",
        "halfHourFee",
        "hourFee",
        "economyFee",
        "minimumFee",
    ];
    let mut m = serde_json::Map::new();
    for (k, v) in keys.iter().zip(r) {
        if let Some(f) = per_kb_to_unit_per_byte(v) {
            m.insert((*k).into(), json!(f));
        }
    }
    // Only a relay fee is not an estimate.
    m.keys()
        .any(|k| k != "minimumFee")
        .then_some(Value::Object(m))
}

/// Like `get_json`, but `Ok(None)` when the server answers 404 (endpoint not implemented).
async fn get_json_opt(ctx: &UtxoCtx<'_>, base: &str, path: &str) -> AppResult<Option<Value>> {
    let (status, body) = ctx
        .net_client
        .server_request(
            ServerRequest::get(url(base, path)?, utxo_family(ctx.coin)),
            ctx.tor,
        )
        .await?;
    match status {
        200 => serde_json::from_slice(&body)
            .map(Some)
            .map_err(|_| bad(format!("{} : JSON invalide sur {path}", ctx.coin.name()))),
        404 => Ok(None),
        other => Err(bad(format!(
            "{} : HTTP {other} sur {path}",
            ctx.coin.name()
        ))),
    }
}

/// Monotonic ladder clamped into `[floor, ceil]`.
fn ladder(v: &Value, floor: u64, ceil: u64) -> Value {
    let at = |k: &str| {
        v.get(k)
            .and_then(Value::as_f64)
            .filter(|f| f.is_finite() && *f >= 0.0)
            .map(|f| (f.ceil() as u64).clamp(floor, ceil))
    };
    let minimum = at("minimumFee").unwrap_or(floor);
    let economy = at("economyFee").unwrap_or(minimum).max(minimum);
    let hour = at("hourFee").unwrap_or(economy).max(economy);
    let half = at("halfHourFee").unwrap_or(hour).max(hour);
    let fastest = at("fastestFee").unwrap_or(half).max(half);
    json!({ "fastestFee": fastest, "halfHourFee": half, "hourFee": hour,
            "economyFee": economy, "minimumFee": minimum })
}

/// `GET /blocks/tip/height`.
pub async fn tip_height(ctx: &UtxoCtx<'_>) -> AppResult<u64> {
    match backend(ctx)? {
        Backend::Esplora(base) => {
            String::from_utf8_lossy(&get(ctx, &base, "/blocks/tip/height").await?)
                .trim()
                .parse()
                .map_err(|_| bad(format!("{} : hauteur invalide", ctx.coin.name())))
        }
        Backend::Electrum(targets) => {
            let mut conn = electrum_session(ctx, &targets).await?;
            let r = conn.call("blockchain.headers.subscribe", json!([])).await?;
            r.get("height")
                .and_then(Value::as_u64)
                .ok_or_else(|| bad(format!("{} : hauteur invalide", ctx.coin.name())))
        }
    }
}

/// Broadcast → txid. The transaction is decoded first (refused if malformed, or with witness
/// data on Dogecoin) and the server's txid must equal ours.
pub async fn broadcast(ctx: &UtxoCtx<'_>, hex_tx: &str) -> AppResult<String> {
    let decoded = wallet_core::utxo_decode_raw_tx(hex_tx, ctx.network, ctx.coin)?;
    match backend(ctx)? {
        Backend::Esplora(base) => {
            let req = ServerRequest {
                url: url(&base, "/tx")?,
                method: Method::Post,
                headers: vec![("content-type".into(), "text/plain".into())],
                body: Some(hex_tx.trim().as_bytes().to_vec()),
                family: utxo_family(ctx.coin),
                direct_private: false,
                long: false,
            };
            let (status, body) = ctx.net_client.server_request(req, ctx.tor).await?;
            let text = String::from_utf8_lossy(&body).trim().to_owned();
            if status != 200 {
                return Err(AppError::InvalidInput(format!(
                    "diffusion refusée : {}",
                    text.chars().take(300).collect::<String>()
                )));
            }
            check_broadcast_txid(&text, &decoded.txid)
        }
        Backend::Electrum(targets) => {
            let mut conn = electrum_session(ctx, &targets).await?;
            // A refusal by the node comes back as an Electrum error (`INVALID_INPUT`).
            let r = conn
                .call("blockchain.transaction.broadcast", json!([hex_tx.trim()]))
                .await?;
            check_broadcast_txid(r.as_str().unwrap_or_default(), &decoded.txid)
        }
    }
}

fn check_broadcast_txid(answer: &str, ours: &str) -> AppResult<String> {
    if answer.trim() != ours {
        return Err(bad(format!(
            "le serveur a répondu un txid inattendu ({})",
            answer.chars().take(80).collect::<String>()
        )));
    }
    Ok(ours.to_owned())
}

/// Checks that the server is reachable and on the right chain: its genesis hash must be the
/// chain's (Litecoin mainnet/testnet4, Dogecoin mainnet/testnet).
pub async fn probe(ctx: &UtxoCtx<'_>) -> AppResult<Detected> {
    let base = match backend(ctx)? {
        Backend::Esplora(base) => base,
        Backend::Electrum(targets) => {
            let mut conn = electrum_session(ctx, &targets).await?;
            let r = conn
                .batch(&[
                    ("server.features", json!([])),
                    ("blockchain.headers.subscribe", json!([])),
                ])
                .await?;
            return Ok(Detected {
                network: Some(network_label(ctx.coin, ctx.network).into()),
                genesis_hash: Some(check_genesis(ctx, &r[0])?),
                server_version: r[0]
                    .get("server_version")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                block_height: r[1].get("height").and_then(Value::as_u64),
                ..Default::default()
            });
        }
    };
    let expected = wallet_core::utxo_genesis_hash(ctx.network, ctx.coin);
    let genesis = String::from_utf8_lossy(&get(ctx, &base, "/block-height/0").await?)
        .trim()
        .to_owned();
    if genesis != expected {
        let what = [
            (UtxoCoin::Litecoin, Network::Mainnet),
            (UtxoCoin::Litecoin, Network::Testnet),
            (UtxoCoin::Dogecoin, Network::Mainnet),
            (UtxoCoin::Dogecoin, Network::Testnet),
        ]
        .into_iter()
        .find(|(c, n)| wallet_core::utxo_genesis_hash(*n, *c) == genesis)
        .map_or_else(
            || format!("genesis {}", genesis.chars().take(64).collect::<String>()),
            |(c, n)| format!("{} {}", c.name(), network_label(c, n)),
        );
        return Err(AppError::ServerWrongNetwork(format!(
            "le serveur n'est pas sur {} {} (trouvé : {what})",
            ctx.coin.name(),
            network_label(ctx.coin, ctx.network)
        )));
    }
    let height = tip_height(ctx).await.ok();
    Ok(Detected {
        network: Some(network_label(ctx.coin, ctx.network).into()),
        genesis_hash: Some(genesis),
        block_height: height,
        ..Default::default()
    })
}

pub fn network_label(coin: UtxoCoin, net: Network) -> &'static str {
    match (coin, net) {
        (_, Network::Mainnet) => "mainnet",
        (UtxoCoin::Litecoin, Network::Testnet) => "testnet4",
        (UtxoCoin::Dogecoin, Network::Testnet) => "testnet",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx(net: &NetClient, coin: UtxoCoin, server: UtxoServer) -> UtxoCtx<'_> {
        UtxoCtx {
            net_client: net,
            network: Network::Testnet,
            coin,
            tor: true,
            server,
        }
    }

    fn esplora(b: Backend) -> String {
        match b {
            Backend::Esplora(u) => u,
            other => panic!("expected Esplora, got {other:?}"),
        }
    }

    #[test]
    fn default_servers() {
        let n = NetClient::new(std::env::temp_dir().join("kyro-utxo-test")).unwrap();
        assert_eq!(
            esplora(backend(&ctx(&n, UtxoCoin::Litecoin, UtxoServer::Default)).unwrap()),
            "https://litecoinspace.org/testnet/api"
        );
        // Dogecoin testnet: no public default, a typed error that says what to do.
        let e = backend(&ctx(&n, UtxoCoin::Dogecoin, UtxoServer::Default)).unwrap_err();
        assert!(matches!(e, AppError::ServerInvalid(ref m) if m.contains("electrs-dogecoin")));
        // Dogecoin mainnet: the allowlisted ElectrumX servers, in order, TLS validated normally.
        let main = UtxoCtx {
            network: Network::Mainnet,
            ..ctx(&n, UtxoCoin::Dogecoin, UtxoServer::Default)
        };
        let b = backend(&main).unwrap();
        assert_eq!(b.label(), "doge.electrum1.cipig.net");
        let Backend::Electrum(t) = b else {
            panic!("electrum expected")
        };
        assert_eq!(t.len(), 2);
        assert!(t
            .iter()
            .all(|t| t.port == 20060 && t.tls == TlsMode::Webpki));
        assert!(t.iter().all(|t| electrum_default_allowed(
            &t.host,
            t.port,
            crate::net::Family::Dogecoin
        )));
        // The user's server replaces the default.
        let custom = UtxoCtx {
            server: UtxoServer::Esplora {
                url: "https://doge.example/api".into(),
            },
            ..main
        };
        assert_eq!(
            esplora(backend(&custom).unwrap()),
            "https://doge.example/api"
        );
        // A custom server is re-validated at use (plain http refused).
        let e = backend(&ctx(
            &n,
            UtxoCoin::Dogecoin,
            UtxoServer::Esplora {
                url: "http://doge.example/api".into(),
            },
        ));
        assert!(matches!(e, Err(AppError::ServerInvalid(_))));
    }

    #[test]
    fn inputs_are_checked_before_any_request() {
        let n = NetClient::new(std::env::temp_dir().join("kyro-utxo-test2")).unwrap();
        let c = ctx(&n, UtxoCoin::Litecoin, UtxoServer::Default);
        tauri::async_runtime::block_on(async {
            // A Bitcoin address, a mainnet address, a path injection: refused locally.
            for a in [
                "tb1qkvwu9g3k2pdxewfqr7syz89r3gj557l3uuf9r9",
                "ltc1qcgnevr9rp7aazy62m4gen0tfzlssa52axwytt6",
                "../../blocks/tip/height",
            ] {
                assert!(matches!(
                    address_info(&c, a).await,
                    Err(AppError::InvalidInput(_))
                ));
            }
            assert!(matches!(
                tx_hex(&c, "../x").await,
                Err(AppError::InvalidInput(_))
            ));
            assert!(matches!(
                broadcast(&c, "00").await,
                Err(AppError::InvalidInput(_))
            ));
        });
    }

    #[test]
    fn broadcast_txid_must_match() {
        let t = "09062ef6f449e49f025c7b7c61badfccd652872bbf20ea5b861a7645d238b300";
        assert_eq!(check_broadcast_txid(&format!("{t}\n"), t).unwrap(), t);
        assert!(matches!(
            check_broadcast_txid(&"0".repeat(64), t),
            Err(AppError::ServerUnreachable(_))
        ));
        assert!(check_broadcast_txid("", t).is_err());
    }

    #[test]
    fn fee_ladders() {
        // litecoinspace.org answer (2026-10-30): everything at 1 litoshi/vB.
        let v = json!({ "fastestFee": 1, "halfHourFee": 1, "hourFee": 1, "economyFee": 1, "minimumFee": 1 });
        assert_eq!(ladder(&v, 1, u64::MAX), v);
        // Dogecoin estimates in koinus/byte are clamped to [0.01, 1] DOGE/kB.
        let v = json!({ "fastestFee": 5_000_000.0, "halfHourFee": 2_240, "hourFee": 100, "economyFee": 1, "minimumFee": 1 });
        assert_eq!(
            ladder(&v, DOGE_FEE_FLOOR, DOGE_FEE_CEIL),
            json!({ "fastestFee": 100_000, "halfHourFee": 2_240, "hourFee": 1_000, "economyFee": 1_000, "minimumFee": 1_000 })
        );
        let v = json!({ "fastestFee": "x", "minimumFee": -3 });
        assert_eq!(ladder(&v, 1_000, 100_000)["fastestFee"], 1_000);
    }

    /// Real, read-only answers of `doge.electrum1.cipig.net:20060` (ElectrumX 2.0.0) for
    /// `DSBM4ZW9Dz8jLJuPUBe623ch4yxNkXdV1h` (2 transactions, 1 coin), recorded 2026-10-31:
    /// `server.features`, `scripthash.get_balance` / `get_history` / `listunspent`,
    /// `transaction.get` of the history and of its previous transactions, `block.header`,
    /// `estimatefee`, `relayfee`, `headers.subscribe`. Nothing was ever broadcast.
    const RECORDED: &str = include_str!("testdata/doge_electrum_mainnet.json");

    struct Recorded {
        v: Value,
        raws: HashMap<String, BtcRawTx>,
    }

    fn recorded() -> Recorded {
        let v: Value = serde_json::from_str(RECORDED).unwrap();
        let mut raws = HashMap::new();
        for (txid, raw) in v["transactions"].as_object().unwrap() {
            let tx = verified_raw(UtxoCoin::Dogecoin, Network::Mainnet, txid, raw).unwrap();
            raws.insert(txid.clone(), tx);
        }
        Recorded { v, raws }
    }

    fn doge_main(n: &NetClient) -> UtxoCtx<'_> {
        UtxoCtx {
            network: Network::Mainnet,
            ..ctx(n, UtxoCoin::Dogecoin, UtxoServer::Default)
        }
    }

    const ADDR: &str = "DSBM4ZW9Dz8jLJuPUBe623ch4yxNkXdV1h";
    const SPK: &str = "76a914e6c7989b8836301af965531c39865a73d745e46788ac";
    const RECEIVED: &str = "386f6e9cc89fcc9d2ceb037677bdfd65d8ff2c46a371be688069784d1b3711c5";
    const SPENT_BY: &str = "91ac15690017a0aa953a696ee5dd63350ca2f270764c8b1f3c7ecff27b47b9f8";
    const UNRELATED: &str = "7618443203806e0d93f7cfd2fc1c3d29ddce290b1d049e12a454ce442238539d";

    #[test]
    fn recorded_mainnet_server_identity_and_balance() {
        let n = NetClient::new(std::env::temp_dir().join("kyro-utxo-rec")).unwrap();
        let r = recorded();
        let c = doge_main(&n);
        // Our scripthash is the server's key for this address.
        assert_eq!(
            scripthash(&c, ADDR).unwrap(),
            (
                r.v["scripthash"].as_str().unwrap().to_owned(),
                SPK.to_owned()
            )
        );
        // Genesis: Dogecoin mainnet accepted; the same server for testnet is refused.
        assert_eq!(
            check_genesis(&c, &r.v["server.features"]).unwrap(),
            wallet_core::utxo_genesis_hash(Network::Mainnet, UtxoCoin::Dogecoin)
        );
        let t = UtxoCtx {
            network: Network::Testnet,
            ..doge_main(&n)
        };
        assert!(matches!(
            check_genesis(&t, &r.v["server.features"]),
            Err(AppError::ServerWrongNetwork(_))
        ));
        assert!(check_genesis(&c, &json!({})).is_err());

        let info = electrum_info(
            UtxoCoin::Dogecoin,
            ADDR,
            &r.v["get_balance"],
            &r.v["get_history"],
        )
        .unwrap();
        assert_eq!(info["address"], ADDR);
        assert_eq!(info["chain_stats"]["tx_count"], 2);
        assert_eq!(info["mempool_stats"]["tx_count"], 0);
        let net = info["chain_stats"]["funded_txo_sum"].as_i64().unwrap()
            - info["chain_stats"]["spent_txo_sum"].as_i64().unwrap();
        assert_eq!(net, 323_699_023, "3.23699023 DOGE");
        // Strict types: a float, a string or a negative confirmed balance is refused.
        for bad in [
            json!({ "confirmed": 1.5, "unconfirmed": 0 }),
            json!({ "confirmed": "323699023", "unconfirmed": 0 }),
            json!({ "confirmed": -1, "unconfirmed": 0 }),
            json!({ "confirmed": 1 }),
        ] {
            assert!(electrum_info(UtxoCoin::Dogecoin, ADDR, &bad, &r.v["get_history"]).is_err());
        }
        assert_eq!(
            r.v["tip"]["height"].as_u64().unwrap(),
            6_438_713,
            "headers.subscribe"
        );
    }

    #[test]
    fn recorded_mainnet_utxos_come_from_the_verified_previous_transaction() {
        let r = recorded();
        let claimed = parse_listunspent(UtxoCoin::Dogecoin, &r.v["listunspent"]).unwrap();
        assert_eq!(
            claimed,
            vec![ClaimedUtxo {
                txid: SPENT_BY.into(),
                vout: 2,
                value: 323_699_023,
                height: 6_436_585
            }]
        );
        let ok = verified_utxos(UtxoCoin::Dogecoin, &claimed, &r.raws, SPK).unwrap();
        assert_eq!(
            ok,
            json!([{ "txid": SPENT_BY, "vout": 2, "value": 323_699_023u64,
                     "status": { "confirmed": true, "block_height": 6_436_585 } }])
        );

        // (1) A server lying about the amount (+1 koinu, or ×10): refused.
        for lie in [323_699_024, 3_236_990_230] {
            let mut c = claimed.clone();
            c[0].value = lie;
            let e = verified_utxos(UtxoCoin::Dogecoin, &c, &r.raws, SPK).unwrap_err();
            assert!(
                e.to_string().contains("la transaction dit 323699023"),
                "{e}"
            );
        }
        // (2) A previous transaction with another hash than the claimed txid: refused when it
        // is fetched (before it can feed any amount), and a coin whose transaction could not be
        // fetched is refused.
        let other = &r.v["transactions"][RECEIVED];
        let e = verified_raw(UtxoCoin::Dogecoin, Network::Mainnet, SPENT_BY, other).unwrap_err();
        assert!(e.to_string().contains("différente"), "{e}");
        assert!(verified_raw(UtxoCoin::Dogecoin, Network::Mainnet, SPENT_BY, &json!(42)).is_err());
        let mut missing = r.raws.clone();
        missing.remove(SPENT_BY);
        assert!(verified_utxos(UtxoCoin::Dogecoin, &claimed, &missing, SPK).is_err());
        // (3) An output that pays someone else (vout 0 of the same transaction), or that does
        // not exist: refused.
        for vout in [0, 3, u32::MAX] {
            let mut c = claimed.clone();
            c[0].vout = vout;
            assert!(verified_utxos(UtxoCoin::Dogecoin, &c, &r.raws, SPK).is_err());
        }
        // Another address's script: the coin is not ours.
        let theirs = &r.raws[SPENT_BY].outputs[0].2;
        assert!(verified_utxos(UtxoCoin::Dogecoin, &claimed, &r.raws, theirs).is_err());

        // Strict listing types: txid of 64 hex, integer koinus, u32 vout, integer height.
        let base = r.v["listunspent"][0].clone();
        for (k, bad) in [
            ("tx_hash", json!("91ac")),
            ("tx_hash", json!(format!("{}zz", &SPENT_BY[..62]))),
            ("tx_pos", json!(-1)),
            ("tx_pos", json!(4_294_967_296u64)),
            ("value", json!(3.5)),
            ("value", json!(-5)),
            ("value", json!("323699023")),
            ("height", json!("6436585")),
        ] {
            let mut u = base.clone();
            u[k] = bad;
            assert!(
                parse_listunspent(UtxoCoin::Dogecoin, &json!([u])).is_err(),
                "{k}"
            );
        }
        assert!(parse_listunspent(UtxoCoin::Dogecoin, &json!({})).is_err());
    }

    #[test]
    fn recorded_mainnet_history_and_fees() {
        let r = recorded();
        let order = parse_history(UtxoCoin::Dogecoin, &r.v["get_history"]).unwrap();
        assert_eq!(
            order,
            vec![(RECEIVED.into(), 6_436_571), (SPENT_BY.into(), 6_436_585)]
        );
        // An unrelated transaction injected into the history is dropped.
        let mut injected = order.clone();
        injected.push((UNRELATED.into(), 6_436_000));
        let kept = involving(injected, &r.raws, SPK);
        assert_eq!(kept, order);
        let times: HashMap<i64, u64> = r.v["headers"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(h, hex)| {
                (
                    h.parse().unwrap(),
                    header_time(hex.as_str().unwrap()).unwrap(),
                )
            })
            .collect();
        let txs = esplora_txs(&kept, &r.raws, &times);
        assert_eq!(txs.len(), 2);
        // Received 84.98984610 DOGE on output 0, then spent with 3.23699023 DOGE of change.
        assert_eq!(txs[0]["txid"], RECEIVED);
        assert_eq!(txs[0]["vout"][0]["scriptpubkey_address"], ADDR);
        assert_eq!(txs[0]["vout"][0]["value"], 8_498_984_610u64);
        assert_eq!(txs[1]["vin"][0]["prevout"]["scriptpubkey_address"], ADDR);
        assert_eq!(txs[1]["vout"][2]["value"], 323_699_023);
        assert!(txs[1]["status"]["block_time"].as_u64().unwrap() > 1_700_000_000);
        // Strict history: a bad txid or a missing height is refused, duplicates collapse.
        assert!(parse_history(
            UtxoCoin::Dogecoin,
            &json!([{ "tx_hash": "x", "height": 1 }])
        )
        .is_err());
        assert!(parse_history(UtxoCoin::Dogecoin, &json!([{ "tx_hash": RECEIVED }])).is_err());
        let dup =
            json!([{ "tx_hash": RECEIVED, "height": 1 }, { "tx_hash": RECEIVED, "height": 1 }]);
        assert_eq!(parse_history(UtxoCoin::Dogecoin, &dup).unwrap().len(), 1);

        // Fees: estimatefee(2) = 0.50731312 DOGE/kB, the others -1, relayfee 0.001 DOGE/kB.
        let answers: Vec<Value> = ["2", "30", "60", "144"]
            .iter()
            .map(|k| r.v["estimatefee"][*k].clone())
            .chain([r.v["relayfee"].clone()])
            .collect();
        let raw = electrum_fees(&answers).unwrap();
        assert_eq!(
            ladder(&raw, DOGE_FEE_FLOOR, DOGE_FEE_CEIL),
            json!({ "fastestFee": 50_732, "halfHourFee": 1_000, "hourFee": 1_000,
                    "economyFee": 1_000, "minimumFee": 1_000 })
        );
        // Bounds: never under 0.01 DOGE/kB (Dogecoin Core's recommended minimum, 10× the
        // 0.001 DOGE/kB relay floor), never over 1 DOGE/kB (wallet-core's high-fee threshold).
        assert_eq!(DOGE_FEE_FLOOR, 1_000);
        const { assert!(DOGE_FEE_FLOOR * 1_000 >= wallet_core::DOGE_MIN_RELAY_FEE_PER_KB) };
        assert_eq!(DOGE_FEE_CEIL * 1_000, 100_000_000);
        let absurd = electrum_fees(&[
            json!(5_000.0),
            json!(-1),
            json!(-1),
            json!(-1),
            json!(0.001),
        ])
        .unwrap();
        assert_eq!(
            ladder(&absurd, DOGE_FEE_FLOOR, DOGE_FEE_CEIL)["fastestFee"],
            100_000
        );
        // Only a relay fee (no estimate): the policy value is used instead.
        assert!(
            electrum_fees(&[json!(-1), json!(-1), json!(-1), json!(-1), json!(0.001)]).is_none()
        );
    }

    /// Live check without Tor's bootstrap cost: a capture made just before (read-only Electrum
    /// calls to `doge.electrum1.cipig.net:20060` — `server.features`, `get_balance`,
    /// `get_history`, `listunspent`, `transaction.get` of every coin, `estimatefee`, `relayfee`)
    /// is fed through the backend's own parsers and checks. File: `$KYRO_DOGE_CAPTURE` (JSON
    /// keyed by method, as `testdata/doge_electrum_mainnet.json`).
    /// `KYRO_DOGE_CAPTURE=… cargo test -p kyro-desktop --lib -- --ignored --nocapture doge_capture`
    #[test]
    #[ignore]
    fn doge_capture_through_the_parsers() {
        let path = std::env::var("KYRO_DOGE_CAPTURE").expect("KYRO_DOGE_CAPTURE");
        let v: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let n = NetClient::new(std::env::temp_dir().join("kyro-utxo-cap")).unwrap();
        let c = doge_main(&n);
        let a = v["address"].as_str().unwrap();
        check_genesis(&c, &v["server.features"]).unwrap();
        let info =
            electrum_info(UtxoCoin::Dogecoin, a, &v["get_balance"], &v["get_history"]).unwrap();
        let (_, spk) = scripthash(&c, a).unwrap();
        let claimed = parse_listunspent(UtxoCoin::Dogecoin, &v["listunspent"]).unwrap();
        let mut raws = HashMap::new();
        for (txid, raw) in v["transactions"].as_object().unwrap() {
            raws.insert(
                txid.clone(),
                verified_raw(UtxoCoin::Dogecoin, Network::Mainnet, txid, raw).unwrap(),
            );
        }
        let utxos = verified_utxos(UtxoCoin::Dogecoin, &claimed, &raws, &spk).unwrap();
        let sum: u64 = utxos
            .as_array()
            .unwrap()
            .iter()
            .map(|u| u["value"].as_u64().unwrap())
            .sum();
        let s = &info["chain_stats"];
        let bal = s["funded_txo_sum"].as_i64().unwrap() - s["spent_txo_sum"].as_i64().unwrap();
        let fees: Vec<Value> = ["2", "30", "60", "144"]
            .iter()
            .map(|k| v["estimatefee"][*k].clone())
            .chain([v["relayfee"].clone()])
            .collect();
        let ladder_v = electrum_fees(&fees)
            .map(|f| ladder(&f, DOGE_FEE_FLOOR, DOGE_FEE_CEIL))
            .unwrap_or_else(|| json!("policy"));
        eprintln!(
            "{} — {a}: balance {bal} koinus, {} history entries, {} coins verified against \
             {} previous transactions (sum {sum}); fees {ladder_v}",
            v["_source"],
            s["tx_count"],
            claimed.len(),
            raws.len()
        );
        assert_eq!(sum as i64, bal, "balance = sum of the verified coins");
        // One inflated amount on live data: the whole listing is refused.
        let mut lie = claimed.clone();
        lie[0].value += 1;
        assert!(verified_utxos(UtxoCoin::Dogecoin, &lie, &raws, &spk).is_err());
    }
}

/// Real-network tests over Tor. Run with
/// `cargo test -p kyro-desktop -- --ignored --nocapture utxo_live`.
#[cfg(test)]
mod live {
    use super::*;
    use crate::tor::TorState;
    use std::time::Instant;

    async fn wait_tor(net: &NetClient) {
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
    }

    const ABANDON: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    fn ltc_ctx(net: &NetClient) -> UtxoCtx<'_> {
        UtxoCtx {
            net_client: net,
            network: Network::Testnet,
            coin: UtxoCoin::Litecoin,
            tor: true,
            server: UtxoServer::Default,
        }
    }

    /// The public test wallet's first receive and change addresses (what the TS scan reads).
    fn abandon_addresses(seed: &wallet_core::Seed, n: u32) -> Vec<(bool, u32, String)> {
        let mut out = Vec::new();
        for change in [false, true] {
            for i in 0..n {
                let a = wallet_core::utxo_address(
                    seed,
                    Network::Testnet,
                    UtxoCoin::Litecoin,
                    0,
                    change,
                    i,
                )
                .unwrap();
                out.push((change, i, a));
            }
        }
        out
    }

    /// Litecoin testnet4 broadcast, phase 1 of 2: reads the public "abandon … about" wallet
    /// over Tor (`ltc_address_info` / `ltc_address_utxos` code) and writes it to
    /// `$KYRO_LTC_DUMP` for the TS adapter, which builds the self-send PSBT.
    /// `KYRO_LTC_DUMP=… cargo test -p kyro-desktop -- --ignored --nocapture ltc_broadcast_1_fetch`
    #[test]
    #[ignore]
    fn ltc_broadcast_1_fetch() {
        let out = std::env::var("KYRO_LTC_DUMP").expect("KYRO_LTC_DUMP");
        let net = NetClient::new(std::env::temp_dir().join("kyro-ltc-bcast")).unwrap();
        let seed = wallet_core::Mnemonic::parse(ABANDON).unwrap().to_seed("");
        tauri::async_runtime::block_on(async {
            wait_tor(&net).await;
            let c = ltc_ctx(&net);
            let mut info = serde_json::Map::new();
            let mut utxos = serde_json::Map::new();
            for (_, _, a) in abandon_addresses(&seed, 40) {
                info.insert(a.clone(), address_info(&c, &a).await.unwrap());
                utxos.insert(a.clone(), address_utxos(&c, &a).await.unwrap());
            }
            let fees = fee_rates(&c).await.unwrap();
            let dump = json!({ "info": info, "utxos": utxos, "fees": fees });
            std::fs::write(&out, serde_json::to_string_pretty(&dump).unwrap()).unwrap();
            eprintln!("wrote {out}; fees {fees}");
        });
    }

    /// Phase 2 of 2: reads the TS-built PSBT from `$KYRO_LTC_PSBT`, runs exactly what
    /// `ltc_sign_psbt` runs (decoding, dialog text, second dialog if required, signature,
    /// identical summary) — the native dialog itself cannot be shown headless, its text is
    /// printed — checks that every output pays this same public wallet, finalizes, then calls
    /// the `ltc_broadcast` code over Tor (txid check) and waits for `ltc_address_txs` to show it.
    /// Broadcasts only when `KYRO_LTC_BROADCAST=yes`.
    #[test]
    #[ignore]
    fn ltc_broadcast_2_sign_and_send() {
        use bitcoin::psbt::Psbt;
        use std::str::FromStr;
        let b64 = std::fs::read_to_string(std::env::var("KYRO_LTC_PSBT").expect("KYRO_LTC_PSBT"))
            .unwrap();
        let b64 = b64.trim();
        let seed = wallet_core::Mnemonic::parse(ABANDON).unwrap().to_seed("");
        let net = Network::Testnet;
        let coin = UtxoCoin::Litecoin;

        let summary = wallet_core::utxo_psbt_summary(&seed, net, coin, 0, b64).unwrap();
        eprintln!(
            "--- native dialog text ---\n{}\n--------------------------",
            crate::commands_utxo::describe_utxo(crate::i18n::Lang::Fr, &summary, net)
        );
        if summary.requires_extra_confirmation {
            eprintln!(
                "--- reinforced dialog ---\n{}",
                crate::commands_utxo::describe_utxo_extra(crate::i18n::Lang::Fr, &summary)
            );
        }
        // Self-send only: every output must be an address of this public wallet.
        let ours: Vec<String> = abandon_addresses(&seed, 40)
            .into_iter()
            .map(|(_, _, a)| a)
            .collect();
        for o in &summary.outputs {
            let a = o.address.as_deref().expect("standard output");
            assert!(ours.iter().any(|x| x == a), "{a} is not in the test wallet");
        }
        assert!(!summary.requires_extra_confirmation);
        assert!(summary.fee_per_kb <= 2_000, "minimum fee only");

        let (signed, again) = wallet_core::utxo_sign_psbt(&seed, net, coin, 0, b64).unwrap();
        assert_eq!(again, summary, "same summary as the dialog");
        let mut p = Psbt::from_str(&signed).unwrap();
        for input in &mut p.inputs {
            let (pk, sig) = input
                .partial_sigs
                .iter()
                .next()
                .map(|(k, s)| (*k, *s))
                .unwrap();
            input.final_script_witness = Some(bitcoin::Witness::p2wpkh(&sig, &pk.inner));
            input.partial_sigs.clear();
        }
        let tx = p.extract_tx_unchecked_fee_rate();
        let hex_tx = bitcoin::consensus::encode::serialize_hex(&tx);
        let txid = tx.compute_txid().to_string();
        eprintln!("signed tx {txid} ({} vB): {hex_tx}", tx.vsize());
        if std::env::var("KYRO_LTC_BROADCAST").as_deref() != Ok("yes") {
            eprintln!("KYRO_LTC_BROADCAST != yes: not broadcast");
            return;
        }
        let client = NetClient::new(std::env::temp_dir().join("kyro-ltc-bcast")).unwrap();
        tauri::async_runtime::block_on(async {
            wait_tor(&client).await;
            let c = ltc_ctx(&client);
            let got = broadcast(&c, &hex_tx).await.unwrap();
            assert_eq!(got, txid);
            eprintln!("BROADCAST OK: {got}");
            let dest = summary.outputs[0].address.clone().unwrap();
            for attempt in 0..20 {
                let txs = address_txs(&c, &dest).await.unwrap();
                if let Some(t) = txs
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|t| t["txid"] == txid.as_str())
                {
                    eprintln!(
                        "seen by ltc_address_txs({dest}) after {attempt} retries: status {}",
                        t["status"]
                    );
                    return;
                }
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            }
            panic!("{txid} not visible in ltc_address_txs");
        });
    }

    /// Self-send of one real UTXO to our own change address at 1 litoshi/vB, signed by
    /// wallet-core; returns a one-line report. Never broadcast.
    fn live_self_send(
        seed: &wallet_core::Seed,
        prev: &bitcoin::Transaction,
        vout: u32,
        prevout: bitcoin::TxOut,
    ) -> String {
        use bitcoin::bip32::{DerivationPath, Xpriv};
        use bitcoin::psbt::Psbt;
        use bitcoin::secp256k1::{Message, Secp256k1};
        use bitcoin::sighash::{EcdsaSighashType, SighashCache};
        use std::str::FromStr;
        let secp = Secp256k1::new();
        let master = Xpriv::new_master(bitcoin::NetworkKind::Test, &seed[..]).unwrap();
        let key = |p: &str| {
            let path = DerivationPath::from_str(p).unwrap();
            let k = master.derive_priv(&secp, &path).unwrap();
            (k.private_key.public_key(&secp), path)
        };
        let (pk, path) = key("m/84'/1'/0'/0/0");
        let (cpk, cpath) = key("m/84'/1'/0'/1/0");
        let fee = 110; // 1 input, 1 P2WPKH output: 109.5 vB
        let tx = bitcoin::Transaction {
            version: bitcoin::transaction::Version::TWO,
            lock_time: bitcoin::absolute::LockTime::ZERO,
            input: vec![bitcoin::TxIn {
                previous_output: bitcoin::OutPoint {
                    txid: prev.compute_txid(),
                    vout,
                },
                script_sig: bitcoin::ScriptBuf::new(),
                sequence: bitcoin::Sequence::ENABLE_RBF_NO_LOCKTIME,
                witness: bitcoin::Witness::new(),
            }],
            output: vec![bitcoin::TxOut {
                value: bitcoin::Amount::from_sat(prevout.value.to_sat() - fee),
                script_pubkey: bitcoin::ScriptBuf::new_p2wpkh(
                    &bitcoin::CompressedPublicKey(cpk).wpubkey_hash(),
                ),
            }],
        };
        let mut psbt = Psbt::from_unsigned_tx(tx).unwrap();
        psbt.inputs[0].witness_utxo = Some(prevout.clone());
        psbt.inputs[0]
            .bip32_derivation
            .insert(pk, (master.fingerprint(&secp), path));
        psbt.outputs[0]
            .bip32_derivation
            .insert(cpk, (master.fingerprint(&secp), cpath));
        let (signed, summary) = wallet_core::utxo_sign_psbt(
            seed,
            Network::Testnet,
            UtxoCoin::Litecoin,
            0,
            &psbt.to_string(),
        )
        .unwrap();
        assert!(summary.outputs[0].is_change && summary.warnings.is_empty());
        assert_eq!(summary.fee, fee.to_string());
        let signed = Psbt::from_str(&signed).unwrap();
        let (spk, sig) = signed.inputs[0].partial_sigs.iter().next().unwrap();
        let h = SighashCache::new(&signed.unsigned_tx)
            .p2wpkh_signature_hash(
                0,
                &prevout.script_pubkey,
                prevout.value,
                EcdsaSighashType::All,
            )
            .unwrap();
        secp.verify_ecdsa(&Message::from(h), &sig.signature, &spk.inner)
            .unwrap();
        format!(
            "fee {} litoshis, {} vB, signature verified",
            summary.fee, summary.size
        )
    }

    /// Dogecoin mainnet on Kyro's default (Komodo's public ElectrumX) over Tor, read-only, nothing
    /// is ever broadcast: probe (genesis), tip, fees (bounds), then, through the very code of
    /// `doge_address_info` / `_utxos` / `_txs` / `_tx_hex`, two public addresses:
    /// `DSBM4ZW9…V1h` (the recorded fixture: same coin, same amount if still unspent) and
    /// `DK4Ur92a…aXY` (≈ 40 coins, each checked against its previous transaction). Finally a
    /// lying server is simulated on live data: the real coin with an inflated amount is refused.
    /// `cargo test -p kyro-desktop -- --ignored --nocapture doge_live_mainnet`
    #[test]
    #[ignore]
    fn doge_live_mainnet_electrum_over_tor() {
        let net = NetClient::new(std::env::temp_dir().join("kyro-doge-live")).unwrap();
        tauri::async_runtime::block_on(async {
            wait_tor(&net).await;
            let c = UtxoCtx {
                net_client: &net,
                network: Network::Mainnet,
                coin: UtxoCoin::Dogecoin,
                tor: true,
                server: UtxoServer::Default,
            };
            let t = Instant::now();
            let d = probe(&c).await.unwrap();
            eprintln!("doge mainnet probe {d:?} in {:.1?}", t.elapsed());
            assert_eq!(
                d.genesis_hash.as_deref(),
                Some(wallet_core::utxo_genesis_hash(
                    Network::Mainnet,
                    UtxoCoin::Dogecoin
                ))
            );
            let tip = tip_height(&c).await.unwrap();
            assert!(tip > 6_438_000, "tip {tip}");
            let fees = fee_rates(&c).await.unwrap();
            eprintln!("doge fees {fees}");
            for k in [
                "fastestFee",
                "halfHourFee",
                "hourFee",
                "economyFee",
                "minimumFee",
            ] {
                let f = fees[k].as_u64().unwrap();
                assert!((DOGE_FEE_FLOOR..=DOGE_FEE_CEIL).contains(&f), "{k} {f}");
            }
            for a in [
                "DSBM4ZW9Dz8jLJuPUBe623ch4yxNkXdV1h",
                "DK4Ur92aP34VSk6PRM8KXRHXogjfFKbaXY",
            ] {
                let t = Instant::now();
                let info = address_info(&c, a).await.unwrap();
                let utxos = address_utxos(&c, a).await.unwrap();
                let txs = address_txs(&c, a).await.unwrap();
                let list = utxos.as_array().unwrap();
                let sum: u64 = list.iter().map(|u| u["value"].as_u64().unwrap()).sum();
                let s = &info["chain_stats"];
                let net_bal =
                    s["funded_txo_sum"].as_i64().unwrap() - s["spent_txo_sum"].as_i64().unwrap();
                eprintln!(
                    "  {a}: balance {net_bal} koinus, tx_count {}, {} verified utxos (sum {sum}), {} txs ({:.1?})",
                    s["tx_count"],
                    list.len(),
                    txs.as_array().unwrap().len(),
                    t.elapsed()
                );
                assert_eq!(info["address"], a);
                // Every confirmed coin was checked against its previous transaction.
                let confirmed: u64 = list
                    .iter()
                    .filter(|u| u["status"]["confirmed"] == true)
                    .map(|u| u["value"].as_u64().unwrap())
                    .sum();
                if info["mempool_stats"]["tx_count"] == 0 {
                    assert_eq!(confirmed as i64, net_bal, "balance = sum of verified coins");
                }
                for tx in txs.as_array().unwrap() {
                    let touches = tx["vout"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|o| o["scriptpubkey_address"] == a)
                        || tx["vin"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .any(|i| i["prevout"]["scriptpubkey_address"] == a);
                    assert!(touches, "{}", tx["txid"]);
                }
            }
            // The fixture's coin, if still unspent, is exactly what was recorded.
            let fixture = "91ac15690017a0aa953a696ee5dd63350ca2f270764c8b1f3c7ecff27b47b9f8";
            let utxos = address_utxos(&c, "DSBM4ZW9Dz8jLJuPUBe623ch4yxNkXdV1h")
                .await
                .unwrap();
            if let Some(u) = utxos
                .as_array()
                .unwrap()
                .iter()
                .find(|u| u["txid"] == fixture)
            {
                assert_eq!(u["vout"], 2);
                assert_eq!(u["value"], 323_699_023);
            }
            // Previous transaction fetched live, hash checked; a lying amount is refused.
            let hex_tx = tx_hex(&c, fixture).await.unwrap();
            let prev =
                wallet_core::utxo_decode_raw_tx(&hex_tx, Network::Mainnet, UtxoCoin::Dogecoin)
                    .unwrap();
            let raws = HashMap::from([(fixture.to_owned(), prev)]);
            let spk = "76a914e6c7989b8836301af965531c39865a73d745e46788ac";
            let real = ClaimedUtxo {
                txid: fixture.into(),
                vout: 2,
                value: 323_699_023,
                height: 6_436_585,
            };
            assert!(
                verified_utxos(UtxoCoin::Dogecoin, std::slice::from_ref(&real), &raws, spk).is_ok()
            );
            let lie = ClaimedUtxo {
                value: 32_369_902_300,
                ..real
            };
            assert!(verified_utxos(UtxoCoin::Dogecoin, &[lie], &raws, spk).is_err());
            eprintln!("live prev-tx check: real amount accepted, inflated amount refused");
        });
    }

    /// Litecoin testnet4 and mainnet on litecoinspace.org over Tor: genesis check, tip, fees,
    /// address info / UTXOs / history of the "abandon … about" testnet address (derived by
    /// wallet-core), a known transaction's hex (checked against its txid), a wrong-network
    /// probe, and Dogecoin's candidate public servers (reported, not required).
    #[test]
    #[ignore]
    fn utxo_live_litecoinspace_over_tor() {
        let net = NetClient::new(std::env::temp_dir().join("kyro-utxo-live")).unwrap();
        let seed = wallet_core::Mnemonic::parse(
            "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
        )
        .unwrap()
        .to_seed("");
        tauri::async_runtime::block_on(async {
            wait_tor(&net).await;
            for network in [Network::Testnet, Network::Mainnet] {
                let c = UtxoCtx {
                    net_client: &net,
                    network,
                    coin: UtxoCoin::Litecoin,
                    tor: true,
                    server: UtxoServer::Default,
                };
                let t = Instant::now();
                let d = probe(&c).await.unwrap();
                eprintln!("ltc {network:?} probe {d:?} in {:.1?}", t.elapsed());
                eprintln!("ltc {network:?} fees {}", fee_rates(&c).await.unwrap());
                for i in 0..3 {
                    let a =
                        wallet_core::utxo_address(&seed, network, UtxoCoin::Litecoin, 0, false, i)
                            .unwrap();
                    let t = Instant::now();
                    let info = address_info(&c, &a).await.unwrap();
                    let utxos = address_utxos(&c, &a).await.unwrap();
                    let txs = address_txs(&c, &a).await.unwrap();
                    eprintln!(
                        "  {a}: tx_count={} funded={} utxos={} txs={} ({:.1?})",
                        info["chain_stats"]["tx_count"],
                        info["chain_stats"]["funded_txo_sum"],
                        utxos.as_array().unwrap().len(),
                        txs.as_array().unwrap().len(),
                        t.elapsed()
                    );
                    assert_eq!(info["address"], a.as_str());
                }
            }
            let c = UtxoCtx {
                net_client: &net,
                network: Network::Testnet,
                coin: UtxoCoin::Litecoin,
                tor: true,
                server: UtxoServer::Default,
            };
            let txid = "09062ef6f449e49f025c7b7c61badfccd652872bbf20ea5b861a7645d238b300";
            let h = tx_hex(&c, txid).await.unwrap();
            eprintln!("tx_hex {txid}: {} hex chars", h.len());

            // Build and sign — NOT broadcast — a self-send spending a real testnet4 UTXO of the
            // public "abandon … about" wallet, if it has one: the prevout comes from the
            // server's raw transaction (checked against its txid), the signature is verified
            // against the BIP143 sighash recomputed here.
            let me =
                wallet_core::utxo_address(&seed, Network::Testnet, UtxoCoin::Litecoin, 0, false, 0)
                    .unwrap();
            let utxos = address_utxos(&c, &me).await.unwrap();
            // Largest one: the self-send output must stay above the 2 940-litoshi dust limit.
            let largest = utxos
                .as_array()
                .unwrap()
                .iter()
                .max_by_key(|u| u["value"].as_u64().unwrap_or(0))
                .filter(|u| u["value"].as_u64().unwrap_or(0) >= 110 + 2_940);
            if let Some(u) = largest {
                let (prev_txid, vout) = (u["txid"].as_str().unwrap(), u["vout"].as_u64().unwrap());
                let raw = tx_hex(&c, prev_txid).await.unwrap();
                let prev: bitcoin::Transaction =
                    bitcoin::consensus::deserialize(&hex::decode(&raw).unwrap()).unwrap();
                let prevout = prev.output[vout as usize].clone();
                assert_eq!(prevout.value.to_sat(), u["value"].as_u64().unwrap());
                let sign = live_self_send(&seed, &prev, vout as u32, prevout);
                eprintln!("signed (not broadcast) a self-send of {prev_txid}:{vout}: {sign}");
            } else {
                eprintln!("no testnet4 UTXO above dust on {me}: build/sign step skipped");
            }
            // A mainnet server for the testnet slot: wrong network, typed error.
            let wrong = UtxoCtx {
                server: UtxoServer::Esplora {
                    url: "https://litecoinspace.org/api".into(),
                },
                ..c
            };
            let e = probe(&wrong).await;
            eprintln!("wrong network: {e:?}");
            assert!(matches!(e, Err(AppError::ServerWrongNetwork(ref m)) if m.contains("mainnet")));

            // Dogecoin candidates (QED electrs demo). Informative: printed, not asserted.
            for (network, url) in [
                (Network::Testnet, "https://doge-electrs-testnet-demo.qed.me"),
                (Network::Mainnet, "https://doge-electrs-demo.qed.me"),
            ] {
                let d = UtxoCtx {
                    net_client: &net,
                    network,
                    coin: UtxoCoin::Dogecoin,
                    tor: true,
                    server: UtxoServer::Esplora { url: url.into() },
                };
                let t = Instant::now();
                eprintln!("doge {url}: {:?} in {:.1?}", probe(&d).await, t.elapsed());
            }
        });
    }
}
