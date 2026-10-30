//! Compact block filters backend (BIP157/158) via `bip157` — cargo feature `cbf`.
//!
//! Kyro downloads block filters from P2P peers, matches them locally against our scripts
//! (no server learns our addresses), and fetches only the matching blocks.
//!
//! Network rule (fail closed): with Tor enabled, bip157 is ALWAYS given our loopback SOCKS
//! bridge (see `socks.rs`) and connects to nothing else; peers come only from our own list
//! (no DNS seeds, no addr gossip: `whitelist_only`), onion peers first, IPv4 through Tor exits
//! as a fallback. With Tor disabled (explicit user choice), IPv4/IPv6 peers are reached
//! directly and onion peers are skipped.

mod scan;
mod socks;

use std::collections::{BTreeMap, HashSet};
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use bip157::chain::BlockHeaderChanges;
use bip157::{Builder, ChainState, Event, HashCheckpoint, Info, TrustedPeer, Warning};
use bitcoin::consensus::encode::{deserialize_hex, serialize_hex};
use bitcoin::p2p::address::AddrV2;
use bitcoin::p2p::ServiceFlags;
use bitcoin::{OutPoint, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use wallet_core::Network;

pub use scan::WatchSet;
use scan::{relevant_txs, Ledger, StoredTx};

use crate::error::{AppError, AppResult};
use crate::servers::{parse_peer, Peer, PeerHost};
use crate::tor::TorManager;

/// Filter-serving peers verified over Tor on 2026-10-30 (NODE_COMPACT_FILTERS advertised),
/// from Bitcoin Core's `contrib/seeds/nodes_testnet4.txt`. Users can add more.
pub const TESTNET4_PEERS: &[&str] = &[
    "a6yijgwn4vtmmhl7uybtbuyvtl7mtj7arld5f4csqsx4syeii4gt3vqd.onion:48333",
    "fsijrllgzgeg4pa5ebq4qy3swmplxkzvuvji5swt36quy42dznq3t3ad.onion:48333",
    "kolvizpy2tctu7tyq5qlquodwcsljtfbmowcxqsihfrlvwlihpsijwad.onion:48333",
    "mdiwdijucocysdvx5dk2iyo5wsav3ehyiggegzfk3ezfcce6nstp4nid.onion:48333",
    "snkvtmm4goxig5ctvvi2rk6nhznamdyuryu3fqo7yw4x2mpxmqkowbqd.onion:48333",
    "wkvaxtftpwmmvrptqavx6mwhrcwiecbodtshuenvot3cjgxsycuurcid.onion:48333",
    "3.235.25.166:48333",
    "148.51.196.40:48333",
    "203.132.94.196:48333",
    "208.68.4.50:48333",
    "216.230.225.61:48333",
];

/// Mainnet filter-serving peers from a sample of Bitcoin Core's `contrib/seeds/nodes_main.txt`
/// (75 sampled, 43 reachable over Tor, 14 with NODE_COMPACT_FILTERS, 2026-10-30).
pub const MAINNET_PEERS: &[&str] = &[
    "pawswtwrpzk4r5kpjivwryiu44ef4eo2xtum2n7nlj53h7xqnfkfebyd.onion:8333",
    "7gfc4defjmhasph34fias6icvxe26bvu2hisrpah546wqjbfwc6iuyid.onion:8333",
    "7b6ijwd43pur75adi3bi5ryzr7l3ut3p33dqcdmlthtf5a4hf4kivuad.onion:8333",
    "aqptmmcc4dwmf7it326uki3xth7a7v7dnlxg3ipmb3xdepbnkbtxuvqd.onion:8333",
    "dmvyioqy2z4qhxbv7alhrqqfhsunby2blhcug44ua2xwbw3omvfib6yd.onion:8333",
    "toz6j4iyoooafbxlapw7njxzuncoijuhyvizuz3dpxn6je6dn3vvm5id.onion:8333",
    "4zwkussxtjykoetv5mgbmegyntqif2tyiwnx2fmliqo6lkkz4blzuqyd.onion:8333",
    "dwowpkhxbb6rcbvphupnayriwzv2megouqerasfh4rg7pizme6k64tqd.onion:8333",
    "n2jg5hr5xkqnhvvekyvlpt3um7rxljwnjh4rrkyrddectavaxkapzgid.onion:8333",
    "brog5tw37z45zrj4qmnwvyejeknody4kzl6m6znhkrlzltwbb5rbx5ad.onion:8333",
    "b44qtuf7kpz3zq4pjsrkcar2yvvmmnwlr3jxd2n4mrngzc34ggolqwid.onion:8333",
    "217.154.63.148:8333",
    "160.16.205.60:8333",
    "37.189.10.185:8333",
];

/// Recent headers kept on disk to resume header sync without starting from genesis
/// (one difficulty period plus margin).
const HEADER_SNAPSHOT: u32 = 2_200;
/// No progress for this long → the sync fails (and the bridge closes).
const STALL: Duration = Duration::from_secs(300);
const BROADCAST_WAIT: Duration = Duration::from_secs(120);
const FEE_BLOCKS: u32 = 3;
const MAX_RESCANS: usize = 4;

// ---------------------------------------------------------------- peers & plan

/// Default peer list for the network, plus user additions (user peers first).
pub fn peer_list(net: Network, user: &[String]) -> AppResult<Vec<Peer>> {
    let defaults = match net {
        Network::Mainnet => MAINNET_PEERS,
        Network::Testnet => TESTNET4_PEERS,
    };
    let mut out: Vec<Peer> = Vec::new();
    for s in user
        .iter()
        .map(String::as_str)
        .chain(defaults.iter().copied())
    {
        let p = parse_peer(s)?;
        if !out.contains(&p) {
            out.push(p);
        }
    }
    Ok(out)
}

/// How bip157 will reach peers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Plan {
    /// Tor on: every connection through our SOCKS bridge; onion first, IPv4 after.
    Tor(Vec<Peer>),
    /// Tor off (explicit user choice): IP peers only, direct.
    Clear(Vec<Peer>),
}

