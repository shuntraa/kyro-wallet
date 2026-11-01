//! Zcash transparent: derivation, addresses (t-addresses only, shielded refused), real mainnet
//! v5 transaction (ZIP-244 txid and signature digest checked against a signature made by
//! another wallet), consensus branch checks, building and signing.
//!
//! Sources:
//! - address derivation: recomputed independently with `@scure/bip32` + `@scure/base`
//!   (base58check) from the BIP39 vectors, see `ADDRESS_VECTORS`;
//! - ZIP 320 example (TEX ↔ t-address of the same key hash): https://zips.z.cash/zip-0320;
//! - real chain data: `tests/data/zec_mainnet_v5.json`, read-only from
//!   `zec.electrum1.cipig.net:20058` (Komodo's public ElectrumX) on 2026-11-01.

mod common;

use bitcoin::bip32::{DerivationPath, Xpriv};
use bitcoin::secp256k1::{ecdsa, Message, PublicKey, Secp256k1};
use bitcoin::NetworkKind;
use common::{seed, ABANDON, LEGAL};
use serde_json::Value;
use std::str::FromStr;
use wallet_core::{
    zec_account, zec_address, zec_address_from_xpub, zec_address_of_script, zec_consensus,
    zec_decode_raw_tx, zec_header_branch_id, zec_input_sighash, zec_next_upgrade,
    zec_parse_address, zec_sign, zec_tx_summary, Error, Network, ZecAddressKind, ZecCoin,
    ZecSendRequest, ZecWarning,
};

const MAIN: Network = Network::Mainnet;
const TEST: Network = Network::Testnet;
/// NU6.3 consensus branch id (zcash_protocol), the one in force on mainnet on 2026-11-01.
const NU6_3: u32 = 0x37a5_165b;
/// A mainnet height under NU6.3 (the recorded tip).
const TIP: u32 = 3_537_784;

fn fixture() -> Value {
    serde_json::from_str(include_str!("data/zec_mainnet_v5.json")).unwrap()
}

// ------------------------------------------------------------------------------------------
// Derivation and addresses
// ------------------------------------------------------------------------------------------

/// `(phrase, network, account, change, index, address)`, recomputed with @scure/bip32 1.7.0
/// (`HDKey.fromMasterSeed(mnemonicToSeed(phrase)).derive("m/44'/133'/a'/c/i")`) and
/// `@scure/base` base58check over `0x1cb8 ‖ hash160(pubkey)` (testnet `0x1d25`, coin type 1).
const ADDRESS_VECTORS: &[(&str, Network, u32, bool, u32, &str)] = &[
    (
        ABANDON,
        MAIN,
        0,
        false,
        0,
        "t1XVXWCvpMgBvUaed4XDqWtgQgJSu1Ghz7F",
    ),
    (
        ABANDON,
        MAIN,
        0,
        false,
        1,
        "t1aQ2b1XszNVo15BguYLbQGqETBL9QZA8Jq",
    ),
    (
        ABANDON,
        MAIN,
        0,
        true,
        0,
        "t1YF8h4qviS77p36wWdUfe8faw4DXduYZnm",
    ),
    (
        ABANDON,
        MAIN,
        1,
        false,
        0,
        "t1Hxm2pmTLYuKhyLeZoSPjsHPFLWePSTDka",
    ),
    (
        ABANDON,
        TEST,
        0,
        false,
        0,
        "tmF1xjfhsSzhy55dmhorzTnKjtHhZmPKzts",
    ),
    (
        ABANDON,
        TEST,
        0,
        true,
        3,
        "tmSP6PkGnmXEiJspiZ9u7YHGhayz1hgiVXN",
    ),
    (
        LEGAL,
        MAIN,
        0,
        false,
        0,
        "t1NSAmNsWQhLGokWiCnpA7mvRmRJrxuiXGy",
    ),
    (
        LEGAL,
        MAIN,
        2,
        false,
        7,
        "t1LeHUmFNeFjiUZJyYwXDusBXRBabo3oXP7",
    ),
];

