//! IPC commands for Aptos (`aptos_*`): address, account (balance, sequence number, key not
//! rotated), history, APT transfer building **by Kyro** (`0x1::aptos_account::transfer`; sequence
//! number, gas price, simulated maximum gas and expiration from the node, encoded by wallet-core),
//! signing behind the password and the native dialog (what Rust decoded, balance and sequence
//! re-read live), and submission with hash check.

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, State};
use wallet_core::{AptosTransfer, AptosTxSummary, AptosWarning, Network};
use zeroize::Zeroizing;

use crate::accounts::{account_arg, confirm_signer, Chain, SignerInfo};
use crate::aptos_backend::{self, AptosAccountInfo, AptosCtx};
use crate::commands::{blocking, confirm_native, format_units_in, seed_from_password};
use crate::error::{AppError, AppResult};
use crate::i18n::Lang;
use crate::state::AppState;

pub(crate) fn ctx(state: &AppState) -> AptosCtx<'_> {
    AptosCtx {
        net_client: &state.net,
        tor: state.settings().tor.enabled,
        bases: aptos_backend::default_bases(state.network),
        chain_id: aptos_backend::chain_id_of(state.network),
    }
}

pub(crate) fn ours(state: &AppState, account: u32) -> AppResult<(String, [u8; 32])> {
    state.with_seed(|seed| {
        Ok((
            wallet_core::aptos_address(seed, account)?,
            wallet_core::aptos_public_key(seed, account)?,
        ))
    })
}

fn apt(lang: Lang, octas: &str) -> String {
    format!("{} APT", format_units_in(lang, octas, 8))
}

/// Live context shown in the dialog.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AptosContext {
    pub account: AptosAccountInfo,
    /// The recipient has never received or sent anything (sequence 0 and no APT): the transfer
    /// creates its account.
    pub recipient_new: bool,
    /// Simulated gas units (the fee actually paid is about this × the gas price).
    pub gas_used: String,
    /// UNIX seconds of the ledger when read.
    pub ledger_time: u64,
    /// Token transfer: our live balance of that token (token units).
    pub token_balance: Option<String>,
}

fn describe_token_head(
    lang: Lang,
    s: &AptosTxSummary,
    k: &wallet_core::AptosTokenSummary,
    c: &AptosContext,
    testnet: &str,
) -> String {
    let units = |v: &str| {
        format!(
            "{} {}",
            format_units_in(lang, v, usize::from(k.decimals)),
            k.symbol
        )
    };
    let mut out = match lang {
        Lang::Fr => format!(
            "Envoi de jeton Aptos{testnet}\n\nJeton : {} — actif vérifié par Kyro\n{}\n{} décimales\n\nÀ : {}\n(adresse sans somme de contrôle : compare-la en entier)\n\nMontant : {} ({} unités)\nSolde {} : {}\n",
            k.symbol,
            k.metadata,
            k.decimals,
            s.recipient,
            units(&s.amount),
            s.amount,
            k.symbol,
            c.token_balance.as_deref().map_or("?".into(), units)
        ),
        Lang::En => format!(
            "Aptos token send{testnet}\n\nToken: {} — asset verified by Kyro\n{}\n{} decimals\n\nTo: {}\n(address without checksum: compare all of it)\n\nAmount: {} ({} units)\n{} balance: {}\n",
            k.symbol,
            k.metadata,
            k.decimals,
            s.recipient,
            units(&s.amount),
            s.amount,
            k.symbol,
            c.token_balance.as_deref().map_or("?".into(), units)
        ),
    };
    if c.recipient_new {
        out += &match lang {
            Lang::Fr => format!(
                "Ce compte n'a pas encore de {} : le transfert crée sa réserve (un peu plus de gaz).\n",
                k.symbol
            ),
            Lang::En => format!(
                "This account holds no {} yet: the transfer creates its store (a bit more gas).\n",
                k.symbol
            ),
        };
    }
    out += lang.pick("Frais payés en APT :\n", "Fee paid in APT:\n");
    out
}

