//! Polkadot Asset Hub data from Parity's public Substrate JSON-RPC node over HTTPS
//! (`polkadot-asset-hub-rpc.polkadot.io`, `westend-asset-hub-rpc.polkadot.io` for the testnet),
//! on the `polkadot` Tor family, never with a fallback.
//!
//! Kyro builds the transfer itself: genesis (checked against wallet-core's pin), runtime
//! version, metadata V15 (decoded and checked by wallet-core, cached per spec version),
//! nonce (`system_accountNextIndex`), finalized block (era), balances (`System.Account`
//! storage), fee estimate (`TransactionPaymentApi_query_info` on a zero-signature copy).
//! History: not from the node (no index by account) but from Statescan, see `dot_history`.

use std::sync::Mutex;

use serde::Serialize;
use serde_json::{json, Value};
use wallet_core::{DotAccountInfo, DotRuntime, Network};

use crate::btc_backend::Detected;
use crate::error::{AppError, AppResult};
use crate::net::{Family, NetClient, ServerRequest};

/// Era length (blocks): ≥ 25 min at 6 s, ≥ 8 min at 2 s per block.
pub const ERA_PERIOD: u64 = 256;
/// A payload whose era ends within this many blocks is refused at signing (rebuild).
pub const ERA_MARGIN: u64 = 16;

/// Parity's public node of the chain Kyro uses on `net`.
pub fn default_url(net: Network) -> &'static str {
    match net {
        Network::Mainnet => "https://polkadot-asset-hub-rpc.polkadot.io/",
        Network::Testnet => "https://westend-asset-hub-rpc.polkadot.io/",
    }
}

pub struct DotCtx<'a> {
    pub net_client: &'a NetClient,
    pub network: Network,
    pub tor: bool,
}

fn bad(msg: impl Into<String>) -> AppError {
    AppError::ServerUnreachable(msg.into())
}

/// A JSON-RPC error object (`{ code, message }`).
#[derive(Debug)]
pub enum RpcError {
    Node(i64, String),
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
            RpcError::Node(code, msg) => bad(format!("Polkadot: error {code} ({msg})")),
        }
    }
}

fn short(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).chars().take(200).collect()
}

async fn rpc_raw(ctx: &DotCtx<'_>, method: &str, params: Value) -> Result<Value, RpcError> {
    let u = url::Url::parse(default_url(ctx.network))
        .map_err(|_| AppError::Internal("Polkadot URL".into()))?;
    let body = json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params }).to_string();
    let (status, bytes) = ctx
        .net_client
        .server_request(ServerRequest::post_json(u, Family::Polkadot, body), ctx.tor)
        .await?;
    if status != 200 {
        return Err(bad(format!(
            "Polkadot: HTTP {status} on {method} ({})",
            short(&bytes)
        ))
        .into());
    }
    let mut v: Value = serde_json::from_slice(&bytes)
        .map_err(|_| bad(format!("Polkadot: invalid JSON on {method}")))?;
    if let Some(e) = v.get("error") {
        return Err(RpcError::Node(
            e["code"].as_i64().unwrap_or(0),
            format!(
                "{} {}",
                e["message"].as_str().unwrap_or(""),
                e["data"].as_str().unwrap_or("")
            )
            .trim()
            .chars()
            .take(200)
            .collect(),
        ));
    }
    Ok(v["result"].take())
}

async fn rpc(ctx: &DotCtx<'_>, method: &str, params: Value) -> AppResult<Value> {
    Ok(rpc_raw(ctx, method, params).await?)
}

fn hex_bytes(v: &Value, what: &str) -> AppResult<Vec<u8>> {
    v.as_str()
        .and_then(|s| s.strip_prefix("0x"))
        .and_then(|s| hex::decode(s).ok())
        .ok_or_else(|| bad(format!("Polkadot: {what} missing or malformed")))
}

fn hash32(v: &Value, what: &str) -> AppResult<[u8; 32]> {
    hex_bytes(v, what)?
        .try_into()
        .map_err(|_| bad(format!("Polkadot: {what} of unexpected length")))
}

fn hex_param(b: &[u8]) -> String {
    format!("0x{}", hex::encode(b))
}

