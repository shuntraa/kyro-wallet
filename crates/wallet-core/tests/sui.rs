//! Sui vectors.

mod common;

use common::seed;
use wallet_core::{
    sui_address, sui_address_of_pubkey, sui_parse_address, sui_path, sui_public_key,
};

/// `test_mnemonics_ed25519` (keytool) = `TEST_CASES` (TypeScript SDK).
const KEYTOOL_MNEMONICS: [(&str, &str); 3] = [
    (
        "film crazy soon outside stand loop subway crumble thrive popular green nuclear struggle pistol arm wife phrase warfare march wheat nephew ask sunny firm",
        "0xa2d14fad60c56049ecf75246a481934691214ce413e6a8ae2fe6834c173a6133",
    ),
    (
        "require decline left thought grid priority false tiny gasp angle royal system attack beef setup reward aunt skill wasp tray vital bounce inflict level",
        "0x1ada6e6f3f3e4055096f606c746690f1108fcc2ca479055cc434a3e1d3f758aa",
    ),
    (
        "organ crash swim stick traffic remember army arctic mesh slice swear summer police vast chaos cradle squirrel hood useless evidence pet hub soap lake",
        "0xe69e896ca10f5a77732769803cc2b5707f0ab9d4407afb5e4b4464b89769af14",
    ),
];

#[test]
fn keytool_mnemonic_vectors() {
    assert_eq!(sui_path(0), "m/44'/784'/0'/0'/0'");
    assert_eq!(sui_path(7), "m/44'/784'/7'/0'/0'");
    for (words, address) in KEYTOOL_MNEMONICS {
        let s = seed(words);
        assert_eq!(sui_address(&s, 0).unwrap(), address);
        let pk = sui_public_key(&s, 0).unwrap();
        assert_eq!(sui_address_of_pubkey(&pk).unwrap(), address);
        assert_ne!(sui_address(&s, 1).unwrap(), address);
    }
}

#[test]
fn keytool_private_key_vectors() {
    for (sk, address) in [
        (
            "9dd9ae36ee51b912a0364c58c1f21333bcdad2d91911aa127226c512be285102",
            "0x90f3e6d73b5730f16974f4df1d3441394ebae62186baf83608599f226455afa7",
        ),
        (
            "eea84be738c59f56ee94dae8fd5a68082d4579ed38548d6ec4017da6c5619bf3",
            "0xfd233cd9a5dd7e577f16fa523427c75fbc382af1583c39fdf1c6747d2ed807a3",
        ),
        (
            "91e8808c489ee0cc99c2edf79e63be6a144f8f600c7411bc2e806f7255710674",
            "0x81aaefa4a883e72e8b6ccd3bec307e25fe3d79b14e43b778695c55dcec42f4f0",
        ),
    ] {
        let sk: [u8; 32] = hex::decode(sk).unwrap().try_into().unwrap();
        let pk = ed25519_dalek::SigningKey::from_bytes(&sk).verifying_key();
        assert_eq!(sui_address_of_pubkey(pk.as_bytes()).unwrap(), address);
        assert_eq!(sui_parse_address(address).unwrap().len(), 32);
    }
    let pk = ed25519_dalek::SigningKey::from_bytes(&[8u8; 32]).verifying_key();
    use base64::Engine as _;
    assert_eq!(
        base64::engine::general_purpose::STANDARD.encode(pk.as_bytes()),
        "E5j2LG0aRXxRumpLXz29L2n8qTIWIY3ImX5Ba9F9k8o="
    );
}

#[test]
fn invalid_public_keys_are_refused() {
    assert!(sui_address_of_pubkey(&[0u8; 31]).is_err());
    let mut not_a_point = [0u8; 32];
    not_a_point[0] = 2;
    assert!(sui_address_of_pubkey(&not_a_point).is_err());
}

use base64::Engine as _;
use wallet_core::{
    sui_address_string, sui_decode_tx, sui_sign, sui_tx_digest, sui_verify_signed, Seed,
    SuiObjectRef, SuiTransfer, SuiTransferAmount, SuiWarning,
};

fn b64(b: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(b)
}

