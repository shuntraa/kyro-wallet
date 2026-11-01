//! Display language of the native dialogs (signing summaries, warnings, recovery phrase, server
//! approval, file picker) — the same choice as the interface (`settings.language`, docs/IPC.md).
//!
//! `auto` (the default) follows the computer: French if its preferred language is French, English
//! otherwise. The system language is read once from the OS (`sys-locale`: Windows user UI
//! languages, macOS preferred languages, `LC_ALL` / `LC_MESSAGES` / `LANG` on Linux).
//!
//! Text builders take a [`Lang`] argument (testable in both languages, no global in tests); the
//! commands pass [`current()`], which [`apply`] keeps in sync with the saved setting. The choice
//! only changes the words: every warning exists in both languages with the same strength.

use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

/// A language Kyro's dialogs are written in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Lang {
    Fr,
    En,
}

impl Lang {
    /// `fr` when `self` is French, otherwise `en`.
    pub fn pick<T>(self, fr: T, en: T) -> T {
        match self {
            Lang::Fr => fr,
            Lang::En => en,
        }
    }

    // ---- labels shared by the native dialogs ----

    /// OK button of a signing dialog.
    pub fn sign(self) -> &'static str {
        self.pick("Signer", "Sign")
    }

    pub fn cancel(self) -> &'static str {
        self.pick("Annuler", "Cancel")
    }

    /// Title of the main signing dialog.
    pub fn confirm_tx_title(self) -> &'static str {
        self.pick("Confirmer la transaction", "Confirm the transaction")
    }

    /// Title of the reinforced (second) dialog.
    pub fn check_tx_title(self) -> &'static str {
        self.pick(
            "Attention : transaction à vérifier",
            "Warning: transaction to check",
        )
    }

    /// First line of a reinforced dialog.
    pub fn unusual_intro(self) -> &'static str {
        self.pick(
            "Kyro a trouvé des éléments inhabituels dans cette transaction :\n",
            "Kyro found unusual elements in this transaction:\n",
        )
    }

    /// Last line of a reinforced dialog.
    pub fn sign_anyway(self) -> &'static str {
        self.pick(
            "Ne signe que si tu sais exactement pourquoi. Signer quand même ?",
            "Only sign if you know exactly why. Sign anyway?",
        )
    }

    /// `"Label : "` (French typography) / `"Label: "`.
    pub fn colon(self) -> &'static str {
        self.pick(" : ", ": ")
    }

    /// `"1,5"` → `"1.5"` in English. Only for plain decimal amounts (one mark, no grouping), as
    /// produced by `commands::format_units`.
    pub fn decimal(self, fr_decimal: &str) -> String {
        match self {
            Lang::Fr => fr_decimal.to_owned(),
            Lang::En => fr_decimal.replace(',', "."),
        }
    }
}

/// `settings.language`: `auto` (default), `fr` or `en`. Anything else is refused by serde
/// (`settings_set` → `INVALID_INPUT`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum LanguagePref {
    #[default]
    Auto,
    Fr,
    En,
}

impl LanguagePref {
    /// The language this preference means on a computer whose language is `system`.
    pub fn resolve(self, system: Lang) -> Lang {
        match self {
            LanguagePref::Auto => system,
            LanguagePref::Fr => Lang::Fr,
            LanguagePref::En => Lang::En,
        }
    }
}

/// French when the first usable locale is French (`fr`, `fr-FR`, `fr_CA.UTF-8`…), else English.
pub fn lang_from_locales<'a>(locales: impl IntoIterator<Item = &'a str>) -> Lang {
    let first = locales
        .into_iter()
        .map(str::trim)
        .find(|l| !l.is_empty() && *l != "C" && *l != "POSIX");
    match first {
        Some(l) => {
            let l = l.to_ascii_lowercase();
            let primary = l.split(['-', '_', '.', '@']).next().unwrap_or("");
            if primary == "fr" {
                Lang::Fr
            } else {
                Lang::En
            }
        }
        None => Lang::En,
    }
}

