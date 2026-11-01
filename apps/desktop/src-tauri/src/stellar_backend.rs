//! Stellar data from SDF's public Horizon (`horizon.stellar.org`, `horizon-testnet.stellar.org`),
//! on the `stellar` Tor family, never with a fallback.
//!
//! Kyro fills the sequence number, the fee and the time bounds itself (`/accounts`,
//! `/fee_stats`, `/ledgers`) and encodes the transaction with wallet-core: Horizon never builds
//! what is signed. Every build, signature and submission first checks Horizon's
//! `network_passphrase` against the app's network (the passphrase is also in what is signed, so
//! a wrong-network signature would be invalid anyway). Reserves come from the latest ledger
//! (`base_reserve_in_stroops`).

use serde::Serialize;
use serde_json::{json, Value};
use wallet_core::{stellar_network_passphrase, Network, STELLAR_HIGH_FEE_STROOPS};

use crate::error::{AppError, AppResult};
use crate::net::{Family, NetClient, ServerRequest};

/// Time bounds: `maxTime` = latest ledger close time + this (5 min).
pub const VALIDITY_SECS: u64 = 300;
/// A transaction whose `maxTime` is closer than this to the ledger time is rebuilt, not signed.
pub const MIN_REMAINING_SECS: u64 = 30;
const MAX_TXS: u32 = 50;
/// SEP-0029: data entry by which an account requires a memo on incoming payments.
const MEMO_REQUIRED_KEY: &str = "config.memo_required";

pub struct StellarCtx<'a> {
    pub net_client: &'a NetClient,
    pub network: Network,
    pub tor: bool,
}

/// SDF's Horizon for `net` (testnet = SDF's test network, the one Friendbot funds).
pub fn horizon_url(net: Network) -> &'static str {
    match net {
        Network::Mainnet => "https://horizon.stellar.org/",
        Network::Testnet => "https://horizon-testnet.stellar.org/",
    }
}

pub fn host(net: Network) -> &'static str {
    match net {
        Network::Mainnet => "horizon.stellar.org",
        Network::Testnet => "horizon-testnet.stellar.org",
    }
}

fn bad(msg: impl Into<String>) -> AppError {
    AppError::ServerUnreachable(msg.into())
}

fn url(ctx: &StellarCtx<'_>, path: &str) -> AppResult<url::Url> {
    url::Url::parse(horizon_url(ctx.network))
        .and_then(|u| u.join(path))
        .map_err(|_| AppError::Internal("URL Horizon invalide".into()))
}

fn short(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).chars().take(200).collect()
}

/// GET `path`: `Ok(None)` on 404 (unknown account / transaction), JSON otherwise.
async fn get(ctx: &StellarCtx<'_>, path: &str) -> AppResult<Option<Value>> {
    let (status, bytes) = ctx
        .net_client
        .server_request(
            ServerRequest::get(url(ctx, path)?, Family::Stellar),
            ctx.tor,
        )
        .await?;
    if status == 404 {
        return Ok(None);
    }
    if status != 200 {
        return Err(bad(format!(
            "Horizon : HTTP {status} sur {} ({})",
            path.split('?').next().unwrap_or(path),
            short(&bytes)
        )));
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| bad("Horizon : JSON invalide"))
}

async fn get_found(ctx: &StellarCtx<'_>, path: &str) -> AppResult<Value> {
    get(ctx, path)
        .await?
        .ok_or_else(|| bad(format!("Horizon : {path} introuvable (404)")))
}

/// `"12.3456789"` (Horizon amount, 7 decimals) → stroops, exactly.
pub fn to_stroops(v: &Value) -> Option<i64> {
    let s = v.as_str()?;
    let (int, frac) = s.split_once('.').unwrap_or((s, ""));
    if frac.len() > 7
        || int.is_empty()
        || !int.bytes().chain(frac.bytes()).all(|b| b.is_ascii_digit())
    {
        return None;
    }
    int.parse::<i64>()
        .ok()?
        .checked_mul(wallet_core::STROOPS_PER_XLM)?
        .checked_add(format!("{frac:0<7}").parse().ok()?)
}

