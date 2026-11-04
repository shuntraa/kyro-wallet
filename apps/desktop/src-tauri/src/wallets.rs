//! Several wallets on one device. Each wallet is its own vault file in the reviewed format
//! (`wallet_core::seal` / `open`, own password, own attempt counter): the file format does not
//! change and the first vault (`coffre-<network>.kyrovault`) stays where it is, untouched. Only one
//! wallet is open at a time: switching ends the session, so one seed at most is in memory.
//!
//! `wallets-<network>.json` lists the others (names only, no secret); a missing or broken list
//! just means "the first wallet only".

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::State;
use zeroize::Zeroizing;

use crate::accounts::clean_name;
use wallet_core::{KdfParams, Mnemonic, VaultFile};

use crate::commands::blocking;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// Id of the first wallet (the historical vault file).
pub const MAIN: &str = "main";
/// At most this many wallets per network, the first one included.
pub const MAX_WALLETS: usize = 10;
const LIST_VERSION: u8 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WalletEntry {
    pub id: String,
    pub name: String,
}

/// What `wallets-<network>.json` holds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WalletList {
    pub version: u8,
    /// Wallet opened last, offered at the next start.
    pub active: String,
    /// Name of the first wallet; absent = the default name of the interface.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub main_name: Option<String>,
    /// The wallets added after the first one.
    pub wallets: Vec<WalletEntry>,
}

impl Default for WalletList {
    fn default() -> Self {
        WalletList {
            version: LIST_VERSION,
            active: MAIN.into(),
            main_name: None,
            wallets: Vec::new(),
        }
    }
}

