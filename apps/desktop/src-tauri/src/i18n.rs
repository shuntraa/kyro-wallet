//! Display language of the native dialogs (signing summaries, warnings, recovery phrase, server
//! approval, file picker) — the same choice as the interface (`settings.language`, docs/IPC.md).

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
            "Kyro found unusual details in this transaction:\n",
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

    /// `"1.5"` → `"1,5"` in French.
    pub fn decimal(self, en_decimal: &str) -> String {
        match self {
            Lang::Fr => en_decimal.replace('.', ","),
            Lang::En => en_decimal.to_owned(),
        }
    }
}

/// `settings.language`: `auto` (default), `fr` or `en`.
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

/// French version of the most common fixed error details (written in English where they are
/// raised); any other detail is returned unchanged (English).
pub fn detail_fr(en: &str) -> String {
    const EXACT: &[(&str, &str)] = &[
        (
            "a vault already exists on this device",
            "un coffre existe déjà sur cet appareil",
        ),
        ("no vault on this device", "aucun coffre sur cet appareil"),
        (
            "the password must be at least 10 characters long",
            "le mot de passe doit faire au moins 10 caractères",
        ),
        ("invalid recovery phrase", "phrase de récupération invalide"),
        ("12 or 24 words", "12 ou 24 mots"),
        (
            "Tor is turned off in the settings",
            "Tor est désactivé dans les réglages",
        ),
        ("Tor is not ready", "Tor n'est pas prêt"),
        ("Tor is not started", "Tor n'est pas démarré"),
        ("Tor stopped", "Tor arrêté"),
        ("start-up timed out", "délai de démarrage dépassé"),
        ("currency not offered", "devise non proposée"),
        (
            "auto-lock: between 1 and 60 minutes",
            "verrouillage automatique : entre 1 et 60 minutes",
        ),
        (
            "language: auto, fr or en",
            "langue : « auto », « fr » ou « en »",
        ),
        (
            "summary differs between the preview and the signature",
            "résumé différent entre l'aperçu et la signature",
        ),
        ("invalid URL", "URL invalide"),
        ("URL without a host", "URL sans hôte"),
        ("invalid host name", "nom d'hôte invalide"),
        ("no reachable peer", "aucun pair joignable"),
        (
            "this account has no EVM key",
            "ce compte n'a pas de clé EVM",
        ),
        (
            "this account has no Solana key",
            "ce compte n'a pas de clé Solana",
        ),
        (
            "unknown hardware wallet account",
            "compte hardware wallet inconnu",
        ),
        (
            "this transaction does not ask for your Solana address's signature",
            "cette transaction ne demande pas la signature de ton adresse Solana",
        ),
        (
            "this account is not in your list",
            "ce compte n'est pas dans ta liste",
        ),
        (
            ".cookie file: local path expected",
            "fichier .cookie : chemin local attendu",
        ),
        ("invalid amount", "montant invalide"),
        ("transfer to yourself", "transfert à soi-même"),
        ("missing recipient", "destinataire manquant"),
        ("hexadecimal expected", "hexadécimal attendu"),
        ("insufficient balance", "solde insuffisant"),
        (
            "this transaction does not ask for this Solana address's signature",
            "cette transaction ne demande pas la signature de cette adresse Solana",
        ),
    ];
    if let Some((_, fr)) = EXACT.iter().find(|(e, _)| *e == en) {
        return (*fr).to_owned();
    }
    const PREFIXES: &[(&str, &str)] = &[
        ("invalid settings: ", "réglages invalides : "),
        ("invalid PSBT: ", "PSBT invalide : "),
        ("cryptographic failure: ", "échec cryptographique : "),
    ];
    for (e, fr) in PREFIXES {
        if let Some(rest) = en.strip_prefix(e) {
            return format!("{fr}{rest}");
        }
    }
    en.to_owned()
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

    #[test]
    fn decimal_mark_per_language() {
        assert_eq!(Lang::En.decimal("0.1"), "0.1");
        assert_eq!(Lang::Fr.decimal("0.1"), "0,1");
        assert_eq!(Lang::Fr.decimal("12"), "12");
    }
}
