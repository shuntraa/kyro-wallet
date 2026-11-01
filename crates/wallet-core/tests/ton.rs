//! TON vectors.
//!
//! Sources (fetched 2026-11-01):
//! - Trust Wallet Core `tests/chains/TheOpenNetwork/TWAnyAddressTests.cpp` (mnemonic → address at
//!   `m/44'/607'/0'`, `registry.json` path), `rust/tw_tests/tests/chains/ton/ton_address.rs`
//!   (17 private keys → v4R2 addresses, valid / invalid user-friendly forms, flags) and
//!   `ton_wallet.rs` (v4R2 `StateInit` of a public key);
//! - ton-org/ton `src/wallets/v4/WalletContractV4.ts` (official v4R2 code, hash
//!   `feb5ff68…dabd5c0` as published by TON).
//!
//! Signed transfers (Trust Wallet's mainnet transactions) are tested in `src/ton.rs`: they are
//! given as raw private keys, and Kyro only derives keys from a seed.

mod common;

use base64::Engine as _;
use common::{seed, ABANDON};
use wallet_core::{
    ton_address, ton_decode_tx, ton_parse_address, ton_parse_raw_address, ton_path, ton_public_key,
    ton_sign, ton_unsigned_transfer, ton_verify_signed, ton_wallet_address, ton_wallet_id,
    TonAddress, TonTransfer, TonWarning, TON_MODE_ALL_BALANCE, TON_MODE_PAY_FEES,
    TON_WALLET_ID_MAINNET, TON_WALLET_ID_TESTNET,
};

const STUFF: &str =
    "stuff diamond cycle federal scan spread pigeon people engage teach snack grain";

fn pubkey_of(secret_hex: &str) -> [u8; 32] {
    let sk: [u8; 32] = hex::decode(secret_hex).unwrap().try_into().unwrap();
    ed25519_dalek::SigningKey::from_bytes(&sk)
        .verifying_key()
        .to_bytes()
}

#[test]
fn trust_wallet_mnemonic_address() {
    let s = seed(STUFF);
    assert_eq!(ton_path(0), "m/44'/607'/0'");
    assert_eq!(
        ton_address(&s, 0, false).unwrap(),
        "UQDYW_1eScJVxtitoBRksvoV9cCYo4uKGWLVNIHB1JqRRyQx"
    );
    // The bounceable form of the same wallet is the destination of Trust Wallet's
    // `SignMessageToTransferAndDeployWalletV4R2` test.
    let pk = ton_public_key(&s, 0).unwrap();
    assert_eq!(
        ton_wallet_address(&pk, TON_WALLET_ID_MAINNET)
            .unwrap()
            .to_friendly(true, false),
        "EQDYW_1eScJVxtitoBRksvoV9cCYo4uKGWLVNIHB1JqRR3n0"
    );
}

