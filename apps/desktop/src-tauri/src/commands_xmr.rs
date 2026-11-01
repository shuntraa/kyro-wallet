//! IPC commands for Monero (`xmr_*`): addresses (primary + subaddresses), background scan with
//! progress, balance (total / unlocked), history, transfers **built by Rust** (inputs, decoys,
//! fee, change) and signed behind the password and the native dialog, the 25-word Monero seed
//! in a native window only, and the restore height. Contract: docs/IPC.md §2.10.

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use wallet_core::{Network, XmrAddressKind, XmrDestination, XmrTxSummary, XmrWarning};
use zeroize::Zeroizing;

use crate::accounts::{account_arg, confirm_signer, Chain, SignerInfo};
use crate::commands::{
    blocking, confirm_native, confirm_native_with, format_units_in, mnemonic_from_password,
    seed_from_password,
};
use crate::error::{AppError, AppResult};
use crate::i18n::Lang;
use crate::servers::host_of;
use crate::state::AppState;
use crate::xmr_backend::{self, XmrCtx, XmrHistoryEntry, XmrPrepared};

fn xmr(lang: Lang, piconero: &str) -> String {
    format!(
        "{} XMR",
        format_units_in(lang, piconero, wallet_core::XMR_DECIMALS as usize)
    )
}

fn net_label(net: Network) -> &'static str {
    match net {
        Network::Mainnet => "mainnet",
        Network::Testnet => "stagenet",
    }
}

fn node_label(state: &AppState) -> String {
    let c = XmrCtx::of(state);
    xmr_backend::node_url(c.network, &c.server, c.tor)
        .ok()
        .as_deref()
        .and_then(host_of)
        .unwrap_or_default()
}

/// Body of the native dialog: what Rust built, nothing from the interface.
pub(crate) fn describe_xmr(lang: Lang, s: &XmrTxSummary, node: &str) -> String {
    let line = "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━";
    let x = |v: &str| xmr(lang, v);
    let kind = match &s.destination.kind {
        XmrAddressKind::Standard => lang.pick("adresse standard", "standard address").to_owned(),
        XmrAddressKind::Subaddress => lang.pick("sous-adresse", "subaddress").to_owned(),
        XmrAddressKind::Integrated { payment_id } => match lang {
            Lang::Fr => format!("adresse intégrée — ID de paiement {payment_id}"),
            Lang::En => format!("integrated address — payment ID {payment_id}"),
        },
    };
    let stagenet = if s.network == "stagenet" {
        " (stagenet)"
    } else {
        ""
    };
    let node = crate::dialog_text::field(node, crate::dialog_text::MAX_FIELD);
    match lang {
        Lang::Fr => format!(
            "Envoi Monero{stagenet}\n\nÀ : {}\nType : {kind}\n{line}\n\
             Montant : {} ({} piconero)\n\
             Frais réseau : {}\n\
             Monnaie rendue à ton adresse principale : {}\n\
             {line}\n\
             Dépensé : {} ({} de tes sorties, anneaux de {} membres)\n\
             Nœud : {node} (il verra la transaction publiée, jamais tes clés)\n",
            s.destination.address,
            x(&s.amount),
            s.amount,
            x(&s.fee),
            x(&s.change),
            x(&s.inputs_total),
            s.input_count,
            s.ring_size
        ),
        Lang::En => format!(
            "Monero send{stagenet}\n\nTo: {}\nType: {kind}\n{line}\n\
             Amount: {} ({} piconero)\n\
             Network fee: {}\n\
             Change returned to your primary address: {}\n\
             {line}\n\
             Spent: {} ({} of your outputs, rings of {} members)\n\
             Node: {node} (it will see the published transaction, never your keys)\n",
            s.destination.address,
            x(&s.amount),
            s.amount,
            x(&s.fee),
            x(&s.change),
            x(&s.inputs_total),
            s.input_count,
            s.ring_size
        ),
    }
}

