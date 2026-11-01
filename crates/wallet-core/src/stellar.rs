//! Stellar: SEP-0005 keys (SLIP-10 ed25519 at `m/44'/148'/account'`, the path of every Stellar
//! wallet: Lobstr, Freighter, Ledger, Trezor), `G…` strkey addresses (SEP-0023) and a strict XDR
//! codec for the few transaction shapes Kyro signs.
//!
//! - Strkey: version byte (`6 << 3` = `G`, account) ‖ 32-byte key ‖ CRC16-XModem (little
//!   endian), RFC 4648 base32 without padding. Decoding is **canonical only**: lengths congruent
//!   to 1, 3 or 6 mod 8 and non-zero unused bits are refused, and the result must re-encode to the
//!   same text (SEP-0023's rule).
//! - Signing: `ed25519(SHA-256(networkId ‖ ENVELOPE_TYPE_TX ‖ Transaction XDR))` with
//!   `networkId = SHA-256(network passphrase)`: a transaction signed for the testnet is invalid on
//!   the public network and vice versa. The transaction hash is the same SHA-256.
//!
//! Codec: hand-written for `TransactionEnvelope` v1 with one `CreateAccount`, `Payment` or
//! `ChangeTrust` operation (≈ 15 XDR types). The official `stellar-xdr` crate generates thousands
//! of types (Soroban included) for a format this small. Same safety rule as for XRP and TRON:
//! **an envelope is accepted only if re-encoding the decoded value gives back the same bytes**
//! (no trailing data, zero padding, canonical asset codes, no unknown arm). Tested against real
//! mainnet / testnet envelopes and their Horizon hashes (`tests/stellar.rs`).

use ed25519_dalek::Signer as _;
use ed25519_dalek_bip32::{ChildIndex, ExtendedSigningKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::Zeroize;

use crate::display::sanitize_text;
use crate::error::{Error, Result};
use crate::mnemonic::Seed;
use crate::network::Network;

/// Network passphrase of the public network.
pub const STELLAR_MAINNET_PASSPHRASE: &str = "Public Global Stellar Network ; September 2015";
/// Network passphrase of SDF's test network.
pub const STELLAR_TESTNET_PASSPHRASE: &str = "Test SDF Network ; September 2015";
/// 1 XLM = 10 000 000 stroops.
pub const STROOPS_PER_XLM: i64 = 10_000_000;
/// Fees above 0.01 XLM need a reinforced confirmation (the usual fee is 100 stroops).
pub const STELLAR_HIGH_FEE_STROOPS: u32 = 100_000;
/// Longest memo text (bytes, XDR `string<28>`).
pub const STELLAR_MAX_MEMO_TEXT: usize = 28;
const MAX_ENVELOPE: usize = 4096;
const MAX_OPERATIONS: u32 = 100;
const MAX_SIGNATURES: u32 = 20;

const VERSION_ACCOUNT: u8 = 6 << 3; // G
const VERSION_MUXED: u8 = 12 << 3; // M
const VERSION_SEED: u8 = 18 << 3; // S

const ENVELOPE_TYPE_TX_V0: u32 = 0;
const ENVELOPE_TYPE_TX: u32 = 2;
const ENVELOPE_TYPE_TX_FEE_BUMP: u32 = 5;
const KEY_TYPE_ED25519: u32 = 0;
const KEY_TYPE_MUXED_ED25519: u32 = 0x100;

/// Passphrase of `net` (`Testnet` = SDF's test network, the one Friendbot funds).
pub fn stellar_network_passphrase(net: Network) -> &'static str {
    match net {
        Network::Mainnet => STELLAR_MAINNET_PASSPHRASE,
        Network::Testnet => STELLAR_TESTNET_PASSPHRASE,
    }
}

fn network_id(net: Network) -> [u8; 32] {
    Sha256::digest(stellar_network_passphrase(net).as_bytes()).into()
}

// ---------------------------------------------------------------------------------------------
// Strkey (SEP-0023)
// ---------------------------------------------------------------------------------------------

/// CRC16-XModem (polynomial 0x1021, initial value 0): the strkey checksum.
fn crc16_xmodem(data: &[u8]) -> u16 {
    let mut crc: u16 = 0;
    for b in data {
        crc ^= u16::from(*b) << 8;
        for _ in 0..8 {
            crc = if crc & 0x8000 != 0 {
                (crc << 1) ^ 0x1021
            } else {
                crc << 1
            };
        }
    }
    crc
}

const B32: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

fn base32_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(5) * 8);
    let (mut acc, mut bits) = (0u32, 0u32);
    for b in data {
        acc = (acc << 8) | u32::from(*b);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(char::from(B32[((acc >> bits) & 31) as usize]));
        }
    }
    if bits > 0 {
        out.push(char::from(B32[((acc << (5 - bits)) & 31) as usize]));
    }
    out
}

