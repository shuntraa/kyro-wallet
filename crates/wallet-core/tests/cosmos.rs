//! Cosmos Hub vectors.

mod common;

use base64::Engine as _;
use bitcoin::hashes::{sha256, Hash};
use bitcoin::secp256k1::{ecdsa::Signature, Message as SecpMessage, PublicKey, Secp256k1};
use common::{seed, ABANDON};
use prost::Message as _;
use wallet_core::cosmos_proto as p;
use wallet_core::{
    cosmos_address, cosmos_address_bytes, cosmos_address_from_bytes, cosmos_decode_sign_doc,
    cosmos_normalize_address, cosmos_path, cosmos_public_key, cosmos_send_sign_doc, cosmos_sign,
    cosmos_simulation_tx, cosmos_verify_signed, CosmosSendRequest, CosmosWarning, Network,
    COSMOS_CHAIN_ID_MAINNET, COSMOS_CHAIN_ID_TESTNET, COSMOS_MSG_SEND, COSMOS_SECP256K1_PUBKEY,
};

const ALL: &str = "all all all all all all all all all all all all";
const SPECIAL: &str =
    "special sign fit simple patrol salute grocery chicken wheat radar tonight ceiling";

fn b64(s: &str) -> Vec<u8> {
    base64::engine::general_purpose::STANDARD.decode(s).unwrap()
}

#[test]
fn address_vectors() {
    assert_eq!(cosmos_path(0), "m/44'/118'/0'/0/0");
    assert_eq!(cosmos_path(7), "m/44'/118'/7'/0/0");
    let s = seed(SPECIAL);
    assert_eq!(
        hex::encode(cosmos_public_key(&s, 0).unwrap()),
        "02baa4ef93f2ce84592a49b1d729c074eab640112522a7a89f7d03ebab21ded7b6"
    );
    assert_eq!(
        cosmos_address(&s, 0).unwrap(),
        "cosmos1jhg0e7s6gn44tfc5k37kr04sznyhedtc9rzys5"
    );
    let a = seed(ABANDON);
    for (acct, pk, addr) in [
        (
            0,
            "024f4e2ad99c34d60b9ba6283c9431a8418af8673212961f97a77b6377fcd05b62",
            "cosmos19rl4cm2hmr8afy4kldpxz3fka4jguq0auqdal4",
        ),
        (
            1,
            "02b74657437c7b173c2f4e442f1c863b24857fa97283385c5ec172ff63ff18b7be",
            "cosmos1tehv5km5e9y706rc2gzk9yyun9dljjjnvyt3u0",
        ),
        (
            2,
            "0287c442dc6c27178b49c57657ef1624cf92f97c29d991a350eddb48b67a8efb14",
            "cosmos1n56pcy6078dpacyj4m6rye47auhxs4ycm8k0dw",
        ),
    ] {
        assert_eq!(hex::encode(cosmos_public_key(&a, acct).unwrap()), pk);
        assert_eq!(cosmos_address(&a, acct).unwrap(), addr);
    }
    let all = seed(ALL);
    assert_eq!(
        cosmos_address(&all, 0).unwrap(),
        "cosmos1knuunh0lmwyrkjmrj7sky49uxk3peyzhzsvqqf"
    );
    assert_eq!(
        cosmos_address(&all, 1).unwrap(),
        "cosmos1ylru7zj280hp2r9nzhdxjny8yrqe36ck9hkll0"
    );
}

