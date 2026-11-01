//! Which network the app runs on (mainnet or testnet), chosen once at startup.
//!
//! Precedence: environment variable `KYRO_NETWORK` (developer override) > the user's saved
//! choice (`network.json` in the app data directory, written by `network_set`) > the build
//! default (**mainnet in release builds, testnet in debug builds**).
//!
//! One refinement for installs made before the choice existed (no `network.json`): if a vault
//! exists on exactly one network, that network is used instead of the build default, so an
//! updated app never greets an existing user with an empty « Bienvenue » screen.
//!
//! Each network has its own vault (`coffre-{mainnet|testnet}.kyrovault`) and hardware-wallet
//! list; switching never deletes the other network's files. The network never changes while
//! the app runs: `network_set` saves the choice and restarts the app.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use wallet_core::Network;

use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// File (in the app data directory) holding the user's saved choice. Public data only.
pub const FILE: &str = "network.json";
/// Environment variable that overrides everything (development, tests).
pub const ENV: &str = "KYRO_NETWORK";

/// Where the running network comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Env,
    Saved,
    /// No saved choice, and only this network has a vault (installs older than the choice).
    Vault,
    Default,
}

#[derive(Debug, Serialize, Deserialize)]
struct SavedFile {
    network: String,
}

/// Network of a fresh install: real funds in release builds, test coins while developing.
pub fn build_default() -> Network {
    if cfg!(debug_assertions) {
        Network::Testnet
    } else {
        Network::Mainnet
    }
}

pub fn name(n: Network) -> &'static str {
    match n {
        Network::Mainnet => "mainnet",
        Network::Testnet => "testnet",
    }
}

/// `"mainnet"` / `"testnet"` (trimmed, any case). Anything else: `None`.
pub fn parse(s: &str) -> Option<Network> {
    match s.trim().to_ascii_lowercase().as_str() {
        "mainnet" => Some(Network::Mainnet),
        "testnet" => Some(Network::Testnet),
        _ => None,
    }
}

/// Applies the precedence rule. `only_vault` = the network that has a vault when exactly one
/// has. An unrecognised `KYRO_NETWORK` value is ignored (never a silent switch to a network
/// the user did not ask for).
pub fn resolve(
    env: Option<&str>,
    saved: Option<Network>,
    only_vault: Option<Network>,
    default: Network,
) -> (Network, Source) {
    if let Some(n) = env.and_then(parse) {
        return (n, Source::Env);
    }
    if let Some(n) = saved {
        return (n, Source::Saved);
    }
    if let Some(n) = only_vault {
        return (n, Source::Vault);
    }
    (default, Source::Default)
}

/// The network that has a vault in `dir`, when exactly one has.
pub fn only_vault(dir: &Path) -> Option<Network> {
    match (
        vault_file(dir, Network::Mainnet).exists(),
        vault_file(dir, Network::Testnet).exists(),
    ) {
        (true, false) => Some(Network::Mainnet),
        (false, true) => Some(Network::Testnet),
        _ => None,
    }
}

/// The saved choice, if the file exists and is valid (a broken file counts as "no choice").
pub fn load_saved(dir: &Path) -> Option<Network> {
    let raw = std::fs::read_to_string(dir.join(FILE)).ok()?;
    let f: SavedFile = serde_json::from_str(&raw).ok()?;
    parse(&f.network)
}

pub fn save(dir: &Path, n: Network) -> AppResult<()> {
    let body = serde_json::to_string_pretty(&SavedFile {
        network: name(n).into(),
    })?;
    crate::settings::write_atomic(&dir.join(FILE), body.as_bytes())
}

/// Network for this run, from the real environment and `dir`.
pub fn startup(dir: &Path) -> (Network, Source) {
    let env = std::env::var(ENV).ok();
    resolve(
        env.as_deref(),
        load_saved(dir),
        only_vault(dir),
        build_default(),
    )
}

/// Vault file of `n` in `dir` (one per network).
pub fn vault_file(dir: &Path, n: Network) -> PathBuf {
    dir.join(format!("coffre-{}.kyrovault", name(n)))
}

