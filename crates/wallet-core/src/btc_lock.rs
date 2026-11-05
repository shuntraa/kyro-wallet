// SPDX-License-Identifier: GPL-3.0-or-later
//! Bitcoin time lock: coins sent to a P2WSH that the network refuses to spend before a date.
//!
//! The script is the miniscript `and_v(v:pk(K),after(T))`, exactly
//! `<K> OP_CHECKSIGVERIFY <T> OP_CHECKLOCKTIMEVERIFY`, so the standard descriptor
//! `wsh(and_v(v:pk(KEY),after(T)))` describes it and Bitcoin Core spends it without Kyro.
//!
//! `T` is 00:00 UTC of the chosen day and `K` sits at `m/84'/coin'/account'/2/<T / 86400>`, so the
//! phrase alone finds every lock by walking the day grid. **Nothing here may ever change**: the
//! script, the path and the day grid are what brings the coins back. The tests freeze them.

use core::str::FromStr;

use bitcoin::absolute::LockTime;
use bitcoin::bip32::ChildNumber;
use bitcoin::consensus::encode::serialize_hex;
use bitcoin::hashes::Hash;
use bitcoin::opcodes::all::{OP_CHECKSIGVERIFY, OP_CLTV};
use bitcoin::script::Builder;
use bitcoin::secp256k1::{All, Message, PublicKey, Secp256k1};
use bitcoin::sighash::{EcdsaSighashType, SighashCache};
use bitcoin::transaction::Version;
use bitcoin::{
    Address, Amount, KnownHrp, OutPoint, ScriptBuf, Sequence, Transaction, TxIn, TxOut, Txid,
    Witness,
};
use serde::{Deserialize, Serialize};

use crate::btc::{
    account_path, account_xpub, btc_address, btc_psbt_summary, btc_sign_psbt, parse_psbt,
    BtcTxSummary, BtcWarning,
};
use crate::btc_watch::btc_script_pubkey;
use crate::error::{Error, Result};
use crate::keys::{normal, path_string, secp, XprivGuard};
use crate::mnemonic::Seed;
use crate::network::{BtcKind, Network};

/// Seconds in a day: `T` is always a multiple of it.
pub const BTC_LOCK_DAY_SECS: u32 = 86_400;
/// Smallest amount that can be locked, in sats: below it a later withdrawal may cost too much.
pub const BTC_LOCK_MIN_SATS: u64 = 50_000;
/// Input sequence of a withdrawal: not final (or CLTV fails), and replaceable.
pub const BTC_LOCK_SEQUENCE: u32 = 0xFFFF_FFFD;
/// The chain under the BIP84 account that holds lock keys. 0 and 1 are receive and change.
pub const BTC_LOCK_BRANCH: u32 = 2;
/// A lock can end at most this many days ahead (10 years, with their leap days).
pub const BTC_LOCK_MAX_DAYS_AHEAD: u32 = 3_653;
/// First day of the grid: 2026-11-05, the day the feature was written. No lock can be earlier.
pub const BTC_LOCK_FIRST_DAY: u32 = 20_762;
/// Local clock and chain tip may differ by this much before a lock is refused.
pub const BTC_LOCK_MAX_CLOCK_GAP_SECS: u64 = 2 * 3_600;
/// Last day a new lock may end: 2038-01-19. Miniscript's `after(n)` stops at `n < 2^31`, so a later
/// date works on the network but has no standard descriptor (Bitcoin Core: "A function is needed
/// within P2WSH") and could only be spent by hand. This shortens the 10 years from January 2028.
pub const BTC_LOCK_LAST_DESCRIBABLE_DAY: u32 = 24_855;
/// Below this, `nLockTime` and CLTV read a block height instead of a time.
const LOCKTIME_THRESHOLD: u32 = 500_000_000;
/// Inputs per withdrawal, far under the standard transaction size. A lock with more coins (only a
/// stranger's dust can do that) is withdrawn in several goes, largest first.
pub const BTC_LOCK_MAX_INPUTS: usize = 400;
/// Smallest output a withdrawal may create, in sats (relay dust limit of a legacy output).
pub const BTC_LOCK_MIN_OUTPUT_SATS: u64 = 546;
/// Highest fee rate accepted for a withdrawal, sat/vB.
pub const BTC_LOCK_MAX_FEE_RATE: u64 = 10_000;
/// Signature size allowed for in the fee: DER at its longest, plus the sighash byte.
const MAX_SIG_LEN: u64 = 73;

/// Everything public about one lock.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BtcLockInfo {
    /// Unlock time, Unix seconds at 00:00 UTC.
    pub t: u32,
    /// `t / 86400`, the last step of the key path.
    pub day: u32,
    /// BIP84 account.
    pub account: u32,
    /// Full key path.
    pub path: String,
    /// Compressed public key, hex.
    pub pubkey: String,
    /// Witness script, hex.
    pub witness_script: String,
    /// Script of the address, hex.
    pub script_pubkey: String,
    /// The address.
    pub address: String,
    /// `wsh(and_v(v:pk([origin]KEY),after(T)))#checksum`, single key: it shows no xpub.
    pub descriptor: String,
}

/// One date of the grid, as the scan asks about it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BtcLockAddress {
    /// Day number.
    pub day: u32,
    /// The address.
    pub address: String,
    /// Script of the address, hex.
    pub script_pubkey: String,
}

/// A coin held by a lock, as a server reports it. A wrong value only yields an invalid signature:
/// BIP143 signs the amount.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BtcLockUtxo {
    /// Funding transaction.
    pub txid: String,
    /// Output index.
    pub vout: u32,
    /// Amount, sats.
    pub value: u64,
}

/// A signed withdrawal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BtcLockSpend {
    /// Raw transaction, hex.
    pub hex: String,
    /// Its txid.
    pub txid: String,
}

/// Checks the form of `t` and returns its day: 00:00 UTC, and a time, never a block height.
pub fn btc_lock_day(t: u32) -> Result<u32> {
    if t < LOCKTIME_THRESHOLD {
        return Err(Error::input(
            "lock date: below 500000000 it would be a height",
        ));
    }
    if t % BTC_LOCK_DAY_SECS != 0 {
        return Err(Error::input("lock date: must be 00:00 UTC"));
    }
    Ok(t / BTC_LOCK_DAY_SECS)
}

