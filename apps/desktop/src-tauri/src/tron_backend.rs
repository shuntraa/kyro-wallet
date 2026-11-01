//! TRON data from a java-tron HTTP API (default TronGrid: `api.trongrid.io`, `nile.trongrid.io`),
//! on the `tron` Tor family, never with a fallback.
//!
//! Kyro builds every `raw_data` itself (wallet-core `TronRaw`) from the latest block
//! (`/wallet/getnowblock`): the server's `createtransaction` is never used to build what is
//! signed. Resources and fees come from `/wallet/getaccount`, `/wallet/getaccountresource`,
//! `/wallet/getchainparameters` and, for TRC-20, an energy simulation
//! (`/wallet/triggerconstantcontract`). History uses TronGrid's `/v1` API.

use serde::Serialize;
use serde_json::{json, Value};
use wallet_core::{Network, TronAction, TronTxSummary};

use crate::btc_backend::Detected;
use crate::error::{AppError, AppResult};
use crate::net::{Family, NetClient, ServerRequest};
use crate::servers::{tron_default_base, validate_http_url, TronServer, TRON_GENESIS};

/// java-tron adds this to the serialized size when it charges bandwidth (MAX_RESULT_SIZE_IN_TX).
const RESULT_SIZE: u64 = 64;
/// Bytes a signed transaction adds to its raw_data: field keys/lengths + one 65-byte signature.
const SIGNED_OVERHEAD: u64 = 3 + 2 + 65;
/// Energy margin on the simulation for `fee_limit` (+30 %).
const FEE_LIMIT_MARGIN_PCT: u64 = 130;
/// Floor of the `fee_limit` Kyro sets on a TRC-20 transfer: 1 TRX.
const MIN_FEE_LIMIT: u64 = 1_000_000;
/// Expiration Kyro sets: 10 minutes after the reference block (leaves time for the password
/// and the dialog; java-tron accepts up to 24 h).
pub const EXPIRATION_MS: i64 = 10 * 60 * 1000;
const MAX_EXPIRATION_MS: i64 = 24 * 3600 * 1000;

pub struct TronCtx<'a> {
    pub net_client: &'a NetClient,
    pub network: Network,
    pub tor: bool,
    pub server: TronServer,
    /// Optional TronGrid key; sent (`TRON-PRO-API-KEY`) to TronGrid hosts only.
    pub api_key: Option<String>,
}

fn bad(msg: impl Into<String>) -> AppError {
    AppError::ServerUnreachable(msg.into())
}

pub fn base(ctx: &TronCtx<'_>) -> AppResult<String> {
    Ok(match &ctx.server {
        TronServer::Default => tron_default_base(ctx.network).to_owned(),
        TronServer::Http { url } => {
            validate_http_url(url, ctx.tor, false)?;
            url.trim().trim_end_matches('/').to_owned()
        }
    })
}

pub(crate) async fn request(
    ctx: &TronCtx<'_>,
    path: &str,
    body: Option<Value>,
) -> AppResult<Value> {
    let base = base(ctx)?;
    let url = url::Url::parse(&format!("{base}{path}"))
        .map_err(|_| AppError::ServerInvalid("URL TRON invalide".into()))?;
    let host = url.host_str().unwrap_or_default().to_owned();
    let mut req = match body {
        Some(b) => ServerRequest::post_json(url, Family::Tron, b.to_string()),
        None => ServerRequest::get(url, Family::Tron),
    };
    if let Some(k) = ctx.api_key.as_ref().filter(|_| is_trongrid(&host)) {
        req.headers.push(("tron-pro-api-key".into(), k.clone()));
    }
    let (status, bytes) = ctx.net_client.server_request(req, ctx.tor).await?;
    if status != 200 {
        return Err(bad(format!(
            "TRON : HTTP {status} sur {path} ({})",
            String::from_utf8_lossy(&bytes)
                .chars()
                .take(200)
                .collect::<String>()
        )));
    }
    let v: Value = serde_json::from_slice(&bytes)
        .map_err(|_| bad(format!("TRON : JSON invalide sur {path}")))?;
    if let Some(e) = v.get("Error").and_then(Value::as_str) {
        return Err(bad(format!(
            "TRON : {path} : {}",
            e.chars().take(200).collect::<String>()
        )));
    }
    Ok(v)
}

/// The key is never sent to a user's own node or to any other host.
pub fn is_trongrid(host: &str) -> bool {
    matches!(host, "api.trongrid.io" | "nile.trongrid.io")
}

fn u64_at(v: &Value, k: &str) -> u64 {
    v.get(k).and_then(Value::as_u64).unwrap_or(0)
}

