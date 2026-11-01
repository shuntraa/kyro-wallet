//! Bitcoin Cash (BIP44 coin 145, CashAddr, `SIGHASH_ALL|FORKID`) and Dash (BIP44 coin 5, P2PKH
//! `X…`, legacy sighash) vectors, real-chain signature checks, PSBT signing and refusals.
//!
//! Sources of the expected values (fetched 2026-11-01):
//! - CashAddr spec `spec/cashaddr.md` (bitcoincash.org), "Examples of address translation";
//!   the spec's size/type vectors are in `src/cashaddr.rs`;
//! - Trezor firmware `tests/device_tests/bitcoin/test_getaddress.py` (`test_bch`),
//!   `test_bcash.py` (`test_send_bch_change`, `test_send_bch_nochange`) and `test_dash.py`
//!   (`test_send_dash`, `test_send_dash_dip2_input`), mnemonic `all ×12`, with their previous
//!   transactions from `tests/txcache/{bcash,dash}/`. Trezor signs with RFC 6979 like
//!   libsecp256k1, so Kyro must produce **byte-identical** signed transactions;
//! - Trust Wallet Core `tests/common/CoinAddressDerivationTests.cpp` (key `0x46…46`) and
//!   `tests/chains/Dash/TWDashTests.cpp` (`Dash.LockScripts`);
//! - Bitcoin Cash Node `src/test/data/sighash.json`: every vector whose type has the FORKID bit
//!   and not `SIGHASH_UTXOS` (236 of 1 000), digest computed with amount 0 as in
//!   `sighash_tests.cpp` → `tests/data/bchn_sighash_forkid.json`;
//! - real mainnet transactions read from public Electrum servers (bch.imaginary.cash,
//!   dash.electrum1.cipig.net), never broadcast; checkpoint headers from bch.loping.net and
//!   chipnet.bch.ninja.

mod common;

use std::str::FromStr;

use bitcoin::bip32::{DerivationPath, Fingerprint, Xpriv};
use bitcoin::hashes::{hash160, Hash};
use bitcoin::psbt::Psbt;
use bitcoin::secp256k1::{ecdsa, Message, PublicKey, Secp256k1, SecretKey};
use bitcoin::sighash::{EcdsaSighashType, SighashCache};
use bitcoin::transaction::Version;
use bitcoin::{
    absolute::LockTime, Amount, NetworkKind, OutPoint, ScriptBuf, Sequence, Transaction, TxIn,
    TxOut, Txid, Witness,
};
use common::{seed, ABANDON, LEGAL};
use wallet_core::{
    bch_forkid_sighash, utxo_account, utxo_address, utxo_address_from_xpub, utxo_address_of_script,
    utxo_checkpoint, utxo_decode_raw_tx, utxo_genesis_hash, utxo_header_hash, utxo_is_special_tx,
    utxo_psbt_summary, utxo_script_pubkey, utxo_sign_psbt, Error, Network, UtxoCoin, UtxoTxSummary,
    UtxoWarning, BCH_SIGHASH_ALL_FORKID,
};

const BCH: UtxoCoin = UtxoCoin::BitcoinCash;
const DASH: UtxoCoin = UtxoCoin::Dash;
const ALL: &str = "all all all all all all all all all all all all";
const M: Network = Network::Mainnet;
const T: Network = Network::Testnet;

fn spk(hex: &str) -> ScriptBuf {
    ScriptBuf::from_hex(hex).unwrap()
}

fn parse_tx(hex_tx: &str) -> Transaction {
    bitcoin::consensus::deserialize(&hex::decode(hex_tx).unwrap()).unwrap()
}

fn pushes(script: &bitcoin::Script) -> Vec<Vec<u8>> {
    script
        .instructions()
        .map(|i| i.unwrap().push_bytes().unwrap().as_bytes().to_vec())
        .collect()
}

// ------------------------------------------------------------------------------------------
// Addresses and derivation
// ------------------------------------------------------------------------------------------

/// CashAddr spec, "Examples of address translation": legacy `1…`/`3…` ↔ `bitcoincash:q…`/`p…`.
#[test]
fn cashaddr_spec_address_translation() {
    for (legacy, cash) in [
        (
            "1BpEi6DfDAUFd7GtittLSdBeYJvcoaVggu",
            "bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a",
        ),
        (
            "1KXrWXciRDZUpQwQmuM1DbwsKDLYAYsVLR",
            "bitcoincash:qr95sy3j9xwd2ap32xkykttr4cvcu7as4y0qverfuy",
        ),
        (
            "16w1D5WRVKJuZUsSRzdLp9w3YGcgoxDXb",
            "bitcoincash:qqq3728yw0y47sqn6l2na30mcw6zm78dzqre909m2r",
        ),
        (
            "3CWFddi6m4ndiGyKqzYvsFYagqDLPVMTzC",
            "bitcoincash:ppm2qsznhks23z7629mms6s4cwef74vcwvn0h829pq",
        ),
        (
            "3LDsS579y7sruadqu11beEJoTjdFiFCdX4",
            "bitcoincash:pr95sy3j9xwd2ap32xkykttr4cvcu7as4yc93ky28e",
        ),
        (
            "31nwvkZwyPdgzjBJZXfDmSWsC4ZLKpYyUw",
            "bitcoincash:pqq3728yw0y47sqn6l2na30mcw6zm78dzq5ucqzc37",
        ),
    ] {
        let raw = bitcoin::base58::decode_check(legacy).unwrap();
        let script = match raw[0] {
            0 => ScriptBuf::new_p2pkh(&bitcoin::PubkeyHash::from_slice(&raw[1..]).unwrap()),
            5 => ScriptBuf::new_p2sh(&bitcoin::ScriptHash::from_slice(&raw[1..]).unwrap()),
            v => panic!("version {v}"),
        };
        assert_eq!(
            utxo_address_of_script(script.as_bytes(), M, BCH).unwrap(),
            cash
        );
        assert_eq!(utxo_script_pubkey(cash, M, BCH).unwrap(), script);
        // Prefix optional, upper case accepted (never mixed).
        let bare = cash.trim_start_matches("bitcoincash:");
        assert_eq!(utxo_script_pubkey(bare, M, BCH).unwrap(), script);
        assert_eq!(
            utxo_script_pubkey(&cash.to_uppercase(), M, BCH).unwrap(),
            script
        );
        // The legacy form is refused: it cannot be told apart from a Bitcoin address.
        let e = utxo_script_pubkey(legacy, M, BCH).unwrap_err();
        assert!(
            matches!(&e, Error::InvalidInput(m) if m.contains("CashAddr")),
            "{e:?}"
        );
        // A mainnet CashAddr on chipnet: another network.
        assert!(matches!(
            utxo_script_pubkey(cash, T, BCH),
            Err(Error::InvalidInput(m)) if m.contains("another network")
        ));
    }
}

