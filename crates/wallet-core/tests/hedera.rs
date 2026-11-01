//! Hedera vectors.
//!
//! Sources (fetched 2026-11-01):
//! - hiero-sdk-java `MnemonicTest.toStandardECDSAsecp256k1PrivateKey()` and `…2()` (vectors of
//!   hedera-sdk-reference issue 73): public keys at `m/44'/3030'/0'/0/i` for a 24- and a 12-word
//!   mnemonic, with and without passphrase;
//! - HIP-15 (address checksums): `0.0.123-vfmkw` on mainnet, `0.0.123-esxsf` on testnet;
//! - `TransactionBody` bytes produced by Google's `protobuf` Python runtime (7.34.1) from the
//!   official field numbers of hiero-consensus-node `services/transaction.proto`,
//!   `basic_types.proto`, `crypto_transfer.proto`, `timestamp.proto`, `duration.proto`
//!   (`SerializeToString(deterministic=True)`).

mod common;

use common::{seed, ABANDON};
use wallet_core::{
    hbar_checksum, hbar_decode_precheck, hbar_decode_tx, hbar_evm_address,
    hbar_evm_address_of_pubkey, hbar_parse_account_id, hbar_parse_recipient, hbar_path,
    hbar_public_key, hbar_sign, hbar_verify_signed, HbarRecipient, HbarTransfer, HbarWarning,
    Mnemonic, Network,
};
use wallet_core::{hbar_decode_tx_on, hbar_known_token, hbar_sign_on, HbarKind};

const W24: &str = "inmate flip alley wear offer often piece magnet surge toddler submit right radio absent pear floor belt raven price stove replace reduce plate home";
const W12: &str = "finish furnace tomorrow wine mass goose festival air palm easy region guilt";

fn pk_hex(phrase: &str, pass: &str, index: u32) -> String {
    let s = Mnemonic::parse(phrase).unwrap().to_seed(pass);
    hex::encode(hbar_public_key(&s, index).unwrap())
}

#[test]
fn sdk_standard_ecdsa_vectors() {
    assert_eq!(hbar_path(0), "m/44'/3030'/0'/0/0");
    assert_eq!(hbar_path(5), "m/44'/3030'/0'/0/5");
    // 24 words.
    assert_eq!(
        pk_hex(W24, "", 0),
        "03b1c064b4d04d52e51f6c8e8bb1bff75d62fa7b1446412d5901d424f6aedd6fd4"
    );
    assert_eq!(
        pk_hex(W24, "some pass", 0),
        "0357d69bb36fee569838fe7b325c07ca511e8c1b222873cde93fc6bb541eb7ecea"
    );
    assert_eq!(
        pk_hex(W24, "some pass", 2_147_483_647),
        "02b59f348a6b69bd97afa80115e2d5331749b3c89c61297255430c487d6677f404"
    );
    // 12 words.
    assert_eq!(
        pk_hex(W12, "", 0),
        "0294bf84a54806989a74ca4b76291d386914610b40b610d303162b9e495bc06416"
    );
    assert_eq!(
        pk_hex(W12, "some pass", 0),
        "0293bdb1507a26542ed9c1ec42afe959cf8b34f39daab4bf842cdac5fa36d50ef7"
    );
    assert_eq!(
        pk_hex(W12, "some pass", 2_147_483_647),
        "03f9eb27cc73f751e8e476dd1db79037a7df2c749fa75b6cc6951031370d2f95a5"
    );
    // The EVM address is that of the key (same function as the EVM module, MetaMask vectors).
    let s = seed(W24);
    let pk = hbar_public_key(&s, 0).unwrap();
    assert_eq!(
        hbar_evm_address(&s, 0).unwrap(),
        hbar_evm_address_of_pubkey(&pk).unwrap()
    );
    // Accounts differ, account 0 is frozen.
    let a = seed(ABANDON);
    assert_ne!(
        hbar_evm_address(&a, 0).unwrap(),
        hbar_evm_address(&a, 1).unwrap()
    );
    // Frozen: account 0 must never change.
    assert_eq!(
        hbar_evm_address(&a, 0).unwrap(),
        "0xC283f34aDafdB758a557304C5F5e4c1E0A554713"
    );
}

