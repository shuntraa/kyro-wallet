//! Sui native staking (`sui_stake_*`, docs/IPC.md §2.8): `request_add_stake` to an active validator
//! and `request_withdraw_stake` of a `StakedSui` object. Built by Rust, decoded by wallet-core,
//! validator set, object and simulation read live, native dialog before signing.

use futures_util::future::join_all;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, State};
use wallet_core::{
    Network, SuiObjectRef, SuiStakeAction, SuiStakeCall, SuiStakeSummary, SuiStakeTx, SuiTxSummary,
    SUI_HIGH_GAS_BUDGET, SUI_MIN_STAKE,
};
use zeroize::Zeroizing;

use crate::accounts::{account_arg, confirm_signer, Chain, SignerInfo};
use crate::commands::{blocking, confirm_native, seed_from_password};
use crate::commands_sui::{b64, ctx, describe_gas, ours, sui, SuiContext, MAX_PRICE_FACTOR};
use crate::error::{AppError, AppResult};
use crate::i18n::Lang;
use crate::state::AppState;
use crate::sui_backend::{self, bad, gql, num, SuiCtx, DRAFT_BUDGET};

const STAKED_SUI: &str = "0x3::staking_pool::StakedSui";
const STAKED_SUI_REPR: &str =
    "0x0000000000000000000000000000000000000000000000000000000000000003::staking_pool::StakedSui";
/// Commission (percent) above which the reinforced dialog opens.
const HIGH_COMMISSION_PCT: f64 = 10.0;
/// Epochs between the two exchange rates of the yield estimate.
const APY_EPOCHS: u64 = 30;
const EPOCHS_PER_YEAR: f64 = 365.0;
/// One lookup alias takes ≈ 200 bytes; the server caps a query at 5,000.
const RATES_PER_QUERY: usize = 20;
const MAX_POSITIONS: u32 = 50;

