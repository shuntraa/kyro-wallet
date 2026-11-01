//! XRP Ledger data from a rippled JSON-RPC server (default: Ripple's public testnet server,
//! xrplcluster.com on mainnet), on the `xrp` Tor family, never with a fallback.
//!
//! Kyro fills `Sequence`, `Fee` and `LastLedgerSequence` itself (`account_info`, `fee`) and
//! encodes the Payment with wallet-core: a server-built blob is never signed. Reserves come from
//! `server_info.validated_ledger` (`reserve_base_xrp`, `reserve_inc_xrp`).

use serde::Serialize;
use serde_json::{json, Value};
use wallet_core::Network;

use crate::btc_backend::Detected;
use crate::error::{AppError, AppResult};
use crate::net::{Family, NetClient, ServerRequest};
use crate::servers::{validate_http_url, xrp_default_url, xrp_network_id, XrpServer};

/// `LastLedgerSequence` = current ledger + this (≈ 1 min at 3–4 s per ledger).
pub const LLS_OFFSET: u32 = 20;
const MAX_TXS: u32 = 50;
/// Seconds between the UNIX epoch and the Ripple epoch (2000-01-01).
const RIPPLE_EPOCH: i64 = 946_684_800;

pub struct XrpCtx<'a> {
    pub net_client: &'a NetClient,
    pub network: Network,
    pub tor: bool,
    pub server: XrpServer,
}

fn bad(msg: impl Into<String>) -> AppError {
    AppError::ServerUnreachable(msg.into())
}

pub fn url(ctx: &XrpCtx<'_>) -> AppResult<String> {
    Ok(match &ctx.server {
        XrpServer::Default => xrp_default_url(ctx.network).to_owned(),
        XrpServer::JsonRpc { url } => {
            validate_http_url(url, ctx.tor, false)?;
            url.trim().to_owned()
        }
    })
}

/// A rippled error (`result.status == "error"`), e.g. `actNotFound`.
#[derive(Debug)]
pub enum RpcError {
    Rippled(String, String),
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
            RpcError::Rippled(code, msg) => bad(format!("XRPL : {code} ({msg})")),
        }
    }
}

async fn rpc(ctx: &XrpCtx<'_>, method: &str, params: Value) -> Result<Value, RpcError> {
    let u = url::Url::parse(&url(ctx)?)
        .map_err(|_| AppError::ServerInvalid("URL XRPL invalide".into()))?;
    let body = json!({ "method": method, "params": [params] }).to_string();
    let (status, bytes) = ctx
        .net_client
        .server_request(ServerRequest::post_json(u, Family::Xrp, body), ctx.tor)
        .await?;
    if status != 200 {
        return Err(bad(format!(
            "XRPL : HTTP {status} sur {method} ({})",
            String::from_utf8_lossy(&bytes)
                .chars()
                .take(200)
                .collect::<String>()
        ))
        .into());
    }
    let v: Value = serde_json::from_slice(&bytes)
        .map_err(|_| bad(format!("XRPL : JSON invalide sur {method}")))?;
    let r = v["result"].clone();
    if r["status"] == "error" {
        return Err(RpcError::Rippled(
            r["error"].as_str().unwrap_or("error").to_owned(),
            r["error_message"]
                .as_str()
                .or(r["error_exception"].as_str())
                .unwrap_or("")
                .chars()
                .take(200)
                .collect(),
        ));
    }
    Ok(r)
}

/// `"1"`, `1`, `1.0`, `0.2` (XRP, JSON number or string) → drops, exactly.
pub fn xrp_to_drops(v: &Value) -> Option<u64> {
    let s = match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => return None,
    };
    let (int, frac) = s.split_once('.').unwrap_or((&s, ""));
    if frac.len() > 6
        || int.is_empty()
        || !int.bytes().chain(frac.bytes()).all(|b| b.is_ascii_digit())
    {
        return None;
    }
    let frac = format!("{frac:0<6}");
    int.parse::<u64>()
        .ok()?
        .checked_mul(1_000_000)?
        .checked_add(frac.parse().ok()?)
}