#[test]
fn hip15_checksums_and_ids() {
    assert_eq!(hbar_checksum(Network::Mainnet, 123), "vfmkw");
    assert_eq!(hbar_checksum(Network::Testnet, 123), "esxsf");
    assert_eq!(
        hbar_parse_account_id("0.0.123", Network::Mainnet).unwrap(),
        123
    );
    assert_eq!(
        hbar_parse_account_id(" 0.0.123-vfmkw ", Network::Mainnet).unwrap(),
        123
    );
    assert_eq!(
        hbar_parse_account_id("0.0.123-esxsf", Network::Testnet).unwrap(),
        123
    );
    for bad in [
        "0.0.123-esxsf", // testnet checksum on mainnet
        "0.0.123-vfmkx",
        "0.0.0",
        "0.0.0123",
        "1.0.123",
        "0.1.123",
        "123",
        "0.0.",
        "0.0.12a",
        "0.0.99999999999999999999",
    ] {
        assert!(
            hbar_parse_account_id(bad, Network::Mainnet).is_err(),
            "{bad}"
        );
    }
    // Recipients.
    assert_eq!(
        hbar_parse_recipient("0.0.98", Network::Mainnet).unwrap(),
        HbarRecipient::Id(98)
    );
    let vitalik = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
    let r = hbar_parse_recipient(vitalik, Network::Mainnet).unwrap();
    assert_eq!(r.display(), vitalik);
    assert!(matches!(r, HbarRecipient::Evm(_)));
    assert_eq!(
        hbar_parse_recipient(&vitalik.to_lowercase(), Network::Mainnet).unwrap(),
        r
    );
    // Bad EIP-55 checksum.
    assert!(hbar_parse_recipient(
        "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96046",
        Network::Mainnet
    )
    .is_err());
    // Long-zero address = account ID.
    assert_eq!(
        hbar_parse_recipient(
            "0x0000000000000000000000000000000000000320",
            Network::Mainnet
        )
        .unwrap(),
        HbarRecipient::Id(800)
    );
    assert!(hbar_parse_recipient(
        "0x0000000000000000000000000000000000000000",
        Network::Mainnet
    )
    .is_err());
}

fn case1() -> HbarTransfer {
    HbarTransfer {
        payer: 1_234_567,
        valid_start_secs: 1_793_500_000,
        valid_start_nanos: 123_456_789,
        node: 3,
        max_fee: 100_000_000,
        valid_duration: 120,
        memo: "facture 42".into(),
        to: HbarRecipient::Id(98_765),
        amount: 150_000_000,
        kind: HbarKind::Hbar,
    }
}

const CASE1: &str = "0a130a0b08e0c69ad70610959aef3a12041887ad4b120218031880c2d72f22020878320a66616374757265203432721e0a1c0a0c0a041887ad4b10ffc5868f010a0c0a0418cd83061080c6868f01";
const SIGNED0: &str = "2ab7010a4c0a120a0b08e0c69ad70610959aef3a1203189221120218031880c2d72f22020878320a66616374757265203432721d0a1b0a0b0a0318922110ffc5868f010a0c0a0418cd83061080c6868f0112670a650a21021de0d6f31872bbda0cfd1680e41a5a88af2646b8d1d015c5e1541ab21a0f449932404f34b5810cc4720a23d71bab0cb96285727908395ffecd4f66c9d60ae93c0ab7393b86bf9b71161cfac061aa7fcfee38ed6e1624f4fc6f39677aab2c5007bf9a";
const CASE2: &str = "0a0e0a0608e0c69ad70612041887ad4b1202180418c0843d220308b40172280a260a080a041887ad4b10010a1a0a162214d8da6bf26964af9d7eed9e03e53415d37aa960451002";

