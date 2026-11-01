//! Monero (XMR): keys from the wallet's BIP39 seed, addresses (primary and subaddresses), the
//! standard 25-word Monero seed of that key, scanning helpers, and transaction signing.
//!
//! **Key derivation (documented in SECURITY.md, same scheme as Ledger's Monero app).**
//! `k = BIP32-secp256k1(seed, m/44'/128'/a'/0/0)` (32-byte private key), then
//! `spend = sc_reduce32(keccak256(k))` and `view = sc_reduce32(keccak256(spend))` — Monero's own
//! rule for the view key, so the 25-word seed of `spend` restores the same wallet (both keys) in
//! Monero GUI, Feather or Cake. `sc_reduce32(keccak256(·))` is monero-oxide's `Scalar::hash`.
//!
//! **No home-made cryptography.** Everything below comes from monero-oxide / monero-wallet
//! (Cypher Stack audit, May 2025): addresses, subaddress derivation, output scanning (view tags,
//! amount decryption and commitment check), key images, CLSAG, Bulletproofs+, decoy-ready
//! transaction building and the post-signing [`Eventuality`] check. Kyro only adds the BIP39 →
//! Monero mapping above, the 25-word encoding (a word list + CRC32, no cryptography), the
//! encrypted local cache (XChaCha20-Poly1305 of RustCrypto) and the refusals.
//!
//! On Kyro's `Testnet`, Monero means **stagenet** (mainnet's rules, worthless coins).

use bitcoin::bip32::ChildNumber;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use curve25519_dalek::constants::ED25519_BASEPOINT_TABLE;
use monero_wallet::address::{AddressType, MoneroAddress, Network as XmrNet, SubaddressIndex};
use monero_wallet::ed25519::{Point, Scalar};
use monero_wallet::interface::FeeRate;
use monero_wallet::primitives::keccak256;
use monero_wallet::ringct::RctType;
use monero_wallet::send::{Change, Eventuality, SignableTransaction};
use monero_wallet::transaction::{Input, Pruned, Transaction};
use monero_wallet::{OutputWithDecoys, Scanner, ViewPair, WalletOutput};
use rand_chacha::ChaCha20Rng;
use rand_core::SeedableRng;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::error::{Error, Result};
use crate::keys::{hardened, normal, random32, secp, XprivGuard};
use crate::mnemonic::Seed;
use crate::monero_words::ENGLISH;
use crate::network::Network;

/// Re-exported so the shell can talk to a daemon (`monero-daemon-rpc`) with the same types.
pub use monero_wallet;

/// 1 XMR = 10^12 piconero.
pub const XMR_DECIMALS: u32 = 12;
/// Ring size of the current protocol (CLSAG + Bulletproofs+, since hard fork 15).
pub const XMR_RING_LEN: u8 = 16;
/// Subaddresses `(0, 1 … N)` scanned beyond the last one handed out (wallet2 uses 200).
pub const XMR_SUBADDRESS_LOOKAHEAD: u32 = 200;
/// Highest subaddress index Kyro hands out (account 0 only).
pub const XMR_MAX_SUBADDRESS: u32 = 100_000;
/// Fees above 0.01 XMR need a reinforced confirmation (a usual 2-output transfer pays
/// ≈ 0.00003 XMR at normal priority).
pub const XMR_HIGH_FEE: u64 = 10_000_000_000;
/// Blocks before a received output can be spent (protocol rule, `CRYPTONOTE_DEFAULT_TX_SPENDABLE_AGE`).
pub const XMR_SPENDABLE_AGE: u64 = 10;
/// Blocks before a coinbase output can be spent (`CRYPTONOTE_MINED_MONEY_UNLOCK_WINDOW`).
pub const XMR_COINBASE_AGE: u64 = 60;

const CACHE_MAGIC: &[u8; 5] = b"KXMR1";

// ---------------------------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------------------------

/// `m/44'/128'/account'/0/0` (the secp256k1 BIP32 node Kyro maps to Monero's spend key).
pub fn xmr_path(account: u32) -> String {
    format!("m/44'/128'/{account}'/0/0")
}

