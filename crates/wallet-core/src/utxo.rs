//! Litecoin (BIP84 P2WPKH), Dogecoin, Bitcoin Cash and Dash (BIP44 legacy P2PKH).

use core::str::FromStr;

use bitcoin::bech32::{self, Hrp};
use bitcoin::bip32::{ChildNumber, DerivationPath, Fingerprint, Xpub};
use bitcoin::consensus::Decodable;
use bitcoin::hashes::{sha256d, Hash};
use bitcoin::key::CompressedPublicKey;
use bitcoin::psbt::{Output as PsbtOutput, Psbt};
use bitcoin::secp256k1::{All, Message, PublicKey, Secp256k1};
use bitcoin::sighash::{EcdsaSighashType, SighashCache};
use bitcoin::{
    Amount, PubkeyHash, Script, ScriptBuf, ScriptHash, Transaction, TxIn, TxOut, Txid,
    WitnessProgram, WitnessVersion,
};
use serde::{Deserialize, Serialize};

use crate::btc::{
    is_our_path, is_unknown_witness, ownership, parse_psbt, prevouts as witness_prevouts, Ownership,
};
use crate::btc_watch::BtcRawTx;
use crate::cashaddr::{self, CashKind};
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
    /// Bitcoin Cash: BIP44 P2PKH/CashAddr, `m/44'/145'/account'` (chipnet `1'`), `ALL|FORKID`.
    #[serde(rename = "bitcoincash")]
    BitcoinCash,
    /// Dash: BIP44 legacy (P2PKH), `m/44'/5'/account'` (testnet `m/44'/1'/…`).
    Dash,
}

impl UtxoCoin {
    /// Ticker (`LTC`, `DOGE`, `BCH`, `DASH`).
    pub fn symbol(self) -> &'static str {
        match self {
            UtxoCoin::Litecoin => "LTC",
            UtxoCoin::Dogecoin => "DOGE",
            UtxoCoin::BitcoinCash => "BCH",
            UtxoCoin::Dash => "DASH",
        }
    }

    /// Display name.
    pub fn name(self) -> &'static str {
        match self {
            UtxoCoin::Litecoin => "Litecoin",
            UtxoCoin::Dogecoin => "Dogecoin",
            UtxoCoin::BitcoinCash => "Bitcoin Cash",
            UtxoCoin::Dash => "Dash",
        }
    }

    /// Every chain of this module.
    pub const ALL: [UtxoCoin; 4] = [
        UtxoCoin::Litecoin,
        UtxoCoin::Dogecoin,
        UtxoCoin::BitcoinCash,
        UtxoCoin::Dash,
    ];

    fn is_legacy(self) -> bool {
        !matches!(self, UtxoCoin::Litecoin)
    }
}

// Policy constants (Litecoin Core 0.21 `policy.h`; Dogecoin Core 1.14 fee-recommendation.md).

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
/// Bitcoin Cash Node and Dash Core minimum relay fee: 1 000 satoshis (duffs) per kB.
pub const BCH_DASH_MIN_RELAY_FEE_PER_KB: u64 = 1_000;
/// BCHN/Dash Core `DUST_RELAY_TX_FEE` (3 000/kB): 546 for a P2PKH output, 540 for P2SH.
pub const BCH_DASH_DUST_RELAY_FEE_PER_KB: u64 = 3_000;

fn high_fee_per_kb(coin: UtxoCoin) -> u64 {
    match coin {
        UtxoCoin::Litecoin | UtxoCoin::BitcoinCash | UtxoCoin::Dash => 100_000,
        UtxoCoin::Dogecoin => 100_000_000,
    }
}

/// Smallest standard (non-dust) value for an output with `script`, as the node computes it.
pub fn utxo_dust_threshold(coin: UtxoCoin, script: &Script) -> u64 {
    if script.is_op_return() {
        return 0;
    }
    let len = script.len() as u64;
    let varint = match len {
        0..=0xfc => 1,
        0xfd..=0xffff => 3,
        _ => 5,
    };
    let out_size = 8 + varint + len;
    match coin {
        UtxoCoin::Dogecoin => DOGE_HARD_DUST,
        UtxoCoin::Litecoin => {
            // Spending input size: 32+4+1+(107/4)+4 for a witness program, else 148.
            let spend = if script.is_witness_program() { 67 } else { 148 };
            (out_size + spend) * LTC_DUST_RELAY_FEE_PER_KVB / 1_000
        }
        // No SegWit: every input is counted at 148 bytes.
        UtxoCoin::BitcoinCash | UtxoCoin::Dash => {
            (out_size + 148) * BCH_DASH_DUST_RELAY_FEE_PER_KB / 1_000
        }
    }
}