#[test]
fn addresses_match_an_independent_implementation() {
    for (phrase, net, account, change, index, want) in ADDRESS_VECTORS {
        let s = seed(phrase);
        assert_eq!(
            zec_address(&s, *net, *account, *change, *index).unwrap(),
            *want,
            "{phrase} {net:?} {account}/{change}/{index}"
        );
        let acct = zec_account(&s, *net, *account).unwrap();
        assert_eq!(
            zec_address_from_xpub(&acct.xpub, *net, *change, *index).unwrap(),
            *want
        );
    }
}

#[test]
fn account_paths_and_xpub_network() {
    let s = seed(ABANDON);
    let a = zec_account(&s, MAIN, 0).unwrap();
    assert_eq!(a.path, "m/44'/133'/0'");
    assert!(a.xpub.starts_with("xpub"));
    assert_eq!(a.fingerprint, "73c5da0a");
    assert_eq!(zec_account(&s, MAIN, 3).unwrap().path, "m/44'/133'/3'");
    let t = zec_account(&s, TEST, 0).unwrap();
    assert_eq!(t.path, "m/44'/1'/0'");
    assert!(t.xpub.starts_with("tpub"));
    // A mainnet xpub is refused on testnet, and the reverse.
    assert!(zec_address_from_xpub(&a.xpub, TEST, false, 0).is_err());
    assert!(zec_address_from_xpub(&t.xpub, MAIN, false, 0).is_err());
    // Mainnet t1…, testnet tm…; accounts and wallets differ.
    let m0 = zec_address(&s, MAIN, 0, false, 0).unwrap();
    assert!(m0.starts_with("t1"), "{m0}");
    assert!(zec_address(&s, TEST, 0, false, 0)
        .unwrap()
        .starts_with("tm"));
    assert_ne!(m0, zec_address(&s, MAIN, 1, false, 0).unwrap());
    assert_ne!(m0, zec_address(&s, MAIN, 0, true, 0).unwrap());
    assert_ne!(m0, zec_address(&seed(LEGAL), MAIN, 0, false, 0).unwrap());
    // The key is the BIP44 key of m/44'/133'/0'/0/0 (rust-bitcoin derivation, hash160).
    let secp = Secp256k1::new();
    let master = Xpriv::new_master(NetworkKind::Main, &s[..]).unwrap();
    let k = master
        .derive_priv(
            &secp,
            &DerivationPath::from_str("m/44'/133'/0'/0/0").unwrap(),
        )
        .unwrap();
    let pk = k.private_key.public_key(&secp);
    let spk = [
        &[0x76u8, 0xa9, 0x14][..],
        bitcoin::PublicKey::new(pk).pubkey_hash().as_ref(),
        &[0x88, 0xac],
    ]
    .concat();
    assert_eq!(zec_address_of_script(&spk, MAIN).unwrap(), m0);
}

#[test]
fn destinations_t_addresses_only() {
    let s = seed(ABANDON);
    let mine = zec_address(&s, MAIN, 0, false, 0).unwrap();
    let (spk, kind) = zec_parse_address(&mine, MAIN).unwrap();
    assert_eq!(kind, ZecAddressKind::P2pkh);
    assert_eq!(zec_address_of_script(&spk, MAIN).unwrap(), mine);
    // Real mainnet P2SH (t3…) round trip.
    let p2sh = [&[0xa9u8, 0x14][..], &[7u8; 20], &[0x87]].concat();
    let t3 = zec_address_of_script(&p2sh, MAIN).unwrap();
    assert!(t3.starts_with("t3"), "{t3}");
    assert_eq!(
        zec_parse_address(&t3, MAIN).unwrap(),
        (p2sh.clone(), ZecAddressKind::P2sh)
    );
    let t2 = zec_address_of_script(&p2sh, TEST).unwrap();
    assert!(t2.starts_with("t2"), "{t2}");

    // Shielded and unified addresses: refused, with a message that says why.
    for z in [
        "zs1z7rejlpsa98s2rrrfkwmaxu53e4ue0ulcrw0h4x5g8jl04tak0d3mm47vdtahatqrlkngh9sly",
        "u1l8xunezsvhq8fgzfl7404m450nwnd76zshscn6nfys7vyz2ywyh4cc5daaq0c7q2su5lqfh23sp7fkf3kt27ve5948mzpfdvckzaect2jtte308mkwlycj2u0eac077wu70vqcetkxf",
        "ztestsapling1abcdef",
        "utest1abcdef",
        "ZS1Z7REJLPSA98S2RRRFKWMAXU53E4UE0ULCRW0H4X5G8JL04TAK0D3MM47VDTAHATQRLKNGH9SLY",
    ] {
        let e = zec_parse_address(z, MAIN).unwrap_err();
        assert!(
            matches!(&e, Error::InvalidInput(m) if m.contains("protégée")),
            "{z}: {e}"
        );
    }
    // Other network, Bitcoin, garbage: refused.
    let tm = zec_address(&s, TEST, 0, false, 0).unwrap();
    assert!(
        matches!(zec_parse_address(&tm, MAIN), Err(Error::InvalidInput(m)) if m.contains("autre réseau"))
    );
    assert!(
        matches!(zec_parse_address(&mine, TEST), Err(Error::InvalidInput(m)) if m.contains("autre réseau"))
    );
    for bad in [
        "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2",
        "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
        "t1",
        "",
        &mine[..mine.len() - 1],
    ] {
        assert!(zec_parse_address(bad, MAIN).is_err(), "{bad}");
    }
    // Non-standard scripts have no address.
    assert!(zec_address_of_script(&[0x6a, 0x01, 0x00], MAIN).is_none());
    assert!(zec_address_of_script(&[0x51], MAIN).is_none());
}

