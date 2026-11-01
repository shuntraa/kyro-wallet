//! Polkadot (DOT on **Polkadot Asset Hub**, WND on Westend Asset Hub for the testnet): sr25519
//! keys, SS58 addresses and one extrinsic, `Balances.transfer_keep_alive`, in SCALE.
//!
//! Since the Asset Hub migration (Polkadot, November 2025), balances and transfers live on
//! **Asset Hub** (parachain 1000), not on the relay chain: Polkadot.js, Nova, Talisman and
//! SubWallet show DOT there, with the same SS58 prefix (0).
//!
//! **Keys: sr25519 from the BIP39 entropy (`substrate-bip39`)**, like Polkadot.js, Nova,
//! Talisman and SubWallet — not the BIP39 seed, and not Ledger's ed25519 `m/44'/354'/…` path
//! (a phrase used with the Ledger Polkadot app gives other addresses). Account 0 is the
//! keypair of the phrase itself (the « root » account every one of those wallets shows first,
//! URI `phrase`); account `a ≥ 1` is the hard derivation `phrase//a` (Polkadot.js notation,
//! numeric junction = `u64` little-endian in a 32-byte chain code). Mini-secret:
//! `PBKDF2-HMAC-SHA512(entropy, "mnemonic" ‖ passphrase, 2048)[..32]` (`substrate-bip39`);
//! expansion and signing: `schnorrkel` (ExpansionMode::Ed25519, signing context `substrate`),
//! the crate Substrate itself uses. Checked against Polkadot.js (independent wasm
//! implementation) for root, `//1`, `//2` and `//Alice`.
//!
//! **SS58**: `base58(prefix ‖ pubkey ‖ blake2b-512("SS58PRE" ‖ prefix ‖ pubkey)[..2])`, one-byte
//! prefixes only (0 Polkadot, 42 Westend / generic); an address of another prefix is refused
//! (Kusama `H…`/`C…`/…, generic `5…` on mainnet: same key, but a different network was meant).
//!
//! **Runtime**: the call index of `Balances.transfer_keep_alive` is **pinned** per chain and
//! must be confirmed by the runtime metadata (V15) the node returns, together with the shape
//! of its arguments, the address / signature types, the layout of `System.Account` and the
//! transaction extensions: every extension must be one Kyro knows, with the expected types,
//! otherwise nothing is built or signed (a runtime upgrade that adds an unknown extension
//! needs a Kyro update). A node lying about metadata can only make the transaction invalid:
//! the call index and its encoding are Kyro's, and spec / transaction versions, genesis and
//! block hash are signed (the chain rejects a signature made for anything else).
//!
//! **Encoding** is SCALE (`parity-scale-codec`) for compact integers, by hand for the few
//! fixed fields: `call = [pallet, call] ‖ MultiAddress::Id(0x00 ‖ dest) ‖ Compact(value)`,
//! signing payload `call ‖ extra ‖ additional` (blake2-256 of it above 256 bytes), extrinsic
//! v4 `Compact(len) ‖ 0x84 ‖ 0x00 ‖ signer ‖ 0x01 ‖ sr25519 sig ‖ extra ‖ call`. Same safety
//! rule as XRP / TRON: **a payload or extrinsic is accepted only if re-encoding what was
//! decoded gives back the same bytes**. Kyro never sets a tip, never enables
//! `CheckMetadataHash` (mode 0, like Polkadot.js without a metadata-hash-aware signer), always
//! pays fees in DOT (`asset_id = None`) and always signs a **mortal** transaction.

use blake2::digest::consts::{U16, U32};
use blake2::{Blake2b, Blake2b512, Digest};
use frame_metadata::v15::RuntimeMetadataV15;
use frame_metadata::{RuntimeMetadata, RuntimeMetadataPrefixed, META_RESERVED};
use parity_scale_codec::{Compact, Decode, DecodeAll, Encode};
use scale_info::form::PortableForm;
use scale_info::{PortableRegistry, Type, TypeDef, TypeDefPrimitive};
use schnorrkel::derive::ChainCode;
use schnorrkel::{ExpansionMode, Keypair, MiniSecretKey, PublicKey, Signature};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::error::{Error, Result};
use crate::mnemonic::Mnemonic;
use crate::network::Network;

/// Signing context of every Substrate sr25519 signature.
const SIGNING_CTX: &[u8] = b"substrate";
/// Above this size the signing payload is replaced by its blake2-256 hash (Substrate rule).
const MAX_RAW_PAYLOAD: usize = 256;
/// Signed extrinsic, format version 4.
const EXTRINSIC_V4_SIGNED: u8 = 0x84;
/// `MultiAddress::Id`.
const MULTIADDRESS_ID: u8 = 0;
/// `MultiSignature::Sr25519`.
const MULTISIG_SR25519: u8 = 1;
const MAX_EXTRINSIC: usize = 1024;
/// Highest account number (hard junction `//a`), like the other chains.
const MAX_ACCOUNT: u32 = 0x7FFF_FFFF;

fn bad(msg: impl Into<String>) -> Error {
    Error::input(format!("transaction Polkadot refusée : {}", msg.into()))
}

/// blake2b-256.
pub fn dot_blake2_256(data: &[u8]) -> [u8; 32] {
    Blake2b::<U32>::digest(data).into()
}

fn blake2_128(data: &[u8]) -> [u8; 16] {
    Blake2b::<U16>::digest(data).into()
}

// ---------------------------------------------------------------------------------------------
// Chains
// ---------------------------------------------------------------------------------------------

/// What Kyro pins for a chain (never taken from the node).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DotChain {
    /// Kyro network.
    pub network: Network,
    /// Display name.
    pub name: &'static str,
    /// Runtime `spec_name` (System.Version).
    pub spec_name: &'static str,
    /// Genesis hash (block 0).
    pub genesis: [u8; 32],
    /// SS58 prefix of its addresses.
    pub ss58: u8,
    /// Decimals of the native token.
    pub decimals: u8,
    /// Native token symbol.
    pub symbol: &'static str,
    /// `Balances` pallet index.
    pub balances_pallet: u8,
    /// `transfer_keep_alive` call index in that pallet.
    pub transfer_keep_alive: u8,
}

/// 32 bytes from 64 lowercase hex digits, at compile time (constants only; checked by tests).
const fn h32(s: &[u8; 64]) -> [u8; 32] {
    const fn nib(c: u8) -> u8 {
        match c {
            b'0'..=b'9' => c - b'0',
            b'a'..=b'f' => c - b'a' + 10,
            _ => 0,
        }
    }
    let mut out = [0u8; 32];
    let mut i = 0;
    while i < 32 {
        out[i] = nib(s[2 * i]) << 4 | nib(s[2 * i + 1]);
        i += 1;
    }
    out
}

