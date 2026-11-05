// SPDX-License-Identifier: GPL-3.0-or-later
//! Bitcoin time locks: the list beside the vault, the "Find my locks" scan, and the commands.
//! Script, keys and signing are in `wallet_core::btc_lock`; docs/BTC_TIMELOCK.md explains the whole.
//!
//! The file `<vault>.btclocks` only holds what makes the screen quick: account, date, last known
//! amount. The address is not in it: it is always derived again from the seed, so the file cannot
//! redirect anything, and it can be lost: the scan rebuilds it from the phrase alone.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, State};
use wallet_core::{
    btc_lock_addresses, btc_lock_check_funding, btc_lock_check_window, btc_lock_day, btc_lock_info,
    btc_lock_is_open, btc_lock_last_day, btc_lock_plan_withdraw, btc_lock_sign_funding,
    btc_lock_sign_plan, btc_lock_utc_date, BtcKind, BtcLockAddress, BtcLockInfo, BtcLockPlan,
    BtcLockUtxo, Network, Seed, BTC_HIGH_FEE_SAT_PER_VB, BTC_LOCK_FIRST_DAY,
};
use zeroize::Zeroizing;

use crate::accounts::{account_arg, btc_paths, confirm_signer, Chain, SignerInfo};
use crate::btc_backend::{self, Ctx, Tip};
use crate::commands::{
    blocking, confirm_native, describe_btc, describe_btc_extra, seed_from_password,
};
use crate::commands_servers::ctx;
use crate::error::{AppError, AppResult};
use crate::i18n::Lang;
use crate::servers::BtcServer;
use crate::spend_value::Spend;
use crate::state::AppState;

const FILE_VERSION: u8 = 1;
const MAX_LOCKS: usize = 20_000;
/// Dates per scan call, so the screen can show progress and resume.
const SCAN_CHUNK_DAYS: u32 = 120;
/// The withdrawal goes to the first unused receive address among these. The app's normal scan walks
/// indices 0 .. lastUsed + gap (`gapScan.ts`, gap 5), so 0 to 4 are the only ones it reaches whatever
/// a server says: past them a server reporting addresses as used could send the coins where an
/// honest scan never looks. Reusing index 4 costs some privacy, never the coins.
const LAST_FRESH_INDEX: u32 = 4;
/// Coins remembered per lock, for a Bitcoin Core node that cannot list them itself.
const MAX_KEPT_COINS: usize = 500;

static STORE_LOCK: Mutex<()> = Mutex::new(());

fn guard(m: &Mutex<()>) -> MutexGuard<'_, ()> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub account: u32,
    pub t: u32,
    /// Last amount seen, shown while the server cannot be reached.
    pub last_sats: u64,
    /// Kyro sent the withdrawal.
    pub withdrawn: bool,
    /// Seen confirmed at least once: a server that later knows nothing of it is not believed.
    pub seen: bool,
    /// Bitcoin Core only: confirmed coins, so that a pruned node that could not rescan them still
    /// reads them with `gettxout`. Empty with any other server.
    pub coins: Vec<BtcLockUtxo>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Store {
    version: u8,
    locks: Vec<Record>,
}

impl Default for Store {
    fn default() -> Self {
        Store {
            version: FILE_VERSION,
            locks: Vec::new(),
        }
    }
}

/// First name free beside the list: earlier damaged files are never overwritten.
fn damaged_path(path: &Path) -> PathBuf {
    let first = path.with_extension("btclocks.damaged");
    if !first.exists() {
        return first;
    }
    (1u32..)
        .map(|n| path.with_extension(format!("btclocks.damaged.{n}")))
        .find(|p| !p.exists())
        .unwrap_or(first)
}

/// `true` as second value: the file was unreadable, and set aside: a scan rebuilds the list. A disk
/// that cannot be read is an error: an empty list here would be saved over the real one.
fn load(path: &Path) -> AppResult<(Store, bool)> {
    let raw = match fs::read(path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok((Store::default(), false)),
        Err(e) => {
            return Err(AppError::Internal(format!(
                "lock list unreadable: {}",
                e.kind()
            )))
        }
    };
    match serde_json::from_slice::<Store>(&raw) {
        Ok(s) if s.version == FILE_VERSION && s.locks.len() <= MAX_LOCKS => Ok((s, false)),
        _ => {
            fs::rename(path, damaged_path(path))
                .map_err(|e| AppError::Internal(format!("lock list set aside: {}", e.kind())))?;
            Ok((Store::default(), true))
        }
    }
}

fn save(path: &Path, store: &Store) -> AppResult<()> {
    crate::settings::write_atomic(path, &serde_json::to_vec(store)?)
}

fn update<T>(path: &Path, f: impl FnOnce(&mut Store) -> T) -> AppResult<T> {
    let _lock = guard(&STORE_LOCK);
    let (mut store, _) = load(path)?;
    let before = store.clone();
    let out = f(&mut store);
    if store != before {
        save(path, &store)?;
    }
    Ok(out)
}

/// One date is one address: a second lock on the same date joins the same record.
fn upsert(store: &mut Store, info: &BtcLockInfo, sats: u64) {
    let found = store
        .locks
        .iter_mut()
        .find(|r| r.account == info.account && r.t == info.t);
    match found {
        Some(r) => r.last_sats = r.last_sats.saturating_add(sats),
        None => store.locks.push(Record {
            account: info.account,
            t: info.t,
            last_sats: sats,
            withdrawn: false,
            seen: false,
            coins: Vec::new(),
        }),
    }
}

fn add_coins(store: &mut Store, info: &BtcLockInfo, coins: &[BtcLockUtxo]) {
    if coins.is_empty() {
        return;
    }
    if let Some(r) = store
        .locks
        .iter_mut()
        .find(|r| r.account == info.account && r.t == info.t)
    {
        for c in coins {
            if r.coins.len() < MAX_KEPT_COINS
                && !r.coins.iter().any(|k| k.txid == c.txid && k.vout == c.vout)
            {
                r.coins.push(c.clone());
            }
        }
        r.seen = true;
        if r.last_sats == 0 {
            r.last_sats = coins.iter().fold(0u64, |s, c| s.saturating_add(c.value));
        }
    }
}

pub fn file_of(state: &AppState) -> PathBuf {
    state.active_vault_path().with_extension("btclocks")
}

/// A coin of a lock as the server sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Coin {
    pub utxo: BtcLockUtxo,
    pub confirmed: bool,
}

/// What the server knows about an address.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AddrView {
    pub coins: Vec<Coin>,
    pub tx_count: u64,
}

/// What one date of the grid holds or held.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GridAnswer {
    pub used: bool,
    /// The coins, when the server gives them in the same answer.
    pub coins: Vec<BtcLockUtxo>,
}

/// The little the lock logic needs from a Bitcoin server. Real servers go through
/// [`Backend`]; the node tests plug in a real `bitcoind`.
#[allow(async_fn_in_trait)]
pub trait LockChain {
    async fn tip(&self) -> AppResult<Tip>;
    /// Called before reading these locks. A server that must be told what to watch does it here,
    /// and answers with the coins it found while at it.
    async fn adopt(&self, _: &[BtcLockInfo]) -> AppResult<Vec<(String, Vec<BtcLockUtxo>)>> {
        Ok(Vec::new())
    }
    /// `known`: the coins of this lock read earlier.
    async fn view(&self, info: &BtcLockInfo, known: &[BtcLockUtxo]) -> AppResult<AddrView>;
    /// Whether a wallet address of this seed has been used.
    async fn wallet_address_used(&self, address: &str) -> AppResult<bool>;
    /// For each date of the grid, what it holds. Fails rather than guess.
    async fn grid_used(&self, grid: &[BtcLockAddress]) -> AppResult<Vec<GridAnswer>>;
    async fn broadcast(&self, hex: &str) -> AppResult<String>;
    /// How many days of the grid one call should cover.
    fn chunk_days(&self) -> u32 {
        SCAN_CHUNK_DAYS
    }
    /// Whether confirmed coins must be remembered (see [`Record::coins`]).
    fn keeps_coins(&self) -> bool {
        false
    }
}

