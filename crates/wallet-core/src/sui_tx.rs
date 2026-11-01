//! Sui SUI transfers: strict hand-written BCS for the one transaction shape Kyro builds, intent
//! signing, digest and signature checks.
//!
//! Kyro never signs bytes it did not build. The only accepted `TransactionData` is
//!
//! ```text
//! TransactionData::V1 {
//!   kind: ProgrammableTransaction {
//!     inputs:   [Pure(u64 amount), Pure(address recipient)]
//!     commands: [SplitCoins(GasCoin, [Input(0)]),
//!                TransferObjects([NestedResult(0, 0)], Input(1))]
//!   }                                                       // « montant »
//!   | ProgrammableTransaction {
//!     inputs:   [Pure(address recipient)]
//!     commands: [TransferObjects([GasCoin], Input(0))]
//!   }                                                       // « tout le solde »
//!   sender, gas_data: { payment: [ObjectRef…], owner = sender, price, budget },
//!   expiration: None | Epoch(e),
//! }
//! ```
//!
//! i.e. exactly what the official TypeScript SDK produces for `tx.splitCoins(tx.gas, [amount])`
//! then `tx.transferObjects([coin], to)`, and for `tx.transferObjects([tx.gas], to)`. Decoding is
//! strict (canonical ULEB128, known variants only, no trailing byte) **and** the decoded value
//! is re-encoded and compared byte for byte with the input: any other layout (an `Object`
//! input, a `MoveCall`, `Result(0)` instead of `NestedResult(0, 0)`, a sponsor, gas paid from
//! the address balance, `ValidDuring` expiration…) is refused before anything is shown.
//!
//! Signing: `ed25519(BLAKE2b-256(IntentMessage { [0, 0, 0], TransactionData }))`; the
//! serialized signature is `0x00 (ed25519 flag) || 64-byte signature || 32-byte public key`.
//! Digest: `base58(BLAKE2b-256("TransactionData::" || bcs))`.

use base64::Engine as _;
use ed25519_dalek::Signer as _;
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::mnemonic::Seed;
use crate::sui::{
    blake2b256, signing_key, sui_address_bytes_of_pubkey, sui_address_string, sui_parse_address,
    SUI_ED25519_FLAG,
};

/// Coin type of the native coin.
pub const SUI_COIN_TYPE: &str = "0x2::sui::SUI";
/// MIST per SUI.
pub const MIST_PER_SUI: u64 = 1_000_000_000;
/// At most this many gas coins (protocol `max_gas_payment_objects` is 256).
pub const SUI_MAX_GAS_OBJECTS: usize = 256;
/// Gas budget above this (0.1 SUI) is flagged: a plain transfer costs a few thousandths of SUI.
pub const SUI_HIGH_GAS_BUDGET: u64 = 100_000_000;
/// Intent `TransactionData` / `V0` / `Sui`.
const INTENT: [u8; 3] = [0, 0, 0];
const MAX_BCS: usize = 128 * 1024;

fn bad(msg: impl Into<String>) -> Error {
    Error::input(format!("transaction Sui refusée : {}", msg.into()))
}

/// Reference to an owned object version (gas coin).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct SuiObjectRef {
    /// Object id.
    pub object_id: [u8; 32],
    /// Sequence number (version).
    pub version: u64,
    /// Object digest.
    pub digest: [u8; 32],
}

impl SuiObjectRef {
    /// From the `0x…` id, the version and the base58 digest returned by the server.
    pub fn parse(object_id: &str, version: u64, digest_b58: &str) -> Result<Self> {
        let digest: [u8; 32] = bs58::decode(digest_b58.trim())
            .into_vec()
            .ok()
            .and_then(|v| v.try_into().ok())
            .ok_or_else(|| Error::input("empreinte d'objet Sui invalide (base58, 32 octets)"))?;
        Ok(Self {
            object_id: sui_parse_address(object_id)?,
            version,
            digest,
        })
    }
}

/// What is sent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SuiTransferAmount {
    /// This many MIST, split from the gas coin.
    Mist(u64),
    /// The whole (merged) gas coin minus the gas actually used.
    All,
}

