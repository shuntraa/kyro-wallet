//! IPC commands for Kaspa (`kas_*`): address, balance and history of the account (receive and
//! change chains, [`KASPA_SCAN_WINDOW`] addresses each), payments **built by Kyro** from the
//! live coins (wallet-core: coin selection, KIP-9 mass, fee), signed behind the password and the
//! native dialog after a live re-read of every spent coin, and broadcast with an id check.
//! Contract: docs/IPC.md §2.11.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use wallet_core::{
    KaspaAmount, KaspaOwnKey, KaspaSpendable, KaspaTx, KaspaTxSummary, KaspaUtxoEntry,
    KaspaWarning, Network, KASPA_SCAN_WINDOW,
};
use zeroize::Zeroizing;

use crate::accounts::{account_arg, confirm_signer, Chain, SignerInfo};
use crate::commands::{blocking, confirm_native, format_units_in, seed_from_password};
use crate::error::{AppError, AppResult};
use crate::i18n::Lang;
use crate::kaspa_backend::{self, KaspaCtx, KaspaHistoryEntry};
use crate::servers::{host_of, utxo_network_key};
use crate::state::AppState;

pub(crate) fn ctx(state: &AppState) -> KaspaCtx<'_> {
    KaspaCtx {
        net_client: &state.net,
        network: state.network,
        tor: state.settings().tor.enabled,
    }
}

/// Our receive and change keys of `account` (vault unlocked).
fn keys(state: &AppState, account: u32) -> AppResult<Vec<KaspaOwnKey>> {
    let net = state.network;
    state.with_seed(|seed| {
        Ok(wallet_core::kaspa_own_keys(
            seed,
            net,
            account,
            KASPA_SCAN_WINDOW,
        )?)
    })
}

fn kas(lang: Lang, sompi: &str) -> String {
    format!("{} KAS", format_units_in(lang, sompi, 8))
}

fn net_suffix(net: Network) -> &'static str {
    match net {
        Network::Mainnet => "",
        Network::Testnet => " (testnet-10)",
    }
}

/// Body of the native dialog, built from Rust's decoding only.
pub(crate) fn describe_kaspa(lang: Lang, s: &KaspaTxSummary, net: Network) -> String {
    let mut out = format!(
        "{}{}\n\n",
        lang.pick("Envoi Kaspa", "Kaspa send"),
        net_suffix(net)
    );
    for o in &s.outputs {
        let amount = kas(lang, &o.amount);
        match &o.address {
            Some(a) if o.is_change => {
                out += &match lang {
                    Lang::Fr => format!("Monnaie (revient chez toi) : {amount}\n  {a}\n"),
                    Lang::En => format!("Change (comes back to you): {amount}\n  {a}\n"),
                };
            }
            Some(a) => {
                out += &match lang {
                    Lang::Fr => format!("À : {a}\nMontant : {amount}\n"),
                    Lang::En => format!("To: {a}\nAmount: {amount}\n"),
                }
            }
            None => {
                out += &match lang {
                    Lang::Fr => format!(
                        "Sortie INCONNUE (script non reconnu) : {amount}\n  script : {}\n",
                        o.script
                    ),
                    Lang::En => format!(
                        "UNKNOWN output (unrecognized script): {amount}\n  script: {}\n",
                        o.script
                    ),
                }
            }
        }
    }
    out += &match lang {
        Lang::Fr => format!(
            "\nFrais : {} ({} sompi)\nMasse : {} g (calcul {} · stockage KIP-9 {} · transitoire {}) · frais minimum de relais : {}",
            kas(lang, &s.fee),
            s.fee,
            s.mass.total,
            s.mass.compute,
            s.mass.storage,
            s.mass.transient.div_ceil(2),
            kas(lang, &s.minimum_fee)
        ),
        Lang::En => format!(
            "\nFee: {} ({} sompi)\nMass: {} g (compute {} · KIP-9 storage {} · transient {}) · minimum relay fee: {}",
            kas(lang, &s.fee),
            s.fee,
            s.mass.total,
            s.mass.compute,
            s.mass.storage,
            s.mass.transient.div_ceil(2),
            kas(lang, &s.minimum_fee)
        ),
    };
    out += &match lang {
        Lang::Fr => format!(
            "\nEntrées : {} pièce(s) de ce compte, {} au total",
            s.inputs,
            kas(lang, &s.input_total)
        ),
        Lang::En => format!(
            "\nInputs: {} coin(s) of this account, {} in total",
            s.inputs,
            kas(lang, &s.input_total)
        ),
    };
    if !s.has_change {
        out += lang.pick(
            "\n\nPas de monnaie : tout ce qui n'est pas envoyé part en frais (un reste trop petit pour une sortie de monnaie — masse de stockage KIP-9 — y est ajouté).",
            "\n\nNo change: everything not sent goes to the fee (a remainder too small for a change output — KIP-9 storage mass — is added to it).",
        );
    }
    out += &format!("\n\n{}{}", lang.pick("Identifiant : ", "ID: "), s.tx_id);
    out
}

