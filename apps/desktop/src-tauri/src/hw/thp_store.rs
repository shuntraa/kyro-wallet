//! THP pairing state on disk: `trezor-thp.json` in the app data directory (next to the vault).
//!
//! Contents (see SECURITY.md, "Trezor Safe 7"):
//! - `hostKey`: Kyro's static X25519 **private** key for THP (one per installation, generated
//!   from the OS RNG the first time a THP device is opened);
//! - `pairings`: for each paired device, its static X25519 **public** key, the opaque credential
//!   it issued (a MAC by the device over Kyro's public key and the label "Kyro Wallet"), its
//!   model and the pairing date.
//!
//! Plain JSON, not encrypted (hardware-wallet-only users have no vault password), written
//! atomically with owner-only permissions on Unix. A corrupt file is an error, never a silent
//! reset; `hw_thp_forget` (all) deletes it.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use wallet_core::Zeroizing;

use super::thp::MAX_CREDENTIAL_LEN;
use super::{lock, HwError, HwResult};

/// One paired THP device.
#[derive(Clone, PartialEq, Eq)]
pub struct Pairing {
    pub trezor_key: [u8; 32],
    pub credential: Vec<u8>,
    /// `internal_model` (e.g. `T3W1`).
    pub model: String,
    /// Unix time (seconds).
    pub added: u64,
}

impl std::fmt::Debug for Pairing {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Pairing")
            .field("trezor_key", &hex::encode(self.trezor_key))
            .field("model", &self.model)
            .finish_non_exhaustive()
    }
}

/// What `hw_thp_pairings` returns (public data only).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingInfo {
    /// Hex of the device's static public key (identifies the device to Kyro).
    pub key: String,
    pub model: String,
    pub added: u64,
}

#[derive(Default)]
struct Stored {
    host_key: Option<Zeroizing<[u8; 32]>>,
    pairings: Vec<Pairing>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FileV1 {
    version: u32,
    host_key: String,
    pairings: Vec<PairingJson>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PairingJson {
    trezor_key: String,
    credential: String,
    model: String,
    added: u64,
}

impl Drop for FileV1 {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.host_key.zeroize();
    }
}

fn corrupt(why: &str) -> HwError {
    HwError::Internal(format!(
        "unreadable Trezor pairing file (trezor-thp.json): {why}. « Forget all » \
         resets it (you will need to pair again)."
    ))
}

fn hex32(s: &str, what: &str) -> HwResult<[u8; 32]> {
    let v = Zeroizing::new(hex::decode(s).map_err(|_| corrupt(what))?);
    v[..].try_into().map_err(|_| corrupt(what))
}

fn parse(raw: &str) -> HwResult<Stored> {
    let f: FileV1 = serde_json::from_str(raw).map_err(|e| corrupt(&e.to_string()))?;
    if f.version != 1 {
        return Err(corrupt("unknown version"));
    }
    let host_key = Zeroizing::new(hex32(&f.host_key, "host key")?);
    let mut pairings = Vec::new();
    for p in &f.pairings {
        let credential = hex::decode(&p.credential).map_err(|_| corrupt("credential"))?;
        if credential.is_empty() || credential.len() > MAX_CREDENTIAL_LEN {
            return Err(corrupt("credential of invalid size"));
        }
        if p.model.is_empty()
            || p.model.len() > 16
            || !p.model.bytes().all(|b| b.is_ascii_alphanumeric())
        {
            return Err(corrupt("model"));
        }
        let trezor_key = hex32(&p.trezor_key, "device key")?;
        if pairings
            .iter()
            .any(|q: &Pairing| q.trezor_key == trezor_key)
        {
            return Err(corrupt("duplicate device"));
        }
        pairings.push(Pairing {
            trezor_key,
            credential,
            model: p.model.clone(),
            added: p.added,
        });
    }
    Ok(Stored {
        host_key: Some(host_key),
        pairings,
    })
}

fn render(s: &Stored) -> HwResult<Zeroizing<String>> {
    let key = s
        .host_key
        .as_ref()
        .ok_or_else(|| HwError::Internal("missing host key".into()))?;
    let f = FileV1 {
        version: 1,
        host_key: hex::encode(&key[..]),
        pairings: s
            .pairings
            .iter()
            .map(|p| PairingJson {
                trezor_key: hex::encode(p.trezor_key),
                credential: hex::encode(&p.credential),
                model: p.model.clone(),
                added: p.added,
            })
            .collect(),
    };
    serde_json::to_string_pretty(&f)
        .map(Zeroizing::new)
        .map_err(|e| HwError::Internal(e.to_string()))
}

/// Atomic write (temporary file + rename), owner-only on Unix.
fn write_private(path: &Path, bytes: &[u8]) -> HwResult<()> {
    use std::io::Write;
    let io = |e: std::io::Error| HwError::Internal(format!("trezor-thp.json: {e}"));
    let tmp = path.with_extension("tmp");
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(&tmp).map_err(io)?;
    f.write_all(bytes).map_err(io)?;
    f.sync_all().map_err(io)?;
    drop(f);
    std::fs::rename(&tmp, path).map_err(io)
}

/// Shared THP state of the [`super::HwManager`]: where the pairings live and the lock that
/// serialises their read-modify-write. Without a path (tests), pairings live in memory.
#[derive(Default)]
pub struct ThpEnv {
    path: Mutex<Option<PathBuf>>,
    mem: Mutex<Stored>,
    io: Mutex<()>,
}

impl ThpEnv {
    /// Tests: in-memory state with a given host key and pairings.
    #[cfg(test)]
    pub fn preset(host_key: [u8; 32], pairings: Vec<Pairing>) -> Self {
        let env = ThpEnv::default();
        *lock(&env.mem) = Stored {
            host_key: Some(Zeroizing::new(host_key)),
            pairings,
        };
        env
    }