/// Polkadot Asset Hub (`statemint`, parachain 1000): where DOT balances live. Genesis and
/// indices checked on 2026-11-01 against `polkadot-asset-hub-rpc.polkadot.io` (runtime
/// 2005002, metadata V15: `Balances` = 10, `transfer_keep_alive` = 3, ED 0.01 DOT).
pub const DOT_POLKADOT_ASSET_HUB: DotChain = DotChain {
    network: Network::Mainnet,
    name: "Polkadot Asset Hub",
    spec_name: "statemint",
    genesis: h32(b"68d56f15f85d3136970ec16946040bc1752654e906147f7e43e9d539d7c3de2f"),
    ss58: 0,
    decimals: 10,
    symbol: "DOT",
    balances_pallet: 10,
    transfer_keep_alive: 3,
};

/// Westend Asset Hub (`westmint`): Parity's public testnet (WND, 12 decimals, generic prefix
/// 42). Checked on 2026-11-01 against `westend-asset-hub-rpc.polkadot.io` (runtime 1025003).
pub const DOT_WESTEND_ASSET_HUB: DotChain = DotChain {
    network: Network::Testnet,
    name: "Westend Asset Hub",
    spec_name: "westmint",
    genesis: h32(b"67f9723393ef76214df0118c34bbbd3dbebc8ed46a10973a8c969d48fe7598c9"),
    ss58: 42,
    decimals: 12,
    symbol: "WND",
    balances_pallet: 10,
    transfer_keep_alive: 3,
};

/// The chain Kyro uses on `network`.
pub fn dot_chain(network: Network) -> &'static DotChain {
    match network {
        Network::Mainnet => &DOT_POLKADOT_ASSET_HUB,
        Network::Testnet => &DOT_WESTEND_ASSET_HUB,
    }
}

// ---------------------------------------------------------------------------------------------
// Keys and addresses
// ---------------------------------------------------------------------------------------------

/// sr25519 mini-secret of the phrase (substrate-bip39), erased on drop.
pub struct PolkadotRoot(MiniSecretKey);

impl core::fmt::Debug for PolkadotRoot {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("PolkadotRoot(…)")
    }
}

impl PolkadotRoot {
    /// `substrate-bip39`: PBKDF2-HMAC-SHA512(entropy, "mnemonic" ‖ passphrase, 2048)[..32].
    pub fn from_mnemonic(mnemonic: &Mnemonic, passphrase: &str) -> Result<PolkadotRoot> {
        let entropy = mnemonic.entropy();
        substrate_bip39::mini_secret_from_entropy(&entropy, passphrase)
            .map(PolkadotRoot)
            .map_err(|_| Error::crypto("dérivation substrate-bip39 impossible"))
    }

    /// The mini-secret, hex (tests only: compared with Polkadot.js).
    #[doc(hidden)]
    pub fn to_hex_for_tests(&self) -> String {
        hex::encode(self.0.as_bytes())
    }

    fn keypair(&self, account: u32) -> Result<Keypair> {
        if account > MAX_ACCOUNT {
            return Err(Error::input("numéro de compte trop grand"));
        }
        let root = self.0.expand_to_keypair(ExpansionMode::Ed25519);
        if account == 0 {
            return Ok(root);
        }
        // `//a`: numeric junction = u64 LE, zero-padded to the 32-byte chain code; hard
        // derivation of sp-core (`hard_derive_mini_secret_key(cc, b"")`, then Ed25519 expansion).
        let mut cc = [0u8; 32];
        cc[..8].copy_from_slice(&u64::from(account).to_le_bytes());
        let (mini, _) = root
            .secret
            .hard_derive_mini_secret_key(Some(ChainCode(cc)), b"");
        Ok(mini.expand_to_keypair(ExpansionMode::Ed25519))
    }
}

/// How account `account` is derived, for the dialog: `sr25519 · phrase` / `sr25519 · phrase//a`.
pub fn dot_path(account: u32) -> String {
    if account == 0 {
        "sr25519 · phrase (compte racine, comme Polkadot.js)".into()
    } else {
        format!("sr25519 · phrase//{account}")
    }
}

/// sr25519 public key of account `account`.
pub fn dot_public_key(root: &PolkadotRoot, account: u32) -> Result<[u8; 32]> {
    Ok(root.keypair(account)?.public.to_bytes())
}

/// SS58 address of account `account` on `network`.
pub fn dot_address(root: &PolkadotRoot, account: u32, network: Network) -> Result<String> {
    Ok(dot_ss58_encode(
        &dot_public_key(root, account)?,
        dot_chain(network).ss58,
    ))
}

fn ss58_checksum(body: &[u8]) -> [u8; 2] {
    let mut h = Blake2b512::new();
    h.update(b"SS58PRE");
    h.update(body);
    let d = h.finalize();
    [d[0], d[1]]
}

/// SS58 address of a 32-byte public key (one-byte prefixes, `prefix < 64`).
pub fn dot_ss58_encode(public: &[u8; 32], prefix: u8) -> String {
    let mut body = Vec::with_capacity(35);
    body.push(prefix & 0x3F);
    body.extend_from_slice(public);
    let c = ss58_checksum(&body);
    body.extend_from_slice(&c);
    bs58::encode(body).into_string()
}

/// `(prefix, public key)` of an SS58 address (32-byte account, one-byte prefix, valid checksum).
pub fn dot_ss58_decode(address: &str) -> Result<(u8, [u8; 32])> {
    let a = address.trim();
    if a.is_empty() || a.len() > 64 {
        return Err(Error::input("adresse Polkadot invalide"));
    }
    let raw = bs58::decode(a)
        .into_vec()
        .map_err(|_| Error::input("adresse Polkadot invalide (base58)"))?;
    if raw.len() != 35 || raw[0] >= 64 {
        return Err(Error::input(
            "adresse Polkadot invalide (compte de 32 octets à préfixe d'un octet attendu)",
        ));
    }
    if ss58_checksum(&raw[..33]) != raw[33..] {
        return Err(Error::input(
            "adresse Polkadot invalide (somme de contrôle)",
        ));
    }
    let mut pk = [0u8; 32];
    pk.copy_from_slice(&raw[1..33]);
    Ok((raw[0], pk))
}

/// Account ID of `address`, which must use the prefix of `network`'s chain.
pub fn dot_account_id(address: &str, network: Network) -> Result<[u8; 32]> {
    let chain = dot_chain(network);
    let (prefix, pk) = dot_ss58_decode(address)?;
    if prefix != chain.ss58 {
        return Err(Error::input(format!(
            "adresse d'un autre réseau (préfixe SS58 {prefix}) : une adresse {} commence par le préfixe {} ({})",
            chain.name,
            chain.ss58,
            if chain.ss58 == 0 { "« 1… »" } else { "« 5… »" }
        )));
    }
    Ok(pk)
}

