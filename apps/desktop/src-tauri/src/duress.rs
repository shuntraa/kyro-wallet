//! Optional second password (Settings › Security). Typed on the normal unlock screen, it opens a
//! separate wallet with its own fresh phrase, for when someone forces the user to open Kyro.
//!
//! - The wallet is a vault in the reviewed format, in `profile-<network>/`, kept out of the wallet
//!   list. One per network, reachable from the unlock screen of any wallet.
//! - An unlock tries the wallet's own password, then this vault. Same answer, one attempt on the
//!   wallet's counter. A wrong password costs two KDF runs while the feature is on.
//! - During such a session (`AppState::start_decoy_session`) the active vault, attempts, settings
//!   and every per-device store are that wallet's own, so a command cannot reach the real side,
//!   and nothing it does can change it. The webview keeps its records in a separate scope
//!   (`store_scope`) and reloads when the scope changes, so nothing stays in its memory.
//! - Nothing the session shows may name the feature: this is why the texts say "second password",
//!   and why the settings commands answer there as if the feature were off.
//!
//! This holds against someone in front of the user, not against disk forensics: the code is public
//! and a second vault file exists.

use serde::Serialize;
use tauri::{AppHandle, State};
use wallet_core::{KdfParams, Mnemonic, Network, VaultFile, WalletSecret, WordCount};
use zeroize::Zeroizing;

use crate::commands::{
    blocking, check_password_strength, confirm_native_with, open_counted, reveal_text,
    secret_from_password, show_words,
};
use crate::error::{AppError, AppResult};
use crate::i18n::Lang;
use crate::phrase_window::Passphrase;
use crate::state::AppState;
use crate::wallets::{wallet_vault, WalletList, MAIN};

/// Where the webview keeps the records of that session (`vault_status.storeScope`).
pub fn store_scope(net: Network) -> String {
    format!("p-{}", crate::network::name(net))
}

/// The feature looks off during such a session, so turning it on there has to look like it works.
/// Nothing is written and all of this goes when the session ends.
pub struct Pretended {
    password: Zeroizing<String>,
    words: Zeroizing<Vec<String>>,
}

fn read_decoy(state: &AppState) -> Option<VaultFile> {
    let raw = std::fs::read_to_string(state.decoy_vault_path()).ok()?;
    serde_json::from_str(&raw).ok()
}

fn off() -> AppError {
    AppError::InvalidInput("the second password is off".into())
}

fn already_on() -> AppError {
    AppError::InvalidInput("the second password is already on".into())
}

fn require_session(state: &AppState) -> AppResult<()> {
    if !state.is_unlocked() {
        return Err(AppError::Locked);
    }
    if state.dialogs.any_open() {
        return Err(AppError::InvalidInput(
            "close the confirmation window first".into(),
        ));
    }
    Ok(())
}

/// The wallet's own password first, then the second one. One attempt either way: a wrong password
/// fails once, with the error of the wallet's own vault. A success on the second vault leaves the
/// wallet's counter as it was: it is not a failure, and it must not clear earlier ones.
/// The flag says the second vault opened.
async fn open_for_unlock(
    state: &AppState,
    password: Zeroizing<String>,
) -> AppResult<(WalletSecret, bool)> {
    let file = state.read_vault()?;
    let decoy = if state.in_decoy() {
        None
    } else {
        read_decoy(state)
    };
    let before = state.attempts();
    state.reserve_attempt()?;
    let first = password.clone();
    match blocking(move || Ok(wallet_core::open(&file, &first)?)).await {
        Ok(secret) => {
            state.attempt_succeeded();
            Ok((secret, false))
        }
        Err(AppError::WrongPassword) => {
            let Some(decoy) = decoy else {
                return Err(AppError::WrongPassword);
            };
            match blocking(move || Ok(wallet_core::open(&decoy, &password)?)).await {
                Ok(secret) => {
                    state.restore_attempts(before);
                    Ok((secret, true))
                }
                Err(_) => Err(AppError::WrongPassword),
            }
        }
        Err(e) => Err(e),
    }
}