/// `T` of a day. `None` past the end of `nLockTime` (year 2106).
pub fn btc_lock_time_of_day(day: u32) -> Option<u32> {
    day.checked_mul(BTC_LOCK_DAY_SECS)
        .filter(|t| *t >= LOCKTIME_THRESHOLD)
}

fn day_of(secs: u64) -> u64 {
    secs / u64::from(BTC_LOCK_DAY_SECS)
}

/// [`btc_lock_day`], for a lock about to be funded: its date must have a standard descriptor.
fn btc_lock_new_day(t: u32) -> Result<u32> {
    let day = btc_lock_day(t)?;
    if day > BTC_LOCK_LAST_DESCRIBABLE_DAY {
        return Err(Error::input("lock date: at most 2038-01-19"));
    }
    Ok(day)
}

/// From tomorrow to 10 years ahead, on the local clock and on the chain tip's time, which must not
/// disagree by more than [`BTC_LOCK_MAX_CLOCK_GAP_SECS`].
pub fn btc_lock_check_window(t: u32, local_now: u64, tip_time: u64) -> Result<()> {
    let day = u64::from(btc_lock_new_day(t)?);
    if local_now.abs_diff(tip_time) > BTC_LOCK_MAX_CLOCK_GAP_SECS {
        return Err(Error::input(
            "this computer's clock and the Bitcoin network disagree by more than 2 hours",
        ));
    }
    if day <= day_of(local_now.max(tip_time)) {
        return Err(Error::input("lock date: from tomorrow (UTC)"));
    }
    if day > day_of(local_now.min(tip_time)) + u64::from(BTC_LOCK_MAX_DAYS_AHEAD) {
        return Err(Error::input("lock date: at most 10 years ahead"));
    }
    Ok(())
}

/// True once the network accepts a spend: median time past strictly above `T`.
pub fn btc_lock_is_open(t: u32, tip_mtp: u64) -> bool {
    tip_mtp > u64::from(t)
}

/// Days the scan walks for a clock at `now`: the first day, up to the furthest date a lock can have,
/// plus two days for a clock that ran ahead when the lock was made.
pub fn btc_lock_last_day(now: u64) -> u32 {
    let last = day_of(now) + u64::from(BTC_LOCK_MAX_DAYS_AHEAD) + 2;
    u32::try_from(last)
        .unwrap_or(u32::MAX)
        .min(BTC_LOCK_LAST_DESCRIBABLE_DAY)
}