/// Strict RFC 4648 base32 without padding: refuses impossible lengths and non-zero unused bits.
fn base32_decode(s: &str) -> Option<Vec<u8>> {
    if matches!(s.len() % 8, 1 | 3 | 6) {
        return None;
    }
    let mut out = Vec::with_capacity(s.len() * 5 / 8);
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in s.bytes() {
        let v = B32.iter().position(|x| *x == c)? as u32;
        acc = ((acc << 5) | v) & 0xFFFF;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    if bits > 0 && acc & ((1 << bits) - 1) != 0 {
        return None;
    }
    Some(out)
}

fn strkey_encode(version: u8, payload: &[u8]) -> String {
    let mut data = Vec::with_capacity(payload.len() + 3);
    data.push(version);
    data.extend_from_slice(payload);
    let crc = crc16_xmodem(&data);
    data.extend_from_slice(&crc.to_le_bytes());
    base32_encode(&data)
}

/// `(version byte, payload)` of a canonical strkey.
fn strkey_decode(s: &str) -> Option<(u8, Vec<u8>)> {
    let raw = base32_decode(s)?;
    if raw.len() < 3 {
        return None;
    }
    let (body, sum) = raw.split_at(raw.len() - 2);
    if crc16_xmodem(body).to_le_bytes() != sum {
        return None;
    }
    let (version, payload) = (body[0], body[1..].to_vec());
    // Round trip (SEP-0023): one text per key.
    (strkey_encode(version, &payload) == s).then_some((version, payload))
}

/// `G…` address of a 32-byte ed25519 public key.
pub fn stellar_address_from_key(key: &[u8; 32]) -> String {
    strkey_encode(VERSION_ACCOUNT, key)
}

/// Public key of a `G…` address. Refused with a dedicated message: `M…` muxed addresses (ask
/// for the `G…` address and the memo instead), and a secret key `S…` pasted by mistake.
pub fn stellar_account_id(address: &str) -> Result<[u8; 32]> {
    let a = address.trim();
    match strkey_decode(a) {
        Some((VERSION_ACCOUNT, k)) if k.len() == 32 => {
            let mut out = [0u8; 32];
            out.copy_from_slice(&k);
            Ok(out)
        }
        Some((VERSION_MUXED, k)) if k.len() == 40 => Err(Error::input(
            "les adresses M… (comptes multiplexés) ne sont pas prises en charge : demande l'adresse G… et le mémo",
        )),
        Some((VERSION_SEED, _)) => Err(Error::input(
            "ceci est une CLÉ SECRÈTE Stellar (S…), pas une adresse : ne la donne jamais à personne",
        )),
        _ => Err(Error::input("adresse Stellar invalide (G… attendue)")),
    }
}

/// `(G… address, id)` of an `M…` muxed address (SEP-0023 vectors; Kyro does not send to them).
pub fn stellar_muxed_parts(address: &str) -> Result<(String, u64)> {
    match strkey_decode(address.trim()) {
        Some((VERSION_MUXED, k)) if k.len() == 40 => {
            let mut key = [0u8; 32];
            key.copy_from_slice(&k[..32]);
            let mut id = [0u8; 8];
            id.copy_from_slice(&k[32..]);
            Ok((stellar_address_from_key(&key), u64::from_be_bytes(id)))
        }
        _ => Err(Error::input("adresse M… invalide")),
    }
}

// ---------------------------------------------------------------------------------------------
// Keys (SEP-0005)
// ---------------------------------------------------------------------------------------------

/// Path of Stellar account `account`: `m/44'/148'/account'` (SEP-0005).
pub fn stellar_path(account: u32) -> String {
    format!("m/44'/148'/{account}'")
}

fn signing_key(seed: &Seed, account: u32) -> Result<ed25519_dalek::SigningKey> {
    let h = |i: u32| {
        ChildIndex::hardened(i).map_err(|_| Error::input("derivation index must be < 2^31"))
    };
    let path = [h(44)?, h(148)?, h(account)?];
    let mut root = ExtendedSigningKey::from_seed(&seed[..])
        .map_err(|_| Error::crypto("SLIP-10 master derivation failed"))?;
    let mut child = root
        .derive(&path)
        .map_err(|_| Error::crypto("SLIP-10 derivation failed"))?;
    // `SigningKey` zeroizes itself on drop; the chain codes do not, so wipe them here.
    root.chain_code.zeroize();
    child.chain_code.zeroize();
    Ok(child.signing_key.clone())
}

/// Ed25519 public key of account `account` (`m/44'/148'/account'`).
pub fn stellar_public_key(seed: &Seed, account: u32) -> Result<[u8; 32]> {
    Ok(signing_key(seed, account)?.verifying_key().to_bytes())
}

/// `G…` address of account `account` (`m/44'/148'/account'`).
pub fn stellar_address(seed: &Seed, account: u32) -> Result<String> {
    Ok(stellar_address_from_key(&stellar_public_key(
        seed, account,
    )?))
}

// ---------------------------------------------------------------------------------------------
// XDR model
// ---------------------------------------------------------------------------------------------

/// An `Asset` (or the credit arms of `ChangeTrustAsset`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StellarAsset {
    /// XLM.
    Native,
    /// Issued asset: 1–4 characters = `CREDIT_ALPHANUM4`, 5–12 = `CREDIT_ALPHANUM12`.
    Credit {
        /// Asset code (ASCII letters and digits).
        code: String,
        /// Issuer public key.
        issuer: [u8; 32],
    },
}

