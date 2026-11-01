//! IPC commands for NEAR Protocol (`near_*`): implicit-account address, account (balance,
//! storage reserve, spendable), history, transfer building **by Kyro** (nonce and block hash
//! from the node, Borsh encoded by wallet-core), signing behind the password and the native
//! dialog (receiver, amount, fee bound, signing account), and `send_tx` with hash check.
//! Contract: docs/IPC.md §2.11.

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, State};
use wallet_core::{NearAccountKind, NearTransfer, NearTxSummary, NearWarning, Network};
use zeroize::Zeroizing;

use crate::accounts::{account_arg, confirm_signer, Chain, SignerInfo};
use crate::commands::{blocking, confirm_native, format_units_in, seed_from_password};
use crate::error::{AppError, AppResult};
use crate::i18n::Lang;
use crate::near_backend::{
    self, NearAccountInfo, NearCtx, NearFeeParams, NearTxOutcome, TransferCheck, MAX_BLOCK_AGE,
};
use crate::servers::{host_of, utxo_network_key};
use crate::state::AppState;

pub(crate) fn ctx(state: &AppState) -> NearCtx<'_> {
    NearCtx {
        net_client: &state.net,
        network: state.network,
        tor: state.settings().tor.enabled,
    }
}

/// Implicit account id and public key of NEAR account `account` (`m/44'/397'/account'`).
fn ours(state: &AppState, account: u32) -> AppResult<(String, [u8; 32])> {
    state.with_seed(|seed| {
        Ok((
            wallet_core::near_address(seed, account)?,
            wallet_core::near_public_key(seed, account)?,
        ))
    })
}

fn near(lang: Lang, yocto: &str) -> String {
    format!("{} NEAR", format_units_in(lang, yocto, 24))
}

/// Live context shown in the dialog.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NearContext {
    pub account: NearAccountInfo,
    pub receiver: NearAccountInfo,
    /// The transfer creates the receiver (implicit account not on chain yet).
    pub creates_account: bool,
    /// yoctoNEAR per gas, now.
    pub gas_price: String,
    /// yoctoNEAR: expected fee at the current gas price.
    pub fee_estimate: String,
    /// yoctoNEAR: what the balance must cover on top of the amount (see near_backend).
    pub fee_bound: String,
    /// Token transfer: live token facts.
    pub token: Option<NearTokenContext>,
}

/// Live facts of a NEP-141 transfer.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NearTokenContext {
    /// Our balance of the token (units).
    pub balance: String,
    /// The recipient is registered with the token (`storage_balance_of` not null).
    pub recipient_registered: bool,
}

/// Gas a token call usually burns (5 Tgas): for the estimate only; the bound uses the 30 Tgas
/// attached to each call, prepaid then refunded.
const FT_GAS_ESTIMATE: u128 = 5_000_000_000_000;

/// Dialog head of a NEP-141 transfer: token, verified contract, decimals, recipient, amount,
/// storage deposit explained.
fn describe_token_head(
    lang: Lang,
    s: &NearTxSummary,
    k: &wallet_core::NearTokenSummary,
    c: &NearContext,
    testnet: &str,
) -> String {
    let n = |v: &str| near(lang, v);
    let units = |v: &str| {
        format!(
            "{} {}",
            format_units_in(lang, v, usize::from(k.decimals)),
            k.symbol
        )
    };
    let bal = c
        .token
        .as_ref()
        .map_or("?".to_owned(), |t| units(&t.balance));
    let mut out = match lang {
        Lang::Fr => format!(
            "Envoi de jeton NEAR (NEP-141){testnet}\n\nJeton : {} — contrat vérifié par Kyro {}\n{} décimales\n\nÀ : {}\n({})\n\nMontant : {} ({} unités)\nSolde {} : {bal}\n",
            k.symbol,
            k.contract,
            k.decimals,
            k.recipient,
            kind_text(lang, k.recipient_kind),
            units(&k.amount),
            k.amount,
            k.symbol
        ),
        Lang::En => format!(
            "NEAR token send (NEP-141){testnet}\n\nToken: {} — contract verified by Kyro {}\n{} decimals\n\nTo: {}\n({})\n\nAmount: {} ({} units)\n{} balance: {bal}\n",
            k.symbol,
            k.contract,
            k.decimals,
            k.recipient,
            kind_text(lang, k.recipient_kind),
            units(&k.amount),
            k.amount,
            k.symbol
        ),
    };
    out += &match (&k.storage_deposit, lang) {
        (Some(d), Lang::Fr) => format!(
            "\nLe destinataire n'est pas encore inscrit auprès de ce jeton : Kyro ajoute storage_deposit pour lui, {} payés par toi (le stockage de son solde sur le contrat).\n",
            n(d)
        ),
        (Some(d), Lang::En) => format!(
            "\nThe recipient is not registered with this token yet: Kyro adds storage_deposit for it, {} paid by you (the storage of its balance on the contract).\n",
            n(d)
        ),
        (None, _) => lang
            .pick(
                "\nLe destinataire est déjà inscrit auprès de ce jeton.\n",
                "\nThe recipient is already registered with this token.\n",
            )
            .to_owned(),
    };
    out += &match lang {
        Lang::Fr => format!(
            "NEAR joints en tout : {} (1 yoctoNEAR exigé par ft_transfer + le dépôt éventuel)\n",
            n(&s.deposit)
        ),
        Lang::En => format!(
            "NEAR attached in total: {} (1 yoctoNEAR required by ft_transfer + the deposit, if any)\n",
            n(&s.deposit)
        ),
    };
    out
}