fn unb64(s: &str) -> Vec<u8> {
    base64::engine::general_purpose::STANDARD.decode(s).unwrap()
}

/// Mainnet SUI transfers made with the official TypeScript SDK (`splitCoins(gas, [amount])` +
/// `transferObjects([coin], to)`), fetched 2026-11-01 from `graphql.mainnet.sui.io`
/// (`transaction(digest) { transactionBcs signatures { signatureBytes } }`, status SUCCESS):
/// (digest, transactionBcs, user signature).
const MAINNET: [(&str, &str, &str); 2] = [
    (
        "qoQG6UgMDH39fa9hxUHxRcFDrmFR3zURqHP2FPcYXG9",
        "AAACAAhgrR8AAAAAAAAgYkkPS1gdnrlMpzX0c13xp7iGjcsB0uL1MadmQ7eTgt4CAgABAQAAAQEDAAAAAAEBABd6D2uW4sdnA9l7OZkKYhBq7juwSLX7+k/P38ZxxUhpAVnypLM4p9uMIC/4T4MUy7X6RmX77Az4gMEC6NtWS85zS5CUKAAAAAAgK7D+xsyF+SZZVJan490OJ2Hb5sAJ0iinLtHTB72d6EIXeg9rluLHZwPZezmZCmIQau47sEi1+/pPz9/GccVIaWQAAAAAAAAAYK0fAAAAAAAA",
        "ACie0reggetvwlNmNoGywfxoPpUoMKcM5pKTDHkPG8nR6EsZuu8/cwNsVeQnilRlaf1lkEAZ1LX25AfW3I5eaw8jUSXrJy5K5wd8LegagQBocErsDTiHUyp8HhRTA3kv9Q==",
    ),
    (
        "GJmVEkKPbmC9Q5pwi7uanUxRFhbkjNBmnopuEMJp27tm",
        "AAACAAjGBk2fGQAAAAAgP5ilws7vKotLPHtJFV14Wj/I0J1hGd8b8+IGNXmruekCAgABAQAAAQEDAAAAAAEBAPeORg2c2AzrM3C0cF7d7/0/x3qHUCppGAjbQcOoNhCeAY+JJheGrtiwGXf1+draBcAPTEXbNPMGxnxBxiAltKzrAEO/PgAAAAAga1CH4NfE/MMWokMmN0UZ5LTHaDWf6vFhRR+D1zKya+b3jkYNnNgM6zNwtHBe3e/9P8d6h1AqaRgI20HDqDYQnugDAAAAAAAAAOH1BQAAAAAA",
        "AHUHFuH3ly7yyG/kxlKNn566Xzp4nWsH6Nu4A2K6pfdl5nEuG5xdStAdRNiKprcULZ3QESQw7BYF5HRz4iH9sAYAVUWxpBnDJwVHGFWThUuix+vDVM7cLXXL5+gkMoCBTg==",
    ),
];

