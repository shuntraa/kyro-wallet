// SPDX-License-Identifier: GPL-3.0-or-later
//! Bitcoin time locks: the list beside the vault, the "Find my locks" scan, and the commands.
//! Script, keys and signing are in `wallet_core::btc_lock`; docs/BTC_TIMELOCK.md explains the whole.
//!
//! The file `<vault>.btclocks` only holds what makes the screen quick: account, date, last known
//! amount. The address is always derived again from the seed, so the file cannot redirect anything,
//! and it can be lost: the scan rebuilds it from the phrase alone.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, State};
use wallet_core::{
    btc_lock_addresses, btc_lock_check_funding, btc_lock_check_window, btc_lock_day, btc_lock_info,
    btc_lock_is_open, btc_lock_last_day, btc_lock_sign_funding, btc_lock_utc_date,
    btc_lock_withdraw_tx, BtcKind, BtcLockAddress, BtcLockInfo, BtcLockSpend, BtcLockUtxo, Network,
    Seed, BTC_HIGH_FEE_SAT_PER_VB, BTC_LOCK_FIRST_DAY,
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
/// The withdrawal goes to the first unused receive address. Kyro's own scan stops at index 40, so
/// past this the last index is used again: reusing an address costs privacy, never the coins.
const LAST_FRESH_INDEX: u32 = 39;

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
    /// When Kyro signed the withdrawal.
    pub withdraw_txid: Option<String>,
    /// Added locally. False for what the scan found.
    pub funded_here: bool,
    /// Wallet where it was made, to tell records from another seed apart in a backup.
    pub address: String,
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

/// `true` as second value: the file was unreadable. It is set aside, never overwritten, and the
/// screen asks for a scan.
fn load(path: &Path) -> (Store, bool) {
    let raw = match fs::read(path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return (Store::default(), false),
        Err(_) => return (Store::default(), true),
    };
    match serde_json::from_slice::<Store>(&raw) {
        Ok(s) if s.version == FILE_VERSION && s.locks.len() <= MAX_LOCKS => (s, false),
        _ => {
            let _ = fs::rename(path, path.with_extension("btclocks.damaged"));
            (Store::default(), true)
        }
    }
}

fn save(path: &Path, store: &Store) -> AppResult<()> {
    crate::settings::write_atomic(path, &serde_json::to_vec(store)?)
}

fn update<T>(path: &Path, f: impl FnOnce(&mut Store) -> T) -> AppResult<T> {
    let _lock = guard(&STORE_LOCK);
    let (mut store, _) = load(path);
    let out = f(&mut store);
    save(path, &store)?;
    Ok(out)
}

/// One date is one address: a second lock on the same date joins the same record.
fn upsert(store: &mut Store, info: &BtcLockInfo, sats: u64, funded_here: bool) {
    let found = store
        .locks
        .iter_mut()
        .find(|r| r.account == info.account && r.t == info.t);
    match found {
        Some(r) => {
            r.last_sats = r.last_sats.saturating_add(if funded_here { sats } else { 0 });
            r.funded_here |= funded_here;
            r.address.clone_from(&info.address);
        }
        None => store.locks.push(Record {
            account: info.account,
            t: info.t,
            last_sats: sats,
            withdraw_txid: None,
            funded_here,
            address: info.address.clone(),
        }),
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

/// The little the lock logic needs from a Bitcoin server. Real servers go through
/// [`Backend`]; the node tests plug in a real `bitcoind`.
#[allow(async_fn_in_trait)]
pub trait LockChain {
    async fn tip(&self) -> AppResult<Tip>;
    async fn view(&self, info: &BtcLockInfo) -> AppResult<AddrView>;
    /// Whether a wallet address of this seed has been used.
    async fn wallet_address_used(&self, address: &str) -> AppResult<bool>;
    /// For each date of the grid, whether it holds or held anything. Fails rather than guess.
    async fn grid_used(&self, grid: &[BtcLockAddress]) -> AppResult<Vec<bool>>;
    async fn broadcast(&self, hex: &str) -> AppResult<String>;
    /// How many days of the grid one call should cover.
    fn chunk_days(&self) -> u32 {
        SCAN_CHUNK_DAYS
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
    let count = |k: &str| info[k]["tx_count"].as_u64().unwrap_or(0);
    Ok(AddrView {
        coins,
        tx_count: count("chain_stats") + count("mempool_stats"),
    })
}

impl LockChain for Backend<'_> {
    async fn tip(&self) -> AppResult<Tip> {
        btc_backend::tip_info(&self.0).await
    }

    async fn view(&self, info: &BtcLockInfo) -> AppResult<AddrView> {
        let utxos = btc_backend::address_utxos(&self.0, &info.address).await?;
        let data = btc_backend::address_info(&self.0, &info.address).await?;
        parse_view(&utxos, &data)
    }

    async fn wallet_address_used(&self, address: &str) -> AppResult<bool> {
        let data = btc_backend::address_info(&self.0, address).await?;
        let count = |k: &str| data[k]["tx_count"].as_u64().unwrap_or(0);
        Ok(count("chain_stats") + count("mempool_stats") > 0)
    }

    async fn grid_used(&self, grid: &[BtcLockAddress]) -> AppResult<Vec<bool>> {
        if let Some((c, wallet)) = btc_backend::core_for_locks(&self.0).await? {
            let scripts: Vec<String> = grid.iter().map(|g| g.script_pubkey.clone()).collect();
            let found = btc_backend::core_lock_scan(&c, &scripts).await?;
            let mut used = vec![false; grid.len()];
            for f in &found {
                if let Some(i) = scripts.iter().position(|s| *s == f.script_pubkey) {
                    used[i] = true;
                    btc_backend::core_lock_watch(&c, &wallet, &f.script_pubkey, Some(f.height))
                        .await?;
                }
            }
            return Ok(used);
        }
        let addresses: Vec<String> = grid.iter().map(|g| g.address.clone()).collect();
        btc_backend::addresses_used(&self.0, &addresses).await
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

pub fn status_of(view: &AddrView, t: u32, mtp: u64, withdraw_txid: Option<&str>) -> Status {
    if view.coins.iter().any(|c| c.confirmed) {
        if btc_lock_is_open(t, mtp) {
            Status::Ready
        } else {
            Status::Locked
        }
    } else if !view.coins.is_empty() {
        Status::Confirming
    } else if view.tx_count > 0 || withdraw_txid.is_some() {
        Status::Withdrawn
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

pub async fn read_status<C: LockChain>(
    chain: &C,
    path: &Path,
    lock_infos: &[BtcLockInfo],
    damaged: bool,
) -> AppResult<LocksStatus> {
    let records = {
        let _lock = guard(&STORE_LOCK);
        load(path).0.locks
    };
    let tip = chain.tip().await;
    let mut locks = Vec::with_capacity(records.len());
    let mut stale = tip.is_err();
    for r in &records {
        let Some(info) = lock_infos
            .iter()
            .find(|i| i.t == r.t && i.account == r.account)
        else {
            continue;
        };
        let view = match &tip {
            Ok(_) => chain.view(info).await,
            Err(_) => Err(AppError::ServerUnreachable(String::new())),
        };
        let mtp = tip.as_ref().map_or(0, |t| t.mtp);
        let (amount_sats, status, coins) = match view {
            Ok(v) => {
                let status = status_of(&v, r.t, mtp, r.withdraw_txid.as_deref());
                let sum = v
                    .coins
                    .iter()
                    .fold(0u64, |s, c| s.saturating_add(c.utxo.value));
                (sum, status, v.coins.len())
            }
            Err(_) => {
                stale = true;
                (r.last_sats, Status::Unknown, 0)
            }
        };
        locks.push(LockView {
            t: r.t,
            day: info.day,
            account: r.account,
            address: info.address.clone(),
            amount_sats,
            status,
            coins,
            secs_left: u64::from(r.t).saturating_sub(mtp),
        });
    }
    locks.sort_by_key(|l| (l.t, l.account));
    let seen: Vec<(u32, u32, u64, Status)> = locks
        .iter()
        .map(|l| (l.account, l.t, l.amount_sats, l.status))
        .collect();
    update(path, |store| {
        for r in &mut store.locks {
            let hit = seen
                .iter()
                .find(|(a, t, _, st)| *a == r.account && *t == r.t && *st != Status::Unknown);
            if let Some((_, _, sats, _)) = hit {
                r.last_sats = *sats;
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
    let first_day = BTC_LOCK_FIRST_DAY;
    let last_day = btc_lock_last_day(clock);
    let from = from_day.unwrap_or(first_day).max(first_day);
    let to = from.saturating_add(chain.chunk_days().saturating_sub(1)).min(last_day);
    let grid = btc_lock_addresses(seed, net, account, from, to)?;
    let used = chain.grid_used(&grid).await?;
    if used.len() != grid.len() {
        return Err(AppError::ServerUnreachable("incomplete answer".into()));
    }
    let mut found = 0;
    for (g, hit) in grid.iter().zip(used) {
        if hit {
            let t = wallet_core::btc_lock_time_of_day(g.day)
                .ok_or_else(|| AppError::Internal("day out of range".into()))?;
            let info = btc_lock_info(seed, net, account, t)?;
            update(path, |s| upsert(s, &info, 0, false))?;
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

/// The signed withdrawal of every confirmed coin of a lock. An unconfirmed coin could be replaced
/// under the spend, so it waits for the next one.
pub async fn plan_withdraw<C: LockChain>(
    chain: &C,
    seed: &Seed,
    net: Network,
    account: u32,
    t: u32,
    sat_per_vb: u64,
) -> AppResult<BtcLockSpend> {
    let info = btc_lock_info(seed, net, account, t)?;
    let tip = chain.tip().await?;
    let view = chain.view(&info).await?;
    let coins: Vec<BtcLockUtxo> = view
        .coins
        .into_iter()
        .filter(|c| c.confirmed)
        .map(|c| c.utxo)
        .collect();
    let index = fresh_index(chain, seed, net, account).await?;
    Ok(btc_lock_withdraw_tx(
        seed, net, account, t, &coins, index, sat_per_vb, tip.mtp,
    )?)
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

fn withdraw_body(lang: Lang, info: &BtcLockInfo, s: &BtcLockSpend) -> String {
    let (amount, fee) = (btc_text(lang, s.amount_sats), btc_text(lang, s.fee_sats));
    let date = btc_lock_utc_date(info.t);
    let to = &s.destination;
    let left = match (s.left_out, lang) {
        (0, _) => String::new(),
        (n, Lang::Fr) => format!("\n{n} petites pièces restent pour un prochain retrait."),
        (n, Lang::En) => format!("\n{n} small coins stay for a next withdrawal."),
    };
    match lang {
        Lang::Fr => format!(
            "Retrait du blocage du {date}\n\nTu reçois : {amount} BTC\nFrais : {fee} BTC\nVers ton adresse : {to}{left}"
        ),
        Lang::En => format!(
            "Withdrawal of the lock of {date}\n\nYou receive: {amount} BTC\nFee: {fee} BTC\nTo your address: {to}{left}"
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
        upsert(store, &info, amount_sats, true);
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
        load(&path)
    };
    let list = state.with_seed(|seed| infos(seed, net, &records.locks))?;
    let settings = state.settings();
    if matches!(
        settings.servers.bitcoin_for(net),
        BtcServer::Cbf { .. }
    ) {
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
    async fn view(&self, _: &BtcLockInfo) -> AppResult<AddrView> {
        Err(AppError::ServerUnreachable("no server".into()))
    }
    async fn wallet_address_used(&self, _: &str) -> AppResult<bool> {
        Err(AppError::ServerUnreachable("no server".into()))
    }
    async fn grid_used(&self, _: &[BtcLockAddress]) -> AppResult<Vec<bool>> {
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
}

/// What a withdrawal would do. Refused while the network would refuse it.
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
    let s = plan_withdraw(&chain, &seed, net, a, t, sat_per_vb).await?;
    Ok(WithdrawPreview {
        amount_sats: s.amount_sats,
        fee_sats: s.fee_sats,
        vsize: s.vsize,
        destination: s.destination,
        inputs: s.inputs,
        left_out: s.left_out,
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

/// Builds, signs and sends the withdrawal. There is no destination argument.
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
    let spend = plan_withdraw(&chain, &seed, net, a, t, sat_per_vb).await?;
    let info = btc_lock_info(&seed, net, a, t)?;
    let lang = crate::i18n::current();
    confirm_native(
        &app,
        lang.confirm_tx_title(),
        signer.body(lang, &withdraw_body(lang, &info, &spend)),
    )
    .await?;
    if sat_per_vb > BTC_HIGH_FEE_SAT_PER_VB || spend.fee_sats > spend.amount_sats {
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
    let txid = chain.broadcast(&spend.hex).await?;
    let path = file_of(&state);
    // The coins have left: a full disk must not turn that into an error on screen.
    let _ = update(&path, |store| {
        if let Some(r) = store.locks.iter_mut().find(|r| r.account == a && r.t == t) {
            r.withdraw_txid = Some(txid.clone());
        }
    });
    state.touch();
    Ok(Withdrawn {
        txid,
        amount_sats: spend.amount_sats,
        fee_sats: spend.fee_sats,
        destination: spend.destination,
    })
}

/// The records for the backup file.
pub fn export_records(state: &AppState) -> Vec<Record> {
    let _lock = guard(&STORE_LOCK);
    load(&file_of(state)).0.locks
}

/// Merges a backup's records, keeping only those this seed really derives.
pub fn merge_records(state: &AppState, incoming: &[Record]) -> AppResult<usize> {
    let net = state.network;
    let kept: Vec<(BtcLockInfo, Record)> = state.with_seed(|seed| {
        Ok(incoming
            .iter()
            .filter_map(|r| {
                let info = btc_lock_info(seed, net, r.account, r.t).ok()?;
                (info.address == r.address).then(|| (info, r.clone()))
            })
            .collect())
    })?;
    let count = kept.len();
    update(&file_of(state), |store| {
        for (info, r) in &kept {
            upsert(store, info, 0, false);
            if let Some(mine) = store
                .locks
                .iter_mut()
                .find(|m| m.account == r.account && m.t == r.t)
            {
                mine.last_sats = mine.last_sats.max(r.last_sats);
                if mine.withdraw_txid.is_none() {
                    mine.withdraw_txid.clone_from(&r.withdraw_txid);
                }
            }
        }
    })?;
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use wallet_core::Mnemonic;

    const PHRASE: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    const T: u32 = 1_804_982_400;

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

    #[derive(Default)]
    struct Fake {
        coins: Vec<Coin>,
        tx_count: u64,
        mtp: u64,
        used: Vec<String>,
        fail_tip: bool,
        fail_grid: bool,
        asked: RefCell<Vec<(u32, u32)>>,
    }

    impl LockChain for Fake {
        async fn tip(&self) -> AppResult<Tip> {
            if self.fail_tip {
                return Err(AppError::ServerUnreachable("down".into()));
            }
            Ok(Tip {
                height: 1,
                time: self.mtp,
                mtp: self.mtp,
            })
        }
        async fn view(&self, _: &BtcLockInfo) -> AppResult<AddrView> {
            Ok(AddrView {
                coins: self.coins.clone(),
                tx_count: self.tx_count,
            })
        }
        async fn wallet_address_used(&self, a: &str) -> AppResult<bool> {
            Ok(self.used.iter().any(|u| u == a))
        }
        async fn grid_used(&self, grid: &[BtcLockAddress]) -> AppResult<Vec<bool>> {
            if self.fail_grid {
                return Err(AppError::ServerUnreachable("429".into()));
            }
            self.asked
                .borrow_mut()
                .push((grid[0].day, grid.last().unwrap().day));
            Ok(grid
                .iter()
                .map(|g| self.used.iter().any(|u| *u == g.address))
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

    #[test]
    fn status_follows_the_chain() {
        let past = u64::from(T) + 1;
        let t = u64::from(T);
        let confirmed = view(vec![coin(1, 5, true)], 1);
        let pending = view(vec![coin(1, 5, false)], 1);
        assert_eq!(status_of(&pending, T, past, None), Status::Confirming);
        assert_eq!(status_of(&confirmed, T, t - 1, None), Status::Locked);
        assert_eq!(status_of(&confirmed, T, t, None), Status::Locked, "MTP = T");
        assert_eq!(status_of(&confirmed, T, past, None), Status::Ready);
        assert_eq!(status_of(&view(vec![], 2), T, past, None), Status::Withdrawn);
        assert_eq!(
            status_of(&view(vec![], 0), T, past, Some("x")),
            Status::Withdrawn
        );
        assert_eq!(status_of(&view(vec![], 0), T, t, None), Status::NotFound);
        // A new deposit after a withdrawal shows again.
        assert_eq!(status_of(&confirmed, T, past, Some("x")), Status::Ready);
    }

    fn info(account: u32, t: u32) -> BtcLockInfo {
        btc_lock_info(&seed(), Network::Testnet, account, t).unwrap()
    }

    #[test]
    fn two_locks_on_one_date_are_one_line() {
        let path = dir("same-date");
        update(&path, |s| upsert(s, &info(0, T), 100_000, true)).unwrap();
        update(&path, |s| upsert(s, &info(0, T), 60_000, true)).unwrap();
        update(&path, |s| upsert(s, &info(1, T), 70_000, true)).unwrap();
        let store = load(&path).0;
        assert_eq!(store.locks.len(), 2, "one per date and account");
        assert_eq!(store.locks[0].last_sats, 160_000);
        // The scan finding it again changes nothing.
        update(&path, |s| upsert(s, &info(0, T), 0, false)).unwrap();
        assert_eq!(load(&path).0.locks[0].last_sats, 160_000);
    }

    #[test]
    fn a_damaged_list_is_set_aside_and_never_overwritten() {
        let path = dir("damaged");
        fs::write(&path, b"{ not json").unwrap();
        let (store, damaged) = load(&path);
        assert!(damaged && store.locks.is_empty());
        assert_eq!(
            fs::read(path.with_extension("btclocks.damaged")).unwrap(),
            b"{ not json"
        );
        assert!(!path.exists());
    }

    #[test]
    fn locked_coins_show_even_when_the_server_is_down() {
        let path = dir("offline");
        let i = info(0, T);
        update(&path, |s| upsert(s, &i, 100_000, true)).unwrap();
        let fake = Fake {
            fail_tip: true,
            ..Fake::default()
        };
        let st = run(read_status(&fake, &path, &[i.clone()], false)).unwrap();
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
        assert_eq!(load(&path).0.locks[0].last_sats, 160_000);
    }

    #[test]
    fn what_never_arrived_is_not_counted() {
        let path = dir("notfound");
        let i = info(0, T);
        update(&path, |s| upsert(s, &i, 100_000, true)).unwrap();
        let fake = Fake::default();
        let st = run(read_status(&fake, &path, &[i], false)).unwrap();
        assert_eq!(st.locks[0].status, Status::NotFound);
        assert_eq!(st.locked_sats, 0);
    }

    #[test]
    fn the_scan_finds_a_lock_and_resumes_in_stretches() {
        let path = dir("scan");
        let i = info(0, T);
        let fake = Fake {
            used: vec![i.address.clone()],
            ..Fake::default()
        };
        let clock = 1_793_836_800;
        let mut next = None;
        let mut steps = 0;
        let mut found = 0;
        loop {
            let s = run(scan_step(
                &fake,
                &path,
                &seed(),
                Network::Testnet,
                0,
                next,
                clock,
            ))
            .unwrap();
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
        let store = load(&path).0;
        assert_eq!(store.locks.len(), 1);
        assert_eq!((store.locks[0].t, store.locks[0].account), (T, 0));
    }

    #[test]
    fn a_failed_scan_never_says_nothing_was_found() {
        let path = dir("scan-fail");
        let fake = Fake {
            fail_grid: true,
            ..Fake::default()
        };
        let r = run(scan_step(
            &fake,
            &path,
            &seed(),
            Network::Testnet,
            0,
            None,
            1_793_836_800,
        ));
        assert!(r.is_err());
    }

    #[test]
    fn withdrawal_takes_confirmed_coins_to_the_first_unused_address() {
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
        let s = run(plan_withdraw(&fake, &seed(), Network::Testnet, 0, T, 2)).unwrap();
        assert_eq!(s.destination, addr(2));
        assert_eq!(s.inputs, 1);
        assert_eq!(s.amount_sats + s.fee_sats, 100_000);

        let early = Fake {
            mtp: u64::from(T),
            ..fake
        };
        assert!(run(plan_withdraw(&early, &seed(), Network::Testnet, 0, T, 2)).is_err());

        // Every address used: stays inside what Kyro's own scan can see.
        let full = Fake {
            coins: vec![coin(1, 100_000, true)],
            mtp: u64::from(T) + 1,
            used: (0..60).map(addr).collect(),
            ..Fake::default()
        };
        let s = run(plan_withdraw(&full, &seed(), Network::Testnet, 0, T, 2)).unwrap();
        assert_eq!(s.destination, addr(LAST_FRESH_INDEX));
    }

    #[test]
    fn nothing_confirmed_means_nothing_to_withdraw() {
        let fake = Fake {
            coins: vec![coin(2, 70_000, false)],
            mtp: u64::from(T) + 1,
            ..Fake::default()
        };
        assert!(run(plan_withdraw(&fake, &seed(), Network::Testnet, 0, T, 2)).is_err());
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
}
