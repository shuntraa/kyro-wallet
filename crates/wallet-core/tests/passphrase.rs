//! BIP39 passphrase (the « 25th word »): standard derivation on every chain, and wallets without
//! one stay as they were, byte for byte.

use wallet_core::{
    btc_address, cardano_address, dot_address, evm_address, open, seal, seal_secret, sol_address,
    xmr_seed_words, BtcKind, KdfParams, Mnemonic, Network, VaultFile, WalletSecret, Zeroizing,
    MAX_PASSPHRASE_CHARS,
};

const ABANDON: &str =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
/// `trezor/python-mnemonic` `vectors.json`, first entry (passphrase "TREZOR").
const SEED_TREZOR: &str = "c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e53495531f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04";
/// Same phrase, no passphrase (BIP84's reference seed).
const SEED_PLAIN: &str = "5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc19a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4";

fn phrase() -> Mnemonic {
    Mnemonic::parse(ABANDON).unwrap()
}

fn with(passphrase: &str) -> WalletSecret {
    WalletSecret::new(phrase(), Zeroizing::new(passphrase.to_owned())).unwrap()
}

#[test]
fn seed_follows_the_bip39_vectors_with_and_without_passphrase() {
    assert_eq!(hex::encode(&with("TREZOR").seed()[..]), SEED_TREZOR);
    assert_eq!(hex::encode(&with("").seed()[..]), SEED_PLAIN);
    assert_eq!(
        hex::encode(&WalletSecret::plain(phrase()).seed()[..]),
        SEED_PLAIN
    );
}

#[test]
fn without_passphrase_every_derivation_is_what_it_was() {
    let m = phrase();
    let secret = WalletSecret::plain(phrase());
    assert_eq!(&secret.seed()[..], &m.to_seed("")[..]);
    assert_eq!(
        secret.cardano_root().to_hex_for_tests(),
        wallet_core::CardanoRoot::from_mnemonic(&m, "").to_hex_for_tests()
    );
    assert_eq!(
        secret.polkadot_root().unwrap().to_hex_for_tests(),
        wallet_core::PolkadotRoot::from_mnemonic(&m, "")
            .unwrap()
            .to_hex_for_tests()
    );
    // BIP84's first address of this phrase.
    assert_eq!(
        btc_address(
            &secret.seed(),
            Network::Mainnet,
            BtcKind::Segwit,
            0,
            false,
            0
        )
        .unwrap(),
        "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu"
    );
}

/// Chains that derive from the entropy (Cardano, Polkadot) must not ignore it either.
#[test]
fn a_passphrase_changes_the_keys_of_every_derivation_family() {
    let plain = with("");
    let other = with("TREZOR");
    let (a, b) = (plain.seed(), other.seed());
    assert_ne!(
        btc_address(&a, Network::Mainnet, BtcKind::Segwit, 0, false, 0).unwrap(),
        btc_address(&b, Network::Mainnet, BtcKind::Segwit, 0, false, 0).unwrap()
    );
    assert_ne!(evm_address(&a, 0).unwrap(), evm_address(&b, 0).unwrap());
    assert_ne!(sol_address(&a, 0).unwrap(), sol_address(&b, 0).unwrap());
    assert_ne!(
        xmr_seed_words(&a, 0).unwrap().join(" "),
        xmr_seed_words(&b, 0).unwrap().join(" ")
    );
    assert_ne!(
        cardano_address(&plain.cardano_root(), Network::Mainnet, 0, 0).unwrap(),
        cardano_address(&other.cardano_root(), Network::Mainnet, 0, 0).unwrap()
    );
    assert_ne!(
        dot_address(&plain.polkadot_root().unwrap(), 0, Network::Mainnet).unwrap(),
        dot_address(&other.polkadot_root().unwrap(), 0, Network::Mainnet).unwrap()
    );
}

/// « é » typed as one or two code points is the same passphrase, on every chain.
#[test]
fn passphrases_are_normalised_on_every_derivation_family() {
    let composed = with("caf\u{e9}");
    let decomposed = with("cafe\u{301}");
    assert_ne!(composed.passphrase(), decomposed.passphrase());
    assert_eq!(&composed.seed()[..], &decomposed.seed()[..]);
    assert_eq!(
        composed.cardano_root().to_hex_for_tests(),
        decomposed.cardano_root().to_hex_for_tests()
    );
    assert_eq!(
        composed.polkadot_root().unwrap().to_hex_for_tests(),
        decomposed.polkadot_root().unwrap().to_hex_for_tests()
    );
}

