//! Litecoin and Dogecoin data from an Esplora-compatible server, in **the same Esplora shapes**
//! as the `btc_*` commands (docs/IPC.md §2.2), so the TypeScript adapters reuse the Bitcoin
//! logic:
//!
//! | command                | Esplora                               |
//! |------------------------|---------------------------------------|
//! | `{ltc,doge}_address_info`  | `GET /address/{a}`                |
//! | `{ltc,doge}_address_utxos` | `GET /address/{a}/utxo`           |
//! | `{ltc,doge}_address_txs`   | `GET /address/{a}/txs` (+ `/txs/chain/{last}`, 50 max) |
//! | `{ltc,doge}_tx_hex`        | `GET /tx/{txid}/hex` (checked: it hashes to `txid`) |
//! | `{ltc,doge}_fee_rates`     | `GET /v1/fees/recommended`, else `GET /fee-estimates` |
//! | `{ltc,doge}_tip_height`    | `GET /blocks/tip/height`          |
//! | `{ltc,doge}_broadcast`     | `POST /tx` (returned txid must match) |
//!
//! Servers: Litecoin defaults to litecoinspace.org (mempool's Litecoin fork, mainnet and
//! testnet4); Dogecoin has **no** default (no free public API with a testnet and broadcast was
//! found, see docs/NETWORK.md) — the user sets an Esplora server (electrs-dogecoin).
//! Requests go through `NetClient::server_request` on the chain's own Tor family. There is
//! never a fallback: the chosen server fails, the command fails.

use serde_json::{json, Value};
use wallet_core::{Network, UtxoCoin};

use crate::btc_backend::{fees_from_estimates, paginate_esplora, Detected};
use crate::error::{AppError, AppResult};
use crate::net::{Method, NetClient, ServerRequest};
use crate::servers::{utxo_default_base, utxo_family, validate_http_url, UtxoServer};

/// Most recent transactions returned per address (same cap as Bitcoin).
const MAX_TXS: usize = 50;

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

fn bad(msg: impl Into<String>) -> AppError {
    AppError::ServerUnreachable(msg.into())
}

pub fn no_default_server(coin: UtxoCoin) -> AppError {
    AppError::ServerInvalid(format!(
        "{} : Kyro n'a pas de serveur public par défaut (aucune API publique gratuite et maintenue, \
         avec testnet et diffusion, n'a été trouvée). Configure ton serveur Esplora \
         (electrs-{}) dans Réglages → Réseaux.",
        coin.name(),
        coin.name().to_lowercase()
    ))
}

/// Esplora base URL of the configured (or default) server.
pub fn base(ctx: &UtxoCtx<'_>) -> AppResult<String> {
    match &ctx.server {
        UtxoServer::Default => utxo_default_base(ctx.coin, ctx.network)
            .map(str::to_owned)
            .ok_or_else(|| no_default_server(ctx.coin)),
        UtxoServer::Esplora { url } => {
            validate_http_url(url, ctx.tor, false)?;
            Ok(url.trim().to_owned())
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
    if t.len() != 64 || !t.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(AppError::InvalidInput(
            "txid : 64 caractères hexadécimaux".into(),
        ));
    }
    Ok(t)
}

/// `GET /address/{a}`: `{ address, chain_stats, mempool_stats }`.
pub async fn address_info(ctx: &UtxoCtx<'_>, address: &str) -> AppResult<Value> {
    let a = check_address(ctx, address)?;
    let base = base(ctx)?;
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

/// `GET /address/{a}/utxo`: `[{ txid, vout, value, status }]`.
pub async fn address_utxos(ctx: &UtxoCtx<'_>, address: &str) -> AppResult<Value> {
    let a = check_address(ctx, address)?;
    let base = base(ctx)?;
    let v = get_json(ctx, &base, &format!("/address/{a}/utxo")).await?;
    if !v.is_array() {
        return Err(bad(format!(
            "{} : réponse /utxo inattendue",
            ctx.coin.name()
        )));
    }
    Ok(v)
}

/// `GET /address/{a}/txs`, paginated like Bitcoin: unconfirmed first, then newest confirmed,
/// 50 at most.
pub async fn address_txs(ctx: &UtxoCtx<'_>, address: &str) -> AppResult<Value> {
    let a = check_address(ctx, address)?;
    let base = base(ctx)?;
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

/// `GET /tx/{txid}/hex`: the full previous transaction (Dogecoin PSBTs need it as
/// `non_witness_utxo`). The answer must decode and hash to `txid`.
pub async fn tx_hex(ctx: &UtxoCtx<'_>, txid: &str) -> AppResult<String> {
    let t = check_txid(txid)?;
    let base = base(ctx)?;
    let body = get(ctx, &base, &format!("/tx/{t}/hex")).await?;
    let hex_tx = String::from_utf8_lossy(&body).trim().to_owned();
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
    let base = base(ctx)?;
    // mempool-style servers (litecoinspace.org) first, then plain electrs. A 404 means "this
    // server has no such endpoint"; any other failure is the server's and is returned as is.
    let raw = match get_json_opt(ctx, &base, "/v1/fees/recommended").await? {
        Some(v) if v.get("fastestFee").is_some() => Some(v),
        _ => get_json_opt(ctx, &base, "/fee-estimates")
            .await?
            .filter(|est| est.as_object().is_some_and(|m| !m.is_empty()))
            .map(|est| fees_from_estimates(&est)),
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
    let base = base(ctx)?;
    String::from_utf8_lossy(&get(ctx, &base, "/blocks/tip/height").await?)
        .trim()
        .parse()
        .map_err(|_| bad(format!("{} : hauteur invalide", ctx.coin.name())))
}

/// `POST /tx` (hex) → txid. The transaction is decoded first (refused if malformed, or with
/// witness data on Dogecoin) and the server's txid must equal ours.
pub async fn broadcast(ctx: &UtxoCtx<'_>, hex_tx: &str) -> AppResult<String> {
    let decoded = wallet_core::utxo_decode_raw_tx(hex_tx, ctx.network, ctx.coin)?;
    let base = base(ctx)?;
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

fn check_broadcast_txid(answer: &str, ours: &str) -> AppResult<String> {
    if answer.trim() != ours {
        return Err(bad(format!(
            "le serveur a répondu un txid inattendu ({})",
            answer.chars().take(80).collect::<String>()
        )));
    }
    Ok(ours.to_owned())
}

/// Checks that the server is reachable and on the right chain: `GET /block-height/0` must be
/// the chain's genesis hash (Litecoin mainnet/testnet4, Dogecoin mainnet/testnet).
pub async fn probe(ctx: &UtxoCtx<'_>) -> AppResult<Detected> {
    let base = base(ctx)?;
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

    #[test]
    fn default_servers() {
        let n = NetClient::new(std::env::temp_dir().join("kyro-utxo-test")).unwrap();
        assert_eq!(
            base(&ctx(&n, UtxoCoin::Litecoin, UtxoServer::Default)).unwrap(),
            "https://litecoinspace.org/testnet/api"
        );
        // Dogecoin: no public default, a typed error that says what to do.
        let e = base(&ctx(&n, UtxoCoin::Dogecoin, UtxoServer::Default)).unwrap_err();
        assert!(matches!(e, AppError::ServerInvalid(ref m) if m.contains("electrs-dogecoin")));
        // A custom server is re-validated at use (plain http refused).
        let e = base(&ctx(
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
            crate::commands_utxo::describe_utxo(&summary, net)
        );
        if summary.requires_extra_confirmation {
            eprintln!(
                "--- reinforced dialog ---\n{}",
                crate::commands_utxo::describe_utxo_extra(&summary)
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