/// English version of the most common fixed error details (written in French where they are
/// raised); any other detail is returned unchanged.
pub fn detail_en(fr: &str) -> String {
    const EXACT: &[(&str, &str)] = &[
        (
            "un coffre existe déjà sur cet appareil",
            "a vault already exists on this device",
        ),
        ("aucun coffre sur cet appareil", "no vault on this device"),
        (
            "le mot de passe doit faire au moins 10 caractères",
            "the password must be at least 10 characters long",
        ),
        ("phrase de récupération invalide", "invalid recovery phrase"),
        ("12 ou 24 mots", "12 or 24 words"),
        (
            "Tor est désactivé dans les réglages",
            "Tor is turned off in the settings",
        ),
        ("Tor n'est pas prêt", "Tor is not ready"),
        ("Tor n'est pas démarré", "Tor is not started"),
        ("Tor arrêté", "Tor stopped"),
        ("délai de démarrage dépassé", "start-up timed out"),
        ("devise : EUR ou USD", "currency: EUR or USD"),
        (
            "verrouillage automatique : entre 1 et 60 minutes",
            "auto-lock: between 1 and 60 minutes",
        ),
        (
            "langue : « auto », « fr » ou « en »",
            "language: « auto », « fr » or « en »",
        ),
        (
            "résumé différent entre l'aperçu et la signature",
            "summary differs between the preview and the signature",
        ),
        ("URL invalide", "invalid URL"),
        ("URL sans hôte", "URL without a host"),
        ("nom d'hôte invalide", "invalid host name"),
        ("aucun pair joignable", "no reachable peer"),
        (
            "ce compte n'a pas de clé EVM",
            "this account has no EVM key",
        ),
        (
            "ce compte n'a pas de clé Solana",
            "this account has no Solana key",
        ),
        (
            "compte hardware wallet inconnu",
            "unknown hardware-wallet account",
        ),
        (
            "cette transaction ne demande pas la signature de ton adresse Solana",
            "this transaction does not ask for your Solana address's signature",
        ),
        (
            "ce compte n'est pas dans ta liste",
            "this account is not in your list",
        ),
        (
            "fichier .cookie : chemin local attendu",
            ".cookie file: local path expected",
        ),
    ];
    if let Some((_, en)) = EXACT.iter().find(|(f, _)| *f == fr) {
        return (*en).to_owned();
    }
    if let Some(rest) = fr.strip_prefix("réglages invalides : ") {
        return format!("invalid settings: {rest}");
    }
    fr.to_owned()
}

/// The computer's language, read once from the OS.
pub fn system() -> Lang {
    static SYSTEM: OnceLock<Lang> = OnceLock::new();
    *SYSTEM.get_or_init(|| {
        let locales: Vec<String> = sys_locale::get_locales().collect();
        lang_from_locales(locales.iter().map(String::as_str))
    })
}

const FR: u8 = 0;
const EN: u8 = 1;
const UNSET: u8 = u8::MAX;

/// Language of the next native dialog (set from the saved setting by [`apply`]).
static CURRENT: AtomicU8 = AtomicU8::new(UNSET);

/// Applies a (saved) preference: the next dialog uses it.
pub fn apply(pref: LanguagePref) {
    let lang = pref.resolve(system());
    CURRENT.store(lang.pick(FR, EN), Ordering::Relaxed);
}

/// Language of the native dialogs right now (the system language until a setting is applied).
pub fn current() -> Lang {
    match CURRENT.load(Ordering::Relaxed) {
        FR => Lang::Fr,
        EN => Lang::En,
        _ => system(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locales_map_to_french_or_english() {
        assert_eq!(lang_from_locales(["fr-FR", "en-US"]), Lang::Fr);
        assert_eq!(lang_from_locales(["fr"]), Lang::Fr);
        assert_eq!(lang_from_locales(["fr_CA.UTF-8"]), Lang::Fr);
        assert_eq!(lang_from_locales(["FR-be"]), Lang::Fr);
        assert_eq!(lang_from_locales(["en-GB", "fr-FR"]), Lang::En);
        assert_eq!(lang_from_locales(["de-DE"]), Lang::En);
        assert_eq!(lang_from_locales(["fy-NL"]), Lang::En, "not a prefix match");
        assert_eq!(lang_from_locales(["", "C", "fr-FR"]), Lang::Fr);
        assert_eq!(lang_from_locales([]), Lang::En);
    }

    #[test]
    fn preference_resolution_and_serde() {
        assert_eq!(LanguagePref::Auto.resolve(Lang::Fr), Lang::Fr);
        assert_eq!(LanguagePref::Auto.resolve(Lang::En), Lang::En);
        assert_eq!(LanguagePref::En.resolve(Lang::Fr), Lang::En);
        assert_eq!(LanguagePref::Fr.resolve(Lang::En), Lang::Fr);
        assert_eq!(LanguagePref::default(), LanguagePref::Auto);
        assert_eq!(serde_json::to_value(LanguagePref::Auto).unwrap(), "auto");
        assert_eq!(
            serde_json::from_value::<LanguagePref>("en".into()).unwrap(),
            LanguagePref::En
        );
        assert!(serde_json::from_value::<LanguagePref>("de".into()).is_err());
        assert_eq!(Lang::En.pick("Signer", "Sign"), "Sign");
    }
}
