//! IPC commands for Sui (`sui_*`): address, balance, history, SUI transfers **built by Kyro**
//! (gas coins, reference gas price and epoch read live, BCS encoded by wallet-core, budget from a
//! simulation of a draft), signing behind the password and the native dialog (recipient in full,
//! amount, coin type, gas budget / price, simulated fee, signing account), and execution with a
//! digest check. Contract: docs/IPC.md §2.11.

use serde::{Serialize, Serializer};
use serde_json::Value;
use tauri::{AppHandle, State};
use wallet_core::{Network, SuiTransfer, SuiTransferAmount, SuiTxSummary, SuiWarning};
use zeroize::Zeroizing;

use crate::accounts::{account_arg, confirm_signer, Chain, SignerInfo};
use crate::commands::{blocking, confirm_native, format_units_in, seed_from_password};
use crate::error::{AppError, AppResult};
use crate::i18n::Lang;
use crate::servers::{host_of, utxo_network_key};
use crate::state::AppState;
use crate::sui_backend::{self, SuiCtx, DRAFT_BUDGET};

/// A gas price above this many times the reference price is refused (Kyro uses the reference).
const MAX_PRICE_FACTOR: u64 = 10;

pub(crate) fn ctx(state: &AppState) -> SuiCtx<'_> {
    SuiCtx::new(&state.net, state.network, state.settings().tor.enabled)
}

fn ours(state: &AppState, account: u32) -> AppResult<String> {
    state.with_seed(|seed| Ok(wallet_core::sui_address(seed, account)?))
}

fn sui(lang: Lang, mist: &str) -> String {
    format!("{} SUI", format_units_in(lang, mist, 9))
}

fn signed_sui(lang: Lang, v: i128) -> String {
    if v < 0 {
        format!("−{}", sui(lang, &v.unsigned_abs().to_string()))
    } else {
        sui(lang, &v.to_string())
    }
}

fn as_string<S: Serializer>(v: &i128, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_str(&v.to_string())
}

/// Live context shown in the dialog (and returned to the interface).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SuiContext {
    /// MIST held in SUI coin objects (spendable by Kyro).
    pub balance: String,
    /// MIST in the gas coins of this transaction.
    pub gas_coins_total: String,
    /// MIST of each gas coin, same order as `summary.gas_coins` (read live: coin still ours at
    /// that version and digest).
    pub gas_coin_balances: Vec<String>,
    /// MIST per gas unit.
    pub reference_gas_price: String,
    pub epoch: u64,
    /// Simulated costs (MIST).
    pub computation_cost: String,
    pub storage_cost: String,
    pub storage_rebate: String,
    /// `computation + storage − rebate`, signed decimal.
    #[serde(serialize_with = "as_string")]
    pub fee: i128,
    /// MIST the recipient receives according to the simulation (the whole-balance case; token
    /// transfer: token units).
    pub receives: Option<String>,
    /// Token transfer: the token coins read live.
    pub token: Option<SuiTokenContext>,
}

/// Live state of the token coins of a token transfer.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SuiTokenContext {
    /// Units held in coin objects of this token (spendable by Kyro).
    pub balance: String,
    /// Units in the token coins of this transfer.
    pub coins_total: String,
    /// Units of each token coin, same order as `summary.token.coins`.
    pub coin_balances: Vec<String>,
}

fn units(lang: Lang, v: &str, k: &wallet_core::SuiTokenSummary) -> String {
    format!(
        "{} {}",
        format_units_in(lang, v, usize::from(k.decimals)),
        k.symbol
    )
}

/// Dialog body of a token transfer: token, verified coin type, decimals, amount, recipient,
/// the token coins merged, then the gas (paid in SUI) like a SUI transfer.
fn describe_token(
    lang: Lang,
    s: &SuiTxSummary,
    k: &wallet_core::SuiTokenSummary,
    c: &SuiContext,
    testnet: &str,
) -> String {
    let line = "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━";
    let mut out = match lang {
        Lang::Fr => format!(
            "Envoi de jeton Sui{testnet}\n\nJeton : {} — type vérifié par Kyro\n{}\n{} décimales\n\nÀ : {}\n(adresse Sui complète : 0x + 64 caractères, sans somme de contrôle — compare-la en entier)\n{line}\n",
            k.symbol, k.coin_type, k.decimals, s.recipient
        ),
        Lang::En => format!(
            "Sui token send{testnet}\n\nToken: {} — type verified by Kyro\n{}\n{} decimals\n\nTo: {}\n(full Sui address: 0x + 64 characters, no checksum — compare all of it)\n{line}\n",
            k.symbol, k.coin_type, k.decimals, s.recipient
        ),
    };
    let t = c.token.as_ref();
    match &s.amount {
        Some(a) => {
            out += &format!(
                "{}{} ({a} {})\n",
                lang.pick("Montant : ", "Amount: "),
                units(lang, a, k),
                lang.pick("unités", "units")
            )
        }
        None => {
            out += &match lang {
                Lang::Fr => format!(
                    "Montant : TOUT LE SOLDE {} des pièces ci-dessous ({})\n",
                    k.symbol,
                    t.map_or("?".into(), |t| units(lang, &t.coins_total, k))
                ),
                Lang::En => format!(
                    "Amount: THE WHOLE {} BALANCE of the coins below ({})\n",
                    k.symbol,
                    t.map_or("?".into(), |t| units(lang, &t.coins_total, k))
                ),
            }
        }
    }
    out += &match lang {
        Lang::Fr => format!(
            "Pièces {} fusionnées : {} · solde {} envoyable : {}\n",
            k.symbol,
            k.coins.len(),
            k.symbol,
            t.map_or("?".into(), |t| units(lang, &t.balance, k))
        ),
        Lang::En => format!(
            "{} coins merged: {} · sendable {} balance: {}\n",
            k.symbol,
            k.coins.len(),
            k.symbol,
            t.map_or("?".into(), |t| units(lang, &t.balance, k))
        ),
    };
    for (i, g) in k.coins.iter().take(SHOWN_GAS_COINS).enumerate() {
        let b = t
            .and_then(|t| t.coin_balances.get(i))
            .map_or("?".to_owned(), |b| units(lang, b, k));
        out += &format!(
            "  • {} (version {}){}{b}\n",
            g.object_id,
            g.version,
            lang.colon()
        );
    }
    if k.coins.len() > SHOWN_GAS_COINS {
        out += &format!(
            "  • … {} {} {}\n",
            lang.pick("et", "and"),
            k.coins.len() - SHOWN_GAS_COINS,
            lang.pick("autres pièces", "other coins")
        );
    }
    out += &format!("{line}\n");
    out += lang.pick(
        "Frais payés en SUI (pièces de gaz ci-dessous) :\n",
        "Fee paid in SUI (gas coins below):\n",
    );
    out
}

