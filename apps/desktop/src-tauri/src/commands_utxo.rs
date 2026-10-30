//! IPC commands for Litecoin (`ltc_*`) and Dogecoin (`doge_*`): addresses, Esplora-shaped data
//! from the chain's server (default or the user's), broadcast with txid check, and PSBT signing
//! behind the password + the native confirmation dialog with the summary decoded by Rust.
//! Contract: docs/IPC.md §2.4.

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, State};
use wallet_core::{Network, UtxoCoin, UtxoOutputKind, UtxoTxSummary, UtxoWarning};
use zeroize::Zeroizing;

use crate::commands::{blocking, confirm_native, format_units, seed_from_password};
use crate::error::{AppError, AppResult};
use crate::servers::{host_of, utxo_network_key, UtxoServer};
use crate::state::AppState;
use crate::utxo_backend::{self, UtxoCtx};

const LTC: UtxoCoin = UtxoCoin::Litecoin;
const DOGE: UtxoCoin = UtxoCoin::Dogecoin;

fn ctx<'a>(state: &'a AppState, coin: UtxoCoin) -> UtxoCtx<'a> {
    let s = state.settings();
    UtxoCtx {
        net_client: &state.net,
        network: state.network,
        coin,
        tor: s.tor.enabled,
        server: s.servers.utxo_for(coin, state.network),
    }
}

// ---------------------------------------------------------------- shared implementations

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UtxoBackendInfo {
    /// `default` | `esplora`
    pub kind: &'static str,
    /// `mainnet` | `testnet` (Litecoin testnet4 / Dogecoin testnet)
    pub network: &'static str,
    /// Host of the server, `""` when there is none (Dogecoin without a configured server).
    pub label: String,
    /// `false` = no server at all: every read fails with `SERVER_INVALID` until one is set.
    pub available: bool,
    pub tor: bool,
}

fn backend_info(state: &AppState, coin: UtxoCoin) -> UtxoBackendInfo {
    let c = ctx(state, coin);
    let base = utxo_backend::base(&c).ok();
    UtxoBackendInfo {
        kind: c.server.kind_name(),
        network: utxo_network_key(state.network),
        label: base.as_deref().and_then(host_of).unwrap_or_default(),
        available: base.is_some(),
        tor: c.tor,
    }
}

fn address(state: &AppState, coin: UtxoCoin, change: bool, index: u32) -> AppResult<String> {
    let net = state.network;
    state.with_seed(|seed| {
        Ok(wallet_core::utxo_address(
            seed, net, coin, 0, change, index,
        )?)
    })
}

fn coin_amount(coin: UtxoCoin, raw: &str) -> String {
    format!("{} {}", format_units(raw, 8), coin.symbol())
}

fn net_suffix(coin: UtxoCoin, net: Network) -> &'static str {
    match (coin, net) {
        (_, Network::Mainnet) => "",
        (UtxoCoin::Litecoin, Network::Testnet) => " (testnet4)",
        (UtxoCoin::Dogecoin, Network::Testnet) => " (testnet)",
    }
}

