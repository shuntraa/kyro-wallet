//! XRP Ledger vectors.

mod common;

use common::seed;
use wallet_core::{
    xrp_account_id, xrp_address, xrp_address_at, xrp_address_from_id, xrp_decode_tx,
    xrp_issued_amount, xrp_public_key, xrp_public_key_at, xrp_sign_at, xrp_verify_signed, Error,
    Mnemonic, XrpAmount, XrpAmountView, XrpMemo, XrpPayment, XrpWarning, TF_FULLY_CANONICAL_SIG,
};

const ALL: &str = "all all all all all all all all all all all all";

fn id(hex_id: &str) -> [u8; 20] {
    hex::decode(hex_id).unwrap().try_into().unwrap()
}

#[test]
fn trezor_address_vectors() {
    let s = seed(ALL);
    assert_eq!(
        xrp_address(&s, 0).unwrap(),
        "rNaqKtKrMSwpwZSzRckPf7S96DkimjkF4H"
    );
    assert_eq!(
        xrp_address_at(&s, 0, 1).unwrap(),
        "rBKz5MC2iXdoS3XgnNSYmF69K1Yo4NS3Ws"
    );
    let custom = Mnemonic::parse(
        "armed bundle pudding lazy strategy impulse where identify submit weekend physical antenna flight social acoustic absurd whip snack decide blur unfold fiction pumpkin athlete",
    )
    .unwrap()
    .to_seed("");
    assert_eq!(
        xrp_address(&custom, 0).unwrap(),
        "r4ocGE47gm4G4LkA9mriVHQqzpMLBTgnTY"
    );
    assert_eq!(
        xrp_address_at(&custom, 0, 1).unwrap(),
        "rUt9ULSrUvfCmke8HTFU1szbmFpWzVbBXW"
    );
    let a = "rNaqKtKrMSwpwZSzRckPf7S96DkimjkF4H";
    assert_eq!(xrp_address_from_id(&xrp_account_id(a).unwrap()), a);
    for bad in [
        "rNaqKtKrMSwpwZSzRckPf7S96DkimjkF4J",
        "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
        "XVLhHMPHU98es4dbozjVtdWzVrDjtV18pX8yuPT7y4xaEHi",
        "",
    ] {
        assert!(xrp_account_id(bad).is_err(), "{bad}");
    }
    assert_eq!(
        xrp_address_from_id(&id("0000000000000000000000000000000000000001")),
        "rrrrrrrrrrrrrrrrrrrrBZbvji"
    );
}

fn trezor_payment(
    index: u32,
    dest: &str,
    amount: u64,
    fee: u64,
    sequence: u32,
    tag: Option<u32>,
    lls: Option<u32>,
) -> XrpPayment {
    let s = seed(ALL);
    let pk = xrp_public_key_at(&s, 0, index).unwrap().to_vec();
    XrpPayment {
        flags: Some(TF_FULLY_CANONICAL_SIG),
        source_tag: None,
        sequence,
        destination_tag: tag,
        last_ledger_sequence: lls,
        invoice_id: None,
        amount: XrpAmount::Xrp(amount),
        fee,
        send_max: None,
        signing_pub_key: Some(pk),
        txn_signature: None,
        account: xrp_account_id(&xrp_address_at(&s, 0, index).unwrap()).unwrap(),
        destination: xrp_account_id(dest).unwrap(),
        memos: vec![],
    }
}

