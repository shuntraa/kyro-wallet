//! Sui native staking: `0x3::sui_system::request_add_stake` and `request_withdraw_stake`, the only
//! Move calls Kyro signs on Sui. Same strict hand-written BCS as [`crate::sui_tx`] (byte-exact
//! re-encoding, no sponsor), in the layout of the official TS SDK:
//!
//! ```text
//!   add:      inputs:   [Pure(u64 amount), Shared(0x5, v1, mutable), Pure(address validator)]
//!             commands: [SplitCoins(GasCoin, [Input(0)]),
//!                        MoveCall(0x3::sui_system::request_add_stake,
//!                                 [Input(1), NestedResult(0, 0), Input(2)])]
//!   withdraw: inputs:   [Shared(0x5, v1, mutable), Object(ImmOrOwned StakedSui)]
//!             commands: [MoveCall(0x3::sui_system::request_withdraw_stake, [Input(0), Input(1)])]
//! ```
//!
//! The withdrawn SUI go to the transaction sender (the Move function transfers them to
//! `ctx.sender()`): the bytes hold no recipient. The payment path ([`crate::SuiTransfer`]) keeps
//! refusing every Move call.

use base64::Engine as _;
use ed25519_dalek::Signer as _;
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::mnemonic::Seed;
use crate::sui::{
    signing_key, sui_address_bytes_of_pubkey, sui_address_string, sui_parse_address,
    SUI_ED25519_FLAG,
};
use crate::sui_tx::{
    b64, bad, put_bytes, put_ref, put_uleb, read_ref, signing_digest, sui_tx_digest,
    verify_sender_signature, view, Reader, SuiGasCoinView, SuiObjectRef, MAX_BCS,
    SUI_MAX_GAS_OBJECTS,
};

/// Protocol minimum of one stake (`MIN_STAKING_THRESHOLD`, 1 SUI).
pub const SUI_MIN_STAKE: u64 = 1_000_000_000;
const MODULE: &str = "sui_system";
const ADD: &str = "request_add_stake";
const WITHDRAW: &str = "request_withdraw_stake";
/// `0x5`, the shared `SuiSystemState`, created at genesis (version 1).
const SYSTEM_STATE: [u8; 32] = {
    let mut a = [0u8; 32];
    a[31] = 5;
    a
};
const SYSTEM_STATE_VERSION: u64 = 1;
/// `0x3`, the Sui system package.
const SYSTEM_PACKAGE: [u8; 32] = {
    let mut a = [0u8; 32];
    a[31] = 3;
    a
};

/// What the staking transaction does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SuiStakeCall {
    /// Split `amount` MIST from the gas coin and stake it with `validator`.
    Add {
        /// MIST.
        amount: u64,
        /// Validator's Sui address.
        validator: [u8; 32],
    },
    /// Give back a `StakedSui` object: principal and rewards return to the sender.
    Withdraw {
        /// The `0x3::staking_pool::StakedSui` object (checked live by the shell).
        staked: SuiObjectRef,
    },
}

/// One of the two staking transactions Kyro builds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SuiStakeTx {
    /// Sender and gas owner.
    pub sender: [u8; 32],
    /// The system call.
    pub call: SuiStakeCall,
    /// Gas coins.
    pub gas_payment: Vec<SuiObjectRef>,
    /// MIST per gas unit.
    pub gas_price: u64,
    /// MIST.
    pub gas_budget: u64,
    /// Void after this epoch.
    pub expiration_epoch: Option<u64>,
}

fn put_system_state(o: &mut Vec<u8>) {
    o.push(1); // CallArg::Object
    o.push(1); // ObjectArg::SharedObject
    o.extend_from_slice(&SYSTEM_STATE);
    o.extend_from_slice(&SYSTEM_STATE_VERSION.to_le_bytes());
    o.push(1); // mutable
}

fn put_input_arg(o: &mut Vec<u8>, i: u16) {
    o.push(1); // Argument::Input
    o.extend_from_slice(&i.to_le_bytes());
}