fn kind_text(lang: Lang, k: NearAccountKind) -> &'static str {
    match k {
        NearAccountKind::Implicit => lang.pick(
            "compte implicite : la clé publique du destinataire, en hexadécimal",
            "implicit account: the receiver's public key, in hexadecimal",
        ),
        NearAccountKind::EthImplicit => lang.pick(
            "compte de style Ethereum, contrôlé par une clé Ethereum",
            "Ethereum-style account, controlled by an Ethereum key",
        ),
        NearAccountKind::Named => lang.pick("compte nommé", "named account"),
    }
}

/// Body of the native dialog.
pub(crate) fn describe_near(
    lang: Lang,
    s: &NearTxSummary,
    c: &NearContext,
    net: Network,
) -> String {
    let n = |v: &str| near(lang, v);
    let testnet = if net == Network::Testnet {
        " (testnet)"
    } else {
        ""
    };
    let mut out = match (&s.token, lang) {
        (Some(k), _) => describe_token_head(lang, s, k, c, testnet),
        (None, Lang::Fr) => format!(
            "Envoi NEAR{testnet}\n\nÀ : {}\n({})\n\nMontant : {} ({} yoctoNEAR)\n",
            s.receiver_id,
            kind_text(lang, s.receiver_kind),
            n(&s.deposit),
            s.deposit
        ),
        (None, Lang::En) => format!(
            "NEAR send{testnet}\n\nTo: {}\n({})\n\nAmount: {} ({} yoctoNEAR)\n",
            s.receiver_id,
            kind_text(lang, s.receiver_kind),
            n(&s.deposit),
            s.deposit
        ),
    };
    if c.creates_account && s.token.is_none() {
        out += lang.pick(
            "\nCe compte implicite n'existe pas encore : ce transfert le crée (frais de création inclus ci-dessous).\n",
            "\nThis implicit account does not exist yet: this transfer creates it (creation fee included below).\n",
        );
    }
    out += &match lang {
        Lang::Fr => format!(
            "\nFrais : ≈ {} — au plus {}\n(les frais NEAR ne sont pas écrits dans la transaction : ils sont prélevés au prix du gas du bloc ; Kyro a vérifié que ton solde couvre le montant + cette borne)\n",
            n(&c.fee_estimate),
            n(&c.fee_bound)
        ),
        Lang::En => format!(
            "\nFee: ≈ {} — at most {}\n(NEAR fees are not written in the transaction: they are charged at the block's gas price; Kyro checked that your balance covers the amount + this bound)\n",
            n(&c.fee_estimate),
            n(&c.fee_bound)
        ),
    };
    out += &match lang {
        Lang::Fr => format!(
            "Solde : {} · réservé au stockage : {} · disponible : {}\n",
            n(&c.account.balance),
            n(&c.account.storage_reserve),
            n(&c.account.spendable)
        ),
        Lang::En => format!(
            "Balance: {} · reserved for storage: {} · available: {}\n",
            n(&c.account.balance),
            n(&c.account.storage_reserve),
            n(&c.account.spendable)
        ),
    };
    out += &match lang {
        Lang::Fr => format!(
            "\nDe : {}\nClé : {} · nonce {}\nBloc de référence : {} (transaction valable ≈ 24 h)\nHash de la transaction : {}\n",
            s.signer_id, s.public_key, s.nonce, s.block_hash, s.hash
        ),
        Lang::En => format!(
            "\nFrom: {}\nKey: {} · nonce {}\nReference block: {} (transaction valid for ≈ 24 h)\nTransaction hash: {}\n",
            s.signer_id, s.public_key, s.nonce, s.block_hash, s.hash
        ),
    };
    out
}