/// Latest block: `(number, block id hex, timestamp ms)`.
pub async fn now_block(ctx: &TronCtx<'_>) -> AppResult<(u64, String, i64)> {
    let v = request(ctx, "/wallet/getnowblock", Some(json!({}))).await?;
    let raw = &v["block_header"]["raw_data"];
    let number = raw["number"]
        .as_u64()
        .ok_or_else(|| bad("TRON : bloc sans numéro"))?;
    let ts = raw["timestamp"]
        .as_i64()
        .ok_or_else(|| bad("TRON : bloc sans horodatage"))?;
    let id = v["blockID"]
        .as_str()
        .ok_or_else(|| bad("TRON : bloc sans blockID"))?
        .to_owned();
    Ok((number, id, ts))
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TronAccount {
    pub address: String,
    /// The account exists on chain (has received TRX at least once). Sending TRX to an
    /// address that does not exist activates it, for an extra fee.
    pub exists: bool,
    /// Sun, decimal string.
    pub balance: String,
    /// Daily free bandwidth (bytes) and what is used of it.
    pub free_bandwidth_limit: u64,
    pub free_bandwidth_used: u64,
    /// Bandwidth from staked TRX.
    pub bandwidth_limit: u64,
    pub bandwidth_used: u64,
    /// Energy from staked TRX.
    pub energy_limit: u64,
    pub energy_used: u64,
}

impl TronAccount {
    pub fn free_bandwidth(&self) -> u64 {
        self.free_bandwidth_limit
            .saturating_sub(self.free_bandwidth_used)
    }
    pub fn staked_bandwidth(&self) -> u64 {
        self.bandwidth_limit.saturating_sub(self.bandwidth_used)
    }
    pub fn energy(&self) -> u64 {
        self.energy_limit.saturating_sub(self.energy_used)
    }
}

pub async fn account(ctx: &TronCtx<'_>, address: &str) -> AppResult<TronAccount> {
    wallet_core::tron_address_bytes(address)?;
    let a = address.trim();
    let acc = request(
        ctx,
        "/wallet/getaccount",
        Some(json!({ "address": a, "visible": true })),
    )
    .await?;
    let res = request(
        ctx,
        "/wallet/getaccountresource",
        Some(json!({ "address": a, "visible": true })),
    )
    .await?;
    Ok(TronAccount {
        address: a.to_owned(),
        exists: acc.get("address").is_some() || acc.get("create_time").is_some(),
        balance: u64_at(&acc, "balance").to_string(),
        free_bandwidth_limit: u64_at(&res, "freeNetLimit"),
        free_bandwidth_used: u64_at(&res, "freeNetUsed"),
        bandwidth_limit: u64_at(&res, "NetLimit"),
        bandwidth_used: u64_at(&res, "NetUsed"),
        energy_limit: u64_at(&res, "EnergyLimit"),
        energy_used: u64_at(&res, "EnergyUsed"),
    })
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TronParams {
    /// Sun burned per unit of energy (`getEnergyFee`).
    pub energy_fee: u64,
    /// Sun burned per byte of bandwidth (`getTransactionFee`).
    pub bandwidth_fee: u64,
    /// Sun burned when an account is created by a transfer (`getCreateNewAccountFeeInSystemContract`).
    pub create_account_fee: u64,
    /// Sun burned instead of staked bandwidth for creating an account (`getCreateAccountFee`).
    pub create_account_bandwidth_fee: u64,
    /// Highest `fee_limit` (`getMaxFeeLimit`).
    pub max_fee_limit: u64,
}

pub async fn params(ctx: &TronCtx<'_>) -> AppResult<TronParams> {
    let v = request(ctx, "/wallet/getchainparameters", Some(json!({}))).await?;
    let list = v["chainParameter"]
        .as_array()
        .ok_or_else(|| bad("TRON : paramètres de chaîne absents"))?;
    let get = |k: &str| {
        list.iter()
            .find(|p| p["key"] == k)
            .and_then(|p| p["value"].as_u64())
            .ok_or_else(|| bad(format!("TRON : paramètre {k} absent")))
    };
    Ok(TronParams {
        energy_fee: get("getEnergyFee")?,
        bandwidth_fee: get("getTransactionFee")?,
        create_account_fee: get("getCreateNewAccountFeeInSystemContract")?,
        create_account_bandwidth_fee: get("getCreateAccountFee")?,
        max_fee_limit: get("getMaxFeeLimit")?,
    })
}

/// `balanceOf(address)` of a TRC-20 contract, raw units (decimal string).
pub async fn trc20_balance(ctx: &TronCtx<'_>, contract: &str, address: &str) -> AppResult<String> {
    let who = wallet_core::tron_address_bytes(address)?;
    wallet_core::tron_address_bytes(contract)?;
    let v = request(
        ctx,
        "/wallet/triggerconstantcontract",
        Some(json!({
            "owner_address": address.trim(), "contract_address": contract.trim(),
            "function_selector": "balanceOf(address)",
            "parameter": format!("{:0>64}", hex::encode(&who[1..])), "visible": true
        })),
    )
    .await?;
    let r = v["constant_result"][0]
        .as_str()
        .filter(|r| r.len() == 64)
        .ok_or_else(|| bad("TRON : balanceOf sans résultat"))?;
    let raw = hex::decode(r).map_err(|_| bad("TRON : balanceOf invalide"))?;
    Ok(be_to_decimal(&raw))
}

fn be_to_decimal(be: &[u8]) -> String {
    // Repeated division by 10 on a big-endian byte string (≤ 32 bytes): no float, no overflow.
    let mut n = be.to_vec();
    let mut digits = Vec::new();
    while n.iter().any(|b| *b != 0) {
        let mut rem = 0u32;
        for b in n.iter_mut() {
            let cur = (rem << 8) | u32::from(*b);
            *b = (cur / 10) as u8;
            rem = cur % 10;
        }
        digits.push(b'0' + rem as u8);
    }
    if digits.is_empty() {
        return "0".into();
    }
    digits.reverse();
    String::from_utf8(digits).unwrap_or_default()
}

/// Energy a TRC-20 call would use, by simulation (`energy_used` + `energy_penalty`). A call
/// that reverts (insufficient token balance, paused token…) is an error: nothing is built.
pub async fn simulate_energy(
    ctx: &TronCtx<'_>,
    owner: &str,
    contract: &str,
    data: &[u8],
) -> AppResult<u64> {
    if data.len() < 4 {
        return Err(AppError::InvalidInput(
            "données d'appel trop courtes".into(),
        ));
    }
    let v = request(
        ctx,
        "/wallet/triggerconstantcontract",
        Some(json!({
            "owner_address": owner, "contract_address": contract,
            "function_selector": "transfer(address,uint256)",
            "parameter": hex::encode(&data[4..]), "visible": true
        })),
    )
    .await?;
    if v["result"]["result"] != true {
        return Err(bad(format!(
            "TRON : simulation refusée ({})",
            message(&v["result"])
        )));
    }
    if let Some(ret) = v["transaction"]["ret"][0]["ret"].as_str() {
        if ret != "SUCESS" && ret != "SUCCESS" {
            return Err(AppError::InvalidInput(format!(
                "le transfert de token échouerait ({ret}) : solde de token insuffisant ?"
            )));
        }
    }
    Ok(u64_at(&v, "energy_used") + u64_at(&v, "energy_penalty"))
}

/// TronGrid error messages are often hex-encoded text.
pub(crate) fn message(v: &Value) -> String {
    let m = v["message"].as_str().unwrap_or("");
    hex::decode(m)
        .ok()
        .and_then(|b| String::from_utf8(b).ok())
        .unwrap_or_else(|| m.to_owned())
        .chars()
        .take(300)
        .collect()
}

/// Resources and TRX burned, shown in the dialog.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TronEstimate {
    /// Bytes charged (signed size + 64).
    pub bandwidth_needed: u64,
    pub free_bandwidth: u64,
    pub staked_bandwidth: u64,
    /// Sun burned for bandwidth if neither free nor staked bandwidth covers it.
    pub bandwidth_burn: String,
    /// TRX transfer to an address that does not exist yet: activation, sun (0 otherwise).
    pub activation_fee: String,
    pub recipient_exists: bool,
    /// TRC-20: simulated energy, energy available from staking.
    pub energy_needed: u64,
    pub energy_available: u64,
    /// Sun per energy.
    pub energy_fee: u64,
    /// Expected sun burned for energy (energy not covered × energy_fee).
    pub energy_burn: String,
    /// `fee_limit` of the transaction: maximum sun burned for energy.
    pub fee_limit: String,
    /// Expected total burned: bandwidth + activation + energy (sun).
    pub total_burn: String,
    /// Upper bound: bandwidth + activation + fee_limit (sun).
    pub total_burn_max: String,
    /// Sun, our balance.
    pub balance: String,
}

pub struct EstimateInput<'a> {
    pub account: &'a TronAccount,
    pub params: TronParams,
    pub raw_size: usize,
    pub recipient_exists: bool,
    pub is_trx: bool,
    pub energy_needed: u64,
    pub fee_limit: u64,
}

