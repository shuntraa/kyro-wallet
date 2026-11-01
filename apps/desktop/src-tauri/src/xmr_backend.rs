//! Monero: a `monerod` RPC node (default: Cake Wallet's mainnet node, Stack Wallet's stagenet
//! node, or the user's), reached through `NetClient::server_request` on the `monero` Tor family,
//! never with a fallback.
//!
//! **The node never receives a key.** Rust downloads the blocks (`get_blocks.bin`, pruned) and
//! scans them locally with monero-wallet's `Scanner` (private view key in memory only); spent
//! outputs are recognised by their key images, computed locally with the spend key (derived
//! from the session seed, then erased). The node does learn the transactions you publish and
//! the decoys you request (as with any remote node), and the IP of a Tor exit (yours in clear
//! mode).
//!
//! **Scan state** (our outputs, key images, history, scanned height, recent block hashes) is
//! kept encrypted next to the vault (`monero/<network>-<account>-<key>.bin`, XChaCha20-Poly1305
//! with a key derived from the private view key, see wallet-core `xmr_cache_seal`).
//!
//! Reorganisations: the hash of the last scanned block is re-checked before each batch; on a
//! mismatch the last [`REORG_DEPTH`] blocks are forgotten and scanned again.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::ops::RangeBounds;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use monero_daemon_rpc::{HttpTransport, MoneroDaemon};
use serde::{Deserialize, Serialize};
use wallet_core::monero_wallet::ed25519::Point;
use wallet_core::monero_wallet::interface::{
    EvaluateUnlocked, FeePriority, InterfaceError, ProvidesBlockchain, ProvidesBlockchainMeta,
    ProvidesFeeRates, ProvidesScannableBlocks, ProvidesUnvalidatedDecoys, PublishTransaction,
    PublishTransactionError, ScannableBlock, TransactionsError,
};
use wallet_core::monero_wallet::{OutputWithDecoys, WalletOutput};
use wallet_core::{Network, XmrTxSummary, XmrUnsigned};

use crate::error::{AppError, AppResult};
use crate::net::{Family, NetClient, ServerRequest};
use crate::servers::{
    monero_default_url, monero_genesis, monero_nettype, validate_http_url, MoneroServer,
};
use crate::state::AppState;

/// Blocks per `get_blocks.bin` request (pruned blocks: usually well under 1 MiB each).
const BATCH: usize = 20;
/// Blocks forgotten and scanned again when the chain changed under us.
pub const REORG_DEPTH: u64 = 30;
/// Recent block hashes kept for the reorganisation check.
const KEEP_HASHES: usize = 64;
/// First scan of a never-used account: from 1 day (720 blocks) before the account was first
/// shown on this device.
const FIRST_SCAN_MARGIN: u64 = 720;
const BLOCK_SECS: u64 = 120;
/// Fee per weight above which the node's estimate is refused (its "priority" level is 4 000 000;
/// "normal" is ≈ 80 000 piconero on 2026-11-01).
pub const MAX_FEE_PER_WEIGHT: u64 = 4_000_000;
/// Inputs per transfer (wallet2's limit is higher; this keeps a transfer far below the weight cap).
pub const MAX_INPUTS: usize = 16;
/// A built transfer must be signed within this delay (decoys and fee rate get stale).
const PENDING_TTL_SECS: u64 = 600;
/// A local spend not seen in a block after this delay is released (transaction dropped).
const PENDING_SPEND_TTL_SECS: u64 = 24 * 3600;
const CACHE_VERSION: u32 = 1;
/// Mainnet block a phrase restored into Kyro starts scanning from. A Kyro-derived Monero wallet
/// cannot be older than Kyro's first release (2026-11-01, block ≈ 3 797 000 per xmrchain.net):
/// this is ≈ 2026-10-22, rounded down by ~10 days so an early test install misses nothing.
pub const KYRO_FIRST_RELEASE_HEIGHT: u64 = 3_790_000;
/// The same moment as a Unix time (2026-10-22 00:00 UTC), for stagenet (heights differ there).
pub const KYRO_FIRST_RELEASE_TIME: u64 = 1_792_627_200;
const MAX_HISTORY: usize = 500;

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

fn bad(msg: impl Into<String>) -> AppError {
    AppError::ServerUnreachable(msg.into())
}

const TOR_PREFIX: &str = "kyro-tor:";

fn interface_err(e: AppError) -> InterfaceError {
    match e {
        AppError::TorUnavailable(m) => InterfaceError::InterfaceError(format!("{TOR_PREFIX}{m}")),
        other => InterfaceError::InterfaceError(other.to_string()),
    }
}

/// Monero interface errors back to the app's: Tor stays `TOR_UNAVAILABLE` (fail closed).
pub fn app_err(e: InterfaceError) -> AppError {
    let text = match e {
        InterfaceError::InternalError(m)
        | InterfaceError::InterfaceError(m)
        | InterfaceError::InvalidInterface(m) => m,
    };
    if let Some(m) = text.strip_prefix(TOR_PREFIX) {
        return AppError::TorUnavailable(m.to_owned());
    }
    bad(format!(
        "Monero node: {}",
        text.chars().take(300).collect::<String>()
    ))
}

fn tx_err(e: TransactionsError) -> AppError {
    match e {
        TransactionsError::InterfaceError(i) => app_err(i),
        other => bad(format!("Monero node: {other}")),
    }
}

// ---------------------------------------------------------------- transport

/// `monero-daemon-rpc` transport over Kyro's network layer (policy, Tor family `monero`, bulk
/// limits: 64 MiB / 180 s per response).
#[derive(Clone)]
pub struct NetTransport {
    net: Arc<NetClient>,
    base: String,
    tor: bool,
}

