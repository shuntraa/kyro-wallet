//! IPC commands for the XRP Ledger (`xrp_*`): address, account (balance, reserve, spendable,
//! RequireDestTag), trust lines, history, Payment building **by Kyro** (Sequence / Fee /
//! LastLedgerSequence from the server, encoded by wallet-core), signing behind the password and
//! the native dialog (destination tag highlighted, reserve and spendable re-read live), and
//! `submit` with hash check. Contract: docs/IPC.md §2.6.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, State};
use wallet_core::{Network, XrpAmount, XrpAmountView, XrpPayment, XrpTxSummary, XrpWarning};
use zeroize::Zeroizing;

use crate::accounts::{account_arg, confirm_signer, Chain, SignerInfo};
use crate::commands::{blocking, confirm_native, format_units_in, seed_from_password};
use crate::error::{AppError, AppResult};
use crate::i18n::Lang;
use crate::servers::{host_of, utxo_network_key, XrpServer};
use crate::state::AppState;
use crate::xrp_backend::{self, PaymentCheck, XrpAccountInfo, XrpCtx, XrpServerInfo, LLS_OFFSET};

pub(crate) fn ctx(state: &AppState) -> XrpCtx<'_> {
    let s = state.settings();
    XrpCtx {
        net_client: &state.net,
        network: state.network,
        tor: s.tor.enabled,
        server: s.servers.xrp.for_network(state.network),
    }
}

/// Address and public key of XRP account `account` (`m/44'/144'/account'/0/0`).
fn ours(state: &AppState, account: u32) -> AppResult<(String, [u8; 33])> {
    state.with_seed(|seed| {
        Ok((
            wallet_core::xrp_address(seed, account)?,
            wallet_core::xrp_public_key(seed, account)?,
        ))
    })
}

fn xrp(lang: Lang, drops: &str) -> String {
    format!("{} XRP", format_units_in(lang, drops, 6))
}

fn amount_text(lang: Lang, a: &XrpAmountView) -> String {
    match a {
        XrpAmountView::Xrp { drops } => format!("{} ({drops} drops)", xrp(lang, drops)),
        XrpAmountView::Issued {
            value,
            currency,
            issuer,
        } => format!(
            "{value} {} ({} {issuer})",
            crate::dialog_text::sanitize(currency, 40),
            lang.pick("émis par", "issued by")
        ),
    }
}

/// Live context shown in the dialog.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XrpContext {
    pub account: XrpAccountInfo,
    pub destination: XrpAccountInfo,
    /// Drops.
    pub reserve_base: String,
    pub reserve_inc: String,
}

/// Body of the native dialog. The destination tag gets its own framed block, whatever it is.
pub(crate) fn describe_xrp(lang: Lang, s: &XrpTxSummary, c: &XrpContext, net: Network) -> String {
    let line = "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━";
    let x = |d: &str| xrp(lang, d);
    let testnet = if net == Network::Testnet {
        " (testnet)"
    } else {
        ""
    };
    let mut out = match lang {
        Lang::Fr => format!("Envoi XRP Ledger{testnet}\n\nÀ : {}\n", s.destination),
        Lang::En => format!("XRP Ledger send{testnet}\n\nTo: {}\n", s.destination),
    };
    out += &format!("{line}\n");
    match (s.destination_tag, lang) {
        (Some(t), Lang::Fr) => out += &format!("TAG DE DESTINATION : {t}\n"),
        (Some(t), Lang::En) => out += &format!("DESTINATION TAG: {t}\n"),
        (None, Lang::Fr) => out += "AUCUN TAG DE DESTINATION\n(une plateforme d'échange ou un service en exige souvent un : sans lui, les fonds peuvent être perdus)\n",
        (None, Lang::En) => out += "NO DESTINATION TAG\n(an exchange or a service often requires one: without it, the funds can be lost)\n",
    }
    out += &format!("{line}\n");
    out += &format!(
        "{}{}\n",
        lang.pick("Montant : ", "Amount: "),
        amount_text(lang, &s.amount)
    );
    if let Some(m) = &s.send_max {
        out += &format!(
            "{}{}\n",
            lang.pick("Dépense au plus (SendMax) : ", "Spends at most (SendMax): "),
            amount_text(lang, m)
        );
    }
    if !c.destination.exists {
        out += &match lang {
            Lang::Fr => format!(
                "\nCe compte n'existe pas encore : ce paiement le crée (réserve de {} bloquée chez lui).\n",
                x(&c.reserve_base)
            ),
            Lang::En => format!(
                "\nThis account does not exist yet: this payment creates it ({} reserve locked on it).\n",
                x(&c.reserve_base)
            ),
        };
    }
    out += &match lang {
        Lang::Fr => format!(
            "\nFrais : {} ({} drops)\nSolde : {} · réserve bloquée : {} ({} + {} × {} objet(s)) · disponible : {}\n",
            x(&s.fee),
            s.fee,
            x(&c.account.balance),
            x(&c.account.reserve),
            x(&c.reserve_base),
            x(&c.reserve_inc),
            c.account.owner_count,
            x(&c.account.spendable)
        ),
        Lang::En => format!(
            "\nFee: {} ({} drops)\nBalance: {} · locked reserve: {} ({} + {} × {} object(s)) · available: {}\n",
            x(&s.fee),
            s.fee,
            x(&c.account.balance),
            x(&c.account.reserve),
            x(&c.reserve_base),
            x(&c.reserve_inc),
            c.account.owner_count,
            x(&c.account.spendable)
        ),
    };
    if let Some(l) = s.last_ledger_sequence {
        out += &match lang {
            Lang::Fr => format!(
                "Valable jusqu'au registre n° {l} (≈ 1 min), séquence {}\n",
                s.sequence
            ),
            Lang::En => format!(
                "Valid until ledger no. {l} (≈ 1 min), sequence {}\n",
                s.sequence
            ),
        };
    }
    // Untrusted text, after the amounts and fees, one quoted line each.
    for m in &s.memos {
        out += &format!(
            "{}{}\n",
            lang.pick(
                "Mémo (texte libre, non vérifié) : ",
                "Memo (free text, not verified): "
            ),
            crate::dialog_text::field(
                m.text
                    .as_deref()
                    .or(m.memo_data.as_deref())
                    .unwrap_or_default(),
                crate::dialog_text::MAX_FIELD
            )
        );
    }
    out
}