/// Body of the native dialog.
pub(crate) fn describe_sui(lang: Lang, s: &SuiTxSummary, c: &SuiContext, net: Network) -> String {
    let testnet = if net == Network::Testnet {
        " (testnet)"
    } else {
        ""
    };
    let mut out = if let Some(k) = &s.token {
        describe_token(lang, s, k, c, testnet)
    } else {
        describe_sui_head(lang, s, c, testnet)
    };
    out += &describe_gas(lang, s, c);
    out
}

/// Recipient, amount and coin type of a SUI transfer.
fn describe_sui_head(lang: Lang, s: &SuiTxSummary, c: &SuiContext, testnet: &str) -> String {
    let line = "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━";
    let su = |v: &str| sui(lang, v);
    let mut out = match lang {
        Lang::Fr => format!(
            "Envoi Sui{testnet}\n\nÀ : {}\n(adresse Sui complète : 0x + 64 caractères, sans somme de contrôle — compare-la en entier)\n{line}\n",
            s.recipient
        ),
        Lang::En => format!(
            "Sui send{testnet}\n\nTo: {}\n(full Sui address: 0x + 64 characters, no checksum — compare all of it)\n{line}\n",
            s.recipient
        ),
    };
    match &s.amount {
        Some(m) => {
            out += &format!(
                "{}{} ({m} MIST)\n",
                lang.pick("Montant : ", "Amount: "),
                su(m)
            )
        }
        None => {
            out += lang.pick(
                "Montant : TOUT LE SOLDE des pièces de gaz ci-dessous, moins les frais\n",
                "Amount: THE WHOLE BALANCE of the gas coins below, minus the fee\n",
            );
            if let Some(r) = &c.receives {
                out += &match lang {
                    Lang::Fr => format!(
                        "(le destinataire recevrait {} selon la simulation)\n",
                        su(r)
                    ),
                    Lang::En => format!(
                        "(the recipient would receive {} according to the simulation)\n",
                        su(r)
                    ),
                };
            }
        }
    }
    out += &format!(
        "{}SUI ({})\n{line}\n",
        lang.pick("Jeton : ", "Token: "),
        s.coin_type
    );
    out
}

/// Fee, gas budget and price, gas coins, expiration and digest (every transfer).
fn describe_gas(lang: Lang, s: &SuiTxSummary, c: &SuiContext) -> String {
    let su = |v: &str| sui(lang, v);
    let mut out = String::new();
    out += &match lang {
        Lang::Fr => format!(
            "Frais estimés (simulation) : {} — calcul {} + stockage {} − remboursement {}\n",
            signed_sui(lang, c.fee),
            su(&c.computation_cost),
            su(&c.storage_cost),
            su(&c.storage_rebate)
        ),
        Lang::En => format!(
            "Estimated fee (simulation): {} — computation {} + storage {} − rebate {}\n",
            signed_sui(lang, c.fee),
            su(&c.computation_cost),
            su(&c.storage_cost),
            su(&c.storage_rebate)
        ),
    };
    out += &match lang {
        Lang::Fr => format!(
            "Budget de gaz maximal : {} ({} MIST) · prix du gaz : {} MIST/unité (référence {})\n",
            su(&s.gas_budget),
            s.gas_budget,
            s.gas_price,
            c.reference_gas_price
        ),
        Lang::En => format!(
            "Maximum gas budget: {} ({} MIST) · gas price: {} MIST/unit (reference {})\n",
            su(&s.gas_budget),
            s.gas_budget,
            s.gas_price,
            c.reference_gas_price
        ),
    };
    out += &match lang {
        Lang::Fr => format!(
            "Pièces de gaz : {} (total {}) · solde dépensable : {}\n",
            s.gas_coins.len(),
            su(&c.gas_coins_total),
            su(&c.balance)
        ),
        Lang::En => format!(
            "Gas coins: {} (total {}) · spendable balance: {}\n",
            s.gas_coins.len(),
            su(&c.gas_coins_total),
            su(&c.balance)
        ),
    };
    out += &gas_coin_lines(lang, s, c);
    match s.expiration_epoch {
        Some(e) => {
            out += &match lang {
                Lang::Fr => format!(
                    "Valable jusqu'à la fin de l'époque n° {e} (époque actuelle {})\n",
                    c.epoch
                ),
                Lang::En => format!(
                    "Valid until the end of epoch {e} (current epoch {})\n",
                    c.epoch
                ),
            }
        }
        None => out += lang.pick("AUCUNE EXPIRATION\n", "NO EXPIRATION\n"),
    }
    out += &format!("{}{}\n", lang.pick("Empreinte : ", "Digest: "), s.digest);
    out
}

