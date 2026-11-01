//! IPC commands for Algorand (`algo_*`): address, account (balance, minimum balance, spendable,
//! rekey), history, payment building **by Kyro** (fee / validity / genesis from algod, encoded by
//! wallet-core), signing behind the password and the native dialog (what Rust decoded: amount,
//! receiver, note, fee, genesis; minimum balances re-read live), and submission with id check.

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, State};
use wallet_core::{AlgoPayment, AlgoTxSummary, AlgoWarning, Network};
use zeroize::Zeroizing;

use crate::accounts::{account_arg, confirm_signer, Chain, SignerInfo};
use crate::algo_backend::{
    self, AlgoAccountInfo, AlgoCtx, AlgoHolding, AlgoTxStatus, PaymentCheck, LV_OFFSET,
};
use crate::commands::{blocking, confirm_native, format_units_in, seed_from_password};
use crate::error::{AppError, AppResult};
use crate::i18n::Lang;
use crate::servers::utxo_network_key;
use crate::state::AppState;

pub(crate) fn ctx(state: &AppState) -> AlgoCtx<'_> {
    AlgoCtx {
        net_client: &state.net,
        network: state.network,
        tor: state.settings().tor.enabled,
    }
}

fn ours(state: &AppState, account: u32) -> AppResult<String> {
    state.with_seed(|seed| Ok(wallet_core::algo_address(seed, account)?))
}

fn algo(lang: Lang, micro: &str) -> String {
    format!("{} ALGO", format_units_in(lang, micro, 6))
}

/// Live context shown in the dialog.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlgoContext {
    pub account: AlgoAccountInfo,
    pub destination: AlgoAccountInfo,
    /// Current round when the payment was checked.
    pub round: u64,
    /// Asset transfer / opt-in: both holdings of the asset, read live.
    pub asset: Option<AlgoAssetContext>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlgoAssetContext {
    pub ours: AlgoHolding,
    pub destination: AlgoHolding,
}

fn units(lang: Lang, raw: &str, a: &wallet_core::AlgoAssetSummary) -> String {
    format!(
        "{} {}",
        format_units_in(lang, raw, usize::from(a.decimals)),
        a.symbol
    )
}

fn describe_asset_head(
    lang: Lang,
    s: &AlgoTxSummary,
    a: &wallet_core::AlgoAssetSummary,
    testnet: &str,
) -> String {
    let token = match lang {
        Lang::Fr => format!(
            "Jeton : {} ({}) · actif n° {} (vérifié, table de Kyro) · {} décimales\n",
            a.symbol, a.name, a.asset_id, a.decimals
        ),
        Lang::En => format!(
            "Token: {} ({}) · asset ID {} (verified, Kyro's table) · {} decimals\n",
            a.symbol, a.name, a.asset_id, a.decimals
        ),
    };
    if a.opt_in {
        return match lang {
            Lang::Fr => format!(
                "Activer {sym} sur Algorand{testnet}\n\n{token}Transaction : transfert de 0 {sym} à toi-même (opt-in), rien n'est envoyé à personne\nEffet : ton solde minimum augmente de 0,1 ALGO (bloqués tant que {sym} reste activé) ; tu pourras ensuite recevoir des {sym}\n",
                sym = a.symbol
            ),
            Lang::En => format!(
                "Enable {sym} on Algorand{testnet}\n\n{token}Transaction: a 0 {sym} transfer to yourself (opt-in), nothing is sent to anyone\nEffect: your minimum balance rises by 0.1 ALGO (locked while {sym} stays enabled); you can then receive {sym}\n",
                sym = a.symbol
            ),
        };
    }
    match lang {
        Lang::Fr => format!(
            "Envoi {} sur Algorand{testnet}\n\n{token}À : {}\nMontant : {} ({} unités)\n",
            a.symbol,
            s.receiver,
            units(lang, &a.amount, a),
            a.amount
        ),
        Lang::En => format!(
            "{} send on Algorand{testnet}\n\n{token}To: {}\nAmount: {} ({} units)\n",
            a.symbol,
            s.receiver,
            units(lang, &a.amount, a),
            a.amount
        ),
    }
}

