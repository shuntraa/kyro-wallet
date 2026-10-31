//! XRP Ledger: secp256k1 keys at `m/44'/144'/account'/0/0` (the BIP44 route of Ledger, Trezor and
//! Xumm/Xaman-compatible wallets — not rippled's "family seed" derivation; one address per
//! account like Ledger Live, account 0 = the historical `m/44'/144'/0'/0/0`), classic `r…`
//! addresses, and the XRPL binary codec for **Payment** transactions only.
//!
//! - Account ID = `RIPEMD160(SHA256(compressed pubkey))`; address = base58check with the Ripple
//!   alphabet (`bs58::Alphabet::RIPPLE`), version byte 0, checksum = first 4 bytes of SHA-256d.
//! - Signing: `SHA-512Half(0x53545800 "STX\0" || serialization without TxnSignature)`,
//!   libsecp256k1 ECDSA, **DER, low-S** (canonical, what `tfFullyCanonicalSig` requires).
//!   Transaction hash: `SHA-512Half(0x54584E00 "TXN\0" || signed serialization)`.
//!
//! Codec: hand-written for the Payment subset (≈ 20 fields, 7 types): the Rust XRPL crates
//! bring large, young dependency trees for a format this small. Same safety rule as for TRON:
//! **a blob is accepted only if re-encoding the decoded transaction gives back the same bytes**
//! (canonical field order, no duplicate, no unknown field). Tested byte for byte against
//! Trezor's firmware fixtures and xrpl.js `ripple-binary-codec` fixtures.

use bitcoin::hashes::{hash160, sha256d, sha512, Hash};
use bitcoin::secp256k1::{ecdsa::Signature, Message, PublicKey, Secp256k1};
use serde::{Deserialize, Serialize};

use crate::display::sanitize_text;
use crate::error::{Error, Result};
use crate::keys::{hardened, normal, secp, XprivGuard};
use crate::mnemonic::Seed;

/// `tfFullyCanonicalSig`: Kyro always sets it.
pub const TF_FULLY_CANONICAL_SIG: u32 = 0x8000_0000;
/// `tfNoRippleDirect` (path option).
pub const TF_NO_RIPPLE_DIRECT: u32 = 0x0001_0000;
/// `tfPartialPayment`: refused — the delivered amount could be anything down to almost zero.
pub const TF_PARTIAL_PAYMENT: u32 = 0x0002_0000;
/// `tfLimitQuality` (path option).
pub const TF_LIMIT_QUALITY: u32 = 0x0004_0000;
/// Account flag `lsfRequireDestTag`: the account refuses payments without a DestinationTag.
pub const LSF_REQUIRE_DEST_TAG: u32 = 0x0002_0000;
/// Account flag `lsfDisallowXRP` (advisory).
pub const LSF_DISALLOW_XRP: u32 = 0x0008_0000;
/// Fees above 1 XRP need a reinforced confirmation (the usual fee is 10–20 drops).
const HIGH_FEE_DROPS: u64 = 1_000_000;
/// Longest memo text shown in the dialog (characters).
const MAX_MEMO_TEXT: usize = 256;
/// 100 billion XRP in drops: the largest valid native amount.
const MAX_DROPS: u64 = 100_000_000_000_000_000;
const MAX_BLOB: usize = 4096;

// ---------------------------------------------------------------------------------------------
// Keys and addresses
// ---------------------------------------------------------------------------------------------

fn path(account: u32, index: u32) -> Result<[bitcoin::bip32::ChildNumber; 5]> {
    Ok([
        hardened(44)?,
        hardened(144)?,
        hardened(account)?,
        normal(0)?,
        normal(index)?,
    ])
}

/// Path of the key of XRP account `account`: `m/44'/144'/account'/0/0`.
pub fn xrp_path(account: u32) -> String {
    format!("m/44'/144'/{account}'/0/0")
}

/// `r…` address of a 20-byte account ID.
pub fn xrp_address_from_id(id: &[u8; 20]) -> String {
    let mut data = Vec::with_capacity(25);
    data.push(0u8);
    data.extend_from_slice(id);
    let sum = sha256d::Hash::hash(&data).to_byte_array();
    data.extend_from_slice(&sum[..4]);
    bs58::encode(data)
        .with_alphabet(bs58::Alphabet::RIPPLE)
        .into_string()
}

/// Account ID of a classic `r…` address. X-addresses (`X…`/`T…`, tag embedded) are refused:
/// ask for the classic address and the destination tag separately.
pub fn xrp_account_id(address: &str) -> Result<[u8; 20]> {
    let a = address.trim();
    if (a.starts_with('X') || a.starts_with('T')) && a.len() >= 46 {
        return Err(Error::input(
            "les X-addresses ne sont pas prises en charge : demande l'adresse classique r… et le tag de destination",
        ));
    }
    let raw = bs58::decode(a)
        .with_alphabet(bs58::Alphabet::RIPPLE)
        .into_vec()
        .map_err(|_| Error::input("adresse XRP invalide"))?;
    if raw.len() != 25 || raw[0] != 0 {
        return Err(Error::input("adresse XRP invalide"));
    }
    let sum = sha256d::Hash::hash(&raw[..21]).to_byte_array();
    if raw[21..] != sum[..4] {
        return Err(Error::input("adresse XRP invalide (somme de contrôle)"));
    }
    let mut id = [0u8; 20];
    id.copy_from_slice(&raw[1..21]);
    Ok(id)
}