/// ZIP 320: `tex1s2rt77ggv6q989lr49rkgzmh5slsksa9khdgte` is the TEX form of
/// `t1VmmGiyjVNeCjxDZzg7vZmd99WyzVby9yC` (same 20-byte key hash, transparent-source-only).
#[test]
fn tex_addresses_pay_the_same_key_hash() {
    let (t_spk, t_kind) = zec_parse_address("t1VmmGiyjVNeCjxDZzg7vZmd99WyzVby9yC", MAIN).unwrap();
    let (x_spk, x_kind) =
        zec_parse_address("tex1s2rt77ggv6q989lr49rkgzmh5slsksa9khdgte", MAIN).unwrap();
    assert_eq!(t_kind, ZecAddressKind::P2pkh);
    assert_eq!(x_kind, ZecAddressKind::Tex);
    assert_eq!(t_spk, x_spk);
    // Bad checksum (bech32m), testnet TEX on mainnet: refused.
    assert!(zec_parse_address("tex1s2rt77ggv6q989lr49rkgzmh5slsksa9khdgtf", MAIN).is_err());
    assert!(zec_parse_address("tex1s2rt77ggv6q989lr49rkgzmh5slsksa9khdgte", TEST).is_err());
}

// ------------------------------------------------------------------------------------------
// Real mainnet data
// ------------------------------------------------------------------------------------------

/// Pushes of a P2PKH scriptSig: `<sig‖hashtype> <pubkey>`.
fn script_sig_parts(raw: &[u8]) -> (Vec<u8>, Vec<u8>) {
    let l1 = raw[0] as usize;
    let sig = raw[1..1 + l1].to_vec();
    let l2 = raw[1 + l1] as usize;
    let pk = raw[2 + l1..2 + l1 + l2].to_vec();
    assert_eq!(raw.len(), 2 + l1 + l2);
    (sig, pk)
}

/// First input's scriptSig of a one-input v5 transaction (fixed v5 layout: 20-byte header,
/// vin count, outpoint 36, scriptSig length).
fn first_script_sig(tx: &[u8]) -> Vec<u8> {
    assert_eq!(tx[20], 1, "one input");
    let len = tx[57] as usize;
    tx[58..58 + len].to_vec()
}

