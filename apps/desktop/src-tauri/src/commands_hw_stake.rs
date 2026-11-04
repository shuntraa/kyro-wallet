//! Staking from hardware accounts (docs/IPC.md §2.8): same build, decoding and live checks as the
//! vault's `*_stake_*` commands, with the key on the device. Each signature follows the `hw_*`
//! send paths: the device key is re-read (`HW_WRONG_DEVICE`), Rust decodes, the native window
//! shows it, the device shows it again and signs, Rust verifies the signature.
//!
//! Only what the device shows decoded gets here. Solana: the four Kyro messages are in the
//! closed list of `stake_sol::classify`, and both firmwares parse them (Ledger app `libsol`
//! briefs, Trezor `programs.json`). TRON and the other staking chains have no command here.

use base64::Engine as _;
use tauri::{AppHandle, State};
use wallet_core::WatchOnlyAccount;

use crate::commands::confirm_native;
use crate::commands_hw::{
    check_brand, device_line, guard, load_account, prompt_fn, same_device, T_CONFIRM, T_READ,
};
use crate::error::{AppError, AppResult};
use crate::hw::Chain;
use crate::solana;
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

#[cfg(test)]
mod tests {
    use crate::hw::ledger::Ledger;
    use crate::hw::ledger_apdu as apdu;
    use crate::hw::ledger_apps::replay::*;
    use crate::hw::{sol_path, HardwareWallet};
    use crate::stake_sol::classify;
    use protobuf::Message;
    use trezor_client::protos;
    use wallet_core::{Mnemonic, SolStakeOp};

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
