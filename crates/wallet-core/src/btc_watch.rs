//! Bitcoin watch helpers: Electrum script hashes, Core watch-only descriptors, genesis hashes.

use core::str::FromStr;

use bitcoin::hashes::{sha256, Hash};
use bitcoin::{Address, ScriptBuf};
use serde::{Deserialize, Serialize};

use crate::btc::btc_account;
use crate::error::{Error, Result};
use crate::mnemonic::Seed;
use crate::network::{BtcKind, Network};

/// Electrum "script hash" of a raw scriptPubKey: `sha256(script)`, byte-reversed, hex.
pub fn btc_scripthash_of_script(script: &[u8]) -> String {
    let mut h = sha256::Hash::hash(script).to_byte_array();
    h.reverse();
    hex::encode(h)
}

/// Electrum script hash of an address valid for `net`.
pub fn btc_scripthash(address: &str, net: Network) -> Result<String> {
    Ok(btc_scripthash_of_script(
        btc_script_pubkey(address, net)?.as_bytes(),
    ))
}

/// scriptPubKey of an address valid for `net`.
pub fn btc_script_pubkey(address: &str, net: Network) -> Result<ScriptBuf> {
    let addr = Address::from_str(address.trim())
        .map_err(|_| Error::input("invalid Bitcoin address"))?
        .require_network(net.btc())
        .map_err(|_| Error::input("Bitcoin address is for another network"))?;
    Ok(addr.script_pubkey())
}

/// Address of a scriptPubKey on `net`, if it is a standard address script.
pub fn btc_address_of_script(script: &[u8], net: Network) -> Option<String> {
    Address::from_script(bitcoin::Script::from_bytes(script), net.btc())
        .ok()
        .map(|a| a.to_string())
}

/// Address at `<account xpub>/change/index` (public derivation only), for a watch-only scanner.
pub fn btc_address_from_xpub(
    xpub: &str,
    net: Network,
    kind: BtcKind,
    change: bool,
    index: u32,
) -> Result<String> {
    use bitcoin::bip32::{ChildNumber, Xpub};
    use bitcoin::key::CompressedPublicKey;
    use bitcoin::secp256k1::Secp256k1;
    let xpub = Xpub::from_str(xpub.trim()).map_err(|_| Error::input("invalid account xpub"))?;
    if xpub.network != net.btc_kind() {
        return Err(Error::input("xpub is for another network"));
    }
    let secp = Secp256k1::verification_only();
    let path = [
        ChildNumber::from_normal_idx(u32::from(change)).map_err(|_| Error::input("bad index"))?,
        ChildNumber::from_normal_idx(index)
            .map_err(|_| Error::input("derivation index must be < 2^31"))?,
    ];
    let pk = xpub
        .derive_pub(&secp, &path)
        .map_err(|_| Error::crypto("public derivation failed"))?
        .public_key;
    let hrp = bitcoin::KnownHrp::from(net.btc());
    Ok(match kind {
        BtcKind::Segwit => Address::p2wpkh(&CompressedPublicKey(pk), hrp),
        BtcKind::Taproot => Address::p2tr(&secp, pk.x_only_public_key().0, None, hrp),
    }
    .to_string())
}

/// Genesis hash (hex, display order) for `net`: mainnet, or **testnet4** for testnet.
pub fn btc_genesis_hash(net: Network) -> String {
    let params = match net {
        Network::Mainnet => bitcoin::Network::Bitcoin,
        Network::Testnet => bitcoin::Network::Testnet4,
    };
    bitcoin::constants::genesis_block(params)
        .block_hash()
        .to_string()
}

/// A raw transaction reduced to what a wallet history needs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BtcRawTx {
    /// Transaction id (display order).
    pub txid: String,
    /// Spent outpoints `(txid, vout)`; empty for a coinbase.
    pub inputs: Vec<(String, u32)>,
    /// Outputs `(address if standard, value in sats, scriptPubKey hex)`.
    pub outputs: Vec<(Option<String>, u64, String)>,
}

/// Decodes a consensus-serialized tx (hex); fails on trailing bytes or malformed data.
pub fn btc_decode_raw_tx(raw_hex: &str, net: Network) -> Result<BtcRawTx> {
    let bytes = hex::decode(raw_hex.trim()).map_err(|_| Error::input("transaction is not hex"))?;
    let tx: bitcoin::Transaction = bitcoin::consensus::deserialize(&bytes)
        .map_err(|_| Error::input("malformed Bitcoin transaction"))?;
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
                btc_address_of_script(o.script_pubkey.as_bytes(), net),
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

/// Checks `raw_hex` is one complete tx whose txid (non-witness double SHA-256) is `txid`.
pub fn verify_tx_hex(raw_hex: &str, txid: &str) -> Result<()> {
    let bytes = hex::decode(raw_hex.trim()).map_err(|_| Error::input("transaction is not hex"))?;
    let tx: bitcoin::Transaction = bitcoin::consensus::deserialize(&bytes)
        .map_err(|_| Error::input("malformed transaction"))?;
    let want = bitcoin::Txid::from_str(txid.trim()).map_err(|_| Error::input("invalid txid"))?;
    if tx.compute_txid() != want {
        return Err(Error::input(
            "transaction does not hash to the requested txid",
        ));
    }
    Ok(())
}

/// One ranged output descriptor of the wallet (without checksum).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BtcDescriptor {
    /// Account kind.
    pub kind: BtcKind,
    /// `true` for the change (internal) chain `/1/*`.
    pub internal: bool,
    /// e.g. `wpkh([73c5da0a/84h/1h/0h]tpub…/0/*)`; checksum appended by the caller.
    pub descriptor: String,
}

