//! NEAR Protocol data from FastNEAR (JSON-RPC: `free.rpc.fastnear.com` / `test.rpc.fastnear.com`;
//! history: the FastNEAR explorer API `tx.main.fastnear.com` / `tx.test.fastnear.com`), on the
//! `near` Tor family, never with a fallback.
//!
//! Kyro fills the nonce (access key nonce + 1) and the block hash (the final block the access
//! key was read at) itself and encodes the transfer with wallet-core: nothing built by a server
//! is ever signed. Fees are not part of a NEAR transaction: they are charged at the gas price of
//! the block that includes it. Kyro computes the gas of a transfer from the live protocol
//! configuration (`EXPERIMENTAL_protocol_config`) and checks the balance against a **bound**
//! (twice the gas at the higher of the current and minimum gas prices).

use base64::Engine as _;
use serde::Serialize;
use serde_json::{json, Value};
use wallet_core::{NearAccountKind, Network};

use crate::btc_backend::Detected;
use crate::error::{AppError, AppResult};
use crate::net::{Family, NetClient, ServerRequest};
use crate::servers::{near_default_history, near_default_rpc, near_genesis};

/// Transactions read for the history (one explorer page, then one batch of details).
const MAX_TXS: usize = 20;
/// A transaction built on a block older than this (≈ 1 h at ≈ 1 block/s) must be rebuilt,
/// well inside NEAR's validity period (86 400 blocks ≈ 1 day).
pub const MAX_BLOCK_AGE: u64 = 3_600;

pub struct NearCtx<'a> {
    pub net_client: &'a NetClient,
    pub network: Network,
    pub tor: bool,
}

fn bad(msg: impl Into<String>) -> AppError {
    AppError::ServerUnreachable(msg.into())
}

pub fn rpc_url(ctx: &NearCtx<'_>) -> &'static str {
    near_default_rpc(ctx.network)
}

pub fn history_url(ctx: &NearCtx<'_>) -> &'static str {
    near_default_history(ctx.network)
}

/// A NEAR RPC error: `error.cause.name` (`UNKNOWN_ACCOUNT`, `UNKNOWN_ACCESS_KEY`,
/// `INVALID_TRANSACTION`, `TIMEOUT_ERROR`…) and a short message.
#[derive(Debug)]
pub enum RpcError {
    Near(String, String),
    App(AppError),
}

impl From<AppError> for RpcError {
    fn from(e: AppError) -> Self {
        RpcError::App(e)
    }
}

impl From<RpcError> for AppError {
    fn from(e: RpcError) -> Self {
        match e {
            RpcError::App(e) => e,
            RpcError::Near(code, msg) => bad(format!("NEAR : {code} ({msg})")),
        }
    }
}

fn short(v: &Value) -> String {
    let s = match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    };
    s.chars().take(300).collect()
}

/// Reads a JSON-RPC 2.0 answer: `result`, or the error's `cause.name` (also the older
/// `result.error` string some nodes still return for `query`).
pub fn parse_rpc(bytes: &[u8], method: &str) -> Result<Value, RpcError> {
    let v: Value = serde_json::from_slice(bytes)
        .map_err(|_| bad(format!("NEAR : JSON invalide sur {method}")))?;
    let e = &v["error"];
    if !e.is_null() {
        let name = e["cause"]["name"]
            .as_str()
            .or(e["name"].as_str())
            .unwrap_or("ERROR")
            .to_owned();
        let msg = if e["cause"]["info"].is_object() && !e["data"].is_string() {
            short(&e["cause"]["info"])
        } else {
            short(&e["data"])
        };
        return Err(RpcError::Near(name, msg));
    }
    let r = v["result"].clone();
    if r.is_null() {
        return Err(bad(format!("NEAR : réponse vide sur {method}")).into());
    }
    if let Some(msg) = r["error"].as_str() {
        let name = if msg.contains("does not exist") {
            if msg.contains("access key") {
                "UNKNOWN_ACCESS_KEY"
            } else {
                "UNKNOWN_ACCOUNT"
            }
        } else {
            "ERROR"
        };
        return Err(RpcError::Near(name.into(), msg.chars().take(300).collect()));
    }
    Ok(r)
}

async fn post(ctx: &NearCtx<'_>, url: &str, family_what: &str, body: String) -> AppResult<Vec<u8>> {
    let u =
        url::Url::parse(url).map_err(|_| AppError::ServerInvalid("URL NEAR invalide".into()))?;
    let (status, bytes) = ctx
        .net_client
        .server_request(ServerRequest::post_json(u, Family::Near, body), ctx.tor)
        .await?;
    if status != 200 {
        return Err(bad(format!(
            "NEAR : HTTP {status} sur {family_what} ({})",
            String::from_utf8_lossy(&bytes)
                .chars()
                .take(200)
                .collect::<String>()
        )));
    }
    Ok(bytes)
}

async fn rpc(ctx: &NearCtx<'_>, method: &str, params: Value) -> Result<Value, RpcError> {
    let body = json!({ "jsonrpc": "2.0", "id": "kyro", "method": method, "params": params });
    let bytes = post(ctx, rpc_url(ctx), method, body.to_string()).await?;
    parse_rpc(&bytes, method)
}

fn u128_at(v: &Value) -> Option<u128> {
    match v {
        Value::String(s) if !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) => {
            s.parse().ok()
        }
        Value::Number(n) => n.as_u64().map(u128::from),
        _ => None,
    }
}