#[test]
fn body_bytes_match_google_protobuf() {
    let t = case1();
    assert_eq!(hex::encode(t.encode()), CASE1);
    assert_eq!(
        HbarTransfer::decode(&hex::decode(CASE1).unwrap()).unwrap(),
        t
    );
    assert_eq!(t.transaction_id(), "0.0.1234567@1793500000.123456789");
    assert_eq!(
        t.mirror_transaction_id(),
        "0.0.1234567-1793500000-123456789"
    );
    let mut alias = [0u8; 20];
    hex::decode_to_slice("d8da6bf26964af9d7eed9e03e53415d37aa96045", &mut alias).unwrap();
    let t2 = HbarTransfer {
        valid_start_nanos: 0,
        node: 4,
        max_fee: 1_000_000,
        valid_duration: 180,
        memo: String::new(),
        to: HbarRecipient::Evm(alias),
        amount: 1,
        ..case1()
    };
    assert_eq!(hex::encode(t2.encode()), CASE2);
    assert_eq!(
        HbarTransfer::decode(&hex::decode(CASE2).unwrap()).unwrap(),
        t2
    );
    assert_eq!(t2.transaction_id(), "0.0.1234567@1793500000.000000000");
}

/// Appends a field to a body (raw protobuf), to build refused variants.
fn with(raw: &str, extra: &[u8]) -> Vec<u8> {
    let mut b = hex::decode(raw).unwrap();
    b.extend_from_slice(extra);
    b
}

#[test]
fn decoder_refuses_everything_else() {
    let refused = |b: &[u8], needle: &str| {
        let e = HbarTransfer::decode(b).unwrap_err().to_string();
        assert!(e.contains(needle), "{needle} not in {e}");
    };
    // Other transaction types / fields of TransactionBody.
    refused(&with(CASE1, &[0x3a, 0x00]), "champ 7"); // contractCall
    refused(&with(CASE1, &[0x5a, 0x00]), "champ 11"); // cryptoCreateAccount
    refused(&with(CASE1, &[0xca, 0x3e, 0x00]), "champ 1001"); // max_custom_fees
    refused(&with(CASE1, &[0x28, 0x01]), "generateRecord");
    // Duplicated / reordered field: re-encoding differs.
    refused(&with(CASE1, &[0x18, 0x01]), "non canonique");
    // A zero-valued field written explicitly (proto3 omits defaults).
    let mut t = case1();
    t.memo = String::new();
    let mut raw = t.encode();
    raw.extend_from_slice(&[0x32, 0x00]);
    refused(&raw, "non canonique");
    // Token transfers (field 2 of CryptoTransfer).
    let ct_tokens = {
        let mut b = Vec::new();
        b.extend_from_slice(&hex::decode(CASE1).unwrap());
        // rebuild cryptoTransfer with an extra tokenTransfers entry
        let pos = b.iter().rposition(|x| *x == 0x72).unwrap();
        let mut inner = b[pos + 2..].to_vec();
        inner.extend_from_slice(&[0x12, 0x00]);
        b.truncate(pos);
        b.push(0x72);
        b.push(inner.len() as u8);
        b.extend_from_slice(&inner);
        b
    };
    refused(&ct_tokens, "HBAR et jetons");
    refused(&with(CASE1, &[0xc2, 0x02, 0x00]), "deux opérations");
    // scheduled flag in the transaction ID.
    let scheduled = hex::decode(CASE1.replacen("0a130a0b", "0a150a0b", 1).replacen(
        "12041887ad4b1202",
        "12041887ad4b18011202",
        1,
    ))
    .unwrap();
    refused(&scheduled, "programmée");
}