/// Hardware-wallet account list of `n` in `dir` (one per network).
pub fn hw_accounts_file(dir: &Path, n: Network) -> PathBuf {
    dir.join(format!("hw-accounts-{}.json", name(n)))
}

fn other(n: Network) -> Network {
    match n {
        Network::Mainnet => Network::Testnet,
        Network::Testnet => Network::Mainnet,
    }
}

// ---------------------------------------------------------------- native dialogs in progress

/// Counts the native signature dialogs currently shown: the network cannot be switched (app
/// restart) while one of them waits for the user.
#[derive(Default, Clone)]
pub struct DialogCounter(Arc<AtomicU32>);

/// Decrements the counter when the dialog is closed, however it ends.
pub struct DialogGuard(Arc<AtomicU32>);

impl DialogCounter {
    pub fn enter(&self) -> DialogGuard {
        self.0.fetch_add(1, Ordering::SeqCst);
        DialogGuard(self.0.clone())
    }

    pub fn any_open(&self) -> bool {
        self.0.load(Ordering::SeqCst) > 0
    }
}

impl Drop for DialogGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

// ---------------------------------------------------------------- IPC

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkInfo {
    /// Network of this run.
    network: &'static str,
    source: Source,
    /// The saved choice (`network.json`), if any.
    saved: Option<&'static str>,
    /// Build default (mainnet in release builds, testnet in debug builds).
    default: &'static str,
    /// False when `KYRO_NETWORK` forces the network (switching from the app would not apply).
    can_switch: bool,
    /// A vault already exists on the other network (it is kept when switching).
    other_vault_exists: bool,
}

fn info(state: &AppState) -> NetworkInfo {
    let dir = state.data_dir();
    NetworkInfo {
        network: name(state.network),
        source: state.network_source,
        saved: load_saved(&dir).map(name),
        default: name(build_default()),
        can_switch: state.network_source != Source::Env,
        other_vault_exists: vault_file(&dir, other(state.network)).exists(),
    }
}

/// Checks done before saving a new choice (pure, tested).
fn check_switch(
    source: Source,
    dialog_open: bool,
    hw_busy: bool,
    requested: &str,
) -> AppResult<Network> {
    let n = parse(requested).ok_or_else(|| {
        AppError::InvalidInput(format!(
            "unknown network « {requested} » (mainnet or testnet)"
        ))
    })?;
    if source == Source::Env {
        return Err(AppError::InvalidInput(format!(
            "the network is set by the environment variable {ENV}: remove it to choose from the app"
        )));
    }
    if dialog_open {
        return Err(AppError::InvalidInput(
            "a signing window is open: finish or cancel it first".into(),
        ));
    }
    if hw_busy {
        return Err(AppError::InvalidInput(
            "an operation is in progress on the hardware wallet: finish or cancel it first".into(),
        ));
    }
    Ok(n)
}

#[tauri::command]
pub fn network_get(state: State<'_, AppState>) -> NetworkInfo {
    info(&state)
}

