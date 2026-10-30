//! Cardano vectors.
//!
//! - CIP-0003 "Icarus" master keys: https://github.com/cardano-foundation/CIPs/blob/master/CIP-0003/Icarus.md
//! - CIP-0019 address test vectors (keys `addr_vk1w0l2…`, `stake_vk1px4j…`):
//!   https://github.com/cardano-foundation/CIPs/blob/master/CIP-0019/README.md#test-vectors
//! - Trezor firmware fixtures (`tests/fixtures/cardano/get_base_address*.json`,
//!   `get_public_key.derivations.json`, `sign_tx.json`, ICARUS derivation): addresses, account
//!   keys, transaction hashes and **signatures**, which are deterministic (Ed25519) and must be
//!   byte-identical.

use bitcoin::bech32::{primitives::decode::CheckedHrpstring, Bech32};
use wallet_core::{
    cardano_account_stake_address, cardano_account_xpub, cardano_address, cardano_address_bytes,
    cardano_address_string, cardano_base_address, cardano_blake2b256, cardano_cip20_aux,
    cardano_decode_tx, cardano_enterprise_address, cardano_min_utxo, cardano_sign,
    cardano_signed_size, cardano_signed_witnesses, cardano_stake_address, cardano_unsigned_tx,
    cardano_verify, CardanoAssets, CardanoBody, CardanoContext, CardanoInput, CardanoOutput,
    CardanoRoot, CardanoWarning, Mnemonic, Network,
};

const CIP3: &str =
    "eight country switch draw meat scout mystery blade tip drift useless good keep usage title";
const ALL: &str = "all all all all all all all all all all all all";
const VERY: &str = "very improve such purity recipe deer giggle shuffle bamboo sorry galaxy damp confirm note easy pause coast purse often hint west angle spare north";

fn root(phrase: &str, pass: &str) -> CardanoRoot {
    CardanoRoot::from_mnemonic(&Mnemonic::parse(phrase).unwrap(), pass)
}

fn bech_data(s: &str) -> Vec<u8> {
    CheckedHrpstring::new::<Bech32>(s)
        .unwrap()
        .byte_iter()
        .collect()
}

fn h32(s: &str) -> [u8; 32] {
    hex::decode(s).unwrap().try_into().unwrap()
}

#[test]
fn cip0003_icarus_master_keys() {
    assert_eq!(
        root(CIP3, "").to_hex_for_tests(),
        "c065afd2832cd8b087c4d9ab7011f481ee1e0721e78ea5dd609f3ab3f156d245d176bd8fd4ec60b4731c3918a2a72a0226c0cd119ec35b47e4d55884667f552a23f7fdcd4a10c6cd2c7393ac61d877873e248f417634aa3d812af327ffe9d620"
    );
    assert_eq!(
        root(CIP3, "foo").to_hex_for_tests(),
        "70531039904019351e1afb361cd1b312a4d0565d4ff9f8062d38acf4b15cce41d7b5738d9c893feea55512a3004acb0d222c35d3e3d5cde943a15a9824cbac59443cf67e589614076ba01e354b1a432e0e6db3b59e37fc56b5fb0222970a010e"
    );
    assert!(!format!("{:?}", root(CIP3, "")).contains("c065"));
}

