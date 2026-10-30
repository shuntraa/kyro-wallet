//! Hardware-wallet commands (docs/IPC.md §2.3).
//!
//! Signing is always: decode in Rust → Kyro's native summary dialog (plus a reinforced second
//! dialog when something is unknown or the device cannot show the details) → the device's own
//! confirmation → independent verification of what the device returned (signature against the
//! key derived from the stored xpub and the sighash/hash computed here). Before any signature
//! or address display, the device's keys are compared with the stored account
//! (`HW_WRONG_DEVICE`), and a displayed address must equal Kyro's own derivation
//! (`HW_ADDRESS_MISMATCH`).

use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use wallet_core::{
    BtcAccount, BtcKind, EvmTxKind, EvmTxRequest, HwDeviceKind, WatchEvm, WatchOnlyAccount,
    WatchSol, Zeroizing, EVM_NODE_PATH, MAX_HW_ACCOUNT,
};

use crate::commands::{confirm_native, describe_btc, describe_evm, TokenHint};
use crate::error::{AppError, AppResult};
use crate::hw::{
    self, path_string, store, BtcSignRequest, Chain, DeviceInfo, DeviceStatus, EvmSignRequest,
    HwError, PromptFn, H,
};
use crate::solana;
use crate::state::AppState;

const T_LIST: Duration = Duration::from_secs(10);
/// Reading keys may include the Trezor PIN typed on the device.
const T_READ: Duration = Duration::from_secs(90);
/// Anything the user must confirm on the device.
const T_CONFIRM: Duration = Duration::from_secs(180);
/// Receive + change addresses scanned to flag change in the native summary.
const OWN_ADDRESS_GAP: u32 = 20;

fn prompt_fn(app: &AppHandle, id: &str) -> PromptFn {
    let app = app.clone();
    let id = id.to_string();
    Arc::new(move |kind| {
        let _ = app.emit("hw-prompt", serde_json::json!({ "id": id, "kind": kind }));
    })
}

/// With a vault on this computer, hardware-wallet operations need the unlocked session
/// (same lock screen as the rest of the app). Hardware-only users have no vault.
fn guard(state: &AppState) -> AppResult<()> {
    if state.vault_exists() && !state.is_unlocked() {
        return Err(AppError::Locked);
    }
    Ok(())
}

fn check_account_number(account: u32) -> AppResult<()> {
    if account > MAX_HW_ACCOUNT {
        return Err(AppError::InvalidInput(format!(
            "numéro de compte : 0 à {MAX_HW_ACCOUNT}"
        )));
    }
    Ok(())
}

fn not_yet(chain: Chain) -> AppError {
    AppError::HwUnsupported {
        what: format!(
            "{} : pas encore pris en charge par Kyro (phase 4)",
            chain.label()
        ),
        min: None,
    }
}

fn load_account(state: &AppState, account_id: &str) -> AppResult<WatchOnlyAccount> {
    let s = store::load(&state.hw_accounts_path, state.network)?;
    store::find(&s, account_id)
}

/// The stored account must be for the brand of device `id`.
fn check_brand(info: &DeviceInfo, acc: &WatchOnlyAccount) -> AppResult<()> {
    if info.kind != acc.device {
        return Err(AppError::HwWrongDevice);
    }
    Ok(())
}

fn device_line(info: &DeviceInfo) -> String {
    let brand = match info.kind {
        HwDeviceKind::Ledger => "Ledger",
        HwDeviceKind::Trezor => "Trezor",
    };
    format!(
        "\n\n— Appareil : {brand} {} —\nAprès « Signer », vérifie les MÊMES informations sur l'écran de \
         l'appareil et confirme-les là-bas. S'il affiche autre chose, refuse sur l'appareil.",
        info.model
    )
}

// ---------------------------------------------------------------- discovery

#[tauri::command]
pub async fn hw_list(app: AppHandle) -> AppResult<Vec<DeviceInfo>> {
    let h = app.clone();
    let task = tauri::async_runtime::spawn_blocking(move || h.state::<AppState>().hw.list());
    match tokio::time::timeout(T_LIST, task).await {
        Ok(Ok(list)) => Ok(list),
        Ok(Err(e)) => Err(AppError::Internal(e.to_string())),
        Err(_) => Err(AppError::HwTimeout),
    }
}

