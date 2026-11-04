//! Lock before the machine sleeps (Windows). The system calls us on `PBT_APMSUSPEND`, before it
//! suspends: the session, and with it the seed, is wiped while Kyro can still run, so it is not in
//! RAM during sleep nor in the hibernation file. macOS and Linux have no such listener yet; the
//! clock-jump lock on wake (`spawn_auto_lock`) stays everywhere as the second line.

/// `PBT_APMSUSPEND`.
#[cfg(any(windows, test))]
const SUSPEND: u32 = 4;

/// Whether this power event must end the session.
#[cfg(any(windows, test))]
fn locks(event: u32, enabled: bool) -> bool {
    event == SUSPEND && enabled
}

#[cfg(windows)]
mod windows {
    use std::ffi::c_void;
    use std::sync::OnceLock;

    use tauri::{Emitter, Manager};
    use windows_sys::Win32::System::Power::{
        PowerRegisterSuspendResumeNotification, DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::DEVICE_NOTIFY_CALLBACK;

    static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

    /// Runs on a system thread, and the system waits for it: nothing here touches the network or
    /// a dialog. A panic must not cross into the caller.
    unsafe extern "system" fn on_power_event(
        _context: *const c_void,
        event: u32,
        _setting: *const c_void,
    ) -> u32 {
        let _ = std::panic::catch_unwind(|| {
            let Some(app) = APP.get() else { return };
            let st = app.state::<crate::state::AppState>();
            if super::locks(event, st.settings().lock_before_sleep) && st.lock_if_unlocked() {
                let _ = app.emit("vault-locked", ());
            }
        });
        0
    }

    /// Registers with the system; the registration lives as long as the process. `false` if
    /// Windows refused it (the lock on wake still applies).
    pub(super) fn register() -> bool {
        let mut params = DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS {
            Callback: Some(on_power_event),
            Context: std::ptr::null_mut(),
        };
        let mut handle: *mut c_void = std::ptr::null_mut();
        // SAFETY: `params` outlives the call (Windows copies it) and the callback is a static
        // function with the documented signature.
        let status = unsafe {
            PowerRegisterSuspendResumeNotification(
                DEVICE_NOTIFY_CALLBACK,
                std::ptr::from_mut(&mut params).cast(),
                &mut handle,
            )
        };
        status == 0
    }

    pub(super) fn listen(app: tauri::AppHandle) {
        if APP.set(app).is_ok() && !register() {
            eprintln!("power: suspend notification refused, locking on wake only");
        }
    }
}

/// Starts listening for the system going to sleep, where Kyro can.
pub fn listen(app: &tauri::AppHandle) {
    #[cfg(windows)]
    windows::listen(app.clone());
    #[cfg(not(windows))]
    let _ = app;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_suspend_locks_and_only_when_on() {
        assert!(locks(SUSPEND, true));
        assert!(!locks(SUSPEND, false));
        // PBT_APMRESUMEAUTOMATIC, PBT_APMRESUMESUSPEND, PBT_APMPOWERSTATUSCHANGE.
        for other in [18, 7, 10] {
            assert!(!locks(other, true));
        }
    }

    /// The real API accepts the registration (a machine has to be put to sleep by hand to see the
    /// callback fire).
    #[cfg(windows)]
    #[test]
    fn windows_accepts_the_registration() {
        assert!(windows::register());
    }
}
