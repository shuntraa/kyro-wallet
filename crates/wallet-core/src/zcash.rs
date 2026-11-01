//! Zcash, **transparent addresses only** (`t1…` P2PKH / `t3…` P2SH; testnet `tm…` / `t2…`).
//!
//! Shielded addresses (Sapling `zs…`, Sprout `zc…`, unified `u1…`) are refused with an explicit
//! message: Kyro neither builds nor reads shielded parts. A transparent Zcash address is as
//! public as a Bitcoin one (amounts, counterparties and history are visible on chain).
//!
//! What comes from where (no cryptography is written here):
//! - keys: BIP44 `m/44'/133'/account'/change/index` (testnet coin type 1, as zcashd), derived
//!   with rust-bitcoin's BIP32 and signed with libsecp256k1 (the `bitcoin` crate), keys wiped by
//!   [`XprivGuard`]; addresses are base58check with Zcash's two-byte prefixes
//!   (`zcash_protocol` constants, protocol spec §5.6.1.1);
//! - transaction format, parsing, ZIP-244 transaction id and **signature digest**, consensus
//!   branch ids and activation heights, ZIP-317 fee: the official librustzcash crates
//!   (`zcash_primitives`, `zcash_transparent`, `zcash_protocol`).
//!
//! Kyro **builds the transaction itself** (v5, ZIP 225): the shell supplies the previous
//! transactions of our coins (each one parsed and re-hashed here: its txid must be the
//! outpoint's), the recipient, the amount, the change index, the chain tip and the consensus
//! branch id read from a recent block. Rust selects the coins, computes the ZIP-317 fee, sends
//! the change to our own derived address, and refuses to sign for a branch id it does not know
//! or that does not match its own activation table (a network upgrade this build does not know:
//! signing would produce an invalid transaction).
//!
//! ZIP 244 commits to the amount and script of **every** transparent input, so a server lying
//! about a coin's value cannot change what the signature means (the network would reject it);
//! amounts still come only from the verified previous transactions.

use core::str::FromStr;
use std::io::Cursor;

use bitcoin::bech32::{primitives::decode::CheckedHrpstring, Bech32m};
use bitcoin::bip32::{ChildNumber, Fingerprint, Xpub};
use bitcoin::hashes::{hash160, Hash};
use bitcoin::script::PushBytesBuf;
use bitcoin::secp256k1::{All, Message, PublicKey, Secp256k1};
use serde::{Deserialize, Serialize};
use zcash_primitives::transaction::fees::transparent::InputSize;
use zcash_primitives::transaction::fees::{zip317, FeeRule as _};
use zcash_primitives::transaction::sighash::{signature_hash, SignableInput};
use zcash_primitives::transaction::txid::{to_txid, TxIdDigester};
use zcash_primitives::transaction::TxVersion;
use zcash_primitives::transaction::{Authorization, Authorized, Transaction, TransactionData};
use zcash_protocol::consensus::{BlockHeight, BranchId, Network as ZcashNetwork, NetworkUpgrade};
use zcash_protocol::value::Zatoshis;
use zcash_transparent::address::Script;
use zcash_transparent::bundle::{self as tbundle, Bundle, OutPoint, TxIn, TxOut};
use zcash_transparent::sighash::{
    SighashType, SignableInput as TransparentSignable, TransparentAuthorizingContext,
};

use crate::btc::MAX_CHANGE_INDEX;
use crate::error::{Error, Result};
use crate::keys::{hardened, normal, path_string, secp, XprivGuard};
use crate::mnemonic::Seed;
use crate::network::Network;

/// ZIP 203: default number of blocks after which an unmined transaction expires (≈ 50 min at
/// 75 s per block).
pub const ZEC_EXPIRY_DELTA: u32 = 40;
/// Smallest output the nodes relay (zcashd `GetDustThreshold` with the 100 zatoshis/kB relay
/// fee: 3 × (34 + 148) × 100 / 1000 = 54 zatoshis for a P2PKH output).
pub const ZEC_DUST: u64 = 54;
/// A change smaller than this (ZIP 317 marginal fee, 0.00005 ZEC) is added to the fee instead
/// of creating an output that would cost more to spend than it is worth.
pub const ZEC_MIN_CHANGE: u64 = 5_000;
/// Most inputs one transaction spends (the ZIP-317 fee grows with each one).
pub const ZEC_MAX_INPUTS: usize = 50;

// ---------------------------------------------------------------------------------------------
// Network parameters
// ---------------------------------------------------------------------------------------------

fn params(net: Network) -> ZcashNetwork {
    match net {
        Network::Mainnet => ZcashNetwork::MainNetwork,
        Network::Testnet => ZcashNetwork::TestNetwork,
    }
}

/// SLIP-44 coin type: 133 on mainnet, 1 on testnet (zcashd's own convention).
fn coin_type(net: Network) -> u32 {
    match net {
        Network::Mainnet => 133,
        Network::Testnet => 1,
    }
}

#[allow(deprecated)] // constants moved to `zcash_address`; same values (protocol spec §5.6.1.1)
fn prefixes(net: Network) -> ([u8; 2], [u8; 2], &'static str) {
    use zcash_protocol::constants::{mainnet, testnet};
    match net {
        Network::Mainnet => (
            mainnet::B58_PUBKEY_ADDRESS_PREFIX,
            mainnet::B58_SCRIPT_ADDRESS_PREFIX,
            mainnet::HRP_TEX_ADDRESS,
        ),
        Network::Testnet => (
            testnet::B58_PUBKEY_ADDRESS_PREFIX,
            testnet::B58_SCRIPT_ADDRESS_PREFIX,
            testnet::HRP_TEX_ADDRESS,
        ),
    }
}