pub(crate) fn describe_aptos(
    lang: Lang,
    s: &AptosTxSummary,
    c: &AptosContext,
    net: Network,
) -> String {
    let ap = |v: &str| apt(lang, v);
    let testnet = if net == Network::Testnet {
        " (testnet)"
    } else {
        ""
    };
    let mut out = match (&s.token, lang) {
        (Some(k), _) => describe_token_head(lang, s, k, c, testnet),
        (None, Lang::Fr) => format!(
            "Envoi Aptos{testnet}\n\nÀ : {}\n(adresse sans somme de contrôle : compare-la en entier)\n\nMontant : {} ({} octas)\n",
            s.recipient,
            ap(&s.amount),
            s.amount
        ),
        (None, Lang::En) => format!(
            "Aptos send{testnet}\n\nTo: {}\n(address without checksum: compare all of it)\n\nAmount: {} ({} octas)\n",
            s.recipient,
            ap(&s.amount),
            s.amount
        ),
    };
    if c.recipient_new && s.token.is_none() {
        out += lang.pick(
            "Ce compte n'a encore rien reçu : le transfert le crée (un peu plus de gaz).\n",
            "This account has not received anything yet: the transfer creates it (a bit more gas).\n",
        );
    }
    let gas_used: u64 = c.gas_used.parse().unwrap_or(0);
    let price: u64 = s.gas_unit_price.parse().unwrap_or(0);
    let estimated = ap(&gas_used.saturating_mul(price).to_string());
    out += &match lang {
        Lang::Fr => format!(
            "\nFrais estimés : {estimated} ({} unités de gaz simulées × {} octas)\nFrais maximum : {} ({} unités × {} octas)\nSolde : {}\n",
            c.gas_used,
            s.gas_unit_price,
            ap(&s.max_fee),
            s.max_gas_amount,
            s.gas_unit_price,
            ap(&c.account.balance)
        ),
        Lang::En => format!(
            "\nEstimated fee: {estimated} ({} simulated gas units × {} octas)\nMaximum fee: {} ({} units × {} octas)\nBalance: {}\n",
            c.gas_used,
            s.gas_unit_price,
            ap(&s.max_fee),
            s.max_gas_amount,
            s.gas_unit_price,
            ap(&c.account.balance)
        ),
    };
    let left = s
        .expiration_timestamp_secs
        .saturating_sub(c.ledger_time)
        .div_ceil(60);
    out += &match lang {
        Lang::Fr => format!(
            "\nFonction : {}\nSéquence {} · chaîne {} · expire dans {left} min\n",
            s.function, s.sequence_number, s.chain_id
        ),
        Lang::En => format!(
            "\nFunction: {}\nSequence {} · chain {} · expires in {left} min\n",
            s.function, s.sequence_number, s.chain_id
        ),
    };
    out
}

pub(crate) fn describe_aptos_extra(lang: Lang, s: &AptosTxSummary) -> String {
    let mut out = String::from(lang.pick(
        "Kyro a trouvé des éléments inhabituels dans ce transfert :\n",
        "Kyro found unusual details in this transfer:\n",
    ));
    for w in &s.warnings {
        out += match w {
            AptosWarning::SelfTransfer => lang.pick(
                "• le destinataire est ton propre compte\n",
                "• the recipient is your own account\n",
            ),
            AptosWarning::HighFee => lang.pick(
                "• frais maximum supérieurs à 0,02 APT (d'habitude environ 0,0001 APT)\n",
                "• maximum fee above 0.02 APT (usually about 0.0001 APT)\n",
            ),
        };
    }
    out += "\n";
    out += lang.sign_anyway();
    out
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AptosBackendInfo {
    pub network: &'static str,
    pub label: String,
    pub tor: bool,
}

#[tauri::command]
pub fn aptos_backend_info(state: State<'_, AppState>) -> AptosBackendInfo {
    let c = ctx(&state);
    AptosBackendInfo {
        network: crate::commands::network_name(state.network),
        label: crate::servers::host_of(aptos_backend::current_base(&c)).unwrap_or_default(),
        tor: c.tor,
    }
}

/// Address of Aptos account `account` (absent = 0).
#[tauri::command]
pub fn aptos_address(state: State<'_, AppState>, account: Option<u32>) -> AppResult<String> {
    Ok(ours(&state, account_arg(account)?)?.0)
}

#[tauri::command]
pub async fn aptos_account(
    state: State<'_, AppState>,
    address: String,
) -> AppResult<AptosAccountInfo> {
    let c = ctx(&state);
    aptos_backend::checked_ledger(&c).await?;
    aptos_backend::account(&c, &address).await
}

#[tauri::command]
pub async fn aptos_txs(state: State<'_, AppState>, address: String) -> AppResult<Value> {
    aptos_backend::txs(&ctx(&state), &address).await
}

/// One line per fungible asset Kyro knows on this network.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AptosTokenBalance {
    pub metadata: String,
    pub symbol: String,
    pub decimals: u8,
    /// Token units.
    pub balance: String,
}

#[tauri::command]
pub async fn aptos_token_balances(
    state: State<'_, AppState>,
    address: String,
) -> AppResult<Vec<AptosTokenBalance>> {
    let c = ctx(&state);
    let mut out = Vec::new();
    for k in wallet_core::aptos_known_assets(c.chain_id) {
        out.push(AptosTokenBalance {
            metadata: k.metadata.into(),
            symbol: k.symbol.into(),
            decimals: k.decimals,
            balance: aptos_backend::fa_balance(&c, &address, k.metadata)
                .await?
                .to_string(),
        });
    }
    Ok(out)
}

