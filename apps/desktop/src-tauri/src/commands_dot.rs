//! IPC commands for Polkadot (`dot_*`, DOT on Polkadot Asset Hub, WND on Westend Asset Hub):
//! address, account (balance, frozen part, spendable above the existential deposit), transfer
//! building **by Kyro** (`Balances.transfer_keep_alive`: nonce, era and runtime from the node,
//! encoded by wallet-core after checking the metadata), signing behind the password and the
//! native dialog (balances and existential deposit re-read live), and `author_submitExtrinsic`
//! with hash check. Contract: docs/IPC.md §2.11.

use serde::Serialize;
use tauri::{AppHandle, State};
use wallet_core::{DotAccountInfo, DotEra, DotRuntime, DotTransfer, DotTxSummary, Network};
use zeroize::Zeroizing;

use crate::accounts::{account_arg, confirm_signer, Chain, SignerInfo};
use crate::commands::{blocking, confirm_native, format_units_in, polkadot_root_from_password};
use crate::dot_backend::{self, DotCtx, DotTxState, TransferCheck, ERA_MARGIN, ERA_PERIOD};
use crate::error::{AppError, AppResult};
use crate::i18n::Lang;
use crate::servers::host_of;
use crate::state::AppState;

pub(crate) fn ctx(state: &AppState) -> DotCtx<'_> {
    DotCtx {
        net_client: &state.net,
        network: state.network,
        tor: state.settings().tor.enabled,
    }
}

/// Address and public key of Polkadot account `account` (root, or `//account`).
fn ours(state: &AppState, account: u32) -> AppResult<(String, [u8; 32])> {
    state.with_polkadot(|root| {
        Ok((
            wallet_core::dot_address(root, account, state.network)?,
            wallet_core::dot_public_key(root, account)?,
        ))
    })
}

fn amount(lang: Lang, planck: u128, net: Network) -> String {
    let c = wallet_core::dot_chain(net);
    format!(
        "{} {}",
        format_units_in(lang, &planck.to_string(), usize::from(c.decimals)),
        c.symbol
    )
}

fn planck_of(s: &str) -> u128 {
    s.parse().unwrap_or(0)
}

/// An account as the UI shows it (planck, decimal strings).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DotAccountView {
    pub address: String,
    /// Exists on chain (holds at least the existential deposit, or another provider).
    pub exists: bool,
    pub free: String,
    pub reserved: String,
    /// Part of `free` locked (staking, vesting, governance).
    pub frozen: String,
    /// What a `transfer_keep_alive` can take (fee included): free − max(frozen − reserved, ED).
    pub spendable: String,
    pub nonce: u32,
}

fn view(address: &str, a: &DotAccountInfo, ed: u128) -> DotAccountView {
    DotAccountView {
        address: address.to_owned(),
        exists: a.exists(),
        free: a.free.to_string(),
        reserved: a.reserved.to_string(),
        frozen: a.frozen.to_string(),
        spendable: a.spendable(ed).to_string(),
        nonce: a.nonce,
    }
}

/// Live context shown in the dialog.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DotContext {
    pub account: DotAccountView,
    pub destination: DotAccountView,
    /// Planck.
    pub existential_deposit: String,
    /// Fee estimate of the node (planck), `TransactionPaymentApi_query_info`.
    pub fee: String,
    /// Birth block of the era (finalized block when built).
    pub era_birth: u64,
    /// First block where the transaction is no longer valid.
    pub valid_until: u64,
    /// Last finalized block seen.
    pub finalized: u64,
    /// Token transfer: both holdings of the asset and its minimum balance, read live.
    pub asset: Option<DotAssetContext>,
}

/// Asset part of [`DotContext`] (token base units, decimal strings).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DotAssetContext {
    pub asset_id: u32,
    pub ours: String,
    pub destination: String,
    /// `Assets.Asset.min_balance`: smallest holding (ours stays ≥ it after a keep-alive send).
    pub min_balance: String,
    pub frozen: bool,
}

/// One known token of `dot_asset_balances`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DotAssetBalance {
    pub asset_id: u32,
    /// Base units.
    pub balance: String,
    pub frozen: bool,
    /// Smallest holding; a keep-alive send leaves at least this much.
    pub min_balance: String,
}

