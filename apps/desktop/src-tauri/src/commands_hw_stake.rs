//! Staking from hardware accounts (docs/IPC.md §2.8): same build, decoding and live checks as the
//! vault's `*_stake_*` commands, with the key on the device. Each signature follows the `hw_*`
//! send paths: the device key is re-read (`HW_WRONG_DEVICE`), Rust decodes, the native window
//! shows it, the device shows it again and signs, Rust verifies the signature.
//!
//! Only what the device shows decoded gets here. Solana: the four Kyro messages are in the
//! closed list of `stake_sol::classify`, and both firmwares parse them (Ledger app `libsol`
//! briefs, Trezor `programs.json`). Cardano: certificates are always shown; a withdrawal is not
//! on every device, so `ada_hidden` refuses those transactions (`HW_UNSUPPORTED`). NEAR (Ledger):
//! the app shows a pool `FunctionCall` (method, arguments, deposit); the account is the implicit
//! one of the Ledger key, not the vault's. TRON and the other staking chains have no command here.

use base64::Engine as _;
use tauri::{AppHandle, State};
use wallet_core::{CardanoContext, CardanoHwPlan, HwDeviceKind, HwKeyChain, WatchOnlyAccount};

use crate::commands::confirm_native;
use crate::commands_cardano::ctx as ada_ctx;
use crate::commands_hw::{
    check_brand, device_line, guard, load_account, prompt_fn, same_device, T_CONFIRM, T_READ,
};
use crate::commands_hw_ada_zec::check_same_device;
use crate::commands_hw_keys::{check_device, device_sign, key_array, stored_key};
use crate::commands_near::ctx as near_ctx;
use crate::error::{AppError, AppResult};
use crate::hw::Chain;
use crate::near_backend::NearTxOutcome;
use crate::solana;
use crate::stake_ada::{
    self, AdaStakeBuilt, AdaStakeKeys, AdaStakeOverview, AdaStakeRequest, AdaStakeSigned,
};
use crate::stake_near::{
    self, NearStakeBuilt, NearStakeOverview, NearStakeRequest, NearStakeSigned,
};
use crate::stake_sol::{self, SolStakeBuilt, SolStakeOverview, SolStakeRequest, SolStakeSigned};
use crate::state::AppState;

fn sol_account(state: &AppState, account_id: &str) -> AppResult<(WatchOnlyAccount, String)> {
    guard(state)?;
    let acc = load_account(state, account_id)?;
    let me = acc
        .sol
        .as_ref()
        .map(|s| s.address.clone())
        .ok_or_else(|| AppError::InvalidInput("this account has no Solana key".into()))?;
    Ok((acc, me))
}

#[tauri::command]
pub async fn hw_sol_stake_overview(
    state: State<'_, AppState>,
    account_id: String,
) -> AppResult<SolStakeOverview> {
    let (_, me) = sol_account(&state, &account_id)?;
    stake_sol::overview(&state, &me).await
}

#[tauri::command]
pub async fn hw_sol_stake_build(
    state: State<'_, AppState>,
    account_id: String,
    action: SolStakeRequest,
) -> AppResult<SolStakeBuilt> {
    let (_, me) = sol_account(&state, &account_id)?;
    stake_sol::build(&state, &me, &action).await
}