#[test]
fn address_parsing() {
    let a = "cosmos19rl4cm2hmr8afy4kldpxz3fka4jguq0auqdal4";
    let bytes = cosmos_address_bytes(a).unwrap();
    assert_eq!(bytes.len(), 20);
    assert_eq!(cosmos_address_from_bytes(&bytes).unwrap(), a);
    assert_eq!(cosmos_normalize_address(&a.to_uppercase()).unwrap(), a);
    assert_eq!(cosmos_normalize_address(&format!("  {a} ")).unwrap(), a);
    // 32-byte (module / interchain account) addresses.
    let long = cosmos_address_from_bytes(&[7u8; 32]).unwrap();
    assert_eq!(cosmos_address_bytes(&long).unwrap(), vec![7u8; 32]);
    let osmo =
        bech32::encode::<bech32::Bech32>(bech32::Hrp::parse("osmo").unwrap(), &bytes).unwrap();
    let m =
        bech32::encode::<bech32::Bech32m>(bech32::Hrp::parse("cosmos").unwrap(), &bytes).unwrap();
    let short = cosmos_address_from_bytes(&[1u8; 19]).unwrap();
    let mixed = format!("COSMOS{}", &a[6..]);
    for bad in [
        "cosmos19rl4cm2hmr8afy4kldpxz3fka4jguq0auqdal5", // checksum
        osmo.as_str(),                                   // other chain
        "cosmosvaloper1sjllsnramtg3ewxqwwrwjxfgc4n4ef9u2lcnj0", // validator operator
        m.as_str(),                                      // bech32m
        short.as_str(),                                  // 19 bytes
        mixed.as_str(),                                  // mixed case
        "",
        "0x9858EfFD232B4033E47d90003D41EC34EcaEda94",
    ] {
        assert!(cosmos_address_bytes(bad).is_err(), "{bad}");
    }
}

/// Real mainnet transactions: `(hash, TxRaw base64, sender account_number)`.
const BF2C: (&str, &str, u64) = (
    "BF2C90FE305EDC7261B92715B33A2EDF6EEA7684D19F3D95C6DEB3DFDB3F97BD",
    "CpgBCpABChwvY29zbW9zLmJhbmsudjFiZXRhMS5Nc2dTZW5kEnAKLWNvc21vczF3eXR2M2Vyc3kzM3FkNno3dno3YWVyNmdlMGUwdHdydHRxMHM2ahItY29zbW9zMTdtbDRhc3N6dnI2Z2hzbTdoY2xqNnVjZXNjcXlmNDh1eG1kbGg5GhAKBXVhdG9tEgcyNjg5NTIyGJ+ehxASZQpOCkYKHy9jb3Ntb3MuY3J5cHRvLnNlY3AyNTZrMS5QdWJLZXkSIwohA5xgzIEFEkMZdkgrH2iLgdkDgI2reMItq2//SyiutpKHEgQKAggBEhMKDQoFdWF0b20SBDEwNjgQzYMNGkD/LLatwKnaCTZF4c0kUsRLYDlXt6ibCcleCV513Tu+wVeA/EhUX/9gXb7IMErvjujikOwTwhZ9IM8WAy3x40ne",
    3_728_305,
);
const F7D8: (&str, &str, u64) = (
    "F7D88EC6F9768EEC106BD3DF8B77CA969D5EA74E6BD5D4B1A9A486E8EF639F2A",
    "CrUBCpABChwvY29zbW9zLmJhbmsudjFiZXRhMS5Nc2dTZW5kEnAKLWNvc21vczFseDN2OWtoZGU0MGRsOGt3dW1odWs2ZGNnNnAyazZ3NGd0N2F0eBItY29zbW9zMWx4enVhZ3hwdTh3MHo0NjB3OGN5NG56cjVoZjZ6OHV1ZTR4Zmc5GhAKBXVhdG9tEgcxMjg2Njc1EiA1OWE2MTczODA2ZDI0ZDhkYWI5MjM1MmEyMTgwMzRjZhJpClIKRgofL2Nvc21vcy5jcnlwdG8uc2VjcDI1NmsxLlB1YktleRIjCiED3kxNqWfZtB/ODctfZM2RBdwiB2RRUAUuFKxpkMzky5ASBAoCCAEYiuwBEhMKDQoFdWF0b20SBDEwMDAQwJoMGkCeNl51XP+6vgPmRlBAX3+L1+0raKSYTLm9Lra4xCH8RhqATktZEBpb3W2QHWgUFMfcltyexvgNX/sfTmVk/y+T",
    3_367_926,
);
const A846: (&str, &str, u64) = (
    "846987F0724C135444CAACF4E3D957FDA5B152D412CB175DAB116FB923E06155",
    "CqYBCpEBChwvY29zbW9zLmJhbmsudjFiZXRhMS5Nc2dTZW5kEnEKLWNvc21vczFycm1jd245OXZ1cjdod3gyeGEydzY0NzZjcGtqdnhnZXMzbXgzbRItY29zbW9zMWhncDg0bWUwbHplOHQ0amZyd3NyMDVhZXAya3I1N3pyazRnZWN4GhEKBXVhdG9tEggxMzIyMDAwMBIQNjc3ODY4MjU0NTk2OTU4NRJnClAKRgofL2Nvc21vcy5jcnlwdG8uc2VjcDI1NmsxLlB1YktleRIjCiECOPtwlkIw19+PtEZxXnEuRaNlyydwigOAfRroa+8grYgSBAoCCAEYAhITCg0KBXVhdG9tEgQ0OTI1EK6DDBpADsNHYvrKe2yYnekTkfQ1LzGVW+vBUEhOsQXMH+1mRFdCHMq/D2JZY/2jSCNo50/sFS7U+OFHRjnvhDyvgAPGaw==",
    1_939_622,
);

