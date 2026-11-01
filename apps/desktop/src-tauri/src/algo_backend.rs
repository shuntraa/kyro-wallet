//! Algorand data from the public AlgoNode / Nodely endpoints (algod for accounts, parameters,
//! submission and pending status; indexer for history), on the `algorand` Tor family, never with a
//! fallback.
//!
//! Kyro fills `fee`, `fv`, `lv`, `gen` and `gh` itself from `/v2/transactions/params` and encodes
//! the payment with wallet-core: a server-built transaction is never signed.

use serde::Serialize;
use serde_json::{json, Value};
use wallet_core::Network;

use crate::error::{AppError, AppResult};
use crate::net::{Family, NetClient, ServerRequest};

/// `lv` = `fv` + this (≈ 9 min at ≈ 2.8 s per round; protocol maximum 1000).
pub const LV_OFFSET: u64 = 200;
const MAX_TXS: u32 = 50;
const SIGNATURE_OVERHEAD: u64 = 75;

pub struct AlgoCtx<'a> {
    pub net_client: &'a NetClient,
    pub network: Network,
    pub tor: bool,
}

/// algod (accounts, parameters, submission) of the network.
pub fn algod_url(net: Network) -> &'static str {
    match net {
        Network::Mainnet => "https://mainnet-api.algonode.cloud",
        Network::Testnet => "https://testnet-api.algonode.cloud",
    }
}

/// Indexer (history) of the network.
pub fn indexer_url(net: Network) -> &'static str {
    match net {
        Network::Mainnet => "https://mainnet-idx.algonode.cloud",
        Network::Testnet => "https://testnet-idx.algonode.cloud",
    }
}

fn bad(msg: impl Into<String>) -> AppError {
    AppError::ServerUnreachable(msg.into())
}

fn snippet(bytes: &[u8]) -> String {
    crate::dialog_text::sanitize(&String::from_utf8_lossy(bytes), 200)
}

async fn send(ctx: &AlgoCtx<'_>, req: ServerRequest, what: &str) -> AppResult<(u16, Value)> {
    let (status, bytes) = ctx.net_client.server_request(req, ctx.tor).await?;
    let v: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    if !(200..300).contains(&status) && status != 404 && status != 400 {
        return Err(bad(format!(
            "Algorand: HTTP {status} on {what} ({})",
            snippet(&bytes)
        )));
    }
    if v.is_null() && status == 200 {
        return Err(bad(format!("Algorand: invalid JSON on {what}")));
    }
    Ok((status, v))
}

async fn get(ctx: &AlgoCtx<'_>, base: &str, path: &str) -> AppResult<(u16, Value)> {
    let u = url::Url::parse(&format!("{base}{path}"))
        .map_err(|_| AppError::Internal("invalid Algorand URL".into()))?;
    send(ctx, ServerRequest::get(u, Family::Algorand), path).await
}

fn u64_at(v: &Value) -> Option<u64> {
    v.as_u64()
}

/// `/v2/transactions/params`, genesis checked against the app's network.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlgoParams {
    /// µALGO per byte (0 when the network is not congested).
    pub fee_per_byte: u64,
    /// µALGO.
    pub min_fee: u64,
    pub genesis_id: String,
    /// Base64.
    pub genesis_hash: String,
    pub last_round: u64,
}

impl AlgoParams {
    /// Flat fee for a transaction whose unsigned encoding is `unsigned_len` bytes.
    pub fn fee_for(&self, unsigned_len: usize) -> u64 {
        let size = unsigned_len as u64 + SIGNATURE_OVERHEAD;
        self.min_fee
            .max(wallet_core::ALGO_MIN_FEE)
            .max(self.fee_per_byte.saturating_mul(size))
    }
}