pub struct Backend<'a>(pub Ctx<'a>);

fn parse_view(utxos: &Value, info: &Value) -> AppResult<AddrView> {
    let bad = || AppError::ServerUnreachable("unexpected server answer".into());
    let mut coins = Vec::new();
    for u in utxos.as_array().ok_or_else(bad)? {
        coins.push(Coin {
            utxo: BtcLockUtxo {
                txid: u["txid"].as_str().ok_or_else(bad)?.to_owned(),
                vout: u["vout"]
                    .as_u64()
                    .and_then(|v| u32::try_from(v).ok())
                    .ok_or_else(bad)?,
                value: u["value"].as_u64().ok_or_else(bad)?,
            },
            confirmed: u["status"]["confirmed"].as_bool().unwrap_or(false),
        });
    }
    Ok(AddrView {
        coins,
        tx_count: btc_backend::tx_count_of(info)?,
    })
}

impl LockChain for Backend<'_> {
    async fn tip(&self) -> AppResult<Tip> {
        btc_backend::tip_info(&self.0).await
    }

    async fn adopt(&self, locks: &[BtcLockInfo]) -> AppResult<Vec<(String, Vec<BtcLockUtxo>)>> {
        let Some((c, wallet)) = btc_backend::core_for_locks(&self.0).await? else {
            return Ok(Vec::new());
        };
        let scripts: Vec<String> = locks.iter().map(|l| l.script_pubkey.clone()).collect();
        btc_backend::core_locks_adopt(&c, &wallet, &scripts).await
    }

    async fn view(&self, info: &BtcLockInfo, known: &[BtcLockUtxo]) -> AppResult<AddrView> {
        if let Some((c, wallet)) = btc_backend::core_for_locks(&self.0).await? {
            return btc_backend::core_lock_view(&c, &wallet, &info.address, known).await;
        }
        let utxos = btc_backend::address_utxos(&self.0, &info.address).await?;
        let data = btc_backend::address_info(&self.0, &info.address).await?;
        parse_view(&utxos, &data)
    }

    async fn wallet_address_used(&self, address: &str) -> AppResult<bool> {
        let data = btc_backend::address_info(&self.0, address).await?;
        Ok(btc_backend::tx_count_of(&data)? > 0)
    }

    async fn grid_used(&self, grid: &[BtcLockAddress]) -> AppResult<Vec<GridAnswer>> {
        if let Some((c, wallet)) = btc_backend::core_for_locks(&self.0).await? {
            return core_grid(&c, &wallet, grid).await;
        }
        let addresses: Vec<String> = grid.iter().map(|g| g.address.clone()).collect();
        let used = btc_backend::addresses_used(&self.0, &addresses).await?;
        Ok(used
            .into_iter()
            .map(|used| GridAnswer {
                used,
                coins: Vec::new(),
            })
            .collect())
    }

    async fn broadcast(&self, hex: &str) -> AppResult<String> {
        btc_backend::broadcast(&self.0, hex).await
    }

    /// `scantxoutset` reads the whole UTXO set whatever it looks for: one pass for every date.
    fn chunk_days(&self) -> u32 {
        if matches!(self.0.server, BtcServer::Core { .. }) {
            u32::MAX
        } else {
            SCAN_CHUNK_DAYS
        }
    }

    fn keeps_coins(&self) -> bool {
        matches!(self.0.server, BtcServer::Core { .. })
    }
}

/// One pass of the UTXO set for the whole grid, and every hit watched from then on.
pub async fn core_grid(
    c: &crate::core_rpc::CoreClient<'_>,
    wallet: &str,
    grid: &[BtcLockAddress],
) -> AppResult<Vec<GridAnswer>> {
    let scripts: Vec<String> = grid.iter().map(|g| g.script_pubkey.clone()).collect();
    let found = btc_backend::core_lock_scan(c, &scripts).await?;
    let mut out = Vec::with_capacity(grid.len());
    for script in &scripts {
        let mine: Vec<_> = found
            .iter()
            .filter(|f| f.script_pubkey == *script)
            .collect();
        if let Some(height) = mine.iter().map(|f| f.height).min() {
            // The UTXO set has answered: a node that cannot rescan must not fail the search.
            let _ = btc_backend::core_lock_watch(c, wallet, script, Some(height)).await;
        }
        out.push(GridAnswer {
            used: !mine.is_empty(),
            coins: mine.iter().map(|f| f.utxo.clone()).collect(),
        });
    }
    Ok(out)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    /// Sent, not yet in a block. Until it is, it can still be replaced.
    Confirming,
    Locked,
    Ready,
    Withdrawn,
    /// Signed here, not seen by the server: never sent, or replaced.
    NotFound,
    /// The server could not be reached.
    Unknown,
}