fn id_of_pubkey(pk: &[u8; 33]) -> [u8; 20] {
    hash160::Hash::hash(pk).to_byte_array()
}

/// `r…` address of a compressed secp256k1 public key.
pub fn xrp_address_of_pubkey(pk: &[u8]) -> Result<String> {
    let pk: [u8; 33] = PublicKey::from_slice(pk)
        .map_err(|_| Error::input("clé publique invalide"))?
        .serialize();
    Ok(xrp_address_from_id(&id_of_pubkey(&pk)))
}

/// Compressed public key of account `account` (`m/44'/144'/account'/0/0`, the transaction's
/// `SigningPubKey`).
pub fn xrp_public_key(seed: &Seed, account: u32) -> Result<[u8; 33]> {
    xrp_public_key_at(seed, account, 0)
}

/// Compressed public key at `m/44'/144'/account'/0/index` (Kyro only uses `index` 0; other
/// indices exist for test vectors of other wallets).
pub fn xrp_public_key_at(seed: &Seed, account: u32, index: u32) -> Result<[u8; 33]> {
    let secp = secp()?;
    let master = XprivGuard::master(seed, bitcoin::NetworkKind::Main)?;
    let key = master.derive(&secp, &path(account, index)?)?;
    Ok(key.xpriv().private_key.public_key(&secp).serialize())
}

/// Address of account `account` (`m/44'/144'/account'/0/0`, see [`xrp_path`]).
pub fn xrp_address(seed: &Seed, account: u32) -> Result<String> {
    xrp_address_at(seed, account, 0)
}

/// Address at `m/44'/144'/account'/0/index`.
pub fn xrp_address_at(seed: &Seed, account: u32, index: u32) -> Result<String> {
    Ok(xrp_address_from_id(&id_of_pubkey(&xrp_public_key_at(
        seed, account, index,
    )?)))
}

// ---------------------------------------------------------------------------------------------
// Amounts
// ---------------------------------------------------------------------------------------------

/// An `STAmount`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum XrpAmount {
    /// Drops (1 XRP = 1 000 000 drops).
    Xrp(u64),
    /// Issued currency (IOU).
    Issued {
        /// `mantissa × 10^exponent`, mantissa in [10^15, 10^16) or 0.
        mantissa: u64,
        /// −96..=80.
        exponent: i32,
        /// Negative value (refused in payments).
        negative: bool,
        /// 20-byte currency code.
        currency: [u8; 20],
        /// Issuer account ID.
        issuer: [u8; 20],
    },
}

const MIN_MANTISSA: u64 = 1_000_000_000_000_000;
const MAX_MANTISSA: u64 = 9_999_999_999_999_999;

impl XrpAmount {
    fn encode(&self, out: &mut Vec<u8>) {
        match self {
            XrpAmount::Xrp(drops) => {
                out.extend_from_slice(&(0x4000_0000_0000_0000 | drops).to_be_bytes())
            }
            XrpAmount::Issued {
                mantissa,
                exponent,
                negative,
                currency,
                issuer,
            } => {
                let v: u64 = if *mantissa == 0 {
                    0x8000_0000_0000_0000
                } else {
                    let sign = if *negative { 0 } else { 1u64 << 62 };
                    (1u64 << 63) | sign | (((exponent + 97) as u64) << 54) | mantissa
                };
                out.extend_from_slice(&v.to_be_bytes());
                out.extend_from_slice(currency);
                out.extend_from_slice(issuer);
            }
        }
    }

    fn decode(b: &mut &[u8]) -> Result<XrpAmount> {
        let head = take(b, 8)?;
        let v = u64::from_be_bytes(head.try_into().map_err(|_| bad("montant"))?);
        if v & (1 << 63) == 0 {
            if v & (1 << 61) != 0 {
                return Err(bad("les montants MPT ne sont pas pris en charge"));
            }
            if v & (1 << 62) == 0 {
                return Err(bad("montant XRP négatif"));
            }
            let drops = v & 0x3FFF_FFFF_FFFF_FFFF;
            if drops > MAX_DROPS {
                return Err(bad("montant XRP trop grand"));
            }
            return Ok(XrpAmount::Xrp(drops));
        }
        let currency: [u8; 20] = take(b, 20)?.try_into().map_err(|_| bad("devise"))?;
        let issuer: [u8; 20] = take(b, 20)?.try_into().map_err(|_| bad("émetteur"))?;
        if currency == [0u8; 20] {
            return Err(bad("montant émis avec le code de devise XRP"));
        }
        if v == 0x8000_0000_0000_0000 {
            return Ok(XrpAmount::Issued {
                mantissa: 0,
                exponent: 0,
                negative: false,
                currency,
                issuer,
            });
        }
        let negative = v & (1 << 62) == 0;
        let exponent = ((v >> 54) & 0xFF) as i32 - 97;
        let mantissa = v & ((1 << 54) - 1);
        if !(MIN_MANTISSA..=MAX_MANTISSA).contains(&mantissa) || !(-96..=80).contains(&exponent) {
            return Err(bad("montant émis non normalisé"));
        }
        Ok(XrpAmount::Issued {
            mantissa,
            exponent,
            negative,
            currency,
            issuer,
        })
    }
}

