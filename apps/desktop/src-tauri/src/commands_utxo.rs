//! IPC commands for Litecoin (`ltc_*`), Dogecoin (`doge_*`), Bitcoin Cash (`bch_*`) and Dash
//! (`dash_*`): addresses, Esplora-shaped data from the chain's server (default or the user's),
//! broadcast with txid check, and PSBT signing behind the password + the native confirmation dialog
//! with the summary decoded by Rust.

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, State};
use wallet_core::{Network, UtxoCoin, UtxoOutputKind, UtxoTxSummary, UtxoWarning};
use zeroize::Zeroizing;

use crate::accounts::{account_arg, confirm_signer, Chain, SignerInfo};
use crate::commands::{blocking, confirm_native, format_units_in, seed_from_password};
use crate::error::{AppError, AppResult};
use crate::i18n::Lang;
use crate::servers::{utxo_network_key, UtxoServer};
use crate::state::AppState;
use crate::utxo_backend::{self, UtxoCtx};

const LTC: UtxoCoin = UtxoCoin::Litecoin;
const DOGE: UtxoCoin = UtxoCoin::Dogecoin;
const BCH: UtxoCoin = UtxoCoin::BitcoinCash;
const DASH: UtxoCoin = UtxoCoin::Dash;

pub(crate) fn ctx<'a>(state: &'a AppState, coin: UtxoCoin) -> UtxoCtx<'a> {
    let s = state.settings();
    UtxoCtx {
        net_client: &state.net,
        network: state.network,
        coin,
        tor: s.tor.enabled,
        server: s.servers.utxo_for(coin, state.network),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UtxoBackendInfo {
    /// `default` | `esplora` (the setting; the default of Dogecoin mainnet speaks Electrum)
    pub kind: &'static str,
    /// `mainnet` | `testnet` (Litecoin testnet4 / Dogecoin testnet / Bitcoin Cash chipnet /
    /// Dash testnet)
    pub network: &'static str,
    /// Host of the server, `""` when there is none (Dogecoin without a configured server).
    pub label: String,
    /// `false` = no server at all: every read fails with `SERVER_INVALID` until one is set.
    pub available: bool,
    pub tor: bool,
}

fn backend_info(state: &AppState, coin: UtxoCoin) -> UtxoBackendInfo {
    let c = ctx(state, coin);
    let backend = utxo_backend::backend(&c).ok();
    UtxoBackendInfo {
        kind: c.server.kind_name(),
        network: utxo_network_key(state.network),
        label: backend.as_ref().map(|b| b.label()).unwrap_or_default(),
        available: backend.is_some(),
        tor: c.tor,
    }
}

fn address(
    state: &AppState,
    coin: UtxoCoin,
    change: bool,
    index: u32,
    account: Option<u32>,
) -> AppResult<String> {
    let net = state.network;
    let a = account_arg(account)?;
    state.with_seed(|seed| {
        Ok(wallet_core::utxo_address(
            seed, net, coin, a, change, index,
        )?)
    })
}

fn chain_of(coin: UtxoCoin) -> Chain {
    match coin {
        UtxoCoin::Litecoin => Chain::Ltc,
        UtxoCoin::Dogecoin => Chain::Doge,
        UtxoCoin::BitcoinCash => Chain::Bch,
        UtxoCoin::Dash => Chain::Dash,
    }
}

fn coin_amount(lang: Lang, coin: UtxoCoin, raw: &str) -> String {
    format!("{} {}", format_units_in(lang, raw, 8), coin.symbol())
}

fn net_suffix(coin: UtxoCoin, net: Network) -> &'static str {
    match (coin, net) {
        (_, Network::Mainnet) => "",
        (UtxoCoin::Litecoin, Network::Testnet) => " (testnet4)",
        (UtxoCoin::BitcoinCash, Network::Testnet) => " (chipnet)",
        (UtxoCoin::Dogecoin | UtxoCoin::Dash, Network::Testnet) => " (testnet)",
    }
}

