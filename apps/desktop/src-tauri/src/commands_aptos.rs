//! IPC commands for Aptos (`aptos_*`): address, account (balance, sequence number, key not
//! rotated), history, APT transfer building **by Kyro** (`0x1::aptos_account::transfer`;
//! sequence number, gas price, simulated maximum gas and expiration from the node, encoded by
//! wallet-core), signing behind the password and the native dialog (what Rust decoded, balance
//! and sequence re-read live), and submission with hash check. Contract: docs/IPC.md §2.11.

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, State};
use wallet_core::{AptosTransfer, AptosTxSummary, AptosWarning, Network};
use zeroize::Zeroizing;

use crate::accounts::{account_arg, confirm_signer, Chain, SignerInfo};
use crate::aptos_backend::{self, AptosAccountInfo, AptosCtx};
use crate::commands::{blocking, confirm_native, format_units, seed_from_password};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

pub(crate) fn ctx(state: &AppState) -> AptosCtx<'_> {
    AptosCtx {
        net_client: &state.net,
        tor: state.settings().tor.enabled,
        base: aptos_backend::default_url(state.network).to_owned(),
        chain_id: aptos_backend::chain_id_of(state.network),
    }
}

/// Address and public key of Aptos account `account` (`m/44'/637'/account'/0'/0'`).
fn ours(state: &AppState, account: u32) -> AppResult<(String, [u8; 32])> {
    state.with_seed(|seed| {
        Ok((
            wallet_core::aptos_address(seed, account)?,
            wallet_core::aptos_public_key(seed, account)?,
        ))
    })
}

fn apt(octas: &str) -> String {
    format!("{} APT", format_units(octas, 8))
}

/// Live context shown in the dialog.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AptosContext {
    pub account: AptosAccountInfo,
    /// The recipient has never received or sent anything (sequence 0 and no APT): the transfer
    /// creates its account.
    pub recipient_new: bool,
    /// Simulated gas units (the fee actually paid is about this × the gas price).
    pub gas_used: String,
    /// UNIX seconds of the ledger when read.
    pub ledger_time: u64,
}

/// Body of the native dialog.
pub(crate) fn describe_aptos(s: &AptosTxSummary, c: &AptosContext, net: Network) -> String {
    let mut out = format!(
        "Envoi Aptos{}\n\nÀ : {}\n(adresse sans somme de contrôle : compare-la en entier)\n\nMontant : {} ({} octas)\n",
        if net == Network::Testnet {
            " (testnet)"
        } else {
            ""
        },
        s.recipient,
        apt(&s.amount),
        s.amount
    );
    if c.recipient_new {
        out += "Ce compte n'a encore rien reçu : le transfert le crée (un peu plus de gaz).\n";
    }
    let gas_used: u64 = c.gas_used.parse().unwrap_or(0);
    let price: u64 = s.gas_unit_price.parse().unwrap_or(0);
    out += &format!(
        "\nFrais estimés : {} ({} unités de gaz simulées × {} octas)\nFrais maximum : {} ({} unités × {} octas)\nSolde : {}\n",
        apt(&gas_used.saturating_mul(price).to_string()),
        c.gas_used,
        s.gas_unit_price,
        apt(&s.max_fee),
        s.max_gas_amount,
        s.gas_unit_price,
        apt(&c.account.balance)
    );
    let left = s.expiration_timestamp_secs.saturating_sub(c.ledger_time);
    out += &format!(
        "\nFonction : {}\nSéquence {} · chaîne {} · expire dans {} min\n",
        s.function,
        s.sequence_number,
        s.chain_id,
        left.div_ceil(60)
    );
    out
}

pub(crate) fn describe_aptos_extra(s: &AptosTxSummary) -> String {
    let mut out = String::from("Kyro a trouvé des éléments inhabituels dans ce transfert :\n");
    for w in &s.warnings {
        out += match w {
            AptosWarning::SelfTransfer => "• le destinataire est ton propre compte\n",
            AptosWarning::HighFee => {
                "• frais maximum supérieurs à 0,02 APT (d'habitude environ 0,0001 APT)\n"
            }
        };
    }
    out += "\nNe signe que si tu sais exactement pourquoi. Signer quand même ?";
    out
}