/// Transfers of the known fungible assets (indexer, known metadata objects only).
#[tauri::command]
pub async fn aptos_token_txs(state: State<'_, AppState>, address: String) -> AppResult<Value> {
    aptos_backend::token_txs(&ctx(&state), &address).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AptosBuilt {
    /// Unsigned `RawTransaction`, hex BCS: what `aptos_sign_tx` signs.
    pub raw: String,
    pub summary: AptosTxSummary,
    pub context: AptosContext,
}

async fn recipient_new(c: &AptosCtx<'_>, to: &str) -> AppResult<bool> {
    let r = aptos_backend::account(c, to).await?;
    Ok(r.sequence_number == "0" && r.balance == "0")
}

pub(crate) async fn build(
    c: &AptosCtx<'_>,
    me: &str,
    pubkey: &[u8; 32],
    to: &str,
    amount: &str,
) -> AppResult<AptosBuilt> {
    let sender = wallet_core::aptos_parse_address(me)?;
    let recipient = wallet_core::aptos_parse_address(to)?;
    let amount: u64 = amount
        .trim()
        .parse()
        .ok()
        .filter(|a| *a > 0)
        .ok_or_else(|| AppError::InvalidInput("invalid amount in octas".into()))?;
    let ledger = aptos_backend::checked_ledger(c).await?;
    let account = aptos_backend::account(c, me).await?;
    aptos_backend::check_transfer(&account, amount, 0)?;
    let price = aptos_backend::gas_price(c).await?;
    let mut t = AptosTransfer {
        sender,
        sequence_number: account.sequence_number.parse().unwrap_or(0),
        recipient,
        amount,
        max_gas_amount: aptos_backend::MAX_MAX_GAS,
        gas_unit_price: price,
        expiration_timestamp_secs: ledger.timestamp_secs + aptos_backend::EXPIRATION_SECS,
        chain_id: c.chain_id,
        token: None,
    };
    let balance: u64 = account.balance.parse().unwrap_or(0);
    let room = balance.saturating_sub(amount) / price;
    t.max_gas_amount = room.clamp(1, aptos_backend::MAX_MAX_GAS);
    let raw = hex::encode(t.encode()?);
    let (ok, vm_status, gas_used) =
        aptos_backend::simulate(c, wallet_core::aptos_simulation_bytes(&raw, pubkey)?).await?;
    if !ok {
        return Err(AppError::InvalidInput(format!(
            "transfer simulation failed: {vm_status}{}",
            if vm_status.contains("INSUFFICIENT_BALANCE") || vm_status.contains("MAX_GAS_UNITS") {
                " (insufficient balance for the amount and the network fee)"
            } else {
                ""
            }
        )));
    }
    t.max_gas_amount = aptos_backend::max_gas_for(gas_used)?;
    aptos_backend::check_transfer(&account, amount, t.max_fee())?;
    let raw = hex::encode(t.encode()?);
    let summary = wallet_core::aptos_decode_tx(&raw, me)?;
    Ok(AptosBuilt {
        raw,
        summary,
        context: AptosContext {
            account,
            recipient_new: recipient_new(c, to).await?,
            gas_used: gas_used.to_string(),
            ledger_time: ledger.timestamp_secs,
            token_balance: None,
        },
    })
}

fn known_asset(c: &AptosCtx<'_>, metadata: &str) -> AppResult<[u8; 32]> {
    let m = wallet_core::aptos_parse_address(metadata)?;
    wallet_core::aptos_known_asset(&m, c.chain_id).ok_or_else(|| {
        AppError::InvalidInput("Aptos token unknown to Kyro on this network".into())
    })?;
    Ok(m)
}

async fn check_token(c: &AptosCtx<'_>, me: &str, metadata: &str, amount: u64) -> AppResult<u64> {
    let m = wallet_core::aptos_parse_address(metadata)?;
    let k = wallet_core::aptos_known_asset(&m, c.chain_id).ok_or_else(|| {
        AppError::InvalidInput("Aptos token unknown to Kyro on this network".into())
    })?;
    let have = aptos_backend::fa_balance(c, me, k.metadata).await?;
    if amount > have {
        return Err(AppError::InvalidInput(format!(
            "insufficient {} balance: {} {}",
            k.symbol,
            crate::commands::format_units(&have.to_string(), usize::from(k.decimals)),
            k.symbol
        )));
    }
    Ok(have)
}

pub(crate) async fn build_token(
    c: &AptosCtx<'_>,
    me: &str,
    pubkey: &[u8; 32],
    metadata: &str,
    to: &str,
    amount: &str,
) -> AppResult<AptosBuilt> {
    let token = known_asset(c, metadata)?;
    let sender = wallet_core::aptos_parse_address(me)?;
    let recipient = wallet_core::aptos_parse_address(to)?;
    let amount: u64 = amount
        .trim()
        .parse()
        .ok()
        .filter(|a| *a > 0)
        .ok_or_else(|| AppError::InvalidInput("invalid token amount".into()))?;
    let ledger = aptos_backend::checked_ledger(c).await?;
    let account = aptos_backend::account(c, me).await?;
    aptos_backend::check_transfer(&account, 0, 0)?;
    let have = check_token(c, me, metadata, amount).await?;
    let price = aptos_backend::gas_price(c).await?;
    let balance: u64 = account.balance.parse().unwrap_or(0);
    let mut t = AptosTransfer {
        sender,
        sequence_number: account.sequence_number.parse().unwrap_or(0),
        recipient,
        amount,
        max_gas_amount: (balance / price).clamp(1, aptos_backend::MAX_MAX_GAS),
        gas_unit_price: price,
        expiration_timestamp_secs: ledger.timestamp_secs + aptos_backend::EXPIRATION_SECS,
        chain_id: c.chain_id,
        token: Some(token),
    };
    let raw = hex::encode(t.encode()?);
    let (ok, vm_status, gas_used) =
        aptos_backend::simulate(c, wallet_core::aptos_simulation_bytes(&raw, pubkey)?).await?;
    if !ok {
        return Err(AppError::InvalidInput(format!(
            "transfer simulation failed: {vm_status}{}",
            if vm_status.contains("MAX_GAS_UNITS") || vm_status.contains("INSUFFICIENT_BALANCE") {
                " (not enough APT for the network fee)"
            } else {
                ""
            }
        )));
    }
    t.max_gas_amount = aptos_backend::max_gas_for(gas_used)?;
    aptos_backend::check_transfer(&account, 0, t.max_fee())?;
    let raw = hex::encode(t.encode()?);
    let summary = wallet_core::aptos_decode_tx(&raw, me)?;
    Ok(AptosBuilt {
        raw,
        summary,
        context: AptosContext {
            account,
            recipient_new: aptos_backend::fa_balance(c, to, metadata).await? == 0,
            gas_used: gas_used.to_string(),
            ledger_time: ledger.timestamp_secs,
            token_balance: Some(have.to_string()),
        },
    })
}

/// Transfer of a known fungible asset: `metadata` = its metadata object (`0x` + 64 hex),
/// `amount` in token units.
#[tauri::command]
pub async fn aptos_build_token_tx(
    state: State<'_, AppState>,
    metadata: String,
    to: String,
    amount: String,
    account: Option<u32>,
) -> AppResult<AptosBuilt> {
    let (me, pk) = ours(&state, account_arg(account)?)?;
    build_token(&ctx(&state), &me, &pk, &metadata, &to, &amount).await
}

#[tauri::command]
pub async fn aptos_build_tx(
    state: State<'_, AppState>,
    to: String,
    amount: String,
    account: Option<u32>,
) -> AppResult<AptosBuilt> {
    let (me, pk) = ours(&state, account_arg(account)?)?;
    build(&ctx(&state), &me, &pk, &to, &amount).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AptosSigned {
    /// Signed transaction, hex BCS: what `aptos_broadcast` submits.
    pub signed: String,
    pub hash: String,
    pub summary: AptosTxSummary,
    pub context: AptosContext,
}

pub(crate) async fn prepare_sign(
    c: &AptosCtx<'_>,
    me: &str,
    pubkey: &[u8; 32],
    raw: &str,
) -> AppResult<(AptosTxSummary, AptosContext)> {
    let summary = wallet_core::aptos_decode_tx(raw, me)?;
    if summary.chain_id != c.chain_id {
        return Err(AppError::InvalidInput(format!(
            "transaction for chain {}, not for the app's ({})",
            summary.chain_id, c.chain_id
        )));
    }
    let ledger = aptos_backend::checked_ledger(c).await?;
    if summary.expiration_timestamp_secs < ledger.timestamp_secs + aptos_backend::MIN_REMAINING_SECS
    {
        return Err(AppError::InvalidInput(
            "Aptos transfer expired or about to expire: rebuild it".into(),
        ));
    }
    if summary.expiration_timestamp_secs
        > ledger.timestamp_secs + aptos_backend::EXPIRATION_SECS + 60
    {
        return Err(AppError::InvalidInput(
            "expiration too far in the future: Kyro does not sign a transfer valid for more than 10 minutes"
                .into(),
        ));
    }
    let account = aptos_backend::account(c, me).await?;
    if summary.sequence_number != account.sequence_number {
        return Err(AppError::InvalidInput(
            "stale sequence number: rebuild the transfer".into(),
        ));
    }
    let amount: u64 = summary.amount.parse().unwrap_or(u64::MAX);
    let max_fee: u64 = summary.max_fee.parse().unwrap_or(u64::MAX);
    let token_balance = match &summary.token {
        None => {
            aptos_backend::check_transfer(&account, amount, max_fee)?;
            None
        }
        Some(k) => {
            aptos_backend::check_transfer(&account, 0, max_fee)?;
            Some(check_token(c, me, &k.metadata, amount).await?.to_string())
        }
    };
    let (ok, vm_status, gas_used) =
        aptos_backend::simulate(c, wallet_core::aptos_simulation_bytes(raw, pubkey)?).await?;
    if !ok {
        return Err(AppError::InvalidInput(format!(
            "transfer simulation failed: {vm_status}"
        )));
    }
    let recipient_new = match &summary.token {
        None => recipient_new(c, &summary.recipient).await?,
        Some(k) => aptos_backend::fa_balance(c, &summary.recipient, &k.metadata).await? == 0,
    };
    Ok((
        summary,
        AptosContext {
            account,
            recipient_new,
            gas_used: gas_used.to_string(),
            ledger_time: ledger.timestamp_secs,
            token_balance,
        },
    ))
}

#[tauri::command]
pub async fn aptos_sign_tx(
    app: AppHandle,
    state: State<'_, AppState>,
    raw: String,
    password: String,
    account: Option<u32>,
) -> AppResult<AptosSigned> {
    if !state.is_unlocked() {
        return Err(AppError::Locked);
    }
    let a = account_arg(account)?;
    let (me, pk) = ours(&state, a)?;
    let signer = SignerInfo::new(&state, Chain::Apt, a, wallet_core::aptos_path(a));
    let c = ctx(&state);
    let (summary, context) = prepare_sign(&c, &me, &pk, &raw).await?;
    let seed = seed_from_password(&state, Zeroizing::new(password)).await?;
    let lang = crate::i18n::current();
    confirm_native(
        &app,
        if summary.token.is_some() {
            lang.pick(
                "Confirmer l'envoi de jeton Aptos",
                "Confirm the Aptos token send",
            )
        } else {
            lang.pick("Confirmer l'envoi d'APT", "Confirm the APT send")
        },
        signer.body(
            lang,
            &describe_aptos(lang, &summary, &context, state.network),
        ),
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
            describe_aptos_extra(lang, &summary),
        )
        .await?;
    }
    let r = raw.clone();
    let (signed, hash, again) =
        blocking(move || Ok(wallet_core::aptos_sign(&seed, a, &r)?)).await?;
    if again != summary {
        return Err(AppError::Internal(
            "summary differs between the preview and the signature".into(),
        ));
    }
    state.touch();
    Ok(AptosSigned {
        signed,
        hash,
        summary,
        context,
    })
}

pub(crate) async fn broadcast_checked(
    c: &AptosCtx<'_>,
    me: &str,
    signed: &str,
) -> AppResult<String> {
    let (hash, t) = wallet_core::aptos_verify_signed(signed)?;
    if t.sender != wallet_core::aptos_parse_address(me)? {
        return Err(AppError::InvalidInput(
            "this transfer is not signed by your account".into(),
        ));
    }
    if t.chain_id != c.chain_id {
        return Err(AppError::InvalidInput(
            "transfer signed for another chain".into(),
        ));
    }
    let bytes = hex::decode(signed.trim().trim_start_matches("0x"))
        .map_err(|_| AppError::InvalidInput("transaction: hexadecimal expected".into()))?;
    aptos_backend::submit(c, bytes, &hash).await
}

#[tauri::command]
pub async fn aptos_broadcast(
    state: State<'_, AppState>,
    signed: String,
    account: Option<u32>,
) -> AppResult<String> {
    let (me, _) = ours(&state, account_arg(account)?)?;
    broadcast_checked(&ctx(&state), &me, &signed).await
}

/// `{ committed, success, vmStatus }` of a submitted transaction.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AptosTxStatus {
    pub committed: bool,
    pub success: bool,
    pub vm_status: String,
}

