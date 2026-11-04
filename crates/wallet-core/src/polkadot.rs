//! Polkadot Asset Hub (DOT; WND on Westend): sr25519, SS58, Balances/Assets `transfer_keep_alive`.

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
use crate::mnemonic::{nfkd, Mnemonic};
use crate::network::Network;

const SIGNING_CTX: &[u8] = b"substrate";
const MAX_RAW_PAYLOAD: usize = 256;
const EXTRINSIC_V4_SIGNED: u8 = 0x84;
const MULTIADDRESS_ID: u8 = 0;
const MULTISIG_SR25519: u8 = 1;
const MAX_EXTRINSIC: usize = 1024;
const MAX_ACCOUNT: u32 = 0x7FFF_FFFF;

fn bad(msg: impl Into<String>) -> Error {
    Error::input(format!("Polkadot transaction refused: {}", msg.into()))
}

/// blake2b-256.
pub fn dot_blake2_256(data: &[u8]) -> [u8; 32] {
    Blake2b::<U32>::digest(data).into()
}

fn blake2_128(data: &[u8]) -> [u8; 16] {
    Blake2b::<U16>::digest(data).into()
}

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
    /// `Assets` pallet index (trust-backed assets: USD₮, USDC).
    pub assets_pallet: u8,
    /// `Assets.transfer_keep_alive` call index.
    pub assets_transfer_keep_alive: u8,
}

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

/// Polkadot Asset Hub (`statemint`, parachain 1000): where DOT balances live.
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
    assets_pallet: 50,
    assets_transfer_keep_alive: 9,
};

/// Westend Asset Hub (`westmint`): Parity's public testnet (WND, 12 decimals, generic prefix 42).
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
    assets_pallet: 50,
    assets_transfer_keep_alive: 9,
};

/// A trust-backed asset of Asset Hub that Kyro knows (pallet `Assets`, verified id).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DotKnownAsset {
    /// Asset id (pallet Assets).
    pub id: u32,
    /// Symbol shown by Kyro.
    pub symbol: &'static str,
    /// `Assets.Metadata` symbol on chain (checked before building).
    pub chain_symbol: &'static str,
    /// Name shown by Kyro.
    pub name: &'static str,
    /// Decimals (equal to `Assets.Metadata`).
    pub decimals: u8,
}

const POLKADOT_ASSETS: &[DotKnownAsset] = &[
    DotKnownAsset {
        id: 1984,
        symbol: "USDT",
        chain_symbol: "USDt",
        name: "Tether",
        decimals: 6,
    },
    DotKnownAsset {
        id: 1337,
        symbol: "USDC",
        chain_symbol: "USDC",
        name: "USD Coin",
        decimals: 6,
    },
];

/// Assets Kyro can hold and send on `network` (none on Westend: no official test stablecoin).
pub fn dot_known_assets(network: Network) -> &'static [DotKnownAsset] {
    match network {
        Network::Mainnet => POLKADOT_ASSETS,
        Network::Testnet => &[],
    }
}

/// The known asset `id` on `network`.
pub fn dot_known_asset(network: Network, id: u32) -> Option<DotKnownAsset> {
    dot_known_assets(network)
        .iter()
        .copied()
        .find(|a| a.id == id)
}