#[test]
fn cip0019_address_vectors() {
    let pay: [u8; 32] =
        bech_data("addr_vk1w0l2sr2zgfm26ztc6nl9xy8ghsk5sh6ldwemlpmp9xylzy4dtf7st80zhd")
            .try_into()
            .unwrap();
    let stake: [u8; 32] =
        bech_data("stake_vk1px4j0r2fk7ux5p23shz8f3y5y2qam7s954rgf3lg5merqcj6aetsft99wu")
            .try_into()
            .unwrap();
    let m0 = "addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x";
    let t0 = "addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgs68faae";
    let m6 = "addr1vx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzers66hrl8";
    let t6 = "addr_test1vz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzerspjrlsz";
    assert_eq!(
        cardano_base_address(Network::Mainnet, &pay, &stake).unwrap(),
        m0
    );
    assert_eq!(
        cardano_base_address(Network::Testnet, &pay, &stake).unwrap(),
        t0
    );
    assert_eq!(
        cardano_enterprise_address(Network::Mainnet, &pay).unwrap(),
        m6
    );
    assert_eq!(
        cardano_enterprise_address(Network::Testnet, &pay).unwrap(),
        t6
    );
    assert_eq!(
        cardano_stake_address(Network::Mainnet, &stake).unwrap(),
        "stake1uyehkck0lajq8gr28t9uxnuvgcqrc6070x3k9r8048z8y5gh6ffgw"
    );
    assert_eq!(
        cardano_stake_address(Network::Testnet, &stake).unwrap(),
        "stake_test1uqehkck0lajq8gr28t9uxnuvgcqrc6070x3k9r8048z8y5gssrtvn"
    );

    // Accepted recipients: base key/key (0), key/script (2), enterprise key (6); round-trip.
    let m2 = "addr1yx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzerkr0vd4msrxnuwnccdxlhdjar77j6lg0wypcc9uar5d2shs2z78ve";
    for (a, net) in [
        (m0, Network::Mainnet),
        (t0, Network::Testnet),
        (m6, Network::Mainnet),
        (t6, Network::Testnet),
        (m2, Network::Mainnet),
    ] {
        let b = cardano_address_bytes(a, net).unwrap();
        assert_eq!(cardano_address_string(&b, net).unwrap(), a);
    }
    // Wrong network.
    assert!(cardano_address_bytes(m0, Network::Testnet).is_err());
    assert!(cardano_address_bytes(t0, Network::Mainnet).is_err());
    // Script payment (1, 3, 7), pointer (4, 5), reward (14), Byron: refused.
    for a in [
        "addr1z8phkx6acpnf78fuvxn0mkew3l0fd058hzquvz7w36x4gten0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgs9yc0hh",
        "addr1x8phkx6acpnf78fuvxn0mkew3l0fd058hzquvz7w36x4gt7r0vd4msrxnuwnccdxlhdjar77j6lg0wypcc9uar5d2shskhj42g",
        "addr1gx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer5pnz75xxcrzqf96k",
        "addr128phkx6acpnf78fuvxn0mkew3l0fd058hzquvz7w36x4gtupnz75xxcrtw79hu",
        "addr1w8phkx6acpnf78fuvxn0mkew3l0fd058hzquvz7w36x4gtcyjy7wx",
        "stake1uyehkck0lajq8gr28t9uxnuvgcqrc6070x3k9r8048z8y5gh6ffgw",
        "Ae2tdPwUPEZCanmBz5g2GEwFqKTKpNJcGYPKfDxoNeKZ8bRHr8366kseiK2",
        "DdzFFzCqrhsw3prhfMFDNFowbzUku3QmrMwarfjUbWXRisodn97R436SHc1rimp4MhPNmbdYb1aTdqtGSJixMVMi5MkArDQJ6Sc1n3Ez",
        "addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3y",
    ] {
        assert!(cardano_address_bytes(a, Network::Mainnet).is_err(), "{a}");
    }
}

#[test]
fn trezor_addresses_and_account_key() {
    let all = root(ALL, "");
    assert_eq!(
        cardano_address(&all, Network::Mainnet, 4, 0).unwrap(),
        "addr1q8v42wjda8r6mpfj40d36znlgfdcqp7jtj03ah8skh6u8wnrqua2vw243tmjfjt0h5wsru6appuz8c0pfd75ur7myyeqsx9990"
    );
    assert_eq!(
        cardano_address(&all, Network::Testnet, 4, 0).unwrap(),
        "addr_test1qrv42wjda8r6mpfj40d36znlgfdcqp7jtj03ah8skh6u8wnrqua2vw243tmjfjt0h5wsru6appuz8c0pfd75ur7myyeqnsc9fs"
    );
    let very = root(VERY, "");
    assert_eq!(
        cardano_account_xpub(&very, 0).unwrap(),
        "8946b80aaa2ab0839276ca373d0b7845803ae39e452ac2469986bf8b360b217f85e096c7789c5aa29012633044750b1a79ab5ac2eb7189c91113e8ffbadd550f"
    );
    assert_eq!(
        cardano_address(&very, Network::Mainnet, 0, 0).unwrap(),
        "addr1q996av5n0379tp8yllaxtgj3ffntmlrsl9sah237h65x6yt76a24dxtkgy59n8tvk00jf5dwfp8cz50g0uheuzfddcnqxp4njq"
    );
    assert!(cardano_account_stake_address(&very, Network::Mainnet, 0)
        .unwrap()
        .starts_with("stake1u"));
    assert!(cardano_account_xpub(&very, 0x8000_0000).is_err());
}

// ---------------------------------------------------------------------------------------------
// Trezor sign_tx.json (all × 12, input m/1852'/1815'/0'/0/0, fee 42, ttl 10, untagged sets)
// ---------------------------------------------------------------------------------------------

const TZ_PREV: &str = "3b40265111d8bb3c3c608d95b3a0bf83461ace32d79336579a1939b3aad1c0b7";
const TZ_DEST: &str = "addr1q84sh2j72ux0l03fxndjnhctdg7hcppsaejafsa84vh7lwgmcs5wgus8qt4atk45lvt4xfxpjtwfhdmvchdf2m3u3hlsd5tq5r";
const TZ_PUB: &str = "5d010cf16fdeff40955633d6c565f3844a288a24967cf6b76acbeb271b4f13c1";
const POL95: &str = "95a292ffee938be03e9bae5657982a74e9014eb4960108c9e23a5b39";
const POL75: &str = "75a292ffee938be03e9bae5657982a74e9014eb4960108c9e23a5b39";