/// Trezor `test_bch` (`all ×12`): `m/44'/145'/0'/{0/0, 0/1, 1/0}`.
#[test]
fn bch_bip44_trezor_vectors() {
    let s = seed(ALL);
    let acct = utxo_account(&s, M, BCH, 0).unwrap();
    assert_eq!(acct.path, "m/44'/145'/0'");
    assert_eq!(acct.coin, BCH);
    for (change, index, expected) in [
        (
            false,
            0,
            "bitcoincash:qr08q88p9etk89wgv05nwlrkm4l0urz4cyl36hh9sv",
        ),
        (
            false,
            1,
            "bitcoincash:qr23ajjfd9wd73l87j642puf8cad20lfmqdgwvpat4",
        ),
        (
            true,
            0,
            "bitcoincash:qzc5q87w069lzg7g3gzx0c8dz83mn7l02scej5aluw",
        ),
    ] {
        assert_eq!(
            utxo_address(&s, M, BCH, 0, change, index).unwrap(),
            expected
        );
        assert_eq!(
            utxo_address_from_xpub(&acct.xpub, M, BCH, change, index).unwrap(),
            expected
        );
    }
}

/// Trezor `test_dash.py` (`all ×12`): `m/44'/5'/0'/0/0` = `XdTw4G5…`, and the change address
/// `m/44'/5'/0'/1/0` pays `76a914fd61dd…` in the signed transaction of `test_send_dash_dip2_input`.
#[test]
fn dash_bip44_trezor_vectors() {
    let s = seed(ALL);
    let acct = utxo_account(&s, M, DASH, 0).unwrap();
    assert_eq!(acct.path, "m/44'/5'/0'");
    assert_eq!(
        utxo_address(&s, M, DASH, 0, false, 0).unwrap(),
        "XdTw4G5AWW4cogGd7ayybyBNDbuB45UpgH"
    );
    let change = utxo_address(&s, M, DASH, 0, true, 0).unwrap();
    assert_eq!(
        utxo_script_pubkey(&change, M, DASH).unwrap(),
        spk("76a914fd61dd017dad1f505c0511142cc9ac51ef3a5beb88ac")
    );
    assert_eq!(
        utxo_address_from_xpub(&acct.xpub, M, DASH, true, 0).unwrap(),
        change
    );
}

/// Trust Wallet Core `Coin.DeriveAddress` (private key `0x46…46`): the same key hash is
/// `qz7eyzy…` on Bitcoin Cash, `XsyCV5y…` on Dash (and `DNRTC6G…` on Dogecoin).
#[test]
fn trust_wallet_cross_chain_encodings() {
    let secp = Secp256k1::new();
    let sk = SecretKey::from_slice(&[0x46; 32]).unwrap();
    let pk = bitcoin::PublicKey::new(sk.public_key(&secp));
    let script = ScriptBuf::new_p2pkh(&pk.pubkey_hash());
    for (coin, expected) in [
        (
            BCH,
            "bitcoincash:qz7eyzytkl5z6cg6nw20hd62pyyp22mcfuardfd2vn",
        ),
        (DASH, "XsyCV5yojxF4y3bYeEiVYqarvRgsWFELZL"),
        (UtxoCoin::Dogecoin, "DNRTC6GZ5evmM7BZWwPqF54fyDqUqULMyu"),
    ] {
        assert_eq!(
            utxo_address_of_script(script.as_bytes(), M, coin).unwrap(),
            expected
        );
        assert_eq!(utxo_script_pubkey(expected, M, coin).unwrap(), script);
    }
}

/// Trust Wallet Core `Dash.LockScripts`: P2PKH `X…` and P2SH `7…`.
#[test]
fn dash_lock_scripts_trust_wallet_vectors() {
    for (addr, script) in [
        (
            "XgkpWEFe59pX3aMhx6PrDawjNnoZKHeZbp",
            "76a91442914f5b70c61619eca5359df57d0b9bdcf8ccff88ac",
        ),
        (
            "7eprxeVjKfVgS8p2RNsZ89K72YV61xg4gq",
            "a9148835ae54f297ad069552a1401e535dfe5f396f6187",
        ),
    ] {
        assert_eq!(utxo_script_pubkey(addr, M, DASH).unwrap(), spk(script));
        assert_eq!(
            utxo_address_of_script(spk(script).as_bytes(), M, DASH).unwrap(),
            addr
        );
    }
}

/// Testnets use SLIP-44 coin type 1 (same keys as Bitcoin testnet BIP44, Trezor `test_tbtc`
/// `mvbu1Gd…`), each with its own encoding: chipnet `bchtest:q…`, Dash testnet `y…` (140).
#[test]
fn testnet_paths_and_encodings() {
    let s = seed(ALL);
    let btc = bitcoin::base58::decode_check("mvbu1Gdy8SUjTenqerxUaZyYjmveZvt33q").unwrap();
    let hash = ScriptBuf::new_p2pkh(&bitcoin::PubkeyHash::from_slice(&btc[1..]).unwrap());

    assert_eq!(utxo_account(&s, T, BCH, 0).unwrap().path, "m/44'/1'/0'");
    let b = utxo_address(&s, T, BCH, 0, false, 0).unwrap();
    assert!(b.starts_with("bchtest:q"), "{b}");
    assert_eq!(utxo_script_pubkey(&b, T, BCH).unwrap(), hash);

    assert_eq!(utxo_account(&s, T, DASH, 0).unwrap().path, "m/44'/1'/0'");
    let d = utxo_address(&s, T, DASH, 0, false, 0).unwrap();
    assert!(d.starts_with('y'), "{d}");
    assert_eq!(bitcoin::base58::decode_check(&d).unwrap()[0], 140);
    assert_eq!(utxo_script_pubkey(&d, T, DASH).unwrap(), hash);

    assert_eq!(utxo_account(&s, M, BCH, 4).unwrap().path, "m/44'/145'/4'");
    assert_eq!(utxo_account(&s, M, DASH, 2).unwrap().path, "m/44'/5'/2'");
}

