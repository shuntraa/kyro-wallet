//! IPC commands for TRON (`tron_*`): address, account resources, TRC-20 balance, history,
//! transaction building **by Kyro** from the latest block, signing behind the password and the
//! native dialog (decoded by Rust, resources and TRX burned re-read live), and broadcast with
//! txid check. Contract: docs/IPC.md §2.5.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, State};
use wallet_core::{Network, TronAction, TronContract, TronRaw, TronTxSummary, TronWarning};
use zeroize::Zeroizing;

use crate::accounts::{account_arg, confirm_signer, Chain, SignerInfo};
use crate::commands::{blocking, confirm_native, format_units, seed_from_password};
use crate::error::{AppError, AppResult};
use crate::servers::{host_of, utxo_network_key, TronServer};
use crate::state::AppState;
use crate::tron_backend::{self, TronCtx, TronEstimate, EXPIRATION_MS};

/// TRC-20 tokens Kyro names itself in the dialog (contract, symbol, decimals). Sources:
/// mainnet USDT (Tether); Nile USDT `TXYZopYR…` checked on chain 2026-10-30 (`symbol()` =
/// USDT, `name()` = Tether USD, `decimals()` = 6). Nile has its own USDT, unrelated to mainnet's.
pub const KNOWN_TOKENS: &[(Network, &str, &str, u8)] = &[
    (
        Network::Mainnet,
        "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
        "USDT",
        6,
    ),
    (
        Network::Testnet,
        "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf",
        "USDT",
        6,
    ),
];

fn known_token(net: Network, contract: &str) -> Option<(&'static str, u8)> {
    KNOWN_TOKENS
        .iter()
        .find(|(n, c, _, _)| *n == net && *c == contract)
        .map(|(_, _, s, d)| (*s, *d))
}

pub(crate) fn ctx(state: &AppState) -> TronCtx<'_> {
    let s = state.settings();
    let api_key = state
        .env_keys
        .trongrid
        .clone()
        .or_else(|| s.api_keys.trongrid.clone())
        .filter(|k| !k.contains(['\r', '\n']));
    TronCtx {
        net_client: &state.net,
        network: state.network,
        tor: s.tor.enabled,
        server: s.servers.tron.for_network(state.network),
        api_key,
    }
}

