//! Encrypted vault holding the recovery phrase.
//!
//! `key = Argon2id(password, salt[16], m, t, p) -> 32 bytes`, then
//! `ciphertext = XChaCha20-Poly1305(key, nonce[24], plaintext = phrase, aad)` with
//! `aad = "kyro-vault" || version || m_cost_kib (LE u32) || t_cost (LE u32) || p_cost (LE u32) || salt`.
//! Any change to the header (version, KDF parameters, salt) or to the ciphertext makes
//! decryption fail.

use argon2::{Algorithm, Argon2, Params, Version};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::error::{Error, Result};
use crate::mnemonic::Mnemonic;

/// Current (and only supported) vault format version.
pub const VAULT_VERSION: u8 = 1;

const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 24;
const KEY_LEN: usize = 32;
const TAG_LEN: usize = 16;
const AAD_DOMAIN: &[u8] = b"kyro-vault";

// Bounds accepted when opening a file, so a tampered header cannot make us allocate
// unbounded memory or spin forever before the tag check fails.
const MAX_M_COST_KIB: u32 = 1024 * 1024; // 1 GiB = 4x production
const MAX_T_COST: u32 = 64;
const MAX_P_COST: u32 = 64;

/// Argon2id cost parameters.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct KdfParams {
    /// Memory cost in KiB.
    pub m_cost_kib: u32,
    /// Number of passes.
    pub t_cost: u32,
    /// Degree of parallelism (lanes).
    pub p_cost: u32,
}

impl KdfParams {
    /// Production parameters: 256 MiB, 3 passes, 4 lanes.
    pub fn production() -> Self {
        KdfParams {
            m_cost_kib: 262_144,
            t_cost: 3,
            p_cost: 4,
        }
    }

    /// Very weak parameters for unit tests only (1 MiB, 1 pass, 1 lane). Never use in the app.
    pub fn insecure_for_tests() -> Self {
        KdfParams {
            m_cost_kib: 1024,
            t_cost: 1,
            p_cost: 1,
        }
    }

    fn argon2(&self) -> Result<Argon2<'static>> {
        if self.m_cost_kib > MAX_M_COST_KIB
            || self.t_cost == 0
            || self.t_cost > MAX_T_COST
            || self.p_cost == 0
            || self.p_cost > MAX_P_COST
        {
            return Err(Error::InvalidVault("KDF parameters out of range".into()));
        }
        let params = Params::new(self.m_cost_kib, self.t_cost, self.p_cost, Some(KEY_LEN))
            .map_err(|_| Error::InvalidVault("KDF parameters out of range".into()))?;
        Ok(Argon2::new(Algorithm::Argon2id, Version::V0x13, params))
    }

    fn derive_key(&self, password: &str, salt: &[u8]) -> Result<Zeroizing<[u8; KEY_LEN]>> {
        let mut key = Zeroizing::new([0u8; KEY_LEN]);
        self.argon2()?
            .hash_password_into(password.as_bytes(), salt, &mut key[..])
            .map_err(|_| Error::crypto("Argon2id failed"))?;
        Ok(key)
    }
}

impl Default for KdfParams {
    fn default() -> Self {
        Self::production()
    }
}

/// On-disk vault representation (serialise with serde, e.g. JSON). Binary fields are
/// standard base64 with padding. Contains no plaintext secret.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VaultFile {
    /// Format version, see [`VAULT_VERSION`].
    pub version: u8,
    /// Argon2id parameters used to derive the key.
    pub kdf: KdfParams,
    /// Base64 16-byte Argon2 salt.
    pub salt: String,
    /// Base64 24-byte XChaCha20-Poly1305 nonce.
    pub nonce: String,
    /// Base64 ciphertext followed by the 16-byte Poly1305 tag.
    pub ciphertext: String,
}

impl VaultFile {
    /// Serialises to pretty JSON.
    pub fn to_json(&self) -> Result<String> {
        serde_json::to_string_pretty(self).map_err(|_| Error::InvalidVault("serialisation".into()))
    }

