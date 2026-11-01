//! Hardware-wallet commands of Litecoin, Dogecoin, Bitcoin Cash, Dash, XRP, TRON and Stellar
//! (docs/IPC.md §2.3). Same rules as `commands_hw.rs`: Rust decodes and re-checks what will be
//! signed, the device's keys are compared with the stored account first (`HW_WRONG_DEVICE`),
//! Kyro's native dialog shows its own summary, the user confirms on the device, and the
//! signature is verified in `wallet-core` before anything is returned.
//!
//! Build and broadcast take the hardware account (`accountId`) instead of a vault account: a
//! hardware-only user has no vault.

use std::str::FromStr;

use tauri::{AppHandle, State};
use wallet_core::{UtxoCoin, UtxoTxSummary, WatchKey, WatchOnlyAccount};

use crate::commands::confirm_native;
use crate::commands_hw::{
    check_brand, device_line, guard, load_account, prompt_fn, T_CONFIRM, T_READ,
};
use crate::commands_stellar::{MemoSpec, StellarBuilt, StellarSigned};
use crate::commands_tron::{TronBuilt, TronSigned};
use crate::commands_xrp::{IssuedSpec, XrpBuilt, XrpSigned};
use crate::error::{AppError, AppResult};
use crate::hw::{chains, Chain, DeviceInfo};
use crate::i18n::Lang;
use crate::state::AppState;

fn title(lang: Lang, chain: Chain) -> &'static str {
    let (fr, en) = match chain {
        Chain::Ltc => (
            "Confirmer la transaction Litecoin (hardware wallet)",
            "Confirm the Litecoin transaction (hardware wallet)",
        ),
        Chain::Doge => (
            "Confirmer la transaction Dogecoin (hardware wallet)",
            "Confirm the Dogecoin transaction (hardware wallet)",
        ),
        Chain::Bch => (
            "Confirmer la transaction Bitcoin Cash (hardware wallet)",
            "Confirm the Bitcoin Cash transaction (hardware wallet)",
        ),
        Chain::Dash => (
            "Confirmer la transaction Dash (hardware wallet)",
            "Confirm the Dash transaction (hardware wallet)",
        ),
        Chain::Xrp => (
            "Confirmer le paiement XRP (hardware wallet)",
            "Confirm the XRP payment (hardware wallet)",
        ),
        Chain::Tron => (
            "Confirmer la transaction TRON (hardware wallet)",
            "Confirm the TRON transaction (hardware wallet)",
        ),
        _ => (
            "Confirmer l'envoi Stellar (hardware wallet)",
            "Confirm the Stellar send (hardware wallet)",
        ),
    };
    lang.pick(fr, en)
}

/// Account + device info, checked: same brand, and the account holds keys of `chain`.
fn account_for(
    state: &AppState,
    id: Option<&str>,
    account_id: &str,
    chain: Chain,
) -> AppResult<(WatchOnlyAccount, Option<DeviceInfo>)> {
    guard(state)?;
    let acc = load_account(state, account_id)?;
    let info = match id {
        Some(id) => {
            let info = state.hw.info(id)?;
            check_brand(&info, &acc)?;
            Some(info)
        }
        None => None,
    };
    let has = match chains::utxo_coin(chain) {
        Some(coin) => acc.utxo_account(coin).is_some(),
        None => key_of(&acc, chain).is_some(),
    };
    if !has {
        return Err(AppError::InvalidInput(format!(
            "this hardware-wallet account has no {} key",
            chain.label()
        )));
    }
    Ok((acc, info))
}

fn key_of(acc: &WatchOnlyAccount, chain: Chain) -> Option<&WatchKey> {
    match chain {
        Chain::Xrp => acc.xrp.as_ref(),
        Chain::Tron => acc.tron.as_ref(),
        Chain::Stellar => acc.stellar.as_ref(),
        _ => None,
    }
}

