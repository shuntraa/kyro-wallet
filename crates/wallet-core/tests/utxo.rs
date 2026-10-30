//! Litecoin (BIP84) and Dogecoin (BIP44) vectors, real-chain signature checks, PSBT signing.
//!
//! Sources of the expected values (fetched 2026-10-30):
//! - Trust Wallet Core `tests/chains/Litecoin/TWLitecoinTests.cpp` (BIP84 Litecoin account
//!   `m/84'/2'/0'` zpub and its `/0/4`, `/0/11` addresses; lock scripts) and
//!   `tests/common/HDWallet/HDWalletTests.cpp` (`privateKeyFromDGRV`), `TWDogeTests.cpp`;
//! - Trezor firmware `tests/device_tests/bitcoin/test_getaddress.py` (`test_ltc`, `test_tbtc`)
//!   and `test_getaddress_segwit_native.py`, mnemonic `all all … all`;
//! - Electrum-LTC `electrum_ltc/tests/test_wallet_vertical.py`
//!   (`test_bip39_seed_bip84_native_segwit`);
//! - real transactions: Litecoin testnet4 and mainnet (litecoinspace.org), Dogecoin mainnet
//!   (raw hex from api.blockcypher.com, decoded fields cross-checked on sochain.com).

mod common;

use std::str::FromStr;

use bitcoin::bip32::{DerivationPath, Xpriv};
use bitcoin::hashes::{hash160, Hash};
use bitcoin::psbt::{Psbt, PsbtSighashType};
use bitcoin::secp256k1::{ecdsa, Message, PublicKey, Secp256k1};
use bitcoin::sighash::{EcdsaSighashType, SighashCache};
use bitcoin::transaction::Version;
use bitcoin::{
    absolute::LockTime, Amount, NetworkKind, OutPoint, ScriptBuf, Sequence, Transaction, TxIn,
    TxOut, Witness,
};
use common::{seed, ABANDON, LEGAL};
use wallet_core::{
    utxo_account, utxo_address, utxo_address_from_xpub, utxo_address_of_script, utxo_decode_raw_tx,
    utxo_genesis_hash, utxo_psbt_summary, utxo_script_pubkey, utxo_sign_psbt, Error, Mnemonic,
    Network, UtxoCoin, UtxoOutputKind, UtxoWarning,
};

const LTC: UtxoCoin = UtxoCoin::Litecoin;
const DOGE: UtxoCoin = UtxoCoin::Dogecoin;
const ALL: &str = "all all all all all all all all all all all all";

fn reversion(ext: &str, from: [u8; 4], to: [u8; 4]) -> String {
    let mut data = bitcoin::base58::decode_check(ext).unwrap();
    assert_eq!(data[..4], from, "version bytes of {ext}");
    data[..4].copy_from_slice(&to);
    bitcoin::base58::encode_check(&data)
}

fn spk(hex: &str) -> ScriptBuf {
    ScriptBuf::from_hex(hex).unwrap()
}

// ------------------------------------------------------------------------------------------
// Derivation and addresses
// ------------------------------------------------------------------------------------------

/// Trust Wallet Core `Litecoin.ExtendedKeys` / `Litecoin.DeriveFromZpub`.
#[test]
fn litecoin_bip84_account_trust_wallet_vector() {
    let s = Mnemonic::parse(
        "ripple scissors kick mammal hire column oak again sun offer wealth tomorrow wagon turn fatal",
    )
    .unwrap()
    .to_seed("TREZOR");
    let acct = utxo_account(&s, Network::Mainnet, LTC, 0).unwrap();
    assert_eq!(acct.path, "m/84'/2'/0'");
    assert_eq!(acct.coin, LTC);
    let zpub = "zpub6sCFp8chadVDXVt7GRmQFpq8B7W8wMLdFDto1hXu2jLZtvkFhRnwScXARNfrGSeyhR8DBLJnaUUkBbkmB2GwUYkecEAMUcbUpFQV4v7PXcs";
    assert_eq!(
        acct.xpub,
        reversion(zpub, [0x04, 0xb2, 0x47, 0x46], [0x04, 0x88, 0xb2, 0x1e])
    );
    let a = |i| utxo_address(&s, Network::Mainnet, LTC, 0, false, i).unwrap();
    assert_eq!(a(4), "ltc1qcgnevr9rp7aazy62m4gen0tfzlssa52axwytt6");
    assert_eq!(a(11), "ltc1qy072y8968nzp6mz3j292h8lp72d678fcmms6vl");
    // Public derivation from the account xpub gives the same addresses.
    for i in [0, 4, 11] {
        assert_eq!(
            utxo_address_from_xpub(&acct.xpub, Network::Mainnet, LTC, false, i).unwrap(),
            a(i)
        );
    }
}

/// Electrum-LTC `test_bip39_seed_bip84_native_segwit` uses the BIP84 test path `m/84'/0'/0'`:
/// same witness programs as the BIP84 Bitcoin vector, Litecoin `ltc` HRP.
#[test]
fn litecoin_hrp_electrum_ltc_vector() {
    let program = |bc: &str| {
        let (_, _, p) = bitcoin::bech32::segwit::decode(bc).unwrap();
        let mut s = vec![0x00, 0x14];
        s.extend(p);
        s
    };
    let recv = program("bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu");
    let change = program("bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el");
    assert_eq!(
        utxo_address_of_script(&recv, Network::Mainnet, LTC).unwrap(),
        "ltc1qcr8te4kr609gcawutmrza0j4xv80jy8z4nqduv"
    );
    assert_eq!(
        utxo_address_of_script(&change, Network::Mainnet, LTC).unwrap(),
        "ltc1q8c6fshw2dlwun7ekn9qwf37cu2rn755u9ym7p0"
    );
}

