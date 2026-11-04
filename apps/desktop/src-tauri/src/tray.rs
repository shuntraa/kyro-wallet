//! Tray icon (Windows only: on macOS and Linux Kyro keeps quitting when its window closes, and
//! Settings does not offer these options). Open, Lock and Quit are Rust menu items: the webview
//! gets no tray or autostart permission. Closing the window hides Kyro only if the user asked for
//! it; every quit, from the tray too, goes through [`shutdown`], which applies a staged update.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::Manager;

use crate::settings::Settings;
use crate::state::AppState;

/// Argument of the start-with-Windows entry: start hidden in the tray.
pub const ARG_MINIMIZED: &str = "--minimized";
/// Value name under the user's `Run` key.
#[cfg(windows)]
const RUN_VALUE: &str = "Kyro";

/// Whether this platform has the tray and its options.
pub const fn available() -> bool {
    cfg!(windows)
}

/// A close the user asked for, or the window already gone (end of session, crash of the webview).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Closing {
    Requested,
    Destroyed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseAction {
    /// Stay in the tray; `lock` ends the session first.
    Hide {
        lock: bool,
    },
    Quit,
}

/// What a close of the main window means. A window already destroyed cannot be kept, and after
/// the tray's Quit nothing is.
pub fn close_action(
    closing: Closing,
    tray: bool,
    close_to_tray: bool,
    lock_on_hide: bool,
    quitting: bool,
) -> CloseAction {
    if closing == Closing::Requested && tray && close_to_tray && !quitting {
        CloseAction::Hide { lock: lock_on_hide }
    } else {
        CloseAction::Quit
    }
}

/// The main window's close, with the current settings.
pub fn on_close(app: &tauri::AppHandle, closing: Closing) -> CloseAction {
    let s = app.state::<AppState>().settings();
    let tray = app.try_state::<TrayState>();
    let active = tray.as_ref().is_some_and(|t| t.active);
    let quitting = tray
        .as_ref()
        .is_some_and(|t| t.quitting.load(Ordering::SeqCst));
    close_action(closing, active, s.close_to_tray, s.lock_on_hide, quitting)
}

#[derive(Default)]
pub struct TrayState {
    /// The icon exists: without it, hiding the window would leave no way back.
    active: bool,
    quitting: AtomicBool,
}

fn close_phrase_window(app: &tauri::AppHandle) {
    if let Some(phrase) = app.get_webview_window(crate::phrase_window::LABEL) {
        let _ = phrase.destroy();
    }
}

/// Ends the session and tells the interface. The phrase window never outlives it.
fn lock(app: &tauri::AppHandle) {
    use tauri::Emitter as _;
    close_phrase_window(app);
    app.state::<AppState>().lock_session();
    let _ = app.emit("vault-locked", ());
}

/// Into the tray. The phrase window closes whatever the lock setting says: it must not stay on
/// screen behind a hidden window.
pub fn hide(app: &tauri::AppHandle, lock_session: bool) {
    close_phrase_window(app);
    if lock_session {
        lock(app);
    }
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.hide();
    }
}

/// The steps of any quit, in order: the update goes last, once the session is gone. `install`
/// runs once whichever signal comes first (`updater::QuitOnce`).
fn shutdown_steps(close_phrase: impl FnOnce(), lock: impl FnOnce(), install: impl FnOnce()) {
    close_phrase();
    lock();
    install();
}

/// Everything a quit must do before the process goes: called at the main window's close and by
/// the tray's Quit, because `RunEvent::Exit` may never come (see `updater::QuitOnce`).
pub fn shutdown(app: &tauri::AppHandle) {
    shutdown_steps(
        || close_phrase_window(app),
        || crate::commands::lock_on_exit(app),
        || crate::updater::on_exit(app),
    );
}

/// The command line of the start-with-Windows entry.
#[cfg_attr(not(windows), allow(dead_code))]
fn run_command(exe: &std::path::Path) -> String {
    format!("\"{}\" {ARG_MINIMIZED}", exe.display())
}

/// Whether this start was asked to stay hidden.
pub fn started_minimized(mut args: impl Iterator<Item = String>) -> bool {
    available() && args.any(|a| a == ARG_MINIMIZED)
}

#[cfg(windows)]
pub use imp::{already_running, setup, sync_autostart, sync_language};

/// Nothing to do on platforms without the tray.
#[cfg(not(windows))]
pub fn sync_autostart(_settings: &Settings) -> crate::error::AppResult<()> {
    Ok(())
}

#[cfg(not(windows))]
pub fn sync_language(_app: &tauri::AppHandle) {}

