//! Polkadot (Asset Hub) vectors.

use wallet_core::{
    dot_account_id, dot_account_storage_key, dot_address, dot_asset_account_key,
    dot_asset_details_key, dot_asset_metadata_key, dot_blake2_256, dot_decode_account_info,
    dot_decode_asset_account, dot_decode_asset_details, dot_decode_asset_metadata,
    dot_decode_fee_info, dot_decode_payload, dot_fee_probe_extrinsic, dot_known_asset,
    dot_known_assets, dot_public_key, dot_runtime, dot_sign, dot_ss58_decode, dot_ss58_encode,
    dot_transfer_payload, dot_verify_extrinsic, DotAccountInfo, DotAssetAccount, DotAssetDetails,
    DotEra, DotExtension, DotRuntime, DotTransfer, Mnemonic, Network, PolkadotRoot,
    DOT_POLKADOT_ASSET_HUB, DOT_WESTEND_ASSET_HUB,
};

const ABANDON: &str =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const DEV: &str = "bottom drive obey lake curtain smoke basket hold race lonely fit walk";
const ZOO24: &str = "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo vote";
const METADATA: &[u8] = include_bytes!("data/polkadot_asset_hub_2005002.metadata_v15");

fn root(words: &str) -> PolkadotRoot {
    PolkadotRoot::from_mnemonic(&Mnemonic::parse(words).unwrap(), "").unwrap()
}

fn h32(s: &str) -> [u8; 32] {
    hex::decode(s).unwrap().try_into().unwrap()
}

fn runtime() -> DotRuntime {
    dot_runtime(Network::Mainnet, METADATA).unwrap()
}

