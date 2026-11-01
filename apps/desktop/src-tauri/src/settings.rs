use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::accounts::VaultAccounts;
use crate::error::{AppError, AppResult};
use crate::servers::{RpcServer, Servers};

/// Legacy (≤ B2a) `settings.rpc`: still accepted on input and migrated into `servers`, never
/// written back.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct RpcOverrides {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ethereum: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub solana: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub esplora: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ApiKeys {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub coingecko: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub zerox: Option<String>,
    /// TronGrid (`TRON-PRO-API-KEY`), optional.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trongrid: Option<String>,
}

impl ApiKeys {
    /// Every key name Settings supports (`settings_get.apiKeysSet`, `settings_set.apiKeys`).
    /// (1inch was removed: a key left in an old settings.json is ignored and dropped on next save.)
    pub const NAMES: [&'static str; 3] = ["coingecko", "zerox", "trongrid"];

    fn get(&self, name: &str) -> Option<&Option<String>> {
        Some(match name {
            "coingecko" => &self.coingecko,
            "zerox" => &self.zerox,
            "trongrid" => &self.trongrid,
            _ => return None,
        })
    }

    fn slot(&mut self, name: &str) -> Option<&mut Option<String>> {
        Some(match name {
            "coingecko" => &mut self.coingecko,
            "zerox" => &mut self.zerox,
            "trongrid" => &mut self.trongrid,
            _ => return None,
        })
    }

    /// `{ coingecko: bool, zerox: bool, … }`: which keys are saved, never their values.
    pub fn set_flags(&self) -> serde_json::Value {
        serde_json::Value::Object(
            Self::NAMES
                .iter()
                .map(|n| {
                    let set = self.get(n).is_some_and(Option::is_some);
                    ((*n).to_owned(), serde_json::Value::Bool(set))
                })
                .collect(),
        )
    }

    /// `settings_set` merge rule for `apiKeys.<name>`: absent (or `null`) = unchanged, `""` =
    /// removed, a non-empty string = set (trimmed; control characters refused).
    pub fn apply_patch(&mut self, patch: &serde_json::Value) -> AppResult<()> {
        let obj = patch
            .as_object()
            .ok_or_else(|| AppError::InvalidInput("apiKeys : objet attendu".into()))?;
        for (name, v) in obj {
            let slot = self
                .slot(name)
                .ok_or_else(|| AppError::InvalidInput(format!("clé API inconnue « {name} »")))?;
            match v {
                serde_json::Value::Null => {}
                serde_json::Value::String(s) if s.is_empty() => *slot = None,
                serde_json::Value::String(s) => {
                    let t = s.trim();
                    if t.is_empty() || t.chars().any(char::is_control) {
                        return Err(AppError::InvalidInput(format!(
                            "clé API « {name} » invalide (vide ou caractères de contrôle)"
                        )));
                    }
                    *slot = Some(t.to_owned());
                }
                _ => {
                    return Err(AppError::InvalidInput(format!(
                        "clé API « {name} » : texte attendu"
                    )))
                }
            }
        }
        Ok(())
    }
}

/// Tor is ON by default; turning it off is an explicit user choice (the UI confirms it).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TorSettings {
    pub enabled: bool,
}

impl Default for TorSettings {
    fn default() -> Self {
        Self { enabled: true }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub currency: String,
    pub auto_lock_secs: u64,
    pub hide_balances_on_start: bool,
    pub capture_protection: bool,
    pub clipboard_guard: bool,
    #[serde(skip_serializing)]
    pub rpc: RpcOverrides,
    pub servers: Servers,
    pub api_keys: ApiKeys,
    pub tor: TorSettings,
    /// Display language of the UI and the native dialogs: `auto` (system), `fr` or `en`.
    /// Read leniently from the file (an unknown value = `auto`, the other settings are kept);
    /// `settings_set` refuses anything else ([`Settings::from_ui`]).
    #[serde(deserialize_with = "lenient_language")]
    pub language: crate::i18n::LanguagePref,
    /// The vault's account lists (see `accounts.rs`). Managed only by the `vault_account_*`
    /// commands: never sent by `settings_get`, never taken from `settings_set`.
    pub accounts: VaultAccounts,
}

fn lenient_language<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<crate::i18n::LanguagePref, D::Error> {
    let v = serde_json::Value::deserialize(d)?;
    Ok(serde_json::from_value(v).unwrap_or_default())
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            currency: "EUR".into(),
            auto_lock_secs: 15 * 60,
            hide_balances_on_start: false,
            capture_protection: true,
            clipboard_guard: true,
            rpc: RpcOverrides::default(),
            servers: Servers::default(),
            api_keys: ApiKeys::default(),
            tor: TorSettings::default(),
            language: crate::i18n::LanguagePref::Auto,
            accounts: VaultAccounts::default(),
        }
    }
}