/// A credit asset from its code and issuer `G…` address (canonical code checked).
pub fn stellar_asset(code: &str, issuer: &str) -> Result<StellarAsset> {
    let code = code.trim();
    if code.is_empty() || code.len() > 12 || !code.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return Err(Error::input(
            "code d'actif Stellar : 1 à 12 lettres ou chiffres",
        ));
    }
    if code.eq_ignore_ascii_case("XLM") && code.len() == 3 {
        // Valid on chain, but a classic impersonation of the native asset.
        return Err(Error::input(
            "« XLM » émis par un compte n'est pas le XLM natif",
        ));
    }
    Ok(StellarAsset::Credit {
        code: code.to_owned(),
        issuer: stellar_account_id(issuer)?,
    })
}

/// A transaction memo.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StellarMemo {
    /// No memo.
    None,
    /// `MEMO_TEXT`, at most 28 bytes (normally UTF-8).
    Text(Vec<u8>),
    /// `MEMO_ID`, unsigned 64-bit.
    Id(u64),
    /// `MEMO_HASH`, 32 bytes.
    Hash([u8; 32]),
    /// `MEMO_RETURN`, 32 bytes (hash of a refunded transaction).
    Return([u8; 32]),
}

/// The operations Kyro understands.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StellarOperation {
    /// Creates (activates) `destination` with `starting_balance` stroops.
    CreateAccount {
        /// New account.
        destination: [u8; 32],
        /// Stroops.
        starting_balance: i64,
    },
    /// Sends `amount` of `asset` to an existing account.
    Payment {
        /// Recipient.
        destination: [u8; 32],
        /// Asset.
        asset: StellarAsset,
        /// Stroops (7 decimals for every asset).
        amount: i64,
    },
    /// Adds, changes or (limit 0) removes a trustline.
    ChangeTrust {
        /// Credit asset trusted.
        asset: StellarAsset,
        /// Stroops; `i64::MAX` = no limit, 0 = remove the trustline.
        limit: i64,
    },
}

/// An operation and its optional own source account.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StellarOp {
    /// Operation-level source (Kyro never sets it; refused when signing).
    pub source: Option<[u8; 32]>,
    /// Body.
    pub body: StellarOperation,
}

/// A `Transaction` (v1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StellarTransaction {
    /// Source account (plain ed25519 key; muxed sources are refused).
    pub source: [u8; 32],
    /// Maximum total fee, stroops.
    pub fee: u32,
    /// Sequence number (account sequence + 1).
    pub sequence: i64,
    /// `(minTime, maxTime)`, UNIX seconds (`PRECOND_TIME`); `None` = `PRECOND_NONE`.
    pub time_bounds: Option<(u64, u64)>,
    /// Memo.
    pub memo: StellarMemo,
    /// Operations.
    pub operations: Vec<StellarOp>,
}

/// A `DecoratedSignature`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StellarSignature {
    /// Last 4 bytes of the signing public key.
    pub hint: [u8; 4],
    /// Ed25519 signature (64 bytes).
    pub signature: Vec<u8>,
}

/// A `TransactionEnvelope` of type `ENVELOPE_TYPE_TX`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StellarEnvelope {
    /// Transaction.
    pub tx: StellarTransaction,
    /// Signatures (empty before signing).
    pub signatures: Vec<StellarSignature>,
}

// ---------------------------------------------------------------------------------------------
// XDR encoding
// ---------------------------------------------------------------------------------------------

fn put_u32(o: &mut Vec<u8>, v: u32) {
    o.extend_from_slice(&v.to_be_bytes());
}

fn put_var(o: &mut Vec<u8>, data: &[u8]) {
    put_u32(o, data.len() as u32);
    o.extend_from_slice(data);
    o.resize(o.len() + (4 - data.len() % 4) % 4, 0);
}

fn put_account(o: &mut Vec<u8>, key: &[u8; 32]) {
    put_u32(o, KEY_TYPE_ED25519);
    o.extend_from_slice(key);
}

fn put_asset(o: &mut Vec<u8>, a: &StellarAsset) {
    match a {
        StellarAsset::Native => put_u32(o, 0),
        StellarAsset::Credit { code, issuer } => {
            let width = if code.len() <= 4 { 4 } else { 12 };
            put_u32(o, if width == 4 { 1 } else { 2 });
            let mut c = code.as_bytes().to_vec();
            c.resize(width, 0);
            o.extend_from_slice(&c);
            put_account(o, issuer);
        }
    }
}