fn invalid(m: impl Into<String>) -> AppError {
    AppError::InvalidInput(m.into())
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SuiValidator {
    pub address: String,
    /// Declared by the validator itself.
    pub name: String,
    pub pool_id: String,
    pub commission_pct: f64,
    /// MIST in the pool this epoch.
    pub stake: String,
    /// On the protocol's at-risk list (too little stake: may leave the set).
    pub at_risk: bool,
    /// Measured yield over the last 30 epochs, percent per year, after commission.
    pub apy: Option<f64>,
}

/// One active validator with what the yield maths need.
#[derive(Debug, Clone, PartialEq)]
pub struct ValidatorEntry {
    pub v: SuiValidator,
    rates_table: String,
    /// `sui_balance` / `pool_token_balance` now.
    rate: Option<f64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SuiValidators {
    pub validators: Vec<SuiValidator>,
    /// Stake-weighted yield of the set, percent per year, after commission.
    pub network_apy: Option<f64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SuiStakePosition {
    /// The `StakedSui` object.
    pub object_id: String,
    pub pool_id: String,
    /// Validator's address, when its pool is in the active set.
    pub validator: Option<String>,
    pub validator_name: Option<String>,
    /// MIST.
    pub principal: String,
    pub activation_epoch: u64,
    /// Earns from `activation_epoch` on.
    pub active: bool,
    /// Rewards accrued so far (MIST, estimate from the pool's exchange rates).
    pub rewards: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SuiStakeOverview {
    pub address: String,
    /// MIST in SUI coins (what Kyro can stake).
    pub spendable: String,
    pub positions: Vec<SuiStakePosition>,
    pub epoch: u64,
    /// MIST.
    pub min_stake: String,
}

/// `at_risk_validators` (VecMap address → epochs) → addresses.
fn at_risk_of(set: &Value) -> Vec<&str> {
    set["at_risk_validators"]["contents"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|e| e["key"].as_str())
        .collect()
}

/// `ValidatorSet` Move value → active validators, largest stake first.
pub fn validators_from(set: &Value) -> AppResult<Vec<ValidatorEntry>> {
    let list = set["active_validators"]
        .as_array()
        .ok_or_else(|| bad("Sui: validator set missing"))?;
    let risky = at_risk_of(set);
    let mut out: Vec<(u64, ValidatorEntry)> = list
        .iter()
        .filter_map(|v| {
            let address =
                sui_backend::check_address(v["metadata"]["sui_address"].as_str()?).ok()?;
            let pool = &v["staking_pool"];
            let balance = num(&pool["sui_balance"])?;
            let tokens = num(&pool["pool_token_balance"])?;
            let commission = num(&v["commission_rate"])?;
            Some((
                balance,
                ValidatorEntry {
                    v: SuiValidator {
                        at_risk: risky.contains(&address.as_str()),
                        name: crate::dialog_text::sanitize(
                            v["metadata"]["name"].as_str().unwrap_or(""),
                            60,
                        ),
                        pool_id: pool["id"].as_str()?.to_owned(),
                        commission_pct: commission as f64 / 100.0,
                        stake: balance.to_string(),
                        apy: None,
                        address,
                    },
                    rates_table: pool["exchange_rates"]["id"].as_str()?.to_owned(),
                    rate: (tokens > 0).then(|| balance as f64 / tokens as f64),
                },
            ))
        })
        .collect();
    out.sort_by_key(|e| std::cmp::Reverse(e.0));
    Ok(out.into_iter().map(|e| e.1).collect())
}

/// Yield between two exchange rates `epochs` apart, percent per year.
pub fn apy_between(then: f64, now: f64, epochs: u64) -> Option<f64> {
    if then <= 0.0 || now < then || epochs == 0 {
        return None;
    }
    let a = ((now / then).powf(EPOCHS_PER_YEAR / epochs as f64) - 1.0) * 100.0;
    (a.is_finite() && a < 100.0).then_some(a)
}

/// Stake-weighted mean of the validators' yields.
pub fn network_apy(list: &[SuiValidator]) -> Option<f64> {
    let (mut sum, mut weight) = (0.0, 0.0);
    for v in list {
        if let (Some(a), Ok(s)) = (v.apy, v.stake.parse::<f64>()) {
            sum += a * s;
            weight += s;
        }
    }
    (weight > 0.0).then(|| sum / weight)
}

/// The whole active set; a reader of the current validator set, epoch and chain.
pub(crate) async fn validator_set(c: &SuiCtx<'_>) -> AppResult<(u64, Vec<ValidatorEntry>)> {
    let d = gql(
        c,
        "{ chainIdentifier epoch { epochId validatorSet { contents { json } } } }",
        json!({}),
    )
    .await?;
    sui_backend::check_chain(c, &d["chainIdentifier"])?;
    let e = &d["epoch"];
    let epoch = num(&e["epochId"]).ok_or_else(|| bad("Sui: epoch missing"))?;
    Ok((
        epoch,
        validators_from(&e["validatorSet"]["contents"]["json"])?,
    ))
}

fn epoch_key(epoch: u64) -> String {
    b64(&epoch.to_le_bytes())
}

/// `PoolTokenExchangeRate` Move value → SUI per pool token (a fresh pool stores 0 / 0 for 1).
pub fn rate_from(v: &Value) -> Option<f64> {
    let sui = num(&v["sui_amount"])?;
    let tokens = num(&v["pool_token_amount"])?;
    if sui == 0 || tokens == 0 {
        return Some(1.0);
    }
    Some(sui as f64 / tokens as f64)
}

/// Exchange rates of `(table, epoch)` pairs, read from each pool's `exchange_rates` table.
async fn rates(c: &SuiCtx<'_>, pairs: &[(String, u64)]) -> Vec<Option<f64>> {
    let chunks = pairs.chunks(RATES_PER_QUERY).map(|chunk| async move {
        let mut q = String::from("{");
        for (i, (table, epoch)) in chunk.iter().enumerate() {
            q += &format!(
                "r{i}:address(address:\"{table}\"){{dynamicField(name:{{type:\"u64\",bcs:\"{}\"}}){{value{{...on MoveValue{{json}}}}}}}}",
                epoch_key(*epoch)
            );
        }
        q.push('}');
        let d = gql(c, &q, json!({})).await.unwrap_or(Value::Null);
        (0..chunk.len())
            .map(|i| rate_from(&d[format!("r{i}")]["dynamicField"]["value"]["json"]))
            .collect::<Vec<_>>()
    });
    join_all(chunks).await.into_iter().flatten().collect()
}

async fn with_apy(c: &SuiCtx<'_>, epoch: u64, entries: Vec<ValidatorEntry>) -> Vec<SuiValidator> {
    let back = APY_EPOCHS.min(epoch);
    let pairs: Vec<(String, u64)> = entries
        .iter()
        .map(|e| (e.rates_table.clone(), epoch - back))
        .collect();
    let then = rates(c, &pairs).await;
    entries
        .into_iter()
        .zip(then)
        .map(|(e, r)| SuiValidator {
            apy: r.zip(e.rate).and_then(|(a, b)| apy_between(a, b, back)),
            ..e.v
        })
        .collect()
}

/// An owned `StakedSui`, as read live.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StakedObject {
    pub r: SuiObjectRef,
    pub pool_id: String,
    pub principal: u64,
    pub activation_epoch: u64,
}

/// `objects` nodes → the account's `StakedSui` objects; anything inconsistent is refused.
pub fn staked_from(nodes: &Value, me: &str) -> AppResult<Vec<StakedObject>> {
    let mut out = Vec::new();
    for n in nodes.as_array().into_iter().flatten() {
        let c = &n["contents"];
        if c["type"]["repr"] != STAKED_SUI_REPR {
            return Err(bad("Sui: object of another type in the stake list"));
        }
        if n["owner"]["address"]["address"].as_str() != Some(me) {
            return Err(bad("Sui: stake not owned by this account"));
        }
        let id = n["address"].as_str().unwrap_or("");
        let j = &c["json"];
        if j["id"].as_str() != Some(id) {
            return Err(bad("Sui: inconsistent stake ID"));
        }
        out.push(StakedObject {
            r: SuiObjectRef::parse(
                id,
                num(&n["version"]).ok_or_else(|| bad("Sui: stake version missing"))?,
                n["digest"].as_str().unwrap_or(""),
            )
            .map_err(|e| bad(format!("Sui: invalid stake ({e})")))?,
            pool_id: j["pool_id"].as_str().unwrap_or("").to_owned(),
            principal: num(&j["principal"]).ok_or_else(|| bad("Sui: principal missing"))?,
            activation_epoch: num(&j["stake_activation_epoch"])
                .ok_or_else(|| bad("Sui: activation epoch missing"))?,
        });
    }
    Ok(out)
}

async fn staked_objects(c: &SuiCtx<'_>, me: &str) -> AppResult<Vec<StakedObject>> {
    let d = gql(
        c,
        "query($a: SuiAddress!, $n: Int!, $t: String!) { chainIdentifier address(address: $a) { objects(first: $n, filter: { type: $t }) { nodes { address version digest owner { __typename ... on AddressOwner { address { address } } } contents { type { repr } json } } } } }",
        json!({ "a": me, "n": MAX_POSITIONS, "t": STAKED_SUI }),
    )
    .await?;
    sui_backend::check_chain(c, &d["chainIdentifier"])?;
    staked_from(&d["address"]["objects"]["nodes"], me)
}

fn position_of(o: &StakedObject, set: &[ValidatorEntry], epoch: u64) -> SuiStakePosition {
    let v = set.iter().find(|e| e.v.pool_id == o.pool_id);
    SuiStakePosition {
        object_id: wallet_core::sui_address_string(&o.r.object_id),
        pool_id: o.pool_id.clone(),
        validator: v.map(|e| e.v.address.clone()),
        validator_name: v.map(|e| e.v.name.clone()),
        principal: o.principal.to_string(),
        activation_epoch: o.activation_epoch,
        active: o.activation_epoch <= epoch,
        rewards: None,
    }
}

/// Rewards = principal × (rate now / rate at activation − 1).
pub fn rewards_of(principal: u64, then: f64, now: f64) -> Option<u64> {
    (then > 0.0 && now >= then).then(|| (principal as f64 * (now / then - 1.0)) as u64)
}

pub(crate) async fn overview(c: &SuiCtx<'_>, me: &str) -> AppResult<SuiStakeOverview> {
    let (epoch, set) = validator_set(c).await?;
    let balance = sui_backend::balance(c, me).await?;
    let objects = staked_objects(c, me).await?;
    let table = |o: &StakedObject| set.iter().find(|e| e.v.pool_id == o.pool_id);
    let pairs: Vec<(String, u64)> = objects
        .iter()
        .filter(|o| o.activation_epoch <= epoch)
        .filter_map(|o| Some((table(o)?.rates_table.clone(), o.activation_epoch)))
        .collect();
    let mut then = rates(c, &pairs).await.into_iter();
    let positions = objects
        .iter()
        .map(|o| {
            let mut p = position_of(o, &set, epoch);
            if p.active {
                if let Some(e) = table(o) {
                    p.rewards = then
                        .next()
                        .flatten()
                        .zip(e.rate)
                        .and_then(|(a, b)| rewards_of(o.principal, a, b))
                        .map(|r| r.to_string());
                }
            }
            p
        })
        .collect();
    Ok(SuiStakeOverview {
        address: me.to_owned(),
        spendable: balance.coin,
        positions,
        epoch,
        min_stake: SUI_MIN_STAKE.to_string(),
    })
}

#[tauri::command]
pub async fn sui_stake_overview(
    state: State<'_, AppState>,
    account: Option<u32>,
) -> AppResult<SuiStakeOverview> {
    let me = ours(&state, account_arg(account)?)?;
    overview(&ctx(&state), &me).await
}

pub(crate) async fn validators(c: &SuiCtx<'_>) -> AppResult<SuiValidators> {
    let (epoch, set) = validator_set(c).await?;
    let validators = with_apy(c, epoch, set).await;
    Ok(SuiValidators {
        network_apy: network_apy(&validators),
        validators,
    })
}

#[tauri::command]
pub async fn sui_stake_validators(state: State<'_, AppState>) -> AppResult<SuiValidators> {
    validators(&ctx(&state)).await
}

/// What the UI asks Kyro to build.
#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SuiStakeRequest {
    /// `amount` in MIST.
    Stake {
        validator: String,
        amount: String,
    },
    Withdraw {
        object_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SuiStakeWarning {
    /// The validator keeps more than 10 % of the rewards.
    HighCommission { pct: f64 },
    /// On the protocol's at-risk list: it may leave the set.
    AtRisk,
    /// Gas budget above 0.1 SUI.
    HighGasBudget,
}

/// Live facts shown before the password and in the dialog.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SuiStakeContext {
    /// Gas side: coins, price, simulated cost (`receives`: SUI back from a withdrawal).
    pub gas: SuiContext,
    pub validator: Option<SuiValidator>,
    pub position: Option<SuiStakePosition>,
    pub warnings: Vec<SuiStakeWarning>,
    pub requires_extra_confirmation: bool,
}

/// The stake's summary as gas lines read it (`describe_gas`).
fn gas_view(s: &SuiStakeSummary) -> SuiTxSummary {
    SuiTxSummary {
        sender: s.sender.clone(),
        recipient: s.sender.clone(),
        coin_type: wallet_core::SUI_COIN_TYPE.into(),
        amount: None,
        gas_budget: s.gas_budget.clone(),
        gas_price: s.gas_price.clone(),
        gas_coins: s.gas_coins.clone(),
        expiration_epoch: Some(s.expiration_epoch),
        digest: s.digest.clone(),
        warnings: vec![],
        requires_extra_confirmation: false,
        token: None,
    }
}

pub(crate) async fn context_for(
    c: &SuiCtx<'_>,
    me: &str,
    bcs: &str,
) -> AppResult<(SuiStakeSummary, SuiStakeContext)> {
    let s = wallet_core::sui_stake_decode(bcs, me)?;
    let ep = sui_backend::epoch(c).await?;
    if s.expiration_epoch < ep.epoch {
        return Err(invalid("staking transaction expired: rebuild it"));
    }
    let price: u64 = s.gas_price.parse().unwrap_or(0);
    if price < ep.reference_gas_price {
        return Err(invalid(
            "gas price below the epoch's reference price: rebuild it",
        ));
    }
    if price > ep.reference_gas_price.saturating_mul(MAX_PRICE_FACTOR) {
        return Err(invalid(format!(
            "abnormal gas price: {price} MIST/unit for a reference of {}",
            ep.reference_gas_price
        )));
    }
    let coins = sui_backend::coins(c, me).await?;
    let mut gas_total: u64 = 0;
    let mut gas_coin_balances = Vec::with_capacity(s.gas_coins.len());
    for g in &s.gas_coins {
        let r = SuiObjectRef::parse(&g.object_id, g.version.parse().unwrap_or(0), &g.digest)?;
        let coin = coins.iter().find(|x| x.r == r).ok_or_else(|| {
            invalid("the gas coins changed since the operation was prepared: rebuild it")
        })?;
        gas_total = gas_total.saturating_add(coin.balance);
        gas_coin_balances.push(coin.balance.to_string());
    }
    let budget: u64 = s.gas_budget.parse().unwrap_or(u64::MAX);
    let (_, set) = validator_set(c).await?;
    let mut warnings = Vec::new();
    let (validator, position, need) = match &s.action {
        SuiStakeAction::Add { amount, validator } => {
            let v = set
                .iter()
                .find(|e| &e.v.address == validator)
                .map(|e| e.v.clone())
                .ok_or_else(|| invalid("this validator is not in the active set: refused"))?;
            if v.commission_pct > HIGH_COMMISSION_PCT {
                warnings.push(SuiStakeWarning::HighCommission {
                    pct: v.commission_pct,
                });
            }
            if v.at_risk {
                warnings.push(SuiStakeWarning::AtRisk);
            }
            let a: u64 = amount.parse().unwrap_or(u64::MAX);
            (Some(v), None, a.saturating_add(budget))
        }
        SuiStakeAction::Withdraw { staked } => {
            let r = SuiObjectRef::parse(
                &staked.object_id,
                staked.version.parse().unwrap_or(0),
                &staked.digest,
            )?;
            let live = staked_objects(c, me).await?;
            let o = live.iter().find(|o| o.r == r).ok_or_else(|| {
                invalid("this stake changed since the operation was prepared: rebuild it")
            })?;
            let p = position_of(o, &set, ep.epoch);
            let v = set.iter().find(|e| e.v.pool_id == o.pool_id);
            (v.map(|e| e.v.clone()), Some(p), budget)
        }
    };
    if need > gas_total {
        return Err(invalid(format!(
            "balance too low: {} in the SUI coins, {} needed",
            sui(Lang::En, &gas_total.to_string()),
            sui(Lang::En, &need.to_string())
        )));
    }
    if budget > SUI_HIGH_GAS_BUDGET {
        warnings.push(SuiStakeWarning::HighGasBudget);
    }
    let sim = sui_backend::simulate(c, bcs, &s.digest).await?;
    if !sim.success {
        return Err(invalid(format!(
            "staking simulation failed: {}",
            sim.error.unwrap_or_default()
        )));
    }
    if !sui_backend::only_sui_between(&sim, me, me) {
        return Err(AppError::ServerUnreachable(
            "Sui: the simulation moves funds other than this operation".into(),
        ));
    }
    let e = &sim.estimate;
    // SUI that leave (add) or return (withdraw), once the simulated fee is taken out.
    let moved = sui_backend::sui_change(&sim, me) + e.net_fee;
    let receives = match &s.action {
        SuiStakeAction::Add { amount, .. } => {
            if moved != -i128::from(amount.parse::<u64>().unwrap_or(0)) {
                return Err(AppError::ServerUnreachable(
                    "Sui: the simulation does not stake the expected amount".into(),
                ));
            }
            None
        }
        SuiStakeAction::Withdraw { .. } => {
            if moved <= 0 {
                return Err(AppError::ServerUnreachable(
                    "Sui: the simulation returns nothing for this stake".into(),
                ));
            }
            Some(moved.to_string())
        }
    };
    let balance: u64 = coins.iter().fold(0u64, |a, x| a.saturating_add(x.balance));
    let context = SuiStakeContext {
        gas: SuiContext {
            balance: balance.to_string(),
            gas_coins_total: gas_total.to_string(),
            gas_coin_balances,
            reference_gas_price: ep.reference_gas_price.to_string(),
            epoch: ep.epoch,
            computation_cost: e.computation_cost.to_string(),
            storage_cost: e.storage_cost.to_string(),
            storage_rebate: e.storage_rebate.to_string(),
            fee: e.net_fee,
            receives,
            token: None,
        },
        validator,
        position,
        requires_extra_confirmation: !warnings.is_empty(),
        warnings,
    };
    Ok((s, context))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SuiStakeBuilt {
    /// Unsigned `TransactionData`, BCS base64: what `sui_stake_sign` takes.
    pub bcs: String,
    pub summary: SuiStakeSummary,
    pub context: SuiStakeContext,
}

pub(crate) async fn build(
    c: &SuiCtx<'_>,
    me: &str,
    action: &SuiStakeRequest,
) -> AppResult<SuiStakeBuilt> {
    let sender = wallet_core::sui_parse_address(me)?;
    let ep = sui_backend::epoch(c).await?;
    let (call, amount) = match action {
        SuiStakeRequest::Stake { validator, amount } => {
            let amount: u64 = amount
                .trim()
                .parse()
                .map_err(|_| invalid("invalid amount (MIST expected)"))?;
            if amount < SUI_MIN_STAKE {
                return Err(invalid("the network's minimum stake is 1 SUI"));
            }
            let validator = wallet_core::sui_parse_address(validator.trim())?;
            (SuiStakeCall::Add { amount, validator }, amount)
        }
        SuiStakeRequest::Withdraw { object_id } => {
            let id = wallet_core::sui_parse_address(object_id.trim())?;
            let live = staked_objects(c, me).await?;
            let o = live
                .iter()
                .find(|o| o.r.object_id == id)
                .ok_or_else(|| invalid("this stake is not on this account"))?;
            (SuiStakeCall::Withdraw { staked: o.r }, 0)
        }
    };
    let coins = sui_backend::coins(c, me).await?;
    let selected = sui_backend::select_coins(&coins, amount.saturating_add(DRAFT_BUDGET));
    let total: u64 = selected.iter().fold(0, |a, x| a.saturating_add(x.balance));
    let price = ep.reference_gas_price;
    let min_budget = price.saturating_mul(1000);
    let draft_budget = total.saturating_sub(amount).min(DRAFT_BUDGET);
    if draft_budget < min_budget {
        return Err(invalid(
            "balance too low for this amount plus the network fee",
        ));
    }
    let mut t = SuiStakeTx {
        sender,
        call,
        gas_payment: selected.iter().map(|x| x.r).collect(),
        gas_price: price,
        gas_budget: draft_budget,
        expiration_epoch: Some(ep.epoch.saturating_add(1)),
    };
    let draft = t.encode()?;
    let sim = sui_backend::simulate(c, &b64(&draft), &wallet_core::sui_tx_digest(&draft)).await?;
    if !sim.success {
        return Err(invalid(format!(
            "staking simulation failed: {}",
            sim.error.unwrap_or_default()
        )));
    }
    t.gas_budget = sui_backend::gas_budget(&sim.estimate, price).max(min_budget);
    if amount.saturating_add(t.gas_budget) > total {
        return Err(invalid(
            "balance too low for this amount plus the network fee",
        ));
    }
    let bcs = b64(&t.encode()?);
    let (summary, context) = context_for(c, me, &bcs).await?;
    Ok(SuiStakeBuilt {
        bcs,
        summary,
        context,
    })
}

#[tauri::command]
pub async fn sui_stake_build(
    state: State<'_, AppState>,
    action: SuiStakeRequest,
    account: Option<u32>,
) -> AppResult<SuiStakeBuilt> {
    let me = ours(&state, account_arg(account)?)?;
    build(&ctx(&state), &me, &action).await
}

pub(crate) fn describe(
    lang: Lang,
    s: &SuiStakeSummary,
    c: &SuiStakeContext,
    net: Network,
) -> String {
    let su = |m: &str| sui(lang, m);
    let mut out = format!(
        "Staking Sui{}\n\n",
        if net == Network::Testnet {
            " (testnet)"
        } else {
            ""
        }
    );
    let named = |v: &Option<SuiValidator>| {
        v.as_ref().map_or("?".to_owned(), |v| {
            format!("\"{}\" ({})", v.name, v.address)
        })
    };
    out += &match (&s.action, lang) {
        (SuiStakeAction::Add { amount, .. }, Lang::Fr) => format!(
            "Opération : STAKER {} ({amount} MIST)\nValidateur : {}\nLe nom est déclaré par le validateur, seule l'adresse compte.\nEn stake à partir de la prochaine époque (24 h au plus). Retrait possible à tout moment.\n",
            su(amount), named(&c.validator)
        ),
        (SuiStakeAction::Add { amount, .. }, Lang::En) => format!(
            "Operation: STAKE {} ({amount} MIST)\nValidator: {}\nThe name is declared by the validator, only the address counts.\nStaked from the next epoch (24 h at most). You can withdraw at any time.\n",
            su(amount), named(&c.validator)
        ),
        (SuiStakeAction::Withdraw { staked }, Lang::Fr) => format!(
            "Opération : RETIRER LE STAKE vers ton compte\nObjet StakedSui : {}\nValidateur : {}\nMontant de départ : {}\nReçu selon la simulation : {}\n",
            staked.object_id,
            named(&c.validator),
            c.position.as_ref().map_or("?".into(), |p| su(&p.principal)),
            c.gas.receives.as_deref().map_or("?".into(), su),
        ),
        (SuiStakeAction::Withdraw { staked }, Lang::En) => format!(
            "Operation: WITHDRAW THE STAKE to your account\nStakedSui object: {}\nValidator: {}\nPrincipal: {}\nReceived according to the simulation: {}\n",
            staked.object_id,
            named(&c.validator),
            c.position.as_ref().map_or("?".into(), |p| su(&p.principal)),
            c.gas.receives.as_deref().map_or("?".into(), su),
        ),
    };
    if let (SuiStakeAction::Add { .. }, Some(v)) = (&s.action, &c.validator) {
        out += &lang.pick(
            format!(
                "Part gardée par le validateur : {:.2} %\n",
                v.commission_pct
            ),
            format!("Share kept by the validator: {:.2}%\n", v.commission_pct),
        );
    }
    out += "\n";
    out += &describe_gas(lang, &gas_view(s), &c.gas);
    out
}

pub(crate) fn describe_extra(lang: Lang, c: &SuiStakeContext) -> String {
    let mut out = String::from(lang.pick(
        "Kyro a trouvé des points à vérifier :\n",
        "Kyro found some things to check:\n",
    ));
    for w in &c.warnings {
        out += &match (w, lang) {
            (SuiStakeWarning::HighCommission { pct }, Lang::Fr) => {
                format!("• le validateur garde {pct:.0} % des récompenses\n")
            }
            (SuiStakeWarning::HighCommission { pct }, Lang::En) => {
                format!("• the validator keeps {pct:.0}% of the rewards\n")
            }
            (SuiStakeWarning::AtRisk, _) => lang
                .pick(
                    "• ce validateur est sur la liste à risque : il peut sortir de l'ensemble actif\n",
                    "• this validator is on the at-risk list: it may leave the active set\n",
                )
                .to_owned(),
            (SuiStakeWarning::HighGasBudget, _) => lang
                .pick(
                    "• budget de gaz supérieur à 0,1 SUI\n",
                    "• gas budget above 0.1 SUI\n",
                )
                .to_owned(),
        };
    }
    out += lang.pick("\nContinuer quand même ?", "\nContinue anyway?");
    out
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SuiStakeSigned {
    pub bcs: String,
    /// `flag || signature || public key`, base64.
    pub signature: String,
    pub digest: String,
    pub summary: SuiStakeSummary,
    pub context: SuiStakeContext,
}

#[tauri::command]
pub async fn sui_stake_sign(
    app: AppHandle,
    state: State<'_, AppState>,
    bcs: String,
    password: String,
    account: Option<u32>,
) -> AppResult<SuiStakeSigned> {
    if !state.is_unlocked() {
        return Err(AppError::Locked);
    }
    let a = account_arg(account)?;
    let me = ours(&state, a)?;
    let signer = SignerInfo::new(&state, Chain::Sui, a, wallet_core::sui_path(a));
    let c = ctx(&state);
    let (summary, context) = context_for(&c, &me, &bcs).await?;
    let seed = seed_from_password(&state, Zeroizing::new(password)).await?;
    let lang = crate::i18n::current();
    confirm_native(
        &app,
        lang.pick(
            "Confirmer l'opération de staking Sui",
            "Confirm the Sui staking operation",
        ),
        signer.body(lang, &describe(lang, &summary, &context, state.network)),
    )
    .await?;
    confirm_signer(&app, &signer).await?;
    if context.requires_extra_confirmation {
        confirm_native(
            &app,
            lang.pick(
                "Attention : validateur à vérifier",
                "Warning: validator to check",
            ),
            describe_extra(lang, &context),
        )
        .await?;
    }
    let b = bcs.clone();
    let (signature, again) =
        blocking(move || Ok(wallet_core::sui_stake_sign(&seed, a, &b)?)).await?;
    if again != summary {
        return Err(AppError::Internal(
            "summary differs between the preview and the signature".into(),
        ));
    }
    state.touch();
    Ok(SuiStakeSigned {
        bcs,
        signature,
        digest: summary.digest.clone(),
        summary,
        context,
    })
}

#[tauri::command]
pub async fn sui_stake_broadcast(
    state: State<'_, AppState>,
    bcs: String,
    signature: String,
    account: Option<u32>,
) -> AppResult<String> {
    let me = ours(&state, account_arg(account)?)?;
    let (t, digest) = wallet_core::sui_stake_verify_signed(&bcs, &signature)?;
    if t.sender != wallet_core::sui_parse_address(&me)? {
        return Err(invalid("this transaction is not signed by your account"));
    }
    sui_backend::execute(&ctx(&state), bcs.trim(), signature.trim(), &digest).await
}

#[cfg(test)]
mod tests {
    use super::*;

    // Trimmed from `epoch.validatorSet.contents.json` of graphql.mainnet.sui.io, 2026-11-04.
    fn set() -> Value {
        json!({
            "total_stake": "7070432181341408654",
            "active_validators": [
                {
                    "metadata": { "sui_address": "0x8f8ea04f3b751533db8b8da0a40eba1ca8332a92680f058d83b9459d061aaa54", "name": "InfStones" },
                    "staking_pool": {
                        "id": "0x3b34ff964e2d7ead46b3fe377b17b11aad0eecda7b75c3afa6f4d9073be2f77e",
                        "sui_balance": "9393599960408031",
                        "pool_token_balance": "8572892337223081",
                        "exchange_rates": { "id": "0xfc84a891514f2eb7f098457bf6451cb36886332116caaa52fce82249c9cabe48", "size": "1299" }
                    },
                    "commission_rate": "800"
                },
                {
                    "metadata": { "sui_address": "0x1ada6e6f3f3e4055096f606c746690f1108fcc2ca479055cc434a3e1d3f758aa", "name": "Big\nFake To: 0xdead" },
                    "staking_pool": {
                        "id": "0xaa",
                        "sui_balance": "19393599960408031",
                        "pool_token_balance": "18572892337223081",
                        "exchange_rates": { "id": "0xbb", "size": "9" }
                    },
                    "commission_rate": "1500"
                },
                { "metadata": { "sui_address": "bad" } }
            ],
            "at_risk_validators": { "contents": [{ "key": "0x1ada6e6f3f3e4055096f606c746690f1108fcc2ca479055cc434a3e1d3f758aa", "value": "3" }] }
        })
    }

    #[test]
    fn parses_the_set_and_yields() {
        let list = validators_from(&set()).unwrap();
        assert_eq!(list.len(), 2);
        assert!(list[0].v.at_risk && !list[1].v.at_risk);
        assert_eq!(list[1].v.name, "InfStones");
        assert!(!list[0].v.name.contains('\n'));
        assert_eq!(list[1].v.commission_pct, 8.0);
        // InfStones, epochs 1271 → 1301.
        let then = rate_from(
            &json!({ "sui_amount": "10054514584614066", "pool_token_amount": "9185440379957689" }),
        )
        .unwrap();
        let apy = apy_between(then, list[1].rate.unwrap(), 30).unwrap();
        assert!(apy > 0.5 && apy < 5.0, "{apy}");
        assert_eq!(apy_between(1.1, 1.0, 30), None);
        assert_eq!(apy_between(1.0, 3.0, 1), None);
        assert_eq!(
            rate_from(&json!({ "sui_amount": "0", "pool_token_amount": "0" })),
            Some(1.0)
        );
        let vs: Vec<SuiValidator> = list
            .iter()
            .map(|e| SuiValidator {
                apy: Some(2.0),
                ..e.v.clone()
            })
            .collect();
        assert_eq!(network_apy(&vs), Some(2.0));
        assert_eq!(network_apy(&[]), None);
        assert_eq!(rewards_of(1_000_000_000, 1.0, 1.1), Some(100_000_000));
        assert_eq!(rewards_of(1_000_000_000, 1.2, 1.1), None);
    }

    #[test]
    fn stake_list_is_checked() {
        let me = "0xa2d14fad60c56049ecf75246a481934691214ce413e6a8ae2fe6834c173a6133";
        let id = format!("0x{}", "ab".repeat(32));
        let node = |repr: &str, owner: &str, json_id: &str| {
            json!([{
                "address": id, "version": "77", "digest": "11111111111111111111111111111111",
                "owner": { "__typename": "AddressOwner", "address": { "address": owner } },
                "contents": { "type": { "repr": repr }, "json": { "id": json_id, "pool_id": "0xaa", "stake_activation_epoch": "1200", "principal": "5000000000" } }
            }])
        };
        let list = staked_from(&node(STAKED_SUI_REPR, me, &id), me).unwrap();
        assert_eq!(list[0].principal, 5_000_000_000);
        assert_eq!(list[0].activation_epoch, 1200);
        assert!(staked_from(&node("0x2::coin::Coin", me, &id), me).is_err());
        assert!(staked_from(&node(STAKED_SUI_REPR, "0xother", &id), me).is_err());
        assert!(staked_from(&node(STAKED_SUI_REPR, me, "0xother"), me).is_err());
        let set = validators_from(&set()).unwrap();
        let p = position_of(&list[0], &set, 1199);
        assert!(!p.active);
        assert_eq!(p.validator_name.as_deref(), Some("Big Fake To: 0xdead"));
    }

    #[test]
    fn dialog_texts() {
        let v = validators_from(&set()).unwrap()[1].v.clone();
        let s = SuiStakeSummary {
            sender: "0xa2d1".into(),
            action: SuiStakeAction::Add {
                amount: "5000000000".into(),
                validator: v.address.clone(),
            },
            gas_budget: "3000000".into(),
            gas_price: "1000".into(),
            gas_coins: vec![],
            expiration_epoch: 1302,
            digest: "qoQG6UgMDH39fa9hxUHxRcFDrmFR3zURqHP2FPcYXG9".into(),
        };
        let c = SuiStakeContext {
            gas: SuiContext {
                balance: "10000000000".into(),
                gas_coins_total: "10000000000".into(),
                gas_coin_balances: vec![],
                reference_gas_price: "1000".into(),
                epoch: 1301,
                computation_cost: "1000000".into(),
                storage_cost: "1976000".into(),
                storage_rebate: "978120".into(),
                fee: 1_997_880,
                receives: None,
                token: None,
            },
            validator: Some(v),
            position: None,
            warnings: vec![
                SuiStakeWarning::HighCommission { pct: 15.0 },
                SuiStakeWarning::AtRisk,
            ],
            requires_extra_confirmation: true,
        };
        for lang in [Lang::En, Lang::Fr] {
            let d = describe(lang, &s, &c, Network::Mainnet);
            for needle in ["InfStones", "0x8f8ea04f", "5 SUI", "Staking Sui\n"] {
                assert!(d.contains(needle), "{needle} missing in {d}");
            }
            let x = describe_extra(lang, &c);
            assert!(x.contains("15"), "{x}");
        }
    }
}

/// Reads over Tor, no stake signed: `cargo test -p kyro-desktop stake_sui -- --ignored`.
#[cfg(test)]
mod live {
    use super::*;
    use crate::net::NetClient;
    use crate::tor::TorState;

    const HOLDER: &str = "0xa67acb25d6c7924818b760c722be4b3d36eb9655a91216a8d32a125e2a3bf812";
    const RICH: &str = "0xe572789431106aadb45c2c47d8be5c32e30e0ed317cdff986b6896227aab2f97";

    async fn wait_tor(net: &NetClient) {
        net.tor.restart();
        while net.tor.status().state != TorState::Ready {
            assert_ne!(net.tor.status().state, TorState::Error);
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }
    }

    async fn reads(net: &NetClient) -> AppResult<()> {
        for network in [Network::Mainnet, Network::Testnet] {
            let c = SuiCtx::new(net, network, true);
            let vs = validators(&c).await?;
            let with = vs.validators.iter().filter(|v| v.apy.is_some()).count();
            eprintln!(
                "{network:?}: {} validators, {with} with a yield, network {:?}, first {:?}",
                vs.validators.len(),
                vs.network_apy,
                vs.validators.first()
            );
            if with * 2 <= vs.validators.len() {
                return Err(bad("too few exchange rates read"));
            }
        }
        let c = SuiCtx::new(net, Network::Mainnet, true);
        let o = overview(&c, HOLDER).await?;
        eprintln!("{} positions {:?}", o.positions.len(), o.positions.first());
        // Real addresses with coins: built and simulated, never signed.
        let vs = validators(&c).await?;
        let v = vs.validators.first().ok_or_else(|| bad("no validator"))?;
        let action = SuiStakeRequest::Stake {
            validator: v.address.clone(),
            amount: SUI_MIN_STAKE.to_string(),
        };
        match build(&c, RICH, &action).await {
            Ok(b) => eprintln!(
                "--- dialog ---\n{}",
                describe(Lang::En, &b.summary, &b.context, Network::Mainnet)
            ),
            Err(e) => return Err(e),
        }
        if let Some(p) = o.positions.first() {
            let action = SuiStakeRequest::Withdraw {
                object_id: p.object_id.clone(),
            };
            match build(&c, HOLDER, &action).await {
                Ok(b) => eprintln!(
                    "--- dialog ---\n{}",
                    describe(Lang::En, &b.summary, &b.context, Network::Mainnet)
                ),
                Err(e) => return Err(e),
            }
        }
        Ok(())
    }

    #[test]
    #[ignore]
    fn sui_stake_reads_over_tor() {
        let net = NetClient::new(std::env::temp_dir().join("kyro-sui-stake-live")).unwrap();
        tauri::async_runtime::block_on(async {
            // Some exit relays get HTTP 403 from the host: take a new circuit and try again.
            for attempt in 0..10 {
                wait_tor(&net).await;
                match reads(&net).await {
                    Ok(()) => return,
                    Err(e) => eprintln!("attempt {attempt}: {e}"),
                }
            }
            panic!("no usable exit relay");
        });
    }
}