/// Genesis block hash (display order) of Zcash mainnet / testnet.
pub fn zec_genesis_hash(net: Network) -> &'static str {
    match net {
        Network::Mainnet => "00040fe8ec8471911baa1db1266ea15dd06b4a8a5c453883c000b031973dce08",
        Network::Testnet => "05a60a92d99d85997cce3b87616c089f6124d7342af37106edc76126334a2c38",
    }
}

// ---------------------------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------------------------

/// Kind of a Zcash destination Kyro can pay.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ZecAddressKind {
    /// `t1…` / `tm…`: pay to public key hash.
    P2pkh,
    /// `t3…` / `t2…`: pay to script hash.
    P2sh,
    /// `tex1…` (ZIP 320): a P2PKH address that only accepts funds from transparent inputs
    /// (exchanges). Kyro's transactions are fully transparent, so it can pay it.
    Tex,
}

fn base58(prefix: [u8; 2], hash: &[u8]) -> String {
    let mut data = Vec::with_capacity(22);
    data.extend_from_slice(&prefix);
    data.extend_from_slice(hash);
    bitcoin::base58::encode_check(&data)
}

fn p2pkh_script(hash: &[u8; 20]) -> Vec<u8> {
    let mut s = Vec::with_capacity(25);
    s.extend_from_slice(&[0x76, 0xa9, 0x14]);
    s.extend_from_slice(hash);
    s.extend_from_slice(&[0x88, 0xac]);
    s
}

fn p2sh_script(hash: &[u8; 20]) -> Vec<u8> {
    let mut s = Vec::with_capacity(23);
    s.extend_from_slice(&[0xa9, 0x14]);
    s.extend_from_slice(hash);
    s.push(0x87);
    s
}

/// Message for an address Kyro will never pay (shielded or unified).
const SHIELDED_REFUSED: &str =
    "adresse Zcash protégée (zs…, zc…) ou unifiée (u1…) : pas encore prise en charge. Kyro n'envoie qu'à des adresses transparentes (t1…, t3…, tex1…)";

fn is_shielded_form(a: &str) -> bool {
    let l = a.to_ascii_lowercase();
    ["zs1", "ztestsapling1", "u1", "utest1", "uregtest1", "zregtestsapling1"]
        .iter()
        .any(|p| l.starts_with(p))
        // Sprout: base58 `zc…` (mainnet) / `zt…` (testnet), 70 bytes once decoded.
        || ((a.starts_with("zc") || a.starts_with("zt"))
            && bitcoin::base58::decode_check(a).is_ok_and(|d| d.len() == 66))
}

/// What a destination address pays: its scriptPubKey and kind. Accepts `t1…`/`t3…` (testnet
/// `tm…`/`t2…`) and ZIP-320 `tex1…` (`textest1…`). Refuses shielded and unified addresses with
/// an explicit message, the other network's addresses, and anything else.
pub fn zec_parse_address(address: &str, net: Network) -> Result<(Vec<u8>, ZecAddressKind)> {
    let a = address.trim();
    if a.is_empty() {
        return Err(Error::input("adresse Zcash vide"));
    }
    if is_shielded_form(a) {
        return Err(Error::input(SHIELDED_REFUSED));
    }
    let (p2pkh, p2sh, tex) = prefixes(net);
    let other = || Error::input("adresse Zcash d'un autre réseau");
    let lower = a.to_ascii_lowercase();
    if lower.starts_with("tex1") || lower.starts_with("textest1") {
        let decoded = CheckedHrpstring::new::<Bech32m>(a)
            .map_err(|_| Error::input("adresse TEX invalide (ZIP 320)"))?;
        if decoded.hrp().to_lowercase() != tex {
            return Err(other());
        }
        let data: Vec<u8> = decoded.byte_iter().collect();
        let hash: [u8; 20] = data
            .as_slice()
            .try_into()
            .map_err(|_| Error::input("adresse TEX invalide (ZIP 320)"))?;
        return Ok((p2pkh_script(&hash), ZecAddressKind::Tex));
    }
    let raw =
        bitcoin::base58::decode_check(a).map_err(|_| Error::input("adresse Zcash invalide"))?;
    if raw.len() != 22 {
        return Err(Error::input("adresse Zcash invalide"));
    }
    let mut hash = [0u8; 20];
    hash.copy_from_slice(&raw[2..]);
    let prefix = [raw[0], raw[1]];
    if prefix == p2pkh {
        Ok((p2pkh_script(&hash), ZecAddressKind::P2pkh))
    } else if prefix == p2sh {
        Ok((p2sh_script(&hash), ZecAddressKind::P2sh))
    } else {
        let (o1, o2, _) = prefixes(match net {
            Network::Mainnet => Network::Testnet,
            Network::Testnet => Network::Mainnet,
        });
        if prefix == o1 || prefix == o2 {
            Err(other())
        } else {
            Err(Error::input("adresse Zcash invalide"))
        }
    }
}

/// scriptPubKey of a destination address (see [`zec_parse_address`]).
pub fn zec_script_pubkey(address: &str, net: Network) -> Result<Vec<u8>> {
    zec_parse_address(address, net).map(|(s, _)| s)
}