#[tauri::command]
pub async fn aptos_tx_status(state: State<'_, AppState>, hash: String) -> AppResult<AptosTxStatus> {
    let h = hash.trim().to_ascii_lowercase();
    let hex_part = h.strip_prefix("0x").unwrap_or(&h);
    if hex_part.len() != 64 || !hex_part.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(AppError::InvalidInput(
            "hash: 0x followed by 64 hexadecimal characters".into(),
        ));
    }
    let (committed, success, vm_status) =
        aptos_backend::tx_status(&ctx(&state), &format!("0x{hex_part}")).await?;
    Ok(AptosTxStatus {
        committed,
        success,
        vm_status,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summary() -> AptosTxSummary {
        AptosTxSummary {
            sender: format!("0x{}", "11".repeat(32)),
            recipient: "0x726c91e2852985c2a8c16f32a64c131bd2a0fd1e0aa985a1e0e6002407506ac0".into(),
            function: "0x1::aptos_account::transfer".into(),
            amount: "150000000".into(),
            sequence_number: "7".into(),
            max_gas_amount: "200".into(),
            gas_unit_price: "100".into(),
            max_fee: "20000".into(),
            expiration_timestamp_secs: 1_000_600,
            chain_id: 2,
            warnings: vec![],
            requires_extra_confirmation: false,
            token: None,
        }
    }

    fn context(new: bool) -> AptosContext {
        AptosContext {
            account: AptosAccountInfo {
                balance: "500000000".into(),
                ..Default::default()
            },
            recipient_new: new,
            gas_used: "11".into(),
            ledger_time: 1_000_000,
            token_balance: None,
        }
    }

    #[test]
    fn token_dialog_shows_asset_metadata_and_decimals() {
        let mut s = summary();
        s.function = "0x1::primary_fungible_store::transfer".into();
        s.amount = "2500000".into();
        s.token = Some(wallet_core::AptosTokenSummary {
            metadata: "0x357b0b74bc833e95a115ad22604854d6b0fca151cecd94111770e5d6ffc9dc2b".into(),
            symbol: "USDT".into(),
            name: "Tether".into(),
            decimals: 6,
        });
        let mut c = context(true);
        c.token_balance = Some("10000000".into());
        let d = describe_aptos(Lang::Fr, &s, &c, Network::Mainnet);
        for needle in [
            "Envoi de jeton Aptos\n",
            "Jeton : USDT — actif vérifié par Kyro\n0x357b0b74bc833e95a115ad22604854d6b0fca151cecd94111770e5d6ffc9dc2b\n6 décimales",
            "À : 0x726c91e2852985c2a8c16f32a64c131bd2a0fd1e0aa985a1e0e6002407506ac0\n",
            "Montant : 2,5 USDT (2500000 unités)",
            "Solde USDT : 10 USDT",
            "pas encore de USDT",
            "Frais payés en APT",
            "Frais maximum : 0,0002 APT",
            "Fonction : 0x1::primary_fungible_store::transfer",
        ] {
            assert!(d.contains(needle), "{needle} missing in:\n{d}");
        }
        assert!(!d.contains("le transfert le crée"));
        let en = describe_aptos(Lang::En, &s, &c, Network::Testnet);
        assert!(
            en.contains("Aptos token send (testnet)")
                && en.contains("Amount: 2.5 USDT (2500000 units)")
        );
    }

    #[test]
    fn dialog_shows_what_rust_decoded() {
        let d = describe_aptos(Lang::Fr, &summary(), &context(false), Network::Testnet);
        for needle in [
            "Envoi Aptos (testnet)",
            "À : 0x726c91e2852985c2a8c16f32a64c131bd2a0fd1e0aa985a1e0e6002407506ac0\n",
            "Montant : 1,5 APT (150000000 octas)",
            "Frais estimés : 0,000011 APT (11 unités de gaz simulées × 100 octas)",
            "Frais maximum : 0,0002 APT (200 unités × 100 octas)",
            "Solde : 5 APT",
            "Fonction : 0x1::aptos_account::transfer",
            "Séquence 7 · chaîne 2 · expire dans 10 min",
        ] {
            assert!(d.contains(needle), "{needle} missing in:\n{d}");
        }
        assert!(!d.contains("le transfert le crée"));
        let d = describe_aptos(Lang::Fr, &summary(), &context(true), Network::Mainnet);
        assert!(d.starts_with("Envoi Aptos\n"));
        assert!(d.contains("le transfert le crée"));
        let mut s = summary();
        s.warnings = vec![AptosWarning::SelfTransfer, AptosWarning::HighFee];
        let x = describe_aptos_extra(Lang::Fr, &s);
        assert!(x.contains("ton propre compte") && x.contains("0,02 APT"));
        let en = describe_aptos(Lang::En, &summary(), &context(false), Network::Testnet);
        assert!(
            en.contains("Amount: 1.5 APT (150000000 octas)") && en.contains("expires in 10 min")
        );
    }
}

/// Real-network test over Tor.
#[cfg(test)]
mod live {
    use super::*;
    use crate::net::{Family, NetClient, ServerRequest};
    use crate::tor::TorState;

    fn test_seed() -> wallet_core::Seed {
        let path =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../.env.aptos-devnet");
        let words = match std::fs::read_to_string(&path) {
            Ok(s) => s
                .lines()
                .find_map(|l| l.strip_prefix("KYRO_APTOS_TEST_MNEMONIC="))
                .expect("mnemonic line")
                .trim()
                .to_owned(),
            Err(_) => {
                let m = wallet_core::Mnemonic::generate(wallet_core::WordCount::W12).unwrap();
                let w = m.words().join(" ");
                std::fs::write(
                    &path,
                    format!("# APTOS DEVNET ONLY — random test mnemonic generated by Kyro's live test (commands_aptos.rs).\n# Never use it for real funds. This file is gitignored (.env.*).\nKYRO_APTOS_TEST_MNEMONIC={w}\n"),
                )
                .unwrap();
                eprintln!("new test mnemonic written to {}", path.display());
                w
            }
        };
        wallet_core::Mnemonic::parse(&words).unwrap().to_seed("")
    }

    /// Each fallback fullnode alone over Tor (`--ignored --nocapture`): which ones answer.
    #[test]
    #[ignore]
    fn aptos_hosts_over_tor() {
        let net = NetClient::new(std::env::temp_dir().join("kyro-aptos-hosts")).unwrap();
        tauri::async_runtime::block_on(async {
            net.tor.restart();
            while net.tor.status().state != TorState::Ready {
                assert_ne!(net.tor.status().state, TorState::Error);
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            }
            for n in [Network::Mainnet, Network::Testnet] {
                for u in aptos_backend::default_urls(n) {
                    let c = AptosCtx {
                        net_client: &net,
                        tor: true,
                        bases: vec![(*u).to_owned()],
                        chain_id: aptos_backend::chain_id_of(n),
                    };
                    let t = std::time::Instant::now();
                    let l = aptos_backend::checked_ledger(&c).await;
                    let h = aptos_backend::txs(
                        &c,
                        "0x0000000000000000000000000000000000000000000000000000000000000001",
                    )
                    .await
                    .map(|_| "ok");
                    eprintln!("{u}: ledger {l:?} indexer {h:?} in {:.1?}", t.elapsed());
                }
            }
        });
    }

    #[test]
    #[ignore]
    fn aptos_live_over_tor() {
        let net = NetClient::new(std::env::temp_dir().join("kyro-aptos-live")).unwrap();
        let tor = std::env::var("KYRO_APTOS_CLEAR").as_deref() != Ok("yes");
        tauri::async_runtime::block_on(async {
            if tor {
                net.tor.restart();
                while net.tor.status().state != TorState::Ready {
                    assert_ne!(net.tor.status().state, TorState::Error);
                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                }
            }
            let mk = |network: Network| AptosCtx {
                net_client: &net,
                tor,
                bases: aptos_backend::default_bases(network),
                chain_id: aptos_backend::chain_id_of(network),
            };
            let testnet = mk(Network::Testnet);
            let mainnet = mk(Network::Mainnet);
            let t = std::time::Instant::now();
            eprintln!(
                "testnet probe {:?} in {:.1?}",
                aptos_backend::probe(&testnet).await,
                t.elapsed()
            );
            eprintln!("mainnet probe {:?}", aptos_backend::probe(&mainnet).await);
            let wrong = AptosCtx {
                chain_id: 2,
                ..mk(Network::Mainnet)
            };
            let e = aptos_backend::probe(&wrong).await;
            eprintln!("wrong network: {e:?}");
            assert!(matches!(e, Err(AppError::ServerWrongNetwork(_))));
            let busy = "0x19fc2203cda87b3d8e19bb90b867506bb2db30a0fb1771fd9e595c17d8de0789";
            eprintln!(
                "mainnet account {:?}",
                aptos_backend::account(&mainnet, busy).await
            );
            eprintln!(
                "mainnet gas price {:?}",
                aptos_backend::gas_price(&mainnet).await
            );
            let h = aptos_backend::txs(&mainnet, busy).await.unwrap();
            eprintln!(
                "mainnet history: {} entries, first {}",
                h.as_array().unwrap().len(),
                h[0]
            );

            if std::env::var("KYRO_APTOS_SEND").as_deref() != Ok("yes") {
                eprintln!("KYRO_APTOS_SEND != yes: no transfer");
                return;
            }
            let seed = test_seed();
            let me = wallet_core::aptos_address(&seed, 0).unwrap();
            let pk = wallet_core::aptos_public_key(&seed, 0).unwrap();
            let to = wallet_core::aptos_address(&seed, 1).unwrap();
            let mut dev = AptosCtx {
                net_client: &net,
                tor,
                bases: vec!["https://api.devnet.aptoslabs.com/v1".into()],
                chain_id: 0,
            };
            dev.chain_id = aptos_backend::ledger(&dev).await.unwrap().chain_id;
            eprintln!("devnet chain id {} — {me} → {to}", dev.chain_id);
            let mut acc = aptos_backend::account(&dev, &me).await.unwrap();
            if acc.balance.parse::<u64>().unwrap() < 20_000_000 {
                let req = ServerRequest::post_bytes(
                    url::Url::parse(&format!(
                        "https://faucet.devnet.aptoslabs.com/mint?amount=100000000&address={me}"
                    ))
                    .unwrap(),
                    Family::Aptos,
                    "application/json",
                    Vec::new(),
                );
                let (status, body) = net.server_request(req, tor).await.unwrap();
                eprintln!("faucet: HTTP {status} {}", String::from_utf8_lossy(&body));
                for _ in 0..30 {
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                    acc = aptos_backend::account(&dev, &me).await.unwrap();
                    if acc.balance != "0" {
                        break;
                    }
                }
            }
            eprintln!("account {acc:?}");
            let r = build(&dev, &me, &pk, &to, &acc.balance).await;
            eprintln!("whole balance (no room for gas): {:?}", r.as_ref().err());
            assert!(matches!(r, Err(AppError::InvalidInput(_))));

            let before: u64 = aptos_backend::account(&dev, &to)
                .await
                .unwrap()
                .balance
                .parse()
                .unwrap();
            let built = build(&dev, &me, &pk, &to, "1234567").await.unwrap();
            let (summary, context) = prepare_sign(&dev, &me, &pk, &built.raw).await.unwrap();
            assert_eq!(summary, built.summary);
            eprintln!(
                "--- dialog ---\n{}---",
                describe_aptos(Lang::Fr, &summary, &context, Network::Testnet)
            );
            let (signed, hash, again) = wallet_core::aptos_sign(&seed, 0, &built.raw).unwrap();
            assert_eq!(again, summary, "identical summary");
            let got = broadcast_checked(&dev, &me, &signed).await.unwrap();
            assert_eq!(got, hash);
            eprintln!("SUBMITTED {hash}");
            for _ in 0..30 {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                let (committed, success, vm) = aptos_backend::tx_status(&dev, &hash).await.unwrap();
                if committed {
                    eprintln!("committed: success={success} {vm}");
                    assert!(success);
                    let r = aptos_backend::account(&dev, &to).await.unwrap();
                    eprintln!("recipient now {r:?}");
                    assert_eq!(r.balance.parse::<u64>().unwrap(), before + 1_234_567);
                    eprintln!("history: {}", aptos_backend::txs(&dev, &me).await.unwrap());
                    return;
                }
            }
            panic!("{hash} not committed");
        });
    }

    #[test]
    #[ignore]
    fn aptos_token_simulation_mainnet() {
        let net = NetClient::new(std::env::temp_dir().join("kyro-aptos-live")).unwrap();
        tauri::async_runtime::block_on(async {
            let c = AptosCtx {
                net_client: &net,
                tor: false,
                bases: aptos_backend::default_bases(Network::Mainnet),
                chain_id: 1,
            };
            let me = "0xbabf76f1e6ac1af9c2666c07be12f90b188ed484fcef0bf1408961b5461373e9";
            let pk: [u8; 32] =
                hex::decode("7a446f7fd8a470fa8abe6c32aa8264c0ecbe78ce83b52e55b0006d5e43957c05")
                    .unwrap()
                    .try_into()
                    .unwrap();
            let to = "0xa044357a441c87a85c5887ddfeb0428a8a25ab2a789b23a2b472b6c6c385d228";
            for k in wallet_core::aptos_known_assets(1) {
                let have = aptos_backend::fa_balance(&c, me, k.metadata).await.unwrap();
                eprintln!("{} balance {have}", k.symbol);
                if have == 0 {
                    continue;
                }
                let built = build_token(&c, me, &pk, k.metadata, to, "1").await.unwrap();
                eprintln!(
                    "--- dialog ---\n{}",
                    describe_aptos(Lang::Fr, &built.summary, &built.context, Network::Mainnet)
                );
                let (s, _) = prepare_sign(&c, me, &pk, &built.raw).await.unwrap();
                assert_eq!(s, built.summary);
            }
            assert!(!aptos_backend::token_txs(&c, me)
                .await
                .unwrap()
                .as_array()
                .unwrap()
                .is_empty());
        });
    }
}
