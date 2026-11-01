//! IPC commands for Zcash, **transparent addresses only** (`zec_*`): addresses, Esplora-shaped
//! data from Kyro's default Electrum servers, and sending — Rust builds the v5 transaction
//! itself (coin selection, ZIP-317 fee, change to our own address, consensus branch read from
//! the chain), shows the native dialog with what it decoded, then signs. The interface only
//! proposes the candidate coins (outpoint + which of our addresses), the recipient and the
//! amount. Contract: docs/IPC.md §2.4b.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, State};
use wallet_core::{Network, ZecAddressKind, ZecCoin, ZecSendRequest, ZecTxSummary, ZecWarning};
use zeroize::Zeroizing;

use crate::accounts::{account_arg, confirm_signer, Chain, SignerInfo};
use crate::commands::{blocking, confirm_native, format_units_in, seed_from_password};
use crate::dialog_text;
use crate::error::{AppError, AppResult};
use crate::i18n::Lang;
use crate::state::AppState;
use crate::zcash_backend::{self, ZecCtx};

/// Most candidate coins one send may propose (each one's previous transaction is fetched).
const MAX_CANDIDATES: usize = 200;

fn ctx(state: &AppState) -> ZecCtx<'_> {
    ZecCtx {
        net_client: &state.net,
        network: state.network,
        tor: state.settings().tor.enabled,
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZecBackendInfo {
    /// Always `default` (no custom Zcash server yet).
    pub kind: &'static str,
    /// `mainnet` | `testnet`.
    pub network: &'static str,
    /// Host of the first default server, `""` on testnet (none).
    pub label: String,
    /// `false` = no server at all (testnet): every read fails with `SERVER_INVALID`.
    pub available: bool,
    pub tor: bool,
}

#[tauri::command]
pub fn zec_backend_info(state: State<'_, AppState>) -> ZecBackendInfo {
    let label = zcash_backend::label(state.network);
    ZecBackendInfo {
        kind: "default",
        network: zcash_backend::network_label(state.network),
        available: !label.is_empty(),
        label,
        tor: state.settings().tor.enabled,
    }
}

#[tauri::command]
pub fn zec_address(
    state: State<'_, AppState>,
    change: bool,
    index: u32,
    account: Option<u32>,
) -> AppResult<String> {
    let net = state.network;
    let a = account_arg(account)?;
    state.with_seed(|seed| Ok(wallet_core::zec_address(seed, net, a, change, index)?))
}

#[tauri::command]
pub async fn zec_address_info(state: State<'_, AppState>, address: String) -> AppResult<Value> {
    zcash_backend::address_info(&ctx(&state), &address).await
}

#[tauri::command]
pub async fn zec_address_utxos(state: State<'_, AppState>, address: String) -> AppResult<Value> {
    zcash_backend::address_utxos(&ctx(&state), &address).await
}

#[tauri::command]
pub async fn zec_address_txs(state: State<'_, AppState>, address: String) -> AppResult<Value> {
    zcash_backend::address_txs(&ctx(&state), &address).await
}

#[tauri::command]
pub async fn zec_tip_height(state: State<'_, AppState>) -> AppResult<u64> {
    zcash_backend::tip_height(&ctx(&state)).await
}

#[tauri::command]
pub async fn zec_broadcast(state: State<'_, AppState>, hex: String) -> AppResult<String> {
    zcash_backend::broadcast(&ctx(&state), &hex).await
}

/// A coin proposed by the interface: outpoint and which address of the account it pays.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ZecCandidate {
    pub txid: String,
    pub vout: u32,
    pub change: bool,
    pub index: u32,
}

/// A send as the interface describes it. Amount in zatoshis (decimal string).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ZecSendArgs {
    pub to: String,
    #[serde(default)]
    pub amount: String,
    #[serde(default)]
    pub max: bool,
    pub coins: Vec<ZecCandidate>,
    pub change_index: u32,
}

fn parse_amount(args: &ZecSendArgs) -> AppResult<u64> {
    if args.max {
        return Ok(0);
    }
    let a = args.amount.trim();
    if a.is_empty() || a.len() > 20 || !a.bytes().all(|b| b.is_ascii_digit()) {
        return Err(AppError::InvalidInput(
            "amount: a whole number of zatoshis".into(),
        ));
    }
    a.parse()
        .map_err(|_| AppError::InvalidInput("amount out of range".into()))
}

