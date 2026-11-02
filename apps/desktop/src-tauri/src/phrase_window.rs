//! The recovery phrase window (SECURITY.md « Phrase display », docs/IPC.md §2.1).
//!
//! The words never reach the main webview. Rust opens a separate window (label `phrase`) whose
//! page it writes itself and serves from a dedicated scheme (`kyrophrase`), i.e. its own origin:
//! the main interface cannot read its storage, register a service worker for it or script it.
//! The page has no script at all (CSP `script-src 'none'`; Hide/Show and the close button are
//! plain CSS and a link), the `phrase` label has no capability (no IPC command), the window uses
//! a private profile, cannot navigate elsewhere or open windows, and is excluded from
//! screenshots and screen sharing (content protection, Windows and macOS). The page is served
//! only to that window and wiped when it closes.

use std::borrow::Cow;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

use base64::Engine as _;
use sha2::{Digest, Sha256};
use tauri::http::{header, Request, Response, StatusCode};
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, Runtime, UriSchemeContext, Url, WebviewUrl, WindowEvent};
use tokio::sync::oneshot;
use zeroize::Zeroizing;

use crate::error::{AppError, AppResult};
use crate::i18n::Lang;

/// Window label. No capability names it: the page cannot call any command.
pub const LABEL: &str = "phrase";
/// Scheme of the page: an origin of its own, separate from the main interface's.
pub const SCHEME: &str = "kyrophrase";
const DONE_PATH: &str = "/done";
const SANS_PATH: &str = "/font/sans.woff2";
const MONO_PATH: &str = "/font/mono.woff2";

/// What the window shows.
pub struct PhraseView<'a> {
    pub title: &'a str,
    pub lead: &'a str,
    pub words: &'a [String],
    /// Extra lines under the words (Monero: key path, restore height).
    pub notes: Vec<String>,
}

/// The page being shown, the « closed » signal and the main window's capture setting.
#[derive(Default)]
pub struct PhraseState {
    page: Mutex<Option<Zeroizing<String>>>,
    done: Mutex<Option<oneshot::Sender<()>>>,
    /// Last capture protection asked by the interface for the main window (restored on close).
    capture: AtomicBool,
}

impl PhraseState {
    /// Records the interface's capture setting; while the phrase is shown, the main window
    /// stays protected whatever it asks.
    pub fn main_capture(&self, enabled: bool) -> bool {
        self.capture.store(enabled, Ordering::SeqCst);
        enabled || self.page.lock().map(|p| p.is_some()).unwrap_or(true)
    }
}

/// Asset keys of the app's fonts (Geist, Geist Mono), found once at startup.
static FONTS: OnceLock<(Option<String>, Option<String>)> = OnceLock::new();

/// Remembers which bundled assets are the Latin Geist fonts (hashed file names).
pub fn remember_fonts<'a>(keys: impl Iterator<Item = &'a str>) {
    let mut sans = None;
    let mut mono = None;
    for k in keys {
        let name = k.rsplit('/').next().unwrap_or_default();
        if !name.ends_with(".woff2") {
            continue;
        }
        if name.starts_with("geist-latin-wght-normal") {
            sans = Some(format!("/{}", k.trim_start_matches('/')));
        } else if name.starts_with("geist-mono-latin-wght-normal") {
            mono = Some(format!("/{}", k.trim_start_matches('/')));
        }
    }
    let _ = FONTS.set((sans, mono));
}

/// URL of the page (Windows: `http://kyrophrase.localhost/`, elsewhere `kyrophrase://localhost/`).
fn page_url() -> Url {
    let s = if cfg!(any(windows, target_os = "android")) {
        format!("http://{SCHEME}.localhost/")
    } else {
        format!("{SCHEME}://localhost/")
    };
    Url::parse(&s).expect("static URL")
}

/// True for the phrase page's own URLs (the only ones its window may load).
pub fn is_phrase_url(url: &Url) -> bool {
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
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    out
}