/// BIP84 `wpkh` / BIP86 `tr` receive and change descriptors from account xpubs, with key origin.
pub fn btc_descriptors(seed: &Seed, net: Network, account: u32) -> Result<Vec<BtcDescriptor>> {
    let mut out = Vec::with_capacity(4);
    for kind in [BtcKind::Segwit, BtcKind::Taproot] {
        let acct = btc_account(seed, net, kind, account)?;
        let origin = acct.path.trim_start_matches("m/").replace('\'', "h");
        let func = match kind {
            BtcKind::Segwit => "wpkh",
            BtcKind::Taproot => "tr",
        };
        for internal in [false, true] {
            out.push(BtcDescriptor {
                kind,
                internal,
                descriptor: format!(
                    "{func}([{}/{origin}]{}/{}/*)",
                    acct.fingerprint,
                    acct.xpub,
                    u8::from(internal)
                ),
            });
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn electrum_documented_examples() {
        // Electrum protocol docs, "Script Hashes": genesis P2PKH address.
        let script = hex::decode("76a91462e907b15cbf27d5425399ebf6f0fb50ebb88f1888ac").unwrap();
        assert_eq!(
            btc_scripthash_of_script(&script),
            "8b01df4e368ea28f8dc0423bcf7a4923e3a12d307c875e47a0cfbf90b5c39161"
        );
        assert_eq!(
            btc_scripthash("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", Network::Mainnet).unwrap(),
            "8b01df4e368ea28f8dc0423bcf7a4923e3a12d307c875e47a0cfbf90b5c39161"
        );
        // Electrum protocol docs, "Status" example (regtest bcrt1qn7d2x…ladrd3).
        let script = hex::decode("00149f9aa3795e57c535d2f7b160ff023804c60fca6e").unwrap();
        assert_eq!(
            btc_scripthash_of_script(&script),
            "f04bf26fc16a27abaa2f10540da7a24e369e6ec408f2d901202a7c0cd4a6112d"
        );
        assert!(btc_scripthash("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", Network::Testnet).is_err());
        assert!(btc_scripthash("nope", Network::Mainnet).is_err());
    }

    #[test]
    fn genesis_hashes() {
        // Cross-checked against mempool.space `/api/block-height/0` and `/testnet4/api/...`.
        assert_eq!(
            btc_genesis_hash(Network::Mainnet),
            "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f"
        );
        assert_eq!(
            btc_genesis_hash(Network::Testnet),
            "00000000da84f2bafbbc53dee25a72ae507ff4914b867c565be350b0da8bf043"
        );
    }

    #[test]
    fn decode_genesis_coinbase_and_errors() {
        // Genesis coinbase transaction (mainnet), txid 4a5e1e4b…da33b.
        let raw = concat!(
            "01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff",
            "4d04ffff001d0104455468652054696d65732030332f4a616e2f32303039204368616e63656c6c6f72",
            "206f6e206272696e6b206f66207365636f6e64206261696c6f757420666f722062616e6b73ffffffff",
            "0100f2052a01000000434104678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f",
            "61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5fac00000000"
        );
        let t = btc_decode_raw_tx(raw, Network::Mainnet).unwrap();
        assert_eq!(
            t.txid,
            "4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b"
        );
        assert!(t.inputs.is_empty());
        assert_eq!(t.outputs.len(), 1);
        assert_eq!(t.outputs[0].1, 5_000_000_000);
        assert_eq!(t.outputs[0].0, None); // bare P2PK has no address
        assert!(btc_decode_raw_tx("zz", Network::Mainnet).is_err());
        assert!(btc_decode_raw_tx(&raw[..raw.len() - 2], Network::Mainnet).is_err());
        assert!(btc_decode_raw_tx(&format!("{raw}00"), Network::Mainnet).is_err());
    }

    #[test]
    fn raw_transaction_must_hash_to_the_requested_txid() {
        // Genesis coinbase of `decode_genesis_coinbase_and_errors`.
        let raw = concat!(
            "01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff",
            "4d04ffff001d0104455468652054696d65732030332f4a616e2f32303039204368616e63656c6c6f72",
            "206f6e206272696e6b206f66207365636f6e64206261696c6f757420666f722062616e6b73ffffffff",
            "0100f2052a01000000434104678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f",
            "61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5fac00000000"
        );
        let txid = "4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b";
        assert!(verify_tx_hex(raw, txid).is_ok());
        assert!(verify_tx_hex(&format!(" {raw}\n"), &txid.to_uppercase()).is_ok());
        // Another txid, a tampered byte (amount), trailing bytes, garbage: refused.
        let other = "0000000000000000000000000000000000000000000000000000000000000001";
        assert!(verify_tx_hex(raw, other).is_err());
        let tampered = raw.replacen("00f2052a01", "00f2052a02", 1);
        assert!(verify_tx_hex(&tampered, txid).is_err());
        assert!(verify_tx_hex(&format!("{raw}00"), txid).is_err());
        assert!(verify_tx_hex("zz", txid).is_err());
        assert!(verify_tx_hex(raw, "../x").is_err());
    }

    #[test]
    fn script_address_roundtrip() {
        let s = btc_script_pubkey(
            "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu",
            Network::Mainnet,
        )
        .unwrap();
        assert_eq!(
            btc_address_of_script(s.as_bytes(), Network::Mainnet).as_deref(),
            Some("bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu")
        );
        assert_eq!(
            btc_address_of_script(&[0x6a, 0x01, 0x00], Network::Mainnet),
            None
        );
    }
}
