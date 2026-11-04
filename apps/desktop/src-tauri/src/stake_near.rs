//! NEAR staking through staking pools (`near_stake_*`, docs/IPC.md §2.8): `deposit_and_stake`,
//! `unstake`, `unstake_all`, `withdraw_all` on a pool from a known factory whose code hash is
//! checked live. Tx built by Rust, decoded by wallet-core, native dialog before signing.

use futures_util::future::join_all;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, State};
use wallet_core::{NearStakeAction, NearStakeCall, NearStakeSummary, NearStakeTx, Network};
use zeroize::Zeroizing;

use crate::accounts::{account_arg, confirm_signer, Chain, SignerInfo};
use crate::commands::{blocking, confirm_native, format_units_in, seed_from_password};
use crate::commands_near::{ctx, ours};
use crate::error::{AppError, AppResult};
use crate::i18n::Lang;
use crate::near_backend::{self, u128_at, NearAccountInfo, NearCtx, NearTxOutcome, MAX_BLOCK_AGE};
use crate::net::{Family, ServerRequest};
use crate::state::AppState;

/// Unstaked NEAR can be withdrawn after this many epochs (staking-pool `NUM_EPOCHS_TO_UNLOCK`).
pub const UNLOCK_EPOCHS: u64 = 4;
/// Pool fee above which the reinforced dialog opens.
const HIGH_FEE_PCT: f64 = 20.0;
/// Gas a pool call usually burns (estimate only; the bound uses the full prepaid gas).
const STAKE_GAS_ESTIMATE: u128 = 30_000_000_000_000;
const MAX_POOLS: usize = 20;

fn invalid(m: impl Into<String>) -> AppError {
    AppError::InvalidInput(m.into())
}

fn server(m: impl Into<String>) -> AppError {
    AppError::ServerUnreachable(m.into())
}

fn api_url(net: Network) -> &'static str {
    match net {
        Network::Mainnet => "https://api.fastnear.com",
        Network::Testnet => "https://test.api.fastnear.com",
    }
}

fn pool_on_network(pool: &str, net: Network) -> bool {
    wallet_core::near_stake_pool_network(pool) == Some(net == Network::Testnet)
}

