//! Kaspa (KAS): keys, addresses, txids, Schnorr sighashes, mass/fees, plain KAS payments.

use bitcoin::bip32::{ChildNumber, Xpriv, Xpub};
use bitcoin::key::Keypair;
use bitcoin::secp256k1::{schnorr, All, Message, Secp256k1, XOnlyPublicKey};
use blake2::digest::consts::U32;
use blake2::digest::{FixedOutput, KeyInit, Update};
use blake2::Blake2bMac;
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::keys::{hardened, normal, path_string, random32, secp, XprivGuard};
use crate::mnemonic::Seed;
use crate::network::Network;

/// SLIP-44 coin type of Kaspa (`m/44'/111111'/…`), on mainnet **and** testnet.
pub const KASPA_COIN_TYPE: u32 = 111_111;
/// 1 KAS = 10⁸ sompi.
pub const SOMPI_PER_KAS: u64 = 100_000_000;
/// Total supply cap (`MAX_SOMPI`): 29 billion KAS.
pub const KASPA_MAX_SOMPI: u64 = 29_000_000_000 * SOMPI_PER_KAS;
/// KIP-9 storage mass parameter C (`STORAGE_MASS_PARAMETER` = 10⁴ KAS in sompi).
pub const KASPA_STORAGE_MASS_PARAMETER: u64 = SOMPI_PER_KAS * 10_000;
/// Largest mass of a standard transaction (`MAXIMUM_STANDARD_TRANSACTION_MASS`, grams).
pub const KASPA_MAX_STANDARD_MASS: u64 = 100_000;
/// Minimum relay fee rate, sompi/gram (`DEFAULT_MINIMUM_RELAY_TRANSACTION_FEE` = 100 000/kg).
pub const KASPA_MIN_FEERATE: u64 = 100;
/// Highest priority fee rate Kyro accepts from the server's estimate (100× the minimum).
pub const KASPA_MAX_FEERATE: u64 = 10_000;
/// A fee above this many times the minimum relay fee asks for the reinforced confirmation.
pub const KASPA_HIGH_FEE_FACTOR: u64 = 10;
/// Above this absolute fee (sompi, 1 KAS) the summary asks for the reinforced confirmation.
pub const KASPA_HIGH_FEE: u64 = SOMPI_PER_KAS;
/// Smallest recipient amount (0.2 KAS): its storage mass is then at most half the limit.
pub const KASPA_MIN_SEND: u64 = 20_000_000;
/// Change up to 0.2 KAS may go to the miner when a change output would exceed standard mass.
pub const KASPA_MAX_FOLDED_CHANGE: u64 = 20_000_000;
/// Addresses read per chain (receive `…/0/0..19`, change `…/1/0..19`).
pub const KASPA_SCAN_WINDOW: u32 = 20;
/// At most this many inputs per transaction (each costs 1 118 grams of compute mass).
pub const KASPA_MAX_INPUTS: usize = 84;
/// Mainnet coinbase maturity in DAA score (100 s × 10 blocks/s); Kyro waits twice that.
pub const KASPA_COINBASE_MATURITY: u64 = 1_000;

const SIG_HASH_ALL: u8 = 0b0000_0001;
const SIG_HASH_NONE: u8 = 0b0000_0010;
const SIG_HASH_SINGLE: u8 = 0b0000_0100;
const SIG_HASH_ANY_ONE_CAN_PAY: u8 = 0b1000_0000;
const SIG_HASH_MASK: u8 = 0b0000_0111;

const MASS_PER_TX_BYTE: u64 = 1;
const MASS_PER_SCRIPT_PUB_KEY_BYTE: u64 = 10;
const MASS_PER_SIG_OP: u64 = 1_000;
const TRANSIENT_BYTE_TO_MASS_FACTOR: u64 = 4;
const TRANSIENT_DIVISOR: u64 = 2;
const SIGNATURE_SCRIPT_LEN: usize = 66;

const CHARSET: &[u8; 32] = b"qpzry9x8gf2tvdw0s3jn54khce6mua7l";

/// Hash domains of rusty-kaspa (`crypto/hashes/src/hashers.rs`): the domain is the BLAKE2b key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KaspaHashDomain {
    /// `TransactionHash`.
    TransactionHash,
    /// `TransactionID`.
    TransactionId,
    /// `TransactionSigningHash`.
    TransactionSigningHash,
}

impl KaspaHashDomain {
    fn key(self) -> &'static [u8] {
        match self {
            KaspaHashDomain::TransactionHash => b"TransactionHash",
            KaspaHashDomain::TransactionId => b"TransactionID",
            KaspaHashDomain::TransactionSigningHash => b"TransactionSigningHash",
        }
    }
}

struct Hasher(Blake2bMac<U32>);

impl Hasher {
    fn new(domain: KaspaHashDomain) -> Result<Self> {
        Blake2bMac::<U32>::new_from_slice(domain.key())
            .map(Hasher)
            .map_err(|_| Error::crypto("blake2b key"))
    }
    fn raw(&mut self, b: &[u8]) -> &mut Self {
        self.0.update(b);
        self
    }
    fn u8(&mut self, v: u8) -> &mut Self {
        self.raw(&[v])
    }
    fn u16(&mut self, v: u16) -> &mut Self {
        self.raw(&v.to_le_bytes())
    }
    fn u32(&mut self, v: u32) -> &mut Self {
        self.raw(&v.to_le_bytes())
    }
    fn u64(&mut self, v: u64) -> &mut Self {
        self.raw(&v.to_le_bytes())
    }
    fn var_bytes(&mut self, b: &[u8]) -> &mut Self {
        self.u64(b.len() as u64).raw(b)
    }
    fn finish(self) -> [u8; 32] {
        self.0.finalize_fixed().into()
    }
}

/// Keyed BLAKE2b-256 of `data` in a Kaspa hash domain (exposed for the official vectors).
pub fn kaspa_hash(domain: KaspaHashDomain, data: &[u8]) -> Result<[u8; 32]> {
    let mut h = Hasher::new(domain)?;
    h.raw(data);
    Ok(h.finish())
}

/// A previous output reference.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct KaspaOutpoint {
    /// Transaction id, in the byte order of its hex form.
    pub tx_id: [u8; 32],
    /// Output index.
    pub index: u32,
}

/// A transaction input (version 0: sig-op count, no compute budget).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KaspaInput {
    /// Spent output.
    pub outpoint: KaspaOutpoint,
    /// Signature script (empty while unsigned).
    pub signature_script: Vec<u8>,
    /// Sequence (Kyro: 0).
    pub sequence: u64,
    /// Declared signature operations (P2PK: 1).
    pub sig_op_count: u8,
}

