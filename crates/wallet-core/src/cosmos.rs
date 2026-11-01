//! Cosmos Hub (ATOM): secp256k1 at `m/44'/118'/account'/0/0` (SLIP-44 118, Keplr/Ledger path),
//! `cosmos1…` addresses, and `uatom` `MsgSend` in **SIGN_MODE_DIRECT** only.

use bech32::{Bech32, Hrp};
use bitcoin::hashes::{hash160, sha256, Hash};
use bitcoin::secp256k1::{ecdsa::Signature, Message, PublicKey, Secp256k1};
use prost::Message as _;
use serde::{Deserialize, Serialize};

use crate::display::sanitize_text;
use crate::error::{Error, Result};
use crate::keys::{hardened, normal, secp, XprivGuard};
use crate::mnemonic::Seed;
use crate::network::Network;

/// Human-readable part of Cosmos Hub account addresses.
pub const COSMOS_HRP: &str = "cosmos";
/// The only denomination Kyro sends: micro-ATOM (1 ATOM = 1 000 000 uatom).
pub const COSMOS_DENOM: &str = "uatom";
/// Chain id of Cosmos Hub mainnet.
pub const COSMOS_CHAIN_ID_MAINNET: &str = "cosmoshub-4";
/// Chain id of the Cosmos Hub public testnet (Interchain Security provider testnet).
pub const COSMOS_CHAIN_ID_TESTNET: &str = "provider";
/// `Any.type_url` of `cosmos.bank.v1beta1.MsgSend`.
pub const COSMOS_MSG_SEND: &str = "/cosmos.bank.v1beta1.MsgSend";
/// `Any.type_url` of `cosmos.crypto.secp256k1.PubKey`.
pub const COSMOS_SECP256K1_PUBKEY: &str = "/cosmos.crypto.secp256k1.PubKey";
/// `SignMode.SIGN_MODE_DIRECT`.
pub const COSMOS_SIGN_MODE_DIRECT: i32 = 1;
/// `SIGN_MODE_LEGACY_AMINO_JSON`: the Ledger Cosmos app's only mode (see [`cosmos_amino_json`]).
pub const COSMOS_SIGN_MODE_AMINO_JSON: i32 = 127;
/// Longest memo (chars): the Hub's `max_memo_characters` (512, read live 2026-11-01).
pub const COSMOS_MAX_MEMO: usize = 512;
const HIGH_FEE_UATOM: u128 = 100_000;
const MAX_MEMO_TEXT: usize = 256;
const MAX_TX: usize = 8192;

/// Chain id expected on `net`.
pub fn cosmos_chain_id(net: Network) -> &'static str {
    match net {
        Network::Mainnet => COSMOS_CHAIN_ID_MAINNET,
        Network::Testnet => COSMOS_CHAIN_ID_TESTNET,
    }
}

fn path(account: u32) -> Result<[bitcoin::bip32::ChildNumber; 5]> {
    Ok([
        hardened(44)?,
        hardened(118)?,
        hardened(account)?,
        normal(0)?,
        normal(0)?,
    ])
}

/// Path of the key of Cosmos account `account`: `m/44'/118'/account'/0/0`.
pub fn cosmos_path(account: u32) -> String {
    format!("m/44'/118'/{account}'/0/0")
}

fn hrp() -> Result<Hrp> {
    Hrp::parse(COSMOS_HRP).map_err(|_| Error::crypto("bech32 prefix"))
}

/// `cosmos1…` address of raw address bytes (20 bytes for a key, 32 for a module / ICA account).
pub fn cosmos_address_from_bytes(bytes: &[u8]) -> Result<String> {
    bech32::encode::<Bech32>(hrp()?, bytes).map_err(|_| Error::input("Cosmos address: encoding"))
}

/// Raw bytes of a `cosmos1…` address (bech32, not bech32m; 20 or 32 bytes; mixed case refused).
pub fn cosmos_address_bytes(address: &str) -> Result<Vec<u8>> {
    use bech32::primitives::decode::CheckedHrpstring;
    let a = address.trim();
    let checked = CheckedHrpstring::new::<Bech32>(a)
        .map_err(|_| Error::input("invalid Cosmos address (bech32 checksum)"))?;
    if checked.hrp().to_lowercase() != COSMOS_HRP {
        return Err(Error::input(format!(
            "address of another chain (prefix \"{}\", \"cosmos\" expected)",
            checked.hrp().to_lowercase()
        )));
    }
    let bytes: Vec<u8> = checked.byte_iter().collect();
    if bytes.len() != 20 && bytes.len() != 32 {
        return Err(Error::input(
            "invalid Cosmos address (20 or 32 bytes expected)",
        ));
    }
    Ok(bytes)
}