fn path(account: u32) -> Result<[ChildNumber; 5]> {
    Ok([
        hardened(44)?,
        hardened(128)?,
        hardened(account)?,
        normal(0)?,
        normal(0)?,
    ])
}

pub(crate) fn xmr_net(net: Network) -> XmrNet {
    match net {
        Network::Mainnet => XmrNet::Mainnet,
        Network::Testnet => XmrNet::Stagenet,
    }
}

/// Private spend key of account `account`: `sc_reduce32(keccak256(k))`, `k` the BIP32 key.
fn spend_key(seed: &Seed, account: u32) -> Result<Zeroizing<Scalar>> {
    let secp = secp()?;
    let master = XprivGuard::master(seed, bitcoin::NetworkKind::Main)?;
    let node = master.derive(&secp, &path(account)?)?;
    let k = Zeroizing::new(node.xpriv().private_key.secret_bytes());
    Ok(Zeroizing::new(Scalar::hash(&k[..])))
}

/// Monero's view key rule: `sc_reduce32(keccak256(spend))`.
fn view_key(spend: &Scalar) -> Zeroizing<Scalar> {
    let bytes = Zeroizing::new(<[u8; 32]>::from(*spend));
    Zeroizing::new(Scalar::hash(&bytes[..]))
}

fn public_of(s: &Scalar) -> Point {
    let d = Zeroizing::new((*s).into());
    Point::from(&*d * ED25519_BASEPOINT_TABLE)
}

/// Public spend key + private view key of account `account` (what scanning needs).
pub fn xmr_view_pair(seed: &Seed, account: u32) -> Result<ViewPair> {
    let spend = spend_key(seed, account)?;
    let view = view_key(&spend);
    ViewPair::new(public_of(&spend), view)
        .map_err(|_| Error::crypto("clé de dépense Monero invalide"))
}

fn subaddress_index(index: u32) -> Result<Option<SubaddressIndex>> {
    if index > XMR_MAX_SUBADDRESS {
        return Err(Error::input(format!(
            "sous-adresse Monero : au plus {XMR_MAX_SUBADDRESS}"
        )));
    }
    Ok(SubaddressIndex::new(0, index))
}

fn address_of(vp: &ViewPair, net: Network, index: u32) -> Result<String> {
    Ok(match subaddress_index(index)? {
        None => vp.legacy_address(xmr_net(net)),
        Some(i) => vp.subaddress(xmr_net(net), i),
    }
    .to_string())
}

/// Address of account `account`: `index` 0 = the primary (standard) address `4…` / `5…`,
/// `index` n ≥ 1 = subaddress `(0, n)` `8…` / `7…` (the ones Monero GUI lists under account #0).
pub fn xmr_address(seed: &Seed, net: Network, account: u32, index: u32) -> Result<String> {
    address_of(&xmr_view_pair(seed, account)?, net, index)
}

/// Several addresses of account `account` at once (one key derivation).
pub fn xmr_addresses(
    seed: &Seed,
    net: Network,
    account: u32,
    indices: core::ops::RangeInclusive<u32>,
) -> Result<Vec<String>> {
    let vp = xmr_view_pair(seed, account)?;
    indices.map(|i| address_of(&vp, net, i)).collect()
}

/// Public view key and public spend key, hex (what a view-only wallet needs, with the
/// private view key — which Kyro never returns).
pub fn xmr_public_keys(seed: &Seed, account: u32) -> Result<(String, String)> {
    let vp = xmr_view_pair(seed, account)?;
    Ok((
        hex::encode(vp.spend().compress().to_bytes()),
        hex::encode(vp.view().compress().to_bytes()),
    ))
}

// ---------------------------------------------------------------------------------------------
// 25-word Monero seed (English, Electrum-style word list with a checksum word)
// ---------------------------------------------------------------------------------------------

const PREFIX: usize = 3;

fn crc32(data: &[u8]) -> u32 {
    let mut crc = u32::MAX;
    for b in data {
        crc ^= u32::from(*b);
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
        }
    }
    !crc
}

