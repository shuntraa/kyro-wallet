//! Aptos vectors.

mod common;

use common::{seed, ABANDON};
use wallet_core::{
    aptos_address, aptos_address_of_pubkey, aptos_decode_tx, aptos_parse_address, aptos_path,
    aptos_public_key, aptos_sign, aptos_signing_message, aptos_simulation_bytes, aptos_tx_hash,
    aptos_verify_signed, AptosTransfer, AptosWarning, Error, APTOS_MAINNET_CHAIN_ID,
};

const SHOOT: &str =
    "shoot island position soft burden budget tooth cruel issue economy destroy above";

fn b32(s: &str) -> [u8; 32] {
    hex::decode(s.trim_start_matches("0x"))
        .unwrap()
        .try_into()
        .unwrap()
}

fn b64(s: &str) -> [u8; 64] {
    hex::decode(s.trim_start_matches("0x"))
        .unwrap()
        .try_into()
        .unwrap()
}

#[test]
fn sdk_wallet_vector() {
    let s = seed(SHOOT);
    assert_eq!(aptos_path(0), "m/44'/637'/0'/0'/0'");
    assert_eq!(
        hex::encode(aptos_public_key(&s, 0).unwrap()),
        "ea526ba1710343d953461ff68641f1b7df5f23b9042ffa2d2a798d3adb3f3d6c"
    );
    assert_eq!(
        aptos_address(&s, 0).unwrap(),
        "0x07968dab936c1bad187c60ce4082f307d030d780e91e694ae03aef16aba73f30"
    );
}

#[test]
fn sdk_ed25519_auth_key_vector() {
    assert_eq!(
        aptos_address_of_pubkey(&b32(
            "de19e5d1880cac87d57484ce9ed2e84cf0f9599f12e7cc3a52e4e7657a763f2c"
        ))
        .unwrap(),
        "0x978c213990c4833df71548df7ce49d54c759d6b6d932de22b24d56060b7af2aa"
    );
    assert!(aptos_address_of_pubkey(&[0u8; 31]).is_err());
}

#[test]
fn accounts_are_distinct_and_frozen() {
    let s = seed(ABANDON);
    assert_eq!(aptos_path(1), "m/44'/637'/1'/0'/0'");
    let a0 = aptos_address(&s, 0).unwrap();
    let a1 = aptos_address(&s, 1).unwrap();
    assert_ne!(a0, a1);
    assert_eq!(a0.len(), 66);
    assert!(aptos_address(&s, 1 << 31).is_err());
}

struct Mainnet {
    hash: &'static str,
    sender: &'static str,
    sequence: u64,
    recipient: &'static str,
    amount: u64,
    max_gas: u64,
    price: u64,
    expiration: u64,
    public_key: &'static str,
    signature: &'static str,
}

const MAINNET: [Mainnet; 2] = [
    Mainnet {
        hash: "0x059dbe353f22a406d7803b5e38b2f283d4d7275a2ca5845cd4f9db75c151cf43",
        sender: "0x19fc2203cda87b3d8e19bb90b867506bb2db30a0fb1771fd9e595c17d8de0789",
        sequence: 3908,
        recipient: "0x726c91e2852985c2a8c16f32a64c131bd2a0fd1e0aa985a1e0e6002407506ac0",
        amount: 3_459_080_000,
        max_gas: 4000,
        price: 150,
        expiration: 1_793_508_754,
        public_key: "0x74f5c7ecbe00a91fb4732f55eec4d11184fafe168a0696233cb9958164315b29",
        signature: "0x657c2c1535b5673875a9fa86426ee772b794a8d290290db2b3c8c965e22eda08a578d58cfa4333769b247cee85c33754b7722851bb56f485fd2a1a499431ba08",
    },
    Mainnet {
        hash: "0x0e58d6cca84e058c25387b8fd3e3602992d46ea0320256225f9051a467f9ec9c",
        sender: "0x966e3ee07a3403a72f44c53f457d34c7148c2c8812c8d52509f54d4a00a36c41",
        sequence: 1_577_480,
        recipient: "0x39d8646cb61f3d65fbe68948c221c09e976f5cc4c92876f3c058f4da7d87f484",
        amount: 2_200_000,
        max_gas: 20000,
        price: 100,
        expiration: 1_793_551_331,
        public_key: "0x466ca5a1cb600f73a5edc1dc36f38d12c4514a9131ee6ec9619504778bf27280",
        signature: "0x18af6b6ebb6b13175d2b516cc171e349e0f87b88eb240d60d1b6cd30ac9ece01602d4c652eb9ddb78e7d19ad28071558ac961232b8936cc12326157d5ddccd06",
    },
];