fn put_move_call(o: &mut Vec<u8>, function: &str, args: impl FnOnce(&mut Vec<u8>)) {
    o.push(0); // Command::MoveCall
    o.extend_from_slice(&SYSTEM_PACKAGE);
    put_bytes(o, MODULE.as_bytes());
    put_bytes(o, function.as_bytes());
    o.push(0); // no type arguments
    args(o);
}

fn read_pure(r: &mut Reader<'_>, len: usize, what: &str) -> Result<Vec<u8>> {
    if r.uleb()? != 0 {
        return Err(bad(format!("{what}: pure value expected")));
    }
    if r.len(64)? != len {
        return Err(bad(format!("{what}: {len} bytes expected")));
    }
    Ok(r.take(len)?.to_vec())
}

fn read_string(r: &mut Reader<'_>) -> Result<String> {
    let n = r.len(64)?;
    core::str::from_utf8(r.take(n)?)
        .map(str::to_owned)
        .map_err(|_| bad("invalid identifier"))
}

/// Skips over the system-state input (its exact value is enforced by the re-encoding).
fn read_system_state(r: &mut Reader<'_>) -> Result<()> {
    if r.uleb()? != 1 || r.uleb()? != 1 {
        return Err(bad("the system state must be a shared object input"));
    }
    if r.arr32()? != SYSTEM_STATE {
        return Err(bad("shared object other than the system state"));
    }
    r.take(9)?;
    Ok(())
}

/// Reads a MoveCall and refuses everything but the two system functions. Its arguments are only
/// skipped here: their exact value is enforced by the re-encoding.
fn read_function(r: &mut Reader<'_>) -> Result<String> {
    if r.uleb()? != 0 {
        return Err(bad("Move call expected"));
    }
    if r.arr32()? != SYSTEM_PACKAGE {
        return Err(bad("Move package other than 0x3: refused"));
    }
    let module = read_string(r)?;
    let function = read_string(r)?;
    if module != MODULE || (function != ADD && function != WITHDRAW) {
        return Err(bad(format!(
            "system function {module}::{function} refused: Kyro only stakes and withdraws"
        )));
    }
    if r.uleb()? != 0 {
        return Err(bad("unexpected type arguments"));
    }
    let n = r.len(3)?;
    // add: Input, NestedResult, Input; withdraw: Input, Input.
    r.take(if n == 3 { 11 } else { n * 3 })?;
    Ok(function)
}

impl SuiStakeTx {
    fn check(&self) -> Result<()> {
        if self.gas_payment.is_empty() {
            return Err(bad("no gas coin"));
        }
        if self.gas_payment.len() > SUI_MAX_GAS_OBJECTS {
            return Err(bad(format!("more than {SUI_MAX_GAS_OBJECTS} gas coins")));
        }
        for (i, a) in self.gas_payment.iter().enumerate() {
            if self.gas_payment[..i]
                .iter()
                .any(|b| b.object_id == a.object_id)
            {
                return Err(bad("duplicate gas coin"));
            }
        }
        if self.gas_price == 0 || self.gas_budget == 0 {
            return Err(bad("zero gas price or budget"));
        }
        match self.call {
            SuiStakeCall::Add { amount, .. } if amount < SUI_MIN_STAKE => {
                Err(bad("stake below the 1 SUI protocol minimum"))
            }
            SuiStakeCall::Withdraw { staked }
                if self
                    .gas_payment
                    .iter()
                    .any(|g| g.object_id == staked.object_id) =>
            {
                Err(bad("the staked object cannot pay for gas"))
            }
            _ => Ok(()),
        }
    }