/// Canonical (lower-case) form of a `cosmos1…` address, after [`cosmos_address_bytes`].
pub fn cosmos_normalize_address(address: &str) -> Result<String> {
    cosmos_address_from_bytes(&cosmos_address_bytes(address)?)
}

/// `cosmos1…` address of a compressed secp256k1 public key.
pub fn cosmos_address_of_pubkey(pk: &[u8]) -> Result<String> {
    let pk: [u8; 33] = PublicKey::from_slice(pk)
        .map_err(|_| Error::input("invalid public key"))?
        .serialize();
    cosmos_address_from_bytes(&hash160::Hash::hash(&pk).to_byte_array())
}

/// Compressed public key of account `account` (`m/44'/118'/account'/0/0`).
pub fn cosmos_public_key(seed: &Seed, account: u32) -> Result<[u8; 33]> {
    let secp = secp()?;
    let master = XprivGuard::master(seed, bitcoin::NetworkKind::Main)?;
    let key = master.derive(&secp, &path(account)?)?;
    Ok(key.xpriv().private_key.public_key(&secp).serialize())
}

/// Address of account `account` (`m/44'/118'/account'/0/0`, see [`cosmos_path`]).
pub fn cosmos_address(seed: &Seed, account: u32) -> Result<String> {
    cosmos_address_of_pubkey(&cosmos_public_key(seed, account)?)
}

/// Protobuf messages of a SIGN_MODE_DIRECT `MsgSend` (cosmos-sdk v0.50/v0.53), Kyro's fields only.
pub mod proto {
    #![allow(missing_docs)]

    /// `cosmos.base.v1beta1.Coin`.
    #[derive(Clone, PartialEq, Eq, prost::Message)]
    pub struct Coin {
        #[prost(string, tag = "1")]
        pub denom: String,
        /// Decimal integer string.
        #[prost(string, tag = "2")]
        pub amount: String,
    }

    /// `cosmos.bank.v1beta1.MsgSend`.
    #[derive(Clone, PartialEq, Eq, prost::Message)]
    pub struct MsgSend {
        #[prost(string, tag = "1")]
        pub from_address: String,
        #[prost(string, tag = "2")]
        pub to_address: String,
        #[prost(message, repeated, tag = "3")]
        pub amount: Vec<Coin>,
    }

    /// `google.protobuf.Any`.
    #[derive(Clone, PartialEq, Eq, prost::Message)]
    pub struct Any {
        #[prost(string, tag = "1")]
        pub type_url: String,
        #[prost(bytes = "vec", tag = "2")]
        pub value: Vec<u8>,
    }

    /// `TxBody` without `unordered`, `timeout_timestamp` and extension options (all refused).
    #[derive(Clone, PartialEq, Eq, prost::Message)]
    pub struct TxBody {
        #[prost(message, repeated, tag = "1")]
        pub messages: Vec<Any>,
        #[prost(string, tag = "2")]
        pub memo: String,
        #[prost(uint64, tag = "3")]
        pub timeout_height: u64,
    }

    /// `cosmos.crypto.secp256k1.PubKey`.
    #[derive(Clone, PartialEq, Eq, prost::Message)]
    pub struct PubKey {
        #[prost(bytes = "vec", tag = "1")]
        pub key: Vec<u8>,
    }

    /// `cosmos.tx.v1beta1.ModeInfo.Single`.
    #[derive(Clone, PartialEq, Eq, prost::Message)]
    pub struct ModeInfoSingle {
        /// `cosmos.tx.signing.v1beta1.SignMode`.
        #[prost(int32, tag = "1")]
        pub mode: i32,
    }

    /// `cosmos.tx.v1beta1.ModeInfo`, `single` branch of the `sum` oneof only (`multi`, 2: refused).
    #[derive(Clone, PartialEq, Eq, prost::Message)]
    pub struct ModeInfo {
        #[prost(message, optional, tag = "1")]
        pub single: Option<ModeInfoSingle>,
    }

