//! Litecoin (BIP84 native SegWit, P2WPKH) and Dogecoin (BIP44 legacy, P2PKH).
//!
//! Both chains are Bitcoin derivatives: same transaction serialization, same secp256k1 keys and
//! BIP32 derivation, same script interpreter and signature hashes (Litecoin: BIP143 for SegWit
//! v0; Dogecoin: the original "legacy" algorithm, no SegWit, no fork id). So the audited
//! `bitcoin` 0.32 crate is reused for keys, PSBTs, transactions and sighashes; only the
//! address encodings differ, and they are built here from the crate's own `bech32` and
//! `base58` (checked) re-exports with each chain's parameters. No cryptography is written here.
//!
//! Parameters (source: `src/chainparams.cpp` of Litecoin Core 0.21 and Dogecoin Core 1.14,
//! read 2026-10-30):
//!
//! | | P2PKH | P2SH | bech32 | genesis |
//! |---|---|---|---|---|
//! | Litecoin mainnet | 48 (`L…`) | 50 (`M…`) | `ltc` | `12a765e3…7e04bfe2` |
//! | Litecoin testnet4 | 111 (`m…`/`n…`) | 58 (`Q…`) | `tltc` | `4966625a…4e3e29a0` |
//! | Dogecoin mainnet | 30 (`D…`) | 22 (`9…`/`A…`) | — | `1a91e3da…2c355691` |
//! | Dogecoin testnet | 113 (`n…`) | 196 (`2…`) | — | `bb0a7826…7350559e` |
//!
//! Litecoin's legacy P2SH version bytes (5 = `3…` mainnet, 196 = `2…` testnet, the same as
//! Bitcoin's) are **refused** as destinations: a Bitcoin `3…` address pasted into a Litecoin
//! send would otherwise be accepted silently. The recipient can give the `M…` / `Q…` form of
//! the same script.
//!
//! Extended keys are serialized with the standard `xpub`/`tpub` version bytes (what Litecoin
//! Core itself uses; Dogecoin Core uses `dgub` on mainnet): the key material is identical, only
//! the 4-byte prefix differs.

use core::str::FromStr;

use bitcoin::bech32::{self, Hrp};
use bitcoin::bip32::{ChildNumber, DerivationPath, Fingerprint, Xpub};
use bitcoin::hashes::Hash;
use bitcoin::key::CompressedPublicKey;
use bitcoin::psbt::{Output as PsbtOutput, Psbt};
use bitcoin::secp256k1::{All, Message, PublicKey, Secp256k1};
use bitcoin::sighash::{EcdsaSighashType, SighashCache};
use bitcoin::{PubkeyHash, Script, ScriptBuf, ScriptHash, TxOut, WitnessProgram, WitnessVersion};
use serde::{Deserialize, Serialize};

use crate::btc::{is_our_path, parse_psbt, prevouts as witness_prevouts};
use crate::btc_watch::BtcRawTx;
use crate::error::{Error, Result};
use crate::keys::{hardened, normal, path_string, secp, XprivGuard};
use crate::mnemonic::Seed;
use crate::network::Network;

/// A Bitcoin-derived UTXO chain other than Bitcoin.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UtxoCoin {
    /// Litecoin: BIP84 native SegWit (P2WPKH), `m/84'/2'/account'` (testnet `m/84'/1'/…`).
    Litecoin,
    /// Dogecoin: BIP44 legacy (P2PKH), `m/44'/3'/account'` (testnet `m/44'/1'/…`).
    Dogecoin,
}