    /// BCS of the `TransactionData`.
    pub fn encode(&self) -> Result<Vec<u8>> {
        self.check()?;
        let mut o = Vec::with_capacity(320 + 80 * self.gas_payment.len());
        o.push(0); // TransactionData::V1
        o.push(0); // TransactionKind::ProgrammableTransaction
        match self.call {
            SuiStakeCall::Add { amount, validator } => {
                o.push(3);
                o.push(0); // CallArg::Pure
                put_bytes(&mut o, &amount.to_le_bytes());
                put_system_state(&mut o);
                o.push(0);
                put_bytes(&mut o, &validator);
                o.push(2);
                o.push(2); // Command::SplitCoins
                o.push(0); // Argument::GasCoin
                o.push(1);
                put_input_arg(&mut o, 0);
                put_move_call(&mut o, ADD, |o| {
                    o.push(3);
                    put_input_arg(o, 1);
                    o.push(3); // Argument::NestedResult(0, 0)
                    o.extend_from_slice(&[0; 4]);
                    put_input_arg(o, 2);
                });
            }
            SuiStakeCall::Withdraw { staked } => {
                o.push(2);
                put_system_state(&mut o);
                o.push(1); // CallArg::Object
                o.push(0); // ObjectArg::ImmOrOwnedObject
                put_ref(&mut o, &staked);
                o.push(1);
                put_move_call(&mut o, WITHDRAW, |o| {
                    o.push(2);
                    put_input_arg(o, 0);
                    put_input_arg(o, 1);
                });
            }
        }
        o.extend_from_slice(&self.sender);
        put_uleb(&mut o, self.gas_payment.len() as u64);
        for g in &self.gas_payment {
            put_ref(&mut o, g);
        }
        o.extend_from_slice(&self.sender); // gas owner
        o.extend_from_slice(&self.gas_price.to_le_bytes());
        o.extend_from_slice(&self.gas_budget.to_le_bytes());
        match self.expiration_epoch {
            None => o.push(0),
            Some(e) => {
                o.push(1);
                o.extend_from_slice(&e.to_le_bytes());
            }
        }
        Ok(o)
    }

    /// Strict decoding; the result re-encodes to exactly `bcs` (checked).
    pub fn decode(bcs: &[u8]) -> Result<SuiStakeTx> {
        if bcs.len() > MAX_BCS {
            return Err(bad("too large"));
        }
        let mut r = Reader(bcs);
        if r.uleb()? != 0 {
            return Err(bad("unknown TransactionData version"));
        }
        if r.uleb()? != 0 {
            return Err(bad("system transaction or unknown type"));
        }
        let call = match r.uleb()? {
            3 => {
                let a = read_pure(&mut r, 8, "amount")?;
                read_system_state(&mut r)?;
                let v = read_pure(&mut r, 32, "validator")?;
                if r.uleb()? != 2 || r.uleb()? != 2 {
                    return Err(bad("unknown staking structure"));
                }
                r.take(5)?; // GasCoin, one amount, Input(0)
                if read_function(&mut r)? != ADD {
                    return Err(bad("unknown staking structure"));
                }
                SuiStakeCall::Add {
                    amount: u64::from_le_bytes(a.try_into().map_err(|_| bad("amount"))?),
                    validator: v.try_into().map_err(|_| bad("validator"))?,
                }
            }
            2 => {
                read_system_state(&mut r)?;
                if r.uleb()? != 1 || r.uleb()? != 0 {
                    return Err(bad("the staked object must be an owned object input"));
                }
                let staked = read_ref(&mut r)?;
                if r.uleb()? != 1 {
                    return Err(bad("unknown staking structure"));
                }
                if read_function(&mut r)? != WITHDRAW {
                    return Err(bad("unknown staking structure"));
                }
                SuiStakeCall::Withdraw { staked }
            }
            _ => return Err(bad("unknown staking structure")),
        };
        let sender = r.arr32()?;
        let n = r.len(SUI_MAX_GAS_OBJECTS)?;
        let mut gas_payment = Vec::with_capacity(n);
        for _ in 0..n {
            gas_payment.push(read_ref(&mut r)?);
        }
        if r.arr32()? != sender {
            return Err(bad(
                "gas paid by another account (sponsored transaction): not supported",
            ));
        }
        let gas_price = r.u64()?;
        let gas_budget = r.u64()?;
        let expiration_epoch = match r.uleb()? {
            0 => None,
            1 => Some(r.u64()?),
            _ => return Err(bad("expiration not supported")),
        };
        if !r.0.is_empty() {
            return Err(bad("trailing bytes after the transaction"));
        }
        let t = SuiStakeTx {
            sender,
            call,
            gas_payment,
            gas_price,
            gas_budget,
            expiration_epoch,
        };
        if t.encode()? != bcs {
            return Err(bad("re-encoding differs"));
        }
        Ok(t)
    }
}

