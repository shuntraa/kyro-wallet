//! Text taken from chain data (memos, CIP-20 messages, seeds, token names) before it reaches a
//! confirmation dialog.
//!
//! A transaction can carry arbitrary UTF-8. Shown as is, line breaks can push the real content
//! of a dialog out of view, and Unicode bidi / invisible characters can make text read
//! differently from what it is (`U+202E` reverses what follows, `U+200B` hides a separator).
//! [`sanitize_text`] is the single place where Kyro turns such text into something safe to show:
//!
//! - control characters (Unicode category Cc: C0, DEL, C1) are replaced — `\n`, `\r`, `\t` by a
//!   space, the others by [`CONTROL_MARKER`];
//! - format, bidi and invisible characters are removed (`U+00AD`, `U+061C`, `U+180E`,
//!   `U+200B`–`U+200F`, `U+202A`–`U+202E`, `U+2060`–`U+206F`, `U+FEFF`, `U+FFF9`–`U+FFFB`,
//!   tag characters `U+E0000`–`U+E007F`); line / paragraph separators (`U+2028`, `U+2029`)
//!   become a space;
//! - the result is capped at `max_chars` characters, the last one being `…`.
//!
//! Whenever anything was changed, [`SanitizedText::altered`] is `true`: decoders then add a
//! warning and require the reinforced confirmation.

use serde::{Deserialize, Serialize};

/// Shown in place of a control character other than `\n`, `\r`, `\t`.
pub const CONTROL_MARKER: char = '\u{FFFD}';
/// Appended when the text was cut.
pub const ELLIPSIS: char = '…';

/// Result of [`sanitize_text`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SanitizedText {
    /// Text safe to display.
    pub text: String,
    /// Something was replaced, removed or cut: the original differs from `text`.
    pub altered: bool,
    /// The text was longer than the limit and was cut (implies `altered`).
    pub truncated: bool,
}

/// Format / bidi / invisible characters removed from displayed text.
fn is_hidden(c: char) -> bool {
    matches!(
        c,
        '\u{00AD}'
            | '\u{061C}'
            | '\u{180E}'
            | '\u{200B}'..='\u{200F}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2060}'..='\u{206F}'
            | '\u{FEFF}'
            | '\u{FFF9}'..='\u{FFFB}'
            | '\u{E0000}'..='\u{E007F}'
    )
}

/// Makes chain-provided text safe to display (see the module documentation). `max_chars` is the
/// maximum number of characters returned, ellipsis included (0 is treated as 1).
pub fn sanitize_text(s: &str, max_chars: usize) -> SanitizedText {
    let max_chars = max_chars.max(1);
    let mut cleaned = String::with_capacity(s.len().min(max_chars.saturating_mul(4)));
    let mut altered = false;
    let mut count = 0usize;
    let mut truncated = false;
    for c in s.chars() {
        let out = if is_hidden(c) {
            altered = true;
            continue;
        } else if matches!(c, '\n' | '\r' | '\t' | '\u{2028}' | '\u{2029}') {
            altered = true;
            ' '
        } else if c.is_control() {
            altered = true;
            CONTROL_MARKER
        } else {
            c
        };
        if count == max_chars {
            truncated = true;
            break;
        }
        cleaned.push(out);
        count += 1;
    }
    if truncated {
        cleaned.pop();
        cleaned.push(ELLIPSIS);
        altered = true;
    }
    SanitizedText {
        text: cleaned,
        altered,
        truncated,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_text_is_untouched() {
        let s = sanitize_text("Facture 42 — merci ! 日本語 🙂", 80);
        assert_eq!(s.text, "Facture 42 — merci ! 日本語 🙂");
        assert!(!s.altered && !s.truncated);
        // Exactly at the limit: not cut.
        let s = sanitize_text("abcde", 5);
        assert_eq!(s.text, "abcde");
        assert!(!s.altered);
    }

    #[test]
    fn controls_are_replaced() {
        let s = sanitize_text("a\nb\r\tc\u{0}d\u{1b}[31me\u{7f}\u{85}", 80);
        assert_eq!(s.text, "a b  c\u{FFFD}d\u{FFFD}[31me\u{FFFD}\u{FFFD}");
        assert!(s.altered && !s.truncated);
        assert!(!s.text.chars().any(char::is_control));
    }

    #[test]
    fn bidi_and_invisible_characters_are_removed() {
        // "pay to evil" written with a right-to-left override, zero-width spaces, a BOM, a
        // soft hyphen, an isolate and a tag character.
        let s = sanitize_text(
            "pay\u{202E}live\u{202C} to\u{200B}\u{FEFF} x\u{00AD}y\u{2066}z\u{2069}\u{E0041}",
            80,
        );
        assert_eq!(s.text, "paylive to xyz");
        assert!(s.altered);
        let s = sanitize_text("line\u{2028}para\u{2029}end", 80);
        assert_eq!(s.text, "line para end");
        assert!(s.altered);
    }

    #[test]
    fn long_text_is_cut_with_an_ellipsis() {
        let s = sanitize_text(&"é".repeat(100), 10);
        assert_eq!(s.text.chars().count(), 10);
        assert!(s.text.ends_with('…'));
        assert!(s.altered && s.truncated);
        assert_eq!(sanitize_text("abc", 0).text, "…");
        // Removed characters do not count against the limit.
        let s = sanitize_text("\u{200B}\u{200B}\u{200B}abc", 3);
        assert_eq!(s.text, "abc");
        assert!(s.altered && !s.truncated);
    }
}
