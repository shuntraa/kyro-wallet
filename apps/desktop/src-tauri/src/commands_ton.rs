//! IPC commands for TON (`ton_*`): address, account (state, balance, seqno), history, transfer
//! building **by Kyro** (seqno and states read from TON Center, cells written by wallet-core,
//! fee estimated by emulation), signing behind the password and the native dialog (comment
//! highlighted, both address forms shown, states re-read live), and broadcast with hash check.
//! Contract: docs/IPC.md §2.11.

use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, State};
use wallet_core::{Network, TonAddress, TonTransfer, TonTxSummary, TonWarning};
use zeroize::Zeroizing;

use crate::accounts::{account_arg, confirm_signer, Chain, SignerInfo};
use crate::commands::{blocking, confirm_native, format_units_in, seed_from_password};
use crate::error::{AppError, AppResult};
use crate::i18n::Lang;
use crate::servers::utxo_network_key;
use crate::state::AppState;
use crate::ton_backend::{
    self, testnet, TonAccountInfo, TonCtx, TonHistoryEntry, TonStatus, TonTxStatus, TransferCheck,
    VALID_FOR_SECS,
};

pub(crate) fn ctx(state: &AppState) -> TonCtx<'_> {
    let s = state.settings();
    TonCtx {
        net_client: &state.net,
        network: state.network,
        tor: s.tor.enabled,
        api_key: state.env_keys.toncenter.clone(),
    }
}

/// Our public key and wallet address for TON account `account` (`m/44'/607'/account'`).
fn ours(state: &AppState, account: u32) -> AppResult<([u8; 32], TonAddress)> {
    let net = state.network;
    state.with_seed(|seed| {
        let pk = wallet_core::ton_public_key(seed, account)?;
        Ok((
            pk,
            wallet_core::ton_wallet_address(&pk, wallet_core::ton_wallet_id(testnet(net)))?,
        ))
    })
}

pub(crate) fn now() -> u32 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| u32::try_from(d.as_secs()).unwrap_or(u32::MAX))
        .unwrap_or(0)
}

fn ton(lang: Lang, nano: &str) -> String {
    format!("{} GRAM", format_units_in(lang, nano, 9))
}

/// A user-friendly address the user typed, for this network.
fn parse_user_address(s: &str, net: Network) -> AppResult<wallet_core::TonFriendly> {
    let f = wallet_core::ton_parse_address(s)?;
    if f.testnet && net == Network::Mainnet {
        return Err(AppError::InvalidInput(
            "adresse TON de testnet (kQ… / 0Q…) : refusée sur mainnet".into(),
        ));
    }
    if f.address.workchain != 0 {
        return Err(AppError::InvalidInput(
            "adresse de la masterchain (-1) : seuls les comptes de la basechain (0) sont pris en charge".into(),
        ));
    }
    Ok(f)
}

/// Live context shown in the dialog.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TonContext {
    pub account: TonAccountInfo,
    pub destination: TonAccountInfo,
    /// Estimated fees (nanotons), paid from the balance on top of the amount.
    pub fee: String,
}

