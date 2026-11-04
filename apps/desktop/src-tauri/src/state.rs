use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
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

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Guard {
    failures: u32,
    retry_after: Option<u64>,
}

/// Recovery phrase of a vault just created, kept only until the user has written it down and passed
/// the 3-word check (`vault_backup_*`).
pub struct PendingBackup {
    pub words: Zeroizing<Vec<String>>,
    /// The wallet has a passphrase. Not the passphrase: it stays in the vault.
    pub has_passphrase: bool,
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
    /// The first wallet's vault file (also locates the data directory).
    pub vault_path: PathBuf,
    /// List of the added wallets (`wallets.rs`).
    pub wallets_path: PathBuf,
    /// The wallet in use: which vault file every password and signature goes to.
    active: Mutex<ActiveVault>,
    /// Changes with the active wallet: an unlock begun on another wallet cannot open a session.
    wallet_epoch: AtomicU64,
    pub settings_path: PathBuf,
    /// Shared with background tasks (Monero scanning).
    pub net: Arc<NetClient>,
    pub env_keys: EnvKeys,
    /// Hardware wallets seen in this session (one lock per device).
    pub hw: HwManager,
    /// Watch-only hardware-wallet accounts (public keys only), next to the vault.
    pub hw_accounts_path: PathBuf,
    /// Serialises read-modify-write of `hw_accounts_path`.
    pub hw_store_lock: Mutex<()>,
    /// Watch addresses (public data only), next to the vault.
    pub watch_path: PathBuf,
    /// Serialises read-modify-write of `watch_path`.
    pub watch_store_lock: Mutex<()>,
    /// Held from the "no vault yet" check until the new vault is written and the session
    /// started (`vault_create` / `vault_import`): two calls can never both create one.
    pub vault_create_lock: tokio::sync::Mutex<()>,
    /// Monero: scan tasks, their status and transfers awaiting signature (`xmr_backend`).
    pub xmr: crate::xmr_backend::XmrManager,
    session: Mutex<Option<Session>>,
    settings: Mutex<Settings>,
    guard: Mutex<Guard>,
    last_reveal: Mutex<Option<Instant>>,
    approved_hosts: Mutex<BTreeSet<String>>,
    picked_cookie: Mutex<Option<String>>,
    pending_backup: Mutex<Option<PendingBackup>>,
}

/// The wallet in use.
struct ActiveVault {
    id: String,
    path: PathBuf,
    attempts_path: PathBuf,
    /// Set while a new wallet is being created: its name and the wallet to go back to.
    creating: Option<(String, String)>,
}

