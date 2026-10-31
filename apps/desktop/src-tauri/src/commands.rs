//! Every IPC command exposed to the webview (see docs/IPC.md and build.rs).
//! Secrets only flow *into* these functions (passwords) and never back out,
//! except the recovery phrase on creation and on an explicit, password-gated reveal.

use base64::Engine as _;
use serde::{Deserialize, Serialize};
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
use crate::state::AppState;
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

/// Opens the vault with `password` (attempt limiting applies).
pub(crate) async fn mnemonic_from_password(
    state: &AppState,
    password: Zeroizing<String>,
) -> AppResult<Mnemonic> {
    state.check_attempts()?;
    let file = state.read_vault()?;
    let result = blocking(move || Ok(wallet_core::open(&file, &password)?)).await;
    state.record_attempt(result.is_ok());
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
    let cardano = wallet_core::CardanoRoot::from_mnemonic(&mnemonic, "");
    let file = blocking(move || {
        Ok(wallet_core::seal(
            &mnemonic,
            &password,
            KdfParams::production(),
        )?)
    })
    .await?;
    state.write_vault(&file)?;
    state.start_session(seed, cardano);
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenHint {
    pub(crate) symbol: String,
    pub(crate) decimals: u8,
}

pub(crate) fn describe_evm(s: &wallet_core::EvmTxSummary, hint: Option<&TokenHint>) -> String {
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

/// Reasons for caution of an EVM transaction, one bullet each (reinforced dialog).
pub(crate) fn evm_warning_lines(s: &wallet_core::EvmTxSummary, hint: Option<&TokenHint>) -> String {
    use wallet_core::EvmWarning;
    let mut out = String::new();
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
                    match hint {
                        Some(h) => format!(
                            "{} {} (unités brutes : {amount})",
                            format_units(amount, h.decimals as usize),
                            h.symbol
                        ),
                        None => format!("{amount} unités brutes"),
                    }
                };
                format!(
                    "• AUTORISATION : {spender} pourra dépenser {shown} de ce token ({}), à tout moment, jusqu'à révocation\n",
                    s.token_contract.as_deref().unwrap_or("?")
                )
            }
            EvmWarning::ValueToContract { value_wei } => format!(
                "• {} ETH (valeur native) envoyés au contrat avec l'appel\n",
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
    hint: Option<&TokenHint>,
) -> String {
    format!(
        "Kyro a trouvé des éléments à vérifier dans cette transaction :\n{}\nNe signe que si tu sais exactement pourquoi. Signer quand même ?",
        evm_warning_lines(s, hint)
    )
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
    account: Option<u32>,
) -> AppResult<EvmSigned> {
    if !state.is_unlocked() {
        return Err(AppError::Locked);
    }
    let a = account_arg(account)?;
    let summary = wallet_core::evm_decode(&tx)?;
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
    if summary.requires_extra_confirmation {
        confirm_native(
            &app,
            "Attention : transaction à vérifier",
            describe_evm_extra(&summary, token.as_ref()),
        )
        .await?;
    }
    let (raw_tx, hash) = blocking(move || Ok(wallet_core::evm_sign_tx(&seed, a, &tx)?)).await?;
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
        signer.body(&solana::describe(&summary, &me, state.network)),
    )
    .await?;
    confirm_signer(&app, &signer).await?;
    if summary.requires_extra_confirmation {
        confirm_native(
            &app,
            "Attention : transaction non vérifiée",
            solana::describe_extra(&summary),
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
        let s = wallet_core::evm_decode(&tx(&max, 11_155_111, "0")).unwrap();
        assert!(s.requires_extra_confirmation);
        let d = describe_evm_extra(&s, None);
        assert!(d.contains("AUTORISATION : 0x9858EfFD232B4033E47d90003D41EC34EcaEda94 pourra dépenser ILLIMITÉ"), "{d}");
        let exact = format!("0x095ea7b3{:0>64}{:0>64}", spender, "f4240");
        let s = wallet_core::evm_decode(&tx(&exact, 11_155_111, "0")).unwrap();
        let hint = TokenHint {
            symbol: "USDC".into(),
            decimals: 6,
        };
        assert!(describe_evm_extra(&s, Some(&hint))
            .contains("dépenser 1 USDC (unités brutes : 1000000)"));
        let s = wallet_core::evm_decode(&tx("0xdeadbeef", 999, "1000000000000000000")).unwrap();
        let d = describe_evm_extra(&s, None);
        for needle in [
            "action INCONNUE",
            "1 ETH (valeur native) envoyés au contrat",
            "réseau INCONNU de Kyro (chainId 999)",
        ] {
            assert!(d.contains(needle), "{needle} in {d}");
        }
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
}