/// Body of the native dialog. The comment gets its own framed block, whatever it is.
pub(crate) fn describe_ton(
    lang: Lang,
    s: &TonTxSummary,
    c: &TonContext,
    net: Network,
    now: u32,
) -> String {
    let line = "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━";
    let tn = |v: &str| ton(lang, v);
    let testnet = if net == Network::Testnet {
        " (testnet)"
    } else {
        ""
    };
    if let Some(j) = &s.jetton {
        return describe_jetton(lang, s, j, c, testnet, now);
    }
    let mut out = match lang {
        Lang::Fr => format!(
            "Envoi TON{testnet}\n\nÀ : {}\n(même compte que {} : seul l'indicateur de rebond diffère)\n",
            s.destination, s.destination_other
        ),
        Lang::En => format!(
            "TON send{testnet}\n\nTo: {}\n(same account as {}: only the bounce flag differs)\n",
            s.destination, s.destination_other
        ),
    };
    out += &format!("{line}\n");
    match &s.comment {
        Some(t) => {
            out += &format!(
                "{}« {t} »\n",
                lang.pick("COMMENTAIRE : ", "COMMENT: ")
            )
        }
        None => out += lang.pick(
            "AUCUN COMMENTAIRE\n(une plateforme d'échange en exige souvent un, appelé aussi mémo ou tag : sans lui, les fonds peuvent être perdus)\n",
            "NO COMMENT\n(an exchange often requires one, also called memo or tag: without it, the funds can be lost)\n",
        ),
    }
    out += &format!("{line}\n");
    if s.send_all {
        out += &match lang {
            Lang::Fr => format!(
                "Montant : TOUT LE SOLDE, ≈ {} (solde moins les frais) — ton portefeuille restera à 0\n",
                tn(&c.account.balance)
            ),
            Lang::En => format!(
                "Amount: THE WHOLE BALANCE, ≈ {} (balance minus the fee) — your wallet will be left at 0\n",
                tn(&c.account.balance)
            ),
        };
    } else {
        out += &format!(
            "{}{} ({} nanotons)\n",
            lang.pick("Montant : ", "Amount: "),
            tn(&s.amount),
            s.amount
        );
    }
    out += if s.bounce {
        lang.pick(
            "Rebond : oui (si le destinataire échoue, les fonds reviennent, moins les frais)\n",
            "Bounce: yes (if the recipient fails, the funds come back, minus the fee)\n",
        )
    } else if c.destination.status == TonStatus::Active {
        lang.pick(
            "Rebond : non (adresse non rebondissante UQ… : les fonds restent chez le destinataire quoi qu'il arrive)\n",
            "Bounce: no (non-bounceable UQ… address: the funds stay with the recipient whatever happens)\n",
        )
    } else {
        lang.pick(
            "Rebond : non — ce compte n'est pas encore actif (jamais utilisé) : les fonds y arrivent quand même et y restent\n",
            "Bounce: no — this account is not active yet (never used): the funds still arrive there and stay there\n",
        )
    };
    out += &match lang {
        Lang::Fr => format!(
            "\nFrais estimés : ≈ {} (en plus du montant, prélevés sur ton solde)\nSolde : {}\n",
            tn(&c.fee),
            tn(&c.account.balance)
        ),
        Lang::En => format!(
            "\nEstimated fee: ≈ {} (on top of the amount, taken from your balance)\nBalance: {}\n",
            tn(&c.fee),
            tn(&c.account.balance)
        ),
    };
    if s.deploys_wallet {
        out += lang.pick(
            "Premier envoi : il déploie aussi ton portefeuille (contrat standard v4R2).\n",
            "First send: it also deploys your wallet (standard v4R2 contract).\n",
        );
    }
    let mins = s.valid_until.saturating_sub(now).div_ceil(60);
    out += &match lang {
        Lang::Fr => format!(
            "Valable encore ≈ {mins} min (jusqu'à {} UTC), seqno {}\n",
            utc_hms(s.valid_until),
            s.seqno
        ),
        Lang::En => format!(
            "Still valid for ≈ {mins} min (until {} UTC), seqno {}\n",
            utc_hms(s.valid_until),
            s.seqno
        ),
    };
    out
}

/// Dialog body of a jetton transfer: token, verified master, decimals, recipient (both forms),
/// comment framed, TON attached for the jetton wallets' fees.
fn describe_jetton(
    lang: Lang,
    s: &TonTxSummary,
    j: &wallet_core::TonJettonSummary,
    c: &TonContext,
    testnet: &str,
    now: u32,
) -> String {
    let line = "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━";
    let amount = format!(
        "{} {}",
        format_units_in(lang, &j.amount, usize::from(j.decimals)),
        j.symbol
    );
    let mut out = match lang {
        Lang::Fr => format!(
            "Envoi de jeton TON (jetton){testnet}\n\nJeton : {} — contrat vérifié par Kyro {}\n{} décimales\nMontant : {amount} ({} unités)\n\nÀ : {}\n(même compte que {})\n",
            j.symbol, j.master, j.decimals, j.amount, j.recipient, j.recipient_other
        ),
        Lang::En => format!(
            "TON token (jetton) send{testnet}\n\nToken: {} — contract verified by Kyro {}\n{} decimals\nAmount: {amount} ({} units)\n\nTo: {}\n(same account as {})\n",
            j.symbol, j.master, j.decimals, j.amount, j.recipient, j.recipient_other
        ),
    };
    out += &format!("{line}\n");
    match &s.comment {
        Some(t) => out += &format!("{}« {t} »\n", lang.pick("COMMENTAIRE : ", "COMMENT: ")),
        None => out += lang.pick(
            "AUCUN COMMENTAIRE\n(une plateforme d'échange en exige souvent un, appelé aussi mémo ou tag : sans lui, les fonds peuvent être perdus)\n",
            "NO COMMENT\n(an exchange often requires one, also called memo or tag: without it, the funds can be lost)\n",
        ),
    }
    out += &format!("{line}\n");
    out += &match lang {
        Lang::Fr => format!(
            "Message envoyé à ton portefeuille de jetons {} (adresse calculée par Kyro), avec {} pour ses frais : le surplus revient à ton portefeuille.\nFrais estimés : ≈ {} en plus\nSolde GRAM : {}\n",
            j.jetton_wallet, ton(lang, &s.amount), ton(lang, &c.fee), ton(lang, &c.account.balance)
        ),
        Lang::En => format!(
            "Message sent to your token wallet {} (address computed by Kyro), with {} for its fees: the excess comes back to your wallet.\nEstimated fee: ≈ {} on top\nGRAM balance: {}\n",
            j.jetton_wallet, ton(lang, &s.amount), ton(lang, &c.fee), ton(lang, &c.account.balance)
        ),
    };
    let mins = s.valid_until.saturating_sub(now).div_ceil(60);
    out += &match lang {
        Lang::Fr => format!(
            "Valable encore ≈ {mins} min (jusqu'à {} UTC), seqno {}\n",
            utc_hms(s.valid_until),
            s.seqno
        ),
        Lang::En => format!(
            "Still valid for ≈ {mins} min (until {} UTC), seqno {}\n",
            utc_hms(s.valid_until),
            s.seqno
        ),
    };
    out
}