#[test]
fn trust_wallet_private_key_addresses() {
    let vectors = [
        (
            "5849481021e305dfdf9f0eaf87e07f15efec3fde8d8ed639c9fcf0bc351d998b",
            "UQAACKJfEIfI5vkht_w3NYk8k-OU5Xl_jq9XNmmkcPaUO-tB",
        ),
        (
            "4a22d994755145e4a4ce7263bdb3a8a70e449c1fccdd299f80df862bd4dcb930",
            "UQA3fRa_AHKBo1Lu8QF5xm_fiCLi197NfoPbeta0VJyvKa76",
        ),
        (
            "287d4c0fcc445173fe211e4ade3518c75cff7a9dd79070f54395058cdd53e485",
            "UQCbJ0QdlDmC0ofyCtH15PHBzrj9sMLoLjNjkgTYaxR8gn9z",
        ),
        (
            "136e464280c4222a99ac34d5077a2edf11e4468a076741e495d9f31ca7939a1f",
            "UQAliC8yJh-Ru2uwEWgEaEV9LHEs0-c1blYr_XZe7CpEwm9D",
        ),
        (
            "f15bb09a2cf37f6e6b6515be4000cdf271338c56fb1ec81848f2f1407b3a4003",
            "UQCeAQaIFwwjmcJkYfqGiyHo2ag7qUMMfsUi28HLWmtpA7zF",
        ),
        (
            "532005268411b3b4ac85b080c8a3bc4a52600be75f758013302745ac05ac18f0",
            "UQDD0YS5pQSe3fgHEKd-D7qTieRxmSknlQQW6fb7IFu7ky9T",
        ),
        (
            "15e5a13ec259bb4515105ba0a84ee93eaa9f56f6fdf73bf6179d1ed80b6a399c",
            "UQAx8JmUT4p14RUAu9gpXqmTzkQz4e3GZz8VQjqWXFDxG6-S",
        ),
        (
            "9b503ff85debe95093acf0f9b057607a0a5be91cb47e2e6ec342d7825c7fafbc",
            "UQD91HEk-TJVublA57dgkSwgrRORj48ubEIfjEPZIjQ08oZl",
        ),
        (
            "97075969876382280ff7598738b3fd2c1748f9a549dd6f5d6aa5694c21deddce",
            "UQBrL2lNG3ThmYbf9gaA_-tsPfdrcGy27LP0M-qg-1TpG_wR",
        ),
        (
            "57d86027989f8ec649cce3be862d68564d471395c5694918b0348e17c7ef6ffe",
            "UQDUJLg8MYZPT2C-2n-ulyNSkBsdDaUzqEq71dBx3l6fhnuL",
        ),
        (
            "b1ad2bff14fc018493c32c37cded62892ec507471e34a25da0b5b5f05e131751",
            "UQD079e5CETiOrR_iS0atJukl7ixS6EYbtaWRSGykFAtwRhL",
        ),
        (
            "16ad201c59ecd7ace74e1677160106923a3d2ee11c495be5c3b88ba6f7ef3d17",
            "UQDuU7NOk_eGzP5CLs_Zeg0LBpySAGy02qqGv0cO_zX5WN1n",
        ),
        (
            "3d935b7a8c24e7dc55ef7c0c890806cee3af1174a62165d4d2fb64ccf2e2260b",
            "UQALRogl66QrJIb3KbStOd-ZadA6Ye2g23ME6JAMU1HOXRG2",
        ),
        (
            "68f3a87d12514854774300b8a4c449616e208336f1b609c96fcd8b1a87d4e064",
            "UQALrF1c2UeoCybOsSeAdUmip4yhcCtrUAhKZ-9bxv6_okVx",
        ),
        (
            "fbfbc640c4cd4649161a935562217f1caecf6e7f3a2818921f9ee336741a48cb",
            "UQAzCS7JoSiOi1BdH4nFkuvUwbBjxUzPx1AhQKwiwXAv27Xs",
        ),
    ];
    for (sk, addr) in vectors {
        let a = ton_wallet_address(&pubkey_of(sk), TON_WALLET_ID_MAINNET).unwrap();
        assert_eq!(a.to_friendly(false, false), addr);
        let p = ton_parse_address(addr).unwrap();
        assert_eq!((p.address, p.bounceable, p.testnet), (a, false, false));
    }
}