    /// `cosmos.tx.v1beta1.SignerInfo`.
    #[derive(Clone, PartialEq, Eq, prost::Message)]
    pub struct SignerInfo {
        #[prost(message, optional, tag = "1")]
        pub public_key: Option<Any>,
        #[prost(message, optional, tag = "2")]
        pub mode_info: Option<ModeInfo>,
        #[prost(uint64, tag = "3")]
        pub sequence: u64,
    }

    /// `cosmos.tx.v1beta1.Fee`.
    #[derive(Clone, PartialEq, Eq, prost::Message)]
    pub struct Fee {
        #[prost(message, repeated, tag = "1")]
        pub amount: Vec<Coin>,
        #[prost(uint64, tag = "2")]
        pub gas_limit: u64,
        #[prost(string, tag = "3")]
        pub payer: String,
        #[prost(string, tag = "4")]
        pub granter: String,
    }

    /// `cosmos.tx.v1beta1.AuthInfo` without `tip` (3, deprecated): refused.
    #[derive(Clone, PartialEq, Eq, prost::Message)]
    pub struct AuthInfo {
        #[prost(message, repeated, tag = "1")]
        pub signer_infos: Vec<SignerInfo>,
        #[prost(message, optional, tag = "2")]
        pub fee: Option<Fee>,
    }

    /// `cosmos.tx.v1beta1.SignDoc`.
    #[derive(Clone, PartialEq, Eq, prost::Message)]
    pub struct SignDoc {
        #[prost(bytes = "vec", tag = "1")]
        pub body_bytes: Vec<u8>,
        #[prost(bytes = "vec", tag = "2")]
        pub auth_info_bytes: Vec<u8>,
        #[prost(string, tag = "3")]
        pub chain_id: String,
        #[prost(uint64, tag = "4")]
        pub account_number: u64,
    }

    /// `cosmos.tx.v1beta1.TxRaw`.
    #[derive(Clone, PartialEq, Eq, prost::Message)]
    pub struct TxRaw {
        #[prost(bytes = "vec", tag = "1")]
        pub body_bytes: Vec<u8>,
        #[prost(bytes = "vec", tag = "2")]
        pub auth_info_bytes: Vec<u8>,
        #[prost(bytes = "vec", repeated, tag = "3")]
        pub signatures: Vec<Vec<u8>>,
    }
}

fn bad(msg: impl Into<String>) -> Error {
    Error::input(format!("Cosmos transaction: {}", msg.into()))
}

fn strict<M: prost::Message + Default>(bytes: &[u8], what: &str) -> Result<M> {
    let m = M::decode(bytes).map_err(|_| bad(format!("{what}: invalid protobuf")))?;
    if m.encode_to_vec() != bytes {
        return Err(bad(format!(
            "{what}: non-canonical encoding or unsupported field"
        )));
    }
    Ok(m)
}

fn parse_amount(s: &str, what: &str) -> Result<u128> {
    if s.is_empty()
        || s.len() > 38
        || !s.bytes().all(|b| b.is_ascii_digit())
        || (s.len() > 1 && s.starts_with('0'))
    {
        return Err(bad(format!("{what}: invalid amount \"{s}\"")));
    }
    let v: u128 = s
        .parse()
        .map_err(|_| bad(format!("{what}: invalid amount")))?;
    if v == 0 {
        return Err(bad(format!("{what}: zero amount")));
    }
    Ok(v)
}

fn one_uatom(coins: &[proto::Coin], what: &str) -> Result<u128> {
    match coins {
        [c] if c.denom == COSMOS_DENOM => parse_amount(&c.amount, what),
        [c] => Err(bad(format!(
            "{what}: denomination \"{}\" refused (uatom only)",
            sanitize_text(&c.denom, 80).text
        ))),
        _ => Err(bad(format!("{what}: a single coin (uatom) expected"))),
    }
}