pub(crate) fn describe_utxo(lang: Lang, s: &UtxoTxSummary, net: Network) -> String {
    let coin = s.coin;
    let mut out = match lang {
        Lang::Fr => format!("Envoi {}{}\n\n", coin.name(), net_suffix(coin, net)),
        Lang::En => format!("{} send{}\n\n", coin.name(), net_suffix(coin, net)),
    };
    for o in &s.outputs {
        let amount = coin_amount(lang, coin, &o.amount);
        out += &match (o.kind, &o.address, lang) {
            (UtxoOutputKind::Address, Some(a), Lang::Fr) if o.is_change => {
                format!("Monnaie (revient chez toi) : {amount}\n  {a}\n")
            }
            (UtxoOutputKind::Address, Some(a), Lang::En) if o.is_change => {
                format!("Change (comes back to you): {amount}\n  {a}\n")
            }
            (UtxoOutputKind::Address, Some(a), Lang::Fr) => {
                format!("À : {a}\nMontant : {amount}\n")
            }
            (UtxoOutputKind::Address, Some(a), Lang::En) => format!("To: {a}\nAmount: {amount}\n"),
            (UtxoOutputKind::OpReturn, _, Lang::Fr) => {
                format!("Données (OP_RETURN) : {amount}\n  {}\n", o.script)
            }
            (UtxoOutputKind::OpReturn, _, Lang::En) => {
                format!("Data (OP_RETURN): {amount}\n  {}\n", o.script)
            }
            (_, _, Lang::Fr) => format!(
                "Sortie INCONNUE (script non reconnu) : {amount}\n  script : {}\n",
                o.script
            ),
            (_, _, Lang::En) => format!(
                "UNKNOWN output (script not recognised): {amount}\n  script: {}\n",
                o.script
            ),
        };
    }
    let rate = match (coin, lang) {
        (UtxoCoin::Litecoin, _) => format!(
            "{} litoshi/vB · {} {} vB",
            format_units_in(lang, &s.fee_per_kb.to_string(), 3),
            lang.pick("taille estimée", "estimated size"),
            s.size
        ),
        (UtxoCoin::Dogecoin, _) => format!(
            "{} DOGE/kB · {} {} {}",
            format_units_in(lang, &s.fee_per_kb.to_string(), 8),
            lang.pick("taille estimée", "estimated size"),
            s.size,
            lang.pick("octets", "bytes")
        ),
        (UtxoCoin::BitcoinCash | UtxoCoin::Dash, _) => format!(
            "{} {}/{} · {} {} {}",
            format_units_in(lang, &s.fee_per_kb.to_string(), 3),
            if coin == UtxoCoin::Dash {
                "duff"
            } else {
                "sat"
            },
            lang.pick("octet", "byte"),
            lang.pick("taille estimée", "estimated size"),
            s.size,
            lang.pick("octets", "bytes")
        ),
    };
    let unit = match coin {
        UtxoCoin::Litecoin => "litoshis",
        UtxoCoin::Dogecoin => "koinus",
        UtxoCoin::BitcoinCash => "satoshis",
        UtxoCoin::Dash => "duffs",
    };
    let fee = coin_amount(lang, coin, &s.fee);
    out += &match lang {
        Lang::Fr => format!("\nFrais : {fee} ({} {unit})\nTaux : {rate}", s.fee),
        Lang::En => format!("\nFee: {fee} ({} {unit})\nRate: {rate}", s.fee),
    };
    if !s.has_change {
        out += lang.pick(
            "\n\nPas de monnaie : tout ce qui n'est pas envoyé part en frais (un reste trop petit pour une sortie de monnaie — poussière — y est ajouté).",
            "\n\nNo change: everything that is not sent goes to fees (a remainder too small for a change output — dust — is added to them).",
        );
    }
    if s.our_inputs < s.inputs {
        let foreign = s.inputs - s.our_inputs;
        out += &match lang {
            Lang::Fr => format!(
                "\n\nEntrées : {} dont {foreign} d'un autre portefeuille.",
                s.inputs
            ),
            Lang::En => format!(
                "\n\nInputs: {}, of which {foreign} from another wallet.",
                s.inputs
            ),
        };
    }
    for w in &s.warnings {
        if let UtxoWarning::FeeBelowMinimum { minimum } = w {
            let min = coin_amount(lang, coin, minimum);
            out += &match lang {
                Lang::Fr => format!(
                    "\n\nFrais sous le minimum de relais ({min}) : la transaction risque de ne pas être diffusée."
                ),
                Lang::En => format!(
                    "\n\nFee below the relay minimum ({min}): the transaction may not be broadcast."
                ),
            };
        }
    }
    out
}

