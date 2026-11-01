//! Hedera (HBAR): ECDSA secp256k1 keys at `m/44'/3030'/0'/0/account` — the "standard" ECDSA path
//! of the Hedera SDKs (`Mnemonic.toStandardECDSAsecp256k1PrivateKey(passphrase, index)`, used by
//! HashPack and the other SDK-based wallets for ECDSA accounts; account 0 = `m/44'/3030'/0'/0/0`)
//! — the key's EVM address (`keccak256(uncompressed pubkey)[12..]`, the account's *alias*), and
//! the protobuf of a **HBAR CryptoTransfer** only.
//!
//! Why ECDSA and not ED25519 (`m/44'/3030'/0'/0'/a'`, Ledger and legacy HashPack accounts): an
//! ECDSA key has an EVM address, so the account can be **created by the first incoming
//! transfer** to that address (HIP-583 auto-creation, no one has to pay `AccountCreate` for us),
//! and an ED25519 account cannot be found from the phrase alone. ED25519 accounts are not
//! supported (documented in SECURITY.md).
//!
//! - Body: `TransactionBody` (services/transaction.proto) with only `transactionID`,
//!   `nodeAccountID`, `transactionFee`, `transactionValidDuration`, `memo` and `cryptoTransfer`
//!   (one HBAR debit of the payer, one credit). Anything else (token transfers, approvals,
//!   hooks, scheduled, nonce, other transaction types, unknown fields) is refused.
//! - Hand-written protobuf for this subset (proto3 canonical encoding: ascending field numbers,
//!   default values omitted). Same rule as XRP / TRON: **a body is accepted only if re-encoding
//!   the decoded body gives back the same bytes**. Cross-checked against Google's `protobuf`
//!   Python runtime with the official `.proto` files (see `tests/hedera.rs`).
//! - Signature: libsecp256k1 ECDSA over `keccak256(bodyBytes)` (what the Hedera SDKs and the
//!   consensus nodes use for `ECDSA_secp256k1` keys), compact `r ‖ s`, **low-S**; the
//!   `SignaturePair` carries the full 33-byte compressed key (needed to finalize a *hollow*
//!   account created by a transfer to the EVM address).

use bitcoin::secp256k1::{ecdsa::Signature, Message, PublicKey, Secp256k1};
use serde::{Deserialize, Serialize};
use sha3::{Digest, Keccak256};

use crate::display::sanitize_text;
use crate::error::{Error, Result};
use crate::keys::{hardened, normal, secp, XprivGuard};
use crate::mnemonic::Seed;
use crate::network::Network;

/// Tinybars per HBAR.
pub const HBAR_TINYBARS: u64 = 100_000_000;
/// `memo` limit of the network (bytes, UTF-8).
pub const HBAR_MAX_MEMO_BYTES: usize = 100;
/// Longest `transactionValidDuration` accepted by the network (seconds).
pub const HBAR_MAX_VALID_DURATION: i64 = 180;
/// Max fees above 2 HBAR need a reinforced confirmation (a transfer costs ≈ $0.0001, an
/// auto-created account ≈ $0.05).
pub const HBAR_HIGH_FEE_TINYBARS: u64 = 2 * HBAR_TINYBARS;
/// 50 billion HBAR, the whole supply.
const MAX_TINYBARS: u64 = 50_000_000_000 * HBAR_TINYBARS;
const MAX_BODY: usize = 2048;
const MAX_MEMO_TEXT: usize = 100;
/// At most this many copies of one transfer (one per consensus node, same transaction ID).
pub const HBAR_MAX_NODES: usize = 4;

// ---------------------------------------------------------------------------------------------
// Keys and addresses
// ---------------------------------------------------------------------------------------------

fn path(account: u32) -> Result<[bitcoin::bip32::ChildNumber; 5]> {
    Ok([
        hardened(44)?,
        hardened(3030)?,
        hardened(0)?,
        normal(0)?,
        normal(account)?,
    ])
}

/// Path of the key of Hedera account `account`: `m/44'/3030'/0'/0/account` (SDK standard ECDSA
/// path; the account number is the last, non-hardened index, like the SDKs' `index`).
pub fn hbar_path(account: u32) -> String {
    format!("m/44'/3030'/0'/0/{account}")
}

/// Compressed secp256k1 public key of account `account`.
pub fn hbar_public_key(seed: &Seed, account: u32) -> Result<[u8; 33]> {
    let secp = secp()?;
    let master = XprivGuard::master(seed, bitcoin::NetworkKind::Main)?;
    let key = master.derive(&secp, &path(account)?)?;
    Ok(key.xpriv().private_key.public_key(&secp).serialize())
}

fn keccak256(data: &[u8]) -> [u8; 32] {
    Keccak256::digest(data).into()
}

fn evm_bytes_of_pubkey(pk: &PublicKey) -> [u8; 20] {
    let full = pk.serialize_uncompressed();
    let h = keccak256(&full[1..]);
    let mut a = [0u8; 20];
    a.copy_from_slice(&h[12..]);
    a
}

/// EVM address (EIP-55) of a compressed or uncompressed secp256k1 public key: the alias under
/// which Hedera auto-creates the account.
pub fn hbar_evm_address_of_pubkey(pk: &[u8]) -> Result<String> {
    crate::evm::evm_address_of_pubkey(pk)
}

/// EVM address of account `account` (`m/44'/3030'/0'/0/account`), EIP-55.
pub fn hbar_evm_address(seed: &Seed, account: u32) -> Result<String> {
    hbar_evm_address_of_pubkey(&hbar_public_key(seed, account)?)
}

fn evm_string(a: &[u8; 20]) -> String {
    // EIP-55 of raw bytes, through the EVM module's checker.
    crate::evm::evm_checksum_address(&format!("0x{}", hex::encode(a)))
        .unwrap_or_else(|_| format!("0x{}", hex::encode(a)))
}

