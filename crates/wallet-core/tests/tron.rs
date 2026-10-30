//! TRON vectors.
//!
//! Sources (fetched 2026-10-30):
//! - Trezor firmware `common/tests/fixtures/tron/get_address.json` and `sign_tx.json`
//!   (mnemonic `all ×12`): addresses at `m/44'/195'/0'/0/i`; structured transactions with their
//!   `raw_data_hex`, txID and signature (Trezor signs with RFC 6979, like libsecp256k1);
//! - Trust Wallet Core `tests/chains/Tron/` (signatures over a known txid, in `src/tron.rs`);
//! - two real Nile transactions read from `nile.trongrid.io` (`getblockbynum`), signed by
//!   other wallets: a TRX transfer (v = 0x01) and a TRC-20 transfer (v = 0x1b).

mod common;

use bitcoin::hashes::{sha256, Hash};
use common::seed;
use wallet_core::{
    tron_address, tron_address_bytes, tron_address_from_bytes, tron_decode_raw,
    tron_recover_signer, tron_ref_block, tron_sign, tron_signed_transaction,
    tron_trc20_transfer_data, Error, TronAction, TronContract, TronRaw, TronWarning,
};

const ALL: &str = "all all all all all all all all all all all all";
const TREZOR_OWNER: &str = "TY72iA3SBtrds3QLYsS7LwYfkzXwAXCRWT";

fn h(s: &str) -> Vec<u8> {
    hex::decode(s).unwrap()
}

fn a21(s: &str) -> [u8; 21] {
    h(s).try_into().unwrap()
}

#[test]
fn trezor_address_vectors() {
    let s = seed(ALL);
    assert_eq!(
        tron_address(&s, 0).unwrap(),
        "TY72iA3SBtrds3QLYsS7LwYfkzXwAXCRWT"
    );
    assert_eq!(
        tron_address(&s, 1).unwrap(),
        "TFz2CJn9CJb8C4i1Gke3jmZX2fRMJxniH2"
    );
    assert_eq!(
        tron_address(&s, 2).unwrap(),
        "TQSw9qVAigRwfgPdf7aW4wxbG9tFitexg2"
    );
    assert_eq!(
        hex::encode(tron_address_bytes(TREZOR_OWNER).unwrap()),
        "41f2cd810c48c401d392ead3c6e1e1cb9f57750a58"
    );
    // Trust Wallet `TronAddress.Invalid`.
    for bad in [
        "abc",
        "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
        "175tWpb8K1S7NmH4Zx6rewF9WQrcZv245W",
        "2MegQ6oqSda2tTagdEzBA",
        "TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeD",
    ] {
        assert!(tron_address_bytes(bad).is_err(), "{bad}");
    }
}

struct Vector {
    name: &'static str,
    raw: TronRaw,
    raw_hex: &'static str,
    txid: Option<&'static str>,
    signature: &'static str,
}

