//! Sui vectors.
//!
//! Sources (fetched 2026-11-01):
//! - MystenLabs/sui `crates/sui/src/unit_tests/keytool_tests.rs`: `test_mnemonics_ed25519`
//!   (three 24-word mnemonics → address at the default `m/44'/784'/0'/0'/0'`, generated with
//!   `sui keytool`, the same cases as the TypeScript SDK's `ed25519-keypair.test.ts`) and
//!   `test_private_keys_import_export` (raw ed25519 private key → address);
//! - MystenLabs/ts-sdks `packages/sui/test/unit/cryptography/ed25519-keypair.test.ts`
//!   (secret key `0x08 × 32` → public key).

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
        // Another account is another key.
        assert_ne!(sui_address(&s, 1).unwrap(), address);
    }
}

/// `test_private_keys_import_export`: (private key hex, address).
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
    // TypeScript SDK: secret key 0x08 × 32.
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
    // Not a curve point (y = 2 has no x on edwards25519).
    let mut not_a_point = [0u8; 32];
    not_a_point[0] = 2;
    assert!(sui_address_of_pubkey(&not_a_point).is_err());
}
