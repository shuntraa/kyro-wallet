//! Algorand: ed25519 at `m/44'/283'/account'/0/0` (Ledger app derivation), base32 addresses, and
//! canonical msgpack of `pay` and `axfer` of [`algo_known_assets`] (opt-in and plain transfers).

use base64::Engine as _;
use data_encoding::BASE32_NOPAD;
use ed25519_bip32::{DerivationScheme, XPrv};
use ed25519_dalek::{Signature, Signer as _, SigningKey, VerifyingKey};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256, Sha512, Sha512_256};
use zeroize::Zeroizing;

use crate::display::sanitize_text;
use crate::error::{Error, Result};
use crate::mnemonic::Seed;
use crate::network::Network;

const HARDENED: u32 = 0x8000_0000;
/// SLIP-44 coin type of Algorand.
const COIN: u32 = 283;
/// Protocol minimum fee per transaction, µALGO.
pub const ALGO_MIN_FEE: u64 = 1_000;
/// Minimum balance of an account without assets or applications, µALGO (0.1 ALGO).
pub const ALGO_MIN_BALANCE: u64 = 100_000;
/// Largest note the protocol accepts, bytes.
pub const ALGO_MAX_NOTE: usize = 1_024;
/// Largest validity window (`lv − fv`) the protocol accepts, rounds.
pub const ALGO_MAX_VALIDITY: u64 = 1_000;
const HIGH_FEE: u64 = 10_000;
const MAX_NOTE_TEXT: usize = 256;
const MAX_BLOB: usize = 2_048;
const MAX_ROOT_ROUNDS: usize = 256;

/// Mainnet genesis id and hash (base64), as returned by algod `/v2/transactions/params`.
pub const ALGO_MAINNET_GENESIS: (&str, &str) = (
    "mainnet-v1.0",
    "wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
);
/// Testnet genesis id and hash (base64).
pub const ALGO_TESTNET_GENESIS: (&str, &str) = (
    "testnet-v1.0",
    "SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=",
);

fn bad(msg: impl Into<String>) -> Error {
    Error::input(format!("Algorand transaction: {}", msg.into()))
}

/// Genesis id and 32-byte genesis hash of `net` (Algorand mainnet / testnet).
pub fn algo_genesis(net: Network) -> Result<(&'static str, [u8; 32])> {
    let (id, b64) = match net {
        Network::Mainnet => ALGO_MAINNET_GENESIS,
        Network::Testnet => ALGO_TESTNET_GENESIS,
    };
    let hash = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .ok()
        .and_then(|v| <[u8; 32]>::try_from(v).ok())
        .ok_or_else(|| Error::crypto("genesis hash constant"))?;
    Ok((id, hash))
}

/// Path of the key of Algorand account `account`: `m/44'/283'/account'/0/0` (Ledger).
pub fn algo_path(account: u32) -> String {
    format!("m/44'/283'/{account}'/0/0")
}

fn hmac512(key: &[u8], data: &[u8]) -> Result<Zeroizing<[u8; 64]>> {
    let mut mac =
        <Hmac<Sha512> as Mac>::new_from_slice(key).map_err(|_| Error::crypto("HMAC-SHA512 key"))?;
    mac.update(data);
    let mut out = Zeroizing::new([0u8; 64]);
    out.copy_from_slice(&mac.finalize().into_bytes());
    Ok(out)
}

fn hmac256(key: &[u8], data: &[&[u8]]) -> Result<Zeroizing<[u8; 32]>> {
    let mut mac =
        <Hmac<Sha256> as Mac>::new_from_slice(key).map_err(|_| Error::crypto("HMAC-SHA256 key"))?;
    for d in data {
        mac.update(d);
    }
    let mut out = Zeroizing::new([0u8; 32]);
    out.copy_from_slice(&mac.finalize().into_bytes());
    Ok(out)
}

/// Root node of the Ledger OS BIP32-Ed25519 derivation (see the module documentation).
fn ledger_root(seed: &Seed) -> Result<XPrv> {
    const KEY: &[u8] = b"ed25519 seed";
    let chain_code = hmac256(KEY, &[&[0x01u8][..], &seed[..]])?;
    let mut i = hmac512(KEY, &seed[..])?;
    let mut rounds = 0;
    while i[31] & 0b0010_0000 != 0 {
        rounds += 1;
        if rounds > MAX_ROOT_ROUNDS {
            return Err(Error::crypto("Algorand root key not found"));
        }
        let next = hmac512(KEY, &i[..])?;
        i = next;
    }
    i[0] &= 0b1111_1000;
    i[31] &= 0b0111_1111;
    i[31] |= 0b0100_0000;
    Ok(XPrv::from_extended_and_chaincode(&i, &chain_code))
}

