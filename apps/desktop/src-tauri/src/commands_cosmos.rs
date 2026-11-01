//! IPC commands for Cosmos Hub (`cosmos_*`): address, account (balance, spendable, account
//! number, sequence), history, `MsgSend` building **by Kyro** (chain id, account number,
//! sequence, timeout height from the server, gas from a simulation of the exact transaction,
//! encoded by wallet-core), signing behind the password and the native dialog (what Rust decoded
//! from the SignDoc: amount, recipient, fee, gas, chain id, memo — all re-read live), and
//! broadcast with hash check. Contract: docs/IPC.md §2.11.

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, State};
use wallet_core::{CosmosSendRequest, CosmosTxSummary, CosmosWarning, Network};
use zeroize::Zeroizing;

use crate::accounts::{account_arg, confirm_signer, Chain, SignerInfo};
use crate::commands::{blocking, confirm_native, format_units_in, seed_from_password};
use crate::cosmos_backend::{self, CosmosAccountInfo, CosmosCtx, CosmosTxStatus, TIMEOUT_BLOCKS};
use crate::error::{AppError, AppResult};
use crate::i18n::Lang;
use crate::servers::host_of;
use crate::state::AppState;

pub(crate) fn ctx(state: &AppState) -> CosmosCtx<'_> {
    CosmosCtx {
        net_client: &state.net,
        network: state.network,
        tor: state.settings().tor.enabled,
    }
}

/// Address and public key of Cosmos account `account` (`m/44'/118'/account'/0/0`).
fn ours(state: &AppState, account: u32) -> AppResult<(String, [u8; 33])> {
    state.with_seed(|seed| {
        Ok((
            wallet_core::cosmos_address(seed, account)?,
            wallet_core::cosmos_public_key(seed, account)?,
        ))
    })
}

fn atom(lang: Lang, uatom: &str) -> String {
    format!("{} ATOM", format_units_in(lang, uatom, 6))
}

/// Live context shown in the dialog.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CosmosContext {
    pub account: CosmosAccountInfo,
    /// Height of the latest block when it was read.
    pub height: u64,
}

/// Body of the native dialog: everything comes from the decoded SignDoc, except the balance.
pub(crate) fn describe_cosmos(
    lang: Lang,
    s: &CosmosTxSummary,
    c: &CosmosContext,
    net: Network,
) -> String {
    let line = "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━";
    let at = |v: &str| atom(lang, v);
    let testnet = if net == Network::Testnet {
        " (testnet)"
    } else {
        ""
    };
    let mut out = match lang {
        Lang::Fr => format!(
            "Envoi Cosmos Hub{testnet}\n\nÀ : {}\n\nMontant : {} ({} uatom)\n",
            s.to,
            at(&s.amount),
            s.amount
        ),
        Lang::En => format!(
            "Cosmos Hub send{testnet}\n\nTo: {}\n\nAmount: {} ({} uatom)\n",
            s.to,
            at(&s.amount),
            s.amount
        ),
    };
    let total = s
        .amount
        .parse::<u128>()
        .unwrap_or(0)
        .saturating_add(s.fee.parse::<u128>().unwrap_or(0));
    let left = c
        .account
        .spendable
        .parse::<u128>()
        .unwrap_or(0)
        .saturating_sub(total);
    out += &match lang {
        Lang::Fr => format!(
            "Frais : {} ({} uatom, gas maximum {})\nDisponible : {} · après l'envoi : {}\n",
            at(&s.fee),
            s.fee,
            s.gas_limit,
            at(&c.account.spendable),
            at(&left.to_string())
        ),
        Lang::En => format!(
            "Fee: {} ({} uatom, maximum gas {})\nAvailable: {} · after the send: {}\n",
            at(&s.fee),
            s.fee,
            s.gas_limit,
            at(&c.account.spendable),
            at(&left.to_string())
        ),
    };
    let chain_id = crate::dialog_text::field(&s.chain_id, 64);
    let minutes = (s.timeout_height.saturating_sub(c.height) * 6).div_ceil(60);
    out += &match lang {
        Lang::Fr => format!(
            "Réseau : chain-id {chain_id} · compte n° {} · séquence {}\nValable jusqu'au bloc n° {} (≈ {minutes} min)\n",
            s.account_number, s.sequence, s.timeout_height
        ),
        Lang::En => format!(
            "Network: chain-id {chain_id} · account number {} · sequence {}\nValid until block {} (≈ {minutes} min)\n",
            s.account_number, s.sequence, s.timeout_height
        ),
    };
    // Untrusted text last, framed on its own line.
    out += &format!("\n{line}\n");
    match &s.memo {
        Some(m) => {
            out += &format!(
                "{}{}\n",
                lang.pick("MÉMO (public à jamais) : ", "MEMO (public forever): "),
                crate::dialog_text::field(m, crate::dialog_text::MAX_FIELD * 2)
            );
        }
        None => out += lang.pick(
            "AUCUN MÉMO\n(une plateforme d'échange en exige souvent un : sans lui, les fonds peuvent être perdus)\n",
            "NO MEMO\n(an exchange often requires one: without it, the funds can be lost)\n",
        ),
    }
    out += line;
    out
}

