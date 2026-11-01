//! User-chosen servers per chain family (`settings.servers`) and their network policy.
//!
//! Rules (see docs/NETWORK.md, docs/IPC.md):
//! - a custom server is allowlisted only for its own family and uses that family's Tor circuits;
//! - URLs: HTTPS, never credentials in the URL; plain `http://` only for a `.onion` host over Tor,
//!   or (Bitcoin Core only) for a loopback / private-LAN address reached directly;
//! - once a custom server is set for a chain, that chain's **default** server is refused
//!   (`DEFAULT_SERVER_DISABLED`) so a failure can never silently leak addresses to it.

use std::collections::BTreeMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use serde::{Deserialize, Serialize};
use wallet_core::{Network, UtxoCoin};

use crate::error::{AppError, AppResult};
use crate::net::{Family, MEMPOOL_ONION};

/// Solana clusters Kyro knows, with their default RPC host.
pub const SOLANA_DEFAULTS: &[(&str, &str)] = &[
    ("devnet", "api.devnet.solana.com"),
    ("mainnet-beta", "api.mainnet-beta.solana.com"),
];

/// EVM chains Kyro knows, with their default RPC host (must match packages/chains registry).
pub const EVM_DEFAULTS: &[(u64, &str)] = &[
    (1, "ethereum-rpc.publicnode.com"),
    (11_155_111, "ethereum-sepolia-rpc.publicnode.com"),
    (42_161, "arbitrum-one-rpc.publicnode.com"),
    (10, "optimism-rpc.publicnode.com"),
    (8_453, "base-rpc.publicnode.com"),
    (137, "polygon-bor-rpc.publicnode.com"),
    (56, "bsc-rpc.publicnode.com"),
    (43_114, "avalanche-c-chain-rpc.publicnode.com"),
];

/// Solana genesis hashes (`getGenesisHash`), checked live on 2026-10-30 against
/// api.devnet.solana.com and api.mainnet-beta.solana.com.
pub const SOLANA_GENESIS: &[(&str, &str)] = &[
    ("devnet", "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"),
    (
        "mainnet-beta",
        "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
    ),
];

/// A plain JSON-RPC endpoint (EVM chain or Solana cluster).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcServer {
    pub url: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ElectrumTls {
    /// Normal certificate validation (Mozilla roots).
    Webpki,
    /// The server certificate's SHA-256 must equal `certSha256` (self-signed servers).
    Pinned,
    /// No TLS: only for a `.onion` host over Tor (the onion protocol authenticates and encrypts).
    None,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CoreAuth {
    /// Bitcoin Core `.cookie` file, read fresh on every request (preferred).
    Cookie { cookie_path: String },
    /// `rpcuser` / `rpcpassword`. The password is stored in plain text in the settings file and
    /// is NEVER returned to the UI (`hasPassword` instead).
    Userpass {
        user: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        password: Option<String>,
        #[serde(default)]
        has_password: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum BtcServer {
    /// mempool.space (its onion service in Tor mode).
    #[default]
    Default,
    /// Any Esplora-compatible REST API, e.g. `https://my-node.example/api`.
    Esplora { url: String },
    /// Electrum protocol server (newline-delimited JSON-RPC over TLS/TCP).
    Electrum {
        host: String,
        port: u16,
        tls: ElectrumTls,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cert_sha256: Option<String>,
    },
    /// The user's own Bitcoin Core node (JSON-RPC), with a watch-only descriptor wallet.
    Core { url: String, auth: CoreAuth },
    /// Compact block filters (BIP157/158) from P2P peers; matching is done locally.
    /// Requires the `cbf` cargo feature (off by default until reviewed).
    Cbf {
        /// Extra peers (`host:port`, host = onion v3 or IP literal; hostnames refused).
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        peers: Vec<String>,
        /// Height to start scanning filters from (wallet birthday). `None` = genesis.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        birth_height: Option<u32>,
    },
}

impl BtcServer {
    pub fn is_default(&self) -> bool {
        matches!(self, BtcServer::Default)
    }

    pub fn kind_name(&self) -> &'static str {
        match self {
            BtcServer::Default => "default",
            BtcServer::Esplora { .. } => "esplora",
            BtcServer::Electrum { .. } => "electrum",
            BtcServer::Core { .. } => "core",
            BtcServer::Cbf { .. } => "cbf",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct BtcServers {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mainnet: Option<BtcServer>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub testnet4: Option<BtcServer>,
}

/// Server of a Litecoin or Dogecoin network: Kyro's default (litecoinspace.org for Litecoin;
/// Komodo's public ElectrumX servers for Dogecoin mainnet, none for Dogecoin testnet — see
/// `utxo_backend`) or the user's Esplora-compatible REST API.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum UtxoServer {
    #[default]
    Default,
    /// e.g. `https://my-node.example/api` (electrs / mempool backend for that chain).
    Esplora { url: String },
}

impl UtxoServer {
    pub fn is_default(&self) -> bool {
        matches!(self, UtxoServer::Default)
    }

    pub fn kind_name(&self) -> &'static str {
        match self {
            UtxoServer::Default => "default",
            UtxoServer::Esplora { .. } => "esplora",
        }
    }
}

/// Key `testnet` = Litecoin testnet4 / Dogecoin testnet (the chain checked by its genesis).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct UtxoServers {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mainnet: Option<UtxoServer>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub testnet: Option<UtxoServer>,
}

impl UtxoServers {
    pub fn for_network(&self, net: Network) -> UtxoServer {
        match net {
            Network::Mainnet => self.mainnet.clone(),
            Network::Testnet => self.testnet.clone(),
        }
        .unwrap_or_default()
    }

    pub fn entries(&self) -> [(&'static str, &Option<UtxoServer>); 2] {
        [("mainnet", &self.mainnet), ("testnet", &self.testnet)]
    }
}

/// Default Esplora base URL of a UTXO chain, or `None` when its default is not Esplora
/// (Dogecoin mainnet: Electrum, see [`utxo_default_electrum`]) or when there is no default
/// (Dogecoin testnet).
pub fn utxo_default_base(coin: UtxoCoin, net: Network) -> Option<&'static str> {
    match (coin, net) {
        (UtxoCoin::Litecoin, Network::Mainnet) => Some("https://litecoinspace.org/api"),
        (UtxoCoin::Litecoin, Network::Testnet) => Some("https://litecoinspace.org/testnet/api"),
        (UtxoCoin::Dogecoin, _) => None,
    }
}

/// Default Electrum servers of a UTXO chain, in the order they are tried (allowlist:
/// `net::ELECTRUM_HOSTS`). Dogecoin mainnet: Komodo's public ElectrumX servers (no free public
/// Dogecoin **testnet** server was found, 2026-10-31: the user configures one).
pub fn utxo_default_electrum(coin: UtxoCoin, net: Network) -> Vec<(&'static str, u16)> {
    match (coin, net) {
        (UtxoCoin::Dogecoin, Network::Mainnet) => crate::net::ELECTRUM_HOSTS
            .iter()
            .filter(|(_, _, f)| *f == Family::Dogecoin)
            .map(|(h, p, _)| (*h, *p))
            .collect(),
        _ => Vec::new(),
    }
}

/// Whether Kyro has a default server for this chain and network.
pub fn utxo_has_default(coin: UtxoCoin, net: Network) -> bool {
    utxo_default_base(coin, net).is_some() || !utxo_default_electrum(coin, net).is_empty()
}

/// Hosts of the default servers of a UTXO chain (refused once replaced).
pub fn utxo_default_hosts(coin: UtxoCoin) -> &'static [&'static str] {
    match coin {
        UtxoCoin::Litecoin => &["litecoinspace.org"],
        UtxoCoin::Dogecoin => &["doge.electrum1.cipig.net", "doge.electrum2.cipig.net"],
    }
}

pub fn utxo_network_key(net: Network) -> &'static str {
    match net {
        Network::Mainnet => "mainnet",
        Network::Testnet => "testnet",
    }
}