#[test]
fn real_mainnet_transactions_reencode_and_verify() {
    for (hash, tx, account_number) in [BF2C, F7D8, A846] {
        let raw = b64(tx);
        assert_eq!(
            hex::encode_upper(sha256::Hash::hash(&raw).to_byte_array()),
            hash
        );
        let t = p::TxRaw::decode(raw.as_slice()).unwrap();
        assert_eq!(t.encode_to_vec(), raw, "TxRaw {hash}");
        let body = p::TxBody::decode(t.body_bytes.as_slice()).unwrap();
        assert_eq!(body.encode_to_vec(), t.body_bytes, "TxBody {hash}");
        assert_eq!(body.messages[0].type_url, COSMOS_MSG_SEND);
        let send = p::MsgSend::decode(body.messages[0].value.as_slice()).unwrap();
        assert_eq!(send.encode_to_vec(), body.messages[0].value);
        let auth = p::AuthInfo::decode(t.auth_info_bytes.as_slice()).unwrap();
        assert_eq!(auth.encode_to_vec(), t.auth_info_bytes, "AuthInfo {hash}");
        let pk_any = auth.signer_infos[0].public_key.clone().unwrap();
        assert_eq!(pk_any.type_url, COSMOS_SECP256K1_PUBKEY);
        let pk = p::PubKey::decode(pk_any.value.as_slice()).unwrap();
        assert_eq!(
            wallet_core::cosmos_address_of_pubkey(&pk.key).unwrap(),
            send.from_address
        );
        let doc = p::SignDoc {
            body_bytes: t.body_bytes.clone(),
            auth_info_bytes: t.auth_info_bytes.clone(),
            chain_id: COSMOS_CHAIN_ID_MAINNET.into(),
            account_number,
        }
        .encode_to_vec();
        let msg = SecpMessage::from_digest(sha256::Hash::hash(&doc).to_byte_array());
        let sig = Signature::from_compact(&t.signatures[0]).unwrap();
        Secp256k1::verification_only()
            .verify_ecdsa(&msg, &sig, &PublicKey::from_slice(&pk.key).unwrap())
            .unwrap_or_else(|_| panic!("signature of {hash}"));
    }
}

#[test]
fn real_mainnet_transaction_through_kyro_rules() {
    let (hash, tx, account_number) = BF2C;
    let (h, s) = cosmos_verify_signed(tx, Network::Mainnet, account_number).unwrap();
    assert_eq!(h, hash);
    assert_eq!(s.chain_id, "cosmoshub-4");
    assert_eq!(s.account_number, account_number);
    assert_eq!(s.sequence, 0);
    assert_eq!(s.from, "cosmos1wytv3ersy33qd6z7vz7aer6ge0e0twrttq0s6j");
    assert_eq!(s.to, "cosmos17ml4asszvr6ghsm7hclj6ucescqyf48uxmdlh9");
    assert_eq!(s.amount, "2689522");
    assert_eq!(s.fee, "1068");
    assert_eq!(s.gas_limit, 213_453);
    assert_eq!(s.timeout_height, 33_672_991);
    assert_eq!(s.memo, None);
    assert!(!s.requires_extra_confirmation);
    assert!(cosmos_verify_signed(tx, Network::Mainnet, account_number + 1).is_err());
    assert!(cosmos_verify_signed(tx, Network::Testnet, account_number).is_err());
    let (_, tx, n) = F7D8;
    let e = cosmos_verify_signed(tx, Network::Mainnet, n).unwrap_err();
    assert!(e.to_string().contains("timeout_height"), "{e}");
}

