//! Aptos vectors.
//!
//! Sources (fetched 2026-11-01):
//! - aptos-ts-sdk `packages/ts-sdk/tests/unit/helper.ts` (`wallet`: mnemonic « shoot island … »,
//!   `m/44'/637'/0'/0'/0'`, private and public key, address; `ed25519`: public key and
//!   authentication key / address);
//! - two real mainnet APT transfers (`0x1::aptos_account::transfer`, single ed25519 signature,
//!   sender pays the gas) read from `api.mainnet.aptoslabs.com/v1/transactions/by_version/…`:
//!   versions 7851560271 and 7851558238. Kyro rebuilds the `RawTransaction` byte for byte from
//!   the JSON fields, the chain's signature verifies on Kyro's signing message, and Kyro's
//!   transaction hash equals the chain's.

mod common;

use common::{seed, ABANDON};
use wallet_core::{
    aptos_address, aptos_address_of_pubkey, aptos_decode_tx, aptos_parse_address, aptos_path,
    aptos_public_key, aptos_sign, aptos_signing_message, aptos_simulation_bytes, aptos_tx_hash,
    aptos_verify_signed, AptosTransfer, AptosWarning, Error, APTOS_MAINNET_CHAIN_ID,
};

const SHOOT: &str = "shoot island position soft burden budget tooth cruel issue economy destroy above";

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
    // Legacy single-ed25519 authentication key (Petra): `wallet.address` of the SDK. The SDK's
    // `Ed25519WalletTestObject.address` (0x28b8…) is the newer SingleKey scheme, not used here.
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
    }
}

#[test]
fn mainnet_transfers_rebuilt_byte_for_byte() {
    for v in &MAINNET {
        let t = transfer(v);
        let raw = t.encode().unwrap();
        // Address = SHA3-256(public key || 0x00).
        assert_eq!(
            aptos_address_of_pubkey(&b32(v.public_key)).unwrap(),
            v.sender
        );
        // The chain's signature verifies on our signing message.
        let pk = ed25519_dalek::VerifyingKey::from_bytes(&b32(v.public_key)).unwrap();
        pk.verify_strict(
            &aptos_signing_message(&raw),
            &ed25519_dalek::Signature::from_bytes(&b64(v.signature)),
        )
        .expect("chain signature verifies on Kyro's bytes");
        // Signed transaction and hash identical to the chain's.
        let signed = t
            .signed_bytes(&b32(v.public_key), &b64(v.signature))
            .unwrap();
        assert_eq!(aptos_tx_hash(&signed), v.hash);
        let (hash, back) = aptos_verify_signed(&hex::encode(&signed)).unwrap();
        assert_eq!(hash, v.hash);
        assert_eq!(back, t);
        // Decoding round-trips and shows what was signed.
        assert_eq!(AptosTransfer::decode(&raw).unwrap(), t);
        let s = aptos_decode_tx(&hex::encode(&raw), v.sender).unwrap();
        assert_eq!(s.recipient, v.recipient);
        assert_eq!(s.amount, v.amount.to_string());
        assert_eq!(s.sequence_number, v.sequence.to_string());
        assert_eq!(s.max_fee, (v.max_gas * v.price).to_string());
        assert_eq!(s.chain_id, 1);
        assert_eq!(s.function, "0x1::aptos_account::transfer");
        // Someone else's transaction is not shown as ours.
        assert!(aptos_decode_tx(&hex::encode(&raw), v.recipient).is_err());
        // A modified signature or a modified byte is refused.
        let mut bad_sig = b64(v.signature);
        bad_sig[0] ^= 1;
        let tampered = t.signed_bytes(&b32(v.public_key), &bad_sig).unwrap();
        assert!(aptos_verify_signed(&hex::encode(tampered)).is_err());
    }
    // Exact layout of the first one (sender, seq, payload, gas, expiration, chain id).
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
    };
    let raw = hex::encode(t.encode().unwrap());
    let preview = aptos_decode_tx(&raw, &me).unwrap();
    assert!(!preview.requires_extra_confirmation);
    let (signed, hash, summary) = aptos_sign(&s, 0, &raw).unwrap();
    assert_eq!(summary, preview);
    let (h2, back) = aptos_verify_signed(&signed).unwrap();
    assert_eq!(h2, hash);
    assert_eq!(back, t);
    // The wrong account's key refuses to sign (sender is account 0).
    assert!(matches!(aptos_sign(&s, 1, &raw), Err(Error::InvalidInput(_))));
    // Simulation body: same raw transaction, zero signature, which never verifies.
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
    // Trailing byte, truncation.
    let mut x = raw.clone();
    x.push(0);
    assert!(refused(&x));
    assert!(refused(&raw[..raw.len() - 1]));
    // Payload variants: script (0), multisig (3), inner payload / orderless (4).
    for v in [0u8, 1, 3, 4, 5] {
        let mut x = raw.clone();
        x[40] = v;
        assert!(refused(&x), "payload variant {v}");
    }
    // Another module address, module or function name.
    let mut x = raw.clone();
    x[41 + 31] = 3;
    assert!(refused(&x));
    let mut x = raw.clone();
    x[41 + 32 + 1] = b'b'; // "bptos_account"
    assert!(refused(&x));
    let t2: Vec<u8> = {
        // transfer_coins<…> has a type argument: count byte != 0.
        let mut x = raw.clone();
        let at = 41 + 32 + 14 + 9;
        x[at] = 1;
        x
    };
    assert!(refused(&t2));
    // Non-canonical ULEB length (0x88 0x00 for 8).
    let at = raw.len() - 34;
    assert_eq!(raw[at], 8);
    let mut x = raw[..at].to_vec();
    x.extend_from_slice(&[0x88, 0x00]);
    x.extend_from_slice(&raw[at + 1..]);
    assert!(refused(&x));
    // Zero amount / gas / price are refused to build and to decode.
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
    // Another authenticator (multi-ed25519 = 1, fee payer = 3…) is refused.
    let mut signed = t
        .signed_bytes(&b32(MAINNET[0].public_key), &b64(MAINNET[0].signature))
        .unwrap();
    let auth = signed.len() - 99;
    signed[auth] = 1;
    assert!(aptos_verify_signed(&hex::encode(&signed)).is_err());
    assert!(aptos_decode_tx("zz", MAINNET[0].sender).is_err());
}