fn transfer(v: &Mainnet) -> AptosTransfer {
    AptosTransfer {
        sender: b32(v.sender),
        sequence_number: v.sequence,
        recipient: b32(v.recipient),
        amount: v.amount,
        max_gas_amount: v.max_gas,
        gas_unit_price: v.price,
        expiration_timestamp_secs: v.expiration,
        chain_id: APTOS_MAINNET_CHAIN_ID,
        token: None,
    }
}

/// Mainnet USDC transfer made with `0x1::primary_fungible_store::transfer<Metadata>` (version
/// 7857447462, fetched 2026-11-01 from api.mainnet.aptoslabs.com): rebuilt from its fields,
/// the chain's own signature verifies over Kyro's bytes and the hash is the network's.
#[test]
fn mainnet_usdc_transfer_rebuilt_byte_for_byte() {
    use wallet_core::{aptos_known_assets, APTOS_FA_TRANSFER_FUNCTION};
    let usdc = b32("0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b");
    let t = AptosTransfer {
        sender: b32("0xd5a7f1beac3d8f95f9593c401897f62be2eb01c35b5a353a2522f1fd97f716ee"),
        sequence_number: 19,
        recipient: b32("0xa044357a441c87a85c5887ddfeb0428a8a25ab2a789b23a2b472b6c6c385d228"),
        amount: 109_548_000,
        max_gas_amount: 11_000,
        gas_unit_price: 100,
        expiration_timestamp_secs: 1_793_558_821,
        chain_id: APTOS_MAINNET_CHAIN_ID,
        token: Some(usdc),
    };
    let raw = t.encode().unwrap();
    assert_eq!(AptosTransfer::decode(&raw).unwrap(), t);
    let pk: [u8; 32] =
        hex::decode("cf85b55932b0aefd39bf6dc2b7d268e250108e63a8f7a5b924de0236f62eaa1f")
            .unwrap()
            .try_into()
            .unwrap();
    let sig: [u8; 64] = hex::decode("bcd075442ddbe4ef4f91fabe4223a0649fbaa46dc6fc3691db6747f8dee033a3852bf1ce93c4bb9596bd17eb0fb5b65ad33c62ff6eac629c5356c0a87fc7360e").unwrap().try_into().unwrap();
    let signed = t.signed_bytes(&pk, &sig).unwrap();
    assert_eq!(
        aptos_tx_hash(&signed),
        "0xe12c3bd68aec8267431c87059f4eb516a880bb22689e451f7efdd20d0ca75663"
    );
    let (hash, back) = aptos_verify_signed(&hex::encode(&signed)).unwrap();
    assert_eq!(
        (hash.as_str(), back),
        (
            "0xe12c3bd68aec8267431c87059f4eb516a880bb22689e451f7efdd20d0ca75663",
            t
        )
    );
    let s = aptos_decode_tx(
        &hex::encode(&raw),
        "0xd5a7f1beac3d8f95f9593c401897f62be2eb01c35b5a353a2522f1fd97f716ee",
    )
    .unwrap();
    assert_eq!(s.function, APTOS_FA_TRANSFER_FUNCTION);
    assert_eq!(s.amount, "109548000");
    let k = s.token.unwrap();
    assert_eq!(
        (k.symbol.as_str(), k.decimals, k.metadata.as_str()),
        ("USDC", 6, aptos_known_assets(1)[0].metadata)
    );
    let mut x = t;
    x.chain_id = 2;
    assert!(x.encode().is_err());
    let mut y = t;
    y.token = Some([0x42; 32]);
    assert!(y.encode().is_err());
    let mut forged = raw.clone();
    let at = hex::encode(&raw).find(&hex::encode(usdc)).unwrap() / 2;
    forged[at] ^= 1;
    assert!(AptosTransfer::decode(&forged).is_err());
    assert_eq!(aptos_known_assets(1)[1].symbol, "USDT");
    assert_eq!(aptos_known_assets(2).len(), 1);
}