#[test]
fn trust_wallet_v4r2_state_init() {
    // ton_wallet.rs `test_ton_wallet_v4_r2_create_state_init`: the address is the hash of this
    // StateInit, so comparing addresses compares the cell.
    let pk: [u8; 32] =
        hex::decode("f229a9371fa7c2108b3d90ea22c9be705ff5d0cfeaee9cbb9366ff0171579357")
            .unwrap()
            .try_into()
            .unwrap();
    let boc = base64::engine::general_purpose::STANDARD
        .decode("te6cckECFgEAAwQAAgE0AQIBFP8A9KQT9LzyyAsDAFEAAAAAKamjF/IpqTcfp8IQiz2Q6iLJvnBf9dDP6u6cu5Nm/wFxV5NXQAIBIAQFAgFIBgcE+PKDCNcYINMf0x/THwL4I7vyZO1E0NMf0x/T//QE0VFDuvKhUVG68qIF+QFUEGT5EPKj+AAkpMjLH1JAyx9SMMv/UhD0AMntVPgPAdMHIcAAn2xRkyDXSpbTB9QC+wDoMOAhwAHjACHAAuMAAcADkTDjDQOkyMsfEssfy/8ICQoLAubQAdDTAyFxsJJfBOAi10nBIJJfBOAC0x8hghBwbHVnvSKCEGRzdHK9sJJfBeAD+kAwIPpEAcjKB8v/ydDtRNCBAUDXIfQEMFyBAQj0Cm+hMbOSXwfgBdM/yCWCEHBsdWe6kjgw4w0DghBkc3RyupJfBuMNDA0CASAODwBu0gf6ANTUIvkABcjKBxXL/8nQd3SAGMjLBcsCIs8WUAX6AhTLaxLMzMlz+wDIQBSBAQj0UfKnAgBwgQEI1xj6ANM/yFQgR4EBCPRR8qeCEG5vdGVwdIAYyMsFywJQBs8WUAT6AhTLahLLH8s/yXP7AAIAbIEBCNcY+gDTPzBSJIEBCPRZ8qeCEGRzdHJwdIAYyMsFywJQBc8WUAP6AhPLassfEss/yXP7AAAK9ADJ7VQAeAH6APQEMPgnbyIwUAqhIb7y4FCCEHBsdWeDHrFwgBhQBMsFJs8WWPoCGfQAy2kXyx9SYMs/IMmAQPsABgCKUASBAQj0WTDtRNCBAUDXIMgBzxb0AMntVAFysI4jghBkc3Rygx6xcIAYUAXLBVADzxYj+gITy2rLH8s/yYBA+wCSXwPiAgEgEBEAWb0kK29qJoQICga5D6AhhHDUCAhHpJN9KZEM5pA+n/mDeBKAG3gQFImHFZ8xhAIBWBITABG4yX7UTQ1wsfgAPbKd+1E0IEBQNch9AQwAsjKB8v/ydABgQEI9ApvoTGACASAUFQAZrc52omhAIGuQ64X/wAAZrx32omhAEGuQ64WPwEXtMkg=")
        .unwrap();
    let hash = tycho_types::boc::Boc::decode(boc).unwrap().repr_hash().0;
    assert_eq!(ton_wallet_address(&pk, 0x29a9_a317).unwrap().hash, hash);
}

#[test]
fn friendly_address_forms() {
    let raw =
        ton_parse_raw_address("0:8a8627861a5dd96c9db3ce0807b122da5ed473934ce7568a5b4b1c361cbb28ae")
            .unwrap();
    let forms = [
        (
            "EQCKhieGGl3ZbJ2zzggHsSLaXtRzk0znVopbSxw2HLsorkdl",
            true,
            false,
        ),
        (
            "UQCKhieGGl3ZbJ2zzggHsSLaXtRzk0znVopbSxw2HLsorhqg",
            false,
            false,
        ),
        (
            "kQCKhieGGl3ZbJ2zzggHsSLaXtRzk0znVopbSxw2HLsorvzv",
            true,
            true,
        ),
        (
            "0QCKhieGGl3ZbJ2zzggHsSLaXtRzk0znVopbSxw2HLsorqEq",
            false,
            true,
        ),
    ];
    for (s, bounceable, testnet) in forms {
        let p = ton_parse_address(s).unwrap();
        assert_eq!(
            (p.address, p.bounceable, p.testnet),
            (raw, bounceable, testnet),
            "{s}"
        );
        assert_eq!(raw.to_friendly(bounceable, testnet), s);
    }
    assert_eq!(
        raw.to_raw(),
        "0:8a8627861a5dd96c9db3ce0807b122da5ed473934ce7568a5b4b1c361cbb28ae"
    );
    // Valid forms from Trust Wallet's list: url-safe, standard base64, masterchain.
    for s in [
        "EQBGqFmKe3oY8PChYN9g92ZEV2ybkzVB-hCiesQRn5mFnrNv",
        "EQAN6Dr3vziti1Kp9D3aEFqJX4bBVfCaV57Z+9jwKTBXICv8",
        "EQCmGW+z+UL00FmnhWaMvJq/i86YY5GlJP3uJW19KC5Tzq4C",
    ] {
        assert_eq!(ton_parse_address(s).unwrap().address.workchain, 0, "{s}");
    }
    for s in [
        "Ef8JfFPRpHBV_tZpCurvxMJW69nt2js3SuGEWojGnOpCVPRe",
        "Ef_drj6m7jcME0fWTA-OwFC-6F0Le2SuOUQ6ibRc3Vz8HL8H",
    ] {
        assert_eq!(ton_parse_address(s).unwrap().address.workchain, -1, "{s}");
    }
    // Invalid: size, workchain, tag, checksum, raw forms (no checksum), mixed alphabets.
    for s in [
        "random string",
        "EQIcIZpPoMnWXd8FbC1KaLtcyIgVUlwsbFK_3P6f5uf_YyzoE",
        "EQIcIZpPoMnWXd8FbC1KaLtcyIgVUlwsbFK_3P6f5uf_YyE",
        "EQIcIZpPoMnWXd8FbC1KaLtcyIgVUlwsbFK_3P6f5uf_Yyw=",
        "EQEMzVEZ8n9_5GFEdsNPfl6Tx64Jjld88gEvi4BDFly4CSyl",
        "Ef7g6Yz890MpIpitnjeaPC5kAXl7nL_A_pi04U_Qzgfs3-Cj",
        "MwCKhieGGl3ZbJ2zzggHsSLaXtRzk0znVopbSxw2HLsorsn8",
        "swCKhieGGl3ZbJ2zzggHsSLaXtRzk0znVopbSxw2HLsornJ2",
        "EQCKhieGGl3ZbJ2zzggHsSLaXtRzk0znVopbSxw2HLsormVH",
        "EQCKhieGGl3ZbJ2zzggHsSLaXtRzk0znVopbSxw2HLsorpcF",
        "0:8a8627861a5dd96c9db3ce0807b122da5ed473934ce7568a5b4b1c361cbb28ae",
        "-1:8a8627861a5dd96c9db3ce0807b122da5ed473934ce7568a5b4b1c361cbb28ae",
        "EQCmGW+z+UL00FmnhWaMvJq/i86YY5GlJP3uJW19KC5Tzq4-",
    ] {
        assert!(ton_parse_address(s).is_err(), "{s}");
    }
    assert!(ton_parse_raw_address(
        "1:0ccd5119f27f7fe4614476c34f7e5e93c7ae098e577cf2012f8b8043165cb809"
    )
    .is_err());
    assert!(ton_parse_raw_address(
        "-2:e0e98cfcf743292298ad9e379a3c2e6401797b9cbfc0fe98b4e14fd0ce07ecdf"
    )
    .is_err());
}