/// Parses a decimal string ("12.5", "0.001", "1e3" not accepted) into a normalized IOU value.
fn parse_iou_value(s: &str) -> Result<(u64, i32, bool)> {
    let s = s.trim();
    let (negative, s) = match s.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, s),
    };
    let (int, frac) = s.split_once('.').unwrap_or((s, ""));
    if (int.is_empty() && frac.is_empty())
        || !int.bytes().all(|c| c.is_ascii_digit())
        || !frac.bytes().all(|c| c.is_ascii_digit())
    {
        return Err(Error::input("montant invalide"));
    }
    let digits: String = format!("{int}{frac}");
    let digits = digits.trim_start_matches('0');
    let mut exponent = -(frac.len() as i64);
    let trimmed = digits.trim_end_matches('0');
    exponent += (digits.len() - trimmed.len()) as i64;
    if trimmed.is_empty() {
        return Ok((0, 0, false));
    }
    if trimmed.len() > 16 {
        return Err(Error::input("plus de 16 chiffres significatifs"));
    }
    let mut m: u64 = trimmed
        .parse()
        .map_err(|_| Error::input("montant invalide"))?;
    while m < MIN_MANTISSA {
        m *= 10;
        exponent -= 1;
    }
    if !(-96..=80).contains(&exponent) {
        return Err(Error::input("montant hors limites"));
    }
    Ok((m, exponent as i32, negative))
}

/// Decimal text of `mantissa × 10^exponent`.
fn iou_value_string(mantissa: u64, exponent: i32, negative: bool) -> String {
    if mantissa == 0 {
        return "0".into();
    }
    let digits = mantissa.to_string();
    let point = digits.len() as i64 + i64::from(exponent); // position of the decimal point
    let s = if point <= 0 {
        format!("0.{}{}", "0".repeat((-point) as usize), digits)
    } else if point as usize >= digits.len() {
        format!("{digits}{}", "0".repeat(point as usize - digits.len()))
    } else {
        format!(
            "{}.{}",
            &digits[..point as usize],
            &digits[point as usize..]
        )
    };
    let s = if s.contains('.') {
        s.trim_end_matches('0').trim_end_matches('.').to_owned()
    } else {
        s
    };
    if negative {
        format!("-{s}")
    } else {
        s
    }
}

/// 20-byte currency code: a 3-character ISO-like code (not "XRP"), or 40 hex characters.
pub fn xrp_currency_code(code: &str) -> Result<[u8; 20]> {
    let c = code.trim();
    let mut out = [0u8; 20];
    if c.len() == 3 && c.bytes().all(|b| b.is_ascii_graphic()) {
        if c.eq_ignore_ascii_case("XRP") {
            return Err(Error::input("XRP n'est pas une devise émise"));
        }
        out[12..15].copy_from_slice(c.as_bytes());
        return Ok(out);
    }
    if c.len() == 40 {
        hex::decode_to_slice(c, &mut out).map_err(|_| Error::input("code de devise invalide"))?;
        if out[0] == 0 {
            return Err(Error::input("code de devise non standard invalide"));
        }
        return Ok(out);
    }
    Err(Error::input(
        "devise : 3 caractères ou 40 caractères hexadécimaux",
    ))
}

fn currency_string(c: &[u8; 20]) -> String {
    let standard = c[..12].iter().all(|b| *b == 0) && c[15..].iter().all(|b| *b == 0);
    if standard && c[12..15].iter().all(|b| b.is_ascii_graphic()) {
        String::from_utf8_lossy(&c[12..15]).into_owned()
    } else {
        hex::encode_upper(c)
    }
}

/// An issued-currency amount from its decimal value, currency and issuer address.
pub fn xrp_issued_amount(value: &str, currency: &str, issuer: &str) -> Result<XrpAmount> {
    let (mantissa, exponent, negative) = parse_iou_value(value)?;
    Ok(XrpAmount::Issued {
        mantissa,
        exponent,
        negative,
        currency: xrp_currency_code(currency)?,
        issuer: xrp_account_id(issuer)?,
    })
}

/// Amount as shown to the user (serde: `{ "kind": "xrp", "drops" }` or `{ "kind": "issued", … }`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum XrpAmountView {
    /// Native XRP.
    Xrp {
        /// Drops, decimal string.
        drops: String,
    },
    /// Issued currency.
    Issued {
        /// Decimal value.
        value: String,
        /// 3-letter code, or 40 hex characters.
        currency: String,
        /// Issuer `r…` address.
        issuer: String,
    },
}