/// A SUI transfer, the only transaction Kyro builds and signs on Sui.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SuiTransfer {
    /// Sender (and gas owner: no sponsor).
    pub sender: [u8; 32],
    /// Recipient.
    pub recipient: [u8; 32],
    /// Amount.
    pub amount: SuiTransferAmount,
    /// Gas coins (merged into the gas coin by the protocol).
    pub gas_payment: Vec<SuiObjectRef>,
    /// Gas price, MIST per gas unit.
    pub gas_price: u64,
    /// Gas budget, MIST.
    pub gas_budget: u64,
    /// `Some(e)`: void after epoch `e`. `None`: valid as long as the gas coins are unchanged.
    pub expiration_epoch: Option<u64>,
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

    fn u16(&mut self) -> Result<u16> {
        let b = self.take(2)?;
        Ok(u16::from_le_bytes([b[0], b[1]]))
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

    fn len(&mut self, max: usize) -> Result<usize> {
        let n = self.uleb()? as usize;
        if n > max {
            return Err(bad("vecteur trop long"));
        }
        Ok(n)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Arg {
    GasCoin,
    Input(u16),
    Result(u16),
    NestedResult(u16, u16),
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Cmd {
    TransferObjects(Vec<Arg>, Arg),
    SplitCoins(Arg, Vec<Arg>),
}

fn put_arg(out: &mut Vec<u8>, a: Arg) {
    match a {
        Arg::GasCoin => out.push(0),
        Arg::Input(i) => {
            out.push(1);
            out.extend_from_slice(&i.to_le_bytes());
        }
        Arg::Result(i) => {
            out.push(2);
            out.extend_from_slice(&i.to_le_bytes());
        }
        Arg::NestedResult(i, j) => {
            out.push(3);
            out.extend_from_slice(&i.to_le_bytes());
            out.extend_from_slice(&j.to_le_bytes());
        }
    }
}

fn read_arg(r: &mut Reader<'_>) -> Result<Arg> {
    Ok(match r.uleb()? {
        0 => Arg::GasCoin,
        1 => Arg::Input(r.u16()?),
        2 => Arg::Result(r.u16()?),
        3 => Arg::NestedResult(r.u16()?, r.u16()?),
        _ => return Err(bad("argument inconnu")),
    })
}

fn read_cmd(r: &mut Reader<'_>) -> Result<Cmd> {
    match r.uleb()? {
        1 => {
            let n = r.len(16)?;
            let objs = (0..n).map(|_| read_arg(r)).collect::<Result<Vec<_>>>()?;
            Ok(Cmd::TransferObjects(objs, read_arg(r)?))
        }
        2 => {
            let coin = read_arg(r)?;
            let n = r.len(16)?;
            let amounts = (0..n).map(|_| read_arg(r)).collect::<Result<Vec<_>>>()?;
            Ok(Cmd::SplitCoins(coin, amounts))
        }
        0 => Err(bad(
            "appel de fonction Move (MoveCall) : non pris en charge",
        )),
        3 => Err(bad("fusion de pièces (MergeCoins) : non prise en charge")),
        4 | 6 => Err(bad(
            "publication / mise à jour de paquet : non prise en charge",
        )),
        5 => Err(bad("MakeMoveVec : non pris en charge")),
        _ => Err(bad("commande inconnue")),
    }
}

fn put_cmd(out: &mut Vec<u8>, c: &Cmd) {
    match c {
        Cmd::TransferObjects(objs, to) => {
            out.push(1);
            put_uleb(out, objs.len() as u64);
            for a in objs {
                put_arg(out, *a);
            }
            put_arg(out, *to);
        }
        Cmd::SplitCoins(coin, amounts) => {
            out.push(2);
            put_arg(out, *coin);
            put_uleb(out, amounts.len() as u64);
            for a in amounts {
                put_arg(out, *a);
            }
        }
    }
}

impl SuiTransfer {
    fn check(&self) -> Result<()> {
        if self.gas_payment.is_empty() {
            return Err(bad(
                "aucune pièce de gaz (le paiement depuis le solde d'adresse n'est pas pris en charge)",
            ));
        }
        if self.gas_payment.len() > SUI_MAX_GAS_OBJECTS {
            return Err(bad(format!("plus de {SUI_MAX_GAS_OBJECTS} pièces de gaz")));
        }
        for (i, a) in self.gas_payment.iter().enumerate() {
            if self.gas_payment[..i]
                .iter()
                .any(|b| b.object_id == a.object_id)
            {
                return Err(bad("pièce de gaz en double"));
            }
        }
        if self.gas_price == 0 {
            return Err(bad("prix du gaz nul"));
        }
        if self.gas_budget == 0 {
            return Err(bad("budget de gaz nul"));
        }
        if self.amount == SuiTransferAmount::Mist(0) {
            return Err(bad("montant nul"));
        }
        Ok(())
    }

    /// BCS of the `TransactionData` (what is signed, after the intent prefix).
    pub fn encode(&self) -> Result<Vec<u8>> {
        self.check()?;
        let mut o = Vec::with_capacity(256 + 80 * self.gas_payment.len());
        o.push(0); // TransactionData::V1
        o.push(0); // TransactionKind::ProgrammableTransaction
        let (inputs, cmds): (Vec<Vec<u8>>, Vec<Cmd>) = match self.amount {
            SuiTransferAmount::Mist(m) => (
                vec![m.to_le_bytes().to_vec(), self.recipient.to_vec()],
                vec![
                    Cmd::SplitCoins(Arg::GasCoin, vec![Arg::Input(0)]),
                    Cmd::TransferObjects(vec![Arg::NestedResult(0, 0)], Arg::Input(1)),
                ],
            ),
            SuiTransferAmount::All => (
                vec![self.recipient.to_vec()],
                vec![Cmd::TransferObjects(vec![Arg::GasCoin], Arg::Input(0))],
            ),
        };
        put_uleb(&mut o, inputs.len() as u64);
        for i in &inputs {
            o.push(0); // CallArg::Pure
            put_bytes(&mut o, i);
        }
        put_uleb(&mut o, cmds.len() as u64);
        for c in &cmds {
            put_cmd(&mut o, c);
        }
        o.extend_from_slice(&self.sender);
        put_uleb(&mut o, self.gas_payment.len() as u64);
        for g in &self.gas_payment {
            o.extend_from_slice(&g.object_id);
            o.extend_from_slice(&g.version.to_le_bytes());
            put_bytes(&mut o, &g.digest);
        }
        o.extend_from_slice(&self.sender); // gas owner
        o.extend_from_slice(&self.gas_price.to_le_bytes());
        o.extend_from_slice(&self.gas_budget.to_le_bytes());
        match self.expiration_epoch {
            None => o.push(0),
            Some(e) => {
                o.push(1);
                o.extend_from_slice(&e.to_le_bytes());
            }
        }
        Ok(o)
    }

    /// Strict decoding; the result re-encodes to exactly `bcs` (checked).
    pub fn decode(bcs: &[u8]) -> Result<SuiTransfer> {
        if bcs.len() > MAX_BCS {
            return Err(bad("trop volumineuse"));
        }
        let mut r = Reader(bcs);
        if r.uleb()? != 0 {
            return Err(bad("version de TransactionData inconnue"));
        }
        if r.uleb()? != 0 {
            return Err(bad("transaction système ou de type inconnu"));
        }
        let n = r.len(16)?;
        let mut inputs = Vec::with_capacity(n);
        for _ in 0..n {
            match r.uleb()? {
                0 => {
                    let l = r.len(16 * 1024)?;
                    inputs.push(r.take(l)?.to_vec());
                }
                1 => return Err(bad("objet en entrée : non pris en charge")),
                _ => return Err(bad("entrée de type inconnu")),
            }
        }
        let n = r.len(16)?;
        let cmds = (0..n)
            .map(|_| read_cmd(&mut r))
            .collect::<Result<Vec<_>>>()?;
        let sender = r.arr32()?;
        let n = r.len(SUI_MAX_GAS_OBJECTS)?;
        let mut gas_payment = Vec::with_capacity(n);
        for _ in 0..n {
            let object_id = r.arr32()?;
            let version = r.u64()?;
            if r.uleb()? != 32 {
                return Err(bad("empreinte d'objet : 32 octets attendus"));
            }
            gas_payment.push(SuiObjectRef {
                object_id,
                version,
                digest: r.arr32()?,
            });
        }
        let owner = r.arr32()?;
        let gas_price = r.u64()?;
        let gas_budget = r.u64()?;
        let expiration_epoch = match r.uleb()? {
            0 => None,
            1 => Some(r.u64()?),
            2 => return Err(bad("expiration ValidDuring : non prise en charge")),
            _ => return Err(bad("expiration inconnue")),
        };
        if !r.0.is_empty() {
            return Err(bad("octets en trop après la transaction"));
        }
        if owner != sender {
            return Err(bad(
                "gaz payé par un autre compte (transaction parrainée) : non pris en charge",
            ));
        }
        let pure32 = |i: &Vec<u8>| -> Result<[u8; 32]> {
            i.as_slice()
                .try_into()
                .map_err(|_| bad("destinataire : 32 octets attendus"))
        };
        let (recipient, amount) = match (inputs.as_slice(), cmds.as_slice()) {
            (
                [amount, to],
                [Cmd::SplitCoins(Arg::GasCoin, a), Cmd::TransferObjects(o, Arg::Input(1))],
            ) if a.as_slice() == [Arg::Input(0)] && o.as_slice() == [Arg::NestedResult(0, 0)] => {
                let m: [u8; 8] = amount
                    .as_slice()
                    .try_into()
                    .map_err(|_| bad("montant : u64 attendu"))?;
                (pure32(to)?, SuiTransferAmount::Mist(u64::from_le_bytes(m)))
            }
            ([to], [Cmd::TransferObjects(o, Arg::Input(0))]) if o.as_slice() == [Arg::GasCoin] => {
                (pure32(to)?, SuiTransferAmount::All)
            }
            _ => {
                return Err(bad(
                    "structure inconnue : Kyro ne signe que les transferts de SUI qu'il construit",
                ))
            }
        };
        let t = SuiTransfer {
            sender,
            recipient,
            amount,
            gas_payment,
            gas_price,
            gas_budget,
            expiration_epoch,
        };
        if t.encode()? != bcs {
            return Err(bad("ré-encodage différent"));
        }
        Ok(t)
    }
}

/// `base58(BLAKE2b-256("TransactionData::" || bcs))`, the transaction digest.
pub fn sui_tx_digest(bcs: &[u8]) -> String {
    bs58::encode(blake2b256(&[b"TransactionData::", bcs])).into_string()
}

fn signing_digest(bcs: &[u8]) -> [u8; 32] {
    blake2b256(&[&INTENT, bcs])
}

fn b64(s: &str, what: &str) -> Result<Vec<u8>> {
    base64::engine::general_purpose::STANDARD
        .decode(s.trim())
        .map_err(|_| Error::input(format!("{what} : base64 attendu")))
}

// ---------------------------------------------------------------- summary

/// One gas coin, for display.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuiGasCoinView {
    /// `0x…`.
    pub object_id: String,
    /// Decimal.
    pub version: String,
    /// Base58.
    pub digest: String,
}

/// Reasons for caution (all of them require the reinforced confirmation).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SuiWarning {
    /// The whole gas coin is sent (all the SUI of the listed coins, minus the gas used).
    SendAll,
    /// Sent to the sender's own address.
    SelfTransfer,
    /// Gas budget above [`SUI_HIGH_GAS_BUDGET`].
    HighGasBudget,
    /// No expiration epoch: the signed transaction stays valid as long as its gas coins are
    /// unchanged.
    NoExpiration,
}

/// Plain-language summary of a SUI transfer, decoded by Rust.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuiTxSummary {
    /// Sender = gas owner (checked: ours).
    pub sender: String,
    /// Recipient, full `0x` + 64 hex.
    pub recipient: String,
    /// Always [`SUI_COIN_TYPE`] (the gas coin is SUI).
    pub coin_type: String,
    /// MIST, decimal; `None` = the whole balance of the gas coins minus the gas used.
    pub amount: Option<String>,
    /// MIST, decimal.
    pub gas_budget: String,
    /// MIST per gas unit, decimal.
    pub gas_price: String,
    /// Gas coins.
    pub gas_coins: Vec<SuiGasCoinView>,
    /// Void after this epoch.
    pub expiration_epoch: Option<u64>,
    /// Transaction digest (base58).
    pub digest: String,
    /// Reasons for caution.
    pub warnings: Vec<SuiWarning>,
    /// The confirmation must be followed by a reinforced one.
    pub requires_extra_confirmation: bool,
}