/// Trezor `test_ltc` (mnemonic `all ×12`), BIP44 Litecoin P2PKH: checks the `L…` encoding and
/// coin type 2 (Kyro receives on BIP84 only, but must decode `L…` destinations).
#[test]
fn litecoin_p2pkh_trezor_vector() {
    let s = seed(ALL);
    let secp = Secp256k1::new();
    let master = Xpriv::new_master(NetworkKind::Main, &s[..]).unwrap();
    for (path, expected) in [
        ("m/44'/2'/0'/0/0", "LcubERmHD31PWup1fbozpKuiqjHZ4anxcL"),
        ("m/44'/2'/0'/0/1", "LVWBmHBkCGNjSPHucvL2PmnuRAJnucmRE6"),
        ("m/44'/2'/0'/1/0", "LWj6ApswZxay4cJEJES2sGe7fLMLRvvv8h"),
    ] {
        let k = master
            .derive_priv(&secp, &DerivationPath::from_str(path).unwrap())
            .unwrap();
        let pk = bitcoin::PublicKey::new(k.private_key.public_key(&secp));
        let script = ScriptBuf::new_p2pkh(&pk.pubkey_hash());
        assert_eq!(
            utxo_address_of_script(script.as_bytes(), Network::Mainnet, LTC).unwrap(),
            expected
        );
        assert_eq!(
            utxo_script_pubkey(expected, Network::Mainnet, LTC).unwrap(),
            script
        );
    }
}

/// Trust Wallet Core `Litecoin.LockScripts` / `LockScriptForAddress{L,M}`, `Doge.LockScripts`.
#[test]
fn lock_scripts_trust_wallet_vectors() {
    for (coin, addr, script) in [
        (
            LTC,
            "ltc1qs32zgdhe2tpzcnz55r7d9jvhce33063sfht3q0",
            "001484542436f952c22c4c54a0fcd2c997c66317ea30",
        ),
        (
            LTC,
            "MHhghmmCTASDnuwpgsPUNJVPTFaj61GzaG",
            "a9146b85b3dac9340f36b9d32bbacf2ffcb0851ef17987",
        ),
        (
            LTC,
            "LgKiekick9Ka7gYoYzAWGrEq8rFBJzYiyf",
            "76a914e771c6695c5dd189ccc4ef00cd0f3db3096d79bd88ac",
        ),
        (
            DOGE,
            "DLSSSUS3ex7YNDACJDxMER1ZMW579Vy8Zy",
            "76a914a7d191ec42aa113e28cd858cceaa7c733ba2f77788ac",
        ),
        (
            DOGE,
            "AETZJzedcmLM2rxCM6VqCGF3YEMUjA3jMw",
            "a914f191149f72f235548746654f5b473c58258f7fb687",
        ),
    ] {
        assert_eq!(
            utxo_script_pubkey(addr, Network::Mainnet, coin).unwrap(),
            spk(script),
            "{addr}"
        );
        assert_eq!(
            utxo_address_of_script(&spk(script).to_bytes(), Network::Mainnet, coin).unwrap(),
            addr
        );
    }
}

/// Trust Wallet Core `HDWallet.privateKeyFromDGRV`: `dgpv…` account key, `/0/1` → `D5taDnd…`.
#[test]
fn dogecoin_p2pkh_trust_wallet_vector() {
    let dgpv = "dgpv595jAJYGBLanByCJXRzrWBZFVXdNisfuPmKRDquCQcwBbwKbeR21AtkETf4EpjBsfsK3kDZgMqhcuky1B9PrT5nxiEcjghxpUVYviHXuCmc";
    // Dogecoin Core EXT_SECRET_KEY 02fac398 → standard xprv version to parse it.
    let xprv = reversion(dgpv, [0x02, 0xfa, 0xc3, 0x98], [0x04, 0x88, 0xad, 0xe4]);
    let secp = Secp256k1::new();
    let k = Xpriv::from_str(&xprv)
        .unwrap()
        .derive_priv(&secp, &DerivationPath::from_str("m/0/1").unwrap())
        .unwrap();
    let pk = k.private_key.public_key(&secp);
    assert_eq!(
        hex::encode(pk.serialize()),
        "03eb6bf281990ee074a39c71ed8ce78c486066ac433bcf066dd5eb08f87d3a6c34"
    );
    let script = ScriptBuf::new_p2pkh(&bitcoin::PublicKey::new(pk).pubkey_hash());
    assert_eq!(
        utxo_address_of_script(script.as_bytes(), Network::Mainnet, DOGE).unwrap(),
        "D5taDndQJ1fDF3AM1yWavmJY2BgSi17CUv"
    );
    // The same account read as an xpub gives the same address through Kyro's own function.
    let xpub = bitcoin::bip32::Xpub::from_priv(&secp, &Xpriv::from_str(&xprv).unwrap());
    assert_eq!(
        utxo_address_from_xpub(&xpub.to_string(), Network::Mainnet, DOGE, false, 1).unwrap(),
        "D5taDndQJ1fDF3AM1yWavmJY2BgSi17CUv"
    );
}

/// Testnets use SLIP-44 coin type 1: Litecoin testnet `m/84'/1'/0'` has the same keys as the
/// Bitcoin testnet BIP84 account (Trezor vector `tb1qkvwu9…`), Dogecoin testnet `m/44'/1'/0'`
/// the same as Bitcoin testnet BIP44 (Trezor `test_tbtc` `mvbu1Gd…`), with each chain's own
/// encoding (Dogecoin testnet P2PKH version 113 → `n…`).
#[test]
fn testnet_paths_and_encodings() {
    let s = seed(ALL);
    let ltc = utxo_account(&s, Network::Testnet, LTC, 0).unwrap();
    assert_eq!(ltc.path, "m/84'/1'/0'");
    assert!(ltc.xpub.starts_with("tpub"));
    let a = utxo_address(&s, Network::Testnet, LTC, 0, false, 0).unwrap();
    assert!(a.starts_with("tltc1q"), "{a}");
    let (_, _, btc_prog) =
        bitcoin::bech32::segwit::decode("tb1qkvwu9g3k2pdxewfqr7syz89r3gj557l3uuf9r9").unwrap();
    let (_, _, ltc_prog) = bitcoin::bech32::segwit::decode(&a).unwrap();
    assert_eq!(btc_prog, ltc_prog);
    let change = utxo_address(&s, Network::Testnet, LTC, 0, true, 0).unwrap();
    let (_, _, c) = bitcoin::bech32::segwit::decode(&change).unwrap();
    let (_, _, btc_c) =
        bitcoin::bech32::segwit::decode("tb1qejqxwzfld7zr6mf7ygqy5s5se5xq7vmt96jk9x").unwrap();
    assert_eq!(c, btc_c);

    let doge = utxo_account(&s, Network::Testnet, DOGE, 0).unwrap();
    assert_eq!(doge.path, "m/44'/1'/0'");
    let d = utxo_address(&s, Network::Testnet, DOGE, 0, false, 0).unwrap();
    assert!(d.starts_with('n'), "{d}");
    let raw = bitcoin::base58::decode_check(&d).unwrap();
    assert_eq!(raw[0], 113);
    let btc = bitcoin::base58::decode_check("mvbu1Gdy8SUjTenqerxUaZyYjmveZvt33q").unwrap();
    assert_eq!(raw[1..], btc[1..]);

    // Mainnet paths.
    assert_eq!(
        utxo_account(&s, Network::Mainnet, DOGE, 0).unwrap().path,
        "m/44'/3'/0'"
    );
    assert!(utxo_address(&s, Network::Mainnet, DOGE, 0, false, 0)
        .unwrap()
        .starts_with('D'));
    assert_eq!(
        utxo_account(&s, Network::Mainnet, LTC, 3).unwrap().path,
        "m/84'/2'/3'"
    );
}