/// `YYYY-MM-DD` of a Unix time, UTC.
pub fn btc_lock_utc_date(t: u32) -> String {
    // Howard Hinnant's civil_from_days.
    let z = i64::from(t / BTC_LOCK_DAY_SECS) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

/// `<K> OP_CHECKSIGVERIFY <T> OP_CHECKLOCKTIMEVERIFY`.
fn witness_script(key: PublicKey, t: u32) -> ScriptBuf {
    Builder::new()
        .push_key(&bitcoin::PublicKey::new(key))
        .push_opcode(OP_CHECKSIGVERIFY)
        .push_int(i64::from(t))
        .push_opcode(OP_CLTV)
        .into_script()
}

fn lock_chain(day: u32) -> Result<[ChildNumber; 2]> {
    Ok([normal(BTC_LOCK_BRANCH)?, normal(day)?])
}

fn lock_path(net: Network, account: u32, day: u32) -> Result<Vec<ChildNumber>> {
    let mut path = account_path(net, BtcKind::Segwit, account)?.to_vec();
    path.extend(lock_chain(day)?);
    Ok(path)
}

fn lock_key(
    seed: &Seed,
    secp: &Secp256k1<All>,
    net: Network,
    path: &[ChildNumber],
) -> Result<XprivGuard> {
    XprivGuard::master(seed, net.btc_kind())?.derive(secp, path)
}

fn p2wsh_address(net: Network, script: &ScriptBuf) -> Address {
    Address::p2wsh(script, KnownHrp::from(net.btc()))
}

/// BIP380 descriptor checksum.
fn descriptor_checksum(desc: &str) -> Result<String> {
    const INPUT: &[u8] =
        b"0123456789()[],'/*abcdefgh@:$%{}IJKLMNOPQRSTUVWXYZ&+-.;<=>?!^_|~ijklmnopqrstuvwxyzABCDEFGH`#\"\\ ";
    const OUTPUT: &[u8] = b"qpzry9x8gf2tvdw0s3jn54khce6mua7l";
    const GENERATOR: [u64; 5] = [
        0xf5dee51989,
        0xa9fdca3312,
        0x1bab10e32d,
        0x3706b1677a,
        0x644d626ffd,
    ];
    fn step(c: u64, val: u64) -> u64 {
        let top = c >> 35;
        let mut next = ((c & 0x7_ffff_ffff) << 5) ^ val;
        for (i, g) in GENERATOR.iter().enumerate() {
            if (top >> i) & 1 == 1 {
                next ^= g;
            }
        }
        next
    }
    let mut c = 1u64;
    let mut group = 0u64;
    let mut count = 0;
    for byte in desc.bytes() {
        let pos = INPUT
            .iter()
            .position(|x| *x == byte)
            .ok_or_else(|| Error::input("descriptor: invalid character"))? as u64;
        c = step(c, pos & 31);
        group = group * 3 + (pos >> 5);
        count += 1;
        if count == 3 {
            c = step(c, group);
            group = 0;
            count = 0;
        }
    }
    if count > 0 {
        c = step(c, group);
    }
    for _ in 0..8 {
        c = step(c, 0);
    }
    c ^= 1;
    Ok((0..8)
        .map(|j| char::from(OUTPUT[((c >> (5 * (7 - j))) & 31) as usize]))
        .collect())
}

/// The address, script and descriptor of the lock of `t` on this seed and account.
pub fn btc_lock_info(seed: &Seed, net: Network, account: u32, t: u32) -> Result<BtcLockInfo> {
    let day = btc_lock_day(t)?;
    let secp = secp()?;
    let path = lock_path(net, account, day)?;
    let master = XprivGuard::master(seed, net.btc_kind())?;
    let fingerprint = master.fingerprint(&secp);
    let key = master.derive(&secp, &path)?;
    let pubkey = key.xpriv().private_key.public_key(&secp);
    let script = witness_script(pubkey, t);
    let address = p2wsh_address(net, &script);
    let origin = path_string(&path);
    let origin = origin.trim_start_matches("m/");
    let hex_key = hex::encode(pubkey.serialize());
    let bare = format!("wsh(and_v(v:pk([{fingerprint}/{origin}]{hex_key}),after({t})))");
    let checksum = descriptor_checksum(&bare)?;
    Ok(BtcLockInfo {
        t,
        day,
        account,
        path: path_string(&path),
        pubkey: hex_key,
        witness_script: hex::encode(script.as_bytes()),
        script_pubkey: hex::encode(address.script_pubkey().as_bytes()),
        address: address.to_string(),
        descriptor: format!("{bare}#{checksum}"),
    })
}

/// The grid from `from_day` to `to_day` included. Public derivation only.
pub fn btc_lock_addresses(
    seed: &Seed,
    net: Network,
    account: u32,
    from_day: u32,
    to_day: u32,
) -> Result<Vec<BtcLockAddress>> {
    let secp = secp()?;
    let (xpub, _, _) = account_xpub(&secp, seed, net, BtcKind::Segwit, account)?;
    let branch = xpub
        .derive_pub(&secp, &[normal(BTC_LOCK_BRANCH)?])
        .map_err(|_| Error::crypto("public derivation failed"))?;
    let mut out = Vec::new();
    for day in from_day..=to_day {
        let t = btc_lock_time_of_day(day).ok_or_else(|| Error::input("day out of range"))?;
        let child = branch
            .derive_pub(&secp, &[normal(day)?])
            .map_err(|_| Error::crypto("public derivation failed"))?;
        let address = p2wsh_address(net, &witness_script(child.public_key, t));
        out.push(BtcLockAddress {
            day,
            script_pubkey: hex::encode(address.script_pubkey().as_bytes()),
            address: address.to_string(),
        });
    }
    Ok(out)
}

/// Refuses a funding transaction that does not do exactly what the user approved: `amount_sats` to
/// the script **re-derived here from the seed and `t`**, only this wallet's coins in, and nothing
/// out but that and this wallet's change. Returns the plain summary for the native dialog.
pub fn btc_lock_check_funding(
    seed: &Seed,
    net: Network,
    account: u32,
    t: u32,
    amount_sats: u64,
    psbt_b64: &str,
) -> Result<BtcTxSummary> {
    if amount_sats < BTC_LOCK_MIN_SATS {
        return Err(Error::input("lock amount: at least 50,000 sats"));
    }
    btc_lock_new_day(t)?;
    let lock = btc_lock_info(seed, net, account, t)?;
    let expected = btc_script_pubkey(&lock.address, net)?;
    let psbt = parse_psbt(psbt_b64)?;
    let summary = btc_psbt_summary(seed, net, account, psbt_b64)?;
    if let Some(w) = summary
        .warnings
        .iter()
        .find(|w| !matches!(w, BtcWarning::HighFee { .. }))
    {
        return Err(Error::psbt(format!("lock funding: refused ({w:?})")));
    }
    let outputs = &psbt.unsigned_tx.output;
    let mut paid = 0usize;
    for (out, (_, _, is_change)) in outputs.iter().zip(&summary.outputs) {
        if out.script_pubkey == expected {
            if out.value.to_sat() != amount_sats {
                return Err(Error::psbt("lock funding: amount differs"));
            }
            paid += 1;
        } else if !is_change {
            return Err(Error::psbt("lock funding: pays someone else"));
        }
    }
    if paid != 1 {
        return Err(Error::psbt("lock funding: must pay the lock address once"));
    }
    Ok(summary)
}

/// [`btc_lock_check_funding`], then the normal signature.
pub fn btc_lock_sign_funding(
    seed: &Seed,
    net: Network,
    account: u32,
    t: u32,
    amount_sats: u64,
    psbt_b64: &str,
) -> Result<(String, BtcTxSummary)> {
    let checked = btc_lock_check_funding(seed, net, account, t, amount_sats, psbt_b64)?;
    let (signed, summary) = btc_sign_psbt(seed, net, account, psbt_b64)?;
    if summary != checked {
        return Err(Error::crypto("summary changed while signing"));
    }
    Ok((signed, summary))
}

fn outpoint(u: &BtcLockUtxo) -> Result<OutPoint> {
    Ok(OutPoint {
        txid: Txid::from_str(&u.txid).map_err(|_| Error::input("invalid txid"))?,
        vout: u.vout,
    })
}

/// Signature-free description of a withdrawal: what the native dialog shows and what
/// [`btc_lock_sign_plan`] signs afterwards. Nothing here needs a private key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BtcLockPlan {
    /// Unlock time of the lock.
    pub t: u32,
    /// BIP84 account of the lock and of the destination.
    pub account: u32,
    /// Coins spent, largest first.
    pub coins: Vec<BtcLockUtxo>,
    /// Receive index of the destination.
    pub destination_index: u32,
    /// The wallet's own address.
    pub destination: String,
    /// What the destination receives, sats.
    pub amount_sats: u64,
    /// Fee, sats.
    pub fee_sats: u64,
    /// Fee rate, sat/vB.
    pub sat_per_vb: u64,
    /// Virtual size the fee was computed on (never below the real one).
    pub vsize: u64,
    /// Coins left at the lock: worth less than their own input at this rate, or over
    /// [`BTC_LOCK_MAX_INPUTS`]. They stay withdrawable later.
    pub left_out: usize,
    /// Their total, sats.
    pub left_out_sats: u64,
}

fn witness_size(script_len: usize) -> u64 {
    // Items count, signature, witness script, each with its length byte.
    1 + 1 + MAX_SIG_LEN + 1 + script_len as u64
}

/// What one more input adds to the fee: outpoint, empty scriptSig, sequence, and the witness.
fn input_vsize(script_len: usize) -> u64 {
    (41 * 4 + witness_size(script_len)).div_ceil(4)
}

/// The plan, refused before the network would accept the spend.
#[allow(clippy::too_many_arguments)]
pub fn btc_lock_plan_withdraw(
    seed: &Seed,
    net: Network,
    account: u32,
    t: u32,
    utxos: &[BtcLockUtxo],
    destination_index: u32,
    sat_per_vb: u64,
    tip_mtp: u64,
) -> Result<BtcLockPlan> {
    if !btc_lock_is_open(t, tip_mtp) {
        return Err(Error::input("still locked: the network would refuse it"));
    }
    btc_lock_plan_unchecked(seed, net, account, t, utxos, destination_index, sat_per_vb)
}

