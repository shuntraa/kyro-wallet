//! Aptos: SLIP-10 ed25519 keys at `m/44'/637'/account'/0'/0'` (Petra, the Aptos CLI and SDKs,
//! Ledger; account 0 = their default `m/44'/637'/0'/0'/0'`), `0x…` addresses, and APT transfers
//! (`0x1::aptos_account::transfer`) in strict BCS.
//!
//! - Address = authentication key of a legacy single ed25519 key =
//!   `SHA3-256(32-byte public key || 0x00 (Ed25519 scheme))`, written `0x` + 64 lower-case hex
//!   characters (AIP-40 long form). Aptos addresses have **no checksum**: a typo gives another
//!   valid address, so the UI shows the full address and the native dialog repeats it in full.
//!   An account whose key was rotated keeps its address but not this key: Kyro only signs for
//!   the address derived here, and the network refuses a signature by a rotated-away key.
//! - Hashes: RustCrypto `sha3` (already used for EVM); keys and signatures: ed25519-dalek and
//!   ed25519-dalek-bip32 (the same crates as Solana). No new dependency.
//!
//! Kyro never signs bytes it did not build. The only accepted `RawTransaction` is
//!
//! ```text
//! RawTransaction {
//!   sender: address, sequence_number: u64,
//!   payload: EntryFunction(0x1::aptos_account::transfer, ty_args: [], args: [bcs(address), bcs(u64)]),
//!   max_gas_amount: u64, gas_unit_price: u64, expiration_timestamp_secs: u64, chain_id: u8,
//! }
//! ```
//!
//! Decoding is strict (canonical ULEB128, known variants only, no trailing byte) **and** the
//! decoded value is re-encoded and compared byte for byte with the input: any other layout
//! (another function or module, type arguments, a script, a multisig or "inner payload" (V1
//! orderless) transaction, a fee payer or secondary signers) is refused before anything is shown.
//!
//! Signing: `ed25519(SHA3-256("APTOS::RawTransaction") || bcs(RawTransaction))`. Signed
//! transaction: `bcs(RawTransaction) || 0x00 (TransactionAuthenticator::Ed25519) ||
//! uleb(32) || public key || uleb(64) || signature`. Transaction hash:
//! `SHA3-256(SHA3-256("APTOS::Transaction") || 0x00 (Transaction::UserTransaction) || signed)`.

use ed25519_dalek::Signer as _;
use ed25519_dalek_bip32::{ChildIndex, ExtendedSigningKey};
use serde::{Deserialize, Serialize};
use sha3::{Digest, Sha3_256};
use zeroize::Zeroize;

use crate::error::{Error, Result};
use crate::mnemonic::Seed;

/// Authentication-key scheme byte of a single ed25519 key.
pub const APTOS_ED25519_SCHEME: u8 = 0x00;
/// Octas per APT (8 decimals).
pub const OCTAS_PER_APT: u64 = 100_000_000;
/// Chain id of Aptos mainnet.
pub const APTOS_MAINNET_CHAIN_ID: u8 = 1;
/// Chain id of Aptos testnet.
pub const APTOS_TESTNET_CHAIN_ID: u8 = 2;
/// Maximum fee (`max_gas_amount × gas_unit_price`) above this (0.02 APT) is flagged: a plain
/// transfer costs about 0.0001 APT, creating the recipient's account a few thousandths.
pub const APTOS_HIGH_FEE_OCTAS: u64 = 2_000_000;
/// The only function Kyro calls.
pub const APTOS_TRANSFER_FUNCTION: &str = "0x1::aptos_account::transfer";

const RAW_TX_SALT: &[u8] = b"APTOS::RawTransaction";
const TX_SALT: &[u8] = b"APTOS::Transaction";
const MODULE_NAME: &[u8] = b"aptos_account";
const FUNCTION_NAME: &[u8] = b"transfer";
const MAX_BCS: usize = 4 * 1024;

fn bad(msg: impl Into<String>) -> Error {
    Error::input(format!("transaction Aptos refusée : {}", msg.into()))
}

