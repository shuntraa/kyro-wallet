//! Replacing a pending Bitcoin or Litecoin transaction of your own (BIP125): the rules Rust holds
//! a replacement to, whatever the interface built, before the native window opens.
//!
//! Kyro replaces with **exactly the same inputs**. That keeps every BIP125 rule checkable here:
//! the replacement conflicts with the original, and no new unconfirmed input can appear (rule 2).
//! A speed-up leaves every payment untouched and takes the extra fee from your own change; a
//! cancel sends everything back to one of your own addresses. Whether the original is already
//! confirmed is the network's answer, not Rust's: then the replacement is simply invalid.

use std::collections::HashMap;
use std::str::FromStr;

use bitcoin::consensus::deserialize;
use bitcoin::{OutPoint, Transaction, Txid};
use serde::{Deserialize, Serialize};

use crate::btc::{estimated_vsize, parse_psbt, prevouts};
use crate::error::{Error, Result};

/// `nSequence` of a replaceable input (BIP125: anything below `0xfffffffe`).
pub const RBF_SEQUENCE: u32 = 0xffff_fffd;
/// BIP125 rule 4: the replacement pays for its own relay, per vbyte (Bitcoin Core and Litecoin
/// Core default; newer Bitcoin nodes ask for less, so this is safe on all of them).
pub const RBF_INCREMENTAL_PER_VB: u64 = 1;

/// What the replacement is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReplaceMode {
    /// Same payment, higher fee.
    SpeedUp,
    /// Back to yourself, higher fee.
    Cancel,
}

/// The pending transaction to replace, as given to a signing command.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UtxoReplaceRequest {
    /// Txid of the original.
    pub txid: String,
    /// Original transaction, raw hex (its txid is recomputed here).
    pub raw_tx: String,
    /// Speed up or cancel.
    pub mode: ReplaceMode,
}

/// What the native window says about a checked replacement.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UtxoReplacement {
    /// Speed up or cancel.
    pub mode: ReplaceMode,
    /// Txid of the original.
    pub txid: String,
    /// Fee of the original, smallest unit (computed, never read from a server).
    pub old_fee: u64,
    /// Fee of the replacement.
    pub new_fee: u64,
    /// What this costs on top: `new_fee - old_fee`.
    pub extra_fee: u64,
}

fn refuse(msg: &str) -> Error {
    Error::input(format!("replacement refused: {msg}"))
}

/// Fee a replacement must pay at least (BIP125 rules 3 and 4).
pub fn rbf_min_fee(old_fee: u64, new_vsize: u64) -> Option<u64> {
    old_fee.checked_add(new_vsize.checked_mul(RBF_INCREMENTAL_PER_VB)?)
}

/// Checks a replacement PSBT against the transaction it replaces. `change[i]`: output `i` of the
/// PSBT provably pays one of our keys (from the decoded summary).
pub fn utxo_check_replacement(
    psbt_b64: &str,
    req: &UtxoReplaceRequest,
    change: &[bool],
) -> Result<UtxoReplacement> {
    let psbt = parse_psbt(psbt_b64)?;
    let spent = prevouts(&psbt)?;
    let tx = &psbt.unsigned_tx;
    if change.len() != tx.output.len() {
        return Err(Error::psbt("output count mismatch"));
    }
    let raw = hex::decode(req.raw_tx.trim()).map_err(|_| refuse("unreadable original"))?;
    let original: Transaction = deserialize(&raw).map_err(|_| refuse("unreadable original"))?;
    let txid = Txid::from_str(req.txid.trim()).map_err(|_| refuse("invalid txid"))?;
    if original.compute_txid() != txid {
        return Err(refuse("the original does not match its txid"));
    }
    if !original.input.iter().any(|i| i.sequence.is_rbf()) {
        return Err(refuse("the original is not marked replaceable"));
    }
    if !tx.input.iter().all(|i| i.sequence.is_rbf()) {
        return Err(refuse("the new transaction must stay replaceable"));
    }

    let values: HashMap<OutPoint, u64> = tx
        .input
        .iter()
        .zip(&spent)
        .map(|(i, p)| (i.previous_output, p.value.to_sat()))
        .collect();
    if values.len() != tx.input.len()
        || original.input.len() != tx.input.len()
        || !original
            .input
            .iter()
            .all(|i| values.contains_key(&i.previous_output))
    {
        return Err(refuse("the inputs must be exactly those of the original"));
    }

    let total_in = values
        .values()
        .try_fold(0u64, |a, v| a.checked_add(*v))
        .ok_or_else(|| Error::psbt("input amount overflow"))?;
    let out_sum = |t: &Transaction| {
        t.output
            .iter()
            .try_fold(0u64, |a, o| a.checked_add(o.value.to_sat()))
            .ok_or_else(|| Error::psbt("output amount overflow"))
    };
    let old_fee = total_in
        .checked_sub(out_sum(&original)?)
        .ok_or_else(|| refuse("the original pays more than its inputs"))?;
    let new_fee = total_in
        .checked_sub(out_sum(tx)?)
        .ok_or_else(|| Error::psbt("outputs exceed inputs (negative fee)"))?;

    let needed = rbf_min_fee(old_fee, estimated_vsize(&psbt, &spent))
        .ok_or_else(|| Error::psbt("fee overflow"))?;
    if new_fee < needed {
        return Err(refuse("the fee does not rise enough"));
    }

    match req.mode {
        ReplaceMode::SpeedUp => {
            if tx.output.len() != original.output.len() {
                return Err(refuse("a speed-up keeps every output"));
            }
            for ((new, old), own) in tx.output.iter().zip(&original.output).zip(change) {
                if new.script_pubkey != old.script_pubkey {
                    return Err(refuse("a speed-up keeps every recipient"));
                }
                let same = new.value == old.value;
                if !same && !(*own && new.value < old.value) {
                    return Err(refuse("only your own change may pay for a speed-up"));
                }
            }
        }
        ReplaceMode::Cancel => {
            if change != [true] {
                return Err(refuse("a cancel pays one output, to yourself"));
            }
        }
    }

    Ok(UtxoReplacement {
        mode: req.mode,
        txid: txid.to_string(),
        old_fee,
        new_fee,
        extra_fee: new_fee - old_fee,
    })
}
