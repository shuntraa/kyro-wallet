//! Anonymous weekly active-wallet count (SECURITY.md, docs/NETWORK.md « weekly count »).
//!
//! At most once per ISO week, a while after an unlock and only once Tor is ready, Kyro downloads
//! the tiny `ping.txt` asset of its latest GitHub release through its own network layer (family
//! `update`, over Tor, never in clear). GitHub's download counter then estimates the number of
//! active wallets. Nothing is sent: no identifier, no extra header, no body. The only local state
//! is the last ISO week sent (`<data>/weekly-count`). Failures are dropped silently. Settings →
//! Privacy → "Anonymous weekly count" turns it off.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::Manager;

use crate::net::{Family, ServerRequest};
use crate::state::AppState;
use crate::tor::TorState;

pub const PING_URL: &str =
    "https://github.com/shuntraa/kyro-wallet/releases/latest/download/ping.txt";
/// After an unlock: the UI's own first requests go first.
const DELAY: Duration = Duration::from_secs(90);
/// How long to wait for Tor to become ready before giving up for this unlock.
const TOR_WAIT: Duration = Duration::from_secs(10 * 60);
const TOR_POLL: Duration = Duration::from_secs(15);

/// One attempt in flight per process at most.
static RUNNING: AtomicBool = AtomicBool::new(false);

/// ISO 8601 week of a Unix time (UTC), e.g. `2026-W45`.
pub fn iso_week(unix_secs: u64) -> String {
    let days = (unix_secs / 86_400) as i64;
    // 1970-01-01 was a Thursday; Monday = 0.
    let weekday = (days + 3).rem_euclid(7);
    let thursday = days - weekday + 3;
    let (year, _, _) = civil_from_days(thursday);
    let week = (thursday - days_from_civil(year, 1, 1)) / 7 + 1;
    format!("{year}-W{week:02}")
}

/// Howard Hinnant's `days_from_civil`.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Howard Hinnant's `civil_from_days`.
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (
        if m <= 2 {
            yoe + era * 400 + 1
        } else {
            yoe + era * 400
        },
        m,
        d,
    )
}

/// Whether to send this week's ping: toggle on, Tor on (never in clear), not already sent.
pub fn due(enabled: bool, tor_enabled: bool, last_sent: Option<&str>, this_week: &str) -> bool {
    enabled && tor_enabled && last_sent != Some(this_week)
}

fn store_path(data_dir: &Path) -> PathBuf {
    data_dir.join("weekly-count")
}

pub fn load_last(data_dir: &Path) -> Option<String> {
    let s = std::fs::read_to_string(store_path(data_dir)).ok()?;
    let s = s.trim();
    (!s.is_empty() && s.len() <= 16).then(|| s.to_owned())
}

pub fn save_last(data_dir: &Path, week: &str) {
    let _ = crate::settings::write_atomic(&store_path(data_dir), week.as_bytes());
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn check(app: &tauri::AppHandle) -> Option<String> {
    let st = app.state::<AppState>();
    let s = st.settings();
    let week = iso_week(now_secs());
    due(
        s.weekly_count,
        s.tor.enabled,
        load_last(&st.data_dir()).as_deref(),
        &week,
    )
    .then_some(week)
}

/// Called after a successful unlock: schedules this week's ping in the background, if due.
pub fn after_unlock(app: &tauri::AppHandle) {
    if check(app).is_none() || RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        send(&app).await;
        RUNNING.store(false, Ordering::SeqCst);
    });
}

async fn send(app: &tauri::AppHandle) {
    tokio::time::sleep(DELAY).await;
    let mut waited = Duration::ZERO;
    loop {
        if app.state::<AppState>().net.tor.status().state == TorState::Ready {
            break;
        }
        if waited >= TOR_WAIT {
            return;
        }
        tokio::time::sleep(TOR_POLL).await;
        waited += TOR_POLL;
    }
    // Settings may have changed while waiting (toggle off, Tor off): checked again.
    let Some(week) = check(app) else {
        return;
    };
    let Ok(url) = url::Url::parse(PING_URL) else {
        return;
    };
    let st = app.state::<AppState>();
    let net = st.net.clone();
    // `tor = true` always: if Tor is off, `check` refused above; never a clear request.
    if let Ok((200, _)) = net
        .server_request(ServerRequest::get(url, Family::Update), true)
        .await
    {
        save_last(&st.data_dir(), &week);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: u64 = 86_400;

    #[test]
    fn iso_weeks() {
        assert_eq!(iso_week(0), "1970-W01"); // Thursday 1970-01-01
                                             // 2026-11-02 is a Monday (week 45).
        let mon = days_from_civil(2026, 11, 2) as u64 * DAY;
        assert_eq!(iso_week(mon), "2026-W45");
        assert_eq!(
            iso_week(mon + 6 * DAY + DAY - 1),
            "2026-W45",
            "Sunday 23:59:59"
        );
        assert_eq!(iso_week(mon + 7 * DAY), "2026-W46");
        assert_eq!(iso_week(mon - 1), "2026-W44");
        // Year boundaries: 2021-01-03 belongs to 2020-W53; 2024-12-30 to 2025-W01.
        assert_eq!(
            iso_week(days_from_civil(2021, 1, 3) as u64 * DAY),
            "2020-W53"
        );
        assert_eq!(
            iso_week(days_from_civil(2024, 12, 30) as u64 * DAY),
            "2025-W01"
        );
        assert_eq!(civil_from_days(days_from_civil(2028, 2, 29)), (2028, 2, 29));
    }

    #[test]
    fn at_most_once_per_week_and_only_over_tor() {
        assert!(due(true, true, None, "2026-W45"));
        assert!(due(true, true, Some("2026-W44"), "2026-W45"));
        assert!(
            !due(true, true, Some("2026-W45"), "2026-W45"),
            "already sent"
        );
        assert!(!due(false, true, None, "2026-W45"), "toggle off");
        assert!(
            !due(true, false, None, "2026-W45"),
            "Tor off: never in clear"
        );
    }

    #[test]
    fn last_week_is_stored_locally() {
        let dir = std::env::temp_dir().join(format!("kyro-weekly-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(load_last(&dir), None);
        save_last(&dir, "2026-W45");
        assert_eq!(load_last(&dir).as_deref(), Some("2026-W45"));
        assert!(!due(true, true, load_last(&dir).as_deref(), "2026-W45"));
        assert!(due(true, true, load_last(&dir).as_deref(), "2026-W46"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ping_url_is_an_update_host() {
        let u = url::Url::parse(PING_URL).unwrap();
        assert!(crate::net::UPDATE_HOSTS.contains(&u.host_str().unwrap()));
        assert!(PING_URL.starts_with("https://github.com/shuntraa/kyro-wallet/releases/"));
    }
}
