//! Cosmos Hub on a Ledger (app « Cosmos »). The app signs amino JSON only: the transaction is
//! built like the vault's (live account, simulation, fee), then switched to LEGACY_AMINO_JSON
//! (`wallet_core::cosmos_amino_sign_doc`); the device signs the canonical JSON, the DER
//! signature is normalized and verified, and the TxRaw is checked again before broadcast.

use tauri::{AppHandle, State};
use wallet_core::HwKeyChain;

use crate::commands::confirm_native;
use crate::commands_cosmos::{
    broadcast_checked, build, ctx, describe_cosmos, describe_cosmos_extra, prepare_sign,
    CosmosBuilt, CosmosSigned,
};
use crate::commands_hw::device_line;
use crate::commands_hw_keys::{check_device, device_sign, key_array, stored_key};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

const CHAIN: HwKeyChain = HwKeyChain::Cosmos;

#[tauri::command]
pub async fn hw_cosmos_build_tx(
    state: State<'_, AppState>,
    account_id: String,
    to: String,
    amount: String,
    memo: Option<String>,
) -> AppResult<CosmosBuilt> {
    let (_, key) = stored_key(&state, &account_id, CHAIN)?;
    let pk = key_array::<33>(&key)?;
    let mut built = build(
        &ctx(&state),
        &key.address,
        &pk,
        &to,
        &amount,
        memo.as_deref().unwrap_or(""),
    )
    .await?;
    built.sign_doc = wallet_core::cosmos_amino_sign_doc(&built.sign_doc, &pk, state.network)?;
    let again = wallet_core::cosmos_decode_sign_doc(&built.sign_doc, &pk, state.network)?;
    if again != built.summary {
        return Err(AppError::Internal(
            "résumé différent après passage en mode amino".into(),
        ));
    }
    Ok(built)
}

#[tauri::command]
pub async fn hw_sign_cosmos_tx(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    account_id: String,
    sign_doc: String,
) -> AppResult<CosmosSigned> {
    let (acc, key) = stored_key(&state, &account_id, CHAIN)?;
    let pk = key_array::<33>(&key)?;
    let net = state.network;
    // Amino mode only (refused otherwise), before anything is shown.
    let json = wallet_core::cosmos_amino_json(&sign_doc, &pk, net)?;
    let info = check_device(&app, &state, &id, &acc, &key).await?;
    let c = ctx(&state);
    let (summary, context) = prepare_sign(&c, &key.address, &pk, &sign_doc).await?;
    let lang = crate::i18n::current();
    confirm_native(
        &app,
        lang.pick(
            "Confirmer l'envoi d'ATOM (hardware wallet)",
            "Confirm the ATOM send (hardware wallet)",
        ),
        describe_cosmos(lang, &summary, &context, net) + &device_line(lang, &info),
    )
    .await?;
    if summary.requires_extra_confirmation {
        confirm_native(
            &app,
            lang.pick("Attention : envoi à vérifier", "Warning: send to check"),
            describe_cosmos_extra(lang, &summary),
        )
        .await?;
    }
    let der = device_sign(&app, &state, &id, &acc, CHAIN, json).await?;
    let (tx, hash, again) = wallet_core::cosmos_amino_signed(&sign_doc, &pk, net, &der)?;
    if again != summary {
        return Err(AppError::Internal(
            "résumé différent entre l'aperçu et la signature".into(),
        ));
    }
    state.touch();
    Ok(CosmosSigned {
        tx,
        hash,
        summary,
        context,
    })
}

#[tauri::command]
pub async fn hw_cosmos_broadcast(
    state: State<'_, AppState>,
    account_id: String,
    tx: String,
) -> AppResult<String> {
    let (_, key) = stored_key(&state, &account_id, CHAIN)?;
    broadcast_checked(&ctx(&state), &key.address, &key_array(&key)?, &tx).await
}
