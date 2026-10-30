//! BIP39 mnemonics (English wordlist only), backed by the rust-bitcoin `bip39` crate.

use core::fmt;

use zeroize::{Zeroize, Zeroizing};

use crate::error::{Error, Result};

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

/// A validated English BIP39 mnemonic. Its contents are wiped on drop and never printed by
/// `Debug`. It is intentionally not `Clone`.
pub struct Mnemonic(bip39::Mnemonic);

impl Mnemonic {
    /// Generates a fresh mnemonic from operating-system randomness.
    pub fn generate(words: WordCount) -> Result<Mnemonic> {
        let mut entropy = Zeroizing::new([0u8; 32]);
        let entropy = &mut entropy[..words.entropy_len()];
        getrandom::getrandom(entropy).map_err(|_| Error::crypto("OS randomness unavailable"))?;
        bip39::Mnemonic::from_entropy_in(bip39::Language::English, entropy)
            .map(Mnemonic)
            .map_err(|_| Error::crypto("mnemonic generation failed"))
    }

    /// Parses an English BIP39 phrase. Case and whitespace are normalised (any run of
    /// whitespace becomes a single space, letters are lower-cased); the checksum is verified.
    /// Every standard length (12, 15, 18, 21, 24 words) is accepted.
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