fn out(addr: &str, coin: u64, assets: CardanoAssets) -> CardanoOutput {
    CardanoOutput {
        address: cardano_address_bytes(addr, Network::Mainnet).unwrap(),
        coin,
        assets,
        map_form: false,
    }
}

fn pol(p: &str) -> [u8; 28] {
    hex::decode(p).unwrap().try_into().unwrap()
}

fn tz_body(outputs: Vec<CardanoOutput>, ttl: Option<u64>) -> CardanoBody {
    CardanoBody {
        inputs: vec![CardanoInput {
            tx_hash: h32(TZ_PREV),
            index: 0,
        }],
        tagged_sets: false,
        outputs,
        fee: 42,
        ttl,
        aux_hash: None,
        validity_start: None,
    }
}

/// Trezor's fixtures pay 1 lovelace: the min-UTxO rule is disabled (coinsPerUTxOByte = 0) only
/// to reproduce them byte for byte.
fn ctx<'a>(own: &'a [String], verified: &'a [(&'a str, &'a str)], cpb: u64) -> CardanoContext<'a> {
    CardanoContext {
        net: Network::Mainnet,
        own,
        verified_tokens: verified,
        coins_per_byte: cpb,
    }
}

fn check_vector(
    body: CardanoBody,
    tx_hash: &str,
    sig: &str,
    own: &[String],
    verified: &[(&str, &str)],
) -> wallet_core::CardanoTxSummary {
    assert_eq!(hex::encode(body.tx_id()), tx_hash);
    let unsigned = hex::encode(cardano_unsigned_tx(&body, None).unwrap());
    let all = root(ALL, "");
    let (signed, id, summary) =
        cardano_sign(&all, 0, 0, &unsigned, &ctx(own, verified, 0)).unwrap();
    assert_eq!(id, tx_hash);
    assert_eq!(summary.tx_id, tx_hash);
    assert_eq!(
        signed,
        format!(
            "84{}a10081825820{TZ_PUB}5840{sig}f5f6",
            hex::encode(body.encode())
        )
    );
    let (wid, keys) = cardano_signed_witnesses(&signed).unwrap();
    assert_eq!(wid, tx_hash);
    assert_eq!(hex::encode(keys[0]), TZ_PUB);
    assert_eq!(
        cardano_signed_size(&body, None, 1).unwrap(),
        signed.len() / 2
    );
    // A signed transaction is not accepted for signing again.
    assert!(cardano_decode_tx(&signed, &ctx(own, verified, 0)).is_err());
    summary
}

#[test]
fn trezor_simple_with_change() {
    let all = root(ALL, "");
    let change = cardano_address(&all, Network::Mainnet, 0, 0).unwrap();
    let body = tz_body(
        vec![out(TZ_DEST, 1, vec![]), out(&change, 7_120_787, vec![])],
        Some(10),
    );
    let s = check_vector(
        body,
        "16fe72bb198be423677577e6326f1f648ec5fc11263b072006382d8125a6edda",
        "6a78f07836dcf4a303448d2b16b217265a9226be3984a69a04dba5d04f4dbb2a47b5e1cbb345f474c0b9634a2f37b921ab26e6a65d5dfd015dacb4455fb8430a",
        std::slice::from_ref(&change),
        &[],
    );
    assert_eq!(s.outputs.len(), 2);
    assert!(!s.outputs[0].is_change && s.outputs[1].is_change);
    assert_eq!(s.outputs[1].lovelace, "7120787");
    assert_eq!(s.fee, "42");
    assert_eq!(s.ttl, Some(10));
    assert!(s.warnings.is_empty() && !s.requires_extra_confirmation);
}

#[test]
fn trezor_no_ttl() {
    let all = root(ALL, "");
    let change = cardano_address(&all, Network::Mainnet, 0, 0).unwrap();
    let s = check_vector(
        tz_body(vec![out(&change, 7_120_787, vec![])], None),
        "b621e22f7cb9aac1a70a3362fde88bdfd31fc100e20f3f3c24a7b853536b4f50",
        "88c35c125664935117d9aa1173cae5f01967b02f6b716b1a135570b2fee74728f2f3e39d56b748302c36e2407d7bfefc4054ca1e60dd857e461734ae41d00500",
        &[change],
        &[],
    );
    assert_eq!(s.warnings, vec![CardanoWarning::NoTtl]);
    assert!(s.requires_extra_confirmation);
}