/// Body of the native dialog, built from Rust's decoding only.
pub(crate) fn describe_utxo(s: &UtxoTxSummary, net: Network) -> String {
    let coin = s.coin;
    let mut out = format!("Envoi {}{}\n\n", coin.name(), net_suffix(coin, net));
    for o in &s.outputs {
        let amount = coin_amount(coin, &o.amount);
        match (o.kind, &o.address) {
            (UtxoOutputKind::Address, Some(a)) if o.is_change => {
                out += &format!("Monnaie (revient chez toi) : {amount}\n  {a}\n");
            }
            (UtxoOutputKind::Address, Some(a)) => {
                out += &format!("À : {a}\nMontant : {amount}\n");
            }
            (UtxoOutputKind::OpReturn, _) => {
                out += &format!("Données (OP_RETURN) : {amount}\n  {}\n", o.script);
            }
            _ => {
                out += &format!(
                    "Sortie INCONNUE (script non reconnu) : {amount}\n  script : {}\n",
                    o.script
                );
            }
        }
    }
    let rate = match coin {
        UtxoCoin::Litecoin => format!(
            "{} litoshi/vB · taille estimée {} vB",
            format_units(&s.fee_per_kb.to_string(), 3),
            s.size
        ),
        UtxoCoin::Dogecoin => format!(
            "{} DOGE/kB · taille estimée {} octets",
            format_units(&s.fee_per_kb.to_string(), 8),
            s.size
        ),
    };
    let unit = match coin {
        UtxoCoin::Litecoin => "litoshis",
        UtxoCoin::Dogecoin => "koinus",
    };
    out += &format!(
        "\nFrais : {} ({} {unit})\nTaux : {rate}",
        coin_amount(coin, &s.fee),
        s.fee
    );
    if !s.has_change {
        out += "\n\nPas de monnaie : tout ce qui n'est pas envoyé part en frais (un reste trop petit pour une sortie de monnaie — poussière — y est ajouté).";
    }
    if s.our_inputs < s.inputs {
        out += &format!(
            "\n\nEntrées : {} dont {} d'un autre portefeuille.",
            s.inputs,
            s.inputs - s.our_inputs
        );
    }
    for w in &s.warnings {
        if let UtxoWarning::FeeBelowMinimum { minimum } = w {
            out += &format!(
                "\n\nFrais sous le minimum de relais ({}) : la transaction risque de ne pas être diffusée.",
                coin_amount(coin, minimum)
            );
        }
    }
    out
}

/// Body of the reinforced (second) dialog.
pub(crate) fn describe_utxo_extra(s: &UtxoTxSummary) -> String {
    let mut out = String::from("Kyro a trouvé des éléments inhabituels dans cette transaction :\n");
    for w in &s.warnings {
        let line = match w {
            UtxoWarning::UnknownOutput { index } => format!(
                "• sortie {index} : script inconnu — Kyro ne sait pas à qui elle paie"
            ),
            UtxoWarning::OpReturn { index } => {
                format!("• sortie {index} : données OP_RETURN (montant brûlé s'il n'est pas nul)")
            }
            UtxoWarning::ForeignInput { index } => format!(
                "• entrée {index} : n'appartient pas à ce portefeuille, son montant n'est pas vérifiable"
            ),
            UtxoWarning::SoftDust { index } => format!(
                "• sortie {index} : sous 0,01 DOGE, le réseau exige 0,01 DOGE de frais en plus par sortie de ce type"
            ),
            UtxoWarning::HighFee => "• frais très élevés (plus de 100 fois le taux habituel, ou plus que le montant envoyé)".into(),
            UtxoWarning::FeeBelowMinimum { .. } => continue,
        };
        out += &line;
        out.push('\n');
    }
    out += "\nNe signe que si tu sais exactement pourquoi. Signer quand même ?";
    out
}

#[derive(Serialize)]
pub struct UtxoSigned {
    psbt: String,
    summary: UtxoTxSummary,
}

async fn sign(
    app: &AppHandle,
    state: &AppState,
    coin: UtxoCoin,
    psbt: String,
    password: String,
) -> AppResult<UtxoSigned> {
    if !state.is_unlocked() {
        return Err(AppError::Locked);
    }
    let net = state.network;
    let seed = seed_from_password(state, Zeroizing::new(password)).await?;
    let (seed, psbt, summary) = blocking(move || {
        let s = wallet_core::utxo_psbt_summary(&seed, net, coin, &psbt)?;
        Ok((seed, psbt, s))
    })
    .await?;
    let title = match coin {
        UtxoCoin::Litecoin => "Confirmer la transaction Litecoin",
        UtxoCoin::Dogecoin => "Confirmer la transaction Dogecoin",
    };
    confirm_native(app, title, describe_utxo(&summary, net)).await?;
    if summary.requires_extra_confirmation {
        confirm_native(
            app,
            "Attention : transaction à vérifier",
            describe_utxo_extra(&summary),
        )
        .await?;
    }
    let (signed, again) =
        blocking(move || Ok(wallet_core::utxo_sign_psbt(&seed, net, coin, &psbt)?)).await?;
    if again != summary {
        return Err(AppError::Internal(
            "résumé différent entre l'aperçu et la signature".into(),
        ));
    }
    state.touch();
    Ok(UtxoSigned {
        psbt: signed,
        summary,
    })
}

