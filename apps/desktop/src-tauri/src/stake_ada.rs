//! Cardano delegation (`ada_stake_*`, docs/IPC.md §2.8), Conway era: stake key registration
//! (certificate 7, deposit = protocol `keyDeposit`), pool delegation (2), governance vote
//! delegation (9: "always abstain", "always no confidence" or a DRep id), reward withdrawal to our
//! own reward address, and deregistration (8, deposit refunded) — always for **our** stake key
//! `m/1852'/1815'/0'/2/0` (the stake part of Kyro's single address).

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, State};
use wallet_core::{
    CardanoBody, CardanoCert, CardanoCertView, CardanoContext, CardanoDrep, CardanoDrepView,
    CardanoInput, CardanoOutput, CardanoStakeSummary, Network,
};
use zeroize::Zeroizing;

use crate::accounts::{account_arg, confirm_signer, Chain, SignerInfo};
use crate::cardano_backend::{
    self, call, first, num, AssetMap, CardanoAccount, CardanoCtx, Params, Utxo, TTL_OFFSET,
};
use crate::commands::{
    blocking, cardano_root_from_password, confirm_native, format_units, format_units_in,
};
use crate::error::{AppError, AppResult};
use crate::i18n::Lang;
use crate::state::AppState;

const HIGH_MARGIN: f64 = 0.10;
const MAX_INPUTS: usize = 100;
const WITNESSES: usize = 2;

fn invalid(m: impl Into<String>) -> AppError {
    AppError::InvalidInput(m.into())
}

fn bad(m: impl Into<String>) -> AppError {
    AppError::ServerUnreachable(m.into())
}

fn ada(lovelace: &str) -> String {
    format!("{} ADA", format_units(lovelace, 6))
}

/// Our keys for staking: the address that pays (and receives the change) and the stake key.
/// The commands use one account `a` for both (`…/a'/0/0` + `…/a'/2/0`); the live test uses the
/// public CIP-19 vector address, whose stake key is account 1's and payment key account 0's.
#[derive(Debug, Clone)]
pub(crate) struct AdaStakeKeys {
    pub address: String,
    /// Account of the payment key `m/1852'/1815'/account'/0/0` (signing).
    pub account: u32,
    pub payment_pk: [u8; 32],
    pub stake_pk: [u8; 32],
    /// Account of the stake key `m/1852'/1815'/stake_account'/2/0` (signing).
    pub stake_account: u32,
}

impl AdaStakeKeys {
    fn stake_hash(&self) -> [u8; 28] {
        wallet_core::cardano_blake2b224(&self.stake_pk)
    }

    pub(crate) fn stake_address(&self, net: Network) -> AppResult<String> {
        Ok(wallet_core::cardano_stake_address(net, &self.stake_pk)?)
    }

    /// The address must be a base address carrying exactly this stake key.
    fn check(&self, net: Network) -> AppResult<Vec<u8>> {
        let b = wallet_core::cardano_address_bytes(&self.address, net)?;
        if b.len() != 57 || b[29..] != self.stake_hash() {
            return Err(AppError::Internal(
                "the address does not contain this stake key".into(),
            ));
        }
        Ok(b)
    }
}

fn our_keys(state: &AppState, account: Option<u32>) -> AppResult<AdaStakeKeys> {
    let net = state.network;
    let a = account_arg(account)?;
    state.with_cardano(|r| {
        Ok(AdaStakeKeys {
            address: wallet_core::cardano_address(r, net, a, 0)?,
            account: a,
            payment_pk: wallet_core::cardano_payment_public_key(r, a, 0)?,
            stake_pk: wallet_core::cardano_stake_public_key(r, a)?,
            stake_account: a,
        })
    })
}

/// Stake account state (Koios `account_info`).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AdaStakeAccount {
    pub stake_address: String,
    pub registered: bool,
    /// `pool1…` or `null`.
    pub delegated_pool: Option<String>,
    /// CIP-129 `drep1…`, `alwaysAbstain`, `alwaysNoConfidence` or `null` (no vote delegation:
    /// since the Plomin hard fork, rewards cannot be withdrawn without one).
    pub delegated_drep: Option<String>,
    /// Lovelace.
    pub rewards_available: String,
    /// Deposit paid at registration (refunded on deregistration), lovelace.
    pub deposit: String,
    /// Everything controlled by this stake key (all its addresses + rewards), lovelace.
    pub total_balance: String,
}

fn drep_label(koios: &str) -> String {
    match koios {
        "drep_always_abstain" => "alwaysAbstain".into(),
        "drep_always_no_confidence" => "alwaysNoConfidence".into(),
        other => other.to_owned(),
    }
}

pub(crate) async fn stake_account(
    c: &CardanoCtx<'_>,
    stake_address: &str,
) -> AppResult<AdaStakeAccount> {
    let v = call(
        c,
        "/account_info",
        Some(json!({ "_stake_addresses": [stake_address] })),
    )
    .await?;
    let a = v.as_array().and_then(|a| a.first()).cloned();
    let Some(a) = a else {
        return Ok(AdaStakeAccount {
            stake_address: stake_address.to_owned(),
            registered: false,
            delegated_pool: None,
            delegated_drep: None,
            rewards_available: "0".into(),
            deposit: "0".into(),
            total_balance: "0".into(),
        });
    };
    if a["stake_address"].as_str() != Some(stake_address) {
        return Err(bad("Koios: account_info for another address"));
    }
    Ok(AdaStakeAccount {
        stake_address: stake_address.to_owned(),
        registered: a["status"].as_str() == Some("registered"),
        delegated_pool: a["delegated_pool"].as_str().map(str::to_owned),
        delegated_drep: a["delegated_drep"].as_str().map(drep_label),
        rewards_available: num(&a["rewards_available"]).unwrap_or(0).to_string(),
        deposit: num(&a["deposit"]).unwrap_or(0).to_string(),
        total_balance: num(&a["total_balance"]).unwrap_or(0).to_string(),
    })
}

pub(crate) async fn key_deposit(c: &CardanoCtx<'_>) -> AppResult<u64> {
    let p = first(
        &call(c, "/epoch_params?limit=1&select=epoch_no,key_deposit", None).await?,
        "epoch_params",
    )?;
    let d = num(&p["key_deposit"]).ok_or_else(|| bad("Koios: key_deposit missing"))?;
    if d == 0 || d > 100_000_000 {
        return Err(bad(format!(
            "Koios: implausible key deposit ({d} lovelace)"
        )));
    }
    Ok(d)
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AdaEpoch {
    pub epoch: u64,
    pub slot_in_epoch: u64,
    pub epoch_length: u64,
    /// Slot = 1 s on preprod and mainnet.
    pub seconds_left: u64,
    pub slot: u64,
}

pub(crate) async fn epoch(c: &CardanoCtx<'_>) -> AppResult<AdaEpoch> {
    let t = first(&call(c, "/tip", None).await?, "tip")?;
    let g = first(&call(c, "/genesis", None).await?, "genesis")?;
    let len = num(&g["epochlength"]).unwrap_or(432_000);
    let in_epoch = num(&t["epoch_slot"]).unwrap_or(0);
    Ok(AdaEpoch {
        epoch: num(&t["epoch_no"]).ok_or_else(|| bad("Koios: epoch_no missing"))?,
        slot_in_epoch: in_epoch,
        epoch_length: len,
        seconds_left: len.saturating_sub(in_epoch),
        slot: num(&t["abs_slot"]).ok_or_else(|| bad("Koios: abs_slot missing"))?,
    })
}

/// A stake pool (Koios `pool_info`).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AdaPool {
    pub pool_id: String,
    pub pool_hash: String,
    pub ticker: Option<String>,
    pub name: Option<String>,
    pub homepage: Option<String>,
    /// 0..1 (0.02 = 2 % of the rewards above the fixed cost).
    pub margin: f64,
    /// Lovelace per epoch.
    pub fixed_cost: String,
    pub pledge: String,
    pub active_stake: Option<String>,
    pub live_stake: Option<String>,
    /// Percent of the saturation point (above 100 the rewards shrink).
    pub live_saturation: Option<f64>,
    pub live_delegators: Option<u64>,
    /// `registered` | `retiring` | `retired`.
    pub status: String,
    pub retiring_epoch: Option<u64>,
}

