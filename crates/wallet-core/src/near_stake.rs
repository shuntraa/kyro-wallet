//! NEAR staking through staking pools: one `FunctionCall` to a pool created by the official pool
//! factories (`*.poolv1.near`, `*.pool.near`, testnet `*.pool.f863973.m0`), methods
//! `deposit_and_stake`, `unstake`, `unstake_all` and `withdraw_all` only. Same `TransactionV0`
//! framing as [`crate::near`] (strict decode, identical re-encoding, ed25519 over SHA-256).

use ed25519_dalek::Signer as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{Error, Result};
use crate::mnemonic::Seed;
use crate::near::{
    action_name, bad, near_account_kind, near_hash_string, near_public_key_string, put_string,
    read_account_id, read_u128, read_u32, read_u64, read_u8, signing_key, take, take_array, unhex,
    NearAccountKind, ACTION_FUNCTION_CALL, ED25519, MAX_DEPOSIT, MAX_TX,
};

/// Gas attached to every pool call (125 Tgas, what NEAR wallets attach; unused gas is refunded).
pub const NEAR_STAKE_GAS: u64 = 125_000_000_000_000;

/// Pool factories Kyro accepts and the code hash their pools must run (read live before signing).
const POOL_FACTORIES: &[(&str, bool, &str)] = &[
    // core-contracts staking-pool, deployed by poolv1.near.
    (
        ".poolv1.near",
        false,
        "J1arLz48fgXcGyCPVckFwLnewNH6j1uw79thsvwqGYTY",
    ),
    // pool.near factory (staking-farm build of the same pool interface).
    (
        ".pool.near",
        false,
        "AjD4YJaXgpiRdiArqnzyDi7Bkr1gJms9Z2w7Ev5esTKB",
    ),
    // Testnet factory, same staking-pool code as poolv1.near.
    (
        ".pool.f863973.m0",
        true,
        "J1arLz48fgXcGyCPVckFwLnewNH6j1uw79thsvwqGYTY",
    ),
];

/// `Some(testnet)` when `pool` is a direct sub-account of a known pool factory.
pub fn near_stake_pool_network(pool: &str) -> Option<bool> {
    near_account_kind(pool).ok()?;
    POOL_FACTORIES.iter().find_map(|(suffix, testnet, _)| {
        let name = pool.strip_suffix(suffix)?;
        (!name.is_empty() && !name.contains('.')).then_some(*testnet)
    })
}

/// The pool's on-chain `code_hash` is the one its factory deploys.
pub fn near_stake_code_ok(pool: &str, code_hash: &str) -> bool {
    POOL_FACTORIES.iter().any(|(suffix, _, hash)| {
        pool.strip_suffix(suffix)
            .is_some_and(|n| !n.is_empty() && !n.contains('.'))
            && *hash == code_hash
    })
}

/// The pool method called (amounts in yoctoNEAR).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NearStakeCall {
    /// `deposit_and_stake({})` with `amount` attached.
    DepositAndStake(u128),
    /// `unstake({"amount"})`: starts the 4-epoch unlock.
    Unstake(u128),
    /// `unstake_all({})`.
    UnstakeAll,
    /// `withdraw_all({})`: moves the unlocked balance back to the account.
    WithdrawAll,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UnstakeArgs {
    amount: String,
}

impl NearStakeCall {
    fn method(&self) -> &'static str {
        match self {
            NearStakeCall::DepositAndStake(_) => "deposit_and_stake",
            NearStakeCall::Unstake(_) => "unstake",
            NearStakeCall::UnstakeAll => "unstake_all",
            NearStakeCall::WithdrawAll => "withdraw_all",
        }
    }

    fn args(&self) -> String {
        match self {
            NearStakeCall::Unstake(a) => format!("{{\"amount\":\"{a}\"}}"),
            _ => "{}".into(),
        }
    }

    fn deposit(&self) -> u128 {
        match self {
            NearStakeCall::DepositAndStake(a) => *a,
            _ => 0,
        }
    }

    fn parse(method: &str, args: &[u8], deposit: u128) -> Result<NearStakeCall> {
        let empty = || {
            if args == b"{}" {
                Ok(())
            } else {
                Err(bad(format!("{method}: unexpected arguments")))
            }
        };
        let call = match method {
            "deposit_and_stake" => {
                empty()?;
                if deposit == 0 || deposit > MAX_DEPOSIT {
                    return Err(bad("deposit_and_stake: amount out of bounds"));
                }
                return Ok(NearStakeCall::DepositAndStake(deposit));
            }
            "unstake" => {
                let a: UnstakeArgs = serde_json::from_slice(args)
                    .map_err(|_| bad("unstake: unexpected arguments"))?;
                let v: u128 = a.amount.parse().map_err(|_| bad("unstake: bad amount"))?;
                if v == 0 || v > MAX_DEPOSIT {
                    return Err(bad("unstake: amount out of bounds"));
                }
                NearStakeCall::Unstake(v)
            }
            "unstake_all" => {
                empty()?;
                NearStakeCall::UnstakeAll
            }
            "withdraw_all" => {
                empty()?;
                NearStakeCall::WithdrawAll
            }
            m => {
                return Err(bad(format!(
                    "pool method {m} refused: Kyro only stakes, unstakes and withdraws"
                )))
            }
        };
        if deposit != 0 {
            return Err(bad(format!("{method}: NEAR attached")));
        }
        Ok(call)
    }
}