/// `vault_unlock`: opens the session of whichever vault `password` opens.
pub(crate) async fn unlock(state: &AppState, password: Zeroizing<String>) -> AppResult<()> {
    let epoch = state.wallet_epoch();
    let (secret, decoy) = open_for_unlock(state, password).await?;
    let (seed, cardano, polkadot) = blocking(move || {
        Ok((
            secret.seed(),
            secret.cardano_root(),
            secret.polkadot_root()?,
        ))
    })
    .await?;
    if decoy {
        state.start_decoy_session(epoch, seed, cardano, polkadot)
    } else {
        state.start_session_for(epoch, seed, cardano, polkadot)
    }
}

/// A real wallet with the second password would open itself, not the second wallet. Skipped during
/// such a session: there the answer would prove the second vault is not the only one.
pub(crate) async fn refuse_its_password(
    state: &AppState,
    password: &Zeroizing<String>,
) -> AppResult<()> {
    if state.in_decoy() {
        return Ok(());
    }
    let Some(decoy) = read_decoy(state) else {
        return Ok(());
    };
    let password = password.clone();
    if blocking(move || Ok(wallet_core::open(&decoy, &password)?))
        .await
        .is_ok()
    {
        return Err(reused());
    }
    Ok(())
}

fn reused() -> AppError {
    AppError::InvalidInput("this password cannot be used here, pick another one".into())
}

/// The other real wallets: on their own unlock screen, their password would win.
async fn refuse_other_wallets(state: &AppState, password: &Zeroizing<String>) -> AppResult<()> {
    let list_path = state.wallets_path();
    let list = WalletList::load(&list_path);
    let active = state.active_wallet();
    let mut paths = Vec::new();
    if active != MAIN {
        paths.push(state.vault_path.clone());
    }
    paths.extend(
        list.wallets
            .iter()
            .filter(|w| w.id != active)
            .map(|w| wallet_vault(&list_path, &w.id)),
    );
    for path in paths {
        let Some(file) = std::fs::read_to_string(path)
            .ok()
            .and_then(|raw| serde_json::from_str::<VaultFile>(&raw).ok())
        else {
            continue;
        };
        let password = password.clone();
        if blocking(move || Ok(wallet_core::open(&file, &password)?))
            .await
            .is_ok()
        {
            return Err(reused());
        }
    }
    Ok(())
}

/// Checks both passwords, then writes the new vault with a fresh phrase. Returns its words.
async fn create_decoy(
    state: &AppState,
    current: Zeroizing<String>,
    password: Zeroizing<String>,
    kdf: KdfParams,
) -> AppResult<Zeroizing<Vec<String>>> {
    if read_decoy(state).is_some() {
        return Err(already_on());
    }
    secret_from_password(state, current).await?;
    refuse_other_wallets(state, &password).await?;
    let secret = WalletSecret::plain(Mnemonic::generate(WordCount::W12)?);
    let words = secret.words();
    let file = blocking(move || Ok(wallet_core::seal_secret(&secret, &password, kdf)?)).await?;
    std::fs::create_dir_all(state.decoy_dir())?;
    crate::settings::write_new(
        &state.decoy_vault_path(),
        serde_json::to_string(&file)?.as_bytes(),
    )?;
    Ok(words)
}

/// [`create_decoy`] during such a session: same checks, same phrase window, nothing written.
async fn pretend_create(
    state: &AppState,
    current: Zeroizing<String>,
    password: Zeroizing<String>,
) -> AppResult<Zeroizing<Vec<String>>> {
    if state.with_pretended(|p| p.is_some()) {
        return Err(already_on());
    }
    secret_from_password(state, current).await?;
    let words = Mnemonic::generate(WordCount::W12)?.words();
    state.set_pretended(Some(Pretended {
        password,
        words: words.clone(),
    }));
    Ok(words)
}

/// Removes the vault and everything kept with it.
fn delete_decoy(state: &AppState) -> AppResult<()> {
    match std::fs::remove_dir_all(state.decoy_dir()) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
        _ => Ok(()),
    }
}