pub(crate) fn describe_cosmos_extra(lang: Lang, s: &CosmosTxSummary) -> String {
    let mut out = String::from(lang.pick(
        "Kyro a trouvé des éléments inhabituels dans cet envoi :\n",
        "Kyro found unusual details in this send:\n",
    ));
    for w in &s.warnings {
        out += match w {
            CosmosWarning::HighFee => lang.pick(
                "• frais supérieurs à 0,1 ATOM (d'habitude moins de 0,001 ATOM)\n",
                "• fee above 0.1 ATOM (usually less than 0.001 ATOM)\n",
            ),
            CosmosWarning::UnusualText => lang.pick(
                "• mémo contenant des caractères invisibles / de contrôle, ou trop long (affiché nettoyé)\n",
                "• memo containing invisible / control characters, or too long (shown cleaned)\n",
            ),
        };
    }
    if let Some(h) = &s.memo_hex {
        if s.warnings.contains(&CosmosWarning::UnusualText) {
            out += &format!(
                "{}{}\n",
                lang.pick("Mémo exact (hexadécimal) : ", "Exact memo (hexadecimal): "),
                crate::dialog_text::sanitize(h, 1100)
            );
        }
    }
    out += "\n";
    out += lang.sign_anyway();
    out
}

// ---------------------------------------------------------------- reads

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CosmosBackendInfo {
    pub kind: &'static str,
    pub network: &'static str,
    pub label: String,
    pub chain_id: &'static str,
    pub tor: bool,
}

#[tauri::command]
pub fn cosmos_backend_info(state: State<'_, AppState>) -> CosmosBackendInfo {
    let c = ctx(&state);
    CosmosBackendInfo {
        kind: "default",
        network: crate::commands::network_name(state.network),
        label: host_of(cosmos_backend::default_url(state.network)).unwrap_or_default(),
        chain_id: wallet_core::cosmos_chain_id(state.network),
        tor: c.tor,
    }
}

/// Address of Cosmos account `account` (absent = 0). One address per account.
#[tauri::command]
pub fn cosmos_address(state: State<'_, AppState>, account: Option<u32>) -> AppResult<String> {
    Ok(ours(&state, account_arg(account)?)?.0)
}

#[tauri::command]
pub async fn cosmos_account(
    state: State<'_, AppState>,
    address: String,
) -> AppResult<CosmosAccountInfo> {
    cosmos_backend::account(&ctx(&state), &address).await
}

#[tauri::command]
pub async fn cosmos_txs(state: State<'_, AppState>, address: String) -> AppResult<Value> {
    cosmos_backend::txs(&ctx(&state), &address).await
}

// ---------------------------------------------------------------- build, sign, broadcast

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CosmosBuilt {
    /// Serialized SignDoc, hex: what `cosmos_sign_tx` signs.
    pub sign_doc: String,
    pub summary: CosmosTxSummary,
    pub context: CosmosContext,
}

