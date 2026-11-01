//! Watch-only hardware-wallet accounts: public keys only, never a secret.
//!
//! A hardware-wallet user may have no recovery phrase in Kyro at all, so these records live
//! outside the encrypted [`crate::VaultFile`] (whose format is unchanged). They hold what is
//! needed to show balances and receive addresses without the device, and to check every
//! signature the device returns: account xpubs + master fingerprint (Bitcoin), the
//! `m/44'/60'/0'/0` node (EVM), the address (Solana, ed25519 has no public derivation).
//!
//! A tampered record (attacker with write access to the app data folder) could only change
//! public keys; Kyro re-reads them from the device before signing and before showing a
//! receive address on the device, and refuses any mismatch (see SECURITY.md).

use core::str::FromStr;

use bitcoin::bip32::Xpub;
use serde::{Deserialize, Serialize};

use crate::btc::BtcAccount;
use crate::error::{Error, Result};
use crate::network::{BtcKind, Network};

/// Current watch-only store format version.
pub const WATCH_ONLY_VERSION: u8 = 1;

/// Highest BIP44 account index accepted (the Ledger Bitcoin app's limit for default wallets).
pub const MAX_HW_ACCOUNT: u32 = 100;

/// Hardware-wallet brand.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HwDeviceKind {
    /// Ledger (Nano S Plus, Nano X, Stax, Flex…).
    Ledger,
    /// Trezor (One, T, Safe 3, Safe 5).
    Trezor,
}

/// EVM part of a watch-only account.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WatchEvm {
    /// Node `m/44'/60'/0'/0` encoded as `xpub` (see [`crate::evm_xpub_from_node`]).
    pub xpub: String,
    /// Always `m/44'/60'/0'/0`; the address index is the account number.
    pub path: String,
}

/// Solana part of a watch-only account.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WatchSol {
    /// Base58 address.
    pub address: String,
    /// `m/44'/501'/account'/0'`.
    pub path: String,
}

/// A watch-only account backed by a hardware wallet.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WatchOnlyAccount {
    /// `hw-` + 16 lowercase hex characters.
    pub id: String,
    /// User label (1–64 characters).
    pub label: String,
    /// Device brand.
    pub device: HwDeviceKind,
    /// Model as reported when the account was added (informative).
    pub model: String,
    /// Network family the keys were read for.
    pub network: Network,
    /// BIP44 account number (Bitcoin and Solana account, EVM address index).
    pub account: u32,
    /// Bitcoin accounts (at most one per kind, same master fingerprint).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub btc: Vec<BtcAccount>,
    /// EVM node.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evm: Option<WatchEvm>,
    /// Solana address.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sol: Option<WatchSol>,
    /// Single-key chains (Sui, Aptos, Algorand, NEAR, Cosmos), see [`crate::WatchKey`].
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub keys: Vec<crate::hw_keys::WatchKey>,
}

/// EVM node path stored in [`WatchEvm::path`].
pub const EVM_NODE_PATH: &str = "m/44'/60'/0'/0";

/// Solana path for `account`.
pub fn sol_path(account: u32) -> String {
    format!("m/44'/501'/{account}'/0'")
}

fn plain_text(field: &str, s: &str, max: usize, allow_empty: bool) -> Result<()> {
    let n = s.chars().count();
    if (!allow_empty && n == 0) || n > max || s.chars().any(char::is_control) {
        return Err(Error::input(format!(
            "{field} must be 1–{max} printable characters"
        )));
    }
    Ok(())
}