pub fn utxo_family(coin: UtxoCoin) -> Family {
    match coin {
        UtxoCoin::Litecoin => Family::Litecoin,
        UtxoCoin::Dogecoin => Family::Dogecoin,
    }
}

/// TRON server: a java-tron HTTP API (`/wallet/*`), the same kind as the default TronGrid.
/// History (`tron_txs`) also needs TronGrid's `/v1` API.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TronServer {
    #[default]
    Default,
    /// e.g. `https://my-node.example` (java-tron FullNode HTTP port).
    Http { url: String },
}

impl TronServer {
    pub fn is_default(&self) -> bool {
        matches!(self, TronServer::Default)
    }

    pub fn kind_name(&self) -> &'static str {
        match self {
            TronServer::Default => "default",
            TronServer::Http { .. } => "http",
        }
    }
}

/// Key `testnet` = Nile.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TronServers {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mainnet: Option<TronServer>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub testnet: Option<TronServer>,
}

impl TronServers {
    pub fn for_network(&self, net: Network) -> TronServer {
        match net {
            Network::Mainnet => self.mainnet.clone(),
            Network::Testnet => self.testnet.clone(),
        }
        .unwrap_or_default()
    }

    pub fn entries(&self) -> [(&'static str, &Option<TronServer>); 2] {
        [("mainnet", &self.mainnet), ("testnet", &self.testnet)]
    }
}

/// TronGrid: mainnet and Nile. Shasta is not used (Nile is TRON's recommended testnet and the
/// one with a test USDT).
pub fn tron_default_base(net: Network) -> &'static str {
    match net {
        Network::Mainnet => "https://api.trongrid.io",
        Network::Testnet => "https://nile.trongrid.io",
    }
}

/// `blockID` of block 0 (`/wallet/getblockbynum {num:0}`), read on 2026-10-30 from
/// api.trongrid.io, nile.trongrid.io and api.shasta.trongrid.io.
pub const TRON_GENESIS: &[(&str, &str)] = &[
    (
        "mainnet",
        "00000000000000001ebf88508a03865c71d452e25f4d51194196a1d22b6653dc",
    ),
    (
        "nile",
        "0000000000000000d698d4192c56cb6be724a558448e2684802de4d6cd8690dc",
    ),
    (
        "shasta",
        "0000000000000000de1aa88295e1fcf982742f773e0419c5a9c134c994a9059e",
    ),
];

/// XRP Ledger server: a rippled JSON-RPC endpoint, the same kind as the defaults.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum XrpServer {
    #[default]
    Default,
    /// e.g. `https://my-rippled.example:51234/`.
    JsonRpc { url: String },
}

impl XrpServer {
    pub fn is_default(&self) -> bool {
        matches!(self, XrpServer::Default)
    }

    pub fn kind_name(&self) -> &'static str {
        match self {
            XrpServer::Default => "default",
            XrpServer::JsonRpc { .. } => "jsonRpc",
        }
    }
}

/// Key `testnet` = XRPL Testnet (network_id 1).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct XrpServers {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mainnet: Option<XrpServer>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub testnet: Option<XrpServer>,
}

impl XrpServers {
    pub fn for_network(&self, net: Network) -> XrpServer {
        match net {
            Network::Mainnet => self.mainnet.clone(),
            Network::Testnet => self.testnet.clone(),
        }
        .unwrap_or_default()
    }

    pub fn entries(&self) -> [(&'static str, &Option<XrpServer>); 2] {
        [("mainnet", &self.mainnet), ("testnet", &self.testnet)]
    }
}

/// rippled JSON-RPC: XRPL Testnet (Ripple's public server) and mainnet (xrplcluster.com).
pub fn xrp_default_url(net: Network) -> &'static str {
    match net {
        Network::Mainnet => "https://xrplcluster.com/",
        Network::Testnet => "https://s.altnet.rippletest.net:51234/",
    }
}

/// `server_info.info.network_id`: 0 mainnet, 1 testnet, 2 devnet.
pub fn xrp_network_id(net: Network) -> u64 {
    match net {
        Network::Mainnet => 0,
        Network::Testnet => 1,
    }
}

/// NEAR JSON-RPC (FastNEAR's free public tier, listed by docs.near.org › RPC providers;
/// `rpc.mainnet.near.org` / `rpc.testnet.near.org` are no longer listed there). No custom NEAR
/// server yet: these defaults only.
pub fn near_default_rpc(net: Network) -> &'static str {
    match net {
        Network::Mainnet => "https://free.rpc.fastnear.com/",
        Network::Testnet => "https://test.rpc.fastnear.com/",
    }
}

/// NEAR transaction history (FastNEAR explorer API: `/v0/account`, `/v0/transactions`),
/// same operator as the default RPC.
pub fn near_default_history(net: Network) -> &'static str {
    match net {
        Network::Mainnet => "https://tx.main.fastnear.com",
        Network::Testnet => "https://tx.test.fastnear.com",
    }
}

/// `status.chain_id` and `status.genesis_hash`, read on 2026-11-01 from free.rpc.fastnear.com
/// and test.rpc.fastnear.com (also rpc.mainnet.near.org / rpc.testnet.near.org).
pub fn near_genesis(net: Network) -> (&'static str, &'static str) {
    match net {
        Network::Mainnet => ("mainnet", "EPnLgE7iEq9s7yTkos96M3cWymH5avBAPm3qx3NXqR8H"),
        Network::Testnet => ("testnet", "FWJ9kR6KFWoyMoNjpLXXGHeuiy7tEY6GmoFeCA5yuc6b"),
    }
}

/// Cardano server: a Koios REST instance (`…/api/v1`), the same API as the defaults.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CardanoServer {
    #[default]
    Default,
    /// Base URL of the API, e.g. `https://koios.example/api/v1`.
    Koios { url: String },
}

impl CardanoServer {
    pub fn is_default(&self) -> bool {
        matches!(self, CardanoServer::Default)
    }

    pub fn kind_name(&self) -> &'static str {
        match self {
            CardanoServer::Default => "default",
            CardanoServer::Koios { .. } => "koios",
        }
    }
}

/// Key `testnet` = preprod (network magic 1).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct CardanoServers {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mainnet: Option<CardanoServer>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub testnet: Option<CardanoServer>,
}

impl CardanoServers {
    pub fn for_network(&self, net: Network) -> CardanoServer {
        match net {
            Network::Mainnet => self.mainnet.clone(),
            Network::Testnet => self.testnet.clone(),
        }
        .unwrap_or_default()
    }