/// Reads the chain state and the previous transaction of every candidate (one Electrum
/// session), then assembles the request wallet-core builds from.
pub(crate) async fn request(state: &AppState, args: &ZecSendArgs) -> AppResult<ZecSendRequest> {
    let net = state.network;
    // Local checks first: nothing is sent for a recipient Kyro would refuse anyway.
    wallet_core::zec_parse_address(&args.to, net)?;
    let amount = parse_amount(args)?;
    if args.coins.is_empty() {
        return Err(AppError::InvalidInput("no coin to spend".into()));
    }
    if args.coins.len() > MAX_CANDIDATES {
        return Err(AppError::InvalidInput(format!(
            "more than {MAX_CANDIDATES} coins offered"
        )));
    }
    let c = ctx(state);
    let mut conn = zcash_backend::session(&c).await?;
    let chain = zcash_backend::chain_state(&mut conn).await?;
    let txids: Vec<String> = args
        .coins
        .iter()
        .map(|c| c.txid.trim().to_ascii_lowercase())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let prevs = zcash_backend::prev_txs(net, &mut conn, &txids).await?;
    let coins = args
        .coins
        .iter()
        .map(|c| {
            let prev_tx = prevs
                .get(&c.txid.trim().to_ascii_lowercase())
                .cloned()
                .ok_or_else(|| {
                    AppError::ServerUnreachable(format!(
                        "Zcash: previous transaction {} not found",
                        c.txid
                    ))
                })?;
            Ok(ZecCoin {
                prev_tx,
                vout: c.vout,
                change: c.change,
                index: c.index,
            })
        })
        .collect::<AppResult<Vec<_>>>()?;
    Ok(ZecSendRequest {
        coins,
        to: args.to.clone(),
        amount,
        max: args.max,
        change_index: args.change_index,
        tip_height: chain.tip,
        network_branch_height: chain.branch_height,
        network_branch_id: chain.branch_id,
    })
}

/// What Rust would sign, without the password: built and decoded the same way as `zec_sign`.
#[tauri::command]
pub async fn zec_send_preview(
    state: State<'_, AppState>,
    request: ZecSendArgs,
    account: Option<u32>,
) -> AppResult<ZecTxSummary> {
    if !state.is_unlocked() {
        return Err(AppError::Locked);
    }
    let net = state.network;
    let a = account_arg(account)?;
    let req = self::request(&state, &request).await?;
    state.with_seed(|seed| Ok(wallet_core::zec_tx_summary(seed, net, a, &req)?))
}

#[derive(Serialize)]
pub struct ZecSigned {
    hex: String,
    txid: String,
    summary: ZecTxSummary,
}

fn zec(lang: Lang, raw: &str) -> String {
    format!("{} ZEC", format_units_in(lang, raw, 8))
}

fn net_suffix(net: Network) -> &'static str {
    match net {
        Network::Mainnet => "",
        Network::Testnet => " (testnet)",
    }
}