#[test]
fn mainnet_transfers_decode_reencode_and_verify() {
    for (digest, bcs, sig) in MAINNET {
        let raw = unb64(bcs);
        let t = SuiTransfer::decode(&raw).unwrap();
        assert_eq!(t.encode().unwrap(), raw);
        assert_eq!(sui_tx_digest(&raw), digest);
        assert_eq!(sui_verify_signed(bcs, sig).unwrap(), digest);
        let s = sui_decode_tx(bcs, &sui_address_string(&t.sender)).unwrap();
        assert_eq!(s.digest, digest);
        assert_eq!(s.coin_type, "0x2::sui::SUI");
        assert_eq!(s.gas_coins.len(), 1);
        assert_eq!(s.warnings, vec![SuiWarning::NoExpiration]);
        assert!(s.requires_extra_confirmation);
        assert!(sui_decode_tx(bcs, KEYTOOL_MNEMONICS[0].1).is_err());
    }
    // Field values of the first vector, rebuilt from scratch: same bytes.
    let addr = |a: &str| sui_parse_address(a).unwrap();
    let rebuilt = SuiTransfer {
        sender: addr("0x177a0f6b96e2c76703d97b39990a62106aee3bb048b5fbfa4fcfdfc671c54869"),
        recipient: addr("0x62490f4b581d9eb94ca735f4735df1a7b8868dcb01d2e2f531a76643b79382de"),
        amount: SuiTransferAmount::Mist(2_076_000),
        gas_payment: vec![SuiObjectRef {
            object_id: addr("0x59f2a4b338a7db8c202ff84f8314cbb5fa4665fbec0cf880c102e8db564bce73"),
            version: 0x2894_904b,
            digest: hex::decode("2bb0fec6cc85f926595496a7e3dd0e2761dbe6c009d228a72ed1d307bd9de842")
                .unwrap()
                .try_into()
                .unwrap(),
        }],
        gas_price: 100,
        gas_budget: 2_076_000,
        expiration_epoch: None,
        coins: vec![],
    };
    assert_eq!(b64(&rebuilt.encode().unwrap()), MAINNET[0].1);
    let s = sui_decode_tx(MAINNET[0].1, &sui_address_string(&rebuilt.sender)).unwrap();
    assert_eq!(s.amount.as_deref(), Some("2076000"));
    assert_eq!(s.gas_price, "100");
    assert_eq!(s.gas_budget, "2076000");
    assert_eq!(
        s.recipient,
        "0x62490f4b581d9eb94ca735f4735df1a7b8868dcb01d2e2f531a76643b79382de"
    );
    let g = &s.gas_coins[0];
    assert_eq!(
        SuiObjectRef::parse(&g.object_id, g.version.parse().unwrap(), &g.digest).unwrap(),
        rebuilt.gas_payment[0]
    );
}

fn ours_transfer(amount: SuiTransferAmount) -> (Seed, SuiTransfer) {
    let s = seed(KEYTOOL_MNEMONICS[0].0);
    let me = sui_parse_address(&sui_address(&s, 0).unwrap()).unwrap();
    let t = SuiTransfer {
        sender: me,
        recipient: sui_parse_address(KEYTOOL_MNEMONICS[1].1).unwrap(),
        amount,
        gas_payment: vec![
            SuiObjectRef {
                object_id: [7u8; 32],
                version: 42,
                digest: [9u8; 32],
            },
            SuiObjectRef {
                object_id: [8u8; 32],
                version: 43,
                digest: [10u8; 32],
            },
        ],
        gas_price: 1000,
        gas_budget: 5_000_000,
        expiration_epoch: Some(1271),
        coins: vec![],
    };
    (s, t)
}

#[test]
fn sign_round_trip_and_send_all() {
    for amount in [SuiTransferAmount::Mist(123_456_789), SuiTransferAmount::All] {
        let (s, t) = ours_transfer(amount);
        let bcs = b64(&t.encode().unwrap());
        let (sig, summary) = sui_sign(&s, 0, &bcs).unwrap();
        let raw = unb64(&sig);
        assert_eq!(raw.len(), 97);
        assert_eq!(raw[0], 0);
        assert_eq!(&raw[65..], &sui_public_key(&s, 0).unwrap());
        assert_eq!(sui_verify_signed(&bcs, &sig).unwrap(), summary.digest);
        assert_eq!(summary.expiration_epoch, Some(1271));
        match amount {
            SuiTransferAmount::Mist(_) => {
                assert_eq!(summary.amount.as_deref(), Some("123456789"));
                assert!(summary.warnings.is_empty());
                assert!(!summary.requires_extra_confirmation);
            }
            SuiTransferAmount::All => {
                assert_eq!(summary.amount, None);
                assert_eq!(summary.warnings, vec![SuiWarning::SendAll]);
            }
        }
        assert!(sui_sign(&s, 1, &bcs).is_err());
        let mut forged = raw.clone();
        forged[10] ^= 1;
        assert!(sui_verify_signed(&bcs, &b64(&forged)).is_err());
        let other = seed(KEYTOOL_MNEMONICS[1].0);
        let mut t2 = t.clone();
        t2.sender = sui_parse_address(KEYTOOL_MNEMONICS[1].1).unwrap();
        t2.recipient = t.sender;
        let (sig2, _) = sui_sign(&other, 0, &b64(&t2.encode().unwrap())).unwrap();
        assert!(sui_verify_signed(&bcs, &sig2).is_err());
    }
    let (s, mut t) = ours_transfer(SuiTransferAmount::Mist(1));
    t.recipient = t.sender;
    t.gas_budget = 200_000_000;
    let (_, summary) = sui_sign(&s, 0, &b64(&t.encode().unwrap())).unwrap();
    assert_eq!(
        summary.warnings,
        vec![SuiWarning::SelfTransfer, SuiWarning::HighGasBudget]
    );
}