/// `t…` address of a standard P2PKH / P2SH scriptPubKey, `None` for anything else.
pub fn zec_address_of_script(script: &[u8], net: Network) -> Option<String> {
    let (p2pkh, p2sh, _) = prefixes(net);
    match script {
        [0x76, 0xa9, 0x14, hash @ .., 0x88, 0xac] if hash.len() == 20 => Some(base58(p2pkh, hash)),
        [0xa9, 0x14, hash @ .., 0x87] if hash.len() == 20 => Some(base58(p2sh, hash)),
        _ => None,
    }
}

fn own_script(pk: &PublicKey) -> Vec<u8> {
    p2pkh_script(&hash160::Hash::hash(&pk.serialize()).to_byte_array())
}

fn own_address(net: Network, pk: &PublicKey) -> String {
    let (p2pkh, _, _) = prefixes(net);
    base58(p2pkh, &hash160::Hash::hash(&pk.serialize()).to_byte_array())
}

/// Public description of a Zcash account (watch-only data).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ZecAccount {
    /// Account-level extended public key (`xpub`/`tpub` encoding; the key material is what
    /// matters, Zcash has no registered prefix of its own).
    pub xpub: String,
    /// Master key fingerprint, 8 lowercase hex chars.
    pub fingerprint: String,
    /// Account path, `m/44'/133'/account'` (testnet `m/44'/1'/account'`).
    pub path: String,
}

fn account_path(net: Network, account: u32) -> Result<[ChildNumber; 3]> {
    Ok([hardened(44)?, hardened(coin_type(net))?, hardened(account)?])
}

fn account_xpub(
    secp: &Secp256k1<All>,
    seed: &Seed,
    net: Network,
    account: u32,
) -> Result<(Xpub, Fingerprint, [ChildNumber; 3])> {
    let path = account_path(net, account)?;
    let master = XprivGuard::master(seed, net.btc_kind())?;
    let acct = master.derive(secp, &path)?;
    Ok((
        Xpub::from_priv(secp, acct.xpriv()),
        master.fingerprint(secp),
        path,
    ))
}

fn child_pubkey(xpub: &Xpub, change: bool, index: u32) -> Result<PublicKey> {
    let secp = Secp256k1::verification_only();
    Ok(xpub
        .derive_pub(&secp, &[normal(u32::from(change))?, normal(index)?])
        .map_err(|_| Error::crypto("public derivation failed"))?
        .public_key)
}

/// Account descriptor for `m/44'/133'/account'`.
pub fn zec_account(seed: &Seed, net: Network, account: u32) -> Result<ZecAccount> {
    let secp = secp()?;
    let (xpub, fingerprint, path) = account_xpub(&secp, seed, net, account)?;
    Ok(ZecAccount {
        xpub: xpub.to_string(),
        fingerprint: fingerprint.to_string(),
        path: path_string(&path),
    })
}

/// Transparent address at `m/44'/133'/account'/change/index` (`change` = internal chain 1).
pub fn zec_address(
    seed: &Seed,
    net: Network,
    account: u32,
    change: bool,
    index: u32,
) -> Result<String> {
    let secp = secp()?;
    let (xpub, _, _) = account_xpub(&secp, seed, net, account)?;
    Ok(own_address(net, &child_pubkey(&xpub, change, index)?))
}

/// Address at `<account xpub>/change/index` (public derivation only), same result as
/// [`zec_address`]. Accepts `xpub`/`tpub` only.
pub fn zec_address_from_xpub(xpub: &str, net: Network, change: bool, index: u32) -> Result<String> {
    let xpub = Xpub::from_str(xpub.trim()).map_err(|_| Error::input("xpub de compte invalide"))?;
    if xpub.network != net.btc_kind() {
        return Err(Error::input("xpub d'un autre réseau"));
    }
    Ok(own_address(net, &child_pubkey(&xpub, change, index)?))
}

// ---------------------------------------------------------------------------------------------
// Raw transactions
// ---------------------------------------------------------------------------------------------

/// The transparent view of a Zcash transaction (any version), for the backend and history.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ZecRawTx {
    /// Transaction id, display order (ZIP 244 for v5+, double SHA-256 before).
    pub txid: String,
    /// Transaction version (1 to 6).
    pub version: u32,
    /// Consensus branch id written in the transaction (v5 and later).
    pub branch_id: Option<u32>,
    /// Spent transparent outpoints `(txid, vout)`; empty for a coinbase.
    pub inputs: Vec<(String, u32)>,
    /// Transparent outputs `(address if standard, zatoshis, scriptPubKey hex)`.
    pub outputs: Vec<(Option<String>, u64, String)>,
    /// The transaction also has shielded parts (Sprout, Sapling, Orchard…): value moves that
    /// Kyro does not see, so a transparent "fee" cannot be computed from it.
    pub shielded: bool,
    /// Coinbase transaction.
    pub coinbase: bool,
}

/// Consensus branch id written in a v5+ transaction header (bytes 8..12), read without parsing
/// the rest: it is how Kyro learns which network upgrade the chain is on, including one this
/// build does not know. `None` for v4 and earlier (no branch id in the encoding).
pub fn zec_header_branch_id(raw: &[u8]) -> Option<u32> {
    let word = |i: usize| -> Option<u32> {
        raw.get(i..i + 4)
            .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    };
    let header = word(0)?;
    let overwintered = header >> 31 == 1;
    (overwintered && (header & 0x7fff_ffff) >= 5)
        .then(|| word(8))
        .flatten()
}