/// `HH:MM:SS` (UTC) of a UNIX time.
fn utc_hms(t: u32) -> String {
    let d = t % 86_400;
    format!("{:02}:{:02}:{:02}", d / 3600, d % 3600 / 60, d % 60)
}

pub(crate) fn describe_ton_extra(lang: Lang, s: &TonTxSummary) -> String {
    let mut out = String::from(lang.pick(
        "Kyro a trouvé des éléments inhabituels dans ce transfert :\n",
        "Kyro found unusual elements in this transfer:\n",
    ));
    for w in &s.warnings {
        out += match w {
            TonWarning::UnusualText => lang.pick(
                "• commentaire contenant des caractères invisibles / de contrôle (affiché nettoyé)\n",
                "• comment containing invisible / control characters (shown cleaned)\n",
            ),
        };
    }
    out += "\n";
    out += lang.sign_anyway();
    out
}

// ---------------------------------------------------------------- reads

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TonBackendInfo {
    pub network: &'static str,
    pub label: &'static str,
    pub tor: bool,
}

#[tauri::command]
pub fn ton_backend_info(state: State<'_, AppState>) -> TonBackendInfo {
    let c = ctx(&state);
    TonBackendInfo {
        network: utxo_network_key(state.network),
        label: ton_backend::host(state.network),
        tor: c.tor,
    }
}

/// Address of TON account `account` (absent = 0), non-bounceable (`UQ…`, testnet `0Q…`).
#[tauri::command]
pub fn ton_address(state: State<'_, AppState>, account: Option<u32>) -> AppResult<String> {
    let (_, a) = ours(&state, account_arg(account)?)?;
    Ok(a.to_friendly(false, testnet(state.network)))
}

#[tauri::command]
pub async fn ton_account(state: State<'_, AppState>, address: String) -> AppResult<TonAccountInfo> {
    let a = parse_user_address(&address, state.network)?;
    ton_backend::account(&ctx(&state), &a.address).await
}

#[tauri::command]
pub async fn ton_txs(
    state: State<'_, AppState>,
    address: String,
) -> AppResult<Vec<TonHistoryEntry>> {
    let a = parse_user_address(&address, state.network)?;
    ton_backend::txs(&ctx(&state), &a.address).await
}

/// Balances of the jettons Kyro knows (our jetton wallets computed by Kyro).
#[tauri::command]
pub async fn ton_jetton_balances(
    state: State<'_, AppState>,
    address: String,
) -> AppResult<Vec<ton_backend::TonJettonBalance>> {
    let a = parse_user_address(&address, state.network)?;
    ton_backend::jetton_balances(&ctx(&state), &a.address).await
}

/// Transfers of the jettons Kyro knows (lines from fake jetton contracts dropped).
#[tauri::command]
pub async fn ton_jetton_txs(
    state: State<'_, AppState>,
    address: String,
) -> AppResult<Vec<ton_backend::TonJettonHistoryEntry>> {
    let a = parse_user_address(&address, state.network)?;
    ton_backend::jetton_txs(&ctx(&state), &a.address).await
}

// ---------------------------------------------------------------- build, sign, broadcast

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TonBuilt {
    /// Unsigned external message, BOC (base64): what `ton_sign_tx` signs.
    pub boc: String,
    pub summary: TonTxSummary,
    pub context: TonContext,
}

fn amount_of(amount: &str, send_all: bool) -> AppResult<u64> {
    if send_all {
        return Ok(0);
    }
    amount
        .trim()
        .parse()
        .ok()
        .filter(|n| *n > 0)
        .ok_or_else(|| AppError::InvalidInput("montant en nanotons invalide".into()))
}

/// What the user asked: recipient, nanotons (ignored with `send_all`), optional comment.
pub(crate) struct TransferRequest<'a> {
    pub to: &'a str,
    pub amount: &'a str,
    pub comment: Option<&'a str>,
    pub send_all: bool,
    /// Ledger account: the layout the Ledger TON app signs (empty body inline, ASCII comment).
    pub hw: bool,
}