fn summarize(t: &SuiTransfer, bcs: &[u8], ours: &[u8; 32]) -> Result<SuiTxSummary> {
    if &t.sender != ours {
        return Err(bad("l'expéditeur n'est pas l'adresse de ce compte"));
    }
    let mut warnings = Vec::new();
    if t.amount == SuiTransferAmount::All {
        warnings.push(SuiWarning::SendAll);
    }
    if t.recipient == t.sender {
        warnings.push(SuiWarning::SelfTransfer);
    }
    if t.gas_budget > SUI_HIGH_GAS_BUDGET {
        warnings.push(SuiWarning::HighGasBudget);
    }
    if t.expiration_epoch.is_none() {
        warnings.push(SuiWarning::NoExpiration);
    }
    Ok(SuiTxSummary {
        sender: sui_address_string(&t.sender),
        recipient: sui_address_string(&t.recipient),
        coin_type: SUI_COIN_TYPE.into(),
        amount: match t.amount {
            SuiTransferAmount::Mist(m) => Some(m.to_string()),
            SuiTransferAmount::All => None,
        },
        gas_budget: t.gas_budget.to_string(),
        gas_price: t.gas_price.to_string(),
        gas_coins: t
            .gas_payment
            .iter()
            .map(|g| SuiGasCoinView {
                object_id: sui_address_string(&g.object_id),
                version: g.version.to_string(),
                digest: bs58::encode(g.digest).into_string(),
            })
            .collect(),
        expiration_epoch: t.expiration_epoch,
        digest: sui_tx_digest(bcs),
        requires_extra_confirmation: !warnings.is_empty(),
        warnings,
    })
}