fn drops_at(v: &Value) -> Option<u64> {
    match v {
        Value::String(s) => s.parse().ok(),
        Value::Number(n) => n.as_u64(),
        _ => None,
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct XrpServerInfo {
    pub network_id: u64,
    /// Drops.
    pub reserve_base: u64,
    /// Drops per owned object.
    pub reserve_inc: u64,
    pub validated_ledger: u64,
}

pub async fn server_info(ctx: &XrpCtx<'_>) -> AppResult<XrpServerInfo> {
    let r = rpc(ctx, "server_info", json!({})).await?;
    let i = &r["info"];
    let v = &i["validated_ledger"];
    Ok(XrpServerInfo {
        network_id: i["network_id"].as_u64().unwrap_or(0),
        reserve_base: xrp_to_drops(&v["reserve_base_xrp"])
            .ok_or_else(|| bad("XRPL : réserve de base absente"))?,
        reserve_inc: xrp_to_drops(&v["reserve_inc_xrp"])
            .ok_or_else(|| bad("XRPL : réserve par objet absente"))?,
        validated_ledger: v["seq"].as_u64().unwrap_or(0),
    })
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct XrpAccountInfo {
    pub address: String,
    /// The account exists (was funded with at least the base reserve).
    pub exists: bool,
    /// Drops, decimal string.
    pub balance: String,
    pub sequence: u32,
    pub owner_count: u32,
    pub flags: u32,
    /// `lsfRequireDestTag`: payments without a destination tag are refused.
    pub require_dest_tag: bool,
    /// `lsfDisallowXRP` (advisory).
    pub disallow_xrp: bool,
    /// Drops locked: base reserve + owner reserve × owned objects.
    pub reserve: String,
    /// Drops: balance − reserve (0 if negative).
    pub spendable: String,
}

pub async fn account(
    ctx: &XrpCtx<'_>,
    address: &str,
    info: &XrpServerInfo,
) -> AppResult<XrpAccountInfo> {
    wallet_core::xrp_account_id(address)?;
    let a = address.trim().to_owned();
    match rpc(
        ctx,
        "account_info",
        json!({ "account": a, "ledger_index": "current", "strict": true }),
    )
    .await
    {
        Ok(r) => {
            let d = &r["account_data"];
            let balance = drops_at(&d["Balance"]).ok_or_else(|| bad("XRPL : solde absent"))?;
            let owner_count = d["OwnerCount"].as_u64().unwrap_or(0) as u32;
            let flags = d["Flags"].as_u64().unwrap_or(0) as u32;
            let reserve = info.reserve_base + info.reserve_inc * u64::from(owner_count);
            Ok(XrpAccountInfo {
                address: a,
                exists: true,
                balance: balance.to_string(),
                sequence: d["Sequence"].as_u64().unwrap_or(0) as u32,
                owner_count,
                flags,
                require_dest_tag: flags & wallet_core::LSF_REQUIRE_DEST_TAG != 0,
                disallow_xrp: flags & wallet_core::LSF_DISALLOW_XRP != 0,
                reserve: reserve.to_string(),
                spendable: balance.saturating_sub(reserve).to_string(),
            })
        }
        Err(RpcError::Rippled(code, _)) if code == "actNotFound" => Ok(XrpAccountInfo {
            address: a,
            balance: "0".into(),
            reserve: "0".into(),
            spendable: "0".into(),
            ..Default::default()
        }),
        Err(e) => Err(e.into()),
    }
}

/// `(fee drops, current ledger index)`: the open-ledger fee (what gets into the next ledger),
/// at least the reference fee.
pub async fn fee(ctx: &XrpCtx<'_>) -> AppResult<(u64, u32)> {
    let r = rpc(ctx, "fee", json!({})).await?;
    let d = &r["drops"];
    let base = drops_at(&d["base_fee"]).ok_or_else(|| bad("XRPL : base_fee absent"))?;
    let open = drops_at(&d["open_ledger_fee"]).unwrap_or(base);
    let current = r["ledger_current_index"]
        .as_u64()
        .ok_or_else(|| bad("XRPL : ledger_current_index absent"))?;
    Ok((open.max(base), u32::try_from(current).unwrap_or(u32::MAX)))
}

/// Trust lines (issued-currency balances): `[{ currency, issuer, balance, limit }]`.
pub async fn lines(ctx: &XrpCtx<'_>, address: &str) -> AppResult<Value> {
    wallet_core::xrp_account_id(address)?;
    match rpc(ctx, "account_lines", json!({ "account": address.trim(), "ledger_index": "validated" })).await {
        Ok(r) => Ok(Value::Array(
            r["lines"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|l| json!({ "currency": l["currency"], "issuer": l["account"], "balance": l["balance"], "limit": l["limit"] }))
                .collect(),
        )),
        Err(RpcError::Rippled(code, _)) if code == "actNotFound" => Ok(json!([])),
        Err(e) => Err(e.into()),
    }
}

/// Last 50 Payments touching `address`, normalized:
/// `[{ hash, from, to, destinationTag, amount: { kind:'xrp', drops } | { kind:'issued', value, currency, issuer }, fee, ledger, time, result }]`.
pub async fn txs(ctx: &XrpCtx<'_>, address: &str) -> AppResult<Value> {
    wallet_core::xrp_account_id(address)?;
    let r = match rpc(
        ctx,
        "account_tx",
        json!({ "account": address.trim(), "limit": MAX_TXS }),
    )
    .await
    {
        Ok(r) => r,
        Err(RpcError::Rippled(code, _)) if code == "actNotFound" => return Ok(json!([])),
        Err(e) => return Err(e.into()),
    };
    let mut out = Vec::new();
    for t in r["transactions"].as_array().into_iter().flatten() {
        let tx = if t["tx_json"].is_object() {
            &t["tx_json"]
        } else {
            &t["tx"]
        };
        if tx["TransactionType"] != "Payment" {
            continue;
        }
        let meta = &t["meta"];
        // delivered_amount is what actually arrived (partial payments!), not Amount.
        let delivered = if meta["delivered_amount"].is_null() {
            &tx["Amount"]
        } else {
            &meta["delivered_amount"]
        };
        let amount = match delivered {
            Value::String(d) => json!({ "kind": "xrp", "drops": d }),
            Value::Object(o) => {
                json!({ "kind": "issued", "value": o.get("value"), "currency": o.get("currency"), "issuer": o.get("issuer") })
            }
            _ => Value::Null,
        };
        let hash = if t["hash"].is_string() {
            &t["hash"]
        } else {
            &tx["hash"]
        };
        out.push(json!({
            "hash": hash, "from": tx["Account"], "to": tx["Destination"],
            "destinationTag": tx["DestinationTag"], "amount": amount, "fee": tx["Fee"],
            "ledger": t["ledger_index"].as_u64().or(tx["ledger_index"].as_u64()),
            "time": tx["date"].as_i64().or(t["close_time_iso"].as_i64()).map(|d| (d + RIPPLE_EPOCH) * 1000),
            "result": meta["TransactionResult"],
        }));
    }
    Ok(Value::Array(out))
}

/// `submit` a signed blob. Accepted: `tesSUCCESS`, `terQUEUED` (and `tec*` is an error: the fee
/// is taken but nothing else happens). The server's hash must be ours.
pub async fn submit(ctx: &XrpCtx<'_>, blob: &str, hash: &str) -> AppResult<String> {
    let r = rpc(ctx, "submit", json!({ "tx_blob": blob })).await?;
    let engine = r["engine_result"].as_str().unwrap_or("");
    let msg = r["engine_result_message"].as_str().unwrap_or("");
    let got = r["tx_json"]["hash"].as_str().unwrap_or("");
    if !got.eq_ignore_ascii_case(hash) {
        return Err(bad(format!(
            "le serveur a répondu un hash inattendu ({})",
            got.chars().take(80).collect::<String>()
        )));
    }
    if engine != "tesSUCCESS" && engine != "terQUEUED" {
        return Err(AppError::InvalidInput(format!(
            "paiement XRP refusé : {engine} ({msg})"
        )));
    }
    Ok(hash.to_uppercase())
}

/// `tx` by hash: `(validated, TransactionResult)`.
pub async fn tx_status(ctx: &XrpCtx<'_>, hash: &str) -> AppResult<(bool, String)> {
    match rpc(ctx, "tx", json!({ "transaction": hash })).await {
        Ok(r) => Ok((
            r["validated"] == true,
            r["meta"]["TransactionResult"]
                .as_str()
                .unwrap_or("")
                .to_owned(),
        )),
        Err(RpcError::Rippled(code, _)) if code == "txnNotFound" => Ok((false, String::new())),
        Err(e) => Err(e.into()),
    }
}

/// Network check: `server_info.info.network_id` (0 mainnet, 1 testnet, 2 devnet).
pub async fn probe(ctx: &XrpCtx<'_>) -> AppResult<Detected> {
    let i = server_info(ctx).await?;
    let want = xrp_network_id(ctx.network);
    if i.network_id != want {
        let name = |id: u64| match id {
            0 => "mainnet".to_owned(),
            1 => "testnet".to_owned(),
            2 => "devnet".to_owned(),
            other => format!("réseau {other}"),
        };
        return Err(AppError::ServerWrongNetwork(format!(
            "ce serveur XRPL est sur {}, pas sur {}",
            name(i.network_id),
            name(want)
        )));
    }
    Ok(Detected {
        network: Some(if want == 0 { "mainnet" } else { "testnet" }.into()),
        chain_id: Some(i.network_id),
        block_height: Some(i.validated_ledger),
        ..Default::default()
    })
}

/// Checks before building / signing a payment, against live data. Errors are user-facing.
pub struct PaymentCheck<'a> {
    pub ours: &'a XrpAccountInfo,
    pub dest: &'a XrpAccountInfo,
    pub info: &'a XrpServerInfo,
    pub drops: Option<u64>,
    pub fee: u64,
    pub destination_tag: Option<u32>,
}

pub fn check_payment(c: &PaymentCheck<'_>) -> AppResult<()> {
    if !c.ours.exists {
        return Err(AppError::InvalidInput(
            "ton compte XRP n'est pas encore activé (aucun XRP reçu)".into(),
        ));
    }
    if c.dest.require_dest_tag && c.destination_tag.is_none() {
        return Err(AppError::InvalidInput(
            "ce destinataire exige un tag de destination (lsfRequireDestTag) : ajoute-le, sinon le paiement serait refusé ou perdu".into(),
        ));
    }
    match c.drops {
        Some(d) => {
            if !c.dest.exists && d < c.info.reserve_base {
                return Err(AppError::InvalidInput(format!(
                    "ce compte n'existe pas encore : il faut lui envoyer au moins la réserve de base ({} XRP), sinon le paiement échoue (tecNO_DST_INSUF_XRP)",
                    crate::commands::format_units(&c.info.reserve_base.to_string(), 6)
                )));
            }
            let spendable: u64 = c.ours.spendable.parse().unwrap_or(0);
            if d.saturating_add(c.fee) > spendable {
                return Err(AppError::InvalidInput(format!(
                    "solde disponible insuffisant : {} XRP disponibles (solde − réserve), il en faut {}",
                    crate::commands::format_units(&spendable.to_string(), 6),
                    crate::commands::format_units(&(d + c.fee).to_string(), 6)
                )));
            }
        }
        None => {
            if !c.dest.exists {
                return Err(AppError::InvalidInput(
                    "un token ne peut pas être envoyé à un compte XRP qui n'existe pas (tecNO_DST)"
                        .into(),
                ));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xrp_decimal_to_drops() {
        assert_eq!(xrp_to_drops(&json!(1)), Some(1_000_000));
        assert_eq!(xrp_to_drops(&json!(1.0)), Some(1_000_000));
        assert_eq!(xrp_to_drops(&json!(0.2)), Some(200_000));
        assert_eq!(xrp_to_drops(&json!("10")), Some(10_000_000));
        assert_eq!(xrp_to_drops(&json!("0.000012")), Some(12));
        assert_eq!(xrp_to_drops(&json!("0.0000001")), None);
        assert_eq!(xrp_to_drops(&json!(-1)), None);
        assert_eq!(xrp_to_drops(&json!("x")), None);
    }

    fn acc(exists: bool, spendable: u64, require_tag: bool) -> XrpAccountInfo {
        XrpAccountInfo {
            exists,
            spendable: spendable.to_string(),
            require_dest_tag: require_tag,
            ..Default::default()
        }
    }

    #[test]
    fn payment_checks() {
        let info = XrpServerInfo {
            network_id: 1,
            reserve_base: 1_000_000,
            reserve_inc: 200_000,
            validated_ledger: 1,
        };
        let ours = acc(true, 50_000_000, false);
        let ok = |dest: &XrpAccountInfo, drops: Option<u64>, tag: Option<u32>| {
            check_payment(&PaymentCheck {
                ours: &ours,
                dest,
                info: &info,
                drops,
                fee: 12,
                destination_tag: tag,
            })
        };
        assert!(ok(&acc(true, 0, false), Some(5_000_000), None).is_ok());
        // Destination requires a tag.
        let tagged = acc(true, 0, true);
        assert!(
            matches!(ok(&tagged, Some(5_000_000), None), Err(AppError::InvalidInput(m)) if m.contains("tag de destination"))
        );
        assert!(ok(&tagged, Some(5_000_000), Some(42)).is_ok());
        // Unfunded destination: at least the base reserve.
        let new = acc(false, 0, false);
        assert!(
            matches!(ok(&new, Some(999_999), None), Err(AppError::InvalidInput(m)) if m.contains("tecNO_DST_INSUF_XRP"))
        );
        assert!(ok(&new, Some(1_000_000), None).is_ok());
        assert!(ok(&new, None, None).is_err());
        // More than spendable (balance − reserve).
        assert!(
            matches!(ok(&acc(true, 0, false), Some(49_999_990), None), Err(AppError::InvalidInput(m)) if m.contains("insuffisant"))
        );
        // Our account not activated.
        let none = acc(false, 0, false);
        assert!(check_payment(&PaymentCheck {
            ours: &none,
            dest: &new,
            info: &info,
            drops: Some(2_000_000),
            fee: 12,
            destination_tag: None
        })
        .is_err());
    }
}

/// Real-network test on the XRPL Testnet over Tor. Run with
/// `cargo test -p kyro-desktop -- --ignored --nocapture xrp_live`.
/// - keys: a NEW random test mnemonic, generated once and kept in the gitignored
///   `.env.xrp-testnet` at the repository root (testnet only);
/// - `KYRO_XRP_FAUCET=yes`: funds the first address from the official testnet faucet;
/// - `KYRO_XRP_SEND=yes`: one payment to an unfunded new account (≥ reserve), then one payment
///   with a destination tag to the same (now funded) second address, through the real path
///   (live checks, dialog text, signature with identical summary, `submit`, hash check).
#[cfg(test)]
mod live {
    use super::*;
    use crate::tor::TorState;

    fn test_seed() -> wallet_core::Seed {
        let path =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../.env.xrp-testnet");
        let words = match std::fs::read_to_string(&path) {
            Ok(s) => s
                .lines()
                .find_map(|l| l.strip_prefix("KYRO_XRP_TEST_MNEMONIC="))
                .expect("mnemonic line")
                .trim()
                .to_owned(),
            Err(_) => {
                let m = wallet_core::Mnemonic::generate(wallet_core::WordCount::W12).unwrap();
                let w = m.words().join(" ");
                std::fs::write(
                    &path,
                    format!("# XRPL TESTNET ONLY — random test mnemonic generated by Kyro's live test (xrp_backend.rs).\n# Never use it for real funds. This file is gitignored (.env.*).\nKYRO_XRP_TEST_MNEMONIC={w}\n"),
                )
                .unwrap();
                eprintln!("new test mnemonic written to {}", path.display());
                w
            }
        };
        wallet_core::Mnemonic::parse(&words).unwrap().to_seed("")
    }

    async fn pay(
        c: &XrpCtx<'_>,
        seed: &wallet_core::Seed,
        me: &str,
        pk: &[u8; 33],
        to: &str,
        drops: &str,
        tag: Option<u32>,
    ) -> String {
        let built = crate::commands_xrp::build(c, me, pk, to, drops, tag, None)
            .await
            .unwrap();
        let (summary, context) = crate::commands_xrp::prepare_sign(c, me, pk, &built.blob)
            .await
            .unwrap();
        assert_eq!(summary, built.summary);
        eprintln!(
            "--- dialog ---\n{}---",
            crate::commands_xrp::describe_xrp(
                crate::i18n::Lang::Fr,
                &summary,
                &context,
                Network::Testnet
            )
        );
        assert!(!summary.requires_extra_confirmation);
        let (signed, hash, again) = wallet_core::xrp_sign(seed, 0, &built.blob).unwrap();
        assert_eq!(again, summary, "identical summary");
        let got = crate::commands_xrp::broadcast_checked(c, me, &signed)
            .await
            .unwrap();
        assert_eq!(got, hash);
        eprintln!("SUBMITTED {hash}");
        for _ in 0..30 {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            let (validated, result) = tx_status(c, &hash).await.unwrap();
            if validated {
                eprintln!("validated: {result}");
                assert_eq!(result, "tesSUCCESS");
                return hash;
            }
        }
        panic!("{hash} not validated");
    }

    #[test]
    #[ignore]
    fn xrp_live_testnet_over_tor() {
        let net = NetClient::new(std::env::temp_dir().join("kyro-xrp-live")).unwrap();
        let seed = test_seed();
        let me = wallet_core::xrp_address(&seed, 0).unwrap();
        let pk = wallet_core::xrp_public_key(&seed, 0).unwrap();
        let a1 = wallet_core::xrp_address(&seed, 1).unwrap();
        let a2 = wallet_core::xrp_address(&seed, 2).unwrap();
        eprintln!("addresses: {me} {a1} {a2}");
        tauri::async_runtime::block_on(async {
            net.tor.restart();
            while net.tor.status().state != TorState::Ready {
                assert_ne!(net.tor.status().state, TorState::Error);
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            }
            let c = XrpCtx {
                net_client: &net,
                network: Network::Testnet,
                tor: true,
                server: XrpServer::Default,
            };
            let t = std::time::Instant::now();
            eprintln!("testnet probe {:?} in {:.1?}", probe(&c).await, t.elapsed());
            let main = XrpCtx {
                net_client: &net,
                network: Network::Mainnet,
                tor: true,
                server: XrpServer::Default,
            };
            eprintln!("mainnet probe {:?}", probe(&main).await);
            let wrong = XrpCtx {
                net_client: &net,
                network: Network::Testnet,
                tor: true,
                server: XrpServer::JsonRpc {
                    url: "https://xrplcluster.com/".into(),
                },
            };
            let e = probe(&wrong).await;
            eprintln!("wrong network: {e:?}");
            assert!(matches!(e, Err(AppError::ServerWrongNetwork(_))));
            let info = server_info(&c).await.unwrap();
            eprintln!("server_info {info:?}");

            let mut acc = account(&c, &me, &info).await.unwrap();
            if !acc.exists && std::env::var("KYRO_XRP_FAUCET").as_deref() == Ok("yes") {
                let req = ServerRequest::post_json(
                    url::Url::parse("https://faucet.altnet.rippletest.net/accounts").unwrap(),
                    Family::Xrp,
                    json!({ "destination": me }).to_string(),
                );
                let (status, body) = net.server_request(req, true).await.unwrap();
                eprintln!(
                    "faucet: HTTP {status} {}",
                    String::from_utf8_lossy(&body)
                        .chars()
                        .take(300)
                        .collect::<String>()
                );
                for _ in 0..30 {
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                    acc = account(&c, &me, &info).await.unwrap();
                    if acc.exists {
                        break;
                    }
                }
            }
            eprintln!("account {acc:?}");
            eprintln!("history: {}", txs(&c, &me).await.unwrap());
            if std::env::var("KYRO_XRP_SEND").as_deref() != Ok("yes") || !acc.exists {
                eprintln!("KYRO_XRP_SEND != yes or account not funded: no payment");
                return;
            }
            // Below the base reserve to an unfunded account: refused before anything is signed.
            let r = crate::commands_xrp::build(&c, &me, &pk, &a2, "500000", None, None).await;
            eprintln!("0.5 XRP to unfunded {a2}: {:?}", r.as_ref().err());
            assert!(
                matches!(r, Err(AppError::InvalidInput(ref m)) if m.contains("tecNO_DST_INSUF_XRP"))
            );
            // 1) to an unfunded new account (≥ reserve), 2) with a destination tag.
            let dest = account(&c, &a1, &info).await.unwrap();
            if !dest.exists {
                let h = pay(&c, &seed, &me, &pk, &a1, "20000000", None).await;
                eprintln!("PAYMENT TO UNFUNDED ACCOUNT: {h}");
            }
            let h = pay(&c, &seed, &me, &pk, &a1, "5000000", Some(12_345)).await;
            eprintln!("PAYMENT WITH DESTINATION TAG: {h}");
            eprintln!("recipient now {:?}", account(&c, &a1, &info).await.unwrap());
            eprintln!("history of recipient: {}", txs(&c, &a1).await.unwrap());
        });
    }
}