impl HttpTransport for NetTransport {
    fn post(
        &self,
        route: &str,
        body: Vec<u8>,
        response_size_limit: Option<usize>,
    ) -> impl Send + Future<Output = Result<Vec<u8>, InterfaceError>> {
        let url = format!(
            "{}/{}",
            self.base.trim_end_matches('/'),
            route.trim_start_matches('/')
        );
        let content_type = if route.ends_with(".bin") {
            "application/octet-stream"
        } else {
            "application/json"
        };
        let net = self.net.clone();
        let tor = self.tor;
        async move {
            let u = url::Url::parse(&url)
                .map_err(|_| InterfaceError::InternalError("invalid node URL".into()))?;
            let mut req = ServerRequest::post_bytes(u, Family::Monero, content_type, body);
            req.bulk = true;
            let (status, bytes) = net.server_request(req, tor).await.map_err(interface_err)?;
            if status != 200 {
                return Err(InterfaceError::InterfaceError(format!(
                    "HTTP {status} on {route_name}",
                    route_name = url.rsplit('/').next().unwrap_or_default()
                )));
            }
            if let Some(limit) = response_size_limit {
                if limit > 0 && bytes.len() > limit {
                    return Err(InterfaceError::InvalidInterface(
                        "response larger than expected".into(),
                    ));
                }
            }
            Ok(bytes)
        }
    }
}

pub type Daemon = MoneroDaemon<NetTransport>;

/// Where Rust reaches Monero for `net` (validated URL).
pub fn node_url(network: Network, server: &MoneroServer, tor: bool) -> AppResult<String> {
    Ok(match server {
        MoneroServer::Default => monero_default_url(network).to_owned(),
        MoneroServer::Node { url } => {
            validate_http_url(url, tor, false)?;
            url.trim().trim_end_matches('/').to_owned()
        }
    })
}

/// Connects and checks the node is on `network` (`get_info.nettype` and block 0's hash).
pub async fn connect(
    net: &Arc<NetClient>,
    network: Network,
    server: &MoneroServer,
    tor: bool,
) -> AppResult<Daemon> {
    let base = node_url(network, server, tor)?;
    let daemon = MoneroDaemon::new(NetTransport {
        net: net.clone(),
        base,
        tor,
    })
    .await
    .map_err(app_err)?;
    let info: serde_json::Value = serde_json::from_str(
        &daemon
            .rpc_call("get_info", None, 64 * 1024)
            .await
            .map_err(app_err)?,
    )
    .map_err(|_| bad("Monero node: unreadable get_info"))?;
    let nettype = info["nettype"].as_str().unwrap_or_default().to_owned();
    if nettype != monero_nettype(network) {
        return Err(AppError::ServerWrongNetwork(format!(
            "this Monero node is on \"{nettype}\", not on {}",
            monero_nettype(network)
        )));
    }
    let genesis = ProvidesBlockchain::block_hash(&daemon, 0)
        .await
        .map_err(app_err)?;
    if hex::encode(genesis) != monero_genesis(network) {
        return Err(AppError::ServerWrongNetwork(
            "unexpected block 0: this is not the expected Monero network".into(),
        ));
    }
    Ok(daemon)
}

/// Probe for `settings_set` / `server_test`.
pub async fn probe(
    net: &Arc<NetClient>,
    network: Network,
    server: &MoneroServer,
    tor: bool,
) -> AppResult<crate::btc_backend::Detected> {
    let daemon = connect(net, network, server, tor).await?;
    let tip = daemon.latest_block_number().await.map_err(app_err)?;
    Ok(crate::btc_backend::Detected {
        network: Some(monero_nettype(network).into()),
        genesis_hash: Some(monero_genesis(network).into()),
        block_height: Some(tip as u64 + 1),
        ..Default::default()
    })
}

/// Decoy source that downloads the output distribution once per transfer (it is ≈ 20 MB on
/// mainnet and monero-wallet asks for it once per input).
struct CachedDecoys<'a> {
    daemon: &'a Daemon,
    dist: Mutex<Option<(usize, Vec<u64>)>>,
}

impl ProvidesBlockchainMeta for CachedDecoys<'_> {
    fn latest_block_number(&self) -> impl Send + Future<Output = Result<usize, InterfaceError>> {
        self.daemon.latest_block_number()
    }
}

impl ProvidesUnvalidatedDecoys for CachedDecoys<'_> {
    fn ringct_output_distribution(
        &self,
        range: impl Send + RangeBounds<usize>,
    ) -> impl Send + Future<Output = Result<Vec<u64>, InterfaceError>> {
        use std::ops::Bound;
        let full_to = match (range.start_bound(), range.end_bound()) {
            (Bound::Unbounded, Bound::Included(e)) => Some(*e),
            _ => None,
        };
        let cached = full_to.and_then(|to| {
            crate::net::lock(&self.dist)
                .as_ref()
                .filter(|(t, _)| *t == to)
                .map(|(_, d)| d.clone())
        });
        let start = range.start_bound().cloned();
        let end = range.end_bound().cloned();
        async move {
            if let Some(d) = cached {
                return Ok(d);
            }
            let d =
                ProvidesUnvalidatedDecoys::ringct_output_distribution(self.daemon, (start, end))
                    .await?;
            if let Some(to) = full_to {
                *crate::net::lock(&self.dist) = Some((to, d.clone()));
            }
            Ok(d)
        }
    }

    fn unlocked_ringct_outputs(
        &self,
        indexes: &[u64],
        evaluate_unlocked: EvaluateUnlocked,
    ) -> impl Send + Future<Output = Result<Vec<Option<[Point; 2]>>, TransactionsError>> {
        ProvidesUnvalidatedDecoys::unlocked_ringct_outputs(self.daemon, indexes, evaluate_unlocked)
    }
}

// ---------------------------------------------------------------- encrypted scan state

/// Computes our outputs' key images (needs the spend key).
pub type KeyImagesOf<'a> = dyn Fn(&[WalletOutput]) -> AppResult<Vec<[u8; 32]>> + 'a;

/// One of our outputs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnedOutput {
    /// `WalletOutput::serialize`, hex (contains the one-time key offset: encrypted at rest).
    pub data: String,
    pub txid: String,
    pub height: u64,
    pub amount: u64,
    /// Subaddress minor index (0 = primary address).
    pub subaddress: u32,
    pub coinbase: bool,
    /// Key image, hex.
    pub key_image: String,
    /// Spent by `txid`; `height` 0 = sent by this Kyro, not yet in a block (`since`: unix secs).
    pub spent: Option<SpentBy>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpentBy {
    pub txid: String,
    pub height: u64,
    pub since: u64,
}

/// A transaction that touched this account, as seen on chain.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TxRecord {
    pub txid: String,
    pub height: u64,
    pub time: u64,
    /// Piconero received by our outputs (change included).
    pub received: u64,
    /// Piconero of our outputs it spent.
    pub spent: u64,
    pub fee: Option<u64>,
}