#[test]
fn keys_match_polkadot_js() {
    type Derivation<'a> = (u32, &'a str, &'a str, &'a str);
    let cases: [(&str, &str, [Derivation; 3]); 3] = [
        (
            ABANDON,
            "4ed8d4b17698ddeaa1f1559f152f87b5d472f725ca86d341bd0276f1b61197e2",
            [
                (
                    0,
                    "66933bd1f37070ef87bd1198af3dacceb095237f803f3d32b173e6b425ed7972",
                    "13KVd4f2a4S5pLp4gTTFezyXdPWx27vQ9vS6xBXJ9yWVd7xo",
                    "5EPCUjPxiHAcNooYipQFWr9NmmXJKpNG5RhcntXwbtUySrgH",
                ),
                (
                    1,
                    "367af3b0d5bae948f910bf5365da6cb7639b0e4b6c3b0131f7d36637556a833f",
                    "12ES7PTE9a3DKbs9mCsRA6Wge2DS1XK1xFgbTkp47nPV53yG",
                    "5DJ8y4CAHnmjt4rdoZpR1wgXnQDnKDksskx7JTphZhMxthiG",
                ),
                (
                    2,
                    "582e53b26d1138af19d141d469ec45b9370b0339d5f6d086b03ee7d77f8ca846",
                    "12zcybhAvDPKwniEzr9UFUFxM1dLZ5mGDjMbpDYYdADbJuLe",
                    "5E4KqGS74S7rWFhj3D6U7KRoVPdgrnD89Ed7evZC55C58Kvh",
                ),
            ],
        ),
        (
            DEV,
            "fac7959dbfe72f052e5a0c3c8d6530f202b02fd8f9f5ca3580ec8deb7797479e",
            [
                (
                    0,
                    "46ebddef8cd9bb167dc30878d7113b7e168e6f0646beffd77d69d39bad76b47a",
                    "12bzRJfh7arnnfPPUZHeJUaE62QLEwhK48QnH9LXeK2m1iZU",
                    "5DfhGyQdFobKM8NsWvEeAKk5EQQgYe9AydgJ7rMB6E1EqRzV",
                ),
                (
                    1,
                    "b606fc73f57f03cdb4c932d475ab426043e429cecc2ffff0d2672b0df8398c48",
                    "157fnqgmRPJCyS7j2iuBrv9h5N82y3grxvGjcgeYgWKrVZVh",
                    "5GBNeWRhZc2jXu7D55rBimKYDk8PGk8itRYFTPfC8RJLKG5o",
                ),
                (
                    2,
                    "46f136b564e1fad55031404dd84e5cd3fa76bfe7cc7599b39d38fd06663bbc0a",
                    "12c21RnPz5HrXqHzk7wAzw5feFmjikXmiss8oRrcaqzfyDGY",
                    "5Dfis6XL8J2P6JHUnUtArnFWndn62SydeP8ee8sG2ky9nfm9",
                ),
            ],
        ),
        (
            ZOO24,
            "73c73744c78131a200a006ac140bcfb3746e9cbff23a77bf8ff8a099d3f2dbe6",
            [
                (
                    0,
                    "ac278e15c7356d5478765c9c227d67c68cb5e12e0443d394dffef7f1098b2f7c",
                    "14tizDU3xafE7o4B7kZkbFS5gEDreHCApywhG1f58mDPGuiF",
                    "5FxRqtCz6oPkgG3fA7WkT6bvpcECwye2kVDD6ifiagBs6ZiW",
                ),
                (
                    1,
                    "42770dbf7f200149add3136ed8c990ae72b3af7dd80274e4c6fca3778203271c",
                    "12W9XYuss9E9RVhA9U7fPCG9JUSXVagDrZQ5EokcTNRJ72AJ",
                    "5DZrPDep1MxfyxgeBq4fF3RzSrSsoH85n4fb5WmFuHPmvq3u",
                ),
                (
                    2,
                    "74758377deee0b5f1797f037c1719bdf3fcbea41cc72d25f06ca2093c5647e1a",
                    "13dhTt1vUN6FKpKnyyKU2s7cdB4nC572pjJiYBTX2S8gndq4",
                    "5EhQKYkrcapmtHKH2LGTtiHTmZ58VmYtkEaENtUAUM7AcCRv",
                ),
            ],
        ),
    ];
    for (words, mini, accounts) in cases {
        let r = root(words);
        assert_eq!(r.to_hex_for_tests(), mini);
        for (a, pk, polkadot, generic) in accounts {
            assert_eq!(
                hex::encode(dot_public_key(&r, a).unwrap()),
                pk,
                "{words} //{a}"
            );
            assert_eq!(dot_address(&r, a, Network::Mainnet).unwrap(), polkadot);
            assert_eq!(dot_address(&r, a, Network::Testnet).unwrap(), generic);
            assert_eq!(dot_ss58_decode(polkadot).unwrap(), (0, h32(pk)));
            assert_eq!(dot_ss58_decode(generic).unwrap(), (42, h32(pk)));
        }
    }
    // A BIP39 passphrase changes everything (substrate-bip39 salt "mnemonic" ‖ passphrase).
    let with_pass = PolkadotRoot::from_mnemonic(&Mnemonic::parse(DEV).unwrap(), "x").unwrap();
    assert_ne!(
        dot_public_key(&with_pass, 0).unwrap(),
        dot_public_key(&root(DEV), 0).unwrap()
    );
    assert!(dot_public_key(&root(DEV), 0x8000_0000).is_err());
    assert_eq!(format!("{:?}", root(DEV)), "PolkadotRoot(…)");
}