/// A `TransactionV0` with exactly one pool `FunctionCall`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NearStakeTx {
    /// Our account.
    pub signer_id: String,
    /// Our ed25519 access key.
    pub public_key: [u8; 32],
    /// Access key nonce + 1.
    pub nonce: u64,
    /// The staking pool (`receiver_id`).
    pub pool_id: String,
    /// Recent block (expiry ≈ 24 h).
    pub block_hash: [u8; 32],
    /// The pool method.
    pub call: NearStakeCall,
}

impl NearStakeTx {
    /// Borsh serialization (what is hashed and signed).
    pub fn encode(&self) -> Vec<u8> {
        let mut o = Vec::with_capacity(200);
        put_string(&mut o, &self.signer_id);
        o.push(ED25519);
        o.extend_from_slice(&self.public_key);
        o.extend_from_slice(&self.nonce.to_le_bytes());
        put_string(&mut o, &self.pool_id);
        o.extend_from_slice(&self.block_hash);
        o.extend_from_slice(&1u32.to_le_bytes());
        o.push(ACTION_FUNCTION_CALL);
        put_string(&mut o, self.call.method());
        put_string(&mut o, &self.call.args());
        o.extend_from_slice(&NEAR_STAKE_GAS.to_le_bytes());
        o.extend_from_slice(&self.call.deposit().to_le_bytes());
        o
    }

    fn read(b: &mut &[u8]) -> Result<NearStakeTx> {
        if b.first() == Some(&1) {
            return Err(bad("TransactionV1 not supported"));
        }
        let signer_id = read_account_id(b, "signer_id")?;
        if read_u8(b)? != ED25519 {
            return Err(bad("key type not supported"));
        }
        let public_key = take_array(b)?;
        let nonce = read_u64(b)?;
        let pool_id = read_account_id(b, "receiver_id")?;
        if near_stake_pool_network(&pool_id).is_none() {
            return Err(bad(format!(
                "{pool_id} is not a staking pool from a known factory"
            )));
        }
        let block_hash = take_array(b)?;
        let n = read_u32(b)?;
        if n != 1 {
            return Err(bad(format!("{n} actions: Kyro signs one pool call only")));
        }
        let tag = read_u8(b)?;
        if tag != ACTION_FUNCTION_CALL {
            return Err(bad(format!(
                "action {} ({tag}) refused in a staking transaction",
                action_name(tag)
            )));
        }
        let len = read_u32(b)? as usize;
        if len > 32 {
            return Err(bad("method name too long"));
        }
        let method = core::str::from_utf8(take(b, len)?)
            .map_err(|_| bad("method name: invalid UTF-8"))?
            .to_owned();
        let len = read_u32(b)? as usize;
        if len > 128 {
            return Err(bad("arguments too long"));
        }
        let args = take(b, len)?.to_vec();
        let gas = read_u64(b)?;
        let deposit = read_u128(b)?;
        if gas != NEAR_STAKE_GAS {
            return Err(bad("unexpected gas for a pool call"));
        }
        let call = NearStakeCall::parse(&method, &args, deposit)?;
        Ok(NearStakeTx {
            signer_id,
            public_key,
            nonce,
            pool_id,
            block_hash,
            call,
        })
    }

    /// Strict decode: one known pool call, no trailing byte, identical re-encoding.
    pub fn decode(raw: &[u8]) -> Result<NearStakeTx> {
        if raw.len() > MAX_TX {
            return Err(bad("too large"));
        }
        let mut b = raw;
        let tx = NearStakeTx::read(&mut b)?;
        if !b.is_empty() {
            return Err(bad("trailing bytes after the transaction"));
        }
        if tx.encode() != raw {
            return Err(bad("non-canonical encoding"));
        }
        Ok(tx)
    }

    /// `SHA-256(borsh(tx))`.
    pub fn hash(&self) -> [u8; 32] {
        Sha256::digest(self.encode()).into()
    }

    /// `SignedTransaction` Borsh.
    pub fn encode_signed(&self, signature: &[u8; 64]) -> Vec<u8> {
        let mut o = self.encode();
        o.push(ED25519);
        o.extend_from_slice(signature);
        o
    }

    /// Strict decoding of a `SignedTransaction`.
    pub fn decode_signed(raw: &[u8]) -> Result<(NearStakeTx, [u8; 64])> {
        if raw.len() > MAX_TX + 65 {
            return Err(bad("too large"));
        }
        let mut b = raw;
        let tx = NearStakeTx::read(&mut b)?;
        if read_u8(&mut b)? != ED25519 {
            return Err(bad("signature: key type not supported"));
        }
        let sig: [u8; 64] = take_array(&mut b)?;
        if !b.is_empty() {
            return Err(bad("trailing bytes after the signature"));
        }
        if tx.encode_signed(&sig) != raw {
            return Err(bad("non-canonical encoding"));
        }
        Ok((tx, sig))
    }
}

