// monero-wallet's decoy selection nests futures deeply (layout of `CachedDecoys`'s async block).
#![recursion_limit = "256"]

mod accounts;
mod algo_backend;
mod aptos_backend;
mod btc_backend;
mod cardano_backend;
#[cfg(feature = "cbf")]
mod cbf;
mod commands;
mod commands_algo;
mod commands_aptos;
mod commands_cardano;
mod commands_cosmos;
mod commands_dot;
mod commands_hbar;
mod commands_hw;
mod commands_hw_ada_zec;
mod commands_hw_algo;
mod commands_hw_aptos;
mod commands_hw_coins;
mod commands_hw_cosmos;
mod commands_hw_hbar;
mod commands_hw_keys;
mod commands_hw_near;
mod commands_hw_sui;
mod commands_hw_ton;
mod commands_kaspa;
mod commands_near;
mod commands_servers;
mod commands_stellar;
mod commands_sui;
mod commands_ton;
mod commands_tron;
mod commands_utxo;
mod commands_xmr;
mod commands_xrp;
mod commands_zcash;
mod core_rpc;
mod cosmos_backend;
mod dialog_text;
mod dot_backend;
mod dot_history;
mod earn_evm;
mod earn_rates;
mod electrum;
mod error;
mod fiat;
mod hbar_backend;
mod hw;
mod i18n;
mod kaspa_backend;
mod known_tokens;
#[cfg(test)]
mod live_smoke;
mod nav_guard;
mod near_backend;
mod net;
mod network;
mod phrase_window;
mod server_approval;
mod servers;
mod settings;
mod solana;
mod stake_ada;
mod stake_near;
mod stake_sol;
mod stake_tron;
mod state;
mod stellar_backend;
mod sui_backend;
mod ton_backend;
mod tor;
mod tron_backend;
mod updater;
mod utxo_backend;
mod weekly_count;
mod xmr_backend;
mod xrp_backend;
mod zcash_backend;

use std::time::Duration;

use tauri::{Emitter, Manager};

