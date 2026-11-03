// SPDX-License-Identifier: GPL-3.0-or-later
//! Earn screen: estimated staking rates for Solana, Cardano and TRON (docs/IPC.md §2.8).
//! Read only, through each chain's existing server (Solana RPC, Koios, TronGrid): no new host.
//! Each rate is a network-wide estimate BEFORE the validator / pool / SR commission; `None` when
//! a read fails or the answer is implausible.

use serde::Serialize;
use serde_json::{json, Value};
use tauri::State;

use crate::cardano_backend::{call, first, num};
use crate::error::AppResult;
use crate::state::AppState;
use crate::{stake_sol, stake_tron, tron_backend};

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct StakingRates {
    pub sol: Option<f64>,
    pub ada: Option<f64>,
    pub trx: Option<f64>,
}

fn plausible(p: f64) -> Option<f64> {
    (p.is_finite() && p > 0.0 && p < 50.0).then_some(p)
}

/// Solana: validator inflation × total supply / activated stake.
pub fn sol_apy(validator_inflation: f64, supply: u64, staked: u64) -> Option<f64> {
    if staked == 0 {
        return None;
    }
    plausible(validator_inflation * supply as f64 / staked as f64 * 100.0)
}

/// Cardano: the epoch reward pot `reserves × ρ × (1 − τ)` is shared in proportion to stake over
/// the circulating total (`max supply − reserves`) and divided by `1 + a0` (pledge influence);
/// 73 epochs a year. Fees and pool performance are left out (small, and not known in advance).
pub fn ada_apy(reserves: u64, max_supply: u64, rho: f64, tau: f64, a0: f64) -> Option<f64> {
    if max_supply <= reserves || !(0.0..1.0).contains(&tau) || rho <= 0.0 || a0 < 0.0 {
        return None;
    }
    let pot = reserves as f64 * rho * (1.0 - tau);
    plausible(pot * 73.0 / (max_supply - reserves) as f64 / (1.0 + a0) * 100.0)
}

/// TRON: vote rewards (`getWitness127PayPerBlock`, one block every 3 s) over the votes of the
/// 127 paid SRs (1 vote = 1 staked TRX).
pub fn trx_apr(pay_per_block_sun: u64, paid_votes: u64) -> Option<f64> {
    if paid_votes == 0 {
        return None;
    }
    let blocks_per_year = 365.0 * 86_400.0 / 3.0;
    plausible(pay_per_block_sun as f64 / 1e6 * blocks_per_year / paid_votes as f64 * 100.0)
}

async fn sol(state: &AppState) -> AppResult<Option<f64>> {
    let infl = stake_sol::rpc(state, "getInflationRate", json!([])).await?;
    let supply = stake_sol::rpc(
        state,
        "getSupply",
        json!([{ "commitment": "confirmed", "excludeNonCirculatingAccountsList": true }]),
    )
    .await?;
    let staked: u64 = stake_sol::vote_accounts(state)
        .await?
        .iter()
        .filter_map(|v| v.activated_stake.parse::<u64>().ok())
        .sum();
    Ok(infl["validator"]
        .as_f64()
        .zip(supply["value"]["total"].as_u64())
        .and_then(|(i, s)| sol_apy(i, s, staked)))
}

fn f(v: &Value) -> Option<f64> {
    v.as_f64().or_else(|| v.as_str()?.parse().ok())
}

async fn ada(state: &AppState) -> AppResult<Option<f64>> {
    let c = crate::commands_cardano::ctx(state);
    let tip = first(&call(&c, "/tip", None).await?, "tip")?;
    let Some(e) = num(&tip["epoch_no"]) else {
        return Ok(None);
    };
    let p = first(
        &call(
            &c,
            &format!("/epoch_params?_epoch_no={e}&select=monetary_expand_rate,treasury_growth_rate,influence"),
            None,
        )
        .await?,
        "epoch_params",
    )?;
    let t = first(
        &call(&c, &format!("/totals?_epoch_no={e}&select=reserves"), None).await?,
        "totals",
    )?;
    let g = first(&call(&c, "/genesis", None).await?, "genesis")?;
    Ok((|| {
        ada_apy(
            num(&t["reserves"])?,
            num(&g["maxlovelacesupply"])?,
            f(&p["monetary_expand_rate"])?,
            f(&p["treasury_growth_rate"])?,
            f(&p["influence"])?,
        )
    })())
}

async fn trx(state: &AppState) -> AppResult<Option<f64>> {
    let c = crate::commands_tron::ctx(state);
    let params = tron_backend::request(&c, "/wallet/getchainparameters", Some(json!({}))).await?;
    let pay = params["chainParameter"]
        .as_array()
        .and_then(|l| l.iter().find(|p| p["key"] == "getWitness127PayPerBlock"))
        .and_then(|p| p["value"].as_u64());
    let votes: u64 = stake_tron::witnesses(&c)
        .await?
        .iter()
        .filter(|w| w.is_paid)
        .map(|w| w.vote_count)
        .sum();
    Ok(pay.and_then(|p| trx_apr(p, votes)))
}

#[tauri::command]
pub async fn earn_staking_rates(state: State<'_, AppState>) -> AppResult<StakingRates> {
    let (s, a, t) = futures_util::future::join3(sol(&state), ada(&state), trx(&state)).await;
    Ok(StakingRates {
        sol: s.ok().flatten(),
        ada: a.ok().flatten(),
        trx: t.ok().flatten(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rates_match_the_networks() {
        // Solana: ~4.4 % validator inflation, 600 M SOL supply, 400 M staked → ~6.6 %.
        let s = sol_apy(0.044, 600_000_000_000_000_000, 400_000_000_000_000_000).unwrap();
        assert!((s - 6.6).abs() < 0.01, "{s}");
        assert_eq!(sol_apy(0.044, 1, 0), None);
        // Cardano: 7 B ADA reserves, 45 B max, ρ 0.003, τ 0.2, a0 0.3 → ~2.5 %.
        let a = ada_apy(
            7_000_000_000_000_000,
            45_000_000_000_000_000,
            0.003,
            0.2,
            0.3,
        )
        .unwrap();
        assert!(a > 2.0 && a < 3.0, "{a}");
        assert_eq!(ada_apy(50, 45, 0.003, 0.2, 0.3), None);
        assert_eq!(ada_apy(7, 45, 0.003, 1.2, 0.3), None);
        // TRON: 160 TRX a block over 45 B votes → ~3.7 %.
        let t = trx_apr(160_000_000, 45_000_000_000).unwrap();
        assert!(t > 3.0 && t < 4.5, "{t}");
        assert_eq!(trx_apr(160_000_000, 0), None);
        assert_eq!(trx_apr(160_000_000_000_000, 1), None);
    }
}