pub(crate) fn describe_algo(
    lang: Lang,
    s: &AlgoTxSummary,
    c: &AlgoContext,
    net: Network,
) -> String {
    let al = |v: &str| algo(lang, v);
    let testnet = if net == Network::Testnet {
        " (testnet)"
    } else {
        ""
    };
    let mut out = match (&s.asset, lang) {
        (Some(a), _) => describe_asset_head(lang, s, a, testnet),
        (None, Lang::Fr) => format!(
            "Envoi Algorand{testnet}\n\nÀ : {}\nMontant : {} ({} µALGO)\n",
            s.receiver,
            al(&s.amount),
            s.amount
        ),
        (None, Lang::En) => format!(
            "Algorand send{testnet}\n\nTo: {}\nAmount: {} ({} µALGO)\n",
            s.receiver,
            al(&s.amount),
            s.amount
        ),
    };
    if let (Some(a), Some(h)) = (&s.asset, &c.asset) {
        if !a.opt_in {
            out += &match lang {
                Lang::Fr => format!(
                    "Ton solde {} : {}\n",
                    a.symbol,
                    units(lang, &h.ours.amount, a)
                ),
                Lang::En => format!(
                    "Your {} balance: {}\n",
                    a.symbol,
                    units(lang, &h.ours.amount, a)
                ),
            };
        }
    }
    if s.asset.is_none() && !c.destination.exists {
        out += &match lang {
            Lang::Fr => format!(
                "\nCe compte n'existe pas encore : ce paiement le crée (au moins {} doivent y rester, solde minimum).\n",
                al(&c.destination.min_balance)
            ),
            Lang::En => format!(
                "\nThis account does not exist yet: this payment creates it (at least {} must stay on it, minimum balance).\n",
                al(&c.destination.min_balance)
            ),
        };
    }
    out += &match lang {
        Lang::Fr => format!(
            "\nFrais : {} ({} µALGO)\nSolde : {} · solde minimum bloqué : {} · disponible : {}\n",
            al(&s.fee),
            s.fee,
            al(&c.account.balance),
            al(&c.account.min_balance),
            al(&c.account.spendable)
        ),
        Lang::En => format!(
            "\nFee: {} ({} µALGO)\nBalance: {} · locked minimum balance: {} · available: {}\n",
            al(&s.fee),
            s.fee,
            al(&c.account.balance),
            al(&c.account.min_balance),
            al(&c.account.spendable)
        ),
    };
    let minutes = (s.last_valid.saturating_sub(c.round.max(s.first_valid)) * 28).div_ceil(600);
    out += &match lang {
        Lang::Fr => format!(
            "Réseau : {} (genesis {})\nValable des rounds {} à {} (≈ {minutes} min)\n",
            s.genesis_id, s.genesis_hash, s.first_valid, s.last_valid
        ),
        Lang::En => format!(
            "Network: {} (genesis {})\nValid from round {} to {} (≈ {minutes} min)\n",
            s.genesis_id, s.genesis_hash, s.first_valid, s.last_valid
        ),
    };
    if s.note_len > 0 {
        match &s.note_text {
            Some(t) => {
                out += &format!(
                    "{}{}\n",
                    lang.pick(
                        "Note (texte libre, publique à jamais) : ",
                        "Note (free text, public forever): "
                    ),
                    crate::dialog_text::field(t, crate::dialog_text::MAX_FIELD)
                )
            }
            None => {
                let hex = crate::dialog_text::sanitize(
                    s.note_hex.as_deref().unwrap_or_default(),
                    crate::dialog_text::MAX_FIELD,
                );
                out += &match lang {
                    Lang::Fr => format!(
                        "Note binaire ({} octets, publique à jamais) : {hex}\n",
                        s.note_len
                    ),
                    Lang::En => format!(
                        "Binary note ({} bytes, public forever): {hex}\n",
                        s.note_len
                    ),
                }
            }
        }
    }
    out += &format!("{}{}\n", lang.pick("Identifiant : ", "ID: "), s.txid);
    out
}