fn sha3(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha3_256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

// ---------------------------------------------------------------- keys and addresses

fn hardened(index: u32) -> Result<ChildIndex> {
    ChildIndex::hardened(index).map_err(|_| Error::input("derivation index must be < 2^31"))
}

/// Path of Aptos account `account`: `m/44'/637'/account'/0'/0'` (every level hardened, SLIP-10).
pub fn aptos_path(account: u32) -> String {
    format!("m/44'/637'/{account}'/0'/0'")
}

fn signing_key(seed: &Seed, account: u32) -> Result<ed25519_dalek::SigningKey> {
    let path = [
        hardened(44)?,
        hardened(637)?,
        hardened(account)?,
        hardened(0)?,
        hardened(0)?,
    ];
    let root = ExtendedSigningKey::from_seed(&seed[..])
        .map_err(|_| Error::crypto("SLIP-10 master derivation failed"))?;
    let mut child = root
        .derive(&path)
        .map_err(|_| Error::crypto("SLIP-10 derivation failed"))?;
    // `SigningKey` zeroizes itself on drop; the chain codes do not, so wipe them here.
    let mut root = root;
    root.chain_code.zeroize();
    child.chain_code.zeroize();
    Ok(child.signing_key.clone())
}

/// 32-byte account address (= authentication key) of an ed25519 public key.
pub fn aptos_address_bytes_of_pubkey(pubkey: &[u8; 32]) -> [u8; 32] {
    sha3(&[pubkey, &[APTOS_ED25519_SCHEME]])
}

/// `0x` + 64 lower-case hex characters (AIP-40 long form).
pub fn aptos_address_string(bytes: &[u8; 32]) -> String {
    format!("0x{}", hex::encode(bytes))
}

/// Address of a raw 32-byte ed25519 public key. Fails if the bytes are not a valid curve point.
pub fn aptos_address_of_pubkey(pubkey: &[u8]) -> Result<String> {
    let bytes: [u8; 32] = pubkey
        .try_into()
        .map_err(|_| Error::input("clé publique ed25519 : 32 octets attendus"))?;
    ed25519_dalek::VerifyingKey::from_bytes(&bytes)
        .map_err(|_| Error::input("clé publique ed25519 invalide"))?;
    Ok(aptos_address_string(&aptos_address_bytes_of_pubkey(&bytes)))
}

/// Public key of account `account` (`m/44'/637'/account'/0'/0'`).
pub fn aptos_public_key(seed: &Seed, account: u32) -> Result<[u8; 32]> {
    Ok(signing_key(seed, account)?.verifying_key().to_bytes())
}

/// Address of account `account` (`m/44'/637'/account'/0'/0'`, see [`aptos_path`]).
pub fn aptos_address(seed: &Seed, account: u32) -> Result<String> {
    Ok(aptos_address_string(&aptos_address_bytes_of_pubkey(
        &aptos_public_key(seed, account)?,
    )))
}

/// Parses a recipient address: `0x` followed by exactly 64 hexadecimal characters (either
/// case). Short forms (`0x1`, an address whose leading zeros were dropped) and ANS names
/// (`nom.apt`) are refused: Kyro only sends to a full address the user can compare character
/// by character.
pub fn aptos_parse_address(address: &str) -> Result<[u8; 32]> {
    let a = address.trim();
    if a.ends_with(".apt") {
        return Err(Error::input(
            "les noms ANS (.apt) ne sont pas pris en charge : colle l'adresse 0x… complète",
        ));
    }
    let h = a.strip_prefix("0x").ok_or_else(|| {
        Error::input("adresse Aptos invalide : 0x suivi de 64 caractères hexadécimaux attendu")
    })?;
    if h.len() != 64 {
        return Err(Error::input(
            "adresse Aptos invalide : 64 caractères hexadécimaux attendus après 0x (forme courte refusée : demande l'adresse complète)",
        ));
    }
    let mut out = [0u8; 32];
    hex::decode_to_slice(h, &mut out)
        .map_err(|_| Error::input("adresse Aptos invalide (caractère non hexadécimal)"))?;
    Ok(out)
}

// ---------------------------------------------------------------- BCS

fn put_uleb(out: &mut Vec<u8>, mut v: u64) {
    loop {
        let b = (v & 0x7f) as u8;
        v >>= 7;
        if v == 0 {
            out.push(b);
            return;
        }
        out.push(b | 0x80);
    }
}

fn put_bytes(out: &mut Vec<u8>, b: &[u8]) {
    put_uleb(out, b.len() as u64);
    out.extend_from_slice(b);
}

struct Reader<'a>(&'a [u8]);

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        if self.0.len() < n {
            return Err(bad("données tronquées"));
        }
        let (h, t) = self.0.split_at(n);
        self.0 = t;
        Ok(h)
    }

    fn u8(&mut self) -> Result<u8> {
        Ok(self.take(1)?[0])
    }

    fn u64(&mut self) -> Result<u64> {
        let mut a = [0u8; 8];
        a.copy_from_slice(self.take(8)?);
        Ok(u64::from_le_bytes(a))
    }

    fn arr32(&mut self) -> Result<[u8; 32]> {
        let mut a = [0u8; 32];
        a.copy_from_slice(self.take(32)?);
        Ok(a)
    }

    /// Canonical ULEB128 ≤ u32::MAX (BCS lengths and variant tags).
    fn uleb(&mut self) -> Result<u32> {
        let mut v: u64 = 0;
        for i in 0..5 {
            let b = self.u8()?;
            v |= u64::from(b & 0x7f) << (7 * i);
            if b & 0x80 == 0 {
                if i > 0 && b == 0 {
                    return Err(bad("ULEB128 non canonique"));
                }
                return u32::try_from(v).map_err(|_| bad("ULEB128 trop grand"));
            }
        }
        Err(bad("ULEB128 trop long"))
    }

    fn bytes(&mut self, max: usize) -> Result<&'a [u8]> {
        let n = self.uleb()? as usize;
        if n > max {
            return Err(bad("champ trop long"));
        }
        self.take(n)
    }
}