#[test]
fn addresses_of_other_chains_are_refused() {
    let refused = [
        // Bitcoin (and BCH legacy) addresses, segwit, other chains on Bitcoin Cash.
        (BCH, M, "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"),
        (BCH, M, "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu"),
        (BCH, M, "XdTw4G5AWW4cogGd7ayybyBNDbuB45UpgH"),
        (BCH, M, "bchtest:qr08q88p9etk89wgv05nwlrkm4l0urz4cyl36hh9sv"),
        // Broken checksum, mixed case, P2SH32 (32-byte hash).
        (
            BCH,
            M,
            "bitcoincash:qr08q88p9etk89wgv05nwlrkm4l0urz4cyl36hh9sw",
        ),
        (
            BCH,
            M,
            "bitcoincash:Qr08q88p9etk89wgv05nwlrkm4l0urz4cyl36hh9sv",
        ),
        (
            BCH,
            M,
            "bitcoincash:pvch8mmxy0rtfrlarg7ucrxxfzds5pamg73h7370aa87d80gyhqxq5nlegake",
        ),
        (BCH, M, ""),
        // Dash: Bitcoin, Dogecoin, testnet on mainnet and vice versa, CashAddr, bad checksum.
        (DASH, M, "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"),
        (DASH, M, "D5taDndQJ1fDF3AM1yWavmJY2BgSi17CUv"),
        (DASH, T, "XdTw4G5AWW4cogGd7ayybyBNDbuB45UpgH"),
        (
            DASH,
            M,
            "bitcoincash:qr08q88p9etk89wgv05nwlrkm4l0urz4cyl36hh9sv",
        ),
        (DASH, M, "XdTw4G5AWW4cogGd7ayybyBNDbuB45UpgJ"),
        // And BCH / Dash addresses on the existing chains.
        (UtxoCoin::Dogecoin, M, "XdTw4G5AWW4cogGd7ayybyBNDbuB45UpgH"),
        (
            UtxoCoin::Litecoin,
            M,
            "bitcoincash:qr08q88p9etk89wgv05nwlrkm4l0urz4cyl36hh9sv",
        ),
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
}

#[test]
fn genesis_hashes_and_checkpoints() {
    // Bitcoin Cash Node / Dash Core chainparams.cpp. Bitcoin Cash shares Bitcoin's genesis
    // (chipnet: testnet4's), hence the checkpoint after the split.
    assert_eq!(
        utxo_genesis_hash(M, BCH),
        "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f"
    );
    assert_eq!(
        utxo_genesis_hash(T, BCH),
        "000000001dd410c49a788668ce26751718cc797474d3152a5fc073dd44fd9f7b"
    );
    assert_eq!(
        utxo_genesis_hash(M, DASH),
        "00000ffd590b1485b3caadc19b22e6379c733355108f107a430458cdf3407ab6"
    );
    assert_eq!(
        utxo_genesis_hash(T, DASH),
        "00000bafbc94add76cb75e2ec92894837288a481e5c005f6563d91623bf8bc2c"
    );
    // Block 478 559 (first Bitcoin Cash block, 1 Aug 2017) and chipnet block 200 000: the
    // headers served by public servers hash to the checkpoints.
    let main = "00000020432d350741fbf28f2e1486eabe2c4e143bfe2241af6518010000000000000000abaa4bd8a48c1c6bc08ee39b66065e5e9484304cab8b56d5eed3e40b1ac996c899c480593547011822ca4ae8";
    let chip = "00000020270088a5d78fd25a32c8bf3f0704aacbd77211bfee9bd5e9afb3dd630000000092c12e2a7f7fc79c64a79ac03e51fa26f819c13906bd1a5612cd6dd0cd568972e6083e66cc9d731c85cf1b8d";
    let (h, hash) = utxo_checkpoint(M, BCH).unwrap();
    assert_eq!(
        (h, utxo_header_hash(main).unwrap().as_str()),
        (478_559, hash)
    );
    let (h, hash) = utxo_checkpoint(T, BCH).unwrap();
    assert_eq!(
        (h, utxo_header_hash(chip).unwrap().as_str()),
        (200_000, hash)
    );
    assert!(utxo_checkpoint(M, DASH).is_none());
    assert!(utxo_checkpoint(M, UtxoCoin::Litecoin).is_none());
    assert!(utxo_header_hash("00").is_err());
}

// ------------------------------------------------------------------------------------------
// Signature hashes
// ------------------------------------------------------------------------------------------

/// Bitcoin Cash Node `sighash.json`, every FORKID vector (amount 0, as in its test).
#[test]
fn bchn_forkid_sighash_vectors() {
    let v: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("data/bchn_sighash_forkid.json")).unwrap();
    assert_eq!(v.len(), 236);
    let mut checked = 0;
    for t in &v {
        let tx = parse_tx(t[0].as_str().unwrap());
        let script = spk(t[1].as_str().unwrap());
        let n = t[2].as_u64().unwrap() as usize;
        let ty = t[3].as_i64().unwrap() as i32 as u32;
        let mut want = hex::decode(t[4].as_str().unwrap()).unwrap();
        want.reverse(); // uint256 display order
        let got = bch_forkid_sighash(&tx, n, &script, 0, ty).unwrap();
        assert_eq!(got.to_vec(), want, "vector {t}");
        checked += 1;
    }
    assert_eq!(checked, 236);
    // Without FORKID, or with SIGHASH_UTXOS: refused.
    let tx = parse_tx(v[0][0].as_str().unwrap());
    assert!(bch_forkid_sighash(&tx, 0, &ScriptBuf::new(), 0, 0x01).is_err());
    assert!(bch_forkid_sighash(&tx, 0, &ScriptBuf::new(), 0, 0x61).is_err());
}

fn verify(msg: Message, der_with_type: &[u8], pk: &[u8], ty: u8) {
    let (sighash, der) = der_with_type.split_last().unwrap();
    assert_eq!(*sighash, ty, "sighash type");
    let sig = ecdsa::Signature::from_der(der).unwrap();
    let pk = PublicKey::from_slice(pk).unwrap();
    Secp256k1::verification_only()
        .verify_ecdsa(&msg, &sig, &pk)
        .expect("the chain's signature verifies against Kyro's sighash");
}