/// Body of the reinforced (second) dialog.
pub(crate) fn describe_kaspa_extra(lang: Lang, s: &KaspaTxSummary) -> String {
    let mut out = String::from(lang.unusual_intro());
    for w in &s.warnings {
        out += &match (w, lang) {
            (KaspaWarning::UnknownOutput { index }, Lang::Fr) => {
                format!("• sortie {index} : script inconnu — Kyro ne sait pas à qui elle paie\n")
            }
            (KaspaWarning::UnknownOutput { index }, Lang::En) => {
                format!("• output {index}: unknown script — Kyro does not know whom it pays\n")
            }
            (KaspaWarning::HighFee, Lang::Fr) => format!(
                "• frais élevés : {} (plus de 1 KAS, ou plus de 10 fois le minimum de relais {})\n",
                kas(lang, &s.fee),
                kas(lang, &s.minimum_fee)
            ),
            (KaspaWarning::HighFee, Lang::En) => format!(
                "• high fee: {} (more than 1 KAS, or more than 10 times the minimum relay fee {})\n",
                kas(lang, &s.fee),
                kas(lang, &s.minimum_fee)
            ),
        };
    }
    out += "\n";
    out += lang.sign_anyway();
    out
}

// ---------------------------------------------------------------- reads

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KaspaBackendInfo {
    /// Always `default` (no custom Kaspa server yet).
    pub kind: &'static str,
    pub network: &'static str,
    pub label: String,
    pub tor: bool,
}

#[tauri::command]
pub fn kas_backend_info(state: State<'_, AppState>) -> KaspaBackendInfo {
    KaspaBackendInfo {
        kind: "default",
        network: utxo_network_key(state.network),
        label: host_of(kaspa_backend::base_url(state.network)).unwrap_or_default(),
        tor: state.settings().tor.enabled,
    }
}

