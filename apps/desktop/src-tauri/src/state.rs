use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use wallet_core::{Network, Seed, VaultFile};

use crate::error::{AppError, AppResult};
use crate::net::{EnvKeys, NetClient};
use crate::settings::Settings;

/// Unlocked session. The seed is zeroized when the session is dropped (lock, auto-lock, exit).
pub struct Session {
    pub seed: Seed,
    pub last_activity: Instant,
}

#[derive(Default)]
struct Guard {
    failures: u32,
    retry_after: Option<Instant>,
}

pub struct AppState {
    pub network: Network,
    pub vault_path: PathBuf,
    pub settings_path: PathBuf,
    pub net: NetClient,
    pub env_keys: EnvKeys,
    session: Mutex<Option<Session>>,
    settings: Mutex<Settings>,
    guard: Mutex<Guard>,
    last_reveal: Mutex<Option<Instant>>,
}

/// Free attempts before an increasing delay kicks in.
const FREE_ATTEMPTS: u32 = 5;
const MAX_DELAY: Duration = Duration::from_secs(15 * 60);
const REVEAL_COOLDOWN: Duration = Duration::from_secs(10);

impl AppState {
    pub fn new(data_dir: PathBuf) -> AppResult<Self> {
        let network = match std::env::var("KYRO_NETWORK").as_deref() {
            Ok("mainnet") => Network::Mainnet,
            _ => Network::Testnet,
        };
        let suffix = match network {
            Network::Mainnet => "mainnet",
            Network::Testnet => "testnet",
        };
        let settings_path = data_dir.join("settings.json");
        Ok(Self {
            network,
            vault_path: data_dir.join(format!("coffre-{suffix}.kyrovault")),
            settings: Mutex::new(Settings::load(&settings_path)),
            settings_path,
            net: NetClient::new(data_dir.join("tor"))?,
            env_keys: EnvKeys::from_env(),
            session: Mutex::new(None),
            guard: Mutex::new(Guard::default()),
            last_reveal: Mutex::new(None),
        })
    }

    // ---- vault file ----

    pub fn vault_exists(&self) -> bool {
        self.vault_path.exists()
    }

    pub fn read_vault(&self) -> AppResult<VaultFile> {
        let raw = fs::read_to_string(&self.vault_path)
            .map_err(|_| AppError::InvalidInput("aucun coffre sur cet appareil".into()))?;
        Ok(serde_json::from_str(&raw)?)
    }

    pub fn write_vault(&self, file: &VaultFile) -> AppResult<()> {
        crate::settings::write_atomic(&self.vault_path, serde_json::to_string(file)?.as_bytes())
    }

    // ---- session ----

    pub fn start_session(&self, seed: Seed) {
        *lock(&self.session) = Some(Session {
            seed,
            last_activity: Instant::now(),
        });
    }

    pub fn lock_session(&self) {
        *lock(&self.session) = None;
    }

    pub fn is_unlocked(&self) -> bool {
        lock(&self.session).is_some()
    }

    pub fn touch(&self) {
        if let Some(s) = lock(&self.session).as_mut() {
            s.last_activity = Instant::now();
        }
    }

    /// Runs `f` with the session seed, or fails with `Locked`.
    pub fn with_seed<T>(&self, f: impl FnOnce(&Seed) -> AppResult<T>) -> AppResult<T> {
        let guard = lock(&self.session);
        let session = guard.as_ref().ok_or(AppError::Locked)?;
        f(&session.seed)
    }

    pub fn lock_in_secs(&self) -> Option<u64> {
        let limit = Duration::from_secs(self.settings().auto_lock_secs);
        lock(&self.session)
            .as_ref()
            .map(|s| limit.saturating_sub(s.last_activity.elapsed()).as_secs())
    }

    /// Called by the auto-lock ticker. Returns true if the session was just locked.
    pub fn expire_if_idle(&self) -> bool {
        let limit = Duration::from_secs(self.settings().auto_lock_secs);
        let mut session = lock(&self.session);
        if session
            .as_ref()
            .is_some_and(|s| s.last_activity.elapsed() >= limit)
        {
            *session = None;
            return true;
        }
        false
    }

    // ---- password attempt limiting ----

    pub fn check_attempts(&self) -> AppResult<()> {
        if let Some(until) = lock(&self.guard).retry_after {
            let now = Instant::now();
            if until > now {
                return Err(AppError::RateLimited((until - now).as_secs().max(1)));
            }
        }
        Ok(())
    }

    pub fn record_attempt(&self, ok: bool) {
        let mut g = lock(&self.guard);
        if ok {
            *g = Guard::default();
            return;
        }
        g.failures += 1;
        if g.failures >= FREE_ATTEMPTS {
            let exp = (g.failures - FREE_ATTEMPTS).min(10);
            let delay = Duration::from_secs(30u64 << exp).min(MAX_DELAY);
            g.retry_after = Some(Instant::now() + delay);
        }
    }

    pub fn check_reveal_cooldown(&self) -> AppResult<()> {
        let mut last = lock(&self.last_reveal);
        if let Some(at) = *last {
            if at.elapsed() < REVEAL_COOLDOWN {
                return Err(AppError::RateLimited(
                    (REVEAL_COOLDOWN - at.elapsed()).as_secs().max(1),
                ));
            }
        }
        *last = Some(Instant::now());
        Ok(())
    }

    // ---- settings ----

    pub fn settings(&self) -> Settings {
        lock(&self.settings).clone()
    }

    pub fn save_settings(&self, new: Settings) -> AppResult<Settings> {
        new.validate()?;
        new.save(&self.settings_path)?;
        *lock(&self.settings) = new.clone();
        Ok(new)
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}