fn text(v: &Value, max: usize) -> Option<String> {
    v.as_str()
        .map(|s| s.chars().filter(|c| !c.is_control()).take(max).collect())
}

fn pool_of(v: &Value) -> Option<AdaPool> {
    let id = v["pool_id_bech32"].as_str()?.to_owned();
    let hash = hex::encode(wallet_core::cardano_pool_id(&id).ok()?);
    let meta = &v["meta_json"];
    Some(AdaPool {
        pool_hash: hash,
        pool_id: id,
        ticker: text(&meta["ticker"], 9).or_else(|| text(&v["ticker"], 9)),
        name: text(&meta["name"], 64),
        homepage: text(&meta["homepage"], 128),
        margin: v["margin"].as_f64().unwrap_or(1.0),
        fixed_cost: num(&v["fixed_cost"]).unwrap_or(0).to_string(),
        pledge: num(&v["pledge"]).unwrap_or(0).to_string(),
        active_stake: num(&v["active_stake"]).map(|x| x.to_string()),
        live_stake: num(&v["live_stake"]).map(|x| x.to_string()),
        live_saturation: v["live_saturation"].as_f64(),
        live_delegators: v["live_delegators"].as_u64(),
        status: v["pool_status"].as_str().unwrap_or("unknown").to_owned(),
        retiring_epoch: v["retiring_epoch"].as_u64(),
    })
}

pub(crate) async fn pool_info(c: &CardanoCtx<'_>, ids: &[String]) -> AppResult<Vec<AdaPool>> {
    let mut out = Vec::new();
    for chunk in ids.chunks(50) {
        let v = call(c, "/pool_info", Some(json!({ "_pool_bech32_ids": chunk }))).await?;
        out.extend(v.as_array().into_iter().flatten().filter_map(pool_of));
    }
    Ok(out)
}