impl UtxoCoin {
    /// Ticker (`LTC`, `DOGE`).
    pub fn symbol(self) -> &'static str {
        match self {
            UtxoCoin::Litecoin => "LTC",
            UtxoCoin::Dogecoin => "DOGE",
        }
    }

    /// Display name.
    pub fn name(self) -> &'static str {
        match self {
            UtxoCoin::Litecoin => "Litecoin",
            UtxoCoin::Dogecoin => "Dogecoin",
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Policy constants (Litecoin Core 0.21 `policy/policy.h`, `validation.h`; Dogecoin Core 1.14
// `policy/policy.h` and doc/fee-recommendation.md). Amounts in the smallest unit.
// ---------------------------------------------------------------------------------------------

/// Litecoin minimum relay fee: 1 000 litoshis/kvB (1 litoshi/vB).
pub const LTC_MIN_RELAY_FEE_PER_KVB: u64 = 1_000;
/// Litecoin dust relay fee (`DUST_RELAY_TX_FEE`): 30 000 litoshis/kvB, 10× Bitcoin's.
pub const LTC_DUST_RELAY_FEE_PER_KVB: u64 = 30_000;
/// Dogecoin recommended minimum fee (`RECOMMENDED_MIN_TX_FEE`): 0.01 DOGE/kB.
pub const DOGE_RECOMMENDED_FEE_PER_KB: u64 = 1_000_000;
/// Dogecoin default minimum relay fee: 0.001 DOGE/kB.
pub const DOGE_MIN_RELAY_FEE_PER_KB: u64 = 100_000;
/// Dogecoin soft dust limit: 0.01 DOGE. Each output below it costs an extra 0.01 DOGE of fee.
pub const DOGE_SOFT_DUST: u64 = 1_000_000;
/// Dogecoin hard dust limit: 0.001 DOGE. Outputs below it are non-standard (not relayed).
pub const DOGE_HARD_DUST: u64 = 100_000;

/// Above this fee rate (smallest unit per 1 000 vB / B) the summary asks for a reinforced
/// confirmation: 100 litoshis/vB (≈ 100× today's rate), 1 DOGE/kB (100× the recommended fee).
fn high_fee_per_kb(coin: UtxoCoin) -> u64 {
    match coin {
        UtxoCoin::Litecoin => 100_000,
        UtxoCoin::Dogecoin => 100_000_000,
    }
}

/// Smallest standard (non-dust) value for an output with `script`, as the node computes it.
/// Litecoin: `GetDustThreshold` with `DUST_RELAY_TX_FEE` (2 940 litoshis for P2WPKH, 5 460
/// for P2PKH). Dogecoin: the hard dust limit. `OP_RETURN` outputs: 0.
pub fn utxo_dust_threshold(coin: UtxoCoin, script: &Script) -> u64 {
    if script.is_op_return() {
        return 0;
    }
    match coin {
        UtxoCoin::Dogecoin => DOGE_HARD_DUST,
        UtxoCoin::Litecoin => {
            let len = script.len() as u64;
            let varint = match len {
                0..=0xfc => 1,
                0xfd..=0xffff => 3,
                _ => 5,
            };
            let out_size = 8 + varint + len;
            // Spending input size: 32+4+1+(107/4)+4 for a witness program, else 148.
            let spend = if script.is_witness_program() { 67 } else { 148 };
            (out_size + spend) * LTC_DUST_RELAY_FEE_PER_KVB / 1_000
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Chain parameters
// ---------------------------------------------------------------------------------------------

struct Params {
    p2pkh: u8,
    p2sh: u8,
    hrp: Option<&'static str>,
    purpose: u32,
    coin_type: u32,
    genesis: &'static str,
}

fn params(coin: UtxoCoin, net: Network) -> Params {
    match (coin, net) {
        (UtxoCoin::Litecoin, Network::Mainnet) => Params {
            p2pkh: 48,
            p2sh: 50,
            hrp: Some("ltc"),
            purpose: 84,
            coin_type: 2,
            genesis: "12a765e31ffd4059bada1e25190f6e98c99d9714d334efa41a195a7e7e04bfe2",
        },
        (UtxoCoin::Litecoin, Network::Testnet) => Params {
            p2pkh: 111,
            p2sh: 58,
            hrp: Some("tltc"),
            purpose: 84,
            coin_type: 1,
            genesis: "4966625a4b2851d9fdee139e56211a0d88575f59ed816ff5e6a63deb4e3e29a0",
        },
        (UtxoCoin::Dogecoin, Network::Mainnet) => Params {
            p2pkh: 30,
            p2sh: 22,
            hrp: None,
            purpose: 44,
            coin_type: 3,
            genesis: "1a91e3dace36e2be3bf030a65679fe821aa1d6ef92e7c9902eb318182c355691",
        },
        (UtxoCoin::Dogecoin, Network::Testnet) => Params {
            p2pkh: 113,
            p2sh: 196,
            hrp: None,
            purpose: 44,
            coin_type: 1,
            genesis: "bb0a78264637406b6360aad926284d544d7049f45189db5664f3c4d07350559e",
        },
    }
}

/// Genesis block hash (display order) of `coin` on `net` (Litecoin testnet = testnet4).
pub fn utxo_genesis_hash(net: Network, coin: UtxoCoin) -> &'static str {
    params(coin, net).genesis
}

// ---------------------------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------------------------

fn base58(version: u8, hash: &[u8]) -> String {
    let mut data = Vec::with_capacity(1 + hash.len());
    data.push(version);
    data.extend_from_slice(hash);
    bitcoin::base58::encode_check(&data)
}

fn hrp(p: &Params) -> Option<Hrp> {
    p.hrp.and_then(|h| Hrp::parse(h).ok())
}

/// Address of a scriptPubKey on `coin`/`net`, if it is a standard address script
/// (P2PKH, P2SH, and on Litecoin any SegWit witness program).
pub fn utxo_address_of_script(script: &[u8], net: Network, coin: UtxoCoin) -> Option<String> {
    let p = params(coin, net);
    let spk = Script::from_bytes(script);
    if spk.is_p2pkh() {
        return Some(base58(p.p2pkh, &script[3..23]));
    }
    if spk.is_p2sh() {
        return Some(base58(p.p2sh, &script[2..22]));
    }
    let (Some(hrp), Some(version)) = (hrp(&p), spk.witness_version()) else {
        return None;
    };
    bech32::segwit::encode(hrp, version.to_fe(), &script[2..]).ok()
}

/// scriptPubKey of a destination address valid for `coin` on `net`. Litecoin: `ltc1…`/`tltc1…`
/// (any witness version, BIP173/BIP350 checksums), `L…`/`M…` (`m…`/`n…`/`Q…` on testnet);
/// legacy `3…`/`2…` P2SH and MWEB addresses are refused. Dogecoin: `D…`/`9…`/`A…`
/// (`n…`/`2…` on testnet).
pub fn utxo_script_pubkey(address: &str, net: Network, coin: UtxoCoin) -> Result<ScriptBuf> {
    let p = params(coin, net);
    let a = address.trim();
    let other = || Error::input(format!("{} address is for another network", coin.name()));
    if let Some(want) = hrp(&p) {
        if let Ok((found, version, program)) = bech32::segwit::decode(a) {
            if found != want {
                return Err(other());
            }
            let version = WitnessVersion::try_from(version)
                .map_err(|_| Error::input("invalid witness version"))?;
            let wp = WitnessProgram::new(version, &program)
                .map_err(|_| Error::input("invalid witness program"))?;
            return Ok(ScriptBuf::new_witness_program(&wp));
        }
        if a.to_ascii_lowercase().starts_with("ltcmweb")
            || a.to_ascii_lowercase().starts_with("tmweb")
        {
            return Err(Error::input("MWEB addresses are not supported"));
        }
    }
    let raw = bitcoin::base58::decode_check(a)
        .map_err(|_| Error::input(format!("invalid {} address", coin.name())))?;
    if raw.len() != 21 {
        return Err(Error::input(format!("invalid {} address", coin.name())));
    }
    let mut hash = [0u8; 20];
    hash.copy_from_slice(&raw[1..]);
    if raw[0] == p.p2pkh {
        Ok(ScriptBuf::new_p2pkh(&PubkeyHash::from_byte_array(hash)))
    } else if raw[0] == p.p2sh {
        Ok(ScriptBuf::new_p2sh(&ScriptHash::from_byte_array(hash)))
    } else {
        Err(other())
    }
}

/// Public description of a Litecoin/Dogecoin account (watch-only data).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UtxoAccount {
    /// Chain.
    pub coin: UtxoCoin,
    /// Account-level extended public key, standard `xpub`/`tpub` encoding.
    pub xpub: String,
    /// Master key fingerprint, 8 lowercase hex chars.
    pub fingerprint: String,
    /// Account path, e.g. `m/84'/2'/0'` or `m/44'/3'/0'`.
    pub path: String,
}

fn account_path(p: &Params, account: u32) -> Result<[ChildNumber; 3]> {
    Ok([
        hardened(p.purpose)?,
        hardened(p.coin_type)?,
        hardened(account)?,
    ])
}

fn account_xpub(
    secp: &Secp256k1<All>,
    seed: &Seed,
    net: Network,
    p: &Params,
    account: u32,
) -> Result<(Xpub, Fingerprint, [ChildNumber; 3])> {
    let path = account_path(p, account)?;
    let master = XprivGuard::master(seed, net.btc_kind())?;
    let acct = master.derive(secp, &path)?;
    Ok((
        Xpub::from_priv(secp, acct.xpriv()),
        master.fingerprint(secp),
        path,
    ))
}

/// Account descriptor for `m/purpose'/coin'/account'`.
pub fn utxo_account(
    seed: &Seed,
    net: Network,
    coin: UtxoCoin,
    account: u32,
) -> Result<UtxoAccount> {
    let secp = secp()?;
    let p = params(coin, net);
    let (xpub, fingerprint, path) = account_xpub(&secp, seed, net, &p, account)?;
    Ok(UtxoAccount {
        coin,
        xpub: xpub.to_string(),
        fingerprint: fingerprint.to_string(),
        path: path_string(&path),
    })
}

/// Our receive (P2WPKH / P2PKH) script for a public key.
fn own_script(coin: UtxoCoin, pk: PublicKey) -> ScriptBuf {
    match coin {
        UtxoCoin::Litecoin => ScriptBuf::new_p2wpkh(&CompressedPublicKey(pk).wpubkey_hash()),
        UtxoCoin::Dogecoin => ScriptBuf::new_p2pkh(&bitcoin::PublicKey::new(pk).pubkey_hash()),
    }
}

fn own_address(coin: UtxoCoin, net: Network, pk: PublicKey) -> Result<String> {
    utxo_address_of_script(own_script(coin, pk).as_bytes(), net, coin)
        .ok_or_else(|| Error::crypto("address encoding failed"))
}

/// Address at `m/purpose'/coin'/account'/change/index` (`change` = internal chain 1).
pub fn utxo_address(
    seed: &Seed,
    net: Network,
    coin: UtxoCoin,
    account: u32,
    change: bool,
    index: u32,
) -> Result<String> {
    let secp = secp()?;
    let (xpub, _, _) = account_xpub(&secp, seed, net, &params(coin, net), account)?;
    let child = xpub
        .derive_pub(&secp, &[normal(u32::from(change))?, normal(index)?])
        .map_err(|_| Error::crypto("public derivation failed"))?;
    own_address(coin, net, child.public_key)
}

/// Address at `<account xpub>/change/index` (public derivation only). Same result as
/// [`utxo_address`] for the same account. Accepts `xpub`/`tpub` only.
pub fn utxo_address_from_xpub(
    xpub: &str,
    net: Network,
    coin: UtxoCoin,
    change: bool,
    index: u32,
) -> Result<String> {
    let xpub = Xpub::from_str(xpub.trim()).map_err(|_| Error::input("invalid account xpub"))?;
    if xpub.network != net.btc_kind() {
        return Err(Error::input("xpub is for another network"));
    }
    let secp = Secp256k1::verification_only();
    let child = xpub
        .derive_pub(&secp, &[normal(u32::from(change))?, normal(index)?])
        .map_err(|_| Error::crypto("public derivation failed"))?;
    own_address(coin, net, child.public_key)
}

/// Decodes a consensus-serialized Litecoin/Dogecoin transaction (hex). Dogecoin has no SegWit:
/// a transaction carrying witness data is refused. Litecoin MWEB-flagged transactions are not
/// supported (refused as malformed).
pub fn utxo_decode_raw_tx(raw_hex: &str, net: Network, coin: UtxoCoin) -> Result<BtcRawTx> {
    let bytes = hex::decode(raw_hex.trim()).map_err(|_| Error::input("transaction is not hex"))?;
    let tx: bitcoin::Transaction = bitcoin::consensus::deserialize(&bytes)
        .map_err(|_| Error::input(format!("malformed {} transaction", coin.name())))?;
    if coin == UtxoCoin::Dogecoin && tx.input.iter().any(|i| !i.witness.is_empty()) {
        return Err(Error::input("Dogecoin transactions have no witness data"));
    }
    let inputs = if tx.is_coinbase() {
        Vec::new()
    } else {
        tx.input
            .iter()
            .map(|i| (i.previous_output.txid.to_string(), i.previous_output.vout))
            .collect()
    };
    let outputs = tx
        .output
        .iter()
        .map(|o| {
            (
                utxo_address_of_script(o.script_pubkey.as_bytes(), net, coin),
                o.value.to_sat(),
                hex::encode(o.script_pubkey.as_bytes()),
            )
        })
        .collect();
    Ok(BtcRawTx {
        txid: tx.compute_txid().to_string(),
        inputs,
        outputs,
    })
}

// ---------------------------------------------------------------------------------------------
// PSBT: decoding and signing
// ---------------------------------------------------------------------------------------------

/// What an output is, as far as Rust can tell.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UtxoOutputKind {
    /// A standard address script of this chain.
    Address,
    /// `OP_RETURN` data (unspendable).
    OpReturn,
    /// Anything else: shown as « inconnu », reinforced confirmation.
    Unknown,
}

/// One output of the decoded transaction.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UtxoOutput {
    /// Address, when the script is a standard address of this chain.
    pub address: Option<String>,
    /// scriptPubKey, hex.
    pub script: String,
    /// Amount in the smallest unit (litoshis, koinus), decimal string.
    pub amount: String,
    /// The output provably pays one of our keys (key origin + derived key + script match).
    pub is_change: bool,
    /// Classification.
    pub kind: UtxoOutputKind,
}

/// Reasons for caution in a decoded transaction.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum UtxoWarning {
    /// Output whose script is not a standard address (reinforced confirmation).
    UnknownOutput {
        /// Output index.
        index: usize,
    },
    /// `OP_RETURN` data output (reinforced confirmation).
    OpReturn {
        /// Output index.
        index: usize,
    },
    /// Input not signed by this wallet: its amount is the PSBT's claim (reinforced confirmation).
    ForeignInput {
        /// Input index.
        index: usize,
    },
    /// Dogecoin output below the soft dust limit (0.01 DOGE): needs an extra 0.01 DOGE of fee
    /// per such output to be relayed (reinforced confirmation).
    SoftDust {
        /// Output index.
        index: usize,
    },
    /// Fee rate above 100× the usual rate, or fee larger than everything sent
    /// (reinforced confirmation).
    HighFee,
    /// Fee below the network's relay minimum: the transaction will probably not propagate
    /// (informative).
    FeeBelowMinimum {
        /// Smallest fee the nodes accept for this transaction, decimal string.
        minimum: String,
    },
}