impl WatchOnlyAccount {
    /// Checks every field: id format, label, account range, that each xpub parses, is for
    /// `network`, sits at its declared standard path and that all Bitcoin accounts share one
    /// master fingerprint; EVM node depth and path; Solana key and path.
    pub fn validate(&self) -> Result<()> {
        let hex_ok = self.id.strip_prefix("hw-").is_some_and(|h| {
            h.len() == 16 && h.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        });
        if !hex_ok {
            return Err(Error::input("invalid watch-only account id"));
        }
        plain_text("label", &self.label, 64, false)?;
        plain_text("model", &self.model, 64, true)?;
        if self.account > MAX_HW_ACCOUNT {
            return Err(Error::input(format!(
                "account number must be at most {MAX_HW_ACCOUNT}"
            )));
        }
        if self.btc.is_empty() && self.evm.is_none() && self.sol.is_none() && self.keys.is_empty() {
            return Err(Error::input("watch-only account without any chain"));
        }
        if self.btc.len() > 2 || (self.btc.len() == 2 && self.btc[0].kind == self.btc[1].kind) {
            return Err(Error::input("at most one Bitcoin account per kind"));
        }
        for b in &self.btc {
            let xpub = Xpub::from_str(&b.xpub).map_err(|_| Error::input("invalid account xpub"))?;
            if u32::from(xpub.child_number) != (self.account | 0x8000_0000) {
                return Err(Error::input("Bitcoin xpub is not for this account number"));
            }
            if b.fingerprint.len() != 8
                || !b
                    .fingerprint
                    .bytes()
                    .all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))
            {
                return Err(Error::input("master fingerprint must be 8 lowercase hex"));
            }
            if b.fingerprint != self.btc[0].fingerprint {
                return Err(Error::input("Bitcoin accounts with different fingerprints"));
            }
        }
        // Network, depth, path consistency (shared with PSBT matching).
        crate::btc_hw::check_accounts(self.network, &self.btc)?;
        if let Some(evm) = &self.evm {
            if evm.path != EVM_NODE_PATH {
                return Err(Error::input("EVM path must be m/44'/60'/0'/0"));
            }
            crate::evm::evm_address_from_xpub(&evm.xpub, self.account)?;
        }
        if let Some(sol) = &self.sol {
            if sol.path != sol_path(self.account) {
                return Err(Error::input(
                    "Solana path does not match the account number",
                ));
            }
            let bytes = bs58::decode(&sol.address)
                .into_vec()
                .map_err(|_| Error::input("invalid Solana address"))?;
            crate::sol::sol_address_of_pubkey(&bytes)?;
        }
        crate::hw_keys::validate_keys(&self.keys, self.account, self.network)?;
        Ok(())
    }

    /// Master fingerprint (from the Bitcoin accounts), if any.
    pub fn fingerprint(&self) -> Option<&str> {
        self.btc.first().map(|b| b.fingerprint.as_str())
    }

    /// The stored key of a single-key chain, if any.
    pub fn key(&self, chain: crate::hw_keys::HwKeyChain) -> Option<&crate::hw_keys::WatchKey> {
        self.keys.iter().find(|k| k.chain == chain)
    }

    /// The Bitcoin account of `kind`, if stored.
    pub fn btc_account(&self, kind: BtcKind) -> Option<&BtcAccount> {
        self.btc.iter().find(|b| b.kind == kind)
    }

    /// The EVM address of this account (`m/44'/60'/0'/0/account`), if stored.
    pub fn evm_address(&self) -> Result<Option<String>> {
        self.evm
            .as_ref()
            .map(|e| crate::evm::evm_address_from_xpub(&e.xpub, self.account))
            .transpose()
    }
}

/// On-disk list of watch-only accounts for one network (JSON).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WatchOnlyStore {
    /// Format version, see [`WATCH_ONLY_VERSION`].
    pub version: u8,
    /// Accounts.
    pub accounts: Vec<WatchOnlyAccount>,
}

impl Default for WatchOnlyStore {
    fn default() -> Self {
        WatchOnlyStore {
            version: WATCH_ONLY_VERSION,
            accounts: Vec::new(),
        }
    }
}

impl WatchOnlyStore {
    /// Parses and fully validates a store; every account must be for `network`.
    pub fn from_json(json: &str, network: Network) -> Result<Self> {
        let store: WatchOnlyStore = serde_json::from_str(json)
            .map_err(|_| Error::input("malformed watch-only account store"))?;
        if store.version != WATCH_ONLY_VERSION {
            return Err(Error::input(format!(
                "unsupported watch-only store version {}",
                store.version
            )));
        }
        store.validate(network)?;
        Ok(store)
    }

    /// Validates every account and that ids are unique.
    pub fn validate(&self, network: Network) -> Result<()> {
        for (i, a) in self.accounts.iter().enumerate() {
            if a.network != network {
                return Err(Error::input("watch-only account for another network"));
            }
            a.validate()?;
            if self.accounts[..i].iter().any(|b| b.id == a.id) {
                return Err(Error::input("duplicate watch-only account id"));
            }
        }
        Ok(())
    }

    /// Serialises to pretty JSON.
    pub fn to_json(&self) -> Result<String> {
        serde_json::to_string_pretty(self)
            .map_err(|_| Error::input("cannot serialise watch-only store"))
    }
}