#[test]
fn ss58_refusals() {
    let ok = "13KVd4f2a4S5pLp4gTTFezyXdPWx27vQ9vS6xBXJ9yWVd7xo";
    assert!(dot_account_id(ok, Network::Mainnet).is_ok());
    assert!(dot_account_id(
        "5EPCUjPxiHAcNooYipQFWr9NmmXJKpNG5RhcntXwbtUySrgH",
        Network::Mainnet
    )
    .is_err());
    assert!(dot_account_id(ok, Network::Testnet).is_err());
    let ksm = dot_ss58_encode(
        &h32("66933bd1f37070ef87bd1198af3dacceb095237f803f3d32b173e6b425ed7972"),
        2,
    );
    assert_eq!(dot_ss58_decode(&ksm).unwrap().0, 2);
    assert!(dot_account_id(&ksm, Network::Mainnet).is_err());
    for bad in [
        "13KVd4f2a4S5pLp4gTTFezyXdPWx27vQ9vS6xBXJ9yWVd7xp", // checksum
        "13KVd4f2a4S5pLp4gTTFezyXdPWx27vQ9vS6xBXJ9yWVd7x",  // length
        "0x66933bd1f37070ef87bd1198af3dacceb095237f803f3d32b173e6b425ed7972",
        "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", // Bitcoin
        "",
    ] {
        assert!(dot_ss58_decode(bad).is_err(), "{bad}");
    }
}

#[test]
fn pinned_chains() {
    assert_eq!(
        hex::encode(DOT_POLKADOT_ASSET_HUB.genesis),
        "68d56f15f85d3136970ec16946040bc1752654e906147f7e43e9d539d7c3de2f"
    );
    assert_eq!(
        hex::encode(DOT_WESTEND_ASSET_HUB.genesis),
        "67f9723393ef76214df0118c34bbbd3dbebc8ed46a10973a8c969d48fe7598c9"
    );
    assert_eq!(
        (DOT_POLKADOT_ASSET_HUB.ss58, DOT_POLKADOT_ASSET_HUB.decimals),
        (0, 10)
    );
    assert_eq!(
        (DOT_WESTEND_ASSET_HUB.ss58, DOT_WESTEND_ASSET_HUB.decimals),
        (42, 12)
    );
}

#[test]
fn runtime_from_real_metadata() {
    let rt = runtime();
    assert_eq!(rt.spec_version, 2_005_002);
    assert_eq!(rt.tx_version, 15);
    assert_eq!(rt.existential_deposit, 100_000_000); // 0.01 DOT
    use DotExtension::*;
    assert_eq!(
        rt.extensions,
        vec![
            NoData, // AuthorizeCall
            NoData, // CheckNonZeroSender
            SpecVersion,
            TxVersion,
            Genesis,
            Mortality,
            Nonce,
            NoData,               // CheckWeight
            ChargeAssetTxPayment, // tip + asset_id
            NoData,               // PrevalidateAttests
            MetadataHash,
            NoData, // EthSetOrigin
            NoData, // StorageWeightReclaim
        ]
    );
    assert!(dot_runtime(Network::Testnet, METADATA).is_err());
    assert!(dot_runtime(Network::Mainnet, &METADATA[..METADATA.len() - 1]).is_err());
    assert!(dot_runtime(Network::Mainnet, &[0]).is_err());
    assert!(dot_runtime(Network::Mainnet, b"garbage").is_err());
}

fn patched(from: &str, to: &str) -> Vec<u8> {
    assert_eq!(from.len(), to.len());
    let mut m = METADATA.to_vec();
    let f = [&[(from.len() as u8) << 2][..], from.as_bytes()].concat();
    let t = [&[(to.len() as u8) << 2][..], to.as_bytes()].concat();
    let mut n = 0;
    let mut i = 0;
    while i + f.len() <= m.len() {
        if m[i..i + f.len()] == f[..] {
            m[i..i + f.len()].copy_from_slice(&t);
            n += 1;
            i += f.len();
        } else {
            i += 1;
        }
    }
    assert!(n > 0, "{from} not found");
    m
}

#[test]
fn runtime_changes_are_refused() {
    let e = dot_runtime(Network::Mainnet, &patched("CheckWeight", "CheckWeigxt")).unwrap_err();
    assert!(e.to_string().contains("CheckWeigxt"), "{e}");
    assert!(dot_runtime(
        Network::Mainnet,
        &patched("transfer_keep_alive", "transfer_keep_alivx")
    )
    .is_err());
    assert!(dot_runtime(Network::Mainnet, &patched("statemint", "statemixt")).is_err());
}