fn parse_tx(raw: &[u8]) -> Result<Transaction> {
    let mut cur = Cursor::new(raw);
    // The branch id only matters for v4 and earlier (it is not in their encoding and only
    // feeds their sighash, never their txid); v5+ carry their own.
    let tx = Transaction::read(&mut cur, BranchId::Nu5)
        .map_err(|_| Error::input("transaction Zcash mal formée"))?;
    if cur.position() != raw.len() as u64 {
        return Err(Error::input(
            "transaction Zcash mal formée (octets en trop)",
        ));
    }
    Ok(tx)
}

fn view(tx: &Transaction, net: Network) -> ZecRawTx {
    let (inputs, outputs, coinbase) = match tx.transparent_bundle() {
        Some(b) => {
            let coinbase = b.is_coinbase();
            let inputs = if coinbase {
                Vec::new()
            } else {
                b.vin
                    .iter()
                    .map(|i| (i.prevout().txid().to_string(), i.prevout().n()))
                    .collect()
            };
            let outputs = b
                .vout
                .iter()
                .map(|o| {
                    let spk = &o.script_pubkey().0 .0;
                    (
                        zec_address_of_script(spk, net),
                        o.value().into_u64(),
                        hex::encode(spk),
                    )
                })
                .collect();
            (inputs, outputs, coinbase)
        }
        None => (Vec::new(), Vec::new(), false),
    };
    let version = tx.version().header() & 0x7fff_ffff;
    ZecRawTx {
        txid: tx.txid().to_string(),
        version,
        branch_id: (version >= 5).then(|| u32::from(tx.consensus_branch_id())),
        inputs,
        outputs,
        shielded: tx.sprout_bundle().is_some()
            || tx.sapling_bundle().is_some()
            || tx.orchard_bundle().is_some()
            || tx.ironwood_bundle().is_some(),
        coinbase,
    }
}

/// Decodes a consensus-serialized Zcash transaction (hex) of any version; fails on malformed
/// data and trailing bytes. The txid is recomputed by `zcash_primitives`.
pub fn zec_decode_raw_tx(raw_hex: &str, net: Network) -> Result<ZecRawTx> {
    let bytes =
        hex::decode(raw_hex.trim()).map_err(|_| Error::input("transaction non hexadécimale"))?;
    Ok(view(&parse_tx(&bytes)?, net))
}

// ---------------------------------------------------------------------------------------------
// Consensus: which branch to sign for
// ---------------------------------------------------------------------------------------------

/// Network upgrade name as Zcash writes it (`NU6.3`).
fn upgrade_name(b: BranchId) -> String {
    b.network_upgrade()
        .map_or_else(|| "Sprout".into(), |nu| nu.to_string().to_uppercase())
}

/// What the transaction commits to, decided from the chain tip.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ZecConsensus {
    /// Consensus branch id the transaction is signed for (ZIP 200 / ZIP 244).
    pub branch_id: u32,
    /// Its network upgrade, e.g. `NU6.3`.
    pub upgrade: String,
    /// Height of the next block (where the transaction can first be mined).
    pub target_height: u32,
    /// Last block where it can be mined (ZIP 203), capped before the next known upgrade.
    pub expiry_height: u32,
    /// The expiry was shortened because a network upgrade activates within 40 blocks.
    pub expiry_capped: bool,
}

/// Decides the branch id and expiry for a transaction built at `tip_height`, and checks them
/// against `observed_branch_id`, the branch id written in a transaction of the block at
/// `observed_height` (read from the network, at most 10 blocks below the tip).
///
/// Refused: a branch id this build does not know (a network upgrade newer than Kyro: update
/// it), or one that is not what the activation table of `zcash_protocol` says for that height
/// (wrong chain, or an upgrade whose height this build does not have).
pub fn zec_consensus(
    net: Network,
    tip_height: u32,
    observed_height: u32,
    observed_branch_id: u32,
) -> Result<ZecConsensus> {
    let p = params(net);
    if observed_height > tip_height || tip_height - observed_height > 10 {
        return Err(Error::input(
            "la mise à niveau du réseau doit être lue dans un des 10 derniers blocs",
        ));
    }
    let observed = BranchId::try_from(observed_branch_id).map_err(|_| {
        Error::input(format!(
            "le réseau Zcash utilise la branche de consensus 0x{observed_branch_id:08x}, inconnue de cette version de Kyro (mise à niveau du réseau) : mets Kyro à jour avant d'envoyer"
        ))
    })?;
    let expected = BranchId::for_height(&p, BlockHeight::from_u32(observed_height));
    if observed != expected {
        return Err(Error::input(format!(
            "le réseau Zcash est en {} (0x{observed_branch_id:08x}) au bloc {observed_height}, cette version de Kyro attend {} : mets Kyro à jour avant d'envoyer",
            upgrade_name(observed),
            upgrade_name(expected),
        )));
    }
    let target_height = tip_height
        .checked_add(1)
        .ok_or_else(|| Error::input("hauteur de bloc invalide"))?;
    let branch = BranchId::for_height(&p, BlockHeight::from_u32(target_height));
    if !TxVersion::V5.valid_in_branch(branch) {
        return Err(Error::input(format!(
            "les transactions v5 ne sont pas valides sous {}",
            upgrade_name(branch)
        )));
    }
    let mut expiry_height = target_height
        .checked_add(ZEC_EXPIRY_DELTA)
        .ok_or_else(|| Error::input("hauteur de bloc invalide"))?;
    let mut expiry_capped = false;
    if let Some(next) = branch
        .height_bounds(&p)
        .and_then(|(_, upper)| upper)
        .map(u32::from)
    {
        if expiry_height >= next {
            expiry_height = next.saturating_sub(1).max(target_height);
            expiry_capped = true;
        }
    }
    Ok(ZecConsensus {
        branch_id: u32::from(branch),
        upgrade: upgrade_name(branch),
        target_height,
        expiry_height,
        expiry_capped,
    })
}