// ---------------------------------------------------------------------------------------------
// Runtime metadata
// ---------------------------------------------------------------------------------------------

/// A transaction extension Kyro knows how to fill (metadata order is kept).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DotExtension {
    /// No data and no additional data (CheckNonZeroSender, CheckWeight, …).
    NoData,
    /// `CheckSpecVersion`: additional `u32`.
    SpecVersion,
    /// `CheckTxVersion`: additional `u32`.
    TxVersion,
    /// `CheckGenesis`: additional genesis hash.
    Genesis,
    /// `CheckMortality`: era, additional block hash.
    Mortality,
    /// `CheckNonce`: `Compact<u32>`.
    Nonce,
    /// `ChargeAssetTxPayment`: `Compact<u128>` tip, `Option<asset id>` (always `None`).
    ChargeAssetTxPayment,
    /// `ChargeTransactionPayment`: `Compact<u128>` tip.
    ChargeTransactionPayment,
    /// `CheckMetadataHash`: mode byte (always 0 = disabled), additional `Option<[u8; 32]>` (None).
    MetadataHash,
}

/// Extensions without data that Kyro accepts (identifier, as in the metadata).
const NO_DATA_EXTENSIONS: &[&str] = &[
    "AuthorizeCall",
    "CheckNonZeroSender",
    "CheckWeight",
    "PrevalidateAttests",
    "EthSetOrigin",
    "StorageWeightReclaim",
];

/// Runtime facts read from the metadata and checked against [`DotChain`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DotRuntime {
    /// Network (selects the pinned chain).
    pub network: Network,
    /// `spec_version` of the metadata's runtime (System.Version).
    pub spec_version: u32,
    /// `transaction_version`.
    pub tx_version: u32,
    /// `Balances.ExistentialDeposit`, planck.
    pub existential_deposit: u128,
    /// Transaction extensions, in order.
    pub extensions: Vec<DotExtension>,
}

impl DotRuntime {
    /// The pinned chain.
    pub fn chain(&self) -> &'static DotChain {
        dot_chain(self.network)
    }
}

struct Reg<'a>(&'a PortableRegistry);

impl<'a> Reg<'a> {
    fn ty(&self, id: u32) -> Result<&'a Type<PortableForm>> {
        self.0
            .resolve(id)
            .ok_or_else(|| Error::input("métadonnées : type introuvable"))
    }

    fn def(&self, id: u32) -> Result<&'a TypeDef<PortableForm>> {
        Ok(&self.ty(id)?.type_def)
    }

    fn is_prim(&self, id: u32, p: TypeDefPrimitive) -> bool {
        matches!(self.def(id), Ok(TypeDef::Primitive(q)) if *q == p)
    }

    fn is_compact_of(&self, id: u32, p: TypeDefPrimitive) -> bool {
        matches!(self.def(id), Ok(TypeDef::Compact(c)) if self.is_prim(c.type_param.id, p))
    }

    /// `[u8; n]`, possibly wrapped in single-field composites (AccountId32, H256, Signature).
    fn is_bytes(&self, id: u32, n: u32) -> bool {
        self.is_bytes_depth(id, n, 0)
    }

    fn is_bytes_depth(&self, id: u32, n: u32, depth: u8) -> bool {
        if depth > 4 {
            return false;
        }
        match self.def(id) {
            Ok(TypeDef::Array(a)) => {
                a.len == n && self.is_prim(a.type_param.id, TypeDefPrimitive::U8)
            }
            Ok(TypeDef::Composite(c)) if c.fields.len() == 1 => {
                self.is_bytes_depth(c.fields[0].ty.id, n, depth + 1)
            }
            _ => false,
        }
    }

    /// Encodes to zero bytes (empty composite / tuple, recursively).
    fn is_empty(&self, id: u32) -> bool {
        self.is_empty_depth(id, 0)
    }

    fn is_empty_depth(&self, id: u32, depth: u8) -> bool {
        if depth > 4 {
            return false;
        }
        match self.def(id) {
            Ok(TypeDef::Composite(c)) => c
                .fields
                .iter()
                .all(|f| self.is_empty_depth(f.ty.id, depth + 1)),
            Ok(TypeDef::Tuple(t)) => t
                .fields
                .iter()
                .all(|f| self.is_empty_depth(f.id, depth + 1)),
            Ok(TypeDef::Array(a)) => a.len == 0,
            _ => false,
        }
    }

    fn path_is(&self, id: u32, path: &[&str]) -> bool {
        self.ty(id).is_ok_and(|t| {
            t.path
                .segments
                .iter()
                .map(String::as_str)
                .eq(path.iter().copied())
        })
    }

    /// Single-field composite: that field's type.
    fn only_field(&self, id: u32) -> Option<u32> {
        match self.def(id) {
            Ok(TypeDef::Composite(c)) if c.fields.len() == 1 => Some(c.fields[0].ty.id),
            _ => None,
        }
    }

    /// Variant `(name, index)` with exactly one field, of a type accepted by `field_ok`.
    fn has_variant(&self, id: u32, name: &str, index: u8, field_ok: impl Fn(u32) -> bool) -> bool {
        match self.def(id) {
            Ok(TypeDef::Variant(v)) => v.variants.iter().any(|x| {
                x.name == name
                    && x.index == index
                    && x.fields.len() == 1
                    && field_ok(x.fields[0].ty.id)
            }),
            _ => false,
        }
    }

    /// Variant without fields named `name` at `index`.
    fn has_unit_variant(&self, id: u32, name: &str, index: u8) -> bool {
        match self.def(id) {
            Ok(TypeDef::Variant(v)) => v
                .variants
                .iter()
                .any(|x| x.name == name && x.index == index && x.fields.is_empty()),
            _ => false,
        }
    }

    /// Named fields of a composite.
    fn fields(&self, id: u32) -> Option<Vec<(&'a str, u32)>> {
        match self.def(id) {
            Ok(TypeDef::Composite(c)) => c
                .fields
                .iter()
                .map(|f| f.name.as_deref().map(|n| (n, f.ty.id)))
                .collect(),
            _ => None,
        }
    }

    /// `MultiAddress` whose `Id` variant (index 0) is a 32-byte account.
    fn is_multiaddress(&self, id: u32) -> bool {
        self.path_is(id, &["sp_runtime", "multiaddress", "MultiAddress"])
            && self.has_variant(id, "Id", MULTIADDRESS_ID, |f| self.is_bytes(f, 32))
    }

    /// `u128`, possibly wrapped (ExtraFlags).
    fn is_u128ish(&self, id: u32) -> bool {
        self.is_prim(id, TypeDefPrimitive::U128)
            || self
                .only_field(id)
                .is_some_and(|f| self.is_prim(f, TypeDefPrimitive::U128))
    }
}

