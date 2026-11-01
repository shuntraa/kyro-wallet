//! Every IPC command exposed to the webview (see docs/IPC.md and build.rs).
//! Secrets only flow *into* these functions (passwords, an imported phrase) and never back out:
//! the recovery phrase is only ever displayed in native dialogs (creation, explicit reveal).

use base64::Engine as _;
use serde::Serialize;
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use wallet_core::{
    BtcKind, EvmTxKind, EvmTxRequest, KdfParams, Mnemonic, Network, Seed, UtxoCoin, WordCount,
};
use zeroize::Zeroizing;

use crate::accounts::{account_arg, btc_paths, confirm_signer, Chain, SignerInfo};
use crate::error::{AppError, AppResult};
use crate::i18n::Lang;
use crate::net::{FetchRequest, FetchResponse};
use crate::solana;
use crate::state::{AppState, PendingBackup};
use crate::tor::TorStatus;

const MIN_PASSWORD_LEN: usize = 10;

/// Argon2id and signing are CPU-heavy: keep them off the async runtime's workers.
pub(crate) async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
}

/// Decrypts the vault with `password` (rate-limited) and returns its seed.
pub(crate) async fn seed_from_password(
    state: &AppState,
    password: Zeroizing<String>,
) -> AppResult<Seed> {
    Ok(mnemonic_from_password(state, password).await?.to_seed(""))
}

/// Opens the vault with `password`. The attempt is reserved (counted, persisted) under the
/// same lock as the delay check before Argon2id runs, so parallel calls cannot bypass it.
pub(crate) async fn mnemonic_from_password(
    state: &AppState,
    password: Zeroizing<String>,
) -> AppResult<Mnemonic> {
    let file = state.read_vault()?;
    state.reserve_attempt()?;
    let result = blocking(move || Ok(wallet_core::open(&file, &password)?)).await;
    if result.is_ok() {
        state.attempt_succeeded();
    }
    result
}

/// Cardano Icarus root key re-derived from the vault (signing asks for the password again).
pub(crate) async fn cardano_root_from_password(
    state: &AppState,
    password: Zeroizing<String>,
) -> AppResult<wallet_core::CardanoRoot> {
    let m = mnemonic_from_password(state, password).await?;
    blocking(move || Ok(wallet_core::CardanoRoot::from_mnemonic(&m, ""))).await
}

/// Polkadot sr25519 root re-derived from the vault (signing asks for the password again).
pub(crate) async fn polkadot_root_from_password(
    state: &AppState,
    password: Zeroizing<String>,
) -> AppResult<wallet_core::PolkadotRoot> {
    let m = mnemonic_from_password(state, password).await?;
    blocking(move || Ok(wallet_core::PolkadotRoot::from_mnemonic(&m, "")?)).await
}

/// Native OS dialog — rendered outside the webview, so a compromised UI cannot fake or skip it.
/// Buttons « Signer » / « Annuler » (Sign / Cancel) in the current language.
pub(crate) async fn confirm_native(
    app: &AppHandle,
    title: &'static str,
    body: String,
) -> AppResult<()> {
    let lang = crate::i18n::current();
    confirm_native_with(app, title, body, lang.sign(), lang.cancel()).await
}

/// [`confirm_native`] with its own button labels. `Err(UserRejected)` unless approved.
pub(crate) async fn confirm_native_with(
    app: &AppHandle,
    title: &'static str,
    body: String,
    ok: &'static str,
    cancel: &'static str,
) -> AppResult<()> {
    // Counted while shown: `network_set` (app restart) is refused until it is answered.
    let _open = app.state::<AppState>().dialogs.enter();
    let app = app.clone();
    // Last pass: no bidi / invisible / stray control character from any field can survive.
    let body = crate::dialog_text::body(&body);
    let approved = blocking(move || {
        Ok(app
            .dialog()
            .message(body)
            .title(title)
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                ok.into(),
                cancel.into(),
            ))
            .blocking_show())
    })
    .await?;
    if approved {
        Ok(())
    } else {
        Err(AppError::UserRejected)
    }
}

/// Shows the recovery phrase in a native dialog (one button). The words never reach the
/// webview: a compromised interface cannot read them, even with the password.
async fn show_words_native(app: &AppHandle, words: Zeroizing<Vec<String>>) -> AppResult<()> {
    let _open = app.state::<AppState>().dialogs.enter();
    let app = app.clone();
    let lang = crate::i18n::current();
    blocking(move || {
        let body = words_text(lang, &words);
        app.dialog()
            .message(body.as_str())
            .title(lang.pick("Ta phrase de récupération", "Your recovery phrase"))
            .kind(MessageDialogKind::Info)
            .buttons(MessageDialogButtons::OkCustom(
                lang.pick("J'ai fini de noter", "I have written it down")
                    .into(),
            ))
            .blocking_show();
        Ok(())
    })
    .await
}

/// Text of the native recovery-phrase dialog: numbered words, three per line.
pub(crate) fn words_text(lang: Lang, words: &[String]) -> Zeroizing<String> {
    let mut out = Zeroizing::new(match lang {
        Lang::Fr => format!(
            "Écris ces {} mots sur papier, dans l'ordre, au stylo. Pas de photo, pas de copie, pas \
             de cloud. Quiconque lit ces mots contrôle tes fonds ; personne de légitime ne te les \
             demandera jamais.\n\n",
            words.len()
        ),
        Lang::En => format!(
            "Write these {} words on paper, in order, in pen. No photo, no copy, no cloud. \
             Anyone who reads these words controls your funds; no one legitimate will ever ask \
             you for them.\n\n",
            words.len()
        ),
    });
    for (i, w) in words.iter().enumerate() {
        out.push_str(&format!("{:>2}. {w}", i + 1));
        out.push_str(if i % 3 == 2 { "\n" } else { "      " });
    }
    out.push_str(lang.pick(
        "\nCette fenêtre appartient au système, pas à l'interface de Kyro : vérifie quand même \
         que personne ne regarde ton écran et qu'aucun partage d'écran n'est actif.",
        "\nThis window belongs to the system, not to Kyro's interface: still make sure nobody is \
         watching your screen and that no screen sharing is active.",
    ));
    out
}

fn check_password_strength(password: &str) -> AppResult<()> {
    if password.chars().count() < MIN_PASSWORD_LEN {
        return Err(AppError::InvalidInput(format!(
            "le mot de passe doit faire au moins {MIN_PASSWORD_LEN} caractères"
        )));
    }
    Ok(())
}

// ---------------------------------------------------------------- vault

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    exists: bool,
    unlocked: bool,
    auto_lock_secs: u64,
    lock_in_secs: Option<u64>,
}

#[tauri::command]
pub fn vault_status(state: State<'_, AppState>) -> VaultStatus {
    VaultStatus {
        exists: state.vault_exists(),
        unlocked: state.is_unlocked(),
        auto_lock_secs: state.settings().auto_lock_secs,
        lock_in_secs: state.lock_in_secs(),
    }
}

