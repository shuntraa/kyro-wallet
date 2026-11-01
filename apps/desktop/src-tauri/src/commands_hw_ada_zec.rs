//! Hardware-wallet commands of Cardano (Ledger "Cardano ADA" app, Trezor Model T / Safe) and
//! Zcash transparent (Trezor), docs/IPC.md §2.3. Same rules as `commands_hw_coins.rs`: Rust
//! builds, decodes and re-checks what will be signed (the same live checks as the vault's
//! `ada_sign_tx` / `zec_sign`), the device's keys are compared with the stored account first
//! (`HW_WRONG_DEVICE`), Kyro's native dialog shows its own summary, the user confirms on the
//! device, and what the device returns is verified in `wallet-core` before anything is
//! returned:
//!
//! - Cardano: the body hash the device computed must be Kyro's transaction id, and the
//!   witness must verify over it with the payment key derived from the stored account key
//!   (`cardano_hw_assemble`); `hw_ada_broadcast` checks the witness again before `submittx`.
//! - Zcash: every signature must verify against Kyro's own ZIP-244 digest of its input and the
//!   key derived from the stored xpub (`zec_hw_finalize`); the signed transaction goes out with
//!   `zec_broadcast`.

use serde::Serialize;
use tauri::{AppHandle, State};
use wallet_core::{CardanoContext, Network, WatchOnlyAccount, ZecAccount, ZecTxSummary};

use crate::commands::confirm_native;
use crate::commands_cardano::{CardanoBuilt, CardanoSigned, TokenSpec};
use crate::commands_hw::{
    check_brand, device_line, guard, load_account, prompt_fn, T_CONFIRM, T_READ,
};
use crate::commands_zcash::ZecSendArgs;
use crate::error::{AppError, AppResult};
use crate::hw::{chains, Chain, DeviceInfo};
use crate::i18n::Lang;
use crate::state::AppState;

fn title(lang: Lang, chain: Chain) -> &'static str {
    match chain {
        Chain::Cardano => lang.pick(
            "Confirmer la transaction Cardano (hardware wallet)",
            "Confirm the Cardano transaction (hardware wallet)",
        ),
        _ => lang.pick(
            "Confirmer la transaction Zcash (hardware wallet)",
            "Confirm the Zcash transaction (hardware wallet)",
        ),
    }
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
    let has = match chain {
        Chain::Cardano => acc.cardano.is_some(),
        _ => acc.zec.is_some(),
    };
    if !has {
        return Err(AppError::InvalidInput(format!(
            "this hardware wallet account has no {} key",
            chain.label()
        )));
    }
    Ok((acc, info))
}

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

// ---------------------------------------------------------------- Cardano

/// Our base address and payment key `…/0/0`, from the stored account key.
fn ada_keys(acc: &WatchOnlyAccount) -> AppResult<(String, [u8; 32])> {
    let k = acc
        .cardano
        .as_ref()
        .ok_or_else(|| AppError::InvalidInput("no Cardano key".into()))?;
    Ok((
        k.address.clone(),
        wallet_core::cardano_xpub_child(&k.pubkey, 0, 0)?,
    ))
}