// ---------------------------------------------------------------- reads

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AptosBackendInfo {
    pub network: &'static str,
    pub label: String,
    pub tor: bool,
}

#[tauri::command]
pub fn aptos_backend_info(state: State<'_, AppState>) -> AptosBackendInfo {
    let c = ctx(&state);
    AptosBackendInfo {
        network: crate::commands::network_name(state.network),
        label: crate::servers::host_of(&c.base).unwrap_or_default(),
        tor: c.tor,
    }
}

/// Address of Aptos account `account` (absent = 0).
#[tauri::command]
pub fn aptos_address(state: State<'_, AppState>, account: Option<u32>) -> AppResult<String> {
    Ok(ours(&state, account_arg(account)?)?.0)
}

#[tauri::command]
pub async fn aptos_account(
    state: State<'_, AppState>,
    address: String,
) -> AppResult<AptosAccountInfo> {
    let c = ctx(&state);
    aptos_backend::checked_ledger(&c).await?;
    aptos_backend::account(&c, &address).await
}

#[tauri::command]
pub async fn aptos_txs(state: State<'_, AppState>, address: String) -> AppResult<Value> {
    aptos_backend::txs(&ctx(&state), &address).await
}

// ---------------------------------------------------------------- build, sign, broadcast

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AptosBuilt {
    /// Unsigned `RawTransaction`, hex BCS: what `aptos_sign_tx` signs.
    pub raw: String,
    pub summary: AptosTxSummary,
    pub context: AptosContext,
}

async fn recipient_new(c: &AptosCtx<'_>, to: &str) -> AppResult<bool> {
    let r = aptos_backend::account(c, to).await?;
    Ok(r.sequence_number == "0" && r.balance == "0")
}

/// Builds an unsigned transfer of `amount` octas from live data.
pub(crate) async fn build(
    c: &AptosCtx<'_>,
    me: &str,
    pubkey: &[u8; 32],
    to: &str,
    amount: &str,
) -> AppResult<AptosBuilt> {
    let sender = wallet_core::aptos_parse_address(me)?;
    let recipient = wallet_core::aptos_parse_address(to)?;
    let amount: u64 = amount
        .trim()
        .parse()
        .ok()
        .filter(|a| *a > 0)
        .ok_or_else(|| AppError::InvalidInput("montant en octas invalide".into()))?;
    let ledger = aptos_backend::checked_ledger(c).await?;
    let account = aptos_backend::account(c, me).await?;
    // Key not rotated, amount within the balance (the fee is checked once simulated).
    aptos_backend::check_transfer(&account, amount, 0)?;
    let price = aptos_backend::gas_price(c).await?;
    let mut t = AptosTransfer {
        sender,
        sequence_number: account.sequence_number.parse().unwrap_or(0),
        recipient,
        amount,
        max_gas_amount: aptos_backend::MAX_MAX_GAS,
        gas_unit_price: price,
        expiration_timestamp_secs: ledger.timestamp_secs + aptos_backend::EXPIRATION_SECS,
        chain_id: c.chain_id,
    };
    // Simulation with the widest gas limit the balance allows, then the real limit.
    let balance: u64 = account.balance.parse().unwrap_or(0);
    let room = balance.saturating_sub(amount) / price;
    t.max_gas_amount = room.clamp(1, aptos_backend::MAX_MAX_GAS);
    let raw = hex::encode(t.encode()?);
    let (ok, vm_status, gas_used) =
        aptos_backend::simulate(c, wallet_core::aptos_simulation_bytes(&raw, pubkey)?).await?;
    if !ok {
        return Err(AppError::InvalidInput(format!(
            "la simulation du transfert échoue : {vm_status}{}",
            if vm_status.contains("INSUFFICIENT_BALANCE") || vm_status.contains("MAX_GAS_UNITS") {
                " (solde insuffisant pour le montant et les frais)"
            } else {
                ""
            }
        )));
    }
    t.max_gas_amount = aptos_backend::max_gas_for(gas_used)?;
    aptos_backend::check_transfer(&account, amount, t.max_fee())?;
    let raw = hex::encode(t.encode()?);
    let summary = wallet_core::aptos_decode_tx(&raw, me)?;
    Ok(AptosBuilt {
        raw,
        summary,
        context: AptosContext {
            account,
            recipient_new: recipient_new(c, to).await?,
            gas_used: gas_used.to_string(),
            ledger_time: ledger.timestamp_secs,
        },
    })
}