pub fn plan(peers: &[Peer], tor: bool) -> AppResult<Plan> {
    let onion: Vec<Peer> = peers
        .iter()
        .filter(|p| matches!(p.host, PeerHost::Onion { .. }))
        .cloned()
        .collect();
    let ip: Vec<Peer> = peers
        .iter()
        .filter(|p| matches!(p.host, PeerHost::Ip(_)))
        .cloned()
        .collect();
    let plan = if tor {
        Plan::Tor(onion.into_iter().chain(ip).collect())
    } else {
        Plan::Clear(ip)
    };
    match &plan {
        Plan::Tor(p) | Plan::Clear(p) if p.is_empty() => Err(AppError::ServerInvalid(
            "filtres compacts : aucun pair utilisable".into(),
        )),
        _ => Ok(plan),
    }
}

fn trusted(p: &Peer) -> TrustedPeer {
    let addr = match &p.host {
        PeerHost::Onion { key, .. } => AddrV2::TorV3(*key),
        PeerHost::Ip(IpAddr::V4(v4)) => AddrV2::Ipv4(*v4),
        PeerHost::Ip(IpAddr::V6(v6)) => AddrV2::Ipv6(*v6),
    };
    TrustedPeer::new(addr, Some(p.port), ServiceFlags::COMPACT_FILTERS)
}

fn btc_network(net: Network) -> bitcoin::Network {
    match net {
        Network::Mainnet => bitcoin::Network::Bitcoin,
        Network::Testnet => bitcoin::Network::Testnet4,
    }
}

// ---------------------------------------------------------------- store

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Store {
    pub version: u32,
    pub birth_height: u32,
    /// Filters scanned (for the current watch set) up to this height.
    pub scanned_to: Option<u32>,
    pub tip_height: Option<u32>,
    /// Recent headers `(height, consensus hex)`, contiguous, for a fast restart.
    pub headers: Vec<(u32, String)>,
    pub txs: BTreeMap<String, StoredTx>,
    /// sat/vB averages over the last blocks (fees paid / weight), newest first.
    pub block_fee_rates: Vec<u64>,
    pub min_relay_sat_vb: Option<u64>,
    pub last_sync_unix: Option<u64>,
}

pub fn store_path(data_dir: &Path, net: Network) -> PathBuf {
    data_dir.join("cbf").join(match net {
        Network::Mainnet => "mainnet.json",
        Network::Testnet => "testnet4.json",
    })
}