/// What Kyro puts in a `MsgSend` transaction (filled from live data by the shell).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CosmosSendRequest {
    /// Chain id (must be [`cosmos_chain_id`] of the network to be signed).
    pub chain_id: String,
    /// `account_number` of the sender (auth module).
    pub account_number: u64,
    /// `sequence` of the sender.
    pub sequence: u64,
    /// Our compressed public key (`SignerInfo.public_key`).
    pub public_key: [u8; 33],
    /// Recipient, `cosmos1…`.
    pub to: String,
    /// uatom.
    pub amount: u128,
    /// uatom.
    pub fee: u128,
    /// Gas limit.
    pub gas_limit: u64,
    /// Memo (empty = none), at most [`COSMOS_MAX_MEMO`] characters.
    pub memo: String,
    /// Last block height at which the transaction may be included.
    pub timeout_height: u64,
}

fn any(type_url: &str, m: &impl prost::Message) -> proto::Any {
    proto::Any {
        type_url: type_url.to_owned(),
        value: m.encode_to_vec(),
    }
}

/// Serialized `SignDoc` of a `MsgSend` of `uatom` (what [`cosmos_sign`] signs).
pub fn cosmos_send_sign_doc(r: &CosmosSendRequest) -> Result<Vec<u8>> {
    if r.memo.chars().count() > COSMOS_MAX_MEMO {
        return Err(Error::input(format!(
            "memo: {COSMOS_MAX_MEMO} characters at most"
        )));
    }
    let from = cosmos_address_of_pubkey(&r.public_key)?;
    let to = cosmos_normalize_address(&r.to)?;
    let send = proto::MsgSend {
        from_address: from,
        to_address: to,
        amount: vec![proto::Coin {
            denom: COSMOS_DENOM.into(),
            amount: r.amount.to_string(),
        }],
    };
    let body = proto::TxBody {
        messages: vec![any(COSMOS_MSG_SEND, &send)],
        memo: r.memo.clone(),
        timeout_height: r.timeout_height,
    };
    let auth = proto::AuthInfo {
        signer_infos: vec![proto::SignerInfo {
            public_key: Some(any(
                COSMOS_SECP256K1_PUBKEY,
                &proto::PubKey {
                    key: r.public_key.to_vec(),
                },
            )),
            mode_info: Some(proto::ModeInfo {
                single: Some(proto::ModeInfoSingle {
                    mode: COSMOS_SIGN_MODE_DIRECT,
                }),
            }),
            sequence: r.sequence,
        }],
        fee: Some(proto::Fee {
            amount: vec![proto::Coin {
                denom: COSMOS_DENOM.into(),
                amount: r.fee.to_string(),
            }],
            gas_limit: r.gas_limit,
            payer: String::new(),
            granter: String::new(),
        }),
    };
    let doc = proto::SignDoc {
        body_bytes: body.encode_to_vec(),
        auth_info_bytes: auth.encode_to_vec(),
        chain_id: r.chain_id.clone(),
        account_number: r.account_number,
    }
    .encode_to_vec();
    parse_sign_doc(&doc, &r.public_key, &r.chain_id)?;
    Ok(doc)
}

/// `TxRaw` with one empty signature, for `/simulate` (signatures unchecked, their count is).
pub fn cosmos_simulation_tx(sign_doc: &[u8]) -> Result<Vec<u8>> {
    let doc: proto::SignDoc = strict(sign_doc, "SignDoc")?;
    Ok(proto::TxRaw {
        body_bytes: doc.body_bytes,
        auth_info_bytes: doc.auth_info_bytes,
        signatures: vec![Vec::new()],
    }
    .encode_to_vec())
}

/// Reasons for caution (all of them require the reinforced confirmation).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CosmosWarning {
    /// Fee above 0.1 ATOM.
    HighFee,
    /// Memo had control/invisible/bidi characters removed or was cut (`memo_hex` is exact).
    UnusualText,
}

/// Plain-language summary of a `MsgSend` transaction, decoded by Rust from the SignDoc.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CosmosTxSummary {
    /// Chain id (checked against the network).
    pub chain_id: String,
    /// `account_number` of the sender.
    pub account_number: u64,
    /// `sequence` of the sender.
    pub sequence: u64,
    /// Sender (always our address, checked).
    pub from: String,
    /// Recipient.
    pub to: String,
    /// uatom, decimal string.
    pub amount: String,
    /// Fee, uatom, decimal string.
    pub fee: String,
    /// Gas limit.
    pub gas_limit: u64,
    /// Memo cleaned for display ([`crate::sanitize_text`], 256 characters); `None` = no memo.
    pub memo: Option<String>,
    /// Exact memo bytes, hex (`None` = no memo).
    pub memo_hex: Option<String>,
    /// Last block height at which the transaction may be included.
    pub timeout_height: u64,
    /// Reasons for caution.
    pub warnings: Vec<CosmosWarning>,
    /// The confirmation must be followed by a reinforced one.
    pub requires_extra_confirmation: bool,
}