#[test]
fn trezor_multiasset() {
    let all = root(ALL, "");
    let change = cardano_address(&all, Network::Mainnet, 0, 0).unwrap();
    let assets = vec![(
        pol(POL95),
        vec![(hex::decode("74652474436f696e").unwrap(), 7_878_754)],
    )];
    let mut body = tz_body(
        vec![out(TZ_DEST, 1234, assets), out(&change, 7_120_787, vec![])],
        Some(10),
    );
    body.validity_start = Some(47);
    // Unknown token → reinforced.
    let s = check_vector(
        body.clone(),
        "b7269ddc59e4094a6581c653e0d5dc1e553e3a5fb6ffae47d3d094dff1cfe87b",
        "e9ab9920f24f7fdf10c90c9c1794cd9efea03dd4b3add405e5f9ffb61874d2704d376269649f8f5c57ec69b2df74fa94f73191fbeb21987b4b887743af454c06",
        std::slice::from_ref(&change),
        &[],
    );
    let t = &s.outputs[0].tokens[0];
    assert_eq!(t.policy, POL95);
    assert_eq!(t.name, "74652474436f696e");
    assert_eq!(t.name_text.as_deref(), Some("te$tCoin"));
    assert_eq!(t.quantity, "7878754");
    assert!(!t.verified);
    assert_eq!(
        s.warnings,
        vec![CardanoWarning::UnknownToken {
            policy: POL95.into(),
            name: "74652474436f696e".into()
        }]
    );
    // The same token in the verified table: no reinforced confirmation.
    let unsigned = hex::encode(cardano_unsigned_tx(&body, None).unwrap());
    let s2 = cardano_decode_tx(
        &unsigned,
        &ctx(&[change], &[(POL95, "74652474436f696e")], 0),
    )
    .unwrap();
    assert!(s2.outputs[0].tokens[0].verified && !s2.requires_extra_confirmation);
}

#[test]
fn trezor_different_policies() {
    let all = root(ALL, "");
    let change = cardano_address(&all, Network::Mainnet, 0, 0).unwrap();
    let assets = vec![
        (
            pol(POL75),
            vec![(hex::decode("7564247542686911").unwrap(), 47)],
        ),
        (
            pol(POL95),
            vec![
                (hex::decode("456c204e69c3b16f").unwrap(), 1234),
                (hex::decode("74652474436f696e").unwrap(), 7_878_754),
            ],
        ),
    ];
    let mut body = tz_body(
        vec![out(TZ_DEST, 1234, assets), out(&change, 7_120_787, vec![])],
        Some(10),
    );
    body.validity_start = Some(47);
    let s = check_vector(
        body,
        "0b929def7bd9f44f5602f809bc0f9be30521f6b93d625525cf33b956993bfb22",
        "8751e397bd9610735a92e65eab02c04aa61507f425e53c0119ddc06047bfac279439ee2bf6e0d572defa9e5649a1ea1fc2b8144041ab4970f39cd6850d4d670e",
        &[change],
        &[],
    );
    let names: Vec<_> = s.outputs[0]
        .tokens
        .iter()
        .map(|t| t.name_text.clone())
        .collect();
    // 0x11 is a control character: hex only.
    assert_eq!(
        names,
        vec![
            None,
            Some("El Niño".to_string()),
            Some("te$tCoin".to_string())
        ]
    );
}

#[test]
fn trezor_multiple_correctly_ordered_tokens() {
    // Outputs of Trezor's "multiple correctly ordered tokens" fixture. Its body also mints, so
    // Kyro refuses it and its hash is not reproduced; only the canonical order (asset names:
    // shorter first, then bytewise; policies bytewise) is checked here.
    let tok = |n: &str, q| (hex::decode(n).unwrap(), q);
    let a1 = vec![
        (
            pol(POL95),
            vec![
                tok("f565", 9_878_754),
                tok("f5652474436f69", 7_878_754),
                tok("74652474436f696e", 7_878_754),
                tok("75652474436f696e", 1234),
            ],
        ),
        (
            pol("96a292ffee938be03e9bae5657982a74e9014eb4960108c9e23a5b39"),
            vec![tok("74652474436f696e", 7_878_754)],
        ),
        (
            pol("d6a292ffee938be03e9bae5657982a74e9014eb4960108c9e23a5b39"),
            vec![tok("74652474436f696e", 7_878_754)],
        ),
    ];
    let a2 = vec![(
        pol("a6a292ffee938be03e9bae5657982a74e9014eb4960108c9e23a5b39"),
        vec![tok("74652474436f696e", 7_878_754)],
    )];
    let mut body = tz_body(
        vec![
            out(TZ_DEST, 2_000_000, a1.clone()),
            out(TZ_DEST, 2_000_000, a2),
        ],
        Some(10),
    );
    body.validity_start = Some(47);
    let unsigned = hex::encode(cardano_unsigned_tx(&body, None).unwrap());
    let s = cardano_decode_tx(&unsigned, &ctx(&[], &[], 0)).unwrap();
    assert_eq!(s.outputs[0].tokens.len(), 6);
    assert_eq!(s.outputs[0].tokens[0].name, "f565");
    assert_eq!(s.valid_from, Some(47));
    assert_eq!(s.warnings.len(), 7, "seven unknown tokens");
    // Same tokens in a non-canonical order: refused (names, then policies).
    let mut wrong = a1.clone();
    wrong[0].1.swap(0, 2);
    let u = hex::encode(
        cardano_unsigned_tx(
            &tz_body(vec![out(TZ_DEST, 2_000_000, wrong)], Some(10)),
            None,
        )
        .unwrap(),
    );
    assert!(cardano_decode_tx(&u, &ctx(&[], &[], 0)).is_err());
    let mut wrong = a1;
    wrong.swap(1, 2);
    let u = hex::encode(
        cardano_unsigned_tx(
            &tz_body(vec![out(TZ_DEST, 2_000_000, wrong)], Some(10)),
            None,
        )
        .unwrap(),
    );
    assert!(cardano_decode_tx(&u, &ctx(&[], &[], 0)).is_err());
}