/// Trezor `test_ripple_sign_simple_tx`: Kyro's signed blobs are identical byte for byte.
#[test]
fn trezor_signed_payments_byte_for_byte() {
    let s = seed(ALL);
    // The first two Trezor vectors carry no LastLedgerSequence: Kyro now refuses to sign them
    // (a payment without it stays valid for ever).
    for (index, p) in [
        (
            0,
            trezor_payment(
                0,
                "rBKz5MC2iXdoS3XgnNSYmF69K1Yo4NS3Ws",
                100_000_000,
                100_000,
                25,
                None,
                None,
            ),
        ),
        (
            2,
            trezor_payment(
                2,
                "rNaqKtKrMSwpwZSzRckPf7S96DkimjkF4H",
                1,
                10,
                1,
                None,
                None,
            ),
        ),
    ] {
        let unsigned = hex::encode(p.encode(false));
        assert!(xrp_decode_tx(
            &unsigned,
            &xrp_address_at(&s, 0, index).unwrap(),
            &xrp_public_key_at(&s, 0, index).unwrap()
        )
        .is_err());
        assert!(xrp_sign_at(&s, 0, index, &unsigned).is_err());
    }
    // The third vector (with LastLedgerSequence): byte for byte.
    {
        let (index, p, expected) = (2, trezor_payment(2, "rNaqKtKrMSwpwZSzRckPf7S96DkimjkF4H", 100_000_009, 100, 100, Some(123_456), Some(333_111)),
         "120000228000000024000000642e0001e240201b00051537614000000005f5e109684000000000000064732103dbed1e77cb91a005e2ec71afbccce5444c9be58276665a3859040f692de8fed2744730450221008770743a472bb2d1c746a53ef131cc17cc118d538ec910ca928d221db4494cf702201e4ef242d6c3bff110c3cc3897a471fed0f5ac10987ea57da63f98dfa01e94df8114bdf86f3ae715ba346b7772ea0e133f48828b766483148fb40e1ffa5d557ce9851a535af94965e0dd0988");
        let unsigned = hex::encode(p.encode(false));
        let summary = xrp_decode_tx(
            &unsigned,
            &xrp_address_at(&s, 0, index).unwrap(),
            &xrp_public_key_at(&s, 0, index).unwrap(),
        )
        .unwrap();
        let (signed, hash, again) = xrp_sign_at(&s, 0, index, &unsigned).unwrap();
        assert_eq!(signed.to_lowercase(), expected);
        assert_eq!(again, summary);
        assert_eq!(xrp_verify_signed(&signed).unwrap(), hash);
        assert_eq!(
            XrpPayment::decode(&hex::decode(expected).unwrap())
                .unwrap()
                .encode(true),
            hex::decode(expected).unwrap()
        );
    }
    let p = trezor_payment(
        2,
        "rNaqKtKrMSwpwZSzRckPf7S96DkimjkF4H",
        100_000_009,
        100,
        100,
        Some(123_456),
        Some(333_111),
    );
    let sum = xrp_decode_tx(
        &hex::encode(p.encode(false)),
        &xrp_address_at(&s, 0, 2).unwrap(),
        &xrp_public_key_at(&s, 0, 2).unwrap(),
    )
    .unwrap();
    assert_eq!(sum.destination_tag, Some(123_456));
    assert_eq!(sum.last_ledger_sequence, Some(333_111));
    assert_eq!(
        sum.amount,
        XrpAmountView::Xrp {
            drops: "100000009".into()
        }
    );
    assert_eq!(sum.fee, "100");
    assert!(sum.warnings.is_empty() && !sum.requires_extra_confirmation);
}