fn transfer() -> DotTransfer {
    DotTransfer {
        dest: h32("367af3b0d5bae948f910bf5365da6cb7639b0e4b6c3b0131f7d36637556a833f"),
        value: 12_345_678_900,
        era: DotEra::mortal(256, 1_000_000),
        block_hash: h32("71542782ee36b20f2c24ec0eb6dd5f709e666ffe0fe05140dcd1b6966fc97c38"),
        nonce: 7,
        tip: 0,
        asset: None,
    }
}

#[test]
fn asset_hub_metadata_has_the_assets_pallet_kyro_expects() {
    let rt = runtime();
    assert_eq!(rt.assets, Ok(()));
    assert_eq!(
        (
            DOT_POLKADOT_ASSET_HUB.assets_pallet,
            DOT_POLKADOT_ASSET_HUB.assets_transfer_keep_alive
        ),
        (50, 9)
    );
    let rt = dot_runtime(Network::Mainnet, &patched("min_balance", "min_balancx")).unwrap();
    assert!(rt.assets.is_err());
    let mut t = transfer();
    t.asset = Some(1984);
    let from = dot_public_key(&root(DEV), 0).unwrap();
    let p = hex::encode(t.payload(&rt));
    assert!(dot_decode_payload(&rt, &p, &from)
        .unwrap_err()
        .to_string()
        .contains("Assets"));
}

#[test]
fn known_assets_are_the_verified_ones() {
    let ids: Vec<_> = dot_known_assets(Network::Mainnet)
        .iter()
        .map(|a| (a.id, a.symbol, a.decimals))
        .collect();
    assert_eq!(ids, [(1984, "USDT", 6), (1337, "USDC", 6)]);
    assert!(dot_known_assets(Network::Testnet).is_empty());
    assert_eq!(
        dot_known_asset(Network::Mainnet, 1984)
            .unwrap()
            .chain_symbol,
        "USDt"
    );
}

#[test]
fn asset_transfer_is_encoded_signed_and_summarized() {
    let rt = runtime();
    let r = root(DEV);
    let from = dot_public_key(&r, 0).unwrap();
    let mut t = transfer();
    t.asset = Some(1984);
    t.value = 12_500_000;
    let call = t.call(&rt);
    assert_eq!(&call[..5], &[50, 9, 0x01, 0x1f, 0x00]);
    assert_eq!(
        &call[37..],
        &parity_scale_codec::Encode::encode(&parity_scale_codec::Compact(12_500_000u128))[..]
    );
    let payload = dot_transfer_payload(&rt, &t, &from).unwrap();
    let s = dot_decode_payload(&rt, &payload, &from).unwrap();
    assert_eq!(
        (
            s.call.as_str(),
            s.symbol.as_str(),
            s.decimals,
            s.amount.as_str()
        ),
        ("Assets.transfer_keep_alive", "USDT", 6, "12500000")
    );
    let a = s.asset.clone().unwrap();
    assert_eq!((a.asset_id, a.name.as_str()), (1984, "Tether"));
    let (ext, hash, again) = dot_sign(&r, 0, &rt, &payload).unwrap();
    assert_eq!(again, s);
    let (signer, h, _) = dot_verify_extrinsic(&rt, &ext, &t.block_hash).unwrap();
    assert_eq!((signer, h), (from, hash));
    let p = dot_transfer_payload(&rt, &transfer(), &from).unwrap();
    let n = dot_decode_payload(&rt, &p, &from).unwrap();
    assert!(n.asset.is_none() && n.symbol == "DOT");
}

#[test]
fn unknown_assets_are_refused() {
    let rt = runtime();
    let from = dot_public_key(&root(DEV), 0).unwrap();
    let mut t = transfer();
    t.asset = Some(1985);
    let p = hex::encode(t.payload(&rt));
    assert!(dot_decode_payload(&rt, &p, &from)
        .unwrap_err()
        .to_string()
        .contains("unknown"));
    assert!(dot_transfer_payload(&rt, &t, &from).is_err());
}