const STYLE: &str = r#"
@font-face{font-family:'Geist';src:url(/font/sans.woff2) format('woff2');font-weight:100 900;font-display:block}
@font-face{font-family:'Geist Mono';src:url(/font/mono.woff2) format('woff2');font-weight:100 900;font-display:block}
:root{color-scheme:dark;--bg:#090a0c;--card:#0d0f12;--raised:#13161a;--control:#191c21;--control2:#20242a;--line:#1e2228;--line2:#292e35;--text:#eef1f4;--text2:#c3c9d1;--mute:#878e99;--faint:#5b616b;--primary:#e4ecf3;--on-primary:#08090b;--ice:#7cc4ff;--ice-line:#355b80;--ice-deep:#16263a;--warn:#f5b74f}
*{box-sizing:border-box;-webkit-user-select:none;user-select:none;-webkit-user-drag:none}
::selection{background:transparent}
html,body{margin:0;min-height:100%;background:var(--bg);color:var(--text);font:14px/1.5 'Geist','Segoe UI',system-ui,sans-serif;-webkit-font-smoothing:antialiased}
body{display:flex;justify-content:center}
main{width:100%;max-width:760px;padding:28px 32px 26px;display:flex;flex-direction:column;gap:18px}
header{display:flex;gap:14px;align-items:flex-start}
.badge{flex:none;width:38px;height:38px;border-radius:10px;background:var(--ice-deep);border:1px solid var(--ice-line);display:grid;place-items:center;color:var(--ice)}
.badge svg{width:20px;height:20px}
h1{margin:0;font-size:19px;font-weight:600;letter-spacing:-.01em}
.lead{margin:4px 0 0;color:var(--text2)}
.lead strong{color:var(--warn);font-weight:500}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 14px 16px}
.bar{display:flex;align-items:center;justify-content:space-between;margin:0 2px 12px}
.count{color:var(--mute);font-size:12px;letter-spacing:.06em;text-transform:uppercase}
.sr{position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0;padding:0}
.toggle{display:inline-flex;align-items:center;gap:7px;height:30px;padding:0 12px;border-radius:6px;background:var(--control);border:1px solid var(--line2);color:var(--text);font-size:13px;font-weight:500;cursor:pointer}
.toggle:hover{background:var(--control2)}
.toggle svg{width:15px;height:15px;color:var(--text2)}
.toggle .h,#reveal:checked~main .toggle .s{display:none}
#reveal:checked~main .toggle .h{display:inline-flex;align-items:center;gap:7px}
.toggle .s{display:inline-flex;align-items:center;gap:7px}
#reveal:focus-visible~main .toggle{outline:1.5px solid var(--ice);outline-offset:2px}
ol{list-style:none;margin:0;padding:0;display:grid;gap:8px;cursor:pointer}
ol.c3{grid-template-columns:repeat(3,minmax(0,1fr))}
ol.c4{grid-template-columns:repeat(4,minmax(0,1fr))}
ol.c5{grid-template-columns:repeat(5,minmax(0,1fr))}
li{display:flex;align-items:baseline;gap:10px;height:40px;padding:0 12px;border-radius:7px;background:var(--raised);border:1px solid var(--line);align-items:center;min-width:0}
.n{flex:none;width:20px;text-align:right;color:var(--faint);font:500 12px/1 'Geist Mono',ui-monospace,Consolas,monospace;font-variant-numeric:tabular-nums}
.w{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:500 15px/1 'Geist Mono',ui-monospace,Consolas,monospace;color:var(--text);filter:blur(7px);opacity:.85;transition:filter .18s ease,opacity .18s ease}
#reveal:checked~main .w,ol:active .w{filter:none;opacity:1}
.hint{margin:12px 2px 0;color:var(--mute);font-size:12.5px}
#reveal:checked~main .hint{visibility:hidden}
.notes{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px;color:var(--mute);font-size:12.5px}
.notes li{display:block;height:auto;padding:0 0 0 14px;background:none;border:0;border-radius:0;position:relative}
.notes li::before{content:'';position:absolute;left:2px;top:.62em;width:4px;height:4px;border-radius:2px;background:var(--faint)}
footer{display:flex;justify-content:flex-end;padding-top:2px}
.btn{display:inline-flex;align-items:center;height:38px;padding:0 18px;border-radius:6px;background:var(--primary);color:var(--on-primary);font-weight:600;font-size:14px;text-decoration:none}
.btn:hover{background:#fff}
.btn:focus-visible{outline:1.5px solid var(--ice);outline-offset:2px}
"#;

const SHIELD: &str = r#"<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z"/><path d="M9 12l2 2 4-4"/></svg>"#;
const EYE: &str = r#"<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>"#;
const EYE_OFF: &str = r#"<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 5.1A10.4 10.4 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6A17.3 17.3 0 0 0 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>"#;

/// Columns of the word grid.
pub fn columns(n: usize) -> usize {
    if n > 12 {
        4
    } else {
        3
    }
}

/// The page's Content-Security-Policy: no script, nothing external, only its own style and fonts.
fn csp() -> String {
    let hash = base64::engine::general_purpose::STANDARD.encode(Sha256::digest(STYLE.as_bytes()));
    format!(
        "default-src 'none'; script-src 'none'; style-src 'sha256-{hash}'; font-src 'self'; \
         img-src 'none'; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; \
         worker-src 'none'; manifest-src 'none'; base-uri 'none'; form-action 'none'; \
         frame-ancestors 'none'"
    )
}

/// The whole page, words included (wiped from memory when dropped).
pub fn render(lang: Lang, view: &PhraseView<'_>) -> Zeroizing<String> {
    let n = view.words.len();
    let mut out = Zeroizing::new(String::with_capacity(8192 + n * 96));
    out.push_str(&format!(
        "<!doctype html><html lang=\"{}\"><head><meta charset=\"utf-8\">\
         <meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\
         <meta name=\"referrer\" content=\"no-referrer\"><title>{}</title><style>{STYLE}</style>\
         </head><body><input type=\"checkbox\" id=\"reveal\" class=\"sr\" aria-label=\"{}\"><main>\
         <header><div class=\"badge\">{SHIELD}</div><div><h1>{}</h1><p class=\"lead\">{}</p></div>\
         </header><section class=\"card\"><div class=\"bar\"><span class=\"count\">{}</span>\
         <label for=\"reveal\" class=\"toggle\"><span class=\"s\">{EYE}{}</span>\
         <span class=\"h\">{EYE_OFF}{}</span></label></div><ol class=\"c{}\">",
        lang.pick("fr", "en"),
        escape(view.title),
        escape(lang.pick("Afficher les mots", "Show the words")),
        escape(view.title),
        escape(view.lead),
        escape(&match lang {
            Lang::Fr => format!("{n} mots"),
            Lang::En => format!("{n} words"),
        }),
        escape(lang.pick("Afficher", "Show")),
        escape(lang.pick("Masquer", "Hide")),
        columns(n),
    ));
    for (i, w) in view.words.iter().enumerate() {
        out.push_str("<li><span class=\"n\">");
        out.push_str(&(i + 1).to_string());
        out.push_str("</span><span class=\"w\">");
        out.push_str(&Zeroizing::new(escape(w)));
        out.push_str("</span></li>");
    }
    out.push_str("</ol><p class=\"hint\">");
    out.push_str(&escape(lang.pick(
        "Clique sur « Afficher », ou maintiens le clic sur les mots, pour les lire.",
        "Click “Show”, or press and hold the words, to read them.",
    )));
    out.push_str("</p></section><ul class=\"notes\">");
    let fixed = [
        lang.pick(
            "Pas de photo, pas de copie, pas de cloud. Personne de légitime ne te demandera jamais ces mots.",
            "No photo, no copy, no cloud. No one legitimate will ever ask you for these words.",
        ),
        lang.pick(
            "Cette fenêtre est masquée des captures et des partages d’écran (Windows, macOS), pas \
             d’une caméra : vérifie que personne ne regarde.",
            "This window is hidden from screenshots and screen sharing (Windows, macOS), not from \
             a camera: make sure nobody is watching.",
        ),
    ];
    for note in view.notes.iter().map(String::as_str).chain(fixed) {
        out.push_str("<li>");
        out.push_str(&escape(note));
        out.push_str("</li>");
    }
    out.push_str(&format!(
        "</ul><footer><a class=\"btn\" href=\"{DONE_PATH}\">{}</a></footer></main></body></html>",
        escape(lang.pick("J’ai noté ma phrase", "I’ve written it down"))
    ));
    out
}

fn respond(status: StatusCode, content_type: &str, body: Vec<u8>) -> Response<Cow<'static, [u8]>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CONTENT_SECURITY_POLICY, csp())
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::REFERRER_POLICY, "no-referrer")
        .header("Cross-Origin-Resource-Policy", "same-origin")
        .body(Cow::Owned(body))
        .unwrap_or_else(|_| Response::new(Cow::Borrowed(&[])))
}

