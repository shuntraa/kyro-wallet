//! TRON: secp256k1 keys at `m/44'/195'/account'/0/0` (SLIP-44 coin type 195, the same path on
//! Nile, Shasta and mainnet; one address per account, Ledger Live's layout — account 0 is the
//! historical `m/44'/195'/0'/0/0`), `T…` addresses, and the protobuf `Transaction.raw` of the two
//! transactions Kyro sends: `TransferContract` (TRX) and `TriggerSmartContract` (TRC-20
//! `transfer(address,uint256)`).
//!
//! - Address: `base58check(0x41 || keccak256(uncompressed_pubkey[1..])[12..])` (Keccak from
//!   RustCrypto `sha3`, base58check = double-SHA-256 checksum from `bitcoin::base58`).
//! - Transaction id: `sha256(raw_data)`; signature: libsecp256k1 recoverable ECDSA over that id,
//!   65 bytes `r || s || v` with `v = 27 + recovery id` (TronWeb and Trezor; java-tron also
//!   accepts `v ∈ {0, 1}`, Trust Wallet's format, on input).
//!
//! Protobuf: neither `prost` nor generated `protobuf` code is in the tree, and only two wire
//! types and ~15 fields are needed, so the codec below is written by hand — with one rule that
//! makes it safe to decode untrusted bytes: **a raw transaction is accepted only if re-encoding
//! what was decoded gives back exactly the same bytes** (canonical field order, minimal varints,
//! no duplicate field — whose "last value wins" semantics could differ from java-tron's — no
//! unknown or ignored field). It is tested byte for byte against Trezor's firmware fixtures
//! and real Nile transactions. This is wire-format handling, not cryptography.

use bitcoin::hashes::{sha256, Hash};
use bitcoin::secp256k1::ecdsa::{RecoverableSignature, RecoveryId};
use bitcoin::secp256k1::{Message, PublicKey, Secp256k1};
use serde::{Deserialize, Serialize};
use sha3::{Digest, Keccak256};

use crate::display::sanitize_text;
use crate::error::{Error, Result};
use crate::keys::{hardened, normal, secp, XprivGuard};
use crate::mnemonic::Seed;

mod u256 {
    #![allow(clippy::all, missing_docs)]
    uint::construct_uint! {
        pub struct U256(4);
    }
}
use u256::U256;

/// Address prefix byte of every TRON network (mainnet, Nile, Shasta).
pub const TRON_ADDRESS_PREFIX: u8 = 0x41;
/// `transfer(address,uint256)` selector.
pub const TRC20_TRANSFER_SELECTOR: [u8; 4] = [0xa9, 0x05, 0x9c, 0xbb];

const TRANSFER_CONTRACT: u64 = 1;
const TRIGGER_SMART_CONTRACT: u64 = 31;
const TRANSFER_URL: &str = "type.googleapis.com/protocol.TransferContract";
const TRIGGER_URL: &str = "type.googleapis.com/protocol.TriggerSmartContract";
// Stake 2.0 and voting (java-tron `Tron.proto` ContractType / `*Contract.proto`).
const VOTE_WITNESS_CONTRACT: u64 = 4;
const WITHDRAW_BALANCE_CONTRACT: u64 = 13;
const FREEZE_V2_CONTRACT: u64 = 54;
const UNFREEZE_V2_CONTRACT: u64 = 55;
const WITHDRAW_EXPIRE_UNFREEZE_CONTRACT: u64 = 56;
const DELEGATE_RESOURCE_CONTRACT: u64 = 57;
const UNDELEGATE_RESOURCE_CONTRACT: u64 = 58;
const CANCEL_ALL_UNFREEZE_V2_CONTRACT: u64 = 59;
const VOTE_URL: &str = "type.googleapis.com/protocol.VoteWitnessContract";
const WITHDRAW_BALANCE_URL: &str = "type.googleapis.com/protocol.WithdrawBalanceContract";
const FREEZE_V2_URL: &str = "type.googleapis.com/protocol.FreezeBalanceV2Contract";
const UNFREEZE_V2_URL: &str = "type.googleapis.com/protocol.UnfreezeBalanceV2Contract";
const WITHDRAW_EXPIRE_URL: &str = "type.googleapis.com/protocol.WithdrawExpireUnfreezeContract";
const CANCEL_ALL_URL: &str = "type.googleapis.com/protocol.CancelAllUnfreezeV2Contract";
/// java-tron `MAX_VOTE_NUMBER`: at most 30 votes per `VoteWitnessContract`.
pub const TRON_MAX_VOTES: usize = 30;
/// Raw transactions larger than this are refused (a TRC-20 transfer is ~200 bytes).
const MAX_RAW: usize = 4096;

// ---------------------------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------------------------

fn path(account: u32, index: u32) -> Result<[bitcoin::bip32::ChildNumber; 5]> {
    Ok([
        hardened(44)?,
        hardened(195)?,
        hardened(account)?,
        normal(0)?,
        normal(index)?,
    ])
}

/// Path of the key of TRON account `account`: `m/44'/195'/account'/0/0`.
pub fn tron_path(account: u32) -> String {
    format!("m/44'/195'/{account}'/0/0")
}

fn address_bytes_of_pubkey(pk: &PublicKey) -> [u8; 21] {
    let uncompressed = pk.serialize_uncompressed();
    let hash = Keccak256::digest(&uncompressed[1..]);
    let mut out = [0u8; 21];
    out[0] = TRON_ADDRESS_PREFIX;
    out[1..].copy_from_slice(&hash[12..]);
    out
}

/// `T…` form of a 21-byte address.
pub fn tron_address_from_bytes(bytes: &[u8; 21]) -> String {
    bitcoin::base58::encode_check(bytes)
}

/// Parses a `T…` address (base58check, prefix 0x41, 21 bytes).
pub fn tron_address_bytes(address: &str) -> Result<[u8; 21]> {
    let raw = bitcoin::base58::decode_check(address.trim())
        .map_err(|_| Error::input("invalid TRON address"))?;
    let bytes: [u8; 21] = raw
        .try_into()
        .map_err(|_| Error::input("invalid TRON address"))?;
    if bytes[0] != TRON_ADDRESS_PREFIX {
        return Err(Error::input("invalid TRON address (prefix)"));
    }
    Ok(bytes)
}

/// `T…` address of a SEC1 public key (33 or 65 bytes).
pub fn tron_address_of_pubkey(sec1: &[u8]) -> Result<String> {
    let pk = PublicKey::from_slice(sec1).map_err(|_| Error::input("invalid public key"))?;
    Ok(tron_address_from_bytes(&address_bytes_of_pubkey(&pk)))
}

/// Address of account `account`: `m/44'/195'/account'/0/0` (see [`tron_path`]).
pub fn tron_address(seed: &Seed, account: u32) -> Result<String> {
    tron_address_at(seed, account, 0)
}