/// The chain Kyro uses on `network`.
pub fn dot_chain(network: Network) -> &'static DotChain {
    match network {
        Network::Mainnet => &DOT_POLKADOT_ASSET_HUB,
        Network::Testnet => &DOT_WESTEND_ASSET_HUB,
    }
}

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
        substrate_bip39::mini_secret_from_entropy(&entropy, &nfkd(passphrase))
            .map(PolkadotRoot)
            .map_err(|_| Error::crypto("substrate-bip39 derivation failed"))
    }

    /// The mini-secret, hex (tests only: compared with Polkadot.js).
    #[doc(hidden)]
    pub fn to_hex_for_tests(&self) -> String {
        hex::encode(self.0.as_bytes())
    }

    fn keypair(&self, account: u32) -> Result<Keypair> {
        if account > MAX_ACCOUNT {
            return Err(Error::input("account number too large"));
        }
        let root = self.0.expand_to_keypair(ExpansionMode::Ed25519);
        if account == 0 {
            return Ok(root);
        }
        // `//a`: u64 LE junction padded to 32 bytes; sp-core hard derive, then Ed25519 expand.
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
        "sr25519 · phrase (root account, like Polkadot.js)".into()
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
        return Err(Error::input("invalid Polkadot address"));
    }
    let raw = bs58::decode(a)
        .into_vec()
        .map_err(|_| Error::input("invalid Polkadot address (base58)"))?;
    if raw.len() != 35 || raw[0] >= 64 {
        return Err(Error::input(
            "invalid Polkadot address (32-byte account with a one-byte prefix expected)",
        ));
    }
    if ss58_checksum(&raw[..33]) != raw[33..] {
        return Err(Error::input("invalid Polkadot address (checksum)"));
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
            "address from another network (SS58 prefix {prefix}): a {} address starts with prefix {} ({})",
            chain.name,
            chain.ss58,
            if chain.ss58 == 0 { "\"1…\"" } else { "\"5…\"" }
        )));
    }
    Ok(pk)
}

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
    /// `Assets` pallet as Kyro expects it, or why not (tokens then refused; DOT still works).
    pub assets: core::result::Result<(), String>,
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
            .ok_or_else(|| Error::input("metadata: type not found"))
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

    fn only_field(&self, id: u32) -> Option<u32> {
        match self.def(id) {
            Ok(TypeDef::Composite(c)) if c.fields.len() == 1 => Some(c.fields[0].ty.id),
            _ => None,
        }
    }

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

    fn has_unit_variant(&self, id: u32, name: &str, index: u8) -> bool {
        match self.def(id) {
            Ok(TypeDef::Variant(v)) => v
                .variants
                .iter()
                .any(|x| x.name == name && x.index == index && x.fields.is_empty()),
            _ => false,
        }
    }

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

    fn is_multiaddress(&self, id: u32) -> bool {
        self.path_is(id, &["sp_runtime", "multiaddress", "MultiAddress"])
            && self.has_variant(id, "Id", MULTIADDRESS_ID, |f| self.is_bytes(f, 32))
    }

    fn is_u128ish(&self, id: u32) -> bool {
        self.is_prim(id, TypeDefPrimitive::U128)
            || self
                .only_field(id)
                .is_some_and(|f| self.is_prim(f, TypeDefPrimitive::U128))
    }
}