impl StellarTransaction {
    /// `Transaction` XDR.
    pub fn encode(&self) -> Vec<u8> {
        let mut o = Vec::with_capacity(256);
        put_account(&mut o, &self.source); // MuxedAccount, KEY_TYPE_ED25519 arm
        put_u32(&mut o, self.fee);
        o.extend_from_slice(&self.sequence.to_be_bytes());
        match self.time_bounds {
            None => put_u32(&mut o, 0),
            Some((min, max)) => {
                put_u32(&mut o, 1);
                o.extend_from_slice(&min.to_be_bytes());
                o.extend_from_slice(&max.to_be_bytes());
            }
        }
        match &self.memo {
            StellarMemo::None => put_u32(&mut o, 0),
            StellarMemo::Text(t) => {
                put_u32(&mut o, 1);
                put_var(&mut o, t);
            }
            StellarMemo::Id(id) => {
                put_u32(&mut o, 2);
                o.extend_from_slice(&id.to_be_bytes());
            }
            StellarMemo::Hash(h) => {
                put_u32(&mut o, 3);
                o.extend_from_slice(h);
            }
            StellarMemo::Return(h) => {
                put_u32(&mut o, 4);
                o.extend_from_slice(h);
            }
        }
        put_u32(&mut o, self.operations.len() as u32);
        for op in &self.operations {
            match &op.source {
                None => put_u32(&mut o, 0),
                Some(k) => {
                    put_u32(&mut o, 1);
                    put_account(&mut o, k);
                }
            }
            match &op.body {
                StellarOperation::CreateAccount {
                    destination,
                    starting_balance,
                } => {
                    put_u32(&mut o, 0);
                    put_account(&mut o, destination); // AccountID = PublicKey
                    o.extend_from_slice(&starting_balance.to_be_bytes());
                }
                StellarOperation::Payment {
                    destination,
                    asset,
                    amount,
                } => {
                    put_u32(&mut o, 1);
                    put_account(&mut o, destination); // MuxedAccount
                    put_asset(&mut o, asset);
                    o.extend_from_slice(&amount.to_be_bytes());
                }
                StellarOperation::ChangeTrust { asset, limit } => {
                    put_u32(&mut o, 6);
                    put_asset(&mut o, asset);
                    o.extend_from_slice(&limit.to_be_bytes());
                }
            }
        }
        put_u32(&mut o, 0); // ext: v0 (no Soroban data)
        o
    }

    /// `TransactionSignaturePayload` for `net`: `networkId ‖ ENVELOPE_TYPE_TX ‖ tx`.
    pub fn signature_payload(&self, net: Network) -> Vec<u8> {
        let mut p = network_id(net).to_vec();
        put_u32(&mut p, ENVELOPE_TYPE_TX);
        p.extend(self.encode());
        p
    }

    /// Transaction hash on `net` (what is signed, and what Horizon calls `hash`).
    pub fn hash(&self, net: Network) -> [u8; 32] {
        Sha256::digest(self.signature_payload(net)).into()
    }
}

impl StellarEnvelope {
    /// `TransactionEnvelope` XDR.
    pub fn encode(&self) -> Vec<u8> {
        let mut o = Vec::with_capacity(320);
        put_u32(&mut o, ENVELOPE_TYPE_TX);
        o.extend(self.tx.encode());
        put_u32(&mut o, self.signatures.len() as u32);
        for s in &self.signatures {
            o.extend_from_slice(&s.hint);
            put_var(&mut o, &s.signature);
        }
        o
    }

    /// Base64 of [`StellarEnvelope::encode`] (what Horizon takes).
    pub fn to_base64(&self) -> String {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD.encode(self.encode())
    }

    /// Strict decoding of a base64 envelope (see [`StellarEnvelope::decode`]).
    pub fn from_base64(b64: &str) -> Result<StellarEnvelope> {
        use base64::Engine as _;
        let raw = base64::engine::general_purpose::STANDARD
            .decode(b64.trim())
            .map_err(|_| bad("base64 invalide"))?;
        StellarEnvelope::decode(&raw)
    }