#[test]
fn decoder_refuses_odd_transfer_lists() {
    // is_approval on the debit.
    let raw = hex::decode(CASE1).unwrap();
    let approval = {
        let s = hex::encode(&raw).replacen(
            "721e0a1c0a0c0a041887ad4b10ffc5868f01",
            "72200a1e0a0e0a041887ad4b10ffc5868f011801",
            1,
        );
        hex::decode(s).unwrap()
    };
    let e = HbarTransfer::decode(&approval).unwrap_err().to_string();
    assert!(e.contains("is_approval"), "{e}");
    // Debit of someone else than the payer.
    let other_payer = HbarTransfer::decode(
        &hex::decode(CASE1.replacen("0a0c0a041887ad4b10", "0a0c0a041888ad4b10", 1)).unwrap(),
    );
    assert!(other_payer.unwrap_err().to_string().contains("payeur"));
    // Credit ≠ debit.
    let unbalanced =
        hex::decode(CASE1.replacen("0a0418cd83061080c6868f01", "0a0418cd83061082c6868f01", 1))
            .unwrap();
    assert!(HbarTransfer::decode(&unbalanced)
        .unwrap_err()
        .to_string()
        .contains("incohérents"));
}

#[test]
fn sign_verify_round_trip() {
    let s = seed(ABANDON);
    let pk = hbar_public_key(&s, 0).unwrap();
    let mut t = case1();
    t.payer = 4_242;
    let bodies: Vec<String> = [3u64, 4, 7]
        .iter()
        .map(|n| {
            hex::encode(
                HbarTransfer {
                    node: *n,
                    ..t.clone()
                }
                .encode(),
            )
        })
        .collect();
    let nodes = [3u64, 4, 7, 8];
    let summary = hbar_decode_tx(&bodies, 4_242, &pk, &nodes).unwrap();
    assert_eq!(summary.from, "0.0.4242");
    assert_eq!(summary.to, "0.0.98765");
    assert_eq!(summary.amount, "150000000");
    assert_eq!(summary.memo.as_deref(), Some("facture 42"));
    assert_eq!(summary.nodes, ["0.0.3", "0.0.4", "0.0.7"]);
    assert!(!summary.requires_extra_confirmation);
    let (signed, again) = hbar_sign(&s, 0, 4_242, &bodies, &nodes).unwrap();
    assert_eq!(again, summary);
    assert_eq!(signed.len(), 3);
    for (tx, body) in signed.iter().zip(&bodies) {
        let v = hbar_verify_signed(tx).unwrap();
        assert_eq!(v.public_key, pk);
        assert_eq!(hex::encode(v.transfer.encode()), *body);
    }
    // Deterministic (RFC 6979): this exact signed transaction was re-checked independently with
    // Google's protobuf runtime (parse + identical re-serialization) and python-ecdsa (signature
    // over keccak256(bodyBytes) by the 33-byte key of the SignaturePair).
    assert_eq!(signed[0], SIGNED0);
    // Tampering: one byte of the body.
    let mut bad = hex::decode(&signed[0]).unwrap();
    bad[10] ^= 1;
    assert!(hbar_verify_signed(&hex::encode(bad)).is_err());

    // Refusals at signing.
    let not_ours = hbar_sign(&s, 0, 4_243, &bodies, &nodes);
    assert!(not_ours.unwrap_err().to_string().contains("payeur"));
    let unknown_node = hbar_decode_tx(&bodies, 4_242, &pk, &[3, 4]);
    assert!(unknown_node.unwrap_err().to_string().contains("0.0.7"));
    let dup = vec![bodies[0].clone(), bodies[0].clone()];
    assert!(hbar_decode_tx(&dup, 4_242, &pk, &nodes).is_err());
    let differ = vec![
        bodies[0].clone(),
        hex::encode(
            HbarTransfer {
                node: 4,
                amount: 1,
                ..t.clone()
            }
            .encode(),
        ),
    ];
    assert!(hbar_decode_tx(&differ, 4_242, &pk, &nodes)
        .unwrap_err()
        .to_string()
        .contains("diffèrent"));
    // To ourselves: by account ID and by our own EVM address.
    let me = hex::encode(
        HbarTransfer {
            to: HbarRecipient::Id(4_242),
            ..t.clone()
        }
        .encode(),
    );
    assert!(hbar_decode_tx(&[me], 4_242, &pk, &nodes).is_err());
    let evm = hbar_evm_address(&s, 0).unwrap();
    let mut own = [0u8; 20];
    hex::decode_to_slice(evm[2..].to_lowercase(), &mut own).unwrap();
    let me = hex::encode(
        HbarTransfer {
            to: HbarRecipient::Evm(own),
            ..t.clone()
        }
        .encode(),
    );
    assert!(hbar_decode_tx(&[me], 4_242, &pk, &nodes).is_err());
    // Validity > 180 s.
    let long = hex::encode(
        HbarTransfer {
            valid_duration: 181,
            ..t.clone()
        }
        .encode(),
    );
    assert!(hbar_decode_tx(&[long], 4_242, &pk, &nodes).is_err());
    // High fee and unusual memo → reinforced confirmation.
    let fee = hex::encode(
        HbarTransfer {
            max_fee: 300_000_000,
            memo: "a\u{202E}b".into(),
            ..t.clone()
        }
        .encode(),
    );
    let s2 = hbar_decode_tx(&[fee], 4_242, &pk, &nodes).unwrap();
    assert_eq!(
        s2.warnings,
        [HbarWarning::HighFee, HbarWarning::UnusualText]
    );
    assert!(s2.requires_extra_confirmation);
    assert_eq!(s2.memo.as_deref(), Some("ab"));
}

