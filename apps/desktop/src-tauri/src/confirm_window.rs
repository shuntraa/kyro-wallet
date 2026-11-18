//! The signature confirmation window (SECURITY.md « Native confirmation », docs/IPC.md).
//!
//! Every signature is approved here. The window mirrors the phrase window (`phrase_window.rs`):
//! Rust writes the page itself from the body it decoded and serves it from a dedicated scheme
//! (`kyroconfirm`), i.e. an origin of its own that the main webview cannot read, script, frame or
//! navigate to. The `confirm` label has no capability (no IPC command), the protocol answers only
//! that window, the window uses a private profile, cannot navigate elsewhere or open windows.
//!
//! The page has one script, allowed by its hash: Escape = Cancel. The buttons are plain links to
//! the scheme; the handler turns `/approve/<nonce>` into an approval (only once the page has been
//! on screen for [`ARM_MS`]) and `/cancel` into a refusal. Closing or losing the window refuses.
//! Nothing is focused when it opens: a stray Enter does nothing.
//!
//! If the window cannot be created, the caller falls back to the OS message box.

use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::Engine as _;
use sha2::{Digest, Sha256};
use tauri::http::{header, Request, Response, StatusCode};
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, Runtime, UriSchemeContext, Url, WebviewUrl, WindowEvent};
use tokio::sync::oneshot;

use crate::error::{AppError, AppResult};
use crate::i18n::Lang;

/// Window label. No capability names it: the page cannot call any command.
pub const LABEL: &str = "confirm";
/// Scheme of the page: an origin of its own, separate from the main interface's.
pub const SCHEME: &str = "kyroconfirm";
const APPROVE_PATH: &str = "/approve/";
const CANCEL_PATH: &str = "/cancel";
const SANS_PATH: &str = "/font/sans.woff2";
const MONO_PATH: &str = "/font/mono.woff2";
const DISPLAY_PATH: &str = "/font/display.woff2";
/// An approval earlier than this after the page was served is ignored (a click meant for the
/// main window landing on « Sign » as the window appears).
pub const ARM_MS: u64 = 700;
/// Window width (logical px).
const WIDTH: f64 = 540.0;

struct Pending {
    page: String,
    nonce: String,
    served: Option<Instant>,
    answer: oneshot::Sender<bool>,
}

/// The confirmation being shown, if any.
#[derive(Default)]
pub struct ConfirmState {
    pending: Mutex<Option<Pending>>,
}

/// Asset keys of the app's fonts (Geist, Geist Mono, Unbounded), found once at startup.
static FONTS: OnceLock<[Option<String>; 3]> = OnceLock::new();

/// Remembers which bundled assets are the Latin Geist / Geist Mono / Unbounded fonts.
pub fn remember_fonts<'a>(keys: impl Iterator<Item = &'a str>) {
    let mut f: [Option<String>; 3] = Default::default();
    for k in keys {
        let name = k.rsplit('/').next().unwrap_or_default();
        if !name.ends_with(".woff2") {
            continue;
        }
        let slot = if name.starts_with("geist-latin-wght-normal") {
            0
        } else if name.starts_with("geist-mono-latin-wght-normal") {
            1
        } else if name.starts_with("unbounded-latin-wght-normal") {
            2
        } else {
            continue;
        };
        f[slot] = Some(format!("/{}", k.trim_start_matches('/')));
    }
    let _ = FONTS.set(f);
}

/// URL of the page (Windows: `http://kyroconfirm.localhost/`, elsewhere `kyroconfirm://localhost/`).
fn page_url() -> Url {
    let s = if cfg!(any(windows, target_os = "android")) {
        format!("http://{SCHEME}.localhost/")
    } else {
        format!("{SCHEME}://localhost/")
    };
    Url::parse(&s).expect("static URL")
}

/// True for the confirmation page's own URLs (the only ones its window may load).
pub fn is_confirm_url(url: &Url) -> bool {
    let host = url.host_str().unwrap_or_default();
    let ok = if cfg!(any(windows, target_os = "android")) {
        url.scheme() == "http" && host == format!("{SCHEME}.localhost")
    } else {
        url.scheme() == SCHEME && host == "localhost"
    };
    ok && url.port().is_none() && url.username().is_empty() && url.password().is_none()
}

fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c if c.is_control() || crate::dialog_text::is_invisible(c) => {}
            c => out.push(c),
        }
    }
    out
}