pub fn estimate(i: &EstimateInput<'_>) -> TronEstimate {
    let raw = i.raw_size as u64;
    let varint = if raw < 128 { 1 } else { 2 };
    let needed = raw + varint + SIGNED_OVERHEAD + RESULT_SIZE;
    let (free, staked) = (i.account.free_bandwidth(), i.account.staked_bandwidth());
    let creates = i.is_trx && !i.recipient_exists;
    let (bandwidth_burn, activation) = if creates {
        // Account creation: staked bandwidth or a fixed burn, plus the creation fee.
        let bw = if staked >= needed {
            0
        } else {
            i.params.create_account_bandwidth_fee
        };
        (0, i.params.create_account_fee + bw)
    } else if staked >= needed || free >= needed {
        (0, 0)
    } else {
        (needed * i.params.bandwidth_fee, 0)
    };
    let energy_available = i.account.energy();
    // Energy not covered by staking is paid in TRX, never more than fee_limit.
    let energy_burn = if i.is_trx {
        0
    } else {
        i.energy_needed
            .saturating_sub(energy_available)
            .saturating_mul(i.params.energy_fee)
            .min(i.fee_limit)
    };
    TronEstimate {
        bandwidth_needed: needed,
        free_bandwidth: free,
        staked_bandwidth: staked,
        bandwidth_burn: bandwidth_burn.to_string(),
        activation_fee: activation.to_string(),
        recipient_exists: i.recipient_exists,
        energy_needed: i.energy_needed,
        energy_available,
        energy_fee: i.params.energy_fee,
        energy_burn: energy_burn.to_string(),
        fee_limit: i.fee_limit.to_string(),
        total_burn: (bandwidth_burn + activation + energy_burn).to_string(),
        total_burn_max: (bandwidth_burn + activation + i.fee_limit).to_string(),
        balance: i.account.balance.clone(),
    }
}

