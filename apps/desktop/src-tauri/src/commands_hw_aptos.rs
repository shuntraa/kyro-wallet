//! Aptos on a Ledger (app « Aptos »): build for the hardware account, native dialog, signature
//! of the signing message on the device, verified signed transaction, submission.

use tauri::{AppHandle, State};
use wallet_core::HwKeyChain;

use crate::commands::confirm_native;
use crate::commands_aptos::{
    broadcast_checked, build, ctx, describe_aptos, describe_aptos_extra, prepare_sign,
    AptosBuilt, AptosSigned,
};
use crate::commands_hw::device_line;
use crate::commands_hw_keys::{check_device, device_sign, key_array, stored_key};
use crate::error::AppResult;
use crate::state::AppState;

const CHAIN: HwKeyChain = HwKeyChain::Aptos;

#[tauri::command]
pub async fn hw_aptos_build_tx(
    state: State<'_, AppState>,
    account_id: String,
    to: String,
    amount: String,
) -> AppResult<AptosBuilt> {
    let (_, key) = stored_key(&state, &account_id, CHAIN)?;
    build(&ctx(&state), &key.address, &key_array(&key)?, &to, &amount).await
}

#[tauri::command]
pub async fn hw_sign_aptos_tx(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    account_id: String,
    raw: String,
) -> AppResult<AptosSigned> {
    let (acc, key) = stored_key(&state, &account_id, CHAIN)?;
    let pk = key_array::<32>(&key)?;
    let info = check_device(&app, &state, &id, &acc, &key).await?;
    let c = ctx(&state);
    let (summary, context) = prepare_sign(&c, &key.address, &pk, &raw).await?;
    let lang = crate::i18n::current();
    confirm_native(
        &app,
        lang.pick(
            "Confirmer l'envoi d'APT (hardware wallet)",
            "Confirm the APT send (hardware wallet)",
        ),
        describe_aptos(lang, &summary, &context, state.network) + &device_line(lang, &info),
    )
    .await?;
    if summary.requires_extra_confirmation {
        confirm_native(
            &app,
            lang.pick(
                "Attention : transfert à vérifier",
                "Warning: transfer to check",
            ),
            describe_aptos_extra(lang, &summary),
        )
        .await?;
    }
    let message = wallet_core::aptos_hw_message(&raw)?;
    let sig = device_sign(&app, &state, &id, &acc, CHAIN, message).await?;
    let (signed, hash) = wallet_core::aptos_hw_signed(&raw, &pk, &sig)?;
    state.touch();
    Ok(AptosSigned {
        signed,
        hash,
        summary,
        context,
    })
}

#[tauri::command]
pub async fn hw_aptos_broadcast(
    state: State<'_, AppState>,
    account_id: String,
    signed: String,
) -> AppResult<String> {
    let (_, key) = stored_key(&state, &account_id, CHAIN)?;
    broadcast_checked(&ctx(&state), &key.address, &signed).await
}