/// Our position in one pool (yoctoNEAR).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NearPoolPosition {
    pub pool_id: String,
    pub staked: String,
    pub unstaked: String,
    /// The unstaked balance is unlocked (4 epochs passed).
    pub can_withdraw: bool,
    /// Share of rewards the pool keeps, in percent.
    pub fee_pct: Option<f64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NearEpoch {
    pub height: u64,
    pub start_height: u64,
    pub length: u64,
    /// Seconds per block measured over the current epoch.
    pub block_secs: f64,
    pub seconds_left: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NearStakeOverview {
    pub account_id: String,
    /// yoctoNEAR you can stake (balance − storage reserve).
    pub spendable: String,
    pub positions: Vec<NearPoolPosition>,
    pub epoch: NearEpoch,
    pub unlock_epochs: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NearValidator {
    pub pool_id: String,
    /// yoctoNEAR staked with the validator this epoch.
    pub stake: String,
    /// Pool from a factory Kyro accepts (the code hash is checked when you stake).
    pub supported: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NearValidators {
    pub validators: Vec<NearValidator>,
    /// Network reward rate before the pool fee, percent per year (estimate).
    pub gross_apy: Option<f64>,
}

fn fraction(v: &Value) -> Option<(u128, u128)> {
    let a = v.get(0)?.as_u64()?;
    let b = v.get(1)?.as_u64()?;
    (b > 0).then_some((u128::from(a), u128::from(b)))
}

/// Gross APY = max inflation × (1 − protocol share) × supply / total stake.
pub fn gross_apy(config: &Value, total_supply: u128, total_stake: u128) -> Option<f64> {
    let (in_n, in_d) = fraction(&config["max_inflation_rate"])?;
    let (pr_n, pr_d) = fraction(&config["protocol_reward_rate"])?;
    if total_stake == 0 || pr_n > pr_d {
        return None;
    }
    let infl = in_n as f64 / in_d as f64;
    let share = 1.0 - pr_n as f64 / pr_d as f64;
    let apy = infl * share * (total_supply as f64 / total_stake as f64) * 100.0;
    (apy.is_finite() && apy < 100.0).then_some(apy)
}

/// `validators` result → current validators, largest stake first.
pub fn validators_from(r: &Value, net: Network) -> AppResult<Vec<NearValidator>> {
    let list = r["current_validators"]
        .as_array()
        .ok_or_else(|| server("NEAR: validators missing"))?;
    let mut out: Vec<(u128, NearValidator)> = list
        .iter()
        .filter_map(|v| {
            let id = v["account_id"].as_str()?;
            wallet_core::near_account_kind(id).ok()?;
            let stake = u128_at(&v["stake"])?;
            Some((
                stake,
                NearValidator {
                    pool_id: id.to_owned(),
                    stake: stake.to_string(),
                    supported: pool_on_network(id, net),
                },
            ))
        })
        .collect();
    out.sort_by_key(|v| std::cmp::Reverse(v.0));
    Ok(out.into_iter().map(|(_, v)| v).collect())
}

/// Pool `get_account` view → position.
pub fn position_from(pool: &str, v: &Value, fee_pct: Option<f64>) -> AppResult<NearPoolPosition> {
    let get = |k: &str| u128_at(&v[k]).ok_or_else(|| server(format!("NEAR pool: {k} missing")));
    Ok(NearPoolPosition {
        pool_id: pool.to_owned(),
        staked: get("staked_balance")?.to_string(),
        unstaked: get("unstaked_balance")?.to_string(),
        can_withdraw: v["can_withdraw"].as_bool().unwrap_or(false),
        fee_pct,
    })
}

/// `get_reward_fee_fraction` → percent.
pub fn fee_from(v: &Value) -> Option<f64> {
    let n = v["numerator"].as_u64()?;
    let d = v["denominator"].as_u64()?;
    (d > 0 && n <= d).then(|| n as f64 * 100.0 / d as f64)
}

/// FastNEAR `/v1/account/{id}/staking` → pool ids on this network.
pub fn pools_from(v: &Value, net: Network) -> Vec<String> {
    let mut out: Vec<String> = v["pools"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|p| p["pool_id"].as_str())
        .filter(|p| pool_on_network(p, net))
        .map(str::to_owned)
        .collect();
    out.sort();
    out.dedup();
    out.truncate(MAX_POOLS);
    out
}

async fn account_pools(c: &NearCtx<'_>, me: &str) -> AppResult<Vec<String>> {
    let u = url::Url::parse(&format!("{}/v1/account/{me}/staking", api_url(c.network)))
        .map_err(|_| AppError::ServerInvalid("invalid NEAR URL".into()))?;
    let (status, bytes) = c
        .net_client
        .server_request(ServerRequest::get(u, Family::Near), c.tor)
        .await?;
    if status != 200 {
        return Err(server(format!("NEAR: HTTP {status} on the pool list")));
    }
    let v: Value =
        serde_json::from_slice(&bytes).map_err(|_| server("NEAR: pool list unreadable"))?;
    Ok(pools_from(&v, c.network))
}

async fn fee_pct(c: &NearCtx<'_>, pool: &str) -> Option<f64> {
    near_backend::view_call(c, pool, "get_reward_fee_fraction", &json!({}))
        .await
        .ok()
        .and_then(|v| fee_from(&v))
}

async fn position(c: &NearCtx<'_>, pool: &str, me: &str) -> AppResult<NearPoolPosition> {
    let v = near_backend::view_call(c, pool, "get_account", &json!({ "account_id": me })).await?;
    position_from(pool, &v, fee_pct(c, pool).await)
}

async fn epoch(c: &NearCtx<'_>) -> AppResult<(NearEpoch, Value)> {
    let vals = near_backend::rpc(c, "validators", json!([null])).await?;
    let head = near_backend::rpc(c, "block", json!({ "finality": "final" })).await?;
    let start = vals["epoch_start_height"]
        .as_u64()
        .ok_or_else(|| server("NEAR: epoch start missing"))?;
    let height = head["header"]["height"].as_u64().unwrap_or(start);
    let first = near_backend::rpc(c, "block", json!({ "block_id": start }))
        .await
        .ok();
    let ts = |b: &Value| {
        b["header"]["timestamp_nanosec"]
            .as_str()
            .and_then(|s| s.parse::<u128>().ok())
    };
    let length = 43_200;
    let block_secs = match (first.as_ref().and_then(ts), ts(&head)) {
        (Some(a), Some(b)) if b > a && height > start => {
            (b - a) as f64 / 1e9 / (height - start) as f64
        }
        _ => 1.0,
    };
    let left = (start + length).saturating_sub(height);
    Ok((
        NearEpoch {
            height,
            start_height: start,
            length,
            block_secs,
            seconds_left: (left as f64 * block_secs) as u64,
        },
        vals,
    ))
}

pub(crate) async fn overview(c: &NearCtx<'_>, me: &str) -> AppResult<NearStakeOverview> {
    let fees = near_backend::fees(c).await?;
    let account = near_backend::account(c, me, fees.storage_per_byte).await?;
    let pools = account_pools(c, me).await?;
    let positions = join_all(pools.iter().map(|p| position(c, p, me)))
        .await
        .into_iter()
        .collect::<AppResult<Vec<_>>>()?;
    let (epoch, _) = epoch(c).await?;
    Ok(NearStakeOverview {
        account_id: me.to_owned(),
        spendable: account.spendable,
        positions: positions
            .into_iter()
            .filter(|p| p.staked != "0" || p.unstaked != "0")
            .collect(),
        epoch,
        unlock_epochs: UNLOCK_EPOCHS,
    })
}

#[tauri::command]
pub async fn near_stake_overview(
    state: State<'_, AppState>,
    account: Option<u32>,
) -> AppResult<NearStakeOverview> {
    let (me, _) = ours(&state, account_arg(account)?)?;
    overview(&ctx(&state), &me).await
}

#[tauri::command]
pub async fn near_stake_validators(state: State<'_, AppState>) -> AppResult<NearValidators> {
    let c = ctx(&state);
    let vals = near_backend::rpc(&c, "validators", json!([null])).await?;
    let validators = validators_from(&vals, c.network)?;
    let total: u128 = validators
        .iter()
        .filter_map(|v| v.stake.parse::<u128>().ok())
        .sum();
    let config = near_backend::rpc(
        &c,
        "EXPERIMENTAL_protocol_config",
        json!({ "finality": "final" }),
    )
    .await?;
    let head = near_backend::rpc(&c, "block", json!({ "finality": "final" })).await?;
    let supply = u128_at(&head["header"]["total_supply"]).unwrap_or(0);
    Ok(NearValidators {
        validators,
        gross_apy: gross_apy(&config, supply, total),
    })
}

/// What the UI asks Kyro to build. Amounts in yoctoNEAR.
#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum NearStakeRequest {
    Stake { pool: String, amount: String },
    Unstake { pool: String, amount: String },
    UnstakeAll { pool: String },
    WithdrawAll { pool: String },
}

impl NearStakeRequest {
    fn pool(&self) -> &str {
        match self {
            NearStakeRequest::Stake { pool, .. }
            | NearStakeRequest::Unstake { pool, .. }
            | NearStakeRequest::UnstakeAll { pool }
            | NearStakeRequest::WithdrawAll { pool } => pool.trim(),
        }
    }

    fn call(&self) -> AppResult<NearStakeCall> {
        let yocto = |s: &str| {
            s.trim()
                .parse::<u128>()
                .ok()
                .filter(|v| *v > 0)
                .ok_or_else(|| invalid("invalid amount (yoctoNEAR expected)"))
        };
        Ok(match self {
            NearStakeRequest::Stake { amount, .. } => {
                NearStakeCall::DepositAndStake(yocto(amount)?)
            }
            NearStakeRequest::Unstake { amount, .. } => NearStakeCall::Unstake(yocto(amount)?),
            NearStakeRequest::UnstakeAll { .. } => NearStakeCall::UnstakeAll,
            NearStakeRequest::WithdrawAll { .. } => NearStakeCall::WithdrawAll,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum NearStakeWarning {
    /// The pool keeps more than 20 % of the rewards.
    HighFee { pct: f64 },
    /// The pool is not in the current validator set: no rewards while it stays out.
    NotValidating,
}

/// Live facts shown before the password and in the dialog.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NearStakeContext {
    pub account: NearAccountInfo,
    /// Our position in the pool before this operation.
    pub position: NearPoolPosition,
    pub validating: bool,
    pub epoch: NearEpoch,
    pub unlock_epochs: u64,
    pub gas_price: String,
    pub fee_estimate: String,
    pub fee_bound: String,
    pub warnings: Vec<NearStakeWarning>,
    pub requires_extra_confirmation: bool,
}

pub(crate) async fn context_for(
    c: &NearCtx<'_>,
    s: &NearStakeSummary,
) -> AppResult<NearStakeContext> {
    if s.testnet != (c.network == Network::Testnet) {
        return Err(invalid("staking pool from another network"));
    }
    let pool = s.pool_id.as_str();
    let code = near_backend::rpc(
        c,
        "query",
        json!({ "request_type": "view_account", "finality": "final", "account_id": pool }),
    )
    .await?;
    let hash = code["code_hash"].as_str().unwrap_or("");
    if !wallet_core::near_stake_code_ok(pool, hash) {
        return Err(invalid(format!(
            "{pool} does not run the standard staking-pool code: refused"
        )));
    }
    let fees = near_backend::fees(c).await?;
    let account = near_backend::account(c, &s.signer_id, fees.storage_per_byte).await?;
    let position = position(c, pool, &s.signer_id).await?;
    let (epoch, vals) = epoch(c).await?;
    let validating = validators_from(&vals, c.network)?
        .iter()
        .any(|v| v.pool_id == pool);
    let price = fees.gas_price.max(fees.min_gas_price);
    let prepaid = u128::from(wallet_core::NEAR_STAKE_GAS) * price;
    let fee_estimate = fees.estimate(false) + STAKE_GAS_ESTIMATE * fees.gas_price;
    let fee_bound = fees.bound(false) + prepaid;
    let spendable: u128 = account.spendable.parse().unwrap_or(0);
    let staked: u128 = position.staked.parse().unwrap_or(0);
    let unstaked: u128 = position.unstaked.parse().unwrap_or(0);
    match &s.action {
        NearStakeAction::Stake { amount } => {
            let a: u128 = amount.parse().unwrap_or(u128::MAX);
            if a.checked_add(fee_bound).is_none_or(|t| t > spendable) {
                return Err(invalid(
                    "balance too low for this amount plus the network fee",
                ));
            }
        }
        NearStakeAction::Unstake { amount } => {
            if amount.parse::<u128>().unwrap_or(u128::MAX) > staked {
                return Err(invalid("amount above what is staked in this pool"));
            }
        }
        NearStakeAction::UnstakeAll if staked == 0 => {
            return Err(invalid("nothing staked in this pool"));
        }
        NearStakeAction::WithdrawAll if unstaked == 0 || !position.can_withdraw => {
            return Err(invalid("nothing to withdraw yet"));
        }
        _ => {}
    }
    if fee_bound > spendable {
        return Err(invalid(
            "balance too low for this amount plus the network fee",
        ));
    }
    let mut warnings = Vec::new();
    if matches!(s.action, NearStakeAction::Stake { .. }) {
        if let Some(pct) = position.fee_pct.filter(|p| *p > HIGH_FEE_PCT) {
            warnings.push(NearStakeWarning::HighFee { pct });
        }
        if !validating {
            warnings.push(NearStakeWarning::NotValidating);
        }
    }
    Ok(NearStakeContext {
        account,
        position,
        validating,
        epoch,
        unlock_epochs: UNLOCK_EPOCHS,
        gas_price: fees.gas_price.to_string(),
        fee_estimate: fee_estimate.to_string(),
        fee_bound: fee_bound.to_string(),
        requires_extra_confirmation: !warnings.is_empty(),
        warnings,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NearStakeBuilt {
    /// Unsigned transaction (Borsh, hex): what `near_stake_sign` takes.
    pub tx: String,
    pub summary: NearStakeSummary,
    pub context: NearStakeContext,
}

#[tauri::command]
pub async fn near_stake_build(
    state: State<'_, AppState>,
    action: NearStakeRequest,
    account: Option<u32>,
) -> AppResult<NearStakeBuilt> {
    let (me, pk) = ours(&state, account_arg(account)?)?;
    build(&ctx(&state), &me, &pk, &action).await
}

pub(crate) async fn build(
    c: &NearCtx<'_>,
    me: &str,
    pk: &[u8; 32],
    action: &NearStakeRequest,
) -> AppResult<NearStakeBuilt> {
    let pool = action.pool();
    if !pool_on_network(pool, c.network) {
        return Err(invalid(format!("{pool}: not a staking pool Kyro accepts")));
    }
    let (key_nonce, block_hash, _) = near_backend::access_key(c, me, pk).await?;
    let tx = NearStakeTx {
        signer_id: me.to_owned(),
        public_key: *pk,
        nonce: key_nonce + 1,
        pool_id: pool.to_owned(),
        block_hash,
        call: action.call()?,
    };
    let hex = hex::encode(tx.encode());
    let summary = wallet_core::near_stake_decode(&hex, me, pk)?;
    let context = context_for(c, &summary).await?;
    Ok(NearStakeBuilt {
        tx: hex,
        summary,
        context,
    })
}

fn near(lang: Lang, yocto: &str) -> String {
    format!("{} NEAR", format_units_in(lang, yocto, 24))
}

fn hours(lang: Lang, secs: f64) -> String {
    let h = (secs / 3600.0).round().max(1.0) as u64;
    lang.pick(format!("≈ {h} h"), format!("≈ {h} h"))
}

pub(crate) fn describe(
    lang: Lang,
    s: &NearStakeSummary,
    c: &NearStakeContext,
    net: Network,
) -> String {
    let n = |y: &str| near(lang, y);
    let epoch_secs = c.epoch.length as f64 * c.epoch.block_secs;
    let unlock = hours(
        lang,
        c.epoch.seconds_left as f64 + (c.unlock_epochs - 1) as f64 * epoch_secs,
    );
    let mut out = format!(
        "Staking NEAR{}\n\n",
        if net == Network::Testnet {
            " (testnet)"
        } else {
            ""
        }
    );
    out += &match (&s.action, lang) {
        (NearStakeAction::Stake { amount }, Lang::Fr) => format!(
            "Opération : STAKER {} dans le pool {}\nPour les récupérer : un retrait du stake, puis {} epochs d'attente ({unlock}), puis un retrait.\n",
            n(amount), s.pool_id, c.unlock_epochs
        ),
        (NearStakeAction::Stake { amount }, Lang::En) => format!(
            "Operation: STAKE {} in pool {}\nTo get them back: unstake, wait {} epochs ({unlock}), then withdraw.\n",
            n(amount), s.pool_id, c.unlock_epochs
        ),
        (NearStakeAction::Unstake { amount }, Lang::Fr) => format!(
            "Opération : RETIRER DU STAKE {} du pool {}\nRetirable dans {} epochs ({unlock}). Plus de récompenses sur ce montant.\n",
            n(amount), s.pool_id, c.unlock_epochs
        ),
        (NearStakeAction::Unstake { amount }, Lang::En) => format!(
            "Operation: UNSTAKE {} from pool {}\nWithdrawable in {} epochs ({unlock}). No more rewards on this amount.\n",
            n(amount), s.pool_id, c.unlock_epochs
        ),
        (NearStakeAction::UnstakeAll, Lang::Fr) => format!(
            "Opération : TOUT RETIRER DU STAKE du pool {} ({})\nRetirable dans {} epochs ({unlock}).\n",
            s.pool_id, n(&c.position.staked), c.unlock_epochs
        ),
        (NearStakeAction::UnstakeAll, Lang::En) => format!(
            "Operation: UNSTAKE ALL from pool {} ({})\nWithdrawable in {} epochs ({unlock}).\n",
            s.pool_id, n(&c.position.staked), c.unlock_epochs
        ),
        (NearStakeAction::WithdrawAll, Lang::Fr) => format!(
            "Opération : RETIRER {} du pool {} vers ton compte\n",
            n(&c.position.unstaked), s.pool_id
        ),
        (NearStakeAction::WithdrawAll, Lang::En) => format!(
            "Operation: WITHDRAW {} from pool {} to your account\n",
            n(&c.position.unstaked), s.pool_id
        ),
    };
    if let Some(p) = c.position.fee_pct {
        out += &lang.pick(
            format!("Part gardée par le pool : {p:.1} %\n"),
            format!("Share kept by the pool: {p:.1}%\n"),
        );
    }
    out += &lang.pick(
        format!(
            "Code du pool vérifié (contrat standard).\nFrais : ≈ {} (au plus {})\n\nCompte : {}\nNonce {} · bloc {}\nHash : {}",
            n(&c.fee_estimate), n(&c.fee_bound), s.signer_id, s.nonce, s.block_hash, s.hash
        ),
        format!(
            "Pool code checked (standard contract).\nFee: ≈ {} (at most {})\n\nAccount: {}\nNonce {} · block {}\nHash: {}",
            n(&c.fee_estimate), n(&c.fee_bound), s.signer_id, s.nonce, s.block_hash, s.hash
        ),
    );
    out
}

pub(crate) fn describe_extra(lang: Lang, c: &NearStakeContext) -> String {
    let mut out = String::from(lang.pick(
        "Kyro a trouvé des points à vérifier :\n",
        "Kyro found some things to check:\n",
    ));
    for w in &c.warnings {
        out += &match (w, lang) {
            (NearStakeWarning::HighFee { pct }, Lang::Fr) => {
                format!("• le pool garde {pct:.0} % des récompenses\n")
            }
            (NearStakeWarning::HighFee { pct }, Lang::En) => {
                format!("• the pool keeps {pct:.0}% of the rewards\n")
            }
            (NearStakeWarning::NotValidating, _) => lang
                .pick(
                    "• ce pool ne valide pas en ce moment : pas de récompenses tant qu'il reste dehors\n",
                    "• this pool is not validating right now: no rewards while it stays out\n",
                )
                .to_owned(),
        };
    }
    out += lang.pick("\nContinuer quand même ?", "\nContinue anyway?");
    out
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NearStakeSigned {
    /// Signed transaction (Borsh, hex): what `near_stake_broadcast` sends.
    pub signed: String,
    pub hash: String,
    pub summary: NearStakeSummary,
    pub context: NearStakeContext,
}

/// Strict decoding for our account and key, fresh nonce and block, live pool facts.
pub(crate) async fn prepare_sign(
    c: &NearCtx<'_>,
    me: &str,
    pk: &[u8; 32],
    tx: &str,
) -> AppResult<(NearStakeSummary, NearStakeContext)> {
    let summary = wallet_core::near_stake_decode(tx, me, pk)?;
    let (key_nonce, _, height) = near_backend::access_key(c, me, pk).await?;
    if summary.nonce.parse::<u64>().unwrap_or(0) <= key_nonce {
        return Err(invalid(
            "stale nonce (another transaction went through in the meantime): rebuild it",
        ));
    }
    let built_at = near_backend::block_height(c, &summary.block_hash).await?;
    if height.saturating_sub(built_at) > MAX_BLOCK_AGE {
        return Err(invalid("staking transaction too old: rebuild it"));
    }
    let context = context_for(c, &summary).await?;
    Ok((summary, context))
}

#[tauri::command]
pub async fn near_stake_sign(
    app: AppHandle,
    state: State<'_, AppState>,
    tx: String,
    password: String,
    account: Option<u32>,
) -> AppResult<NearStakeSigned> {
    if !state.is_unlocked() {
        return Err(AppError::Locked);
    }
    let a = account_arg(account)?;
    let (me, pk) = ours(&state, a)?;
    let signer = SignerInfo::new(&state, Chain::Near, a, wallet_core::near_path(a));
    let (summary, context) = prepare_sign(&ctx(&state), &me, &pk, &tx).await?;
    let seed = seed_from_password(&state, Zeroizing::new(password)).await?;
    let lang = crate::i18n::current();
    confirm_native(
        &app,
        lang.pick(
            "Confirmer l'opération de staking NEAR",
            "Confirm the NEAR staking operation",
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
    let t = tx.clone();
    let (signed, hash, again) =
        blocking(move || Ok(wallet_core::near_stake_sign(&seed, a, &t)?)).await?;
    if again != summary {
        return Err(AppError::Internal(
            "summary differs between the preview and the signature".into(),
        ));
    }
    state.touch();
    Ok(NearStakeSigned {
        signed,
        hash,
        summary,
        context,
    })
}

#[tauri::command]
pub async fn near_stake_broadcast(
    state: State<'_, AppState>,
    signed: String,
    account: Option<u32>,
) -> AppResult<NearTxOutcome> {
    let (me, _) = ours(&state, account_arg(account)?)?;
    broadcast_checked(&ctx(&state), &me, &signed).await
}

pub(crate) async fn broadcast_checked(
    c: &NearCtx<'_>,
    me: &str,
    signed: &str,
) -> AppResult<NearTxOutcome> {
    let (tx, hash) = wallet_core::near_stake_verify_signed(signed)?;
    if tx.signer_id != me {
        return Err(invalid("this transaction is not signed by your account"));
    }
    let raw = hex::decode(signed.trim()).map_err(|_| invalid("hexadecimal expected"))?;
    near_backend::send(c, &raw, &hash).await
}

#[cfg(test)]
mod tests {
    use super::*;

    // Recorded from free.rpc.fastnear.com / api.fastnear.com on 2026-11-02 (trimmed).
    const VALIDATORS: &str = include_str!("testdata/near_stake_validators.json");
    const CONFIG: &str =
        r#"{"max_inflation_rate":[1,40],"protocol_reward_rate":[0,1],"epoch_length":43200}"#;
    const POOL_ACCOUNT: &str = r#"{"account_id":"epic.poolv1.near","unstaked_balance":"2000000000000000000000000","staked_balance":"10999999999999999999999999","can_withdraw":false}"#;
    const FEE: &str = r#"{"numerator":1,"denominator":100}"#;
    const POOLS: &str = r#"{"account_id":"x","pools":[{"pool_id":"epic.poolv1.near","last_update_block_height":222753710},{"pool_id":"lst-pool.near","last_update_block_height":1},{"pool_id":"kiln.pool.f863973.m0","last_update_block_height":2}]}"#;

    #[test]
    fn parses_recorded_answers() {
        let v: Value = serde_json::from_str(VALIDATORS).unwrap();
        let list = validators_from(&v, Network::Mainnet).unwrap();
        assert_eq!(list[0].pool_id, "astro-stakers.poolv1.near");
        assert!(list.iter().all(|w| w.stake.parse::<u128>().is_ok()));
        assert!(list.iter().any(|w| !w.supported));
        let total: u128 = list.iter().map(|w| w.stake.parse::<u128>().unwrap()).sum();
        let cfg: Value = serde_json::from_str(CONFIG).unwrap();
        let apy = gross_apy(&cfg, 1_310_653_150_613_045_978_025_954_791_777_993, total).unwrap();
        assert!(apy > 1.0 && apy < 20.0, "{apy}");
        assert_eq!(gross_apy(&cfg, 1, 0), None);

        let fee = fee_from(&serde_json::from_str(FEE).unwrap());
        assert_eq!(fee, Some(1.0));
        assert_eq!(fee_from(&json!({"numerator": 2, "denominator": 1})), None);
        let p = position_from(
            "epic.poolv1.near",
            &serde_json::from_str(POOL_ACCOUNT).unwrap(),
            fee,
        )
        .unwrap();
        assert_eq!(p.staked, "10999999999999999999999999");
        assert!(!p.can_withdraw);

        let pools: Value = serde_json::from_str(POOLS).unwrap();
        assert_eq!(
            pools_from(&pools, Network::Mainnet),
            vec!["epic.poolv1.near"]
        );
        assert_eq!(
            pools_from(&pools, Network::Testnet),
            vec!["kiln.pool.f863973.m0"]
        );
    }

    fn sample() -> (NearStakeSummary, NearStakeContext) {
        let s = NearStakeSummary {
            signer_id: "5510e2b44cae6eb807e3e0e45d579dda058c274abcba15e5cb84636f5d1ee412".into(),
            public_key: "ed25519:x".into(),
            nonce: "8".into(),
            pool_id: "epic.poolv1.near".into(),
            testnet: false,
            action: NearStakeAction::Stake {
                amount: "1000000000000000000000000".into(),
            },
            gas: "125000000000000".into(),
            attached: "1000000000000000000000000".into(),
            block_hash: "244ZQ9cgj3CQ6bWBdytfrJMuMQ1jdXLFGnr4HhvtCTnM".into(),
            hash: "h".into(),
        };
        let c = NearStakeContext {
            account: NearAccountInfo::default(),
            position: position_from(
                "epic.poolv1.near",
                &serde_json::from_str(POOL_ACCOUNT).unwrap(),
                Some(25.0),
            )
            .unwrap(),
            validating: false,
            epoch: NearEpoch {
                height: 100,
                start_height: 0,
                length: 43_200,
                block_secs: 0.6,
                seconds_left: 3600,
            },
            unlock_epochs: UNLOCK_EPOCHS,
            gas_price: "100000000".into(),
            fee_estimate: "3000000000000000000000".into(),
            fee_bound: "13000000000000000000000".into(),
            warnings: vec![
                NearStakeWarning::HighFee { pct: 25.0 },
                NearStakeWarning::NotValidating,
            ],
            requires_extra_confirmation: true,
        };
        (s, c)
    }

    #[test]
    fn dialog_texts() {
        let (s, c) = sample();
        for lang in [Lang::En, Lang::Fr] {
            let d = describe(lang, &s, &c, Network::Mainnet);
            assert!(d.contains("epic.poolv1.near"), "{d}");
            assert!(d.contains("1 NEAR"), "{d}");
            assert!(d.contains("4 epochs"), "{d}");
            let x = describe_extra(lang, &c);
            assert!(x.contains("25"), "{x}");
        }
    }
}