/// Seals `mnemonic` into a NEW vault and starts the session. The creation lock is held from
/// the existence check until the session is started, and the file is created with
/// `create_new` semantics: two concurrent calls can never both succeed, nor overwrite a vault.
async fn seal_and_start(
    state: &AppState,
    mnemonic: Mnemonic,
    password: Zeroizing<String>,
) -> AppResult<()> {
    check_password_strength(&password)?;
    let _creating = state.vault_create_lock.lock().await;
    if state.vault_exists() {
        return Err(AppError::InvalidInput(
            "un coffre existe déjà sur cet appareil".into(),
        ));
    }
    let seed = mnemonic.to_seed("");
    let cardano = wallet_core::CardanoRoot::from_mnemonic(&mnemonic, "");
    let polkadot = wallet_core::PolkadotRoot::from_mnemonic(&mnemonic, "")?;
    let file = blocking(move || {
        Ok(wallet_core::seal(
            &mnemonic,
            &password,
            KdfParams::production(),
        )?)
    })
    .await?;
    state.write_new_vault(&file)?;
    state.start_session(seed, cardano, polkadot);
    Ok(())
}

/// Three distinct positions in `0..n`, from OS randomness, sorted.
fn random_checks(n: usize) -> AppResult<[usize; 3]> {
    let mut picked: Vec<usize> = Vec::with_capacity(3);
    while picked.len() < 3 {
        let mut b = [0u8; 4];
        getrandom::getrandom(&mut b).map_err(|e| AppError::Internal(e.to_string()))?;
        let i = (u32::from_le_bytes(b) as usize) % n;
        if !picked.contains(&i) {
            picked.push(i);
        }
    }
    picked.sort_unstable();
    Ok([picked[0], picked[1], picked[2]])
}

/// Wrong 3-word checks allowed before the pending phrase is dropped (it can still be shown
/// later from Réglages › Sécurité, with the password and a native confirmation).
const MAX_BACKUP_FAILURES: u32 = 5;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedOut {
    /// 12 or 24. The words themselves are only ever shown natively (`vault_backup_show`).
    word_count: usize,
}

/// Creates the vault and keeps its phrase in Rust until the backup check passes. The phrase is
/// NOT returned: `vault_backup_show` displays it in a native dialog.
#[tauri::command]
pub async fn vault_create(
    state: State<'_, AppState>,
    password: String,
    words: u8,
) -> AppResult<CreatedOut> {
    let password = Zeroizing::new(password);
    let count = match words {
        12 => WordCount::W12,
        24 => WordCount::W24,
        _ => return Err(AppError::InvalidInput("12 ou 24 mots".into())),
    };
    let mnemonic = Mnemonic::generate(count)?;
    let words = mnemonic.words();
    let word_count = words.len();
    seal_and_start(&state, mnemonic, password).await?;
    state.set_pending_backup(PendingBackup {
        checks: random_checks(word_count)?,
        words,
        failures: 0,
    });
    Ok(CreatedOut { word_count })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupChecks {
    /// 0-based positions of the three words to type back.
    checks: [usize; 3],
}

/// Shows the phrase of the vault just created in a native dialog (returns when it is closed),
/// then picks the three positions to check. Only while that phrase is pending.
#[tauri::command]
pub async fn vault_backup_show(
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<BackupChecks> {
    let words = state.with_pending_backup(|p| {
        Ok(p.as_ref()
            .map(|p| Zeroizing::new(p.words.to_vec()))
            .unwrap_or_default())
    })?;
    let n = words.len();
    show_words_native(&app, words).await?;
    let checks = random_checks(n)?;
    state.with_pending_backup(|p| {
        if let Some(p) = p.as_mut() {
            p.checks = checks;
        }
        Ok(())
    })?;
    Ok(BackupChecks { checks })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupVerified {
    ok: bool,
    attempts_left: u32,
}

/// Checks the three words typed by the user against the pending phrase (positions chosen by
/// Rust). Answers only ok / not ok, a few times: not an oracle for guessing the phrase.
fn backup_answers_match(p: &PendingBackup, answers: &[String]) -> bool {
    answers.len() == 3
        && p.checks.iter().zip(answers).all(|(i, a)| {
            p.words
                .get(*i)
                .is_some_and(|w| *w == a.trim().to_lowercase())
        })
}

#[tauri::command]
pub fn vault_backup_verify(
    state: State<'_, AppState>,
    answers: Vec<String>,
) -> AppResult<BackupVerified> {
    let answers = Zeroizing::new(answers);
    state.with_pending_backup(|slot| {
        let Some(p) = slot.as_mut() else {
            return Err(AppError::Internal("sauvegarde absente".into()));
        };
        if backup_answers_match(p, &answers) {
            *slot = None;
            return Ok(BackupVerified {
                ok: true,
                attempts_left: 0,
            });
        }
        p.failures += 1;
        let left = MAX_BACKUP_FAILURES.saturating_sub(p.failures);
        if left == 0 {
            *slot = None;
        }
        Ok(BackupVerified {
            ok: false,
            attempts_left: left,
        })
    })
}

#[tauri::command]
pub async fn vault_import(
    state: State<'_, AppState>,
    password: String,
    phrase: String,
) -> AppResult<()> {
    let password = Zeroizing::new(password);
    let phrase = Zeroizing::new(phrase);
    let mnemonic = Mnemonic::parse(&phrase)?;
    seal_and_start(&state, mnemonic, password).await
}

#[tauri::command]
pub async fn vault_unlock(state: State<'_, AppState>, password: String) -> AppResult<()> {
    let m = mnemonic_from_password(&state, Zeroizing::new(password)).await?;
    let (seed, cardano, polkadot) = blocking(move || {
        Ok((
            m.to_seed(""),
            wallet_core::CardanoRoot::from_mnemonic(&m, ""),
            wallet_core::PolkadotRoot::from_mnemonic(&m, "")?,
        ))
    })
    .await?;
    state.start_session(seed, cardano, polkadot);
    Ok(())
}

#[tauri::command]
pub fn vault_lock(state: State<'_, AppState>) {
    state.lock_session();
}

/// Shows the recovery phrase again: password (rate-limited), then a native confirmation, then
/// the words in a native dialog. Nothing is returned to the webview, which knows the password
/// it typed and so could otherwise read the phrase.
#[tauri::command]
pub async fn vault_reveal_mnemonic(
    app: AppHandle,
    state: State<'_, AppState>,
    password: String,
) -> AppResult<()> {
    if !state.is_unlocked() {
        return Err(AppError::Locked);
    }
    state.check_reveal_cooldown()?;
    let mnemonic = mnemonic_from_password(&state, Zeroizing::new(password)).await?;
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
    show_words_native(&app, mnemonic.words()).await?;
    state.touch();
    Ok(())
}

/// Body of the confirmation before the phrase is shown again.
pub(crate) fn reveal_text(lang: Lang) -> &'static str {
    lang.pick(
        "Kyro va afficher ta phrase de récupération dans une fenêtre du système.\n\nQuiconque la \
         voit peut prendre tous tes fonds. Vérifie que personne ne regarde ton écran et \
         qu'aucun partage d'écran ni logiciel de capture n'est actif.\n\nSi tu n'as pas \
         toi-même demandé à l'afficher, refuse.",
        "Kyro is about to show your recovery phrase in a system window.\n\nAnyone who sees it \
         can take all your funds. Make sure nobody is watching your screen and that no screen \
         sharing or capture software is active.\n\nIf you did not ask to show it yourself, \
         refuse.",
    )
}

#[tauri::command]
pub fn session_touch(state: State<'_, AppState>) {
    state.touch();
}

// ---------------------------------------------------------------- accounts

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BtcAccountOut {
    address: String,
    xpub: String,
    fingerprint: String,
    path: String,
}

#[derive(Serialize)]
pub struct AddressOut {
    address: String,
    /// Derivation path of the key behind `address`.
    path: String,
}

#[derive(Serialize)]
pub struct BtcAccounts {
    segwit: BtcAccountOut,
    taproot: BtcAccountOut,
}

/// Litecoin (BIP84) / Dogecoin, Bitcoin Cash, Dash (BIP44) account: first receive address and
/// public data.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UtxoAccountOut {
    address: String,
    xpub: String,
    fingerprint: String,
    path: String,
}

#[derive(Serialize)]
pub struct Accounts {
    network: &'static str,
    /// Account index these addresses belong to (`accounts_get({ account })`).
    account: u32,
    btc: BtcAccounts,
    evm: AddressOut,
    sol: AddressOut,
    ltc: UtxoAccountOut,
    doge: UtxoAccountOut,
    /// `m/44'/145'/a'` (chipnet `m/44'/1'/a'`), CashAddr.
    bch: UtxoAccountOut,
    /// `m/44'/5'/a'` (testnet `m/44'/1'/a'`).
    dash: UtxoAccountOut,
    /// `m/44'/195'/a'/0/0`.
    tron: AddressOut,
    /// `m/44'/144'/a'/0/0`.
    xrp: AddressOut,
    /// `m/44'/148'/a'` (SEP-0005).
    stellar: AddressOut,
    /// Base address `m/1852'/1815'/a'/0/0` + stake key `…/2/0` (CIP-1852, Icarus).
    cardano: AddressOut,
    /// Implicit account (64 hex of the ed25519 key) `m/44'/397'/a'`.
    near: AddressOut,
    /// `m/44'/784'/a'/0'/0'` (SLIP-10 ed25519).
    sui: AddressOut,
    /// Hedera: EVM address (alias) of the ECDSA key `m/44'/3030'/0'/0/a`.
    hbar: AddressOut,
    /// Receive address `m/44'/111111'/a'/0/0` (change: `…/1/0`).
    kas: AddressOut,
    /// sr25519 (substrate-bip39): the phrase's root key for account 0, `//a` otherwise.
    polkadot: AddressOut,
    /// `m/44'/283'/a'/0/0` (Ledger's Algorand derivation).
    algo: AddressOut,
}

fn utxo_account_out(
    seed: &Seed,
    net: Network,
    coin: UtxoCoin,
    account: u32,
) -> AppResult<UtxoAccountOut> {
    let acc = wallet_core::utxo_account(seed, net, coin, account)?;
    Ok(UtxoAccountOut {
        address: wallet_core::utxo_address(seed, net, coin, account, false, 0)?,
        xpub: acc.xpub,
        fingerprint: acc.fingerprint,
        path: acc.path,
    })
}

pub(crate) fn network_name(n: Network) -> &'static str {
    match n {
        Network::Mainnet => "mainnet",
        Network::Testnet => "testnet",
    }
}