/// Next network upgrade this build knows on `net` after `height`, if any: `(name, height)`.
pub fn zec_next_upgrade(net: Network, height: u32) -> Option<(String, u32)> {
    let p = params(net);
    let b = BranchId::for_height(&p, BlockHeight::from_u32(height));
    let next = b.height_bounds(&p).and_then(|(_, upper)| upper)?;
    let nu: Option<NetworkUpgrade> = BranchId::for_height(&p, next).network_upgrade();
    Some((
        nu.map_or_else(String::new, |n| n.to_string().to_uppercase()),
        u32::from(next),
    ))
}

// ---------------------------------------------------------------------------------------------
// Building and signing
// ---------------------------------------------------------------------------------------------

/// One of our coins, as the shell supplies it: the full previous transaction (hex) and which of
/// our addresses (`change`/`index` of the signing account) the output pays.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ZecCoin {
    /// Previous transaction, consensus-serialized hex.
    pub prev_tx: String,
    /// Output index in it.
    pub vout: u32,
    /// Internal (change) chain.
    pub change: bool,
    /// Address index.
    pub index: u32,
}

/// A send to build: candidate coins (Rust selects among them), recipient, amount (zatoshis)
/// or everything, our change index, and the chain state read from the network.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ZecSendRequest {
    /// Candidate coins of the account.
    pub coins: Vec<ZecCoin>,
    /// Destination address.
    pub to: String,
    /// Amount in zatoshis (ignored with `max`).
    pub amount: u64,
    /// Send everything minus the fee to `to`, no change.
    pub max: bool,
    /// Index of our change address (`m/44'/133'/account'/1/change_index`).
    pub change_index: u32,
    /// Chain tip height.
    pub tip_height: u32,
    /// Height of the block where `network_branch_id` was read (at most 10 below the tip).
    pub network_branch_height: u32,
    /// Branch id written in a transaction of that block.
    pub network_branch_id: u32,
}

/// Change output of a decoded transaction.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ZecChange {
    /// Our address.
    pub address: String,
    /// Zatoshis, decimal string.
    pub amount: String,
    /// `m/44'/133'/account'/1/index`.
    pub index: u32,
}

/// Reasons for caution.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ZecWarning {
    /// Fee above 10× the ZIP-317 conventional fee, or larger than the amount sent
    /// (reinforced confirmation).
    HighFee,
    /// A network upgrade activates within 40 blocks: the transaction expires earlier than
    /// usual (informative).
    ExpiryCapped {
        /// Upgrade activation height.
        next_upgrade_height: u32,
    },
}

/// Plain-language summary of a Zcash transaction built by Kyro, decoded from its encoding.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ZecTxSummary {
    /// Recipient as given (normalized: trimmed).
    pub to: String,
    /// Recipient kind.
    pub to_kind: ZecAddressKind,
    /// Recipient's transparent address (`t1…`), for a TEX recipient the address it encodes.
    pub to_address: String,
    /// Zatoshis sent, decimal string.
    pub amount: String,
    /// Change back to us, if any.
    pub change: Option<ZecChange>,
    /// Fee paid (inputs − outputs), zatoshis.
    pub fee: String,
    /// ZIP-317 conventional fee for these inputs and outputs.
    pub zip317_fee: String,
    /// Remainder too small for a change output, included in `fee`.
    pub folded: String,
    /// Inputs spent (all ours).
    pub inputs: usize,
    /// Sum of the inputs, zatoshis.
    pub input_total: String,
    /// Network upgrade and branch id signed for.
    pub upgrade: String,
    /// Branch id, `0x…`.
    pub branch_id: String,
    /// Height of the next block.
    pub target_height: u32,
    /// Last block where it can be mined.
    pub expiry_height: u32,
    /// ZIP-244 transaction id (does not depend on the signatures).
    pub txid: String,
    /// Reasons for caution.
    pub warnings: Vec<ZecWarning>,
    /// The confirmation dialog must be followed by a reinforced one.
    pub requires_extra_confirmation: bool,
}

/// Transparent authorization context of an unsigned bundle: the amount and script of every
/// spent output, which ZIP 244 commits to.
#[derive(Debug)]
struct Unsigned {
    coins: Vec<TxOut>,
}

impl tbundle::Authorization for Unsigned {
    type ScriptSig = ();
}

impl TransparentAuthorizingContext for Unsigned {
    fn input_amounts(&self) -> Vec<Zatoshis> {
        self.coins.iter().map(TxOut::value).collect()
    }

    fn input_scriptpubkeys(&self) -> Vec<Script> {
        self.coins
            .iter()
            .map(|c| c.script_pubkey().clone())
            .collect()
    }
}

/// A transaction with a transparent part only (no Sapling / Orchard bundle is ever built).
struct TransparentOnly;

impl Authorization for TransparentOnly {
    type TransparentAuth = Unsigned;
    type SaplingAuth = sapling_crypto::bundle::Authorized;
    type OrchardAuth = orchard::bundle::Authorized;
}

fn script(bytes: Vec<u8>) -> Script {
    Script(zcash_script::script::Code(bytes))
}

