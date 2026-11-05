// SPDX-License-Identifier: GPL-3.0-or-later
//! Optional daily spending limit, enforced where a software-wallet signature is approved.
//!
//! [`approve`] runs from `accounts::confirm_signer`, the last step before a key signs. Every signing
//! command must hand it a [`Spend`] (the parameter is required, so a new chain cannot skip it). What
//! counts and what does not is written down in docs/IPC.md §2.13 and SECURITY.md.
//!
//! The state sits next to the vault of the wallet in use (`<vault>.spendlimit`), so each wallet of
//! each network has its own: another wallet never inherits it. It does not depend on `settings_set`
//! or the backup, which go through `settings.json`.
//!
//! Time comes from [`Clock`], not from the wall clock directly: it only ever moves forward, so
//! setting the computer's date back cannot end a wait or empty the 24 h total.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::State;
use zeroize::Zeroizing;

use crate::error::{AppError, AppResult};
use crate::spend_value::{fiat_value, Coin, Spend};
use crate::state::AppState;

const HOUR: u64 = 3_600;
const DAY: u64 = 24 * HOUR;
/// How long an accepted override stays open.
const OVERRIDE_WINDOW: u64 = HOUR;
/// A finished wait left unconfirmed lapses: it cannot sit armed for a later thief.
const READY_LAPSES_AFTER: u64 = DAY;
const MAX_AMOUNT: f64 = 1e15;
const FILE_VERSION: u8 = 1;
/// How long a swap's declared amount waits for its signature.
const DECLARED_TTL: Duration = Duration::from_secs(5 * 60);

/// Serialises every read-modify-write of a limit file: two signatures cannot both fit the same room.
static STORE_LOCK: Mutex<()> = Mutex::new(());
static DECLARED: Mutex<Option<Declared>> = Mutex::new(None);

fn guard<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn wall_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

/// Elapsed time as Kyro counts it. `now` gains what the wall clock gained since the last reading
/// and nothing when it went back, so it never decreases.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Clock {
    now: u64,
    wall: u64,
}

impl Clock {
    fn read(&mut self, wall: u64) {
        self.now = self.now.saturating_add(wall.saturating_sub(self.wall));
        self.wall = wall;
    }
}

/// The limit itself. Off is `Limit::config == None`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    amount: f64,
    /// Fixed when the limit is set: changing the display currency later does not move it.
    currency: String,
    wait_secs: u64,
}

impl Config {
    fn new(amount: f64, currency: String, wait_secs: u64) -> AppResult<Config> {
        if !amount.is_finite() || amount <= 0.0 || amount > MAX_AMOUNT {
            return Err(AppError::InvalidInput("limit: invalid amount".into()));
        }
        if !crate::fiat::is_supported(&currency) {
            return Err(AppError::InvalidInput("currency not offered".into()));
        }
        if wait_secs != HOUR && wait_secs != DAY {
            return Err(AppError::InvalidInput("wait: 1 h or 24 h".into()));
        }
        Ok(Config {
            amount,
            currency,
            wait_secs,
        })
    }

    /// Protects at least as much as `self`. Two currencies cannot be compared without a rate, so a
    /// change of currency never counts as tighter.
    fn tightened_by(&self, next: &Config) -> bool {
        self.currency == next.currency
            && next.amount <= self.amount
            && next.wait_secs >= self.wait_secs
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    at: u64,
    value: f64,
}

/// A raise or a disable waiting for its delay. `target: None` turns the limit off.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Change {
    target: Option<Config>,
    ready_at: u64,
}

/// What a limit refuses, for the screen.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Exceeded {
    pub spent: f64,
    pub limit: f64,
    /// `None`: the value is not known (fail closed).
    pub amount: Option<f64>,
    pub currency: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum What {
    Override,
    Change,
}

/// Content of `<vault>.spendlimit`. Every field is required: a cut file is a damaged file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Limit {
    version: u8,
    clock: Clock,
    config: Option<Config>,
    spends: Vec<Entry>,
    /// When a requested override can be confirmed.
    override_ready_at: Option<u64>,
    /// End of the open override window.
    override_until: Option<u64>,
    change: Option<Change>,
}