/// Decodes `Option<OpaqueMetadata>` (`Metadata_metadata_at_version(15)`) into the [`DotRuntime`]
/// of `network`, checked against the pinned [`DotChain`] (spec, SS58, call/type/extension layout).
pub fn dot_runtime(network: Network, state_call_result: &[u8]) -> Result<DotRuntime> {
    let chain = dot_chain(network);
    let md = |m: &str| Error::input(format!("{} metadata refused: {m}", chain.name));
    let opaque = Option::<Vec<u8>>::decode_all(&mut &state_call_result[..])
        .map_err(|_| md("unreadable response"))?
        .ok_or_else(|| md("the runtime does not provide V15 metadata"))?;
    let prefixed =
        RuntimeMetadataPrefixed::decode_all(&mut &opaque[..]).map_err(|_| md("invalid SCALE"))?;
    if prefixed.0 != META_RESERVED {
        return Err(md("\"meta\" header missing"));
    }
    let RuntimeMetadata::V15(m) = prefixed.1 else {
        return Err(md("metadata version other than V15"));
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
        return Err(e("extrinsic format other than v4"));
    }
    if !r.is_multiaddress(x.address_ty.id) {
        return Err(e("unexpected address type (MultiAddress expected)"));
    }
    if !(r.path_is(x.signature_ty.id, &["sp_runtime", "MultiSignature"])
        && r.has_variant(x.signature_ty.id, "Sr25519", MULTISIG_SR25519, |f| {
            r.is_bytes(f, 64)
        }))
    {
        return Err(e(
            "unexpected signature type (MultiSignature::Sr25519 expected)",
        ));
    }

    // System: spec name and versions, SS58 prefix, System.Account layout.
    let system = m
        .pallets
        .iter()
        .find(|p| p.name == "System")
        .ok_or_else(|| e("System pallet missing"))?;
    let constant = |p: &frame_metadata::v15::PalletMetadata<PortableForm>, name: &str| {
        p.constants
            .iter()
            .find(|c| c.name == name)
            .map(|c| c.value.clone())
            .ok_or_else(|| e(&format!("constant {}.{name} missing", p.name)))
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
        .map_err(|_| e("System.Version unreadable"))?;
    if spec_name != chain.spec_name {
        return Err(e(&format!(
            "runtime \"{}\" instead of \"{}\": this node is not {}",
            crate::display::sanitize_text(&spec_name, 40).text,
            chain.spec_name,
            chain.name
        )));
    }
    let ss58 = u16::decode_all(&mut &constant(system, "SS58Prefix")?[..])
        .map_err(|_| e("System.SS58Prefix unreadable"))?;
    if ss58 != u16::from(chain.ss58) {
        return Err(e("SS58 prefix differs from the expected one"));
    }
    check_account_layout(&r, system).map_err(|s| e(&s))?;

    // Balances: pallet index, transfer_keep_alive index and arguments, existential deposit.
    let balances = m
        .pallets
        .iter()
        .find(|p| p.name == "Balances")
        .ok_or_else(|| e("Balances pallet missing"))?;
    if balances.index != chain.balances_pallet {
        return Err(e(&format!(
            "Balances pallet index {} instead of {}: Kyro must be updated",
            balances.index, chain.balances_pallet
        )));
    }
    let calls = balances
        .calls
        .as_ref()
        .ok_or_else(|| e("Balances without calls"))?;
    let TypeDef::Variant(v) = r.def(calls.ty.id)? else {
        return Err(e("Balances calls unreadable"));
    };
    let call = v
        .variants
        .iter()
        .find(|c| c.name == "transfer_keep_alive")
        .ok_or_else(|| e("Balances.transfer_keep_alive missing"))?;
    if call.index != chain.transfer_keep_alive {
        return Err(e(&format!(
            "transfer_keep_alive index {} instead of {}: Kyro must be updated",
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
            "unexpected transfer_keep_alive arguments (dest: MultiAddress, value: Compact<u128>)",
        ));
    }
    let existential_deposit = u128::decode_all(&mut &constant(balances, "ExistentialDeposit")?[..])
        .map_err(|_| e("Balances.ExistentialDeposit unreadable"))?;
    let assets = check_assets(chain, &r, m);

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
                "unknown or unexpectedly shaped transaction extension \"{}\": Kyro must be updated",
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
            return Err(e(&format!("extension {required:?} missing or duplicated")));
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
        return Err(e("unexpected fee payment extensions"));
    }
    Ok(DotRuntime {
        network: chain.network,
        spec_version,
        tx_version,
        existential_deposit,
        extensions,
        assets,
    })
}

fn check_assets(
    chain: &'static DotChain,
    r: &Reg<'_>,
    m: &RuntimeMetadataV15,
) -> core::result::Result<(), String> {
    use frame_metadata::v15::{StorageEntryType, StorageHasher};
    let p = m
        .pallets
        .iter()
        .find(|p| p.name == "Assets")
        .ok_or("Assets pallet missing")?;
    if p.index != chain.assets_pallet {
        return Err(format!(
            "Assets pallet index {} instead of {}",
            p.index, chain.assets_pallet
        ));
    }
    let calls = p.calls.as_ref().ok_or("Assets without calls")?;
    let Ok(TypeDef::Variant(v)) = r.def(calls.ty.id) else {
        return Err("Assets calls unreadable".into());
    };
    let call = v
        .variants
        .iter()
        .find(|c| c.name == "transfer_keep_alive")
        .ok_or("Assets.transfer_keep_alive missing")?;
    if call.index != chain.assets_transfer_keep_alive {
        return Err(format!(
            "Assets.transfer_keep_alive index {} instead of {}",
            call.index, chain.assets_transfer_keep_alive
        ));
    }
    let args: Vec<(Option<&str>, u32)> = call
        .fields
        .iter()
        .map(|f| (f.name.as_deref(), f.ty.id))
        .collect();
    if !matches!(args.as_slice(),
        [(Some("id"), i), (Some("target"), t), (Some("amount"), a)]
            if r.is_compact_of(*i, TypeDefPrimitive::U32)
                && r.is_multiaddress(*t)
                && r.is_compact_of(*a, TypeDefPrimitive::U128))
    {
        return Err("unexpected Assets.transfer_keep_alive arguments".into());
    }
    let storage = p.storage.as_ref().ok_or("Assets without storage")?;
    let entry = |name: &str| {
        storage
            .entries
            .iter()
            .find(|e| e.name == name)
            .ok_or(format!("Assets.{name} missing"))
    };
    let map = |name: &str, n: usize| -> core::result::Result<u32, String> {
        let StorageEntryType::Map { hashers, value, .. } = &entry(name)?.ty else {
            return Err(format!("Assets.{name} is not a map"));
        };
        if hashers.len() != n
            || !hashers
                .iter()
                .all(|h| *h == StorageHasher::Blake2_128Concat)
        {
            return Err(format!("unexpected Assets.{name} key"));
        }
        Ok(value.id)
    };
    let names = |id: u32| -> Vec<&str> {
        r.fields(id)
            .map(|f| f.iter().map(|x| x.0).collect())
            .unwrap_or_default()
    };
    // Account: (asset, account) → { balance: u128, status: Liquid | Frozen | Blocked, … }.
    let acc = map("Account", 2)?;
    let f = r.fields(acc).ok_or("Assets.Account unreadable")?;
    if names(acc) != ["balance", "status", "reason", "extra"]
        || !r.is_prim(f[0].1, TypeDefPrimitive::U128)
        || !(r.has_unit_variant(f[1].1, "Liquid", 0)
            && r.has_unit_variant(f[1].1, "Frozen", 1)
            && r.has_unit_variant(f[1].1, "Blocked", 2))
    {
        return Err("unexpected AssetAccount".into());
    }
    // Asset: asset → AssetDetails (190 bytes, decoded by `dot_decode_asset_details`).
    let det = map("Asset", 1)?;
    let f = r.fields(det).ok_or("Assets.Asset unreadable")?;
    let want = [
        "owner",
        "issuer",
        "admin",
        "freezer",
        "supply",
        "deposit",
        "min_balance",
        "is_sufficient",
        "accounts",
        "sufficients",
        "approvals",
        "status",
    ];
    if names(det) != want
        || !f[..4].iter().all(|x| r.is_bytes(x.1, 32))
        || !f[4..7]
            .iter()
            .all(|x| r.is_prim(x.1, TypeDefPrimitive::U128))
        || !r.is_prim(f[7].1, TypeDefPrimitive::Bool)
        || !f[8..11]
            .iter()
            .all(|x| r.is_prim(x.1, TypeDefPrimitive::U32))
        || !r.has_unit_variant(f[11].1, "Live", 0)
    {
        return Err("unexpected AssetDetails".into());
    }
    // Metadata: asset → { deposit: u128, name, symbol: bytes, decimals: u8, is_frozen: bool }.
    let meta = map("Metadata", 1)?;
    let f = r.fields(meta).ok_or("Assets.Metadata unreadable")?;
    if names(meta) != ["deposit", "name", "symbol", "decimals", "is_frozen"]
        || !r.is_prim(f[0].1, TypeDefPrimitive::U128)
        || !r.is_prim(f[3].1, TypeDefPrimitive::U8)
        || !r.is_prim(f[4].1, TypeDefPrimitive::Bool)
    {
        return Err("unexpected AssetMetadata".into());
    }
    Ok(())
}

fn check_account_layout(
    r: &Reg<'_>,
    system: &frame_metadata::v15::PalletMetadata<PortableForm>,
) -> core::result::Result<(), String> {
    use frame_metadata::v15::{StorageEntryType, StorageHasher};
    let entry = system
        .storage
        .as_ref()
        .and_then(|s| s.entries.iter().find(|e| e.name == "Account"))
        .ok_or("System.Account missing")?;
    let StorageEntryType::Map {
        hashers,
        key,
        value,
    } = &entry.ty
    else {
        return Err("System.Account is not a map".into());
    };
    if !matches!(hashers.as_slice(), [StorageHasher::Blake2_128Concat]) || !r.is_bytes(key.id, 32) {
        return Err("unexpected System.Account key".into());
    }
    let info = r.fields(value.id).ok_or("System.Account unreadable")?;
    let names: Vec<&str> = info.iter().map(|f| f.0).collect();
    if names != ["nonce", "consumers", "providers", "sufficients", "data"]
        || !info[..4]
            .iter()
            .all(|f| r.is_prim(f.1, TypeDefPrimitive::U32))
    {
        return Err("unexpected AccountInfo".into());
    }
    let data = r.fields(info[4].1).ok_or("AccountData unreadable")?;
    let names: Vec<&str> = data.iter().map(|f| f.0).collect();
    if names != ["free", "reserved", "frozen", "flags"] || !data.iter().all(|f| r.is_u128ish(f.1)) {
        return Err("unexpected AccountData".into());
    }
    Ok(())
}

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

const ASSETS_PREFIX: [u8; 16] = h16(b"682a59d51ab9e48a8c8cc418ff9708d2");
const ASSETS_ACCOUNT: [u8; 16] = h16(b"b99d880ec681799c0cf30e8886371da9");
const ASSETS_ASSET: [u8; 16] = h16(b"d34371a193a751eea5883e9553457b2e");
const ASSETS_METADATA: [u8; 16] = h16(b"b5f3822e35ca2f31ce3526eab1363fd2");

const fn h16(s: &[u8; 32]) -> [u8; 16] {
    let mut wide = [0u8; 64];
    let mut i = 0;
    while i < 32 {
        wide[i] = s[i];
        wide[32 + i] = b'0';
        i += 1;
    }
    let full = h32(&wide);
    let mut out = [0u8; 16];
    let mut j = 0;
    while j < 16 {
        out[j] = full[j];
        j += 1;
    }
    out
}

fn blake2_128_concat(o: &mut Vec<u8>, data: &[u8]) {
    o.extend_from_slice(&blake2_128(data));
    o.extend_from_slice(data);
}

fn assets_key(item: &[u8; 16], asset: u32, account: Option<&[u8; 32]>) -> Vec<u8> {
    let mut k = Vec::with_capacity(32 + 20 + 48);
    k.extend_from_slice(&ASSETS_PREFIX);
    k.extend_from_slice(item);
    blake2_128_concat(&mut k, &asset.to_le_bytes());
    if let Some(a) = account {
        blake2_128_concat(&mut k, a);
    }
    k
}

/// Storage key of `Assets.Account(asset, account)`.
pub fn dot_asset_account_key(asset: u32, account: &[u8; 32]) -> Vec<u8> {
    assets_key(&ASSETS_ACCOUNT, asset, Some(account))
}

/// Storage key of `Assets.Asset(asset)`.
pub fn dot_asset_details_key(asset: u32) -> Vec<u8> {
    assets_key(&ASSETS_ASSET, asset, None)
}

/// Storage key of `Assets.Metadata(asset)`.
pub fn dot_asset_metadata_key(asset: u32) -> Vec<u8> {
    assets_key(&ASSETS_METADATA, asset, None)
}

/// Our holding of an asset (`Assets.Account`; absent = no holding, balance 0).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DotAssetAccount {
    /// Base units.
    pub balance: u128,
    /// Frozen or blocked by the issuer: cannot send (blocked: cannot receive either).
    pub frozen: bool,
    /// Blocked by the issuer: can neither send nor receive.
    pub blocked: bool,
}