fn checksum_index(words: &[&str]) -> usize {
    let mut trimmed = Zeroizing::new(String::new());
    for w in words {
        trimmed.extend(w.chars().take(PREFIX));
    }
    // u32 → usize is lossless on every target Kyro builds for (32- and 64-bit).
    usize::try_from(crc32(trimmed.as_bytes())).unwrap_or(0) % words.len()
}

/// The 25 English words of a 32-byte key (Monero's `bytes_to_words`).
fn key_to_words(key: &[u8; 32]) -> Zeroizing<Vec<String>> {
    const N: u64 = ENGLISH.len() as u64;
    let mut idx = Zeroizing::new(Vec::with_capacity(25));
    for chunk in key.chunks_exact(4) {
        let mut b = [0u8; 4];
        b.copy_from_slice(chunk);
        let x = u64::from(u32::from_le_bytes(b));
        let w1 = x % N;
        let w2 = (x / N + w1) % N;
        let w3 = (x / N / N + w2) % N;
        for w in [w1, w2, w3] {
            // < 1626, fits.
            idx.push(usize::try_from(w).unwrap_or(0));
        }
    }
    let words: Vec<&str> = idx.iter().map(|i| ENGLISH[*i]).collect();
    let check = words[checksum_index(&words)];
    let mut out = Zeroizing::new(Vec::with_capacity(25));
    for w in words {
        out.push(w.to_owned());
    }
    out.push(check.to_owned());
    out
}

/// Decodes 25 English words back to the 32-byte key (checksum verified). Used by the tests to
/// prove the round trip and by nothing else (Kyro never imports a Monero seed).
#[doc(hidden)]
pub fn xmr_words_to_key(phrase: &str) -> Result<Zeroizing<[u8; 32]>> {
    const N: usize = ENGLISH.len();
    let words: Vec<&str> = phrase.split_whitespace().collect();
    if words.len() != 25 {
        return Err(Error::input("phrase Monero : 25 mots attendus"));
    }
    let find = |w: &str| {
        let p: String = w.chars().take(PREFIX).collect();
        ENGLISH
            .iter()
            .position(|e| e.chars().take(PREFIX).collect::<String>() == p)
    };
    let mut idx = Zeroizing::new(Vec::with_capacity(24));
    for w in &words[..24] {
        idx.push(find(w).ok_or_else(|| Error::input("mot Monero inconnu"))?);
    }
    let expected = words[checksum_index(&words[..24])];
    let pfx = |w: &str| w.chars().take(PREFIX).collect::<String>();
    if pfx(expected) != pfx(words[24]) {
        return Err(Error::input("phrase Monero : mot de contrôle faux"));
    }
    let mut out = Zeroizing::new([0u8; 32]);
    for (i, t) in idx.chunks_exact(3).enumerate() {
        let (w1, w2, w3) = (t[0], t[1], t[2]);
        let x = w1 + N * ((N - w1 + w2) % N) + N * N * ((N - w2 + w3) % N);
        if x % N != w1 {
            return Err(Error::input("phrase Monero invalide"));
        }
        let v = u32::try_from(x).map_err(|_| Error::input("phrase Monero invalide"))?;
        out[i * 4..i * 4 + 4].copy_from_slice(&v.to_le_bytes());
    }
    Ok(out)
}

/// The standard 25-word Monero seed of account `account`'s spend key: restores the same wallet
/// in Monero GUI, Feather or Cake. **Only for the native backup window** (never sent to the UI).
pub fn xmr_seed_words(seed: &Seed, account: u32) -> Result<Zeroizing<Vec<String>>> {
    let spend = spend_key(seed, account)?;
    let bytes = Zeroizing::new(<[u8; 32]>::from(*spend));
    Ok(key_to_words(&bytes))
}

// ---------------------------------------------------------------------------------------------
// Destination addresses
// ---------------------------------------------------------------------------------------------

/// Kind of a Monero destination, as decoded by Rust.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum XmrAddressKind {
    /// Primary / standard address (`4…` mainnet, `5…` stagenet).
    Standard,
    /// Subaddress (`8…` mainnet, `7…` stagenet).
    Subaddress,
    /// Integrated address: standard address + 8-byte payment ID (hex), used by some exchanges.
    Integrated {
        /// The embedded payment ID, 16 hex characters.
        payment_id: String,
    },
}