struct Params {
    /// Base58 versions (unused for Bitcoin Cash, which only speaks CashAddr).
    p2pkh: u8,
    p2sh: u8,
    hrp: Option<&'static str>,
    /// CashAddr prefix (Bitcoin Cash only).
    cashaddr: Option<&'static str>,
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
            cashaddr: None,
            purpose: 84,
            coin_type: 2,
            genesis: "12a765e31ffd4059bada1e25190f6e98c99d9714d334efa41a195a7e7e04bfe2",
        },
        (UtxoCoin::Litecoin, Network::Testnet) => Params {
            p2pkh: 111,
            p2sh: 58,
            hrp: Some("tltc"),
            cashaddr: None,
            purpose: 84,
            coin_type: 1,
            genesis: "4966625a4b2851d9fdee139e56211a0d88575f59ed816ff5e6a63deb4e3e29a0",
        },
        (UtxoCoin::Dogecoin, Network::Mainnet) => Params {
            p2pkh: 30,
            p2sh: 22,
            hrp: None,
            cashaddr: None,
            purpose: 44,
            coin_type: 3,
            genesis: "1a91e3dace36e2be3bf030a65679fe821aa1d6ef92e7c9902eb318182c355691",
        },
        (UtxoCoin::Dogecoin, Network::Testnet) => Params {
            p2pkh: 113,
            p2sh: 196,
            hrp: None,
            cashaddr: None,
            purpose: 44,
            coin_type: 1,
            genesis: "bb0a78264637406b6360aad926284d544d7049f45189db5664f3c4d07350559e",
        },
        (UtxoCoin::BitcoinCash, Network::Mainnet) => Params {
            p2pkh: 0,
            p2sh: 5,
            hrp: None,
            cashaddr: Some("bitcoincash"),
            purpose: 44,
            coin_type: 145,
            genesis: "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f",
        },
        (UtxoCoin::BitcoinCash, Network::Testnet) => Params {
            p2pkh: 111,
            p2sh: 196,
            hrp: None,
            cashaddr: Some("bchtest"),
            purpose: 44,
            coin_type: 1,
            genesis: "000000001dd410c49a788668ce26751718cc797474d3152a5fc073dd44fd9f7b",
        },
        (UtxoCoin::Dash, Network::Mainnet) => Params {
            p2pkh: 76,
            p2sh: 16,
            hrp: None,
            cashaddr: None,
            purpose: 44,
            coin_type: 5,
            genesis: "00000ffd590b1485b3caadc19b22e6379c733355108f107a430458cdf3407ab6",
        },
        (UtxoCoin::Dash, Network::Testnet) => Params {
            p2pkh: 140,
            p2sh: 19,
            hrp: None,
            cashaddr: None,
            purpose: 44,
            coin_type: 1,
            genesis: "00000bafbc94add76cb75e2ec92894837288a481e5c005f6563d91623bf8bc2c",
        },
    }
}

/// Genesis hash (display order) of `coin`/`net` (LTC testnet4; BCH chipnet = testnet4's).
pub fn utxo_genesis_hash(net: Network, coin: UtxoCoin) -> &'static str {
    params(coin, net).genesis
}

/// Checkpoint `(height, hash)` where genesis is shared: BCH main 478 559, chipnet 200 000.
pub fn utxo_checkpoint(net: Network, coin: UtxoCoin) -> Option<(u64, &'static str)> {
    match (coin, net) {
        (UtxoCoin::BitcoinCash, Network::Mainnet) => Some((
            478_559,
            "000000000000000000651ef99cb9fcbe0dadde1d424bd9f15ff20136191a5eec",
        )),
        (UtxoCoin::BitcoinCash, Network::Testnet) => Some((
            200_000,
            "000000005d7d99462a40e3fc6219070ad619bdc7f4c27b5474ac269fc9357c05",
        )),
        _ => None,
    }
}