/// Decodes an `Assets.Account` value (`balance: u128`, `status: u8`, reason; see [`dot_runtime`]).
pub fn dot_decode_asset_account(bytes: &[u8]) -> Result<DotAssetAccount> {
    if bytes.len() < 18 {
        return Err(Error::input("Assets.Account too short"));
    }
    let mut b = [0u8; 16];
    b.copy_from_slice(&bytes[..16]);
    let status = bytes[16];
    if status > 2 {
        return Err(Error::input("Assets.Account: unknown status"));
    }
    Ok(DotAssetAccount {
        balance: u128::from_le_bytes(b),
        frozen: status == 1,
        blocked: status == 2,
    })
}

/// What `Assets.Asset` says of an asset (190-byte `AssetDetails`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DotAssetDetails {
    /// Smallest balance an account may hold (below it the holding is removed).
    pub min_balance: u128,
    /// The asset alone can keep an account alive (no DOT needed to receive it).
    pub is_sufficient: bool,
    /// `Live` (otherwise frozen or being destroyed: transfers fail).
    pub live: bool,
}

/// Decodes an `Assets.Asset` value (layout checked by [`dot_runtime`]).
pub fn dot_decode_asset_details(bytes: &[u8]) -> Result<DotAssetDetails> {
    if bytes.len() != 190 {
        return Err(Error::input("Assets.Asset: 190 bytes expected"));
    }
    let mut mb = [0u8; 16];
    mb.copy_from_slice(&bytes[160..176]);
    let suff = bytes[176];
    if suff > 1 || bytes[189] > 2 {
        return Err(Error::input("Assets.Asset unreadable"));
    }
    Ok(DotAssetDetails {
        min_balance: u128::from_le_bytes(mb),
        is_sufficient: suff == 1,
        live: bytes[189] == 0,
    })
}