/// Builds an unsigned transfer from live data.
pub(crate) async fn build(
    c: &TonCtx<'_>,
    public_key: &[u8; 32],
    me: &TonAddress,
    req: &TransferRequest<'_>,
    now: u32,
) -> AppResult<TonBuilt> {
    let send_all = req.send_all;
    let dest = parse_user_address(req.to, c.network)?;
    let amount = amount_of(req.amount, send_all)?;
    let comment = req.comment.filter(|t| !t.is_empty()).map(str::to_owned);
    let account = ton_backend::account(c, me).await?;
    let destination = ton_backend::account(c, &dest.address).await?;
    if destination.status == TonStatus::Frozen {
        return Err(AppError::InvalidInput(
            "le compte destinataire est gelé (frais de stockage impayés) : envoi refusé".into(),
        ));
    }
    let deploy = account.status == TonStatus::Uninit;
    if req.hw {
        if let Some(c) = &comment {
            wallet_core::ton_hw_check_comment(c)?;
        }
    }
    let inline_empty_body = req.hw && comment.is_none();
    let t = TonTransfer {
        public_key: *public_key,
        wallet_id: wallet_core::ton_wallet_id(testnet(c.network)),
        valid_until: now.saturating_add(VALID_FOR_SECS),
        seqno: if deploy {
            0
        } else {
            account.seqno.unwrap_or(0)
        },
        mode: if send_all {
            wallet_core::TON_MODE_ALL_BALANCE
        } else {
            wallet_core::TON_MODE_PAY_FEES
        },
        destination: dest.address,
        // The address's own flag, unless the account is not deployed: a bounceable message to
        // an inactive account would only come back (minus fees).
        bounce: dest.bounceable && destination.status == TonStatus::Active,
        amount,
        comment,
        with_state_init: deploy,
        jetton: None,
        inline_empty_body,
    };
    // Cell layout and limits are checked by wallet-core before any request.
    let boc = wallet_core::ton_unsigned_transfer(&t)?;
    let fee = ton_backend::estimate_fee(c, me, &t.estimate_parts()?).await?;
    ton_backend::check_transfer(&TransferCheck {
        ours: &account,
        amount: (!send_all).then_some(amount),
        fee,
    })?;
    let summary = wallet_core::ton_decode_tx(&boc, public_key, testnet(c.network))?;
    Ok(TonBuilt {
        boc,
        summary,
        context: TonContext {
            account,
            destination,
            fee: fee.to_string(),
        },
    })
}

/// Our live balance of the jetton whose wallet is `jetton_wallet`; refuses `amount` above it.
async fn check_jetton_balance(
    c: &TonCtx<'_>,
    me: &TonAddress,
    j: &wallet_core::TonJettonSummary,
    amount: u128,
) -> AppResult<()> {
    let balances = ton_backend::jetton_balances(c, me).await?;
    let have: u128 = balances
        .iter()
        .find(|b| b.master == j.master && b.wallet == j.jetton_wallet)
        .and_then(|b| b.balance.parse().ok())
        .unwrap_or(0);
    if amount > have {
        return Err(AppError::InvalidInput(format!(
            "solde {} insuffisant : {} {}",
            j.symbol,
            crate::commands::format_units(&have.to_string(), usize::from(j.decimals)),
            j.symbol
        )));
    }
    Ok(())
}

/// Builds an unsigned jetton transfer: `amount` jetton units of the known jetton `master` to the
/// wallet `to`, through our jetton wallet (computed by Kyro).
pub(crate) async fn build_jetton(
    c: &TonCtx<'_>,
    public_key: &[u8; 32],
    me: &TonAddress,
    master: &str,
    req: &TransferRequest<'_>,
    now: u32,
) -> AppResult<TonBuilt> {
    let tn = testnet(c.network);
    let master = wallet_core::ton_parse_address(master)?.address;
    if wallet_core::ton_known_jetton(&master, tn).is_none() {
        return Err(AppError::InvalidInput("jeton TON inconnu de Kyro".into()));
    }
    let dest = parse_user_address(req.to, c.network)?;
    let units: u128 = req
        .amount
        .trim()
        .parse()
        .ok()
        .filter(|n| *n > 0)
        .ok_or_else(|| AppError::InvalidInput("montant de jeton invalide".into()))?;
    let jetton_wallet = wallet_core::ton_jetton_wallet_address(&master, me, tn)?;
    let account = ton_backend::account(c, me).await?;
    let jw = ton_backend::account(c, &jetton_wallet).await?;
    if jw.status != TonStatus::Active {
        return Err(AppError::InvalidInput(
            "tu n'as encore reçu aucun jeton de ce type : ton portefeuille de jetons n'existe pas"
                .into(),
        ));
    }
    let valid_until = now.saturating_add(VALID_FOR_SECS);
    let t = TonTransfer {
        public_key: *public_key,
        wallet_id: wallet_core::ton_wallet_id(tn),
        valid_until,
        seqno: account.seqno.unwrap_or(0),
        mode: wallet_core::TON_MODE_PAY_FEES,
        destination: jetton_wallet,
        bounce: true,
        amount: wallet_core::TON_JETTON_ATTACHED_NANOTON,
        comment: None,
        with_state_init: account.status == TonStatus::Uninit,
        inline_empty_body: false,
        jetton: Some(wallet_core::TonJettonBody {
            query_id: u64::from(valid_until),
            amount: units,
            destination: dest.address,
            response_destination: *me,
            forward_ton_amount: wallet_core::TON_JETTON_FORWARD_NANOTON,
            comment: req.comment.filter(|t| !t.is_empty()).map(str::to_owned),
        }),
    };
    if t.with_state_init && t.seqno != 0 {
        return Err(AppError::InvalidInput(
            "état du portefeuille TON incohérent".into(),
        ));
    }
    let boc = wallet_core::ton_unsigned_transfer(&t)?;
    let fee = ton_backend::estimate_fee(c, me, &t.estimate_parts()?).await?;
    ton_backend::check_transfer(&TransferCheck {
        ours: &account,
        amount: Some(t.amount),
        fee,
    })?;
    let summary = wallet_core::ton_decode_tx(&boc, public_key, tn)?;
    let Some(j) = &summary.jetton else {
        return Err(AppError::Internal("transfert de jeton non reconnu".into()));
    };
    check_jetton_balance(c, me, j, units).await?;
    Ok(TonBuilt {
        boc,
        summary,
        context: TonContext {
            account,
            destination: jw,
            fee: fee.to_string(),
        },
    })
}