#[tauri::command]
pub async fn aptos_build_tx(
    state: State<'_, AppState>,
    to: String,
    amount: String,
    account: Option<u32>,
) -> AppResult<AptosBuilt> {
    let (me, pk) = ours(&state, account_arg(account)?)?;
    build(&ctx(&state), &me, &pk, &to, &amount).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AptosSigned {
    /// Signed transaction, hex BCS: what `aptos_broadcast` submits.
    pub signed: String,
    pub hash: String,
    pub summary: AptosTxSummary,
    pub context: AptosContext,
}

/// Decoding + live re-checks, i.e. everything `aptos_sign_tx` does before the dialog. The gas
/// figure shown is the build's simulation (`gas_used`, carried by the caller), bounded by the
/// maximum the user signs anyway.
pub(crate) async fn prepare_sign(
    c: &AptosCtx<'_>,
    me: &str,
    pubkey: &[u8; 32],
    raw: &str,
) -> AppResult<(AptosTxSummary, AptosContext)> {
    let summary = wallet_core::aptos_decode_tx(raw, me)?;
    if summary.chain_id != c.chain_id {
        return Err(AppError::InvalidInput(format!(
            "transaction pour la chaîne {}, pas pour celle de l'app ({})",
            summary.chain_id, c.chain_id
        )));
    }
    let ledger = aptos_backend::checked_ledger(c).await?;
    if summary.expiration_timestamp_secs
        < ledger.timestamp_secs + aptos_backend::MIN_REMAINING_SECS
    {
        return Err(AppError::InvalidInput(
            "transfert Aptos expiré ou sur le point de l'être : reconstruis-le".into(),
        ));
    }
    if summary.expiration_timestamp_secs
        > ledger.timestamp_secs + aptos_backend::EXPIRATION_SECS + 60
    {
        return Err(AppError::InvalidInput(
            "expiration trop lointaine : Kyro ne signe pas un transfert valable plus de 10 minutes"
                .into(),
        ));
    }
    let account = aptos_backend::account(c, me).await?;
    if summary.sequence_number != account.sequence_number {
        return Err(AppError::InvalidInput(
            "numéro de séquence périmé : reconstruis le transfert".into(),
        ));
    }
    let amount: u64 = summary.amount.parse().unwrap_or(u64::MAX);
    let max_fee: u64 = summary.max_fee.parse().unwrap_or(u64::MAX);
    aptos_backend::check_transfer(&account, amount, max_fee)?;
    let (ok, vm_status, gas_used) =
        aptos_backend::simulate(c, wallet_core::aptos_simulation_bytes(raw, pubkey)?).await?;
    if !ok {
        return Err(AppError::InvalidInput(format!(
            "la simulation du transfert échoue : {vm_status}"
        )));
    }
    let recipient_new = recipient_new(c, &summary.recipient).await?;
    Ok((
        summary,
        AptosContext {
            account,
            recipient_new,
            gas_used: gas_used.to_string(),
            ledger_time: ledger.timestamp_secs,
        },
    ))
}

#[tauri::command]
pub async fn aptos_sign_tx(
    app: AppHandle,
    state: State<'_, AppState>,
    raw: String,
    password: String,
    account: Option<u32>,
) -> AppResult<AptosSigned> {
    if !state.is_unlocked() {
        return Err(AppError::Locked);
    }
    let a = account_arg(account)?;
    let (me, pk) = ours(&state, a)?;
    let signer = SignerInfo::new(&state, Chain::Apt, a, wallet_core::aptos_path(a));
    let c = ctx(&state);
    let (summary, context) = prepare_sign(&c, &me, &pk, &raw).await?;
    let seed = seed_from_password(&state, Zeroizing::new(password)).await?;
    confirm_native(
        &app,
        "Confirmer l'envoi d'APT",
        signer.body(&describe_aptos(&summary, &context, state.network)),
    )
    .await?;
    confirm_signer(&app, &signer).await?;
    if summary.requires_extra_confirmation {
        confirm_native(
            &app,
            "Attention : transfert à vérifier",
            describe_aptos_extra(&summary),
        )
        .await?;
    }
    let r = raw.clone();
    let (signed, hash, again) = blocking(move || Ok(wallet_core::aptos_sign(&seed, a, &r)?)).await?;
    if again != summary {
        return Err(AppError::Internal(
            "résumé différent entre l'aperçu et la signature".into(),
        ));
    }
    state.touch();
    Ok(AptosSigned {
        signed,
        hash,
        summary,
        context,
    })
}

/// Checks the signed transaction (decodes, single ed25519 signature by our key, right chain)
/// then submits it.
pub(crate) async fn broadcast_checked(
    c: &AptosCtx<'_>,
    me: &str,
    signed: &str,
) -> AppResult<String> {
    let (hash, t) = wallet_core::aptos_verify_signed(signed)?;
    if t.sender != wallet_core::aptos_parse_address(me)? {
        return Err(AppError::InvalidInput(
            "ce transfert n'est pas signé par ton compte".into(),
        ));
    }
    if t.chain_id != c.chain_id {
        return Err(AppError::InvalidInput(
            "transfert signé pour une autre chaîne".into(),
        ));
    }
    let bytes = hex::decode(signed.trim().trim_start_matches("0x"))
        .map_err(|_| AppError::InvalidInput("transaction : hexadécimal attendu".into()))?;
    aptos_backend::submit(c, bytes, &hash).await
}

#[tauri::command]
pub async fn aptos_broadcast(
    state: State<'_, AppState>,
    signed: String,
    account: Option<u32>,
) -> AppResult<String> {
    let (me, _) = ours(&state, account_arg(account)?)?;
    broadcast_checked(&ctx(&state), &me, &signed).await
}

/// `{ committed, success, vmStatus }` of a submitted transaction.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AptosTxStatus {
    pub committed: bool,
    pub success: bool,
    pub vm_status: String,
}