/// An APT transfer (`0x1::aptos_account::transfer(recipient, amount)`), the only transaction
/// Kyro builds and signs on Aptos.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AptosTransfer {
    /// Sender (pays the gas: no fee payer).
    pub sender: [u8; 32],
    /// Sender's sequence number (replay protection).
    pub sequence_number: u64,
    /// Recipient (created by the transfer if it does not exist yet).
    pub recipient: [u8; 32],
    /// Octas.
    pub amount: u64,
    /// Gas units at most.
    pub max_gas_amount: u64,
    /// Octas per gas unit.
    pub gas_unit_price: u64,
    /// UNIX seconds after which the transaction is void.
    pub expiration_timestamp_secs: u64,
    /// 1 mainnet, 2 testnet.
    pub chain_id: u8,
}

impl AptosTransfer {
    fn check(&self) -> Result<()> {
        if self.amount == 0 {
            return Err(bad("montant nul"));
        }
        if self.max_gas_amount == 0 {
            return Err(bad("gaz maximum nul"));
        }
        if self.gas_unit_price == 0 {
            return Err(bad("prix du gaz nul"));
        }
        if self.max_gas_amount.checked_mul(self.gas_unit_price).is_none() {
            return Err(bad("frais maximum hors limites"));
        }
        if self.chain_id == 0 {
            return Err(bad("identifiant de chaîne nul"));
        }
        Ok(())
    }

    /// Maximum fee in octas (`max_gas_amount × gas_unit_price`), what the account must hold
    /// on top of the amount.
    pub fn max_fee(&self) -> u64 {
        self.max_gas_amount.saturating_mul(self.gas_unit_price)
    }

    /// BCS of the `RawTransaction` (what is signed, after the domain-separator hash).
    pub fn encode(&self) -> Result<Vec<u8>> {
        self.check()?;
        let mut o = Vec::with_capacity(160);
        o.extend_from_slice(&self.sender);
        o.extend_from_slice(&self.sequence_number.to_le_bytes());
        o.push(2); // TransactionPayload::EntryFunction
        let mut module_address = [0u8; 32];
        module_address[31] = 1;
        o.extend_from_slice(&module_address);
        put_bytes(&mut o, MODULE_NAME);
        put_bytes(&mut o, FUNCTION_NAME);
        put_uleb(&mut o, 0); // no type argument
        put_uleb(&mut o, 2); // two arguments, each BCS-encoded then length-prefixed
        put_bytes(&mut o, &self.recipient);
        put_bytes(&mut o, &self.amount.to_le_bytes());
        o.extend_from_slice(&self.max_gas_amount.to_le_bytes());
        o.extend_from_slice(&self.gas_unit_price.to_le_bytes());
        o.extend_from_slice(&self.expiration_timestamp_secs.to_le_bytes());
        o.push(self.chain_id);
        Ok(o)
    }