struct Parsed {
    doc: proto::SignDoc,
    summary: CosmosTxSummary,
    /// [`COSMOS_SIGN_MODE_DIRECT`] or [`COSMOS_SIGN_MODE_AMINO_JSON`].
    mode: i32,
    memo: String,
}

fn parse_sign_doc(doc_bytes: &[u8], our_pubkey: &[u8; 33], chain_id: &str) -> Result<Parsed> {
    if doc_bytes.len() > MAX_TX {
        return Err(bad("too large"));
    }
    let doc: proto::SignDoc = strict(doc_bytes, "SignDoc")?;
    if doc.chain_id != chain_id {
        return Err(bad(format!(
            "chain-id \"{}\" instead of \"{chain_id}\"",
            sanitize_text(&doc.chain_id, 64).text
        )));
    }
    let body: proto::TxBody = strict(&doc.body_bytes, "TxBody")?;
    let msg = match body.messages.as_slice() {
        [m] => m,
        _ => return Err(bad("a single message expected")),
    };
    if msg.type_url != COSMOS_MSG_SEND {
        return Err(bad(format!(
            "message \"{}\" refused (MsgSend only)",
            sanitize_text(&msg.type_url, 80).text
        )));
    }
    let send: proto::MsgSend = strict(&msg.value, "MsgSend")?;
    if body.timeout_height == 0 {
        return Err(bad(
            "missing timeout_height: the transaction would stay valid forever",
        ));
    }
    if body.memo.chars().count() > COSMOS_MAX_MEMO {
        return Err(bad(format!(
            "memo longer than {COSMOS_MAX_MEMO} characters"
        )));
    }
    let auth: proto::AuthInfo = strict(&doc.auth_info_bytes, "AuthInfo")?;
    let signer = match auth.signer_infos.as_slice() {
        [s] => s,
        _ => return Err(bad("a single signer expected")),
    };
    let pk_any = signer
        .public_key
        .as_ref()
        .ok_or_else(|| bad("missing signer public key"))?;
    if pk_any.type_url != COSMOS_SECP256K1_PUBKEY {
        return Err(bad("public key: secp256k1 expected"));
    }
    let pk: proto::PubKey = strict(&pk_any.value, "PubKey")?;
    if pk.key.as_slice() != our_pubkey.as_slice() {
        return Err(bad("the signer's key is not this account's"));
    }
    let mode = signer
        .mode_info
        .as_ref()
        .and_then(|m| m.single.as_ref())
        .map(|s| s.mode);
    let mode = match mode {
        Some(m @ (COSMOS_SIGN_MODE_DIRECT | COSMOS_SIGN_MODE_AMINO_JSON)) => m,
        _ => return Err(bad("sign mode: SIGN_MODE_DIRECT expected")),
    };
    if mode == COSMOS_SIGN_MODE_AMINO_JSON && !amino_safe_memo(&body.memo) {
        return Err(bad(
            "memo: with a Ledger, printable ASCII characters only (no \" \\ < > &)",
        ));
    }
    let fee = auth.fee.as_ref().ok_or_else(|| bad("missing fee"))?;
    if !fee.payer.is_empty() || !fee.granter.is_empty() {
        return Err(bad("fee paid by a third party (payer / granter) refused"));
    }
    let fee_amount = one_uatom(&fee.amount, "fee")?;
    if fee.gas_limit == 0 {
        return Err(bad("zero gas_limit"));
    }
    let from = cosmos_address_of_pubkey(our_pubkey)?;
    if send.from_address != from {
        return Err(bad("the sender is not this account's address"));
    }
    // Canonical lower-case form only: what the chain shows is what the dialog shows.
    if cosmos_normalize_address(&send.to_address)? != send.to_address {
        return Err(bad("non-canonical recipient address"));
    }
    if send.to_address == from {
        return Err(bad("send to yourself"));
    }
    let amount = one_uatom(&send.amount, "amount")?;
    let mut warnings = Vec::new();
    if fee_amount > HIGH_FEE_UATOM {
        warnings.push(CosmosWarning::HighFee);
    }
    let raw_memo = body.memo.clone();
    let (memo, memo_hex) = if body.memo.is_empty() {
        (None, None)
    } else {
        let clean = sanitize_text(&body.memo, MAX_MEMO_TEXT);
        if clean.altered {
            warnings.push(CosmosWarning::UnusualText);
        }
        (Some(clean.text), Some(hex::encode(body.memo.as_bytes())))
    };
    let summary = CosmosTxSummary {
        chain_id: doc.chain_id.clone(),
        account_number: doc.account_number,
        sequence: signer.sequence,
        from,
        to: send.to_address,
        amount: amount.to_string(),
        fee: fee_amount.to_string(),
        gas_limit: fee.gas_limit,
        memo,
        memo_hex,
        timeout_height: body.timeout_height,
        requires_extra_confirmation: !warnings.is_empty(),
        warnings,
    };
    Ok(Parsed {
        doc,
        summary,
        mode,
        memo: raw_memo,
    })
}