fn parse_uatom(amount: &str) -> AppResult<u128> {
    let a = amount.trim();
    if a.is_empty() || a.len() > 30 || !a.bytes().all(|b| b.is_ascii_digit()) {
        return Err(AppError::InvalidInput("invalid amount in uatom".into()));
    }
    a.parse::<u128>()
        .ok()
        .filter(|v| *v > 0)
        .ok_or_else(|| AppError::InvalidInput("invalid amount in uatom".into()))
}

/// Our account, checked: it exists and the key recorded on chain (if any) is ours.
async fn our_account(c: &CosmosCtx<'_>, me: &str, pk: &[u8; 33]) -> AppResult<CosmosAccountInfo> {
    use base64::Engine as _;
    let acc = cosmos_backend::account(c, me).await?;
    if let Some(k) = &acc.pub_key {
        if base64::engine::general_purpose::STANDARD
            .decode(k)
            .ok()
            .as_deref()
            != Some(pk.as_slice())
        {
            return Err(AppError::ServerUnreachable(
                "Cosmos: the public key recorded on the chain is not this account's".into(),
            ));
        }
    }
    Ok(acc)
}

/// Builds an unsigned MsgSend from live data: `amount` in uatom.
pub(crate) async fn build(
    c: &CosmosCtx<'_>,
    me: &str,
    pk: &[u8; 33],
    to: &str,
    amount: &str,
    memo: &str,
) -> AppResult<CosmosBuilt> {
    let to = wallet_core::cosmos_normalize_address(to)?;
    if to == me {
        return Err(AppError::InvalidInput("cannot send to yourself".into()));
    }
    let amount = parse_uatom(amount)?;
    if memo.chars().count() > wallet_core::COSMOS_MAX_MEMO {
        return Err(AppError::InvalidInput(format!(
            "memo: at most {} characters",
            wallet_core::COSMOS_MAX_MEMO
        )));
    }
    let info = cosmos_backend::chain_info(c).await?;
    let account = our_account(c, me, pk).await?;
    cosmos_backend::check_send(&account, amount, 0)?;
    let mut req = CosmosSendRequest {
        chain_id: info.chain_id.clone(),
        account_number: account.account_number,
        sequence: account.sequence,
        public_key: *pk,
        to,
        amount,
        fee: 0,
        gas_limit: cosmos_backend::MAX_GAS,
        memo: memo.to_owned(),
        timeout_height: info.height.saturating_add(TIMEOUT_BLOCKS),
    };
    // Simulate the exact transaction (fee 0: simulation does not charge it), then set the fee.
    let probe = wallet_core::cosmos_send_sign_doc(&req)?;
    let gas_used = cosmos_backend::simulate(c, &wallet_core::cosmos_simulation_tx(&probe)?).await?;
    let price = cosmos_backend::gas_price(c).await?;
    let (gas_limit, fee) = cosmos_backend::fee_for(gas_used, price)?;
    req.gas_limit = gas_limit;
    req.fee = fee;
    cosmos_backend::check_send(&account, amount, fee)?;
    let doc = wallet_core::cosmos_send_sign_doc(&req)?;
    let sign_doc = hex::encode(&doc);
    let summary = wallet_core::cosmos_decode_sign_doc(&sign_doc, pk, c.network)?;
    Ok(CosmosBuilt {
        sign_doc,
        summary,
        context: CosmosContext {
            account,
            height: info.height,
        },
    })
}

