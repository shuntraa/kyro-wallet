//! Settings › Export/Import: one file with what the phrase cannot restore (address book, labels,
//! watch list, favorites, alerts, settings), encrypted by `wallet_core::seal_backup` under a
//! password chosen for it. The phrase, keys, API keys and the Core password have no field here:
//! every type is an allowlist, and unknown fields are refused both ways.
//!
//! Network settings stay out on purpose: a server or « Tor off » taken from a file would skip the
//! native confirmations of `settings_set`. Rust opens the native file windows; the interface
//! never sees a path, and what is applied from a backup is what Rust decrypted.

use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{Manager as _, State};
use wallet_core::{
    open_backup, seal_backup, KdfParams, Network, WatchAddress, MAX_BACKUP_FILE,
    MAX_WATCH_ADDRESSES,
};
use zeroize::Zeroizing;

use crate::accounts::{account_arg, clean_name, default_name, Chain, VaultAccounts};
use crate::commands::{blocking, check_password_strength};
use crate::commands_hw::guard;
use crate::error::{AppError, AppResult};
use crate::i18n::LanguagePref;
use crate::settings::Settings;
use crate::state::AppState;

const CONTENT_VERSION: u8 = 1;
const FILE_EXTENSION: &str = "kyrobackup";
const MAX_CONTACTS: usize = 5_000;
const MAX_FAVORITES: usize = 1_000;
const MAX_PRICE_ALERTS: usize = 50;
const MAX_LABELS: usize = 5_000;
const MAX_NAME: usize = 200;
const MAX_ADDRESS: usize = 200;

fn invalid(what: &str) -> AppError {
    AppError::InvalidInput(format!("backup file: {what}"))
}

fn clean_text(s: &str, max: usize) -> bool {
    !s.is_empty()
        && s.chars().count() <= max
        && !s
            .chars()
            .any(|c| c.is_control() || crate::dialog_text::is_invisible(c))
}

