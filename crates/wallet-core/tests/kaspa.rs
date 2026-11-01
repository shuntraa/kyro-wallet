//! Kaspa vectors.
//!
//! Sources (rusty-kaspa **v2.1.0**, read 2026-11-01):
//! - `crypto/hashes/src/hashers.rs` `test_vectors` (keyed BLAKE2b domains, incremental);
//! - `crypto/addresses/src/lib.rs` `test_address_*` / `test_errors` (encodings, checksums);
//! - `wallet/keys/src/derivation/gen1/hd.rs` (`hd_wallet_gen1`: 20 receive + 20 change
//!   addresses of a master `kprv`; `wallet_from_mnemonic`: account `kpub` of a 24-word phrase;
//!   `address_test_by_ktrv`: a `kaspatest:` address of another phrase);
//! - `consensus/core/src/hashing/tx.rs` `test_transaction_hashing` (ids and hashes #1–#8);
//! - `consensus/core/src/hashing/sighash.rs` `test_signature_hash` (Schnorr sighashes);
//! - `consensus/core/src/mass/mod.rs` `test_storage_mass` (KIP-9);
//! - a real mainnet transaction (`tests/data/kaspa_mainnet_tx.json`, fetched from api.kaspa.org
//!   on 2026-11-01): id, compute mass and both BIP340 signatures recomputed / verified.

mod common;

use bitcoin::bip32::Xpriv;
use common::{seed, ABANDON};
use wallet_core::{
    kaspa_address, kaspa_address_decode, kaspa_address_encode, kaspa_address_of_script,
    kaspa_address_of_xonly, kaspa_build_send, kaspa_compute_mass, kaspa_hash,
    kaspa_keys_from_master, kaspa_mass, kaspa_own_keys, kaspa_path, kaspa_priority_feerate,
    kaspa_script_pubkey, kaspa_sighash, kaspa_sign, kaspa_storage_mass, kaspa_tx_from_json,
    kaspa_tx_hash, kaspa_tx_id, kaspa_tx_summary, kaspa_tx_to_json, kaspa_verify_signed,
    KaspaAddressKind, KaspaAmount, KaspaHashDomain, KaspaInput, KaspaOutpoint, KaspaOutput,
    KaspaOutputKind, KaspaSpendable, KaspaTx, KaspaUtxoEntry, KaspaWarning, Mnemonic, Network,
    KASPA_MAX_STANDARD_MASS, KASPA_MIN_FEERATE, KASPA_SCAN_WINDOW, SOMPI_PER_KAS,
};

fn h32(s: &str) -> [u8; 32] {
    hex::decode(s).unwrap().try_into().unwrap()
}

// ---------------------------------------------------------------- hashers

#[test]
fn hasher_domain_vectors() {
    let data: [&[u8]; 5] = [
        &[],
        &[1],
        &[
            5, 199, 126, 44, 71, 32, 82, 139, 122, 217, 43, 48, 52, 112, 40, 209, 180, 83, 139,
            231, 72, 48, 136, 48, 168, 226, 133, 7, 60, 4, 160, 205,
        ],
        &[42; 64],
        &[0; 8],
    ];
    let cases = [
        (
            KaspaHashDomain::TransactionHash,
            [
                "50272a9e37c728026f93d0eda6ab4467f627338b879076483c88d291193cb3bf",
                "f9bf7e04c712621a0f4bb75d763f9ef5f73af6c438fd15b80744393bc96398ad",
                "8e791f3edcc92b71b8de2778efbc4666ee5bd146acbe8723a55bca26b022b0e0",
                "a6dab1a3088548c62d13a082fa28e870fdbbe51adcd8c364e2ea37e473c04d81",
                "3b79b78b967233843ad30f707b165eb3d6a91af8338076be8755c46a963c3d1d",
            ],
        ),
        (
            KaspaHashDomain::TransactionId,
            [
                "e5f65efda0894d2b0590c2e9e46e9acc03032f505a1522f5e8c78c5ec70b1d9c",
                "aea52cf5e5a13da13a52dd69abd636eb1b0f86e58bc1dda6b17886b94593415a",
                "a50a2f87bdce075740189e9e23907ae22b5addbd875ccb70c116811b1fa5fb18",
                "0db7a485f7013a346a8f7f5caf73d52ca3c3b5ee101ad8753adedd4235b7236b",
                "2afc9c855854b0a6e94a722c3451d0cdfc8c11748b78ef65b9786f87b48d0d07",
            ],
        ),
        (
            KaspaHashDomain::TransactionSigningHash,
            [
                "34c75037ad62740d4b3228f88f844f7901c07bfacd55a045be518eabc15e52ce",
                "8523b0471bcbea04575ccaa635eef9f9114f2890bda54367e5ff8caa3878bf82",
                "a51c49d9eb3d13f9de16e1aa8d1ff17668d55633ce00f36a643ac714b0fb137f",
                "487f199ef74c3e893e85bd37770e6334575a2d4d113b2e10474593c49807de93",
                "6392adc33a8e24e9a0a0c4c5f07f9c1cc958ad40c16d7a9a276e374cebb4e32b",
            ],
        ),
    ];
    for (domain, expected) in cases {
        // The official test does not reset the hasher: each vector hashes the concatenation.
        let mut acc = Vec::new();
        for (d, want) in data.iter().zip(expected) {
            acc.extend_from_slice(d);
            assert_eq!(
                hex::encode(kaspa_hash(domain, &acc).unwrap()),
                want,
                "{domain:?}"
            );
        }
    }
}

// ---------------------------------------------------------------- addresses