/// xrpl.js `values_tests` (type Amount): issued-currency and XRP encodings.
#[test]
fn xrpl_js_amount_vectors() {
    let issuer = "rrrrrrrrrrrrrrrrrrrrBZbvji";
    let enc = |a: XrpAmount| {
        let p = XrpPayment {
            flags: Some(0),
            source_tag: None,
            sequence: 0,
            destination_tag: None,
            last_ledger_sequence: None,
            invoice_id: None,
            amount: a,
            fee: 1,
            send_max: None,
            signing_pub_key: None,
            txn_signature: None,
            account: [1; 20],
            destination: [2; 20],
            memos: vec![],
        };
        let b = p.encode(false);
        let len = if b[14] & 0x80 != 0 { 48 } else { 8 };
        hex::encode_upper(&b[14..14 + len])
    };
    assert_eq!(enc(XrpAmount::Xrp(0)), "4000000000000000");
    assert_eq!(enc(XrpAmount::Xrp(1)), "4000000000000001");
    let iou = concat!(
        "0000000000000000000000005553440000000000",
        "0000000000000000000000000000000000000001"
    );
    for (value, head) in [
        ("-1", "94838D7EA4C68000"),
        ("1", "D4838D7EA4C68000"),
        ("0", "8000000000000000"),
        ("-1.0", "94838D7EA4C68000"),
        ("1.0", "D4838D7EA4C68000"),
        ("0.0", "8000000000000000"),
        (
            "0.000000000000000000000000000000000000000000000000000000000000000000000000001",
            "C1C38D7EA4C68000",
        ),
        (
            "100000000000000000000000000000000000000000000000000000000000000000000000000000",
            "E7C38D7EA4C68000",
        ),
        ("1.111111111111111", "D483F28CB71571C7"),
        ("11.11111111111111", "D4C3F28CB71571C7"),
        ("111.1111111111111", "D503F28CB71571C7"),
        ("1111.111111111111", "D543F28CB71571C7"),
        ("11111.11111111111", "D583F28CB71571C7"),
        ("111111.1111111111", "D5C3F28CB71571C7"),
        ("1111111.111111111", "D603F28CB71571C7"),
        ("11111111.11111111", "D643F28CB71571C7"),
        ("111111111.1111111", "D683F28CB71571C7"),
        ("1111111111.111111", "D6C3F28CB71571C7"),
        ("11111111111.11111", "D703F28CB71571C7"),
        ("111111111111.1111", "D743F28CB71571C7"),
        ("1111111111111.111", "D783F28CB71571C7"),
        ("11111111111111.11", "D7C3F28CB71571C7"),
        ("111111111111111.1", "D803F28CB71571C7"),
        ("1111111111111111.0", "D843F28CB71571C7"),
        ("11111000.00000001", "D643F28A20CF5801"),
    ] {
        let a = xrp_issued_amount(value, "USD", issuer).unwrap();
        assert_eq!(enc(a), format!("{head}{}", iou.to_uppercase()), "{value}");
    }
    assert!(xrp_issued_amount("1111111111111111.1", "USD", issuer).is_err());
    assert!(xrp_issued_amount("9999999999999999000000000000000000000000000000000000000000000000000000000000000000000000000000000", "USD", issuer).is_err());
    assert!(xrp_issued_amount("1", "XRP", issuer).is_err());
}

#[test]
fn xrpl_js_whole_payments_round_trip() {
    for blob in [
        "120000228000000024000054C761D54416B0AE3B00000000000000000000000000005244440000000000387B5123A1C93417271BA6DBBBD087E68E7445B268400000000000000A69D54417BCE6C800000000000000000000000000005244440000000000387B5123A1C93417271BA6DBBBD087E68E7445B28114F7B414E9D25EE050553D8A0BB27202F4249AD3288314B83EB506BBE5BCF3E89C638FDB185B1DEAC96584",
        "120000220000000024000000026140000000017D784068400000000000000A81145CCB151F6E9D603F394AE778ACF10D3BECE874F68314E851BBBE79E328E43D68F43445368133DF5FBA5A",
        "12000022000000002400000090201B005EE9BA614000000000030D4068400000000000000F8114AA1BD19D9E87BE8069FDBF6843653C43837C03C6831467FE6EC28E0464DD24FB2D62A492AAC697CFAD02",
        "120000220000000024000000012EF72D50CA6140000000017D784068400000000000000C8114E851BBBE79E328E43D68F43445368133DF5FBA5A831476DAC5E814CD4AA74142C3AB45E69A900E637AA2",
        "12000023000A34F8240000888A61400000000007A120684000000000000014811408F41F116A1F60D60296B16907F0A041BF10619783146E2F0455C46CF5DF61A1E58419A89D45459045EA",
    ] {
        let raw = hex::decode(blob).unwrap();
        let p = XrpPayment::decode(&raw).unwrap_or_else(|e| panic!("{blob}: {e}"));
        assert_eq!(hex::encode_upper(p.encode(true)), blob);
    }
    let dt = XrpPayment::decode(&hex::decode("120000220000000024000000012EF72D50CA6140000000017D784068400000000000000C8114E851BBBE79E328E43D68F43445368133DF5FBA5A831476DAC5E814CD4AA74142C3AB45E69A900E637AA2").unwrap()).unwrap();
    assert_eq!(dt.destination_tag, Some(4_146_942_154));
    let rdd = XrpPayment::decode(&hex::decode("120000228000000024000054C761D54416B0AE3B00000000000000000000000000005244440000000000387B5123A1C93417271BA6DBBBD087E68E7445B268400000000000000A69D54417BCE6C800000000000000000000000000005244440000000000387B5123A1C93417271BA6DBBBD087E68E7445B28114F7B414E9D25EE050553D8A0BB27202F4249AD3288314B83EB506BBE5BCF3E89C638FDB185B1DEAC96584").unwrap()).unwrap();
    assert_eq!(
        rdd.amount.view(),
        XrpAmountView::Issued {
            value: "1150.848".into(),
            currency: "RDD".into(),
            issuer: "ra9eZxMbJrUcgV8ui7aPc161FgrqWScQxV".into()
        }
    );
    assert_eq!(
        rdd.send_max.as_ref().unwrap().view(),
        XrpAmountView::Issued {
            value: "1152".into(),
            currency: "RDD".into(),
            issuer: "ra9eZxMbJrUcgV8ui7aPc161FgrqWScQxV".into()
        }
    );
}

