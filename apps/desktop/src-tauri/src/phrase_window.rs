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
const DISPLAY_PATH: &str = "/font/display.woff2";

/// The BIP39 passphrase of the wallet, in the window.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Passphrase<'a> {
    /// None, or not this window's business (Monero).
    #[default]
    None,
    /// Blurred under the words, like them (Settings › Security).
    Shown(&'a str),
    /// A line says the wallet has one (creation: it was just typed twice).
    Reminder,
}

/// What the window shows.
pub struct PhraseView<'a> {
    pub title: &'a str,
    pub lead: &'a str,
    pub words: &'a [String],
    pub passphrase: Passphrase<'a>,
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

/// Asset keys of the app's fonts (Geist, Geist Mono, Unbounded), found once at startup.
static FONTS: OnceLock<[Option<String>; 3]> = OnceLock::new();

/// Remembers which bundled assets are the Latin Geist / Geist Mono / Unbounded fonts (hashed
/// file names).
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
@font-face{font-family:'Unbounded Variable';src:url(/font/display.woff2) format('woff2');font-weight:200 900;font-display:block}
:root{color-scheme:dark;--bg:#05070a;--text:#f1f4f7;--text2:#c6ccd4;--mute:#8d949f;--faint:#636a75;--ice:#7cc4ff;--warn:#f5b74f;--glass:rgba(255,255,255,.045);--glass-line:rgba(255,255,255,.07)}
*{box-sizing:border-box;-webkit-user-select:none;user-select:none;-webkit-user-drag:none}
::selection{background:transparent}
html,body{margin:0;min-height:100%;background:var(--bg);color:var(--text);font:14px/1.5 'Geist','Segoe UI',system-ui,sans-serif;-webkit-font-smoothing:antialiased}
body{position:relative;overflow-x:hidden}
.light{position:fixed;inset:0;pointer-events:none;background:radial-gradient(900px 520px at 50% 6%,rgba(124,196,255,.085),rgba(124,196,255,.022) 45%,transparent 75%)}
.light svg{position:absolute;inset:0;width:100%;height:100%;opacity:.1;mix-blend-mode:screen;-webkit-mask-image:radial-gradient(1000px 620px at 50% 6%,#000 0%,rgba(0,0,0,.55) 38%,transparent 72%);mask-image:radial-gradient(1000px 620px at 50% 6%,#000 0%,rgba(0,0,0,.55) 38%,transparent 72%)}
.light::after{content:'';position:absolute;inset:0;background:radial-gradient(1400px 900px at 50% 40%,transparent 55%,rgba(0,0,0,.55))}
.sr{position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0;padding:0}
main{position:relative;display:flex;flex-direction:column;align-items:center;padding:34px 20px 30px}
.label{display:flex;align-items:center;gap:8px;color:var(--faint);font-size:11px;font-weight:500;letter-spacing:.16em;text-transform:uppercase}
.label i{width:6px;height:6px;background:var(--ice);box-shadow:0 0 10px var(--ice);flex:none}
h1{margin:16px 0 0;font:500 28px/1.15 'Unbounded Variable','Unbounded','Geist',sans-serif;letter-spacing:-.04em;text-align:center}
.lead{margin:12px 0 0;max-width:640px;color:var(--mute);font-size:13.5px;text-align:center}
.wrap{position:relative;margin-top:30px;width:100%;max-width:760px}
.wrap.k3{max-width:590px}
ol{list-style:none;margin:0;padding:0;display:grid;gap:10px;cursor:pointer}
ol.c3{grid-template-columns:repeat(3,minmax(0,1fr))}
ol.c4{grid-template-columns:repeat(4,minmax(0,1fr))}
ol.c5{grid-template-columns:repeat(5,minmax(0,1fr))}
ol li{display:flex;align-items:center;gap:12px;height:44px;padding:0 14px;border-radius:12px;background:var(--glass);box-shadow:inset 0 0 0 1px var(--glass-line);min-width:0}
.n{flex:none;width:20px;text-align:right;color:var(--faint);font:500 11.5px/1 'Geist',system-ui,sans-serif;font-variant-numeric:tabular-nums}
.w{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:400 14px/1.2 'Geist Mono',ui-monospace,Consolas,monospace;color:var(--text);filter:blur(7px);opacity:.85;transition:filter .18s ease,opacity .18s ease}
#reveal:checked~main .w,ol:active .w{filter:none;opacity:1}
.sides{position:absolute;inset:0;pointer-events:none}
.side{position:absolute;display:flex;align-items:center;gap:8px;width:202px}
.side.r{left:100%;margin-left:12px;top:56px}
.side.l{right:100%;margin-right:12px;top:52%;flex-direction:row-reverse;text-align:right}
.sq{flex:none;width:6px;height:6px;background:#cfe7ff}
.ln{flex:none;width:20px;height:1px;background:rgba(255,255,255,.18)}
.tx{width:160px;color:var(--mute);font-size:12.5px;line-height:1.4}
.tx strong{display:block;margin-bottom:2px;color:var(--text);font-size:13px;font-weight:600}
@media (max-width:1227px){.wrap.k4 .sides{position:static;display:flex;gap:28px;justify-content:center;margin-top:22px}.wrap.k4 .side{position:static;margin:0;width:auto;max-width:300px;flex-direction:row;text-align:left}.wrap.k4 .tx{width:auto}}
@media (max-width:1057px){.wrap.k3 .sides{position:static;display:flex;gap:28px;justify-content:center;margin-top:22px}.wrap.k3 .side{position:static;margin:0;width:auto;max-width:280px;flex-direction:row;text-align:left}.wrap.k3 .tx{width:auto}}
.pp{margin:12px 0 0;display:flex;align-items:center;gap:14px;min-height:44px;padding:10px 16px;border-radius:12px;background:var(--glass);box-shadow:inset 0 0 0 1px var(--glass-line)}
.ppl{flex:none;color:var(--faint);font-size:11px;font-weight:500;letter-spacing:.12em;text-transform:uppercase}
.pp .w{white-space:normal;overflow-wrap:anywhere;line-height:1.35}
.hint{margin:14px 0 0;color:var(--faint);font-size:12.5px;text-align:center}
#reveal:checked~main .hint{visibility:hidden}
.notes{margin:16px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px;width:100%;max-width:760px;color:var(--text2);font-size:12.5px}
.notes li{padding:0 0 0 14px;position:relative}
.notes li::before{content:'';position:absolute;left:2px;top:.62em;width:4px;height:4px;background:var(--warn)}
footer{display:flex;gap:12px;justify-content:center;margin-top:30px}
.toggle,.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:48px;border-radius:14px;font-weight:600;cursor:pointer;text-decoration:none}
.toggle{width:150px;background:var(--glass);box-shadow:inset 0 0 0 1px var(--glass-line);color:var(--text);font-size:13.5px}
.toggle:hover{background:rgba(255,255,255,.08)}
.toggle svg{width:16px;height:16px;color:var(--text2)}
.toggle .h,#reveal:checked~main .toggle .s{display:none}
#reveal:checked~main .toggle .h{display:inline-flex;align-items:center;gap:8px}
.toggle .s{display:inline-flex;align-items:center;gap:8px}
#reveal:focus-visible~main .toggle{outline:1.5px solid var(--ice);outline-offset:2px}
.btn{width:260px;background:linear-gradient(180deg,#e6f3ff,#c2e0fa);color:#061423;font-size:14.5px;box-shadow:inset 0 1px 0 rgba(255,255,255,.95),inset 0 -1px 0 rgba(53,119,180,.35),inset 0 0 0 1px rgba(255,255,255,.35),0 10px 30px -12px rgba(124,196,255,.85)}
.btn:hover{background:linear-gradient(180deg,#fff,#e6f3ff)}
.btn:focus-visible{outline:1.5px solid var(--ice);outline-offset:2px}
"#;

/// The ice light at the top of the page (the interface's `IceLight`, inline: no image request).
const LIGHT: &str = r#"<div class="light" aria-hidden="true"><svg><filter id="ice" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.009 0.014" numOctaves="2" seed="4"/><feComponentTransfer><feFuncR type="table" tableValues="0 0 0 0 0 0 .15 1 .15 0 0 0 0 0 0 0 0 0 0 0"/><feFuncG type="table" tableValues="0 0 0 0 0 0 .15 1 .15 0 0 0 0 0 0 0 0 0 0 0"/><feFuncB type="table" tableValues="0 0 0 0 0 0 .15 1 .15 0 0 0 0 0 0 0 0 0 0 0"/><feFuncA type="linear" slope="0" intercept="1"/></feComponentTransfer><feGaussianBlur stdDeviation="0.45"/><feColorMatrix type="matrix" values="0 0 0 0 .62  0 0 0 0 .84  0 0 0 0 1  1 0 0 0 0"/></filter><rect width="100%" height="100%" filter="url(#ice)"/></svg></div>"#;
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

/// Window width (logical px) that leaves room for the two side notes beside the grid
/// (the page's media queries stack them under the grid below these widths).
pub fn wide_width(cols: usize) -> f64 {
    if cols == 4 {
        1240.0
    } else {
        1080.0
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

/// The two notes beside the grid: only what is true of this window. `(title, text)`.
pub fn side_notes(lang: Lang) -> [(&'static str, &'static str); 2] {
    let offline = (
        lang.pick("Hors ligne", "Offline"),
        lang.pick(
            "Ces mots ne passent jamais par Internet, même pas par Tor. Personne de légitime ne te \
             les demandera jamais.",
            "These words never go over the Internet, not even through Tor. No one legitimate will \
             ever ask you for these words.",
        ),
    );
    // Content protection exists on Windows and macOS only.
    let photo = if cfg!(any(windows, target_os = "macos")) {
        lang.pick(
            "Ni capture, ni cloud, ni message. Cette fenêtre est masquée des captures et du \
             partage d’écran, pas d’une caméra : vérifie que personne ne regarde.",
            "No screenshot, no cloud, no message. This window is hidden from screenshots and \
             screen sharing, not from a camera: make sure nobody is watching.",
        )
    } else {
        lang.pick(
            "Ni capture, ni cloud, ni message. Vérifie que personne ne regarde.",
            "No screenshot, no cloud, no message. Make sure nobody is watching.",
        )
    };
    [offline, (lang.pick("Pas de photo", "No photo"), photo)]
}

/// The whole page, words included (wiped from memory when dropped).
pub fn render(lang: Lang, view: &PhraseView<'_>) -> Zeroizing<String> {
    let n = view.words.len();
    let cols = columns(n);
    let mut out = Zeroizing::new(String::with_capacity(12288 + n * 96));
    out.push_str(&format!(
        "<!doctype html><html lang=\"{}\"><head><meta charset=\"utf-8\">\
         <meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\
         <meta name=\"referrer\" content=\"no-referrer\"><title>{}</title><style>{STYLE}</style>\
         </head><body>{LIGHT}<input type=\"checkbox\" id=\"reveal\" class=\"sr\" aria-label=\"{}\"><main>\
         <div class=\"label\"><i></i><span class=\"count\">{}</span></div><h1>{}</h1>\
         <p class=\"lead\">{}</p><div class=\"wrap k{cols}\"><ol class=\"c{cols}\">",
        lang.pick("fr", "en"),
        escape(view.title),
        escape(lang.pick("Afficher les mots", "Show the words")),
        escape(&match lang {
            Lang::Fr => format!("{n} mots"),
            Lang::En => format!("{n} words"),
        }),
        escape(view.title),
        escape(view.lead),
    ));
    for (i, w) in view.words.iter().enumerate() {
        out.push_str("<li><span class=\"n\">");
        out.push_str(&(i + 1).to_string());
        out.push_str("</span><span class=\"w\">");
        out.push_str(&Zeroizing::new(escape(w)));
        out.push_str("</span></li>");
    }
    out.push_str("</ol><div class=\"sides\">");
    for ((title, text), side) in side_notes(lang).into_iter().zip(["r", "l"]) {
        out.push_str(&format!(
            "<div class=\"side {side}\"><span class=\"sq\"></span><span class=\"ln\"></span>\
             <span class=\"tx\"><strong>{}</strong>{}</span></div>",
            escape(title),
            escape(text)
        ));
    }
    out.push_str("</div>");
    if let Passphrase::Shown(p) = view.passphrase {
        out.push_str("<div class=\"pp\"><span class=\"ppl\">");
        out.push_str(&escape(lang.pick("Phrase secrète", "Passphrase")));
        out.push_str("</span><span class=\"w\">");
        out.push_str(&Zeroizing::new(escape(p)));
        out.push_str("</span></div>");
    }
    out.push_str("</div><p class=\"hint\">");
    out.push_str(&escape(lang.pick(
        "Clique sur « Afficher », ou maintiens le clic sur les mots, pour les lire.",
        "Click “Show”, or press and hold the words, to read them.",
    )));
    out.push_str("</p>");
    let passphrase_note = (view.passphrase != Passphrase::None).then(|| {
        lang.pick(
            "Ce portefeuille a aussi une phrase secrète. Sans elle, ces mots n’ouvrent pas ces fonds. \
             Si tu l’oublies, ces fonds sont perdus. Personne ne peut la récupérer.",
            "This wallet also has a passphrase. These words alone do not open these funds. If you \
             forget it, these funds are lost. Nobody can recover it.",
        )
    });
    let notes: Vec<&str> = view
        .notes
        .iter()
        .map(String::as_str)
        .chain(passphrase_note)
        .collect();
    if !notes.is_empty() {
        out.push_str("<ul class=\"notes\">");
        for note in notes {
            out.push_str("<li>");
            out.push_str(&escape(note));
            out.push_str("</li>");
        }
        out.push_str("</ul>");
    }
    out.push_str(&format!(
        "<footer><label for=\"reveal\" class=\"toggle\"><span class=\"s\">{EYE}{}</span>\
         <span class=\"h\">{EYE_OFF}{}</span></label><a class=\"btn\" href=\"{DONE_PATH}\">{}</a>\
         </footer></main></body></html>",
        escape(lang.pick("Afficher", "Show")),
        escape(lang.pick("Masquer", "Hide")),
        escape(lang.pick("J’ai noté ma phrase", "I’ve written it down"))
    ));
    out
}

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

/// The `kyrophrase` scheme handler. Serves only the `phrase` window: any other webview gets 403.
pub fn protocol<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    req: Request<Vec<u8>>,
) -> Response<Vec<u8>> {
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
        p @ (SANS_PATH | MONO_PATH | DISPLAY_PATH) => {
            let i = [SANS_PATH, MONO_PATH, DISPLAY_PATH]
                .iter()
                .position(|x| *x == p)
                .unwrap_or(0);
            let key = FONTS.get().and_then(|f| f[i].clone());
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
    // Wide enough for the side notes, never wider than the screen (the page then stacks them
    // under the grid).
    let screen = main
        .as_ref()
        .and_then(|m| m.current_monitor().ok().flatten())
        .map(|mon| mon.size().width as f64 / mon.scale_factor() - 40.0);
    let width = screen.map_or(wide_width(cols), |s| wide_width(cols).min(s).max(640.0));
    let stacked = width < wide_width(cols);
    let extra_notes = view.notes.len() + usize::from(view.passphrase != Passphrase::None);
    let mut height = 318.0 + rows as f64 * 54.0;
    if matches!(view.passphrase, Passphrase::Shown(_)) {
        height += 58.0;
    }
    if extra_notes > 0 {
        height += 16.0 + extra_notes as f64 * 40.0;
    }
    if stacked {
        height += 110.0;
    }
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
            .background_color(tauri::window::Color(5, 7, 10, 255))
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
pub fn recovery_view<'a>(
    lang: Lang,
    words: &'a [String],
    passphrase: Passphrase<'a>,
) -> PhraseView<'a> {
    PhraseView {
        title: lang.pick("Ta phrase de récupération", "Your recovery phrase"),
        lead: lang.pick(
            "Écris ces mots sur papier, dans l’ordre. Quiconque les possède peut prendre tes fonds.",
            "Write these words on paper, in order. Anyone with them can take your funds.",
        ),
        words,
        passphrase,
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
    fn the_passphrase_is_blurred_like_the_words_and_escaped() {
        let w = words(12);
        let view = recovery_view(Lang::En, &w, Passphrase::Shown("<b>&\"secret\""));
        let page = render(Lang::En, &view);
        assert!(page.contains("<span class=\"w\">&lt;b&gt;&amp;&quot;secret&quot;</span>"));
        assert!(page.contains("If you forget it, these funds are lost. Nobody can recover it."));
        assert!(!page.contains("<b>&"));
    }

    #[test]
    fn creation_only_reminds_and_a_plain_wallet_says_nothing() {
        let w = words(12);
        let reminder = render(Lang::Fr, &recovery_view(Lang::Fr, &w, Passphrase::Reminder));
        assert!(reminder.contains("phrase secrète") && !reminder.contains("class=\"pp\""));
        let plain = render(Lang::En, &recovery_view(Lang::En, &w, Passphrase::None));
        assert!(!plain.contains("passphrase") && !plain.contains("class=\"pp\""));
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
                passphrase: Passphrase::None,
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
                passphrase: Passphrase::None,
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
                passphrase: Passphrase::None,
                notes: vec!["</li><script>".into()],
            },
        );
        assert!(!page.contains("<img") && !page.contains("<script") && !page.contains("<b>"));
        assert!(page.contains("&lt;img src=x&gt;") && page.contains("a&amp;b&quot;&#39;"));
    }

    #[test]
    fn side_notes_are_rendered_once_with_the_grid_class() {
        let w = words(24);
        let page = render(Lang::Fr, &recovery_view(Lang::Fr, &w, Passphrase::None));
        assert!(page.contains("<div class=\"wrap k4\"><ol class=\"c4\">"));
        for (title, text) in side_notes(Lang::Fr) {
            let needle = format!("<strong>{}</strong>{}", escape(title), escape(text));
            assert_eq!(page.matches(&needle).count(), 1, "{needle}");
        }
        assert!(page.contains("Hors ligne") && page.contains("Pas de photo"));
        // No extra notes: no list at all.
        assert!(!page.contains("<ul class=\"notes\">"));
        assert!(page.contains("<h1>Ta phrase de récupération</h1>"));
        assert!(page.contains("<span class=\"count\">24 mots</span>"));
        let en = render(
            Lang::En,
            &recovery_view(Lang::En, &words(12), Passphrase::None),
        );
        assert!(en.contains("<div class=\"wrap k3\"><ol class=\"c3\">"));
        assert!(
            en.contains("<strong>Offline</strong>") && en.contains("<strong>No photo</strong>")
        );
    }

    #[test]
    fn toggle_and_done_are_in_the_footer_and_nothing_is_external() {
        let page = render(
            Lang::En,
            &recovery_view(Lang::En, &words(24), Passphrase::None),
        );
        let footer = &page[page.find("<footer>").unwrap()..];
        assert!(footer.contains("<label for=\"reveal\" class=\"toggle\">"));
        assert!(footer.contains("<a class=\"btn\" href=\"/done\">"));
        // The checkbox precedes <main>, so the CSS reveal selectors still apply.
        assert!(page.find("id=\"reveal\"").unwrap() < page.find("<main>").unwrap());
        assert!(!page.contains(" style=") && !page.contains("<img") && !page.contains("http"));
        assert!(!page.contains("<script"));
        assert!(wide_width(4) > wide_width(3));
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
                "/assets/unbounded-latin-ext-wght-normal-Ux.woff2",
                "/assets/unbounded-latin-wght-normal-Ub.woff2",
                "/assets/index.js",
            ]
            .into_iter(),
        );
        let f = FONTS.get().unwrap();
        assert_eq!(
            f[0].as_deref(),
            Some("/assets/geist-latin-wght-normal-Bg.woff2")
        );
        assert_eq!(
            f[1].as_deref(),
            Some("/assets/geist-mono-latin-wght-normal-XN.woff2")
        );
        assert_eq!(
            f[2].as_deref(),
            Some("/assets/unbounded-latin-wght-normal-Ub.woff2")
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
        let mut page = render(lang, &recovery_view(lang, &w, Passphrase::None)).to_string();
        if let Ok(dir) = std::env::var("KYRO_PHRASE_FONTS") {
            // Font URLs for a page opened from disk (proof only).
            for f in ["sans", "mono", "display"] {
                page = page.replace(
                    &format!("url(/font/{f}.woff2)"),
                    &format!("url({dir}{f}.woff2)"),
                );
            }
        }
        if std::env::var("KYRO_PHRASE_REVEAL").is_ok() {
            page = page.replace("class=\"sr\" aria-label", "class=\"sr\" checked aria-label");
        }
        std::fs::write(path, page.as_bytes()).unwrap();
    }
}
