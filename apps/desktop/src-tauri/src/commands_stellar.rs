//! IPC commands for Stellar (`stellar_*`): address, account (balance, reserve, spendable, memo
//! required), history, XLM payment building **by Kyro** (Payment, or CreateAccount for an
//! unfunded destination; sequence / fee / time bounds from Horizon, encoded by wallet-core),
//! signing behind the password and the native dialog (memo highlighted, reserve re-read live),
//! and submission with hash check. Contract: docs/IPC.md §2.11.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, State};
use wallet_core::{
    Network, StellarAsset, StellarAssetView, StellarEnvelope, StellarKnownAsset, StellarMemo,
    StellarMemoView, StellarOp, StellarOpView, StellarOperation, StellarTransaction,
    StellarTxSummary, StellarWarning, STELLAR_MAX_MEMO_TEXT,
};
use zeroize::Zeroizing;

use crate::accounts::{account_arg, confirm_signer, Chain, SignerInfo};
use crate::commands::{
    blocking, confirm_native, format_units_in, network_name, seed_from_password,
};
use crate::error::{AppError, AppResult};
use crate::i18n::Lang;
use crate::state::AppState;
use crate::stellar_backend::{
    self, PaymentCheck, StellarAccountInfo, StellarCtx, StellarLedger, MIN_REMAINING_SECS,
    VALIDITY_SECS,
};

pub(crate) fn ctx(state: &AppState) -> StellarCtx<'_> {
    StellarCtx {
        net_client: &state.net,
        network: state.network,
        tor: state.settings().tor.enabled,
    }
}

/// Address of Stellar account `account` (`m/44'/148'/account'`).
fn ours(state: &AppState, account: u32) -> AppResult<String> {
    state.with_seed(|seed| Ok(wallet_core::stellar_address(seed, account)?))
}

/// Memo requested by the interface.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum MemoSpec {
    /// UTF-8 text, at most 28 bytes, no control or invisible character.
    Text { value: String },
    /// Unsigned 64-bit id, decimal (exchanges' usual "memo").
    Id { value: String },
    /// 32 bytes, 64 hexadecimal characters.
    Hash { value: String },
}

pub fn parse_memo(m: Option<&MemoSpec>) -> AppResult<StellarMemo> {
    let bad = |m: &str| AppError::InvalidInput(m.into());
    Ok(match m {
        None => StellarMemo::None,
        Some(MemoSpec::Text { value }) => {
            if value.is_empty() {
                return Ok(StellarMemo::None);
            }
            if value.len() > STELLAR_MAX_MEMO_TEXT {
                return Err(bad("mémo texte : 28 octets au plus"));
            }
            if value
                .chars()
                .any(|c| c.is_control() || crate::dialog_text::is_invisible(c))
            {
                return Err(bad(
                    "mémo texte : caractère de contrôle ou invisible refusé",
                ));
            }
            StellarMemo::Text(value.as_bytes().to_vec())
        }
        Some(MemoSpec::Id { value }) => {
            let v = value.trim();
            if v.is_empty() || v.len() > 20 || !v.bytes().all(|b| b.is_ascii_digit()) {
                return Err(bad("mémo identifiant : un nombre entier positif"));
            }
            StellarMemo::Id(
                v.parse()
                    .map_err(|_| bad("mémo identifiant : au plus 18446744073709551615"))?,
            )
        }
        Some(MemoSpec::Hash { value }) => {
            let v = value.trim();
            let raw = hex::decode(v).map_err(|_| bad("mémo hash : 64 caractères hexadécimaux"))?;
            StellarMemo::Hash(
                raw.try_into()
                    .map_err(|_| bad("mémo hash : 64 caractères hexadécimaux"))?,
            )
        }
    })
}

/// Live context shown in the dialog.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StellarContext {
    pub account: StellarAccountInfo,
    pub destination: StellarAccountInfo,
    /// Stroops.
    pub base_reserve: String,
    /// Stroops per operation.
    pub base_fee: u32,
    /// Close time of the latest ledger, UNIX seconds.
    pub ledger_time: u64,
}

fn memo_block(lang: Lang, m: &StellarMemoView) -> String {
    match (m, lang) {
        (StellarMemoView::None, Lang::Fr) => "AUCUN MÉMO\n(une plateforme d'échange en exige souvent un : sans lui, les fonds peuvent être perdus)\n".into(),
        (StellarMemoView::None, Lang::En) => "NO MEMO\n(an exchange often requires one: without it, the funds can be lost)\n".into(),
        (StellarMemoView::Text { text: Some(t), .. }, _) => format!(
            "{}{}\n",
            lang.pick("MÉMO (texte) : ", "MEMO (text): "),
            crate::dialog_text::field(t, STELLAR_MAX_MEMO_TEXT)
        ),
        (StellarMemoView::Text { text: None, hex }, _) => format!(
            "{}{hex}\n",
            lang.pick("MÉMO (texte non lisible, octets) : ", "MEMO (unreadable text, bytes): ")
        ),
        (StellarMemoView::Id { id }, _) => {
            format!("{}{id}\n", lang.pick("MÉMO (identifiant) : ", "MEMO (ID): "))
        }
        (StellarMemoView::Hash { hex }, _) => {
            format!("{}{hex}\n", lang.pick("MÉMO (hash) : ", "MEMO (hash): "))
        }
        (StellarMemoView::Return { hex }, _) => format!(
            "{}{hex}\n",
            lang.pick("MÉMO (remboursement) : ", "MEMO (return): ")
        ),
    }
}

/// The known asset an asset view names on `net` (exact code and issuer), if any.
fn known_view(a: &StellarAssetView, net: Network) -> Option<&'static StellarKnownAsset> {
    match a {
        StellarAssetView::Credit { code, issuer } => {
            wallet_core::stellar_known_asset(code, issuer, net)
        }
        StellarAssetView::Native => None,
    }
}

