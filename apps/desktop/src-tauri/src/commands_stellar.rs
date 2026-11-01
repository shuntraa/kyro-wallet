//! IPC commands for Stellar (`stellar_*`): address, account (balance, reserve, spendable, memo
//! required), history, XLM payment building **by Kyro** (Payment, or CreateAccount for an
//! unfunded destination; sequence / fee / time bounds from Horizon, encoded by wallet-core),
//! signing behind the password and the native dialog (memo highlighted, reserve re-read live),
//! and submission with hash check. Contract: docs/IPC.md §2.11.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, State};
use wallet_core::{
    Network, StellarAsset, StellarAssetView, StellarEnvelope, StellarMemo, StellarMemoView,
    StellarOp, StellarOpView, StellarOperation, StellarTransaction, StellarTxSummary,
    StellarWarning, STELLAR_MAX_MEMO_TEXT,
};
use zeroize::Zeroizing;

use crate::accounts::{account_arg, confirm_signer, Chain, SignerInfo};
use crate::commands::{blocking, confirm_native, format_units, network_name, seed_from_password};
use crate::error::{AppError, AppResult};
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

fn xlm(stroops: &str) -> String {
    format!("{} XLM", format_units(stroops, 7))
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

fn memo_block(m: &StellarMemoView) -> String {
    match m {
        StellarMemoView::None => "AUCUN MÉMO\n(une plateforme d'échange en exige souvent un : sans lui, les fonds peuvent être perdus)\n".into(),
        StellarMemoView::Text { text: Some(t), .. } => format!(
            "MÉMO (texte) : {}\n",
            crate::dialog_text::field(t, STELLAR_MAX_MEMO_TEXT)
        ),
        StellarMemoView::Text { text: None, hex } => {
            format!("MÉMO (texte non lisible, octets) : {hex}\n")
        }
        StellarMemoView::Id { id } => format!("MÉMO (identifiant) : {id}\n"),
        StellarMemoView::Hash { hex } => format!("MÉMO (hash) : {hex}\n"),
        StellarMemoView::Return { hex } => format!("MÉMO (remboursement) : {hex}\n"),
    }
}

fn asset_text(a: &StellarAssetView) -> String {
    match a {
        StellarAssetView::Native => "XLM".into(),
        StellarAssetView::Credit { code, issuer } => format!(
            "{} (émis par {issuer})",
            crate::dialog_text::sanitize(code, 12)
        ),
    }
}

/// Body of the native dialog. The memo gets its own framed block, whatever it is.
pub(crate) fn describe_stellar(s: &StellarTxSummary, c: &StellarContext) -> String {
    let line = "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━";
    let testnet = if s.network == Network::Testnet {
        " (testnet)"
    } else {
        ""
    };
    let (title, to) = match &s.operation {
        StellarOpView::Payment { destination, .. } => ("Envoi Stellar", destination.as_str()),
        StellarOpView::CreateAccount { destination, .. } => {
            ("Envoi Stellar — création de compte", destination.as_str())
        }
        StellarOpView::ChangeTrust { .. } => ("Ligne de confiance Stellar", ""),
    };
    let mut out = format!("{title}{testnet}\n\n");
    if !to.is_empty() {
        out += &format!("À : {to}\n{line}\n{}{line}\n", memo_block(&s.memo));
    }
    match &s.operation {
        StellarOpView::Payment { asset, amount, .. } => {
            out += &match asset {
                StellarAssetView::Native => {
                    format!("Montant : {} ({amount} stroops)\n", xlm(amount))
                }
                other => format!(
                    "Montant : {} {}\n",
                    format_units(amount, 7),
                    asset_text(other)
                ),
            };
        }
        StellarOpView::CreateAccount {
            starting_balance, ..
        } => {
            out += &format!(
                "Montant : {} ({starting_balance} stroops)\n\nCe compte n'existe pas encore : cet envoi le crée (opération CreateAccount). {} de réserve y reste bloqué (2 × {}).\n",
                xlm(starting_balance),
                xlm(&(2 * c.base_reserve.parse::<i64>().unwrap_or(0)).to_string()),
                xlm(&c.base_reserve)
            );
        }
        StellarOpView::ChangeTrust { asset, limit } => {
            out += &format!(
                "{} : {}\nLimite : {}\nChaque ligne de confiance bloque {} de réserve.\n",
                if limit == "0" {
                    "Suppression de la ligne de confiance"
                } else {
                    "Ajout d'une ligne de confiance"
                },
                asset_text(asset),
                if limit == &i64::MAX.to_string() {
                    "aucune".to_owned()
                } else {
                    format_units(limit, 7)
                },
                xlm(&c.base_reserve)
            );
            out += &memo_block(&s.memo);
        }
    }
    out += &format!(
        "\nFrais maximum : {} ({} stroops ; d'habitude seuls {} stroops sont prélevés)\n",
        xlm(&s.fee),
        s.fee,
        c.base_fee
    );
    let a = &c.account;
    out += &format!(
        "Solde : {} · réserve bloquée : {} ((2 + {} entrée(s)) × {}) · disponible : {}\n",
        xlm(&a.balance),
        xlm(&a.reserve),
        a.subentry_count,
        xlm(&c.base_reserve),
        xlm(&a.spendable)
    );
    out += &format!(
        "Valable jusqu'au {} (≈ {} min), séquence {}\n",
        stellar_backend::format_utc(s.max_time),
        s.max_time.saturating_sub(c.ledger_time).div_ceil(60),
        s.sequence
    );
    out += &format!(
        "Réseau signé : « {} »\n",
        wallet_core::stellar_network_passphrase(s.network)
    );
    out
}

pub(crate) fn describe_stellar_extra(s: &StellarTxSummary) -> String {
    let mut out = String::from("Kyro a trouvé des éléments inhabituels dans cette transaction :\n");
    for w in &s.warnings {
        out += match w {
            StellarWarning::HighFee => {
                "• frais maximum supérieurs à 0,01 XLM (d'habitude 100 stroops)\n"
            }
            StellarWarning::UnusualText => {
                "• mémo contenant des caractères invisibles / de contrôle, ou illisible (affiché nettoyé)\n"
            }
            StellarWarning::MemoReturn => "• mémo de type « remboursement » (MEMO_RETURN)\n",
            StellarWarning::RemoveTrustline => {
                "• suppression d'une ligne de confiance (l'actif ne pourra plus être reçu)\n"
            }
        };
    }
    out += "\nNe signe que si tu sais exactement pourquoi. Signer quand même ?";
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

/// Decoding + live re-checks, i.e. everything `stellar_sign_tx` does before the dialog. Only
/// XLM transfers are signed (Kyro builds nothing else yet).
pub(crate) async fn prepare_sign(
    c: &StellarCtx<'_>,
    me: &str,
    envelope: &str,
) -> AppResult<(StellarTxSummary, StellarContext)> {
    let summary = wallet_core::stellar_decode_tx(envelope, me, c.network)?;
    let (to, stroops, creates) = match &summary.operation {
        StellarOpView::Payment {
            destination,
            asset: StellarAssetView::Native,
            amount,
        } => (destination.clone(), amount, false),
        StellarOpView::CreateAccount {
            destination,
            starting_balance,
        } => (destination.clone(), starting_balance, true),
        _ => {
            return Err(AppError::InvalidInput(
                "Kyro ne signe que des envois de XLM pour l'instant".into(),
            ))
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
        fee: summary.fee.parse().unwrap_or(u32::MAX),
        has_memo: summary.memo != StellarMemoView::None,
    })?;
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
    confirm_native(
        &app,
        "Confirmer l'envoi Stellar",
        signer.body(&describe_stellar(&summary, &context)),
    )
    .await?;
    confirm_signer(&app, &signer).await?;
    if summary.requires_extra_confirmation {
        confirm_native(
            &app,
            "Attention : transaction à vérifier",
            describe_stellar_extra(&summary),
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
        let d = describe_stellar(&summary(StellarMemoView::None, pay.clone()), &context(true));
        assert!(d.contains("AUCUN MÉMO"));
        let d = describe_stellar(
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
        let d = describe_stellar(&s, &context(false));
        assert!(d.starts_with("Envoi Stellar — création de compte\n"), "{d}");
        assert!(d.contains(
            "cet envoi le crée (opération CreateAccount). 1 XLM de réserve y reste bloqué"
        ));
        assert!(d.contains("« Public Global Stellar Network ; September 2015 »"));
        s.warnings = vec![StellarWarning::HighFee, StellarWarning::UnusualText];
        let x = describe_stellar_extra(&s);
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
}