/// Double-SHA256 block hash of an 80-byte hex header (BTC/BCH; Dash X11 ids not checked).
pub fn utxo_header_hash(header_hex: &str) -> Result<String> {
    let bytes = hex::decode(header_hex.trim()).map_err(|_| Error::input("header is not hex"))?;
    let header: bitcoin::block::Header = bitcoin::consensus::deserialize(&bytes)
        .map_err(|_| Error::input("malformed block header"))?;
    Ok(header.block_hash().to_string())
}

fn base58(version: u8, hash: &[u8]) -> String {
    let mut data = Vec::with_capacity(1 + hash.len());
    data.push(version);
    data.extend_from_slice(hash);
    bitcoin::base58::encode_check(&data)
}

fn hrp(p: &Params) -> Option<Hrp> {
    p.hrp.and_then(|h| Hrp::parse(h).ok())
}

/// Address of a standard scriptPubKey (P2PKH, P2SH, any SegWit program on Litecoin).
pub fn utxo_address_of_script(script: &[u8], net: Network, coin: UtxoCoin) -> Option<String> {
    let p = params(coin, net);
    let spk = Script::from_bytes(script);
    if let Some(prefix) = p.cashaddr {
        let (kind, hash) = if spk.is_p2pkh() {
            (CashKind::P2pkh, &script[3..23])
        } else if spk.is_p2sh() {
            (CashKind::P2sh, &script[2..22])
        } else {
            // P2SH32, CashTokens-prefixed and every other script: not an ordinary address.
            return None;
        };
        let hash: &[u8; 20] = hash.try_into().ok()?;
        return cashaddr::encode(prefix, kind, hash).ok();
    }
    if spk.is_p2pkh() {
        return Some(base58(p.p2pkh, &script[3..23]));
    }
    if spk.is_p2sh() {
        return Some(base58(p.p2sh, &script[2..22]));
    }
    let (Some(hrp), Some(version)) = (hrp(&p), spk.witness_version()) else {
        return None;
    };
    // Witness v2+ (and v1 other than taproot): not shown as an ordinary address.
    if is_unknown_witness(spk) {
        return None;
    }
    bech32::segwit::encode(hrp, version.to_fe(), &script[2..]).ok()
}