/// `(symbol, decimals)` of an `Assets.Metadata` value.
pub fn dot_decode_asset_metadata(bytes: &[u8]) -> Result<(String, u8)> {
    let bad_md = || Error::input("Assets.Metadata unreadable");
    let (_deposit, _name, symbol, decimals, _frozen): (u128, Vec<u8>, Vec<u8>, u8, bool) =
        DecodeAll::decode_all(&mut &bytes[..]).map_err(|_| bad_md())?;
    let symbol = String::from_utf8(symbol).map_err(|_| bad_md())?;
    Ok((symbol, decimals))
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

    /// Spendable by `transfer_keep_alive`: `free − max(frozen − reserved, ED)`.
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
        .map_err(|_| Error::input("System.Account: 80 bytes expected"))?;
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

/// `partial_fee` (planck) of a `TransactionPaymentApi_query_info` `RuntimeDispatchInfo` result.
pub fn dot_decode_fee_info(bytes: &[u8]) -> Result<u128> {
    let (_rt, _ps, class, fee): (Compact<u64>, Compact<u64>, u8, u128) =
        DecodeAll::decode_all(&mut &bytes[..])
            .map_err(|_| Error::input("unreadable Polkadot fee response"))?;
    if class > 2 {
        return Err(Error::input("unexpected transaction class"));
    }
    Ok(fee)
}

/// Argument of `TransactionPaymentApi_query_info`: the extrinsic then its length (`u32`).
pub fn dot_fee_query_arg(extrinsic: &[u8]) -> Vec<u8> {
    let mut out = extrinsic.to_vec();
    out.extend_from_slice(&(extrinsic.len() as u32).to_le_bytes());
    out
}

/// A **mortal** era (`Era::Mortal`): valid from block `birth` for `period` blocks; never immortal.
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
                "immortal transaction (valid forever): Kyro signs only time-limited transactions",
            ));
        }
        let second = take(input, 1)?[0];
        let encoded = u64::from(first) | (u64::from(second) << 8);
        let period = 2u64 << (encoded % (1 << 4));
        let q = (period >> 12).max(1);
        let phase = (encoded >> 4) * q;
        if period < 4 || phase >= period {
            return Err(bad("invalid era"));
        }
        Ok(DotEra { period, phase })
    }
}