    pub fn entries(&self) -> [(&'static str, &Option<CardanoServer>); 2] {
        [("mainnet", &self.mainnet), ("testnet", &self.testnet)]
    }
}

/// Koios (free, keyless public tier): preprod and mainnet.
pub fn cardano_default_url(net: Network) -> &'static str {
    match net {
        Network::Mainnet => "https://api.koios.rest/api/v1",
        Network::Testnet => "https://preprod.koios.rest/api/v1",
    }
}

/// Genesis `networkmagic`: mainnet 764824073, preprod 1 (preview is 2, refused).
pub fn cardano_network_magic(net: Network) -> u64 {
    match net {
        Network::Mainnet => 764_824_073,
        Network::Testnet => 1,
    }
}

/// `settings.servers`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Servers {
    pub bitcoin: BtcServers,
    /// Litecoin: Esplora only (as the default, litecoinspace.org).
    pub litecoin: UtxoServers,
    /// Dogecoin: the user's Esplora (electrs-dogecoin), or the default (mainnet: public
    /// ElectrumX servers; testnet: none).
    pub dogecoin: UtxoServers,
    /// TRON: java-tron HTTP API (default TronGrid). Key `testnet` = Nile.
    pub tron: TronServers,
    /// XRP Ledger: rippled JSON-RPC. Key `testnet` = XRPL Testnet.
    pub xrp: XrpServers,
    /// Cardano: Koios REST. Key `testnet` = preprod.
    pub cardano: CardanoServers,
    /// Key: EVM chain id in decimal (e.g. `"11155111"`).
    pub evm: BTreeMap<String, RpcServer>,
    /// Key: `"devnet"` or `"mainnet-beta"`.
    pub solana: BTreeMap<String, RpcServer>,
}

pub fn btc_network_key(net: Network) -> &'static str {
    match net {
        Network::Mainnet => "mainnet",
        Network::Testnet => "testnet4",
    }
}

pub fn solana_cluster(net: Network) -> &'static str {
    match net {
        Network::Mainnet => "mainnet-beta",
        Network::Testnet => "devnet",
    }
}

impl Servers {
    /// Bitcoin server for the app's network (`Default` when unset).
    pub fn bitcoin_for(&self, net: Network) -> BtcServer {
        match net {
            Network::Mainnet => self.bitcoin.mainnet.clone(),
            Network::Testnet => self.bitcoin.testnet4.clone(),
        }
        .unwrap_or_default()
    }

    pub fn utxo(&self, coin: UtxoCoin) -> &UtxoServers {
        match coin {
            UtxoCoin::Litecoin => &self.litecoin,
            UtxoCoin::Dogecoin => &self.dogecoin,
        }
    }

    pub fn utxo_mut(&mut self, coin: UtxoCoin) -> &mut UtxoServers {
        match coin {
            UtxoCoin::Litecoin => &mut self.litecoin,
            UtxoCoin::Dogecoin => &mut self.dogecoin,
        }
    }

    /// Litecoin / Dogecoin server for the app's network (`Default` when unset).
    pub fn utxo_for(&self, coin: UtxoCoin, net: Network) -> UtxoServer {
        self.utxo(coin).for_network(net)
    }

    pub fn solana_for(&self, net: Network) -> Option<&RpcServer> {
        self.solana.get(solana_cluster(net))
    }

    /// Hosts of custom HTTP servers with their family (allowlist extension for `net_fetch`).
    /// Electrum and Bitcoin Core are not HTTP-fetchable from the webview.
    pub fn custom_http_hosts(&self) -> Vec<(String, Family)> {
        let mut out = Vec::new();
        for s in [&self.bitcoin.mainnet, &self.bitcoin.testnet4]
            .into_iter()
            .flatten()
        {
            if let BtcServer::Esplora { url } = s {
                if let Some(h) = host_of(url) {
                    out.push((h, Family::Bitcoin));
                }
            }
        }
        for s in self.evm.values() {
            if let Some(h) = host_of(&s.url) {
                out.push((h, Family::Evm));
            }
        }
        for s in self.solana.values() {
            if let Some(h) = host_of(&s.url) {
                out.push((h, Family::Solana));
            }
        }
        out
    }

    /// Default hosts that must be refused because the user replaced them for `net`.
    pub fn disabled_defaults(&self, net: Network) -> Vec<&'static str> {
        let mut out = Vec::new();
        if !self.bitcoin_for(net).is_default() {
            out.extend(["mempool.space", MEMPOOL_ONION]);
        }
        for coin in [UtxoCoin::Litecoin, UtxoCoin::Dogecoin] {
            if !self.utxo_for(coin, net).is_default() {
                out.extend(utxo_default_hosts(coin));
            }
        }
        if !self.xrp.for_network(net).is_default() {
            out.push(match net {
                Network::Mainnet => "xrplcluster.com",
                Network::Testnet => "s.altnet.rippletest.net",
            });
        }
        if !self.cardano.for_network(net).is_default() {
            out.push(match net {
                Network::Mainnet => "api.koios.rest",
                Network::Testnet => "preprod.koios.rest",
            });
        }
        if !self.tron.for_network(net).is_default() {
            out.push(match net {
                Network::Mainnet => "api.trongrid.io",
                Network::Testnet => "nile.trongrid.io",
            });
        }
        for (chain, host) in EVM_DEFAULTS {
            if self.evm.contains_key(&chain.to_string()) {
                out.push(*host);
            }
        }
        for (cluster, host) in SOLANA_DEFAULTS {
            if self.solana.contains_key(*cluster) {
                out.push(*host);
            }
        }
        out
    }

    /// Syntax validation (no network). `tor` = Tor currently enabled in the same settings.
    pub fn validate(&self, tor: bool) -> AppResult<()> {
        for (key, s) in [
            ("mainnet", &self.bitcoin.mainnet),
            ("testnet4", &self.bitcoin.testnet4),
        ] {
            if let Some(s) = s {
                validate_btc(s, tor).map_err(|e| prefix(e, &format!("bitcoin {key}")))?;
            }
        }
        for coin in [UtxoCoin::Litecoin, UtxoCoin::Dogecoin] {
            for (key, s) in self.utxo(coin).entries() {
                if let Some(UtxoServer::Esplora { url }) = s {
                    let what = format!("{} {key}", coin.name().to_lowercase());
                    validate_http_url(url, tor, false).map_err(|e| prefix(e, &what))?;
                }
            }
        }
        for (key, s) in self.xrp.entries() {
            if let Some(XrpServer::JsonRpc { url }) = s {
                validate_http_url(url, tor, false).map_err(|e| prefix(e, &format!("xrp {key}")))?;
            }
        }
        for (key, s) in self.cardano.entries() {
            if let Some(CardanoServer::Koios { url }) = s {
                validate_http_url(url, tor, false)
                    .map_err(|e| prefix(e, &format!("cardano {key}")))?;
            }
        }
        for (key, s) in self.tron.entries() {
            if let Some(TronServer::Http { url }) = s {
                validate_http_url(url, tor, false)
                    .map_err(|e| prefix(e, &format!("tron {key}")))?;
            }
        }
        for (chain, s) in &self.evm {
            let id: u64 = chain.parse().map_err(|_| {
                AppError::ServerInvalid(format!("evm : chainId invalide « {chain} »"))
            })?;
            if id == 0 {
                return Err(AppError::ServerInvalid("evm : chainId 0".into()));
            }
            validate_http_url(&s.url, tor, false)
                .map_err(|e| prefix(e, &format!("evm {chain}")))?;
        }
        for (cluster, s) in &self.solana {
            if !SOLANA_DEFAULTS.iter().any(|(c, _)| c == cluster) {
                return Err(AppError::ServerInvalid(format!(
                    "solana : cluster inconnu « {cluster} » (devnet ou mainnet-beta)"
                )));
            }
            validate_http_url(&s.url, tor, false)
                .map_err(|e| prefix(e, &format!("solana {cluster}")))?;
        }
        Ok(())
    }

    /// Settings view for the UI: Core passwords removed, `hasPassword` set.
    pub fn redacted(&self) -> Servers {
        let mut out = self.clone();
        for s in [&mut out.bitcoin.mainnet, &mut out.bitcoin.testnet4]
            .into_iter()
            .flatten()
        {
            if let BtcServer::Core {
                auth:
                    CoreAuth::Userpass {
                        password,
                        has_password,
                        ..
                    },
                ..
            } = s
            {
                *has_password = password.as_deref().is_some_and(|p| !p.is_empty());
                *password = None;
            }
        }
        out
    }

    /// Applies an update from the UI: a Core `userpass` entry without `password` keeps the
    /// stored one (same URL and user); `password: ""` clears it.
    pub fn merge_secrets_from(&mut self, stored: &Servers) {
        let pairs = [
            (&mut self.bitcoin.mainnet, &stored.bitcoin.mainnet),
            (&mut self.bitcoin.testnet4, &stored.bitcoin.testnet4),
        ];
        for (new, old) in pairs {
            let (
                Some(BtcServer::Core { url, auth }),
                Some(BtcServer::Core {
                    url: old_url,
                    auth: old_auth,
                }),
            ) = (new.as_mut(), old.as_ref())
            else {
                continue;
            };
            if let (
                CoreAuth::Userpass { user, password, .. },
                CoreAuth::Userpass {
                    user: old_user,
                    password: old_password,
                    ..
                },
            ) = (auth, old_auth)
            {
                match password.as_deref() {
                    None if user == old_user && url == old_url => password.clone_from(old_password),
                    Some("") => *password = None,
                    _ => {}
                }
            }
        }
        for s in [&mut self.bitcoin.mainnet, &mut self.bitcoin.testnet4]
            .into_iter()
            .flatten()
        {
            if let BtcServer::Core {
                auth:
                    CoreAuth::Userpass {
                        password,
                        has_password,
                        ..
                    },
                ..
            } = s
            {
                *has_password = password.is_some();
            }
        }
    }
}