/// HIP-15 checksum (5 letters) of `0.0.num` for a ledger (mainnet ledger ID `0x00`, testnet
/// `0x01`).
pub fn hbar_checksum(network: Network, num: u64) -> String {
    let ledger: u8 = match network {
        Network::Mainnet => 0,
        Network::Testnet => 1,
    };
    let addr = format!("0.0.{num}");
    const P3: u64 = 26 * 26 * 26;
    const P5: u64 = 26 * 26 * 26 * 26 * 26;
    const M: u64 = 1_000_003;
    const W: u64 = 31;
    let (mut s, mut s0, mut s1, mut sh) = (0u64, 0u64, 0u64, 0u64);
    for (i, ch) in addr.bytes().enumerate() {
        let d = if ch == b'.' { 10 } else { u64::from(ch - b'0') };
        s = (W * s + d) % P3;
        if i % 2 == 0 {
            s0 = (s0 + d) % 11;
        } else {
            s1 = (s1 + d) % 11;
        }
    }
    for b in [ledger, 0, 0, 0, 0, 0, 0] {
        sh = (W * sh + u64::from(b)) % P5;
    }
    let len = addr.len() as u64;
    let mut c = ((((len % 5) * 11 + s0) * 11 + s1) * P3 + s + sh) % P5;
    c = (c * M) % P5;
    let mut out = [b'a'; 5];
    for slot in out.iter_mut().rev() {
        *slot = b'a' + (c % 26) as u8;
        c /= 26;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Parses `0.0.num`, optionally followed by its HIP-15 checksum (`0.0.123-vfmkw`), which must
/// then be the checksum **of this network**. Other shards / realms are refused (Hedera only uses
/// 0.0 today).
pub fn hbar_parse_account_id(s: &str, network: Network) -> Result<u64> {
    let s = s.trim();
    let (id, sum) = match s.split_once('-') {
        Some((id, sum)) => (id, Some(sum)),
        None => (s, None),
    };
    let num = id
        .strip_prefix("0.0.")
        .ok_or_else(|| Error::input("identifiant Hedera attendu : 0.0.nombre"))?;
    if num.is_empty()
        || num.len() > 19
        || !num.bytes().all(|b| b.is_ascii_digit())
        || (num.len() > 1 && num.starts_with('0'))
    {
        return Err(Error::input("identifiant Hedera invalide"));
    }
    let n: u64 = num
        .parse()
        .map_err(|_| Error::input("identifiant Hedera invalide"))?;
    if n == 0 || n > i64::MAX as u64 {
        return Err(Error::input("identifiant Hedera invalide"));
    }
    if let Some(sum) = sum {
        if sum != hbar_checksum(network, n) {
            return Err(Error::input(
                "somme de contrôle de l'identifiant Hedera incorrecte (ou identifiant d'un autre réseau)",
            ));
        }
    }
    Ok(n)
}

/// Recipient of a transfer: an account ID, or an EVM address (alias; the network creates the
/// account if none has it).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HbarRecipient {
    /// `0.0.num`.
    Id(u64),
    /// 20-byte EVM address alias.
    Evm([u8; 20]),
}

impl HbarRecipient {
    /// `0.0.num` or the EIP-55 address.
    pub fn display(&self) -> String {
        match self {
            HbarRecipient::Id(n) => format!("0.0.{n}"),
            HbarRecipient::Evm(a) => evm_string(a),
        }
    }
}

/// A "long-zero" EVM address (`0x` + 4 zero bytes shard + 8 zero bytes realm + 8 bytes num) is
/// the EVM form of an account ID, not an alias.
fn long_zero(a: &[u8; 20]) -> Option<u64> {
    if a[..12].iter().all(|b| *b == 0) {
        let mut n = [0u8; 8];
        n.copy_from_slice(&a[12..]);
        Some(u64::from_be_bytes(n))
    } else {
        None
    }
}

/// Parses a recipient: `0.0.num` (checksum optional, verified for `network`), or a `0x` EVM
/// address (all lower / upper case, or a valid EIP-55 checksum). A long-zero address is turned
/// into its account ID.
pub fn hbar_parse_recipient(s: &str, network: Network) -> Result<HbarRecipient> {
    let t = s.trim();
    if t.starts_with("0x") || t.starts_with("0X") {
        let a = crate::evm::evm_checksum_address(t)
            .map_err(|_| Error::input("adresse EVM invalide (0x + 40 hexadécimaux, EIP-55)"))?;
        let mut bytes = [0u8; 20];
        hex::decode_to_slice(&a[2..], &mut bytes)
            .map_err(|_| Error::input("adresse EVM invalide"))?;
        return Ok(match long_zero(&bytes) {
            Some(0) => return Err(Error::input("adresse nulle refusée")),
            Some(n) if n <= i64::MAX as u64 => HbarRecipient::Id(n),
            Some(_) => return Err(Error::input("adresse EVM invalide")),
            None => HbarRecipient::Evm(bytes),
        });
    }
    Ok(HbarRecipient::Id(hbar_parse_account_id(t, network)?))
}

// ---------------------------------------------------------------------------------------------
// Protobuf (proto3, canonical) for the CryptoTransfer subset
// ---------------------------------------------------------------------------------------------

fn bad(msg: impl Into<String>) -> Error {
    Error::input(format!("transaction Hedera refusée : {}", msg.into()))
}

fn put_varint(o: &mut Vec<u8>, mut v: u64) {
    while v >= 0x80 {
        o.push((v as u8) | 0x80);
        v >>= 7;
    }
    o.push(v as u8);
}

fn put_key(o: &mut Vec<u8>, field: u32, wire: u8) {
    put_varint(o, (u64::from(field) << 3) | u64::from(wire));
}

fn put_uint(o: &mut Vec<u8>, field: u32, v: u64) {
    if v != 0 {
        put_key(o, field, 0);
        put_varint(o, v);
    }
}

fn put_bytes(o: &mut Vec<u8>, field: u32, b: &[u8]) {
    put_key(o, field, 2);
    put_varint(o, b.len() as u64);
    o.extend_from_slice(b);
}

fn zigzag(n: i64) -> u64 {
    ((n << 1) ^ (n >> 63)) as u64
}

fn unzigzag(v: u64) -> i64 {
    ((v >> 1) as i64) ^ -((v & 1) as i64)
}

/// One field read from the wire: varint or length-delimited (other wire types are refused).
enum Val<'a> {
    Varint(u64),
    Bytes(&'a [u8]),
}

fn read_varint(b: &mut &[u8]) -> Result<u64> {
    let mut v = 0u64;
    for i in 0..10 {
        let (&byte, rest) = b.split_first().ok_or_else(|| bad("varint tronqué"))?;
        *b = rest;
        if i == 9 && byte > 1 {
            return Err(bad("varint trop long"));
        }
        v |= u64::from(byte & 0x7F) << (7 * i);
        if byte & 0x80 == 0 {
            return Ok(v);
        }
    }
    Err(bad("varint trop long"))
}

/// All fields of a message, in wire order.
fn fields(mut b: &[u8]) -> Result<Vec<(u32, Val<'_>)>> {
    let mut out = Vec::new();
    while !b.is_empty() {
        let key = read_varint(&mut b)?;
        let field = u32::try_from(key >> 3).map_err(|_| bad("numéro de champ"))?;
        if field == 0 {
            return Err(bad("numéro de champ nul"));
        }
        match key & 7 {
            0 => out.push((field, Val::Varint(read_varint(&mut b)?))),
            2 => {
                let len = usize::try_from(read_varint(&mut b)?).map_err(|_| bad("longueur"))?;
                if len > b.len() {
                    return Err(bad("champ tronqué"));
                }
                let (v, rest) = b.split_at(len);
                b = rest;
                out.push((field, Val::Bytes(v)));
            }
            w => return Err(bad(format!("type de champ {w} inattendu (champ {field})"))),
        }
    }
    Ok(out)
}

fn varint_of(v: &Val<'_>, what: &str) -> Result<u64> {
    match v {
        Val::Varint(x) => Ok(*x),
        Val::Bytes(_) => Err(bad(format!("{what} : entier attendu"))),
    }
}

fn bytes_of<'a>(v: &Val<'a>, what: &str) -> Result<&'a [u8]> {
    match v {
        Val::Bytes(x) => Ok(x),
        Val::Varint(_) => Err(bad(format!("{what} : message attendu"))),
    }
}

