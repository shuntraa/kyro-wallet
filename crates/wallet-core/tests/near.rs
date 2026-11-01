//! NEAR Protocol vectors.
//!
//! Sources (fetched 2026-11-01):
//! - `near/near-seed-phrase` `test/index.test.js` (« parse seed phrase »): the mnemonic
//!   `Shoot island … Above` gives `ed25519:r4yuiZE45mzeZAENDEF2pWeFBJkW8mQYGx3rU46zCqh` at
//!   `m/44'/397'/0'` (the library lower-cases the phrase first);
//! - `near/near-api-js` `test/unit/transactions/serialize.test.ts` (master): « serialize transfer
//!   tx » (Borsh bytes) and « serialize multi-action tx » (8 actions, must be refused);
//! - `near/near-api-js` tag `v0.44.2`, `test/serialize.test.js`: « serialize and sign transfer
//!   tx » (key pair, ed25519 signature, signed transaction bytes).
//!
//! Account 1 and 2 of "abandon … about" were cross-checked on 2026-11-01 with an independent
//! SLIP-10 implementation (`@noble/hashes` 1.8.0 HMAC-SHA512 + `@noble/curves` 1.9.7 ed25519 +
//! `@scure/bip39` 1.6.0).

mod common;

use base64::Engine as _;
use common::{seed, ABANDON};
use ed25519_dalek::Signer as _;
use wallet_core::{
    near_account_kind, near_address, near_decode_tx, near_hash_string, near_parse_hash,
    near_parse_public_key, near_path, near_public_key, near_public_key_string, near_sign,
    near_verify_signed, NearAccountKind, NearTransfer, NearWarning,
};

const SHOOT: &str =
    "shoot island position soft burden budget tooth cruel issue economy destroy above";

const TRANSFER_HEX: &str = "09000000746573742e6e65617200917b3d268d4b58f7fec1b150bd68d69be3ee5d4cc39855e341538465bb77860d01000000000000000d00000077686174657665722e6e6561720fa473fd26901df296be6adc4cc4df34d040efa2435224b6986910e630c2fef6010000000301000000000000000000000000000000";
const SIGNED_HEX: &str = "09000000746573742e6e65617200917b3d268d4b58f7fec1b150bd68d69be3ee5d4cc39855e341538465bb77860d01000000000000000d00000077686174657665722e6e6561720fa473fd26901df296be6adc4cc4df34d040efa2435224b6986910e630c2fef601000000030100000000000000000000000000000000969a83332186ee9755e4839325525806e189a3d2d2bb4b4760e94443e97e1c4f22deeef0059a8e9713100eda6e19144da7e8a0ef7e539b20708ba1d8d021bd01";
const SIGNATURE_B64: &str =
    "lpqDMyGG7pdV5IOTJVJYBuGJo9LSu0tHYOlEQ+l+HE8i3u7wBZqOlxMQDtpuGRRNp+ig735TmyBwi6HY0CG9AQ==";
const SECRET: &str =
    "3hoMW1HvnRLSFCLZnvPzWeoGwtdHzke34B2cTHM8rhcbG3TbuLKtShTv3DvyejnXKXKBiV7YPkLeqUHN1ghnqpFv";
const MULTI_ACTION_HEX: &str = "09000000746573742e6e656172000f56a5f028dfc089ec7c39c1183b321b4d8f89ba5bec9e1762803cc2491f6ef80100000000000000030000003132330fa473fd26901df296be6adc4cc4df34d040efa2435224b6986910e630c2fef608000000000103000000010203020300000071717103000000010203e80300000000000040420f00000000000000000000000000037b0000000000000000000000000000000440420f00000000000000000000000000000f56a5f028dfc089ec7c39c1183b321b4d8f89ba5bec9e1762803cc2491f6ef805000f56a5f028dfc089ec7c39c1183b321b4d8f89ba5bec9e1762803cc2491f6ef800000000000000000000030000007a7a7a010000000300000077777706000f56a5f028dfc089ec7c39c1183b321b4d8f89ba5bec9e1762803cc2491f6ef80703000000313233";

fn transfer_vector() -> NearTransfer {
    NearTransfer {
        signer_id: "test.near".into(),
        public_key: near_parse_public_key("ed25519:Anu7LYDfpLtkP7E16LT9imXF694BdQaa9ufVkQiwTQxC")
            .unwrap(),
        nonce: 1,
        receiver_id: "whatever.near".into(),
        block_hash: near_parse_hash("244ZQ9cgj3CQ6bWBdytfrJMuMQ1jdXLFGnr4HhvtCTnM").unwrap(),
        deposit: 1,
        ft: None,
    }
}