pub(crate) fn describe_utxo_extra(lang: Lang, s: &UtxoTxSummary) -> String {
    let mut out = String::from(lang.unusual_intro());
    for w in &s.warnings {
        let line = match (w, lang) {
            (UtxoWarning::UnknownOutput { index }, Lang::Fr) => format!(
                "• sortie {index} : script inconnu — Kyro ne sait pas à qui elle paie"
            ),
            (UtxoWarning::UnknownOutput { index }, Lang::En) => format!(
                "• output {index}: unknown script — Kyro does not know whom it pays"
            ),
            (UtxoWarning::OpReturn { index }, Lang::Fr) => {
                format!("• sortie {index} : données OP_RETURN (montant brûlé s'il n'est pas nul)")
            }
            (UtxoWarning::OpReturn { index }, Lang::En) => {
                format!("• output {index}: OP_RETURN data (amount burned if it is not zero)")
            }
            (UtxoWarning::ForeignInput { index }, Lang::Fr) => format!(
                "• entrée {index} : n'appartient pas à ce portefeuille, son montant n'est pas vérifiable"
            ),
            (UtxoWarning::ForeignInput { index }, Lang::En) => format!(
                "• input {index}: does not belong to this wallet, its amount cannot be verified"
            ),
            (UtxoWarning::SoftDust { index }, Lang::Fr) => format!(
                "• sortie {index} : sous 0,01 DOGE, le réseau exige 0,01 DOGE de frais en plus par sortie de ce type"
            ),
            (UtxoWarning::SoftDust { index }, Lang::En) => format!(
                "• output {index}: below 0.01 DOGE, the network requires 0.01 DOGE of extra fee per output of this kind"
            ),
            (UtxoWarning::HighFee, _) => lang
                .pick(
                    "• frais très élevés (plus de 100 fois le taux habituel, ou plus que le montant envoyé)",
                    "• very high fee (more than 100 times the usual rate, or more than the amount sent)",
                )
                .into(),
            (UtxoWarning::ChangeIndexOutOfRange { index }, Lang::Fr) => format!(
                "• sortie {index} : une de tes clés, mais à un index d'adresse anormalement élevé (affichée comme un paiement, pas comme ta monnaie)"
            ),
            (UtxoWarning::ChangeIndexOutOfRange { index }, Lang::En) => format!(
                "• output {index}: one of your keys, but at an abnormally high address index (shown as a payment, not as your change)"
            ),
            (UtxoWarning::FeeBelowMinimum { .. }, _) => continue,
        };
        out += &line;
        out.push('\n');
    }
    out += "\n";
    out += lang.sign_anyway();
    out
}

#[derive(Serialize)]
pub struct UtxoSigned {
    psbt: String,
    summary: UtxoTxSummary,
}

/// Checks a Litecoin replacement against its original; empty when this is an ordinary send. Only
/// Litecoin has replaceable transactions among these coins.
pub(crate) fn replacement_head(
    lang: Lang,
    coin: UtxoCoin,
    psbt: &str,
    replaces: Option<&wallet_core::UtxoReplaceRequest>,
    summary: &UtxoTxSummary,
) -> AppResult<String> {
    let Some(r) = replaces else {
        return Ok(String::new());
    };
    if coin != UtxoCoin::Litecoin {
        return Err(AppError::InvalidInput(
            "this coin has no replaceable transactions".into(),
        ));
    }
    let change: Vec<bool> = summary.outputs.iter().map(|o| o.is_change).collect();
    let checked = wallet_core::utxo_check_replacement(psbt, r, &change)?;
    Ok(crate::commands::describe_utxo_replacement(
        lang,
        coin.symbol(),
        &checked,
    ))
}