/// The `kyrophrase` scheme handler. Serves only the `phrase` window: any other webview gets 403.
pub fn protocol<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    req: Request<Vec<u8>>,
) -> Response<Cow<'static, [u8]>> {
    if ctx.webview_label() != LABEL || req.method() != tauri::http::Method::GET {
        return respond(StatusCode::FORBIDDEN, "text/plain", Vec::new());
    }
    let app = ctx.app_handle();
    let Some(state) = app.try_state::<PhraseState>() else {
        return respond(StatusCode::NOT_FOUND, "text/plain", Vec::new());
    };
    match req.uri().path() {
        "/" | "" => match state.page.lock().ok().and_then(|p| p.clone()) {
            Some(page) => respond(
                StatusCode::OK,
                "text/html; charset=utf-8",
                page.as_bytes().to_vec(),
            ),
            None => respond(StatusCode::NOT_FOUND, "text/plain", Vec::new()),
        },
        DONE_PATH => {
            signal(&state);
            respond(StatusCode::NO_CONTENT, "text/plain", Vec::new())
        }
        p @ (SANS_PATH | MONO_PATH) => {
            let key = FONTS
                .get()
                .and_then(|(s, m)| if p == SANS_PATH { s.clone() } else { m.clone() });
            match key.and_then(|k| app.asset_resolver().get(k)) {
                Some(a) => respond(StatusCode::OK, "font/woff2", a.bytes),
                None => respond(StatusCode::NOT_FOUND, "text/plain", Vec::new()),
            }
        }
        _ => respond(StatusCode::NOT_FOUND, "text/plain", Vec::new()),
    }
}

