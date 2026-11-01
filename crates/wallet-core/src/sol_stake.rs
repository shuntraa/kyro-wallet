//! Solana native staking: Kyro-built messages, stake account/history parsing, activation math.

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::sol_decode::{
    create_with_seed, MAX_SEED_LEN, STAKE_CONFIG, STAKE_PROGRAM, STAKE_STATE_SIZE, SYSVAR_CLOCK,
    SYSVAR_RENT, SYSVAR_STAKE_HISTORY,
};

/// Stake program id.
pub const SOL_STAKE_PROGRAM: &str = STAKE_PROGRAM;
/// Size of a stake account (`StakeStateV2`).
pub const SOL_STAKE_ACCOUNT_SIZE: u64 = STAKE_STATE_SIZE;
/// Stake-history sysvar address (read to compute activation).
pub const SOL_STAKE_HISTORY_SYSVAR: &str = SYSVAR_STAKE_HISTORY;
const WARMUP_COOLDOWN_RATE: f64 = 0.09;
const SYSTEM_PROGRAM: &str = "11111111111111111111111111111111";

fn key(s: &str) -> Result<[u8; 32]> {
    bs58::decode(s.trim())
        .into_vec()
        .ok()
        .and_then(|v| v.try_into().ok())
        .ok_or_else(|| Error::input(format!("invalid Solana address: {s}")))
}

fn b58(k: &[u8; 32]) -> String {
    bs58::encode(k).into_string()
}

/// `Pubkey::create_with_seed(base, seed, owner)` (base58 in, base58 out).
pub fn sol_create_with_seed(base: &str, seed: &str, owner: &str) -> Result<String> {
    Ok(b58(&create_with_seed(&key(base)?, seed, &key(owner)?)?))
}

/// A staking operation Kyro builds. Amounts in lamports.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SolStakeOp {
    /// New stake account at `create_with_seed(us, seed, Stake)`, us as authorities, delegated.
    CreateAndDelegate {
        /// Seed (≤ 32 bytes, ASCII).
        seed: String,
        /// Lamports moved into the new account (delegated amount + rent-exempt reserve).
        lamports: u64,
        /// Validator vote account.
        vote_account: String,
    },
    /// Delegates an existing (initialised or fully deactivated) stake account.
    Delegate {
        /// Stake account.
        stake_account: String,
        /// Validator vote account.
        vote_account: String,
    },
    /// Starts the cool-down.
    Deactivate {
        /// Stake account.
        stake_account: String,
    },
    /// Withdraws `lamports` to our own address (the whole balance closes the account).
    Withdraw {
        /// Stake account.
        stake_account: String,
        /// Lamports.
        lamports: u64,
    },
}

struct Ix {
    program: [u8; 32],
    /// `(key, writable)`; `is_signer` is implied by `key == payer`.
    accounts: Vec<([u8; 32], bool)>,
    data: Vec<u8>,
}

fn compact_u16(n: usize, out: &mut Vec<u8>) -> Result<()> {
    if n > 0xffff {
        return Err(Error::input("Solana message too large"));
    }
    let mut n = n;
    loop {
        let mut b = (n & 0x7f) as u8;
        n >>= 7;
        if n != 0 {
            b |= 0x80;
        }
        out.push(b);
        if n == 0 {
            return Ok(());
        }
    }
}

fn legacy_message(payer: &[u8; 32], blockhash: &[u8; 32], ixs: &[Ix]) -> Result<Vec<u8>> {
    let mut writable: Vec<[u8; 32]> = Vec::new();
    let mut readonly: Vec<[u8; 32]> = Vec::new();
    for ix in ixs {
        for (k, w) in &ix.accounts {
            if k == payer {
                continue;
            }
            if *w {
                if !writable.contains(k) {
                    writable.push(*k);
                }
                readonly.retain(|x| x != k);
            } else if !writable.contains(k) && !readonly.contains(k) {
                readonly.push(*k);
            }
        }
        if !writable.contains(&ix.program) && !readonly.contains(&ix.program) {
            readonly.push(ix.program);
        }
    }
    let mut keys = vec![*payer];
    keys.extend_from_slice(&writable);
    keys.extend_from_slice(&readonly);
    let ro = u8::try_from(readonly.len()).map_err(|_| Error::input("too many accounts"))?;
    let mut m = vec![1, 0, ro];
    compact_u16(keys.len(), &mut m)?;
    for k in &keys {
        m.extend_from_slice(k);
    }
    m.extend_from_slice(blockhash);
    compact_u16(ixs.len(), &mut m)?;
    let idx = |k: &[u8; 32]| -> Result<u8> {
        keys.iter()
            .position(|x| x == k)
            .and_then(|p| u8::try_from(p).ok())
            .ok_or_else(|| Error::input("account missing from the message"))
    };
    for ix in ixs {
        m.push(idx(&ix.program)?);
        compact_u16(ix.accounts.len(), &mut m)?;
        for (k, _) in &ix.accounts {
            m.push(idx(k)?);
        }
        compact_u16(ix.data.len(), &mut m)?;
        m.extend_from_slice(&ix.data);
    }
    Ok(m)
}