/// Address at `m/44'/195'/account'/0/index` (Kyro only uses `index` 0; other indices exist for
/// test vectors of other wallets).
pub fn tron_address_at(seed: &Seed, account: u32, index: u32) -> Result<String> {
    let secp = secp()?;
    let master = XprivGuard::master(seed, bitcoin::NetworkKind::Main)?;
    let key = master.derive(&secp, &path(account, index)?)?;
    let pk = key.xpriv().private_key.public_key(&secp);
    Ok(tron_address_from_bytes(&address_bytes_of_pubkey(&pk)))
}

// ---------------------------------------------------------------------------------------------
// Protobuf wire format (the subset used here)
// ---------------------------------------------------------------------------------------------

fn put_varint(out: &mut Vec<u8>, mut v: u64) {
    while v >= 0x80 {
        out.push((v as u8) | 0x80);
        v >>= 7;
    }
    out.push(v as u8);
}

fn put_key(out: &mut Vec<u8>, field: u64, wire: u64) {
    put_varint(out, (field << 3) | wire);
}

fn put_uint(out: &mut Vec<u8>, field: u64, v: u64) {
    if v != 0 {
        put_key(out, field, 0);
        put_varint(out, v);
    }
}

fn put_bytes(out: &mut Vec<u8>, field: u64, b: &[u8]) {
    if !b.is_empty() {
        put_key(out, field, 2);
        put_varint(out, b.len() as u64);
        out.extend_from_slice(b);
    }
}

enum Value<'a> {
    Varint(u64),
    Bytes(&'a [u8]),
}

/// Splits a message into `(field, value)` pairs, wire types 0 and 2 only.
fn fields(mut b: &[u8]) -> Result<Vec<(u64, Value<'_>)>> {
    fn varint(b: &mut &[u8]) -> Result<u64> {
        let mut v: u64 = 0;
        for i in 0..10 {
            let (&byte, rest) = b.split_first().ok_or_else(|| bad("truncated varint"))?;
            *b = rest;
            if i == 9 && byte > 1 {
                return Err(bad("varint overflow"));
            }
            v |= u64::from(byte & 0x7f) << (7 * i);
            if byte & 0x80 == 0 {
                return Ok(v);
            }
        }
        Err(bad("varint too long"))
    }
    let mut out = Vec::new();
    while !b.is_empty() {
        let key = varint(&mut b)?;
        let (field, wire) = (key >> 3, key & 7);
        match wire {
            0 => out.push((field, Value::Varint(varint(&mut b)?))),
            2 => {
                let len = usize::try_from(varint(&mut b)?).map_err(|_| bad("length"))?;
                if len > b.len() {
                    return Err(bad("truncated field"));
                }
                let (v, rest) = b.split_at(len);
                out.push((field, Value::Bytes(v)));
                b = rest;
            }
            _ => return Err(bad(format!("wire type {wire} not supported"))),
        }
    }
    Ok(out)
}

fn bad(msg: impl Into<String>) -> Error {
    Error::input(format!("TRON transaction: {}", msg.into()))
}

fn as_bytes<'a>(v: &Value<'a>, what: &str) -> Result<&'a [u8]> {
    match v {
        Value::Bytes(b) => Ok(b),
        Value::Varint(_) => Err(bad(format!("{what}: bytes expected"))),
    }
}

fn as_i64(v: &Value<'_>, what: &str) -> Result<i64> {
    match v {
        // Negative int64 would be a 10-byte varint above i64::MAX: refused.
        Value::Varint(n) => i64::try_from(*n).map_err(|_| bad(format!("{what}: negative"))),
        Value::Bytes(_) => Err(bad(format!("{what}: integer expected"))),
    }
}

fn addr21(b: &[u8], what: &str) -> Result<[u8; 21]> {
    let a: [u8; 21] = b
        .try_into()
        .map_err(|_| bad(format!("{what}: 21-byte address expected")))?;
    if a[0] != TRON_ADDRESS_PREFIX {
        return Err(bad(format!("{what}: address prefix")));
    }
    Ok(a)
}

// ---------------------------------------------------------------------------------------------
// Transaction.raw
// ---------------------------------------------------------------------------------------------

/// Resource a Stake 2.0 freeze / unfreeze applies to (`ResourceCode`; `TRON_POWER` is refused).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TronResource {
    /// `BANDWIDTH` (0, the protobuf default: field omitted).
    Bandwidth,
    /// `ENERGY` (1).
    Energy,
}

impl TronResource {
    fn code(self) -> u64 {
        match self {
            TronResource::Bandwidth => 0,
            TronResource::Energy => 1,
        }
    }
}

/// The single contract of a transaction Kyro accepts. Transfers and contract calls go through
/// [`tron_decode_raw`]; the Stake 2.0 / voting variants only through [`tron_decode_stake_raw`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TronContract {
    /// `FreezeBalanceV2Contract` (54): stakes `amount` sun for `resource`.
    FreezeV2 {
        /// Staker.
        owner: [u8; 21],
        /// Sun.
        amount: i64,
        /// Bandwidth or energy.
        resource: TronResource,
    },
    /// `UnfreezeBalanceV2Contract` (55): starts unstaking `amount` sun of `resource`.
    UnfreezeV2 {
        /// Staker.
        owner: [u8; 21],
        /// Sun.
        amount: i64,
        /// Bandwidth or energy.
        resource: TronResource,
    },
    /// `WithdrawExpireUnfreezeContract` (56): claims the unstaked TRX whose wait has ended.
    WithdrawExpireUnfreeze {
        /// Staker.
        owner: [u8; 21],
    },
    /// `CancelAllUnfreezeV2Contract` (59): cancels every pending unstake (re-stakes it; what is
    /// already claimable is withdrawn).
    CancelAllUnfreezeV2 {
        /// Staker.
        owner: [u8; 21],
    },
    /// `VoteWitnessContract` (4): replaces all our votes by these `(SR, TRON Power)` pairs.
    VoteWitness {
        /// Voter.
        owner: [u8; 21],
        /// `(super representative, votes)`, 1 to 30 entries.
        votes: Vec<([u8; 21], i64)>,
    },
    /// `WithdrawBalanceContract` (13): claims the voting rewards.
    WithdrawBalance {
        /// Voter.
        owner: [u8; 21],
    },
    /// `TransferContract` (type 1): TRX.
    Transfer {
        /// Sender.
        owner: [u8; 21],
        /// Recipient.
        to: [u8; 21],
        /// Sun (1 TRX = 1 000 000 sun).
        amount: i64,
    },
    /// `TriggerSmartContract` (type 31), without TRC-10 token value.
    Trigger {
        /// Caller.
        owner: [u8; 21],
        /// Contract called.
        contract: [u8; 21],
        /// TRX sent along (sun).
        call_value: i64,
        /// ABI call data.
        data: Vec<u8>,
    },
}

/// `Transaction.raw`, restricted to the fields Kyro understands.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TronRaw {
    /// Bytes 6..8 of the reference block number (big endian).
    pub ref_block_bytes: [u8; 2],
    /// Bytes 8..16 of the reference block id.
    pub ref_block_hash: [u8; 8],
    /// Milliseconds since the epoch.
    pub expiration: i64,
    /// Memo (`data`), empty if none.
    pub memo: Vec<u8>,
    /// Exactly one contract.
    pub contract: TronContract,
    /// Milliseconds since the epoch (0 = absent).
    pub timestamp: i64,
    /// Maximum TRX burned for energy, sun (0 = absent).
    pub fee_limit: i64,
}