/// Step 1 of every signature: is the device the one of this account?
async fn check_same_device(
    app: &AppHandle,
    state: &AppState,
    id: &str,
    acc: &WatchOnlyAccount,
    chain: Chain,
) -> AppResult<()> {
    let acc2 = acc.clone();
    let same = state
        .hw
        .run(id, T_READ, prompt_fn(app, id), move |dev, ctl| {
            chains::same_device(dev, ctl, &acc2, chain)
        })
        .await?;
    if !same {
        return Err(AppError::HwWrongDevice);
    }
    Ok(())
}

// ---------------------------------------------------------------- Litecoin / Dogecoin / BCH / Dash

#[derive(serde::Serialize)]
pub struct HwUtxoSigned {
    psbt: String,
    summary: UtxoTxSummary,
}

fn coin_of(chain: Chain) -> AppResult<UtxoCoin> {
    chains::utxo_coin(chain)
        .ok_or_else(|| AppError::InvalidInput("chain expected: ltc, doge, bch or dash".into()))
}

/// Signs a Litecoin / Dogecoin / Bitcoin Cash / Dash PSBT on the device. Every input must be
/// of this account and carry its previous transaction (`non_witness_utxo`, also for Litecoin).
/// Returns the PSBT with verified partial signatures (Bitcoin Cash: inputs finalized).
#[tauri::command]
pub async fn hw_sign_utxo_psbt(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    account_id: String,
    chain: Chain,
    psbt: String,
) -> AppResult<HwUtxoSigned> {
    let coin = coin_of(chain)?;
    let (acc, info) = account_for(&state, Some(&id), &account_id, chain)?;
    let info = info.ok_or(AppError::HwNotFound)?;
    let net = state.network;
    let account = acc
        .utxo_account(coin)
        .cloned()
        .ok_or_else(|| AppError::Internal("missing UTXO account".into()))?;
    let plan = wallet_core::utxo_hw_plan(net, coin, &account, &psbt)?;
    check_same_device(&app, &state, &id, &acc, chain).await?;
    let lang = crate::i18n::current();
    let summary = plan.summary.clone();
    confirm_native(
        &app,
        title(lang, chain),
        crate::commands_utxo::describe_utxo(lang, &summary, net) + &device_line(lang, &info),
    )
    .await?;
    if summary.requires_extra_confirmation {
        confirm_native(
            &app,
            lang.check_tx_title(),
            crate::commands_utxo::describe_utxo_extra(lang, &summary),
        )
        .await?;
    }
    let parsed = bitcoin::psbt::Psbt::from_str(psbt.trim())
        .map_err(|_| AppError::InvalidInput("invalid PSBT".into()))?;
    let plan2 = plan.clone();
    let sigs = state
        .hw
        .run(&id, T_CONFIRM, prompt_fn(&app, &id), move |dev, ctl| {
            chains::sign_utxo(dev, ctl, net, coin, &parsed, &plan2)
        })
        .await?;
    let (signed, again) = wallet_core::utxo_hw_finalize(net, coin, &account, &psbt, &sigs)?;
    if again != summary {
        return Err(AppError::Internal(
            "summary differs between the preview and the signature".into(),
        ));
    }
    state.touch();
    Ok(HwUtxoSigned {
        psbt: signed,
        summary,
    })
}

// ---------------------------------------------------------------- XRP

fn xrp_key(acc: &WatchOnlyAccount) -> AppResult<(String, [u8; 33])> {
    let k = key_of(acc, Chain::Xrp).ok_or_else(|| AppError::InvalidInput("no XRP key".into()))?;
    let pk: [u8; 33] = k
        .pubkey_bytes()?
        .try_into()
        .map_err(|_| AppError::InvalidInput("invalid XRP key".into()))?;
    Ok((k.address.clone(), pk))
}