/// Gas coins listed one by one in the dialog.
const SHOWN_GAS_COINS: usize = 5;

/// One line per gas coin (full object id and version decoded from the bytes, balance read live),
/// the first [`SHOWN_GAS_COINS`], then the count and total of the others.
fn gas_coin_lines(lang: Lang, s: &SuiTxSummary, c: &SuiContext) -> String {
    let mut out = String::new();
    for (i, g) in s.gas_coins.iter().take(SHOWN_GAS_COINS).enumerate() {
        let b = c
            .gas_coin_balances
            .get(i)
            .map_or("?".to_owned(), |b| sui(lang, b));
        out += &format!(
            "  • {} (version {}){}{b}\n",
            g.object_id,
            g.version,
            lang.colon()
        );
    }
    if s.gas_coins.len() > SHOWN_GAS_COINS {
        let rest: u128 = c
            .gas_coin_balances
            .iter()
            .skip(SHOWN_GAS_COINS)
            .map(|b| b.parse::<u128>().unwrap_or(0))
            .sum();
        out += &format!(
            "  • … {} {} {} ({})\n",
            lang.pick("et", "and"),
            s.gas_coins.len() - SHOWN_GAS_COINS,
            lang.pick("autres pièces", "other coins"),
            sui(lang, &rest.to_string())
        );
    }
    out
}