fn request(s: &wallet_core::Seed) -> CosmosSendRequest {
    CosmosSendRequest {
        chain_id: COSMOS_CHAIN_ID_TESTNET.into(),
        account_number: 12,
        sequence: 3,
        public_key: cosmos_public_key(s, 0).unwrap(),
        to: "cosmos1jhg0e7s6gn44tfc5k37kr04sznyhedtc9rzys5".into(),
        amount: 1_500_000,
        fee: 600,
        gas_limit: 120_000,
        memo: "dépôt 4242".into(),
        timeout_height: 1_000_100,
    }
}

#[test]
fn build_decode_sign_verify_round_trip() {
    let s = seed(ABANDON);
    let pk = cosmos_public_key(&s, 0).unwrap();
    let doc = cosmos_send_sign_doc(&request(&s)).unwrap();
    let doc_hex = hex::encode(&doc);
    let summary = cosmos_decode_sign_doc(&doc_hex, &pk, Network::Testnet).unwrap();
    assert_eq!(summary.chain_id, "provider");
    assert_eq!(
        summary.from,
        "cosmos19rl4cm2hmr8afy4kldpxz3fka4jguq0auqdal4"
    );
    assert_eq!(summary.to, "cosmos1jhg0e7s6gn44tfc5k37kr04sznyhedtc9rzys5");
    assert_eq!(summary.amount, "1500000");
    assert_eq!(summary.fee, "600");
    assert_eq!(summary.gas_limit, 120_000);
    assert_eq!(summary.sequence, 3);
    assert_eq!(summary.account_number, 12);
    assert_eq!(summary.memo.as_deref(), Some("dépôt 4242"));
    assert_eq!(
        summary.memo_hex.as_deref(),
        Some(hex::encode("dépôt 4242").as_str())
    );
    assert_eq!(summary.timeout_height, 1_000_100);
    assert!(summary.warnings.is_empty() && !summary.requires_extra_confirmation);
    assert!(cosmos_decode_sign_doc(&doc_hex, &pk, Network::Mainnet).is_err());
    let other = cosmos_public_key(&s, 1).unwrap();
    assert!(cosmos_decode_sign_doc(&doc_hex, &other, Network::Testnet).is_err());
    assert!(cosmos_sign(&s, 1, &doc_hex, Network::Testnet).is_err());

    let (tx, hash, signed_summary) = cosmos_sign(&s, 0, &doc_hex, Network::Testnet).unwrap();
    assert_eq!(signed_summary, summary);
    // RFC 6979: deterministic.
    assert_eq!(
        cosmos_sign(&s, 0, &doc_hex, Network::Testnet).unwrap().0,
        tx
    );
    let (h, again) = cosmos_verify_signed(&tx, Network::Testnet, 12).unwrap();
    assert_eq!(h, hash);
    assert_eq!(again, summary);
    assert!(cosmos_verify_signed(&tx, Network::Testnet, 13).is_err());
    let mut t = p::TxRaw::decode(b64(&tx).as_slice()).unwrap();
    let sig = Signature::from_compact(&t.signatures[0]).unwrap();
    let n =
        hex::decode("FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141").unwrap();
    let mut compact = sig.serialize_compact();
    let mut borrow = 0i16;
    for (out, &nb) in compact[32..].iter_mut().rev().zip(n.iter().rev()) {
        let v = i16::from(nb) - i16::from(*out) - borrow;
        borrow = i16::from(v < 0);
        *out = (v + 256 * borrow) as u8;
    }
    t.signatures[0] = compact.to_vec();
    let high = base64::engine::general_purpose::STANDARD.encode(t.encode_to_vec());
    let e = cosmos_verify_signed(&high, Network::Testnet, 12).unwrap_err();
    assert!(e.to_string().contains("low-S"), "{e}");
    let sim = p::TxRaw::decode(cosmos_simulation_tx(&doc).unwrap().as_slice()).unwrap();
    assert_eq!(sim.signatures, vec![Vec::<u8>::new()]);
    let d = p::SignDoc::decode(doc.as_slice()).unwrap();
    assert_eq!(sim.body_bytes, d.body_bytes);
    assert_eq!(sim.auth_info_bytes, d.auth_info_bytes);
}

