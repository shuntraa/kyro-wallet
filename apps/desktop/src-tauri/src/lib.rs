mod commands;
mod error;
mod net;
mod settings;
mod state;

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
            commands::sol_sign_message,
            commands::net_fetch,
            commands::settings_get,
            commands::settings_set,
            commands::set_capture_protection,
            commands::config_get,
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