fn signal(state: &PhraseState) {
    if let Some(tx) = state.done.lock().ok().and_then(|mut d| d.take()) {
        let _ = tx.send(());
    }
}

/// Undoes everything `show` set up, however it ends (closed, error, cancelled future).
struct Cleanup {
    app: AppHandle,
}

impl Drop for Cleanup {
    fn drop(&mut self) {
        let state = self.app.state::<PhraseState>();
        if let Ok(mut p) = state.page.lock() {
            *p = None;
        }
        if let Ok(mut d) = state.done.lock() {
            *d = None;
        }
        if let Some(w) = self.app.get_webview_window(LABEL) {
            let _ = w.destroy();
        }
        if let Some(main) = self.app.get_webview_window("main") {
            let _ = main.set_enabled(true);
            let _ = main.set_content_protected(state.capture.load(Ordering::SeqCst));
            let _ = main.set_focus();
        }
    }
}

/// Shows `view` in the phrase window and returns when the user closes it. Meanwhile the main
/// window is disabled (modal) and protected from capture.
pub async fn show(app: &AppHandle, view: PhraseView<'_>) -> AppResult<()> {
    let state = app.state::<PhraseState>();
    if app.get_webview_window(LABEL).is_some()
        || state.page.lock().map(|p| p.is_some()).unwrap_or(true)
    {
        return Err(AppError::InvalidInput(
            "the recovery phrase is already shown".into(),
        ));
    }
    let lang = crate::i18n::current();
    let (tx, rx) = oneshot::channel();
    if let (Ok(mut p), Ok(mut d)) = (state.page.lock(), state.done.lock()) {
        *p = Some(render(lang, &view));
        *d = Some(tx);
    }
    let _cleanup = Cleanup { app: app.clone() };
    let main = app.get_webview_window("main");
    if let Some(m) = &main {
        let _ = m.set_content_protected(true);
    }
    let cols = columns(view.words.len());
    let rows = view.words.len().div_ceil(cols);
    let width = if cols == 4 { 760.0 } else { 640.0 };
    let height = 372.0 + rows as f64 * 48.0 + view.notes.len() as f64 * 22.0;
    let mut builder =
        tauri::WebviewWindowBuilder::new(app, LABEL, WebviewUrl::CustomProtocol(page_url()))
            .title(lang.pick("Kyro — Phrase de récupération", "Kyro — Recovery phrase"))
            .inner_size(width, height)
            .min_inner_size(560.0, 360.0)
            .center()
            .focused(true)
            .minimizable(false)
            .maximizable(false)
            .content_protected(true)
            .theme(Some(tauri::Theme::Dark))
            .background_color(tauri::window::Color(9, 10, 12, 255))
            .incognito(true)
            .devtools(false)
            .on_new_window(|_url, _features| NewWindowResponse::Deny);
    if let Some(m) = &main {
        builder = builder.parent(m)?;
    }
    let window = builder.build()?;
    let handle = app.clone();
    window.on_window_event(move |e| {
        if matches!(e, WindowEvent::Destroyed) {
            signal(&handle.state::<PhraseState>());
        }
    });
    if let Some(m) = &main {
        let _ = m.set_enabled(false);
    }
    let _ = rx.await;
    Ok(())
}

