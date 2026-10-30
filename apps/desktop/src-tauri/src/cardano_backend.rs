//! Cardano data from a Koios REST instance (default: the free, keyless public tier of
//! `preprod.koios.rest` / `api.koios.rest`), on the `cardano` Tor family, never with a fallback.
//!
//! Kyro builds every transaction itself from the live UTxO set and protocol parameters
//! (`min_fee_a`, `min_fee_b`, `coins_per_utxo_size`, `max_tx_size`) with wallet-core's encoder;
//! a server-built transaction is never signed. Network check: genesis `networkmagic`.

use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::{json, Value};
use wallet_core::{CardanoAssets, CardanoBody, CardanoInput, CardanoOutput, Network};

use crate::btc_backend::Detected;
use crate::error::{AppError, AppResult};
use crate::net::{Family, NetClient, ServerRequest};
use crate::servers::{
    cardano_default_url, cardano_network_magic, validate_http_url, CardanoServer,
};

/// TTL = current slot + this (1 slot = 1 s on preprod and mainnet: one hour).
pub const TTL_OFFSET: u64 = 3600;
const MAX_TXS: usize = 20;
/// Inputs used at most by one transaction (each input adds ~37 bytes).
const MAX_INPUTS: usize = 100;

pub struct CardanoCtx<'a> {
    pub net_client: &'a NetClient,
    pub network: Network,
    pub tor: bool,
    pub server: CardanoServer,
}

fn bad(msg: impl Into<String>) -> AppError {
    AppError::ServerUnreachable(msg.into())
}

pub fn url(ctx: &CardanoCtx<'_>) -> AppResult<String> {
    Ok(match &ctx.server {
        CardanoServer::Default => cardano_default_url(ctx.network).to_owned(),
        CardanoServer::Koios { url } => {
            validate_http_url(url, ctx.tor, false)?;
            url.trim().trim_end_matches('/').to_owned()
        }
    })
}

fn endpoint(ctx: &CardanoCtx<'_>, path: &str) -> AppResult<url::Url> {
    url::Url::parse(&format!("{}{path}", url(ctx)?))
        .map_err(|_| AppError::ServerInvalid("URL Koios invalide".into()))
}

fn snippet(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).chars().take(200).collect()
}

async fn call(ctx: &CardanoCtx<'_>, path: &str, body: Option<Value>) -> AppResult<Value> {
    let u = endpoint(ctx, path)?;
    let req = match body {
        None => ServerRequest::get(u, Family::Cardano),
        Some(b) => ServerRequest::post_json(u, Family::Cardano, b.to_string()),
    };
    let (status, bytes) = ctx.net_client.server_request(req, ctx.tor).await?;
    if status != 200 {
        return Err(bad(format!(
            "Koios : HTTP {status} sur {path} ({})",
            snippet(&bytes)
        )));
    }
    serde_json::from_slice(&bytes).map_err(|_| bad(format!("Koios : JSON invalide sur {path}")))
}

fn first(v: &Value, what: &str) -> AppResult<Value> {
    v.as_array()
        .and_then(|a| a.first())
        .cloned()
        .ok_or_else(|| bad(format!("Koios : réponse vide ({what})")))
}

/// Koios returns some numbers as strings, others as JSON numbers.
fn num(v: &Value) -> Option<u64> {
    match v {
        Value::String(s) => s.parse().ok(),
        Value::Number(n) => n.as_u64(),
        _ => None,
    }
}

// ---------------------------------------------------------------- chain state

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Tip {
    pub slot: u64,
    pub block_height: u64,
    pub epoch: u64,
}

pub async fn tip(ctx: &CardanoCtx<'_>) -> AppResult<Tip> {
    let t = first(&call(ctx, "/tip", None).await?, "tip")?;
    Ok(Tip {
        slot: num(&t["abs_slot"]).ok_or_else(|| bad("Koios : abs_slot absent"))?,
        block_height: num(&t["block_height"]).or(num(&t["block_no"])).unwrap_or(0),
        epoch: num(&t["epoch_no"]).unwrap_or(0),
    })
}

/// Protocol parameters used by Kyro's builder.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Params {
    /// Lovelace per byte of transaction.
    pub min_fee_a: u64,
    /// Constant lovelace per transaction.
    pub min_fee_b: u64,
    /// `coinsPerUTxOByte`.
    pub coins_per_byte: u64,
    pub max_tx_size: u64,
}

impl Params {
    pub fn min_fee(&self, size: usize) -> u64 {
        self.min_fee_a
            .saturating_mul(size as u64)
            .saturating_add(self.min_fee_b)
    }
}