fn trezor_vectors() -> Vec<Vector> {
    let owner = a21("41f2cd810c48c401d392ead3c6e1e1cb9f57750a58");
    let to = a21("4141f82674a30ae1328745d08afe2d1a0a24195283");
    let usdt = a21("4142a1e39aefa49290f2b3f9ed688d7cecf86cd6e0");
    let rb = |b: &str, hs: &str| -> ([u8; 2], [u8; 8]) {
        (h(b).try_into().unwrap(), h(hs).try_into().unwrap())
    };
    let raw = |r: ([u8; 2], [u8; 8]), exp, ts, fee, memo: &str, contract| TronRaw {
        ref_block_bytes: r.0,
        ref_block_hash: r.1,
        expiration: exp,
        memo: h(memo),
        contract,
        timestamp: ts,
        fee_limit: fee,
    };
    vec![
        Vector {
            name: "TransferContract",
            raw: raw(rb("e942", "6394747da9fee421"), 1752562632000, 1752562572000, 0, "",
                TronContract::Transfer { owner, to, amount: 18123456 }),
            raw_hex: "0a02e94222086394747da9fee42140c08afee680335a68080112640a2d747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e5472616e73666572436f6e747261637412330a1541f2cd810c48c401d392ead3c6e1e1cb9f57750a5812154141f82674a30ae1328745d08afe2d1a0a2419528318c095d20870e0b5fae68033",
            txid: Some("91813c4e057a4c881d9dc4981f041c33cffb17c41e860a53eb68e7995f5de821"),
            signature: "a7f8602b02413e9dded0170daa5b4ada9a2679198af276be456f4faea1bc326f5070789bec5e6471de3f726f4fe0c9daced8df183e4a62804db26d5650c59a521c",
        },
        Vector {
            name: "TransferContract_amount_int64_max",
            raw: raw(rb("0fc4", "9643b084bc8b5cde"), 1752568944000, 1752571244333, 0, "",
                TronContract::Transfer { owner, to, amount: i64::MAX }),
            raw_hex: "0a020fc422089643b084bc8b5cde4080abffe980335a6d080112690a2d747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e5472616e73666572436f6e747261637412380a1541f2cd810c48c401d392ead3c6e1e1cb9f57750a5812154141f82674a30ae1328745d08afe2d1a0a2419528318ffffffffffffffff7f70adde8beb8033",
            txid: None,
            signature: "36db819a6c50b8c770ff1067a2753692fa8c8bfa7efde8ddfc2f891f7053d9955f6ffd0ee7d6217b448ac3515d97f6877159b721f2a78da78d1fcc10c1019dd51b",
        },
        Vector {
            name: "Note_hello_world",
            raw: raw(rb("ea2a", "d43320ee5a8b677f"), 1752563334000, 1752563274000, 0, "68656c6c6f20776f726c6421",
                TronContract::Transfer { owner, to, amount: 18123456 }),
            raw_hex: "0a02ea2a2208d43320ee5a8b677f40f0f6a8e78033520c68656c6c6f20776f726c64215a68080112640a2d747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e5472616e73666572436f6e747261637412330a1541f2cd810c48c401d392ead3c6e1e1cb9f57750a5812154141f82674a30ae1328745d08afe2d1a0a2419528318c095d2087090a2a5e78033",
            txid: Some("2b166e72fe1cfb71345d5061d15e10ac2cc5ee3bb85b5ad34a14c9bf112b8372"),
            signature: "7b43c3e8977db4f5475656eec2e643bf1549d923f29c28c009c85b51556a78602aa0f3f2780cb19655dfa8d4eb2102a3c6b3440ce5b7448a814c860cdc925dd21c",
        },
        Vector {
            name: "TriggerSmartContract_USDT_transfer",
            raw: raw(rb("dae0", "9ab5c70b3a11405f"), 1766454906000, 1766453046721, 50000000, "",
                TronContract::Trigger { owner, contract: usdt, call_value: 0,
                    data: h("a9059cbb000000000000000000000000d093f24888ab06073a4bdffbb8107db1ea9dc0a000000000000000000000000000000000000000000000000000000000013bb450") }),
            raw_hex: "0a02dae022089ab5c70b3a11405f409099abc7b4335aae01081f12a9010a31747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e54726967676572536d617274436f6e747261637412740a1541f2cd810c48c401d392ead3c6e1e1cb9f57750a5812154142a1e39aefa49290f2b3f9ed688d7cecf86cd6e02244a9059cbb000000000000000000000000d093f24888ab06073a4bdffbb8107db1ea9dc0a000000000000000000000000000000000000000000000000000000000013bb45070c1dbb9c6b433900180e1eb17",
            txid: Some("3b76769f2fae94ffad214967c013b714110f26c740b4bf2d5702069d125353de"),
            signature: "f99e2f704c78b07d49fcfa4cc7cd032635807f9a1f09b57adc2232cac38d0d42428008bd9953944e0276123ee6851a266078df9c68e5c4db158be05377dadd7b1c",
        },
        Vector {
            name: "TriggerSmartContract_USDT_transfer_with_value",
            raw: raw(rb("910e", "a65791b6ace7540b"), 1787647044000, 1787645784622, 100000000, "",
                TronContract::Trigger { owner, contract: usdt, call_value: 1234567,
                    data: h("a9059cbb000000000000000000000000f59b1e8c74ed1a925eef999c9f6f2dac11c11a9f00000000000000000000000000000000000000000000000000000000000f4240") }),
            raw_hex: "0a02910e2208a65791b6ace7540b40a0d3c4c083345ab201081f12ad010a31747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e54726967676572536d617274436f6e747261637412780a1541f2cd810c48c401d392ead3c6e1e1cb9f57750a5812154142a1e39aefa49290f2b3f9ed688d7cecf86cd6e01887ad4b2244a9059cbb000000000000000000000000f59b1e8c74ed1a925eef999c9f6f2dac11c11a9f00000000000000000000000000000000000000000000000000000000000f424070aee4f7bf8334900180c2d72f",
            txid: Some("309d2d033dd6e504909ce12989720ee9fba00998faecb1770c91d7bec14ecb7e"),
            signature: "d805b9a608c361bb8a86e3b2037b9f5674281c0443c42e54293fc51d0bfc2a564bd60788f68f99512a4de3f514f8ef6d2c3548056253ae4992d8c95b1e3824ca1c",
        },
        Vector {
            name: "TriggerSmartContract_USDT_approve_with_value",
            raw: raw(rb("9111", "049152ee761b2c26"), 1787647053000, 1787645794097, 100000000, "",
                TronContract::Trigger { owner, contract: usdt, call_value: 9876543,
                    data: h("095ea7b3000000000000000000000000f59b1e8c74ed1a925eef999c9f6f2dac11c11a9f00000000000000000000000000000000000000000000000000000000000007d0") }),
            raw_hex: "0a0291112208049152ee761b2c2640c899c5c083345ab301081f12ae010a31747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e54726967676572536d617274436f6e747261637412790a1541f2cd810c48c401d392ead3c6e1e1cb9f57750a5812154142a1e39aefa49290f2b3f9ed688d7cecf86cd6e018bfe8da042244095ea7b3000000000000000000000000f59b1e8c74ed1a925eef999c9f6f2dac11c11a9f00000000000000000000000000000000000000000000000000000000000007d070b1aef8bf8334900180c2d72f",
            txid: Some("32a5a28ad7825f86017f404c7d2ecbaf4be97e6da30349bf5c0adb9f6255a72c"),
            signature: "aaf3b599481c6aa0200dd3b5c33d23af8efd28fe4f3a621dfb5f372ac0499b574f65a864fa85ed309d5c2eacd66ba71d87a3fc8061b3132d73e147bce6f6de0d1b",
        },
    ]
}