#[test]
fn asset_storage_keys_and_values() {
    let k = hex::encode(dot_asset_details_key(1337));
    assert!(k.starts_with("682a59d51ab9e48a8c8cc418ff9708d2d34371a193a751eea5883e9553457b2e"));
    assert!(k.ends_with("39050000"));
    assert!(hex::encode(dot_asset_metadata_key(1984))
        .starts_with("682a59d51ab9e48a8c8cc418ff9708d2b5f3822e35ca2f31ce3526eab1363fd2"));
    let acc = dot_asset_account_key(1984, &[7; 32]);
    assert_eq!(acc.len(), 32 + 20 + 48);
    let d = hex::decode("5670f9f348bd7f967539de1856c5b11de4302122233100adb22ceb9846f98b2c383a171d3c8fbbdcc9a831831663cd83f2efd57d0e84776469cc61c347d1dcfe6c7aa3e3187f04f100c14f7d29ebd9e2cdc7e78d367d46ae099751f72f55da3645fd34d372d89f1934e14f99fb3a7a977df9779763d265ce7a450af4d6df8a155026295f573e0100000000000000000000e87648170000000000000000000000102700000000000000000000000000000116bb1f000abb1f000c00000000").unwrap();
    let det = dot_decode_asset_details(&d).unwrap();
    assert_eq!(
        det,
        DotAssetDetails {
            min_balance: 10_000,
            is_sufficient: true,
            live: true
        }
    );
    let mut v = 2_500_000u128.to_le_bytes().to_vec();
    v.extend([0u8, 1]);
    assert_eq!(
        dot_decode_asset_account(&v).unwrap(),
        DotAssetAccount {
            balance: 2_500_000,
            frozen: false,
            blocked: false
        }
    );
    v[16] = 1;
    assert!(dot_decode_asset_account(&v).unwrap().frozen);
    v[16] = 3;
    assert!(dot_decode_asset_account(&v).is_err());
    let m = parity_scale_codec::Encode::encode(&(
        0u128,
        b"Tether USD".to_vec(),
        b"USDt".to_vec(),
        6u8,
        false,
    ));
    assert_eq!(
        dot_decode_asset_metadata(&m).unwrap(),
        ("USDt".to_string(), 6)
    );
}

const PAYLOAD: &str = "0a0300367af3b0d5bae948f910bf5365da6cb7639b0e4b6c3b0131f7d36637556a833f07341cdcdf0207041c0000000a981e000f00000068d56f15f85d3136970ec16946040bc1752654e906147f7e43e9d539d7c3de2f71542782ee36b20f2c24ec0eb6dd5f709e666ffe0fe05140dcd1b6966fc97c3800";
const PJS_SIG: &str = "2210877cbe307e88a7a02dcf78de7d07b12ebb569dbd0eea0b4d7891553afa3d72af0fb4774730f92ce9dc1b0acd82931c5742615ae22911ddf5ac264d3a6082";

#[test]
fn era_codec() {
    let e = DotEra::mortal(64, 42);
    assert_eq!((e.period, e.phase), (64, 42));
    assert_eq!((e.birth(42), e.death(42)), (42, 106));
    assert_eq!(e.birth(105), 42);
    let l = DotEra::mortal(32_768, 20_000);
    assert_eq!((l.period, l.phase), (32_768, 20_000));
    let k = DotEra::mortal(256, 1_000_000);
    assert_eq!(
        (k.period, k.phase, k.birth(1_000_000)),
        (256, 64, 1_000_000)
    );
    assert!(PAYLOAD.contains("07041c"));
}