pub fn status_of(view: &AddrView, t: u32, mtp: u64, record: &Record) -> Status {
    if view.coins.iter().any(|c| c.confirmed) {
        if btc_lock_is_open(t, mtp) {
            Status::Ready
        } else {
            Status::Locked
        }
    } else if !view.coins.is_empty() {
        Status::Confirming
    } else if view.tx_count > 0 || record.withdrawn {
        Status::Withdrawn
    } else if record.seen {
        // It was confirmed and this server has never heard of it: that says nothing of the coins.
        Status::Unknown
    } else {
        Status::NotFound
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LockView {
    t: u32,
    day: u32,
    account: u32,
    address: String,
    amount_sats: u64,
    status: Status,
    /// Coins at the address.
    coins: usize,
    /// Part of the amount not confirmed yet: a withdrawal leaves it for later.
    unconfirmed_sats: u64,
    /// Seconds until the network's clock (median time past) reaches the date.
    secs_left: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocksStatus {
    locks: Vec<LockView>,
    /// What is locked or ready, in sats. Never part of the spendable balance.
    locked_sats: u64,
    /// The server failed: amounts are the last ones seen.
    stale: bool,
    /// The list was unreadable and was set aside: a scan rebuilds it.
    damaged: bool,
}

fn infos(seed: &Seed, net: Network, records: &[Record]) -> AppResult<Vec<BtcLockInfo>> {
    records
        .iter()
        .map(|r| Ok(btc_lock_info(seed, net, r.account, r.t)?))
        .collect()
}

/// Saves what `adopt` found, and hands the records back.
fn remember_adopted(
    path: &Path,
    infos: &[BtcLockInfo],
    adopted: &[(String, Vec<BtcLockUtxo>)],
) -> AppResult<()> {
    update(path, |store| {
        for (script, coins) in adopted {
            if let Some(info) = infos.iter().find(|i| i.script_pubkey == *script) {
                add_coins(store, info, coins);
            }
        }
    })
}

pub async fn read_status<C: LockChain>(
    chain: &C,
    path: &Path,
    lock_infos: &[BtcLockInfo],
    damaged: bool,
) -> AppResult<LocksStatus> {
    let empty = {
        let _lock = guard(&STORE_LOCK);
        load(path)?.0.locks.is_empty()
    };
    if empty {
        return Ok(LocksStatus {
            locks: Vec::new(),
            locked_sats: 0,
            stale: false,
            damaged,
        });
    }
    let tip = chain.tip().await;
    let adopted = chain.adopt(lock_infos).await;
    let reachable = tip.is_ok() && adopted.is_ok();
    if let Ok(found) = &adopted {
        remember_adopted(path, lock_infos, found)?;
    }
    let records = {
        let _lock = guard(&STORE_LOCK);
        load(path)?.0.locks
    };
    let mut locks = Vec::with_capacity(records.len());
    let mut seen = Vec::with_capacity(records.len());
    let mut stale = !reachable;
    for r in &records {
        let Some(info) = lock_infos
            .iter()
            .find(|i| i.t == r.t && i.account == r.account)
        else {
            continue;
        };
        let view = if reachable {
            chain.view(info, &r.coins).await
        } else {
            Err(AppError::ServerUnreachable(String::new()))
        };
        let mtp = tip.as_ref().map_or(0, |t| t.mtp);
        let (amount_sats, status, coins, unconfirmed_sats) = match view {
            Ok(v) => {
                let status = status_of(&v, r.t, mtp, r);
                let add = |s: u64, c: &Coin| s.saturating_add(c.utxo.value);
                let sum = v.coins.iter().fold(0u64, add);
                let pending = v.coins.iter().filter(|c| !c.confirmed).fold(0u64, add);
                let confirmed: Vec<BtcLockUtxo> = v
                    .coins
                    .iter()
                    .filter(|c| c.confirmed)
                    .map(|c| c.utxo.clone())
                    .collect();
                if !matches!(status, Status::Unknown | Status::NotFound) {
                    seen.push((r.account, r.t, sum, confirmed));
                }
                // Nothing read: the last amount stays on screen, it is not news that it is zero.
                let shown = if matches!(status, Status::Unknown | Status::NotFound) {
                    r.last_sats
                } else {
                    sum
                };
                (shown, status, v.coins.len(), pending)
            }
            Err(_) => {
                stale = true;
                (r.last_sats, Status::Unknown, 0, 0)
            }
        };
        stale |= status == Status::Unknown;
        locks.push(LockView {
            t: r.t,
            day: info.day,
            account: r.account,
            address: info.address.clone(),
            amount_sats,
            status,
            coins,
            unconfirmed_sats,
            secs_left: u64::from(r.t).saturating_sub(mtp),
        });
    }
    locks.sort_by_key(|l| (l.t, l.account));
    let keep = chain.keeps_coins();
    update(path, |store| {
        for r in &mut store.locks {
            let hit = seen.iter().find(|(a, t, ..)| *a == r.account && *t == r.t);
            if let Some((_, _, sats, confirmed)) = hit {
                r.last_sats = *sats;
                r.seen |= !confirmed.is_empty();
                if keep && !confirmed.is_empty() {
                    r.coins.clone_from(confirmed);
                    r.coins.truncate(MAX_KEPT_COINS);
                }
            }
        }
    })?;
    let locked_sats = locks
        .iter()
        .filter(|l| {
            matches!(
                l.status,
                Status::Confirming | Status::Locked | Status::Ready | Status::Unknown
            )
        })
        .fold(0u64, |s, l| s.saturating_add(l.amount_sats));
    Ok(LocksStatus {
        locks,
        locked_sats,
        stale,
        damaged,
    })
}

/// Walks one stretch of the day grid. Returns where to go on, and what it added.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanStep {
    /// `None`: the whole grid was asked about and every answer came back.
    pub(crate) next_day: Option<u32>,
    pub(crate) first_day: u32,
    pub(crate) last_day: u32,
    pub(crate) found: u32,
}

pub async fn scan_step<C: LockChain>(
    chain: &C,
    path: &Path,
    seed: &Seed,
    net: Network,
    account: u32,
    from_day: Option<u32>,
    clock: u64,
) -> AppResult<ScanStep> {
    // The end of the grid cannot rest on this computer's clock alone: running late, it would leave
    // the last dates out and still call the search finished.
    let tip = chain.tip().await?;
    let first_day = BTC_LOCK_FIRST_DAY;
    let last_day = btc_lock_last_day(clock.max(tip.time));
    let from = from_day.unwrap_or(first_day).max(first_day);
    if last_day < first_day || from > last_day {
        return Err(AppError::InvalidInput(
            "nothing to search: check this computer's date".into(),
        ));
    }
    let to = from
        .saturating_add(chain.chunk_days().saturating_sub(1))
        .min(last_day);
    let grid = btc_lock_addresses(seed, net, account, from, to)?;
    if grid.is_empty() {
        return Err(AppError::Internal("empty search range".into()));
    }
    let answers = chain.grid_used(&grid).await?;
    if answers.len() != grid.len() {
        return Err(AppError::ServerUnreachable("incomplete answer".into()));
    }
    let mut found = 0;
    for (g, hit) in grid.iter().zip(answers) {
        if hit.used {
            let t = wallet_core::btc_lock_time_of_day(g.day)
                .ok_or_else(|| AppError::Internal("day out of range".into()))?;
            let info = btc_lock_info(seed, net, account, t)?;
            update(path, |s| {
                upsert(s, &info, 0);
                add_coins(s, &info, &hit.coins);
            })?;
            found += 1;
        }
    }
    Ok(ScanStep {
        next_day: (to < last_day).then_some(to + 1),
        first_day,
        last_day,
        found,
    })
}

/// First unused receive address of this account, derived here: no address comes from outside.
async fn fresh_index<C: LockChain>(
    chain: &C,
    seed: &Seed,
    net: Network,
    account: u32,
) -> AppResult<u32> {
    for i in 0..LAST_FRESH_INDEX {
        let address = wallet_core::btc_address(seed, net, BtcKind::Segwit, account, false, i)?;
        if !chain.wallet_address_used(&address).await? {
            return Ok(i);
        }
    }
    Ok(LAST_FRESH_INDEX)
}

/// What a withdrawal would do, with nothing signed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Withdrawal {
    pub plan: BtcLockPlan,
    /// Coins of this lock not confirmed yet. They could be replaced under the spend, so they stay
    /// for the next withdrawal.
    pub unconfirmed_sats: u64,
}

/// The withdrawal of the confirmed coins of a lock.
pub async fn plan_withdraw<C: LockChain>(
    chain: &C,
    path: &Path,
    seed: &Seed,
    net: Network,
    account: u32,
    t: u32,
    sat_per_vb: u64,
) -> AppResult<Withdrawal> {
    let info = btc_lock_info(seed, net, account, t)?;
    let tip = chain.tip().await?;
    let one = std::slice::from_ref(&info);
    let adopted = chain.adopt(one).await?;
    remember_adopted(path, one, &adopted)?;
    let known = {
        let _lock = guard(&STORE_LOCK);
        load(path)?
            .0
            .locks
            .into_iter()
            .find(|r| r.account == account && r.t == t)
            .map_or_else(Vec::new, |r| r.coins)
    };
    let view = chain.view(&info, &known).await?;
    let (ready, pending): (Vec<Coin>, Vec<Coin>) =
        view.coins.into_iter().partition(|c| c.confirmed);
    let coins: Vec<BtcLockUtxo> = ready.into_iter().map(|c| c.utxo).collect();
    let index = fresh_index(chain, seed, net, account).await?;
    let plan = btc_lock_plan_withdraw(seed, net, account, t, &coins, index, sat_per_vb, tip.mtp)?;
    Ok(Withdrawal {
        plan,
        unconfirmed_sats: pending
            .iter()
            .fold(0u64, |s, c| s.saturating_add(c.utxo.value)),
    })
}

fn refuse_cbf(state: &AppState) -> AppResult<()> {
    if matches!(
        state.settings().servers.bitcoin_for(state.network),
        BtcServer::Cbf { .. }
    ) {
        return Err(AppError::InvalidInput(
            crate::i18n::current()
                .pick(
                    "Les blocages ont besoin d'un serveur Bitcoin : le mode filtres compacts ne les voit pas.",
                    "Locks need a Bitcoin server: compact filter mode cannot see them.",
                )
                .into(),
        ));
    }
    Ok(())
}

fn require_unlocked(state: &AppState) -> AppResult<()> {
    if state.is_unlocked() {
        Ok(())
    } else {
        Err(AppError::Locked)
    }
}

fn btc_text(lang: Lang, sats: u64) -> String {
    crate::commands::format_units_in(lang, &sats.to_string(), 8)
}

fn lock_head(lang: Lang, info: &BtcLockInfo, sats: u64) -> String {
    let date = btc_lock_utc_date(info.t);
    let amount = btc_text(lang, sats);
    let address = &info.address;
    match lang {
        Lang::Fr => format!(
            "BLOCAGE BITCOIN\n\n{amount} BTC bloqués jusqu'au {date} à 00:00 UTC, disponibles environ 1 à 2 h après.\nAdresse recalculée par Kyro : {address}\n\nUne fois confirmé, personne ne peut annuler ni raccourcir ce blocage, pas même avec la phrase de récupération. La phrase reste nécessaire pour récupérer les fonds.\n\n"
        ),
        Lang::En => format!(
            "BITCOIN LOCK\n\n{amount} BTC locked until {date} at 00:00 UTC, available about 1 to 2 hours later.\nAddress recomputed by Kyro: {address}\n\nOnce confirmed, nobody can cancel or shorten this lock, not even with the recovery phrase. The phrase stays necessary to get the funds back.\n\n"
        ),
    }
}

fn withdraw_body(lang: Lang, info: &BtcLockInfo, w: &Withdrawal) -> String {
    let s = &w.plan;
    let (amount, fee) = (btc_text(lang, s.amount_sats), btc_text(lang, s.fee_sats));
    let date = btc_lock_utc_date(info.t);
    let to = &s.destination;
    let left = match (s.left_out, lang) {
        (0, _) => String::new(),
        (n, Lang::Fr) => format!(
            "\n{n} petites pièces ({}) restent au blocage, pour un prochain retrait.",
            btc_text(lang, s.left_out_sats)
        ),
        (n, Lang::En) => format!(
            "\n{n} small coins ({}) stay at the lock, for a next withdrawal.",
            btc_text(lang, s.left_out_sats)
        ),
    };
    let pending = match (w.unconfirmed_sats, lang) {
        (0, _) => String::new(),
        (n, Lang::Fr) => format!(
            "\n{} BTC pas encore confirmés restent pour un prochain retrait.",
            btc_text(lang, n)
        ),
        (n, Lang::En) => format!(
            "\n{} BTC not confirmed yet stay for a next withdrawal.",
            btc_text(lang, n)
        ),
    };
    match lang {
        Lang::Fr => format!(
            "Retrait du blocage du {date}\n\nTu reçois : {amount} BTC\nFrais : {fee} BTC\nVers ton adresse : {to}{left}{pending}"
        ),
        Lang::En => format!(
            "Withdrawal of the lock of {date}\n\nYou receive: {amount} BTC\nFee: {fee} BTC\nTo your address: {to}{left}{pending}"
        ),
    }
}

/// Checks a date against both clocks and gives the address to pay. The address is for the screen:
/// the signature derives it again.
#[tauri::command]
pub async fn btc_lock_preview(
    state: State<'_, AppState>,
    t: u32,
    account: Option<u32>,
) -> AppResult<BtcLockInfo> {
    require_unlocked(&state)?;
    refuse_cbf(&state)?;
    let a = account_arg(account)?;
    btc_lock_day(t)?;
    let s = state.settings();
    let tip = btc_backend::tip_info(&ctx(&state, &s)?).await?;
    btc_lock_check_window(t, now(), tip.time)?;
    let net = state.network;
    state.with_seed(|seed| Ok(btc_lock_info(seed, net, a, t)?))
}

#[derive(Serialize)]
pub struct LockSigned {
    psbt: String,
    summary: wallet_core::BtcTxSummary,
}

/// The only way to fund a lock. `confirm_word` is what the user typed.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn btc_lock_sign_funding_tx(
    app: AppHandle,
    state: State<'_, AppState>,
    psbt: String,
    password: String,
    account: Option<u32>,
    t: u32,
    amount_sats: u64,
    confirm_word: String,
) -> AppResult<LockSigned> {
    require_unlocked(&state)?;
    refuse_cbf(&state)?;
    let word = confirm_word.trim();
    if word != "BLOQUER" && word != "LOCK" {
        return Err(AppError::InvalidInput("confirmation word expected".into()));
    }
    let a = account_arg(account)?;
    let net = state.network;
    let settings = state.settings();
    let backend = ctx(&state, &settings)?;
    let tip = btc_backend::tip_info(&backend).await?;
    btc_lock_check_window(t, now(), tip.time)?;
    let signer = SignerInfo::new(&state, Chain::Btc, a, btc_paths(net, a));
    let seed = seed_from_password(&state, Zeroizing::new(password)).await?;
    let (s, p) = (seed.clone(), psbt.clone());
    let (info, summary) = blocking(move || {
        let summary = btc_lock_check_funding(&s, net, a, t, amount_sats, &p)?;
        Ok((btc_lock_info(&s, net, a, t)?, summary))
    })
    .await?;
    let lang = crate::i18n::current();
    let head = lock_head(lang, &info, amount_sats);
    confirm_native(
        &app,
        lang.confirm_tx_title(),
        signer.body(lang, &(head + &describe_btc(lang, &summary))),
    )
    .await?;
    if summary.requires_extra_confirmation {
        confirm_native(
            &app,
            lang.check_tx_title(),
            describe_btc_extra(lang, &summary),
        )
        .await?;
    }
    // The node must watch the script before the coins go there.
    if let Some((c, wallet)) = btc_backend::core_for_locks(&backend).await? {
        btc_backend::core_lock_watch(&c, &wallet, &info.script_pubkey, None).await?;
    }
    confirm_signer(&app, &signer, crate::spend_value::btc(&summary)).await?;
    let (signed, again) =
        blocking(move || Ok(btc_lock_sign_funding(&seed, net, a, t, amount_sats, &psbt)?)).await?;
    if again != summary {
        return Err(AppError::Internal(
            "summary differs between the preview and the signature".into(),
        ));
    }
    // Written before the interface can broadcast: no coins without their line in the list.
    update(&file_of(&state), |store| {
        upsert(store, &info, amount_sats);
    })?;
    state.touch();
    Ok(LockSigned {
        psbt: signed,
        summary,
    })
}