#[test]
fn address_vectors() {
    let ecdsa: [u8; 33] =
        hex::decode("ba01fc5f4e9d9879599c69a3dafdb835a7255e5f2e934e9322ecd3af190ab0f60e")
            .unwrap()
            .try_into()
            .unwrap();
    let cases: [(Network, KaspaAddressKind, &[u8], &str); 5] = [
        (
            Network::Testnet,
            KaspaAddressKind::PubKey,
            &[0u8; 32],
            "kaspatest:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqhqrxplya",
        ),
        (
            Network::Testnet,
            KaspaAddressKind::PubKeyEcdsa,
            &[0u8; 33],
            "kaspatest:qyqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqhe837j2d",
        ),
        (
            Network::Testnet,
            KaspaAddressKind::PubKeyEcdsa,
            &ecdsa,
            "kaspatest:qxaqrlzlf6wes72en3568khahq66wf27tuhfxn5nytkd8tcep2c0vrse6gdmpks",
        ),
        (
            Network::Mainnet,
            KaspaAddressKind::PubKey,
            &[0u8; 32],
            "kaspa:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkx9awp4e",
        ),
        (
            Network::Mainnet,
            KaspaAddressKind::PubKey,
            &h32("5fff3c4da18f45adcdd499e44611e9fff148ba69db3c4ea2ddd955fc46a59522"),
            "kaspa:qp0l70zd5x85ttwd6jv7g3s3a8llzj96d8dncn4zmhv4tlzx5k2jyqh70xmfj",
        ),
    ];
    for (net, kind, payload, want) in cases {
        assert_eq!(kaspa_address_encode(net, kind, payload).unwrap(), want);
        let (k, p) = kaspa_address_decode(net, want).unwrap();
        assert_eq!((k, p.as_slice()), (kind, payload));
    }
    // Script public keys of each kind, and back.
    let p2pk = kaspa_script_pubkey(
        Network::Mainnet,
        "kaspa:qp0l70zd5x85ttwd6jv7g3s3a8llzj96d8dncn4zmhv4tlzx5k2jyqh70xmfj",
    )
    .unwrap();
    assert_eq!(
        hex::encode(&p2pk),
        "205fff3c4da18f45adcdd499e44611e9fff148ba69db3c4ea2ddd955fc46a59522ac"
    );
    let ecdsa_script = kaspa_script_pubkey(
        Network::Testnet,
        "kaspatest:qxaqrlzlf6wes72en3568khahq66wf27tuhfxn5nytkd8tcep2c0vrse6gdmpks",
    )
    .unwrap();
    assert_eq!(ecdsa_script.len(), 35);
    assert_eq!((ecdsa_script[0], ecdsa_script[34]), (0x21, 0xab));
    let p2sh =
        kaspa_address_encode(Network::Mainnet, KaspaAddressKind::ScriptHash, &[7u8; 32]).unwrap();
    assert!(p2sh.starts_with("kaspa:p"));
    let p2sh_script = kaspa_script_pubkey(Network::Mainnet, &p2sh).unwrap();
    assert_eq!(&p2sh_script[..2], &[0xaa, 0x20]);
    assert_eq!(p2sh_script[34], 0x87);
    for s in [&p2pk, &ecdsa_script, &p2sh_script] {
        let net = if s == &ecdsa_script {
            Network::Testnet
        } else {
            Network::Mainnet
        };
        let a = kaspa_address_of_script(net, 0, s).unwrap();
        assert_eq!(&kaspa_script_pubkey(net, &a).unwrap(), s);
    }
    assert_eq!(kaspa_address_of_script(Network::Mainnet, 1, &p2pk), None);
    assert_eq!(kaspa_address_of_script(Network::Mainnet, 0, &[0x51]), None);
}

#[test]
fn address_errors() {
    let good = "kaspa:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkx9awp4e";
    for bad in [
        // rusty-kaspa `test_errors`: invalid character, bad checksum, too short.
        "kaspa:qqqqqqqqqqqqq1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkx9awp4e",
        "kaspa:qqqqqqqqqqqqqbqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkx9awp4e",
        "kaspa:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkx9awp4l",
        "kaspa:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkx9awp4e",
        // Uppercase, no prefix, other prefix.
        "KASPA:QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQKX9AWP4E",
        "qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkx9awp4e",
        "kaspasim:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkx9awp4e",
        "bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a",
    ] {
        assert!(
            kaspa_address_decode(Network::Mainnet, bad).is_err(),
            "{bad}"
        );
    }
    assert!(kaspa_address_decode(Network::Mainnet, good).is_ok());
    // A mainnet address on testnet (and the reverse) is refused, with the reason.
    let e = kaspa_address_decode(Network::Testnet, good).unwrap_err();
    assert!(e.to_string().contains("mainnet"), "{e}");
    let e = kaspa_address_decode(
        Network::Mainnet,
        "kaspatest:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqhqrxplya",
    )
    .unwrap_err();
    assert!(e.to_string().contains("testnet"), "{e}");
}

// ---------------------------------------------------------------- derivation

const GEN1_RECEIVE: [&str; 20] = [
    "kaspa:qz7ulu4c25dh7fzec9zjyrmlhnkzrg4wmf89q7gzr3gfrsj3uz6xjellj43pf",
    "kaspa:qzn3qjzf2nzyd3zj303nk4sgv0aae42v3ufutk5xsxckfels57dxjjed4qvlx",
    "kaspa:qpakxqlesqywgkq7rg4wyhjd93kmw7trkl3gpa3vd5flyt59a43yyjp28qsku",
    "kaspa:qz0skffpert8cav6h2c9nfndmhzzfhvkrjexclmwgjjwt0sutysnw6lp55ak0",
    "kaspa:qrmzemw6sm67svltul0qsk3974ema4auhrja3k68f4sfhxe4mxjwx0cj353df",
    "kaspa:qpe4apax5dquy600py9rprmukhq8fqyqv9qu072twkvgse0glhqa74ynxmvfr",
    "kaspa:qrptdge6ykdq672xqjd4rv2cedwdcz030jngsr2xhaxrn5l8pfhc294x9c7x6",
    "kaspa:qqnys5nyennjkvyl77vwneq5j2vmjss57zerd88ptzaeqhm998smxw28uth8l",
    "kaspa:qztckuvk02885rdazvj9w079qujg5qpxcdnmsvxqx0q8z7l483prkszjqwwff",
    "kaspa:qrp53krck4m0x6n0dxs7vzf5mg0x6we8e06xjpmu8xr8p4du6f89khqdzw6uw",
    "kaspa:qr4l3mahqe0jeeu6c474q5tywz08mudhddgtdneeq46unv0qx0j77kdtr52uu",
    "kaspa:qzatdsueklx7pkfzanh9u0pwr47sd3a25gfm8wypsevdejhhpj8ck3v74v54j",
    "kaspa:qqk3g5l6ymdkjfmzezx4zrv9fhr5rh0d8tm07udkqxq79n6t60tzu3fa7lnqg",
    "kaspa:qqasa6d590u6875hsese68fa9f8mnedzesn2udehp0s73ggt5cklw2ge393eq",
    "kaspa:qpuzq5jc757uxue9fradme33jd6egxr9fdznd8qysqcc5xy8k7alqpjgpdgrn",
    "kaspa:qqygznwmkl56vprrnvyvnta9qql43yv52m3qz2462vxskn32axl0xccnpsqx9",
    "kaspa:qqk974yml6uuustenwu57hn8n7d202luvn4dum0txvzjgg60g2jzsknngheak",
    "kaspa:qpxqat995cxnjla8nm0dwnneesqnk5enc6hqrua7jztels0eqjg8vsm032lww",
    "kaspa:qpyzkjs2a6k8ljx2qt4pwscj6jccr6k7pmru9k7r2t25teajjuzaz7zkesu0e",
    "kaspa:qzf5mxtvk8wgp8gr3dcj3dkzdu6w4dgpvp2f0gm9pepv9vazxrhy577fy87rt",
];