fn tampered(
    s: &wallet_core::Seed,
    edit: impl FnOnce(&mut p::TxBody, &mut p::MsgSend, &mut p::AuthInfo, &mut p::SignDoc),
) -> String {
    let doc = cosmos_send_sign_doc(&request(s)).unwrap();
    let mut d = p::SignDoc::decode(doc.as_slice()).unwrap();
    let mut body = p::TxBody::decode(d.body_bytes.as_slice()).unwrap();
    let mut send = p::MsgSend::decode(body.messages[0].value.as_slice()).unwrap();
    let mut auth = p::AuthInfo::decode(d.auth_info_bytes.as_slice()).unwrap();
    edit(&mut body, &mut send, &mut auth, &mut d);
    if body.messages.len() == 1 && body.messages[0].type_url == COSMOS_MSG_SEND {
        body.messages[0].value = send.encode_to_vec();
    }
    d.body_bytes = body.encode_to_vec();
    d.auth_info_bytes = auth.encode_to_vec();
    hex::encode(d.encode_to_vec())
}

#[test]
fn refusals() {
    let s = seed(ABANDON);
    let pk = cosmos_public_key(&s, 0).unwrap();
    let refused = |doc: String, needle: &str| {
        let e = cosmos_decode_sign_doc(&doc, &pk, Network::Testnet).unwrap_err();
        assert!(e.to_string().contains(needle), "{needle}: {e}");
        assert!(cosmos_sign(&s, 0, &doc, Network::Testnet).is_err());
    };
    let coin = |denom: &str, amount: &str| p::Coin {
        denom: denom.into(),
        amount: amount.into(),
    };
    assert!(cosmos_decode_sign_doc(&tampered(&s, |_, _, _, _| {}), &pk, Network::Testnet).is_ok());
    refused(
        tampered(&s, |_, m, _, _| {
            m.amount = vec![coin(
                "ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2",
                "5",
            )]
        }),
        "denomination",
    );
    refused(
        tampered(&s, |_, m, _, _| m.amount.push(coin("uatom", "1"))),
        "a single coin",
    );
    refused(
        tampered(&s, |_, m, _, _| m.amount = vec![coin("uatom", "0")]),
        "zero",
    );
    refused(
        tampered(&s, |_, m, _, _| m.amount = vec![coin("uatom", "007")]),
        "invalid amount",
    );
    refused(
        tampered(&s, |_, m, _, _| {
            m.from_address = "cosmos1jhg0e7s6gn44tfc5k37kr04sznyhedtc9rzys5".into()
        }),
        "sender",
    );
    refused(
        tampered(&s, |_, m, _, _| m.to_address = m.from_address.clone()),
        "yourself",
    );
    refused(
        tampered(&s, |_, m, _, _| m.to_address = m.to_address.to_uppercase()),
        "non-canonical",
    );
    refused(
        tampered(&s, |b, _, _, _| {
            let again = b.messages[0].clone();
            b.messages.push(again);
        }),
        "a single message",
    );
    refused(
        tampered(&s, |b, _, _, _| {
            b.messages[0].type_url = "/cosmos.staking.v1beta1.MsgDelegate".into()
        }),
        "MsgDelegate",
    );
    refused(
        tampered(&s, |b, _, _, _| b.timeout_height = 0),
        "timeout_height",
    );
    refused(tampered(&s, |b, _, _, _| b.memo = "x".repeat(513)), "memo");
    refused(
        tampered(&s, |_, _, a, _| {
            a.fee.as_mut().unwrap().granter = "cosmos1jhg0e7s6gn44tfc5k37kr04sznyhedtc9rzys5".into()
        }),
        "granter",
    );
    refused(
        tampered(&s, |_, _, a, _| {
            a.fee.as_mut().unwrap().amount = vec![coin("uosmo", "600")]
        }),
        "denomination",
    );
    refused(
        tampered(&s, |_, _, a, _| a.fee.as_mut().unwrap().gas_limit = 0),
        "gas_limit",
    );
    refused(
        tampered(&s, |_, _, a, _| {
            a.signer_infos[0].mode_info = Some(p::ModeInfo {
                single: Some(p::ModeInfoSingle { mode: 2 }),
            });
        }),
        "SIGN_MODE_DIRECT",
    );
    refused(
        tampered(&s, |_, _, a, _| {
            let again = a.signer_infos[0].clone();
            a.signer_infos.push(again);
        }),
        "a single signer",
    );
    refused(
        tampered(&s, |_, _, _, d| d.chain_id = "cosmoshub-4".into()),
        "chain-id",
    );

    let raw = hex::decode(tampered(&s, |_, _, _, _| {})).unwrap();
    let d = p::SignDoc::decode(raw.as_slice()).unwrap();
    let with_body = |extra: &[u8]| {
        let mut b = d.body_bytes.clone();
        b.extend_from_slice(extra);
        hex::encode(
            p::SignDoc {
                body_bytes: b,
                ..d.clone()
            }
            .encode_to_vec(),
        )
    };
    refused(with_body(&[0x20, 0x01]), "TxBody");
    refused(with_body(&[0x2a, 0x00]), "TxBody");
    refused(with_body(&[0xfa, 0x3f, 0x00]), "TxBody");
    // AuthInfo.tip (field 3).
    let mut a = d.auth_info_bytes.clone();
    a.extend_from_slice(&[0x1a, 0x00]);
    refused(
        hex::encode(
            p::SignDoc {
                auth_info_bytes: a,
                ..d.clone()
            }
            .encode_to_vec(),
        ),
        "AuthInfo",
    );
    refused(
        tampered(&s, |_, _, a, _| {
            a.signer_infos[0].mode_info = Some(p::ModeInfo { single: None });
        }),
        "SIGN_MODE_DIRECT",
    );
    let mut g = raw.clone();
    g.extend_from_slice(&[0x28, 0x01]);
    refused(hex::encode(g), "SignDoc");
}