fn token(lang: Lang, units: u128, a: &wallet_core::DotAssetSummary) -> String {
    format!(
        "{} {}",
        format_units_in(lang, &units.to_string(), usize::from(a.decimals)),
        a.symbol
    )
}

/// Body of the native dialog.
pub(crate) fn describe_dot(lang: Lang, s: &DotTxSummary, c: &DotContext, net: Network) -> String {
    let ed = planck_of(&c.existential_deposit);
    let am = |p: u128| amount(lang, p, net);
    let testnet = if net == Network::Testnet {
        " (testnet)"
    } else {
        ""
    };
    let mut out = match (&s.asset, lang) {
        (Some(a), Lang::Fr) => format!(
            "Envoi {} — {}{testnet}\n\nJeton : {} ({}) · actif n° {} (vérifié, table de Kyro) · {} décimales\nÀ : {}\n\nMontant : {} ({} unités)\n",
            a.symbol,
            s.chain,
            a.symbol,
            a.name,
            a.asset_id,
            a.decimals,
            s.to,
            token(lang, planck_of(&s.amount), a),
            s.amount
        ),
        (Some(a), Lang::En) => format!(
            "{} send — {}{testnet}\n\nToken: {} ({}) · asset ID {} (verified, Kyro's table) · {} decimals\nTo: {}\n\nAmount: {} ({} units)\n",
            a.symbol,
            s.chain,
            a.symbol,
            a.name,
            a.asset_id,
            a.decimals,
            s.to,
            token(lang, planck_of(&s.amount), a),
            s.amount
        ),
        (None, Lang::Fr) => format!(
            "Envoi Polkadot — {}{testnet}\n\nÀ : {}\n\nMontant : {} ({} planck)\n",
            s.chain,
            s.to,
            am(planck_of(&s.amount)),
            s.amount
        ),
        (None, Lang::En) => format!(
            "Polkadot send — {}{testnet}\n\nTo: {}\n\nAmount: {} ({} planck)\n",
            s.chain,
            s.to,
            am(planck_of(&s.amount)),
            s.amount
        ),
    };
    if let (Some(a), Some(h)) = (&s.asset, &c.asset) {
        let min = planck_of(&h.min_balance);
        out += &match lang {
            Lang::Fr => format!(
                "Ton solde {} : {} (au moins {} reste sur le compte)\n",
                a.symbol,
                token(lang, planck_of(&h.ours), a),
                token(lang, min, a)
            ),
            Lang::En => format!(
                "Your {} balance: {} (at least {} stays on the account)\n",
                a.symbol,
                token(lang, planck_of(&h.ours), a),
                token(lang, min, a)
            ),
        };
        if planck_of(&h.destination) == 0 {
            out += lang.pick(
                "Le destinataire n'a pas encore ce jeton : ce transfert le lui crée.\n",
                "The recipient does not hold this token yet: this transfer creates it.\n",
            );
        }
    }
    if s.asset.is_none() && !c.destination.exists {
        out += &match lang {
            Lang::Fr => format!(
                "Ce compte n'existe pas encore : ce transfert le crée (dépôt existentiel : {}).\n",
                am(ed)
            ),
            Lang::En => format!(
                "This account does not exist yet: this transfer creates it (existential deposit: {}).\n",
                am(ed)
            ),
        };
    }
    out += &match lang {
        Lang::Fr => format!(
            "\nFrais estimés par le nœud : ≈ {} (prélevés en plus)\nSolde : {} · bloqué : {} · dépôt existentiel (reste toujours sur le compte) : {} · disponible : {}\n",
            am(planck_of(&c.fee)),
            am(planck_of(&c.account.free)),
            am(planck_of(&c.account.frozen)),
            am(ed),
            am(planck_of(&c.account.spendable))
        ),
        Lang::En => format!(
            "\nFee estimated by the node: ≈ {} (charged on top)\nBalance: {} · locked: {} · existential deposit (always stays on the account): {} · available: {}\n",
            am(planck_of(&c.fee)),
            am(planck_of(&c.account.free)),
            am(planck_of(&c.account.frozen)),
            am(ed),
            am(planck_of(&c.account.spendable))
        ),
    };
    out += &match lang {
        Lang::Fr => format!(
            "\nAppel : {} (ton compte reste actif) · pourboire : {}\nValable jusqu'au bloc n° {} ({} blocs) · nonce {} · runtime {} / {}\n",
            s.call,
            am(planck_of(&s.tip)),
            c.valid_until,
            s.era_period,
            s.nonce,
            s.spec_version,
            s.tx_version
        ),
        Lang::En => format!(
            "\nCall: {} (your account stays active) · tip: {}\nValid until block {} ({} blocks) · nonce {} · runtime {} / {}\n",
            s.call,
            am(planck_of(&s.tip)),
            c.valid_until,
            s.era_period,
            s.nonce,
            s.spec_version,
            s.tx_version
        ),
    };
    out
}