fn enc_account_num(num: u64) -> Vec<u8> {
    let mut o = Vec::new();
    put_key(&mut o, 3, 0);
    put_varint(&mut o, num);
    o
}

fn enc_recipient(r: &HbarRecipient) -> Vec<u8> {
    match r {
        HbarRecipient::Id(n) => enc_account_num(*n),
        HbarRecipient::Evm(a) => {
            let mut o = Vec::new();
            put_bytes(&mut o, 4, a);
            o
        }
    }
}

/// `AccountID` of shard 0, realm 0: a number, or (`allow_alias`) a 20-byte EVM alias.
fn dec_account(b: &[u8], allow_alias: bool, what: &str) -> Result<HbarRecipient> {
    let mut out = None;
    for (f, v) in fields(b)? {
        match f {
            1 | 2 => {
                if varint_of(&v, what)? != 0 {
                    return Err(bad(format!(
                        "{what} : seuls les comptes 0.0.x sont pris en charge"
                    )));
                }
            }
            3 => {
                let n = varint_of(&v, what)?;
                if n == 0 || n > i64::MAX as u64 {
                    return Err(bad(format!("{what} : numéro de compte invalide")));
                }
                out = Some(HbarRecipient::Id(n));
            }
            4 if allow_alias => {
                let a: [u8; 20] = bytes_of(&v, what)?
                    .try_into()
                    .map_err(|_| bad(format!("{what} : alias de 20 octets attendu")))?;
                if long_zero(&a).is_some() {
                    return Err(bad(format!("{what} : alias « long-zero » refusé")));
                }
                out = Some(HbarRecipient::Evm(a));
            }
            4 => return Err(bad(format!("{what} : alias refusé"))),
            f => return Err(bad(format!("{what} : champ inconnu {f}"))),
        }
    }
    out.ok_or_else(|| bad(format!("{what} : compte manquant")))
}

fn dec_num(b: &[u8], what: &str) -> Result<u64> {
    match dec_account(b, false, what)? {
        HbarRecipient::Id(n) => Ok(n),
        HbarRecipient::Evm(_) => Err(bad(format!("{what} : alias refusé"))),
    }
}

/// A HBAR transfer: the only `TransactionBody` Kyro builds and signs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HbarTransfer {
    /// Payer and sender (`transactionID.accountID`, debited in the transfer list).
    pub payer: u64,
    /// `transactionID.transactionValidStart` seconds (UNIX).
    pub valid_start_secs: i64,
    /// … nanoseconds.
    pub valid_start_nanos: i32,
    /// `nodeAccountID`: the consensus node this copy is for.
    pub node: u64,
    /// `transactionFee`: the **maximum** fee, tinybars (only the actual fee is charged).
    pub max_fee: u64,
    /// `transactionValidDuration`, seconds.
    pub valid_duration: i64,
    /// `memo` (≤ 100 bytes).
    pub memo: String,
    /// Credited account.
    pub to: HbarRecipient,
    /// Tinybars moved from `payer` to `to`.
    pub amount: u64,
}

impl HbarTransfer {
    /// Canonical `TransactionBody` bytes (what is signed).
    pub fn encode(&self) -> Vec<u8> {
        let mut ts = Vec::new();
        put_uint(&mut ts, 1, self.valid_start_secs as u64);
        put_uint(&mut ts, 2, self.valid_start_nanos as u32 as u64);
        let mut txid = Vec::new();
        put_bytes(&mut txid, 1, &ts);
        put_bytes(&mut txid, 2, &enc_account_num(self.payer));
        let mut dur = Vec::new();
        put_uint(&mut dur, 1, self.valid_duration as u64);

        let amount = i64::try_from(self.amount).unwrap_or(i64::MAX);
        let mut debit = Vec::new();
        put_bytes(&mut debit, 1, &enc_account_num(self.payer));
        put_uint(&mut debit, 2, zigzag(-amount));
        let mut credit = Vec::new();
        put_bytes(&mut credit, 1, &enc_recipient(&self.to));
        put_uint(&mut credit, 2, zigzag(amount));
        let mut list = Vec::new();
        put_bytes(&mut list, 1, &debit);
        put_bytes(&mut list, 1, &credit);
        let mut ct = Vec::new();
        put_bytes(&mut ct, 1, &list);

        let mut o = Vec::new();
        put_bytes(&mut o, 1, &txid);
        put_bytes(&mut o, 2, &enc_account_num(self.node));
        put_uint(&mut o, 3, self.max_fee);
        put_bytes(&mut o, 4, &dur);
        if !self.memo.is_empty() {
            put_bytes(&mut o, 6, self.memo.as_bytes());
        }
        put_bytes(&mut o, 14, &ct);
        o
    }