#[tauri::command]
pub async fn hw_open(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> AppResult<DeviceStatus> {
    let net = state.network;
    let mut st = state
        .hw
        .run(&id, T_READ, prompt_fn(&app, &id), move |dev, ctl| {
            dev.status(ctl, net)
        })
        .await?;
    st.id = id;
    Ok(st)
}

#[tauri::command]
pub fn hw_cancel(state: State<'_, AppState>, id: String) -> AppResult<bool> {
    Ok(state.hw.cancel(&id)?)
}

/// Trezor One PIN matrix: `positions` are digits 1–9 = cells of the 3×3 grid (numbered like a
/// phone keypad from the top-left as the UI draws it), never the PIN digits themselves.
#[tauri::command]
pub fn hw_pin_matrix(state: State<'_, AppState>, id: String, positions: String) -> AppResult<()> {
    let positions = Zeroizing::new(positions);
    if positions.is_empty()
        || positions.len() > 50
        || !positions.bytes().all(|b| (b'1'..=b'9').contains(&b))
    {
        return Err(AppError::InvalidInput("positions : chiffres 1 à 9".into()));
    }
    Ok(state.hw.submit_pin(&id, positions)?)
}

// ---------------------------------------------------------------- keys

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HwEvmKey {
    xpub: String,
    path: String,
    address: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HwSolKey {
    address: String,
    path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HwXpub {
    chain: Chain,
    account: u32,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    btc: Vec<BtcAccount>,
    #[serde(skip_serializing_if = "Option::is_none")]
    evm: Option<HwEvmKey>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sol: Option<HwSolKey>,
}

async fn read_keys(
    app: &AppHandle,
    state: &AppState,
    id: &str,
    chain: Chain,
    account: u32,
) -> AppResult<HwXpub> {
    check_account_number(account)?;
    if !chain.implemented() {
        return Err(not_yet(chain));
    }
    let net = state.network;
    let out = state
        .hw
        .run(id, T_READ, prompt_fn(app, id), move |dev, ctl| {
            let mut out = HwXpub {
                chain,
                account,
                btc: Vec::new(),
                evm: None,
                sol: None,
            };
            match chain {
                Chain::Btc => {
                    for kind in [BtcKind::Segwit, BtcKind::Taproot] {
                        out.btc.push(dev.btc_account(ctl, net, kind, account)?);
                    }
                    if out.btc[0].fingerprint != out.btc[1].fingerprint {
                        return Err(HwError::bad("empreintes maîtres différentes"));
                    }
                }
                Chain::Evm => {
                    let xpub = dev.evm_node(ctl)?;
                    let address = wallet_core::evm_address_from_xpub(&xpub, account)
                        .map_err(|e| HwError::bad(e.to_string()))?;
                    // The device's own address for that index must agree with the node.
                    if dev.evm_address(ctl, account, false)? != address {
                        return Err(HwError::bad("adresse et nœud EVM incohérents"));
                    }
                    out.evm = Some(HwEvmKey {
                        xpub,
                        path: EVM_NODE_PATH.into(),
                        address,
                    });
                }
                Chain::Sol => {
                    out.sol = Some(HwSolKey {
                        address: dev.sol_address(ctl, account, false)?,
                        path: wallet_core::sol_path(account),
                    });
                }
                other => return Err(HwError::unsupported(other.label())),
            }
            Ok(out)
        })
        .await?;
    // Every xpub must be well-formed for this network before it leaves Rust.
    wallet_core::btc_hw_own_addresses(net, &out.btc, 1)?;
    Ok(out)
}

#[tauri::command]
pub async fn hw_get_xpub(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    chain: Chain,
    account: u32,
) -> AppResult<HwXpub> {
    guard(&state)?;
    read_keys(&app, &state, &id, chain, account).await
}

// ---------------------------------------------------------------- watch-only accounts

#[tauri::command]
pub fn hw_accounts_get(state: State<'_, AppState>) -> AppResult<Vec<WatchOnlyAccount>> {
    Ok(store::load(&state.hw_accounts_path, state.network)?.accounts)
}

/// Reads the keys of `chain` from device `id` and stores them as a watch-only account, new or
/// merged into `accountId` (same brand, same account number, same master fingerprint).
#[tauri::command]
pub async fn hw_account_add(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    chain: Chain,
    account: u32,
    account_id: Option<String>,
    label: Option<String>,
) -> AppResult<WatchOnlyAccount> {
    guard(&state)?;
    let info = state.hw.info(&id)?;
    let keys = read_keys(&app, &state, &id, chain, account).await?;
    let _write = hw::lock(&state.hw_store_lock);
    let mut s = store::load(&state.hw_accounts_path, state.network)?;
    let mut acc = match &account_id {
        Some(aid) => {
            let acc = store::find(&s, aid)?;
            check_brand(&info, &acc)?;
            if acc.account != account {
                return Err(AppError::InvalidInput(
                    "numéro de compte différent de celui du compte existant".into(),
                ));
            }
            acc
        }
        None => WatchOnlyAccount {
            id: store::new_id(&s),
            label: String::new(),
            device: info.kind,
            model: info.model.clone(),
            network: state.network,
            account,
            btc: Vec::new(),
            evm: None,
            sol: None,
        },
    };
    if let Some(l) = label {
        acc.label = l.trim().to_string();
    }
    if acc.label.is_empty() {
        acc.label = format!("{} {}", info.model, account + 1);
    }
    if !keys.btc.is_empty() {
        if let Some(fp) = acc.fingerprint() {
            if fp != keys.btc[0].fingerprint {
                return Err(AppError::HwWrongDevice);
            }
        }
        acc.btc = keys.btc;
    }
    if let Some(e) = keys.evm {
        acc.evm = Some(WatchEvm {
            xpub: e.xpub,
            path: e.path,
        });
    }
    if let Some(sol) = keys.sol {
        acc.sol = Some(WatchSol {
            address: sol.address,
            path: sol.path,
        });
    }
    acc.validate()?;
    s.accounts.retain(|a| a.id != acc.id);
    s.accounts.push(acc.clone());
    store::save(&state.hw_accounts_path, &s, state.network)?;
    Ok(acc)
}

#[tauri::command]
pub fn hw_account_remove(state: State<'_, AppState>, account_id: String) -> AppResult<()> {
    guard(&state)?;
    let _write = hw::lock(&state.hw_store_lock);
    let mut s = store::load(&state.hw_accounts_path, state.network)?;
    let before = s.accounts.len();
    s.accounts.retain(|a| a.id != account_id);
    if s.accounts.len() == before {
        return Err(AppError::InvalidInput(
            "compte hardware wallet inconnu".into(),
        ));
    }
    store::save(&state.hw_accounts_path, &s, state.network)
}

// ---------------------------------------------------------------- address verification

/// `m/a'/b'/…` → raw indices.
pub fn parse_path(path: &str) -> AppResult<Vec<u32>> {
    let bad = || AppError::InvalidInput(format!("chemin de dérivation invalide : {path}"));
    let rest = path.trim().strip_prefix("m/").ok_or_else(bad)?;
    let mut out = Vec::new();
    for part in rest.split('/') {
        let (num, hardened) = match part.strip_suffix(['\'', 'h']) {
            Some(n) => (n, true),
            None => (part, false),
        };
        if num.is_empty() || num.len() > 10 || !num.bytes().all(|b| b.is_ascii_digit()) {
            return Err(bad());
        }
        let v: u32 = num.parse().map_err(|_| bad())?;
        if v >= H {
            return Err(bad());
        }
        out.push(if hardened { v | H } else { v });
    }
    if out.is_empty() || out.len() > 10 {
        return Err(bad());
    }
    Ok(out)
}

/// What to show on the device for `path`, and what Kyro expects it to be.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    Btc {
        account: BtcAccount,
        change: bool,
        index: u32,
    },
    Evm {
        index: u32,
    },
    Sol,
}

/// Resolves `path` against the stored account; returns the target and Kyro's own address.
pub fn resolve_target(
    acc: &WatchOnlyAccount,
    chain: Chain,
    path: &[u32],
) -> AppResult<(Target, String)> {
    let wrong =
        || AppError::InvalidInput("ce chemin n'appartient pas à ce compte hardware wallet".into());
    match chain {
        Chain::Btc => {
            let [purpose, coin, account, change, index] = path else {
                return Err(wrong());
            };
            let kind = match *purpose {
                p if p == 84 | H => BtcKind::Segwit,
                p if p == 86 | H => BtcKind::Taproot,
                _ => return Err(wrong()),
            };
            let stored = acc.btc_account(kind).ok_or_else(wrong)?;
            if path_string(&[*purpose, *coin, *account]) != stored.path
                || *change > 1
                || *index >= H
            {
                return Err(wrong());
            }
            let expected = wallet_core::btc_address_from_xpub(
                &stored.xpub,
                acc.network,
                kind,
                *change == 1,
                *index,
            )?;
            Ok((
                Target::Btc {
                    account: stored.clone(),
                    change: *change == 1,
                    index: *index,
                },
                expected,
            ))
        }
        Chain::Evm => {
            let evm = acc.evm.as_ref().ok_or_else(wrong)?;
            match path {
                [a, b, c, d, index] if [*a, *b, *c, *d] == [44 | H, 60 | H, H, 0] && *index < H => {
                    let expected = wallet_core::evm_address_from_xpub(&evm.xpub, *index)?;
                    Ok((Target::Evm { index: *index }, expected))
                }
                _ => Err(wrong()),
            }
        }
        Chain::Sol => {
            let sol = acc.sol.as_ref().ok_or_else(wrong)?;
            if path != hw::sol_path(acc.account) {
                return Err(wrong());
            }
            Ok((Target::Sol, sol.address.clone()))
        }
        other => Err(not_yet(other)),
    }
}

/// Re-reads the device's keys and compares them with the stored account.
fn same_device(
    dev: &mut dyn hw::HardwareWallet,
    ctl: &hw::Ctl,
    acc: &WatchOnlyAccount,
    chain: Chain,
    kinds: &[BtcKind],
) -> Result<bool, HwError> {
    let net = acc.network;
    Ok(match chain {
        Chain::Btc => {
            for kind in kinds {
                let Some(stored) = acc.btc_account(*kind) else {
                    return Ok(false);
                };
                let live = dev.btc_account(ctl, net, *kind, acc.account)?;
                if live.xpub != stored.xpub || live.fingerprint != stored.fingerprint {
                    return Ok(false);
                }
            }
            true
        }
        Chain::Evm => match &acc.evm {
            Some(e) => {
                let expected = wallet_core::evm_address_from_xpub(&e.xpub, acc.account)
                    .map_err(|e| HwError::bad(e.to_string()))?;
                dev.evm_address(ctl, acc.account, false)? == expected
            }
            None => false,
        },
        Chain::Sol => match &acc.sol {
            Some(s) => dev.sol_address(ctl, acc.account, false)? == s.address,
            None => false,
        },
        _ => false,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedAddress {
    address: String,
    path: String,
}

#[tauri::command]
pub async fn hw_verify_address(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    account_id: String,
    chain: Chain,
    path: String,
) -> AppResult<VerifiedAddress> {
    guard(&state)?;
    let acc = load_account(&state, &account_id)?;
    let info = state.hw.info(&id)?;
    check_brand(&info, &acc)?;
    let raw = parse_path(&path)?;
    let (target, expected) = resolve_target(&acc, chain, &raw)?;
    let kinds: Vec<BtcKind> = match &target {
        Target::Btc { account, .. } => vec![account.kind],
        _ => Vec::new(),
    };
    let acc2 = acc.clone();
    let shown = state
        .hw
        .run(&id, T_CONFIRM, prompt_fn(&app, &id), move |dev, ctl| {
            if !same_device(dev, ctl, &acc2, chain, &kinds)? {
                return Ok(None);
            }
            let net = acc2.network;
            Ok(Some(match &target {
                Target::Btc {
                    account,
                    change,
                    index,
                } => dev.btc_display_address(ctl, net, account, *change, *index)?,
                Target::Evm { index } => dev.evm_address(ctl, *index, true)?,
                Target::Sol => dev.sol_address(ctl, acc2.account, true)?,
            }))
        })
        .await?
        .ok_or(AppError::HwWrongDevice)?;
    let equal = match chain {
        Chain::Evm => shown.eq_ignore_ascii_case(&expected),
        _ => shown == expected,
    };
    if !equal {
        return Err(AppError::HwAddressMismatch {
            device: shown,
            expected,
        });
    }
    Ok(VerifiedAddress {
        address: expected,
        path: path_string(&raw),
    })
}

// ---------------------------------------------------------------- signing

#[derive(Serialize)]
pub struct HwBtcSigned {
    psbt: String,
    summary: wallet_core::BtcTxSummary,
}

fn has_unknown_output(s: &wallet_core::BtcTxSummary) -> bool {
    s.outputs
        .iter()
        .any(|(a, _, _)| a.starts_with("script:") || a.starts_with("op_return:"))
}

#[tauri::command]
pub async fn hw_sign_btc_psbt(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    account_id: String,
    psbt: String,
) -> AppResult<HwBtcSigned> {
    guard(&state)?;
    let net = state.network;
    let acc = load_account(&state, &account_id)?;
    let info = state.hw.info(&id)?;
    check_brand(&info, &acc)?;
    if acc.btc.is_empty() {
        return Err(AppError::InvalidInput(
            "ce compte n'a pas de clés Bitcoin".into(),
        ));
    }
    let plan = wallet_core::btc_hw_plan(net, &psbt, &acc.btc)?;
    if !plan.external_inputs.is_empty() {
        return Err(AppError::HwUnsupported {
            what: "transaction avec des entrées qui n'appartiennent pas à ce compte".into(),
            min: None,
        });
    }
    if let Some(i) = plan
        .inputs
        .iter()
        .find(|i| i.kind == BtcKind::Segwit && !i.has_prev_tx)
    {
        return Err(AppError::InvalidInput(format!(
            "la PSBT doit inclure la transaction précédente (non_witness_utxo) de l'entrée {} \
             pour une signature sur hardware wallet",
            i.index
        )));
    }
    // Same change flags as the address-based decoder (sanity check of the plan).
    let own = wallet_core::btc_hw_own_addresses(net, &acc.btc, OWN_ADDRESS_GAP)?;
    let decoded = wallet_core::btc_decode_psbt(net, &psbt, &own)?;
    if decoded.fee_sats != plan.summary.fee_sats
        || decoded.outputs.len() != plan.summary.outputs.len()
    {
        return Err(AppError::Internal("décodages PSBT incohérents".into()));
    }
    let mut kinds: Vec<BtcKind> = plan.inputs.iter().map(|i| i.kind).collect();
    kinds.dedup();

    // 1. Is this the right device? (before asking the user anything)
    let (acc2, kinds2) = (acc.clone(), kinds.clone());
    let same = state
        .hw
        .run(&id, T_READ, prompt_fn(&app, &id), move |dev, ctl| {
            same_device(dev, ctl, &acc2, Chain::Btc, &kinds2)
        })
        .await?;
    if !same {
        return Err(AppError::HwWrongDevice);
    }
    // 2. Kyro's own decoded summary, in a native dialog.
    let summary = plan.summary.clone();
    confirm_native(
        &app,
        "Confirmer la transaction (hardware wallet)",
        describe_btc(&summary) + &device_line(&info),
    )
    .await?;
    if has_unknown_output(&summary) {
        confirm_native(
            &app,
            "Attention : sortie inconnue",
            "Cette transaction contient une sortie que Kyro ne sait pas décoder (script \
             « inconnu » ou OP_RETURN). Ne continue que si tu sais exactement pourquoi."
                .into(),
        )
        .await?;
    }
    // 3. The device.
    let parsed = bitcoin::psbt::Psbt::from_str(psbt.trim())
        .map_err(|_| AppError::InvalidInput("PSBT invalide".into()))?;
    let accounts = acc.btc.clone();
    let plan2 = plan.clone();
    let sigs = state
        .hw
        .run(&id, T_CONFIRM, prompt_fn(&app, &id), move |dev, ctl| {
            let req = BtcSignRequest {
                psbt: &parsed,
                plan: &plan2,
                accounts: &accounts,
            };
            dev.btc_sign(ctl, net, &req)
        })
        .await?;
    // 4. Never trust the device: every signature is verified before returning.
    let (signed, summary) = wallet_core::btc_hw_finalize(net, &psbt, &acc.btc, &sigs)?;
    state.touch();
    Ok(HwBtcSigned {
        psbt: signed,
        summary,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HwEvmSigned {
    raw_tx: String,
    hash: String,
}

#[tauri::command]
pub async fn hw_sign_evm_tx(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    account_id: String,
    tx: EvmTxRequest,
    token: Option<TokenHint>,
) -> AppResult<HwEvmSigned> {
    guard(&state)?;
    let acc = load_account(&state, &account_id)?;
    let info = state.hw.info(&id)?;
    check_brand(&info, &acc)?;
    let expected = acc
        .evm_address()?
        .ok_or_else(|| AppError::InvalidInput("ce compte n'a pas de clé EVM".into()))?;
    let summary = wallet_core::evm_decode(&tx)?;
    let descriptor = match (info.kind, summary.kind, summary.token_contract.as_deref()) {
        (
            HwDeviceKind::Ledger,
            EvmTxKind::Erc20Transfer | EvmTxKind::Erc20Approve,
            Some(contract),
        ) => wallet_core::ledger_erc20_lookup(tx.chain_id, contract)
            .filter(|d| wallet_core::ledger_erc20_verify(d).is_ok()),
        _ => None,
    };
    // A Ledger-signed descriptor is a trusted symbol/decimals source; the UI hint is not.
    let hint = descriptor
        .as_ref()
        .map(|d| TokenHint {
            symbol: d.ticker.clone(),
            decimals: d.decimals,
        })
        .or(token);

    let acc2 = acc.clone();
    let (kind, has_desc) = (summary.kind, descriptor.is_some());
    let (same, clear) = state
        .hw
        .run(&id, T_READ, prompt_fn(&app, &id), move |dev, ctl| {
            let same = same_device(dev, ctl, &acc2, Chain::Evm, &[])?;
            Ok((same, dev.evm_clear_signs(kind, has_desc)))
        })
        .await?;
    if !same {
        return Err(AppError::HwWrongDevice);
    }
    confirm_native(
        &app,
        "Confirmer la transaction (hardware wallet)",
        describe_evm(&summary, hint.as_ref()) + &device_line(&info),
    )
    .await?;
    if !clear || summary.kind == EvmTxKind::ContractCall {
        let mut body = String::new();
        if summary.kind == EvmTxKind::ContractCall {
            body +=
                "Appel de contrat : action « inconnue », Kyro ne peut pas en décoder l'effet.\n\n";
        }
        if !clear {
            body += "Ton appareil ne pourra PAS afficher le détail de cette transaction \
                     (blind signing : il ne montrera que des données brutes ou une empreinte). \
                     Seul le résumé de Kyro ci-dessus décrit ce que tu signes.\n\n";
        }
        body += "Ne continue que si tu fais confiance au destinataire et au contrat.";
        confirm_native(&app, "Attention : vérification limitée", body).await?;
    }
    let index = acc.account;
    let tx2 = tx.clone();
    let (r, s) = state
        .hw
        .run(&id, T_CONFIRM, prompt_fn(&app, &id), move |dev, ctl| {
            dev.evm_sign(
                ctl,
                &EvmSignRequest {
                    tx: &tx2,
                    index,
                    token: descriptor.as_ref(),
                },
            )
        })
        .await?;
    let (raw_tx, hash) = wallet_core::evm_hw_finalize(&tx, &r, &s, &expected)?;
    state.touch();
    Ok(HwEvmSigned { raw_tx, hash })
}

#[derive(Serialize)]
pub struct HwSolSigned {
    signature: String,
    summary: wallet_core::SolTxSummary,
}

#[tauri::command]
pub async fn hw_sign_sol_tx(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    account_id: String,
    message: String,
) -> AppResult<HwSolSigned> {
    guard(&state)?;
    let acc = load_account(&state, &account_id)?;
    let info = state.hw.info(&id)?;
    check_brand(&info, &acc)?;
    let me = acc
        .sol
        .as_ref()
        .map(|s| s.address.clone())
        .ok_or_else(|| AppError::InvalidInput("ce compte n'a pas de clé Solana".into()))?;
    let bytes = solana::message_bytes(&message)?;
    let summary = solana::decode(&state, &bytes, &me).await?;
    if summary.our_signer_index.is_none() {
        return Err(AppError::InvalidInput(
            "cette transaction ne demande pas la signature de cette adresse Solana".into(),
        ));
    }
    let acc2 = acc.clone();
    let same = state
        .hw
        .run(&id, T_READ, prompt_fn(&app, &id), move |dev, ctl| {
            same_device(dev, ctl, &acc2, Chain::Sol, &[])
        })
        .await?;
    if !same {
        return Err(AppError::HwWrongDevice);
    }
    confirm_native(
        &app,
        "Confirmer la transaction Solana (hardware wallet)",
        solana::describe(&summary, &me, state.network) + &device_line(&info),
    )
    .await?;
    if summary.requires_extra_confirmation {
        confirm_native(
            &app,
            "Attention : transaction non vérifiée",
            solana::describe_extra(&summary),
        )
        .await?;
    }
    let account = acc.account;
    let msg = bytes.clone();
    let sig = state
        .hw
        .run(&id, T_CONFIRM, prompt_fn(&app, &id), move |dev, ctl| {
            dev.sol_sign(ctl, account, &msg)
        })
        .await?;
    let sig = wallet_core::sol_verify_signature(&me, &bytes, &sig)?;
    state.touch();
    Ok(HwSolSigned {
        signature: base64::engine::general_purpose::STANDARD.encode(sig),
        summary,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use wallet_core::{Mnemonic, Network};

    const ABANDON: &str =
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    fn account() -> WatchOnlyAccount {
        let seed = Mnemonic::parse(ABANDON).unwrap().to_seed("");
        let net = Network::Testnet;
        WatchOnlyAccount {
            id: "hw-00000000000000aa".into(),
            label: "test".into(),
            device: HwDeviceKind::Trezor,
            model: "Trezor Safe 5".into(),
            network: net,
            account: 0,
            btc: vec![
                wallet_core::btc_account(&seed, net, BtcKind::Segwit, 0).unwrap(),
                wallet_core::btc_account(&seed, net, BtcKind::Taproot, 0).unwrap(),
            ],
            evm: None,
            sol: Some(WatchSol {
                address: wallet_core::sol_address(&seed, 0).unwrap(),
                path: wallet_core::sol_path(0),
            }),
        }
    }

    #[test]
    fn paths_parse() {
        assert_eq!(
            parse_path("m/84'/1'/0'/0/5").unwrap(),
            vec![84 | H, 1 | H, H, 0, 5]
        );
        assert_eq!(
            parse_path("m/44h/501h/0h/0h").unwrap(),
            hw::sol_path(0).to_vec()
        );
        for bad in ["84'/1'", "m/", "m/x", "m/2147483648", "m/1''", "m//1", ""] {
            assert!(parse_path(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn verify_targets_resolve_to_kyro_derivation() {
        let acc = account();
        let seed = Mnemonic::parse(ABANDON).unwrap().to_seed("");
        let (t, expected) =
            resolve_target(&acc, Chain::Btc, &parse_path("m/84'/1'/0'/1/3").unwrap()).unwrap();
        assert!(matches!(
            t,
            Target::Btc {
                change: true,
                index: 3,
                ..
            }
        ));
        assert_eq!(
            expected,
            wallet_core::btc_address(&seed, Network::Testnet, BtcKind::Segwit, 0, true, 3).unwrap()
        );
        let (_, tr) =
            resolve_target(&acc, Chain::Btc, &parse_path("m/86'/1'/0'/0/0").unwrap()).unwrap();
        assert!(tr.starts_with("tb1p"));
        let (t, sol) =
            resolve_target(&acc, Chain::Sol, &parse_path("m/44'/501'/0'/0'").unwrap()).unwrap();
        assert_eq!(t, Target::Sol);
        assert_eq!(sol, wallet_core::sol_address(&seed, 0).unwrap());
        // Paths outside the stored account are refused.
        for (chain, p) in [
            (Chain::Btc, "m/84'/1'/1'/0/0"),  // other account
            (Chain::Btc, "m/84'/0'/0'/0/0"),  // mainnet coin type
            (Chain::Btc, "m/84'/1'/0'/2/0"),  // change > 1
            (Chain::Btc, "m/49'/1'/0'/0/0"),  // BIP49 not stored
            (Chain::Sol, "m/44'/501'/1'/0'"), // other account
            (Chain::Evm, "m/44'/60'/0'/0/0"), // no EVM key stored
        ] {
            assert!(
                resolve_target(&acc, chain, &parse_path(p).unwrap()).is_err(),
                "{p}"
            );
        }
        assert!(matches!(
            resolve_target(&acc, Chain::Xrp, &[0]),
            Err(AppError::HwUnsupported { .. })
        ));
    }

    #[test]
    fn unknown_outputs_need_reinforced_confirmation() {
        let s = wallet_core::BtcTxSummary {
            outputs: vec![
                ("tb1q…".into(), 1, false),
                ("op_return:6a00".into(), 0, false),
            ],
            fee_sats: 1,
        };
        assert!(has_unknown_output(&s));
    }
}
