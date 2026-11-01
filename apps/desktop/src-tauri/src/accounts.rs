//! Several accounts per chain for the software vault (Ledger Live model).
//!
//! Keys are derived from the seed, so an "account" is only a public bookmark: the account
//! **index** the user added for a chain and the **name** they gave it, stored per network in
//! `settings.json` (`accounts`). Removing an account only removes the bookmark; adding it
//! again gives back the same addresses. Account 0 always exists (it is every chain's
//! historical account) and cannot be removed, only renamed.
//!
//! Every vault command that derives one of our addresses or signs takes an optional `account`
//! (absent = 0, so an older UI keeps working unchanged). The native dialog always says which
//! account and path signs; an account that is **not** in the user's list is shown as
//! « inconnu » and needs a reinforced confirmation ([`confirm_signer`]).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use wallet_core::Network;

use crate::error::{AppError, AppResult};
use crate::i18n::Lang;
use crate::state::AppState;

/// Highest account index accepted (same bound as hardware-wallet accounts).
pub const MAX_ACCOUNT: u32 = wallet_core::MAX_HW_ACCOUNT;
/// At most this many accounts per chain and network.
pub const MAX_ACCOUNTS_PER_CHAIN: usize = 20;
const MAX_NAME: usize = 32;

/// A chain family of the vault (one account list each; EVM chains share theirs).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Chain {
    Btc,
    Evm,
    Sol,
    Ltc,
    Doge,
    Tron,
    Xrp,
    Ada,
    Xlm,
    Near,
}

impl Chain {
    pub const ALL: [Chain; 10] = [
        Chain::Btc,
        Chain::Evm,
        Chain::Sol,
        Chain::Ltc,
        Chain::Doge,
        Chain::Tron,
        Chain::Xrp,
        Chain::Ada,
        Chain::Xlm,
        Chain::Near,
    ];

    /// Name used for default account names ("Bitcoin 2").
    pub fn label(self) -> &'static str {
        match self {
            Chain::Btc => "Bitcoin",
            Chain::Evm => "Ethereum",
            Chain::Sol => "Solana",
            Chain::Ltc => "Litecoin",
            Chain::Doge => "Dogecoin",
            Chain::Tron => "TRON",
            Chain::Xrp => "XRP",
            Chain::Ada => "Cardano",
            Chain::Xlm => "Stellar",
            Chain::Near => "NEAR",
        }
    }

    pub fn parse(s: &str) -> AppResult<Chain> {
        Chain::ALL
            .into_iter()
            .find(|c| c.key() == s)
            .ok_or_else(|| AppError::InvalidInput(format!("chaîne inconnue « {s} »")))
    }

    pub fn key(self) -> &'static str {
        match self {
            Chain::Btc => "btc",
            Chain::Evm => "evm",
            Chain::Sol => "sol",
            Chain::Ltc => "ltc",
            Chain::Doge => "doge",
            Chain::Tron => "tron",
            Chain::Xrp => "xrp",
            Chain::Ada => "ada",
            Chain::Xlm => "xlm",
            Chain::Near => "near",
        }
    }
}

/// One account of the user's list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountEntry {
    pub index: u32,
    pub name: String,
}

/// Default name of account `index`: "Bitcoin 1" for index 0, "Bitcoin 2" for index 1…
pub fn default_name(chain: Chain, index: u32) -> String {
    format!("{} {}", chain.label(), u64::from(index) + 1)
}

/// What `settings.json` stores: per network, per chain, the added accounts (and a renamed
/// account 0). Public data only.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct VaultAccounts {
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub mainnet: BTreeMap<Chain, Vec<AccountEntry>>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub testnet: BTreeMap<Chain, Vec<AccountEntry>>,
}