fn zats(v: u64) -> Result<Zatoshis> {
    Zatoshis::from_u64(v).map_err(|_| Error::input("montant au-delà de la masse monétaire Zcash"))
}

struct Spend {
    outpoint: OutPoint,
    coin: TxOut,
    change: bool,
    index: u32,
    pubkey: PublicKey,
}

struct Plan {
    unsigned: TransactionData<TransparentOnly>,
    spends: Vec<Spend>,
    summary: ZecTxSummary,
}

fn zip317_fee(net: Network, target: u32, inputs: usize, outputs: &[&[u8]]) -> Result<u64> {
    zip317::FeeRule::standard()
        .fee_required(
            &params(net),
            BlockHeight::from_u32(target),
            (0..inputs).map(|_| InputSize::STANDARD_P2PKH),
            outputs
                .iter()
                .map(|s| 8 + script(s.to_vec()).serialized_size()),
            0,
            0,
            0,
            0,
        )
        .map(Zatoshis::into_u64)
        .map_err(|_| Error::input("dépassement dans le calcul des frais"))
}

/// Verifies the candidate coins (previous transaction re-hashed, output exists, pays the key
/// of this account at the given `change`/`index`), largest first.
fn verified_coins(xpub: &Xpub, coins: &[ZecCoin]) -> Result<Vec<Spend>> {
    let mut out: Vec<Spend> = Vec::with_capacity(coins.len());
    for (i, c) in coins.iter().enumerate() {
        let bytes = hex::decode(c.prev_tx.trim())
            .map_err(|_| Error::input("transaction non hexadécimale"))?;
        let prev = parse_tx(&bytes)?;
        let bundle = prev
            .transparent_bundle()
            .ok_or_else(|| Error::input(format!("pièce {i} : aucune sortie transparente")))?;
        if bundle.is_coinbase() {
            return Err(Error::input(format!(
                "pièce {i} : issue d'un minage (coinbase) — Zcash impose de la protéger, Kyro ne peut pas la dépenser"
            )));
        }
        let txout = usize::try_from(c.vout)
            .ok()
            .and_then(|v| bundle.vout.get(v))
            .ok_or_else(|| Error::input(format!("pièce {i} : sortie (vout) inexistante")))?;
        let pubkey = child_pubkey(xpub, c.change, c.index)?;
        if txout.script_pubkey().0 .0 != own_script(&pubkey) {
            return Err(Error::input(format!(
                "pièce {i} : la sortie ne paie pas l'adresse {}/{} de ce compte",
                u8::from(c.change),
                c.index
            )));
        }
        let outpoint = OutPoint::new(*prev.txid().as_ref(), c.vout);
        if out.iter().any(|s| s.outpoint == outpoint) {
            return Err(Error::input(format!("pièce {i} : listée deux fois")));
        }
        out.push(Spend {
            outpoint,
            coin: txout.clone(),
            change: c.change,
            index: c.index,
            pubkey,
        });
    }
    out.sort_by(|a, b| {
        b.coin
            .value()
            .cmp(&a.coin.value())
            .then_with(|| a.outpoint.cmp(&b.outpoint))
    });
    Ok(out)
}