#[tauri::command]
pub async fn cosmos_build_tx(
    state: State<'_, AppState>,
    to: String,
    amount: String,
    memo: Option<String>,
    account: Option<u32>,
) -> AppResult<CosmosBuilt> {
    let (me, pk) = ours(&state, account_arg(account)?)?;
    build(
        &ctx(&state),
        &me,
        &pk,
        &to,
        &amount,
        memo.as_deref().unwrap_or(""),
    )
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CosmosSigned {
    /// Signed `TxRaw`, base64: what `cosmos_broadcast` sends.
    pub tx: String,
    pub hash: String,
    pub summary: CosmosTxSummary,
    pub context: CosmosContext,
}

/// Decoding + live re-checks, i.e. everything `cosmos_sign_tx` does before the dialog.
pub(crate) async fn prepare_sign(
    c: &CosmosCtx<'_>,
    me: &str,
    pk: &[u8; 33],
    sign_doc: &str,
) -> AppResult<(CosmosTxSummary, CosmosContext)> {
    let summary = wallet_core::cosmos_decode_sign_doc(sign_doc, pk, c.network)?;
    let info = cosmos_backend::chain_info(c).await?;
    let account = our_account(c, me, pk).await?;
    if summary.timeout_height <= info.height {
        return Err(AppError::InvalidInput(
            "Cosmos transaction expired (timeout_height passed): rebuild it".into(),
        ));
    }
    if summary.account_number != account.account_number {
        return Err(AppError::InvalidInput(
            "Cosmos account number differs from the network's: rebuild the transaction".into(),
        ));
    }
    if summary.sequence != account.sequence {
        return Err(AppError::InvalidInput(
            "stale sequence number: rebuild the transaction".into(),
        ));
    }
    cosmos_backend::check_send(
        &account,
        summary.amount.parse().unwrap_or(u128::MAX),
        summary.fee.parse().unwrap_or(u128::MAX),
    )?;
    Ok((
        summary,
        CosmosContext {
            account,
            height: info.height,
        },
    ))
}

#[tauri::command]
pub async fn cosmos_sign_tx(
    app: AppHandle,
    state: State<'_, AppState>,
    sign_doc: String,
    password: String,
    account: Option<u32>,
) -> AppResult<CosmosSigned> {
    if !state.is_unlocked() {
        return Err(AppError::Locked);
    }
    let a = account_arg(account)?;
    let (me, pk) = ours(&state, a)?;
    let signer = SignerInfo::new(&state, Chain::Cosmos, a, wallet_core::cosmos_path(a));
    let c = ctx(&state);
    let net = state.network;
    let (summary, context) = prepare_sign(&c, &me, &pk, &sign_doc).await?;
    let seed = seed_from_password(&state, Zeroizing::new(password)).await?;
    let lang = crate::i18n::current();
    confirm_native(
        &app,
        lang.pick("Confirmer l'envoi d'ATOM", "Confirm the ATOM send"),
        signer.body(lang, &describe_cosmos(lang, &summary, &context, net)),
    )
    .await?;
    confirm_signer(&app, &signer).await?;
    if summary.requires_extra_confirmation {
        confirm_native(
            &app,
            lang.pick("Attention : envoi à vérifier", "Warning: send to check"),
            describe_cosmos_extra(lang, &summary),
        )
        .await?;
    }
    let d = sign_doc.clone();
    let (tx, hash, again) =
        blocking(move || Ok(wallet_core::cosmos_sign(&seed, a, &d, net)?)).await?;
    if again != summary {
        return Err(AppError::Internal(
            "summary differs between the preview and the signature".into(),
        ));
    }
    state.touch();
    Ok(CosmosSigned {
        tx,
        hash,
        summary,
        context,
    })
}

/// Checks the signed transaction (strict decoding, low-S signature by our key over the SignDoc
/// rebuilt with the live account number) then broadcasts it.
pub(crate) async fn broadcast_checked(
    c: &CosmosCtx<'_>,
    me: &str,
    pk: &[u8; 33],
    tx: &str,
) -> AppResult<String> {
    let account = our_account(c, me, pk).await?;
    let (hash, summary) = wallet_core::cosmos_verify_signed(tx, c.network, account.account_number)?;
    if summary.from != me {
        return Err(AppError::InvalidInput(
            "this transaction is not signed by your account".into(),
        ));
    }
    cosmos_backend::broadcast(c, tx.trim(), &hash).await
}

#[tauri::command]
pub async fn cosmos_broadcast(
    state: State<'_, AppState>,
    tx: String,
    account: Option<u32>,
) -> AppResult<String> {
    let (me, pk) = ours(&state, account_arg(account)?)?;
    broadcast_checked(&ctx(&state), &me, &pk, &tx).await
}

#[tauri::command]
pub async fn cosmos_tx_status(
    state: State<'_, AppState>,
    hash: String,
) -> AppResult<CosmosTxStatus> {
    let h = hash.trim();
    if h.len() != 64 || !h.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(AppError::InvalidInput(
            "hash: 64 hexadecimal characters".into(),
        ));
    }
    cosmos_backend::tx_status(&ctx(&state), &h.to_uppercase()).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summary(memo: Option<&str>) -> CosmosTxSummary {
        CosmosTxSummary {
            chain_id: "provider".into(),
            account_number: 30_881,
            sequence: 72,
            from: "cosmos19rl4cm2hmr8afy4kldpxz3fka4jguq0auqdal4".into(),
            to: "cosmos1tehv5km5e9y706rc2gzk9yyun9dljjjnvyt3u0".into(),
            amount: "1500000".into(),
            fee: "756".into(),
            gas_limit: 126_000,
            memo: memo.map(str::to_owned),
            memo_hex: memo.map(|m| hex::encode(m.as_bytes())),
            timeout_height: 1_100,
            warnings: vec![],
            requires_extra_confirmation: false,
        }
    }

    fn context() -> CosmosContext {
        CosmosContext {
            account: CosmosAccountInfo {
                exists: true,
                balance: "15605097".into(),
                spendable: "15605097".into(),
                ..Default::default()
            },
            height: 1_000,
        }
    }

    #[test]
    fn dialog_shows_what_rust_decoded() {
        let d = describe_cosmos(
            Lang::Fr,
            &summary(Some("4242\n")),
            &context(),
            Network::Testnet,
        );
        for needle in [
            "Envoi Cosmos Hub (testnet)",
            "À : cosmos1tehv5km5e9y706rc2gzk9yyun9dljjjnvyt3u0",
            "Montant : 1,5 ATOM (1500000 uatom)",
            "Frais : 0,000756 ATOM (756 uatom, gas maximum 126000)",
            "Disponible : 15,605097 ATOM · après l'envoi : 14,104341 ATOM",
            "chain-id « provider » · compte n° 30881 · séquence 72",
            "Valable jusqu'au bloc n° 1100 (≈ 10 min)",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nMÉMO (public à jamais) : « 4242 »\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        ] {
            assert!(d.contains(needle), "{needle} missing in:\n{d}");
        }
        // The memo comes after the amount and the fee.
        assert!(d.find("MÉMO").unwrap() > d.find("Frais").unwrap());
        let d = describe_cosmos(Lang::Fr, &summary(None), &context(), Network::Mainnet);
        assert!(d.starts_with("Envoi Cosmos Hub\n"));
        assert!(d.contains("AUCUN MÉMO"));
        let mut s = summary(Some("x"));
        s.warnings = vec![CosmosWarning::HighFee, CosmosWarning::UnusualText];
        let x = describe_cosmos_extra(Lang::Fr, &s);
        assert!(x.contains("0,1 ATOM") && x.contains("Mémo exact (hexadécimal) : 78"));
        let en = describe_cosmos(
            Lang::En,
            &summary(Some("4242\n")),
            &context(),
            Network::Testnet,
        );
        assert!(
            en.contains("Amount: 1.5 ATOM (1500000 uatom)")
                && en.contains("MEMO (public forever): « 4242 »")
        );
        assert!(describe_cosmos_extra(Lang::En, &s).contains("0.1 ATOM"));
    }

    #[test]
    fn amounts() {
        assert_eq!(parse_uatom("1000").unwrap(), 1000);
        for bad in ["", "0", "-1", "1.5", "1e3", " "] {
            assert!(parse_uatom(bad).is_err(), "{bad:?}");
        }
    }
}