// ---------------------------------------------------------------- network

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NearStatus {
    pub chain_id: String,
    pub genesis_hash: String,
    pub height: u64,
    pub syncing: bool,
}

pub async fn status(ctx: &NearCtx<'_>) -> AppResult<NearStatus> {
    let r = rpc(ctx, "status", json!([])).await?;
    Ok(NearStatus {
        chain_id: r["chain_id"].as_str().unwrap_or("").to_owned(),
        genesis_hash: r["genesis_hash"].as_str().unwrap_or("").to_owned(),
        height: r["sync_info"]["latest_block_height"]
            .as_u64()
            .ok_or_else(|| bad("NEAR : hauteur absente"))?,
        syncing: r["sync_info"]["syncing"] == true,
    })
}

/// The server must be on the app's network (chain id **and** genesis hash) and synced.
pub fn check_status(s: &NearStatus, net: Network) -> AppResult<()> {
    let (chain, genesis) = near_genesis(net);
    if s.chain_id != chain || s.genesis_hash != genesis {
        return Err(AppError::ServerWrongNetwork(format!(
            "ce serveur NEAR est sur « {} », pas sur {chain}",
            crate::dialog_text::sanitize(&s.chain_id, 40)
        )));
    }
    if s.syncing {
        return Err(bad("NEAR : le serveur est en cours de synchronisation"));
    }
    Ok(())
}

pub async fn probe(ctx: &NearCtx<'_>) -> AppResult<Detected> {
    let s = status(ctx).await?;
    check_status(&s, ctx.network)?;
    Ok(Detected {
        network: Some(s.chain_id.clone()),
        genesis_hash: Some(s.genesis_hash),
        block_height: Some(s.height),
        ..Default::default()
    })
}

/// What a transfer costs, from the live protocol configuration and gas price.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NearFeeParams {
    /// yoctoNEAR per gas unit, now.
    pub gas_price: u128,
    /// The protocol's minimum gas price.
    pub min_gas_price: u128,
    /// yoctoNEAR locked per byte of account storage.
    pub storage_per_byte: u128,
    /// Gas of a transfer to an existing account (receipt creation + transfer, send + execution).
    pub transfer_gas: u128,
    /// Extra gas when the transfer creates an implicit account (create account + full-access key).
    pub create_gas: u128,
}

impl NearFeeParams {
    pub fn gas(&self, creates_account: bool) -> u128 {
        self.transfer_gas + if creates_account { self.create_gas } else { 0 }
    }

    /// Expected fee at the current gas price.
    pub fn estimate(&self, creates_account: bool) -> u128 {
        self.gas(creates_account) * self.gas_price
    }

    /// What Kyro requires the balance to cover on top of the amount: twice the gas at the
    /// higher of the current and minimum gas prices (the price can move ≤ 1 % per block, and
    /// execution gas is prepaid at a slightly higher "pessimistic" price, then refunded).
    pub fn bound(&self, creates_account: bool) -> u128 {
        self.gas(creates_account) * self.gas_price.max(self.min_gas_price) * 2
    }
}

fn cost(v: &Value, what: &str) -> AppResult<u128> {
    let get = |k: &str| {
        v[k].as_u64()
            .map(u128::from)
            .ok_or_else(|| bad(format!("NEAR : coût {what}.{k} absent")))
    };
    Ok(get("send_not_sir")? + get("execution")?)
}

/// Parses `EXPERIMENTAL_protocol_config` + `gas_price`.
pub fn fee_params(config: &Value, gas_price: &Value) -> AppResult<NearFeeParams> {
    let rc = &config["runtime_config"];
    let tc = &rc["transaction_costs"];
    let ac = &tc["action_creation_config"];
    let p = NearFeeParams {
        gas_price: u128_at(&gas_price["gas_price"])
            .ok_or_else(|| bad("NEAR : prix du gas absent"))?,
        min_gas_price: u128_at(&config["min_gas_price"]).unwrap_or(0),
        storage_per_byte: u128_at(&rc["storage_amount_per_byte"])
            .ok_or_else(|| bad("NEAR : prix du stockage absent"))?,
        transfer_gas: cost(&tc["action_receipt_creation_config"], "receipt")?
            + cost(&ac["transfer_cost"], "transfer")?,
        create_gas: cost(&ac["create_account_cost"], "create_account")?
            + cost(&ac["add_key_cost"]["full_access_cost"], "add_key")?,
    };
    // Sanity: a transfer is well under 100 Tgas, and the gas price is at most 10^13 yocto.
    if p.gas(true) > 100_000_000_000_000 || p.gas_price > 10_000_000_000_000 || p.gas_price == 0 {
        return Err(bad("NEAR : paramètres de frais invraisemblables"));
    }
    Ok(p)
}

pub async fn fees(ctx: &NearCtx<'_>) -> AppResult<NearFeeParams> {
    let config = rpc(
        ctx,
        "EXPERIMENTAL_protocol_config",
        json!({ "finality": "final" }),
    )
    .await?;
    let price = rpc(ctx, "gas_price", json!([null])).await?;
    fee_params(&config, &price)
}