#[test]
fn mainnet_transfers_rebuilt_byte_for_byte() {
    for v in &MAINNET {
        let t = transfer(v);
        let raw = t.encode().unwrap();
        assert_eq!(
            aptos_address_of_pubkey(&b32(v.public_key)).unwrap(),
            v.sender
        );
        let pk = ed25519_dalek::VerifyingKey::from_bytes(&b32(v.public_key)).unwrap();
        pk.verify_strict(
            &aptos_signing_message(&raw),
            &ed25519_dalek::Signature::from_bytes(&b64(v.signature)),
        )
        .expect("chain signature verifies on Kyro's bytes");
        let signed = t
            .signed_bytes(&b32(v.public_key), &b64(v.signature))
            .unwrap();
        assert_eq!(aptos_tx_hash(&signed), v.hash);
        let (hash, back) = aptos_verify_signed(&hex::encode(&signed)).unwrap();
        assert_eq!(hash, v.hash);
        assert_eq!(back, t);
        assert_eq!(AptosTransfer::decode(&raw).unwrap(), t);
        let s = aptos_decode_tx(&hex::encode(&raw), v.sender).unwrap();
        assert_eq!(s.recipient, v.recipient);
        assert_eq!(s.amount, v.amount.to_string());
        assert_eq!(s.sequence_number, v.sequence.to_string());
        assert_eq!(s.max_fee, (v.max_gas * v.price).to_string());
        assert_eq!(s.chain_id, 1);
        assert_eq!(s.function, "0x1::aptos_account::transfer");
        assert!(aptos_decode_tx(&hex::encode(&raw), v.recipient).is_err());
        let mut bad_sig = b64(v.signature);
        bad_sig[0] ^= 1;
        let tampered = t.signed_bytes(&b32(v.public_key), &bad_sig).unwrap();
        assert!(aptos_verify_signed(&hex::encode(tampered)).is_err());
    }
    let raw = transfer(&MAINNET[0]).encode().unwrap();
    assert_eq!(
        hex::encode(&raw),
        concat!(
            "19fc2203cda87b3d8e19bb90b867506bb2db30a0fb1771fd9e595c17d8de0789",
            "440f000000000000",
            "02",
            "0000000000000000000000000000000000000000000000000000000000000001",
            "0d6170746f735f6163636f756e74",
            "087472616e73666572",
            "00",
            "02",
            "20726c91e2852985c2a8c16f32a64c131bd2a0fd1e0aa985a1e0e6002407506ac0",
            "08405f2dce00000000",
            "a00f000000000000",
            "9600000000000000",
            "92c5e66a00000000",
            "01"
        )
    );
}

#[test]
fn sign_round_trip_and_warnings() {
    let s = seed(ABANDON);
    let me = aptos_address(&s, 0).unwrap();
    let to = aptos_address(&s, 1).unwrap();
    let t = AptosTransfer {
        sender: aptos_parse_address(&me).unwrap(),
        sequence_number: 0,
        recipient: aptos_parse_address(&to).unwrap(),
        amount: 10_000_000,
        max_gas_amount: 2000,
        gas_unit_price: 100,
        expiration_timestamp_secs: 1_900_000_000,
        chain_id: 2,
        token: None,
    };
    let raw = hex::encode(t.encode().unwrap());
    let preview = aptos_decode_tx(&raw, &me).unwrap();
    assert!(!preview.requires_extra_confirmation);
    let (signed, hash, summary) = aptos_sign(&s, 0, &raw).unwrap();
    assert_eq!(summary, preview);
    let (h2, back) = aptos_verify_signed(&signed).unwrap();
    assert_eq!(h2, hash);
    assert_eq!(back, t);
    assert!(matches!(
        aptos_sign(&s, 1, &raw),
        Err(Error::InvalidInput(_))
    ));
    let pk = aptos_public_key(&s, 0).unwrap();
    let sim = aptos_simulation_bytes(&raw, &pk).unwrap();
    assert!(sim.ends_with(&[0u8; 64]));
    assert!(aptos_verify_signed(&hex::encode(&sim)).is_err());

    let mut odd = t;
    odd.recipient = odd.sender;
    odd.max_gas_amount = 200_000;
    let s2 = aptos_decode_tx(&hex::encode(odd.encode().unwrap()), &me).unwrap();
    assert_eq!(
        s2.warnings,
        vec![AptosWarning::SelfTransfer, AptosWarning::HighFee]
    );
    assert!(s2.requires_extra_confirmation);
}