/// A transfer signed and published by this Kyro (the chain does not reveal destinations).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SentRecord {
    pub txid: String,
    pub to: String,
    pub amount: u64,
    pub fee: u64,
    pub time: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XmrCache {
    pub version: u32,
    /// First block scanned. `None` until the first sync: then computed from `created_at`.
    pub restore_height: Option<u64>,
    /// Unix time this account's cache was created (first address shown on this device).
    pub created_at: u64,
    /// Next block number to scan.
    pub next: u64,
    /// `(block number, hash hex)` of the last scanned blocks, oldest first.
    pub hashes: Vec<(u64, String)>,
    pub outputs: Vec<OwnedOutput>,
    pub txs: Vec<TxRecord>,
    pub sent: Vec<SentRecord>,
    /// Highest subaddress minor index handed out (0 = only the primary address).
    pub subaddresses: u32,
    /// Outputs ignored because their key was already received once (burning bug).
    pub burnt_duplicates: u32,
    /// Outputs ignored because of an additional timelock (almost never used).
    pub timelocked_ignored: u32,
}

impl XmrCache {
    pub fn new() -> Self {
        Self {
            version: CACHE_VERSION,
            restore_height: None,
            created_at: now(),
            next: 0,
            hashes: Vec::new(),
            outputs: Vec::new(),
            txs: Vec::new(),
            sent: Vec::new(),
            subaddresses: 0,
            burnt_duplicates: 0,
            timelocked_ignored: 0,
        }
    }

    /// Forgets everything from block `from` on (reorganisation).
    pub fn rewind(&mut self, from: u64) {
        self.outputs.retain(|o| o.height < from);
        for o in &mut self.outputs {
            if o.spent.as_ref().is_some_and(|s| s.height >= from) {
                o.spent = None;
            }
        }
        self.txs.retain(|t| t.height < from);
        self.hashes.retain(|(h, _)| *h < from);
        self.next = self.next.min(from);
    }

    /// Releases local spends never seen on chain after [`PENDING_SPEND_TTL_SECS`].
    pub fn release_stale(&mut self, at: u64) {
        for o in &mut self.outputs {
            if o.spent.as_ref().is_some_and(|s| {
                s.height == 0 && at.saturating_sub(s.since) > PENDING_SPEND_TTL_SECS
            }) {
                o.spent = None;
            }
        }
    }

    /// Balance as of chain height `height` (= latest block number + 1): `(total, unlocked)`.
    pub fn balance(&self, height: u64) -> (u64, u64) {
        let mut total = 0u64;
        let mut unlocked = 0u64;
        for o in self.outputs.iter().filter(|o| o.spent.is_none()) {
            total = total.saturating_add(o.amount);
            if spendable(o, height) {
                unlocked = unlocked.saturating_add(o.amount);
            }
        }
        (total, unlocked)
    }

    /// Scans one block into the cache. `key_images_of` computes our key images (spend key).
    pub fn apply_block(
        &mut self,
        block: ScannableBlock,
        scanner: &mut wallet_core::monero_wallet::Scanner,
        key_images_of: &KeyImagesOf<'_>,
    ) -> AppResult<()> {
        let number = block.block.number() as u64;
        if number != self.next {
            return Err(bad(format!(
                "Monero node: block {number} received, {} expected",
                self.next
            )));
        }
        let hash = hex::encode(block.block.hash());
        if let Some((h, prev)) = self.hashes.last() {
            if *h + 1 == number && hex::encode(block.block.header.previous) != *prev {
                return Err(bad("Monero node: inconsistent chain (previous block)"));
            }
        }
        let time = block.block.header.timestamp;
        let miner = hex::encode(block.block.miner_transaction().hash());
        // Spends first (a transaction cannot spend an output of the same block).
        let mut spent_by: HashMap<String, u64> = HashMap::new();
        for (txh, tx) in block.block.transactions.iter().zip(&block.transactions) {
            let txid = hex::encode(txh);
            let kis: HashSet<String> = wallet_core::xmr_spent_key_images(tx)
                .iter()
                .map(hex::encode)
                .collect();
            for o in &mut self.outputs {
                if kis.contains(&o.key_image) && o.spent.as_ref().is_none_or(|s| s.height == 0) {
                    o.spent = Some(SpentBy {
                        txid: txid.clone(),
                        height: number,
                        since: time,
                    });
                    *spent_by.entry(txid.clone()).or_default() += o.amount;
                }
            }
            if let Some(total) = spent_by.get(&txid).copied() {
                self.record(&txid, number, time, 0, total, wallet_core::xmr_tx_fee(tx));
            }
        }
        let found = scanner
            .scan(block)
            .map_err(|e| bad(format!("unreadable Monero block: {e}")))?;
        let all = found.ignore_additional_timelock();
        let mut fresh = Vec::new();
        for o in all {
            if o.additional_timelock() != wallet_core::monero_wallet::transaction::Timelock::None {
                self.timelocked_ignored = self.timelocked_ignored.saturating_add(1);
                continue;
            }
            let key = hex::encode(o.key().compress().to_bytes());
            let dup = self
                .outputs
                .iter()
                .any(|x| output_key(&x.data) == Some(key.clone()))
                || fresh
                    .iter()
                    .any(|x: &WalletOutput| hex::encode(x.key().compress().to_bytes()) == key);
            if dup {
                // Burning bug: only the first output with a given key is spendable.
                self.burnt_duplicates = self.burnt_duplicates.saturating_add(1);
                continue;
            }
            fresh.push(o);
        }
        if !fresh.is_empty() {
            let kis = key_images_of(&fresh)?;
            for (o, ki) in fresh.iter().zip(kis) {
                let txid = hex::encode(o.transaction());
                let amount = o.commitment().amount;
                self.outputs.push(OwnedOutput {
                    data: hex::encode(o.serialize()),
                    coinbase: txid == miner,
                    subaddress: o.subaddress().map_or(0, |s| s.address()),
                    height: number,
                    amount,
                    key_image: hex::encode(ki),
                    spent: None,
                    txid: txid.clone(),
                });
                self.record(&txid, number, time, amount, 0, None);
            }
        }
        self.hashes.push((number, hash));
        if self.hashes.len() > KEEP_HASHES {
            let cut = self.hashes.len() - KEEP_HASHES;
            self.hashes.drain(..cut);
        }
        self.next = number + 1;
        Ok(())
    }