#[test]
fn testnet_wallet_id_gives_another_address() {
    let s = seed(ABANDON);
    assert_eq!(ton_wallet_id(false), 698_983_191);
    assert_eq!(ton_wallet_id(true), TON_WALLET_ID_TESTNET);
    let main = ton_parse_address(&ton_address(&s, 0, false).unwrap()).unwrap();
    let test = ton_parse_address(&ton_address(&s, 0, true).unwrap()).unwrap();
    assert!(!main.testnet && test.testnet && !main.bounceable && !test.bounceable);
    assert_ne!(main.address, test.address);
    assert_ne!(
        ton_address(&s, 0, false).unwrap(),
        ton_address(&s, 1, false).unwrap()
    );
}

fn transfer(seed_words: &str, testnet: bool) -> TonTransfer {
    let s = seed(seed_words);
    TonTransfer {
        public_key: ton_public_key(&s, 0).unwrap(),
        wallet_id: ton_wallet_id(testnet),
        valid_until: 1_800_000_000,
        seqno: 4,
        mode: TON_MODE_PAY_FEES,
        destination: ton_parse_address("EQBm--PFwDv1yCeS-QTJ-L8oiUpqo9IT1BwgVptlSq3ts90Q")
            .unwrap()
            .address,
        bounce: true,
        amount: 1_500_000_000,
        comment: Some("123456".into()),
        with_state_init: false,
        jetton: None,
        inline_empty_body: false,
    }
}