fn enabled(state: &AppState) -> bool {
    if state.in_decoy() {
        state.with_pretended(|p| p.is_some())
    } else {
        read_decoy(state).is_some()
    }
}

fn disable_text(lang: Lang) -> &'static str {
    lang.pick(
        "Le portefeuille du second mot de passe sera supprimé de cet appareil.\n\nSes fonds \
         restent sur la blockchain, mais seule sa phrase de récupération y donne accès. Sans \
         elle, ils sont perdus.",
        "The wallet of the second password will be deleted from this device.\n\nIts funds stay on \
         the blockchain, but only its recovery phrase gives access to them. Without it, they are \
         lost.",
    )
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuressStatus {
    enabled: bool,
}

#[tauri::command]
pub fn duress_status(state: State<'_, AppState>) -> AppResult<DuressStatus> {
    if !state.is_unlocked() {
        return Err(AppError::Locked);
    }
    Ok(DuressStatus {
        enabled: enabled(&state),
    })
}

/// Turns it on and shows the new phrase in the phrase window (returns when it is closed).
#[tauri::command]
pub async fn duress_enable(
    app: AppHandle,
    state: State<'_, AppState>,
    current: String,
    password: String,
) -> AppResult<()> {
    let current = Zeroizing::new(current);
    let password = Zeroizing::new(password);
    require_session(&state)?;
    check_password_strength(&password)?;
    if *current == *password {
        return Err(AppError::InvalidInput(
            "the second password must differ from the wallet's password".into(),
        ));
    }
    let _creating = state.vault_create_lock.lock().await;
    let words = if state.in_decoy() {
        pretend_create(&state, current, password).await?
    } else {
        create_decoy(&state, current, password, KdfParams::production()).await?
    };
    show_words(&app, words, Passphrase::None).await
}

/// Shows the phrase of the second wallet again: its password, a native confirmation, the window.
#[tauri::command]
pub async fn duress_show_phrase(
    app: AppHandle,
    state: State<'_, AppState>,
    password: String,
) -> AppResult<()> {
    let password = Zeroizing::new(password);
    require_session(&state)?;
    state.check_reveal_cooldown()?;
    let words = if state.in_decoy() {
        state.with_pretended(|p| match p {
            None => Err(off()),
            Some(p) if *p.password == *password => Ok(p.words.clone()),
            Some(_) => Err(AppError::WrongPassword),
        })?
    } else {
        let file = read_decoy(&state).ok_or_else(off)?;
        open_counted(&state, file, password).await?.words()
    };
    let lang = crate::i18n::current();
    confirm_native_with(
        &app,
        lang.pick(
            "Afficher la phrase de récupération ?",
            "Show the recovery phrase?",
        ),
        reveal_text(lang).into(),
        lang.pick("Afficher", "Show"),
        lang.cancel(),
    )
    .await?;
    show_words(&app, words, Passphrase::None).await?;
    state.touch();
    Ok(())
}