// ---------------------------------------------------------------- accounts

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NearAccountInfo {
    pub account_id: String,
    /// The account exists on chain (an implicit account is created by its first transfer).
    pub exists: bool,
    /// yoctoNEAR, liquid (`amount`, staking excluded).
    pub balance: String,
    /// yoctoNEAR locked by validator staking (not delegations to a pool).
    pub locked: String,
    pub storage_usage: u64,
    /// yoctoNEAR the account must keep for its storage (not covered by `locked`).
    pub storage_reserve: String,
    /// yoctoNEAR: balance − storage reserve (0 if negative).
    pub spendable: String,
    /// A contract is deployed on this account.
    pub has_contract: bool,
}

/// Balance facts from a `view_account` result.
pub fn account_from(
    account_id: &str,
    r: &Value,
    storage_per_byte: u128,
) -> AppResult<NearAccountInfo> {
    let amount = u128_at(&r["amount"]).ok_or_else(|| bad("NEAR : solde absent"))?;
    let locked = u128_at(&r["locked"]).unwrap_or(0);
    let usage = r["storage_usage"].as_u64().unwrap_or(0);
    let reserve = (u128::from(usage) * storage_per_byte).saturating_sub(locked);
    Ok(NearAccountInfo {
        account_id: account_id.to_owned(),
        exists: true,
        balance: amount.to_string(),
        locked: locked.to_string(),
        storage_usage: usage,
        storage_reserve: reserve.to_string(),
        spendable: amount.saturating_sub(reserve).to_string(),
        has_contract: r["code_hash"]
            .as_str()
            .is_some_and(|h| h != "11111111111111111111111111111111"),
    })
}

fn missing(account_id: &str) -> NearAccountInfo {
    NearAccountInfo {
        account_id: account_id.to_owned(),
        balance: "0".into(),
        locked: "0".into(),
        storage_reserve: "0".into(),
        spendable: "0".into(),
        ..Default::default()
    }
}

pub async fn account(
    ctx: &NearCtx<'_>,
    account_id: &str,
    storage_per_byte: u128,
) -> AppResult<NearAccountInfo> {
    let id = account_id.trim();
    wallet_core::near_account_kind(id)?;
    match rpc(
        ctx,
        "query",
        json!({ "request_type": "view_account", "finality": "final", "account_id": id }),
    )
    .await
    {
        Ok(r) => account_from(id, &r, storage_per_byte),
        Err(RpcError::Near(code, _)) if code == "UNKNOWN_ACCOUNT" => Ok(missing(id)),
        Err(e) => Err(e.into()),
    }
}

/// `view_access_key` of our key: `(nonce, final block hash, final block height)`. Only a
/// full-access key can sign a transfer.
pub async fn access_key(
    ctx: &NearCtx<'_>,
    account_id: &str,
    public_key: &[u8; 32],
) -> AppResult<(u64, [u8; 32], u64)> {
    let r = match rpc(
        ctx,
        "query",
        json!({
            "request_type": "view_access_key", "finality": "final",
            "account_id": account_id, "public_key": wallet_core::near_public_key_string(public_key),
        }),
    )
    .await
    {
        Ok(r) => r,
        Err(RpcError::Near(code, _))
            if code == "UNKNOWN_ACCESS_KEY" || code == "UNKNOWN_ACCOUNT" =>
        {
            return Err(AppError::InvalidInput(
                "ton compte NEAR n'existe pas encore (aucun NEAR reçu) ou ta clé en a été retirée"
                    .into(),
            ))
        }
        Err(e) => return Err(e.into()),
    };
    access_key_from(&r)
}

pub fn access_key_from(r: &Value) -> AppResult<(u64, [u8; 32], u64)> {
    if r["permission"] != "FullAccess" {
        return Err(AppError::InvalidInput(
            "la clé de ce portefeuille n'a plus l'accès complet à ton compte NEAR : elle ne peut pas envoyer de NEAR".into(),
        ));
    }
    let nonce = r["nonce"]
        .as_u64()
        .ok_or_else(|| bad("NEAR : nonce absent"))?;
    let hash = wallet_core::near_parse_hash(r["block_hash"].as_str().unwrap_or(""))
        .map_err(|_| bad("NEAR : hash de bloc absent"))?;
    let height = r["block_height"].as_u64().unwrap_or(0);
    Ok((nonce, hash, height))
}

/// Height of block `hash` (base58).
pub async fn block_height(ctx: &NearCtx<'_>, hash: &str) -> AppResult<u64> {
    let r = rpc(ctx, "block", json!({ "block_id": hash })).await?;
    r["header"]["height"]
        .as_u64()
        .ok_or_else(|| bad("NEAR : hauteur du bloc absente"))
}

// ---------------------------------------------------------------- checks

/// Checks before building / signing a transfer, against live data. Errors are user-facing.
pub struct TransferCheck<'a> {
    pub ours: &'a NearAccountInfo,
    pub receiver: &'a NearAccountInfo,
    pub receiver_kind: NearAccountKind,
    pub deposit: u128,
    pub fees: &'a NearFeeParams,
}

/// The transfer creates the receiver (an implicit account that does not exist yet).
pub fn creates_account(receiver: &NearAccountInfo, kind: NearAccountKind) -> bool {
    !receiver.exists && kind == NearAccountKind::Implicit
}

