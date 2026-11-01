//! TRON Stake 2.0 and voting (`tron_stake_*`, docs/IPC.md §2.8): `FreezeBalanceV2`
//! (BANDWIDTH / ENERGY), `UnfreezeBalanceV2`, `WithdrawExpireUnfreeze`, `CancelAllUnfreezeV2`,
//! `VoteWitness` and `WithdrawBalance` (voting rewards), owner = our address only. Lending
//! resources to another account (`DelegateResource`) is refused by wallet-core.
//!
//! Kyro builds `raw_data` itself from the latest block, like `tron_build_tx`; wallet-core decodes
//! it again (`tron_decode_stake_raw`) and signs it after the native dialog. Broadcast: the
//! existing `tron_broadcast` (signature must recover to our address, txid = sha256(raw_data)).
//! Reads: `getaccount`, `getaccountresource`, `getReward`, `getchainparameters`
//! (`getUnfreezeDelayDays`), `getnextmaintenancetime`, `listwitnesses`, `getBrokerage`.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, State};
use wallet_core::{
    Network, TronContract, TronRaw, TronResource, TronStakeAction, TronStakeSummary, TronVote,
    TRON_MAX_VOTES,
};
use zeroize::Zeroizing;

use crate::accounts::{account_arg, confirm_signer, Chain, SignerInfo};
use crate::commands::{
    blocking, confirm_native, format_units, format_units_in, seed_from_password,
};
use crate::commands_tron::ctx;
use crate::error::{AppError, AppResult};
use crate::i18n::Lang;
use crate::state::AppState;
use crate::tron_backend::{self, request, TronCtx, TronEstimate, EXPIRATION_MS};

/// java-tron `UNFREEZE_MAX_TIMES`: at most 32 unstakes waiting at the same time.
const MAX_PENDING_UNFREEZE: usize = 32;
/// Minimum stake (java-tron: `frozen_balance` ≥ 1 TRX).
const MIN_FREEZE: i64 = 1_000_000;
/// Voting rewards can be claimed once every 24 h.
const CLAIM_INTERVAL_MS: i64 = 24 * 3600 * 1000;
/// Super representatives produce blocks; the top 127 (SRs + partners) share vote rewards.
const SR_COUNT: usize = 27;
const PAID_RANKS: usize = 127;

fn invalid(m: impl Into<String>) -> AppError {
    AppError::InvalidInput(m.into())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

fn trx(sun: &str) -> String {
    format!("{} TRX", format_units(sun, 6))
}

fn u64_at(v: &Value, k: &str) -> u64 {
    v.get(k).and_then(Value::as_u64).unwrap_or(0)
}

fn resource_of(v: &Value) -> Option<TronResource> {
    match v["type"].as_str() {
        None | Some("BANDWIDTH") => Some(TronResource::Bandwidth),
        Some("ENERGY") => Some(TronResource::Energy),
        _ => None, // TRON_POWER (legacy), unknown
    }
}

fn resource_name(lang: Lang, r: TronResource) -> &'static str {
    match r {
        TronResource::Bandwidth => lang.pick("la BANDE PASSANTE", "BANDWIDTH"),
        TronResource::Energy => lang.pick("l'ÉNERGIE", "ENERGY"),
    }
}