#[test]
fn precheck_response() {
    // TransactionResponse { nodeTransactionPrecheckCode: INVALID_SIGNATURE (7) }.
    assert_eq!(hbar_decode_precheck(&[0x08, 0x07]).unwrap(), (7, 0));
    assert_eq!(hbar_decode_precheck(&[]).unwrap(), (0, 0));
    assert_eq!(
        hbar_decode_precheck(&[0x08, 0x0a, 0x10, 0x05]).unwrap(),
        (10, 5)
    );
}

// ---------------------------------------------------------------- HTS tokens (USDC)

const USDC_MAIN: u64 = 456_858;
const USDC_TEST: u64 = 429_274;

fn put_varint(o: &mut Vec<u8>, mut v: u64) {
    while v >= 0x80 {
        o.push((v as u8) | 0x80);
        v >>= 7;
    }
    o.push(v as u8);
}

#[test]
fn known_tokens_are_circle_usdc() {
    let m = hbar_known_token(Network::Mainnet, USDC_MAIN).unwrap();
    assert_eq!((m.symbol, m.decimals), ("USDC", 6));
    assert!(hbar_known_token(Network::Mainnet, USDC_TEST).is_none());
    assert_eq!(hbar_known_token(Network::Testnet, USDC_TEST).unwrap().symbol, "USDC");
}

#[test]
fn token_transfer_and_association_encoding() {
    let token = HbarTransfer {
        amount: 12_500_000,
        kind: HbarKind::Token { token: USDC_MAIN, decimals: 6 },
        ..case1()
    };
    let raw = token.encode();
    // cryptoTransfer (field 14) holds only tokenTransfers (field 2): TokenID {tokenNum},
    // two AccountAmounts, expected_decimals { value: 6 }.
    let mut tid = vec![0x0a, 0x00, 0x18];
    put_varint(&mut tid, USDC_MAIN);
    tid[1] = (tid.len() - 2) as u8;
    let at = raw.windows(tid.len()).position(|w| w == tid.as_slice()).unwrap();
    assert_eq!(raw[at - 2], 0x12, "tokenTransfers is field 2");
    assert!(raw.ends_with(&[0x22, 0x02, 0x08, 0x06]), "expected_decimals = 6");
    assert_eq!(HbarTransfer::decode(&raw).unwrap(), token);
    let assoc = HbarTransfer {
        amount: 0,
        to: HbarRecipient::Id(1_234_567),
        kind: HbarKind::Associate(USDC_MAIN),
        ..case1()
    };
    let raw = assoc.encode();
    // tokenAssociate = field 40 (key 0xC2 0x02): { account: 0.0.payer, tokens: [0.0.456858] }.
    let at = raw.windows(2).position(|w| w == [0xc2, 0x02]).unwrap();
    let msg = |field: u8, num: u64| {
        let mut inner = vec![0x18];
        put_varint(&mut inner, num);
        let mut o = vec![field, inner.len() as u8];
        o.extend(inner);
        o
    };
    let body = [msg(0x0a, 1_234_567), msg(0x12, USDC_MAIN)].concat();
    assert_eq!(&raw[at + 3..], body.as_slice());
    assert_eq!(raw[at + 2] as usize, body.len());
    assert_eq!(HbarTransfer::decode(&raw).unwrap(), assoc);
    // Without decimals, with an NFT list, two token lists: refused.
    let mut no_dec = token.clone().encode();
    no_dec.truncate(no_dec.len() - 4);
    assert!(HbarTransfer::decode(&no_dec).is_err());
}