pub fn check_transfer(c: &TransferCheck<'_>) -> AppResult<()> {
    if !c.ours.exists {
        return Err(AppError::InvalidInput(
            "ton compte NEAR n'existe pas encore : il est créé par le premier NEAR reçu".into(),
        ));
    }
    if !c.receiver.exists {
        match c.receiver_kind {
            NearAccountKind::Implicit => {}
            NearAccountKind::Named => {
                return Err(AppError::InvalidInput(format!(
                    "le compte « {} » n'existe pas : un compte nommé doit déjà exister (sinon les frais sont perdus)",
                    c.receiver.account_id
                )))
            }
            NearAccountKind::EthImplicit => {
                return Err(AppError::InvalidInput(
                    "ce compte de style Ethereum (0x…) n'existe pas sur NEAR : Kyro ne le crée pas".into(),
                ))
            }
        }
    }
    let spendable: u128 = c.ours.spendable.parse().unwrap_or(0);
    let bound = c.fees.bound(creates_account(c.receiver, c.receiver_kind));
    if c.deposit.saturating_add(bound) > spendable {
        return Err(AppError::InvalidInput(format!(
            "solde disponible insuffisant : {} NEAR disponibles (solde − réserve de stockage), il en faut {} (montant + frais au plus)",
            crate::commands::format_units(&spendable.to_string(), 24),
            crate::commands::format_units(&c.deposit.saturating_add(bound).to_string(), 24)
        )));
    }
    Ok(())
}

// ---------------------------------------------------------------- history

/// Last transactions touching `account_id`, normalized:
/// `[{ hash, from, to, kind: 'transfer' | 'other', deposit, fee, height, time, success }]`
/// (`deposit`: yoctoNEAR of the transaction's own Transfer actions; `fee`: yoctoNEAR burnt).
pub async fn txs(ctx: &NearCtx<'_>, account_id: &str) -> AppResult<Value> {
    let id = account_id.trim();
    wallet_core::near_account_kind(id)?;
    let base = history_url(ctx);
    let list = post(
        ctx,
        &format!("{base}/v0/account"),
        "historique",
        json!({ "account_id": id, "limit": MAX_TXS, "desc": true }).to_string(),
    )
    .await?;
    let list: Value =
        serde_json::from_slice(&list).map_err(|_| bad("NEAR : historique illisible"))?;
    let hashes: Vec<String> = list["account_txs"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|t| t["transaction_hash"].as_str())
        .filter(|h| wallet_core::near_parse_hash(h).is_ok())
        .take(MAX_TXS)
        .map(str::to_owned)
        .collect();
    if hashes.is_empty() {
        return Ok(json!([]));
    }
    let details = post(
        ctx,
        &format!("{base}/v0/transactions"),
        "historique",
        json!({ "tx_hashes": hashes }).to_string(),
    )
    .await?;
    let details: Value =
        serde_json::from_slice(&details).map_err(|_| bad("NEAR : historique illisible"))?;
    Ok(Value::Array(
        details["transactions"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(history_entry)
            .collect(),
    ))
}

/// One explorer transaction → one history entry (`None` if malformed).
pub fn history_entry(t: &Value) -> Option<Value> {
    let tx = &t["transaction"];
    let hash = tx["hash"].as_str()?;
    wallet_core::near_parse_hash(hash).ok()?;
    let from = tx["signer_id"].as_str()?;
    let to = tx["receiver_id"].as_str()?;
    let actions = tx["actions"].as_array()?;
    let mut deposit: u128 = 0;
    let mut only_transfers = !actions.is_empty();
    for a in actions {
        match a.get("Transfer") {
            Some(tr) => deposit = deposit.checked_add(u128_at(&tr["deposit"])?)?,
            None => only_transfers = false,
        }
    }
    let outcome = &t["execution_outcome"];
    let mut fee = u128_at(&outcome["outcome"]["tokens_burnt"]).unwrap_or(0);
    let mut success = outcome["outcome"]["status"].get("Failure").is_none();
    for r in t["receipts"].as_array().into_iter().flatten() {
        let o = &r["execution_outcome"]["outcome"];
        fee = fee.saturating_add(u128_at(&o["tokens_burnt"]).unwrap_or(0));
        if o["status"].get("Failure").is_some() {
            success = false;
        }
    }
    Some(json!({
        "hash": hash,
        "from": from,
        "to": to,
        "kind": if only_transfers { "transfer" } else { "other" },
        "deposit": deposit.to_string(),
        "fee": fee.to_string(),
        "height": outcome["block_height"].as_u64(),
        "time": outcome["block_timestamp"].as_u64().map(|ns| ns / 1_000_000),
        "success": success,
    }))
}

// ---------------------------------------------------------------- broadcast

/// Result of a broadcast or a status query.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NearTxOutcome {
    pub hash: String,
    /// `success` | `failure` | `pending`.
    pub status: &'static str,
    /// Failure reason (from the node, sanitized), empty otherwise.
    pub message: String,
}

/// Reads a `send_tx` / `tx` result for transaction `hash`.
pub fn outcome_from(r: &Value, hash: &str) -> AppResult<NearTxOutcome> {
    let got = r["transaction"]["hash"]
        .as_str()
        .or(r["transaction_outcome"]["id"].as_str())
        .unwrap_or("");
    if !got.is_empty() && got != hash {
        return Err(bad(format!(
            "le serveur a répondu un hash inattendu ({})",
            crate::dialog_text::sanitize(got, 80)
        )));
    }
    let st = &r["status"];
    let (status, message) =
        if st.get("SuccessValue").is_some() || st.get("SuccessReceiptId").is_some() {
            ("success", String::new())
        } else if let Some(f) = st.get("Failure") {
            ("failure", crate::dialog_text::sanitize(&f.to_string(), 300))
        } else {
            ("pending", String::new())
        };
    Ok(NearTxOutcome {
        hash: hash.to_owned(),
        status,
        message,
    })
}