async fn pool(c: &CardanoCtx<'_>, pool_id: &str) -> AppResult<AdaPool> {
    let hash = wallet_core::cardano_pool_id(pool_id)?;
    let id = wallet_core::cardano_pool_bech32(&hash)?;
    pool_info(c, std::slice::from_ref(&id))
        .await?
        .into_iter()
        .find(|p| p.pool_id == id)
        .ok_or_else(|| invalid(format!("pool {id} unknown to the network: refused")))
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AdaDrep {
    pub drep: CardanoDrepView,
    /// Registered DRep (always `true` for the predefined ones).
    pub registered: bool,
    /// Voted recently (`false`: inactive, its votes do not count for now).
    pub active: bool,
}

async fn drep_info(c: &CardanoCtx<'_>, d: &CardanoDrep) -> AppResult<AdaDrep> {
    let Some(id) = wallet_core::cardano_drep_id(d) else {
        return Ok(AdaDrep {
            drep: d.into(),
            registered: true,
            active: true,
        });
    };
    let v = call(c, "/drep_info", Some(json!({ "_drep_ids": [id] }))).await?;
    let x = v.as_array().and_then(|a| {
        a.iter()
            .find(|x| x["drep_id"].as_str() == Some(id.as_str()))
    });
    Ok(AdaDrep {
        drep: d.into(),
        registered: x.is_some_and(|x| x["registered"] == true),
        active: x.is_some_and(|x| x["active"] == true),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdaStakeOverview {
    pub address: String,
    pub stake: AdaStakeAccount,
    /// Pool currently delegated to, if any.
    pub pool: Option<AdaPool>,
    pub key_deposit: String,
    pub epoch: AdaEpoch,
    /// Rewards > 0 and a vote delegation exists (required by the ledger since Plomin).
    pub can_withdraw: bool,
}

pub(crate) async fn overview(
    c: &CardanoCtx<'_>,
    keys: &AdaStakeKeys,
) -> AppResult<AdaStakeOverview> {
    let stake = stake_account(c, &keys.stake_address(c.network)?).await?;
    let pool = match &stake.delegated_pool {
        Some(p) => pool_info(c, std::slice::from_ref(p))
            .await?
            .into_iter()
            .next(),
        None => None,
    };
    Ok(AdaStakeOverview {
        address: keys.address.clone(),
        can_withdraw: stake.rewards_available != "0" && stake.delegated_drep.is_some(),
        key_deposit: key_deposit(c).await?.to_string(),
        epoch: epoch(c).await?,
        pool,
        stake,
    })
}

#[tauri::command]
pub async fn ada_stake_overview(
    state: State<'_, AppState>,
    account: Option<u32>,
) -> AppResult<AdaStakeOverview> {
    let keys = our_keys(&state, account)?;
    overview(&crate::commands_cardano::ctx(&state), &keys).await
}

/// Registered pools by decreasing active stake (Koios `pool_list` then `pool_info`).
#[tauri::command]
pub async fn ada_stake_pools(
    state: State<'_, AppState>,
    limit: Option<u32>,
) -> AppResult<Vec<AdaPool>> {
    let c = crate::commands_cardano::ctx(&state);
    let n = limit.unwrap_or(50).clamp(1, 200);
    let v = call(
        &c,
        &format!(
            "/pool_list?pool_status=eq.registered&order=active_stake.desc.nullslast&limit={n}"
        ),
        None,
    )
    .await?;
    let ids: Vec<String> = v
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|p| p["pool_id_bech32"].as_str().map(str::to_owned))
        .collect();
    pool_info(&c, &ids).await
}

#[tauri::command]
pub async fn ada_stake_pool(state: State<'_, AppState>, pool_id: String) -> AppResult<AdaPool> {
    pool(&crate::commands_cardano::ctx(&state), &pool_id).await
}

/// What the UI asks Kyro to build.
#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AdaStakeRequest {
    /// Delegates to `pool_id` (`pool1…` or hex), registering the stake key first if needed
    /// (2 ADA deposit), and delegates the vote to `drep` if given.
    Delegate {
        pool_id: String,
        drep: Option<String>,
    },
    /// Delegates the governance vote (`alwaysAbstain`, `alwaysNoConfidence`, `drep1…`),
    /// registering the stake key first if needed.
    VoteDelegate { drep: String },
    /// Withdraws all available rewards to our reward address (they then count in our balance
    /// and are spent like any ADA: Cardano rewards are paid to the reward account).
    Withdraw,
    /// Deregisters the stake key: withdraws the rewards and refunds the deposit.
    Deregister,
}

fn change_out(change: &[u8], coin: u64, assets: wallet_core::CardanoAssets) -> CardanoOutput {
    CardanoOutput {
        address: change.to_vec(),
        coin,
        assets,
        map_form: false,
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn plan(
    utxos: &[Utxo],
    change: &[u8],
    certs: Vec<CardanoCert>,
    withdrawals: Vec<(Vec<u8>, u64)>,
    deposit: u64,
    credit: u64,
    p: &Params,
    ttl: u64,
) -> AppResult<CardanoBody> {
    let mut order: Vec<&Utxo> = utxos.iter().collect();
    order.sort_by_key(|u| (!u.assets.is_empty(), std::cmp::Reverse(u.lovelace)));
    let mut chosen: Vec<&Utxo> = Vec::new();
    let mut last = None;
    for u in order {
        if chosen.len() >= MAX_INPUTS {
            break;
        }
        chosen.push(u);
        let mut in_coin = 0u64;
        let mut assets = AssetMap::new();
        for c in &chosen {
            in_coin = in_coin.saturating_add(c.lovelace);
            for (k, q) in &c.assets {
                *assets.entry(k.clone()).or_default() += q;
            }
        }
        let change_assets = cardano_backend::to_assets(&assets)?;
        let min_change = wallet_core::cardano_min_utxo(change, &change_assets, p.coins_per_byte);
        let mut inputs = chosen
            .iter()
            .map(|u| {
                Ok(CardanoInput {
                    tx_hash: hex::decode(&u.tx_hash)
                        .ok()
                        .and_then(|b| b.try_into().ok())
                        .ok_or_else(|| AppError::Internal("invalid UTxO tx_hash".into()))?,
                    index: u.index,
                })
            })
            .collect::<AppResult<Vec<_>>>()?;
        inputs.sort();
        let mut fee = p.min_fee_b;
        let mut done = None;
        for _ in 0..6 {
            let available = in_coin.saturating_add(credit);
            let Some(rest) = available.checked_sub(fee.saturating_add(deposit)) else {
                last = Some(invalid(format!(
                    "insufficient balance: {} needed (deposit + fees)",
                    ada(&(fee + deposit).to_string())
                )));
                break;
            };
            if rest < min_change {
                last = Some(invalid(format!(
                    "the change ({}) would be below its minimum of {}",
                    ada(&rest.to_string()),
                    ada(&min_change.to_string())
                )));
                break;
            }
            let body = CardanoBody {
                inputs: inputs.clone(),
                tagged_sets: true,
                outputs: vec![change_out(change, rest, change_assets.clone())],
                fee,
                ttl: Some(ttl),
                certs: certs.clone(),
                withdrawals: withdrawals.clone(),
                aux_hash: None,
                validity_start: None,
            };
            let size = wallet_core::cardano_signed_size(&body, None, WITNESSES)?;
            if size as u64 > p.max_tx_size {
                return Err(invalid("transaction too large"));
            }
            let need = p.min_fee(size);
            if fee >= need {
                done = Some(body);
                break;
            }
            fee = need;
        }
        if let Some(b) = done {
            return Ok(b);
        }
    }
    Err(last.unwrap_or_else(|| invalid("no UTxO: empty address")))
}

pub(crate) fn check_balance(
    body: &CardanoBody,
    ours: &[Utxo],
    s: &CardanoStakeSummary,
) -> AppResult<i128> {
    let mut in_coin: u128 = 0;
    let mut in_assets = AssetMap::new();
    for i in &body.inputs {
        let h = hex::encode(i.tx_hash);
        let u = ours
            .iter()
            .find(|u| u.tx_hash == h && u.index == i.index)
            .ok_or_else(|| {
                invalid(format!(
                    "input {h}#{} unknown or already spent: rebuild the transaction",
                    i.index
                ))
            })?;
        in_coin += u128::from(u.lovelace);
        for (k, q) in &u.assets {
            *in_assets.entry(k.clone()).or_default() += q;
        }
    }
    let n = |x: &str| x.parse::<u128>().unwrap_or(u128::MAX / 4);
    let (deposit, refund, withdrawn) = (n(&s.deposit), n(&s.refund), n(&s.withdrawn));
    let mut out_coin = u128::from(body.fee) + deposit;
    let mut out_assets = AssetMap::new();
    for o in &body.outputs {
        out_coin += u128::from(o.coin);
        for (p, names) in &o.assets {
            for (nm, q) in names {
                *out_assets
                    .entry((hex::encode(p), hex::encode(nm)))
                    .or_default() += q;
            }
        }
    }
    if in_coin + refund + withdrawn != out_coin || in_assets != out_assets {
        return Err(invalid(
            "unbalanced transaction (inputs + withdrawals + refund ≠ outputs + fees + deposit): refused",
        ));
    }
    Ok(i128::from(body.fee) + deposit as i128 - refund as i128 - withdrawn as i128)
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AdaStakeWarning {
    /// The pool announced its retirement at this epoch (delegation then earns nothing).
    PoolRetiring { epoch: u64 },
    /// Margin above 10 % (`margin` in percent).
    HighMargin { margin: f64 },
    /// Live stake above the saturation point (rewards shrink).
    PoolSaturated { saturation: f64 },
    /// The DRep is registered but inactive.
    DrepInactive,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdaStakeContext {
    /// Payment address balance (what pays fee and deposit).
    pub account: CardanoAccount,
    /// Stake key state before this transaction.
    pub stake: AdaStakeAccount,
    /// Pool of a delegation certificate.
    pub pool: Option<AdaPool>,
    /// DRep of a vote delegation certificate.
    pub drep: Option<AdaDrep>,
    pub params: Params,
    pub key_deposit: String,
    pub epoch: AdaEpoch,
    /// fee + deposit − refund − withdrawal, lovelace (negative: the wallet gains).
    pub net_cost: String,
    pub warnings: Vec<AdaStakeWarning>,
    pub requires_extra_confirmation: bool,
}

fn decode_ctx<'a>(net: Network, own: &'a [String], p: &Params) -> CardanoContext<'a> {
    CardanoContext {
        net,
        own,
        verified_tokens: &[],
        coins_per_byte: p.coins_per_byte,
    }
}

pub(crate) async fn prepare_sign(
    c: &CardanoCtx<'_>,
    keys: &AdaStakeKeys,
    tx: &str,
) -> AppResult<(CardanoStakeSummary, AdaStakeContext)> {
    keys.check(c.network)?;
    let p = cardano_backend::params(c).await?;
    let kd = key_deposit(c).await?;
    let own = [keys.address.clone()];
    let dctx = decode_ctx(c.network, &own, &p);
    let summary = wallet_core::cardano_decode_stake_tx(tx, &dctx, &keys.stake_pk, kd)?;
    let body = wallet_core::cardano_stake_tx_body(tx, &dctx, &keys.stake_pk, kd)?;
    let ep = epoch(c).await?;
    if summary.tx.ttl.is_some_and(|t| t <= ep.slot) {
        return Err(invalid(
            "Cardano transaction expired (ttl passed): rebuild it",
        ));
    }
    if summary.tx.outputs.iter().any(|o| !o.is_change) {
        return Err(invalid(
            "a staking transaction only pays your own address: refused",
        ));
    }
    let utxos = cardano_backend::utxos(c, &keys.address).await?;
    let account = cardano_backend::account_of(c.network, &keys.address, &utxos, p.coins_per_byte)?;
    let net_cost = check_balance(&body, &utxos, &summary)?;
    let size = wallet_core::cardano_signed_size(&body, None, WITNESSES)?;
    if body.fee < p.min_fee(size) {
        return Err(invalid(format!(
            "fee too low ({} lovelace, minimum {})",
            body.fee,
            p.min_fee(size)
        )));
    }
    let stake = stake_account(c, &keys.stake_address(c.network)?).await?;
    let has = |f: fn(&CardanoCertView) -> bool| summary.certificates.iter().any(f);
    let registers = has(|x| matches!(x, CardanoCertView::StakeRegistration { .. }));
    let deregisters = has(|x| matches!(x, CardanoCertView::StakeDeregistration { .. }));
    if registers && stake.registered {
        return Err(invalid("your stake key is already registered"));
    }
    if !registers && !stake.registered {
        return Err(invalid(
            "your stake key is not registered: the network would reject this operation",
        ));
    }
    if deregisters && summary.refund != stake.deposit {
        return Err(invalid(format!(
            "refund of {} lovelace, the deposit paid is {}: refused",
            summary.refund, stake.deposit
        )));
    }
    if !summary.withdrawals.is_empty() {
        if summary.withdrawn != stake.rewards_available {
            return Err(invalid(format!(
                "withdrawal of {} lovelace, rewards available: {} (the network requires the whole balance)",
                summary.withdrawn, stake.rewards_available
            )));
        }
        if stake.delegated_drep.is_none() {
            return Err(invalid(
                "cannot withdraw without a vote delegation (network rule since Plomin): delegate your vote first, for example to \"always abstain\"",
            ));
        }
    }
    if deregisters && stake.rewards_available != "0" && summary.withdrawals.is_empty() {
        return Err(invalid(
            "deregistration: the rewards must be withdrawn in the same transaction",
        ));
    }
    let mut warnings = Vec::new();
    let mut pool_ctx = None;
    let mut drep_ctx = None;
    for cert in &body.certs {
        match cert {
            CardanoCert::StakeDelegation { pool: h, .. } => {
                let pl = pool(c, &hex::encode(h)).await?;
                match pl.status.as_str() {
                    "registered" => {}
                    "retiring" => warnings.push(AdaStakeWarning::PoolRetiring {
                        epoch: pl.retiring_epoch.unwrap_or(0),
                    }),
                    other => {
                        return Err(invalid(format!(
                            "pool {}: status \"{other}\": refused",
                            pl.pool_id
                        )))
                    }
                }
                if pl.margin > HIGH_MARGIN {
                    warnings.push(AdaStakeWarning::HighMargin {
                        margin: (pl.margin * 1000.0).round() / 10.0,
                    });
                }
                if let Some(s) = pl.live_saturation.filter(|s| *s > 100.0) {
                    warnings.push(AdaStakeWarning::PoolSaturated { saturation: s });
                }
                pool_ctx = Some(pl);
            }
            CardanoCert::VoteDelegation { drep, .. } => {
                let d = drep_info(c, drep).await?;
                if !d.registered {
                    return Err(invalid(
                        "this DRep is not registered: vote delegation refused",
                    ));
                }
                if !d.active {
                    warnings.push(AdaStakeWarning::DrepInactive);
                }
                drep_ctx = Some(d);
            }
            _ => {}
        }
    }
    Ok((
        summary,
        AdaStakeContext {
            account,
            stake,
            pool: pool_ctx,
            drep: drep_ctx,
            params: p,
            key_deposit: kd.to_string(),
            epoch: ep,
            net_cost: net_cost.to_string(),
            requires_extra_confirmation: !warnings.is_empty(),
            warnings,
        },
    ))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdaStakeBuilt {
    /// Unsigned transaction (CBOR hex): what `ada_stake_sign` signs.
    pub tx: String,
    pub summary: CardanoStakeSummary,
    pub context: AdaStakeContext,
}

pub(crate) async fn build(
    c: &CardanoCtx<'_>,
    keys: &AdaStakeKeys,
    r: &AdaStakeRequest,
) -> AppResult<AdaStakeBuilt> {
    let me_b = keys.check(c.network)?;
    let p = cardano_backend::params(c).await?;
    let kd = key_deposit(c).await?;
    let ep = epoch(c).await?;
    let stake = stake_account(c, &keys.stake_address(c.network)?).await?;
    let me = keys.stake_hash();
    let reward = wallet_core::cardano_reward_address_bytes(c.network, &me);
    let rewards: u64 = stake.rewards_available.parse().unwrap_or(0);
    let mut certs = Vec::new();
    let mut withdrawals = Vec::new();
    let (mut deposit, mut credit) = (0u64, 0u64);
    let register = |certs: &mut Vec<CardanoCert>, deposit: &mut u64| {
        if !stake.registered {
            certs.push(CardanoCert::StakeRegistration {
                stake: me,
                deposit: kd,
            });
            *deposit = kd;
        }
    };
    match r {
        AdaStakeRequest::Delegate { pool_id, drep } => {
            register(&mut certs, &mut deposit);
            certs.push(CardanoCert::StakeDelegation {
                stake: me,
                pool: wallet_core::cardano_pool_id(pool_id)?,
            });
            if let Some(d) = drep {
                certs.push(CardanoCert::VoteDelegation {
                    stake: me,
                    drep: wallet_core::cardano_drep_parse(d)?,
                });
            }
        }
        AdaStakeRequest::VoteDelegate { drep } => {
            register(&mut certs, &mut deposit);
            certs.push(CardanoCert::VoteDelegation {
                stake: me,
                drep: wallet_core::cardano_drep_parse(drep)?,
            });
        }
        AdaStakeRequest::Withdraw => {
            if !stake.registered || rewards == 0 {
                return Err(invalid("no rewards to withdraw"));
            }
            withdrawals.push((reward, rewards));
            credit = rewards;
        }
        AdaStakeRequest::Deregister => {
            if !stake.registered {
                return Err(invalid("your stake key is not registered"));
            }
            let refund: u64 = stake.deposit.parse().unwrap_or(0);
            if rewards > 0 {
                withdrawals.push((reward, rewards));
            }
            certs.push(CardanoCert::StakeDeregistration { stake: me, refund });
            credit = refund.saturating_add(rewards);
        }
    }
    let utxos = cardano_backend::utxos(c, &keys.address).await?;
    let body = plan(
        &utxos,
        &me_b,
        certs,
        withdrawals,
        deposit,
        credit,
        &p,
        ep.slot + TTL_OFFSET,
    )?;
    let tx = hex::encode(wallet_core::cardano_unsigned_tx(&body, None)?);
    let (summary, context) = prepare_sign(c, keys, &tx).await?;
    Ok(AdaStakeBuilt {
        tx,
        summary,
        context,
    })
}

#[tauri::command]
pub async fn ada_stake_build(
    state: State<'_, AppState>,
    action: AdaStakeRequest,
    account: Option<u32>,
) -> AppResult<AdaStakeBuilt> {
    let keys = our_keys(&state, account)?;
    build(&crate::commands_cardano::ctx(&state), &keys, &action).await
}

fn ada_in(lang: Lang, lovelace: &str) -> String {
    format!("{} ADA", format_units_in(lang, lovelace, 6))
}

fn drep_text(lang: Lang, d: &CardanoDrepView) -> String {
    match d {
        CardanoDrepView::AlwaysAbstain => lang
            .pick(
                "« toujours s'abstenir » (DRep prédéfini : ton stake ne vote pas)",
                "“always abstain” (predefined DRep: your stake does not vote)",
            )
            .into(),
        CardanoDrepView::AlwaysNoConfidence => lang
            .pick(
                "« toujours défiance » (DRep prédéfini : vote de défiance envers le comité)",
                "“always no confidence” (predefined DRep: no-confidence vote against the committee)",
            )
            .into(),
        CardanoDrepView::Key { id, .. } => format!("DRep {id} ({})", lang.pick("clé", "key")),
        CardanoDrepView::Script { id, .. } => format!("DRep {id} (script)"),
    }
}

fn pool_text(lang: Lang, p: &AdaPool) -> String {
    let ticker = p
        .ticker
        .as_deref()
        .map(|t| format!("[{}] ", crate::dialog_text::sanitize(t, 12)))
        .unwrap_or_default();
    let name = p
        .name
        .as_deref()
        .map(|n| crate::dialog_text::field(n, 60))
        .unwrap_or_else(|| {
            lang.pick("pool sans métadonnées", "pool without metadata")
                .into()
        });
    let margin = (p.margin * 1000.0).round() / 10.0;
    let saturation = p
        .live_saturation
        .map(|s| lang.pick(format!("{s} %"), format!("{s}%")))
        .unwrap_or_else(|| lang.pick("inconnue", "unknown").into());
    let delegators = p
        .live_delegators
        .map(|d| d.to_string())
        .unwrap_or_else(|| "?".into());
    match lang {
        Lang::Fr => format!(
            "{ticker}{name} ({})\n      marge {margin} % · coût fixe {} par époque · pledge {} · saturation {saturation} · {delegators} délégants\n      nom et ticker déclarés par le pool, non vérifiés par Kyro",
            p.pool_id,
            ada_in(lang, &p.fixed_cost),
            ada_in(lang, &p.pledge),
        ),
        Lang::En => format!(
            "{ticker}{name} ({})\n      margin {margin}% · fixed cost {} per epoch · pledge {} · saturation {saturation} · {delegators} delegators\n      name and ticker declared by the pool, not verified by Kyro",
            p.pool_id,
            ada_in(lang, &p.fixed_cost),
            ada_in(lang, &p.pledge),
        ),
    }
}

pub(crate) fn describe(
    lang: Lang,
    s: &CardanoStakeSummary,
    c: &AdaStakeContext,
    net: Network,
) -> String {
    let ada = |l: &str| ada_in(lang, l);
    let fr = lang == Lang::Fr;
    let preprod = if net == Network::Testnet {
        " (preprod)"
    } else {
        ""
    };
    let mut out = if fr {
        format!(
            "Staking Cardano{preprod}\nClé de staking : {}\n\nOpérations :\n",
            s.stake_address
        )
    } else {
        format!(
            "Cardano staking{preprod}\nStake key: {}\n\nOperations:\n",
            s.stake_address
        )
    };
    let mut n = 0;
    for cert in &s.certificates {
        n += 1;
        out += &match cert {
            CardanoCertView::StakeRegistration { deposit } => {
                if fr {
                    format!(
                    " {n}. Enregistrement de ta clé de staking — DÉPÔT {} (rendu à la désinscription)\n",
                    ada(deposit)
                )
                } else {
                    format!(
                    " {n}. Registration of your stake key — DEPOSIT {} (returned on deregistration)\n",
                    ada(deposit)
                )
                }
            }
            CardanoCertView::StakeDeregistration { refund } => {
                if fr {
                    format!(
                    " {n}. DÉSINSCRIPTION de ta clé de staking — dépôt remboursé {} ; la délégation s'arrête\n",
                    ada(refund)
                )
                } else {
                    format!(
                    " {n}. DEREGISTRATION of your stake key — deposit refunded {}; the delegation stops\n",
                    ada(refund)
                )
                }
            }
            CardanoCertView::StakeDelegation { pool_id, .. } => format!(
                " {n}. {}{}\n",
                lang.pick("Délégation au pool ", "Delegation to pool "),
                c.pool
                    .as_ref()
                    .filter(|p| p.pool_id == *pool_id)
                    .map(|p| pool_text(lang, p))
                    .unwrap_or_else(|| pool_id.clone())
            ),
            CardanoCertView::VoteDelegation { drep } => format!(
                " {n}. {}{}\n",
                lang.pick("Délégation de vote : ", "Vote delegation: "),
                drep_text(lang, drep)
            ),
        };
    }
    for w in &s.withdrawals {
        n += 1;
        out += &if fr {
            format!(
                " {n}. Retrait des récompenses : {} depuis {} (ton compte de récompenses)\n",
                ada(&w.lovelace),
                w.reward_address
            )
        } else {
            format!(
                " {n}. Rewards withdrawal: {} from {} (your rewards account)\n",
                ada(&w.lovelace),
                w.reward_address
            )
        };
    }
    for o in &s.tx.outputs {
        out += &format!(
            "\n{}{}\n  {}\n",
            lang.pick(
                "Monnaie rendue à ton adresse : ",
                "Change returned to your address: "
            ),
            ada(&o.lovelace),
            o.address
        );
    }
    let cost: i128 = c.net_cost.parse().unwrap_or(0);
    out += &format!(
        "{}{}\n{}{}{}\n",
        lang.pick("Frais : ", "Fee: "),
        ada(&s.tx.fee),
        if cost >= 0 {
            lang.pick(
                "Coût total (frais + dépôt − remboursement − retrait)",
                "Total cost (fee + deposit − refund − withdrawal)",
            )
        } else {
            lang.pick(
                "Gain net (remboursement + retrait − frais)",
                "Net gain (refund + withdrawal − fee)",
            )
        },
        lang.colon(),
        ada(&cost.unsigned_abs().to_string())
    );
    let e = &c.epoch;
    out += &if fr {
        format!(
            "\nÉpoque actuelle : {} (fin dans ≈ {} h)\n",
            e.epoch,
            e.seconds_left / 3600
        )
    } else {
        format!(
            "\nCurrent epoch: {} (ends in ≈ {} h)\n",
            e.epoch,
            e.seconds_left / 3600
        )
    };
    if s.certificates
        .iter()
        .any(|x| matches!(x, CardanoCertView::StakeDelegation { .. }))
    {
        out += &if fr {
            format!(
                "Calendrier : la délégation compte à partir de l'époque {} ; premières récompenses versées au début de l'époque {} (≈ 15 à 20 jours)\n",
                e.epoch + 2,
                e.epoch + 4
            )
        } else {
            format!(
                "Schedule: the delegation counts from epoch {}; first rewards paid at the start of epoch {} (≈ 15 to 20 days)\n",
                e.epoch + 2,
                e.epoch + 4
            )
        };
    }
    out += lang.pick(
        "Tes ADA restent sur ton adresse et restent dépensables : pas de blocage. Pas de slashing sur Cardano : un mauvais pool fait perdre des récompenses, jamais le stake.\n",
        "Your ADA stays on your address and remains spendable: no lockup. No slashing on Cardano: a bad pool loses you rewards, never the stake.\n",
    );
    if let Some(t) = s.tx.ttl {
        out += &if fr {
            format!(
                "Valable jusqu'au slot {t} (≈ {} min) · id {}\n",
                t.saturating_sub(e.slot) / 60,
                s.tx.tx_id
            )
        } else {
            format!(
                "Valid until slot {t} (≈ {} min) · id {}\n",
                t.saturating_sub(e.slot) / 60,
                s.tx.tx_id
            )
        };
    }
    out
}

pub(crate) fn describe_extra(lang: Lang, c: &AdaStakeContext) -> String {
    let mut out = String::from(lang.pick(
        "Kyro a trouvé des points à vérifier :\n",
        "Kyro found some things to check:\n",
    ));
    for w in &c.warnings {
        out += &match (w, lang) {
            (AdaStakeWarning::PoolRetiring { epoch }, Lang::Fr) => format!(
                "• ce pool a annoncé son arrêt à l'époque {epoch} : ta délégation ne rapportera plus rien ensuite\n"
            ),
            (AdaStakeWarning::PoolRetiring { epoch }, Lang::En) => format!(
                "• this pool has announced it will retire at epoch {epoch}: your delegation will earn nothing after that\n"
            ),
            (AdaStakeWarning::HighMargin { margin }, Lang::Fr) => format!(
                "• ce pool garde {margin} % des récompenses (marge élevée{})\n",
                if *margin >= 100.0 {
                    " : tu ne recevrais RIEN"
                } else {
                    ""
                }
            ),
            (AdaStakeWarning::HighMargin { margin }, Lang::En) => format!(
                "• this pool keeps {margin}% of the rewards (high margin{})\n",
                if *margin >= 100.0 {
                    ": you would receive NOTHING"
                } else {
                    ""
                }
            ),
            (AdaStakeWarning::PoolSaturated { saturation }, Lang::Fr) => format!(
                "• ce pool est saturé ({saturation} %) : les récompenses de chacun diminuent\n"
            ),
            (AdaStakeWarning::PoolSaturated { saturation }, Lang::En) => format!(
                "• this pool is saturated ({saturation}%): everyone's rewards decrease\n"
            ),
            (AdaStakeWarning::DrepInactive, _) => lang
                .pick(
                    "• ce DRep est inactif : ses votes ne comptent pas pour l'instant\n",
                    "• this DRep is inactive: its votes do not count for now\n",
                )
                .to_owned(),
        };
    }
    out += lang.pick("\nContinuer quand même ?", "\nContinue anyway?");
    out
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdaStakeSigned {
    /// Signed transaction (CBOR hex): what `ada_stake_broadcast` submits.
    pub tx: String,
    pub tx_id: String,
    pub summary: CardanoStakeSummary,
    pub context: AdaStakeContext,
}

#[tauri::command]
pub async fn ada_stake_sign(
    app: AppHandle,
    state: State<'_, AppState>,
    tx: String,
    password: String,
    account: Option<u32>,
) -> AppResult<AdaStakeSigned> {
    if !state.is_unlocked() {
        return Err(AppError::Locked);
    }
    let keys = our_keys(&state, account)?;
    let lang = crate::i18n::current();
    let signer = SignerInfo::new(
        &state,
        Chain::Ada,
        keys.account,
        format!(
            "{} ({}), …/2/0 (staking)",
            crate::commands_cardano::payment_path(keys.account),
            lang.pick("paiement", "payment")
        ),
    );
    let c = crate::commands_cardano::ctx(&state);
    let (summary, context) = prepare_sign(&c, &keys, &tx).await?;
    let root = cardano_root_from_password(&state, Zeroizing::new(password)).await?;
    confirm_native(
        &app,
        lang.pick(
            "Confirmer l'opération de staking Cardano",
            "Confirm the Cardano staking operation",
        ),
        signer.body(lang, &describe(lang, &summary, &context, state.network)),
    )
    .await?;
    confirm_signer(&app, &signer).await?;
    if context.requires_extra_confirmation {
        confirm_native(
            &app,
            lang.pick(
                "Attention : pool ou DRep à vérifier",
                "Warning: pool or DRep to check",
            ),
            describe_extra(lang, &context),
        )
        .await?;
    }
    let net = state.network;
    let cpb = context.params.coins_per_byte;
    let kd: u64 = context.key_deposit.parse().unwrap_or(0);
    let (t, own, pa, sa) = (
        tx.clone(),
        keys.address.clone(),
        keys.account,
        keys.stake_account,
    );
    let (signed, tx_id, again) = blocking(move || {
        let own = [own];
        let dctx = decode_ctx(
            net,
            &own,
            &Params {
                min_fee_a: 0,
                min_fee_b: 0,
                coins_per_byte: cpb,
                max_tx_size: 0,
            },
        );
        Ok(wallet_core::cardano_sign_stake(
            &root, pa, 0, sa, &t, &dctx, kd,
        )?)
    })
    .await?;
    if again != summary {
        return Err(AppError::Internal(
            "summary differs between the preview and the signature".into(),
        ));
    }
    state.touch();
    Ok(AdaStakeSigned {
        tx: signed,
        tx_id,
        summary,
        context,
    })
}

/// The witnesses must be exactly our payment key and our stake key, each verified over the tx
/// id; then `submittx`, whose answer must be that tx id.
pub(crate) async fn broadcast_checked(
    c: &CardanoCtx<'_>,
    keys: &AdaStakeKeys,
    tx: &str,
) -> AppResult<String> {
    let (tx_id, mut wit) = wallet_core::cardano_signed_witnesses(tx)?;
    let mut want = vec![keys.payment_pk, keys.stake_pk];
    wit.sort();
    want.sort();
    if wit != want {
        return Err(invalid(
            "this transaction is not signed (only) by your payment and stake keys",
        ));
    }
    let bytes = hex::decode(tx.trim()).map_err(|_| invalid("tx hex"))?;
    cardano_backend::submit(c, bytes, &tx_id).await
}

#[tauri::command]
pub async fn ada_stake_broadcast(
    state: State<'_, AppState>,
    tx: String,
    account: Option<u32>,
) -> AppResult<String> {
    let keys = our_keys(&state, account)?;
    broadcast_checked(&crate::commands_cardano::ctx(&state), &keys, &tx).await
}

#[cfg(test)]
mod tests {
    use super::*;

    const P: Params = Params {
        min_fee_a: 44,
        min_fee_b: 155_381,
        coins_per_byte: 4310,
        max_tx_size: 16_384,
    };

    fn keys() -> (wallet_core::CardanoRoot, AdaStakeKeys) {
        let r = wallet_core::CardanoRoot::from_mnemonic(
            &wallet_core::Mnemonic::parse("all all all all all all all all all all all all")
                .unwrap(),
            "",
        );
        let k = AdaStakeKeys {
            address: wallet_core::cardano_address(&r, Network::Testnet, 0, 0).unwrap(),
            account: 0,
            payment_pk: wallet_core::cardano_payment_public_key(&r, 0, 0).unwrap(),
            stake_pk: wallet_core::cardano_stake_public_key(&r, 0).unwrap(),
            stake_account: 0,
        };
        (r, k)
    }

    fn utxo(i: u8, lovelace: u64) -> Utxo {
        Utxo {
            tx_hash: hex::encode([i; 32]),
            index: 0,
            lovelace,
            assets: AssetMap::new(),
        }
    }

    #[test]
    fn plan_registers_delegates_and_balances() {
        let (r, k) = keys();
        let me_b = k.check(Network::Testnet).unwrap();
        let h = k.stake_hash();
        let utxos = vec![utxo(1, 3_000_000), utxo(2, 5_000_000)];
        let certs = vec![
            CardanoCert::StakeRegistration {
                stake: h,
                deposit: 2_000_000,
            },
            CardanoCert::StakeDelegation {
                stake: h,
                pool: [7; 28],
            },
            CardanoCert::VoteDelegation {
                stake: h,
                drep: CardanoDrep::AlwaysAbstain,
            },
        ];
        let body = plan(&utxos, &me_b, certs, vec![], 2_000_000, 0, &P, 1000).unwrap();
        assert_eq!(body.inputs.len(), 1, "largest UTxO first");
        let tx = hex::encode(wallet_core::cardano_unsigned_tx(&body, None).unwrap());
        let own = [k.address.clone()];
        let ctx = decode_ctx(Network::Testnet, &own, &P);
        let (signed, _, s) =
            wallet_core::cardano_sign_stake(&r, 0, 0, 0, &tx, &ctx, 2_000_000).unwrap();
        let cost = check_balance(&body, &utxos, &s).unwrap();
        assert_eq!(cost, i128::from(body.fee) + 2_000_000);
        let need = P.min_fee(signed.len() / 2);
        assert!(
            body.fee >= need && body.fee - need < 500,
            "{} {need}",
            body.fee
        );
        assert!(s.tx.outputs[0].is_change);
        let reward = wallet_core::cardano_reward_address_bytes(Network::Testnet, &h);
        let body = plan(
            &utxos,
            &me_b,
            vec![CardanoCert::StakeDeregistration {
                stake: h,
                refund: 2_000_000,
            }],
            vec![(reward, 700_000)],
            0,
            2_700_000,
            &P,
            1000,
        )
        .unwrap();
        let tx = hex::encode(wallet_core::cardano_unsigned_tx(&body, None).unwrap());
        let (_, _, s) = wallet_core::cardano_sign_stake(&r, 0, 0, 0, &tx, &ctx, 2_000_000).unwrap();
        assert!(
            check_balance(&body, &utxos, &s).unwrap() < 0,
            "the wallet gains"
        );
        let mut b2 = body.clone();
        b2.outputs[0].coin -= 1;
        assert!(check_balance(&b2, &utxos, &s).is_err());
        assert!(plan(
            &[utxo(1, 2_100_000)],
            &me_b,
            vec![CardanoCert::StakeRegistration {
                stake: h,
                deposit: 2_000_000
            }],
            vec![],
            2_000_000,
            0,
            &P,
            1
        )
        .is_err());
    }

    #[test]
    fn dialog_text() {
        let (r, k) = keys();
        let me_b = k.check(Network::Testnet).unwrap();
        let h = k.stake_hash();
        let body = plan(
            &[utxo(1, 9_000_000)],
            &me_b,
            vec![
                CardanoCert::StakeRegistration {
                    stake: h,
                    deposit: 2_000_000,
                },
                CardanoCert::StakeDelegation {
                    stake: h,
                    pool: wallet_core::cardano_pool_id(
                        "pool187jmkalfzyz5cdlw4mxz9t9n8plcxpj7ve7a74mk05umvufp7jh",
                    )
                    .unwrap(),
                },
                CardanoCert::VoteDelegation {
                    stake: h,
                    drep: CardanoDrep::AlwaysAbstain,
                },
            ],
            vec![],
            2_000_000,
            0,
            &P,
            5000,
        )
        .unwrap();
        let tx = hex::encode(wallet_core::cardano_unsigned_tx(&body, None).unwrap());
        let own = [k.address.clone()];
        let (_, _, s) = wallet_core::cardano_sign_stake(
            &r,
            0,
            0,
            0,
            &tx,
            &decode_ctx(Network::Testnet, &own, &P),
            2_000_000,
        )
        .unwrap();
        let pool = AdaPool {
            pool_id: "pool187jmkalfzyz5cdlw4mxz9t9n8plcxpj7ve7a74mk05umvufp7jh".into(),
            pool_hash: "3fa5bb77e911054c37eeaecc22acb3387f83065e667ddf57767d39b6".into(),
            ticker: Some("ECS".into()),
            name: Some("Easy Car Stake".into()),
            homepage: None,
            margin: 1.0,
            fixed_cost: "340000000".into(),
            pledge: "100000000".into(),
            active_stake: None,
            live_stake: None,
            live_saturation: Some(0.03),
            live_delegators: Some(3),
            status: "registered".into(),
            retiring_epoch: None,
        };
        let ctx = AdaStakeContext {
            account: cardano_backend::account_of(
                Network::Testnet,
                &k.address,
                &[utxo(1, 9_000_000)],
                4310,
            )
            .unwrap(),
            stake: AdaStakeAccount {
                stake_address: s.stake_address.clone(),
                registered: false,
                delegated_pool: None,
                delegated_drep: None,
                rewards_available: "0".into(),
                deposit: "0".into(),
                total_balance: "0".into(),
            },
            pool: Some(pool),
            drep: None,
            params: P,
            key_deposit: "2000000".into(),
            epoch: AdaEpoch {
                epoch: 322,
                slot_in_epoch: 218_679,
                epoch_length: 432_000,
                seconds_left: 213_321,
                slot: 1000,
            },
            net_cost: (i128::from(body.fee) + 2_000_000).to_string(),
            warnings: vec![AdaStakeWarning::HighMargin { margin: 100.0 }],
            requires_extra_confirmation: true,
        };
        let d = describe(Lang::Fr, &s, &ctx, Network::Testnet);
        for needle in [
            "Staking Cardano (preprod)",
            "Clé de staking : stake_test1",
            "1. Enregistrement de ta clé de staking — DÉPÔT 2 ADA",
            "2. Délégation au pool [ECS] « Easy Car Stake » (pool187jm",
            "marge 100 % · coût fixe 340 ADA par époque",
            "non vérifiés par Kyro",
            "3. Délégation de vote : « toujours s'abstenir »",
            "Monnaie rendue à ton adresse",
            "Coût total (frais + dépôt − remboursement − retrait)",
            "Époque actuelle : 322 (fin dans ≈ 59 h)",
            "compte à partir de l'époque 324",
            "début de l'époque 326",
            "Pas de slashing sur Cardano",
        ] {
            assert!(d.contains(needle), "{needle} missing in:\n{d}");
        }
        assert!(describe_extra(Lang::Fr, &ctx).contains("tu ne recevrais RIEN"));
        let d = describe(Lang::En, &s, &ctx, Network::Testnet);
        for needle in [
            "Cardano staking (preprod)",
            "Stake key: stake_test1",
            "1. Registration of your stake key — DEPOSIT 2 ADA",
            "2. Delegation to pool [ECS] « Easy Car Stake » (pool187jm",
            "margin 100% · fixed cost 340 ADA per epoch",
            "not verified by Kyro",
            "3. Vote delegation: “always abstain”",
            "Change returned to your address",
            "Total cost (fee + deposit − refund − withdrawal): ",
            "Current epoch: 322 (ends in ≈ 59 h)",
            "counts from epoch 324",
            "start of epoch 326",
            "No slashing on Cardano",
        ] {
            assert!(d.contains(needle), "{needle} missing in:\n{d}");
        }
        let x = describe_extra(Lang::En, &ctx);
        assert!(x.contains("you would receive NOTHING") && x.ends_with("Continue anyway?"));
        for fr in ["Frais", "Époque", "Délégation", "marge", "RIEN"] {
            assert!(!d.contains(fr) && !x.contains(fr), "{fr}");
        }
    }
}

/// Real preprod staking through the Rust path of the `ada_stake_*` commands, over Tor, from the
/// public CIP-19 test-vector address (payment key m/1852'/1815'/0'/0/0, stake key
/// m/1852'/1815'/1'/2/0 of the published test mnemonic).
#[cfg(test)]
mod live {
    use super::*;
    use crate::net::NetClient;
    use crate::servers::CardanoServer;
    use crate::tor::TorState;

    const CIP19_PREPROD: &str = "addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgs68faae";

    async fn send(
        c: &CardanoCtx<'_>,
        root: &wallet_core::CardanoRoot,
        keys: &AdaStakeKeys,
        r: &AdaStakeRequest,
        label: &str,
    ) -> String {
        let built = build(c, keys, r).await.unwrap();
        let (summary, ctx) = prepare_sign(c, keys, &built.tx).await.unwrap();
        assert_eq!(summary, built.summary, "{label}: same decode at signing");
        eprintln!(
            "--- {label}: dialog ---\n{}---",
            describe(Lang::Fr, &summary, &ctx, Network::Testnet)
        );
        if ctx.requires_extra_confirmation {
            eprintln!(
                "--- {label}: reinforced ---\n{}---",
                describe_extra(Lang::Fr, &ctx)
            );
        }
        let own = [keys.address.clone()];
        let dctx = decode_ctx(Network::Testnet, &own, &ctx.params);
        let kd: u64 = ctx.key_deposit.parse().unwrap();
        let (signed, id, again) =
            wallet_core::cardano_sign_stake(root, 0, 0, keys.stake_account, &built.tx, &dctx, kd)
                .unwrap();
        assert_eq!(again, summary, "{label}: identical summary");
        if std::env::var("KYRO_ADA_STAKE").as_deref() != Ok("yes") {
            eprintln!("{label}: KYRO_ADA_STAKE != yes, not sent");
            return String::new();
        }
        let got = broadcast_checked(c, keys, &signed).await.unwrap();
        assert_eq!(got, id);
        eprintln!("{label}: SUBMITTED {id} ({} bytes)", signed.len() / 2);
        for _ in 0..90 {
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            if cardano_backend::tx_status(c, &id)
                .await
                .unwrap()
                .is_some_and(|n| n >= 1)
            {
                eprintln!("{label}: confirmed");
                return id;
            }
        }
        panic!("{label}: {id} not confirmed");
    }

    async fn wait_account(
        c: &CardanoCtx<'_>,
        keys: &AdaStakeKeys,
        registered: bool,
    ) -> AdaStakeAccount {
        for _ in 0..60 {
            let a = stake_account(c, &keys.stake_address(Network::Testnet).unwrap())
                .await
                .unwrap();
            if a.registered == registered {
                return a;
            }
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        }
        panic!("Koios never showed registered = {registered}");
    }

    #[test]
    #[ignore]
    fn ada_stake_live_preprod() {
        let net = NetClient::new(std::env::temp_dir().join("kyro-ada-stake-live")).unwrap();
        let root = wallet_core::CardanoRoot::from_mnemonic(
            &wallet_core::Mnemonic::parse(
                "test walk nut penalty hip pave soap entry language right filter choice",
            )
            .unwrap(),
            "",
        );
        let keys = AdaStakeKeys {
            address: CIP19_PREPROD.into(),
            account: 0,
            payment_pk: wallet_core::cardano_payment_public_key(&root, 0, 0).unwrap(),
            stake_pk: wallet_core::cardano_stake_public_key(&root, 1).unwrap(),
            stake_account: 1,
        };
        keys.check(Network::Testnet).unwrap();
        tauri::async_runtime::block_on(async {
            net.tor.restart();
            while net.tor.status().state != TorState::Ready {
                assert_ne!(net.tor.status().state, TorState::Error);
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            }
            let c = CardanoCtx {
                net_client: &net,
                network: Network::Testnet,
                tor: true,
                server: CardanoServer::Default,
            };
            let ov = overview(&c, &keys).await.unwrap();
            eprintln!("overview: {:#?}", serde_json::to_value(&ov).unwrap());
            let ids: Vec<String> = call(
                &c,
                "/pool_list?pool_status=eq.registered&order=active_stake.desc.nullslast&limit=40",
                None,
            )
            .await
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|p| p["pool_id_bech32"].as_str().map(str::to_owned))
            .collect();
            let pools = pool_info(&c, &ids).await.unwrap();
            let pool = pools
                .iter()
                .find(|p| {
                    p.status == "registered"
                        && p.margin <= 0.05
                        && p.live_saturation.unwrap_or(0.0) < 90.0
                })
                .expect("a pool")
                .clone();
            eprintln!("{} pools read; chosen {pool:#?}", pools.len());
            let delegate = AdaStakeRequest::Delegate {
                pool_id: pool.pool_id.clone(),
                drep: Some("alwaysAbstain".into()),
            };
            if ov.stake.registered {
                eprintln!("stake key already registered: delegation only");
            }
            let t1 = send(&c, &root, &keys, &delegate, "register+delegate+vote").await;
            if t1.is_empty() {
                return;
            }
            eprintln!("ADA STAKE REGISTER+DELEGATE+VOTE: {t1}");
            let a = wait_account(&c, &keys, true).await;
            eprintln!("account after: {a:#?}");
            if a.rewards_available != "0" {
                let t = send(&c, &root, &keys, &AdaStakeRequest::Withdraw, "withdraw").await;
                eprintln!("ADA STAKE WITHDRAW: {t}");
            } else {
                eprintln!("no rewards (new delegation: the first ones come ~4 epochs later): no withdrawal");
            }
            if std::env::var("KYRO_ADA_DEREGISTER").as_deref() == Ok("yes") {
                let t2 = send(&c, &root, &keys, &AdaStakeRequest::Deregister, "deregister").await;
                eprintln!("ADA STAKE DEREGISTER: {t2}");
                wait_account(&c, &keys, false).await;
                let t3 = send(&c, &root, &keys, &delegate, "register+delegate+vote again").await;
                eprintln!("ADA STAKE REGISTER+DELEGATE+VOTE (2): {t3}");
                eprintln!("final account: {:#?}", wait_account(&c, &keys, true).await);
            }
        });
    }
}