pub fn run() {
    // Dev convenience only: read the repo-root .env (never in release builds).
    #[cfg(debug_assertions)]
    {
        let _ = dotenvy::from_path(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../.env"));
    }

    let context = tauri::generate_context!();
    let dev_url = context.config().build.dev_url.clone();
    // The phrase window uses the app's fonts: find them among the bundled assets (hashed names).
    #[allow(unused_mut)]
    let mut assets: Vec<String> = context
        .assets()
        .iter()
        .map(|(k, _)| k.into_owned())
        .collect();
    #[cfg(debug_assertions)]
    if let Ok(dir) = std::fs::read_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/../dist/assets")) {
        // `tauri dev` does not embed the assets: look in the built frontend.
        assets
            .extend(dir.filter_map(|e| Some(format!("/assets/{}", e.ok()?.file_name().to_str()?))));
    }
    phrase_window::remember_fonts(assets.iter().map(String::as_str));
    tauri::Builder::default()
        .plugin(nav_guard::init(dev_url))
        .plugin(tauri_plugin_dialog::init())
        .register_uri_scheme_protocol(phrase_window::SCHEME, phrase_window::protocol)
        .setup(|app| {
            app.manage(phrase_window::PhraseState::default());
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            app.manage(state::AppState::new(dir)?);
            let st = app.state::<state::AppState>();
            st.hw.set_thp_store(st.data_dir().join("trezor-thp.json"));
            let handle = app.handle().clone();
            st.net.tor.set_emitter(move |s| {
                let _ = handle.emit("tor-status", s);
            });
            if st.settings().tor.enabled {
                st.net.tor.start();
            }
            updater::on_start(app.handle());
            spawn_auto_lock(app.handle().clone());
            // The main window is created here, after the state exists (`"create": false` in
            // tauri.conf.json), so that `window.open` can be refused: a new window would load
            // any URL, outside the navigation guard and outside Tor.
            let main = app
                .config()
                .app
                .windows
                .iter()
                .find(|w| w.label == "main")
                .cloned()
                .ok_or("main window missing from the configuration")?;
            tauri::WebviewWindowBuilder::from_config(app.handle(), &main)?
                .on_new_window(|_url, _features| tauri::webview::NewWindowResponse::Deny)
                .build()?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // Only the main window: closing the phrase window must not lock the session.
            if updater::is_quit(window.label(), event) {
                if let Some(phrase) = window.app_handle().get_webview_window(phrase_window::LABEL) {
                    let _ = phrase.destroy();
                }
                commands::lock_on_exit(window.app_handle());
                // Closing the main window quits Kyro: apply a staged update now, not at
                // `RunEvent::Exit`, which may never come (see `updater::QuitOnce`).
                updater::on_exit(window.app_handle());
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::vault_status,
            commands::vault_create,
            commands::vault_import,
            commands::vault_unlock,
            commands::vault_lock,
            commands::vault_reveal_mnemonic,
            commands::vault_backup_show,
            commands::vault_backup_verify,
            commands::session_touch,
            commands::accounts_get,
            accounts::vault_accounts_get,
            accounts::vault_account_add,
            accounts::vault_account_rename,
            accounts::vault_account_remove,
            commands::btc_address,
            commands::evm_decode_tx,
            commands::evm_sign_tx,
            commands::btc_sign_psbt,
            commands::sol_decode_tx,
            commands::sol_sign_tx,
            commands::net_fetch,
            commands_servers::settings_get,
            commands_servers::settings_set,
            commands_servers::server_test,
            commands_servers::electrum_fetch_cert,
            commands_servers::btc_backend_info,
            commands_servers::btc_address_info,
            commands_servers::btc_address_utxos,
            commands_servers::btc_address_txs,
            commands_servers::btc_fee_rates,
            commands_servers::btc_tip_height,
            commands_servers::btc_tx_hex,
            commands_servers::btc_broadcast,
            commands_servers::btc_core_pick_cookie,
            commands_servers::btc_core_setup,
            commands_servers::btc_core_status,
            commands_servers::btc_cbf_status,
            commands_servers::btc_cbf_sync,
            commands_utxo::ltc_backend_info,
            commands_utxo::ltc_address,
            commands_utxo::ltc_address_info,
            commands_utxo::ltc_address_utxos,
            commands_utxo::ltc_address_txs,
            commands_utxo::ltc_tx_hex,
            commands_utxo::ltc_fee_rates,
            commands_utxo::ltc_tip_height,
            commands_utxo::ltc_broadcast,
            commands_utxo::ltc_sign_psbt,
            commands_utxo::doge_backend_info,
            commands_utxo::doge_address,
            commands_utxo::doge_address_info,
            commands_utxo::doge_address_utxos,
            commands_utxo::doge_address_txs,
            commands_utxo::doge_tx_hex,
            commands_utxo::doge_fee_rates,
            commands_utxo::doge_tip_height,
            commands_utxo::doge_broadcast,
            commands_utxo::doge_sign_psbt,
            commands_utxo::bch_backend_info,
            commands_utxo::bch_address,
            commands_utxo::bch_address_info,
            commands_utxo::bch_address_utxos,
            commands_utxo::bch_address_txs,
            commands_utxo::bch_tx_hex,
            commands_utxo::bch_fee_rates,
            commands_utxo::bch_tip_height,
            commands_utxo::bch_broadcast,
            commands_utxo::bch_sign_psbt,
            commands_utxo::dash_backend_info,
            commands_utxo::dash_address,
            commands_utxo::dash_address_info,
            commands_utxo::dash_address_utxos,
            commands_utxo::dash_address_txs,
            commands_utxo::dash_tx_hex,
            commands_utxo::dash_fee_rates,
            commands_utxo::dash_tip_height,
            commands_utxo::dash_broadcast,
            commands_utxo::dash_sign_psbt,
            commands_zcash::zec_backend_info,
            commands_zcash::zec_address,
            commands_zcash::zec_address_info,
            commands_zcash::zec_address_utxos,
            commands_zcash::zec_address_txs,
            commands_zcash::zec_tip_height,
            commands_zcash::zec_broadcast,
            commands_zcash::zec_send_preview,
            commands_zcash::zec_sign,
            commands_tron::tron_backend_info,
            commands_tron::tron_address,
            commands_tron::tron_account,
            commands_tron::tron_trc20_balance,
            commands_tron::tron_txs,
            commands_tron::tron_build_tx,
            commands_tron::tron_sign_tx,
            commands_tron::tron_broadcast,
            commands_xrp::xrp_backend_info,
            commands_xrp::xrp_address,
            commands_xrp::xrp_account,
            commands_xrp::xrp_lines,
            commands_xrp::xrp_txs,
            commands_xrp::xrp_build_tx,
            commands_xrp::xrp_sign_tx,
            commands_xrp::xrp_broadcast,
            commands_xrp::xrp_tx_status,
            commands_stellar::stellar_backend_info,
            commands_stellar::stellar_address,
            commands_stellar::stellar_account,
            commands_stellar::stellar_txs,
            commands_stellar::stellar_build_tx,
            commands_stellar::stellar_build_asset_tx,
            commands_stellar::stellar_build_trust_tx,
            commands_stellar::stellar_sign_tx,
            commands_stellar::stellar_broadcast,
            commands_stellar::stellar_tx_status,
            commands_near::near_backend_info,
            commands_near::near_address,
            commands_near::near_account,
            commands_near::near_txs,
            commands_near::near_token_balances,
            commands_near::near_build_token_tx,
            commands_near::near_build_tx,
            commands_near::near_sign_tx,
            commands_near::near_broadcast,
            commands_near::near_tx_status,
            commands_sui::sui_backend_info,
            commands_sui::sui_address,
            commands_sui::sui_balance,
            commands_sui::sui_txs,
            commands_sui::sui_token_balances,
            commands_sui::sui_build_token_tx,
            commands_sui::sui_build_tx,
            commands_sui::sui_sign_tx,
            commands_sui::sui_broadcast,
            commands_sui::sui_tx_status,
            commands_hbar::hbar_backend_info,
            commands_hbar::hbar_address,
            commands_hbar::hbar_account,
            commands_hbar::hbar_recipient,
            commands_hbar::hbar_txs,
            commands_hbar::hbar_build_tx,
            commands_hbar::hbar_sign_tx,
            commands_hbar::hbar_broadcast,
            commands_hbar::hbar_tx_status,
            commands_hbar::hbar_token_holdings,
            commands_hbar::hbar_build_associate_tx,
            commands_hbar::hbar_build_token_tx,
            commands_algo::algo_backend_info,
            commands_algo::algo_address,
            commands_algo::algo_account,
            commands_algo::algo_txs,
            commands_algo::algo_build_tx,
            commands_algo::algo_sign_tx,
            commands_algo::algo_broadcast,
            commands_algo::algo_tx_status,
            commands_algo::algo_asset_holdings,
            commands_algo::algo_build_optin_tx,
            commands_algo::algo_build_asset_tx,
            commands_xmr::xmr_backend_info,
            commands_xmr::xmr_address,
            commands_xmr::xmr_new_subaddress,
            commands_xmr::xmr_subaddresses,
            commands_xmr::xmr_status,
            commands_xmr::xmr_sync,
            commands_xmr::xmr_txs,
            commands_xmr::xmr_validate_address,
            commands_xmr::xmr_set_restore_height,
            commands_xmr::xmr_prepare_tx,
            commands_xmr::xmr_send_tx,
            commands_xmr::xmr_seed_show,
            commands_ton::ton_backend_info,
            commands_ton::ton_address,
            commands_ton::ton_account,
            commands_ton::ton_txs,
            commands_ton::ton_build_tx,
            commands_ton::ton_build_jetton_tx,
            commands_ton::ton_jetton_balances,
            commands_ton::ton_jetton_txs,
            commands_ton::ton_sign_tx,
            commands_ton::ton_broadcast,
            commands_ton::ton_tx_status,
            commands_cosmos::cosmos_backend_info,
            commands_cosmos::cosmos_address,
            commands_cosmos::cosmos_account,
            commands_cosmos::cosmos_txs,
            commands_cosmos::cosmos_build_tx,
            commands_cosmos::cosmos_sign_tx,
            commands_cosmos::cosmos_broadcast,
            commands_cosmos::cosmos_tx_status,
            commands_aptos::aptos_backend_info,
            commands_aptos::aptos_address,
            commands_aptos::aptos_account,
            commands_aptos::aptos_txs,
            commands_aptos::aptos_token_balances,
            commands_aptos::aptos_token_txs,
            commands_aptos::aptos_build_token_tx,
            commands_aptos::aptos_build_tx,
            commands_aptos::aptos_sign_tx,
            commands_aptos::aptos_broadcast,
            commands_aptos::aptos_tx_status,
            commands_cardano::ada_backend_info,
            commands_cardano::ada_address,
            commands_cardano::ada_account,
            commands_cardano::ada_txs,
            commands_cardano::ada_tx_status,
            commands_cardano::ada_build_tx,
            commands_cardano::ada_sign_tx,
            commands_cardano::ada_broadcast,
            commands_kaspa::kas_backend_info,
            commands_kaspa::kas_address,
            commands_kaspa::kas_account,
            commands_kaspa::kas_txs,
            commands_kaspa::kas_tx_status,
            commands_kaspa::kas_build_tx,
            commands_kaspa::kas_sign_tx,
            commands_kaspa::kas_broadcast,
            commands_dot::dot_backend_info,
            commands_dot::dot_address,
            commands_dot::dot_account,
            commands_dot::dot_build_tx,
            commands_dot::dot_sign_tx,
            commands_dot::dot_broadcast,
            commands_dot::dot_tx_status,
            commands_dot::dot_txs,
            commands_dot::dot_asset_balances,
            commands_dot::dot_build_asset_tx,
            stake_sol::sol_stake_overview,
            stake_sol::sol_stake_validators,
            stake_sol::sol_stake_build,
            stake_sol::sol_stake_sign,
            stake_sol::sol_stake_broadcast,
            stake_ada::ada_stake_overview,
            stake_ada::ada_stake_pools,
            stake_ada::ada_stake_pool,
            stake_ada::ada_stake_build,
            stake_ada::ada_stake_sign,
            stake_ada::ada_stake_broadcast,
            stake_tron::tron_stake_overview,
            stake_tron::tron_stake_witnesses,
            stake_tron::tron_stake_build,
            stake_tron::tron_stake_sign,
            stake_near::near_stake_overview,
            stake_near::near_stake_validators,
            stake_near::near_stake_build,
            earn_evm::earn_evm_build,
            earn_rates::earn_staking_rates,
            stake_near::near_stake_sign,
            stake_near::near_stake_broadcast,
            commands::set_capture_protection,
            commands::open_fees_page,
            commands::config_get,
            network::network_get,
            network::network_set,
            commands::tor_status,
            commands::tor_retry,
            commands_hw::hw_list,
            commands_hw::hw_open,
            commands_hw::hw_cancel,
            commands_hw::hw_pin_matrix,
            commands_hw::hw_get_xpub,
            commands_hw::hw_accounts_get,
            commands_hw::hw_account_add,
            commands_hw::hw_account_remove,
            commands_hw::hw_verify_address,
            commands_hw::hw_sign_btc_psbt,
            commands_hw::hw_sign_evm_tx,
            commands_hw::hw_sign_sol_tx,
            commands_hw_keys::hw_key_add,
            commands_hw_keys::hw_key_verify,
            commands_hw_sui::hw_sui_build_tx,
            commands_hw_sui::hw_sign_sui_tx,
            commands_hw_sui::hw_sui_broadcast,
            commands_hw_aptos::hw_aptos_build_tx,
            commands_hw_aptos::hw_sign_aptos_tx,
            commands_hw_aptos::hw_aptos_broadcast,
            commands_hw_algo::hw_algo_build_tx,
            commands_hw_algo::hw_sign_algo_tx,
            commands_hw_algo::hw_algo_broadcast,
            commands_hw_near::hw_near_build_tx,
            commands_hw_near::hw_sign_near_tx,
            commands_hw_near::hw_near_broadcast,
            commands_hw_near::hw_near_tx_status,
            commands_hw_ton::hw_ton_build_tx,
            commands_hw_ton::hw_ton_build_jetton_tx,
            commands_hw_ton::hw_sign_ton_tx,
            commands_hw_ton::hw_ton_broadcast,
            commands_hw_hbar::hw_hbar_account,
            commands_hw_hbar::hw_hbar_build_tx,
            commands_hw_hbar::hw_sign_hbar_tx,
            commands_hw_hbar::hw_hbar_broadcast,
            commands_hw_cosmos::hw_cosmos_build_tx,
            commands_hw_cosmos::hw_sign_cosmos_tx,
            commands_hw_cosmos::hw_cosmos_broadcast,
            commands_hw::hw_thp_pairing_code,
            commands_hw::hw_thp_pairings,
            commands_hw::hw_thp_forget,
            updater::update_status,
            commands_hw_coins::hw_sign_utxo_psbt,
            commands_hw_coins::hw_xrp_build_tx,
            commands_hw_coins::hw_sign_xrp_tx,
            commands_hw_coins::hw_xrp_broadcast,
            commands_hw_coins::hw_tron_build_tx,
            commands_hw_coins::hw_sign_tron_tx,
            commands_hw_coins::hw_tron_broadcast,
            commands_hw_coins::hw_stellar_build_tx,
            commands_hw_coins::hw_sign_stellar_tx,
            commands_hw_coins::hw_stellar_broadcast,
            commands_hw_ada_zec::hw_ada_build_tx,
            commands_hw_ada_zec::hw_sign_ada_tx,
            commands_hw_ada_zec::hw_ada_broadcast,
            commands_hw_ada_zec::hw_zec_send_preview,
            commands_hw_ada_zec::hw_sign_zec_tx,
        ])
        .build(context)
        .expect("error while running Kyro")
        .run(|app, event| {
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                updater::on_exit(app);
            }
        });
}

const SLEEP_GAP: Duration = Duration::from_secs(20);

fn slept(expected: Duration, monotonic: Duration, wall: Option<Duration>) -> bool {
    let limit = expected + SLEEP_GAP;
    monotonic > limit || wall.is_some_and(|w| w > limit)
}

/// Checks idleness every second; drops (and zeroizes) the session and tells the UI.
fn spawn_auto_lock(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let tick = Duration::from_secs(1);
        loop {
            let (mono, wall) = (std::time::Instant::now(), std::time::SystemTime::now());
            std::thread::sleep(tick);
            let st = app.state::<state::AppState>();
            let woke = slept(tick, mono.elapsed(), wall.elapsed().ok());
            let locked = if woke {
                st.lock_if_unlocked()
            } else {
                st.expire_if_idle()
            };
            if locked {
                let _ = app.emit("vault-locked", ());
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sleep_detection() {
        let s = Duration::from_secs;
        assert!(!slept(s(1), s(1), Some(s(1))));
        assert!(!slept(s(1), s(5), Some(s(5))), "busy machine, not asleep");
        assert!(slept(s(1), s(3600), Some(s(3600))));
        assert!(slept(s(1), s(1), Some(s(600))));
        assert!(!slept(s(1), s(1), None));
    }
}
