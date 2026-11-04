//! Aptos delegation pools (`aptos_stake_*`, docs/IPC.md §2.8): `add_stake`, `unlock` and `withdraw`
//! of `0x1::delegation_pool`. Built by Rust, decoded by wallet-core, pool state, stake and
//! simulation read live, native dialog before signing.

use futures_util::future::join_all;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, State};
use wallet_core::{AptosStakeCall, AptosStakeSummary, AptosStakeTx, Network};
use zeroize::Zeroizing;

use crate::accounts::{account_arg, confirm_signer, Chain, SignerInfo};
use crate::aptos_backend::{self, u64_at, AptosAccountInfo, AptosCtx};
use crate::commands::{blocking, confirm_native, format_units_in, seed_from_password};
use crate::commands_aptos::{ctx, ours};
use crate::error::{AppError, AppResult};
use crate::i18n::Lang;
use crate::state::AppState;

/// Commission (percent) above which the reinforced dialog opens.
const HIGH_COMMISSION_PCT: f64 = 10.0;
/// Pool calls burn far more gas than a transfer (≈ 13,000 units for `add_stake`).
const MAX_STAKE_GAS: u64 = 60_000;
const MIN_STAKE_GAS: u64 = 2_000;
/// Maximum fee above 0.1 APT opens the reinforced dialog.
const HIGH_FEE_OCTAS: u64 = 10_000_000;
const MAX_POOLS: usize = 20;
/// `0x1::stake` validator status.
const VALIDATOR_ACTIVE: u64 = 2;
/// `0x1::delegation_pool::MIN_COINS_ON_SHARES_POOL` plus the add-stake fee margin wallets ask for.
pub const MIN_FIRST_STAKE: u64 = 1_100_000_000;

fn invalid(m: impl Into<String>) -> AppError {
    AppError::InvalidInput(m.into())
}

fn server(m: impl Into<String>) -> AppError {
    AppError::ServerUnreachable(m.into())
}