#[test]
fn real_mainnet_v5_txid_and_signature_digest() {
    let f = fixture();
    let hex_tx = f["tx"]["hex"].as_str().unwrap();
    let raw = hex::decode(hex_tx).unwrap();
    let tx = zec_decode_raw_tx(hex_tx, MAIN).unwrap();
    // ZIP-244 txid recomputed by zcash_primitives = the server's (and explorers') txid.
    assert_eq!(tx.txid, f["tx"]["txid"].as_str().unwrap());
    assert_eq!(tx.version, 5);
    assert_eq!(tx.branch_id, Some(NU6_3));
    assert_eq!(zec_header_branch_id(&raw), Some(NU6_3));
    assert!(!tx.shielded && !tx.coinbase);
    assert_eq!(tx.inputs.len(), 1);
    assert_eq!(tx.outputs.len(), 2);
    assert!(tx
        .outputs
        .iter()
        .all(|o| o.0.as_deref().is_some_and(|a| a.starts_with("t1"))));
    assert_eq!(tx.outputs[0].1, 6_715_070);

    // The previous transaction, and the output it spends.
    let (prev_id, vout) = &tx.inputs[0];
    let prev_hex = f["prev_txs"][prev_id].as_str().unwrap();
    let prev = zec_decode_raw_tx(prev_hex, MAIN).unwrap();
    assert_eq!(&prev.txid, prev_id);
    let (_, value, spk) = &prev.outputs[*vout as usize];

    // The signature another wallet made verifies against the digest Kyro computes.
    let digest = zec_input_sighash(hex_tx, &[(*value, hex::decode(spk).unwrap())], 0).unwrap();
    let (sig, pk) = script_sig_parts(&first_script_sig(&raw));
    assert_eq!(*sig.last().unwrap(), 0x01, "SIGHASH_ALL");
    let secp = Secp256k1::verification_only();
    let sig = ecdsa::Signature::from_der(&sig[..sig.len() - 1]).unwrap();
    let pk = PublicKey::from_slice(&pk).unwrap();
    let msg = Message::from_digest(digest);
    secp.verify_ecdsa(&msg, &sig, &pk).unwrap();
    // The digest commits to the spent amount and script (ZIP 244): one zatoshi off, or
    // another script, and the same signature no longer verifies.
    let lie = zec_input_sighash(hex_tx, &[(*value + 1, hex::decode(spk).unwrap())], 0).unwrap();
    assert!(secp
        .verify_ecdsa(&Message::from_digest(lie), &sig, &pk)
        .is_err());
    let other = zec_input_sighash(hex_tx, &[(*value, vec![0x51])], 0).unwrap();
    assert!(secp
        .verify_ecdsa(&Message::from_digest(other), &sig, &pk)
        .is_err());

    // The tip coinbase (v6 under NU6.3) parses too and gives the same branch id.
    let cb = f["coinbase"]["hex"].as_str().unwrap();
    let c = zec_decode_raw_tx(cb, MAIN).unwrap();
    assert_eq!(c.txid, f["coinbase"]["txid"].as_str().unwrap());
    assert!(c.coinbase && c.inputs.is_empty());
    assert_eq!(zec_header_branch_id(&hex::decode(cb).unwrap()), Some(NU6_3));

    // Malformed: truncated, trailing byte, not hex.
    assert!(zec_decode_raw_tx(&hex_tx[..hex_tx.len() - 2], MAIN).is_err());
    assert!(zec_decode_raw_tx(&format!("{hex_tx}00"), MAIN).is_err());
    assert!(zec_decode_raw_tx("zz", MAIN).is_err());
    // v4 and earlier carry no branch id.
    assert_eq!(
        zec_header_branch_id(&[0x04, 0, 0, 0x80, 0x85, 0x20, 0x2f, 0x89, 1, 2, 3, 4]),
        None
    );
    assert_eq!(zec_header_branch_id(&[0x05, 0, 0, 0x80]), None);
}

// ------------------------------------------------------------------------------------------
// Consensus branch
// ------------------------------------------------------------------------------------------