/// Signing key of account `account` (`m/44'/283'/account'/0/0`); zeroized on drop.
fn signing_key(seed: &Seed, account: u32) -> Result<SigningKey> {
    if account >= HARDENED {
        return Err(Error::input("derivation index must be < 2^31"));
    }
    let mut node = ledger_root(seed)?;
    for i in [44 | HARDENED, COIN | HARDENED, account | HARDENED, 0, 0] {
        node = node.derive(DerivationScheme::V2, i);
    }
    let mut kl = Zeroizing::new([0u8; 32]);
    kl.copy_from_slice(&node.extended_secret_key_bytes()[..32]);
    Ok(SigningKey::from_bytes(&kl))
}

fn checksum(pk: &[u8; 32]) -> [u8; 4] {
    let h = Sha512_256::digest(pk);
    let mut out = [0u8; 4];
    out.copy_from_slice(&h[28..32]);
    out
}

/// Address of a public key: `base32(pk ‖ last 4 bytes of SHA-512/256(pk))`, 58 chars, unpadded.
pub fn algo_address_of_pubkey(pk: &[u8; 32]) -> String {
    let mut data = [0u8; 36];
    data[..32].copy_from_slice(pk);
    data[32..].copy_from_slice(&checksum(pk));
    BASE32_NOPAD.encode(&data)
}

/// The 32 bytes of an address (key or program/app hash: not necessarily a curve point).
pub fn algo_address_bytes(address: &str) -> Result<[u8; 32]> {
    let a = address.trim();
    let invalid = || Error::input("invalid Algorand address");
    if a.len() != 58 {
        return Err(invalid());
    }
    let raw = BASE32_NOPAD.decode(a.as_bytes()).map_err(|_| invalid())?;
    let raw: [u8; 36] = raw.try_into().map_err(|_| invalid())?;
    let mut pk = [0u8; 32];
    pk.copy_from_slice(&raw[..32]);
    if raw[32..] != checksum(&pk) {
        return Err(Error::input("invalid Algorand address (checksum)"));
    }
    if algo_address_of_pubkey(&pk) != a {
        return Err(invalid());
    }
    Ok(pk)
}

/// Public key of account `account`.
pub fn algo_public_key(seed: &Seed, account: u32) -> Result<[u8; 32]> {
    Ok(signing_key(seed, account)?.verifying_key().to_bytes())
}

/// Address of account `account` (`m/44'/283'/account'/0/0`, see [`algo_path`]).
pub fn algo_address(seed: &Seed, account: u32) -> Result<String> {
    Ok(algo_address_of_pubkey(&algo_public_key(seed, account)?))
}

fn put_uint(o: &mut Vec<u8>, v: u64) {
    if v < 0x80 {
        o.push(v as u8);
    } else if v <= 0xFF {
        o.extend_from_slice(&[0xCC, v as u8]);
    } else if v <= 0xFFFF {
        o.push(0xCD);
        o.extend_from_slice(&(v as u16).to_be_bytes());
    } else if v <= 0xFFFF_FFFF {
        o.push(0xCE);
        o.extend_from_slice(&(v as u32).to_be_bytes());
    } else {
        o.push(0xCF);
        o.extend_from_slice(&v.to_be_bytes());
    }
}

fn put_str(o: &mut Vec<u8>, s: &str) {
    let l = s.len();
    if l <= 31 {
        o.push(0xA0 | l as u8);
    } else if l <= 0xFF {
        o.extend_from_slice(&[0xD9, l as u8]);
    } else {
        o.push(0xDA);
        o.extend_from_slice(&(l as u16).to_be_bytes());
    }
    o.extend_from_slice(s.as_bytes());
}

fn put_bin(o: &mut Vec<u8>, b: &[u8]) {
    let l = b.len();
    if l <= 0xFF {
        o.extend_from_slice(&[0xC4, l as u8]);
    } else {
        o.push(0xC5);
        o.extend_from_slice(&(l as u16).to_be_bytes());
    }
    o.extend_from_slice(b);
}