pub(crate) fn describe_near_extra(lang: Lang, s: &NearTxSummary) -> String {
    let mut out = String::from(lang.pick(
        "Kyro a trouvé des éléments inhabituels dans ce transfert :\n",
        "Kyro found unusual elements in this transfer:\n",
    ));
    for w in &s.warnings {
        out += match w {
            NearWarning::EthImplicitReceiver => lang.pick(
                "• le destinataire est un compte NEAR de style Ethereum (0x…) : il est contrôlé par une clé Ethereum. Une adresse de dépôt EVM d'une plateforme n'est PAS un compte NEAR.\n",
                "• the receiver is an Ethereum-style NEAR account (0x…): it is controlled by an Ethereum key. An exchange's EVM deposit address is NOT a NEAR account.\n",
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
pub struct NearBackendInfo {
    pub kind: &'static str,
    pub network: &'static str,
    /// RPC host.
    pub label: String,
    /// History host.
    pub history: String,
    pub tor: bool,
}

#[tauri::command]
pub fn near_backend_info(state: State<'_, AppState>) -> NearBackendInfo {
    let c = ctx(&state);
    NearBackendInfo {
        kind: "default",
        network: utxo_network_key(state.network),
        label: host_of(near_backend::rpc_url(&c)).unwrap_or_default(),
        history: host_of(near_backend::history_url(&c)).unwrap_or_default(),
        tor: c.tor,
    }
}

/// Implicit account id of NEAR account `account` (absent = 0).
#[tauri::command]
pub fn near_address(state: State<'_, AppState>, account: Option<u32>) -> AppResult<String> {
    Ok(ours(&state, account_arg(account)?)?.0)
}

#[tauri::command]
pub async fn near_account(
    state: State<'_, AppState>,
    account_id: String,
) -> AppResult<NearAccountInfo> {
    let c = ctx(&state);
    let fees = near_backend::fees(&c).await?;
    near_backend::account(&c, &account_id, fees.storage_per_byte).await
}

#[tauri::command]
pub async fn near_txs(state: State<'_, AppState>, account_id: String) -> AppResult<Value> {
    near_backend::txs(&ctx(&state), &account_id).await
}

/// One line per NEP-141 token Kyro knows on this network.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NearTokenBalance {
    pub contract: String,
    pub symbol: String,
    pub decimals: u8,
    /// Token units.
    pub balance: String,
    /// Registered with the token (`storage_balance_of` not null).
    pub registered: bool,
}

#[tauri::command]
pub async fn near_token_balances(
    state: State<'_, AppState>,
    account_id: String,
) -> AppResult<Vec<NearTokenBalance>> {
    let c = ctx(&state);
    let id = account_id.trim();
    wallet_core::near_account_kind(id)?;
    let mut out = Vec::new();
    for k in wallet_core::near_known_tokens(c.network == Network::Testnet) {
        out.push(NearTokenBalance {
            contract: k.contract.into(),
            symbol: k.symbol.into(),
            decimals: k.decimals,
            balance: near_backend::ft_balance(&c, k.contract, id)
                .await?
                .to_string(),
            registered: near_backend::ft_registered(&c, k.contract, id).await?,
        });
    }
    Ok(out)
}

// ---------------------------------------------------------------- build, sign, broadcast

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NearBuilt {
    /// Unsigned transaction (Borsh, hex): what `near_sign_tx` signs.
    pub tx: String,
    pub summary: NearTxSummary,
    pub context: NearContext,
}

async fn live_context(
    c: &NearCtx<'_>,
    me: &str,
    to: &str,
) -> AppResult<(NearFeeParams, NearContext)> {
    let kind = wallet_core::near_account_kind(to)?;
    // Before building or signing: the RPC is on the app's network (chain id + genesis), synced.
    near_backend::probe(c).await?;
    let fees = near_backend::fees(c).await?;
    let account = near_backend::account(c, me, fees.storage_per_byte).await?;
    let receiver = near_backend::account(c, to, fees.storage_per_byte).await?;
    let creates = near_backend::creates_account(&receiver, kind);
    Ok((
        fees,
        NearContext {
            account,
            receiver,
            creates_account: creates,
            gas_price: fees.gas_price.to_string(),
            fee_estimate: fees.estimate(creates).to_string(),
            fee_bound: fees.bound(creates).to_string(),
            token: None,
        },
    ))
}

fn known_token(c: &NearCtx<'_>, contract: &str) -> AppResult<&'static wallet_core::NearKnownToken> {
    match wallet_core::near_known_token(contract.trim()) {
        Some((k, tn)) if tn == (c.network == Network::Testnet) => Ok(k),
        _ => Err(AppError::InvalidInput(
            "NEAR token unknown to Kyro on this network".into(),
        )),
    }
}

/// Live context of a token transfer of `k` to `to`: our NEAR account (fees, deposit), the
/// recipient (must exist if named), our token balance, the recipient's registration. The fee
/// figures are for `calls` function calls of 30 Tgas each.
async fn token_context(
    c: &NearCtx<'_>,
    me: &str,
    k: &wallet_core::NearKnownToken,
    to: &str,
    calls: u128,
) -> AppResult<(NearFeeParams, NearContext)> {
    let kind = wallet_core::near_account_kind(to)?;
    near_backend::probe(c).await?;
    let fees = near_backend::fees(c).await?;
    let account = near_backend::account(c, me, fees.storage_per_byte).await?;
    let receiver = near_backend::account(c, to, fees.storage_per_byte).await?;
    if !receiver.exists && kind != NearAccountKind::Implicit {
        return Err(AppError::InvalidInput(format!(
            "the account \"{to}\" does not exist: the tokens would be stuck"
        )));
    }
    let balance = near_backend::ft_balance(c, k.contract, me).await?;
    let registered = near_backend::ft_registered(c, k.contract, to).await?;
    let price = fees.gas_price.max(fees.min_gas_price);
    let prepaid = calls * u128::from(wallet_core::NEAR_FT_GAS) * price;
    Ok((
        fees,
        NearContext {
            account,
            receiver,
            creates_account: false,
            gas_price: fees.gas_price.to_string(),
            fee_estimate: (fees.estimate(false) + calls * FT_GAS_ESTIMATE * fees.gas_price)
                .to_string(),
            fee_bound: (fees.bound(false) + prepaid).to_string(),
            token: Some(NearTokenContext {
                balance: balance.to_string(),
                recipient_registered: registered,
            }),
        },
    ))
}

/// Token amount ≤ our balance; NEAR attached + fee bound ≤ our spendable NEAR.
fn check_token(
    s: &NearTxSummary,
    k: &wallet_core::NearTokenSummary,
    c: &NearContext,
) -> AppResult<()> {
    let have: u128 = c
        .token
        .as_ref()
        .and_then(|t| t.balance.parse().ok())
        .unwrap_or(0);
    let amount: u128 = k.amount.parse().unwrap_or(u128::MAX);
    if amount > have {
        return Err(AppError::InvalidInput(format!(
            "insufficient {} balance: {} {}",
            k.symbol,
            crate::commands::format_units(&have.to_string(), usize::from(k.decimals)),
            k.symbol
        )));
    }
    if !c.account.exists {
        return Err(AppError::InvalidInput(
            "your NEAR account does not exist yet: it is created by the first NEAR received".into(),
        ));
    }
    let spendable: u128 = c.account.spendable.parse().unwrap_or(0);
    let need = s
        .deposit
        .parse::<u128>()
        .unwrap_or(u128::MAX)
        .saturating_add(c.fee_bound.parse().unwrap_or(u128::MAX));
    if need > spendable {
        return Err(AppError::InvalidInput(format!(
            "not enough NEAR for the fees: {} NEAR available, {} needed (gas of the contract calls, mostly refunded, + possible storage deposit)",
            crate::commands::format_units(&spendable.to_string(), 24),
            crate::commands::format_units(&need.to_string(), 24)
        )));
    }
    Ok(())
}

/// Builds an unsigned NEP-141 transfer of `amount` units of the known token `contract` to `to`,
/// with `storage_deposit` for `to` first when it is not registered with the token.
pub(crate) async fn build_token(
    c: &NearCtx<'_>,
    me: &str,
    pubkey: &[u8; 32],
    contract: &str,
    to: &str,
    amount: &str,
) -> AppResult<NearBuilt> {
    let k = known_token(c, contract)?;
    let to = to.trim();
    wallet_core::near_account_kind(to)?;
    if to == me {
        return Err(AppError::InvalidInput("transfer to yourself".into()));
    }
    let a = amount.trim();
    let units: u128 = (!a.is_empty() && a.len() <= 39 && a.bytes().all(|b| b.is_ascii_digit()))
        .then(|| a.parse().ok())
        .flatten()
        .filter(|v: &u128| *v > 0)
        .ok_or_else(|| AppError::InvalidInput("invalid token amount".into()))?;
    let registered = near_backend::ft_registered(c, k.contract, to).await?;
    let storage_deposit = if registered {
        None
    } else {
        let min = near_backend::ft_storage_min(c, k.contract).await?;
        if min == 0 || min > wallet_core::NEAR_MAX_STORAGE_DEPOSIT {
            return Err(AppError::ServerUnreachable(
                "NEAR: implausible token storage deposit".into(),
            ));
        }
        Some(min)
    };
    let calls = if storage_deposit.is_some() { 2 } else { 1 };
    let (_, context) = token_context(c, me, k, to, calls).await?;
    let (key_nonce, block_hash, _) = near_backend::access_key(c, me, pubkey).await?;
    let tx = NearTransfer {
        signer_id: me.to_owned(),
        public_key: *pubkey,
        nonce: key_nonce
            .checked_add(1)
            .ok_or_else(|| AppError::Internal("NEAR nonce at its maximum".into()))?,
        receiver_id: k.contract.to_owned(),
        block_hash,
        deposit: 0,
        ft: Some(wallet_core::NearFtTransfer {
            recipient: to.to_owned(),
            amount: units,
            storage_deposit,
        }),
    };
    let hex_tx = hex::encode(tx.encode());
    let summary = wallet_core::near_decode_tx(&hex_tx, me, pubkey)?;
    let Some(ts) = &summary.token else {
        return Err(AppError::Internal("unrecognized token transfer".into()));
    };
    check_token(&summary, ts, &context)?;
    Ok(NearBuilt {
        tx: hex_tx,
        summary,
        context,
    })
}

/// NEP-141 transfer of a known token: `contract`, `to`, `amount` in token units.
#[tauri::command]
pub async fn near_build_token_tx(
    state: State<'_, AppState>,
    contract: String,
    to: String,
    amount: String,
    account: Option<u32>,
) -> AppResult<NearBuilt> {
    let (me, pk) = ours(&state, account_arg(account)?)?;
    build_token(&ctx(&state), &me, &pk, &contract, &to, &amount).await
}

fn check(s: &NearTxSummary, fees: &NearFeeParams, c: &NearContext) -> AppResult<()> {
    near_backend::check_transfer(&TransferCheck {
        ours: &c.account,
        receiver: &c.receiver,
        receiver_kind: s.receiver_kind,
        deposit: s
            .deposit
            .parse()
            .map_err(|_| AppError::Internal("unreadable NEAR amount".into()))?,
        fees,
    })
}

/// Parses a yoctoNEAR amount (decimal integer string).
fn parse_yocto(amount: &str) -> AppResult<u128> {
    let a = amount.trim();
    if a.is_empty() || a.len() > 40 || !a.bytes().all(|b| b.is_ascii_digit()) {
        return Err(AppError::InvalidInput("invalid amount in yoctoNEAR".into()));
    }
    a.parse::<u128>()
        .ok()
        .filter(|d| *d > 0)
        .ok_or_else(|| AppError::InvalidInput("invalid amount in yoctoNEAR".into()))
}

/// Builds an unsigned transfer of `amount` yoctoNEAR from live data.
pub(crate) async fn build(
    c: &NearCtx<'_>,
    me: &str,
    pubkey: &[u8; 32],
    to: &str,
    amount: &str,
) -> AppResult<NearBuilt> {
    let to = to.trim();
    wallet_core::near_account_kind(to)?;
    let deposit = parse_yocto(amount)?;
    let (fees, context) = live_context(c, me, to).await?;
    let (key_nonce, block_hash, _) = near_backend::access_key(c, me, pubkey).await?;
    let tx = NearTransfer {
        signer_id: me.to_owned(),
        public_key: *pubkey,
        nonce: key_nonce
            .checked_add(1)
            .ok_or_else(|| AppError::Internal("NEAR nonce at its maximum".into()))?,
        receiver_id: to.to_owned(),
        block_hash,
        deposit,
        ft: None,
    };
    let hex_tx = hex::encode(tx.encode());
    let summary = wallet_core::near_decode_tx(&hex_tx, me, pubkey)?;
    check(&summary, &fees, &context)?;
    Ok(NearBuilt {
        tx: hex_tx,
        summary,
        context,
    })
}

#[tauri::command]
pub async fn near_build_tx(
    state: State<'_, AppState>,
    to: String,
    amount: String,
    account: Option<u32>,
) -> AppResult<NearBuilt> {
    let (me, pk) = ours(&state, account_arg(account)?)?;
    build(&ctx(&state), &me, &pk, &to, &amount).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NearSigned {
    /// Signed transaction (Borsh, hex): what `near_broadcast` sends.
    pub signed: String,
    pub hash: String,
    pub summary: NearTxSummary,
    pub context: NearContext,
}

/// Decoding + live re-checks, i.e. everything `near_sign_tx` does before the dialog.
pub(crate) async fn prepare_sign(
    c: &NearCtx<'_>,
    me: &str,
    pubkey: &[u8; 32],
    tx_hex: &str,
) -> AppResult<(NearTxSummary, NearContext)> {
    let summary = wallet_core::near_decode_tx(tx_hex, me, pubkey)?;
    let (fees, context) = match &summary.token {
        None => live_context(c, me, &summary.receiver_id).await?,
        Some(t) => {
            let k = known_token(c, &t.contract)?;
            if t.testnet != (c.network == Network::Testnet) {
                return Err(AppError::InvalidInput(
                    "token contract from another network".into(),
                ));
            }
            let calls = if t.storage_deposit.is_some() { 2 } else { 1 };
            let (fees, context) = token_context(c, me, k, &t.recipient, calls).await?;
            let registered = context
                .token
                .as_ref()
                .is_some_and(|x| x.recipient_registered);
            if t.storage_deposit.is_none() && !registered {
                return Err(AppError::InvalidInput(
                    "the recipient is no longer registered with the token: rebuild the transfer"
                        .into(),
                ));
            }
            (fees, context)
        }
    };
    let (key_nonce, _, height) = near_backend::access_key(c, me, pubkey).await?;
    let nonce: u64 = summary.nonce.parse().unwrap_or(0);
    if nonce <= key_nonce {
        return Err(AppError::InvalidInput(
            "stale nonce (another transaction went through in the meantime): rebuild the transfer"
                .into(),
        ));
    }
    let built_at = near_backend::block_height(c, &summary.block_hash).await?;
    if height.saturating_sub(built_at) > MAX_BLOCK_AGE {
        return Err(AppError::InvalidInput(
            "NEAR transfer too old (reference block more than an hour old): rebuild it".into(),
        ));
    }
    match &summary.token {
        None => check(&summary, &fees, &context)?,
        Some(t) => check_token(&summary, t, &context)?,
    }
    Ok((summary, context))
}

#[tauri::command]
pub async fn near_sign_tx(
    app: AppHandle,
    state: State<'_, AppState>,
    tx: String,
    password: String,
    account: Option<u32>,
) -> AppResult<NearSigned> {
    if !state.is_unlocked() {
        return Err(AppError::Locked);
    }
    let a = account_arg(account)?;
    let (me, pk) = ours(&state, a)?;
    let signer = SignerInfo::new(&state, Chain::Near, a, wallet_core::near_path(a));
    let c = ctx(&state);
    let (summary, context) = prepare_sign(&c, &me, &pk, &tx).await?;
    let seed = seed_from_password(&state, Zeroizing::new(password)).await?;
    let lang = crate::i18n::current();
    confirm_native(
        &app,
        if summary.token.is_some() {
            lang.pick(
                "Confirmer l'envoi de jeton NEAR",
                "Confirm the NEAR token send",
            )
        } else {
            lang.pick("Confirmer l'envoi NEAR", "Confirm the NEAR send")
        },
        signer.body(
            lang,
            &describe_near(lang, &summary, &context, state.network),
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
            describe_near_extra(lang, &summary),
        )
        .await?;
    }
    let t = tx.clone();
    let (signed, hash, again) = blocking(move || Ok(wallet_core::near_sign(&seed, a, &t)?)).await?;
    if again != summary {
        return Err(AppError::Internal(
            "summary differs between the preview and the signature".into(),
        ));
    }
    state.touch();
    Ok(NearSigned {
        signed,
        hash,
        summary,
        context,
    })
}

/// Checks the signed transaction (strict decoding, signature by our key, our account) then
/// sends it.
pub(crate) async fn broadcast_checked(
    c: &NearCtx<'_>,
    me: &str,
    signed_hex: &str,
) -> AppResult<NearTxOutcome> {
    let (tx, hash) = wallet_core::near_verify_signed(signed_hex)?;
    if tx.signer_id != me {
        return Err(AppError::InvalidInput(
            "this transaction is not signed by your account".into(),
        ));
    }
    let raw = hex::decode(signed_hex.trim())
        .map_err(|_| AppError::InvalidInput("transaction: hexadecimal expected".into()))?;
    near_backend::send(c, &raw, &hash).await
}

#[tauri::command]
pub async fn near_broadcast(
    state: State<'_, AppState>,
    signed: String,
    account: Option<u32>,
) -> AppResult<NearTxOutcome> {
    let (me, _) = ours(&state, account_arg(account)?)?;
    broadcast_checked(&ctx(&state), &me, &signed).await
}

/// Status of a sent transaction of account `account` (`pending` until executed).
#[tauri::command]
pub async fn near_tx_status(
    state: State<'_, AppState>,
    hash: String,
    account: Option<u32>,
) -> AppResult<NearTxOutcome> {
    let h = hash.trim();
    wallet_core::near_parse_hash(h)?;
    let (me, _) = ours(&state, account_arg(account)?)?;
    near_backend::tx_status(&ctx(&state), h, &me).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summary(kind: NearAccountKind, warnings: Vec<NearWarning>) -> NearTxSummary {
        NearTxSummary {
            signer_id: "5510e2b44cae6eb807e3e0e45d579dda058c274abcba15e5cb84636f5d1ee412".into(),
            public_key: "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp".into(),
            nonce: "187000000000001".into(),
            receiver_id: "bob.testnet".into(),
            receiver_kind: kind,
            deposit: "1500000000000000000000000".into(),
            block_hash: "244ZQ9cgj3CQ6bWBdytfrJMuMQ1jdXLFGnr4HhvtCTnM".into(),
            hash: "4XTVLd3z94Rjfp5rpNcKNqqfXbKNhf1bwtonhj77uvPs".into(),
            requires_extra_confirmation: !warnings.is_empty(),
            warnings,
            token: None,
        }
    }

    fn context(creates: bool) -> NearContext {
        NearContext {
            account: NearAccountInfo {
                exists: true,
                balance: "10000000000000000000000000".into(),
                storage_reserve: "1820000000000000000000".into(),
                spendable: "9998180000000000000000000".into(),
                ..Default::default()
            },
            receiver: NearAccountInfo {
                exists: !creates,
                ..Default::default()
            },
            creates_account: creates,
            gas_price: "100000000".into(),
            fee_estimate: "44636512500000000000".into(),
            fee_bound: "892730250000000000000".into(),
            token: None,
        }
    }

    #[test]
    fn token_dialog_shows_contract_decimals_and_storage_deposit() {
        let mut s = summary(NearAccountKind::Implicit, vec![]);
        s.receiver_id = "usdt.tether-token.near".into();
        s.deposit = "1250000000000000000001".into();
        s.token = Some(wallet_core::NearTokenSummary {
            contract: "usdt.tether-token.near".into(),
            symbol: "USDT".into(),
            name: "Tether".into(),
            decimals: 6,
            testnet: false,
            recipient: "bob.near".into(),
            recipient_kind: NearAccountKind::Named,
            amount: "2500000".into(),
            storage_deposit: Some("1250000000000000000000".into()),
        });
        let mut c = context(false);
        c.token = Some(NearTokenContext {
            balance: "9000000".into(),
            recipient_registered: false,
        });
        let d = describe_near(Lang::Fr, &s, &c, Network::Mainnet);
        for needle in [
            "Envoi de jeton NEAR (NEP-141)\n",
            "Jeton : USDT — contrat vérifié par Kyro usdt.tether-token.near\n6 décimales",
            "À : bob.near\n(compte nommé)",
            "Montant : 2,5 USDT (2500000 unités)",
            "Solde USDT : 9 USDT",
            "storage_deposit pour lui, 0,00125 NEAR payés par toi",
            "NEAR joints en tout : 0,001250000000000000000001 NEAR",
            "Frais : ≈",
        ] {
            assert!(d.contains(needle), "{needle} missing in:\n{d}");
        }
        if let Some(t) = s.token.as_mut() {
            t.storage_deposit = None;
        }
        let en = describe_near(Lang::En, &s, &c, Network::Testnet);
        assert!(
            en.contains("NEAR token send (NEP-141) (testnet)") && en.contains("already registered")
        );
    }

    #[test]
    fn dialog_shows_receiver_amount_fee_bound_and_key() {
        let d = describe_near(
            Lang::Fr,
            &summary(NearAccountKind::Named, vec![]),
            &context(false),
            Network::Testnet,
        );
        for needle in [
            "Envoi NEAR (testnet)",
            "À : bob.testnet\n(compte nommé)",
            "Montant : 1,5 NEAR (1500000000000000000000000 yoctoNEAR)",
            "Frais : ≈ 0,0000446365125 NEAR — au plus 0,00089273025 NEAR",
            "disponible : 9,99818 NEAR",
            "nonce 187000000000001",
            "Hash de la transaction : 4XTVLd3z94Rjfp5rpNcKNqqfXbKNhf1bwtonhj77uvPs",
        ] {
            assert!(d.contains(needle), "{needle} missing in:\n{d}");
        }
        assert!(!d.contains("n'existe pas encore"));
        let d = describe_near(
            Lang::Fr,
            &summary(NearAccountKind::Implicit, vec![]),
            &context(true),
            Network::Mainnet,
        );
        assert!(d.starts_with("Envoi NEAR\n"));
        assert!(d.contains("ce transfert le crée"));
        assert!(d.contains("compte implicite"));
        let x = describe_near_extra(
            Lang::Fr,
            &summary(
                NearAccountKind::EthImplicit,
                vec![NearWarning::EthImplicitReceiver],
            ),
        );
        assert!(x.contains("style Ethereum") && x.contains("Signer quand même"));
        let d = describe_near(
            Lang::En,
            &summary(NearAccountKind::Named, vec![]),
            &context(false),
            Network::Testnet,
        );
        assert!(
            d.contains("Amount: 1.5 NEAR")
                && d.contains(
                    "To: bob.testnet
(named account)"
                )
        );
    }

    #[test]
    fn amounts() {
        assert_eq!(parse_yocto("1").unwrap(), 1);
        assert_eq!(
            parse_yocto(" 1500000000000000000000000 ").unwrap(),
            1_500_000_000_000_000_000_000_000
        );
        for bad in ["", "0", "-1", "1.5", "1e24", "x", &"9".repeat(41)] {
            assert!(parse_yocto(bad).is_err(), "{bad:?}");
        }
        assert_eq!(near(Lang::Fr, "1"), "0,000000000000000000000001 NEAR");
    }

    /// NEP-141 transfers built by Kyro for real mainnet implicit holders (the account id is the
    /// public key: no secret needed to build and run the live checks; nothing is signed or sent),
    /// to a registered recipient and to a fresh implicit account (storage_deposit added).
    /// `cargo test -p kyro-desktop --lib near_token_live_mainnet -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn near_token_live_mainnet() {
        let net = crate::net::NetClient::new(std::env::temp_dir().join("kyro-near-live")).unwrap();
        tauri::async_runtime::block_on(async {
            let c = NearCtx {
                net_client: &net,
                network: Network::Mainnet,
                tor: false,
            };
            let holders = [
                "e589457354361489a89039b8be6737cbc2db4d13919b6ccf23889a60f3b0d8f3",
                "fe58c8fb2458f59e9e081ac92ee2306cfd5f0067087fd36ef031a42cf4ba8d3a",
                "3501fb232e87e0ed795953b79e65c33b26a652d095f54ca10b0251e636f060a3",
            ];
            let fresh = "11".repeat(32);
            let mut done = 0;
            for k in wallet_core::near_known_tokens(false) {
                for me in holders {
                    let pk: [u8; 32] = hex::decode(me).unwrap().try_into().unwrap();
                    let bal = near_backend::ft_balance(&c, k.contract, me).await.unwrap();
                    eprintln!("{} {me}: {bal}", k.symbol);
                    if bal == 0 {
                        continue;
                    }
                    let other = holders.iter().find(|h| **h != me).unwrap();
                    for to in [*other, fresh.as_str()] {
                        match build_token(&c, me, &pk, k.contract, to, "1").await {
                            Ok(b) => {
                                let (s, ctx) = prepare_sign(&c, me, &pk, &b.tx).await.unwrap();
                                assert_eq!(s, b.summary);
                                let registered = near_backend::ft_registered(&c, k.contract, to)
                                    .await
                                    .unwrap();
                                assert_eq!(
                                    s.token.as_ref().unwrap().storage_deposit.is_some(),
                                    !registered
                                );
                                assert!(to != fresh || !registered);
                                eprintln!(
                                    "--- {} → {to} ---\n{}",
                                    k.symbol,
                                    describe_near(Lang::Fr, &s, &ctx, Network::Mainnet)
                                );
                                done += 1;
                            }
                            Err(e) => eprintln!("{} {me} → {to}: {e}", k.symbol),
                        }
                    }
                    break;
                }
            }
            assert!(done >= 2);
            let h = near_backend::txs(&c, holders[0]).await.unwrap();
            let tokens: Vec<_> = h
                .as_array()
                .unwrap()
                .iter()
                .flat_map(|t| t["tokens"].as_array().cloned().unwrap_or_default())
                .collect();
            eprintln!("token history of {}: {tokens:?}", holders[0]);
        });
    }
}