#[test]
fn near_seed_phrase_vector() {
    // near-seed-phrase lower-cases « Shoot … Above » before deriving.
    let s = seed(SHOOT);
    assert_eq!(
        near_public_key_string(&near_public_key(&s, 0).unwrap()),
        "ed25519:r4yuiZE45mzeZAENDEF2pWeFBJkW8mQYGx3rU46zCqh"
    );
    assert_eq!(
        near_address(&s, 0).unwrap(),
        "0c91f6106ff835c0195d5388565a2d69e25038a7e23d26198f85caf6594117ec"
    );
    assert_eq!(near_path(0), "m/44'/397'/0'");
}

#[test]
fn abandon_accounts() {
    let s = seed(ABANDON);
    for (a, implicit) in [
        (
            0,
            "5510e2b44cae6eb807e3e0e45d579dda058c274abcba15e5cb84636f5d1ee412",
        ),
        (
            1,
            "3b93b03253b9715213ec314eb50ecc99d25602ccb5b059f91f51d24710d54326",
        ),
        (
            2,
            "06ff7a6fae3da4d225a93da1fac0eb9adc64a33c417dd14a99a373b4bab4047a",
        ),
    ] {
        assert_eq!(near_address(&s, a).unwrap(), implicit, "account {a}");
        assert_eq!(
            near_account_kind(implicit).unwrap(),
            NearAccountKind::Implicit
        );
    }
    assert_eq!(
        near_public_key_string(&near_public_key(&s, 1).unwrap()),
        "ed25519:51ZftJ8qPN8mJ3oqgQb3fqPbotQVZfTC4mxLgwz34FTK"
    );
    assert_eq!(near_path(2), "m/44'/397'/2'");
}

#[test]
fn near_api_js_transfer_encoding() {
    let tx = transfer_vector();
    assert_eq!(hex::encode(tx.encode()), TRANSFER_HEX);
    assert_eq!(
        NearTransfer::decode(&hex::decode(TRANSFER_HEX).unwrap()).unwrap(),
        tx
    );
}

#[test]
fn near_api_js_signed_transfer() {
    let tx = transfer_vector();
    // The key pair of the fixture: 64 bytes = ed25519 seed ‖ public key.
    let secret = bs58::decode(SECRET).into_vec().unwrap();
    let key = ed25519_dalek::SigningKey::from_bytes(&secret[..32].try_into().unwrap());
    assert_eq!(key.verifying_key().to_bytes(), tx.public_key);
    assert_eq!(&secret[32..], &tx.public_key);
    // Kyro's rule: ed25519 over SHA-256(borsh(tx)).
    let sig = key.sign(&tx.hash()).to_bytes();
    assert_eq!(
        base64::engine::general_purpose::STANDARD.encode(sig),
        SIGNATURE_B64
    );
    assert_eq!(hex::encode(tx.encode_signed(&sig)), SIGNED_HEX);
    // Strict check of the signed bytes.
    let (back, hash) = near_verify_signed(SIGNED_HEX).unwrap();
    assert_eq!(back, tx);
    assert_eq!(hash, near_hash_string(&tx.hash()));
    // One bit changed in the signature, or in the amount: refused.
    let mut forged = hex::decode(SIGNED_HEX).unwrap();
    let last = forged.len() - 1;
    forged[last] ^= 1;
    assert!(near_verify_signed(&hex::encode(&forged)).is_err());
    let mut more = hex::decode(SIGNED_HEX).unwrap();
    more[TRANSFER_HEX.len() / 2 - 16] = 2;
    assert!(near_verify_signed(&hex::encode(&more)).is_err());
}

#[test]
fn multi_action_transaction_is_refused() {
    let e = NearTransfer::decode(&hex::decode(MULTI_ACTION_HEX).unwrap())
        .unwrap_err()
        .to_string();
    assert!(e.contains("8 actions"), "{e}");
}

