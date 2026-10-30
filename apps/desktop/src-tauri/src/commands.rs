//! Every IPC command exposed to the webview (see docs/IPC.md and build.rs).
//! Secrets only flow *into* these functions (passwords) and never back out,
//! except the recovery phrase on creation and on an explicit, password-gated reveal.

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use wallet_core::{
    BtcKind, EvmTxKind, EvmTxRequest, KdfParams, Mnemonic, Network, Seed, WordCount,
};
use zeroize::Zeroizing;

use crate::error::{AppError, AppResult};
use crate::net::{FetchRequest, FetchResponse};
use crate::solana;
use crate::state::AppState;
use crate::tor::TorStatus;

const MIN_PASSWORD_LEN: usize = 10;
/// Receive + change addresses scanned per kind to recognise our own outputs in a PSBT.
const OWN_ADDRESS_GAP: u32 = 20;

/// Argon2id and signing are CPU-heavy: keep them off the async runtime's workers.
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
}

/// Decrypts the vault with `password` (rate-limited) and returns its seed.
async fn seed_from_password(state: &AppState, password: Zeroizing<String>) -> AppResult<Seed> {
    state.check_attempts()?;
    let file = state.read_vault()?;
    let result = blocking(move || Ok(wallet_core::open(&file, &password)?)).await;
    state.record_attempt(result.is_ok());
    Ok(result?.to_seed(""))
}