pub fn parse_params(v: &Value, net: Network) -> AppResult<AlgoParams> {
    let gen = v["genesis-id"].as_str().unwrap_or_default().to_owned();
    let gh = v["genesis-hash"].as_str().unwrap_or_default().to_owned();
    let (want_id, want_b64) = match net {
        Network::Mainnet => wallet_core::ALGO_MAINNET_GENESIS,
        Network::Testnet => wallet_core::ALGO_TESTNET_GENESIS,
    };
    if gen != want_id || gh != want_b64 {
        return Err(AppError::ServerWrongNetwork(format!(
            "this Algorand server is on \"{}\", not on {want_id}",
            crate::dialog_text::sanitize(&gen, 32)
        )));
    }
    Ok(AlgoParams {
        fee_per_byte: u64_at(&v["fee"]).unwrap_or(0),
        min_fee: u64_at(&v["min-fee"]).ok_or_else(|| bad("Algorand: min-fee missing"))?,
        genesis_id: gen,
        genesis_hash: gh,
        last_round: u64_at(&v["last-round"]).ok_or_else(|| bad("Algorand: last-round missing"))?,
    })
}

pub async fn params(ctx: &AlgoCtx<'_>) -> AppResult<AlgoParams> {
    let (status, v) = get(ctx, algod_url(ctx.network), "/v2/transactions/params").await?;
    if status != 200 {
        return Err(bad(format!("Algorand: HTTP {status} on the parameters")));
    }
    parse_params(&v, ctx.network)
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AlgoAccountInfo {
    pub address: String,
    /// The account holds ALGO (an empty account does not exist on chain).
    pub exists: bool,
    /// µALGO, decimal string (pending rewards included, as algod reports it).
    pub balance: String,
    /// µALGO the account must keep: 0.1 ALGO + 0.1 per asset / application opted in (and more
    /// for created applications), as computed by algod.
    pub min_balance: String,
    /// µALGO: balance − minimum balance (0 if negative).
    pub spendable: String,
    /// Assets opted in (each one raises the minimum balance by 0.1 ALGO).
    pub assets: u64,
    /// `auth-addr`: the account was rekeyed to this address; Kyro's key no longer signs for it.
    pub auth_addr: Option<String>,
    pub round: u64,
}

pub fn parse_account(v: &Value, address: &str) -> AppResult<AlgoAccountInfo> {
    let balance = u64_at(&v["amount"]).ok_or_else(|| bad("Algorand: balance missing"))?;
    let min = u64_at(&v["min-balance"]).unwrap_or(wallet_core::ALGO_MIN_BALANCE);
    let auth = v["auth-addr"]
        .as_str()
        .filter(|a| !a.is_empty() && *a != address)
        .map(|a| crate::dialog_text::sanitize(a, 58));
    Ok(AlgoAccountInfo {
        address: address.to_owned(),
        exists: balance > 0,
        balance: balance.to_string(),
        min_balance: min.to_string(),
        spendable: balance.saturating_sub(min).to_string(),
        assets: u64_at(&v["total-assets-opted-in"]).unwrap_or(0),
        auth_addr: auth,
        round: u64_at(&v["round"]).unwrap_or(0),
    })
}

pub async fn account(ctx: &AlgoCtx<'_>, address: &str) -> AppResult<AlgoAccountInfo> {
    let a = address.trim();
    wallet_core::algo_address_bytes(a)?;
    let (status, v) = get(
        ctx,
        algod_url(ctx.network),
        &format!("/v2/accounts/{a}?exclude=all"),
    )
    .await?;
    if status != 200 {
        return Err(bad(format!(
            "Algorand: HTTP {status} on the account ({})",
            crate::dialog_text::sanitize(v["message"].as_str().unwrap_or(""), 120)
        )));
    }
    parse_account(&v, a)
}

/// Our holding of one known asset (algod `/v2/accounts/{a}/assets/{id}`).
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AlgoHolding {
    pub asset_id: u64,
    /// The account opted in (it can receive the asset).
    pub opted_in: bool,
    /// Asset base units, decimal string.
    pub amount: String,
    /// Frozen by the asset's freeze address: it can neither send nor receive.
    pub frozen: bool,
}

/// `200` = opted in (the server's asset id must be ours), `404` = not opted in.
pub fn parse_holding(status: u16, v: &Value, asset_id: u64) -> AppResult<AlgoHolding> {
    match status {
        200 => {
            let h = &v["asset-holding"];
            if u64_at(&h["asset-id"]) != Some(asset_id) {
                return Err(bad("Algorand: response for another asset"));
            }
            Ok(AlgoHolding {
                asset_id,
                opted_in: true,
                amount: u64_at(&h["amount"])
                    .ok_or_else(|| bad("Algorand: asset balance missing"))?
                    .to_string(),
                frozen: h["is-frozen"].as_bool().unwrap_or(false),
            })
        }
        404 => Ok(AlgoHolding {
            asset_id,
            opted_in: false,
            amount: "0".into(),
            frozen: false,
        }),
        s => Err(bad(format!("Algorand: HTTP {s} on asset {asset_id}"))),
    }
}

pub async fn holding(ctx: &AlgoCtx<'_>, address: &str, asset_id: u64) -> AppResult<AlgoHolding> {
    let a = address.trim();
    wallet_core::algo_address_bytes(a)?;
    let (status, v) = get(
        ctx,
        algod_url(ctx.network),
        &format!("/v2/accounts/{a}/assets/{asset_id}"),
    )
    .await?;
    parse_holding(status, &v, asset_id)
}

/// Checks before building / signing an asset transfer or an opt-in, against live data.
pub struct AssetCheck<'a> {
    pub ours: &'a AlgoAccountInfo,
    pub symbol: &'a str,
    pub decimals: u8,
    pub mine: &'a AlgoHolding,
    pub dest: &'a AlgoHolding,
    pub amount: u64,
    pub fee: u64,
    pub opt_in: bool,
}