    /// Parses JSON produced by [`VaultFile::to_json`]. Unknown fields are rejected.
    pub fn from_json(json: &str) -> Result<Self> {
        serde_json::from_str(json).map_err(|_| Error::InvalidVault("malformed JSON".into()))
    }
}

fn aad(version: u8, kdf: &KdfParams, salt: &[u8]) -> Vec<u8> {
    let mut aad = Vec::with_capacity(AAD_DOMAIN.len() + 1 + 12 + salt.len());
    aad.extend_from_slice(AAD_DOMAIN);
    aad.push(version);
    aad.extend_from_slice(&kdf.m_cost_kib.to_le_bytes());
    aad.extend_from_slice(&kdf.t_cost.to_le_bytes());
    aad.extend_from_slice(&kdf.p_cost.to_le_bytes());
    aad.extend_from_slice(salt);
    aad
}

fn random<const N: usize>() -> Result<[u8; N]> {
    let mut out = [0u8; N];
    getrandom::getrandom(&mut out).map_err(|_| Error::crypto("OS randomness unavailable"))?;
    Ok(out)
}

fn b64_fixed<const N: usize>(field: &str, s: &str) -> Result<[u8; N]> {
    let bytes = B64
        .decode(s)
        .map_err(|_| Error::InvalidVault(format!("{field} is not valid base64")))?;
    bytes
        .try_into()
        .map_err(|_| Error::InvalidVault(format!("{field} must be {N} bytes")))
}

/// Encrypts the recovery phrase under `password`. The password must not be empty.
pub fn seal(mnemonic: &Mnemonic, password: &str, kdf: KdfParams) -> Result<VaultFile> {
    if password.is_empty() {
        return Err(Error::input("password must not be empty"));
    }
    let salt: [u8; SALT_LEN] = random()?;
    let nonce: [u8; NONCE_LEN] = random()?;
    let key = kdf.derive_key(password, &salt)?;
    let cipher = XChaCha20Poly1305::new_from_slice(&key[..])
        .map_err(|_| Error::crypto("cipher init failed"))?;
    let phrase = mnemonic.phrase();
    let aad = aad(VAULT_VERSION, &kdf, &salt);
    let ciphertext = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: phrase.as_bytes(),
                aad: &aad,
            },
        )
        .map_err(|_| Error::crypto("encryption failed"))?;
    Ok(VaultFile {
        version: VAULT_VERSION,
        kdf,
        salt: B64.encode(salt),
        nonce: B64.encode(nonce),
        ciphertext: B64.encode(ciphertext),
    })
}

/// Decrypts a vault. Returns [`Error::WrongPassword`] if authentication fails (wrong password
/// or any tampering with header or ciphertext).
pub fn open(file: &VaultFile, password: &str) -> Result<Mnemonic> {
    if file.version != VAULT_VERSION {
        return Err(Error::UnsupportedVaultVersion(file.version));
    }
    let salt: [u8; SALT_LEN] = b64_fixed("salt", &file.salt)?;
    let nonce: [u8; NONCE_LEN] = b64_fixed("nonce", &file.nonce)?;
    let ciphertext = B64
        .decode(&file.ciphertext)
        .map_err(|_| Error::InvalidVault("ciphertext is not valid base64".into()))?;
    if ciphertext.len() <= TAG_LEN {
        return Err(Error::InvalidVault("ciphertext too short".into()));
    }
    let key = file.kdf.derive_key(password, &salt)?;
    let cipher = XChaCha20Poly1305::new_from_slice(&key[..])
        .map_err(|_| Error::crypto("cipher init failed"))?;
    let aad = aad(file.version, &file.kdf, &salt);
    let plaintext = Zeroizing::new(
        cipher
            .decrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: &ciphertext,
                    aad: &aad,
                },
            )
            .map_err(|_| Error::WrongPassword)?,
    );
    let phrase = core::str::from_utf8(&plaintext)
        .map_err(|_| Error::InvalidVault("decrypted payload is not UTF-8".into()))?;
    Mnemonic::parse(phrase)
}