fn amino_safe_memo(memo: &str) -> bool {
    memo.bytes()
        .all(|b| (0x20..0x7f).contains(&b) && !matches!(b, b'"' | b'\\' | b'<' | b'>' | b'&'))
}

fn amino_json(p: &Parsed) -> String {
    let s = &p.summary;
    format!(
        concat!(
            r#"{{"account_number":"{}","chain_id":"{}","fee":{{"amount":[{{"amount":"{}","denom":"{}"}}],"gas":"{}"}},"#,
            r#""memo":"{}","msgs":[{{"type":"cosmos-sdk/MsgSend","value":{{"amount":[{{"amount":"{}","denom":"{}"}}],"#,
            r#""from_address":"{}","to_address":"{}"}}}}],"sequence":"{}","timeout_height":"{}"}}"#
        ),
        s.account_number,
        s.chain_id,
        s.fee,
        COSMOS_DENOM,
        s.gas_limit,
        p.memo,
        s.amount,
        COSMOS_DENOM,
        s.from,
        s.to,
        s.sequence,
        s.timeout_height,
    )
}

fn sign_doc_bytes(sign_doc_hex: &str) -> Result<Vec<u8>> {
    hex::decode(sign_doc_hex.trim()).map_err(|_| Error::input("SignDoc: hexadecimal expected"))
}

/// Hardware wallet: [`cosmos_send_sign_doc`] SignDoc with sign mode LEGACY_AMINO_JSON (Ledger).
pub fn cosmos_amino_sign_doc(
    sign_doc_hex: &str,
    our_pubkey: &[u8; 33],
    net: Network,
) -> Result<String> {
    let raw = sign_doc_bytes(sign_doc_hex)?;
    let parsed = parse_sign_doc(&raw, our_pubkey, cosmos_chain_id(net))?;
    let mut auth: proto::AuthInfo = strict(&parsed.doc.auth_info_bytes, "AuthInfo")?;
    auth.signer_infos[0].mode_info = Some(proto::ModeInfo {
        single: Some(proto::ModeInfoSingle {
            mode: COSMOS_SIGN_MODE_AMINO_JSON,
        }),
    });
    let doc = proto::SignDoc {
        auth_info_bytes: auth.encode_to_vec(),
        ..parsed.doc
    }
    .encode_to_vec();
    parse_sign_doc(&doc, our_pubkey, cosmos_chain_id(net))?;
    Ok(hex::encode(doc))
}

/// Hardware wallet: amino JSON the Ledger Cosmos app shows and signs, for an AMINO_JSON SignDoc.
pub fn cosmos_amino_json(
    sign_doc_hex: &str,
    our_pubkey: &[u8; 33],
    net: Network,
) -> Result<Vec<u8>> {
    let parsed = parse_sign_doc(
        &sign_doc_bytes(sign_doc_hex)?,
        our_pubkey,
        cosmos_chain_id(net),
    )?;
    if parsed.mode != COSMOS_SIGN_MODE_AMINO_JSON {
        return Err(bad("sign mode: LEGACY_AMINO_JSON expected"));
    }
    Ok(amino_json(&parsed).into_bytes())
}