/// « Verified issuer » line of a known asset.
fn verified_line(lang: Lang, k: &StellarKnownAsset) -> String {
    match lang {
        Lang::Fr => format!(
            "Émetteur vérifié par Kyro : {} — {}\n",
            k.issuer_name, k.issuer
        ),
        Lang::En => format!(
            "Issuer verified by Kyro: {} — {}\n",
            k.issuer_name, k.issuer
        ),
    }
}

fn asset_text(lang: Lang, a: &StellarAssetView) -> String {
    match a {
        StellarAssetView::Native => "XLM".into(),
        StellarAssetView::Credit { code, issuer } => format!(
            "{} ({} {issuer})",
            crate::dialog_text::sanitize(code, 12),
            lang.pick("émis par", "issued by")
        ),
    }
}

/// Body of the native dialog. The memo gets its own framed block, whatever it is.
pub(crate) fn describe_stellar(lang: Lang, s: &StellarTxSummary, c: &StellarContext) -> String {
    let line = "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━";
    let xlm = |v: &str| format!("{} XLM", format_units_in(lang, v, 7));
    let testnet = if s.network == Network::Testnet {
        " (testnet)"
    } else {
        ""
    };
    let (title, to) = match &s.operation {
        StellarOpView::Payment { destination, .. } => (
            lang.pick("Envoi Stellar", "Stellar send"),
            destination.as_str(),
        ),
        StellarOpView::CreateAccount { destination, .. } => (
            lang.pick(
                "Envoi Stellar — création de compte",
                "Stellar send — account creation",
            ),
            destination.as_str(),
        ),
        StellarOpView::ChangeTrust { .. } => (
            lang.pick("Ligne de confiance Stellar", "Stellar trustline"),
            "",
        ),
    };
    let mut out = format!("{title}{testnet}\n\n");
    if !to.is_empty() {
        out += &format!(
            "{}{to}\n{line}\n{}{line}\n",
            lang.pick("À : ", "To: "),
            memo_block(lang, &s.memo)
        );
    }
    let amount_label = lang.pick("Montant : ", "Amount: ");
    match &s.operation {
        StellarOpView::Payment { asset, amount, .. } => {
            out += &match asset {
                StellarAssetView::Native => {
                    format!("{amount_label}{} ({amount} stroops)\n", xlm(amount))
                }
                other => {
                    let mut t = format!(
                        "{amount_label}{} {} ({amount} {})\n",
                        format_units_in(lang, amount, 7),
                        asset_text(lang, other),
                        lang.pick("unités, 7 décimales", "units, 7 decimals")
                    );
                    if let Some(k) = known_view(other, s.network) {
                        t += &verified_line(lang, k);
                    }
                    t
                }
            };
        }
        StellarOpView::CreateAccount {
            starting_balance, ..
        } => {
            let reserve = xlm(&(2 * c.base_reserve.parse::<i64>().unwrap_or(0)).to_string());
            let base = xlm(&c.base_reserve);
            out += &format!(
                "{amount_label}{} ({starting_balance} stroops)\n\n",
                xlm(starting_balance)
            );
            out += &match lang {
                Lang::Fr => format!("Ce compte n'existe pas encore : cet envoi le crée (opération CreateAccount). {reserve} de réserve y reste bloqué (2 × {base}).\n"),
                Lang::En => format!("This account does not exist yet: this send creates it (CreateAccount operation). {reserve} of reserve stays locked on it (2 × {base}).\n"),
            };
        }
        StellarOpView::ChangeTrust { asset, limit } => {
            let lim = if limit == &i64::MAX.to_string() {
                lang.pick("aucune", "none").to_owned()
            } else {
                format_units_in(lang, limit, 7)
            };
            let what = if limit == "0" {
                lang.pick("Suppression de la ligne de confiance", "Trustline removal")
            } else {
                lang.pick("Ajout d'une ligne de confiance", "Trustline addition")
            };
            out += &match lang {
                Lang::Fr => format!(
                    "{what} : {}\nLimite : {lim}\nChaque ligne de confiance bloque {} de réserve.\n",
                    asset_text(lang, asset),
                    xlm(&c.base_reserve)
                ),
                Lang::En => format!(
                    "{what}: {}\nLimit: {lim}\nEach trustline locks {} of reserve.\n",
                    asset_text(lang, asset),
                    xlm(&c.base_reserve)
                ),
            };
            if let Some(k) = known_view(asset, s.network) {
                out += &verified_line(lang, k);
            }
            out += if limit == "0" {
                lang.pick(
                    "Tu ne pourras plus recevoir cet actif ; la réserve redevient disponible.\n",
                    "You will no longer be able to receive this asset; the reserve becomes available again.\n",
                )
            } else {
                lang.pick(
                    "Ton compte pourra recevoir cet actif ; la réserve reste bloquée tant que la ligne existe (rendue quand tu la supprimes, solde à 0).\n",
                    "Your account will be able to receive this asset; the reserve stays locked while the line exists (given back when you remove it, at a zero balance).\n",
                )
            };
            out += &memo_block(lang, &s.memo);
        }
    }
    let a = &c.account;
    let minutes = s.max_time.saturating_sub(c.ledger_time).div_ceil(60);
    let until = stellar_backend::format_utc(s.max_time);
    let pass = wallet_core::stellar_network_passphrase(s.network);
    out += &match lang {
        Lang::Fr => format!(
            "\nFrais maximum : {} ({} stroops ; d'habitude seuls {} stroops sont prélevés)\nSolde : {} · réserve bloquée : {} ((2 + {} entrée(s)) × {}) · disponible : {}\nValable jusqu'au {until} (≈ {minutes} min), séquence {}\nRéseau signé : « {pass} »\n",
            xlm(&s.fee), s.fee, c.base_fee,
            xlm(&a.balance), xlm(&a.reserve), a.subentry_count, xlm(&c.base_reserve), xlm(&a.spendable),
            s.sequence
        ),
        Lang::En => format!(
            "\nMaximum fee: {} ({} stroops; usually only {} stroops are charged)\nBalance: {} · locked reserve: {} ((2 + {} entr(ies)) × {}) · available: {}\nValid until {until} (≈ {minutes} min), sequence {}\nSigned network: “{pass}”\n",
            xlm(&s.fee), s.fee, c.base_fee,
            xlm(&a.balance), xlm(&a.reserve), a.subentry_count, xlm(&c.base_reserve), xlm(&a.spendable),
            s.sequence
        ),
    };
    out
}