#[test]
fn memos_encode_like_xrpl_js() {
    // OfferCreate fixture memo: MemoType "XMM value", MemoData "2.20965".
    let p = XrpPayment {
        memos: vec![XrpMemo {
            memo_type: Some(hex::decode("584D4D2076616C7565").unwrap()),
            memo_data: Some(hex::decode("322E3230393635").unwrap()),
            memo_format: None,
        }],
        ..trezor_payment(
            0,
            "rBKz5MC2iXdoS3XgnNSYmF69K1Yo4NS3Ws",
            1,
            12,
            1,
            None,
            Some(1_000),
        )
    };
    let enc = hex::encode_upper(p.encode(true));
    assert!(
        enc.ends_with("F9EA7C09584D4D2076616C75657D07322E3230393635E1F1"),
        "{enc}"
    );
    assert_eq!(XrpPayment::decode(&p.encode(true)).unwrap(), p);
    let s = seed(ALL);
    let sum = xrp_decode_tx(
        &hex::encode(p.encode(false)),
        &xrp_address(&s, 0).unwrap(),
        &xrp_public_key(&s, 0).unwrap(),
    )
    .unwrap();
    assert_eq!(sum.memos[0].text.as_deref(), Some("2.20965"));
    assert_eq!(sum.warnings, vec![XrpWarning::Memo]);
    assert!(sum.requires_extra_confirmation);
}

#[test]
fn memo_text_is_sanitized() {
    let p = XrpPayment {
        memos: vec![XrpMemo {
            memo_type: None,
            memo_data: Some("ok\u{202E}evil\n\nfin\u{200B}".as_bytes().to_vec()),
            memo_format: None,
        }],
        ..trezor_payment(
            0,
            "rBKz5MC2iXdoS3XgnNSYmF69K1Yo4NS3Ws",
            1,
            12,
            1,
            None,
            Some(1_000),
        )
    };
    let s = seed(ALL);
    let sum = xrp_decode_tx(
        &hex::encode(p.encode(false)),
        &xrp_address(&s, 0).unwrap(),
        &xrp_public_key(&s, 0).unwrap(),
    )
    .unwrap();
    assert_eq!(sum.memos[0].text.as_deref(), Some("okevil  fin"));
    assert_eq!(
        sum.warnings,
        vec![XrpWarning::Memo, XrpWarning::UnusualText]
    );
    assert!(sum.requires_extra_confirmation);
}

