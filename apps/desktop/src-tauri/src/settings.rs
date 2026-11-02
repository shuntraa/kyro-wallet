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
            .ok_or_else(|| AppError::InvalidInput("apiKeys: object expected".into()))?;
        for (name, v) in obj {
            let slot = self
                .slot(name)
                .ok_or_else(|| AppError::InvalidInput(format!("unknown API key “{name}”")))?;
            match v {
                serde_json::Value::Null => {}
                serde_json::Value::String(s) if s.is_empty() => *slot = None,
                serde_json::Value::String(s) => {
                    let t = s.trim();
                    if t.is_empty() || t.chars().any(char::is_control) {
                        return Err(AppError::InvalidInput(format!(
                            "invalid API key “{name}” (empty or control characters)"
                        )));
                    }
                    *slot = Some(t.to_owned());
                }
                _ => {
                    return Err(AppError::InvalidInput(format!(
                        "API key “{name}”: text expected"
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
    #[serde(deserialize_with = "lenient_language")]
    pub language: crate::i18n::LanguagePref,
    /// Automatic updates (`updater.rs`): ON by default; off = no check, a staged update is
    /// discarded.
    pub auto_update: bool,
    /// Anonymous weekly count (`weekly_count.rs`): ON by default; once per ISO week, over Tor,
    /// downloads `ping.txt` from the latest release. Off = never.
    pub weekly_count: bool,
    /// The vault's account lists (see `accounts.rs`).
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
            auto_update: true,
            weekly_count: true,
            accounts: VaultAccounts::default(),
        }
    }
}

impl Settings {
    pub fn load(path: &Path, net: wallet_core::Network) -> Settings {
        let raw: Option<serde_json::Value> = fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok());
        let mut s = Self::from_saved(raw, crate::fiat::system_currency);
        s.migrate_legacy_rpc(net);
        s
    }

    fn from_saved(
        raw: Option<serde_json::Value>,
        system_currency: fn() -> &'static str,
    ) -> Settings {
        let has_currency = raw
            .as_ref()
            .and_then(|v| v.get("currency"))
            .and_then(|c| c.as_str())
            .is_some_and(crate::fiat::is_supported);
        let mut s: Settings = raw
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default();
        if !has_currency {
            s.currency = system_currency().into();
        }
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
    /// [`ApiKeys::apply_patch`]).
    pub fn from_ui(mut v: serde_json::Value, current: &ApiKeys) -> AppResult<Settings> {
        let patch = v.as_object_mut().and_then(|o| {
            o.remove("apiKeysSet");
            o.remove("accounts");
            o.remove("apiKeys")
        });
        if let Some(lang) = v.get("language") {
            serde_json::from_value::<crate::i18n::LanguagePref>(lang.clone())
                .map_err(|_| AppError::InvalidInput("language: auto, fr or en".into()))?;
        }
        let mut s: Settings = serde_json::from_value(v)
            .map_err(|e| AppError::InvalidInput(format!("invalid settings: {e}")))?;
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
        if !crate::fiat::is_supported(&self.currency) {
            return Err(AppError::InvalidInput("currency not offered".into()));
        }
        if !(60..=3600).contains(&self.auto_lock_secs) {
            return Err(AppError::InvalidInput(
                "auto-lock: between 1 and 60 minutes".into(),
            ));
        }
        self.servers.validate(self.tor.enabled)
    }
}

fn sibling(path: &Path, suffix: &str) -> std::path::PathBuf {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    path.with_file_name(format!("{name}.{suffix}"))
}

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

/// Write to a temp file then rename, so a crash never leaves a half-written vault or settings file.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> AppResult<()> {
    let tmp = sibling(path, "tmp");
    let _ = fs::remove_file(&tmp);
    write_private(&tmp, bytes, true)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

/// Creates `path` with `bytes`, refusing to replace an existing file (`AlreadyExists`), and never
/// leaving a half-written file: written to a temp file first, then hard-linked into place (atomic,
/// fails if the target exists).
pub fn write_new(path: &Path, bytes: &[u8]) -> AppResult<()> {
    let exists = || AppError::InvalidInput("a vault already exists on this device".into());
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
        let back = Settings::from_ui(ui.clone(), &s.api_keys).unwrap();
        assert_eq!(back.api_keys.coingecko.as_deref(), Some("CG-secret-1"));
        assert_eq!(back.api_keys.trongrid.as_deref(), Some("tron-secret-3"));
        assert!(!back.for_ui().to_string().contains("secret"));
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
        let mut forged = ui.clone();
        forged["accounts"] =
            serde_json::json!({ "testnet": { "btc": [{ "index": 9, "name": "x" }] } });
        let back = Settings::from_ui(forged, &s.api_keys).unwrap();
        assert_eq!(back.accounts, VaultAccounts::default());
        let disk: Settings = serde_json::from_str(&serde_json::to_string(&s).unwrap()).unwrap();
        assert_eq!(disk.accounts, s.accounts);
    }

    #[test]
    fn api_key_merge_rule() {
        let s = with_keys();
        let mut ui = s.for_ui();
        ui["apiKeys"] =
            serde_json::json!({ "coingecko": "", "zerox": "  0x-new \t", "trongrid": null });
        let n = Settings::from_ui(ui.clone(), &s.api_keys).unwrap();
        assert_eq!(n.api_keys.coingecko, None);
        assert_eq!(n.api_keys.zerox.as_deref(), Some("0x-new"));
        assert_eq!(n.api_keys.trongrid.as_deref(), Some("tron-secret-3"));
        assert_eq!(n.for_ui()["apiKeysSet"]["coingecko"], false);
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
    fn auto_update_defaults_to_on() {
        let s: Settings = serde_json::from_str(r#"{"currency":"USD"}"#).unwrap();
        assert!(s.auto_update, "older file: on");
        assert_eq!(Settings::default().for_ui()["autoUpdate"], true);
        let s: Settings = serde_json::from_str(r#"{"autoUpdate":false}"#).unwrap();
        assert!(!s.auto_update);
    }

    #[test]
    fn weekly_count_defaults_to_on_and_can_be_turned_off() {
        let s: Settings = serde_json::from_str(r#"{"currency":"USD"}"#).unwrap();
        assert!(s.weekly_count, "older file: on");
        assert_eq!(Settings::default().for_ui()["weeklyCount"], true);
        let s: Settings = serde_json::from_str(r#"{"weeklyCount":false}"#).unwrap();
        assert!(!s.weekly_count);
        let mut ui = Settings::default().for_ui();
        ui["weeklyCount"] = false.into();
        let s = Settings::from_ui(ui, &ApiKeys::default()).unwrap();
        assert!(!s.weekly_count);
    }

    #[test]
    fn currency_defaults_from_the_os_region_and_is_validated() {
        let chf = || "CHF";
        assert_eq!(Settings::from_saved(None, chf).currency, "CHF");
        let v = |s: &str| Some(serde_json::from_str::<serde_json::Value>(s).unwrap());
        assert_eq!(
            Settings::from_saved(v(r#"{"autoLockSecs":300}"#), chf).currency,
            "CHF"
        );
        let s = Settings::from_saved(v(r#"{"currency":"XYZ","autoLockSecs":300}"#), chf);
        assert_eq!((s.currency.as_str(), s.auto_lock_secs), ("CHF", 300));
        assert_eq!(
            Settings::from_saved(v(r#"{"currency":"JPY"}"#), chf).currency,
            "JPY"
        );
        for c in crate::fiat::FIAT_CURRENCIES {
            let s = Settings {
                currency: (*c).into(),
                ..Settings::default()
            };
            assert!(s.validate().is_ok(), "{c}");
        }
        for bad in ["XYZ", "eur", ""] {
            let s = Settings {
                currency: bad.into(),
                ..Settings::default()
            };
            assert!(s.validate().is_err(), "{bad}");
        }
    }

    #[test]
    fn language_defaults_to_auto_and_is_validated() {
        use crate::i18n::LanguagePref;
        let s: Settings = serde_json::from_str(r#"{"currency":"USD"}"#).unwrap();
        assert_eq!(s.language, LanguagePref::Auto);
        let s: Settings = serde_json::from_str(r#"{"currency":"USD","language":"de"}"#).unwrap();
        assert_eq!(
            (s.language, s.currency.as_str()),
            (LanguagePref::Auto, "USD")
        );
        let ui = Settings::default().for_ui();
        assert_eq!(ui["language"], "auto");
        let mut next = ui.clone();
        next["language"] = "en".into();
        let back = Settings::from_ui(next.clone(), &ApiKeys::default()).unwrap();
        assert_eq!(back.language, LanguagePref::En);
        for bad in [
            serde_json::json!("de"),
            serde_json::json!(1),
            serde_json::json!(null),
        ] {
            next["language"] = bad.clone();
            assert!(
                Settings::from_ui(next.clone(), &ApiKeys::default()).is_err(),
                "{bad}"
            );
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
        let names: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names.len(), 2, "{names:?}");
        let _ = fs::remove_dir_all(&dir);
    }
}