fn prefix(e: AppError, what: &str) -> AppError {
    match e {
        AppError::ServerInvalid(m) => AppError::ServerInvalid(format!("{what} : {m}")),
        other => other,
    }
}

pub fn host_of(url: &str) -> Option<String> {
    url::Url::parse(url)
        .ok()?
        .host_str()
        .map(|h| h.trim_start_matches('[').trim_end_matches(']').to_owned())
}

/// Loopback, RFC 1918, link-local and IPv6 ULA (fc00::/7) addresses, or `localhost`.
pub fn is_private_host(host: &str) -> bool {
    let h = host.trim_start_matches('[').trim_end_matches(']');
    if h.eq_ignore_ascii_case("localhost") {
        return true;
    }
    match h.parse::<IpAddr>() {
        Ok(IpAddr::V4(v4)) => is_private_v4(v4),
        Ok(IpAddr::V6(v6)) => {
            v6 == Ipv6Addr::LOCALHOST
                || (v6.segments()[0] & 0xfe00) == 0xfc00
                || (v6.segments()[0] & 0xffc0) == 0xfe80
                || v6.to_ipv4_mapped().is_some_and(is_private_v4)
        }
        Err(_) => false,
    }
}

fn is_private_v4(v4: Ipv4Addr) -> bool {
    v4.is_loopback() || v4.is_private() || v4.is_link_local()
}

fn invalid(msg: impl Into<String>) -> AppError {
    AppError::ServerInvalid(msg.into())
}

/// HTTP(S) server URL rule. `allow_private_http` = Bitcoin Core only.
pub fn validate_http_url(url: &str, tor: bool, allow_private_http: bool) -> AppResult<url::Url> {
    let u = url::Url::parse(url.trim()).map_err(|_| invalid(format!("URL invalide « {url} »")))?;
    if !u.username().is_empty() || u.password().is_some() {
        return Err(invalid(
            "pas d'identifiants dans l'URL (utilise les champs d'authentification)",
        ));
    }
    let host = u
        .host_str()
        .ok_or_else(|| invalid("URL sans hôte"))?
        .to_owned();
    let onion = host.ends_with(".onion");
    let private = is_private_host(&host);
    match u.scheme() {
        "https" if onion && !tor => Err(invalid("adresse .onion : exige Tor activé")),
        "https" => Ok(u),
        "http" if onion && tor => Ok(u),
        "http" if onion => Err(invalid("adresse .onion : exige Tor activé")),
        "http" if private && allow_private_http => Ok(u),
        "http" => Err(invalid(
            "http:// n'est permis que pour une adresse .onion via Tor (ou un nœud Bitcoin Core local)",
        )),
        other => Err(invalid(format!("schéma non autorisé « {other} »"))),
    }
}

fn validate_btc(s: &BtcServer, tor: bool) -> AppResult<()> {
    match s {
        BtcServer::Default => Ok(()),
        BtcServer::Cbf { peers, .. } => {
            if !cfg!(feature = "cbf") {
                return Err(AppError::FeatureDisabled(
                    "filtres compacts (BIP157/158) : disponible après revue (>= 2026-11-11)".into(),
                ));
            }
            let parsed = peers
                .iter()
                .map(|p| parse_peer(p))
                .collect::<AppResult<Vec<_>>>()?;
            if !tor
                && !parsed.is_empty()
                && parsed
                    .iter()
                    .all(|p| matches!(p.host, PeerHost::Onion { .. }))
            {
                return Err(invalid(
                    "pairs .onion uniquement : exige Tor activé (ajoute un pair IP pour le mode clair)",
                ));
            }
            Ok(())
        }
        BtcServer::Esplora { url } => validate_http_url(url, tor, false).map(|_| ()),
        BtcServer::Electrum {
            host,
            port,
            tls,
            cert_sha256,
        } => {
            let h = host.trim();
            if h.is_empty()
                || url::Host::parse(h).is_err()
                || h.contains(['/', ':', '@']) && !h.starts_with('[')
            {
                return Err(invalid(format!("hôte Electrum invalide « {host} »")));
            }
            if *port == 0 {
                return Err(invalid("port Electrum invalide"));
            }
            let onion = h.ends_with(".onion");
            if onion && !tor {
                return Err(invalid("adresse .onion : exige Tor activé"));
            }
            match tls {
                ElectrumTls::None if !(onion && tor) => Err(invalid(
                    "Electrum sans TLS : uniquement vers une adresse .onion via Tor",
                )),
                ElectrumTls::Pinned => {
                    parse_fingerprint(cert_sha256.as_deref().unwrap_or("")).map(|_| ())
                }
                _ => Ok(()),
            }
        }
        BtcServer::Core { url, auth } => {
            let u = validate_http_url(url, tor, true)?;
            match auth {
                CoreAuth::Cookie { cookie_path } => {
                    // The cookie is a local secret: it is only ever sent to a node on this
                    // machine or the local network, never to a remote (or onion) host.
                    if !u.host_str().is_some_and(is_private_host) {
                        return Err(invalid(
                            "fichier .cookie : seulement pour un nœud local (127.0.0.1, ::1) ou de ton réseau local ; pour un nœud distant, utilise rpcuser / rpcpassword",
                        ));
                    }
                    validate_cookie_path(cookie_path)
                }
                CoreAuth::Userpass { user, password, .. } => {
                    if user.is_empty() || user.contains(':') {
                        return Err(invalid("utilisateur RPC invalide"));
                    }
                    if password.as_deref().is_none_or(str::is_empty) {
                        return Err(invalid("mot de passe RPC manquant"));
                    }
                    Ok(())
                }
            }
        }
    }
}

