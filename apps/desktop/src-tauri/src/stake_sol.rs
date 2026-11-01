//! Solana native staking (`sol_stake_*`, docs/IPC.md §2.8): our stake accounts and validators
//! (read by Rust from the Solana RPC through `net_fetch`'s policy and Tor), messages **built by
//! Kyro** (wallet-core `sol_stake_message`), signing behind the password and the native dialog
//! (decoded by wallet-core, live state re-read), and broadcast with signature check.
//!
//! RPC methods used (all still served by Agave 4.x; `getStakeActivation` was removed in 2.0 and
//! Kyro computes activation itself from the StakeHistory sysvar): `getEpochInfo`,
//! `getProgramAccounts` (Stake program, `withdrawer = us`; Config program, validator info),
//! `getAccountInfo`, `getVoteAccounts`, `getStakeMinimumDelegation`,
//! `getMinimumBalanceForRentExemption`, `getBalance`, `getLatestBlockhash`, `sendTransaction`.

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, State};
use wallet_core::{
    Network, SolInstruction, SolStakeAccount, SolStakeHistoryEntry, SolStakeOp, SolTxSummary,
    SOL_STAKE_ACCOUNT_SIZE, SOL_STAKE_HISTORY_SYSVAR, SOL_STAKE_PROGRAM,
};
use zeroize::Zeroizing;

use crate::accounts::{account_arg, confirm_signer, Chain, SignerInfo};
use crate::commands::{blocking, confirm_native, format_units, seed_from_password};
use crate::error::{AppError, AppResult};
use crate::net::FetchRequest;
use crate::solana;
use crate::state::AppState;

/// Above this commission (percent) the dialog is followed by the reinforced confirmation.
const HIGH_COMMISSION: u64 = 10;
/// Approximate slot time (the protocol target is 400 ms).
const SLOT_MS: u64 = 400;
const SEED_PREFIX: &str = "kyro-stake-";
const VALIDATOR_INFO: &str = "Va1idator1nfo111111111111111111111111111111";
const CONFIG_PROGRAM: &str = "Config1111111111111111111111111111111111111";

fn bad(msg: impl Into<String>) -> AppError {
    AppError::ServerUnreachable(msg.into())
}

/// One JSON-RPC call to the configured Solana RPC (custom server or allowlisted default),
/// through `NetClient::fetch` (allowlist, Tor family `solana`, size and time caps).
pub(crate) async fn rpc(state: &AppState, method: &str, params: Value) -> AppResult<Value> {
    let body = json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params });
    let settings = state.settings();
    let resp = state
        .net
        .fetch(
            FetchRequest {
                url: solana::rpc_url(state),
                method: "POST".into(),
                headers: [("content-type".to_owned(), "application/json".to_owned())].into(),
                body: Some(body.to_string()),
            },
            &settings,
            &state.env_keys,
            state.network,
        )
        .await?;
    if resp.status != 200 {
        return Err(bad(format!(
            "RPC Solana : HTTP {} sur {method}",
            resp.status
        )));
    }
    let v: Value = serde_json::from_str(&resp.body)
        .map_err(|_| bad(format!("RPC Solana : réponse illisible ({method})")))?;
    if let Some(e) = v.get("error") {
        let m: String = e["message"]
            .as_str()
            .unwrap_or("erreur")
            .chars()
            .take(300)
            .collect();
        return Err(if method == "sendTransaction" {
            AppError::InvalidInput(format!("transaction Solana refusée par le réseau : {m}"))
        } else {
            bad(format!("RPC Solana : {method} : {m}"))
        });
    }
    Ok(v["result"].clone())
}

fn sol(lamports: &str) -> String {
    format!("{} SOL", format_units(lamports, 9))
}

fn u64_of(v: &Value, what: &str) -> AppResult<u64> {
    v.as_u64()
        .ok_or_else(|| bad(format!("RPC Solana : {what} absent")))
}

fn b64(v: &Value) -> AppResult<Vec<u8>> {
    let (Some(d), Some("base64")) = (v[0].as_str(), v[1].as_str()) else {
        return Err(bad("RPC Solana : encodage inattendu"));
    };
    base64::engine::general_purpose::STANDARD
        .decode(d)
        .map_err(|_| bad("RPC Solana : base64 invalide"))
}

// ---------------------------------------------------------------- reads

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SolEpoch {
    pub epoch: u64,
    pub slot_index: u64,
    pub slots_in_epoch: u64,
    pub absolute_slot: u64,
    /// Estimate: remaining slots × 400 ms.
    pub seconds_left: u64,
}

pub(crate) async fn epoch(state: &AppState) -> AppResult<SolEpoch> {
    let v = rpc(
        state,
        "getEpochInfo",
        json!([{ "commitment": "confirmed" }]),
    )
    .await?;
    let slot_index = u64_of(&v["slotIndex"], "slotIndex")?;
    let slots_in_epoch = u64_of(&v["slotsInEpoch"], "slotsInEpoch")?;
    Ok(SolEpoch {
        epoch: u64_of(&v["epoch"], "epoch")?,
        slot_index,
        slots_in_epoch,
        absolute_slot: u64_of(&v["absoluteSlot"], "absoluteSlot")?,
        seconds_left: slots_in_epoch.saturating_sub(slot_index) * SLOT_MS / 1000,
    })
}

async fn stake_history(state: &AppState) -> AppResult<Vec<SolStakeHistoryEntry>> {
    let v = rpc(
        state,
        "getAccountInfo",
        json!([SOL_STAKE_HISTORY_SYSVAR, { "encoding": "base64", "commitment": "confirmed" }]),
    )
    .await?;
    Ok(wallet_core::sol_parse_stake_history(&b64(
        &v["value"]["data"]
    )?)?)
}

async fn rent_reserve(state: &AppState) -> AppResult<u64> {
    u64_of(
        &rpc(
            state,
            "getMinimumBalanceForRentExemption",
            json!([SOL_STAKE_ACCOUNT_SIZE]),
        )
        .await?,
        "rent",
    )
}

async fn balance(state: &AppState, a: &str) -> AppResult<u64> {
    u64_of(
        &rpc(
            state,
            "getBalance",
            json!([a, { "commitment": "confirmed" }]),
        )
        .await?["value"],
        "balance",
    )
}