#[tauri::command]
pub async fn btc_locks_status(state: State<'_, AppState>) -> AppResult<LocksStatus> {
    require_unlocked(&state)?;
    let path = file_of(&state);
    let net = state.network;
    let (records, damaged) = {
        let _lock = guard(&STORE_LOCK);
        load(&path)?
    };
    let list = state.with_seed(|seed| infos(seed, net, &records.locks))?;
    let settings = state.settings();
    if matches!(settings.servers.bitcoin_for(net), BtcServer::Cbf { .. }) {
        return read_status(&Offline, &path, &list, damaged).await;
    }
    read_status(&Backend(ctx(&state, &settings)?), &path, &list, damaged).await
}

/// Used when no server can answer: the list still shows the last amounts.
struct Offline;

impl LockChain for Offline {
    async fn tip(&self) -> AppResult<Tip> {
        Err(AppError::ServerUnreachable("no server".into()))
    }
    async fn view(&self, _: &BtcLockInfo, _: &[BtcLockUtxo]) -> AppResult<AddrView> {
        Err(AppError::ServerUnreachable("no server".into()))
    }
    async fn wallet_address_used(&self, _: &str) -> AppResult<bool> {
        Err(AppError::ServerUnreachable("no server".into()))
    }
    async fn grid_used(&self, _: &[BtcLockAddress]) -> AppResult<Vec<GridAnswer>> {
        Err(AppError::ServerUnreachable("no server".into()))
    }
    async fn broadcast(&self, _: &str) -> AppResult<String> {
        Err(AppError::ServerUnreachable("no server".into()))
    }
}