#[test]
fn payload_matches_independent_encoding_and_polkadot_js_signature() {
    let rt = runtime();
    let dev = dot_public_key(&root(DEV), 0).unwrap();
    assert_eq!(
        dot_transfer_payload(&rt, &transfer(), &dev).unwrap(),
        PAYLOAD
    );
    let s = dot_decode_payload(&rt, PAYLOAD, &dev).unwrap();
    assert_eq!(s.from, "12bzRJfh7arnnfPPUZHeJUaE62QLEwhK48QnH9LXeK2m1iZU");
    assert_eq!(s.to, "12ES7PTE9a3DKbs9mCsRA6Wge2DS1XK1xFgbTkp47nPV53yG");
    assert_eq!(
        (s.amount.as_str(), s.symbol.as_str(), s.decimals),
        ("12345678900", "DOT", 10)
    );
    assert_eq!((s.nonce, s.era_period, s.era_phase), (7, 256, 64));
    assert_eq!((s.spec_version, s.tx_version), (2_005_002, 15));
    assert_eq!(s.call, "Balances.transfer_keep_alive");
    let t = transfer();
    let sig: [u8; 64] = hex::decode(PJS_SIG).unwrap().try_into().unwrap();
    let ext = hex::encode(t.extrinsic(&rt, &dev, &sig));
    let (signer, hash, again) = dot_verify_extrinsic(&rt, &ext, &t.block_hash).unwrap();
    assert_eq!((signer, again), (dev, s));
    assert_eq!(
        hash,
        hex::encode(dot_blake2_256(&hex::decode(&ext).unwrap()))
    );
    let other = h32("00000000000000000000000000000000000000000000000000000000000000aa");
    assert!(dot_verify_extrinsic(&rt, &ext, &other).is_err());
}

#[test]
fn sign_then_verify() {
    let rt = runtime();
    let r = root(ABANDON);
    let me = dot_public_key(&r, 0).unwrap();
    let t = transfer();
    let payload = dot_transfer_payload(&rt, &t, &me).unwrap();
    let (ext, hash, summary) = dot_sign(&r, 0, &rt, &payload).unwrap();
    assert_eq!(summary, dot_decode_payload(&rt, &payload, &me).unwrap());
    let raw = hex::decode(&ext).unwrap();
    assert_eq!(hash, hex::encode(dot_blake2_256(&raw)));
    assert_eq!(raw[0] & 0b11, 0b01);
    assert_eq!(
        (u16::from_le_bytes([raw[0], raw[1]]) >> 2) as usize,
        raw.len() - 2
    );
    assert_eq!(&raw[2..4], &[0x84, 0x00]);
    assert_eq!(&raw[4..36], &me);
    assert_eq!(raw[36], 0x01);
    assert!(raw.ends_with(&t.call(&rt)));
    let (signer, h2, s2) = dot_verify_extrinsic(&rt, &ext, &t.block_hash).unwrap();
    assert_eq!((signer, h2, s2), (me, hash, summary));
    let me1 = dot_public_key(&r, 1).unwrap();
    let mut t1 = t;
    t1.dest = me;
    let p1 = dot_transfer_payload(&rt, &t1, &me1).unwrap();
    let (e1, _, s1) = dot_sign(&r, 1, &rt, &p1).unwrap();
    assert_eq!(
        dot_verify_extrinsic(&rt, &e1, &t.block_hash).unwrap().0,
        me1
    );
    assert_eq!(s1.from, dot_address(&r, 1, Network::Mainnet).unwrap());
    assert!(dot_sign(&r, 0, &rt, &p1).is_err());
    for i in [2usize, 10, 40, raw.len() - 1, raw.len() - 20] {
        let mut x = raw.clone();
        x[i] ^= 1;
        assert!(
            dot_verify_extrinsic(&rt, &hex::encode(&x), &t.block_hash).is_err(),
            "byte {i}"
        );
    }
    let probe = dot_fee_probe_extrinsic(&rt, &payload, &me).unwrap();
    assert_eq!(probe.len(), raw.len());
    assert!(probe[37..101].iter().all(|b| *b == 0));
}

