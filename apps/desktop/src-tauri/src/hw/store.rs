//! Watch-only hardware-wallet accounts on disk: `hw-accounts-<network>.json` next to the
//! vault. Public data only (xpubs, addresses); the encrypted vault file is not touched, so a
//! hardware-wallet user needs no recovery phrase in Kyro.

use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use wallet_core::{Network, WatchOnlyAccount, WatchOnlyStore};

use crate::error::{AppError, AppResult};

pub fn load(path: &Path, net: Network) -> AppResult<WatchOnlyStore> {
    match std::fs::read_to_string(path) {
        Ok(raw) => Ok(WatchOnlyStore::from_json(&raw, net)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(WatchOnlyStore::default()),
        Err(e) => Err(e.into()),
    }
}

pub fn save(path: &Path, store: &WatchOnlyStore, net: Network) -> AppResult<()> {
    store.validate(net)?;
    crate::settings::write_atomic(path, store.to_json()?.as_bytes())
}

pub fn find(store: &WatchOnlyStore, id: &str) -> AppResult<WatchOnlyAccount> {
    store
        .accounts
        .iter()
        .find(|a| a.id == id)
        .cloned()
        .ok_or_else(|| AppError::InvalidInput("unknown hardware-wallet account".into()))
}

/// `hw-` + 16 hex. Uniqueness only (not a secret): std's randomly keyed hasher + clock.
pub fn new_id(store: &WatchOnlyStore) -> String {
    loop {
        let mut h = RandomState::new().build_hasher();
        h.write_u128(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default(),
        );
        let id = format!("hw-{:016x}", h.finish());
        if !store.accounts.iter().any(|a| a.id == id) {
            return id;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_file_is_empty_and_ids_are_valid() {
        let dir = std::env::temp_dir().join(format!("kyro-hw-store-{}", std::process::id()));
        let path = dir.join("hw-accounts-testnet.json");
        let store = load(&path, Network::Testnet).unwrap();
        assert!(store.accounts.is_empty());
        let id = new_id(&store);
        assert_eq!(id.len(), 19);
        assert!(id[3..]
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
        // Corrupt file: an error, never a silent reset.
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&path, "{ not json").unwrap();
        assert!(load(&path, Network::Testnet).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
