//! Encrypted backup file of what is not derived from the phrase (contacts, labels, settings). The
//! vault's own encryption, under a password chosen for the file: this module only adds the file
//! format and its limits. What goes inside is decided by the shell, as bytes; never key material.

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::error::{Error, Result};
use crate::vault::{open_data, seal_data, KdfParams, VaultFile};

/// Authenticated: a vault does not open as a backup, nor a backup as a vault.
const DOMAIN: &[u8] = b"kyro-backup";
const FORMAT: &str = "kyro-backup";

/// Largest backup file accepted, checked before anything is parsed.
pub const MAX_BACKUP_FILE: usize = 4 * 1024 * 1024;
/// Largest content sealed or accepted once decrypted.
pub const MAX_BACKUP_PLAINTEXT: usize = 2 * 1024 * 1024;

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct BackupFile {
    format: String,
    sealed: VaultFile,
}

fn invalid(what: &str) -> Error {
    Error::InvalidVault(format!("backup file: {what}"))
}

/// Encrypts `content` and returns the text of the file.
pub fn seal_backup(content: &[u8], password: &str, kdf: KdfParams) -> Result<String> {
    if content.len() > MAX_BACKUP_PLAINTEXT {
        return Err(invalid("too large"));
    }
    let file = BackupFile {
        format: FORMAT.into(),
        sealed: seal_data(DOMAIN, content, password, kdf)?,
    };
    serde_json::to_string_pretty(&file).map_err(|_| invalid("serialisation"))
}

/// Decrypts a backup file, checking its size, format and version first. A wrong password and a
/// modified file are the same error.
pub fn open_backup(text: &str, password: &str) -> Result<Zeroizing<Vec<u8>>> {
    if text.len() > MAX_BACKUP_FILE {
        return Err(invalid("too large"));
    }
    let file: BackupFile = serde_json::from_str(text).map_err(|_| invalid("not a Kyro backup"))?;
    if file.format != FORMAT {
        return Err(invalid("not a Kyro backup"));
    }
    let content = open_data(DOMAIN, &file.sealed, password)?;
    if content.len() > MAX_BACKUP_PLAINTEXT {
        return Err(invalid("too large"));
    }
    Ok(content)
}

#[cfg(test)]
mod tests {
    use base64::engine::general_purpose::STANDARD as B64;
    use base64::Engine as _;

    use super::*;
    use crate::mnemonic::Mnemonic;

    const PHRASE: &str = "abandon abandon abandon abandon abandon abandon abandon abandon \
                          abandon abandon abandon about";

    fn sealed(content: &[u8]) -> String {
        seal_backup(content, "backup password", KdfParams::minimum()).unwrap()
    }

    fn edit(text: &str, f: impl FnOnce(&mut serde_json::Value)) -> String {
        let mut v: serde_json::Value = serde_json::from_str(text).unwrap();
        f(&mut v);
        v.to_string()
    }

    #[test]
    fn round_trip_and_nothing_readable_in_the_file() {
        let text = sealed(b"{\"contact\":\"Alice\"}");
        assert!(!text.contains("Alice"));
        assert_eq!(
            &open_backup(&text, "backup password").unwrap()[..],
            b"{\"contact\":\"Alice\"}"
        );
    }

    #[test]
    fn wrong_password_is_refused() {
        assert!(matches!(
            open_backup(&sealed(b"x"), "another password"),
            Err(Error::WrongPassword)
        ));
    }

    #[test]
    fn any_change_to_the_ciphertext_or_the_header_is_refused() {
        let text = sealed(b"content");
        let flipped = edit(&text, |v| {
            let c = v["sealed"]["ciphertext"].as_str().unwrap();
            let mut bytes = B64.decode(c).unwrap();
            bytes[0] ^= 1;
            v["sealed"]["ciphertext"] = B64.encode(bytes).into();
        });
        assert!(matches!(
            open_backup(&flipped, "backup password"),
            Err(Error::WrongPassword)
        ));
        let salt = edit(&text, |v| {
            v["sealed"]["salt"] = B64.encode([7u8; 16]).into();
        });
        assert!(matches!(
            open_backup(&salt, "backup password"),
            Err(Error::WrongPassword)
        ));
        let kdf = edit(&text, |v| {
            v["sealed"]["kdf"]["t_cost"] = 3.into();
        });
        assert!(matches!(
            open_backup(&kdf, "backup password"),
            Err(Error::WrongPassword)
        ));
    }

    #[test]
    fn strict_format() {
        let text = sealed(b"content");
        for bad in [
            "",
            "not json",
            "{}",
            &edit(&text, |v| v["format"] = "other".into()),
            &edit(&text, |v| v["extra"] = 1.into()),
            &edit(&text, |v| v["sealed"]["extra"] = 1.into()),
            &edit(&text, |v| v["sealed"]["nonce"] = "AAAA".into()),
            &edit(&text, |v| v["sealed"]["kdf"]["m_cost_kib"] = 1024.into()),
        ] {
            assert!(
                matches!(
                    open_backup(bad, "backup password"),
                    Err(Error::InvalidVault(_))
                ),
                "{bad}"
            );
        }
    }

    #[test]
    fn unknown_version_is_refused() {
        let text = edit(&sealed(b"content"), |v| v["sealed"]["version"] = 2.into());
        assert!(matches!(
            open_backup(&text, "backup password"),
            Err(Error::UnsupportedVaultVersion(2))
        ));
    }

    #[test]
    fn size_limits() {
        assert!(seal_backup(
            &vec![0; MAX_BACKUP_PLAINTEXT + 1],
            "pw",
            KdfParams::minimum()
        )
        .is_err());
        let huge = " ".repeat(MAX_BACKUP_FILE + 1);
        assert!(matches!(
            open_backup(&huge, "pw"),
            Err(Error::InvalidVault(_))
        ));
    }

    #[test]
    fn a_vault_is_not_a_backup_and_a_backup_is_not_a_vault() {
        let m = Mnemonic::parse(PHRASE).unwrap();
        let vault = crate::vault::seal(&m, "same password", KdfParams::minimum()).unwrap();
        let as_backup = serde_json::to_string(&BackupFile {
            format: FORMAT.into(),
            sealed: vault,
        })
        .unwrap();
        assert!(matches!(
            open_backup(&as_backup, "same password"),
            Err(Error::WrongPassword)
        ));

        let text = seal_backup(PHRASE.as_bytes(), "same password", KdfParams::minimum()).unwrap();
        let file: BackupFile = serde_json::from_str(&text).unwrap();
        assert!(matches!(
            crate::vault::open(&file.sealed, "same password"),
            Err(Error::WrongPassword)
        ));
    }

    #[test]
    fn an_empty_password_or_a_weak_kdf_is_refused() {
        assert!(seal_backup(b"x", "", KdfParams::minimum()).is_err());
        let weak = KdfParams {
            t_cost: 1,
            ..KdfParams::minimum()
        };
        assert!(seal_backup(b"x", "pw", weak).is_err());
    }
}
