//! Watch addresses (`watch_*`): public addresses and xpubs the user follows. No key is stored and
//! no signing command takes them: `watch-addresses-<network>.json` next to the vault.

use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::State;
use wallet_core::{Network, WatchAddress, WatchAddressStore};

use crate::accounts::clean_name;
use crate::commands_hw::guard;
use crate::error::{AppError, AppResult};
use crate::hw;
use crate::state::AppState;

fn load(path: &Path, net: Network) -> AppResult<WatchAddressStore> {
    match std::fs::read_to_string(path) {
        Ok(raw) => Ok(WatchAddressStore::from_json(&raw, net)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(WatchAddressStore::default()),
        Err(e) => Err(e.into()),
    }
}

fn save(path: &Path, store: &WatchAddressStore, net: Network) -> AppResult<()> {
    store.validate(net)?;
    crate::settings::write_atomic(path, store.to_json()?.as_bytes())
}

/// `wa-` + 16 hex. Uniqueness only (not a secret): std's randomly keyed hasher + clock.
fn new_id(store: &WatchAddressStore) -> String {
    loop {
        let mut h = RandomState::new().build_hasher();
        h.write_u128(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default(),
        );
        let id = format!("wa-{:016x}", h.finish());
        if !store.addresses.iter().any(|a| a.id == id) {
            return id;
        }
    }
}

fn add(
    store: &mut WatchAddressStore,
    net: Network,
    family: String,
    value: &str,
    label: &str,
) -> AppResult<WatchAddress> {
    let entry = WatchAddress {
        id: new_id(store),
        label: clean_name(label)?,
        family,
        value: value.trim().to_owned(),
    };
    store.addresses.push(entry.clone());
    store.validate(net)?;
    Ok(entry)
}

#[tauri::command]
pub fn watch_addresses_get(state: State<'_, AppState>) -> AppResult<Vec<WatchAddress>> {
    guard(&state)?;
    Ok(load(&state.watch_path, state.network)?.addresses)
}

#[tauri::command]
pub fn watch_address_add(
    state: State<'_, AppState>,
    family: String,
    value: String,
    label: String,
) -> AppResult<WatchAddress> {
    guard(&state)?;
    let _write = hw::lock(&state.watch_store_lock);
    let mut s = load(&state.watch_path, state.network)?;
    let entry = add(&mut s, state.network, family, &value, &label)?;
    save(&state.watch_path, &s, state.network)?;
    Ok(entry)
}

#[tauri::command]
pub fn watch_address_rename(
    state: State<'_, AppState>,
    id: String,
    label: String,
) -> AppResult<WatchAddress> {
    guard(&state)?;
    let label = clean_name(&label)?;
    let _write = hw::lock(&state.watch_store_lock);
    let mut s = load(&state.watch_path, state.network)?;
    let entry = s
        .addresses
        .iter_mut()
        .find(|a| a.id == id)
        .ok_or_else(|| AppError::InvalidInput("unknown watch address".into()))?;
    entry.label = label;
    let out = entry.clone();
    save(&state.watch_path, &s, state.network)?;
    Ok(out)
}

#[tauri::command]
pub fn watch_address_remove(state: State<'_, AppState>, id: String) -> AppResult<()> {
    guard(&state)?;
    let _write = hw::lock(&state.watch_store_lock);
    let mut s = load(&state.watch_path, state.network)?;
    let before = s.addresses.len();
    s.addresses.retain(|a| a.id != id);
    if s.addresses.len() == before {
        return Err(AppError::InvalidInput("unknown watch address".into()));
    }
    save(&state.watch_path, &s, state.network)
}

#[cfg(test)]
mod tests {
    use super::*;

    const EVM: &str = "0x000000000000000000000000000000000000dEaD";

    #[test]
    fn missing_file_is_empty_and_entries_round_trip() {
        let dir = std::env::temp_dir().join(format!("kyro-watch-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("watch-addresses-mainnet.json");
        let _ = std::fs::remove_file(&path);
        let mut s = load(&path, Network::Mainnet).unwrap();
        assert!(s.addresses.is_empty());
        let e = add(&mut s, Network::Mainnet, "evm".into(), EVM, " Cold ").unwrap();
        assert_eq!(e.label, "Cold");
        assert!(e.id.starts_with("wa-"));
        save(&path, &s, Network::Mainnet).unwrap();
        assert_eq!(load(&path, Network::Mainnet).unwrap(), s);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn duplicates_and_bad_labels_are_refused() {
        let mut s = WatchAddressStore::default();
        add(&mut s, Network::Mainnet, "evm".into(), EVM, "One").unwrap();
        let mut dup = s.clone();
        assert!(add(&mut dup, Network::Mainnet, "evm".into(), EVM, "Two").is_err());
        assert!(add(&mut s, Network::Mainnet, "evm".into(), EVM, "   ").is_err());
    }
}