    pub fn set_path(&self, path: PathBuf) {
        *lock(&self.path) = Some(path);
    }

    fn path(&self) -> Option<PathBuf> {
        lock(&self.path).clone()
    }

    fn read(&self) -> HwResult<Stored> {
        let Some(path) = self.path() else {
            let m = lock(&self.mem);
            return Ok(Stored {
                host_key: m.host_key.clone(),
                pairings: m.pairings.clone(),
            });
        };
        match std::fs::read_to_string(&path) {
            Ok(raw) => parse(&Zeroizing::new(raw)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Stored::default()),
            Err(e) => Err(HwError::Internal(format!("trezor-thp.json: {e}"))),
        }
    }

    fn write(&self, s: Stored) -> HwResult<()> {
        let Some(path) = self.path() else {
            *lock(&self.mem) = s;
            return Ok(());
        };
        write_private(&path, render(&s)?.as_bytes())
    }

    /// Kyro's host key (created and saved on first use) and the known devices.
    pub fn load_or_init(&self) -> HwResult<(Zeroizing<[u8; 32]>, Vec<Pairing>)> {
        let _io = lock(&self.io);
        let s = self.read()?;
        if let Some(k) = s.host_key {
            return Ok((k, s.pairings));
        }
        let mut k = Zeroizing::new([0u8; 32]);
        getrandom::getrandom(&mut k[..])
            .map_err(|_| HwError::Internal("system randomness unavailable".into()))?;
        self.write(Stored {
            host_key: Some(k.clone()),
            pairings: s.pairings.clone(),
        })?;
        Ok((k, s.pairings))
    }

    /// Records (or replaces) the pairing of one device.
    pub fn add(&self, p: Pairing) -> HwResult<()> {
        let _io = lock(&self.io);
        let mut s = self.read()?;
        if s.host_key.is_none() {
            return Err(HwError::Internal("missing host key".into()));
        }
        s.pairings.retain(|q| q.trezor_key != p.trezor_key);
        s.pairings.push(p);
        self.write(s)
    }

    /// Drops the pairing of one device (stale credential).
    pub fn remove(&self, trezor_key: &[u8; 32]) -> HwResult<()> {
        let _io = lock(&self.io);
        let mut s = self.read()?;
        let before = s.pairings.len();
        s.pairings.retain(|q| q.trezor_key != *trezor_key);
        if s.pairings.len() == before {
            return Ok(());
        }
        self.write(s)
    }