/// Body of the native dialog, built from Rust's own construction and decoding only.
pub(crate) fn describe_zec(lang: Lang, s: &ZecTxSummary, net: Network) -> String {
    let z = |v: &str| zec(lang, v);
    let mut out = format!(
        "{}{}\n\n",
        lang.pick("Envoi Zcash transparent", "Transparent Zcash send"),
        net_suffix(net)
    );
    let to = dialog_text::field(&s.to, 120);
    let to_label = lang.pick("À : ", "To: ");
    match s.to_kind {
        ZecAddressKind::Tex => {
            out += &match lang {
                Lang::Fr => format!(
                    "{to_label}{to}\n  (adresse TEX, ZIP 320 : paie la clé de {})\n",
                    s.to_address
                ),
                Lang::En => format!(
                    "{to_label}{to}\n  (TEX address, ZIP 320: pays the key of {})\n",
                    s.to_address
                ),
            };
        }
        _ => out += &format!("{to_label}{to}\n"),
    }
    out += &format!("{}{}\n", lang.pick("Montant : ", "Amount: "), z(&s.amount));
    if let Some(c) = &s.change {
        out += &match lang {
            Lang::Fr => format!(
                "Monnaie (revient chez toi) : {}\n  {} (adresse de monnaie n° {})\n",
                z(&c.amount),
                c.address,
                c.index
            ),
            Lang::En => format!(
                "Change (comes back to you): {}\n  {} (change address #{})\n",
                z(&c.amount),
                c.address,
                c.index
            ),
        };
    }
    out += &match lang {
        Lang::Fr => format!(
            "\nFrais : {} ({} zatoshis ; ZIP 317 : {} zatoshis)",
            z(&s.fee),
            s.fee,
            s.zip317_fee
        ),
        Lang::En => format!(
            "\nFee: {} ({} zatoshis; ZIP 317: {} zatoshis)",
            z(&s.fee),
            s.fee,
            s.zip317_fee
        ),
    };
    if s.folded != "0" {
        out += &match lang {
            Lang::Fr => format!(
                "\nPas de monnaie : le reste ({} zatoshis), trop petit pour une sortie, est ajouté aux frais.",
                s.folded
            ),
            Lang::En => format!(
                "\nNo change: the remainder ({} zatoshis), too small for an output, is added to the fee.",
                s.folded
            ),
        };
    }
    out += &match lang {
        Lang::Fr => format!(
            "\nEntrées : {} pièce(s) à toi, {}",
            s.inputs,
            z(&s.input_total)
        ),
        Lang::En => format!(
            "\nInputs: {} coin(s) of yours, {}",
            s.inputs,
            z(&s.input_total)
        ),
    };
    let minutes = (u64::from(s.expiry_height.saturating_sub(s.target_height)) + 1) * 75 / 60;
    out += &match lang {
        Lang::Fr => format!(
            "\nRéseau : {} (branche {}) · valable jusqu'au bloc {} (≈ {minutes} min)",
            s.upgrade, s.branch_id, s.expiry_height
        ),
        Lang::En => format!(
            "\nNetwork: {} (branch {}) · valid until block {} (≈ {minutes} min)",
            s.upgrade, s.branch_id, s.expiry_height
        ),
    };
    for w in &s.warnings {
        if let ZecWarning::ExpiryCapped {
            next_upgrade_height,
        } = w
        {
            out += &match lang {
                Lang::Fr => format!(
                    "\nMise à niveau du réseau au bloc {next_upgrade_height} : la transaction expire plus tôt que d'habitude."
                ),
                Lang::En => format!(
                    "\nNetwork upgrade at block {next_upgrade_height}: the transaction expires sooner than usual."
                ),
            };
        }
    }
    out += lang.pick(
        "\n\nTransparent : le montant, ton adresse et le destinataire sont publics sur la chaîne, comme pour Bitcoin.",
        "\n\nTransparent: the amount, your address and the recipient are public on the chain, as with Bitcoin.",
    );
    out
}

/// Body of the reinforced (second) dialog.
pub(crate) fn describe_zec_extra(lang: Lang, s: &ZecTxSummary) -> String {
    let mut out = String::from(lang.unusual_intro());
    for w in &s.warnings {
        match w {
            ZecWarning::HighFee => {
                out += lang.pick(
                    "• frais très élevés (plus de 10 fois les frais ZIP 317, ou plus que le montant envoyé)\n",
                    "• very high fee (more than 10 times the ZIP 317 fee, or more than the amount sent)\n",
                )
            }
            ZecWarning::ExpiryCapped { .. } => continue,
        }
    }
    out += "\n";
    out += lang.sign_anyway();
    out
}

