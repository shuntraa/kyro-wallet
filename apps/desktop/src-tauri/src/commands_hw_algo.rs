//! Algorand on a Ledger (app « Algorand »): build for the hardware account, native dialog,
//! signature of the msgpack on the device, verified signed transaction, submission.

use tauri::{AppHandle, State};
use wallet_core::HwKeyChain;

use crate::commands::confirm_native;
use crate::commands_algo::{
    broadcast_checked, build, ctx, describe_algo, describe_algo_extra, prepare_sign, AlgoBuilt,
    AlgoSigned,
};
use crate::commands_hw::device_line;
use crate::commands_hw_keys::{check_device, device_sign, stored_key};
use crate::error::AppResult;
use crate::state::AppState;

const CHAIN: HwKeyChain = HwKeyChain::Algo;

#[tauri::command]
pub async fn hw_algo_build_tx(
    state: State<'_, AppState>,
    account_id: String,
    to: String,
    amount: String,
    note: Option<String>,
) -> AppResult<AlgoBuilt> {
    let (_, key) = stored_key(&state, &account_id, CHAIN)?;
    build(&ctx(&state), &key.address, &to, &amount, note.as_deref()).await
}

#[tauri::command]
pub async fn hw_sign_algo_tx(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    account_id: String,
    blob: String,
) -> AppResult<AlgoSigned> {
    let (acc, key) = stored_key(&state, &account_id, CHAIN)?;
    let info = check_device(&app, &state, &id, &acc, &key).await?;
    let c = ctx(&state);
    let net = state.network;
    let (summary, context) = prepare_sign(&c, &key.address, &blob).await?;
    let lang = crate::i18n::current();
    confirm_native(
        &app,
        lang.pick(
            "Confirmer le paiement Algorand (hardware wallet)",
            "Confirm the Algorand payment (hardware wallet)",
        ),
        describe_algo(lang, &summary, &context, net) + &device_line(lang, &info),
    )
    .await?;
    if summary.requires_extra_confirmation {
        confirm_native(
            &app,
            lang.pick(
                "Attention : paiement à vérifier",
                "Warning: payment to check",
            ),
            describe_algo_extra(lang, &summary),
        )
        .await?;
    }
    let message = wallet_core::algo_hw_message(&blob)?;
    let sig = device_sign(&app, &state, &id, &acc, CHAIN, message).await?;
    let (signed, txid) = wallet_core::algo_hw_signed(&blob, net, &key.address, &sig)?;
    state.touch();
    Ok(AlgoSigned {
        blob: signed,
        txid,
        summary,
        context,
    })
}

#[tauri::command]
pub async fn hw_algo_broadcast(
    state: State<'_, AppState>,
    account_id: String,
    blob: String,
) -> AppResult<String> {
    let (_, key) = stored_key(&state, &account_id, CHAIN)?;
    broadcast_checked(&ctx(&state), &key.address, &blob).await
}