/// Native OS dialog — rendered outside the webview, so a compromised UI cannot fake or skip it.
async fn confirm_native(app: &AppHandle, title: &'static str, body: String) -> AppResult<()> {
    let app = app.clone();
    let approved = blocking(move || {
        Ok(app
            .dialog()
            .message(body)
            .title(title)
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Signer".into(),
                "Annuler".into(),
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

#[derive(Serialize)]
pub struct WordsOut {
    words: Vec<String>,
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

async fn seal_and_start(
    state: &AppState,
    mnemonic: Mnemonic,
    password: Zeroizing<String>,
) -> AppResult<()> {
    if state.vault_exists() {
        return Err(AppError::InvalidInput(
            "un coffre existe déjà sur cet appareil".into(),
        ));
    }
    check_password_strength(&password)?;
    let seed = mnemonic.to_seed("");
    let file = blocking(move || {
        Ok(wallet_core::seal(
            &mnemonic,
            &password,
            KdfParams::production(),
        )?)
    })
    .await?;
    state.write_vault(&file)?;
    state.start_session(seed);
    Ok(())
}

#[tauri::command]
pub async fn vault_create(
    state: State<'_, AppState>,
    password: String,
    words: u8,
) -> AppResult<WordsOut> {
    let password = Zeroizing::new(password);
    let count = match words {
        12 => WordCount::W12,
        24 => WordCount::W24,
        _ => return Err(AppError::InvalidInput("12 ou 24 mots".into())),
    };
    let mnemonic = Mnemonic::generate(count)?;
    let shown = mnemonic.words();
    seal_and_start(&state, mnemonic, password).await?;
    Ok(WordsOut {
        words: shown.to_vec(),
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
    let seed = seed_from_password(&state, Zeroizing::new(password)).await?;
    state.start_session(seed);
    Ok(())
}

#[tauri::command]
pub fn vault_lock(state: State<'_, AppState>) {
    state.lock_session();
}

#[tauri::command]
pub async fn vault_reveal_mnemonic(
    state: State<'_, AppState>,
    window: WebviewWindow,
    password: String,
) -> AppResult<WordsOut> {
    if !state.is_unlocked() {
        return Err(AppError::Locked);
    }
    state.check_reveal_cooldown()?;
    state.check_attempts()?;
    let file = state.read_vault()?;
    let password = Zeroizing::new(password);
    let result = blocking(move || Ok(wallet_core::open(&file, &password)?)).await;
    state.record_attempt(result.is_ok());
    // Best effort: full on Windows, partial on macOS, unavailable on Linux.
    let _ = window.set_content_protected(true);
    Ok(WordsOut {
        words: result?.words().to_vec(),
    })
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
}

#[derive(Serialize)]
pub struct BtcAccounts {
    segwit: BtcAccountOut,
    taproot: BtcAccountOut,
}

#[derive(Serialize)]
pub struct Accounts {
    network: &'static str,
    btc: BtcAccounts,
    evm: AddressOut,
    sol: AddressOut,
}

fn network_name(n: Network) -> &'static str {
    match n {
        Network::Mainnet => "mainnet",
        Network::Testnet => "testnet",
    }
}

fn btc_account_out(seed: &Seed, net: Network, kind: BtcKind) -> AppResult<BtcAccountOut> {
    let acc = wallet_core::btc_account(seed, net, kind, 0)?;
    Ok(BtcAccountOut {
        address: wallet_core::btc_address(seed, net, kind, 0, false, 0)?,
        xpub: acc.xpub,
        fingerprint: acc.fingerprint,
        path: acc.path,
    })
}

#[tauri::command]
pub fn accounts_get(state: State<'_, AppState>) -> AppResult<Accounts> {
    let net = state.network;
    state.with_seed(|seed| {
        Ok(Accounts {
            network: network_name(net),
            btc: BtcAccounts {
                segwit: btc_account_out(seed, net, BtcKind::Segwit)?,
                taproot: btc_account_out(seed, net, BtcKind::Taproot)?,
            },
            evm: AddressOut {
                address: wallet_core::evm_address(seed, 0)?,
            },
            sol: AddressOut {
                address: wallet_core::sol_address(seed, 0)?,
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
) -> AppResult<String> {
    let kind = parse_kind(&kind)?;
    let net = state.network;
    state.with_seed(|seed| Ok(wallet_core::btc_address(seed, net, kind, 0, change, index)?))
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenHint {
    symbol: String,
    decimals: u8,
}

fn describe_evm(s: &wallet_core::EvmTxSummary, hint: Option<&TokenHint>) -> String {
    let token_amount = |raw: &str| match hint {
        Some(h) => format!(
            "{} {} (unités brutes : {raw})",
            format_units(raw, h.decimals as usize),
            h.symbol
        ),
        None => format!("{raw} unités brutes"),
    };
    let mut out = format!("Réseau : {}\n\n", chain_name(s.chain_id));
    match s.kind {
        EvmTxKind::NativeTransfer => {
            out += &format!(
                "Envoi de {} ETH\nÀ : {}\n",
                format_units(&s.amount, 18),
                s.to
            );
        }
        EvmTxKind::Erc20Transfer => {
            out += &format!(
                "Envoi de token : {}\nContrat du token : {}\nÀ : {}\n",
                token_amount(&s.amount),
                s.token_contract.as_deref().unwrap_or("?"),
                s.to
            );
        }
        EvmTxKind::Erc20Approve => {
            out +=
                &format!(
                "AUTORISATION de dépense\nContrat du token : {}\nBénéficiaire : {}\nMontant : {}\n",
                s.token_contract.as_deref().unwrap_or("?"),
                s.spender.as_deref().unwrap_or("?"),
                if s.unlimited_approval { "ILLIMITÉ".to_string() } else { token_amount(&s.amount) }
            );
            if s.unlimited_approval {
                out += "\n⚠ Ce contrat pourra dépenser TOUS ces tokens, sans limite de temps.\n";
            }
        }
        EvmTxKind::ContractCall => {
            out += &format!(
                "Appel de contrat : {}\nValeur envoyée : {} ETH\n",
                s.to,
                format_units(&s.amount, 18)
            );
        }
    }
    out += &format!("\nFrais maximum : {} ETH", format_units(&s.max_fee_wei, 18));
    out
}

#[tauri::command]
pub fn evm_decode_tx(tx: EvmTxRequest) -> AppResult<wallet_core::EvmTxSummary> {
    Ok(wallet_core::evm_decode(&tx)?)
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
    token: Option<TokenHint>,
) -> AppResult<EvmSigned> {
    if !state.is_unlocked() {
        return Err(AppError::Locked);
    }
    let summary = wallet_core::evm_decode(&tx)?;
    let seed = seed_from_password(&state, Zeroizing::new(password)).await?;
    confirm_native(
        &app,
        "Confirmer la transaction",
        describe_evm(&summary, token.as_ref()),
    )
    .await?;
    let (raw_tx, hash) = blocking(move || Ok(wallet_core::evm_sign_tx(&seed, 0, &tx)?)).await?;
    state.touch();
    Ok(EvmSigned { raw_tx, hash })
}

fn own_btc_addresses(seed: &Seed, net: Network) -> AppResult<Vec<String>> {
    let mut out = Vec::new();
    for kind in [BtcKind::Segwit, BtcKind::Taproot] {
        for change in [false, true] {
            for i in 0..OWN_ADDRESS_GAP {
                out.push(wallet_core::btc_address(seed, net, kind, 0, change, i)?);
            }
        }
    }
    Ok(out)
}

fn describe_btc(s: &wallet_core::BtcTxSummary) -> String {
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
) -> AppResult<BtcSigned> {
    if !state.is_unlocked() {
        return Err(AppError::Locked);
    }
    let net = state.network;
    let seed = seed_from_password(&state, Zeroizing::new(password)).await?;
    let own = own_btc_addresses(&seed, net)?;
    let summary = wallet_core::btc_decode_psbt(net, &psbt, &own)?;
    confirm_native(&app, "Confirmer la transaction", describe_btc(&summary)).await?;
    let (signed, summary) =
        blocking(move || Ok(wallet_core::btc_sign_psbt(&seed, net, &psbt)?)).await?;
    state.touch();
    Ok(BtcSigned {
        psbt: signed,
        summary,
    })
}

/// Our Solana address (account 0) from the unlocked session.
fn sol_own_address(state: &AppState) -> AppResult<String> {
    state.with_seed(|seed| Ok(wallet_core::sol_address(seed, 0)?))
}

/// Preview for the UI: decoded in Rust, lookup tables fetched by the shell.
#[tauri::command]
pub async fn sol_decode_tx(
    state: State<'_, AppState>,
    message: String,
) -> AppResult<wallet_core::SolTxSummary> {
    let bytes = solana::message_bytes(&message)?;
    let me = sol_own_address(&state)?;
    solana::decode(&state, &bytes, &me).await
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
) -> AppResult<SolSigned> {
    if !state.is_unlocked() {
        return Err(AppError::Locked);
    }
    let bytes = solana::message_bytes(&message)?;
    let me = sol_own_address(&state)?;
    // Decoded (and lookup tables resolved) in Rust only — nothing from the UI is trusted.
    let summary = solana::decode(&state, &bytes, &me).await?;
    if summary.our_signer_index.is_none() {
        return Err(AppError::InvalidInput(
            "cette transaction ne demande pas la signature de ton adresse Solana".into(),
        ));
    }
    let seed = seed_from_password(&state, Zeroizing::new(password)).await?;
    confirm_native(
        &app,
        "Confirmer la transaction Solana",
        solana::describe(&summary, &me, state.network),
    )
    .await?;
    if summary.requires_extra_confirmation {
        confirm_native(
            &app,
            "Attention : transaction non vérifiée",
            solana::describe_extra(&summary),
        )
        .await?;
    }
    let sig = blocking(move || Ok(wallet_core::sol_sign_message(&seed, 0, &bytes)?)).await?;
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
    has_oneinch_key: bool,
    has_coingecko_key: bool,
}

#[tauri::command]
pub fn config_get(state: State<'_, AppState>) -> ConfigOut {
    let s = state.settings();
    let env = &state.env_keys;
    ConfigOut {
        network: network_name(state.network),
        has_zerox_key: env.zerox.is_some() || s.api_keys.zerox.is_some(),
        has_oneinch_key: env.oneinch.is_some() || s.api_keys.oneinch.is_some(),
        has_coingecko_key: env.coingecko.is_some() || s.api_keys.coingecko.is_some(),
    }
}

/// Re-exported for the window-close hook in lib.rs.
pub fn lock_on_exit(app: &AppHandle) {
    app.state::<AppState>().lock_session();
}

#[cfg(test)]
mod tests {
    use super::format_units;

    #[test]
    fn units() {
        assert_eq!(format_units("0", 18), "0");
        assert_eq!(format_units("250000000000000000", 18), "0,25");
        assert_eq!(format_units("1000000", 6), "1");
        assert_eq!(format_units("1234500", 6), "1,2345");
        assert_eq!(format_units("12", 8), "0,00000012");
    }
}
