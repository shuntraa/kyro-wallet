//! NEAR on a Ledger (app « NEAR »): build for the hardware account's implicit account (key at
//! `m/44'/397'/0'/0'/(account + 1)'`, not the vault's path, see `wallet_core::HwKeyChain`),
//! native dialog, signature of the Borsh transaction on the device, verification, sending.

use tauri::{AppHandle, State};
use wallet_core::HwKeyChain;

use crate::commands::confirm_native;
use crate::commands_hw::device_line;
use crate::commands_hw_keys::{check_device, device_sign, key_array, stored_key};
use crate::commands_near::{
    broadcast_checked, build, ctx, describe_near, describe_near_extra, prepare_sign, NearBuilt,
    NearSigned,
};
use crate::error::AppResult;
use crate::near_backend::{self, NearTxOutcome};
use crate::state::AppState;

const CHAIN: HwKeyChain = HwKeyChain::Near;

#[tauri::command]
pub async fn hw_near_build_tx(
    state: State<'_, AppState>,
    account_id: String,
    to: String,
    amount: String,
) -> AppResult<NearBuilt> {
    let (_, key) = stored_key(&state, &account_id, CHAIN)?;
    build(&ctx(&state), &key.address, &key_array(&key)?, &to, &amount).await
}

#[tauri::command]
pub async fn hw_sign_near_tx(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    account_id: String,
    tx: String,
) -> AppResult<NearSigned> {
    let (acc, key) = stored_key(&state, &account_id, CHAIN)?;
    let pk = key_array::<32>(&key)?;
    let info = check_device(&app, &state, &id, &acc, &key).await?;
    let c = ctx(&state);
    let (summary, context) = prepare_sign(&c, &key.address, &pk, &tx).await?;
    let lang = crate::i18n::current();
    confirm_native(
        &app,
        lang.pick(
            "Confirmer l'envoi NEAR (hardware wallet)",
            "Confirm the NEAR send (hardware wallet)",
        ),
        describe_near(lang, &summary, &context, state.network) + &device_line(lang, &info),
    )
    .await?;
    if summary.requires_extra_confirmation {
        confirm_native(
            &app,
            lang.pick(
                "Attention : transfert à vérifier",
                "Warning: transfer to check",
            ),
            describe_near_extra(lang, &summary),
        )
        .await?;
    }
    let message = wallet_core::near_hw_message(&tx)?;
    let sig = device_sign(&app, &state, &id, &acc, CHAIN, message).await?;
    let (signed, hash) = wallet_core::near_hw_signed(&tx, &sig)?;
    state.touch();
    Ok(NearSigned {
        signed,
        hash,
        summary,
        context,
    })
}

#[tauri::command]
pub async fn hw_near_broadcast(
    state: State<'_, AppState>,
    account_id: String,
    signed: String,
) -> AppResult<NearTxOutcome> {
    let (_, key) = stored_key(&state, &account_id, CHAIN)?;
    broadcast_checked(&ctx(&state), &key.address, &signed).await
}

#[tauri::command]
pub async fn hw_near_tx_status(
    state: State<'_, AppState>,
    account_id: String,
    hash: String,
) -> AppResult<NearTxOutcome> {
    let (_, key) = stored_key(&state, &account_id, CHAIN)?;
    let h = hash.trim();
    wallet_core::near_parse_hash(h)?;
    near_backend::tx_status(&ctx(&state), h, &key.address).await
}