/// A transaction output.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KaspaOutput {
    /// Amount, sompi.
    pub value: u64,
    /// Script public key version (standard: 0).
    pub script_version: u16,
    /// Script public key.
    pub script: Vec<u8>,
}

/// A Kaspa transaction (the fields of rusty-kaspa's `Transaction`, minus the mass commitment).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KaspaTx {
    /// Version (Kyro builds and signs only 0).
    pub version: u16,
    /// Inputs.
    pub inputs: Vec<KaspaInput>,
    /// Outputs.
    pub outputs: Vec<KaspaOutput>,
    /// Lock time.
    pub lock_time: u64,
    /// Subnetwork id (native: 20 zero bytes).
    pub subnetwork_id: [u8; 20],
    /// Gas.
    pub gas: u64,
    /// Payload.
    pub payload: Vec<u8>,
}

/// The UTXO entry an input spends (amount and script are committed by the signature hash).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KaspaUtxoEntry {
    /// Amount, sompi.
    pub amount: u64,
    /// Script public key version.
    pub script_version: u16,
    /// Script public key.
    pub script: Vec<u8>,
    /// DAA score of the block that created it.
    pub block_daa_score: u64,
    /// Coinbase output (subject to maturity).
    pub is_coinbase: bool,
}

/// A coin Kyro may spend: an outpoint and its entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KaspaSpendable {
    /// Outpoint.
    pub outpoint: KaspaOutpoint,
    /// Entry.
    pub entry: KaspaUtxoEntry,
}

fn write_tx(h: &mut Hasher, tx: &KaspaTx, include_signature_scripts: bool) {
    h.u16(tx.version).u64(tx.inputs.len() as u64);
    for i in &tx.inputs {
        h.raw(&i.outpoint.tx_id).u32(i.outpoint.index);
        if include_signature_scripts {
            h.var_bytes(&i.signature_script).u8(i.sig_op_count);
        } else {
            h.var_bytes(&[]);
        }
        h.u64(i.sequence);
    }
    h.u64(tx.outputs.len() as u64);
    for o in &tx.outputs {
        h.u64(o.value).u16(o.script_version).var_bytes(&o.script);
    }
    h.u64(tx.lock_time)
        .raw(&tx.subnetwork_id)
        .u64(tx.gas)
        .var_bytes(&tx.payload);
}

/// Transaction id (v0): `TransactionID` hash without signature scripts or mass commitment.
pub fn kaspa_tx_id(tx: &KaspaTx) -> Result<[u8; 32]> {
    if tx.version != 0 {
        return Err(Error::input(
            "Kaspa: only version 0 transactions are supported",
        ));
    }
    let mut h = Hasher::new(KaspaHashDomain::TransactionId)?;
    write_tx(&mut h, tx, false);
    Ok(h.finish())
}

/// Transaction hash (version 0, mass commitment 0): `TransactionHash` of the full encoding.
pub fn kaspa_tx_hash(tx: &KaspaTx) -> Result<[u8; 32]> {
    if tx.version != 0 {
        return Err(Error::input(
            "Kaspa: only version 0 transactions are supported",
        ));
    }
    let mut h = Hasher::new(KaspaHashDomain::TransactionHash)?;
    write_tx(&mut h, tx, true);
    Ok(h.finish())
}

fn signing_hash(f: impl FnOnce(&mut Hasher)) -> Result<[u8; 32]> {
    let mut h = Hasher::new(KaspaHashDomain::TransactionSigningHash)?;
    f(&mut h);
    Ok(h.finish())
}

fn hash_output(h: &mut Hasher, o: &KaspaOutput, version: u16) {
    h.u64(o.value).u16(o.script_version).var_bytes(&o.script);
    if version >= 1 {
        // No covenant binding (Kyro never builds one).
        h.u8(0);
    }
}

/// Schnorr signature hash of input `index` (`calc_schnorr_signature_hash`), any standard type.
pub fn kaspa_sighash(
    tx: &KaspaTx,
    entries: &[KaspaUtxoEntry],
    index: usize,
    hash_type: u8,
) -> Result<[u8; 32]> {
    if !matches!(hash_type, 0x01 | 0x02 | 0x04 | 0x81 | 0x82 | 0x84) {
        return Err(Error::input("Kaspa: invalid sighash type"));
    }
    if entries.len() != tx.inputs.len() {
        return Err(Error::input("Kaspa: one UTXO entry per input expected"));
    }
    let (input, entry) = match (tx.inputs.get(index), entries.get(index)) {
        (Some(i), Some(e)) => (i, e),
        _ => return Err(Error::input("Kaspa: input index out of range")),
    };
    let anyone = hash_type & SIG_HASH_ANY_ONE_CAN_PAY != 0;
    let base = hash_type & SIG_HASH_MASK;
    let single = base == SIG_HASH_SINGLE;
    let none = base == SIG_HASH_NONE;
    let zero = [0u8; 32];

    let prev_outputs = if anyone {
        zero
    } else {
        signing_hash(|h| {
            for i in &tx.inputs {
                h.raw(&i.outpoint.tx_id).u32(i.outpoint.index);
            }
        })?
    };
    let sequences = if single || anyone || none {
        zero
    } else {
        signing_hash(|h| {
            for i in &tx.inputs {
                h.u64(i.sequence);
            }
        })?
    };
    let sig_op_counts = if anyone {
        zero
    } else {
        signing_hash(|h| {
            for i in &tx.inputs {
                h.u8(i.sig_op_count);
            }
        })?
    };
    let outputs = if none {
        zero
    } else if single {
        match tx.outputs.get(index) {
            Some(o) => signing_hash(|h| hash_output(h, o, tx.version))?,
            None => zero,
        }
    } else {
        signing_hash(|h| {
            for o in &tx.outputs {
                hash_output(h, o, tx.version);
            }
        })?
    };
    let native = tx.subnetwork_id == [0u8; 20];
    let payload = if native && tx.payload.is_empty() {
        zero
    } else {
        signing_hash(|h| {
            h.var_bytes(&tx.payload);
        })?
    };

    signing_hash(|h| {
        h.u16(tx.version).raw(&prev_outputs).raw(&sequences);
        if tx.version < 1 {
            h.raw(&sig_op_counts);
        }
        h.raw(&input.outpoint.tx_id)
            .u32(input.outpoint.index)
            .u16(entry.script_version)
            .var_bytes(&entry.script)
            .u64(entry.amount)
            .u64(input.sequence);
        if tx.version < 1 {
            h.u8(input.sig_op_count);
        }
        h.raw(&outputs)
            .u64(tx.lock_time)
            .raw(&tx.subnetwork_id)
            .u64(tx.gas)
            .raw(&payload)
            .u8(hash_type);
    })
}