/// Decodes `Option<OpaqueMetadata>` (the result of `state_call("Metadata_metadata_at_version",
/// 15u32)`) and builds the [`DotRuntime`] of `network`, after checking it against the pinned
/// [`DotChain`] (spec name, SS58 prefix, call index and argument types, address / signature
/// types, `System.Account` layout, known extensions only).
pub fn dot_runtime(network: Network, state_call_result: &[u8]) -> Result<DotRuntime> {
    let chain = dot_chain(network);
    let md = |m: &str| Error::input(format!("métadonnées {} refusées : {m}", chain.name));
    let opaque = Option::<Vec<u8>>::decode_all(&mut &state_call_result[..])
        .map_err(|_| md("réponse illisible"))?
        .ok_or_else(|| md("le runtime ne fournit pas de métadonnées V15"))?;
    let prefixed =
        RuntimeMetadataPrefixed::decode_all(&mut &opaque[..]).map_err(|_| md("SCALE invalide"))?;
    if prefixed.0 != META_RESERVED {
        return Err(md("en-tête « meta » absent"));
    }
    let RuntimeMetadata::V15(m) = prefixed.1 else {
        return Err(md("version de métadonnées autre que V15"));
    };
    runtime_from_v15(chain, &m).map_err(|e| match e {
        Error::InvalidInput(s) => md(&s),
        other => other,
    })
}

fn runtime_from_v15(chain: &'static DotChain, m: &RuntimeMetadataV15) -> Result<DotRuntime> {
    let r = Reg(&m.types);
    let e = |s: &str| Error::input(s.to_owned());
    let x = &m.extrinsic;
    if x.version != 4 {
        return Err(e("format d'extrinsèque autre que v4"));
    }
    if !r.is_multiaddress(x.address_ty.id) {
        return Err(e("type d'adresse inattendu (MultiAddress attendu)"));
    }
    if !(r.path_is(x.signature_ty.id, &["sp_runtime", "MultiSignature"])
        && r.has_variant(x.signature_ty.id, "Sr25519", MULTISIG_SR25519, |f| {
            r.is_bytes(f, 64)
        }))
    {
        return Err(e(
            "type de signature inattendu (MultiSignature::Sr25519 attendu)",
        ));
    }

    // System: spec name and versions, SS58 prefix, System.Account layout.
    let system = m
        .pallets
        .iter()
        .find(|p| p.name == "System")
        .ok_or_else(|| e("pallet System absente"))?;
    let constant = |p: &frame_metadata::v15::PalletMetadata<PortableForm>, name: &str| {
        p.constants
            .iter()
            .find(|c| c.name == name)
            .map(|c| c.value.clone())
            .ok_or_else(|| e(&format!("constante {}.{name} absente", p.name)))
    };
    #[allow(clippy::type_complexity)]
    let (spec_name, _impl_name, _auth, spec_version, _impl_v, _apis, tx_version, _sys): (
        String,
        String,
        u32,
        u32,
        u32,
        Vec<([u8; 8], u32)>,
        u32,
        u8,
    ) = DecodeAll::decode_all(&mut &constant(system, "Version")?[..])
        .map_err(|_| e("System.Version illisible"))?;
    if spec_name != chain.spec_name {
        return Err(e(&format!(
            "runtime « {} » au lieu de « {} » : ce nœud n'est pas {}",
            crate::display::sanitize_text(&spec_name, 40).text,
            chain.spec_name,
            chain.name
        )));
    }
    let ss58 = u16::decode_all(&mut &constant(system, "SS58Prefix")?[..])
        .map_err(|_| e("System.SS58Prefix illisible"))?;
    if ss58 != u16::from(chain.ss58) {
        return Err(e("préfixe SS58 différent de celui attendu"));
    }
    check_account_layout(&r, system).map_err(|s| e(&s))?;

    // Balances: pallet index, transfer_keep_alive index and arguments, existential deposit.
    let balances = m
        .pallets
        .iter()
        .find(|p| p.name == "Balances")
        .ok_or_else(|| e("pallet Balances absente"))?;
    if balances.index != chain.balances_pallet {
        return Err(e(&format!(
            "index de la pallet Balances {} au lieu de {} : Kyro doit être mis à jour",
            balances.index, chain.balances_pallet
        )));
    }
    let calls = balances
        .calls
        .as_ref()
        .ok_or_else(|| e("Balances sans appels"))?;
    let TypeDef::Variant(v) = r.def(calls.ty.id)? else {
        return Err(e("appels de Balances illisibles"));
    };
    let call = v
        .variants
        .iter()
        .find(|c| c.name == "transfer_keep_alive")
        .ok_or_else(|| e("Balances.transfer_keep_alive absent"))?;
    if call.index != chain.transfer_keep_alive {
        return Err(e(&format!(
            "index de transfer_keep_alive {} au lieu de {} : Kyro doit être mis à jour",
            call.index, chain.transfer_keep_alive
        )));
    }
    let args: Vec<(Option<&str>, u32)> = call
        .fields
        .iter()
        .map(|f| (f.name.as_deref(), f.ty.id))
        .collect();
    let args_ok = matches!(
        args.as_slice(),
        [(Some("dest"), d), (Some("value"), val)]
            if r.is_multiaddress(*d) && r.is_compact_of(*val, TypeDefPrimitive::U128)
    );
    if !args_ok {
        return Err(e(
            "arguments de transfer_keep_alive inattendus (dest: MultiAddress, value: Compact<u128>)",
        ));
    }
    let existential_deposit = u128::decode_all(&mut &constant(balances, "ExistentialDeposit")?[..])
        .map_err(|_| e("Balances.ExistentialDeposit illisible"))?;

    // Transaction extensions.
    let mut extensions = Vec::with_capacity(x.signed_extensions.len());
    for ext in &x.signed_extensions {
        let id = ext.identifier.as_str();
        let (ty, add) = (ext.ty.id, ext.additional_signed.id);
        let fields = r.fields(ty);
        let one = r.only_field(ty);
        let kind = match id {
            "CheckSpecVersion" | "CheckTxVersion"
                if r.is_empty(ty) && r.is_prim(add, TypeDefPrimitive::U32) =>
            {
                if id == "CheckSpecVersion" {
                    DotExtension::SpecVersion
                } else {
                    DotExtension::TxVersion
                }
            }
            "CheckGenesis" if r.is_empty(ty) && r.is_bytes(add, 32) => DotExtension::Genesis,
            "CheckMortality" | "CheckEra"
                if one.is_some_and(|f| r.path_is(f, &["sp_runtime", "generic", "era", "Era"]))
                    && r.is_bytes(add, 32) =>
            {
                DotExtension::Mortality
            }
            "CheckNonce"
                if one.is_some_and(|f| r.is_compact_of(f, TypeDefPrimitive::U32))
                    && r.is_empty(add) =>
            {
                DotExtension::Nonce
            }
            "ChargeAssetTxPayment"
                if matches!(fields.as_deref(), Some([("tip", t), ("asset_id", a)])
                    if r.is_compact_of(*t, TypeDefPrimitive::U128)
                        && r.path_is(*a, &["Option"])
                        && r.has_unit_variant(*a, "None", 0))
                    && r.is_empty(add) =>
            {
                DotExtension::ChargeAssetTxPayment
            }
            "ChargeTransactionPayment"
                if one.is_some_and(|f| r.is_compact_of(f, TypeDefPrimitive::U128))
                    && r.is_empty(add) =>
            {
                DotExtension::ChargeTransactionPayment
            }
            "CheckMetadataHash"
                if matches!(fields.as_deref(), Some([("mode", mode)])
                    if r.has_unit_variant(*mode, "Disabled", 0))
                    && r.path_is(add, &["Option"])
                    && r.has_unit_variant(add, "None", 0) =>
            {
                DotExtension::MetadataHash
            }
            n if NO_DATA_EXTENSIONS.contains(&n) && r.is_empty(ty) && r.is_empty(add) => {
                DotExtension::NoData
            }
            other => {
                return Err(e(&format!(
                    "extension de transaction inconnue ou de forme inattendue « {} » : Kyro doit être mis à jour",
                    crate::display::sanitize_text(other, 60).text
                )))
            }
        };
        extensions.push(kind);
    }
    for required in [
        DotExtension::SpecVersion,
        DotExtension::TxVersion,
        DotExtension::Genesis,
        DotExtension::Mortality,
        DotExtension::Nonce,
    ] {
        if extensions.iter().filter(|k| **k == required).count() != 1 {
            return Err(e(&format!("extension {required:?} absente ou en double")));
        }
    }
    let payments = extensions
        .iter()
        .filter(|k| {
            matches!(
                k,
                DotExtension::ChargeAssetTxPayment | DotExtension::ChargeTransactionPayment
            )
        })
        .count();
    if payments != 1
        || extensions
            .iter()
            .filter(|k| **k == DotExtension::MetadataHash)
            .count()
            > 1
    {
        return Err(e("extensions de paiement des frais inattendues"));
    }
    Ok(DotRuntime {
        network: chain.network,
        spec_version,
        tx_version,
        existential_deposit,
        extensions,
    })
}