    /// Strict decoding. Refused: v0 and fee-bump envelopes, muxed accounts, `PRECOND_V2`,
    /// Soroban data, any operation other than CreateAccount / Payment / ChangeTrust, pool-share
    /// trustlines, non-canonical asset codes or padding, trailing bytes, and any encoding that
    /// does not re-encode identically.
    pub fn decode(raw: &[u8]) -> Result<StellarEnvelope> {
        if raw.len() > MAX_ENVELOPE {
            return Err(bad("trop grande"));
        }
        let mut r = Reader(raw);
        match r.u32()? {
            ENVELOPE_TYPE_TX => {}
            ENVELOPE_TYPE_TX_V0 => {
                return Err(bad("ancien format d'enveloppe (v0) non pris en charge"))
            }
            ENVELOPE_TYPE_TX_FEE_BUMP => return Err(bad(
                "transaction « fee bump » (frais payés par un autre compte) non prise en charge",
            )),
            t => return Err(bad(format!("type d'enveloppe inconnu ({t})"))),
        }
        let source = r.muxed()?;
        let fee = r.u32()?;
        let sequence = r.i64()?;
        let time_bounds = match r.u32()? {
            0 => None,
            1 => Some((r.u64()?, r.u64()?)),
            2 => {
                return Err(bad(
                    "préconditions avancées (PRECOND_V2) non prises en charge",
                ))
            }
            t => return Err(bad(format!("préconditions inconnues ({t})"))),
        };
        let memo = match r.u32()? {
            0 => StellarMemo::None,
            1 => StellarMemo::Text(r.var(STELLAR_MAX_MEMO_TEXT)?),
            2 => StellarMemo::Id(r.u64()?),
            3 => StellarMemo::Hash(r.fixed32()?),
            4 => StellarMemo::Return(r.fixed32()?),
            t => return Err(bad(format!("type de mémo inconnu ({t})"))),
        };
        let n = r.u32()?;
        if n > MAX_OPERATIONS {
            return Err(bad("trop d'opérations"));
        }
        let mut operations = Vec::with_capacity(n as usize);
        for _ in 0..n {
            let source = match r.u32()? {
                0 => None,
                1 => Some(r.muxed()?),
                _ => return Err(bad("source d'opération mal formée")),
            };
            let body = match r.u32()? {
                0 => StellarOperation::CreateAccount {
                    destination: r.account_id()?,
                    starting_balance: r.i64()?,
                },
                1 => StellarOperation::Payment {
                    destination: r.muxed()?,
                    asset: r.asset(false)?,
                    amount: r.i64()?,
                },
                6 => StellarOperation::ChangeTrust {
                    asset: r.asset(true)?,
                    limit: r.i64()?,
                },
                t => {
                    return Err(bad(format!(
                        "opération « {} » (type {t}) non prise en charge : refusée",
                        op_name(t)
                    )))
                }
            };
            operations.push(StellarOp { source, body });
        }
        match r.u32()? {
            0 => {}
            1 => return Err(bad("transaction Soroban (contrat) non prise en charge")),
            v => return Err(bad(format!("extension de transaction inconnue ({v})"))),
        }
        let n = r.u32()?;
        if n > MAX_SIGNATURES {
            return Err(bad("trop de signatures"));
        }
        let mut signatures = Vec::with_capacity(n as usize);
        for _ in 0..n {
            let mut hint = [0u8; 4];
            hint.copy_from_slice(r.take(4)?);
            signatures.push(StellarSignature {
                hint,
                signature: r.var(64)?,
            });
        }
        if !r.0.is_empty() {
            return Err(bad("octets en trop après l'enveloppe"));
        }
        let env = StellarEnvelope {
            tx: StellarTransaction {
                source,
                fee,
                sequence,
                time_bounds,
                memo,
                operations,
            },
            signatures,
        };
        if env.encode() != raw {
            return Err(bad(
                "encodage non canonique (remplissage, code d'actif ou disposition inconnue)",
            ));
        }
        Ok(env)
    }
}

fn op_name(t: u32) -> &'static str {
    match t {
        2 => "PathPaymentStrictReceive",
        3 => "ManageSellOffer",
        4 => "CreatePassiveSellOffer",
        5 => "SetOptions",
        7 => "AllowTrust",
        8 => "AccountMerge",
        9 => "Inflation",
        10 => "ManageData",
        11 => "BumpSequence",
        12 => "ManageBuyOffer",
        13 => "PathPaymentStrictSend",
        14 => "CreateClaimableBalance",
        15 => "ClaimClaimableBalance",
        16 => "BeginSponsoringFutureReserves",
        17 => "EndSponsoringFutureReserves",
        18 => "RevokeSponsorship",
        19 => "Clawback",
        20 => "ClawbackClaimableBalance",
        21 => "SetTrustLineFlags",
        22 => "LiquidityPoolDeposit",
        23 => "LiquidityPoolWithdraw",
        24 => "InvokeHostFunction",
        25 => "ExtendFootprintTTL",
        26 => "RestoreFootprint",
        _ => "inconnu",
    }
}

fn bad(msg: impl Into<String>) -> Error {
    Error::input(format!("transaction Stellar : {}", msg.into()))
}

