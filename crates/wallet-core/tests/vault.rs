//! Vault: Argon2id + XChaCha20-Poly1305, tamper detection.

mod common;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use common::ABANDON;
use wallet_core::{open, seal, Error, KdfParams, Mnemonic, Seed, VaultFile, WordCount};

const PW: &str = "correct horse battery staple";

fn sealed() -> VaultFile {
    seal(
        &Mnemonic::parse(ABANDON).unwrap(),
        PW,
        KdfParams::insecure_for_tests(),
    )
    .unwrap()
}

fn flip_b64(s: &str, idx: usize) -> String {
    let mut bytes = B64.decode(s).unwrap();
    bytes[idx] ^= 0x01;
    B64.encode(bytes)
}

#[test]
fn roundtrip() {
    let m = Mnemonic::generate(WordCount::W24).unwrap();
    let file = seal(&m, PW, KdfParams::insecure_for_tests()).unwrap();
    assert_eq!(file.version, 1);
    assert_eq!(B64.decode(&file.salt).unwrap().len(), 16);
    assert_eq!(B64.decode(&file.nonce).unwrap().len(), 24);
    let opened = open(&file, PW).unwrap();
    assert!(opened == m);
    assert_eq!(opened.phrase(), m.phrase());
}

#[test]
fn ciphertext_does_not_leak_phrase_and_is_randomized() {
    let a = sealed();
    let b = sealed();
    assert_ne!(a.salt, b.salt);
    assert_ne!(a.nonce, b.nonce);
    assert_ne!(a.ciphertext, b.ciphertext);
    let json = a.to_json().unwrap();
    assert!(!json.contains("abandon"));
    let ct = B64.decode(&a.ciphertext).unwrap();
    assert!(!ct.windows(7).any(|w| w == b"abandon"));
}

#[test]
fn wrong_password() {
    assert_eq!(
        open(&sealed(), "Correct horse battery staple"),
        Err(Error::WrongPassword)
    );
    assert_eq!(open(&sealed(), ""), Err(Error::WrongPassword));
}

#[test]
fn tampered_ciphertext() {
    let mut f = sealed();
    f.ciphertext = flip_b64(&f.ciphertext, 3);
    assert_eq!(open(&f, PW), Err(Error::WrongPassword));
    // Tag byte.
    let mut f = sealed();
    let len = B64.decode(&f.ciphertext).unwrap().len();
    f.ciphertext = flip_b64(&f.ciphertext, len - 1);
    assert_eq!(open(&f, PW), Err(Error::WrongPassword));
    // Truncated.
    let mut f = sealed();
    f.ciphertext = B64.encode(&B64.decode(&f.ciphertext).unwrap()[..10]);
    assert!(matches!(open(&f, PW), Err(Error::InvalidVault(_))));
}

#[test]
fn tampered_header() {
    let mut f = sealed();
    f.salt = flip_b64(&f.salt, 0);
    assert_eq!(open(&f, PW), Err(Error::WrongPassword));

    let mut f = sealed();
    f.nonce = flip_b64(&f.nonce, 0);
    assert_eq!(open(&f, PW), Err(Error::WrongPassword));

    // KDF params are bound twice: different key AND different AAD.
    for kdf in [
        KdfParams {
            t_cost: 2,
            ..KdfParams::insecure_for_tests()
        },
        KdfParams {
            m_cost_kib: 2048,
            ..KdfParams::insecure_for_tests()
        },
        KdfParams {
            p_cost: 2,
            ..KdfParams::insecure_for_tests()
        },
    ] {
        let mut f = sealed();
        f.kdf = kdf;
        assert_eq!(open(&f, PW), Err(Error::WrongPassword), "{kdf:?}");
    }

    let mut f = sealed();
    f.version = 2;
    assert_eq!(open(&f, PW), Err(Error::UnsupportedVaultVersion(2)));

    let mut f = sealed();
    f.salt = B64.encode([0u8; 8]);
    assert!(matches!(open(&f, PW), Err(Error::InvalidVault(_))));

    let mut f = sealed();
    f.nonce = "***".into();
    assert!(matches!(open(&f, PW), Err(Error::InvalidVault(_))));

    // Absurd KDF cost is rejected before any allocation.
    let mut f = sealed();
    f.kdf.m_cost_kib = u32::MAX;
    assert!(matches!(open(&f, PW), Err(Error::InvalidVault(_))));
}

#[test]
fn json_roundtrip_and_strictness() {
    let f = sealed();
    let json = f.to_json().unwrap();
    assert!(json.contains("\"m_cost_kib\": 1024"));
    let back = VaultFile::from_json(&json).unwrap();
    assert_eq!(back, f);
    assert!(open(&back, PW).is_ok());

    let mut v: serde_json::Value = serde_json::from_str(&json).unwrap();
    v["extra"] = serde_json::json!(1);
    assert!(VaultFile::from_json(&v.to_string()).is_err());
}

#[test]
fn empty_password_rejected_on_seal() {
    let m = Mnemonic::parse(ABANDON).unwrap();
    assert!(matches!(
        seal(&m, "", KdfParams::insecure_for_tests()),
        Err(Error::InvalidInput(_))
    ));
}

#[test]
fn production_params() {
    let p = KdfParams::production();
    assert_eq!((p.m_cost_kib, p.t_cost, p.p_cost), (262_144, 3, 4));
    let t = KdfParams::insecure_for_tests();
    assert_eq!((t.m_cost_kib, t.t_cost, t.p_cost), (1024, 1, 1));
}

#[test]
fn secret_types_are_send_static() {
    fn assert_send_static<T: Send + 'static>() {}
    assert_send_static::<Mnemonic>();
    assert_send_static::<Seed>();
    assert_send_static::<VaultFile>();
    assert_send_static::<Error>();
}

/// Slow (~1 s optimised, 256 MiB): run with `cargo test --release -- --ignored`.
#[test]
#[ignore]
fn production_params_roundtrip() {
    let m = Mnemonic::parse(ABANDON).unwrap();
    let f = seal(&m, PW, KdfParams::production()).unwrap();
    assert!(open(&f, PW).unwrap() == m);
    assert_eq!(open(&f, "nope"), Err(Error::WrongPassword));
}