type Mutation = Box<dyn Fn(&mut SuiTransfer)>;

#[test]
fn everything_else_is_refused() {
    let (_, t) = ours_transfer(SuiTransferAmount::Mist(5));
    let good = t.encode().unwrap();
    let me = sui_address_string(&t.sender);
    assert!(sui_decode_tx(&b64(&good), &me).is_ok());
    let refused = |bytes: &[u8], why: &str| {
        assert!(sui_decode_tx(&b64(bytes), &me).is_err(), "{why}");
    };
    let mut v = good.clone();
    v.push(0);
    refused(&v, "trailing byte");
    refused(&good[..good.len() - 1], "truncated");
    let mut v = good.clone();
    v[0] = 1;
    refused(&v, "V2");
    let mut v = good.clone();
    v[1] = 1;
    refused(&v, "not a PTB");
    let mut v = good.clone();
    v[3] = 1;
    refused(&v, "object input");
    let hexs = hex::encode(&good);
    let alt = hexs.replacen("0101030000000001", "010102000001", 1);
    assert_ne!(alt, hexs);
    refused(&hex::decode(alt).unwrap(), "Result(0)");
    let pos = hexs.find("02000101000001").unwrap() / 2;
    let mut v = good.clone();
    v[pos] = 0;
    refused(&v, "MoveCall");
    let owner_at = good.len() - 9 - 8 - 8 - 32;
    let mut v = good.clone();
    v[owner_at] ^= 1;
    refused(&v, "sponsored");
    let mut v = good.clone();
    let exp_at = good.len() - 9;
    v[exp_at] = 2;
    refused(&v, "ValidDuring");
    let cases: Vec<(Mutation, &str)> = vec![
        (Box::new(|t| t.gas_payment.clear()), "no gas coin"),
        (
            Box::new(|t| t.gas_payment[1].object_id = t.gas_payment[0].object_id),
            "duplicate gas coin",
        ),
        (Box::new(|t| t.gas_price = 0), "gas price 0"),
        (Box::new(|t| t.gas_budget = 0), "budget 0"),
        (
            Box::new(|t| t.amount = SuiTransferAmount::Mist(0)),
            "amount 0",
        ),
    ];
    for (f, why) in cases {
        let mut x = t.clone();
        f(&mut x);
        assert!(x.encode().is_err(), "{why}");
    }
    assert!(sui_decode_tx("@@", &me).is_err());
}

#[test]
fn hardware_wallet_message_and_signature() {
    let (s, t) = ours_transfer(SuiTransferAmount::Mist(1));
    let bytes = t.encode().unwrap();
    let bcs = b64(&bytes);
    let msg = wallet_core::sui_hw_message(&bcs).unwrap();
    assert_eq!(&msg[..3], &[0, 0, 0]);
    assert_eq!(&msg[3..], bytes.as_slice());
    let (sig, _) = sui_sign(&s, 0, &bcs).unwrap();
    let raw = unb64(&sig);
    let pk: [u8; 32] = raw[65..].try_into().unwrap();
    assert_eq!(
        wallet_core::sui_hw_signature(&bcs, &pk, &raw[1..65]).unwrap(),
        sig
    );
    let mut bad = raw[1..65].to_vec();
    bad[0] ^= 1;
    assert!(wallet_core::sui_hw_signature(&bcs, &pk, &bad).is_err());
    assert!(wallet_core::sui_hw_signature(&bcs, &pk, &raw[1..64]).is_err());
    let other = wallet_core::sui_public_key(&s, 1).unwrap();
    assert!(wallet_core::sui_hw_signature(&bcs, &other, &raw[1..65]).is_err());
}

const USDC_MAINNET: &str =
    "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";

