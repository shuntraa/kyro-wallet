//! IPC commands for TRON (`tron_*`): address, account resources, TRC-20 balance, history,
//! transaction building **by Kyro** from the latest block, signing behind the password and the
//! native dialog (decoded by Rust, resources and TRX burned re-read live), and broadcast with
//! txid check. Contract: docs/IPC.md §2.5.

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, State};
use wallet_core::{Network, TronAction, TronContract, TronRaw, TronTxSummary, TronWarning};
use zeroize::Zeroizing;

use crate::accounts::{account_arg, confirm_signer, Chain, SignerInfo};
use crate::commands::{blocking, confirm_native, format_units_in, seed_from_password};
use crate::error::{AppError, AppResult};
use crate::i18n::Lang;
use crate::servers::{host_of, utxo_network_key, TronServer};
use crate::state::AppState;
use crate::tron_backend::{self, TronCtx, TronEstimate, EXPIRATION_MS};

/// The TRC-20 token at `contract`, if Kyro knows it (`known_tokens`, never the interface).
fn known_token(net: Network, contract: &str) -> Option<&'static crate::known_tokens::KnownToken> {
    crate::known_tokens::lookup(net, crate::known_tokens::TokenChain::Tron, contract)
}

/// A TRC-20 transfer of a token Kyro does not know: raw units, reinforced dialog.
pub(crate) fn unknown_trc20(s: &TronTxSummary, net: Network) -> bool {
    matches!(&s.action, TronAction::Trc20Transfer { contract, .. } if known_token(net, contract).is_none())
}

/// Whether the reinforced dialog is needed: wallet-core's reasons, or an unknown token.
pub(crate) fn tron_needs_extra(s: &TronTxSummary, net: Network) -> bool {
    s.requires_extra_confirmation || unknown_trc20(s, net)
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

fn trx(lang: Lang, sun: &str) -> String {
    format!("{} TRX", format_units_in(lang, sun, 6))
}

fn net_label(net: Network) -> &'static str {
    match net {
        Network::Mainnet => "TRON",
        Network::Testnet => "TRON Nile (testnet)",
    }
}