    /// Strict decoding of a `TransactionBody`. Refused: any field other than the six above (other
    /// transaction types, `batch_key`, `max_custom_fees`, …), `scheduled`, `nonce`, token
    /// transfers, `is_approval` (allowance spending), hooks, anything but one debit of the payer
    /// followed by one credit of the same amount, and any encoding that does not re-encode
    /// identically.
    pub fn decode(raw: &[u8]) -> Result<HbarTransfer> {
        if raw.len() > MAX_BODY {
            return Err(bad("trop grande"));
        }
        let (mut txid, mut node, mut fee, mut dur, mut memo, mut ct) =
            (None, None, 0u64, None, String::new(), None);
        for (f, v) in fields(raw)? {
            match f {
                1 => txid = Some(bytes_of(&v, "transactionID")?),
                2 => node = Some(dec_num(bytes_of(&v, "nodeAccountID")?, "nodeAccountID")?),
                3 => fee = varint_of(&v, "transactionFee")?,
                4 => dur = Some(bytes_of(&v, "transactionValidDuration")?),
                5 => return Err(bad("generateRecord (obsolète) refusé")),
                6 => {
                    memo = String::from_utf8(bytes_of(&v, "memo")?.to_vec())
                        .map_err(|_| bad("mémo : UTF-8 invalide"))?
                }
                14 => ct = Some(bytes_of(&v, "cryptoTransfer")?),
                f => {
                    return Err(bad(format!(
                        "champ {f} : seul un transfert de HBAR (CryptoTransfer) est signé par Kyro"
                    )))
                }
            }
        }
        // transactionID
        let txid = txid.ok_or_else(|| bad("transactionID manquant"))?;
        let (mut start, mut payer) = (None, None);
        for (f, v) in fields(txid)? {
            match f {
                1 => start = Some(bytes_of(&v, "transactionValidStart")?),
                2 => payer = Some(dec_num(bytes_of(&v, "payeur")?, "payeur")?),
                3 => return Err(bad("transaction programmée (scheduled) refusée")),
                4 => return Err(bad("nonce refusé (transaction enfant)")),
                f => return Err(bad(format!("transactionID : champ inconnu {f}"))),
            }
        }
        let (mut secs, mut nanos) = (0u64, 0u64);
        for (f, v) in fields(start.ok_or_else(|| bad("transactionValidStart manquant"))?)? {
            match f {
                1 => secs = varint_of(&v, "secondes")?,
                2 => nanos = varint_of(&v, "nanosecondes")?,
                f => return Err(bad(format!("Timestamp : champ inconnu {f}"))),
            }
        }
        if secs == 0 || secs > i64::MAX as u64 || nanos >= 1_000_000_000 {
            return Err(bad("transactionValidStart invalide"));
        }
        let mut duration = 0u64;
        for (f, v) in fields(dur.ok_or_else(|| bad("transactionValidDuration manquant"))?)? {
            match f {
                1 => duration = varint_of(&v, "durée")?,
                f => return Err(bad(format!("Duration : champ inconnu {f}"))),
            }
        }
        // cryptoTransfer
        let ct = ct.ok_or_else(|| bad("cryptoTransfer manquant"))?;
        let mut list = None;
        for (f, v) in fields(ct)? {
            match f {
                1 => list = Some(bytes_of(&v, "transfers")?),
                2 => return Err(bad("transferts de tokens HTS refusés (HBAR seulement)")),
                f => return Err(bad(format!("cryptoTransfer : champ inconnu {f}"))),
            }
        }
        let mut entries = Vec::new();
        for (f, v) in fields(list.ok_or_else(|| bad("liste de transferts manquante"))?)? {
            if f != 1 {
                return Err(bad(format!("TransferList : champ inconnu {f}")));
            }
            let (mut acc, mut amount) = (None, 0i64);
            for (g, w) in fields(bytes_of(&v, "accountAmounts")?)? {
                match g {
                    1 => acc = Some(dec_account(bytes_of(&w, "compte")?, true, "compte")?),
                    2 => amount = unzigzag(varint_of(&w, "montant")?),
                    3 => {
                        return Err(bad(
                            "is_approval refusé : dépense par autorisation (allowance)",
                        ))
                    }
                    4 | 5 => return Err(bad("crochet (hook) refusé")),
                    g => return Err(bad(format!("AccountAmount : champ inconnu {g}"))),
                }
            }
            entries.push((acc.ok_or_else(|| bad("compte manquant"))?, amount));
        }
        let payer = payer.ok_or_else(|| bad("payeur manquant"))?;
        let [(from, debit), (to, credit)] = <[(HbarRecipient, i64); 2]>::try_from(entries)
            .map_err(|_| bad("exactement un débit et un crédit attendus"))?;
        if from != HbarRecipient::Id(payer) {
            return Err(bad("le compte débité n'est pas le payeur"));
        }
        if credit <= 0 || debit != -credit {
            return Err(bad("montants incohérents (un débit, puis un crédit égal)"));
        }
        let t = HbarTransfer {
            payer,
            valid_start_secs: secs as i64,
            valid_start_nanos: nanos as i32,
            node: node.ok_or_else(|| bad("nodeAccountID manquant"))?,
            max_fee: fee,
            valid_duration: i64::try_from(duration).map_err(|_| bad("durée"))?,
            memo,
            to,
            amount: credit as u64,
        };
        if t.encode() != raw {
            return Err(bad(
                "encodage non canonique (ordre, doublon, valeur par défaut ou disposition inconnue)",
            ));
        }
        Ok(t)
    }

    /// `0.0.payer@seconds.nanoseconds` (SDK / HashScan form).
    pub fn transaction_id(&self) -> String {
        format!(
            "0.0.{}@{}.{:09}",
            self.payer, self.valid_start_secs, self.valid_start_nanos
        )
    }

    /// `0.0.payer-seconds-nanoseconds` (mirror node REST form).
    pub fn mirror_transaction_id(&self) -> String {
        format!(
            "0.0.{}-{}-{:09}",
            self.payer, self.valid_start_secs, self.valid_start_nanos
        )
    }