#[test]
fn trezor_auxiliary_data_hash() {
    // Trezor signs with only the hash; Kyro needs the data (it must show it), so only the body
    // hash and Trezor's signature are checked here.
    let mut body = tz_body(vec![out(TZ_DEST, 1, vec![])], Some(10));
    body.aux_hash = Some(h32(
        "ea4c91860dd5ec5449f8f985d227946ff39086b17f10b5afb93d12ee87050b6a",
    ));
    let id = body.tx_id();
    assert_eq!(
        hex::encode(id),
        "1875f1d59a53f1cb4c43949867d72bcfd857fa3b64feb88f41b78ddaa1a21cbf"
    );
    let sig = hex::decode("b2015772a91043aeb04b98111744a098afdade0db5e30206538d7f2814965a5800d45240137f4d0dc81845a71e67cda38beaf816a520d73c4decbf7cbf0f6d08").unwrap();
    cardano_verify(&hex::decode(TZ_PUB).unwrap(), &id, &sig).unwrap();
    let unsigned = hex::encode(cardano_unsigned_tx(&body, None).unwrap());
    assert!(
        cardano_decode_tx(&unsigned, &ctx(&[], &[], 0)).is_err(),
        "hash without data"
    );
}

// ---------------------------------------------------------------------------------------------
// Kyro-built transactions: CIP-20 memo, tagged sets, min-UTxO, refusals
// ---------------------------------------------------------------------------------------------

#[test]
fn memo_tagged_sets_and_min_utxo() {
    let r = root(ALL, "");
    let own = cardano_address(&r, Network::Testnet, 0, 0).unwrap();
    let own_b = cardano_address_bytes(&own, Network::Testnet).unwrap();
    let aux = cardano_cip20_aux("Kyro preprod test").unwrap();
    let min_plain = cardano_min_utxo(&own_b, &vec![], 4310);
    // (160 + 65) × 4310: a base-address ADA-only output is 65 bytes with a 5-byte coin.
    assert_eq!(min_plain, 969_750);
    let body = CardanoBody {
        inputs: vec![
            CardanoInput {
                tx_hash: h32(TZ_PREV),
                index: 0,
            },
            CardanoInput {
                tx_hash: h32(TZ_PREV),
                index: 3,
            },
        ],
        tagged_sets: true,
        outputs: vec![CardanoOutput {
            address: own_b.clone(),
            coin: 1_000_000,
            assets: vec![],
            map_form: false,
        }],
        fee: 180_000,
        ttl: Some(90_000_000),
        aux_hash: Some(cardano_blake2b256(&aux)),
        validity_start: None,
    };
    let unsigned = hex::encode(cardano_unsigned_tx(&body, Some(&aux)).unwrap());
    let c = CardanoContext {
        net: Network::Testnet,
        own: std::slice::from_ref(&own),
        verified_tokens: &[],
        coins_per_byte: 4310,
    };
    let (signed, id, s) = cardano_sign(&r, 0, 0, &unsigned, &c).unwrap();
    assert_eq!(id, hex::encode(body.tx_id()));
    assert_eq!(s.memo, Some(vec!["Kyro preprod test".to_string()]));
    assert_eq!(s.warnings, vec![CardanoWarning::Memo]);
    assert_eq!(s.outputs[0].min_lovelace, min_plain.to_string());
    assert_eq!(s.inputs[1], format!("{TZ_PREV}#3"));
    // Witness set {0: 258([[vkey, sig]])}, auxiliary data kept.
    assert!(signed.contains("a100d9010281825820"));
    assert!(signed.ends_with(&format!("f5{}", hex::encode(&aux))));
    cardano_signed_witnesses(&signed).unwrap();
    assert_eq!(
        cardano_signed_size(&body, Some(&aux), 1).unwrap(),
        signed.len() / 2
    );

    // Below min-UTxO: refused.
    let mut low = body.clone();
    low.outputs[0].coin = min_plain - 1;
    let u = hex::encode(cardano_unsigned_tx(&low, Some(&aux)).unwrap());
    assert!(cardano_decode_tx(&u, &c).is_err());
    // Aux data that does not match its hash: refused.
    let other = cardano_cip20_aux("something else").unwrap();
    let u = hex::encode(cardano_unsigned_tx(&body, Some(&other)).unwrap());
    assert!(cardano_decode_tx(&u, &c).is_err());
    // Metadata other than CIP-20 (label 721, NFT metadata) with a matching hash: refused.
    let nft = hex::decode("a11902d1a0").unwrap();
    let mut b = body.clone();
    b.aux_hash = Some(cardano_blake2b256(&nft));
    let u = hex::encode(cardano_unsigned_tx(&b, Some(&nft)).unwrap());
    assert!(cardano_decode_tx(&u, &c).is_err());
    // Duplicate input.
    let mut b = body.clone();
    b.inputs[1].index = 0;
    let u = hex::encode(cardano_unsigned_tx(&b, Some(&aux)).unwrap());
    assert!(cardano_decode_tx(&u, &c).is_err());
    // Mainnet output in a testnet transaction.
    let mut b = body;
    b.outputs[0].address[0] = 0x01;
    let u = hex::encode(cardano_unsigned_tx(&b, Some(&aux)).unwrap());
    assert!(cardano_decode_tx(&u, &c).is_err());
}