/// Masses of a (signed, or sized-as-signed) transaction, grams.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KaspaMass {
    /// Compute mass: bytes + 10 × script public key bytes + 1 000 per sig-op.
    pub compute: u64,
    /// Transient mass: 4 × bytes (before normalization).
    pub transient: u64,
    /// KIP-9 storage mass.
    pub storage: u64,
    /// max(compute, transient ÷ 2): what the minimum relay fee is computed on.
    pub relay: u64,
    /// max(compute, storage, transient ÷ 2): the transaction mass (standard limit, priority).
    pub total: u64,
}

impl KaspaMass {
    /// Minimum relay fee (sompi): relay mass × [`KASPA_MIN_FEERATE`].
    pub fn minimum_fee(&self) -> u64 {
        self.relay.saturating_mul(KASPA_MIN_FEERATE)
    }

    /// Fee: minimum relay fee, or `priority_feerate` × whole mass if higher (0 when not busy).
    pub fn fee(&self, priority_feerate: u64) -> u64 {
        self.minimum_fee().max(
            self.total
                .saturating_mul(priority_feerate.min(KASPA_MAX_FEERATE)),
        )
    }
}

/// Priority fee rate from the estimate: 0 at the minimum, else capped at [`KASPA_MAX_FEERATE`].
pub fn kaspa_priority_feerate(estimate: u64) -> u64 {
    if estimate <= KASPA_MIN_FEERATE {
        0
    } else {
        estimate.min(KASPA_MAX_FEERATE)
    }
}

/// `transaction_estimated_serialized_size` (version 0).
pub fn kaspa_serialized_size(tx: &KaspaTx) -> u64 {
    let mut size: u64 = 2 + 8;
    for i in &tx.inputs {
        size += 32 + 4 + 8 + i.signature_script.len() as u64 + 8;
    }
    size += 8;
    for o in &tx.outputs {
        size += 8 + 2 + 8 + o.script.len() as u64;
    }
    size + 8 + 20 + 8 + 32 + 8 + tx.payload.len() as u64
}

/// Compute mass (`calc_non_contextual_masses`, version 0).
pub fn kaspa_compute_mass(tx: &KaspaTx) -> u64 {
    let size = kaspa_serialized_size(tx);
    let spk: u64 = tx.outputs.iter().map(|o| 2 + o.script.len() as u64).sum();
    let sigops: u64 = tx.inputs.iter().map(|i| u64::from(i.sig_op_count)).sum();
    size * MASS_PER_TX_BYTE + spk * MASS_PER_SCRIPT_PUB_KEY_BYTE + sigops * MASS_PER_SIG_OP
}

fn plurality(script_len: usize) -> u64 {
    (63 + script_len as u64).div_ceil(100)
}

/// KIP-9 storage mass (`calc_storage_mass`, with pluralities) from `(amount, script len)` pairs.
pub fn kaspa_storage_mass(inputs: &[(u64, usize)], outputs: &[(u64, usize)]) -> Option<u64> {
    let c = KASPA_STORAGE_MASS_PARAMETER;
    if inputs.is_empty() || inputs.iter().chain(outputs).any(|(a, _)| *a == 0) {
        return None;
    }
    let mut outs_plurality = 0u64;
    let mut harmonic_outs = 0u64;
    for (amount, len) in outputs {
        let p = plurality(*len);
        outs_plurality += p;
        harmonic_outs = harmonic_outs.checked_add(c.checked_mul(p)?.checked_mul(p)? / amount)?;
    }
    let ins_plurality: u64 = inputs.iter().map(|(_, l)| plurality(*l)).sum();
    let relaxed = outs_plurality == 1
        || (inputs.len() <= 2
            && (ins_plurality == 1 || (outs_plurality == 2 && ins_plurality == 2)));
    if relaxed {
        let harmonic_ins = inputs.iter().fold(0u64, |acc, (amount, len)| {
            let p = plurality(*len);
            acc.saturating_add(c.saturating_mul(p).saturating_mul(p) / amount)
        });
        return Some(harmonic_outs.saturating_sub(harmonic_ins));
    }
    let sum_ins = inputs
        .iter()
        .try_fold(0u64, |acc, (a, _)| acc.checked_add(*a))?;
    let mean_ins = (sum_ins / ins_plurality).max(1);
    let arithmetic_ins = ins_plurality.saturating_mul(c / mean_ins);
    Some(harmonic_outs.saturating_sub(arithmetic_ins))
}

/// All masses of `tx` spending `entries`.
pub fn kaspa_mass(tx: &KaspaTx, entries: &[KaspaUtxoEntry]) -> Result<KaspaMass> {
    let compute = kaspa_compute_mass(tx);
    let transient = kaspa_serialized_size(tx) * TRANSIENT_BYTE_TO_MASS_FACTOR;
    let ins: Vec<(u64, usize)> = entries.iter().map(|e| (e.amount, e.script.len())).collect();
    let outs: Vec<(u64, usize)> = tx
        .outputs
        .iter()
        .map(|o| (o.value, o.script.len()))
        .collect();
    let storage = kaspa_storage_mass(&ins, &outs)
        .ok_or_else(|| Error::input("Kaspa: storage mass too high (an amount is zero or tiny)"))?;
    let relay = compute.max(transient.div_ceil(TRANSIENT_DIVISOR));
    Ok(KaspaMass {
        compute,
        transient,
        storage,
        relay,
        total: relay.max(storage),
    })
}

/// Copy of `tx` with 66-byte placeholder signature scripts (P2PK Schnorr size), for pricing.
pub fn kaspa_with_dummy_signatures(tx: &KaspaTx) -> KaspaTx {
    let mut t = tx.clone();
    for i in &mut t.inputs {
        i.signature_script = vec![0u8; SIGNATURE_SCRIPT_LEN];
    }
    t
}

/// Address version byte.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KaspaAddressKind {
    /// 0: P2PK Schnorr (32-byte x-only key) — Kyro's own addresses.
    PubKey,
    /// 1: P2PK ECDSA (33-byte compressed key).
    PubKeyEcdsa,
    /// 8: P2SH (32-byte blake2b script hash).
    ScriptHash,
}

impl KaspaAddressKind {
    fn byte(self) -> u8 {
        match self {
            KaspaAddressKind::PubKey => 0,
            KaspaAddressKind::PubKeyEcdsa => 1,
            KaspaAddressKind::ScriptHash => 8,
        }
    }
    fn from_byte(b: u8) -> Option<Self> {
        match b {
            0 => Some(KaspaAddressKind::PubKey),
            1 => Some(KaspaAddressKind::PubKeyEcdsa),
            8 => Some(KaspaAddressKind::ScriptHash),
            _ => None,
        }
    }
    fn payload_len(self) -> usize {
        match self {
            KaspaAddressKind::PubKeyEcdsa => 33,
            _ => 32,
        }
    }
}