/// A destination decoded by Rust.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XmrDestination {
    /// The address, re-encoded (identical to the input, which is required).
    pub address: String,
    /// Its kind.
    #[serde(flatten)]
    pub kind: XmrAddressKind,
}

fn parse_destination(address: &str, net: Network) -> Result<(MoneroAddress, XmrDestination)> {
    let s = address.trim();
    let want = xmr_net(net);
    let a = MoneroAddress::from_str_with_unchecked_network(s)
        .map_err(|_| Error::input("adresse Monero invalide (format ou somme de contrôle)"))?;
    if a.network() != want {
        let name = |n: XmrNet| match n {
            XmrNet::Mainnet => "mainnet",
            XmrNet::Stagenet => "stagenet",
            XmrNet::Testnet => "testnet",
        };
        return Err(Error::input(format!(
            "adresse Monero {} : Kyro est sur {}",
            name(a.network()),
            name(want)
        )));
    }
    let kind = match a.kind() {
        AddressType::Legacy => XmrAddressKind::Standard,
        AddressType::Subaddress => XmrAddressKind::Subaddress,
        AddressType::LegacyIntegrated(id) => XmrAddressKind::Integrated {
            payment_id: hex::encode(id),
        },
        AddressType::Featured { .. } => {
            return Err(Error::input(
                "adresse Monero « featured » (format expérimental, non standard) refusée",
            ))
        }
    };
    if a.to_string() != s {
        return Err(Error::input("adresse Monero non canonique"));
    }
    Ok((
        a,
        XmrDestination {
            address: s.to_owned(),
            kind,
        },
    ))
}

/// Decodes a destination for `net`: standard, subaddress or integrated only; another network,
/// a "featured" (guaranteed / experimental) address or a non-canonical encoding are refused.
pub fn xmr_parse_address(address: &str, net: Network) -> Result<XmrDestination> {
    parse_destination(address, net).map(|(_, d)| d)
}

// ---------------------------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------------------------

/// Scanner of account `account`: primary address + subaddresses `(0, 1 … subaddresses)`.
pub fn xmr_scanner(seed: &Seed, account: u32, subaddresses: u32) -> Result<Scanner> {
    let mut s = Scanner::new(xmr_view_pair(seed, account)?);
    for i in 1..=subaddresses.min(XMR_MAX_SUBADDRESS + XMR_SUBADDRESS_LOOKAHEAD) {
        if let Some(idx) = SubaddressIndex::new(0, i) {
            s.register_subaddress(idx);
        }
    }
    Ok(s)
}

/// Key images of `outputs` (received by account `account`), in order: what a spending
/// transaction reveals, so Kyro can tell which of its outputs are spent. Needs the private
/// spend key (derived here, then erased). An output that is not ours is refused.
pub fn xmr_key_images(
    seed: &Seed,
    account: u32,
    outputs: &[WalletOutput],
) -> Result<Vec<[u8; 32]>> {
    let b = spend_key(seed, account)?;
    let b = Zeroizing::new((*b).into());
    let mut out = Vec::with_capacity(outputs.len());
    for o in outputs {
        let x = Zeroizing::new(*b + o.key_offset().into());
        let key = o.key();
        if Point::from(&*x * ED25519_BASEPOINT_TABLE) != key {
            return Err(Error::input("sortie Monero qui n'est pas à ce compte"));
        }
        let hp = Point::biased_hash(key.compress().to_bytes()).into();
        out.push(Point::from(*x * hp).compress().to_bytes());
    }
    Ok(out)
}

/// A CSPRNG seeded from the OS, for monero-wallet's APIs that take one (decoy selection).
pub fn xmr_rng() -> Result<impl rand_core::RngCore + rand_core::CryptoRng + Send + Sync> {
    Ok(ChaCha20Rng::from_seed(*random32()?))
}