fn token_transfer(n: u8, amount: SuiTransferAmount) -> (Seed, SuiTransfer) {
    let (s, mut t) = ours_transfer(amount);
    t.coins = (0..n)
        .map(|i| SuiObjectRef {
            object_id: [0x20 + i; 32],
            version: 500 + u64::from(i),
            digest: [0x40 + i; 32],
        })
        .collect();
    (s, t)
}

#[test]
fn token_transfers_layout_sign_and_refusals() {
    use wallet_core::{sui_decode_coin_tx, sui_known_coin, sui_known_coins, sui_sign_coin};
    assert_eq!(sui_known_coins(false).len(), 1);
    assert_eq!(sui_known_coin(USDC_MAINNET, false).unwrap().decimals, 6);
    assert!(sui_known_coin(USDC_MAINNET, true).is_none());
    let (s, t) = token_transfer(1, SuiTransferAmount::Mist(1_500_000));
    let raw = t.encode().unwrap();
    let h = hex::encode(&raw);
    let coin = format!(
        "0100{}{}20{}",
        "20".repeat(32),
        hex::encode(500u64.to_le_bytes()),
        "40".repeat(32)
    );
    assert!(
        h.starts_with(&format!(
            "000003{coin}0008{}0020",
            hex::encode(1_500_000u64.to_le_bytes())
        )),
        "{h}"
    );
    assert!(h.contains("02020100000101010001010300000000010200"), "{h}");
    assert_eq!(SuiTransfer::decode(&raw).unwrap(), t);
    let bcs = b64(&raw);
    let me = sui_address_string(&t.sender);
    assert!(sui_decode_tx(&bcs, &me).is_err());
    assert!(sui_decode_coin_tx(&bcs, &me, "0x2::sui::SUI", false).is_err());
    assert!(sui_decode_coin_tx(&bcs, &me, USDC_MAINNET, true).is_err());
    let d = sui_decode_coin_tx(&bcs, &me, USDC_MAINNET, false).unwrap();
    assert_eq!(d.coin_type, USDC_MAINNET);
    assert_eq!(d.amount.as_deref(), Some("1500000"));
    let tok = d.token.clone().unwrap();
    assert_eq!(
        (tok.symbol.as_str(), tok.decimals, tok.coins.len()),
        ("USDC", 6, 1)
    );
    let (sig, again) = sui_sign_coin(&s, 0, &bcs, USDC_MAINNET, false).unwrap();
    assert_eq!(again, d);
    assert_eq!(sui_verify_signed(&bcs, &sig).unwrap(), d.digest);
    let (_, plain) = ours_transfer(SuiTransferAmount::Mist(5));
    assert!(sui_decode_coin_tx(&b64(&plain.encode().unwrap()), &me, USDC_MAINNET, false).is_err());
    let (_, t3) = token_transfer(3, SuiTransferAmount::Mist(7));
    let raw3 = t3.encode().unwrap();
    let h3 = hex::encode(&raw3);
    assert!(
        h3.contains("030301000002010100010200020100000101030001010301000000010400"),
        "{h3}"
    );
    assert_eq!(SuiTransfer::decode(&raw3).unwrap(), t3);
    let (_, ta) = token_transfer(2, SuiTransferAmount::All);
    let rawa = ta.encode().unwrap();
    assert!(
        hex::encode(&rawa).contains("0203010000010101000101010000010200"),
        "{}",
        hex::encode(&rawa)
    );
    let da = sui_decode_coin_tx(&b64(&rawa), &me, USDC_MAINNET, false).unwrap();
    assert_eq!(da.amount, None);
    assert_eq!(da.warnings, vec![SuiWarning::SendAll]);
    let mut x = t3.clone();
    x.coins[1].object_id = x.gas_payment[0].object_id;
    assert!(x.encode().is_err());
    let mut x = t3.clone();
    x.coins[2].object_id = x.coins[0].object_id;
    assert!(x.encode().is_err());
    let (_, x) = token_transfer(33, SuiTransferAmount::Mist(1));
    assert!(x.encode().is_err());
    let mut v = raw.clone();
    v[4] = 1;
    assert!(SuiTransfer::decode(&v).is_err());
}