/// Decodes an unsigned transfer (base64 BCS, as built by Kyro) for the dialog. Refused:
/// anything [`SuiTransfer::decode`] refuses and a sender other than `our_address`.
pub fn sui_decode_tx(bcs_b64: &str, our_address: &str) -> Result<SuiTxSummary> {
    let bcs = b64(bcs_b64, "transaction")?;
    let t = SuiTransfer::decode(&bcs)?;
    summarize(&t, &bcs, &sui_parse_address(our_address)?)
}

/// Signs an unsigned transfer (base64 BCS) with account `account`'s key after decoding it like
/// [`sui_decode_tx`]. Returns `(serialized signature base64 = flag || sig || pubkey, summary)`;
/// the signature is verified before it is returned.
pub fn sui_sign(seed: &Seed, account: u32, bcs_b64: &str) -> Result<(String, SuiTxSummary)> {
    let bcs = b64(bcs_b64, "transaction")?;
    let t = SuiTransfer::decode(&bcs)?;
    let key = signing_key(seed, account)?;
    let pk = key.verifying_key();
    let summary = summarize(&t, &bcs, &sui_address_bytes_of_pubkey(pk.as_bytes()))?;
    let msg = signing_digest(&bcs);
    let sig = key.sign(&msg);
    pk.verify_strict(&msg, &sig)
        .map_err(|_| Error::crypto("échec de la vérification de la signature"))?;
    let mut out = Vec::with_capacity(97);
    out.push(SUI_ED25519_FLAG);
    out.extend_from_slice(&sig.to_bytes());
    out.extend_from_slice(pk.as_bytes());
    Ok((
        base64::engine::general_purpose::STANDARD.encode(out),
        summary,
    ))
}