/// What the pool call does (amounts: yoctoNEAR, decimal strings).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum NearStakeAction {
    /// `deposit_and_stake`.
    Stake {
        /// yoctoNEAR.
        amount: String,
    },
    /// `unstake`.
    Unstake {
        /// yoctoNEAR.
        amount: String,
    },
    /// `unstake_all`.
    UnstakeAll,
    /// `withdraw_all`.
    WithdrawAll,
}

/// Decoded staking transaction, for the dialog and the UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NearStakeSummary {
    /// Our account.
    pub signer_id: String,
    /// `ed25519:…`.
    pub public_key: String,
    /// Decimal.
    pub nonce: String,
    /// The staking pool.
    pub pool_id: String,
    /// The pool belongs to the testnet factory.
    pub testnet: bool,
    /// What the call does.
    pub action: NearStakeAction,
    /// Prepaid gas (unused gas is refunded).
    pub gas: String,
    /// yoctoNEAR attached (the stake amount, else 0).
    pub attached: String,
    /// Base58.
    pub block_hash: String,
    /// Transaction hash, base58.
    pub hash: String,
}

fn summarize(
    tx: &NearStakeTx,
    our_account: &str,
    our_pubkey: &[u8; 32],
) -> Result<NearStakeSummary> {
    if tx.signer_id != our_account {
        return Err(bad("the signer is not this wallet's account"));
    }
    if &tx.public_key != our_pubkey {
        return Err(bad("the signing key is not this wallet's"));
    }
    if near_account_kind(&tx.signer_id)? == NearAccountKind::Implicit
        && tx.signer_id != hex::encode(tx.public_key)
    {
        return Err(bad("the key does not match the signing implicit account"));
    }
    if tx.nonce == 0 {
        return Err(bad("zero nonce"));
    }
    let testnet = near_stake_pool_network(&tx.pool_id).ok_or_else(|| bad("unknown pool"))?;
    let action = match tx.call {
        NearStakeCall::DepositAndStake(a) => NearStakeAction::Stake {
            amount: a.to_string(),
        },
        NearStakeCall::Unstake(a) => NearStakeAction::Unstake {
            amount: a.to_string(),
        },
        NearStakeCall::UnstakeAll => NearStakeAction::UnstakeAll,
        NearStakeCall::WithdrawAll => NearStakeAction::WithdrawAll,
    };
    Ok(NearStakeSummary {
        signer_id: tx.signer_id.clone(),
        public_key: near_public_key_string(&tx.public_key),
        nonce: tx.nonce.to_string(),
        pool_id: tx.pool_id.clone(),
        testnet,
        action,
        gas: NEAR_STAKE_GAS.to_string(),
        attached: tx.call.deposit().to_string(),
        block_hash: bs58::encode(tx.block_hash).into_string(),
        hash: near_hash_string(&tx.hash()),
    })
}

/// Decodes an **unsigned** staking transaction (hex Borsh) of our account.
pub fn near_stake_decode(
    tx_hex: &str,
    our_account: &str,
    our_pubkey: &[u8; 32],
) -> Result<NearStakeSummary> {
    summarize(
        &NearStakeTx::decode(&unhex(tx_hex)?)?,
        our_account,
        our_pubkey,
    )
}

/// Signs a staking transaction with `account`'s key: `(signed hex, hash, summary)`.
pub fn near_stake_sign(
    seed: &Seed,
    account: u32,
    tx_hex: &str,
) -> Result<(String, String, NearStakeSummary)> {
    let key = signing_key(seed, account)?;
    let pk = key.verifying_key().to_bytes();
    let tx = NearStakeTx::decode(&unhex(tx_hex)?)?;
    let summary = summarize(&tx, &hex::encode(pk), &pk)?;
    let hash = tx.hash();
    let sig = key.sign(&hash);
    key.verifying_key()
        .verify_strict(&hash, &sig)
        .map_err(|_| Error::crypto("signature verification failed"))?;
    Ok((
        hex::encode(tx.encode_signed(&sig.to_bytes())),
        near_hash_string(&hash),
        summary,
    ))
}

/// Checks a signed staking transaction: strict decode, strict ed25519, implicit signer = key.
pub fn near_stake_verify_signed(signed_hex: &str) -> Result<(NearStakeTx, String)> {
    let (tx, sig) = NearStakeTx::decode_signed(&unhex(signed_hex)?)?;
    let key = ed25519_dalek::VerifyingKey::from_bytes(&tx.public_key)
        .map_err(|_| bad("invalid public key"))?;
    let hash = tx.hash();
    key.verify_strict(&hash, &ed25519_dalek::Signature::from_bytes(&sig))
        .map_err(|_| bad("the signature does not verify"))?;
    if near_account_kind(&tx.signer_id)? == NearAccountKind::Implicit
        && tx.signer_id != hex::encode(tx.public_key)
    {
        return Err(bad("the key does not match the signing implicit account"));
    }
    Ok((tx, near_hash_string(&hash)))
}
