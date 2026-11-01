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

    pub fn code(self) -> &'static str {
        self.pick("fr", "en")
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
        assert_eq!(Lang::Fr.code(), "fr");
    }
}