/// Jetton transfer: `amount` in jetton units, `master` = the jetton's master (`EQ…`).
#[tauri::command]
pub async fn ton_build_jetton_tx(
    state: State<'_, AppState>,
    master: String,
    to: String,
    amount: String,
    comment: Option<String>,
    account: Option<u32>,
) -> AppResult<TonBuilt> {
    let (pk, me) = ours(&state, account_arg(account)?)?;
    let req = TransferRequest {
        to: &to,
        amount: &amount,
        comment: comment.as_deref(),
        send_all: false,
        hw: false,
    };
    build_jetton(&ctx(&state), &pk, &me, &master, &req, now()).await
}

#[tauri::command]
pub async fn ton_build_tx(
    state: State<'_, AppState>,
    to: String,
    amount: String,
    comment: Option<String>,
    send_all: Option<bool>,
    account: Option<u32>,
) -> AppResult<TonBuilt> {
    let (pk, me) = ours(&state, account_arg(account)?)?;
    let req = TransferRequest {
        to: &to,
        amount: &amount,
        comment: comment.as_deref(),
        send_all: send_all.unwrap_or(false),
        hw: false,
    };
    build(&ctx(&state), &pk, &me, &req, now()).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TonSignedOut {
    /// Signed external message, BOC (base64): what `ton_broadcast` sends.
    pub boc: String,
    /// Hash of the external message (hex).
    pub hash: String,
    /// Normalized hash (hex, TEP-467): what `ton_tx_status` looks up.
    pub normalized_hash: String,
    pub summary: TonTxSummary,
    pub context: TonContext,
}

/// Refuses a message that is expired (or about to) or valid suspiciously long.
fn check_validity(valid_until: u32, now: u32) -> AppResult<()> {
    if valid_until <= now.saturating_add(15) {
        return Err(AppError::InvalidInput(
            "transfert TON expiré (valable 10 min après sa préparation) : reconstruis-le".into(),
        ));
    }
    if valid_until > now.saturating_add(VALID_FOR_SECS + 120) {
        return Err(AppError::InvalidInput(
            "transfert TON valable trop longtemps (horloge ?) : reconstruis-le".into(),
        ));
    }
    Ok(())
}

/// Decoding + live re-checks, i.e. everything `ton_sign_tx` does before the dialog.
pub(crate) async fn prepare_sign(
    c: &TonCtx<'_>,
    public_key: &[u8; 32],
    me: &TonAddress,
    boc: &str,
    now: u32,
) -> AppResult<(TonTxSummary, TonContext)> {
    let summary = wallet_core::ton_decode_tx(boc, public_key, testnet(c.network))?;
    check_validity(summary.valid_until, now)?;
    let (t, _) = TonTransfer::decode(
        boc,
        public_key,
        wallet_core::ton_wallet_id(testnet(c.network)),
    )?;
    let account = ton_backend::account(c, me).await?;
    let destination = ton_backend::account(c, &t.destination).await?;
    let fresh = match account.status {
        TonStatus::Uninit => summary.deploys_wallet && summary.seqno == 0,
        TonStatus::Active => !summary.deploys_wallet && account.seqno == Some(summary.seqno),
        _ => false,
    };
    if !fresh && matches!(account.status, TonStatus::Active | TonStatus::Uninit) {
        return Err(AppError::InvalidInput(
            "numéro de séquence (seqno) ou état du portefeuille périmé : reconstruis le transfert"
                .into(),
        ));
    }
    let fee = ton_backend::estimate_fee(c, me, &t.estimate_parts()?).await?;
    ton_backend::check_transfer(&TransferCheck {
        ours: &account,
        amount: (!summary.send_all).then_some(t.amount),
        fee,
    })?;
    if let (Some(j), Some(body)) = (&summary.jetton, &t.jetton) {
        check_jetton_balance(c, me, j, body.amount).await?;
    }
    Ok((
        summary,
        TonContext {
            account,
            destination,
            fee: fee.to_string(),
        },
    ))
}

#[tauri::command]
pub async fn ton_sign_tx(
    app: AppHandle,
    state: State<'_, AppState>,
    boc: String,
    password: String,
    account: Option<u32>,
) -> AppResult<TonSignedOut> {
    if !state.is_unlocked() {
        return Err(AppError::Locked);
    }
    let a = account_arg(account)?;
    let (pk, me) = ours(&state, a)?;
    let signer = SignerInfo::new(&state, Chain::Ton, a, wallet_core::ton_path(a));
    let c = ctx(&state);
    let net = state.network;
    let (summary, context) = prepare_sign(&c, &pk, &me, &boc, now()).await?;
    let seed = seed_from_password(&state, Zeroizing::new(password)).await?;
    let lang = crate::i18n::current();
    confirm_native(
        &app,
        lang.pick("Confirmer l'envoi TON", "Confirm the TON send"),
        signer.body(lang, &describe_ton(lang, &summary, &context, net, now())),
    )
    .await?;
    confirm_signer(&app, &signer).await?;
    if summary.requires_extra_confirmation {
        confirm_native(
            &app,
            lang.pick(
                "Attention : transfert à vérifier",
                "Warning: transfer to check",
            ),
            describe_ton_extra(lang, &summary),
        )
        .await?;
    }
    let b = boc.clone();
    let signed = blocking(move || Ok(wallet_core::ton_sign(&seed, a, &b, testnet(net))?)).await?;
    if signed.summary != summary {
        return Err(AppError::Internal(
            "résumé différent entre l'aperçu et la signature".into(),
        ));
    }
    state.touch();
    Ok(TonSignedOut {
        boc: signed.boc,
        hash: signed.hash,
        normalized_hash: signed.normalized_hash,
        summary,
        context,
    })
}

/// Checks the signed BOC (strict decoding, our wallet and network, valid signature, not
/// expired) then sends it. Returns the normalized message hash (hex).
pub(crate) async fn broadcast_checked(
    c: &TonCtx<'_>,
    public_key: &[u8; 32],
    boc: &str,
    now: u32,
) -> AppResult<String> {
    let (t, hash, normalized) =
        wallet_core::ton_verify_signed(boc, public_key, testnet(c.network))?;
    if t.valid_until <= now {
        return Err(AppError::InvalidInput(
            "transfert TON expiré : reconstruis-le".into(),
        ));
    }
    ton_backend::submit(c, boc, &hash, &normalized).await
}

#[tauri::command]
pub async fn ton_broadcast(
    state: State<'_, AppState>,
    boc: String,
    account: Option<u32>,
) -> AppResult<String> {
    let (pk, _) = ours(&state, account_arg(account)?)?;
    broadcast_checked(&ctx(&state), &pk, &boc, now()).await
}

/// `{ found, success, txHash }` of a sent transfer, by its normalized hash.
#[tauri::command]
pub async fn ton_tx_status(state: State<'_, AppState>, hash: String) -> AppResult<TonTxStatus> {
    let h = hash.trim().to_ascii_lowercase();
    if h.len() != 64 || !h.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(AppError::InvalidInput(
            "hash : 64 caractères hexadécimaux".into(),
        ));
    }
    ton_backend::tx_status(&ctx(&state), &h).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summary(comment: Option<&str>, bounce: bool, send_all: bool, deploy: bool) -> TonTxSummary {
        TonTxSummary {
            wallet: "UQDYW_1eScJVxtitoBRksvoV9cCYo4uKGWLVNIHB1JqRRyQx".into(),
            destination: if bounce {
                "EQBm--PFwDv1yCeS-QTJ-L8oiUpqo9IT1BwgVptlSq3ts90Q".into()
            } else {
                "UQBm--PFwDv1yCeS-QTJ-L8oiUpqo9IT1BwgVptlSq3ts4DV".into()
            },
            destination_other: if bounce {
                "UQBm--PFwDv1yCeS-QTJ-L8oiUpqo9IT1BwgVptlSq3ts4DV".into()
            } else {
                "EQBm--PFwDv1yCeS-QTJ-L8oiUpqo9IT1BwgVptlSq3ts90Q".into()
            },
            destination_raw: "0:66fbe3c5c03bf5c82792f904c9f8bf28894a6aa3d213d41c20569b654aadedb3"
                .into(),
            amount: if send_all {
                "0".into()
            } else {
                "1500000000".into()
            },
            send_all,
            bounce,
            comment: comment.map(str::to_owned),
            seqno: if deploy { 0 } else { 7 },
            valid_until: 1_800_000_600,
            deploys_wallet: deploy,
            wallet_id: wallet_core::TON_WALLET_ID_MAINNET,
            warnings: vec![],
            requires_extra_confirmation: false,
            jetton: None,
        }
    }

    fn info(status: TonStatus, balance: &str) -> TonAccountInfo {
        TonAccountInfo {
            address: String::new(),
            raw: String::new(),
            status,
            balance: balance.into(),
            seqno: None,
            wallet_type: None,
        }
    }

    fn context(dest: TonStatus) -> TonContext {
        TonContext {
            account: info(TonStatus::Active, "3000000000"),
            destination: info(dest, "0"),
            fee: "5500000".into(),
        }
    }

    #[test]
    fn dialog_highlights_the_comment_and_both_address_forms() {
        let d = describe_ton(
            Lang::Fr,
            &summary(Some("123456"), true, false, false),
            &context(TonStatus::Active),
            Network::Testnet,
            1_800_000_000,
        );
        for needle in [
            "Envoi TON (testnet)",
            "À : EQBm--PFwDv1yCeS-QTJ-L8oiUpqo9IT1BwgVptlSq3ts90Q\n(même compte que UQBm--PFwDv1yCeS-QTJ-L8oiUpqo9IT1BwgVptlSq3ts4DV",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nCOMMENTAIRE : « 123456 »\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            "Montant : 1,5 GRAM (1500000000 nanotons)",
            "Rebond : oui",
            "Frais estimés : ≈ 0,0055 GRAM",
            "Solde : 3 GRAM",
            "Valable encore ≈ 10 min",
            "seqno 7",
        ] {
            assert!(d.contains(needle), "{needle} missing in:\n{d}");
        }
        assert!(!d.contains("déploie"));
        let d = describe_ton(
            Lang::Fr,
            &summary(None, false, true, true),
            &context(TonStatus::Uninit),
            Network::Mainnet,
            1_800_000_000,
        );
        assert!(d.starts_with("Envoi TON\n"));
        assert!(d.contains("AUCUN COMMENTAIRE"));
        assert!(d.contains("TOUT LE SOLDE, ≈ 3 GRAM"));
        assert!(d.contains("pas encore actif"));
        assert!(d.contains("déploie aussi ton portefeuille"));
        let mut s = summary(Some("x"), true, false, false);
        s.warnings = vec![TonWarning::UnusualText];
        assert!(describe_ton_extra(Lang::Fr, &s).contains("caractères invisibles"));
        assert_eq!(utc_hms(1_800_000_600), "08:10:00");
        let en = describe_ton(
            Lang::En,
            &summary(Some("123456"), true, false, false),
            &context(TonStatus::Active),
            Network::Testnet,
            1_800_000_000,
        );
        assert!(
            en.contains("Amount: 1.5 GRAM (1500000000 nanotons)") && en.contains("Bounce: yes")
        );
    }

    #[test]
    fn validity_window() {
        let now = 1_800_000_000;
        assert!(check_validity(now + VALID_FOR_SECS, now).is_ok());
        assert!(check_validity(now + 10, now).is_err());
        assert!(check_validity(now - 1, now).is_err());
        assert!(check_validity(now + VALID_FOR_SECS + 121, now).is_err());
    }

    #[test]
    fn user_addresses() {
        assert!(parse_user_address(
            "EQBm--PFwDv1yCeS-QTJ-L8oiUpqo9IT1BwgVptlSq3ts90Q",
            Network::Mainnet
        )
        .is_ok());
        // Testnet-only flag: refused on mainnet, accepted on testnet.
        assert!(parse_user_address(
            "kQCKhieGGl3ZbJ2zzggHsSLaXtRzk0znVopbSxw2HLsorvzv",
            Network::Mainnet
        )
        .is_err());
        assert!(parse_user_address(
            "kQCKhieGGl3ZbJ2zzggHsSLaXtRzk0znVopbSxw2HLsorvzv",
            Network::Testnet
        )
        .is_ok());
        assert!(parse_user_address(
            "Ef8JfFPRpHBV_tZpCurvxMJW69nt2js3SuGEWojGnOpCVPRe",
            Network::Mainnet
        )
        .is_err());
        assert!(parse_user_address(
            "0:66fbe3c5c03bf5c82792f904c9f8bf28894a6aa3d213d41c20569b654aadedb3",
            Network::Mainnet
        )
        .is_err());
        assert_eq!(amount_of("10", false).unwrap(), 10);
        assert!(
            amount_of("0", false).is_err()
                && amount_of("-1", false).is_err()
                && amount_of("1.5", false).is_err()
        );
        assert_eq!(amount_of("whatever", true).unwrap(), 0);
    }
}