/// Validates an `account` argument of a command (absent = 0).
pub fn account_arg(account: Option<u32>) -> AppResult<u32> {
    let a = account.unwrap_or(0);
    if a > MAX_ACCOUNT {
        return Err(AppError::InvalidInput(format!(
            "numéro de compte : au plus {MAX_ACCOUNT}"
        )));
    }
    Ok(a)
}

fn clean_name(name: &str) -> AppResult<String> {
    let n = name.trim();
    let len = n.chars().count();
    if len == 0
        || len > MAX_NAME
        || n.chars()
            .any(|c| c.is_control() || crate::dialog_text::is_invisible(c))
    {
        return Err(AppError::InvalidInput(format!(
            "nom du compte : 1 à {MAX_NAME} caractères, sans caractère de contrôle ni caractère invisible ou de direction"
        )));
    }
    Ok(n.to_owned())
}

impl VaultAccounts {
    fn slot(&mut self, net: Network) -> &mut BTreeMap<Chain, Vec<AccountEntry>> {
        match net {
            Network::Mainnet => &mut self.mainnet,
            Network::Testnet => &mut self.testnet,
        }
    }

    fn stored(&self, net: Network, chain: Chain) -> &[AccountEntry] {
        let m = match net {
            Network::Mainnet => &self.mainnet,
            Network::Testnet => &self.testnet,
        };
        m.get(&chain).map(Vec::as_slice).unwrap_or_default()
    }

    /// The user's accounts of `chain`, sorted by index; account 0 is always first.
    pub fn list(&self, net: Network, chain: Chain) -> Vec<AccountEntry> {
        let mut out: Vec<AccountEntry> = self.stored(net, chain).to_vec();
        if !out.iter().any(|e| e.index == 0) {
            out.push(AccountEntry {
                index: 0,
                name: default_name(chain, 0),
            });
        }
        out.sort_by_key(|e| e.index);
        out.dedup_by_key(|e| e.index);
        out
    }

    /// Every chain's list (what `vault_accounts_get` returns).
    pub fn all(&self, net: Network) -> BTreeMap<Chain, Vec<AccountEntry>> {
        Chain::ALL
            .into_iter()
            .map(|c| (c, self.list(net, c)))
            .collect()
    }

    /// Name of `index` if it is in the user's list.
    pub fn name_of(&self, net: Network, chain: Chain, index: u32) -> Option<String> {
        self.list(net, chain)
            .into_iter()
            .find(|e| e.index == index)
            .map(|e| e.name)
    }

    pub fn add(&mut self, net: Network, chain: Chain, index: u32, name: &str) -> AppResult<()> {
        account_arg(Some(index))?;
        let name = clean_name(name)?;
        let current = self.list(net, chain);
        if current.iter().any(|e| e.index == index) {
            return Err(AppError::InvalidInput(
                "ce compte est déjà dans ta liste".into(),
            ));
        }
        if current.len() >= MAX_ACCOUNTS_PER_CHAIN {
            return Err(AppError::InvalidInput(format!(
                "au plus {MAX_ACCOUNTS_PER_CHAIN} comptes par chaîne"
            )));
        }
        let list = self.slot(net).entry(chain).or_default();
        list.push(AccountEntry { index, name });
        list.sort_by_key(|e| e.index);
        Ok(())
    }

    pub fn rename(&mut self, net: Network, chain: Chain, index: u32, name: &str) -> AppResult<()> {
        let name = clean_name(name)?;
        if self.name_of(net, chain, index).is_none() {
            return Err(AppError::InvalidInput(
                "ce compte n'est pas dans ta liste".into(),
            ));
        }
        let list = self.slot(net).entry(chain).or_default();
        match list.iter_mut().find(|e| e.index == index) {
            Some(e) => e.name = name,
            // Account 0, never renamed before: store it now.
            None => list.push(AccountEntry { index, name }),
        }
        list.sort_by_key(|e| e.index);
        Ok(())
    }

