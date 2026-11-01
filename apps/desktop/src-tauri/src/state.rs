use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use wallet_core::{CardanoRoot, Network, PolkadotRoot, Seed, VaultFile, Zeroizing};

use crate::error::{AppError, AppResult};
use crate::hw::HwManager;
use crate::net::{EnvKeys, NetClient};
use crate::settings::Settings;

/// Unlocked session. The seed, the Cardano root key and the Polkadot mini-secret are zeroized when the session is dropped
/// (lock, auto-lock, exit).
pub struct Session {
    pub seed: Seed,
    /// CIP-0003 Icarus root (Cardano derives from the BIP39 *entropy*, not from the seed).
    pub cardano: CardanoRoot,
    /// sr25519 mini-secret (Polkadot also derives from the *entropy*: substrate-bip39).
    pub polkadot: PolkadotRoot,
    pub last_activity: Instant,
}

/// Password attempt counter, persisted next to the vault (`coffre-<réseau>.attempts`) so that
/// restarting the app does not reset the delay.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Guard {
    failures: u32,
    /// Unix seconds before which no attempt is accepted.
    retry_after: Option<u64>,
}

/// Recovery phrase of a vault just created, kept only until the user has written it down and
/// passed the 3-word check (`vault_backup_*`). Never sent to the webview.
pub struct PendingBackup {
    pub words: Zeroizing<Vec<String>>,
    /// The three positions (0-based) the user must type, chosen by Rust.
    pub checks: [usize; 3],
    pub failures: u32,
}

pub struct AppState {
    pub network: Network,
    /// Where `network` comes from (env override, saved choice, build default).
    pub network_source: crate::network::Source,
    /// Native signature dialogs currently open (the network cannot be switched meanwhile).
    pub dialogs: crate::network::DialogCounter,
    pub vault_path: PathBuf,
    pub settings_path: PathBuf,
    pub net: NetClient,
    pub env_keys: EnvKeys,
    /// Hardware wallets seen in this session (one lock per device).
    pub hw: HwManager,
    /// Watch-only hardware-wallet accounts (public keys only), next to the vault.
    pub hw_accounts_path: PathBuf,
    /// Serialises read-modify-write of `hw_accounts_path`.
    pub hw_store_lock: Mutex<()>,
    /// Held from the "no vault yet" check until the new vault is written and the session
    /// started (`vault_create` / `vault_import`): two calls can never both create one.
    pub vault_create_lock: tokio::sync::Mutex<()>,
    attempts_path: PathBuf,
    session: Mutex<Option<Session>>,
    settings: Mutex<Settings>,
    guard: Mutex<Guard>,
    last_reveal: Mutex<Option<Instant>>,
    /// Custom server `host:port` approved in a native dialog during this session.
    approved_hosts: Mutex<BTreeSet<String>>,
    /// Bitcoin Core `.cookie` file chosen in the native file picker (the only new cookie path
    /// `settings_set` / `server_test` accept).
    picked_cookie: Mutex<Option<String>>,
    pending_backup: Mutex<Option<PendingBackup>>,
}

/// Free attempts before an increasing delay kicks in.
const FREE_ATTEMPTS: u32 = 5;
const MAX_DELAY: Duration = Duration::from_secs(15 * 60);
const REVEAL_COOLDOWN: Duration = Duration::from_secs(10);

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