fn coin_id_ok(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 100
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"-_.".contains(&b))
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupContact {
    name: String,
    address: String,
    family: String,
    sends: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Direction {
    Above,
    Below,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupPriceAlert {
    coin_id: String,
    symbol: String,
    direction: Direction,
    level: f64,
    currency: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupAlerts {
    received: bool,
    prices: Vec<BackupPriceAlert>,
}

/// What lives in the interface's storage; the interface also merges it back.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalData {
    contacts: Vec<BackupContact>,
    favorites: Vec<String>,
    alerts: BackupAlerts,
}

impl LocalData {
    fn validate(&self) -> AppResult<()> {
        if self.contacts.len() > MAX_CONTACTS
            || self.favorites.len() > MAX_FAVORITES
            || self.alerts.prices.len() > MAX_PRICE_ALERTS
        {
            return Err(invalid("too many entries"));
        }
        for c in &self.contacts {
            let address_ok = !c.address.is_empty()
                && c.address.len() <= MAX_ADDRESS
                && c.address.bytes().all(|b| b.is_ascii_graphic());
            let family_ok = !c.family.is_empty()
                && c.family.len() <= 8
                && c.family.bytes().all(|b| b.is_ascii_lowercase());
            if !clean_text(&c.name, MAX_NAME) || !address_ok || !family_ok {
                return Err(invalid("invalid contact"));
            }
        }
        if !self.favorites.iter().all(|f| coin_id_ok(f)) {
            return Err(invalid("invalid favorite"));
        }
        for a in &self.alerts.prices {
            if !coin_id_ok(&a.coin_id)
                || !clean_text(&a.symbol, 32)
                || !a.level.is_finite()
                || a.level <= 0.0
                || !crate::fiat::is_supported(&a.currency)
            {
                return Err(invalid("invalid alert"));
            }
        }
        Ok(())
    }
}

/// The settings that travel. No server, API key, Tor switch or account list, and nothing tied to
/// this computer (start with Windows).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupSettings {
    currency: String,
    auto_lock_secs: u64,
    hide_balances_on_start: bool,
    capture_protection: bool,
    clipboard_guard: bool,
    language: LanguagePref,
    auto_update: bool,
    weekly_count: bool,
    close_to_tray: bool,
    lock_on_hide: bool,
}

impl From<&Settings> for BackupSettings {
    fn from(s: &Settings) -> Self {
        BackupSettings {
            currency: s.currency.clone(),
            auto_lock_secs: s.auto_lock_secs,
            hide_balances_on_start: s.hide_balances_on_start,
            capture_protection: s.capture_protection,
            clipboard_guard: s.clipboard_guard,
            language: s.language,
            auto_update: s.auto_update,
            weekly_count: s.weekly_count,
            close_to_tray: s.close_to_tray,
            lock_on_hide: s.lock_on_hide,
        }
    }
}

impl BackupSettings {
    fn apply_to(&self, s: &mut Settings) {
        s.currency.clone_from(&self.currency);
        s.auto_lock_secs = self.auto_lock_secs;
        s.hide_balances_on_start = self.hide_balances_on_start;
        s.capture_protection = self.capture_protection;
        s.clipboard_guard = self.clipboard_guard;
        s.language = self.language;
        s.auto_update = self.auto_update;
        s.weekly_count = self.weekly_count;
        s.close_to_tray = self.close_to_tray;
        s.lock_on_hide = self.lock_on_hide;
    }

    fn validate(&self) -> AppResult<()> {
        let mut s = Settings::default();
        self.apply_to(&mut s);
        s.validate().map_err(|_| invalid("invalid settings"))
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupWatch {
    label: String,
    family: String,
    value: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupLabel {
    chain: Chain,
    index: u32,
    name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupContent {
    version: u8,
    created_at: u64,
    /// `mainnet` or `testnet`: the watch list and the labels belong to one network.
    network: String,
    settings: BackupSettings,
    watch: Vec<BackupWatch>,
    labels: Vec<BackupLabel>,
    local: LocalData,
}

impl BackupContent {
    /// The decrypted bytes, checked field by field: an authentic file of another version, or
    /// values Kyro would never write, stop here.
    fn parse(bytes: &[u8]) -> AppResult<BackupContent> {
        let c: BackupContent =
            serde_json::from_slice(bytes).map_err(|_| invalid("not a Kyro backup"))?;
        if c.version != CONTENT_VERSION {
            return Err(invalid("made by a newer version of Kyro"));
        }
        if c.network != "mainnet" && c.network != "testnet" {
            return Err(invalid("unknown network"));
        }
        if c.watch.len() > MAX_LABELS || c.labels.len() > MAX_LABELS {
            return Err(invalid("too many entries"));
        }
        for l in &c.labels {
            account_arg(Some(l.index)).map_err(|_| invalid("invalid account"))?;
            clean_name(&l.name).map_err(|_| invalid("invalid account"))?;
        }
        c.settings.validate()?;
        c.local.validate()?;
        Ok(c)
    }
}

fn network_key(net: Network) -> &'static str {
    match net {
        Network::Mainnet => "mainnet",
        Network::Testnet => "testnet",
    }
}

/// Names the user gave: a default name needs no backup.
fn own_labels(accounts: &VaultAccounts, net: Network) -> Vec<BackupLabel> {
    accounts
        .all(net)
        .into_iter()
        .flat_map(|(chain, list)| {
            list.into_iter()
                .filter(move |e| e.index != 0 || e.name != default_name(chain, 0))
                .map(move |e| BackupLabel {
                    chain,
                    index: e.index,
                    name: e.name,
                })
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchRename {
    family: String,
    value: String,
    current: String,
    backup: String,
}

#[derive(Debug, Default, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchPlan {
    add: Vec<BackupWatch>,
    rename: Vec<WatchRename>,
    same: usize,
    /// Not valid for this network, a private key, or past the list's limit.
    refused: usize,
}

fn same_watch(family: &str, a: &str, b: &str) -> bool {
    if family == "evm" || family == "apt" {
        a.eq_ignore_ascii_case(b)
    } else {
        a == b
    }
}

fn plan_watch(existing: &[WatchAddress], incoming: &[BackupWatch], net: Network) -> WatchPlan {
    let mut plan = WatchPlan::default();
    for w in incoming {
        let found = existing
            .iter()
            .find(|e| e.family == w.family && same_watch(&e.family, &e.value, &w.value));
        if let Some(e) = found {
            if e.label == w.label {
                plan.same += 1;
            } else {
                plan.rename.push(WatchRename {
                    family: w.family.clone(),
                    value: w.value.clone(),
                    current: e.label.clone(),
                    backup: w.label.clone(),
                });
            }
            continue;
        }
        let checked = WatchAddress {
            id: "wa-0000000000000000".into(),
            label: w.label.clone(),
            family: w.family.clone(),
            value: w.value.clone(),
        };
        let twice = plan
            .add
            .iter()
            .any(|a| a.family == w.family && same_watch(&a.family, &a.value, &w.value));
        if checked.validate(net).is_err() || existing.len() + plan.add.len() >= MAX_WATCH_ADDRESSES
        {
            plan.refused += 1;
        } else if twice {
            plan.same += 1;
        } else {
            plan.add.push(w.clone());
        }
    }
    plan
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LabelRename {
    chain: Chain,
    index: u32,
    current: String,
    backup: String,
}

#[derive(Debug, Default, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LabelPlan {
    add: Vec<BackupLabel>,
    rename: Vec<LabelRename>,
    same: usize,
}

fn plan_labels(current: &VaultAccounts, incoming: &[BackupLabel], net: Network) -> LabelPlan {
    let mut plan = LabelPlan::default();
    for l in incoming {
        match current.name_of(net, l.chain, l.index) {
            Some(name) if name == l.name => plan.same += 1,
            Some(name) => plan.rename.push(LabelRename {
                chain: l.chain,
                index: l.index,
                current: name,
                backup: l.name.clone(),
            }),
            None => plan.add.push(l.clone()),
        }
    }
    plan
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingChange {
    key: String,
    current: serde_json::Value,
    backup: serde_json::Value,
}

fn setting_changes(current: &Settings, backup: &BackupSettings) -> AppResult<Vec<SettingChange>> {
    let old = serde_json::to_value(BackupSettings::from(current))?;
    let new = serde_json::to_value(backup)?;
    let (Some(old), Some(new)) = (old.as_object(), new.as_object()) else {
        return Err(AppError::Internal("settings are not an object".into()));
    };
    Ok(new
        .iter()
        .filter(|(k, v)| old.get(*k) != Some(*v))
        .map(|(k, v)| SettingChange {
            key: k.clone(),
            current: old.get(k).cloned().unwrap_or_default(),
            backup: v.clone(),
        })
        .collect())
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupPreview {
    created_at: u64,
    /// Made on the other network: its watch list and labels are left out.
    other_network: bool,
    local: LocalData,
    watch: WatchPlan,
    labels: LabelPlan,
    settings: Vec<SettingChange>,
}

fn preview(
    content: &BackupContent,
    net: Network,
    settings: &Settings,
    accounts: &VaultAccounts,
    watch: &[WatchAddress],
) -> AppResult<BackupPreview> {
    let other_network = content.network != network_key(net);
    Ok(BackupPreview {
        created_at: content.created_at,
        other_network,
        local: content.local.clone(),
        watch: if other_network {
            WatchPlan::default()
        } else {
            plan_watch(watch, &content.watch, net)
        },
        labels: if other_network {
            LabelPlan::default()
        } else {
            plan_labels(accounts, &content.labels, net)
        },
        settings: setting_changes(settings, &content.settings)?,
    })
}

/// What the user ticked on the import screen. Everything is off unless asked for.
#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupChoices {
    add_watch: bool,
    add_labels: bool,
    replace_names: bool,
    settings: bool,
}

/// The file picked, then the content decrypted, between the steps of an import.
#[derive(Default)]
pub struct BackupState {
    picked: Mutex<Option<PathBuf>>,
    opened: Mutex<Option<BackupContent>>,
}

fn read_limited(path: &Path) -> AppResult<String> {
    let file = std::fs::File::open(path).map_err(|_| invalid("cannot be read"))?;
    let mut bytes = Vec::new();
    file.take(MAX_BACKUP_FILE as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| invalid("cannot be read"))?;
    if bytes.len() > MAX_BACKUP_FILE {
        return Err(invalid("too large"));
    }
    String::from_utf8(bytes).map_err(|_| invalid("not a Kyro backup"))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

/// Encrypts the content to a file chosen in the native window; false if the user cancels.
#[tauri::command]
pub async fn backup_export(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    password: String,
    local: LocalData,
) -> AppResult<bool> {
    use tauri_plugin_dialog::DialogExt as _;
    let password = Zeroizing::new(password);
    guard(&state)?;
    check_password_strength(&password)?;
    local.validate()?;
    let watch = crate::commands_watch::load(&state.watch_path, state.network)?;
    let content = BackupContent {
        version: CONTENT_VERSION,
        created_at: now_ms(),
        network: network_key(state.network).into(),
        settings: BackupSettings::from(&state.settings()),
        watch: watch
            .addresses
            .into_iter()
            .map(|w| BackupWatch {
                label: w.label,
                family: w.family,
                value: w.value,
            })
            .collect(),
        labels: own_labels(&state.vault_accounts(), state.network),
        local,
    };
    let json = Zeroizing::new(serde_json::to_vec(&content)?);
    let title = crate::i18n::current().pick("Enregistrer la sauvegarde", "Save the backup");
    let handle = app.clone();
    let picked = blocking(move || {
        Ok(handle
            .dialog()
            .file()
            .set_title(title)
            .set_file_name(format!("kyro-backup.{FILE_EXTENSION}"))
            .add_filter("Kyro", &[FILE_EXTENSION])
            .blocking_save_file())
    })
    .await?;
    let Some(file) = picked else {
        return Ok(false);
    };
    let path = file
        .into_path()
        .map_err(|_| AppError::InvalidInput("a local file is expected".into()))?;
    let text =
        blocking(move || Ok(seal_backup(&json, &password, KdfParams::production())?)).await?;
    crate::settings::write_atomic(&path, text.as_bytes())?;
    Ok(true)
}

/// Native open window. Returns the file's name for the screen; the path stays in Rust.
#[tauri::command]
pub async fn backup_pick(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    backup: State<'_, BackupState>,
) -> AppResult<Option<String>> {
    use tauri_plugin_dialog::DialogExt as _;
    guard(&state)?;
    let title = crate::i18n::current().pick("Choisir une sauvegarde", "Choose a backup");
    let handle = app.clone();
    let picked = blocking(move || {
        Ok(handle
            .dialog()
            .file()
            .set_title(title)
            .add_filter("Kyro", &[FILE_EXTENSION])
            .blocking_pick_file())
    })
    .await?;
    let Some(file) = picked else {
        return Ok(None);
    };
    let path = file
        .into_path()
        .map_err(|_| AppError::InvalidInput("a local file is expected".into()))?;
    let name = path
        .file_name()
        .map(|n| crate::dialog_text::field(&n.to_string_lossy(), 120));
    *crate::net::lock(&backup.picked) = Some(path);
    *crate::net::lock(&backup.opened) = None;
    Ok(name)
}

/// Decrypts and checks the picked file, and says what importing it would change. Nothing is
/// written.
#[tauri::command]
pub async fn backup_open(
    state: State<'_, AppState>,
    backup: State<'_, BackupState>,
    password: String,
) -> AppResult<BackupPreview> {
    let password = Zeroizing::new(password);
    guard(&state)?;
    let path = crate::net::lock(&backup.picked)
        .clone()
        .ok_or_else(|| AppError::InvalidInput("choose a backup file first".into()))?;
    let content = blocking(move || {
        let text = read_limited(&path)?;
        let plain = open_backup(&text, &password)?;
        BackupContent::parse(&plain)
    })
    .await?;
    let watch = crate::commands_watch::load(&state.watch_path, state.network)?;
    let out = preview(
        &content,
        state.network,
        &state.settings(),
        &state.vault_accounts(),
        &watch.addresses,
    )?;
    *crate::net::lock(&backup.opened) = Some(content);
    Ok(out)
}

fn apply_labels(
    accounts: &mut VaultAccounts,
    plan: &LabelPlan,
    net: Network,
    choices: BackupChoices,
) {
    if choices.add_labels {
        for l in &plan.add {
            // Past the chain's limit, the account just stays out.
            let _ = accounts.add(net, l.chain, l.index, &l.name);
        }
    }
    if choices.replace_names {
        for r in &plan.rename {
            let _ = accounts.rename(net, r.chain, r.index, &r.backup);
        }
    }
}

/// Applies what the user ticked, from the content Rust decrypted. Returns the settings as
/// `settings_get` does.
#[tauri::command]
pub fn backup_apply(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    backup: State<'_, BackupState>,
    choices: BackupChoices,
) -> AppResult<serde_json::Value> {
    guard(&state)?;
    let content = crate::net::lock(&backup.opened)
        .take()
        .ok_or_else(|| AppError::InvalidInput("open a backup file first".into()))?;
    *crate::net::lock(&backup.picked) = None;
    let net = state.network;
    if content.network == network_key(net) {
        {
            let _write = crate::hw::lock(&state.watch_store_lock);
            let mut store = crate::commands_watch::load(&state.watch_path, net)?;
            let plan = plan_watch(&store.addresses, &content.watch, net);
            if choices.add_watch {
                for w in &plan.add {
                    let id = crate::commands_watch::new_id(&store);
                    store.addresses.push(WatchAddress {
                        id,
                        label: w.label.clone(),
                        family: w.family.clone(),
                        value: w.value.clone(),
                    });
                }
            }
            if choices.replace_names {
                for r in &plan.rename {
                    if let Some(e) = store
                        .addresses
                        .iter_mut()
                        .find(|e| e.family == r.family && same_watch(&e.family, &e.value, &r.value))
                    {
                        e.label.clone_from(&r.backup);
                    }
                }
            }
            if choices.add_watch || choices.replace_names {
                crate::commands_watch::save(&state.watch_path, &store, net)?;
            }
        }
        state.update_accounts(|accounts| {
            let plan = plan_labels(accounts, &content.labels, net);
            apply_labels(accounts, &plan, net, choices);
            Ok(())
        })?;
    }
    let old = state.settings();
    if !choices.settings {
        return Ok(old.for_ui());
    }
    let mut next = old.clone();
    content.settings.apply_to(&mut next);
    let saved = state.save_settings(next)?;
    crate::tray::on_settings_saved(&app, &old, &saved);
    if old.capture_protection != saved.capture_protection {
        if let Some(main) = app.get_webview_window("main") {
            let phrase = app.state::<crate::phrase_window::PhraseState>();
            main.set_content_protected(phrase.main_capture(saved.capture_protection))?;
        }
    }
    Ok(saved.for_ui())
}

/// The import screen closed: nothing of the file stays in memory.
#[tauri::command]
pub fn backup_cancel(backup: State<'_, BackupState>) {
    *crate::net::lock(&backup.picked) = None;
    *crate::net::lock(&backup.opened) = None;
}

#[cfg(test)]
mod tests {
    use super::*;

    const PHRASE: &str = "abandon abandon abandon abandon abandon abandon abandon abandon \
                          abandon abandon abandon about";
    const BTC: &str = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
    const EVM: &str = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

    fn sample() -> BackupContent {
        BackupContent {
            version: CONTENT_VERSION,
            created_at: 1_800_000_000_000,
            network: "mainnet".into(),
            settings: BackupSettings::from(&Settings::default()),
            watch: vec![BackupWatch {
                label: "Cold".into(),
                family: "btc".into(),
                value: BTC.into(),
            }],
            labels: vec![BackupLabel {
                chain: Chain::Btc,
                index: 0,
                name: "Savings".into(),
            }],
            local: LocalData {
                contacts: vec![BackupContact {
                    name: "Alice".into(),
                    address: EVM.into(),
                    family: "evm".into(),
                    sends: 3,
                }],
                favorites: vec!["bitcoin".into()],
                alerts: BackupAlerts {
                    received: true,
                    prices: vec![BackupPriceAlert {
                        coin_id: "bitcoin".into(),
                        symbol: "BTC".into(),
                        direction: Direction::Above,
                        level: 100_000.0,
                        currency: "USD".into(),
                    }],
                },
            },
        }
    }

    fn edit(f: impl FnOnce(&mut serde_json::Value)) -> Vec<u8> {
        let mut v = serde_json::to_value(sample()).unwrap();
        f(&mut v);
        serde_json::to_vec(&v).unwrap()
    }

    fn watch(label: &str, family: &str, value: &str) -> WatchAddress {
        WatchAddress {
            id: "wa-0123456789abcdef".into(),
            label: label.into(),
            family: family.into(),
            value: value.into(),
        }
    }

    #[test]
    fn round_trip_through_the_encrypted_file() {
        let c = sample();
        let json = serde_json::to_vec(&c).unwrap();
        let text = seal_backup(&json, "a long password", KdfParams::minimum()).unwrap();
        for clear in ["Alice", EVM, BTC, "Savings", "100000"] {
            assert!(!text.contains(clear), "{clear} in the file");
        }
        let plain = open_backup(&text, "a long password").unwrap();
        assert_eq!(BackupContent::parse(&plain).unwrap(), c);
    }

    #[test]
    fn wrong_password_and_tampered_file_read_nothing() {
        let json = serde_json::to_vec(&sample()).unwrap();
        let text = seal_backup(&json, "a long password", KdfParams::minimum()).unwrap();
        assert!(matches!(
            open_backup(&text, "not the password").map(|_| ()),
            Err(wallet_core::Error::WrongPassword)
        ));
        let mut v: serde_json::Value = serde_json::from_str(&text).unwrap();
        let tampered = v["sealed"]["ciphertext"]
            .as_str()
            .unwrap()
            .replace('A', "B");
        v["sealed"]["ciphertext"] = tampered.into();
        assert!(open_backup(&v.to_string(), "a long password").is_err());
    }

    #[test]
    fn nothing_secret_is_inside() {
        let mut s = Settings::default();
        s.api_keys.coingecko = Some("CG-SECRET-KEY".into());
        s.api_keys.zerox = Some("ZEROX-SECRET-KEY".into());
        s.api_keys.trongrid = Some("TRON-SECRET-KEY".into());
        s.tor.enabled = false;
        let mut c = sample();
        c.settings = BackupSettings::from(&s);
        let json = serde_json::to_string(&c).unwrap();
        for secret in ["CG-SECRET", "ZEROX-SECRET", "TRON-SECRET", "abandon"] {
            assert!(!json.contains(secret), "{secret}");
        }
        for field in [
            "apiKeys",
            "servers",
            "tor",
            "mnemonic",
            "phrase",
            "seed",
            "accounts",
            "startMinimized",
        ] {
            assert!(!json.contains(&format!("\"{field}\"")), "{field}");
        }
    }

    #[test]
    fn only_these_settings_travel() {
        let v = serde_json::to_value(BackupSettings::from(&Settings::default())).unwrap();
        let mut keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "autoLockSecs",
                "autoUpdate",
                "captureProtection",
                "clipboardGuard",
                "closeToTray",
                "currency",
                "hideBalancesOnStart",
                "language",
                "lockOnHide",
                "weeklyCount"
            ]
        );
    }

    #[test]
    fn importing_settings_leaves_network_and_secrets_alone() {
        let mut s = Settings::default();
        s.api_keys.coingecko = Some("key".into());
        s.tor.enabled = false;
        s.start_minimized = true;
        let mut b = BackupSettings::from(&Settings::default());
        b.currency = "JPY".into();
        b.apply_to(&mut s);
        assert_eq!(s.currency, "JPY");
        assert_eq!(s.api_keys.coingecko.as_deref(), Some("key"));
        assert!(!s.tor.enabled && s.start_minimized);
    }

    #[test]
    fn strict_content() {
        assert!(BackupContent::parse(&serde_json::to_vec(&sample()).unwrap()).is_ok());
        let bad: Vec<Vec<u8>> = vec![
            b"not json".to_vec(),
            edit(|v| v["version"] = 2.into()),
            edit(|v| v["network"] = "regtest".into()),
            edit(|v| v["mnemonic"] = PHRASE.into()),
            edit(|v| v["settings"]["apiKeys"] = serde_json::json!({ "zerox": "k" })),
            edit(|v| v["settings"]["servers"] = serde_json::json!({})),
            edit(|v| v["settings"]["tor"] = serde_json::json!({ "enabled": false })),
            edit(|v| v["settings"]["autoLockSecs"] = 1.into()),
            edit(|v| v["settings"]["currency"] = "XXX".into()),
            edit(|v| v["local"]["contacts"][0]["name"] = "a\nb".into()),
            edit(|v| v["local"]["contacts"][0]["name"] = "a\u{202e}b".into()),
            edit(|v| v["local"]["contacts"][0]["address"] = "with space".into()),
            edit(|v| v["local"]["contacts"][0]["extra"] = 1.into()),
            edit(|v| v["local"]["favorites"][0] = "../x".into()),
            edit(|v| v["local"]["alerts"]["prices"][0]["level"] = (-1).into()),
            edit(|v| v["local"]["alerts"]["prices"][0]["direction"] = "sideways".into()),
            edit(|v| v["labels"][0]["name"] = "".into()),
            edit(|v| v["labels"][0]["index"] = 4_000_000_000u32.into()),
        ];
        for b in bad {
            assert!(
                BackupContent::parse(&b).is_err(),
                "{}",
                String::from_utf8_lossy(&b)
            );
        }
    }

    #[test]
    fn too_many_entries_are_refused() {
        let mut c = sample();
        c.local.contacts = vec![c.local.contacts[0].clone(); MAX_CONTACTS + 1];
        assert!(BackupContent::parse(&serde_json::to_vec(&c).unwrap()).is_err());
        let mut c = sample();
        c.local.alerts.prices = vec![c.local.alerts.prices[0].clone(); MAX_PRICE_ALERTS + 1];
        assert!(BackupContent::parse(&serde_json::to_vec(&c).unwrap()).is_err());
    }

    #[test]
    fn watch_merge_adds_keeps_and_asks() {
        let existing = [
            watch("Same", "btc", BTC),
            watch("Mine", "evm", &EVM.to_lowercase()),
        ];
        let incoming = [
            BackupWatch {
                label: "Same".into(),
                family: "btc".into(),
                value: BTC.into(),
            },
            BackupWatch {
                label: "Theirs".into(),
                family: "evm".into(),
                value: EVM.into(),
            },
            BackupWatch {
                label: "New".into(),
                family: "evm".into(),
                value: "0x000000000000000000000000000000000000dEaD".into(),
            },
            BackupWatch {
                label: "Key".into(),
                family: "btc".into(),
                value: "xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi".into(),
            },
        ];
        let plan = plan_watch(&existing, &incoming, Network::Mainnet);
        assert_eq!(plan.same, 1);
        assert_eq!(plan.add.len(), 1);
        assert_eq!(plan.add[0].label, "New");
        assert_eq!(plan.rename.len(), 1);
        assert_eq!(
            (
                plan.rename[0].current.as_str(),
                plan.rename[0].backup.as_str()
            ),
            ("Mine", "Theirs")
        );
        assert_eq!(plan.refused, 1, "a private key never enters the list");
    }

    #[test]
    fn watch_merge_stays_within_the_limit() {
        let existing = vec![watch("x", "btc", BTC); MAX_WATCH_ADDRESSES];
        let incoming = [BackupWatch {
            label: "New".into(),
            family: "evm".into(),
            value: EVM.into(),
        }];
        let plan = plan_watch(&existing, &incoming, Network::Mainnet);
        assert!(plan.add.is_empty());
        assert_eq!(plan.refused, 1);
    }

    #[test]
    fn labels_never_change_without_being_asked() {
        let net = Network::Mainnet;
        let mut accounts = VaultAccounts::default();
        accounts.rename(net, Chain::Btc, 0, "Mine").unwrap();
        let incoming = [
            BackupLabel {
                chain: Chain::Btc,
                index: 0,
                name: "Theirs".into(),
            },
            BackupLabel {
                chain: Chain::Btc,
                index: 1,
                name: "Second".into(),
            },
        ];
        let plan = plan_labels(&accounts, &incoming, net);
        assert_eq!((plan.add.len(), plan.rename.len()), (1, 1));

        let mut kept = accounts.clone();
        let add_only = BackupChoices {
            add_labels: true,
            ..BackupChoices::default()
        };
        apply_labels(&mut kept, &plan, net, add_only);
        assert_eq!(kept.name_of(net, Chain::Btc, 0).unwrap(), "Mine");
        assert_eq!(kept.name_of(net, Chain::Btc, 1).unwrap(), "Second");

        let mut none = accounts.clone();
        apply_labels(&mut none, &plan, net, BackupChoices::default());
        assert_eq!(none, accounts);

        let replace = BackupChoices {
            replace_names: true,
            ..BackupChoices::default()
        };
        apply_labels(&mut accounts, &plan, net, replace);
        assert_eq!(accounts.name_of(net, Chain::Btc, 0).unwrap(), "Theirs");
    }

    #[test]
    fn default_names_are_not_labels() {
        let net = Network::Mainnet;
        let mut accounts = VaultAccounts::default();
        assert!(own_labels(&accounts, net).is_empty());
        accounts.rename(net, Chain::Btc, 0, "Mine").unwrap();
        accounts.add(net, Chain::Evm, 1, "Second").unwrap();
        let labels = own_labels(&accounts, net);
        assert_eq!(labels.len(), 2);
        assert!(labels.iter().all(|l| clean_name(&l.name).is_ok()));
    }

    #[test]
    fn preview_lists_setting_changes_and_leaves_other_networks_out() {
        let mut c = sample();
        c.settings.currency = "JPY".into();
        let s = Settings::default();
        let accounts = VaultAccounts::default();
        let p = preview(&c, Network::Mainnet, &s, &accounts, &[]).unwrap();
        assert!(!p.other_network);
        assert_eq!(p.settings.len(), 1);
        assert_eq!(p.settings[0].key, "currency");
        assert_eq!(p.settings[0].backup, "JPY");
        assert_eq!(p.watch.add.len(), 1);
        let other = preview(&c, Network::Testnet, &s, &accounts, &[]).unwrap();
        assert!(other.other_network);
        assert!(other.watch.add.is_empty() && other.labels.add.is_empty());
    }

    #[test]
    fn a_file_read_stops_at_the_limit() {
        let dir = std::env::temp_dir().join(format!("kyro-backup-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let big = dir.join("big");
        std::fs::write(&big, vec![b' '; MAX_BACKUP_FILE + 1]).unwrap();
        assert!(read_limited(&big).is_err());
        let binary = dir.join("binary");
        std::fs::write(&binary, [0xff, 0xfe]).unwrap();
        assert!(read_limited(&binary).is_err());
        assert!(read_limited(&dir.join("missing")).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