/// Hardware wallet: `(TxRaw base64, hash, summary)` from the Ledger's DER signature.
pub fn cosmos_amino_signed(
    sign_doc_hex: &str,
    our_pubkey: &[u8; 33],
    net: Network,
    der_sig: &[u8],
) -> Result<(String, String, CosmosTxSummary)> {
    use base64::Engine as _;
    let parsed = parse_sign_doc(
        &sign_doc_bytes(sign_doc_hex)?,
        our_pubkey,
        cosmos_chain_id(net),
    )?;
    if parsed.mode != COSMOS_SIGN_MODE_AMINO_JSON {
        return Err(bad("sign mode: LEGACY_AMINO_JSON expected"));
    }
    let mut sig = Signature::from_der(der_sig).map_err(|_| bad("invalid device DER signature"))?;
    sig.normalize_s();
    let pk = PublicKey::from_slice(our_pubkey).map_err(|_| bad("invalid public key"))?;
    let digest = sha256::Hash::hash(amino_json(&parsed).as_bytes()).to_byte_array();
    Secp256k1::verification_only()
        .verify_ecdsa(&Message::from_digest(digest), &sig, &pk)
        .map_err(|_| bad("the device signature does not verify"))?;
    let tx = proto::TxRaw {
        body_bytes: parsed.doc.body_bytes,
        auth_info_bytes: parsed.doc.auth_info_bytes,
        signatures: vec![sig.serialize_compact().to_vec()],
    }
    .encode_to_vec();
    let hash = hex::encode_upper(sha256::Hash::hash(&tx).to_byte_array());
    Ok((
        base64::engine::general_purpose::STANDARD.encode(&tx),
        hash,
        parsed.summary,
    ))
}

/// Decodes a serialized SignDoc (hex) for the dialog.
pub fn cosmos_decode_sign_doc(
    sign_doc_hex: &str,
    our_pubkey: &[u8; 33],
    net: Network,
) -> Result<CosmosTxSummary> {
    let raw = hex::decode(sign_doc_hex.trim())
        .map_err(|_| Error::input("SignDoc: hexadecimal expected"))?;
    Ok(parse_sign_doc(&raw, our_pubkey, cosmos_chain_id(net))?.summary)
}

/// Signs a SignDoc (hex) with `m/44'/118'/account'/0/0`, after [`cosmos_decode_sign_doc`].
pub fn cosmos_sign(
    seed: &Seed,
    account: u32,
    sign_doc_hex: &str,
    net: Network,
) -> Result<(String, String, CosmosTxSummary)> {
    use base64::Engine as _;
    let raw = hex::decode(sign_doc_hex.trim())
        .map_err(|_| Error::input("SignDoc: hexadecimal expected"))?;
    let secp = secp()?;
    let master = XprivGuard::master(seed, bitcoin::NetworkKind::Main)?;
    let key = master.derive(&secp, &path(account)?)?;
    // A reference: `SecretKey` is `Copy`, a copy here would outlive the guard's erasure.
    let sk = &key.xpriv().private_key;
    let pk = sk.public_key(&secp);
    let parsed = parse_sign_doc(&raw, &pk.serialize(), cosmos_chain_id(net))?;
    if parsed.mode != COSMOS_SIGN_MODE_DIRECT {
        return Err(bad("sign mode: SIGN_MODE_DIRECT expected"));
    }
    let msg = Message::from_digest(sha256::Hash::hash(&raw).to_byte_array());
    let mut sig = secp.sign_ecdsa(&msg, sk);
    sig.normalize_s();
    secp.verify_ecdsa(&msg, &sig, &pk)
        .map_err(|_| Error::crypto("signature verification failed"))?;
    let tx = proto::TxRaw {
        body_bytes: parsed.doc.body_bytes,
        auth_info_bytes: parsed.doc.auth_info_bytes,
        signatures: vec![sig.serialize_compact().to_vec()],
    }
    .encode_to_vec();
    let hash = hex::encode_upper(sha256::Hash::hash(&tx).to_byte_array());
    Ok((
        base64::engine::general_purpose::STANDARD.encode(&tx),
        hash,
        parsed.summary,
    ))
}