    /// Same transfer, ignoring the node (copies for several nodes must be otherwise identical).
    fn same_except_node(&self, other: &HbarTransfer) -> bool {
        let mut o = other.clone();
        o.node = self.node;
        o == *self
    }
}

/// Validates a memo typed by the user: ≤ 100 bytes, no NUL (refused by the network), no
/// control / invisible / bidi character.
pub fn hbar_check_memo(memo: &str) -> Result<()> {
    if memo.len() > HBAR_MAX_MEMO_BYTES {
        return Err(Error::input(format!(
            "mémo trop long : {HBAR_MAX_MEMO_BYTES} octets au plus"
        )));
    }
    if sanitize_text(memo, HBAR_MAX_MEMO_BYTES + 1).altered {
        return Err(Error::input(
            "mémo : caractères de contrôle, invisibles ou de direction refusés",
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Summary, signing, verification
// ---------------------------------------------------------------------------------------------

/// Reasons for caution (all of them require the reinforced confirmation).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum HbarWarning {
    /// Max fee above 2 HBAR.
    HighFee,
    /// The memo had control / invisible / bidi characters removed or was cut: the dialog shows
    /// a cleaned version (the hex is exact).
    UnusualText,
}

/// Plain-language summary of a HBAR transfer, decoded by Rust.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HbarTxSummary {
    /// Payer and sender, `0.0.x` (always our account, checked).
    pub from: String,
    /// `0.0.x`, or an EVM address (EIP-55).
    pub to: String,
    /// `to` is an EVM address (alias): the network auto-creates the account if none has it.
    pub to_is_evm: bool,
    /// Tinybars, decimal string.
    pub amount: String,
    /// Maximum fee, tinybars (only the actual fee is charged).
    pub max_fee: String,
    /// Memo, cleaned for display (`None` = no memo).
    pub memo: Option<String>,
    /// Memo bytes, hex (exact).
    pub memo_hex: Option<String>,
    /// `0.0.payer@secs.nanos`.
    pub transaction_id: String,
    /// Mirror-node form of the transaction ID.
    pub mirror_transaction_id: String,
    /// UNIX seconds: not valid before.
    pub valid_start: i64,
    /// Seconds of validity after `valid_start`.
    pub valid_duration: i64,
    /// Consensus nodes this transfer is signed for (one copy each, same transaction ID: the
    /// network executes it at most once).
    pub nodes: Vec<String>,
    /// Reasons for caution.
    pub warnings: Vec<HbarWarning>,
    /// The confirmation must be followed by a reinforced one.
    pub requires_extra_confirmation: bool,
}

fn decode_bodies(bodies: &[String]) -> Result<Vec<(Vec<u8>, HbarTransfer)>> {
    if bodies.is_empty() || bodies.len() > HBAR_MAX_NODES {
        return Err(bad(format!("1 à {HBAR_MAX_NODES} copies attendues")));
    }
    bodies
        .iter()
        .map(|b| {
            let raw =
                hex::decode(b.trim()).map_err(|_| Error::input("corps : hexadécimal attendu"))?;
            let t = HbarTransfer::decode(&raw)?;
            Ok((raw, t))
        })
        .collect()
}

fn summarize(
    ts: &[HbarTransfer],
    our_account: u64,
    our_evm: &[u8; 20],
    allowed_nodes: &[u64],
) -> Result<HbarTxSummary> {
    let t = ts.first().ok_or_else(|| bad("aucune copie"))?;
    for (i, x) in ts.iter().enumerate() {
        if !t.same_except_node(x) {
            return Err(bad("les copies pour plusieurs nœuds diffèrent"));
        }
        if !allowed_nodes.contains(&x.node) {
            return Err(bad(format!("nœud 0.0.{} hors de la liste de Kyro", x.node)));
        }
        if ts[..i].iter().any(|y| y.node == x.node) {
            return Err(bad("nœud en double"));
        }
    }
    if t.payer != our_account {
        return Err(bad("le payeur n'est pas le compte de ce portefeuille"));
    }
    match t.to {
        HbarRecipient::Id(n) if n == our_account => return Err(bad("transfert à soi-même")),
        HbarRecipient::Evm(a) if a == *our_evm => return Err(bad("transfert à soi-même")),
        _ => {}
    }
    if t.amount == 0 || t.amount > MAX_TINYBARS {
        return Err(bad("montant invalide"));
    }
    if t.max_fee == 0 {
        return Err(bad("frais maximum nuls"));
    }
    if !(1..=HBAR_MAX_VALID_DURATION).contains(&t.valid_duration) {
        return Err(bad("durée de validité hors de 1 à 180 s"));
    }
    if t.memo.len() > HBAR_MAX_MEMO_BYTES || t.memo.contains('\0') {
        return Err(bad("mémo : 100 octets au plus, sans octet nul"));
    }
    let mut warnings = Vec::new();
    if t.max_fee > HBAR_HIGH_FEE_TINYBARS {
        warnings.push(HbarWarning::HighFee);
    }
    let memo = (!t.memo.is_empty()).then(|| {
        let clean = sanitize_text(&t.memo, MAX_MEMO_TEXT);
        if clean.altered {
            warnings.push(HbarWarning::UnusualText);
        }
        clean.text
    });
    Ok(HbarTxSummary {
        from: format!("0.0.{}", t.payer),
        to: t.to.display(),
        to_is_evm: matches!(t.to, HbarRecipient::Evm(_)),
        amount: t.amount.to_string(),
        max_fee: t.max_fee.to_string(),
        memo_hex: (!t.memo.is_empty()).then(|| hex::encode(t.memo.as_bytes())),
        memo,
        transaction_id: t.transaction_id(),
        mirror_transaction_id: t.mirror_transaction_id(),
        valid_start: t.valid_start_secs,
        valid_duration: t.valid_duration,
        nodes: ts.iter().map(|x| format!("0.0.{}", x.node)).collect(),
        requires_extra_confirmation: !warnings.is_empty(),
        warnings,
    })
}

fn evm_of_pubkey33(pk: &[u8]) -> Result<[u8; 20]> {
    let pk = PublicKey::from_slice(pk).map_err(|_| Error::input("clé publique invalide"))?;
    Ok(evm_bytes_of_pubkey(&pk))
}

/// Decodes the **unsigned** bodies (hex, one per consensus node) of a transfer for the dialog.
/// Refused: anything [`HbarTransfer::decode`] refuses, copies that differ other than by their
/// node, a node outside `allowed_nodes`, a payer other than `our_account`, a transfer to
/// ourselves (account ID or our EVM address), a zero amount or fee, a validity outside 1–180 s.
pub fn hbar_decode_tx(
    bodies: &[String],
    our_account: u64,
    our_pubkey: &[u8],
    allowed_nodes: &[u64],
) -> Result<HbarTxSummary> {
    let ts: Vec<HbarTransfer> = decode_bodies(bodies)?.into_iter().map(|(_, t)| t).collect();
    summarize(
        &ts,
        our_account,
        &evm_of_pubkey33(our_pubkey)?,
        allowed_nodes,
    )
}

fn signed_transaction(body: &[u8], pk: &[u8; 33], sig: &[u8; 64]) -> Vec<u8> {
    let mut pair = Vec::new();
    put_bytes(&mut pair, 1, pk);
    put_bytes(&mut pair, 6, sig);
    let mut map = Vec::new();
    put_bytes(&mut map, 1, &pair);
    let mut st = Vec::new();
    put_bytes(&mut st, 1, body);
    put_bytes(&mut st, 2, &map);
    let mut tx = Vec::new();
    put_bytes(&mut tx, 5, &st);
    tx
}

/// Signs the bodies (hex, one per node) with the key of account `account`
/// (`m/44'/3030'/0'/0/account`) after decoding them like [`hbar_decode_tx`]. Returns
/// `(signed Transaction protobufs, hex, same order; summary)`. Each signature is checked before
/// it is returned.
pub fn hbar_sign(
    seed: &Seed,
    account: u32,
    our_account: u64,
    bodies: &[String],
    allowed_nodes: &[u64],
) -> Result<(Vec<String>, HbarTxSummary)> {
    let secp = secp()?;
    let master = XprivGuard::master(seed, bitcoin::NetworkKind::Main)?;
    let key = master.derive(&secp, &path(account)?)?;
    // A reference: `SecretKey` is `Copy`, a copy here would outlive the guard's erasure.
    let sk = &key.xpriv().private_key;
    let pk = sk.public_key(&secp);
    let pk33 = pk.serialize();
    let decoded = decode_bodies(bodies)?;
    let ts: Vec<HbarTransfer> = decoded.iter().map(|(_, t)| t.clone()).collect();
    let summary = summarize(&ts, our_account, &evm_bytes_of_pubkey(&pk), allowed_nodes)?;
    let mut out = Vec::with_capacity(decoded.len());
    for (raw, _) in &decoded {
        let msg = Message::from_digest(keccak256(raw));
        let mut sig = secp.sign_ecdsa(&msg, sk);
        sig.normalize_s();
        secp.verify_ecdsa(&msg, &sig, &pk)
            .map_err(|_| Error::crypto("échec de la vérification de la signature"))?;
        out.push(hex::encode(signed_transaction(
            raw,
            &pk33,
            &sig.serialize_compact(),
        )));
    }
    Ok((out, summary))
}

/// A signed `Transaction` checked by [`hbar_verify_signed`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HbarSignedTransfer {
    /// The decoded body.
    pub transfer: HbarTransfer,
    /// The compressed key that signed it.
    pub public_key: [u8; 33],
}

/// `(bodyBytes, pubKeyPrefix, signature field number, signature)` of a signed `Transaction`
/// with only `signedTransactionBytes` and exactly one signature pair (ECDSA field 6 or ED25519
/// field 3).
type SignedParts<'a> = (&'a [u8], &'a [u8], u32, &'a [u8]);