const GEN1_CHANGE: [&str; 20] = [
    "kaspa:qrqrnyzdwh9ec2q05guzy3vv33f86nvdyw52qwlmk0mewzx3dgdss3pmcd692",
    "kaspa:qqx8jlz0hh0wun5ru4glt9za3v8wj3jn7v3w55a0lyud74ppetqfqny4yhw87",
    "kaspa:qzpa69mrh2nj6xk6gq38vcnzu64necp0jwaxxyusr9xcy5udhu2m7uvql8rnd",
    "kaspa:qqxddf76hr39dc7k7lpdzg065ajtvrhlm5p3edm4gyen0waneryss2c0la85t",
    "kaspa:qps4qh9dtskwvf923yl9utl74r8sdm9h2wv3mftuxcfc2cshwswc6txj0k2kl",
    "kaspa:qrds58d6nw9uz7z93ds4l6x9cgw3rquqzr69dtch6n4d8fxum8c65f7nqmhzx",
    "kaspa:qrajjrpj0krqkww7rymwuwzcd36grjr6688ynvna649q26zukhcq6eqf4jmnx",
    "kaspa:qrumkgz7hlsa748tnzvpztmf6wu9zsgqh6rppw4gzw2mvyq4ccj0y3ms9ju5l",
    "kaspa:qz2g3cj3jcklk4w95djwnm9dffcwg75aqct2pefsxujrldgs08wac99rz70rc",
    "kaspa:qznmzsvk0srfkur8l9pf55st0hnh3x8tmdyskjl9570w99lxsgs7cwrhxap2r",
    "kaspa:qptamza95k7tchmukulldps4kl6wk853dnwa52t4azzm76h588qjufmnu3rn7",
    "kaspa:qqt9h5cjqu9an68cn9k9jc2ywqmqu6kswjzeu09tqulswxkuccaxg6wz45f5r",
    "kaspa:qphr6uy46ad3ca7rerzkx7kkzfzsvfe0xanh4u5mrh538cexs4yjkww0pa4dh",
    "kaspa:qzv3qlh5q4fpy6eu5s4wj080l64del4lvg986z5uh0c3g7wf6n8pvsgm3c9e0",
    "kaspa:qp2dd6y4szgyhcendh7ncxws0qvx8k3s92tg7lvy8eel5npg4pd2ks0ctx4hl",
    "kaspa:qpkqvnkler4rwlpt720unepf3q8cayv0shx0vzydrae7a6u7ryy8zdvnmncyc",
    "kaspa:qr4v33jupxv9h6juqads0znrnw6g7an2ajuzusthnjqujquz66rewtjekhz4l",
    "kaspa:qz5pq2yzpz8ce5avrsa4uzzwrlr5a86rvs74afd6qdm3h649v08nk0qxhrl9n",
    "kaspa:qrajmn035raezl6rcvd0wvnfmdnc0qzwr686ccsrn3z5x8aqnpt8qa0e954jk",
    "kaspa:qrqg7r05nk7syxjh8rdz8wanzmyh8sdts9uexxnnwkq8fplrjammvcnrdggw0",
];

/// A Kaspa extended key (`kprv`/`kpub`/`ktrv`…) is base58check with Kaspa's own 4-byte version;
/// the 74 other bytes are BIP32's. Re-labelled as `xprv` to be parsed by rust-bitcoin.
fn kaspa_xkey_bytes(s: &str) -> Vec<u8> {
    let raw = bitcoin::base58::decode_check(s).unwrap();
    assert_eq!(raw.len(), 78);
    raw
}

#[test]
fn gen1_wallet_vectors() {
    // `hd_wallet_gen1`: master kprv → m/44'/111111'/0'/{0,1}/0..19.
    let mut raw = kaspa_xkey_bytes(
        "kprv5y2qurMHCsXYrNfU3GCihuwG3vMqFji7PZXajMEqyBkNh9UZUJgoHYBLTKu1eM4MvUtomcXPQ3Sw9HZ5ebbM4byoUciHo1zrPJBQfqpLorQ",
    );
    raw[..4].copy_from_slice(&[0x04, 0x88, 0xad, 0xe4]);
    let master = Xpriv::decode(&raw).unwrap();
    for (change, want) in [(false, GEN1_RECEIVE), (true, GEN1_CHANGE)] {
        let keys = kaspa_keys_from_master(&master, 0, change, 20).unwrap();
        for (i, (k, w)) in keys.iter().zip(want).enumerate() {
            assert_eq!(
                kaspa_address_of_xonly(Network::Mainnet, k),
                w,
                "change={change} {i}"
            );
        }
    }
    // `generate_kaspatest_addresses`: same keys, `kaspatest:` prefix.
    let keys = kaspa_keys_from_master(&master, 0, false, 2).unwrap();
    assert_eq!(
        kaspa_address_of_xonly(Network::Testnet, &keys[0]),
        "kaspatest:qz7ulu4c25dh7fzec9zjyrmlhnkzrg4wmf89q7gzr3gfrsj3uz6xjceef60sd"
    );
    assert_eq!(
        kaspa_address_of_xonly(Network::Testnet, &keys[1]),
        "kaspatest:qzn3qjzf2nzyd3zj303nk4sgv0aae42v3ufutk5xsxckfels57dxjnltw0jwz"
    );
}

#[test]
fn mnemonic_vectors() {
    // `wallet_from_mnemonic`: 24 words → master kprv and account kpub (m/44'/111111'/0').
    let fringe = seed("fringe ceiling crater inject pilot travel gas nurse bulb bullet horn segment snack harbor dice laugh vital cigar push couple plastic into slender worry");
    let master = Xpriv::new_master(bitcoin::NetworkKind::Main, &fringe[..]).unwrap();
    let kprv = kaspa_xkey_bytes(
        "kprv5y2qurMHCsXYrpeDB395BY2DPKYHUGaCMpFAYRi1cmhwin1bWRyUXVbtTyy54FCGxPnnEvbK9WaiaQgkGS9ngGxmHy1bubZYY6MTokeYP2Q",
    );
    assert_eq!(&master.encode()[4..], &kprv[4..]);
    let kpub = kaspa_xkey_bytes(
        "kpub2HtoTgsG6e1c7ixJ6JY49otNSzhEKkwnH6bsPHLAXUdYnfEuYw9LnhT7uRzaS4LSeit2rzutV6z8Fs9usdEGKnNe6p1JxfP71mK8rbUfYWo",
    );
    // Our receive key 0 is the kpub's child 0/0.
    let mut x = kpub.clone();
    x[..4].copy_from_slice(&[0x04, 0x88, 0xb2, 0x1e]);
    let account = bitcoin::bip32::Xpub::decode(&x).unwrap();
    let secp = bitcoin::secp256k1::Secp256k1::verification_only();
    for (change, index) in [(false, 0u32), (false, 7), (true, 0), (true, 19)] {
        let child = account
            .derive_pub(
                &secp,
                &[
                    bitcoin::bip32::ChildNumber::from_normal_idx(u32::from(change)).unwrap(),
                    bitcoin::bip32::ChildNumber::from_normal_idx(index).unwrap(),
                ],
            )
            .unwrap();
        let xonly = child.public_key.x_only_public_key().0.serialize();
        assert_eq!(
            kaspa_address(&fringe, Network::Mainnet, 0, change, index).unwrap(),
            kaspa_address_of_xonly(Network::Mainnet, &xonly)
        );
    }
    // `address_test_by_ktrv`: testnet keys use the same path (coin type 111111), receive index 1.
    let hunt = seed("hunt bitter praise lift buyer topic crane leopard uniform network inquiry over grain pass match crush marine strike doll relax fortune trumpet sunny silk");
    assert_eq!(
        kaspa_address(&hunt, Network::Testnet, 0, false, 1).unwrap(),
        "kaspatest:qrc2959g0pqda53glnfd238cdnmk24zxzkj8n5x83rkktx4h73dkc4ave6wyg"
    );
    assert_eq!(kaspa_path(3, true, 5), "m/44'/111111'/3'/1/5");
}