#[test]
fn consensus_branch_is_read_from_the_chain_and_checked() {
    let c = zec_consensus(MAIN, TIP, TIP, NU6_3).unwrap();
    assert_eq!(c.branch_id, NU6_3);
    assert_eq!(c.upgrade, "NU6.3");
    assert_eq!(c.target_height, TIP + 1);
    assert_eq!(c.expiry_height, TIP + 1 + 40);
    assert!(!c.expiry_capped);
    // Read a few blocks below the tip: fine; more than 10, or above the tip: refused.
    assert!(zec_consensus(MAIN, TIP, TIP - 2, NU6_3).is_ok());
    assert!(zec_consensus(MAIN, TIP, TIP - 11, NU6_3).is_err());
    assert!(zec_consensus(MAIN, TIP, TIP + 1, NU6_3).is_err());
    // A branch id this build does not know (a newer network upgrade): refused, says to update.
    let e = zec_consensus(MAIN, TIP, TIP, 0xdead_beef).unwrap_err();
    assert!(
        matches!(&e, Error::InvalidInput(m) if m.contains("0xdeadbeef") && m.contains("mets Kyro à jour")),
        "{e}"
    );
    // A known branch that is not the one of this height (older NU6.1, or NU7 activated on the
    // network while this build has no mainnet height for it): refused.
    for other in [0x4dec_4df0u32, 0x7719_0ad9] {
        let e = zec_consensus(MAIN, TIP, TIP, other).unwrap_err();
        assert!(
            matches!(&e, Error::InvalidInput(m) if m.contains("mets Kyro à jour")),
            "{e}"
        );
    }
}

#[test]
fn expiry_is_capped_before_a_known_upgrade() {
    // Testnet: zcash_protocol knows NU7 at 4 465 026 (NU6.3 since 4 134 000).
    let (name, at) = zec_next_upgrade(TEST, 4_400_000).unwrap();
    assert_eq!((name.as_str(), at), ("NU7", 4_465_026));
    let tip = at - 10;
    let c = zec_consensus(TEST, tip, tip, NU6_3).unwrap();
    assert_eq!(c.upgrade, "NU6.3");
    assert_eq!(c.expiry_height, at - 1);
    assert!(c.expiry_capped);
    // At the activation height itself, the new branch applies to the next block.
    let c = zec_consensus(TEST, at - 1, at - 1, NU6_3).unwrap();
    assert_eq!(c.upgrade, "NU7");
    assert_eq!(c.branch_id, 0x7719_0ad9);
}

// ------------------------------------------------------------------------------------------
// Building and signing
// ------------------------------------------------------------------------------------------

/// A v5 transparent transaction paying `outputs`, with one dummy input (`salt` makes the txid
/// unique) or a coinbase input. Layout: ZIP 225.
fn fake_prev(outputs: &[(u64, Vec<u8>)], salt: u8, coinbase: bool) -> String {
    let mut b = Vec::new();
    b.extend_from_slice(&0x8000_0005u32.to_le_bytes());
    b.extend_from_slice(&0x26a7_270au32.to_le_bytes());
    b.extend_from_slice(&NU6_3.to_le_bytes());
    b.extend_from_slice(&0u32.to_le_bytes()); // lock_time
    b.extend_from_slice(&0u32.to_le_bytes()); // expiry
    b.push(1);
    if coinbase {
        b.extend_from_slice(&[0u8; 32]);
        b.extend_from_slice(&u32::MAX.to_le_bytes());
        b.extend_from_slice(&[4, 0x03, 0x01, 0x02, salt]);
    } else {
        b.extend_from_slice(&[salt; 32]);
        b.extend_from_slice(&0u32.to_le_bytes());
        b.push(0);
    }
    b.extend_from_slice(&u32::MAX.to_le_bytes());
    b.push(u8::try_from(outputs.len()).unwrap());
    for (v, s) in outputs {
        b.extend_from_slice(&v.to_le_bytes());
        b.push(u8::try_from(s.len()).unwrap());
        b.extend_from_slice(s);
    }
    b.extend_from_slice(&[0, 0, 0]); // no Sapling spends / outputs, no Orchard actions
    hex::encode(b)
}

fn our_script(phrase: &str, account: u32, change: bool, index: u32) -> Vec<u8> {
    let a = zec_address(&seed(phrase), MAIN, account, change, index).unwrap();
    zec_parse_address(&a, MAIN).unwrap().0
}

fn coin(value: u64, salt: u8, change: bool, index: u32) -> ZecCoin {
    ZecCoin {
        prev_tx: fake_prev(
            &[(value, our_script(ABANDON, 0, change, index))],
            salt,
            false,
        ),
        vout: 0,
        change,
        index,
    }
}