/// `w-` + 16 lowercase hex: the only ids that ever reach a file path.
pub fn valid_id(id: &str) -> bool {
    id.strip_prefix("w-")
        .is_some_and(|h| h.len() == 16 && h.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f')))
}

/// Directory of the added wallets of `network` (`wallets-<network>`).
pub fn wallets_dir(list_path: &Path) -> PathBuf {
    list_path.with_extension("")
}

/// Vault file of an added wallet.
pub fn wallet_vault(list_path: &Path, id: &str) -> PathBuf {
    wallets_dir(list_path).join(format!("{id}.kyrovault"))
}

impl WalletList {
    /// Reads the list. Entries with a bad id or without their vault file are left out of the
    /// answer (nothing is deleted); a missing or broken file is the first wallet alone.
    pub fn load(path: &Path) -> WalletList {
        let mut list: WalletList = std::fs::read_to_string(path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .filter(|l: &WalletList| l.version == LIST_VERSION)
            .unwrap_or_default();
        list.wallets
            .retain(|w| valid_id(&w.id) && wallet_vault(path, &w.id).exists());
        if !list.knows(&list.active) {
            list.active = MAIN.into();
        }
        list
    }

    pub fn save(&self, path: &Path) -> AppResult<()> {
        crate::settings::write_atomic(path, serde_json::to_string_pretty(self)?.as_bytes())
    }

    pub fn knows(&self, id: &str) -> bool {
        id == MAIN || self.wallets.iter().any(|w| w.id == id)
    }

    #[cfg(test)]
    pub fn name_of(&self, id: &str) -> Option<String> {
        if id == MAIN {
            return self.main_name.clone();
        }
        self.wallets
            .iter()
            .find(|w| w.id == id)
            .map(|w| w.name.clone())
    }

    fn name_taken(&self, name: &str, except: &str) -> bool {
        let same = |n: &str| n.to_lowercase() == name.to_lowercase();
        (except != MAIN && self.main_name.as_deref().is_some_and(same))
            || self.wallets.iter().any(|w| w.id != except && same(&w.name))
    }

    /// Checks a name for wallet `id` (a new one: an id not in the list).
    pub fn check_name(&self, name: &str, id: &str) -> AppResult<String> {
        let name = clean_name(name)?;
        if self.name_taken(&name, id) {
            return Err(AppError::InvalidInput(
                "a wallet already has this name".into(),
            ));
        }
        Ok(name)
    }

    pub fn rename(&mut self, id: &str, name: String) -> AppResult<()> {
        if id == MAIN {
            self.main_name = Some(name);
            return Ok(());
        }
        self.wallets
            .iter_mut()
            .find(|w| w.id == id)
            .map(|w| w.name = name)
            .ok_or_else(|| AppError::InvalidInput("unknown wallet".into()))
    }
}

/// Encrypts `mnemonic` under `password` with `kdf` and swaps the vault at `path`, once the new file
/// read back from the disk opens to the same words.
pub fn rewrite_vault(
    path: &Path,
    mnemonic: &Mnemonic,
    password: &str,
    kdf: KdfParams,
) -> AppResult<()> {
    let sealed = serde_json::to_vec(&wallet_core::seal(mnemonic, password, kdf)?)?;
    let want = mnemonic.words();
    crate::settings::replace_checked(path, &sealed, |written| {
        let file: VaultFile = serde_json::from_slice(written)?;
        if wallet_core::open(&file, password)?.words() == want {
            Ok(())
        } else {
            Err(AppError::Internal("the new vault does not match".into()))
        }
    })
}

/// A random id: file names only, not a secret.
fn new_id(list: &WalletList) -> AppResult<String> {
    loop {
        let mut b = [0u8; 8];
        getrandom::getrandom(&mut b).map_err(|e| AppError::Internal(e.to_string()))?;
        let id = format!("w-{}", hex::encode(b));
        if !list.knows(&id) {
            return Ok(id);
        }
    }
}

/// A removed wallet stays on disk, encrypted, under this name: removing never destroys a phrase.
fn removed_path(vault: &Path) -> PathBuf {
    vault.with_extension("kyrovault.removed")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WalletsView {
    active: String,
    /// `name`: empty for a first wallet never renamed (the interface shows its default name).
    wallets: Vec<WalletEntry>,
}

fn view(state: &AppState) -> WalletsView {
    let list = WalletList::load(&state.wallets_path);
    let mut wallets = vec![WalletEntry {
        id: MAIN.into(),
        name: list.main_name.clone().unwrap_or_default(),
    }];
    wallets.extend(list.wallets);
    WalletsView {
        active: state.active_wallet(),
        wallets,
    }
}

fn require_idle(state: &AppState) -> AppResult<()> {
    if state.dialogs.any_open() {
        return Err(AppError::InvalidInput(
            "close the confirmation window first".into(),
        ));
    }
    Ok(())
}

/// Names are shown on the lock screen too: they are plain text on disk, and opening a wallet
/// still takes its password.
#[tauri::command]
pub fn wallets_get(state: State<'_, AppState>) -> WalletsView {
    view(&state)
}

/// Ends the session and makes `id` the active wallet (locked). Its password is asked next.
#[tauri::command]
pub async fn wallet_switch(state: State<'_, AppState>, id: String) -> AppResult<WalletsView> {
    require_idle(&state)?;
    let _creating = state.vault_create_lock.lock().await;
    let mut list = WalletList::load(&state.wallets_path);
    if !list.knows(&id) {
        return Err(AppError::InvalidInput("unknown wallet".into()));
    }
    state.activate_wallet(&id);
    list.active = id;
    list.save(&state.wallets_path)?;
    Ok(view(&state))
}

/// Starts adding a wallet: the session ends and the usual create or import flow runs on a new
/// vault file. Nothing is written until that flow ends; [`wallet_new_cancel`] goes back.
#[tauri::command]
pub async fn wallet_new(state: State<'_, AppState>, name: String) -> AppResult<()> {
    require_idle(&state)?;
    if !state.is_unlocked() {
        return Err(AppError::Locked);
    }
    let _creating = state.vault_create_lock.lock().await;
    let list = WalletList::load(&state.wallets_path);
    if list.wallets.len() + 1 >= MAX_WALLETS {
        return Err(AppError::InvalidInput(format!(
            "at most {MAX_WALLETS} wallets"
        )));
    }
    let id = new_id(&list)?;
    let name = list.check_name(&name, &id)?;
    std::fs::create_dir_all(wallets_dir(&state.wallets_path))
        .map_err(|e| AppError::Internal(e.to_string()))?;
    state.begin_new_wallet(&id, name);
    Ok(())
}

/// Leaves the add flow before the vault is written, back to the previous wallet (locked).
#[tauri::command]
pub async fn wallet_new_cancel(state: State<'_, AppState>) -> AppResult<()> {
    let _creating = state.vault_create_lock.lock().await;
    state.cancel_new_wallet()
}

#[tauri::command]
pub fn wallet_rename(
    state: State<'_, AppState>,
    id: String,
    name: String,
) -> AppResult<WalletsView> {
    if !state.is_unlocked() {
        return Err(AppError::Locked);
    }
    let mut list = WalletList::load(&state.wallets_path);
    let name = list.check_name(&name, &id)?;
    list.rename(&id, name)?;
    list.save(&state.wallets_path)?;
    Ok(view(&state))
}

/// Takes an added wallet off the list, behind its own password. The encrypted file is kept
/// (`.removed`): the phrase is the user's only other copy, and a slip must not cost it.
#[tauri::command]
pub async fn wallet_remove(
    state: State<'_, AppState>,
    id: String,
    password: String,
) -> AppResult<WalletsView> {
    require_idle(&state)?;
    if !state.is_unlocked() {
        return Err(AppError::Locked);
    }
    let password = Zeroizing::new(password);
    let mut list = WalletList::load(&state.wallets_path);
    if id == MAIN || !list.knows(&id) {
        return Err(AppError::InvalidInput(
            "only an added wallet can be removed".into(),
        ));
    }
    if id != state.active_wallet() {
        return Err(AppError::InvalidInput(
            "open this wallet first to remove it".into(),
        ));
    }
    // The password of the wallet being removed, under its own attempt counter.
    crate::commands::mnemonic_from_password(&state, password).await?;
    let _creating = state.vault_create_lock.lock().await;
    let vault = wallet_vault(&state.wallets_path, &id);
    state.activate_wallet(MAIN);
    list.wallets.retain(|w| w.id != id);
    list.active = MAIN.into();
    list.save(&state.wallets_path)?;
    let renamed = removed_path(&vault);
    blocking(move || {
        std::fs::rename(&vault, &renamed).map_err(|e| AppError::Internal(e.to_string()))
    })
    .await?;
    Ok(view(&state))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kyro-wallets-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("wallets-testnet.json")
    }

    const PHRASE: &str =
        "legal winner thank year wave sausage worth useful legal winner thank yellow";

    fn vault_at(tag: &str) -> (PathBuf, Mnemonic) {
        let path = tmp(tag).with_file_name("coffre-testnet.kyrovault");
        let m = Mnemonic::parse(PHRASE).unwrap();
        let file = wallet_core::seal(&m, "old password", KdfParams::minimum()).unwrap();
        std::fs::write(&path, serde_json::to_vec(&file).unwrap()).unwrap();
        (path, m)
    }

    fn opens(path: &Path, pw: &str) -> bool {
        let f: VaultFile = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        wallet_core::open(&f, pw).is_ok_and(|m| m.words().join(" ") == PHRASE)
    }

    #[test]
    fn the_new_password_opens_the_same_phrase_and_the_old_one_stops() {
        let (path, m) = vault_at("pw-ok");
        rewrite_vault(&path, &m, "new password", KdfParams::minimum()).unwrap();
        assert!(opens(&path, "new password"));
        assert!(!opens(&path, "old password"));
        assert!(!path.with_extension("kyrovault.new").exists());
    }

    #[test]
    fn a_new_file_that_fails_its_check_leaves_the_vault_untouched() {
        let (path, _) = vault_at("pw-check");
        let before = std::fs::read(&path).unwrap();
        let refused = crate::settings::replace_checked(&path, b"anything", |_| {
            Err(AppError::Internal("does not open".into()))
        });
        assert!(refused.is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert!(!path.with_extension("kyrovault.new").exists());
    }

    #[test]
    fn a_crash_before_the_swap_leaves_a_usable_vault_and_can_be_retried() {
        let (path, m) = vault_at("pw-crash");
        // What a crash leaves: a half-written new file next to the vault.
        let leftover = path.with_extension("kyrovault.new");
        std::fs::write(&leftover, b"{\"half").unwrap();
        assert!(opens(&path, "old password"));
        rewrite_vault(&path, &m, "new password", KdfParams::minimum()).unwrap();
        assert!(opens(&path, "new password"));
        assert!(!leftover.exists());
    }

    #[test]
    fn missing_or_broken_list_is_the_first_wallet() {
        let p = tmp("missing");
        assert_eq!(WalletList::load(&p), WalletList::default());
        std::fs::write(&p, "not json").unwrap();
        assert_eq!(WalletList::load(&p), WalletList::default());
        std::fs::write(&p, "{\"version\":9,\"active\":\"main\",\"wallets\":[]}").unwrap();
        assert_eq!(WalletList::load(&p), WalletList::default());
    }

    #[test]
    fn ids_cannot_escape_the_directory() {
        assert!(valid_id("w-0123456789abcdef"));
        for bad in [
            "main",
            "w-../../coffre",
            "w-0123456789abcde",
            "w-0123456789ABCDEF",
        ] {
            assert!(!valid_id(bad), "{bad}");
        }
        let p = tmp("escape");
        let raw =
            "{\"version\":1,\"active\":\"../x\",\"wallets\":[{\"id\":\"../x\",\"name\":\"a\"}]}";
        std::fs::write(&p, raw).unwrap();
        let l = WalletList::load(&p);
        assert!(l.wallets.is_empty());
        assert_eq!(l.active, MAIN);
    }

    #[test]
    fn an_entry_without_its_vault_is_ignored_and_the_active_falls_back() {
        let p = tmp("orphan");
        let id = "w-0123456789abcdef";
        let list = WalletList {
            active: id.into(),
            wallets: vec![WalletEntry {
                id: id.into(),
                name: "Two".into(),
            }],
            ..Default::default()
        };
        list.save(&p).unwrap();
        assert_eq!(WalletList::load(&p).active, MAIN);
        std::fs::create_dir_all(wallets_dir(&p)).unwrap();
        std::fs::write(wallet_vault(&p, id), "{}").unwrap();
        let l = WalletList::load(&p);
        assert_eq!(l.active, id);
        assert_eq!(l.name_of(id).as_deref(), Some("Two"));
    }

    #[test]
    fn names_are_cleaned_and_unique() {
        let mut l = WalletList::default();
        l.wallets.push(WalletEntry {
            id: "w-0000000000000001".into(),
            name: "Savings".into(),
        });
        assert!(l.check_name("savings", "w-0000000000000002").is_err());
        assert_eq!(
            l.check_name(" Savings ", "w-0000000000000001").unwrap(),
            "Savings"
        );
        assert!(l.check_name("   ", MAIN).is_err());
        l.rename(MAIN, "Daily".into()).unwrap();
        assert!(l.check_name("daily", "w-0000000000000002").is_err());
        assert!(l.rename("w-ffffffffffffffff", "x".into()).is_err());
    }

    #[test]
    fn the_removed_name_keeps_the_file_out_of_the_list() {
        let p = tmp("removed");
        let v = wallet_vault(&p, "w-0123456789abcdef");
        assert!(removed_path(&v).ends_with("w-0123456789abcdef.kyrovault.removed"));
    }
}