/// Genesis hash, which must be the pinned one (a node of another chain is refused).
pub async fn check_genesis(ctx: &DotCtx<'_>) -> AppResult<[u8; 32]> {
    let g = hash32(
        &rpc(ctx, "chain_getBlockHash", json!([0])).await?,
        "genesis",
    )?;
    let chain = wallet_core::dot_chain(ctx.network);
    if g != chain.genesis {
        return Err(AppError::ServerWrongNetwork(format!(
            "this node is not on {} (genesis 0x{}…)",
            chain.name,
            &hex::encode(g)[..16]
        )));
    }
    Ok(g)
}

/// `(spec_version, transaction_version)` of the node's best block.
pub async fn runtime_version(ctx: &DotCtx<'_>) -> AppResult<(u32, u32)> {
    let r = rpc(ctx, "state_getRuntimeVersion", json!([])).await?;
    let n = |k: &str| {
        r[k].as_u64()
            .and_then(|n| u32::try_from(n).ok())
            .ok_or_else(|| bad(format!("Polkadot: {k} missing")))
    };
    Ok((n("specVersion")?, n("transactionVersion")?))
}

/// Runtimes already decoded in this process (metadata is ≈ 0.7 MB), by network and spec.
static RUNTIMES: Mutex<Vec<DotRuntime>> = Mutex::new(Vec::new());

/// The current runtime, checked by wallet-core: genesis pinned, metadata V15 of the node
/// decoded once per spec version, versions identical to `state_getRuntimeVersion`.
pub async fn runtime(ctx: &DotCtx<'_>) -> AppResult<DotRuntime> {
    check_genesis(ctx).await?;
    let (spec, tx) = runtime_version(ctx).await?;
    let cached = RUNTIMES
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .iter()
        .find(|r| r.network == ctx.network && r.spec_version == spec)
        .cloned();
    let rt = match cached {
        Some(r) => r,
        None => {
            // `Metadata_metadata_at_version(15u32)` → `Option<OpaqueMetadata>`.
            let raw = hex_bytes(
                &rpc(
                    ctx,
                    "state_call",
                    json!(["Metadata_metadata_at_version", "0x0f000000"]),
                )
                .await?,
                "metadata",
            )?;
            let net = ctx.network;
            let r =
                crate::commands::blocking(move || Ok(wallet_core::dot_runtime(net, &raw)?)).await?;
            let mut cache = RUNTIMES.lock().unwrap_or_else(|p| p.into_inner());
            cache.retain(|c| c.network != r.network);
            cache.push(r.clone());
            r
        }
    };
    if (rt.spec_version, rt.tx_version) != (spec, tx) {
        return Err(bad(
            "Polkadot: runtime versions inconsistent between the metadata and the node (update in progress?): try again",
        ));
    }
    Ok(rt)
}

/// `System.Account` of `id` (an absent entry is an account that does not exist), at the best
/// block or at `at`.
pub async fn account_info(
    ctx: &DotCtx<'_>,
    id: &[u8; 32],
    at: Option<&[u8; 32]>,
) -> AppResult<DotAccountInfo> {
    let key = hex_param(&wallet_core::dot_account_storage_key(id));
    let params = match at {
        Some(h) => json!([key, hex_param(h)]),
        None => json!([key]),
    };
    let v = rpc(ctx, "state_getStorage", params).await?;
    if v.is_null() {
        return Ok(DotAccountInfo::default());
    }
    Ok(wallet_core::dot_decode_account_info(&hex_bytes(
        &v,
        "System.Account",
    )?)?)
}

/// `Assets.Account(asset, id)` (absent = no holding).
pub async fn asset_account(
    ctx: &DotCtx<'_>,
    asset: u32,
    id: &[u8; 32],
) -> AppResult<wallet_core::DotAssetAccount> {
    let key = hex_param(&wallet_core::dot_asset_account_key(asset, id));
    let v = rpc(ctx, "state_getStorage", json!([key])).await?;
    if v.is_null() {
        return Ok(wallet_core::DotAssetAccount::default());
    }
    Ok(wallet_core::dot_decode_asset_account(&hex_bytes(
        &v,
        "Assets.Account",
    )?)?)
}