impl ActiveVault {
    fn of(main: &Path, list_path: &Path, id: &str) -> ActiveVault {
        let path = if id == crate::wallets::MAIN {
            main.to_path_buf()
        } else {
            crate::wallets::wallet_vault(list_path, id)
        };
        ActiveVault {
            id: id.to_owned(),
            attempts_path: path.with_extension("attempts"),
            path,
            creating: None,
        }
    }
}

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

    fn wait(&self, now: u64) -> Option<u64> {
        let until = self.retry_after?;
        (until > now).then(|| (until - now).min(MAX_DELAY.as_secs()).max(1))
    }

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
        let (network, network_source) = crate::network::startup(&data_dir);
        let settings_path = data_dir.join("settings.json");
        let vault_path = crate::network::vault_file(&data_dir, network);
        let wallets_path = crate::network::wallets_file(&data_dir, network);
        let last = crate::wallets::WalletList::load(&wallets_path).active;
        let active = ActiveVault::of(&vault_path, &wallets_path, &last);
        let settings = Settings::load(&settings_path, network);
        crate::i18n::apply(settings.language);
        Ok(Self {
            network,
            network_source,
            dialogs: crate::network::DialogCounter::default(),
            guard: Mutex::new(Guard::load(&active.attempts_path)),
            active: Mutex::new(active),
            wallet_epoch: AtomicU64::new(0),
            wallets_path,
            vault_path,
            settings: Mutex::new(settings),
            settings_path,
            net: Arc::new(NetClient::new(data_dir.join("tor"))?),
            env_keys: EnvKeys::from_env(),
            hw: HwManager::default(),
            hw_accounts_path: crate::network::hw_accounts_file(&data_dir, network),
            hw_store_lock: Mutex::new(()),
            watch_path: crate::network::watch_addresses_file(&data_dir, network),
            watch_store_lock: Mutex::new(()),
            vault_create_lock: tokio::sync::Mutex::new(()),
            xmr: crate::xmr_backend::XmrManager::default(),
            session: Mutex::new(None),
            last_reveal: Mutex::new(None),
            approved_hosts: Mutex::new(BTreeSet::new()),
            picked_cookie: Mutex::new(None),
            pending_backup: Mutex::new(None),
        })
    }

    /// App data directory (holds the vault, settings, Tor and CBF state).
    #[cfg_attr(not(feature = "cbf"), allow(dead_code))]
    pub fn data_dir(&self) -> PathBuf {
        self.vault_path
            .parent()
            .map(PathBuf::from)
            .unwrap_or_default()
    }

    /// True when the active wallet has its vault file.
    pub fn vault_exists(&self) -> bool {
        lock(&self.active).path.exists()
    }

    /// True when any wallet needs a password on this device (public data stays behind it, also
    /// while a new wallet is being created).
    pub fn any_vault_exists(&self) -> bool {
        self.vault_path.exists() || self.vault_exists()
    }

    /// Id of the wallet in use.
    pub fn active_wallet(&self) -> String {
        lock(&self.active).id.clone()
    }

    /// Name of the wallet being created, if any.
    pub fn creating_wallet(&self) -> Option<String> {
        lock(&self.active).creating.as_ref().map(|c| c.0.clone())
    }

    /// Value of the wallet epoch, to pass to [`AppState::start_session_for`].
    pub fn wallet_epoch(&self) -> u64 {
        self.wallet_epoch.load(Ordering::SeqCst)
    }

    /// The vault file of the wallet in use.
    pub fn active_vault_path(&self) -> PathBuf {
        lock(&self.active).path.clone()
    }

    /// The password just changed: every secret of the session goes, and an unlock still running
    /// on the old password cannot open one. The next unlock proves the new password.
    pub fn end_session_after_password_change(&self) {
        self.lock_session();
        self.wallet_epoch.fetch_add(1, Ordering::SeqCst);
    }

    /// Ends the session and points every vault operation at wallet `id`, with its own attempts.
    pub fn activate_wallet(&self, id: &str) {
        self.lock_session();
        let next = ActiveVault::of(&self.vault_path, &self.wallets_path, id);
        self.set_active(next);
    }

    fn set_active(&self, next: ActiveVault) {
        *lock(&self.guard) = Guard::load(&next.attempts_path);
        *lock(&self.active) = next;
        self.wallet_epoch.fetch_add(1, Ordering::SeqCst);
    }

    /// Same, for a wallet that has no vault file yet. It joins the list once written.
    pub fn begin_new_wallet(&self, id: &str, name: String) {
        let previous = self.active_wallet();
        self.lock_session();
        let mut next = ActiveVault::of(&self.vault_path, &self.wallets_path, id);
        next.creating = Some((name, previous));
        self.set_active(next);
    }

    /// Back to the wallet the add flow started from.
    pub fn cancel_new_wallet(&self) -> AppResult<()> {
        let previous = lock(&self.active).creating.as_ref().map(|c| c.1.clone());
        match previous {
            Some(p) if !self.vault_exists() => {
                self.activate_wallet(&p);
                Ok(())
            }
            _ => Err(AppError::InvalidInput("no wallet being added".into())),
        }
    }

    /// The new wallet's vault is written: it joins the list and becomes the wallet in use.
    fn finish_new_wallet(&self) -> AppResult<()> {
        let (id, created) = {
            let mut a = lock(&self.active);
            (a.id.clone(), a.creating.take())
        };
        let Some((name, _)) = created else {
            return Ok(());
        };
        let mut list = crate::wallets::WalletList::load(&self.wallets_path);
        list.wallets.push(crate::wallets::WalletEntry {
            id: id.clone(),
            name,
        });
        list.active = id;
        list.save(&self.wallets_path)
    }

    pub fn read_vault(&self) -> AppResult<VaultFile> {
        let path = lock(&self.active).path.clone();
        let raw = fs::read_to_string(&path)
            .map_err(|_| AppError::InvalidInput("no vault on this device".into()))?;
        Ok(serde_json::from_str(&raw)?)
    }

    /// Writes a NEW vault: fails if one already exists (never overwrites).
    pub fn write_new_vault(&self, file: &VaultFile) -> AppResult<()> {
        let path = lock(&self.active).path.clone();
        crate::settings::write_new(&path, serde_json::to_string(file)?.as_bytes())?;
        self.finish_new_wallet()
    }

    pub fn start_session(&self, seed: Seed, cardano: CardanoRoot, polkadot: PolkadotRoot) {
        *lock(&self.session) = Some(Session {
            seed,
            cardano,
            polkadot,
            last_activity: Instant::now(),
        });
    }

    /// Starts the session unless the active wallet changed since `epoch` was read (the keys
    /// would belong to another wallet than the one the app now shows).
    pub fn start_session_for(
        &self,
        epoch: u64,
        seed: Seed,
        cardano: CardanoRoot,
        polkadot: PolkadotRoot,
    ) -> AppResult<()> {
        if self.wallet_epoch() != epoch {
            return Err(AppError::InvalidInput(
                "the wallet changed: unlock it again".into(),
            ));
        }
        self.start_session(seed, cardano, polkadot);
        Ok(())
    }

    pub fn lock_session(&self) {
        *lock(&self.session) = None;
        *lock(&self.pending_backup) = None;
        // Scan tasks stop at their next step (they need the seed); unsigned transfers go.
        self.xmr.on_lock();
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
            let path = lock(&self.active).attempts_path.clone();
            let _ = crate::settings::write_atomic(&path, &json);
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
                "no recovery phrase waiting to be backed up".into(),
            ));
        }
        f(&mut g)
    }

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

    pub fn settings(&self) -> Settings {
        lock(&self.settings).clone()
    }

    /// Saves `new`, keeping the stored account lists (they only change through
    /// [`AppState::update_accounts`], even if `settings_set` raced with it).
    pub fn save_settings(&self, mut new: Settings) -> AppResult<Settings> {
        new.validate()?;
        let mut current = lock(&self.settings);
        new.accounts = current.accounts.clone();
        new.wallet_accounts = current.wallet_accounts.clone();
        new.save(&self.settings_path)?;
        crate::i18n::apply(new.language);
        *current = new.clone();
        Ok(new)
    }

    /// Account lists of the wallet in use.
    pub fn vault_accounts(&self) -> crate::accounts::VaultAccounts {
        lock(&self.settings)
            .accounts_of(&self.active_wallet())
            .clone()
    }

    /// Read-modify-write of the vault's account lists, saved atomically with the settings.
    pub fn update_accounts<T>(
        &self,
        f: impl FnOnce(&mut crate::accounts::VaultAccounts) -> AppResult<T>,
    ) -> AppResult<T> {
        let mut current = lock(&self.settings);
        let mut next = current.clone();
        let id = self.active_wallet();
        let out = f(next.accounts_mut(&id))?;
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
    use crate::wallets::{wallet_vault, wallets_dir, WalletList, MAIN};
    use wallet_core::{seal, KdfParams, Mnemonic};

    const PHRASE_1: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    const PHRASE_2: &str =
        "legal winner thank year wave sausage worth useful legal winner thank yellow";
    const ID: &str = "w-0123456789abcdef";

    fn with_two_wallets(tag: &str) -> (AppState, PathBuf) {
        let dir = std::env::temp_dir().join(format!("kyro-state-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let state = AppState::new(dir.clone()).unwrap();
        let sealed = |p: &str, pw: &str| {
            seal(&Mnemonic::parse(p).unwrap(), pw, KdfParams::minimum()).unwrap()
        };
        state
            .write_new_vault(&sealed(PHRASE_1, "first password"))
            .unwrap();
        fs::create_dir_all(wallets_dir(&state.wallets_path)).unwrap();
        state.begin_new_wallet(ID, "Two".into());
        assert!(!state.vault_exists());
        assert!(state.any_vault_exists());
        assert_eq!(state.creating_wallet().as_deref(), Some("Two"));
        state
            .write_new_vault(&sealed(PHRASE_2, "second password"))
            .unwrap();
        (state, dir)
    }

    fn phrase(state: &AppState, pw: &str) -> Option<String> {
        wallet_core::open(&state.read_vault().unwrap(), pw)
            .ok()
            .map(|m| m.words().join(" "))
    }

    #[test]
    fn each_wallet_opens_its_own_file_and_the_first_is_left_alone() {
        let (state, dir) = with_two_wallets("files");
        let main_bytes = fs::read(&state.vault_path).unwrap();
        assert_eq!(state.creating_wallet(), None);
        assert_eq!(state.active_wallet(), ID);
        assert!(wallet_vault(&state.wallets_path, ID).exists());
        assert_eq!(phrase(&state, "second password").as_deref(), Some(PHRASE_2));
        assert_eq!(phrase(&state, "first password"), None);

        let list = WalletList::load(&state.wallets_path);
        assert_eq!(list.active, ID);
        assert_eq!(list.name_of(ID).as_deref(), Some("Two"));

        state.activate_wallet(MAIN);
        assert_eq!(phrase(&state, "first password").as_deref(), Some(PHRASE_1));
        assert_eq!(fs::read(&state.vault_path).unwrap(), main_bytes);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_new_start_reopens_the_last_wallet() {
        let (state, dir) = with_two_wallets("restart");
        drop(state);
        let again = AppState::new(dir.clone()).unwrap();
        assert_eq!(again.active_wallet(), ID);
        assert_eq!(phrase(&again, "second password").as_deref(), Some(PHRASE_2));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn an_unlock_begun_before_a_switch_cannot_open_a_session() {
        let (state, dir) = with_two_wallets("epoch");
        let m = Mnemonic::parse(PHRASE_2).unwrap();
        let keys = |m: &Mnemonic| {
            (
                m.to_seed(""),
                CardanoRoot::from_mnemonic(m, ""),
                PolkadotRoot::from_mnemonic(m, "").unwrap(),
            )
        };
        let epoch = state.wallet_epoch();
        state.activate_wallet(MAIN);
        let (s, c, p) = keys(&m);
        assert!(state.start_session_for(epoch, s, c, p).is_err());
        assert!(!state.is_unlocked());

        let (s, c, p) = keys(&m);
        state
            .start_session_for(state.wallet_epoch(), s, c, p)
            .unwrap();
        assert!(state.is_unlocked());
        // Switching ends the session: never two seeds, never a seed under another wallet's name.
        state.activate_wallet(ID);
        assert!(!state.is_unlocked());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn attempts_are_counted_per_wallet_and_survive_a_switch() {
        let (state, dir) = with_two_wallets("attempts");
        for _ in 0..FREE_ATTEMPTS {
            state.reserve_attempt().unwrap();
        }
        assert!(matches!(
            state.reserve_attempt(),
            Err(AppError::RateLimited(_))
        ));
        state.activate_wallet(MAIN);
        state.reserve_attempt().unwrap();
        // Going through another wallet does not clear the delay.
        state.activate_wallet(ID);
        assert!(matches!(
            state.reserve_attempt(),
            Err(AppError::RateLimited(_))
        ));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn cancelling_a_new_wallet_leaves_nothing() {
        let (state, dir) = with_two_wallets("cancel");
        state.activate_wallet(MAIN);
        let other = "w-00000000000000ff";
        state.begin_new_wallet(other, "Three".into());
        state.cancel_new_wallet().unwrap();
        assert_eq!(state.active_wallet(), MAIN);
        assert_eq!(state.creating_wallet(), None);
        assert!(!wallet_vault(&state.wallets_path, other).exists());
        assert!(!WalletList::load(&state.wallets_path).knows(other));
        assert!(state.cancel_new_wallet().is_err());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_passphrase_stays_in_its_own_wallet() {
        let dir = std::env::temp_dir().join(format!("kyro-state-pp-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let state = AppState::new(dir.clone()).unwrap();
        let m = |p| Mnemonic::parse(p).unwrap();
        let plain = seal(&m(PHRASE_1), "first password", KdfParams::minimum()).unwrap();
        state.write_new_vault(&plain).unwrap();
        let main_bytes = fs::read(&state.vault_path).unwrap();
        fs::create_dir_all(wallets_dir(&state.wallets_path)).unwrap();
        state.begin_new_wallet(ID, "Two".into());
        let passphrase = Zeroizing::new("25th word".to_owned());
        let secret = wallet_core::WalletSecret::new(m(PHRASE_1), passphrase).unwrap();
        let sealed =
            wallet_core::seal_secret(&secret, "second password", KdfParams::minimum()).unwrap();
        state.write_new_vault(&sealed).unwrap();
        let opened = wallet_core::open(&state.read_vault().unwrap(), "second password").unwrap();
        assert_eq!(opened.passphrase(), "25th word");
        state.activate_wallet(MAIN);
        let opened = wallet_core::open(&state.read_vault().unwrap(), "first password").unwrap();
        assert!(!opened.has_passphrase());
        assert_ne!(&opened.seed()[..], &secret.seed()[..]);
        assert_eq!(fs::read(&state.vault_path).unwrap(), main_bytes);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn changing_a_password_touches_only_the_wallet_in_use() {
        let (state, dir) = with_two_wallets("password");
        let main_bytes = fs::read(&state.vault_path).unwrap();
        let secret = wallet_core::WalletSecret::plain(Mnemonic::parse(PHRASE_2).unwrap());
        let path = state.active_vault_path();
        crate::wallets::rewrite_vault(&path, &secret, "third password", KdfParams::minimum())
            .unwrap();
        assert_eq!(phrase(&state, "third password").as_deref(), Some(PHRASE_2));
        assert_eq!(phrase(&state, "second password"), None);
        assert_eq!(fs::read(&state.vault_path).unwrap(), main_bytes);
        state.activate_wallet(MAIN);
        assert_eq!(phrase(&state, "first password").as_deref(), Some(PHRASE_1));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn after_a_password_change_the_session_is_gone_and_a_late_unlock_is_refused() {
        let (state, dir) = with_two_wallets("relock");
        let m = Mnemonic::parse(PHRASE_2).unwrap();
        let keys = |m: &Mnemonic| {
            (
                m.to_seed(""),
                CardanoRoot::from_mnemonic(m, ""),
                PolkadotRoot::from_mnemonic(m, "").unwrap(),
            )
        };
        let (s, c, p) = keys(&m);
        state.start_session(s, c, p);
        let late = state.wallet_epoch();
        state.end_session_after_password_change();
        assert!(!state.is_unlocked());
        let (s, c, p) = keys(&m);
        assert!(state.start_session_for(late, s, c, p).is_err());
        assert!(!state.is_unlocked());
        // Unlocking again, with the new password, opens a session.
        let (s, c, p) = keys(&m);
        state
            .start_session_for(state.wallet_epoch(), s, c, p)
            .unwrap();
        assert!(state.is_unlocked());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_wrong_current_password_counts_as_an_attempt_and_changes_nothing() {
        let (state, dir) = with_two_wallets("wrong");
        let before = fs::read(state.active_vault_path()).unwrap();
        let wrong = Zeroizing::new("not the password".to_owned());
        let r =
            tauri::async_runtime::block_on(crate::commands::secret_from_password(&state, wrong));
        assert!(r.is_err());
        assert_ne!(*lock(&state.guard), Guard::default());
        assert_eq!(fs::read(state.active_vault_path()).unwrap(), before);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn account_lists_are_per_wallet() {
        let (state, dir) = with_two_wallets("accounts");
        let net = state.network;
        let chain = crate::accounts::Chain::Btc;
        state
            .update_accounts(|a| a.add(net, chain, 3, "Second wallet only"))
            .unwrap();
        assert_eq!(state.vault_accounts().indices(net, chain), vec![0, 3]);
        state.activate_wallet(MAIN);
        assert_eq!(state.vault_accounts().indices(net, chain), vec![0]);
        state.activate_wallet(ID);
        assert_eq!(state.vault_accounts().indices(net, chain), vec![0, 3]);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn attempts_reserved_and_persisted() {
        let mut g = Guard::default();
        let now = 1_000_000;
        for _ in 0..FREE_ATTEMPTS {
            g.reserve(now).unwrap();
        }
        assert!(matches!(g.reserve(now), Err(AppError::RateLimited(30))));
        assert!(g.reserve(now + 31).is_ok());
        assert!(matches!(
            g.reserve(now + 31),
            Err(AppError::RateLimited(60))
        ));
        let json = serde_json::to_string(&g).unwrap();
        let back: Guard = serde_json::from_str(&json).unwrap();
        assert_eq!(back, g);
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