/// `System.Account`: map `Blake2_128Concat(AccountId32) → AccountInfo { nonce, consumers,
/// providers, sufficients: u32, data: { free, reserved, frozen, flags: u128 } }`, the 80-byte
/// layout [`dot_decode_account_info`] reads.
fn check_account_layout(
    r: &Reg<'_>,
    system: &frame_metadata::v15::PalletMetadata<PortableForm>,
) -> core::result::Result<(), String> {
    use frame_metadata::v15::{StorageEntryType, StorageHasher};
    let entry = system
        .storage
        .as_ref()
        .and_then(|s| s.entries.iter().find(|e| e.name == "Account"))
        .ok_or("System.Account absent")?;
    let StorageEntryType::Map {
        hashers,
        key,
        value,
    } = &entry.ty
    else {
        return Err("System.Account n'est pas une map".into());
    };
    if !matches!(hashers.as_slice(), [StorageHasher::Blake2_128Concat]) || !r.is_bytes(key.id, 32) {
        return Err("clé de System.Account inattendue".into());
    }
    let info = r.fields(value.id).ok_or("System.Account illisible")?;
    let names: Vec<&str> = info.iter().map(|f| f.0).collect();
    if names != ["nonce", "consumers", "providers", "sufficients", "data"]
        || !info[..4]
            .iter()
            .all(|f| r.is_prim(f.1, TypeDefPrimitive::U32))
    {
        return Err("AccountInfo inattendu".into());
    }
    let data = r.fields(info[4].1).ok_or("AccountData illisible")?;
    let names: Vec<&str> = data.iter().map(|f| f.0).collect();
    if names != ["free", "reserved", "frozen", "flags"] || !data.iter().all(|f| r.is_u128ish(f.1)) {
        return Err("AccountData inattendu".into());
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Storage and runtime API helpers
// ---------------------------------------------------------------------------------------------

/// `twox128("System") ‖ twox128("Account")`.
const SYSTEM_ACCOUNT_PREFIX: [u8; 32] =
    h32(b"26aa394eea5630e07c48ae0c9558cef7b99d880ec681799c0cf30e8886371da9");

/// Storage key of `System.Account(account)`: prefix ‖ blake2-128(account) ‖ account.
pub fn dot_account_storage_key(account: &[u8; 32]) -> Vec<u8> {
    let mut k = Vec::with_capacity(80);
    k.extend_from_slice(&SYSTEM_ACCOUNT_PREFIX);
    k.extend_from_slice(&blake2_128(account));
    k.extend_from_slice(account);
    k
}

/// `System.Account` value (an absent key means an account that does not exist: all zero).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DotAccountInfo {
    /// Nonce of the next transaction.
    pub nonce: u32,
    /// Consumer references.
    pub consumers: u32,
    /// Provider references (0 = the account does not exist).
    pub providers: u32,
    /// Sufficient references.
    pub sufficients: u32,
    /// Free balance, planck.
    pub free: u128,
    /// Reserved balance, planck.
    pub reserved: u128,
    /// Frozen (locked) part of `free`, planck.
    pub frozen: u128,
    /// Internal flags.
    pub flags: u128,
}

impl DotAccountInfo {
    /// The account exists on chain (has a provider, e.g. a balance ≥ the existential deposit).
    pub fn exists(&self) -> bool {
        self.providers > 0 || self.sufficients > 0
    }

    /// What `transfer_keep_alive` (and the fee) may take: `free − max(frozen − reserved, ED)`,
    /// pallet-balances' `reducible_balance(Preserve, Polite)`.
    pub fn spendable(&self, existential_deposit: u128) -> u128 {
        let untouchable = self
            .frozen
            .saturating_sub(self.reserved)
            .max(existential_deposit);
        self.free.saturating_sub(untouchable)
    }
}

/// Decodes a `System.Account` value (exactly 80 bytes; layout checked by [`dot_runtime`]).
pub fn dot_decode_account_info(bytes: &[u8]) -> Result<DotAccountInfo> {
    #[allow(clippy::type_complexity)]
    let (nonce, consumers, providers, sufficients, free, reserved, frozen, flags): (
        u32,
        u32,
        u32,
        u32,
        u128,
        u128,
        u128,
        u128,
    ) = DecodeAll::decode_all(&mut &bytes[..])
        .map_err(|_| Error::input("System.Account : 80 octets attendus"))?;
    Ok(DotAccountInfo {
        nonce,
        consumers,
        providers,
        sufficients,
        free,
        reserved,
        frozen,
        flags,
    })
}

/// `partial_fee` (planck) of a `TransactionPaymentApi_query_info` result:
/// `RuntimeDispatchInfo { weight: { Compact<u64>, Compact<u64> }, class: u8, partial_fee: u128 }`.
pub fn dot_decode_fee_info(bytes: &[u8]) -> Result<u128> {
    let (_rt, _ps, class, fee): (Compact<u64>, Compact<u64>, u8, u128) =
        DecodeAll::decode_all(&mut &bytes[..])
            .map_err(|_| Error::input("réponse de frais Polkadot illisible"))?;
    if class > 2 {
        return Err(Error::input("classe de transaction inattendue"));
    }
    Ok(fee)
}

/// Argument of `TransactionPaymentApi_query_info`: the extrinsic then its length (`u32`).
pub fn dot_fee_query_arg(extrinsic: &[u8]) -> Vec<u8> {
    let mut out = extrinsic.to_vec();
    out.extend_from_slice(&(extrinsic.len() as u32).to_le_bytes());
    out
}

// ---------------------------------------------------------------------------------------------
// Era
// ---------------------------------------------------------------------------------------------

/// A **mortal** era (sp_runtime `Era::Mortal(period, phase)`): valid from block `birth` for
/// `period` blocks. Immortal transactions are never built nor signed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DotEra {
    /// Power of two, 4 … 65536.
    pub period: u64,
    /// `birth % period`.
    pub phase: u64,
}