impl XrpAmount {
    /// Display form.
    pub fn view(&self) -> XrpAmountView {
        match self {
            XrpAmount::Xrp(d) => XrpAmountView::Xrp {
                drops: d.to_string(),
            },
            XrpAmount::Issued {
                mantissa,
                exponent,
                negative,
                currency,
                issuer,
            } => XrpAmountView::Issued {
                value: iou_value_string(*mantissa, *exponent, *negative),
                currency: currency_string(currency),
                issuer: xrp_address_from_id(issuer),
            },
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Binary codec (Payment subset)
// ---------------------------------------------------------------------------------------------

fn bad(msg: impl Into<String>) -> Error {
    Error::input(format!("transaction XRP : {}", msg.into()))
}

fn take<'a>(b: &mut &'a [u8], n: usize) -> Result<&'a [u8]> {
    if b.len() < n {
        return Err(bad("tronquée"));
    }
    let (head, rest) = b.split_at(n);
    *b = rest;
    Ok(head)
}

fn put_header(out: &mut Vec<u8>, t: u8, n: u8) {
    match (t < 16, n < 16) {
        (true, true) => out.push((t << 4) | n),
        (true, false) => out.extend_from_slice(&[t << 4, n]),
        (false, true) => out.extend_from_slice(&[n, t]),
        (false, false) => out.extend_from_slice(&[0, t, n]),
    }
}

fn read_header(b: &mut &[u8]) -> Result<(u8, u8)> {
    let first = take(b, 1)?[0];
    let (mut t, mut n) = (first >> 4, first & 0x0F);
    if t == 0 {
        t = take(b, 1)?[0];
    }
    if n == 0 {
        n = take(b, 1)?[0];
    }
    Ok((t, n))
}

fn put_vl(out: &mut Vec<u8>, data: &[u8]) {
    let l = data.len();
    if l <= 192 {
        out.push(l as u8);
    } else if l <= 12_480 {
        let l = l - 193;
        out.extend_from_slice(&[193 + (l >> 8) as u8, (l & 0xFF) as u8]);
    } else {
        let l = l - 12_481;
        out.extend_from_slice(&[
            241 + (l >> 16) as u8,
            ((l >> 8) & 0xFF) as u8,
            (l & 0xFF) as u8,
        ]);
    }
    out.extend_from_slice(data);
}

fn read_vl<'a>(b: &mut &'a [u8]) -> Result<&'a [u8]> {
    let b1 = usize::from(take(b, 1)?[0]);
    let len = if b1 <= 192 {
        b1
    } else if b1 <= 240 {
        193 + (b1 - 193) * 256 + usize::from(take(b, 1)?[0])
    } else if b1 <= 254 {
        let x = take(b, 2)?;
        12_481 + (b1 - 241) * 65_536 + usize::from(x[0]) * 256 + usize::from(x[1])
    } else {
        return Err(bad("préfixe de longueur"));
    };
    take(b, len)
}

fn put_u32(out: &mut Vec<u8>, n: u8, v: u32) {
    put_header(out, 2, n);
    out.extend_from_slice(&v.to_be_bytes());
}

fn read_u32(b: &mut &[u8]) -> Result<u32> {
    Ok(u32::from_be_bytes(
        take(b, 4)?.try_into().map_err(|_| bad("u32"))?,
    ))
}

fn read_account(b: &mut &[u8]) -> Result<[u8; 20]> {
    read_vl(b)?
        .try_into()
        .map_err(|_| bad("compte : 20 octets attendus"))
}

/// One memo (all three fields optional).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct XrpMemo {
    /// `MemoType`.
    pub memo_type: Option<Vec<u8>>,
    /// `MemoData`.
    pub memo_data: Option<Vec<u8>>,
    /// `MemoFormat`.
    pub memo_format: Option<Vec<u8>>,
}

/// A Payment, restricted to the fields Kyro understands.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct XrpPayment {
    /// `Flags` (optional on the wire, 0 when absent; Kyro always sets it).
    pub flags: Option<u32>,
    /// `SourceTag`.
    pub source_tag: Option<u32>,
    /// `Sequence`.
    pub sequence: u32,
    /// `DestinationTag`.
    pub destination_tag: Option<u32>,
    /// `LastLedgerSequence`.
    pub last_ledger_sequence: Option<u32>,
    /// `InvoiceID`.
    pub invoice_id: Option<[u8; 32]>,
    /// `Amount`.
    pub amount: XrpAmount,
    /// `Fee`, drops.
    pub fee: u64,
    /// `SendMax`.
    pub send_max: Option<XrpAmount>,
    /// `SigningPubKey` (absent in some reference fixtures; required to sign).
    pub signing_pub_key: Option<Vec<u8>>,
    /// `TxnSignature` (DER), absent before signing.
    pub txn_signature: Option<Vec<u8>>,
    /// `Account`.
    pub account: [u8; 20],
    /// `Destination`.
    pub destination: [u8; 20],
    /// `Memos`.
    pub memos: Vec<XrpMemo>,
}