/// Bitcoin Cash mainnet tx 21c41fcc…e3e6 (block 975 300), one P2PKH input signed
/// `ALL|FORKID` over its amount (1 260 283 sat, from the previous transaction 8189ea81…).
#[test]
fn bch_mainnet_real_forkid_signature_verifies() {
    let raw = "02000000016cdf10e541185ada1628953b77779c34b82937aa32371f7526d700fd81ea8981010000006a473044022040030e78772203ec69d8e3f1be92efa6760445ec9eb00e98fdf512328c4561d3022005fb59355d4e7ff61e2dda1d85037eae80cffd468e5b3b60b91e23e396ea2dc1412103806da3f15c15259ae0d64dd9135d741306709938c2e886083ef05ba9a7d32de1ffffffff01eb131300000000001976a91478ab4b7159a1a6e3a873b696933ee5898e2e599888ac00000000";
    let prev_raw = "010000000270377b4b5c60cd8d6cea7048fcc23bd4a901050b59aa97b730b33a6e7f28ff442b0000006a4730440220343e82de3a99d9d4d0c4fa1458f6f5227f5f7d1e172994bf203a8e4f8053b5c0022019e9841db98a18aa58fdaa33696a7032d4b13e1b72d27b9078424ffed9194276412102faa652904cfbc4254b1a72fd9ea7a6b76ee33901f3aa51f5d4f7b61e10178ba2ffffffff1527417eeb8e980378140a88fe3656ac8db212937b343b9106e28d46671f23f2010000006b483045022100e5a6f0064c2b095a990a0dea1a5428eb750219ef5109ed41f8a75c48d39e9e7402206b0a9e43208e01bd47156df64a883fd131afe98775fb16fffc47e70d97541b5f4121022fa7d33d87a8d53a8296baef29f71e2d25054527536a2e006390a73cf23f7e5dffffffff0222020000000000001976a91426ac8a0018d1ababfb33e1101029fc7f08ad3f6988acfb3a1300000000001976a914611d9a1ca46864d1df4effc4cda3f5bd067d795088ac00000000";
    let tx = parse_tx(raw);
    let prev = parse_tx(prev_raw);
    assert_eq!(tx.input[0].previous_output.txid, prev.compute_txid());
    let prevout = &prev.output[tx.input[0].previous_output.vout as usize];
    assert_eq!(prevout.value.to_sat(), 1_260_283);
    let p = pushes(&tx.input[0].script_sig);
    assert_eq!(
        &prevout.script_pubkey.as_bytes()[3..23],
        hash160::Hash::hash(&p[1]).as_byte_array()
    );
    let h = bch_forkid_sighash(
        &tx,
        0,
        &prevout.script_pubkey,
        prevout.value.to_sat(),
        BCH_SIGHASH_ALL_FORKID,
    )
    .unwrap();
    verify(Message::from_digest(h), &p[0], &p[1], 0x41);
    // A different amount gives another digest: the signature no longer verifies.
    let wrong = bch_forkid_sighash(&tx, 0, &prevout.script_pubkey, 1_260_282, 0x41).unwrap();
    let (_, der) = p[0].split_last().unwrap();
    assert!(Secp256k1::verification_only()
        .verify_ecdsa(
            &Message::from_digest(wrong),
            &ecdsa::Signature::from_der(der).unwrap(),
            &PublicKey::from_slice(&p[1]).unwrap()
        )
        .is_err());

    let d = utxo_decode_raw_tx(raw, M, BCH).unwrap();
    assert_eq!(
        d.txid,
        "21c41fcc7c64b3967952c46b1a4b619300e58e10448a52b886f81a0ac04de3e6"
    );
    assert_eq!(d.outputs[0].1, 1_250_283);
    assert!(d.outputs[0]
        .0
        .as_deref()
        .unwrap()
        .starts_with("bitcoincash:q"));
}

/// Dash mainnet tx dc4a865a…a8e6 (block 2 564 700): one P2PKH input, legacy sighash.
#[test]
fn dash_mainnet_real_legacy_signature_verifies() {
    let raw = "01000000014e12f0fd392cea03fd8039cb789ff87807ae7f85e5ce07f7f849f7d5e483bf1e000000006b483045022100bc289c6cf2cfadfd020040d3fa8aa2787bd6f351817f68ec8e076418c313d6310220372e9e39a218dcf3aaddb48a56ffc0cce2c04514465b47fafd01bd3613c7bdc9012103b36743168dcea1eb7a2457fa7d5e678aca5d67823ddfc63d0947faa3c7147a8effffffff010000000000000000016a00000000";
    let prev_raw = "0100000001153a889e8240af45b2624ec8218dd5760f7788a7aaf7600a9593bf585ca2a9be000000006b483045022100e59d965dab67d9bbebc4e5cb8334719335c598613388c281bf0aab94a1413b72022006d67d59f435001e1e444f7e8b2b44f7ca272686ead0534b63ea29a556d1fa11012102f70fb71a5f291b622a95aa5d1e222e639bf1add7ef2779b2fdc4d5eea72b0651ffffffff0110270000000000001976a9149c661c44fde54bf3f3d1c41fe934782451f83d9f88ac00000000";
    let tx = parse_tx(raw);
    let prev = parse_tx(prev_raw);
    assert_eq!(tx.input[0].previous_output.txid, prev.compute_txid());
    let prevout = &prev.output[0];
    let p = pushes(&tx.input[0].script_sig);
    let h = SighashCache::new(&tx)
        .legacy_signature_hash(0, &prevout.script_pubkey, EcdsaSighashType::All.to_u32())
        .unwrap();
    verify(Message::from(h), &p[0], &p[1], 0x01);
    let d = utxo_decode_raw_tx(raw, M, DASH).unwrap();
    assert_eq!(
        d.txid,
        "dc4a865a4990e94d8776c932652f16b62db9dfd738a79d069bf77011d4b6a8e6"
    );
    let a = utxo_address_of_script(prevout.script_pubkey.as_bytes(), M, DASH).unwrap();
    assert!(a.starts_with('X'), "{a}");
    assert!(!utxo_is_special_tx(raw, DASH));
}

// ------------------------------------------------------------------------------------------
// Trezor vectors: Kyro's signed transactions must be byte-identical.
// ------------------------------------------------------------------------------------------

/// A transaction from Trezor's `txcache` JSON fields.
fn cached_tx(
    version: i32,
    inputs: &[(&str, u32, &str, u32)],
    outputs: &[(u64, &str)],
    lock_time: u32,
) -> Transaction {
    Transaction {
        version: Version(version),
        lock_time: LockTime::from_consensus(lock_time),
        input: inputs
            .iter()
            .map(|(h, i, ss, seq)| TxIn {
                previous_output: OutPoint {
                    txid: Txid::from_str(h).unwrap(),
                    vout: *i,
                },
                script_sig: spk(ss),
                sequence: Sequence(*seq),
                witness: Witness::new(),
            })
            .collect(),
        output: outputs
            .iter()
            .map(|(v, s)| TxOut {
                value: Amount::from_sat(*v),
                script_pubkey: spk(s),
            })
            .collect(),
    }
}

struct Key {
    pk: PublicKey,
    path: DerivationPath,
    fp: Fingerprint,
}

fn key(phrase: &str, path: &str) -> Key {
    let s = seed(phrase);
    let secp = Secp256k1::new();
    let master = Xpriv::new_master(NetworkKind::Main, &s[..]).unwrap();
    let path = DerivationPath::from_str(path).unwrap();
    let k = master.derive_priv(&secp, &path).unwrap();
    Key {
        pk: k.private_key.public_key(&secp),
        path,
        fp: master.fingerprint(&secp),
    }
}

