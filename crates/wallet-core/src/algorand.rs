//! Algorand: ed25519 keys at `m/44'/283'/account'/0/0` derived like the **Ledger Algorand
//! app** (Ledger Live), 58-character base32 addresses, and the canonical msgpack encoding of
//! **payment** (`pay`) transactions only.
//!
//! Derivation — the BIP39 seed (64 bytes, PBKDF2 of the phrase) goes through Ledger's
//! BIP32-Ed25519 ("HDW_NORMAL" mode of the Ledger OS for the Ed25519 curve, reference:
//! LedgerHQ/orakolo `HDEd25519.py`):
//! - root: `I = HMAC-SHA512("ed25519 seed", seed)`, re-hashed (`I = HMAC-SHA512("ed25519 seed",
//!   I)`) while the third highest bit of `kL` is set, then clamped; chain code
//!   `HMAC-SHA256("ed25519 seed", 0x01 ‖ seed)`;
//! - children: Khovratovich–Law "V2" hardened derivation (`ed25519-bip32`, the same crate and
//!   scheme as Cardano), hardened `44'/283'/account'` then non-hardened `0/0` (the Ledger app's path);
//! - the 32-byte `kL` of the last node is then used by the Ledger app as a **standard RFC 8032
//!   ed25519 secret key** (it is hashed again with SHA-512 by `cx_eddsa_sign`): Kyro does the
//!   same with `ed25519-dalek`'s `SigningKey`.
//!
//! Checked against the Ledger app's own emulator tests (Zondax `ledger-algorand`,
//! `tests_zemu`: 24-word seed, account 123). **This is not Pera's 25-word format**: a Pera /
//! "Algorand Wallet" 25-word mnemonic encodes one raw ed25519 secret key (11-bit words, its own
//! checksum, no BIP39, no derivation) and cannot be imported into Kyro; a Kyro phrase restored in
//! Ledger Live (Algorand app) gives the same addresses, a 25-word phrase never does.
//!
//! Cryptography (none written here): HMAC-SHA512 / HMAC-SHA256 (RustCrypto `hmac`, `sha2`),
//! `ed25519-bip32` (child derivation), `ed25519-dalek` (signatures, `verify_strict`),
//! SHA-512/256 (RustCrypto `sha2`, address checksum and transaction id), base32 (`data-encoding`).
//!
//! Encoding: hand-written for the `pay` subset, as Algorand's canonical msgpack ("canonical
//! encoding": map keys sorted, empty / zero fields omitted, smallest integer and length forms).
//! A blob is accepted **only if re-encoding the decoded transaction gives back the same bytes**
//! (no unknown field, no duplicate, no other order or form). Signing message: `"TX" ‖ msgpack`;
//! transaction id: `base32(SHA-512/256("TX" ‖ msgpack))`. Tested byte for byte against the
//! official py-algorand-sdk fixtures (signed payment and transaction id).

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
/// Fees above 0.01 ALGO (ten times the usual) need a reinforced confirmation.
const HIGH_FEE: u64 = 10_000;
/// Longest note text shown in the dialog (characters).
const MAX_NOTE_TEXT: usize = 256;
/// Largest unsigned / signed blob accepted (a payment with a full note is ≈ 1.3 kB).
const MAX_BLOB: usize = 2_048;
/// Bounded re-hashing of the root key (each round succeeds with probability 1/2).
const MAX_ROOT_ROUNDS: usize = 256;

/// Mainnet genesis id and hash (base64), as returned by algod `/v2/transactions/params`.
pub const ALGO_MAINNET_GENESIS: (&str, &str) =
    ("mainnet-v1.0", "wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=");
/// Testnet genesis id and hash (base64).
pub const ALGO_TESTNET_GENESIS: (&str, &str) =
    ("testnet-v1.0", "SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=");