#[test]
fn spaces_count() {
    assert_ne!(&with("word").seed()[..], &with("word ").seed()[..]);
    assert_eq!(with(" word ").passphrase(), " word ");
}

#[test]
fn control_characters_and_oversized_passphrases_are_refused() {
    let new = |p: String| WalletSecret::new(phrase(), Zeroizing::new(p));
    assert!(new("line\nbreak".into()).is_err());
    assert!(new("nul\0".into()).is_err());
    assert!(new("é".repeat(MAX_PASSPHRASE_CHARS)).is_ok());
    assert!(new("é".repeat(MAX_PASSPHRASE_CHARS + 1)).is_err());
}

#[test]
fn debug_does_not_print_it() {
    let s = format!("{:?}", with("hunter2 horse"));
    assert!(!s.contains("hunter2") && !s.contains("abandon"));
}

#[test]
fn a_vault_keeps_the_passphrase_and_needs_only_the_password() {
    for passphrase in ["TREZOR", " spaces around ", "phrase secrète 日本語"] {
        let secret = with(passphrase);
        let file = seal_secret(&secret, "pw", KdfParams::minimum()).unwrap();
        let opened = open(&file, "pw").unwrap();
        assert_eq!(opened, secret);
        assert_eq!(opened.passphrase(), passphrase);
        assert_eq!(&opened.seed()[..], &secret.seed()[..]);
        assert!(open(&file, "wrong").is_err());
    }
}

#[test]
fn the_passphrase_never_shows_in_the_vault_file() {
    let file = seal_secret(&with("findme-please"), "pw", KdfParams::minimum()).unwrap();
    assert!(!file.to_json().unwrap().contains("findme"));
}

#[test]
fn a_wallet_with_and_one_without_have_the_same_file_shape() {
    let fields = |f: &VaultFile| {
        let v: serde_json::Value = serde_json::from_str(&f.to_json().unwrap()).unwrap();
        let mut keys: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        keys
    };
    let plain = seal(&phrase(), "pw", KdfParams::minimum()).unwrap();
    let other = seal_secret(&with("x"), "pw", KdfParams::minimum()).unwrap();
    assert_eq!(fields(&plain), fields(&other));
}

/// Same length as `seal` gives for the phrase: nothing is added to a plain wallet's content.
#[test]
fn a_plain_wallet_holds_the_phrase_alone() {
    let a = seal(&phrase(), "pw", KdfParams::minimum()).unwrap();
    let b = seal_secret(&WalletSecret::plain(phrase()), "pw", KdfParams::minimum()).unwrap();
    assert_eq!(a.ciphertext.len(), b.ciphertext.len());
    assert_eq!(open(&a, "pw").unwrap(), open(&b, "pw").unwrap());
    assert!(!open(&b, "pw").unwrap().has_passphrase());
}

/// A vault written by the code from before passphrases (data/vault-before-passphrase.json).
#[test]
fn an_existing_vault_still_opens_to_the_same_keys() {
    let raw = include_str!("data/vault-before-passphrase.json");
    let file = VaultFile::from_json(raw).unwrap();
    let opened = open(&file, "kyro test password").unwrap();
    assert!(!opened.has_passphrase());
    assert_eq!(opened.phrase().as_str(), ABANDON);
    assert_eq!(hex::encode(&opened.seed()[..]), SEED_PLAIN);
    // Nothing rewrites it: reading leaves the same JSON fields.
    assert_eq!(VaultFile::from_json(raw).unwrap(), file);
}

/// What a Kyro from before passphrases does with one: it parses the content as a phrase. It must
/// fail, whatever the passphrase, rather than open a wallet without it.
#[test]
fn an_older_kyro_refuses_a_vault_with_a_passphrase() {
    // The words of a valid phrase as passphrase: split on spaces, they would still not parse,
    // because the first word carries the marker.
    let content = format!("\u{1}{ABANDON}\0{ABANDON}");
    assert!(Mnemonic::parse(&content).is_err());
}