/// PSBT spending `(prev, vout, our key path)` inputs to `outputs` (with an optional change
/// output index and its path), version 1, sequence `ffffffff`, lock time 0 (Trezor's).
fn psbt_of(
    phrase: &str,
    inputs: &[(&Transaction, u32, &str)],
    outputs: Vec<TxOut>,
    change: Option<(usize, &str)>,
) -> Psbt {
    let tx = Transaction {
        version: Version::ONE,
        lock_time: LockTime::ZERO,
        input: inputs
            .iter()
            .map(|(prev, vout, _)| TxIn {
                previous_output: OutPoint {
                    txid: prev.compute_txid(),
                    vout: *vout,
                },
                script_sig: ScriptBuf::new(),
                sequence: Sequence::MAX,
                witness: Witness::new(),
            })
            .collect(),
        output: outputs,
    };
    let mut psbt = Psbt::from_unsigned_tx(tx).unwrap();
    for (i, (prev, _, path)) in inputs.iter().enumerate() {
        let k = key(phrase, path);
        psbt.inputs[i].non_witness_utxo = Some((*prev).clone());
        psbt.inputs[i].bip32_derivation.insert(k.pk, (k.fp, k.path));
    }
    if let Some((j, path)) = change {
        let k = key(phrase, path);
        psbt.outputs[j]
            .bip32_derivation
            .insert(k.pk, (k.fp, k.path));
    }
    psbt
}

fn out(script: ScriptBuf, value: u64) -> TxOut {
    TxOut {
        value: Amount::from_sat(value),
        script_pubkey: script,
    }
}

/// Bitcoin Cash's previous transaction bc37c28d… (Trezor txcache).
fn bch_prev_bc37c2() -> Transaction {
    cached_tx(
        1,
        &[(
            "8d566ad80d5f1d3887d3acddb35b980641919e6efa7c3a3a78413e56f95ea516",
            1,
            "483045022100860b4c43649f86ee603c13791646af4736c50b532e1fc905c53d73ddd3754f3902206a301113f27b0d10622b333eb914751eed8af7f5534e0e4ee01176668674f259412102e227a30cc2aa732090af6667086b1665cbe6dbde71aab95ada5a518a4c2fdb6e",
            0xffff_ffff,
        )],
        &[(1_995_344, "76a914de701ce12e576395c863e9377c76dd7efe0c55c188ac")],
        0,
    )
}

/// Trezor `test_send_bch_change`: 1 995 344 sat from `m/44'/145'/0'/0/0` → 1 896 050 change to
/// `m/44'/145'/0'/1/0`, 73 452 to `qr23ajj…`. Kyro's signed transaction is Trezor's, byte for
/// byte (its txid 502e8577… is on chain).
#[test]
fn bch_trezor_send_with_change_is_byte_identical() {
    let s = seed(ALL);
    let prev = bch_prev_bc37c2();
    assert_eq!(
        prev.compute_txid().to_string(),
        "bc37c28dfb467d2ecb50261387bf752a3977d7e5337915071bb4151e6b711a78"
    );
    let change =
        utxo_script_pubkey(&utxo_address(&s, M, BCH, 0, true, 0).unwrap(), M, BCH).unwrap();
    let dest = utxo_script_pubkey(
        "bitcoincash:qr23ajjfd9wd73l87j642puf8cad20lfmqdgwvpat4",
        M,
        BCH,
    )
    .unwrap();
    let psbt = psbt_of(
        ALL,
        &[(&prev, 0, "m/44'/145'/0'/0/0")],
        vec![out(change, 1_896_050), out(dest, 73_452)],
        Some((0, "m/44'/145'/0'/1/0")),
    );
    let b64 = psbt.to_string();
    let preview = utxo_psbt_summary(&s, M, BCH, 0, &b64).unwrap();
    let (signed, summary) = utxo_sign_psbt(&s, M, BCH, 0, &b64).unwrap();
    assert_eq!(preview, summary);
    assert_eq!(summary.fee, "25842");
    assert_eq!(summary.size, 226);
    assert!(summary.outputs[0].is_change && !summary.outputs[1].is_change);
    assert_eq!(
        summary.outputs[1].address.as_deref(),
        Some("bitcoincash:qr23ajjfd9wd73l87j642puf8cad20lfmqdgwvpat4")
    );
    // 114 sat/B is above 100× the relay minimum: reinforced confirmation.
    assert_eq!(summary.warnings, vec![UtxoWarning::HighFee]);
    assert!(summary.requires_extra_confirmation);

    // Signed with FORKID, so finalized by wallet-core (a PSBT partial signature cannot carry
    // type 0x41): the extracted transaction is Trezor's.
    let p = Psbt::from_str(&signed).unwrap();
    assert!(p.inputs[0].partial_sigs.is_empty());
    assert!(p.inputs[0].bip32_derivation.is_empty());
    let tx = p.extract_tx_unchecked_fee_rate();
    assert_eq!(
        bitcoin::consensus::encode::serialize_hex(&tx),
        "0100000001781a716b1e15b41b07157933e5d777392a75bf87132650cb2e7d46fb8dc237bc000000006a473044022061aee4f17abe044d5df8c52c9ffd3b84e5a29743517e488b20ecf1ae0b3e4d3a02206bb84c55e407f3b684ff8d9bea0a3409cfd865795a19d10b3d3c31f12795c34a412103a020b36130021a0f037c1d1a02042e325c0cb666d6478c1afdcd9d913b9ef080ffffffff0272ee1c00000000001976a914b1401fce7e8bf123c88a0467e0ed11e3b9fbef5488acec1e0100000000001976a914d51eca49695cdf47e7f4b55507893e3ad53fe9d888ac00000000"
    );
    assert_eq!(
        tx.compute_txid().to_string(),
        "502e8577b237b0152843a416f8f1ab0c63321b1be7a8cad7bf5c5c216fcf062c"
    );
    assert!(
        tx.total_size() as u64 <= summary.size,
        "estimate is an upper bound"
    );
}

