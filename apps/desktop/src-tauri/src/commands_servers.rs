//! IPC commands for user-chosen servers (B2b): settings with live validation, connection
//! test, Electrum certificate fetch (TOFU), Bitcoin data in Esplora shapes from any backend,
//! and the Bitcoin Core watch-only wallet. Contract: docs/IPC.md.

use std::time::Instant;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{Manager, State};
use wallet_core::{BtcKind, Network, UtxoCoin};

use crate::btc_backend::{self, Ctx, Detected};
use crate::error::{AppError, AppResult};
use crate::net::{Family, NetClient, ServerRequest};
use crate::server_approval::{confirm_endpoints, confirm_tor_off, endpoints, host_port_endpoint};
use crate::servers::{
    btc_network_key, validate_http_url, BtcServer, CardanoServer, CoreAuth, RpcServer, Servers,
    TronServer, UtxoServer, XrpServer, SOLANA_GENESIS,
};
use crate::settings::Settings;
use crate::state::AppState;

fn network_of(key: &str) -> AppResult<Network> {
    match key {
        "mainnet" => Ok(Network::Mainnet),
        "testnet4" => Ok(Network::Testnet),
        other => Err(AppError::ServerInvalid(format!(
            "réseau Bitcoin inconnu « {other} » (mainnet ou testnet4)"
        ))),
    }
}

/// Litecoin / Dogecoin network key of `servers.{litecoin,dogecoin}`.
fn utxo_network_of(key: &str) -> AppResult<Network> {
    match key {
        "mainnet" => Ok(Network::Mainnet),
        "testnet" => Ok(Network::Testnet),
        other => Err(AppError::ServerInvalid(format!(
            "réseau inconnu « {other} » (mainnet ou testnet)"
        ))),
    }
}

fn fingerprint(state: &AppState) -> AppResult<String> {
    let net = state.network;
    state.with_seed(|seed| Ok(wallet_core::btc_account(seed, net, BtcKind::Segwit, 0)?.fingerprint))
}

/// Backend context for the app's network; the fingerprint is only read for Bitcoin Core.
fn ctx<'a>(state: &'a AppState, settings: &Settings) -> AppResult<Ctx<'a>> {
    let server = settings.servers.bitcoin_for(state.network);
    let fingerprint = match server {
        BtcServer::Core { .. } => Some(fingerprint(state)?),
        _ => None,
    };
    Ok(Ctx {
        net_client: &state.net,
        network: state.network,
        tor: settings.tor.enabled,
        server,
        fingerprint,
    })
}

// ---------------------------------------------------------------- probes

async fn json_rpc(
    net: &NetClient,
    url: &str,
    tor: bool,
    family: Family,
    method: &str,
) -> AppResult<Value> {
    let u = validate_http_url(url, tor, false)?;
    let body = json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": [] }).to_string();
    let (status, bytes) = net
        .server_request(ServerRequest::post_json(u, family, body), tor)
        .await?;
    let v: Value = serde_json::from_slice(&bytes).map_err(|_| {
        AppError::ServerUnreachable(format!("{method} : HTTP {status}, réponse non JSON"))
    })?;
    v.get("result")
        .cloned()
        .filter(|r| !r.is_null())
        .ok_or_else(|| {
            AppError::ServerUnreachable(format!("{method} : pas de résultat (HTTP {status})"))
        })
}

async fn probe_evm(net: &NetClient, chain: u64, s: &RpcServer, tor: bool) -> AppResult<Detected> {
    let r = json_rpc(net, &s.url, tor, Family::Evm, "eth_chainId").await?;
    let found = r
        .as_str()
        .and_then(|h| u64::from_str_radix(h.trim_start_matches("0x"), 16).ok())
        .ok_or_else(|| AppError::ServerUnreachable("eth_chainId invalide".into()))?;
    if found != chain {
        return Err(AppError::ServerWrongNetwork(format!(
            "chainId {found} au lieu de {chain}"
        )));
    }
    Ok(Detected {
        chain_id: Some(found),
        ..Default::default()
    })
}

async fn probe_solana(
    net: &NetClient,
    cluster: &str,
    s: &RpcServer,
    tor: bool,
) -> AppResult<Detected> {
    let expected = SOLANA_GENESIS
        .iter()
        .find(|(c, _)| *c == cluster)
        .map(|(_, g)| *g)
        .ok_or_else(|| AppError::ServerInvalid(format!("cluster inconnu « {cluster} »")))?;
    let r = json_rpc(net, &s.url, tor, Family::Solana, "getGenesisHash").await?;
    let found = r.as_str().unwrap_or_default().to_owned();
    if found != expected {
        let what = SOLANA_GENESIS
            .iter()
            .find(|(_, g)| *g == found)
            .map_or("cluster inconnu", |(c, _)| c);
        return Err(AppError::ServerWrongNetwork(format!(
            "ce RPC est sur {what}, pas sur {cluster}"
        )));
    }
    Ok(Detected {
        network: Some(cluster.into()),
        genesis_hash: Some(found),
        ..Default::default()
    })
}

