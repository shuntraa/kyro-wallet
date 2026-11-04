//! Live smoke test of every mainnet chain, through the same contexts and backend calls as the
//! balance-refresh commands the UI uses (`*_account`, `*_address_info`, `net_fetch`, …), on a
//! fresh vault with default settings (Tor on, no custom server), like a new install.
//!
//! `cargo test -p kyro-desktop live_smoke -- --ignored --nocapture`
//! - `KYRO_SMOKE_CLEAR=yes`: Tor off (clear connections).
//! - `KYRO_SMOKE_WARM=yes`: wait for Tor before the first request (otherwise the requests start
//!   during the bootstrap, as the app does right after unlocking).
//! - `KYRO_SMOKE_ONLY=bitcoin,tron`: only these chains.

use std::future::Future;
use std::pin::Pin;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use wallet_core::{BtcKind, Network, UtxoCoin};

use crate::commands_hbar::OurKey;
use crate::net::FetchRequest;
use crate::state::AppState;
use crate::tor::TorState;

/// Chains hidden in this release (mirror of `HIDDEN_FAMILIES` in `packages/chains`: `hbar`):
/// skipped unless named in `KYRO_SMOKE_ONLY`.
const HIDDEN: &[&str] = &["hedera"];

type Check<'a> = Pin<Box<dyn Future<Output = Result<String, String>> + 'a>>;

fn e<E: std::fmt::Display>(x: E) -> String {
    x.to_string()
}

async fn rpc(state: &AppState, url: &str, method: &str, params: Value) -> Result<Value, String> {
    let req = FetchRequest {
        url: url.into(),
        method: "POST".into(),
        headers: [("content-type".to_owned(), "application/json".to_owned())].into(),
        body: Some(
            json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params }).to_string(),
        ),
    };
    let r = state
        .net
        .fetch(req, &state.settings(), &state.env_keys, state.network)
        .await
        .map_err(e)?;
    if r.status != 200 {
        return Err(format!(
            "HTTP {} {}",
            r.status,
            r.body.chars().take(120).collect::<String>()
        ));
    }
    let v: Value = serde_json::from_str(&r.body).map_err(e)?;
    v.get("result").cloned().ok_or_else(|| {
        format!(
            "no result: {}",
            r.body.chars().take(160).collect::<String>()
        )
    })
}

const EVM: &[(&str, &str)] = &[
    ("ethereum", "https://ethereum-rpc.publicnode.com"),
    ("arbitrum", "https://arbitrum-one-rpc.publicnode.com"),
    ("arb1", "https://arb1.arbitrum.io/rpc"),
    ("optimism", "https://optimism-rpc.publicnode.com"),
    ("base", "https://base-rpc.publicnode.com"),
    ("polygon", "https://polygon-bor-rpc.publicnode.com"),
    ("bsc", "https://bsc-rpc.publicnode.com"),
    ("avalanche", "https://avalanche-c-chain-rpc.publicnode.com"),
    ("cronos", "https://cronos-evm-rpc.publicnode.com"),
    ("mantle", "https://mantle-rpc.publicnode.com"),
    ("sonic", "https://sonic-rpc.publicnode.com"),
    ("flare", "https://rpc.ankr.com/flare"),
    ("kaia", "https://kaia.api.pocket.network"),
    ("gnosis", "https://gnosis-rpc.publicnode.com"),
    ("hyperevm", "https://hyperliquid-rpc.publicnode.com"),
    ("sei", "https://sei-evm-rpc.publicnode.com"),
    ("conflux", "https://evm.confluxrpc.com"),
];

/// Same scan as the TS Bitcoin adapter on a fresh wallet: 4 branches in parallel, 5/3 addresses each.
async fn btc_scan(state: &AppState, seed: &wallet_core::Seed) -> Result<String, String> {
    let s = state.settings();
    let c = crate::commands_servers::ctx(state, &s).map_err(e)?;
    let branch = |kind: BtcKind, change: bool| {
        let c = &c;
        async move {
            for i in 0..if change { 3 } else { 5 } {
                let a = wallet_core::btc_address(seed, Network::Mainnet, kind, 0, change, i)
                    .map_err(e)?;
                crate::btc_backend::address_info(c, &a).await.map_err(e)?;
            }
            Ok::<(), String>(())
        }
    };
    let r = futures_util::future::join_all([
        branch(BtcKind::Segwit, false),
        branch(BtcKind::Segwit, true),
        branch(BtcKind::Taproot, false),
        branch(BtcKind::Taproot, true),
    ])
    .await;
    for x in r {
        x?;
    }
    let funded = crate::btc_backend::address_info(&c, "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa")
        .await
        .map_err(e)?;
    let fees = crate::btc_backend::fee_rates(&c).await.map_err(e)?;
    let tip = crate::btc_backend::tip_height(&c).await.map_err(e)?;
    Ok(format!(
        "16 addr ok, genesis funded {} sat, fastest {} sat/vB, tip {tip}",
        funded["chain_stats"]["funded_txo_sum"], fees["fastestFee"]
    ))
}