fn btc_account_out(
    seed: &Seed,
    net: Network,
    kind: BtcKind,
    account: u32,
) -> AppResult<BtcAccountOut> {
    let acc = wallet_core::btc_account(seed, net, kind, account)?;
    Ok(BtcAccountOut {
        address: wallet_core::btc_address(seed, net, kind, account, false, 0)?,
        xpub: acc.xpub,
        fingerprint: acc.fingerprint,
        path: acc.path,
    })
}

/// Public data of account `account` (absent = 0) on every chain. Used for the accounts of the
/// user's lists and to preview the next one before adding it (`vault_account_add`).
#[tauri::command]
pub fn accounts_get(state: State<'_, AppState>, account: Option<u32>) -> AppResult<Accounts> {
    let a = account_arg(account)?;
    let net = state.network;
    // Separate lock scope: `with_seed` and `with_cardano` take the same (non-reentrant) mutex.
    let cardano = state.with_cardano(|r| Ok(wallet_core::cardano_address(r, net, a, 0)?))?;
    let polkadot = state.with_polkadot(|r| Ok(wallet_core::dot_address(r, a, net)?))?;
    state.with_seed(|seed| {
        Ok(Accounts {
            network: network_name(net),
            account: a,
            btc: BtcAccounts {
                segwit: btc_account_out(seed, net, BtcKind::Segwit, a)?,
                taproot: btc_account_out(seed, net, BtcKind::Taproot, a)?,
            },
            evm: AddressOut {
                address: wallet_core::evm_address(seed, a)?,
                path: wallet_core::evm_path(a),
            },
            sol: AddressOut {
                address: wallet_core::sol_address(seed, a)?,
                path: wallet_core::sol_path(a),
            },
            ltc: utxo_account_out(seed, net, UtxoCoin::Litecoin, a)?,
            doge: utxo_account_out(seed, net, UtxoCoin::Dogecoin, a)?,
            bch: utxo_account_out(seed, net, UtxoCoin::BitcoinCash, a)?,
            dash: utxo_account_out(seed, net, UtxoCoin::Dash, a)?,
            tron: AddressOut {
                address: wallet_core::tron_address(seed, a)?,
                path: wallet_core::tron_path(a),
            },
            xrp: AddressOut {
                address: wallet_core::xrp_address(seed, a)?,
                path: wallet_core::xrp_path(a),
            },
            stellar: AddressOut {
                address: wallet_core::stellar_address(seed, a)?,
                path: wallet_core::stellar_path(a),
            },
            cardano: AddressOut {
                address: cardano,
                path: format!("{}/0/0", wallet_core::cardano_account_path(a)),
            },
            near: AddressOut {
                address: wallet_core::near_address(seed, a)?,
                path: wallet_core::near_path(a),
            },
            sui: AddressOut {
                address: wallet_core::sui_address(seed, a)?,
                path: wallet_core::sui_path(a),
            },
            hbar: AddressOut {
                address: wallet_core::hbar_evm_address(seed, a)?,
                path: wallet_core::hbar_path(a),
            },
            kas: AddressOut {
                address: wallet_core::kaspa_address(seed, net, a, false, 0)?,
                path: wallet_core::kaspa_path(a, false, 0),
            },
            polkadot: AddressOut {
                address: polkadot,
                path: wallet_core::dot_path(a),
            },
            algo: AddressOut {
                address: wallet_core::algo_address(seed, a)?,
                path: wallet_core::algo_path(a),
            },
        })
    })
}

fn parse_kind(kind: &str) -> AppResult<BtcKind> {
    match kind {
        "segwit" => Ok(BtcKind::Segwit),
        "taproot" => Ok(BtcKind::Taproot),
        _ => Err(AppError::InvalidInput(
            "type d'adresse : segwit ou taproot".into(),
        )),
    }
}

#[tauri::command]
pub fn btc_address(
    state: State<'_, AppState>,
    kind: String,
    change: bool,
    index: u32,
    account: Option<u32>,
) -> AppResult<String> {
    let kind = parse_kind(&kind)?;
    let a = account_arg(account)?;
    let net = state.network;
    state.with_seed(|seed| Ok(wallet_core::btc_address(seed, net, kind, a, change, index)?))
}

// ---------------------------------------------------------------- signing

pub(crate) fn format_units(raw: &str, decimals: usize) -> String {
    let digits = raw.trim_start_matches('0');
    if digits.is_empty() {
        return "0".into();
    }
    let padded = format!("{digits:0>width$}", width = decimals + 1);
    let (int, frac) = padded.split_at(padded.len() - decimals);
    let frac = frac.trim_end_matches('0');
    if frac.is_empty() {
        int.to_string()
    } else {
        format!("{int},{frac}")
    }
}