impl Settings {
    pub fn load(path: &Path, net: wallet_core::Network) -> Settings {
        let mut s: Settings = fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        s.migrate_legacy_rpc(net);
        s
    }

    /// Moves legacy `rpc.{esplora,ethereum,solana}` into `servers` for `net` (only where no
    /// server is set yet), then clears `rpc`.
    pub fn migrate_legacy_rpc(&mut self, net: wallet_core::Network) {
        use crate::servers::{solana_cluster, BtcServer};
        let rpc = std::mem::take(&mut self.rpc);
        if let Some(url) = rpc.esplora {
            let slot = match net {
                wallet_core::Network::Mainnet => &mut self.servers.bitcoin.mainnet,
                wallet_core::Network::Testnet => &mut self.servers.bitcoin.testnet4,
            };
            if slot.is_none() {
                *slot = Some(BtcServer::Esplora { url });
            }
        }
        if let Some(url) = rpc.ethereum {
            let chain = match net {
                wallet_core::Network::Mainnet => "1",
                wallet_core::Network::Testnet => "11155111",
            };
            self.servers
                .evm
                .entry(chain.into())
                .or_insert(RpcServer { url });
        }
        if let Some(url) = rpc.solana {
            self.servers
                .solana
                .entry(solana_cluster(net).into())
                .or_insert(RpcServer { url });
        }
    }

    /// What `settings_get` / `settings_set` return: secrets removed — `hasPassword` instead of
    /// the Bitcoin Core password, `apiKeysSet` (booleans) instead of `apiKeys`.
    pub fn for_ui(&self) -> serde_json::Value {
        let mut s = self.clone();
        s.servers = s.servers.redacted();
        let flags = s.api_keys.set_flags();
        s.api_keys = ApiKeys::default();
        let mut v = serde_json::to_value(&s).unwrap_or_default();
        if let Some(o) = v.as_object_mut() {
            o.remove("apiKeys");
            o.remove("accounts");
            o.insert("apiKeysSet".into(), flags);
        }
        v
    }

    /// Parses a `settings_set` payload: `apiKeys` is a patch applied to `current`'s keys (see
    /// [`ApiKeys::apply_patch`]); `apiKeysSet` is ignored.
    pub fn from_ui(mut v: serde_json::Value, current: &ApiKeys) -> AppResult<Settings> {
        let patch = v.as_object_mut().and_then(|o| {
            o.remove("apiKeysSet");
            o.remove("accounts");
            o.remove("apiKeys")
        });
        if let Some(lang) = v.get("language") {
            serde_json::from_value::<crate::i18n::LanguagePref>(lang.clone()).map_err(|_| {
                AppError::InvalidInput("langue : « auto », « fr » ou « en »".into())
            })?;
        }
        let mut s: Settings = serde_json::from_value(v)
            .map_err(|e| AppError::InvalidInput(format!("réglages invalides : {e}")))?;
        s.api_keys = current.clone();
        if let Some(p) = patch.filter(|p| !p.is_null()) {
            s.api_keys.apply_patch(&p)?;
        }
        Ok(s)
    }

    pub fn save(&self, path: &Path) -> AppResult<()> {
        write_atomic(path, serde_json::to_string_pretty(self)?.as_bytes())
    }

    /// Rejects values the rest of the app relies on being sane.
    pub fn validate(&self) -> AppResult<()> {
        if self.currency != "EUR" && self.currency != "USD" {
            return Err(AppError::InvalidInput("devise : EUR ou USD".into()));
        }
        if !(60..=3600).contains(&self.auto_lock_secs) {
            return Err(AppError::InvalidInput(
                "verrouillage automatique : entre 1 et 60 minutes".into(),
            ));
        }
        self.servers.validate(self.tor.enabled)
    }
}

/// `<file name>.<suffix>` next to `path` (each file gets its own temporary name).
fn sibling(path: &Path, suffix: &str) -> std::path::PathBuf {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    path.with_file_name(format!("{name}.{suffix}"))
}

