//! TON on a Ledger (app « TON » ≥ 2.1.0): build for the hardware account's own v4R2 wallet (key at
//! `m/44'/607'/0'/0'/account'/0'`, not the vault's path, see `wallet_core::HwKeyChain`; the
//! network's wallet id, like the vault), native dialog, then the device rebuilds the order from the
//! structured request (`wallet_core::ton_hw_request`), shows it and signs.

use tauri::{AppHandle, State};
use wallet_core::{HwKeyChain, HwWatchKey, TonAddress};

use crate::commands::confirm_native;
use crate::commands_hw::device_line;
use crate::commands_hw_keys::{check_device, device_sign, key_array, stored_key};
use crate::commands_ton::{
    broadcast_checked, build, ctx, describe_ton, describe_ton_extra, now, prepare_sign, TonBuilt,
    TonSignedOut, TransferRequest,
};
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::ton_backend::testnet;

const CHAIN: HwKeyChain = HwKeyChain::Ton;

fn wallet_of(state: &AppState, key: &HwWatchKey) -> AppResult<([u8; 32], TonAddress)> {
    let pk = key_array::<32>(key)?;
    let t = testnet(state.network);
    let me = wallet_core::ton_wallet_address(&pk, wallet_core::ton_wallet_id(t))?;
    if me.to_friendly(false, t) != key.address {
        return Err(AppError::Internal(
            "saved TON address differs from the key's".into(),
        ));
    }
    Ok((pk, me))
}

#[tauri::command]
pub async fn hw_ton_build_tx(
    state: State<'_, AppState>,
    account_id: String,
    to: String,
    amount: String,
    comment: Option<String>,
    send_all: Option<bool>,
) -> AppResult<TonBuilt> {
    let (_, key) = stored_key(&state, &account_id, CHAIN)?;
    let (pk, me) = wallet_of(&state, &key)?;
    let req = TransferRequest {
        to: &to,
        amount: &amount,
        comment: comment.as_deref(),
        send_all: send_all.unwrap_or(false),
        hw: true,
    };
    build(&ctx(&state), &pk, &me, &req, now()).await
}

#[tauri::command]
pub async fn hw_sign_ton_tx(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    account_id: String,
    boc: String,
) -> AppResult<TonSignedOut> {
    let (acc, key) = stored_key(&state, &account_id, CHAIN)?;
    let (pk, me) = wallet_of(&state, &key)?;
    let net = state.network;
    let (request, _) = wallet_core::ton_hw_request(&boc, &pk, testnet(net))?;
    let info = check_device(&app, &state, &id, &acc, &key).await?;
    let c = ctx(&state);
    let (summary, context) = prepare_sign(&c, &pk, &me, &boc, now()).await?;
    let lang = crate::i18n::current();
    confirm_native(
        &app,
        lang.pick(
            "Confirmer l'envoi TON (hardware wallet)",
            "Confirm the TON send (hardware wallet)",
        ),
        describe_ton(lang, &summary, &context, net, now()) + &device_line(lang, &info),
    )
    .await?;
    if summary.requires_extra_confirmation {
        confirm_native(
            &app,
            lang.pick(
                "Attention : transfert à vérifier",
                "Warning: transfer to check",
            ),
            describe_ton_extra(lang, &summary),
        )
        .await?;
    }
    let out = device_sign(&app, &state, &id, &acc, CHAIN, request).await?;
    if out.len() != 96 {
        return Err(AppError::Internal(
            "device response of unexpected length".into(),
        ));
    }
    let (hash, sig) = out.split_at(32);
    let signed = wallet_core::ton_hw_signed(&boc, &pk, testnet(net), sig, hash)?;
    if signed.summary != summary {
        return Err(AppError::Internal(
            "summary differs between the preview and the signature".into(),
        ));
    }
    state.touch();
    Ok(TonSignedOut {
        boc: signed.boc,
        hash: signed.hash,
        normalized_hash: signed.normalized_hash,
        summary,
        context,
    })
}

#[tauri::command]
pub async fn hw_ton_broadcast(
    state: State<'_, AppState>,
    account_id: String,
    boc: String,
) -> AppResult<String> {
    let (_, key) = stored_key(&state, &account_id, CHAIN)?;
    let (pk, _) = wallet_of(&state, &key)?;
    broadcast_checked(&ctx(&state), &pk, &boc, now()).await
}