/// Plain-language summary of a Litecoin/Dogecoin PSBT, computed by Rust.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UtxoTxSummary {
    /// Chain.
    pub coin: UtxoCoin,
    /// Every output, in order.
    pub outputs: Vec<UtxoOutput>,
    /// Number of inputs.
    pub inputs: usize,
    /// Inputs that this wallet will sign.
    pub our_inputs: usize,
    /// Sum of inputs minus sum of outputs, smallest unit, decimal string.
    pub fee: String,
    /// Estimated size once signed: virtual bytes (Litecoin) or bytes (Dogecoin), worst-case
    /// signature length.
    pub size: u64,
    /// `fee × 1000 / size`: litoshis per kvB, or koinus per kB.
    pub fee_per_kb: u64,
    /// At least one output returns to us. `false`: whatever is not sent is part of the fee
    /// (a remainder below the dust limit cannot be a change output).
    pub has_change: bool,
    /// Reasons for caution.
    pub warnings: Vec<UtxoWarning>,
    /// The confirmation dialog must be followed by a reinforced one.
    pub requires_extra_confirmation: bool,
}

/// Dogecoin: spent outputs from `non_witness_utxo` (mandatory, the legacy sighash does not
/// commit to amounts: the full previous transaction, whose txid must equal the outpoint, is
/// what proves them). `witness_utxo` is refused (no SegWit on Dogecoin).
fn legacy_prevouts(psbt: &Psbt) -> Result<Vec<TxOut>> {
    if psbt.inputs.len() != psbt.unsigned_tx.input.len() {
        return Err(Error::psbt("input count mismatch"));
    }
    let mut out = Vec::with_capacity(psbt.inputs.len());
    for (i, (input, txin)) in psbt.inputs.iter().zip(&psbt.unsigned_tx.input).enumerate() {
        if input.witness_utxo.is_some() || input.final_script_witness.is_some() {
            return Err(Error::psbt(format!(
                "input {i}: Dogecoin has no SegWit (witness data refused)"
            )));
        }
        let prev = input
            .non_witness_utxo
            .as_ref()
            .ok_or_else(|| Error::psbt(format!("input {i} lacks non_witness_utxo")))?;
        if prev.compute_txid() != txin.previous_output.txid {
            return Err(Error::psbt(format!(
                "input {i}: non_witness_utxo does not match the outpoint"
            )));
        }
        let utxo = usize::try_from(txin.previous_output.vout)
            .ok()
            .and_then(|v| prev.output.get(v))
            .ok_or_else(|| Error::psbt(format!("input {i}: vout out of range")))?;
        out.push(utxo.clone());
    }
    Ok(out)
}