/// Largest `.cookie` accepted (`__cookie__:` + 64 hex = 75 bytes, plus a newline).
pub const MAX_COOKIE_LEN: u64 = 256;

/// Syntax of a cookie path: absolute, file name exactly `.cookie`. The content is checked by
/// [`read_cookie`]. Never echoes the path (it may come from a compromised interface).
pub fn validate_cookie_path(path: &str) -> AppResult<()> {
    let p = std::path::Path::new(path.trim());
    if !p.is_absolute() || p.file_name().and_then(|n| n.to_str()) != Some(".cookie") {
        return Err(invalid(
            "fichier .cookie : choisis le fichier « .cookie » du dossier de données de ton nœud",
        ));
    }
    Ok(())
}

/// `__cookie__:` followed by 64 lower-case hex characters (Bitcoin Core's cookie format).
pub fn is_cookie_content(s: &str) -> bool {
    s.strip_prefix("__cookie__:")
        .is_some_and(|h| h.len() == 64 && h.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')))
}

/// Reads a Bitcoin Core `.cookie` safely: the name must be `.cookie`, no symlink, a regular
/// file of at most [`MAX_COOKIE_LEN`] bytes whose content is exactly `__cookie__:<64 hex>`.
/// Errors never contain the path nor the OS error (no file-content oracle for the interface).
pub fn read_cookie(path: &str) -> AppResult<zeroize::Zeroizing<String>> {
    use std::io::Read as _;
    let refused = || {
        AppError::ServerInvalid(
            "Bitcoin Core : fichier .cookie illisible ou invalide (choisis à nouveau le fichier .cookie de ton nœud)".into(),
        )
    };
    validate_cookie_path(path).map_err(|_| refused())?;
    let p = std::path::Path::new(path.trim());
    let meta = std::fs::symlink_metadata(p).map_err(|_| refused())?;
    if meta.file_type().is_symlink() || !meta.is_file() || meta.len() > MAX_COOKIE_LEN {
        return Err(refused());
    }
    let mut buf = zeroize::Zeroizing::new(Vec::with_capacity(MAX_COOKIE_LEN as usize));
    std::fs::File::open(p)
        .and_then(|f| f.take(MAX_COOKIE_LEN + 1).read_to_end(&mut buf))
        .map_err(|_| refused())?;
    if buf.len() as u64 > MAX_COOKIE_LEN {
        return Err(refused());
    }
    let text = std::str::from_utf8(&buf).map_err(|_| refused())?.trim();
    if !is_cookie_content(text) {
        return Err(refused());
    }
    Ok(zeroize::Zeroizing::new(text.to_owned()))
}

/// A P2P peer (`host:port`): an onion v3 service or an IP literal. Hostnames are refused so
/// that no DNS lookup ever happens.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Peer {
    pub host: PeerHost,
    pub port: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum PeerHost {
    /// `<56 base32 chars>.onion` (lowercase) and its ed25519 public key.
    Onion {
        name: String,
        key: [u8; 32],
    },
    Ip(IpAddr),
}

impl Peer {
    /// Host as sent in a SOCKS5 request (onion name or IP text).
    pub fn host_string(&self) -> String {
        match &self.host {
            PeerHost::Onion { name, .. } => name.clone(),
            PeerHost::Ip(ip) => ip.to_string(),
        }
    }
}

impl std::fmt::Display for Peer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.host {
            PeerHost::Ip(IpAddr::V6(v6)) => write!(f, "[{v6}]:{}", self.port),
            _ => write!(f, "{}:{}", self.host_string(), self.port),
        }
    }
}

const ONION_ALPHABET: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";

/// Decodes and checks a v3 onion name (rend-spec-v3: base32(pubkey | checksum | version),
/// checksum = SHA3-256(".onion checksum" | pubkey | version)[..2], version = 3).
pub fn parse_onion_v3(name: &str) -> AppResult<[u8; 32]> {
    let label = name
        .strip_suffix(".onion")
        .ok_or_else(|| invalid("adresse .onion attendue"))?;
    if label.len() != 56 {
        return Err(invalid("adresse .onion v3 : 56 caractères attendus"));
    }
    let mut bits: u64 = 0;
    let mut nbits = 0u32;
    let mut out = Vec::with_capacity(35);
    for c in label.bytes() {
        let v = ONION_ALPHABET
            .iter()
            .position(|a| *a == c)
            .ok_or_else(|| invalid("adresse .onion : caractère invalide"))? as u64;
        bits = (bits << 5) | v;
        nbits += 5;
        if nbits >= 8 {
            nbits -= 8;
            out.push((bits >> nbits) as u8);
            bits &= (1 << nbits) - 1;
        }
    }
    if out.len() != 35 || out[34] != 3 {
        return Err(invalid("adresse .onion : version 3 attendue"));
    }
    use sha3::{Digest, Sha3_256};
    let mut h = Sha3_256::new();
    h.update(b".onion checksum");
    h.update(&out[..32]);
    h.update([3u8]);
    let sum = h.finalize();
    if sum[..2] != out[32..34] {
        return Err(invalid("adresse .onion : somme de contrôle invalide"));
    }
    let mut key = [0u8; 32];
    key.copy_from_slice(&out[..32]);
    Ok(key)
}

/// Parses `host:port` / `[v6]:port` for a P2P peer.
pub fn parse_peer(s: &str) -> AppResult<Peer> {
    let s = s.trim();
    let (host, port) = s
        .rsplit_once(':')
        .ok_or_else(|| invalid(format!("pair « {s} » : hôte:port attendu")))?;
    let port: u16 = port
        .parse()
        .ok()
        .filter(|p| *p != 0)
        .ok_or_else(|| invalid(format!("pair « {s} » : port invalide")))?;
    let host = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_ascii_lowercase();
    if host.ends_with(".onion") {
        let key = parse_onion_v3(&host)?;
        return Ok(Peer {
            host: PeerHost::Onion { name: host, key },
            port,
        });
    }
    let ip: IpAddr = host.parse().map_err(|_| {
        invalid(format!(
            "pair « {s} » : adresse IP ou .onion attendue (pas de nom d'hôte : aucune requête DNS)"
        ))
    })?;
    Ok(Peer {
        host: PeerHost::Ip(ip),
        port,
    })
}