    fn record(
        &mut self,
        txid: &str,
        height: u64,
        time: u64,
        received: u64,
        spent: u64,
        fee: Option<u64>,
    ) {
        if let Some(t) = self.txs.iter_mut().find(|t| t.txid == txid) {
            t.received = t.received.saturating_add(received);
            t.spent = t.spent.saturating_add(spent);
            if fee.is_some() {
                t.fee = fee;
            }
            return;
        }
        self.txs.push(TxRecord {
            txid: txid.to_owned(),
            height,
            time,
            received,
            spent,
            fee,
        });
    }
}

impl Default for XmrCache {
    fn default() -> Self {
        Self::new()
    }
}

fn output_key(data_hex: &str) -> Option<String> {
    let b = hex::decode(data_hex).ok()?;
    // AbsoluteId (32 + 8) + RelativeId (8), then the 32-byte output key.
    b.get(48..80).map(hex::encode)
}

/// Protocol unlock rule: an output of block `h` is spendable once the chain has `h + 10`
/// blocks (60 for a coinbase).
pub fn spendable(o: &OwnedOutput, height: u64) -> bool {
    let age = if o.coinbase {
        wallet_core::XMR_COINBASE_AGE
    } else {
        wallet_core::XMR_SPENDABLE_AGE
    };
    height >= o.height.saturating_add(age)
}

/// Height to start scanning a never-scanned account from.
pub fn first_restore_height(tip: u64, created_at: u64, at: u64) -> u64 {
    let back = at.saturating_sub(created_at) / BLOCK_SECS + FIRST_SCAN_MARGIN;
    tip.saturating_sub(back)
}

/// Where the first scan of a vault restored from a recovery phrase starts (chosen in the
/// restore flow, kept in `monero/<network>-restore-<key>.json`). A vault created in Kyro has none.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RestoreFrom {
    /// Default: Kyro's first release (a Kyro-derived Monero wallet cannot be older).
    Kyro,
    /// The phrase was used with Monero before (Ledger): from this Unix time.
    Date { date: u64 },
    /// From the genesis block (can take hours).
    Genesis,
}

/// Height to start the first scan of an account from: [`first_restore_height`] for a vault
/// created here, never later than the restore choice for a restored one.
pub fn start_height(
    tip: u64,
    created_at: u64,
    at: u64,
    network: Network,
    restored: Option<RestoreFrom>,
) -> u64 {
    let created = first_restore_height(tip, created_at, at);
    let restored = match restored {
        None => return created,
        Some(RestoreFrom::Genesis) => 0,
        Some(RestoreFrom::Kyro) => match network {
            Network::Mainnet => KYRO_FIRST_RELEASE_HEIGHT,
            Network::Testnet => first_restore_height(tip, KYRO_FIRST_RELEASE_TIME, at),
        },
        // Never after Kyro's release: the phrase existed in Kyro from then on at the latest.
        Some(RestoreFrom::Date { date }) => {
            let by_date = first_restore_height(tip, date.min(KYRO_FIRST_RELEASE_TIME), at);
            match network {
                Network::Mainnet => by_date.min(KYRO_FIRST_RELEASE_HEIGHT),
                Network::Testnet => by_date,
            }
        }
    };
    restored.min(created)
}

fn restore_path(state: &AppState) -> AppResult<PathBuf> {
    let (spend, _) = state.with_seed(|s| Ok(wallet_core::xmr_public_keys(s, 0)?))?;
    let net = match state.network {
        Network::Mainnet => "mainnet",
        Network::Testnet => "stagenet",
    };
    Ok(state
        .data_dir()
        .join("monero")
        .join(format!("{net}-restore-{}.json", &spend[..16])))
}

/// Records the restore choice of the vault just imported (applies to all its Monero accounts).
pub fn save_restore_from(state: &AppState, from: RestoreFrom) -> AppResult<()> {
    let path = restore_path(state)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| AppError::Internal(e.to_string()))?;
    }
    let json = serde_json::to_vec(&from).map_err(|e| AppError::Internal(e.to_string()))?;
    std::fs::write(&path, json).map_err(|e| AppError::Internal(e.to_string()))
}

/// The restore choice of this vault, `None` if it was created in Kyro.
pub fn load_restore_from(state: &AppState) -> Option<RestoreFrom> {
    let bytes = std::fs::read(restore_path(state).ok()?).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn cache_path(state: &AppState, account: u32) -> AppResult<PathBuf> {
    let (spend, _) = state.with_seed(|s| Ok(wallet_core::xmr_public_keys(s, account)?))?;
    let net = match state.network {
        Network::Mainnet => "mainnet",
        Network::Testnet => "stagenet",
    };
    Ok(state
        .data_dir()
        .join("monero")
        .join(format!("{net}-{account}-{}.bin", &spend[..16])))
}

/// Reads the cache of `account` (a fresh one if none exists yet).
pub fn load(state: &AppState, account: u32) -> AppResult<XmrCache> {
    let path = cache_path(state, account)?;
    let Ok(bytes) = std::fs::read(&path) else {
        return Ok(XmrCache::new());
    };
    let plain = state.with_seed(|s| {
        Ok(wallet_core::xmr_cache_open(
            s,
            state.network,
            account,
            &bytes,
        )?)
    })?;
    let c: XmrCache = serde_json::from_slice(&plain)
        .map_err(|_| AppError::Internal("unreadable Monero cache".into()))?;
    if c.version != CACHE_VERSION {
        return Ok(XmrCache::new());
    }
    Ok(c)
}

/// Writes the cache of `account` (encrypted, atomically).
pub fn save(state: &AppState, account: u32, c: &XmrCache) -> AppResult<()> {
    let path = cache_path(state, account)?;
    let plain = zeroize::Zeroizing::new(
        serde_json::to_vec(c).map_err(|e| AppError::Internal(e.to_string()))?,
    );
    let sealed = state.with_seed(|s| {
        Ok(wallet_core::xmr_cache_seal(
            s,
            state.network,
            account,
            &plain,
        )?)
    })?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| AppError::Internal(e.to_string()))?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, sealed).map_err(|e| AppError::Internal(e.to_string()))?;
    std::fs::rename(&tmp, &path).map_err(|e| AppError::Internal(e.to_string()))
}