/// `send_tx` (signed transaction, Borsh) waiting for optimistic execution. A node timeout is
/// not a failure: the transaction may still land (status `pending`, follow it with `tx`).
pub async fn send(ctx: &NearCtx<'_>, signed: &[u8], hash: &str) -> AppResult<NearTxOutcome> {
    let b64 = base64::engine::general_purpose::STANDARD.encode(signed);
    match rpc(
        ctx,
        "send_tx",
        json!({ "signed_tx_base64": b64, "wait_until": "EXECUTED_OPTIMISTIC" }),
    )
    .await
    {
        Ok(r) => outcome_from(&r, hash),
        Err(RpcError::Near(code, _)) if code == "TIMEOUT_ERROR" => Ok(NearTxOutcome {
            hash: hash.to_owned(),
            status: "pending",
            message: String::new(),
        }),
        Err(RpcError::Near(code, msg)) if code == "INVALID_TRANSACTION" => {
            Err(AppError::InvalidInput(format!(
                "transaction NEAR refusée par le réseau : {}",
                crate::dialog_text::sanitize(&msg, 200)
            )))
        }
        Err(e) => Err(e.into()),
    }
}

/// `tx` by hash (and sender): `pending` while unknown or not yet executed.
pub async fn tx_status(ctx: &NearCtx<'_>, hash: &str, sender: &str) -> AppResult<NearTxOutcome> {
    match rpc(
        ctx,
        "tx",
        json!({ "tx_hash": hash, "sender_account_id": sender, "wait_until": "NONE" }),
    )
    .await
    {
        Ok(r) => outcome_from(&r, hash),
        Err(RpcError::Near(code, _))
            if code == "UNKNOWN_TRANSACTION" || code == "TIMEOUT_ERROR" =>
        {
            Ok(NearTxOutcome {
                hash: hash.to_owned(),
                status: "pending",
                message: String::new(),
            })
        }
        Err(e) => Err(e.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const YOCTO: u128 = 1_000_000_000_000_000_000_000_000;

    fn fee_params_sample() -> NearFeeParams {
        // Live values of mainnet protocol 86 (2026-11-01).
        let config = json!({
            "min_gas_price": "1000000000",
            "runtime_config": {
                "storage_amount_per_byte": "10000000000000000000",
                "transaction_costs": {
                    "action_receipt_creation_config": { "execution": 108059500000u64, "send_not_sir": 108059500000u64, "send_sir": 108059500000u64 },
                    "action_creation_config": {
                        "transfer_cost": { "execution": 115123062500u64, "send_not_sir": 115123062500u64, "send_sir": 115123062500u64 },
                        "create_account_cost": { "execution": 7200000000000u64, "send_not_sir": 500000000000u64, "send_sir": 500000000000u64 },
                        "add_key_cost": { "full_access_cost": { "execution": 101765125000u64, "send_not_sir": 101765125000u64, "send_sir": 101765125000u64 } }
                    }
                }
            }
        });
        fee_params(&config, &json!({ "gas_price": "100000000" })).unwrap()
    }

    #[test]
    fn fees_from_protocol_config() {
        let p = fee_params_sample();
        assert_eq!(p.transfer_gas, 446_365_125_000);
        assert_eq!(p.create_gas, 7_903_530_250_000);
        // 0.0000446 NEAR at 10^8 yocto/gas; bound at the minimum price 10^9, × 2.
        assert_eq!(p.estimate(false), 44_636_512_500_000_000_000);
        assert_eq!(p.bound(false), 892_730_250_000_000_000_000);
        assert!(
            p.bound(true) < YOCTO / 50,
            "creating an account stays under 0.02 NEAR"
        );
        assert!(fee_params(&json!({}), &json!({ "gas_price": "1" })).is_err());
    }

    #[test]
    fn accounts_and_storage() {
        let r = json!({ "amount": "5100000000000000000000000", "locked": "0", "storage_usage": 182, "code_hash": "11111111111111111111111111111111" });
        let a = account_from("x.testnet", &r, 10_000_000_000_000_000_000).unwrap();
        assert_eq!(a.storage_reserve, "1820000000000000000000");
        assert_eq!(a.spendable, "5098180000000000000000000");
        assert!(!a.has_contract);
        assert!(account_from("x", &json!({ "amount": -1 }), 1).is_err());
    }

    #[test]
    fn rpc_errors() {
        let unknown = br#"{"jsonrpc":"2.0","error":{"name":"HANDLER_ERROR","cause":{"info":{"requested_account_id":"0000000000000000000000000000000000000000000000000000000000000001"},"name":"UNKNOWN_ACCOUNT"},"code":-32000,"message":"Server error","data":"account 00..01 does not exist while viewing"},"id":"k"}"#;
        assert!(
            matches!(parse_rpc(unknown, "query"), Err(RpcError::Near(c, _)) if c == "UNKNOWN_ACCOUNT")
        );
        let legacy = br#"{"jsonrpc":"2.0","result":{"error":"access key ed25519:x does not exist while viewing","logs":[]},"id":"k"}"#;
        assert!(
            matches!(parse_rpc(legacy, "query"), Err(RpcError::Near(c, _)) if c == "UNKNOWN_ACCESS_KEY")
        );
        assert!(parse_rpc(b"not json", "status").is_err());
        assert!(parse_rpc(br#"{"result":{"gas_price":"1"}}"#, "gas_price").is_ok());
    }

    #[test]
    fn network_check() {
        let mut s = NearStatus {
            chain_id: "testnet".into(),
            genesis_hash: "FWJ9kR6KFWoyMoNjpLXXGHeuiy7tEY6GmoFeCA5yuc6b".into(),
            height: 1,
            syncing: false,
        };
        assert!(check_status(&s, Network::Testnet).is_ok());
        assert!(matches!(
            check_status(&s, Network::Mainnet),
            Err(AppError::ServerWrongNetwork(_))
        ));
        s.genesis_hash = "EPnLgE7iEq9s7yTkos96M3cWymH5avBAPm3qx3NXqR8H".into();
        assert!(
            check_status(&s, Network::Testnet).is_err(),
            "testnet name, mainnet genesis"
        );
        s.chain_id = "mainnet".into();
        s.syncing = true;
        assert!(check_status(&s, Network::Mainnet).is_err());
    }

    #[test]
    fn access_keys() {
        let full = json!({ "nonce": 187000000000005u64, "permission": "FullAccess", "block_hash": "244ZQ9cgj3CQ6bWBdytfrJMuMQ1jdXLFGnr4HhvtCTnM", "block_height": 7 });
        let (n, _, h) = access_key_from(&full).unwrap();
        assert_eq!((n, h), (187000000000005, 7));
        let fc = json!({ "nonce": 1, "permission": { "FunctionCall": { "allowance": null, "receiver_id": "x", "method_names": [] } }, "block_hash": "244ZQ9cgj3CQ6bWBdytfrJMuMQ1jdXLFGnr4HhvtCTnM" });
        assert!(access_key_from(&fc).is_err());
    }

    fn info(exists: bool, spendable: u128) -> NearAccountInfo {
        NearAccountInfo {
            account_id: "bob.testnet".into(),
            exists,
            spendable: spendable.to_string(),
            ..Default::default()
        }
    }

    #[test]
    fn transfer_checks() {
        let fees = fee_params_sample();
        let ours = info(true, YOCTO);
        let ok = |receiver: &NearAccountInfo, kind, deposit| {
            check_transfer(&TransferCheck {
                ours: &ours,
                receiver,
                receiver_kind: kind,
                deposit,
                fees: &fees,
            })
        };
        use NearAccountKind::*;
        assert!(ok(&info(true, 0), Named, YOCTO / 2).is_ok());
        assert!(
            matches!(ok(&info(false, 0), Named, 1), Err(AppError::InvalidInput(m)) if m.contains("n'existe pas"))
        );
        assert!(ok(&info(false, 0), Implicit, YOCTO / 2).is_ok());
        assert!(ok(&info(false, 0), EthImplicit, 1).is_err());
        // Amount + fee bound above spendable.
        assert!(
            matches!(ok(&info(true, 0), Named, YOCTO - fees.bound(false) + 1), Err(AppError::InvalidInput(m)) if m.contains("insuffisant"))
        );
        assert!(ok(&info(true, 0), Named, YOCTO - fees.bound(false)).is_ok());
        assert!(
            ok(&info(false, 0), Implicit, YOCTO - fees.bound(false)).is_err(),
            "creation costs more"
        );
        // Our account does not exist.
        let none = info(false, 0);
        assert!(check_transfer(&TransferCheck {
            ours: &none,
            receiver: &info(true, 0),
            receiver_kind: Named,
            deposit: 1,
            fees: &fees
        })
        .is_err());
    }

    #[test]
    fn history_entries() {
        let t = json!({
            "transaction": { "hash": "4XTVLd3z94Rjfp5rpNcKNqqfXbKNhf1bwtonhj77uvPs", "signer_id": "a.testnet", "receiver_id": "b.testnet",
                "actions": [{ "Transfer": { "deposit": "1500000000000000000000000" } }] },
            "execution_outcome": { "block_height": 10, "block_timestamp": 1793497228798591241u64,
                "outcome": { "tokens_burnt": "22318256250000000000", "status": { "SuccessReceiptId": "x" } } },
            "receipts": [{ "execution_outcome": { "outcome": { "tokens_burnt": "22318256250000000000", "status": { "SuccessValue": "" } } } }]
        });
        let e = history_entry(&t).unwrap();
        assert_eq!(e["kind"], "transfer");
        assert_eq!(e["deposit"], "1500000000000000000000000");
        assert_eq!(e["fee"], "44636512500000000000");
        assert_eq!(e["time"], 1793497228798u64);
        assert_eq!(e["success"], true);
        let mut f = t.clone();
        f["transaction"]["actions"] =
            json!([{ "FunctionCall": { "method_name": "ft_transfer", "deposit": "1" } }]);
        f["receipts"][0]["execution_outcome"]["outcome"]["status"] =
            json!({ "Failure": { "ActionError": {} } });
        let e = history_entry(&f).unwrap();
        assert_eq!(
            (
                e["kind"].as_str(),
                e["deposit"].as_str(),
                e["success"].as_bool()
            ),
            (Some("other"), Some("0"), Some(false))
        );
        let mut g = t;
        g["transaction"]["hash"] = json!("not-a-hash");
        assert!(history_entry(&g).is_none());
    }

    #[test]
    fn outcomes() {
        let h = "4XTVLd3z94Rjfp5rpNcKNqqfXbKNhf1bwtonhj77uvPs";
        let ok = json!({ "status": { "SuccessValue": "" }, "transaction": { "hash": h } });
        assert_eq!(outcome_from(&ok, h).unwrap().status, "success");
        let fail = json!({ "status": { "Failure": { "ActionError": { "kind": "LackBalanceForState" } } }, "transaction": { "hash": h } });
        let o = outcome_from(&fail, h).unwrap();
        assert_eq!(o.status, "failure");
        assert!(o.message.contains("LackBalanceForState"));
        let other = json!({ "status": { "SuccessValue": "" }, "transaction": { "hash": "11111111111111111111111111111111" } });
        assert!(outcome_from(&other, h).is_err());
        assert_eq!(
            outcome_from(&json!({ "final_execution_status": "INCLUDED" }), h)
                .unwrap()
                .status,
            "pending"
        );
    }
}

/// Real-network test on NEAR testnet over Tor. Run with
/// `cargo test -p kyro-desktop -- --ignored --nocapture near_live`.
/// - keys: a NEW random test mnemonic and a NEW random ed25519 key for the funding account,
///   generated once and kept in the gitignored `.env.near-testnet` at the repository root
///   (testnet only);
/// - `KYRO_NEAR_FAUCET=yes`: asks NEAR's account helper (`helper.nearprotocol.com/account`, the
///   faucet of near-cli `sponsor-by-faucet-service`, no captcha) to create a named
///   `kyro-….testnet` account with the funding key, then moves NEAR from it to our implicit
///   account 0 (that one transfer is signed here, outside Kyro's path: its signer is a named
///   account);
/// - `KYRO_NEAR_SEND=yes`: through the real path (live checks, dialog text, signature with an
///   identical summary, `send_tx`, hash check): one transfer that creates implicit account 1,
///   one transfer to the named account.
#[cfg(test)]
mod live {
    use super::*;
    use crate::tor::TorState;
    use ed25519_dalek::Signer as _;

    struct Keys {
        seed: wallet_core::Seed,
        funder: ed25519_dalek::SigningKey,
        funder_id: String,
    }

    fn keys() -> Keys {
        let path =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../.env.near-testnet");
        let text = std::fs::read_to_string(&path).unwrap_or_else(|_| {
            let m = wallet_core::Mnemonic::generate(wallet_core::WordCount::W12).unwrap();
            let mut secret = [0u8; 32];
            getrandom::getrandom(&mut secret).unwrap();
            let mut tag = [0u8; 4];
            getrandom::getrandom(&mut tag).unwrap();
            let t = format!(
                "# NEAR TESTNET ONLY — random test keys generated by Kyro's live test (near_backend.rs).\n# Never use them for real funds. This file is gitignored (.env.*).\nKYRO_NEAR_TEST_MNEMONIC={}\nKYRO_NEAR_FUNDER_SECRET={}\nKYRO_NEAR_FUNDER_ACCOUNT=kyro-{}.testnet\n",
                m.words().join(" "),
                hex::encode(secret),
                hex::encode(tag)
            );
            std::fs::write(&path, &t).unwrap();
            eprintln!("new test keys written to {}", path.display());
            t
        });
        let get = |k: &str| {
            text.lines()
                .find_map(|l| l.strip_prefix(k))
                .unwrap_or_else(|| panic!("{k} missing"))
                .trim()
                .to_owned()
        };
        let secret: [u8; 32] = hex::decode(get("KYRO_NEAR_FUNDER_SECRET="))
            .unwrap()
            .try_into()
            .unwrap();
        Keys {
            seed: wallet_core::Mnemonic::parse(&get("KYRO_NEAR_TEST_MNEMONIC="))
                .unwrap()
                .to_seed(""),
            funder: ed25519_dalek::SigningKey::from_bytes(&secret),
            funder_id: get("KYRO_NEAR_FUNDER_ACCOUNT="),
        }
    }

    async fn wait_exists(c: &NearCtx<'_>, id: &str, spb: u128) -> NearAccountInfo {
        for _ in 0..30 {
            let a = account(c, id, spb).await.unwrap();
            if a.exists {
                return a;
            }
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
        panic!("{id} still missing");
    }

    /// Funding only: a transfer signed by the named funding account (not Kyro's signing path).
    async fn fund(c: &NearCtx<'_>, k: &Keys, to: &str, deposit: u128) {
        let pk = k.funder.verifying_key().to_bytes();
        let (nonce, block_hash, _) = access_key(c, &k.funder_id, &pk).await.unwrap();
        let tx = wallet_core::NearTransfer {
            signer_id: k.funder_id.clone(),
            public_key: pk,
            nonce: nonce + 1,
            receiver_id: to.to_owned(),
            block_hash,
            deposit,
        };
        let hash = tx.hash();
        let signed = tx.encode_signed(&k.funder.sign(&hash).to_bytes());
        let out = send(c, &signed, &wallet_core::near_hash_string(&hash))
            .await
            .unwrap();
        eprintln!("FUNDING {to}: {out:?}");
        assert_ne!(out.status, "failure");
    }

    async fn transfer(
        c: &NearCtx<'_>,
        seed: &wallet_core::Seed,
        me: &str,
        pk: &[u8; 32],
        to: &str,
        yocto: &str,
    ) -> String {
        let built = crate::commands_near::build(c, me, pk, to, yocto)
            .await
            .unwrap();
        let (summary, context) = crate::commands_near::prepare_sign(c, me, pk, &built.tx)
            .await
            .unwrap();
        assert_eq!(summary, built.summary);
        eprintln!(
            "--- dialog ---\n{}---",
            crate::commands_near::describe_near(&summary, &context, Network::Testnet)
        );
        let (signed, hash, again) = wallet_core::near_sign(seed, 0, &built.tx).unwrap();
        assert_eq!(again, summary, "identical summary");
        let out = crate::commands_near::broadcast_checked(c, me, &signed)
            .await
            .unwrap();
        eprintln!("SENT {out:?}");
        assert_eq!(out.hash, hash);
        for _ in 0..30 {
            let s = tx_status(c, &hash, me).await.unwrap();
            if s.status != "pending" {
                assert_eq!(s.status, "success", "{s:?}");
                return hash;
            }
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
        panic!("{hash} not executed");
    }

    #[test]
    #[ignore]
    fn near_live_testnet_over_tor() {
        let net = NetClient::new(std::env::temp_dir().join("kyro-near-live")).unwrap();
        let k = keys();
        let me = wallet_core::near_address(&k.seed, 0).unwrap();
        let pk = wallet_core::near_public_key(&k.seed, 0).unwrap();
        let a1 = wallet_core::near_address(&k.seed, 1).unwrap();
        eprintln!("implicit accounts: {me} {a1}; funder {}", k.funder_id);
        tauri::async_runtime::block_on(async {
            net.tor.restart();
            while net.tor.status().state != TorState::Ready {
                assert_ne!(net.tor.status().state, TorState::Error);
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            }
            let c = NearCtx {
                net_client: &net,
                network: Network::Testnet,
                tor: true,
            };
            let t = std::time::Instant::now();
            eprintln!("testnet probe {:?} in {:.1?}", probe(&c).await, t.elapsed());
            let main = NearCtx {
                net_client: &net,
                network: Network::Mainnet,
                tor: true,
            };
            eprintln!("mainnet probe {:?}", probe(&main).await);
            // The mainnet node seen with testnet expectations: wrong network.
            let s = status(&main).await.unwrap();
            assert!(matches!(
                check_status(&s, Network::Testnet),
                Err(AppError::ServerWrongNetwork(_))
            ));
            let f = fees(&c).await.unwrap();
            eprintln!(
                "fees {f:?} estimate {} bound {}",
                f.estimate(false),
                f.bound(true)
            );
            let sample = txs(&main, "relay.aurora").await.unwrap();
            eprintln!(
                "mainnet history sample: {} entries, first {}",
                sample.as_array().map(|a| a.len()).unwrap_or(0),
                sample[0]
            );

            let mut acc = account(&c, &me, f.storage_per_byte).await.unwrap();
            if !acc.exists && std::env::var("KYRO_NEAR_FAUCET").as_deref() == Ok("yes") {
                let funder = account(&c, &k.funder_id, f.storage_per_byte).await.unwrap();
                if !funder.exists {
                    let body = json!({
                        "newAccountId": k.funder_id,
                        "newAccountPublicKey": wallet_core::near_public_key_string(&k.funder.verifying_key().to_bytes()),
                    });
                    let req = ServerRequest::post_json(
                        url::Url::parse("https://helper.nearprotocol.com/account").unwrap(),
                        Family::Near,
                        body.to_string(),
                    );
                    let (st, body) = net.server_request(req, true).await.unwrap();
                    eprintln!(
                        "faucet: HTTP {st} {}",
                        String::from_utf8_lossy(&body)
                            .chars()
                            .take(300)
                            .collect::<String>()
                    );
                }
                let funder = wait_exists(&c, &k.funder_id, f.storage_per_byte).await;
                eprintln!("funder {funder:?}");
                let spendable: u128 = funder.spendable.parse().unwrap();
                fund(&c, &k, &me, spendable.saturating_sub(f.bound(true) * 4) / 2).await;
                acc = wait_exists(&c, &me, f.storage_per_byte).await;
            }
            eprintln!("account {acc:?}");
            eprintln!("history: {}", txs(&c, &me).await.unwrap());
            if std::env::var("KYRO_NEAR_SEND").as_deref() != Ok("yes") || !acc.exists {
                eprintln!("KYRO_NEAR_SEND != yes or account missing: no transfer");
                return;
            }
            // A named account that does not exist: refused before anything is signed.
            let r = crate::commands_near::build(&c, &me, &pk, "kyro-nexiste-pas-0000.testnet", "1")
                .await;
            eprintln!("to a missing named account: {:?}", r.as_ref().err());
            assert!(matches!(r, Err(AppError::InvalidInput(ref m)) if m.contains("n'existe pas")));
            // 1) creates implicit account 1, 2) to the named funding account.
            let h = transfer(&c, &k.seed, &me, &pk, &a1, "500000000000000000000000").await;
            eprintln!("TRANSFER CREATING AN IMPLICIT ACCOUNT: {h}");
            let h = transfer(
                &c,
                &k.seed,
                &me,
                &pk,
                &k.funder_id,
                "100000000000000000000000",
            )
            .await;
            eprintln!("TRANSFER TO A NAMED ACCOUNT: {h}");
            eprintln!(
                "recipient now {:?}",
                account(&c, &a1, f.storage_per_byte).await.unwrap()
            );
            eprintln!(
                "our account now {:?}",
                account(&c, &me, f.storage_per_byte).await.unwrap()
            );
            eprintln!("history after: {}", txs(&c, &me).await.unwrap());
        });
    }
}