/// Body `{0: [[TZ_PREV, 0]], 1: [[addr, 1]], 2: 42, 3: 10, <extra>}` as an unsigned transaction.
fn with_extra(extra_key: u8, extra_value: &str, outputs_hex: Option<&str>) -> String {
    let addr = hex::encode(cardano_address_bytes(TZ_DEST, Network::Mainnet).unwrap());
    let outputs = outputs_hex
        .map(str::to_string)
        .unwrap_or(format!("81825839{addr}01"));
    let n = if extra_key == 0xff { 4 } else { 5 };
    let mut body = format!("a{n}00818258 20{TZ_PREV}0001{outputs}02182a030a").replace(' ', "");
    if extra_key != 0xff {
        body.push_str(&format!("{extra_key:02x}{extra_value}"));
    }
    format!("84{body}a0f5f6")
}

#[test]
fn refuses_everything_but_payments() {
    let c = ctx(&[], &[], 0);
    // Baseline is accepted.
    cardano_decode_tx(&with_extra(0xff, "", None), &c).unwrap();
    let cases: &[(u8, &str, &str)] = &[
        (0x04, "80", "certificates"),
        (0x05, "a0", "withdrawals"),
        (0x09, "a0", "mint"),
        (0x0b, &format!("5820{TZ_PREV}"), "script data hash"),
        (0x0d, "80", "collateral"),
        (0x0e, "80", "required signers"),
        (0x0f, "01", "network id"),
        (0x10, "80", "collateral return"),
        (0x11, "01", "total collateral"),
        (0x12, "80", "reference inputs"),
        (0x13, "a0", "voting procedures"),
        (0x14, "80", "proposals"),
        (0x15, "00", "treasury"),
        (0x16, "01", "donation"),
        (0x17, "01", "unknown"),
    ];
    for (k, v, what) in cases {
        assert!(
            cardano_decode_tx(&with_extra(*k, v, None), &c).is_err(),
            "{what}"
        );
    }
    let addr = hex::encode(cardano_address_bytes(TZ_DEST, Network::Mainnet).unwrap());
    // Outputs with a datum hash (legacy), datum or reference script (map form): refused.
    for o in [
        format!("81835839{addr}015820{TZ_PREV}"),
        format!("81a3005839{addr}0101028200 5820{TZ_PREV}").replace(' ', ""),
        format!("81a3005839{addr}010103d8184100"),
    ] {
        assert!(
            cardano_decode_tx(&with_extra(0xff, "", Some(&o)), &c).is_err(),
            "{o}"
        );
    }
    // Map-form output without datum: accepted.
    let s = cardano_decode_tx(
        &with_extra(0xff, "", Some(&format!("81a2005839{addr}0101"))),
        &c,
    )
    .unwrap();
    assert_eq!(s.outputs[0].address, TZ_DEST);
    // Non-canonical encodings: fee 42 as 3 bytes, keys out of order, indefinite map.
    let tx = with_extra(0xff, "", None);
    let inner = tx
        .strip_prefix("84a4")
        .unwrap()
        .strip_suffix("02182a030aa0f5f6")
        .unwrap();
    let mk = |head: &str, tail: &str| format!("84{head}{inner}{tail}a0f5f6");
    assert_eq!(mk("a4", "02182a030a"), tx);
    assert!(cardano_decode_tx(&mk("a4", "0219002a030a"), &c).is_err());
    assert!(cardano_decode_tx(&mk("a4", "030a02182a"), &c).is_err());
    assert!(cardano_decode_tx(&mk("bf", "02182a030aff"), &c).is_err());
    // Duplicate key (fee twice), trailing byte, is_valid = false, not hex.
    assert!(cardano_decode_tx(&mk("a5", "02182a02182a030a"), &c).is_err());
    assert!(cardano_decode_tx(&mk("a5", "02182a030a030a"), &c).is_err());
    assert!(cardano_decode_tx(&format!("{tx}00"), &c).is_err());
    assert!(cardano_decode_tx(&tx.replace("a0f5f6", "a0f4f6"), &c).is_err());
    assert!(cardano_decode_tx("zz", &c).is_err());
    // Zero token quantity.
    let zero = format!("818258 39{addr}8201a1581c{POL95}a14174 00").replace(' ', "");
    assert!(cardano_decode_tx(&with_extra(0xff, "", Some(&zero)), &c).is_err());
    let one = zero.replacen("417400", "417401", 1);
    cardano_decode_tx(&with_extra(0xff, "", Some(&one)), &c).unwrap();
}