/// `fee_limit` for a simulated energy: +30 %, at least 1 TRX, at most the chain maximum.
pub fn fee_limit_for(energy: u64, p: &TronParams) -> u64 {
    (energy.saturating_mul(p.energy_fee) * FEE_LIMIT_MARGIN_PCT / 100)
        .max(MIN_FEE_LIMIT)
        .min(p.max_fee_limit)
}

/// Resources for a decoded transaction, re-read live (used by the dialog).
pub async fn estimate_for(ctx: &TronCtx<'_>, summary: &TronTxSummary) -> AppResult<TronEstimate> {
    let acc = account(ctx, &summary.owner).await?;
    let p = params(ctx).await?;
    let fee_limit: u64 = summary.fee_limit.parse().unwrap_or(0);
    let (is_trx, recipient_exists, energy) = match &summary.action {
        TronAction::TrxTransfer { to, .. } => (true, account(ctx, to).await?.exists, 0),
        TronAction::Trc20Transfer {
            contract,
            to,
            amount,
            ..
        } => {
            let data = wallet_core::tron_trc20_transfer_data(to, amount)?;
            (
                false,
                true,
                simulate_energy(ctx, &summary.owner, contract, &data).await?,
            )
        }
        // Unknown call: no simulation; the fee_limit is the bound shown.
        TronAction::ContractCall { .. } => (false, true, 0),
    };
    Ok(estimate(&EstimateInput {
        account: &acc,
        params: p,
        raw_size: summary.raw_size,
        recipient_exists,
        is_trx,
        energy_needed: energy,
        fee_limit,
    }))
}

/// Refuses a transaction that is expired or expires more than 24 h ahead.
pub fn check_expiration(summary: &TronTxSummary, now_ms: i64) -> AppResult<()> {
    check_expiration_ms(summary.expiration, now_ms)
}

/// Same rule from the expiration alone (staking transactions).
pub fn check_expiration_ms(expiration: i64, now_ms: i64) -> AppResult<()> {
    if expiration <= now_ms {
        return Err(AppError::InvalidInput(
            "transaction TRON expirée : reconstruis-la".into(),
        ));
    }
    if expiration > now_ms + MAX_EXPIRATION_MS {
        return Err(AppError::InvalidInput(
            "expiration TRON à plus de 24 h : refusée".into(),
        ));
    }
    Ok(())
}

/// Broadcasts `Transaction { raw_data, signature }` with `/wallet/broadcasthex`; the server's
/// txid must be `sha256(raw_data)`.
pub async fn broadcast(
    ctx: &TronCtx<'_>,
    raw_hex: &str,
    signature: &[u8; 65],
) -> AppResult<String> {
    let raw = hex::decode(raw_hex.trim())
        .map_err(|_| AppError::InvalidInput("raw_data : hexadécimal attendu".into()))?;
    let tx = wallet_core::TronRaw::decode(&raw)?;
    let txid = hex::encode(tx.txid());
    let signed = wallet_core::tron_signed_transaction(raw_hex, signature)?;
    let v = request(
        ctx,
        "/wallet/broadcasthex",
        Some(json!({ "transaction": signed })),
    )
    .await?;
    if v["result"] != true {
        return Err(AppError::InvalidInput(format!(
            "diffusion TRON refusée : {} {}",
            v["code"].as_str().unwrap_or(""),
            message(&v)
        )));
    }
    let got = v["txid"].as_str().unwrap_or("");
    if got != txid {
        return Err(bad(format!(
            "le serveur a répondu un txid inattendu ({})",
            got.chars().take(80).collect::<String>()
        )));
    }
    Ok(txid)
}