fn put_map(o: &mut Vec<u8>, n: usize) {
    if n <= 15 {
        o.push(0x80 | n as u8);
    } else {
        // An asset transfer with every field set has 16 entries: map16.
        o.push(0xDE);
        o.extend_from_slice(&(n as u16).to_be_bytes());
    }
}

type Entry = (&'static str, Vec<u8>);

fn e_uint(f: &mut Vec<Entry>, k: &'static str, v: u64) {
    if v != 0 {
        let mut o = Vec::new();
        put_uint(&mut o, v);
        f.push((k, o));
    }
}

fn e_bin(f: &mut Vec<Entry>, k: &'static str, v: Option<&[u8]>) {
    if let Some(v) = v.filter(|v| !v.is_empty()) {
        let mut o = Vec::new();
        put_bin(&mut o, v);
        f.push((k, o));
    }
}

fn e_str(f: &mut Vec<Entry>, k: &'static str, v: &str) {
    if !v.is_empty() {
        let mut o = Vec::new();
        put_str(&mut o, v);
        f.push((k, o));
    }
}

fn write_map(mut f: Vec<Entry>) -> Vec<u8> {
    f.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
    let mut o = Vec::with_capacity(64 + f.iter().map(|(_, v)| v.len() + 8).sum::<usize>());
    put_map(&mut o, f.len());
    for (k, v) in f {
        put_str(&mut o, k);
        o.extend(v);
    }
    o
}

fn take<'a>(b: &mut &'a [u8], n: usize) -> Result<&'a [u8]> {
    if b.len() < n {
        return Err(bad("truncated"));
    }
    let (head, rest) = b.split_at(n);
    *b = rest;
    Ok(head)
}

fn be(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0u64, |acc, x| (acc << 8) | u64::from(*x))
}

fn read_uint(b: &mut &[u8]) -> Result<u64> {
    let t = take(b, 1)?[0];
    Ok(match t {
        0x00..=0x7F => u64::from(t),
        0xCC => be(take(b, 1)?),
        0xCD => be(take(b, 2)?),
        0xCE => be(take(b, 4)?),
        0xCF => be(take(b, 8)?),
        _ => return Err(bad("integer expected")),
    })
}

fn read_str<'a>(b: &mut &'a [u8]) -> Result<&'a str> {
    let t = take(b, 1)?[0];
    let len = match t {
        0xA0..=0xBF => usize::from(t & 0x1F),
        0xD9 => be(take(b, 1)?) as usize,
        0xDA => be(take(b, 2)?) as usize,
        _ => return Err(bad("text expected")),
    };
    core::str::from_utf8(take(b, len)?).map_err(|_| bad("non-UTF-8 text"))
}

fn read_bin<'a>(b: &mut &'a [u8]) -> Result<&'a [u8]> {
    let t = take(b, 1)?[0];
    let len = match t {
        0xC4 => be(take(b, 1)?) as usize,
        0xC5 => be(take(b, 2)?) as usize,
        _ => return Err(bad("bytes expected")),
    };
    take(b, len)
}

fn read_32(b: &mut &[u8], what: &str) -> Result<[u8; 32]> {
    read_bin(b)?
        .try_into()
        .map_err(|_| bad(format!("{what}: 32 bytes expected")))
}

fn read_map(b: &mut &[u8]) -> Result<usize> {
    let t = take(b, 1)?[0];
    match t {
        0x80..=0x8F => Ok(usize::from(t & 0x0F)),
        0xDE => Ok(be(take(b, 2)?) as usize),
        _ => Err(bad("msgpack object expected")),
    }
}

/// An Algorand Standard Asset Kyro knows (verified id, see `registry.ts` `ALGO_ASSETS`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AlgoKnownAsset {
    /// Asset id (ASA).
    pub id: u64,
    /// Symbol shown by Kyro.
    pub symbol: &'static str,
    /// Name shown by Kyro.
    pub name: &'static str,
    /// Decimals of the asset.
    pub decimals: u8,
}

const MAINNET_ASSETS: &[AlgoKnownAsset] = &[
    AlgoKnownAsset {
        id: 31_566_704,
        symbol: "USDC",
        name: "USD Coin",
        decimals: 6,
    },
    AlgoKnownAsset {
        id: 312_769,
        symbol: "USDT",
        name: "Tether",
        decimals: 6,
    },
];
const TESTNET_ASSETS: &[AlgoKnownAsset] = &[AlgoKnownAsset {
    id: 10_458_941,
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
}];