pub fn check_asset(c: &AssetCheck<'_>) -> AppResult<()> {
    if let Some(auth) = &c.ours.auth_addr {
        return Err(AppError::InvalidInput(format!(
            "this Algorand account was rekeyed to {auth}: Kyro cannot sign for it"
        )));
    }
    if !c.ours.exists {
        return Err(AppError::InvalidInput(
            "your Algorand account is not activated yet: first receive at least 0.2 ALGO".into(),
        ));
    }
    let spendable: u64 = c.ours.spendable.parse().unwrap_or(0);
    let s = c.symbol;
    if c.opt_in {
        if c.mine.opted_in {
            return Err(AppError::InvalidInput(format!(
                "{s} is already enabled on this account"
            )));
        }
        let need = c.fee.saturating_add(wallet_core::ALGO_MIN_BALANCE);
        if spendable < need {
            return Err(AppError::InvalidInput(format!(
                "enabling {s} locks an extra 0.1 ALGO (minimum balance): you need {} available, you have {}",
                algo(need),
                algo(spendable)
            )));
        }
        return Ok(());
    }
    if !c.mine.opted_in {
        return Err(AppError::InvalidInput(format!(
            "{s} is not enabled on this account"
        )));
    }
    if c.mine.frozen {
        return Err(AppError::InvalidInput(format!(
            "your {s} balance is frozen by the issuer: you cannot send it"
        )));
    }
    let have: u64 = c.mine.amount.parse().unwrap_or(0);
    if c.amount > have {
        return Err(AppError::InvalidInput(format!(
            "insufficient {s} balance: {} available",
            crate::commands::format_units(&have.to_string(), usize::from(c.decimals))
        )));
    }
    if c.fee > spendable {
        return Err(AppError::InvalidInput(format!(
            "not enough ALGO for the network fee: {} available (balance − minimum balance), {} needed",
            algo(spendable),
            algo(c.fee)
        )));
    }
    if !c.dest.opted_in {
        return Err(AppError::InvalidInput(format!(
            "this recipient has not enabled {s} (opt-in): they must enable it first, otherwise the transfer is rejected"
        )));
    }
    if c.dest.frozen {
        return Err(AppError::InvalidInput(format!(
            "this recipient's {s} balance is frozen by the issuer: it cannot receive anything"
        )));
    }
    Ok(())
}

