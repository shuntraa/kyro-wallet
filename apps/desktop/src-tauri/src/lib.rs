mod accounts;
mod btc_backend;
mod cardano_backend;
#[cfg(feature = "cbf")]
mod cbf;
mod commands;
mod commands_cardano;
mod commands_cosmos;
mod commands_hw;
mod commands_servers;
mod commands_tron;
mod commands_utxo;
mod commands_xrp;
mod core_rpc;
mod cosmos_backend;
mod dialog_text;
mod electrum;
mod error;
mod hw;
mod known_tokens;
mod nav_guard;
mod net;
mod network;
mod server_approval;
mod servers;
mod settings;
mod solana;
mod stake_ada;
mod stake_sol;
mod stake_tron;
mod state;
mod tor;
mod tron_backend;
mod utxo_backend;
mod xrp_backend;

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
    tauri::Builder::default()
        // Every navigation outside the app's own origin is refused (docs/NETWORK.md).
        .plugin(nav_guard::init(dev_url))
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            app.manage(state::AppState::new(dir)?);
            let st = app.state::<state::AppState>();
            // THP pairings (Trezor Safe 7): next to the vault, see SECURITY.md.
            st.hw.set_thp_store(st.data_dir().join("trezor-thp.json"));
            let handle = app.handle().clone();
            st.net.tor.set_emitter(move |s| {
                let _ = handle.emit("tor-status", s);
            });
            if st.settings().tor.enabled {
                st.net.tor.start();
            }
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
                .ok_or("fenêtre principale absente de la configuration")?;
            tauri::WebviewWindowBuilder::from_config(app.handle(), &main)?
                .on_new_window(|_url, _features| tauri::webview::NewWindowResponse::Deny)
                .build()?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(
                event,
                tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed
            ) {
                commands::lock_on_exit(window.app_handle());
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
            commands_cosmos::cosmos_backend_info,
            commands_cosmos::cosmos_address,
            commands_cosmos::cosmos_account,
            commands_cosmos::cosmos_txs,
            commands_cosmos::cosmos_build_tx,
            commands_cosmos::cosmos_sign_tx,
            commands_cosmos::cosmos_broadcast,
            commands_cosmos::cosmos_tx_status,
            commands_cardano::ada_backend_info,
            commands_cardano::ada_address,
            commands_cardano::ada_account,
            commands_cardano::ada_txs,
            commands_cardano::ada_tx_status,
            commands_cardano::ada_build_tx,
            commands_cardano::ada_sign_tx,
            commands_cardano::ada_broadcast,
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
            commands::set_capture_protection,
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
            commands_hw::hw_thp_pairing_code,
            commands_hw::hw_thp_pairings,
            commands_hw::hw_thp_forget,
        ])
        .run(context)
        .expect("error while running Kyro");
}

/// A 1 s tick that took longer than this means the machine was suspended (or the process was
/// frozen): the session is locked.
const SLEEP_GAP: Duration = Duration::from_secs(20);

/// True when one tick of `expected` took `monotonic` (process clock) or `wall` (system clock)
/// much longer: system sleep / hibernation. Both clocks are checked because the monotonic
/// clock stops during sleep on Linux and macOS, and the wall clock may be adjusted.
fn slept(expected: Duration, monotonic: Duration, wall: Option<Duration>) -> bool {
    let limit = expected + SLEEP_GAP;
    monotonic > limit || wall.is_some_and(|w| w > limit)
}

/// Checks idleness every second; drops (and zeroizes) the session and tells the UI. Also
/// locks after a system sleep, detected when the machine wakes up (portable, no OS hook).
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
        // Windows: the monotonic clock includes the sleep.
        assert!(slept(s(1), s(3600), Some(s(3600))));
        // Linux / macOS: it does not, the wall clock jumps.
        assert!(slept(s(1), s(1), Some(s(600))));
        // Wall clock moved backwards: `elapsed()` fails, the monotonic clock decides.
        assert!(!slept(s(1), s(1), None));
    }
}