impl XrpPayment {
    /// Canonical serialization; `with_signature = false` gives the signing serialization.
    pub fn encode(&self, with_signature: bool) -> Vec<u8> {
        let mut o = Vec::new();
        put_header(&mut o, 1, 2); // TransactionType
        o.extend_from_slice(&0u16.to_be_bytes()); // Payment
        if let Some(f) = self.flags {
            put_u32(&mut o, 2, f);
        }
        if let Some(t) = self.source_tag {
            put_u32(&mut o, 3, t);
        }
        put_u32(&mut o, 4, self.sequence);
        if let Some(t) = self.destination_tag {
            put_u32(&mut o, 14, t);
        }
        if let Some(l) = self.last_ledger_sequence {
            put_u32(&mut o, 27, l);
        }
        if let Some(h) = &self.invoice_id {
            put_header(&mut o, 5, 17);
            o.extend_from_slice(h);
        }
        put_header(&mut o, 6, 1);
        self.amount.encode(&mut o);
        put_header(&mut o, 6, 8);
        XrpAmount::Xrp(self.fee).encode(&mut o);
        if let Some(m) = &self.send_max {
            put_header(&mut o, 6, 9);
            m.encode(&mut o);
        }
        if let Some(k) = &self.signing_pub_key {
            put_header(&mut o, 7, 3);
            put_vl(&mut o, k);
        }
        if with_signature {
            if let Some(s) = &self.txn_signature {
                put_header(&mut o, 7, 4);
                put_vl(&mut o, s);
            }
        }
        put_header(&mut o, 8, 1);
        put_vl(&mut o, &self.account);
        put_header(&mut o, 8, 3);
        put_vl(&mut o, &self.destination);
        if !self.memos.is_empty() {
            put_header(&mut o, 15, 9);
            for m in &self.memos {
                put_header(&mut o, 14, 10);
                for (n, v) in [(12, &m.memo_type), (13, &m.memo_data), (14, &m.memo_format)] {
                    if let Some(v) = v {
                        put_header(&mut o, 7, n);
                        put_vl(&mut o, v);
                    }
                }
                put_header(&mut o, 14, 1); // end of object
            }
            put_header(&mut o, 15, 1); // end of array
        }
        o
    }

    /// Strict decoding of a Payment. Refused: any other transaction type, `NetworkID`,
    /// `TicketSequence`, `Paths`, `DeliverMin`, MPT amounts, unknown fields, and any encoding
    /// that does not re-encode identically.
    pub fn decode(raw: &[u8]) -> Result<XrpPayment> {
        if raw.len() > MAX_BLOB {
            return Err(bad("trop grande"));
        }
        let mut b = raw;
        let (mut ty, mut flags, mut source_tag, mut sequence) = (None, None, None, None);
        let (mut destination_tag, mut lls, mut invoice_id) = (None, None, None);
        let (mut amount, mut fee, mut send_max) = (None, None, None);
        let (mut spk, mut sig, mut account, mut destination) = (None, None, None, None);
        let mut memos = Vec::new();
        while !b.is_empty() {
            match read_header(&mut b)? {
                (1, 2) => {
                    ty = Some(u16::from_be_bytes(
                        take(&mut b, 2)?.try_into().map_err(|_| bad("type"))?,
                    ))
                }
                (2, 1) => {
                    return Err(bad(
                        "NetworkID n'est pas pris en charge (XRPL mainnet / testnet uniquement)",
                    ))
                }
                (2, 2) => flags = Some(read_u32(&mut b)?),
                (2, 3) => source_tag = Some(read_u32(&mut b)?),
                (2, 4) => sequence = Some(read_u32(&mut b)?),
                (2, 14) => destination_tag = Some(read_u32(&mut b)?),
                (2, 27) => lls = Some(read_u32(&mut b)?),
                (2, 41) => return Err(bad("TicketSequence n'est pas pris en charge")),
                (5, 17) => {
                    invoice_id = Some(
                        <[u8; 32]>::try_from(take(&mut b, 32)?).map_err(|_| bad("InvoiceID"))?,
                    )
                }
                (6, 1) => amount = Some(XrpAmount::decode(&mut b)?),
                (6, 8) => match XrpAmount::decode(&mut b)? {
                    XrpAmount::Xrp(d) => fee = Some(d),
                    XrpAmount::Issued { .. } => return Err(bad("Fee doit être en XRP")),
                },
                (6, 9) => send_max = Some(XrpAmount::decode(&mut b)?),
                (6, 10) => {
                    return Err(bad(
                        "DeliverMin (paiements partiels) n'est pas pris en charge",
                    ))
                }
                (7, 3) => spk = Some(read_vl(&mut b)?.to_vec()),
                (7, 4) => sig = Some(read_vl(&mut b)?.to_vec()),
                (8, 1) => account = Some(read_account(&mut b)?),
                (8, 3) => destination = Some(read_account(&mut b)?),
                (15, 9) => memos = read_memos(&mut b)?,
                (18, 1) => return Err(bad("les chemins (Paths) ne sont pas pris en charge")),
                (t, n) => return Err(bad(format!("champ inconnu (type {t}, champ {n})"))),
            }
        }
        match ty {
            Some(0) => {}
            Some(other) => {
                return Err(bad(format!(
                    "le type de transaction {other} n'est pas un Payment : refusé"
                )))
            }
            None => return Err(bad("TransactionType manquant")),
        }
        let p = XrpPayment {
            flags,
            source_tag,
            sequence: sequence.ok_or_else(|| bad("Sequence manquant"))?,
            destination_tag,
            last_ledger_sequence: lls,
            invoice_id,
            amount: amount.ok_or_else(|| bad("Amount manquant"))?,
            fee: fee.ok_or_else(|| bad("Fee manquant"))?,
            send_max,
            signing_pub_key: spk,
            txn_signature: sig,
            account: account.ok_or_else(|| bad("Account manquant"))?,
            destination: destination.ok_or_else(|| bad("Destination manquante"))?,
            memos,
        };
        if p.encode(true) != raw {
            return Err(bad(
                "encodage non canonique (ordre, doublon ou disposition inconnue)",
            ));
        }
        Ok(p)
    }