/// `AA:BB:…` or plain hex SHA-256 fingerprint → 32 bytes.
pub fn parse_fingerprint(s: &str) -> AppResult<[u8; 32]> {
    let clean: String = s
        .chars()
        .filter(|c| *c != ':' && !c.is_whitespace())
        .collect();
    let mut out = [0u8; 32];
    hex::decode_to_slice(&clean, &mut out).map_err(|_| {
        invalid("empreinte SHA-256 du certificat : 64 caractères hexadécimaux attendus")
    })?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn esplora(url: &str) -> BtcServer {
        BtcServer::Esplora { url: url.into() }
    }

    fn with_btc(s: BtcServer) -> Servers {
        Servers {
            bitcoin: BtcServers {
                testnet4: Some(s),
                mainnet: None,
            },
            ..Default::default()
        }
    }

    #[test]
    fn private_hosts() {
        for h in [
            "127.0.0.1",
            "127.8.9.1",
            "10.0.0.5",
            "172.16.3.4",
            "192.168.1.10",
            "::1",
            "[::1]",
            "fd12::1",
            "fe80::1",
            "localhost",
            "169.254.1.1",
            "::ffff:192.168.1.2",
        ] {
            assert!(is_private_host(h), "{h}");
        }
        for h in [
            "8.8.8.8",
            "172.32.0.1",
            "mempool.space",
            "2001:db8::1",
            "1.1.1.1",
            "example.onion",
        ] {
            assert!(!is_private_host(h), "{h}");
        }
    }

    #[test]
    fn url_rules() {
        // https always fine; credentials never.
        assert!(validate_http_url("https://node.example/api", false, false).is_ok());
        assert!(validate_http_url("https://u:p@node.example/api", true, false).is_err());
        // http: onion over Tor only.
        let onion = "http://abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuv.onion/api";
        assert!(validate_http_url(onion, true, false).is_ok());
        assert!(validate_http_url(onion, false, false).is_err());
        assert!(validate_http_url("http://node.example/api", true, false).is_err());
        // Core only: private http.
        assert!(validate_http_url("http://127.0.0.1:8332/", false, true).is_ok());
        assert!(validate_http_url("http://192.168.1.5:48332/", true, true).is_ok());
        assert!(validate_http_url("http://127.0.0.1:8332/", false, false).is_err());
        assert!(validate_http_url("http://8.8.8.8:8332/", false, true).is_err());
        assert!(validate_http_url("ftp://node.example/", true, true).is_err());
        assert!(validate_http_url("not a url", true, true).is_err());
    }

    #[test]
    fn btc_server_validation() {
        assert!(with_btc(esplora("https://blockstream.info/testnet/api"))
            .validate(true)
            .is_ok());
        assert!(with_btc(esplora("http://blockstream.info/api"))
            .validate(true)
            .is_err());
        let e = |host: &str, tls, pin: Option<&str>| BtcServer::Electrum {
            host: host.into(),
            port: 50002,
            tls,
            cert_sha256: pin.map(str::to_owned),
        };
        assert!(with_btc(e("electrum.example", ElectrumTls::Webpki, None))
            .validate(false)
            .is_ok());
        assert!(with_btc(e("electrum.example", ElectrumTls::None, None))
            .validate(true)
            .is_err());
        assert!(with_btc(e("x.onion", ElectrumTls::None, None))
            .validate(true)
            .is_ok());
        assert!(with_btc(e("x.onion", ElectrumTls::None, None))
            .validate(false)
            .is_err());
        assert!(with_btc(e("electrum.example", ElectrumTls::Pinned, None))
            .validate(true)
            .is_err());
        let pin = "AB:".repeat(31) + "AB";
        assert!(
            with_btc(e("electrum.example", ElectrumTls::Pinned, Some(&pin)))
                .validate(true)
                .is_ok()
        );
        assert!(with_btc(e("bad host/x", ElectrumTls::Webpki, None))
            .validate(true)
            .is_err());
        let core = |url: &str, auth| BtcServer::Core {
            url: url.into(),
            auth,
        };
        let cookie = CoreAuth::Cookie {
            cookie_path: if cfg!(windows) {
                "C:\\btc\\.cookie"
            } else {
                "/btc/.cookie"
            }
            .into(),
        };
        assert!(with_btc(core("http://127.0.0.1:48332", cookie.clone()))
            .validate(true)
            .is_ok());
        assert!(with_btc(core("http://node.example:8332", cookie.clone()))
            .validate(true)
            .is_err());
        // CRITIQUE 1: the cookie is a local secret, never sent to a remote or onion host.
        for remote in [
            "https://node.example:8332",
            "https://8.8.8.8:8332",
            "http://abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcd.onion:8332",
        ] {
            assert!(
                with_btc(core(remote, cookie.clone()))
                    .validate(true)
                    .is_err(),
                "{remote}"
            );
        }
        assert!(with_btc(core("http://192.168.1.20:8332", cookie.clone()))
            .validate(true)
            .is_ok());
        assert!(with_btc(core("https://[::1]:8332", cookie))
            .validate(true)
            .is_ok());
        // File name must be exactly `.cookie` (no settings.json, vault, SSH key…), absolute.
        let abs = |name: &str| {
            if cfg!(windows) {
                format!("C:\\btc\\{name}")
            } else {
                format!("/btc/{name}")
            }
        };
        for bad in [
            ".cookie".to_owned(),
            abs("settings.json"),
            abs("coffre-mainnet.kyrovault"),
            abs("id_ed25519"),
            abs(".cookie.bak"),
            abs("x.cookie"),
        ] {
            let auth = CoreAuth::Cookie {
                cookie_path: bad.clone(),
            };
            let err = with_btc(core("http://127.0.0.1:8332", auth))
                .validate(true)
                .unwrap_err();
            // The path is never echoed back.
            assert!(bad == ".cookie" || !err.to_string().contains(&bad), "{err}");
        }
        let nopass = CoreAuth::Userpass {
            user: "kyro".into(),
            password: None,
            has_password: false,
        };
        assert!(with_btc(core("http://127.0.0.1:8332", nopass))
            .validate(true)
            .is_err());
    }

    #[test]
    fn evm_and_solana_validation() {
        let mut s = Servers::default();
        s.evm.insert(
            "11155111".into(),
            RpcServer {
                url: "https://rpc.example".into(),
            },
        );
        s.solana.insert(
            "devnet".into(),
            RpcServer {
                url: "https://sol.example".into(),
            },
        );
        assert!(s.validate(true).is_ok());
        s.evm.insert(
            "abc".into(),
            RpcServer {
                url: "https://rpc.example".into(),
            },
        );
        assert!(s.validate(true).is_err());
        s.evm.remove("abc");
        s.solana.insert(
            "testnet".into(),
            RpcServer {
                url: "https://sol.example".into(),
            },
        );
        assert!(s.validate(true).is_err());
    }

    #[test]
    fn disabled_defaults_and_hosts() {
        let mut s = with_btc(esplora("https://esplora.example/api"));
        s.evm.insert(
            "11155111".into(),
            RpcServer {
                url: "https://rpc.example/x".into(),
            },
        );
        s.solana.insert(
            "devnet".into(),
            RpcServer {
                url: "https://sol.example".into(),
            },
        );
        let d = s.disabled_defaults(Network::Testnet);
        for h in [
            "mempool.space",
            MEMPOOL_ONION,
            "ethereum-sepolia-rpc.publicnode.com",
            "api.devnet.solana.com",
        ] {
            assert!(d.contains(&h), "{h}");
        }
        assert!(!d.contains(&"ethereum-rpc.publicnode.com"));
        // Mainnet bitcoin is still default.
        assert!(!s
            .disabled_defaults(Network::Mainnet)
            .contains(&"mempool.space"));
        let hosts = s.custom_http_hosts();
        assert!(hosts.contains(&("esplora.example".into(), Family::Bitcoin)));
        assert!(hosts.contains(&("rpc.example".into(), Family::Evm)));
        assert!(hosts.contains(&("sol.example".into(), Family::Solana)));
    }

    #[test]
    fn password_never_returned_and_kept_on_update() {
        let stored = with_btc(BtcServer::Core {
            url: "http://127.0.0.1:48332".into(),
            auth: CoreAuth::Userpass {
                user: "kyro".into(),
                password: Some("s3cret".into()),
                has_password: true,
            },
        });
        let ui = stored.redacted();
        let json = serde_json::to_string(&ui).unwrap();
        assert!(!json.contains("s3cret"));
        assert!(json.contains("\"hasPassword\":true"));
        // UI sends the redacted form back: password kept.
        let mut update = ui.clone();
        update.merge_secrets_from(&stored);
        assert_eq!(update, {
            let mut s = stored.clone();
            if let Some(BtcServer::Core {
                auth: CoreAuth::Userpass { has_password, .. },
                ..
            }) = &mut s.bitcoin.testnet4
            {
                *has_password = true;
            }
            s
        });
        // Different user: not kept.
        let mut other = ui.clone();
        if let Some(BtcServer::Core {
            auth: CoreAuth::Userpass { user, .. },
            ..
        }) = &mut other.bitcoin.testnet4
        {
            *user = "someone".into();
        }
        other.merge_secrets_from(&stored);
        assert!(other.validate(true).is_err());
        // Explicit "" clears.
        let mut cleared = ui;
        if let Some(BtcServer::Core {
            auth: CoreAuth::Userpass { password, .. },
            ..
        }) = &mut cleared.bitcoin.testnet4
        {
            *password = Some(String::new());
        }
        cleared.merge_secrets_from(&stored);
        assert!(cleared.validate(true).is_err());
    }

    #[test]
    fn p2p_peers_are_onion_v3_or_ip_literals_only() {
        let onion = "a6yijgwn4vtmmhl7uybtbuyvtl7mtj7arld5f4csqsx4syeii4gt3vqd.onion:48333";
        let p = parse_peer(onion).unwrap();
        assert!(matches!(p.host, PeerHost::Onion { .. }));
        assert_eq!(p.to_string(), onion);
        // Upper case is normalised; a flipped character breaks the v3 checksum.
        assert_eq!(
            parse_peer(&onion.to_uppercase().replace(".ONION", ".onion")).unwrap(),
            p
        );
        let bad = onion.replacen('a', "b", 1);
        assert!(parse_peer(&bad).is_err());
        assert!(
            parse_peer("abc.onion:48333").is_err(),
            "v2/short onion refused"
        );
        // IP literals.
        assert_eq!(
            parse_peer("203.132.94.196:48333").unwrap().to_string(),
            "203.132.94.196:48333"
        );
        assert_eq!(
            parse_peer("[2001:db8::1]:8333").unwrap().to_string(),
            "[2001:db8::1]:8333"
        );
        // Hostnames (DNS) and bad ports refused.
        for bad in [
            "seed.testnet4.wiz.biz:48333",
            "localhost:8333",
            "1.2.3.4:0",
            "1.2.3.4",
            "1.2.3.4:99999",
        ] {
            assert!(parse_peer(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn cbf_kind_is_feature_gated() {
        let s = with_btc(BtcServer::Cbf {
            peers: vec![],
            birth_height: Some(100),
        });
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["bitcoin"]["testnet4"]["kind"], "cbf");
        assert_eq!(v["bitcoin"]["testnet4"]["birthHeight"], 100);
        let r = s.validate(true);
        if cfg!(feature = "cbf") {
            assert!(r.is_ok(), "{r:?}");
            // Onion-only peer list in clear mode: refused.
            let onion = with_btc(BtcServer::Cbf {
                peers: vec![
                    "a6yijgwn4vtmmhl7uybtbuyvtl7mtj7arld5f4csqsx4syeii4gt3vqd.onion:48333".into(),
                ],
                birth_height: None,
            });
            assert!(onion.validate(false).is_err());
            assert!(onion.validate(true).is_ok());
        } else {
            assert!(matches!(r, Err(AppError::FeatureDisabled(_))), "{r:?}");
        }
        // A CBF server disables mempool for that network.
        assert!(s
            .disabled_defaults(Network::Testnet)
            .contains(&"mempool.space"));
    }

    #[test]
    fn cardano_servers() {
        let mut s = Servers::default();
        assert_eq!(
            s.cardano.for_network(Network::Testnet),
            CardanoServer::Default
        );
        assert!(s
            .disabled_defaults(Network::Testnet)
            .iter()
            .all(|h| !h.contains("koios")));
        s.cardano.testnet = Some(CardanoServer::Koios {
            url: "https://koios.example/api/v1".into(),
        });
        assert!(s.validate(true).is_ok());
        assert!(s
            .disabled_defaults(Network::Testnet)
            .contains(&"preprod.koios.rest"));
        assert!(!s
            .disabled_defaults(Network::Mainnet)
            .contains(&"api.koios.rest"));
        s.cardano.mainnet = Some(CardanoServer::Koios {
            url: "http://koios.example/".into(),
        });
        assert!(
            matches!(s.validate(true), Err(AppError::ServerInvalid(ref m)) if m.starts_with("cardano mainnet"))
        );
        assert_eq!(
            serde_json::to_value(CardanoServer::Koios {
                url: "https://k/".into()
            })
            .unwrap(),
            serde_json::json!({ "kind": "koios", "url": "https://k/" })
        );
        assert_eq!(cardano_network_magic(Network::Testnet), 1);
        assert_eq!(cardano_network_magic(Network::Mainnet), 764_824_073);
    }

    #[test]
    fn xrp_servers() {
        let mut s = Servers::default();
        assert_eq!(s.xrp.for_network(Network::Testnet), XrpServer::Default);
        s.xrp.testnet = Some(XrpServer::JsonRpc {
            url: "https://rippled.my-node.example:51234/".into(),
        });
        assert!(s.validate(true).is_ok());
        assert!(s
            .disabled_defaults(Network::Testnet)
            .contains(&"s.altnet.rippletest.net"));
        s.xrp.mainnet = Some(XrpServer::JsonRpc {
            url: "http://x.example".into(),
        });
        assert!(
            matches!(s.validate(true), Err(AppError::ServerInvalid(ref m)) if m.starts_with("xrp mainnet"))
        );
        assert_eq!(
            serde_json::to_value(XrpServer::JsonRpc {
                url: "https://x".into()
            })
            .unwrap(),
            serde_json::json!({ "kind": "jsonRpc", "url": "https://x" })
        );
        assert_eq!(xrp_network_id(Network::Testnet), 1);
    }

    #[test]
    fn tron_servers() {
        let mut s = Servers::default();
        assert_eq!(s.tron.for_network(Network::Testnet), TronServer::Default);
        s.tron.testnet = Some(TronServer::Http {
            url: "https://tron.my-node.example".into(),
        });
        assert!(s.validate(true).is_ok());
        assert!(s
            .disabled_defaults(Network::Testnet)
            .contains(&"nile.trongrid.io"));
        assert!(!s
            .disabled_defaults(Network::Mainnet)
            .contains(&"api.trongrid.io"));
        s.tron.mainnet = Some(TronServer::Http {
            url: "http://tron.example".into(),
        });
        assert!(
            matches!(s.validate(true), Err(AppError::ServerInvalid(ref m)) if m.starts_with("tron mainnet"))
        );
        let v = serde_json::to_value(TronServer::Http {
            url: "https://x".into(),
        })
        .unwrap();
        assert_eq!(v, serde_json::json!({ "kind": "http", "url": "https://x" }));
        assert_eq!(
            tron_default_base(Network::Testnet),
            "https://nile.trongrid.io"
        );
    }

    #[test]
    fn litecoin_dogecoin_servers() {
        let mut s = Servers::default();
        assert_eq!(
            s.utxo_for(UtxoCoin::Litecoin, Network::Testnet),
            UtxoServer::Default
        );
        assert!(!s
            .disabled_defaults(Network::Testnet)
            .contains(&"litecoinspace.org"));
        s.litecoin.testnet = Some(UtxoServer::Esplora {
            url: "https://ltc.my-node.example/api".into(),
        });
        s.dogecoin.mainnet = Some(UtxoServer::Esplora {
            url: "http://abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuv.onion/api".into(),
        });
        assert!(s.validate(true).is_ok());
        // .onion without Tor, plain http: refused like every other server.
        assert!(
            matches!(s.validate(false), Err(AppError::ServerInvalid(ref m)) if m.starts_with("dogecoin mainnet"))
        );
        s.dogecoin.mainnet = Some(UtxoServer::Esplora {
            url: "http://doge.example/api".into(),
        });
        assert!(s.validate(true).is_err());
        s.dogecoin.mainnet = Some(UtxoServer::Esplora {
            url: "https://u:p@doge.example/api".into(),
        });
        assert!(s.validate(true).is_err());
        s.dogecoin.mainnet = None;
        // The replaced default is refused, on that network only.
        assert!(s
            .disabled_defaults(Network::Testnet)
            .contains(&"litecoinspace.org"));
        assert!(!s
            .disabled_defaults(Network::Mainnet)
            .contains(&"litecoinspace.org"));
        // JSON: `servers.litecoin.testnet = { kind: 'esplora', url }`; absent = default.
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["litecoin"]["testnet"]["kind"], "esplora");
        assert_eq!(v["dogecoin"], serde_json::json!({}));
        let back: Servers = serde_json::from_value(serde_json::json!({
            "bitcoin": {}, "evm": {}, "solana": {}
        }))
        .unwrap();
        assert_eq!(back.litecoin, UtxoServers::default());
        assert!(utxo_default_base(UtxoCoin::Dogecoin, Network::Testnet).is_none());
        // Dogecoin: Electrum default on mainnet only, from the allowlist; none on testnet.
        assert_eq!(
            utxo_default_electrum(UtxoCoin::Dogecoin, Network::Mainnet),
            vec![
                ("doge.electrum1.cipig.net", 20060),
                ("doge.electrum2.cipig.net", 20060)
            ]
        );
        assert!(utxo_has_default(UtxoCoin::Dogecoin, Network::Mainnet));
        assert!(!utxo_has_default(UtxoCoin::Dogecoin, Network::Testnet));
        assert!(utxo_default_electrum(UtxoCoin::Litecoin, Network::Mainnet).is_empty());
        for (h, _) in utxo_default_electrum(UtxoCoin::Dogecoin, Network::Mainnet) {
            assert!(utxo_default_hosts(UtxoCoin::Dogecoin).contains(&h));
        }
        s.dogecoin.mainnet = Some(UtxoServer::Esplora {
            url: "https://doge.example/api".into(),
        });
        assert!(s
            .disabled_defaults(Network::Mainnet)
            .contains(&"doge.electrum1.cipig.net"));
        s.dogecoin.mainnet = None;
        assert_eq!(
            utxo_default_base(UtxoCoin::Litecoin, Network::Testnet),
            Some("https://litecoinspace.org/testnet/api")
        );
    }

    #[test]
    fn serde_shape() {
        let s = with_btc(BtcServer::Electrum {
            host: "e.example".into(),
            port: 50002,
            tls: ElectrumTls::Pinned,
            cert_sha256: Some("00".repeat(32)),
        });
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["bitcoin"]["testnet4"]["kind"], "electrum");
        assert_eq!(v["bitcoin"]["testnet4"]["tls"], "pinned");
        assert_eq!(v["bitcoin"]["testnet4"]["certSha256"], "00".repeat(32));
        let back: Servers = serde_json::from_value(v).unwrap();
        assert_eq!(back, s);
        let core: BtcServer = serde_json::from_value(serde_json::json!({
            "kind": "core", "url": "http://127.0.0.1:8332",
            "auth": { "kind": "cookie", "cookiePath": "/x/.cookie" }
        }))
        .unwrap();
        assert!(matches!(
            core,
            BtcServer::Core {
                auth: CoreAuth::Cookie { .. },
                ..
            }
        ));
    }

    /// CRITIQUE 1: only a real Bitcoin Core cookie is ever read and sent.
    #[test]
    fn cookie_reading_is_strict() {
        let dir = std::env::temp_dir().join(format!("kyro-cookie-strict-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(".cookie");
        let p = path.to_string_lossy().into_owned();
        let good = format!("__cookie__:{}", "a1".repeat(32));
        std::fs::write(&path, format!("{good}\n")).unwrap();
        assert_eq!(read_cookie(&p).unwrap().as_str(), good);
        for bad in [
            "__cookie__:abc".to_owned(),
            format!("__cookie__:{}", "A1".repeat(32)),
            format!("user:{}", "a1".repeat(32)),
            "{\"tor\":{\"enabled\":true}}".to_owned(),
            "x".repeat(300),
        ] {
            std::fs::write(&path, &bad).unwrap();
            let e = read_cookie(&p).unwrap_err().to_string();
            assert!(!e.contains(&p) && !e.contains("abc"), "{e}");
        }
        // Another file name (settings.json, the vault…) is refused before being opened.
        let other = dir.join("settings.json");
        std::fs::write(&other, &good).unwrap();
        assert!(read_cookie(&other.to_string_lossy()).is_err());
        // A symlink named .cookie is refused (Unix: creating one needs no privilege).
        #[cfg(unix)]
        {
            std::fs::remove_file(&path).unwrap();
            std::os::unix::fs::symlink(&other, &path).unwrap();
            assert!(read_cookie(&p).is_err());
        }
        // Missing file: same generic error, no OS text.
        let _ = std::fs::remove_file(&path);
        let e = read_cookie(&p).unwrap_err().to_string();
        assert!(!e.contains(&p), "{e}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