/// Receive address `m/44'/111111'/account'/0/0` (the one the UI shows).
#[tauri::command]
pub fn kas_address(state: State<'_, AppState>, account: Option<u32>) -> AppResult<String> {
    let a = account_arg(account)?;
    let net = state.network;
    state.with_seed(|seed| Ok(wallet_core::kaspa_address(seed, net, a, false, 0)?))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KaspaAccountInfo {
    /// Receive address shown (`…/0/0`).
    pub address: String,
    /// Sum of the balances of the scanned addresses, sompi.
    pub balance: String,
    /// Sum of the coins that can be spent now (immature coinbase excluded), sompi.
    pub spendable: String,
    pub utxo_count: usize,
    /// Addresses read: receive `…/0/0..n` and change `…/1/0..n`.
    pub scanned: u32,
}

#[tauri::command]
pub async fn kas_account(
    state: State<'_, AppState>,
    account: Option<u32>,
) -> AppResult<KaspaAccountInfo> {
    let ks = keys(&state, account_arg(account)?)?;
    let c = ctx(&state);
    let daa = kaspa_backend::network_info(&c).await?;
    let balance = kaspa_backend::balance(&c, &ks).await?;
    let coins = kaspa_backend::mature(kaspa_backend::utxos(&c, &ks).await?, daa);
    let spendable: u64 = coins.iter().map(|c| c.entry.amount).sum();
    Ok(KaspaAccountInfo {
        address: ks[0].address.clone(),
        balance: balance.to_string(),
        spendable: spendable.to_string(),
        utxo_count: coins.len(),
        scanned: KASPA_SCAN_WINDOW,
    })
}

#[tauri::command]
pub async fn kas_txs(
    state: State<'_, AppState>,
    account: Option<u32>,
) -> AppResult<Vec<KaspaHistoryEntry>> {
    let ks = keys(&state, account_arg(account)?)?;
    let c = ctx(&state);
    kaspa_backend::network_info(&c).await?;
    kaspa_backend::history(&c, &ks).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KaspaTxStatus {
    /// `false` until the indexer knows the transaction.
    pub found: bool,
    pub accepted: bool,
}

#[tauri::command]
pub async fn kas_tx_status(state: State<'_, AppState>, txid: String) -> AppResult<KaspaTxStatus> {
    let s = kaspa_backend::tx_status(&ctx(&state), txid.trim()).await?;
    Ok(KaspaTxStatus {
        found: s.is_some(),
        accepted: s.unwrap_or(false),
    })
}

// ---------------------------------------------------------------- build, sign, broadcast

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KaspaContext {
    /// Server estimate, sompi/gram.
    pub feerate_estimate: u64,
    /// Rate applied to the whole mass (0 = network not busy: minimum relay fee only).
    pub priority_feerate: u64,
    pub spendable: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KaspaBuilt {
    /// Unsigned transaction, JSON (the REST API's submit shape): what `kas_sign_tx` signs.
    pub tx: String,
    pub summary: KaspaTxSummary,
    pub context: KaspaContext,
}

/// Request of `kas_build_tx`: an amount in sompi, or `max`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KaspaSendSpec {
    pub to: String,
    pub amount: Option<String>,
    #[serde(default)]
    pub max: bool,
}

fn parse_amount(spec: &KaspaSendSpec) -> AppResult<KaspaAmount> {
    match (&spec.amount, spec.max) {
        (_, true) => Ok(KaspaAmount::Max),
        (Some(a), false) => a
            .trim()
            .parse::<u64>()
            .ok()
            .filter(|v| *v > 0)
            .map(KaspaAmount::Exact)
            .ok_or_else(|| AppError::InvalidInput("montant en sompi invalide".into())),
        (None, false) => Err(AppError::InvalidInput("montant manquant".into())),
    }
}

/// Live coins, network check, immature coinbase removed.
async fn live_coins(c: &KaspaCtx<'_>, ks: &[KaspaOwnKey]) -> AppResult<Vec<KaspaSpendable>> {
    let daa = kaspa_backend::network_info(c).await?;
    Ok(kaspa_backend::mature(
        kaspa_backend::utxos(c, ks).await?,
        daa,
    ))
}

pub(crate) async fn build(
    c: &KaspaCtx<'_>,
    ks: &[KaspaOwnKey],
    spec: &KaspaSendSpec,
) -> AppResult<KaspaBuilt> {
    let to = wallet_core::kaspa_script_pubkey(c.network, &spec.to)?;
    let amount = parse_amount(spec)?;
    let coins = live_coins(c, ks).await?;
    let estimate = kaspa_backend::fee_estimate(c).await?;
    let priority = wallet_core::kaspa_priority_feerate(estimate);
    // Change goes back to our first change address `…/1/0`.
    let change = ks
        .iter()
        .find(|k| k.change && k.index == 0)
        .ok_or_else(|| AppError::Internal("adresse de monnaie absente".into()))?
        .script();
    let built = wallet_core::kaspa_build_send(&coins, &to, amount, &change, priority)?;
    let summary = wallet_core::kaspa_tx_summary(c.network, &built.tx, &built.entries, ks)?;
    Ok(KaspaBuilt {
        tx: wallet_core::kaspa_tx_to_json(&built.tx)?,
        summary,
        context: KaspaContext {
            feerate_estimate: estimate,
            priority_feerate: priority,
            spendable: coins
                .iter()
                .map(|c| c.entry.amount)
                .sum::<u64>()
                .to_string(),
        },
    })
}

#[tauri::command]
pub async fn kas_build_tx(
    state: State<'_, AppState>,
    to: String,
    amount: Option<String>,
    max: Option<bool>,
    account: Option<u32>,
) -> AppResult<KaspaBuilt> {
    let ks = keys(&state, account_arg(account)?)?;
    build(
        &ctx(&state),
        &ks,
        &KaspaSendSpec {
            to,
            amount,
            max: max.unwrap_or(false),
        },
    )
    .await
}

/// The live entries of `tx`'s inputs: each must still be one of our unspent coins.
pub(crate) async fn live_entries(
    c: &KaspaCtx<'_>,
    ks: &[KaspaOwnKey],
    tx: &KaspaTx,
) -> AppResult<Vec<KaspaUtxoEntry>> {
    let coins = live_coins(c, ks).await?;
    tx.inputs
        .iter()
        .enumerate()
        .map(|(i, input)| {
            coins
                .iter()
                .find(|c| c.outpoint == input.outpoint)
                .map(|c| c.entry.clone())
                .ok_or_else(|| {
                    AppError::InvalidInput(format!(
                        "entrée {i} : pièce déjà dépensée ou inconnue de ce compte, reconstruis la transaction"
                    ))
                })
        })
        .collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KaspaSigned {
    /// Signed transaction, JSON: what `kas_broadcast` submits.
    pub tx: String,
    pub tx_id: String,
    pub summary: KaspaTxSummary,
}

/// Decoding against the live coins: everything `kas_sign_tx` does before the dialog.
pub(crate) async fn prepare_sign(
    c: &KaspaCtx<'_>,
    ks: &[KaspaOwnKey],
    tx_json: &str,
) -> AppResult<(KaspaTx, Vec<KaspaUtxoEntry>, KaspaTxSummary)> {
    let tx = wallet_core::kaspa_tx_from_json(tx_json)?;
    if tx.inputs.iter().any(|i| !i.signature_script.is_empty()) {
        return Err(AppError::InvalidInput(
            "transaction Kaspa déjà signée".into(),
        ));
    }
    let entries = live_entries(c, ks, &tx).await?;
    let summary = wallet_core::kaspa_tx_summary(c.network, &tx, &entries, ks)?;
    Ok((tx, entries, summary))
}

#[tauri::command]
pub async fn kas_sign_tx(
    app: AppHandle,
    state: State<'_, AppState>,
    tx: String,
    password: String,
    account: Option<u32>,
) -> AppResult<KaspaSigned> {
    if !state.is_unlocked() {
        return Err(AppError::Locked);
    }
    let a = account_arg(account)?;
    let net = state.network;
    let ks = keys(&state, a)?;
    let lang = crate::i18n::current();
    let signer = SignerInfo::new(
        &state,
        Chain::Kas,
        a,
        format!(
            "{} {}",
            wallet_core::kaspa_account_path(a)?,
            lang.pick(
                "(réception …/0/i, monnaie …/1/i)",
                "(receive …/0/i, change …/1/i)"
            )
        ),
    );
    let c = ctx(&state);
    let (unsigned, entries, summary) = prepare_sign(&c, &ks, &tx).await?;
    let seed = seed_from_password(&state, Zeroizing::new(password)).await?;
    confirm_native(
        &app,
        lang.pick(
            "Confirmer la transaction Kaspa",
            "Confirm the Kaspa transaction",
        ),
        signer.body(lang, &describe_kaspa(lang, &summary, net)),
    )
    .await?;
    confirm_signer(&app, &signer).await?;
    if summary.requires_extra_confirmation {
        confirm_native(
            &app,
            lang.check_tx_title(),
            describe_kaspa_extra(lang, &summary),
        )
        .await?;
    }
    let (signed, again) =
        blocking(move || Ok(wallet_core::kaspa_sign(&seed, net, a, &unsigned, &entries)?)).await?;
    if again != summary {
        return Err(AppError::Internal(
            "résumé différent entre l'aperçu et la signature".into(),
        ));
    }
    state.touch();
    Ok(KaspaSigned {
        tx: wallet_core::kaspa_tx_to_json(&signed)?,
        tx_id: summary.tx_id.clone(),
        summary,
    })
}

/// Checks the signed transaction against the live coins (ours, standard, every signature
/// valid) then submits it; the id the server returns must be ours.
pub(crate) async fn broadcast_checked(
    c: &KaspaCtx<'_>,
    ks: &[KaspaOwnKey],
    tx_json: &str,
) -> AppResult<String> {
    let tx = wallet_core::kaspa_tx_from_json(tx_json)?;
    let entries = live_entries(c, ks, &tx).await?;
    let summary = wallet_core::kaspa_tx_summary(c.network, &tx, &entries, ks)?;
    wallet_core::kaspa_verify_signed(&tx, &entries)?;
    kaspa_backend::submit(c, &wallet_core::kaspa_tx_to_json(&tx)?, &summary.tx_id).await
}

#[tauri::command]
pub async fn kas_broadcast(
    state: State<'_, AppState>,
    tx: String,
    account: Option<u32>,
) -> AppResult<String> {
    let ks = keys(&state, account_arg(account)?)?;
    broadcast_checked(&ctx(&state), &ks, &tx).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use wallet_core::{KaspaMass, KaspaOutputKind, KaspaOutputView};

    fn summary() -> KaspaTxSummary {
        KaspaTxSummary {
            tx_id: "ab".repeat(32),
            outputs: vec![
                KaspaOutputView {
                    address: Some("kaspa:qdest".into()),
                    script: "20ac".into(),
                    amount: "1000000000".into(),
                    is_change: false,
                    kind: KaspaOutputKind::Address,
                },
                KaspaOutputView {
                    address: Some("kaspa:qchange".into()),
                    script: "20ac".into(),
                    amount: "3999796400".into(),
                    is_change: true,
                    kind: KaspaOutputKind::Address,
                },
            ],
            inputs: 1,
            input_total: "5000000000".into(),
            sent: "1000000000".into(),
            fee: "203600".into(),
            mass: KaspaMass {
                compute: 2036,
                transient: 1264,
                storage: 1050,
                relay: 2036,
                total: 2036,
            },
            minimum_fee: "203600".into(),
            fee_rate: 100,
            has_change: true,
            warnings: vec![],
            requires_extra_confirmation: false,
        }
    }

    #[test]
    fn dialog_shows_what_rust_decoded() {
        let s = summary();
        let d = describe_kaspa(Lang::Fr, &s, Network::Testnet);
        for needle in [
            "Envoi Kaspa (testnet-10)",
            "À : kaspa:qdest\nMontant : 10 KAS",
            "Monnaie (revient chez toi) : 39,997964 KAS\n  kaspa:qchange",
            "Frais : 0,002036 KAS (203600 sompi)",
            "Masse : 2036 g (calcul 2036 · stockage KIP-9 1050 · transitoire 632)",
            "frais minimum de relais : 0,002036 KAS",
            "Entrées : 1 pièce(s) de ce compte, 50 KAS au total",
            &format!("Identifiant : {}", "ab".repeat(32)),
        ] {
            assert!(d.contains(needle), "{needle} missing in:\n{d}");
        }
        assert!(!d.contains("Pas de monnaie"));
        assert!(describe_kaspa(Lang::Fr, &s, Network::Mainnet).starts_with("Envoi Kaspa\n"));

        let mut x = summary();
        x.outputs[1].address = None;
        x.outputs[1].is_change = false;
        x.outputs[1].kind = KaspaOutputKind::Unknown;
        x.has_change = false;
        x.warnings = vec![
            KaspaWarning::UnknownOutput { index: 1 },
            KaspaWarning::HighFee,
        ];
        let d = describe_kaspa(Lang::Fr, &x, Network::Mainnet);
        assert!(d.contains("Sortie INCONNUE (script non reconnu) : 39,997964 KAS\n  script : 20ac"));
        assert!(d.contains("Pas de monnaie"));
        let e = describe_kaspa_extra(Lang::Fr, &x);
        assert!(e.contains("sortie 1 : script inconnu"));
        assert!(e.contains("frais élevés : 0,002036 KAS"));
        let en = describe_kaspa(Lang::En, &s, Network::Testnet);
        assert!(en.contains("To: kaspa:qdest\nAmount: 10 KAS") && en.contains("Fee: 0.002036 KAS"));
        assert!(describe_kaspa_extra(Lang::En, &x).contains("output 1: unknown script"));
    }

    #[test]
    fn amount_spec() {
        let s = |amount: Option<&str>, max| KaspaSendSpec {
            to: String::new(),
            amount: amount.map(str::to_owned),
            max,
        };
        assert_eq!(
            parse_amount(&s(Some("123"), false)).unwrap(),
            KaspaAmount::Exact(123)
        );
        assert_eq!(parse_amount(&s(None, true)).unwrap(), KaspaAmount::Max);
        for bad in [Some("0"), Some("-1"), Some("1.5"), Some(""), None] {
            assert!(parse_amount(&s(bad, false)).is_err(), "{bad:?}");
        }
    }
}