/// The assets Kyro can opt in to, hold and send on `net`.
pub fn algo_known_assets(net: Network) -> &'static [AlgoKnownAsset] {
    match net {
        Network::Mainnet => MAINNET_ASSETS,
        Network::Testnet => TESTNET_ASSETS,
    }
}

/// The known asset `id` on `net`, if any.
pub fn algo_known_asset(net: Network, id: u64) -> Option<AlgoKnownAsset> {
    algo_known_assets(net).iter().copied().find(|a| a.id == id)
}

/// Fields of an asset transfer (`type = "axfer"`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AlgoAssetTransfer {
    /// `xaid`: asset id.
    pub asset_id: u64,
    /// `aamt`: asset base units (0 for an opt-in).
    pub amount: u64,
    /// `arcv`: receiver (the sender itself for an opt-in).
    pub receiver: [u8; 32],
    /// `aclose`: sends the whole asset balance there and opts out. Refused.
    pub close_to: Option<[u8; 32]>,
    /// `asnd`: clawback source (asset manager only). Refused.
    pub asset_sender: Option<[u8; 32]>,
}

/// A payment (`type = "pay"`) transaction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AlgoPayment {
    /// `amt`, µALGO.
    pub amount: u64,
    /// `close`: sends the whole remaining balance there and closes the account. Refused.
    pub close_remainder_to: Option<[u8; 32]>,
    /// `fee`, µALGO (flat).
    pub fee: u64,
    /// `fv`: first round of validity.
    pub first_valid: u64,
    /// `gen`: genesis id (`mainnet-v1.0`, `testnet-v1.0`).
    pub genesis_id: String,
    /// `gh`: genesis hash.
    pub genesis_hash: [u8; 32],
    /// `grp`: atomic group id. Refused.
    pub group: Option<[u8; 32]>,
    /// `lv`: last round of validity.
    pub last_valid: u64,
    /// `lx`: lease. Refused.
    pub lease: Option<[u8; 32]>,
    /// `note`: free bytes, public for ever (≤ 1024).
    pub note: Vec<u8>,
    /// `rcv`: receiver (zero = omitted on the wire).
    pub receiver: [u8; 32],
    /// `rekey`: gives control of the account to another key. Refused.
    pub rekey_to: Option<[u8; 32]>,
    /// `snd`: sender.
    pub sender: [u8; 32],
    /// `Some`: an `axfer` instead of a payment; the ALGO fields are then zero / absent.
    pub asset: Option<AlgoAssetTransfer>,
}

fn nonzero(x: &Option<[u8; 32]>) -> Option<&[u8; 32]> {
    x.as_ref().filter(|v| **v != [0u8; 32])
}

impl AlgoPayment {
    /// Canonical msgpack of the `txn` object: keys sorted, empty fields omitted.
    pub fn encode(&self) -> Vec<u8> {
        fn z(v: &[u8; 32]) -> Option<&[u8]> {
            (*v != [0u8; 32]).then_some(&v[..])
        }
        fn o32(v: &Option<[u8; 32]>) -> Option<&[u8]> {
            nonzero(v).map(|v| &v[..])
        }
        let mut f: Vec<Entry> = Vec::with_capacity(18);
        e_uint(&mut f, "amt", self.amount);
        e_bin(&mut f, "close", o32(&self.close_remainder_to));
        e_uint(&mut f, "fee", self.fee);
        e_uint(&mut f, "fv", self.first_valid);
        e_str(&mut f, "gen", &self.genesis_id);
        e_bin(&mut f, "gh", z(&self.genesis_hash));
        e_bin(&mut f, "grp", o32(&self.group));
        e_uint(&mut f, "lv", self.last_valid);
        e_bin(&mut f, "lx", o32(&self.lease));
        e_bin(&mut f, "note", Some(self.note.as_slice()));
        e_bin(&mut f, "rcv", z(&self.receiver));
        e_bin(&mut f, "rekey", o32(&self.rekey_to));
        e_bin(&mut f, "snd", z(&self.sender));
        match &self.asset {
            None => e_str(&mut f, "type", "pay"),
            Some(a) => {
                e_str(&mut f, "type", "axfer");
                e_uint(&mut f, "aamt", a.amount);
                e_bin(&mut f, "aclose", o32(&a.close_to));
                e_bin(&mut f, "arcv", z(&a.receiver));
                e_bin(&mut f, "asnd", o32(&a.asset_sender));
                e_uint(&mut f, "xaid", a.asset_id);
            }
        }
        write_map(f)
    }