/// Checks a signed `TxRaw` (base64) before broadcast, returns `(hash upper hex, summary)`: strict
/// decode, live `chain_id`/`account_number`, one 64-byte low-S signature by its key.
pub fn cosmos_verify_signed(
    tx_b64: &str,
    net: Network,
    account_number: u64,
) -> Result<(String, CosmosTxSummary)> {
    use base64::Engine as _;
    let raw = base64::engine::general_purpose::STANDARD
        .decode(tx_b64.trim())
        .map_err(|_| Error::input("transaction: base64 expected"))?;
    if raw.len() > MAX_TX {
        return Err(bad("too large"));
    }
    let tx: proto::TxRaw = strict(&raw, "TxRaw")?;
    let sig = match tx.signatures.as_slice() {
        [s] if s.len() == 64 => s,
        _ => return Err(bad("one 64-byte signature expected")),
    };
    let auth: proto::AuthInfo = strict(&tx.auth_info_bytes, "AuthInfo")?;
    let key = auth
        .signer_infos
        .first()
        .and_then(|s| s.public_key.as_ref())
        .filter(|a| a.type_url == COSMOS_SECP256K1_PUBKEY)
        .ok_or_else(|| bad("missing signer public key"))?;
    let pk_bytes: [u8; 33] = strict::<proto::PubKey>(&key.value, "PubKey")?
        .key
        .try_into()
        .map_err(|_| bad("public key: 33 bytes expected"))?;
    let doc = proto::SignDoc {
        body_bytes: tx.body_bytes,
        auth_info_bytes: tx.auth_info_bytes,
        chain_id: cosmos_chain_id(net).to_owned(),
        account_number,
    }
    .encode_to_vec();
    let parsed = parse_sign_doc(&doc, &pk_bytes, cosmos_chain_id(net))?;
    let sig = Signature::from_compact(sig).map_err(|_| bad("invalid signature"))?;
    let mut low = sig;
    low.normalize_s();
    if low != sig {
        return Err(bad("the signature is not low-S (non-canonical)"));
    }
    let pk = PublicKey::from_slice(&pk_bytes).map_err(|_| bad("invalid public key"))?;
    let digest = if parsed.mode == COSMOS_SIGN_MODE_AMINO_JSON {
        sha256::Hash::hash(amino_json(&parsed).as_bytes())
    } else {
        sha256::Hash::hash(&doc)
    };
    Secp256k1::verification_only()
        .verify_ecdsa(&Message::from_digest(digest.to_byte_array()), &sig, &pk)
        .map_err(|_| bad("the signature does not verify"))?;
    Ok((
        hex::encode_upper(sha256::Hash::hash(&raw).to_byte_array()),
        parsed.summary,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn amounts_are_canonical_integers() {
        assert_eq!(parse_amount("1", "x").unwrap(), 1);
        assert_eq!(parse_amount("1000000", "x").unwrap(), 1_000_000);
        for s in ["", "0", "01", "+1", "-1", "1.0", " 1", "1e6", "x"] {
            assert!(parse_amount(s, "x").is_err(), "{s:?}");
        }
    }

    #[test]
    fn strict_refuses_unknown_and_duplicate_fields() {
        let c = proto::Coin {
            denom: "uatom".into(),
            amount: "5".into(),
        };
        let mut b = c.encode_to_vec();
        assert_eq!(strict::<proto::Coin>(&b, "Coin").unwrap(), c);
        // Unknown field 3 (varint 1): prost skips it, the re-encoding check refuses it.
        b.extend_from_slice(&[0x18, 0x01]);
        assert!(proto::Coin::decode(b.as_slice()).is_ok());
        assert!(strict::<proto::Coin>(&b, "Coin").is_err());
        // Duplicate field 2: "last one wins" in prost, refused here.
        let mut d = c.encode_to_vec();
        d.extend_from_slice(&[0x12, 0x01, b'9']);
        assert!(strict::<proto::Coin>(&d, "Coin").is_err());
        // Non-minimal length varint.
        let nm = [0x0a, 0x85, 0x00, b'u', b'a', b't', b'o', b'm'];
        assert!(strict::<proto::Coin>(&nm, "Coin").is_err());
    }
}