/// Password, Rust's construction and decoding, native dialog (+ reinforced one if needed),
/// signature. Returns the signed transaction; `zec_broadcast` sends it.
#[tauri::command]
pub async fn zec_sign(
    app: AppHandle,
    state: State<'_, AppState>,
    request: ZecSendArgs,
    password: String,
    account: Option<u32>,
) -> AppResult<ZecSigned> {
    if !state.is_unlocked() {
        return Err(AppError::Locked);
    }
    let net = state.network;
    let a = account_arg(account)?;
    let path = state.with_seed(|seed| Ok(wallet_core::zec_account(seed, net, a)?.path))?;
    let signer = SignerInfo::new(&state, Chain::Zec, a, path);
    let req = self::request(&state, &request).await?;
    let seed = seed_from_password(&state, Zeroizing::new(password)).await?;
    let (seed, req, summary) = blocking(move || {
        let s = wallet_core::zec_tx_summary(&seed, net, a, &req)?;
        Ok((seed, req, s))
    })
    .await?;
    let lang = crate::i18n::current();
    confirm_native(
        &app,
        lang.pick(
            "Confirmer la transaction Zcash",
            "Confirm the Zcash transaction",
        ),
        signer.body(lang, &describe_zec(lang, &summary, net)),
    )
    .await?;
    confirm_signer(&app, &signer).await?;
    if summary.requires_extra_confirmation {
        confirm_native(
            &app,
            lang.check_tx_title(),
            describe_zec_extra(lang, &summary),
        )
        .await?;
    }
    let (hex, again) = blocking(move || Ok(wallet_core::zec_sign(&seed, net, a, &req)?)).await?;
    if again != summary {
        return Err(AppError::Internal(
            "summary differs between the preview and the signature".into(),
        ));
    }
    state.touch();
    Ok(ZecSigned {
        txid: summary.txid.clone(),
        hex,
        summary,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use wallet_core::ZecChange;

    fn summary() -> ZecTxSummary {
        ZecTxSummary {
            to: "t1VmmGiyjVNeCjxDZzg7vZmd99WyzVby9yC".into(),
            to_kind: ZecAddressKind::P2pkh,
            to_address: "t1VmmGiyjVNeCjxDZzg7vZmd99WyzVby9yC".into(),
            amount: "12345678".into(),
            change: Some(ZecChange {
                address: "t1Change".into(),
                amount: "17644322".into(),
                index: 2,
            }),
            fee: "10000".into(),
            zip317_fee: "10000".into(),
            folded: "0".into(),
            inputs: 1,
            input_total: "30000000".into(),
            upgrade: "NU6.3".into(),
            branch_id: "0x37a5165b".into(),
            target_height: 3_537_785,
            expiry_height: 3_537_825,
            txid: "00".repeat(32),
            warnings: vec![],
            requires_extra_confirmation: false,
        }
    }

    #[test]
    fn dialog_shows_what_rust_built() {
        let d = describe_zec(Lang::Fr, &summary(), Network::Mainnet);
        for needle in [
            "Envoi Zcash transparent\n",
            "À : « t1VmmGiyjVNeCjxDZzg7vZmd99WyzVby9yC »",
            "Montant : 0,12345678 ZEC",
            "Monnaie (revient chez toi) : 0,17644322 ZEC\n  t1Change (adresse de monnaie n° 2)",
            "Frais : 0,0001 ZEC (10000 zatoshis ; ZIP 317 : 10000 zatoshis)",
            "Entrées : 1 pièce(s) à toi, 0,3 ZEC",
            "Réseau : NU6.3 (branche 0x37a5165b) · valable jusqu'au bloc 3537825 (≈ 51 min)",
            "publics sur la chaîne",
        ] {
            assert!(d.contains(needle), "{needle} missing in:\n{d}");
        }
        assert!(!d.contains("Pas de monnaie"));

        let mut s = summary();
        s.to = "tex1s2rt77ggv6q989lr49rkgzmh5slsksa9khdgte".into();
        s.to_kind = ZecAddressKind::Tex;
        s.change = None;
        s.folded = "4999".into();
        s.fee = "14999".into();
        s.warnings = vec![
            ZecWarning::HighFee,
            ZecWarning::ExpiryCapped {
                next_upgrade_height: 3_543_405,
            },
        ];
        s.requires_extra_confirmation = true;
        let d = describe_zec(Lang::Fr, &s, Network::Testnet);
        assert!(d.starts_with("Envoi Zcash transparent (testnet)"));
        assert!(
            d.contains("adresse TEX, ZIP 320 : paie la clé de t1VmmGiyjVNeCjxDZzg7vZmd99WyzVby9yC")
        );
        assert!(d.contains("le reste (4999 zatoshis)"));
        assert!(d.contains("Mise à niveau du réseau au bloc 3543405"));
        assert!(!d.contains("Monnaie (revient"));
        let x = describe_zec_extra(Lang::Fr, &s);
        assert!(x.contains("frais très élevés"));
        assert!(!x.contains("Mise à niveau"));
        let en = describe_zec(Lang::En, &summary(), Network::Mainnet);
        assert!(en.contains("Amount: 0.12345678 ZEC") && en.contains("Fee: 0.0001 ZEC"));
    }

    #[test]
    fn send_arguments_are_strict() {
        let ok: ZecSendArgs = serde_json::from_value(serde_json::json!({
            "to": "t1VmmGiyjVNeCjxDZzg7vZmd99WyzVby9yC", "amount": "1000",
            "coins": [{ "txid": "ab".repeat(32), "vout": 0, "change": false, "index": 0 }],
            "changeIndex": 0
        }))
        .unwrap();
        assert_eq!(parse_amount(&ok).unwrap(), 1000);
        // Unknown fields (e.g. an amount the interface claims for a coin) are refused.
        assert!(serde_json::from_value::<ZecSendArgs>(serde_json::json!({
            "to": "t1", "amount": "1", "changeIndex": 0,
            "coins": [{ "txid": "ab", "vout": 0, "change": false, "index": 0, "value": 5 }]
        }))
        .is_err());
        for bad in ["", "1.5", "-1", "1e9", "99999999999999999999999"] {
            let mut a = ok.clone();
            a.amount = bad.into();
            assert!(parse_amount(&a).is_err(), "{bad}");
        }
        let mut m = ok.clone();
        m.max = true;
        m.amount = String::new();
        assert_eq!(parse_amount(&m).unwrap(), 0);
    }
}