    /// Removes `index` from the list (keys stay derivable: adding it back restores it).
    pub fn remove(&mut self, net: Network, chain: Chain, index: u32) -> AppResult<()> {
        if index == 0 {
            return Err(AppError::InvalidInput(
                "le premier compte ne peut pas être retiré (tu peux le renommer)".into(),
            ));
        }
        let list = self.slot(net).entry(chain).or_default();
        let before = list.len();
        list.retain(|e| e.index != index);
        if list.len() == before {
            return Err(AppError::InvalidInput(
                "ce compte n'est pas dans ta liste".into(),
            ));
        }
        if list.is_empty() {
            self.slot(net).remove(&chain);
        }
        Ok(())
    }

    /// Indices of the user's accounts of `chain` (account 0 included).
    pub fn indices(&self, net: Network, chain: Chain) -> Vec<u32> {
        self.list(net, chain).into_iter().map(|e| e.index).collect()
    }
}

// ---------------------------------------------------------------- signing account

/// Which account signs, for the native dialog.
#[derive(Debug, Clone)]
pub struct SignerInfo {
    pub chain: Chain,
    pub account: u32,
    /// Derivation path(s) of the signing key(s), e.g. `m/44'/60'/0'/0/1`.
    pub path: String,
    /// Name from the user's list; `None` = not in the list (« inconnu »).
    pub name: Option<String>,
}

impl SignerInfo {
    pub fn new(state: &AppState, chain: Chain, account: u32, path: String) -> SignerInfo {
        SignerInfo {
            chain,
            account,
            path,
            name: state
                .settings()
                .accounts
                .name_of(state.network, chain, account),
        }
    }

    pub fn unknown(&self) -> bool {
        self.name.is_none()
    }

    /// First line of every native signing dialog of the vault.
    pub fn line(&self, lang: Lang) -> String {
        let n = u64::from(self.account) + 1;
        match (&self.name, lang) {
            (Some(name), Lang::Fr) => format!(
                "Compte signataire : {} — {}",
                crate::dialog_text::field(name, MAX_NAME),
                self.path
            ),
            (Some(name), Lang::En) => format!(
                "Signing account: {} — {}",
                crate::dialog_text::field(name, MAX_NAME),
                self.path
            ),
            (None, Lang::Fr) => format!(
                "Compte signataire : « inconnu » (n° {n} {}, absent de ta liste) — {}",
                self.chain.label(),
                self.path
            ),
            (None, Lang::En) => format!(
                "Signing account: « unknown » (no. {n} {}, not in your list) — {}",
                self.chain.label(),
                self.path
            ),
        }
    }

    /// Dialog body with the signer line first.
    pub fn body(&self, lang: Lang, rest: &str) -> String {
        format!("{}\n\n{rest}", self.line(lang))
    }

    /// Text of the reinforced dialog for an account that is not in the user's list.
    pub fn unknown_text(&self, lang: Lang) -> String {
        let n = u64::from(self.account) + 1;
        match lang {
            Lang::Fr => format!(
                "Cette signature utilise un compte {} qui n'est PAS dans ta liste de comptes :\n\
                 • n° {n} — {}\n\n\
                 Kyro ne l'a pas ajouté pour toi : si tu ne viens pas de choisir ce compte, refuse.\n\
                 Signer quand même ?",
                self.chain.label(),
                self.path
            ),
            Lang::En => format!(
                "This signature uses a {} account that is NOT in your account list:\n\
                 • no. {n} — {}\n\n\
                 Kyro did not add it for you: if you did not just choose this account, refuse.\n\
                 Sign anyway?",
                self.chain.label(),
                self.path
            ),
        }
    }
}

/// Reinforced confirmation when the signing account is « inconnu ». Call it after the main
/// dialog (which already shows [`SignerInfo::line`]).
pub async fn confirm_signer(app: &AppHandle, signer: &SignerInfo) -> AppResult<()> {
    if signer.unknown() {
        let lang = crate::i18n::current();
        crate::commands::confirm_native(
            app,
            lang.pick("Attention : compte inconnu", "Warning: unknown account"),
            signer.unknown_text(lang),
        )
        .await?;
    }
    Ok(())
}