/// Address prefix of `net`: `kaspa` (mainnet) or `kaspatest` (testnet-10).
pub fn kaspa_prefix(net: Network) -> &'static str {
    match net {
        Network::Mainnet => "kaspa",
        Network::Testnet => "kaspatest",
    }
}

fn polymod(values: impl Iterator<Item = u8>) -> u64 {
    let mut c = 1u64;
    for d in values {
        let c0 = c >> 35;
        c = ((c & 0x07_ffff_ffff) << 5) ^ u64::from(d);
        for (bit, g) in [
            (0x01, 0x98_f2bc_8e61u64),
            (0x02, 0x79_b76d_99e2),
            (0x04, 0xf3_3e5f_b3c4),
            (0x08, 0xae_2eab_e2a8),
            (0x10, 0x1e_4f43_e470),
        ] {
            if c0 & bit != 0 {
                c ^= g;
            }
        }
    }
    c ^ 1
}

fn checksum(prefix: &str, payload5: &[u8]) -> u64 {
    polymod(
        prefix
            .bytes()
            .map(|c| c & 0x1f)
            .chain([0u8])
            .chain(payload5.iter().copied())
            .chain([0u8; 8]),
    )
}

fn conv8to5(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() * 8 / 5 + 1);
    let mut buf = 0u16;
    let mut bits = 0u32;
    for b in data {
        buf = (buf << 8) | u16::from(*b);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(((buf >> bits) & 0x1f) as u8);
        }
        buf &= (1 << bits) - 1;
    }
    if bits > 0 {
        out.push(((buf << (5 - bits)) & 0x1f) as u8);
    }
    out
}

fn conv5to8(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() * 5 / 8);
    let mut buf = 0u16;
    let mut bits = 0u32;
    for b in data {
        buf = (buf << 5) | u16::from(*b);
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push(((buf >> bits) & 0xff) as u8);
        }
        buf &= (1 << bits) - 1;
    }
    out
}

fn encode_address(prefix: &str, kind: KaspaAddressKind, payload: &[u8]) -> String {
    let mut raw = Vec::with_capacity(1 + payload.len());
    raw.push(kind.byte());
    raw.extend_from_slice(payload);
    let five = conv8to5(&raw);
    let sum = checksum(prefix, &five);
    let sum5 = conv8to5(&sum.to_be_bytes()[3..]);
    let mut s = String::with_capacity(prefix.len() + 1 + five.len() + 8);
    s.push_str(prefix);
    s.push(':');
    for v in five.iter().chain(&sum5) {
        s.push(char::from(CHARSET[usize::from(*v)]));
    }
    s
}

/// Encodes an address of `kind` with `payload` (32 or 33 bytes) for `net`.
pub fn kaspa_address_encode(
    net: Network,
    kind: KaspaAddressKind,
    payload: &[u8],
) -> Result<String> {
    if payload.len() != kind.payload_len() {
        return Err(Error::input("Kaspa: wrong address payload length"));
    }
    Ok(encode_address(kaspa_prefix(net), kind, payload))
}

/// Decodes a `kaspa:`/`kaspatest:` address: lowercase, `net` prefix, checksum, canonical.
pub fn kaspa_address_decode(net: Network, address: &str) -> Result<(KaspaAddressKind, Vec<u8>)> {
    let a = address.trim();
    let want = kaspa_prefix(net);
    let Some((prefix, data)) = a.split_once(':') else {
        return Err(Error::input(
            "Kaspa address must start with kaspa: (or kaspatest:)",
        ));
    };
    if prefix != want {
        return Err(Error::input(match (prefix, net) {
            ("kaspatest", Network::Mainnet) => "this is a Kaspa testnet address (kaspatest:)",
            ("kaspa", Network::Testnet) => "this is a Kaspa mainnet address (kaspa:)",
            _ => "not a Kaspa address of this network",
        }));
    }
    let mut five = Vec::with_capacity(data.len());
    for c in data.bytes() {
        let v = CHARSET
            .iter()
            .position(|x| *x == c)
            .ok_or_else(|| Error::input("invalid character in Kaspa address"))?;
        five.push(v as u8);
    }
    if five.len() < 8 + 2 {
        return Err(Error::input("Kaspa address too short"));
    }
    let (payload5, sum5) = five.split_at(five.len() - 8);
    let mut sum_bytes = [0u8; 8];
    let sum8 = conv5to8(sum5);
    if sum8.len() != 5 {
        return Err(Error::input("invalid Kaspa address checksum"));
    }
    sum_bytes[3..].copy_from_slice(&sum8);
    if checksum(want, payload5) != u64::from_be_bytes(sum_bytes) {
        return Err(Error::input("invalid Kaspa address checksum"));
    }
    let raw = conv5to8(payload5);
    let (version, payload) = raw
        .split_first()
        .ok_or_else(|| Error::input("empty Kaspa address"))?;
    let kind = KaspaAddressKind::from_byte(*version)
        .ok_or_else(|| Error::input("unknown Kaspa address version"))?;
    if payload.len() != kind.payload_len() {
        return Err(Error::input("wrong Kaspa address length"));
    }
    if encode_address(want, kind, payload) != a {
        return Err(Error::input("non-canonical Kaspa address"));
    }
    Ok((kind, payload.to_vec()))
}

fn script_for(kind: KaspaAddressKind, payload: &[u8]) -> Vec<u8> {
    let mut s = Vec::with_capacity(payload.len() + 3);
    match kind {
        KaspaAddressKind::PubKey => {
            s.push(0x20);
            s.extend_from_slice(payload);
            s.push(0xac); // OP_CHECKSIG
        }
        KaspaAddressKind::PubKeyEcdsa => {
            s.push(0x21);
            s.extend_from_slice(payload);
            s.push(0xab); // OP_CHECKSIGECDSA
        }
        KaspaAddressKind::ScriptHash => {
            s.push(0xaa); // OP_BLAKE2B
            s.push(0x20);
            s.extend_from_slice(payload);
            s.push(0x87); // OP_EQUAL
        }
    }
    s
}

/// Script public key (version 0) of a destination address valid on `net`.
pub fn kaspa_script_pubkey(net: Network, address: &str) -> Result<Vec<u8>> {
    let (kind, payload) = kaspa_address_decode(net, address)?;
    Ok(script_for(kind, &payload))
}

