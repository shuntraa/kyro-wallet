// SPDX-License-Identifier: GPL-3.0-or-later
//! Fiat currencies offered in the settings (all CoinGecko `vs_currencies`), and the first-run
//! default: the currency of the REGION of the OS locale (`fr-FR` → EUR, `de-CH` → CHF,
//! `en-GB` → GBP…), read with `sys-locale` (Windows user locale, macOS preferred languages,
//! Linux `LANG`/`LC_*`). Never the IP address. Same table as `packages/shared/src/fiat.ts`.

pub const FIAT_CURRENCIES: &[&str] = &[
    "EUR", "USD", "GBP", "CHF", "CAD", "AUD", "NZD", "JPY", "CNY", "HKD", "SGD", "KRW", "INR",
    "BRL", "MXN", "ARS", "TRY", "PLN", "CZK", "SEK", "NOK", "DKK", "ZAR", "AED", "ILS", "RUB",
];

pub const DEFAULT_CURRENCY: &str = "USD";

pub fn is_supported(c: &str) -> bool {
    FIAT_CURRENCIES.contains(&c)
}

const EURO_REGIONS: &[&str] = &[
    "AT", "BE", "CY", "DE", "EE", "ES", "FI", "FR", "GR", "HR", "IE", "IT", "LT", "LU", "LV", "MT",
    "NL", "PT", "SI", "SK", "AD", "MC", "SM", "VA", "ME", "XK", "GF", "GP", "MQ", "RE", "YT", "PM",
    "BL", "MF",
];

fn region_currency(region: &str) -> Option<&'static str> {
    if EURO_REGIONS.contains(&region) {
        return Some("EUR");
    }
    Some(match region {
        "US" | "PR" | "EC" | "SV" | "PA" | "GU" | "VI" | "AS" => "USD",
        "GB" | "IM" | "JE" | "GG" => "GBP",
        "CH" | "LI" => "CHF",
        "CA" => "CAD",
        "AU" => "AUD",
        "NZ" => "NZD",
        "JP" => "JPY",
        "CN" => "CNY",
        "HK" => "HKD",
        "SG" => "SGD",
        "KR" => "KRW",
        "IN" => "INR",
        "BR" => "BRL",
        "MX" => "MXN",
        "AR" => "ARS",
        "TR" => "TRY",
        "PL" => "PLN",
        "CZ" => "CZK",
        "SE" => "SEK",
        "NO" => "NOK",
        "DK" | "GL" | "FO" => "DKK",
        "ZA" => "ZAR",
        "AE" => "AED",
        "IL" => "ILS",
        "RU" => "RUB",
        _ => return None,
    })
}

/// A language without a region (`fr`, `ja`…): a likely currency where it is unambiguous enough.
fn lang_currency(lang: &str) -> Option<&'static str> {
    Some(match lang {
        "fr" | "de" | "it" | "nl" | "fi" | "el" | "et" | "lv" | "lt" | "sk" | "sl" | "ga"
        | "mt" | "hr" => "EUR",
        "ja" => "JPY",
        "ko" => "KRW",
        "zh" => "CNY",
        "pl" => "PLN",
        "cs" => "CZK",
        "sv" => "SEK",
        "nb" | "nn" | "no" => "NOK",
        "da" => "DKK",
        "tr" => "TRY",
        "he" => "ILS",
        "ru" => "RUB",
        "hi" => "INR",
        _ => return None,
    })
}

/// Region of a locale tag: `fr-FR`, `fr_FR.UTF-8`, `zh-Hant-HK`, `en_GB@euro` → `FR`, `FR`, `HK`, `GB`.
fn locale_region(tag: &str) -> Option<String> {
    let base = tag.trim().split(['.', '@']).next().unwrap_or("");
    base.split(['-', '_'])
        .skip(1)
        .find(|p| p.len() == 2 && p.chars().all(|c| c.is_ascii_alphabetic()))
        .map(str::to_ascii_uppercase)
}

/// Currency for the OS locales, in preference order: the first locale whose region (or, without a
/// region, whose language) is known decides; USD when none is.
pub fn currency_from_locales<'a>(locales: impl IntoIterator<Item = &'a str>) -> &'static str {
    for l in locales {
        let l = l.trim();
        if l.is_empty() {
            continue;
        }
        if let Some(r) = locale_region(l) {
            if let Some(c) = region_currency(&r) {
                return c;
            }
            continue;
        }
        let lang = l
            .split(['-', '_', '.', '@'])
            .next()
            .unwrap_or("")
            .to_ascii_lowercase();
        if let Some(c) = lang_currency(&lang) {
            return c;
        }
    }
    DEFAULT_CURRENCY
}

/// The computer's currency (first run, or a saved currency Kyro no longer offers).
pub fn system_currency() -> &'static str {
    let locales: Vec<String> = sys_locale::get_locales().collect();
    currency_from_locales(locales.iter().map(String::as_str))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn region_decides() {
        let cases: &[(&[&str], &str)] = &[
            (&["fr-FR"], "EUR"),
            (&["de-DE"], "EUR"),
            (&["fr-BE"], "EUR"),
            (&["nl-NL"], "EUR"),
            (&["de-CH"], "CHF"),
            (&["fr-CH"], "CHF"),
            (&["en-GB"], "GBP"),
            (&["en-US"], "USD"),
            (&["fr-CA"], "CAD"),
            (&["en_AU.UTF-8"], "AUD"),
            (&["ja-JP"], "JPY"),
            (&["ko-KR"], "KRW"),
            (&["zh-Hant-HK"], "HKD"),
            (&["pt-BR"], "BRL"),
            (&["es-MX"], "MXN"),
            (&["en_GB@euro"], "GBP"),
            (&["sv-SE"], "SEK"),
            // Region Kyro has no currency for (Kenya): next locale, then USD.
            (&["sw-KE", "fr-FR"], "EUR"),
            (&["sw-KE"], "USD"),
            // Language only.
            (&["fr"], "EUR"),
            (&["ja"], "JPY"),
            (&["en"], "USD"),
            (&[], "USD"),
            (&["", "  "], "USD"),
            // `es-419` (Latin America): numeric region, skipped, no language guess for `es`.
            (&["es-419"], "USD"),
        ];
        for (locales, want) in cases {
            assert_eq!(
                currency_from_locales(locales.iter().copied()),
                *want,
                "{locales:?}"
            );
        }
    }

    #[test]
    fn every_default_is_offered() {
        for r in EURO_REGIONS
            .iter()
            .copied()
            .chain(["US", "GB", "CH", "JP", "RU", "IL"])
        {
            assert!(is_supported(region_currency(r).unwrap()), "{r}");
        }
        assert!(is_supported(DEFAULT_CURRENCY));
        assert_eq!(FIAT_CURRENCIES.len(), 26);
    }
}