pub(crate) fn describe_sui_extra(lang: Lang, s: &SuiTxSummary) -> String {
    let mut out = String::from(lang.pick(
        "Kyro a trouvé des éléments inhabituels dans ce transfert :\n",
        "Kyro found unusual elements in this transfer:\n",
    ));
    for w in &s.warnings {
        out += match w {
            SuiWarning::SendAll if s.token.is_some() => lang.pick(
                "• tout le solde du jeton (pièces listées) part\n",
                "• the whole token balance (listed coins) goes\n",
            ),
            SuiWarning::SendAll => lang.pick(
                "• tout le solde des pièces de gaz part (il ne restera que ce que les frais n'ont pas utilisé : rien)\n",
                "• the whole balance of the gas coins goes (only what the fee did not use will remain: nothing)\n",
            ),
            SuiWarning::SelfTransfer => lang.pick(
                "• le destinataire est ton propre compte\n",
                "• the recipient is your own account\n",
            ),
            SuiWarning::HighGasBudget => lang.pick(
                "• budget de gaz supérieur à 0,1 SUI (un transfert coûte d'habitude quelques millièmes)\n",
                "• gas budget above 0.1 SUI (a transfer usually costs a few thousandths)\n",
            ),
            SuiWarning::NoExpiration => lang.pick(
                "• aucune époque d'expiration : la transaction signée resterait valable\n",
                "• no expiration epoch: the signed transaction would stay valid\n",
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
pub struct SuiBackendInfo {
    pub kind: &'static str,
    pub network: &'static str,
    pub label: String,
    pub tor: bool,
}

#[tauri::command]
pub fn sui_backend_info(state: State<'_, AppState>) -> SuiBackendInfo {
    let c = ctx(&state);
    SuiBackendInfo {
        kind: "default",
        network: utxo_network_key(state.network),
        label: host_of(&c.url).unwrap_or_default(),
        tor: c.tor,
    }
}

/// Address of Sui account `account` (absent = 0), `m/44'/784'/account'/0'/0'`.
#[tauri::command]
pub fn sui_address(state: State<'_, AppState>, account: Option<u32>) -> AppResult<String> {
    ours(&state, account_arg(account)?)
}

#[tauri::command]
pub async fn sui_balance(
    state: State<'_, AppState>,
    address: String,
) -> AppResult<sui_backend::SuiBalance> {
    sui_backend::balance(&ctx(&state), &address).await
}

#[tauri::command]
pub async fn sui_txs(state: State<'_, AppState>, address: String) -> AppResult<Value> {
    sui_backend::txs(&ctx(&state), &address).await
}

/// Balances of the token coin types Kyro knows (Circle's USDC).
#[tauri::command]
pub async fn sui_token_balances(
    state: State<'_, AppState>,
    address: String,
) -> AppResult<Vec<sui_backend::SuiTokenBalance>> {
    sui_backend::token_balances(&ctx(&state), &address).await
}

// ---------------------------------------------------------------- build, sign, broadcast

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SuiBuilt {
    /// Unsigned `TransactionData`, BCS base64: what `sui_sign_tx` signs.
    pub bcs: String,
    pub summary: SuiTxSummary,
    pub context: SuiContext,
}

fn insufficient(have: u64, need: u64) -> AppError {
    AppError::InvalidInput(format!(
        "solde insuffisant : {} dans les pièces SUI, il en faut {} (montant + budget de gaz)",
        sui(Lang::Fr, &have.to_string()),
        sui(Lang::Fr, &need.to_string())
    ))
}

fn b64(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Builds an unsigned transfer from live data: `amount` in MIST, `None` = the whole balance.
pub(crate) async fn build(
    c: &SuiCtx<'_>,
    me: &str,
    to: &str,
    amount: Option<u64>,
) -> AppResult<SuiBuilt> {
    let sender = wallet_core::sui_parse_address(me)?;
    let recipient = wallet_core::sui_parse_address(to)?;
    if amount == Some(0) {
        return Err(AppError::InvalidInput("montant nul".into()));
    }
    let ep = sui_backend::epoch(c).await?;
    let coins = sui_backend::coins(c, me).await?;
    if coins.is_empty() {
        let b = sui_backend::balance(c, me).await?;
        return Err(AppError::InvalidInput(if b.address_balance != "0" {
            format!(
                "aucune pièce SUI à dépenser : tes {} sont dans le « solde d'adresse » de Sui, que Kyro ne sait pas encore dépenser",
                sui(Lang::Fr, &b.address_balance)
            )
        } else {
            "aucun SUI sur ce compte".into()
        }));
    }
    let price = ep.reference_gas_price;
    let min_budget = price.saturating_mul(1000);
    let selected = match amount {
        Some(a) => sui_backend::select_coins(&coins, a.saturating_add(DRAFT_BUDGET)),
        None => sui_backend::select_coins(&coins, u64::MAX),
    };
    let total: u64 = selected
        .iter()
        .fold(0u64, |s, c| s.saturating_add(c.balance));
    let draft_budget = match amount {
        Some(a) => total.saturating_sub(a).min(DRAFT_BUDGET),
        None => total.min(DRAFT_BUDGET),
    };
    if draft_budget < min_budget {
        return Err(insufficient(
            total,
            amount.unwrap_or(0).saturating_add(min_budget),
        ));
    }
    let mut t = SuiTransfer {
        sender,
        recipient,
        amount: amount.map_or(SuiTransferAmount::All, SuiTransferAmount::Mist),
        gas_payment: selected.iter().map(|c| c.r).collect(),
        gas_price: price,
        gas_budget: draft_budget,
        // Void once the next epoch is over (≈ 24 to 48 h): a signed transfer cannot be replayed
        // months later by whoever kept it, even if its gas coins never moved.
        expiration_epoch: Some(ep.epoch.saturating_add(1)),
        coins: vec![],
    };
    let draft = t.encode()?;
    let sim = sui_backend::simulate(c, &b64(&draft), &wallet_core::sui_tx_digest(&draft)).await?;
    if !sim.success {
        return Err(AppError::InvalidInput(format!(
            "la simulation du transfert échoue : {}",
            sim.error.unwrap_or_default()
        )));
    }
    t.gas_budget = sui_backend::gas_budget(&sim.estimate, price).max(min_budget);
    let need = amount.unwrap_or(0).saturating_add(t.gas_budget);
    if need > total || (amount.is_none() && t.gas_budget >= total) {
        return Err(insufficient(total, need));
    }
    let bcs = b64(&t.encode()?);
    let (summary, context) = prepare_sign(c, me, &bcs, None).await?;
    Ok(SuiBuilt {
        bcs,
        summary,
        context,
    })
}

fn known_coin(c: &SuiCtx<'_>, coin_type: &str) -> AppResult<&'static wallet_core::SuiKnownCoin> {
    wallet_core::sui_known_coin(coin_type.trim(), c.network == Network::Testnet)
        .ok_or_else(|| AppError::InvalidInput("jeton Sui inconnu de Kyro sur ce réseau".into()))
}

/// Builds an unsigned token transfer of the known `coin_type`: `amount` in token units
/// (`None` = every coin of that token, at most 32), gas paid with SUI coins.
pub(crate) async fn build_token(
    c: &SuiCtx<'_>,
    me: &str,
    to: &str,
    coin_type: &str,
    amount: Option<u64>,
) -> AppResult<SuiBuilt> {
    let coin = known_coin(c, coin_type)?;
    let sender = wallet_core::sui_parse_address(me)?;
    let recipient = wallet_core::sui_parse_address(to)?;
    if amount == Some(0) {
        return Err(AppError::InvalidInput("montant nul".into()));
    }
    let ep = sui_backend::epoch(c).await?;
    let tokens = sui_backend::token_coins(c, me, coin).await?;
    let max = wallet_core::SUI_MAX_TOKEN_COINS;
    let selected = match amount {
        Some(a) => sui_backend::select_up_to(&tokens, a, max),
        None if tokens.len() > max => {
            return Err(AppError::InvalidInput(format!(
                "plus de {max} pièces {} : envoie un montant plutôt que tout le solde",
                coin.symbol
            )))
        }
        None => tokens.clone(),
    };
    let have: u64 = selected
        .iter()
        .fold(0u64, |s, c| s.saturating_add(c.balance));
    if selected.is_empty() || amount.is_some_and(|a| a > have) {
        let all: u64 = tokens.iter().fold(0u64, |s, c| s.saturating_add(c.balance));
        return Err(AppError::InvalidInput(format!(
            "solde {} insuffisant : {} {} dans les pièces de ce jeton{}",
            coin.symbol,
            crate::commands::format_units(&all.to_string(), usize::from(coin.decimals)),
            coin.symbol,
            if all > have {
                " (trop de petites pièces : envoie un montant plus petit)"
            } else {
                ""
            }
        )));
    }
    let gas = sui_backend::coins(c, me).await?;
    let price = ep.reference_gas_price;
    let min_budget = price.saturating_mul(1000);
    let gas_sel = sui_backend::select_coins(&gas, DRAFT_BUDGET);
    let gas_total: u64 = gas_sel
        .iter()
        .fold(0u64, |s, c| s.saturating_add(c.balance));
    let draft_budget = gas_total.min(DRAFT_BUDGET);
    if draft_budget < min_budget {
        return Err(AppError::InvalidInput(format!(
            "pas assez de SUI pour les frais : {} dans les pièces SUI, il en faut au moins {}",
            sui(Lang::Fr, &gas_total.to_string()),
            sui(Lang::Fr, &min_budget.to_string())
        )));
    }
    let mut t = SuiTransfer {
        sender,
        recipient,
        amount: amount.map_or(SuiTransferAmount::All, SuiTransferAmount::Mist),
        gas_payment: gas_sel.iter().map(|c| c.r).collect(),
        gas_price: price,
        gas_budget: draft_budget,
        expiration_epoch: Some(ep.epoch.saturating_add(1)),
        coins: selected.iter().map(|c| c.r).collect(),
    };
    let draft = t.encode()?;
    let sim = sui_backend::simulate(c, &b64(&draft), &wallet_core::sui_tx_digest(&draft)).await?;
    if !sim.success {
        return Err(AppError::InvalidInput(format!(
            "la simulation du transfert échoue : {}",
            sim.error.unwrap_or_default()
        )));
    }
    t.gas_budget = sui_backend::gas_budget(&sim.estimate, price).max(min_budget);
    if t.gas_budget > gas_total {
        return Err(insufficient(gas_total, t.gas_budget));
    }
    let bcs = b64(&t.encode()?);
    let (summary, context) = prepare_sign(c, me, &bcs, Some(coin.coin_type)).await?;
    Ok(SuiBuilt {
        bcs,
        summary,
        context,
    })
}

/// Token transfer of the known `coinType`: `amount` in token units, or `all`.
#[tauri::command]
pub async fn sui_build_token_tx(
    state: State<'_, AppState>,
    coin_type: String,
    to: String,
    amount: Option<String>,
    all: Option<bool>,
    account: Option<u32>,
) -> AppResult<SuiBuilt> {
    let me = ours(&state, account_arg(account)?)?;
    let amount = if all.unwrap_or(false) {
        None
    } else {
        Some(
            amount
                .as_deref()
                .map(str::trim)
                .and_then(|a| a.parse::<u64>().ok())
                .filter(|a| *a > 0)
                .ok_or_else(|| AppError::InvalidInput("montant de jeton invalide".into()))?,
        )
    };
    build_token(&ctx(&state), &me, &to, &coin_type, amount).await
}

/// Decodes like wallet-core will sign: SUI transfer, or token transfer of `coin_type`.
fn decode(c: &SuiCtx<'_>, bcs: &str, me: &str, coin_type: Option<&str>) -> AppResult<SuiTxSummary> {
    Ok(match coin_type {
        None => wallet_core::sui_decode_tx(bcs, me)?,
        Some(t) => {
            wallet_core::sui_decode_coin_tx(bcs, me, t.trim(), c.network == Network::Testnet)?
        }
    })
}

#[tauri::command]
pub async fn sui_build_tx(
    state: State<'_, AppState>,
    to: String,
    amount: Option<String>,
    all: Option<bool>,
    account: Option<u32>,
) -> AppResult<SuiBuilt> {
    let me = ours(&state, account_arg(account)?)?;
    let amount = if all.unwrap_or(false) {
        None
    } else {
        Some(
            amount
                .as_deref()
                .map(str::trim)
                .and_then(|a| a.parse::<u64>().ok())
                .filter(|a| *a > 0)
                .ok_or_else(|| AppError::InvalidInput("montant en MIST invalide".into()))?,
        )
    };
    build(&ctx(&state), &me, &to, amount).await
}

/// Decoding + live re-checks + simulation of the exact bytes: everything `sui_sign_tx` does
/// before the dialog.
pub(crate) async fn prepare_sign(
    c: &SuiCtx<'_>,
    me: &str,
    bcs: &str,
    coin_type: Option<&str>,
) -> AppResult<(SuiTxSummary, SuiContext)> {
    let summary = decode(c, bcs, me, coin_type)?;
    let ep = sui_backend::epoch(c).await?;
    match summary.expiration_epoch {
        None => {
            return Err(AppError::InvalidInput(
                "transfert Sui sans époque d'expiration : Kyro ne signe que ce qu'il construit, reconstruis-le".into(),
            ))
        }
        Some(e) if e < ep.epoch => {
            return Err(AppError::InvalidInput(format!(
                "transfert Sui expiré (époque {e} terminée, époque actuelle {}) : reconstruis-le",
                ep.epoch
            )))
        }
        _ => {}
    }
    let price: u64 = summary.gas_price.parse().unwrap_or(0);
    if price < ep.reference_gas_price {
        return Err(AppError::InvalidInput(
            "prix du gaz inférieur au prix de référence de l'époque : reconstruis le transfert"
                .into(),
        ));
    }
    if price > ep.reference_gas_price.saturating_mul(MAX_PRICE_FACTOR) {
        return Err(AppError::InvalidInput(format!(
            "prix du gaz anormal : {price} MIST/unité pour une référence de {}",
            ep.reference_gas_price
        )));
    }
    let coins = sui_backend::coins(c, me).await?;
    let mut gas_total: u64 = 0;
    let mut gas_coin_balances = Vec::with_capacity(summary.gas_coins.len());
    for g in &summary.gas_coins {
        let r = wallet_core::SuiObjectRef::parse(
            &g.object_id,
            g.version.parse().unwrap_or(0),
            &g.digest,
        )?;
        let coin = coins.iter().find(|c| c.r == r).ok_or_else(|| {
            AppError::InvalidInput(
                "les pièces de gaz ont changé depuis la préparation : reconstruis le transfert"
                    .into(),
            )
        })?;
        gas_total = gas_total.saturating_add(coin.balance);
        gas_coin_balances.push(coin.balance.to_string());
    }
    let budget: u64 = summary.gas_budget.parse().unwrap_or(u64::MAX);
    let amount: Option<u64> = summary.amount.as_deref().and_then(|a| a.parse().ok());
    if let Some(k) = &summary.token {
        return prepare_token(
            c,
            me,
            bcs,
            &summary,
            k,
            ep,
            &coins,
            gas_total,
            gas_coin_balances,
        )
        .await;
    }
    let need = amount.unwrap_or(0).saturating_add(budget);
    if need > gas_total || (amount.is_none() && budget >= gas_total) {
        return Err(insufficient(gas_total, need));
    }
    let sim = sui_backend::simulate(c, bcs, &summary.digest).await?;
    if !sim.success {
        return Err(AppError::InvalidInput(format!(
            "la simulation du transfert échoue : {}",
            sim.error.unwrap_or_default()
        )));
    }
    // The estimate comes from the server: it only fills the dialog, but it must at least tell
    // the same story as the bytes Kyro built.
    if !sui_backend::only_sui_between(&sim, me, &summary.recipient) {
        return Err(AppError::ServerUnreachable(
            "Sui : la simulation déplace d'autres fonds que ce transfert".into(),
        ));
    }
    let received = sui_backend::sui_change(&sim, &summary.recipient);
    if let (Some(a), false) = (amount, summary.recipient == me) {
        if received != i128::from(a) {
            return Err(AppError::ServerUnreachable(
                "Sui : la simulation ne crédite pas le montant prévu au destinataire".into(),
            ));
        }
    }
    let e = &sim.estimate;
    let balance: u64 = coins.iter().fold(0u64, |s, c| s.saturating_add(c.balance));
    Ok((
        summary.clone(),
        SuiContext {
            balance: balance.to_string(),
            gas_coins_total: gas_total.to_string(),
            gas_coin_balances,
            reference_gas_price: ep.reference_gas_price.to_string(),
            epoch: ep.epoch,
            computation_cost: e.computation_cost.to_string(),
            storage_cost: e.storage_cost.to_string(),
            storage_rebate: e.storage_rebate.to_string(),
            fee: e.net_fee,
            receives: (amount.is_none() && summary.recipient != me && received > 0)
                .then(|| received.to_string()),
            token: None,
        },
    ))
}

/// Token side of [`prepare_sign`]: every token coin is ours, of this type, at this version and
/// digest (read live); the gas coins cover the budget; the simulation moves only this token
/// between us and the recipient (exactly the amount) and our SUI for the gas.
#[allow(clippy::too_many_arguments)]
async fn prepare_token(
    c: &SuiCtx<'_>,
    me: &str,
    bcs: &str,
    summary: &SuiTxSummary,
    k: &wallet_core::SuiTokenSummary,
    ep: sui_backend::SuiEpoch,
    gas: &[sui_backend::SuiCoin],
    gas_total: u64,
    gas_coin_balances: Vec<String>,
) -> AppResult<(SuiTxSummary, SuiContext)> {
    let coin = known_coin(c, &k.coin_type)?;
    let budget: u64 = summary.gas_budget.parse().unwrap_or(u64::MAX);
    if budget > gas_total {
        return Err(insufficient(gas_total, budget));
    }
    let live = sui_backend::token_coins(c, me, coin).await?;
    let mut total: u64 = 0;
    let mut coin_balances = Vec::with_capacity(k.coins.len());
    for g in &k.coins {
        let r = wallet_core::SuiObjectRef::parse(
            &g.object_id,
            g.version.parse().unwrap_or(0),
            &g.digest,
        )?;
        let found = live.iter().find(|x| x.r == r).ok_or_else(|| {
            AppError::InvalidInput(format!(
                "les pièces {} ont changé depuis la préparation (ou ne sont pas de ce jeton) : reconstruis le transfert",
                coin.symbol
            ))
        })?;
        total = total.saturating_add(found.balance);
        coin_balances.push(found.balance.to_string());
    }
    let amount: Option<u64> = summary.amount.as_deref().and_then(|a| a.parse().ok());
    if amount.is_some_and(|a| a > total) {
        return Err(AppError::InvalidInput(format!(
            "solde {} insuffisant dans les pièces choisies : reconstruis le transfert",
            coin.symbol
        )));
    }
    let sim = sui_backend::simulate(c, bcs, &summary.digest).await?;
    if !sim.success {
        return Err(AppError::InvalidInput(format!(
            "la simulation du transfert échoue : {}",
            sim.error.unwrap_or_default()
        )));
    }
    let to = &summary.recipient;
    if !sui_backend::only_token_between(&sim, me, to, coin.coin_type) {
        return Err(AppError::ServerUnreachable(
            "Sui : la simulation déplace d'autres fonds que ce transfert".into(),
        ));
    }
    let received = sui_backend::coin_change(&sim, to, coin.coin_type);
    if to != me && received != i128::from(amount.unwrap_or(total)) {
        return Err(AppError::ServerUnreachable(
            "Sui : la simulation ne crédite pas le montant prévu au destinataire".into(),
        ));
    }
    let e = &sim.estimate;
    let balance: u64 = gas.iter().fold(0u64, |s, c| s.saturating_add(c.balance));
    let token_balance: u64 = live.iter().fold(0u64, |s, c| s.saturating_add(c.balance));
    Ok((
        summary.clone(),
        SuiContext {
            balance: balance.to_string(),
            gas_coins_total: gas_total.to_string(),
            gas_coin_balances,
            reference_gas_price: ep.reference_gas_price.to_string(),
            epoch: ep.epoch,
            computation_cost: e.computation_cost.to_string(),
            storage_cost: e.storage_cost.to_string(),
            storage_rebate: e.storage_rebate.to_string(),
            fee: e.net_fee,
            receives: (amount.is_none() && to != me).then(|| received.to_string()),
            token: Some(SuiTokenContext {
                balance: token_balance.to_string(),
                coins_total: total.to_string(),
                coin_balances,
            }),
        },
    ))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SuiSigned {
    pub bcs: String,
    /// `flag || signature || public key`, base64: what `sui_broadcast` sends.
    pub signature: String,
    pub digest: String,
    pub summary: SuiTxSummary,
    pub context: SuiContext,
}

#[tauri::command]
pub async fn sui_sign_tx(
    app: AppHandle,
    state: State<'_, AppState>,
    bcs: String,
    password: String,
    coin_type: Option<String>,
    account: Option<u32>,
) -> AppResult<SuiSigned> {
    if !state.is_unlocked() {
        return Err(AppError::Locked);
    }
    let a = account_arg(account)?;
    let me = ours(&state, a)?;
    let signer = SignerInfo::new(&state, Chain::Sui, a, wallet_core::sui_path(a));
    let c = ctx(&state);
    let coin_type = coin_type
        .map(|t| t.trim().to_owned())
        .filter(|t| !t.is_empty());
    let (summary, context) = prepare_sign(&c, &me, &bcs, coin_type.as_deref()).await?;
    let seed = seed_from_password(&state, Zeroizing::new(password)).await?;
    let lang = crate::i18n::current();
    confirm_native(
        &app,
        lang.pick("Confirmer le transfert Sui", "Confirm the Sui transfer"),
        signer.body(lang, &describe_sui(lang, &summary, &context, state.network)),
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
            describe_sui_extra(lang, &summary),
        )
        .await?;
    }
    let b = bcs.clone();
    let testnet = state.network == Network::Testnet;
    let (signature, again) = blocking(move || {
        Ok(match coin_type {
            None => wallet_core::sui_sign(&seed, a, &b)?,
            Some(t) => wallet_core::sui_sign_coin(&seed, a, &b, &t, testnet)?,
        })
    })
    .await?;
    if again != summary {
        return Err(AppError::Internal(
            "résumé différent entre l'aperçu et la signature".into(),
        ));
    }
    state.touch();
    Ok(SuiSigned {
        bcs,
        signature,
        digest: summary.digest.clone(),
        summary,
        context,
    })
}

/// Checks the signed transaction (decodes, ed25519 signature by our key over these bytes) and
/// executes it; the digest of the effects must be ours.
pub(crate) async fn broadcast_checked(
    c: &SuiCtx<'_>,
    me: &str,
    bcs: &str,
    signature: &str,
) -> AppResult<String> {
    let digest = wallet_core::sui_verify_signed(bcs, signature)?;
    // SUI or token transfer: same strict decoding; the sender must be this account.
    let raw = {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD
            .decode(bcs.trim())
            .map_err(|_| AppError::InvalidInput("transaction : base64 attendu".into()))?
    };
    let t = SuiTransfer::decode(&raw)?;
    if t.sender != wallet_core::sui_parse_address(me)? {
        return Err(AppError::InvalidInput(
            "ce transfert n'est pas signé par ton compte".into(),
        ));
    }
    sui_backend::execute(c, bcs.trim(), signature.trim(), &digest).await
}

#[tauri::command]
pub async fn sui_broadcast(
    state: State<'_, AppState>,
    bcs: String,
    signature: String,
    account: Option<u32>,
) -> AppResult<String> {
    let me = ours(&state, account_arg(account)?)?;
    broadcast_checked(&ctx(&state), &me, &bcs, &signature).await
}

#[tauri::command]
pub async fn sui_tx_status(
    state: State<'_, AppState>,
    digest: String,
) -> AppResult<sui_backend::SuiTxStatus> {
    let d = digest.trim();
    const B58: &str = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    if !(32..=44).contains(&d.len()) || !d.chars().all(|ch| B58.contains(ch)) {
        return Err(AppError::InvalidInput(
            "empreinte Sui : base58 de 32 octets attendue".into(),
        ));
    }
    sui_backend::tx_status(&ctx(&state), d).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summary(amount: Option<&str>, warnings: Vec<SuiWarning>) -> SuiTxSummary {
        SuiTxSummary {
            sender: "0xa2d14fad60c56049ecf75246a481934691214ce413e6a8ae2fe6834c173a6133".into(),
            recipient: "0x1ada6e6f3f3e4055096f606c746690f1108fcc2ca479055cc434a3e1d3f758aa".into(),
            coin_type: "0x2::sui::SUI".into(),
            amount: amount.map(str::to_owned),
            gas_budget: "3000000".into(),
            gas_price: "1000".into(),
            gas_coins: vec![],
            expiration_epoch: Some(1271),
            digest: "qoQG6UgMDH39fa9hxUHxRcFDrmFR3zURqHP2FPcYXG9".into(),
            requires_extra_confirmation: !warnings.is_empty(),
            warnings,
            token: None,
        }
    }

    fn context(receives: Option<&str>) -> SuiContext {
        SuiContext {
            balance: "10000000000".into(),
            gas_coins_total: "10000000000".into(),
            gas_coin_balances: vec![],
            reference_gas_price: "1000".into(),
            epoch: 1270,
            computation_cost: "1000000".into(),
            storage_cost: "1976000".into(),
            storage_rebate: "978120".into(),
            fee: 1_997_880,
            receives: receives.map(str::to_owned),
            token: None,
        }
    }

    #[test]
    fn token_dialog_shows_token_type_decimals_and_coins() {
        let mut s = summary(Some("1500000"), vec![]);
        s.coin_type =
            "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC".into();
        s.token = Some(wallet_core::SuiTokenSummary {
            coin_type: s.coin_type.clone(),
            symbol: "USDC".into(),
            name: "USD Coin".into(),
            decimals: 6,
            coins: vec![wallet_core::SuiGasCoinView {
                object_id: format!("0x{}", "ab".repeat(32)),
                version: "77".into(),
                digest: "11111111111111111111111111111111".into(),
            }],
        });
        let mut c = context(None);
        c.token = Some(SuiTokenContext {
            balance: "2500000".into(),
            coins_total: "2500000".into(),
            coin_balances: vec!["2500000".into()],
        });
        let d = describe_sui(Lang::Fr, &s, &c, Network::Mainnet);
        for needle in [
            "Envoi de jeton Sui\n",
            "Jeton : USDC — type vérifié par Kyro\n0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC\n6 décimales",
            "À : 0x1ada6e6f3f3e4055096f606c746690f1108fcc2ca479055cc434a3e1d3f758aa\n",
            "Montant : 1,5 USDC (1500000 unités)",
            "Pièces USDC fusionnées : 1 · solde USDC envoyable : 2,5 USDC",
            "(version 77) : 2,5 USDC",
            "Frais payés en SUI",
            "Budget de gaz maximal : 0,003 SUI",
        ] {
            assert!(d.contains(needle), "{needle} missing in:\n{d}");
        }
        assert!(!d.contains("Montant : 1,5 SUI"));
        s.amount = None;
        s.warnings = vec![SuiWarning::SendAll];
        let all = describe_sui(Lang::En, &s, &c, Network::Testnet);
        assert!(
            all.contains("Sui token send (testnet)")
                && all.contains("THE WHOLE USDC BALANCE of the coins below (2.5 USDC)")
        );
        assert!(describe_sui_extra(Lang::Fr, &s).contains("tout le solde du jeton"));
    }

    #[test]
    fn dialog_shows_recipient_amount_coin_and_gas() {
        let d = describe_sui(
            Lang::Fr,
            &summary(Some("1500000000"), vec![]),
            &context(None),
            Network::Testnet,
        );
        for needle in [
            "Envoi Sui (testnet)",
            "À : 0x1ada6e6f3f3e4055096f606c746690f1108fcc2ca479055cc434a3e1d3f758aa\n",
            "Montant : 1,5 SUI (1500000000 MIST)",
            "Jeton : SUI (0x2::sui::SUI)",
            "Frais estimés (simulation) : 0,00199788 SUI — calcul 0,001 SUI + stockage 0,001976 SUI − remboursement 0,00097812 SUI",
            "Budget de gaz maximal : 0,003 SUI (3000000 MIST) · prix du gaz : 1000 MIST/unité (référence 1000)",
            "Pièces de gaz : 0 (total 10 SUI) · solde dépensable : 10 SUI",
            "Valable jusqu'à la fin de l'époque n° 1271 (époque actuelle 1270)",
            "Empreinte : qoQG6UgMDH39fa9hxUHxRcFDrmFR3zURqHP2FPcYXG9",
        ] {
            assert!(d.contains(needle), "{needle} missing in:\n{d}");
        }
        let all = describe_sui(
            Lang::Fr,
            &summary(None, vec![SuiWarning::SendAll]),
            &context(Some("9998000000")),
            Network::Mainnet,
        );
        assert!(all.starts_with("Envoi Sui\n"));
        assert!(all.contains("TOUT LE SOLDE"));
        assert!(all.contains("recevrait 9,998 SUI"));
        let x = describe_sui_extra(
            Lang::Fr,
            &summary(None, vec![SuiWarning::SendAll, SuiWarning::HighGasBudget]),
        );
        assert!(x.contains("tout le solde") && x.contains("0,1 SUI"));
        // Gas coins: decoded id and version, live balance; beyond 5, a count and a total.
        let coin = |i: u8| wallet_core::SuiGasCoinView {
            object_id: format!("0x{}", hex::encode([i; 32])),
            version: format!("{}", 100 + u64::from(i)),
            digest: "11111111111111111111111111111111".into(),
        };
        let mut many = summary(Some("1"), vec![]);
        many.gas_coins = (1..=7).map(coin).collect();
        let mut ctx7 = context(None);
        ctx7.gas_coin_balances = [
            "4000000000",
            "3000000000",
            "1000000000",
            "1000000000",
            "500000000",
            "300000000",
            "200000000",
        ]
        .map(String::from)
        .to_vec();
        let d7 = describe_sui(Lang::Fr, &many, &ctx7, Network::Mainnet);
        assert!(d7.contains(&format!(
            "  • 0x{} (version 101) : 4 SUI\n",
            "01".repeat(32)
        )));
        assert!(d7.contains(&format!(
            "  • 0x{} (version 105) : 0,5 SUI\n",
            "05".repeat(32)
        )));
        assert!(!d7.contains(&"06".repeat(32)));
        assert!(d7.contains("  • … et 2 autres pièces (0,5 SUI)\n"));
        let mut neg = context(None);
        neg.fee = -5_000;
        assert!(describe_sui(
            Lang::Fr,
            &summary(Some("1"), vec![]),
            &neg,
            Network::Mainnet
        )
        .contains("Frais estimés (simulation) : −0,000005 SUI"));
        let en = describe_sui(
            Lang::En,
            &summary(Some("1500000000"), vec![]),
            &context(None),
            Network::Testnet,
        );
        assert!(en.contains("Amount: 1.5 SUI (1500000000 MIST)") && en.contains("Digest: "));
    }
}