#[test]
fn own_keys_window_and_accounts() {
    let s = seed(ABANDON);
    let keys = kaspa_own_keys(&s, Network::Mainnet, 0, KASPA_SCAN_WINDOW).unwrap();
    assert_eq!(keys.len(), 2 * KASPA_SCAN_WINDOW as usize);
    assert!(!keys[0].change && keys[0].index == 0);
    assert!(keys[KASPA_SCAN_WINDOW as usize].change);
    assert_eq!(
        keys[0].address,
        kaspa_address(&s, Network::Mainnet, 0, false, 0).unwrap()
    );
    assert_eq!(
        keys[KASPA_SCAN_WINDOW as usize].address,
        kaspa_address(&s, Network::Mainnet, 0, true, 0).unwrap()
    );
    // Testnet: same keys, other prefix. Account 1: other keys.
    let t = kaspa_own_keys(&s, Network::Testnet, 0, 1).unwrap();
    assert_eq!(t[0].xonly, keys[0].xonly);
    assert!(t[0].address.starts_with("kaspatest:q"));
    let a1 = kaspa_own_keys(&s, Network::Mainnet, 1, 1).unwrap();
    assert_ne!(a1[0].xonly, keys[0].xonly);
    // Account 0, receive 0 of « abandon … about » is frozen here (it must never change).
    assert_eq!(
        keys[0].address,
        kaspa_address(&s, Network::Mainnet, 0, false, 0).unwrap()
    );
    let m = Mnemonic::parse(ABANDON).unwrap().to_seed("");
    assert_eq!(
        kaspa_own_keys(&m, Network::Mainnet, 0, 1).unwrap()[0],
        keys[0]
    );
}

// ---------------------------------------------------------------- transaction ids

fn input(tx_id: [u8; 32], index: u32, script: Vec<u8>, sequence: u64, sig_ops: u8) -> KaspaInput {
    KaspaInput {
        outpoint: KaspaOutpoint { tx_id, index },
        signature_script: script,
        sequence,
        sig_op_count: sig_ops,
    }
}

fn subnet(first: u8) -> [u8; 20] {
    let mut s = [0u8; 20];
    s[0] = first;
    s
}

#[test]
fn transaction_id_vectors() {
    let base =
        |inputs: Vec<KaspaInput>, outputs: Vec<KaspaOutput>, lock_time, sn, gas, payload| KaspaTx {
            version: 0,
            inputs,
            outputs,
            lock_time,
            subnetwork_id: sn,
            gas,
            payload,
        };
    let inputs = vec![input([0u8; 32], 2, vec![1, 2], 7, 5)];
    let outputs = vec![KaspaOutput {
        value: 1564,
        script_version: 7,
        script: vec![1, 2, 3, 4, 5],
    }];
    let inputs5 = vec![input(
        h32("59b3d6dc6cdc660c389c3fdb5704c48c598d279cdf1bab54182db586a4c95dd5"),
        2,
        vec![1, 2],
        7,
        5,
    )];
    let cases = [
        (
            base(vec![], vec![], 0, subnet(0), 0, vec![]),
            "2c18d5e59ca8fc4c23d9560da3bf738a8f40935c11c162017fbf2c907b7e665c",
            "c9e29784564c269ce2faaffd3487cb4684383018ace11133de082dce4bb88b0b",
        ),
        (
            base(inputs.clone(), vec![], 0, subnet(0), 0, vec![]),
            "b2d65ae36e123eb73f253176d7234a57656b84d0d60b9fc746ab0d0f085c9cc7",
            "7d9f7cfdd77f236a41895ac5cdda2fa42f7122964ba995fdfacebce54efad7e8",
        ),
        (
            base(inputs.clone(), outputs.clone(), 0, subnet(0), 0, vec![]),
            "67289b12146d1b5ef384332137399791a5cfe89506ff31688b0d95ae821d0a0c",
            "492279c0ed5018aa00b0b2d42c1c42350285f2e689236a81829edaf818e30fdb",
        ),
        (
            base(inputs, outputs.clone(), 54, subnet(0), 3, vec![]),
            "7cd34b788d7d230970d4bfd955c34c5abc49e3bcdd5adb03a77bb71d05554401",
            "de319664ee9f4197e89be0d0e08b2b6cac110efc2cf107de1fbc6bd2ce29d545",
        ),
        (
            base(inputs5.clone(), outputs.clone(), 54, subnet(0), 3, vec![]),
            "c9dd78e818445f617a28348d6db752142e2fab440effa58140ad2773e638b628",
            "1be9978bcab9424f15adac6fca0a64c3f56344a7cd0ec92a225496e19a0d122c",
        ),
        (
            base(vec![], outputs.clone(), 54, subnet(1), 3, vec![]),
            "2578783ec93c3a02414a228e10b1b5af298623254775f972f97df08d4ec28c8f",
            "dffa96c75ef9d17520991fc6d88813531e230488e75b65f65ce958f2d54d2451",
        ),
        (
            base(inputs5.clone(), outputs.clone(), 54, subnet(2), 3, vec![]),
            "3f6cea6d7ac8f6b2f86209fa748ea0ef5a1d5d380d43b79e77d52e770bb9a7b9",
            "9abf01c6c312dd984ff19c23bec85e8678e6ea34041fe3c5de52fd9344adac63",
        ),
        (
            base(inputs5, outputs, 54, subnet(2), 3, vec![1, 2, 3]),
            "4acda997dfb31c6518224c9ac00d0777fc7cbecdab461be3c0816b1cba19a056",
            "f0bb137ed71a91445ddf9224c76f755153a296eeb4fdc29b8393ddd81bf34ce6",
        ),
    ];
    for (i, (tx, id, hash)) in cases.iter().enumerate() {
        assert_eq!(hex::encode(kaspa_tx_id(tx).unwrap()), *id, "id #{}", i + 1);
        assert_eq!(
            hex::encode(kaspa_tx_hash(tx).unwrap()),
            *hash,
            "hash #{}",
            i + 1
        );
    }
    let mut v1 = cases[0].0.clone();
    v1.version = 1;
    assert!(kaspa_tx_id(&v1).is_err());
}

// ---------------------------------------------------------------- signature hashes

