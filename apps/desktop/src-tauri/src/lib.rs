mod btc_backend;
#[cfg(feature = "cbf")]
mod cbf;
mod commands;
mod commands_hw;
mod commands_servers;
mod commands_tron;
mod commands_utxo;
mod commands_xrp;
mod core_rpc;
mod electrum;
mod error;
mod hw;
mod net;
mod servers;
mod settings;
mod solana;
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

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            app.manage(state::AppState::new(dir)?);
            let st = app.state::<state::AppState>();
            let handle = app.handle().clone();
            st.net.tor.set_emitter(move |s| {
                let _ = handle.emit("tor-status", s);
            });
            if st.settings().tor.enabled {
                st.net.tor.start();
            }
            spawn_auto_lock(app.handle().clone());
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
            commands::session_touch,
            commands::accounts_get,
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
            commands::set_capture_protection,
            commands::config_get,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running Kyro");
}

/// Checks idleness every second; drops (and zeroizes) the session and tells the UI.
fn spawn_auto_lock(app: tauri::AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(1));
        if app.state::<state::AppState>().expire_if_idle() {
            let _ = app.emit("vault-locked", ());
        }
    });
}