impl TronRaw {
    /// Canonical protobuf encoding (field order, defaults omitted), as java-tron and TronWeb
    /// produce it.
    pub fn encode(&self) -> Vec<u8> {
        let (ty, url, param) = match &self.contract {
            TronContract::Transfer { owner, to, amount } => {
                let mut p = Vec::new();
                put_bytes(&mut p, 1, owner);
                put_bytes(&mut p, 2, to);
                put_uint(&mut p, 3, *amount as u64);
                (TRANSFER_CONTRACT, TRANSFER_URL, p)
            }
            TronContract::Trigger {
                owner,
                contract,
                call_value,
                data,
            } => {
                let mut p = Vec::new();
                put_bytes(&mut p, 1, owner);
                put_bytes(&mut p, 2, contract);
                put_uint(&mut p, 3, *call_value as u64);
                put_bytes(&mut p, 4, data);
                (TRIGGER_SMART_CONTRACT, TRIGGER_URL, p)
            }
            TronContract::FreezeV2 {
                owner,
                amount,
                resource,
            }
            | TronContract::UnfreezeV2 {
                owner,
                amount,
                resource,
            } => {
                let mut p = Vec::new();
                put_bytes(&mut p, 1, owner);
                put_uint(&mut p, 2, *amount as u64);
                put_uint(&mut p, 3, resource.code());
                if matches!(self.contract, TronContract::FreezeV2 { .. }) {
                    (FREEZE_V2_CONTRACT, FREEZE_V2_URL, p)
                } else {
                    (UNFREEZE_V2_CONTRACT, UNFREEZE_V2_URL, p)
                }
            }
            TronContract::WithdrawExpireUnfreeze { owner } => {
                let mut p = Vec::new();
                put_bytes(&mut p, 1, owner);
                (WITHDRAW_EXPIRE_UNFREEZE_CONTRACT, WITHDRAW_EXPIRE_URL, p)
            }
            TronContract::CancelAllUnfreezeV2 { owner } => {
                let mut p = Vec::new();
                put_bytes(&mut p, 1, owner);
                (CANCEL_ALL_UNFREEZE_V2_CONTRACT, CANCEL_ALL_URL, p)
            }
            TronContract::WithdrawBalance { owner } => {
                let mut p = Vec::new();
                put_bytes(&mut p, 1, owner);
                (WITHDRAW_BALANCE_CONTRACT, WITHDRAW_BALANCE_URL, p)
            }
            TronContract::VoteWitness { owner, votes } => {
                let mut p = Vec::new();
                put_bytes(&mut p, 1, owner);
                for (sr, count) in votes {
                    let mut v = Vec::new();
                    put_bytes(&mut v, 1, sr);
                    put_uint(&mut v, 2, *count as u64);
                    // A vote is always written, even if empty (repeated message field).
                    put_key(&mut p, 2, 2);
                    put_varint(&mut p, v.len() as u64);
                    p.extend_from_slice(&v);
                }
                (VOTE_WITNESS_CONTRACT, VOTE_URL, p)
            }
        };
        let mut any = Vec::new();
        put_bytes(&mut any, 1, url.as_bytes());
        put_bytes(&mut any, 2, &param);
        let mut contract = Vec::new();
        put_uint(&mut contract, 1, ty);
        put_bytes(&mut contract, 2, &any);
        let mut out = Vec::new();
        put_bytes(&mut out, 1, &self.ref_block_bytes);
        put_bytes(&mut out, 4, &self.ref_block_hash);
        put_uint(&mut out, 8, self.expiration as u64);
        put_bytes(&mut out, 10, &self.memo);
        put_bytes(&mut out, 11, &contract);
        put_uint(&mut out, 14, self.timestamp as u64);
        put_uint(&mut out, 18, self.fee_limit as u64);
        out
    }

    /// Strict decoding: refuses unknown or unsupported fields (`ref_block_num`, `auths`,
    /// `scripts`, `provider`, `ContractName`, `Permission_id`, TRC-10 token value), any
    /// contract type other than TRX transfer / smart-contract call, more or fewer than one
    /// contract, negative integers, and any encoding that does not re-encode identically.
    pub fn decode(raw: &[u8]) -> Result<TronRaw> {
        if raw.len() > MAX_RAW {
            return Err(bad("too large"));
        }
        let mut ref_block_bytes = None;
        let mut ref_block_hash = None;
        let mut expiration = 0;
        let mut memo = Vec::new();
        let mut contracts = Vec::new();
        let mut timestamp = 0;
        let mut fee_limit = 0;
        for (f, v) in fields(raw)? {
            match f {
                1 => {
                    ref_block_bytes = Some(
                        <[u8; 2]>::try_from(as_bytes(&v, "ref_block_bytes")?)
                            .map_err(|_| bad("ref_block_bytes: 2 bytes"))?,
                    )
                }
                4 => {
                    ref_block_hash = Some(
                        <[u8; 8]>::try_from(as_bytes(&v, "ref_block_hash")?)
                            .map_err(|_| bad("ref_block_hash: 8 bytes"))?,
                    )
                }
                8 => expiration = as_i64(&v, "expiration")?,
                10 => memo = as_bytes(&v, "data")?.to_vec(),
                11 => contracts.push(decode_contract(as_bytes(&v, "contract")?)?),
                14 => timestamp = as_i64(&v, "timestamp")?,
                18 => fee_limit = as_i64(&v, "fee_limit")?,
                3 => return Err(bad("ref_block_num is not supported")),
                9 => return Err(bad("auths is not supported")),
                12 => return Err(bad("scripts is not supported")),
                other => return Err(bad(format!("unknown field {other}"))),
            }
        }
        if contracts.len() != 1 {
            return Err(bad("a single contract expected"));
        }
        let decoded = TronRaw {
            ref_block_bytes: ref_block_bytes.ok_or_else(|| bad("missing ref_block_bytes"))?,
            ref_block_hash: ref_block_hash.ok_or_else(|| bad("missing ref_block_hash"))?,
            expiration,
            memo,
            contract: contracts.remove(0),
            timestamp,
            fee_limit,
        };
        if expiration <= 0 {
            return Err(bad("missing expiration"));
        }
        if decoded.encode() != raw {
            return Err(bad(
                "non-canonical encoding (order, duplicate or non-minimal field)",
            ));
        }
        Ok(decoded)
    }

    /// Transaction id: `sha256(raw)`.
    pub fn txid(&self) -> [u8; 32] {
        sha256::Hash::hash(&self.encode()).to_byte_array()
    }