/// Last 50 transactions touching `address` (indexer), payments normalized: `[{ id, type, from, to,
/// amount, fee, closeTo, closeAmount, round, time, note }]` (µALGO strings, `time` in ms, `note` =
/// sanitized UTF-8 text or null).
pub fn parse_txs(v: &Value) -> Value {
    let mut out = Vec::new();
    for t in v["transactions"].as_array().into_iter().flatten() {
        let ty = t["tx-type"].as_str().unwrap_or("");
        let pay = &t["payment-transaction"];
        let note = t["note"]
            .as_str()
            .and_then(|n| {
                use base64::Engine as _;
                base64::engine::general_purpose::STANDARD.decode(n).ok()
            })
            .and_then(|b| String::from_utf8(b).ok())
            .map(|s| crate::dialog_text::sanitize(&s, 120));
        let num = |x: &Value| x.as_u64().map(|n| n.to_string());
        let xfer = &t["asset-transfer-transaction"];
        let is_xfer = ty == "axfer" && xfer.is_object();
        out.push(json!({
            "id": t["id"],
            "type": ty,
            "from": t["sender"],
            "to": if ty == "pay" { pay["receiver"].clone() } else if is_xfer { xfer["receiver"].clone() } else { Value::Null },
            "assetId": if is_xfer { xfer["asset-id"].clone() } else { Value::Null },
            "assetAmount": if is_xfer { num(&xfer["amount"]) } else { None },
            "amount": if ty == "pay" { num(&pay["amount"]).unwrap_or_else(|| "0".into()) } else { "0".into() },
            "fee": num(&t["fee"]).unwrap_or_else(|| "0".into()),
            "closeTo": pay["close-remainder-to"],
            "closeAmount": num(&pay["close-amount"]),
            "round": t["confirmed-round"],
            "time": t["round-time"].as_i64().map(|s| s * 1000),
            "note": note,
        }));
    }
    Value::Array(out)
}

pub async fn txs(ctx: &AlgoCtx<'_>, address: &str) -> AppResult<Value> {
    let a = address.trim();
    wallet_core::algo_address_bytes(a)?;
    let (status, v) = get(
        ctx,
        indexer_url(ctx.network),
        &format!("/v2/accounts/{a}/transactions?limit={MAX_TXS}"),
    )
    .await?;
    match status {
        200 => Ok(parse_txs(&v)),
        404 => Ok(json!([])),
        s => Err(bad(format!("Algorand: HTTP {s} on the history"))),
    }
}

/// `POST /v2/transactions` (raw signed msgpack). The server's `txId` must be ours.
pub async fn submit(ctx: &AlgoCtx<'_>, raw: Vec<u8>, txid: &str) -> AppResult<String> {
    let u = url::Url::parse(&format!("{}/v2/transactions", algod_url(ctx.network)))
        .map_err(|_| AppError::Internal("invalid Algorand URL".into()))?;
    let req = ServerRequest::post_bytes(u, Family::Algorand, "application/x-binary", raw);
    let (status, v) = send(ctx, req, "/v2/transactions").await?;
    if status != 200 {
        return Err(AppError::InvalidInput(format!(
            "Algorand payment rejected: {}",
            crate::dialog_text::sanitize(v["message"].as_str().unwrap_or("unknown error"), 240)
        )));
    }
    let got = v["txId"].as_str().unwrap_or("");
    if got != txid {
        return Err(bad(format!(
            "the server returned an unexpected identifier ({})",
            crate::dialog_text::sanitize(got, 80)
        )));
    }
    Ok(txid.to_owned())
}

/// `{ confirmed, round, error }` of a submitted transaction (algod pending pool, then indexer).
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AlgoTxStatus {
    pub confirmed: bool,
    pub round: Option<u64>,
    /// `pool-error`: the transaction was dropped from the pool (never confirmed).
    pub error: Option<String>,
}

pub fn parse_pending(v: &Value) -> AlgoTxStatus {
    let round = v["confirmed-round"].as_u64().filter(|r| *r > 0);
    let err = v["pool-error"]
        .as_str()
        .filter(|e| !e.is_empty())
        .map(|e| crate::dialog_text::sanitize(e, 200));
    AlgoTxStatus {
        confirmed: round.is_some(),
        round,
        error: err,
    }
}