pub async fn params(ctx: &CardanoCtx<'_>) -> AppResult<Params> {
    let p = first(
        &call(
            ctx,
            "/epoch_params?limit=1&select=epoch_no,min_fee_a,min_fee_b,coins_per_utxo_size,max_tx_size",
            None,
        )
        .await?,
        "epoch_params",
    )?;
    let get = |k: &str| num(&p[k]).ok_or_else(|| bad(format!("Koios : {k} absent")));
    let out = Params {
        min_fee_a: get("min_fee_a")?,
        min_fee_b: get("min_fee_b")?,
        coins_per_byte: get("coins_per_utxo_size")?,
        max_tx_size: get("max_tx_size")?,
    };
    // Sanity bounds: a hostile server must not make Kyro pay absurd fees silently (the fee is
    // also shown in the dialog). Current values: 44 / 155 381 / 4 310 / 16 384.
    if out.min_fee_a > 1_000
        || out.min_fee_b > 10_000_000
        || out.coins_per_byte == 0
        || out.coins_per_byte > 100_000
        || !(1_024..=65_536).contains(&out.max_tx_size)
    {
        return Err(bad(format!(
            "Koios : paramètres de protocole invraisemblables ({out:?})"
        )));
    }
    Ok(out)
}

/// Network check: genesis `networkmagic` (preprod 1, mainnet 764824073; preview 2 is refused).
pub async fn probe(ctx: &CardanoCtx<'_>) -> AppResult<Detected> {
    let g = first(&call(ctx, "/genesis", None).await?, "genesis")?;
    let magic = num(&g["networkmagic"]).ok_or_else(|| bad("Koios : networkmagic absent"))?;
    let want = cardano_network_magic(ctx.network);
    if magic != want {
        let name = |m: u64| match m {
            764_824_073 => "mainnet".to_owned(),
            1 => "preprod".to_owned(),
            2 => "preview".to_owned(),
            other => format!("réseau magic {other}"),
        };
        return Err(AppError::ServerWrongNetwork(format!(
            "ce serveur Cardano est sur {}, pas sur {}",
            name(magic),
            name(want)
        )));
    }
    let t = tip(ctx).await?;
    Ok(Detected {
        network: Some(if want == 1 { "preprod" } else { "mainnet" }.into()),
        chain_id: Some(magic),
        block_height: Some(t.block_height),
        ..Default::default()
    })
}

// ---------------------------------------------------------------- UTxOs, account, history

/// `(policy hex, asset name hex)` → quantity.
pub type AssetMap = BTreeMap<(String, String), u64>;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Utxo {
    pub tx_hash: String,
    pub index: u64,
    pub lovelace: u64,
    pub assets: AssetMap,
}

fn assets_of(list: &Value) -> AppResult<AssetMap> {
    let mut out = AssetMap::new();
    for a in list.as_array().into_iter().flatten() {
        let policy = a["policy_id"].as_str().unwrap_or("").to_ascii_lowercase();
        let name = a["asset_name"].as_str().unwrap_or("").to_ascii_lowercase();
        let q = num(&a["quantity"]).ok_or_else(|| bad("Koios : quantité de token invalide"))?;
        if policy.len() != 56 || hex::decode(&policy).is_err() || hex::decode(&name).is_err() {
            return Err(bad("Koios : token invalide"));
        }
        *out.entry((policy, name)).or_default() += q;
    }
    Ok(out)
}