fn parse_signed(raw: &[u8]) -> Result<SignedParts<'_>> {
    if raw.len() > MAX_BODY * 2 {
        return Err(bad("trop grande"));
    }
    let mut st = None;
    for (f, v) in fields(raw)? {
        match f {
            5 => st = Some(bytes_of(&v, "signedTransactionBytes")?),
            f => {
                return Err(bad(format!(
                    "Transaction : champ {f} refusé (obsolète ou inconnu)"
                )))
            }
        }
    }
    let (mut body, mut map) = (None, None);
    for (f, v) in fields(st.ok_or_else(|| bad("signedTransactionBytes manquant"))?)? {
        match f {
            1 => body = Some(bytes_of(&v, "bodyBytes")?),
            2 => map = Some(bytes_of(&v, "sigMap")?),
            f => return Err(bad(format!("SignedTransaction : champ {f} refusé"))),
        }
    }
    let body = body.ok_or_else(|| bad("bodyBytes manquant"))?;
    let mut pairs = Vec::new();
    for (f, v) in fields(map.ok_or_else(|| bad("sigMap manquant"))?)? {
        if f != 1 {
            return Err(bad(format!("SignatureMap : champ {f} refusé")));
        }
        pairs.push(bytes_of(&v, "sigPair")?);
    }
    let [pair] = <[&[u8]; 1]>::try_from(pairs).map_err(|_| bad("une seule signature attendue"))?;
    let (mut prefix, mut sig) = (None, None);
    for (f, v) in fields(pair)? {
        match f {
            1 if prefix.is_none() => prefix = Some(bytes_of(&v, "pubKeyPrefix")?),
            3 | 6 if sig.is_none() => sig = Some((f, bytes_of(&v, "signature")?)),
            f => return Err(bad(format!("SignaturePair : champ {f} refusé"))),
        }
    }
    let prefix = prefix.ok_or_else(|| bad("clé manquante"))?;
    let (field, sig) = sig.ok_or_else(|| bad("signature manquante"))?;
    Ok((body, prefix, field, sig))
}