/// [`format_units`] with the decimal mark of `lang` (« 0,25 » / « 0.25 »), for dialog text.
pub(crate) fn format_units_in(lang: Lang, raw: &str, decimals: usize) -> String {
    lang.decimal(&format_units(raw, decimals))
}

/// Name of an EVM chain for the dialog: Kyro's registry (generated `known_tokens` table).
fn chain_name(lang: Lang, id: u64) -> String {
    match crate::known_tokens::evm_chain(id) {
        Some(c) if c.network == wallet_core::Network::Testnet => format!("{} (testnet)", c.name),
        Some(c) => c.name.into(),
        None => lang.pick(format!("chaîne {id}"), format!("chain {id}")),
    }
}

/// Native coin ticker of an EVM chain (ETH, POL, BNB, CRO, …); « unités natives » if unknown.
pub(crate) fn native_symbol(lang: Lang, id: u64) -> &'static str {
    crate::known_tokens::evm_chain(id).map_or(lang.pick("unités natives", "native units"), |c| {
        c.native_symbol
    })
}

/// Symbol and decimals of a token, from a source Rust trusts: the `known_tokens` table, or a
/// Ledger-signed descriptor verified offline. Never from the interface.
#[derive(Debug, Clone)]
pub(crate) struct TokenLabel {
    pub(crate) symbol: String,
    pub(crate) decimals: u8,
}

impl TokenLabel {
    pub(crate) fn from_known(t: &crate::known_tokens::KnownToken) -> Self {
        Self {
            symbol: t.symbol.to_owned(),
            decimals: t.decimals,
        }
    }
}

/// The token of an ERC-20 transfer/approve, if Kyro knows its contract on this chain.
pub(crate) fn evm_token_label(net: Network, s: &wallet_core::EvmTxSummary) -> Option<TokenLabel> {
    let contract = s.token_contract.as_deref()?;
    crate::known_tokens::lookup(
        net,
        crate::known_tokens::TokenChain::Evm(s.chain_id),
        contract,
    )
    .map(TokenLabel::from_known)
}

/// ERC-20 call on a contract Kyro does not know: the amount can only be shown in raw units.
pub(crate) fn evm_unknown_token(s: &wallet_core::EvmTxSummary, token: Option<&TokenLabel>) -> bool {
    matches!(s.kind, EvmTxKind::Erc20Transfer | EvmTxKind::Erc20Approve) && token.is_none()
}

/// Whether the reinforced dialog is needed: wallet-core's reasons, or an unknown token.
pub(crate) fn evm_needs_extra(s: &wallet_core::EvmTxSummary, token: Option<&TokenLabel>) -> bool {
    s.requires_extra_confirmation || evm_unknown_token(s, token)
}

fn evm_token_amount(lang: Lang, raw: &str, token: Option<&TokenLabel>) -> String {
    match (token, lang) {
        (Some(t), _) => format!(
            "{} {} ({}{raw})",
            format_units_in(lang, raw, t.decimals as usize),
            crate::dialog_text::sanitize(&t.symbol, 16),
            lang.pick("unités brutes : ", "raw units: ")
        ),
        (None, Lang::Fr) => {
            format!("{raw} unités brutes (jeton inconnu : décimales non vérifiées)")
        }
        (None, Lang::En) => format!("{raw} raw units (unknown token: decimals not verified)"),
    }
}

pub(crate) fn describe_evm(
    lang: Lang,
    s: &wallet_core::EvmTxSummary,
    token: Option<&TokenLabel>,
) -> String {
    let native = native_symbol(lang, s.chain_id);
    let units = |raw: &str| format_units_in(lang, raw, 18);
    let unknown = if token.is_none() {
        lang.pick(" (JETON INCONNU)", " (UNKNOWN TOKEN)")
    } else {
        ""
    };
    let contract = s.token_contract.as_deref().unwrap_or("?");
    let mut out = match lang {
        Lang::Fr => format!("Réseau : {}\n\n", chain_name(lang, s.chain_id)),
        Lang::En => format!("Network: {}\n\n", chain_name(lang, s.chain_id)),
    };
    match (s.kind, lang) {
        (EvmTxKind::NativeTransfer, Lang::Fr) => {
            out += &format!("Envoi de {} {native}\nÀ : {}\n", units(&s.amount), s.to);
        }
        (EvmTxKind::NativeTransfer, Lang::En) => {
            out += &format!("Sending {} {native}\nTo: {}\n", units(&s.amount), s.to);
        }
        (EvmTxKind::Erc20Transfer, Lang::Fr) => {
            out += &format!(
                "Envoi de token{unknown} : {}\nContrat du token : {contract}\nÀ : {}\n",
                evm_token_amount(lang, &s.amount, token),
                s.to
            );
        }
        (EvmTxKind::Erc20Transfer, Lang::En) => {
            out += &format!(
                "Token transfer{unknown}: {}\nToken contract: {contract}\nTo: {}\n",
                evm_token_amount(lang, &s.amount, token),
                s.to
            );
        }
        (EvmTxKind::Erc20Approve, _) => {
            let amount = if s.unlimited_approval {
                lang.pick("ILLIMITÉ", "UNLIMITED").to_string()
            } else {
                evm_token_amount(lang, &s.amount, token)
            };
            let spender = s.spender.as_deref().unwrap_or("?");
            out += &match lang {
                Lang::Fr => format!(
                    "AUTORISATION de dépense{unknown}\nContrat du token : {contract}\nBénéficiaire : {spender}\nMontant : {amount}\n"
                ),
                Lang::En => format!(
                    "SPENDING APPROVAL{unknown}\nToken contract: {contract}\nSpender: {spender}\nAmount: {amount}\n"
                ),
            };
            if s.unlimited_approval {
                out += lang.pick(
                    "\n⚠ Ce contrat pourra dépenser TOUS ces tokens, sans limite de temps.\n",
                    "\n⚠ This contract will be able to spend ALL these tokens, with no time limit.\n",
                );
            }
        }
        (EvmTxKind::ContractCall, Lang::Fr) => {
            out += &format!(
                "Appel de contrat : {}\nValeur envoyée : {} {native}\n",
                s.to,
                units(&s.amount)
            );
        }
        (EvmTxKind::ContractCall, Lang::En) => {
            out += &format!(
                "Contract call: {}\nValue sent: {} {native}\n",
                s.to,
                units(&s.amount)
            );
        }
    }
    out += &format!(
        "\n{}{} {native}",
        lang.pick("Frais maximum : ", "Maximum fee: "),
        units(&s.max_fee_wei)
    );
    out
}