#[test]
fn decode_sign_verify_round_trip() {
    let s = seed(ABANDON);
    for testnet in [false, true] {
        for (seqno, init, comment, mode, amount) in [
            (
                4,
                false,
                Some("123456"),
                TON_MODE_PAY_FEES,
                1_500_000_000u64,
            ),
            (0, true, None, TON_MODE_PAY_FEES, 1),
            (9, false, None, TON_MODE_ALL_BALANCE, 0),
        ] {
            let mut t = transfer(ABANDON, testnet);
            t.seqno = seqno;
            t.with_state_init = init;
            t.comment = comment.map(str::to_owned);
            t.mode = mode;
            t.amount = amount;
            let boc = ton_unsigned_transfer(&t).unwrap();
            let sum = ton_decode_tx(&boc, &t.public_key, testnet).unwrap();
            assert_eq!(sum.wallet, ton_address(&s, 0, testnet).unwrap());
            assert_eq!(
                sum.destination_raw,
                "0:66fbe3c5c03bf5c82792f904c9f8bf28894a6aa3d213d41c20569b654aadedb3"
            );
            assert_eq!(sum.amount, amount.to_string());
            assert_eq!(sum.comment.as_deref(), comment);
            assert_eq!(
                (sum.seqno, sum.deploys_wallet, sum.send_all),
                (seqno, init, mode == TON_MODE_ALL_BALANCE)
            );
            assert!(
                sum.bounce
                    && sum
                        .destination
                        .starts_with(if testnet { "kQ" } else { "EQ" })
            );
            assert!(sum
                .destination_other
                .starts_with(if testnet { "0Q" } else { "UQ" }));
            assert!(!sum.requires_extra_confirmation);
            let signed = ton_sign(&s, 0, &boc, testnet).unwrap();
            assert_eq!(signed.summary, sum);
            let (back, hash, norm) =
                ton_verify_signed(&signed.boc, &t.public_key, testnet).unwrap();
            assert_eq!(
                (back, hash, norm),
                (
                    t.clone(),
                    signed.hash.clone(),
                    signed.normalized_hash.clone()
                )
            );
            if !init {
                // Without StateInit, the normalized message is the message itself.
                assert_eq!(signed.hash, signed.normalized_hash);
            } else {
                assert_ne!(signed.hash, signed.normalized_hash);
            }
            // The signed BOC is not accepted where an unsigned one is expected, and the other
            // network's wallet id (and so the other network) is refused.
            assert!(ton_decode_tx(&signed.boc, &t.public_key, testnet).is_err());
            assert!(ton_sign(&s, 0, &signed.boc, testnet).is_err());
            assert!(ton_decode_tx(&boc, &t.public_key, !testnet).is_err());
            assert!(ton_verify_signed(&signed.boc, &t.public_key, !testnet).is_err());
            // Another account's key: not our wallet.
            assert!(ton_sign(&s, 1, &boc, testnet).is_err());
        }
    }
}

#[test]
fn tampered_or_unusual_bocs_are_refused() {
    let t = transfer(ABANDON, false);
    let boc = ton_unsigned_transfer(&t).unwrap();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&boc)
        .unwrap();
    // Any changed byte: bad CRC or another message — never silently accepted as is.
    for i in 0..bytes.len() {
        let mut b = bytes.clone();
        b[i] ^= 0x01;
        let alt = base64::engine::general_purpose::STANDARD.encode(&b);
        if let Ok(s) = ton_decode_tx(&alt, &t.public_key, false) {
            panic!("byte {i} flipped and still accepted: {s:?}");
        }
    }
    assert!(ton_decode_tx("", &t.public_key, false).is_err());
    assert!(ton_decode_tx("not base64!", &t.public_key, false).is_err());
    assert!(ton_decode_tx(&"A".repeat(5000), &t.public_key, false).is_err());
    // A signed signature slot (non-zero) is refused as "already signed" by decode.
    let s = seed(ABANDON);
    let signed = ton_sign(&s, 0, &boc, false).unwrap();
    assert!(ton_decode_tx(&signed.boc, &t.public_key, false).is_err());
    // A broken signature does not verify.
    let mut sb = base64::engine::general_purpose::STANDARD
        .decode(&signed.boc)
        .unwrap();
    let n = sb.len();
    sb[n / 2] ^= 0x80;
    assert!(ton_verify_signed(
        &base64::engine::general_purpose::STANDARD.encode(&sb),
        &t.public_key,
        false
    )
    .is_err());
}