#[tauri::command]
pub async fn hw_sol_stake_sign(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    account_id: String,
    message: String,
) -> AppResult<SolStakeSigned> {
    let (acc, me) = sol_account(&state, &account_id)?;
    let info = state.hw.info(&id)?;
    check_brand(&info, &acc)?;
    let bytes = solana::message_bytes(&message)?;
    let (summary, stake) = stake_sol::prepare_sign(&state, &me, &bytes).await?;
    let acc2 = acc.clone();
    let same = state
        .hw
        .run(&id, T_READ, prompt_fn(&app, &id), move |dev, ctl| {
            same_device(dev, ctl, &acc2, Chain::Sol, &[])
        })
        .await?;
    if !same {
        return Err(AppError::HwWrongDevice);
    }
    let lang = crate::i18n::current();
    confirm_native(
        &app,
        lang.pick(
            "Confirmer l'opération de staking Solana (hardware wallet)",
            "Confirm the Solana staking operation (hardware wallet)",
        ),
        stake_sol::describe(lang, &stake, state.network) + &device_line(lang, &info),
    )
    .await?;
    if stake.requires_extra_confirmation {
        confirm_native(
            &app,
            lang.pick(
                "Attention : validateur à vérifier",
                "Warning: validator to check",
            ),
            stake_sol::describe_extra(lang, &stake),
        )
        .await?;
    }
    let account = acc.account;
    let msg = bytes.clone();
    let sig = state
        .hw
        .run(&id, T_CONFIRM, prompt_fn(&app, &id), move |dev, ctl| {
            dev.sol_sign(ctl, account, &msg)
        })
        .await?;
    let sig = wallet_core::sol_verify_signature(&me, &bytes, &sig)
        .map_err(|e| AppError::HwBadResponse(e.to_string()))?;
    state.touch();
    Ok(SolStakeSigned {
        signature: base64::engine::general_purpose::STANDARD.encode(sig),
        summary,
        stake,
    })
}

#[tauri::command]
pub async fn hw_sol_stake_broadcast(
    state: State<'_, AppState>,
    account_id: String,
    message: String,
    signature: String,
) -> AppResult<String> {
    let (_, me) = sol_account(&state, &account_id)?;
    let bytes = solana::message_bytes(&message)?;
    let sig = base64::engine::general_purpose::STANDARD
        .decode(signature.trim())
        .map_err(|_| AppError::InvalidInput("signature: base64 expected".into()))?;
    stake_sol::broadcast(&state, &me, &bytes, &sig).await
}

fn ada_account(state: &AppState, account_id: &str) -> AppResult<(WatchOnlyAccount, AdaStakeKeys)> {
    guard(state)?;
    let acc = load_account(state, account_id)?;
    let k = acc
        .cardano
        .as_ref()
        .ok_or_else(|| AppError::InvalidInput("this account has no Cardano key".into()))?;
    let keys = AdaStakeKeys {
        address: k.address.clone(),
        account: acc.account,
        payment_pk: wallet_core::cardano_xpub_child(&k.pubkey, 0, 0)?,
        stake_pk: wallet_core::cardano_xpub_child(&k.pubkey, 2, 0)?,
        stake_account: acc.account,
    };
    Ok((acc, keys))
}

/// A transaction the device would sign without showing all of it: on a Ledger any withdrawal
/// (hidden outside expert mode, which the host cannot read), on a Trezor a withdrawal next to a
/// certificate (behind a "show details" choice). A withdrawal alone is shown by a Trezor.
fn ada_hidden(device: HwDeviceKind, plan: &CardanoHwPlan) -> Option<&'static str> {
    if plan.staking.withdrawals.is_empty() {
        return None;
    }
    match device {
        HwDeviceKind::Ledger => Some(
            "Cardano rewards withdrawal: the Ledger app does not show it outside expert mode, \
             Kyro does not sign it (withdraw from another wallet)",
        ),
        HwDeviceKind::Trezor if !plan.staking.certs.is_empty() => Some(
            "Cardano: the Trezor may not show a withdrawal next to a certificate: withdraw your \
             rewards first, then deregister",
        ),
        HwDeviceKind::Trezor => None,
    }
}

fn ada_plan(
    state: &AppState,
    device: HwDeviceKind,
    keys: &AdaStakeKeys,
    tx: &str,
    coins_per_byte: u64,
    key_deposit: u64,
) -> AppResult<CardanoHwPlan> {
    let net = state.network;
    let own = [keys.address.clone()];
    let dctx = ada_decode_ctx(net, &own, coins_per_byte);
    let me = wallet_core::cardano_address_bytes(&keys.address, net)?;
    let plan = wallet_core::cardano_hw_stake_plan(tx, &dctx, &me, &keys.stake_pk, key_deposit)?;
    if let Some(what) = ada_hidden(device, &plan) {
        return Err(AppError::HwUnsupported {
            what: what.into(),
            min: None,
        });
    }
    Ok(plan)
}

fn ada_decode_ctx<'a>(
    net: wallet_core::Network,
    own: &'a [String],
    coins_per_byte: u64,
) -> CardanoContext<'a> {
    CardanoContext {
        net,
        own,
        verified_tokens: &[],
        coins_per_byte,
    }
}