/// Deletes the cache of `account` (rescan from a new restore height).
pub fn reset(state: &AppState, account: u32, restore_height: Option<u64>) -> AppResult<XmrCache> {
    let old = load(state, account).unwrap_or_default();
    let mut c = XmrCache::new();
    c.created_at = old.created_at.min(now());
    c.subaddresses = old.subaddresses;
    c.sent = old.sent;
    c.restore_height = restore_height;
    c.next = restore_height.unwrap_or(0);
    save(state, account, &c)?;
    Ok(c)
}

// ---------------------------------------------------------------- tasks and pending transfers

/// Progress of the scan of one account, shown by the UI (`xmr_status`).
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncProgress {
    pub running: bool,
    /// Node's chain height (latest block number + 1), when known.
    pub tip: Option<u64>,
    /// Unix time of the node's latest block, when known.
    pub tip_time: Option<u64>,
    pub error: Option<String>,
    /// Unix time of the last completed sync.
    pub synced_at: Option<u64>,
}

pub struct PendingTx {
    pub network: Network,
    pub account: u32,
    pub unsigned: XmrUnsigned,
    /// Key images of the outputs it spends (hex).
    pub key_images: Vec<String>,
    pub created: Instant,
}

type FileLock = Arc<tokio::sync::Mutex<()>>;

#[derive(Default)]
pub struct XmrManager {
    progress: Mutex<HashMap<(Network, u32), SyncProgress>>,
    pending: Mutex<HashMap<String, PendingTx>>,
    /// One lock per account around every read-modify-write of its cache file.
    file_locks: Mutex<HashMap<(Network, u32), FileLock>>,
    /// Bumped on every lock of the vault: scan tasks of an older epoch stop.
    epoch: AtomicU64,
}

impl XmrManager {
    pub fn on_lock(&self) {
        crate::net::lock(&self.pending).clear();
        self.epoch.fetch_add(1, Ordering::SeqCst);
    }

    pub fn epoch(&self) -> u64 {
        self.epoch.load(Ordering::SeqCst)
    }

    pub fn progress(&self, net: Network, account: u32) -> SyncProgress {
        crate::net::lock(&self.progress)
            .get(&(net, account))
            .cloned()
            .unwrap_or_default()
    }

    fn update(&self, net: Network, account: u32, f: impl FnOnce(&mut SyncProgress)) {
        f(crate::net::lock(&self.progress)
            .entry((net, account))
            .or_default());
    }

    /// Marks a scan of `account` as running; `false` if one already runs.
    pub fn try_start(&self, net: Network, account: u32) -> bool {
        let mut map = crate::net::lock(&self.progress);
        let p = map.entry((net, account)).or_default();
        if p.running {
            return false;
        }
        p.running = true;
        p.error = None;
        true
    }

    /// End of a scan task: `err` is shown by `xmr_status` (a lock of the vault is not an error).
    pub fn finish(&self, net: Network, account: u32, err: Option<AppError>) {
        self.update(net, account, |p| {
            p.running = false;
            p.error = err
                .filter(|e| !matches!(e, AppError::Locked))
                .map(|e| e.to_string());
        });
    }

    pub fn file_lock(&self, net: Network, account: u32) -> Arc<tokio::sync::Mutex<()>> {
        crate::net::lock(&self.file_locks)
            .entry((net, account))
            .or_default()
            .clone()
    }

    pub fn put_pending(&self, id: String, p: PendingTx) {
        let mut map = crate::net::lock(&self.pending);
        map.retain(|_, v| v.created.elapsed().as_secs() < PENDING_TTL_SECS);
        map.insert(id, p);
    }

    pub fn take_pending(&self, id: &str) -> AppResult<PendingTx> {
        let p = crate::net::lock(&self.pending).remove(id).ok_or_else(|| {
            AppError::InvalidInput("unknown or expired Monero transfer: prepare it again".into())
        })?;
        if p.created.elapsed().as_secs() >= PENDING_TTL_SECS {
            return Err(AppError::InvalidInput(
                "Monero transfer prepared more than 10 min ago: prepare it again".into(),
            ));
        }
        Ok(p)
    }
}

/// Context of one Monero call.
pub struct XmrCtx {
    pub net: Arc<NetClient>,
    pub network: Network,
    pub tor: bool,
    pub server: MoneroServer,
}

impl XmrCtx {
    pub fn of(state: &AppState) -> Self {
        let s = state.settings();
        Self {
            net: state.net.clone(),
            network: state.network,
            tor: s.tor.enabled,
            server: s.servers.monero.for_network(state.network),
        }
    }
}

/// Scans `account` up to the node's tip, batch by batch, saving after each batch. Stops early
/// (keeping what was scanned) if the vault is locked.
pub async fn sync(state: &AppState, account: u32) -> AppResult<()> {
    let epoch = state.xmr.epoch();
    let ctx = XmrCtx::of(state);
    let daemon = connect(&ctx.net, ctx.network, &ctx.server, ctx.tor).await?;
    let lock = state.xmr.file_lock(ctx.network, account);
    loop {
        if state.xmr.epoch() != epoch || !state.is_unlocked() {
            return Err(AppError::Locked);
        }
        let tip_number = daemon.latest_block_number().await.map_err(app_err)? as u64;
        let height = tip_number + 1;
        state
            .xmr
            .update(ctx.network, account, |p| p.tip = Some(height));
        let _guard = lock.lock().await;
        let mut c = load(state, account)?;
        // Only the very first sync picks the start: later runs (and restarts) resume from the
        // stored `next`, saved after each batch.
        if c.restore_height.is_none() {
            let restored = load_restore_from(state);
            let r = start_height(tip_number, c.created_at, now(), ctx.network, restored);
            c.restore_height = Some(r);
            c.next = r;
        }
        // Reorganisation check: our last block must still be the node's.
        if let Some((n, h)) = c.hashes.last().cloned() {
            let theirs = ProvidesBlockchain::block_hash(&daemon, n as usize)
                .await
                .map(hex::encode);
            if theirs.as_deref().ok() != Some(h.as_str()) {
                let from = n
                    .saturating_sub(REORG_DEPTH)
                    .max(c.restore_height.unwrap_or(0));
                c.rewind(from);
                if c.hashes.is_empty() {
                    c.next = from;
                }
            }
        }
        c.release_stale(now());
        if c.next > tip_number {
            save(state, account, &c)?;
            state.xmr.update(ctx.network, account, |p| {
                p.synced_at = Some(now());
            });
            return Ok(());
        }
        let end = (c.next + BATCH as u64 - 1).min(tip_number);
        let blocks = ProvidesScannableBlocks::contiguous_scannable_blocks(
            &daemon,
            c.next as usize..=end as usize,
        )
        .await
        .map_err(app_err)?;
        if let Some(last) = blocks.last() {
            let t = last.block.header.timestamp;
            state
                .xmr
                .update(ctx.network, account, |p| p.tip_time = Some(t));
        }
        let mut scanner = state.with_seed(|s| {
            Ok(wallet_core::xmr_scanner(
                s,
                account,
                c.subaddresses + wallet_core::XMR_SUBADDRESS_LOOKAHEAD,
            )?)
        })?;
        let images = |outs: &[WalletOutput]| {
            state.with_seed(|s| Ok(wallet_core::xmr_key_images(s, account, outs)?))
        };
        for b in blocks {
            c.apply_block(b, &mut scanner, &images)?;
        }
        save(state, account, &c)?;
    }
}