fn spent_outputs(coin: UtxoCoin, psbt: &Psbt) -> Result<Vec<TxOut>> {
    match coin {
        UtxoCoin::Litecoin => witness_prevouts(psbt),
        UtxoCoin::Dogecoin => legacy_prevouts(psbt),
    }
}

/// Worst-case signed size: P2WPKH witness 108 WU (count, 72-byte signature, 33-byte key);
/// P2PKH scriptSig 107 bytes more than the empty one. Unknown inputs are assumed to be ours.
fn estimated_size(coin: UtxoCoin, psbt: &Psbt) -> u64 {
    let base = psbt.unsigned_tx.base_size() as u64;
    let n = psbt.unsigned_tx.input.len() as u64;
    match coin {
        UtxoCoin::Litecoin => {
            let weight = base * 4 + 2 + 108 * n;
            weight.div_ceil(4)
        }
        UtxoCoin::Dogecoin => base + 107 * n,
    }
}

struct Signer {
    secp: Secp256k1<All>,
    master: XprivGuard,
    fingerprint: Fingerprint,
    coin: UtxoCoin,
    purpose: u32,
    coin_type: u32,
    account: u32,
}

impl Signer {
    fn new(seed: &Seed, net: Network, coin: UtxoCoin, account: u32) -> Result<Signer> {
        crate::keys::hardened(account)?;
        let secp = secp()?;
        let master = XprivGuard::master(seed, net.btc_kind())?;
        let fingerprint = master.fingerprint(&secp);
        let p = params(coin, net);
        Ok(Signer {
            secp,
            master,
            fingerprint,
            coin,
            purpose: p.purpose,
            coin_type: p.coin_type,
            account,
        })
    }