#[test]
fn transfer_rules() {
    let pk = transfer(ABANDON, false).public_key;
    let bad = |f: &dyn Fn(&mut TonTransfer)| {
        let mut t = transfer(ABANDON, false);
        f(&mut t);
        ton_unsigned_transfer(&t)
    };
    assert!(bad(&|t| t.amount = 0).is_err(), "mode 3 without amount");
    assert!(bad(&|t| t.mode = 1).is_err(), "unknown mode");
    assert!(
        bad(&|t| t.mode = 128).is_err(),
        "mode 128 without ignore-errors"
    );
    assert!(bad(&|t| t.mode = 160).is_err(), "destroy flag");
    assert!(
        bad(&|t| t.with_state_init = true).is_err(),
        "StateInit with seqno ≠ 0"
    );
    assert!(bad(&|t| t.comment = Some(String::new())).is_err());
    assert!(bad(&|t| t.comment = Some("x".repeat(124))).is_err());
    assert!(
        bad(&|t| t.comment = Some("é".repeat(62))).is_err(),
        "124 bytes"
    );
    assert!(bad(&|t| t.comment = Some("x".repeat(123))).is_ok());
    assert!(bad(&|t| t.amount = 6_000_000_000_000_000_000).is_err());
    assert!(
        bad(&|t| t.destination = TonAddress {
            workchain: -1,
            hash: [7; 32]
        })
        .is_err(),
        "masterchain"
    );
    // Unusual text: shown cleaned, reinforced confirmation.
    let mut t = transfer(ABANDON, false);
    t.comment = Some("pay\u{202E}evil\nline".into());
    let sum = ton_decode_tx(&ton_unsigned_transfer(&t).unwrap(), &pk, false).unwrap();
    assert_eq!(sum.comment.as_deref(), Some("payevil line"));
    assert_eq!(sum.warnings, vec![TonWarning::UnusualText]);
    assert!(sum.requires_extra_confirmation);
    // Non-bounceable destination.
    t.bounce = false;
    let sum = ton_decode_tx(&ton_unsigned_transfer(&t).unwrap(), &pk, false).unwrap();
    assert!(
        !sum.bounce && sum.destination.starts_with("UQ") && sum.destination_other.starts_with("EQ")
    );
}

#[test]
fn estimate_parts() {
    let mut t = transfer(ABANDON, false);
    let p = t.estimate_parts().unwrap();
    assert!(!p.body.is_empty() && p.init_code.is_empty() && p.init_data.is_empty());
    t.seqno = 0;
    t.with_state_init = true;
    let p = t.estimate_parts().unwrap();
    assert!(p.init_code.starts_with("te6cck") && p.init_data.starts_with("te6cck"));
}

#[test]
fn usdt_jetton_transfer_round_trip() {
    use wallet_core::{
        ton_jetton_wallet_address, ton_known_jettons, TonJettonBody, TON_JETTON_ATTACHED_NANOTON,
    };
    let s = seed(ABANDON);
    let usdt = ton_known_jettons(false)[0];
    assert_eq!(usdt.symbol, "USDT");
    let mut t = transfer(ABANDON, false);
    let me = t.wallet_address().unwrap();
    let recipient = t.destination;
    t.destination = ton_jetton_wallet_address(&usdt.master, &me, false).unwrap();
    t.amount = TON_JETTON_ATTACHED_NANOTON;
    t.comment = None;
    t.jetton = Some(TonJettonBody {
        query_id: 1_800_000_000,
        amount: 12_340_000,
        destination: recipient,
        response_destination: me,
        forward_ton_amount: 1,
        comment: Some("dépôt 42".into()),
    });
    let boc = ton_unsigned_transfer(&t).unwrap();
    let sum = ton_decode_tx(&boc, &t.public_key, false).unwrap();
    let j = sum.jetton.clone().unwrap();
    assert_eq!(j.master, "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs");
    assert_eq!(
        (j.symbol.as_str(), j.decimals, j.amount.as_str()),
        ("USDT", 6, "12340000")
    );
    assert_eq!(j.recipient_raw, recipient.to_raw());
    assert_eq!(sum.comment.as_deref(), Some("dépôt 42"));
    assert_eq!(sum.amount, TON_JETTON_ATTACHED_NANOTON.to_string());
    let signed = ton_sign(&s, 0, &boc, false).unwrap();
    assert_eq!(signed.summary, sum);
    let (back, _, _) = ton_verify_signed(&signed.boc, &t.public_key, false).unwrap();
    assert_eq!(back.jetton, t.jetton);

    // A jetton body to a contract that is not our wallet of a known jetton: refused.
    let mut fake = t.clone();
    fake.destination = recipient;
    let boc = ton_unsigned_transfer(&fake).unwrap();
    assert!(ton_decode_tx(&boc, &t.public_key, false).is_err());
    // Not on testnet (no known jetton there).
    let mut tn = t.clone();
    tn.wallet_id = ton_wallet_id(true);
    assert!(ton_unsigned_transfer(&tn)
        .and_then(|b| ton_decode_tx(&b, &t.public_key, true))
        .is_err());
    // Excess TON must come back to us.
    let mut other = t.clone();
    if let Some(j) = other.jetton.as_mut() {
        j.response_destination = recipient;
    }
    assert!(ton_unsigned_transfer(&other).is_err());
}