/// scriptPubKey of a destination address valid for `coin` on `net`.
pub fn utxo_script_pubkey(address: &str, net: Network, coin: UtxoCoin) -> Result<ScriptBuf> {
    let p = params(coin, net);
    let a = address.trim();
    let other = || Error::input(format!("{} address is for another network", coin.name()));
    if let Some(prefix) = p.cashaddr {
        return match cashaddr::decode(a, prefix) {
            Ok((CashKind::P2pkh, h)) => Ok(ScriptBuf::new_p2pkh(&PubkeyHash::from_byte_array(h))),
            Ok((CashKind::P2sh, h)) => Ok(ScriptBuf::new_p2sh(&ScriptHash::from_byte_array(h))),
            Err(cashaddr::DecodeError::OtherPrefix(_)) => Err(other()),
            Err(cashaddr::DecodeError::Invalid) if bitcoin::base58::decode_check(a).is_ok() => {
                Err(Error::input(
                    "legacy Bitcoin Cash addresses (1…/3…) are refused: use the CashAddr form \
                 (bitcoincash:…), a legacy address cannot be told apart from a Bitcoin one",
                ))
            }
            Err(cashaddr::DecodeError::Invalid) => Err(Error::input(
                "invalid Bitcoin Cash address (CashAddr expected)",
            )),
        };
    }
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

fn own_script(coin: UtxoCoin, pk: PublicKey) -> ScriptBuf {
    match coin {
        UtxoCoin::Litecoin => ScriptBuf::new_p2wpkh(&CompressedPublicKey(pk).wpubkey_hash()),
        UtxoCoin::Dogecoin | UtxoCoin::BitcoinCash | UtxoCoin::Dash => {
            ScriptBuf::new_p2pkh(&bitcoin::PublicKey::new(pk).pubkey_hash())
        }
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

/// Address at `<account xpub>/change/index` (public derivation only).
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

fn dash_decode(bytes: &[u8]) -> Result<(Transaction, Txid, bool)> {
    let err = || Error::input("malformed Dash transaction");
    let mut r: &[u8] = bytes;
    let version = i32::consensus_decode(&mut r).map_err(|_| err())?;
    let input = Vec::<TxIn>::consensus_decode(&mut r).map_err(|_| err())?;
    let output = Vec::<TxOut>::consensus_decode(&mut r).map_err(|_| err())?;
    let lock_time = bitcoin::absolute::LockTime::consensus_decode(&mut r).map_err(|_| err())?;
    let v = version as u32;
    let special = (v & 0xffff) >= 3 && (v >> 16) != 0;
    if special {
        Vec::<u8>::consensus_decode(&mut r).map_err(|_| err())?;
    }
    if !r.is_empty() {
        return Err(err());
    }
    let tx = Transaction {
        version: bitcoin::transaction::Version(version),
        lock_time,
        input,
        output,
    };
    Ok((tx, Txid::from_raw_hash(sha256d::Hash::hash(bytes)), special))
}

/// Whether `raw_hex` is a Dash DIP2 special tx: shown in history, its outputs unspendable.
pub fn utxo_is_special_tx(raw_hex: &str, coin: UtxoCoin) -> bool {
    coin == UtxoCoin::Dash
        && hex::decode(raw_hex.trim())
            .ok()
            .and_then(|b| dash_decode(&b).ok())
            .is_some_and(|(_, _, special)| special)
}

/// Decodes a consensus-serialized Litecoin / Dogecoin / Bitcoin Cash / Dash transaction (hex).
pub fn utxo_decode_raw_tx(raw_hex: &str, net: Network, coin: UtxoCoin) -> Result<BtcRawTx> {
    let bytes = hex::decode(raw_hex.trim()).map_err(|_| Error::input("transaction is not hex"))?;
    let (tx, txid) = if coin == UtxoCoin::Dash {
        let (tx, txid, _) = dash_decode(&bytes)?;
        (tx, txid)
    } else {
        let tx: Transaction = bitcoin::consensus::deserialize(&bytes)
            .map_err(|_| Error::input(format!("malformed {} transaction", coin.name())))?;
        let txid = tx.compute_txid();
        (tx, txid)
    };
    if coin.is_legacy() && tx.input.iter().any(|i| !i.witness.is_empty()) {
        return Err(Error::input(format!(
            "{} transactions have no witness data",
            coin.name()
        )));
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
        txid: txid.to_string(),
        inputs,
        outputs,
    })
}

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
    /// Dogecoin output below 0.01 DOGE soft dust: +0.01 DOGE fee each (reinforced confirmation).
    SoftDust {
        /// Output index.
        index: usize,
    },
    /// Fee rate over 100× usual, or fee above everything sent (reinforced confirmation).
    HighFee,
    /// Pays our key beyond [`crate::MAX_CHANGE_INDEX`]: not shown as change (reinforced).
    ChangeIndexOutOfRange {
        /// Output index.
        index: usize,
    },
    /// Fee below the relay minimum: will probably not propagate (informative).
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
    /// Estimated signed size: vbytes (Litecoin) or bytes (Dogecoin), worst-case signatures.
    pub size: u64,
    /// `fee × 1000 / size`: litoshis per kvB, or koinus per kB.
    pub fee_per_kb: u64,
    /// At least one output returns to us.
    pub has_change: bool,
    /// Reasons for caution.
    pub warnings: Vec<UtxoWarning>,
    /// The confirmation dialog must be followed by a reinforced one.
    pub requires_extra_confirmation: bool,
}

/// DOGE/DASH/BCH spent outputs from `non_witness_utxo` (txid-verified; never server claims).
fn legacy_prevouts(coin: UtxoCoin, psbt: &Psbt) -> Result<Vec<TxOut>> {
    if psbt.inputs.len() != psbt.unsigned_tx.input.len() {
        return Err(Error::psbt("input count mismatch"));
    }
    let mut out = Vec::with_capacity(psbt.inputs.len());
    for (i, (input, txin)) in psbt.inputs.iter().zip(&psbt.unsigned_tx.input).enumerate() {
        if input.witness_utxo.is_some() || input.final_script_witness.is_some() {
            return Err(Error::psbt(format!(
                "input {i}: {} has no SegWit (witness data refused)",
                coin.name()
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
        UtxoCoin::Dogecoin | UtxoCoin::BitcoinCash | UtxoCoin::Dash => legacy_prevouts(coin, psbt),
    }
}

fn estimated_size(coin: UtxoCoin, psbt: &Psbt) -> u64 {
    let base = psbt.unsigned_tx.base_size() as u64;
    let n = psbt.unsigned_tx.input.len() as u64;
    match coin {
        UtxoCoin::Litecoin => {
            let weight = base * 4 + 2 + 108 * n;
            weight.div_ceil(4)
        }
        UtxoCoin::Dogecoin | UtxoCoin::BitcoinCash | UtxoCoin::Dash => base + 107 * n,
    }
}

enum Keys {
    Seed(XprivGuard),
    Watch(Xpub),
}

struct Signer {
    secp: Secp256k1<All>,
    keys: Keys,
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
            keys: Keys::Seed(master),
            fingerprint,
            coin,
            purpose: p.purpose,
            coin_type: p.coin_type,
            account,
        })
    }

    fn watch(net: Network, coin: UtxoCoin, acc: &UtxoAccount) -> Result<Signer> {
        if acc.coin != coin {
            return Err(Error::input("account is for another chain"));
        }
        let xpub =
            Xpub::from_str(acc.xpub.trim()).map_err(|_| Error::input("invalid account xpub"))?;
        if xpub.network != net.btc_kind() {
            return Err(Error::input("xpub is for another network"));
        }
        let account = match xpub.child_number {
            ChildNumber::Hardened { index } if xpub.depth == 3 => index,
            _ => return Err(Error::input("xpub is not an account-level key")),
        };
        let p = params(coin, net);
        if path_string(&account_path(&p, account)?) != acc.path {
            return Err(Error::input(
                "account path is not the chain's standard path",
            ));
        }
        let fingerprint = Fingerprint::from_str(&acc.fingerprint)
            .map_err(|_| Error::input("invalid master fingerprint"))?;
        Ok(Signer {
            secp: secp()?,
            keys: Keys::Watch(xpub),
            fingerprint,
            coin,
            purpose: p.purpose,
            coin_type: p.coin_type,
            account,
        })
    }

    fn ours(&self, fp: &Fingerprint, path: &DerivationPath) -> bool {
        *fp == self.fingerprint && is_our_path(path, self.purpose, self.coin_type, self.account)
    }

    fn derive(&self, path: &DerivationPath) -> Result<XprivGuard> {
        match &self.keys {
            Keys::Seed(master) => master.derive(&self.secp, path.as_ref()),
            Keys::Watch(_) => Err(Error::crypto(
                "no private key for a hardware wallet account",
            )),
        }
    }

    fn pubkey(&self, path: &DerivationPath) -> Result<PublicKey> {
        match &self.keys {
            Keys::Seed(_) => Ok(self
                .derive(path)?
                .xpriv()
                .private_key
                .public_key(&self.secp)),
            Keys::Watch(xpub) => {
                let tail = path
                    .as_ref()
                    .get(3..)
                    .ok_or_else(|| Error::psbt("derivation path too short"))?;
                Ok(xpub
                    .derive_pub(&self.secp, &tail)
                    .map_err(|_| Error::crypto("public derivation failed"))?
                    .public_key)
            }
        }
    }

    fn output_is_ours(&self, spk: &Script, meta: &PsbtOutput) -> Result<Ownership> {
        for (pk, (fp, path)) in &meta.bip32_derivation {
            if self.ours(fp, path) {
                let derived = self.pubkey(path)?;
                if derived == *pk && own_script(self.coin, derived) == *spk {
                    return Ok(ownership(path));
                }
            }
        }
        Ok(Ownership::Foreign)
    }

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
            let derived = self.pubkey(path)?;
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

fn check_version(coin: UtxoCoin, version: i32) -> Result<()> {
    match coin {
        UtxoCoin::BitcoinCash if !matches!(version, 1 | 2) => Err(Error::psbt(format!(
            "Bitcoin Cash transaction version {version} is invalid (1 or 2)"
        ))),
        UtxoCoin::Dash if (version as u32) >> 16 != 0 => Err(Error::psbt(
            "Dash special transactions (DIP2 type ≠ 0) are not signed",
        )),
        _ => Ok(()),
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
    check_version(coin, psbt.unsigned_tx.version.0)?;

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
        let owner = signer.output_is_ours(spk, meta)?;
        if owner == Ownership::FarIndex {
            warnings.push(UtxoWarning::ChangeIndexOutOfRange { index: j });
        }
        outputs.push(UtxoOutput {
            address,
            script: hex::encode(spk.as_bytes()),
            amount: value.to_string(),
            is_change: owner == Ownership::Change,
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
        UtxoCoin::BitcoinCash | UtxoCoin::Dash => {
            (size * BCH_DASH_MIN_RELAY_FEE_PER_KB).div_ceil(1_000)
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

/// Decodes a LTC/DOGE/BCH/DASH PSBT for the confirmation dialog, without signing.
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

/// `SIGHASH_ALL | SIGHASH_FORKID` (fork id 0), the only BCH sighash since the 2017 split.
pub const BCH_SIGHASH_ALL_FORKID: u32 = 0x41;

/// BCH sighash (`replay-protected-sighash.md`): BIP143 digest with 32-bit sighash type.
pub fn bch_forkid_sighash(
    tx: &Transaction,
    input: usize,
    script_code: &Script,
    value: u64,
    sighash_type: u32,
) -> Result<[u8; 32]> {
    if sighash_type & 0x40 == 0 || sighash_type & 0x20 != 0 {
        return Err(Error::psbt("only FORKID sighash types are supported"));
    }
    let base = EcdsaSighashType::from_consensus(sighash_type & 0x9f);
    let mut pre: Vec<u8> = Vec::new();
    SighashCache::new(tx)
        .segwit_v0_encode_signing_data_to(
            &mut pre,
            input,
            script_code,
            Amount::from_sat(value),
            base,
        )
        .map_err(|_| Error::psbt(format!("input {input}: sighash failed")))?;
    let n = pre.len();
    if n < 4 || pre[n - 4..] != base.to_u32().to_le_bytes() {
        return Err(Error::crypto("unexpected BIP143 preimage"));
    }
    pre[n - 4..].copy_from_slice(&sighash_type.to_le_bytes());
    Ok(sha256d::Hash::hash(&pre).to_byte_array())
}

/// Signs our inputs, each verified: LTC/DOGE/DASH as partial sigs (not finalized);
/// BCH `ALL|FORKID` can't be a PSBT partial sig, so it is finalized here (BIP174).
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
        if coin == UtxoCoin::BitcoinCash && input_keys.len() > 1 {
            // A P2PKH input has exactly one key; two origins of ours cannot both be it.
            return Err(Error::psbt(format!(
                "input {i}: several keys for one P2PKH input"
            )));
        }
        for (pk, path) in input_keys {
            let msg = input_sighash(coin, &mut cache, &tx, i, prevout)?;
            let key = signer.derive(&path)?;
            let sk = &key.xpriv().private_key;
            let signature = secp.sign_ecdsa(&msg, sk);
            secp.verify_ecdsa(&msg, &signature, &pk)
                .map_err(|_| Error::crypto("signature self-check failed"))?;
            put_signature(coin, &mut psbt, i, pk, signature)?;
        }
    }
    Ok((psbt.to_string(), summary))
}

fn input_sighash(
    coin: UtxoCoin,
    cache: &mut SighashCache<&Transaction>,
    tx: &Transaction,
    i: usize,
    prevout: &TxOut,
) -> Result<Message> {
    let failed = |_| Error::psbt(format!("input {i}: sighash failed"));
    Ok(match coin {
        UtxoCoin::Litecoin => Message::from(
            cache
                .p2wpkh_signature_hash(
                    i,
                    &prevout.script_pubkey,
                    prevout.value,
                    EcdsaSighashType::All,
                )
                .map_err(failed)?,
        ),
        UtxoCoin::Dogecoin | UtxoCoin::Dash => Message::from(
            cache
                .legacy_signature_hash(i, &prevout.script_pubkey, EcdsaSighashType::All.to_u32())
                .map_err(|_| Error::psbt(format!("input {i}: sighash failed")))?,
        ),
        UtxoCoin::BitcoinCash => Message::from_digest(bch_forkid_sighash(
            tx,
            i,
            &prevout.script_pubkey,
            prevout.value.to_sat(),
            BCH_SIGHASH_ALL_FORKID,
        )?),
    })
}

fn put_signature(
    coin: UtxoCoin,
    psbt: &mut Psbt,
    i: usize,
    pk: PublicKey,
    signature: bitcoin::secp256k1::ecdsa::Signature,
) -> Result<()> {
    if coin == UtxoCoin::BitcoinCash {
        let mut sig = signature.serialize_der().to_vec();
        sig.push(BCH_SIGHASH_ALL_FORKID as u8);
        let push = bitcoin::script::PushBytesBuf::try_from(sig)
            .map_err(|_| Error::crypto("signature push failed"))?;
        let script_sig = bitcoin::script::Builder::new()
            .push_slice(push)
            .push_key(&bitcoin::PublicKey::new(pk))
            .into_script();
        let input = &mut psbt.inputs[i];
        input.final_script_sig = Some(script_sig);
        input.partial_sigs.clear();
        input.bip32_derivation.clear();
        input.sighash_type = None;
        input.redeem_script = None;
    } else {
        psbt.inputs[i].partial_sigs.insert(
            bitcoin::PublicKey::new(pk),
            bitcoin::ecdsa::Signature {
                signature,
                sighash_type: EcdsaSighashType::All,
            },
        );
    }
    Ok(())
}

pub(crate) fn check_watch_account(net: Network, acc: &UtxoAccount, account: u32) -> Result<()> {
    if Signer::watch(net, acc.coin, acc)?.account != account {
        return Err(Error::input("UTXO xpub is not for this account number"));
    }
    Ok(())
}

/// An input of ours, as a hardware wallet needs it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UtxoHwInput {
    /// Input index.
    pub index: usize,
    /// Full derivation path (raw BIP32 indices, hardened bit set).
    pub path: Vec<u32>,
    /// Compressed public key, derived from the stored xpub.
    pub pubkey: [u8; 33],
    /// Spent amount (verified previous transaction / `witness_utxo`).
    pub amount: u64,
    /// Spent script.
    pub script: Vec<u8>,
}

/// A change output of ours (chain 1 of this account, key and script checked against the xpub).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UtxoHwChange {
    /// Output index.
    pub index: usize,
    /// Full derivation path.
    pub path: Vec<u32>,
}

/// What a hardware wallet signs, decoded and checked against the stored account.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UtxoHwPlan {
    /// Same summary as [`utxo_psbt_summary`].
    pub summary: UtxoTxSummary,
    /// Every input (all are ours: a device signs only its own inputs).
    pub inputs: Vec<UtxoHwInput>,
    /// Change outputs.
    pub change: Vec<UtxoHwChange>,
}

fn raw_path(path: &DerivationPath) -> Vec<u32> {
    path.as_ref().iter().map(|c| u32::from(*c)).collect()
}

/// [`utxo_psbt_summary`] for a hardware account (xpub + fingerprint) with per-input data.
pub fn utxo_hw_plan(
    net: Network,
    coin: UtxoCoin,
    account: &UtxoAccount,
    psbt_b64: &str,
) -> Result<UtxoHwPlan> {
    let signer = Signer::watch(net, coin, account)?;
    let a = analyse(&signer, net, psbt_b64)?;
    let mut inputs = Vec::with_capacity(a.keys.len());
    for (i, (keys, prevout)) in a.keys.iter().zip(&a.prevouts).enumerate() {
        let [(pk, path)] = keys.as_slice() else {
            return Err(Error::psbt(format!(
                "input {i}: a hardware wallet signs only inputs of this account (one key each)"
            )));
        };
        if coin == UtxoCoin::Litecoin {
            let txin = &a.psbt.unsigned_tx.input[i];
            let consistent = a.psbt.inputs[i]
                .non_witness_utxo
                .as_ref()
                .is_some_and(|prev| {
                    prev.compute_txid() == txin.previous_output.txid
                        && prev.output.get(txin.previous_output.vout as usize) == Some(prevout)
                });
            if !consistent {
                return Err(Error::psbt(format!(
                    "input {i}: the previous transaction (non_witness_utxo) is required and must match witness_utxo"
                )));
            }
        }
        inputs.push(UtxoHwInput {
            index: i,
            path: raw_path(path),
            pubkey: pk.serialize(),
            amount: prevout.value.to_sat(),
            script: prevout.script_pubkey.to_bytes(),
        });
    }
    let mut change = Vec::new();
    for (j, (out, meta)) in a
        .psbt
        .unsigned_tx
        .output
        .iter()
        .zip(&a.psbt.outputs)
        .enumerate()
    {
        if !a.summary.outputs[j].is_change {
            continue;
        }
        let path = meta
            .bip32_derivation
            .iter()
            .find(|(pk, (fp, path))| {
                signer.ours(fp, path)
                    && signer.pubkey(path).ok().as_ref() == Some(*pk)
                    && own_script(coin, **pk) == out.script_pubkey
            })
            .map(|(_, (_, path))| raw_path(path))
            .ok_or_else(|| Error::psbt("change output without its key"))?;
        change.push(UtxoHwChange { index: j, path });
    }
    Ok(UtxoHwPlan {
        summary: a.summary,
        inputs,
        change,
    })
}

/// Checks hardware-wallet signatures (once each, DER, `ALL`/BCH `ALL|FORKID`) and stores them.
pub fn utxo_hw_finalize(
    net: Network,
    coin: UtxoCoin,
    account: &UtxoAccount,
    psbt_b64: &str,
    sigs: &[crate::btc_hw::HwBtcSignature],
) -> Result<(String, UtxoTxSummary)> {
    let plan = utxo_hw_plan(net, coin, account, psbt_b64)?;
    let Analysis {
        mut psbt, prevouts, ..
    } = analyse(&Signer::watch(net, coin, account)?, net, psbt_b64)?;
    let tx = psbt.unsigned_tx.clone();
    let mut cache = SighashCache::new(&tx);
    let verifier = Secp256k1::verification_only();
    let mut done = vec![false; plan.inputs.len()];
    let want_type = if coin == UtxoCoin::BitcoinCash {
        BCH_SIGHASH_ALL_FORKID as u8
    } else {
        EcdsaSighashType::All.to_u32() as u8
    };
    for s in sigs {
        let input = plan
            .inputs
            .get(s.input)
            .ok_or_else(|| Error::psbt(format!("signature for unknown input {}", s.input)))?;
        if done[s.input] {
            return Err(Error::psbt(format!("input {}: two signatures", s.input)));
        }
        if s.pubkey.as_ref().is_some_and(|k| k[..] != input.pubkey[..]) {
            return Err(Error::psbt(format!(
                "input {}: signed by another key",
                s.input
            )));
        }
        let der = if bitcoin::secp256k1::ecdsa::Signature::from_der(&s.signature).is_ok() {
            &s.signature[..]
        } else {
            match s.signature.split_last() {
                Some((t, der)) if *t == want_type => der,
                _ => {
                    return Err(Error::psbt(format!(
                        "input {}: not a DER signature with the expected sighash type",
                        s.input
                    )))
                }
            }
        };
        let mut signature = bitcoin::secp256k1::ecdsa::Signature::from_der(der)
            .map_err(|_| Error::psbt(format!("input {}: invalid DER signature", s.input)))?;
        signature.normalize_s();
        let pk = PublicKey::from_slice(&input.pubkey)
            .map_err(|_| Error::crypto("invalid public key"))?;
        let msg = input_sighash(coin, &mut cache, &tx, s.input, &prevouts[s.input])?;
        verifier.verify_ecdsa(&msg, &signature, &pk).map_err(|_| {
            Error::crypto(format!(
                "input {}: the device's signature does not verify",
                s.input
            ))
        })?;
        put_signature(coin, &mut psbt, s.input, pk, signature)?;
        done[s.input] = true;
    }
    if let Some(i) = done.iter().position(|d| !d) {
        return Err(Error::psbt(format!(
            "input {i}: no signature from the device"
        )));
    }
    Ok((psbt.to_string(), plan.summary))
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
        // Bitcoin Cash Node / Dash Core: (34 + 148) × 3 = 546, (32 + 148) × 3 = 540.
        let p2sh = ScriptBuf::from_hex("a914751e76e8199196d454941c45d1b3a323f1433bd687").unwrap();
        for coin in [UtxoCoin::BitcoinCash, UtxoCoin::Dash] {
            assert_eq!(utxo_dust_threshold(coin, &p2pkh), 546);
            assert_eq!(utxo_dust_threshold(coin, &p2sh), 540);
            assert_eq!(utxo_dust_threshold(coin, &op_return), 0);
        }
    }

    #[test]
    fn genesis_hashes_are_distinct() {
        let all: Vec<&str> = UtxoCoin::ALL
            .iter()
            .flat_map(|c| [Network::Mainnet, Network::Testnet].map(|n| utxo_genesis_hash(n, *c)))
            .collect();
        assert_eq!(all.len(), 8);
        for (i, a) in all.iter().enumerate() {
            assert_eq!(a.len(), 64);
            for b in &all[i + 1..] {
                assert_ne!(a, b);
            }
        }
    }
}