    fn read(b: &mut &[u8]) -> Result<AlgoPayment> {
        let n = read_map(b)?;
        let mut p = AlgoPayment {
            amount: 0,
            close_remainder_to: None,
            fee: 0,
            first_valid: 0,
            genesis_id: String::new(),
            genesis_hash: [0u8; 32],
            group: None,
            last_valid: 0,
            lease: None,
            note: Vec::new(),
            receiver: [0u8; 32],
            rekey_to: None,
            sender: [0u8; 32],
            asset: None,
        };
        let mut a = AlgoAssetTransfer::default();
        let mut asset_fields = false;
        let mut ty = None;
        for _ in 0..n {
            let key = read_str(b)?;
            if matches!(key, "aamt" | "aclose" | "arcv" | "asnd" | "xaid") {
                asset_fields = true;
            }
            match key {
                "aamt" => a.amount = read_uint(b)?,
                "aclose" => a.close_to = Some(read_32(b, "aclose")?),
                "arcv" => a.receiver = read_32(b, "arcv")?,
                "asnd" => a.asset_sender = Some(read_32(b, "asnd")?),
                "xaid" => a.asset_id = read_uint(b)?,
                "amt" => p.amount = read_uint(b)?,
                "close" => p.close_remainder_to = Some(read_32(b, "close")?),
                "fee" => p.fee = read_uint(b)?,
                "fv" => p.first_valid = read_uint(b)?,
                "gen" => p.genesis_id = read_str(b)?.to_owned(),
                "gh" => p.genesis_hash = read_32(b, "gh")?,
                "grp" => p.group = Some(read_32(b, "grp")?),
                "lv" => p.last_valid = read_uint(b)?,
                "lx" => p.lease = Some(read_32(b, "lx")?),
                "note" => p.note = read_bin(b)?.to_vec(),
                "rcv" => p.receiver = read_32(b, "rcv")?,
                "rekey" => p.rekey_to = Some(read_32(b, "rekey")?),
                "snd" => p.sender = read_32(b, "snd")?,
                "type" => ty = Some(read_str(b)?.to_owned()),
                other => {
                    let name: String = other.chars().take(16).collect();
                    return Err(bad(format!(
                        "unknown field \"{}\": refused",
                        name.escape_default()
                    )));
                }
            }
        }
        match ty.as_deref() {
            Some("pay") if asset_fields => Err(bad("asset fields in an ALGO payment")),
            Some("pay") => Ok(p),
            Some("axfer") => {
                if p.amount != 0 || p.receiver != [0u8; 32] || p.close_remainder_to.is_some() {
                    return Err(bad("ALGO payment fields in an asset transfer"));
                }
                p.asset = Some(a);
                Ok(p)
            }
            Some(t) => {
                let t: String = t.chars().take(16).collect();
                Err(bad(format!(
                    "type \"{}\" refused: only ALGO payments (pay) and transfers of known assets (axfer) are supported",
                    t.escape_default()
                )))
            }
            None => Err(bad("missing type")),
        }
    }

    /// Strict decoding of an unsigned transaction (`txn` object).
    pub fn decode(raw: &[u8]) -> Result<AlgoPayment> {
        if raw.len() > MAX_BLOB {
            return Err(bad("too large"));
        }
        let mut b = raw;
        let p = AlgoPayment::read(&mut b)?;
        if !b.is_empty() {
            return Err(bad("trailing bytes after the transaction"));
        }
        if p.encode() != raw {
            return Err(bad(
                "non-canonical encoding (order, duplicate, empty field or unexpected form)",
            ));
        }
        Ok(p)
    }

    /// Bytes that are signed: `"TX" ‖ msgpack`.
    pub fn signing_bytes(&self) -> Vec<u8> {
        let mut m = b"TX".to_vec();
        m.extend(self.encode());
        m
    }

    /// Transaction id: `base32(SHA-512/256("TX" ‖ msgpack))`, 52 characters.
    pub fn txid(&self) -> String {
        BASE32_NOPAD.encode(&Sha512_256::digest(self.signing_bytes()))
    }
}

