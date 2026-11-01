//! Hardware-wallet accounts of the single-key chains — Sui, Aptos, Algorand, NEAR, Cosmos Hub
//! (Ledger only, docs/IPC.md §2.3): reading the key into a watch-only account, showing the
//! address on the device, and the device checks shared by the `hw_*` commands of each chain
//! (`commands_hw_sui.rs`, `commands_hw_aptos.rs`, `commands_hw_algo.rs`, `commands_hw_near.rs`,
//! `commands_hw_cosmos.rs`).
//!
//! Before any signature the key is re-read from the device and must be the stored one
//! (`HW_WRONG_DEVICE` otherwise); the native dialog shows the transaction as decoded by Rust,
//! then the device shows it again; the signature it returns is verified with `wallet-core`.

use serde::Serialize;
use tauri::{AppHandle, State};
use wallet_core::{HwKeyChain, HwWatchKey, WatchOnlyAccount};

use crate::commands_hw::{
    check_account_number, check_brand, guard, load_account, prompt_fn, T_CONFIRM, T_READ,
};
use crate::error::{AppError, AppResult};
use crate::hw::{self, ledger_apps, store, DeviceInfo};
use crate::state::AppState;

pub(crate) fn stored_key(
    state: &AppState,
    account_id: &str,
    chain: HwKeyChain,
) -> AppResult<(WatchOnlyAccount, HwWatchKey)> {
    guard(state)?;
    let acc = load_account(state, account_id)?;
    let key = acc.key(chain).cloned().ok_or_else(|| {
        AppError::InvalidInput(format!(
            "this hardware wallet account has no {} key",
            ledger_apps::hw_chain(chain).label()
        ))
    })?;
    Ok((acc, key))
}

pub(crate) async fn check_device(
    app: &AppHandle,
    state: &AppState,
    id: &str,
    acc: &WatchOnlyAccount,
    key: &HwWatchKey,
) -> AppResult<DeviceInfo> {
    let info = state.hw.info(id)?;
    check_brand(&info, acc)?;
    let (chain, account, net) = (key.chain, acc.account, acc.network);
    let live = state
        .hw
        .run(id, T_READ, prompt_fn(app, id), move |dev, ctl| {
            ledger_apps::pubkey(dev, ctl, chain, account, false, net)
        })
        .await?;
    if live != key.pubkey_bytes()? {
        return Err(AppError::HwWrongDevice);
    }
    Ok(info)
}

pub(crate) async fn device_sign(
    app: &AppHandle,
    state: &AppState,
    id: &str,
    acc: &WatchOnlyAccount,
    chain: HwKeyChain,
    message: Vec<u8>,
) -> AppResult<Vec<u8>> {
    let account = acc.account;
    Ok(state
        .hw
        .run(id, T_CONFIRM, prompt_fn(app, id), move |dev, ctl| {
            ledger_apps::sign(dev, ctl, chain, account, &message)
        })
        .await?)
}

/// Reads the public key of `chain` from device `id` and stores it in a watch-only account,
/// new or `accountId` (same brand and account number; a different key already stored for this
/// chain means another device: `HW_WRONG_DEVICE`).
#[tauri::command]
pub async fn hw_key_add(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    chain: HwKeyChain,
    account: u32,
    account_id: Option<String>,
    label: Option<String>,
) -> AppResult<WatchOnlyAccount> {
    guard(&state)?;
    check_account_number(account)?;
    let info = state.hw.info(&id)?;
    let net = state.network;
    let pk = state
        .hw
        .run(&id, T_READ, prompt_fn(&app, &id), move |dev, ctl| {
            ledger_apps::pubkey(dev, ctl, chain, account, false, net)
        })
        .await?;
    let key = HwWatchKey::new(chain, account, net, &pk)?;
    let _write = hw::lock(&state.hw_store_lock);
    let mut s = store::load(&state.hw_accounts_path, state.network)?;
    let mut acc = match &account_id {
        Some(aid) => {
            let acc = store::find(&s, aid)?;
            check_brand(&info, &acc)?;
            if acc.account != account {
                return Err(AppError::InvalidInput(
                    "account number differs from the existing account's".into(),
                ));
            }
            if acc.key(chain).is_some_and(|k| k.pubkey != key.pubkey) {
                return Err(AppError::HwWrongDevice);
            }
            acc
        }
        None => WatchOnlyAccount {
            id: store::new_id(&s),
            label: String::new(),
            device: info.kind,
            model: info.model.clone(),
            network: state.network,
            account,
            btc: Vec::new(),
            evm: None,
            sol: None,
            utxo: Vec::new(),
            xrp: None,
            tron: None,
            stellar: None,
            cardano: None,
            zec: None,
            keys: Vec::new(),
        },
    };
    if let Some(l) = label {
        acc.label = l.trim().to_string();
    }
    if acc.label.is_empty() {
        acc.label = format!("{} {}", info.model, account + 1);
    }
    acc.keys.retain(|k| k.chain != chain);
    acc.keys.push(key);
    acc.validate()?;
    s.accounts.retain(|a| a.id != acc.id);
    s.accounts.push(acc.clone());
    store::save(&state.hw_accounts_path, &s, state.network)?;
    Ok(acc)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedKey {
    address: String,
    path: String,
}

/// Shows the account's key for `chain` on the device screen (the app displays the address,
/// or for NEAR the `ed25519:…` public key) after checking it is the stored one.
#[tauri::command]
pub async fn hw_key_verify(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    account_id: String,
    chain: HwKeyChain,
) -> AppResult<VerifiedKey> {
    let (acc, key) = stored_key(&state, &account_id, chain)?;
    check_device(&app, &state, &id, &acc, &key).await?;
    let (account, net) = (acc.account, acc.network);
    let shown = state
        .hw
        .run(&id, T_CONFIRM, prompt_fn(&app, &id), move |dev, ctl| {
            ledger_apps::pubkey(dev, ctl, chain, account, true, net)
        })
        .await?;
    if shown != key.pubkey_bytes()? {
        return Err(AppError::HwAddressMismatch {
            device: chain.address_of(&shown, net)?,
            expected: key.address,
        });
    }
    Ok(VerifiedKey {
        address: key.address,
        path: key.path,
    })
}

pub(crate) fn key_array<const N: usize>(key: &HwWatchKey) -> AppResult<[u8; N]> {
    key.pubkey_bytes()?
        .try_into()
        .map_err(|_| AppError::Internal("saved key of unexpected length".into()))
}