fn request(coins: Vec<ZecCoin>, to: &str, amount: u64) -> ZecSendRequest {
    ZecSendRequest {
        coins,
        to: to.into(),
        amount,
        max: false,
        change_index: 2,
        tip_height: TIP,
        network_branch_height: TIP,
        network_branch_id: NU6_3,
    }
}

const DEST: &str = "t1VmmGiyjVNeCjxDZzg7vZmd99WyzVby9yC";

#[test]
fn builds_and_signs_a_v5_transaction() {
    let s = seed(ABANDON);
    let req = request(
        vec![coin(30_000_000, 1, false, 0), coin(5_000_000, 2, true, 1)],
        DEST,
        12_345_678,
    );
    let summary = zec_tx_summary(&s, MAIN, 0, &req).unwrap();
    // Largest coin first: one input is enough. ZIP 317: 1 input, 2 outputs → 2 logical
    // actions = the 2 grace actions → 10 000 zatoshis.
    assert_eq!(summary.inputs, 1);
    assert_eq!(summary.input_total, "30000000");
    assert_eq!(summary.amount, "12345678");
    assert_eq!(summary.fee, "10000");
    assert_eq!(summary.zip317_fee, "10000");
    assert_eq!(summary.folded, "0");
    let change = summary.change.clone().unwrap();
    assert_eq!(
        change.amount,
        (30_000_000u64 - 12_345_678 - 10_000).to_string()
    );
    assert_eq!(change.index, 2);
    assert_eq!(change.address, zec_address(&s, MAIN, 0, true, 2).unwrap());
    assert_eq!(summary.to_address, DEST);
    assert_eq!(summary.to_kind, ZecAddressKind::P2pkh);
    assert_eq!(summary.upgrade, "NU6.3");
    assert_eq!(summary.branch_id, "0x37a5165b");
    assert_eq!(summary.expiry_height, TIP + 41);
    assert!(summary.warnings.is_empty());
    assert!(!summary.requires_extra_confirmation);

    let (signed_hex, again) = zec_sign(&s, MAIN, 0, &req).unwrap();
    assert_eq!(again, summary);
    let tx = zec_decode_raw_tx(&signed_hex, MAIN).unwrap();
    assert_eq!(
        tx.txid, summary.txid,
        "ZIP-244 txid does not depend on signatures"
    );
    assert_eq!(tx.version, 5);
    assert_eq!(tx.branch_id, Some(NU6_3));
    assert_eq!(
        tx.outputs
            .iter()
            .map(|o| (o.0.clone().unwrap(), o.1))
            .collect::<Vec<_>>(),
        vec![
            (DEST.to_owned(), 12_345_678),
            (change.address.clone(), 30_000_000 - 12_345_678 - 10_000)
        ]
    );
    let prev = zec_decode_raw_tx(&req.coins[0].prev_tx, MAIN).unwrap();
    assert_eq!(tx.inputs, vec![(prev.txid.clone(), 0)]);

    // The signature verifies against the ZIP-244 digest (recomputed from the signed bytes)
    // and the key of m/44'/133'/0'/0/0.
    let raw = hex::decode(&signed_hex).unwrap();
    let (sig, pk) = script_sig_parts(&first_script_sig(&raw));
    assert_eq!(*sig.last().unwrap(), 0x01);
    let digest = zec_input_sighash(
        &signed_hex,
        &[(30_000_000, our_script(ABANDON, 0, false, 0))],
        0,
    )
    .unwrap();
    let secp = Secp256k1::verification_only();
    let sig = ecdsa::Signature::from_der(&sig[..sig.len() - 1]).unwrap();
    let mut normalized = sig;
    normalized.normalize_s();
    assert_eq!(normalized, sig, "low-S");
    let pk = PublicKey::from_slice(&pk).unwrap();
    secp.verify_ecdsa(&Message::from_digest(digest), &sig, &pk)
        .unwrap();
    let master = Xpriv::new_master(NetworkKind::Main, &s[..]).unwrap();
    let want = master
        .derive_priv(
            &Secp256k1::new(),
            &DerivationPath::from_str("m/44'/133'/0'/0/0").unwrap(),
        )
        .unwrap()
        .private_key
        .public_key(&Secp256k1::new());
    assert_eq!(pk, want);
}