/// Bitcoin signing paths of `account` (both kinds).
pub fn btc_paths(net: Network, account: u32) -> String {
    let coin = match net {
        Network::Mainnet => 0,
        Network::Testnet => 1,
    };
    format!("m/84'/{coin}'/{account}' (SegWit), m/86'/{coin}'/{account}' (Taproot)")
}

// ---------------------------------------------------------------- IPC

fn require_unlocked(state: &AppState) -> AppResult<()> {
    if state.is_unlocked() {
        Ok(())
    } else {
        Err(AppError::Locked)
    }
}

#[tauri::command]
pub fn vault_accounts_get(state: tauri::State<'_, AppState>) -> BTreeMap<Chain, Vec<AccountEntry>> {
    state.settings().accounts.all(state.network)
}

#[tauri::command]
pub fn vault_account_add(
    state: tauri::State<'_, AppState>,
    chain: String,
    account: u32,
    name: String,
) -> AppResult<BTreeMap<Chain, Vec<AccountEntry>>> {
    require_unlocked(&state)?;
    let chain = Chain::parse(&chain)?;
    let net = state.network;
    state.update_accounts(|a| {
        a.add(net, chain, account, &name)?;
        Ok(a.all(net))
    })
}

#[tauri::command]
pub fn vault_account_rename(
    state: tauri::State<'_, AppState>,
    chain: String,
    account: u32,
    name: String,
) -> AppResult<BTreeMap<Chain, Vec<AccountEntry>>> {
    require_unlocked(&state)?;
    let chain = Chain::parse(&chain)?;
    let net = state.network;
    state.update_accounts(|a| {
        a.rename(net, chain, account, &name)?;
        Ok(a.all(net))
    })
}