// ---------------------------------------------------------------- Litecoin

#[tauri::command]
pub fn ltc_backend_info(state: State<'_, AppState>) -> UtxoBackendInfo {
    backend_info(&state, LTC)
}

#[tauri::command]
pub fn ltc_address(state: State<'_, AppState>, change: bool, index: u32) -> AppResult<String> {
    address(&state, LTC, change, index)
}

#[tauri::command]
pub async fn ltc_address_info(state: State<'_, AppState>, address: String) -> AppResult<Value> {
    utxo_backend::address_info(&ctx(&state, LTC), &address).await
}

#[tauri::command]
pub async fn ltc_address_utxos(state: State<'_, AppState>, address: String) -> AppResult<Value> {
    utxo_backend::address_utxos(&ctx(&state, LTC), &address).await
}

#[tauri::command]
pub async fn ltc_address_txs(state: State<'_, AppState>, address: String) -> AppResult<Value> {
    utxo_backend::address_txs(&ctx(&state, LTC), &address).await
}

#[tauri::command]
pub async fn ltc_tx_hex(state: State<'_, AppState>, txid: String) -> AppResult<String> {
    utxo_backend::tx_hex(&ctx(&state, LTC), &txid).await
}

#[tauri::command]
pub async fn ltc_fee_rates(state: State<'_, AppState>) -> AppResult<Value> {
    utxo_backend::fee_rates(&ctx(&state, LTC)).await
}

#[tauri::command]
pub async fn ltc_tip_height(state: State<'_, AppState>) -> AppResult<u64> {
    utxo_backend::tip_height(&ctx(&state, LTC)).await
}

#[tauri::command]
pub async fn ltc_broadcast(state: State<'_, AppState>, hex: String) -> AppResult<String> {
    utxo_backend::broadcast(&ctx(&state, LTC), &hex).await
}

#[tauri::command]
pub async fn ltc_sign_psbt(
    app: AppHandle,
    state: State<'_, AppState>,
    psbt: String,
    password: String,
) -> AppResult<UtxoSigned> {
    sign(&app, &state, LTC, psbt, password).await
}

// ---------------------------------------------------------------- Dogecoin

#[tauri::command]
pub fn doge_backend_info(state: State<'_, AppState>) -> UtxoBackendInfo {
    backend_info(&state, DOGE)
}

#[tauri::command]
pub fn doge_address(state: State<'_, AppState>, change: bool, index: u32) -> AppResult<String> {
    address(&state, DOGE, change, index)
}

#[tauri::command]
pub async fn doge_address_info(state: State<'_, AppState>, address: String) -> AppResult<Value> {
    utxo_backend::address_info(&ctx(&state, DOGE), &address).await
}

#[tauri::command]
pub async fn doge_address_utxos(state: State<'_, AppState>, address: String) -> AppResult<Value> {
    utxo_backend::address_utxos(&ctx(&state, DOGE), &address).await
}

#[tauri::command]
pub async fn doge_address_txs(state: State<'_, AppState>, address: String) -> AppResult<Value> {
    utxo_backend::address_txs(&ctx(&state, DOGE), &address).await
}

#[tauri::command]
pub async fn doge_tx_hex(state: State<'_, AppState>, txid: String) -> AppResult<String> {
    utxo_backend::tx_hex(&ctx(&state, DOGE), &txid).await
}

#[tauri::command]
pub async fn doge_fee_rates(state: State<'_, AppState>) -> AppResult<Value> {
    utxo_backend::fee_rates(&ctx(&state, DOGE)).await
}