fn delegate_ix(stake: [u8; 32], vote: [u8; 32], me: [u8; 32]) -> Result<Ix> {
    Ok(Ix {
        program: key(STAKE_PROGRAM)?,
        accounts: vec![
            (stake, true),
            (vote, false),
            (key(SYSVAR_CLOCK)?, false),
            (key(SYSVAR_STAKE_HISTORY)?, false),
            (key(STAKE_CONFIG)?, false),
            (me, false),
        ],
        data: 2u32.to_le_bytes().to_vec(),
    })
}

/// The unsigned legacy message of `op` for our address `me`, on `blockhash` (base58).
pub fn sol_stake_message(me: &str, op: &SolStakeOp, blockhash: &str) -> Result<Vec<u8>> {
    let me_k = key(me)?;
    let bh = key(blockhash)?;
    let stake_program = key(STAKE_PROGRAM)?;
    let ixs = match op {
        SolStakeOp::CreateAndDelegate {
            seed,
            lamports,
            vote_account,
        } => {
            if seed.is_empty() || seed.len() > MAX_SEED_LEN || !seed.is_ascii() {
                return Err(Error::input("seed: 1 to 32 ASCII characters"));
            }
            let stake = create_with_seed(&me_k, seed, &stake_program)?;
            let mut create = 3u32.to_le_bytes().to_vec();
            create.extend_from_slice(&me_k);
            create.extend_from_slice(&(seed.len() as u64).to_le_bytes());
            create.extend_from_slice(seed.as_bytes());
            create.extend_from_slice(&lamports.to_le_bytes());
            create.extend_from_slice(&STAKE_STATE_SIZE.to_le_bytes());
            create.extend_from_slice(&stake_program);
            let mut init = 0u32.to_le_bytes().to_vec();
            init.extend_from_slice(&me_k); // staker
            init.extend_from_slice(&me_k); // withdrawer
            init.extend_from_slice(&[0u8; 48]); // lockup: unix_timestamp, epoch, custodian = 0
            vec![
                Ix {
                    program: key(SYSTEM_PROGRAM)?,
                    // base = funding account: the system program takes 2 accounts then.
                    accounts: vec![(me_k, true), (stake, true)],
                    data: create,
                },
                Ix {
                    program: stake_program,
                    accounts: vec![(stake, true), (key(SYSVAR_RENT)?, false)],
                    data: init,
                },
                delegate_ix(stake, key(vote_account)?, me_k)?,
            ]
        }
        SolStakeOp::Delegate {
            stake_account,
            vote_account,
        } => vec![delegate_ix(key(stake_account)?, key(vote_account)?, me_k)?],
        SolStakeOp::Deactivate { stake_account } => vec![Ix {
            program: stake_program,
            accounts: vec![
                (key(stake_account)?, true),
                (key(SYSVAR_CLOCK)?, false),
                (me_k, false),
            ],
            data: 5u32.to_le_bytes().to_vec(),
        }],
        SolStakeOp::Withdraw {
            stake_account,
            lamports,
        } => {
            if *lamports == 0 {
                return Err(Error::input("zero withdrawal amount"));
            }
            let mut data = 4u32.to_le_bytes().to_vec();
            data.extend_from_slice(&lamports.to_le_bytes());
            vec![Ix {
                program: stake_program,
                accounts: vec![
                    (key(stake_account)?, true),
                    (me_k, true),
                    (key(SYSVAR_CLOCK)?, false),
                    (key(SYSVAR_STAKE_HISTORY)?, false),
                    (me_k, false),
                ],
                data,
            }]
        }
    };
    legacy_message(&me_k, &bh, &ixs)
}