    /// Strict decoding; the result re-encodes to exactly `bcs` (checked).
    pub fn decode(bcs: &[u8]) -> Result<AptosTransfer> {
        if bcs.len() > MAX_BCS {
            return Err(bad("trop volumineuse"));
        }
        let mut r = Reader(bcs);
        let sender = r.arr32()?;
        let sequence_number = r.u64()?;
        match r.uleb()? {
            2 => {}
            0 => return Err(bad("script Move : non pris en charge")),
            3 => return Err(bad("transaction multisig : non prise en charge")),
            4 => {
                return Err(bad(
                    "charge utile « Payload » (transaction sans séquence, multisig…) : non prise en charge",
                ))
            }
            _ => return Err(bad("charge utile de type inconnu")),
        }
        let module_address = r.arr32()?;
        let module = r.bytes(128)?;
        let function = r.bytes(128)?;
        let mut expected_module = [0u8; 32];
        expected_module[31] = 1;
        if module_address != expected_module || module != MODULE_NAME || function != FUNCTION_NAME
        {
            return Err(bad(format!(
                "appel de fonction autre que {APTOS_TRANSFER_FUNCTION} : non pris en charge"
            )));
        }
        if r.uleb()? != 0 {
            return Err(bad("arguments de type : non pris en charge"));
        }
        if r.uleb()? != 2 {
            return Err(bad("nombre d'arguments inattendu"));
        }
        let to = r.bytes(64)?;
        let recipient: [u8; 32] = to
            .try_into()
            .map_err(|_| bad("destinataire : 32 octets attendus"))?;
        let amt = r.bytes(64)?;
        let amount = u64::from_le_bytes(
            amt.try_into()
                .map_err(|_| bad("montant : u64 attendu"))?,
        );
        let max_gas_amount = r.u64()?;
        let gas_unit_price = r.u64()?;
        let expiration_timestamp_secs = r.u64()?;
        let chain_id = r.u8()?;
        if !r.0.is_empty() {
            return Err(bad("octets en trop après la transaction"));
        }
        let t = AptosTransfer {
            sender,
            sequence_number,
            recipient,
            amount,
            max_gas_amount,
            gas_unit_price,
            expiration_timestamp_secs,
            chain_id,
        };
        if t.encode()? != bcs {
            return Err(bad("ré-encodage différent"));
        }
        Ok(t)
    }

    /// Signed transaction bytes with a single ed25519 authenticator. With an all-zero
    /// signature, this is what `/transactions/simulate` expects (it refuses a valid one).
    pub fn signed_bytes(&self, pubkey: &[u8; 32], signature: &[u8; 64]) -> Result<Vec<u8>> {
        let mut o = self.encode()?;
        o.push(0); // TransactionAuthenticator::Ed25519
        put_bytes(&mut o, pubkey);
        put_bytes(&mut o, signature);
        Ok(o)
    }
}

/// What ed25519 signs: `SHA3-256("APTOS::RawTransaction") || bcs`.
pub fn aptos_signing_message(raw_bcs: &[u8]) -> Vec<u8> {
    let mut m = sha3(&[RAW_TX_SALT]).to_vec();
    m.extend_from_slice(raw_bcs);
    m
}

/// `0x` + hex of `SHA3-256(SHA3-256("APTOS::Transaction") || 0x00 || signed)`, the hash the
/// network and explorers show.
pub fn aptos_tx_hash(signed: &[u8]) -> String {
    format!(
        "0x{}",
        hex::encode(sha3(&[&sha3(&[TX_SALT]), &[0u8], signed]))
    )
}