/// Turns it off: the password of the wallet in use, a native warning, then the files go. Returns the
/// store scope the webview can clear (empty: nothing to clear).
#[tauri::command]
pub async fn duress_disable(
    app: AppHandle,
    state: State<'_, AppState>,
    password: String,
) -> AppResult<String> {
    let password = Zeroizing::new(password);
    require_session(&state)?;
    if !enabled(&state) {
        return Err(off());
    }
    let _creating = state.vault_create_lock.lock().await;
    secret_from_password(&state, password).await?;
    let lang = crate::i18n::current();
    confirm_native_with(
        &app,
        lang.pick(
            "Désactiver le second mot de passe ?",
            "Turn off the second password?",
        ),
        disable_text(lang).into(),
        lang.pick("Désactiver", "Turn off"),
        lang.cancel(),
    )
    .await?;
    if state.in_decoy() {
        state.set_pretended(None);
        return Ok(String::new());
    }
    delete_decoy(&state)?;
    Ok(store_scope(state.network))
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use super::*;
    use crate::wallets::wallets_dir;
    use wallet_core::{seal, Mnemonic};

    const PHRASE_1: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    const PHRASE_2: &str =
        "legal winner thank year wave sausage worth useful legal winner thank yellow";
    const FIRST: &str = "first password";
    const SECOND: &str = "second password";
    const COERCED: &str = "the other password";
    const ID: &str = "w-0123456789abcdef";

    fn pw(s: &str) -> Zeroizing<String> {
        Zeroizing::new(s.to_owned())
    }

    fn run<T>(f: impl std::future::Future<Output = T>) -> T {
        tauri::async_runtime::block_on(f)
    }

    /// Two real wallets, the first one active and unlocked, the feature off.
    fn device(tag: &str) -> (AppState, PathBuf) {
        let dir = std::env::temp_dir().join(format!("kyro-duress-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let state = AppState::new(dir.clone()).unwrap();
        let sealed = |p: &str, password: &str| {
            seal(&Mnemonic::parse(p).unwrap(), password, KdfParams::minimum()).unwrap()
        };
        state.write_new_vault(&sealed(PHRASE_1, FIRST)).unwrap();
        fs::create_dir_all(wallets_dir(&state.wallets_path())).unwrap();
        state.begin_new_wallet(ID, "Savings".into());
        state.write_new_vault(&sealed(PHRASE_2, SECOND)).unwrap();
        state.activate_wallet(MAIN);
        let mut list = WalletList::load(&state.wallets_path());
        list.active = MAIN.into();
        list.save(&state.wallets_path()).unwrap();
        run(unlock(&state, pw(FIRST))).unwrap();
        (state, dir)
    }

    /// [`device`] with the feature on, locked.
    fn enabled_device(tag: &str) -> (AppState, PathBuf) {
        let (state, dir) = device(tag);
        run(create_decoy(
            &state,
            pw(FIRST),
            pw(COERCED),
            KdfParams::minimum(),
        ))
        .unwrap();
        state.lock_session();
        (state, dir)
    }

    fn bytes(dir: &std::path::Path, name: &str) -> Option<Vec<u8>> {
        fs::read(dir.join(name)).ok()
    }

    fn seed_of(state: &AppState) -> Vec<u8> {
        state.with_seed(|s| Ok(s.to_vec())).unwrap()
    }

    fn real_seed(phrase: &str) -> Vec<u8> {
        Mnemonic::parse(phrase).unwrap().to_seed("").to_vec()
    }

    fn wrong(state: &AppState, password: &str) -> bool {
        matches!(
            run(unlock(state, pw(password))),
            Err(AppError::WrongPassword)
        )
    }

    #[test]
    fn the_new_vault_stays_out_of_the_list_and_opens_with_its_password() {
        let (state, dir) = enabled_device("create");
        let list = WalletList::load(&state.wallets_path());
        assert_eq!(list.wallets.len(), 1);
        assert!(!fs::read_to_string(state.wallets_path())
            .unwrap()
            .contains("profile"));
        // The reviewed format, nothing else.
        let file: VaultFile =
            serde_json::from_slice(&fs::read(state.decoy_vault_path()).unwrap()).unwrap();
        let opened = wallet_core::open(&file, COERCED).unwrap();
        assert_eq!(opened.words().len(), 12);
        assert_ne!(opened.seed().to_vec(), real_seed(PHRASE_1));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn enabling_takes_the_current_password_and_a_password_no_wallet_uses() {
        let (state, dir) = device("enable");
        let kdf = KdfParams::minimum;
        assert!(matches!(
            run(create_decoy(
                &state,
                pw("not it at all"),
                pw(COERCED),
                kdf()
            )),
            Err(AppError::WrongPassword)
        ));
        assert!(run(create_decoy(&state, pw(FIRST), pw(SECOND), kdf())).is_err());
        assert!(!state.decoy_vault_path().exists());
        run(create_decoy(&state, pw(FIRST), pw(COERCED), kdf())).unwrap();
        assert!(matches!(
            run(create_decoy(
                &state,
                pw(FIRST),
                pw("yet another one"),
                kdf()
            )),
            Err(AppError::InvalidInput(_))
        ));
        assert!(enabled(&state));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_wallets_own_password_comes_first() {
        let (state, dir) = enabled_device("order");
        run(unlock(&state, pw(FIRST))).unwrap();
        assert!(!state.in_decoy());
        assert_eq!(seed_of(&state), real_seed(PHRASE_1));
        state.lock_session();

        // Same password on both vaults, which enabling refuses: the real wallet still wins.
        let m = Mnemonic::parse(PHRASE_2).unwrap();
        let same = seal(&m, FIRST, KdfParams::minimum()).unwrap();
        fs::write(state.decoy_vault_path(), serde_json::to_vec(&same).unwrap()).unwrap();
        run(unlock(&state, pw(FIRST))).unwrap();
        assert!(!state.in_decoy());
        assert_eq!(seed_of(&state), real_seed(PHRASE_1));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn it_works_from_the_unlock_screen_of_any_wallet() {
        let (state, dir) = enabled_device("any");
        run(unlock(&state, pw(COERCED))).unwrap();
        assert!(state.in_decoy());
        let first = seed_of(&state);
        state.lock_session();
        state.activate_wallet(ID);
        run(unlock(&state, pw(COERCED))).unwrap();
        assert!(state.in_decoy());
        assert_eq!(seed_of(&state), first);
        state.lock_session();
        assert_eq!(state.active_wallet(), ID);
        run(unlock(&state, pw(SECOND))).unwrap();
        assert_eq!(seed_of(&state), real_seed(PHRASE_2));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_wrong_password_fails_the_same_way_and_counts_once() {
        let (state, dir) = device("count-off");
        state.lock_session();
        assert!(wrong(&state, "wrong password"));
        let one = state.attempts();
        state.attempt_succeeded();

        run(create_decoy_locked(&state)).unwrap();
        assert!(wrong(&state, "wrong password"));
        assert_eq!(state.attempts(), one);
        for _ in 0..3 {
            assert!(wrong(&state, "wrong password"));
        }
        // The fifth failure starts the delay: both vaults stop being tried.
        assert!(wrong(&state, "wrong password"));
        assert!(matches!(
            run(unlock(&state, pw(COERCED))),
            Err(AppError::RateLimited(_))
        ));
        assert!(!state.is_unlocked());
        fs::remove_dir_all(dir).unwrap();
    }

    async fn create_decoy_locked(state: &AppState) -> AppResult<()> {
        create_decoy(state, pw(FIRST), pw(COERCED), KdfParams::minimum())
            .await
            .map(|_| ())
    }

    #[test]
    fn opening_the_second_wallet_leaves_the_counter_as_it_was() {
        let (state, dir) = enabled_device("count-on");
        assert!(wrong(&state, "wrong password"));
        assert!(wrong(&state, "wrong password"));
        let two = state.attempts();
        let file = fs::read(state.vault_path.with_extension("attempts")).unwrap();
        run(unlock(&state, pw(COERCED))).unwrap();
        state.lock_session();
        assert_eq!(state.attempts(), two);
        assert_eq!(
            fs::read(state.vault_path.with_extension("attempts")).unwrap(),
            file
        );
        for _ in 0..10 {
            run(unlock(&state, pw(COERCED))).unwrap();
            state.lock_session();
        }
        assert_eq!(state.attempts(), two);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_wrong_password_inside_the_session_stays_on_its_side() {
        let (state, dir) = enabled_device("count-side");
        run(unlock(&state, pw(COERCED))).unwrap();
        assert!(run(secret_from_password(&state, pw("wrong password"))).is_err());
        assert!(run(secret_from_password(&state, pw(FIRST))).is_err());
        assert!(run(secret_from_password(&state, pw(COERCED))).is_ok());
        state.lock_session();
        assert_eq!(state.attempts(), Default::default());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_session_looks_like_a_first_wallet_and_the_real_side_does_not_exist() {
        let (state, dir) = enabled_device("view");
        let hw = crate::network::hw_accounts_file(&dir, state.network);
        let watch = crate::network::watch_addresses_file(&dir, state.network);
        let real_watch = r#"{"version":1,"addresses":[]}"#;
        fs::write(&hw, "real accounts").unwrap();
        fs::write(&watch, real_watch).unwrap();
        run(unlock(&state, pw(COERCED))).unwrap();

        let v = serde_json::to_value(crate::wallets::view(&state)).unwrap();
        assert_eq!(v["active"], "main");
        assert_eq!(
            v["wallets"],
            serde_json::json!([{"id": "main", "name": ""}])
        );
        let s = serde_json::to_value(crate::commands::status_of(&state)).unwrap();
        assert_eq!(s["walletId"], "main");
        assert_eq!(s["exists"], true);
        assert_eq!(s["unlocked"], true);
        assert_eq!(s["creating"], serde_json::Value::Null);
        assert!(s["storeScope"].is_string());
        assert!(!enabled(&state));
        assert_ne!(state.hw_accounts_path(), hw);
        assert_ne!(state.watch_path(), watch);
        assert!(!state.hw_accounts_path().exists());
        assert!(!state.watch_path().exists());
        assert_ne!(
            state.ln_store_path(),
            state.vault_path.with_extension("lnswaps")
        );
        assert_ne!(state.side_dir(), state.data_dir());
        assert!(
            crate::commands_watch::load(&state.watch_path(), state.network)
                .unwrap()
                .addresses
                .is_empty()
        );
        for text in [v.to_string(), s.to_string()] {
            let text = text.to_lowercase();
            assert!(
                !text.contains("duress") && !text.contains("decoy"),
                "{text}"
            );
        }
        assert!(crate::wallets::switch(&state, ID.into()).is_err());
        assert!(state.in_decoy());
        assert!(crate::wallets::rename_wallet(&state, ID, "Mine").is_err());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_status_says_nothing_in_a_real_session() {
        let (state, dir) = enabled_device("real-status");
        run(unlock(&state, pw(FIRST))).unwrap();
        let s = serde_json::to_value(crate::commands::status_of(&state)).unwrap();
        assert_eq!(s["storeScope"], serde_json::Value::Null);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_other_network_has_no_wallet_there() {
        let (state, dir) = enabled_device("other-net");
        let other = match state.network {
            Network::Mainnet => Network::Testnet,
            Network::Testnet => Network::Mainnet,
        };
        fs::write(crate::network::vault_file(&dir, other), "{}").unwrap();
        run(unlock(&state, pw(FIRST))).unwrap();
        let real = serde_json::to_value(crate::network::info(&state)).unwrap();
        assert_eq!(real["otherVaultExists"], true);
        state.lock_session();
        run(unlock(&state, pw(COERCED))).unwrap();
        let there = serde_json::to_value(crate::network::info(&state)).unwrap();
        assert_eq!(there["otherVaultExists"], false);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn nothing_the_session_does_reaches_the_real_files() {
        let (state, dir) = enabled_device("writes");
        // Real wallet active is the added one, with its own settings on disk.
        state.activate_wallet(ID);
        let mut list = WalletList::load(&state.wallets_path());
        list.active = ID.into();
        list.main_name = Some("Daily".into());
        list.save(&state.wallets_path()).unwrap();
        run(unlock(&state, pw(SECOND))).unwrap();
        let net = state.network;
        let chain = crate::accounts::Chain::Btc;
        state
            .update_accounts(|a| a.add(net, chain, 4, "Real one"))
            .unwrap();
        let mut real = state.settings();
        real.currency = "USD".into();
        state.save_settings(real).unwrap();
        state.lock_session();
        let names = [
            "settings.json".to_owned(),
            format!("wallets-{}.json", crate::network::name(net)),
            format!("coffre-{}.kyrovault", crate::network::name(net)),
            format!("coffre-{}.attempts", crate::network::name(net)),
        ];
        let before: Vec<_> = names.iter().map(|n| bytes(&dir, n)).collect();

        run(unlock(&state, pw(COERCED))).unwrap();
        assert_eq!(state.vault_accounts().indices(net, chain), vec![0]);
        state
            .update_accounts(|a| a.add(net, chain, 7, "Its own"))
            .unwrap();
        crate::wallets::rename_wallet(&state, MAIN, "Pocket money").unwrap();
        let mut own = state.settings();
        own.currency = "CHF".into();
        own.auto_lock_secs = 300;
        state.save_settings(own).unwrap();
        assert_eq!(state.settings().currency, "CHF");
        let mut store = crate::commands_watch::load(&state.watch_path(), net).unwrap();
        store.addresses.clear();
        crate::commands_watch::save(&state.watch_path(), &store, net).unwrap();
        crate::wallets::switch(&state, MAIN.into()).unwrap();
        assert!(!state.is_unlocked());

        let after: Vec<_> = names.iter().map(|n| bytes(&dir, n)).collect();
        assert_eq!(before, after);
        assert_eq!(state.active_wallet(), ID);
        assert_eq!(WalletList::load(&state.wallets_path()).active, ID);
        assert_eq!(state.settings().currency, "USD");
        assert_eq!(state.vault_accounts().indices(net, chain), vec![0, 4]);

        // Its own accounts and name are there the next time.
        run(unlock(&state, pw(COERCED))).unwrap();
        assert_eq!(state.vault_accounts().indices(net, chain), vec![0, 7]);
        let v = serde_json::to_value(crate::wallets::view(&state)).unwrap();
        assert_eq!(v["wallets"][0]["name"], "Pocket money");
        assert_eq!(state.settings().currency, "USD");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn locking_gives_the_real_side_back_and_both_passwords_still_work() {
        let (state, dir) = enabled_device("lock");
        run(unlock(&state, pw(COERCED))).unwrap();
        let epoch = state.wallet_epoch();
        let m = Mnemonic::parse(PHRASE_2).unwrap();
        // Same path as the auto-lock.
        assert!(state.lock_if_unlocked());
        assert!(!state.in_decoy());
        assert!(!state.is_unlocked());
        let (s, c, p) = (
            m.to_seed(""),
            wallet_core::CardanoRoot::from_mnemonic(&m, ""),
            wallet_core::PolkadotRoot::from_mnemonic(&m, "").unwrap(),
        );
        // An unlock begun before the lock cannot open anything.
        assert!(state.start_session_for(epoch, s, c, p).is_err());
        run(unlock(&state, pw(FIRST))).unwrap();
        assert_eq!(seed_of(&state), real_seed(PHRASE_1));
        state.lock_session();
        run(unlock(&state, pw(COERCED))).unwrap();
        assert!(state.in_decoy());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_new_real_password_keeps_the_second_one_and_cannot_be_the_same() {
        let (state, dir) = enabled_device("password");
        run(unlock(&state, pw(FIRST))).unwrap();
        assert!(matches!(
            run(refuse_its_password(&state, &pw(COERCED))),
            Err(AppError::InvalidInput(_))
        ));
        run(refuse_its_password(&state, &pw("a brand new one"))).unwrap();
        let secret = run(secret_from_password(&state, pw(FIRST))).unwrap();
        crate::wallets::rewrite_vault(
            &state.active_vault_path(),
            &secret,
            "a brand new one",
            KdfParams::minimum(),
        )
        .unwrap();
        state.end_session_after_password_change();
        assert!(wrong(&state, FIRST));
        run(unlock(&state, pw(COERCED))).unwrap();
        assert!(state.in_decoy());
        state.lock_session();
        run(unlock(&state, pw("a brand new one"))).unwrap();
        assert_eq!(seed_of(&state), real_seed(PHRASE_1));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_password_change_inside_the_session_touches_its_vault_and_proves_nothing() {
        let (state, dir) = enabled_device("password-side");
        let real = fs::read(&state.vault_path).unwrap();
        run(unlock(&state, pw(COERCED))).unwrap();
        // The real password gets the same answer as any other: no oracle.
        run(refuse_its_password(&state, &pw(FIRST))).unwrap();
        let secret = run(secret_from_password(&state, pw(COERCED))).unwrap();
        crate::wallets::rewrite_vault(
            &state.active_vault_path(),
            &secret,
            "yet another password",
            KdfParams::minimum(),
        )
        .unwrap();
        state.end_session_after_password_change();
        assert!(!state.in_decoy());
        assert_eq!(fs::read(&state.vault_path).unwrap(), real);
        run(unlock(&state, pw("yet another password"))).unwrap();
        assert!(state.in_decoy());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn removing_a_wallet_changes_nothing_for_it() {
        let (state, dir) = enabled_device("remove");
        let mut list = WalletList::load(&state.wallets_path());
        list.wallets.clear();
        list.save(&state.wallets_path()).unwrap();
        fs::remove_file(wallet_vault(&state.wallets_path(), ID)).unwrap();
        run(unlock(&state, pw(COERCED))).unwrap();
        assert!(state.in_decoy());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn each_network_has_its_own() {
        let (state, dir) = enabled_device("networks");
        let other = match state.network {
            Network::Mainnet => Network::Testnet,
            Network::Testnet => Network::Mainnet,
        };
        assert_ne!(
            crate::network::profile_dir(&dir, state.network),
            crate::network::profile_dir(&dir, other)
        );
        assert_ne!(store_scope(state.network), store_scope(other));
        assert_eq!(
            state.decoy_dir(),
            crate::network::profile_dir(&dir, state.network)
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn turning_it_off_deletes_its_files_and_only_them() {
        let (state, dir) = enabled_device("disable");
        run(unlock(&state, pw(COERCED))).unwrap();
        state
            .update_accounts(|a| a.add(state.network, crate::accounts::Chain::Btc, 2, "Own"))
            .unwrap();
        state.lock_session();
        run(unlock(&state, pw(FIRST))).unwrap();
        let real = fs::read(&state.vault_path).unwrap();
        assert!(enabled(&state));
        delete_decoy(&state).unwrap();
        assert!(!enabled(&state));
        assert!(!state.decoy_dir().exists());
        assert_eq!(fs::read(&state.vault_path).unwrap(), real);
        state.lock_session();
        assert!(wrong(&state, COERCED));
        run(unlock(&state, pw(FIRST))).unwrap();
        // A second run finds nothing to delete, and the wallet can turn it on again.
        delete_decoy(&state).unwrap();
        run(create_decoy_locked(&state)).unwrap();
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn inside_the_session_it_looks_off_and_turning_it_on_writes_nothing() {
        let (state, dir) = enabled_device("pretend");
        run(unlock(&state, pw(COERCED))).unwrap();
        let files = fs::read(state.decoy_vault_path()).unwrap();
        assert!(!enabled(&state));
        assert!(matches!(
            run(pretend_create(
                &state,
                pw("wrong one here"),
                pw("another password")
            )),
            Err(AppError::WrongPassword)
        ));
        let words = run(pretend_create(&state, pw(COERCED), pw("another password"))).unwrap();
        assert_eq!(words.len(), 12);
        assert!(enabled(&state));
        assert!(run(pretend_create(&state, pw(COERCED), pw("another password"))).is_err());
        assert_eq!(fs::read(state.decoy_vault_path()).unwrap(), files);
        state.lock_session();
        assert!(wrong(&state, "another password"));
        run(unlock(&state, pw(COERCED))).unwrap();
        assert!(!enabled(&state));
        assert!(state.decoy_vault_path().exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_broken_second_vault_does_not_get_in_the_way() {
        let (state, dir) = enabled_device("broken");
        fs::write(state.decoy_vault_path(), "not json").unwrap();
        assert!(wrong(&state, COERCED));
        run(unlock(&state, pw(FIRST))).unwrap();
        assert!(!state.in_decoy());
        fs::remove_dir_all(dir).unwrap();
    }
}