/// Key images spent by a (pruned) transaction's inputs.
pub fn xmr_spent_key_images(tx: &Transaction<Pruned>) -> Vec<[u8; 32]> {
    tx.prefix()
        .inputs
        .iter()
        .filter_map(|i| match i {
            Input::ToKey { key_image, .. } => Some(key_image.to_bytes()),
            Input::Gen(_) => None,
        })
        .collect()
}

/// Fee of a (pruned) RingCT transaction, if any.
pub fn xmr_tx_fee(tx: &Transaction<Pruned>) -> Option<u64> {
    match tx {
        Transaction::V2 {
            proofs: Some(p), ..
        } => Some(p.base.fee),
        _ => None,
    }
}

// ---------------------------------------------------------------------------------------------
// Encrypted local cache (scan state)
// ---------------------------------------------------------------------------------------------

fn cache_header(net: Network, account: u32) -> Vec<u8> {
    let mut h = CACHE_MAGIC.to_vec();
    h.push(match net {
        Network::Mainnet => 0,
        Network::Testnet => 1,
    });
    h.extend(account.to_le_bytes());
    h
}

fn cache_key(seed: &Seed, net: Network, account: u32) -> Result<Zeroizing<[u8; 32]>> {
    let spend = spend_key(seed, account)?;
    let view = view_key(&spend);
    let mut pre = Zeroizing::new(b"Kyro XMR scan cache v1".to_vec());
    pre.extend(<[u8; 32]>::from(*view));
    pre.extend(cache_header(net, account));
    Ok(Zeroizing::new(keccak256(&pre[..])))
}

/// Encrypts the scan cache of `(net, account)` (XChaCha20-Poly1305; key derived from the
/// private view key, so only this seed can read it; network and account authenticated).
pub fn xmr_cache_seal(seed: &Seed, net: Network, account: u32, plain: &[u8]) -> Result<Vec<u8>> {
    let key = cache_key(seed, net, account)?;
    let cipher = XChaCha20Poly1305::new_from_slice(&key[..])
        .map_err(|_| Error::crypto("clé de cache invalide"))?;
    let mut nonce = [0u8; 24];
    getrandom::getrandom(&mut nonce).map_err(|_| Error::crypto("OS randomness unavailable"))?;
    let header = cache_header(net, account);
    let ct = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: plain,
                aad: &header,
            },
        )
        .map_err(|_| Error::crypto("chiffrement du cache impossible"))?;
    let mut out = header;
    out.extend(nonce);
    out.extend(ct);
    Ok(out)
}

/// Decrypts a cache written by [`xmr_cache_seal`] for the same seed, network and account.
pub fn xmr_cache_open(
    seed: &Seed,
    net: Network,
    account: u32,
    data: &[u8],
) -> Result<Zeroizing<Vec<u8>>> {
    let header = cache_header(net, account);
    if data.len() < header.len() + 24 + 16 || data[..header.len()] != header[..] {
        return Err(Error::input(
            "cache Monero d'un autre réseau, compte ou format",
        ));
    }
    let key = cache_key(seed, net, account)?;
    let cipher = XChaCha20Poly1305::new_from_slice(&key[..])
        .map_err(|_| Error::crypto("clé de cache invalide"))?;
    let (nonce, ct) = data[header.len()..].split_at(24);
    cipher
        .decrypt(
            XNonce::from_slice(nonce),
            Payload {
                msg: ct,
                aad: &header,
            },
        )
        .map(Zeroizing::new)
        .map_err(|_| Error::input("cache Monero illisible (autre phrase ou fichier modifié)"))
}

// ---------------------------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------------------------

/// Something in a transfer that deserves a second, reinforced confirmation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum XmrWarning {
    /// Integrated address: the payment ID travels encrypted in the transaction.
    IntegratedAddress,
    /// Fee above [`XMR_HIGH_FEE`] (0.01 XMR).
    HighFee,
    /// The fee is larger than the amount sent.
    FeeAboveAmount,
    /// The destination is one of this account's own addresses.
    OwnAddress,
}