    /// The account that signs.
    pub fn owner(&self) -> &[u8; 21] {
        match &self.contract {
            TronContract::Transfer { owner, .. }
            | TronContract::Trigger { owner, .. }
            | TronContract::FreezeV2 { owner, .. }
            | TronContract::UnfreezeV2 { owner, .. }
            | TronContract::WithdrawExpireUnfreeze { owner }
            | TronContract::CancelAllUnfreezeV2 { owner }
            | TronContract::VoteWitness { owner, .. }
            | TronContract::WithdrawBalance { owner } => owner,
        }
    }

    /// A Stake 2.0 / voting contract (handled by [`tron_decode_stake_raw`] only).
    pub fn is_staking(&self) -> bool {
        !matches!(
            self.contract,
            TronContract::Transfer { .. } | TronContract::Trigger { .. }
        )
    }
}

/// `owner_address`-only contracts (56, 59, 13).
fn owner_only(value: &[u8], name: &str) -> Result<[u8; 21]> {
    let mut owner = None;
    for (f, v) in fields(value)? {
        match f {
            1 => owner = Some(addr21(as_bytes(&v, "owner_address")?, "owner_address")?),
            other => return Err(bad(format!("unknown {name} field {other}"))),
        }
    }
    owner.ok_or_else(|| bad("missing owner_address"))
}

/// Freeze / unfreeze V2: `owner_address = 1`, `frozen_balance` / `unfreeze_balance = 2`,
/// `resource = 3` (BANDWIDTH = 0 omitted, ENERGY = 1; TRON_POWER = 2 refused).
fn freeze_fields(value: &[u8], name: &str) -> Result<([u8; 21], i64, TronResource)> {
    let (mut owner, mut amount, mut resource) = (None, 0, TronResource::Bandwidth);
    for (f, v) in fields(value)? {
        match f {
            1 => owner = Some(addr21(as_bytes(&v, "owner_address")?, "owner_address")?),
            2 => amount = as_i64(&v, "amount")?,
            3 => {
                resource = match v {
                    Value::Varint(0) => TronResource::Bandwidth,
                    Value::Varint(1) => TronResource::Energy,
                    Value::Varint(2) => {
                        return Err(bad(
                            "TRON_POWER resource: refused (only BANDWIDTH and ENERGY)",
                        ))
                    }
                    _ => return Err(bad("unknown resource")),
                }
            }
            other => return Err(bad(format!("unknown {name} field {other}"))),
        }
    }
    Ok((
        owner.ok_or_else(|| bad("missing owner_address"))?,
        amount,
        resource,
    ))
}

fn check_url(url: &[u8], want: &str, name: &str) -> Result<()> {
    if url != want.as_bytes() {
        return Err(bad(format!("type_url does not match {name}")));
    }
    Ok(())
}

fn decode_contract(b: &[u8]) -> Result<TronContract> {
    let mut ty = 0;
    let mut param = None;
    for (f, v) in fields(b)? {
        match f {
            1 => match v {
                Value::Varint(t) => ty = t,
                Value::Bytes(_) => return Err(bad("contract type")),
            },
            2 => param = Some(as_bytes(&v, "parameter")?),
            5 => return Err(bad("Permission_id is not supported (multi-signature)")),
            3 | 4 => return Err(bad("provider / ContractName are not supported")),
            other => return Err(bad(format!("unknown contract field {other}"))),
        }
    }
    let any = param.ok_or_else(|| bad("missing parameter"))?;
    let mut url = None;
    let mut value = None;
    for (f, v) in fields(any)? {
        match f {
            1 => url = Some(as_bytes(&v, "type_url")?),
            2 => value = Some(as_bytes(&v, "value")?),
            other => return Err(bad(format!("unknown Any field {other}"))),
        }
    }
    let url = url.ok_or_else(|| bad("missing type_url"))?;
    let value = value.unwrap_or_default();
    match ty {
        TRANSFER_CONTRACT => {
            if url != TRANSFER_URL.as_bytes() {
                return Err(bad("type_url does not match TransferContract"));
            }
            let (mut owner, mut to, mut amount) = (None, None, 0);
            for (f, v) in fields(value)? {
                match f {
                    1 => owner = Some(addr21(as_bytes(&v, "owner_address")?, "owner_address")?),
                    2 => to = Some(addr21(as_bytes(&v, "to_address")?, "to_address")?),
                    3 => amount = as_i64(&v, "amount")?,
                    other => return Err(bad(format!("unknown TransferContract field {other}"))),
                }
            }
            Ok(TronContract::Transfer {
                owner: owner.ok_or_else(|| bad("missing owner_address"))?,
                to: to.ok_or_else(|| bad("missing to_address"))?,
                amount,
            })
        }
        TRIGGER_SMART_CONTRACT => {
            if url != TRIGGER_URL.as_bytes() {
                return Err(bad("type_url does not match TriggerSmartContract"));
            }
            let (mut owner, mut contract, mut call_value, mut data) = (None, None, 0, Vec::new());
            for (f, v) in fields(value)? {
                match f {
                    1 => owner = Some(addr21(as_bytes(&v, "owner_address")?, "owner_address")?),
                    2 => {
                        contract = Some(addr21(
                            as_bytes(&v, "contract_address")?,
                            "contract_address",
                        )?)
                    }
                    3 => call_value = as_i64(&v, "call_value")?,
                    4 => data = as_bytes(&v, "data")?.to_vec(),
                    5 | 6 => return Err(bad("TRC-10 token value is not supported")),
                    other => {
                        return Err(bad(format!("unknown TriggerSmartContract field {other}")))
                    }
                }
            }
            Ok(TronContract::Trigger {
                owner: owner.ok_or_else(|| bad("missing owner_address"))?,
                contract: contract.ok_or_else(|| bad("missing contract_address"))?,
                call_value,
                data,
            })
        }
        FREEZE_V2_CONTRACT => {
            check_url(url, FREEZE_V2_URL, "FreezeBalanceV2Contract")?;
            let (owner, amount, resource) = freeze_fields(value, "FreezeBalanceV2Contract")?;
            Ok(TronContract::FreezeV2 {
                owner,
                amount,
                resource,
            })
        }
        UNFREEZE_V2_CONTRACT => {
            check_url(url, UNFREEZE_V2_URL, "UnfreezeBalanceV2Contract")?;
            let (owner, amount, resource) = freeze_fields(value, "UnfreezeBalanceV2Contract")?;
            Ok(TronContract::UnfreezeV2 {
                owner,
                amount,
                resource,
            })
        }
        WITHDRAW_EXPIRE_UNFREEZE_CONTRACT => {
            check_url(url, WITHDRAW_EXPIRE_URL, "WithdrawExpireUnfreezeContract")?;
            Ok(TronContract::WithdrawExpireUnfreeze {
                owner: owner_only(value, "WithdrawExpireUnfreezeContract")?,
            })
        }
        CANCEL_ALL_UNFREEZE_V2_CONTRACT => {
            check_url(url, CANCEL_ALL_URL, "CancelAllUnfreezeV2Contract")?;
            Ok(TronContract::CancelAllUnfreezeV2 {
                owner: owner_only(value, "CancelAllUnfreezeV2Contract")?,
            })
        }
        WITHDRAW_BALANCE_CONTRACT => {
            check_url(url, WITHDRAW_BALANCE_URL, "WithdrawBalanceContract")?;
            Ok(TronContract::WithdrawBalance {
                owner: owner_only(value, "WithdrawBalanceContract")?,
            })
        }
        VOTE_WITNESS_CONTRACT => {
            check_url(url, VOTE_URL, "VoteWitnessContract")?;
            let (mut owner, mut votes) = (None, Vec::new());
            for (f, v) in fields(value)? {
                match f {
                    1 => owner = Some(addr21(as_bytes(&v, "owner_address")?, "owner_address")?),
                    2 => {
                        let (mut sr, mut count) = (None, 0);
                        for (g, w) in fields(as_bytes(&v, "vote")?)? {
                            match g {
                                1 => {
                                    sr =
                                        Some(addr21(as_bytes(&w, "vote_address")?, "vote_address")?)
                                }
                                2 => count = as_i64(&w, "vote_count")?,
                                other => return Err(bad(format!("unknown Vote field {other}"))),
                            }
                        }
                        votes.push((sr.ok_or_else(|| bad("missing vote_address"))?, count));
                    }
                    3 => return Err(bad("\"support\" field (obsolete): refused")),
                    other => return Err(bad(format!("unknown VoteWitnessContract field {other}"))),
                }
            }
            Ok(TronContract::VoteWitness {
                owner: owner.ok_or_else(|| bad("missing owner_address"))?,
                votes,
            })
        }
        DELEGATE_RESOURCE_CONTRACT | UNDELEGATE_RESOURCE_CONTRACT => Err(bad(
            "resource delegation (DelegateResource / UnDelegateResource): refused",
        )),
        other => Err(bad(format!(
            "contract type {other} is not supported (TRX / TRC-20 transfers and Stake 2.0 only)"
        ))),
    }
}