/// Encoder and decoder byte for byte against Trezor's fixtures; Kyro's signature (libsecp256k1,
/// RFC 6979) identical to Trezor's; the signature recovers to the owner.
#[test]
fn trezor_sign_tx_vectors_byte_for_byte() {
    let s = seed(ALL);
    for v in trezor_vectors() {
        assert_eq!(hex::encode(v.raw.encode()), v.raw_hex, "{} encode", v.name);
        assert_eq!(
            TronRaw::decode(&h(v.raw_hex)).unwrap(),
            v.raw,
            "{} decode",
            v.name
        );
        let txid = hex::encode(sha256::Hash::hash(&h(v.raw_hex)).to_byte_array());
        if let Some(t) = v.txid {
            assert_eq!(txid, t, "{} txid", v.name);
        }
        let (sig, summary) = tron_sign(&s, 0, v.raw_hex).unwrap();
        assert_eq!(hex::encode(sig), v.signature, "{} signature", v.name);
        assert_eq!(summary.txid, txid);
        assert_eq!(summary.owner, TREZOR_OWNER);
        assert_eq!(tron_recover_signer(v.raw_hex, &sig).unwrap(), TREZOR_OWNER);
    }
}

#[test]
fn summaries_of_the_trezor_vectors() {
    let v = trezor_vectors();
    let sum = |i: usize| tron_decode_raw(v[i].raw_hex, TREZOR_OWNER).unwrap();

    let t = sum(0);
    assert_eq!(
        t.action,
        TronAction::TrxTransfer {
            to: tron_address_from_bytes(&a21("4141f82674a30ae1328745d08afe2d1a0a24195283")),
            amount: "18123456".into()
        }
    );
    assert_eq!((t.expiration, t.timestamp), (1752562632000, 1752562572000));
    assert_eq!(
        (t.ref_block_bytes.as_str(), t.ref_block_hash.as_str()),
        ("e942", "6394747da9fee421")
    );
    assert_eq!(t.fee_limit, "0");
    assert!(t.warnings.is_empty() && !t.requires_extra_confirmation);

    // Memo: shown, reinforced.
    let m = sum(2);
    assert_eq!(m.memo, "68656c6c6f20776f726c6421");
    assert_eq!(m.warnings, vec![TronWarning::Memo]);
    assert!(m.requires_extra_confirmation);

    // TRC-20 transfer (Trezor's fixture calls it "USDT"; the contract is TG3XXyEx…, not
    // mainnet USDT): contract, recipient, raw amount (0x13bb450 = 20 690 000).
    let u = sum(3);
    assert_eq!(
        u.action,
        TronAction::Trc20Transfer {
            contract: "TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs".into(),
            to: tron_address_from_bytes(&a21("41d093f24888ab06073a4bdffbb8107db1ea9dc0a0")),
            amount: "20690000".into(),
            call_value: "0".into(),
        }
    );
    assert_eq!(u.fee_limit, "50000000");
    assert!(!u.requires_extra_confirmation);
    // Kyro's own call data for the same transfer is identical.
    let TronAction::Trc20Transfer { to, .. } = &u.action else {
        panic!()
    };
    assert_eq!(
        hex::encode(tron_trc20_transfer_data(to, "20690000").unwrap()),
        "a9059cbb000000000000000000000000d093f24888ab06073a4bdffbb8107db1ea9dc0a000000000000000000000000000000000000000000000000000000000013bb450"
    );

    // TRX sent along a transfer: reinforced.
    assert_eq!(sum(4).warnings, vec![TronWarning::CallValue]);
    // approve(): not a transfer → shown raw as an unknown call, reinforced.
    let a = sum(5);
    assert!(
        matches!(&a.action, TronAction::ContractCall { selector, .. } if selector == "095ea7b3")
    );
    assert!(a.warnings.contains(&TronWarning::UnknownCall {
        selector: "095ea7b3".into()
    }));
    assert!(a.requires_extra_confirmation);
}