/// `0x…` as the REST API prints it (leading zeros trimmed) → `0x` + 64 hex.
fn full_address(a: &str) -> Option<String> {
    let h = a.strip_prefix("0x")?;
    (!h.is_empty() && h.len() <= 64 && h.chars().all(|c| c.is_ascii_hexdigit()))
        .then(|| format!("0x{:0>64}", h.to_ascii_lowercase()))
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AptosPool {
    pub address: String,
    /// Operator's ANS name, when it has one (declared).
    pub name: Option<String>,
    pub commission_pct: f64,
    /// Octas delegated to the pool.
    pub stake: String,
    /// Network rate after this pool's commission, percent per year (estimate).
    pub apy: Option<f64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AptosPools {
    pub pools: Vec<AptosPool>,
    /// Rewards rate before commission, percent per year (estimate, assumes full performance).
    pub gross_apy: Option<f64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AptosPoolPosition {
    pub pool: String,
    /// Octas earning rewards.
    pub active: String,
    /// Octas unlocking until the end of the pool's lockup.
    pub pending_inactive: String,
    /// Octas ready to withdraw.
    pub inactive: String,
    pub commission_pct: Option<f64>,
    /// UNIX seconds at which the pool's current lockup ends.
    pub lockup_ends: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AptosStakeOverview {
    pub address: String,
    /// Octas.
    pub balance: String,
    pub positions: Vec<AptosPoolPosition>,
    /// UNIX seconds of the ledger.
    pub ledger_time: u64,
    /// Octas.
    pub min_first_stake: String,
}

/// Yearly rate, percent, from a per-epoch rate and the epoch length in microseconds.
pub fn apy_from(rate_per_epoch: f64, epoch_micros: u64) -> Option<f64> {
    if rate_per_epoch <= 0.0 || epoch_micros == 0 {
        return None;
    }
    let epochs = 365.0 * 86_400.0 * 1e6 / epoch_micros as f64;
    let a = ((1.0 + rate_per_epoch).powf(epochs) - 1.0) * 100.0;
    (a.is_finite() && a < 100.0).then_some(a)
}

/// Rate per epoch: `StakingRewardsConfig` (fixed point 64, what `0x1::stake` pays today), else the
/// older `StakingConfig` pair.
pub fn rate_from(rewards: Option<&Value>, config: Option<&Value>) -> Option<f64> {
    if let Some(v) = rewards.and_then(|r| u128_of(&r["rewards_rate"]["value"])) {
        return Some(v as f64 / 2f64.powi(64));
    }
    let c = config?;
    let n = u64_at(&c["rewards_rate"])?;
    let d = u64_at(&c["rewards_rate_denominator"]).filter(|d| *d > 0)?;
    Some(n as f64 / d as f64)
}

fn u128_of(v: &Value) -> Option<u128> {
    v.as_str()?.parse().ok()
}

async fn gross_apy(c: &AptosCtx<'_>) -> Option<f64> {
    let rewards =
        aptos_backend::resource(c, "0x1", "0x1::staking_config::StakingRewardsConfig").await;
    let config = aptos_backend::resource(c, "0x1", "0x1::staking_config::StakingConfig").await;
    let block = aptos_backend::resource(c, "0x1", "0x1::block::BlockResource")
        .await
        .ok()?;
    apy_from(
        rate_from(rewards.as_ref().ok(), config.as_ref().ok())?,
        u64_at(&block["epoch_interval"])?,
    )
}

/// Active validators and indexer rows → the delegation pools of the set, largest first.
pub fn pools_from(set: &Value, indexed: &Value, gross: Option<f64>) -> Vec<AptosPool> {
    let names = indexed["delegated_staking_pools"].as_array();
    let name_of = |pool: &str| {
        names?
            .iter()
            .find(|p| p["staking_pool_address"].as_str() == Some(pool))?["current_staking_pool"]
            ["operator_aptos_name"][0]["domain"]
            .as_str()
            .map(|d| crate::dialog_text::sanitize(d, 60))
    };
    let active: Vec<String> = set["active_validators"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| full_address(v["addr"].as_str()?))
        .collect();
    let mut out: Vec<(u64, AptosPool)> = indexed["current_delegated_staking_pool_balances"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|p| {
            let address = full_address(p["staking_pool_address"].as_str()?)?;
            if !active.contains(&address) {
                return None;
            }
            let commission_pct = p["operator_commission_percentage"].as_f64()? / 100.0;
            let stake = u64_at(&p["total_coins"])?;
            Some((
                stake,
                AptosPool {
                    name: name_of(&address),
                    commission_pct,
                    stake: stake.to_string(),
                    apy: gross.map(|g| g * (1.0 - commission_pct / 100.0)),
                    address,
                },
            ))
        })
        .collect();
    out.sort_by_key(|p| std::cmp::Reverse(p.0));
    out.into_iter().map(|p| p.1).collect()
}

pub(crate) async fn pools(c: &AptosCtx<'_>) -> AppResult<AptosPools> {
    let set = aptos_backend::resource(c, "0x1", "0x1::stake::ValidatorSet").await?;
    let addresses: Vec<String> = set["active_validators"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| full_address(v["addr"].as_str()?))
        .collect();
    let indexed = aptos_backend::graphql(
        c,
        "query($p:[String!]!){current_delegated_staking_pool_balances(where:{staking_pool_address:{_in:$p}}){staking_pool_address operator_commission_percentage total_coins} delegated_staking_pools(where:{staking_pool_address:{_in:$p}}){staking_pool_address current_staking_pool{operator_aptos_name{domain}}}}",
        json!({ "p": addresses }),
    )
    .await?;
    let gross = gross_apy(c).await;
    Ok(AptosPools {
        pools: pools_from(&set, &indexed, gross),
        gross_apy: gross,
    })
}

#[tauri::command]
pub async fn aptos_stake_pools(state: State<'_, AppState>) -> AppResult<AptosPools> {
    pools(&ctx(&state)).await
}

/// `get_stake` view → `(active, inactive, pending_inactive)`.
pub fn stake_from(v: &Value) -> AppResult<(u64, u64, u64)> {
    let at = |i: usize| u64_at(&v[i]).ok_or_else(|| server("Aptos: get_stake unreadable"));
    Ok((at(0)?, at(1)?, at(2)?))
}

fn first_u64(v: &Value) -> Option<u64> {
    u64_at(&v[0])
}

async fn commission(c: &AptosCtx<'_>, pool: &str) -> Option<f64> {
    aptos_backend::view(
        c,
        "0x1::delegation_pool::operator_commission_percentage",
        json!([pool]),
    )
    .await
    .ok()
    .and_then(|v| first_u64(&v))
    .map(|b| b as f64 / 100.0)
}

async fn position(c: &AptosCtx<'_>, pool: &str, me: &str) -> AppResult<AptosPoolPosition> {
    let v = aptos_backend::view(c, "0x1::delegation_pool::get_stake", json!([pool, me])).await?;
    let (active, inactive, pending) = stake_from(&v)?;
    let lockup = aptos_backend::view(c, "0x1::stake::get_lockup_secs", json!([pool]))
        .await
        .ok()
        .and_then(|v| first_u64(&v));
    Ok(AptosPoolPosition {
        pool: pool.to_owned(),
        active: active.to_string(),
        pending_inactive: pending.to_string(),
        inactive: inactive.to_string(),
        commission_pct: commission(c, pool).await,
        lockup_ends: lockup,
    })
}

/// `delegator_distinct_pool` rows → pool addresses.
pub fn my_pools_from(d: &Value) -> Vec<String> {
    let mut out: Vec<String> = d["delegator_distinct_pool"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|p| full_address(p["pool_address"].as_str()?))
        .collect();
    out.sort();
    out.dedup();
    out.truncate(MAX_POOLS);
    out
}

pub(crate) async fn overview(c: &AptosCtx<'_>, me: &str) -> AppResult<AptosStakeOverview> {
    let ledger = aptos_backend::checked_ledger(c).await?;
    let account = aptos_backend::account(c, me).await?;
    let d = aptos_backend::graphql(
        c,
        "query($a:String!){delegator_distinct_pool(where:{delegator_address:{_eq:$a}},limit:50){pool_address}}",
        json!({ "a": me }),
    )
    .await?;
    let list = my_pools_from(&d);
    let positions = join_all(list.iter().map(|p| position(c, p, me)))
        .await
        .into_iter()
        .collect::<AppResult<Vec<_>>>()?;
    Ok(AptosStakeOverview {
        address: me.to_owned(),
        balance: account.balance,
        positions: positions
            .into_iter()
            .filter(|p| p.active != "0" || p.pending_inactive != "0" || p.inactive != "0")
            .collect(),
        ledger_time: ledger.timestamp_secs,
        min_first_stake: MIN_FIRST_STAKE.to_string(),
    })
}

#[tauri::command]
pub async fn aptos_stake_overview(
    state: State<'_, AppState>,
    account: Option<u32>,
) -> AppResult<AptosStakeOverview> {
    let (me, _) = ours(&state, account_arg(account)?)?;
    overview(&ctx(&state), &me).await
}

/// What the UI asks Kyro to build. Amounts in octas.
#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AptosStakeRequest {
    Stake { pool: String, amount: String },
    Unlock { pool: String, amount: String },
    Withdraw { pool: String },
}

impl AptosStakeRequest {
    fn pool(&self) -> &str {
        match self {
            AptosStakeRequest::Stake { pool, .. }
            | AptosStakeRequest::Unlock { pool, .. }
            | AptosStakeRequest::Withdraw { pool } => pool.trim(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AptosStakeWarning {
    /// The operator keeps more than 10 % of the rewards.
    HighCommission { pct: f64 },
    /// The pool's validator is not in the active set: no rewards while it stays out.
    NotValidating,
    /// Maximum fee above 0.1 APT.
    HighFee,
}

/// Live facts shown before the password and in the dialog.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AptosStakeContext {
    pub account: AptosAccountInfo,
    /// Our position in the pool before this operation.
    pub position: AptosPoolPosition,
    pub validating: bool,
    /// Octas held back on `add_stake` until the next epoch, then refunded (active pool).
    pub add_stake_fee: Option<String>,
    pub gas_used: String,
    pub ledger_time: u64,
    pub warnings: Vec<AptosStakeWarning>,
    pub requires_extra_confirmation: bool,
}

pub(crate) async fn context_for(
    c: &AptosCtx<'_>,
    me: &str,
    pubkey: &[u8; 32],
    raw: &str,
) -> AppResult<(AptosStakeSummary, AptosStakeContext)> {
    let s = wallet_core::aptos_stake_decode(raw, me)?;
    if s.chain_id != c.chain_id {
        return Err(invalid("transaction for another chain"));
    }
    let ledger = aptos_backend::checked_ledger(c).await?;
    if s.expiration_timestamp_secs < ledger.timestamp_secs + aptos_backend::MIN_REMAINING_SECS {
        return Err(invalid("staking transaction expired: rebuild it"));
    }
    if s.expiration_timestamp_secs > ledger.timestamp_secs + aptos_backend::EXPIRATION_SECS + 60 {
        return Err(invalid(
            "expiration too far in the future: Kyro does not sign for more than 10 minutes",
        ));
    }
    let account = aptos_backend::account(c, me).await?;
    if s.sequence_number != account.sequence_number {
        return Err(invalid("stale sequence number: rebuild it"));
    }
    let exists = aptos_backend::view(
        c,
        "0x1::delegation_pool::delegation_pool_exists",
        json!([s.pool]),
    )
    .await?;
    if exists[0] != true {
        return Err(invalid(format!(
            "{}: not a delegation pool: refused",
            s.pool
        )));
    }
    let amount: u64 = s.amount.parse().unwrap_or(u64::MAX);
    let max_fee: u64 = s.max_fee.parse().unwrap_or(u64::MAX);
    let staking = s.call == AptosStakeCall::AddStake;
    aptos_backend::check_transfer(&account, if staking { amount } else { 0 }, max_fee)?;
    let position = position(c, &s.pool, me).await?;
    let num = |v: &str| v.parse::<u64>().unwrap_or(0);
    match s.call {
        AptosStakeCall::Unlock if amount > num(&position.active) => {
            return Err(invalid("amount above what is staked in this pool"));
        }
        AptosStakeCall::Withdraw if amount > num(&position.inactive) => {
            return Err(invalid("nothing to withdraw yet"));
        }
        _ => {}
    }
    let state = aptos_backend::view(c, "0x1::stake::get_validator_state", json!([s.pool])).await?;
    let validating = first_u64(&state) == Some(VALIDATOR_ACTIVE);
    let add_stake_fee = if staking {
        let f = aptos_backend::view(
            c,
            "0x1::delegation_pool::get_add_stake_fee",
            json!([s.pool, s.amount]),
        )
        .await?;
        first_u64(&f).map(|v| v.to_string())
    } else {
        None
    };
    let (ok, vm_status, gas_used) =
        aptos_backend::simulate(c, wallet_core::aptos_stake_simulation_bytes(raw, pubkey)?).await?;
    if !ok {
        return Err(refused_by_simulation(&vm_status));
    }
    let mut warnings = Vec::new();
    if staking {
        if let Some(pct) = position.commission_pct.filter(|p| *p > HIGH_COMMISSION_PCT) {
            warnings.push(AptosStakeWarning::HighCommission { pct });
        }
        if !validating {
            warnings.push(AptosStakeWarning::NotValidating);
        }
    }
    if max_fee > HIGH_FEE_OCTAS {
        warnings.push(AptosStakeWarning::HighFee);
    }
    Ok((
        s,
        AptosStakeContext {
            account,
            position,
            validating,
            add_stake_fee,
            gas_used: gas_used.to_string(),
            ledger_time: ledger.timestamp_secs,
            requires_extra_confirmation: !warnings.is_empty(),
            warnings,
        },
    ))
}

fn refused_by_simulation(vm_status: &str) -> AppError {
    invalid(format!(
        "staking simulation failed: {vm_status}{}",
        if vm_status.contains("0x10008") || vm_status.contains("0x10007") {
            " (a delegator must keep at least 10 APT in the pool)"
        } else if vm_status.contains("INSUFFICIENT_BALANCE") || vm_status.contains("MAX_GAS_UNITS")
        {
            " (balance too low for the amount and the network fee)"
        } else {
            ""
        }
    ))
}

fn max_gas_for(gas_used: u64) -> AppResult<u64> {
    let g = gas_used.saturating_mul(3).div_ceil(2).max(MIN_STAKE_GAS);
    if g > MAX_STAKE_GAS {
        return Err(invalid(format!(
            "pool call unusually expensive in the simulation ({gas_used} gas units): refused"
        )));
    }
    Ok(g)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AptosStakeBuilt {
    /// Unsigned `RawTransaction`, hex BCS: what `aptos_stake_sign` takes.
    pub raw: String,
    pub summary: AptosStakeSummary,
    pub context: AptosStakeContext,
}

pub(crate) async fn build(
    c: &AptosCtx<'_>,
    me: &str,
    pubkey: &[u8; 32],
    action: &AptosStakeRequest,
) -> AppResult<AptosStakeBuilt> {
    let sender = wallet_core::aptos_parse_address(me)?;
    let pool_text = action.pool();
    let pool = wallet_core::aptos_parse_address(pool_text)?;
    let octas = |s: &str| {
        s.trim()
            .parse::<u64>()
            .ok()
            .filter(|v| *v > 0)
            .ok_or_else(|| invalid("invalid amount (octas expected)"))
    };
    let (call, amount) = match action {
        AptosStakeRequest::Stake { amount, .. } => (AptosStakeCall::AddStake, octas(amount)?),
        AptosStakeRequest::Unlock { amount, .. } => (AptosStakeCall::Unlock, octas(amount)?),
        AptosStakeRequest::Withdraw { .. } => {
            let v = aptos_backend::view(
                c,
                "0x1::delegation_pool::get_stake",
                json!([wallet_core::aptos_address_string(&pool), me]),
            )
            .await?;
            let (_, inactive, _) = stake_from(&v)?;
            if inactive == 0 {
                return Err(invalid("nothing to withdraw yet"));
            }
            (AptosStakeCall::Withdraw, inactive)
        }
    };
    let ledger = aptos_backend::checked_ledger(c).await?;
    let account = aptos_backend::account(c, me).await?;
    let staked = if call == AptosStakeCall::AddStake {
        amount
    } else {
        0
    };
    aptos_backend::check_transfer(&account, staked, 0)?;
    let price = aptos_backend::gas_price(c).await?;
    let balance: u64 = account.balance.parse().unwrap_or(0);
    let mut t = AptosStakeTx {
        sender,
        sequence_number: account.sequence_number.parse().unwrap_or(0),
        call,
        pool,
        amount,
        max_gas_amount: (balance.saturating_sub(staked) / price).clamp(1, MAX_STAKE_GAS),
        gas_unit_price: price,
        expiration_timestamp_secs: ledger.timestamp_secs + aptos_backend::EXPIRATION_SECS,
        chain_id: c.chain_id,
    };
    let raw = hex::encode(t.encode()?);
    let (ok, vm_status, gas_used) =
        aptos_backend::simulate(c, wallet_core::aptos_stake_simulation_bytes(&raw, pubkey)?)
            .await?;
    if !ok {
        return Err(refused_by_simulation(&vm_status));
    }
    t.max_gas_amount = max_gas_for(gas_used)?;
    let raw = hex::encode(t.encode()?);
    let (summary, context) = context_for(c, me, pubkey, &raw).await?;
    Ok(AptosStakeBuilt {
        raw,
        summary,
        context,
    })
}

#[tauri::command]
pub async fn aptos_stake_build(
    state: State<'_, AppState>,
    action: AptosStakeRequest,
    account: Option<u32>,
) -> AppResult<AptosStakeBuilt> {
    let (me, pk) = ours(&state, account_arg(account)?)?;
    build(&ctx(&state), &me, &pk, &action).await
}

fn apt(lang: Lang, octas: &str) -> String {
    format!("{} APT", format_units_in(lang, octas, 8))
}

fn days(lang: Lang, secs: u64) -> String {
    let d = secs.div_ceil(86_400).max(1);
    lang.pick(format!("≈ {d} j"), format!("≈ {d} d"))
}

pub(crate) fn describe(
    lang: Lang,
    s: &AptosStakeSummary,
    c: &AptosStakeContext,
    net: Network,
) -> String {
    let a = |v: &str| apt(lang, v);
    let lockup = c.position.lockup_ends.map_or("?".to_owned(), |t| {
        days(lang, t.saturating_sub(c.ledger_time))
    });
    let mut out = format!(
        "Staking Aptos{}\n\n",
        if net == Network::Testnet {
            " (testnet)"
        } else {
            ""
        }
    );
    out += &match (s.call, lang) {
        (AptosStakeCall::AddStake, Lang::Fr) => format!(
            "Opération : STAKER {} dans le pool\n{}\n(adresse complète, sans somme de contrôle — compare-la en entier)\nPour les récupérer : déverrouiller, attendre la fin du verrouillage du pool ({lockup}), puis retirer.\n",
            a(&s.amount), s.pool
        ),
        (AptosStakeCall::AddStake, Lang::En) => format!(
            "Operation: STAKE {} in pool\n{}\n(full address, no checksum — compare all of it)\nTo get them back: unlock, wait for the end of the pool's lockup ({lockup}), then withdraw.\n",
            a(&s.amount), s.pool
        ),
        (AptosStakeCall::Unlock, Lang::Fr) => format!(
            "Opération : DÉVERROUILLER {} du pool\n{}\nRetirable à la fin du verrouillage du pool ({lockup}). Le réseau peut arrondir le montant pour garder au moins 10 APT de chaque côté.\n",
            a(&s.amount), s.pool
        ),
        (AptosStakeCall::Unlock, Lang::En) => format!(
            "Operation: UNLOCK {} from pool\n{}\nWithdrawable at the end of the pool's lockup ({lockup}). The network may round the amount to keep at least 10 APT on each side.\n",
            a(&s.amount), s.pool
        ),
        (AptosStakeCall::Withdraw, Lang::Fr) => format!(
            "Opération : RETIRER {} du pool vers ton compte\n{}\n",
            a(&s.amount), s.pool
        ),
        (AptosStakeCall::Withdraw, Lang::En) => format!(
            "Operation: WITHDRAW {} from pool to your account\n{}\n",
            a(&s.amount), s.pool
        ),
    };
    if let Some(p) = c.position.commission_pct {
        out += &lang.pick(
            format!("Part gardée par l'opérateur : {p:.2} %\n"),
            format!("Share kept by the operator: {p:.2}%\n"),
        );
    }
    if let Some(f) = &c.add_stake_fee {
        out += &lang.pick(
            format!(
                "Retenue du réseau à l'entrée : {} (rendue à l'époque suivante si le pool est actif)\n",
                a(f)
            ),
            format!(
                "Network add-stake fee: {} (refunded at the next epoch if the pool is active)\n",
                a(f)
            ),
        );
    }
    out += &lang.pick(
        format!(
            "Frais maximaux : {} ({} unités de gaz au plus, {} octas par unité) · simulation : {} unités\n\nCompte : {}\nSéquence {}\nExpire à {} (UNIX)",
            a(&s.max_fee), s.max_gas_amount, s.gas_unit_price, c.gas_used, s.sender, s.sequence_number, s.expiration_timestamp_secs
        ),
        format!(
            "Maximum fee: {} ({} gas units at most, {} octas per unit) · simulation: {} units\n\nAccount: {}\nSequence {}\nExpires at {} (UNIX)",
            a(&s.max_fee), s.max_gas_amount, s.gas_unit_price, c.gas_used, s.sender, s.sequence_number, s.expiration_timestamp_secs
        ),
    );
    out
}

pub(crate) fn describe_extra(lang: Lang, c: &AptosStakeContext) -> String {
    let mut out = String::from(lang.pick(
        "Kyro a trouvé des points à vérifier :\n",
        "Kyro found some things to check:\n",
    ));
    for w in &c.warnings {
        out += &match (w, lang) {
            (AptosStakeWarning::HighCommission { pct }, Lang::Fr) => {
                format!("• l'opérateur garde {pct:.0} % des récompenses\n")
            }
            (AptosStakeWarning::HighCommission { pct }, Lang::En) => {
                format!("• the operator keeps {pct:.0}% of the rewards\n")
            }
            (AptosStakeWarning::NotValidating, _) => lang
                .pick(
                    "• ce pool ne valide pas en ce moment : pas de récompenses tant qu'il reste dehors\n",
                    "• this pool is not validating right now: no rewards while it stays out\n",
                )
                .to_owned(),
            (AptosStakeWarning::HighFee, _) => lang
                .pick(
                    "• frais maximaux supérieurs à 0,1 APT\n",
                    "• maximum fee above 0.1 APT\n",
                )
                .to_owned(),
        };
    }
    out += lang.pick("\nContinuer quand même ?", "\nContinue anyway?");
    out
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AptosStakeSigned {
    /// Signed transaction, hex BCS: what `aptos_stake_broadcast` submits.
    pub signed: String,
    pub hash: String,
    pub summary: AptosStakeSummary,
    pub context: AptosStakeContext,
}

#[tauri::command]
pub async fn aptos_stake_sign(
    app: AppHandle,
    state: State<'_, AppState>,
    raw: String,
    password: String,
    account: Option<u32>,
) -> AppResult<AptosStakeSigned> {
    if !state.is_unlocked() {
        return Err(AppError::Locked);
    }
    let a = account_arg(account)?;
    let (me, pk) = ours(&state, a)?;
    let signer = SignerInfo::new(&state, Chain::Apt, a, wallet_core::aptos_path(a));
    let c = ctx(&state);
    let (summary, context) = context_for(&c, &me, &pk, &raw).await?;
    let seed = seed_from_password(&state, Zeroizing::new(password)).await?;
    let lang = crate::i18n::current();
    confirm_native(
        &app,
        lang.pick(
            "Confirmer l'opération de staking Aptos",
            "Confirm the Aptos staking operation",
        ),
        signer.body(lang, &describe(lang, &summary, &context, state.network)),
    )
    .await?;
    confirm_signer(&app, &signer).await?;
    if context.requires_extra_confirmation {
        confirm_native(
            &app,
            lang.pick("Attention : pool à vérifier", "Warning: pool to check"),
            describe_extra(lang, &context),
        )
        .await?;
    }
    let r = raw.clone();
    let (signed, hash, again) =
        blocking(move || Ok(wallet_core::aptos_stake_sign(&seed, a, &r)?)).await?;
    if again != summary {
        return Err(AppError::Internal(
            "summary differs between the preview and the signature".into(),
        ));
    }
    state.touch();
    Ok(AptosStakeSigned {
        signed,
        hash,
        summary,
        context,
    })
}

#[tauri::command]
pub async fn aptos_stake_broadcast(
    state: State<'_, AppState>,
    signed: String,
    account: Option<u32>,
) -> AppResult<String> {
    let (me, _) = ours(&state, account_arg(account)?)?;
    let (hash, t) = wallet_core::aptos_stake_verify_signed(&signed)?;
    let c = ctx(&state);
    if t.sender != wallet_core::aptos_parse_address(&me)? {
        return Err(invalid("this transaction is not signed by your account"));
    }
    if t.chain_id != c.chain_id {
        return Err(invalid("transaction signed for another chain"));
    }
    let bytes = hex::decode(signed.trim().trim_start_matches("0x"))
        .map_err(|_| invalid("transaction: hexadecimal expected"))?;
    aptos_backend::submit(&c, bytes, &hash).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_pools_and_rates() {
        // Trimmed from api.mainnet.aptoslabs.com on 2026-11-04.
        let set = json!({ "active_validators": [
            { "addr": "0x63b0a7343c481fe176603e4e30cc5acc521c75d4310ce1b7b657c8168df66c66" },
            { "addr": "0xb9d1a07cb94e46147b50ba9ce9c0f3b6677d7108384d63fda6e63dfca102bba" },
            { "addr": "not an address" }
        ] });
        let pool = "0x63b0a7343c481fe176603e4e30cc5acc521c75d4310ce1b7b657c8168df66c66";
        let short = "0x0b9d1a07cb94e46147b50ba9ce9c0f3b6677d7108384d63fda6e63dfca102bba";
        let indexed = json!({
            "current_delegated_staking_pool_balances": [
                { "staking_pool_address": pool, "operator_commission_percentage": 1000, "total_coins": 249350668400243u64 },
                { "staking_pool_address": short, "operator_commission_percentage": 500, "total_coins": 5 },
                { "staking_pool_address": "0xdd257c629f8e6cae3e649ebab088c2e2c06e533dbdb3fd0204bd7e4264cdffb3", "operator_commission_percentage": 0, "total_coins": 900 }
            ],
            "delegated_staking_pools": [
                { "staking_pool_address": pool, "current_staking_pool": { "operator_aptos_name": [{ "domain": "kyro\ntest" }] } },
                { "staking_pool_address": short, "current_staking_pool": { "operator_aptos_name": [] } }
            ]
        });
        let list = pools_from(&set, &indexed, Some(2.0));
        assert_eq!(list.len(), 2, "pools outside the active set are dropped");
        assert_eq!(list[0].address, pool);
        assert_eq!(list[0].commission_pct, 10.0);
        assert_eq!(list[0].name.as_deref(), Some("kyro test"));
        assert_eq!(list[0].apy, Some(1.8));
        assert_eq!(list[1].address, short);
        assert_eq!(list[1].name, None);

        let rewards = json!({ "rewards_rate": { "value": "109501220528869" } });
        let config = json!({ "rewards_rate": "15981", "rewards_rate_denominator": "1000000000" });
        let r = rate_from(Some(&rewards), Some(&config)).unwrap();
        assert!((r - 5.936e-6).abs() < 1e-8, "{r}");
        assert_eq!(rate_from(None, Some(&config)), Some(1.5981e-5));
        let apy = apy_from(r, 7_200_000_000).unwrap();
        assert!(apy > 2.0 && apy < 3.0, "{apy}");
        assert_eq!(apy_from(0.0, 1), None);

        assert_eq!(
            stake_from(&json!(["3147382529", "0", "24095161003169"])).unwrap(),
            (3_147_382_529, 0, 24_095_161_003_169)
        );
        assert!(stake_from(&json!(["1"])).is_err());
        assert_eq!(
            my_pools_from(&json!({ "delegator_distinct_pool": [
                { "pool_address": pool }, { "pool_address": pool }, { "pool_address": "bad" }
            ] })),
            vec![pool.to_owned()]
        );
    }

    #[test]
    fn gas_bounds() {
        assert_eq!(max_gas_for(13_316).unwrap(), 19_974);
        assert_eq!(max_gas_for(1).unwrap(), MIN_STAKE_GAS);
        assert!(max_gas_for(50_000).is_err());
    }

    #[test]
    fn dialog_texts() {
        let pool = format!("0x{}", "ab".repeat(32));
        let s = AptosStakeSummary {
            sender: "0xa2d1".into(),
            call: AptosStakeCall::AddStake,
            pool: pool.clone(),
            amount: "1100000000".into(),
            sequence_number: "3".into(),
            max_gas_amount: "20000".into(),
            gas_unit_price: "100".into(),
            max_fee: "2000000".into(),
            expiration_timestamp_secs: 1_793_800_000,
            chain_id: 1,
        };
        let c = AptosStakeContext {
            account: AptosAccountInfo::default(),
            position: AptosPoolPosition {
                pool,
                active: "0".into(),
                pending_inactive: "0".into(),
                inactive: "0".into(),
                commission_pct: Some(25.0),
                lockup_ends: Some(1_000 + 3 * 86_400),
            },
            validating: false,
            add_stake_fee: Some("5876".into()),
            gas_used: "13000".into(),
            ledger_time: 1_000,
            warnings: vec![
                AptosStakeWarning::HighCommission { pct: 25.0 },
                AptosStakeWarning::NotValidating,
            ],
            requires_extra_confirmation: true,
        };
        for lang in [Lang::En, Lang::Fr] {
            let d = describe(lang, &s, &c, Network::Mainnet);
            for needle in ["11 APT", "abab", "≈ 3", "0,00005876|0.00005876"] {
                assert!(
                    needle.split('|').any(|n| d.contains(n)),
                    "{needle} missing in {d}"
                );
            }
            assert!(describe_extra(lang, &c).contains("25"));
        }
    }
}

/// Reads over Tor, no stake signed: `cargo test -p kyro-desktop stake_aptos -- --ignored`.
#[cfg(test)]
mod live {
    use super::*;
    use crate::net::NetClient;
    use crate::tor::TorState;

    const HOLDER: &str = "0x84698b6cae4da89c7f25558537e872c63ccd4d28e96ac70eeb4bf6d8761e3a4d";

    #[test]
    #[ignore]
    fn aptos_stake_reads_over_tor() {
        let net = NetClient::new(std::env::temp_dir().join("kyro-apt-stake-live")).unwrap();
        tauri::async_runtime::block_on(async {
            net.tor.restart();
            while net.tor.status().state != TorState::Ready {
                assert_ne!(net.tor.status().state, TorState::Error);
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            }
            let at = |network| AptosCtx {
                net_client: &net,
                tor: true,
                bases: aptos_backend::default_bases(network),
                chain_id: aptos_backend::chain_id_of(network),
            };
            for network in [Network::Mainnet, Network::Testnet] {
                let c = at(network);
                let p = pools(&c).await.unwrap();
                eprintln!(
                    "{network:?}: {} pools, gross {:?}, first {:?}",
                    p.pools.len(),
                    p.gross_apy,
                    p.pools.first()
                );
                assert!(p.gross_apy.is_some());
            }
            let c = at(Network::Mainnet);
            let p = pools(&c).await.unwrap();
            assert!(p.pools.len() > 5);
            let o = overview(&c, HOLDER).await.unwrap();
            eprintln!("positions {:?}", o.positions);
            assert!(!o.positions.is_empty());
        });
    }
}
