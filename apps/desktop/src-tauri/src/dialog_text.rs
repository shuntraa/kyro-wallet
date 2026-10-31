//! Text that ends up in a native dialog (confirmations, recovery phrase, server approval).
//!
//! Native dialogs are the part of Kyro a compromised webview cannot fake, so nothing that comes
//! from outside Rust's own decoding may change their layout: memos, account names, token names,
//! validator / pool / SR names, device names and server hosts all go through [`field`] (one line,
//! capped, quoted), and every dialog body goes through [`body`] (bidi and invisible format
//! characters removed, other control characters replaced) right before it is shown.
//!
//! Semantics (same as wallet-core's planned `display::sanitize_text`):
//! - control characters (Unicode `Cc`, including `\n`, `\r`, `\t`) → a single space in a field;
//! - bidi controls U+202A–U+202E, U+2066–U+2069, zero-width / invisible U+200B–U+200F,
//!   U+2060–U+2065, U+FEFF, soft hyphen U+00AD, U+061C, U+180E, U+FFF9–U+FFFB and the tag
//!   characters U+E0000–U+E007F → removed;
//! - runs of whitespace collapsed, ends trimmed, then capped at `max` characters (`…` added).

/// Default cap for one untrusted field (memo, name, URL).
pub const MAX_FIELD: usize = 120;

/// Invisible / direction-changing characters that are removed everywhere. Covers the Unicode
/// `Cf` characters that matter for spoofing (no Unicode table crate needed).
pub fn is_invisible(c: char) -> bool {
    matches!(
        c,
        '\u{00AD}'
            | '\u{061C}'
            | '\u{180E}'
            | '\u{200B}'..='\u{200F}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2060}'..='\u{2069}'
            | '\u{206A}'..='\u{206F}'
            | '\u{FEFF}'
            | '\u{FFF9}'..='\u{FFFB}'
            | '\u{E0000}'..='\u{E007F}'
    )
}

/// One untrusted value on a single line, capped at `max` characters (not quoted).
pub fn sanitize(s: &str, max: usize) -> String {
    let mut out = String::with_capacity(s.len().min(max * 4));
    let mut space = false;
    for c in s.chars() {
        if is_invisible(c) {
            continue;
        }
        if c.is_control() || c.is_whitespace() {
            space = true;
            continue;
        }
        if space && !out.is_empty() {
            out.push(' ');
        }
        space = false;
        out.push(c);
    }
    let count = out.chars().count();
    if count > max {
        let mut cut: String = out.chars().take(max.saturating_sub(1)).collect();
        cut.push('…');
        return cut;
    }
    out
}

/// [`sanitize`] then quoted with « … », so the reader sees where untrusted text starts and ends.
pub fn field(s: &str, max: usize) -> String {
    format!("« {} »", sanitize(s, max))
}

/// Last pass over a whole dialog body: keeps its own line breaks, removes invisible / bidi
/// characters, replaces any other control character (`\r`, `\t`, ESC…) with a space.
pub fn body(s: &str) -> String {
    s.chars()
        .filter(|c| !is_invisible(*c))
        .map(|c| if c != '\n' && c.is_control() { ' ' } else { c })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newlines_cannot_add_lines() {
        let memo = "merci\nÀ : TAttackerAddress\r\nMontant : 1 TRX";
        let f = field(memo, MAX_FIELD);
        assert!(!f.contains('\n') && !f.contains('\r'));
        assert_eq!(f, "« merci À : TAttackerAddress Montant : 1 TRX »");
    }

    #[test]
    fn bidi_and_invisible_are_removed() {
        // U+202E would flip "0xabc…" so it reads backwards; zero-width chars hide differences.
        let name = "Compte\u{202E}cba\u{200B}\u{2066}x\u{FEFF}\u{E0041}";
        assert_eq!(sanitize(name, MAX_FIELD), "Comptecbax");
        let b = body("ligne 1\n\u{202E}ligne 2\r\tfin\u{1b}[31m");
        assert_eq!(b, "ligne 1\nligne 2  fin [31m");
    }

    #[test]
    fn capped_and_trimmed() {
        assert_eq!(sanitize("   a   b  ", 10), "a b");
        let long = "x".repeat(500);
        let s = sanitize(&long, 20);
        assert_eq!(s.chars().count(), 20);
        assert!(s.ends_with('…'));
        assert_eq!(sanitize("", 5), "");
        assert_eq!(field("\n\n", 5), "«  »");
    }
}