/// Reasons for caution of an EVM transaction, one bullet each (reinforced dialog).
pub(crate) fn evm_warning_lines(
    lang: Lang,
    s: &wallet_core::EvmTxSummary,
    token: Option<&TokenLabel>,
) -> String {
    use wallet_core::EvmWarning;
    let native = native_symbol(lang, s.chain_id);
    let units = |raw: &str| format_units_in(lang, raw, 18);
    let contract = s.token_contract.as_deref().unwrap_or("?");
    let mut out = String::new();
    if evm_unknown_token(s, token) {
        out += &match lang {
            Lang::Fr => format!(
                "• jeton INCONNU de Kyro (contrat {contract}) : nom et décimales non vérifiés, montant en unités brutes ; n'importe qui peut créer un jeton qui en imite un vrai\n"
            ),
            Lang::En => format!(
                "• token UNKNOWN to Kyro (contract {contract}): name and decimals not verified, amount in raw units; anyone can create a token that imitates a real one\n"
            ),
        };
    }
    for w in &s.warnings {
        out += &match (w, lang) {
            (EvmWarning::ContractCall, Lang::Fr) => format!(
                "• appel de contrat sur {} : action INCONNUE, Kyro ne décode pas ce qu'elle fait (données de l'appel non vérifiées)\n",
                s.to
            ),
            (EvmWarning::ContractCall, Lang::En) => format!(
                "• contract call on {}: UNKNOWN action, Kyro does not decode what it does (call data not verified)\n",
                s.to
            ),
            (EvmWarning::Approval { spender, amount, unlimited }, _) => {
                let shown = if *unlimited {
                    lang.pick("ILLIMITÉ", "UNLIMITED").to_string()
                } else {
                    evm_token_amount(lang, amount, token)
                };
                match lang {
                    Lang::Fr => format!(
                        "• AUTORISATION : {spender} pourra dépenser {shown} de ce token ({contract}), à tout moment, jusqu'à révocation\n"
                    ),
                    Lang::En => format!(
                        "• APPROVAL: {spender} will be able to spend {shown} of this token ({contract}), at any time, until revoked\n"
                    ),
                }
            }
            (EvmWarning::ValueToContract { value_wei }, Lang::Fr) => format!(
                "• valeur native envoyée au contrat avec l'appel : {} {native}\n",
                units(value_wei)
            ),
            (EvmWarning::ValueToContract { value_wei }, Lang::En) => format!(
                "• native value sent to the contract with the call: {} {native}\n",
                units(value_wei)
            ),
            (EvmWarning::UnknownChain { chain_id }, Lang::Fr) => format!(
                "• réseau INCONNU de Kyro (chainId {chain_id}) : vérifie que c'est bien celui que tu veux\n"
            ),
            (EvmWarning::UnknownChain { chain_id }, Lang::En) => format!(
                "• network UNKNOWN to Kyro (chainId {chain_id}): check that it is the one you want\n"
            ),
            (EvmWarning::HighFee { max_fee_wei }, _) => format!(
                "{}{} {native} ({} {} {native})\n",
                lang.pick("• frais maximum très élevés : ", "• very high maximum fee: "),
                units(max_fee_wei),
                lang.pick("seuil", "threshold"),
                units(&wallet_core::evm_high_fee_threshold_wei(s.chain_id).to_string())
            ),
        };
    }
    out
}

/// Text of the reinforced dialog for EVM transactions signed by the vault.
pub(crate) fn describe_evm_extra(
    lang: Lang,
    s: &wallet_core::EvmTxSummary,
    token: Option<&TokenLabel>,
) -> String {
    format!(
        "{}\n{}\n{}",
        lang.pick(
            "Kyro a trouvé des éléments à vérifier dans cette transaction :",
            "Kyro found elements to check in this transaction:"
        ),
        evm_warning_lines(lang, s, token),
        lang.sign_anyway()
    )
}