/// Delegation part of a delegated stake account.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SolDelegation {
    /// Vote account (validator).
    pub vote_account: String,
    /// Lamports delegated.
    pub stake: u64,
    /// Epoch the delegation started (`u64::MAX` for bootstrap stakes).
    pub activation_epoch: u64,
    /// Epoch of `Deactivate` (`u64::MAX` = not deactivated).
    pub deactivation_epoch: u64,
}

/// Decoded `StakeStateV2` account.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SolStakeAccount {
    /// `uninitialized` | `initialized` | `delegated` | `rewardsPool`.
    pub state: String,
    /// Lamports kept for rent exemption.
    pub rent_exempt_reserve: u64,
    /// Stake authority.
    pub staker: String,
    /// Withdraw authority.
    pub withdrawer: String,
    /// Lockup: Unix timestamp (0 = none).
    pub lockup_unix_timestamp: i64,
    /// Lockup: epoch (0 = none).
    pub lockup_epoch: u64,
    /// Lockup custodian (`11111111111111111111111111111111` = none).
    pub lockup_custodian: String,
    /// Present when delegated.
    pub delegation: Option<SolDelegation>,
}

fn u64_at(d: &[u8], at: usize) -> Result<u64> {
    d.get(at..at + 8)
        .and_then(|b| b.try_into().ok())
        .map(u64::from_le_bytes)
        .ok_or_else(|| Error::input("truncated stake account"))
}

fn key_at(d: &[u8], at: usize) -> Result<String> {
    let k: [u8; 32] = d
        .get(at..at + 32)
        .and_then(|b| b.try_into().ok())
        .ok_or_else(|| Error::input("truncated stake account"))?;
    Ok(b58(&k))
}

/// Parses a 200-byte stake account (`StakeStateV2`, bincode): tag, `Meta` at 4..124, then
/// for `Stake` the `Delegation` at 124..188.
pub fn sol_parse_stake_account(data: &[u8]) -> Result<SolStakeAccount> {
    if data.len() as u64 != STAKE_STATE_SIZE {
        return Err(Error::input("stake account: unexpected size"));
    }
    let tag = u32::from_le_bytes([data[0], data[1], data[2], data[3]]);
    let state = match tag {
        0 => "uninitialized",
        1 => "initialized",
        2 => "delegated",
        3 => "rewardsPool",
        _ => return Err(Error::input("stake account: unknown state")),
    };
    if tag == 0 || tag == 3 {
        return Ok(SolStakeAccount {
            state: state.into(),
            rent_exempt_reserve: 0,
            staker: String::new(),
            withdrawer: String::new(),
            lockup_unix_timestamp: 0,
            lockup_epoch: 0,
            lockup_custodian: String::new(),
            delegation: None,
        });
    }
    let delegation = if tag == 2 {
        Some(SolDelegation {
            vote_account: key_at(data, 124)?,
            stake: u64_at(data, 156)?,
            activation_epoch: u64_at(data, 164)?,
            deactivation_epoch: u64_at(data, 172)?,
        })
    } else {
        None
    };
    Ok(SolStakeAccount {
        state: state.into(),
        rent_exempt_reserve: u64_at(data, 4)?,
        staker: key_at(data, 12)?,
        withdrawer: key_at(data, 44)?,
        lockup_unix_timestamp: u64_at(data, 76)? as i64,
        lockup_epoch: u64_at(data, 84)?,
        lockup_custodian: key_at(data, 92)?,
        delegation,
    })
}

/// One entry of the StakeHistory sysvar.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SolStakeHistoryEntry {
    /// Epoch.
    pub epoch: u64,
    /// Cluster effective stake.
    pub effective: u64,
    /// Cluster stake warming up.
    pub activating: u64,
    /// Cluster stake cooling down.
    pub deactivating: u64,
}

/// Parses the StakeHistory sysvar (bincode `u64` length, then 32-byte entries).
pub fn sol_parse_stake_history(data: &[u8]) -> Result<Vec<SolStakeHistoryEntry>> {
    let n = usize::try_from(u64_at(data, 0)?).map_err(|_| Error::input("invalid history"))?;
    if n > 512 || data.len() < 8 + n * 32 {
        return Err(Error::input("invalid stake history"));
    }
    (0..n)
        .map(|i| {
            let at = 8 + i * 32;
            Ok(SolStakeHistoryEntry {
                epoch: u64_at(data, at)?,
                effective: u64_at(data, at + 8)?,
                activating: u64_at(data, at + 16)?,
                deactivating: u64_at(data, at + 24)?,
            })
        })
        .collect()
}