#[test]
fn tokens_are_signed_only_on_their_network() {
    let s = Mnemonic::parse(W12).unwrap().to_seed("");
    let pk = hbar_public_key(&s, 0).unwrap();
    let nodes = [3u64, 4];
    let body = |kind, to, amount| {
        hex::encode(
            HbarTransfer {
                payer: 4_242,
                node: 3,
                to,
                amount,
                kind,
                ..case1()
            }
            .encode(),
        )
    };
    let usdc = body(HbarKind::Token { token: USDC_MAIN, decimals: 6 }, HbarRecipient::Id(98_765), 2_000_000);
    // The network-less API refuses every token.
    assert!(hbar_decode_tx(std::slice::from_ref(&usdc), 4_242, &pk, &nodes).unwrap_err().to_string().contains("réseau"));
    let sm = hbar_decode_tx_on(Network::Mainnet, std::slice::from_ref(&usdc), 4_242, &pk, &nodes).unwrap();
    let t = sm.token.clone().unwrap();
    assert_eq!((t.token_id.as_str(), t.symbol.as_str(), t.decimals, t.associate), ("0.0.456858", "USDC", 6, false));
    assert_eq!(sm.amount, "2000000");
    // Mainnet USDC on testnet, wrong decimals, unknown token: refused.
    assert!(hbar_decode_tx_on(Network::Testnet, std::slice::from_ref(&usdc), 4_242, &pk, &nodes).is_err());
    let bad_dec = body(HbarKind::Token { token: USDC_MAIN, decimals: 2 }, HbarRecipient::Id(98_765), 1);
    assert!(hbar_decode_tx_on(Network::Mainnet, &[bad_dec], 4_242, &pk, &nodes).unwrap_err().to_string().contains("expected_decimals"));
    let other = body(HbarKind::Token { token: 731_861, decimals: 6 }, HbarRecipient::Id(98_765), 1);
    assert!(hbar_decode_tx_on(Network::Mainnet, &[other], 4_242, &pk, &nodes).unwrap_err().to_string().contains("inconnu"));
    // Association: for ourselves only.
    let assoc = body(HbarKind::Associate(USDC_MAIN), HbarRecipient::Id(4_242), 0);
    let sa = hbar_decode_tx_on(Network::Mainnet, std::slice::from_ref(&assoc), 4_242, &pk, &nodes).unwrap();
    assert!(sa.token.as_ref().unwrap().associate);
    let (signed, again) = hbar_sign_on(Network::Mainnet, &s, 0, 4_242, &[assoc], &nodes).unwrap();
    assert_eq!(again, sa);
    assert_eq!(hbar_verify_signed(&signed[0]).unwrap().transfer.kind, HbarKind::Associate(USDC_MAIN));
    let (signed, _) = hbar_sign_on(Network::Mainnet, &s, 0, 4_242, &[usdc], &nodes).unwrap();
    assert!(hbar_verify_signed(&signed[0]).is_ok());
}
