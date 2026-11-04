//! BIP39 mnemonics (English wordlist only), backed by the rust-bitcoin `bip39` crate.

use core::fmt;
use std::borrow::Cow;

use zeroize::{Zeroize, Zeroizing};

use crate::cardano::CardanoRoot;
use crate::error::{Error, Result};
use crate::polkadot::PolkadotRoot;

/// 64-byte BIP39 seed, wiped on drop.
pub type Seed = Zeroizing<[u8; 64]>;

/// Number of words of a newly generated mnemonic.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub enum WordCount {
    /// 12 words, 128 bits of entropy.
    W12,
    /// 24 words, 256 bits of entropy.
    W24,
}

impl WordCount {
    fn entropy_len(self) -> usize {
        match self {
            WordCount::W12 => 16,
            WordCount::W24 => 32,
        }
    }
}

/// A validated English BIP39 mnemonic.
pub struct Mnemonic(bip39::Mnemonic);

impl Mnemonic {
    /// Generates a fresh mnemonic from operating-system randomness.
    pub fn generate(words: WordCount) -> Result<Mnemonic> {
        let mut entropy = Zeroizing::new([0u8; 32]);
        let entropy = &mut entropy[..words.entropy_len()];
        getrandom::getrandom(entropy).map_err(|_| Error::crypto("OS randomness unavailable"))?;
        bip39::Mnemonic::from_entropy_in(bip39::Language::English, entropy)
            .map(Mnemonic)
            .map_err(|_| Error::crypto("recovery phrase generation failed"))
    }

    /// Parses an English BIP39 phrase.
    pub fn parse(phrase: &str) -> Result<Mnemonic> {
        let mut normalized = Zeroizing::new(String::with_capacity(phrase.len()));
        for (i, word) in phrase.split_whitespace().enumerate() {
            if i > 0 {
                normalized.push(' ');
            }
            for c in word.chars() {
                normalized.extend(c.to_lowercase());
            }
        }
        bip39::Mnemonic::parse_in_normalized(bip39::Language::English, &normalized)
            .map(Mnemonic)
            .map_err(|_| Error::InvalidMnemonic)
    }

    /// The words of the phrase, in order.
    pub fn words(&self) -> Zeroizing<Vec<String>> {
        Zeroizing::new(self.0.words().map(str::to_owned).collect())
    }

    /// The phrase as a single space-separated string.
    pub fn phrase(&self) -> Zeroizing<String> {
        Zeroizing::new(self.0.to_string())
    }

    /// Number of words.
    pub fn word_count(&self) -> usize {
        self.0.word_count()
    }

    /// BIP39 entropy (16 to 32 bytes), wiped on drop. Cardano's Icarus master key is derived
    /// from the entropy, not from the BIP39 seed.
    pub(crate) fn entropy(&self) -> Zeroizing<Vec<u8>> {
        let (mut arr, len) = self.0.to_entropy_array();
        let out = Zeroizing::new(arr[..len].to_vec());
        arr.zeroize();
        out
    }

    /// BIP39 seed (PBKDF2-HMAC-SHA512, 2048 rounds). The optional passphrase is NFKD-normalised.
    pub fn to_seed(&self, passphrase: &str) -> Seed {
        Zeroizing::new(self.0.to_seed(passphrase))
    }
}

impl Drop for Mnemonic {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

/// Longest passphrase accepted, in characters.
pub const MAX_PASSPHRASE_CHARS: usize = 256;

/// NFKD form of a passphrase, as BIP39 asks. Cardano and Polkadot derive from the entropy with
/// crates that take the bytes as given, so every chain has to go through this.
pub(crate) fn nfkd(passphrase: &str) -> Zeroizing<String> {
    let mut cow = Cow::Borrowed(passphrase);
    bip39::Mnemonic::normalize_utf8_cow(&mut cow);
    Zeroizing::new(cow.into_owned())
}

/// What a vault holds: the phrase and, optionally, its BIP39 passphrase (the « 25th word »). Every
/// key of a wallet comes from here, so a passphrase cannot be forgotten on one chain.
pub struct WalletSecret {
    mnemonic: Mnemonic,
    /// Empty: no passphrase. As the user typed it; [`nfkd`] applies at derivation.
    passphrase: Zeroizing<String>,
}

impl WalletSecret {
    /// A wallet without passphrase.
    pub fn plain(mnemonic: Mnemonic) -> WalletSecret {
        WalletSecret {
            mnemonic,
            passphrase: Zeroizing::new(String::new()),
        }
    }

