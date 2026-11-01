//! Hedera on a Ledger (app « Hedera »): an **ED25519** account (key at
//! `m/44'/3030'/0'/0'/account'`, not the vault's ECDSA key, see `wallet_core::HwKeyChain`),
//! found on the mirror node by its public key (it must have been created first: by Ledger
//! Live, HashPack, an exchange…; Kyro does not create accounts). Build for that account with
//! **one** copy (one consensus node: each copy is one confirmation on the device), native
//! dialog, signature of the body on the device, ED25519 verification, sending. Status of a
//! sent transfer: the generic `hbar_tx_status`.

use tauri::{AppHandle, State};
use wallet_core::HwKeyChain;

use crate::commands::confirm_native;
use crate::commands_hbar::{
    broadcast_checked, build, ctx, describe_hbar, describe_hbar_extra, own_account, prepare_sign,
    HbarBuilt, HbarOwnAccount, HbarSigned, OurKey,
};
use crate::commands_hw::device_line;
use crate::commands_hw_keys::{check_device, device_sign, key_array, stored_key};
use crate::error::{AppError, AppResult};
use crate::hbar_backend;
use crate::state::AppState;

const CHAIN: HwKeyChain = HwKeyChain::Hbar;

/// The node a hardware transfer is built for (the first of Kyro's list for the network).
fn hw_nodes(state: &AppState) -> Vec<u64> {
    hbar_backend::node_ids(state.network)
        .into_iter()
        .take(1)
        .collect()
}

/// The hardware account on the mirror node (found by its ED25519 key).
#[tauri::command]
pub async fn hw_hbar_account(
    state: State<'_, AppState>,
    account_id: String,
) -> AppResult<HbarOwnAccount> {
    let (_, key) = stored_key(&state, &account_id, CHAIN)?;
    let pk = key_array::<32>(&key)?;
    own_account(&ctx(&state), OurKey::Ed25519(&pk), key.address.clone()).await
}

#[tauri::command]
pub async fn hw_hbar_build_tx(
    state: State<'_, AppState>,
    account_id: String,
    to: String,
    amount: String,
    memo: Option<String>,
) -> AppResult<HbarBuilt> {
    let (_, key) = stored_key(&state, &account_id, CHAIN)?;
    let pk = key_array::<32>(&key)?;
    let built = build(
        &ctx(&state),
        OurKey::Ed25519(&pk),
        &to,
        &amount,
        memo.as_deref(),
        &hw_nodes(&state),
    )
    .await?;
    // Refused now rather than by the device (one APDU).
    for b in &built.bodies {
        wallet_core::hbar_hw_message(b)?;
    }
    Ok(built)
}

#[tauri::command]
pub async fn hw_sign_hbar_tx(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    account_id: String,
    bodies: Vec<String>,
) -> AppResult<HbarSigned> {
    let (acc, key) = stored_key(&state, &account_id, CHAIN)?;
    let pk = key_array::<32>(&key)?;
    let messages = bodies
        .iter()
        .map(|b| wallet_core::hbar_hw_message(b))
        .collect::<Result<Vec<_>, _>>()?;
    if messages.len() != 1 {
        return Err(AppError::InvalidInput(
            "hardware wallet : une seule copie (un nœud) attendue".into(),
        ));
    }
    let info = check_device(&app, &state, &id, &acc, &key).await?;
    let c = ctx(&state);
    let (_, summary, context) =
        prepare_sign(&c, OurKey::Ed25519(&pk), &bodies, &hw_nodes(&state)).await?;
    let lang = crate::i18n::current();
    confirm_native(
        &app,
        lang.pick(
            "Confirmer le transfert Hedera (hardware wallet)",
            "Confirm the Hedera transfer (hardware wallet)",
        ),
        describe_hbar(lang, &summary, &context, state.network) + &device_line(lang, &info),
    )
    .await?;
    if summary.requires_extra_confirmation {
        confirm_native(
            &app,
            lang.pick(
                "Attention : transfert à vérifier",
                "Warning: transfer to check",
            ),
            describe_hbar_extra(lang, &summary),
        )
        .await?;
    }
    let mut signed = Vec::with_capacity(bodies.len());
    for (b, m) in bodies.iter().zip(messages) {
        let sig = device_sign(&app, &state, &id, &acc, CHAIN, m).await?;
        signed.push(wallet_core::hbar_hw_signed(b, &pk, &sig)?);
    }
    state.touch();
    Ok(HbarSigned {
        signed,
        summary,
        context,
    })
}

#[tauri::command]
pub async fn hw_hbar_broadcast(
    state: State<'_, AppState>,
    account_id: String,
    signed: Vec<String>,
) -> AppResult<String> {
    let (_, key) = stored_key(&state, &account_id, CHAIN)?;
    let pk = key_array::<32>(&key)?;
    broadcast_checked(&ctx(&state), OurKey::Ed25519(&pk), &signed).await
}