impl Guard {
    fn load(path: &Path) -> Guard {
        fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    /// Seconds to wait before the next attempt, if any. A `retry_after` further away than the
    /// longest delay (clock moved back, file edited) is clamped to that delay.
    fn wait(&self, now: u64) -> Option<u64> {
        let until = self.retry_after?;
        (until > now).then(|| (until - now).min(MAX_DELAY.as_secs()).max(1))
    }

    /// Counts one attempt as failed *before* it runs (it is reset if it succeeds), so parallel
    /// attempts cannot all slip through the same check.
    fn reserve(&mut self, now: u64) -> AppResult<()> {
        if let Some(s) = self.wait(now) {
            return Err(AppError::RateLimited(s));
        }
        self.failures = self.failures.saturating_add(1);
        if self.failures >= FREE_ATTEMPTS {
            let exp = (self.failures - FREE_ATTEMPTS).min(10);
            let delay = Duration::from_secs(30u64 << exp).min(MAX_DELAY);
            self.retry_after = Some(now + delay.as_secs());
        }
        Ok(())
    }
}

impl AppState {
    pub fn new(data_dir: PathBuf) -> AppResult<Self> {
        // Env `KYRO_NETWORK` > saved choice (`network.json`) > build default (network.rs).
        let (network, network_source) = crate::network::startup(&data_dir);
        let settings_path = data_dir.join("settings.json");
        let vault_path = crate::network::vault_file(&data_dir, network);
        let attempts_path = vault_path.with_extension("attempts");
        Ok(Self {
            network,
            network_source,
            dialogs: crate::network::DialogCounter::default(),
            guard: Mutex::new(Guard::load(&attempts_path)),
            attempts_path,
            vault_path,
            settings: Mutex::new(Settings::load(&settings_path, network)),
            settings_path,
            net: NetClient::new(data_dir.join("tor"))?,
            env_keys: EnvKeys::from_env(),
            hw: HwManager::default(),
            hw_accounts_path: crate::network::hw_accounts_file(&data_dir, network),
            hw_store_lock: Mutex::new(()),
            vault_create_lock: tokio::sync::Mutex::new(()),
            session: Mutex::new(None),
            last_reveal: Mutex::new(None),
            approved_hosts: Mutex::new(BTreeSet::new()),
            picked_cookie: Mutex::new(None),
            pending_backup: Mutex::new(None),
        })
    }

    // ---- vault file ----

    /// App data directory (holds the vault, settings, Tor and CBF state).
    #[cfg_attr(not(feature = "cbf"), allow(dead_code))]
    pub fn data_dir(&self) -> PathBuf {
        self.vault_path
            .parent()
            .map(PathBuf::from)
            .unwrap_or_default()
    }

    pub fn vault_exists(&self) -> bool {
        self.vault_path.exists()
    }

    pub fn read_vault(&self) -> AppResult<VaultFile> {
        let raw = fs::read_to_string(&self.vault_path)
            .map_err(|_| AppError::InvalidInput("aucun coffre sur cet appareil".into()))?;
        Ok(serde_json::from_str(&raw)?)
    }

    /// Writes a NEW vault: fails if one already exists (never overwrites). The caller holds
    /// [`AppState::vault_create_lock`].
    pub fn write_new_vault(&self, file: &VaultFile) -> AppResult<()> {
        crate::settings::write_new(&self.vault_path, serde_json::to_string(file)?.as_bytes())
    }

    // ---- session ----

    pub fn start_session(&self, seed: Seed, cardano: CardanoRoot, polkadot: PolkadotRoot) {
        *lock(&self.session) = Some(Session {
            seed,
            cardano,
            polkadot,
            last_activity: Instant::now(),
        });
    }