impl Store {
    pub fn load(path: &Path) -> Store {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, path: &Path) -> AppResult<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        crate::settings::write_atomic(path, serde_json::to_string(self)?.as_bytes())
    }

    fn known_outpoints(&self, watch: &WatchSet) -> HashSet<OutPoint> {
        let mut out = HashSet::new();
        for t in self.txs.values() {
            if let Ok(tx) = deserialize_hex::<Transaction>(&t.hex) {
                let txid = tx.compute_txid();
                for (i, o) in tx.output.iter().enumerate() {
                    if watch.contains(&o.script_pubkey) {
                        out.insert(OutPoint {
                            txid,
                            vout: i as u32,
                        });
                    }
                }
            }
        }
        out
    }

    fn chain_state(&self, net: Network) -> ChainState {
        let headers: Vec<bip157::chain::IndexedHeader> = self
            .headers
            .iter()
            .filter_map(|(h, hex)| {
                Some(bip157::chain::IndexedHeader {
                    height: *h,
                    header: deserialize_hex(hex).ok()?,
                })
            })
            .collect();
        if headers.len() as u32 >= HEADER_SNAPSHOT / 2 {
            ChainState::Snapshot(headers)
        } else {
            ChainState::Checkpoint(HashCheckpoint::from_genesis(btc_network(net)))
        }
    }

    fn drop_blocks(&mut self, hashes: &HashSet<String>) {
        for t in self.txs.values_mut() {
            if t.block_hash.as_ref().is_some_and(|h| hashes.contains(h)) {
                t.height = None;
                t.block_hash = None;
                t.time = None;
            }
        }
    }
}