struct Reader<'a>(&'a [u8]);

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        if self.0.len() < n {
            return Err(bad("tronquée"));
        }
        let (head, rest) = self.0.split_at(n);
        self.0 = rest;
        Ok(head)
    }

    fn u32(&mut self) -> Result<u32> {
        let mut b = [0u8; 4];
        b.copy_from_slice(self.take(4)?);
        Ok(u32::from_be_bytes(b))
    }

    fn u64(&mut self) -> Result<u64> {
        let mut b = [0u8; 8];
        b.copy_from_slice(self.take(8)?);
        Ok(u64::from_be_bytes(b))
    }

    fn i64(&mut self) -> Result<i64> {
        let mut b = [0u8; 8];
        b.copy_from_slice(self.take(8)?);
        Ok(i64::from_be_bytes(b))
    }

    fn fixed32(&mut self) -> Result<[u8; 32]> {
        let mut b = [0u8; 32];
        b.copy_from_slice(self.take(32)?);
        Ok(b)
    }

    /// Variable-length opaque / string of at most `max` bytes, zero padding checked.
    fn var(&mut self, max: usize) -> Result<Vec<u8>> {
        let len = self.u32()? as usize;
        if len > max {
            return Err(bad("champ trop long"));
        }
        let data = self.take(len)?.to_vec();
        if self.take((4 - len % 4) % 4)?.iter().any(|b| *b != 0) {
            return Err(bad("remplissage non nul"));
        }
        Ok(data)
    }

    fn account_id(&mut self) -> Result<[u8; 32]> {
        match self.u32()? {
            KEY_TYPE_ED25519 => self.fixed32(),
            t => Err(bad(format!("type de clé inconnu ({t})"))),
        }
    }

    fn muxed(&mut self) -> Result<[u8; 32]> {
        match self.u32()? {
            KEY_TYPE_ED25519 => self.fixed32(),
            KEY_TYPE_MUXED_ED25519 => {
                Err(bad("comptes multiplexés (adresses M…) non pris en charge"))
            }
            t => Err(bad(format!("type de compte inconnu ({t})"))),
        }
    }

    /// `Asset`, or `ChangeTrustAsset` when `trust` (native and pool shares refused there).
    fn asset(&mut self, trust: bool) -> Result<StellarAsset> {
        let width = match self.u32()? {
            0 if !trust => return Ok(StellarAsset::Native),
            0 => return Err(bad("ligne de confiance vers le XLM natif")),
            1 => 4,
            2 => 12,
            3 if trust => {
                return Err(bad(
                    "ligne de confiance de pool de liquidité non prise en charge",
                ))
            }
            t => return Err(bad(format!("type d'actif inconnu ({t})"))),
        };
        let raw = self.take(width)?;
        let len = raw.iter().position(|b| *b == 0).unwrap_or(width);
        let (code, pad) = raw.split_at(len);
        // stellar-core's isAssetValid: alphanumeric, zero padded at the end only, and a
        // 5-12 character code for ALPHANUM12 (a short code there would be a second encoding).
        if code.is_empty()
            || !code.iter().all(u8::is_ascii_alphanumeric)
            || pad.iter().any(|b| *b != 0)
            || (width == 12 && code.len() < 5)
        {
            return Err(bad("code d'actif non canonique"));
        }
        let code = String::from_utf8_lossy(code).into_owned();
        Ok(StellarAsset::Credit {
            code,
            issuer: self.account_id()?,
        })
    }
}

// ---------------------------------------------------------------------------------------------
// Summary and signing
// ---------------------------------------------------------------------------------------------

/// Asset as shown (serde: `{ "kind": "native" }` or `{ "kind": "credit", "code", "issuer" }`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum StellarAssetView {
    /// XLM.
    Native,
    /// Issued asset.
    Credit {
        /// Code.
        code: String,
        /// Issuer `G…`.
        issuer: String,
    },
}

impl StellarAsset {
    /// Display form.
    pub fn view(&self) -> StellarAssetView {
        match self {
            StellarAsset::Native => StellarAssetView::Native,
            StellarAsset::Credit { code, issuer } => StellarAssetView::Credit {
                code: code.clone(),
                issuer: stellar_address_from_key(issuer),
            },
        }
    }
}

/// Memo as shown.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum StellarMemoView {
    /// No memo.
    None,
    /// Text: `text` cleaned for display ([`crate::sanitize_text`]) or `None` if not UTF-8;
    /// `hex` = exact bytes.
    Text {
        /// Display text.
        text: Option<String>,
        /// Exact bytes, hex.
        hex: String,
    },
    /// Numeric id (decimal string: exceeds JavaScript's safe integers).
    Id {
        /// Decimal.
        id: String,
    },
    /// 32-byte hash, hex.
    Hash {
        /// Hex.
        hex: String,
    },
    /// 32-byte return hash, hex.
    Return {
        /// Hex.
        hex: String,
    },
}

/// The operation, decoded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum StellarOpView {
    /// Activation of a new account.
    CreateAccount {
        /// New account `G…`.
        destination: String,
        /// Stroops, decimal string.
        starting_balance: String,
    },
    /// Payment.
    Payment {
        /// Recipient `G…`.
        destination: String,
        /// Asset.
        asset: StellarAssetView,
        /// Stroops, decimal string.
        amount: String,
    },
    /// Trustline added / changed / removed.
    ChangeTrust {
        /// Asset.
        asset: StellarAssetView,
        /// Stroops, decimal string (`9223372036854775807` = no limit, `0` = removal).
        limit: String,
    },
}

/// Reasons for caution (each one requires the reinforced confirmation).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum StellarWarning {
    /// Fee above 0.01 XLM.
    HighFee,
    /// The memo text had characters removed / replaced, or is not UTF-8.
    UnusualText,
    /// `MEMO_RETURN` (refund reference).
    MemoReturn,
    /// ChangeTrust with limit 0: the trustline is removed.
    RemoveTrustline,
}