/// Normalized history (TronGrid `/v1`): TRX transfers and TRC-20 transfers, newest first,
/// 50 of each at most.
pub async fn history(ctx: &TronCtx<'_>, address: &str) -> AppResult<Value> {
    wallet_core::tron_address_bytes(address)?;
    let a = address.trim();
    let hexaddr = |h: &str| -> Option<String> {
        let b: [u8; 21] = hex::decode(h).ok()?.try_into().ok()?;
        Some(wallet_core::tron_address_from_bytes(&b))
    };
    let mut out = Vec::new();
    let trx = request(
        ctx,
        &format!("/v1/accounts/{a}/transactions?limit=50"),
        None,
    )
    .await
    .map_err(|e| match e {
        AppError::ServerUnreachable(m) => {
            AppError::ServerUnreachable(format!("{m} (l'historique exige l'API /v1 de TronGrid)"))
        }
        other => other,
    })?;
    for t in trx["data"].as_array().into_iter().flatten() {
        let c = &t["raw_data"]["contract"][0];
        if c["type"] != "TransferContract" {
            continue;
        }
        let v = &c["parameter"]["value"];
        out.push(json!({
            "txid": t["txID"], "kind": "trx",
            "from": v["owner_address"].as_str().and_then(hexaddr),
            "to": v["to_address"].as_str().and_then(hexaddr),
            "amount": v["amount"].as_u64().unwrap_or(0).to_string(),
            "timestamp": t["block_timestamp"],
            "status": if t["ret"][0]["contractRet"] == "SUCCESS" { "confirmed" } else { "failed" },
        }));
    }
    let trc20 = request(
        ctx,
        &format!("/v1/accounts/{a}/transactions/trc20?limit=50"),
        None,
    )
    .await?;
    for t in trc20["data"].as_array().into_iter().flatten() {
        out.push(json!({
            "txid": t["transaction_id"], "kind": "trc20",
            "from": t["from"], "to": t["to"], "amount": t["value"],
            "token": { "contract": t["token_info"]["address"], "symbol": t["token_info"]["symbol"],
                       "decimals": t["token_info"]["decimals"] },
            "timestamp": t["block_timestamp"], "status": "confirmed",
        }));
    }
    out.sort_by_key(|t| std::cmp::Reverse(t["timestamp"].as_i64().unwrap_or(i64::MAX)));
    Ok(Value::Array(out))
}