#[test]
fn signature_is_strict_and_bound_to_the_key() {
    let all = root(ALL, "");
    let change = cardano_address(&all, Network::Mainnet, 0, 0).unwrap();
    let body = tz_body(vec![out(&change, 7_120_787, vec![])], Some(10));
    let unsigned = hex::encode(cardano_unsigned_tx(&body, None).unwrap());
    let (signed, id, _) = cardano_sign(&all, 0, 0, &unsigned, &ctx(&[], &[], 0)).unwrap();
    // Flip one signature bit: rejected.
    let pos = signed.len() - 6;
    let mut bad = signed.clone().into_bytes();
    bad[pos] = if bad[pos] == b'0' { b'1' } else { b'0' };
    assert!(cardano_signed_witnesses(std::str::from_utf8(&bad).unwrap()).is_err());
    // Another key index signs with another key.
    let (signed1, id1, _) = cardano_sign(&all, 0, 1, &unsigned, &ctx(&[], &[], 0)).unwrap();
    assert_eq!(id, id1);
    assert_ne!(
        cardano_signed_witnesses(&signed).unwrap().1,
        cardano_signed_witnesses(&signed1).unwrap().1
    );
}

// ---------------------------------------------------------------------------------------------
// Real preprod transactions (Koios `tx_cbor`, fetched 2026-10-30): decoding of third-party
// encodings, transaction id and witness verification.
// ---------------------------------------------------------------------------------------------

/// 2 ADA to the CIP-19 test address, no ttl (cardano-cli style, legacy outputs).
const PREPROD_331A: &str = "84a3008182582003e58bed78e8746cc08224576b001b254128b7e9d0c0d4f9f3b9858a404d0b7c010182825839009493315cd92eb5d8c4304e67b7e16ae36d61d34502694657811a2c8e337b62cfff6403a06a3acbc34f8c46003c69fe79a3628cefa9c472511a001e8480825839009493315cd92eb5d8c4304e67b7e16ae36d61d34502694657811a2c8e32c728d3861e164cab28cb8f006448139c8f1740ffb8e7aa9e5232dc1b000000022ef5e6b0021a00029075a1008182582073fea80d424276ad0978d4fe5310e8bc2d485f5f6bb3bf87612989f112ad5a7d584095f3c7e2a355e1c76e09360d80fa3ead32f94c91778263555cb39acbb0b1fb9e52b751600cbcc2becc6d9626f4b252a58478a26afbbf65b27f52c75bebcbb709f5f6";
/// Map-form outputs with five native tokens, and a `network_id` field (15).
const PREPROD_C7B6: &str = "84a40082825820b6188fe189c9a5d78bee648979ce0060a9049bedfe7b2696e0add4f8d6e5f326018258203c214a48924cf3faafec9e05e9fea5dcc02b34d5846389e99011b59d6c9ec333010182a2005839001f1899a0cbc2c9b8340cec6d619ed3fa523fa8875ea5d66bc74d0fb1693926d839c9ad2ce369668ee7018a8656a8ea13c95ff6fb11578efd011a0013d620a20058390071229fcde7f08fdcd3d22ba4fc00d0da339290fc84337b4a57c4a310089c02f3e2b2de387098cb510763b44ede16d581ffac1b6ddee0f3b201821a0180023ba5581c54f9290a88a407b2a1b9ce2c9a96142d02a8d0b686a634346a00d1efa1485349524955532d421b000000066720b300581c59e35b701247154f645388c5e17a098fced0e5098543dd58a797c04aa145524947454c1b000000051f4d5c00581c644825fe5f46cdedbbb14f26ef696bbd5a65b9875f8a17ce4ba445a7a1536772764c50284144412c5349524955532d41291a006ea6bc581c73dead11ca9e387fef50a8a68726a68273d607eea0f1d2bde205140fa1485349524955532d411b000000066720b300581cc0e65618da9d3d39d20d0f7cdefc6481aebe616fe063a447d8647c90a144564547411b000000028fa6ae00021a0002c2210f00a10081825820b800b5f9b6fa3f51c668f5eaa00bdd3a56c0199648817923ae6be5c9ec4fce9e5840b9ced20438e707b103707d4714e0011d03be9f1d23cc9ca98351d5cd59b287c5494d35a904b56b4a4eeb75037fcb9bcda6cc28333bbdaa2b5596dcaaae46f308f5f6";