/// The exact descriptor, path, date and address, for the "Details" view.
#[tauri::command]
pub fn btc_lock_details(
    state: State<'_, AppState>,
    t: u32,
    account: Option<u32>,
) -> AppResult<BtcLockInfo> {
    require_unlocked(&state)?;
    let a = account_arg(account)?;
    let net = state.network;
    state.with_seed(|seed| Ok(btc_lock_info(seed, net, a, t)?))
}

/// One stretch of "Find my locks", on the active account. `from_day: None` starts over.
#[tauri::command]
pub async fn btc_locks_scan(
    state: State<'_, AppState>,
    from_day: Option<u32>,
    account: Option<u32>,
) -> AppResult<ScanStep> {
    require_unlocked(&state)?;
    refuse_cbf(&state)?;
    let a = account_arg(account)?;
    let net = state.network;
    let seed = state.with_seed(|seed| Ok(seed.clone()))?;
    let settings = state.settings();
    let chain = Backend(ctx(&state, &settings)?);
    let step = scan_step(&chain, &file_of(&state), &seed, net, a, from_day, now()).await?;
    state.touch();
    Ok(step)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WithdrawPreview {
    amount_sats: u64,
    fee_sats: u64,
    vsize: u64,
    destination: String,
    inputs: usize,
    left_out: usize,
    left_out_sats: u64,
    unconfirmed_sats: u64,
}

/// What a withdrawal would do. Refused while the network would refuse it. Signs nothing.
#[tauri::command]
pub async fn btc_lock_withdraw_preview(
    state: State<'_, AppState>,
    t: u32,
    account: Option<u32>,
    sat_per_vb: u64,
) -> AppResult<WithdrawPreview> {
    require_unlocked(&state)?;
    refuse_cbf(&state)?;
    let a = account_arg(account)?;
    let net = state.network;
    let seed = state.with_seed(|seed| Ok(seed.clone()))?;
    let settings = state.settings();
    let chain = Backend(ctx(&state, &settings)?);
    let w = plan_withdraw(&chain, &file_of(&state), &seed, net, a, t, sat_per_vb).await?;
    let s = w.plan;
    Ok(WithdrawPreview {
        amount_sats: s.amount_sats,
        fee_sats: s.fee_sats,
        vsize: s.vsize,
        destination: s.destination,
        inputs: s.coins.len(),
        left_out: s.left_out,
        left_out_sats: s.left_out_sats,
        unconfirmed_sats: w.unconfirmed_sats,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Withdrawn {
    txid: String,
    amount_sats: u64,
    fee_sats: u64,
    destination: String,
}

/// Shows the withdrawal, then signs and sends it. There is no destination argument.
#[tauri::command]
pub async fn btc_lock_withdraw(
    app: AppHandle,
    state: State<'_, AppState>,
    t: u32,
    account: Option<u32>,
    sat_per_vb: u64,
    password: String,
) -> AppResult<Withdrawn> {
    require_unlocked(&state)?;
    refuse_cbf(&state)?;
    let a = account_arg(account)?;
    let net = state.network;
    let signer = SignerInfo::new(&state, Chain::Btc, a, btc_paths(net, a));
    let seed = seed_from_password(&state, Zeroizing::new(password)).await?;
    let settings = state.settings();
    let chain = Backend(ctx(&state, &settings)?);
    let path = file_of(&state);
    let w = plan_withdraw(&chain, &path, &seed, net, a, t, sat_per_vb).await?;
    let info = btc_lock_info(&seed, net, a, t)?;
    let lang = crate::i18n::current();
    confirm_native(
        &app,
        lang.confirm_tx_title(),
        signer.body(lang, &withdraw_body(lang, &info, &w)),
    )
    .await?;
    let plan = w.plan;
    if sat_per_vb > BTC_HIGH_FEE_SAT_PER_VB || plan.fee_sats > plan.amount_sats {
        confirm_native(
            &app,
            lang.check_tx_title(),
            lang.pick(
                "Ces frais sont très élevés pour ce retrait. Les payer quand même ?",
                "This fee is very high for this withdrawal. Pay it anyway?",
            )
            .to_owned(),
        )
        .await?;
    }
    // The coins go to this wallet's own address: nothing leaves, so nothing counts.
    confirm_signer(&app, &signer, Spend::Free).await?;
    // Signed only now, after every dialog, and exactly what they showed.
    let signing = plan.clone();
    let spend = blocking(move || Ok(btc_lock_sign_plan(&seed, net, &signing)?)).await?;
    let txid = chain.broadcast(&spend.hex).await?;
    // The coins have left: a full disk must not turn that into an error on screen.
    let _ = update(&path, |store| {
        if let Some(r) = store.locks.iter_mut().find(|r| r.account == a && r.t == t) {
            r.withdrawn = true;
        }
    });
    state.touch();
    Ok(Withdrawn {
        txid,
        amount_sats: plan.amount_sats,
        fee_sats: plan.fee_sats,
        destination: plan.destination,
    })
}

/// A line of the backup file. The address is only here, in the encrypted file: it lets the import
/// tell lines of another seed apart.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupLock {
    pub account: u32,
    pub t: u32,
    pub last_sats: u64,
    pub withdrawn: bool,
    pub address: String,
}

/// The records for the backup file.
pub fn export_records(state: &AppState) -> AppResult<Vec<BackupLock>> {
    let net = state.network;
    let records = {
        let _lock = guard(&STORE_LOCK);
        load(&file_of(state))?.0.locks
    };
    state.with_seed(|seed| {
        records
            .into_iter()
            .map(|r| {
                Ok(BackupLock {
                    account: r.account,
                    t: r.t,
                    last_sats: r.last_sats,
                    withdrawn: r.withdrawn,
                    address: btc_lock_info(seed, net, r.account, r.t)?.address,
                })
            })
            .collect()
    })
}

/// Merges a backup's records, keeping only those this seed really derives. With Bitcoin Core as
/// the server, the next status read imports their scripts.
pub fn merge_records(state: &AppState, incoming: &[BackupLock]) -> AppResult<usize> {
    let net = state.network;
    let kept: Vec<(BtcLockInfo, BackupLock)> = state.with_seed(|seed| {
        Ok(incoming
            .iter()
            .filter_map(|r| {
                let info = btc_lock_info(seed, net, r.account, r.t).ok()?;
                (info.address == r.address).then(|| (info, r.clone()))
            })
            .collect())
    })?;
    let count = kept.len();
    update(&file_of(state), |store| merge_into(store, &kept))?;
    Ok(count)
}

fn merge_into(store: &mut Store, kept: &[(BtcLockInfo, BackupLock)]) {
    for (info, r) in kept {
        upsert(store, info, 0);
        if let Some(mine) = store
            .locks
            .iter_mut()
            .find(|m| m.account == r.account && m.t == r.t)
        {
            mine.last_sats = mine.last_sats.max(r.last_sats);
            mine.withdrawn |= r.withdrawn;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use wallet_core::{Mnemonic, BTC_LOCK_DAY_SECS};

    const PHRASE: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    const T: u32 = 1_804_982_400;
    /// 2026-11-05 00:00 UTC.
    const CLOCK: u64 = 1_793_836_800;

    fn seed() -> Seed {
        Mnemonic::parse(PHRASE).unwrap().to_seed("")
    }

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("kyro-lock-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d.join("v.btclocks")
    }

    fn coin(n: u8, value: u64, confirmed: bool) -> Coin {
        Coin {
            utxo: BtcLockUtxo {
                txid: format!("{n:02x}").repeat(32),
                vout: 0,
                value,
            },
            confirmed,
        }
    }

    struct Fake {
        coins: Vec<Coin>,
        tx_count: u64,
        mtp: u64,
        tip_time: u64,
        used: Vec<String>,
        fail_tip: bool,
        fail_adopt: bool,
        /// Answers this many stretches of the grid, then fails.
        grid_answers: Cell<u32>,
        asked: RefCell<Vec<(u32, u32)>>,
        tips: Cell<u32>,
    }

    impl Default for Fake {
        fn default() -> Self {
            Fake {
                coins: Vec::new(),
                tx_count: 0,
                mtp: 0,
                tip_time: CLOCK,
                used: Vec::new(),
                fail_tip: false,
                fail_adopt: false,
                grid_answers: Cell::new(u32::MAX),
                asked: RefCell::new(Vec::new()),
                tips: Cell::new(0),
            }
        }
    }

    impl LockChain for Fake {
        async fn tip(&self) -> AppResult<Tip> {
            self.tips.set(self.tips.get() + 1);
            if self.fail_tip {
                return Err(AppError::ServerUnreachable("down".into()));
            }
            Ok(Tip {
                height: 1,
                time: self.tip_time,
                mtp: self.mtp,
            })
        }
        async fn adopt(&self, _: &[BtcLockInfo]) -> AppResult<Vec<(String, Vec<BtcLockUtxo>)>> {
            if self.fail_adopt {
                return Err(AppError::ServerUnreachable("scan in progress".into()));
            }
            Ok(Vec::new())
        }
        async fn view(&self, _: &BtcLockInfo, _: &[BtcLockUtxo]) -> AppResult<AddrView> {
            Ok(AddrView {
                coins: self.coins.clone(),
                tx_count: self.tx_count,
            })
        }
        async fn wallet_address_used(&self, a: &str) -> AppResult<bool> {
            Ok(self.used.iter().any(|u| u == a))
        }
        async fn grid_used(&self, grid: &[BtcLockAddress]) -> AppResult<Vec<GridAnswer>> {
            let left = self.grid_answers.get();
            if left == 0 {
                return Err(AppError::ServerUnreachable("429".into()));
            }
            self.grid_answers.set(left - 1);
            self.asked
                .borrow_mut()
                .push((grid[0].day, grid.last().unwrap().day));
            Ok(grid
                .iter()
                .map(|g| GridAnswer {
                    used: self.used.contains(&g.address),
                    coins: Vec::new(),
                })
                .collect())
        }
        async fn broadcast(&self, _: &str) -> AppResult<String> {
            Ok("txid".into())
        }
    }

    fn run<F: std::future::Future>(f: F) -> F::Output {
        tauri::async_runtime::block_on(f)
    }

    fn view(coins: Vec<Coin>, tx_count: u64) -> AddrView {
        AddrView { coins, tx_count }
    }

    fn record() -> Record {
        Record {
            account: 0,
            t: T,
            last_sats: 100_000,
            withdrawn: false,
            seen: false,
            coins: Vec::new(),
        }
    }

    fn scan(chain: &Fake, path: &Path, from: Option<u32>, clock: u64) -> AppResult<ScanStep> {
        run(scan_step(
            chain,
            path,
            &seed(),
            Network::Testnet,
            0,
            from,
            clock,
        ))
    }

    fn plan(chain: &Fake, path: &Path) -> AppResult<Withdrawal> {
        run(plan_withdraw(
            chain,
            path,
            &seed(),
            Network::Testnet,
            0,
            T,
            2,
        ))
    }

    #[test]
    fn status_follows_the_chain() {
        let past = u64::from(T) + 1;
        let t = u64::from(T);
        let r = record();
        let confirmed = view(vec![coin(1, 5, true)], 1);
        let pending = view(vec![coin(1, 5, false)], 1);
        assert_eq!(status_of(&pending, T, past, &r), Status::Confirming);
        assert_eq!(status_of(&confirmed, T, t - 1, &r), Status::Locked);
        assert_eq!(status_of(&confirmed, T, t, &r), Status::Locked, "MTP = T");
        assert_eq!(status_of(&confirmed, T, past, &r), Status::Ready);
        assert_eq!(status_of(&view(vec![], 2), T, past, &r), Status::Withdrawn);
        let gone = Record {
            withdrawn: true,
            ..record()
        };
        assert_eq!(
            status_of(&view(vec![], 0), T, past, &gone),
            Status::Withdrawn
        );
        assert_eq!(status_of(&view(vec![], 0), T, t, &r), Status::NotFound);
        // A new deposit after a withdrawal shows again.
        assert_eq!(status_of(&confirmed, T, past, &gone), Status::Ready);
    }

    /// A server that knows nothing of a lock seen confirmed says nothing about the coins.
    #[test]
    fn a_confirmed_lock_a_server_forgot_is_unknown_not_gone() {
        let seen = Record {
            seen: true,
            ..record()
        };
        assert_eq!(status_of(&view(vec![], 0), T, 0, &seen), Status::Unknown);

        let path = dir("forgot");
        let i = info(0, T);
        update(&path, |s| {
            upsert(s, &i, 100_000);
            s.locks[0].seen = true;
        })
        .unwrap();
        let fresh = Fake::default();
        let st = run(read_status(&fresh, &path, std::slice::from_ref(&i), false)).unwrap();
        assert_eq!(st.locks[0].status, Status::Unknown);
        assert_eq!(st.locks[0].amount_sats, 100_000);
        assert_eq!(st.locked_sats, 100_000, "the Locked line stays");
        assert!(st.stale);
        assert_eq!(load(&path).unwrap().0.locks[0].last_sats, 100_000);
    }

    /// Switching to Bitcoin Core, or restoring on it, while the node is busy.
    #[test]
    fn a_node_that_cannot_adopt_a_lock_yet_never_drops_it() {
        let path = dir("adopt-fails");
        let i = info(0, T);
        update(&path, |s| upsert(s, &i, 100_000)).unwrap();
        let busy = Fake {
            fail_adopt: true,
            ..Fake::default()
        };
        let st = run(read_status(&busy, &path, std::slice::from_ref(&i), false)).unwrap();
        assert_eq!(st.locks[0].status, Status::Unknown);
        assert_eq!(st.locked_sats, 100_000);
        assert!(st.stale);
        assert_eq!(load(&path).unwrap().0.locks[0].last_sats, 100_000);
    }

    fn info(account: u32, t: u32) -> BtcLockInfo {
        btc_lock_info(&seed(), Network::Testnet, account, t).unwrap()
    }

    #[test]
    fn two_locks_on_one_date_are_one_line() {
        let path = dir("same-date");
        update(&path, |s| upsert(s, &info(0, T), 100_000)).unwrap();
        update(&path, |s| upsert(s, &info(0, T), 60_000)).unwrap();
        update(&path, |s| upsert(s, &info(1, T), 70_000)).unwrap();
        let store = load(&path).unwrap().0;
        assert_eq!(store.locks.len(), 2, "one per date and account");
        assert_eq!(store.locks[0].last_sats, 160_000);
        // The scan finding it again changes nothing.
        update(&path, |s| upsert(s, &info(0, T), 0)).unwrap();
        assert_eq!(load(&path).unwrap().0.locks[0].last_sats, 160_000);
    }

    #[test]
    fn the_file_keeps_no_address() {
        let path = dir("no-address");
        let i = info(0, T);
        update(&path, |s| upsert(s, &i, 100_000)).unwrap();
        let raw = String::from_utf8(fs::read(&path).unwrap()).unwrap();
        assert!(!raw.contains(&i.address) && !raw.contains("tb1"));
    }

    #[test]
    fn a_damaged_list_is_set_aside_and_never_overwritten() {
        let path = dir("damaged");
        fs::write(&path, b"{ not json").unwrap();
        let (store, damaged) = load(&path).unwrap();
        assert!(damaged && store.locks.is_empty());
        let first = path.with_extension("btclocks.damaged");
        assert_eq!(fs::read(&first).unwrap(), b"{ not json");
        assert!(!path.exists());

        // A second corruption keeps the first one.
        fs::write(&path, b"second").unwrap();
        fs::write(path.with_extension("btclocks.damaged.1"), b"older").unwrap();
        fs::write(&path, b"third").unwrap();
        assert!(load(&path).unwrap().1);
        assert_eq!(fs::read(&first).unwrap(), b"{ not json");
        assert_eq!(
            fs::read(path.with_extension("btclocks.damaged.1")).unwrap(),
            b"older"
        );
        assert_eq!(
            fs::read(path.with_extension("btclocks.damaged.2")).unwrap(),
            b"third"
        );
    }

    /// A folder in the file's place reads as an I/O error other than "not found".
    #[test]
    fn a_read_error_is_an_error_and_saves_nothing() {
        let path = dir("read-error");
        fs::create_dir_all(&path).unwrap();
        fs::write(path.join("keep"), b"x").unwrap();
        assert!(load(&path).is_err());
        assert!(update(&path, |s| upsert(s, &info(0, T), 1)).is_err());
        let fake = Fake::default();
        assert!(run(read_status(&fake, &path, &[], false)).is_err());
        assert!(path.join("keep").exists());
    }

    #[test]
    fn with_no_lock_nothing_is_asked_or_written() {
        let path = dir("none");
        let fake = Fake::default();
        let st = run(read_status(&fake, &path, &[], false)).unwrap();
        assert_eq!(st.locked_sats, 0);
        assert!(st.locks.is_empty() && !st.stale);
        assert_eq!(fake.tips.get(), 0, "no request to the server");
        assert!(!path.exists(), "no file");
    }

    #[test]
    fn a_read_that_changes_nothing_does_not_touch_the_file() {
        let path = dir("unchanged");
        let i = info(0, T);
        update(&path, |s| upsert(s, &i, 100_000)).unwrap();
        let up = Fake {
            coins: vec![coin(1, 100_000, true)],
            tx_count: 1,
            ..Fake::default()
        };
        run(read_status(&up, &path, std::slice::from_ref(&i), false)).unwrap();
        let mut raw = fs::read(&path).unwrap();
        raw.push(b'\n');
        fs::write(&path, &raw).unwrap();
        run(read_status(&up, &path, std::slice::from_ref(&i), false)).unwrap();
        assert_eq!(fs::read(&path).unwrap(), raw, "not rewritten");
    }

    #[test]
    fn locked_coins_show_even_when_the_server_is_down() {
        let path = dir("offline");
        let i = info(0, T);
        update(&path, |s| upsert(s, &i, 100_000)).unwrap();
        let fake = Fake {
            fail_tip: true,
            ..Fake::default()
        };
        let st = run(read_status(&fake, &path, std::slice::from_ref(&i), false)).unwrap();
        assert!(st.stale);
        assert_eq!(st.locked_sats, 100_000);
        assert_eq!(st.locks[0].status, Status::Unknown);

        let up = Fake {
            coins: vec![coin(1, 100_000, true), coin(2, 60_000, true)],
            tx_count: 2,
            mtp: u64::from(T) - 3_600,
            ..Fake::default()
        };
        let st = run(read_status(&up, &path, &[i], false)).unwrap();
        assert!(!st.stale);
        assert_eq!(st.locks[0].status, Status::Locked);
        assert_eq!(st.locks[0].secs_left, 3_600);
        assert_eq!(st.locked_sats, 160_000);
        let saved = load(&path).unwrap().0;
        assert_eq!(saved.locks[0].last_sats, 160_000);
        assert!(saved.locks[0].seen);
        assert!(saved.locks[0].coins.is_empty(), "only Core keeps coins");
    }

    #[test]
    fn what_never_arrived_is_not_counted() {
        let path = dir("notfound");
        let i = info(0, T);
        update(&path, |s| upsert(s, &i, 100_000)).unwrap();
        let fake = Fake::default();
        let st = run(read_status(&fake, &path, &[i], false)).unwrap();
        assert_eq!(st.locks[0].status, Status::NotFound);
        assert_eq!(st.locked_sats, 0);
        assert_eq!(
            st.locks[0].amount_sats, 100_000,
            "what was signed stays shown"
        );
        assert_eq!(load(&path).unwrap().0.locks[0].last_sats, 100_000);
    }

    #[test]
    fn the_list_says_what_is_not_confirmed_yet() {
        let path = dir("pending");
        let i = info(0, T);
        update(&path, |s| upsert(s, &i, 170_000)).unwrap();
        let fake = Fake {
            coins: vec![coin(1, 100_000, true), coin(2, 70_000, false)],
            tx_count: 2,
            mtp: u64::from(T) + 1,
            ..Fake::default()
        };
        let st = run(read_status(&fake, &path, &[i], false)).unwrap();
        assert_eq!(st.locks[0].status, Status::Ready);
        assert_eq!(st.locks[0].unconfirmed_sats, 70_000);
        assert_eq!(st.locks[0].amount_sats, 170_000);
    }

    #[test]
    fn the_scan_finds_a_lock_and_resumes_in_stretches() {
        let path = dir("scan");
        let i = info(0, T);
        let fake = Fake {
            used: vec![i.address.clone()],
            ..Fake::default()
        };
        let mut next = None;
        let mut steps = 0;
        let mut found = 0;
        loop {
            let s = scan(&fake, &path, next, CLOCK).unwrap();
            found += s.found;
            steps += 1;
            next = s.next_day;
            if next.is_none() {
                assert_eq!(s.last_day, 20_762 + 3_653 + 2);
                break;
            }
        }
        assert_eq!(found, 1);
        assert!(steps > 20);
        let asked = fake.asked.borrow();
        assert_eq!(asked[0].0, BTC_LOCK_FIRST_DAY);
        for w in asked.windows(2) {
            assert_eq!(w[1].0, w[0].1 + 1, "no day skipped");
        }
        assert_eq!(asked.last().unwrap().1, 20_762 + 3_653 + 2);
        let store = load(&path).unwrap().0;
        assert_eq!(store.locks.len(), 1);
        assert_eq!((store.locks[0].t, store.locks[0].account), (T, 0));
    }

    #[test]
    fn a_server_failing_halfway_is_not_a_result_and_the_scan_resumes() {
        let path = dir("scan-halfway");
        let late = day_time(20_762 + 2_000);
        let hit = info(0, late);
        let fake = Fake {
            used: vec![hit.address.clone()],
            grid_answers: Cell::new(3),
            ..Fake::default()
        };
        let mut next = None;
        for _ in 0..3 {
            next = scan(&fake, &path, next, CLOCK).unwrap().next_day;
        }
        let stopped_at = next.unwrap();
        assert_eq!(stopped_at, BTC_LOCK_FIRST_DAY + 3 * SCAN_CHUNK_DAYS);
        // The fourth stretch fails: an error, not "finished".
        assert!(scan(&fake, &path, next, CLOCK).is_err());
        assert!(load(&path).unwrap().0.locks.is_empty());

        // Resuming from there walks what is left and finds the lock past the failure.
        fake.grid_answers.set(u32::MAX);
        let mut found = 0;
        while let Some(from) = next {
            let s = scan(&fake, &path, Some(from), CLOCK).unwrap();
            found += s.found;
            next = s.next_day;
        }
        assert_eq!(found, 1);
        let asked = fake.asked.borrow();
        assert_eq!(asked[3].0, stopped_at, "nothing skipped");
    }

    fn day_time(day: u32) -> u32 {
        day * BTC_LOCK_DAY_SECS
    }

    #[test]
    fn the_end_of_the_grid_does_not_rest_on_the_local_clock() {
        let path = dir("scan-clock");
        // This computer is a year late; the chain is not.
        let tip = CLOCK + 365 * 86_400;
        let fake = Fake {
            tip_time: tip,
            ..Fake::default()
        };
        let s = scan(&fake, &path, None, CLOCK).unwrap();
        assert_eq!(s.last_day, wallet_core::btc_lock_last_day(tip));
        // The chain is behind instead: the local clock still counts.
        let behind = Fake {
            tip_time: 0,
            ..Fake::default()
        };
        let s = scan(&behind, &path, None, tip).unwrap();
        assert_eq!(s.last_day, wallet_core::btc_lock_last_day(tip));
        // Without the tip there is no end to trust.
        let down = Fake {
            fail_tip: true,
            ..Fake::default()
        };
        assert!(scan(&down, &path, None, CLOCK).is_err());
    }

    #[test]
    fn an_empty_or_inverted_grid_is_an_error() {
        let path = dir("scan-inverted");
        let past = Fake {
            tip_time: 0,
            ..Fake::default()
        };
        // Both clocks far before the first day: the grid would end before it starts.
        let s = scan(&past, &path, None, 0).unwrap_err();
        assert!(matches!(s, AppError::InvalidInput(_)), "{s:?}");
        let fake = Fake::default();
        assert!(scan(&fake, &path, Some(30_000), CLOCK).is_err());
        assert!(fake.asked.borrow().is_empty());
    }

    #[test]
    fn withdrawal_takes_confirmed_coins_to_the_first_unused_address() {
        let path = dir("withdraw");
        let addr = |i| {
            wallet_core::btc_address(&seed(), Network::Testnet, BtcKind::Segwit, 0, false, i)
                .unwrap()
        };
        let fake = Fake {
            coins: vec![coin(1, 100_000, true), coin(2, 70_000, false)],
            mtp: u64::from(T) + 1,
            used: vec![addr(0), addr(1)],
            ..Fake::default()
        };
        let w = plan(&fake, &path).unwrap();
        assert_eq!(w.plan.destination, addr(2));
        assert_eq!(w.plan.coins.len(), 1);
        assert_eq!(w.plan.amount_sats + w.plan.fee_sats, 100_000);
        assert_eq!(w.unconfirmed_sats, 70_000);

        let early = Fake {
            mtp: u64::from(T),
            ..fake
        };
        assert!(plan(&early, &path).is_err());
    }

    /// A lying server calling indexes 0 to 38 used must not send the coins out of reach of an
    /// honest scan, which walks 0 .. lastUsed + 5.
    #[test]
    fn the_destination_stays_where_the_normal_scan_always_looks() {
        let path = dir("destination");
        let addr = |i| {
            wallet_core::btc_address(&seed(), Network::Testnet, BtcKind::Segwit, 0, false, i)
                .unwrap()
        };
        assert_eq!(LAST_FRESH_INDEX, 4);
        let liar = Fake {
            coins: vec![coin(1, 100_000, true)],
            mtp: u64::from(T) + 1,
            used: (0..39).map(addr).collect(),
            ..Fake::default()
        };
        let w = plan(&liar, &path).unwrap();
        assert_eq!(w.plan.destination, addr(LAST_FRESH_INDEX));
        assert_eq!(w.plan.destination_index, 4);
    }

    #[test]
    fn nothing_confirmed_means_nothing_to_withdraw() {
        let path = dir("nothing");
        let fake = Fake {
            coins: vec![coin(2, 70_000, false)],
            mtp: u64::from(T) + 1,
            ..Fake::default()
        };
        assert!(plan(&fake, &path).is_err());
    }

    #[test]
    fn server_answers_are_read_strictly() {
        let good = serde_json::json!([{ "txid": "ab", "vout": 1, "value": 5, "status": { "confirmed": true } }]);
        let info = serde_json::json!({ "chain_stats": { "tx_count": 2 }, "mempool_stats": { "tx_count": 1 } });
        let v = parse_view(&good, &info).unwrap();
        assert_eq!(v.tx_count, 3);
        assert!(v.coins[0].confirmed);
        assert!(parse_view(&serde_json::json!({}), &info).is_err());
        let no_value = serde_json::json!([{ "txid": "ab", "vout": 1 }]);
        assert!(parse_view(&no_value, &info).is_err());
        assert!(
            parse_view(&good, &serde_json::json!({})).is_err(),
            "no counts"
        );
    }

    #[test]
    fn dialogs_name_the_date_in_utc_and_say_it_cannot_be_undone() {
        let i = info(0, T);
        let fr = lock_head(Lang::Fr, &i, 100_000);
        assert!(fr.contains("2027-03-14 à 00:00 UTC") && fr.contains(&i.address));
        assert!(fr.contains("personne ne peut annuler"));
        let en = lock_head(Lang::En, &i, 100_000);
        assert!(en.contains("2027-03-14 at 00:00 UTC") && en.contains("nobody can cancel"));
    }

    #[test]
    fn the_withdrawal_dialog_says_what_stays_behind() {
        let path = dir("dialog");
        let fake = Fake {
            coins: vec![
                coin(1, 100_000, true),
                coin(2, 70_000, false),
                coin(3, 50, true),
            ],
            mtp: u64::from(T) + 1,
            ..Fake::default()
        };
        let w = plan(&fake, &path).unwrap();
        assert_eq!(w.plan.left_out, 1);
        let i = info(0, T);
        let en = withdraw_body(Lang::En, &i, &w);
        assert!(
            en.contains("1 small coins") && en.contains("not confirmed yet"),
            "{en}"
        );
        assert!(en.contains(&w.plan.destination));
        let fr = withdraw_body(Lang::Fr, &i, &w);
        assert!(fr.contains("pas encore confirmés") && fr.contains("restent au blocage"));
    }

    #[test]
    fn a_backup_line_of_another_seed_is_dropped_by_the_address_check() {
        let mut store = Store::default();
        let i = info(0, T);
        let line = BackupLock {
            account: 0,
            t: T,
            last_sats: 100_000,
            withdrawn: false,
            address: i.address.clone(),
        };
        merge_into(&mut store, &[(i, line)]);
        assert_eq!(store.locks[0].last_sats, 100_000);
    }
}