    /// `SHA-512Half("STX\0" || signing serialization)`.
    pub fn signing_hash(&self) -> [u8; 32] {
        let mut data = vec![0x53, 0x54, 0x58, 0x00];
        data.extend(self.encode(false));
        half(&data)
    }

    /// `SHA-512Half("TXN\0" || signed serialization)`, the transaction hash.
    pub fn hash(&self) -> [u8; 32] {
        let mut data = vec![0x54, 0x58, 0x4E, 0x00];
        data.extend(self.encode(true));
        half(&data)
    }
}

fn half(data: &[u8]) -> [u8; 32] {
    let full = sha512::Hash::hash(data).to_byte_array();
    let mut out = [0u8; 32];
    out.copy_from_slice(&full[..32]);
    out
}

fn read_memos(b: &mut &[u8]) -> Result<Vec<XrpMemo>> {
    let mut out = Vec::new();
    loop {
        match read_header(b)? {
            (15, 1) => return Ok(out),
            (14, 10) => {
                let mut m = XrpMemo::default();
                loop {
                    match read_header(b)? {
                        (14, 1) => break,
                        (7, 12) => m.memo_type = Some(read_vl(b)?.to_vec()),
                        (7, 13) => m.memo_data = Some(read_vl(b)?.to_vec()),
                        (7, 14) => m.memo_format = Some(read_vl(b)?.to_vec()),
                        (t, n) => {
                            return Err(bad(format!("champ de mémo inconnu (type {t}, champ {n})")))
                        }
                    }
                }
                out.push(m);
            }
            (t, n) => return Err(bad(format!("entrée Memos inconnue (type {t}, champ {n})"))),
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Summary and signing
// ---------------------------------------------------------------------------------------------

/// One memo, hex fields plus UTF-8 text when readable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XrpMemoView {
    /// Hex.
    pub memo_type: Option<String>,
    /// Hex.
    pub memo_data: Option<String>,
    /// Hex.
    pub memo_format: Option<String>,
    /// `MemoData` as text, if valid UTF-8, cleaned for display ([`crate::sanitize_text`]).
    pub text: Option<String>,
}

/// Reasons for caution (all of them require the reinforced confirmation).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum XrpWarning {
    /// `SendMax` present: cross-currency / issued payment that may spend up to that amount.
    SendMax,
    /// `tfLimitQuality` / `tfNoRippleDirect`: path options.
    PathFlags,
    /// Memos present.
    Memo,
    /// Fee above 1 XRP.
    HighFee,
    /// `InvoiceID` present.
    InvoiceId,
    /// A memo text had control / invisible / bidi characters removed or was cut: the dialog
    /// shows a cleaned version (the hex fields are exact).
    UnusualText,
}

/// Plain-language summary of a Payment, decoded by Rust.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XrpTxSummary {
    /// Sender (always our address, checked).
    pub account: String,
    /// Recipient.
    pub destination: String,
    /// **Destination tag** (exchanges, custodians): `None` = no tag.
    pub destination_tag: Option<u32>,
    /// Amount delivered.
    pub amount: XrpAmountView,
    /// Drops, decimal string.
    pub fee: String,
    /// `Sequence`.
    pub sequence: u32,
    /// `LastLedgerSequence`: the transaction is void after this ledger.
    pub last_ledger_sequence: Option<u32>,
    /// `Flags`.
    pub flags: u32,
    /// `SendMax`.
    pub send_max: Option<XrpAmountView>,
    /// `SourceTag`.
    pub source_tag: Option<u32>,
    /// `InvoiceID`, hex.
    pub invoice_id: Option<String>,
    /// Memos.
    pub memos: Vec<XrpMemoView>,
    /// Reasons for caution.
    pub warnings: Vec<XrpWarning>,
    /// The confirmation must be followed by a reinforced one.
    pub requires_extra_confirmation: bool,
}

