use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub currency: String,
    pub auto_lock_secs: u64,
    pub hide_balances_on_start: bool,
    pub capture_protection: bool,
    pub clipboard_guard: bool,
    pub rpc: RpcOverrides,
    pub api_keys: ApiKeys,
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
            api_keys: ApiKeys::default(),
        }
    }
}

impl Settings {
    pub fn load(path: &Path) -> Settings {
        fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
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
        for url in [&self.rpc.ethereum, &self.rpc.solana, &self.rpc.esplora]
            .into_iter()
            .flatten()
        {
            let parsed = url::Url::parse(url)
                .map_err(|_| AppError::InvalidInput(format!("URL RPC invalide : {url}")))?;
            if parsed.scheme() != "https" || parsed.host_str().is_none() {
                return Err(AppError::InvalidInput(format!(
                    "URL RPC : HTTPS obligatoire ({url})"
                )));
            }
        }
        Ok(())
    }

    /// Hosts of user-configured RPC endpoints, added to the network allowlist.
    pub fn rpc_hosts(&self) -> Vec<String> {
        [&self.rpc.ethereum, &self.rpc.solana, &self.rpc.esplora]
            .into_iter()
            .flatten()
            .filter_map(|u| url::Url::parse(u).ok()?.host_str().map(str::to_owned))
            .collect()
    }
}

/// Write to a temp file then rename, so a crash never leaves a half-written vault or settings file.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> AppResult<()> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, path)?;
    Ok(())
}
