//! Error type. Messages never contain secret material.

/// Result alias used throughout the crate.
pub type Result<T> = core::result::Result<T, Error>;

/// Every failure the core can report.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[non_exhaustive]
pub enum Error {
    /// The phrase is not a valid English BIP39 mnemonic (unknown word, bad length or checksum).
    #[error("invalid recovery phrase")]
    InvalidMnemonic,
    /// The vault could not be decrypted: wrong password, or the file was tampered with.
    #[error("wrong password")]
    WrongPassword,
    /// The vault file declares a format version this build does not understand.
    #[error("unsupported vault version {0}")]
    UnsupportedVaultVersion(u8),
    /// The vault file is structurally invalid (bad base64, wrong lengths, out-of-range KDF params).
    #[error("invalid vault file: {0}")]
    InvalidVault(String),
    /// A caller-supplied value is malformed (address, amount, index, hex, ...).
    #[error("invalid input: {0}")]
    InvalidInput(String),
    /// The PSBT is malformed or cannot be signed/decoded safely.
    #[error("invalid PSBT: {0}")]
    Psbt(String),
    /// A cryptographic primitive failed unexpectedly (RNG, KDF, derivation, signing).
    #[error("cryptographic failure: {0}")]
    Crypto(String),
    /// Something a hardware wallet returned was rejected by an independent check (signature
    /// that does not verify, unexpected key or input, malformed data).
    #[error("hardware wallet response rejected: {0}")]
    Device(String),
}

impl Error {
    /// Stable machine-readable code, matching the IPC error codes of `docs/IPC.md` §2.
    pub fn code(&self) -> &'static str {
        match self {
            Error::WrongPassword => "WRONG_PASSWORD",
            Error::InvalidMnemonic | Error::InvalidInput(_) | Error::Psbt(_) => "INVALID_INPUT",
            Error::UnsupportedVaultVersion(_) | Error::InvalidVault(_) | Error::Crypto(_) => {
                "INTERNAL"
            }
            Error::Device(_) => "HW_BAD_RESPONSE",
        }
    }

    pub(crate) fn input(msg: impl Into<String>) -> Self {
        Error::InvalidInput(msg.into())
    }

    pub(crate) fn psbt(msg: impl Into<String>) -> Self {
        Error::Psbt(msg.into())
    }

    pub(crate) fn crypto(msg: impl Into<String>) -> Self {
        Error::Crypto(msg.into())
    }
}