fn bad(msg: impl Into<String>) -> Error {
    Error::input(format!("transaction Algorand : {}", msg.into()))
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

// ---------------------------------------------------------------------------------------------
// Keys and addresses
// ---------------------------------------------------------------------------------------------

/// Path of the key of Algorand account `account`: `m/44'/283'/account'/0/0` (Ledger).
pub fn algo_path(account: u32) -> String {
    format!("m/44'/283'/{account}'/0/0")
}

fn hmac512(key: &[u8], data: &[u8]) -> Result<Zeroizing<[u8; 64]>> {
    let mut mac = <Hmac<Sha512> as Mac>::new_from_slice(key)
        .map_err(|_| Error::crypto("HMAC-SHA512 key"))?;
    mac.update(data);
    let mut out = Zeroizing::new([0u8; 64]);
    out.copy_from_slice(&mac.finalize().into_bytes());
    Ok(out)
}

fn hmac256(key: &[u8], data: &[&[u8]]) -> Result<Zeroizing<[u8; 32]>> {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key)
        .map_err(|_| Error::crypto("HMAC-SHA256 key"))?;
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
            return Err(Error::crypto("clé racine Algorand introuvable"));
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

/// Address of a 32-byte public key: `base32(pk ‖ last 4 bytes of SHA-512/256(pk))`, 58
/// characters without padding.
pub fn algo_address_of_pubkey(pk: &[u8; 32]) -> String {
    let mut data = [0u8; 36];
    data[..32].copy_from_slice(pk);
    data[32..].copy_from_slice(&checksum(pk));
    BASE32_NOPAD.encode(&data)
}

/// The 32 bytes of an address (a public key, or the hash of a program / an application
/// account: not necessarily a curve point). Refused: anything but 58 upper-case base32
/// characters with a valid checksum.
pub fn algo_address_bytes(address: &str) -> Result<[u8; 32]> {
    let a = address.trim();
    let invalid = || Error::input("adresse Algorand invalide");
    if a.len() != 58 {
        return Err(invalid());
    }
    let raw = BASE32_NOPAD
        .decode(a.as_bytes())
        .map_err(|_| invalid())?;
    let raw: [u8; 36] = raw.try_into().map_err(|_| invalid())?;
    let mut pk = [0u8; 32];
    pk.copy_from_slice(&raw[..32]);
    if raw[32..] != checksum(&pk) {
        return Err(Error::input("adresse Algorand invalide (somme de contrôle)"));
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

// ---------------------------------------------------------------------------------------------
// Canonical msgpack (payment subset)
// ---------------------------------------------------------------------------------------------

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
    // At most 14 entries here: always a fixmap.
    o.push(0x80 | n as u8);
}

fn take<'a>(b: &mut &'a [u8], n: usize) -> Result<&'a [u8]> {
    if b.len() < n {
        return Err(bad("tronquée"));
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
        _ => return Err(bad("entier attendu")),
    })
}

fn read_str<'a>(b: &mut &'a [u8]) -> Result<&'a str> {
    let t = take(b, 1)?[0];
    let len = match t {
        0xA0..=0xBF => usize::from(t & 0x1F),
        0xD9 => be(take(b, 1)?) as usize,
        0xDA => be(take(b, 2)?) as usize,
        _ => return Err(bad("texte attendu")),
    };
    core::str::from_utf8(take(b, len)?).map_err(|_| bad("texte non UTF-8"))
}

fn read_bin<'a>(b: &mut &'a [u8]) -> Result<&'a [u8]> {
    let t = take(b, 1)?[0];
    let len = match t {
        0xC4 => be(take(b, 1)?) as usize,
        0xC5 => be(take(b, 2)?) as usize,
        _ => return Err(bad("octets attendus")),
    };
    take(b, len)
}

fn read_32(b: &mut &[u8], what: &str) -> Result<[u8; 32]> {
    read_bin(b)?
        .try_into()
        .map_err(|_| bad(format!("{what} : 32 octets attendus")))
}

fn read_map(b: &mut &[u8]) -> Result<usize> {
    let t = take(b, 1)?[0];
    match t {
        0x80..=0x8F => Ok(usize::from(t & 0x0F)),
        _ => Err(bad("objet msgpack attendu")),
    }
}

/// A payment (`type = "pay"`) transaction. `close_remainder_to`, `rekey_to`, `group` and
/// `lease` are decoded only so that they can be **refused** with a clear message.
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
}

fn nonzero(x: &Option<[u8; 32]>) -> Option<&[u8; 32]> {
    x.as_ref().filter(|v| **v != [0u8; 32])
}

