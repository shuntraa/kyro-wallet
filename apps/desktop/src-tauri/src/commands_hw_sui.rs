//! Sui on a Ledger (app « Sui »): build for the hardware account's address, native dialog,
//! signature on the device, verified serialized signature, execution (docs/IPC.md §2.3).

use tauri::{AppHandle, State};
use wallet_core::HwKeyChain;

use crate::commands::confirm_native;
use crate::commands_hw::device_line;
use crate::commands_hw_keys::{
    check_device, device_sign, device_sign_sui_token, key_array, stored_key,
};
use crate::commands_sui::{
    broadcast_checked, build, build_token, ctx, describe_sui, describe_sui_extra, prepare_sign,
    SuiBuilt, SuiSigned,
};
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::sui_backend;

const CHAIN: HwKeyChain = HwKeyChain::Sui;

#[tauri::command]
pub async fn hw_sui_build_tx(
    state: State<'_, AppState>,
    account_id: String,
    to: String,
    amount: Option<String>,
    all: Option<bool>,
) -> AppResult<SuiBuilt> {
    let (_, key) = stored_key(&state, &account_id, CHAIN)?;
    let amount = if all.unwrap_or(false) {
        None
    } else {
        Some(
            amount
                .as_deref()
                .map(str::trim)
                .and_then(|a| a.parse::<u64>().ok())
                .filter(|a| *a > 0)
                .ok_or_else(|| AppError::InvalidInput("invalid amount in MIST".into()))?,
        )
    };
    build(&ctx(&state), &key.address, &to, amount).await
}

/// The Ledger Sui app parses at most a few merged coins.
fn check_hw_coins(n: usize) -> AppResult<()> {
    if n > wallet_core::SUI_HW_MAX_TOKEN_COINS {
        return Err(AppError::InvalidInput(format!(
            "this transfer needs {n} token coins and a Ledger reads {} at most: send a smaller \
             amount",
            wallet_core::SUI_HW_MAX_TOKEN_COINS
        )));
    }
    Ok(())
}

/// Token transfer of the known `coinType`: `amount` in token units, or `all`.
#[tauri::command]
pub async fn hw_sui_build_token_tx(
    state: State<'_, AppState>,
    account_id: String,
    coin_type: String,
    to: String,
    amount: Option<String>,
    all: Option<bool>,
) -> AppResult<SuiBuilt> {
    let (_, key) = stored_key(&state, &account_id, CHAIN)?;
    let amount = if all.unwrap_or(false) {
        None
    } else {
        Some(
            amount
                .as_deref()
                .map(str::trim)
                .and_then(|a| a.parse::<u64>().ok())
                .filter(|a| *a > 0)
                .ok_or_else(|| AppError::InvalidInput("invalid token amount".into()))?,
        )
    };
    let built = build_token(&ctx(&state), &key.address, &to, &coin_type, amount).await?;
    check_hw_coins(built.summary.token.as_ref().map_or(0, |t| t.coins.len()))?;
    Ok(built)
}

#[tauri::command]
pub async fn hw_sign_sui_tx(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    account_id: String,
    bcs: String,
    coin_type: Option<String>,
) -> AppResult<SuiSigned> {
    let (acc, key) = stored_key(&state, &account_id, CHAIN)?;
    let info = check_device(&app, &state, &id, &acc, &key).await?;
    let c = ctx(&state);
    let coin_type = coin_type
        .map(|t| t.trim().to_owned())
        .filter(|t| !t.is_empty());
    let (summary, context) = prepare_sign(&c, &key.address, &bcs, coin_type.as_deref()).await?;
    // A token transfer: the coin objects the app reads the token and amounts from, read before
    // the dialog so that an unusable server stops here. Gas coins too, as the app advises.
    let objects = match &summary.token {
        Some(t) => {
            check_hw_coins(t.coins.len())?;
            let mut refs = Vec::new();
            for g in t.coins.iter().chain(&summary.gas_coins) {
                let version = g.version.parse().unwrap_or(0);
                refs.push(wallet_core::SuiObjectRef::parse(
                    &g.object_id,
                    version,
                    &g.digest,
                )?);
            }
            sui_backend::object_bcs(&c, &refs).await?
        }
        None => Vec::new(),
    };
    let lang = crate::i18n::current();
    confirm_native(
        &app,
        lang.pick(
            "Confirmer le transfert Sui (hardware wallet)",
            "Confirm the Sui transfer (hardware wallet)",
        ),
        describe_sui(lang, &summary, &context, state.network) + &device_line(lang, &info),
    )
    .await?;
    if summary.requires_extra_confirmation {
        confirm_native(
            &app,
            lang.pick(
                "Attention : transfert à vérifier",
                "Warning: transfer to check",
            ),
            describe_sui_extra(lang, &summary),
        )
        .await?;
    }
    let message = wallet_core::sui_hw_message(&bcs)?;
    let sig = if objects.is_empty() {
        device_sign(&app, &state, &id, &acc, CHAIN, message).await?
    } else {
        device_sign_sui_token(&app, &state, &id, &acc, message, objects).await?
    };
    let signature = wallet_core::sui_hw_signature(&bcs, &key_array::<32>(&key)?, &sig)?;
    state.touch();
    Ok(SuiSigned {
        bcs,
        signature,
        digest: summary.digest.clone(),
        summary,
        context,
    })
}

#[tauri::command]
pub async fn hw_sui_broadcast(
    state: State<'_, AppState>,
    account_id: String,
    bcs: String,
    signature: String,
) -> AppResult<String> {
    let (_, key) = stored_key(&state, &account_id, CHAIN)?;
    broadcast_checked(&ctx(&state), &key.address, &bcs, &signature).await
}