/// Trezor `test_send_bch_nochange`: both outputs of 502e8577… (keys `/1/0` and `/0/1`) to
/// `qq6wnnk…`, no change. Two inputs, each FORKID-signed: byte-identical again.
#[test]
fn bch_trezor_two_inputs_no_change_is_byte_identical() {
    let s = seed(ALL);
    let prev = parse_tx("0100000001781a716b1e15b41b07157933e5d777392a75bf87132650cb2e7d46fb8dc237bc000000006a473044022061aee4f17abe044d5df8c52c9ffd3b84e5a29743517e488b20ecf1ae0b3e4d3a02206bb84c55e407f3b684ff8d9bea0a3409cfd865795a19d10b3d3c31f12795c34a412103a020b36130021a0f037c1d1a02042e325c0cb666d6478c1afdcd9d913b9ef080ffffffff0272ee1c00000000001976a914b1401fce7e8bf123c88a0467e0ed11e3b9fbef5488acec1e0100000000001976a914d51eca49695cdf47e7f4b55507893e3ad53fe9d888ac00000000");
    let dest = utxo_script_pubkey(
        "bitcoincash:qq6wnnkrz7ykaqvxrx4hmjvayvzjzml54uyk76arx4",
        M,
        BCH,
    )
    .unwrap();
    let psbt = psbt_of(
        ALL,
        &[
            (&prev, 0, "m/44'/145'/0'/1/0"),
            (&prev, 1, "m/44'/145'/0'/0/1"),
        ],
        vec![out(dest, 1_934_960)],
        None,
    );
    let (signed, summary) = utxo_sign_psbt(&s, M, BCH, 0, &psbt.to_string()).unwrap();
    assert_eq!((summary.inputs, summary.our_inputs), (2, 2));
    assert_eq!(summary.fee, (1_896_050u64 + 73_452 - 1_934_960).to_string());
    assert!(!summary.has_change);
    let tx = Psbt::from_str(&signed)
        .unwrap()
        .extract_tx_unchecked_fee_rate();
    assert_eq!(
        bitcoin::consensus::encode::serialize_hex(&tx),
        "01000000022c06cf6f215c5cbfd7caa8e71b1b32630cabf1f816a4432815b037b277852e50000000006a47304402207a2a955f1cb3dc5f03f2c82934f55654882af4e852e5159639f6349e9386ec4002205fb8419dce4e648eae8f67bc4e369adfb130a87d2ea2d668f8144213b12bb457412103174c61e9c5362507e8061e28d2c0ce3d4df4e73f3535ae0b12f37809e0f92d2dffffffff2c06cf6f215c5cbfd7caa8e71b1b32630cabf1f816a4432815b037b277852e50010000006a473044022062151cf960b71823bbe68c7ed2c2a93ad1b9706a30255fddb02fcbe056d8c26102207bad1f0872bc5f0cfaf22e45c925c35d6c1466e303163b75cb7688038f1a5541412102595caf9aeb6ffdd0e82b150739a83297358b9a77564de382671056ad9e5b8c58ffffffff0170861d00000000001976a91434e9cec317896e818619ab7dc99d2305216ff4af88ac00000000"
    );
    assert_eq!(
        tx.compute_txid().to_string(),
        "5594fd9e5e26dcb4437cbbbba517401720849159bac4e2158e1e6401ffd5fdb7"
    );
}

/// Dash's previous transaction 5579eaa6… (Trezor txcache).
fn dash_prev_5579ea() -> Transaction {
    cached_tx(
        3,
        &[
            ("4f5a33d74e1d2aea6a0d6c374e382a9bc4d5a045dff1969ed62b887558f7a230", 0, "473044022003057fa600b72bf970fe56cf8fbaba613ec705563adcb34c4a18eb6a268d722f022070fa9e1f999dacf2b16de9887d5e37374b09fddb7e8856f250de918def31fd0d01210380137151f0cdacdd072ec5fd3b11c68c4509be9d5676d24ca2ba852173c6a899", 0xffff_fffe),
            ("4f5a33d74e1d2aea6a0d6c374e382a9bc4d5a045dff1969ed62b887558f7a230", 1, "483045022100babd26c449eb9718d3906328a392873630df77c5cafd715cfdb880f832f5470c02201a8dce2a0e784696a2bcbd64415e523e8c545773881764e7100354eaddd7337401210219a6894f4d5dd3e78c2215f9feb0d57fcce287bd0f0078ae0d246a58b3e554fb", 0xffff_fffe),
        ],
        &[
            (1_000_210, "76a9144f61517912cf3fb9a19a14912bea23792b18bdcc88ac"),
            (1_000_000_000, "76a9141e7754b21a4afe7d229b8ff46e613d1117a6515588ac"),
        ],
        21_064,
    )
}

/// Trezor `test_send_dash`: 10 DASH from `m/44'/5'/0'/0/0` to `XpTc36D…`, 1 000 duffs of fee.
/// Legacy sighash, partial signature, finalized here: byte-identical to Trezor's.
#[test]
fn dash_trezor_send_is_byte_identical() {
    let s = seed(ALL);
    let prev = dash_prev_5579ea();
    assert_eq!(
        prev.compute_txid().to_string(),
        "5579eaa64b2a0233e7d8d037f5a5afc957cedf48f1c4067e9e33ca6df22ab04f"
    );
    let dest = utxo_script_pubkey("XpTc36DPAeWmaueNBA9JqCg2GC8XDLKSYe", M, DASH).unwrap();
    let psbt = psbt_of(
        ALL,
        &[(&prev, 1, "m/44'/5'/0'/0/0")],
        vec![out(dest, 999_999_000)],
        None,
    );
    let b64 = psbt.to_string();
    let (signed, summary) = utxo_sign_psbt(&s, M, DASH, 0, &b64).unwrap();
    assert_eq!(summary, utxo_psbt_summary(&s, M, DASH, 0, &b64).unwrap());
    assert_eq!(summary.fee, "1000");
    assert_eq!(summary.size, 192, "1-in 1-out P2PKH");
    assert_eq!(summary.fee_per_kb, 5_208);
    assert!(!summary.has_change);
    assert!(summary.warnings.is_empty(), "{:?}", summary.warnings);
    assert_eq!(
        summary.outputs[0].address.as_deref(),
        Some("XpTc36DPAeWmaueNBA9JqCg2GC8XDLKSYe")
    );
    let mut p = Psbt::from_str(&signed).unwrap();
    let (pk, sig) = p.inputs[0]
        .partial_sigs
        .iter()
        .next()
        .map(|(k, s)| (*k, *s))
        .unwrap();
    assert_eq!(sig.sighash_type, EcdsaSighashType::All);
    p.inputs[0].final_script_sig = Some(
        bitcoin::script::Builder::new()
            .push_slice(bitcoin::script::PushBytesBuf::try_from(sig.to_vec()).unwrap())
            .push_key(&pk)
            .into_script(),
    );
    let tx = p.extract_tx_unchecked_fee_rate();
    assert_eq!(
        bitcoin::consensus::encode::serialize_hex(&tx),
        "01000000014fb02af26dca339e7e06c4f148dfce57c9afa5f537d0d8e733022a4ba6ea7955010000006a4730440220387be4d1e4b5e355614091416373e99e1a3532b8cc9a8629368060aff2681bdb02200a0c4a5e9eb2ce6adb6c2e01ec8f954463dcc04f531ed8a89a2b40019d5aeb0b012102936f80cac2ba719ddb238646eb6b78a170a55a52a9b9f08c43523a4a6bd5c896ffffffff0118c69a3b000000001976a9149710d6545407e78c326aa8c8ae386ec7f883b0af88ac00000000"
    );
    let d = utxo_decode_raw_tx(&bitcoin::consensus::encode::serialize_hex(&tx), M, DASH).unwrap();
    assert_eq!(d.txid, tx.compute_txid().to_string());
}