#[tauri::command]
pub async fn hw_ada_stake_overview(
    state: State<'_, AppState>,
    account_id: String,
) -> AppResult<AdaStakeOverview> {
    let (_, keys) = ada_account(&state, &account_id)?;
    stake_ada::overview(&ada_ctx(&state), &keys).await
}

#[tauri::command]
pub async fn hw_ada_stake_build(
    state: State<'_, AppState>,
    account_id: String,
    action: AdaStakeRequest,
) -> AppResult<AdaStakeBuilt> {
    let (acc, keys) = ada_account(&state, &account_id)?;
    let built = stake_ada::build(&ada_ctx(&state), &keys, &action).await?;
    let kd = built.context.key_deposit.parse().unwrap_or(0);
    let cpb = built.context.params.coins_per_byte;
    ada_plan(&state, acc.device, &keys, &built.tx, cpb, kd)?;
    Ok(built)
}

#[tauri::command]
pub async fn hw_ada_stake_sign(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    account_id: String,
    tx: String,
) -> AppResult<AdaStakeSigned> {
    let (acc, keys) = ada_account(&state, &account_id)?;
    let info = state.hw.info(&id)?;
    check_brand(&info, &acc)?;
    let net = state.network;
    let c = ada_ctx(&state);
    let (summary, context) = stake_ada::prepare_sign(&c, &keys, &tx).await?;
    let kd: u64 = context.key_deposit.parse().unwrap_or(0);
    let cpb = context.params.coins_per_byte;
    let plan = ada_plan(&state, acc.device, &keys, &tx, cpb, kd)?;
    check_same_device(&app, &state, &id, &acc, Chain::Cardano).await?;
    let lang = crate::i18n::current();
    confirm_native(
        &app,
        lang.pick(
            "Confirmer l'opération de staking Cardano (hardware wallet)",
            "Confirm the Cardano staking operation (hardware wallet)",
        ),
        stake_ada::describe(lang, &summary, &context, net) + &device_line(lang, &info),
    )
    .await?;
    if context.requires_extra_confirmation {
        confirm_native(
            &app,
            lang.pick(
                "Attention : pool ou DRep à vérifier",
                "Warning: pool or DRep to check",
            ),
            stake_ada::describe_extra(lang, &context),
        )
        .await?;
    }
    let account = acc.account;
    let (hash, pay_sig, stake_sig) = state
        .hw
        .run(&id, T_CONFIRM, prompt_fn(&app, &id), move |dev, ctl| {
            crate::hw::chains::sign_cardano_stake(dev, ctl, net, account, &plan)
        })
        .await?;
    let own = [keys.address.clone()];
    let dctx = ada_decode_ctx(net, &own, cpb);
    let (signed, tx_id, again) = wallet_core::cardano_hw_stake_assemble(
        &tx,
        &dctx,
        &keys.payment_pk,
        &keys.stake_pk,
        kd,
        &hash,
        &pay_sig,
        &stake_sig,
    )
    .map_err(|e| AppError::HwBadResponse(e.to_string()))?;
    if again != summary {
        return Err(AppError::Internal(
            "summary differs between the preview and the signature".into(),
        ));
    }
    state.touch();
    Ok(AdaStakeSigned {
        tx: signed,
        tx_id,
        summary,
        context,
    })
}

#[tauri::command]
pub async fn hw_ada_stake_broadcast(
    state: State<'_, AppState>,
    account_id: String,
    tx: String,
) -> AppResult<String> {
    let (_, keys) = ada_account(&state, &account_id)?;
    stake_ada::broadcast_checked(&ada_ctx(&state), &keys, &tx).await
}

const NEAR: HwKeyChain = HwKeyChain::Near;

#[tauri::command]
pub async fn hw_near_stake_overview(
    state: State<'_, AppState>,
    account_id: String,
) -> AppResult<NearStakeOverview> {
    let (_, key) = stored_key(&state, &account_id, NEAR)?;
    stake_near::overview(&near_ctx(&state), &key.address).await
}