/// Reference block fields from the block Kyro builds on: `ref_block_bytes` = bytes 6..8 of the
/// 8-byte big-endian block number, `ref_block_hash` = bytes 8..16 of the block id. Checks that
/// the block id starts with the block number (as every TRON block id does).
pub fn tron_ref_block(number: u64, block_id_hex: &str) -> Result<([u8; 2], [u8; 8])> {
    let id: [u8; 32] = hex::decode(block_id_hex.trim())
        .ok()
        .and_then(|v| v.try_into().ok())
        .ok_or_else(|| Error::input("block id: 32 hex bytes expected"))?;
    if id[..8] != number.to_be_bytes() {
        return Err(Error::input("the block id does not match the block number"));
    }
    let n = number.to_be_bytes();
    let mut hash = [0u8; 8];
    hash.copy_from_slice(&id[8..16]);
    Ok(([n[6], n[7]], hash))
}

/// ABI call data of `transfer(to, amount)`; `amount` is a decimal string (uint256).
pub fn tron_trc20_transfer_data(to: &str, amount: &str) -> Result<Vec<u8>> {
    let to = tron_address_bytes(to)?;
    let amount = U256::from_dec_str(amount.trim()).map_err(|_| Error::input("invalid amount"))?;
    let mut data = Vec::with_capacity(68);
    data.extend_from_slice(&TRC20_TRANSFER_SELECTOR);
    data.extend_from_slice(&[0u8; 12]);
    data.extend_from_slice(&to[1..]);
    data.extend_from_slice(&amount.to_big_endian());
    Ok(data)
}

// ---------------------------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------------------------

/// What the transaction does, as decoded by Rust.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TronAction {
    /// TRX transfer.
    TrxTransfer {
        /// Recipient (`T…`).
        to: String,
        /// Sun, decimal string.
        amount: String,
    },
    /// TRC-20 `transfer(address,uint256)`.
    Trc20Transfer {
        /// Token contract (`T…`).
        contract: String,
        /// Token recipient (`T…`).
        to: String,
        /// Raw token units, decimal string.
        amount: String,
        /// TRX sent to the contract along with the call (sun), normally 0.
        call_value: String,
    },
    /// Any other smart-contract call: shown raw, reinforced confirmation.
    ContractCall {
        /// Contract (`T…`).
        contract: String,
        /// First 4 bytes of the call data, hex (empty if shorter).
        selector: String,
        /// Full call data, hex.
        data: String,
        /// TRX sent (sun).
        call_value: String,
    },
}

/// Reasons for caution.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TronWarning {
    /// Smart-contract call that is not a TRC-20 transfer (approve, swap, unknown...).
    UnknownCall {
        /// Selector, hex.
        selector: String,
    },
    /// TRX sent to a contract along with the call.
    CallValue,
    /// The transaction carries a memo (on mainnet a memo costs extra TRX).
    Memo,
    /// `fee_limit` above 100 TRX.
    HighFeeLimit,
    /// The memo text had control / invisible / bidi characters removed or was cut: the dialog
    /// shows a cleaned version (`memo`, hex, is exact).
    UnusualText,
}

/// Plain-language summary of a raw TRON transaction.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TronTxSummary {
    /// `sha256(raw_data)`, hex.
    pub txid: String,
    /// Signer (`T…`), always our address (checked).
    pub owner: String,
    /// What it does.
    pub action: TronAction,
    /// Maximum TRX burned for energy, sun, decimal string (`"0"` if absent).
    pub fee_limit: String,
    /// Milliseconds since the epoch.
    pub expiration: i64,
    /// Milliseconds since the epoch (0 if absent).
    pub timestamp: i64,
    /// Hex.
    pub ref_block_bytes: String,
    /// Hex.
    pub ref_block_hash: String,
    /// Memo bytes, hex (empty if none).
    pub memo: String,
    /// Memo as text when it is valid UTF-8, cleaned for display ([`crate::sanitize_text`]).
    pub memo_text: Option<String>,
    /// Size of `raw_data`, bytes.
    pub raw_size: usize,
    /// Reasons for caution.
    pub warnings: Vec<TronWarning>,
    /// The confirmation must be followed by a reinforced one.
    pub requires_extra_confirmation: bool,
}

const HIGH_FEE_LIMIT: i64 = 100_000_000;
/// Longest memo text shown in the dialog (characters).
const MAX_MEMO_TEXT: usize = 256;
/// java-tron refuses an expiration more than 24 h after the head block; Kyro refuses to sign one
/// more than 24 h after its own clock, whatever the caller says.
pub const TRON_MAX_EXPIRATION_MS: i64 = 24 * 60 * 60 * 1000;

/// Current time in ms since the epoch (system clock). A clock before 1970 fails closed.
fn now_ms() -> Result<i64> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|d| i64::try_from(d.as_millis()).ok())
        .ok_or_else(|| Error::input("invalid system clock"))
}

/// Refuses an expiration more than [`TRON_MAX_EXPIRATION_MS`] after `now` (ms). An expiration
/// in the past is left to the caller (java-tron refuses it at broadcast).
fn check_expiration_at(expiration: i64, now: i64) -> Result<()> {
    if expiration > now.saturating_add(TRON_MAX_EXPIRATION_MS) {
        return Err(bad("expiration more than 24 h away: refused"));
    }
    Ok(())
}

