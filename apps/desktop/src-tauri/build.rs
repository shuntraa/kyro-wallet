// Every command the webview may call must be listed here AND granted in
// capabilities/default.json. Anything else is rejected by Tauri (least privilege).
const COMMANDS: &[&str] = &[
    "vault_status",
    "vault_create",
    "vault_import",
    "vault_unlock",
    "vault_lock",
    "vault_reveal_mnemonic",
    "session_touch",
    "accounts_get",
    "btc_address",
    "evm_decode_tx",
    "evm_sign_tx",
    "btc_sign_psbt",
    "sol_decode_tx",
    "sol_sign_tx",
    "net_fetch",
    "settings_get",
    "settings_set",
    "server_test",
    "electrum_fetch_cert",
    "btc_backend_info",
    "btc_address_info",
    "btc_address_utxos",
    "btc_address_txs",
    "btc_fee_rates",
    "btc_tip_height",
    "btc_broadcast",
    "btc_core_setup",
    "btc_core_status",
    "btc_cbf_status",
    "btc_cbf_sync",
    "set_capture_protection",
    "config_get",
    "tor_status",
    "tor_retry",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