#[tauri::command]
pub async fn hw_ada_build_tx(
    state: State<'_, AppState>,
    account_id: String,
    to: String,
    lovelace: Option<String>,
    token: Option<TokenSpec>,
    memo: Option<String>,
) -> AppResult<CardanoBuilt> {
    let (acc, _) = account_for(&state, None, &account_id, Chain::Cardano)?;
    let (me, _) = ada_keys(&acc)?;
    crate::commands_cardano::build(
        &crate::commands_cardano::ctx(&state),
        &me,
        &to,
        lovelace.as_deref(),
        token.as_ref(),
        memo.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn hw_sign_ada_tx(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    account_id: String,
    tx: String,
) -> AppResult<CardanoSigned> {
    let (acc, info) = account_for(&state, Some(&id), &account_id, Chain::Cardano)?;
    let info = info.ok_or(AppError::HwNotFound)?;
    let (me, pk) = ada_keys(&acc)?;
    let net = state.network;
    let c = crate::commands_cardano::ctx(&state);
    // Same live checks as the vault: inputs ours and unspent, balance, fee, ttl.
    let (summary, context) = crate::commands_cardano::prepare_sign(&c, &me, &tx).await?;
    let own = [me.clone()];
    let verified = crate::cardano_backend::verified_tokens(net);
    let dctx = CardanoContext {
        net,
        own: &own,
        verified_tokens: &verified,
        coins_per_byte: context.params.coins_per_byte,
    };
    let me_b = wallet_core::cardano_address_bytes(&me, net)?;
    let plan = wallet_core::cardano_hw_plan(&tx, &dctx, &me_b)?;
    if plan.summary != summary {
        return Err(AppError::Internal(
            "summary differs between the preview and the signature".into(),
        ));
    }
    check_same_device(&app, &state, &id, &acc, Chain::Cardano).await?;
    let lang = crate::i18n::current();
    confirm_native(
        &app,
        title(lang, Chain::Cardano),
        crate::commands_cardano::describe_ada(lang, &summary, &context, net)
            + &device_line(lang, &info),
    )
    .await?;
    if summary.requires_extra_confirmation {
        confirm_native(
            &app,
            lang.check_tx_title(),
            crate::commands_cardano::describe_ada_extra(lang, &summary),
        )
        .await?;
    }
    let account = acc.account;
    let plan2 = plan.clone();
    let (hash, sig, device_pk) = state
        .hw
        .run(&id, T_CONFIRM, prompt_fn(&app, &id), move |dev, ctl| {
            chains::sign_cardano(dev, ctl, net, account, &plan2)
        })
        .await?;
    if device_pk.is_some_and(|k| k != pk) {
        return Err(AppError::HwBadResponse(
            "the device signed with a key other than this account's".into(),
        ));
    }
    let (signed, tx_id, again) = wallet_core::cardano_hw_assemble(&tx, &dctx, &pk, &hash, &sig)
        .map_err(|e| AppError::HwBadResponse(e.to_string()))?;
    if again != summary {
        return Err(AppError::Internal(
            "summary differs between the preview and the signature".into(),
        ));
    }
    state.touch();
    Ok(CardanoSigned {
        tx: signed,
        tx_id,
        summary,
        context,
    })
}

#[tauri::command]
pub async fn hw_ada_broadcast(
    state: State<'_, AppState>,
    account_id: String,
    tx: String,
) -> AppResult<String> {
    let (acc, _) = account_for(&state, None, &account_id, Chain::Cardano)?;
    let (_, pk) = ada_keys(&acc)?;
    crate::commands_cardano::broadcast_checked(&crate::commands_cardano::ctx(&state), &pk, &tx)
        .await
}

// ---------------------------------------------------------------- Zcash

fn zec_account(acc: &WatchOnlyAccount) -> AppResult<ZecAccount> {
    acc.zec
        .clone()
        .ok_or_else(|| AppError::InvalidInput("no Zcash account".into()))
}

/// What the device would be asked to sign (built from the stored xpub, as `hw_sign_zec_tx`).
#[tauri::command]
pub async fn hw_zec_send_preview(
    state: State<'_, AppState>,
    account_id: String,
    request: ZecSendArgs,
) -> AppResult<ZecTxSummary> {
    let (acc, _) = account_for(&state, None, &account_id, Chain::Zec)?;
    let z = zec_account(&acc)?;
    let req = crate::commands_zcash::request(&state, &request).await?;
    Ok(wallet_core::zec_hw_plan(&z, state.network, &req)?.summary)
}

#[derive(Serialize)]
pub struct HwZecSigned {
    hex: String,
    txid: String,
    summary: ZecTxSummary,
}

#[tauri::command]
pub async fn hw_sign_zec_tx(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    account_id: String,
    request: ZecSendArgs,
) -> AppResult<HwZecSigned> {
    let (acc, info) = account_for(&state, Some(&id), &account_id, Chain::Zec)?;
    let info = info.ok_or(AppError::HwNotFound)?;
    let z = zec_account(&acc)?;
    let net: Network = state.network;
    let req = crate::commands_zcash::request(&state, &request).await?;
    let plan = wallet_core::zec_hw_plan(&z, net, &req)?;
    let summary = plan.summary.clone();
    check_same_device(&app, &state, &id, &acc, Chain::Zec).await?;
    let lang = crate::i18n::current();
    confirm_native(
        &app,
        title(lang, Chain::Zec),
        crate::commands_zcash::describe_zec(lang, &summary, net) + &device_line(lang, &info),
    )
    .await?;
    if summary.requires_extra_confirmation {
        confirm_native(
            &app,
            lang.check_tx_title(),
            crate::commands_zcash::describe_zec_extra(lang, &summary),
        )
        .await?;
    }
    let sigs = state
        .hw
        .run(&id, T_CONFIRM, prompt_fn(&app, &id), move |dev, ctl| {
            chains::sign_zec(dev, ctl, net, &plan)
        })
        .await?;
    let (hex, again) = wallet_core::zec_hw_finalize(&z, net, &req, &sigs)
        .map_err(|e| AppError::HwBadResponse(e.to_string()))?;
    if again != summary {
        return Err(AppError::Internal(
            "summary differs between the preview and the signature".into(),
        ));
    }
    state.touch();
    Ok(HwZecSigned {
        txid: summary.txid.clone(),
        hex,
        summary,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands_hw::{parse_path, resolve_target, Target};
    use wallet_core::{HwDeviceKind, Mnemonic, WatchKey};

    const ABANDON: &str =
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    /// Verify-on-device targets of Cardano and Zcash resolve to the address Kyro derives from
    /// the stored keys; any other path is refused.
    #[test]
    fn verify_targets_resolve_to_stored_keys() {
        let m = Mnemonic::parse(ABANDON).unwrap();
        let seed = m.to_seed("");
        let root = wallet_core::CardanoRoot::from_mnemonic(&m, "");
        let net = Network::Mainnet;
        let xpub = wallet_core::cardano_account_xpub(&root, 0).unwrap();
        let acc = WatchOnlyAccount {
            id: "hw-00000000000000ef".into(),
            label: "t".into(),
            device: HwDeviceKind::Trezor,
            model: "Safe 3".into(),
            network: net,
            account: 0,
            btc: vec![],
            evm: None,
            sol: None,
            utxo: vec![],
            xrp: None,
            tron: None,
            stellar: None,
            cardano: Some(WatchKey {
                address: wallet_core::cardano_address(&root, net, 0, 0).unwrap(),
                pubkey: xpub,
                path: wallet_core::cardano_account_path(0),
            }),
            zec: Some(wallet_core::zec_account(&seed, net, 0).unwrap()),
            keys: Vec::new(),
        };
        acc.validate().unwrap();
        let (t, a) = resolve_target(
            &acc,
            Chain::Cardano,
            &parse_path("m/1852'/1815'/0'/0/0").unwrap(),
        )
        .unwrap();
        assert_eq!(t, Target::Other(chains::Target::Cardano));
        assert_eq!(a, wallet_core::cardano_address(&root, net, 0, 0).unwrap());
        let (t, a) =
            resolve_target(&acc, Chain::Zec, &parse_path("m/44'/133'/0'/1/7").unwrap()).unwrap();
        assert!(matches!(t, Target::Other(chains::Target::Zec { .. })));
        assert_eq!(a, wallet_core::zec_address(&seed, net, 0, true, 7).unwrap());
        for (chain, p) in [
            (Chain::Cardano, "m/1852'/1815'/0'/0/1"),
            (Chain::Cardano, "m/1852'/1815'/1'/0/0"),
            (Chain::Zec, "m/44'/133'/1'/0/0"),
            (Chain::Zec, "m/44'/133'/0'/2/0"),
        ] {
            assert!(
                resolve_target(&acc, chain, &parse_path(p).unwrap()).is_err(),
                "{p}"
            );
        }
        let (me, pk) = ada_keys(&acc).unwrap();
        assert_eq!(me, wallet_core::cardano_address(&root, net, 0, 0).unwrap());
        assert_eq!(
            pk,
            wallet_core::cardano_payment_public_key(&root, 0, 0).unwrap()
        );
        assert_eq!(
            title(Lang::En, Chain::Zec),
            "Confirm the Zcash transaction (hardware wallet)"
        );
    }
}
