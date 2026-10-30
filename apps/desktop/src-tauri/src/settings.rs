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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oneinch: Option<String>,
    /// TronGrid (`TRON-PRO-API-KEY`), optional.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trongrid: Option<String>,
}

impl ApiKeys {
    /// Every key name Settings supports (`settings_get.apiKeysSet`, `settings_set.apiKeys`).
    pub const NAMES: [&'static str; 4] = ["coingecko", "zerox", "oneinch", "trongrid"];

    fn get(&self, name: &str) -> Option<&Option<String>> {
        Some(match name {
            "coingecko" => &self.coingecko,
            "zerox" => &self.zerox,
            "oneinch" => &self.oneinch,
            "trongrid" => &self.trongrid,
            _ => return None,
        })
    }

    fn slot(&mut self, name: &str) -> Option<&mut Option<String>> {
        Some(match name {
            "coingecko" => &mut self.coingecko,
            "zerox" => &mut self.zerox,
            "oneinch" => &mut self.oneinch,
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
    /// The vault's account lists (see `accounts.rs`). Managed only by the `vault_account_*`
    /// commands: never sent by `settings_get`, never taken from `settings_set`.
    pub accounts: VaultAccounts,
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

/// Write to a temp file then rename, so a crash never leaves a half-written vault or settings file.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> AppResult<()> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, path)?;
    Ok(())
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
                oneinch: Some("1inch-secret-2".into()),
                trongrid: Some("tron-secret-3".into()),
            },
            ..Settings::default()
        }
    }

    #[test]
    fn ui_view_never_contains_api_keys() {
        let s = with_keys();
        let ui = s.for_ui();
        let text = ui.to_string();
        for secret in ["CG-secret-1", "1inch-secret-2", "tron-secret-3"] {
            assert!(!text.contains(secret), "{secret} leaked");
        }
        assert!(ui.get("apiKeys").is_none());
        assert_eq!(
            ui["apiKeysSet"],
            serde_json::json!({ "coingecko": true, "zerox": false, "oneinch": true, "trongrid": true })
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
        assert_eq!(n.api_keys.oneinch.as_deref(), Some("1inch-secret-2"));
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
}