/// Writes `bytes` to a file readable by the owner only on Unix (0600; settings.json holds API
/// keys and maybe the Bitcoin Core password), flushed to disk.
fn write_private(path: &Path, bytes: &[u8], create_new: bool) -> std::io::Result<()> {
    use std::io::Write as _;
    let mut opts = fs::OpenOptions::new();
    opts.write(true);
    if create_new {
        opts.create_new(true);
    } else {
        opts.create(true).truncate(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        opts.mode(0o600);
    }
    let mut f = opts.open(path)?;
    f.write_all(bytes)?;
    f.sync_all()
}

/// Write to a temp file then rename, so a crash never leaves a half-written vault or settings
/// file. Owner-only permissions on Unix (the temp file is created 0600, before any byte).
pub fn write_atomic(path: &Path, bytes: &[u8]) -> AppResult<()> {
    let tmp = sibling(path, "tmp");
    let _ = fs::remove_file(&tmp);
    write_private(&tmp, bytes, true)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

/// Creates `path` with `bytes`, refusing to replace an existing file (`AlreadyExists`), and
/// never leaving a half-written file: written to a temp file first, then hard-linked into
/// place (atomic, fails if the target exists). A file system without hard links falls back to
/// `create_new` on the target itself.
pub fn write_new(path: &Path, bytes: &[u8]) -> AppResult<()> {
    let exists = || AppError::InvalidInput("un coffre existe déjà sur cet appareil".into());
    let tmp = sibling(path, "new.tmp");
    let _ = fs::remove_file(&tmp);
    write_private(&tmp, bytes, true)?;
    let linked = fs::hard_link(&tmp, path);
    let _ = fs::remove_file(&tmp);
    match linked {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Err(exists()),
        Err(_) => match write_private(path, bytes, true) {
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Err(exists()),
            other => Ok(other?),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::servers::{BtcServer, CoreAuth};
    use wallet_core::Network;

    #[test]
    fn legacy_rpc_is_migrated_and_never_written_back() {
        let json = r#"{"currency":"USD","rpc":{"esplora":"https://esplora.example/api","ethereum":"https://eth.example","solana":"https://sol.example"}}"#;
        let mut s: Settings = serde_json::from_str(json).unwrap();
        s.migrate_legacy_rpc(Network::Testnet);
        assert_eq!(
            s.servers.bitcoin.testnet4,
            Some(BtcServer::Esplora {
                url: "https://esplora.example/api".into()
            })
        );
        assert_eq!(s.servers.evm["11155111"].url, "https://eth.example");
        assert_eq!(s.servers.solana["devnet"].url, "https://sol.example");
        assert!(s.tor.enabled, "Tor stays on by default");
        let out = serde_json::to_value(&s).unwrap();
        assert!(out.get("rpc").is_none());
        assert!(out.get("servers").is_some());
        assert!(s.validate().is_ok());
    }

    #[test]
    fn ui_view_never_contains_the_core_password() {
        let mut s = Settings::default();
        s.servers.bitcoin.mainnet = Some(BtcServer::Core {
            url: "http://127.0.0.1:8332".into(),
            auth: CoreAuth::Userpass {
                user: "kyro".into(),
                password: Some("hunter2".into()),
                has_password: true,
            },
        });
        let ui = serde_json::to_string(&s.for_ui()).unwrap();
        assert!(!ui.contains("hunter2"));
        assert!(ui.contains("hasPassword"));
        // ...but the file on disk keeps it.
        assert!(serde_json::to_string(&s).unwrap().contains("hunter2"));
    }

    fn with_keys() -> Settings {
        Settings {
            api_keys: ApiKeys {
                coingecko: Some("CG-secret-1".into()),
                zerox: None,
                trongrid: Some("tron-secret-3".into()),
            },
            ..Settings::default()
        }
    }

    #[test]
    fn old_oneinch_key_is_ignored_and_dropped() {
        let k: ApiKeys =
            serde_json::from_value(serde_json::json!({ "zerox": "zx", "oneinch": "old" })).unwrap();
        assert_eq!(k.zerox.as_deref(), Some("zx"));
        assert!(!serde_json::to_string(&k).unwrap().contains("old"));
    }

    #[test]
    fn ui_view_never_contains_api_keys() {
        let s = with_keys();
        let ui = s.for_ui();
        let text = ui.to_string();
        for secret in ["CG-secret-1", "tron-secret-3"] {
            assert!(!text.contains(secret), "{secret} leaked");
        }
        assert!(ui.get("apiKeys").is_none());
        assert_eq!(
            ui["apiKeysSet"],
            serde_json::json!({ "coingecko": true, "zerox": false, "trongrid": true })
        );
        // Round trip: the UI sends back what it got (apiKeysSet, no apiKeys): nothing changes,
        // and the response still leaks nothing.
        let back = Settings::from_ui(ui.clone(), &s.api_keys).unwrap();
        assert_eq!(back.api_keys.coingecko.as_deref(), Some("CG-secret-1"));
        assert_eq!(back.api_keys.trongrid.as_deref(), Some("tron-secret-3"));
        assert!(!back.for_ui().to_string().contains("secret"));
        // The file on disk keeps them.
        assert!(serde_json::to_string(&s).unwrap().contains("tron-secret-3"));
    }

    #[test]
    fn account_lists_never_go_through_settings_get_or_set() {
        let mut s = Settings::default();
        s.accounts
            .add(
                Network::Testnet,
                crate::accounts::Chain::Btc,
                1,
                "Bitcoin 2",
            )
            .unwrap();
        let ui = s.for_ui();
        assert!(ui.get("accounts").is_none());
        // A UI sending `accounts` back (or a forged list) is ignored: the caller keeps the
        // stored lists (AppState::save_settings).
        let mut forged = ui.clone();
        forged["accounts"] =
            serde_json::json!({ "testnet": { "btc": [{ "index": 9, "name": "x" }] } });
        let back = Settings::from_ui(forged, &s.api_keys).unwrap();
        assert_eq!(back.accounts, VaultAccounts::default());
        // On disk, the lists are kept.
        let disk: Settings = serde_json::from_str(&serde_json::to_string(&s).unwrap()).unwrap();
        assert_eq!(disk.accounts, s.accounts);
    }

    #[test]
    fn api_key_merge_rule() {
        let s = with_keys();
        let mut ui = s.for_ui();
        // Absent = unchanged, "" = removed, non-empty = set (trimmed), null = unchanged.
        ui["apiKeys"] =
            serde_json::json!({ "coingecko": "", "zerox": "  0x-new \t", "trongrid": null });
        let n = Settings::from_ui(ui.clone(), &s.api_keys).unwrap();
        assert_eq!(n.api_keys.coingecko, None);
        assert_eq!(n.api_keys.zerox.as_deref(), Some("0x-new"));
        assert_eq!(n.api_keys.trongrid.as_deref(), Some("tron-secret-3"));
        assert_eq!(n.for_ui()["apiKeysSet"]["coingecko"], false);
        // Refused: control characters, blank, unknown name, non-string, not an object.
        for bad in [
            serde_json::json!({ "zerox": "abc\ndef" }),
            serde_json::json!({ "zerox": "abc\u{7f}" }),
            serde_json::json!({ "zerox": "   " }),
            serde_json::json!({ "lifi": "x" }),
            serde_json::json!({ "zerox": 42 }),
            serde_json::json!("nope"),
        ] {
            ui["apiKeys"] = bad.clone();
            assert!(Settings::from_ui(ui.clone(), &s.api_keys).is_err(), "{bad}");
        }
    }

    #[test]
    fn language_defaults_to_auto_and_is_validated() {
        use crate::i18n::LanguagePref;
        // Older file without the field, or an unknown value: auto, other settings kept.
        let s: Settings = serde_json::from_str(r#"{"currency":"USD"}"#).unwrap();
        assert_eq!(s.language, LanguagePref::Auto);
        let s: Settings = serde_json::from_str(r#"{"currency":"USD","language":"de"}"#).unwrap();
        assert_eq!((s.language, s.currency.as_str()), (LanguagePref::Auto, "USD"));
        // settings_get sends it, settings_set takes auto / fr / en and refuses anything else.
        let ui = Settings::default().for_ui();
        assert_eq!(ui["language"], "auto");
        let mut next = ui.clone();
        next["language"] = "en".into();
        let back = Settings::from_ui(next.clone(), &ApiKeys::default()).unwrap();
        assert_eq!(back.language, LanguagePref::En);
        for bad in [serde_json::json!("de"), serde_json::json!(1), serde_json::json!(null)] {
            next["language"] = bad.clone();
            assert!(Settings::from_ui(next.clone(), &ApiKeys::default()).is_err(), "{bad}");
        }
    }

    /// MOYENNE 3 + F5: a new vault never replaces an existing one; files are owner-only on Unix.
    #[test]
    fn write_new_never_overwrites_and_files_are_private() {
        let dir = std::env::temp_dir().join(format!("kyro-write-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let vault = dir.join("coffre-testnet.kyrovault");
        write_new(&vault, b"first").unwrap();
        assert!(matches!(
            write_new(&vault, b"second"),
            Err(AppError::InvalidInput(_))
        ));
        assert_eq!(fs::read(&vault).unwrap(), b"first");
        let settings = dir.join("settings.json");
        write_atomic(&settings, b"{}").unwrap();
        write_atomic(&settings, b"[1]").unwrap();
        assert_eq!(fs::read(&settings).unwrap(), b"[1]");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            for p in [&vault, &settings] {
                assert_eq!(fs::metadata(p).unwrap().permissions().mode() & 0o777, 0o600);
            }
        }
        // No temporary file left behind.
        let names: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names.len(), 2, "{names:?}");
        let _ = fs::remove_dir_all(&dir);
    }
}