/// Decodes `raw` (hex `raw_data`) for the confirmation dialog. Refused: anything
/// [`TronRaw::decode`] refuses, an owner other than `our_address` and an expiration more than
/// 24 h ahead of the system clock.
pub fn tron_decode_raw(raw_hex: &str, our_address: &str) -> Result<TronTxSummary> {
    tron_decode_raw_at(raw_hex, our_address, now_ms()?)
}

fn tron_decode_raw_at(raw_hex: &str, our_address: &str, now: i64) -> Result<TronTxSummary> {
    let raw =
        hex::decode(raw_hex.trim()).map_err(|_| Error::input("raw_data is not hexadecimal"))?;
    let tx = TronRaw::decode(&raw)?;
    check_expiration_at(tx.expiration, now)?;
    let ours = tron_address_bytes(our_address)?;
    if *tx.owner() != ours {
        return Err(bad("the owner is not this wallet's address"));
    }
    let mut warnings = Vec::new();
    let action = match &tx.contract {
        TronContract::Transfer { to, amount, .. } => {
            if *amount <= 0 {
                return Err(bad("the amount must be positive"));
            }
            if to == tx.owner() {
                return Err(bad("TRON refuses a transfer to yourself"));
            }
            TronAction::TrxTransfer {
                to: tron_address_from_bytes(to),
                amount: amount.to_string(),
            }
        }
        TronContract::Trigger {
            contract,
            call_value,
            data,
            ..
        } => {
            if *call_value > 0 {
                warnings.push(TronWarning::CallValue);
            }
            let is_transfer = data.len() == 68
                && data[..4] == TRC20_TRANSFER_SELECTOR
                && data[4..16].iter().all(|b| *b == 0);
            if is_transfer {
                let mut to = [0u8; 21];
                to[0] = TRON_ADDRESS_PREFIX;
                to[1..].copy_from_slice(&data[16..36]);
                TronAction::Trc20Transfer {
                    contract: tron_address_from_bytes(contract),
                    to: tron_address_from_bytes(&to),
                    amount: U256::from_big_endian(&data[36..68]).to_string(),
                    call_value: call_value.to_string(),
                }
            } else {
                let selector = hex::encode(&data[..data.len().min(4)]);
                warnings.push(TronWarning::UnknownCall {
                    selector: selector.clone(),
                });
                TronAction::ContractCall {
                    contract: tron_address_from_bytes(contract),
                    selector,
                    data: hex::encode(data),
                    call_value: call_value.to_string(),
                }
            }
        }
        _ => {
            return Err(bad(
                "staking contract (freeze, unfreeze, vote, rewards): refused here, it goes through tron_stake_sign",
            ))
        }
    };
    if !tx.memo.is_empty() {
        warnings.push(TronWarning::Memo);
    }
    if tx.fee_limit > HIGH_FEE_LIMIT {
        warnings.push(TronWarning::HighFeeLimit);
    }
    let memo_text = core::str::from_utf8(&tx.memo)
        .ok()
        .filter(|t| !t.is_empty())
        .map(|t| {
            let clean = sanitize_text(t, MAX_MEMO_TEXT);
            if clean.altered {
                warnings.push(TronWarning::UnusualText);
            }
            clean.text
        });
    Ok(TronTxSummary {
        txid: hex::encode(tx.txid()),
        owner: tron_address_from_bytes(tx.owner()),
        action,
        fee_limit: tx.fee_limit.to_string(),
        expiration: tx.expiration,
        timestamp: tx.timestamp,
        ref_block_bytes: hex::encode(tx.ref_block_bytes),
        ref_block_hash: hex::encode(tx.ref_block_hash),
        memo: hex::encode(&tx.memo),
        memo_text,
        raw_size: raw.len(),
        requires_extra_confirmation: !warnings.is_empty(),
        warnings,
    })
}

// ---------------------------------------------------------------------------------------------
// Stake 2.0 and voting
// ---------------------------------------------------------------------------------------------

/// One vote, as decoded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TronVote {
    /// Super representative (`T…`).
    pub address: String,
    /// Votes (TRON Power; 1 vote = 1 TRX staked).
    pub count: String,
}

/// What a staking transaction does, as decoded by Rust.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TronStakeAction {
    /// `FreezeBalanceV2`.
    Freeze {
        /// `BANDWIDTH` | `ENERGY`.
        resource: TronResource,
        /// Sun.
        amount: String,
    },
    /// `UnfreezeBalanceV2`.
    Unfreeze {
        /// `BANDWIDTH` | `ENERGY`.
        resource: TronResource,
        /// Sun.
        amount: String,
    },
    /// `WithdrawExpireUnfreeze`.
    WithdrawUnfrozen,
    /// `CancelAllUnfreezeV2`.
    CancelAllUnfreeze,
    /// `VoteWitness` (replaces every previous vote).
    Vote {
        /// Votes.
        votes: Vec<TronVote>,
        /// Sum of the votes.
        total: String,
    },
    /// `WithdrawBalance` (voting rewards).
    ClaimRewards,
}

/// Plain-language summary of a raw TRON staking transaction.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TronStakeSummary {
    /// `sha256(raw_data)`, hex.
    pub txid: String,
    /// Signer (`T…`), always our address (checked).
    pub owner: String,
    /// What it does.
    pub action: TronStakeAction,
    /// Milliseconds since the epoch.
    pub expiration: i64,
    /// Milliseconds since the epoch (0 if absent).
    pub timestamp: i64,
    /// Hex.
    pub ref_block_bytes: String,
    /// Hex.
    pub ref_block_hash: String,
    /// Size of `raw_data`, bytes.
    pub raw_size: usize,
}

/// Decodes a **staking** `raw_data` (hex): `FreezeBalanceV2` / `UnfreezeBalanceV2` (BANDWIDTH
/// or ENERGY, amount > 0), `WithdrawExpireUnfreeze`, `CancelAllUnfreezeV2`, `VoteWitness` (1 to
/// 30 votes, each > 0, no SR twice, `support` absent) and `WithdrawBalance`. Refused: everything
/// [`TronRaw::decode`] refuses (including `DelegateResource` / `UnDelegateResource`, i.e. lending
/// resources to another account, and `TRON_POWER`), a transfer or contract call, an owner other
/// than `our_address`, a memo, a `fee_limit` (system contracts burn no energy) and an expiration
/// more than 24 h ahead of the system clock.
pub fn tron_decode_stake_raw(raw_hex: &str, our_address: &str) -> Result<TronStakeSummary> {
    tron_decode_stake_raw_at(raw_hex, our_address, now_ms()?)
}