#[test]
fn decode_and_sign_our_transfer() {
    let s = seed(ABANDON);
    let me = near_address(&s, 0).unwrap();
    let pk = near_public_key(&s, 0).unwrap();
    let tx = NearTransfer {
        signer_id: me.clone(),
        public_key: pk,
        nonce: 187_000_000_000_001,
        receiver_id: "kyro-test.testnet".into(),
        block_hash: [3; 32],
        deposit: 1_500_000_000_000_000_000_000, // 0.0015 NEAR
        ft: None,
    };
    let raw = hex::encode(tx.encode());
    let summary = near_decode_tx(&raw, &me, &pk).unwrap();
    assert_eq!(summary.signer_id, me);
    assert_eq!(summary.receiver_id, "kyro-test.testnet");
    assert_eq!(summary.receiver_kind, NearAccountKind::Named);
    assert_eq!(summary.deposit, "1500000000000000000000");
    assert_eq!(summary.nonce, "187000000000001");
    assert_eq!(summary.hash, near_hash_string(&tx.hash()));
    assert!(!summary.requires_extra_confirmation);

    let (signed, hash, again) = near_sign(&s, 0, &raw).unwrap();
    assert_eq!(again, summary);
    assert_eq!(hash, summary.hash);
    let (back, h) = near_verify_signed(&signed).unwrap();
    assert_eq!((back, h), (tx.clone(), hash));

    // Account 1 cannot sign account 0's transaction.
    assert!(near_sign(&s, 1, &raw).is_err());
    // Not our account, not our key.
    let other = near_address(&s, 1).unwrap();
    assert!(near_decode_tx(&raw, &other, &pk).is_err());
    assert!(near_decode_tx(&raw, &me, &near_public_key(&s, 1).unwrap()).is_err());
    // Self transfer, zero amount.
    for bad in [
        NearTransfer {
            receiver_id: me.clone(),
            ..tx.clone()
        },
        NearTransfer {
            deposit: 0,
            ..tx.clone()
        },
        NearTransfer {
            nonce: 0,
            ..tx.clone()
        },
    ] {
        assert!(near_decode_tx(&hex::encode(bad.encode()), &me, &pk).is_err());
    }
    // An Ethereum-style receiver needs the reinforced confirmation.
    let eth = NearTransfer {
        receiver_id: "0x2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
        ..tx.clone()
    };
    let s2 = near_decode_tx(&hex::encode(eth.encode()), &me, &pk).unwrap();
    assert_eq!(s2.warnings, vec![NearWarning::EthImplicitReceiver]);
    assert!(s2.requires_extra_confirmation);
    // An implicit signer whose key is not the signing key: refused at broadcast.
    let wrong = NearTransfer {
        signer_id: other,
        ..tx
    };
    let key_sig = {
        let (signed, _, _) = near_sign(&s, 0, &raw).unwrap();
        let b = hex::decode(signed).unwrap();
        <[u8; 64]>::try_from(&b[b.len() - 64..]).unwrap()
    };
    assert!(near_verify_signed(&hex::encode(wrong.encode_signed(&key_sig))).is_err());
}

#[test]
fn parsing_helpers() {
    assert!(near_parse_public_key("Anu7LYDfpLtkP7E16LT9imXF694BdQaa9ufVkQiwTQxC").is_err());
    assert!(
        near_parse_public_key("secp256k1:Anu7LYDfpLtkP7E16LT9imXF694BdQaa9ufVkQiwTQxC").is_err()
    );
    assert!(near_parse_hash("244ZQ9cgj3CQ6bWBdytfrJMuMQ1jdXLFGnr4HhvtCTn").is_err());
    assert!(near_parse_hash("0OIl").is_err());
}

// ---------------------------------------------------------------- NEP-141 (USDC, USDt)

/// Borsh of a transaction with the given function calls, written independently of wallet-core.
fn raw_calls(tx: &NearTransfer, calls: &[(&str, &str, u64, u128)]) -> Vec<u8> {
    let s = |o: &mut Vec<u8>, b: &[u8]| {
        o.extend_from_slice(&(b.len() as u32).to_le_bytes());
        o.extend_from_slice(b);
    };
    let mut o = Vec::new();
    s(&mut o, tx.signer_id.as_bytes());
    o.push(0);
    o.extend_from_slice(&tx.public_key);
    o.extend_from_slice(&tx.nonce.to_le_bytes());
    s(&mut o, tx.receiver_id.as_bytes());
    o.extend_from_slice(&tx.block_hash);
    o.extend_from_slice(&(calls.len() as u32).to_le_bytes());
    for (m, args, gas, dep) in calls {
        o.push(2);
        s(&mut o, m.as_bytes());
        s(&mut o, args.as_bytes());
        o.extend_from_slice(&gas.to_le_bytes());
        o.extend_from_slice(&dep.to_le_bytes());
    }
    o
}