#[test]
fn addresses_of_other_chains_are_refused() {
    let m = Network::Mainnet;
    let t = Network::Testnet;
    let refused = [
        // Bitcoin addresses on Litecoin, including the legacy P2SH `3…` form.
        (LTC, m, "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu"),
        (LTC, m, "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"),
        (LTC, m, "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy"),
        // Testnet on mainnet and vice versa.
        (LTC, m, "tltc1qv99w6gxa67tgy89xgrmtcf9nydnsws7sflulmg"),
        (LTC, t, "ltc1qcgnevr9rp7aazy62m4gen0tfzlssa52axwytt6"),
        (DOGE, t, "D5taDndQJ1fDF3AM1yWavmJY2BgSi17CUv"),
        // Cross-chain.
        (DOGE, m, "LcubERmHD31PWup1fbozpKuiqjHZ4anxcL"),
        (DOGE, m, "ltc1qcgnevr9rp7aazy62m4gen0tfzlssa52axwytt6"),
        (LTC, m, "D5taDndQJ1fDF3AM1yWavmJY2BgSi17CUv"),
        // Broken checksums.
        (LTC, m, "ltc1qcgnevr9rp7aazy62m4gen0tfzlssa52axwytt7"),
        (DOGE, m, "D5taDndQJ1fDF3AM1yWavmJY2BgSi17CUw"),
        (DOGE, m, ""),
        // MWEB prefix (made-up payload: refused before any decoding).
        (LTC, m, "ltcmweb1qq0yq03ewm830ugmkkvrvjmyyeslcpwk8ayd7k27qx63sryy6kx3ksqm3k6jd24ld3r5dp5lzx7rm7uyxfujf8sn7v4nlxeqwrcq6k6xxwqdc6tl3"),
    ];
    for (coin, net, a) in refused {
        assert!(
            matches!(
                utxo_script_pubkey(a, net, coin),
                Err(Error::InvalidInput(_))
            ),
            "{coin:?} {net:?} {a}"
        );
    }
    // Upper-case bech32 is valid (BIP173).
    assert!(utxo_script_pubkey("LTC1QCGNEVR9RP7AAZY62M4GEN0TFZLSSA52AXWYTT6", m, LTC).is_ok());
}

#[test]
fn genesis_hashes_match_the_nodes() {
    // Litecoin Core / Dogecoin Core chainparams.cpp, and litecoinspace.org /block-height/0.
    assert_eq!(
        utxo_genesis_hash(Network::Mainnet, LTC),
        "12a765e31ffd4059bada1e25190f6e98c99d9714d334efa41a195a7e7e04bfe2"
    );
    assert_eq!(
        utxo_genesis_hash(Network::Testnet, LTC),
        "4966625a4b2851d9fdee139e56211a0d88575f59ed816ff5e6a63deb4e3e29a0"
    );
    assert_eq!(
        utxo_genesis_hash(Network::Mainnet, DOGE),
        "1a91e3dace36e2be3bf030a65679fe821aa1d6ef92e7c9902eb318182c355691"
    );
    assert_eq!(
        utxo_genesis_hash(Network::Testnet, DOGE),
        "bb0a78264637406b6360aad926284d544d7049f45189db5664f3c4d07350559e"
    );
}

// ------------------------------------------------------------------------------------------
// Real transactions: the sighash Kyro computes must be the one the chain's signers used.
// ------------------------------------------------------------------------------------------

fn parse_tx(hex_tx: &str) -> Transaction {
    bitcoin::consensus::deserialize(&hex::decode(hex_tx).unwrap()).unwrap()
}

fn verify(msg: Message, der_with_type: &[u8], pk: &[u8]) {
    let (sighash, der) = der_with_type.split_last().unwrap();
    assert_eq!(*sighash, 0x01, "SIGHASH_ALL");
    let sig = ecdsa::Signature::from_der(der).unwrap();
    let pk = PublicKey::from_slice(pk).unwrap();
    Secp256k1::verification_only()
        .verify_ecdsa(&msg, &sig, &pk)
        .expect("the chain's signature verifies against Kyro's sighash");
}