#[tauri::command]
pub fn evm_decode_tx(
    state: State<'_, AppState>,
    tx: EvmTxRequest,
) -> AppResult<wallet_core::EvmTxSummary> {
    Ok(wallet_core::evm_decode(&tx, state.network)?)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvmSigned {
    raw_tx: String,
    hash: String,
}

#[tauri::command]
pub async fn evm_sign_tx(
    app: AppHandle,
    state: State<'_, AppState>,
    tx: EvmTxRequest,
    password: String,
    account: Option<u32>,
) -> AppResult<EvmSigned> {
    if !state.is_unlocked() {
        return Err(AppError::Locked);
    }
    let a = account_arg(account)?;
    let summary = wallet_core::evm_decode(&tx, state.network)?;
    // Symbol and decimals come from Rust's own table only (never from the interface).
    let token = evm_token_label(state.network, &summary);
    let from = state.with_seed(|seed| Ok(wallet_core::evm_address(seed, a)?))?;
    let signer = SignerInfo::new(&state, Chain::Evm, a, wallet_core::evm_path(a));
    let seed = seed_from_password(&state, Zeroizing::new(password)).await?;
    let lang = crate::i18n::current();
    confirm_native(
        &app,
        lang.confirm_tx_title(),
        signer.body(
            lang,
            &format!(
                "{}{from}\n{}",
                lang.pick("De : ", "From: "),
                describe_evm(lang, &summary, token.as_ref())
            ),
        ),
    )
    .await?;
    confirm_signer(&app, &signer).await?;
    if evm_needs_extra(&summary, token.as_ref()) {
        confirm_native(
            &app,
            lang.check_tx_title(),
            describe_evm_extra(lang, &summary, token.as_ref()),
        )
        .await?;
    }
    let net = state.network;
    let (raw_tx, hash) =
        blocking(move || Ok(wallet_core::evm_sign_tx(&seed, a, &tx, net)?)).await?;
    state.touch();
    Ok(EvmSigned { raw_tx, hash })
}

pub(crate) fn describe_btc(lang: Lang, s: &wallet_core::BtcTxSummary) -> String {
    let sats = |v: u64| format_units_in(lang, &v.to_string(), 8);
    let mut out = String::from(lang.pick("Envoi Bitcoin\n\n", "Bitcoin send\n\n"));
    for (addr, value, is_change) in &s.outputs {
        out += &match (is_change, lang) {
            (true, Lang::Fr) => format!(
                "Monnaie (revient chez toi) : {} BTC\n  {addr}\n",
                sats(*value)
            ),
            (true, Lang::En) => format!(
                "Change (comes back to you): {} BTC\n  {addr}\n",
                sats(*value)
            ),
            (false, Lang::Fr) => format!("À : {addr}\nMontant : {} BTC\n", sats(*value)),
            (false, Lang::En) => format!("To: {addr}\nAmount: {} BTC\n", sats(*value)),
        };
    }
    out += &format!(
        "\n{}{} BTC ({} sats)",
        lang.pick("Frais : ", "Fee: "),
        sats(s.fee_sats),
        s.fee_sats
    );
    out
}

/// Text of the reinforced dialog for Bitcoin (vault and hardware wallet).
pub(crate) fn describe_btc_extra(lang: Lang, s: &wallet_core::BtcTxSummary) -> String {
    use wallet_core::BtcWarning;
    let mut out = String::from(lang.unusual_intro());
    for w in &s.warnings {
        out += &match (w, lang) {
            (BtcWarning::UnknownScript { output }, Lang::Fr) => format!(
                "• sortie {} : script INCONNU (pas une adresse standard), Kyro ne sait pas qui peut la dépenser\n",
                output + 1
            ),
            (BtcWarning::UnknownScript { output }, Lang::En) => format!(
                "• output {}: UNKNOWN script (not a standard address), Kyro does not know who can spend it\n",
                output + 1
            ),
            (BtcWarning::OpReturn { output }, Lang::Fr) => format!(
                "• sortie {} : OP_RETURN (données inscrites sur la chaîne ; son montant est détruit)\n",
                output + 1
            ),
            (BtcWarning::OpReturn { output }, Lang::En) => format!(
                "• output {}: OP_RETURN (data written on the chain; its amount is destroyed)\n",
                output + 1
            ),
            (BtcWarning::ForeignInput { input }, Lang::Fr) => format!(
                "• entrée {} : n'appartient PAS à ce portefeuille (Kyro ne la signe pas ; quelqu'un d'autre participe à cette transaction)\n",
                input + 1
            ),
            (BtcWarning::ForeignInput { input }, Lang::En) => format!(
                "• input {}: does NOT belong to this wallet (Kyro does not sign it; someone else takes part in this transaction)\n",
                input + 1
            ),
            (BtcWarning::HighFee { sat_per_vb }, Lang::Fr) => format!(
                "• frais très élevés : ≈ {sat_per_vb} sat/vB (seuil {} sat/vB), ou plus que tous les montants envoyés\n",
                wallet_core::BTC_HIGH_FEE_SAT_PER_VB
            ),
            (BtcWarning::HighFee { sat_per_vb }, Lang::En) => format!(
                "• very high fee: ≈ {sat_per_vb} sat/vB (threshold {} sat/vB), or more than all the amounts sent\n",
                wallet_core::BTC_HIGH_FEE_SAT_PER_VB
            ),
            (BtcWarning::ChangeIndexOutOfRange { output }, Lang::Fr) => format!(
                "• sortie {} : une de tes clés, mais à un index d'adresse anormalement élevé (affichée comme un paiement, pas comme ta monnaie)\n",
                output + 1
            ),
            (BtcWarning::ChangeIndexOutOfRange { output }, Lang::En) => format!(
                "• output {}: one of your keys, but at an abnormally high address index (shown as a payment, not as your change)\n",
                output + 1
            ),
        };
    }
    out += "\n";
    out += lang.sign_anyway();
    out
}

#[derive(Serialize)]
pub struct BtcSigned {
    psbt: String,
    summary: wallet_core::BtcTxSummary,
}

#[tauri::command]
pub async fn btc_sign_psbt(
    app: AppHandle,
    state: State<'_, AppState>,
    psbt: String,
    password: String,
    account: Option<u32>,
) -> AppResult<BtcSigned> {
    if !state.is_unlocked() {
        return Err(AppError::Locked);
    }
    let a = account_arg(account)?;
    let net = state.network;
    let signer = SignerInfo::new(&state, Chain::Btc, a, btc_paths(net, a));
    let seed = seed_from_password(&state, Zeroizing::new(password)).await?;
    // Same summary as the signature computes (change and own inputs by key origin, in this
    // account only: the other accounts' inputs are foreign and stay unsigned).
    let (s, p) = (seed.clone(), psbt.clone());
    let summary = blocking(move || Ok(wallet_core::btc_psbt_summary(&s, net, a, &p)?)).await?;
    let lang = crate::i18n::current();
    confirm_native(
        &app,
        lang.confirm_tx_title(),
        signer.body(lang, &describe_btc(lang, &summary)),
    )
    .await?;
    confirm_signer(&app, &signer).await?;
    if summary.requires_extra_confirmation {
        confirm_native(
            &app,
            lang.check_tx_title(),
            describe_btc_extra(lang, &summary),
        )
        .await?;
    }
    let (signed, again) =
        blocking(move || Ok(wallet_core::btc_sign_psbt(&seed, net, a, &psbt)?)).await?;
    if again != summary {
        return Err(AppError::Internal(
            "résumé différent entre l'aperçu et la signature".into(),
        ));
    }
    state.touch();
    Ok(BtcSigned {
        psbt: signed,
        summary,
    })
}

/// Our Solana address of `account` from the unlocked session.
fn sol_own_address(state: &AppState, account: u32) -> AppResult<String> {
    state.with_seed(|seed| Ok(wallet_core::sol_address(seed, account)?))
}

/// Preview for the UI: decoded in Rust, lookup tables fetched by the shell.
#[tauri::command]
pub async fn sol_decode_tx(
    state: State<'_, AppState>,
    message: String,
    account: Option<u32>,
) -> AppResult<wallet_core::SolTxSummary> {
    let bytes = solana::message_bytes(&message)?;
    let me = sol_own_address(&state, account_arg(account)?)?;
    Ok(solana::decode(&state, &bytes, &me).await?.summary)
}

#[derive(Serialize)]
pub struct SolSigned {
    signature: String,
    summary: wallet_core::SolTxSummary,
}

#[tauri::command]
pub async fn sol_sign_tx(
    app: AppHandle,
    state: State<'_, AppState>,
    message: String,
    password: String,
    account: Option<u32>,
) -> AppResult<SolSigned> {
    if !state.is_unlocked() {
        return Err(AppError::Locked);
    }
    let a = account_arg(account)?;
    let bytes = solana::message_bytes(&message)?;
    let me = sol_own_address(&state, a)?;
    let signer = SignerInfo::new(&state, Chain::Sol, a, wallet_core::sol_path(a));
    // Decoded (and lookup tables resolved) in Rust only — nothing from the UI is trusted.
    let decoded = solana::decode(&state, &bytes, &me).await?;
    let summary = decoded.summary.clone();
    if summary.our_signer_index.is_none() {
        return Err(AppError::InvalidInput(
            "cette transaction ne demande pas la signature de ton adresse Solana".into(),
        ));
    }
    let seed = seed_from_password(&state, Zeroizing::new(password)).await?;
    let lang = crate::i18n::current();
    confirm_native(
        &app,
        lang.pick(
            "Confirmer la transaction Solana",
            "Confirm the Solana transaction",
        ),
        signer.body(lang, &solana::describe(lang, &decoded, &me, state.network)),
    )
    .await?;
    confirm_signer(&app, &signer).await?;
    if summary.requires_extra_confirmation {
        confirm_native(
            &app,
            lang.pick(
                "Attention : transaction non vérifiée",
                "Warning: unverified transaction",
            ),
            solana::describe_extra(lang, &decoded),
        )
        .await?;
    }
    let sig = blocking(move || Ok(wallet_core::sol_sign_message(&seed, a, &bytes)?)).await?;
    state.touch();
    Ok(SolSigned {
        signature: base64::engine::general_purpose::STANDARD.encode(sig),
        summary,
    })
}

// ---------------------------------------------------------------- network & settings

#[tauri::command]
pub async fn net_fetch(state: State<'_, AppState>, req: FetchRequest) -> AppResult<FetchResponse> {
    let settings = state.settings();
    state
        .net
        .fetch(req, &settings, &state.env_keys, state.network)
        .await
}

#[tauri::command]
pub fn tor_status(state: State<'_, AppState>) -> TorStatus {
    state.net.tor.status()
}

/// Restarts the Tor bootstrap (after an error). Refused when Tor is disabled in settings.
#[tauri::command]
pub fn tor_retry(state: State<'_, AppState>) -> AppResult<TorStatus> {
    if !state.settings().tor.enabled {
        return Err(AppError::InvalidInput(
            "Tor est désactivé dans les réglages".into(),
        ));
    }
    state.net.tor.restart();
    Ok(state.net.tor.status())
}

#[tauri::command]
pub fn set_capture_protection(window: WebviewWindow, enabled: bool) -> AppResult<()> {
    window.set_content_protected(enabled)?;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigOut {
    network: &'static str,
    has_zerox_key: bool,
    has_coingecko_key: bool,
    has_trongrid_key: bool,
    /// The computer's language (`fr` | `en`): what `settings.language = auto` means.
    system_language: crate::i18n::Lang,
}

#[tauri::command]
pub fn config_get(state: State<'_, AppState>) -> ConfigOut {
    let s = state.settings();
    let env = &state.env_keys;
    ConfigOut {
        network: network_name(state.network),
        has_zerox_key: env.zerox.is_some() || s.api_keys.zerox.is_some(),
        has_coingecko_key: env.coingecko.is_some() || s.api_keys.coingecko.is_some(),
        has_trongrid_key: env.trongrid.is_some() || s.api_keys.trongrid.is_some(),
        system_language: crate::i18n::system(),
    }
}

/// Re-exported for the window-close hook in lib.rs.
pub fn lock_on_exit(app: &AppHandle) {
    app.state::<AppState>().lock_session();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn evm_reinforced_dialog_text() {
        let tx = |data: &str, chain_id: u64, value: &str| EvmTxRequest {
            chain_id,
            nonce: 0,
            to: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238".into(),
            value_wei: value.into(),
            data: data.into(),
            gas_limit: 60_000,
            max_fee_per_gas: "2000000000".into(),
            max_priority_fee_per_gas: "1000000000".into(),
        };
        let spender = "9858effd232b4033e47d90003d41ec34ecaeda94";
        let max = format!("0x095ea7b3{:0>64}{}", spender, "f".repeat(64));
        let net = wallet_core::Network::Testnet;
        let s = wallet_core::evm_decode(&tx(&max, 11_155_111, "0"), net).unwrap();
        assert!(s.requires_extra_confirmation);
        let d = describe_evm_extra(Lang::Fr, &s, None);
        assert!(d.contains("AUTORISATION : 0x9858EfFD232B4033E47d90003D41EC34EcaEda94 pourra dépenser ILLIMITÉ"), "{d}");
        let exact = format!("0x095ea7b3{:0>64}{:0>64}", spender, "f4240");
        let s = wallet_core::evm_decode(&tx(&exact, 11_155_111, "0"), net).unwrap();
        // The token is named from Rust's table (Sepolia test USDC), never from the interface.
        let token = evm_token_label(Network::Testnet, &s);
        assert!(token.is_some());
        assert!(describe_evm_extra(Lang::Fr, &s, token.as_ref())
            .contains("dépenser 1 USDC (unités brutes : 1000000)"));
        // Same contract on mainnet chain id 1: not a known token there.
        let s1 = wallet_core::evm_decode(&tx(&exact, 1, "0"), Network::Mainnet).unwrap();
        assert!(evm_token_label(Network::Mainnet, &s1).is_none());
        // 31337 (a local devnet): unknown to Kyro.
        let s =
            wallet_core::evm_decode(&tx("0xdeadbeef", 31_337, "1000000000000000000"), net).unwrap();
        let d = describe_evm_extra(Lang::Fr, &s, None);
        for needle in [
            "action INCONNUE",
            "valeur native envoyée au contrat avec l'appel : 1 unités natives",
            "réseau INCONNU de Kyro (chainId 31337)",
        ] {
            assert!(d.contains(needle), "{needle} in {d}");
        }
        // 424242: unknown as well, on either network.
        let s = wallet_core::evm_decode(&tx("0xdeadbeef", 424_242, "0"), Network::Mainnet).unwrap();
        assert!(describe_evm_extra(Lang::Fr, &s, None)
            .contains("réseau INCONNU de Kyro (chainId 424242)"));
        let s = wallet_core::evm_decode(
            &tx("0xdeadbeef", 1, "1000000000000000000"),
            Network::Mainnet,
        )
        .unwrap();
        assert!(describe_evm_extra(Lang::Fr, &s, None)
            .contains("valeur native envoyée au contrat avec l'appel : 1 ETH"));
    }

    #[test]
    fn evm_dialog_names_the_chain_and_its_native_coin() {
        let tx = EvmTxRequest {
            chain_id: 25,
            nonce: 0,
            to: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238".into(),
            value_wei: "1500000000000000000".into(),
            data: "0x".into(),
            gas_limit: 21_000,
            max_fee_per_gas: "1000000000000".into(),
            max_priority_fee_per_gas: "1000000000".into(),
        };
        let s = wallet_core::evm_decode(&tx, Network::Mainnet).unwrap();
        assert!(!s.requires_extra_confirmation, "{:?}", s.warnings);
        let d = describe_evm(Lang::Fr, &s, None);
        for needle in [
            "Réseau : Cronos",
            "Envoi de 1,5 CRO",
            "Frais maximum : 0,021 CRO",
        ] {
            assert!(d.contains(needle), "{needle} in {d}");
        }
        let s = wallet_core::evm_decode(
            &EvmTxRequest {
                chain_id: 11_155_111,
                ..tx
            },
            Network::Testnet,
        )
        .unwrap();
        assert!(describe_evm(Lang::Fr, &s, None).contains("Réseau : Ethereum Sepolia (testnet)"));
        assert_eq!(native_symbol(Lang::Fr, 137), "POL");
        assert_eq!(native_symbol(Lang::Fr, 424_242), "unités natives");
    }

    /// ÉLEVÉE 2: an ERC-20 transfer on a contract Kyro does not know is labelled « jeton
    /// inconnu », shown in raw units, and needs the reinforced dialog even though wallet-core
    /// sees a plain transfer.
    #[test]
    fn unknown_erc20_is_raw_and_reinforced() {
        let to = "9858effd232b4033e47d90003d41ec34ecaeda94";
        let data = format!("0xa9059cbb{:0>64}{:0>64}", to, "f4240");
        let tx = |contract: &str, chain_id: u64| EvmTxRequest {
            chain_id,
            nonce: 0,
            to: contract.into(),
            value_wei: "0".into(),
            data: data.clone(),
            gas_limit: 60_000,
            max_fee_per_gas: "2000000000".into(),
            max_priority_fee_per_gas: "1000000000".into(),
        };
        // Fake token contract on mainnet.
        let s = wallet_core::evm_decode(
            &tx("0x00000000000000000000000000000000DeaDBeef", 1),
            Network::Mainnet,
        )
        .unwrap();
        assert_eq!(s.kind, EvmTxKind::Erc20Transfer);
        assert!(!s.requires_extra_confirmation);
        let token = evm_token_label(Network::Mainnet, &s);
        assert!(token.is_none());
        assert!(evm_needs_extra(&s, token.as_ref()));
        let d = describe_evm(Lang::Fr, &s, None);
        assert!(
            d.contains("Envoi de token (JETON INCONNU) : 1000000 unités brutes"),
            "{d}"
        );
        assert!(describe_evm_extra(Lang::Fr, &s, None).contains("jeton INCONNU de Kyro"));
        // Real USDC on mainnet: named by Rust, 6 decimals, no extra dialog.
        let s = wallet_core::evm_decode(
            &tx("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", 1),
            Network::Mainnet,
        )
        .unwrap();
        let token = evm_token_label(Network::Mainnet, &s);
        assert!(!evm_needs_extra(&s, token.as_ref()));
        assert!(describe_evm(Lang::Fr, &s, token.as_ref())
            .contains("Envoi de token : 1 USDC (unités brutes : 1000000)"));
        // Polygon: native currency is POL, not ETH.
        let native = wallet_core::evm_decode(
            &EvmTxRequest {
                data: "0x".into(),
                value_wei: "1000000000000000000".into(),
                ..tx("0x9858EfFD232B4033E47d90003D41EC34EcaEda94", 137)
            },
            Network::Mainnet,
        )
        .unwrap();
        assert!(describe_evm(Lang::Fr, &native, None).contains("Envoi de 1 POL"));
    }

    #[test]
    fn btc_reinforced_dialog_text() {
        let s = wallet_core::BtcTxSummary {
            outputs: vec![],
            fee_sats: 30_000,
            warnings: vec![
                wallet_core::BtcWarning::UnknownScript { output: 0 },
                wallet_core::BtcWarning::ForeignInput { input: 1 },
                wallet_core::BtcWarning::HighFee { sat_per_vb: 212 },
            ],
            requires_extra_confirmation: true,
        };
        let d = describe_btc_extra(Lang::Fr, &s);
        for needle in [
            "sortie 1 : script INCONNU",
            "entrée 2 : n'appartient PAS",
            "≈ 212 sat/vB (seuil 100 sat/vB)",
        ] {
            assert!(d.contains(needle), "{needle} in {d}");
        }
    }

    #[test]
    fn evm_and_btc_dialogs_in_english() {
        let tx = |data: &str, chain_id: u64, to: &str, value: &str| EvmTxRequest {
            chain_id,
            nonce: 0,
            to: to.into(),
            value_wei: value.into(),
            data: data.into(),
            gas_limit: 60_000,
            max_fee_per_gas: "2000000000".into(),
            max_priority_fee_per_gas: "1000000000".into(),
        };
        let spender = "9858effd232b4033e47d90003d41ec34ecaeda94";
        let max = format!("0x095ea7b3{:0>64}{}", spender, "f".repeat(64));
        let usdc = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
        let s =
            wallet_core::evm_decode(&tx(&max, 11_155_111, usdc, "0"), Network::Testnet).unwrap();
        let d = describe_evm(Lang::En, &s, None);
        assert!(d.starts_with("Network: Ethereum Sepolia (testnet)"), "{d}");
        assert!(d.contains("SPENDING APPROVAL (UNKNOWN TOKEN)") && d.contains("Amount: UNLIMITED"));
        assert!(d.contains("will be able to spend ALL these tokens, with no time limit"));
        assert!(d.contains("Maximum fee: 0.00012 ETH"), "{d}");
        let x = describe_evm_extra(Lang::En, &s, None);
        assert!(x.contains(
            "APPROVAL: 0x9858EfFD232B4033E47d90003D41EC34EcaEda94 will be able to spend UNLIMITED"
        ));
        assert!(x.ends_with("Only sign if you know exactly why. Sign anyway?"));
        let native = wallet_core::evm_decode(
            &tx(
                "0x",
                137,
                "0x9858EfFD232B4033E47d90003D41EC34EcaEda94",
                "1500000000000000000",
            ),
            Network::Mainnet,
        )
        .unwrap();
        let n = describe_evm(Lang::En, &native, None);
        assert!(n.contains("Sending 1.5 POL\nTo: 0x9858"), "{n}");
        let call = wallet_core::evm_decode(
            &tx("0xdeadbeef", 31_337, usdc, "1000000000000000000"),
            Network::Testnet,
        )
        .unwrap();
        let c = describe_evm_extra(Lang::En, &call, None);
        for needle in [
            "UNKNOWN action",
            "native value sent to the contract with the call: 1 native units",
            "network UNKNOWN to Kyro (chainId 31337)",
        ] {
            assert!(c.contains(needle), "{needle} in {c}");
        }
        for fr in [
            "Réseau",
            "Montant",
            "Frais",
            "AUTORISATION",
            "ILLIMITÉ",
            "Signer",
            "chaîne",
        ] {
            assert!(![&d, &x, &n, &c].iter().any(|t| t.contains(fr)), "{fr}");
        }

        let b = wallet_core::BtcTxSummary {
            outputs: vec![
                ("tb1qdest".into(), 150_000, false),
                ("tb1qchange".into(), 20_000, true),
            ],
            fee_sats: 30_000,
            warnings: vec![
                wallet_core::BtcWarning::UnknownScript { output: 0 },
                wallet_core::BtcWarning::ForeignInput { input: 1 },
                wallet_core::BtcWarning::HighFee { sat_per_vb: 212 },
            ],
            requires_extra_confirmation: true,
        };
        let d = describe_btc(Lang::En, &b);
        assert!(d.contains("To: tb1qdest\nAmount: 0.0015 BTC"), "{d}");
        assert!(d.contains("Change (comes back to you): 0.0002 BTC"));
        assert!(d.ends_with("Fee: 0.0003 BTC (30000 sats)"));
        let x = describe_btc_extra(Lang::En, &b);
        for needle in [
            "output 1: UNKNOWN script",
            "input 2: does NOT belong",
            "≈ 212 sat/vB (threshold 100 sat/vB)",
            "Sign anyway?",
        ] {
            assert!(x.contains(needle), "{needle} in {x}");
        }
        assert!(describe_btc(Lang::Fr, &b).contains("À : tb1qdest\nMontant : 0,0015 BTC"));
    }

    #[test]
    fn phrase_texts_in_english() {
        let words: Vec<String> = (1..=12).map(|i| format!("word{i}")).collect();
        let t = words_text(Lang::En, &words);
        assert!(t.starts_with("Write these 12 words on paper, in order, in pen."));
        assert!(t.contains("no one legitimate will ever ask you for them"));
        assert!(t.contains(" 1. word1") && t.contains("12. word12"));
        assert!(t.contains("This window belongs to the system"));
        assert!(!t.contains("mots") && !t.contains("Écris"));
        assert!(reveal_text(Lang::En).contains("Anyone who sees it can take all your funds"));
        assert!(reveal_text(Lang::En).ends_with("refuse."));
        assert!(reveal_text(Lang::Fr).contains("Quiconque la voit peut prendre tous tes fonds"));
        assert_eq!(format_units_in(Lang::En, "250000000000000000", 18), "0.25");
        assert_eq!(format_units_in(Lang::Fr, "250000000000000000", 18), "0,25");
    }

    #[test]
    fn units() {
        assert_eq!(format_units("0", 18), "0");
        assert_eq!(format_units("250000000000000000", 18), "0,25");
        assert_eq!(format_units("1000000", 6), "1");
        assert_eq!(format_units("1234500", 6), "1,2345");
        assert_eq!(format_units("12", 8), "0,00000012");
    }

    /// CRITIQUE 2: the phrase is shown natively, numbered; the check needs the 3 words Rust
    /// chose, in order, and nothing else.
    #[test]
    fn backup_words_and_check() {
        let words: Vec<String> = (1..=12).map(|i| format!("mot{i}")).collect();
        let t = words_text(Lang::Fr, &words);
        assert!(t.contains(" 1. mot1"));
        assert!(t.contains("12. mot12"));
        assert!(t.contains("Écris ces 12 mots"));
        let c = random_checks(12).unwrap();
        assert!(c[0] < c[1] && c[1] < c[2] && c[2] < 12);
        let p = PendingBackup {
            words: Zeroizing::new(words),
            checks: [0, 5, 11],
            failures: 0,
        };
        let a = |x: [&str; 3]| x.map(String::from).to_vec();
        assert!(backup_answers_match(&p, &a(["mot1", " MOT6 ", "mot12"])));
        assert!(!backup_answers_match(&p, &a(["mot1", "mot6", "mot11"])));
        assert!(!backup_answers_match(&p, &a(["mot6", "mot1", "mot12"])));
        assert!(!backup_answers_match(&p, &["mot1".into(), "mot6".into()]));
    }
}