/// Trezor `test_send_dash_dip2_input`'s previous transaction 15575a1c… is a DIP2 coinbase
/// (type 5, version 3, 38-byte payload). Kyro decodes it (txid over the payload, outputs shown)
/// but cannot spend it: a PSBT `non_witness_utxo` cannot carry the payload, so the spent
/// transaction it carries never hashes to the outpoint — refused, never signed blindly.
#[test]
fn dash_dip2_special_transaction_is_decoded_but_not_spent() {
    let base = cached_tx(
        327_683,
        &[(
            "0000000000000000000000000000000000000000000000000000000000000000",
            0xffff_ffff,
            "023a52042ab0355c08fabe6d6d0000000000000000000000000000000000000000000000000000000000000000010000000000000010000017cd0000000d2f6e6f64655374726174756d2f",
            0,
        )],
        &[
            (4_095_000_262, "76a914cb594917ad4e5849688ec63f29a0f7f3badb5da688ac"),
            (4_095_000_260, "76a9141e7754b21a4afe7d229b8ff46e613d1117a6515588ac"),
        ],
        0,
    );
    let raw = format!(
        "{}{}",
        bitcoin::consensus::encode::serialize_hex(&base),
        "2601003a5200009e8ecb69a1493e3d573cc9ce8460b9a0d7b05e77ca17878c9faf73959392cef3"
    );
    let d = utxo_decode_raw_tx(&raw, M, DASH).unwrap();
    assert_eq!(
        d.txid,
        "15575a1c874bd60a819884e116c42e6791c8283ce1fc3b79f0d18531a61bbb8a"
    );
    assert!(d.inputs.is_empty(), "coinbase");
    assert_eq!(d.outputs[1].1, 4_095_000_260);
    assert_eq!(
        d.outputs[1].0.as_deref(),
        Some("XdTw4G5AWW4cogGd7ayybyBNDbuB45UpgH")
    );
    assert!(utxo_is_special_tx(&raw, DASH));
    assert!(!utxo_is_special_tx(&raw, BCH));
    // Truncated payload / trailing garbage: malformed.
    assert!(utxo_decode_raw_tx(&raw[..raw.len() - 2], M, DASH).is_err());
    assert!(utxo_decode_raw_tx(&format!("{raw}00"), M, DASH).is_err());
    // The other chains' decoder does not know the payload.
    assert!(utxo_decode_raw_tx(&raw, M, BCH).is_err());

    // Spending it: the PSBT can only carry the payload-less transaction → txid mismatch.
    let s = seed(ALL);
    let change =
        utxo_script_pubkey(&utxo_address(&s, M, DASH, 0, true, 0).unwrap(), M, DASH).unwrap();
    let mut psbt = psbt_of(
        ALL,
        &[(&base, 1, "m/44'/5'/0'/0/0")],
        vec![out(change, 4_000_000_000)],
        None,
    );
    psbt.unsigned_tx.input[0].previous_output.txid = Txid::from_str(&d.txid).unwrap();
    let e = utxo_sign_psbt(&s, M, DASH, 0, &psbt.to_string()).unwrap_err();
    assert!(
        matches!(&e, Error::Psbt(m) if m.contains("does not match")),
        "{e:?}"
    );
}

// ------------------------------------------------------------------------------------------
// Refusals and warnings
// ------------------------------------------------------------------------------------------

fn psbt_err(r: Result<(String, UtxoTxSummary), Error>) -> String {
    match r {
        Err(Error::Psbt(m)) => m,
        other => panic!("expected a PSBT error, got {other:?}"),
    }
}

/// Testnet send for `coin`: 1 coin out of 10 from `m/44'/1'/0'/0/0`, change to `/1/0`.
fn testnet_psbt(coin: UtxoCoin, fee: u64) -> (Psbt, Transaction) {
    let s = seed(ABANDON);
    let me = utxo_script_pubkey(&utxo_address(&s, T, coin, 0, false, 0).unwrap(), T, coin).unwrap();
    let change =
        utxo_script_pubkey(&utxo_address(&s, T, coin, 0, true, 0).unwrap(), T, coin).unwrap();
    let dest = utxo_script_pubkey(
        &utxo_address(&seed(LEGAL), T, coin, 0, false, 0).unwrap(),
        T,
        coin,
    )
    .unwrap();
    let prev = cached_tx(
        2,
        &[(
            "7618443203806e0d93f7cfd2fc1c3d29ddce290b1d049e12a454ce442238539d",
            1,
            "",
            0xffff_ffff,
        )],
        &[(1_234, "76a914e6c7989b8836301af965531c39865a73d745e46788ac")],
        0,
    );
    let mut prev = prev;
    prev.output.push(out(me, 1_000_000_000));
    let mut psbt = psbt_of(
        ABANDON,
        &[(&prev, 1, "m/44'/1'/0'/0/0")],
        vec![out(dest, 100_000_000), out(change, 900_000_000 - fee)],
        Some((1, "m/44'/1'/0'/1/0")),
    );
    // Testnet keys: the fingerprint is the same, only the xpub version differs.
    psbt.unsigned_tx.version = Version::TWO;
    (psbt, prev)
}

#[test]
fn testnet_sends_sign_with_the_right_sighash() {
    let s = seed(ABANDON);
    for coin in [BCH, DASH] {
        let (psbt, prev) = testnet_psbt(coin, 226);
        let (signed, sum) = utxo_sign_psbt(&s, T, coin, 0, &psbt.to_string()).unwrap();
        assert_eq!(sum.fee, "226");
        assert_eq!(sum.fee_per_kb, 1_000, "1 sat/B");
        assert!(sum.warnings.is_empty(), "{coin:?} {:?}", sum.warnings);
        assert!(sum.outputs[1].is_change && !sum.outputs[0].is_change);
        let p = Psbt::from_str(&signed).unwrap();
        let prevout = &prev.output[1];
        let (der, pk) = if coin == BCH {
            let ss = p.inputs[0].final_script_sig.clone().unwrap();
            let v = pushes(&ss);
            (v[0].clone(), v[1].clone())
        } else {
            let (pk, sig) = p.inputs[0].partial_sigs.iter().next().unwrap();
            (sig.to_vec(), pk.to_bytes())
        };
        let tx = &p.unsigned_tx;
        if coin == BCH {
            let h = bch_forkid_sighash(tx, 0, &prevout.script_pubkey, prevout.value.to_sat(), 0x41)
                .unwrap();
            verify(Message::from_digest(h), &der, &pk, 0x41);
        } else {
            let h = SighashCache::new(tx)
                .legacy_signature_hash(0, &prevout.script_pubkey, 1)
                .unwrap();
            verify(Message::from(h), &der, &pk, 0x01);
        }
    }
}

