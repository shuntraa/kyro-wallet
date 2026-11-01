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

/// Native OS dialog — rendered outside the webview, so a compromised UI cannot fake or skip it.
pub(crate) async fn confirm_native(
    app: &AppHandle,
    title: &'static str,
    body: String,
) -> AppResult<()> {
    confirm_native_with(app, title, body, "Signer", "Annuler").await
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
    blocking(move || {
        let body = words_text(&words);
        app.dialog()
            .message(body.as_str())
            .title("Ta phrase de récupération")
            .kind(MessageDialogKind::Info)
            .buttons(MessageDialogButtons::OkCustom("J'ai fini de noter".into()))
            .blocking_show();
        Ok(())
    })
    .await
}

/// Text of the native recovery-phrase dialog: numbered words, three per line.
pub(crate) fn words_text(words: &[String]) -> Zeroizing<String> {
    let mut out = Zeroizing::new(format!(
        "Écris ces {} mots sur papier, dans l'ordre, au stylo. Pas de photo, pas de copie, pas de \
         cloud. Quiconque lit ces mots contrôle tes fonds ; personne de légitime ne te les \
         demandera jamais.\n\n",
        words.len()
    ));
    for (i, w) in words.iter().enumerate() {
        out.push_str(&format!("{:>2}. {w}", i + 1));
        out.push_str(if i % 3 == 2 { "\n" } else { "      " });
    }
    out.push_str(
        "\nCette fenêtre appartient au système, pas à l'interface de Kyro : vérifie quand même \
         que personne ne regarde ton écran et qu'aucun partage d'écran n'est actif.",
    );
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
    let file = blocking(move || {
        Ok(wallet_core::seal(
            &mnemonic,
            &password,
            KdfParams::production(),
        )?)
    })
    .await?;
    state.write_new_vault(&file)?;
    state.start_session(seed, cardano);
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
    let (seed, cardano) = blocking(move || {
        Ok((
            m.to_seed(""),
            wallet_core::CardanoRoot::from_mnemonic(&m, ""),
        ))
    })
    .await?;
    state.start_session(seed, cardano);
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
    confirm_native_with(
        &app,
        "Afficher la phrase de récupération ?",
        "Kyro va afficher ta phrase de récupération dans une fenêtre du système.\n\nQuiconque la \
         voit peut prendre tous tes fonds. Vérifie que personne ne regarde ton écran et \
         qu'aucun partage d'écran ni logiciel de capture n'est actif.\n\nSi tu n'as pas \
         toi-même demandé à l'afficher, refuse."
            .into(),
        "Afficher",
        "Annuler",
    )
    .await?;
    show_words_native(&app, mnemonic.words()).await?;
    state.touch();
    Ok(())
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

/// Litecoin (BIP84) / Dogecoin (BIP44) account: first receive address and public data.
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
    /// `m/44'/195'/a'/0/0`.
    tron: AddressOut,
    /// `m/44'/144'/a'/0/0`.
    xrp: AddressOut,
    /// Base address `m/1852'/1815'/a'/0/0` + stake key `…/2/0` (CIP-1852, Icarus).
    cardano: AddressOut,
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
            tron: AddressOut {
                address: wallet_core::tron_address(seed, a)?,
                path: wallet_core::tron_path(a),
            },
            xrp: AddressOut {
                address: wallet_core::xrp_address(seed, a)?,
                path: wallet_core::xrp_path(a),
            },
            cardano: AddressOut {
                address: cardano,
                path: format!("{}/0/0", wallet_core::cardano_account_path(a)),
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

fn chain_name(id: u64) -> String {
    match id {
        1 => "Ethereum".into(),
        11155111 => "Ethereum Sepolia (testnet)".into(),
        42161 => "Arbitrum One".into(),
        10 => "Optimism".into(),
        8453 => "Base".into(),
        137 => "Polygon".into(),
        56 => "BNB Chain".into(),
        43114 => "Avalanche C-Chain".into(),
        other => format!("chaîne {other}"),
    }
}

/// Native currency of an EVM chain (what `value` and the fees are paid in).
fn native_symbol(id: u64) -> &'static str {
    match id {
        137 => "POL",
        56 => "BNB",
        43114 => "AVAX",
        1 | 11155111 | 42161 | 10 | 8453 => "ETH",
        _ => "(monnaie native)",
    }
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

fn evm_token_amount(raw: &str, token: Option<&TokenLabel>) -> String {
    match token {
        Some(t) => format!(
            "{} {} (unités brutes : {raw})",
            format_units(raw, t.decimals as usize),
            crate::dialog_text::sanitize(&t.symbol, 16)
        ),
        None => format!("{raw} unités brutes (jeton inconnu : décimales non vérifiées)"),
    }
}

pub(crate) fn describe_evm(s: &wallet_core::EvmTxSummary, token: Option<&TokenLabel>) -> String {
    let native = native_symbol(s.chain_id);
    let unknown = if token.is_none() {
        " (JETON INCONNU)"
    } else {
        ""
    };
    let mut out = format!("Réseau : {}\n\n", chain_name(s.chain_id));
    match s.kind {
        EvmTxKind::NativeTransfer => {
            out += &format!(
                "Envoi de {} {native}\nÀ : {}\n",
                format_units(&s.amount, 18),
                s.to
            );
        }
        EvmTxKind::Erc20Transfer => {
            out += &format!(
                "Envoi de token{unknown} : {}\nContrat du token : {}\nÀ : {}\n",
                evm_token_amount(&s.amount, token),
                s.token_contract.as_deref().unwrap_or("?"),
                s.to
            );
        }
        EvmTxKind::Erc20Approve => {
            out += &format!(
                "AUTORISATION de dépense{unknown}\nContrat du token : {}\nBénéficiaire : {}\nMontant : {}\n",
                s.token_contract.as_deref().unwrap_or("?"),
                s.spender.as_deref().unwrap_or("?"),
                if s.unlimited_approval {
                    "ILLIMITÉ".to_string()
                } else {
                    evm_token_amount(&s.amount, token)
                }
            );
            if s.unlimited_approval {
                out += "\n⚠ Ce contrat pourra dépenser TOUS ces tokens, sans limite de temps.\n";
            }
        }
        EvmTxKind::ContractCall => {
            out += &format!(
                "Appel de contrat : {}\nValeur envoyée : {} {native}\n",
                s.to,
                format_units(&s.amount, 18)
            );
        }
    }
    out += &format!(
        "\nFrais maximum : {} {native}",
        format_units(&s.max_fee_wei, 18)
    );
    out
}

/// Reasons for caution of an EVM transaction, one bullet each (reinforced dialog).
pub(crate) fn evm_warning_lines(
    s: &wallet_core::EvmTxSummary,
    token: Option<&TokenLabel>,
) -> String {
    use wallet_core::EvmWarning;
    let native = native_symbol(s.chain_id);
    let mut out = String::new();
    if evm_unknown_token(s, token) {
        out += &format!(
            "• jeton INCONNU de Kyro (contrat {}) : nom et décimales non vérifiés, montant en unités brutes ; n'importe qui peut créer un jeton qui en imite un vrai\n",
            s.token_contract.as_deref().unwrap_or("?")
        );
    }
    for w in &s.warnings {
        out += &match w {
            EvmWarning::ContractCall => format!(
                "• appel de contrat sur {} : action INCONNUE, Kyro ne décode pas ce qu'elle fait (données de l'appel non vérifiées)\n",
                s.to
            ),
            EvmWarning::Approval { spender, amount, unlimited } => {
                let shown = if *unlimited {
                    "ILLIMITÉ".to_string()
                } else {
                    evm_token_amount(amount, token)
                };
                format!(
                    "• AUTORISATION : {spender} pourra dépenser {shown} de ce token ({}), à tout moment, jusqu'à révocation\n",
                    s.token_contract.as_deref().unwrap_or("?")
                )
            }
            EvmWarning::ValueToContract { value_wei } => format!(
                "• valeur native envoyée au contrat avec l'appel : {} {native}\n",
                format_units(value_wei, 18)
            ),
            EvmWarning::UnknownChain { chain_id } => format!(
                "• réseau INCONNU de Kyro (chainId {chain_id}) : vérifie que c'est bien celui que tu veux\n"
            ),
            EvmWarning::HighFee { max_fee_wei } => format!(
                "• frais maximum très élevés : {} (seuil {})\n",
                format_units(max_fee_wei, 18),
                format_units(&wallet_core::evm_high_fee_threshold_wei(s.chain_id).to_string(), 18)
            ),
        };
    }
    out
}

/// Text of the reinforced dialog for EVM transactions signed by the vault.
pub(crate) fn describe_evm_extra(
    s: &wallet_core::EvmTxSummary,
    token: Option<&TokenLabel>,
) -> String {
    format!(
        "Kyro a trouvé des éléments à vérifier dans cette transaction :\n{}\nNe signe que si tu sais exactement pourquoi. Signer quand même ?",
        evm_warning_lines(s, token)
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
    confirm_native(
        &app,
        "Confirmer la transaction",
        signer.body(&format!(
            "De : {from}\n{}",
            describe_evm(&summary, token.as_ref())
        )),
    )
    .await?;
    confirm_signer(&app, &signer).await?;
    if evm_needs_extra(&summary, token.as_ref()) {
        confirm_native(
            &app,
            "Attention : transaction à vérifier",
            describe_evm_extra(&summary, token.as_ref()),
        )
        .await?;
    }
    let net = state.network;
    let (raw_tx, hash) =
        blocking(move || Ok(wallet_core::evm_sign_tx(&seed, a, &tx, net)?)).await?;
    state.touch();
    Ok(EvmSigned { raw_tx, hash })
}

pub(crate) fn describe_btc(s: &wallet_core::BtcTxSummary) -> String {
    let sats = |v: u64| format_units(&v.to_string(), 8);
    let mut out = String::from("Envoi Bitcoin\n\n");
    for (addr, value, is_change) in &s.outputs {
        if *is_change {
            out += &format!(
                "Monnaie (revient chez toi) : {} BTC\n  {addr}\n",
                sats(*value)
            );
        } else {
            out += &format!("À : {addr}\nMontant : {} BTC\n", sats(*value));
        }
    }
    out += &format!("\nFrais : {} BTC ({} sats)", sats(s.fee_sats), s.fee_sats);
    out
}

/// Text of the reinforced dialog for Bitcoin (vault and hardware wallet).
pub(crate) fn describe_btc_extra(s: &wallet_core::BtcTxSummary) -> String {
    let mut out = String::from("Kyro a trouvé des éléments inhabituels dans cette transaction :\n");
    for w in &s.warnings {
        out += &match w {
            wallet_core::BtcWarning::UnknownScript { output } => format!(
                "• sortie {} : script INCONNU (pas une adresse standard), Kyro ne sait pas qui peut la dépenser\n",
                output + 1
            ),
            wallet_core::BtcWarning::OpReturn { output } => format!(
                "• sortie {} : OP_RETURN (données inscrites sur la chaîne ; son montant est détruit)\n",
                output + 1
            ),
            wallet_core::BtcWarning::ForeignInput { input } => format!(
                "• entrée {} : n'appartient PAS à ce portefeuille (Kyro ne la signe pas ; quelqu'un d'autre participe à cette transaction)\n",
                input + 1
            ),
            wallet_core::BtcWarning::HighFee { sat_per_vb } => format!(
                "• frais très élevés : ≈ {sat_per_vb} sat/vB (seuil {} sat/vB), ou plus que tous les montants envoyés\n",
                wallet_core::BTC_HIGH_FEE_SAT_PER_VB
            ),
            wallet_core::BtcWarning::ChangeIndexOutOfRange { output } => format!(
                "• sortie {} : une de tes clés, mais à un index d'adresse anormalement élevé (affichée comme un paiement, pas comme ta monnaie)\n",
                output + 1
            ),
        };
    }
    out += "\nNe signe que si tu sais exactement pourquoi. Signer quand même ?";
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
    confirm_native(
        &app,
        "Confirmer la transaction",
        signer.body(&describe_btc(&summary)),
    )
    .await?;
    confirm_signer(&app, &signer).await?;
    if summary.requires_extra_confirmation {
        confirm_native(
            &app,
            "Attention : transaction à vérifier",
            describe_btc_extra(&summary),
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
    confirm_native(
        &app,
        "Confirmer la transaction Solana",
        signer.body(&solana::describe(&decoded, &me, state.network)),
    )
    .await?;
    confirm_signer(&app, &signer).await?;
    if summary.requires_extra_confirmation {
        confirm_native(
            &app,
            "Attention : transaction non vérifiée",
            solana::describe_extra(&decoded),
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
        let d = describe_evm_extra(&s, None);
        assert!(d.contains("AUTORISATION : 0x9858EfFD232B4033E47d90003D41EC34EcaEda94 pourra dépenser ILLIMITÉ"), "{d}");
        let exact = format!("0x095ea7b3{:0>64}{:0>64}", spender, "f4240");
        let s = wallet_core::evm_decode(&tx(&exact, 11_155_111, "0"), net).unwrap();
        // The token is named from Rust's table (Sepolia test USDC), never from the interface.
        let token = evm_token_label(Network::Testnet, &s);
        assert!(token.is_some());
        assert!(describe_evm_extra(&s, token.as_ref())
            .contains("dépenser 1 USDC (unités brutes : 1000000)"));
        // Same contract on mainnet chain id 1: not a known token there.
        let s1 = wallet_core::evm_decode(&tx(&exact, 1, "0"), Network::Mainnet).unwrap();
        assert!(evm_token_label(Network::Mainnet, &s1).is_none());
        // 31337 (a local devnet): unknown to Kyro.
        let s =
            wallet_core::evm_decode(&tx("0xdeadbeef", 31_337, "1000000000000000000"), net).unwrap();
        let d = describe_evm_extra(&s, None);
        for needle in [
            "action INCONNUE",
            "valeur native envoyée au contrat avec l'appel : 1 (monnaie native)",
            "réseau INCONNU de Kyro (chainId 31337)",
        ] {
            assert!(d.contains(needle), "{needle} in {d}");
        }
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
        let d = describe_evm(&s, None);
        assert!(
            d.contains("Envoi de token (JETON INCONNU) : 1000000 unités brutes"),
            "{d}"
        );
        assert!(describe_evm_extra(&s, None).contains("jeton INCONNU de Kyro"));
        // Real USDC on mainnet: named by Rust, 6 decimals, no extra dialog.
        let s = wallet_core::evm_decode(
            &tx("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", 1),
            Network::Mainnet,
        )
        .unwrap();
        let token = evm_token_label(Network::Mainnet, &s);
        assert!(!evm_needs_extra(&s, token.as_ref()));
        assert!(describe_evm(&s, token.as_ref())
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
        assert!(describe_evm(&native, None).contains("Envoi de 1 POL"));
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
        let d = describe_btc_extra(&s);
        for needle in [
            "sortie 1 : script INCONNU",
            "entrée 2 : n'appartient PAS",
            "≈ 212 sat/vB (seuil 100 sat/vB)",
        ] {
            assert!(d.contains(needle), "{needle} in {d}");
        }
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
        let t = words_text(&words);
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