/// Effective / activating / deactivating lamports of a delegation at `target_epoch`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SolStakeActivation {
    /// Earning rewards.
    pub effective: u64,
    /// Warming up.
    pub activating: u64,
    /// Cooling down.
    pub deactivating: u64,
}

fn entry(h: &[SolStakeHistoryEntry], epoch: u64) -> Option<&SolStakeHistoryEntry> {
    h.iter().find(|e| e.epoch == epoch)
}

fn stake_and_activating(d: &SolDelegation, target: u64, h: &[SolStakeHistoryEntry]) -> (u64, u64) {
    let delegated = d.stake;
    if d.activation_epoch == u64::MAX {
        return (delegated, 0);
    }
    if d.activation_epoch == d.deactivation_epoch {
        // Activated and deactivated in the same epoch: never any stake.
        return (0, 0);
    }
    if target == d.activation_epoch {
        return (0, delegated);
    }
    if target < d.activation_epoch {
        return (0, 0);
    }
    let Some(mut prev) = entry(h, d.activation_epoch).copied() else {
        // Older than the history: fully effective.
        return (delegated, 0);
    };
    let mut prev_epoch = d.activation_epoch;
    let mut effective: u64 = 0;
    // Epochs come from the chain (StakeHistory via RPC): never wrap around.
    while let Some(current) = prev_epoch.checked_add(1) {
        if prev.activating == 0 {
            break;
        }
        let remaining = delegated.saturating_sub(effective);
        let weight = remaining as f64 / prev.activating as f64;
        let newly_cluster = prev.effective as f64 * WARMUP_COOLDOWN_RATE;
        let newly = ((weight * newly_cluster) as u64).max(1);
        effective = effective.saturating_add(newly);
        if effective >= delegated {
            effective = delegated;
            break;
        }
        if current >= target || current >= d.deactivation_epoch {
            break;
        }
        match entry(h, current) {
            Some(e) => {
                prev_epoch = current;
                prev = *e;
            }
            None => break,
        }
    }
    (effective, delegated.saturating_sub(effective))
}

/// Stake program's `stake_activating_and_deactivating` at `target_epoch`, from StakeHistory.
pub fn sol_stake_activation(
    d: &SolDelegation,
    target_epoch: u64,
    history: &[SolStakeHistoryEntry],
) -> SolStakeActivation {
    let (effective, activating) = stake_and_activating(d, target_epoch, history);
    if target_epoch < d.deactivation_epoch {
        return SolStakeActivation {
            effective,
            activating,
            deactivating: 0,
        };
    }
    if target_epoch == d.deactivation_epoch {
        return SolStakeActivation {
            effective,
            activating: 0,
            deactivating: effective,
        };
    }
    let Some(mut prev) = entry(history, d.deactivation_epoch).copied() else {
        return SolStakeActivation::default();
    };
    let mut prev_epoch = d.deactivation_epoch;
    let mut current_effective = effective;
    while let Some(current) = prev_epoch.checked_add(1) {
        if prev.deactivating == 0 {
            break;
        }
        let weight = current_effective as f64 / prev.deactivating as f64;
        let newly_cluster = prev.effective as f64 * WARMUP_COOLDOWN_RATE;
        let newly = ((weight * newly_cluster) as u64).max(1);
        current_effective = current_effective.saturating_sub(newly);
        if current_effective == 0 || current >= target_epoch {
            break;
        }
        match entry(history, current) {
            Some(e) => {
                prev_epoch = current;
                prev = *e;
            }
            None => break,
        }
    }
    SolStakeActivation {
        effective: current_effective,
        activating: 0,
        deactivating: current_effective,
    }
}

/// Withdrawable now (Stake `withdraw` rule): `(partial max keeping account open, whole allowed)`.
pub fn sol_stake_withdrawable(
    account: &SolStakeAccount,
    balance: u64,
    current_epoch: u64,
    history: &[SolStakeHistoryEntry],
) -> (u64, bool) {
    let staked = match &account.delegation {
        Some(d) if current_epoch >= d.deactivation_epoch => {
            let a = sol_stake_activation(d, current_epoch, history);
            a.effective
        }
        Some(d) => d.stake,
        None => 0,
    };
    let reserve = staked.saturating_add(account.rent_exempt_reserve);
    (balance.saturating_sub(reserve), staked == 0)
}