async fn utxo(
    state: &AppState,
    seed: &wallet_core::Seed,
    coin: UtxoCoin,
) -> Result<String, String> {
    let c = crate::commands_utxo::ctx(state, coin);
    let a = wallet_core::utxo_address(seed, Network::Mainnet, coin, 0, false, 0).map_err(e)?;
    let info = crate::utxo_backend::address_info(&c, &a).await.map_err(e)?;
    let tip = crate::utxo_backend::tip_height(&c).await.map_err(e)?;
    let fees = crate::utxo_backend::fee_rates(&c).await;
    Ok(format!(
        "txs {}, tip {tip}, fees {}",
        info["chain_stats"]["tx_count"],
        fees.map_or_else(|x| format!("ERR {x}"), |f| f["fastestFee"].to_string())
    ))
}

fn checks<'a>(state: &'a AppState, seed: &'a wallet_core::Seed) -> Vec<(String, Check<'a>)> {
    let net = Network::Mainnet;
    let mut out: Vec<(String, Check<'a>)> = Vec::new();
    out.push(("bitcoin".into(), Box::pin(btc_scan(state, seed))));
    for (key, url) in EVM {
        out.push((
            (*key).into(),
            Box::pin(async move {
                let b = rpc(
                    state,
                    url,
                    "eth_getBalance",
                    json!(["0x0000000000000000000000000000000000000000", "latest"]),
                )
                .await?;
                let n = rpc(state, url, "eth_blockNumber", json!([])).await?;
                let g = rpc(state, url, "eth_gasPrice", json!([])).await?;
                Ok(format!("0x0 balance {b}, block {n}, gas {g}"))
            }),
        ));
    }
    out.push((
        "solana".into(),
        Box::pin(async move {
            let url = "https://api.mainnet-beta.solana.com";
            let b = rpc(
                state,
                url,
                "getBalance",
                json!(["So11111111111111111111111111111111111111112"]),
            )
            .await?;
            let s = rpc(state, url, "getSlot", json!([])).await?;
            Ok(format!("wSOL mint {} lamports, slot {s}", b["value"]))
        }),
    ));
    out.push((
        "litecoin".into(),
        Box::pin(utxo(state, seed, UtxoCoin::Litecoin)),
    ));
    out.push((
        "dogecoin".into(),
        Box::pin(utxo(state, seed, UtxoCoin::Dogecoin)),
    ));
    out.push((
        "bitcoincash".into(),
        Box::pin(utxo(state, seed, UtxoCoin::BitcoinCash)),
    ));
    out.push(("dash".into(), Box::pin(utxo(state, seed, UtxoCoin::Dash))));
    out.push((
        "zcash".into(),
        Box::pin(async move {
            let c = crate::commands_zcash::ctx(state);
            let a = wallet_core::zec_address(seed, net, 0, false, 0).map_err(e)?;
            let i = crate::zcash_backend::address_info(&c, &a)
                .await
                .map_err(e)?;
            let t = crate::zcash_backend::tip_height(&c).await.map_err(e)?;
            Ok(format!("txs {}, tip {t}", i["chain_stats"]["tx_count"]))
        }),
    ));
    out.push((
        "tron".into(),
        Box::pin(async move {
            let c = crate::commands_tron::ctx(state);
            let a = wallet_core::tron_address(seed, 0).map_err(e)?;
            let acc = crate::tron_backend::account(&c, &a).await.map_err(e)?;
            let usdt =
                crate::tron_backend::trc20_balance(&c, "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", &a)
                    .await
                    .map_err(e)?;
            let p = crate::tron_backend::params(&c).await.map_err(e)?;
            Ok(
                format!("balance {}, USDT {usdt}, params {:?}", acc.balance, p)
                    .chars()
                    .take(160)
                    .collect(),
            )
        }),
    ));
    out.push((
        "xrp".into(),
        Box::pin(async move {
            let c = crate::commands_xrp::ctx(state);
            let a = wallet_core::xrp_address(seed, 0).map_err(e)?;
            let info = crate::xrp_backend::server_info(&c).await.map_err(e)?;
            let acc = crate::xrp_backend::account(&c, &a, &info)
                .await
                .map_err(e)?;
            let f = crate::xrp_backend::fee(&c).await.map_err(e)?;
            Ok(format!("{acc:?} fee {f:?}").chars().take(160).collect())
        }),
    ));
    out.push((
        "hedera".into(),
        Box::pin(async move {
            let (evm, pk) = crate::commands_hbar::ours(state, 0).map_err(e)?;
            let c = crate::commands_hbar::ctx(state);
            let r = crate::commands_hbar::own_account(
                &c,
                OurKey::Ecdsa { evm: &evm, pk: &pk },
                evm.clone(),
            )
            .await
            .map_err(e)?;
            let big = crate::hbar_backend::account(&c, "0.0.98")
                .await
                .map_err(e)?;
            Ok(format!(
                "exists {}, 0.0.98 balance {}",
                r.info.exists, big.balance
            ))
        }),
    ));
    out.push((
        "cardano".into(),
        Box::pin(async move {
            let c = crate::commands_cardano::ctx(state);
            let a = state
                .with_cardano(|r| Ok(wallet_core::cardano_address(r, net, 0, 0)?))
                .map_err(e)?;
            let p = crate::cardano_backend::params(&c).await.map_err(e)?;
            let (acc, _) = crate::commands_cardano::account_and_utxos(&c, &a, &p)
                .await
                .map_err(e)?;
            Ok(format!("{acc:?}").chars().take(160).collect())
        }),
    ));
    out.push((
        "stellar".into(),
        Box::pin(async move {
            let c = crate::commands_stellar::ctx(state);
            let a = wallet_core::stellar_address(seed, 0).map_err(e)?;
            let l = crate::stellar_backend::latest_ledger(&c).await.map_err(e)?;
            let acc = crate::stellar_backend::account(&c, &a, &l)
                .await
                .map_err(e)?;
            let f = crate::stellar_backend::fee(&c, &l).await.map_err(e)?;
            Ok(format!("{acc:?} fee {f}").chars().take(160).collect())
        }),
    ));
    out.push((
        "near".into(),
        Box::pin(async move {
            let c = crate::commands_near::ctx(state);
            let a = wallet_core::near_address(seed, 0).map_err(e)?;
            let f = crate::near_backend::fees(&c).await.map_err(e)?;
            let acc = crate::near_backend::account(&c, &a, f.storage_per_byte)
                .await
                .map_err(e)?;
            let big = crate::near_backend::account(&c, "near", f.storage_per_byte)
                .await
                .map_err(e)?;
            Ok(format!("{acc:?} / near {big:?}")
                .chars()
                .take(160)
                .collect())
        }),
    ));
    out.push((
        "sui".into(),
        Box::pin(async move {
            let c = crate::commands_sui::ctx(state);
            let a = wallet_core::sui_address(seed, 0).map_err(e)?;
            let b = crate::sui_backend::balance(&c, &a).await.map_err(e)?;
            crate::sui_backend::token_balances(&c, &a)
                .await
                .map_err(e)?;
            let busy = crate::sui_backend::balance(
                &c,
                "0x177a0f6b96e2c76703d97b39990a62106aee3bb048b5fbfa4fcfdfc671c54869",
            )
            .await
            .map_err(e)?;
            let ep = crate::sui_backend::epoch(&c).await.map_err(e)?;
            Ok(format!("{b:?} / busy {busy:?} / {ep:?}")
                .chars()
                .take(200)
                .collect())
        }),
    ));
    out.push((
        "kaspa".into(),
        Box::pin(async move {
            let c = crate::commands_kaspa::ctx(state);
            let ks = crate::commands_kaspa::keys(state, 0).map_err(e)?;
            let daa = crate::kaspa_backend::network_info(&c).await.map_err(e)?;
            let b = crate::kaspa_backend::balance(&c, &ks).await.map_err(e)?;
            let u = crate::kaspa_backend::utxos(&c, &ks).await.map_err(e)?;
            let f = crate::kaspa_backend::fee_estimate(&c).await.map_err(e)?;
            Ok(format!(
                "daa {daa}, balance {b}, utxos {}, fee {f}",
                u.len()
            ))
        }),
    ));
    out.push((
        "polkadot".into(),
        Box::pin(async move {
            let c = crate::commands_dot::ctx(state);
            let a = state
                .with_polkadot(|r| Ok(wallet_core::dot_address(r, 0, net)?))
                .map_err(e)?;
            let id = wallet_core::dot_account_id(&a, net).map_err(e)?;
            let rt = crate::dot_backend::runtime(&c).await.map_err(e)?;
            let info = crate::dot_backend::account_info(&c, &id, None)
                .await
                .map_err(e)?;
            for k in wallet_core::dot_known_assets(net) {
                crate::dot_backend::asset_details(&c, k).await.map_err(e)?;
                crate::dot_backend::asset_account(&c, k.id, &id)
                    .await
                    .map_err(e)?;
            }
            Ok(format!("ED {}, {info:?}", rt.existential_deposit)
                .chars()
                .take(160)
                .collect())
        }),
    ));
    out.push((
        "algorand".into(),
        Box::pin(async move {
            let c = crate::commands_algo::ctx(state);
            let a = wallet_core::algo_address(seed, 0).map_err(e)?;
            let acc = crate::algo_backend::account(&c, &a).await.map_err(e)?;
            let p = crate::algo_backend::params(&c).await.map_err(e)?;
            Ok(format!("{acc:?} {p:?}").chars().take(160).collect())
        }),
    ));
    out.push((
        "monero".into(),
        Box::pin(async move {
            let c = crate::xmr_backend::XmrCtx::of(state);
            let d = crate::xmr_backend::probe(&c.net, c.network, &c.server, c.tor)
                .await
                .map_err(e)?;
            Ok(format!("{d:?}"))
        }),
    ));
    out.push((
        "ton".into(),
        Box::pin(async move {
            let c = crate::commands_ton::ctx(state);
            let a = wallet_core::ton_address(seed, 0, false).map_err(e)?;
            let f = crate::commands_ton::parse_user_address(&a, net).map_err(e)?;
            let acc = crate::ton_backend::account(&c, &f.address)
                .await
                .map_err(e)?;
            crate::ton_backend::jetton_balances(&c, &f.address)
                .await
                .map_err(e)?;
            Ok(format!("{acc:?}").chars().take(160).collect())
        }),
    ));
    out.push((
        "cosmos".into(),
        Box::pin(async move {
            let c = crate::commands_cosmos::ctx(state);
            let a = wallet_core::cosmos_address(seed, 0).map_err(e)?;
            let acc = crate::cosmos_backend::account(&c, &a).await.map_err(e)?;
            let g = crate::cosmos_backend::gas_price(&c).await.map_err(e)?;
            Ok(format!("{acc:?} gas {g}").chars().take(160).collect())
        }),
    ));
    out.push((
        "aptos".into(),
        Box::pin(async move {
            let c = crate::commands_aptos::ctx(state);
            let a = wallet_core::aptos_address(seed, 0).map_err(e)?;
            crate::aptos_backend::checked_ledger(&c).await.map_err(e)?;
            let acc = crate::aptos_backend::account(&c, &a).await.map_err(e)?;
            for k in wallet_core::aptos_known_assets(c.chain_id) {
                crate::aptos_backend::fa_balance(&c, &a, k.metadata)
                    .await
                    .map_err(e)?;
            }
            let g = crate::aptos_backend::gas_price(&c).await.map_err(e)?;
            Ok(format!("{acc:?} gas {g}").chars().take(160).collect())
        }),
    ));
    out
}

/// Reads added in 1.0.7, over Tor, nothing signed: Kaspa watch, Earn rates, and what each public
/// EVM node answers to the simulation calls (empty call from one address to another).
/// `cargo test -p kyro-desktop live_smoke_new_reads -- --ignored --nocapture`
#[test]
#[ignore]
fn live_smoke_new_reads_tor() {
    std::env::set_var(crate::network::ENV, "mainnet");
    let dir = std::env::temp_dir().join(format!("kyro-smoke-new-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&dir);
    let state = AppState::new(dir).unwrap();
    let watched = "kaspa:qr85gz7hvp76mtws6p236uv5xxdk57dzfe4p06ues0rlqhtqy3rtqqx7eeq3u";
    tauri::async_runtime::block_on(async {
        state.net.tor.start();
        while state.net.tor.status().state != TorState::Ready {
            assert_ne!(state.net.tor.status().state, TorState::Error);
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        let ks = crate::commands_kaspa::watched(state.network, watched).unwrap();
        let c = crate::commands_kaspa::ctx(&state);
        let daa = crate::kaspa_backend::network_info(&c).await;
        let balance = crate::kaspa_backend::balance(&c, &ks).await;
        let coins = crate::kaspa_backend::watch_utxos(&c, watched)
            .await
            .map(|u| u.len());
        let history = crate::kaspa_backend::history(&c, &ks)
            .await
            .map(|h| h.len());
        eprintln!("kaspa watch: daa {daa:?} balance {balance:?} utxos {coins:?} txs {history:?}");
        assert!(daa.is_ok() && balance.is_ok() && coins.is_ok() && history.is_ok());

        let sol = crate::earn_rates::sol(&state).await;
        let ada = crate::earn_rates::ada(&state).await;
        let trx = crate::earn_rates::trx(&state).await;
        eprintln!("apy: sol {sol:?} ada {ada:?} trx {trx:?}");
        for r in [sol, ada, trx] {
            assert!(matches!(r, Ok(Some(_))), "{r:?}");
        }

        let call = json!({
            "from": "0x0000000000000000000000000000000000000001",
            "to": "0x0000000000000000000000000000000000000002",
            "data": "0x",
            "value": "0x0"
        });
        let v1 = json!([
            { "blockStateCalls": [{ "calls": [call] }], "traceTransfers": true, "validation": false },
            "latest"
        ]);
        let trace = json!([call, "latest", { "tracer": "callTracer", "tracerConfig": { "withLog": true } }]);
        let short = |r: Result<Value, String>| match r {
            Ok(_) => "ok".to_owned(),
            Err(x) => x.chars().take(90).collect(),
        };
        for (name, url) in EVM {
            let (a, b) = futures_util::future::join(
                rpc(&state, url, "eth_simulateV1", v1.clone()),
                rpc(&state, url, "debug_traceCall", trace.clone()),
            )
            .await;
            eprintln!("{name}: simulateV1 {} | traceCall {}", short(a), short(b));
        }
    });
}

#[test]
#[ignore]
fn live_smoke_all_chains_mainnet() {
    std::env::set_var(crate::network::ENV, "mainnet");
    let clear = std::env::var("KYRO_SMOKE_CLEAR").as_deref() == Ok("yes");
    let warm = std::env::var("KYRO_SMOKE_WARM").as_deref() == Ok("yes");
    let only: Option<Vec<String>> = std::env::var("KYRO_SMOKE_ONLY")
        .ok()
        .filter(|s| !s.is_empty())
        .map(|s| s.split(',').map(str::to_owned).collect());
    let dir = std::env::var("KYRO_SMOKE_DIR").map_or_else(
        |_| std::env::temp_dir().join(format!("kyro-smoke-{}", std::process::id())),
        std::path::PathBuf::from,
    );
    let _ = std::fs::create_dir_all(&dir);
    let state = AppState::new(dir).unwrap();
    assert_eq!(state.network, Network::Mainnet);
    let mut s = state.settings();
    s.tor.enabled = !clear;
    state.save_settings(s).unwrap();
    let m = wallet_core::Mnemonic::generate(wallet_core::WordCount::W12).unwrap();
    let seed = m.to_seed("");
    let cardano = wallet_core::CardanoRoot::from_mnemonic(&m, "");
    let polkadot = wallet_core::PolkadotRoot::from_mnemonic(&m, "").unwrap();
    state.start_session(m.to_seed(""), cardano, polkadot);

    tauri::async_runtime::block_on(async {
        let t0 = Instant::now();
        if !clear {
            state.net.tor.start();
            if warm {
                while state.net.tor.status().state != TorState::Ready {
                    assert_ne!(state.net.tor.status().state, TorState::Error);
                    tokio::time::sleep(Duration::from_millis(200)).await;
                }
                eprintln!("tor ready in {:.1?}", t0.elapsed());
            }
        }
        let all = checks(&state, &seed);
        let (names, futs): (Vec<_>, Vec<_>) = all
            .into_iter()
            .filter(|(n, _)| {
                only.as_ref()
                    .map_or(!HIDDEN.contains(&n.as_str()), |o| o.contains(n))
            })
            .map(|(n, f)| {
                (n, async move {
                    let t = Instant::now();
                    let r = f.await;
                    (r, t.elapsed())
                })
            })
            .unzip();
        let results = futures_util::future::join_all(futs).await;
        let mut failed = Vec::new();
        eprintln!(
            "\n=== {} chains, Tor {} ===",
            names.len(),
            if clear { "off" } else { "on" }
        );
        for (n, (r, dt)) in names.iter().zip(results) {
            match r {
                Ok(m) => eprintln!("OK   {n:<12} {:>5.1}s  {m}", dt.as_secs_f32()),
                Err(m) => {
                    eprintln!("FAIL {n:<12} {:>5.1}s  {m}", dt.as_secs_f32());
                    failed.push(n.clone());
                }
            }
        }
        eprintln!("total {:.1?}", t0.elapsed());
        assert!(failed.is_empty(), "failed: {failed:?}");
    });
}

/// History-shaped load over Tor (what the History screen does on every EVM chain at once):
/// `eth_blockNumber`, then a JSON-RPC batch of `eth_getLogs` over the last 5000 blocks, on several
/// chains in parallel, repeated a few times. `KYRO_SMOKE_ONLY` picks the chains (default: 3).
#[test]
#[ignore]
fn live_smoke_evm_history_tor() {
    std::env::set_var(crate::network::ENV, "mainnet");
    let only: Vec<String> = std::env::var("KYRO_SMOKE_ONLY")
        .ok()
        .filter(|s| !s.is_empty())
        .map_or_else(
            || vec!["ethereum".into(), "base".into(), "arbitrum".into()],
            |s| s.split(',').map(str::to_owned).collect(),
        );
    let dir = std::env::temp_dir().join(format!("kyro-smoke-hist-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&dir);
    let state = AppState::new(dir).unwrap();
    let mut s = state.settings();
    s.tor.enabled = true;
    state.save_settings(s).unwrap();
    let me = format!("0x{:0>64}", "d8da6bf26964af9d7eed9e03e53415d37aa96045");
    let tokens: Vec<String> = (1..=20u8).map(|i| format!("0x{:040x}", i)).collect();

    tauri::async_runtime::block_on(async {
        let t0 = Instant::now();
        state.net.tor.start();
        // Extra endpoints to try (`KYRO_SMOKE_EXTRA=name=url,…`, hosts must be allowlisted).
        let extra: Vec<(String, String)> = std::env::var("KYRO_SMOKE_EXTRA")
            .unwrap_or_default()
            .split(',')
            .filter_map(|x| x.split_once('=').map(|(a, b)| (a.to_owned(), b.to_owned())))
            .collect();
        let chains: Vec<(&str, &str)> = EVM
            .iter()
            .copied()
            .filter(|(n, _)| only.iter().any(|o| o == n))
            .chain(extra.iter().map(|(a, b)| (a.as_str(), b.as_str())))
            .collect();
        let mut failed = Vec::new();
        for round in 1..=3 {
            let futs = chains.iter().map(|(name, url)| {
                let (state, me, tokens) = (&state, &me, &tokens);
                async move {
                    let t = Instant::now();
                    let r: Result<usize, String> = async {
                        let n = rpc(state, url, "eth_blockNumber", json!([])).await?;
                        let latest = u64::from_str_radix(
                            n.as_str().unwrap_or("0x0").trim_start_matches("0x"),
                            16,
                        )
                        .map_err(e)?;
                        let range = json!({ "fromBlock": format!("0x{:x}", latest.saturating_sub(5000)), "toBlock": format!("0x{latest:x}") });
                        let mut batch = Vec::new();
                        for (i, chunk) in tokens.chunks(10).enumerate() {
                            for topics in [json!([TRANSFER, null, me]), json!([TRANSFER, me])] {
                                let mut q = range.clone();
                                q["address"] = json!(chunk);
                                q["topics"] = topics;
                                batch.push(json!({ "jsonrpc": "2.0", "id": batch.len() + i, "method": "eth_getLogs", "params": [q] }));
                            }
                        }
                        let req = FetchRequest {
                            url: (*url).into(),
                            method: "POST".into(),
                            headers: [("content-type".to_owned(), "application/json".to_owned())]
                                .into(),
                            body: Some(Value::Array(batch).to_string()),
                        };
                        let r = state
                            .net
                            .fetch(req, &state.settings(), &state.env_keys, state.network)
                            .await
                            .map_err(e)?;
                        if r.status != 200 {
                            return Err(format!("HTTP {}", r.status));
                        }
                        // Every batch entry must be a `result`, not an RPC `error` (HTTP 200 either way).
                        let v: Value = serde_json::from_str(&r.body).map_err(e)?;
                        let errors: Vec<String> = v
                            .as_array()
                            .map(|a| {
                                a.iter()
                                    .filter_map(|x| x.get("error").map(Value::to_string))
                                    .collect()
                            })
                            .unwrap_or_else(|| vec![v.to_string()]);
                        if let Some(first) = errors.first() {
                            return Err(format!("{} RPC errors, first: {first}", errors.len()));
                        }
                        Ok(r.body.len())
                    }
                    .await;
                    (*name, r, t.elapsed())
                }
            });
            for (name, r, dt) in futures_util::future::join_all(futs).await {
                match r {
                    Ok(len) => eprintln!(
                        "round {round} OK   {name:<10} {:>5.1}s  {len} bytes",
                        dt.as_secs_f32()
                    ),
                    Err(m) => {
                        eprintln!(
                            "round {round} FAIL {name:<10} {:>5.1}s  {m}",
                            dt.as_secs_f32()
                        );
                        failed.push(format!("{round}:{name}"));
                    }
                }
            }
        }
        eprintln!("total {:.1?}", t0.elapsed());
        assert!(failed.is_empty(), "failed: {failed:?}");
    });
}

const TRANSFER: &str = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/// Timings of what the asset page waits for over Tor (cold, then warm): the gap scan of an empty
/// Bitcoin account (16 `address_info`, 5 in flight, like `gapScan.ts`), the history of a used
/// address, an EVM `eth_blockNumber` and a CoinGecko 1Y chart.
#[test]
#[ignore]
fn live_smoke_activity_timing_tor() {
    std::env::set_var(crate::network::ENV, "mainnet");
    let dir = std::env::temp_dir().join(format!("kyro-smoke-act-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&dir);
    let state = AppState::new(dir).unwrap();
    let mut s = state.settings();
    s.tor.enabled = true;
    state.save_settings(s).unwrap();
    let seed = wallet_core::Mnemonic::generate(wallet_core::WordCount::W12)
        .unwrap()
        .to_seed("");
    tauri::async_runtime::block_on(async {
        let t0 = Instant::now();
        state.net.tor.start();
        let s = state.settings();
        let c = crate::commands_servers::ctx(&state, &s).unwrap();
        let get = |url: &'static str| {
            let state = &state;
            async move {
                let req = FetchRequest {
                    url: url.into(),
                    method: "GET".into(),
                    headers: Default::default(),
                    body: None,
                };
                state
                    .net
                    .fetch(req, &state.settings(), &state.env_keys, state.network)
                    .await
                    .map(|r| r.status)
                    .map_err(e)
            }
        };
        for round in ["cold", "warm"] {
            let t = Instant::now();
            let sem = tokio::sync::Semaphore::new(5);
            let mut addrs = Vec::new();
            for (kind, change, n) in [
                (BtcKind::Segwit, false, 5),
                (BtcKind::Segwit, true, 3),
                (BtcKind::Taproot, false, 5),
                (BtcKind::Taproot, true, 3),
            ] {
                for i in 0..n {
                    addrs.push(
                        wallet_core::btc_address(&seed, Network::Mainnet, kind, 0, change, i)
                            .unwrap(),
                    );
                }
            }
            let r = futures_util::future::join_all(addrs.iter().map(|a| {
                let (c, sem) = (&c, &sem);
                async move {
                    let _p = sem.acquire().await;
                    let t = Instant::now();
                    let r = crate::btc_backend::address_info(c, a).await;
                    (r.is_ok(), t.elapsed())
                }
            }))
            .await;
            let worst = r.iter().map(|x| x.1).max().unwrap_or_default();
            let ok = r.iter().filter(|x| x.0).count();
            eprintln!(
                "{round} btc empty scan  {:>5.1}s ({ok}/16 ok, slowest {:.1}s)",
                t.elapsed().as_secs_f32(),
                worst.as_secs_f32()
            );
            let t = Instant::now();
            let used = "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh";
            let i = crate::btc_backend::address_info(&c, used).await.is_ok();
            let h = crate::btc_backend::address_txs(&c, used)
                .await
                .map(|v| v.as_array().map_or(0, Vec::len));
            eprintln!(
                "{round} btc used history {:>5.1}s (info {i}, txs {h:?})",
                t.elapsed().as_secs_f32()
            );
            let t = Instant::now();
            let n = rpc(&state, EVM[0].1, "eth_blockNumber", json!([])).await;
            eprintln!(
                "{round} evm blockNumber  {:>5.1}s ({})",
                t.elapsed().as_secs_f32(),
                n.is_ok()
            );
            let t = Instant::now();
            let st = get("https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=365").await;
            eprintln!(
                "{round} chart 1Y         {:>5.1}s ({st:?})",
                t.elapsed().as_secs_f32()
            );
        }
        eprintln!("total {:.1?}", t0.elapsed());
    });
}

/// The price history of the « All » chart over Tor: status, time, size, number of points and first
/// date of every Kraken pair (`KRAKEN_PAIRS` in `packages/market`), then three rounds of Bitcoin.
/// `KYRO_SMOKE_ONLY=<url part>` keeps the matching sources.
///
/// Measured 2026-11-04 for other keyless sources, refused: CoinGecko `days=max` (HTTP 401, 10012),
/// CryptoCompare `histoday` (HTTP 401, key required), Bitstamp (HTTP 403/302 to Tor exits), Coinbase
/// candles (a year per answer, 350 rows).
///
/// `cargo test -p kyro-desktop live_smoke_chart_history -- --ignored --nocapture`
#[test]
#[ignore]
fn live_smoke_chart_history() {
    std::env::set_var(crate::network::ENV, "mainnet");
    let dir = std::env::temp_dir().join(format!("kyro-chart-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&dir);
    let state = AppState::new(dir).unwrap();
    let only = std::env::var("KYRO_SMOKE_ONLY").unwrap_or_default();
    const PAIRS: &[&str] = &[
        "XBTUSD", "ETHUSD", "LTCUSD", "XDGUSD", "XRPUSD", "XMRUSD", "ZECUSD", "BCHUSD", "DASHUSD",
        "XLMUSD", "ADAUSD", "DOTUSD", "SOLUSD", "TRXUSD", "ALGOUSD", "ATOMUSD", "AVAXUSD",
        "NEARUSD", "LINKUSD", "UNIUSD", "XTZUSD", "ETCUSD", "USDTZUSD", "USDCUSD",
    ];
    const RECENT: &str =
        "https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=365";
    let kraken = |p: &str| format!("https://api.kraken.com/0/public/OHLC?pair={p}&interval=10080");
    tauri::async_runtime::block_on(async {
        state.net.tor.start();
        for round in 1..=3 {
            let pairs = if round == 1 { PAIRS } else { &PAIRS[..1] };
            let urls = pairs.iter().map(|p| kraken(p)).chain([RECENT.to_owned()]);
            for url in urls.filter(|u| only.is_empty() || u.contains(&only)) {
                let t = Instant::now();
                let req = FetchRequest {
                    url: url.clone(),
                    method: "GET".into(),
                    headers: Default::default(),
                    body: None,
                };
                let r = state
                    .net
                    .fetch(req, &state.settings(), &state.env_keys, state.network)
                    .await;
                let secs = t.elapsed().as_secs_f32();
                let host = url.split(['?', '&']).nth(1).unwrap_or(&url);
                match r {
                    Err(x) => eprintln!("{round} {host:<28} {secs:>5.1}s ERR {x}"),
                    Ok(r) => {
                        let (n, first) = history_rows(&r.body);
                        eprintln!(
                            "{round} {host:<28} {secs:>5.1}s HTTP {} {:>8}B {n:>5} rows, first {first} | {}",
                            r.status,
                            r.body.len(),
                            r.body.chars().take(if n > 0 { 0 } else { 140 }).collect::<String>()
                        );
                    }
                }
            }
        }
    });
}

/// The longest array of rows in an answer (any shape above it) and its first time, as raw text.
fn history_rows(body: &str) -> (usize, String) {
    fn walk<'a>(v: &'a Value, best: &mut Option<&'a Vec<Value>>) {
        match v {
            Value::Array(a) => {
                if a.len() > best.map_or(0, Vec::len) && a.iter().all(|x| !x.is_number()) {
                    *best = Some(a);
                }
            }
            Value::Object(o) => o.values().for_each(|x| walk(x, best)),
            _ => {}
        }
    }
    let Ok(v) = serde_json::from_str::<Value>(body) else {
        return (0, "not JSON".into());
    };
    let mut best = None;
    walk(&v, &mut best);
    let Some(rows) = best else {
        return (0, "-".into());
    };
    let time = |row: &Value| {
        row.get(0)
            .or_else(|| row.get("time"))
            .or_else(|| row.get("timestamp"))
            .and_then(|t| t.as_f64().or_else(|| t.as_str()?.parse().ok()))
            .unwrap_or(0.0)
    };
    let oldest = rows.iter().map(time).fold(f64::INFINITY, f64::min);
    let secs = if oldest > 1e11 {
        oldest / 1000.0
    } else {
        oldest
    };
    let days = (secs / 86_400.0) as i64;
    // Civil date from days since 1970 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let (d, m) = (
        doy - (153 * mp + 2) / 5 + 1,
        if mp < 10 { mp + 3 } else { mp - 9 },
    );
    let y = yoe + era * 400 + i64::from(m <= 2);
    (rows.len(), format!("{y}-{m:02}-{d:02}"))
}

/// Exolix public API v2 over Tor, without a key: `GET /rate` (fixed, then float) and
/// `POST /transactions` (XMR → BTC to a fresh, never-funded address; nothing is ever sent).
#[test]
#[ignore]
fn live_smoke_exolix_tor() {
    std::env::set_var(crate::network::ENV, "mainnet");
    let dir = std::env::temp_dir().join(format!("kyro-exolix-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&dir);
    let state = AppState::new(dir).unwrap();
    let mut s = state.settings();
    s.tor.enabled = std::env::var("KYRO_SMOKE_CLEAR").as_deref() != Ok("yes");
    state.save_settings(s).unwrap();
    let m = wallet_core::Mnemonic::generate(wallet_core::WordCount::W12).unwrap();
    let seed = m.to_seed("");
    let btc =
        wallet_core::btc_address(&seed, Network::Mainnet, BtcKind::Segwit, 0, false, 0).unwrap();
    tauri::async_runtime::block_on(async {
        state.net.tor.start();
        let get = |url: String| FetchRequest {
            url,
            method: "GET".into(),
            headers: Default::default(),
            body: None,
        };
        for rt in ["fixed", "float"] {
            let r = state
                .net
                .fetch(
                    get(format!("https://exolix.com/api/v2/rate?coinFrom=XMR&networkFrom=XMR&coinTo=BTC&networkTo=BTC&amount=1&rateType={rt}")),
                    &state.settings(),
                    &state.env_keys,
                    state.network,
                )
                .await
                .unwrap();
            eprintln!(
                "RATE {rt} HTTP {} {}",
                r.status,
                r.body.chars().take(600).collect::<String>()
            );
        }
        let body = json!({ "coinFrom": "XMR", "networkFrom": "XMR", "coinTo": "BTC", "networkTo": "BTC", "amount": 1, "withdrawalAddress": btc, "rateType": "fixed" });
        let r = state
            .net
            .fetch(
                FetchRequest {
                    url: "https://exolix.com/api/v2/transactions".into(),
                    method: "POST".into(),
                    headers: [("content-type".to_owned(), "application/json".to_owned())].into(),
                    body: Some(body.to_string()),
                },
                &state.settings(),
                &state.env_keys,
                state.network,
            )
            .await
            .unwrap();
        eprintln!(
            "CREATE HTTP {} {}",
            r.status,
            r.body.chars().take(1500).collect::<String>()
        );
        if let Some(id) = serde_json::from_str::<Value>(&r.body)
            .ok()
            .and_then(|v| v.get("id").and_then(Value::as_str).map(str::to_owned))
        {
            let r = state
                .net
                .fetch(
                    get(format!("https://exolix.com/api/v2/transactions/{id}")),
                    &state.settings(),
                    &state.env_keys,
                    state.network,
                )
                .await
                .unwrap();
            eprintln!(
                "STATUS HTTP {} {}",
                r.status,
                r.body.chars().take(1500).collect::<String>()
            );
        }
    });
}