#[tauri::command]
pub async fn doge_tip_height(state: State<'_, AppState>) -> AppResult<u64> {
    utxo_backend::tip_height(&ctx(&state, DOGE)).await
}

#[tauri::command]
pub async fn doge_broadcast(state: State<'_, AppState>, hex: String) -> AppResult<String> {
    utxo_backend::broadcast(&ctx(&state, DOGE), &hex).await
}

#[tauri::command]
pub async fn doge_sign_psbt(
    app: AppHandle,
    state: State<'_, AppState>,
    psbt: String,
    password: String,
) -> AppResult<UtxoSigned> {
    sign(&app, &state, DOGE, psbt, password).await
}

/// Probe used by `settings_set` / `server_test` (network checked by genesis hash).
pub(crate) async fn probe(
    net: &crate::net::NetClient,
    network: Network,
    coin: UtxoCoin,
    server: &UtxoServer,
    tor: bool,
) -> AppResult<crate::btc_backend::Detected> {
    let c = UtxoCtx {
        net_client: net,
        network,
        coin,
        tor,
        server: server.clone(),
    };
    utxo_backend::probe(&c).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use wallet_core::UtxoOutput;

    fn summary() -> UtxoTxSummary {
        UtxoTxSummary {
            coin: DOGE,
            outputs: vec![
                UtxoOutput {
                    address: Some("nDest".into()),
                    script: "76a9".into(),
                    amount: "1000000000".into(),
                    is_change: false,
                    kind: UtxoOutputKind::Address,
                },
                UtxoOutput {
                    address: None,
                    script: "51ae".into(),
                    amount: "500000".into(),
                    is_change: false,
                    kind: UtxoOutputKind::Unknown,
                },
            ],
            inputs: 2,
            our_inputs: 1,
            fee: "226000".into(),
            size: 226,
            fee_per_kb: 1_000_000,
            has_change: false,
            warnings: vec![
                UtxoWarning::UnknownOutput { index: 1 },
                UtxoWarning::ForeignInput { index: 1 },
                UtxoWarning::SoftDust { index: 1 },
                UtxoWarning::FeeBelowMinimum {
                    minimum: "300000".into(),
                },
            ],
            requires_extra_confirmation: true,
        }
    }

    #[test]
    fn dialog_shows_everything_rust_decoded() {
        let s = summary();
        let d = describe_utxo(&s, Network::Testnet);
        for needle in [
            "Envoi Dogecoin (testnet)",
            "À : nDest",
            "Montant : 10 DOGE",
            "Sortie INCONNUE",
            "script : 51ae",
            "Frais : 0,00226 DOGE (226000 koinus)",
            "Taux : 0,01 DOGE/kB · taille estimée 226 octets",
            "Pas de monnaie",
            "dont 1 d'un autre portefeuille",
            "minimum de relais (0,003 DOGE)",
        ] {
            assert!(d.contains(needle), "{needle} missing in:\n{d}");
        }
        let x = describe_utxo_extra(&s);
        assert!(x.contains("sortie 1 : script inconnu"));
        assert!(x.contains("entrée 1 : n'appartient pas"));
        assert!(x.contains("0,01 DOGE de frais en plus"));
        assert!(!x.contains("relais"));

        let mut ltc = summary();
        ltc.coin = LTC;
        ltc.fee = "141".into();
        ltc.size = 141;
        ltc.fee_per_kb = 1_000;
        ltc.outputs[0].is_change = true;
        ltc.outputs[0].address = Some("tltc1qme".into());
        ltc.has_change = true;
        let d = describe_utxo(&ltc, Network::Mainnet);
        assert!(d.starts_with("Envoi Litecoin\n"));
        assert!(d.contains("Monnaie (revient chez toi) : 10 LTC\n  tltc1qme"));
        assert!(d.contains("Taux : 1 litoshi/vB · taille estimée 141 vB"));
        assert!(!d.contains("Pas de monnaie"));
    }
}