/// Real-network test over Tor. Run with
/// `cargo test -p kyro-desktop -- --ignored --nocapture cosmos_live`.
/// - reads (always): chain id and height on mainnet and testnet, the account, balance and
///   history of the public « abandon … about » address, the fee-market gas price;
/// - simulation (always, nothing is signed or sent): a MsgSend built by Kyro from that address;
/// - `KYRO_COSMOS_SEND=yes`: one real **testnet** send of 1 000 uatom from « abandon … about »
///   (a public test wallet: its keys are known to everyone) to its account 1, with a memo, through
///   the real path (live checks, dialog text, signature with identical summary, broadcast, hash
///   check, inclusion).
#[cfg(test)]
mod live {
    use super::*;
    use crate::net::NetClient;
    use crate::tor::TorState;

    const ABANDON: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    #[test]
    #[ignore]
    fn cosmos_live_over_tor() {
        let net = NetClient::new(std::env::temp_dir().join("kyro-cosmos-live")).unwrap();
        let seed = wallet_core::Mnemonic::parse(ABANDON).unwrap().to_seed("");
        let me = wallet_core::cosmos_address(&seed, 0).unwrap();
        let pk = wallet_core::cosmos_public_key(&seed, 0).unwrap();
        let to = wallet_core::cosmos_address(&seed, 1).unwrap();
        let tor = std::env::var("KYRO_COSMOS_CLEAR").as_deref() != Ok("yes");
        tauri::async_runtime::block_on(async {
            if tor {
                net.tor.restart();
                while net.tor.status().state != TorState::Ready {
                    assert_ne!(net.tor.status().state, TorState::Error);
                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                }
            }
            let main = CosmosCtx {
                net_client: &net,
                network: Network::Mainnet,
                tor,
            };
            let c = CosmosCtx {
                net_client: &net,
                network: Network::Testnet,
                tor,
            };
            let t = std::time::Instant::now();
            eprintln!(
                "mainnet {:?} in {:.1?}",
                cosmos_backend::probe(&main).await,
                t.elapsed()
            );
            eprintln!("testnet {:?}", cosmos_backend::probe(&c).await);
            eprintln!("gas price {:?}", cosmos_backend::gas_price(&main).await);
            eprintln!(
                "mainnet account {:?}",
                cosmos_backend::account(&main, &me).await
            );
            let acc = cosmos_backend::account(&c, &me).await.unwrap();
            eprintln!("testnet account {acc:?}");
            let h = cosmos_backend::txs(&c, &me).await.unwrap();
            eprintln!(
                "history: {} entries, first {}",
                h.as_array().map_or(0, Vec::len),
                h.get(0).cloned().unwrap_or_default()
            );
            let built = build(&c, &me, &pk, &to, "1000", "Kyro test").await.unwrap();
            eprintln!(
                "built: gas {} fee {} uatom, timeout {}",
                built.summary.gas_limit, built.summary.fee, built.summary.timeout_height
            );
            let (summary, context) = prepare_sign(&c, &me, &pk, &built.sign_doc).await.unwrap();
            assert_eq!(summary, built.summary);
            eprintln!(
                "--- dialog ---\n{}\n---",
                describe_cosmos(Lang::Fr, &summary, &context, Network::Testnet)
            );
            assert!(!summary.requires_extra_confirmation);
            if std::env::var("KYRO_COSMOS_SEND").as_deref() != Ok("yes") {
                eprintln!("KYRO_COSMOS_SEND != yes: nothing sent");
                return;
            }
            let (tx, hash, again) =
                wallet_core::cosmos_sign(&seed, 0, &built.sign_doc, Network::Testnet).unwrap();
            assert_eq!(again, summary, "identical summary");
            let got = broadcast_checked(&c, &me, &pk, &tx).await.unwrap();
            assert_eq!(got, hash);
            eprintln!("BROADCAST {hash}");
            for _ in 0..40 {
                tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                let s = cosmos_backend::tx_status(&c, &hash).await.unwrap();
                if s.included {
                    eprintln!("included: {s:?}");
                    assert!(s.success, "{s:?}");
                    eprintln!("recipient {:?}", cosmos_backend::account(&c, &to).await);
                    return;
                }
            }
            panic!("{hash} not included");
        });
    }
}