/// A stake account as the UI shows it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SolStakePosition {
    pub address: String,
    /// Lamports held by the account (stake + rent reserve + undelegated excess).
    pub lamports: String,
    /// `initialized` | `activating` | `active` | `deactivating` | `inactive`.
    pub state: &'static str,
    pub rent_exempt_reserve: String,
    pub staker: String,
    pub withdrawer: String,
    /// `staker = withdrawer = us` and no lockup in force: Kyro can manage it.
    pub ours: bool,
    pub lockup_in_force: bool,
    pub vote_account: Option<String>,
    /// Delegated lamports.
    pub delegated: Option<String>,
    pub activation_epoch: Option<u64>,
    /// `None` = not deactivated.
    pub deactivation_epoch: Option<u64>,
    /// Lamports earning rewards now / warming up / cooling down (Stake program rule, computed
    /// by Kyro from the StakeHistory sysvar).
    pub effective: String,
    pub activating: String,
    pub deactivating: String,
    /// Partial withdrawal maximum that keeps the account open.
    pub withdrawable: String,
    /// The whole balance can be withdrawn (closes the account): nothing is staked any more.
    pub can_close: bool,
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX))
}

pub(crate) fn position(
    address: &str,
    lamports: u64,
    a: &SolStakeAccount,
    me: &str,
    current_epoch: u64,
    history: &[SolStakeHistoryEntry],
) -> SolStakePosition {
    let activation = a
        .delegation
        .as_ref()
        .map(|d| wallet_core::sol_stake_activation(d, current_epoch, history))
        .unwrap_or_default();
    let state = match &a.delegation {
        None => "initialized",
        Some(d) if d.deactivation_epoch == u64::MAX => {
            if activation.activating > 0 {
                "activating"
            } else {
                "active"
            }
        }
        Some(_) if activation.effective > 0 || activation.deactivating > 0 => "deactivating",
        Some(_) => "inactive",
    };
    let lockup_in_force = a.lockup_unix_timestamp > now_secs() || a.lockup_epoch > current_epoch;
    let (withdrawable, can_close) =
        wallet_core::sol_stake_withdrawable(a, lamports, current_epoch, history);
    let d = a.delegation.as_ref();
    SolStakePosition {
        address: address.to_owned(),
        lamports: lamports.to_string(),
        state,
        rent_exempt_reserve: a.rent_exempt_reserve.to_string(),
        staker: a.staker.clone(),
        withdrawer: a.withdrawer.clone(),
        ours: a.staker == me && a.withdrawer == me && !lockup_in_force,
        lockup_in_force,
        vote_account: d.map(|d| d.vote_account.clone()),
        delegated: d.map(|d| d.stake.to_string()),
        activation_epoch: d.map(|d| d.activation_epoch),
        deactivation_epoch: d.map(|d| d.deactivation_epoch).filter(|e| *e != u64::MAX),
        effective: activation.effective.to_string(),
        activating: activation.activating.to_string(),
        deactivating: activation.deactivating.to_string(),
        withdrawable: withdrawable.to_string(),
        can_close,
    }
}

/// Our stake accounts: `getProgramAccounts(Stake, dataSize 200, memcmp(44 = withdrawer) = us)`.
async fn our_stake_accounts(
    state: &AppState,
    me: &str,
) -> AppResult<Vec<(String, u64, SolStakeAccount)>> {
    let v = rpc(
        state,
        "getProgramAccounts",
        json!([SOL_STAKE_PROGRAM, {
            "encoding": "base64", "commitment": "confirmed",
            "filters": [{ "dataSize": SOL_STAKE_ACCOUNT_SIZE }, { "memcmp": { "offset": 44, "bytes": me } }]
        }]),
    )
    .await?;
    let mut out = Vec::new();
    for a in v.as_array().into_iter().flatten() {
        let address = a["pubkey"]
            .as_str()
            .ok_or_else(|| bad("RPC Solana : pubkey absent"))?
            .to_owned();
        let acc = &a["account"];
        if acc["owner"].as_str() != Some(SOL_STAKE_PROGRAM) {
            continue;
        }
        let parsed = wallet_core::sol_parse_stake_account(&b64(&acc["data"])?)?;
        if parsed.withdrawer != me {
            continue; // the server's filter is not trusted
        }
        out.push((address, u64_of(&acc["lamports"], "lamports")?, parsed));
    }
    Ok(out)
}