// ---------------------------------------------------------------- history

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XmrHistoryEntry {
    pub txid: String,
    /// `in`, `out` or `self` (only our own addresses received it).
    pub direction: &'static str,
    /// Piconero: received (in) or sent to others (out).
    pub amount: String,
    pub fee: Option<String>,
    /// Destination of a transfer signed by this Kyro (the chain does not reveal it).
    pub to: Option<String>,
    /// 0 = not yet in a block.
    pub height: u64,
    pub time: u64,
    pub confirmations: u64,
}

pub fn history(c: &XmrCache, height: u64) -> Vec<XmrHistoryEntry> {
    let mut out: Vec<XmrHistoryEntry> = c
        .txs
        .iter()
        .map(|t| {
            let sent = c.sent.iter().find(|s| s.txid == t.txid);
            let (direction, amount) = if t.spent > 0 {
                let fee = t.fee.unwrap_or(0);
                let others = t.spent.saturating_sub(t.received).saturating_sub(fee);
                match sent {
                    Some(s) => ("out", s.amount),
                    None if others == 0 => ("self", t.received),
                    None => ("out", others),
                }
            } else {
                ("in", t.received)
            };
            XmrHistoryEntry {
                txid: t.txid.clone(),
                direction,
                amount: amount.to_string(),
                fee: (t.spent > 0).then(|| t.fee.unwrap_or(0).to_string()),
                to: sent.map(|s| s.to.clone()),
                height: t.height,
                time: t.time,
                confirmations: height.saturating_sub(t.height),
            }
        })
        .collect();
    for s in &c.sent {
        if !c.txs.iter().any(|t| t.txid == s.txid)
            && c.outputs.iter().any(|o| {
                o.spent
                    .as_ref()
                    .is_some_and(|x| x.txid == s.txid && x.height == 0)
            })
        {
            out.push(XmrHistoryEntry {
                txid: s.txid.clone(),
                direction: "out",
                amount: s.amount.to_string(),
                fee: Some(s.fee.to_string()),
                to: Some(s.to.clone()),
                height: 0,
                time: s.time,
                confirmations: 0,
            });
        }
    }
    out.sort_by_key(|e| std::cmp::Reverse((e.height == 0, e.height, e.time)));
    out.truncate(MAX_HISTORY);
    out
}

// ---------------------------------------------------------------- sending

/// Our unspent, unlocked outputs, largest first.
pub fn candidates(c: &XmrCache, height: u64) -> Vec<&OwnedOutput> {
    let mut v: Vec<&OwnedOutput> = c
        .outputs
        .iter()
        .filter(|o| o.spent.is_none() && spendable(o, height))
        .collect();
    v.sort_by(|a, b| b.amount.cmp(&a.amount).then(a.height.cmp(&b.height)));
    v
}

fn wallet_output(o: &OwnedOutput) -> AppResult<WalletOutput> {
    let b =
        hex::decode(&o.data).map_err(|_| AppError::Internal("unreadable Monero cache".into()))?;
    WalletOutput::read(&mut b.as_slice())
        .map_err(|_| AppError::Internal("unreadable Monero cache".into()))
}

/// What `xmr_prepare_tx` returns.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XmrPrepared {
    /// Handle of the transfer kept by Rust (never the transaction itself).
    pub id: String,
    pub summary: XmrTxSummary,
}