/// Saves the choice; if it differs from the running network, locks the session and restarts
/// the app (the vault of the other network is opened after the restart, nothing is deleted).
/// Returns `true` when a restart was requested.
#[tauri::command]
pub fn network_set(app: AppHandle, state: State<'_, AppState>, network: String) -> AppResult<bool> {
    let n = check_switch(
        state.network_source,
        state.dialogs.any_open(),
        state.hw.any_busy(),
        &network,
    )?;
    save(&state.data_dir(), n)?;
    if n == state.network {
        return Ok(false);
    }
    state.lock_session();
    app.request_restart();
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("kyro-network-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn default_is_mainnet_in_release_testnet_in_debug() {
        let want = if cfg!(debug_assertions) {
            Network::Testnet
        } else {
            Network::Mainnet
        };
        assert_eq!(build_default(), want);
        assert_eq!(
            resolve(None, None, None, Network::Mainnet),
            (Network::Mainnet, Source::Default)
        );
        assert_eq!(
            resolve(None, None, None, Network::Testnet),
            (Network::Testnet, Source::Default)
        );
    }

    #[test]
    fn env_beats_saved_beats_default() {
        let m = Network::Mainnet;
        let t = Network::Testnet;
        assert_eq!(
            resolve(Some("testnet"), Some(m), Some(m), m),
            (t, Source::Env)
        );
        assert_eq!(
            resolve(Some(" MAINNET "), Some(t), None, t),
            (m, Source::Env)
        );
        assert_eq!(resolve(None, Some(t), Some(m), m), (t, Source::Saved));
        assert_eq!(resolve(None, Some(m), None, t), (m, Source::Saved));
        // An unknown env value is ignored, never a silent pick.
        assert_eq!(
            resolve(Some("testnet4"), Some(m), None, t),
            (m, Source::Saved)
        );
        assert_eq!(resolve(Some(""), None, None, m), (m, Source::Default));
        // No saved choice: the only existing vault wins over the build default.
        assert_eq!(resolve(None, None, Some(t), m), (t, Source::Vault));
        assert_eq!(resolve(None, None, Some(m), t), (m, Source::Vault));
    }

    #[test]
    fn an_older_install_keeps_its_vault_network() {
        let dir = temp_dir("older");
        assert_eq!(only_vault(&dir), None);
        std::fs::write(vault_file(&dir, Network::Testnet), "{}").unwrap();
        assert_eq!(only_vault(&dir), Some(Network::Testnet));
        assert_eq!(
            resolve(None, load_saved(&dir), only_vault(&dir), Network::Mainnet),
            (Network::Testnet, Source::Vault)
        );
        // Both networks have a vault: back to the saved choice / build default.
        std::fs::write(vault_file(&dir, Network::Mainnet), "{}").unwrap();
        assert_eq!(only_vault(&dir), None);
        assert_eq!(
            resolve(None, None, only_vault(&dir), Network::Mainnet),
            (Network::Mainnet, Source::Default)
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn choice_is_persisted_and_broken_files_are_ignored() {
        let dir = temp_dir("persist");
        assert_eq!(load_saved(&dir), None);
        save(&dir, Network::Testnet).unwrap();
        assert_eq!(load_saved(&dir), Some(Network::Testnet));
        save(&dir, Network::Mainnet).unwrap();
        assert_eq!(load_saved(&dir), Some(Network::Mainnet));
        assert_eq!(
            resolve(None, load_saved(&dir), None, Network::Testnet),
            (Network::Mainnet, Source::Saved)
        );
        // No temp file left behind.
        assert!(!dir.join("network.tmp").exists());
        std::fs::write(dir.join(FILE), "{ pas du json").unwrap();
        assert_eq!(load_saved(&dir), None);
        std::fs::write(dir.join(FILE), r#"{"network":"regtest"}"#).unwrap();
        assert_eq!(load_saved(&dir), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn each_network_has_its_own_files() {
        let dir = Path::new("data");
        assert_ne!(
            vault_file(dir, Network::Mainnet),
            vault_file(dir, Network::Testnet)
        );
        assert!(vault_file(dir, Network::Mainnet).ends_with("coffre-mainnet.kyrovault"));
        assert!(hw_accounts_file(dir, Network::Testnet).ends_with("hw-accounts-testnet.json"));
    }

    #[test]
    fn switch_is_refused_when_forced_or_busy() {
        assert_eq!(
            check_switch(Source::Default, false, false, "mainnet").unwrap(),
            Network::Mainnet
        );
        assert_eq!(
            check_switch(Source::Saved, false, false, "testnet").unwrap(),
            Network::Testnet
        );
        assert!(check_switch(Source::Vault, false, false, "mainnet").is_ok());
        assert!(check_switch(Source::Env, false, false, "mainnet").is_err());
        assert!(check_switch(Source::Saved, true, false, "mainnet").is_err());
        assert!(check_switch(Source::Saved, false, true, "mainnet").is_err());
        assert!(check_switch(Source::Saved, false, false, "regtest").is_err());
    }

    #[test]
    fn dialog_counter_follows_guards() {
        let c = DialogCounter::default();
        assert!(!c.any_open());
        let g1 = c.enter();
        let g2 = c.enter();
        assert!(c.any_open());
        drop(g1);
        assert!(c.any_open());
        drop(g2);
        assert!(!c.any_open());
    }
}