impl Default for Limit {
    fn default() -> Self {
        Limit {
            version: FILE_VERSION,
            clock: Clock::default(),
            config: None,
            spends: Vec::new(),
            override_ready_at: None,
            override_until: None,
            change: None,
        }
    }
}

impl Limit {
    /// An unreadable file must not turn the limit off: everything counted is over a limit of
    /// zero until an override, and the normal delay is the way out.
    fn damaged() -> Limit {
        Limit {
            config: Some(Config {
                amount: 0.0,
                currency: crate::fiat::DEFAULT_CURRENCY.into(),
                wait_secs: DAY,
            }),
            ..Limit::default()
        }
    }

    fn sane(&self) -> bool {
        self.version == FILE_VERSION
            && self
                .spends
                .iter()
                .all(|e| e.value.is_finite() && e.value >= 0.0)
            && self
                .config
                .as_ref()
                .is_none_or(|c| c.amount.is_finite() && c.amount >= 0.0)
    }

    fn load(path: &Path) -> Limit {
        match fs::read(path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Limit::default(),
            Err(_) => Limit::damaged(),
            Ok(raw) => serde_json::from_slice::<Limit>(&raw)
                .ok()
                .filter(Limit::sane)
                .unwrap_or_else(Limit::damaged),
        }
    }

    fn save(&self, path: &Path) -> AppResult<()> {
        crate::settings::write_atomic(path, &serde_json::to_vec(self)?)
    }

    /// Reads the clock and drops what time has ended.
    fn tick(&mut self, wall: u64) {
        self.clock.read(wall);
        let now = self.clock.now;
        self.spends.retain(|e| e.at.saturating_add(DAY) > now);
        if self.override_until.is_some_and(|u| u <= now) {
            self.override_until = None;
        }
        let lapsed = |ready: u64| ready.saturating_add(READY_LAPSES_AFTER) <= now;
        if self.override_ready_at.is_some_and(lapsed) {
            self.override_ready_at = None;
        }
        if self.change.as_ref().is_some_and(|c| lapsed(c.ready_at)) {
            self.change = None;
        }
    }

    fn spent(&self) -> f64 {
        self.spends.iter().map(|e| e.value).sum()
    }

    /// Lets a send through and counts it, or says why not. `value: None` is never within the limit,
    /// and once let through by an override it counts as the whole limit.
    fn spend(&mut self, value: Option<f64>) -> Result<(), Exceeded> {
        let Some(config) = self.config.clone() else {
            return Ok(());
        };
        let value = value.filter(|v| v.is_finite() && *v >= 0.0);
        let spent = self.spent();
        let fits = value.is_some_and(|v| spent + v <= config.amount);
        if !fits && self.override_until.take().is_none() {
            return Err(Exceeded {
                spent,
                limit: config.amount,
                amount: value,
                currency: config.currency,
            });
        }
        self.spends.push(Entry {
            at: self.clock.now,
            value: value.unwrap_or(config.amount),
        });
        Ok(())
    }

    fn wait_secs(&self) -> AppResult<u64> {
        self.config
            .as_ref()
            .map(|c| c.wait_secs)
            .ok_or_else(|| AppError::InvalidInput("the limit is off".into()))
    }

    fn request_override(&mut self) -> AppResult<()> {
        let wait = self.wait_secs()?;
        if self.override_ready_at.is_some() || self.override_until.is_some() {
            return Err(AppError::InvalidInput(
                "an override is already running".into(),
            ));
        }
        self.override_ready_at = Some(self.clock.now.saturating_add(wait));
        Ok(())
    }

    /// The caller has checked the password.
    fn open_override(&mut self) -> AppResult<()> {
        match self.override_ready_at {
            Some(at) if at <= self.clock.now => {
                self.override_ready_at = None;
                self.override_until = Some(self.clock.now.saturating_add(OVERRIDE_WINDOW));
                Ok(())
            }
            Some(_) => Err(AppError::InvalidInput("the wait is not over".into())),
            None => Err(AppError::InvalidInput("no override requested".into())),
        }
    }

    /// Turning on or tightening applies now and drops any pending loosening. The rest waits for the
    /// current delay. The caller has checked the password.
    fn configure(&mut self, next: Option<Config>) -> AppResult<()> {
        let loosening = match (&self.config, &next) {
            (None, _) => false,
            (Some(_), None) => true,
            (Some(cur), Some(n)) => !cur.tightened_by(n),
        };
        if loosening {
            let ready_at = self.clock.now.saturating_add(self.wait_secs()?);
            self.change = Some(Change {
                target: next,
                ready_at,
            });
        } else {
            self.install(next);
        }
        Ok(())
    }