/// Real-network test on TON testnet over Tor. Run with
/// `cargo test -p kyro-desktop -- --ignored --nocapture ton_live`.
/// - keys: a NEW random test mnemonic, generated once and kept in the gitignored
///   `.env.ton-testnet` at the repository root (testnet only);
/// - always: account state, history, a transfer built by the real path (`build`,
///   `prepare_sign`, dialog text, signature), and TON Center's emulation of the *signed*
///   message (`estimateFee` with the signature checked) — accepted with Kyro's signature,
///   refused with a corrupted one;
/// - `KYRO_TON_SEND=yes` (and a funded address): broadcast, then wait for the transaction.
#[cfg(test)]
mod live {
    use super::*;
    use crate::net::NetClient;
    use crate::tor::TorState;

    fn test_seed() -> wallet_core::Seed {
        let path =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../.env.ton-testnet");
        let words = match std::fs::read_to_string(&path) {
            Ok(s) => s
                .lines()
                .find_map(|l| l.strip_prefix("KYRO_TON_TEST_MNEMONIC="))
                .expect("mnemonic line")
                .trim()
                .to_owned(),
            Err(_) => {
                let m = wallet_core::Mnemonic::generate(wallet_core::WordCount::W12).unwrap();
                let w = m.words().join(" ");
                std::fs::write(
                    &path,
                    format!("# TON TESTNET ONLY — random test mnemonic generated by Kyro's live test (commands_ton.rs).\n# Never use it for real funds. This file is gitignored (.env.*).\nKYRO_TON_TEST_MNEMONIC={w}\n"),
                )
                .unwrap();
                eprintln!("new test mnemonic written to {}", path.display());
                w
            }
        };
        wallet_core::Mnemonic::parse(&words).unwrap().to_seed("")
    }