#[cfg(not(windows))]
pub fn setup(app: &tauri::App) -> bool {
    app.manage(TrayState::default());
    false
}

#[cfg(not(windows))]
pub fn already_running(_minimized: bool) -> bool {
    false
}

#[cfg(windows)]
mod imp {
    use std::sync::atomic::Ordering;

    use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    use tauri::Manager;
    use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
    use windows_sys::Win32::System::Registry::{
        RegDeleteKeyValueW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ,
    };
    use windows_sys::Win32::System::Threading::{
        CreateEventW, OpenEventW, SetEvent, WaitForSingleObject, EVENT_MODIFY_STATE, INFINITE,
    };

    use super::{lock, shutdown, TrayState, RUN_VALUE};
    use crate::error::{AppError, AppResult};
    use crate::settings::Settings;

    const TRAY_ID: &str = "kyro";
    const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    /// A second start while Kyro sits in the tray signals this event and leaves: two processes
    /// on one vault and one settings file would overwrite each other. Debug builds have their own.
    const SHOW_EVENT: &str = if cfg!(debug_assertions) {
        r"Local\org.kyro.wallet.dev.show"
    } else {
        r"Local\org.kyro.wallet.show"
    };

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// Asks a running Kyro to show its window; true if there is one.
    pub fn already_running(minimized: bool) -> bool {
        let name = wide(SHOW_EVENT);
        // SAFETY: `name` is a NUL-terminated UTF-16 string that outlives the calls, and the
        // returned handle is checked before use. It is released with the process, which leaves.
        unsafe {
            let event = OpenEventW(EVENT_MODIFY_STATE, 0, name.as_ptr());
            if event.is_null() {
                return false;
            }
            if !minimized {
                SetEvent(event);
            }
        }
        true
    }

    /// Created after the updater's start hook: a restart that applies an update must not find it.
    fn listen_for_second_start(app: tauri::AppHandle) {
        let name = wide(SHOW_EVENT);
        // SAFETY: as above; null attributes, auto-reset, not signaled.
        let event = unsafe { CreateEventW(std::ptr::null(), 0, 0, name.as_ptr()) };
        if event.is_null() {
            return;
        }
        let event = event as usize;
        std::thread::spawn(move || loop {
            // SAFETY: the handle is never closed; it lives as long as the process.
            unsafe { WaitForSingleObject(event as *mut core::ffi::c_void, INFINITE) };
            show(&app);
        });
    }

    fn show(app: &tauri::AppHandle) {
        if let Some(main) = app.get_webview_window("main") {
            let _ = main.show();
            let _ = main.unminimize();
            let _ = main.set_focus();
        }
    }

    fn menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
        let lang = crate::i18n::current();
        let open = MenuItem::with_id(app, "open", lang.pick("Ouvrir", "Open"), true, None::<&str>)?;
        let lock = MenuItem::with_id(
            app,
            "lock",
            lang.pick("Verrouiller", "Lock"),
            true,
            None::<&str>,
        )?;
        let quit = MenuItem::with_id(
            app,
            "quit",
            lang.pick("Quitter", "Quit"),
            true,
            None::<&str>,
        )?;
        Menu::with_items(
            app,
            &[&open, &lock, &PredefinedMenuItem::separator(app)?, &quit],
        )
    }

    fn on_menu(app: &tauri::AppHandle, event: MenuEvent) {
        match event.id().as_ref() {
            "open" => show(app),
            "lock" => lock(app),
            "quit" => {
                app.state::<TrayState>()
                    .quitting
                    .store(true, Ordering::SeqCst);
                shutdown(app);
                app.exit(0);
            }
            _ => {}
        }
    }

    fn build(handle: &tauri::AppHandle) -> tauri::Result<()> {
        let mut tray = TrayIconBuilder::with_id(TRAY_ID)
            .tooltip("Kyro")
            .menu(&menu(handle)?)
            .show_menu_on_left_click(false)
            .on_menu_event(on_menu)
            .on_tray_icon_event(|tray, event| {
                if let TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } = event
                {
                    show(tray.app_handle());
                }
            });
        if let Some(icon) = handle.default_window_icon() {
            tray = tray.icon(icon.clone());
        }
        tray.build(handle)?;
        Ok(())
    }

    /// True if the icon is there. A failure costs the tray, never the wallet: closing then quits
    /// and a hidden start shows its window.
    pub fn setup(app: &tauri::App) -> bool {
        let handle = app.handle();
        let active = build(handle).is_ok();
        app.manage(TrayState {
            active,
            ..TrayState::default()
        });
        listen_for_second_start(handle.clone());
        // An install moved since the entry was written still starts.
        let settings = handle.state::<crate::state::AppState>().settings();
        if settings.start_minimized {
            let _ = sync_autostart(&settings);
        }
        active
    }

    /// The menu in the language just chosen.
    pub fn sync_language(app: &tauri::AppHandle) {
        if let (Some(tray), Ok(menu)) = (app.tray_by_id(TRAY_ID), menu(app)) {
            let _ = tray.set_menu(Some(menu));
        }
    }

    /// Writes or removes the user's `Run` entry. Kyro's own path only: the setting is a boolean.
    pub fn sync_autostart(settings: &Settings) -> AppResult<()> {
        let key = wide(RUN_KEY);
        let value = wide(RUN_VALUE);
        let failed = || AppError::Internal("start with Windows: registry refused".into());
        if !settings.start_minimized {
            // SAFETY: both strings are NUL-terminated and outlive the call.
            let code =
                unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, key.as_ptr(), value.as_ptr()) };
            return match code {
                ERROR_SUCCESS | ERROR_FILE_NOT_FOUND => Ok(()),
                _ => Err(failed()),
            };
        }
        let exe = std::env::current_exe().map_err(|_| failed())?;
        let data = wide(&super::run_command(&exe));
        let size = u32::try_from(data.len() * 2).map_err(|_| failed())?;
        // SAFETY: as above; `data` is `size` bytes of NUL-terminated UTF-16, as REG_SZ expects.
        let code = unsafe {
            RegSetKeyValueW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                value.as_ptr(),
                REG_SZ,
                data.as_ptr().cast(),
                size,
            )
        };
        if code == ERROR_SUCCESS {
            Ok(())
        } else {
            Err(failed())
        }
    }
}