#[test]
fn refusals() {
    let v = trezor_vectors();
    let transfer = v[0].raw_hex;
    let refused = |hex_raw: &str, owner: &str| {
        assert!(
            matches!(tron_decode_raw(hex_raw, owner), Err(Error::InvalidInput(_))),
            "{hex_raw}"
        )
    };
    // Another owner (Trezor "different owner" case: our key is m/44'/195'/0'/0/1).
    refused(transfer, "TFz2CJn9CJb8C4i1Gke3jmZX2fRMJxniH2");
    assert!(tron_sign(&seed(ALL), 1, transfer).is_err());
    // Trezor's Stake_for_Energy (FreezeBalanceV2, type 54): unsupported contract type.
    refused("0a027e0b2208ed0f599cb230d51240f884eee8c3335a5a083612560a34747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e467265657a6542616c616e63655632436f6e7472616374121e0a1541f2cd810c48c401d392ead3c6e1e1cb9f57750a581080e1eb1718017098b0eae8c333", TREZOR_OWNER);
    // Appended field (duplicate timestamp): non-canonical.
    refused(&format!("{transfer}70e0b5fae68033"), TREZOR_OWNER);
    // Permission_id = 2 appended inside the contract (multi-signature permission).
    let contract = &transfer[transfer.find("5a68").unwrap() + 4..transfer.find("70e0b5").unwrap()];
    let with_perm = transfer.replace(&format!("5a68{contract}"), &format!("5a6a{contract}2802"));
    assert_ne!(with_perm, transfer);
    refused(&with_perm, TREZOR_OWNER);
    let mut raw = v[0].raw.clone();
    // Non-minimal varint for the amount (c095d208 → c095d28800): refused by the round trip.
    let non_minimal = transfer
        .replace("5a680801126", "5a690801126")
        .replace("12330a15", "12340a15")
        .replace("18c095d208", "18c095d28800");
    refused(&non_minimal, TREZOR_OWNER);
    // Self-transfer, zero amount, negative amount.
    if let TronContract::Transfer { owner, .. } = raw.contract {
        raw.contract = TronContract::Transfer {
            owner,
            to: owner,
            amount: 1,
        };
        refused(&hex::encode(raw.encode()), TREZOR_OWNER);
        raw.contract = TronContract::Transfer {
            owner,
            to: a21("4141f82674a30ae1328745d08afe2d1a0a24195283"),
            amount: 0,
        };
        refused(&hex::encode(raw.encode()), TREZOR_OWNER);
        raw.contract = TronContract::Transfer {
            owner,
            to: a21("4141f82674a30ae1328745d08afe2d1a0a24195283"),
            amount: -5,
        };
        refused(&hex::encode(raw.encode()), TREZOR_OWNER);
    }
    // Garbage.
    refused("zz", TREZOR_OWNER);
    refused("0a", TREZOR_OWNER);
}