async fn probe_btc(
    net: &NetClient,
    network: Network,
    s: &BtcServer,
    tor: bool,
) -> AppResult<Detected> {
    let ctx = Ctx {
        net_client: net,
        network,
        tor,
        server: s.clone(),
        fingerprint: None,
    };
    btc_backend::probe(&ctx).await
}

/// Probes every server entry of `new` that differs from `old`.
async fn probe_changes(net: &NetClient, new: &Servers, old: &Servers, tor: bool) -> AppResult<()> {
    for (key, n, o) in [
        ("mainnet", &new.bitcoin.mainnet, &old.bitcoin.mainnet),
        ("testnet4", &new.bitcoin.testnet4, &old.bitcoin.testnet4),
    ] {
        if let Some(s) = n.as_ref().filter(|s| !s.is_default() && *n != *o) {
            probe_btc(net, network_of(key)?, s, tor).await?;
        }
    }
    for coin in [UtxoCoin::Litecoin, UtxoCoin::Dogecoin] {
        for ((key, n), (_, o)) in new
            .utxo(coin)
            .entries()
            .into_iter()
            .zip(old.utxo(coin).entries())
        {
            if let Some(s) = n.as_ref().filter(|s| !s.is_default() && *n != *o) {
                crate::commands_utxo::probe(net, utxo_network_of(key)?, coin, s, tor).await?;
            }
        }
    }
    for ((key, n), (_, o)) in new.xrp.entries().into_iter().zip(old.xrp.entries()) {
        if let Some(s) = n.as_ref().filter(|s| !s.is_default() && *n != *o) {
            crate::commands_xrp::probe(net, utxo_network_of(key)?, s, tor).await?;
        }
    }
    for ((key, n), (_, o)) in new.cardano.entries().into_iter().zip(old.cardano.entries()) {
        if let Some(s) = n.as_ref().filter(|s| !s.is_default() && *n != *o) {
            crate::commands_cardano::probe(net, utxo_network_of(key)?, s, tor).await?;
        }
    }
    for ((key, n), (_, o)) in new.tron.entries().into_iter().zip(old.tron.entries()) {
        if let Some(s) = n.as_ref().filter(|s| !s.is_default() && *n != *o) {
            crate::commands_tron::probe(net, utxo_network_of(key)?, s, tor).await?;
        }
    }
    for (chain, s) in &new.evm {
        if old.evm.get(chain) != Some(s) {
            let id = chain
                .parse()
                .map_err(|_| AppError::ServerInvalid(format!("chainId invalide « {chain} »")))?;
            probe_evm(net, id, s, tor).await?;
        }
    }
    for (cluster, s) in &new.solana {
        if old.solana.get(cluster) != Some(s) {
            probe_solana(net, cluster, s, tor).await?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------- cookie gate

/// `.cookie` paths of the Bitcoin Core entries of `s`.
fn cookie_paths(s: &Servers) -> Vec<&str> {
    [&s.bitcoin.mainnet, &s.bitcoin.testnet4]
        .into_iter()
        .flatten()
        .filter_map(|b| match b {
            BtcServer::Core {
                auth: CoreAuth::Cookie { cookie_path },
                ..
            } => Some(cookie_path.as_str()),
            _ => None,
        })
        .collect()
}

/// A cookie path is accepted only if it is already saved, or was just chosen by the user in
/// the native file picker (`btc_core_pick_cookie`): the interface cannot point Kyro at any
/// other file.
pub(crate) fn check_cookie_paths(
    new: &Servers,
    saved: &Servers,
    picked: Option<&str>,
) -> AppResult<()> {
    let known = cookie_paths(saved);
    for p in cookie_paths(new) {
        if !known.contains(&p) && picked != Some(p) {
            return Err(AppError::ServerInvalid(
                "fichier .cookie : choisis-le avec le bouton « Choisir le fichier .cookie »".into(),
            ));
        }
    }
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedCookie {
    /// Path of the file the user chose (theirs to see; it is a `.cookie` that passed the
    /// checks). `null` when the picker was cancelled.
    pub path: Option<String>,
}

/// Opens the system file picker (owned by Rust, not the webview) to choose Bitcoin Core's
/// `.cookie`. The file must pass the same checks as on every request (name `.cookie`, no
/// symlink, <= 256 bytes, `__cookie__:<64 hex>`); it then becomes the one new cookie path
/// that `settings_set` / `server_test` accept.
#[tauri::command]
pub async fn btc_core_pick_cookie(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> AppResult<PickedCookie> {
    use tauri_plugin_dialog::DialogExt as _;
    let handle = app.clone();
    let title = crate::i18n::current().pick(
        "Fichier .cookie de ton nœud Bitcoin Core",
        "The .cookie file of your Bitcoin Core node",
    );
    let picked = crate::commands::blocking(move || {
        Ok(handle.dialog().file().set_title(title).blocking_pick_file())
    })
    .await?;
    let Some(file) = picked else {
        return Ok(PickedCookie { path: None });
    };
    let path = file
        .into_path()
        .map_err(|_| AppError::ServerInvalid("fichier .cookie : chemin local attendu".into()))?
        .to_string_lossy()
        .into_owned();
    crate::servers::read_cookie(&path)?;
    state.set_picked_cookie(Some(path.clone()));
    Ok(PickedCookie { path: Some(path) })
}

// ---------------------------------------------------------------- settings

#[tauri::command]
pub fn settings_get(state: State<'_, AppState>) -> Value {
    state.settings().for_ui()
}

/// Validates (syntax, then a live check of every changed server: network/chain must match),
/// saves, and starts/stops Tor. Every new custom server host and Tor going off are confirmed
/// in a native dialog first (`USER_REJECTED` if refused). Errors: `SERVER_INVALID`,
/// `SERVER_WRONG_NETWORK`, `SERVER_UNREACHABLE`, `TOR_UNAVAILABLE`, `INVALID_INPUT`,
/// `USER_REJECTED`.
#[tauri::command]
pub async fn settings_set(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    settings: Value,
) -> AppResult<Value> {
    let old = state.settings();
    // A caller that does not know `servers` yet (older UI) must not wipe them.
    let has_servers = settings.get("servers").is_some();
    // `apiKeys` is a patch (absent = unchanged, "" = removed); keys are never sent to the UI.
    let mut new = Settings::from_ui(settings, &old.api_keys)?;
    if !has_servers {
        new.servers = old.servers.clone();
    }
    new.migrate_legacy_rpc(state.network);
    new.servers.merge_secrets_from(&old.servers);
    new.validate()?;
    check_cookie_paths(&new.servers, &old.servers, state.picked_cookie().as_deref())?;
    // Native confirmations BEFORE any request: Tor going off, then every new server host.
    if old.tor.enabled && !new.tor.enabled {
        confirm_tor_off(&app).await?;
    }
    confirm_endpoints(&app, &endpoints(&new.servers), &old.servers).await?;
    probe_changes(&state.net, &new.servers, &old.servers, new.tor.enabled).await?;
    let saved = state.save_settings(new)?;
    match (old.tor.enabled, saved.tor.enabled) {
        (false, true) => state.net.tor.start(),
        (true, false) => state.net.tor.stop(),
        _ => {}
    }
    Ok(saved.for_ui())
}

// ---------------------------------------------------------------- connection test

#[derive(Debug, Deserialize)]
#[serde(
    tag = "family",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ServerTestTarget {
    Bitcoin {
        network: String,
        server: BtcServer,
    },
    /// `network`: `mainnet` | `testnet` (Litecoin testnet4).
    Litecoin {
        network: String,
        server: UtxoServer,
    },
    /// `network`: `mainnet` | `testnet`.
    Dogecoin {
        network: String,
        server: UtxoServer,
    },
    /// `network`: `mainnet` | `testnet` (Nile).
    Tron {
        network: String,
        server: TronServer,
    },
    /// `network`: `mainnet` | `testnet` (XRPL Testnet).
    Xrp {
        network: String,
        server: XrpServer,
    },
    /// `network`: `mainnet` | `testnet` (preprod).
    Cardano {
        network: String,
        server: CardanoServer,
    },
    Evm {
        chain_id: u64,
        server: RpcServer,
    },
    Solana {
        cluster: String,
        server: RpcServer,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerTestResult {
    pub latency_ms: u64,
    pub detected: Detected,
}

/// Servers of a test target, in a `Servers` value (for validation and native approval).
fn probe_servers(target: &ServerTestTarget) -> AppResult<Servers> {
    let mut probe = Servers::default();
    match target {
        ServerTestTarget::Bitcoin { network, server } => {
            *match network_of(network)? {
                Network::Mainnet => &mut probe.bitcoin.mainnet,
                Network::Testnet => &mut probe.bitcoin.testnet4,
            } = Some(server.clone());
        }
        ServerTestTarget::Litecoin { network, server }
        | ServerTestTarget::Dogecoin { network, server } => {
            let coin = if matches!(target, ServerTestTarget::Litecoin { .. }) {
                UtxoCoin::Litecoin
            } else {
                UtxoCoin::Dogecoin
            };
            *match utxo_network_of(network)? {
                Network::Mainnet => &mut probe.utxo_mut(coin).mainnet,
                Network::Testnet => &mut probe.utxo_mut(coin).testnet,
            } = Some(server.clone());
        }
        ServerTestTarget::Tron { network, server } => {
            *match utxo_network_of(network)? {
                Network::Mainnet => &mut probe.tron.mainnet,
                Network::Testnet => &mut probe.tron.testnet,
            } = Some(server.clone());
        }
        ServerTestTarget::Xrp { network, server } => {
            *match utxo_network_of(network)? {
                Network::Mainnet => &mut probe.xrp.mainnet,
                Network::Testnet => &mut probe.xrp.testnet,
            } = Some(server.clone());
        }
        ServerTestTarget::Cardano { network, server } => {
            *match utxo_network_of(network)? {
                Network::Mainnet => &mut probe.cardano.mainnet,
                Network::Testnet => &mut probe.cardano.testnet,
            } = Some(server.clone());
        }
        ServerTestTarget::Evm { chain_id, server } => {
            probe.evm.insert(chain_id.to_string(), server.clone());
        }
        ServerTestTarget::Solana { cluster, server } => {
            probe.solana.insert(cluster.clone(), server.clone());
        }
    }
    Ok(probe)
}

/// Tests a server WITHOUT saving it (same checks as `settings_set`, including the native
/// approval of a new host, BEFORE any request). For a Core `userpass` entry sent without
/// `password`, the stored password of that slot is used.
#[tauri::command]
pub async fn server_test(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    target: ServerTestTarget,
) -> AppResult<ServerTestResult> {
    let settings = state.settings();
    let tor = settings.tor.enabled;
    {
        let mut probe = probe_servers(&target)?;
        probe.merge_secrets_from(&settings.servers);
        probe.validate(tor)?;
        check_cookie_paths(&probe, &settings.servers, state.picked_cookie().as_deref())?;
        confirm_endpoints(&app, &endpoints(&probe), &settings.servers).await?;
    }
    let started = Instant::now();
    let detected = match target {
        ServerTestTarget::Bitcoin { network, server } => {
            let net = network_of(&network)?;
            let mut probe = Servers::default();
            *match net {
                Network::Mainnet => &mut probe.bitcoin.mainnet,
                Network::Testnet => &mut probe.bitcoin.testnet4,
            } = Some(server);
            probe.merge_secrets_from(&settings.servers);
            probe.validate(tor)?;
            let s = probe.bitcoin_for(net);
            probe_btc(&state.net, net, &s, tor).await?
        }
        ServerTestTarget::Litecoin { network, server } => {
            probe_utxo(&state, UtxoCoin::Litecoin, &network, server, tor).await?
        }
        ServerTestTarget::Dogecoin { network, server } => {
            probe_utxo(&state, UtxoCoin::Dogecoin, &network, server, tor).await?
        }
        ServerTestTarget::Xrp { network, server } => {
            let net = utxo_network_of(&network)?;
            let mut probe = Servers::default();
            *match net {
                Network::Mainnet => &mut probe.xrp.mainnet,
                Network::Testnet => &mut probe.xrp.testnet,
            } = Some(server.clone());
            probe.validate(tor)?;
            crate::commands_xrp::probe(&state.net, net, &server, tor).await?
        }
        ServerTestTarget::Cardano { network, server } => {
            let net = utxo_network_of(&network)?;
            let mut probe = Servers::default();
            *match net {
                Network::Mainnet => &mut probe.cardano.mainnet,
                Network::Testnet => &mut probe.cardano.testnet,
            } = Some(server.clone());
            probe.validate(tor)?;
            crate::commands_cardano::probe(&state.net, net, &server, tor).await?
        }
        ServerTestTarget::Tron { network, server } => {
            let net = utxo_network_of(&network)?;
            let mut probe = Servers::default();
            *match net {
                Network::Mainnet => &mut probe.tron.mainnet,
                Network::Testnet => &mut probe.tron.testnet,
            } = Some(server.clone());
            probe.validate(tor)?;
            crate::commands_tron::probe(&state.net, net, &server, tor).await?
        }
        ServerTestTarget::Evm { chain_id, server } => {
            let mut probe = Servers::default();
            probe.evm.insert(chain_id.to_string(), server.clone());
            probe.validate(tor)?;
            probe_evm(&state.net, chain_id, &server, tor).await?
        }
        ServerTestTarget::Solana { cluster, server } => {
            let mut probe = Servers::default();
            probe.solana.insert(cluster.clone(), server.clone());
            probe.validate(tor)?;
            probe_solana(&state.net, &cluster, &server, tor).await?
        }
    };
    Ok(ServerTestResult {
        latency_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        detected,
    })
}

async fn probe_utxo(
    state: &AppState,
    coin: UtxoCoin,
    network: &str,
    server: UtxoServer,
    tor: bool,
) -> AppResult<Detected> {
    let net = utxo_network_of(network)?;
    if server.is_default() && !crate::servers::utxo_has_default(coin, net) {
        return Err(crate::utxo_backend::no_default_server(coin));
    }
    let mut probe = Servers::default();
    *match net {
        Network::Mainnet => &mut probe.utxo_mut(coin).mainnet,
        Network::Testnet => &mut probe.utxo_mut(coin).testnet,
    } = Some(server.clone());
    probe.validate(tor)?;
    crate::commands_utxo::probe(&state.net, net, coin, &server, tor).await
}

/// Fetches an Electrum server's TLS certificate fingerprint for the trust-on-first-use prompt.
/// The handshake is aborted right after the certificate is seen: nothing else is sent. A host
/// not saved nor approved yet is confirmed natively first (its name alone would leave).
#[tauri::command]
pub async fn electrum_fetch_cert(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    host: String,
    port: u16,
) -> AppResult<crate::electrum::CertInfo> {
    let tor = state.settings().tor.enabled;
    let host = host.trim().to_owned();
    if host.is_empty() || url::Host::parse(&host).is_err() || port == 0 {
        return Err(AppError::ServerInvalid(
            "hôte ou port Electrum invalide".into(),
        ));
    }
    if host.ends_with(".onion") && !tor {
        return Err(AppError::ServerInvalid(
            "adresse .onion : exige Tor activé".into(),
        ));
    }
    let endpoint = host_port_endpoint("Bitcoin (Electrum, lecture du certificat)", &host, port);
    confirm_endpoints(&app, &[endpoint], &state.settings().servers).await?;
    crate::electrum::fetch_certificate(&state.net, &host, port, tor).await
}

// ---------------------------------------------------------------- Bitcoin data (Esplora shapes)

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BtcBackendInfo {
    /// `default` | `esplora` | `electrum` | `core`
    pub kind: &'static str,
    /// `mainnet` | `testnet4`
    pub network: &'static str,
    /// Human label (host), never credentials.
    pub label: String,
    pub tor: bool,
}

#[tauri::command]
pub fn btc_backend_info(state: State<'_, AppState>) -> BtcBackendInfo {
    let s = state.settings();
    let server = s.servers.bitcoin_for(state.network);
    let label = match &server {
        BtcServer::Default => "mempool.space".to_owned(),
        BtcServer::Esplora { url } | BtcServer::Core { url, .. } => {
            crate::servers::host_of(url).unwrap_or_default()
        }
        BtcServer::Electrum { host, port, .. } => format!("{host}:{port}"),
        BtcServer::Cbf { .. } => "P2P (filtres compacts)".to_owned(),
    };
    BtcBackendInfo {
        kind: server.kind_name(),
        network: btc_network_key(state.network),
        label,
        tor: s.tor.enabled,
    }
}

#[tauri::command]
pub async fn btc_address_info(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    address: String,
) -> AppResult<Value> {
    if let Some(r) = cbf_read(&app, &state, "info", Some(&address)) {
        return r;
    }
    let s = state.settings();
    btc_backend::address_info(&ctx(&state, &s)?, &address).await
}

#[tauri::command]
pub async fn btc_address_utxos(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    address: String,
) -> AppResult<Value> {
    if let Some(r) = cbf_read(&app, &state, "utxos", Some(&address)) {
        return r;
    }
    let s = state.settings();
    btc_backend::address_utxos(&ctx(&state, &s)?, &address).await
}

#[tauri::command]
pub async fn btc_address_txs(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    address: String,
) -> AppResult<Value> {
    if let Some(r) = cbf_read(&app, &state, "txs", Some(&address)) {
        return r;
    }
    let s = state.settings();
    btc_backend::address_txs(&ctx(&state, &s)?, &address).await
}

#[tauri::command]
pub async fn btc_fee_rates(app: tauri::AppHandle, state: State<'_, AppState>) -> AppResult<Value> {
    if let Some(r) = cbf_read(&app, &state, "fees", None) {
        return r;
    }
    let s = state.settings();
    btc_backend::fee_rates(&ctx(&state, &s)?).await
}

#[tauri::command]
pub async fn btc_tip_height(app: tauri::AppHandle, state: State<'_, AppState>) -> AppResult<u64> {
    if let Some(r) = cbf_read(&app, &state, "tip", None) {
        return r.map(|v| v.as_u64().unwrap_or(0));
    }
    let s = state.settings();
    btc_backend::tip_height(&ctx(&state, &s)?).await
}

/// Raw transaction (hex) by txid from the configured Bitcoin backend, verified to hash to
/// `txid` (e.g. `non_witness_utxo` for hardware-wallet SegWit v0 spends).
#[tauri::command]
pub async fn btc_tx_hex(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    txid: String,
) -> AppResult<String> {
    if let Some(r) = cbf_read(&app, &state, "txhex", Some(&txid)) {
        return r.and_then(|v| {
            v.as_str()
                .map(str::to_owned)
                .ok_or_else(|| AppError::Internal("cbf : réponse inattendue".into()))
        });
    }
    let s = state.settings();
    btc_backend::tx_hex(&ctx(&state, &s)?, &txid).await
}

#[tauri::command]
pub async fn btc_broadcast(state: State<'_, AppState>, hex: String) -> AppResult<String> {
    if matches!(
        state.settings().servers.bitcoin_for(state.network),
        BtcServer::Cbf { .. }
    ) {
        #[cfg(not(feature = "cbf"))]
        return Err(cbf_disabled());
        #[cfg(feature = "cbf")]
        return crate::cbf::broadcast(state.net.tor.clone(), cbf_glue::params(&state)?, &hex).await;
    }
    let s = state.settings();
    btc_backend::broadcast(&ctx(&state, &s)?, &hex).await
}

// ---------------------------------------------------------------- Bitcoin Core wallet

#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum RescanFrom {
    /// `"now"`: no rescan (new wallet).
    Keyword(String),
    /// UNIX timestamp (seconds) of the wallet's first transaction (or earlier).
    Timestamp(u64),
}

fn core_settings(state: &AppState) -> AppResult<(String, crate::servers::CoreAuth, bool)> {
    let s = state.settings();
    match s.servers.bitcoin_for(state.network) {
        BtcServer::Core { url, auth } => Ok((url, auth, s.tor.enabled)),
        _ => Err(AppError::InvalidInput(
            "aucun nœud Bitcoin Core n'est configuré pour ce réseau".into(),
        )),
    }
}

/// Creates the watch-only wallet `kyro-watch-<fingerprint>` and imports the BIP84/BIP86
/// descriptors (public keys only). The pre-flight (node reachable, auth, chain, wallet
/// created/loaded, checksums) runs synchronously, so its errors come back from this call;
/// only `importdescriptors` and its rescan run in the background (poll `btc_core_status`).
/// Without a Core node configured: `INVALID_INPUT`.
#[tauri::command]
pub async fn btc_core_setup(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    rescan_from: RescanFrom,
) -> AppResult<btc_backend::CoreStatus> {
    let (url, auth, tor) = core_settings(&state)?;
    let timestamp = match rescan_from {
        RescanFrom::Keyword(k) if k == "now" => None,
        RescanFrom::Keyword(k) => {
            return Err(AppError::InvalidInput(format!(
                "rescanFrom : « now » ou un horodatage UNIX attendu (reçu « {k} »)"
            )))
        }
        RescanFrom::Timestamp(t) => Some(t),
    };
    let net = state.network;
    let fp = fingerprint(&state)?;
    // Every Bitcoin account of the user's list (an account added later needs a new setup).
    let accounts = state
        .settings()
        .accounts
        .indices(net, crate::accounts::Chain::Btc);
    let descriptors = state.with_seed(|seed| {
        let mut all = Vec::new();
        for a in accounts {
            all.extend(wallet_core::btc_descriptors(seed, net, a)?);
        }
        Ok(all)
    })?;
    let mut job =
        btc_backend::core_prepare(&state.net, net, &url, &auth, tor, &fp, &descriptors).await?;
    job.timestamp = timestamp;
    let wallet = job.wallet.clone();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let _ = btc_backend::core_import(&state.net, &url, &auth, tor, job).await;
    });
    Ok(btc_backend::CoreStatus {
        wallet,
        state: "importing".into(),
        wallet_loaded: true,
        ..Default::default()
    })
}

/// Status of the configured node's watch-only wallet; `state: "not-configured"` when no
/// Bitcoin Core node is set for the app's network.
#[tauri::command]
pub async fn btc_core_status(state: State<'_, AppState>) -> AppResult<btc_backend::CoreStatus> {
    let Ok((url, auth, tor)) = core_settings(&state) else {
        return Ok(btc_backend::core_not_configured());
    };
    let fp = fingerprint(&state)?;
    btc_backend::core_status(&state.net, state.network, &url, &auth, tor, &fp).await
}

// ---------------------------------------------------------------- compact block filters (feature `cbf`)

#[cfg(not(feature = "cbf"))]
fn cbf_disabled() -> AppError {
    AppError::FeatureDisabled(
        "filtres compacts (BIP157/158) : disponible après revue (>= 2026-11-11)".into(),
    )
}

#[cfg(feature = "cbf")]
mod cbf_glue {
    use super::*;
    use std::sync::Arc;
    use tauri::Emitter;

    /// Starts a background sync (no-op if one is running). Needs the unlocked session to read
    /// the account xpubs (public keys only).
    pub fn start_sync(app: &tauri::AppHandle, state: &AppState) -> AppResult<()> {
        let s = state.settings();
        let BtcServer::Cbf {
            peers,
            birth_height,
        } = s.servers.bitcoin_for(state.network)
        else {
            return Err(AppError::InvalidInput(
                "le serveur Bitcoin n'est pas en mode filtres compacts".into(),
            ));
        };
        if crate::cbf::is_running() {
            return Ok(());
        }
        let net = state.network;
        let (seg, tap) = state.with_seed(|seed| {
            Ok((
                wallet_core::btc_account(seed, net, BtcKind::Segwit, 0)?.xpub,
                wallet_core::btc_account(seed, net, BtcKind::Taproot, 0)?.xpub,
            ))
        })?;
        let watch = crate::cbf::WatchSet::from_xpubs(net, &seg, &tap)?;
        let params = crate::cbf::Params {
            network: net,
            tor: s.tor.enabled,
            peers: crate::cbf::peer_list(net, &peers)?,
            birth_height: birth_height.unwrap_or(0),
            data_dir: state.data_dir(),
        };
        let tor = state.net.tor.clone();
        let handle = app.clone();
        let emit: Arc<dyn Fn(&crate::cbf::CbfStatus) + Send + Sync> = Arc::new(move |st| {
            let _ = handle.emit("cbf-status", st);
        });
        tauri::async_runtime::spawn(async move {
            let _ = crate::cbf::sync(tor, params, watch, emit).await;
        });
        Ok(())
    }

    /// Background refresh when the data is older than two minutes (reads never block).
    pub fn refresh_if_stale(app: &tauri::AppHandle, state: &AppState) {
        let st = crate::cbf::status();
        let stale = st
            .last_sync_unix
            .is_none_or(|t| super::now_unix().saturating_sub(t) > 120);
        if stale && !crate::cbf::is_running() {
            let _ = start_sync(app, state);
        }
    }

    pub fn params(state: &AppState) -> AppResult<crate::cbf::Params> {
        let s = state.settings();
        let BtcServer::Cbf {
            peers,
            birth_height,
        } = s.servers.bitcoin_for(state.network)
        else {
            return Err(AppError::InvalidInput(
                "mode filtres compacts inactif".into(),
            ));
        };
        Ok(crate::cbf::Params {
            network: state.network,
            tor: s.tor.enabled,
            peers: crate::cbf::peer_list(state.network, &peers)?,
            birth_height: birth_height.unwrap_or(0),
            data_dir: state.data_dir(),
        })
    }
}

#[cfg_attr(not(feature = "cbf"), allow(dead_code))]
fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

/// Answers a Bitcoin read for the CBF backend from the local store (`None` = not CBF).
#[allow(unused_variables)]
fn cbf_read(
    app: &tauri::AppHandle,
    state: &AppState,
    what: &str,
    address: Option<&str>,
) -> Option<AppResult<Value>> {
    if !matches!(
        state.settings().servers.bitcoin_for(state.network),
        BtcServer::Cbf { .. }
    ) {
        return None;
    }
    #[cfg(not(feature = "cbf"))]
    {
        Some(Err(cbf_disabled()))
    }
    #[cfg(feature = "cbf")]
    {
        cbf_glue::refresh_if_stale(app, state);
        let dir = state.data_dir();
        let net = state.network;
        let r = match (what, address) {
            ("info", Some(a)) => crate::cbf::address_info(&dir, net, a),
            ("utxos", Some(a)) => crate::cbf::address_utxos(&dir, net, a),
            ("txs", Some(a)) => crate::cbf::address_txs(&dir, net, a),
            ("fees", _) => crate::cbf::fee_rates(&dir, net),
            ("tip", _) => crate::cbf::tip_height(&dir, net).map(|h| json!(h)),
            ("txhex", Some(t)) => crate::cbf::tx_hex(&dir, net, t).map(Value::String),
            _ => Err(AppError::Internal("cbf : requête inconnue".into())),
        };
        Some(r)
    }
}

/// Compact-filter sync state. `FEATURE_DISABLED` when the build has no `cbf` feature.
#[tauri::command]
pub fn btc_cbf_status(state: State<'_, AppState>) -> AppResult<Value> {
    let _ = &state;
    #[cfg(not(feature = "cbf"))]
    {
        Err(cbf_disabled())
    }
    #[cfg(feature = "cbf")]
    {
        let mut st = crate::cbf::status();
        if st.last_sync_unix.is_none() {
            let store =
                crate::cbf::Store::load(&crate::cbf::store_path(&state.data_dir(), state.network));
            st.tip_height = store.tip_height;
            st.scanned_height = store.scanned_to;
            st.last_sync_unix = store.last_sync_unix;
        }
        Ok(serde_json::to_value(st)?)
    }
}

/// Starts (or joins) a compact-filter sync in the background; progress via `cbf-status`.
#[tauri::command]
pub fn btc_cbf_sync(app: tauri::AppHandle, state: State<'_, AppState>) -> AppResult<Value> {
    let _ = (&app, &state);
    #[cfg(not(feature = "cbf"))]
    {
        Err(cbf_disabled())
    }
    #[cfg(feature = "cbf")]
    {
        cbf_glue::start_sync(&app, &state)?;
        Ok(serde_json::to_value(crate::cbf::status())?)
    }
}

/// Real-network probes over Tor (EVM chainId, Solana genesis, Esplora genesis). Run with
/// `cargo test -p kyro-desktop -- --ignored --nocapture probes_live`.
#[cfg(test)]
mod live {
    use super::*;
    use crate::tor::TorState;

    #[test]
    #[ignore]
    fn probes_live_over_tor() {
        let net = NetClient::new(std::env::temp_dir().join("kyro-probe-live")).unwrap();
        tauri::async_runtime::block_on(async {
            net.tor.restart();
            while net.tor.status().state != TorState::Ready {
                assert_ne!(net.tor.status().state, TorState::Error);
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            }
            let rpc = |u: &str| RpcServer { url: u.into() };
            let t = Instant::now();
            let d = probe_evm(
                &net,
                11_155_111,
                &rpc("https://ethereum-sepolia-rpc.publicnode.com"),
                true,
            )
            .await
            .unwrap();
            eprintln!("evm sepolia {d:?} in {:.1?}", t.elapsed());
            let e = probe_evm(
                &net,
                1,
                &rpc("https://ethereum-sepolia-rpc.publicnode.com"),
                true,
            )
            .await;
            assert!(matches!(e, Err(AppError::ServerWrongNetwork(_))), "{e:?}");

            let t = Instant::now();
            let d = probe_solana(&net, "devnet", &rpc("https://api.devnet.solana.com"), true)
                .await
                .unwrap();
            eprintln!("solana devnet {d:?} in {:.1?}", t.elapsed());
            let e = probe_solana(
                &net,
                "mainnet-beta",
                &rpc("https://api.devnet.solana.com"),
                true,
            )
            .await;
            assert!(
                matches!(e, Err(AppError::ServerWrongNetwork(ref m)) if m.contains("devnet")),
                "{e:?}"
            );

            let esplora = |u: &str| BtcServer::Esplora { url: u.into() };
            let t = Instant::now();
            let d = probe_btc(
                &net,
                Network::Testnet,
                &esplora("https://mempool.space/testnet4/api"),
                true,
            )
            .await
            .unwrap();
            eprintln!("esplora testnet4 {d:?} in {:.1?}", t.elapsed());
            let e = probe_btc(
                &net,
                Network::Testnet,
                &esplora("https://mempool.space/api"),
                true,
            )
            .await;
            assert!(matches!(e, Err(AppError::ServerWrongNetwork(_))), "{e:?}");
            // Unreachable custom server: typed error, no fallback.
            let e = probe_evm(&net, 1, &rpc("https://kyro-does-not-exist.invalid"), true).await;
            assert!(matches!(e, Err(AppError::ServerUnreachable(_))), "{e:?}");
        });
    }
}