/// Litecoin testnet4 tx 09062ef6…b300 (block 4 945 833), one P2WPKH input of 22 358 455
/// litoshis spending `00142b5f…c847` (prevout value and script from litecoinspace.org).
#[test]
fn litecoin_testnet_real_p2wpkh_signature_verifies() {
    let raw = "02000000000101e3153a7d96ae4fbe56623634a34d2321136263346d4b1ea768e27449a0b1df380100000000feffffff02f5e1450100000000160014614aed20ddd796821ca640f6bc24b323670743d040420f000000000016001416c4dec6d0a02a481646f1e5d86ddfd1a595cb59024730440220188f64c30231f3c59b2471a88b33a88a3636542c7478492041e55cd41c59f1bd022065ebc284272ee9fb9395a3e26b0792174a621a568cd8fefdc9e05a2c49beb1ed0121026d429ac367d942cf9a050e131eee2167ab104a31d3b71e5a08e633753e31ee91a8774b00";
    let tx = parse_tx(raw);
    let prev_spk = spk("00142b5f0fad46d5bf891cd551d5762ff502aa5ec847");
    let w = &tx.input[0].witness;
    let pk = w.nth(1).unwrap();
    assert_eq!(
        &prev_spk.as_bytes()[2..],
        hash160::Hash::hash(pk).as_byte_array()
    );
    let mut cache = SighashCache::new(&tx);
    let h = cache
        .p2wpkh_signature_hash(
            0,
            &prev_spk,
            Amount::from_sat(22_358_455),
            EcdsaSighashType::All,
        )
        .unwrap();
    verify(Message::from(h), w.nth(0).unwrap(), pk);

    // Kyro's decoder: txid and `tltc1…` rendering identical to the explorer's.
    let d = utxo_decode_raw_tx(raw, Network::Testnet, LTC).unwrap();
    assert_eq!(
        d.txid,
        "09062ef6f449e49f025c7b7c61badfccd652872bbf20ea5b861a7645d238b300"
    );
    assert_eq!(
        d.outputs[0].0.as_deref(),
        Some("tltc1qv99w6gxa67tgy89xgrmtcf9nydnsws7sflulmg")
    );
    assert_eq!(d.outputs[0].1, 21_357_045);
    assert_eq!(
        d.outputs[1].0.as_deref(),
        Some("tltc1qzmzda3ks5q4ys9jx78jasmwl6xjetj6eqjvw2u")
    );
    // Fee shown by the explorer: 22 358 455 − 21 357 045 − 1 000 000 = 1 410.
    assert_eq!(22_358_455 - d.outputs[0].1 - d.outputs[1].1, 1_410);
}

/// Litecoin mainnet tx eb5a3cf9…5e98 (block 3 204 227), one P2WPKH input of 88 097 106.
#[test]
fn litecoin_mainnet_real_p2wpkh_signature_verifies() {
    let raw = "0200000000010160c0239f50e6c053d3381a01fafbc6bbd41d46b8a70934420bbeb618005fb7290000000000fdffffff016ac03f0500000000160014c3ab305b75ac290f96c11dbb316d941afed8d7440247304402203e2a64e7313dd5799090eeaf1150c19729d74f914bd3537bb5b2cd4f747ca3a602207fa5fc0f249f108ab21a96d83bdabdfbcac578ca5c085d8ac3e622b06595db05012102ae4693b6e34a39ee550d39865f07d4d50460f0709d1a0fee0b88a83174c807f982e43000";
    let tx = parse_tx(raw);
    let prev_spk = spk("001440a84c73dfc2485d8179c87e8e56b79deb923255");
    let w = &tx.input[0].witness;
    let mut cache = SighashCache::new(&tx);
    let h = cache
        .p2wpkh_signature_hash(
            0,
            &prev_spk,
            Amount::from_sat(88_097_106),
            EcdsaSighashType::All,
        )
        .unwrap();
    verify(Message::from(h), w.nth(0).unwrap(), w.nth(1).unwrap());
    assert_eq!(
        utxo_address_of_script(prev_spk.as_bytes(), Network::Mainnet, LTC).unwrap(),
        "ltc1qgz5ycu7lcfy9mqteeplgu44hnh4eyvj46cyjk6"
    );
    let d = utxo_decode_raw_tx(raw, Network::Mainnet, LTC).unwrap();
    assert_eq!(
        d.outputs[0].0.as_deref(),
        Some("ltc1qcw4nqkm44s5sl9kprkanzmv5rtld346y7ashdm")
    );
}

/// Dogecoin mainnet tx 386f6e9c…11c5 (block 6 436 571), one P2PKH input from
/// `DK4Ur92aP34VSk6PRM8KXRHXogjfFKbaXY`: legacy sighash, signature in the scriptSig.
#[test]
fn dogecoin_mainnet_real_p2pkh_signature_verifies() {
    let raw = "01000000019d53382244ce54a4129e041d0b29cedd293d1cfcd2cff7930d6e800332441876010000006a473044022020cdcc4c5072aca5e52f18d78d811308f8d79fd92e0198b998f06ac8dcacd6d2022053f6ca9c4e1f80dc8714c77914fad862e78064adbd4710dceb507b43fef3b6b7012103648adbede7ed318fc35e2b7d310046111f626e975d87e103a11e8cd84e5a1b76ffffffff02a23694fa010000001976a914e6c7989b8836301af965531c39865a73d745e46788acb0cc81d86c2b00001976a91498b24d9d9928caab02f40a57b9e7fdcc9dd8e34e88ac00000000";
    let tx = parse_tx(raw);
    let prev_spk =
        utxo_script_pubkey("DK4Ur92aP34VSk6PRM8KXRHXogjfFKbaXY", Network::Mainnet, DOGE).unwrap();
    assert_eq!(
        prev_spk,
        spk("76a91498b24d9d9928caab02f40a57b9e7fdcc9dd8e34e88ac")
    );
    let pushes: Vec<Vec<u8>> = tx.input[0]
        .script_sig
        .instructions()
        .map(|i| i.unwrap().push_bytes().unwrap().as_bytes().to_vec())
        .collect();
    assert_eq!(pushes.len(), 2);
    assert_eq!(
        &prev_spk.as_bytes()[3..23],
        hash160::Hash::hash(&pushes[1]).as_byte_array()
    );
    let cache = SighashCache::new(&tx);
    let h = cache
        .legacy_signature_hash(0, &prev_spk, EcdsaSighashType::All.to_u32())
        .unwrap();
    verify(Message::from(h), &pushes[0], &pushes[1]);

    let d = utxo_decode_raw_tx(raw, Network::Mainnet, DOGE).unwrap();
    assert_eq!(
        d.txid,
        "386f6e9cc89fcc9d2ceb037677bdfd65d8ff2c46a371be688069784d1b3711c5"
    );
    assert_eq!(
        d.outputs[0],
        (
            Some("DSBM4ZW9Dz8jLJuPUBe623ch4yxNkXdV1h".to_owned()),
            8_498_984_610,
            "76a914e6c7989b8836301af965531c39865a73d745e46788ac".to_owned()
        )
    );
    assert_eq!(d.outputs[1].1, 47_746_488_847_536);
    // A witness-serialized transaction is not a Dogecoin transaction.
    let ltc = "02000000000101e3153a7d96ae4fbe56623634a34d2321136263346d4b1ea768e27449a0b1df380100000000feffffff02f5e1450100000000160014614aed20ddd796821ca640f6bc24b323670743d040420f000000000016001416c4dec6d0a02a481646f1e5d86ddfd1a595cb59024730440220188f64c30231f3c59b2471a88b33a88a3636542c7478492041e55cd41c59f1bd022065ebc284272ee9fb9395a3e26b0792174a621a568cd8fefdc9e05a2c49beb1ed0121026d429ac367d942cf9a050e131eee2167ab104a31d3b71e5a08e633753e31ee91a8774b00";
    assert!(utxo_decode_raw_tx(ltc, Network::Mainnet, DOGE).is_err());
}