fn tron_decode_stake_raw_at(
    raw_hex: &str,
    our_address: &str,
    now: i64,
) -> Result<TronStakeSummary> {
    let raw =
        hex::decode(raw_hex.trim()).map_err(|_| Error::input("raw_data is not hexadecimal"))?;
    let tx = TronRaw::decode(&raw)?;
    check_expiration_at(tx.expiration, now)?;
    let ours = tron_address_bytes(our_address)?;
    if *tx.owner() != ours {
        return Err(bad("the owner is not this wallet's address"));
    }
    if !tx.memo.is_empty() {
        return Err(bad("memo in a staking transaction: refused"));
    }
    if tx.fee_limit != 0 {
        return Err(bad("fee_limit in a staking transaction: refused"));
    }
    let positive = |a: i64| -> Result<String> {
        if a <= 0 {
            return Err(bad("the amount must be positive"));
        }
        Ok(a.to_string())
    };
    let action = match &tx.contract {
        TronContract::FreezeV2 {
            amount, resource, ..
        } => TronStakeAction::Freeze {
            resource: *resource,
            amount: positive(*amount)?,
        },
        TronContract::UnfreezeV2 {
            amount, resource, ..
        } => TronStakeAction::Unfreeze {
            resource: *resource,
            amount: positive(*amount)?,
        },
        TronContract::WithdrawExpireUnfreeze { .. } => TronStakeAction::WithdrawUnfrozen,
        TronContract::CancelAllUnfreezeV2 { .. } => TronStakeAction::CancelAllUnfreeze,
        TronContract::WithdrawBalance { .. } => TronStakeAction::ClaimRewards,
        TronContract::VoteWitness { votes, .. } => {
            if votes.is_empty() || votes.len() > TRON_MAX_VOTES {
                return Err(bad(format!(
                    "1 to {TRON_MAX_VOTES} votes per transaction (here {})",
                    votes.len()
                )));
            }
            let mut seen: Vec<&[u8; 21]> = Vec::new();
            let mut total: i64 = 0;
            let mut out = Vec::with_capacity(votes.len());
            for (sr, count) in votes {
                if seen.contains(&sr) {
                    return Err(bad("the same SR appears twice: refused"));
                }
                seen.push(sr);
                total = total
                    .checked_add(*count)
                    .ok_or_else(|| bad("vote total too large"))?;
                out.push(TronVote {
                    address: tron_address_from_bytes(sr),
                    count: positive(*count)?,
                });
            }
            TronStakeAction::Vote {
                votes: out,
                total: total.to_string(),
            }
        }
        TronContract::Transfer { .. } | TronContract::Trigger { .. } => {
            return Err(bad(
                "not a staking transaction (transfer or contract call): refused here",
            ))
        }
    };
    Ok(TronStakeSummary {
        txid: hex::encode(tx.txid()),
        owner: tron_address_from_bytes(tx.owner()),
        action,
        expiration: tx.expiration,
        timestamp: tx.timestamp,
        ref_block_bytes: hex::encode(tx.ref_block_bytes),
        ref_block_hash: hex::encode(tx.ref_block_hash),
        raw_size: raw.len(),
    })
}

/// Signs a staking `raw_data` (hex) with the key of account `account` (`m/44'/195'/account'/0/0`),
/// after decoding it like [`tron_decode_stake_raw`] (owner must be that key's address).
pub fn tron_stake_sign(
    seed: &Seed,
    account: u32,
    raw_hex: &str,
) -> Result<([u8; 65], TronStakeSummary)> {
    let secp = secp()?;
    let master = XprivGuard::master(seed, bitcoin::NetworkKind::Main)?;
    let key = master.derive(&secp, &path(account, 0)?)?;
    // A reference: `SecretKey` is `Copy`, a copy here would outlive the guard's erasure.
    let sk = &key.xpriv().private_key;
    let ours = tron_address_from_bytes(&address_bytes_of_pubkey(&sk.public_key(&secp)));
    let summary = tron_decode_stake_raw(raw_hex, &ours)?;
    let raw =
        hex::decode(raw_hex.trim()).map_err(|_| Error::input("raw_data is not hexadecimal"))?;
    let digest = sha256::Hash::hash(&raw).to_byte_array();
    let sig = sign_digest(&secp, sk, digest)?;
    Ok((sig, summary))
}

// ---------------------------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------------------------

fn sign_digest(
    secp: &Secp256k1<bitcoin::secp256k1::All>,
    sk: &bitcoin::secp256k1::SecretKey,
    digest: [u8; 32],
) -> Result<[u8; 65]> {
    let msg = Message::from_digest(digest);
    let rec = secp.sign_ecdsa_recoverable(&msg, sk);
    let recovered = secp
        .recover_ecdsa(&msg, &rec)
        .map_err(|_| Error::crypto("signature verification failed"))?;
    if recovered != sk.public_key(secp) {
        return Err(Error::crypto("signature verification failed"));
    }
    let (recid, compact) = rec.serialize_compact();
    let v = match recid.to_i32() {
        0 => 27,
        1 => 28,
        _ => return Err(Error::crypto("unexpected recovery id")),
    };
    let mut out = [0u8; 65];
    out[..64].copy_from_slice(&compact);
    out[64] = v;
    Ok(out)
}

/// Signs `raw_data` (hex) with the key of account `account` (`m/44'/195'/account'/0/0`), after
/// decoding it like [`tron_decode_raw`] (owner must be that key's address). Returns the 65-byte
/// signature `r || s || v` (`v` = 27/28) and the summary.
pub fn tron_sign(seed: &Seed, account: u32, raw_hex: &str) -> Result<([u8; 65], TronTxSummary)> {
    let secp = secp()?;
    let master = XprivGuard::master(seed, bitcoin::NetworkKind::Main)?;
    let key = master.derive(&secp, &path(account, 0)?)?;
    // A reference: `SecretKey` is `Copy`, a copy here would outlive the guard's erasure.
    let sk = &key.xpriv().private_key;
    let ours = tron_address_from_bytes(&address_bytes_of_pubkey(&sk.public_key(&secp)));
    let summary = tron_decode_raw(raw_hex, &ours)?;
    let raw =
        hex::decode(raw_hex.trim()).map_err(|_| Error::input("raw_data is not hexadecimal"))?;
    let digest = sha256::Hash::hash(&raw).to_byte_array();
    let sig = sign_digest(&secp, sk, digest)?;
    Ok((sig, summary))
}

/// Address that produced `signature` (65 bytes, `v` ∈ {0, 1, 27, 28}) over `raw_data` (hex).
pub fn tron_recover_signer(raw_hex: &str, signature: &[u8]) -> Result<String> {
    let raw =
        hex::decode(raw_hex.trim()).map_err(|_| Error::input("raw_data is not hexadecimal"))?;
    let sig: [u8; 65] = signature
        .try_into()
        .map_err(|_| Error::input("signature: 65 bytes expected"))?;
    let v = match sig[64] {
        0 | 27 => 0,
        1 | 28 => 1,
        _ => return Err(Error::input("signature: invalid v")),
    };
    let rec = RecoverableSignature::from_compact(
        &sig[..64],
        RecoveryId::from_i32(v).map_err(|_| Error::input("signature: invalid v"))?,
    )
    .map_err(|_| Error::input("signature: invalid r/s"))?;
    let msg = Message::from_digest(sha256::Hash::hash(&raw).to_byte_array());
    let pk = Secp256k1::verification_only()
        .recover_ecdsa(&msg, &rec)
        .map_err(|_| Error::input("the key cannot be recovered from the signature"))?;
    Ok(tron_address_from_bytes(&address_bytes_of_pubkey(&pk)))
}

