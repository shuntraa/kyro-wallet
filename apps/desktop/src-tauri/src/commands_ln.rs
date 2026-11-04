//! Lightning payments from a Bitcoin account (`docs/LIGHTNING.md`).
//!
//! The interface talks to the provider through `net_fetch`; everything that decides whether coins
//! may move is here. An accepted swap is written to disk, encrypted, before the deposit is signed:
//! the refund needs those terms, and it needs no provider.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use wallet_core::{
    BtcKind, BtcTxSummary, LnInvoice, LnLockedCoin, LnRefund, LnSwapChecked, LnSwapTerms, Network,
    Seed,
};
use zeroize::Zeroizing;

use crate::accounts::account_arg;
use crate::btc_backend;
use crate::commands::{blocking, confirm_native, seed_from_password};
use crate::commands_servers::ctx;
use crate::error::{AppError, AppResult};
use crate::i18n::Lang;
use crate::state::AppState;

/// Providers Kyro knows (same ids as `packages/swap/src/lightning.ts`).
const PROVIDERS: &[(&str, &str)] = &[("coinos", "Coinos"), ("satsrouting", "SATS Routing")];
const MAX_SWAPS: usize = 500;

/// Writes of the swap file, one at a time.
static STORE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LnSwapRecord {
    pub terms: LnSwapTerms,
    pub provider: String,
    pub invoice: String,
    pub payment_hash: String,
    pub invoice_sat: u64,
    pub expires_at: u64,
    pub key_index: u32,
    pub account: u32,
    pub created_at: u64,
    #[serde(default)]
    pub deposit_txid: Option<String>,
    #[serde(default)]
    pub refund_txid: Option<String>,
}

#[derive(Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LnStore {
    next_index: u32,
    swaps: Vec<LnSwapRecord>,
}

fn store_path(state: &AppState) -> PathBuf {
    state.vault_path.with_extension("lnswaps")
}

fn read_store(state: &AppState, seed: &Seed) -> AppResult<LnStore> {
    let path = store_path(state);
    let data = match std::fs::read(&path) {
        Ok(d) => d,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(LnStore::default()),
        Err(_) => return Err(AppError::Internal("swap file unreadable".into())),
    };
    let plain = wallet_core::ln_open_state(seed, state.network, &data)?;
    serde_json::from_slice(&plain).map_err(|_| AppError::Internal("swap file unreadable".into()))
}

fn write_store(state: &AppState, seed: &Seed, store: &LnStore) -> AppResult<()> {
    let plain = Zeroizing::new(
        serde_json::to_vec(store).map_err(|_| AppError::Internal("swap file".into()))?,
    );
    let sealed = wallet_core::ln_seal_state(seed, state.network, &plain)?;
    let path = store_path(state);
    let tmp = path.with_extension("lnswaps.tmp");
    std::fs::write(&tmp, sealed)
        .and_then(|()| std::fs::rename(&tmp, &path))
        .map_err(|_| AppError::Internal("swap file cannot be written".into()))
}

fn update_store<T>(state: &AppState, f: impl FnOnce(&mut LnStore) -> AppResult<T>) -> AppResult<T> {
    let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    state.with_seed(|seed| {
        let mut store = read_store(state, seed)?;
        let out = f(&mut store)?;
        write_store(state, seed, &store)?;
        Ok(out)
    })
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

fn mainnet_only(state: &AppState) -> AppResult<()> {
    if state.network != Network::Mainnet {
        return Err(AppError::InvalidInput(
            "Lightning payments work on mainnet only".into(),
        ));
    }
    Ok(())
}

fn provider_name(id: &str) -> AppResult<&'static str> {
    PROVIDERS
        .iter()
        .find(|(k, _)| *k == id)
        .map(|(_, name)| *name)
        .ok_or_else(|| AppError::InvalidInput("unknown Lightning provider".into()))
}