/// The decoded operation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SuiStakeAction {
    /// `request_add_stake`.
    Add {
        /// MIST, decimal.
        amount: String,
        /// Full `0x…` address.
        validator: String,
    },
    /// `request_withdraw_stake`.
    Withdraw {
        /// The `StakedSui` object given back.
        staked: SuiGasCoinView,
    },
}

/// Summary of a staking transaction, decoded by Rust.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuiStakeSummary {
    /// Sender = gas owner (checked: ours).
    pub sender: String,
    /// What it does.
    pub action: SuiStakeAction,
    /// MIST, decimal.
    pub gas_budget: String,
    /// MIST per gas unit, decimal.
    pub gas_price: String,
    /// Gas coins.
    pub gas_coins: Vec<SuiGasCoinView>,
    /// Void after this epoch.
    pub expiration_epoch: u64,
    /// Transaction digest (base58).
    pub digest: String,
}

fn summarize(t: &SuiStakeTx, bcs: &[u8], ours: &[u8; 32]) -> Result<SuiStakeSummary> {
    if &t.sender != ours {
        return Err(bad("the sender is not this account's address"));
    }
    let expiration_epoch = t
        .expiration_epoch
        .ok_or_else(|| bad("no expiration epoch: Kyro only signs what it builds"))?;
    Ok(SuiStakeSummary {
        sender: sui_address_string(&t.sender),
        action: match t.call {
            SuiStakeCall::Add { amount, validator } => SuiStakeAction::Add {
                amount: amount.to_string(),
                validator: sui_address_string(&validator),
            },
            SuiStakeCall::Withdraw { staked } => SuiStakeAction::Withdraw {
                staked: view(&staked),
            },
        },
        gas_budget: t.gas_budget.to_string(),
        gas_price: t.gas_price.to_string(),
        gas_coins: t.gas_payment.iter().map(view).collect(),
        expiration_epoch,
        digest: sui_tx_digest(bcs),
    })
}

/// Decodes an unsigned staking transaction (base64 BCS) of `our_address`.
pub fn sui_stake_decode(bcs_b64: &str, our_address: &str) -> Result<SuiStakeSummary> {
    let bcs = b64(bcs_b64, "transaction")?;
    let t = SuiStakeTx::decode(&bcs)?;
    summarize(&t, &bcs, &sui_parse_address(our_address)?)
}

/// Signs a staking transaction with `account`'s key: `(signature base64, summary)`.
pub fn sui_stake_sign(
    seed: &Seed,
    account: u32,
    bcs_b64: &str,
) -> Result<(String, SuiStakeSummary)> {
    let bcs = b64(bcs_b64, "transaction")?;
    let t = SuiStakeTx::decode(&bcs)?;
    let key = signing_key(seed, account)?;
    let pk = key.verifying_key();
    let summary = summarize(&t, &bcs, &sui_address_bytes_of_pubkey(pk.as_bytes()))?;
    let msg = signing_digest(&bcs);
    let sig = key.sign(&msg);
    pk.verify_strict(&msg, &sig)
        .map_err(|_| Error::crypto("signature verification failed"))?;
    let mut out = Vec::with_capacity(97);
    out.push(SUI_ED25519_FLAG);
    out.extend_from_slice(&sig.to_bytes());
    out.extend_from_slice(pk.as_bytes());
    Ok((
        base64::engine::general_purpose::STANDARD.encode(out),
        summary,
    ))
}

/// Pre-send check: strict decode and strict ed25519 by the sender: `(transaction, digest)`.
pub fn sui_stake_verify_signed(bcs_b64: &str, signature_b64: &str) -> Result<(SuiStakeTx, String)> {
    let bcs = b64(bcs_b64, "transaction")?;
    let t = SuiStakeTx::decode(&bcs)?;
    verify_sender_signature(&bcs, &t.sender, signature_b64)?;
    Ok((t, sui_tx_digest(&bcs)))
}