/// Canonical msgpack `{ "sig": …, "txn": … }` for algod's `POST /v2/transactions`.
pub fn algo_encode_signed(p: &AlgoPayment, sig: &[u8; 64]) -> Vec<u8> {
    let mut o = Vec::new();
    put_map(&mut o, 2);
    put_str(&mut o, "sig");
    put_bin(&mut o, sig);
    put_str(&mut o, "txn");
    o.extend(p.encode());
    o
}

/// Strict decode of a signed tx: only `sig` and `txn` (no `sgnr`/`msig`/`lsig`), same re-encoding.
pub fn algo_decode_signed(raw: &[u8]) -> Result<(AlgoPayment, [u8; 64])> {
    if raw.len() > MAX_BLOB {
        return Err(bad("too large"));
    }
    let mut b = raw;
    if read_map(&mut b)? != 2 {
        return Err(bad("signed transaction: exactly sig and txn expected"));
    }
    if read_str(&mut b)? != "sig" {
        return Err(bad(
            "signed transaction: sig expected (multisig, lsig, sgnr refused)",
        ));
    }
    let sig: [u8; 64] = read_bin(&mut b)?
        .try_into()
        .map_err(|_| bad("signature: 64 bytes expected"))?;
    if read_str(&mut b)? != "txn" {
        return Err(bad("signed transaction: txn expected"));
    }
    let p = AlgoPayment::read(&mut b)?;
    if !b.is_empty() || algo_encode_signed(&p, &sig) != raw {
        return Err(bad("non-canonical signed transaction"));
    }
    Ok((p, sig))
}

/// Reasons for caution (all of them require the reinforced confirmation).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AlgoWarning {
    /// A note is attached: public for ever on the chain.
    Note,
    /// The note is not valid UTF-8: shown in hexadecimal.
    BinaryNote,
    /// The note text had control / invisible / bidi characters removed or was cut.
    UnusualText,
    /// Fee above 0.01 ALGO.
    HighFee,
}

/// Plain-language summary of a payment, decoded by Rust.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlgoTxSummary {
    /// Sender (always our address, checked).
    pub sender: String,
    /// Receiver.
    pub receiver: String,
    /// µALGO, decimal string.
    pub amount: String,
    /// µALGO, decimal string.
    pub fee: String,
    /// First valid round.
    pub first_valid: u64,
    /// Last valid round: the transaction is void after it.
    pub last_valid: u64,
    /// Genesis id (`mainnet-v1.0` / `testnet-v1.0`), checked against the app's network.
    pub genesis_id: String,
    /// Genesis hash, base64, checked.
    pub genesis_hash: String,
    /// Note size in bytes (0 = none).
    pub note_len: usize,
    /// Note, hexadecimal (exact bytes).
    pub note_hex: Option<String>,
    /// Note as text if valid UTF-8, cleaned for display ([`crate::sanitize_text`]).
    pub note_text: Option<String>,
    /// Transaction id.
    pub txid: String,
    /// Reasons for caution.
    pub warnings: Vec<AlgoWarning>,
    /// The confirmation must be followed by a reinforced one.
    pub requires_extra_confirmation: bool,
    /// Known-asset `axfer`; `amount` is then `"0"`, `receiver` the asset receiver (us if opt-in).
    #[serde(default)]
    pub asset: Option<AlgoAssetSummary>,
}

/// Asset part of [`AlgoTxSummary`]: the token as Kyro's table knows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlgoAssetSummary {
    /// Verified asset id (ASA).
    pub asset_id: u64,
    /// Symbol (Kyro's table).
    pub symbol: String,
    /// Name (Kyro's table).
    pub name: String,
    /// Decimals (Kyro's table).
    pub decimals: u8,
    /// Asset base units, decimal string (`"0"` for an opt-in).
    pub amount: String,
    /// 0-amount transfer to ourselves: enables the asset (raises the minimum balance by 0.1 ALGO).
    pub opt_in: bool,
}