#[test]
fn warnings_and_builder_limits() {
    let s = seed(ABANDON);
    let pk = cosmos_public_key(&s, 0).unwrap();
    let mut r = request(&s);
    r.fee = 100_001;
    r.memo = "line\nbreak \u{202e}evil".into();
    let doc = hex::encode(cosmos_send_sign_doc(&r).unwrap());
    let summary = cosmos_decode_sign_doc(&doc, &pk, Network::Testnet).unwrap();
    assert_eq!(
        summary.warnings,
        vec![CosmosWarning::HighFee, CosmosWarning::UnusualText]
    );
    assert!(summary.requires_extra_confirmation);
    assert_eq!(summary.memo.as_deref(), Some("line break evil"));
    assert_eq!(
        summary.memo_hex.as_deref(),
        Some(hex::encode(r.memo.as_bytes()).as_str())
    );
    let mut r = request(&s);
    r.memo = "é".repeat(513);
    assert!(cosmos_send_sign_doc(&r).is_err());
    r.memo = "é".repeat(512);
    assert!(cosmos_send_sign_doc(&r).is_ok());
    let mut r = request(&s);
    r.to = bech32::encode::<bech32::Bech32>(
        bech32::Hrp::parse("osmo").unwrap(),
        &cosmos_address_bytes(&r.to).unwrap(),
    )
    .unwrap();
    assert!(cosmos_send_sign_doc(&r).is_err());
    let mut r = request(&s);
    r.to = cosmos_address(&s, 0).unwrap();
    assert!(cosmos_send_sign_doc(&r).is_err());
    let mut r = request(&s);
    r.timeout_height = 0;
    assert!(cosmos_send_sign_doc(&r).is_err());
}