/// Plain-language summary of a transaction, decoded by Rust.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StellarTxSummary {
    /// Network whose passphrase is in the signature (what the dialog says).
    pub network: Network,
    /// Source (always our address, checked).
    pub source: String,
    /// Maximum fee, stroops.
    pub fee: String,
    /// Sequence number, decimal string.
    pub sequence: String,
    /// Valid from (UNIX seconds, 0 = no lower bound).
    pub min_time: u64,
    /// Void after (UNIX seconds, never 0).
    pub max_time: u64,
    /// Memo.
    pub memo: StellarMemoView,
    /// The only operation.
    pub operation: StellarOpView,
    /// Reasons for caution.
    pub warnings: Vec<StellarWarning>,
    /// The confirmation must be followed by a reinforced one.
    pub requires_extra_confirmation: bool,
}

/// Decodes an **unsigned** envelope (base64) for the dialog. Refused: anything
/// [`StellarEnvelope::decode`] refuses, an already signed envelope, a source other than
/// `our_address`, no time bounds or `maxTime` 0, a zero fee, a non-positive sequence, anything but
/// exactly one operation, an operation with its own source, a payment / activation to oneself, a
/// non-positive amount, a negative trust limit, a trustline to an asset we issue.
pub fn stellar_decode_tx(
    envelope_b64: &str,
    our_address: &str,
    net: Network,
) -> Result<StellarTxSummary> {
    let env = StellarEnvelope::from_base64(envelope_b64)?;
    summarize(&env, &stellar_account_id(our_address)?, net, false)
}

fn summarize(
    env: &StellarEnvelope,
    ours: &[u8; 32],
    net: Network,
    signed: bool,
) -> Result<StellarTxSummary> {
    let t = &env.tx;
    if !env.signatures.is_empty() && !signed {
        return Err(bad("déjà signée"));
    }
    if &t.source != ours {
        return Err(bad("la source n'est pas l'adresse de ce portefeuille"));
    }
    // Without maxTime a signed transaction stays valid for ever: whoever holds it could submit
    // it much later (same rule as XRP's LastLedgerSequence).
    let (min_time, max_time) = match t.time_bounds {
        Some((min, max)) if max != 0 && min <= max => (min, max),
        Some(_) => return Err(bad("limites de temps invalides")),
        None => {
            return Err(bad(
                "aucune limite de temps : la transaction resterait valable indéfiniment",
            ))
        }
    };
    if t.fee == 0 {
        return Err(bad("frais nuls"));
    }
    if t.sequence <= 0 {
        return Err(bad("numéro de séquence invalide"));
    }
    let [op] = t.operations.as_slice() else {
        return Err(bad(format!(
            "{} opérations : Kyro ne signe qu'une opération à la fois",
            t.operations.len()
        )));
    };
    if op.source.is_some() {
        return Err(bad("opération avec sa propre source : refusée"));
    }
    let mut warnings = Vec::new();
    let operation = match &op.body {
        StellarOperation::CreateAccount {
            destination,
            starting_balance,
        } => {
            if destination == ours {
                return Err(bad("activation de son propre compte"));
            }
            if *starting_balance <= 0 {
                return Err(bad("solde de départ nul"));
            }
            StellarOpView::CreateAccount {
                destination: stellar_address_from_key(destination),
                starting_balance: starting_balance.to_string(),
            }
        }
        StellarOperation::Payment {
            destination,
            asset,
            amount,
        } => {
            if destination == ours {
                return Err(bad("paiement à soi-même"));
            }
            if *amount <= 0 {
                return Err(bad("montant nul ou négatif"));
            }
            StellarOpView::Payment {
                destination: stellar_address_from_key(destination),
                asset: asset.view(),
                amount: amount.to_string(),
            }
        }
        StellarOperation::ChangeTrust { asset, limit } => {
            if let StellarAsset::Credit { issuer, .. } = asset {
                if issuer == ours {
                    return Err(bad("ligne de confiance vers son propre actif"));
                }
            }
            if *limit < 0 {
                return Err(bad("limite négative"));
            }
            if *limit == 0 {
                warnings.push(StellarWarning::RemoveTrustline);
            }
            StellarOpView::ChangeTrust {
                asset: asset.view(),
                limit: limit.to_string(),
            }
        }
    };
    if t.fee > STELLAR_HIGH_FEE_STROOPS {
        warnings.push(StellarWarning::HighFee);
    }
    let memo = match &t.memo {
        StellarMemo::None => StellarMemoView::None,
        StellarMemo::Text(b) => {
            let text = core::str::from_utf8(b).ok().map(|s| {
                let clean = sanitize_text(s, STELLAR_MAX_MEMO_TEXT);
                if clean.altered {
                    warnings.push(StellarWarning::UnusualText);
                }
                clean.text
            });
            if text.is_none() {
                warnings.push(StellarWarning::UnusualText);
            }
            StellarMemoView::Text {
                text,
                hex: hex::encode(b),
            }
        }
        StellarMemo::Id(id) => StellarMemoView::Id { id: id.to_string() },
        StellarMemo::Hash(h) => StellarMemoView::Hash {
            hex: hex::encode(h),
        },
        StellarMemo::Return(h) => {
            warnings.push(StellarWarning::MemoReturn);
            StellarMemoView::Return {
                hex: hex::encode(h),
            }
        }
    };
    Ok(StellarTxSummary {
        network: net,
        source: stellar_address_from_key(&t.source),
        fee: t.fee.to_string(),
        sequence: t.sequence.to_string(),
        min_time,
        max_time,
        memo,
        operation,
        requires_extra_confirmation: !warnings.is_empty(),
        warnings,
    })
}