// ------------------------------------------------------------------------------------------
// Kyro's own PSBTs: sign, verify, finalize, decode.
// ------------------------------------------------------------------------------------------

struct Key {
    pk: PublicKey,
    path: DerivationPath,
    fp: bitcoin::bip32::Fingerprint,
}

fn key(phrase: &str, path: &str) -> Key {
    let s = seed(phrase);
    let secp = Secp256k1::new();
    let master = Xpriv::new_master(NetworkKind::Test, &s[..]).unwrap();
    let path = DerivationPath::from_str(path).unwrap();
    let k = master.derive_priv(&secp, &path).unwrap();
    Key {
        pk: k.private_key.public_key(&secp),
        path,
        fp: master.fingerprint(&secp),
    }
}

fn prev_tx(to: ScriptBuf, value: u64) -> Transaction {
    Transaction {
        version: Version::ONE,
        lock_time: LockTime::ZERO,
        input: vec![TxIn {
            previous_output: OutPoint::from_str(
                "7618443203806e0d93f7cfd2fc1c3d29ddce290b1d049e12a454ce442238539d:1",
            )
            .unwrap(),
            script_sig: ScriptBuf::new(),
            sequence: Sequence::MAX,
            witness: Witness::new(),
        }],
        output: vec![
            TxOut {
                value: Amount::from_sat(1_234),
                script_pubkey: spk("76a914e6c7989b8836301af965531c39865a73d745e46788ac"),
            },
            TxOut {
                value: Amount::from_sat(value),
                script_pubkey: to,
            },
        ],
    }
}

fn unsigned(prev: &Transaction, outs: Vec<TxOut>) -> Psbt {
    let tx = Transaction {
        version: Version::TWO,
        lock_time: LockTime::ZERO,
        input: vec![TxIn {
            previous_output: OutPoint {
                txid: prev.compute_txid(),
                vout: 1,
            },
            script_sig: ScriptBuf::new(),
            sequence: Sequence::ENABLE_RBF_NO_LOCKTIME,
            witness: Witness::new(),
        }],
        output: outs,
    };
    Psbt::from_unsigned_tx(tx).unwrap()
}

fn out(script: ScriptBuf, value: u64) -> TxOut {
    TxOut {
        value: Amount::from_sat(value),
        script_pubkey: script,
    }
}

/// Litecoin testnet send: 0.5 tLTC to a third party, change to `m/84'/1'/0'/1/0`.
fn ltc_psbt() -> (Psbt, Key) {
    let me = key(ABANDON, "m/84'/1'/0'/0/0");
    let change = key(ABANDON, "m/84'/1'/0'/1/0");
    let s = seed(ABANDON);
    let my_spk = utxo_script_pubkey(
        &utxo_address(&s, Network::Testnet, LTC, 0, false, 0).unwrap(),
        Network::Testnet,
        LTC,
    )
    .unwrap();
    let change_spk = utxo_script_pubkey(
        &utxo_address(&s, Network::Testnet, LTC, 0, true, 0).unwrap(),
        Network::Testnet,
        LTC,
    )
    .unwrap();
    let dest = utxo_script_pubkey(
        "tltc1qv99w6gxa67tgy89xgrmtcf9nydnsws7sflulmg",
        Network::Testnet,
        LTC,
    )
    .unwrap();
    let prev = prev_tx(my_spk.clone(), 100_000_000);
    let mut psbt = unsigned(
        &prev,
        vec![out(dest, 50_000_000), out(change_spk, 49_999_859)],
    );
    psbt.inputs[0].witness_utxo = Some(prev.output[1].clone());
    psbt.inputs[0]
        .bip32_derivation
        .insert(me.pk, (me.fp, me.path.clone()));
    psbt.outputs[1]
        .bip32_derivation
        .insert(change.pk, (change.fp, change.path.clone()));
    (psbt, me)
}

#[test]
fn litecoin_sign_verify_finalize() {
    let s = seed(ABANDON);
    let (psbt, me) = ltc_psbt();
    let b64 = psbt.to_string();
    let preview = utxo_psbt_summary(&s, Network::Testnet, LTC, &b64).unwrap();
    let (signed, summary) = utxo_sign_psbt(&s, Network::Testnet, LTC, &b64).unwrap();
    assert_eq!(preview, summary);
    assert_eq!(summary.fee, "141");
    assert_eq!(summary.size, 141, "1-in 2-out P2WPKH: 141 vB");
    assert_eq!(summary.fee_per_kb, 1_000);
    assert!(summary.has_change);
    assert!(!summary.outputs[0].is_change && summary.outputs[1].is_change);
    assert_eq!(
        summary.outputs[0].address.as_deref(),
        Some("tltc1qv99w6gxa67tgy89xgrmtcf9nydnsws7sflulmg")
    );
    assert_eq!(summary.outputs[0].amount, "50000000");
    assert!(summary.warnings.is_empty(), "{:?}", summary.warnings);
    assert!(!summary.requires_extra_confirmation);

    // Independent check of the signature, then finalize by hand and decode.
    let mut p = Psbt::from_str(&signed).unwrap();
    let (pk, sig) = p.inputs[0].partial_sigs.iter().next().unwrap();
    assert_eq!(pk.inner, me.pk);
    let mut cache = SighashCache::new(&p.unsigned_tx);
    let prevout = p.inputs[0].witness_utxo.clone().unwrap();
    let h = cache
        .p2wpkh_signature_hash(
            0,
            &prevout.script_pubkey,
            prevout.value,
            EcdsaSighashType::All,
        )
        .unwrap();
    verify(Message::from(h), &sig.to_vec(), &pk.to_bytes());
    let w = Witness::p2wpkh(sig, &me.pk);
    p.inputs[0].final_script_witness = Some(w);
    let tx = p.extract_tx_unchecked_fee_rate();
    assert!(
        tx.vsize() as u64 <= summary.size,
        "estimate is an upper bound"
    );
    let hex_tx = bitcoin::consensus::encode::serialize_hex(&tx);
    let d = utxo_decode_raw_tx(&hex_tx, Network::Testnet, LTC).unwrap();
    assert_eq!(d.txid, tx.compute_txid().to_string());
    assert_eq!(d.outputs[1].1, 49_999_859);
}