/// `2026-11-01T01:48:00Z` (RFC 3339, UTC, what Horizon writes) → UNIX seconds.
pub fn parse_utc(s: &str) -> Option<u64> {
    let b = s.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || !s.ends_with('Z') {
        return None;
    }
    let n = |r: std::ops::Range<usize>| s.get(r)?.parse::<u64>().ok();
    let (y, mo, d) = (n(0..4)?, n(5..7)?, n(8..10)?);
    let (h, mi, se) = (n(11..13)?, n(14..16)?, n(17..19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || se > 60 {
        return None;
    }
    // Days from civil (H. Hinnant), proleptic Gregorian calendar.
    let y = if mo <= 2 { y - 1 } else { y };
    let era = y / 400;
    let yoe = y - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = (era * 146_097 + doe).checked_sub(719_468)?;
    Some(days * 86_400 + h * 3_600 + mi * 60 + se)
}

/// UNIX seconds → `2026-11-01 01:53 UTC` (for the dialog).
pub fn format_utc(t: u64) -> String {
    let (days, rem) = (t / 86_400, t % 86_400);
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + u64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02} {:02}:{:02} UTC",
        rem / 3_600,
        rem % 3_600 / 60
    )
}

/// The Horizon root: refuses a server on another network (`network_passphrase`).
pub async fn check_network(ctx: &StellarCtx<'_>) -> AppResult<Value> {
    let r = get_found(ctx, "").await?;
    let got = r["network_passphrase"].as_str().unwrap_or("");
    let want = stellar_network_passphrase(ctx.network);
    if got != want {
        return Err(AppError::ServerWrongNetwork(format!(
            "ce serveur Horizon est sur « {} », pas sur « {want} »",
            crate::dialog_text::sanitize(got, 80)
        )));
    }
    Ok(r)
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StellarLedger {
    pub sequence: u64,
    /// Stroops per operation.
    pub base_fee: u32,
    /// Stroops (0.5 XLM since protocol 10).
    pub base_reserve: i64,
    /// UNIX seconds.
    pub closed_at: u64,
}

pub async fn latest_ledger(ctx: &StellarCtx<'_>) -> AppResult<StellarLedger> {
    let r = get_found(ctx, "ledgers?order=desc&limit=1").await?;
    let l = &r["_embedded"]["records"][0];
    Ok(StellarLedger {
        sequence: l["sequence"]
            .as_u64()
            .ok_or_else(|| bad("Horizon : registre sans numéro"))?,
        base_fee: l["base_fee_in_stroops"]
            .as_u64()
            .and_then(|f| u32::try_from(f).ok())
            .ok_or_else(|| bad("Horizon : frais de base absents"))?,
        base_reserve: l["base_reserve_in_stroops"]
            .as_i64()
            .filter(|r| *r > 0)
            .ok_or_else(|| bad("Horizon : réserve de base absente"))?,
        closed_at: l["closed_at"]
            .as_str()
            .and_then(parse_utc)
            .ok_or_else(|| bad("Horizon : heure du registre absente"))?,
    })
}

/// A trustline (issued asset held by the account).
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StellarTrustline {
    pub code: String,
    pub issuer: String,
    /// Stroops, decimal string.
    pub balance: String,
    pub limit: String,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StellarAccountInfo {
    pub address: String,
    /// The account exists (was created with at least 2 × the base reserve).
    pub exists: bool,
    /// XLM balance, stroops, decimal string.
    pub balance: String,
    /// Current sequence number (the next transaction uses + 1), decimal string.
    pub sequence: String,
    /// Trustlines, offers, signers, data entries (each locks one base reserve).
    pub subentry_count: u32,
    pub num_sponsoring: u32,
    pub num_sponsored: u32,
    /// Stroops of XLM locked by open offers.
    pub selling_liabilities: String,
    /// Stroops locked: (2 + subentries + sponsoring − sponsored) × base reserve + liabilities.
    pub reserve: String,
    /// Stroops: balance − reserve (0 if negative).
    pub spendable: String,
    /// SEP-0029 `config.memo_required`: payments without a memo are refused by wallets.
    pub memo_required: bool,
    pub trustlines: Vec<StellarTrustline>,
    /// Stroops: the network's current base reserve (0.5 XLM), for the explanation.
    pub base_reserve: String,
}

/// Minimum balance of an account (stroops).
pub fn minimum_balance(
    subentries: u32,
    sponsoring: u32,
    sponsored: u32,
    base_reserve: i64,
    liabilities: i64,
) -> i64 {
    let entries = 2 + i64::from(subentries) + i64::from(sponsoring) - i64::from(sponsored);
    entries
        .max(0)
        .saturating_mul(base_reserve)
        .saturating_add(liabilities)
}

/// Parses Horizon's `/accounts/{id}` record.
pub fn parse_account(address: &str, r: &Value, base_reserve: i64) -> AppResult<StellarAccountInfo> {
    let u = |k: &str| {
        r[k].as_u64()
            .and_then(|n| u32::try_from(n).ok())
            .unwrap_or(0)
    };
    let mut native = None;
    let mut liabilities = 0;
    let mut trustlines = Vec::new();
    for b in r["balances"].as_array().into_iter().flatten() {
        match b["asset_type"].as_str() {
            Some("native") => {
                native = to_stroops(&b["balance"]);
                liabilities = to_stroops(&b["selling_liabilities"]).unwrap_or(0);
            }
            Some("credit_alphanum4" | "credit_alphanum12") => trustlines.push(StellarTrustline {
                code: crate::dialog_text::sanitize(b["asset_code"].as_str().unwrap_or(""), 12),
                issuer: b["asset_issuer"].as_str().unwrap_or("").to_owned(),
                balance: to_stroops(&b["balance"]).unwrap_or(0).to_string(),
                limit: to_stroops(&b["limit"]).unwrap_or(0).to_string(),
            }),
            _ => {} // liquidity pool shares: not shown
        }
    }
    let balance = native.ok_or_else(|| bad("Horizon : solde XLM absent"))?;
    let sequence = r["sequence"]
        .as_str()
        .and_then(|s| s.parse::<i64>().ok())
        .ok_or_else(|| bad("Horizon : numéro de séquence absent"))?;
    let (subentry_count, num_sponsoring, num_sponsored) =
        (u("subentry_count"), u("num_sponsoring"), u("num_sponsored"));
    let reserve = minimum_balance(
        subentry_count,
        num_sponsoring,
        num_sponsored,
        base_reserve,
        liabilities,
    );
    Ok(StellarAccountInfo {
        address: address.to_owned(),
        exists: true,
        balance: balance.to_string(),
        sequence: sequence.to_string(),
        subentry_count,
        num_sponsoring,
        num_sponsored,
        selling_liabilities: liabilities.to_string(),
        reserve: reserve.to_string(),
        spendable: (balance - reserve).max(0).to_string(),
        // SEP-0029: value "1", base64 "MQ==".
        memo_required: r["data"][MEMO_REQUIRED_KEY].as_str() == Some("MQ=="),
        trustlines,
        base_reserve: base_reserve.to_string(),
    })
}

pub async fn account(
    ctx: &StellarCtx<'_>,
    address: &str,
    ledger: &StellarLedger,
) -> AppResult<StellarAccountInfo> {
    wallet_core::stellar_account_id(address)?;
    let a = address.trim();
    match get(ctx, &format!("accounts/{a}")).await? {
        Some(r) => parse_account(a, &r, ledger.base_reserve),
        None => Ok(StellarAccountInfo {
            address: a.to_owned(),
            balance: "0".into(),
            sequence: "0".into(),
            selling_liabilities: "0".into(),
            reserve: "0".into(),
            spendable: "0".into(),
            base_reserve: ledger.base_reserve.to_string(),
            ..Default::default()
        }),
    }
}

/// Fee bid per operation (stroops): the 90th percentile of recently charged fees, at least the
/// base fee, at most [`STELLAR_HIGH_FEE_STROOPS`] (0.01 XLM). Outside surge pricing the network
/// only takes the base fee; the bid is a ceiling.
pub fn fee_bid(stats: &Value, base_fee: u32) -> u32 {
    let p90 = stats["fee_charged"]["p90"]
        .as_str()
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(base_fee);
    p90.max(base_fee).clamp(1, STELLAR_HIGH_FEE_STROOPS)
}

pub async fn fee(ctx: &StellarCtx<'_>, ledger: &StellarLedger) -> AppResult<u32> {
    let s = get_found(ctx, "fee_stats").await?;
    Ok(fee_bid(&s, ledger.base_fee))
}

fn amount_json(r: &Value, amount_key: &str) -> Value {
    let stroops = to_stroops(&r[amount_key]).map(|v| v.to_string());
    match r["asset_type"].as_str() {
        Some("native") | None => json!({ "kind": "native", "stroops": stroops }),
        Some(_) => json!({
            "kind": "credit",
            "code": crate::dialog_text::sanitize(r["asset_code"].as_str().unwrap_or(""), 12),
            "issuer": r["asset_issuer"],
            "stroops": stroops,
        }),
    }
}

fn memo_json(t: &Value) -> Value {
    match t["memo_type"].as_str() {
        Some("text") => json!({ "kind": "text", "text": crate::dialog_text::sanitize(
            t["memo"].as_str().unwrap_or(""),
            wallet_core::STELLAR_MAX_MEMO_TEXT,
        ) }),
        Some("id") => json!({ "kind": "id", "id": t["memo"] }),
        Some("hash") => json!({ "kind": "hash", "value": t["memo"] }),
        Some("return") => json!({ "kind": "return", "value": t["memo"] }),
        _ => json!({ "kind": "none" }),
    }
}

/// Normalizes `/accounts/{id}/payments?join=transactions` records:
/// `[{ id, hash, type, from, to, amount: { kind:'native', stroops } | { kind:'credit', code,
/// issuer, stroops }, fee, time, successful, memo, txSource }]`. Account merges and other
/// operation types are skipped.
pub fn normalize_payments(r: &Value) -> Value {
    let mut out = Vec::new();
    for p in r["_embedded"]["records"].as_array().into_iter().flatten() {
        let t = &p["transaction"];
        let (kind, from, to, amount) = match p["type"].as_str() {
            Some("create_account") => (
                "create_account",
                &p["funder"],
                &p["account"],
                json!({ "kind": "native", "stroops": to_stroops(&p["starting_balance"]).map(|v| v.to_string()) }),
            ),
            Some("payment") => ("payment", &p["from"], &p["to"], amount_json(p, "amount")),
            // Path payments: what the recipient received (`amount` in `asset_*`).
            Some(k @ ("path_payment_strict_send" | "path_payment_strict_receive")) => {
                (k, &p["from"], &p["to"], amount_json(p, "amount"))
            }
            _ => continue,
        };
        out.push(json!({
            "id": p["id"],
            "hash": p["transaction_hash"],
            "type": kind,
            "from": from,
            "to": to,
            "amount": amount,
            "fee": t["fee_charged"],
            "time": p["created_at"].as_str().and_then(parse_utc).map(|s| s * 1000),
            "successful": p["transaction_successful"].as_bool().unwrap_or(true),
            "memo": memo_json(t),
            "txSource": t["source_account"],
        }));
    }
    Value::Array(out)
}

pub async fn payments(ctx: &StellarCtx<'_>, address: &str) -> AppResult<Value> {
    wallet_core::stellar_account_id(address)?;
    let path = format!(
        "accounts/{}/payments?order=desc&limit={MAX_TXS}&join=transactions",
        address.trim()
    );
    Ok(match get(ctx, &path).await? {
        Some(r) => normalize_payments(&r),
        None => json!([]),
    })
}

/// French reading of Horizon's `result_codes` (transaction, then operation).
pub fn explain_result(codes: &Value) -> String {
    let tx = codes["transaction"].as_str().unwrap_or("");
    let op = codes["operations"][0].as_str().unwrap_or("");
    let what = match (tx, op) {
        ("tx_bad_seq", _) => "numéro de séquence périmé : reconstruis la transaction",
        ("tx_too_late", _) => "transaction expirée (limite de temps dépassée) : reconstruis-la",
        ("tx_too_early", _) => "transaction pas encore valable",
        ("tx_insufficient_fee", _) => "frais trop bas pour le moment (réseau chargé) : réessaie",
        ("tx_insufficient_balance", _) => "solde insuffisant pour les frais et la réserve",
        ("tx_bad_auth", _) => "signature refusée par le réseau",
        ("tx_no_source_account", _) => "ton compte n'existe pas (encore) sur ce réseau",
        (_, "op_underfunded") => "solde disponible insuffisant",
        (_, "op_low_reserve") => "montant trop faible pour créer ce compte ou réserve insuffisante",
        (_, "op_no_destination") => "le destinataire n'existe pas : il faut d'abord le créer",
        (_, "op_already_exists") => "ce compte existe déjà",
        (_, "op_no_trust") => "le destinataire n'a pas de ligne de confiance pour cet actif",
        (_, "op_line_full") => "la ligne de confiance du destinataire est pleine",
        (_, "op_not_authorized") => "l'émetteur de l'actif n'autorise pas ce compte",
        _ => "refusée par le réseau",
    };
    format!(
        "{what} ({}{}{})",
        crate::dialog_text::sanitize(tx, 40),
        if op.is_empty() { "" } else { " / " },
        crate::dialog_text::sanitize(op, 40)
    )
}

/// `POST /transactions` (form `tx=`). Horizon waits for the ledger: 200 = included and
/// successful. The returned hash must be ours.
pub async fn submit(ctx: &StellarCtx<'_>, envelope_b64: &str, hash: &str) -> AppResult<String> {
    let body = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("tx", envelope_b64)
        .finish();
    let req = ServerRequest::post_bytes(
        url(ctx, "transactions")?,
        Family::Stellar,
        "application/x-www-form-urlencoded",
        body.into_bytes(),
    );
    // Resubmitting the same signed envelope is harmless (same hash, the sequence number can only
    // be used once), so a lost answer is reported as such, never retried behind the user's back.
    let (status, bytes) = ctx
        .net_client
        .server_request(req, ctx.tor)
        .await
        .map_err(|e| match e {
            AppError::ServerUnreachable(m) => bad(format!(
                "{m} — la transaction {hash} a peut-être été transmise : vérifie l'historique avant de réessayer"
            )),
            other => other,
        })?;
    let v: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    match status {
        200 => {
            let got = v["hash"].as_str().unwrap_or("");
            if !got.eq_ignore_ascii_case(hash) {
                return Err(bad(format!(
                    "Horizon a répondu un hash inattendu ({})",
                    got.chars().take(80).collect::<String>()
                )));
            }
            if v["successful"] == false {
                return Err(AppError::InvalidInput(
                    "transaction Stellar incluse mais échouée (frais prélevés)".into(),
                ));
            }
            Ok(hash.to_lowercase())
        }
        400 => Err(AppError::InvalidInput(format!(
            "transaction Stellar refusée : {}",
            explain_result(&v["extras"]["result_codes"])
        ))),
        // Timeout: the transaction may still land before its maxTime. Never resubmit blindly.
        504 => Err(bad(format!(
            "Horizon n'a pas eu de réponse du réseau à temps : la transaction {hash} peut encore passer avant sa limite de temps, vérifie l'historique avant de réessayer"
        ))),
        s => Err(bad(format!("Horizon : HTTP {s} à l'envoi ({})", short(&bytes)))),
    }
}

/// `(found, successful)` of a transaction by hash.
pub async fn tx_status(ctx: &StellarCtx<'_>, hash: &str) -> AppResult<(bool, bool)> {
    Ok(match get(ctx, &format!("transactions/{hash}")).await? {
        Some(t) => (true, t["successful"] == true),
        None => (false, false),
    })
}

/// Checks before building / signing an XLM payment, against live data. Errors are user-facing.
pub struct PaymentCheck<'a> {
    pub ours: &'a StellarAccountInfo,
    pub dest: &'a StellarAccountInfo,
    pub ledger: &'a StellarLedger,
    /// Stroops sent (payment amount or starting balance).
    pub stroops: i64,
    pub fee: u32,
    pub has_memo: bool,
}

pub fn check_payment(c: &PaymentCheck<'_>) -> AppResult<()> {
    let xlm = |s: i64| crate::commands::format_units(&s.to_string(), 7);
    if !c.ours.exists {
        return Err(AppError::InvalidInput(
            "ton compte Stellar n'est pas encore activé : il doit d'abord recevoir au moins 1 XLM"
                .into(),
        ));
    }
    if c.stroops <= 0 {
        return Err(AppError::InvalidInput("montant nul".into()));
    }
    if c.dest.memo_required && !c.has_memo {
        return Err(AppError::InvalidInput(
            "ce destinataire exige un mémo (SEP-0029, souvent une plateforme d'échange) : ajoute-le, sinon les fonds risquent d'être perdus".into(),
        ));
    }
    let min_create = 2 * c.ledger.base_reserve;
    if !c.dest.exists && c.stroops < min_create {
        return Err(AppError::InvalidInput(format!(
            "ce compte n'existe pas encore : il faut lui envoyer au moins {} XLM (2 × la réserve de base) pour le créer",
            xlm(min_create)
        )));
    }
    let spendable: i64 = c.ours.spendable.parse().unwrap_or(0);
    let need = c.stroops.saturating_add(i64::from(c.fee));
    if need > spendable {
        return Err(AppError::InvalidInput(format!(
            "solde disponible insuffisant : {} XLM disponibles (solde − réserve), il en faut {}",
            xlm(spendable),
            xlm(need)
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn amounts_and_times() {
        assert_eq!(to_stroops(&json!("1")), Some(10_000_000));
        assert_eq!(to_stroops(&json!("0.0000001")), Some(1));
        assert_eq!(to_stroops(&json!("12.3456789")), Some(123_456_789));
        assert_eq!(
            to_stroops(&json!("922337203685.4775807")),
            Some(i64::MAX),
            "maximum trust limit"
        );
        for bad in [
            json!("0.00000001"),
            json!("-1"),
            json!("1e3"),
            json!(1),
            json!(""),
        ] {
            assert_eq!(to_stroops(&bad), None, "{bad}");
        }
        assert_eq!(parse_utc("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_utc("2026-11-01T01:48:00Z"), Some(1_793_497_680));
        assert_eq!(parse_utc("2024-02-29T12:00:00Z"), Some(1_709_208_000));
        assert_eq!(parse_utc("2026-11-01 01:48:00"), None);
        assert_eq!(parse_utc("2026-13-01T01:48:00Z"), None);
        assert_eq!(format_utc(1_793_497_680), "2026-11-01 01:48 UTC");
        assert_eq!(format_utc(1_709_208_000), "2024-02-29 12:00 UTC");
        for t in [0, 951_782_400, 1_793_497_680, 4_102_444_800] {
            let s = format_utc(t);
            let iso = format!("{}T{}:00Z", &s[..10], &s[11..16]);
            assert_eq!(parse_utc(&iso), Some(t - t % 60), "{s}");
        }
    }

    #[test]
    fn account_reserve_and_memo_required() {
        let r = json!({
            "sequence": "4294967298",
            "subentry_count": 1,
            "num_sponsoring": 0,
            "num_sponsored": 0,
            "balances": [
                { "asset_type": "credit_alphanum4", "asset_code": "USDC",
                  "asset_issuer": "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
                  "balance": "5.0000000", "limit": "922337203685.4775807" },
                { "asset_type": "native", "balance": "100.0000000",
                  "selling_liabilities": "2.0000000" }
            ],
            "data": { "config.memo_required": "MQ==" }
        });
        let a = parse_account("G", &r, 5_000_000).unwrap();
        // (2 + 1) × 0.5 XLM + 2 XLM in offers.
        assert_eq!(a.reserve, "35000000");
        assert_eq!(a.spendable, "965000000");
        assert_eq!(a.sequence, "4294967298");
        assert!(a.memo_required);
        assert_eq!(a.trustlines[0].code, "USDC");
        assert_eq!(a.trustlines[0].balance, "50000000");
        assert_eq!(minimum_balance(0, 0, 2, 5_000_000, 0), 0, "fully sponsored");
        assert_eq!(minimum_balance(3, 1, 0, 5_000_000, 0), 30_000_000);
        let none = parse_account("G", &json!({ "sequence": "1", "balances": [] }), 5_000_000);
        assert!(none.is_err());
    }

    #[test]
    fn fee_bid_is_bounded() {
        let s = |p90: &str| json!({ "fee_charged": { "p90": p90 } });
        assert_eq!(fee_bid(&s("100"), 100), 100);
        assert_eq!(fee_bid(&s("3521"), 100), 3521);
        assert_eq!(fee_bid(&s("99"), 100), 100);
        assert_eq!(fee_bid(&s("50000000"), 100), STELLAR_HIGH_FEE_STROOPS);
        assert_eq!(fee_bid(&json!({}), 100), 100);
    }

    #[test]
    fn history_is_normalized() {
        let r = json!({ "_embedded": { "records": [
            { "id": "1", "type": "create_account", "funder": "GA", "account": "GB",
              "starting_balance": "10.0000000", "transaction_hash": "aa",
              "created_at": "2026-11-01T01:48:00Z", "transaction_successful": true,
              "transaction": { "fee_charged": "100", "memo_type": "text", "memo": "a\u{202E}b",
                               "source_account": "GA" } },
            { "id": "2", "type": "payment", "from": "GB", "to": "GA", "asset_type": "credit_alphanum4",
              "asset_code": "USDC", "asset_issuer": "GI", "amount": "1.5000000",
              "transaction_hash": "bb", "created_at": "2026-11-01T01:49:00Z",
              "transaction": { "fee_charged": "100", "memo_type": "id", "memo": "42",
                               "source_account": "GB" } },
            { "id": "3", "type": "account_merge" }
        ] } });
        let n = normalize_payments(&r);
        assert_eq!(n.as_array().unwrap().len(), 2);
        assert_eq!(
            n[0]["amount"],
            json!({ "kind": "native", "stroops": "100000000" })
        );
        assert_eq!(n[0]["time"], 1_793_497_680_000u64);
        assert_eq!(n[0]["memo"]["text"], "ab", "memo text cleaned");
        assert_eq!(n[1]["amount"]["code"], "USDC");
        assert_eq!(n[1]["amount"]["stroops"], "15000000");
        assert_eq!(n[1]["memo"], json!({ "kind": "id", "id": "42" }));
    }

    #[test]
    fn result_codes_are_explained() {
        let e = explain_result(
            &json!({ "transaction": "tx_failed", "operations": ["op_underfunded"] }),
        );
        assert!(
            e.contains("insuffisant") && e.contains("op_underfunded"),
            "{e}"
        );
        let e = explain_result(&json!({ "transaction": "tx_bad_seq" }));
        assert!(e.starts_with("numéro de séquence"), "{e}");
    }

    fn acc(exists: bool, spendable: i64, memo_required: bool) -> StellarAccountInfo {
        StellarAccountInfo {
            exists,
            spendable: spendable.to_string(),
            memo_required,
            ..Default::default()
        }
    }

    #[test]
    fn payment_checks() {
        let ledger = StellarLedger {
            sequence: 1,
            base_fee: 100,
            base_reserve: 5_000_000,
            closed_at: 0,
        };
        let ours = acc(true, 500_000_000, false);
        let ok = |dest: &StellarAccountInfo, stroops: i64, memo: bool| {
            check_payment(&PaymentCheck {
                ours: &ours,
                dest,
                ledger: &ledger,
                stroops,
                fee: 100,
                has_memo: memo,
            })
        };
        assert!(ok(&acc(true, 0, false), 1, false).is_ok());
        let exchange = acc(true, 0, true);
        assert!(
            matches!(ok(&exchange, 10, false), Err(AppError::InvalidInput(m)) if m.contains("exige un mémo"))
        );
        assert!(ok(&exchange, 10, true).is_ok());
        // Unfunded destination: at least 2 × base reserve (1 XLM).
        let new = acc(false, 0, false);
        assert!(
            matches!(ok(&new, 9_999_999, false), Err(AppError::InvalidInput(m)) if m.contains("au moins 1 XLM"))
        );
        assert!(ok(&new, 10_000_000, false).is_ok());
        // More than spendable (fee included).
        assert!(
            matches!(ok(&acc(true, 0, false), 499_999_901, false), Err(AppError::InvalidInput(m)) if m.contains("insuffisant"))
        );
        assert!(ok(&acc(true, 0, false), 499_999_900, false).is_ok());
        assert!(ok(&acc(true, 0, false), 0, false).is_err());
        let none = acc(false, 0, false);
        assert!(check_payment(&PaymentCheck {
            ours: &none,
            dest: &new,
            ledger: &ledger,
            stroops: 20_000_000,
            fee: 100,
            has_memo: false,
        })
        .is_err());
    }
}

/// Real-network test on SDF's Stellar testnet (Tor by default). Run with
/// `cargo test -p kyro-desktop -- --ignored --nocapture stellar_live`.
/// - keys: a NEW random test mnemonic, generated once and kept in the gitignored
///   `.env.stellar-testnet` at the repository root (testnet only);
/// - `KYRO_STELLAR_FRIENDBOT=yes`: funds account 0 from Friendbot (`friendbot.stellar.org`, test
///   only: the app never contacts it);
/// - `KYRO_STELLAR_SEND=yes`: a CreateAccount to an unfunded new account (account 1), then a
///   Payment with an id memo to it, through the real path (live checks, dialog text, signature
///   with identical summary, submission, hash check);
/// - `KYRO_STELLAR_CLEAR=yes`: clear HTTPS instead of Tor.
#[cfg(test)]
mod live {
    use super::*;
    use crate::commands_stellar::{self as cmd, MemoSpec};
    use crate::tor::TorState;

    fn test_seed() -> wallet_core::Seed {
        let path =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../.env.stellar-testnet");
        let words = match std::fs::read_to_string(&path) {
            Ok(s) => s
                .lines()
                .find_map(|l| l.strip_prefix("KYRO_STELLAR_TEST_MNEMONIC="))
                .expect("mnemonic line")
                .trim()
                .to_owned(),
            Err(_) => {
                let m = wallet_core::Mnemonic::generate(wallet_core::WordCount::W12).unwrap();
                let w = m.words().join(" ");
                std::fs::write(
                    &path,
                    format!("# STELLAR TESTNET ONLY — random test mnemonic generated by Kyro's live test (stellar_backend.rs).\n# Never use it for real funds. This file is gitignored (.env.*).\nKYRO_STELLAR_TEST_MNEMONIC={w}\n"),
                )
                .unwrap();
                eprintln!("new test mnemonic written to {}", path.display());
                w
            }
        };
        wallet_core::Mnemonic::parse(&words).unwrap().to_seed("")
    }

    async fn pay(
        c: &StellarCtx<'_>,
        seed: &wallet_core::Seed,
        me: &str,
        to: &str,
        stroops: &str,
        memo: Option<MemoSpec>,
    ) -> String {
        let built = cmd::build(c, me, to, stroops, memo.as_ref()).await.unwrap();
        let (summary, context) = cmd::prepare_sign(c, me, &built.envelope).await.unwrap();
        assert_eq!(summary, built.summary);
        eprintln!(
            "--- dialog ---\n{}---",
            cmd::describe_stellar(crate::i18n::Lang::Fr, &summary, &context)
        );
        assert!(!summary.requires_extra_confirmation);
        let (signed, hash, again) =
            wallet_core::stellar_sign(seed, 0, &built.envelope, Network::Testnet).unwrap();
        assert_eq!(again, summary, "identical summary");
        let t = std::time::Instant::now();
        let got = cmd::broadcast_checked(c, me, &signed).await.unwrap();
        assert_eq!(got, hash);
        eprintln!("SUBMITTED {hash} in {:.1?}", t.elapsed());
        let (found, ok) = tx_status(c, &hash).await.unwrap();
        assert!(found && ok, "{hash} found and successful");
        hash
    }

    #[test]
    #[ignore]
    fn stellar_live_testnet() {
        let net = NetClient::new(std::env::temp_dir().join("kyro-stellar-live")).unwrap();
        let tor = std::env::var("KYRO_STELLAR_CLEAR").as_deref() != Ok("yes");
        let seed = test_seed();
        let me = wallet_core::stellar_address(&seed, 0).unwrap();
        let a1 = wallet_core::stellar_address(&seed, 1).unwrap();
        let a2 = wallet_core::stellar_address(&seed, 2).unwrap();
        eprintln!("addresses: {me} {a1} {a2} (tor: {tor})");
        tauri::async_runtime::block_on(async {
            if tor {
                net.tor.restart();
                while net.tor.status().state != TorState::Ready {
                    assert_ne!(net.tor.status().state, TorState::Error);
                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                }
            }
            let c = StellarCtx {
                net_client: &net,
                network: Network::Testnet,
                tor,
            };
            let t = std::time::Instant::now();
            let root = check_network(&c).await.unwrap();
            eprintln!(
                "testnet Horizon {} ledger {} in {:.1?}",
                root["horizon_version"],
                root["history_latest_ledger"],
                t.elapsed()
            );
            let main = StellarCtx {
                net_client: &net,
                network: Network::Mainnet,
                tor,
            };
            let t = std::time::Instant::now();
            let r = check_network(&main).await.unwrap();
            eprintln!(
                "mainnet Horizon {} « {} » in {:.1?}",
                r["horizon_version"],
                r["network_passphrase"],
                t.elapsed()
            );
            let ledger = latest_ledger(&c).await.unwrap();
            eprintln!(
                "ledger {ledger:?}, fee bid {}",
                fee(&c, &ledger).await.unwrap()
            );

            let mut acc = account(&c, &me, &ledger).await.unwrap();
            if !acc.exists && std::env::var("KYRO_STELLAR_FRIENDBOT").as_deref() == Ok("yes") {
                let mut u = url::Url::parse("https://friendbot.stellar.org/").unwrap();
                u.query_pairs_mut().append_pair("addr", &me);
                let (status, body) = net
                    .server_request(ServerRequest::get(u, Family::Stellar), tor)
                    .await
                    .unwrap();
                eprintln!("friendbot: HTTP {status} {}", short(&body));
                for _ in 0..30 {
                    acc = account(&c, &me, &ledger).await.unwrap();
                    if acc.exists {
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                }
            }
            eprintln!("account {acc:?}");
            eprintln!("history: {}", payments(&c, &me).await.unwrap());
            if std::env::var("KYRO_STELLAR_SEND").as_deref() != Ok("yes") || !acc.exists {
                eprintln!("KYRO_STELLAR_SEND != yes or account not funded: no payment");
                return;
            }
            // Below 2 × base reserve to an unfunded account: refused before anything is signed.
            let r = cmd::build(&c, &me, &a2, "5000000", None).await;
            eprintln!("0.5 XLM to unfunded {a2}: {:?}", r.as_ref().err());
            assert!(
                matches!(r, Err(AppError::InvalidInput(ref m)) if m.contains("au moins 1 XLM"))
            );
            // 1) CreateAccount to an unfunded new account, 2) Payment with an id memo.
            if !account(&c, &a1, &ledger).await.unwrap().exists {
                let h = pay(&c, &seed, &me, &a1, "20000000", None).await;
                eprintln!("CREATE ACCOUNT: {h}");
            }
            let memo = MemoSpec::Id {
                value: "804539585".into(),
            };
            let h = pay(&c, &seed, &me, &a1, "15000000", Some(memo)).await;
            eprintln!("PAYMENT WITH MEMO: {h}");
            let ledger = latest_ledger(&c).await.unwrap();
            eprintln!(
                "recipient now {:?}",
                account(&c, &a1, &ledger).await.unwrap()
            );
            eprintln!("history of recipient: {}", payments(&c, &a1).await.unwrap());
        });
    }
}