fn plan(seed: &Seed, net: Network, account: u32, req: &ZecSendRequest) -> Result<Plan> {
    let consensus = zec_consensus(
        net,
        req.tip_height,
        req.network_branch_height,
        req.network_branch_id,
    )?;
    let (to_script, to_kind) = zec_parse_address(&req.to, net)?;
    if req.change_index > MAX_CHANGE_INDEX {
        return Err(Error::input(format!(
            "index de monnaie au-delà de {MAX_CHANGE_INDEX}"
        )));
    }
    let secp = secp()?;
    let (xpub, _, _) = account_xpub(&secp, seed, net, account)?;
    let change_pk = child_pubkey(&xpub, true, req.change_index)?;
    let change_script = own_script(&change_pk);
    let coins = verified_coins(&xpub, &req.coins)?;
    if coins.is_empty() {
        return Err(Error::input("aucune pièce à dépenser"));
    }
    let target = consensus.target_height;

    // Selection: largest first, until amount + ZIP-317 fee is covered.
    let mut chosen = 0usize;
    let mut total: u64 = 0;
    let (amount, change, fee, folded, conventional) = loop {
        if chosen == coins.len() || chosen == ZEC_MAX_INPUTS {
            if req.max {
                let fee1 = zip317_fee(net, target, chosen, &[&to_script])?;
                let amount = total
                    .checked_sub(fee1)
                    .filter(|a| *a >= ZEC_DUST)
                    .ok_or_else(|| {
                        Error::input("solde trop faible pour couvrir les frais du réseau")
                    })?;
                break (amount, 0, fee1, 0, fee1);
            }
            return Err(Error::input(format!(
                "solde insuffisant : {total} zatoshis dans {chosen} pièce(s), il en faut plus pour le montant et les frais"
            )));
        }
        total = total
            .checked_add(coins[chosen].coin.value().into_u64())
            .ok_or_else(|| Error::input("dépassement de la somme des entrées"))?;
        chosen += 1;
        if req.max {
            continue;
        }
        if req.amount < ZEC_DUST {
            return Err(Error::input(format!(
                "montant sous la limite de poussière du réseau ({ZEC_DUST} zatoshis)"
            )));
        }
        let fee2 = zip317_fee(net, target, chosen, &[&to_script, &change_script])?;
        if let Some(c) = total
            .checked_sub(req.amount)
            .and_then(|r| r.checked_sub(fee2))
            .filter(|c| *c >= ZEC_MIN_CHANGE)
        {
            break (req.amount, c, fee2, 0, fee2);
        }
        let fee1 = zip317_fee(net, target, chosen, &[&to_script])?;
        if let Some(rest) = total
            .checked_sub(req.amount)
            .and_then(|r| r.checked_sub(fee1))
        {
            break (req.amount, 0, fee1 + rest, rest, fee1);
        }
    };
    let spends: Vec<Spend> = coins.into_iter().take(chosen).collect();

    let mut vout = vec![TxOut::new(zats(amount)?, script(to_script.clone()))];
    if change > 0 {
        vout.push(TxOut::new(zats(change)?, script(change_script.clone())));
    }
    let vin = spends
        .iter()
        .map(|s| TxIn::from_parts(s.outpoint.clone(), (), u32::MAX))
        .collect();
    let bundle = Bundle {
        vin,
        vout,
        authorization: Unsigned {
            coins: spends.iter().map(|s| s.coin.clone()).collect(),
        },
    };
    let branch = BranchId::try_from(consensus.branch_id)
        .map_err(|_| Error::crypto("branch id round trip failed"))?;
    let unsigned = TransactionData::<TransparentOnly>::from_parts(
        TxVersion::V5,
        branch,
        0,
        BlockHeight::from_u32(consensus.expiry_height),
        Some(bundle),
        None,
        None,
        None,
    );
    let digests = unsigned.digest(TxIdDigester);
    let txid = to_txid(TxVersion::V5, branch, &digests);

    let mut warnings = Vec::new();
    if fee > conventional.saturating_mul(10) || fee > amount {
        warnings.push(ZecWarning::HighFee);
    }
    if consensus.expiry_capped {
        warnings.push(ZecWarning::ExpiryCapped {
            next_upgrade_height: consensus.expiry_height + 1,
        });
    }
    let requires_extra_confirmation = warnings
        .iter()
        .any(|w| !matches!(w, ZecWarning::ExpiryCapped { .. }));
    let to_address = zec_address_of_script(&to_script, net)
        .ok_or_else(|| Error::crypto("address encoding failed"))?;
    let summary = ZecTxSummary {
        to: req.to.trim().to_owned(),
        to_kind,
        to_address,
        amount: amount.to_string(),
        change: (change > 0).then(|| ZecChange {
            address: own_address(net, &change_pk),
            amount: change.to_string(),
            index: req.change_index,
        }),
        fee: fee.to_string(),
        zip317_fee: conventional.to_string(),
        folded: folded.to_string(),
        inputs: spends.len(),
        input_total: total.to_string(),
        upgrade: consensus.upgrade.clone(),
        branch_id: format!("0x{:08x}", consensus.branch_id),
        target_height: consensus.target_height,
        expiry_height: consensus.expiry_height,
        txid: txid.to_string(),
        warnings,
        requires_extra_confirmation,
    };
    Ok(Plan {
        unsigned,
        spends,
        summary,
    })
}

/// Decodes the transaction encoding back and checks it says exactly what the summary says:
/// version 5, the branch and expiry, our inputs, the recipient, the amount and our change.
fn check_encoding(
    tx: &Transaction,
    net: Network,
    plan_summary: &ZecTxSummary,
    spends: &[Spend],
) -> Result<()> {
    let v = view(tx, net);
    let s = plan_summary;
    let mut want_out = vec![(Some(s.to_address.clone()), s.amount.clone())];
    if let Some(c) = &s.change {
        want_out.push((Some(c.address.clone()), c.amount.clone()));
    }
    let got_out: Vec<(Option<String>, String)> = v
        .outputs
        .iter()
        .map(|(a, value, _)| (a.clone(), value.to_string()))
        .collect();
    let want_in: Vec<(String, u32)> = spends
        .iter()
        .map(|sp| (sp.outpoint.txid().to_string(), sp.outpoint.n()))
        .collect();
    if v.version != 5
        || v.shielded
        || v.branch_id != Some(u32::from(tx.consensus_branch_id()))
        || format!("0x{:08x}", u32::from(tx.consensus_branch_id())) != s.branch_id
        || u32::from(tx.expiry_height()) != s.expiry_height
        || tx.lock_time() != 0
        || got_out != want_out
        || v.inputs != want_in
        || v.txid != s.txid
    {
        return Err(Error::crypto(
            "the encoded transaction differs from what was built",
        ));
    }
    Ok(())
}

/// Builds the transaction (see [`ZecSendRequest`]) and returns the summary shown in the native
/// dialog, without signing.
///
/// Refused: shielded / unified / other-network recipient, unknown or mismatching consensus
/// branch, a coin whose previous transaction does not parse, whose output does not exist or
/// does not pay this account at the stated index, a coinbase coin, a duplicate coin, an amount
/// under the dust limit, insufficient funds, a change index above [`MAX_CHANGE_INDEX`].
pub fn zec_tx_summary(
    seed: &Seed,
    net: Network,
    account: u32,
    req: &ZecSendRequest,
) -> Result<ZecTxSummary> {
    Ok(plan(seed, net, account, req)?.summary)
}