fn take<'a>(input: &mut &'a [u8], n: usize) -> Result<&'a [u8]> {
    if input.len() < n {
        return Err(bad("truncated data"));
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
        .map_err(|_| bad("invalid compact integer"))
}

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
    /// `Some(id)`: `Assets.transfer_keep_alive` of that known asset (`value` in its units).
    pub asset: Option<u32>,
}

impl DotTransfer {
    /// `[pallet, call] ‖ (Compact(asset id) ‖)? MultiAddress::Id(dest) ‖ Compact(value)`.
    pub fn call(&self, rt: &DotRuntime) -> Vec<u8> {
        let c = rt.chain();
        let mut o = match self.asset {
            None => vec![c.balances_pallet, c.transfer_keep_alive],
            Some(id) => {
                let mut o = vec![c.assets_pallet, c.assets_transfer_keep_alive];
                Compact(id).encode_to(&mut o);
                o
            }
        };
        o.push(MULTIADDRESS_ID);
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

fn decode_call(rt: &DotRuntime, input: &mut &[u8]) -> Result<(Option<u32>, [u8; 32], u128)> {
    let c = rt.chain();
    let head = take(input, 2)?;
    let asset = if head == [c.balances_pallet, c.transfer_keep_alive] {
        None
    } else if head == [c.assets_pallet, c.assets_transfer_keep_alive] {
        if let Err(why) = &rt.assets {
            return Err(bad(format!(
                "Assets pallet differs from what Kyro knows ({why}): Kyro must be updated"
            )));
        }
        let id = Compact::<u32>::decode(input)
            .map_err(|_| bad("invalid asset id"))?
            .0;
        if dot_known_asset(rt.network, id).is_none() {
            return Err(bad(format!(
                "unknown asset {id}: Kyro signs only the verified tokens of its table"
            )));
        }
        Some(id)
    } else {
        return Err(bad(format!(
            "call {:02x}{:02x}: only Balances.transfer_keep_alive ({:02x}{:02x}) and Assets.transfer_keep_alive ({:02x}{:02x}) are accepted",
            head[0], head[1], c.balances_pallet, c.transfer_keep_alive, c.assets_pallet, c.assets_transfer_keep_alive
        )));
    };
    if take(input, 1)?[0] != MULTIADDRESS_ID {
        return Err(bad("recipient other than an account (MultiAddress::Id)"));
    }
    let dest = take32(input)?;
    let value = compact_u128(input)?;
    Ok((asset, dest, value))
}

fn decode_extra(rt: &DotRuntime, input: &mut &[u8]) -> Result<(DotEra, u32, u128)> {
    let (mut era, mut nonce, mut tip) = (None, None, 0u128);
    for e in &rt.extensions {
        match e {
            DotExtension::Mortality => era = Some(DotEra::decode(input)?),
            DotExtension::Nonce => {
                nonce = Some(
                    Compact::<u32>::decode(input)
                        .map_err(|_| bad("invalid nonce"))?
                        .0,
                )
            }
            DotExtension::ChargeAssetTxPayment => {
                tip = compact_u128(input)?;
                if take(input, 1)?[0] != 0 {
                    return Err(bad(
                        "fees paid in an asset other than the native token: refused",
                    ));
                }
            }
            DotExtension::ChargeTransactionPayment => tip = compact_u128(input)?,
            DotExtension::MetadataHash => {
                if take(input, 1)?[0] != 0 {
                    return Err(bad("CheckMetadataHash enabled: Kyro does not use it"));
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
        _ => Err(bad("incomplete extensions")),
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
                        "spec_version differs from the current runtime: rebuild",
                    ));
                }
            }
            DotExtension::TxVersion => {
                if u32_at(input)? != rt.tx_version {
                    return Err(bad(
                        "transaction_version differs from the current runtime: rebuild",
                    ));
                }
            }
            DotExtension::Genesis => {
                if take32(input)? != rt.chain().genesis {
                    return Err(bad(format!(
                        "genesis of a chain other than {}",
                        rt.chain().name
                    )));
                }
            }
            DotExtension::Mortality => block = Some(take32(input)?),
            DotExtension::MetadataHash => {
                if take(input, 1)?[0] != 0 {
                    return Err(bad("unexpected metadata hash"));
                }
            }
            DotExtension::NoData
            | DotExtension::Nonce
            | DotExtension::ChargeAssetTxPayment
            | DotExtension::ChargeTransactionPayment => {}
        }
    }
    block.ok_or_else(|| bad("block hash missing"))
}