/// One stake account, read live.
async fn stake_account(
    state: &AppState,
    address: &str,
) -> AppResult<Option<(u64, SolStakeAccount)>> {
    let v = rpc(
        state,
        "getAccountInfo",
        json!([address, { "encoding": "base64", "commitment": "confirmed" }]),
    )
    .await?;
    let acc = &v["value"];
    if acc.is_null() {
        return Ok(None);
    }
    if acc["owner"].as_str() != Some(SOL_STAKE_PROGRAM) {
        return Err(AppError::InvalidInput(format!(
            "{address} n'est pas un compte de staking"
        )));
    }
    Ok(Some((
        u64_of(&acc["lamports"], "lamports")?,
        wallet_core::sol_parse_stake_account(&b64(&acc["data"])?)?,
    )))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SolValidator {
    pub vote_account: String,
    /// Node identity.
    pub identity: String,
    /// Self-declared name (validator-info account), **not verified** by anyone.
    pub name: Option<String>,
    /// Percent of rewards kept by the validator.
    pub commission: u64,
    /// Lamports.
    pub activated_stake: String,
    pub delinquent: bool,
    pub last_vote: u64,
    pub epoch_vote_account: bool,
}

fn validator_of(v: &Value, delinquent: bool) -> Option<SolValidator> {
    Some(SolValidator {
        vote_account: v["votePubkey"].as_str()?.to_owned(),
        identity: v["nodePubkey"].as_str()?.to_owned(),
        name: None,
        commission: v["commission"].as_u64()?,
        activated_stake: v["activatedStake"].as_u64()?.to_string(),
        delinquent,
        last_vote: v["lastVote"].as_u64().unwrap_or(0),
        epoch_vote_account: v["epochVoteAccount"].as_bool().unwrap_or(false),
    })
}

async fn vote_accounts(state: &AppState) -> AppResult<Vec<SolValidator>> {
    let v = rpc(
        state,
        "getVoteAccounts",
        json!([{ "commitment": "confirmed" }]),
    )
    .await?;
    let mut out: Vec<SolValidator> = Vec::new();
    for (k, delinquent) in [("current", false), ("delinquent", true)] {
        for x in v[k].as_array().into_iter().flatten() {
            if let Some(val) = validator_of(x, delinquent) {
                out.push(val);
            }
        }
    }
    out.sort_by_key(|x| {
        (
            x.delinquent,
            std::cmp::Reverse(x.activated_stake.parse::<u64>().unwrap_or(0)),
        )
    });
    Ok(out)
}

fn info_name(a: &Value) -> Option<(String, String)> {
    let info = &a["account"]["data"]["parsed"]["info"];
    let keys = info["keys"].as_array()?;
    if keys.first()?["pubkey"].as_str()? != VALIDATOR_INFO {
        return None;
    }
    let identity = keys.get(1)?["pubkey"].as_str()?.to_owned();
    let name: String = info["configData"]["name"]
        .as_str()?
        .chars()
        .filter(|c| !c.is_control())
        .take(64)
        .collect();
    Some((identity, name))
}

/// Self-declared validator names (Config program, `validatorInfo`), optionally for one identity
/// only (`memcmp` at offset 34 = the second key of `ConfigKeys`).
async fn validator_names(
    state: &AppState,
    identity: Option<&str>,
) -> AppResult<Vec<(String, String)>> {
    let mut cfg = json!({ "encoding": "jsonParsed", "commitment": "confirmed" });
    if let Some(id) = identity {
        cfg["filters"] = json!([{ "memcmp": { "offset": 34, "bytes": id } }]);
    }
    let v = rpc(state, "getProgramAccounts", json!([CONFIG_PROGRAM, cfg])).await?;
    Ok(v.as_array()
        .into_iter()
        .flatten()
        .filter_map(info_name)
        .collect())
}

async fn validator(state: &AppState, vote: &str) -> AppResult<SolValidator> {
    let all = vote_accounts(state).await?;
    let mut v = all
        .into_iter()
        .find(|x| x.vote_account == vote)
        .ok_or_else(|| {
            AppError::InvalidInput(format!(
                "{vote} n'est pas un compte de vote connu du réseau (getVoteAccounts) : refusé"
            ))
        })?;
    // Best effort: a missing name never blocks.
    if let Ok(names) = validator_names(state, Some(&v.identity)).await {
        v.name = names
            .into_iter()
            .find(|(id, _)| *id == v.identity)
            .map(|(_, n)| n);
    }
    Ok(v)
}

// ---------------------------------------------------------------- commands: reads

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SolStakeOverview {
    pub address: String,
    /// Lamports on our address.
    pub balance: String,
    pub epoch: SolEpoch,
    /// `getStakeMinimumDelegation` (lamports).
    pub minimum_delegation: String,
    /// Rent-exempt reserve of a new stake account (lamports, recovered on withdrawal).
    pub rent_exempt_reserve: String,
    pub accounts: Vec<SolStakePosition>,
}

/// Our address of Solana account `account` (`m/44'/501'/account'/0'`).
fn our_address(state: &AppState, account: u32) -> AppResult<String> {
    state.with_seed(|seed| Ok(wallet_core::sol_address(seed, account)?))
}

pub(crate) async fn overview(state: &AppState, me: &str) -> AppResult<SolStakeOverview> {
    let ep = epoch(state).await?;
    let history = stake_history(state).await?;
    let min = u64_of(
        &rpc(
            state,
            "getStakeMinimumDelegation",
            json!([{ "commitment": "confirmed" }]),
        )
        .await?["value"],
        "minimum",
    )?;
    let accounts = our_stake_accounts(state, me)
        .await?
        .iter()
        .map(|(a, l, s)| position(a, *l, s, me, ep.epoch, &history))
        .collect();
    Ok(SolStakeOverview {
        address: me.to_owned(),
        balance: balance(state, me).await?.to_string(),
        minimum_delegation: min.to_string(),
        rent_exempt_reserve: rent_reserve(state).await?.to_string(),
        epoch: ep,
        accounts,
    })
}

#[tauri::command]
pub async fn sol_stake_overview(
    state: State<'_, AppState>,
    account: Option<u32>,
) -> AppResult<SolStakeOverview> {
    let me = our_address(&state, account_arg(account)?)?;
    overview(&state, &me).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SolValidators {
    pub validators: Vec<SolValidator>,
    /// `false` if the validator-info accounts could not be read (names all `null`).
    pub names_available: bool,
}

#[tauri::command]
pub async fn sol_stake_validators(
    state: State<'_, AppState>,
    with_names: Option<bool>,
) -> AppResult<SolValidators> {
    let mut validators = vote_accounts(&state).await?;
    let mut names_available = false;
    if with_names.unwrap_or(true) {
        if let Ok(names) = validator_names(&state, None).await {
            names_available = true;
            for v in &mut validators {
                v.name = names
                    .iter()
                    .find(|(id, _)| *id == v.identity)
                    .map(|(_, n)| n.clone());
            }
        }
    }
    Ok(SolValidators {
        validators,
        names_available,
    })
}

// ---------------------------------------------------------------- build / check

/// What the UI asks Kyro to build. Amounts: lamports, decimal strings.
#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SolStakeRequest {
    /// New stake account delegating `lamports` (the rent reserve is added by Kyro).
    CreateAndDelegate {
        lamports: String,
        vote_account: String,
    },
    Delegate {
        stake_account: String,
        vote_account: String,
    },
    Deactivate {
        stake_account: String,
    },
    /// `lamports` absent = everything that can be withdrawn (the whole balance if possible).
    Withdraw {
        stake_account: String,
        lamports: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SolStakeWarning {
    /// The validator is delinquent (not voting): no rewards while it stays so.
    Delinquent,
    /// Commission above 10 %.
    HighCommission { commission: u64 },
}

/// Decoded operation + live context, shown in the dialog and returned to the UI.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SolStakePreview {
    /// `createAndDelegate` | `delegate` | `deactivate` | `withdraw`.
    pub kind: &'static str,
    pub stake_account: String,
    /// Seed of a new stake account (`kyro-stake-N`).
    pub seed: Option<String>,
    /// Lamports moved into a new account, or withdrawn.
    pub lamports: Option<String>,
    /// Lamports that will be (or are) delegated.
    pub delegated: Option<String>,
    pub rent_exempt_reserve: String,
    pub validator: Option<SolValidator>,
    /// Current state of an existing stake account.
    pub account: Option<SolStakePosition>,
    /// Our SOL balance (lamports).
    pub balance: String,
    /// Base fee (lamports).
    pub fee: String,
    pub epoch: SolEpoch,
    /// Withdrawal of the whole balance: the account is closed.
    pub closes_account: bool,
    pub warnings: Vec<SolStakeWarning>,
    pub requires_extra_confirmation: bool,
}

/// The operation a decoded message performs, if it is exactly one Kyro builds.
pub(crate) fn classify(s: &SolTxSummary, me: &str) -> AppResult<SolStakeOp> {
    let refuse = || {
        AppError::InvalidInput(
            "ce n'est pas une opération de staking construite par Kyro : refusée".into(),
        )
    };
    if s.fee_payer != me
        || s.signers != [me.to_owned()]
        || !s.lookup_tables.is_empty()
        || s.requires_extra_confirmation
    {
        return Err(refuse());
    }
    Ok(match s.instructions.as_slice() {
        [SolInstruction::SystemCreateAccountWithSeed {
            from,
            new_account,
            base,
            seed,
            lamports,
            space,
            owner,
        }, SolInstruction::StakeInitialize {
            stake_account: a, ..
        }, SolInstruction::StakeDelegate {
            stake_account: b,
            vote_account,
            ..
        }] if from == me
            && base == me
            && owner == SOL_STAKE_PROGRAM
            && *space == SOL_STAKE_ACCOUNT_SIZE.to_string()
            && a == new_account
            && b == new_account =>
        {
            SolStakeOp::CreateAndDelegate {
                seed: seed.clone(),
                lamports: lamports.parse().map_err(|_| refuse())?,
                vote_account: vote_account.clone(),
            }
        }
        [SolInstruction::StakeDelegate {
            stake_account,
            vote_account,
            ..
        }] => SolStakeOp::Delegate {
            stake_account: stake_account.clone(),
            vote_account: vote_account.clone(),
        },
        [SolInstruction::StakeDeactivate { stake_account, .. }] => SolStakeOp::Deactivate {
            stake_account: stake_account.clone(),
        },
        [SolInstruction::StakeWithdraw {
            stake_account,
            lamports,
            ..
        }] => SolStakeOp::Withdraw {
            stake_account: stake_account.clone(),
            lamports: lamports.parse().map_err(|_| refuse())?,
        },
        _ => return Err(refuse()),
    })
}

fn invalid(m: impl Into<String>) -> AppError {
    AppError::InvalidInput(m.into())
}

fn warnings_for(v: &SolValidator) -> Vec<SolStakeWarning> {
    let mut w = Vec::new();
    if v.delinquent {
        w.push(SolStakeWarning::Delinquent);
    }
    if v.commission > HIGH_COMMISSION {
        w.push(SolStakeWarning::HighCommission {
            commission: v.commission,
        });
    }
    w
}

/// Live checks of `op` for our address and the dialog's context. Used by build (before
/// returning the message) and by sign (again, with fresh data).
pub(crate) async fn preview(
    state: &AppState,
    me: &str,
    op: &SolStakeOp,
    fee: u64,
) -> AppResult<SolStakePreview> {
    let ep = epoch(state).await?;
    let rent = rent_reserve(state).await?;
    let bal = balance(state, me).await?;
    let mk = |kind, stake_account: String| SolStakePreview {
        kind,
        stake_account,
        seed: None,
        lamports: None,
        delegated: None,
        rent_exempt_reserve: rent.to_string(),
        validator: None,
        account: None,
        balance: bal.to_string(),
        fee: fee.to_string(),
        epoch: ep.clone(),
        closes_account: false,
        warnings: Vec::new(),
        requires_extra_confirmation: false,
    };
    let mut p = match op {
        SolStakeOp::CreateAndDelegate {
            seed,
            lamports,
            vote_account,
        } => {
            let stake = wallet_core::sol_create_with_seed(me, seed, SOL_STAKE_PROGRAM)?;
            if stake_account(state, &stake).await?.is_some() {
                return Err(invalid(format!(
                    "le compte de staking {stake} existe déjà : reconstruis l'opération"
                )));
            }
            let delegated = lamports
                .checked_sub(rent)
                .filter(|d| *d > 0)
                .ok_or_else(|| {
                    invalid("montant inférieur à la réserve de rent du compte de staking")
                })?;
            let min = u64_of(
                &rpc(
                    state,
                    "getStakeMinimumDelegation",
                    json!([{ "commitment": "confirmed" }]),
                )
                .await?["value"],
                "minimum",
            )?;
            if delegated < min {
                return Err(invalid(format!(
                    "délégation minimale : {} (le réseau refuse moins)",
                    sol(&min.to_string())
                )));
            }
            if bal < lamports.saturating_add(fee) {
                return Err(invalid(format!(
                    "solde insuffisant : {} disponibles, il faut {} + frais",
                    sol(&bal.to_string()),
                    sol(&lamports.to_string())
                )));
            }
            let v = validator(state, vote_account).await?;
            let mut p = mk("createAndDelegate", stake);
            p.seed = Some(seed.clone());
            p.lamports = Some(lamports.to_string());
            p.delegated = Some(delegated.to_string());
            p.warnings = warnings_for(&v);
            p.validator = Some(v);
            p
        }
        SolStakeOp::Delegate {
            stake_account: sa, ..
        }
        | SolStakeOp::Deactivate { stake_account: sa }
        | SolStakeOp::Withdraw {
            stake_account: sa, ..
        } => {
            let (lamports, acc) = stake_account(state, sa)
                .await?
                .ok_or_else(|| invalid(format!("compte de staking {sa} introuvable")))?;
            let history = stake_history(state).await?;
            let pos = position(sa, lamports, &acc, me, ep.epoch, &history);
            if !pos.ours {
                return Err(invalid(
                    "ce compte de staking n'est pas entièrement à toi (autorité ou blocage) : refusé",
                ));
            }
            let mut p = match op {
                SolStakeOp::Delegate { vote_account, .. } => {
                    if !matches!(pos.state, "initialized" | "inactive") {
                        return Err(invalid(format!(
                            "compte de staking « {} » : seule une délégation d'un compte inactif est possible",
                            pos.state
                        )));
                    }
                    let v = validator(state, vote_account).await?;
                    let mut p = mk("delegate", sa.clone());
                    p.delegated =
                        Some(lamports.saturating_sub(acc.rent_exempt_reserve).to_string());
                    p.warnings = warnings_for(&v);
                    p.validator = Some(v);
                    p
                }
                SolStakeOp::Deactivate { .. } => {
                    if !matches!(pos.state, "activating" | "active") {
                        return Err(invalid(format!(
                            "compte de staking « {} » : rien à désactiver",
                            pos.state
                        )));
                    }
                    let mut p = mk("deactivate", sa.clone());
                    p.delegated = pos.delegated.clone();
                    if let Some(v) = &pos.vote_account {
                        p.validator = validator(state, v).await.ok();
                    }
                    p
                }
                SolStakeOp::Withdraw {
                    lamports: amount, ..
                } => {
                    let partial: u64 = pos.withdrawable.parse().unwrap_or(0);
                    let closes = *amount == lamports;
                    if (closes && !pos.can_close) || (!closes && *amount > partial) || *amount == 0
                    {
                        return Err(invalid(format!(
                            "retrait impossible : au plus {} sans fermer le compte{}",
                            sol(&partial.to_string()),
                            if pos.can_close {
                                format!(", ou tout le solde ({})", sol(&lamports.to_string()))
                            } else {
                                " (le stake doit d'abord finir son refroidissement)".into()
                            }
                        )));
                    }
                    let mut p = mk("withdraw", sa.clone());
                    p.lamports = Some(amount.to_string());
                    p.closes_account = closes;
                    p
                }
                SolStakeOp::CreateAndDelegate { .. } => return Err(invalid("opération")),
            };
            p.account = Some(pos);
            p
        }
    };
    p.requires_extra_confirmation = !p.warnings.is_empty();
    Ok(p)
}

fn parse_lamports(s: &str) -> AppResult<u64> {
    s.trim()
        .parse::<u64>()
        .ok()
        .filter(|v| *v > 0)
        .ok_or_else(|| invalid("montant en lamports invalide"))
}

/// Request → operation (seed choice for a new account, maximum for a withdrawal).
async fn operation(state: &AppState, me: &str, r: &SolStakeRequest) -> AppResult<SolStakeOp> {
    Ok(match r {
        SolStakeRequest::CreateAndDelegate {
            lamports,
            vote_account,
        } => {
            let stake = parse_lamports(lamports)?;
            let rent = rent_reserve(state).await?;
            let existing: Vec<String> = our_stake_accounts(state, me)
                .await?
                .into_iter()
                .map(|(a, _, _)| a)
                .collect();
            let mut chosen = None;
            for n in 0..1000u32 {
                let seed = format!("{SEED_PREFIX}{n}");
                let addr = wallet_core::sol_create_with_seed(me, &seed, SOL_STAKE_PROGRAM)?;
                if existing.contains(&addr) {
                    continue;
                }
                if stake_account(state, &addr).await?.is_none() {
                    chosen = Some(seed);
                    break;
                }
            }
            SolStakeOp::CreateAndDelegate {
                seed: chosen.ok_or_else(|| invalid("aucun seed libre"))?,
                lamports: stake
                    .checked_add(rent)
                    .ok_or_else(|| invalid("montant trop grand"))?,
                vote_account: vote_account.trim().to_owned(),
            }
        }
        SolStakeRequest::Delegate {
            stake_account,
            vote_account,
        } => SolStakeOp::Delegate {
            stake_account: stake_account.trim().to_owned(),
            vote_account: vote_account.trim().to_owned(),
        },
        SolStakeRequest::Deactivate { stake_account } => SolStakeOp::Deactivate {
            stake_account: stake_account.trim().to_owned(),
        },
        SolStakeRequest::Withdraw {
            stake_account,
            lamports,
        } => {
            let amount = match lamports {
                Some(l) => parse_lamports(l)?,
                None => {
                    let ep = epoch(state).await?;
                    let (bal, acc) = stake_account_or_err(state, stake_account).await?;
                    let history = stake_history(state).await?;
                    let pos = position(stake_account, bal, &acc, me, ep.epoch, &history);
                    if pos.can_close {
                        bal
                    } else {
                        pos.withdrawable.parse().unwrap_or(0)
                    }
                }
            };
            SolStakeOp::Withdraw {
                stake_account: stake_account.trim().to_owned(),
                lamports: amount,
            }
        }
    })
}

async fn stake_account_or_err(state: &AppState, a: &str) -> AppResult<(u64, SolStakeAccount)> {
    stake_account(state, a.trim())
        .await?
        .ok_or_else(|| invalid(format!("compte de staking {a} introuvable")))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SolStakeBuilt {
    /// Unsigned legacy message, base64: what `sol_stake_sign` signs.
    pub message: String,
    pub summary: SolTxSummary,
    pub stake: SolStakePreview,
}

pub(crate) async fn build(
    state: &AppState,
    me: &str,
    r: &SolStakeRequest,
) -> AppResult<SolStakeBuilt> {
    let op = operation(state, me, r).await?;
    let bh = rpc(
        state,
        "getLatestBlockhash",
        json!([{ "commitment": "confirmed" }]),
    )
    .await?;
    let blockhash = bh["value"]["blockhash"]
        .as_str()
        .ok_or_else(|| bad("RPC Solana : blockhash absent"))?;
    let message = wallet_core::sol_stake_message(me, &op, blockhash)?;
    // Decoded again by wallet-core, with the rules used before signing.
    let summary = wallet_core::sol_decode_message(&message, &[], me)?;
    if classify(&summary, me)? != op {
        return Err(AppError::Internal("message de staking inattendu".into()));
    }
    let fee: u64 = summary.base_fee_lamports.parse().unwrap_or(5000);
    let stake = preview(state, me, &op, fee).await?;
    Ok(SolStakeBuilt {
        message: base64::engine::general_purpose::STANDARD.encode(&message),
        summary,
        stake,
    })
}

#[tauri::command]
pub async fn sol_stake_build(
    state: State<'_, AppState>,
    action: SolStakeRequest,
    account: Option<u32>,
) -> AppResult<SolStakeBuilt> {
    let me = our_address(&state, account_arg(account)?)?;
    build(&state, &me, &action).await
}

// ---------------------------------------------------------------- dialog

fn net_label(net: Network) -> &'static str {
    match net {
        Network::Mainnet => "Solana (mainnet)",
        Network::Testnet => "Solana devnet (test)",
    }
}

fn duration(secs: u64) -> String {
    if secs >= 2 * 86_400 {
        format!("≈ {} jours", secs / 86_400)
    } else if secs >= 3600 {
        format!("≈ {} h", secs / 3600)
    } else {
        format!("≈ {} min", (secs / 60).max(1))
    }
}

fn validator_lines(v: &SolValidator) -> String {
    format!(
        "Validateur (compte de vote) : {}\n   Identité : {}\n   Nom déclaré : {}\n   Commission : {} % · stake actif : {} · {}\n",
        v.vote_account,
        v.identity,
        v.name
            .as_deref()
            .map(|n| format!(
                "{} (déclaré par le validateur, non vérifié)",
                crate::dialog_text::field(n, 60)
            ))
            .unwrap_or_else(|| "aucun".into()),
        v.commission,
        sol(&v.activated_stake),
        if v.delinquent {
            "⚠ EN RETARD (delinquent) : il ne vote plus, pas de récompenses"
        } else {
            "vote normalement"
        }
    )
}

/// Body of the native dialog, from the decoded message and the live context only.
pub(crate) fn describe(p: &SolStakePreview, net: Network) -> String {
    let e = &p.epoch;
    let mut out = format!("Staking {}\n\n", net_label(net));
    match p.kind {
        "createAndDelegate" => {
            out += &format!(
                "Opération : créer un compte de staking et le déléguer\nCompte de staking (nouveau) : {}\n   dérivé de ton adresse et du seed « {} »\n",
                p.stake_account,
                crate::dialog_text::sanitize(p.seed.as_deref().unwrap_or(""), 40)
            );
            out += &format!(
                "Montant délégué : {}\nRéserve de rent (récupérée au retrait) : {}\nTotal prélevé : {} + frais\n",
                sol(p.delegated.as_deref().unwrap_or("0")),
                sol(&p.rent_exempt_reserve),
                sol(p.lamports.as_deref().unwrap_or("0"))
            );
        }
        "delegate" => {
            out += &format!(
                "Opération : déléguer un compte de staking existant\nCompte de staking : {}\nMontant délégué : {}\n",
                p.stake_account,
                sol(p.delegated.as_deref().unwrap_or("0"))
            );
        }
        "deactivate" => {
            out += &format!(
                "Opération : DÉSACTIVER le stake (début du refroidissement)\nCompte de staking : {}\nMontant concerné : {}\n",
                p.stake_account,
                sol(p.delegated.as_deref().unwrap_or("0"))
            );
        }
        _ => {
            out += &format!(
                "Opération : RETIRER vers ton adresse\nCompte de staking : {}\nMontant : {}{}\n",
                p.stake_account,
                sol(p.lamports.as_deref().unwrap_or("0")),
                if p.closes_account {
                    " (tout le solde : le compte est fermé)"
                } else {
                    ""
                }
            );
        }
    }
    if let Some(v) = &p.validator {
        out += "\n";
        out += &validator_lines(v);
    }
    out += "\nAutorités : toi (staker et withdrawer), aucun blocage (lockup)\n";
    out += &format!(
        "\nÉpoque actuelle : {} (fin dans {})\n",
        e.epoch,
        duration(e.seconds_left)
    );
    match p.kind {
        "createAndDelegate" | "delegate" => {
            out += &format!(
                "Activation : au début de l'époque {} si le réseau l'absorbe (au plus 9 % du stake total s'active par époque : elle peut prendre plusieurs époques)\n",
                e.epoch + 1
            )
        }
        "deactivate" => {
            out += &format!(
                "Refroidissement : retrait possible à partir de l'époque {} (peut prendre plusieurs époques, même limite de 9 %) ; pas de récompenses pendant ce temps. Désactivé dans l'époque même de sa délégation, il est retirable tout de suite.\n",
                e.epoch + 1
            )
        }
        _ => {}
    }
    out += &format!(
        "\nFrais de base : {} · Solde : {}\nPas de slashing sur Solana aujourd'hui : un mauvais validateur fait perdre des récompenses, pas le stake.",
        sol(&p.fee),
        sol(&p.balance)
    );
    out
}

pub(crate) fn describe_extra(p: &SolStakePreview) -> String {
    let mut out = String::from("Kyro a trouvé des points à vérifier sur ce validateur :\n");
    for w in &p.warnings {
        out += &match w {
            SolStakeWarning::Delinquent => {
                "• il est EN RETARD (delinquent) : il ne vote plus, ton stake ne rapporterait rien tant qu'il le reste\n".to_owned()
            }
            SolStakeWarning::HighCommission { commission } => format!(
                "• il garde {commission} % des récompenses (commission élevée{})\n",
                if *commission >= 100 {
                    " : tu ne recevrais RIEN"
                } else {
                    ""
                }
            ),
        };
    }
    out += "\nDéléguer quand même ?";
    out
}

// ---------------------------------------------------------------- sign, broadcast

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SolStakeSigned {
    /// Ed25519 signature, base64.
    pub signature: String,
    pub summary: SolTxSummary,
    pub stake: SolStakePreview,
}

/// Everything `sol_stake_sign` does before the password: decode, classify, live checks.
pub(crate) async fn prepare_sign(
    state: &AppState,
    me: &str,
    bytes: &[u8],
) -> AppResult<(SolTxSummary, SolStakePreview)> {
    let decoded = solana::decode(state, bytes, me).await?;
    // Kyro builds staking messages itself, without lookup tables: an account given by the RPC
    // through a table has no business here.
    if !decoded.from_tables.is_empty() {
        return Err(AppError::InvalidInput(
            "staking : comptes lus dans une table d'adresses refusés".into(),
        ));
    }
    let summary = decoded.summary;
    let op = classify(&summary, me)?;
    let fee: u64 = summary.base_fee_lamports.parse().unwrap_or(5000);
    let p = preview(state, me, &op, fee).await?;
    Ok((summary, p))
}

#[tauri::command]
pub async fn sol_stake_sign(
    app: AppHandle,
    state: State<'_, AppState>,
    message: String,
    password: String,
    account: Option<u32>,
) -> AppResult<SolStakeSigned> {
    if !state.is_unlocked() {
        return Err(AppError::Locked);
    }
    let a = account_arg(account)?;
    let bytes = solana::message_bytes(&message)?;
    let me = our_address(&state, a)?;
    let signer = SignerInfo::new(&state, Chain::Sol, a, wallet_core::sol_path(a));
    let (summary, stake) = prepare_sign(&state, &me, &bytes).await?;
    let seed = seed_from_password(&state, Zeroizing::new(password)).await?;
    confirm_native(
        &app,
        "Confirmer l'opération de staking Solana",
        signer.body(&describe(&stake, state.network)),
    )
    .await?;
    confirm_signer(&app, &signer).await?;
    if stake.requires_extra_confirmation {
        confirm_native(
            &app,
            "Attention : validateur à vérifier",
            describe_extra(&stake),
        )
        .await?;
    }
    let m = me.clone();
    let sig = blocking(move || {
        let sig = wallet_core::sol_sign_message(&seed, a, &bytes)?;
        wallet_core::sol_verify_signature(&m, &bytes, &sig)?;
        Ok(sig)
    })
    .await?;
    state.touch();
    Ok(SolStakeSigned {
        signature: base64::engine::general_purpose::STANDARD.encode(sig),
        summary,
        stake,
    })
}

/// Signature check (ours, over this staking message), then `sendTransaction`; the id returned
/// must be our signature.
pub(crate) async fn broadcast(
    state: &AppState,
    me: &str,
    message: &[u8],
    signature: &[u8],
) -> AppResult<String> {
    let summary = wallet_core::sol_decode_message(message, &[], me)?;
    classify(&summary, me)?;
    let sig = wallet_core::sol_verify_signature(me, message, signature)
        .map_err(|_| invalid("signature invalide pour ton adresse Solana"))?;
    let mut tx = vec![1u8];
    tx.extend_from_slice(&sig);
    tx.extend_from_slice(message);
    let expected = bitcoin::base58::encode(&sig);
    let r = rpc(
        state,
        "sendTransaction",
        json!([base64::engine::general_purpose::STANDARD.encode(&tx),
               { "encoding": "base64", "preflightCommitment": "confirmed" }]),
    )
    .await?;
    if r.as_str() != Some(expected.as_str()) {
        return Err(bad(format!(
            "le RPC a répondu un identifiant inattendu ({})",
            r.to_string().chars().take(100).collect::<String>()
        )));
    }
    Ok(expected)
}

#[tauri::command]
pub async fn sol_stake_broadcast(
    state: State<'_, AppState>,
    message: String,
    signature: String,
    account: Option<u32>,
) -> AppResult<String> {
    let me = our_address(&state, account_arg(account)?)?;
    let bytes = solana::message_bytes(&message)?;
    let sig = base64::engine::general_purpose::STANDARD
        .decode(signature.trim())
        .map_err(|_| invalid("signature : base64 attendu"))?;
    broadcast(&state, &me, &bytes, &sig).await
}

#[cfg(test)]
mod tests {
    use super::*;

    const ME: &str = "14CCvQzQzHCVgZM3j9soPnXuJXh1RmCfwLVUcdfbZVBS";
    const VOTE: &str = "ETxHeBBcuw9Yu4dGuP3oXrD12V5RECvmi8ogQ9PkjyVF";
    const BH: &str = "2p4rYZAaFfV5Uk5ugdG5KPNty9Uda9B3b4gWB8qnNqak";

    #[test]
    fn classify_accepts_only_kyro_operations() {
        let ops = [
            SolStakeOp::CreateAndDelegate {
                seed: "kyro-stake-0".into(),
                lamports: 1_001_666_240,
                vote_account: VOTE.into(),
            },
            SolStakeOp::Deactivate {
                stake_account: VOTE.into(),
            },
            SolStakeOp::Withdraw {
                stake_account: VOTE.into(),
                lamports: 5,
            },
            SolStakeOp::Delegate {
                stake_account: VOTE.into(),
                vote_account: VOTE.into(),
            },
        ];
        for op in ops {
            let m = wallet_core::sol_stake_message(ME, &op, BH).unwrap();
            let s = wallet_core::sol_decode_message(&m, &[], ME).unwrap();
            assert_eq!(classify(&s, ME).unwrap(), op);
        }
        // A plain SOL transfer is not a staking operation.
        let mut s = wallet_core::sol_decode_message(
            &wallet_core::sol_stake_message(
                ME,
                &SolStakeOp::Deactivate {
                    stake_account: VOTE.into(),
                },
                BH,
            )
            .unwrap(),
            &[],
            ME,
        )
        .unwrap();
        s.instructions = vec![SolInstruction::SystemTransfer {
            from: ME.into(),
            to: VOTE.into(),
            lamports: "1".into(),
        }];
        assert!(classify(&s, ME).is_err());
        // Two operations in one message.
        let m = wallet_core::sol_stake_message(
            ME,
            &SolStakeOp::Deactivate {
                stake_account: VOTE.into(),
            },
            BH,
        )
        .unwrap();
        let mut s2 = wallet_core::sol_decode_message(&m, &[], ME).unwrap();
        s2.instructions.push(s2.instructions[0].clone());
        assert!(classify(&s2, ME).is_err());
        // Another fee payer.
        let mut s3 = wallet_core::sol_decode_message(&m, &[], ME).unwrap();
        s3.fee_payer = VOTE.into();
        assert!(classify(&s3, ME).is_err());
    }

    fn preview_of(kind: &'static str, warnings: Vec<SolStakeWarning>) -> SolStakePreview {
        SolStakePreview {
            kind,
            stake_account: "STAKE".into(),
            seed: Some("kyro-stake-0".into()),
            lamports: Some("1001666240".into()),
            delegated: Some("1000000000".into()),
            rent_exempt_reserve: "1666240".into(),
            validator: Some(SolValidator {
                vote_account: VOTE.into(),
                identity: "NODE".into(),
                name: Some("Test".into()),
                commission: 100,
                activated_stake: "5000000000000".into(),
                delinquent: true,
                last_vote: 1,
                epoch_vote_account: true,
            }),
            account: None,
            balance: "1499915000".into(),
            fee: "5000".into(),
            epoch: SolEpoch {
                epoch: 1196,
                slot_index: 100_000,
                slots_in_epoch: 432_000,
                absolute_slot: 1,
                seconds_left: 132_800,
            },
            closes_account: false,
            requires_extra_confirmation: !warnings.is_empty(),
            warnings,
        }
    }

    #[test]
    fn dialog_text() {
        let p = preview_of(
            "createAndDelegate",
            vec![
                SolStakeWarning::Delinquent,
                SolStakeWarning::HighCommission { commission: 100 },
            ],
        );
        let d = describe(&p, Network::Testnet);
        for needle in [
            "Staking Solana devnet (test)",
            "créer un compte de staking et le déléguer",
            "seed « kyro-stake-0 »",
            "Montant délégué : 1 SOL",
            "Réserve de rent (récupérée au retrait) : 0,00166624 SOL",
            "Validateur (compte de vote) : ETxHeBBcuw9Yu4dGuP3oXrD12V5RECvmi8ogQ9PkjyVF",
            "« Test » (déclaré par le validateur, non vérifié)",
            "Commission : 100 %",
            "EN RETARD",
            "Époque actuelle : 1196 (fin dans ≈ 36 h)",
            "au début de l'époque 1197",
            "Pas de slashing",
        ] {
            assert!(d.contains(needle), "{needle} missing in:\n{d}");
        }
        let x = describe_extra(&p);
        assert!(x.contains("delinquent") && x.contains("tu ne recevrais RIEN"));
        let mut w = preview_of("withdraw", vec![]);
        w.closes_account = true;
        assert!(describe(&w, Network::Mainnet).contains("le compte est fermé"));
        assert!(
            describe(&preview_of("deactivate", vec![]), Network::Testnet)
                .contains("retrait possible à partir de l'époque 1197")
        );
    }
}

/// Real devnet staking through the Rust path of the `sol_stake_*` commands (Kyro builds the
/// message, `prepare_sign` decodes it and re-reads everything live, dialog text, signature
/// verified, `broadcast` checks and sends), over Tor. Wallet: the public Trezor test mnemonic
/// (`all × 12`, `14CCvQzQ…`), which holds devnet SOL (devnet's minimum delegation is 1 SOL; the
/// public "abandon" wallet has less). Sequence: create + delegate (minimum), deactivate in the
/// same epoch (never activated, so immediately withdrawable), withdraw everything back.
/// `KYRO_SOL_STAKE=yes cargo test -p kyro-desktop --lib -- --ignored --nocapture sol_stake_live`
#[cfg(test)]
mod live {
    use super::*;
    use crate::tor::TorState;

    const ALL: &str = "all all all all all all all all all all all all";

    async fn sign_and_send(
        state: &AppState,
        seed: &wallet_core::Seed,
        me: &str,
        built: &SolStakeBuilt,
        label: &str,
    ) -> String {
        let bytes = solana::message_bytes(&built.message).unwrap();
        let (summary, p) = prepare_sign(state, me, &bytes).await.unwrap();
        assert_eq!(summary, built.summary, "{label}: same decode at signing");
        eprintln!(
            "--- {label}: dialog ---\n{}\n---",
            describe(&p, Network::Testnet)
        );
        if p.requires_extra_confirmation {
            eprintln!("--- {label}: reinforced ---\n{}\n---", describe_extra(&p));
        }
        let sig = wallet_core::sol_sign_message(seed, 0, &bytes).unwrap();
        wallet_core::sol_verify_signature(me, &bytes, &sig).unwrap();
        if std::env::var("KYRO_SOL_STAKE").as_deref() != Ok("yes") {
            eprintln!("{label}: KYRO_SOL_STAKE != yes, not sent");
            return String::new();
        }
        let id = broadcast(state, me, &bytes, &sig).await.unwrap();
        for _ in 0..45 {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            let st = rpc(
                state,
                "getSignatureStatuses",
                json!([[id], { "searchTransactionHistory": true }]),
            )
            .await
            .unwrap();
            let s = &st["value"][0];
            if s["confirmationStatus"] == "confirmed" || s["confirmationStatus"] == "finalized" {
                assert!(s["err"].is_null(), "{label}: {s}");
                eprintln!("{label}: CONFIRMED {id} (slot {})", s["slot"]);
                return id;
            }
        }
        panic!("{label}: {id} not confirmed");
    }

    #[test]
    #[ignore]
    fn sol_stake_live_devnet() {
        let dir = std::env::temp_dir().join("kyro-sol-stake-live");
        let _ = std::fs::create_dir_all(&dir);
        let state = AppState::new(dir).unwrap();
        assert_eq!(state.network, Network::Testnet);
        let seed = wallet_core::Mnemonic::parse(ALL).unwrap().to_seed("");
        let me = wallet_core::sol_address(&seed, 0).unwrap();
        tauri::async_runtime::block_on(async {
            state.net.tor.restart();
            while state.net.tor.status().state != TorState::Ready {
                assert_ne!(state.net.tor.status().state, TorState::Error);
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            }
            let ov = overview(&state, &me).await.unwrap();
            eprintln!(
                "overview: balance {} min delegation {} rent {} epoch {:?}\naccounts {:#?}",
                ov.balance, ov.minimum_delegation, ov.rent_exempt_reserve, ov.epoch, ov.accounts
            );
            let vals = vote_accounts(&state).await.unwrap();
            let names = validator_names(&state, None).await;
            eprintln!(
                "{} vote accounts; validator-info names: {}",
                vals.len(),
                names
                    .as_ref()
                    .map(|n| n.len().to_string())
                    .unwrap_or_else(|e| format!("{e:?}"))
            );
            let v = vals
                .iter()
                .filter(|v| !v.delinquent && v.epoch_vote_account)
                .min_by_key(|v| v.commission)
                .expect("a voting validator")
                .clone();
            eprintln!("chosen validator {v:?}");
            // 1. Create + delegate the minimum.
            let built = build(
                &state,
                &me,
                &SolStakeRequest::CreateAndDelegate {
                    lamports: ov.minimum_delegation.clone(),
                    vote_account: v.vote_account.clone(),
                },
            )
            .await
            .unwrap();
            let stake_acc = built.stake.stake_account.clone();
            eprintln!(
                "message {} bytes, stake account {stake_acc}",
                built.message.len() * 3 / 4
            );
            let t1 = sign_and_send(&state, &seed, &me, &built, "create+delegate").await;
            if t1.is_empty() {
                return;
            }
            eprintln!("SOL STAKE CREATE+DELEGATE: {t1}");
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            // 2. Deactivate.
            let built = build(
                &state,
                &me,
                &SolStakeRequest::Deactivate {
                    stake_account: stake_acc.clone(),
                },
            )
            .await
            .unwrap();
            let t2 = sign_and_send(&state, &seed, &me, &built, "deactivate").await;
            eprintln!("SOL STAKE DEACTIVATE: {t2}");
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            let ov = overview(&state, &me).await.unwrap();
            let pos = ov.accounts.iter().find(|a| a.address == stake_acc).unwrap();
            eprintln!("after deactivate: {pos:#?}");
            // 3. Withdraw everything back (possible at once if still in the activation epoch).
            if !pos.can_close {
                eprintln!("not withdrawable yet (epoch changed between delegation and deactivation): withdraw after the cool-down");
                return;
            }
            let built = build(
                &state,
                &me,
                &SolStakeRequest::Withdraw {
                    stake_account: stake_acc.clone(),
                    lamports: None,
                },
            )
            .await
            .unwrap();
            assert!(built.stake.closes_account);
            let t3 = sign_and_send(&state, &seed, &me, &built, "withdraw").await;
            eprintln!("SOL STAKE WITHDRAW: {t3}");
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            eprintln!("final balance {}", balance(&state, &me).await.unwrap());
        });
    }
}