/// Signs an unsigned envelope (base64) for `net` with the key of account `account`
/// (`m/44'/148'/account'`), after decoding it like [`stellar_decode_tx`]. Returns `(signed
/// envelope base64, transaction hash hex, summary)`. The signature is verified (strictly) before
/// it is returned.
pub fn stellar_sign(
    seed: &Seed,
    account: u32,
    envelope_b64: &str,
    net: Network,
) -> Result<(String, String, StellarTxSummary)> {
    let key = signing_key(seed, account)?;
    let pk = key.verifying_key();
    let mut env = StellarEnvelope::from_base64(envelope_b64)?;
    let summary = summarize(&env, pk.as_bytes(), net, false)?;
    let hash = env.tx.hash(net);
    let sig = key.sign(&hash);
    pk.verify_strict(&hash, &sig)
        .map_err(|_| Error::crypto("échec de la vérification de la signature"))?;
    let mut hint = [0u8; 4];
    hint.copy_from_slice(&pk.as_bytes()[28..]);
    env.signatures = vec![StellarSignature {
        hint,
        signature: sig.to_bytes().to_vec(),
    }];
    Ok((env.to_base64(), hex::encode(hash), summary))
}

/// Hash (hex) of a signed envelope for `net`, after checking that it decodes, that it carries
/// exactly one signature, and that this signature is a valid (strict) ed25519 signature of the
/// source account over the transaction hash **on `net`** — a testnet transaction does not verify
/// on the public network.
pub fn stellar_verify_signed(envelope_b64: &str, net: Network) -> Result<String> {
    let env = StellarEnvelope::from_base64(envelope_b64)?;
    let [s] = env.signatures.as_slice() else {
        return Err(bad("une signature attendue"));
    };
    let pk = ed25519_dalek::VerifyingKey::from_bytes(&env.tx.source)
        .map_err(|_| bad("clé source invalide"))?;
    if s.hint != env.tx.source[28..] {
        return Err(bad("indice de signature (hint) d'une autre clé"));
    }
    let sig: [u8; 64] = s
        .signature
        .as_slice()
        .try_into()
        .map_err(|_| bad("signature : 64 octets attendus"))?;
    let hash = env.tx.hash(net);
    pk.verify_strict(&hash, &ed25519_dalek::Signature::from_bytes(&sig))
        .map_err(|_| {
            bad("la signature ne se vérifie pas sur ce réseau (mainnet / testnet inversés ?)")
        })?;
    Ok(hex::encode(hash))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crc_and_base32() {
        // CRC-16/XMODEM check value.
        assert_eq!(crc16_xmodem(b"123456789"), 0x31C3);
        // RFC 4648 §10 (without padding).
        for (raw, enc) in [
            ("", ""),
            ("f", "MY"),
            ("fo", "MZXQ"),
            ("foo", "MZXW6"),
            ("foob", "MZXW6YQ"),
            ("fooba", "MZXW6YTB"),
            ("foobar", "MZXW6YTBOI"),
        ] {
            assert_eq!(base32_encode(raw.as_bytes()), enc);
            assert_eq!(base32_decode(enc).unwrap(), raw.as_bytes());
        }
        assert!(base32_decode("MZ").is_none(), "non-zero unused bits");
        assert!(base32_decode("M").is_none(), "length 1 mod 8");
        assert!(base32_decode("mzxw6").is_none(), "lower case");
    }

    /// SEP-0005 test 1 and test 5: the secret seeds (`S…`) of the official vectors.
    #[test]
    fn sep5_secret_seeds() {
        let t1 = crate::Mnemonic::parse(
            "illness spike retreat truth genius clock brain pass fit cave bargain toe",
        )
        .unwrap()
        .to_seed("");
        let k = signing_key(&t1, 0).unwrap();
        assert_eq!(
            strkey_encode(VERSION_SEED, &k.to_bytes()),
            "SBGWSG6BTNCKCOB3DIFBGCVMUPQFYPA2G4O34RMTB343OYPXU5DJDVMN"
        );
        let t5 = crate::Mnemonic::parse(
            "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
        )
        .unwrap()
        .to_seed("");
        assert_eq!(
            strkey_encode(VERSION_SEED, &signing_key(&t5, 9).unwrap().to_bytes()),
            "SALJ5LPBTXCFML2CQ7ORP7WJNJOZSVBVRQAAODMVHMUF4P4XXFZB7MKY"
        );
    }
}