/// Network check: block 0's id must be the chain's (mainnet or Nile).
pub async fn probe(ctx: &TronCtx<'_>) -> AppResult<Detected> {
    let v = request(ctx, "/wallet/getblockbynum", Some(json!({ "num": 0 }))).await?;
    let found = v["blockID"].as_str().unwrap_or("").to_owned();
    let want = match ctx.network {
        Network::Mainnet => "mainnet",
        Network::Testnet => "nile",
    };
    let expected = TRON_GENESIS
        .iter()
        .find(|(n, _)| *n == want)
        .map(|(_, g)| *g)
        .unwrap_or_default();
    if found != expected {
        let what = TRON_GENESIS
            .iter()
            .find(|(_, g)| *g == found)
            .map_or("réseau inconnu", |(n, _)| n);
        return Err(AppError::ServerWrongNetwork(format!(
            "ce serveur TRON est sur {what}, pas sur {want}"
        )));
    }
    let height = now_block(ctx).await.ok().map(|b| b.0);
    Ok(Detected {
        network: Some(want.into()),
        genesis_hash: Some(found),
        block_height: height,
        ..Default::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn acc(free: u64, staked: u64, energy: u64) -> TronAccount {
        TronAccount {
            free_bandwidth_limit: 600,
            free_bandwidth_used: 600 - free,
            bandwidth_limit: staked,
            energy_limit: energy,
            balance: "150000000".into(),
            exists: true,
            ..Default::default()
        }
    }

    const P: TronParams = TronParams {
        energy_fee: 100,
        bandwidth_fee: 1_000,
        create_account_fee: 1_000_000,
        create_account_bandwidth_fee: 100_000,
        max_fee_limit: 15_000_000_000,
    };

    #[test]
    fn bandwidth_activation_and_energy() {
        // 101-byte TRX transfer raw_data → 101+1+70+64 = 236 bytes.
        let mut i = EstimateInput {
            account: &acc(600, 0, 0),
            params: P,
            raw_size: 101,
            recipient_exists: true,
            is_trx: true,
            energy_needed: 0,
            fee_limit: 0,
        };
        let e = estimate(&i);
        assert_eq!(e.bandwidth_needed, 236);
        assert_eq!(
            (e.bandwidth_burn.as_str(), e.activation_fee.as_str()),
            ("0", "0")
        );
        // No free bandwidth left: 236 × 1 000 sun.
        let a = acc(100, 0, 0);
        i.account = &a;
        assert_eq!(estimate(&i).bandwidth_burn, "236000");
        // New recipient without staked bandwidth: 1 TRX + 0.1 TRX.
        let a = acc(600, 0, 0);
        i.account = &a;
        i.recipient_exists = false;
        let e = estimate(&i);
        assert_eq!(e.activation_fee, "1100000");
        assert_eq!(e.total_burn, "1100000");
        // TRC-20: 30 000 energy, none staked, fee_limit 3.9 TRX.
        i.is_trx = false;
        i.recipient_exists = true;
        i.raw_size = 210;
        i.energy_needed = 30_000;
        i.fee_limit = fee_limit_for(30_000, &P);
        let e = estimate(&i);
        assert_eq!(e.fee_limit, "3900000");
        assert_eq!(e.energy_burn, "3000000");
        assert_eq!(e.total_burn_max, "3900000");
        assert_eq!(fee_limit_for(10, &P), MIN_FEE_LIMIT);
    }

    #[test]
    fn decimal_of_big_endian() {
        assert_eq!(be_to_decimal(&[0; 32]), "0");
        let mut b = [0u8; 32];
        b[31] = 0x50;
        b[30] = 0xb4;
        b[29] = 0x3b;
        b[28] = 0x01;
        assert_eq!(be_to_decimal(&b), "20690000");
        assert_eq!(
            be_to_decimal(&[0xff; 32]),
            "115792089237316195423570985008687907853269984665640564039457584007913129639935"
        );
    }

    #[test]
    fn hex_messages_and_expiration() {
        assert_eq!(message(&json!({ "message": "6f6f7073" })), "oops");
        assert_eq!(message(&json!({ "message": "plain" })), "plain");
        let s = wallet_core::TronTxSummary {
            txid: String::new(),
            owner: String::new(),
            action: TronAction::TrxTransfer {
                to: String::new(),
                amount: "1".into(),
            },
            fee_limit: "0".into(),
            expiration: 1_000_000,
            timestamp: 0,
            ref_block_bytes: String::new(),
            ref_block_hash: String::new(),
            memo: String::new(),
            memo_text: None,
            raw_size: 0,
            warnings: vec![],
            requires_extra_confirmation: false,
        };
        assert!(check_expiration(&s, 999_999).is_ok());
        assert!(check_expiration(&s, 1_000_000).is_err());
        assert!(check_expiration(&s, 1_000_000 - MAX_EXPIRATION_MS - 1).is_err());
    }
}

/// Real-network test on Nile (and a mainnet probe) over Tor. Run with
/// `cargo test -p kyro-desktop -- --ignored --nocapture tron_live`.
/// `KYRO_TRON_BROADCAST=yes` also broadcasts the TRX transfer, from the public Trezor test
/// wallet (`all ×12`, m/44'/195'/0'/0/0) to its own next address (m/44'/195'/0'/0/1).
#[cfg(test)]
mod live {
    use super::*;
    use crate::tor::TorState;
    use std::time::Instant;

    const ALL: &str = "all all all all all all all all all all all all";

    #[test]
    #[ignore]
    fn tron_live_nile_over_tor() {
        let net = NetClient::new(std::env::temp_dir().join("kyro-tron-live")).unwrap();
        let seed = wallet_core::Mnemonic::parse(ALL).unwrap().to_seed("");
        let abandon = wallet_core::Mnemonic::parse(
            "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
        )
        .unwrap()
        .to_seed("");
        tauri::async_runtime::block_on(async {
            let t0 = Instant::now();
            net.tor.restart();
            while net.tor.status().state != TorState::Ready {
                assert_ne!(net.tor.status().state, TorState::Error);
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            }
            eprintln!("tor ready in {:.1?}", t0.elapsed());
            let c = TronCtx {
                net_client: &net,
                network: Network::Testnet,
                tor: true,
                server: TronServer::Default,
                api_key: std::env::var("KYRO_TRONGRID_API_KEY").ok(),
            };
            let main = TronCtx {
                net_client: &net,
                network: Network::Mainnet,
                tor: true,
                server: TronServer::Default,
                api_key: None,
            };
            let t = Instant::now();
            eprintln!(
                "nile probe {:?} in {:.1?}",
                probe(&c).await.unwrap(),
                t.elapsed()
            );
            for attempt in 1..=3 {
                // Informative: TronGrid mainnet may refuse Tor exits without an API key.
                let r = probe(&main).await;
                eprintln!("mainnet probe (attempt {attempt}): {r:?}");
                if r.is_ok() {
                    break;
                }
            }
            let wrong = TronCtx {
                net_client: &net,
                network: Network::Testnet,
                tor: true,
                server: TronServer::Http {
                    url: "https://api.trongrid.io".into(),
                },
                api_key: None,
            };
            let e = probe(&wrong).await;
            eprintln!("wrong network: {e:?}");
            assert!(matches!(e, Err(AppError::ServerWrongNetwork(_))));

            let me = wallet_core::tron_address(&seed, 0).unwrap();
            let next = wallet_core::tron_address(&seed, 1).unwrap();
            let a0 = wallet_core::tron_address(&abandon, 0).unwrap();
            for a in [&a0, &me, &next] {
                eprintln!("account {a}: {:?}", account(&c, a).await.unwrap());
            }
            let p = params(&c).await.unwrap();
            eprintln!("params {p:?}");
            let h = history(&c, &me).await.unwrap();
            eprintln!(
                "history of {me}: {} entries, first {}",
                h.as_array().unwrap().len(),
                h.as_array()
                    .unwrap()
                    .first()
                    .map(|v| v.to_string())
                    .unwrap_or_default()
            );

            // java-tron's own createtransaction (unsigned, never used to sign) vs Kyro's encoder
            // with the same reference block, expiration and timestamp: byte for byte.
            let server = request(
                &c,
                "/wallet/createtransaction",
                Some(json!({
                    "owner_address": me, "to_address": next, "amount": 1_000_000, "visible": true
                })),
            )
            .await
            .unwrap();
            let rd = &server["raw_data"];
            let theirs = server["raw_data_hex"].as_str().unwrap().to_owned();
            let ours = wallet_core::TronRaw {
                ref_block_bytes: hex::decode(rd["ref_block_bytes"].as_str().unwrap())
                    .unwrap()
                    .try_into()
                    .unwrap(),
                ref_block_hash: hex::decode(rd["ref_block_hash"].as_str().unwrap())
                    .unwrap()
                    .try_into()
                    .unwrap(),
                expiration: rd["expiration"].as_i64().unwrap(),
                memo: Vec::new(),
                contract: wallet_core::TronContract::Transfer {
                    owner: wallet_core::tron_address_bytes(&me).unwrap(),
                    to: wallet_core::tron_address_bytes(&next).unwrap(),
                    amount: 1_000_000,
                },
                timestamp: rd["timestamp"].as_i64().unwrap_or(0),
                fee_limit: 0,
            };
            assert_eq!(
                hex::encode(ours.encode()),
                theirs,
                "Kyro's encoder = java-tron's createtransaction"
            );
            assert_eq!(hex::encode(ours.txid()), server["txID"].as_str().unwrap());
            eprintln!(
                "createtransaction matches Kyro's encoding byte for byte ({} bytes)",
                theirs.len() / 2
            );

            // Kyro-built TRX transfer, signed and checked (decode, recovery).
            let now = || {
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_millis() as i64
            };
            let trx = crate::commands_tron::build(&c, &me, &next, "1000000", None)
                .await
                .unwrap();
            let (sig, s) = wallet_core::tron_sign(&seed, 0, &trx.raw).unwrap();
            assert_eq!(s, trx.summary);
            assert_eq!(
                wallet_core::tron_recover_signer(&trx.raw, &sig).unwrap(),
                me
            );
            check_expiration(&s, now()).unwrap();
            eprintln!(
                "--- dialog (TRX) ---\n{}\n---",
                crate::commands_tron::describe_tron(
                    crate::i18n::Lang::Fr,
                    &s,
                    &trx.estimate,
                    Network::Testnet,
                    now()
                )
            );

            // Kyro-built TRC-20 transfer of a token the test wallet holds, signed and checked.
            let token = "TFT7sNiNDGZcqL7z7dwXUPpxrx1Ewk8iGL";
            eprintln!(
                "token balance {}",
                trc20_balance(&c, token, &me).await.unwrap()
            );
            let t20 =
                crate::commands_tron::build(&c, &me, &next, "1000000000000000000", Some(token))
                    .await
                    .unwrap();
            let (sig20, s20) = wallet_core::tron_sign(&seed, 0, &t20.raw).unwrap();
            assert_eq!(
                wallet_core::tron_recover_signer(&t20.raw, &sig20).unwrap(),
                me
            );
            assert!(matches!(
                s20.action,
                wallet_core::TronAction::Trc20Transfer { .. }
            ));
            eprintln!(
                "--- dialog (TRC-20) ---\n{}\n---",
                crate::commands_tron::describe_tron(
                    crate::i18n::Lang::Fr,
                    &s20,
                    &t20.estimate,
                    Network::Testnet,
                    now()
                )
            );
            // Nile USDT: the test wallet holds none, the simulation must refuse to build.
            let usdt = crate::commands_tron::build(
                &c,
                &me,
                &next,
                "1000000",
                Some("TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf"),
            )
            .await;
            eprintln!(
                "USDT build with 0 balance: {:?}",
                usdt.as_ref().map(|b| &b.txid)
            );
            if let Ok(b) = &usdt {
                let (sig, _) = wallet_core::tron_sign(&seed, 0, &b.raw).unwrap();
                assert_eq!(wallet_core::tron_recover_signer(&b.raw, &sig).unwrap(), me);
            }

            if std::env::var("KYRO_TRON_BROADCAST").as_deref() == Ok("yes") {
                let txid =
                    crate::commands_tron::broadcast_checked(&c, &me, &trx.raw, &hex::encode(sig))
                        .await
                        .unwrap();
                eprintln!("BROADCAST OK: {txid}");
                for _ in 0..20 {
                    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                    let info = request(
                        &c,
                        "/wallet/gettransactioninfobyid",
                        Some(json!({ "value": txid })),
                    )
                    .await
                    .unwrap();
                    if info.get("blockNumber").is_some() {
                        eprintln!("confirmed: {info}");
                        break;
                    }
                }
                eprintln!("recipient now: {:?}", account(&c, &next).await.unwrap());
            }
        });
    }

    /// One TRC-20 self-send on Nile through the real path: Kyro builds, Rust decodes, the
    /// dialog text is the one `tron_sign_tx` shows (resources re-read live), signature with the
    /// identical-summary check, `tron_broadcast`'s checks, then the energy actually burned is
    /// compared with the announcement. From the public "abandon … about" Tron address if it holds
    /// the token and has staked energy, else from the public Trezor test wallet (`all ×12`).
    /// Broadcasts only with `KYRO_TRON_TRC20=yes`.
    /// `cargo test -p kyro-desktop -- --ignored --nocapture tron_live_trc20`
    #[test]
    #[ignore]
    fn tron_live_trc20_self_send() {
        let net = NetClient::new(std::env::temp_dir().join("kyro-tron-live")).unwrap();
        let token = "TFT7sNiNDGZcqL7z7dwXUPpxrx1Ewk8iGL";
        let amount = "1000000000000000000";
        tauri::async_runtime::block_on(async {
            net.tor.restart();
            while net.tor.status().state != TorState::Ready {
                assert_ne!(net.tor.status().state, TorState::Error);
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            }
            let c = TronCtx {
                net_client: &net,
                network: Network::Testnet,
                tor: true,
                server: TronServer::Default,
                api_key: std::env::var("KYRO_TRONGRID_API_KEY").ok(),
            };
            let mut chosen = None;
            for phrase in [
                "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
                ALL,
            ] {
                let seed = wallet_core::Mnemonic::parse(phrase).unwrap().to_seed("");
                let me = wallet_core::tron_address(&seed, 0).unwrap();
                let bal: u128 = trc20_balance(&c, token, &me).await.unwrap().parse().unwrap_or(u128::MAX);
                let acc = account(&c, &me).await.unwrap();
                eprintln!("{me}: token balance {bal}, energy available {}", acc.energy());
                if bal >= 1_000_000_000_000_000_000 && (acc.energy() > 0 || phrase == ALL) {
                    chosen = Some((seed, me));
                    break;
                }
            }
            let (seed, me) = chosen.expect("a public test wallet holding the token");
            let built = crate::commands_tron::build(&c, &me, &me, amount, Some(token))
                .await
                .unwrap();
            let summary = wallet_core::tron_decode_raw(&built.raw, &me).unwrap();
            assert_eq!(summary, built.summary);
            let now = || {
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_millis() as i64
            };
            check_expiration(&summary, now()).unwrap();
            let est = estimate_for(&c, &summary).await.unwrap();
            eprintln!(
                "--- dialog ---
{}
---",
                crate::commands_tron::describe_tron(
                    crate::i18n::Lang::Fr,
                    &summary,
                    &est,
                    Network::Testnet,
                    now()
                )
            );
            assert!(!summary.requires_extra_confirmation);
            let (sig, again) = wallet_core::tron_sign(&seed, 0, &built.raw).unwrap();
            assert_eq!(again, summary, "identical summary");
            if std::env::var("KYRO_TRON_TRC20").as_deref() != Ok("yes") {
                eprintln!("KYRO_TRON_TRC20 != yes: not broadcast");
                return;
            }
            let txid =
                crate::commands_tron::broadcast_checked(&c, &me, &built.raw, &hex::encode(sig))
                    .await
                    .unwrap();
            eprintln!("BROADCAST OK: {txid}");
            for _ in 0..30 {
                tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                let info = request(
                    &c,
                    "/wallet/gettransactioninfobyid",
                    Some(json!({ "value": txid })),
                )
                .await
                .unwrap();
                if info.get("blockNumber").is_some() {
                    let r = &info["receipt"];
                    eprintln!(
                        "confirmed in block {} : result {}",
                        info["blockNumber"], r["result"]
                    );
                    eprintln!(
                        "energy: announced {} needed / {} available / {} sun burned (fee_limit {}) — actual: energy_usage_total {}, from stake {}, energy_fee {} sun; bandwidth: announced {} bytes, actual net_usage {} net_fee {}; total fee {}",
                        est.energy_needed, est.energy_available, est.energy_burn, est.fee_limit,
                        r["energy_usage_total"], r["energy_usage"], r["energy_fee"],
                        est.bandwidth_needed, r["net_usage"], r["net_fee"], info["fee"]
                    );
                    return;
                }
            }
            panic!("{txid} not confirmed");
        });
    }
}