/// Dogecoin testnet send with `non_witness_utxo`: 10 DOGE out of 100, change back to us.
fn doge_psbt(fee: u64) -> (Psbt, Transaction, Key) {
    let s = seed(ABANDON);
    let me = key(ABANDON, "m/44'/1'/0'/0/0");
    let change = key(ABANDON, "m/44'/1'/0'/1/3");
    let my_spk = utxo_script_pubkey(
        &utxo_address(&s, Network::Testnet, DOGE, 0, false, 0).unwrap(),
        Network::Testnet,
        DOGE,
    )
    .unwrap();
    let change_spk = ScriptBuf::new_p2pkh(&bitcoin::PublicKey::new(change.pk).pubkey_hash());
    let dest = utxo_script_pubkey(
        &utxo_address(&seed(LEGAL), Network::Testnet, DOGE, 0, false, 0).unwrap(),
        Network::Testnet,
        DOGE,
    )
    .unwrap();
    let prev = prev_tx(my_spk, 10_000_000_000);
    let mut psbt = unsigned(
        &prev,
        vec![
            out(dest, 1_000_000_000),
            out(change_spk, 9_000_000_000 - fee),
        ],
    );
    psbt.inputs[0].non_witness_utxo = Some(prev.clone());
    psbt.inputs[0]
        .bip32_derivation
        .insert(me.pk, (me.fp, me.path.clone()));
    psbt.outputs[1]
        .bip32_derivation
        .insert(change.pk, (change.fp, change.path.clone()));
    (psbt, prev, me)
}

#[test]
fn dogecoin_sign_verify_finalize() {
    let s = seed(ABANDON);
    // 226 B × 0.01 DOGE/kB = 226 000 koinus.
    let (psbt, _, me) = doge_psbt(226_000);
    let b64 = psbt.to_string();
    let (signed, summary) = utxo_sign_psbt(&s, Network::Testnet, DOGE, &b64).unwrap();
    assert_eq!(
        summary,
        utxo_psbt_summary(&s, Network::Testnet, DOGE, &b64).unwrap()
    );
    assert_eq!(summary.size, 226, "1-in 2-out P2PKH: 226 B");
    assert_eq!(summary.fee, "226000");
    assert_eq!(summary.fee_per_kb, 1_000_000, "0.01 DOGE/kB");
    assert!(summary.outputs[1].is_change && !summary.outputs[0].is_change);
    assert!(summary.outputs[0]
        .address
        .as_deref()
        .unwrap()
        .starts_with('n'));
    assert!(summary.warnings.is_empty(), "{:?}", summary.warnings);

    let mut p = Psbt::from_str(&signed).unwrap();
    let (pk, sig) = p.inputs[0].partial_sigs.iter().next().unwrap();
    assert_eq!(pk.inner, me.pk);
    let prev_spk = {
        let prev = p.inputs[0].non_witness_utxo.clone().unwrap();
        prev.output[1].script_pubkey.clone()
    };
    let h = SighashCache::new(&p.unsigned_tx)
        .legacy_signature_hash(0, &prev_spk, EcdsaSighashType::All.to_u32())
        .unwrap();
    verify(Message::from(h), &sig.to_vec(), &pk.to_bytes());
    let script_sig = bitcoin::script::Builder::new()
        .push_slice(bitcoin::script::PushBytesBuf::try_from(sig.to_vec()).unwrap())
        .push_key(pk)
        .into_script();
    p.inputs[0].final_script_sig = Some(script_sig);
    let tx = p.extract_tx_unchecked_fee_rate();
    assert!(tx.input[0].witness.is_empty());
    assert!(
        tx.total_size() as u64 <= summary.size,
        "estimate is an upper bound"
    );
    let d = utxo_decode_raw_tx(
        &bitcoin::consensus::encode::serialize_hex(&tx),
        Network::Testnet,
        DOGE,
    )
    .unwrap();
    assert_eq!(d.txid, tx.compute_txid().to_string());
}

// ------------------------------------------------------------------------------------------
// Refusals and warnings
// ------------------------------------------------------------------------------------------

fn psbt_err(r: Result<(String, wallet_core::UtxoTxSummary), Error>) -> String {
    match r {
        Err(Error::Psbt(m)) => m,
        other => panic!("expected a PSBT error, got {other:?}"),
    }
}

#[test]
fn dogecoin_requires_a_matching_previous_transaction() {
    let s = seed(ABANDON);
    let sign = |p: &Psbt| utxo_sign_psbt(&s, Network::Testnet, DOGE, &p.to_string());

    let (mut p, prev, _) = doge_psbt(226_000);
    p.inputs[0].non_witness_utxo = None;
    assert!(psbt_err(sign(&p)).contains("non_witness_utxo"));

    // A previous transaction that is not the one spent (amount inflated): txid mismatch.
    let (mut p, mut prev2, _) = doge_psbt(226_000);
    prev2.output[1].value = Amount::from_sat(20_000_000_000);
    p.inputs[0].non_witness_utxo = Some(prev2);
    assert!(psbt_err(sign(&p)).contains("does not match"));

    // SegWit data on Dogecoin.
    let (mut p, _, _) = doge_psbt(226_000);
    p.inputs[0].witness_utxo = Some(prev.output[1].clone());
    assert!(psbt_err(sign(&p)).contains("SegWit"));
}