async fn sign(
    app: &AppHandle,
    state: &AppState,
    coin: UtxoCoin,
    psbt: String,
    password: String,
    account: Option<u32>,
    replaces: Option<wallet_core::UtxoReplaceRequest>,
) -> AppResult<UtxoSigned> {
    if !state.is_unlocked() {
        return Err(AppError::Locked);
    }
    let net = state.network;
    let a = account_arg(account)?;
    let path = state.with_seed(|seed| Ok(wallet_core::utxo_account(seed, net, coin, a)?.path))?;
    let signer = SignerInfo::new(state, chain_of(coin), a, path);
    let seed = seed_from_password(state, Zeroizing::new(password)).await?;
    let (seed, psbt, summary) = blocking(move || {
        let s = wallet_core::utxo_psbt_summary(&seed, net, coin, a, &psbt)?;
        Ok((seed, psbt, s))
    })
    .await?;
    let lang = crate::i18n::current();
    let title = match (coin, lang) {
        (UtxoCoin::Litecoin, Lang::Fr) => "Confirmer la transaction Litecoin",
        (UtxoCoin::Litecoin, Lang::En) => "Confirm the Litecoin transaction",
        (UtxoCoin::Dogecoin, Lang::Fr) => "Confirmer la transaction Dogecoin",
        (UtxoCoin::Dogecoin, Lang::En) => "Confirm the Dogecoin transaction",
        (UtxoCoin::BitcoinCash, Lang::Fr) => "Confirmer la transaction Bitcoin Cash",
        (UtxoCoin::BitcoinCash, Lang::En) => "Confirm the Bitcoin Cash transaction",
        (UtxoCoin::Dash, Lang::Fr) => "Confirmer la transaction Dash",
        (UtxoCoin::Dash, Lang::En) => "Confirm the Dash transaction",
    };
    let head = replacement_head(lang, coin, &psbt, replaces.as_ref(), &summary)?;
    confirm_native(
        app,
        title,
        signer.body(lang, &(head + &describe_utxo(lang, &summary, net))),
    )
    .await?;
    confirm_signer(app, &signer).await?;
    if summary.requires_extra_confirmation {
        confirm_native(
            app,
            lang.check_tx_title(),
            describe_utxo_extra(lang, &summary),
        )
        .await?;
    }
    let (signed, again) =
        blocking(move || Ok(wallet_core::utxo_sign_psbt(&seed, net, coin, a, &psbt)?)).await?;
    if again != summary {
        return Err(AppError::Internal(
            "summary differs between the preview and the signature".into(),
        ));
    }
    state.touch();
    Ok(UtxoSigned {
        psbt: signed,
        summary,
    })
}

#[tauri::command]
pub fn ltc_backend_info(state: State<'_, AppState>) -> UtxoBackendInfo {
    backend_info(&state, LTC)
}

#[tauri::command]
pub fn ltc_address(
    state: State<'_, AppState>,
    change: bool,
    index: u32,
    account: Option<u32>,
) -> AppResult<String> {
    address(&state, LTC, change, index, account)
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
    account: Option<u32>,
    replaces: Option<wallet_core::UtxoReplaceRequest>,
) -> AppResult<UtxoSigned> {
    sign(&app, &state, LTC, psbt, password, account, replaces).await
}

#[tauri::command]
pub fn doge_backend_info(state: State<'_, AppState>) -> UtxoBackendInfo {
    backend_info(&state, DOGE)
}