// ---------------------------------------------------------------- reads

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TronUnfreezing {
    pub resource: TronResource,
    /// Sun.
    pub amount: String,
    /// Milliseconds since the epoch: withdrawable from then on.
    pub expire_time: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TronStakeAccount {
    pub address: String,
    /// Sun.
    pub balance: String,
    /// Sun staked for bandwidth / energy (Stake 2.0, kept by us; delegations not included).
    pub staked_bandwidth: String,
    pub staked_energy: String,
    /// Unstakes waiting for their delay, and those already withdrawable.
    pub unfreezing: Vec<TronUnfreezing>,
    /// Sum of the unstakes whose delay is over (sun): `withdrawUnfrozen` claims them.
    pub withdrawable_now: String,
    /// TRON Power (votes): 1 per staked TRX.
    pub tron_power_limit: u64,
    pub tron_power_used: u64,
    pub votes: Vec<TronVote>,
    /// Claimable voting rewards (sun).
    pub reward: String,
    /// When rewards can be claimed again (ms; 0 = now).
    pub next_claim_time: i64,
    pub unfreeze_delay_days: u64,
    /// Next vote count (ms): new votes take effect then.
    pub next_maintenance_time: i64,
    pub energy_limit: u64,
    pub energy_used: u64,
    pub bandwidth_limit: u64,
    pub bandwidth_used: u64,
}

pub(crate) async fn unfreeze_delay_days(c: &TronCtx<'_>) -> AppResult<u64> {
    let v = request(c, "/wallet/getchainparameters", Some(json!({}))).await?;
    v["chainParameter"]
        .as_array()
        .and_then(|l| l.iter().find(|p| p["key"] == "getUnfreezeDelayDays"))
        .and_then(|p| p["value"].as_u64())
        .filter(|d| *d > 0 && *d <= 365)
        .ok_or_else(|| AppError::ServerUnreachable("TRON: getUnfreezeDelayDays missing".into()))
}

pub(crate) async fn stake_account(c: &TronCtx<'_>, address: &str) -> AppResult<TronStakeAccount> {
    wallet_core::tron_address_bytes(address)?;
    let a = address.trim();
    let acc = request(
        c,
        "/wallet/getaccount",
        Some(json!({ "address": a, "visible": true })),
    )
    .await?;
    let res = request(
        c,
        "/wallet/getaccountresource",
        Some(json!({ "address": a, "visible": true })),
    )
    .await?;
    let reward = request(
        c,
        "/wallet/getReward",
        Some(json!({ "address": a, "visible": true })),
    )
    .await?;
    let maint = request(c, "/wallet/getnextmaintenancetime", Some(json!({}))).await?;
    let (mut bw, mut en) = (0u64, 0u64);
    for f in acc["frozenV2"].as_array().into_iter().flatten() {
        match resource_of(f) {
            Some(TronResource::Bandwidth) => bw += u64_at(f, "amount"),
            Some(TronResource::Energy) => en += u64_at(f, "amount"),
            None => {}
        }
    }
    let now = now_ms();
    let mut unfreezing = Vec::new();
    let mut ready = 0u64;
    for u in acc["unfrozenV2"].as_array().into_iter().flatten() {
        let Some(r) = resource_of(u) else { continue };
        let amount = u64_at(u, "unfreeze_amount");
        let expire = u["unfreeze_expire_time"].as_i64().unwrap_or(0);
        if expire <= now {
            ready += amount;
        }
        unfreezing.push(TronUnfreezing {
            resource: r,
            amount: amount.to_string(),
            expire_time: expire,
        });
    }
    let votes = acc["votes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| {
            Some(TronVote {
                address: address_of(v["vote_address"].as_str()?)?,
                count: v["vote_count"].as_u64()?.to_string(),
            })
        })
        .collect();
    let last_claim = acc["latest_withdraw_time"].as_i64().unwrap_or(0);
    let next_claim = if last_claim + CLAIM_INTERVAL_MS > now {
        last_claim + CLAIM_INTERVAL_MS
    } else {
        0
    };
    Ok(TronStakeAccount {
        address: a.to_owned(),
        balance: u64_at(&acc, "balance").to_string(),
        staked_bandwidth: bw.to_string(),
        staked_energy: en.to_string(),
        unfreezing,
        withdrawable_now: ready.to_string(),
        tron_power_limit: u64_at(&res, "tronPowerLimit"),
        tron_power_used: u64_at(&res, "tronPowerUsed"),
        votes,
        reward: u64_at(&reward, "reward").to_string(),
        next_claim_time: next_claim,
        unfreeze_delay_days: unfreeze_delay_days(c).await?,
        next_maintenance_time: maint["num"].as_i64().unwrap_or(0),
        energy_limit: u64_at(&res, "EnergyLimit"),
        energy_used: u64_at(&res, "EnergyUsed"),
        bandwidth_limit: u64_at(&res, "NetLimit"),
        bandwidth_used: u64_at(&res, "NetUsed"),
    })
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TronWitness {
    pub address: String,
    /// Declared by the SR, **not verified** (it is the only "name" TRON has).
    pub url: String,
    pub vote_count: u64,
    /// 1 = most voted.
    pub rank: usize,
    /// Rank ≤ 27: produces blocks.
    pub is_sr: bool,
    /// Rank ≤ 127: its voters share vote rewards.
    pub is_paid: bool,
    /// `isJobs` of java-tron: currently producing.
    pub producing: bool,
    /// Percent of the rewards the SR keeps (`getBrokerage`), when read.
    pub brokerage: Option<u64>,
}

/// `T…` form of an address java-tron returned as base58 or as 21-byte hex (`41…`): some
/// endpoints ignore `visible`.
fn address_of(s: &str) -> Option<String> {
    if wallet_core::tron_address_bytes(s).is_ok() {
        return Some(s.to_owned());
    }
    let b: [u8; 21] = hex::decode(s).ok()?.try_into().ok()?;
    (b[0] == wallet_core::TRON_ADDRESS_PREFIX).then(|| wallet_core::tron_address_from_bytes(&b))
}

pub(crate) async fn witnesses(c: &TronCtx<'_>) -> AppResult<Vec<TronWitness>> {
    let v = request(c, "/wallet/listwitnesses", Some(json!({ "visible": true }))).await?;
    let mut list: Vec<TronWitness> = v["witnesses"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|w| {
            let address = address_of(w["address"].as_str()?)?;
            Some(TronWitness {
                address,
                url: w["url"]
                    .as_str()
                    .unwrap_or("")
                    .chars()
                    .filter(|c| !c.is_control())
                    .take(128)
                    .collect(),
                vote_count: u64_at(w, "voteCount"),
                rank: 0,
                is_sr: false,
                is_paid: false,
                producing: w["isJobs"] == true,
                brokerage: None,
            })
        })
        .collect();
    list.sort_by_key(|w| std::cmp::Reverse(w.vote_count));
    for (i, w) in list.iter_mut().enumerate() {
        w.rank = i + 1;
        w.is_sr = w.rank <= SR_COUNT;
        w.is_paid = w.rank <= PAID_RANKS;
    }
    Ok(list)
}

async fn brokerage(c: &TronCtx<'_>, sr: &str) -> AppResult<u64> {
    let v = request(
        c,
        "/wallet/getBrokerage",
        Some(json!({ "address": sr, "visible": true })),
    )
    .await?;
    v["brokerage"]
        .as_u64()
        .filter(|b| *b <= 100)
        .ok_or_else(|| AppError::ServerUnreachable("TRON: invalid getBrokerage".into()))
}

fn our_address(state: &AppState, account: Option<u32>) -> AppResult<String> {
    crate::commands_tron::our_address(state, account_arg(account)?)
}

#[tauri::command]
pub async fn tron_stake_overview(
    state: State<'_, AppState>,
    account: Option<u32>,
) -> AppResult<TronStakeAccount> {
    let me = our_address(&state, account)?;
    stake_account(&ctx(&state), &me).await
}

#[tauri::command]
pub async fn tron_stake_witnesses(state: State<'_, AppState>) -> AppResult<Vec<TronWitness>> {
    witnesses(&ctx(&state)).await
}

// ---------------------------------------------------------------- build

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoteInput {
    pub address: String,
    /// Votes (TRON Power, whole TRX), decimal string.
    pub count: String,
}

/// What the UI asks Kyro to build. Amounts in sun.
#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TronStakeRequest {
    Freeze {
        resource: TronResource,
        amount: String,
    },
    Unfreeze {
        resource: TronResource,
        amount: String,
    },
    WithdrawUnfrozen,
    CancelAllUnfreeze,
    /// Replaces ALL current votes.
    Vote {
        votes: Vec<VoteInput>,
    },
    ClaimRewards,
}