#[test]
fn litecoin_requires_witness_utxo_and_refuses_bitcoin_paths() {
    let s = seed(ABANDON);
    let (mut p, _) = ltc_psbt();
    p.inputs[0].witness_utxo = None;
    assert!(
        psbt_err(utxo_sign_psbt(&s, Network::Testnet, LTC, &p.to_string()))
            .contains("witness_utxo")
    );

    // A Bitcoin mainnet BIP84 input (coin type 0) is not a Litecoin key: nothing to sign.
    let (mut p, _) = ltc_psbt();
    let btc = {
        let secp = Secp256k1::new();
        let master = Xpriv::new_master(NetworkKind::Main, &s[..]).unwrap();
        let path = DerivationPath::from_str("m/84'/0'/0'/0/0").unwrap();
        let k = master.derive_priv(&secp, &path).unwrap();
        (
            k.private_key.public_key(&secp),
            master.fingerprint(&secp),
            path,
        )
    };
    p.inputs[0].witness_utxo = Some(out(
        ScriptBuf::new_p2wpkh(&bitcoin::CompressedPublicKey(btc.0).wpubkey_hash()),
        100_000_000,
    ));
    p.inputs[0].bip32_derivation.clear();
    p.inputs[0].bip32_derivation.insert(btc.0, (btc.1, btc.2));
    assert!(
        psbt_err(utxo_sign_psbt(&s, Network::Mainnet, LTC, &p.to_string())).contains("no input")
    );

    // A key origin of ours whose key does not match the spent script.
    let (mut p, _) = ltc_psbt();
    p.inputs[0].witness_utxo = Some(out(
        utxo_script_pubkey(
            "tltc1qzmzda3ks5q4ys9jx78jasmwl6xjetj6eqjvw2u",
            Network::Testnet,
            LTC,
        )
        .unwrap(),
        100_000_000,
    ));
    assert!(
        psbt_err(utxo_sign_psbt(&s, Network::Testnet, LTC, &p.to_string())).contains("not ours")
    );

    // Only SIGHASH_ALL.
    let (mut p, _) = ltc_psbt();
    p.inputs[0].sighash_type = Some(PsbtSighashType::from(
        EcdsaSighashType::SinglePlusAnyoneCanPay,
    ));
    assert!(
        psbt_err(utxo_sign_psbt(&s, Network::Testnet, LTC, &p.to_string())).contains("SIGHASH_ALL")
    );

    // Wrong seed: nothing of ours.
    let (p, _) = ltc_psbt();
    assert!(psbt_err(utxo_sign_psbt(
        &seed(LEGAL),
        Network::Testnet,
        LTC,
        &p.to_string()
    ))
    .contains("no input"));
}

#[test]
fn dust_outputs_are_refused() {
    let s = seed(ABANDON);
    // Litecoin: 2 939 < 2 940 (P2WPKH dust at 30 000 litoshis/kvB).
    let (mut p, _) = ltc_psbt();
    p.unsigned_tx.output[0].value = Amount::from_sat(2_939);
    assert!(psbt_err(utxo_sign_psbt(&s, Network::Testnet, LTC, &p.to_string())).contains("dust"));
    let (mut p, _) = ltc_psbt();
    p.unsigned_tx.output[0].value = Amount::from_sat(2_940);
    assert!(utxo_sign_psbt(&s, Network::Testnet, LTC, &p.to_string()).is_ok());
    // Dogecoin: below the hard dust limit (0.001 DOGE) refused; soft dust warned.
    let (mut p, _, _) = doge_psbt(226_000);
    p.unsigned_tx.output[0].value = Amount::from_sat(99_999);
    assert!(psbt_err(utxo_sign_psbt(&s, Network::Testnet, DOGE, &p.to_string())).contains("dust"));
    let (mut p, _, _) = doge_psbt(226_000);
    p.unsigned_tx.output[0].value = Amount::from_sat(500_000);
    let (_, sum) = utxo_sign_psbt(&s, Network::Testnet, DOGE, &p.to_string()).unwrap();
    assert!(sum.warnings.contains(&UtxoWarning::SoftDust { index: 0 }));
    assert!(sum.requires_extra_confirmation);
}

#[test]
fn unknown_scripts_foreign_inputs_and_high_fees_need_a_reinforced_confirmation() {
    let s = seed(ABANDON);
    let summary =
        |coin, p: &Psbt| utxo_psbt_summary(&s, Network::Testnet, coin, &p.to_string()).unwrap();

    // Bare multisig-like unknown script and OP_RETURN.
    let (mut p, _) = ltc_psbt();
    p.unsigned_tx.output[0].script_pubkey =
        spk("5121020202020202020202020202020202020202020202020202020202020202020251ae");
    p.unsigned_tx.output.push(out(spk("6a0461626364"), 0));
    p.outputs.push(Default::default());
    let sum = summary(LTC, &p);
    assert_eq!(sum.outputs[0].kind, UtxoOutputKind::Unknown);
    assert_eq!(sum.outputs[0].address, None);
    assert_eq!(sum.outputs[2].kind, UtxoOutputKind::OpReturn);
    assert!(sum
        .warnings
        .contains(&UtxoWarning::UnknownOutput { index: 0 }));
    assert!(sum.warnings.contains(&UtxoWarning::OpReturn { index: 2 }));
    assert!(sum.requires_extra_confirmation);

    // A fee of 0.49 LTC on a 0.5 LTC send.
    let (mut p, _) = ltc_psbt();
    p.unsigned_tx.output[1].value = Amount::from_sat(1_000_000);
    let sum = summary(LTC, &p);
    assert!(sum.warnings.contains(&UtxoWarning::HighFee));
    assert!(sum.requires_extra_confirmation);

    // No change output: the summary says so (whatever is not sent is fee).
    let (mut p, _) = ltc_psbt();
    p.unsigned_tx.output.truncate(1);
    p.outputs.truncate(1);
    let sum = summary(LTC, &p);
    assert!(!sum.has_change);

    // Fee below the relay minimum: informative only.
    let (p, _, _) = doge_psbt(1_000);
    let sum = summary(DOGE, &p);
    assert!(
        matches!(&sum.warnings[..], [UtxoWarning::FeeBelowMinimum { minimum }] if minimum == "22600")
    );
    assert!(!sum.requires_extra_confirmation);

    // A second input that is not ours.
    let (mut p, prev, _) = doge_psbt(226_000);
    // Someone else's P2PKH coin (key not derived from our seed).
    let foreign_prev = prev_tx(prev.output[0].script_pubkey.clone(), 5_000_000_000);
    p.unsigned_tx.input.push(TxIn {
        previous_output: OutPoint {
            txid: foreign_prev.compute_txid(),
            vout: 1,
        },
        ..p.unsigned_tx.input[0].clone()
    });
    p.inputs.push(bitcoin::psbt::Input {
        non_witness_utxo: Some(foreign_prev),
        ..Default::default()
    });
    p.unsigned_tx.output[1].value = Amount::from_sat(14_000_000_000 - 400_000);
    let sum = summary(DOGE, &p);
    assert_eq!((sum.inputs, sum.our_inputs), (2, 1));
    assert!(sum
        .warnings
        .contains(&UtxoWarning::ForeignInput { index: 1 }));
    assert!(sum.requires_extra_confirmation);
    let (signed, _) = utxo_sign_psbt(&s, Network::Testnet, DOGE, &p.to_string()).unwrap();
    let signed = Psbt::from_str(&signed).unwrap();
    assert_eq!(signed.inputs[0].partial_sigs.len(), 1);
    assert!(signed.inputs[1].partial_sigs.is_empty());
}