#[test]
fn selection_change_max_and_dust() {
    let s = seed(ABANDON);
    // Two coins needed: 2 inputs, 2 outputs → still 2 logical actions (300/150, 68/34).
    let r = zec_tx_summary(
        &s,
        MAIN,
        0,
        &request(
            vec![coin(1_000_000, 1, false, 0), coin(600_000, 2, false, 3)],
            DEST,
            1_200_000,
        ),
    )
    .unwrap();
    assert_eq!((r.inputs, r.fee.as_str()), (2, "10000"));
    assert_eq!(r.change.unwrap().amount, "390000");
    // Three inputs: 3 logical actions → 15 000.
    let r = zec_tx_summary(
        &s,
        MAIN,
        0,
        &request(
            vec![
                coin(500_000, 1, false, 0),
                coin(500_000, 2, false, 1),
                coin(500_000, 3, true, 0),
            ],
            DEST,
            1_400_000,
        ),
    )
    .unwrap();
    assert_eq!(
        (r.inputs, r.fee.as_str(), r.zip317_fee.as_str()),
        (3, "15000", "15000")
    );
    assert_eq!(r.change.unwrap().amount, "85000");
}

#[test]
fn small_remainder_is_folded_into_the_fee() {
    let s = seed(ABANDON);
    // 1 000 000 − 985 000 − 10 000 = 5 000 − 1: below ZEC_MIN_CHANGE, folded.
    let r = zec_tx_summary(
        &s,
        MAIN,
        0,
        &request(vec![coin(1_000_000, 1, false, 0)], DEST, 985_001),
    )
    .unwrap();
    assert!(r.change.is_none());
    assert_eq!(r.fee, (1_000_000u64 - 985_001).to_string());
    assert_eq!(r.zip317_fee, "10000");
    assert_eq!(r.folded, (1_000_000u64 - 985_001 - 10_000).to_string());
    assert!(r.warnings.is_empty());
    // Exactly ZEC_MIN_CHANGE left: a change output.
    let r = zec_tx_summary(
        &s,
        MAIN,
        0,
        &request(vec![coin(1_000_000, 1, false, 0)], DEST, 985_000),
    )
    .unwrap();
    assert_eq!(r.change.unwrap().amount, "5000");
}

#[test]
fn send_everything() {
    let s = seed(ABANDON);
    let mut req = request(
        vec![coin(700_000, 1, false, 0), coin(300_000, 2, true, 0)],
        DEST,
        0,
    );
    req.max = true;
    let r = zec_tx_summary(&s, MAIN, 0, &req).unwrap();
    assert_eq!(r.inputs, 2);
    assert!(r.change.is_none());
    assert_eq!(r.fee, "10000");
    assert_eq!(r.amount, "990000");
    let (hex_tx, _) = zec_sign(&s, MAIN, 0, &req).unwrap();
    assert_eq!(zec_decode_raw_tx(&hex_tx, MAIN).unwrap().outputs.len(), 1);
    // Nothing left after the fee: refused.
    let mut tiny = request(vec![coin(9_000, 1, false, 0)], DEST, 0);
    tiny.max = true;
    assert!(zec_tx_summary(&s, MAIN, 0, &tiny).is_err());
}

#[test]
fn high_fee_needs_the_reinforced_confirmation() {
    let s = seed(ABANDON);
    // Sending 1 000 zatoshis costs 10 000 of fee: more than the amount.
    let r = zec_tx_summary(
        &s,
        MAIN,
        0,
        &request(vec![coin(1_000_000, 1, false, 0)], DEST, 1_000),
    )
    .unwrap();
    assert_eq!(r.warnings, vec![ZecWarning::HighFee]);
    assert!(r.requires_extra_confirmation);
}