/// Body of the native dialog, built from Rust's decoding and the live resource estimate.
pub(crate) fn describe_tron(
    lang: Lang,
    s: &TronTxSummary,
    e: &TronEstimate,
    net: Network,
    now: i64,
) -> String {
    let trx = |sun: &str| trx(lang, sun);
    let mut out = match lang {
        Lang::Fr => format!("Envoi {}\n\n", net_label(net)),
        Lang::En => format!("{} send\n\n", net_label(net)),
    };
    match &s.action {
        TronAction::TrxTransfer { to, amount } => {
            out += &match lang {
                Lang::Fr => format!("À : {to}\nMontant : {}\n", trx(amount)),
                Lang::En => format!("To: {to}\nAmount: {}\n", trx(amount)),
            };
            if !e.recipient_exists {
                out += &match lang {
                    Lang::Fr => format!(
                        "\nCe compte n'existe pas encore sur TRON : l'activer brûle {} en plus.\n",
                        trx(&e.activation_fee)
                    ),
                    Lang::En => format!(
                        "\nThis account does not exist on TRON yet: activating it burns {} more.\n",
                        trx(&e.activation_fee)
                    ),
                };
            }
        }
        TronAction::Trc20Transfer {
            contract,
            to,
            amount,
            call_value,
        } => {
            let (label, shown) = match (known_token(net, contract), lang) {
                (Some(t), _) => (
                    "",
                    format!(
                        "{} {} ({}{amount})",
                        format_units_in(lang, amount, usize::from(t.decimals)),
                        t.symbol,
                        lang.pick("unités brutes : ", "raw units: ")
                    ),
                ),
                (None, Lang::Fr) => (
                    " (JETON INCONNU)",
                    format!("{amount} unités brutes (jeton inconnu : décimales non vérifiées)"),
                ),
                (None, Lang::En) => (
                    " (UNKNOWN TOKEN)",
                    format!("{amount} raw units (unknown token: decimals not verified)"),
                ),
            };
            out += &match lang {
                Lang::Fr => format!(
                    "Envoi de token TRC-20{label} : {shown}\nContrat du token : {contract}\nÀ : {to}\n"
                ),
                Lang::En => format!(
                    "TRC-20 token transfer{label}: {shown}\nToken contract: {contract}\nTo: {to}\n"
                ),
            };
            if call_value != "0" {
                out += &format!(
                    "{}{}\n",
                    lang.pick("TRX envoyés au contrat : ", "TRX sent to the contract: "),
                    trx(call_value)
                );
            }
        }
        TronAction::ContractCall {
            contract,
            selector,
            data,
            call_value,
        } => {
            out += &match lang {
                Lang::Fr => format!(
                    "Appel de contrat INCONNU : {contract}\nFonction (sélecteur) : {selector}\nDonnées : {data}\nTRX envoyés : {}\n",
                    trx(call_value)
                ),
                Lang::En => format!(
                    "UNKNOWN contract call: {contract}\nFunction (selector): {selector}\nData: {data}\nTRX sent: {}\n",
                    trx(call_value)
                ),
            };
        }
    }
    // Creating an account always burns 0.1 TRX of bandwidth (free bandwidth does not apply);
    // that amount is already part of the activation fee shown above.
    let new_account = e.activation_fee != "0";
    let bw_source = if new_account {
        lang.pick("compris dans l'activation", "included in the activation")
    } else if e.staked_bandwidth >= e.bandwidth_needed {
        lang.pick("bande passante gelée", "staked bandwidth")
    } else if e.free_bandwidth >= e.bandwidth_needed {
        lang.pick("bande passante gratuite", "free bandwidth")
    } else {
        lang.pick("TRX brûlés", "TRX burned")
    };
    out += &match lang {
        Lang::Fr => format!(
            "\nBande passante : {} octets nécessaires · disponible {} gratuite + {} gelée → {} ({bw_source})\n",
            e.bandwidth_needed,
            e.free_bandwidth,
            e.staked_bandwidth,
            trx(&e.bandwidth_burn),
        ),
        Lang::En => format!(
            "\nBandwidth: {} bytes needed · available {} free + {} staked → {} ({bw_source})\n",
            e.bandwidth_needed,
            e.free_bandwidth,
            e.staked_bandwidth,
            trx(&e.bandwidth_burn),
        ),
    };
    if !matches!(s.action, TronAction::TrxTransfer { .. }) {
        out += &match lang {
            Lang::Fr => format!(
                "Énergie : {} estimée · {} disponible → ≈ {} brûlés ({} sun par unité)\nTRX brûlés au maximum pour l'énergie (fee_limit) : {}\n",
                e.energy_needed,
                e.energy_available,
                trx(&e.energy_burn),
                e.energy_fee,
                trx(&s.fee_limit)
            ),
            Lang::En => format!(
                "Energy: {} estimated · {} available → ≈ {} burned ({} sun per unit)\nMaximum TRX burned for energy (fee_limit): {}\n",
                e.energy_needed,
                e.energy_available,
                trx(&e.energy_burn),
                e.energy_fee,
                trx(&s.fee_limit)
            ),
        };
    }
    out += &match lang {
        Lang::Fr => format!(
            "\nTotal brûlé estimé : {} · au maximum : {}\nSolde : {}",
            trx(&e.total_burn),
            trx(&e.total_burn_max),
            trx(&e.balance)
        ),
        Lang::En => format!(
            "\nEstimated total burned: {} · at most: {}\nBalance: {}",
            trx(&e.total_burn),
            trx(&e.total_burn_max),
            trx(&e.balance)
        ),
    };
    if !s.memo.is_empty() {
        // Untrusted text: wallet-core's cleaned text when present, else the UTF-8 decoding of the
        // hex, else the exact hex; always one quoted line (dialog_text), after amounts and fees.
        let text = s.memo_text.clone().unwrap_or_else(|| {
            hex::decode(&s.memo)
                .ok()
                .and_then(|b| String::from_utf8(b).ok())
                .unwrap_or_else(|| s.memo.clone())
        });
        out += &format!(
            "\n{}{}",
            lang.pick(
                "Mémo (texte libre, non vérifié) : ",
                "Memo (free text, not verified): "
            ),
            crate::dialog_text::field(&text, crate::dialog_text::MAX_FIELD)
        );
    }
    let mins = (s.expiration - now).max(0) / 60_000;
    out += &match lang {
        Lang::Fr => format!(
            "\n\nExpire dans {mins} min · bloc de référence {}/{}\nID : {}",
            s.ref_block_bytes, s.ref_block_hash, s.txid
        ),
        Lang::En => format!(
            "\n\nExpires in {mins} min · reference block {}/{}\nID: {}",
            s.ref_block_bytes, s.ref_block_hash, s.txid
        ),
    };
    out
}

