//! Polkadot history from Statescan's keyless REST API (`ahp-api.statescan.io` for Polkadot Asset
//! Hub, where DOT lives since the November 2025 migration; `polkadot-api.statescan.io` for the
//! relay chain, where older transfers stay), on the `polkadot` Tor family, never with a fallback.

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use serde_json::Value;
use wallet_core::Network;

use crate::dot_backend::DotCtx;
use crate::net::{Family, ServerRequest};

pub const ASSET_HUB_API: &str = "https://ahp-api.statescan.io";
pub const RELAY_API: &str = "https://polkadot-api.statescan.io";
/// Hosts of [`ASSET_HUB_API`] and [`RELAY_API`] (allowlist, `polkadot` family).
pub const STATESCAN_HOSTS: &[&str] = &["ahp-api.statescan.io", "polkadot-api.statescan.io"];

const PAGE_SIZE: usize = 50;
const MAX_HASH_FETCHES: usize = 12;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DotHistoryChain {
    AssetHub,
    Relay,
}

impl DotHistoryChain {
    fn base(self) -> &'static str {
        match self {
            DotHistoryChain::AssetHub => ASSET_HUB_API,
            DotHistoryChain::Relay => RELAY_API,
        }
    }

    fn tag(self) -> &'static str {
        match self {
            DotHistoryChain::AssetHub => "ahp",
            DotHistoryChain::Relay => "relay",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DotHistoryEntry {
    /// Unique in the list: the extrinsic hash (0x…) when known, else `{chain}:{block}-{index}`.
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hash: Option<String>,
    pub chain: DotHistoryChain,
    pub block_height: u64,
    /// None: not made by an extrinsic (`isSigned: false`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extrinsic_index: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event_index: Option<u32>,
    /// ms epoch.
    pub time: u64,
    pub from: String,
    pub to: String,
    /// Planck (DOT: 10 decimals), decimal string.
    pub amount: String,
    /// `in`, `out` or `self`.
    pub direction: &'static str,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DotHistory {
    /// False: no history to show (testnet, Statescan unreachable or unreadable).
    pub available: bool,
    /// One of the two chains could not be read: the list may miss transfers.
    pub partial: bool,
    pub items: Vec<DotHistoryEntry>,
}

fn account_id_of(v: &Value) -> Option<[u8; 32]> {
    let s = v.as_str()?.trim();
    if let Some(h) = s.strip_prefix("0x") {
        return hex::decode(h).ok()?.try_into().ok();
    }
    wallet_core::dot_ss58_decode(s).ok().map(|(_, id)| id)
}

fn u64_of(v: &Value) -> Option<u64> {
    v.as_u64().or_else(|| v.as_str()?.trim().parse().ok())
}

fn u32_of(v: &Value) -> Option<u32> {
    u64_of(v).and_then(|n| u32::try_from(n).ok())
}

fn planck_of(v: &Value) -> Option<u128> {
    match v {
        Value::String(s) => {
            let s = s.trim();
            if let Some(h) = s.strip_prefix("0x") {
                let h = h.trim_start_matches('0');
                return if h.is_empty() {
                    Some(0)
                } else if h.len() <= 32 {
                    u128::from_str_radix(h, 16).ok()
                } else {
                    None
                };
            }
            (!s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
                .then(|| s.parse().ok())
                .flatten()
        }
        Value::Number(n) => n.as_u64().map(u128::from),
        _ => None,
    }
}

/// `GET /accounts/{ss58}/transfers` → our native DOT transfers. `None`: not the expected shape.
pub fn parse_transfers(
    bytes: &[u8],
    chain: DotHistoryChain,
    me: &[u8; 32],
) -> Option<Vec<DotHistoryEntry>> {
    let v: Value = serde_json::from_slice(bytes).ok()?;
    let items = v.get("items")?.as_array()?;
    let mut out = Vec::new();
    for t in items {
        let native = t.get("isNativeAsset").and_then(Value::as_bool);
        let is_dot = match chain {
            DotHistoryChain::AssetHub => native == Some(true),
            DotHistoryChain::Relay => native != Some(false),
        };
        if !is_dot {
            continue;
        }
        let ix = &t["indexer"];
        let (Some(block_height), Some(time)) =
            (u64_of(&ix["blockHeight"]), u64_of(&ix["blockTime"]))
        else {
            continue;
        };
        let extrinsic_index = u32_of(&ix["extrinsicIndex"]);
        let event_index = u32_of(&ix["eventIndex"]);
        if extrinsic_index.is_none() && event_index.is_none() {
            continue;
        }
        let (Some(from), Some(to)) = (account_id_of(&t["from"]), account_id_of(&t["to"])) else {
            continue;
        };
        let Some(amount) = planck_of(&t["balance"]) else {
            continue;
        };
        let direction = match (from == *me, to == *me) {
            (true, true) => "self",
            (true, false) => "out",
            (false, true) => "in",
            (false, false) => continue,
        };
        let id = match (extrinsic_index, event_index) {
            (Some(x), _) => format!("{}:{block_height}-{x}", chain.tag()),
            (None, e) => format!("{}:{block_height}-e{}", chain.tag(), e.unwrap_or(0)),
        };
        out.push(DotHistoryEntry {
            id,
            hash: None,
            chain,
            block_height,
            extrinsic_index,
            event_index,
            time,
            from: wallet_core::dot_ss58_encode(&from, 0),
            to: wallet_core::dot_ss58_encode(&to, 0),
            amount: amount.to_string(),
            direction,
        });
    }
    Some(out)
}

/// `GET /extrinsics/{height}-{index}` → its hash (0x + 64 hex, lower case), if well-formed.
pub fn parse_extrinsic_hash(bytes: &[u8]) -> Option<String> {
    let v: Value = serde_json::from_slice(bytes).ok()?;
    let h = v.get("hash")?.as_str()?.trim();
    let hex = h.strip_prefix("0x")?;
    (hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit())).then(|| h.to_ascii_lowercase())
}

/// Merges the chains' lists, newest first, each transfer event once.
pub fn merge(lists: Vec<Vec<DotHistoryEntry>>) -> Vec<DotHistoryEntry> {
    let mut all: Vec<DotHistoryEntry> = lists.into_iter().flatten().collect();
    all.sort_by(|a, b| {
        b.time
            .cmp(&a.time)
            .then(b.block_height.cmp(&a.block_height))
            .then(b.event_index.cmp(&a.event_index))
    });
    let mut seen = HashSet::new();
    all.retain(|e| {
        seen.insert((
            e.chain,
            e.block_height,
            e.event_index,
            e.extrinsic_index,
            e.direction,
        ))
    });
    all
}

/// Sets the known hashes; an extrinsic moving DOT twice to or from us keeps distinct ids.
pub fn apply_hashes(
    items: &mut [DotHistoryEntry],
    hash_of: impl Fn(&DotHistoryEntry) -> Option<String>,
) {
    let mut used = HashSet::new();
    for e in items.iter_mut() {
        if let Some(h) = hash_of(e) {
            e.id = if used.insert(h.clone()) {
                h.clone()
            } else {
                format!("{h}:{}", e.event_index.unwrap_or(0))
            };
            e.hash = Some(h);
        }
    }
}

type HashKey = (DotHistoryChain, u64, u32);

fn hash_cache() -> &'static Mutex<HashMap<HashKey, String>> {
    static CACHE: OnceLock<Mutex<HashMap<HashKey, String>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cached_hash(k: &HashKey) -> Option<String> {
    hash_cache().lock().ok()?.get(k).cloned()
}

async fn get(ctx: &DotCtx<'_>, url: &str) -> Option<Vec<u8>> {
    let u = url::Url::parse(url).ok()?;
    let (status, bytes) = ctx
        .net_client
        .server_request(ServerRequest::get(u, Family::Polkadot), ctx.tor)
        .await
        .ok()?;
    (status == 200).then_some(bytes)
}

async fn chain_transfers(
    ctx: &DotCtx<'_>,
    chain: DotHistoryChain,
    address: &str,
    me: &[u8; 32],
) -> Option<Vec<DotHistoryEntry>> {
    let url = format!(
        "{}/accounts/{address}/transfers?page=0&page_size={PAGE_SIZE}",
        chain.base()
    );
    parse_transfers(&get(ctx, &url).await?, chain, me)
}

/// History of our Polkadot `address` (mainnet). Never fails: see [`DotHistory::available`].
pub async fn txs(ctx: &DotCtx<'_>, address: &str) -> DotHistory {
    if ctx.network != Network::Mainnet {
        return DotHistory::default();
    }
    let Ok(me) = wallet_core::dot_account_id(address, ctx.network) else {
        return DotHistory::default();
    };
    let address = wallet_core::dot_ss58_encode(&me, 0);
    let (hub, relay) = futures_util::future::join(
        chain_transfers(ctx, DotHistoryChain::AssetHub, &address, &me),
        chain_transfers(ctx, DotHistoryChain::Relay, &address, &me),
    )
    .await;
    if hub.is_none() && relay.is_none() {
        return DotHistory::default();
    }
    let partial = hub.is_none() || relay.is_none();
    let mut items = merge(vec![hub.unwrap_or_default(), relay.unwrap_or_default()]);
    let mut fetched = 0;
    for e in &items {
        let Some(x) = e.extrinsic_index else { continue };
        let key = (e.chain, e.block_height, x);
        if fetched >= MAX_HASH_FETCHES || cached_hash(&key).is_some() {
            continue;
        }
        fetched += 1;
        let url = format!("{}/extrinsics/{}-{x}", e.chain.base(), e.block_height);
        if let Some(h) = get(ctx, &url)
            .await
            .as_deref()
            .and_then(parse_extrinsic_hash)
        {
            if let Ok(mut c) = hash_cache().lock() {
                c.insert(key, h);
            }
        }
    }
    apply_hashes(&mut items, |e| {
        cached_hash(&(e.chain, e.block_height, e.extrinsic_index?))
    });
    DotHistory {
        available: true,
        partial,
        items,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HUB: &[u8] = include_bytes!("testdata/statescan_ahp_transfers.json");
    const HUB_SYSTEM: &[u8] = include_bytes!("testdata/statescan_ahp_transfers_system.json");
    const RELAY: &[u8] = include_bytes!("testdata/statescan_relay_transfers.json");
    const EXTRINSIC: &[u8] = include_bytes!("testdata/statescan_extrinsic.json");

    fn id(a: &str) -> [u8; 32] {
        wallet_core::dot_account_id(a, Network::Mainnet).unwrap()
    }

    #[test]
    fn parses_native_transfers_of_our_account() {
        let me = "14ta64vXXABuqvcF4vozdi2R1tTx9t4pPGnaqiQrJR3YV4uN";
        let hub = parse_transfers(HUB, DotHistoryChain::AssetHub, &id(me)).unwrap();
        assert_eq!(hub.len(), 6);
        let first = &hub[0];
        assert_eq!(first.direction, "out");
        assert_eq!(first.from, me);
        assert_eq!(first.to, "13tn5s3s4KZNLN19WweQYoCF4NzSQmzTcCNf7tHeGdWGnfYb");
        assert_eq!(first.amount, "2306758000000");
        assert_eq!(
            (
                first.block_height,
                first.extrinsic_index,
                first.event_index,
                first.time
            ),
            (22_575_150, Some(2), Some(3), 1_793_544_720_000)
        );
        assert_eq!(first.id, "ahp:22575150-2");
        assert_eq!(hub[3].direction, "in");
        assert_eq!(
            hub[3].from,
            "1JVrK16XZm9vyZjHoYVPjtZ35LvTQ4oyufMoUFTFpAUhath"
        );
        let other = id("1EVdqVDMGnDLTVPXruvGNNzd7r5aBezXhQquAg8sbJGjdTs");
        assert_eq!(
            parse_transfers(HUB, DotHistoryChain::AssetHub, &other),
            Some(vec![])
        );
    }

    #[test]
    fn relay_and_asset_hub_merge_newest_first() {
        let me = id("1EVdqVDMGnDLTVPXruvGNNzd7r5aBezXhQquAg8sbJGjdTs");
        let relay = parse_transfers(RELAY, DotHistoryChain::Relay, &me).unwrap();
        assert_eq!(relay.len(), 4);
        assert!(relay.iter().all(|e| e.direction == "out"));
        assert_eq!(relay[0].amount, "20260000000000");
        let extra = DotHistoryEntry {
            time: 1_793_100_000_000,
            chain: DotHistoryChain::AssetHub,
            id: "ahp:1-2".into(),
            ..relay[0].clone()
        };
        let all = merge(vec![vec![extra], relay.clone(), relay]);
        assert_eq!(all.len(), 5, "same event once");
        assert!(all.windows(2).all(|w| w[0].time >= w[1].time));
        assert_eq!(all[0].chain, DotHistoryChain::AssetHub);
    }

    #[test]
    fn transfers_without_extrinsic_and_hex_balances() {
        let me = id("13UVJyLnbVp9RBZYFwFGyDvVd1y27Tt8tkntv6Q7JVPhFsTB");
        let list = parse_transfers(HUB_SYSTEM, DotHistoryChain::AssetHub, &me).unwrap();
        assert_eq!(list.len(), 3);
        assert_eq!(list[0].direction, "out");
        assert_eq!(list[0].extrinsic_index, None);
        assert_eq!(list[0].id, "ahp:21572110-e38");
        assert_eq!(
            list[0].amount,
            u128::from_str_radix("655df9706967b8", 16)
                .unwrap()
                .to_string()
        );
        assert_eq!(list[1].direction, "in");
        assert_eq!(list[1].amount, "2699586672240738");
    }

    #[test]
    fn unexpected_shapes_are_unavailable_not_errors() {
        let me = id("14ta64vXXABuqvcF4vozdi2R1tTx9t4pPGnaqiQrJR3YV4uN");
        for bad in [
            &b""[..],
            b"null",
            b"{}",
            b"[]",
            b"{\"items\":3}",
            b"<html>502</html>",
        ] {
            assert!(
                parse_transfers(bad, DotHistoryChain::AssetHub, &me).is_none(),
                "{}",
                String::from_utf8_lossy(bad)
            );
        }
        let odd = br#"{"items":[
            {"isNativeAsset":true,"indexer":{"blockHeight":"x"},"from":"?","to":"?","balance":"1"},
            {"isNativeAsset":true,"indexer":{"blockHeight":1,"extrinsicIndex":1,"blockTime":1},"from":"14ta64vXXABuqvcF4vozdi2R1tTx9t4pPGnaqiQrJR3YV4uN","to":"1JVrK16XZm9vyZjHoYVPjtZ35LvTQ4oyufMoUFTFpAUhath","balance":"-5"},
            {"isNativeAsset":false,"assetId":1984,"indexer":{"blockHeight":1,"extrinsicIndex":1,"blockTime":1},"from":"14ta64vXXABuqvcF4vozdi2R1tTx9t4pPGnaqiQrJR3YV4uN","to":"1JVrK16XZm9vyZjHoYVPjtZ35LvTQ4oyufMoUFTFpAUhath","balance":"5"},
            {"indexer":{"blockHeight":1,"extrinsicIndex":1,"blockTime":1},"from":"14ta64vXXABuqvcF4vozdi2R1tTx9t4pPGnaqiQrJR3YV4uN","to":"1JVrK16XZm9vyZjHoYVPjtZ35LvTQ4oyufMoUFTFpAUhath","balance":"0x00000000000000000000000000000000000000000000000000000000000000ff"}
        ]}"#;
        assert_eq!(
            parse_transfers(odd, DotHistoryChain::AssetHub, &me),
            Some(vec![])
        );
        let relay = br#"{"items":[{"indexer":{"blockHeight":7,"extrinsicIndex":1,"eventIndex":4,"blockTime":9},"from":"1JVrK16XZm9vyZjHoYVPjtZ35LvTQ4oyufMoUFTFpAUhath","to":"14ta64vXXABuqvcF4vozdi2R1tTx9t4pPGnaqiQrJR3YV4uN","balance":12}]}"#;
        let r = parse_transfers(relay, DotHistoryChain::Relay, &me).unwrap();
        assert_eq!(
            (r.len(), r[0].direction, r[0].amount.as_str()),
            (1, "in", "12")
        );
    }

    #[test]
    fn extrinsic_hash_and_unique_ids() {
        let h = "0xc7c559de98507ee138dc9b5f40e5baafb6db82090d83632b683326e3a8487b48";
        assert_eq!(parse_extrinsic_hash(EXTRINSIC).as_deref(), Some(h));
        assert_eq!(parse_extrinsic_hash(br#"{"hash":"0x12"}"#), None);
        assert_eq!(parse_extrinsic_hash(b"{}"), None);
        assert_eq!(parse_extrinsic_hash(b"oops"), None);
        let me = id("14ta64vXXABuqvcF4vozdi2R1tTx9t4pPGnaqiQrJR3YV4uN");
        let mut list = parse_transfers(HUB, DotHistoryChain::AssetHub, &me).unwrap();
        list.truncate(2);
        list[1].event_index = Some(9);
        apply_hashes(&mut list, |_| Some(h.to_owned()));
        assert_eq!(list[0].id, h);
        assert_eq!(list[1].id, format!("{h}:9"));
        assert!(list.iter().all(|e| e.hash.as_deref() == Some(h)));
    }

    #[test]
    fn hosts_are_allowlisted_on_the_polkadot_family() {
        for h in STATESCAN_HOSTS {
            assert!(crate::net::ALLOWED_HOSTS.contains(h), "{h}");
            assert_eq!(
                crate::net::family_for(h, &crate::net::NetContext::default()),
                Family::Polkadot
            );
        }
        for base in [ASSET_HUB_API, RELAY_API] {
            let u = url::Url::parse(base).unwrap();
            assert!(STATESCAN_HOSTS.contains(&u.host_str().unwrap()));
        }
    }
}