#[test]
fn payload_refusals() {
    let rt = runtime();
    let me = dot_public_key(&root(DEV), 0).unwrap();
    let p = hex::decode(PAYLOAD).unwrap();
    let refused = |bytes: &[u8]| dot_decode_payload(&rt, &hex::encode(bytes), &me).is_err();
    let at = |i: usize, v: u8| {
        let mut x = p.clone();
        x[i] = v;
        x
    };
    // Another call (transfer_allow_death = 0x0a00, System pallet), MultiAddress::Index.
    assert!(refused(&at(1, 0)));
    assert!(refused(&at(0, 0)));
    assert!(refused(&at(2, 1)));
    // call (3 + 32 + 6 bytes), then era (2), nonce (1), tip, asset, mode.
    let extra = 3 + 32 + 6;
    assert!(refused(&at(extra, 0))); // immortal era
    assert!(refused(&at(extra + 3, 4))); // tip 1
    assert!(refused(&at(extra + 4, 1))); // asset_id Some
    assert!(refused(&at(extra + 5, 1))); // CheckMetadataHash enabled
    let add = extra + 6;
    assert!(refused(&at(add, 0x0b))); // spec version
    assert!(refused(&at(add + 4, 0x10))); // transaction version
    assert!(refused(&at(add + 8, 0x69))); // genesis
    assert!(refused(&at(p.len() - 1, 1))); // metadata hash Some
    assert!(refused(&[&p[..], &[0]].concat())); // trailing byte
    assert!(refused(&p[..p.len() - 1])); // truncated
    let nc = [&p[..extra + 2], &[0x1d, 0x00], &p[extra + 3..]].concat();
    assert!(refused(&nc));
    let mut long = transfer();
    long.era = DotEra::mortal(8192, 1_000_000);
    assert!(dot_transfer_payload(&rt, &long, &me).is_err());
    // Zero amount, to oneself, with a tip.
    let mut t = transfer();
    t.value = 0;
    assert!(dot_transfer_payload(&rt, &t, &me).is_err());
    let mut t = transfer();
    t.dest = me;
    assert!(dot_transfer_payload(&rt, &t, &me).is_err());
    let mut t = transfer();
    t.tip = 1;
    assert!(dot_transfer_payload(&rt, &t, &me).is_err());
    assert!(dot_decode_payload(&rt, "zz", &me).is_err());
}

#[test]
fn account_storage_and_fee_info() {
    let id = h32("66933bd1f37070ef87bd1198af3dacceb095237f803f3d32b173e6b425ed7972");
    let k = dot_account_storage_key(&id);
    assert_eq!(
        hex::encode(&k[..32]),
        "26aa394eea5630e07c48ae0c9558cef7b99d880ec681799c0cf30e8886371da9"
    );
    assert_eq!(&k[48..], &id);
    assert_eq!(k.len(), 80);
    let mut v = Vec::new();
    for n in [14u32, 0, 1, 0] {
        v.extend_from_slice(&n.to_le_bytes());
    }
    for n in [1_890_905_223_357u128, 0, 500_000_000_000, 1u128 << 127] {
        v.extend_from_slice(&n.to_le_bytes());
    }
    let a = dot_decode_account_info(&v).unwrap();
    assert_eq!(
        a,
        DotAccountInfo {
            nonce: 14,
            consumers: 0,
            providers: 1,
            sufficients: 0,
            free: 1_890_905_223_357,
            reserved: 0,
            frozen: 500_000_000_000,
            flags: 1u128 << 127,
        }
    );
    assert!(a.exists());
    assert_eq!(a.spendable(1_000_000_000), 1_390_905_223_357);
    assert_eq!(DotAccountInfo::default().spendable(1), 0);
    assert!(!DotAccountInfo::default().exists());
    assert!(dot_decode_account_info(&v[..79]).is_err());
    let mut f = vec![0xa1, 0x0f, 0x01, 0x01, 0x00];
    f.extend_from_slice(&155_000_000u128.to_le_bytes());
    assert_eq!(dot_decode_fee_info(&f).unwrap(), 155_000_000);
    assert!(dot_decode_fee_info(&f[..f.len() - 1]).is_err());
}