// ---------------------------------------------------------------- status

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CbfStatus {
    /// `idle` | `connecting` | `headers` | `filters` | `synced` | `error`
    pub state: String,
    pub tip_height: Option<u32>,
    pub scanned_height: Option<u32>,
    pub birth_height: u32,
    /// 0..1 over the filter range being scanned.
    pub progress: f32,
    /// Connected peers (onion name or IP:port).
    pub peers: Vec<String>,
    pub tor: bool,
    pub last_sync_unix: Option<u64>,
    pub watched_scripts: usize,
    pub matched_blocks: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

static STATUS: Mutex<Option<CbfStatus>> = Mutex::new(None);
static RUNNING: Mutex<bool> = Mutex::new(false);

pub fn status() -> CbfStatus {
    crate::net::lock(&STATUS)
        .clone()
        .unwrap_or_else(|| CbfStatus {
            state: "idle".into(),
            ..Default::default()
        })
}

fn set_status(s: &CbfStatus, emit: &(dyn Fn(&CbfStatus) + Send + Sync)) {
    *crate::net::lock(&STATUS) = Some(s.clone());
    emit(s);
}

pub fn is_running() -> bool {
    *crate::net::lock(&RUNNING)
}

struct RunGuard;
impl RunGuard {
    fn take() -> Option<RunGuard> {
        let mut r = crate::net::lock(&RUNNING);
        if *r {
            None
        } else {
            *r = true;
            Some(RunGuard)
        }
    }
}
impl Drop for RunGuard {
    fn drop(&mut self) {
        *crate::net::lock(&RUNNING) = false;
    }
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

// ---------------------------------------------------------------- node

pub struct Params {
    pub network: Network,
    pub tor: bool,
    pub peers: Vec<Peer>,
    pub birth_height: u32,
    pub data_dir: PathBuf,
}

/// A running bip157 node plus (Tor mode) the SOCKS bridge that is its only way out.
struct Running {
    client: bip157::Client,
    node: tauri::async_runtime::JoinHandle<Result<(), bip157::NodeError>>,
    _bridge: Option<socks::SocksBridge>,
}

async fn start_node(
    tor_mgr: &Arc<TorManager>,
    p: &Params,
    store: &Store,
    headers_only: bool,
) -> AppResult<Running> {
    let plan = plan(&p.peers, p.tor)?;
    let peers = match &plan {
        Plan::Tor(v) | Plan::Clear(v) => v.clone(),
    };
    // bip157 pops its whitelist from the end: reverse so the preferred peers come first.
    let mut builder = Builder::new(btc_network(p.network))
        .whitelist_only()
        .add_peers(peers.iter().rev().map(trusted))
        .required_peers(1)
        .chain_state(store.chain_state(p.network))
        .handshake_timeout(Duration::from_secs(45))
        .response_timeout(Duration::from_secs(60));
    if headers_only {
        builder = builder.headers_only_sync();
    }
    let bridge = match plan {
        Plan::Tor(_) => {
            let allowed: socks::Allowed = peers.iter().map(|q| (q.host_string(), q.port)).collect();
            let b =
                socks::SocksBridge::start(Arc::new(socks::TorUpstream(tor_mgr.clone())), allowed)
                    .await?;
            builder = builder.socks5_proxy(b.addr);
            Some(b)
        }
        Plan::Clear(_) => None,
    };
    let (node, client) = builder.build();
    let node = tauri::async_runtime::spawn(node.run());
    Ok(Running {
        client,
        node,
        _bridge: bridge,
    })
}

async fn stop_node(r: Running) {
    let _ = r.client.requester.shutdown();
    let _ = tokio::time::timeout(Duration::from_secs(10), r.node).await;
}

fn peer_label(a: &AddrV2) -> String {
    match a {
        AddrV2::Ipv4(ip) => ip.to_string(),
        AddrV2::Ipv6(ip) => ip.to_string(),
        AddrV2::TorV3(_) => "onion".into(),
        _ => "?".into(),
    }
}

/// Header sync, then a filter scan from the first unscanned height; matching blocks are
/// fetched and their relevant transactions stored. Persists progress; never blocks reads.
pub async fn sync(
    tor_mgr: Arc<TorManager>,
    p: Params,
    mut watch: WatchSet,
    emit: Arc<dyn Fn(&CbfStatus) + Send + Sync>,
) -> AppResult<()> {
    let Some(_guard) = RunGuard::take() else {
        return Ok(()); // already syncing
    };
    let path = store_path(&p.data_dir, p.network);
    let mut store = Store::load(&path);
    if store.birth_height != p.birth_height {
        // Birthday changed: rescan everything from the new birthday.
        store.birth_height = p.birth_height;
        store.scanned_to = None;
    }
    let mut st = CbfStatus {
        state: "connecting".into(),
        tip_height: store.tip_height,
        scanned_height: store.scanned_to,
        birth_height: p.birth_height,
        tor: p.tor,
        last_sync_unix: store.last_sync_unix,
        watched_scripts: watch.len(),
        ..Default::default()
    };
    set_status(&st, emit.as_ref());
    let result = run_sync(&tor_mgr, &p, &mut watch, &mut store, &mut st, emit.as_ref()).await;
    match &result {
        Ok(()) => {
            store.last_sync_unix = Some(now_unix());
            st.state = "synced".into();
            st.last_sync_unix = store.last_sync_unix;
            st.message = None;
        }
        Err(e) => {
            st.state = "error".into();
            st.message = Some(e.to_string());
        }
    }
    store.save(&path)?;
    st.peers.clear();
    set_status(&st, emit.as_ref());
    result
}

async fn run_sync(
    tor_mgr: &Arc<TorManager>,
    p: &Params,
    watch: &mut WatchSet,
    store: &mut Store,
    st: &mut CbfStatus,
    emit: &(dyn Fn(&CbfStatus) + Send + Sync),
) -> AppResult<()> {
    let mut running = start_node(tor_mgr, p, store, true).await?;
    let r = drive(&mut running, p, watch, store, st, emit).await;
    if r.is_ok() {
        finish(&running, store).await;
    }
    stop_node(running).await;
    r
}

#[derive(PartialEq, Eq)]
enum Phase {
    Headers,
    Filters,
}

async fn drive(
    running: &mut Running,
    p: &Params,
    watch: &mut WatchSet,
    store: &mut Store,
    st: &mut CbfStatus,
    emit: &(dyn Fn(&CbfStatus) + Send + Sync),
) -> AppResult<()> {
    let mut known = store.known_outpoints(watch);
    let mut scan_from = store.scanned_to.map_or(p.birth_height, |h| h + 1);
    let mut phase = Phase::Headers;
    let mut rescans = 0usize;
    let mut last_emit = std::time::Instant::now();
    st.state = "headers".into();
    set_status(st, emit);
    loop {
        let client = &mut running.client;
        let step = tokio::time::timeout(STALL, async {
            tokio::select! {
                ev = client.event_rx.recv() => Some(Ok(ev)),
                info = client.info_rx.recv() => Some(Err(Ok(info))),
                warn = client.warn_rx.recv() => Some(Err(Err(warn))),
            }
        })
        .await
        .map_err(|_| {
            AppError::ServerUnreachable(
                "filtres compacts : aucune progression (pairs injoignables ?)".into(),
            )
        })?;
        match step {
            Some(Ok(Some(ev))) => match ev {
                Event::FiltersSynced(update) => {
                    let tip = update.tip().height;
                    store.tip_height = Some(tip);
                    st.tip_height = Some(tip);
                    match phase {
                        Phase::Headers if scan_from > tip => return Ok(()),
                        Phase::Headers => {
                            phase = Phase::Filters;
                            st.state = "filters".into();
                            running
                                .client
                                .requester
                                .rescan_from(scan_from.saturating_sub(1))
                                .map_err(|e| AppError::Internal(format!("cbf : {e}")))?;
                        }
                        Phase::Filters => {
                            if watch.take_extended() && rescans < MAX_RESCANS {
                                // New gap-limit scripts: they must be checked against the
                                // filters already scanned.
                                rescans += 1;
                                scan_from = p.birth_height;
                                store.scanned_to = None;
                                running
                                    .client
                                    .requester
                                    .rescan_from(scan_from.saturating_sub(1))
                                    .map_err(|e| AppError::Internal(format!("cbf : {e}")))?;
                            } else {
                                return Ok(());
                            }
                        }
                    }
                }
                Event::IndexedFilter(f) => {
                    if phase != Phase::Filters || f.height() < scan_from {
                        continue;
                    }
                    let height = f.height();
                    if f.contains_any(watch.scripts()) {
                        let block = running
                            .client
                            .requester
                            .get_block(f.block_hash())
                            .await
                            .map_err(|e| {
                                AppError::ServerUnreachable(format!("cbf : bloc {height} : {e}"))
                            })?;
                        st.matched_blocks += 1;
                        let hash = block.block.block_hash().to_string();
                        let time = block.block.header.time;
                        for tx in relevant_txs(&block.block.txdata, watch, &mut known)? {
                            store.txs.insert(
                                tx.compute_txid().to_string(),
                                StoredTx {
                                    hex: serialize_hex(&tx),
                                    height: Some(height),
                                    block_hash: Some(hash.clone()),
                                    time: Some(time),
                                },
                            );
                        }
                        st.watched_scripts = watch.len();
                    }
                    store.scanned_to = Some(store.scanned_to.map_or(height, |s| s.max(height)));
                    st.scanned_height = store.scanned_to;
                    if let Some(tip) = st.tip_height {
                        let span = tip.saturating_sub(scan_from).max(1) as f32;
                        st.progress =
                            (height.saturating_sub(scan_from) as f32 / span).clamp(0.0, 1.0);
                    }
                }
                Event::ChainUpdate(BlockHeaderChanges::Reorganized { reorganized, .. }) => {
                    let hashes: HashSet<String> = reorganized
                        .iter()
                        .map(|h| h.header.block_hash().to_string())
                        .collect();
                    if let Some(low) = reorganized.iter().map(|h| h.height).min() {
                        store.drop_blocks(&hashes);
                        store.scanned_to = store.scanned_to.map(|s| s.min(low.saturating_sub(1)));
                    }
                }
                Event::ChainUpdate(_) => {}
            },
            Some(Err(Ok(Some(info)))) => match info {
                Info::NewChainHeight(h) => st.tip_height = Some(h),
                Info::SuccessfulHandshake | Info::ConnectionsMet => {
                    st.message = None;
                    if let Ok(peers) = running.client.requester.peer_info().await {
                        st.peers = peers.iter().map(|(a, _)| peer_label(a)).collect();
                    }
                }
                _ => {}
            },
            Some(Err(Err(Some(w)))) => {
                st.message = Some(match w {
                    Warning::NeedConnections {
                        connected,
                        required,
                    } => {
                        format!("connexion aux pairs ({connected}/{required})")
                    }
                    other => other.to_string(),
                });
            }
            // A channel closed: the node stopped (e.g. no reachable peer).
            _ => {
                return Err(AppError::ServerUnreachable(
                    "filtres compacts : aucun pair joignable".into(),
                ))
            }
        }
        if last_emit.elapsed() > Duration::from_millis(500) {
            set_status(st, emit);
            last_emit = std::time::Instant::now();
        }
    }
}

/// After a successful scan: recent headers for a fast restart, and fee rates.
async fn finish(running: &Running, store: &mut Store) {
    let r = &running.client.requester;
    let Ok(tip) = r.chain_tip().await else { return };
    let mut headers = Vec::new();
    for h in tip.height.saturating_sub(HEADER_SNAPSHOT)..=tip.height {
        if let Ok(Some(ih)) = r.get_header(h).await {
            headers.push((h, serialize_hex(&ih.header)));
        }
    }
    if !headers.is_empty() {
        store.headers = headers;
    }
    let mut rates = Vec::new();
    for h in (tip.height.saturating_sub(FEE_BLOCKS - 1)..=tip.height).rev() {
        if let Ok(Some(ih)) = r.get_header(h).await {
            if let Ok(rate) = r.average_fee_rate(ih.header.block_hash()).await {
                rates.push(rate.to_sat_per_vb_ceil());
            }
        }
    }
    if !rates.is_empty() {
        store.block_fee_rates = rates;
    }
    if let Ok(min) = r.broadcast_min_feerate().await {
        store.min_relay_sat_vb = Some(min.to_sat_per_vb_ceil().max(1));
    }
}

/// Broadcasts over P2P (same transport rules), then records the transaction as pending.
pub async fn broadcast(tor_mgr: Arc<TorManager>, p: Params, hex_tx: &str) -> AppResult<String> {
    let tx: Transaction = deserialize_hex(hex_tx.trim())
        .map_err(|_| AppError::InvalidInput("transaction Bitcoin invalide".into()))?;
    let path = store_path(&p.data_dir, p.network);
    let mut store = Store::load(&path);
    let running = start_node(&tor_mgr, &p, &store, true).await?;
    let mut client = running;
    let sent = tokio::time::timeout(BROADCAST_WAIT, async {
        loop {
            match client.client.info_rx.recv().await {
                Some(Info::ConnectionsMet | Info::SuccessfulHandshake) => break,
                Some(_) => {}
                None => return Err(AppError::ServerUnreachable("aucun pair joignable".into())),
            }
        }
        client
            .client
            .requester
            .submit_package(tx.clone())
            .await
            .map_err(|e| AppError::ServerUnreachable(format!("diffusion P2P : {e}")))
    })
    .await
    .map_err(|_| AppError::ServerUnreachable("diffusion P2P : délai dépassé".into()))?;
    stop_node(client).await;
    sent?;
    let txid = tx.compute_txid().to_string();
    store.txs.entry(txid.clone()).or_insert(StoredTx {
        hex: serialize_hex(&tx),
        height: None,
        block_hash: None,
        time: None,
    });
    store.save(&path)?;
    Ok(txid)
}

// ---------------------------------------------------------------- reads (Esplora shapes)

pub fn ledger(data_dir: &Path, net: Network) -> AppResult<(Store, Ledger)> {
    let store = Store::load(&store_path(data_dir, net));
    let ledger = Ledger::new(&store.txs, net)?;
    Ok((store, ledger))
}

pub fn address_info(data_dir: &Path, net: Network, address: &str) -> AppResult<Value> {
    ledger(data_dir, net)?.1.address_info(address, net)
}

pub fn address_utxos(data_dir: &Path, net: Network, address: &str) -> AppResult<Value> {
    ledger(data_dir, net)?.1.utxos(address, net)
}

pub fn address_txs(data_dir: &Path, net: Network, address: &str) -> AppResult<Value> {
    ledger(data_dir, net)?.1.address_txs(address, net, 50)
}

pub fn tip_height(data_dir: &Path, net: Network) -> AppResult<u64> {
    Store::load(&store_path(data_dir, net))
        .tip_height
        .map(u64::from)
        .ok_or_else(|| {
            AppError::ServerUnreachable("filtres compacts : pas encore synchronisé".into())
        })
}

/// No mempool with compact filters: rates are the average fee paid (fees / weight) in the
/// last blocks, with the peers' minimum relay rate as the floor. The UI keeps a manual fee.
pub fn fee_rates(data_dir: &Path, net: Network) -> AppResult<Value> {
    let s = Store::load(&store_path(data_dir, net));
    if s.block_fee_rates.is_empty() {
        return Err(AppError::ServerUnreachable(
            "filtres compacts : pas encore d'estimation (synchronise d'abord)".into(),
        ));
    }
    let max = s.block_fee_rates.iter().copied().max().unwrap_or(1);
    let min = s.block_fee_rates.iter().copied().min().unwrap_or(1);
    let mut sorted = s.block_fee_rates.clone();
    sorted.sort_unstable();
    let median = sorted[sorted.len() / 2];
    let floor = s.min_relay_sat_vb.unwrap_or(1).max(1);
    Ok(serde_json::json!({
        "fastestFee": max.max(floor), "halfHourFee": median.max(floor), "hourFee": min.max(floor),
        "economyFee": floor, "minimumFee": floor,
        "source": "block-average",
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_peer_lists_parse() {
        for net in [Network::Testnet, Network::Mainnet] {
            let peers = peer_list(net, &[]).unwrap();
            assert!(peers.len() >= 10);
            assert!(peers
                .iter()
                .any(|p| matches!(p.host, PeerHost::Onion { .. })));
        }
        // User peers first, duplicates removed, hostnames refused.
        let user = vec![
            "203.132.94.196:48333".to_string(),
            "1.2.3.4:48333".to_string(),
        ];
        let peers = peer_list(Network::Testnet, &user).unwrap();
        assert_eq!(peers[0].to_string(), "203.132.94.196:48333");
        assert_eq!(peers[1].to_string(), "1.2.3.4:48333");
        assert_eq!(peers.len(), TESTNET4_PEERS.len() + 1);
        assert!(peer_list(Network::Testnet, &["seed.testnet4.wiz.biz:48333".into()]).is_err());
    }

    #[test]
    fn tor_plan_is_onion_first_and_never_clear() {
        let peers = peer_list(Network::Testnet, &[]).unwrap();
        let Plan::Tor(order) = plan(&peers, true).unwrap() else {
            panic!("Tor on must use the bridge")
        };
        assert_eq!(order.len(), peers.len());
        let first_ip = order
            .iter()
            .position(|p| matches!(p.host, PeerHost::Ip(_)))
            .unwrap();
        assert!(order[..first_ip]
            .iter()
            .all(|p| matches!(p.host, PeerHost::Onion { .. })));
        assert!(order[first_ip..]
            .iter()
            .all(|p| matches!(p.host, PeerHost::Ip(_))));
        // Clear mode: IP peers only, onion skipped.
        let Plan::Clear(ip) = plan(&peers, false).unwrap() else {
            panic!()
        };
        assert!(ip.iter().all(|p| matches!(p.host, PeerHost::Ip(_))));
        // Onion-only list without Tor: nothing usable, typed error.
        let onion_only: Vec<Peer> = peers
            .into_iter()
            .filter(|p| matches!(p.host, PeerHost::Onion { .. }))
            .collect();
        assert!(matches!(
            plan(&onion_only, false),
            Err(AppError::ServerInvalid(_))
        ));
    }

    #[test]
    fn trusted_peer_conversion_keeps_onion_key() {
        let p = parse_peer(TESTNET4_PEERS[0]).unwrap();
        let PeerHost::Onion { key, .. } = &p.host else {
            panic!()
        };
        let t = trusted(&p);
        assert_eq!(t.port(), Some(48333));
        assert!(format!("{t:?}").contains(&format!("{:?}", AddrV2::TorV3(*key))));
    }

    #[test]
    fn fee_rates_from_block_averages() {
        let dir = std::env::temp_dir().join(format!("kyro-cbf-fees-{}", std::process::id()));
        let store = Store {
            block_fee_rates: vec![3, 9, 1],
            min_relay_sat_vb: Some(1),
            ..Default::default()
        };
        store.save(&store_path(&dir, Network::Testnet)).unwrap();
        let f = fee_rates(&dir, Network::Testnet).unwrap();
        assert_eq!(f["fastestFee"], 9);
        assert_eq!(f["halfHourFee"], 3);
        assert_eq!(f["hourFee"], 1);
        assert_eq!(f["source"], "block-average");
        assert!(fee_rates(&dir, Network::Mainnet).is_err());
    }

    /// Real sync over Tor on testnet4. Run with
    /// `cargo test -p kyro-desktop --features cbf -- --ignored --nocapture cbf_live`.
    /// Watches the two B2b addresses from a birthday just before their first transaction
    /// (`KYRO_CBF_BIRTH`, default 0) and compares with mempool's onion Esplora.
    #[test]
    #[ignore]
    fn cbf_live_testnet4_over_tor() {
        use crate::net::NetClient;
        use crate::tor::TorState;
        let addrs = [
            "tb1q6rz28mcfaxtmd6v789l9rrlrusdprr9pqcpvkl",
            "tb1qhrw7celkgk34q3p9jx0eqts2de746f24fxj0x9",
        ];
        let birth: u32 = std::env::var("KYRO_CBF_BIRTH")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join("kyro-cbf-live");
        let net = NetClient::new(dir.join("tor")).unwrap();
        tauri::async_runtime::block_on(async {
            let t0 = std::time::Instant::now();
            net.tor.restart();
            while net.tor.status().state != TorState::Ready {
                assert_ne!(net.tor.status().state, TorState::Error);
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
            eprintln!("tor ready {:.1?}", t0.elapsed());
            let watch = WatchSet::from_addresses(Network::Testnet, &addrs).unwrap();
            let params = Params {
                network: Network::Testnet,
                tor: true,
                peers: peer_list(Network::Testnet, &[]).unwrap(),
                birth_height: birth,
                data_dir: dir.clone(),
            };
            let t = std::time::Instant::now();
            let last = Arc::new(Mutex::new(std::time::Instant::now()));
            let emit: Arc<dyn Fn(&CbfStatus) + Send + Sync> = Arc::new(move |s: &CbfStatus| {
                let mut l = crate::net::lock(&last);
                if l.elapsed() > Duration::from_secs(15)
                    || s.state == "synced"
                    || s.state == "error"
                {
                    *l = std::time::Instant::now();
                    eprintln!(
                        "[{:>6.0?}] {} tip={:?} scanned={:?} {:.1}% peers={:?} matched={} {:?}",
                        t.elapsed(),
                        s.state,
                        s.tip_height,
                        s.scanned_height,
                        s.progress * 100.0,
                        s.peers,
                        s.matched_blocks,
                        s.message
                    );
                }
            });
            sync(net.tor.clone(), params, watch, emit).await.unwrap();
            eprintln!("cbf sync done in {:.1?}", t.elapsed());

            let d = crate::btc_backend::Ctx {
                net_client: &net,
                network: Network::Testnet,
                tor: true,
                server: crate::servers::BtcServer::Default,
                fingerprint: None,
            };
            for a in addrs {
                let ours = address_info(&dir, Network::Testnet, a).unwrap();
                let theirs = crate::btc_backend::address_info(&d, a).await.unwrap();
                let bal = |v: &Value| {
                    ["chain_stats", "mempool_stats"]
                        .iter()
                        .map(|k| {
                            v[k]["funded_txo_sum"].as_i64().unwrap()
                                - v[k]["spent_txo_sum"].as_i64().unwrap()
                        })
                        .sum::<i64>()
                };
                let conf = |v: &Value| v["chain_stats"]["tx_count"].as_u64().unwrap();
                eprintln!(
                    "{a}: cbf balance={} txs={} | mempool balance={} confirmed txs={}",
                    bal(&ours),
                    conf(&ours),
                    bal(&theirs),
                    conf(&theirs)
                );
                assert_eq!(
                    bal(&ours),
                    theirs["chain_stats"]["funded_txo_sum"].as_i64().unwrap()
                        - theirs["chain_stats"]["spent_txo_sum"].as_i64().unwrap()
                );
                assert_eq!(conf(&ours), conf(&theirs));
                let u_ours = address_utxos(&dir, Network::Testnet, a).unwrap();
                let u_theirs = crate::btc_backend::address_utxos(&d, a).await.unwrap();
                let set = |v: &Value| {
                    let mut s: Vec<(String, u64)> = v
                        .as_array()
                        .unwrap()
                        .iter()
                        .filter(|u| u["status"]["confirmed"] == true)
                        .map(|u| {
                            (
                                u["txid"].as_str().unwrap().to_owned(),
                                u["vout"].as_u64().unwrap(),
                            )
                        })
                        .collect();
                    s.sort();
                    s
                };
                assert_eq!(set(&u_ours), set(&u_theirs));
            }
            eprintln!("fees {}", fee_rates(&dir, Network::Testnet).unwrap());
        });
    }
}