#[test]
fn nep141_transfers_layout_sign_and_refusals() {
    use wallet_core::{near_known_token, NearFtTransfer, NEAR_FT_GAS};
    let s = seed(ABANDON);
    let me = near_address(&s, 0).unwrap();
    let pk = near_public_key(&s, 0).unwrap();
    let usdt = "usdt.tether-token.near";
    assert_eq!(
        near_known_token(usdt).map(|(k, tn)| (k.decimals, tn)),
        Some((6, false))
    );
    assert!(near_known_token("usdt.fake.near").is_none());
    let base = NearTransfer {
        signer_id: me.clone(),
        public_key: pk,
        nonce: 5,
        receiver_id: usdt.into(),
        block_hash: [4; 32],
        deposit: 0,
        ft: Some(NearFtTransfer {
            recipient: "bob.near".into(),
            amount: 2_500_000,
            storage_deposit: Some(1_250_000_000_000_000_000_000),
        }),
    };
    let args_sd = r#"{"account_id":"bob.near","registration_only":true}"#;
    let args_ft = r#"{"receiver_id":"bob.near","amount":"2500000"}"#;
    let expected = raw_calls(
        &base,
        &[
            (
                "storage_deposit",
                args_sd,
                NEAR_FT_GAS,
                1_250_000_000_000_000_000_000,
            ),
            ("ft_transfer", args_ft, NEAR_FT_GAS, 1),
        ],
    );
    assert_eq!(base.encode(), expected);
    assert_eq!(NearTransfer::decode(&expected).unwrap(), base);
    let sm = near_decode_tx(&hex::encode(&expected), &me, &pk).unwrap();
    let t = sm.token.clone().unwrap();
    assert_eq!(sm.receiver_id, usdt);
    assert_eq!(sm.deposit, "1250000000000000000001");
    assert_eq!(
        (t.symbol.as_str(), t.decimals, t.testnet),
        ("USDT", 6, false)
    );
    assert_eq!(
        (t.recipient.as_str(), t.amount.as_str()),
        ("bob.near", "2500000")
    );
    assert_eq!(t.storage_deposit.as_deref(), Some("1250000000000000000000"));
    let (signed, hash, again) = near_sign(&s, 0, &hex::encode(&expected)).unwrap();
    assert_eq!(again, sm);
    assert_eq!(near_verify_signed(&signed).unwrap().1, hash);
    // Registered recipient: ft_transfer alone.
    let mut one = base.clone();
    one.ft.as_mut().unwrap().storage_deposit = None;
    assert_eq!(
        one.encode(),
        raw_calls(&one, &[("ft_transfer", args_ft, NEAR_FT_GAS, 1)])
    );
    let s1 = near_decode_tx(&hex::encode(one.encode()), &me, &pk).unwrap();
    assert_eq!(s1.deposit, "1");
    assert_eq!(s1.token.unwrap().storage_deposit, None);
    // Refused: unknown contract, a memo, other gas or deposit, a non-canonical JSON, storage for
    // someone else, a third action, another method, a zero amount, a transfer to ourselves.
    let refused = |raw: Vec<u8>, why: &str| {
        assert!(
            near_decode_tx(&hex::encode(raw), &me, &pk).is_err(),
            "{why}"
        );
    };
    let mut fake = one.clone();
    fake.receiver_id = "usdt.fake.near".into();
    refused(
        raw_calls(&fake, &[("ft_transfer", args_ft, NEAR_FT_GAS, 1)]),
        "unknown contract",
    );
    let memo = r#"{"receiver_id":"bob.near","amount":"2500000","memo":"x"}"#;
    refused(
        raw_calls(&one, &[("ft_transfer", memo, NEAR_FT_GAS, 1)]),
        "memo",
    );
    refused(
        raw_calls(&one, &[("ft_transfer", args_ft, NEAR_FT_GAS * 10, 1)]),
        "gas",
    );
    refused(
        raw_calls(&one, &[("ft_transfer", args_ft, NEAR_FT_GAS, 2)]),
        "deposit",
    );
    let spaced = r#"{"receiver_id": "bob.near","amount":"2500000"}"#;
    refused(
        raw_calls(&one, &[("ft_transfer", spaced, NEAR_FT_GAS, 1)]),
        "non-canonical",
    );
    let other = r#"{"account_id":"eve.near","registration_only":true}"#;
    refused(
        raw_calls(
            &one,
            &[
                ("storage_deposit", other, NEAR_FT_GAS, 1),
                ("ft_transfer", args_ft, NEAR_FT_GAS, 1),
            ],
        ),
        "storage for another account",
    );
    refused(
        raw_calls(
            &one,
            &[
                ("storage_deposit", args_sd, NEAR_FT_GAS, 1),
                ("ft_transfer", args_ft, NEAR_FT_GAS, 1),
                ("ft_transfer", args_ft, NEAR_FT_GAS, 1),
            ],
        ),
        "three actions",
    );
    refused(
        raw_calls(&one, &[("ft_transfer_call", args_ft, NEAR_FT_GAS, 1)]),
        "ft_transfer_call",
    );
    let zero = r#"{"receiver_id":"bob.near","amount":"0"}"#;
    refused(
        raw_calls(&one, &[("ft_transfer", zero, NEAR_FT_GAS, 1)]),
        "zero",
    );
    let selfa = format!(r#"{{"receiver_id":"{me}","amount":"1"}}"#);
    refused(
        raw_calls(&one, &[("ft_transfer", &selfa, NEAR_FT_GAS, 1)]),
        "self",
    );
}