#[tauri::command]
pub async fn hw_near_stake_build(
    state: State<'_, AppState>,
    account_id: String,
    action: NearStakeRequest,
) -> AppResult<NearStakeBuilt> {
    let (_, key) = stored_key(&state, &account_id, NEAR)?;
    stake_near::build(&near_ctx(&state), &key.address, &key_array(&key)?, &action).await
}

#[tauri::command]
pub async fn hw_near_stake_sign(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    account_id: String,
    tx: String,
) -> AppResult<NearStakeSigned> {
    let (acc, key) = stored_key(&state, &account_id, NEAR)?;
    let pk = key_array::<32>(&key)?;
    let info = check_device(&app, &state, &id, &acc, &key).await?;
    let c = near_ctx(&state);
    let (summary, context) = stake_near::prepare_sign(&c, &key.address, &pk, &tx).await?;
    let lang = crate::i18n::current();
    confirm_native(
        &app,
        lang.pick(
            "Confirmer l'opération de staking NEAR (hardware wallet)",
            "Confirm the NEAR staking operation (hardware wallet)",
        ),
        stake_near::describe(lang, &summary, &context, state.network) + &device_line(lang, &info),
    )
    .await?;
    if context.requires_extra_confirmation {
        confirm_native(
            &app,
            lang.pick("Attention : pool à vérifier", "Warning: pool to check"),
            stake_near::describe_extra(lang, &context),
        )
        .await?;
    }
    let message = wallet_core::near_stake_hw_message(&tx, &key.address, &pk)?;
    let sig = device_sign(&app, &state, &id, &acc, NEAR, message).await?;
    let (signed, hash) = wallet_core::near_stake_hw_signed(&tx, &sig)
        .map_err(|e| AppError::HwBadResponse(e.to_string()))?;
    state.touch();
    Ok(NearStakeSigned {
        signed,
        hash,
        summary,
        context,
    })
}

#[tauri::command]
pub async fn hw_near_stake_broadcast(
    state: State<'_, AppState>,
    account_id: String,
    signed: String,
) -> AppResult<NearTxOutcome> {
    let (_, key) = stored_key(&state, &account_id, NEAR)?;
    stake_near::broadcast_checked(&near_ctx(&state), &key.address, &signed).await
}

#[cfg(test)]
mod tests {
    use super::ada_hidden;
    use crate::hw::ledger::Ledger;
    use crate::hw::ledger_apdu as apdu;
    use crate::hw::ledger_apps::replay::*;
    use crate::hw::{sol_path, HardwareWallet};
    use crate::stake_sol::classify;
    use protobuf::Message;
    use trezor_client::protos;
    use wallet_core::{
        CardanoCert, CardanoHwPlan, CardanoHwStaking, CardanoTxSummary, HwDeviceKind, Mnemonic,
        SolStakeOp,
    };

    const ABANDON: &str =
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    const VOTE: &str = "CertusDeBmqN8ZawdkxK5kFGMwBXdudvWHYwtNgNhvLu";
    const BLOCKHASH: &str = "GfVcyD4kkTrj4bKc7WA9sZCin9JDbdT4Zkd3EittNR1W";

    fn ops(stake: &str) -> Vec<SolStakeOp> {
        vec![
            SolStakeOp::CreateAndDelegate {
                seed: "kyro-stake-1".into(),
                lamports: 1_002_282_880,
                vote_account: VOTE.into(),
            },
            SolStakeOp::Delegate {
                stake_account: stake.into(),
                vote_account: VOTE.into(),
            },
            SolStakeOp::Deactivate {
                stake_account: stake.into(),
            },
            SolStakeOp::Withdraw {
                stake_account: stake.into(),
                lamports: 5_000,
            },
        ]
    }

    /// `(program, first data word)` of each instruction, read from the raw legacy message.
    fn shape(m: &[u8]) -> Vec<(String, u32)> {
        let n_keys = m[3] as usize;
        let key = |i: usize| bitcoin::base58::encode(&m[4 + 32 * i..36 + 32 * i]);
        let mut at = 4 + 32 * n_keys + 32;
        let n = m[at] as usize;
        at += 1;
        let mut out = Vec::new();
        for _ in 0..n {
            let program = key(m[at] as usize);
            let accounts = m[at + 1] as usize;
            at += 2 + accounts;
            let (mut len, mut shift) = (0usize, 0);
            loop {
                let b = m[at];
                at += 1;
                len |= ((b & 0x7f) as usize) << shift;
                shift += 7;
                if b & 0x80 == 0 {
                    break;
                }
            }
            let word = u32::from_le_bytes(m[at..at + 4].try_into().unwrap());
            at += len;
            out.push((program, word));
        }
        out
    }