#[tauri::command]
pub async fn hw_xrp_build_tx(
    state: State<'_, AppState>,
    account_id: String,
    to: String,
    amount: String,
    destination_tag: Option<u32>,
    issued: Option<IssuedSpec>,
) -> AppResult<XrpBuilt> {
    let (acc, _) = account_for(&state, None, &account_id, Chain::Xrp)?;
    let (me, pk) = xrp_key(&acc)?;
    crate::commands_xrp::build(
        &crate::commands_xrp::ctx(&state),
        &me,
        &pk,
        &to,
        &amount,
        destination_tag,
        issued.as_ref(),
    )
    .await
}

#[tauri::command]
pub async fn hw_sign_xrp_tx(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    account_id: String,
    blob: String,
) -> AppResult<XrpSigned> {
    let (acc, info) = account_for(&state, Some(&id), &account_id, Chain::Xrp)?;
    let info = info.ok_or(AppError::HwNotFound)?;
    let (me, pk) = xrp_key(&acc)?;
    let c = crate::commands_xrp::ctx(&state);
    let (summary, context) = crate::commands_xrp::prepare_sign(&c, &me, &pk, &blob).await?;
    check_same_device(&app, &state, &id, &acc, Chain::Xrp).await?;
    let lang = crate::i18n::current();
    confirm_native(
        &app,
        title(lang, Chain::Xrp),
        crate::commands_xrp::describe_xrp(lang, &summary, &context, state.network)
            + &device_line(lang, &info),
    )
    .await?;
    if summary.requires_extra_confirmation {
        confirm_native(
            &app,
            lang.pick(
                "Attention : paiement à vérifier",
                "Warning: payment to check",
            ),
            crate::commands_xrp::describe_xrp_extra(lang, &summary),
        )
        .await?;
    }
    let raw = hex::decode(blob.trim())
        .map_err(|_| AppError::InvalidInput("blob: hexadecimal expected".into()))?;
    let (net, account) = (state.network, acc.account);
    let der = state
        .hw
        .run(&id, T_CONFIRM, prompt_fn(&app, &id), move |dev, ctl| {
            chains::sign_xrp(dev, ctl, net, account, &raw)
        })
        .await?;
    let (signed, hash) = wallet_core::xrp_hw_assemble(&blob, &pk, &der)?;
    state.touch();
    Ok(XrpSigned {
        blob: signed,
        hash,
        summary,
        context,
    })
}

#[tauri::command]
pub async fn hw_xrp_broadcast(
    state: State<'_, AppState>,
    account_id: String,
    blob: String,
) -> AppResult<String> {
    let (acc, _) = account_for(&state, None, &account_id, Chain::Xrp)?;
    let (me, _) = xrp_key(&acc)?;
    crate::commands_xrp::broadcast_checked(&crate::commands_xrp::ctx(&state), &me, &blob).await
}

// ---------------------------------------------------------------- TRON