/// Address of a version-0 standard script (P2PK Schnorr, P2PK ECDSA, P2SH), else `None`.
pub fn kaspa_address_of_script(net: Network, version: u16, script: &[u8]) -> Option<String> {
    if version != 0 {
        return None;
    }
    let (kind, payload) = match script {
        [0x20, key @ .., 0xac] if key.len() == 32 => (KaspaAddressKind::PubKey, key),
        [0x21, key @ .., 0xab] if key.len() == 33 => (KaspaAddressKind::PubKeyEcdsa, key),
        [0xaa, 0x20, hash @ .., 0x87] if hash.len() == 32 => (KaspaAddressKind::ScriptHash, hash),
        _ => return None,
    };
    Some(encode_address(kaspa_prefix(net), kind, payload))
}

/// `m/44'/111111'/account'/change/index` as text (`change`: 0 receive, 1 change).
pub fn kaspa_path(account: u32, change: bool, index: u32) -> String {
    format!(
        "m/44'/{KASPA_COIN_TYPE}'/{account}'/{}/{index}",
        u8::from(change)
    )
}

fn account_path(account: u32) -> Result<[ChildNumber; 3]> {
    Ok([
        hardened(44)?,
        hardened(KASPA_COIN_TYPE)?,
        hardened(account)?,
    ])
}

fn account_xpriv(secp: &Secp256k1<All>, seed: &Seed, account: u32) -> Result<XprivGuard> {
    // The key material does not depend on the network (same path on testnet).
    let master = XprivGuard::master(seed, bitcoin::NetworkKind::Main)?;
    master.derive(secp, &account_path(account)?)
}

fn xonly_at(secp: &Secp256k1<All>, xpub: &Xpub, change: bool, index: u32) -> Result<[u8; 32]> {
    let child = xpub
        .derive_pub(secp, &[normal(u32::from(change))?, normal(index)?])
        .map_err(|_| Error::crypto("key derivation failed"))?;
    Ok(child.public_key.x_only_public_key().0.serialize())
}

/// One of our keys, by position in the account.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KaspaOwnKey {
    /// Change chain (`…/1/i`) or receive chain (`…/0/i`).
    pub change: bool,
    /// Address index.
    pub index: u32,
    /// x-only public key.
    #[serde(with = "hex_32")]
    pub xonly: [u8; 32],
    /// Its P2PK Schnorr address.
    pub address: String,
}

impl KaspaOwnKey {
    /// Its script public key (`OP_DATA_32 <key> OP_CHECKSIG`).
    pub fn script(&self) -> Vec<u8> {
        script_for(KaspaAddressKind::PubKey, &self.xonly)
    }
}

mod hex_32 {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(v: &[u8; 32], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&hex::encode(v))
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<[u8; 32], D::Error> {
        let s = String::deserialize(d)?;
        let v = hex::decode(s).map_err(serde::de::Error::custom)?;
        v.try_into()
            .map_err(|_| serde::de::Error::custom("32 bytes expected"))
    }
}

/// The first `window` receive and change keys of `account` (receive first).
pub fn kaspa_own_keys(
    seed: &Seed,
    net: Network,
    account: u32,
    window: u32,
) -> Result<Vec<KaspaOwnKey>> {
    let secp = secp()?;
    let acct = account_xpriv(&secp, seed, account)?;
    let xpub = Xpub::from_priv(&secp, acct.xpriv());
    drop(acct);
    let mut out = Vec::with_capacity(2 * window as usize);
    for change in [false, true] {
        for index in 0..window {
            let xonly = xonly_at(&secp, &xpub, change, index)?;
            out.push(KaspaOwnKey {
                change,
                index,
                xonly,
                address: encode_address(kaspa_prefix(net), KaspaAddressKind::PubKey, &xonly),
            });
        }
    }
    Ok(out)
}

/// x-only public key at `m/44'/111111'/account'/change/index`.
pub fn kaspa_public_key(seed: &Seed, account: u32, change: bool, index: u32) -> Result<[u8; 32]> {
    let secp = secp()?;
    let acct = account_xpriv(&secp, seed, account)?;
    let xpub = Xpub::from_priv(&secp, acct.xpriv());
    xonly_at(&secp, &xpub, change, index)
}

/// P2PK Schnorr address at `m/44'/111111'/account'/change/index` on `net`.
pub fn kaspa_address(
    seed: &Seed,
    net: Network,
    account: u32,
    change: bool,
    index: u32,
) -> Result<String> {
    let xonly = kaspa_public_key(seed, account, change, index)?;
    Ok(encode_address(
        kaspa_prefix(net),
        KaspaAddressKind::PubKey,
        &xonly,
    ))
}

/// Address of an x-only key on `net` (vectors that start from an extended key).
pub fn kaspa_address_of_xonly(net: Network, xonly: &[u8; 32]) -> String {
    encode_address(kaspa_prefix(net), KaspaAddressKind::PubKey, xonly)
}

/// Account path `m/44'/111111'/account'`.
pub fn kaspa_account_path(account: u32) -> Result<String> {
    Ok(path_string(&account_path(account)?))
}