    #[test]
    #[ignore]
    fn ton_live_testnet_over_tor() {
        let net = NetClient::new(std::env::temp_dir().join("kyro-ton-live")).unwrap();
        let seed = test_seed();
        let tor = std::env::var("KYRO_TON_CLEAR").as_deref() != Ok("yes");
        tauri::async_runtime::block_on(async {
            if tor {
                net.tor.restart();
                while net.tor.status().state != TorState::Ready {
                    assert_ne!(net.tor.status().state, TorState::Error);
                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                }
            }
            let c = TonCtx {
                net_client: &net,
                network: Network::Testnet,
                tor,
                api_key: None,
            };
            let pk = wallet_core::ton_public_key(&seed, 0).unwrap();
            let me =
                wallet_core::ton_wallet_address(&pk, wallet_core::TON_WALLET_ID_TESTNET).unwrap();
            let me_s = me.to_friendly(false, true);
            let other = wallet_core::ton_address(&seed, 1, true).unwrap();
            eprintln!("address (tor: {tor}): {me_s}, recipient {other}");
            let t = std::time::Instant::now();
            let acc = ton_backend::account(&c, &me).await.unwrap();
            eprintln!("account {acc:?} in {:.1?}", t.elapsed());
            eprintln!("history {:?}", ton_backend::txs(&c, &me).await.unwrap());
            // A well-known mainnet wallet read over the mainnet host (Trust Wallet's vector).
            let main = TonCtx {
                net_client: &net,
                network: Network::Mainnet,
                tor,
                api_key: None,
            };
            let twc =
                wallet_core::ton_parse_address("UQDYW_1eScJVxtitoBRksvoV9cCYo4uKGWLVNIHB1JqRRyQx")
                    .unwrap()
                    .address;
            let a = ton_backend::account(&main, &twc).await.unwrap();
            eprintln!("mainnet TWC wallet {a:?}");
            assert_eq!(a.wallet_type.as_deref(), Some("wallet v4 r2"));
            let h = ton_backend::txs(&main, &twc).await.unwrap();
            eprintln!(
                "mainnet TWC history: {} lines, first {:?}",
                h.len(),
                h.first()
            );

            let balance: u64 = acc.balance.parse().unwrap_or(0);
            if balance == 0 {
                // Unfunded: build is refused before anything is signed.
                let req = TransferRequest {
                    to: &other,
                    amount: "1000000",
                    comment: Some("kyro"),
                    send_all: false,
                    hw: false,
                };
                let r = build(&c, &pk, &me, &req, now()).await;
                eprintln!("unfunded build: {:?}", r.as_ref().err());
                assert!(matches!(r, Err(AppError::InvalidInput(_))));
                eprintln!("fund {me_s} on testnet (e.g. @testgiver_ton_bot) to test a transfer");
                return;
            }
            let req = TransferRequest {
                to: &other,
                amount: "10000000",
                comment: Some("Kyro test"),
                send_all: false,
                hw: false,
            };
            let built = build(&c, &pk, &me, &req, now()).await.unwrap();
            let (summary, context) = prepare_sign(&c, &pk, &me, &built.boc, now()).await.unwrap();
            assert_eq!(summary, built.summary);
            eprintln!(
                "--- dialog ---\n{}---",
                describe_ton(Lang::Fr, &summary, &context, Network::Testnet, now())
            );
            let signed = wallet_core::ton_sign(&seed, 0, &built.boc, true).unwrap();
            assert_eq!(signed.summary, summary);
            // The real v4R2 contract, emulated by TON Center's node, checks Kyro's signature.
            let (t, sig) =
                TonTransfer::decode(&signed.boc, &pk, wallet_core::TON_WALLET_ID_TESTNET).unwrap();
            let good =
                ton_backend::emulate(&c, &me, &t.estimate_parts_signed(&sig).unwrap(), false).await;
            let mut broken = sig;
            broken[10] ^= 1;
            let bad =
                ton_backend::emulate(&c, &me, &t.estimate_parts_signed(&broken).unwrap(), false)
                    .await;
            eprintln!("emulation with Kyro's signature: {good:?}; with a corrupted one: {bad:?}");
            assert!(good.is_ok() && bad.is_err());
            if std::env::var("KYRO_TON_SEND").as_deref() != Ok("yes") {
                eprintln!("KYRO_TON_SEND != yes: no broadcast");
                return;
            }
            let id = broadcast_checked(&c, &pk, &signed.boc, now())
                .await
                .unwrap();
            assert_eq!(id, signed.normalized_hash);
            eprintln!("SENT {id}");
            for _ in 0..40 {
                tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                let s = ton_backend::tx_status(&c, &id).await.unwrap();
                if s.found {
                    eprintln!("processed: {s:?}");
                    assert!(s.success);
                    eprintln!(
                        "recipient now {:?}",
                        ton_backend::account(
                            &c,
                            &wallet_core::ton_parse_address(&other).unwrap().address
                        )
                        .await
                        .unwrap()
                    );
                    return;
                }
            }
            panic!("{id} not processed");
        });
    }
}