#[test]
fn previous_transaction_is_mandatory_and_must_match() {
    let s = seed(ABANDON);
    for coin in [BCH, DASH] {
        let sign = |p: &Psbt| utxo_sign_psbt(&s, T, coin, 0, &p.to_string());
        let (mut p, prev) = testnet_psbt(coin, 226);
        p.inputs[0].non_witness_utxo = None;
        assert!(psbt_err(sign(&p)).contains("non_witness_utxo"), "{coin:?}");
        // The server lies about the amount and forges the previous transaction: txid mismatch.
        let (mut p, mut forged) = testnet_psbt(coin, 226);
        forged.output[1].value = Amount::from_sat(2_000_000_000);
        p.inputs[0].non_witness_utxo = Some(forged);
        assert!(psbt_err(sign(&p)).contains("does not match"));
        // SegWit data refused.
        let (mut p, _) = testnet_psbt(coin, 226);
        p.inputs[0].witness_utxo = Some(prev.output[1].clone());
        assert!(psbt_err(sign(&p)).contains("SegWit"));
        // Only SIGHASH_ALL is asked for (Bitcoin Cash: signed ALL|FORKID).
        let (mut p, _) = testnet_psbt(coin, 226);
        p.inputs[0].sighash_type = Some(EcdsaSighashType::None.into());
        assert!(psbt_err(sign(&p)).contains("SIGHASH_ALL"));
    }
}

/// Owner's rule for Dash (legacy sighash, amounts not committed): the fee comes from the
/// verified previous transaction, never from what a server claimed.
#[test]
fn dash_amounts_come_only_from_the_verified_previous_transaction() {
    let s = seed(ABANDON);
    let (mut p, prev) = testnet_psbt(DASH, 226);
    assert_eq!(prev.output[1].value.to_sat(), 1_000_000_000);
    // The adapter believed a 5 DASH coin: 1 out, 3.99999774 back. The real fee is 5 DASH.
    p.unsigned_tx.output[1].value = Amount::from_sat(400_000_000 - 226);
    let sum = utxo_psbt_summary(&s, T, DASH, 0, &p.to_string()).unwrap();
    assert_eq!(sum.fee, (500_000_000u64 + 226).to_string());
    assert!(sum.warnings.contains(&UtxoWarning::HighFee));
    assert!(sum.requires_extra_confirmation);
}

#[test]
fn dust_versions_and_fees() {
    let s = seed(ABANDON);
    for coin in [BCH, DASH] {
        // 546 is the P2PKH dust limit (3 000 per kB relay dust fee): 545 refused.
        let (mut p, _) = testnet_psbt(coin, 226);
        p.unsigned_tx.output[0].value = Amount::from_sat(545);
        assert!(psbt_err(utxo_sign_psbt(&s, T, coin, 0, &p.to_string())).contains("dust"));
        let (mut p, _) = testnet_psbt(coin, 226);
        p.unsigned_tx.output[0].value = Amount::from_sat(546);
        assert!(utxo_sign_psbt(&s, T, coin, 0, &p.to_string()).is_ok());
        // Below 1 sat/B: informative only.
        let (p, _) = testnet_psbt(coin, 100);
        let sum = utxo_psbt_summary(&s, T, coin, 0, &p.to_string()).unwrap();
        assert!(
            matches!(&sum.warnings[..], [UtxoWarning::FeeBelowMinimum { minimum }] if minimum == "226")
        );
        assert!(!sum.requires_extra_confirmation);
    }
    // Bitcoin Cash: transaction versions other than 1 / 2 are invalid since May 2023.
    let (mut p, _) = testnet_psbt(BCH, 226);
    p.unsigned_tx.version = Version(3);
    assert!(psbt_err(utxo_sign_psbt(&s, T, BCH, 0, &p.to_string())).contains("version"));
    // Dash: a special transaction (type ≠ 0) is never signed.
    let (mut p, _) = testnet_psbt(DASH, 226);
    p.unsigned_tx.version = Version(0x0001_0003);
    assert!(psbt_err(utxo_sign_psbt(&s, T, DASH, 0, &p.to_string())).contains("special"));
    // Dash version 3, type 0: an ordinary transaction.
    let (mut p, _) = testnet_psbt(DASH, 226);
    p.unsigned_tx.version = Version(3);
    assert!(utxo_sign_psbt(&s, T, DASH, 0, &p.to_string()).is_ok());
}

/// A Bitcoin Cash key origin (`m/44'/145'/…`) is foreign to Dash (`m/44'/5'/…`), and another
/// account of the same chain is foreign too: nothing of ours, nothing signed.
#[test]
fn other_coin_types_and_accounts_are_foreign() {
    let s = seed(ALL);
    let prev = bch_prev_bc37c2();
    let dest = utxo_script_pubkey("XpTc36DPAeWmaueNBA9JqCg2GC8XDLKSYe", M, DASH).unwrap();
    let psbt = psbt_of(
        ALL,
        &[(&prev, 0, "m/44'/145'/0'/0/0")],
        vec![out(dest, 1_900_000)],
        None,
    );
    assert!(psbt_err(utxo_sign_psbt(&s, M, DASH, 0, &psbt.to_string())).contains("no input"));
    // Account 1 of Bitcoin Cash does not sign account 0's coin.
    let dest = utxo_script_pubkey(
        "bitcoincash:qr23ajjfd9wd73l87j642puf8cad20lfmqdgwvpat4",
        M,
        BCH,
    )
    .unwrap();
    let psbt = psbt_of(
        ALL,
        &[(&prev, 0, "m/44'/145'/0'/0/0")],
        vec![out(dest, 1_900_000)],
        None,
    );
    assert!(psbt_err(utxo_sign_psbt(&s, M, BCH, 1, &psbt.to_string())).contains("no input"));
    assert!(utxo_sign_psbt(&s, M, BCH, 0, &psbt.to_string()).is_ok());
}

#[test]
fn summary_json_names_the_coins() {
    let s = seed(ABANDON);
    for (coin, name) in [(BCH, "bitcoincash"), (DASH, "dash")] {
        let (p, _) = testnet_psbt(coin, 226);
        let v = serde_json::to_value(utxo_psbt_summary(&s, T, coin, 0, &p.to_string()).unwrap())
            .unwrap();
        assert_eq!(v["coin"], name);
        assert_eq!(serde_json::to_value(coin).unwrap(), name);
    }
}