    fn install(&mut self, next: Option<Config>) {
        if next.is_none() {
            self.override_ready_at = None;
            self.override_until = None;
        }
        self.config = next;
        self.change = None;
    }

    /// The caller has checked the password.
    fn apply_change(&mut self) -> AppResult<()> {
        match &self.change {
            Some(c) if c.ready_at <= self.clock.now => {
                let target = c.target.clone();
                self.install(target);
                Ok(())
            }
            Some(_) => Err(AppError::InvalidInput("the wait is not over".into())),
            None => Err(AppError::InvalidInput("no change waiting".into())),
        }
    }

    /// Only ever takes something away, so it needs no password.
    fn cancel(&mut self, what: What) {
        match what {
            What::Override => {
                self.override_ready_at = None;
                self.override_until = None;
            }
            What::Change => self.change = None,
        }
    }

    fn view(&self) -> LimitView {
        let now = self.clock.now;
        let left = |at: u64| at.saturating_sub(now);
        let override_state = match (self.override_until, self.override_ready_at) {
            (Some(until), _) => Some(OverrideView {
                phase: "open",
                secs_left: left(until),
            }),
            (None, Some(at)) if at > now => Some(OverrideView {
                phase: "waiting",
                secs_left: left(at),
            }),
            (None, Some(_)) => Some(OverrideView {
                phase: "ready",
                secs_left: 0,
            }),
            (None, None) => None,
        };
        LimitView {
            config: self.config.clone(),
            spent: self.spent(),
            override_state,
            change: self.change.as_ref().map(|c| ChangeView {
                target: c.target.clone(),
                secs_left: left(c.ready_at),
            }),
        }
    }
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OverrideView {
    phase: &'static str,
    secs_left: u64,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChangeView {
    target: Option<Config>,
    /// 0: the wait is over, the password applies it.
    secs_left: u64,
}

/// What `spend_limit_status` returns.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LimitView {
    config: Option<Config>,
    spent: f64,
    #[serde(rename = "override")]
    override_state: Option<OverrideView>,
    change: Option<ChangeView>,
}

/// A swap's calldata that Rust cannot read: what the interface says it sells, bound to those exact
/// bytes and to one signature.
struct Declared {
    vault: PathBuf,
    chain: String,
    payload: String,
    coin: Coin,
    at: Instant,
}

fn take_declared(vault: &Path, chain: &str, payload: &str) -> Option<Coin> {
    let mut slot = guard(&DECLARED);
    let matches = slot.as_ref().is_some_and(|d| {
        d.vault == vault
            && d.chain == chain
            && d.payload == payload
            && d.at.elapsed() < DECLARED_TTL
    });
    matches.then(|| slot.take().map(|d| d.coin)).flatten()
}

fn file_of(state: &AppState) -> PathBuf {
    state.active_vault_path().with_extension("spendlimit")
}

/// Read, tick, change, save, under the store lock. Nothing is saved when `f` fails.
fn update<T>(path: &Path, f: impl FnOnce(&mut Limit) -> AppResult<T>) -> AppResult<T> {
    let _lock = guard(&STORE_LOCK);
    let mut limit = Limit::load(path);
    limit.tick(wall_now());
    let out = f(&mut limit)?;
    limit.save(path)?;
    Ok(out)
}

fn status(path: &Path) -> LimitView {
    let _lock = guard(&STORE_LOCK);
    let mut limit = Limit::load(path);
    limit.tick(wall_now());
    limit.view()
}

/// The last step before a signature. Counts the send, or refuses it with `SPEND_LIMIT`. If the
/// record cannot be written the send is refused too: nothing is signed without being counted.
pub async fn approve(state: &AppState, spend: Spend) -> AppResult<()> {
    if matches!(spend, Spend::Free) {
        return Ok(());
    }
    let path = file_of(state);
    let currency = {
        let _lock = guard(&STORE_LOCK);
        match Limit::load(&path).config {
            Some(c) => c.currency,
            None => return Ok(()),
        }
    };
    let value = match &spend {
        Spend::Free => return Ok(()),
        Spend::Unknown => None,
        Spend::Coins(coins) => fiat_value(state, coins, &currency).await,
        Spend::Undecoded {
            attached,
            chain,
            payload,
        } => match take_declared(&path, chain, payload) {
            Some(declared) => {
                let sold = fiat_value(state, std::slice::from_ref(&declared), &currency).await;
                let sent = fiat_value(state, attached, &currency).await;
                sold.zip(sent).map(|(a, b)| a.max(b))
            }
            None => None,
        },
    };
    let _lock = guard(&STORE_LOCK);
    let mut limit = Limit::load(&path);
    limit.tick(wall_now());
    // The limit changed during the price lookup: that value is in another currency.
    let same_currency = limit
        .config
        .as_ref()
        .is_some_and(|c| c.currency == currency);
    limit
        .spend(value.filter(|_| same_currency))
        .map_err(AppError::SpendLimit)?;
    limit.save(&path)
}

fn require_unlocked(state: &AppState) -> AppResult<()> {
    if state.is_unlocked() {
        Ok(())
    } else {
        Err(AppError::Locked)
    }
}

async fn check_password(state: &AppState, password: String) -> AppResult<()> {
    crate::commands::secret_from_password(state, Zeroizing::new(password)).await?;
    Ok(())
}

#[tauri::command]
pub fn spend_limit_status(state: State<'_, AppState>) -> AppResult<LimitView> {
    require_unlocked(&state)?;
    Ok(status(&file_of(&state)))
}

/// `enabled: false` asks to turn it off; otherwise the three values are the limit wanted.
#[tauri::command]
pub async fn spend_limit_set(
    state: State<'_, AppState>,
    enabled: bool,
    amount: f64,
    currency: String,
    wait_secs: u64,
    password: String,
) -> AppResult<LimitView> {
    require_unlocked(&state)?;
    let next = enabled
        .then(|| Config::new(amount, currency, wait_secs))
        .transpose()?;
    let path = file_of(&state);
    check_password(&state, password).await?;
    update(&path, |l| l.configure(next))?;
    state.touch();
    Ok(status(&path))
}

/// Applies a raise or a disable once its wait is over.
#[tauri::command]
pub async fn spend_limit_apply(
    state: State<'_, AppState>,
    password: String,
) -> AppResult<LimitView> {
    require_unlocked(&state)?;
    let path = file_of(&state);
    check_password(&state, password).await?;
    update(&path, Limit::apply_change)?;
    state.touch();
    Ok(status(&path))
}

#[tauri::command]
pub fn spend_limit_override_request(state: State<'_, AppState>) -> AppResult<LimitView> {
    require_unlocked(&state)?;
    let path = file_of(&state);
    update(&path, Limit::request_override)?;
    Ok(status(&path))
}

/// After the wait: opens the window for one transaction.
#[tauri::command]
pub async fn spend_limit_override_confirm(
    state: State<'_, AppState>,
    password: String,
) -> AppResult<LimitView> {
    require_unlocked(&state)?;
    let path = file_of(&state);
    check_password(&state, password).await?;
    update(&path, Limit::open_override)?;
    state.touch();
    Ok(status(&path))
}

/// `what`: `override` or `change`.
#[tauri::command]
pub fn spend_limit_cancel(state: State<'_, AppState>, what: String) -> AppResult<LimitView> {
    require_unlocked(&state)?;
    let what = match what.as_str() {
        "override" => What::Override,
        "change" => What::Change,
        _ => return Err(AppError::InvalidInput("override or change".into())),
    };
    let path = file_of(&state);
    update(&path, |l| {
        l.cancel(what);
        Ok(())
    })?;
    Ok(status(&path))
}

/// Swap only: says what the next signature of exactly `payload` sells. Rust prices it from its own
/// tables, but the amount is the interface's word (docs/IPC.md §2.13).
#[tauri::command]
pub fn spend_limit_declare(
    state: State<'_, AppState>,
    chain: String,
    payload: String,
    contract: Option<String>,
    amount: String,
) -> AppResult<()> {
    require_unlocked(&state)?;
    let coin =
        crate::spend_value::declared_coin(state.network, &chain, contract.as_deref(), amount)?;
    *guard(&DECLARED) = Some(Declared {
        vault: file_of(&state),
        chain,
        payload,
        coin,
        at: Instant::now(),
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: u64 = 1_800_000_000;

    fn on(amount: f64, wait: u64) -> Limit {
        let mut l = Limit::default();
        l.tick(T0);
        l.configure(Some(cfg(amount, wait))).unwrap();
        l
    }

    fn cfg(amount: f64, wait: u64) -> Config {
        Config::new(amount, "EUR".into(), wait).unwrap()
    }

    fn temp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kyro-limit-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn off_by_default_and_counts_nothing() {
        let mut l = Limit::default();
        l.tick(T0);
        assert!(l.spend(Some(1e9)).is_ok());
        assert!(l.spend(None).is_ok());
        assert!(l.spends.is_empty());
    }

    #[test]
    fn rolling_total_refuses_then_frees_up_after_24_hours() {
        let mut l = on(100.0, DAY);
        l.spend(Some(60.0)).unwrap();
        l.tick(T0 + 12 * HOUR);
        l.spend(Some(40.0)).unwrap(); // exactly the limit fits
        let e = l.spend(Some(0.01)).unwrap_err();
        assert_eq!((e.spent, e.limit, e.amount), (100.0, 100.0, Some(0.01)));
        assert_eq!(e.currency, "EUR");

        // The first send leaves the window; the second is still in it.
        l.tick(T0 + DAY);
        assert_eq!(l.spent(), 40.0);
        assert!(l.spend(Some(61.0)).is_err());
        l.spend(Some(60.0)).unwrap();
        l.tick(T0 + 12 * HOUR + DAY);
        assert_eq!(l.spent(), 60.0);
    }

    #[test]
    fn a_refused_send_is_not_counted() {
        let mut l = on(100.0, DAY);
        assert!(l.spend(Some(500.0)).is_err());
        assert_eq!(l.spent(), 0.0);
    }

    #[test]
    fn override_waits_then_opens_for_one_transaction() {
        let mut l = on(100.0, HOUR);
        assert!(l.spend(Some(500.0)).is_err());
        l.request_override().unwrap();
        assert!(l.request_override().is_err(), "one at a time");
        assert_eq!(l.view().override_state.unwrap().phase, "waiting");

        // Requested is not granted, and the wait cannot be confirmed early.
        assert!(l.spend(Some(500.0)).is_err());
        l.tick(T0 + HOUR - 1);
        assert!(l.open_override().is_err());

        l.tick(T0 + HOUR);
        assert_eq!(l.view().override_state.unwrap().phase, "ready");
        assert!(l.spend(Some(500.0)).is_err(), "still needs the password");
        l.open_override().unwrap();
        assert_eq!(
            l.view().override_state.unwrap(),
            OverrideView {
                phase: "open",
                secs_left: HOUR
            }
        );

        l.spend(Some(500.0)).unwrap();
        assert_eq!(l.spent(), 500.0, "it still counts");
        assert!(l.spend(Some(500.0)).is_err(), "one transaction only");
        assert!(l.view().override_state.is_none());
    }

    #[test]
    fn a_send_within_the_limit_leaves_the_override_open() {
        let mut l = on(100.0, HOUR);
        l.request_override().unwrap();
        l.tick(T0 + HOUR);
        l.open_override().unwrap();
        l.spend(Some(5.0)).unwrap();
        l.spend(Some(500.0)).unwrap();
    }

    #[test]
    fn the_override_window_closes_after_an_hour() {
        let mut l = on(100.0, HOUR);
        l.request_override().unwrap();
        l.tick(T0 + HOUR);
        l.open_override().unwrap();
        l.tick(T0 + 2 * HOUR);
        assert!(l.spend(Some(500.0)).is_err());
    }

    #[test]
    fn a_finished_wait_does_not_stay_armed() {
        let mut l = on(100.0, HOUR);
        l.request_override().unwrap();
        l.configure(None).unwrap();
        l.tick(T0 + HOUR + DAY);
        assert!(l.open_override().is_err());
        assert!(l.apply_change().is_err());
        assert!(l.config.is_some());
    }

    #[test]
    fn a_pending_override_can_be_cancelled() {
        let mut l = on(100.0, HOUR);
        l.request_override().unwrap();
        l.cancel(What::Override);
        l.tick(T0 + HOUR);
        assert!(l.open_override().is_err());
        l.request_override().unwrap();
        l.tick(T0 + 2 * HOUR);
        l.open_override().unwrap();
        l.cancel(What::Override);
        assert!(l.spend(Some(500.0)).is_err());
    }

    #[test]
    fn override_needs_a_limit() {
        let mut l = Limit::default();
        l.tick(T0);
        assert!(l.request_override().is_err());
    }

    #[test]
    fn turning_on_and_lowering_apply_at_once() {
        let mut l = on(100.0, HOUR);
        assert_eq!(l.config, Some(cfg(100.0, HOUR)));
        l.configure(Some(cfg(50.0, HOUR))).unwrap();
        assert_eq!(l.config, Some(cfg(50.0, HOUR)));
        l.configure(Some(cfg(50.0, DAY))).unwrap();
        assert_eq!(l.config, Some(cfg(50.0, DAY)), "a longer wait is tighter");
        assert!(l.change.is_none());
    }

    #[test]
    fn raising_waits_for_the_delay_and_the_password_step() {
        let mut l = on(100.0, DAY);
        l.configure(Some(cfg(1000.0, DAY))).unwrap();
        assert_eq!(l.config, Some(cfg(100.0, DAY)), "nothing changes yet");
        assert_eq!(l.view().change.unwrap().secs_left, DAY);
        assert!(l.spend(Some(500.0)).is_err());

        l.tick(T0 + DAY - 1);
        assert!(l.apply_change().is_err());
        assert_eq!(l.config, Some(cfg(100.0, DAY)));

        l.tick(T0 + DAY);
        assert_eq!(
            l.config,
            Some(cfg(100.0, DAY)),
            "not without the password step"
        );
        l.apply_change().unwrap();
        assert_eq!(l.config, Some(cfg(1000.0, DAY)));
        assert!(l.change.is_none());
    }

    #[test]
    fn disabling_waits_too_and_clears_any_override() {
        let mut l = on(100.0, HOUR);
        l.request_override().unwrap();
        l.configure(None).unwrap();
        assert!(l.config.is_some());
        assert_eq!(l.view().change.as_ref().unwrap().target, None);
        l.tick(T0 + HOUR);
        l.apply_change().unwrap();
        assert!(l.config.is_none());
        assert!(l.override_ready_at.is_none());
    }

    #[test]
    fn a_shorter_wait_or_a_new_currency_is_a_raise() {
        let mut l = on(100.0, DAY);
        l.configure(Some(cfg(50.0, HOUR))).unwrap();
        assert_eq!(l.config, Some(cfg(100.0, DAY)));
        assert!(l.change.is_some());

        let mut l = on(100.0, DAY);
        l.configure(Some(Config::new(1.0, "JPY".into(), DAY).unwrap()))
            .unwrap();
        assert_eq!(l.config, Some(cfg(100.0, DAY)));
        assert!(l.change.is_some());
    }

    #[test]
    fn the_delay_of_a_raise_is_the_current_one_not_the_requested_one() {
        let mut l = on(100.0, DAY);
        l.configure(Some(cfg(1000.0, HOUR))).unwrap();
        l.tick(T0 + HOUR);
        assert!(l.apply_change().is_err());
    }

    #[test]
    fn asking_again_restarts_the_wait() {
        let mut l = on(100.0, HOUR);
        l.configure(Some(cfg(200.0, HOUR))).unwrap();
        l.tick(T0 + HOUR - 1);
        l.configure(Some(cfg(300.0, HOUR))).unwrap();
        l.tick(T0 + HOUR);
        assert!(l.apply_change().is_err());
    }

    #[test]
    fn tightening_drops_a_pending_raise_and_cancel_keeps_the_limit() {
        let mut l = on(100.0, HOUR);
        l.configure(Some(cfg(1000.0, HOUR))).unwrap();
        l.configure(Some(cfg(50.0, HOUR))).unwrap();
        assert!(l.change.is_none());
        assert_eq!(l.config, Some(cfg(50.0, HOUR)));

        l.configure(None).unwrap();
        l.cancel(What::Change);
        l.tick(T0 + HOUR);
        assert!(l.apply_change().is_err());
        assert!(l.config.is_some());
    }

    #[test]
    fn clock_set_back_keeps_waits_and_the_total() {
        let mut l = on(100.0, DAY);
        l.spend(Some(90.0)).unwrap();
        l.request_override().unwrap();
        l.configure(None).unwrap();

        // Three years back, then the clock runs on from there.
        let back = T0 - 3 * 365 * DAY;
        l.tick(back);
        assert_eq!(l.spent(), 90.0);
        l.tick(back + 2 * HOUR);
        assert_eq!(l.spent(), 90.0);
        assert!(l.open_override().is_err());
        assert!(l.apply_change().is_err());

        // Time really spent after the change still counts, and no more than that.
        assert_eq!(l.view().change.unwrap().secs_left, DAY - 2 * HOUR);
        l.tick(back + DAY);
        assert_eq!(l.spent(), 0.0);
        assert_eq!(l.view().override_state.unwrap().phase, "ready");
    }

    #[test]
    fn time_never_runs_backwards_across_several_jumps() {
        let mut l = on(100.0, DAY);
        let before = l.clock.now;
        for wall in [T0 - 10, T0 - 500, 0, 5, T0 - 1] {
            l.tick(wall);
            assert!(l.clock.now >= before);
        }
        l.spend(Some(1.0)).unwrap();
        let at = l.spends[0].at;
        l.tick(0);
        assert_eq!(l.clock.now, at);
        assert_eq!(l.spent(), 1.0);
    }

    #[test]
    fn a_stale_reading_after_a_restart_only_stretches_the_wait() {
        let dir = temp("restart");
        let path = dir.join("v.spendlimit");
        let mut l = on(100.0, HOUR);
        l.request_override().unwrap();
        l.save(&path).unwrap();

        let mut l = Limit::load(&path);
        l.tick(T0 - DAY);
        l.tick(T0 - DAY + HOUR - 1);
        assert!(l.open_override().is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn unknown_value_is_over_the_limit_with_the_same_override_path() {
        let mut l = on(100.0, HOUR);
        let e = l.spend(None).unwrap_err();
        assert_eq!(e.amount, None);
        assert_eq!(e.spent, 0.0);

        for bad in [f64::NAN, f64::INFINITY, -1.0] {
            assert_eq!(l.spend(Some(bad)).unwrap_err().amount, None);
        }

        l.request_override().unwrap();
        l.tick(T0 + HOUR);
        l.open_override().unwrap();
        l.spend(None).unwrap();
        assert_eq!(l.spent(), 100.0, "counts as the whole limit");
        assert!(l.spend(Some(0.01)).is_err());
    }

    #[test]
    fn each_wallet_and_network_has_its_own_file() {
        let dir = temp("wallets");
        let main = dir
            .join("coffre-mainnet.kyrovault")
            .with_extension("spendlimit");
        let other = dir
            .join("wallets-mainnet")
            .join("w-0123456789abcdef.kyrovault")
            .with_extension("spendlimit");
        let testnet = dir
            .join("coffre-testnet.kyrovault")
            .with_extension("spendlimit");
        fs::create_dir_all(other.parent().unwrap()).unwrap();

        update(&main, |l| l.configure(Some(cfg(100.0, DAY)))).unwrap();
        update(&main, |l| {
            l.spend(Some(99.0)).unwrap();
            Ok(())
        })
        .unwrap();

        assert_eq!(status(&main).spent, 99.0);
        for path in [&other, &testnet] {
            let v = status(path);
            assert!(v.config.is_none(), "{path:?}");
            assert_eq!(v.spent, 0.0);
            update(path, |l| {
                assert!(l.spend(Some(1e9)).is_ok());
                Ok(())
            })
            .unwrap();
        }
        assert_eq!(status(&main).spent, 99.0);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn state_survives_a_restart() {
        let dir = temp("persist");
        let path = dir.join("v.spendlimit");
        update(&path, |l| l.configure(Some(cfg(100.0, HOUR)))).unwrap();
        update(&path, |l| {
            l.spend(Some(70.0)).unwrap();
            l.request_override()
        })
        .unwrap();
        let v = status(&path);
        assert_eq!(v.spent, 70.0);
        assert_eq!(v.override_state.unwrap().phase, "waiting");
        assert!(!dir.join("v.spendlimit.tmp").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failed_step_saves_nothing() {
        let dir = temp("nosave");
        let path = dir.join("v.spendlimit");
        assert!(update(&path, Limit::request_override).is_err());
        assert!(!path.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_broken_file_fails_closed() {
        let dir = temp("broken");
        let path = dir.join("v.spendlimit");
        for bad in [
            "not json",
            "{}",
            r#"{"version":9,"clock":{"now":0,"wall":0},"config":null,"spends":[],"overrideReadyAt":null,"overrideUntil":null,"change":null}"#,
        ] {
            fs::write(&path, bad).unwrap();
            let mut l = Limit::load(&path);
            l.tick(T0);
            assert!(l.spend(Some(0.01)).is_err(), "{bad}");
            assert!(l.spend(None).is_err(), "{bad}");
        }
        // The normal way out still works.
        let mut l = Limit::load(&path);
        l.tick(T0);
        l.request_override().unwrap();
        l.tick(T0 + DAY);
        l.open_override().unwrap();
        l.spend(Some(5.0)).unwrap();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn config_is_checked() {
        assert!(Config::new(0.0, "EUR".into(), DAY).is_err());
        assert!(Config::new(-1.0, "EUR".into(), DAY).is_err());
        assert!(Config::new(f64::NAN, "EUR".into(), DAY).is_err());
        assert!(Config::new(1e16, "EUR".into(), DAY).is_err());
        assert!(Config::new(10.0, "XXX".into(), DAY).is_err());
        assert!(Config::new(10.0, "EUR".into(), 60).is_err());
        assert!(Config::new(10.0, "EUR".into(), HOUR).is_ok());
    }

    #[test]
    fn the_gate_refuses_what_it_cannot_value_for_the_wallet_in_use_only() {
        let dir = temp("gate");
        let state = AppState::new(dir.clone()).unwrap();
        let path = file_of(&state);
        let approve_now = |s: Spend| tauri::async_runtime::block_on(approve(&state, s));
        let refused = |r: AppResult<()>| matches!(r, Err(AppError::SpendLimit(_)));
        let unpriced = || Spend::Coins(vec![Coin::new(None, "5", 0)]);
        let undeclared = || Spend::Undecoded {
            attached: Vec::new(),
            chain: "evm:1".into(),
            payload: "0xnever-declared".into(),
        };

        assert!(approve_now(Spend::Unknown).is_ok(), "off by default");
        assert!(!path.exists());

        update(&path, |l| l.configure(Some(cfg(100.0, HOUR)))).unwrap();
        assert!(refused(approve_now(Spend::Unknown)));
        assert!(refused(approve_now(unpriced())));
        assert!(refused(approve_now(undeclared())));
        assert!(approve_now(Spend::Free).is_ok(), "staking and Earn pass");
        assert_eq!(status(&path).spent, 0.0);

        // Open an override by hand: its wait has passed.
        let mut l = Limit::load(&path);
        l.tick(wall_now());
        l.override_until = Some(l.clock.now + HOUR);
        l.save(&path).unwrap();
        assert!(approve_now(Spend::Unknown).is_ok());
        assert_eq!(status(&path).spent, 100.0, "counts as the whole limit");
        assert!(refused(approve_now(Spend::Unknown)), "one transaction");

        state.activate_wallet("w-0123456789abcdef");
        assert_ne!(file_of(&state), path);
        assert!(approve_now(Spend::Unknown).is_ok(), "another wallet");
        state.activate_wallet(crate::wallets::MAIN);
        assert!(refused(approve_now(Spend::Unknown)));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_declaration_serves_one_signature_of_those_exact_bytes() {
        let coin = || Coin::new(Some("ethereum"), "1", 18);
        let put = |payload: &str| {
            *guard(&DECLARED) = Some(Declared {
                vault: PathBuf::from("a"),
                chain: "evm:1".into(),
                payload: payload.into(),
                coin: coin(),
                at: Instant::now(),
            });
        };
        let a = Path::new("a");
        put("0xaa");
        assert!(take_declared(a, "evm:1", "0xbb").is_none());
        assert!(take_declared(a, "evm:8453", "0xaa").is_none());
        assert!(take_declared(Path::new("b"), "evm:1", "0xaa").is_none());
        assert!(take_declared(a, "evm:1", "0xaa").is_some());
        assert!(take_declared(a, "evm:1", "0xaa").is_none(), "single use");
    }
}