    /// A wallet with `passphrase`, kept exactly as typed: spaces count. Empty means none. Control
    /// characters are refused (a paste accident, and nothing a keyboard types).
    pub fn new(mnemonic: Mnemonic, passphrase: Zeroizing<String>) -> Result<WalletSecret> {
        if passphrase.chars().count() > MAX_PASSPHRASE_CHARS {
            return Err(Error::input("passphrase too long"));
        }
        if passphrase.chars().any(char::is_control) {
            return Err(Error::input("passphrase has a control character"));
        }
        Ok(WalletSecret {
            mnemonic,
            passphrase,
        })
    }

    /// True when the wallet has a passphrase.
    pub fn has_passphrase(&self) -> bool {
        !self.passphrase.is_empty()
    }

    /// The passphrase as typed, empty if none. For the vault and the phrase window only.
    pub fn passphrase(&self) -> &str {
        &self.passphrase
    }

    /// The words of the phrase, in order.
    pub fn words(&self) -> Zeroizing<Vec<String>> {
        self.mnemonic.words()
    }

    /// The phrase as a single space-separated string.
    pub fn phrase(&self) -> Zeroizing<String> {
        self.mnemonic.phrase()
    }

    /// BIP39 seed of the phrase and passphrase.
    pub fn seed(&self) -> Seed {
        self.mnemonic.to_seed(&self.passphrase)
    }

    /// Cardano root key (CIP-0003, the passphrase goes into its PBKDF2).
    pub fn cardano_root(&self) -> CardanoRoot {
        CardanoRoot::from_mnemonic(&self.mnemonic, &self.passphrase)
    }

    /// Polkadot mini-secret (substrate-bip39, the passphrase goes into its salt).
    pub fn polkadot_root(&self) -> Result<PolkadotRoot> {
        PolkadotRoot::from_mnemonic(&self.mnemonic, &self.passphrase)
    }
}

impl fmt::Debug for WalletSecret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "WalletSecret({:?}, <passphrase redacted>)",
            self.mnemonic
        )
    }
}

impl PartialEq for WalletSecret {
    fn eq(&self, other: &Self) -> bool {
        self.mnemonic == other.mnemonic && self.passphrase == other.passphrase
    }
}

impl Eq for WalletSecret {}

impl fmt::Debug for Mnemonic {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Mnemonic(<{} words redacted>)", self.0.word_count())
    }
}

impl PartialEq for Mnemonic {
    fn eq(&self, other: &Self) -> bool {
        self.0 == other.0
    }
}

impl Eq for Mnemonic {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generate_lengths() {
        for (wc, n) in [(WordCount::W12, 12), (WordCount::W24, 24)] {
            let m = Mnemonic::generate(wc).unwrap();
            assert_eq!(m.words().len(), n);
            // Round-trips through parse.
            assert!(Mnemonic::parse(&m.phrase()).unwrap() == m);
        }
    }

    #[test]
    fn parse_normalizes_whitespace_and_case() {
        let m = Mnemonic::parse(
            "  Abandon abandon\tabandon abandon abandon abandon\nabandon abandon abandon abandon abandon ABOUT ",
        )
        .unwrap();
        assert_eq!(
            m.phrase().as_str(),
            "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
        );
    }

    #[test]
    fn parse_rejects_bad_checksum_and_words() {
        let bad_checksum = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon";
        assert_eq!(Mnemonic::parse(bad_checksum), Err(Error::InvalidMnemonic));
        assert_eq!(Mnemonic::parse("hello world"), Err(Error::InvalidMnemonic));
        assert_eq!(Mnemonic::parse(""), Err(Error::InvalidMnemonic));
    }

    #[test]
    fn debug_is_redacted() {
        let m = Mnemonic::parse(
            "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
        )
        .unwrap();
        let s = format!("{m:?}");
        assert!(!s.contains("abandon"));
        assert!(s.contains("redacted"));
    }
}