/// The recovery phrase view (creation and Settings › Security).
pub fn recovery_view(lang: Lang, words: &[String]) -> PhraseView<'_> {
    PhraseView {
        title: lang.pick("Ta phrase de récupération", "Your recovery phrase"),
        lead: lang.pick(
            "Écris ces mots sur papier, dans l’ordre. Quiconque les possède peut prendre tes fonds.",
            "Write these words on paper, in order. Anyone with them can take your funds.",
        ),
        words,
        notes: vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(n: usize) -> Vec<String> {
        (1..=n).map(|i| format!("word{i}")).collect()
    }

    #[test]
    fn page_shows_every_word_in_order_and_no_script() {
        let w = words(24);
        let page = render(
            Lang::En,
            &PhraseView {
                title: "Your recovery phrase",
                lead: "Write these words on paper, in order. Anyone with them can take your funds.",
                words: &w,
                notes: vec![],
            },
        );
        let mut at = 0;
        for (i, w) in w.iter().enumerate() {
            let needle = format!(
                "<span class=\"n\">{}</span><span class=\"w\">{w}</span>",
                i + 1
            );
            let pos = page[at..].find(&needle).expect(&needle) + at;
            at = pos;
        }
        assert!(page.contains("<ol class=\"c4\">") && page.contains("24 words"));
        assert!(page.contains("Anyone with them can take your funds."));
        assert!(page.contains("I’ve written it down") && page.contains("href=\"/done\""));
        assert!(!page.contains("<script") && !page.contains("http"));
        let fr = render(
            Lang::Fr,
            &PhraseView {
                title: "Ta phrase de récupération",
                lead: "x",
                words: &words(12),
                notes: vec!["Hauteur de restauration : 7".into()],
            },
        );
        assert!(fr.contains("<ol class=\"c3\">") && fr.contains("12 mots"));
        assert!(fr.contains("Masquer") && fr.contains("J’ai noté ma phrase"));
        assert!(fr.contains("<li>Hauteur de restauration : 7</li>"));
    }

    #[test]
    fn text_is_escaped() {
        let w = vec!["<img src=x>".to_string(), "a&b\"'".to_string()];
        let page = render(
            Lang::En,
            &PhraseView {
                title: "<b>",
                lead: "l",
                words: &w,
                notes: vec!["</li><script>".into()],
            },
        );
        assert!(!page.contains("<img") && !page.contains("<script") && !page.contains("<b>"));
        assert!(page.contains("&lt;img src=x&gt;") && page.contains("a&amp;b&quot;&#39;"));
    }

    #[test]
    fn csp_allows_only_the_page_style_and_fonts() {
        let c = csp();
        assert!(c.starts_with("default-src 'none'; script-src 'none'; style-src 'sha256-"));
        assert!(c.contains("connect-src 'none'") && c.contains("form-action 'none'"));
        assert!(!c.contains("unsafe"));
    }

    #[test]
    fn only_the_phrase_origin() {
        assert!(is_phrase_url(&page_url()));
        let mut done = page_url();
        done.set_path(DONE_PATH);
        assert!(is_phrase_url(&done));
        for bad in [
            "tauri://localhost/",
            "http://tauri.localhost/",
            "https://evil.example/",
            "http://kyrophrase.localhost:8080/",
            "kyrophrase://evil/",
            "http://kyrophrase.localhost.evil.example/",
            "about:blank",
            "data:text/html,x",
        ] {
            assert!(!is_phrase_url(&Url::parse(bad).unwrap()), "{bad}");
        }
    }

    #[test]
    fn fonts_found_by_name() {
        remember_fonts(
            [
                "/assets/geist-latin-ext-wght-normal-DC.woff2",
                "/assets/geist-mono-latin-wght-normal-XN.woff2",
                "/assets/geist-latin-wght-normal-Bg.woff2",
                "/assets/index.js",
            ]
            .into_iter(),
        );
        let (s, m) = FONTS.get().unwrap();
        assert_eq!(
            s.as_deref(),
            Some("/assets/geist-latin-wght-normal-Bg.woff2")
        );
        assert_eq!(
            m.as_deref(),
            Some("/assets/geist-mono-latin-wght-normal-XN.woff2")
        );
    }

    /// Writes a sample page for a visual check: `KYRO_PHRASE_PREVIEW=<file.html> cargo test
    /// -p kyro-desktop phrase_preview -- --ignored`.
    #[test]
    #[ignore]
    fn phrase_preview() {
        let path = std::env::var("KYRO_PHRASE_PREVIEW").expect("KYRO_PHRASE_PREVIEW");
        let sample = "abandon ability able about above absent absorb abstract absurd abuse access \
                      accident account accuse achieve acid acoustic acquire across act action \
                      actor actress actual";
        let w: Vec<String> = sample.split_whitespace().map(String::from).collect();
        let lang = if std::env::var("KYRO_PHRASE_LANG").as_deref() == Ok("fr") {
            Lang::Fr
        } else {
            Lang::En
        };
        let page = render(lang, &recovery_view(lang, &w));
        std::fs::write(path, page.as_bytes()).unwrap();
    }
}