/// Picks the coins and works out the fee for a spend to
/// `m/84'/coin'/account'/0/destination_index`, the only destination there is. A coin worth less
/// than its own input at this rate is left out, so a stranger's dust can neither make the
/// withdrawal fail nor cost more than it brings. Does not look at the time.
pub fn btc_lock_plan_unchecked(
    seed: &Seed,
    net: Network,
    account: u32,
    t: u32,
    utxos: &[BtcLockUtxo],
    destination_index: u32,
    sat_per_vb: u64,
) -> Result<BtcLockPlan> {
    if !(1..=BTC_LOCK_MAX_FEE_RATE).contains(&sat_per_vb) {
        return Err(Error::input("fee rate out of range"));
    }
    if utxos.is_empty() {
        return Err(Error::input("nothing to withdraw"));
    }
    let info = btc_lock_info(seed, net, account, t)?;
    let script_len = info.witness_script.len() / 2;
    let input_fee = input_vsize(script_len)
        .checked_mul(sat_per_vb)
        .ok_or_else(|| Error::input("fee overflow"))?;

    let mut all = utxos.to_vec();
    all.sort_by(|a, b| (&a.txid, a.vout).cmp(&(&b.txid, b.vout)));
    all.dedup_by(|a, b| a.txid == b.txid && a.vout == b.vout);
    all.sort_by(|a, b| {
        b.value
            .cmp(&a.value)
            .then_with(|| (&a.txid, a.vout).cmp(&(&b.txid, b.vout)))
    });
    let (mut coins, mut rest): (Vec<_>, Vec<_>) =
        all.into_iter().partition(|c| c.value > input_fee);
    if coins.len() > BTC_LOCK_MAX_INPUTS {
        rest.extend(coins.split_off(BTC_LOCK_MAX_INPUTS));
    }
    if coins.is_empty() {
        return Err(Error::input(
            "the fee would take the whole amount: pick a lower fee",
        ));
    }
    let left_out_sats = rest
        .iter()
        .try_fold(0u64, |s, c| s.checked_add(c.value))
        .ok_or_else(|| Error::input("amount overflow"))?;
    let total = coins
        .iter()
        .try_fold(0u64, |s, c| s.checked_add(c.value))
        .ok_or_else(|| Error::input("amount overflow"))?;

    let destination = btc_address(
        seed,
        net,
        BtcKind::Segwit,
        account,
        false,
        destination_index,
    )?;
    let tx = unsigned_spend(t, &coins, btc_script_pubkey(&destination, net)?, 0)?;
    let inputs = coins.len() as u64;
    let weight = (tx.base_size() as u64) * 4 + 2 + inputs * witness_size(script_len);
    let vsize = weight.div_ceil(4);
    let fee_sats = vsize
        .checked_mul(sat_per_vb)
        .ok_or_else(|| Error::input("fee overflow"))?;
    let amount_sats = total
        .checked_sub(fee_sats)
        .filter(|a| *a >= BTC_LOCK_MIN_OUTPUT_SATS)
        .ok_or_else(|| Error::input("the fee would take the whole amount: pick a lower fee"))?;
    Ok(BtcLockPlan {
        t,
        account,
        coins,
        destination_index,
        destination,
        amount_sats,
        fee_sats,
        sat_per_vb,
        vsize,
        left_out: rest.len(),
        left_out_sats,
    })
}

fn unsigned_spend(
    t: u32,
    coins: &[BtcLockUtxo],
    destination: ScriptBuf,
    amount_sats: u64,
) -> Result<Transaction> {
    let mut input = Vec::with_capacity(coins.len());
    for c in coins {
        input.push(TxIn {
            previous_output: outpoint(c)?,
            script_sig: ScriptBuf::new(),
            sequence: Sequence(BTC_LOCK_SEQUENCE),
            witness: Witness::new(),
        });
    }
    Ok(Transaction {
        version: Version::TWO,
        lock_time: LockTime::from_time(t).map_err(|_| Error::input("invalid lock time"))?,
        input,
        output: vec![TxOut {
            value: Amount::from_sat(amount_sats),
            script_pubkey: destination,
        }],
    })
}