/// Selects inputs, fetches their decoys and the fee rate, builds the transfer (Rust), and keeps
/// it for `xmr_send_tx`. `amount` = `None`: send everything that is unlocked (up to
/// [`MAX_INPUTS`] outputs).
pub async fn prepare(
    state: &AppState,
    account: u32,
    to: &str,
    amount: Option<u64>,
) -> AppResult<XmrPrepared> {
    wallet_core::xmr_parse_address(to, state.network)?;
    let ctx = XmrCtx::of(state);
    let daemon = connect(&ctx.net, ctx.network, &ctx.server, ctx.tor).await?;
    let tip_number = daemon.latest_block_number().await.map_err(app_err)?;
    let height = tip_number as u64 + 1;
    let c = load(state, account)?;
    if c.restore_height.is_none() || c.next + 2 < height {
        return Err(AppError::InvalidInput(format!(
            "Monero: sync incomplete (block {} of {height}): wait for the scan to finish",
            c.next
        )));
    }
    let fee_rate = ProvidesFeeRates::fee_rate(&daemon, FeePriority::Normal, MAX_FEE_PER_WEIGHT)
        .await
        .map_err(|e| bad(format!("Monero fees refused: {e}")))?;
    let cands = candidates(&c, height);
    if cands.is_empty() {
        let (total, _) = c.balance(height);
        return Err(AppError::InvalidInput(if total > 0 {
            "Monero: funds still locked (10 confirmations, ≈ 20 min, before they can be spent)"
                .into()
        } else {
            "Monero: no funds available".into()
        }));
    }
    // Rough fee to pick inputs: weight ≈ 1 500 + 700 per extra input.
    let est = |n: usize| fee_rate.per_weight().saturating_mul(1_500 + 700 * n as u64);
    let mut chosen: Vec<&OwnedOutput> = Vec::new();
    match amount {
        Some(a) => {
            let mut sum = 0u64;
            for o in &cands {
                if chosen.len() >= MAX_INPUTS || sum >= a.saturating_add(est(chosen.len().max(1))) {
                    break;
                }
                chosen.push(o);
                sum = sum.saturating_add(o.amount);
            }
            if sum < a.saturating_add(est(chosen.len())) && chosen.len() >= MAX_INPUTS {
                return Err(AppError::InvalidInput(format!(
                    "Monero: this amount needs more than {MAX_INPUTS} outputs; send less at a time"
                )));
            }
        }
        None => chosen = cands.iter().take(MAX_INPUTS).copied().collect(),
    }
    let key_images: Vec<String> = chosen.iter().map(|o| o.key_image.clone()).collect();
    let decoys = CachedDecoys {
        daemon: &daemon,
        dist: Mutex::new(None),
    };
    let mut inputs = Vec::with_capacity(chosen.len());
    for o in &chosen {
        let mut rng = wallet_core::xmr_rng()?;
        let w = wallet_output(o)?;
        let with =
            OutputWithDecoys::new(&mut rng, &decoys, wallet_core::XMR_RING_LEN, tip_number, w)
                .await
                .map_err(tx_err)?;
        inputs.push(with);
    }
    let total: u64 = chosen.iter().map(|o| o.amount).sum();
    let own = (0..=c.subaddresses)
        .map(|i| state.with_seed(|s| Ok(wallet_core::xmr_address(s, state.network, account, i)?)))
        .collect::<AppResult<Vec<String>>>()?;
    let send_amount = match amount {
        Some(a) => a,
        None => {
            // Fee of this exact shape (fee does not depend on the amount), then everything else.
            let probe = state.with_seed(|s| {
                Ok(wallet_core::xmr_build(
                    s,
                    state.network,
                    account,
                    inputs.clone(),
                    to,
                    1,
                    fee_rate,
                    &own,
                )?)
            })?;
            let fee: u64 = probe.summary.fee.parse().unwrap_or(u64::MAX);
            total.checked_sub(fee).filter(|a| *a > 0).ok_or_else(|| {
                AppError::InvalidInput("Monero: balance lower than the fee".into())
            })?
        }
    };
    let unsigned = state.with_seed(|s| {
        Ok(wallet_core::xmr_build(
            s,
            state.network,
            account,
            inputs,
            to,
            send_amount,
            fee_rate,
            &own,
        )?)
    })?;
    let summary = unsigned.summary.clone();
    let mut idb = [0u8; 16];
    getrandom::getrandom(&mut idb)
        .map_err(|_| AppError::Internal("randomness unavailable".into()))?;
    let id = hex::encode(idb);
    state.xmr.put_pending(
        id.clone(),
        PendingTx {
            network: state.network,
            account,
            unsigned,
            key_images,
            created: Instant::now(),
        },
    );
    Ok(XmrPrepared { id, summary })
}