/// Our address of TRON account `account` (`m/44'/195'/account'/0/0`).
pub(crate) fn our_address(state: &AppState, account: u32) -> AppResult<String> {
    state.with_seed(|seed| Ok(wallet_core::tron_address(seed, account)?))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

fn trx(sun: &str) -> String {
    format!("{} TRX", format_units(sun, 6))
}

fn net_label(net: Network) -> &'static str {
    match net {
        Network::Mainnet => "TRON",
        Network::Testnet => "TRON Nile (testnet)",
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenHint {
    pub symbol: String,
    pub decimals: u8,
}

/// Body of the native dialog, built from Rust's decoding and the live resource estimate.
pub(crate) fn describe_tron(
    s: &TronTxSummary,
    e: &TronEstimate,
    net: Network,
    hint: Option<&TokenHint>,
    now: i64,
) -> String {
    let mut out = format!("Envoi {}\n\n", net_label(net));
    match &s.action {
        TronAction::TrxTransfer { to, amount } => {
            out += &format!("À : {to}\nMontant : {}\n", trx(amount));
            if !e.recipient_exists {
                out += &format!(
                    "\nCe compte n'existe pas encore sur TRON : l'activer brûle {} en plus.\n",
                    trx(&e.activation_fee)
                );
            }
        }
        TronAction::Trc20Transfer {
            contract,
            to,
            amount,
            call_value,
        } => {
            let shown = match known_token(net, contract) {
                Some((sym, dec)) => format!(
                    "{} {sym} (unités brutes : {amount})",
                    format_units(amount, usize::from(dec))
                ),
                None => match hint {
                    Some(h) => format!(
                        "{amount} unités brutes (selon l'interface : {} {} — token non vérifié par Kyro)",
                        format_units(amount, usize::from(h.decimals)),
                        h.symbol
                    ),
                    None => format!("{amount} unités brutes (token inconnu de Kyro)"),
                },
            };
            out += &format!(
                "Envoi de token TRC-20 : {shown}\nContrat du token : {contract}\nÀ : {to}\n"
            );
            if call_value != "0" {
                out += &format!("TRX envoyés au contrat : {}\n", trx(call_value));
            }
        }
        TronAction::ContractCall {
            contract,
            selector,
            data,
            call_value,
        } => {
            out += &format!(
                "Appel de contrat INCONNU : {contract}\nFonction (sélecteur) : {selector}\nDonnées : {data}\nTRX envoyés : {}\n",
                trx(call_value)
            );
        }
    }
    // Creating an account always burns 0.1 TRX of bandwidth (free bandwidth does not apply);
    // that amount is already part of the activation fee shown above.
    let new_account = e.activation_fee != "0";
    let bw_source = if new_account {
        "compris dans l'activation"
    } else if e.staked_bandwidth >= e.bandwidth_needed {
        "bande passante gelée"
    } else if e.free_bandwidth >= e.bandwidth_needed {
        "bande passante gratuite"
    } else {
        "TRX brûlés"
    };
    out += &format!(
        "\nBande passante : {} octets nécessaires · disponible {} gratuite + {} gelée → {} ({})\n",
        e.bandwidth_needed,
        e.free_bandwidth,
        e.staked_bandwidth,
        trx(&e.bandwidth_burn),
        bw_source
    );
    if !matches!(s.action, TronAction::TrxTransfer { .. }) {
        out += &format!(
            "Énergie : {} estimée · {} disponible → ≈ {} brûlés ({} sun par unité)\nTRX brûlés au maximum pour l'énergie (fee_limit) : {}\n",
            e.energy_needed,
            e.energy_available,
            trx(&e.energy_burn),
            e.energy_fee,
            trx(&s.fee_limit)
        );
    }
    out += &format!(
        "\nTotal brûlé estimé : {} · au maximum : {}\nSolde : {}",
        trx(&e.total_burn),
        trx(&e.total_burn_max),
        trx(&e.balance)
    );
    if !s.memo.is_empty() {
        let text = hex::decode(&s.memo)
            .ok()
            .and_then(|b| String::from_utf8(b).ok())
            .unwrap_or_else(|| s.memo.clone());
        out += &format!("\nMémo : {text}");
    }
    let mins = (s.expiration - now).max(0) / 60_000;
    out += &format!(
        "\n\nExpire dans {mins} min · bloc de référence {}/{}\nID : {}",
        s.ref_block_bytes, s.ref_block_hash, s.txid
    );
    out
}

pub(crate) fn describe_tron_extra(s: &TronTxSummary) -> String {
    let mut out = String::from("Kyro a trouvé des éléments inhabituels dans cette transaction :\n");
    for w in &s.warnings {
        out += match w {
            TronWarning::UnknownCall { .. } => "• appel de contrat qui n'est pas un transfert TRC-20 : Kyro ne sait pas ce qu'il fait (approbation, échange…)\n",
            TronWarning::CallValue => "• des TRX sont envoyés au contrat en plus de l'appel\n",
            TronWarning::Memo => "• la transaction porte un mémo (sur mainnet, un mémo coûte des TRX en plus)\n",
            TronWarning::HighFeeLimit => "• plafond de frais (fee_limit) supérieur à 100 TRX\n",
        };
    }
    out += "\nNe signe que si tu sais exactement pourquoi. Signer quand même ?";
    out
}

// ---------------------------------------------------------------- read commands

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TronBackendInfo {
    pub kind: &'static str,
    /// `mainnet` | `testnet` (Nile)
    pub network: &'static str,
    pub label: String,
    pub tor: bool,
}

#[tauri::command]
pub fn tron_backend_info(state: State<'_, AppState>) -> TronBackendInfo {
    let c = ctx(&state);
    TronBackendInfo {
        kind: c.server.kind_name(),
        network: utxo_network_key(state.network),
        label: tron_backend::base(&c)
            .ok()
            .as_deref()
            .and_then(host_of)
            .unwrap_or_default(),
        tor: c.tor,
    }
}

/// Address of TRON account `account` (absent = 0). `index` is accepted for older callers and
/// must be 0 (one address per account).
#[tauri::command]
pub fn tron_address(
    state: State<'_, AppState>,
    index: Option<u32>,
    account: Option<u32>,
) -> AppResult<String> {
    if index.unwrap_or(0) != 0 {
        return Err(AppError::InvalidInput(
            "TRON : une seule adresse par compte (index 0)".into(),
        ));
    }
    our_address(&state, account_arg(account)?)
}

#[tauri::command]
pub async fn tron_account(
    state: State<'_, AppState>,
    address: String,
) -> AppResult<tron_backend::TronAccount> {
    tron_backend::account(&ctx(&state), &address).await
}

#[tauri::command]
pub async fn tron_trc20_balance(
    state: State<'_, AppState>,
    contract: String,
    address: String,
) -> AppResult<String> {
    tron_backend::trc20_balance(&ctx(&state), &contract, &address).await
}

#[tauri::command]
pub async fn tron_txs(state: State<'_, AppState>, address: String) -> AppResult<Value> {
    tron_backend::history(&ctx(&state), &address).await
}

// ---------------------------------------------------------------- build, sign, broadcast

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TronBuilt {
    /// `raw_data`, hex: what `tron_sign_tx` signs.
    pub raw: String,
    pub txid: String,
    pub summary: TronTxSummary,
    pub estimate: TronEstimate,
}

/// Builds `raw_data` in Rust from the latest block: TRX if `token` is absent, else a TRC-20
/// `transfer(to, amount)` on `token` with `fee_limit` from an energy simulation. `amount`:
/// smallest unit (sun or token units), decimal string.
pub(crate) async fn build(
    c: &TronCtx<'_>,
    owner: &str,
    to: &str,
    amount: &str,
    token: Option<&str>,
) -> AppResult<TronBuilt> {
    let owner_b = wallet_core::tron_address_bytes(owner)?;
    let to_b = wallet_core::tron_address_bytes(to)?;
    let (number, id, ts) = tron_backend::now_block(c).await?;
    let (ref_block_bytes, ref_block_hash) = wallet_core::tron_ref_block(number, &id)?;
    let p = tron_backend::params(c).await?;
    let acc = tron_backend::account(c, owner).await?;
    let (contract, fee_limit, energy, recipient_exists) = match token {
        None => {
            let sun: i64 = amount
                .trim()
                .parse()
                .ok()
                .filter(|v| *v > 0)
                .ok_or_else(|| AppError::InvalidInput("montant TRX invalide".into()))?;
            let exists = tron_backend::account(c, to).await?.exists;
            (
                TronContract::Transfer {
                    owner: owner_b,
                    to: to_b,
                    amount: sun,
                },
                0,
                0,
                exists,
            )
        }
        Some(t) => {
            let contract = wallet_core::tron_address_bytes(t)?;
            let data = wallet_core::tron_trc20_transfer_data(to, amount)?;
            let energy = tron_backend::simulate_energy(c, owner, t, &data).await?;
            let fee_limit = tron_backend::fee_limit_for(energy, &p);
            (
                TronContract::Trigger {
                    owner: owner_b,
                    contract,
                    call_value: 0,
                    data,
                },
                fee_limit,
                energy,
                true,
            )
        }
    };
    let raw = TronRaw {
        ref_block_bytes,
        ref_block_hash,
        expiration: ts + EXPIRATION_MS,
        memo: Vec::new(),
        contract,
        timestamp: ts,
        fee_limit: i64::try_from(fee_limit).unwrap_or(i64::MAX),
    };
    let raw_hex = hex::encode(raw.encode());
    // Rust re-decodes what it built, with the same checks as before signing.
    let summary = wallet_core::tron_decode_raw(&raw_hex, owner)?;
    let estimate = tron_backend::estimate(&tron_backend::EstimateInput {
        account: &acc,
        params: p,
        raw_size: summary.raw_size,
        recipient_exists,
        is_trx: token.is_none(),
        energy_needed: energy,
        fee_limit,
    });
    Ok(TronBuilt {
        txid: summary.txid.clone(),
        raw: raw_hex,
        summary,
        estimate,
    })
}

#[tauri::command]
pub async fn tron_build_tx(
    state: State<'_, AppState>,
    to: String,
    amount: String,
    token: Option<String>,
    account: Option<u32>,
) -> AppResult<TronBuilt> {
    let owner = our_address(&state, account_arg(account)?)?;
    build(&ctx(&state), &owner, &to, &amount, token.as_deref()).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TronSigned {
    /// 65 bytes `r || s || v`, hex.
    pub signature: String,
    pub txid: String,
    pub summary: TronTxSummary,
    pub estimate: TronEstimate,
}

#[tauri::command]
pub async fn tron_sign_tx(
    app: AppHandle,
    state: State<'_, AppState>,
    raw: String,
    password: String,
    token: Option<TokenHint>,
    account: Option<u32>,
) -> AppResult<TronSigned> {
    if !state.is_unlocked() {
        return Err(AppError::Locked);
    }
    let a = account_arg(account)?;
    let me = our_address(&state, a)?;
    let signer = SignerInfo::new(&state, Chain::Tron, a, wallet_core::tron_path(a));
    let summary = wallet_core::tron_decode_raw(&raw, &me)?;
    tron_backend::check_expiration(&summary, now_ms())?;
    let seed = seed_from_password(&state, Zeroizing::new(password)).await?;
    let c = ctx(&state);
    let estimate = tron_backend::estimate_for(&c, &summary).await?;
    confirm_native(
        &app,
        "Confirmer la transaction TRON",
        signer.body(&describe_tron(
            &summary,
            &estimate,
            state.network,
            token.as_ref(),
            now_ms(),
        )),
    )
    .await?;
    confirm_signer(&app, &signer).await?;
    if summary.requires_extra_confirmation {
        confirm_native(
            &app,
            "Attention : transaction à vérifier",
            describe_tron_extra(&summary),
        )
        .await?;
    }
    let raw2 = raw.clone();
    let (sig, again) = blocking(move || Ok(wallet_core::tron_sign(&seed, a, &raw2)?)).await?;
    if again != summary {
        return Err(AppError::Internal(
            "résumé différent entre l'aperçu et la signature".into(),
        ));
    }
    state.touch();
    Ok(TronSigned {
        signature: hex::encode(sig),
        txid: summary.txid.clone(),
        summary,
        estimate,
    })
}

/// Checks that `signature` recovers to `owner` over `raw`, then broadcasts.
pub(crate) async fn broadcast_checked(
    c: &TronCtx<'_>,
    owner: &str,
    raw: &str,
    signature: &str,
) -> AppResult<String> {
    let sig: [u8; 65] = hex::decode(signature.trim())
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or_else(|| AppError::InvalidInput("signature : 65 octets hex".into()))?;
    if wallet_core::tron_recover_signer(raw, &sig)? != owner {
        return Err(AppError::InvalidInput(
            "la signature ne correspond pas à ton adresse TRON".into(),
        ));
    }
    tron_backend::broadcast(c, raw, &sig).await
}

#[tauri::command]
pub async fn tron_broadcast(
    state: State<'_, AppState>,
    raw: String,
    signature: String,
    account: Option<u32>,
) -> AppResult<String> {
    let me = our_address(&state, account_arg(account)?)?;
    broadcast_checked(&ctx(&state), &me, &raw, &signature).await
}

/// Probe used by `settings_set` / `server_test`.
pub(crate) async fn probe(
    net: &crate::net::NetClient,
    network: Network,
    server: &TronServer,
    tor: bool,
) -> AppResult<crate::btc_backend::Detected> {
    tron_backend::probe(&TronCtx {
        net_client: net,
        network,
        tor,
        server: server.clone(),
        api_key: None,
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summary(action: TronAction, warnings: Vec<TronWarning>) -> TronTxSummary {
        TronTxSummary {
            txid: "ab".repeat(32),
            owner: "TY72iA3SBtrds3QLYsS7LwYfkzXwAXCRWT".into(),
            action,
            fee_limit: "3900000".into(),
            expiration: 600_000,
            timestamp: 0,
            ref_block_bytes: "cab8".into(),
            ref_block_hash: "883caa0677c5a7f3".into(),
            memo: String::new(),
            raw_size: 210,
            requires_extra_confirmation: !warnings.is_empty(),
            warnings,
        }
    }

    fn est(exists: bool) -> TronEstimate {
        TronEstimate {
            bandwidth_needed: 345,
            free_bandwidth: 600,
            staked_bandwidth: 0,
            bandwidth_burn: "0".into(),
            activation_fee: if exists { "0" } else { "1100000" }.into(),
            recipient_exists: exists,
            energy_needed: 30_000,
            energy_available: 0,
            energy_fee: 100,
            energy_burn: "3000000".into(),
            fee_limit: "3900000".into(),
            total_burn: "3000000".into(),
            total_burn_max: "3900000".into(),
            balance: "150000000".into(),
        }
    }

    #[test]
    fn dialog_texts() {
        let s = summary(
            TronAction::Trc20Transfer {
                contract: "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf".into(),
                to: "TFz2CJn9CJb8C4i1Gke3jmZX2fRMJxniH2".into(),
                amount: "1500000".into(),
                call_value: "0".into(),
            },
            vec![],
        );
        let d = describe_tron(&s, &est(true), Network::Testnet, None, 0);
        for needle in [
            "Envoi TRON Nile (testnet)",
            "1,5 USDT (unités brutes : 1500000)",
            "À : TFz2CJn9CJb8C4i1Gke3jmZX2fRMJxniH2",
            "345 octets nécessaires · disponible 600 gratuite + 0 gelée → 0 TRX (bande passante gratuite)",
            "Énergie : 30000 estimée · 0 disponible → ≈ 3 TRX brûlés (100 sun par unité)",
            "(fee_limit) : 3,9 TRX",
            "au maximum : 3,9 TRX",
            "Solde : 150 TRX",
            "Expire dans 10 min",
        ] {
            assert!(d.contains(needle), "{needle} missing in:\n{d}");
        }
        // Unknown token on mainnet: raw units, UI hint labelled as such.
        let d = describe_tron(
            &s,
            &est(true),
            Network::Mainnet,
            Some(&TokenHint {
                symbol: "FAKE".into(),
                decimals: 6,
            }),
            0,
        );
        assert!(d.contains("selon l'interface : 1,5 FAKE — token non vérifié par Kyro"));
        // TRX to a new account: activation shown.
        let t = summary(
            TronAction::TrxTransfer {
                to: "TFz2CJn9CJb8C4i1Gke3jmZX2fRMJxniH2".into(),
                amount: "1000000".into(),
            },
            vec![],
        );
        let d = describe_tron(&t, &est(false), Network::Testnet, None, 0);
        assert!(d.contains("n'existe pas encore sur TRON : l'activer brûle 1,1 TRX en plus"));
        assert!(!d.contains("Énergie"));
        let x = summary(
            TronAction::ContractCall {
                contract: "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf".into(),
                selector: "095ea7b3".into(),
                data: "095ea7b3".into(),
                call_value: "0".into(),
            },
            vec![TronWarning::UnknownCall {
                selector: "095ea7b3".into(),
            }],
        );
        assert!(describe_tron(&x, &est(true), Network::Testnet, None, 0)
            .contains("Appel de contrat INCONNU"));
        assert!(describe_tron_extra(&x).contains("n'est pas un transfert TRC-20"));
    }
}
