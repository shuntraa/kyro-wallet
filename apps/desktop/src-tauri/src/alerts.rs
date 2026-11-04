//! Local alerts (price, funds received): the only place Kyro shows an OS notification.
//!
//! The interface decides *when* (it compares data the app already fetched, nothing is sent
//! anywhere); Rust decides *what is written*. The webview has no notification permission and
//! cannot pass free text: it names a template and gives a symbol and a formatted number, both
//! checked here, so a compromised interface cannot write « your wallet is at risk, go to … » in
//! a system notification. A limit per minute stops it from flooding the screen.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

use crate::error::{AppError, AppResult};
use crate::i18n::Lang;

const MAX_PER_MINUTE: usize = 6;
const MAX_SYMBOL: usize = 12;
const MAX_FIGURE: usize = 32;
/// Letters allowed in a figure: a currency code (« CHF 64,000.00 »), not a word.
const MAX_FIGURE_LETTERS: usize = 3;

/// One of the fixed notification texts.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AlertNote {
    /// The price rose past the user's level.
    PriceAbove { symbol: String, price: String },
    /// The price fell past the user's level.
    PriceBelow { symbol: String, price: String },
    /// Funds arrived. No amount while balances are hidden.
    Received {
        symbol: String,
        amount: Option<String>,
    },
    /// Settings › Alerts › Try it.
    Test,
}

fn check_symbol(s: &str) -> AppResult<&str> {
    let ok = !s.is_empty()
        && s.len() <= MAX_SYMBOL
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"$.-".contains(&b));
    ok.then_some(s)
        .ok_or_else(|| AppError::InvalidInput("invalid alert symbol".into()))
}

fn check_figure(s: &str) -> AppResult<&str> {
    let allowed = |c: char| {
        c.is_ascii_digit() || c.is_ascii_uppercase() || " .,'$€£¥\u{a0}\u{202f}".contains(c)
    };
    let ok = s.chars().any(|c| c.is_ascii_digit())
        && s.chars().count() <= MAX_FIGURE
        && s.chars().all(allowed)
        && s.chars().filter(char::is_ascii_uppercase).count() <= MAX_FIGURE_LETTERS;
    ok.then_some(s)
        .ok_or_else(|| AppError::InvalidInput("invalid alert figure".into()))
}

/// Title and body of a notification.
pub fn render(lang: Lang, note: &AlertNote) -> AppResult<(String, String)> {
    Ok(match note {
        AlertNote::PriceAbove { symbol, price } => {
            let (symbol, price) = (check_symbol(symbol)?, check_figure(price)?);
            match lang {
                Lang::Fr => (
                    format!("{symbol} au-dessus de ton alerte"),
                    format!("Prix actuel : {price}"),
                ),
                Lang::En => (
                    format!("{symbol} is above your alert"),
                    format!("Price now: {price}"),
                ),
            }
        }
        AlertNote::PriceBelow { symbol, price } => {
            let (symbol, price) = (check_symbol(symbol)?, check_figure(price)?);
            match lang {
                Lang::Fr => (
                    format!("{symbol} sous ton alerte"),
                    format!("Prix actuel : {price}"),
                ),
                Lang::En => (
                    format!("{symbol} is below your alert"),
                    format!("Price now: {price}"),
                ),
            }
        }
        AlertNote::Received { symbol, amount } => {
            let symbol = check_symbol(symbol)?;
            let title = lang.pick("Fonds reçus", "Funds received").to_string();
            match amount {
                Some(a) => (title, format!("{} {symbol}", check_figure(a)?)),
                None => (title, symbol.to_string()),
            }
        }
        AlertNote::Test => (
            lang.pick("Alertes Kyro", "Kyro alerts").to_string(),
            lang.pick(
                "Tes alertes s'afficheront ici.",
                "Your alerts will show up here.",
            )
            .to_string(),
        ),
    })
}

/// Sliding one-minute window: `true` when one more notification may be shown.
fn allow(sent: &mut VecDeque<Instant>, now: Instant) -> bool {
    while sent
        .front()
        .is_some_and(|t| now.duration_since(*t) >= Duration::from_secs(60))
    {
        sent.pop_front();
    }
    if sent.len() >= MAX_PER_MINUTE {
        return false;
    }
    sent.push_back(now);
    true
}

static SENT: Mutex<VecDeque<Instant>> = Mutex::new(VecDeque::new());

/// Shows one local notification. Past the limit it is dropped, without an error.
#[tauri::command]
pub fn alert_notify(app: AppHandle, note: AlertNote) -> AppResult<()> {
    let (title, body) = render(crate::i18n::current(), &note)?;
    let mut sent = SENT.lock().unwrap_or_else(|e| e.into_inner());
    if !allow(&mut sent, Instant::now()) {
        return Ok(());
    }
    drop(sent);
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|_| AppError::Internal("notification failed".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn price(symbol: &str, price: &str) -> AlertNote {
        AlertNote::PriceAbove {
            symbol: symbol.into(),
            price: price.into(),
        }
    }

    #[test]
    fn fixed_texts_in_both_languages() {
        let (t, b) = render(Lang::En, &price("BTC", "$70,123.00")).unwrap();
        assert_eq!(
            (t.as_str(), b.as_str()),
            ("BTC is above your alert", "Price now: $70,123.00")
        );
        let (t, _) = render(Lang::Fr, &price("BTC", "70\u{202f}123,00\u{a0}€")).unwrap();
        assert_eq!(t, "BTC au-dessus de ton alerte");
    }

    #[test]
    fn hidden_balances_show_no_amount() {
        let note = AlertNote::Received {
            symbol: "ETH".into(),
            amount: None,
        };
        assert_eq!(render(Lang::En, &note).unwrap().1, "ETH");
    }

    #[test]
    fn free_text_is_refused() {
        for (symbol, figure) in [
            ("URGENT: go to evil.example", "1"),
            ("BTC\nFake line", "1"),
            ("", "1"),
            ("BTC", "VISIT EVIL 1"),
            ("BTC", "no digits"),
            ("BTC", "1\n2"),
            ("BTC", "111111111111111111111111111111111"),
        ] {
            assert!(
                render(Lang::En, &price(symbol, figure)).is_err(),
                "{symbol}"
            );
        }
        assert!(render(Lang::En, &price("USDC.e", "CHF 1.00")).is_ok());
    }

    #[test]
    fn limit_per_minute() {
        let mut q = VecDeque::new();
        let t0 = Instant::now();
        for _ in 0..MAX_PER_MINUTE {
            assert!(allow(&mut q, t0));
        }
        assert!(!allow(&mut q, t0 + Duration::from_secs(59)));
        assert!(allow(&mut q, t0 + Duration::from_secs(60)));
    }
}