impl DotEra {
    /// Era of `period` blocks starting at block `current` (sp_runtime `Era::mortal`).
    pub fn mortal(period: u64, current: u64) -> DotEra {
        let period = period
            .checked_next_power_of_two()
            .unwrap_or(1 << 16)
            .clamp(4, 1 << 16);
        let phase = current % period;
        let q = (period >> 12).max(1);
        DotEra {
            period,
            phase: phase / q * q,
        }
    }

    /// First block of validity, for a transaction checked at block `current`.
    pub fn birth(&self, current: u64) -> u64 {
        (current.max(self.phase) - self.phase) / self.period * self.period + self.phase
    }

    /// First block where it is no longer valid.
    pub fn death(&self, current: u64) -> u64 {
        self.birth(current) + self.period
    }

    fn encode(&self) -> [u8; 2] {
        let q = (self.period >> 12).max(1);
        let tz = self.period.trailing_zeros().saturating_sub(1).clamp(1, 15) as u16;
        let encoded = tz | (((self.phase / q) as u16) << 4);
        encoded.to_le_bytes()
    }

    fn decode(input: &mut &[u8]) -> Result<DotEra> {
        let first = take(input, 1)?[0];
        if first == 0 {
            return Err(bad(
                "transaction immortelle (valable indéfiniment) : Kyro ne signe que des transactions à durée limitée",
            ));
        }
        let second = take(input, 1)?[0];
        let encoded = u64::from(first) | (u64::from(second) << 8);
        let period = 2u64 << (encoded % (1 << 4));
        let q = (period >> 12).max(1);
        let phase = (encoded >> 4) * q;
        if period < 4 || phase >= period {
            return Err(bad("ère invalide"));
        }
        Ok(DotEra { period, phase })
    }
}

fn take<'a>(input: &mut &'a [u8], n: usize) -> Result<&'a [u8]> {
    if input.len() < n {
        return Err(bad("données tronquées"));
    }
    let (head, tail) = input.split_at(n);
    *input = tail;
    Ok(head)
}

fn take32(input: &mut &[u8]) -> Result<[u8; 32]> {
    let mut out = [0u8; 32];
    out.copy_from_slice(take(input, 32)?);
    Ok(out)
}

fn compact_u128(input: &mut &[u8]) -> Result<u128> {
    Compact::<u128>::decode(input)
        .map(|c| c.0)
        .map_err(|_| bad("entier compact invalide"))
}

// ---------------------------------------------------------------------------------------------
// Transfer: encoding, decoding, signing
// ---------------------------------------------------------------------------------------------

/// A `Balances.transfer_keep_alive` and what is signed with it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DotTransfer {
    /// Recipient account ID.
    pub dest: [u8; 32],
    /// Amount, planck.
    pub value: u128,
    /// Mortality.
    pub era: DotEra,
    /// Hash of the era's birth block.
    pub block_hash: [u8; 32],
    /// Account nonce.
    pub nonce: u32,
    /// Tip, planck (Kyro: always 0).
    pub tip: u128,
}

impl DotTransfer {
    /// `[pallet, call] ‖ MultiAddress::Id(dest) ‖ Compact(value)`.
    pub fn call(&self, rt: &DotRuntime) -> Vec<u8> {
        let c = rt.chain();
        let mut o = vec![c.balances_pallet, c.transfer_keep_alive, MULTIADDRESS_ID];
        o.extend_from_slice(&self.dest);
        Compact(self.value).encode_to(&mut o);
        o
    }

    /// Extension data placed in the extrinsic (metadata order).
    pub fn extra(&self, rt: &DotRuntime) -> Vec<u8> {
        let mut o = Vec::new();
        for e in &rt.extensions {
            match e {
                DotExtension::Mortality => o.extend_from_slice(&self.era.encode()),
                DotExtension::Nonce => Compact(self.nonce).encode_to(&mut o),
                DotExtension::ChargeAssetTxPayment => {
                    Compact(self.tip).encode_to(&mut o);
                    o.push(0); // asset_id: None (fees in the native token)
                }
                DotExtension::ChargeTransactionPayment => Compact(self.tip).encode_to(&mut o),
                DotExtension::MetadataHash => o.push(0), // Mode::Disabled
                DotExtension::NoData
                | DotExtension::SpecVersion
                | DotExtension::TxVersion
                | DotExtension::Genesis => {}
            }
        }
        o
    }

    /// Additional signed data (not in the extrinsic, but signed).
    pub fn additional(&self, rt: &DotRuntime) -> Vec<u8> {
        let mut o = Vec::new();
        for e in &rt.extensions {
            match e {
                DotExtension::SpecVersion => o.extend_from_slice(&rt.spec_version.to_le_bytes()),
                DotExtension::TxVersion => o.extend_from_slice(&rt.tx_version.to_le_bytes()),
                DotExtension::Genesis => o.extend_from_slice(&rt.chain().genesis),
                DotExtension::Mortality => o.extend_from_slice(&self.block_hash),
                DotExtension::MetadataHash => o.push(0), // None
                DotExtension::NoData
                | DotExtension::Nonce
                | DotExtension::ChargeAssetTxPayment
                | DotExtension::ChargeTransactionPayment => {}
            }
        }
        o
    }