/// Decodes an **unsigned** Payment blob (hex) for the dialog. Refused: anything
/// [`XrpPayment::decode`] refuses, an already signed blob, `Account` ≠ `our_address`,
/// `SigningPubKey` ≠ `our_pubkey`, `tfPartialPayment`, unknown flags, a payment to oneself,
/// a non-positive amount, a zero fee, a missing `LastLedgerSequence`.
pub fn xrp_decode_tx(blob_hex: &str, our_address: &str, our_pubkey: &[u8]) -> Result<XrpTxSummary> {
    let raw = hex::decode(blob_hex.trim())
        .map_err(|_| Error::input("le blob n'est pas en hexadécimal"))?;
    let p = XrpPayment::decode(&raw)?;
    summarize(&p, our_address, our_pubkey, false)
}

fn summarize(
    p: &XrpPayment,
    our_address: &str,
    our_pubkey: &[u8],
    signed: bool,
) -> Result<XrpTxSummary> {
    if p.txn_signature.is_some() && !signed {
        return Err(bad("déjà signée"));
    }
    if p.account != xrp_account_id(our_address)? {
        return Err(bad("l'Account n'est pas l'adresse de ce portefeuille"));
    }
    if p.signing_pub_key.as_deref() != Some(our_pubkey) {
        return Err(bad("SigningPubKey n'est pas la clé de ce portefeuille"));
    }
    let flags = p.flags.unwrap_or(0);
    if flags & TF_PARTIAL_PAYMENT != 0 {
        return Err(bad("les paiements partiels (tfPartialPayment) sont refusés : le montant livré pourrait être presque nul"));
    }
    let known = TF_FULLY_CANONICAL_SIG | TF_NO_RIPPLE_DIRECT | TF_LIMIT_QUALITY;
    if flags & !known != 0 {
        return Err(bad(format!("flags inconnus {:#010x}", flags & !known)));
    }
    if p.destination == p.account {
        return Err(bad("paiement à soi-même"));
    }
    match &p.amount {
        XrpAmount::Xrp(0) => return Err(bad("montant nul")),
        XrpAmount::Issued {
            mantissa, negative, ..
        } if *mantissa == 0 || *negative => return Err(bad("le montant émis doit être positif")),
        _ => {}
    }
    if let Some(XrpAmount::Issued { negative: true, .. }) = &p.send_max {
        return Err(bad("SendMax négatif"));
    }
    if p.fee == 0 {
        return Err(bad("frais nuls"));
    }
    // Without LastLedgerSequence a signed payment stays valid for ever: whoever holds the blob
    // (a node, a log) could submit it months later.
    if p.last_ledger_sequence.is_none() {
        return Err(bad(
            "LastLedgerSequence absent : la transaction resterait valable indéfiniment",
        ));
    }
    let mut warnings = Vec::new();
    if p.send_max.is_some() {
        warnings.push(XrpWarning::SendMax);
    }
    if flags & (TF_NO_RIPPLE_DIRECT | TF_LIMIT_QUALITY) != 0 {
        warnings.push(XrpWarning::PathFlags);
    }
    if !p.memos.is_empty() {
        warnings.push(XrpWarning::Memo);
    }
    if p.fee > HIGH_FEE_DROPS {
        warnings.push(XrpWarning::HighFee);
    }
    if p.invoice_id.is_some() {
        warnings.push(XrpWarning::InvoiceId);
    }
    let mut unusual_text = false;
    let memos = p
        .memos
        .iter()
        .map(|m| {
            let h = |v: &Option<Vec<u8>>| v.as_ref().map(hex::encode_upper);
            let text = m
                .memo_data
                .as_deref()
                .and_then(|d| core::str::from_utf8(d).ok())
                .map(|t| {
                    let clean = sanitize_text(t, MAX_MEMO_TEXT);
                    unusual_text |= clean.altered;
                    clean.text
                });
            XrpMemoView {
                memo_type: h(&m.memo_type),
                memo_data: h(&m.memo_data),
                memo_format: h(&m.memo_format),
                text,
            }
        })
        .collect();
    if unusual_text {
        warnings.push(XrpWarning::UnusualText);
    }
    Ok(XrpTxSummary {
        account: xrp_address_from_id(&p.account),
        destination: xrp_address_from_id(&p.destination),
        destination_tag: p.destination_tag,
        amount: p.amount.view(),
        fee: p.fee.to_string(),
        sequence: p.sequence,
        last_ledger_sequence: p.last_ledger_sequence,
        flags,
        send_max: p.send_max.as_ref().map(XrpAmount::view),
        source_tag: p.source_tag,
        invoice_id: p.invoice_id.map(hex::encode_upper),
        memos,
        requires_extra_confirmation: !warnings.is_empty(),
        warnings,
    })
}