#[tauri::command]
pub async fn aptos_tx_status(state: State<'_, AppState>, hash: String) -> AppResult<AptosTxStatus> {
    let h = hash.trim().to_ascii_lowercase();
    let hex_part = h.strip_prefix("0x").unwrap_or(&h);
    if hex_part.len() != 64 || !hex_part.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(AppError::InvalidInput(
            "hash : 0x suivi de 64 caractères hexadécimaux".into(),
        ));
    }
    let (committed, success, vm_status) =
        aptos_backend::tx_status(&ctx(&state), &format!("0x{hex_part}")).await?;
    Ok(AptosTxStatus {
        committed,
        success,
        vm_status,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summary() -> AptosTxSummary {
        AptosTxSummary {
            sender: format!("0x{}", "11".repeat(32)),
            recipient: "0x726c91e2852985c2a8c16f32a64c131bd2a0fd1e0aa985a1e0e6002407506ac0".into(),
            function: "0x1::aptos_account::transfer".into(),
            amount: "150000000".into(),
            sequence_number: "7".into(),
            max_gas_amount: "200".into(),
            gas_unit_price: "100".into(),
            max_fee: "20000".into(),
            expiration_timestamp_secs: 1_000_600,
            chain_id: 2,
            warnings: vec![],
            requires_extra_confirmation: false,
        }
    }

    fn context(new: bool) -> AptosContext {
        AptosContext {
            account: AptosAccountInfo {
                balance: "500000000".into(),
                ..Default::default()
            },
            recipient_new: new,
            gas_used: "11".into(),
            ledger_time: 1_000_000,
        }
    }

    #[test]
    fn dialog_shows_what_rust_decoded() {
        let d = describe_aptos(&summary(), &context(false), Network::Testnet);
        for needle in [
            "Envoi Aptos (testnet)",
            "À : 0x726c91e2852985c2a8c16f32a64c131bd2a0fd1e0aa985a1e0e6002407506ac0\n",
            "Montant : 1,5 APT (150000000 octas)",
            "Frais estimés : 0,000011 APT (11 unités de gaz simulées × 100 octas)",
            "Frais maximum : 0,0002 APT (200 unités × 100 octas)",
            "Solde : 5 APT",
            "Fonction : 0x1::aptos_account::transfer",
            "Séquence 7 · chaîne 2 · expire dans 10 min",
        ] {
            assert!(d.contains(needle), "{needle} missing in:\n{d}");
        }
        assert!(!d.contains("le transfert le crée"));
        let d = describe_aptos(&summary(), &context(true), Network::Mainnet);
        assert!(d.starts_with("Envoi Aptos\n"));
        assert!(d.contains("le transfert le crée"));
        let mut s = summary();
        s.warnings = vec![AptosWarning::SelfTransfer, AptosWarning::HighFee];
        let x = describe_aptos_extra(&s);
        assert!(x.contains("ton propre compte") && x.contains("0,02 APT"));
    }
}

/// Real-network test over Tor. Run with
/// `cargo test -p kyro-desktop -- --ignored --nocapture aptos_live`.
/// - reads: testnet and mainnet ledgers (chain ids 2 / 1), a mainnet account, history;
/// - `KYRO_APTOS_SEND=yes`: on **devnet** (the testnet faucet needs a sign-in; devnet's is
///   open), a NEW random test mnemonic kept in the gitignored `.env.aptos-devnet` at the
///   repository root is funded by the devnet faucet, then one transfer to account 1 (a new
///   account) goes through the real path (build with simulation, live checks, dialog text,
///   signature with identical summary, submission, hash check, committed and successful).
#[cfg(test)]
mod live {
    use super::*;
    use crate::net::{Family, NetClient, ServerRequest};
    use crate::tor::TorState;

    fn test_seed() -> wallet_core::Seed {
        let path =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../.env.aptos-devnet");
        let words = match std::fs::read_to_string(&path) {
            Ok(s) => s
                .lines()
                .find_map(|l| l.strip_prefix("KYRO_APTOS_TEST_MNEMONIC="))
                .expect("mnemonic line")
                .trim()
                .to_owned(),
            Err(_) => {
                let m = wallet_core::Mnemonic::generate(wallet_core::WordCount::W12).unwrap();
                let w = m.words().join(" ");
                std::fs::write(
                    &path,
                    format!("# APTOS DEVNET ONLY — random test mnemonic generated by Kyro's live test (commands_aptos.rs).\n# Never use it for real funds. This file is gitignored (.env.*).\nKYRO_APTOS_TEST_MNEMONIC={w}\n"),
                )
                .unwrap();
                eprintln!("new test mnemonic written to {}", path.display());
                w
            }
        };
        wallet_core::Mnemonic::parse(&words).unwrap().to_seed("")
    }

    #[test]
    #[ignore]
    fn aptos_live_over_tor() {
        let net = NetClient::new(std::env::temp_dir().join("kyro-aptos-live")).unwrap();
        let tor = std::env::var("KYRO_APTOS_CLEAR").as_deref() != Ok("yes");
        tauri::async_runtime::block_on(async {
            if tor {
                net.tor.restart();
                while net.tor.status().state != TorState::Ready {
                    assert_ne!(net.tor.status().state, TorState::Error);
                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                }
            }
            let mk = |network: Network| AptosCtx {
                net_client: &net,
                tor,
                base: aptos_backend::default_url(network).to_owned(),
                chain_id: aptos_backend::chain_id_of(network),
            };
            let testnet = mk(Network::Testnet);
            let mainnet = mk(Network::Mainnet);
            let t = std::time::Instant::now();
            eprintln!(
                "testnet probe {:?} in {:.1?}",
                aptos_backend::probe(&testnet).await,
                t.elapsed()
            );
            eprintln!("mainnet probe {:?}", aptos_backend::probe(&mainnet).await);
            let wrong = AptosCtx {
                chain_id: 2,
                ..mk(Network::Mainnet)
            };
            let e = aptos_backend::probe(&wrong).await;
            eprintln!("wrong network: {e:?}");
            assert!(matches!(e, Err(AppError::ServerWrongNetwork(_))));
            let busy = "0x19fc2203cda87b3d8e19bb90b867506bb2db30a0fb1771fd9e595c17d8de0789";
            eprintln!("mainnet account {:?}", aptos_backend::account(&mainnet, busy).await);
            eprintln!("mainnet gas price {:?}", aptos_backend::gas_price(&mainnet).await);
            let h = aptos_backend::txs(&mainnet, busy).await.unwrap();
            eprintln!(
                "mainnet history: {} entries, first {}",
                h.as_array().unwrap().len(),
                h[0]
            );

            if std::env::var("KYRO_APTOS_SEND").as_deref() != Ok("yes") {
                eprintln!("KYRO_APTOS_SEND != yes: no transfer");
                return;
            }
            let seed = test_seed();
            let me = wallet_core::aptos_address(&seed, 0).unwrap();
            let pk = wallet_core::aptos_public_key(&seed, 0).unwrap();
            let to = wallet_core::aptos_address(&seed, 1).unwrap();
            let mut dev = AptosCtx {
                net_client: &net,
                tor,
                base: "https://api.devnet.aptoslabs.com/v1".into(),
                chain_id: 0,
            };
            dev.chain_id = aptos_backend::ledger(&dev).await.unwrap().chain_id;
            eprintln!("devnet chain id {} — {me} → {to}", dev.chain_id);
            let mut acc = aptos_backend::account(&dev, &me).await.unwrap();
            if acc.balance.parse::<u64>().unwrap() < 20_000_000 {
                let req = ServerRequest::post_bytes(
                    url::Url::parse(&format!(
                        "https://faucet.devnet.aptoslabs.com/mint?amount=100000000&address={me}"
                    ))
                    .unwrap(),
                    Family::Aptos,
                    "application/json",
                    Vec::new(),
                );
                let (status, body) = net.server_request(req, tor).await.unwrap();
                eprintln!("faucet: HTTP {status} {}", String::from_utf8_lossy(&body));
                for _ in 0..30 {
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                    acc = aptos_backend::account(&dev, &me).await.unwrap();
                    if acc.balance != "0" {
                        break;
                    }
                }
            }
            eprintln!("account {acc:?}");
            // More than the balance: refused before anything is signed.
            let r = build(&dev, &me, &pk, &to, &acc.balance).await;
            eprintln!("whole balance (no room for gas): {:?}", r.as_ref().err());
            assert!(matches!(r, Err(AppError::InvalidInput(_))));

            let before: u64 = aptos_backend::account(&dev, &to).await.unwrap().balance.parse().unwrap();
            let built = build(&dev, &me, &pk, &to, "1234567").await.unwrap();
            let (summary, context) = prepare_sign(&dev, &me, &pk, &built.raw).await.unwrap();
            assert_eq!(summary, built.summary);
            eprintln!(
                "--- dialog ---\n{}---",
                describe_aptos(&summary, &context, Network::Testnet)
            );
            let (signed, hash, again) = wallet_core::aptos_sign(&seed, 0, &built.raw).unwrap();
            assert_eq!(again, summary, "identical summary");
            let got = broadcast_checked(&dev, &me, &signed).await.unwrap();
            assert_eq!(got, hash);
            eprintln!("SUBMITTED {hash}");
            for _ in 0..30 {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                let (committed, success, vm) = aptos_backend::tx_status(&dev, &hash).await.unwrap();
                if committed {
                    eprintln!("committed: success={success} {vm}");
                    assert!(success);
                    let r = aptos_backend::account(&dev, &to).await.unwrap();
                    eprintln!("recipient now {r:?}");
                    assert_eq!(r.balance.parse::<u64>().unwrap(), before + 1_234_567);
                    eprintln!("history: {}", aptos_backend::txs(&dev, &me).await.unwrap());
                    return;
                }
            }
            panic!("{hash} not committed");
        });
    }
}