#[tauri::command]
pub fn doge_address(
    state: State<'_, AppState>,
    change: bool,
    index: u32,
    account: Option<u32>,
) -> AppResult<String> {
    address(&state, DOGE, change, index, account)
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
    account: Option<u32>,
) -> AppResult<UtxoSigned> {
    sign(&app, &state, DOGE, psbt, password, account, None).await
}

#[tauri::command]
pub fn bch_backend_info(state: State<'_, AppState>) -> UtxoBackendInfo {
    backend_info(&state, BCH)
}

#[tauri::command]
pub fn bch_address(
    state: State<'_, AppState>,
    change: bool,
    index: u32,
    account: Option<u32>,
) -> AppResult<String> {
    address(&state, BCH, change, index, account)
}

#[tauri::command]
pub async fn bch_address_info(state: State<'_, AppState>, address: String) -> AppResult<Value> {
    utxo_backend::address_info(&ctx(&state, BCH), &address).await
}

#[tauri::command]
pub async fn bch_address_utxos(state: State<'_, AppState>, address: String) -> AppResult<Value> {
    utxo_backend::address_utxos(&ctx(&state, BCH), &address).await
}

#[tauri::command]
pub async fn bch_address_txs(state: State<'_, AppState>, address: String) -> AppResult<Value> {
    utxo_backend::address_txs(&ctx(&state, BCH), &address).await
}

#[tauri::command]
pub async fn bch_tx_hex(state: State<'_, AppState>, txid: String) -> AppResult<String> {
    utxo_backend::tx_hex(&ctx(&state, BCH), &txid).await
}

#[tauri::command]
pub async fn bch_fee_rates(state: State<'_, AppState>) -> AppResult<Value> {
    utxo_backend::fee_rates(&ctx(&state, BCH)).await
}

#[tauri::command]
pub async fn bch_tip_height(state: State<'_, AppState>) -> AppResult<u64> {
    utxo_backend::tip_height(&ctx(&state, BCH)).await
}

#[tauri::command]
pub async fn bch_broadcast(state: State<'_, AppState>, hex: String) -> AppResult<String> {
    utxo_backend::broadcast(&ctx(&state, BCH), &hex).await
}

/// Bitcoin Cash: the returned PSBT is **already finalized** by wallet-core (a FORKID signature
/// cannot be a PSBT partial signature); the adapter only extracts the transaction.
#[tauri::command]
pub async fn bch_sign_psbt(
    app: AppHandle,
    state: State<'_, AppState>,
    psbt: String,
    password: String,
    account: Option<u32>,
) -> AppResult<UtxoSigned> {
    sign(&app, &state, BCH, psbt, password, account, None).await
}

#[tauri::command]
pub fn dash_backend_info(state: State<'_, AppState>) -> UtxoBackendInfo {
    backend_info(&state, DASH)
}

#[tauri::command]
pub fn dash_address(
    state: State<'_, AppState>,
    change: bool,
    index: u32,
    account: Option<u32>,
) -> AppResult<String> {
    address(&state, DASH, change, index, account)
}

#[tauri::command]
pub async fn dash_address_info(state: State<'_, AppState>, address: String) -> AppResult<Value> {
    utxo_backend::address_info(&ctx(&state, DASH), &address).await
}

#[tauri::command]
pub async fn dash_address_utxos(state: State<'_, AppState>, address: String) -> AppResult<Value> {
    utxo_backend::address_utxos(&ctx(&state, DASH), &address).await
}

#[tauri::command]
pub async fn dash_address_txs(state: State<'_, AppState>, address: String) -> AppResult<Value> {
    utxo_backend::address_txs(&ctx(&state, DASH), &address).await
}

#[tauri::command]
pub async fn dash_tx_hex(state: State<'_, AppState>, txid: String) -> AppResult<String> {
    utxo_backend::tx_hex(&ctx(&state, DASH), &txid).await
}

#[tauri::command]
pub async fn dash_fee_rates(state: State<'_, AppState>) -> AppResult<Value> {
    utxo_backend::fee_rates(&ctx(&state, DASH)).await
}