/// A real signed mainnet Payment (codec-fixtures): decodes and re-encodes identically; its
/// signature verifies but is high-S (pre-2014 malleable form) — refused by Kyro's check.
#[test]
fn signed_mainnet_payment_high_s_is_refused() {
    let blob = "1200002200000000240000003E6140000002540BE40068400000000000000A7321034AADB09CFF4A4804073701EC53C3510CDC95917C2BB0150FB742D0C66E6CEE9E74473045022022EB32AECEF7C644C891C19F87966DF9C62B1F34BABA6BE774325E4BB8E2DD62022100A51437898C28C2B297112DF8131F2BB39EA5FE613487DDD611525F17962646398114550FC62003E785DC231A1058A05E56E3F09CF4E68314D4CC8AB5B21D86A82C3E9E8D0ECF2404B77FECBA";
    let p = XrpPayment::decode(&hex::decode(blob).unwrap()).unwrap();
    assert_eq!(hex::encode_upper(p.encode(true)), blob);
    assert_eq!(
        xrp_address_from_id(&p.account),
        "r3kmLJN5D28dHuH8vZNUZpMC43pEHpaocV"
    );
    assert!(matches!(xrp_verify_signed(blob), Err(Error::InvalidInput(m)) if m.contains("low-S")));
}

#[test]
fn refusals() {
    let s = seed(ALL);
    let me = xrp_address(&s, 0).unwrap();
    let pk = xrp_public_key(&s, 0).unwrap();
    let base = trezor_payment(
        0,
        "rBKz5MC2iXdoS3XgnNSYmF69K1Yo4NS3Ws",
        1_000_000,
        12,
        1,
        None,
        Some(1_000),
    );
    let refused = |p: &XrpPayment| {
        let h = hex::encode(p.encode(true));
        assert!(
            matches!(xrp_decode_tx(&h, &me, &pk), Err(Error::InvalidInput(_))),
            "{h}"
        );
    };
    refused(&XrpPayment {
        flags: Some(TF_FULLY_CANONICAL_SIG | 0x0002_0000),
        ..base.clone()
    });
    refused(&XrpPayment {
        flags: Some(0x0000_0001),
        ..base.clone()
    });
    refused(&XrpPayment {
        destination: base.account,
        ..base.clone()
    });
    refused(&XrpPayment {
        amount: XrpAmount::Xrp(0),
        ..base.clone()
    });
    refused(&XrpPayment {
        fee: 0,
        ..base.clone()
    });
    refused(&XrpPayment {
        amount: xrp_issued_amount("-5", "USD", "rrrrrrrrrrrrrrrrrrrrBZbvji").unwrap(),
        ..base.clone()
    });
    refused(&XrpPayment {
        last_ledger_sequence: None,
        ..base.clone()
    });
    refused(&XrpPayment {
        account: [9; 20],
        ..base.clone()
    });
    refused(&XrpPayment {
        signing_pub_key: Some(xrp_public_key(&s, 1).unwrap().to_vec()),
        ..base.clone()
    });
    refused(&XrpPayment {
        txn_signature: Some(vec![0x30, 0x00]),
        ..base.clone()
    });
    for fixture in [
        "1200002280020000240000689E201B010BF0E361D4950EA99C657EF800000000000000000000000055534400000000000A20B3C85F482532A9578DBB3950B85CA06594D1684000000000002AF8694000000000003A986AD40485B690F28E8000000000000000000000000055534400000000000A20B3C85F482532A9578DBB3950B85CA06594D1",
        "12000C22800000002400003B49201B01724E3520230000000368400000000000000B",
    ] {
        assert!(XrpPayment::decode(&hex::decode(fixture).unwrap()).is_err(), "{fixture}");
    }
    let mut dup = base.encode(true);
    dup.extend_from_slice(&[0x24, 0, 0, 0, 2]);
    assert!(XrpPayment::decode(&dup).is_err());
    // SendMax: allowed, reinforced.
    let sm = XrpPayment {
        send_max: Some(XrpAmount::Xrp(2_000_000)),
        ..base.clone()
    };
    let sum = xrp_decode_tx(&hex::encode(sm.encode(false)), &me, &pk).unwrap();
    assert!(sum.warnings.contains(&XrpWarning::SendMax) && sum.requires_extra_confirmation);
    let hf = XrpPayment {
        fee: 2_000_000,
        ..base
    };
    assert!(xrp_decode_tx(&hex::encode(hf.encode(false)), &me, &pk)
        .unwrap()
        .warnings
        .contains(&XrpWarning::HighFee));
}