#[test]
fn refusals() {
    let s = seed(ABANDON);
    let ok = || request(vec![coin(1_000_000, 1, false, 0)], DEST, 100_000);
    assert!(zec_tx_summary(&s, MAIN, 0, &ok()).is_ok());

    let err = |req: ZecSendRequest| zec_tx_summary(&s, MAIN, 0, &req).unwrap_err().to_string();
    // Shielded / unified recipient.
    let mut r = ok();
    r.to = "zs1z7rejlpsa98s2rrrfkwmaxu53e4ue0ulcrw0h4x5g8jl04tak0d3mm47vdtahatqrlkngh9sly".into();
    assert!(err(r).contains("protégée"));
    // Insufficient funds, dust, no coin.
    let mut r = ok();
    r.amount = 995_000;
    assert!(err(r).contains("insuffisant"));
    let mut r = ok();
    r.amount = 53;
    assert!(err(r).contains("poussière"));
    let mut r = ok();
    r.coins.clear();
    assert!(err(r).contains("aucune pièce"));
    // A coin that pays another address of ours than claimed, another wallet, another account.
    let mut r = ok();
    r.coins[0].index = 1;
    assert!(err(r).contains("ne paie pas"));
    let mut r = ok();
    r.coins[0].prev_tx = fake_prev(&[(1_000_000, our_script(LEGAL, 0, false, 0))], 9, false);
    assert!(err(r).contains("ne paie pas"));
    assert!(zec_tx_summary(&s, MAIN, 1, &ok())
        .unwrap_err()
        .to_string()
        .contains("ne paie pas"));
    // vout out of range, malformed previous transaction, duplicate, coinbase.
    let mut r = ok();
    r.coins[0].vout = 1;
    assert!(err(r).contains("vout"));
    let mut r = ok();
    r.coins[0].prev_tx = "00".into();
    assert!(err(r).contains("mal formée"));
    let mut r = ok();
    r.coins.push(r.coins[0].clone());
    assert!(err(r).contains("deux fois"));
    let mut r = ok();
    r.coins[0].prev_tx = fake_prev(&[(1_000_000, our_script(ABANDON, 0, false, 0))], 3, true);
    assert!(err(r).contains("coinbase"));
    // Change index beyond MAX_CHANGE_INDEX.
    let mut r = ok();
    r.change_index = 1_001;
    assert!(err(r).contains("index de monnaie"));
    // Unknown network upgrade, mismatching branch.
    let mut r = ok();
    r.network_branch_id = 0x1234_5678;
    assert!(err(r).contains("mets Kyro à jour"));
    let mut r = ok();
    r.network_branch_id = 0x4dec_4df0;
    assert!(err(r).contains("mets Kyro à jour"));
    // The signing path refuses exactly the same things.
    let mut r = ok();
    r.network_branch_id = 0x1234_5678;
    assert!(zec_sign(&s, MAIN, 0, &r).is_err());
}

#[test]
fn tex_recipient_and_testnet() {
    let s = seed(ABANDON);
    let r = zec_tx_summary(
        &s,
        MAIN,
        0,
        &request(
            vec![coin(1_000_000, 1, false, 0)],
            "tex1s2rt77ggv6q989lr49rkgzmh5slsksa9khdgte",
            100_000,
        ),
    )
    .unwrap();
    assert_eq!(r.to_kind, ZecAddressKind::Tex);
    assert_eq!(
        r.to_address, DEST,
        "a TEX address pays the P2PKH of its key hash"
    );

    // Testnet: tm… keys at m/44'/1'/0', its own branch table.
    let to = zec_address(&s, TEST, 0, false, 5).unwrap();
    let c = ZecCoin {
        prev_tx: fake_prev(
            &[(
                2_000_000,
                zec_parse_address(&zec_address(&s, TEST, 0, false, 0).unwrap(), TEST)
                    .unwrap()
                    .0,
            )],
            4,
            false,
        ),
        vout: 0,
        change: false,
        index: 0,
    };
    let tip = 4_200_000;
    let req = ZecSendRequest {
        tip_height: tip,
        network_branch_height: tip,
        ..request(vec![c], &to, 1_000_000)
    };
    let (hex_tx, sum) = zec_sign(&s, TEST, 0, &req).unwrap();
    assert_eq!(sum.upgrade, "NU6.3");
    assert!(sum.change.unwrap().address.starts_with("tm"));
    assert!(
        zec_decode_raw_tx(&hex_tx, TEST).unwrap().outputs[0]
            .0
            .as_deref()
            == Some(to.as_str())
    );
    // The same request on mainnet: the coin's script is not a mainnet key of ours.
    assert!(zec_tx_summary(&s, MAIN, 0, &req).is_err());
}