/// Unspent outputs of `address` (validated as ours or a payment address of this network).
pub async fn utxos(ctx: &CardanoCtx<'_>, address: &str) -> AppResult<Vec<Utxo>> {
    wallet_core::cardano_address_bytes(address, ctx.network)?;
    let v = call(
        ctx,
        "/address_utxos",
        Some(json!({ "_addresses": [address.trim()], "_extended": true })),
    )
    .await?;
    let mut out = Vec::new();
    for u in v.as_array().into_iter().flatten() {
        if u["is_spent"] == true || u["address"].as_str() != Some(address.trim()) {
            continue;
        }
        let tx_hash = u["tx_hash"].as_str().unwrap_or("").to_ascii_lowercase();
        if tx_hash.len() != 64 || hex::decode(&tx_hash).is_err() {
            return Err(bad("Koios : tx_hash invalide"));
        }
        out.push(Utxo {
            tx_hash,
            index: num(&u["tx_index"]).ok_or_else(|| bad("Koios : tx_index absent"))?,
            lovelace: num(&u["value"]).ok_or_else(|| bad("Koios : valeur absente"))?,
            assets: assets_of(&u["asset_list"])?,
        });
    }
    Ok(out)
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TokenBalance {
    pub policy: String,
    pub name: String,
    pub name_text: Option<String>,
    pub quantity: String,
    /// In Kyro's verified table (`verified_tokens`).
    pub verified: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ticker: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decimals: Option<u8>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CardanoAccount {
    pub address: String,
    /// Lovelace, decimal string.
    pub balance: String,
    pub tokens: Vec<TokenBalance>,
    pub utxo_count: usize,
    /// ADA that the tokens tie up (sum over UTxOs carrying tokens of their min-UTxO), i.e.
    /// lovelace that cannot leave without the tokens.
    pub locked_with_tokens: String,
}

/// Verified tokens shown by name without a reinforced confirmation:
/// `(policy, asset name hex, ticker, decimals)`. Checked against Koios mainnet `asset_info`
/// (Cardano token registry metadata) on 2026-10-30. None on preprod.
pub const VERIFIED_MAINNET: &[(&str, &str, &str, u8)] = &[
    (
        "8db269c3ec630e06ae29f74bc39edd1f87c819f1056206e879a1cd61",
        "446a65644d6963726f555344",
        "DJED",
        6,
    ),
    (
        "c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad",
        "0014df105553444d",
        "USDM",
        6,
    ),
    (
        "f66d78b4a3cb3d37afa0ec36461e51ecbde00f26c8f0a68f94b69880",
        "69555344",
        "iUSD",
        6,
    ),
];

pub fn verified_tokens(net: Network) -> Vec<(&'static str, &'static str)> {
    match net {
        Network::Mainnet => VERIFIED_MAINNET
            .iter()
            .map(|(p, n, _, _)| (*p, *n))
            .collect(),
        Network::Testnet => Vec::new(),
    }
}

fn verified_entry(net: Network, policy: &str, name: &str) -> Option<(&'static str, u8)> {
    if net != Network::Mainnet {
        return None;
    }
    VERIFIED_MAINNET
        .iter()
        .find(|(p, n, _, _)| *p == policy && *n == name)
        .map(|(_, _, t, d)| (*t, *d))
}

pub fn printable(name_hex: &str) -> Option<String> {
    hex::decode(name_hex)
        .ok()
        .and_then(|b| String::from_utf8(b).ok())
        .filter(|t| !t.is_empty() && t.chars().all(|c| !c.is_control()))
}

pub fn account_of(
    net: Network,
    address: &str,
    utxos: &[Utxo],
    coins_per_byte: u64,
) -> AppResult<CardanoAccount> {
    let addr = wallet_core::cardano_address_bytes(address, net)?;
    let mut balance = 0u64;
    let mut tokens = AssetMap::new();
    let mut locked = 0u64;
    for u in utxos {
        balance = balance.saturating_add(u.lovelace);
        for (k, q) in &u.assets {
            *tokens.entry(k.clone()).or_default() += q;
        }
        if !u.assets.is_empty() {
            locked += wallet_core::cardano_min_utxo(&addr, &to_assets(&u.assets)?, coins_per_byte);
        }
    }
    Ok(CardanoAccount {
        address: address.trim().to_owned(),
        balance: balance.to_string(),
        tokens: tokens
            .into_iter()
            .map(|((policy, name), q)| {
                let v = verified_entry(net, &policy, &name);
                TokenBalance {
                    name_text: printable(&name),
                    quantity: q.to_string(),
                    verified: v.is_some(),
                    ticker: v.map(|x| x.0),
                    decimals: v.map(|x| x.1),
                    policy,
                    name,
                }
            })
            .collect(),
        utxo_count: utxos.len(),
        locked_with_tokens: locked.min(balance).to_string(),
    })
}

/// Last 20 transactions touching `address`, normalized:
/// `[{ hash, time, blockHeight, fee, lovelaceDelta, tokenDeltas: [{policy, name, delta}], memo }]`
/// (`lovelaceDelta` = received − spent by this address, signed decimal string).
pub async fn txs(ctx: &CardanoCtx<'_>, address: &str) -> AppResult<Value> {
    wallet_core::cardano_address_bytes(address, ctx.network)?;
    let me = address.trim();
    let list = call(ctx, "/address_txs", Some(json!({ "_addresses": [me] }))).await?;
    // Koios lists oldest first: keep the most recent ones.
    let mut all: Vec<(u64, String)> = list
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|t| {
            t["tx_hash"]
                .as_str()
                .map(|h| (num(&t["block_height"]).unwrap_or(u64::MAX), h.to_owned()))
        })
        .collect();
    all.sort_by(|a, b| b.cmp(a));
    let hashes: Vec<String> = all.into_iter().take(MAX_TXS).map(|(_, h)| h).collect();
    if hashes.is_empty() {
        return Ok(json!([]));
    }
    let info = call(
        ctx,
        "/tx_info",
        Some(json!({
            "_tx_hashes": hashes, "_inputs": true, "_metadata": true, "_assets": true,
            "_withdrawals": false, "_certs": false, "_scripts": false, "_bytecode": false
        })),
    )
    .await?;
    let mut out = Vec::new();
    for t in info.as_array().into_iter().flatten() {
        let mut delta: i128 = 0;
        let mut tok: BTreeMap<(String, String), i128> = BTreeMap::new();
        for (side, sign) in [("outputs", 1i128), ("inputs", -1i128)] {
            for o in t[side].as_array().into_iter().flatten() {
                if o["payment_addr"]["bech32"].as_str() != Some(me) {
                    continue;
                }
                delta += sign * i128::from(num(&o["value"]).unwrap_or(0));
                for ((p, n), q) in assets_of(&o["asset_list"]).unwrap_or_default() {
                    *tok.entry((p, n)).or_default() += sign * i128::from(q);
                }
            }
        }
        let memo = t["metadata"]["674"]["msg"].as_array().map(|l| {
            l.iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .concat()
        });
        out.push(json!({
            "hash": t["tx_hash"], "time": num(&t["tx_timestamp"]).map(|s| s * 1000),
            "blockHeight": t["block_height"], "fee": t["fee"],
            "lovelaceDelta": delta.to_string(),
            "tokenDeltas": tok.into_iter().filter(|(_, d)| *d != 0)
                .map(|((p, n), d)| json!({ "policy": p, "name": n, "nameText": printable(&n), "delta": d.to_string() }))
                .collect::<Vec<_>>(),
            "memo": memo,
        }));
    }
    out.sort_by_key(|t| std::cmp::Reverse(t["blockHeight"].as_u64().unwrap_or(u64::MAX)));
    Ok(Value::Array(out))
}

/// Confirmations of a transaction (`None`: unknown to the indexer yet).
pub async fn tx_status(ctx: &CardanoCtx<'_>, hash: &str) -> AppResult<Option<u64>> {
    let v = call(ctx, "/tx_status", Some(json!({ "_tx_hashes": [hash] }))).await?;
    Ok(v.as_array()
        .and_then(|a| a.first())
        .and_then(|t| num(&t["num_confirmations"])))
}

/// `submittx` (raw CBOR, `application/cbor`). The returned transaction id must be ours.
pub async fn submit(ctx: &CardanoCtx<'_>, tx_cbor: Vec<u8>, tx_id: &str) -> AppResult<String> {
    let u = endpoint(ctx, "/submittx")?;
    let req = ServerRequest::post_bytes(u, Family::Cardano, "application/cbor", tx_cbor);
    let (status, bytes) = ctx.net_client.server_request(req, ctx.tor).await?;
    if !(200..300).contains(&status) {
        return Err(AppError::InvalidInput(format!(
            "transaction Cardano refusée par le nœud : HTTP {status} ({})",
            snippet(&bytes)
        )));
    }
    let got = String::from_utf8_lossy(&bytes)
        .trim()
        .trim_matches('"')
        .to_ascii_lowercase();
    if got != tx_id {
        return Err(bad(format!(
            "le serveur a répondu un identifiant inattendu ({})",
            got.chars().take(80).collect::<String>()
        )));
    }
    Ok(got)
}

// ---------------------------------------------------------------- building

fn to_assets(m: &AssetMap) -> AppResult<CardanoAssets> {
    let mut by_policy: BTreeMap<[u8; 28], Vec<(Vec<u8>, u64)>> = BTreeMap::new();
    for ((p, n), q) in m {
        if *q == 0 {
            continue;
        }
        let policy: [u8; 28] = hex::decode(p)
            .ok()
            .and_then(|b| b.try_into().ok())
            .ok_or_else(|| AppError::InvalidInput("policy id : 28 octets hex".into()))?;
        let name = hex::decode(n).map_err(|_| AppError::InvalidInput("nom d'asset hex".into()))?;
        by_policy.entry(policy).or_default().push((name, *q));
    }
    Ok(by_policy
        .into_iter()
        .map(|(p, mut names)| {
            // Canonical CBOR map order: shorter keys first, then bytewise.
            names.sort_by(|a, b| (a.0.len(), &a.0).cmp(&(b.0.len(), &b.0)));
            (p, names)
        })
        .collect())
}

/// What the user asked to send.
#[derive(Debug, Clone)]
pub struct PaymentSpec {
    /// Recipient address bytes (validated by `cardano_address_bytes`).
    pub to: Vec<u8>,
    /// Lovelace; `None` with a token = the minimum the output needs (min-UTxO).
    pub lovelace: Option<u64>,
    /// `(policy hex, asset name hex, quantity)`.
    pub token: Option<(String, String, u64)>,
    pub memo: Option<String>,
}

/// Result of the builder: body and CIP-20 auxiliary data.
#[derive(Debug, Clone)]
pub struct Plan {
    pub body: CardanoBody,
    pub aux: Option<Vec<u8>>,
}

fn insufficient(msg: String) -> AppError {
    AppError::InvalidInput(msg)
}

/// Kyro's builder: coin selection (UTxOs carrying the requested token first, then ADA-only
/// UTxOs by decreasing value, token-carrying ones last), one recipient output, one change output
/// to `change` carrying every leftover token, fee = `min_fee_a × size + min_fee_b` iterated on the
/// signed size (one vkey witness), each output at or above its min-UTxO.
pub fn plan(
    utxos: &[Utxo],
    change: &[u8],
    spec: &PaymentSpec,
    p: &Params,
    ttl: u64,
) -> AppResult<Plan> {
    let mut send = AssetMap::new();
    if let Some((pol, name, q)) = &spec.token {
        if *q == 0 {
            return Err(AppError::InvalidInput("quantité de token nulle".into()));
        }
        send.insert((pol.to_ascii_lowercase(), name.to_ascii_lowercase()), *q);
    }
    let send_assets = to_assets(&send)?;
    let min_to = wallet_core::cardano_min_utxo(&spec.to, &send_assets, p.coins_per_byte);
    let coin = match spec.lovelace {
        Some(c) if c < min_to => {
            return Err(AppError::InvalidInput(format!(
                "montant trop faible : cette sortie doit porter au moins {} ADA (min-UTxO{})",
                crate::commands::format_units(&min_to.to_string(), 6),
                if send.is_empty() {
                    ""
                } else {
                    ", avec le token"
                }
            )))
        }
        Some(c) => c,
        None if !send.is_empty() => min_to,
        None => return Err(AppError::InvalidInput("montant ADA manquant".into())),
    };
    let aux = spec
        .memo
        .as_deref()
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .map(wallet_core::cardano_cip20_aux)
        .transpose()?;

    let wanted = send.keys().next().cloned();
    let mut order: Vec<&Utxo> = utxos.iter().collect();
    order.sort_by_key(|u| {
        let has_wanted = wanted.as_ref().is_some_and(|k| u.assets.contains_key(k));
        (
            !has_wanted,
            !u.assets.is_empty(),
            std::cmp::Reverse(u.lovelace),
        )
    });

    let mut chosen: Vec<&Utxo> = Vec::new();
    let mut last_err = None;
    for u in order {
        if chosen.len() >= MAX_INPUTS {
            break;
        }
        chosen.push(u);
        match finish(&chosen, change, spec, &send, coin, p, ttl, aux.as_deref()) {
            Ok(body) => return Ok(Plan { body, aux }),
            Err(e) => last_err = Some(e),
        }
    }
    Err(last_err.unwrap_or_else(|| insufficient("aucun UTxO : adresse vide".into())))
}

#[allow(clippy::too_many_arguments)]
fn finish(
    chosen: &[&Utxo],
    change: &[u8],
    spec: &PaymentSpec,
    send: &AssetMap,
    coin: u64,
    p: &Params,
    ttl: u64,
    aux: Option<&[u8]>,
) -> AppResult<CardanoBody> {
    let aux_hash = aux.map(wallet_core::cardano_blake2b256);
    let mut in_coin = 0u64;
    let mut left = AssetMap::new();
    for u in chosen {
        in_coin = in_coin.saturating_add(u.lovelace);
        for (k, q) in &u.assets {
            *left.entry(k.clone()).or_default() += q;
        }
    }
    for (k, q) in send {
        let have = left.get(k).copied().unwrap_or(0);
        if have < *q {
            return Err(insufficient(format!(
                "token insuffisant : {have} disponible(s), {q} demandé(s)"
            )));
        }
        left.insert(k.clone(), have - q);
    }
    let change_assets = to_assets(&left)?;
    let mut inputs = chosen
        .iter()
        .map(|u| {
            let tx_hash: [u8; 32] = hex::decode(&u.tx_hash)
                .ok()
                .and_then(|b| b.try_into().ok())
                .ok_or_else(|| AppError::Internal("tx_hash d'UTxO invalide".into()))?;
            Ok(CardanoInput {
                tx_hash,
                index: u.index,
            })
        })
        .collect::<AppResult<Vec<_>>>()?;
    inputs.sort();
    let to_out = CardanoOutput {
        address: spec.to.clone(),
        coin,
        assets: to_assets(send)?,
        map_form: false,
    };
    let min_change = wallet_core::cardano_min_utxo(change, &change_assets, p.coins_per_byte);
    let mut fee = p.min_fee_b;
    for _ in 0..6 {
        let need = coin.saturating_add(fee);
        let Some(rest) = in_coin.checked_sub(need) else {
            return Err(insufficient(format!(
                "solde insuffisant : {} ADA en entrée, il faut {} ADA (montant + frais)",
                crate::commands::format_units(&in_coin.to_string(), 6),
                crate::commands::format_units(&need.to_string(), 6)
            )));
        };
        if rest < min_change {
            return Err(insufficient(format!(
                "la monnaie rendue ({} ADA) serait sous son minimum de {} ADA (min-UTxO) : envoie un peu moins",
                crate::commands::format_units(&rest.to_string(), 6),
                crate::commands::format_units(&min_change.to_string(), 6)
            )));
        }
        let body = CardanoBody {
            inputs: inputs.clone(),
            tagged_sets: true,
            outputs: vec![
                to_out.clone(),
                CardanoOutput {
                    address: change.to_vec(),
                    coin: rest,
                    assets: change_assets.clone(),
                    map_form: false,
                },
            ],
            fee,
            ttl: Some(ttl),
            aux_hash,
            validity_start: None,
        };
        let size = wallet_core::cardano_signed_size(&body, aux, 1)?;
        if size as u64 > p.max_tx_size {
            return Err(AppError::InvalidInput(format!(
                "transaction trop grande ({size} octets, maximum {})",
                p.max_tx_size
            )));
        }
        let req = p.min_fee(size);
        if fee >= req {
            return Ok(body);
        }
        // Next pass: new fee, new change (and its min-UTxO is re-checked).
        fee = req;
    }
    Err(AppError::Internal(
        "calcul des frais Cardano instable".into(),
    ))
}

/// Live balance check before signing: every input is one of our unspent UTxOs, and
/// inputs = outputs + fee, lovelace and every token (no mint, no deposit, no withdrawal are
/// possible in what wallet-core accepts). Returns the lovelace leaving the wallet (outputs to
/// other addresses + fee).
pub fn check_balance(body: &CardanoBody, ours: &[Utxo], own_address: &[u8]) -> AppResult<u64> {
    let mut in_coin = 0u64;
    let mut in_assets = AssetMap::new();
    for i in &body.inputs {
        let h = hex::encode(i.tx_hash);
        let u = ours
            .iter()
            .find(|u| u.tx_hash == h && u.index == i.index)
            .ok_or_else(|| {
                AppError::InvalidInput(format!(
                    "entrée {h}#{} inconnue ou déjà dépensée : reconstruis la transaction",
                    i.index
                ))
            })?;
        in_coin = in_coin.saturating_add(u.lovelace);
        for (k, q) in &u.assets {
            *in_assets.entry(k.clone()).or_default() += q;
        }
    }
    let mut out_coin = body.fee;
    let mut out_assets = AssetMap::new();
    let mut leaving = body.fee;
    for o in &body.outputs {
        out_coin = out_coin.saturating_add(o.coin);
        if o.address != own_address {
            leaving = leaving.saturating_add(o.coin);
        }
        for (p, names) in &o.assets {
            for (n, q) in names {
                *out_assets
                    .entry((hex::encode(p), hex::encode(n)))
                    .or_default() += q;
            }
        }
    }
    if in_coin != out_coin || in_assets != out_assets {
        return Err(AppError::InvalidInput(
            "transaction déséquilibrée (entrées ≠ sorties + frais) : refusée".into(),
        ));
    }
    Ok(leaving)
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
    const POL: &str = "95a292ffee938be03e9bae5657982a74e9014eb4960108c9e23a5b39";

    fn root() -> wallet_core::CardanoRoot {
        wallet_core::CardanoRoot::from_mnemonic(
            &wallet_core::Mnemonic::parse("all all all all all all all all all all all all")
                .unwrap(),
            "",
        )
    }

    fn me() -> (String, Vec<u8>) {
        let a = wallet_core::cardano_address(&root(), Network::Testnet, 0, 0).unwrap();
        let b = wallet_core::cardano_address_bytes(&a, Network::Testnet).unwrap();
        (a, b)
    }

    fn utxo(i: u8, lovelace: u64, tokens: &[(&str, u64)]) -> Utxo {
        Utxo {
            tx_hash: hex::encode([i; 32]),
            index: u64::from(i),
            lovelace,
            assets: tokens
                .iter()
                .map(|(n, q)| ((POL.to_owned(), (*n).to_owned()), *q))
                .collect(),
        }
    }

    fn sign_and_check(
        plan: &Plan,
        utxos: &[Utxo],
        own: &str,
        own_b: &[u8],
    ) -> wallet_core::CardanoTxSummary {
        let unsigned =
            hex::encode(wallet_core::cardano_unsigned_tx(&plan.body, plan.aux.as_deref()).unwrap());
        let ownv = [own.to_owned()];
        let ctx = wallet_core::CardanoContext {
            net: Network::Testnet,
            own: &ownv,
            verified_tokens: &[],
            coins_per_byte: P.coins_per_byte,
        };
        let (signed, id, s) = wallet_core::cardano_sign(&root(), 0, 0, &unsigned, &ctx).unwrap();
        assert_eq!(id, s.tx_id);
        // Fee covers the real signed size, and not by much.
        let fee: u64 = s.fee.parse().unwrap();
        let need = P.min_fee(signed.len() / 2);
        assert!(fee >= need && fee - need < 500, "fee {fee} need {need}");
        check_balance(&plan.body, utxos, own_b).unwrap();
        s
    }

    #[test]
    fn ada_payment_with_change_and_memo() {
        let (own, own_b) = me();
        let to = wallet_core::cardano_address_bytes(
            "addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgs68faae",
            Network::Testnet,
        )
        .unwrap();
        let utxos = vec![
            utxo(1, 3_000_000, &[]),
            utxo(2, 10_000_000, &[]),
            utxo(3, 2_000_000, &[("74", 5)]),
        ];
        let spec = PaymentSpec {
            to,
            lovelace: Some(4_000_000),
            token: None,
            memo: Some("merci".into()),
        };
        let plan = plan(&utxos, &own_b, &spec, &P, 1000).unwrap();
        // Largest ADA-only UTxO first; the token UTxO is left alone.
        assert_eq!(plan.body.inputs.len(), 1);
        assert_eq!(plan.body.inputs[0].tx_hash, [2; 32]);
        let s = sign_and_check(&plan, &utxos, &own, &own_b);
        assert_eq!(s.memo, Some(vec!["merci".to_string()]));
        assert!(s.outputs[1].is_change);
        assert_eq!(s.ttl, Some(1000));
    }

    #[test]
    fn token_payment_takes_min_ada_and_returns_other_tokens() {
        let (own, own_b) = me();
        let utxos = vec![
            utxo(1, 20_000_000, &[]),
            utxo(2, 1_500_000, &[("74", 10), ("75", 3)]),
        ];
        let spec = PaymentSpec {
            to: own_b.clone(),
            lovelace: None,
            token: Some((POL.into(), "74".into(), 4)),
            memo: None,
        };
        let plan = plan(&utxos, &own_b, &spec, &P, 1000).unwrap();
        assert_eq!(plan.body.inputs.len(), 2, "token UTxO first, then ADA");
        let s = sign_and_check(&plan, &utxos, &own, &own_b);
        let o = &s.outputs[0];
        assert_eq!(o.lovelace, o.min_lovelace, "min-ADA rides with the token");
        assert_eq!(o.tokens[0].quantity, "4");
        // Change keeps 6 × "74" and 3 × "75".
        let c = &s.outputs[1];
        assert_eq!(
            c.tokens
                .iter()
                .map(|t| t.quantity.as_str())
                .collect::<Vec<_>>(),
            ["6", "3"]
        );
        // Too little lovelace with a token: refused with the minimum.
        let low = PaymentSpec {
            lovelace: Some(1_000_000),
            ..spec.clone()
        };
        assert!(
            matches!(plan_err(&utxos, &own_b, &low), AppError::InvalidInput(m) if m.contains("au moins"))
        );
        // More tokens than held.
        let many = PaymentSpec {
            token: Some((POL.into(), "74".into(), 11)),
            ..spec
        };
        assert!(
            matches!(plan_err(&utxos, &own_b, &many), AppError::InvalidInput(m) if m.contains("token insuffisant"))
        );
    }

    fn plan_err(u: &[Utxo], c: &[u8], s: &PaymentSpec) -> AppError {
        plan(u, c, s, &P, 1000).unwrap_err()
    }

    #[test]
    fn insufficient_and_unbalanced() {
        let (_, own_b) = me();
        let utxos = vec![utxo(1, 2_000_000, &[])];
        let spec = PaymentSpec {
            to: own_b.clone(),
            lovelace: Some(1_000_000),
            token: None,
            memo: None,
        };
        // 2 ADA − 1 ADA − fee is below the change's min-UTxO (~0.97 ADA).
        assert!(
            matches!(plan_err(&utxos, &own_b, &spec), AppError::InvalidInput(m) if m.contains("min-UTxO"))
        );
        let spec = PaymentSpec {
            lovelace: Some(5_000_000),
            ..spec
        };
        assert!(
            matches!(plan_err(&utxos, &own_b, &spec), AppError::InvalidInput(m) if m.contains("insuffisant"))
        );
        assert!(plan(&[], &own_b, &spec, &P, 1).is_err());

        let ok = PaymentSpec {
            lovelace: Some(1_000_000),
            ..spec
        };
        let utxos = vec![utxo(1, 5_000_000, &[])];
        let mut p = plan(&utxos, &own_b, &ok, &P, 1).unwrap();
        // Spent / foreign input.
        assert!(check_balance(&p.body, &[utxo(9, 5_000_000, &[])], &own_b).is_err());
        // Outputs + fee ≠ inputs.
        p.body.fee += 1;
        assert!(check_balance(&p.body, &utxos, &own_b).is_err());
    }

    #[test]
    fn asset_numbers_from_koios() {
        let a = assets_of(&json!([
            { "policy_id": POL, "asset_name": "74", "quantity": "5" },
            { "policy_id": POL, "asset_name": "74", "quantity": 2 }
        ]))
        .unwrap();
        assert_eq!(a[&(POL.to_owned(), "74".to_owned())], 7);
        assert!(
            assets_of(&json!([{ "policy_id": "zz", "asset_name": "", "quantity": "1" }])).is_err()
        );
        assert_eq!(printable("524947454c").as_deref(), Some("RIGEL"));
        assert_eq!(printable("0014df10"), None);
    }
}

/// Real-network test on Cardano preprod over Tor. Run with
/// `cargo test -p kyro-desktop -- --ignored --nocapture ada_live`.
/// - keys: a NEW random test mnemonic, generated once and kept in the gitignored
///   `.env.cardano-testnet` at the repository root (preprod only);
/// - always: network checks (preprod, mainnet, wrong network), parameters, tip, our account, and
///   a dry build (no signature) from the UTxOs of the public CIP-19 test address;
/// - `KYRO_ADA_SEND=yes` and the address funded (faucet by hand: it has a captcha): one ADA
///   payment to our address #1 with a CIP-20 memo, then one native-token payment if we hold
///   one, through the real path (live checks, dialog text, signature with identical summary,
///   `submittx`, tx-id check, confirmation).
#[cfg(test)]
mod live {
    use super::*;
    use crate::tor::TorState;

    /// The public CIP-19 test vector address: it holds preprod ADA (read only, nobody here
    /// has its key).
    const CIP19_PREPROD: &str = "addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgs68faae";

    fn test_root() -> wallet_core::CardanoRoot {
        let path =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../.env.cardano-testnet");
        let words = match std::fs::read_to_string(&path) {
            Ok(s) => s
                .lines()
                .find_map(|l| l.strip_prefix("KYRO_ADA_TEST_MNEMONIC="))
                .expect("mnemonic line")
                .trim()
                .to_owned(),
            Err(_) => {
                let m = wallet_core::Mnemonic::generate(wallet_core::WordCount::W24).unwrap();
                let w = m.words().join(" ");
                std::fs::write(
                    &path,
                    format!("# CARDANO PREPROD ONLY - random test mnemonic generated by the Kyro live test (cardano_backend.rs).\n# Never use it for real funds. This file is gitignored (.env.*).\nKYRO_ADA_TEST_MNEMONIC={w}\n"),
                )
                .unwrap();
                eprintln!("new test mnemonic written to {}", path.display());
                w
            }
        };
        wallet_core::CardanoRoot::from_mnemonic(&wallet_core::Mnemonic::parse(&words).unwrap(), "")
    }

    async fn pay(
        c: &CardanoCtx<'_>,
        root: &wallet_core::CardanoRoot,
        me: &str,
        to: &str,
        lovelace: Option<&str>,
        token: Option<&crate::commands_cardano::TokenSpec>,
        memo: Option<&str>,
    ) -> String {
        let built = crate::commands_cardano::build(c, me, to, lovelace, token, memo)
            .await
            .unwrap();
        let (summary, context) = crate::commands_cardano::prepare_sign(c, me, &built.tx)
            .await
            .unwrap();
        assert_eq!(summary, built.summary);
        eprintln!(
            "--- dialog ---\n{}---",
            crate::commands_cardano::describe_ada(&summary, &context, Network::Testnet)
        );
        if summary.requires_extra_confirmation {
            eprintln!(
                "--- reinforced ---\n{}---",
                crate::commands_cardano::describe_ada_extra(&summary)
            );
        }
        let own = [me.to_owned()];
        let dctx = wallet_core::CardanoContext {
            net: Network::Testnet,
            own: &own,
            verified_tokens: &[],
            coins_per_byte: context.params.coins_per_byte,
        };
        let (signed, id, again) = wallet_core::cardano_sign(root, 0, 0, &built.tx, &dctx).unwrap();
        assert_eq!(again, summary, "identical summary");
        let pk = wallet_core::cardano_payment_public_key(root, 0, 0).unwrap();
        let got = crate::commands_cardano::broadcast_checked(c, &pk, &signed)
            .await
            .unwrap();
        assert_eq!(got, id);
        eprintln!("SUBMITTED {id} ({} bytes)", signed.len() / 2);
        for _ in 0..60 {
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            if let Some(n) = tx_status(c, &id).await.unwrap() {
                if n >= 1 {
                    eprintln!("confirmed: {n} confirmation(s)");
                    return id;
                }
            }
        }
        panic!("{id} not confirmed");
    }

    #[test]
    #[ignore]
    fn ada_live_preprod_over_tor() {
        let net = NetClient::new(std::env::temp_dir().join("kyro-ada-live")).unwrap();
        let root = test_root();
        let me = wallet_core::cardano_address(&root, Network::Testnet, 0, 0).unwrap();
        let a1 = wallet_core::cardano_address(&root, Network::Testnet, 0, 1).unwrap();
        eprintln!("addresses: {me} {a1}");
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
            let t = std::time::Instant::now();
            eprintln!("preprod probe {:?} in {:.1?}", probe(&c).await, t.elapsed());
            let main = CardanoCtx {
                net_client: &net,
                network: Network::Mainnet,
                tor: true,
                server: CardanoServer::Default,
            };
            eprintln!("mainnet probe {:?}", probe(&main).await);
            let wrong = CardanoCtx {
                net_client: &net,
                network: Network::Testnet,
                tor: true,
                server: CardanoServer::Koios {
                    url: "https://api.koios.rest/api/v1".into(),
                },
            };
            let e = probe(&wrong).await;
            eprintln!("wrong network: {e:?}");
            assert!(matches!(e, Err(AppError::ServerWrongNetwork(_))));
            let p = params(&c).await.unwrap();
            let tp = tip(&c).await.unwrap();
            eprintln!("params {p:?}\ntip {tp:?}");

            // Dry build from real UTxOs of the public CIP-19 address (not signed: no key).
            let built = crate::commands_cardano::build(
                &c,
                CIP19_PREPROD,
                &me,
                Some("1500000"),
                None,
                Some("Kyro dry run"),
            )
            .await;
            match built {
                Ok(b) => eprintln!(
                    "dry build OK: {} inputs, fee {}, unsigned size {} bytes, outputs {:?}",
                    b.summary.inputs.len(),
                    b.summary.fee,
                    b.tx.len() / 2,
                    b.summary
                        .outputs
                        .iter()
                        .map(|o| (
                            o.address.chars().take(24).collect::<String>(),
                            o.lovelace.clone()
                        ))
                        .collect::<Vec<_>>()
                ),
                Err(e) => eprintln!("dry build: {e:?}"),
            }
            eprintln!(
                "CIP-19 address history: {}",
                txs(&c, CIP19_PREPROD)
                    .await
                    .unwrap()
                    .to_string()
                    .chars()
                    .take(400)
                    .collect::<String>()
            );

            let u = utxos(&c, &me).await.unwrap();
            let acc = account_of(Network::Testnet, &me, &u, p.coins_per_byte).unwrap();
            eprintln!("our account {acc:?}");
            eprintln!("our history: {}", txs(&c, &me).await.unwrap());
            if std::env::var("KYRO_ADA_SEND").as_deref() != Ok("yes") || u.is_empty() {
                eprintln!("KYRO_ADA_SEND != yes or address not funded: no payment");
                return;
            }
            let h = pay(
                &c,
                &root,
                &me,
                &a1,
                Some("2000000"),
                None,
                Some("Kyro preprod test"),
            )
            .await;
            eprintln!("ADA PAYMENT: {h}");
            if let Some(t) = acc.tokens.first() {
                let spec = crate::commands_cardano::TokenSpec {
                    policy: t.policy.clone(),
                    name: t.name.clone(),
                    quantity: "1".into(),
                };
                let h = pay(&c, &root, &me, &a1, None, Some(&spec), None).await;
                eprintln!("TOKEN PAYMENT: {h}");
            } else {
                eprintln!("no native token held: no token payment");
            }
            eprintln!("recipient history: {}", txs(&c, &a1).await.unwrap());
        });
    }
}