    pub fn list(&self) -> HwResult<Vec<PairingInfo>> {
        let _io = lock(&self.io);
        Ok(self
            .read()?
            .pairings
            .iter()
            .map(|p| PairingInfo {
                key: hex::encode(p.trezor_key),
                model: p.model.clone(),
                added: p.added,
            })
            .collect())
    }

    /// Forgets one device, or everything (pairings **and** Kyro's host key: the file is
    /// deleted, a new key is generated next time). Returns how many pairings were removed.
    pub fn forget(&self, trezor_key: Option<&[u8; 32]>) -> HwResult<usize> {
        let _io = lock(&self.io);
        let Some(key) = trezor_key else {
            let n = match self.read() {
                Ok(s) => s.pairings.len(),
                Err(_) => 0, // corrupt file: deleting it is the way out
            };
            match self.path() {
                Some(path) => match std::fs::remove_file(&path) {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(HwError::Internal(format!("trezor-thp.json: {e}"))),
                },
                None => *lock(&self.mem) = Stored::default(),
            }
            return Ok(n);
        };
        let mut s = self.read()?;
        let before = s.pairings.len();
        s.pairings.retain(|q| q.trezor_key != *key);
        let n = before - s.pairings.len();
        if n > 0 {
            self.write(s)?;
        }
        Ok(n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pairing(b: u8) -> Pairing {
        Pairing {
            trezor_key: [b; 32],
            credential: vec![b; 40],
            model: "T3W1".into(),
            added: 1_700_000_000,
        }
    }

    #[test]
    fn file_round_trip_permissions_and_forget() {
        let dir = std::env::temp_dir().join(format!("kyro-thp-store-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("trezor-thp.json");
        let _ = std::fs::remove_file(&path);
        let env = ThpEnv::default();
        env.set_path(path.clone());
        let (k1, known) = env.load_or_init().unwrap();
        assert!(known.is_empty());
        // The host key is persisted immediately and stays the same.
        let (k2, _) = env.load_or_init().unwrap();
        assert_eq!(*k1, *k2);
        env.add(pairing(1)).unwrap();
        env.add(pairing(2)).unwrap();
        env.add(pairing(1)).unwrap(); // replaced, not duplicated
        let (_, known) = env.load_or_init().unwrap();
        assert_eq!(known, vec![pairing(2), pairing(1)]);
        let list = env.list().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].key, hex::encode([2u8; 32]));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        env.remove(&[2; 32]).unwrap();
        assert_eq!(env.forget(Some(&[9; 32])).unwrap(), 0);
        assert_eq!(env.forget(Some(&[1; 32])).unwrap(), 1);
        env.add(pairing(3)).unwrap();
        // Forget all: file deleted, a new host key next time.
        assert_eq!(env.forget(None).unwrap(), 1);
        assert!(!path.exists());
        let (k3, known) = env.load_or_init().unwrap();
        assert!(known.is_empty());
        assert_ne!(*k1, *k3);
        // Corrupt file: an error, never a silent reset; "forget all" is the way out.
        std::fs::write(&path, "{ \"version\": 1 }").unwrap();
        assert!(matches!(env.load_or_init(), Err(HwError::Internal(_))));
        assert_eq!(env.forget(None).unwrap(), 0);
        assert!(env.load_or_init().is_ok());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn hostile_contents_are_refused() {
        let key = "11".repeat(32);
        let ok = format!(
            r#"{{"version":1,"hostKey":"{key}","pairings":[{{"trezorKey":"{key}","credential":"0a0b","model":"T3W1","added":1}}]}}"#
        );
        assert!(parse(&ok).is_ok());
        for bad in [
            ok.replace("\"version\":1", "\"version\":2"),
            ok.replace("T3W1", "T3W1<script>"),
            ok.replace("0a0b", ""),
            ok.replace("0a0b", &"00".repeat(MAX_CREDENTIAL_LEN + 1)),
            ok.replace(",\"added\":1", ",\"added\":1,\"extra\":true"),
            ok.replacen(&key, "11", 1),
        ] {
            assert!(parse(&bad).is_err(), "{bad}");
        }
    }
}