fn sun(s: &str) -> AppResult<i64> {
    s.trim()
        .parse::<i64>()
        .ok()
        .filter(|v| *v > 0)
        .ok_or_else(|| invalid("invalid amount in sun"))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TronStakeWarning {
    /// Ranked beyond 127: its voters get no vote rewards.
    SrNotPaid { address: String, rank: usize },
    /// The SR keeps 100 % of the rewards.
    BrokerageAll { address: String },
    /// After this unstake the TRON Power no longer covers the votes: java-tron reduces them.
    VotesReduced,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TronStakeContext {
    /// State before the transaction.
    pub account: TronStakeAccount,
    /// Bandwidth needed / available / TRX burned (staking contracts burn no energy).
    pub estimate: TronEstimate,
    /// Details of the SRs voted for (vote only).
    pub witnesses: Vec<TronWitness>,
    pub warnings: Vec<TronStakeWarning>,
    pub requires_extra_confirmation: bool,
}

/// Live checks and the dialog's context for a decoded staking transaction (build and sign).
pub(crate) async fn context_for(
    c: &TronCtx<'_>,
    s: &TronStakeSummary,
) -> AppResult<TronStakeContext> {
    let acc = stake_account(c, &s.owner).await?;
    let p = tron_backend::params(c).await?;
    let raw_acc = tron_backend::account(c, &s.owner).await?;
    if !raw_acc.exists {
        return Err(invalid(
            "TRON account not activated: receive some TRX first",
        ));
    }
    let estimate = tron_backend::estimate(&tron_backend::EstimateInput {
        account: &raw_acc,
        params: p,
        raw_size: s.raw_size,
        recipient_exists: true,
        is_trx: false,
        energy_needed: 0,
        fee_limit: 0,
    });
    let burn: u64 = estimate.bandwidth_burn.parse().unwrap_or(0);
    let balance: u64 = acc.balance.parse().unwrap_or(0);
    let mut warnings = Vec::new();
    let mut voted = Vec::new();
    let n = |x: &str| x.parse::<u64>().unwrap_or(0);
    match &s.action {
        TronStakeAction::Freeze { amount, .. } => {
            let a = n(amount);
            if (a as i64) < MIN_FREEZE {
                return Err(invalid("minimum stake: 1 TRX"));
            }
            if a.saturating_add(burn) > balance {
                return Err(invalid(format!(
                    "insufficient balance: {} available",
                    trx(&acc.balance)
                )));
            }
        }
        TronStakeAction::Unfreeze { resource, amount } => {
            let staked = n(match resource {
                TronResource::Bandwidth => &acc.staked_bandwidth,
                TronResource::Energy => &acc.staked_energy,
            });
            if n(amount) > staked {
                return Err(invalid(format!(
                    "only {} staked for this resource",
                    trx(&staked.to_string())
                )));
            }
            let pending = acc
                .unfreezing
                .iter()
                .filter(|u| u.expire_time > now_ms())
                .count();
            if pending >= MAX_PENDING_UNFREEZE {
                return Err(invalid(
                    "32 unfreezes already pending: wait until one of them completes its delay",
                ));
            }
            let power_after = acc.tron_power_limit.saturating_sub(n(amount) / 1_000_000);
            if power_after < acc.tron_power_used {
                warnings.push(TronStakeWarning::VotesReduced);
            }
        }
        TronStakeAction::WithdrawUnfrozen => {
            if acc.withdrawable_now == "0" {
                return Err(invalid(
                    "nothing to withdraw: no unfreeze has finished its delay",
                ));
            }
        }
        TronStakeAction::CancelAllUnfreeze => {
            if acc.unfreezing.is_empty() {
                return Err(invalid("no pending unfreeze"));
            }
        }
        TronStakeAction::ClaimRewards => {
            if acc.reward == "0" {
                return Err(invalid("no voting rewards to claim"));
            }
            if acc.next_claim_time > now_ms() {
                return Err(invalid("one claim per 24 h: try again later"));
            }
        }
        TronStakeAction::Vote { votes, total } => {
            if n(total) > acc.tron_power_limit {
                return Err(invalid(format!(
                    "{total} votes requested, TRON Power available: {} (1 vote = 1 staked TRX)",
                    acc.tron_power_limit
                )));
            }
            let all = witnesses(c).await?;
            for v in votes {
                let mut w = all
                    .iter()
                    .find(|w| w.address == v.address)
                    .cloned()
                    .ok_or_else(|| {
                        invalid(format!(
                            "{} is not an SR candidate (listwitnesses): refused",
                            v.address
                        ))
                    })?;
                let b = brokerage(c, &w.address).await?;
                w.brokerage = Some(b);
                if !w.is_paid {
                    warnings.push(TronStakeWarning::SrNotPaid {
                        address: w.address.clone(),
                        rank: w.rank,
                    });
                }
                if b >= 100 {
                    warnings.push(TronStakeWarning::BrokerageAll {
                        address: w.address.clone(),
                    });
                }
                voted.push(w);
            }
        }
    }
    if burn > balance {
        return Err(invalid("insufficient balance for the bandwidth"));
    }
    Ok(TronStakeContext {
        account: acc,
        estimate,
        witnesses: voted,
        requires_extra_confirmation: !warnings.is_empty(),
        warnings,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TronStakeBuilt {
    /// `raw_data`, hex: what `tron_stake_sign` signs.
    pub raw: String,
    pub txid: String,
    pub summary: TronStakeSummary,
    pub context: TronStakeContext,
}

pub(crate) fn contract_for(owner: [u8; 21], r: &TronStakeRequest) -> AppResult<TronContract> {
    Ok(match r {
        TronStakeRequest::Freeze { resource, amount } => TronContract::FreezeV2 {
            owner,
            amount: sun(amount)?,
            resource: *resource,
        },
        TronStakeRequest::Unfreeze { resource, amount } => TronContract::UnfreezeV2 {
            owner,
            amount: sun(amount)?,
            resource: *resource,
        },
        TronStakeRequest::WithdrawUnfrozen => TronContract::WithdrawExpireUnfreeze { owner },
        TronStakeRequest::CancelAllUnfreeze => TronContract::CancelAllUnfreezeV2 { owner },
        TronStakeRequest::ClaimRewards => TronContract::WithdrawBalance { owner },
        TronStakeRequest::Vote { votes } => {
            if votes.is_empty() || votes.len() > TRON_MAX_VOTES {
                return Err(invalid(format!("1 to {TRON_MAX_VOTES} SRs per vote")));
            }
            TronContract::VoteWitness {
                owner,
                votes: votes
                    .iter()
                    .map(|v| {
                        Ok((
                            wallet_core::tron_address_bytes(&v.address)?,
                            v.count
                                .trim()
                                .parse::<i64>()
                                .ok()
                                .filter(|c| *c > 0)
                                .ok_or_else(|| invalid("invalid number of votes"))?,
                        ))
                    })
                    .collect::<AppResult<Vec<_>>>()?,
            }
        }
    })
}

pub(crate) async fn build(
    c: &TronCtx<'_>,
    owner: &str,
    r: &TronStakeRequest,
) -> AppResult<TronStakeBuilt> {
    let owner_b = wallet_core::tron_address_bytes(owner)?;
    let (number, id, ts) = tron_backend::now_block(c).await?;
    let (ref_block_bytes, ref_block_hash) = wallet_core::tron_ref_block(number, &id)?;
    let raw = TronRaw {
        ref_block_bytes,
        ref_block_hash,
        expiration: ts + EXPIRATION_MS,
        memo: Vec::new(),
        contract: contract_for(owner_b, r)?,
        timestamp: ts,
        fee_limit: 0,
    };
    let raw_hex = hex::encode(raw.encode());
    let summary = wallet_core::tron_decode_stake_raw(&raw_hex, owner)?;
    let context = context_for(c, &summary).await?;
    Ok(TronStakeBuilt {
        txid: summary.txid.clone(),
        raw: raw_hex,
        summary,
        context,
    })
}

#[tauri::command]
pub async fn tron_stake_build(
    state: State<'_, AppState>,
    action: TronStakeRequest,
    account: Option<u32>,
) -> AppResult<TronStakeBuilt> {
    let me = our_address(&state, account)?;
    build(&ctx(&state), &me, &action).await
}

// ---------------------------------------------------------------- dialog

fn net_label(net: Network) -> &'static str {
    match net {
        Network::Mainnet => "TRON",
        Network::Testnet => "TRON Nile (testnet)",
    }
}

fn days(lang: Lang, d: u64) -> String {
    match (d, lang) {
        (1, Lang::Fr) => "1 jour".into(),
        (1, Lang::En) => "1 day".into(),
        (d, Lang::Fr) => format!("{d} jours"),
        (d, Lang::En) => format!("{d} days"),
    }
}

fn trx_in(lang: Lang, sun: &str) -> String {
    format!("{} TRX", format_units_in(lang, sun, 6))
}

/// Body of the native dialog, from Rust's decoding and live data only.
pub(crate) fn describe(
    lang: Lang,
    s: &TronStakeSummary,
    c: &TronStakeContext,
    net: Network,
    now: i64,
) -> String {
    let trx = |sun: &str| trx_in(lang, sun);
    let fr = lang == Lang::Fr;
    let a = &c.account;
    let mut out = format!("Staking {} (Stake 2.0)\n\n", net_label(net));
    match &s.action {
        TronStakeAction::Freeze { resource, amount } => {
            let power = amount.parse::<u64>().unwrap_or(0) / 1_000_000;
            out += &if fr {
                format!(
                    "Opération : STAKER {} pour {}\n→ +{power} TRON Power (droit de vote)\nPour récupérer ces TRX : un dégel, puis {} d'attente (paramètre du réseau), puis un retrait.\n",
                    trx(amount),
                    resource_name(lang, *resource),
                    days(lang, a.unfreeze_delay_days)
                )
            } else {
                format!(
                    "Operation: STAKE {} for {}\n→ +{power} TRON Power (voting right)\nTo get these TRX back: an unfreeze, then {} of waiting (network parameter), then a withdrawal.\n",
                    trx(amount),
                    resource_name(lang, *resource),
                    days(lang, a.unfreeze_delay_days)
                )
            };
        }
        TronStakeAction::Unfreeze { resource, amount } => {
            out += &if fr {
                format!(
                    "Opération : DÉGELER {} de {}\nCes TRX seront retirables dans {} (paramètre du réseau), puis il faudra « Retirer ». Pendant ce délai ils ne donnent ni ressource ni vote.\n",
                    trx(amount),
                    resource_name(lang, *resource),
                    days(lang, a.unfreeze_delay_days)
                )
            } else {
                format!(
                    "Operation: UNFREEZE {} of {}\nThese TRX can be withdrawn in {} (network parameter), then you will have to “Withdraw” them. Meanwhile they give neither resources nor votes.\n",
                    trx(amount),
                    resource_name(lang, *resource),
                    days(lang, a.unfreeze_delay_days)
                )
            };
            if c.warnings.contains(&TronStakeWarning::VotesReduced) {
                out += lang.pick(
                    "⚠ Ton TRON Power ne couvrira plus tes votes : le réseau les réduira.\n",
                    "⚠ Your TRON Power will no longer cover your votes: the network will reduce them.\n",
                );
            }
        }
        TronStakeAction::WithdrawUnfrozen => {
            out += &format!(
                "{}{}\n",
                lang.pick(
                    "Opération : RETIRER les TRX dégelés dont le délai est fini : ",
                    "Operation: WITHDRAW the unfrozen TRX whose delay is over: "
                ),
                trx(&a.withdrawable_now)
            );
        }
        TronStakeAction::CancelAllUnfreeze => {
            out += &if fr {
                format!(
                    "Opération : ANNULER tous les dégels en cours ({}) : ces TRX sont re-stakés ; ceux dont le délai est fini ({}) sont retirés vers ton solde.\n",
                    a.unfreezing.len(),
                    trx(&a.withdrawable_now)
                )
            } else {
                format!(
                    "Operation: CANCEL all pending unfreezes ({}): these TRX are staked again; those whose delay is over ({}) are withdrawn to your balance.\n",
                    a.unfreezing.len(),
                    trx(&a.withdrawable_now)
                )
            };
        }
        TronStakeAction::Vote { votes, total } => {
            out += &if fr {
                format!(
                    "Opération : VOTER (remplace TOUS tes votes actuels) — {total} votes sur {} de TRON Power\n",
                    a.tron_power_limit
                )
            } else {
                format!(
                    "Operation: VOTE (replaces ALL your current votes) — {total} votes out of {} TRON Power\n",
                    a.tron_power_limit
                )
            };
            for v in votes {
                let w = c.witnesses.iter().find(|w| w.address == v.address);
                let info = w
                    .map(|w| {
                        let url = if w.url.is_empty() {
                            lang.pick("aucune", "none").to_owned()
                        } else {
                            crate::dialog_text::field(&w.url, 80)
                        };
                        let kind = if w.is_sr {
                            " (SR)"
                        } else if w.is_paid {
                            lang.pick(" (partenaire)", " (partner)")
                        } else {
                            lang.pick(
                                " (hors des 127 : aucune récompense)",
                                " (outside the top 127: no rewards)",
                            )
                        };
                        let brokerage = w
                            .brokerage
                            .map(|b| b.to_string())
                            .unwrap_or_else(|| "?".into());
                        match lang {
                            Lang::Fr => format!(
                                "url déclarée : {url} · rang {}{kind} · garde {brokerage} % des récompenses",
                                w.rank
                            ),
                            Lang::En => format!(
                                "declared url: {url} · rank {}{kind} · keeps {brokerage}% of the rewards",
                                w.rank
                            ),
                        }
                    })
                    .unwrap_or_default();
                out += &format!(
                    "  • {} {} {}\n    {info}\n",
                    v.count,
                    lang.pick("votes pour", "votes for"),
                    v.address
                );
            }
            if !a.votes.is_empty() {
                out += &format!(
                    "{}{}\n",
                    lang.pick("Votes actuels remplacés : ", "Current votes replaced: "),
                    a.votes.len()
                );
            }
            out += lang.pick(
                "Les votes comptent à partir du prochain décompte (toutes les 6 h).\n",
                "Votes count from the next tally (every 6 h).\n",
            );
        }
        TronStakeAction::ClaimRewards => {
            out += &format!(
                "{}{}\n",
                lang.pick(
                    "Opération : RÉCLAMER les récompenses de vote : ",
                    "Operation: CLAIM the voting rewards: "
                ),
                trx(&a.reward)
            );
        }
    }
    let e = &c.estimate;
    out += &if fr {
        format!(
            "\nBande passante : {} octets nécessaires · disponible {} gratuite + {} stakée → {} brûlés\nAucune énergie consommée. Solde : {}\n",
            e.bandwidth_needed,
            e.free_bandwidth,
            e.staked_bandwidth,
            trx(&e.bandwidth_burn),
            trx(&a.balance)
        )
    } else {
        format!(
            "\nBandwidth: {} bytes needed · available {} free + {} staked → {} burned\nNo energy consumed. Balance: {}\n",
            e.bandwidth_needed,
            e.free_bandwidth,
            e.staked_bandwidth,
            trx(&e.bandwidth_burn),
            trx(&a.balance)
        )
    };
    out += lang.pick(
        "Pas de slashing sur TRON : un SR défaillant fait perdre des récompenses, pas les TRX stakés.\n",
        "No slashing on TRON: a failing SR loses you rewards, not the staked TRX.\n",
    );
    let mins = (s.expiration - now).max(0) / 60_000;
    out += &if fr {
        format!(
            "\nExpire dans {mins} min · bloc de référence {}/{}\nID : {}",
            s.ref_block_bytes, s.ref_block_hash, s.txid
        )
    } else {
        format!(
            "\nExpires in {mins} min · reference block {}/{}\nID: {}",
            s.ref_block_bytes, s.ref_block_hash, s.txid
        )
    };
    out
}

pub(crate) fn describe_extra(lang: Lang, c: &TronStakeContext) -> String {
    let mut out = String::from(lang.pick(
        "Kyro a trouvé des points à vérifier :\n",
        "Kyro found some things to check:\n",
    ));
    for w in &c.warnings {
        out += &match (w, lang) {
            (TronStakeWarning::SrNotPaid { address, rank }, Lang::Fr) => format!(
                "• {address} est classé {rank}e : hors des 127 premiers, ses électeurs ne reçoivent aucune récompense\n"
            ),
            (TronStakeWarning::SrNotPaid { address, rank }, Lang::En) => format!(
                "• {address} is ranked #{rank}: outside the top 127, its voters receive no rewards\n"
            ),
            (TronStakeWarning::BrokerageAll { address }, Lang::Fr) => format!(
                "• {address} garde 100 % des récompenses : tu ne recevrais RIEN\n"
            ),
            (TronStakeWarning::BrokerageAll { address }, Lang::En) => format!(
                "• {address} keeps 100% of the rewards: you would receive NOTHING\n"
            ),
            (TronStakeWarning::VotesReduced, _) => lang
                .pick(
                    "• après ce dégel, ton TRON Power ne couvre plus tes votes : ils seront réduits\n",
                    "• after this unfreeze, your TRON Power no longer covers your votes: they will be reduced\n",
                )
                .to_owned(),
        };
    }
    out += lang.pick("\nContinuer quand même ?", "\nContinue anyway?");
    out
}

// ---------------------------------------------------------------- sign

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TronStakeSigned {
    /// 65 bytes `r || s || v`, hex: give it to `tron_broadcast` with `raw`.
    pub signature: String,
    pub txid: String,
    pub summary: TronStakeSummary,
    pub context: TronStakeContext,
}

#[tauri::command]
pub async fn tron_stake_sign(
    app: AppHandle,
    state: State<'_, AppState>,
    raw: String,
    password: String,
    account: Option<u32>,
) -> AppResult<TronStakeSigned> {
    if !state.is_unlocked() {
        return Err(AppError::Locked);
    }
    let a = account_arg(account)?;
    let me = our_address(&state, Some(a))?;
    let signer = SignerInfo::new(&state, Chain::Tron, a, wallet_core::tron_path(a));
    let summary = wallet_core::tron_decode_stake_raw(&raw, &me)?;
    tron_backend::check_expiration_ms(summary.expiration, now_ms())?;
    let c = ctx(&state);
    let context = context_for(&c, &summary).await?;
    let seed = seed_from_password(&state, Zeroizing::new(password)).await?;
    let lang = crate::i18n::current();
    confirm_native(
        &app,
        lang.pick(
            "Confirmer l'opération de staking TRON",
            "Confirm the TRON staking operation",
        ),
        signer.body(
            lang,
            &describe(lang, &summary, &context, state.network, now_ms()),
        ),
    )
    .await?;
    confirm_signer(&app, &signer).await?;
    if context.requires_extra_confirmation {
        confirm_native(
            &app,
            lang.pick(
                "Attention : vote ou dégel à vérifier",
                "Warning: vote or unfreeze to check",
            ),
            describe_extra(lang, &context),
        )
        .await?;
    }
    let r = raw.clone();
    let (sig, again) = blocking(move || Ok(wallet_core::tron_stake_sign(&seed, a, &r)?)).await?;
    if again != summary {
        return Err(AppError::Internal(
            "summary differs between the preview and the signature".into(),
        ));
    }
    state.touch();
    Ok(TronStakeSigned {
        signature: hex::encode(sig),
        txid: summary.txid.clone(),
        summary,
        context,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account() -> TronStakeAccount {
        TronStakeAccount {
            address: "TY72iA3SBtrds3QLYsS7LwYfkzXwAXCRWT".into(),
            balance: "146620800".into(),
            staked_bandwidth: "0".into(),
            staked_energy: "10000000".into(),
            unfreezing: vec![],
            withdrawable_now: "0".into(),
            tron_power_limit: 10,
            tron_power_used: 10,
            votes: vec![TronVote {
                address: "TJmka325yjJKeFpQDwKSQAoNwEyNGhsaEV".into(),
                count: "10".into(),
            }],
            reward: "0".into(),
            next_claim_time: 0,
            unfreeze_delay_days: 14,
            next_maintenance_time: 0,
            energy_limit: 0,
            energy_used: 0,
            bandwidth_limit: 0,
            bandwidth_used: 0,
        }
    }

    fn estimate() -> TronEstimate {
        TronEstimate {
            bandwidth_needed: 270,
            free_bandwidth: 292,
            staked_bandwidth: 0,
            bandwidth_burn: "0".into(),
            activation_fee: "0".into(),
            recipient_exists: true,
            energy_needed: 0,
            energy_available: 0,
            energy_fee: 100,
            energy_burn: "0".into(),
            fee_limit: "0".into(),
            total_burn: "0".into(),
            total_burn_max: "0".into(),
            balance: "146620800".into(),
        }
    }

    fn summary(action: TronStakeAction) -> TronStakeSummary {
        TronStakeSummary {
            txid: "ab".repeat(32),
            owner: "TY72iA3SBtrds3QLYsS7LwYfkzXwAXCRWT".into(),
            action,
            expiration: 600_000,
            timestamp: 0,
            ref_block_bytes: "7e0b".into(),
            ref_block_hash: "ed0f599cb230d512".into(),
            raw_size: 90,
        }
    }

    #[test]
    fn dialog_texts() {
        let c = TronStakeContext {
            account: account(),
            estimate: estimate(),
            witnesses: vec![],
            warnings: vec![TronStakeWarning::VotesReduced],
            requires_extra_confirmation: true,
        };
        let d = describe(
            Lang::Fr,
            &summary(TronStakeAction::Unfreeze {
                resource: TronResource::Energy,
                amount: "5000000".into(),
            }),
            &c,
            Network::Mainnet,
            0,
        );
        for needle in [
            "Staking TRON (Stake 2.0)",
            "DÉGELER 5 TRX de l'ÉNERGIE",
            "retirables dans 14 jours",
            "le réseau les réduira",
            "270 octets nécessaires",
            "Pas de slashing",
            "Expire dans 10 min",
        ] {
            assert!(d.contains(needle), "{needle} missing in:\n{d}");
        }
        assert!(describe_extra(Lang::Fr, &c).contains("ils seront réduits"));
        let en = describe(
            Lang::En,
            &summary(TronStakeAction::Unfreeze {
                resource: TronResource::Energy,
                amount: "5000000".into(),
            }),
            &c,
            Network::Mainnet,
            0,
        );
        for needle in [
            "Operation: UNFREEZE 5 TRX of ENERGY",
            "can be withdrawn in 14 days",
            "the network will reduce them",
            "270 bytes needed",
            "No slashing",
            "Expires in 10 min",
        ] {
            assert!(en.contains(needle), "{needle} missing in:\n{en}");
        }
        assert!(describe_extra(Lang::En, &c).contains("they will be reduced"));
        for fr in ["Opération", "Solde", "DÉGELER", "jours"] {
            assert!(!en.contains(fr), "{fr}");
        }
        let mut c = c;
        c.witnesses = vec![TronWitness {
            address: "TJmka325yjJKeFpQDwKSQAoNwEyNGhsaEV".into(),
            url: "http://sr-8.com".into(),
            vote_count: 5,
            rank: 200,
            is_sr: false,
            is_paid: false,
            producing: false,
            brokerage: Some(100),
        }];
        c.warnings = vec![
            TronStakeWarning::SrNotPaid {
                address: "TJmka325yjJKeFpQDwKSQAoNwEyNGhsaEV".into(),
                rank: 200,
            },
            TronStakeWarning::BrokerageAll {
                address: "TJmka325yjJKeFpQDwKSQAoNwEyNGhsaEV".into(),
            },
        ];
        let d = describe(
            Lang::Fr,
            &summary(TronStakeAction::Vote {
                votes: vec![TronVote {
                    address: "TJmka325yjJKeFpQDwKSQAoNwEyNGhsaEV".into(),
                    count: "10".into(),
                }],
                total: "10".into(),
            }),
            &c,
            Network::Testnet,
            0,
        );
        for needle in [
            "TRON Nile (testnet)",
            "remplace TOUS tes votes actuels",
            "10 votes pour TJmka325",
            "url déclarée : « http://sr-8.com » · rang 200 (hors des 127 : aucune récompense) · garde 100 %",
            "Votes actuels remplacés : 1",
        ] {
            assert!(d.contains(needle), "{needle} missing in:\n{d}");
        }
        let x = describe_extra(Lang::Fr, &c);
        assert!(x.contains("200e") && x.contains("tu ne recevrais RIEN"));
        let x = describe_extra(Lang::En, &c);
        assert!(x.contains("ranked #200") && x.contains("you would receive NOTHING"));
    }

    #[test]
    fn requests_become_exact_contracts() {
        let owner = wallet_core::tron_address_bytes("TY72iA3SBtrds3QLYsS7LwYfkzXwAXCRWT").unwrap();
        assert_eq!(
            contract_for(
                owner,
                &TronStakeRequest::Freeze {
                    resource: TronResource::Energy,
                    amount: "10000000".into()
                }
            )
            .unwrap(),
            TronContract::FreezeV2 {
                owner,
                amount: 10_000_000,
                resource: TronResource::Energy
            }
        );
        for bad in ["0", "-1", "abc", ""] {
            assert!(contract_for(
                owner,
                &TronStakeRequest::Unfreeze {
                    resource: TronResource::Bandwidth,
                    amount: bad.into()
                }
            )
            .is_err());
        }
        assert!(contract_for(owner, &TronStakeRequest::Vote { votes: vec![] }).is_err());
        assert!(contract_for(
            owner,
            &TronStakeRequest::Vote {
                votes: vec![VoteInput {
                    address: "TJmka325yjJKeFpQDwKSQAoNwEyNGhsaEV".into(),
                    count: "0".into()
                }]
            }
        )
        .is_err());
        // The request JSON the UI sends.
        let r: TronStakeRequest =
            serde_json::from_str(r#"{"kind":"freeze","resource":"BANDWIDTH","amount":"1000000"}"#)
                .unwrap();
        assert!(matches!(
            r,
            TronStakeRequest::Freeze {
                resource: TronResource::Bandwidth,
                ..
            }
        ));
        let r: TronStakeRequest = serde_json::from_str(r#"{"kind":"claimRewards"}"#).unwrap();
        assert!(matches!(r, TronStakeRequest::ClaimRewards));
    }
}

/// Real Nile staking through the Rust path of `tron_stake_*`, over Tor, from the public Trezor
/// test wallet (`all × 12`, `TY72iA3S…`). Always: java-tron's own `freezebalancev2`,
/// `unfreezebalancev2`, `votewitnessaccount`, `cancelallunfreezev2`, `withdrawexpireunfreeze` and
/// `withdrawbalance` (unsigned, never used to sign) compared with Kyro's encoding byte for byte.
/// With `KYRO_TRON_STAKE=yes`: freeze 10 TRX for ENERGY, vote 10 for the top SR, unfreeze 5,
/// cancel all unfreezes, unfreeze 10 (they come back after the delay: 1 day on Nile).
/// `KYRO_TRON_STAKE=yes cargo test -p kyro-desktop --lib -- --ignored --nocapture tron_stake_live`
#[cfg(test)]
mod live {
    use super::*;
    use crate::net::NetClient;
    use crate::servers::TronServer;
    use crate::tor::TorState;

    const ALL: &str = "all all all all all all all all all all all all";

    /// java-tron's unsigned transaction for `path` vs Kyro's with the same block fields.
    async fn compare(c: &TronCtx<'_>, path: &str, body: Value, contract: TronContract) {
        let server = match request(c, path, Some(body)).await {
            Ok(v) if v.get("raw_data_hex").is_some() => v,
            other => {
                eprintln!("{path}: no transaction from java-tron ({other:?}): not compared");
                return;
            }
        };
        let rd = &server["raw_data"];
        let ours = TronRaw {
            ref_block_bytes: hex::decode(rd["ref_block_bytes"].as_str().unwrap())
                .unwrap()
                .try_into()
                .unwrap(),
            ref_block_hash: hex::decode(rd["ref_block_hash"].as_str().unwrap())
                .unwrap()
                .try_into()
                .unwrap(),
            expiration: rd["expiration"].as_i64().unwrap(),
            memo: Vec::new(),
            contract,
            timestamp: rd["timestamp"].as_i64().unwrap_or(0),
            fee_limit: 0,
        };
        assert_eq!(
            hex::encode(ours.encode()),
            server["raw_data_hex"].as_str().unwrap(),
            "{path}: Kyro encoding vs java-tron"
        );
        eprintln!("{path}: identical to java-tron byte for byte");
    }

    async fn send(
        c: &TronCtx<'_>,
        seed: &wallet_core::Seed,
        me: &str,
        r: &TronStakeRequest,
        label: &str,
    ) -> String {
        let built = build(c, me, r).await.unwrap();
        let summary = wallet_core::tron_decode_stake_raw(&built.raw, me).unwrap();
        assert_eq!(summary, built.summary);
        tron_backend::check_expiration_ms(summary.expiration, now_ms()).unwrap();
        let ctx2 = context_for(c, &summary).await.unwrap();
        eprintln!(
            "--- {label}: dialog ---\n{}\n---",
            describe(Lang::Fr, &summary, &ctx2, Network::Testnet, now_ms())
        );
        if ctx2.requires_extra_confirmation {
            eprintln!(
                "--- {label}: reinforced ---\n{}\n---",
                describe_extra(Lang::Fr, &ctx2)
            );
        }
        let (sig, again) = wallet_core::tron_stake_sign(seed, 0, &built.raw).unwrap();
        assert_eq!(again, summary);
        if std::env::var("KYRO_TRON_STAKE").as_deref() != Ok("yes") {
            eprintln!("{label}: KYRO_TRON_STAKE != yes, not broadcast");
            return String::new();
        }
        let txid = crate::commands_tron::broadcast_checked(c, me, &built.raw, &hex::encode(sig))
            .await
            .unwrap();
        for _ in 0..30 {
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            let info = request(
                c,
                "/wallet/gettransactioninfobyid",
                Some(json!({ "value": txid })),
            )
            .await
            .unwrap();
            if info.get("blockNumber").is_some() {
                let tx = request(
                    c,
                    "/wallet/gettransactionbyid",
                    Some(json!({ "value": txid })),
                )
                .await
                .unwrap();
                assert_eq!(tx["ret"][0]["contractRet"], "SUCCESS", "{label}: {tx}");
                eprintln!(
                    "{label}: CONFIRMED {txid} in block {} (fee {} sun)",
                    info["blockNumber"], info["fee"]
                );
                return txid;
            }
        }
        panic!("{label}: {txid} not confirmed");
    }

    #[test]
    #[ignore]
    fn tron_stake_live_nile() {
        let net = NetClient::new(std::env::temp_dir().join("kyro-tron-stake-live")).unwrap();
        let seed = wallet_core::Mnemonic::parse(ALL).unwrap().to_seed("");
        let me = wallet_core::tron_address(&seed, 0).unwrap();
        tauri::async_runtime::block_on(async {
            net.tor.restart();
            while net.tor.status().state != TorState::Ready {
                assert_ne!(net.tor.status().state, TorState::Error);
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            }
            let c = TronCtx {
                net_client: &net,
                network: Network::Testnet,
                tor: true,
                server: TronServer::Default,
                api_key: std::env::var("KYRO_TRONGRID_API_KEY").ok(),
            };
            let owner = wallet_core::tron_address_bytes(&me).unwrap();
            let acc = stake_account(&c, &me).await.unwrap();
            eprintln!("account {acc:#?}");
            let ws = witnesses(&c).await.unwrap();
            let top = ws[0].clone();
            eprintln!("{} SR candidates; top {top:?}", ws.len());
            let sr = wallet_core::tron_address_bytes(&top.address).unwrap();
            compare(
                &c,
                "/wallet/freezebalancev2",
                json!({ "owner_address": me, "frozen_balance": 10_000_000, "resource": "ENERGY", "visible": true }),
                TronContract::FreezeV2 {
                    owner,
                    amount: 10_000_000,
                    resource: TronResource::Energy,
                },
            )
            .await;
            compare(
                &c,
                "/wallet/freezebalancev2",
                json!({ "owner_address": me, "frozen_balance": 2_000_000, "resource": "BANDWIDTH", "visible": true }),
                TronContract::FreezeV2 {
                    owner,
                    amount: 2_000_000,
                    resource: TronResource::Bandwidth,
                },
            )
            .await;
            compare(
                &c,
                "/wallet/votewitnessaccount",
                json!({ "owner_address": me, "votes": [{ "vote_address": top.address, "vote_count": 1 }], "visible": true }),
                TronContract::VoteWitness {
                    owner,
                    votes: vec![(sr, 1)],
                },
            )
            .await;
            compare(
                &c,
                "/wallet/unfreezebalancev2",
                json!({ "owner_address": me, "unfreeze_balance": 1_000_000, "resource": "ENERGY", "visible": true }),
                TronContract::UnfreezeV2 {
                    owner,
                    amount: 1_000_000,
                    resource: TronResource::Energy,
                },
            )
            .await;
            compare(
                &c,
                "/wallet/cancelallunfreezev2",
                json!({ "owner_address": me, "visible": true }),
                TronContract::CancelAllUnfreezeV2 { owner },
            )
            .await;
            compare(
                &c,
                "/wallet/withdrawexpireunfreeze",
                json!({ "owner_address": me, "visible": true }),
                TronContract::WithdrawExpireUnfreeze { owner },
            )
            .await;
            compare(
                &c,
                "/wallet/withdrawbalance",
                json!({ "owner_address": me, "visible": true }),
                TronContract::WithdrawBalance { owner },
            )
            .await;

            let energy = TronResource::Energy;
            let t1 = send(
                &c,
                &seed,
                &me,
                &TronStakeRequest::Freeze {
                    resource: energy,
                    amount: "10000000".into(),
                },
                "freeze 10 TRX energy",
            )
            .await;
            if t1.is_empty() {
                return;
            }
            eprintln!("TRON FREEZE: {t1}");
            tokio::time::sleep(std::time::Duration::from_secs(4)).await;
            let t2 = send(
                &c,
                &seed,
                &me,
                &TronStakeRequest::Vote {
                    votes: vec![VoteInput {
                        address: top.address.clone(),
                        count: "10".into(),
                    }],
                },
                "vote 10",
            )
            .await;
            eprintln!("TRON VOTE: {t2}");
            tokio::time::sleep(std::time::Duration::from_secs(4)).await;
            eprintln!("after vote: {:#?}", stake_account(&c, &me).await.unwrap());
            let t3 = send(
                &c,
                &seed,
                &me,
                &TronStakeRequest::Unfreeze {
                    resource: energy,
                    amount: "5000000".into(),
                },
                "unfreeze 5",
            )
            .await;
            eprintln!("TRON UNFREEZE 5: {t3}");
            tokio::time::sleep(std::time::Duration::from_secs(4)).await;
            eprintln!(
                "after unfreeze: {:#?}",
                stake_account(&c, &me).await.unwrap()
            );
            let t4 = send(
                &c,
                &seed,
                &me,
                &TronStakeRequest::CancelAllUnfreeze,
                "cancel all unfreeze",
            )
            .await;
            eprintln!("TRON CANCEL ALL UNFREEZE: {t4}");
            tokio::time::sleep(std::time::Duration::from_secs(4)).await;
            let acc = stake_account(&c, &me).await.unwrap();
            eprintln!("after cancel: {acc:#?}");
            let t5 = send(
                &c,
                &seed,
                &me,
                &TronStakeRequest::Unfreeze {
                    resource: energy,
                    amount: acc.staked_energy.clone(),
                },
                "unfreeze all",
            )
            .await;
            eprintln!("TRON UNFREEZE ALL: {t5}");
            tokio::time::sleep(std::time::Duration::from_secs(4)).await;
            eprintln!("final: {:#?}", stake_account(&c, &me).await.unwrap());
        });
    }
}
