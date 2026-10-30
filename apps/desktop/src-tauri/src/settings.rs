use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

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

    /// What `settings_get` returns: secrets removed (`hasPassword` instead).
    pub fn for_ui(&self) -> Settings {
        let mut s = self.clone();
        s.servers = s.servers.redacted();
        s
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
}