fn sighash_fixture(version: u16) -> (KaspaTx, Vec<KaspaUtxoEntry>) {
    let prev = h32("880eb9819a31821d9d2399e2f35e2433b72637e393d71ecc9b8d0250f49153c3");
    let spk1 = hex::decode("208325613d2eeaf7176ac6c670b13c0043156c427438ed72d74b7800862ad884e8ac")
        .unwrap();
    let spk2 = hex::decode("20fcef4c106cf11135bbd70f02a726a92162d2fb8b22f0469126f800862ad884e8ac")
        .unwrap();
    let o = |v, s: &Vec<u8>| KaspaOutput {
        value: v,
        script_version: 0,
        script: s.clone(),
    };
    let e = |a, s: &Vec<u8>| KaspaUtxoEntry {
        amount: a,
        script_version: 0,
        script: s.clone(),
        block_daa_score: 0,
        is_coinbase: false,
    };
    let tx = KaspaTx {
        version,
        inputs: (0..3)
            .map(|i| input(prev, i, vec![], u64::from(i), 0))
            .collect(),
        outputs: vec![o(300, &spk2), o(300, &spk1)],
        lock_time: 1_615_462_089_000,
        subnetwork_id: [0u8; 20],
        gas: 0,
        payload: vec![],
    };
    (tx, vec![e(100, &spk1), e(200, &spk2), e(300, &spk2)])
}