/// Publishes a signed transfer and records it (outputs marked spent, destination kept).
pub async fn publish(
    state: &AppState,
    account: u32,
    signed: &wallet_core::XmrSigned,
    key_images: &[String],
) -> AppResult<()> {
    let ctx = XmrCtx::of(state);
    let daemon = connect(&ctx.net, ctx.network, &ctx.server, ctx.tor).await?;
    let lock = state.xmr.file_lock(ctx.network, account);
    let _guard = lock.lock().await;
    let c = load(state, account)?;
    for ki in key_images {
        let o = c
            .outputs
            .iter()
            .find(|o| &o.key_image == ki)
            .ok_or_else(|| AppError::InvalidInput("unknown Monero output".into()))?;
        if o.spent.is_some() {
            return Err(AppError::InvalidInput(
                "one of the outputs is already spent: prepare the transfer again".into(),
            ));
        }
    }
    PublishTransaction::publish_transaction(&daemon, &signed.tx)
        .await
        .map_err(|e| match e {
            PublishTransactionError::InterfaceError(i) => app_err(i),
            PublishTransactionError::TransactionRejected(r) => AppError::InvalidInput(format!(
                "transaction refused by the Monero node: {}",
                r.chars().take(200).collect::<String>()
            )),
        })?;
    // Re-read: the scan task may have saved meanwhile (it takes the same lock, so not).
    let mut c = load(state, account)?;
    let at = now();
    for o in &mut c.outputs {
        if key_images.contains(&o.key_image) {
            o.spent = Some(SpentBy {
                txid: signed.txid.clone(),
                height: 0,
                since: at,
            });
        }
    }
    c.sent.push(SentRecord {
        txid: signed.txid.clone(),
        to: signed.summary.destination.address.clone(),
        amount: signed.summary.amount.parse().unwrap_or(0),
        fee: signed.summary.fee.parse().unwrap_or(0),
        time: at,
    });
    if c.sent.len() > MAX_HISTORY {
        let cut = c.sent.len() - MAX_HISTORY;
        c.sent.drain(..cut);
    }
    save(state, account, &c)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn out(height: u64, amount: u64, coinbase: bool, ki: &str) -> OwnedOutput {
        OwnedOutput {
            data: String::new(),
            txid: format!("tx{height}"),
            height,
            amount,
            subaddress: 0,
            coinbase,
            key_image: ki.into(),
            spent: None,
        }
    }

    #[test]
    fn unlock_rules_and_balance() {
        let mut c = XmrCache::new();
        c.outputs = vec![
            out(100, 5, false, "a"),
            out(105, 7, false, "b"),
            out(100, 11, true, "c"),
        ];
        // Height 110: block 100 has 10 blocks on top of it (100..=109) → spendable.
        assert_eq!(c.balance(110), (23, 5));
        assert_eq!(c.balance(109), (23, 0));
        assert_eq!(c.balance(160), (23, 23));
        c.outputs[0].spent = Some(SpentBy {
            txid: "t".into(),
            height: 0,
            since: 1_000,
        });
        assert_eq!(c.balance(160), (18, 18));
        assert_eq!(candidates(&c, 160).len(), 2);
        assert_eq!(candidates(&c, 160)[0].amount, 11);
        // A local spend never mined is released after a day.
        c.release_stale(1_000 + PENDING_SPEND_TTL_SECS);
        assert!(c.outputs[0].spent.is_some());
        c.release_stale(1_001 + PENDING_SPEND_TTL_SECS);
        assert!(c.outputs[0].spent.is_none());
    }

    #[test]
    fn rewind_forgets_recent_blocks_only() {
        let mut c = XmrCache::new();
        c.next = 200;
        c.outputs = vec![out(100, 5, false, "a"), out(190, 7, false, "b")];
        c.outputs[0].spent = Some(SpentBy {
            txid: "t".into(),
            height: 195,
            since: 0,
        });
        c.txs = vec![
            TxRecord {
                txid: "x".into(),
                height: 100,
                time: 0,
                received: 5,
                spent: 0,
                fee: None,
            },
            TxRecord {
                txid: "y".into(),
                height: 195,
                time: 0,
                received: 0,
                spent: 5,
                fee: Some(1),
            },
        ];
        c.hashes = (180..200).map(|h| (h, format!("{h}"))).collect();
        c.rewind(185);
        assert_eq!(c.next, 185);
        assert_eq!(c.outputs.len(), 1);
        assert!(c.outputs[0].spent.is_none());
        assert_eq!(c.txs.len(), 1);
        assert_eq!(c.hashes.last().unwrap().0, 184);
    }

    #[test]
    fn first_scan_starts_before_the_address_was_shown() {
        // Created 2 h ago: 60 blocks + 1 day of margin.
        assert_eq!(
            first_restore_height(3_000_000, 1_000, 1_000 + 7_200),
            3_000_000 - 60 - 720
        );
        assert_eq!(first_restore_height(100, 0, 1_000_000), 0);
    }

    #[test]
    fn restored_vault_scans_from_kyro_release_by_default() {
        let at = KYRO_FIRST_RELEASE_TIME + 30 * 86_400;
        let tip = KYRO_FIRST_RELEASE_HEIGHT + 30 * 720;
        // Created here: from the address's first display (minus one day), as before.
        assert_eq!(
            start_height(tip, at - 7_200, at, Network::Mainnet, None),
            tip - 60 - 720
        );
        // Restored: Kyro's first release height, even though the cache is brand new.
        assert_eq!(
            start_height(tip, at, at, Network::Mainnet, Some(RestoreFrom::Kyro)),
            KYRO_FIRST_RELEASE_HEIGHT
        );
        // Stagenet: estimated from the release date.
        assert_eq!(
            start_height(1_900_000, at, at, Network::Testnet, Some(RestoreFrom::Kyro)),
            1_900_000 - 30 * 720 - 720
        );
    }

    #[test]
    fn restored_with_ledger_history_goes_back_further() {
        let at = KYRO_FIRST_RELEASE_TIME + 10 * 86_400;
        let tip = KYRO_FIRST_RELEASE_HEIGHT + 10 * 720;
        let year_before = KYRO_FIRST_RELEASE_TIME - 365 * 86_400;
        let from = |r| start_height(tip, at, at, Network::Mainnet, Some(r));
        assert_eq!(
            from(RestoreFrom::Date { date: year_before }),
            tip - 375 * 720 - 720
        );
        assert_eq!(from(RestoreFrom::Genesis), 0);
        // A date after Kyro's release never starts later than the release (estimate − 1 day).
        assert_eq!(
            from(RestoreFrom::Date { date: at }),
            KYRO_FIRST_RELEASE_HEIGHT - 720
        );
    }

    #[test]
    fn restore_choice_wire_format() {
        let j = |s: &str| serde_json::from_str::<RestoreFrom>(s).unwrap();
        assert_eq!(j(r#"{"kind":"kyro"}"#), RestoreFrom::Kyro);
        assert_eq!(j(r#"{"kind":"genesis"}"#), RestoreFrom::Genesis);
        assert_eq!(
            j(r#"{"kind":"date","date":5}"#),
            RestoreFrom::Date { date: 5 }
        );
    }

    #[test]
    fn history_directions() {
        let mut c = XmrCache::new();
        c.txs = vec![
            TxRecord {
                txid: "in".into(),
                height: 10,
                time: 1,
                received: 50,
                spent: 0,
                fee: None,
            },
            TxRecord {
                txid: "out".into(),
                height: 20,
                time: 2,
                received: 10,
                spent: 50,
                fee: Some(3),
            },
            TxRecord {
                txid: "self".into(),
                height: 30,
                time: 3,
                received: 7,
                spent: 10,
                fee: Some(3),
            },
        ];
        c.sent = vec![SentRecord {
            txid: "pending".into(),
            to: "8abc".into(),
            amount: 4,
            fee: 1,
            time: 9,
        }];
        let mut o = out(30, 7, false, "k");
        o.spent = Some(SpentBy {
            txid: "pending".into(),
            height: 0,
            since: 9,
        });
        c.outputs = vec![o];
        let h = history(&c, 40);
        let by = |id: &str| h.iter().find(|e| e.txid == id).unwrap().clone();
        assert_eq!(h[0].txid, "pending");
        assert_eq!((by("pending").direction, by("pending").height), ("out", 0));
        assert_eq!(by("pending").to.as_deref(), Some("8abc"));
        assert_eq!((by("in").direction, by("in").amount.as_str()), ("in", "50"));
        assert_eq!(
            (by("out").direction, by("out").amount.as_str()),
            ("out", "37")
        );
        assert_eq!(by("out").fee.as_deref(), Some("3"));
        assert_eq!(by("self").direction, "self");
        assert_eq!(by("in").confirmations, 30);
    }

    #[test]
    fn output_key_offset_in_serialization() {
        let mut data = vec![0u8; 48];
        data.extend([7u8; 32]);
        data.extend([0u8; 40]);
        assert_eq!(
            output_key(&hex::encode(&data)),
            Some(hex::encode([7u8; 32]))
        );
        assert_eq!(output_key("00"), None);
    }

    #[test]
    fn tor_errors_stay_tor_errors() {
        let e = app_err(interface_err(AppError::TorUnavailable("not ready".into())));
        assert!(matches!(e, AppError::TorUnavailable(ref m) if m == "not ready"));
        assert!(matches!(
            app_err(InterfaceError::InvalidInterface("x".into())),
            AppError::ServerUnreachable(_)
        ));
    }
}