fn check_transfer(t: &DotTransfer, from: &[u8; 32]) -> Result<()> {
    if t.asset
        .is_some_and(|id| !POLKADOT_ASSETS.iter().any(|a| a.id == id))
    {
        return Err(bad("unknown asset"));
    }
    if t.value == 0 {
        return Err(bad("zero amount"));
    }
    if &t.dest == from {
        return Err(bad("transfer to yourself"));
    }
    if t.tip != 0 {
        return Err(bad("non-zero tip: Kyro never adds one"));
    }
    if t.era.period > 4096 {
        return Err(bad("validity period too long (more than 4096 blocks)"));
    }
    Ok(())
}

/// Decodes a signing payload into a transfer, refusing what Kyro would not build.
pub fn dot_parse_payload(rt: &DotRuntime, payload: &[u8], from: &[u8; 32]) -> Result<DotTransfer> {
    if payload.len() > MAX_RAW_PAYLOAD {
        return Err(bad("signing payload too long for a transfer"));
    }
    let mut input = payload;
    let (asset, dest, value) = decode_call(rt, &mut input)?;
    let (era, nonce, tip) = decode_extra(rt, &mut input)?;
    let block_hash = decode_additional(rt, &mut input)?;
    if !input.is_empty() {
        return Err(bad("trailing bytes"));
    }
    let t = DotTransfer {
        dest,
        value,
        era,
        block_hash,
        nonce,
        tip,
        asset,
    };
    if t.payload(rt) != payload {
        return Err(bad("non-canonical encoding (re-encoding differs)"));
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
    /// Token transfer (`Assets.transfer_keep_alive`): amount/symbol/decimals are the token's.
    #[serde(default)]
    pub asset: Option<DotAssetSummary>,
}

/// The token of an asset transfer, as Kyro's table knows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DotAssetSummary {
    /// Verified asset id (pallet Assets).
    pub asset_id: u32,
    /// Symbol (Kyro's table).
    pub symbol: String,
    /// Name (Kyro's table).
    pub name: String,
    /// Decimals (Kyro's table).
    pub decimals: u8,
}

fn summarize(rt: &DotRuntime, t: &DotTransfer, from: &[u8; 32]) -> DotTxSummary {
    let c = rt.chain();
    let known = t.asset.and_then(|id| dot_known_asset(rt.network, id));
    DotTxSummary {
        chain: c.name.into(),
        from: dot_ss58_encode(from, c.ss58),
        to: dot_ss58_encode(&t.dest, c.ss58),
        amount: t.value.to_string(),
        symbol: known.map_or(c.symbol, |k| k.symbol).into(),
        decimals: known.map_or(c.decimals, |k| k.decimals),
        call: if known.is_some() {
            "Assets.transfer_keep_alive"
        } else {
            "Balances.transfer_keep_alive"
        }
        .into(),
        nonce: t.nonce,
        tip: t.tip.to_string(),
        era_period: t.era.period,
        era_phase: t.era.phase,
        block_hash: hex::encode(t.block_hash),
        spec_version: rt.spec_version,
        tx_version: rt.tx_version,
        asset: known.map(|k| DotAssetSummary {
            asset_id: k.id,
            symbol: k.symbol.into(),
            name: k.name.into(),
            decimals: k.decimals,
        }),
    }
}