/// `Assets.Asset(asset)`, after checking `Assets.Metadata(asset)` (symbol and decimals) against
/// Kyro's table: an asset whose on-chain metadata changed is refused.
pub async fn asset_details(
    ctx: &DotCtx<'_>,
    known: &wallet_core::DotKnownAsset,
) -> AppResult<wallet_core::DotAssetDetails> {
    let meta = rpc(
        ctx,
        "state_getStorage",
        json!([hex_param(&wallet_core::dot_asset_metadata_key(known.id))]),
    )
    .await?;
    let (symbol, decimals) =
        wallet_core::dot_decode_asset_metadata(&hex_bytes(&meta, "Assets.Metadata")?)?;
    if symbol != known.chain_symbol || decimals != known.decimals {
        return Err(AppError::InvalidInput(format!(
            "asset {}: unexpected on-chain metadata (\"{}\", {decimals} decimals): refused",
            known.id,
            crate::dialog_text::sanitize(&symbol, 16)
        )));
    }
    let v = rpc(
        ctx,
        "state_getStorage",
        json!([hex_param(&wallet_core::dot_asset_details_key(known.id))]),
    )
    .await?;
    Ok(wallet_core::dot_decode_asset_details(&hex_bytes(
        &v,
        "Assets.Asset",
    )?)?)
}

/// Next nonce of `address`, transaction pool included (`system_accountNextIndex`).
pub async fn next_nonce(ctx: &DotCtx<'_>, address: &str) -> AppResult<u32> {
    rpc(ctx, "system_accountNextIndex", json!([address]))
        .await?
        .as_u64()
        .and_then(|n| u32::try_from(n).ok())
        .ok_or_else(|| bad("Polkadot: nonce missing"))
}

fn header_number(h: &Value) -> AppResult<u64> {
    h["number"]
        .as_str()
        .and_then(|s| s.strip_prefix("0x"))
        .and_then(|s| u64::from_str_radix(s, 16).ok())
        .ok_or_else(|| bad("Polkadot: block number missing"))
}

/// `(number, hash)` of the last finalized block.
pub async fn finalized(ctx: &DotCtx<'_>) -> AppResult<(u64, [u8; 32])> {
    let hash = hash32(
        &rpc(ctx, "chain_getFinalizedHead", json!([])).await?,
        "finalized block",
    )?;
    let n = block_number(ctx, &hash).await?;
    Ok((n, hash))
}

/// Number of the block `hash` (error if the node does not know it).
pub async fn block_number(ctx: &DotCtx<'_>, hash: &[u8; 32]) -> AppResult<u64> {
    let h = rpc(ctx, "chain_getHeader", json!([hex_param(hash)])).await?;
    if h.is_null() {
        return Err(AppError::InvalidInput(
            "reference block unknown to the node: rebuild the transaction".into(),
        ));
    }
    header_number(&h)
}

/// Fee estimate (planck) of an extrinsic: `TransactionPaymentApi_query_info(uxt, len)`.
pub async fn fee(ctx: &DotCtx<'_>, extrinsic: &[u8]) -> AppResult<u128> {
    let r = rpc(
        ctx,
        "state_call",
        json!([
            "TransactionPaymentApi_query_info",
            hex_param(&wallet_core::dot_fee_query_arg(extrinsic))
        ]),
    )
    .await?;
    Ok(wallet_core::dot_decode_fee_info(&hex_bytes(&r, "fee")?)?)
}

/// `author_submitExtrinsic`; the node's hash must be ours.
pub async fn submit(ctx: &DotCtx<'_>, extrinsic_hex: &str, hash: &str) -> AppResult<String> {
    let got = match rpc_raw(
        ctx,
        "author_submitExtrinsic",
        json!([format!("0x{}", extrinsic_hex.trim())]),
    )
    .await
    {
        Ok(v) => v,
        // 1010: invalid transaction (bad nonce, too low balance, outdated…): nothing happened.
        Err(RpcError::Node(code, msg)) => {
            return Err(AppError::InvalidInput(format!(
                "Polkadot transaction rejected by the node ({code}): {}",
                crate::dialog_text::sanitize(&msg, 200)
            )))
        }
        Err(RpcError::App(e)) => return Err(e),
    };
    let got = got
        .as_str()
        .unwrap_or("")
        .trim_start_matches("0x")
        .to_owned();
    if !got.eq_ignore_ascii_case(hash) {
        return Err(bad(format!(
            "the node answered an unexpected hash ({})",
            got.chars().take(80).collect::<String>()
        )));
    }
    Ok(hash.to_lowercase())
}