pub(crate) fn describe_xrp_extra(lang: Lang, s: &XrpTxSummary) -> String {
    let mut out = String::from(lang.pick(
        "Kyro a trouvé des éléments inhabituels dans ce paiement :\n",
        "Kyro found unusual elements in this payment:\n",
    ));
    for w in &s.warnings {
        out += match w {
            XrpWarning::SendMax => lang.pick(
                "• SendMax : paiement converti, qui peut dépenser jusqu'au montant SendMax\n",
                "• SendMax: converted payment, which can spend up to the SendMax amount\n",
            ),
            XrpWarning::PathFlags => lang.pick(
                "• options de chemin (tfNoRippleDirect / tfLimitQuality)\n",
                "• path options (tfNoRippleDirect / tfLimitQuality)\n",
            ),
            XrpWarning::Memo => lang.pick(
                "• la transaction porte un mémo, public à jamais sur le registre\n",
                "• the transaction carries a memo, public forever on the ledger\n",
            ),
            XrpWarning::HighFee => lang.pick(
                "• frais supérieurs à 1 XRP (d'habitude quelques dizaines de drops)\n",
                "• fee above 1 XRP (usually a few dozen drops)\n",
            ),
            XrpWarning::InvoiceId => lang.pick(
                "• identifiant de facture (InvoiceID)\n",
                "• invoice identifier (InvoiceID)\n",
            ),
            XrpWarning::UnusualText => lang.pick(
                "• mémo contenant des caractères invisibles / de contrôle, ou trop long (affiché nettoyé)\n",
                "• memo with invisible / control characters, or too long (shown cleaned)\n",
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
pub struct XrpBackendInfo {
    pub kind: &'static str,
    pub network: &'static str,
    pub label: String,
    pub tor: bool,
}

#[tauri::command]
pub fn xrp_backend_info(state: State<'_, AppState>) -> XrpBackendInfo {
    let c = ctx(&state);
    XrpBackendInfo {
        kind: c.server.kind_name(),
        network: utxo_network_key(state.network),
        label: xrp_backend::url(&c)
            .ok()
            .as_deref()
            .and_then(host_of)
            .unwrap_or_default(),
        tor: c.tor,
    }
}

/// Address of XRP account `account` (absent = 0). `index` is accepted for older callers and
/// must be 0 (one address per account).
#[tauri::command]
pub fn xrp_address(
    state: State<'_, AppState>,
    index: Option<u32>,
    account: Option<u32>,
) -> AppResult<String> {
    if index.unwrap_or(0) != 0 {
        return Err(AppError::InvalidInput(
            "XRP: a single address per account (index 0)".into(),
        ));
    }
    Ok(ours(&state, account_arg(account)?)?.0)
}

#[tauri::command]
pub async fn xrp_account(state: State<'_, AppState>, address: String) -> AppResult<XrpAccountInfo> {
    let c = ctx(&state);
    let info = xrp_backend::server_info(&c).await?;
    xrp_backend::account(&c, &address, &info).await
}

#[tauri::command]
pub async fn xrp_lines(state: State<'_, AppState>, address: String) -> AppResult<Value> {
    xrp_backend::lines(&ctx(&state), &address).await
}

#[tauri::command]
pub async fn xrp_txs(state: State<'_, AppState>, address: String) -> AppResult<Value> {
    xrp_backend::txs(&ctx(&state), &address).await
}

// ---------------------------------------------------------------- build, sign, broadcast

/// Issued currency to send instead of XRP.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssuedSpec {
    pub currency: String,
    pub issuer: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XrpBuilt {
    /// Unsigned Payment, hex: what `xrp_sign_tx` signs.
    pub blob: String,
    pub summary: XrpTxSummary,
    pub context: XrpContext,
}

async fn live_context(
    c: &XrpCtx<'_>,
    me: &str,
    to: &str,
) -> AppResult<(XrpServerInfo, XrpContext)> {
    let info = xrp_backend::server_info(c).await?;
    let account = xrp_backend::account(c, me, &info).await?;
    let destination = xrp_backend::account(c, to, &info).await?;
    Ok((
        info,
        XrpContext {
            account,
            destination,
            reserve_base: info.reserve_base.to_string(),
            reserve_inc: info.reserve_inc.to_string(),
        },
    ))
}

fn drops_of(s: &XrpTxSummary) -> Option<u64> {
    match &s.amount {
        XrpAmountView::Xrp { drops } => drops.parse().ok(),
        XrpAmountView::Issued { .. } => None,
    }
}

/// Builds an unsigned Payment from live data: `amount` in drops (XRP) or as a decimal value
/// (issued currency, with `issued`).
pub(crate) async fn build(
    c: &XrpCtx<'_>,
    me: &str,
    pubkey: &[u8; 33],
    to: &str,
    amount: &str,
    destination_tag: Option<u32>,
    issued: Option<&IssuedSpec>,
) -> AppResult<XrpBuilt> {
    let account = wallet_core::xrp_account_id(me)?;
    let destination = wallet_core::xrp_account_id(to)?;
    let amt = match issued {
        None => XrpAmount::Xrp(
            amount
                .trim()
                .parse()
                .ok()
                .filter(|d| *d > 0)
                .ok_or_else(|| AppError::InvalidInput("invalid amount in drops".into()))?,
        ),
        Some(i) => wallet_core::xrp_issued_amount(amount, &i.currency, &i.issuer)?,
    };
    let (info, context) = live_context(c, me, to).await?;
    let (fee, current) = xrp_backend::fee(c).await?;
    let drops = match amt {
        XrpAmount::Xrp(d) => Some(d),
        XrpAmount::Issued { .. } => None,
    };
    xrp_backend::check_payment(&PaymentCheck {
        ours: &context.account,
        dest: &context.destination,
        info: &info,
        drops,
        fee,
        destination_tag,
    })?;
    let p = XrpPayment {
        flags: Some(wallet_core::TF_FULLY_CANONICAL_SIG),
        source_tag: None,
        sequence: context.account.sequence,
        destination_tag,
        last_ledger_sequence: Some(current.saturating_add(LLS_OFFSET)),
        invoice_id: None,
        amount: amt,
        fee,
        send_max: None,
        signing_pub_key: Some(pubkey.to_vec()),
        txn_signature: None,
        account,
        destination,
        memos: Vec::new(),
    };
    let blob = hex::encode_upper(p.encode(false));
    let summary = wallet_core::xrp_decode_tx(&blob, me, pubkey)?;
    Ok(XrpBuilt {
        blob,
        summary,
        context,
    })
}

#[tauri::command]
pub async fn xrp_build_tx(
    state: State<'_, AppState>,
    to: String,
    amount: String,
    destination_tag: Option<u32>,
    issued: Option<IssuedSpec>,
    account: Option<u32>,
) -> AppResult<XrpBuilt> {
    let (me, pk) = ours(&state, account_arg(account)?)?;
    build(
        &ctx(&state),
        &me,
        &pk,
        &to,
        &amount,
        destination_tag,
        issued.as_ref(),
    )
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XrpSigned {
    /// Signed blob, hex: what `xrp_broadcast` submits.
    pub blob: String,
    pub hash: String,
    pub summary: XrpTxSummary,
    pub context: XrpContext,
}

/// Decoding + live re-checks, i.e. everything `xrp_sign_tx` does before the dialog.
pub(crate) async fn prepare_sign(
    c: &XrpCtx<'_>,
    me: &str,
    pubkey: &[u8; 33],
    blob: &str,
) -> AppResult<(XrpTxSummary, XrpContext)> {
    let summary = wallet_core::xrp_decode_tx(blob, me, pubkey)?;
    let (info, context) = live_context(c, me, &summary.destination).await?;
    let (_, current) = xrp_backend::fee(c).await?;
    if summary.last_ledger_sequence.is_some_and(|l| l <= current) {
        return Err(AppError::InvalidInput(
            "XRP payment expired (LastLedgerSequence passed): rebuild it".into(),
        ));
    }
    if summary.sequence != context.account.sequence {
        return Err(AppError::InvalidInput(
            "stale sequence number: rebuild the payment".into(),
        ));
    }
    let fee: u64 = summary.fee.parse().unwrap_or(0);
    xrp_backend::check_payment(&PaymentCheck {
        ours: &context.account,
        dest: &context.destination,
        info: &info,
        drops: drops_of(&summary),
        fee,
        destination_tag: summary.destination_tag,
    })?;
    Ok((summary, context))
}

#[tauri::command]
pub async fn xrp_sign_tx(
    app: AppHandle,
    state: State<'_, AppState>,
    blob: String,
    password: String,
    account: Option<u32>,
) -> AppResult<XrpSigned> {
    if !state.is_unlocked() {
        return Err(AppError::Locked);
    }
    let a = account_arg(account)?;
    let (me, pk) = ours(&state, a)?;
    let signer = SignerInfo::new(&state, Chain::Xrp, a, wallet_core::xrp_path(a));
    let c = ctx(&state);
    let (summary, context) = prepare_sign(&c, &me, &pk, &blob).await?;
    let seed = seed_from_password(&state, Zeroizing::new(password)).await?;
    let lang = crate::i18n::current();
    confirm_native(
        &app,
        lang.pick("Confirmer le paiement XRP", "Confirm the XRP payment"),
        signer.body(lang, &describe_xrp(lang, &summary, &context, state.network)),
    )
    .await?;
    confirm_signer(&app, &signer).await?;
    if summary.requires_extra_confirmation {
        confirm_native(
            &app,
            lang.pick(
                "Attention : paiement à vérifier",
                "Warning: payment to check",
            ),
            describe_xrp_extra(lang, &summary),
        )
        .await?;
    }
    let b = blob.clone();
    let (signed, hash, again) = blocking(move || Ok(wallet_core::xrp_sign(&seed, a, &b)?)).await?;
    if again != summary {
        return Err(AppError::Internal(
            "summary differs between the preview and the signature".into(),
        ));
    }
    state.touch();
    Ok(XrpSigned {
        blob: signed,
        hash,
        summary,
        context,
    })
}

/// Checks the signed blob (decodes, canonical low-S signature by our key) then submits it.
pub(crate) async fn broadcast_checked(c: &XrpCtx<'_>, me: &str, blob: &str) -> AppResult<String> {
    let hash = wallet_core::xrp_verify_signed(blob)?;
    let p = XrpPayment::decode(
        &hex::decode(blob.trim())
            .map_err(|_| AppError::InvalidInput("blob: hexadecimal expected".into()))?,
    )?;
    if p.account != wallet_core::xrp_account_id(me)? {
        return Err(AppError::InvalidInput(
            "this payment is not signed by your account".into(),
        ));
    }
    xrp_backend::submit(c, blob.trim(), &hash).await
}

/// `{ validated, result }` of a submitted transaction (`result` = `tesSUCCESS`… once validated).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XrpTxStatus {
    pub validated: bool,
    pub result: String,
}

#[tauri::command]
pub async fn xrp_tx_status(state: State<'_, AppState>, hash: String) -> AppResult<XrpTxStatus> {
    let h = hash.trim();
    if h.len() != 64 || !h.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(AppError::InvalidInput(
            "hash: 64 hexadecimal characters".into(),
        ));
    }
    let (validated, result) = xrp_backend::tx_status(&ctx(&state), h).await?;
    Ok(XrpTxStatus { validated, result })
}

#[tauri::command]
pub async fn xrp_broadcast(
    state: State<'_, AppState>,
    blob: String,
    account: Option<u32>,
) -> AppResult<String> {
    let (me, _) = ours(&state, account_arg(account)?)?;
    broadcast_checked(&ctx(&state), &me, &blob).await
}

/// Probe used by `settings_set` / `server_test`.
pub(crate) async fn probe(
    net: &crate::net::NetClient,
    network: Network,
    server: &XrpServer,
    tor: bool,
) -> AppResult<crate::btc_backend::Detected> {
    xrp_backend::probe(&XrpCtx {
        net_client: net,
        network,
        tor,
        server: server.clone(),
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summary(tag: Option<u32>) -> XrpTxSummary {
        XrpTxSummary {
            account: "rNaqKtKrMSwpwZSzRckPf7S96DkimjkF4H".into(),
            destination: "rBKz5MC2iXdoS3XgnNSYmF69K1Yo4NS3Ws".into(),
            destination_tag: tag,
            amount: XrpAmountView::Xrp {
                drops: "20000000".into(),
            },
            fee: "12".into(),
            sequence: 7,
            last_ledger_sequence: Some(1234),
            flags: wallet_core::TF_FULLY_CANONICAL_SIG,
            send_max: None,
            source_tag: None,
            invoice_id: None,
            memos: vec![],
            warnings: vec![],
            requires_extra_confirmation: false,
        }
    }

    fn context(dest_exists: bool) -> XrpContext {
        XrpContext {
            account: XrpAccountInfo {
                exists: true,
                balance: "100000000".into(),
                owner_count: 1,
                reserve: "1200000".into(),
                spendable: "98800000".into(),
                ..Default::default()
            },
            destination: XrpAccountInfo {
                exists: dest_exists,
                ..Default::default()
            },
            reserve_base: "1000000".into(),
            reserve_inc: "200000".into(),
        }
    }

    #[test]
    fn dialog_highlights_the_destination_tag_and_shows_the_reserve() {
        let d = describe_xrp(
            Lang::Fr,
            &summary(Some(12_345)),
            &context(true),
            Network::Testnet,
        );
        for needle in [
            "Envoi XRP Ledger (testnet)",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nTAG DE DESTINATION : 12345\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            "Montant : 20 XRP (20000000 drops)",
            "Frais : 0,000012 XRP (12 drops)",
            "réserve bloquée : 1,2 XRP (1 XRP + 0,2 XRP × 1 objet(s)) · disponible : 98,8 XRP",
            "Valable jusqu'au registre n° 1234",
        ] {
            assert!(d.contains(needle), "{needle} missing in:\n{d}");
        }
        assert!(!d.contains("n'existe pas encore"));
        let d = describe_xrp(Lang::Fr, &summary(None), &context(false), Network::Mainnet);
        assert!(d.contains("AUCUN TAG DE DESTINATION"));
        assert!(d.contains("ce paiement le crée (réserve de 1 XRP"));
        let mut s = summary(None);
        s.warnings = vec![XrpWarning::SendMax, XrpWarning::Memo];
        let x = describe_xrp_extra(Lang::Fr, &s);
        assert!(x.contains("SendMax") && x.contains("mémo"));
    }

    #[test]
    fn dialog_in_english() {
        let d = describe_xrp(
            Lang::En,
            &summary(Some(12_345)),
            &context(true),
            Network::Testnet,
        );
        for needle in [
            "XRP Ledger send (testnet)",
            "To: rBKz5MC2iXdoS3XgnNSYmF69K1Yo4NS3Ws",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nDESTINATION TAG: 12345\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            "Amount: 20 XRP (20000000 drops)",
            "Fee: 0.000012 XRP (12 drops)",
            "locked reserve: 1.2 XRP (1 XRP + 0.2 XRP × 1 object(s)) · available: 98.8 XRP",
            "Valid until ledger no. 1234",
        ] {
            assert!(d.contains(needle), "{needle} missing in:\n{d}");
        }
        let d = describe_xrp(Lang::En, &summary(None), &context(false), Network::Mainnet);
        assert!(d.contains("NO DESTINATION TAG"));
        assert!(d.contains("the funds can be lost"));
        assert!(d.contains("this payment creates it (1 XRP reserve"));
        let mut s = summary(None);
        s.warnings = vec![XrpWarning::SendMax, XrpWarning::Memo];
        let x = describe_xrp_extra(Lang::En, &s);
        assert!(x.contains("public forever on the ledger"));
        for fr in ["Montant", "Frais", "Solde", "mémo", "Signer"] {
            assert!(!d.contains(fr) && !x.contains(fr), "{fr}");
        }
    }
}