/// Decodes a signed `Transaction` (hex) strictly — only `signedTransactionBytes`, a body that
/// [`HbarTransfer::decode`] accepts, exactly one `ECDSA_secp256k1` signature pair with a full
/// 33-byte key — and checks the low-S signature over `keccak256(bodyBytes)`.
pub fn hbar_verify_signed(tx_hex: &str) -> Result<HbarSignedTransfer> {
    let raw = hex::decode(tx_hex.trim()).map_err(|_| Error::input("hexadécimal attendu"))?;
    let (body, prefix, field, sig) = parse_signed(&raw)?;
    if field != 6 {
        return Err(bad("signature ECDSA_secp256k1 attendue"));
    }
    let pk33: [u8; 33] = prefix
        .try_into()
        .map_err(|_| bad("clé complète de 33 octets attendue"))?;
    let sig64: [u8; 64] = sig
        .try_into()
        .map_err(|_| bad("signature de 64 octets attendue"))?;
    let transfer = HbarTransfer::decode(body)?;
    let pk = PublicKey::from_slice(&pk33).map_err(|_| bad("clé publique invalide"))?;
    let sig = Signature::from_compact(&sig64).map_err(|_| bad("signature invalide"))?;
    let mut low = sig;
    low.normalize_s();
    if low != sig {
        return Err(bad("la signature n'est pas low-S"));
    }
    Secp256k1::verification_only()
        .verify_ecdsa(&Message::from_digest(keccak256(body)), &sig, &pk)
        .map_err(|_| bad("la signature ne se vérifie pas"))?;
    if signed_transaction(body, &pk33, &sig64) != raw {
        return Err(bad("encodage non canonique"));
    }
    Ok(HbarSignedTransfer {
        transfer,
        public_key: pk33,
    })
}

// ---------------------------------------------------------------------------------------------
// ED25519 hardware accounts (Ledger « Hedera » app)
// ---------------------------------------------------------------------------------------------

/// DER (`SubjectPublicKeyInfo`) prefix of an ED25519 key, the form Hedera wallets and the
/// mirror node show (`302a300506032b6570032100` ‖ key).
const ED25519_DER_PREFIX: &str = "302a300506032b6570032100";
/// Longest body the Ledger Hedera app takes (one APDU: 255 bytes minus the 4-byte key index).
pub const HBAR_HW_MAX_BODY: usize = 251;

/// DER hex of an ED25519 public key (what a hardware Hedera account stores as « address »: the
/// account ID is not derived from the key, it is looked up on the mirror node).
pub fn hbar_ed25519_key_string(pk: &[u8; 32]) -> String {
    format!("{ED25519_DER_PREFIX}{}", hex::encode(pk))
}

/// Long-zero EVM form of an account number (to refuse a transfer to ourselves by that form).
fn long_zero_of(num: u64) -> [u8; 20] {
    let mut a = [0u8; 20];
    a[12..].copy_from_slice(&num.to_be_bytes());
    a
}

/// [`hbar_decode_tx`] for an ED25519 account `our_account` (no EVM alias: the long-zero form
/// of the account is the one that names it).
pub fn hbar_decode_tx_ed25519(
    bodies: &[String],
    our_account: u64,
    allowed_nodes: &[u64],
) -> Result<HbarTxSummary> {
    let ts: Vec<HbarTransfer> = decode_bodies(bodies)?.into_iter().map(|(_, t)| t).collect();
    summarize(&ts, our_account, &long_zero_of(our_account), allowed_nodes)
}

/// The bytes the Ledger signs for one body (hex): the body itself (the app signs `bodyBytes`
/// with ED25519, as the network checks them), after strict decoding; at most
/// [`HBAR_HW_MAX_BODY`] bytes.
pub fn hbar_hw_message(body_hex: &str) -> Result<Vec<u8>> {
    let raw =
        hex::decode(body_hex.trim()).map_err(|_| Error::input("corps : hexadécimal attendu"))?;
    HbarTransfer::decode(&raw)?;
    if raw.len() > HBAR_HW_MAX_BODY {
        return Err(bad(
            "trop long pour l'app Ledger Hedera (mémo plus court ?)",
        ));
    }
    Ok(raw)
}

fn signed_transaction_ed25519(body: &[u8], pk: &[u8; 32], sig: &[u8; 64]) -> Vec<u8> {
    let mut pair = Vec::new();
    put_bytes(&mut pair, 1, pk);
    put_bytes(&mut pair, 3, sig);
    let mut map = Vec::new();
    put_bytes(&mut map, 1, &pair);
    let mut st = Vec::new();
    put_bytes(&mut st, 1, body);
    put_bytes(&mut st, 2, &map);
    let mut tx = Vec::new();
    put_bytes(&mut tx, 5, &st);
    tx
}

/// Signed `Transaction` (hex) from the device's ED25519 signature of `body_hex`, checked with
/// [`hbar_verify_signed_ed25519`] before it is returned.
pub fn hbar_hw_signed(body_hex: &str, pk: &[u8; 32], sig: &[u8]) -> Result<String> {
    let body = hbar_hw_message(body_hex)?;
    let sig: [u8; 64] = sig
        .try_into()
        .map_err(|_| Error::crypto("signature de l'appareil : 64 octets attendus"))?;
    let out = hex::encode(signed_transaction_ed25519(&body, pk, &sig));
    let (_, signer) = hbar_verify_signed_ed25519(&out)?;
    if signer != *pk {
        return Err(Error::crypto("signature d'une autre clé"));
    }
    Ok(out)
}

/// Strict decoding of a signed `Transaction` (hex) with exactly one **ED25519** signature
/// pair (full 32-byte key) and its strict verification over `bodyBytes`. Returns the body and
/// the key.
pub fn hbar_verify_signed_ed25519(tx_hex: &str) -> Result<(HbarTransfer, [u8; 32])> {
    let raw = hex::decode(tx_hex.trim()).map_err(|_| Error::input("hexadécimal attendu"))?;
    let (body, prefix, field, sig) = parse_signed(&raw)?;
    if field != 3 {
        return Err(bad("signature ED25519 attendue"));
    }
    let pk: [u8; 32] = prefix
        .try_into()
        .map_err(|_| bad("clé complète de 32 octets attendue"))?;
    let sig64: [u8; 64] = sig
        .try_into()
        .map_err(|_| bad("signature de 64 octets attendue"))?;
    let transfer = HbarTransfer::decode(body)?;
    let key =
        ed25519_dalek::VerifyingKey::from_bytes(&pk).map_err(|_| bad("clé publique invalide"))?;
    key.verify_strict(body, &ed25519_dalek::Signature::from_bytes(&sig64))
        .map_err(|_| bad("la signature ne se vérifie pas"))?;
    if signed_transaction_ed25519(body, &pk, &sig64) != raw {
        return Err(bad("encodage non canonique"));
    }
    Ok((transfer, pk))
}