fn summarize_asset(
    a: &AlgoAssetTransfer,
    sender: &[u8; 32],
    net: Network,
) -> Result<AlgoAssetSummary> {
    if a.close_to.is_some() {
        return Err(bad(
            "asset-close-to refused: it would send the ENTIRE asset balance to another address and opt out of the asset",
        ));
    }
    if a.asset_sender.is_some() {
        return Err(bad(
            "asset-sender (clawback) refused: reserved for the asset manager",
        ));
    }
    let known = algo_known_asset(net, a.asset_id).ok_or_else(|| {
        bad(format!(
            "unknown asset {}: Kyro signs only the verified tokens in its table",
            a.asset_id
        ))
    })?;
    if a.receiver == [0u8; 32] {
        return Err(bad("null recipient (zero address): refused"));
    }
    let opt_in = a.receiver == *sender;
    if opt_in && a.amount != 0 {
        return Err(bad("asset transfer to yourself"));
    }
    if !opt_in && a.amount == 0 {
        return Err(bad("zero amount"));
    }
    Ok(AlgoAssetSummary {
        asset_id: known.id,
        symbol: known.symbol.into(),
        name: known.name.into(),
        decimals: known.decimals,
        amount: a.amount.to_string(),
        opt_in,
    })
}

fn summarize(p: &AlgoPayment, net: Network, our_address: &str) -> Result<AlgoTxSummary> {
    if p.close_remainder_to.is_some() {
        return Err(bad(
            "close-remainder-to refused: it would send the ENTIRE remaining balance to another address and close the account",
        ));
    }
    if p.rekey_to.is_some() {
        return Err(bad(
            "rekey refused: it would hand control of this account to another key",
        ));
    }
    if p.group.is_some() {
        return Err(bad(
            "grouped transaction (grp) refused: Kyro signs only standalone payments",
        ));
    }
    if p.lease.is_some() {
        return Err(bad("lease (lx) not supported: refused"));
    }
    if p.sender != algo_address_bytes(our_address)? {
        return Err(bad("the sender is not this wallet's address"));
    }
    let (gen, gh) = algo_genesis(net)?;
    if p.genesis_id != gen || p.genesis_hash != gh {
        return Err(bad(format!(
            "unexpected network (\"{}\"): this wallet is on {gen}",
            p.genesis_id
                .chars()
                .take(32)
                .collect::<String>()
                .escape_default()
        )));
    }
    let asset = match &p.asset {
        Some(a) => Some(summarize_asset(a, &p.sender, net)?),
        None => {
            if p.receiver == [0u8; 32] {
                return Err(bad("null recipient (zero address): refused"));
            }
            if p.receiver == p.sender {
                return Err(bad("payment to yourself"));
            }
            if p.amount == 0 {
                return Err(bad("zero amount"));
            }
            None
        }
    };
    let receiver = p.asset.as_ref().map_or(p.receiver, |a| a.receiver);
    if p.fee < ALGO_MIN_FEE {
        return Err(bad("fee below the protocol minimum (0.001 ALGO)"));
    }
    if p.first_valid == 0 || p.last_valid < p.first_valid {
        return Err(bad("invalid validity window"));
    }
    if p.last_valid - p.first_valid > ALGO_MAX_VALIDITY {
        return Err(bad("validity window longer than 1000 rounds"));
    }
    if p.note.len() > ALGO_MAX_NOTE {
        return Err(bad("note longer than 1024 bytes"));
    }
    let mut warnings = Vec::new();
    let (mut note_hex, mut note_text) = (None, None);
    if !p.note.is_empty() {
        warnings.push(AlgoWarning::Note);
        note_hex = Some(hex::encode(&p.note));
        match core::str::from_utf8(&p.note) {
            Ok(t) => {
                let clean = sanitize_text(t, MAX_NOTE_TEXT);
                if clean.altered {
                    warnings.push(AlgoWarning::UnusualText);
                }
                note_text = Some(clean.text);
            }
            Err(_) => warnings.push(AlgoWarning::BinaryNote),
        }
    }
    if p.fee > HIGH_FEE {
        warnings.push(AlgoWarning::HighFee);
    }
    Ok(AlgoTxSummary {
        sender: algo_address_of_pubkey(&p.sender),
        receiver: algo_address_of_pubkey(&receiver),
        amount: p.amount.to_string(),
        fee: p.fee.to_string(),
        first_valid: p.first_valid,
        last_valid: p.last_valid,
        genesis_id: p.genesis_id.clone(),
        genesis_hash: base64::engine::general_purpose::STANDARD.encode(p.genesis_hash),
        note_len: p.note.len(),
        note_hex,
        note_text,
        txid: p.txid(),
        requires_extra_confirmation: !warnings.is_empty(),
        warnings,
        asset,
    })
}