pub(crate) fn describe_algo_extra(lang: Lang, s: &AlgoTxSummary) -> String {
    let mut out = String::from(lang.pick(
        "Kyro a trouvé des éléments à vérifier dans ce paiement :\n",
        "Kyro found some things to check in this payment:\n",
    ));
    for w in &s.warnings {
        out += match w {
            AlgoWarning::Note => lang.pick(
                "• la transaction porte une note, lisible par tous et pour toujours sur la chaîne\n",
                "• the transaction carries a note, readable by anyone and forever on the chain\n",
            ),
            AlgoWarning::BinaryNote => lang.pick(
                "• la note n'est pas du texte (octets bruts affichés en hexadécimal)\n",
                "• the note is not text (raw bytes shown in hexadecimal)\n",
            ),
            AlgoWarning::UnusualText => lang.pick(
                "• note contenant des caractères invisibles / de contrôle, ou trop longue (affichée nettoyée)\n",
                "• note containing invisible / control characters, or too long (shown cleaned)\n",
            ),
            AlgoWarning::HighFee => lang.pick(
                "• frais supérieurs à 0,01 ALGO (d'habitude 0,001 ALGO)\n",
                "• fee above 0.01 ALGO (usually 0.001 ALGO)\n",
            ),
        };
    }
    out += "\n";
    out += lang.sign_anyway();
    out
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlgoBackendInfo {
    pub kind: &'static str,
    pub network: &'static str,
    pub label: String,
    pub indexer: String,
    pub tor: bool,
}

#[tauri::command]
pub fn algo_backend_info(state: State<'_, AppState>) -> AlgoBackendInfo {
    let c = ctx(&state);
    let host = |u: &str| crate::servers::host_of(u).unwrap_or_default();
    AlgoBackendInfo {
        kind: "default",
        network: utxo_network_key(state.network),
        label: host(algo_backend::algod_url(state.network)),
        indexer: host(algo_backend::indexer_url(state.network)),
        tor: c.tor,
    }
}

/// Address of Algorand account `account` (absent = 0).
#[tauri::command]
pub fn algo_address(state: State<'_, AppState>, account: Option<u32>) -> AppResult<String> {
    ours(&state, account_arg(account)?)
}

#[tauri::command]
pub async fn algo_account(
    state: State<'_, AppState>,
    address: String,
) -> AppResult<AlgoAccountInfo> {
    algo_backend::account(&ctx(&state), &address).await
}

#[tauri::command]
pub async fn algo_txs(state: State<'_, AppState>, address: String) -> AppResult<Value> {
    algo_backend::txs(&ctx(&state), &address).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlgoBuilt {
    /// Unsigned transaction (canonical msgpack), hex: what `algo_sign_tx` signs.
    pub blob: String,
    pub summary: AlgoTxSummary,
    pub context: AlgoContext,
}

async fn live_context(
    c: &AlgoCtx<'_>,
    me: &str,
    to: &str,
    asset: Option<u64>,
) -> AppResult<(algo_backend::AlgoParams, AlgoContext)> {
    let params = algo_backend::params(c).await?;
    let account = algo_backend::account(c, me).await?;
    let destination = algo_backend::account(c, to).await?;
    let asset = match asset {
        None => None,
        Some(id) => {
            let ours = algo_backend::holding(c, me, id).await?;
            let destination = if to == me {
                ours.clone()
            } else {
                algo_backend::holding(c, to, id).await?
            };
            Some(AlgoAssetContext { ours, destination })
        }
    };
    Ok((
        params.clone(),
        AlgoContext {
            account,
            destination,
            round: params.last_round,
            asset,
        },
    ))
}

fn check_asset_live(
    a: &wallet_core::AlgoAssetSummary,
    fee: u64,
    context: &AlgoContext,
) -> AppResult<()> {
    let h = context
        .asset
        .as_ref()
        .ok_or_else(|| AppError::Internal("missing asset context".into()))?;
    algo_backend::check_asset(&algo_backend::AssetCheck {
        ours: &context.account,
        symbol: &a.symbol,
        decimals: a.decimals,
        mine: &h.ours,
        dest: &h.destination,
        amount: a.amount.parse().unwrap_or(u64::MAX),
        fee,
        opt_in: a.opt_in,
    })
}

pub(crate) async fn build_asset(
    c: &AlgoCtx<'_>,
    me: &str,
    asset_id: u64,
    to: &str,
    amount: u64,
    note: Option<&str>,
) -> AppResult<AlgoBuilt> {
    let known = wallet_core::algo_known_asset(c.network, asset_id).ok_or_else(|| {
        AppError::InvalidInput(format!("Algorand asset {asset_id} unknown to Kyro"))
    })?;
    let sender = wallet_core::algo_address_bytes(me)?;
    let receiver = wallet_core::algo_address_bytes(to)?;
    let opt_in = receiver == sender;
    if opt_in != (amount == 0) {
        return Err(AppError::InvalidInput(
            "invalid amount (0 only to enable the token on your own account)".into(),
        ));
    }
    let note = note.map(str::as_bytes).unwrap_or_default().to_vec();
    if note.len() > wallet_core::ALGO_MAX_NOTE {
        return Err(AppError::InvalidInput("note: at most 1024 bytes".into()));
    }
    let (params, context) = live_context(c, me, to, Some(known.id)).await?;
    let (gen, gh) = wallet_core::algo_genesis(c.network)?;
    let mut p = AlgoPayment {
        amount: 0,
        close_remainder_to: None,
        fee: params.fee_for(0),
        first_valid: params.last_round,
        genesis_id: gen.into(),
        genesis_hash: gh,
        group: None,
        last_valid: params.last_round + LV_OFFSET,
        lease: None,
        note,
        receiver: [0u8; 32],
        rekey_to: None,
        sender,
        asset: Some(wallet_core::AlgoAssetTransfer {
            asset_id: known.id,
            amount,
            receiver,
            close_to: None,
            asset_sender: None,
        }),
    };
    p.fee = params.fee_for(p.encode().len());
    p.fee = params.fee_for(p.encode().len());
    let blob = hex::encode(p.encode());
    let summary = wallet_core::algo_decode_tx(&blob, c.network, me)?;
    let a = summary
        .asset
        .as_ref()
        .ok_or_else(|| AppError::Internal("asset transfer expected".into()))?;
    check_asset_live(a, p.fee, &context)?;
    Ok(AlgoBuilt {
        blob,
        summary,
        context,
    })
}

fn micro_of(s: &AlgoTxSummary) -> (u64, u64) {
    (s.amount.parse().unwrap_or(0), s.fee.parse().unwrap_or(0))
}

pub(crate) async fn build(
    c: &AlgoCtx<'_>,
    me: &str,
    to: &str,
    amount: &str,
    note: Option<&str>,
) -> AppResult<AlgoBuilt> {
    let sender = wallet_core::algo_address_bytes(me)?;
    let receiver = wallet_core::algo_address_bytes(to)?;
    let amount: u64 = amount
        .trim()
        .parse()
        .ok()
        .filter(|a| *a > 0)
        .ok_or_else(|| AppError::InvalidInput("invalid amount in µALGO".into()))?;
    let note = note.map(str::as_bytes).unwrap_or_default().to_vec();
    if note.len() > wallet_core::ALGO_MAX_NOTE {
        return Err(AppError::InvalidInput("note: at most 1024 bytes".into()));
    }
    let (params, context) = live_context(c, me, to, None).await?;
    let (gen, gh) = wallet_core::algo_genesis(c.network)?;
    let mut p = AlgoPayment {
        asset: None,
        amount,
        close_remainder_to: None,
        fee: params.fee_for(0),
        first_valid: params.last_round,
        genesis_id: gen.into(),
        genesis_hash: gh,
        group: None,
        last_valid: params.last_round + LV_OFFSET,
        lease: None,
        note,
        receiver,
        rekey_to: None,
        sender,
    };
    p.fee = params.fee_for(p.encode().len());
    p.fee = params.fee_for(p.encode().len());
    algo_backend::check_payment(&PaymentCheck {
        ours: &context.account,
        dest: &context.destination,
        amount,
        fee: p.fee,
    })?;
    let blob = hex::encode(p.encode());
    let summary = wallet_core::algo_decode_tx(&blob, c.network, me)?;
    Ok(AlgoBuilt {
        blob,
        summary,
        context,
    })
}

#[tauri::command]
pub async fn algo_build_tx(
    state: State<'_, AppState>,
    to: String,
    amount: String,
    note: Option<String>,
    account: Option<u32>,
) -> AppResult<AlgoBuilt> {
    let me = ours(&state, account_arg(account)?)?;
    build(&ctx(&state), &me, &to, &amount, note.as_deref()).await
}

/// Our holdings of the known assets of the network (USDC, USD₮ on mainnet), in their order.
#[tauri::command]
pub async fn algo_asset_holdings(
    state: State<'_, AppState>,
    address: String,
) -> AppResult<Vec<AlgoHolding>> {
    let c = ctx(&state);
    let mut out = Vec::new();
    for a in wallet_core::algo_known_assets(c.network) {
        out.push(algo_backend::holding(&c, &address, a.id).await?);
    }
    Ok(out)
}

/// Opt-in to a known asset: a 0-unit transfer of it to ourselves (raises the minimum balance by 0.1
/// ALGO).
#[tauri::command]
pub async fn algo_build_optin_tx(
    state: State<'_, AppState>,
    asset_id: u64,
    account: Option<u32>,
) -> AppResult<AlgoBuilt> {
    let me = ours(&state, account_arg(account)?)?;
    build_asset(&ctx(&state), &me, asset_id, &me, 0, None).await
}

/// Transfer of `amount` base units of a known asset to `to` (who must have opted in).
#[tauri::command]
pub async fn algo_build_asset_tx(
    state: State<'_, AppState>,
    asset_id: u64,
    to: String,
    amount: String,
    note: Option<String>,
    account: Option<u32>,
) -> AppResult<AlgoBuilt> {
    let me = ours(&state, account_arg(account)?)?;
    let units: u64 = amount
        .trim()
        .parse()
        .ok()
        .filter(|a| *a > 0)
        .ok_or_else(|| AppError::InvalidInput("invalid token amount".into()))?;
    if to.trim() == me {
        return Err(AppError::InvalidInput("cannot send to yourself".into()));
    }
    build_asset(
        &ctx(&state),
        &me,
        asset_id,
        to.trim(),
        units,
        note.as_deref(),
    )
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlgoSigned {
    /// Signed transaction (msgpack), hex: what `algo_broadcast` submits.
    pub blob: String,
    pub txid: String,
    pub summary: AlgoTxSummary,
    pub context: AlgoContext,
}

pub(crate) async fn prepare_sign(
    c: &AlgoCtx<'_>,
    me: &str,
    blob: &str,
) -> AppResult<(AlgoTxSummary, AlgoContext)> {
    let summary = wallet_core::algo_decode_tx(blob, c.network, me)?;
    let asset_id = summary.asset.as_ref().map(|a| a.asset_id);
    let (_, context) = live_context(c, me, &summary.receiver, asset_id).await?;
    if summary.last_valid <= context.round {
        return Err(AppError::InvalidInput(
            "Algorand payment expired (last valid round passed): rebuild it".into(),
        ));
    }
    let (amount, fee) = micro_of(&summary);
    if let Some(a) = &summary.asset {
        check_asset_live(a, fee, &context)?;
        return Ok((summary, context));
    }
    algo_backend::check_payment(&PaymentCheck {
        ours: &context.account,
        dest: &context.destination,
        amount,
        fee,
    })?;
    Ok((summary, context))
}

#[tauri::command]
pub async fn algo_sign_tx(
    app: AppHandle,
    state: State<'_, AppState>,
    blob: String,
    password: String,
    account: Option<u32>,
) -> AppResult<AlgoSigned> {
    if !state.is_unlocked() {
        return Err(AppError::Locked);
    }
    let a = account_arg(account)?;
    let me = ours(&state, a)?;
    let signer = SignerInfo::new(&state, Chain::Algo, a, wallet_core::algo_path(a));
    let c = ctx(&state);
    let net = state.network;
    let (summary, context) = prepare_sign(&c, &me, &blob).await?;
    let seed = seed_from_password(&state, Zeroizing::new(password)).await?;
    let lang = crate::i18n::current();
    let title = match &summary.asset {
        Some(a) if a.opt_in => lang.pick(
            "Activer un jeton Algorand (opt-in)",
            "Enable an Algorand token (opt-in)",
        ),
        Some(_) => lang.pick(
            "Confirmer l'envoi de jetons Algorand",
            "Confirm the Algorand token send",
        ),
        None => lang.pick(
            "Confirmer le paiement Algorand",
            "Confirm the Algorand payment",
        ),
    };
    confirm_native(
        &app,
        title,
        signer.body(lang, &describe_algo(lang, &summary, &context, net)),
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
            describe_algo_extra(lang, &summary),
        )
        .await?;
    }
    let b = blob.clone();
    let (signed, txid, again) =
        blocking(move || Ok(wallet_core::algo_sign(&seed, a, net, &b)?)).await?;
    if again != summary {
        return Err(AppError::Internal(
            "summary differs between the preview and the signature".into(),
        ));
    }
    state.touch();
    Ok(AlgoSigned {
        blob: signed,
        txid,
        summary,
        context,
    })
}

/// Checks the signed transaction (strict decoding, policy, signature by our key) then submits
/// it; the id algod returns must be ours.
pub(crate) async fn broadcast_checked(c: &AlgoCtx<'_>, me: &str, blob: &str) -> AppResult<String> {
    let (txid, raw) = wallet_core::algo_verify_signed(blob, c.network, me)?;
    algo_backend::submit(c, raw, &txid).await
}

#[tauri::command]
pub async fn algo_broadcast(
    state: State<'_, AppState>,
    blob: String,
    account: Option<u32>,
) -> AppResult<String> {
    let me = ours(&state, account_arg(account)?)?;
    broadcast_checked(&ctx(&state), &me, &blob).await
}

fn valid_txid(t: &str) -> bool {
    t.len() == 52
        && t.bytes()
            .all(|b| b.is_ascii_uppercase() || (b'2'..=b'7').contains(&b))
}

#[tauri::command]
pub async fn algo_tx_status(state: State<'_, AppState>, txid: String) -> AppResult<AlgoTxStatus> {
    let t = txid.trim();
    if !valid_txid(t) {
        return Err(AppError::InvalidInput(
            "Algorand transaction ID: 52 base32 characters".into(),
        ));
    }
    algo_backend::tx_status(&ctx(&state), t).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summary(note: Option<&str>) -> AlgoTxSummary {
        AlgoTxSummary {
            sender: "SENDER".into(),
            receiver: "BX63ZW4O5PWWFDH3J33QEB5YN7IN5XOKPDUQ5DCZ232EDY4DWN3XKUQRCA".into(),
            amount: "1500000".into(),
            fee: "1000".into(),
            first_valid: 1000,
            last_valid: 1200,
            genesis_id: "testnet-v1.0".into(),
            genesis_hash: "SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=".into(),
            note_len: note.map_or(0, str::len),
            note_hex: note.map(|n| hex::encode(n.as_bytes())),
            note_text: note.map(str::to_owned),
            txid: "TXID".into(),
            warnings: if note.is_some() {
                vec![AlgoWarning::Note]
            } else {
                vec![]
            },
            requires_extra_confirmation: note.is_some(),
            asset: None,
        }
    }

    fn usdc(amount: &str, opt_in: bool) -> wallet_core::AlgoAssetSummary {
        wallet_core::AlgoAssetSummary {
            asset_id: 31_566_704,
            symbol: "USDC".into(),
            name: "USD Coin".into(),
            decimals: 6,
            amount: amount.into(),
            opt_in,
        }
    }

    #[test]
    fn dialog_shows_the_token_its_verified_id_and_decimals() {
        let mut s = summary(None);
        s.amount = "0".into();
        s.asset = Some(usdc("12500000", false));
        let mut c = context(true);
        let h = AlgoHolding {
            asset_id: 31_566_704,
            opted_in: true,
            amount: "20000000".into(),
            frozen: false,
        };
        c.asset = Some(AlgoAssetContext {
            ours: h.clone(),
            destination: h,
        });
        let d = describe_algo(Lang::Fr, &s, &c, Network::Mainnet);
        for needle in [
            "Envoi USDC sur Algorand\n",
            "Jeton : USDC (USD Coin) · actif n° 31566704 (vérifié, table de Kyro) · 6 décimales",
            "À : BX63ZW4O5PWWFDH3J33QEB5YN7IN5XOKPDUQ5DCZ232EDY4DWN3XKUQRCA",
            "Montant : 12,5 USDC (12500000 unités)",
            "Ton solde USDC : 20 USDC",
            "Frais : 0,001 ALGO",
        ] {
            assert!(d.contains(needle), "{needle} missing in:\n{d}");
        }
        assert!(!d.contains("µALGO)\nFrais") && !d.contains("Montant : 0 ALGO"));
        s.asset = Some(usdc("0", true));
        let d = describe_algo(Lang::En, &s, &c, Network::Testnet);
        assert!(d.starts_with("Enable USDC on Algorand (testnet)\n"), "{d}");
        assert!(d.contains("asset ID 31566704 (verified, Kyro's table) · 6 decimals"));
        assert!(d.contains("minimum balance rises by 0.1 ALGO"));
    }

    fn context(dest_exists: bool) -> AlgoContext {
        AlgoContext {
            account: AlgoAccountInfo {
                exists: true,
                balance: "10000000".into(),
                min_balance: "100000".into(),
                spendable: "9900000".into(),
                ..Default::default()
            },
            destination: AlgoAccountInfo {
                exists: dest_exists,
                balance: if dest_exists { "1".into() } else { "0".into() },
                min_balance: "100000".into(),
                ..Default::default()
            },
            round: 1000,
            asset: None,
        }
    }

    #[test]
    fn dialog_shows_what_rust_decoded() {
        let d = describe_algo(
            Lang::Fr,
            &summary(Some("Loyer\noctobre")),
            &context(true),
            Network::Testnet,
        );
        for needle in [
            "Envoi Algorand (testnet)",
            "À : BX63ZW4O5PWWFDH3J33QEB5YN7IN5XOKPDUQ5DCZ232EDY4DWN3XKUQRCA",
            "Montant : 1,5 ALGO (1500000 µALGO)",
            "Frais : 0,001 ALGO (1000 µALGO)",
            "solde minimum bloqué : 0,1 ALGO · disponible : 9,9 ALGO",
            "Réseau : testnet-v1.0 (genesis SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=)",
            "Valable des rounds 1000 à 1200 (≈ 10 min)",
            "Note (texte libre, publique à jamais) : « Loyer octobre »",
            "Identifiant : TXID",
        ] {
            assert!(d.contains(needle), "{needle} missing in:\n{d}");
        }
        assert!(!d.contains("n'existe pas encore"));
        let d = describe_algo(Lang::Fr, &summary(None), &context(false), Network::Mainnet);
        assert!(d.starts_with("Envoi Algorand\n"));
        assert!(d.contains("ce paiement le crée (au moins 0,1 ALGO"));
        assert!(!d.contains("Note"));
        let x = describe_algo_extra(Lang::Fr, &summary(Some("x")));
        assert!(x.contains("note, lisible par tous"));
        let en = describe_algo(
            Lang::En,
            &summary(Some("x")),
            &context(true),
            Network::Testnet,
        );
        assert!(
            en.contains("Amount: 1.5 ALGO (1500000 µALGO)")
                && en.contains("Note (free text, public forever): ")
        );
    }

    #[test]
    fn txid_shape() {
        assert!(valid_txid(
            "5FJDJD5LMZC3EHUYYJNH5I23U4X6H2KXABNDGPIL557ZMJ33GZHQ"
        ));
        assert!(!valid_txid(
            "5fjdjd5lmzc3ehuyyjnh5i23u4x6h2kxabndgpil557zmj33gzhq"
        ));
        assert!(!valid_txid(
            "5FJDJD5LMZC3EHUYYJNH5I23U4X6H2KXABNDGPIL557ZMJ33GZH"
        ));
        assert!(!valid_txid(
            "5FJDJD5LMZC3EHUYYJNH5I23U4X6H2KXABNDGPIL557ZMJ33GZH1"
        ));
    }
}

/// Real-network test on Algorand TestNet over Tor.
#[cfg(test)]
mod live {
    use super::*;
    use crate::net::NetClient;
    use crate::tor::TorState;

    fn test_seed() -> wallet_core::Seed {
        let path =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../.env.algo-testnet");
        let words = match std::fs::read_to_string(&path) {
            Ok(s) => s
                .lines()
                .find_map(|l| l.strip_prefix("KYRO_ALGO_TEST_MNEMONIC="))
                .expect("mnemonic line")
                .trim()
                .to_owned(),
            Err(_) => {
                let m = wallet_core::Mnemonic::generate(wallet_core::WordCount::W12).unwrap();
                let w = m.words().join(" ");
                std::fs::write(
                    &path,
                    format!("# ALGORAND TESTNET ONLY — random test mnemonic generated by Kyro's live test (commands_algo.rs).\n# Never use it for real funds. This file is gitignored (.env.*).\nKYRO_ALGO_TEST_MNEMONIC={w}\n"),
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
    fn algo_live_testnet_over_tor() {
        let net = NetClient::new(std::env::temp_dir().join("kyro-algo-live")).unwrap();
        let seed = test_seed();
        let me = wallet_core::algo_address(&seed, 0).unwrap();
        let other = wallet_core::algo_address(&seed, 1).unwrap();
        eprintln!("addresses: {me} {other}");
        tauri::async_runtime::block_on(async {
            net.tor.restart();
            while net.tor.status().state != TorState::Ready {
                assert_ne!(net.tor.status().state, TorState::Error);
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            }
            let c = AlgoCtx {
                net_client: &net,
                network: Network::Testnet,
                tor: true,
            };
            let t = std::time::Instant::now();
            eprintln!(
                "testnet probe {:?} in {:.1?}",
                algo_backend::probe(&c).await,
                t.elapsed()
            );
            let main = AlgoCtx {
                net_client: &net,
                network: Network::Mainnet,
                tor: true,
            };
            eprintln!("mainnet probe {:?}", algo_backend::probe(&main).await);
            let acc = algo_backend::account(&c, &me).await.unwrap();
            eprintln!("account {acc:?}");
            eprintln!("history: {}", algo_backend::txs(&c, &me).await.unwrap());
            if acc.exists {
                let r = build(&c, &me, &other, "1000", None).await;
                eprintln!("0.001 ALGO to empty {other}: {:?}", r.as_ref().err());
            }
            if std::env::var("KYRO_ALGO_SEND").as_deref() != Ok("yes") || !acc.exists {
                eprintln!("KYRO_ALGO_SEND != yes or account not funded: no payment");
                return;
            }
            let built = build(&c, &me, &other, "200000", Some("Kyro test Algorand"))
                .await
                .unwrap();
            let (summary, context) = prepare_sign(&c, &me, &built.blob).await.unwrap();
            assert_eq!(summary, built.summary);
            eprintln!(
                "--- dialog ---\n{}---\n{}---",
                describe_algo(Lang::Fr, &summary, &context, Network::Testnet),
                describe_algo_extra(Lang::Fr, &summary)
            );
            let (signed, txid, again) =
                wallet_core::algo_sign(&seed, 0, Network::Testnet, &built.blob).unwrap();
            assert_eq!(again, summary, "identical summary");
            let got = broadcast_checked(&c, &me, &signed).await.unwrap();
            assert_eq!(got, txid);
            eprintln!("SUBMITTED {txid}");
            for _ in 0..30 {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                let s = algo_backend::tx_status(&c, &txid).await.unwrap();
                if s.confirmed {
                    eprintln!("confirmed in round {:?}", s.round);
                    return;
                }
                assert!(s.error.is_none(), "{:?}", s.error);
            }
            panic!("{txid} not confirmed");
        });
    }
}