#[tauri::command]
pub async fn dash_tip_height(state: State<'_, AppState>) -> AppResult<u64> {
    utxo_backend::tip_height(&ctx(&state, DASH)).await
}

#[tauri::command]
pub async fn dash_broadcast(state: State<'_, AppState>, hex: String) -> AppResult<String> {
    utxo_backend::broadcast(&ctx(&state, DASH), &hex).await
}

#[tauri::command]
pub async fn dash_sign_psbt(
    app: AppHandle,
    state: State<'_, AppState>,
    psbt: String,
    password: String,
    account: Option<u32>,
) -> AppResult<UtxoSigned> {
    sign(&app, &state, DASH, psbt, password, account, None).await
}

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
        let d = describe_utxo(Lang::Fr, &s, Network::Testnet);
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
        let x = describe_utxo_extra(Lang::Fr, &s);
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
        let d = describe_utxo(Lang::Fr, &ltc, Network::Mainnet);
        assert!(d.starts_with("Envoi Litecoin\n"));
        assert!(d.contains("Monnaie (revient chez toi) : 10 LTC\n  tltc1qme"));
        assert!(d.contains("Taux : 1 litoshi/vB · taille estimée 141 vB"));
        assert!(!d.contains("Pas de monnaie"));
    }

    #[test]
    fn dialog_in_english() {
        let s = summary();
        let d = describe_utxo(Lang::En, &s, Network::Testnet);
        for needle in [
            "Dogecoin send (testnet)",
            "To: nDest",
            "Amount: 10 DOGE",
            "UNKNOWN output",
            "Fee: 0.00226 DOGE (226000 koinus)",
            "Rate: 0.01 DOGE/kB · estimated size 226 bytes",
            "No change",
            "of which 1 from another wallet",
            "relay minimum (0.003 DOGE)",
        ] {
            assert!(d.contains(needle), "{needle} missing in:\n{d}");
        }
        let x = describe_utxo_extra(Lang::En, &s);
        assert!(x.contains("output 1: unknown script"));
        assert!(x.contains("input 1: does not belong"));
        assert!(x.ends_with("Only sign if you know exactly why. Sign anyway?"));
        for fr in ["Montant", "Frais", "Taux", "sortie", "Signer"] {
            assert!(!d.contains(fr) && !x.contains(fr), "{fr}");
        }
    }

    #[test]
    fn bitcoin_cash_and_dash_dialogs() {
        let mut bch = summary();
        bch.coin = BCH;
        bch.outputs[0].address = Some("bchtest:qr08q88p9etk89wgv05nwlrkm4l0urz4cyl36hh9sv".into());
        bch.fee = "226".into();
        bch.fee_per_kb = 1_000;
        bch.warnings = vec![UtxoWarning::HighFee];
        let d = describe_utxo(Lang::Fr, &bch, Network::Testnet);
        for needle in [
            "Envoi Bitcoin Cash (chipnet)",
            "À : bchtest:qr08q88p9etk89wgv05nwlrkm4l0urz4cyl36hh9sv",
            "Montant : 10 BCH",
            "Frais : 0,00000226 BCH (226 satoshis)",
            "Taux : 1 sat/octet · taille estimée 226 octets",
            "Sortie INCONNUE",
        ] {
            assert!(d.contains(needle), "{needle} missing in:\n{d}");
        }
        assert!(describe_utxo_extra(Lang::Fr, &bch).contains("frais très élevés"));

        let mut dash = summary();
        dash.coin = DASH;
        dash.fee = "1000".into();
        dash.fee_per_kb = 5_208;
        let d = describe_utxo(Lang::Fr, &dash, Network::Mainnet);
        assert!(d.starts_with("Envoi Dash\n"), "{d}");
        assert!(d.contains("Frais : 0,00001 DASH (1000 duffs)"), "{d}");
        assert!(d.contains("Taux : 5,208 duff/octet"), "{d}");
        assert_eq!(chain_of(BCH), Chain::Bch);
        assert_eq!(chain_of(DASH), Chain::Dash);
    }
}