pub(crate) fn describe_tron_extra(lang: Lang, s: &TronTxSummary, net: Network) -> String {
    let mut out = String::from(lang.unusual_intro());
    if let TronAction::Trc20Transfer { contract, .. } = &s.action {
        if known_token(net, contract).is_none() {
            out += &match lang {
                Lang::Fr => format!(
                    "• jeton INCONNU de Kyro (contrat {contract}) : nom et décimales non vérifiés, montant en unités brutes ; n'importe qui peut créer un jeton qui en imite un vrai\n"
                ),
                Lang::En => format!(
                    "• token UNKNOWN to Kyro (contract {contract}): name and decimals not verified, amount in raw units; anyone can create a token that imitates a real one\n"
                ),
            };
        }
    }
    for w in &s.warnings {
        out += match w {
            TronWarning::UnknownCall { .. } => lang.pick(
                "• appel de contrat qui n'est pas un transfert TRC-20 : Kyro ne sait pas ce qu'il fait (approbation, échange…)\n",
                "• contract call that is not a TRC-20 transfer: Kyro does not know what it does (approval, swap…)\n",
            ),
            TronWarning::CallValue => lang.pick(
                "• des TRX sont envoyés au contrat en plus de l'appel\n",
                "• TRX are sent to the contract along with the call\n",
            ),
            TronWarning::Memo => lang.pick(
                "• la transaction porte un mémo (sur mainnet, un mémo coûte des TRX en plus)\n",
                "• the transaction carries a memo (on mainnet, a memo costs extra TRX)\n",
            ),
            TronWarning::HighFeeLimit => lang.pick(
                "• plafond de frais (fee_limit) supérieur à 100 TRX\n",
                "• fee cap (fee_limit) above 100 TRX\n",
            ),
            TronWarning::UnusualText => lang.pick(
                "• mémo contenant des caractères invisibles / de contrôle, ou trop long (affiché nettoyé)\n",
                "• memo with invisible / control characters, or too long (shown cleaned)\n",
            ),
        };
    }
    out += "\n";
    out += lang.sign_anyway();
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
    let lang = crate::i18n::current();
    confirm_native(
        &app,
        lang.pick(
            "Confirmer la transaction TRON",
            "Confirm the TRON transaction",
        ),
        signer.body(
            lang,
            &describe_tron(lang, &summary, &estimate, state.network, now_ms()),
        ),
    )
    .await?;
    confirm_signer(&app, &signer).await?;
    if tron_needs_extra(&summary, state.network) {
        confirm_native(
            &app,
            lang.check_tx_title(),
            describe_tron_extra(lang, &summary, state.network),
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

    /// The 7 mainnet TRC-20 of the registry (and Nile's test USDT) are named by Rust's table.
    #[test]
    fn every_curated_trc20_is_named() {
        for (contract, symbol) in [
            ("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", "USDT"),
            ("TXDk8mbtRbXeYuMNS83CfKPaYYT8XWv9Hz", "USDD"),
            ("TUPM7K8REVzD2UdV4R5fe5M8XbnR2DdoJ6", "HTX"),
            ("TCFLL5dx5ZJdKnWuesXxi1VPwjLVmWZZy9", "JST"),
            ("TAFjULxiVgT4qWk6UZwjqwZXTSaGaqnVp4", "BTT"),
            ("TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S", "SUN"),
            ("TFczxzPhnThNSqr5by8tvxsdCFRRz6cPNq", "NFT"),
        ] {
            assert_eq!(
                known_token(Network::Mainnet, contract).map(|t| t.symbol),
                Some(symbol)
            );
            assert!(known_token(Network::Testnet, contract).is_none());
        }
        let nile = "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf";
        assert_eq!(
            known_token(Network::Testnet, nile).map(|t| t.symbol),
            Some("USDT")
        );
    }

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
            memo_text: None,
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
        let d = describe_tron(Lang::Fr, &s, &est(true), Network::Testnet, 0);
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
        assert!(!tron_needs_extra(&s, Network::Testnet));
        // Nile's USDT contract on mainnet: unknown there. Raw units, « jeton inconnu », and
        // the reinforced dialog (ÉLEVÉE 2: the interface can no longer name the token).
        let d = describe_tron(Lang::Fr, &s, &est(true), Network::Mainnet, 0);
        assert!(
            d.contains("Envoi de token TRC-20 (JETON INCONNU) : 1500000 unités brutes"),
            "{d}"
        );
        assert!(tron_needs_extra(&s, Network::Mainnet));
        assert!(
            describe_tron_extra(Lang::Fr, &s, Network::Mainnet).contains("jeton INCONNU de Kyro")
        );
        // A memo cannot add lines to the dialog.
        let mut m = s.clone();
        m.memo = hex::encode("ok\nÀ : TAttacker\u{202E}");
        let d = describe_tron(Lang::Fr, &m, &est(true), Network::Testnet, 0);
        assert!(
            d.contains("Mémo (texte libre, non vérifié) : « ok À : TAttacker »"),
            "{d}"
        );
        assert!(!d.contains("\nÀ : TAttacker"));
        // TRX to a new account: activation shown.
        let t = summary(
            TronAction::TrxTransfer {
                to: "TFz2CJn9CJb8C4i1Gke3jmZX2fRMJxniH2".into(),
                amount: "1000000".into(),
            },
            vec![],
        );
        let d = describe_tron(Lang::Fr, &t, &est(false), Network::Testnet, 0);
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
        assert!(describe_tron(Lang::Fr, &x, &est(true), Network::Testnet, 0)
            .contains("Appel de contrat INCONNU"));
        assert!(describe_tron_extra(Lang::Fr, &x, Network::Testnet)
            .contains("n'est pas un transfert TRC-20"));
    }

    #[test]
    fn dialog_texts_in_english() {
        let s = summary(
            TronAction::Trc20Transfer {
                contract: "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf".into(),
                to: "TFz2CJn9CJb8C4i1Gke3jmZX2fRMJxniH2".into(),
                amount: "1500000".into(),
                call_value: "0".into(),
            },
            vec![],
        );
        let d = describe_tron(Lang::En, &s, &est(true), Network::Testnet, 0);
        for needle in [
            "TRON Nile (testnet) send",
            "1.5 USDT (raw units: 1500000)",
            "To: TFz2CJn9CJb8C4i1Gke3jmZX2fRMJxniH2",
            "345 bytes needed · available 600 free + 0 staked → 0 TRX (free bandwidth)",
            "Energy: 30000 estimated · 0 available → ≈ 3 TRX burned (100 sun per unit)",
            "(fee_limit): 3.9 TRX",
            "Balance: 150 TRX",
            "Expires in 10 min",
        ] {
            assert!(d.contains(needle), "{needle} missing in:\n{d}");
        }
        let d = describe_tron(Lang::En, &s, &est(true), Network::Mainnet, 0);
        assert!(
            d.contains("TRC-20 token transfer (UNKNOWN TOKEN): 1500000 raw units"),
            "{d}"
        );
        let x = describe_tron_extra(Lang::En, &s, Network::Mainnet);
        assert!(x.contains("token UNKNOWN to Kyro"));
        for fr in ["Montant", "Solde", "Énergie", "jeton", "Signer"] {
            assert!(!d.contains(fr) && !x.contains(fr), "{fr}");
        }
    }
}