    /// Signing payload `call ‖ extra ‖ additional` (what [`dot_sign`] receives, in hex).
    pub fn payload(&self, rt: &DotRuntime) -> Vec<u8> {
        let mut o = self.call(rt);
        o.extend(self.extra(rt));
        o.extend(self.additional(rt));
        o
    }

    /// Signed extrinsic v4, length-prefixed.
    pub fn extrinsic(&self, rt: &DotRuntime, signer: &[u8; 32], signature: &[u8; 64]) -> Vec<u8> {
        let mut body = vec![EXTRINSIC_V4_SIGNED, MULTIADDRESS_ID];
        body.extend_from_slice(signer);
        body.push(MULTISIG_SR25519);
        body.extend_from_slice(signature);
        body.extend(self.extra(rt));
        body.extend(self.call(rt));
        let mut out = Compact(body.len() as u32).encode();
        out.extend(body);
        out
    }
}

fn decode_call(rt: &DotRuntime, input: &mut &[u8]) -> Result<([u8; 32], u128)> {
    let c = rt.chain();
    let head = take(input, 3)?;
    if head[0] != c.balances_pallet || head[1] != c.transfer_keep_alive {
        return Err(bad(format!(
            "appel {:02x}{:02x} : seul Balances.transfer_keep_alive ({:02x}{:02x}) est accepté",
            head[0], head[1], c.balances_pallet, c.transfer_keep_alive
        )));
    }
    if head[2] != MULTIADDRESS_ID {
        return Err(bad("destinataire autre qu'un compte (MultiAddress::Id)"));
    }
    let dest = take32(input)?;
    let value = compact_u128(input)?;
    Ok((dest, value))
}

fn decode_extra(rt: &DotRuntime, input: &mut &[u8]) -> Result<(DotEra, u32, u128)> {
    let (mut era, mut nonce, mut tip) = (None, None, 0u128);
    for e in &rt.extensions {
        match e {
            DotExtension::Mortality => era = Some(DotEra::decode(input)?),
            DotExtension::Nonce => {
                nonce = Some(
                    Compact::<u32>::decode(input)
                        .map_err(|_| bad("nonce invalide"))?
                        .0,
                )
            }
            DotExtension::ChargeAssetTxPayment => {
                tip = compact_u128(input)?;
                if take(input, 1)?[0] != 0 {
                    return Err(bad(
                        "frais payés dans un autre actif que le jeton natif : refusé",
                    ));
                }
            }
            DotExtension::ChargeTransactionPayment => tip = compact_u128(input)?,
            DotExtension::MetadataHash => {
                if take(input, 1)?[0] != 0 {
                    return Err(bad("CheckMetadataHash activé : Kyro ne l'utilise pas"));
                }
            }
            DotExtension::NoData
            | DotExtension::SpecVersion
            | DotExtension::TxVersion
            | DotExtension::Genesis => {}
        }
    }
    match (era, nonce) {
        (Some(era), Some(nonce)) => Ok((era, nonce, tip)),
        _ => Err(bad("extensions incomplètes")),
    }
}

fn decode_additional(rt: &DotRuntime, input: &mut &[u8]) -> Result<[u8; 32]> {
    let u32_at = |input: &mut &[u8]| -> Result<u32> {
        let b = take(input, 4)?;
        Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    };
    let mut block = None;
    for e in &rt.extensions {
        match e {
            DotExtension::SpecVersion => {
                if u32_at(input)? != rt.spec_version {
                    return Err(bad(
                        "spec_version différent du runtime actuel : reconstruis",
                    ));
                }
            }
            DotExtension::TxVersion => {
                if u32_at(input)? != rt.tx_version {
                    return Err(bad(
                        "transaction_version différent du runtime actuel : reconstruis",
                    ));
                }
            }
            DotExtension::Genesis => {
                if take32(input)? != rt.chain().genesis {
                    return Err(bad(format!(
                        "genesis d'une autre chaîne que {}",
                        rt.chain().name
                    )));
                }
            }
            DotExtension::Mortality => block = Some(take32(input)?),
            DotExtension::MetadataHash => {
                if take(input, 1)?[0] != 0 {
                    return Err(bad("hash de métadonnées inattendu"));
                }
            }
            DotExtension::NoData
            | DotExtension::Nonce
            | DotExtension::ChargeAssetTxPayment
            | DotExtension::ChargeTransactionPayment => {}
        }
    }
    block.ok_or_else(|| bad("hash de bloc absent"))
}

fn check_transfer(t: &DotTransfer, from: &[u8; 32]) -> Result<()> {
    if t.value == 0 {
        return Err(bad("montant nul"));
    }
    if &t.dest == from {
        return Err(bad("transfert à soi-même"));
    }
    if t.tip != 0 {
        return Err(bad("pourboire non nul : Kyro n'en ajoute jamais"));
    }
    if t.era.period > 4096 {
        return Err(bad("durée de validité trop longue (plus de 4096 blocs)"));
    }
    Ok(())
}

/// Decodes a signing payload (bytes) into a transfer, refusing anything Kyro would not build
/// (see [`dot_decode_payload`]).
pub fn dot_parse_payload(rt: &DotRuntime, payload: &[u8], from: &[u8; 32]) -> Result<DotTransfer> {
    if payload.len() > MAX_RAW_PAYLOAD {
        return Err(bad("charge à signer trop longue pour un transfert"));
    }
    let mut input = payload;
    let (dest, value) = decode_call(rt, &mut input)?;
    let (era, nonce, tip) = decode_extra(rt, &mut input)?;
    let block_hash = decode_additional(rt, &mut input)?;
    if !input.is_empty() {
        return Err(bad("octets en trop"));
    }
    let t = DotTransfer {
        dest,
        value,
        era,
        block_hash,
        nonce,
        tip,
    };
    if t.payload(rt) != payload {
        return Err(bad("encodage non canonique (ré-encodage différent)"));
    }
    check_transfer(&t, from)?;
    Ok(t)
}

/// Plain-language summary of a transfer, decoded by Rust.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DotTxSummary {
    /// Chain name ("Polkadot Asset Hub").
    pub chain: String,
    /// Sender (always our address).
    pub from: String,
    /// Recipient.
    pub to: String,
    /// Planck, decimal string.
    pub amount: String,
    /// Token symbol (DOT / WND).
    pub symbol: String,
    /// Token decimals.
    pub decimals: u8,
    /// `Balances.transfer_keep_alive`.
    pub call: String,
    /// Account nonce.
    pub nonce: u32,
    /// Tip, planck (always "0").
    pub tip: String,
    /// Validity in blocks.
    pub era_period: u64,
    /// Era phase.
    pub era_phase: u64,
    /// Hash of the era's birth block, hex.
    pub block_hash: String,
    /// Runtime spec version signed.
    pub spec_version: u32,
    /// Transaction version signed.
    pub tx_version: u32,
}