/// `TransactionResponse` of a consensus node: `(nodeTransactionPrecheckCode, cost)`.
pub fn hbar_decode_precheck(raw: &[u8]) -> Result<(u32, u64)> {
    let (mut code, mut cost) = (0u64, 0u64);
    for (f, v) in fields(raw)? {
        match f {
            1 => code = varint_of(&v, "code")?,
            2 => cost = varint_of(&v, "cost")?,
            _ => {}
        }
    }
    Ok((
        u32::try_from(code).map_err(|_| bad("code de réponse"))?,
        cost,
    ))
}

/// Name of a `ResponseCodeEnum` value (the ones a transfer can meet), else `CODE_n`.
pub fn hbar_response_name(code: u32) -> String {
    let name = match code {
        0 => "OK",
        1 => "INVALID_TRANSACTION",
        2 => "PAYER_ACCOUNT_NOT_FOUND",
        3 => "INVALID_NODE_ACCOUNT",
        4 => "TRANSACTION_EXPIRED",
        5 => "INVALID_TRANSACTION_START",
        6 => "INVALID_TRANSACTION_DURATION",
        7 => "INVALID_SIGNATURE",
        8 => "MEMO_TOO_LONG",
        9 => "INSUFFICIENT_TX_FEE",
        10 => "INSUFFICIENT_PAYER_BALANCE",
        11 => "DUPLICATE_TRANSACTION",
        12 => "BUSY",
        13 => "NOT_SUPPORTED",
        15 => "INVALID_ACCOUNT_ID",
        17 => "INVALID_TRANSACTION_ID",
        21 => "UNKNOWN",
        22 => "SUCCESS",
        27 => "BAD_ENCODING",
        28 => "INSUFFICIENT_ACCOUNT_BALANCE",
        35 => "INVALID_RECEIVING_NODE_ACCOUNT",
        43 => "INVALID_PAYER_SIGNATURE",
        48 => "INVALID_ACCOUNT_AMOUNTS",
        49 => "EMPTY_TRANSACTION_BODY",
        50 => "INVALID_TRANSACTION_BODY",
        60 => "ACCOUNT_ID_DOES_NOT_EXIST",
        64 => "TRANSACTION_OVERSIZE",
        67 => "PLATFORM_NOT_ACTIVE",
        69 => "PLATFORM_TRANSACTION_NOT_CREATED",
        71 => "INVALID_PAYER_ACCOUNT_ID",
        72 => "ACCOUNT_DELETED",
        74 => "ACCOUNT_REPEATED_IN_ACCOUNT_AMOUNTS",
        113 => "RECEIVER_SIG_REQUIRED",
        211 => "INVALID_ZERO_BYTE_IN_STRING",
        256 => "PAYER_ACCOUNT_DELETED",
        282 => "INVALID_ALIAS_KEY",
        366 => "THROTTLED_AT_CONSENSUS",
        _ => return format!("CODE_{code}"),
    };
    name.to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zigzag_round_trip() {
        for n in [
            0i64,
            1,
            -1,
            100_000_000,
            -100_000_000,
            i64::MAX,
            i64::MIN + 1,
        ] {
            assert_eq!(unzigzag(zigzag(n)), n);
        }
        assert_eq!(zigzag(-1), 1);
        assert_eq!(zigzag(1), 2);
    }

    #[test]
    fn varints_are_bounded() {
        let mut o = Vec::new();
        put_varint(&mut o, u64::MAX);
        assert_eq!(o.len(), 10);
        assert_eq!(read_varint(&mut o.as_slice()).unwrap(), u64::MAX);
        let too_long = [0xFFu8; 11];
        assert!(read_varint(&mut too_long.as_slice()).is_err());
        assert!(read_varint(&mut [0x80u8].as_slice()).is_err());
    }
}

#[cfg(test)]
mod hw_tests {
    use super::*;
    use ed25519_dalek::Signer;

    fn body(memo: &str) -> String {
        hex::encode(
            HbarTransfer {
                payer: 1234,
                valid_start_secs: 1_760_000_000,
                valid_start_nanos: 5,
                node: 3,
                max_fee: 100_000_000,
                valid_duration: 120,
                memo: memo.into(),
                to: HbarRecipient::Id(98),
                amount: 42,
            }
            .encode(),
        )
    }

    #[test]
    fn ed25519_signed_transfer() {
        let k = ed25519_dalek::SigningKey::from_bytes(&[7u8; 32]);
        let pk = k.verifying_key().to_bytes();
        let b = body("kyro");
        let msg = hbar_hw_message(&b).unwrap();
        let sig = k.sign(&msg).to_bytes();
        let signed = hbar_hw_signed(&b, &pk, &sig).unwrap();
        let (t, signer) = hbar_verify_signed_ed25519(&signed).unwrap();
        assert_eq!((t.payer, t.amount, signer), (1234, 42, pk));
        // Not accepted as an ECDSA transaction; a bad signature or another key is refused.
        assert!(hbar_verify_signed(&signed).is_err());
        let mut bad_sig = sig;
        bad_sig[0] ^= 1;
        assert!(hbar_hw_signed(&b, &pk, &bad_sig).is_err());
        let other = ed25519_dalek::SigningKey::from_bytes(&[8u8; 32]);
        assert!(hbar_hw_signed(&b, &other.verifying_key().to_bytes(), &sig).is_err());
        // The longest memo still fits one APDU of the Ledger app.
        assert!(hbar_hw_message(&body(&"m".repeat(100))).unwrap().len() <= HBAR_HW_MAX_BODY);
        assert_eq!(
            hbar_ed25519_key_string(&pk),
            format!("302a300506032b6570032100{}", hex::encode(pk))
        );
        let s = hbar_decode_tx_ed25519(std::slice::from_ref(&b), 1234, &[3]).unwrap();
        assert_eq!(s.amount, "42");
        // Payer must be our account.
        assert!(hbar_decode_tx_ed25519(&[b], 99, &[3]).is_err());
    }
}