/// Signs a plan the user has approved. The destination is derived again here.
pub fn btc_lock_sign_plan(seed: &Seed, net: Network, plan: &BtcLockPlan) -> Result<BtcLockSpend> {
    let day = btc_lock_day(plan.t)?;
    let destination = btc_address(
        seed,
        net,
        BtcKind::Segwit,
        plan.account,
        false,
        plan.destination_index,
    )?;
    if destination != plan.destination {
        return Err(Error::input("the destination is not this wallet's"));
    }
    let secp = secp()?;
    let path = lock_path(net, plan.account, day)?;
    let key = lock_key(seed, &secp, net, &path)?;
    let sk = &key.xpriv().private_key;
    let pubkey = sk.public_key(&secp);
    let script = witness_script(pubkey, plan.t);
    let mut tx = unsigned_spend(
        plan.t,
        &plan.coins,
        btc_script_pubkey(&destination, net)?,
        plan.amount_sats,
    )?;
    let mut witnesses = Vec::with_capacity(plan.coins.len());
    {
        let mut cache = SighashCache::new(&tx);
        for (i, c) in plan.coins.iter().enumerate() {
            let sighash = cache
                .p2wsh_signature_hash(i, &script, Amount::from_sat(c.value), EcdsaSighashType::All)
                .map_err(|_| Error::crypto("sighash failed"))?;
            let msg = Message::from_digest(sighash.to_byte_array());
            let signature = secp.sign_ecdsa(&msg, sk);
            secp.verify_ecdsa(&msg, &signature, &pubkey)
                .map_err(|_| Error::crypto("signature self-check failed"))?;
            let mut w = Witness::new();
            w.push_ecdsa_signature(&bitcoin::ecdsa::Signature {
                signature,
                sighash_type: EcdsaSighashType::All,
            });
            w.push(script.as_bytes());
            witnesses.push(w);
        }
    }
    for (txin, w) in tx.input.iter_mut().zip(witnesses) {
        txin.witness = w;
    }
    Ok(BtcLockSpend {
        hex: serialize_hex(&tx),
        txid: tx.compute_txid().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::btc::{btc_account, is_our_path};
    use crate::mnemonic::Mnemonic;
    use bitcoin::bip32::{DerivationPath, Fingerprint};
    use bitcoin::consensus::encode::deserialize_hex;
    use bitcoin::key::CompressedPublicKey;
    use bitcoin::psbt::Psbt;

    const PHRASE: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    /// 2027-03-14 00:00 UTC.
    const T: u32 = 1_804_982_400;
    /// 2026-11-05 00:00 UTC.
    const NOW: u64 = 1_793_836_800;
    const TXID: &str = "1111111111111111111111111111111111111111111111111111111111111111";
    const STRANGER: &str = "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx";

    fn seed() -> Seed {
        Mnemonic::parse(PHRASE).unwrap().to_seed("")
    }

    /// Frozen. If this test fails the code changed, not the test: coins already locked would no
    /// longer be found. Bitcoin Core produced the same addresses from the descriptors alone.
    #[test]
    fn frozen_vectors_never_change() {
        let main = btc_lock_info(&seed(), Network::Mainnet, 0, T).unwrap();
        assert_eq!(main.day, 20_891);
        assert_eq!(main.path, "m/84'/0'/0'/2/20891");
        assert_eq!(
            main.pubkey,
            "02b0c411138f37419cab5225f3f4735a9127e648b683c12846fc4d0de2d5002594"
        );
        assert_eq!(
            main.witness_script,
            "2102b0c411138f37419cab5225f3f4735a9127e648b683c12846fc4d0de2d5002594ad0480d8956bb1"
        );
        assert_eq!(
            main.address,
            "bc1qjv373cp7excz626d8s4p74yq6v2mydk4pe9a37ddn3l8g6xsngrq3x2nf8"
        );
        assert_eq!(main.descriptor, "wsh(and_v(v:pk([73c5da0a/84'/0'/0'/2/20891]02b0c411138f37419cab5225f3f4735a9127e648b683c12846fc4d0de2d5002594),after(1804982400)))#4vdnvyex");

        let test = btc_lock_info(&seed(), Network::Testnet, 0, T).unwrap();
        assert_eq!(test.path, "m/84'/1'/0'/2/20891");
        assert_eq!(
            test.pubkey,
            "02c83056a1c512181e6ce924bef1d772502d13d2f4a80a28a26f5f7a237ee87bae"
        );
        assert_eq!(
            test.witness_script,
            "2102c83056a1c512181e6ce924bef1d772502d13d2f4a80a28a26f5f7a237ee87baead0480d8956bb1"
        );
        assert_eq!(
            test.address,
            "tb1qufl0wuef6a7duuv3a4rvad6ynz0ungyp7fg0mdl2w7wz4hthsvsqdv4n3d"
        );
        assert_eq!(test.descriptor, "wsh(and_v(v:pk([73c5da0a/84'/1'/0'/2/20891]02c83056a1c512181e6ce924bef1d772502d13d2f4a80a28a26f5f7a237ee87bae),after(1804982400)))#48p4cp33");

        let acct1 = btc_lock_info(&seed(), Network::Mainnet, 1, T).unwrap();
        assert_eq!(acct1.path, "m/84'/0'/1'/2/20891");
        assert_eq!(
            acct1.address,
            "bc1qwndkjetplqyfqy4t4au220z5lsjvwh0anremetapyrtae2jdxq9ssde79t"
        );

        assert_eq!(BTC_LOCK_FIRST_DAY, 20_762);
        assert_eq!(BTC_LOCK_BRANCH, 2);
        assert_eq!(BTC_LOCK_MAX_DAYS_AHEAD, 3_653);
        assert_eq!(BTC_LOCK_SEQUENCE, 0xFFFF_FFFD);
    }

    /// BIP84's own test vector: the account the lock chain hangs from is the standard one.
    #[test]
    fn the_account_is_standard_bip84() {
        let a = btc_account(&seed(), Network::Mainnet, BtcKind::Segwit, 0).unwrap();
        assert_eq!(a.path, "m/84'/0'/0'");
        assert_eq!(a.fingerprint, "73c5da0a");
        assert_eq!(
            btc_address(&seed(), Network::Mainnet, BtcKind::Segwit, 0, false, 0).unwrap(),
            "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu"
        );
    }

    #[test]
    fn script_is_exactly_the_miniscript() {
        let info = btc_lock_info(&seed(), Network::Testnet, 0, T).unwrap();
        assert_eq!(
            info.witness_script,
            format!("21{}ad04{}b1", info.pubkey, hex::encode(T.to_le_bytes()))
        );
    }

    #[test]
    fn time_is_pushed_as_a_minimal_script_number() {
        let key = btc_lock_info(&seed(), Network::Testnet, 0, T)
            .unwrap()
            .pubkey;
        let k = PublicKey::from_str(&key).unwrap();
        let tail = |t: u32| hex::encode(&witness_script(k, t).as_bytes()[35..]);
        // Top bit clear: 4 bytes.
        assert_eq!(tail(T), format!("04{}b1", hex::encode(T.to_le_bytes())));
        // 2^31 and up: the top bit would read as a sign, so a fifth byte (CLTV reads up to five).
        let past = 2_147_558_400u32;
        assert_eq!(
            tail(past),
            format!("05{}00b1", hex::encode(past.to_le_bytes()))
        );
        let last = btc_lock_time_of_day(u32::MAX / BTC_LOCK_DAY_SECS).unwrap();
        assert_eq!(last, 4_294_944_000);
        assert_eq!(
            tail(last),
            format!("05{}00b1", hex::encode(last.to_le_bytes()))
        );
    }

    #[test]
    fn dates_that_are_not_a_day_or_not_a_time_are_refused() {
        assert_eq!(btc_lock_day(T).unwrap(), 20_891);
        assert!(btc_lock_day(T + 1).is_err());
        assert!(
            btc_lock_day(T - 3_600).is_err(),
            "local midnight is not UTC"
        );
        assert!(
            btc_lock_day(499_996_800).is_err(),
            "a midnight, but a height"
        );
        assert!(btc_lock_day(0).is_err());
        assert!(btc_lock_info(&seed(), Network::Mainnet, 0, 86_400).is_err());
        assert_eq!(btc_lock_day(500_083_200).unwrap(), 5_788);
    }

    #[test]
    fn day_to_time_never_overflows() {
        assert_eq!(btc_lock_time_of_day(20_891), Some(T));
        assert_eq!(btc_lock_time_of_day(49_710), Some(4_294_944_000));
        assert_eq!(btc_lock_time_of_day(49_711), None, "past 2106");
        assert_eq!(btc_lock_time_of_day(u32::MAX), None);
        assert_eq!(btc_lock_time_of_day(100), None, "a height");
        assert_eq!(btc_lock_last_day(NOW), 20_762 + 3_653 + 2);
    }

    #[test]
    fn window_runs_from_tomorrow_to_ten_years() {
        let day = |d: u32| d * BTC_LOCK_DAY_SECS;
        let today = 20_762;
        assert_eq!(u64::from(day(today)), NOW);
        assert!(
            btc_lock_check_window(day(today), NOW, NOW).is_err(),
            "today"
        );
        assert!(btc_lock_check_window(day(today + 1), NOW, NOW).is_ok());
        // One second before midnight UTC, tomorrow is one second away and still allowed.
        assert!(btc_lock_check_window(day(today + 1), NOW + 86_399, NOW + 86_399).is_ok());
        assert!(btc_lock_check_window(day(today + 1), NOW + 86_400, NOW + 86_400).is_err());
        assert!(btc_lock_check_window(day(today + 3_653), NOW, NOW).is_ok());
        assert!(btc_lock_check_window(day(today + 3_654), NOW, NOW).is_err());
        assert!(btc_lock_check_window(day(today) + 1, NOW, NOW).is_err());
        // The clock check.
        assert!(btc_lock_check_window(day(today + 5), NOW, NOW + 7_200).is_ok());
        assert!(btc_lock_check_window(day(today + 5), NOW, NOW + 7_201).is_err());
        assert!(btc_lock_check_window(day(today + 5), NOW + 7_201, NOW).is_err());
        // Each clock is held to the window: the later one for tomorrow, the earlier for 10 years.
        let late = NOW + 86_399;
        assert!(btc_lock_check_window(day(today + 1), late, late + 7_000).is_err());
        assert!(btc_lock_check_window(day(today + 3_654), late + 2, late - 7_000).is_err());
    }

    /// `after(n)` has no standard form from 2^31 up: such a date must never be funded.
    #[test]
    fn no_lock_past_what_a_descriptor_can_say() {
        let day = |d: u32| d * BTC_LOCK_DAY_SECS;
        let last = BTC_LOCK_LAST_DESCRIBABLE_DAY;
        assert_eq!(day(last), 2_147_472_000);
        assert!(day(last) < 1 << 31 && day(last + 1) > 1 << 31);
        assert_eq!(btc_lock_utc_date(day(last)), "2038-01-19");
        // Late 2030: ten years ahead would pass the limit.
        let clock = 1_920_000_000;
        assert!(btc_lock_check_window(day(last), clock, clock).is_ok());
        assert!(btc_lock_check_window(day(last + 1), clock, clock).is_err());
        assert_eq!(btc_lock_last_day(clock), last);
        // Today nothing changes.
        assert_eq!(btc_lock_last_day(NOW), 20_762 + 3_653 + 2);
        let psbt = funding(vec![(lock_spk(), 100_000, false)]);
        let refused =
            btc_lock_check_funding(&seed(), Network::Testnet, 0, day(last + 1), 100_000, &psbt);
        assert_eq!(
            refused.unwrap_err(),
            Error::input("lock date: at most 2038-01-19")
        );
    }

    #[test]
    fn open_only_strictly_past_the_date() {
        assert!(!btc_lock_is_open(T, u64::from(T) - 1));
        assert!(
            !btc_lock_is_open(T, u64::from(T)),
            "the network needs MTP above T"
        );
        assert!(btc_lock_is_open(T, u64::from(T) + 1));
    }

    #[test]
    fn utc_dates() {
        assert_eq!(btc_lock_utc_date(T), "2027-03-14");
        assert_eq!(btc_lock_utc_date(0), "1970-01-01");
        assert_eq!(btc_lock_utc_date(951_782_400), "2000-02-29");
        assert_eq!(btc_lock_utc_date(2_147_558_400), "2038-01-20");
        assert_eq!(
            btc_lock_utc_date(BTC_LOCK_FIRST_DAY * BTC_LOCK_DAY_SECS),
            "2026-11-05"
        );
    }

    #[test]
    fn descriptor_checksum_matches_bip380() {
        assert_eq!(descriptor_checksum("raw(deadbeef)").unwrap(), "89f8spxm");
        assert!(descriptor_checksum("raw(é)").is_err());
    }

    #[test]
    fn the_scan_finds_what_a_lock_derives() {
        for net in [Network::Mainnet, Network::Testnet] {
            for account in [0, 3] {
                let grid = btc_lock_addresses(&seed(), net, account, 20_890, 20_892).unwrap();
                assert_eq!(grid.len(), 3);
                let info = btc_lock_info(&seed(), net, account, T).unwrap();
                assert_eq!(grid[1].day, 20_891);
                assert_eq!(grid[1].address, info.address);
                assert_eq!(grid[1].script_pubkey, info.script_pubkey);
                assert_ne!(grid[0].address, grid[1].address);
            }
        }
        // A whole scan's worth, and a lock ten years out.
        let last = btc_lock_last_day(NOW);
        let grid =
            btc_lock_addresses(&seed(), Network::Mainnet, 0, BTC_LOCK_FIRST_DAY, last).unwrap();
        assert_eq!(grid.len() as u32, last - BTC_LOCK_FIRST_DAY + 1);
        let ten_years = (20_762 + 3_653) * BTC_LOCK_DAY_SECS;
        let far = btc_lock_info(&seed(), Network::Mainnet, 0, ten_years).unwrap();
        assert!(grid.iter().any(|g| g.address == far.address));
    }

    #[test]
    fn networks_accounts_and_seeds_never_share_a_lock() {
        let a = btc_lock_info(&seed(), Network::Mainnet, 0, T).unwrap();
        let b = btc_lock_info(&seed(), Network::Testnet, 0, T).unwrap();
        let c = btc_lock_info(&seed(), Network::Mainnet, 1, T).unwrap();
        let other = Mnemonic::parse(PHRASE).unwrap().to_seed("passphrase");
        let d = btc_lock_info(&other, Network::Mainnet, 0, T).unwrap();
        assert_ne!(a.pubkey, b.pubkey, "coin type");
        assert_ne!(a.pubkey, c.pubkey, "account");
        assert_ne!(a.pubkey, d.pubkey, "passphrase");
        assert!(a.address.starts_with("bc1q") && a.address.len() == 62);
        assert!(b.address.starts_with("tb1q") && b.address.len() == 62);
    }

    fn own_key(change: u32, index: u32) -> (PublicKey, DerivationPath) {
        let secp = secp().unwrap();
        let path = DerivationPath::from_str(&format!("m/84'/1'/0'/{change}/{index}")).unwrap();
        let key = lock_key(&seed(), &secp, Network::Testnet, path.as_ref()).unwrap();
        (key.xpriv().private_key.public_key(&secp), path)
    }

    fn origin() -> Fingerprint {
        Fingerprint::from_str("73c5da0a").unwrap()
    }

    fn p2wpkh(k: PublicKey) -> ScriptBuf {
        ScriptBuf::new_p2wpkh(&CompressedPublicKey(k).wpubkey_hash())
    }

    /// One own coin of 1,000,000 sats, paying `outs`; change outputs carry their key origin.
    fn funding(outs: Vec<(ScriptBuf, u64, bool)>) -> String {
        let (key, path) = own_key(0, 0);
        let tx = Transaction {
            version: Version::TWO,
            lock_time: LockTime::ZERO,
            input: vec![TxIn {
                previous_output: OutPoint {
                    txid: Txid::from_str(TXID).unwrap(),
                    vout: 0,
                },
                script_sig: ScriptBuf::new(),
                sequence: Sequence(BTC_LOCK_SEQUENCE),
                witness: Witness::new(),
            }],
            output: outs
                .iter()
                .map(|(s, v, _)| TxOut {
                    value: Amount::from_sat(*v),
                    script_pubkey: s.clone(),
                })
                .collect(),
        };
        let mut psbt = Psbt::from_unsigned_tx(tx).unwrap();
        psbt.inputs[0].witness_utxo = Some(TxOut {
            value: Amount::from_sat(1_000_000),
            script_pubkey: p2wpkh(key),
        });
        psbt.inputs[0]
            .bip32_derivation
            .insert(key, (origin(), path));
        for (i, (_, _, change)) in outs.iter().enumerate() {
            if *change {
                let (k, p) = own_key(1, 0);
                psbt.outputs[i].bip32_derivation.insert(k, (origin(), p));
            }
        }
        psbt.to_string()
    }

    fn spk_of(address: &str) -> ScriptBuf {
        btc_script_pubkey(address, Network::Testnet).unwrap()
    }

    fn lock_spk() -> ScriptBuf {
        spk_of(
            &btc_lock_info(&seed(), Network::Testnet, 0, T)
                .unwrap()
                .address,
        )
    }

    fn check(psbt: &str, amount: u64) -> Result<BtcTxSummary> {
        btc_lock_check_funding(&seed(), Network::Testnet, 0, T, amount, psbt)
    }

    #[test]
    fn funding_must_pay_exactly_the_rederived_script() {
        let change = p2wpkh(own_key(1, 0).0);
        let good = funding(vec![
            (lock_spk(), 100_000, false),
            (change.clone(), 899_000, true),
        ]);
        assert!(check(&good, 100_000).is_ok());
        let (signed, summary) =
            btc_lock_sign_funding(&seed(), Network::Testnet, 0, T, 100_000, &good).unwrap();
        assert_eq!(summary.fee_sats, 1_000);
        assert_eq!(parse_psbt(&signed).unwrap().inputs[0].partial_sigs.len(), 1);

        // The amount the user approved, not another.
        assert!(check(&good, 100_001).is_err());
        // Another date's address, another account's, or a stranger's.
        let t2 = T + BTC_LOCK_DAY_SECS;
        for wrong in [
            btc_lock_info(&seed(), Network::Testnet, 0, t2)
                .unwrap()
                .address,
            btc_lock_info(&seed(), Network::Testnet, 1, T)
                .unwrap()
                .address,
            STRANGER.to_owned(),
        ] {
            let psbt = funding(vec![
                (spk_of(&wrong), 100_000, false),
                (change.clone(), 899_000, true),
            ]);
            assert!(check(&psbt, 100_000).is_err(), "{wrong}");
        }
        // A third output leaving the wallet, even a small one.
        let extra = funding(vec![
            (lock_spk(), 100_000, false),
            (spk_of(STRANGER), 5_000, false),
        ]);
        assert!(check(&extra, 100_000).is_err());
        // Paying it twice, or not at all.
        let twice = funding(vec![
            (lock_spk(), 100_000, false),
            (lock_spk(), 100_000, false),
        ]);
        assert!(check(&twice, 100_000).is_err());
        let none = funding(vec![(change, 999_000, true)]);
        assert!(check(&none, 999_000).is_err());
    }

    #[test]
    fn too_small_a_lock_is_refused() {
        let at = funding(vec![(lock_spk(), 50_000, false)]);
        assert!(check(&at, 50_000).is_ok());
        let under = funding(vec![(lock_spk(), 49_999, false)]);
        assert!(check(&under, 49_999).is_err());
    }

    #[test]
    fn foreign_inputs_are_refused() {
        let good = funding(vec![(lock_spk(), 100_000, false)]);
        let mut psbt = parse_psbt(&good).unwrap();
        psbt.inputs[0].bip32_derivation.clear();
        assert!(check(&psbt.to_string(), 100_000).is_err());
    }

    fn coin(n: u8, value: u64) -> BtcLockUtxo {
        BtcLockUtxo {
            txid: format!("{n:02x}").repeat(32),
            vout: 0,
            value,
        }
    }

    fn plan(utxos: &[BtcLockUtxo], rate: u64) -> Result<BtcLockPlan> {
        btc_lock_plan_unchecked(&seed(), Network::Testnet, 0, T, utxos, 3, rate)
    }

    #[test]
    fn the_spend_has_the_fields_the_network_needs() {
        let p = plan(&[coin(1, 100_000), coin(2, 60_000)], 5).unwrap();
        let s = btc_lock_sign_plan(&seed(), Network::Testnet, &p).unwrap();
        let tx: Transaction = deserialize_hex(&s.hex).unwrap();
        assert_eq!(tx.lock_time.to_consensus_u32(), T);
        assert_eq!(tx.version, Version::TWO);
        assert_eq!(tx.input.len(), 2);
        let info = btc_lock_info(&seed(), Network::Testnet, 0, T).unwrap();
        for i in &tx.input {
            assert_eq!(i.sequence.0, 0xFFFF_FFFD);
            assert!(i.script_sig.is_empty());
            assert_eq!(i.witness.len(), 2);
            assert_eq!(hex::encode(i.witness.nth(1).unwrap()), info.witness_script);
            assert_eq!(
                *i.witness.nth(0).unwrap().last().unwrap(),
                0x01,
                "SIGHASH_ALL"
            );
        }
        assert_eq!(tx.output.len(), 1, "no second destination");
        assert_eq!(
            p.destination,
            btc_address(&seed(), Network::Testnet, BtcKind::Segwit, 0, false, 3).unwrap()
        );
        assert_eq!(tx.output[0].value.to_sat(), p.amount_sats);
        assert_eq!(p.amount_sats + p.fee_sats, 160_000);
        assert!(
            p.vsize >= tx.vsize() as u64,
            "the fee never falls under the rate"
        );
        assert!(p.vsize <= tx.vsize() as u64 + 2);
        assert_eq!(p.fee_sats, p.vsize * 5);
        assert_eq!(s.txid, tx.compute_txid().to_string());
    }

    #[test]
    fn no_withdrawal_before_the_network_allows_it() {
        let w = |mtp| {
            btc_lock_plan_withdraw(
                &seed(),
                Network::Testnet,
                0,
                T,
                &[coin(1, 100_000)],
                0,
                2,
                mtp,
            )
        };
        assert!(w(u64::from(T) - 1).is_err());
        assert!(w(u64::from(T)).is_err());
        assert!(w(u64::from(T) + 1).is_ok());
    }

    #[test]
    fn a_plan_for_another_destination_is_not_signed() {
        let mut p = plan(&[coin(1, 100_000)], 2).unwrap();
        p.destination = STRANGER.to_owned();
        assert!(btc_lock_sign_plan(&seed(), Network::Testnet, &p).is_err());
    }

    #[test]
    fn fees_that_eat_the_coins_are_refused() {
        let coins = [coin(1, 50_000)];
        let fine = plan(&coins, 1).unwrap();
        assert!(fine.amount_sats > 49_000);
        // Rate so high the fee passes the amount, or leaves only dust.
        assert!(plan(&coins, 1_000).is_err());
        let vsize = fine.vsize;
        let at_limit = (50_000 - BTC_LOCK_MIN_OUTPUT_SATS) / vsize;
        assert_eq!(
            plan(&coins, at_limit).unwrap().amount_sats,
            50_000 - at_limit * vsize
        );
        assert!(plan(&coins, at_limit + 1).is_err());
        assert!(plan(&coins, 0).is_err());
        assert!(plan(&coins, BTC_LOCK_MAX_FEE_RATE + 1).is_err());
        assert!(
            plan(&[coin(1, u64::MAX), coin(2, u64::MAX)], 1).is_err(),
            "overflow"
        );
        assert!(plan(&[], 1).is_err());
    }

    #[test]
    fn a_coin_listed_twice_counts_once() {
        let p = plan(&[coin(1, 100_000), coin(1, 100_000)], 1).unwrap();
        assert_eq!(p.coins.len(), 1);
        assert_eq!(p.amount_sats + p.fee_sats, 100_000);
    }

    #[test]
    fn a_flood_of_dust_stays_a_standard_transaction() {
        let mut coins: Vec<BtcLockUtxo> = (0..=250u8)
            .flat_map(|n| {
                [0, 1].map(|vout| BtcLockUtxo {
                    vout,
                    ..coin(n, 600)
                })
            })
            .collect();
        coins.push(coin(255, 100_000));
        let p = plan(&coins, 1).unwrap();
        assert_eq!(p.coins.len(), BTC_LOCK_MAX_INPUTS);
        assert_eq!(p.left_out, coins.len() - BTC_LOCK_MAX_INPUTS);
        let s = btc_lock_sign_plan(&seed(), Network::Testnet, &p).unwrap();
        let tx: Transaction = deserialize_hex(&s.hex).unwrap();
        assert!(tx.weight().to_wu() < 400_000);
        assert!(
            tx.input
                .iter()
                .any(|i| i.previous_output.txid.to_string() == "ff".repeat(32)),
            "the real coin is taken first"
        );
    }

    /// A stranger's dust must not make the withdrawal fail or cost more than it brings.
    #[test]
    fn dust_worth_less_than_its_input_is_left_out_and_stays_withdrawable() {
        let per_input = input_vsize(41);
        assert_eq!(per_input, 71);
        let dust: Vec<BtcLockUtxo> = (2..=40u8).map(|n| coin(n, 546)).collect();
        let mut coins = dust.clone();
        coins.push(coin(1, 100_000));

        // 20 sat/vB: an input costs 1,420 sats, a 546 sat coin is not worth spending.
        let p = plan(&coins, 20).unwrap();
        assert_eq!(p.coins, vec![coin(1, 100_000)]);
        assert_eq!(p.left_out, dust.len());
        assert_eq!(p.left_out_sats, 546 * dust.len() as u64);
        assert_eq!(p.vsize, plan(&[coin(1, 100_000)], 20).unwrap().vsize);

        // The rule's edge: worth exactly its input is not worth it, one sat more is.
        let edge = per_input * 20;
        assert_eq!(
            plan(&[coin(1, 100_000), coin(2, edge)], 20)
                .unwrap()
                .left_out,
            1
        );
        assert_eq!(
            plan(&[coin(1, 100_000), coin(2, edge + 1)], 20)
                .unwrap()
                .left_out,
            0
        );

        // At a low rate the same coins come along.
        let p = plan(&coins, 1).unwrap();
        assert_eq!((p.coins.len(), p.left_out), (coins.len(), 0));

        // Only dust at a high rate: refused in plain words, nothing lost.
        assert!(plan(&dust, 20).is_err());
        assert!(plan(&dust, 1).is_ok());
    }

    #[test]
    fn the_normal_signer_never_touches_the_lock_chain() {
        let path = DerivationPath::from_str("m/84'/1'/0'/2/20891").unwrap();
        assert!(!is_our_path(&path, 84, 1, 0));
    }
}