fn unhex(s: &str, what: &str) -> Result<Vec<u8>> {
    let t = s.trim();
    hex::decode(t.strip_prefix("0x").unwrap_or(t))
        .map_err(|_| Error::input(format!("{what} : hexadécimal attendu")))
}

/// Splits signed transaction bytes into the transfer, the public key and the signature.
/// Only a single ed25519 authenticator is accepted.
fn split_signed(signed: &[u8]) -> Result<(AptosTransfer, [u8; 32], [u8; 64])> {
    if signed.len() < 99 {
        return Err(bad("transaction signée tronquée"));
    }
    let (raw, auth) = signed.split_at(signed.len() - 99);
    if auth[0] != 0 || auth[1] != 32 || auth[34] != 64 {
        return Err(bad(
            "authentification : une seule clé ed25519 attendue (multi-signature, fee payer, multi-agent refusés)",
        ));
    }
    let t = AptosTransfer::decode(raw)?;
    let mut pk = [0u8; 32];
    pk.copy_from_slice(&auth[2..34]);
    let mut sig = [0u8; 64];
    sig.copy_from_slice(&auth[35..99]);
    Ok((t, pk, sig))
}

// ---------------------------------------------------------------- summary

/// Reasons for caution (all of them require the reinforced confirmation).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AptosWarning {
    /// Sent to the sender's own address.
    SelfTransfer,
    /// Maximum fee above [`APTOS_HIGH_FEE_OCTAS`].
    HighFee,
}

/// Plain-language summary of an APT transfer, decoded by Rust.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AptosTxSummary {
    /// Sender (checked: ours).
    pub sender: String,
    /// Recipient, full `0x` + 64 hex.
    pub recipient: String,
    /// Always [`APTOS_TRANSFER_FUNCTION`].
    pub function: String,
    /// Octas, decimal.
    pub amount: String,
    /// Sender's sequence number.
    pub sequence_number: String,
    /// Gas units at most, decimal.
    pub max_gas_amount: String,
    /// Octas per gas unit, decimal.
    pub gas_unit_price: String,
    /// `max_gas_amount × gas_unit_price`, octas, decimal.
    pub max_fee: String,
    /// UNIX seconds.
    pub expiration_timestamp_secs: u64,
    /// 1 mainnet, 2 testnet.
    pub chain_id: u8,
    /// Reasons for caution.
    pub warnings: Vec<AptosWarning>,
    /// The confirmation must be followed by a reinforced one.
    pub requires_extra_confirmation: bool,
}

fn summarize(t: &AptosTransfer, ours: &[u8; 32]) -> Result<AptosTxSummary> {
    if &t.sender != ours {
        return Err(bad("l'expéditeur n'est pas l'adresse de ce compte"));
    }
    let mut warnings = Vec::new();
    if t.recipient == t.sender {
        warnings.push(AptosWarning::SelfTransfer);
    }
    if t.max_fee() > APTOS_HIGH_FEE_OCTAS {
        warnings.push(AptosWarning::HighFee);
    }
    Ok(AptosTxSummary {
        sender: aptos_address_string(&t.sender),
        recipient: aptos_address_string(&t.recipient),
        function: APTOS_TRANSFER_FUNCTION.into(),
        amount: t.amount.to_string(),
        sequence_number: t.sequence_number.to_string(),
        max_gas_amount: t.max_gas_amount.to_string(),
        gas_unit_price: t.gas_unit_price.to_string(),
        max_fee: t.max_fee().to_string(),
        expiration_timestamp_secs: t.expiration_timestamp_secs,
        chain_id: t.chain_id,
        requires_extra_confirmation: !warnings.is_empty(),
        warnings,
    })
}

/// Decodes an unsigned transfer (hex BCS `RawTransaction`, as built by Kyro) for the dialog.
/// Refused: anything [`AptosTransfer::decode`] refuses and a sender other than `our_address`.
pub fn aptos_decode_tx(raw_hex: &str, our_address: &str) -> Result<AptosTxSummary> {
    let raw = unhex(raw_hex, "transaction")?;
    let t = AptosTransfer::decode(&raw)?;
    summarize(&t, &aptos_parse_address(our_address)?)
}