/// Signs an unsigned Payment blob (hex) with the key of account `account`
/// (`m/44'/144'/account'/0/0`), after decoding it like [`xrp_decode_tx`]. Returns `(signed blob
/// hex, transaction hash hex, summary)`. DER, low-S, verified before it is returned.
pub fn xrp_sign(
    seed: &Seed,
    account: u32,
    blob_hex: &str,
) -> Result<(String, String, XrpTxSummary)> {
    xrp_sign_at(seed, account, 0, blob_hex)
}

/// [`xrp_sign`] with the key at `m/44'/144'/account'/0/index` (test vectors of other wallets).
pub fn xrp_sign_at(
    seed: &Seed,
    account: u32,
    index: u32,
    blob_hex: &str,
) -> Result<(String, String, XrpTxSummary)> {
    let secp = secp()?;
    let master = XprivGuard::master(seed, bitcoin::NetworkKind::Main)?;
    let key = master.derive(&secp, &path(account, index)?)?;
    // A reference: `SecretKey` is `Copy`, a copy here would outlive the guard's erasure.
    let sk = &key.xpriv().private_key;
    let pk = sk.public_key(&secp).serialize();
    let ours = xrp_address_from_id(&id_of_pubkey(&pk));
    let raw = hex::decode(blob_hex.trim())
        .map_err(|_| Error::input("le blob n'est pas en hexadécimal"))?;
    let mut p = XrpPayment::decode(&raw)?;
    let summary = summarize(&p, &ours, &pk, false)?;
    let msg = Message::from_digest(p.signing_hash());
    let mut sig = secp.sign_ecdsa(&msg, sk);
    sig.normalize_s();
    secp.verify_ecdsa(&msg, &sig, &sk.public_key(&secp))
        .map_err(|_| Error::crypto("échec de la vérification de la signature"))?;
    p.txn_signature = Some(sig.serialize_der().to_vec());
    let signed = p.encode(true);
    let hash = hex::encode_upper(p.hash());
    Ok((hex::encode_upper(signed), hash, summary))
}

/// Hash of a signed blob, after checking that it decodes, that its signature is a canonical
/// (DER, low-S) signature by its `SigningPubKey`, and that this key is `Account`'s.
pub fn xrp_verify_signed(blob_hex: &str) -> Result<String> {
    let raw = hex::decode(blob_hex.trim())
        .map_err(|_| Error::input("le blob n'est pas en hexadécimal"))?;
    let p = XrpPayment::decode(&raw)?;
    let der = p.txn_signature.as_ref().ok_or_else(|| bad("non signée"))?;
    let sig = Signature::from_der(der).map_err(|_| bad("signature : DER invalide"))?;
    let mut low = sig;
    low.normalize_s();
    if low != sig {
        return Err(bad("la signature n'est pas low-S (non canonique)"));
    }
    let pk = PublicKey::from_slice(p.signing_pub_key.as_deref().unwrap_or_default())
        .map_err(|_| bad("SigningPubKey"))?;
    if id_of_pubkey(&pk.serialize()) != p.account {
        return Err(bad("SigningPubKey n'est pas la clé de l'Account"));
    }
    Secp256k1::verification_only()
        .verify_ecdsa(&Message::from_digest(p.signing_hash()), &sig, &pk)
        .map_err(|_| bad("la signature ne se vérifie pas"))?;
    Ok(hex::encode_upper(p.hash()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iou_values_round_trip() {
        for (s, m, e) in [
            ("1", 1_000_000_000_000_000, -15),
            ("1.0", 1_000_000_000_000_000, -15),
            ("0.001", 1_000_000_000_000_000, -18),
            ("1150.848", 1_150_848_000_000_000, -12),
            ("11111000.00000001", 1_111_100_000_000_001, -8),
        ] {
            let (mm, ee, neg) = parse_iou_value(s).unwrap();
            assert_eq!((mm, ee, neg), (m, e, false), "{s}");
        }
        assert_eq!(
            iou_value_string(1_150_848_000_000_000, -12, false),
            "1150.848"
        );
        assert_eq!(iou_value_string(1_000_000_000_000_000, -18, false), "0.001");
        assert_eq!(iou_value_string(5_000_000_000_000_000, -12, false), "5000");
        assert_eq!(
            iou_value_string(1_000_000_000_000_000, 0, true),
            "-1000000000000000"
        );
        assert!(parse_iou_value("1111111111111111.1").is_err());
        assert!(parse_iou_value("1e3").is_err());
        assert!(parse_iou_value("").is_err());
    }

    #[test]
    fn vl_lengths() {
        for n in [0usize, 192, 193, 12_480, 12_481] {
            let data = vec![7u8; n];
            let mut o = Vec::new();
            put_vl(&mut o, &data);
            let mut s = o.as_slice();
            assert_eq!(read_vl(&mut s).unwrap().len(), n);
            assert!(s.is_empty());
        }
    }
}