fn tron_address(acc: &WatchOnlyAccount) -> AppResult<String> {
    key_of(acc, Chain::Tron)
        .map(|k| k.address.clone())
        .ok_or_else(|| AppError::InvalidInput("no TRON key".into()))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

#[tauri::command]
pub async fn hw_tron_build_tx(
    state: State<'_, AppState>,
    account_id: String,
    to: String,
    amount: String,
    token: Option<String>,
) -> AppResult<TronBuilt> {
    let (acc, _) = account_for(&state, None, &account_id, Chain::Tron)?;
    let owner = tron_address(&acc)?;
    crate::commands_tron::build(
        &crate::commands_tron::ctx(&state),
        &owner,
        &to,
        &amount,
        token.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn hw_sign_tron_tx(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    account_id: String,
    raw: String,
) -> AppResult<TronSigned> {
    let (acc, info) = account_for(&state, Some(&id), &account_id, Chain::Tron)?;
    let info = info.ok_or(AppError::HwNotFound)?;
    let me = tron_address(&acc)?;
    let summary = wallet_core::tron_decode_raw(&raw, &me)?;
    crate::tron_backend::check_expiration(&summary, now_ms())?;
    let c = crate::commands_tron::ctx(&state);
    let estimate = crate::tron_backend::estimate_for(&c, &summary).await?;
    check_same_device(&app, &state, &id, &acc, Chain::Tron).await?;
    let lang = crate::i18n::current();
    let net = state.network;
    confirm_native(
        &app,
        title(lang, Chain::Tron),
        crate::commands_tron::describe_tron(lang, &summary, &estimate, net, now_ms())
            + &device_line(lang, &info),
    )
    .await?;
    if crate::commands_tron::tron_needs_extra(&summary, net) {
        confirm_native(
            &app,
            lang.check_tx_title(),
            crate::commands_tron::describe_tron_extra(lang, &summary, net),
        )
        .await?;
    }
    let bytes = hex::decode(raw.trim())
        .map_err(|_| AppError::InvalidInput("raw_data is not hexadecimal".into()))?;
    let account = acc.account;
    let sig = state
        .hw
        .run(&id, T_CONFIRM, prompt_fn(&app, &id), move |dev, ctl| {
            chains::sign_tron(dev, ctl, net, account, &bytes)
        })
        .await?;
    // Never trust the device: the signature must recover to this account's address.
    if wallet_core::tron_recover_signer(&raw, &sig)? != me {
        return Err(AppError::HwBadResponse(
            "the device's signature is not this account's".into(),
        ));
    }
    state.touch();
    Ok(TronSigned {
        signature: hex::encode(sig),
        txid: summary.txid.clone(),
        summary,
        estimate,
    })
}

#[tauri::command]
pub async fn hw_tron_broadcast(
    state: State<'_, AppState>,
    account_id: String,
    raw: String,
    signature: String,
) -> AppResult<String> {
    let (acc, _) = account_for(&state, None, &account_id, Chain::Tron)?;
    let owner = tron_address(&acc)?;
    crate::commands_tron::broadcast_checked(
        &crate::commands_tron::ctx(&state),
        &owner,
        &raw,
        &signature,
    )
    .await
}

// ---------------------------------------------------------------- Stellar

fn stellar_key(acc: &WatchOnlyAccount) -> AppResult<(String, [u8; 32])> {
    let k = key_of(acc, Chain::Stellar)
        .ok_or_else(|| AppError::InvalidInput("no Stellar key".into()))?;
    let pk: [u8; 32] = k
        .pubkey_bytes()?
        .try_into()
        .map_err(|_| AppError::InvalidInput("invalid Stellar key".into()))?;
    Ok((k.address.clone(), pk))
}

#[tauri::command]
pub async fn hw_stellar_build_tx(
    state: State<'_, AppState>,
    account_id: String,
    to: String,
    amount: String,
    memo: Option<MemoSpec>,
) -> AppResult<StellarBuilt> {
    let (acc, _) = account_for(&state, None, &account_id, Chain::Stellar)?;
    let (me, _) = stellar_key(&acc)?;
    crate::commands_stellar::build(
        &crate::commands_stellar::ctx(&state),
        &me,
        &to,
        &amount,
        memo.as_ref(),
    )
    .await
}

#[tauri::command]
pub async fn hw_sign_stellar_tx(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    account_id: String,
    envelope: String,
) -> AppResult<StellarSigned> {
    let (acc, info) = account_for(&state, Some(&id), &account_id, Chain::Stellar)?;
    let info = info.ok_or(AppError::HwNotFound)?;
    let (me, pk) = stellar_key(&acc)?;
    let c = crate::commands_stellar::ctx(&state);
    let (summary, context) = crate::commands_stellar::prepare_sign(&c, &me, &envelope).await?;
    check_same_device(&app, &state, &id, &acc, Chain::Stellar).await?;
    let lang = crate::i18n::current();
    confirm_native(
        &app,
        title(lang, Chain::Stellar),
        crate::commands_stellar::describe_stellar(lang, &summary, &context)
            + &device_line(lang, &info),
    )
    .await?;
    if summary.requires_extra_confirmation {
        confirm_native(
            &app,
            lang.check_tx_title(),
            crate::commands_stellar::describe_stellar_extra(lang, &summary),
        )
        .await?;
    }
    let (net, account) = (state.network, acc.account);
    let env = envelope.clone();
    let sig = state
        .hw
        .run(&id, T_CONFIRM, prompt_fn(&app, &id), move |dev, ctl| {
            chains::sign_stellar(dev, ctl, net, account, &env)
        })
        .await?;
    let (signed, hash) = wallet_core::stellar_hw_assemble(&envelope, net, &pk, &sig)?;
    state.touch();
    Ok(StellarSigned {
        envelope: signed,
        hash,
        summary,
        context,
    })
}

#[tauri::command]
pub async fn hw_stellar_broadcast(
    state: State<'_, AppState>,
    account_id: String,
    envelope: String,
) -> AppResult<String> {
    let (acc, _) = account_for(&state, None, &account_id, Chain::Stellar)?;
    let (me, _) = stellar_key(&acc)?;
    crate::commands_stellar::broadcast_checked(
        &crate::commands_stellar::ctx(&state),
        &me,
        &envelope,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands_hw::{parse_path, resolve_target, Target};
    use wallet_core::{HwDeviceKind, Mnemonic, Network};

    const ABANDON: &str =
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    #[test]
    fn verify_targets_of_other_chains_resolve_to_kyro_derivation() {
        let seed = Mnemonic::parse(ABANDON).unwrap().to_seed("");
        let net = Network::Mainnet;
        let pk = wallet_core::stellar_public_key(&seed, 0).unwrap();
        let acc = WatchOnlyAccount {
            id: "hw-00000000000000ab".into(),
            label: "t".into(),
            device: HwDeviceKind::Ledger,
            model: "Nano X".into(),
            network: net,
            account: 0,
            btc: vec![],
            evm: None,
            sol: None,
            utxo: vec![wallet_core::utxo_account(&seed, net, UtxoCoin::BitcoinCash, 0).unwrap()],
            xrp: None,
            tron: None,
            stellar: Some(WatchKey {
                address: wallet_core::stellar_address(&seed, 0).unwrap(),
                pubkey: hex::encode(pk),
                path: wallet_core::stellar_path(0),
            }),
            keys: Vec::new(),
            cardano: None,
            zec: None,
        };
        acc.validate().unwrap();
        let (t, expected) =
            resolve_target(&acc, Chain::Bch, &parse_path("m/44'/145'/0'/1/4").unwrap()).unwrap();
        assert!(matches!(t, Target::Other(chains::Target::Utxo { .. })));
        assert_eq!(
            expected,
            wallet_core::utxo_address(&seed, net, UtxoCoin::BitcoinCash, 0, true, 4).unwrap()
        );
        let (_, s) =
            resolve_target(&acc, Chain::Stellar, &parse_path("m/44'/148'/0'").unwrap()).unwrap();
        assert_eq!(s, wallet_core::stellar_address(&seed, 0).unwrap());
        for (chain, p) in [
            (Chain::Bch, "m/44'/145'/1'/0/0"),
            (Chain::Bch, "m/44'/145'/0'/2/0"),
            (Chain::Ltc, "m/84'/2'/0'/0/0"),
            (Chain::Stellar, "m/44'/148'/1'"),
            (Chain::Xrp, "m/44'/144'/0'/0/0"),
        ] {
            assert!(
                resolve_target(&acc, chain, &parse_path(p).unwrap()).is_err(),
                "{p}"
            );
        }
        assert_eq!(
            title(Lang::En, Chain::Dash),
            "Confirm the Dash transaction (hardware wallet)"
        );
        assert!(coin_of(Chain::Xrp).is_err());
        assert_eq!(coin_of(Chain::Doge).unwrap(), UtxoCoin::Dogecoin);
    }
}