    pub fn lock_session(&self) {
        *lock(&self.session) = None;
        *lock(&self.pending_backup) = None;
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

    /// Runs `f` with the session's Cardano root key, or fails with `Locked`.
    pub fn with_cardano<T>(&self, f: impl FnOnce(&CardanoRoot) -> AppResult<T>) -> AppResult<T> {
        let guard = lock(&self.session);
        let session = guard.as_ref().ok_or(AppError::Locked)?;
        f(&session.cardano)
    }

    /// Runs `f` with the session's Polkadot root (sr25519 mini-secret), or fails with `Locked`.
    pub fn with_polkadot<T>(&self, f: impl FnOnce(&PolkadotRoot) -> AppResult<T>) -> AppResult<T> {
        let guard = lock(&self.session);
        let session = guard.as_ref().ok_or(AppError::Locked)?;
        f(&session.polkadot)
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
        let expired = lock(&self.session)
            .as_ref()
            .is_some_and(|s| s.last_activity.elapsed() >= limit);
        if expired {
            self.lock_session();
        }
        expired
    }

    /// Locks now (system sleep detected). Returns true if a session was open.
    pub fn lock_if_unlocked(&self) -> bool {
        let was = self.is_unlocked();
        self.lock_session();
        was
    }

    // ---- password attempt limiting ----

    /// Reserves one password attempt under the same lock as the check (the attempt counts as
    /// failed until [`AppState::attempt_succeeded`]) and persists the counter on disk.
    pub fn reserve_attempt(&self) -> AppResult<()> {
        let mut g = lock(&self.guard);
        g.reserve(unix_now())?;
        self.save_guard(&g);
        Ok(())
    }

    pub fn attempt_succeeded(&self) {
        let mut g = lock(&self.guard);
        if *g != Guard::default() {
            *g = Guard::default();
            self.save_guard(&g);
        }
    }

    fn save_guard(&self, g: &Guard) {
        // Best effort: an unwritable data dir must not lock the user out (the in-memory
        // counter still applies).
        if let Ok(json) = serde_json::to_vec(g) {
            let _ = crate::settings::write_atomic(&self.attempts_path, &json);
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

    // ---- recovery phrase backup (vault creation) ----

    pub fn set_pending_backup(&self, b: PendingBackup) {
        *lock(&self.pending_backup) = Some(b);
    }

    /// Runs `f` on the pending backup, or fails if there is none.
    pub fn with_pending_backup<T>(
        &self,
        f: impl FnOnce(&mut Option<PendingBackup>) -> AppResult<T>,
    ) -> AppResult<T> {
        let mut g = lock(&self.pending_backup);
        if g.is_none() {
            return Err(AppError::InvalidInput(
                "aucune phrase de récupération en attente de sauvegarde".into(),
            ));
        }
        f(&mut g)
    }

    // ---- custom servers approved natively ----

    pub fn approved_hosts(&self) -> BTreeSet<String> {
        lock(&self.approved_hosts).clone()
    }

    pub fn approve_hosts(&self, keys: impl IntoIterator<Item = String>) {
        lock(&self.approved_hosts).extend(keys);
    }

    pub fn set_picked_cookie(&self, path: Option<String>) {
        *lock(&self.picked_cookie) = path;
    }

    pub fn picked_cookie(&self) -> Option<String> {
        lock(&self.picked_cookie).clone()
    }

    // ---- settings ----

    pub fn settings(&self) -> Settings {
        lock(&self.settings).clone()
    }

    /// Saves `new`, keeping the stored account lists (they only change through
    /// [`AppState::update_accounts`], even if `settings_set` raced with it).
    pub fn save_settings(&self, mut new: Settings) -> AppResult<Settings> {
        new.validate()?;
        let mut current = lock(&self.settings);
        new.accounts = current.accounts.clone();
        new.save(&self.settings_path)?;
        *current = new.clone();
        Ok(new)
    }

    /// Read-modify-write of the vault's account lists, saved atomically with the settings.
    pub fn update_accounts<T>(
        &self,
        f: impl FnOnce(&mut crate::accounts::VaultAccounts) -> AppResult<T>,
    ) -> AppResult<T> {
        let mut current = lock(&self.settings);
        let mut next = current.clone();
        let out = f(&mut next.accounts)?;
        next.save(&self.settings_path)?;
        *current = next;
        Ok(out)
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// F1: attempts are counted before they run, so N parallel attempts cannot all pass one
    /// check; the delay survives a restart (persisted) and a clock moved back is clamped.
    #[test]
    fn attempts_reserved_and_persisted() {
        let mut g = Guard::default();
        let now = 1_000_000;
        for _ in 0..FREE_ATTEMPTS {
            g.reserve(now).unwrap();
        }
        // The 5th reservation already armed the delay for the 6th, even if 5 run in parallel.
        assert!(matches!(g.reserve(now), Err(AppError::RateLimited(30))));
        assert!(g.reserve(now + 31).is_ok());
        assert!(matches!(
            g.reserve(now + 31),
            Err(AppError::RateLimited(60))
        ));
        // Persisted form round-trips.
        let json = serde_json::to_string(&g).unwrap();
        let back: Guard = serde_json::from_str(&json).unwrap();
        assert_eq!(back, g);
        // Clock moved back by a day: the wait is clamped to the longest delay.
        assert_eq!(g.wait(now - 86_400), Some(MAX_DELAY.as_secs()));

        let dir = std::env::temp_dir().join(format!("kyro-attempts-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let p = dir.join("coffre-testnet.attempts");
        crate::settings::write_atomic(&p, json.as_bytes()).unwrap();
        assert_eq!(Guard::load(&p), g);
        assert_eq!(Guard::load(&dir.join("absent")), Guard::default());
        let _ = fs::remove_dir_all(&dir);
    }
}