fn unhex(blob_hex: &str) -> Result<Vec<u8>> {
    let s = blob_hex.trim();
    if s.len() > 2 * MAX_BLOB {
        return Err(bad("too large"));
    }
    hex::decode(s).map_err(|_| Error::input("the blob is not hexadecimal"))
}

/// Decodes an **unsigned** payment (msgpack, hex) for the dialog, on network `net`.
pub fn algo_decode_tx(blob_hex: &str, net: Network, our_address: &str) -> Result<AlgoTxSummary> {
    let p = AlgoPayment::decode(&unhex(blob_hex)?)?;
    summarize(&p, net, our_address)
}

/// Signs an unsigned payment (hex) with `account`'s key after [`algo_decode_tx`].
pub fn algo_sign(
    seed: &Seed,
    account: u32,
    net: Network,
    blob_hex: &str,
) -> Result<(String, String, AlgoTxSummary)> {
    let key = signing_key(seed, account)?;
    let vk = key.verifying_key();
    let ours = algo_address_of_pubkey(&vk.to_bytes());
    let p = AlgoPayment::decode(&unhex(blob_hex)?)?;
    let summary = summarize(&p, net, &ours)?;
    let msg = p.signing_bytes();
    let sig = key.sign(&msg);
    vk.verify_strict(&msg, &sig)
        .map_err(|_| Error::crypto("signature verification failed"))?;
    let signed = algo_encode_signed(&p, &sig.to_bytes());
    Ok((hex::encode(signed), p.txid(), summary))
}

/// Pre-broadcast check: strict decode, [`algo_decode_tx`] policy for `our_address`, strict sig.
pub fn algo_verify_signed(
    signed_hex: &str,
    net: Network,
    our_address: &str,
) -> Result<(String, Vec<u8>)> {
    let raw = unhex(signed_hex)?;
    let (p, sig) = algo_decode_signed(&raw)?;
    summarize(&p, net, our_address)?;
    let vk = VerifyingKey::from_bytes(&p.sender).map_err(|_| bad("sender key"))?;
    vk.verify_strict(&p.signing_bytes(), &Signature::from_bytes(&sig))
        .map_err(|_| bad("the signature does not verify"))?;
    Ok((p.txid(), raw))
}

/// Ledger Algorand app: the strictly decoded msgpack (the app prefixes `TX` itself).
pub fn algo_hw_message(blob_hex: &str) -> Result<Vec<u8>> {
    let p = AlgoPayment::decode(&unhex(blob_hex)?)?;
    if p.asset.is_some() {
        return Err(bad(
            "Algorand tokens: not supported on hardware wallets yet",
        ));
    }
    Ok(p.encode())
}

/// HW: signed tx (hex) and tx id from the device sig, checked like [`algo_verify_signed`].
pub fn algo_hw_signed(
    blob_hex: &str,
    net: Network,
    our_address: &str,
    sig: &[u8],
) -> Result<(String, String)> {
    let sig: [u8; 64] = sig
        .try_into()
        .map_err(|_| bad("device signature: 64 bytes expected"))?;
    let p = AlgoPayment::decode(&unhex(blob_hex)?)?;
    if p.asset.is_some() {
        return Err(bad(
            "Algorand tokens: not supported on hardware wallets yet",
        ));
    }
    let signed = hex::encode(algo_encode_signed(&p, &sig));
    let (txid, _) = algo_verify_signed(&signed, net, our_address)?;
    Ok((signed, txid))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn integer_and_length_forms_are_minimal() {
        for (v, len) in [
            (0u64, 1usize),
            (127, 1),
            (128, 2),
            (255, 2),
            (256, 3),
            (65_535, 3),
            (65_536, 5),
            (u64::from(u32::MAX), 5),
            (u64::from(u32::MAX) + 1, 9),
        ] {
            let mut o = Vec::new();
            put_uint(&mut o, v);
            assert_eq!(o.len(), len, "{v}");
            let mut s = o.as_slice();
            assert_eq!(read_uint(&mut s).unwrap(), v);
        }
        let mut o = Vec::new();
        put_bin(&mut o, &[7u8; 300]);
        assert_eq!(&o[..3], &[0xC5, 0x01, 0x2C]);
        let mut s = o.as_slice();
        assert_eq!(read_bin(&mut s).unwrap().len(), 300);
    }
}