/// Builds the signing payload (hex) of a transfer from `from` (refused like [`dot_decode_payload`]).
pub fn dot_transfer_payload(rt: &DotRuntime, t: &DotTransfer, from: &[u8; 32]) -> Result<String> {
    check_transfer(t, from)?;
    Ok(hex::encode(t.payload(rt)))
}

/// Decodes a signing payload (hex) for the dialog.
pub fn dot_decode_payload(
    rt: &DotRuntime,
    payload_hex: &str,
    from: &[u8; 32],
) -> Result<DotTxSummary> {
    let raw = hex::decode(payload_hex.trim()).map_err(|_| bad("hexadecimal expected"))?;
    let t = dot_parse_payload(rt, &raw, from)?;
    Ok(summarize(rt, &t, from))
}

/// Payload's extrinsic with a zero signature, only for `query_info` (fees ignore the signature).
pub fn dot_fee_probe_extrinsic(
    rt: &DotRuntime,
    payload_hex: &str,
    from: &[u8; 32],
) -> Result<Vec<u8>> {
    let raw = hex::decode(payload_hex.trim()).map_err(|_| bad("hexadecimal expected"))?;
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

/// Signs a payload (hex) with `account`, after decoding it like [`dot_decode_payload`].
pub fn dot_sign(
    root: &PolkadotRoot,
    account: u32,
    rt: &DotRuntime,
    payload_hex: &str,
) -> Result<(String, String, DotTxSummary)> {
    let kp = root.keypair(account)?;
    let from = kp.public.to_bytes();
    let raw = hex::decode(payload_hex.trim()).map_err(|_| bad("hexadecimal expected"))?;
    let t = dot_parse_payload(rt, &raw, &from)?;
    let ctx = schnorrkel::signing_context(SIGNING_CTX);
    let sig = kp.sign(ctx.bytes(&signing_message(&raw))).to_bytes();
    drop(kp);
    let ext = t.extrinsic(rt, &from, &sig);
    let (signer, hash, summary) = dot_verify_extrinsic(rt, &hex::encode(&ext), &t.block_hash)?;
    if signer != from || summary != summarize(rt, &t, &from) {
        return Err(Error::crypto("inconsistent signed extrinsic"));
    }
    Ok((hex::encode(ext), hash, summary))
}

/// Decodes a signed extrinsic and checks its sr25519 signature (`block_hash` = era birth block)
pub fn dot_verify_extrinsic(
    rt: &DotRuntime,
    extrinsic_hex: &str,
    block_hash: &[u8; 32],
) -> Result<([u8; 32], String, DotTxSummary)> {
    let raw =
        Zeroizing::new(hex::decode(extrinsic_hex.trim()).map_err(|_| bad("hexadecimal expected"))?);
    if raw.len() > MAX_EXTRINSIC {
        return Err(bad("extrinsic too long"));
    }
    let mut input = &raw[..];
    let len = Compact::<u32>::decode(&mut input)
        .map_err(|_| bad("invalid length"))?
        .0 as usize;
    if len != input.len() {
        return Err(bad("declared length differs"));
    }
    let head = take(&mut input, 2)?;
    if head != [EXTRINSIC_V4_SIGNED, MULTIADDRESS_ID] {
        return Err(bad("v4 extrinsic signed by an account expected"));
    }
    let signer = take32(&mut input)?;
    if take(&mut input, 1)?[0] != MULTISIG_SR25519 {
        return Err(bad("signature other than sr25519"));
    }
    let mut sig = [0u8; 64];
    sig.copy_from_slice(take(&mut input, 64)?);
    let (era, nonce, tip) = decode_extra(rt, &mut input)?;
    let (asset, dest, value) = decode_call(rt, &mut input)?;
    if !input.is_empty() {
        return Err(bad("trailing bytes"));
    }
    let t = DotTransfer {
        dest,
        value,
        era,
        block_hash: *block_hash,
        nonce,
        tip,
        asset,
    };
    check_transfer(&t, &signer)?;
    if t.extrinsic(rt, &signer, &sig) != *raw {
        return Err(bad("non-canonical encoding (re-encoding differs)"));
    }
    let public = PublicKey::from_bytes(&signer).map_err(|_| bad("invalid public key"))?;
    let signature = Signature::from_bytes(&sig).map_err(|_| bad("malformed signature"))?;
    let ctx = schnorrkel::signing_context(SIGNING_CTX);
    public
        .verify(ctx.bytes(&signing_message(&t.payload(rt))), &signature)
        .map_err(|_| {
            bad("invalid signature for this runtime, block and account (nothing is broadcast)")
        })?;
    Ok((
        signer,
        hex::encode(dot_blake2_256(&raw)),
        summarize(rt, &t, &signer),
    ))
}
