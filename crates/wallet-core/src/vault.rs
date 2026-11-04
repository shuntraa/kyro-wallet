//! Encrypted vault holding the recovery phrase and, for the wallets that have one, its BIP39
//! passphrase. The file format is the same for both: only the encrypted content differs, and a
//! wallet without passphrase holds exactly what it always held, the phrase alone.

use argon2::{Algorithm, Argon2, Params, Version};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::error::{Error, Result};
use crate::mnemonic::{Mnemonic, WalletSecret};

/// Current (and only supported) vault format version.
pub const VAULT_VERSION: u8 = 1;

const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 24;
const KEY_LEN: usize = 32;
const TAG_LEN: usize = 16;
const AAD_DOMAIN: &[u8] = b"kyro-vault";
/// First byte of a content with a passphrase: `0x01`, phrase, `0x00`, passphrase. A phrase never
/// starts with it, so a Kyro from before passphrases refuses the vault instead of opening it as
/// another wallet. The content is authenticated: this marker cannot be added or removed.
const WITH_PASSPHRASE: u8 = 0x01;
const PASSPHRASE_SEPARATOR: u8 = 0x00;

// Floor: below this, a stolen vault file is cheap to brute-force (OWASP's Argon2id minimum is
// 19 MiB / 2 passes; Kyro asks for more).
const MIN_M_COST_KIB: u32 = 64 * 1024; // 64 MiB
const MIN_T_COST: u32 = 2;
const MAX_M_COST_KIB: u32 = 1024 * 1024; // 1 GiB = 4x production
const MAX_T_COST: u32 = 10;
const MAX_P_COST: u32 = 16;

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

    /// The weakest parameters [`seal`] and [`open`] accept: 64 MiB, 2 passes, 1 lane.
    pub fn minimum() -> Self {
        KdfParams {
            m_cost_kib: MIN_M_COST_KIB,
            t_cost: MIN_T_COST,
            p_cost: 1,
        }
    }

    /// Very weak parameters (1 MiB, 1 pass, 1 lane), **unit tests only**: refused by [`seal`]
    /// and [`open`], used to build the vaults that must be refused.
    #[cfg(test)]
    pub(crate) fn insecure_for_tests() -> Self {
        KdfParams {
            m_cost_kib: 1024,
            t_cost: 1,
            p_cost: 1,
        }
    }

    fn check(&self) -> Result<()> {
        if self.m_cost_kib < MIN_M_COST_KIB
            || self.t_cost < MIN_T_COST
            || self.p_cost == 0
            || self.p_cost > MAX_P_COST
            || self.m_cost_kib < 8 * self.p_cost
        {
            return Err(Error::InvalidVault(
                "KDF parameters too weak (minimum 64 MiB, 2 passes)".into(),
            ));
        }
        if self.m_cost_kib > MAX_M_COST_KIB || self.t_cost > MAX_T_COST {
            return Err(Error::InvalidVault("KDF parameters out of range".into()));
        }
        Ok(())
    }

    fn argon2(&self) -> Result<Argon2<'static>> {
        self.check()?;
        self.argon2_unchecked()
    }

    fn argon2_unchecked(&self) -> Result<Argon2<'static>> {
        let params = Params::new(self.m_cost_kib, self.t_cost, self.p_cost, Some(KEY_LEN))
            .map_err(|_| Error::InvalidVault("KDF parameters out of range".into()))?;
        Ok(Argon2::new(Algorithm::Argon2id, Version::V0x13, params))
    }

    fn derive_key(&self, password: &str, salt: &[u8]) -> Result<Zeroizing<[u8; KEY_LEN]>> {
        derive_with(self.argon2()?, password, salt)
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

fn derive_with(
    argon2: Argon2<'static>,
    password: &str,
    salt: &[u8],
) -> Result<Zeroizing<[u8; KEY_LEN]>> {
    let mut key = Zeroizing::new([0u8; KEY_LEN]);
    argon2
        .hash_password_into(password.as_bytes(), salt, &mut key[..])
        .map_err(|_| Error::crypto("Argon2id failed"))?;
    Ok(key)
}

fn aad(domain: &[u8], version: u8, kdf: &KdfParams, salt: &[u8]) -> Vec<u8> {
    let mut aad = Vec::with_capacity(domain.len() + 1 + 12 + salt.len());
    aad.extend_from_slice(domain);
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

fn content(secret: &WalletSecret) -> Zeroizing<Vec<u8>> {
    let phrase = secret.phrase();
    if !secret.has_passphrase() {
        return Zeroizing::new(phrase.as_bytes().to_vec());
    }
    let passphrase = secret.passphrase().as_bytes();
    let mut out = Zeroizing::new(Vec::with_capacity(phrase.len() + passphrase.len() + 2));
    out.push(WITH_PASSPHRASE);
    out.extend_from_slice(phrase.as_bytes());
    out.push(PASSPHRASE_SEPARATOR);
    out.extend_from_slice(passphrase);
    out
}

fn parse_content(content: &[u8]) -> Result<WalletSecret> {
    let text = |bytes| {
        core::str::from_utf8(bytes)
            .map_err(|_| Error::InvalidVault("decrypted payload is not UTF-8".into()))
    };
    let Some(rest) = content.strip_prefix(&[WITH_PASSPHRASE]) else {
        return Ok(WalletSecret::plain(Mnemonic::parse(text(content)?)?));
    };
    let at = rest
        .iter()
        .position(|b| *b == PASSPHRASE_SEPARATOR)
        .ok_or_else(|| Error::InvalidVault("malformed payload".into()))?;
    let passphrase = Zeroizing::new(text(&rest[at + 1..])?.to_owned());
    if passphrase.is_empty() {
        return Err(Error::InvalidVault("malformed payload".into()));
    }
    WalletSecret::new(Mnemonic::parse(text(&rest[..at])?)?, passphrase)
        .map_err(|_| Error::InvalidVault("malformed payload".into()))
}

/// Encrypts a recovery phrase without passphrase under `password`.
pub fn seal(mnemonic: &Mnemonic, password: &str, kdf: KdfParams) -> Result<VaultFile> {
    let phrase = mnemonic.phrase();
    seal_payload(AAD_DOMAIN, phrase.as_bytes(), password, kdf, kdf.argon2()?)
}

/// Encrypts a phrase and its passphrase, if any, under `password`.
pub fn seal_secret(secret: &WalletSecret, password: &str, kdf: KdfParams) -> Result<VaultFile> {
    seal_payload(AAD_DOMAIN, &content(secret), password, kdf, kdf.argon2()?)
}

/// Encrypts `data` under `password` (another format than the vault's: see [`seal_data`]).
fn seal_payload(
    domain: &[u8],
    data: &[u8],
    password: &str,
    kdf: KdfParams,
    argon2: Argon2<'static>,
) -> Result<VaultFile> {
    if password.is_empty() {
        return Err(Error::input("password must not be empty"));
    }
    let salt: [u8; SALT_LEN] = random()?;
    let nonce: [u8; NONCE_LEN] = random()?;
    let key = derive_with(argon2, password, &salt)?;
    let cipher = XChaCha20Poly1305::new_from_slice(&key[..])
        .map_err(|_| Error::crypto("cipher init failed"))?;
    let aad = aad(domain, VAULT_VERSION, &kdf, &salt);
    let ciphertext = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: data,
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

/// Decrypts a vault. Keys come from the result as a whole ([`WalletSecret::seed`]…): there is no
/// way to get a seed that leaves the passphrase out.
pub fn open(file: &VaultFile, password: &str) -> Result<WalletSecret> {
    parse_content(&open_payload(AAD_DOMAIN, file, password)?)
}

/// Encrypts `data` exactly as the vault encrypts the phrase (same KDF, cipher, floor and ceiling).
/// `domain` is authenticated: a file sealed for one use never opens as another.
pub(crate) fn seal_data(
    domain: &[u8],
    data: &[u8],
    password: &str,
    kdf: KdfParams,
) -> Result<VaultFile> {
    seal_payload(domain, data, password, kdf, kdf.argon2()?)
}

/// Decrypts what [`seal_data`] wrote. A wrong password and a modified file give the same error.
pub(crate) fn open_data(
    domain: &[u8],
    file: &VaultFile,
    password: &str,
) -> Result<Zeroizing<Vec<u8>>> {
    open_payload(domain, file, password)
}

fn open_payload(domain: &[u8], file: &VaultFile, password: &str) -> Result<Zeroizing<Vec<u8>>> {
    if file.version != VAULT_VERSION {
        return Err(Error::UnsupportedVaultVersion(file.version));
    }
    file.kdf.check()?;
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
    let aad = aad(domain, file.version, &file.kdf, &salt);
    Ok(Zeroizing::new(
        cipher
            .decrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: &ciphertext,
                    aad: &aad,
                },
            )
            .map_err(|_| Error::WrongPassword)?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    const ABANDON: &str = "abandon abandon abandon abandon abandon abandon abandon abandon \
                           abandon abandon abandon about";

    fn weak_vault(kdf: KdfParams) -> VaultFile {
        let m = Mnemonic::parse(ABANDON).unwrap();
        let phrase = m.phrase();
        let argon2 = kdf.argon2_unchecked().unwrap();
        seal_payload(AAD_DOMAIN, phrase.as_bytes(), "pw", kdf, argon2).unwrap()
    }

    #[test]
    fn a_plain_wallet_seals_the_phrase_and_nothing_else() {
        let secret = WalletSecret::plain(Mnemonic::parse(ABANDON).unwrap());
        assert_eq!(&content(&secret)[..], ABANDON.as_bytes());
        let file = seal_secret(&secret, "pw", KdfParams::minimum()).unwrap();
        let plain = open_payload(AAD_DOMAIN, &file, "pw").unwrap();
        assert_eq!(&plain[..], ABANDON.as_bytes());
    }

    #[test]
    fn passphrase_content_round_trips_and_broken_content_is_refused() {
        let m = Mnemonic::parse(ABANDON).unwrap();
        let secret = WalletSecret::new(m, Zeroizing::new("a b".to_owned())).unwrap();
        let bytes = content(&secret);
        assert_eq!(bytes[0], WITH_PASSPHRASE);
        assert_eq!(parse_content(&bytes).unwrap(), secret);
        let framed = |tail: &[u8]| [&[WITH_PASSPHRASE], ABANDON.as_bytes(), tail].concat();
        for bad in [
            framed(b""),              // no separator
            framed(b"\0"),            // empty passphrase
            framed(b"\0line\nbreak"), // control character
            framed(b"\0\xff"),        // not UTF-8
        ] {
            assert!(matches!(parse_content(&bad), Err(Error::InvalidVault(_))));
        }
    }

    #[test]
    fn weak_kdf_is_refused_at_seal_and_open() {
        let m = Mnemonic::parse(ABANDON).unwrap();
        let weak = KdfParams::insecure_for_tests();
        for kdf in [
            weak,
            KdfParams {
                t_cost: 1,
                ..KdfParams::minimum()
            },
            KdfParams {
                m_cost_kib: MIN_M_COST_KIB - 1,
                ..KdfParams::minimum()
            },
        ] {
            assert!(matches!(seal(&m, "pw", kdf), Err(Error::InvalidVault(_))));
            let f = weak_vault(kdf);
            // Refused before any derivation, even with the right password.
            assert!(
                matches!(open(&f, "pw"), Err(Error::InvalidVault(_))),
                "{kdf:?}"
            );
        }
        // Ceiling.
        for kdf in [
            KdfParams {
                t_cost: MAX_T_COST + 1,
                ..KdfParams::minimum()
            },
            KdfParams {
                p_cost: MAX_P_COST + 1,
                ..KdfParams::minimum()
            },
            KdfParams {
                m_cost_kib: MAX_M_COST_KIB + 1,
                ..KdfParams::minimum()
            },
        ] {
            assert!(kdf.check().is_err(), "{kdf:?}");
        }
        assert!(KdfParams::minimum().check().is_ok());
        assert!(KdfParams::production().check().is_ok());
    }
}