/// What Rust built, shown in the native dialog. Amounts in piconero (decimal strings).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XmrTxSummary {
    /// `mainnet` or `stagenet`.
    pub network: String,
    /// Account that signs.
    pub account: u32,
    /// Decoded destination.
    pub destination: XmrDestination,
    /// Amount the destination receives.
    pub amount: String,
    /// Network fee (paid on top).
    pub fee: String,
    /// Change back to this account's primary address.
    pub change: String,
    /// Sum of the spent outputs (= amount + fee + change).
    pub inputs_total: String,
    /// Number of our outputs spent.
    pub input_count: usize,
    /// Ring size of each input.
    pub ring_size: u8,
    /// Fee per weight unit used (piconero), from the node's estimate (bounded by the shell).
    pub fee_per_weight: String,
    /// Reasons for the reinforced confirmation.
    pub warnings: Vec<XmrWarning>,
    /// A second, reinforced native confirmation is required.
    pub requires_extra_confirmation: bool,
}

/// A transaction ready to be signed. Holds no private key (the spend key is only derived in
/// [`xmr_sign`]); it does hold our outputs' one-time offsets: it never leaves Rust.
pub struct XmrUnsigned {
    signable: SignableTransaction,
    /// What the dialog shows.
    pub summary: XmrTxSummary,
}

impl core::fmt::Debug for XmrUnsigned {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("XmrUnsigned")
            .field("summary", &self.summary)
            .finish_non_exhaustive()
    }
}

/// Builds the transfer of `amount` piconero to `to` from `inputs` (our unlocked outputs with
/// their decoys, chosen by the shell), change to this account's primary address.
///
/// `fee_rate`: the node's estimate, bounded by the shell. `own_addresses`: this account's
/// addresses handed out so far (a send to one of them is flagged).
#[allow(clippy::too_many_arguments)]
pub fn xmr_build(
    seed: &Seed,
    net: Network,
    account: u32,
    inputs: Vec<OutputWithDecoys>,
    to: &str,
    amount: u64,
    fee_rate: FeeRate,
    own_addresses: &[String],
) -> Result<XmrUnsigned> {
    if amount == 0 {
        return Err(Error::input("montant nul"));
    }
    if inputs.is_empty() {
        return Err(Error::input("aucune sortie à dépenser"));
    }
    if inputs
        .iter()
        .any(|i| i.decoys().len() != usize::from(XMR_RING_LEN))
    {
        return Err(Error::input("anneau de taille inattendue"));
    }
    let (parsed, dest) = parse_destination(to, net)?;
    let vp = xmr_view_pair(seed, account)?;
    let inputs_total: u64 = inputs
        .iter()
        .try_fold(0u64, |acc, i| acc.checked_add(i.commitment().amount))
        .ok_or_else(|| Error::input("montants d'entrée trop grands"))?;
    let input_count = inputs.len();
    let ovk = random32()?;
    let signable = SignableTransaction::new(
        RctType::ClsagBulletproofPlus,
        ovk,
        inputs,
        vec![(parsed, amount)],
        Change::new(vp, None),
        Vec::new(),
        fee_rate,
    )
    .map_err(|e| match e {
        monero_wallet::send::SendError::NotEnoughFunds {
            inputs,
            outputs,
            necessary_fee,
        } => Error::input(format!(
            "fonds insuffisants : {inputs} piconero disponibles, {outputs} demandés + {} de frais",
            necessary_fee.unwrap_or(0)
        )),
        other => Error::input(format!("transaction Monero impossible : {other}")),
    })?;
    let fee = signable.necessary_fee();
    let change = inputs_total
        .checked_sub(amount)
        .and_then(|r| r.checked_sub(fee))
        .ok_or_else(|| Error::input("fonds insuffisants pour les frais"))?;
    let mut warnings = Vec::new();
    if matches!(dest.kind, XmrAddressKind::Integrated { .. }) {
        warnings.push(XmrWarning::IntegratedAddress);
    }
    if fee > XMR_HIGH_FEE {
        warnings.push(XmrWarning::HighFee);
    }
    if fee > amount {
        warnings.push(XmrWarning::FeeAboveAmount);
    }
    if own_addresses.iter().any(|a| a.trim() == dest.address) {
        warnings.push(XmrWarning::OwnAddress);
    }
    let summary = XmrTxSummary {
        network: match net {
            Network::Mainnet => "mainnet",
            Network::Testnet => "stagenet",
        }
        .into(),
        account,
        destination: dest,
        amount: amount.to_string(),
        fee: fee.to_string(),
        change: change.to_string(),
        inputs_total: inputs_total.to_string(),
        input_count,
        ring_size: XMR_RING_LEN,
        fee_per_weight: fee_rate.per_weight().to_string(),
        requires_extra_confirmation: !warnings.is_empty(),
        warnings,
    };
    Ok(XmrUnsigned { signable, summary })
}