/// Checks a signed transfer before it is sent: the BCS decodes like [`sui_decode_tx`], the
/// signature is an ed25519 one (`flag 0x00`), its public key is the sender's and it verifies
/// (strict). Returns the transaction digest.
pub fn sui_verify_signed(bcs_b64: &str, signature_b64: &str) -> Result<String> {
    let bcs = b64(bcs_b64, "transaction")?;
    let t = SuiTransfer::decode(&bcs)?;
    let s = b64(signature_b64, "signature")?;
    if s.len() != 97 || s[0] != SUI_ED25519_FLAG {
        return Err(bad(
            "signature : ed25519 (0x00 || 64 octets || 32 octets) attendue",
        ));
    }
    let mut sig = [0u8; 64];
    sig.copy_from_slice(&s[1..65]);
    let mut pk = [0u8; 32];
    pk.copy_from_slice(&s[65..97]);
    if sui_address_bytes_of_pubkey(&pk) != t.sender {
        return Err(bad(
            "la clé de la signature n'est pas celle de l'expéditeur",
        ));
    }
    ed25519_dalek::VerifyingKey::from_bytes(&pk)
        .map_err(|_| bad("clé publique invalide"))?
        .verify_strict(
            &signing_digest(&bcs),
            &ed25519_dalek::Signature::from_bytes(&sig),
        )
        .map_err(|_| bad("la signature ne se vérifie pas"))?;
    Ok(sui_tx_digest(&bcs))
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
        for bad in [
            &[0x80u8, 0x00][..],
            &[0xff, 0xff, 0xff, 0xff, 0x7f],
            &[0x80],
        ] {
            assert!(Reader(bad).uleb().is_err(), "{bad:?}");
        }
    }
}