/// Real Nile transactions signed by other wallets: decode → re-encode identical, txid, and the
/// signature recovers to the owner (v = 0x01 and v = 0x1b both accepted).
#[test]
fn real_nile_transactions() {
    for (raw, txid, sig, owner_hex) in [
        (
            "0a02cb0b2208c00f95777164dee34095a8ffe198345a67080112630a2d747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e5472616e73666572436f6e747261637412320a1541f7c3feccb6461aab0fd25f61d9560645b08228cb121541b06b4139895c9f51c967c9f3d9089ca721e8e34c18e0b00f7090fcf9a3afc0d1f118",
            "86fca528764df550755a48844f97a1aa95111344814a4a07edea32f1e828d858",
            "bf4a88dae7e7f6f4eb4409ffc78a8f02db8043f8cb3ac8a67f3b33e96d7e619235064b16848111319e871b5c9c9f731b763a008b8c18a36e0e91930befb3eac701",
            "41f7c3feccb6461aab0fd25f61d9560645b08228cb",
        ),
        (
            "0a02cb0822083463b4a2470fe044409089f0e198345aae01081f12a9010a31747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e54726967676572536d617274436f6e747261637412740a15412c86055d6d04b07f109553036f0d660a9edc8774121541eca9bc828a3005b9a3b909f2cc5c2a54794de05f2244a9059cbb00000000000000000000000057f6d1c859cf6a7948a84c2408bfe397fb8e9d79000000000000000000000000000000000000000000000000000000000164b55870e2b7ece19834900180c2d72f",
            "37fbb96df0243c17e3fa988bb82c0d00b8497b9348a36e3fc3b1189ef014166d",
            "6036f1067f6cc38d91fa8e6ab924ac4ca9fe962b32e03268e5984a10236d370b211438495378743e1162c7ad9f382ed97e5d0a1a9613c8b3c60cfc5eb784d1021b",
            "412c86055d6d04b07f109553036f0d660a9edc8774",
        ),
    ] {
        let decoded = TronRaw::decode(&h(raw)).unwrap();
        assert_eq!(hex::encode(decoded.encode()), raw);
        assert_eq!(hex::encode(decoded.txid()), txid);
        let owner = tron_address_from_bytes(&a21(owner_hex));
        assert_eq!(tron_recover_signer(raw, &h(sig)).unwrap(), owner);
        let s = tron_decode_raw(raw, &owner).unwrap();
        assert_eq!(s.txid, txid);
        // The Transaction message for broadcasthex: raw_data (1) then signature (2).
        let signed = tron_signed_transaction(raw, &h(sig).try_into().unwrap()).unwrap();
        assert!(signed.ends_with(sig));
    }
}

#[test]
fn reference_block_from_a_nile_block() {
    // nile.trongrid.io getnowblock, 2026-10-30: number 72 272 568.
    let (b, hash) = tron_ref_block(
        72_272_568,
        "00000000044ecab8883caa0677c5a7f36c8cb18c62016efac0da52a696a7b736",
    )
    .unwrap();
    assert_eq!(hex::encode(b), "cab8");
    assert_eq!(hex::encode(hash), "883caa0677c5a7f3");
    // A block id that does not start with the block number: refused.
    assert!(tron_ref_block(
        72_272_569,
        "00000000044ecab8883caa0677c5a7f36c8cb18c62016efac0da52a696a7b736"
    )
    .is_err());
}