/// A signed transaction, checked: its outputs are exactly the planned payment and change, and
/// its fee is the one shown.
pub struct XmrSigned {
    /// The transaction (published by the shell through the daemon interface).
    pub tx: Transaction,
    /// Transaction id, hex.
    pub txid: String,
    /// Key images of our outputs it spends.
    pub key_images: Vec<[u8; 32]>,
    /// The summary that was signed (identical to the one shown).
    pub summary: XmrTxSummary,
}

/// Signs `unsigned` with account `account`'s spend key (derived here, then erased), then checks
/// the result with monero-wallet's [`Eventuality`] (the transaction creates exactly the planned
/// outputs — payment and change — with the planned data) and that its fee is the one shown.
pub fn xmr_sign(seed: &Seed, account: u32, unsigned: XmrUnsigned) -> Result<XmrSigned> {
    if unsigned.summary.account != account {
        return Err(Error::input("transaction préparée pour un autre compte"));
    }
    let XmrUnsigned { signable, summary } = unsigned;
    let eventuality = Eventuality::from(signable.clone());
    let spend = spend_key(seed, account)?;
    let mut rng = ChaCha20Rng::from_seed(*random32()?);
    let tx = signable
        .sign(&mut rng, &spend)
        .map_err(|e| Error::crypto(format!("signature Monero impossible : {e}")))?;
    let pruned = Transaction::<Pruned>::from(tx.clone());
    if !eventuality.matches(&pruned) {
        return Err(Error::crypto(
            "la transaction signée ne crée pas exactement les sorties prévues",
        ));
    }
    if xmr_tx_fee(&pruned).map(|f| f.to_string()) != Some(summary.fee.clone()) {
        return Err(Error::crypto("frais de la transaction signée différents"));
    }
    Ok(XmrSigned {
        txid: hex::encode(tx.hash()),
        key_images: xmr_spent_key_images(&pruned),
        tx,
        summary,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crc32_matches_the_standard_check_value() {
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
    }

    #[test]
    fn official_english_vector_encodes() {
        // kayabaNerve/monero-wallet-util seed/src/tests.rs (English).
        let k: [u8; 32] =
            hex::decode("c0af65c0dd837e666b9d0dfed62745f4df35aed7ea619b2798a709f0fe545403")
                .unwrap()
                .try_into()
                .unwrap();
        assert_eq!(
            key_to_words(&k).join(" "),
            "washing thirsty occur lectures tuesday fainted toxic adapt abnormal memoir nylon \
             mostly building shrugged online ember northern ruby woes dauntless boil family \
             illness inroads northern"
        );
        // Its view key is Monero's H_s(spend).
        let spend = Scalar::read(&mut k.as_slice()).unwrap();
        assert_eq!(
            hex::encode(<[u8; 32]>::from(*view_key(&spend))),
            "513ba91c538a5a9069e0094de90e927c0cd147fa10428ce3ac1afd49f63e3b01"
        );
    }

    #[test]
    fn words_round_trip() {
        for k in [[0u8; 32], [0x5a; 32], {
            let mut k = [0u8; 32];
            for (i, b) in k.iter_mut().enumerate() {
                *b = u8::try_from(i * 7).unwrap();
            }
            k
        }] {
            let w = key_to_words(&k);
            assert_eq!(w.len(), 25);
            assert_eq!(*xmr_words_to_key(&w.join(" ")).unwrap(), k);
        }
    }
}