fn summarize(rt: &DotRuntime, t: &DotTransfer, from: &[u8; 32]) -> DotTxSummary {
    let c = rt.chain();
    DotTxSummary {
        chain: c.name.into(),
        from: dot_ss58_encode(from, c.ss58),
        to: dot_ss58_encode(&t.dest, c.ss58),
        amount: t.value.to_string(),
        symbol: c.symbol.into(),
        decimals: c.decimals,
        call: "Balances.transfer_keep_alive".into(),
        nonce: t.nonce,
        tip: t.tip.to_string(),
        era_period: t.era.period,
        era_phase: t.era.phase,
        block_hash: hex::encode(t.block_hash),
        spec_version: rt.spec_version,
        tx_version: rt.tx_version,
    }
}

/// Builds the signing payload (hex) of a transfer from `from` (refused like [`dot_decode_payload`]).
pub fn dot_transfer_payload(rt: &DotRuntime, t: &DotTransfer, from: &[u8; 32]) -> Result<String> {
    check_transfer(t, from)?;
    Ok(hex::encode(t.payload(rt)))
}

/// Decodes a signing payload (hex) for the dialog. Refused: any call but
/// `Balances.transfer_keep_alive` to a plain account, a zero amount, a transfer to `from`, a
/// tip, fees in another asset, `CheckMetadataHash` enabled, an immortal era or one above 4096
/// blocks, another genesis / spec / transaction version than `rt`, trailing or non-canonical
/// bytes.
pub fn dot_decode_payload(
    rt: &DotRuntime,
    payload_hex: &str,
    from: &[u8; 32],
) -> Result<DotTxSummary> {
    let raw = hex::decode(payload_hex.trim()).map_err(|_| bad("hexadécimal attendu"))?;
    let t = dot_parse_payload(rt, &raw, from)?;
    Ok(summarize(rt, &t, from))
}

/// The extrinsic of a payload (hex) with an all-zero signature, for
/// `TransactionPaymentApi_query_info` only (fees do not depend on the signature; the node
/// would reject it). Same refusals as [`dot_decode_payload`].
pub fn dot_fee_probe_extrinsic(
    rt: &DotRuntime,
    payload_hex: &str,
    from: &[u8; 32],
) -> Result<Vec<u8>> {
    let raw = hex::decode(payload_hex.trim()).map_err(|_| bad("hexadécimal attendu"))?;
    let t = dot_parse_payload(rt, &raw, from)?;
    Ok(t.extrinsic(rt, from, &[0u8; 64]))
}

fn signing_message(payload: &[u8]) -> Vec<u8> {
    if payload.len() > MAX_RAW_PAYLOAD {
        dot_blake2_256(payload).to_vec()
    } else {
        payload.to_vec()
    }
}

/// Signs a payload (hex) with account `account`, after decoding it like
/// [`dot_decode_payload`]. Returns `(signed extrinsic hex, extrinsic hash hex, summary)`; the
/// signature is verified and the extrinsic re-decoded ([`dot_verify_extrinsic`]) before return.
pub fn dot_sign(
    root: &PolkadotRoot,
    account: u32,
    rt: &DotRuntime,
    payload_hex: &str,
) -> Result<(String, String, DotTxSummary)> {
    let kp = root.keypair(account)?;
    let from = kp.public.to_bytes();
    let raw = hex::decode(payload_hex.trim()).map_err(|_| bad("hexadécimal attendu"))?;
    let t = dot_parse_payload(rt, &raw, &from)?;
    let ctx = schnorrkel::signing_context(SIGNING_CTX);
    let sig = kp.sign(ctx.bytes(&signing_message(&raw))).to_bytes();
    drop(kp);
    let ext = t.extrinsic(rt, &from, &sig);
    let (signer, hash, summary) = dot_verify_extrinsic(rt, &hex::encode(&ext), &t.block_hash)?;
    if signer != from || summary != summarize(rt, &t, &from) {
        return Err(Error::crypto("extrinsèque signé incohérent"));
    }
    Ok((hex::encode(ext), hash, summary))
}

/// Decodes a signed extrinsic (hex), checks its sr25519 signature over the payload rebuilt from
/// `rt` and `block_hash` (the era's birth block: it is signed but not part of the extrinsic)
/// and the same refusals as [`dot_decode_payload`]. Returns `(signer, hash hex, summary)`; the
/// hash is blake2-256 of the whole extrinsic, what `author_submitExtrinsic` returns.
pub fn dot_verify_extrinsic(
    rt: &DotRuntime,
    extrinsic_hex: &str,
    block_hash: &[u8; 32],
) -> Result<([u8; 32], String, DotTxSummary)> {
    let raw =
        Zeroizing::new(hex::decode(extrinsic_hex.trim()).map_err(|_| bad("hexadécimal attendu"))?);
    if raw.len() > MAX_EXTRINSIC {
        return Err(bad("extrinsèque trop long"));
    }
    let mut input = &raw[..];
    let len = Compact::<u32>::decode(&mut input)
        .map_err(|_| bad("longueur invalide"))?
        .0 as usize;
    if len != input.len() {
        return Err(bad("longueur annoncée différente"));
    }
    let head = take(&mut input, 2)?;
    if head != [EXTRINSIC_V4_SIGNED, MULTIADDRESS_ID] {
        return Err(bad("extrinsèque v4 signé par un compte attendu"));
    }
    let signer = take32(&mut input)?;
    if take(&mut input, 1)?[0] != MULTISIG_SR25519 {
        return Err(bad("signature autre que sr25519"));
    }
    let mut sig = [0u8; 64];
    sig.copy_from_slice(take(&mut input, 64)?);
    let (era, nonce, tip) = decode_extra(rt, &mut input)?;
    let (dest, value) = decode_call(rt, &mut input)?;
    if !input.is_empty() {
        return Err(bad("octets en trop"));
    }
    let t = DotTransfer {
        dest,
        value,
        era,
        block_hash: *block_hash,
        nonce,
        tip,
    };
    check_transfer(&t, &signer)?;
    if t.extrinsic(rt, &signer, &sig) != *raw {
        return Err(bad("encodage non canonique (ré-encodage différent)"));
    }
    let public = PublicKey::from_bytes(&signer).map_err(|_| bad("clé publique invalide"))?;
    let signature = Signature::from_bytes(&sig).map_err(|_| bad("signature mal formée"))?;
    let ctx = schnorrkel::signing_context(SIGNING_CTX);
    public
        .verify(ctx.bytes(&signing_message(&t.payload(rt))), &signature)
        .map_err(|_| {
            bad("signature invalide pour ce runtime, ce bloc et ce compte (rien n'est diffusé)")
        })?;
    Ok((
        signer,
        hex::encode(dot_blake2_256(&raw)),
        summarize(rt, &t, &signer),
    ))
}