    /// The Ledger app decodes a stake message only through a `libsol/transaction_printers.c`
    /// brief (else "Unrecognized format" and a hash, or a refusal): each Kyro message must stay
    /// on one. Trezor `common/defs/solana/programs.json` lists the same instruction ids.
    #[test]
    fn every_operation_matches_a_device_brief() {
        const SYSTEM: &str = "11111111111111111111111111111111";
        const STAKE: &str = wallet_core::SOL_STAKE_PROGRAM;
        let seed = Mnemonic::parse(ABANDON).unwrap().to_seed("");
        let me = wallet_core::sol_address(&seed, 0).unwrap();
        let stake = wallet_core::sol_create_with_seed(&me, "kyro-stake-1", STAKE).unwrap();
        let want: [&[(&str, u32)]; 4] = [
            // CreateAccountWithSeed, Initialize, DelegateStake
            &[(SYSTEM, 3), (STAKE, 0), (STAKE, 2)],
            &[(STAKE, 2)],
            &[(STAKE, 5)],
            &[(STAKE, 4)],
        ];
        for (op, want) in ops(&stake).iter().zip(want) {
            let m = wallet_core::sol_stake_message(&me, op, BLOCKHASH).unwrap();
            let want: Vec<_> = want.iter().map(|(p, w)| ((*p).to_owned(), *w)).collect();
            assert_eq!(shape(&m), want, "{op:?}");
            let summary = wallet_core::sol_decode_message(&m, &[], &me).unwrap();
            assert_eq!(&classify(&summary, &me).unwrap(), op);
        }
    }

    fn ada_plan_with(certs: Vec<CardanoCert>, withdrawals: Vec<u64>) -> CardanoHwPlan {
        CardanoHwPlan {
            inputs: vec![],
            outputs: vec![],
            fee: 0,
            ttl: None,
            aux_hash: None,
            validity_start: None,
            tagged_sets: true,
            staking: CardanoHwStaking { certs, withdrawals },
            tx_id: [0; 32],
            summary: CardanoTxSummary {
                tx_id: String::new(),
                inputs: vec![],
                outputs: vec![],
                fee: "0".into(),
                ttl: None,
                valid_from: None,
                memo: None,
                warnings: vec![],
                requires_extra_confirmation: false,
            },
        }
    }

    /// A device must show all of what it signs: certificates are always prompted, a withdrawal
    /// only by a Trezor and only alone.
    #[test]
    fn cardano_hidden_withdrawals_are_refused() {
        let dereg = CardanoCert::StakeDeregistration {
            stake: [7; 28],
            refund: 2_000_000,
        };
        let (l, t) = (HwDeviceKind::Ledger, HwDeviceKind::Trezor);
        let certs = ada_plan_with(vec![dereg.clone()], vec![]);
        assert_eq!(ada_hidden(l, &certs), None);
        assert_eq!(ada_hidden(t, &certs), None);
        let alone = ada_plan_with(vec![], vec![5]);
        assert!(ada_hidden(l, &alone).is_some_and(|m| m.contains("expert mode")));
        assert_eq!(ada_hidden(t, &alone), None);
        let both = ada_plan_with(vec![dereg], vec![5]);
        assert!(ada_hidden(l, &both).is_some());
        assert!(ada_hidden(t, &both).is_some_and(|m| m.contains("first")));
    }