/// Live state of a submitted transfer (signed with `nonce`, valid until block `valid_until`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DotTxState {
    /// Not yet in a finalized block, still valid.
    Pending,
    /// The nonce is used in the finalized state: the transaction was included (Kyro does not
    /// decode events: a transfer that failed after inclusion also consumes the nonce).
    Finalized,
    /// Era over and nonce still unused: it will never be included.
    Expired,
}

pub async fn tx_state(
    ctx: &DotCtx<'_>,
    id: &[u8; 32],
    nonce: u32,
    valid_until: u64,
) -> AppResult<(DotTxState, u64)> {
    let (n, hash) = finalized(ctx).await?;
    let info = account_info(ctx, id, Some(&hash)).await?;
    let state = if info.nonce > nonce {
        DotTxState::Finalized
    } else if n >= valid_until {
        DotTxState::Expired
    } else {
        DotTxState::Pending
    };
    Ok((state, n))
}

/// Network check (genesis), with the node's runtime and finalized height.
// Pas encore appelée : pas de serveur Polkadot personnalisé (docs/IPC.md §2.11).
#[allow(dead_code)]
pub async fn probe(ctx: &DotCtx<'_>) -> AppResult<Detected> {
    let g = check_genesis(ctx).await?;
    let (spec, _) = runtime_version(ctx).await?;
    let (n, _) = finalized(ctx).await?;
    Ok(Detected {
        network: Some(
            match ctx.network {
                Network::Mainnet => "mainnet",
                Network::Testnet => "testnet",
            }
            .into(),
        ),
        genesis_hash: Some(hex::encode(g)),
        server_version: Some(format!(
            "{} {spec}",
            wallet_core::dot_chain(ctx.network).spec_name
        )),
        block_height: Some(n),
        ..Default::default()
    })
}

/// Checks before building / signing a transfer, against live data. Errors are user-facing.
pub struct TransferCheck<'a> {
    pub ours: &'a DotAccountInfo,
    pub dest: &'a DotAccountInfo,
    pub existential_deposit: u128,
    pub value: u128,
    pub fee: u128,
    pub decimals: u8,
    pub symbol: &'a str,
}

pub fn check_transfer(c: &TransferCheck<'_>) -> AppResult<()> {
    let fmt = |v: u128| {
        format!(
            "{} {}",
            crate::commands::format_units(&v.to_string(), usize::from(c.decimals)),
            c.symbol
        )
    };
    if !c.ours.exists() {
        return Err(AppError::InvalidInput(format!(
            "your account does not exist on the chain yet (no {} received)",
            c.symbol
        )));
    }
    if !c.dest.exists() && c.value < c.existential_deposit {
        return Err(AppError::InvalidInput(format!(
            "this account does not exist yet: you must send it at least the existential deposit ({}), otherwise the transfer fails",
            fmt(c.existential_deposit)
        )));
    }
    let spendable = c.ours.spendable(c.existential_deposit);
    if c.value.saturating_add(c.fee) > spendable {
        return Err(AppError::InvalidInput(format!(
            "insufficient available balance: {} available (balance − existential deposit − locked part), {} needed with the fees",
            fmt(spendable),
            fmt(c.value.saturating_add(c.fee))
        )));
    }
    Ok(())
}

/// Checks before building / signing a token transfer (`Assets.transfer_keep_alive`).
pub struct AssetCheck<'a> {
    /// Our DOT account (pays the fee).
    pub ours: &'a DotAccountInfo,
    pub existential_deposit: u128,
    pub mine: &'a wallet_core::DotAssetAccount,
    pub dest: &'a wallet_core::DotAssetAccount,
    pub details: &'a wallet_core::DotAssetDetails,
    pub value: u128,
    /// DOT planck.
    pub fee: u128,
    pub symbol: &'a str,
    pub decimals: u8,
}