#[test]
fn summary_json_shape() {
    let s = seed(ABANDON);
    let (p, _) = ltc_psbt();
    let v =
        serde_json::to_value(utxo_psbt_summary(&s, Network::Testnet, LTC, &p.to_string()).unwrap())
            .unwrap();
    assert_eq!(v["coin"], "litecoin");
    assert_eq!(v["fee"], "141");
    assert_eq!(v["feePerKb"], 1000);
    assert_eq!(v["outputs"][1]["isChange"], true);
    assert_eq!(v["outputs"][0]["kind"], "address");
    assert_eq!(v["requiresExtraConfirmation"], false);
    let w = serde_json::to_value(UtxoWarning::SoftDust { index: 2 }).unwrap();
    assert_eq!(w, serde_json::json!({ "kind": "softDust", "index": 2 }));
}

// ------------------------------------------------------------------------------------------
// PSBTs built by the TypeScript adapters (packages/chains, bitcoinjs-lib), "abandon … about".
// ------------------------------------------------------------------------------------------

/// `LitecoinAdapter.buildTx`: 0.5 tLTC from `m/84'/1'/0'/0/0` (fixture UTXO of 1 tLTC),
/// change to `m/84'/1'/0'/1/0`, 1 litoshi/vB.
const TS_LTC_PSBT: &str = "cHNidP8BAHECAAAAAaqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqAQAAAAD/////AoDw+gIAAAAAFgAUYUrtIN3XloIcpkD2vCSzI2cHQ9Dz7/oCAAAAABYAFC80qhzwClOwVaKRoDp9RfCmmItSAAAAAAABAR8A4fUFAAAAABYAFNDEo+8J6Ze26Z45flGP4+QaEYyhIgYC56slN7XUnpcDCargbp5J82zhyf671E7I4NHMoLT5wxkYc8XaClQAAIABAACAAAAAgAAAAAAAAAAAAAAiAgNdSezNVNAJnkNnYnfHptRiXWEdqIpd9Jv5UXp3kad3pRhzxdoKVAAAgAEAAIAAAACAAQAAAAAAAAAA";

/// `DogecoinAdapter.buildTx`: 10 DOGE from `m/44'/1'/0'/0/0` (`nonWitnessUtxo` of 100 DOGE),
/// change to `m/44'/1'/0'/1/0`, 0.01 DOGE/kB.
const TS_DOGE_PSBT: &str = "cHNidP8BAHcCAAAAARJmgqwvI6lsL36LtKJLSB3aGOxwYXu6cubZdu0FFJJvAQAAAAD/////AgDKmjsAAAAAGXapFAkJCQkJCQkJCQkJCQkJCQkJCQkJiKwwp20YAgAAABl2qRQctzkgtaw49GDjjetoS5xKQI/zwIisAAAAAAABAHcBAAAAAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAAAAAAD/////AtIEAAAAAAAAGXapFAkJCQkJCQkJCQkJCQkJCQkJCQkJiKwA5AtUAgAAABl2qRQ6LUFFpPCYUjs+gSfx2ofPxVuOeYisAAAAACIGAqdFE5VzU2ny7N/IKcD3dOiO8TA9/lsvBNuqswpTXf3WGHPF2gosAACAAQAAgAAAAIAAAAAAAAAAAAAAIgIDICgqxrN4JyGxdCwpRTCp8lBBM2Grv/ZZrMg1K8TB8/EYc8XaCiwAAIABAACAAAAAgAEAAAAAAAAAAA==";

#[test]
fn psbts_built_by_the_ts_adapters_are_decoded_and_signed() {
    let s = seed(ABANDON);
    let (signed, sum) = utxo_sign_psbt(&s, Network::Testnet, LTC, TS_LTC_PSBT).unwrap();
    assert_eq!((sum.inputs, sum.our_inputs), (1, 1));
    assert_eq!(sum.fee, "141");
    assert_eq!(sum.size, 141, "TS and Rust size models agree");
    assert!(sum.outputs[1].is_change && !sum.outputs[0].is_change);
    assert_eq!(
        sum.outputs[1].address.as_deref(),
        Some(
            utxo_address(&s, Network::Testnet, LTC, 0, true, 0)
                .unwrap()
                .as_str()
        )
    );
    assert!(sum.warnings.is_empty() && !sum.requires_extra_confirmation);
    assert_eq!(
        Psbt::from_str(&signed).unwrap().inputs[0]
            .partial_sigs
            .len(),
        1
    );

    let (signed, sum) = utxo_sign_psbt(&s, Network::Testnet, DOGE, TS_DOGE_PSBT).unwrap();
    assert_eq!(sum.fee, "226000");
    assert_eq!(sum.size, 226, "TS and Rust size models agree");
    assert_eq!(sum.fee_per_kb, 1_000_000);
    assert_eq!(
        sum.outputs[0].address.as_deref(),
        Some("nV1wAnFEiT9JuGLWZrk9xMFS5CP8eaw2B9")
    );
    assert!(sum.outputs[1].is_change);
    assert!(sum.warnings.is_empty() && !sum.requires_extra_confirmation);
    assert_eq!(
        utxo_address(&s, Network::Testnet, DOGE, 0, false, 0).unwrap(),
        "nZVmfmUtKPmskB9Ds4P9GUJy9eYFqPKHqH",
        "same address as the TS adapter"
    );
    assert_eq!(
        Psbt::from_str(&signed).unwrap().inputs[0]
            .partial_sigs
            .len(),
        1
    );
}