const STYLE: &str = r#"
@font-face{font-family:'Geist';src:url(/font/sans.woff2) format('woff2');font-weight:100 900;font-display:block}
@font-face{font-family:'Geist Mono';src:url(/font/mono.woff2) format('woff2');font-weight:100 900;font-display:block}
@font-face{font-family:'Unbounded Variable';src:url(/font/display.woff2) format('woff2');font-weight:200 900;font-display:block}
:root{color-scheme:dark;--bg:#0b0e13;--bar:#0e1218;--text:#f1f4f7;--text2:#c6ccd4;--mute:#8d949f;--faint:#636a75;--ice:#7cc4ff;--btc:#f7931a;--warm:#f5b74f}
*{box-sizing:border-box;-webkit-user-select:none;user-select:none;-webkit-user-drag:none}
::selection{background:transparent}
html,body{margin:0;height:100%;background:#07090d;color:var(--text);font:13px/1.5 'Geist','Segoe UI',system-ui,sans-serif;-webkit-font-smoothing:antialiased;overflow:hidden}
body{display:flex;flex-direction:column;border:1px solid rgba(170,220,255,.13);background:radial-gradient(90% 46% at 50% -6%,rgba(124,196,255,.15),transparent 72%),radial-gradient(60% 40% at 100% 100%,rgba(139,124,255,.07),transparent 70%),linear-gradient(180deg,#0e1826 0%,#0a0f16 48%,#07090d 100%)}
.bar{flex:none;display:flex;align-items:center;gap:8px;height:36px;padding:0 6px 0 14px;background:transparent;border-bottom:1px solid rgba(255,255,255,.06);color:var(--text2);font-size:12px;app-region:drag;-webkit-app-region:drag}
.bar svg{width:14px;height:14px;flex:none}
.bar .t{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.x{app-region:no-drag;-webkit-app-region:no-drag;display:grid;place-items:center;width:28px;height:26px;border-radius:6px;color:var(--faint);text-decoration:none}
.x:hover{background:rgba(255,255,255,.06);color:var(--text)}
.x svg{width:12px;height:12px}
main{flex:1;min-height:0;overflow-y:auto;padding:22px 28px 0;display:flex;flex-direction:column}
.signer{margin:0 0 14px;color:var(--faint);font-size:11.5px;overflow-wrap:anywhere}
.label{display:flex;align-items:center;gap:8px;color:var(--faint);font-size:11px;font-weight:500;letter-spacing:.16em;text-transform:uppercase}
.label i{width:5px;height:5px;background:var(--ice);box-shadow:0 0 8px var(--ice);flex:none}
.intro{margin:14px 0 0;color:var(--text2);font-size:14px}
.big{margin:12px 0 4px;font:300 36px/1.05 'Unbounded Variable','Unbounded','Geist',sans-serif;letter-spacing:-.035em;font-feature-settings:'tnum' 1;color:#eaf5ff;text-shadow:0 0 34px rgba(124,196,255,.4),0 0 3px rgba(124,196,255,.27);overflow-wrap:anywhere}
.big small{margin-left:10px;font-size:18px;letter-spacing:-.02em}
.big.btc{color:var(--btc);text-shadow:0 0 34px rgba(247,147,26,.4),0 0 3px rgba(247,147,26,.27)}
.btcv{color:var(--btc);text-shadow:0 0 16px rgba(247,147,26,.5),0 0 2px rgba(247,147,26,.33)}
.alabel{margin:18px 0 0;color:var(--mute);font-size:12px}
.addr{margin:7px 0 0;padding:10px 13px;border-radius:12px;background:rgba(22,27,35,.72);box-shadow:inset 0 0 0 1px rgba(255,255,255,.08),inset 0 1px 0 rgba(170,220,255,.06);font:14px/1.7 'Geist Mono',ui-monospace,Consolas,monospace;letter-spacing:.03em;color:var(--mute);display:flex;flex-wrap:wrap;column-gap:7px}
.addr .hi{color:#eaf5ff;font-weight:600;text-shadow:0 0 14px rgba(124,196,255,.35)}
.addr.sub{margin:2px 0 0;padding:0;background:none;box-shadow:none;font-size:12px;line-height:1.6;justify-content:flex-end;column-gap:5px}
.rows{margin:16px 0 0;display:flex;flex-direction:column;padding:2px 13px;border-radius:12px;background:rgba(22,27,35,.5);box-shadow:inset 0 0 0 1px rgba(255,255,255,.06)}
.row{padding:10px 0;border-bottom:1px solid rgba(255,255,255,.05)}
.row:last-child{border-bottom:0}
.kv{display:flex;gap:16px;align-items:baseline}
.k{flex:none;max-width:48%;color:var(--mute)}
.v{margin-left:auto;text-align:right;color:var(--text2);font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.v.strong{color:var(--text);font-weight:600}
.subt{margin:2px 0 0;text-align:right;color:var(--mute);font-size:12px;overflow-wrap:anywhere}
p.para{margin:14px 0 0;color:var(--text2);overflow-wrap:anywhere}
p.bullet{margin:8px 0 0;padding-left:14px;position:relative;color:var(--text2);overflow-wrap:anywhere}
p.bullet::before{content:'';position:absolute;left:2px;top:.62em;width:4px;height:4px;background:var(--warm)}
footer{flex:none;display:flex;gap:10px;padding:20px 28px 24px}
.btn{display:flex;align-items:center;justify-content:center;height:46px;border-radius:999px;font-weight:600;text-decoration:none;font-size:14px;padding:0 14px;text-align:center}
.cancel{flex:1;background:rgba(22,27,35,.72);box-shadow:inset 0 0 0 1px rgba(124,196,255,.22);color:var(--text)}
.cancel:hover{background:rgba(30,38,50,.8);box-shadow:inset 0 0 0 1px rgba(124,196,255,.4)}
.sign{flex:1.6;background:linear-gradient(180deg,#e6f3ff,#c2e0fa);color:#061423;font-size:14.5px;box-shadow:inset 0 1px 0 rgba(255,255,255,.95),inset 0 -1px 0 rgba(53,119,180,.35),inset 0 0 0 1px rgba(255,255,255,.35),0 10px 30px -12px rgba(124,196,255,.85);animation:arm .7s step-end both}
.sign:hover{background:linear-gradient(180deg,#fff,#e6f3ff)}
@keyframes arm{from{pointer-events:none}to{pointer-events:auto}}
a:focus{outline:none}
a:focus-visible{outline:1.5px solid var(--ice);outline-offset:2px}
"#;

/// The page's only script: Escape = Cancel.
const SCRIPT: &str = "addEventListener('keydown',function(e){if(e.key==='Escape'){e.preventDefault();location.replace('/cancel')}});";

const MARK: &str = r##"<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M47.32 44.86 A20 20 0 1 1 47.32 19.14" fill="none" stroke="#F5F7FA" stroke-width="11"/><rect x="25" y="25" width="14" height="14" fill="#7CC4FF"/></svg>"##;
const CROSS: &str = r#"<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>"#;

fn sha(s: &str) -> String {
    base64::engine::general_purpose::STANDARD.encode(Sha256::digest(s.as_bytes()))
}

/// The page's Content-Security-Policy: its own style, its Escape script, its fonts; nothing else.
fn csp() -> String {
    format!(
        "default-src 'none'; script-src 'sha256-{}'; style-src 'sha256-{}'; font-src 'self'; \
         img-src 'none'; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; \
         worker-src 'none'; manifest-src 'none'; base-uri 'none'; form-action 'none'; \
         frame-ancestors 'none'",
        sha(SCRIPT),
        sha(STYLE)
    )
}

// ---------- Reading the body ----------

/// One piece of the body, in the body's order.
#[derive(Debug, PartialEq, Eq)]
enum Block {
    /// « Compte signataire : … » / « Signing account: … » (shown small, at the top).
    Signer(String),
    /// Blank line in the body.
    Gap,
    Para(String),
    Bullet(String),
    /// « To: <address> »: the label above, the address in groups of 4.
    Addr {
        label: String,
        addr: String,
    },
    /// « Key : value », with the indented lines that follow it.
    Row {
        key: String,
        value: String,
        subs: Vec<String>,
    },
}

/// Splits « Key : value » (FR) / « Key: value » (EN). The key must be short and plain: Rust's own
/// words, never a quoted untrusted field.
fn split_kv(line: &str) -> Option<(&str, &str)> {
    let i = line.find(':')?;
    let (k, rest) = (line[..i].trim(), &line[i + 1..]);
    if !rest.starts_with(' ') {
        return None;
    }
    let v = rest.trim();
    let bad = k.is_empty()
        || v.is_empty()
        || k.chars().count() > 40
        || k.contains(['«', '»', '•', '"'])
        || k.starts_with(char::is_whitespace);
    (!bad).then_some((k, v))
}

/// A single token that looks like an address or a hash (shown in groups of 4).
fn is_address(s: &str) -> bool {
    let n = s.chars().count();
    (20..=130).contains(&n)
        && s.chars().any(|c| c.is_ascii_digit())
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '_' | '-'))
}

fn is_signer_key(k: &str) -> bool {
    k == "Compte signataire" || k == "Signing account"
}

fn parse(body: &str) -> Vec<Block> {
    let mut out: Vec<Block> = Vec::new();
    for raw in body.split('\n') {
        let line = raw.trim_end();
        if line.trim().is_empty() {
            if !matches!(out.last(), None | Some(Block::Gap)) {
                out.push(Block::Gap);
            }
            continue;
        }
        let indented = line.starts_with(char::is_whitespace);
        let text = line.trim();
        if indented {
            if let Some(Block::Row { subs, .. }) = out.last_mut() {
                subs.push(text.to_string());
                continue;
            }
        }
        if let Some(b) = text.strip_prefix('•') {
            out.push(Block::Bullet(b.trim().to_string()));
            continue;
        }
        if !indented {
            if let Some((k, v)) = split_kv(text) {
                if out.is_empty() && is_signer_key(k) {
                    out.push(Block::Signer(text.to_string()));
                } else if is_address(v) {
                    out.push(Block::Addr {
                        label: k.to_string(),
                        addr: v.to_string(),
                    });
                } else {
                    out.push(Block::Row {
                        key: k.to_string(),
                        value: v.to_string(),
                        subs: vec![],
                    });
                }
                continue;
            }
        }
        if indented && is_address(text) {
            out.push(Block::Addr {
                label: String::new(),
                addr: text.to_string(),
            });
            continue;
        }
        out.push(Block::Para(text.to_string()));
    }
    while matches!(out.last(), Some(Block::Gap)) {
        out.pop();
    }
    out
}

fn is_amount_key(k: &str) -> bool {
    k == "Montant" || k == "Amount"
}

/// The headline: the amount, when the body has exactly one plain « Amount » line of the form
/// `<number> <UNIT>[ …]`. Several amounts (several outputs): no headline, the rows say it all.
fn headline(blocks: &[Block]) -> Option<(String, String)> {
    let mut found = blocks.iter().filter_map(|b| match b {
        Block::Row { key, value, .. } if is_amount_key(key) => Some(value.as_str()),
        _ => None,
    });
    let value = found.next()?;
    if found.next().is_some() || value.contains(['«', '»']) {
        return None;
    }
    let mut it = value.splitn(3, ' ');
    amount_parts(it.next()?, it.next()?)
}

/// `<number> <UNIT>`, both plain (digits and separators; a short ticker).
fn amount_parts(num: &str, unit: &str) -> Option<(String, String)> {
    let numeric = num.chars().any(|c| c.is_ascii_digit())
        && num
            .chars()
            .all(|c| c.is_ascii_digit() || matches!(c, ',' | '.' | '\u{202F}' | '\u{A0}'));
    let unit_ok = (1..=12).contains(&unit.chars().count())
        && unit
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '.' | '-' | '_' | '$'));
    (numeric && unit_ok).then(|| (num.to_string(), unit.to_string()))
}

/// A plain native send has no « Amount » row but Rust's own line « Sending 1.5 ETH » /
/// « Envoi de 1,5 ETH » (exactly that, nothing else on the line): it becomes the headline.
/// Returns the block's index, the verb shown above the figure, the number and the unit.
fn sending_head(blocks: &[Block]) -> Option<(usize, &'static str, String, String)> {
    let mut found = blocks.iter().enumerate().filter_map(|(i, b)| match b {
        Block::Para(p) => {
            let (verb, rest) = if let Some(r) = p.strip_prefix("Sending ") {
                ("Sending", r)
            } else {
                ("Envoi", p.strip_prefix("Envoi de ")?)
            };
            let mut it = rest.split(' ');
            let (num, unit) = (it.next()?, it.next()?);
            if it.next().is_some() {
                return None;
            }
            amount_parts(num, unit).map(|(n, u)| (i, verb, n, u))
        }
        _ => None,
    });
    let one = found.next()?;
    found.next().is_none().then_some(one)
}

fn push_addr(out: &mut String, addr: &str, class: &str) {
    let chars: Vec<char> = addr.chars().collect();
    let groups: Vec<String> = chars.chunks(4).map(|c| c.iter().collect()).collect();
    let n = groups.len();
    out.push_str(&format!("<div class=\"{class}\">"));
    for (i, g) in groups.iter().enumerate() {
        let hi = i < 2 || i + 2 >= n;
        out.push_str(if hi { "<span class=\"hi\">" } else { "<span>" });
        out.push_str(&escape(g));
        out.push_str("</span>");
    }
    out.push_str("</div>");
}

/// What the window shows: title, the sanitised body, the two button labels.
pub struct ConfirmView<'a> {
    pub title: &'a str,
    pub body: &'a str,
    pub ok: &'a str,
    pub cancel: &'a str,
}

/// The whole page. `nonce` goes into the approve link only.
pub fn render(lang: Lang, view: &ConfirmView<'_>, nonce: &str) -> String {
    let body = crate::dialog_text::body(view.body);
    let blocks = parse(&body);
    let mut head = headline(&blocks);
    // Without an « Amount » row, Rust's « Sending 1.5 ETH » line is the headline (and leaves the body).
    let mut skip: Option<usize> = None;
    let mut verb: Option<&str> = None;
    if head.is_none() {
        if let Some((i, v, n, u)) = sending_head(&blocks) {
            head = Some((n, u));
            skip = Some(i);
            verb = Some(v);
        }
    }
    let is_tx = blocks
        .iter()
        .any(|b| matches!(b, Block::Row { .. } | Block::Addr { .. }));
    let mut out = String::with_capacity(8192 + body.len() * 3);
    let title = format!("Kyro · {}", view.title);
    out.push_str(&format!(
        "<!doctype html><html lang=\"{}\"><head><meta charset=\"utf-8\">\
         <meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\
         <meta name=\"referrer\" content=\"no-referrer\"><title>{}</title><style>{STYLE}</style>\
         <script>{SCRIPT}</script></head><body><div class=\"bar\">{MARK}<span class=\"t\">{}</span>\
         <a class=\"x\" href=\"{CANCEL_PATH}\" aria-label=\"{}\">{CROSS}</a></div><main>",
        lang.pick("fr", "en"),
        escape(&title),
        escape(&title),
        escape(view.cancel),
    ));
    let mut rest = &blocks[..];
    let mut at = 0usize;
    if let Some(Block::Signer(s)) = rest.first() {
        out.push_str(&format!("<p class=\"signer\">{}</p>", escape(s)));
        rest = &rest[1..];
        at += 1;
    }
    while matches!(rest.first(), Some(Block::Gap)) {
        rest = &rest[1..];
        at += 1;
    }
    out.push_str(&format!(
        "<div class=\"label\"><i></i>{}</div>",
        escape(if is_tx {
            lang.pick(
                "Ce que Kyro a lu dans la transaction",
                "What Kyro read in the transaction",
            )
        } else {
            lang.pick("Kyro te demande de confirmer", "Kyro asks you to confirm")
        })
    ));
    let btc = head.as_ref().is_some_and(|(_, u)| u == "BTC");
    if let Some((num, unit)) = &head {
        // The short line that opens the body (« Envoi Bitcoin ») goes above the figure.
        if let Some(v) = verb {
            out.push_str(&format!("<p class=\"intro\">{}</p>", escape(v)));
        } else if let Some(Block::Para(p)) = rest.first() {
            if p.chars().count() <= 48 {
                out.push_str(&format!("<p class=\"intro\">{}</p>", escape(p)));
                rest = &rest[1..];
                at += 1;
            }
        }
        out.push_str(&format!(
            "<div class=\"big{}\">{}<small>{}</small></div>",
            if btc { " btc" } else { "" },
            escape(num),
            escape(unit)
        ));
    }
    let mut in_rows = false;
    for (i, b) in rest.iter().enumerate() {
        // A blank line between rows keeps them in one list (no double rule).
        if matches!(b, Block::Gap) || skip == Some(at + i) {
            continue;
        }
        let is_row = matches!(b, Block::Row { .. });
        if is_row && !in_rows {
            out.push_str("<div class=\"rows\">");
            in_rows = true;
        } else if !is_row && in_rows {
            out.push_str("</div>");
            in_rows = false;
        }
        match b {
            Block::Signer(s) | Block::Para(s) => {
                out.push_str(&format!("<p class=\"para\">{}</p>", escape(s)));
            }
            Block::Bullet(s) => out.push_str(&format!("<p class=\"bullet\">{}</p>", escape(s))),
            Block::Gap => {}
            Block::Addr { label, addr } => {
                if !label.is_empty() {
                    out.push_str(&format!("<div class=\"alabel\">{}</div>", escape(label)));
                }
                push_addr(&mut out, addr, "addr");
            }
            Block::Row { key, value, subs } => {
                let strong = key.starts_with("Total");
                let v = if btc && is_amount_key(key) {
                    format!("<span class=\"btcv\">{}</span>", escape(value))
                } else {
                    escape(value)
                };
                out.push_str(&format!(
                    "<div class=\"row\"><div class=\"kv\"><span class=\"k\">{}</span>\
                     <span class=\"v{}\">{v}</span></div>",
                    escape(key),
                    if strong { " strong" } else { "" },
                ));
                for s in subs {
                    if is_address(s) {
                        push_addr(&mut out, s, "addr sub");
                    } else {
                        out.push_str(&format!("<div class=\"subt\">{}</div>", escape(s)));
                    }
                }
                out.push_str("</div>");
            }
        }
    }
    if in_rows {
        out.push_str("</div>");
    }
    out.push_str(&format!(
        "</main><footer><a class=\"btn cancel\" href=\"{CANCEL_PATH}\">{}</a>\
         <a class=\"btn sign\" href=\"{APPROVE_PATH}{}\">{}</a></footer></body></html>",
        escape(view.cancel),
        escape(nonce),
        escape(view.ok),
    ));
    out
}

/// Height (logical px) that fits the page, estimated from its blocks.
fn estimate_height(body: &str) -> f64 {
    let blocks = parse(&crate::dialog_text::body(body));
    let lines = |s: &str, per: usize| s.chars().count().div_ceil(per).max(1) as f64;
    let mut h = 36.0 + 22.0 + 18.0 + 92.0 + 8.0;
    if headline(&blocks).is_some() {
        h += 80.0;
    } else if sending_head(&blocks).is_some() {
        h += 80.0 - 34.0;
    }
    let mut in_rows = false;
    for b in &blocks {
        let is_row = matches!(b, Block::Row { .. });
        if is_row && !in_rows {
            h += 16.0;
        }
        in_rows = is_row;
        h += match b {
            Block::Signer(s) => 4.0 + 18.0 * lines(s, 80),
            Block::Gap => 0.0,
            Block::Para(s) => 14.0 + 20.0 * lines(s, 66),
            Block::Bullet(s) => 8.0 + 20.0 * lines(s, 64),
            Block::Addr { label, addr } => {
                (if label.is_empty() { 26.0 } else { 62.0 })
                    + 24.0 * (addr.chars().count().div_ceil(4) as f64 / 11.0).ceil()
            }
            Block::Row { value, subs, .. } => {
                21.0 + 20.0 * lines(value, 44)
                    + subs.iter().map(|s| 2.0 + 19.0 * lines(s, 58)).sum::<f64>()
            }
        };
    }
    h.clamp(260.0, 860.0)
}

// ---------- Serving it ----------

fn respond(status: StatusCode, content_type: &str, body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CONTENT_SECURITY_POLICY, csp())
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::REFERRER_POLICY, "no-referrer")
        .header("Cross-Origin-Resource-Policy", "same-origin")
        .body(body)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

fn answer(state: &ConfirmState, approved: bool) {
    if let Some(p) = state.pending.lock().ok().and_then(|mut p| p.take()) {
        let _ = p.answer.send(approved);
    }
}

/// What a request to `path` does (pure, for the tests). `Some(true)` approves.
fn decide(pending: &mut Option<Pending>, path: &str, now: Instant) -> Option<bool> {
    if path == CANCEL_PATH {
        return Some(false);
    }
    let nonce = path.strip_prefix(APPROVE_PATH)?;
    let p = pending.as_ref()?;
    let armed = p
        .served
        .is_some_and(|t| now.duration_since(t) >= Duration::from_millis(ARM_MS));
    (armed && !p.nonce.is_empty() && nonce == p.nonce).then_some(true)
}

/// The `kyroconfirm` scheme handler. Serves only the `confirm` window: any other webview gets 403.
pub fn protocol<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    req: Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    if ctx.webview_label() != LABEL || req.method() != tauri::http::Method::GET {
        return respond(StatusCode::FORBIDDEN, "text/plain", Vec::new());
    }
    let app = ctx.app_handle();
    let Some(state) = app.try_state::<ConfirmState>() else {
        return respond(StatusCode::NOT_FOUND, "text/plain", Vec::new());
    };
    let path = req.uri().path();
    match path {
        "/" | "" => {
            let page = state.pending.lock().ok().and_then(|mut p| {
                let p = p.as_mut()?;
                p.served.get_or_insert_with(Instant::now);
                Some(p.page.clone())
            });
            match page {
                Some(page) => respond(
                    StatusCode::OK,
                    "text/html; charset=utf-8",
                    page.into_bytes(),
                ),
                None => respond(StatusCode::NOT_FOUND, "text/plain", Vec::new()),
            }
        }
        SANS_PATH | MONO_PATH | DISPLAY_PATH => {
            let i = [SANS_PATH, MONO_PATH, DISPLAY_PATH]
                .iter()
                .position(|p| *p == path)
                .unwrap_or(0);
            let key = FONTS.get().and_then(|f| f[i].clone());
            match key.and_then(|k| app.asset_resolver().get(k)) {
                Some(a) => respond(StatusCode::OK, "font/woff2", a.bytes),
                None => respond(StatusCode::NOT_FOUND, "text/plain", Vec::new()),
            }
        }
        _ => {
            let decision = state
                .pending
                .lock()
                .ok()
                .and_then(|mut p| decide(&mut p, path, Instant::now()));
            match decision {
                Some(approved) => {
                    answer(&state, approved);
                    respond(StatusCode::NO_CONTENT, "text/plain", Vec::new())
                }
                // Early click, stale or wrong nonce: ignored, the window stays.
                None if path.starts_with(APPROVE_PATH) => {
                    respond(StatusCode::NO_CONTENT, "text/plain", Vec::new())
                }
                None => respond(StatusCode::NOT_FOUND, "text/plain", Vec::new()),
            }
        }
    }
}

/// Undoes everything `ask` set up, however it ends (answer, close, error, cancelled future).
struct Cleanup {
    app: AppHandle,
}

impl Drop for Cleanup {
    fn drop(&mut self) {
        if let Some(state) = self.app.try_state::<ConfirmState>() {
            if let Ok(mut p) = state.pending.lock() {
                *p = None;
            }
        }
        if let Some(w) = self.app.get_webview_window(LABEL) {
            let _ = w.destroy();
        }
        if let Some(main) = self.app.get_webview_window("main") {
            let _ = main.set_enabled(true);
            let _ = main.set_focus();
        }
    }
}

fn new_nonce() -> Option<String> {
    let mut b = [0u8; 16];
    getrandom::getrandom(&mut b).ok()?;
    Some(b.iter().map(|x| format!("{x:02x}")).collect())
}

/// Shows the confirmation window. `Ok(Some(true))`: approved; `Ok(Some(false))`: refused (Cancel,
/// close, Escape, window lost); `Ok(None)`: the window could not be created (the caller falls
/// back to the OS message box); `Err`: another confirmation is already on screen.
pub async fn ask(app: &AppHandle, lang: Lang, view: ConfirmView<'_>) -> AppResult<Option<bool>> {
    let Some(state) = app.try_state::<ConfirmState>() else {
        return Ok(None);
    };
    let Some(nonce) = new_nonce() else {
        return Ok(None);
    };
    if app.get_webview_window(LABEL).is_some()
        || state.pending.lock().map(|p| p.is_some()).unwrap_or(true)
    {
        return Err(AppError::InvalidInput(
            "another confirmation is already open".into(),
        ));
    }
    let (tx, rx) = oneshot::channel();
    match state.pending.lock() {
        Ok(mut p) => {
            *p = Some(Pending {
                page: render(lang, &view, &nonce),
                nonce,
                served: None,
                answer: tx,
            })
        }
        Err(_) => return Ok(None),
    }
    let cleanup = Cleanup { app: app.clone() };
    let height = estimate_height(view.body);
    let main = app.get_webview_window("main");
    let mut builder =
        tauri::WebviewWindowBuilder::new(app, LABEL, WebviewUrl::CustomProtocol(page_url()))
            .title(format!("Kyro · {}", view.title))
            .inner_size(WIDTH, height)
            .resizable(false)
            .minimizable(false)
            .maximizable(false)
            .decorations(false)
            .shadow(true)
            .always_on_top(true)
            .skip_taskbar(true)
            .focused(true)
            .theme(Some(tauri::Theme::Dark))
            .background_color(tauri::window::Color(11, 14, 19, 255))
            .incognito(true)
            .devtools(false)
            .on_new_window(|_url, _features| NewWindowResponse::Deny);
    let over_main = main.as_ref().and_then(|m| {
        if !m.is_visible().ok()? || m.is_minimized().ok()? {
            return None;
        }
        let (p, s, f) = (
            m.outer_position().ok()?,
            m.outer_size().ok()?,
            m.scale_factor().ok()?,
        );
        let x = p.x as f64 / f + (s.width as f64 / f - WIDTH) / 2.0;
        let y = p.y as f64 / f + ((s.height as f64 / f - height) / 2.0).max(0.0);
        Some((x, y))
    });
    builder = match over_main {
        Some((x, y)) => builder.position(x, y),
        None => builder.center(),
    };
    if let Some(m) = &main {
        builder = match builder.parent(m) {
            Ok(b) => b,
            Err(_) => return Ok(None),
        };
    }
    let window = match builder.build() {
        Ok(w) => w,
        Err(_) => {
            // Nothing was shown: the OS message box takes over.
            drop(cleanup);
            return Ok(None);
        }
    };
    let handle = app.clone();
    window.on_window_event(move |e| {
        if matches!(
            e,
            WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed
        ) {
            answer(&handle.state::<ConfirmState>(), false);
        }
    });
    if let Some(m) = &main {
        let _ = m.set_enabled(false);
    }
    let _ = window.set_focus();
    let approved = rx.await.unwrap_or(false);
    drop(cleanup);
    Ok(Some(approved))
}

#[cfg(test)]
mod tests {
    use super::*;

    const FR_BTC: &str = "Compte signataire : « Bitcoin 1 » — m/84'/0'/0'\n\nEnvoi Bitcoin\n\n\
        À : bc1q9h7mx2c8r5tq6vfe3jd0wl0e8sxuk3d7a4k2\nMontant : 0,0250 BTC\n\
        Monnaie (revient chez toi) : 0,34629436 BTC\n  bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh\n\n\
        Frais : 0,00000564 BTC (564 sats)";

    fn page(lang: Lang, title: &str, body: &str) -> String {
        render(
            lang,
            &ConfirmView {
                title,
                body,
                ok: lang.sign(),
                cancel: lang.cancel(),
            },
            "00ff",
        )
    }

    const EN_ETH: &str = "Signing account: « Ethereum 1 » — m/44'/60'/0'/0/0

        From: 0x4f0dc8132131534caAc4a7a76EA3954F9b3b7f1D
Network: Ethereum

        Sending 0.014580233794 ETH
To: 0xc3CF480C3542ed41B8F4CC8A02aFf8677FFA712a

        Maximum fee: 0.000004242403578 ETH";

    #[test]
    fn native_send_line_becomes_the_headline() {
        let b = parse(&crate::dialog_text::body(EN_ETH));
        assert_eq!(headline(&b), None);
        assert!(
            matches!(sending_head(&b), Some((_, "Sending", ref n, ref u)) if n == "0.014580233794" && u == "ETH")
        );
        let p = page(Lang::En, "Confirm the transaction", EN_ETH);
        assert!(p.contains("<p class=\"intro\">Sending</p><div class=\"big\">0.014580233794<small>ETH</small></div>"), "{p}");
        assert!(
            !p.contains("Sending 0.014580233794 ETH"),
            "the line is not shown twice"
        );
        let fr = parse("Envoi de 1,5 POL\nÀ : 0xc3CF480C3542ed41B8F4CC8A02aFf8677FFA712a");
        assert!(matches!(sending_head(&fr), Some((0, "Envoi", ref n, _)) if n == "1,5"));
        assert_eq!(sending_head(&parse("Sending 1.5 ETH to Bob")), None);
        assert_eq!(sending_head(&parse("Sending 1 ETH\n\nSending 2 ETH")), None);
    }

    #[test]
    fn fr_btc_body_reads_as_rows_headline_and_address() {
        let b = parse(&crate::dialog_text::body(FR_BTC));
        assert!(matches!(&b[0], Block::Signer(s) if s.starts_with("Compte signataire")));
        assert!(b.contains(&Block::Para("Envoi Bitcoin".into())));
        assert!(b.contains(&Block::Addr {
            label: "À".into(),
            addr: "bc1q9h7mx2c8r5tq6vfe3jd0wl0e8sxuk3d7a4k2".into()
        }));
        assert!(b.contains(&Block::Row {
            key: "Monnaie (revient chez toi)".into(),
            value: "0,34629436 BTC".into(),
            subs: vec!["bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh".into()],
        }));
        assert!(b.contains(&Block::Row {
            key: "Frais".into(),
            value: "0,00000564 BTC (564 sats)".into(),
            subs: vec![],
        }));
        assert_eq!(headline(&b), Some(("0,0250".into(), "BTC".into())));
        let p = page(Lang::Fr, "Confirmer la transaction", FR_BTC);
        assert!(p.contains("<div class=\"big btc\">0,0250<small>BTC</small></div>"));
        assert!(p.contains("<p class=\"intro\">Envoi Bitcoin</p>"));
        assert!(p.contains("Ce que Kyro a lu dans la transaction"));
        assert!(p.contains(
            "<span class=\"hi\">bc1q</span><span class=\"hi\">9h7m</span><span>x2c8</span>"
        ));
        assert!(p.contains("<span class=\"hi\">k3d7</span><span class=\"hi\">a4k2</span></div>"));
        assert!(p.contains("Kyro · Confirmer la transaction"));
        assert!(p.contains(">Annuler</a>") && p.contains("href=\"/approve/00ff\">Signer</a>"));
        // Every word of the body is on the page.
        for w in [
            "0,34629436",
            "564",
            "m/84&#39;/0&#39;/0&#39;",
            "« Bitcoin 1 »",
        ] {
            assert!(p.contains(w), "{w}");
        }
        assert!(!p.contains("autofocus") && !p.contains("password"));
    }

    #[test]
    fn en_body_and_several_outputs() {
        let body = "Signing account: « Main » — m/84'/0'/0'\n\nBitcoin send\n\n\
            To: bc1q9h7mx2c8r5tq6vfe3jd0wl0e8sxuk3d7a4k2\nAmount: 0.025 BTC\n\
            To: bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh\nAmount: 1 BTC\n\nFee: 0.0001 BTC (10000 sats)";
        let b = parse(body);
        assert!(matches!(&b[0], Block::Signer(_)));
        assert_eq!(headline(&b), None, "two amounts: no headline");
        let p = page(Lang::En, "Confirm the transaction", body);
        assert!(!p.contains("class=\"big"));
        assert!(p.contains("What Kyro read in the transaction"));
        assert!(p.contains("<span class=\"k\">Fee</span>"));
        let one = "Amount: 12.5 ETH\nTo: 0x52908400098527886E0F7030069857D2E4169EE7";
        let b = parse(one);
        assert_eq!(headline(&b), Some(("12.5".into(), "ETH".into())));
        let p = page(Lang::En, "t", one);
        assert!(p.contains("<div class=\"big\">12.5<small>ETH</small>"));
    }

    #[test]
    fn body_without_amount_still_renders() {
        let body = "Afficher ta phrase de récupération ?\n\nPersonne de légitime ne te la demandera.\n• point un";
        let p = page(Lang::Fr, "Phrase", body);
        assert!(!p.contains("class=\"big"));
        assert!(p.contains("Kyro te demande de confirmer"));
        assert!(p.contains("<p class=\"para\">Afficher ta phrase de récupération ?</p>"));
        assert!(p.contains("<p class=\"bullet\">point un</p>"));
        assert!(page(Lang::En, "x", "").contains("Kyro asks you to confirm"));
    }

    #[test]
    fn untrusted_amount_lines_do_not_make_a_headline() {
        let b = parse("Mémo : « Montant : 1000 BTC »\nMontant : « 5 BTC »");
        assert_eq!(headline(&b), None);
        assert!(matches!(&b[0], Block::Row { key, .. } if key == "Mémo"));
        let b = parse("« Montant » : 1000 BTC");
        assert!(matches!(&b[0], Block::Para(_)));
    }

    #[test]
    fn injection_is_escaped_everywhere() {
        let evil = "<script>alert(1)</script><img src=x onerror=alert(1)>\"'&";
        let p = render(
            Lang::En,
            &ConfirmView {
                title: evil,
                body: &format!("{evil}\nTo: {evil}\nAmount: 1 <b>X</b>\n  {evil}\n• {evil}"),
                ok: evil,
                cancel: evil,
            },
            "\"><script>",
        );
        assert_eq!(
            p.matches("<script>").count(),
            1,
            "only the page's own script"
        );
        assert!(!p.contains("<img") && !p.contains("<b>") && !p.contains("onerror=alert(1)>"));
        assert!(p.contains("&lt;script&gt;alert(1)&lt;/script&gt;"));
        assert!(p.contains("&quot;&#39;&amp;"));
        assert!(!p.contains(" style=") && !p.contains(" onerror=alert(1)>"));
    }

    #[test]
    fn bidi_and_controls_stay_removed() {
        let body = "Compte signataire : « A\u{202E}B »\nÀ : bc1q\u{200B}9h7mx2c8r5tq6vfe3jd0wl0e8sxu\u{2066}k3d7a4k2\nfin\r\x1b[31m";
        let p = render(
            Lang::Fr,
            &ConfirmView {
                title: "T\u{202E}x\u{7}",
                body,
                ok: "S\u{200F}",
                cancel: "C",
            },
            "n",
        );
        for c in [
            '\u{202E}', '\u{200B}', '\u{2066}', '\u{200F}', '\r', '\x1b', '\u{7}',
        ] {
            assert!(!p.contains(c), "{c:?}");
        }
        assert!(p.contains("« AB »") && p.contains("Kyro · Tx"));
        assert!(p.contains("<span class=\"hi\">bc1q</span><span class=\"hi\">9h7m</span>"));
    }

    #[test]
    fn csp_is_strict() {
        let c = csp();
        assert!(c.starts_with("default-src 'none'; script-src 'sha256-"));
        assert!(c.contains(&format!("script-src 'sha256-{}'", sha(SCRIPT))));
        assert!(c.contains(&format!("style-src 'sha256-{}'", sha(STYLE))));
        for d in [
            "connect-src 'none'",
            "form-action 'none'",
            "frame-ancestors 'none'",
            "img-src 'none'",
            "base-uri 'none'",
        ] {
            assert!(c.contains(d), "{d}");
        }
        assert!(!c.contains("unsafe") && !c.contains("http") && !c.contains('*'));
        // The page's own script and style are exactly the hashed ones.
        let p = page(Lang::En, "t", "x");
        assert!(
            p.contains(&format!("<script>{SCRIPT}</script>"))
                && p.contains(&format!("<style>{STYLE}</style>"))
        );
    }

    #[test]
    fn only_the_confirm_origin() {
        assert!(is_confirm_url(&page_url()));
        let mut a = page_url();
        a.set_path("/approve/ab");
        assert!(is_confirm_url(&a));
        for bad in [
            "tauri://localhost/",
            "http://tauri.localhost/",
            "http://kyrophrase.localhost/",
            "kyrophrase://localhost/",
            "https://evil.example/",
            "http://kyroconfirm.localhost:8080/",
            "kyroconfirm://evil/",
            "http://kyroconfirm.localhost.evil.example/",
            "about:blank",
            "data:text/html,x",
        ] {
            assert!(!is_confirm_url(&Url::parse(bad).unwrap()), "{bad}");
        }
        assert!(!crate::phrase_window::is_phrase_url(&page_url()));
        assert!(!crate::nav_guard::is_app_url(&page_url(), None));
    }

    #[test]
    fn approve_needs_the_nonce_and_the_delay() {
        let (tx, _rx) = oneshot::channel();
        let t0 = Instant::now();
        let mut p = Some(Pending {
            page: String::new(),
            nonce: "abc".into(),
            served: None,
            answer: tx,
        });
        let late = t0 + Duration::from_millis(ARM_MS + 1);
        assert_eq!(
            decide(&mut p, "/approve/abc", late),
            None,
            "page not served yet"
        );
        p.as_mut().unwrap().served = Some(t0);
        assert_eq!(
            decide(&mut p, "/approve/abc", t0 + Duration::from_millis(100)),
            None
        );
        assert_eq!(decide(&mut p, "/approve/abd", late), None);
        assert_eq!(decide(&mut p, "/approve/", late), None);
        assert_eq!(decide(&mut p, "/approve/abc", late), Some(true));
        assert_eq!(decide(&mut p, "/cancel", t0), Some(false));
        assert_eq!(decide(&mut None, "/approve/abc", late), None);
        assert_eq!(decide(&mut p, "/other", late), None);
    }

    #[test]
    fn height_grows_with_the_body() {
        let small = estimate_height("x");
        let big = estimate_height(FR_BTC);
        assert!(small >= 260.0 && big > small && big <= 860.0);
    }

    #[test]
    fn fonts_found_by_name() {
        remember_fonts(
            [
                "/assets/unbounded-latin-ext-wght-normal-A.woff2",
                "/assets/unbounded-latin-wght-normal-B.woff2",
                "/assets/geist-latin-wght-normal-C.woff2",
                "/assets/geist-mono-latin-wght-normal-D.woff2",
            ]
            .into_iter(),
        );
        let f = FONTS.get().unwrap();
        assert_eq!(
            f[0].as_deref(),
            Some("/assets/geist-latin-wght-normal-C.woff2")
        );
        assert_eq!(
            f[1].as_deref(),
            Some("/assets/geist-mono-latin-wght-normal-D.woff2")
        );
        assert_eq!(
            f[2].as_deref(),
            Some("/assets/unbounded-latin-wght-normal-B.woff2")
        );
    }

    /// Writes a sample page for a visual check: `KYRO_CONFIRM_PREVIEW=<file.html> cargo test
    /// -p <crate> confirm_preview -- --ignored`. `KYRO_CONFIRM_FONTS=<dir/>` rewrites the font
    /// URLs for a page opened from disk (proof only).
    #[test]
    #[ignore]
    fn confirm_preview() {
        let path = std::env::var("KYRO_CONFIRM_PREVIEW").expect("KYRO_CONFIRM_PREVIEW");
        let mut p = page(Lang::Fr, "Confirmer la transaction", FR_BTC);
        if let Ok(dir) = std::env::var("KYRO_CONFIRM_FONTS") {
            p = p
                .replace("url(/font/sans.woff2)", &format!("url({dir}sans.woff2)"))
                .replace("url(/font/mono.woff2)", &format!("url({dir}mono.woff2)"))
                .replace(
                    "url(/font/display.woff2)",
                    &format!("url({dir}display.woff2)"),
                );
        }
        std::fs::write(path, p).unwrap();
    }
}