// ---------------------------------------------------------------- reads

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DotBackendInfo {
    pub network: &'static str,
    /// "Polkadot Asset Hub" / "Westend Asset Hub".
    pub chain: &'static str,
    pub symbol: &'static str,
    pub decimals: u8,
    pub ss58: u8,
    pub label: String,
    pub tor: bool,
}

#[tauri::command]
pub fn dot_backend_info(state: State<'_, AppState>) -> DotBackendInfo {
    let c = ctx(&state);
    let chain = wallet_core::dot_chain(state.network);
    DotBackendInfo {
        network: match state.network {
            Network::Mainnet => "mainnet",
            Network::Testnet => "testnet",
        },
        chain: chain.name,
        symbol: chain.symbol,
        decimals: chain.decimals,
        ss58: chain.ss58,
        label: host_of(dot_backend::default_url(state.network)).unwrap_or_default(),
        tor: c.tor,
    }
}

/// Address of Polkadot account `account` (absent = 0, the phrase's root key).
#[tauri::command]
pub fn dot_address(state: State<'_, AppState>, account: Option<u32>) -> AppResult<String> {
    Ok(ours(&state, account_arg(account)?)?.0)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DotAccountReply {
    #[serde(flatten)]
    pub account: DotAccountView,
    /// Planck.
    pub existential_deposit: String,
}

#[tauri::command]
pub async fn dot_account(
    state: State<'_, AppState>,
    address: String,
) -> AppResult<DotAccountReply> {
    let c = ctx(&state);
    let id = wallet_core::dot_account_id(&address, c.network)?;
    let rt = dot_backend::runtime(&c).await?;
    let info = dot_backend::account_info(&c, &id, None).await?;
    Ok(DotAccountReply {
        account: view(address.trim(), &info, rt.existential_deposit),
        existential_deposit: rt.existential_deposit.to_string(),
    })
}

// ---------------------------------------------------------------- build, sign, broadcast

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DotBuilt {
    /// Signing payload, hex: what `dot_sign_tx` decodes and signs.
    pub payload: String,
    pub summary: DotTxSummary,
    pub context: DotContext,
}

async fn live_context(
    c: &DotCtx<'_>,
    rt: &DotRuntime,
    me: &str,
    pk: &[u8; 32],
    t: &DotTransfer,
    era_birth: u64,
    finalized: u64,
) -> AppResult<DotContext> {
    let ed = rt.existential_deposit;
    let ours = dot_backend::account_info(c, pk, None).await?;
    let dest = dot_backend::account_info(c, &t.dest, None).await?;
    let payload = wallet_core::dot_transfer_payload(rt, t, pk)?;
    let fee = dot_backend::fee(c, &wallet_core::dot_fee_probe_extrinsic(rt, &payload, pk)?).await?;
    let chain = rt.chain();
    let asset = match t.asset {
        None => {
            dot_backend::check_transfer(&TransferCheck {
                ours: &ours,
                dest: &dest,
                existential_deposit: ed,
                value: t.value,
                fee,
                decimals: chain.decimals,
                symbol: chain.symbol,
            })?;
            None
        }
        Some(id) => {
            let known = wallet_core::dot_known_asset(c.network, id)
                .ok_or_else(|| AppError::InvalidInput(format!("actif {id} inconnu de Kyro")))?;
            let details = dot_backend::asset_details(c, &known).await?;
            let mine = dot_backend::asset_account(c, id, pk).await?;
            let theirs = dot_backend::asset_account(c, id, &t.dest).await?;
            dot_backend::check_asset_transfer(&dot_backend::AssetCheck {
                ours: &ours,
                existential_deposit: ed,
                mine: &mine,
                dest: &theirs,
                details: &details,
                value: t.value,
                fee,
                symbol: known.symbol,
                decimals: known.decimals,
            })?;
            Some(DotAssetContext {
                asset_id: id,
                ours: mine.balance.to_string(),
                destination: theirs.balance.to_string(),
                min_balance: details.min_balance.to_string(),
                frozen: mine.frozen || mine.blocked,
            })
        }
    };
    Ok(DotContext {
        account: view(me, &ours, ed),
        destination: view(
            &wallet_core::dot_ss58_encode(&t.dest, chain.ss58),
            &dest,
            ed,
        ),
        existential_deposit: ed.to_string(),
        fee: fee.to_string(),
        era_birth,
        valid_until: era_birth + t.era.period,
        finalized,
        asset,
    })
}

/// Builds the payload of a transfer of `planck` to `to` from live data.
pub(crate) async fn build(
    c: &DotCtx<'_>,
    rt: &DotRuntime,
    me: &str,
    pk: &[u8; 32],
    to: &str,
    planck: &str,
) -> AppResult<DotBuilt> {
    build_any(c, rt, me, pk, to, planck, None).await
}

/// Builds a native (`asset` = None) or token transfer of `planck` base units to `to`.
pub(crate) async fn build_any(
    c: &DotCtx<'_>,
    rt: &DotRuntime,
    me: &str,
    pk: &[u8; 32],
    to: &str,
    planck: &str,
    asset: Option<u32>,
) -> AppResult<DotBuilt> {
    if let Some(id) = asset {
        if wallet_core::dot_known_asset(c.network, id).is_none() {
            return Err(AppError::InvalidInput(format!(
                "actif {id} inconnu de Kyro"
            )));
        }
        if let Err(why) = &rt.assets {
            return Err(AppError::InvalidInput(format!(
                "pallet Assets différente de ce que Kyro connaît ({why}) : Kyro doit être mis à jour"
            )));
        }
    }
    let dest = wallet_core::dot_account_id(to, c.network)?;
    let value: u128 = planck
        .trim()
        .parse()
        .ok()
        .filter(|v| *v > 0)
        .ok_or_else(|| AppError::InvalidInput("montant en planck invalide".into()))?;
    if &dest == pk {
        return Err(AppError::InvalidInput("transfert à soi-même".into()));
    }
    let (n, hash) = dot_backend::finalized(c).await?;
    let nonce = dot_backend::next_nonce(c, me).await?;
    let t = DotTransfer {
        dest,
        value,
        era: DotEra::mortal(ERA_PERIOD, n),
        block_hash: hash,
        nonce,
        tip: 0,
        asset,
    };
    let context = live_context(c, rt, me, pk, &t, t.era.birth(n), n).await?;
    let payload = wallet_core::dot_transfer_payload(rt, &t, pk)?;
    let summary = wallet_core::dot_decode_payload(rt, &payload, pk)?;
    Ok(DotBuilt {
        payload,
        summary,
        context,
    })
}

#[tauri::command]
pub async fn dot_build_tx(
    state: State<'_, AppState>,
    to: String,
    amount: String,
    account: Option<u32>,
) -> AppResult<DotBuilt> {
    let (me, pk) = ours(&state, account_arg(account)?)?;
    let c = ctx(&state);
    let rt = dot_backend::runtime(&c).await?;
    build(&c, &rt, &me, &pk, &to, &amount).await
}

/// Known tokens of the network (USD₮ 1984, USDC 1337 on Polkadot Asset Hub) held by `address`.
#[tauri::command]
pub async fn dot_asset_balances(
    state: State<'_, AppState>,
    address: String,
) -> AppResult<Vec<DotAssetBalance>> {
    let c = ctx(&state);
    let id = wallet_core::dot_account_id(&address, c.network)?;
    let mut out = Vec::new();
    for k in wallet_core::dot_known_assets(c.network) {
        let details = dot_backend::asset_details(&c, k).await?;
        let a = dot_backend::asset_account(&c, k.id, &id).await?;
        out.push(DotAssetBalance {
            asset_id: k.id,
            balance: a.balance.to_string(),
            frozen: a.frozen || a.blocked,
            min_balance: details.min_balance.to_string(),
        });
    }
    Ok(out)
}

/// `Assets.transfer_keep_alive` of a known token (`amount` in its base units); fees in DOT.
#[tauri::command]
pub async fn dot_build_asset_tx(
    state: State<'_, AppState>,
    asset_id: u32,
    to: String,
    amount: String,
    account: Option<u32>,
) -> AppResult<DotBuilt> {
    let (me, pk) = ours(&state, account_arg(account)?)?;
    let c = ctx(&state);
    let rt = dot_backend::runtime(&c).await?;
    build_any(&c, &rt, &me, &pk, &to, &amount, Some(asset_id)).await
}

/// Decoding + live re-checks, i.e. everything `dot_sign_tx` does before the dialog: current
/// runtime (spec / transaction versions must still match), era block known and not about to
/// expire, nonce still the next one, balances and fee re-read.
pub(crate) async fn prepare_sign(
    c: &DotCtx<'_>,
    rt: &DotRuntime,
    me: &str,
    pk: &[u8; 32],
    payload: &str,
) -> AppResult<(DotTxSummary, DotContext)> {
    let raw = hex::decode(payload.trim())
        .map_err(|_| AppError::InvalidInput("charge à signer : hexadécimal attendu".into()))?;
    let t = wallet_core::dot_parse_payload(rt, &raw, pk)?;
    let summary = wallet_core::dot_decode_payload(rt, payload, pk)?;
    let birth = dot_backend::block_number(c, &t.block_hash).await?;
    if birth % t.era.period != t.era.phase {
        return Err(AppError::InvalidInput(
            "ère incohérente avec son bloc de référence : reconstruis la transaction".into(),
        ));
    }
    let (n, _) = dot_backend::finalized(c).await?;
    if birth > n {
        return Err(AppError::InvalidInput(
            "bloc de référence pas encore finalisé : reconstruis la transaction".into(),
        ));
    }
    if n + ERA_MARGIN >= birth + t.era.period {
        return Err(AppError::InvalidInput(
            "transaction Polkadot expirée (ou sur le point de l'être) : reconstruis-la".into(),
        ));
    }
    if dot_backend::next_nonce(c, me).await? != t.nonce {
        return Err(AppError::InvalidInput(
            "nonce périmé (une autre transaction est passée) : reconstruis la transaction".into(),
        ));
    }
    let context = live_context(c, rt, me, pk, &t, birth, n).await?;
    Ok((summary, context))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DotSigned {
    /// Signed extrinsic, hex: what `dot_broadcast` submits.
    pub extrinsic: String,
    /// blake2-256 of the extrinsic, hex.
    pub hash: String,
    /// Era block hash, hex (signed but not in the extrinsic: `dot_broadcast` needs it).
    pub block_hash: String,
    pub summary: DotTxSummary,
    pub context: DotContext,
}

#[tauri::command]
pub async fn dot_sign_tx(
    app: AppHandle,
    state: State<'_, AppState>,
    payload: String,
    password: String,
    account: Option<u32>,
) -> AppResult<DotSigned> {
    if !state.is_unlocked() {
        return Err(AppError::Locked);
    }
    let a = account_arg(account)?;
    let (me, pk) = ours(&state, a)?;
    let signer = SignerInfo::new(&state, Chain::Dot, a, wallet_core::dot_path(a));
    let c = ctx(&state);
    let rt = dot_backend::runtime(&c).await?;
    let (summary, context) = prepare_sign(&c, &rt, &me, &pk, &payload).await?;
    let root = polkadot_root_from_password(&state, Zeroizing::new(password)).await?;
    let lang = crate::i18n::current();
    confirm_native(
        &app,
        if summary.asset.is_some() {
            lang.pick(
                "Confirmer l'envoi de jetons (Polkadot Asset Hub)",
                "Confirm the token send (Polkadot Asset Hub)",
            )
        } else {
            lang.pick("Confirmer l'envoi Polkadot", "Confirm the Polkadot send")
        },
        signer.body(lang, &describe_dot(lang, &summary, &context, state.network)),
    )
    .await?;
    confirm_signer(&app, &signer).await?;
    let (p, r) = (payload.clone(), rt.clone());
    let (extrinsic, hash, again) =
        blocking(move || Ok(wallet_core::dot_sign(&root, a, &r, &p)?)).await?;
    if again != summary {
        return Err(AppError::Internal(
            "résumé différent entre l'aperçu et la signature".into(),
        ));
    }
    state.touch();
    Ok(DotSigned {
        extrinsic,
        hash,
        block_hash: summary.block_hash.clone(),
        summary,
        context,
    })
}

/// Checks the signed extrinsic (decodes, sr25519 signature by our key over the current
/// runtime and `block_hash`) then submits it.
pub(crate) async fn broadcast_checked(
    c: &DotCtx<'_>,
    rt: &DotRuntime,
    me: &str,
    extrinsic: &str,
    block_hash: &[u8; 32],
) -> AppResult<String> {
    let (signer, hash, _) = wallet_core::dot_verify_extrinsic(rt, extrinsic, block_hash)?;
    if signer != wallet_core::dot_account_id(me, c.network)? {
        return Err(AppError::InvalidInput(
            "cette transaction n'est pas signée par ton compte".into(),
        ));
    }
    dot_backend::submit(c, extrinsic.trim(), &hash).await
}

fn hash_arg(s: &str, what: &str) -> AppResult<[u8; 32]> {
    hex::decode(s.trim().trim_start_matches("0x"))
        .ok()
        .and_then(|b| <[u8; 32]>::try_from(b).ok())
        .ok_or_else(|| AppError::InvalidInput(format!("{what} : 64 caractères hexadécimaux")))
}

#[tauri::command]
pub async fn dot_broadcast(
    state: State<'_, AppState>,
    extrinsic: String,
    block_hash: String,
    account: Option<u32>,
) -> AppResult<String> {
    let (me, _) = ours(&state, account_arg(account)?)?;
    let block = hash_arg(&block_hash, "blockHash")?;
    let c = ctx(&state);
    let rt = dot_backend::runtime(&c).await?;
    broadcast_checked(&c, &rt, &me, &extrinsic, &block).await
}

/// `{ state: 'pending' | 'finalized' | 'expired', finalized }` of a transfer signed by
/// `address` with `nonce`, valid until block `validUntil`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DotTxStatus {
    pub state: DotTxState,
    pub finalized: u64,
}

#[tauri::command]
pub async fn dot_tx_status(
    state: State<'_, AppState>,
    address: String,
    nonce: u32,
    valid_until: u64,
) -> AppResult<DotTxStatus> {
    let c = ctx(&state);
    let id = wallet_core::dot_account_id(&address, c.network)?;
    let (s, n) = dot_backend::tx_state(&c, &id, nonce, valid_until).await?;
    Ok(DotTxStatus {
        state: s,
        finalized: n,
    })
}

/// Native DOT transfers of `address` (Statescan, Asset Hub + relay chain). Never an error:
/// `available: false` when there is nothing reliable to show (see `dot_history`).
#[tauri::command]
pub async fn dot_txs(
    state: State<'_, AppState>,
    address: String,
) -> AppResult<crate::dot_history::DotHistory> {
    Ok(crate::dot_history::txs(&ctx(&state), &address).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summary() -> DotTxSummary {
        DotTxSummary {
            chain: "Polkadot Asset Hub".into(),
            from: "13KVd4f2a4S5pLp4gTTFezyXdPWx27vQ9vS6xBXJ9yWVd7xo".into(),
            to: "12ES7PTE9a3DKbs9mCsRA6Wge2DS1XK1xFgbTkp47nPV53yG".into(),
            amount: "12345678900".into(),
            symbol: "DOT".into(),
            decimals: 10,
            call: "Balances.transfer_keep_alive".into(),
            nonce: 7,
            tip: "0".into(),
            era_period: 256,
            era_phase: 64,
            block_hash: "00".repeat(32),
            spec_version: 2_005_002,
            tx_version: 15,
            asset: None,
        }
    }

    fn context(dest_exists: bool) -> DotContext {
        DotContext {
            account: DotAccountView {
                exists: true,
                free: "50000000000".into(),
                frozen: "10000000000".into(),
                spendable: "39900000000".into(),
                ..Default::default()
            },
            destination: DotAccountView {
                exists: dest_exists,
                ..Default::default()
            },
            existential_deposit: "100000000".into(),
            fee: "155000000".into(),
            era_birth: 1_000_000,
            valid_until: 1_000_256,
            finalized: 1_000_000,
            asset: None,
        }
    }

    #[test]
    fn dialog_shows_the_token_its_verified_id_and_decimals() {
        let mut s = summary();
        s.amount = "12500000".into();
        s.symbol = "USDT".into();
        s.decimals = 6;
        s.call = "Assets.transfer_keep_alive".into();
        s.asset = Some(wallet_core::DotAssetSummary {
            asset_id: 1984,
            symbol: "USDT".into(),
            name: "Tether".into(),
            decimals: 6,
        });
        let mut c = context(true);
        c.asset = Some(DotAssetContext {
            asset_id: 1984,
            ours: "20000000".into(),
            destination: "0".into(),
            min_balance: "10000".into(),
            frozen: false,
        });
        let d = describe_dot(Lang::Fr, &s, &c, Network::Mainnet);
        for needle in [
            "Envoi USDT — Polkadot Asset Hub",
            "Jeton : USDT (Tether) · actif n° 1984 (vérifié, table de Kyro) · 6 décimales",
            "Montant : 12,5 USDT (12500000 unités)",
            "Ton solde USDT : 20 USDT (au moins 0,01 USDT reste sur le compte)",
            "n'a pas encore ce jeton",
            "Appel : Assets.transfer_keep_alive",
        ] {
            assert!(d.contains(needle), "{needle} missing in:\n{d}");
        }
        assert!(!d.contains("planck)\n") || d.contains("Frais"));
        let en = describe_dot(Lang::En, &s, &c, Network::Mainnet);
        assert!(en.contains("asset ID 1984 (verified, Kyro's table) · 6 decimals"));
    }

    #[test]
    fn dialog_shows_amount_fee_and_existential_deposit() {
        let d = describe_dot(Lang::Fr, &summary(), &context(true), Network::Mainnet);
        for needle in [
            "Envoi Polkadot — Polkadot Asset Hub\n",
            "À : 12ES7PTE9a3DKbs9mCsRA6Wge2DS1XK1xFgbTkp47nPV53yG",
            "Montant : 1,23456789 DOT (12345678900 planck)",
            "Frais estimés par le nœud : ≈ 0,0155 DOT",
            "bloqué : 1 DOT",
            "dépôt existentiel (reste toujours sur le compte) : 0,01 DOT · disponible : 3,99 DOT",
            "Balances.transfer_keep_alive (ton compte reste actif) · pourboire : 0 DOT",
            "Valable jusqu'au bloc n° 1000256 (256 blocs) · nonce 7 · runtime 2005002 / 15",
        ] {
            assert!(d.contains(needle), "{needle} missing in:\n{d}");
        }
        assert!(!d.contains("n'existe pas encore"));
        let d = describe_dot(Lang::Fr, &summary(), &context(false), Network::Testnet);
        assert!(d.contains("(testnet)"));
        // Westend: WND, 12 decimals.
        assert!(
            d.contains("ce transfert le crée (dépôt existentiel : 0,0001 WND)"),
            "{d}"
        );
        let en = describe_dot(Lang::En, &summary(), &context(true), Network::Mainnet);
        assert!(
            en.contains("Amount: 1.23456789 DOT (12345678900 planck)") && en.contains("tip: 0 DOT")
        );
    }

    #[test]
    fn hash_arguments() {
        assert!(hash_arg(&"ab".repeat(32), "h").is_ok());
        assert!(hash_arg(&format!("0x{}", "ab".repeat(32)), "h").is_ok());
        assert!(hash_arg("abcd", "h").is_err());
        assert!(hash_arg(&"zz".repeat(32), "h").is_err());
    }
}