    /// Our fingerprint and a path of **this account** (other accounts of the wallet are foreign).
    fn ours(&self, fp: &Fingerprint, path: &DerivationPath) -> bool {
        *fp == self.fingerprint && is_our_path(path, self.purpose, self.coin_type, self.account)
    }

    fn derive(&self, path: &DerivationPath) -> Result<XprivGuard> {
        self.master.derive(&self.secp, path.as_ref())
    }

    fn output_is_ours(&self, spk: &Script, meta: &PsbtOutput) -> Result<bool> {
        for (pk, (fp, path)) in &meta.bip32_derivation {
            if self.ours(fp, path) {
                let k = self.derive(path)?;
                let derived = k.xpriv().private_key.public_key(&self.secp);
                if derived == *pk && own_script(self.coin, derived) == *spk {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }

    /// Our keys for input `i`: every key origin with our fingerprint and path, checked against
    /// the derived key and the spent script. A key origin that claims to be ours but does not
    /// match is an error, never silently skipped.
    fn input_keys(
        &self,
        psbt: &Psbt,
        i: usize,
        prevout: &TxOut,
    ) -> Result<Vec<(PublicKey, DerivationPath)>> {
        let input = &psbt.inputs[i];
        if input.final_script_sig.is_some() || input.final_script_witness.is_some() {
            return Ok(Vec::new()); // already finalized by someone else
        }
        let mut out = Vec::new();
        for (pk, (fp, path)) in &input.bip32_derivation {
            if !self.ours(fp, path) {
                continue;
            }
            let k = self.derive(path)?;
            let derived = k.xpriv().private_key.public_key(&self.secp);
            if derived != *pk {
                return Err(Error::psbt(format!(
                    "input {i}: key origin does not match key"
                )));
            }
            if own_script(self.coin, derived) != prevout.script_pubkey {
                return Err(Error::psbt(format!("input {i}: script is not ours")));
            }
            match input.ecdsa_hash_ty() {
                Ok(EcdsaSighashType::All) => {}
                _ => {
                    return Err(Error::psbt(format!(
                        "input {i}: only SIGHASH_ALL is signed"
                    )))
                }
            }
            out.push((*pk, path.clone()));
        }
        Ok(out)
    }
}

struct Analysis {
    psbt: Psbt,
    prevouts: Vec<TxOut>,
    keys: Vec<Vec<(PublicKey, DerivationPath)>>,
    summary: UtxoTxSummary,
}

fn analyse(signer: &Signer, net: Network, psbt_b64: &str) -> Result<Analysis> {
    let coin = signer.coin;
    let psbt = parse_psbt(psbt_b64)?;
    let prevouts = spent_outputs(coin, &psbt)?;
    if psbt.outputs.len() != psbt.unsigned_tx.output.len() {
        return Err(Error::psbt("output count mismatch"));
    }
    if psbt.unsigned_tx.output.is_empty() {
        return Err(Error::psbt("no output"));
    }

    let mut keys = Vec::with_capacity(prevouts.len());
    let mut warnings = Vec::new();
    let mut total_in: u64 = 0;
    for (i, prevout) in prevouts.iter().enumerate() {
        total_in = total_in
            .checked_add(prevout.value.to_sat())
            .ok_or_else(|| Error::psbt("input amount overflow"))?;
        let k = signer.input_keys(&psbt, i, prevout)?;
        if k.is_empty() {
            warnings.push(UtxoWarning::ForeignInput { index: i });
        }
        keys.push(k);
    }
    let our_inputs = keys.iter().filter(|k| !k.is_empty()).count();
    if our_inputs == 0 {
        return Err(Error::psbt("no input belongs to this wallet"));
    }

    let mut outputs = Vec::with_capacity(psbt.unsigned_tx.output.len());
    let mut total_out: u64 = 0;
    let mut soft_dust = 0u64;
    for (j, (out, meta)) in psbt
        .unsigned_tx
        .output
        .iter()
        .zip(&psbt.outputs)
        .enumerate()
    {
        let value = out.value.to_sat();
        total_out = total_out
            .checked_add(value)
            .ok_or_else(|| Error::psbt("output amount overflow"))?;
        let spk = &out.script_pubkey;
        let address = utxo_address_of_script(spk.as_bytes(), net, coin);
        let kind = if address.is_some() {
            UtxoOutputKind::Address
        } else if spk.is_op_return() {
            warnings.push(UtxoWarning::OpReturn { index: j });
            UtxoOutputKind::OpReturn
        } else {
            warnings.push(UtxoWarning::UnknownOutput { index: j });
            UtxoOutputKind::Unknown
        };
        if value < utxo_dust_threshold(coin, spk) {
            return Err(Error::psbt(format!(
                "output {j}: {value} is below the {} dust limit (non-standard, the network would reject it)",
                coin.name()
            )));
        }
        if coin == UtxoCoin::Dogecoin && kind != UtxoOutputKind::OpReturn && value < DOGE_SOFT_DUST
        {
            soft_dust += 1;
            warnings.push(UtxoWarning::SoftDust { index: j });
        }
        outputs.push(UtxoOutput {
            address,
            script: hex::encode(spk.as_bytes()),
            amount: value.to_string(),
            is_change: signer.output_is_ours(spk, meta)?,
            kind,
        });
    }
    let fee = total_in
        .checked_sub(total_out)
        .ok_or_else(|| Error::psbt("outputs exceed inputs (negative fee)"))?;
    let size = estimated_size(coin, &psbt);
    let fee_per_kb = fee.saturating_mul(1_000) / size.max(1);
    if fee_per_kb > high_fee_per_kb(coin) || fee > total_out {
        warnings.push(UtxoWarning::HighFee);
    }
    let minimum = match coin {
        UtxoCoin::Litecoin => (size * LTC_MIN_RELAY_FEE_PER_KVB).div_ceil(1_000),
        UtxoCoin::Dogecoin => {
            (size * DOGE_MIN_RELAY_FEE_PER_KB).div_ceil(1_000) + soft_dust * DOGE_SOFT_DUST
        }
    };
    if fee < minimum {
        warnings.push(UtxoWarning::FeeBelowMinimum {
            minimum: minimum.to_string(),
        });
    }
    let requires_extra_confirmation = warnings
        .iter()
        .any(|w| !matches!(w, UtxoWarning::FeeBelowMinimum { .. }));
    let has_change = outputs.iter().any(|o| o.is_change);
    let summary = UtxoTxSummary {
        coin,
        outputs,
        inputs: prevouts.len(),
        our_inputs,
        fee: fee.to_string(),
        size,
        fee_per_kb,
        has_change,
        warnings,
        requires_extra_confirmation,
    };
    Ok(Analysis {
        psbt,
        prevouts,
        keys,
        summary,
    })
}

/// Decodes a Litecoin/Dogecoin PSBT for the confirmation dialog, without signing. Needs the
/// seed only to prove which inputs and outputs are ours (key origin + derived key + script),
/// where "ours" means **account `account`** (`m/84'/2'/account'/…`, `m/44'/3'/account'/…`): the
/// wallet's other accounts count as foreign.
///
/// Refused: malformed PSBT; Litecoin input without `witness_utxo`; Dogecoin input without a
/// `non_witness_utxo` matching its outpoint, or with witness data; a key origin of ours that
/// does not match the key or the spent script; a sighash other than `ALL`; an output below the
/// dust limit; negative fee; no input of ours.
pub fn utxo_psbt_summary(
    seed: &Seed,
    net: Network,
    coin: UtxoCoin,
    account: u32,
    psbt_b64: &str,
) -> Result<UtxoTxSummary> {
    let signer = Signer::new(seed, net, coin, account)?;
    Ok(analyse(&signer, net, psbt_b64)?.summary)
}

/// Signs every input of ours (see [`utxo_psbt_summary`] for what is refused): Litecoin with
/// the BIP143 sighash of a P2WPKH input, Dogecoin with the legacy sighash of a P2PKH input,
/// both `SIGHASH_ALL`, each signature verified against the derived key before it is kept.
/// Returns the signed, **not finalized** PSBT (base64) and the same summary as
/// [`utxo_psbt_summary`].
pub fn utxo_sign_psbt(
    seed: &Seed,
    net: Network,
    coin: UtxoCoin,
    account: u32,
    psbt_b64: &str,
) -> Result<(String, UtxoTxSummary)> {
    let signer = Signer::new(seed, net, coin, account)?;
    let Analysis {
        mut psbt,
        prevouts,
        keys,
        summary,
    } = analyse(&signer, net, psbt_b64)?;
    let secp = &signer.secp;
    let tx = psbt.unsigned_tx.clone();
    let mut cache = SighashCache::new(&tx);
    for (i, (prevout, input_keys)) in prevouts.iter().zip(keys).enumerate() {
        for (pk, path) in input_keys {
            let msg = match coin {
                UtxoCoin::Litecoin => Message::from(
                    cache
                        .p2wpkh_signature_hash(
                            i,
                            &prevout.script_pubkey,
                            prevout.value,
                            EcdsaSighashType::All,
                        )
                        .map_err(|_| Error::psbt(format!("input {i}: sighash failed")))?,
                ),
                UtxoCoin::Dogecoin => Message::from(
                    cache
                        .legacy_signature_hash(
                            i,
                            &prevout.script_pubkey,
                            EcdsaSighashType::All.to_u32(),
                        )
                        .map_err(|_| Error::psbt(format!("input {i}: sighash failed")))?,
                ),
            };
            let key = signer.derive(&path)?;
            let sk = &key.xpriv().private_key;
            let signature = secp.sign_ecdsa(&msg, sk);
            secp.verify_ecdsa(&msg, &signature, &pk)
                .map_err(|_| Error::crypto("signature self-check failed"))?;
            psbt.inputs[i].partial_sigs.insert(
                bitcoin::PublicKey::new(pk),
                bitcoin::ecdsa::Signature {
                    signature,
                    sighash_type: EcdsaSighashType::All,
                },
            );
        }
    }
    Ok((psbt.to_string(), summary))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dust_thresholds_match_the_nodes() {
        let p2wpkh = ScriptBuf::from_hex("0014751e76e8199196d454941c45d1b3a323f1433bd6").unwrap();
        let p2pkh =
            ScriptBuf::from_hex("76a914751e76e8199196d454941c45d1b3a323f1433bd688ac").unwrap();
        let op_return = ScriptBuf::from_hex("6a0401020304").unwrap();
        // Litecoin Core: (31 + 67) × 30 and (34 + 148) × 30.
        assert_eq!(utxo_dust_threshold(UtxoCoin::Litecoin, &p2wpkh), 2_940);
        assert_eq!(utxo_dust_threshold(UtxoCoin::Litecoin, &p2pkh), 5_460);
        assert_eq!(utxo_dust_threshold(UtxoCoin::Litecoin, &op_return), 0);
        assert_eq!(utxo_dust_threshold(UtxoCoin::Dogecoin, &p2pkh), 100_000);
        assert_eq!(utxo_dust_threshold(UtxoCoin::Dogecoin, &op_return), 0);
    }

    #[test]
    fn genesis_hashes_are_distinct() {
        let all = [
            utxo_genesis_hash(Network::Mainnet, UtxoCoin::Litecoin),
            utxo_genesis_hash(Network::Testnet, UtxoCoin::Litecoin),
            utxo_genesis_hash(Network::Mainnet, UtxoCoin::Dogecoin),
            utxo_genesis_hash(Network::Testnet, UtxoCoin::Dogecoin),
        ];
        for (i, a) in all.iter().enumerate() {
            assert_eq!(a.len(), 64);
            for b in &all[i + 1..] {
                assert_ne!(a, b);
            }
        }
    }
}