pub(crate) fn describe_stellar_extra(lang: Lang, s: &StellarTxSummary) -> String {
    let mut out = String::from(lang.unusual_intro());
    for w in &s.warnings {
        out += match w {
            StellarWarning::HighFee => lang.pick(
                "• frais maximum supérieurs à 0,01 XLM (d'habitude 100 stroops)\n",
                "• maximum fee above 0.01 XLM (usually 100 stroops)\n",
            ),
            StellarWarning::UnusualText => lang.pick(
                "• mémo contenant des caractères invisibles / de contrôle, ou illisible (affiché nettoyé)\n",
                "• memo with invisible / control characters, or unreadable (shown cleaned)\n",
            ),
            StellarWarning::MemoReturn => lang.pick(
                "• mémo de type « remboursement » (MEMO_RETURN)\n",
                "• “return” memo (MEMO_RETURN)\n",
            ),
            StellarWarning::RemoveTrustline => lang.pick(
                "• suppression d'une ligne de confiance (l'actif ne pourra plus être reçu)\n",
                "• trustline removal (the asset can no longer be received)\n",
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
pub struct StellarBackendInfo {
    pub kind: &'static str,
    pub network: &'static str,
    pub label: &'static str,
    pub tor: bool,
}

#[tauri::command]
pub fn stellar_backend_info(state: State<'_, AppState>) -> StellarBackendInfo {
    let c = ctx(&state);
    StellarBackendInfo {
        kind: "default",
        network: network_name(state.network),
        label: stellar_backend::host(state.network),
        tor: c.tor,
    }
}

/// Address of Stellar account `account` (absent = 0).
#[tauri::command]
pub fn stellar_address(state: State<'_, AppState>, account: Option<u32>) -> AppResult<String> {
    ours(&state, account_arg(account)?)
}

#[tauri::command]
pub async fn stellar_account(
    state: State<'_, AppState>,
    address: String,
) -> AppResult<StellarAccountInfo> {
    let c = ctx(&state);
    let ledger = stellar_backend::latest_ledger(&c).await?;
    stellar_backend::account(&c, &address, &ledger).await
}

#[tauri::command]
pub async fn stellar_txs(state: State<'_, AppState>, address: String) -> AppResult<Value> {
    stellar_backend::payments(&ctx(&state), &address).await
}

// ---------------------------------------------------------------- build, sign, broadcast

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StellarBuilt {
    /// Unsigned `TransactionEnvelope`, base64: what `stellar_sign_tx` signs.
    pub envelope: String,
    pub summary: StellarTxSummary,
    pub context: StellarContext,
}

async fn live_context(
    c: &StellarCtx<'_>,
    me: &str,
    to: &str,
) -> AppResult<(StellarLedger, StellarContext)> {
    stellar_backend::check_network(c).await?;
    let ledger = stellar_backend::latest_ledger(c).await?;
    let account = stellar_backend::account(c, me, &ledger).await?;
    let destination = stellar_backend::account(c, to, &ledger).await?;
    Ok((
        ledger,
        StellarContext {
            account,
            destination,
            base_reserve: ledger.base_reserve.to_string(),
            base_fee: ledger.base_fee,
            ledger_time: ledger.closed_at,
        },
    ))
}

fn next_sequence(a: &StellarAccountInfo) -> AppResult<i64> {
    a.sequence
        .parse::<i64>()
        .ok()
        .and_then(|s| s.checked_add(1))
        .ok_or_else(|| AppError::ServerUnreachable("Horizon : numéro de séquence invalide".into()))
}

/// Builds an unsigned XLM transfer from live data: a Payment, or a CreateAccount when the
/// destination does not exist yet. `stroops` is the amount, in stroops.
pub(crate) async fn build(
    c: &StellarCtx<'_>,
    me: &str,
    to: &str,
    stroops: &str,
    memo: Option<&MemoSpec>,
) -> AppResult<StellarBuilt> {
    let source = wallet_core::stellar_account_id(me)?;
    let destination = wallet_core::stellar_account_id(to)?;
    let amount: i64 = stroops
        .trim()
        .parse()
        .ok()
        .filter(|a| *a > 0)
        .ok_or_else(|| AppError::InvalidInput("montant en stroops invalide".into()))?;
    let memo = parse_memo(memo)?;
    let (ledger, context) = live_context(c, me, to).await?;
    let fee = stellar_backend::fee(c, &ledger).await?;
    stellar_backend::check_payment(&PaymentCheck {
        ours: &context.account,
        dest: &context.destination,
        ledger: &ledger,
        stroops: amount,
        fee,
        has_memo: memo != StellarMemo::None,
    })?;
    let body = if context.destination.exists {
        StellarOperation::Payment {
            destination,
            asset: StellarAsset::Native,
            amount,
        }
    } else {
        StellarOperation::CreateAccount {
            destination,
            starting_balance: amount,
        }
    };
    let tx = StellarTransaction {
        source,
        fee,
        sequence: next_sequence(&context.account)?,
        time_bounds: Some((0, ledger.closed_at + VALIDITY_SECS)),
        memo,
        operations: vec![StellarOp { source: None, body }],
    };
    let envelope = StellarEnvelope {
        tx,
        signatures: vec![],
    }
    .to_base64();
    let summary = wallet_core::stellar_decode_tx(&envelope, me, c.network)?;
    Ok(StellarBuilt {
        envelope,
        summary,
        context,
    })
}

fn known_asset(net: Network, id: &str) -> AppResult<&'static StellarKnownAsset> {
    let (code, issuer) = id
        .trim()
        .split_once('-')
        .ok_or_else(|| AppError::InvalidInput("actif Stellar : CODE-ÉMETTEUR attendu".into()))?;
    wallet_core::stellar_known_asset(code, issuer, net)
        .ok_or_else(|| AppError::InvalidInput("actif Stellar inconnu de Kyro sur ce réseau".into()))
}

fn trustline<'a>(
    a: &'a StellarAccountInfo,
    k: &StellarKnownAsset,
) -> Option<&'a stellar_backend::StellarTrustline> {
    a.trustlines
        .iter()
        .find(|t| t.code == k.code && t.issuer == k.issuer)
}

/// Checks of a known-asset payment against live data: both accounts exist, the recipient trusts
/// the asset (authorized, room under its limit) and takes a memo if it requires one; our
/// trustline holds the amount; our XLM covers the fee.
fn check_asset_payment(
    k: &StellarKnownAsset,
    c: &StellarContext,
    amount: i64,
    fee: u32,
    has_memo: bool,
) -> AppResult<()> {
    if !c.account.exists {
        return Err(AppError::InvalidInput(
            "ton compte Stellar n'est pas encore activé : il doit d'abord recevoir au moins 1 XLM"
                .into(),
        ));
    }
    if amount <= 0 {
        return Err(AppError::InvalidInput("montant nul".into()));
    }
    if !c.destination.exists {
        return Err(AppError::InvalidInput(format!(
            "ce compte Stellar n'existe pas : il doit d'abord être activé (XLM) puis accepter {}",
            k.code
        )));
    }
    if c.destination.memo_required && !has_memo {
        return Err(AppError::InvalidInput(
            "ce destinataire exige un mémo (SEP-0029, souvent une plateforme d'échange) : ajoute-le, sinon les fonds risquent d'être perdus".into(),
        ));
    }
    let Some(dest) = trustline(&c.destination, k) else {
        return Err(AppError::InvalidInput(format!(
            "le destinataire n'a pas de ligne de confiance pour {} (émis par {}) : il doit d'abord l'activer, sinon le paiement est refusé",
            k.code, k.issuer_name
        )));
    };
    if !dest.authorized {
        return Err(AppError::InvalidInput(format!(
            "l'émetteur de {} n'autorise pas ce destinataire",
            k.code
        )));
    }
    let room = dest.limit.parse::<i64>().unwrap_or(0) - dest.balance.parse::<i64>().unwrap_or(0);
    if amount > room {
        return Err(AppError::InvalidInput(
            "la ligne de confiance du destinataire est pleine (limite atteinte)".into(),
        ));
    }
    let have = trustline(&c.account, k)
        .and_then(|t| t.balance.parse::<i64>().ok())
        .unwrap_or(0);
    if amount > have {
        return Err(AppError::InvalidInput(format!(
            "solde {} insuffisant : {} {}",
            k.code,
            crate::commands::format_units(&have.to_string(), 7),
            k.code
        )));
    }
    let spendable: i64 = c.account.spendable.parse().unwrap_or(0);
    if i64::from(fee) > spendable {
        return Err(AppError::InvalidInput(
            "pas assez de XLM disponibles pour les frais (solde − réserve)".into(),
        ));
    }
    Ok(())
}

/// Checks of a trustline change: enabling needs one more base reserve available (+ fee) and no
/// existing line; removing needs an existing line with a zero balance.
fn check_trust(k: &StellarKnownAsset, c: &StellarContext, enable: bool, fee: u32) -> AppResult<()> {
    if !c.account.exists {
        return Err(AppError::InvalidInput(
            "ton compte Stellar n'est pas encore activé : il doit d'abord recevoir au moins 1 XLM"
                .into(),
        ));
    }
    let spendable: i64 = c.account.spendable.parse().unwrap_or(0);
    let line = trustline(&c.account, k);
    if enable {
        if line.is_some() {
            return Err(AppError::InvalidInput(format!(
                "{} est déjà activé sur ce compte",
                k.code
            )));
        }
        let reserve: i64 = c.base_reserve.parse().unwrap_or(0);
        let need = reserve.saturating_add(i64::from(fee));
        if need > spendable {
            return Err(AppError::InvalidInput(format!(
                "pas assez de XLM disponibles : la ligne de confiance bloque {} XLM de réserve (+ frais), tu as {} XLM disponibles",
                crate::commands::format_units(&reserve.to_string(), 7),
                crate::commands::format_units(&spendable.to_string(), 7)
            )));
        }
    } else {
        let Some(l) = line else {
            return Err(AppError::InvalidInput(format!(
                "{} n'est pas activé sur ce compte",
                k.code
            )));
        };
        if l.balance != "0" {
            return Err(AppError::InvalidInput(format!(
                "il te reste {} {} : envoie-les d'abord, une ligne de confiance ne se supprime qu'à solde nul",
                crate::commands::format_units(&l.balance, 7),
                k.code
            )));
        }
        if i64::from(fee) > spendable {
            return Err(AppError::InvalidInput(
                "pas assez de XLM disponibles pour les frais".into(),
            ));
        }
    }
    Ok(())
}

fn envelope_of(tx: StellarTransaction) -> String {
    StellarEnvelope {
        tx,
        signatures: vec![],
    }
    .to_base64()
}

/// Builds an unsigned payment of `amount` units (7 decimals) of the known asset `asset_id`
/// (`CODE-ISSUER`) to `to`.
pub(crate) async fn build_asset(
    c: &StellarCtx<'_>,
    me: &str,
    to: &str,
    asset_id: &str,
    amount: &str,
    memo: Option<&MemoSpec>,
) -> AppResult<StellarBuilt> {
    let k = known_asset(c.network, asset_id)?;
    let source = wallet_core::stellar_account_id(me)?;
    let destination = wallet_core::stellar_account_id(to)?;
    let amount: i64 = amount
        .trim()
        .parse()
        .ok()
        .filter(|a| *a > 0)
        .ok_or_else(|| AppError::InvalidInput("montant d'actif invalide".into()))?;
    let memo = parse_memo(memo)?;
    let (ledger, context) = live_context(c, me, to).await?;
    let fee = stellar_backend::fee(c, &ledger).await?;
    check_asset_payment(k, &context, amount, fee, memo != StellarMemo::None)?;
    let envelope = envelope_of(StellarTransaction {
        source,
        fee,
        sequence: next_sequence(&context.account)?,
        time_bounds: Some((0, ledger.closed_at + VALIDITY_SECS)),
        memo,
        operations: vec![StellarOp {
            source: None,
            body: StellarOperation::Payment {
                destination,
                asset: k.asset(),
                amount,
            },
        }],
    });
    let summary = wallet_core::stellar_decode_tx(&envelope, me, c.network)?;
    Ok(StellarBuilt {
        envelope,
        summary,
        context,
    })
}

/// Builds an unsigned `ChangeTrust` for the known asset `asset_id`: no limit (`enable`) or
/// limit 0 (removal, at a zero balance).
pub(crate) async fn build_trust(
    c: &StellarCtx<'_>,
    me: &str,
    asset_id: &str,
    enable: bool,
) -> AppResult<StellarBuilt> {
    let k = known_asset(c.network, asset_id)?;
    let source = wallet_core::stellar_account_id(me)?;
    let (ledger, context) = live_context(c, me, me).await?;
    let fee = stellar_backend::fee(c, &ledger).await?;
    check_trust(k, &context, enable, fee)?;
    let envelope = envelope_of(StellarTransaction {
        source,
        fee,
        sequence: next_sequence(&context.account)?,
        time_bounds: Some((0, ledger.closed_at + VALIDITY_SECS)),
        memo: StellarMemo::None,
        operations: vec![StellarOp {
            source: None,
            body: StellarOperation::ChangeTrust {
                asset: k.asset(),
                limit: if enable { i64::MAX } else { 0 },
            },
        }],
    });
    let summary = wallet_core::stellar_decode_tx(&envelope, me, c.network)?;
    Ok(StellarBuilt {
        envelope,
        summary,
        context,
    })
}

/// Payment of a known issued asset (Circle's USDC): `asset` = `CODE-ISSUER`, `amount` in units
/// of 7 decimals.
#[tauri::command]
pub async fn stellar_build_asset_tx(
    state: State<'_, AppState>,
    asset: String,
    to: String,
    amount: String,
    memo: Option<MemoSpec>,
    account: Option<u32>,
) -> AppResult<StellarBuilt> {
    let me = ours(&state, account_arg(account)?)?;
    build_asset(&ctx(&state), &me, &to, &asset, &amount, memo.as_ref()).await
}

/// Trustline for a known issued asset: `enable: true` opens it (one base reserve locked),
/// `false` removes it (zero balance only).
#[tauri::command]
pub async fn stellar_build_trust_tx(
    state: State<'_, AppState>,
    asset: String,
    enable: bool,
    account: Option<u32>,
) -> AppResult<StellarBuilt> {
    let me = ours(&state, account_arg(account)?)?;
    build_trust(&ctx(&state), &me, &asset, enable).await
}

#[tauri::command]
pub async fn stellar_build_tx(
    state: State<'_, AppState>,
    to: String,
    amount: String,
    memo: Option<MemoSpec>,
    account: Option<u32>,
) -> AppResult<StellarBuilt> {
    let me = ours(&state, account_arg(account)?)?;
    build(&ctx(&state), &me, &to, &amount, memo.as_ref()).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StellarSigned {
    /// Signed envelope, base64: what `stellar_broadcast` submits.
    pub envelope: String,
    pub hash: String,
    pub summary: StellarTxSummary,
    pub context: StellarContext,
}

/// What a decoded transaction is, among the shapes Kyro builds.
enum Shape<'a> {
    /// XLM payment or account creation.
    Xlm { stroops: &'a str, creates: bool },
    /// Payment of a known issued asset.
    Asset {
        k: &'static StellarKnownAsset,
        amount: &'a str,
    },
    /// Trustline of a known issued asset.
    Trust {
        k: &'static StellarKnownAsset,
        enable: bool,
    },
}

/// Decoding + live re-checks, i.e. everything `stellar_sign_tx` does before the dialog. Signed:
/// XLM transfers, payments of a known asset (Circle's USDC) and trustlines of a known asset.
pub(crate) async fn prepare_sign(
    c: &StellarCtx<'_>,
    me: &str,
    envelope: &str,
) -> AppResult<(StellarTxSummary, StellarContext)> {
    let summary = wallet_core::stellar_decode_tx(envelope, me, c.network)?;
    let unknown = || {
        AppError::InvalidInput(
            "Kyro ne signe que des envois de XLM et des actifs qu'il connaît (USDC de Circle)"
                .into(),
        )
    };
    let (to, shape) = match &summary.operation {
        StellarOpView::Payment {
            destination,
            asset: StellarAssetView::Native,
            amount,
        } => (
            destination.clone(),
            Shape::Xlm {
                stroops: amount,
                creates: false,
            },
        ),
        StellarOpView::CreateAccount {
            destination,
            starting_balance,
        } => (
            destination.clone(),
            Shape::Xlm {
                stroops: starting_balance,
                creates: true,
            },
        ),
        StellarOpView::Payment {
            destination,
            asset,
            amount,
        } => (
            destination.clone(),
            Shape::Asset {
                k: known_view(asset, c.network).ok_or_else(unknown)?,
                amount,
            },
        ),
        StellarOpView::ChangeTrust { asset, limit } => {
            let enable = if limit == &i64::MAX.to_string() {
                true
            } else if limit == "0" {
                false
            } else {
                return Err(unknown());
            };
            (
                me.to_owned(),
                Shape::Trust {
                    k: known_view(asset, c.network).ok_or_else(unknown)?,
                    enable,
                },
            )
        }
    };
    let (ledger, context) = live_context(c, me, &to).await?;
    if summary.max_time <= ledger.closed_at + MIN_REMAINING_SECS {
        return Err(AppError::InvalidInput(
            "transaction Stellar expirée (limite de temps presque atteinte) : reconstruis-la"
                .into(),
        ));
    }
    if summary.max_time > ledger.closed_at + VALIDITY_SECS {
        return Err(AppError::InvalidInput(
            "limite de temps trop lointaine (au plus 5 minutes) : reconstruis la transaction"
                .into(),
        ));
    }
    if summary.sequence != next_sequence(&context.account)?.to_string() {
        return Err(AppError::InvalidInput(
            "numéro de séquence périmé : reconstruis la transaction".into(),
        ));
    }
    let fee: u32 = summary.fee.parse().unwrap_or(u32::MAX);
    let has_memo = summary.memo != StellarMemoView::None;
    match shape {
        Shape::Xlm { stroops, creates } => {
            if creates == context.destination.exists {
                return Err(AppError::InvalidInput(
                    if creates {
                        "ce compte existe maintenant : reconstruis la transaction (paiement simple)"
                    } else {
                        "ce compte n'existe pas : reconstruis la transaction (création de compte)"
                    }
                    .into(),
                ));
            }
            stellar_backend::check_payment(&PaymentCheck {
                ours: &context.account,
                dest: &context.destination,
                ledger: &ledger,
                stroops: stroops.parse().unwrap_or(0),
                fee,
                has_memo,
            })?;
        }
        Shape::Asset { k, amount } => {
            check_asset_payment(k, &context, amount.parse().unwrap_or(0), fee, has_memo)?;
        }
        Shape::Trust { k, enable } => {
            if has_memo {
                return Err(unknown());
            }
            check_trust(k, &context, enable, fee)?;
        }
    }
    Ok((summary, context))
}

#[tauri::command]
pub async fn stellar_sign_tx(
    app: AppHandle,
    state: State<'_, AppState>,
    envelope: String,
    password: String,
    account: Option<u32>,
) -> AppResult<StellarSigned> {
    if !state.is_unlocked() {
        return Err(AppError::Locked);
    }
    let a = account_arg(account)?;
    let me = ours(&state, a)?;
    let signer = SignerInfo::new(&state, Chain::Xlm, a, wallet_core::stellar_path(a));
    let c = ctx(&state);
    let (summary, context) = prepare_sign(&c, &me, &envelope).await?;
    let seed = seed_from_password(&state, Zeroizing::new(password)).await?;
    let lang = crate::i18n::current();
    confirm_native(
        &app,
        if matches!(summary.operation, StellarOpView::ChangeTrust { .. }) {
            lang.pick(
                "Confirmer la ligne de confiance Stellar",
                "Confirm the Stellar trustline",
            )
        } else {
            lang.pick("Confirmer l'envoi Stellar", "Confirm the Stellar send")
        },
        signer.body(lang, &describe_stellar(lang, &summary, &context)),
    )
    .await?;
    confirm_signer(&app, &signer).await?;
    if summary.requires_extra_confirmation {
        confirm_native(
            &app,
            lang.check_tx_title(),
            describe_stellar_extra(lang, &summary),
        )
        .await?;
    }
    let net = c.network;
    let e = envelope.clone();
    let (signed, hash, again) =
        blocking(move || Ok(wallet_core::stellar_sign(&seed, a, &e, net)?)).await?;
    if again != summary {
        return Err(AppError::Internal(
            "résumé différent entre l'aperçu et la signature".into(),
        ));
    }
    state.touch();
    Ok(StellarSigned {
        envelope: signed,
        hash,
        summary,
        context,
    })
}

/// Checks the signed envelope (decodes, one valid signature of our key **for this network**)
/// then submits it.
pub(crate) async fn broadcast_checked(
    c: &StellarCtx<'_>,
    me: &str,
    envelope: &str,
) -> AppResult<String> {
    let hash = wallet_core::stellar_verify_signed(envelope, c.network)?;
    let env = StellarEnvelope::from_base64(envelope)?;
    if env.tx.source != wallet_core::stellar_account_id(me)? {
        return Err(AppError::InvalidInput(
            "cette transaction n'est pas signée par ton compte".into(),
        ));
    }
    stellar_backend::check_network(c).await?;
    stellar_backend::submit(c, envelope.trim(), &hash).await
}

#[tauri::command]
pub async fn stellar_broadcast(
    state: State<'_, AppState>,
    envelope: String,
    account: Option<u32>,
) -> AppResult<String> {
    let me = ours(&state, account_arg(account)?)?;
    broadcast_checked(&ctx(&state), &me, &envelope).await
}

/// `{ found, successful }` of a submitted transaction.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StellarTxStatus {
    pub found: bool,
    pub successful: bool,
}

#[tauri::command]
pub async fn stellar_tx_status(
    state: State<'_, AppState>,
    hash: String,
) -> AppResult<StellarTxStatus> {
    let h = hash.trim().to_ascii_lowercase();
    if h.len() != 64 || !h.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(AppError::InvalidInput(
            "hash : 64 caractères hexadécimaux".into(),
        ));
    }
    let (found, successful) = stellar_backend::tx_status(&ctx(&state), &h).await?;
    Ok(StellarTxStatus { found, successful })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summary(memo: StellarMemoView, op: StellarOpView) -> StellarTxSummary {
        StellarTxSummary {
            network: Network::Testnet,
            source: "GB3JDWCQJCWMJ3IILWIGDTQJJC5567PGVEVXSCVPEQOTDN64VJBDQBYX".into(),
            fee: "100".into(),
            sequence: "4294967297".into(),
            min_time: 0,
            max_time: 1_793_497_980,
            memo,
            operation: op,
            warnings: vec![],
            requires_extra_confirmation: false,
        }
    }

    fn context(dest_exists: bool) -> StellarContext {
        StellarContext {
            account: StellarAccountInfo {
                exists: true,
                balance: "1000000000".into(),
                subentry_count: 1,
                reserve: "15000000".into(),
                spendable: "985000000".into(),
                ..Default::default()
            },
            destination: StellarAccountInfo {
                exists: dest_exists,
                ..Default::default()
            },
            base_reserve: "5000000".into(),
            base_fee: 100,
            ledger_time: 1_793_497_680,
        }
    }

    const TO: &str = "GDVSYYTUAJ3ACHTPQNSTQBDQ4LDHQCMNY4FCEQH5TJUMSSLWQSTG42MV";

    #[test]
    fn dialog_highlights_the_memo_and_shows_the_reserve() {
        let pay = StellarOpView::Payment {
            destination: TO.into(),
            asset: StellarAssetView::Native,
            amount: "125000000".into(),
        };
        let d = describe_stellar(
            Lang::Fr,
            &summary(
                StellarMemoView::Id {
                    id: "804539585".into(),
                },
                pay.clone(),
            ),
            &context(true),
        );
        for needle in [
            "Envoi Stellar (testnet)",
            &format!("À : {TO}"),
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nMÉMO (identifiant) : 804539585\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            "Montant : 12,5 XLM (125000000 stroops)",
            "Frais maximum : 0,00001 XLM (100 stroops",
            "réserve bloquée : 1,5 XLM ((2 + 1 entrée(s)) × 0,5 XLM) · disponible : 98,5 XLM",
            "Valable jusqu'au 2026-11-01 01:53 UTC (≈ 5 min), séquence 4294967297",
            "Réseau signé : « Test SDF Network ; September 2015 »",
        ] {
            assert!(d.contains(needle), "{needle} missing in:\n{d}");
        }
        assert!(!d.contains("n'existe pas encore"));
        let d = describe_stellar(
            Lang::Fr,
            &summary(StellarMemoView::None, pay.clone()),
            &context(true),
        );
        assert!(d.contains("AUCUN MÉMO"));
        let d = describe_stellar(
            Lang::Fr,
            &summary(
                StellarMemoView::Text {
                    text: Some("facture\u{202E} 42".into()),
                    hex: String::new(),
                },
                pay,
            ),
            &context(true),
        );
        assert!(d.contains("MÉMO (texte) : « facture 42 »"), "{d}");
        let create = StellarOpView::CreateAccount {
            destination: TO.into(),
            starting_balance: "20000000".into(),
        };
        let mut s = summary(StellarMemoView::None, create);
        s.network = Network::Mainnet;
        let d = describe_stellar(Lang::Fr, &s, &context(false));
        assert!(d.starts_with("Envoi Stellar — création de compte\n"), "{d}");
        assert!(d.contains(
            "cet envoi le crée (opération CreateAccount). 1 XLM de réserve y reste bloqué"
        ));
        assert!(d.contains("« Public Global Stellar Network ; September 2015 »"));
        s.warnings = vec![StellarWarning::HighFee, StellarWarning::UnusualText];
        let x = describe_stellar_extra(Lang::Fr, &s);
        assert!(x.contains("0,01 XLM") && x.contains("mémo"));
    }

    #[test]
    fn memos_from_the_interface() {
        let t = |v: &str| MemoSpec::Text { value: v.into() };
        let id = |v: &str| MemoSpec::Id { value: v.into() };
        assert_eq!(parse_memo(None).unwrap(), StellarMemo::None);
        assert_eq!(parse_memo(Some(&t(""))).unwrap(), StellarMemo::None);
        assert_eq!(
            parse_memo(Some(&t("café 42"))).unwrap(),
            StellarMemo::Text("café 42".as_bytes().to_vec())
        );
        assert!(parse_memo(Some(&t(&"é".repeat(15)))).is_err(), "30 bytes");
        assert!(parse_memo(Some(&t("a\nb"))).is_err());
        assert!(parse_memo(Some(&t("a\u{200B}b"))).is_err());
        assert_eq!(
            parse_memo(Some(&id(" 18446744073709551615 "))).unwrap(),
            StellarMemo::Id(u64::MAX)
        );
        for bad in ["", "-1", "18446744073709551616", "1e3", "0x10"] {
            assert!(parse_memo(Some(&id(bad))).is_err(), "{bad}");
        }
        let h = "ab".repeat(32);
        assert_eq!(
            parse_memo(Some(&MemoSpec::Hash { value: h.clone() })).unwrap(),
            StellarMemo::Hash([0xab; 32])
        );
        assert!(parse_memo(Some(&MemoSpec::Hash {
            value: h[..62].into()
        }))
        .is_err());
        // IPC shape.
        let m: MemoSpec = serde_json::from_str(r#"{"kind":"id","value":"42"}"#).unwrap();
        assert_eq!(parse_memo(Some(&m)).unwrap(), StellarMemo::Id(42));
    }

    /// USDC payment and trustline removal built by Kyro for real mainnet accounts (no key:
    /// build + the live checks of `stellar_sign_tx`, nothing signed or sent). `cargo test -p
    /// kyro-desktop --lib stellar_usdc_live_mainnet -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn stellar_usdc_live_mainnet() {
        let net = crate::net::NetClient::new(std::env::temp_dir().join("kyro-xlm-live")).unwrap();
        let k = wallet_core::stellar_known_assets(Network::Mainnet)[0];
        tauri::async_runtime::block_on(async {
            let c = StellarCtx {
                net_client: &net,
                network: Network::Mainnet,
                tor: false,
            };
            let ledger = stellar_backend::latest_ledger(&c).await.unwrap();
            let path = format!(
                "https://horizon.stellar.org/accounts?asset=USDC:{}&limit=100",
                k.issuer
            );
            let list = reqwest_like(&net, &path).await;
            let mut sender = None;
            let mut empty = None;
            let mut receiver = None;
            for r in list["_embedded"]["records"].as_array().unwrap() {
                let id = r["id"].as_str().unwrap();
                let a = stellar_backend::account(&c, id, &ledger).await.unwrap();
                let line = trustline(&a, &k).unwrap();
                let spendable: i64 = a.spendable.parse().unwrap();
                if a.memo_required || spendable < 100_000 {
                    continue;
                }
                if line.balance != "0" && sender.is_none() {
                    sender = Some(id.to_owned());
                } else if line.balance == "0" && empty.is_none() {
                    empty = Some(id.to_owned());
                } else if receiver.is_none() {
                    receiver = Some(id.to_owned());
                }
            }
            let (sender, receiver) = (sender.unwrap(), receiver.or(empty.clone()).unwrap());
            let built = build_asset(&c, &sender, &receiver, &k.id(), "1", None)
                .await
                .unwrap();
            let (s, ctx) = prepare_sign(&c, &sender, &built.envelope).await.unwrap();
            assert_eq!(s, built.summary);
            eprintln!("--- payment ---\n{}", describe_stellar(Lang::Fr, &s, &ctx));
            if let Some(e) = empty {
                let built = build_trust(&c, &e, &k.id(), false).await.unwrap();
                let (s, ctx) = prepare_sign(&c, &e, &built.envelope).await.unwrap();
                eprintln!("--- removal ---\n{}", describe_stellar(Lang::Fr, &s, &ctx));
                assert!(
                    build_trust(&c, &e, &k.id(), true).await.is_err(),
                    "already enabled"
                );
            }
            assert!(
                build_trust(&c, &sender, &k.id(), false).await.is_err(),
                "balance not zero"
            );
        });
    }

    /// GET through the app's client (Horizon is on the allowlist).
    async fn reqwest_like(net: &crate::net::NetClient, url: &str) -> Value {
        let req = crate::net::ServerRequest::get(
            url::Url::parse(url).unwrap(),
            crate::net::Family::Stellar,
        );
        let (_, bytes) = net.server_request(req, false).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    const USDC_TESTNET: &str = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

    fn usdc_line(balance: &str) -> stellar_backend::StellarTrustline {
        stellar_backend::StellarTrustline {
            code: "USDC".into(),
            issuer: USDC_TESTNET.into(),
            balance: balance.into(),
            limit: i64::MAX.to_string(),
            authorized: true,
        }
    }

    #[test]
    fn usdc_payment_and_trustline_dialogs_and_checks() {
        let usdc = StellarAssetView::Credit {
            code: "USDC".into(),
            issuer: USDC_TESTNET.into(),
        };
        let pay = summary(
            StellarMemoView::Id { id: "7".into() },
            StellarOpView::Payment {
                destination: TO.into(),
                asset: usdc.clone(),
                amount: "25000000".into(),
            },
        );
        let d = describe_stellar(Lang::Fr, &pay, &context(true));
        for needle in [
            "Montant : 2,5 USDC (émis par GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5) (25000000 unités, 7 décimales)",
            "Émetteur vérifié par Kyro : Circle (testnet) — GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
            "MÉMO (identifiant) : 7",
        ] {
            assert!(d.contains(needle), "{needle} missing in: {d}");
        }
        let trust = summary(
            StellarMemoView::None,
            StellarOpView::ChangeTrust {
                asset: usdc.clone(),
                limit: i64::MAX.to_string(),
            },
        );
        let d = describe_stellar(Lang::Fr, &trust, &context(true));
        assert!(d.contains("Ajout d'une ligne de confiance : USDC"), "{d}");
        assert!(d.contains("Chaque ligne de confiance bloque 0,5 XLM de réserve."));
        assert!(d.contains("Émetteur vérifié par Kyro : Circle (testnet)"));
        assert!(d.contains("la réserve reste bloquée tant que la ligne existe"));
        // An unknown issuer is never « verified ».
        let fake = summary(
            StellarMemoView::None,
            StellarOpView::Payment {
                destination: TO.into(),
                asset: StellarAssetView::Credit {
                    code: "USDC".into(),
                    issuer: TO.into(),
                },
                amount: "1".into(),
            },
        );
        assert!(!describe_stellar(Lang::Fr, &fake, &context(true)).contains("vérifié"));
        // Checks.
        let k = wallet_core::stellar_known_assets(Network::Testnet)[0];
        let mut c = context(true);
        assert!(
            check_asset_payment(&k, &c, 10, 100, false).is_err(),
            "no trustline at the recipient"
        );
        c.destination.trustlines = vec![usdc_line("0")];
        assert!(
            check_asset_payment(&k, &c, 10, 100, false).is_err(),
            "our line is missing"
        );
        c.account.trustlines = vec![usdc_line("50")];
        check_asset_payment(&k, &c, 10, 100, false).unwrap();
        assert!(
            check_asset_payment(&k, &c, 51, 100, false).is_err(),
            "above our balance"
        );
        c.destination.memo_required = true;
        assert!(
            check_asset_payment(&k, &c, 10, 100, false).is_err(),
            "memo required"
        );
        c.destination.memo_required = false;
        c.destination.trustlines[0].authorized = false;
        assert!(
            check_asset_payment(&k, &c, 10, 100, false).is_err(),
            "not authorized"
        );
        // Trustline: enabling twice, removing with a balance.
        assert!(check_trust(&k, &c, true, 100).is_err());
        assert!(check_trust(&k, &c, false, 100).is_err());
        c.account.trustlines = vec![usdc_line("0")];
        check_trust(&k, &c, false, 100).unwrap();
        c.account.trustlines.clear();
        check_trust(&k, &c, true, 100).unwrap();
        c.account.spendable = "5000000".into();
        assert!(
            check_trust(&k, &c, true, 100).is_err(),
            "reserve + fee not covered"
        );
    }
}