/// `settings_set`: what follows a change of the tray settings or the language.
pub fn on_settings_saved(app: &tauri::AppHandle, old: &Settings, new: &Settings) {
    if old.language != new.language {
        sync_language(app);
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::path::Path;

    use super::*;

    const REQUESTED: Closing = Closing::Requested;

    #[test]
    fn closing_quits_unless_the_user_asked_for_the_tray() {
        assert_eq!(
            close_action(REQUESTED, true, false, true, false),
            CloseAction::Quit
        );
        assert_eq!(
            close_action(REQUESTED, true, true, true, false),
            CloseAction::Hide { lock: true }
        );
        assert_eq!(
            close_action(REQUESTED, true, true, false, false),
            CloseAction::Hide { lock: false }
        );
    }

    #[test]
    fn a_platform_without_tray_always_quits() {
        assert_eq!(
            close_action(REQUESTED, false, true, true, false),
            CloseAction::Quit
        );
    }

    #[test]
    fn the_tray_quit_and_a_destroyed_window_are_never_kept() {
        assert_eq!(
            close_action(REQUESTED, true, true, true, true),
            CloseAction::Quit
        );
        assert_eq!(
            close_action(Closing::Destroyed, true, true, false, false),
            CloseAction::Quit
        );
    }

    #[test]
    fn a_quit_locks_then_applies_the_update() {
        let order = RefCell::new(Vec::new());
        shutdown_steps(
            || order.borrow_mut().push("phrase"),
            || order.borrow_mut().push("lock"),
            || order.borrow_mut().push("update"),
        );
        assert_eq!(*order.borrow(), ["phrase", "lock", "update"]);
    }

    #[test]
    fn tray_options_are_off_and_lock_on_hide_is_on_by_default() {
        let s = Settings::default();
        assert!(!s.close_to_tray && !s.start_minimized && s.lock_on_hide);
        let old: Settings = serde_json::from_str(r#"{"currency":"USD"}"#).unwrap();
        assert!(!old.close_to_tray && !old.start_minimized && old.lock_on_hide);
    }

    #[test]
    fn the_autostart_entry_quotes_the_path_and_starts_hidden() {
        assert_eq!(
            run_command(Path::new(r"C:\Program Files\Kyro\kyro.exe")),
            r#""C:\Program Files\Kyro\kyro.exe" --minimized"#
        );
    }

    #[test]
    fn only_the_exact_argument_starts_hidden() {
        let args = |a: &[&str]| a.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
        assert_eq!(
            started_minimized(args(&["kyro", "--minimized"]).into_iter()),
            available()
        );
        assert!(!started_minimized(
            args(&["kyro", "--minimize"]).into_iter()
        ));
        assert!(!started_minimized(args(&["kyro"]).into_iter()));
    }
}