#[tauri::command]
pub fn ln_invoice_decode(state: State<'_, AppState>, invoice: String) -> AppResult<LnInvoice> {
    mainnet_only(&state)?;
    Ok(wallet_core::ln_decode_invoice(
        &invoice,
        state.network,
        now_secs(),
    )?)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LnSwapKey {
    index: u32,
    public_key: String,
}

/// Next refund key. Numbers are never reused, even when the swap goes no further.
#[tauri::command]
pub fn ln_swap_key(state: State<'_, AppState>) -> AppResult<LnSwapKey> {
    mainnet_only(&state)?;
    let index = update_store(&state, |s| {
        let i = s.next_index;
        s.next_index = i
            .checked_add(1)
            .ok_or_else(|| AppError::Internal("swap index".into()))?;
        Ok(i)
    })?;
    let public_key = state.with_seed(|seed| {
        Ok(wallet_core::ln_refund_public_key(
            seed,
            state.network,
            index,
        )?)
    })?;
    Ok(LnSwapKey { index, public_key })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LnAcceptRequest {
    invoice: String,
    terms: LnSwapTerms,
    key_index: u32,
    provider: String,
    account: Option<u32>,
}

fn accept(state: &AppState, req: LnAcceptRequest, tip: u64, now: u64) -> AppResult<LnSwapChecked> {
    provider_name(&req.provider)?;
    let net = state.network;
    let account = account_arg(req.account)?;
    let inv = wallet_core::ln_decode_invoice(&req.invoice, net, now)?;
    let public =
        state.with_seed(|seed| Ok(wallet_core::ln_refund_public_key(seed, net, req.key_index)?))?;
    let checked = wallet_core::ln_check_swap(&inv, &req.terms, &public, net, tip, now)?;
    update_store(state, |s| {
        if req.key_index >= s.next_index {
            return Err(AppError::InvalidInput("unknown refund key".into()));
        }
        if let Some(old) = s
            .swaps
            .iter()
            .find(|o| o.payment_hash == inv.payment_hash && o.deposit_txid.is_some())
        {
            return Err(AppError::InvalidInput(format!(
                "this invoice was already sent to {}",
                old.provider
            )));
        }
        // A swap that was never funded gives way to the new one for the same invoice.
        s.swaps
            .retain(|o| o.payment_hash != inv.payment_hash && o.terms.id != req.terms.id);
        if s.swaps.len() >= MAX_SWAPS {
            let drop = s
                .swaps
                .iter()
                .position(|o| o.deposit_txid.is_none() || o.refund_txid.is_some());
            match drop {
                Some(i) => {
                    s.swaps.remove(i);
                }
                None => return Err(AppError::InvalidInput("too many open swaps".into())),
            }
        }
        s.swaps.push(LnSwapRecord {
            terms: req.terms.clone(),
            provider: req.provider.clone(),
            invoice: inv.invoice.clone(),
            payment_hash: inv.payment_hash.clone(),
            invoice_sat: inv.amount_sat,
            expires_at: inv.expires_at,
            key_index: req.key_index,
            account,
            created_at: now,
            deposit_txid: None,
            refund_txid: None,
        });
        Ok(())
    })?;
    Ok(checked)
}

/// Checks the provider's answer against the invoice and keeps the terms. Nothing can be deposited
/// safely without this: the interface takes the address it returns.
#[tauri::command]
pub async fn ln_swap_accept(
    state: State<'_, AppState>,
    request: LnAcceptRequest,
) -> AppResult<LnSwapChecked> {
    mainnet_only(&state)?;
    let s = state.settings();
    let tip = btc_backend::tip_height(&ctx(&state, &s)?).await?;
    accept(&state, request, tip, now_secs())
}

#[tauri::command]
pub fn ln_swaps(state: State<'_, AppState>) -> AppResult<Vec<LnSwapRecord>> {
    let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    state.with_seed(|seed| Ok(read_store(&state, seed)?.swaps))
}

fn valid_txid(t: &str) -> bool {
    t.len() == 64 && t.bytes().all(|b| b.is_ascii_hexdigit())
}

#[tauri::command]
pub fn ln_swap_deposited(state: State<'_, AppState>, id: String, txid: String) -> AppResult<()> {
    if !valid_txid(&txid) {
        return Err(AppError::InvalidInput("transaction id".into()));
    }
    update_store(&state, |s| {
        let r = s
            .swaps
            .iter_mut()
            .find(|r| r.terms.id == id)
            .ok_or_else(|| AppError::InvalidInput("unknown swap".into()))?;
        r.deposit_txid = Some(txid);
        Ok(())
    })
}

fn refund_body(lang: Lang, r: &LnSwapRecord, refund: &LnRefund) -> String {
    let (provider, hash) = (
        provider_name(&r.provider).unwrap_or("?"),
        &r.payment_hash[..16.min(r.payment_hash.len())],
    );
    lang.pick(
        format!(
            "REMBOURSEMENT LIGHTNING\nÉchange : {provider}\nFacture : {hash}…\nDe : {}\nVers ton adresse : {}\nMontant : {} sat\nFrais réseau : {} sat",
            r.terms.address, refund.destination, refund.amount_sat, refund.fee_sat
        ),
        format!(
            "LIGHTNING REFUND\nSwap: {provider}\nInvoice: {hash}…\nFrom: {}\nTo your address: {}\nAmount: {} sat\nNetwork fee: {} sat",
            r.terms.address, refund.destination, refund.amount_sat, refund.fee_sat
        ),
    )
}

/// Builds and signs the refund of swap `id` to the swap account's own first address. The coins are
/// read here, the destination is derived here, and the native window shows the result.
#[tauri::command]
pub async fn ln_refund(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    fee_rate: u64,
    password: String,
) -> AppResult<LnRefund> {
    mainnet_only(&state)?;
    let net = state.network;
    let seed = seed_from_password(&state, Zeroizing::new(password)).await?;
    let record = {
        let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        read_store(&state, &seed)?
            .swaps
            .into_iter()
            .find(|r| r.terms.id == id)
            .ok_or_else(|| AppError::InvalidInput("unknown swap".into()))?
    };
    if record.refund_txid.is_some() {
        return Err(AppError::InvalidInput("already refunded".into()));
    }
    let s = state.settings();
    let c = ctx(&state, &s)?;
    let tip = btc_backend::tip_height(&c).await?;
    let raw = btc_backend::address_utxos(&c, &record.terms.address).await?;
    let coins: Vec<LnLockedCoin> = raw
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|u| {
            Some(LnLockedCoin {
                txid: u.get("txid")?.as_str()?.to_owned(),
                vout: u32::try_from(u.get("vout")?.as_u64()?).ok()?,
                value: u.get("value")?.as_u64()?,
            })
        })
        .collect();
    let (sd, rec) = (seed.clone(), record.clone());
    let refund = blocking(move || {
        let dest = wallet_core::btc_address(&sd, net, BtcKind::Segwit, rec.account, false, 0)?;
        Ok(wallet_core::ln_refund_tx(
            &sd,
            net,
            &rec.terms,
            rec.key_index,
            &coins,
            &dest,
            fee_rate,
            tip,
        )?)
    })
    .await?;
    let lang = crate::i18n::current();
    confirm_native(
        &app,
        lang.confirm_tx_title(),
        refund_body(lang, &record, &refund),
    )
    .await?;
    state.touch();
    Ok(refund)
}

/// Broadcasts a refund signed by `ln_refund` and remembers it.
#[tauri::command]
pub async fn ln_refund_broadcast(
    state: State<'_, AppState>,
    id: String,
    hex: String,
) -> AppResult<String> {
    let s = state.settings();
    let txid = btc_backend::broadcast(&ctx(&state, &s)?, &hex).await?;
    let t = txid.clone();
    update_store(&state, |store| {
        if let Some(r) = store.swaps.iter_mut().find(|r| r.terms.id == id) {
            r.refund_txid = Some(t);
        }
        Ok(())
    })?;
    Ok(txid)
}

/// Lines put at the top of the signing window when a payment goes to a known lockup address.
pub(crate) fn deposit_head(state: &AppState, lang: Lang, summary: &BtcTxSummary) -> String {
    let swaps = {
        let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        state
            .with_seed(|seed| read_store(state, seed))
            .map(|s| s.swaps)
            .unwrap_or_default()
    };
    deposit_lines(lang, &swaps, summary)
}

fn deposit_lines(lang: Lang, swaps: &[LnSwapRecord], summary: &BtcTxSummary) -> String {
    let found = summary
        .outputs
        .iter()
        .filter(|(_, _, change)| !change)
        .find_map(|(address, sat, _)| {
            swaps
                .iter()
                .find(|r| r.terms.address == *address)
                .map(|r| (r, *sat))
        });
    let Some((r, sat)) = found else {
        return String::new();
    };
    let provider = provider_name(&r.provider).unwrap_or("?");
    let warn = if sat == r.terms.expected_amount {
        ""
    } else {
        lang.pick(
            "ATTENTION : ce montant n’est pas celui de l’échange.\n",
            "WARNING: this amount is not the swap's amount.\n",
        )
    };
    lang.pick(
        format!(
            "PAIEMENT LIGHTNING via {provider}\nFacture : {} sat\nÀ envoyer sur la chaîne : {} sat\n{warn}Si le paiement échoue, remboursement à partir du bloc {}.\n\n",
            r.invoice_sat, r.terms.expected_amount, r.terms.timeout_block_height
        ),
        format!(
            "LIGHTNING PAYMENT via {provider}\nInvoice: {} sat\nTo send on-chain: {} sat\n{warn}If the payment fails, refund from block {}.\n\n",
            r.invoice_sat, r.terms.expected_amount, r.terms.timeout_block_height
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record() -> LnSwapRecord {
        LnSwapRecord {
            terms: LnSwapTerms {
                id: "abc".into(),
                address: "bc1plockup".into(),
                expected_amount: 100_402,
                claim_public_key: String::new(),
                claim_leaf: String::new(),
                refund_leaf: String::new(),
                timeout_block_height: 975_576,
            },
            provider: "coinos".into(),
            invoice: "lnbc".into(),
            payment_hash: "00".repeat(32),
            invoice_sat: 100_000,
            expires_at: 0,
            key_index: 0,
            account: 0,
            created_at: 0,
            deposit_txid: None,
            refund_txid: None,
        }
    }

    fn summary(outputs: Vec<(String, u64, bool)>) -> BtcTxSummary {
        BtcTxSummary {
            outputs,
            fee_sats: 300,
            warnings: Vec::new(),
            requires_extra_confirmation: false,
        }
    }

    #[test]
    fn signing_window_names_the_payment() {
        let swaps = [record()];
        let s = summary(vec![
            ("bc1plockup".into(), 100_402, false),
            ("bc1qchange".into(), 5_000, true),
        ]);
        let head = deposit_lines(Lang::En, &swaps, &s);
        assert!(head.contains("LIGHTNING PAYMENT via Coinos"));
        assert!(head.contains("100000 sat"));
        assert!(head.contains("975576"));
        assert!(!head.contains("WARNING"));
    }

    #[test]
    fn signing_window_warns_on_another_amount() {
        let swaps = [record()];
        let s = summary(vec![("bc1plockup".into(), 1, false)]);
        assert!(deposit_lines(Lang::En, &swaps, &s).contains("WARNING"));
    }

    #[test]
    fn unrelated_sends_are_untouched() {
        let swaps = [record()];
        let s = summary(vec![("bc1qother".into(), 100_402, false)]);
        assert_eq!(deposit_lines(Lang::En, &swaps, &s), "");
        // Change to a lockup address is not a payment.
        let s = summary(vec![("bc1plockup".into(), 100_402, true)]);
        assert_eq!(deposit_lines(Lang::En, &swaps, &s), "");
    }

    #[test]
    fn only_known_providers() {
        assert_eq!(provider_name("coinos").unwrap(), "Coinos");
        assert!(provider_name("evil").is_err());
    }
}