/// Hardware wallet (Ledger Cosmos app, amino JSON): the same transaction in
/// LEGACY_AMINO_JSON mode, the canonical StdSignDoc (sorted keys, integers as strings, like
/// CosmJS `serializeSignDoc` and the SDK's `aminojson` handler), a DER signature as the app
/// returns it, and the TxRaw that `cosmos_verify_signed` accepts.
#[test]
fn hardware_wallet_amino_json() {
    use bitcoin::bip32::{DerivationPath, Xpriv};
    use std::str::FromStr;
    let s = seed(ABANDON);
    let pk = cosmos_public_key(&s, 0).unwrap();
    let mut req = request(&s);
    req.memo = "depot 4242".into();
    let direct = hex::encode(cosmos_send_sign_doc(&req).unwrap());
    let amino = wallet_core::cosmos_amino_sign_doc(&direct, &pk, Network::Testnet).unwrap();
    assert_ne!(amino, direct);
    assert_eq!(
        cosmos_decode_sign_doc(&amino, &pk, Network::Testnet).unwrap(),
        cosmos_decode_sign_doc(&direct, &pk, Network::Testnet).unwrap()
    );
    assert!(cosmos_sign(&s, 0, &amino, Network::Testnet).is_err());
    assert!(wallet_core::cosmos_amino_json(&direct, &pk, Network::Testnet).is_err());
    let json = wallet_core::cosmos_amino_json(&amino, &pk, Network::Testnet).unwrap();
    assert_eq!(
        String::from_utf8(json.clone()).unwrap(),
        concat!(
            r#"{"account_number":"12","chain_id":"provider","fee":{"amount":[{"amount":"600","denom":"uatom"}],"gas":"120000"},"#,
            r#""memo":"depot 4242","msgs":[{"type":"cosmos-sdk/MsgSend","value":{"amount":[{"amount":"1500000","denom":"uatom"}],"#,
            r#""from_address":"cosmos19rl4cm2hmr8afy4kldpxz3fka4jguq0auqdal4","to_address":"cosmos1jhg0e7s6gn44tfc5k37kr04sznyhedtc9rzys5"}}],"#,
            r#""sequence":"3","timeout_height":"1000100"}"#
        )
    );
    let secp = Secp256k1::new();
    let master = Xpriv::new_master(bitcoin::NetworkKind::Main, &s[..]).unwrap();
    let key = master
        .derive_priv(
            &secp,
            &DerivationPath::from_str("m/44'/118'/0'/0/0").unwrap(),
        )
        .unwrap();
    let digest = sha256::Hash::hash(&json).to_byte_array();
    let sig = secp.sign_ecdsa(&SecpMessage::from_digest(digest), &key.private_key);
    let der = sig.serialize_der().to_vec();
    let (tx, hash, summary) =
        wallet_core::cosmos_amino_signed(&amino, &pk, Network::Testnet, &der).unwrap();
    let (h2, s2) = cosmos_verify_signed(&tx, Network::Testnet, 12).unwrap();
    assert_eq!((h2, s2), (hash, summary));
    assert!(cosmos_verify_signed(&tx, Network::Testnet, 13).is_err());
    let mut bad = der.clone();
    let n = bad.len();
    bad[n - 1] ^= 1;
    assert!(wallet_core::cosmos_amino_signed(&amino, &pk, Network::Testnet, &bad).is_err());
    req.memo = "a\"b".into();
    let direct = hex::encode(cosmos_send_sign_doc(&req).unwrap());
    assert!(wallet_core::cosmos_amino_sign_doc(&direct, &pk, Network::Testnet).is_err());
    let _ = (
        PublicKey::from_slice(&pk).unwrap(),
        Signature::from_der(&der).unwrap(),
    );
}