/// Builds and signs (`SIGHASH_ALL`, ZIP-244 digest computed by `zcash_primitives`), verifies
/// every signature against its key and digest, re-decodes the encoding and checks it matches
/// the summary. Returns the signed transaction (hex) and the same summary as
/// [`zec_tx_summary`].
pub fn zec_sign(
    seed: &Seed,
    net: Network,
    account: u32,
    req: &ZecSendRequest,
) -> Result<(String, ZecTxSummary)> {
    let Plan {
        unsigned,
        spends,
        summary,
    } = plan(seed, net, account, req)?;
    let digests = unsigned.digest(TxIdDigester);
    let secp = secp()?;
    let master = XprivGuard::master(seed, net.btc_kind())?;
    let base = account_path(net, account)?;
    let bundle = unsigned
        .transparent_bundle()
        .ok_or_else(|| Error::crypto("missing transparent bundle"))?;
    let mut vin = Vec::with_capacity(spends.len());
    for (i, sp) in spends.iter().enumerate() {
        let spk = sp.coin.script_pubkey();
        let input =
            TransparentSignable::from_parts(bundle, SighashType::ALL, i, spk, spk, sp.coin.value())
                .map_err(|_| Error::crypto("input index out of range"))?;
        let digest = signature_hash(&unsigned, &SignableInput::Transparent(input), &digests);
        let msg = Message::from_digest(*digest.as_ref());
        let path = [
            base[0],
            base[1],
            base[2],
            normal(u32::from(sp.change))?,
            normal(sp.index)?,
        ];
        let key = master.derive(&secp, &path)?;
        let sk = &key.xpriv().private_key;
        if sk.public_key(&secp) != sp.pubkey {
            return Err(Error::crypto("derived key does not match the coin"));
        }
        let sig = secp.sign_ecdsa(&msg, sk);
        secp.verify_ecdsa(&msg, &sig, &sp.pubkey)
            .map_err(|_| Error::crypto("signature self-check failed"))?;
        let mut der = sig.serialize_der().to_vec();
        der.push(zcash_transparent::sighash::SIGHASH_ALL);
        let script_sig = bitcoin::ScriptBuf::builder()
            .push_slice(
                PushBytesBuf::try_from(der).map_err(|_| Error::crypto("signature too long"))?,
            )
            .push_key(&bitcoin::PublicKey::new(sp.pubkey))
            .into_script();
        vin.push(TxIn::<tbundle::Authorized>::from_parts(
            sp.outpoint.clone(),
            script(script_sig.into_bytes()),
            u32::MAX,
        ));
    }
    let signed = TransactionData::<Authorized>::from_parts(
        TxVersion::V5,
        unsigned.consensus_branch_id(),
        0,
        unsigned.expiry_height(),
        Some(Bundle {
            vin,
            vout: bundle.vout.clone(),
            authorization: tbundle::Authorized,
        }),
        None,
        None,
        None,
    )
    .freeze()
    .map_err(|_| Error::crypto("transaction encoding failed"))?;
    let mut bytes = Vec::new();
    signed
        .write(&mut bytes)
        .map_err(|_| Error::crypto("transaction encoding failed"))?;
    // What goes on the wire, parsed back by zcash_primitives, must be what the dialog shows.
    let reparsed = parse_tx(&bytes)?;
    check_encoding(&reparsed, net, &summary, &spends)?;
    Ok((hex::encode(bytes), summary))
}

/// ZIP-244 signature digest of transparent input `index` of `tx` (`SIGHASH_ALL`), given the
/// amount and script of every spent output: for checking real transactions in tests and for
/// re-verifying a signed transaction.
pub fn zec_input_sighash(
    raw_hex: &str,
    prevouts: &[(u64, Vec<u8>)],
    index: usize,
) -> Result<[u8; 32]> {
    let bytes =
        hex::decode(raw_hex.trim()).map_err(|_| Error::input("transaction non hexadécimale"))?;
    let tx = parse_tx(&bytes)?;
    if tx.version() != TxVersion::V5 {
        return Err(Error::input(
            "seules les transactions v5 sont prises en charge",
        ));
    }
    let data = tx.into_data();
    let bundle = data
        .transparent_bundle()
        .ok_or_else(|| Error::input("aucune partie transparente"))?;
    if prevouts.len() != bundle.vin.len() || index >= prevouts.len() {
        return Err(Error::input(
            "les sorties dépensées ne correspondent pas aux entrées",
        ));
    }
    let coins = prevouts
        .iter()
        .map(|(v, s)| Ok(TxOut::new(zats(*v)?, script(s.clone()))))
        .collect::<Result<Vec<_>>>()?;
    let unsigned_bundle = Bundle {
        vin: bundle
            .vin
            .iter()
            .map(|i| TxIn::from_parts(i.prevout().clone(), (), i.sequence()))
            .collect(),
        vout: bundle.vout.clone(),
        authorization: Unsigned {
            coins: coins.clone(),
        },
    };
    if data.sapling_bundle().is_some() || data.orchard_bundle().is_some() {
        return Err(Error::input("parties protégées non prises en charge"));
    }
    let unsigned = TransactionData::<TransparentOnly>::from_parts(
        TxVersion::V5,
        data.consensus_branch_id(),
        data.lock_time(),
        data.expiry_height(),
        Some(unsigned_bundle),
        None,
        None,
        None,
    );
    let digests = unsigned.digest(TxIdDigester);
    let ub = unsigned
        .transparent_bundle()
        .ok_or_else(|| Error::crypto("missing transparent bundle"))?;
    let spk = coins[index].script_pubkey();
    let input = TransparentSignable::from_parts(
        ub,
        SighashType::ALL,
        index,
        spk,
        spk,
        coins[index].value(),
    )
    .map_err(|_| Error::input("index d'entrée hors limites"))?;
    Ok(*signature_hash(&unsigned, &SignableInput::Transparent(input), &digests).as_ref())
}