fn unsign(tx: &str, witness_start: &str) -> String {
    let i = tx.rfind(witness_start).unwrap();
    format!("{}a0f5f6", &tx[..i])
}

#[test]
fn real_preprod_transactions() {
    let (id, keys) = cardano_signed_witnesses(PREPROD_331A).unwrap();
    assert_eq!(
        id,
        "331a79ece991fc9bfd98e9da2a5514f38f7ffeb3a08f1bd7e5a1f75af0e42416"
    );
    assert_eq!(keys.len(), 1);
    let (id, _) = cardano_signed_witnesses(PREPROD_C7B6).unwrap();
    assert_eq!(
        id,
        "c7b63f681ede0b8dd717f78b05fe671f31912a775434a0c2e33561324d454976"
    );

    let c = CardanoContext {
        net: Network::Testnet,
        own: &[],
        verified_tokens: &[],
        coins_per_byte: 4310,
    };
    let s = cardano_decode_tx(&unsign(PREPROD_331A, "a10081825820"), &c).unwrap();
    assert_eq!(
        s.tx_id,
        "331a79ece991fc9bfd98e9da2a5514f38f7ffeb3a08f1bd7e5a1f75af0e42416"
    );
    assert_eq!(
        s.outputs[0].address,
        "addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgs68faae"
    );
    assert_eq!(s.outputs[0].lovelace, "2000000");
    assert_eq!(s.fee, "168053");
    assert_eq!(s.warnings, vec![CardanoWarning::NoTtl]);
    // The network-id field (15) is refused.
    let e = cardano_decode_tx(&unsign(PREPROD_C7B6, "a10081825820"), &c).unwrap_err();
    assert!(e.to_string().contains("network id"), "{e}");
    // Without it (and so with another tx id), the map-form outputs and tokens decode.
    let body_only = unsign(PREPROD_C7B6, "a10081825820")
        .replacen("84a4", "84a3", 1)
        .replace("0f00a0f5f6", "a0f5f6");
    let s = cardano_decode_tx(&body_only, &c).unwrap();
    assert_eq!(s.outputs[1].tokens.len(), 5);
    assert_eq!(s.outputs[1].tokens[1].name_text.as_deref(), Some("RIGEL"));
}

/// The CIP-0019 test keys come from the published test mnemonic (cardano-addresses test
/// suite): payment key = m/1852'/1815'/0'/0/0, stake key = m/1852'/1815'/1'/2/0 (account 1).
/// Its preprod address is therefore spendable by anyone, like the "abandon" wallets.
#[test]
fn cip19_keys_come_from_the_published_test_mnemonic() {
    let r = root(
        "test walk nut penalty hip pave soap entry language right filter choice",
        "",
    );
    let cip19 = "addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgs68faae";
    let pay = wallet_core::cardano_payment_public_key(&r, 0, 0).unwrap();
    let stake_of_account_1 = cardano_address(&r, Network::Testnet, 1, 0).unwrap();
    let stake_pk: [u8; 32] = {
        // Rebuild the CIP-19 base address from the two derived keys.
        let pay_vk: [u8; 32] =
            bech_data("addr_vk1w0l2sr2zgfm26ztc6nl9xy8ghsk5sh6ldwemlpmp9xylzy4dtf7st80zhd")
                .try_into()
                .unwrap();
        assert_eq!(pay, pay_vk, "payment key = m/1852'/1815'/0'/0/0");
        bech_data("stake_vk1px4j0r2fk7ux5p23shz8f3y5y2qam7s954rgf3lg5merqcj6aetsft99wu")
            .try_into()
            .unwrap()
    };
    assert_eq!(
        cardano_base_address(Network::Testnet, &pay, &stake_pk).unwrap(),
        cip19
    );
    // The stake key is account 1's (m/1852'/1815'/1'/2/0).
    assert!(stake_of_account_1.starts_with("addr_test1"));
    assert_eq!(
        cardano_account_stake_address(&r, Network::Testnet, 1).unwrap(),
        "stake_test1uqehkck0lajq8gr28t9uxnuvgcqrc6070x3k9r8048z8y5gssrtvn"
    );
}