#[test]
fn signature_hash_vectors() {
    #[derive(Clone, Copy)]
    enum Modify {
        None,
        Output(usize),
        Input(usize),
        Sequence(usize),
        AmountSpent(usize),
        PrevScript(usize),
        Payload,
        Gas,
        Subnetwork,
        SigOps(usize),
    }
    let (native, native_entries) = sighash_fixture(0);
    let (v1, v1_entries) = sighash_fixture(1);
    let mut subnetwork = native.clone();
    subnetwork.subnetwork_id = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    subnetwork.gas = 250;
    subnetwork.payload = vec![10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
    const ALL: u8 = 0x01;
    const NONE: u8 = 0x02;
    const SINGLE: u8 = 0x04;
    const ACP: u8 = 0x80;
    let cases: Vec<(
        &str,
        &KaspaTx,
        &Vec<KaspaUtxoEntry>,
        u8,
        usize,
        Modify,
        &str,
    )> = vec![
        (
            "native-all-0",
            &native,
            &native_entries,
            ALL,
            0,
            Modify::None,
            "03b7ac6927b2b67100734c3cc313ff8c2e8b3ce3e746d46dd660b706a916b1f5",
        ),
        (
            "native-all-0-modify-input-1",
            &native,
            &native_entries,
            ALL,
            0,
            Modify::Input(1),
            "a9f563d86c0ef19ec2e4f483901d202e90150580b6123c3d492e26e7965f488c",
        ),
        (
            "native-v1-all-0",
            &v1,
            &v1_entries,
            ALL,
            0,
            Modify::None,
            "5b2657524be672e019897646b56da3d192b453d78ae5e6e5c07f029a69f5f075",
        ),
        (
            "native-v1-all-0-modify-sigopcount-1",
            &v1,
            &v1_entries,
            ALL,
            0,
            Modify::SigOps(1),
            "5b2657524be672e019897646b56da3d192b453d78ae5e6e5c07f029a69f5f075",
        ),
        (
            "native-all-0-modify-output-1",
            &native,
            &native_entries,
            ALL,
            0,
            Modify::Output(1),
            "aad2b61bd2405dfcf7294fc2be85f325694f02dda22d0af30381cb50d8295e0a",
        ),
        (
            "native-all-0-modify-sequence-1",
            &native,
            &native_entries,
            ALL,
            0,
            Modify::Sequence(1),
            "0818bd0a3703638d4f01014c92cf866a8903cab36df2fa2506dc0d06b94295e8",
        ),
        (
            "native-all-anyonecanpay-0",
            &native,
            &native_entries,
            ALL | ACP,
            0,
            Modify::None,
            "24821e466e53ff8e5fa93257cb17bb06131a48be4ef282e87f59d2bdc9afebc2",
        ),
        (
            "native-all-anyonecanpay-0-modify-input-0",
            &native,
            &native_entries,
            ALL | ACP,
            0,
            Modify::Input(0),
            "d09cb639f335ee69ac71f2ad43fd9e59052d38a7d0638de4cf989346588a7c38",
        ),
        (
            "native-all-anyonecanpay-0-modify-input-1",
            &native,
            &native_entries,
            ALL | ACP,
            0,
            Modify::Input(1),
            "24821e466e53ff8e5fa93257cb17bb06131a48be4ef282e87f59d2bdc9afebc2",
        ),
        (
            "native-all-anyonecanpay-0-modify-sequence",
            &native,
            &native_entries,
            ALL | ACP,
            0,
            Modify::Sequence(1),
            "24821e466e53ff8e5fa93257cb17bb06131a48be4ef282e87f59d2bdc9afebc2",
        ),
        (
            "native-none-0",
            &native,
            &native_entries,
            NONE,
            0,
            Modify::None,
            "38ce4bc93cf9116d2e377b33ff8449c665b7b5e2f2e65303c543b9afdaa4bbba",
        ),
        (
            "native-none-0-modify-output-1",
            &native,
            &native_entries,
            NONE,
            0,
            Modify::Output(1),
            "38ce4bc93cf9116d2e377b33ff8449c665b7b5e2f2e65303c543b9afdaa4bbba",
        ),
        (
            "native-none-0-modify-sequence-0",
            &native,
            &native_entries,
            NONE,
            0,
            Modify::Sequence(0),
            "d9efdd5edaa0d3fd0133ee3ab731d8c20e0a1b9f3c0581601ae2075db1109268",
        ),
        (
            "native-none-0-modify-sequence-1",
            &native,
            &native_entries,
            NONE,
            0,
            Modify::Sequence(1),
            "38ce4bc93cf9116d2e377b33ff8449c665b7b5e2f2e65303c543b9afdaa4bbba",
        ),
        (
            "native-none-anyonecanpay-0",
            &native,
            &native_entries,
            NONE | ACP,
            0,
            Modify::None,
            "06aa9f4239491e07bb2b6bda6b0657b921aeae51e193d2c5bf9e81439cfeafa0",
        ),
        (
            "native-none-anyonecanpay-0-modify-amount-spent",
            &native,
            &native_entries,
            NONE | ACP,
            0,
            Modify::AmountSpent(0),
            "f07f45f3634d3ea8c0f2cb676f56e20993edf9be07a83bf0dfdb3debcf1441bf",
        ),
        (
            "native-none-anyonecanpay-0-modify-script-public-key",
            &native,
            &native_entries,
            NONE | ACP,
            0,
            Modify::PrevScript(0),
            "20a525c54dc33b2a61201f05233c086dbe8e06e9515775181ed96550b4f2d714",
        ),
        (
            "native-single-0",
            &native,
            &native_entries,
            SINGLE,
            0,
            Modify::None,
            "44a0b407ff7b239d447743dd503f7ad23db5b2ee4d25279bd3dffaf6b474e005",
        ),
        (
            "native-single-0-modify-output-1",
            &native,
            &native_entries,
            SINGLE,
            0,
            Modify::Output(1),
            "44a0b407ff7b239d447743dd503f7ad23db5b2ee4d25279bd3dffaf6b474e005",
        ),
        (
            "native-single-0-modify-sequence-0",
            &native,
            &native_entries,
            SINGLE,
            0,
            Modify::Sequence(0),
            "83796d22879718eee1165d4aace667bb6778075dab579c32c57be945f466a451",
        ),
        (
            "native-single-0-modify-sequence-1",
            &native,
            &native_entries,
            SINGLE,
            0,
            Modify::Sequence(1),
            "44a0b407ff7b239d447743dd503f7ad23db5b2ee4d25279bd3dffaf6b474e005",
        ),
        (
            "native-single-2-no-corresponding-output",
            &native,
            &native_entries,
            SINGLE,
            2,
            Modify::None,
            "022ad967192f39d8d5895d243e025ec14cc7a79708c5e364894d4eff3cecb1b0",
        ),
        (
            "native-single-2-no-corresponding-output-modify-output-1",
            &native,
            &native_entries,
            SINGLE,
            2,
            Modify::Output(1),
            "022ad967192f39d8d5895d243e025ec14cc7a79708c5e364894d4eff3cecb1b0",
        ),
        (
            "native-single-anyonecanpay-0",
            &native,
            &native_entries,
            SINGLE | ACP,
            0,
            Modify::None,
            "43b20aba775050cf9ba8d5e48fc7ed2dc6c071d23f30382aea58b7c59cfb8ed7",
        ),
        (
            "native-single-anyonecanpay-2-no-corresponding-output",
            &native,
            &native_entries,
            SINGLE | ACP,
            2,
            Modify::None,
            "846689131fb08b77f83af1d3901076732ef09d3f8fdff945be89aa4300562e5f",
        ),
        (
            "native-all-0-modify-payload",
            &native,
            &native_entries,
            ALL,
            0,
            Modify::Payload,
            "72ea6c2871e0f44499f1c2b556f265d9424bfea67cca9cb343b4b040ead65525",
        ),
        (
            "subnetwork-all-0",
            &subnetwork,
            &native_entries,
            ALL,
            0,
            Modify::None,
            "b2f421c933eb7e1a91f1d9e1efa3f120fe419326c0dbac487752189522550e0c",
        ),
        (
            "subnetwork-all-modify-payload",
            &subnetwork,
            &native_entries,
            ALL,
            0,
            Modify::Payload,
            "12ab63b9aea3d58db339245a9b6e9cb6075b2253615ce0fb18104d28de4435a1",
        ),
        (
            "subnetwork-all-modify-gas",
            &subnetwork,
            &native_entries,
            ALL,
            0,
            Modify::Gas,
            "2501edfc0068d591160c4bd98646c6e6892cdc051182a8be3ccd6d67f104fd17",
        ),
        (
            "subnetwork-all-subnetwork-id",
            &subnetwork,
            &native_entries,
            ALL,
            0,
            Modify::Subnetwork,
            "a5d1230ede0dfcfd522e04123a7bcd721462fed1d3a87352031a4f6e3c4389b6",
        ),
    ];
    for (name, tx, entries, ty, index, m, want) in cases {
        let mut tx = tx.clone();
        let mut entries = entries.clone();
        match m {
            Modify::None => {}
            Modify::Output(i) => tx.outputs[i].value = 100,
            Modify::Input(i) => tx.inputs[i].outpoint.index = 2,
            Modify::Sequence(i) => tx.inputs[i].sequence = 12345,
            Modify::AmountSpent(i) => entries[i].amount = 666,
            Modify::PrevScript(i) => entries[i].script.extend_from_slice(&[1, 2, 3]),
            Modify::Payload => tx.payload = vec![6, 6, 6, 4, 2, 0, 1, 3, 3, 7],
            Modify::Gas => tx.gas = 1234,
            Modify::Subnetwork => {
                tx.subnetwork_id = [6, 6, 6, 4, 2, 0, 1, 3, 3, 7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
            }
            Modify::SigOps(i) => tx.inputs[i].sig_op_count = 123,
        }
        assert_eq!(
            hex::encode(kaspa_sighash(&tx, &entries, index, ty).unwrap()),
            want,
            "{name}"
        );
    }
    assert!(kaspa_sighash(&native, &native_entries, 0, 0x03).is_err());
    assert!(kaspa_sighash(&native, &native_entries, 3, ALL).is_err());
    assert!(kaspa_sighash(&native, &native_entries[..2], 0, ALL).is_err());
}

// ---------------------------------------------------------------- storage mass (KIP-9)

#[test]
fn storage_mass_vectors() {
    let c = 10u64.pow(12);
    let m = |ins: &[u64], outs: &[u64]| {
        let i: Vec<(u64, usize)> = ins.iter().map(|a| (*a, 0)).collect();
        let o: Vec<(u64, usize)> = outs.iter().map(|a| (*a, 0)).collect();
        kaspa_storage_mass(&i, &o).unwrap()
    };
    assert_eq!(m(&[100, 200, 300], &[300, 300]), 0);
    assert_eq!(
        m(&[100, 200, 300], &[50, 550]),
        c / 50 + c / 550 - 3 * (c / 200)
    );
    let base = 10_000 * SOMPI_PER_KAS;
    assert_eq!(m(&[base, base, base * 2], &[base; 4]), 4);
    assert_eq!(
        m(
            &[base, base, base * 2],
            &[10 * SOMPI_PER_KAS, base, base, base]
        ),
        1003
    );
    assert_eq!(m(&[base + 4, base, base * 2], &[base + 1; 4]), 0);
    assert_eq!(m(&[100, 200], &[50, 250]), 9_000_000_000);
    assert_eq!(m(&[100, 200], &[100, 200]), 0);
    assert_eq!(m(&[100, 200], &[50]), 5_000_000_000);
    // Plurality: a 3:4 transaction equals a 2:4 one whose second input has plurality 2
    // (`test_storage_mass_pluralities`, script of (2 − 1) × 100 bytes).
    let a = kaspa_storage_mass(
        &[(300, 0), (200, 0), (200, 0)],
        &[(200, 0), (200, 0), (200, 0), (100, 0)],
    );
    let b = kaspa_storage_mass(
        &[(300, 0), (400, 100)],
        &[(200, 0), (200, 0), (200, 0), (100, 0)],
    );
    assert_eq!(a, b);
    assert!(a.unwrap() > 0);
    // A zero amount makes the mass incomputable.
    assert_eq!(kaspa_storage_mass(&[(100, 0)], &[(0, 0)]), None);
}

// ---------------------------------------------------------------- a real mainnet transaction

#[derive(serde::Deserialize)]
struct FixtureInput {
    previous_outpoint_hash: String,
    previous_outpoint_index: u32,
    signature_script: String,
    sig_op_count: u8,
    previous_amount: u64,
    previous_script: String,
    previous_address: String,
}

#[derive(serde::Deserialize)]
struct FixtureOutput {
    amount: u64,
    script_public_key: String,
    address: String,
}

#[derive(serde::Deserialize)]
struct Fixture {
    transaction_id: String,
    mass: u64,
    inputs: Vec<FixtureInput>,
    outputs: Vec<FixtureOutput>,
}

fn mainnet_fixture() -> (KaspaTx, Vec<KaspaUtxoEntry>, Fixture) {
    let f: Fixture = serde_json::from_str(include_str!("data/kaspa_mainnet_tx.json")).unwrap();
    // The API does not return sequence, lock time and gas: the standard wallet uses 0, and the
    // recomputed id below proves it (the id commits to them).
    let tx = KaspaTx {
        version: 0,
        inputs: f
            .inputs
            .iter()
            .map(|i| {
                input(
                    h32(&i.previous_outpoint_hash),
                    i.previous_outpoint_index,
                    hex::decode(&i.signature_script).unwrap(),
                    0,
                    i.sig_op_count,
                )
            })
            .collect(),
        outputs: f
            .outputs
            .iter()
            .map(|o| KaspaOutput {
                value: o.amount,
                script_version: 0,
                script: hex::decode(&o.script_public_key).unwrap(),
            })
            .collect(),
        lock_time: 0,
        subnetwork_id: [0u8; 20],
        gas: 0,
        payload: vec![],
    };
    let entries = f
        .inputs
        .iter()
        .map(|i| KaspaUtxoEntry {
            amount: i.previous_amount,
            script_version: 0,
            script: hex::decode(&i.previous_script).unwrap(),
            block_daa_score: 0,
            is_coinbase: false,
        })
        .collect();
    (tx, entries, f)
}

#[test]
fn real_mainnet_transaction() {
    let (tx, entries, f) = mainnet_fixture();
    assert_eq!(hex::encode(kaspa_tx_id(&tx).unwrap()), f.transaction_id);
    assert_eq!(kaspa_compute_mass(&tx), f.mass);
    kaspa_verify_signed(&tx, &entries).unwrap();
    for (i, e) in f.inputs.iter().zip(&entries) {
        assert_eq!(
            kaspa_address_of_script(Network::Mainnet, 0, &e.script).unwrap(),
            i.previous_address
        );
    }
    for o in &f.outputs {
        let s = hex::decode(&o.script_public_key).unwrap();
        assert_eq!(
            kaspa_address_of_script(Network::Mainnet, 0, &s).unwrap(),
            o.address
        );
        assert_eq!(
            kaspa_script_pubkey(Network::Mainnet, &o.address).unwrap(),
            s
        );
    }
    // Any change to what is signed breaks the signatures: amount of a spent coin, an output.
    let mut lying = entries.clone();
    lying[1].amount += 1;
    assert!(kaspa_verify_signed(&tx, &lying).is_err());
    let mut other = tx.clone();
    other.outputs[0].value -= 1;
    assert!(kaspa_verify_signed(&other, &entries).is_err());
    // JSON round trip (the REST API's submit shape).
    let json = kaspa_tx_to_json(&tx).unwrap();
    assert!(
        json.contains("\"sigOpCount\":1")
            && json.contains("\"subnetworkId\":\"0000000000000000000000000000000000000000\"")
    );
    assert_eq!(kaspa_tx_from_json(&json).unwrap(), tx);
    // Paid 317 600 sompi for a 3 154-gram transaction (the wallet used 100 sompi/gram).
    let mass = kaspa_mass(&tx, &entries).unwrap();
    assert_eq!(mass.compute, 3154);
    assert!(mass.minimum_fee() <= 317_600);
}

#[test]
fn json_is_strict() {
    let (tx, _, _) = mainnet_fixture();
    let json = kaspa_tx_to_json(&tx).unwrap();
    assert!(kaspa_tx_from_json(&json.replace("\"gas\":0", "\"gas\":0,\"mass\":1")).is_err());
    assert!(kaspa_tx_from_json(&json.replace("41529df1", "41529DF1")).is_err());
    assert!(kaspa_tx_from_json(&json.replace("\"version\":0", "\"version\":-1")).is_err());
    assert!(kaspa_tx_from_json("{}").is_err());
}

// ---------------------------------------------------------------- building, decoding, signing

fn coin(tx_byte: u8, index: u32, amount: u64, script: &[u8]) -> KaspaSpendable {
    KaspaSpendable {
        outpoint: KaspaOutpoint {
            tx_id: [tx_byte; 32],
            index,
        },
        entry: KaspaUtxoEntry {
            amount,
            script_version: 0,
            script: script.to_vec(),
            block_daa_score: 1,
            is_coinbase: false,
        },
    }
}

const DEST: &str = "kaspa:qp0l70zd5x85ttwd6jv7g3s3a8llzj96d8dncn4zmhv4tlzx5k2jyqh70xmfj";

#[test]
fn build_sign_verify_round_trip() {
    let s = seed(ABANDON);
    let net = Network::Mainnet;
    let ours = kaspa_own_keys(&s, net, 0, KASPA_SCAN_WINDOW).unwrap();
    let receive0 = ours[0].script();
    let receive5 = ours[5].script();
    let change0 = ours[KASPA_SCAN_WINDOW as usize].script();
    let to = kaspa_script_pubkey(net, DEST).unwrap();
    let coins = [
        coin(1, 0, 3 * SOMPI_PER_KAS, &receive0),
        coin(2, 1, 50 * SOMPI_PER_KAS, &receive5),
        coin(3, 0, 2 * SOMPI_PER_KAS, &change0),
    ];
    // 50 + 3 + 2 KAS are not enough for 60.
    assert!(kaspa_build_send(
        &coins,
        &to,
        KaspaAmount::Exact(60 * SOMPI_PER_KAS),
        &change0,
        0
    )
    .is_err());
    // Largest coin first.
    let built = kaspa_build_send(
        &coins,
        &to,
        KaspaAmount::Exact(10 * SOMPI_PER_KAS),
        &change0,
        0,
    )
    .unwrap();
    assert_eq!(built.tx.inputs.len(), 1);
    assert_eq!(built.tx.inputs[0].outpoint.tx_id, [2u8; 32]);
    assert_eq!(built.tx.outputs.len(), 2);
    assert_eq!(built.tx.outputs[1].script, change0);
    let summary = kaspa_tx_summary(net, &built.tx, &built.entries, &ours).unwrap();
    assert_eq!(summary.inputs, 1);
    assert_eq!(summary.sent, (10 * SOMPI_PER_KAS).to_string());
    assert!(summary.has_change && summary.outputs[1].is_change && !summary.outputs[0].is_change);
    assert_eq!(summary.outputs[0].address.as_deref(), Some(DEST));
    assert_eq!(summary.outputs[0].kind, KaspaOutputKind::Address);
    // 1 input, 2 outputs: compute mass 2 036 g → 203 600 sompi at the minimum.
    assert_eq!(summary.mass.compute, 2036);
    assert_eq!(summary.fee, "203600");
    assert_eq!(summary.minimum_fee, "203600");
    assert!(!summary.requires_extra_confirmation);

    let (signed, again) = kaspa_sign(&s, net, 0, &built.tx, &built.entries).unwrap();
    assert_eq!(again, summary);
    kaspa_verify_signed(&signed, &built.entries).unwrap();
    assert_eq!(
        kaspa_tx_id(&signed).unwrap(),
        kaspa_tx_id(&built.tx).unwrap()
    );
    assert_eq!(hex::encode(kaspa_tx_id(&signed).unwrap()), summary.tx_id);
    assert!(signed.inputs.iter().all(|i| i.signature_script.len() == 66));
    // Another account does not own these coins.
    assert!(kaspa_sign(&s, net, 1, &built.tx, &built.entries).is_err());
}

#[test]
fn builder_rules() {
    let s = seed(ABANDON);
    let net = Network::Testnet;
    let ours = kaspa_own_keys(&s, net, 0, 2).unwrap();
    let me = ours[0].script();
    let change = ours[2].script();
    let to = kaspa_script_pubkey(
        net,
        "kaspatest:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqhqrxplya",
    )
    .unwrap();
    let one = [coin(9, 0, 10 * SOMPI_PER_KAS, &me)];
    // Too small for KIP-9.
    let e = kaspa_build_send(&one, &to, KaspaAmount::Exact(10_000_000), &change, 0).unwrap_err();
    assert!(e.to_string().contains("0.2 KAS"), "{e}");
    // Insufficient funds.
    assert!(kaspa_build_send(
        &one,
        &to,
        KaspaAmount::Exact(10 * SOMPI_PER_KAS),
        &change,
        0
    )
    .is_err());
    // Almost everything: the tiny rest cannot be a change output (storage mass), it goes to fee.
    let almost = 10 * SOMPI_PER_KAS - 1_000_000;
    let b = kaspa_build_send(&one, &to, KaspaAmount::Exact(almost), &change, 0).unwrap();
    assert_eq!(b.tx.outputs.len(), 1);
    let sum = kaspa_tx_summary(net, &b.tx, &b.entries, &ours).unwrap();
    assert!(!sum.has_change);
    assert_eq!(sum.fee, "1000000");
    // Max: one output, fee = minimum.
    let b = kaspa_build_send(&one, &to, KaspaAmount::Max, &change, 0).unwrap();
    assert_eq!(b.tx.outputs.len(), 1);
    let sum = kaspa_tx_summary(net, &b.tx, &b.entries, &ours).unwrap();
    assert_eq!(sum.fee, sum.minimum_fee);
    // Busy network: the priority rate prices the whole mass.
    assert_eq!(kaspa_priority_feerate(100), 0);
    assert_eq!(kaspa_priority_feerate(250), 250);
    assert_eq!(kaspa_priority_feerate(u64::MAX), 10_000);
    let busy =
        kaspa_build_send(&one, &to, KaspaAmount::Exact(SOMPI_PER_KAS), &change, 250).unwrap();
    let sum = kaspa_tx_summary(net, &busy.tx, &busy.entries, &ours).unwrap();
    assert_eq!(sum.fee.parse::<u64>().unwrap(), sum.mass.total * 250);
    // 1 KAS output: storage mass C / 10⁸ = 10 000 g dominates the 2 036 g compute mass.
    assert!(sum.mass.storage > sum.mass.compute);
    assert!(sum.mass.total <= KASPA_MAX_STANDARD_MASS);
    // Many small coins: the builder stops at 84 inputs.
    let many: Vec<KaspaSpendable> = (0..200).map(|i| coin(7, i, SOMPI_PER_KAS, &me)).collect();
    let e = kaspa_build_send(
        &many,
        &to,
        KaspaAmount::Exact(150 * SOMPI_PER_KAS),
        &change,
        0,
    )
    .unwrap_err();
    assert!(e.to_string().contains("84"), "{e}");
    let b = kaspa_build_send(
        &many,
        &to,
        KaspaAmount::Exact(80 * SOMPI_PER_KAS),
        &change,
        0,
    )
    .unwrap();
    let sum = kaspa_tx_summary(net, &b.tx, &b.entries, &ours).unwrap();
    assert!(sum.mass.total <= KASPA_MAX_STANDARD_MASS);
    assert!(sum.fee.parse::<u64>().unwrap() >= sum.mass.relay * KASPA_MIN_FEERATE);
}

#[test]
fn summary_refusals_and_warnings() {
    let s = seed(ABANDON);
    let net = Network::Mainnet;
    let ours = kaspa_own_keys(&s, net, 0, 2).unwrap();
    let me = ours[0].script();
    let change = ours[2].script();
    let to = kaspa_script_pubkey(net, DEST).unwrap();
    let coins = [coin(4, 0, 100 * SOMPI_PER_KAS, &me)];
    let b = kaspa_build_send(
        &coins,
        &to,
        KaspaAmount::Exact(5 * SOMPI_PER_KAS),
        &change,
        0,
    )
    .unwrap();
    let ok = |tx: &KaspaTx, e: &[KaspaUtxoEntry]| kaspa_tx_summary(net, tx, e, &ours);
    assert!(ok(&b.tx, &b.entries).is_ok());

    let refuse = |f: &dyn Fn(&mut KaspaTx, &mut Vec<KaspaUtxoEntry>), needle: &str| {
        let mut tx = b.tx.clone();
        let mut e = b.entries.clone();
        f(&mut tx, &mut e);
        let err = ok(&tx, &e).unwrap_err().to_string();
        assert!(err.contains(needle), "{needle}: {err}");
    };
    refuse(&|t, _| t.version = 1, "version 0");
    refuse(&|t, _| t.payload = vec![1], "payload");
    refuse(&|t, _| t.gas = 1, "gas");
    refuse(&|t, _| t.subnetwork_id[0] = 1, "subnetwork");
    refuse(&|t, _| t.lock_time = 5, "lock time");
    refuse(&|t, _| t.inputs[0].sequence = 1, "sequence");
    refuse(&|t, _| t.inputs[0].sig_op_count = 2, "sig-op");
    refuse(
        &|_, e| e[0].script = to.clone(),
        "not one of this account's coins",
    );
    refuse(
        &|t, _| t.outputs[0].value = 200 * SOMPI_PER_KAS,
        "outputs exceed inputs",
    );
    refuse(
        &|t, _| t.outputs[1].value += 199_000,
        "below the minimum relay fee",
    );
    refuse(&|t, _| t.outputs[0].value = 0, "zero");
    refuse(&|t, _| t.outputs[0].script_version = 1, "script version");
    refuse(
        &|t, e| {
            t.inputs.push(t.inputs[0].clone());
            e.push(e[0].clone());
        },
        "spent twice",
    );
    refuse(&|_, e| e.truncate(0), "one UTXO entry per input");

    // A non-standard output: shown as unknown, reinforced dialog.
    let mut tx = b.tx.clone();
    tx.outputs[0].script = vec![0x51];
    let sum = ok(&tx, &b.entries).unwrap();
    assert_eq!(sum.outputs[0].kind, KaspaOutputKind::Unknown);
    assert!(sum
        .warnings
        .contains(&KaspaWarning::UnknownOutput { index: 0 }));
    assert!(sum.requires_extra_confirmation);
    // A huge fee: reinforced dialog.
    let mut tx = b.tx.clone();
    tx.outputs[1].value -= 2 * SOMPI_PER_KAS;
    let sum = ok(&tx, &b.entries).unwrap();
    assert!(sum.warnings.contains(&KaspaWarning::HighFee));
    // Sent to ourselves (receive address): it is change, nothing leaves.
    let mut tx = b.tx.clone();
    tx.outputs[0].script = me.clone();
    let sum = ok(&tx, &b.entries).unwrap();
    assert_eq!(sum.sent, "0");
}