impl AlgoPayment {
    /// Canonical msgpack of the transaction (the `txn` object), keys sorted, empty fields
    /// omitted.
    pub fn encode(&self) -> Vec<u8> {
        let close = nonzero(&self.close_remainder_to);
        let group = nonzero(&self.group);
        let lease = nonzero(&self.lease);
        let rekey = nonzero(&self.rekey_to);
        let gh = (self.genesis_hash != [0u8; 32]).then_some(&self.genesis_hash);
        let rcv = (self.receiver != [0u8; 32]).then_some(&self.receiver);
        let snd = (self.sender != [0u8; 32]).then_some(&self.sender);
        let n = [
            self.amount != 0,
            close.is_some(),
            self.fee != 0,
            self.first_valid != 0,
            !self.genesis_id.is_empty(),
            gh.is_some(),
            group.is_some(),
            self.last_valid != 0,
            lease.is_some(),
            !self.note.is_empty(),
            rcv.is_some(),
            rekey.is_some(),
            snd.is_some(),
            true, // type
        ]
        .iter()
        .filter(|x| **x)
        .count();
        let mut o = Vec::with_capacity(256 + self.note.len());
        put_map(&mut o, n);
        if self.amount != 0 {
            put_str(&mut o, "amt");
            put_uint(&mut o, self.amount);
        }
        if let Some(c) = close {
            put_str(&mut o, "close");
            put_bin(&mut o, c);
        }
        if self.fee != 0 {
            put_str(&mut o, "fee");
            put_uint(&mut o, self.fee);
        }
        if self.first_valid != 0 {
            put_str(&mut o, "fv");
            put_uint(&mut o, self.first_valid);
        }
        if !self.genesis_id.is_empty() {
            put_str(&mut o, "gen");
            put_str(&mut o, &self.genesis_id);
        }
        if let Some(h) = gh {
            put_str(&mut o, "gh");
            put_bin(&mut o, h);
        }
        if let Some(g) = group {
            put_str(&mut o, "grp");
            put_bin(&mut o, g);
        }
        if self.last_valid != 0 {
            put_str(&mut o, "lv");
            put_uint(&mut o, self.last_valid);
        }
        if let Some(l) = lease {
            put_str(&mut o, "lx");
            put_bin(&mut o, l);
        }
        if !self.note.is_empty() {
            put_str(&mut o, "note");
            put_bin(&mut o, &self.note);
        }
        if let Some(r) = rcv {
            put_str(&mut o, "rcv");
            put_bin(&mut o, r);
        }
        if let Some(r) = rekey {
            put_str(&mut o, "rekey");
            put_bin(&mut o, r);
        }
        if let Some(s) = snd {
            put_str(&mut o, "snd");
            put_bin(&mut o, s);
        }
        put_str(&mut o, "type");
        put_str(&mut o, "pay");
        o
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
        };
        let mut ty = None;
        for _ in 0..n {
            match read_str(b)? {
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
                        "champ inconnu « {} » : refusé",
                        name.escape_default()
                    )));
                }
            }
        }
        match ty.as_deref() {
            Some("pay") => Ok(p),
            Some(t) => {
                let t: String = t.chars().take(16).collect();
                Err(bad(format!(
                    "type « {} » refusé : seuls les paiements ALGO (pay) sont pris en charge",
                    t.escape_default()
                )))
            }
            None => Err(bad("type absent")),
        }
    }

    /// Strict decoding of an unsigned transaction (`txn` object). Refused: any other type, any
    /// unknown field, trailing bytes, and any encoding that does not re-encode identically.
    pub fn decode(raw: &[u8]) -> Result<AlgoPayment> {
        if raw.len() > MAX_BLOB {
            return Err(bad("trop grande"));
        }
        let mut b = raw;
        let p = AlgoPayment::read(&mut b)?;
        if !b.is_empty() {
            return Err(bad("octets en trop après la transaction"));
        }
        if p.encode() != raw {
            return Err(bad(
                "encodage non canonique (ordre, doublon, champ vide ou forme inattendue)",
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

/// Canonical msgpack of a signed transaction `{ "sig": …, "txn": … }` (what algod's
/// `POST /v2/transactions` takes).
pub fn algo_encode_signed(p: &AlgoPayment, sig: &[u8; 64]) -> Vec<u8> {
    let mut o = Vec::new();
    put_map(&mut o, 2);
    put_str(&mut o, "sig");
    put_bin(&mut o, sig);
    put_str(&mut o, "txn");
    o.extend(p.encode());
    o
}

/// Strict decoding of a signed transaction: exactly `sig` (64 bytes) and `txn`, nothing else
/// (no `sgnr`, `msig`, `lsig`), identical re-encoding.
pub fn algo_decode_signed(raw: &[u8]) -> Result<(AlgoPayment, [u8; 64])> {
    if raw.len() > MAX_BLOB {
        return Err(bad("trop grande"));
    }
    let mut b = raw;
    if read_map(&mut b)? != 2 {
        return Err(bad("transaction signée : exactement sig et txn attendus"));
    }
    if read_str(&mut b)? != "sig" {
        return Err(bad("transaction signée : sig attendu (multisig, lsig, sgnr refusés)"));
    }
    let sig: [u8; 64] = read_bin(&mut b)?
        .try_into()
        .map_err(|_| bad("signature : 64 octets attendus"))?;
    if read_str(&mut b)? != "txn" {
        return Err(bad("transaction signée : txn attendu"));
    }
    let p = AlgoPayment::read(&mut b)?;
    if !b.is_empty() || algo_encode_signed(&p, &sig) != raw {
        return Err(bad("transaction signée non canonique"));
    }
    Ok((p, sig))
}

// ---------------------------------------------------------------------------------------------
// Summary and signing
// ---------------------------------------------------------------------------------------------

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
}

fn summarize(p: &AlgoPayment, net: Network, our_address: &str) -> Result<AlgoTxSummary> {
    if p.close_remainder_to.is_some() {
        return Err(bad(
            "close-remainder-to refusé : il enverrait TOUT le solde restant à une autre adresse et fermerait le compte",
        ));
    }
    if p.rekey_to.is_some() {
        return Err(bad(
            "rekey refusé : il donnerait le contrôle de ce compte à une autre clé",
        ));
    }
    if p.group.is_some() {
        return Err(bad(
            "transaction groupée (grp) refusée : Kyro ne signe que des paiements isolés",
        ));
    }
    if p.lease.is_some() {
        return Err(bad("bail (lx) non pris en charge : refusé"));
    }
    if p.sender != algo_address_bytes(our_address)? {
        return Err(bad("l'expéditeur n'est pas l'adresse de ce portefeuille"));
    }
    let (gen, gh) = algo_genesis(net)?;
    if p.genesis_id != gen || p.genesis_hash != gh {
        return Err(bad(format!(
            "réseau inattendu (« {} ») : ce portefeuille est sur {gen}",
            p.genesis_id.chars().take(32).collect::<String>().escape_default()
        )));
    }
    if p.receiver == [0u8; 32] {
        return Err(bad("destinataire nul (adresse zéro) : refusé"));
    }
    if p.receiver == p.sender {
        return Err(bad("paiement à soi-même"));
    }
    if p.amount == 0 {
        return Err(bad("montant nul"));
    }
    if p.fee < ALGO_MIN_FEE {
        return Err(bad("frais sous le minimum du protocole (0,001 ALGO)"));
    }
    if p.first_valid == 0 || p.last_valid < p.first_valid {
        return Err(bad("fenêtre de validité invalide"));
    }
    if p.last_valid - p.first_valid > ALGO_MAX_VALIDITY {
        return Err(bad("fenêtre de validité de plus de 1000 rounds"));
    }
    if p.note.len() > ALGO_MAX_NOTE {
        return Err(bad("note de plus de 1024 octets"));
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
        receiver: algo_address_of_pubkey(&p.receiver),
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
    })
}

fn unhex(blob_hex: &str) -> Result<Vec<u8>> {
    let s = blob_hex.trim();
    if s.len() > 2 * MAX_BLOB {
        return Err(bad("trop grande"));
    }
    hex::decode(s).map_err(|_| Error::input("le blob n'est pas en hexadécimal"))
}

/// Decodes an **unsigned** payment (msgpack, hex) for the dialog, on network `net`. Refused:
/// anything [`AlgoPayment::decode`] refuses, `close-remainder-to`, `rekey`, `grp`, `lx`, a
/// sender other than `our_address`, another network (genesis id or hash), a zero / own
/// receiver, a zero amount, a fee under the protocol minimum, an invalid or > 1000-round
/// validity window, a note over 1024 bytes.
pub fn algo_decode_tx(blob_hex: &str, net: Network, our_address: &str) -> Result<AlgoTxSummary> {
    let p = AlgoPayment::decode(&unhex(blob_hex)?)?;
    summarize(&p, net, our_address)
}

/// Signs an unsigned payment (hex) with the key of account `account` after decoding it like
/// [`algo_decode_tx`]. Returns `(signed transaction hex, transaction id, summary)`; the
/// signature is verified (`verify_strict`) before it is returned.
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
        .map_err(|_| Error::crypto("échec de la vérification de la signature"))?;
    let signed = algo_encode_signed(&p, &sig.to_bytes());
    Ok((hex::encode(signed), p.txid(), summary))
}

/// Checks a signed transaction (hex) before it is broadcast: strict decoding, policy of
/// [`algo_decode_tx`] for the sender `our_address` on `net`, and a valid (`verify_strict`)
/// signature by the sender's key. Returns the transaction id and the raw bytes to submit.
pub fn algo_verify_signed(
    signed_hex: &str,
    net: Network,
    our_address: &str,
) -> Result<(String, Vec<u8>)> {
    let raw = unhex(signed_hex)?;
    let (p, sig) = algo_decode_signed(&raw)?;
    summarize(&p, net, our_address)?;
    let vk = VerifyingKey::from_bytes(&p.sender).map_err(|_| bad("clé de l'expéditeur"))?;
    vk.verify_strict(&p.signing_bytes(), &Signature::from_bytes(&sig))
        .map_err(|_| bad("la signature ne se vérifie pas"))?;
    Ok((p.txid(), raw))
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