#[tauri::command]
pub fn vault_account_remove(
    state: tauri::State<'_, AppState>,
    chain: String,
    account: u32,
) -> AppResult<BTreeMap<Chain, Vec<AccountEntry>>> {
    require_unlocked(&state)?;
    let chain = Chain::parse(&chain)?;
    let net = state.network;
    state.update_accounts(|a| {
        a.remove(net, chain, account)?;
        Ok(a.all(net))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const T: Network = Network::Testnet;

    #[test]
    fn account_0_always_exists_and_cannot_be_removed() {
        let mut a = VaultAccounts::default();
        assert_eq!(
            a.list(T, Chain::Btc),
            vec![AccountEntry {
                index: 0,
                name: "Bitcoin 1".into()
            }]
        );
        assert!(a.remove(T, Chain::Btc, 0).is_err());
        a.rename(T, Chain::Btc, 0, "  Épargne  ").unwrap();
        assert_eq!(a.name_of(T, Chain::Btc, 0).as_deref(), Some("Épargne"));
        assert!(a.add(T, Chain::Btc, 0, "x").is_err(), "already there");
    }

    #[test]
    fn add_rename_remove_per_network_and_chain() {
        let mut a = VaultAccounts::default();
        a.add(T, Chain::Evm, 3, "Ethereum 4").unwrap();
        a.add(T, Chain::Evm, 1, "Ethereum 2").unwrap();
        assert_eq!(a.indices(T, Chain::Evm), vec![0, 1, 3]);
        assert_eq!(a.indices(Network::Mainnet, Chain::Evm), vec![0]);
        assert_eq!(a.indices(T, Chain::Sol), vec![0]);
        assert!(a.add(T, Chain::Evm, 1, "again").is_err());
        a.rename(T, Chain::Evm, 3, "Pro").unwrap();
        assert_eq!(a.name_of(T, Chain::Evm, 3).as_deref(), Some("Pro"));
        assert!(a.rename(T, Chain::Evm, 7, "nope").is_err());
        a.remove(T, Chain::Evm, 3).unwrap();
        assert!(a.remove(T, Chain::Evm, 3).is_err());
        assert_eq!(a.name_of(T, Chain::Evm, 3), None);
        // Re-adding gives the same index (the keys never changed).
        a.add(T, Chain::Evm, 3, "Ethereum 4").unwrap();
        assert_eq!(a.indices(T, Chain::Evm), vec![0, 1, 3]);
    }

    #[test]
    fn limits_and_names() {
        let mut a = VaultAccounts::default();
        assert!(a.add(T, Chain::Btc, MAX_ACCOUNT + 1, "x").is_err());
        // F6: bidi overrides, isolates and zero-width characters are refused too.
        for bad in [
            "",
            "   ",
            "a\nb",
            &"x".repeat(MAX_NAME + 1),
            "Épargne\u{202E}",
            "a\u{2066}b",
            "a\u{200B}b",
            "\u{FEFF}x",
        ] {
            assert!(a.add(T, Chain::Btc, 1, bad).is_err(), "{bad:?}");
        }
        for i in 1..MAX_ACCOUNTS_PER_CHAIN as u32 {
            a.add(T, Chain::Btc, i, "ok").unwrap();
        }
        assert!(a.add(T, Chain::Btc, 50, "one too many").is_err());
        assert_eq!(account_arg(None).unwrap(), 0);
        assert!(account_arg(Some(MAX_ACCOUNT + 1)).is_err());
    }

    #[test]
    fn serde_round_trip_and_tolerant_load() {
        let mut a = VaultAccounts::default();
        a.add(T, Chain::Ada, 2, "Cardano 3").unwrap();
        let json = serde_json::to_string(&a).unwrap();
        assert_eq!(
            json,
            r#"{"testnet":{"ada":[{"index":2,"name":"Cardano 3"}]}}"#
        );
        let back: VaultAccounts = serde_json::from_str(&json).unwrap();
        assert_eq!(back, a);
        let empty: VaultAccounts = serde_json::from_str("{}").unwrap();
        assert_eq!(empty, VaultAccounts::default());
    }

    #[test]
    fn signer_lines() {
        let known = SignerInfo {
            chain: Chain::Evm,
            account: 1,
            path: wallet_core::evm_path(1),
            name: Some("Ethereum 2".into()),
        };
        assert_eq!(
            known.line(Lang::Fr),
            "Compte signataire : « Ethereum 2 » — m/44'/60'/0'/0/1"
        );
        // A name stored before the bidi rule (or edited on disk) cannot reorder the line.
        let spoof = SignerInfo {
            name: Some("Pro\u{202E}\nÀ : 0xEvil".into()),
            ..known.clone()
        };
        assert_eq!(
            spoof.line(Lang::Fr),
            "Compte signataire : « Pro À : 0xEvil » — m/44'/60'/0'/0/1"
        );
        assert!(!known.unknown());
        let unknown = SignerInfo {
            name: None,
            account: 7,
            ..known
        };
        assert!(unknown.unknown());
        assert!(unknown
            .line(Lang::Fr)
            .starts_with("Compte signataire : « inconnu » (n° 8 Ethereum"));
        assert!(unknown.unknown_text(Lang::Fr).contains("PAS dans ta liste"));
        assert!(unknown
            .line(Lang::En)
            .starts_with("Signing account: « unknown » (no. 8 Ethereum, not in your list)"));
        let en = unknown.unknown_text(Lang::En);
        assert!(en.contains("NOT in your account list") && en.ends_with("Sign anyway?"));
        assert_eq!(
            SignerInfo {
                name: Some("Ethereum 2".into()),
                ..unknown.clone()
            }
            .line(Lang::En),
            "Signing account: « Ethereum 2 » — m/44'/60'/0'/0/1"
        );
        assert_eq!(
            btc_paths(T, 2),
            "m/84'/1'/2' (SegWit), m/86'/1'/2' (Taproot)"
        );
    }
}