pub fn check_asset_transfer(c: &AssetCheck<'_>) -> AppResult<()> {
    let tok = |v: u128| {
        format!(
            "{} {}",
            crate::commands::format_units(&v.to_string(), usize::from(c.decimals)),
            c.symbol
        )
    };
    let dot = |v: u128| format!("{} DOT", crate::commands::format_units(&v.to_string(), 10));
    let s = c.symbol;
    if !c.details.live {
        return Err(AppError::InvalidInput(format!(
            "{s} is frozen or being destroyed by its issuer: transfers are impossible"
        )));
    }
    if c.mine.frozen || c.mine.blocked {
        return Err(AppError::InvalidInput(format!(
            "your {s} balance is frozen by the issuer: sending is impossible"
        )));
    }
    if c.dest.blocked {
        return Err(AppError::InvalidInput(format!(
            "this recipient is blocked by the issuer of {s}: it cannot receive anything"
        )));
    }
    // transfer_keep_alive: our holding must stay ≥ min_balance.
    let sendable = c.mine.balance.saturating_sub(c.details.min_balance);
    if c.value > sendable {
        return Err(AppError::InvalidInput(format!(
            "insufficient {s} balance: at most {} (balance {} − {} that stay on the account)",
            tok(sendable),
            tok(c.mine.balance),
            tok(c.details.min_balance)
        )));
    }
    if c.dest.balance == 0 && c.value < c.details.min_balance {
        return Err(AppError::InvalidInput(format!(
            "this recipient has no {s} yet: send at least {} (the asset's minimum balance)",
            tok(c.details.min_balance)
        )));
    }
    let spendable = c.ours.spendable(c.existential_deposit);
    if !c.ours.exists() || c.fee > spendable {
        return Err(AppError::InvalidInput(format!(
            "DOT is needed for the fees: {} available, ≈ {} needed",
            dot(spendable),
            dot(c.fee)
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asset_transfer_checks() {
        let ours = acc(10_000_000_000, 0);
        let det = wallet_core::DotAssetDetails {
            min_balance: 10_000,
            is_sufficient: true,
            live: true,
        };
        let h = |balance| wallet_core::DotAssetAccount {
            balance,
            frozen: false,
            blocked: false,
        };
        let check = |mine: &wallet_core::DotAssetAccount,
                     dest: &wallet_core::DotAssetAccount,
                     value,
                     ours: &DotAccountInfo,
                     details: &wallet_core::DotAssetDetails| {
            check_asset_transfer(&AssetCheck {
                ours,
                existential_deposit: 100_000_000,
                mine,
                dest,
                details,
                value,
                fee: 20_000_000,
                symbol: "USDT",
                decimals: 6,
            })
        };
        let err = |r: AppResult<()>, needle: &str| {
            assert!(
                matches!(&r, Err(AppError::InvalidInput(m)) if m.contains(needle)),
                "{needle}: {r:?}"
            );
        };
        let me = h(5_000_000);
        assert!(check(&me, &h(1), 4_990_000, &ours, &det).is_ok());
        err(
            check(&me, &h(1), 4_990_001, &ours, &det),
            "at most 4,99 USDT",
        );
        err(check(&me, &h(0), 9_999, &ours, &det), "at least 0,01 USDT");
        assert!(check(&me, &h(0), 10_000, &ours, &det).is_ok());
        let frozen = wallet_core::DotAssetAccount { frozen: true, ..me };
        err(check(&frozen, &h(1), 1, &ours, &det), "frozen");
        let blocked = wallet_core::DotAssetAccount {
            blocked: true,
            ..h(1)
        };
        err(check(&me, &blocked, 1, &ours, &det), "blocked");
        let dead = wallet_core::DotAssetDetails { live: false, ..det };
        err(
            check(&me, &h(1), 1, &ours, &dead),
            "frozen or being destroyed",
        );
        // DOT for the fee.
        err(check(&me, &h(1), 1, &acc(100_000_000, 0), &det), "fees");
        err(
            check(&me, &h(1), 1, &DotAccountInfo::default(), &det),
            "fees",
        );
    }

    fn acc(free: u128, frozen: u128) -> DotAccountInfo {
        DotAccountInfo {
            providers: u32::from(free > 0),
            free,
            frozen,
            ..Default::default()
        }
    }

    #[test]
    fn transfer_checks() {
        let ok = |ours: &DotAccountInfo, dest: &DotAccountInfo, value: u128| {
            check_transfer(&TransferCheck {
                ours,
                dest,
                existential_deposit: 100_000_000,
                value,
                fee: 20_000_000,
                decimals: 10,
                symbol: "DOT",
            })
        };
        let me = acc(10_000_000_000, 0); // 1 DOT
        let exists = acc(1, 0);
        let new = DotAccountInfo::default();
        assert!(ok(&me, &exists, 1).is_ok());
        // New account: at least the existential deposit (0.01 DOT).
        assert!(
            matches!(ok(&me, &new, 99_999_999), Err(AppError::InvalidInput(m)) if m.contains("existential deposit (0,01 DOT)"))
        );
        assert!(ok(&me, &new, 100_000_000).is_ok());
        // Keep-alive: balance − ED − fee at most.
        assert!(ok(&me, &exists, 10_000_000_000 - 100_000_000 - 20_000_000).is_ok());
        assert!(
            matches!(ok(&me, &exists, 10_000_000_000 - 100_000_000 - 19_999_999), Err(AppError::InvalidInput(m)) if m.contains("insufficient"))
        );
        // Frozen (staking, vesting) part is not spendable.
        let locked = acc(10_000_000_000, 9_000_000_000);
        assert!(ok(&locked, &exists, 980_000_000).is_ok());
        assert!(ok(&locked, &exists, 980_000_001).is_err());
        // Our account does not exist.
        assert!(ok(&new, &exists, 1).is_err());
    }

    #[test]
    fn default_urls_are_allowlisted() {
        for net in [Network::Mainnet, Network::Testnet] {
            let u = url::Url::parse(default_url(net)).unwrap();
            let h = u.host_str().unwrap();
            assert!(crate::net::ALLOWED_HOSTS.contains(&h), "{h}");
            assert_eq!(
                crate::net::family_for(h, &crate::net::NetContext::default()),
                Family::Polkadot
            );
        }
    }
}

/// Real-network test (Westend Asset Hub, and mainnet reads). Run with
/// `cargo test -p kyro-desktop -- --ignored --nocapture dot_live`.
/// - `KYRO_DOT_CLEAR=yes`: clear net instead of Tor;
/// - mainnet: genesis, metadata, balances, fee of a transfer from the public « abandon … about »
///   account, and `TaggedTransactionQueue_validate_transaction` of a REAL signed transfer: the
///   node answers « Payment » (no funds) — not « BadProof » — which proves the signature
///   payload (genesis, spec / transaction versions, era block, extensions) is what the runtime
///   checks. Nothing is submitted on mainnet;
/// - `KYRO_DOT_SEND=yes`: one real transfer on Westend Asset Hub from the public « abandon …
///   about » account (account 0, funded by others) to its own account `//1`, through the real
///   path (build, live checks, dialog text, signature with identical summary, broadcast with
///   hash check, finalization through the nonce).
#[cfg(test)]
mod live {
    use super::*;
    use crate::tor::TorState;

    const ABANDON: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    fn root() -> wallet_core::PolkadotRoot {
        wallet_core::PolkadotRoot::from_mnemonic(
            &wallet_core::Mnemonic::parse(ABANDON).unwrap(),
            "",
        )
        .unwrap()
    }

    async fn validate(c: &DotCtx<'_>, ext_hex: &str, at: &[u8; 32]) -> String {
        // TaggedTransactionQueue_validate_transaction(source: External = 2, uxt, block_hash)
        let mut arg = vec![2u8];
        arg.extend(hex::decode(ext_hex).unwrap());
        arg.extend_from_slice(at);
        let r = rpc(
            c,
            "state_call",
            json!([
                "TaggedTransactionQueue_validate_transaction",
                hex_param(&arg)
            ]),
        )
        .await
        .unwrap();
        r.as_str().unwrap().to_owned()
    }

    #[test]
    #[ignore]
    fn dot_live_asset_hub() {
        let net = NetClient::new(std::env::temp_dir().join("kyro-dot-live")).unwrap();
        let tor = std::env::var("KYRO_DOT_CLEAR").as_deref() != Ok("yes");
        let r = root();
        tauri::async_runtime::block_on(async {
            if tor {
                net.tor.restart();
                while net.tor.status().state != TorState::Ready {
                    assert_ne!(net.tor.status().state, TorState::Error);
                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                }
            }
            for network in [Network::Mainnet, Network::Testnet] {
                let c = DotCtx {
                    net_client: &net,
                    network,
                    tor,
                };
                let t = std::time::Instant::now();
                eprintln!(
                    "{network:?} probe {:?} in {:.1?}",
                    probe(&c).await,
                    t.elapsed()
                );
                let t = std::time::Instant::now();
                let rt = runtime(&c).await.unwrap();
                eprintln!("runtime {rt:?} in {:.1?}", t.elapsed());
                let me = wallet_core::dot_address(&r, 0, network).unwrap();
                let pk = wallet_core::dot_public_key(&r, 0).unwrap();
                let a1 = wallet_core::dot_address(&r, 1, network).unwrap();
                let info = account_info(&c, &pk, None).await.unwrap();
                eprintln!(
                    "{me}: {info:?}, next nonce {}",
                    next_nonce(&c, &me).await.unwrap()
                );
                let built = crate::commands_dot::build(&c, &rt, &me, &pk, &a1, "10000000000").await;
                eprintln!("build: {:?}", built.as_ref().map(|b| &b.summary));
                if network == Network::Mainnet {
                    // No DOT: building is refused before anything is signed…
                    assert!(matches!(built, Err(AppError::InvalidInput(_))));
                    // …so sign a transfer by hand and ask the node to validate it.
                    let (n, h) = finalized(&c).await.unwrap();
                    let t = wallet_core::DotTransfer {
                        dest: wallet_core::dot_account_id(&a1, network).unwrap(),
                        value: 10_000_000_000,
                        era: wallet_core::DotEra::mortal(ERA_PERIOD, n),
                        block_hash: h,
                        nonce: info.nonce,
                        tip: 0,
                        asset: None,
                    };
                    let payload = wallet_core::dot_transfer_payload(&rt, &t, &pk).unwrap();
                    let probe_ext =
                        wallet_core::dot_fee_probe_extrinsic(&rt, &payload, &pk).unwrap();
                    eprintln!(
                        "mainnet fee estimate {} planck",
                        fee(&c, &probe_ext).await.unwrap()
                    );
                    let (ext, _, _) = wallet_core::dot_sign(&r, 0, &rt, &payload).unwrap();
                    let v = validate(&c, &ext, &h).await;
                    eprintln!("validate_transaction (signed): {v}");
                    // Err(Invalid(Payment)) = 0x01 00 01; Err(Invalid(BadProof)) = 0x01 00 04.
                    assert_eq!(v, "0x010001", "the runtime must accept the signature");
                    let v0 = validate(&c, &hex::encode(probe_ext), &h).await;
                    eprintln!("validate_transaction (zero signature): {v0}");
                    assert_eq!(v0, "0x010004", "a wrong signature must be BadProof");
                    continue;
                }
                let built = built.unwrap();
                eprintln!(
                    "--- dialog ---\n{}---",
                    crate::commands_dot::describe_dot(
                        crate::i18n::Lang::Fr,
                        &built.summary,
                        &built.context,
                        network
                    )
                );
                let block = hash32(&json!(format!("0x{}", built.summary.block_hash)), "h").unwrap();
                let (s2, ctx2) =
                    crate::commands_dot::prepare_sign(&c, &rt, &me, &pk, &built.payload)
                        .await
                        .unwrap();
                assert_eq!(s2, built.summary);
                let (ext, hash, again) = wallet_core::dot_sign(&r, 0, &rt, &built.payload).unwrap();
                assert_eq!(again, s2, "identical summary");
                let v = validate(&c, &ext, &block).await;
                eprintln!("validate_transaction: {v} (context {ctx2:?})");
                assert!(v.starts_with("0x00"), "valid transaction expected: {v}");
                if std::env::var("KYRO_DOT_SEND").as_deref() != Ok("yes") {
                    eprintln!("KYRO_DOT_SEND != yes: nothing submitted");
                    continue;
                }
                let got = crate::commands_dot::broadcast_checked(&c, &rt, &me, &ext, &block)
                    .await
                    .unwrap();
                assert_eq!(got, hash);
                eprintln!("SUBMITTED 0x{hash}");
                let until = built.context.valid_until;
                for _ in 0..60 {
                    tokio::time::sleep(std::time::Duration::from_secs(4)).await;
                    let (s, n) = tx_state(&c, &pk, built.summary.nonce, until).await.unwrap();
                    eprintln!("state {s:?} at finalized #{n}");
                    if s != DotTxState::Pending {
                        assert_eq!(s, DotTxState::Finalized);
                        let to = wallet_core::dot_account_id(&a1, network).unwrap();
                        eprintln!(
                            "recipient now {:?}",
                            account_info(&c, &to, None).await.unwrap()
                        );
                        return;
                    }
                }
                panic!("0x{hash} not finalized");
            }
        });
    }
}