/// Signs an unsigned transfer (hex BCS) with account `account`'s key after decoding it like
/// [`aptos_decode_tx`]. Returns `(signed transaction hex, transaction hash, summary)`; the
/// signature is verified before it is returned.
pub fn aptos_sign(
    seed: &Seed,
    account: u32,
    raw_hex: &str,
) -> Result<(String, String, AptosTxSummary)> {
    let raw = unhex(raw_hex, "transaction")?;
    let t = AptosTransfer::decode(&raw)?;
    let key = signing_key(seed, account)?;
    let pk = key.verifying_key();
    let summary = summarize(&t, &aptos_address_bytes_of_pubkey(pk.as_bytes()))?;
    let msg = aptos_signing_message(&raw);
    let sig = key.sign(&msg);
    pk.verify_strict(&msg, &sig)
        .map_err(|_| Error::crypto("échec de la vérification de la signature"))?;
    let signed = t.signed_bytes(pk.as_bytes(), &sig.to_bytes())?;
    Ok((hex::encode(&signed), aptos_tx_hash(&signed), summary))
}

/// Checks a signed transfer before it is sent: the raw transaction decodes like
/// [`aptos_decode_tx`], the authenticator is a single ed25519 key whose address is the
/// sender's, and the signature verifies (strict). Returns `(hash, transfer)`.
pub fn aptos_verify_signed(signed_hex: &str) -> Result<(String, AptosTransfer)> {
    let signed = unhex(signed_hex, "transaction signée")?;
    let (t, pk, sig) = split_signed(&signed)?;
    if aptos_address_bytes_of_pubkey(&pk) != t.sender {
        return Err(bad(
            "la clé de la signature n'est pas celle de l'expéditeur",
        ));
    }
    ed25519_dalek::VerifyingKey::from_bytes(&pk)
        .map_err(|_| bad("clé publique invalide"))?
        .verify_strict(
            &aptos_signing_message(&t.encode()?),
            &ed25519_dalek::Signature::from_bytes(&sig),
        )
        .map_err(|_| bad("la signature ne se vérifie pas"))?;
    Ok((aptos_tx_hash(&signed), t))
}

/// Body for `/transactions/simulate`: the transfer with our public key and an all-zero
/// signature (the node refuses to simulate a validly signed transaction).
pub fn aptos_simulation_bytes(raw_hex: &str, pubkey: &[u8; 32]) -> Result<Vec<u8>> {
    let raw = unhex(raw_hex, "transaction")?;
    AptosTransfer::decode(&raw)?.signed_bytes(pubkey, &[0u8; 64])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uleb_is_canonical() {
        for v in [0u64, 1, 127, 128, 255, 16_384, u64::from(u32::MAX)] {
            let mut o = Vec::new();
            put_uleb(&mut o, v);
            let mut r = Reader(&o);
            assert_eq!(u64::from(r.uleb().unwrap()), v);
            assert!(r.0.is_empty());
        }
        for bad in [&[0x80u8, 0x00][..], &[0xff, 0xff, 0xff, 0xff, 0x7f], &[0x80]] {
            assert!(Reader(bad).uleb().is_err(), "{bad:?}");
        }
    }

    #[test]
    fn parse_addresses() {
        let a = "0x07968dab936c1bad187c60ce4082f307d030d780e91e694ae03aef16aba73f30";
        assert_eq!(aptos_address_string(&aptos_parse_address(a).unwrap()), a);
        assert_eq!(
            aptos_address_string(
                &aptos_parse_address(&a.to_uppercase().replace("0X", "0x")).unwrap()
            ),
            a
        );
        for bad in [
            "0x1",
            "0x7968dab936c1bad187c60ce4082f307d030d780e91e694ae03aef16aba73f30",
            "07968dab936c1bad187c60ce4082f307d030d780e91e694ae03aef16aba73f30",
            "0xg7968dab936c1bad187c60ce4082f307d030d780e91e694ae03aef16aba73f3",
            "kyro.apt",
            "",
        ] {
            assert!(aptos_parse_address(bad).is_err(), "{bad}");
        }
    }
}