pub async fn tx_status(ctx: &AlgoCtx<'_>, txid: &str) -> AppResult<AlgoTxStatus> {
    let (status, v) = get(
        ctx,
        algod_url(ctx.network),
        &format!("/v2/transactions/pending/{txid}"),
    )
    .await?;
    if status == 200 {
        return Ok(parse_pending(&v));
    }
    let (status, v) = get(
        ctx,
        indexer_url(ctx.network),
        &format!("/v2/transactions/{txid}"),
    )
    .await?;
    if status == 200 {
        let round = v["transaction"]["confirmed-round"].as_u64();
        return Ok(AlgoTxStatus {
            confirmed: round.is_some(),
            round,
            error: None,
        });
    }
    Ok(AlgoTxStatus::default())
}

/// Network check of the default servers (`genesis-id` / `genesis-hash`); used by the live test
/// until custom Algorand servers exist.
#[cfg(test)]
pub async fn probe(ctx: &AlgoCtx<'_>) -> AppResult<crate::btc_backend::Detected> {
    let p = params(ctx).await?;
    Ok(crate::btc_backend::Detected {
        network: Some(p.genesis_id.clone()),
        genesis_hash: Some(p.genesis_hash),
        block_height: Some(p.last_round),
        ..Default::default()
    })
}

pub struct PaymentCheck<'a> {
    pub ours: &'a AlgoAccountInfo,
    pub dest: &'a AlgoAccountInfo,
    pub amount: u64,
    pub fee: u64,
}

fn algo(micro: u64) -> String {
    format!(
        "{} ALGO",
        crate::commands::format_units(&micro.to_string(), 6)
    )
}