/// Serialized `Transaction { raw_data = 1; repeated bytes signature = 2 }`, hex — what
/// `/wallet/broadcasthex` takes.
pub fn tron_signed_transaction(raw_hex: &str, signature: &[u8; 65]) -> Result<String> {
    let raw =
        hex::decode(raw_hex.trim()).map_err(|_| Error::input("raw_data is not hexadecimal"))?;
    TronRaw::decode(&raw)?;
    let mut out = Vec::with_capacity(raw.len() + 72);
    put_bytes(&mut out, 1, &raw);
    put_bytes(&mut out, 2, signature);
    Ok(hex::encode(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Trust Wallet Core `TronSigner.SignTransfer` / `SignTransferTrc20Contract`: the private
    /// key, the transaction id (sha256 of raw_data) and the expected `r || s` (Trust Wallet
    /// writes `v` as 0/1, Kyro as 27/28 — same recovery id).
    #[test]
    fn signature_matches_trust_wallet_vectors() {
        let secp = Secp256k1::new();
        let sk = bitcoin::secp256k1::SecretKey::from_slice(
            &hex::decode("2d8f68944bdbfbc0769542fba8fc2d2a3de67393334471624364c7006da2aa54")
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            tron_address_from_bytes(&address_bytes_of_pubkey(&sk.public_key(&secp))),
            "TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC"
        );
        for (id, sig) in [
            (
                "dc6f6d9325ee44ab3c00528472be16e1572ab076aa161ccd12515029869d0451",
                "ede769f6df28aefe6a846be169958c155e23e7e5c9621d2e8dce1719b4d952b63e8a8bf9f00e41204ac1bf69b1a663dacdf764367e48e4a5afcd6b055a747fb200",
            ),
            (
                "0d644290e3cf554f6219c7747f5287589b6e7e30e1b02793b48ba362da6a5058",
                "bec790877b3a008640781e3948b070740b1f6023c29ecb3f7b5835433c13fc5835e5cad3bd44360ff2ddad5ed7dc9d7dee6878f90e86a40355b7697f5954b88c01",
            ),
        ] {
            let digest: [u8; 32] = hex::decode(id).unwrap().try_into().unwrap();
            let got = sign_digest(&secp, &sk, digest).unwrap();
            let want = hex::decode(sig).unwrap();
            assert_eq!(got[..64], want[..64]);
            assert_eq!(got[64], 27 + want[64]);
        }
        // Trust Wallet `TronAddress.FromPublicKey` second key.
        let sk2 = bitcoin::secp256k1::SecretKey::from_slice(
            &hex::decode("BE88DF1D0BF30A923CB39C3BB953178BAAF3726E8D3CE81E7C8462E046E0D835")
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            tron_address_of_pubkey(&sk2.public_key(&secp).serialize()).unwrap(),
            "THRF3GuPnvvPzKoaT8pJex5XHmo8NNbCb3"
        );
    }

    #[test]
    fn varints_and_wire_errors() {
        let mut b = Vec::new();
        put_varint(&mut b, 300);
        assert_eq!(b, [0xac, 0x02]);
        put_varint(&mut b, u64::MAX);
        assert_eq!(b.len(), 2 + 10);
        // Truncated, overlong and wire type 5 are refused.
        assert!(fields(&[0x08]).is_err());
        assert!(
            fields(&[0x08, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f]).is_err()
        );
        assert!(fields(&[0x0d, 0, 0, 0, 0]).is_err());
        assert!(fields(&[0x0a, 0x05, 0x01]).is_err());
    }

    const NOW: i64 = 1_800_000_000_000;

    fn raw_hex(contract: TronContract, expiration: i64, memo: &[u8]) -> String {
        hex::encode(
            TronRaw {
                ref_block_bytes: [1, 2],
                ref_block_hash: [3; 8],
                expiration,
                memo: memo.to_vec(),
                contract,
                timestamp: NOW,
                fee_limit: 0,
            }
            .encode(),
        )
    }

    fn me() -> [u8; 21] {
        let mut a = [7u8; 21];
        a[0] = TRON_ADDRESS_PREFIX;
        a
    }

    fn trx(memo: &[u8], expiration: i64) -> String {
        let mut to = [9u8; 21];
        to[0] = TRON_ADDRESS_PREFIX;
        raw_hex(
            TronContract::Transfer {
                owner: me(),
                to,
                amount: 1,
            },
            expiration,
            memo,
        )
    }

    /// Audit finding: the 24 h expiration ceiling was only enforced by the shell.
    #[test]
    fn expiration_more_than_24h_ahead_is_refused() {
        let ours = tron_address_from_bytes(&me());
        let limit = NOW + TRON_MAX_EXPIRATION_MS;
        assert!(tron_decode_raw_at(&trx(b"", limit), &ours, NOW).is_ok());
        assert!(tron_decode_raw_at(&trx(b"", limit + 1), &ours, NOW).is_err());
        let stake = |expiration| {
            raw_hex(
                TronContract::FreezeV2 {
                    owner: me(),
                    amount: 1_000_000,
                    resource: TronResource::Energy,
                },
                expiration,
                b"",
            )
        };
        assert!(tron_decode_stake_raw_at(&stake(limit), &ours, NOW).is_ok());
        assert!(tron_decode_stake_raw_at(&stake(limit + 1), &ours, NOW).is_err());
        // The public entry points use the system clock: a year ahead is refused.
        let year = now_ms().unwrap() + 365 * TRON_MAX_EXPIRATION_MS;
        assert!(tron_decode_raw(&trx(b"", year), &ours).is_err());
        assert!(tron_decode_stake_raw(&stake(year), &ours).is_err());
    }

    /// Audit finding: the memo was shown by the shell with its control / bidi characters.
    #[test]
    fn memo_text_is_sanitized() {
        let ours = tron_address_from_bytes(&me());
        let s = tron_decode_raw_at(&trx(b"merci", NOW + 60_000), &ours, NOW).unwrap();
        assert_eq!(s.memo_text.as_deref(), Some("merci"));
        assert_eq!(s.warnings, vec![TronWarning::Memo]);
        let tricky = "pay\u{202E}evil\r\nok\u{2066}".as_bytes();
        let s = tron_decode_raw_at(&trx(tricky, NOW + 60_000), &ours, NOW).unwrap();
        assert_eq!(s.memo_text.as_deref(), Some("payevil  ok"));
        assert_eq!(s.memo, hex::encode(tricky));
        assert_eq!(
            s.warnings,
            vec![TronWarning::Memo, TronWarning::UnusualText]
        );
        assert!(s.requires_extra_confirmation);
        // Not UTF-8: no text, only the hex.
        let s = tron_decode_raw_at(&trx(&[0xff, 0xfe], NOW + 60_000), &ours, NOW).unwrap();
        assert_eq!(s.memo_text, None);
    }
}