#[test]
fn anything_else_is_refused() {
    let t = transfer(&MAINNET[0]);
    let raw = t.encode().unwrap();
    let refused = |b: &[u8]| AptosTransfer::decode(b).is_err();
    let mut x = raw.clone();
    x.push(0);
    assert!(refused(&x));
    assert!(refused(&raw[..raw.len() - 1]));
    for v in [0u8, 1, 3, 4, 5] {
        let mut x = raw.clone();
        x[40] = v;
        assert!(refused(&x), "payload variant {v}");
    }
    let mut x = raw.clone();
    x[41 + 31] = 3;
    assert!(refused(&x));
    let mut x = raw.clone();
    x[41 + 32 + 1] = b'b'; // "bptos_account"
    assert!(refused(&x));
    let t2: Vec<u8> = {
        let mut x = raw.clone();
        let at = 41 + 32 + 14 + 9;
        x[at] = 1;
        x
    };
    assert!(refused(&t2));
    let at = raw.len() - 34;
    assert_eq!(raw[at], 8);
    let mut x = raw[..at].to_vec();
    x.extend_from_slice(&[0x88, 0x00]);
    x.extend_from_slice(&raw[at + 1..]);
    assert!(refused(&x));
    for f in [
        |t: &mut AptosTransfer| t.amount = 0,
        |t: &mut AptosTransfer| t.max_gas_amount = 0,
        |t: &mut AptosTransfer| t.gas_unit_price = 0,
        |t: &mut AptosTransfer| t.chain_id = 0,
    ] {
        let mut z = t;
        f(&mut z);
        assert!(z.encode().is_err());
    }
    let mut signed = t
        .signed_bytes(&b32(MAINNET[0].public_key), &b64(MAINNET[0].signature))
        .unwrap();
    let auth = signed.len() - 99;
    signed[auth] = 1;
    assert!(aptos_verify_signed(&hex::encode(&signed)).is_err());
    assert!(aptos_decode_tx("zz", MAINNET[0].sender).is_err());
}

#[test]
fn hardware_wallet_message_and_signature() {
    let s = seed(ABANDON);
    let me = aptos_address(&s, 0).unwrap();
    let to = aptos_address(&s, 1).unwrap();
    let t = AptosTransfer {
        sender: aptos_parse_address(&me).unwrap(),
        sequence_number: 4,
        recipient: aptos_parse_address(&to).unwrap(),
        amount: 1,
        max_gas_amount: 2000,
        gas_unit_price: 100,
        expiration_timestamp_secs: 1_900_000_000,
        chain_id: 2,
        token: None,
    };
    let bytes = t.encode().unwrap();
    let raw = hex::encode(&bytes);
    let msg = wallet_core::aptos_hw_message(&raw).unwrap();
    assert_eq!(msg, wallet_core::aptos_signing_message(&bytes));
    let (signed, hash, _) = aptos_sign(&s, 0, &raw).unwrap();
    let sb = hex::decode(&signed).unwrap();
    let sig = &sb[sb.len() - 64..];
    let pk = wallet_core::aptos_public_key(&s, 0).unwrap();
    assert_eq!(
        wallet_core::aptos_hw_signed(&raw, &pk, sig).unwrap(),
        (signed, hash)
    );
    let other = wallet_core::aptos_public_key(&s, 1).unwrap();
    assert!(wallet_core::aptos_hw_signed(&raw, &other, sig).is_err());
    assert!(wallet_core::aptos_hw_signed(&raw, &pk, &sig[1..]).is_err());
}