pub(crate) fn describe_xmr_extra(lang: Lang, s: &XmrTxSummary) -> String {
    let mut out = String::from(lang.pick(
        "Kyro a trouvé des éléments inhabituels dans cet envoi :\n",
        "Kyro found unusual elements in this send:\n",
    ));
    for w in &s.warnings {
        out += match w {
            XmrWarning::IntegratedAddress => lang.pick(
                "• adresse intégrée : l'ID de paiement est envoyé (chiffré) avec la transaction ; vérifie qu'il est bien celui que la plateforme t'a donné\n",
                "• integrated address: the payment ID is sent (encrypted) with the transaction; check that it is the one the exchange gave you\n",
            ),
            XmrWarning::HighFee => lang.pick(
                "• frais supérieurs à 0,01 XMR (d'habitude moins de 0,001 XMR)\n",
                "• fee above 0.01 XMR (usually less than 0.001 XMR)\n",
            ),
            XmrWarning::FeeAboveAmount => lang.pick(
                "• les frais sont plus élevés que le montant envoyé\n",
                "• the fee is higher than the amount sent\n",
            ),
            XmrWarning::OwnAddress => lang.pick(
                "• le destinataire est une de tes propres adresses Monero\n",
                "• the recipient is one of your own Monero addresses\n",
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
pub struct XmrBackendInfo {
    pub kind: &'static str,
    /// `mainnet` | `stagenet`.
    pub network: &'static str,
    pub label: String,
    pub tor: bool,
}

#[tauri::command]
pub fn xmr_backend_info(state: State<'_, AppState>) -> XmrBackendInfo {
    let c = XmrCtx::of(&state);
    XmrBackendInfo {
        kind: c.server.kind_name(),
        network: net_label(state.network),
        label: node_label(&state),
        tor: c.tor,
    }
}

/// Address `index` of account `account`: 0 = primary, n ≥ 1 = subaddress `(0, n)` (only the
/// ones already handed out, see `xmr_new_subaddress`). The first call creates the account's
/// encrypted scan state, so the first scan starts before that moment.
#[tauri::command]
pub async fn xmr_address(
    state: State<'_, AppState>,
    index: Option<u32>,
    account: Option<u32>,
) -> AppResult<String> {
    let a = account_arg(account)?;
    let i = index.unwrap_or(0);
    let lock = state.xmr.file_lock(state.network, a);
    let _g = lock.lock().await;
    let path_exists = {
        let c = xmr_backend::load(&state, a)?;
        if i > c.subaddresses {
            return Err(AppError::InvalidInput(
                "sous-adresse Monero pas encore créée (xmr_new_subaddress)".into(),
            ));
        }
        c.restore_height.is_some() || c.next > 0 || !c.txs.is_empty()
    };
    if !path_exists {
        // Persist `created_at` now (no-op if the file exists with the same content).
        let c = xmr_backend::load(&state, a)?;
        xmr_backend::save(&state, a, &c)?;
    }
    state.with_seed(|s| Ok(wallet_core::xmr_address(s, state.network, a, i)?))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XmrSubaddress {
    pub index: u32,
    pub address: String,
    /// Piconero received on it (confirmed outputs, spent or not).
    pub received: String,
}

/// Hands out the next subaddress `(0, n)` of account `account` (scanned from now on, with
/// a look-ahead of 200 like wallet2).
#[tauri::command]
pub async fn xmr_new_subaddress(
    state: State<'_, AppState>,
    account: Option<u32>,
) -> AppResult<XmrSubaddress> {
    let a = account_arg(account)?;
    let lock = state.xmr.file_lock(state.network, a);
    let _g = lock.lock().await;
    let mut c = xmr_backend::load(&state, a)?;
    if c.subaddresses >= wallet_core::XMR_MAX_SUBADDRESS {
        return Err(AppError::InvalidInput(
            "trop de sous-adresses Monero".into(),
        ));
    }
    c.subaddresses += 1;
    let index = c.subaddresses;
    let address = state.with_seed(|s| Ok(wallet_core::xmr_address(s, state.network, a, index)?))?;
    xmr_backend::save(&state, a, &c)?;
    Ok(XmrSubaddress {
        index,
        address,
        received: "0".into(),
    })
}

/// Primary address and every subaddress handed out, with what each received.
#[tauri::command]
pub fn xmr_subaddresses(
    state: State<'_, AppState>,
    account: Option<u32>,
) -> AppResult<Vec<XmrSubaddress>> {
    let a = account_arg(account)?;
    let c = xmr_backend::load(&state, a)?;
    let addrs = state.with_seed(|s| {
        Ok(wallet_core::xmr_addresses(
            s,
            state.network,
            a,
            0..=c.subaddresses,
        )?)
    })?;
    Ok(addrs
        .into_iter()
        .enumerate()
        .map(|(i, address)| {
            let index = u32::try_from(i).unwrap_or(u32::MAX);
            let received: u64 = c
                .outputs
                .iter()
                .filter(|o| o.subaddress == index)
                .map(|o| o.amount)
                .sum();
            XmrSubaddress {
                index,
                address,
                received: received.to_string(),
            }
        })
        .collect())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XmrStatus {
    /// A scan task is running.
    pub running: bool,
    /// First block scanned (`None` before the first sync).
    pub restore_height: Option<u64>,
    /// Next block to scan.
    pub scanned: u64,
    /// Node's chain height, when known.
    pub tip: Option<u64>,
    /// Unix time of the latest block seen, when known.
    pub tip_time: Option<u64>,
    /// 0 … 1.
    pub progress: f64,
    /// Piconero: everything not spent (locked included).
    pub balance: String,
    /// Piconero: spendable now (10 confirmations, 60 for a coinbase).
    pub unlocked: String,
    pub synced_at: Option<u64>,
    pub error: Option<String>,
    /// Highest subaddress index handed out.
    pub subaddresses: u32,
    /// Outputs ignored: duplicated key (burning bug), additional timelock.
    pub ignored_outputs: u32,
    pub node: String,
}

fn status_of(state: &AppState, a: u32) -> AppResult<XmrStatus> {
    let c = xmr_backend::load(state, a)?;
    let p = state.xmr.progress(state.network, a);
    let height = p.tip.unwrap_or(c.next).max(c.next);
    let (total, unlocked) = c.balance(height);
    let progress = match (c.restore_height, p.tip) {
        (Some(r), Some(t)) if t > r => {
            ((c.next.saturating_sub(r)) as f64 / (t - r) as f64).min(1.0)
        }
        (Some(_), Some(_)) => 1.0,
        _ => 0.0,
    };
    Ok(XmrStatus {
        running: p.running,
        restore_height: c.restore_height,
        scanned: c.next,
        tip: p.tip,
        tip_time: p.tip_time,
        progress,
        balance: total.to_string(),
        unlocked: unlocked.to_string(),
        synced_at: p.synced_at,
        error: p.error,
        subaddresses: c.subaddresses,
        ignored_outputs: c.burnt_duplicates.saturating_add(c.timelocked_ignored),
        node: node_label(state),
    })
}

#[tauri::command]
pub fn xmr_status(state: State<'_, AppState>, account: Option<u32>) -> AppResult<XmrStatus> {
    status_of(&state, account_arg(account)?)
}

/// Starts the background scan of account `account` (no-op if one runs). Poll `xmr_status`.
#[tauri::command]
pub fn xmr_sync(
    app: AppHandle,
    state: State<'_, AppState>,
    account: Option<u32>,
) -> AppResult<XmrStatus> {
    let a = account_arg(account)?;
    if !state.is_unlocked() {
        return Err(AppError::Locked);
    }
    let net = state.network;
    if state.xmr.try_start(net, a) {
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            let st = handle.state::<AppState>();
            let r = xmr_backend::sync(&st, a).await;
            st.xmr.finish(net, a, r.err());
        });
    }
    status_of(&state, a)
}

#[tauri::command]
pub fn xmr_txs(
    state: State<'_, AppState>,
    account: Option<u32>,
) -> AppResult<Vec<XmrHistoryEntry>> {
    let a = account_arg(account)?;
    let c = xmr_backend::load(&state, a)?;
    let p = state.xmr.progress(state.network, a);
    Ok(xmr_backend::history(
        &c,
        p.tip.unwrap_or(c.next).max(c.next),
    ))
}

/// Rust's decoding of a destination (the Send screen shows its kind and refuses the others).
#[tauri::command]
pub fn xmr_validate_address(
    state: State<'_, AppState>,
    address: String,
) -> AppResult<XmrDestination> {
    Ok(wallet_core::xmr_parse_address(&address, state.network)?)
}

/// Forgets the scan state and scans again from block `height` (an older height finds older
/// funds; scanning takes longer).
#[tauri::command]
pub async fn xmr_set_restore_height(
    state: State<'_, AppState>,
    height: u64,
    account: Option<u32>,
) -> AppResult<XmrStatus> {
    let a = account_arg(account)?;
    if state.xmr.progress(state.network, a).running {
        return Err(AppError::InvalidInput(
            "Monero : un scan est en cours, réessaie quand il est terminé".into(),
        ));
    }
    let lock = state.xmr.file_lock(state.network, a);
    {
        let _g = lock.lock().await;
        xmr_backend::reset(&state, a, Some(height))?;
    }
    status_of(&state, a)
}

// ---------------------------------------------------------------- send

/// Builds a transfer of `amount` piconero (absent = everything unlocked) to `to`. Rust picks the
/// inputs, fetches decoys and the fee rate, sets the change; the transfer stays in Rust.
#[tauri::command]
pub async fn xmr_prepare_tx(
    state: State<'_, AppState>,
    to: String,
    amount: Option<String>,
    account: Option<u32>,
) -> AppResult<XmrPrepared> {
    let a = account_arg(account)?;
    let amount = match amount {
        None => None,
        Some(s) => Some(
            s.trim()
                .parse::<u64>()
                .ok()
                .filter(|v| *v > 0)
                .ok_or_else(|| AppError::InvalidInput("montant en piconero invalide".into()))?,
        ),
    };
    xmr_backend::prepare(&state, a, to.trim(), amount).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XmrSent {
    pub txid: String,
    pub summary: XmrTxSummary,
}

/// Password, native dialog (what Rust built), signature (monero-wallet), checks (exact outputs,
/// fee, key images), publication, local record.
#[tauri::command]
pub async fn xmr_send_tx(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    password: String,
    account: Option<u32>,
) -> AppResult<XmrSent> {
    if !state.is_unlocked() {
        return Err(AppError::Locked);
    }
    let a = account_arg(account)?;
    let pending = state.xmr.take_pending(id.trim())?;
    if pending.account != a || pending.network != state.network {
        return Err(AppError::InvalidInput(
            "transfert préparé pour un autre compte ou réseau".into(),
        ));
    }
    let summary = pending.unsigned.summary.clone();
    let signer = SignerInfo::new(&state, Chain::Xmr, a, wallet_core::xmr_path(a));
    let seed = seed_from_password(&state, Zeroizing::new(password)).await?;
    let lang = crate::i18n::current();
    confirm_native(
        &app,
        lang.pick("Confirmer l'envoi Monero", "Confirm the Monero send"),
        signer.body(lang, &describe_xmr(lang, &summary, &node_label(&state))),
    )
    .await?;
    confirm_signer(&app, &signer).await?;
    if summary.requires_extra_confirmation {
        confirm_native(
            &app,
            lang.pick(
                "Attention : envoi Monero à vérifier",
                "Warning: Monero send to check",
            ),
            describe_xmr_extra(lang, &summary),
        )
        .await?;
    }
    let unsigned = pending.unsigned;
    let signed = blocking(move || Ok(wallet_core::xmr_sign(&seed, a, unsigned)?)).await?;
    if signed.summary != summary {
        return Err(AppError::Internal(
            "résumé différent entre l'aperçu et la signature".into(),
        ));
    }
    let mut revealed: Vec<String> = signed.key_images.iter().map(hex::encode).collect();
    let mut expected = pending.key_images.clone();
    revealed.sort();
    expected.sort();
    if revealed != expected {
        return Err(AppError::Internal(
            "la transaction signée ne dépense pas les sorties prévues".into(),
        ));
    }
    xmr_backend::publish(&state, a, &signed, &pending.key_images).await?;
    state.touch();
    Ok(XmrSent {
        txid: signed.txid,
        summary,
    })
}

// ---------------------------------------------------------------- 25-word seed

pub(crate) fn seed_text(
    lang: Lang,
    words: &[String],
    path: &str,
    restore: Option<u64>,
) -> Zeroizing<String> {
    let mut out = Zeroizing::new(match lang {
        Lang::Fr => format!(
            "Phrase Monero de 25 mots — clé {path}\n\n\
             Elle restaure ce portefeuille Monero dans Monero GUI, Feather ou Cake Wallet \
             (« restaurer depuis une phrase »). Elle est calculée depuis ta phrase de récupération \
             Kyro, qui reste ta sauvegarde principale. Quiconque lit ces mots peut prendre tes XMR.\n\n"
        ),
        Lang::En => format!(
            "25-word Monero phrase — key {path}\n\n\
             It restores this Monero wallet in Monero GUI, Feather or Cake Wallet \
             (\"restore from seed\"). It is derived from your Kyro recovery phrase, \
             which stays your main backup. Anyone who reads these words can take your XMR.\n\n"
        ),
    });
    for (i, w) in words.iter().enumerate() {
        out.push_str(&format!("{:>2}. {w}", i + 1));
        out.push_str(if i % 5 == 4 { "\n" } else { "    " });
    }
    match (restore, lang) {
        (Some(h), Lang::Fr) => out.push_str(&format!(
            "\nHauteur de restauration : {h} (Kyro scanne à partir de ce bloc ; indique-la, ou une plus ancienne, dans l'autre portefeuille).\n"
        )),
        (Some(h), Lang::En) => out.push_str(&format!(
            "\nRestore height: {h} (Kyro scans from this block; enter it, or an older one, in the other wallet).\n"
        )),
        (None, _) => out.push_str(lang.pick(
            "\nHauteur de restauration : pas encore choisie (aucun scan).\n",
            "\nRestore height: not chosen yet (no scan).\n",
        )),
    }
    out.push_str(lang.pick(
        "\nCette fenêtre appartient au système, pas à l'interface de Kyro : vérifie quand même \
         que personne ne regarde ton écran et qu'aucun partage d'écran n'est actif.",
        "\nThis window belongs to the system, not to Kyro's interface: still check \
         that nobody is watching your screen and that no screen sharing is active.",
    ));
    out
}

/// Shows the 25-word Monero seed of account `account` in a native window (password, native
/// confirmation, then the words). Nothing is returned to the webview.
#[tauri::command]
pub async fn xmr_seed_show(
    app: AppHandle,
    state: State<'_, AppState>,
    password: String,
    account: Option<u32>,
) -> AppResult<()> {
    if !state.is_unlocked() {
        return Err(AppError::Locked);
    }
    let a = account_arg(account)?;
    state.check_reveal_cooldown()?;
    let mnemonic = mnemonic_from_password(&state, Zeroizing::new(password)).await?;
    let lang = crate::i18n::current();
    confirm_native_with(
        &app,
        lang.pick("Afficher la phrase Monero ?", "Show the Monero phrase?"),
        lang.pick(
            "Kyro va afficher la phrase Monero de 25 mots de ce compte dans une fenêtre du système.\n\n\
             Quiconque la voit peut prendre tes XMR. Vérifie que personne ne regarde ton écran et \
             qu'aucun partage d'écran ni logiciel de capture n'est actif.\n\nSi tu n'as pas toi-même \
             demandé à l'afficher, refuse.",
            "Kyro will show this account's 25-word Monero phrase in a system window.\n\n\
             Anyone who sees it can take your XMR. Check that nobody is watching your screen and \
             that no screen sharing or capture software is active.\n\nIf you did not ask to \
             show it yourself, refuse.",
        )
        .into(),
        lang.pick("Afficher", "Show"),
        lang.cancel(),
    )
    .await?;
    let restore = xmr_backend::load(&state, a)
        .ok()
        .and_then(|c| c.restore_height);
    let words =
        blocking(move || Ok(wallet_core::xmr_seed_words(&mnemonic.to_seed(""), a)?)).await?;
    let body = seed_text(lang, &words, &wallet_core::xmr_path(a), restore);
    let _open = app.state::<AppState>().dialogs.enter();
    let handle = app.clone();
    blocking(move || {
        handle
            .dialog()
            .message(body.as_str())
            .title(lang.pick("Phrase Monero (25 mots)", "Monero phrase (25 words)"))
            .kind(MessageDialogKind::Info)
            .buttons(MessageDialogButtons::OkCustom(
                lang.pick("J'ai fini de noter", "I have written it down")
                    .into(),
            ))
            .blocking_show();
        Ok(())
    })
    .await?;
    state.touch();
    Ok(())
}

/// Probe used by `settings_set` / `server_test`.
pub(crate) async fn probe(
    net: &std::sync::Arc<crate::net::NetClient>,
    network: Network,
    server: &crate::servers::MoneroServer,
    tor: bool,
) -> AppResult<crate::btc_backend::Detected> {
    xmr_backend::probe(net, network, server, tor).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use wallet_core::XmrDestination;

    fn summary(kind: XmrAddressKind, warnings: Vec<XmrWarning>) -> XmrTxSummary {
        XmrTxSummary {
            network: "stagenet".into(),
            account: 0,
            destination: XmrDestination {
                address: "79y5JZUvzJWdkghYFN2prK3rZ7zPeL9f2REEdqE4WXYbSZr3797Aqti5xAjRsVy4jTdcwMW11GWejQtqk2kNXxj2QWJ9bkP".into(),
                kind,
            },
            amount: "1500000000000".into(),
            fee: "120000000".into(),
            change: "999880000000".into(),
            inputs_total: "2500000000000".into(),
            input_count: 2,
            ring_size: 16,
            fee_per_weight: "80000".into(),
            requires_extra_confirmation: !warnings.is_empty(),
            warnings,
        }
    }

    #[test]
    fn dialog_shows_what_rust_built() {
        let d = describe_xmr(
            Lang::Fr,
            &summary(XmrAddressKind::Subaddress, vec![]),
            "monero-stagenet.stackwallet.com",
        );
        for needle in [
            "Envoi Monero (stagenet)",
            "À : 79y5JZUvzJWdkghYFN2prK3rZ7zPeL9f2REEdqE4WXYbSZr3797Aqti5xAjRsVy4jTdcwMW11GWejQtqk2kNXxj2QWJ9bkP",
            "Type : sous-adresse",
            "Montant : 1,5 XMR (1500000000000 piconero)",
            "Frais réseau : 0,00012 XMR",
            "Monnaie rendue à ton adresse principale : 0,99988 XMR",
            "Dépensé : 2,5 XMR (2 de tes sorties, anneaux de 16 membres)",
            "Nœud : « monero-stagenet.stackwallet.com »",
        ] {
            assert!(d.contains(needle), "{needle} missing in:\n{d}");
        }
        let d = describe_xmr(
            Lang::Fr,
            &summary(
                XmrAddressKind::Integrated {
                    payment_id: "0102030405060708".into(),
                },
                vec![XmrWarning::IntegratedAddress, XmrWarning::HighFee],
            ),
            "x",
        );
        assert!(d.contains("adresse intégrée — ID de paiement 0102030405060708"));
        let x = describe_xmr_extra(
            Lang::Fr,
            &summary(
                XmrAddressKind::Standard,
                vec![XmrWarning::IntegratedAddress, XmrWarning::OwnAddress],
            ),
        );
        assert!(x.contains("ID de paiement") && x.contains("tes propres adresses"));
        let en = describe_xmr(Lang::En, &summary(XmrAddressKind::Subaddress, vec![]), "n");
        assert!(
            en.contains("Type: subaddress")
                && en.contains("Amount: 1.5 XMR (1500000000000 piconero)")
        );
    }

    #[test]
    fn seed_window_text() {
        let words: Vec<String> = (0..25).map(|i| format!("w{i}")).collect();
        let t = seed_text(Lang::Fr, &words, "m/44'/128'/0'/0/0", Some(3_500_000));
        assert!(t.contains(" 1. w0") && t.contains("25. w24"));
        assert!(t.contains("Hauteur de restauration : 3500000"));
        assert!(seed_text(Lang::Fr, &words, "m", None).contains("pas encore choisie"));
        assert!(seed_text(Lang::En, &words, "m", Some(7)).contains("Restore height: 7"));
    }
}