    /// The Ledger key's implicit account signs each pool call: scripted exchange through the
    /// NEAR app's chunking, signature of that key (not the vault's), Kyro's check.
    #[test]
    fn near_pool_calls_through_the_ledger() {
        use crate::hw::ledger_apps::App;
        use crate::hw::ledger_near as near;
        use ed25519_dalek::{Signer, SigningKey};
        use wallet_core::{HwKeyChain, NearStakeCall, NearStakeTx};
        let device = SigningKey::from_bytes(&[0x42; 32]);
        let pk = device.verifying_key().to_bytes();
        let me = hex::encode(pk);
        let path = HwKeyChain::Near.path(0);
        for call in [
            NearStakeCall::DepositAndStake(1_000_000_000_000_000_000_000_000),
            NearStakeCall::Unstake(5),
            NearStakeCall::UnstakeAll,
            NearStakeCall::WithdrawAll,
        ] {
            let tx = NearStakeTx {
                signer_id: me.clone(),
                public_key: pk,
                nonce: 7,
                pool_id: "epic.poolv1.near".into(),
                block_hash: [3; 32],
                call,
            };
            let tx_hex = hex::encode(tx.encode());
            let msg = wallet_core::near_stake_hw_message(&tx_hex, &me, &pk).unwrap();
            assert_eq!(hex::encode(&msg), tx_hex);
            assert!(wallet_core::near_stake_hw_message(&tx_hex, "vault.near", &pk).is_err());
            assert!(wallet_core::near_stake_hw_message(&tx_hex, &me, &[9; 32]).is_err());

            let sig = device.sign(&tx.hash()).to_bytes();
            let mut lines = app("NEAR", "2.5.0").to_vec();
            lines.push("=> 8006000000".into());
            lines.push("<= 0205009000".into());
            let apdus = near::sign_apdus(&path, &msg).unwrap();
            for (i, a) in apdus.iter().enumerate() {
                lines.push(format!("=> {}", hex::encode(a)));
                lines.push(if i + 1 == apdus.len() {
                    format!("<= {}9000", hex::encode(sig))
                } else {
                    "<= 9000".into()
                });
            }
            let r = Replay::new(&lines);
            let c = ctl();
            let a = App::open(&r, &c, HwKeyChain::Near).unwrap();
            let got = near::sign(&a, &path, &msg).unwrap();
            assert!(r.done());
            let (signed, hash) = wallet_core::near_stake_hw_signed(&tx_hex, &got).unwrap();
            let (back, again) = wallet_core::near_stake_verify_signed(&signed).unwrap();
            assert_eq!((back.signer_id.as_str(), again), (me.as_str(), hash));
            assert!(wallet_core::near_stake_hw_signed(&tx_hex, &[1; 64]).is_err());
        }
    }

    /// Scripted Ledger exchange and Trezor request for each message; the "device" signature is
    /// the abandon seed's, as the app would produce it, and must pass Kyro's check.
    #[test]
    fn device_exchange_of_each_operation() {
        let seed = Mnemonic::parse(ABANDON).unwrap().to_seed("");
        let me = wallet_core::sol_address(&seed, 0).unwrap();
        let stake =
            wallet_core::sol_create_with_seed(&me, "kyro-stake-1", wallet_core::SOL_STAKE_PROGRAM)
                .unwrap();
        for op in ops(&stake) {
            let m = wallet_core::sol_stake_message(&me, &op, BLOCKHASH).unwrap();
            let sig = wallet_core::sol_sign_message(&seed, 0, &m).unwrap();
            let apdus = apdu::sol_sign(&sol_path(0), &m).unwrap();
            let mut lines = app("Solana", "1.16.0").to_vec();
            for (i, a) in apdus.iter().enumerate() {
                lines.push(format!("=> {}", hex::encode(a)));
                lines.push(if i + 1 == apdus.len() {
                    format!("<= {}9000", hex::encode(sig))
                } else {
                    "<= 9000".into()
                });
            }
            let mut ledger = Ledger::with_link(Replay::new(&lines));
            let got = ledger.sol_sign(&ctl(), 0, &m).unwrap();
            wallet_core::sol_verify_signature(&me, &m, &got).unwrap();
            assert!(wallet_core::sol_verify_signature(&stake, &m, &got).is_err());

            let req = crate::hw::trezor::sol_sign_request(0, &m, &[]);
            let wire = req.write_to_bytes().unwrap();
            let back = protos::SolanaSignTx::parse_from_bytes(&wire).unwrap();
            assert_eq!(back.address_n, sol_path(0).to_vec());
            assert_eq!(back.serialized_tx(), m.as_slice());
            assert!(back.additional_info.is_none());
        }
    }
}