pub fn check_payment(c: &PaymentCheck<'_>) -> AppResult<()> {
    if let Some(auth) = &c.ours.auth_addr {
        return Err(AppError::InvalidInput(format!(
            "this Algorand account was rekeyed to {auth}: its signing key is no longer this wallet's, Kyro cannot sign for it"
        )));
    }
    if !c.ours.exists {
        return Err(AppError::InvalidInput(
            "your Algorand account is not activated yet (no ALGO received)".into(),
        ));
    }
    let spendable: u64 = c.ours.spendable.parse().unwrap_or(0);
    let min: u64 = c.ours.min_balance.parse().unwrap_or(0);
    if c.amount.saturating_add(c.fee) > spendable {
        return Err(AppError::InvalidInput(format!(
            "insufficient available balance: {} available (balance − minimum balance of {}), {} needed",
            algo(spendable),
            algo(min),
            algo(c.amount.saturating_add(c.fee))
        )));
    }
    let dest_balance: u64 = c.dest.balance.parse().unwrap_or(0);
    let dest_min: u64 = c
        .dest
        .min_balance
        .parse()
        .unwrap_or(wallet_core::ALGO_MIN_BALANCE);
    if dest_balance.saturating_add(c.amount) < dest_min {
        return Err(AppError::InvalidInput(if c.dest.exists {
            format!(
                "this recipient would stay below its minimum balance ({}): send at least {}",
                algo(dest_min),
                algo(dest_min - dest_balance)
            )
        } else {
            format!(
                "this account does not exist yet: you must send it at least {} (minimum balance), otherwise the payment is rejected",
                algo(dest_min)
            )
        }));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn params_are_checked_against_the_genesis() {
        let t = json!({"consensus-version":"https://github.com/algorandfoundation/specs/tree/73c43b4a9699390884c51e2a9598d49e28373d10","fee":0,"genesis-hash":"SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=","genesis-id":"testnet-v1.0","last-round":68824675,"min-fee":1000});
        let m = json!({"consensus-version":"https://github.com/algorandfoundation/specs/tree/268b63433a907455d439995bf916f6b296018f4f","fee":0,"genesis-hash":"wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=","genesis-id":"mainnet-v1.0","last-round":66529512,"min-fee":1000});
        let p = parse_params(&t, Network::Testnet).unwrap();
        assert_eq!(
            (p.min_fee, p.fee_per_byte, p.last_round),
            (1000, 0, 68_824_675)
        );
        assert_eq!(p.fee_for(200), 1000);
        assert!(parse_params(&m, Network::Mainnet).is_ok());
        assert!(matches!(
            parse_params(&m, Network::Testnet),
            Err(AppError::ServerWrongNetwork(_))
        ));
        let mut forged = t.clone();
        forged["genesis-hash"] = json!("wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=");
        assert!(parse_params(&forged, Network::Testnet).is_err());
        let busy = AlgoParams {
            fee_per_byte: 10,
            ..p
        };
        assert_eq!(busy.fee_for(200), 2750);
    }

    #[test]
    fn accounts_and_minimum_balance() {
        let empty = json!({"address":"BX63ZW4O5PWWFDH3J33QEB5YN7IN5XOKPDUQ5DCZ232EDY4DWN3XKUQRCA","amount":0,"amount-without-pending-rewards":0,"apps-total-schema":{"num-byte-slice":0,"num-uint":0},"min-balance":100000,"pending-rewards":0,"reward-base":218288,"rewards":0,"round":66529512,"status":"Offline","total-apps-opted-in":0,"total-assets-opted-in":0,"total-created-apps":0,"total-created-assets":0});
        let a = "BX63ZW4O5PWWFDH3J33QEB5YN7IN5XOKPDUQ5DCZ232EDY4DWN3XKUQRCA";
        let dest = parse_account(&empty, a).unwrap();
        assert!(!dest.exists);
        assert_eq!(
            (
                dest.balance.as_str(),
                dest.min_balance.as_str(),
                dest.spendable.as_str()
            ),
            ("0", "100000", "0")
        );
        let ours = AlgoAccountInfo {
            exists: true,
            balance: "5000000".into(),
            min_balance: "200000".into(),
            spendable: "4800000".into(),
            ..Default::default()
        };
        let ok = |amount, dest: &AlgoAccountInfo| {
            check_payment(&PaymentCheck {
                ours: &ours,
                dest,
                amount,
                fee: 1000,
            })
        };
        assert!(ok(100_000, &dest).is_ok());
        assert!(
            matches!(ok(99_999, &dest), Err(AppError::InvalidInput(m)) if m.contains("at least 0.1 ALGO"))
        );
        assert!(
            matches!(ok(4_799_001, &dest), Err(AppError::InvalidInput(m)) if m.contains("insufficient") && m.contains("0.2 ALGO"))
        );
        assert!(ok(4_799_000, &dest).is_ok());
        let funded = AlgoAccountInfo {
            exists: true,
            balance: "1".into(),
            min_balance: "100000".into(),
            ..Default::default()
        };
        assert!(
            matches!(ok(10, &funded), Err(AppError::InvalidInput(m)) if m.contains("below its minimum balance"))
        );
        let rekeyed = AlgoAccountInfo {
            auth_addr: Some("XYZ".into()),
            ..ours.clone()
        };
        assert!(matches!(
            check_payment(&PaymentCheck { ours: &rekeyed, dest: &dest, amount: 200_000, fee: 1000 }),
            Err(AppError::InvalidInput(m)) if m.contains("rekey")
        ));
        let mut with_auth = empty.clone();
        with_auth["auth-addr"] =
            json!("PNWOET7LLOWMBMLE4KOCELCX6X3D3Q4H2Q4QJASYIEOF7YIPPQBG3YQ5YI");
        assert!(parse_account(&with_auth, a).unwrap().auth_addr.is_some());
    }

    #[test]
    fn history_and_pending_status() {
        let v = json!({"current-round": 10, "transactions": [
            {"id":"TXA","tx-type":"pay","sender":"S","fee":1000,"confirmed-round":9,"round-time":1700000000,
             "note":"SGVsbG8=","payment-transaction":{"amount":1500000,"receiver":"R","close-amount":0}},
            {"id":"TXB","tx-type":"axfer","sender":"S","fee":1000,"confirmed-round":8,"round-time":1700000001}
        ]});
        let h = parse_txs(&v);
        assert_eq!(h[0]["amount"], "1500000");
        assert_eq!(h[0]["to"], "R");
        assert_eq!(h[0]["note"], "Hello");
        assert_eq!(h[0]["time"], 1_700_000_000_000i64);
        assert_eq!(h[1]["type"], "axfer");
        assert_eq!(h[1]["amount"], "0");
        assert!(h[1]["to"].is_null());
        let p = parse_pending(&json!({"confirmed-round": 0, "pool-error": ""}));
        assert!(!p.confirmed && p.error.is_none());
        let p = parse_pending(&json!({"confirmed-round": 123, "pool-error": ""}));
        assert_eq!((p.confirmed, p.round), (true, Some(123)));
        let p = parse_pending(&json!({"confirmed-round": 0, "pool-error": "overspend"}));
        assert_eq!(p.error.as_deref(), Some("overspend"));
        let v = json!({"transactions": [{"id":"TXC","tx-type":"axfer","sender":"S","fee":1000,"confirmed-round":7,
            "asset-transfer-transaction":{"amount":2500000,"asset-id":31566704,"close-amount":0,"receiver":"R"}}]});
        let h = parse_txs(&v);
        assert_eq!(
            (h[0]["assetId"].as_u64(), h[0]["assetAmount"].as_str()),
            (Some(31_566_704), Some("2500000"))
        );
        assert_eq!(
            (h[0]["to"].as_str(), h[0]["amount"].as_str()),
            (Some("R"), Some("0"))
        );
    }

    #[test]
    fn asset_holdings_and_checks() {
        let ok = json!({"asset-holding":{"amount":12500000,"asset-id":31566704,"is-frozen":false},"round":1});
        let h = parse_holding(200, &ok, 31_566_704).unwrap();
        assert_eq!(
            (h.opted_in, h.amount.as_str(), h.frozen),
            (true, "12500000", false)
        );
        assert!(parse_holding(200, &ok, 312_769).is_err(), "another asset");
        let none = parse_holding(
            404,
            &json!({"message":"account asset info not found"}),
            312_769,
        )
        .unwrap();
        assert!(!none.opted_in);
        let ours = AlgoAccountInfo {
            exists: true,
            balance: "300000".into(),
            min_balance: "100000".into(),
            spendable: "200000".into(),
            ..Default::default()
        };
        let check =
            |mine: &AlgoHolding, dest: &AlgoHolding, amount, opt_in, ours: &AlgoAccountInfo| {
                check_asset(&AssetCheck {
                    ours,
                    symbol: "USDC",
                    decimals: 6,
                    mine,
                    dest,
                    amount,
                    fee: 1000,
                    opt_in,
                })
            };
        let err = |r: AppResult<()>, needle: &str| {
            assert!(
                matches!(&r, Err(AppError::InvalidInput(m)) if m.contains(needle)),
                "{needle}: {r:?}"
            );
        };
        assert!(check(&none, &none, 0, true, &ours).is_ok());
        let poor = AlgoAccountInfo {
            spendable: "100500".into(),
            ..ours.clone()
        };
        err(check(&none, &none, 0, true, &poor), "an extra 0.1 ALGO");
        err(check(&h, &h, 0, true, &ours), "already enabled");
        assert!(check(&h, &h, 12_500_000, false, &ours).is_ok());
        err(check(&h, &h, 12_500_001, false, &ours), "insufficient");
        err(check(&none, &h, 1, false, &ours), "is not enabled");
        err(check(&h, &none, 1, false, &ours), "has not enabled USDC");
        let frozen = AlgoHolding {
            frozen: true,
            ..h.clone()
        };
        err(check(&frozen, &h, 1, false, &ours), "frozen");
        err(check(&h, &frozen, 1, false, &ours), "frozen");
        let broke = AlgoAccountInfo {
            spendable: "0".into(),
            ..ours.clone()
        };
        err(check(&h, &h, 1, false, &broke), "network fee");
    }
}