/// Receive/change x-only keys `0..count` from an account-level xprv (for `kprv` test vectors).
pub fn kaspa_keys_from_master(
    master: &Xpriv,
    account: u32,
    change: bool,
    count: u32,
) -> Result<Vec<[u8; 32]>> {
    let secp = secp()?;
    let acct = master
        .derive_priv(&secp, &account_path(account)?)
        .map_err(|_| Error::crypto("key derivation failed"))?;
    let xpub = Xpub::from_priv(&secp, &acct);
    (0..count)
        .map(|i| xonly_at(&secp, &xpub, change, i))
        .collect()
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct JsonOutpoint {
    transaction_id: String,
    index: u32,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct JsonInput {
    previous_outpoint: JsonOutpoint,
    signature_script: String,
    sequence: u64,
    sig_op_count: u8,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct JsonScript {
    version: u16,
    script_public_key: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct JsonOutput {
    amount: u64,
    script_public_key: JsonScript,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct JsonTx {
    version: u16,
    inputs: Vec<JsonInput>,
    outputs: Vec<JsonOutput>,
    lock_time: u64,
    subnetwork_id: String,
    gas: u64,
    payload: String,
}

fn hex_bytes(s: &str, what: &str) -> Result<Vec<u8>> {
    if s.bytes().any(|b| b.is_ascii_uppercase()) {
        return Err(Error::input(format!(
            "Kaspa: {what}: lowercase hex expected"
        )));
    }
    hex::decode(s).map_err(|_| Error::input(format!("Kaspa: {what}: invalid hex")))
}

fn hex_array<const N: usize>(s: &str, what: &str) -> Result<[u8; N]> {
    hex_bytes(s, what)?
        .try_into()
        .map_err(|_| Error::input(format!("Kaspa: {what}: {N} bytes expected")))
}

/// Serializes `tx` as the REST API's `SubmitTxModel` JSON (hex fields, integer amounts).
pub fn kaspa_tx_to_json(tx: &KaspaTx) -> Result<String> {
    let j = JsonTx {
        version: tx.version,
        inputs: tx
            .inputs
            .iter()
            .map(|i| JsonInput {
                previous_outpoint: JsonOutpoint {
                    transaction_id: hex::encode(i.outpoint.tx_id),
                    index: i.outpoint.index,
                },
                signature_script: hex::encode(&i.signature_script),
                sequence: i.sequence,
                sig_op_count: i.sig_op_count,
            })
            .collect(),
        outputs: tx
            .outputs
            .iter()
            .map(|o| JsonOutput {
                amount: o.value,
                script_public_key: JsonScript {
                    version: o.script_version,
                    script_public_key: hex::encode(&o.script),
                },
            })
            .collect(),
        lock_time: tx.lock_time,
        subnetwork_id: hex::encode(tx.subnetwork_id),
        gas: tx.gas,
        payload: hex::encode(&tx.payload),
    };
    serde_json::to_string(&j).map_err(|_| Error::crypto("Kaspa: JSON encoding failed"))
}

/// Strictly parses [`kaspa_tx_to_json`] JSON (no unknown fields, lowercase hex, ≤ 1 000 in/out).
pub fn kaspa_tx_from_json(json: &str) -> Result<KaspaTx> {
    if json.len() > 512 * 1024 {
        return Err(Error::input("Kaspa: transaction too large"));
    }
    let j: JsonTx = serde_json::from_str(json)
        .map_err(|e| Error::input(format!("Kaspa: invalid transaction JSON ({e})")))?;
    if j.inputs.len() > 1_000 || j.outputs.len() > 1_000 {
        return Err(Error::input("Kaspa: too many inputs or outputs"));
    }
    let inputs = j
        .inputs
        .iter()
        .map(|i| {
            Ok(KaspaInput {
                outpoint: KaspaOutpoint {
                    tx_id: hex_array(&i.previous_outpoint.transaction_id, "transactionId")?,
                    index: i.previous_outpoint.index,
                },
                signature_script: hex_bytes(&i.signature_script, "signatureScript")?,
                sequence: i.sequence,
                sig_op_count: i.sig_op_count,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let outputs = j
        .outputs
        .iter()
        .map(|o| {
            Ok(KaspaOutput {
                value: o.amount,
                script_version: o.script_public_key.version,
                script: hex_bytes(&o.script_public_key.script_public_key, "scriptPublicKey")?,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(KaspaTx {
        version: j.version,
        inputs,
        outputs,
        lock_time: j.lock_time,
        subnetwork_id: hex_array(&j.subnetwork_id, "subnetworkId")?,
        gas: j.gas,
        payload: hex_bytes(&j.payload, "payload")?,
    })
}

/// How much to send.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KaspaAmount {
    /// Exactly this many sompi to the recipient.
    Exact(u64),
    /// Everything spendable minus the fee (single output, no change).
    Max,
}

/// A transaction built by [`kaspa_build_send`] and the entries its inputs spend.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KaspaBuilt {
    /// Unsigned transaction (empty signature scripts).
    pub tx: KaspaTx,
    /// `entries[i]` is spent by input `i`.
    pub entries: Vec<KaspaUtxoEntry>,
}

fn unsigned_tx(coins: &[KaspaSpendable], outputs: Vec<KaspaOutput>) -> KaspaTx {
    KaspaTx {
        version: 0,
        inputs: coins
            .iter()
            .map(|c| KaspaInput {
                outpoint: c.outpoint,
                signature_script: Vec::new(),
                sequence: 0,
                sig_op_count: 1,
            })
            .collect(),
        outputs,
        lock_time: 0,
        subnetwork_id: [0u8; 20],
        gas: 0,
        payload: Vec::new(),
    }
}

fn out(value: u64, script: &[u8]) -> KaspaOutput {
    KaspaOutput {
        value,
        script_version: 0,
        script: script.to_vec(),
    }
}

fn priced(coins: &[KaspaSpendable], outputs: Vec<KaspaOutput>) -> Option<KaspaMass> {
    let entries: Vec<KaspaUtxoEntry> = coins.iter().map(|c| c.entry.clone()).collect();
    let tx = kaspa_with_dummy_signatures(&unsigned_tx(coins, outputs));
    kaspa_mass(&tx, &entries).ok()
}

fn fee_with_change(
    coins: &[KaspaSpendable],
    total: u64,
    amount: u64,
    to: &[u8],
    change: &[u8],
    priority: u64,
) -> Option<(u64, u64)> {
    let mut fee = 0u64;
    for _ in 0..16 {
        let change_value = total.checked_sub(amount)?.checked_sub(fee)?;
        if change_value == 0 {
            return None;
        }
        let m = priced(coins, vec![out(amount, to), out(change_value, change)])?;
        if m.total > KASPA_MAX_STANDARD_MASS {
            return None;
        }
        let needed = m.fee(priority);
        if needed <= fee {
            return Some((fee, change_value));
        }
        fee = needed;
    }
    None
}

/// Builds an unsigned payment (largest coins first, change to `change_script`, [`KaspaMass::fee`]).
pub fn kaspa_build_send(
    coins: &[KaspaSpendable],
    to_script: &[u8],
    amount: KaspaAmount,
    change_script: &[u8],
    priority_feerate: u64,
) -> Result<KaspaBuilt> {
    let priority = priority_feerate.min(KASPA_MAX_FEERATE);
    let mut sorted: Vec<KaspaSpendable> = coins
        .iter()
        .filter(|c| c.entry.amount > 0)
        .cloned()
        .collect();
    sorted.sort_by(|a, b| {
        b.entry
            .amount
            .cmp(&a.entry.amount)
            .then(a.outpoint.cmp(&b.outpoint))
    });
    if sorted.is_empty() {
        return Err(Error::input("no KAS to spend"));
    }
    let built = |chosen: &[KaspaSpendable], outputs: Vec<KaspaOutput>| KaspaBuilt {
        tx: unsigned_tx(chosen, outputs),
        entries: chosen.iter().map(|c| c.entry.clone()).collect(),
    };
    match amount {
        KaspaAmount::Max => {
            let chosen = &sorted[..sorted.len().min(KASPA_MAX_INPUTS)];
            let total = chosen
                .iter()
                .try_fold(0u64, |a, c| a.checked_add(c.entry.amount))
                .ok_or_else(|| Error::input("amount overflow"))?;
            let mut fee = 0u64;
            for _ in 0..16 {
                let value = total
                    .checked_sub(fee)
                    .filter(|v| *v > 0)
                    .ok_or_else(|| Error::input("balance too small to pay the fee"))?;
                let m = priced(chosen, vec![out(value, to_script)])
                    .filter(|m| m.total <= KASPA_MAX_STANDARD_MASS)
                    .ok_or_else(|| {
                        Error::input("amount too small: the transaction mass would exceed the standard limit")
                    })?;
                let needed = m.fee(priority);
                if needed <= fee {
                    return Ok(built(chosen, vec![out(value, to_script)]));
                }
                fee = needed;
            }
            Err(Error::input("fee did not converge"))
        }
        KaspaAmount::Exact(amount) => {
            if amount == 0 {
                return Err(Error::input("amount must be positive"));
            }
            if amount < KASPA_MIN_SEND {
                return Err(Error::input(
                    "amount too small: at least 0.2 KAS (Kaspa's storage mass, KIP-9, makes tiny outputs non-standard)",
                ));
            }
            let mut total = 0u64;
            for n in 1..=sorted.len().min(KASPA_MAX_INPUTS) {
                let chosen = &sorted[..n];
                total = total
                    .checked_add(chosen[n - 1].entry.amount)
                    .ok_or_else(|| Error::input("amount overflow"))?;
                if total <= amount {
                    continue;
                }
                if let Some((_, change)) =
                    fee_with_change(chosen, total, amount, to_script, change_script, priority)
                {
                    return Ok(built(
                        chosen,
                        vec![out(amount, to_script), out(change, change_script)],
                    ));
                }
                // No room for a change output: give the small rest to the miner, if small.
                if let Some(m) = priced(chosen, vec![out(amount, to_script)]) {
                    let fee = m.fee(priority);
                    let rest = total - amount;
                    if m.total <= KASPA_MAX_STANDARD_MASS
                        && rest >= fee
                        && rest - fee <= KASPA_MAX_FOLDED_CHANGE
                    {
                        return Ok(built(chosen, vec![out(amount, to_script)]));
                    }
                }
            }
            if sorted.len() > KASPA_MAX_INPUTS {
                Err(Error::input(format!(
                    "insufficient funds within {KASPA_MAX_INPUTS} coins: send a smaller amount, or send everything to yourself first to merge your coins"
                )))
            } else {
                Err(Error::input("insufficient funds (amount + fee)"))
            }
        }
    }
}

/// What an output pays.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KaspaOutputKind {
    /// A standard script with an address.
    Address,
    /// Anything else (no address can be shown).
    Unknown,
}

/// One decoded output.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KaspaOutputView {
    /// Address (standard scripts).
    pub address: Option<String>,
    /// Script public key, hex.
    pub script: String,
    /// Sompi, decimal string.
    pub amount: String,
    /// Pays one of our keys of this account (receive or change chain, inside the window).
    pub is_change: bool,
    /// Kind.
    pub kind: KaspaOutputKind,
}

/// Something unusual that asks for the reinforced confirmation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum KaspaWarning {
    /// An output with a non-standard script.
    UnknownOutput {
        /// Output index.
        index: usize,
    },
    /// Fee above [`KASPA_HIGH_FEE_FACTOR`] × the minimum relay fee, or above [`KASPA_HIGH_FEE`].
    HighFee,
}

/// Rust's decoding of a payment, shown in the native dialog.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KaspaTxSummary {
    /// Transaction id, hex.
    pub tx_id: String,
    /// Outputs, in order.
    pub outputs: Vec<KaspaOutputView>,
    /// Number of inputs (all ours).
    pub inputs: usize,
    /// Sum of the inputs, sompi.
    pub input_total: String,
    /// Sum of the outputs that do not come back to us, sompi.
    pub sent: String,
    /// Inputs − outputs, sompi.
    pub fee: String,
    /// Masses (grams).
    pub mass: KaspaMass,
    /// Minimum relay fee for this mass, sompi.
    pub minimum_fee: String,
    /// fee ÷ relay mass, sompi per gram (rounded down).
    pub fee_rate: u64,
    /// At least one output comes back to us.
    pub has_change: bool,
    /// Warnings.
    pub warnings: Vec<KaspaWarning>,
    /// Second, reinforced dialog needed.
    pub requires_extra_confirmation: bool,
}

/// Strict decoding of an unsigned or signed payment spending `entries` (`ours`: account keys).
pub fn kaspa_tx_summary(
    net: Network,
    tx: &KaspaTx,
    entries: &[KaspaUtxoEntry],
    ours: &[KaspaOwnKey],
) -> Result<KaspaTxSummary> {
    if tx.version != 0 {
        return Err(Error::input(
            "Kaspa: only version 0 transactions are signed",
        ));
    }
    if tx.subnetwork_id != [0u8; 20] || tx.gas != 0 || !tx.payload.is_empty() {
        return Err(Error::input(
            "Kaspa: subnetwork, gas and payload must be empty",
        ));
    }
    if tx.lock_time != 0 {
        return Err(Error::input("Kaspa: lock time must be 0"));
    }
    if tx.inputs.is_empty() || tx.inputs.len() > KASPA_MAX_INPUTS {
        return Err(Error::input(format!(
            "Kaspa: 1 to {KASPA_MAX_INPUTS} inputs expected"
        )));
    }
    if entries.len() != tx.inputs.len() {
        return Err(Error::input("Kaspa: one UTXO entry per input expected"));
    }
    if tx.outputs.is_empty() || tx.outputs.len() > 2 {
        return Err(Error::input("Kaspa: one or two outputs expected"));
    }
    let our_scripts: Vec<Vec<u8>> = ours.iter().map(KaspaOwnKey::script).collect();
    let mut seen = std::collections::BTreeSet::new();
    let mut input_total = 0u64;
    for (i, (input, entry)) in tx.inputs.iter().zip(entries).enumerate() {
        if !seen.insert(input.outpoint) {
            return Err(Error::input(format!("Kaspa: input {i} spent twice")));
        }
        if input.sequence != 0 || input.sig_op_count != 1 {
            return Err(Error::input(format!(
                "Kaspa: input {i}: sequence 0 and one sig-op expected"
            )));
        }
        if entry.script_version != 0 || !our_scripts.contains(&entry.script) {
            return Err(Error::input(format!(
                "Kaspa: input {i} is not one of this account's coins"
            )));
        }
        input_total = input_total
            .checked_add(entry.amount)
            .ok_or_else(|| Error::input("Kaspa: amount overflow"))?;
    }
    let mut outputs = Vec::with_capacity(tx.outputs.len());
    let mut warnings = Vec::new();
    let mut output_total = 0u64;
    let mut sent = 0u64;
    for (i, o) in tx.outputs.iter().enumerate() {
        if o.value == 0 {
            return Err(Error::input(format!("Kaspa: output {i} is zero")));
        }
        if o.script_version != 0 {
            return Err(Error::input(format!(
                "Kaspa: output {i}: script version must be 0"
            )));
        }
        output_total = output_total
            .checked_add(o.value)
            .ok_or_else(|| Error::input("Kaspa: amount overflow"))?;
        let address = kaspa_address_of_script(net, 0, &o.script);
        let is_change = our_scripts.contains(&o.script);
        if !is_change {
            sent += o.value;
        }
        let kind = if address.is_some() {
            KaspaOutputKind::Address
        } else {
            warnings.push(KaspaWarning::UnknownOutput { index: i });
            KaspaOutputKind::Unknown
        };
        outputs.push(KaspaOutputView {
            address,
            script: hex::encode(&o.script),
            amount: o.value.to_string(),
            is_change,
            kind,
        });
    }
    if output_total > KASPA_MAX_SOMPI {
        return Err(Error::input("Kaspa: amount above the supply"));
    }
    let fee = input_total
        .checked_sub(output_total)
        .ok_or_else(|| Error::input("Kaspa: outputs exceed inputs"))?;
    let mass = kaspa_mass(&kaspa_with_dummy_signatures(tx), entries)?;
    if mass.total > KASPA_MAX_STANDARD_MASS {
        return Err(Error::input(format!(
            "Kaspa: mass {} g above the standard limit {KASPA_MAX_STANDARD_MASS} g",
            mass.total
        )));
    }
    let minimum = mass.minimum_fee();
    if fee < minimum {
        return Err(Error::input(format!(
            "Kaspa: fee {fee} sompi below the minimum relay fee {minimum}"
        )));
    }
    if fee > minimum.saturating_mul(KASPA_HIGH_FEE_FACTOR) || fee > KASPA_HIGH_FEE {
        warnings.push(KaspaWarning::HighFee);
    }
    Ok(KaspaTxSummary {
        tx_id: hex::encode(kaspa_tx_id(tx)?),
        has_change: outputs.iter().any(|o| o.is_change),
        outputs,
        inputs: tx.inputs.len(),
        input_total: input_total.to_string(),
        sent: sent.to_string(),
        fee: fee.to_string(),
        fee_rate: fee / mass.relay.max(1),
        minimum_fee: minimum.to_string(),
        mass,
        requires_extra_confirmation: !warnings.is_empty(),
        warnings,
    })
}

fn verify_input(
    secp: &Secp256k1<All>,
    tx: &KaspaTx,
    entries: &[KaspaUtxoEntry],
    i: usize,
) -> Result<()> {
    let input = &tx.inputs[i];
    let entry = &entries[i];
    let key = match entry.script.as_slice() {
        [0x20, key @ .., 0xac] if key.len() == 32 => key,
        _ => {
            return Err(Error::input(format!(
                "Kaspa: input {i}: not a P2PK Schnorr coin"
            )))
        }
    };
    let sig = match input.signature_script.as_slice() {
        [0x41, sig @ .., SIG_HASH_ALL] if sig.len() == 64 => sig,
        _ => {
            return Err(Error::input(format!(
                "Kaspa: input {i}: signature script is not <sig65 SIGHASH_ALL>"
            )))
        }
    };
    let xonly =
        XOnlyPublicKey::from_slice(key).map_err(|_| Error::input("Kaspa: invalid public key"))?;
    let sig = schnorr::Signature::from_slice(sig)
        .map_err(|_| Error::input("Kaspa: invalid signature encoding"))?;
    let msg = Message::from_digest(kaspa_sighash(tx, entries, i, SIG_HASH_ALL)?);
    secp.verify_schnorr(&sig, &msg, &xonly)
        .map_err(|_| Error::input(format!("Kaspa: input {i}: signature does not verify")))
}

/// Verifies every input's BIP340 signature (`SIG_HASH_ALL`) against its spent coin's key.
pub fn kaspa_verify_signed(tx: &KaspaTx, entries: &[KaspaUtxoEntry]) -> Result<()> {
    if entries.len() != tx.inputs.len() {
        return Err(Error::input("Kaspa: one UTXO entry per input expected"));
    }
    let secp = Secp256k1::new();
    for i in 0..tx.inputs.len() {
        verify_input(&secp, tx, entries, i)?;
    }
    Ok(())
}

/// Signs every input (must spend `account`'s first [`KASPA_SCAN_WINDOW`] keys) after
/// [`kaspa_tx_summary`]; returns the signed tx and its summary.
pub fn kaspa_sign(
    seed: &Seed,
    net: Network,
    account: u32,
    tx: &KaspaTx,
    entries: &[KaspaUtxoEntry],
) -> Result<(KaspaTx, KaspaTxSummary)> {
    let ours = kaspa_own_keys(seed, net, account, KASPA_SCAN_WINDOW)?;
    let summary = kaspa_tx_summary(net, tx, entries, &ours)?;
    let secp = secp()?;
    let acct = account_xpriv(&secp, seed, account)?;
    let mut signed = tx.clone();
    for (i, entry) in entries.iter().enumerate() {
        let own = ours
            .iter()
            .find(|k| k.script() == entry.script)
            .ok_or_else(|| Error::input(format!("Kaspa: input {i} is not ours")))?;
        let child = acct.derive(&secp, &[normal(u32::from(own.change))?, normal(own.index)?])?;
        let mut keypair = Keypair::from_secret_key(&secp, &child.xpriv().private_key);
        if keypair.x_only_public_key().0.serialize() != own.xonly {
            keypair.non_secure_erase();
            return Err(Error::crypto("Kaspa: derived key mismatch"));
        }
        let msg = Message::from_digest(kaspa_sighash(tx, entries, i, SIG_HASH_ALL)?);
        let aux = random32()?;
        let sig = secp.sign_schnorr_with_aux_rand(&msg, &keypair, &aux);
        keypair.non_secure_erase();
        let mut script = Vec::with_capacity(SIGNATURE_SCRIPT_LEN);
        script.push(0x41);
        script.extend_from_slice(&sig.serialize());
        script.push(SIG_HASH_ALL);
        signed.inputs[i].signature_script = script;
        verify_input(&secp, &signed, entries, i)
            .map_err(|_| Error::crypto("signature self-check failed"))?;
    }
    let again = kaspa_tx_summary(net, &signed, entries, &ours)?;
    if again != summary {
        return Err(Error::crypto("Kaspa: summary changed while signing"));
    }
    Ok((signed, summary))
}
