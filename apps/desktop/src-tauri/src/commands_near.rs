//! IPC commands for NEAR Protocol (`near_*`): implicit-account address, account (balance,
//! storage reserve, spendable), history, transfer building **by Kyro** (nonce and block hash
//! from the node, Borsh encoded by wallet-core), signing behind the password and the native
//! dialog (receiver, amount, fee bound, signing account), and `send_tx` with hash check.
//! Contract: docs/IPC.md §2.11.

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, State};
use wallet_core::{NearAccountKind, NearTransfer, NearTxSummary, NearWarning, Network};
use zeroize::Zeroizing;

use crate::accounts::{account_arg, confirm_signer, Chain, SignerInfo};
use crate::commands::{blocking, confirm_native, format_units_in, seed_from_password};
use crate::error::{AppError, AppResult};
use crate::i18n::Lang;
use crate::near_backend::{
    self, NearAccountInfo, NearCtx, NearFeeParams, NearTxOutcome, TransferCheck, MAX_BLOCK_AGE,
};
use crate::servers::{host_of, utxo_network_key};
use crate::state::AppState;

pub(crate) fn ctx(state: &AppState) -> NearCtx<'_> {
    NearCtx {
        net_client: &state.net,
        network: state.network,
        tor: state.settings().tor.enabled,
    }
}

/// Implicit account id and public key of NEAR account `account` (`m/44'/397'/account'`).
fn ours(state: &AppState, account: u32) -> AppResult<(String, [u8; 32])> {
    state.with_seed(|seed| {
        Ok((
            wallet_core::near_address(seed, account)?,
            wallet_core::near_public_key(seed, account)?,
        ))
    })
}

fn near(lang: Lang, yocto: &str) -> String {
    format!("{} NEAR", format_units_in(lang, yocto, 24))
}

/// Live context shown in the dialog.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NearContext {
    pub account: NearAccountInfo,
    pub receiver: NearAccountInfo,
    /// The transfer creates the receiver (implicit account not on chain yet).
    pub creates_account: bool,
    /// yoctoNEAR per gas, now.
    pub gas_price: String,
    /// yoctoNEAR: expected fee at the current gas price.
    pub fee_estimate: String,
    /// yoctoNEAR: what the balance must cover on top of the amount (see near_backend).
    pub fee_bound: String,
}

fn kind_text(lang: Lang, k: NearAccountKind) -> &'static str {
    match k {
        NearAccountKind::Implicit => lang.pick(
            "compte implicite : la clé publique du destinataire, en hexadécimal",
            "implicit account: the receiver's public key, in hexadecimal",
        ),
        NearAccountKind::EthImplicit => lang.pick(
            "compte de style Ethereum, contrôlé par une clé Ethereum",
            "Ethereum-style account, controlled by an Ethereum key",
        ),
        NearAccountKind::Named => lang.pick("compte nommé", "named account"),
    }
}

/// Body of the native dialog.
pub(crate) fn describe_near(
    lang: Lang,
    s: &NearTxSummary,
    c: &NearContext,
    net: Network,
) -> String {
    let n = |v: &str| near(lang, v);
    let testnet = if net == Network::Testnet {
        " (testnet)"
    } else {
        ""
    };
    let mut out = match lang {
        Lang::Fr => format!(
            "Envoi NEAR{testnet}\n\nÀ : {}\n({})\n\nMontant : {} ({} yoctoNEAR)\n",
            s.receiver_id,
            kind_text(lang, s.receiver_kind),
            n(&s.deposit),
            s.deposit
        ),
        Lang::En => format!(
            "NEAR send{testnet}\n\nTo: {}\n({})\n\nAmount: {} ({} yoctoNEAR)\n",
            s.receiver_id,
            kind_text(lang, s.receiver_kind),
            n(&s.deposit),
            s.deposit
        ),
    };
    if c.creates_account {
        out += lang.pick(
            "\nCe compte implicite n'existe pas encore : ce transfert le crée (frais de création inclus ci-dessous).\n",
            "\nThis implicit account does not exist yet: this transfer creates it (creation fee included below).\n",
        );
    }
    out += &match lang {
        Lang::Fr => format!(
            "\nFrais : ≈ {} — au plus {}\n(les frais NEAR ne sont pas écrits dans la transaction : ils sont prélevés au prix du gas du bloc ; Kyro a vérifié que ton solde couvre le montant + cette borne)\n",
            n(&c.fee_estimate),
            n(&c.fee_bound)
        ),
        Lang::En => format!(
            "\nFee: ≈ {} — at most {}\n(NEAR fees are not written in the transaction: they are charged at the block's gas price; Kyro checked that your balance covers the amount + this bound)\n",
            n(&c.fee_estimate),
            n(&c.fee_bound)
        ),
    };
    out += &match lang {
        Lang::Fr => format!(
            "Solde : {} · réservé au stockage : {} · disponible : {}\n",
            n(&c.account.balance),
            n(&c.account.storage_reserve),
            n(&c.account.spendable)
        ),
        Lang::En => format!(
            "Balance: {} · reserved for storage: {} · available: {}\n",
            n(&c.account.balance),
            n(&c.account.storage_reserve),
            n(&c.account.spendable)
        ),
    };
    out += &match lang {
        Lang::Fr => format!(
            "\nDe : {}\nClé : {} · nonce {}\nBloc de référence : {} (transaction valable ≈ 24 h)\nHash de la transaction : {}\n",
            s.signer_id, s.public_key, s.nonce, s.block_hash, s.hash
        ),
        Lang::En => format!(
            "\nFrom: {}\nKey: {} · nonce {}\nReference block: {} (transaction valid for ≈ 24 h)\nTransaction hash: {}\n",
            s.signer_id, s.public_key, s.nonce, s.block_hash, s.hash
        ),
    };
    out
}

pub(crate) fn describe_near_extra(lang: Lang, s: &NearTxSummary) -> String {
    let mut out = String::from(lang.pick(
        "Kyro a trouvé des éléments inhabituels dans ce transfert :\n",
        "Kyro found unusual elements in this transfer:\n",
    ));
    for w in &s.warnings {
        out += match w {
            NearWarning::EthImplicitReceiver => lang.pick(
                "• le destinataire est un compte NEAR de style Ethereum (0x…) : il est contrôlé par une clé Ethereum. Une adresse de dépôt EVM d'une plateforme n'est PAS un compte NEAR.\n",
                "• the receiver is an Ethereum-style NEAR account (0x…): it is controlled by an Ethereum key. An exchange's EVM deposit address is NOT a NEAR account.\n",
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
pub struct NearBackendInfo {
    pub kind: &'static str,
    pub network: &'static str,
    /// RPC host.
    pub label: String,
    /// History host.
    pub history: String,
    pub tor: bool,
}

#[tauri::command]
pub fn near_backend_info(state: State<'_, AppState>) -> NearBackendInfo {
    let c = ctx(&state);
    NearBackendInfo {
        kind: "default",
        network: utxo_network_key(state.network),
        label: host_of(near_backend::rpc_url(&c)).unwrap_or_default(),
        history: host_of(near_backend::history_url(&c)).unwrap_or_default(),
        tor: c.tor,
    }
}

/// Implicit account id of NEAR account `account` (absent = 0).
#[tauri::command]
pub fn near_address(state: State<'_, AppState>, account: Option<u32>) -> AppResult<String> {
    Ok(ours(&state, account_arg(account)?)?.0)
}

#[tauri::command]
pub async fn near_account(
    state: State<'_, AppState>,
    account_id: String,
) -> AppResult<NearAccountInfo> {
    let c = ctx(&state);
    let fees = near_backend::fees(&c).await?;
    near_backend::account(&c, &account_id, fees.storage_per_byte).await
}

#[tauri::command]
pub async fn near_txs(state: State<'_, AppState>, account_id: String) -> AppResult<Value> {
    near_backend::txs(&ctx(&state), &account_id).await
}

// ---------------------------------------------------------------- build, sign, broadcast

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NearBuilt {
    /// Unsigned transaction (Borsh, hex): what `near_sign_tx` signs.
    pub tx: String,
    pub summary: NearTxSummary,
    pub context: NearContext,
}

async fn live_context(
    c: &NearCtx<'_>,
    me: &str,
    to: &str,
) -> AppResult<(NearFeeParams, NearContext)> {
    let kind = wallet_core::near_account_kind(to)?;
    // Before building or signing: the RPC is on the app's network (chain id + genesis), synced.
    near_backend::probe(c).await?;
    let fees = near_backend::fees(c).await?;
    let account = near_backend::account(c, me, fees.storage_per_byte).await?;
    let receiver = near_backend::account(c, to, fees.storage_per_byte).await?;
    let creates = near_backend::creates_account(&receiver, kind);
    Ok((
        fees,
        NearContext {
            account,
            receiver,
            creates_account: creates,
            gas_price: fees.gas_price.to_string(),
            fee_estimate: fees.estimate(creates).to_string(),
            fee_bound: fees.bound(creates).to_string(),
        },
    ))
}

fn check(s: &NearTxSummary, fees: &NearFeeParams, c: &NearContext) -> AppResult<()> {
    near_backend::check_transfer(&TransferCheck {
        ours: &c.account,
        receiver: &c.receiver,
        receiver_kind: s.receiver_kind,
        deposit: s
            .deposit
            .parse()
            .map_err(|_| AppError::Internal("montant NEAR illisible".into()))?,
        fees,
    })
}

/// Parses a yoctoNEAR amount (decimal integer string).
fn parse_yocto(amount: &str) -> AppResult<u128> {
    let a = amount.trim();
    if a.is_empty() || a.len() > 40 || !a.bytes().all(|b| b.is_ascii_digit()) {
        return Err(AppError::InvalidInput(
            "montant en yoctoNEAR invalide".into(),
        ));
    }
    a.parse::<u128>()
        .ok()
        .filter(|d| *d > 0)
        .ok_or_else(|| AppError::InvalidInput("montant en yoctoNEAR invalide".into()))
}

/// Builds an unsigned transfer of `amount` yoctoNEAR from live data.
pub(crate) async fn build(
    c: &NearCtx<'_>,
    me: &str,
    pubkey: &[u8; 32],
    to: &str,
    amount: &str,
) -> AppResult<NearBuilt> {
    let to = to.trim();
    wallet_core::near_account_kind(to)?;
    let deposit = parse_yocto(amount)?;
    let (fees, context) = live_context(c, me, to).await?;
    let (key_nonce, block_hash, _) = near_backend::access_key(c, me, pubkey).await?;
    let tx = NearTransfer {
        signer_id: me.to_owned(),
        public_key: *pubkey,
        nonce: key_nonce
            .checked_add(1)
            .ok_or_else(|| AppError::Internal("nonce NEAR au maximum".into()))?,
        receiver_id: to.to_owned(),
        block_hash,
        deposit,
    };
    let hex_tx = hex::encode(tx.encode());
    let summary = wallet_core::near_decode_tx(&hex_tx, me, pubkey)?;
    check(&summary, &fees, &context)?;
    Ok(NearBuilt {
        tx: hex_tx,
        summary,
        context,
    })
}

#[tauri::command]
pub async fn near_build_tx(
    state: State<'_, AppState>,
    to: String,
    amount: String,
    account: Option<u32>,
) -> AppResult<NearBuilt> {
    let (me, pk) = ours(&state, account_arg(account)?)?;
    build(&ctx(&state), &me, &pk, &to, &amount).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NearSigned {
    /// Signed transaction (Borsh, hex): what `near_broadcast` sends.
    pub signed: String,
    pub hash: String,
    pub summary: NearTxSummary,
    pub context: NearContext,
}

/// Decoding + live re-checks, i.e. everything `near_sign_tx` does before the dialog.
pub(crate) async fn prepare_sign(
    c: &NearCtx<'_>,
    me: &str,
    pubkey: &[u8; 32],
    tx_hex: &str,
) -> AppResult<(NearTxSummary, NearContext)> {
    let summary = wallet_core::near_decode_tx(tx_hex, me, pubkey)?;
    let (fees, context) = live_context(c, me, &summary.receiver_id).await?;
    let (key_nonce, _, height) = near_backend::access_key(c, me, pubkey).await?;
    let nonce: u64 = summary.nonce.parse().unwrap_or(0);
    if nonce <= key_nonce {
        return Err(AppError::InvalidInput(
            "nonce périmé (une autre transaction est passée entre-temps) : reconstruis le transfert"
                .into(),
        ));
    }
    let built_at = near_backend::block_height(c, &summary.block_hash).await?;
    if height.saturating_sub(built_at) > MAX_BLOCK_AGE {
        return Err(AppError::InvalidInput(
            "transfert NEAR trop ancien (bloc de référence de plus d'une heure) : reconstruis-le"
                .into(),
        ));
    }
    check(&summary, &fees, &context)?;
    Ok((summary, context))
}

#[tauri::command]
pub async fn near_sign_tx(
    app: AppHandle,
    state: State<'_, AppState>,
    tx: String,
    password: String,
    account: Option<u32>,
) -> AppResult<NearSigned> {
    if !state.is_unlocked() {
        return Err(AppError::Locked);
    }
    let a = account_arg(account)?;
    let (me, pk) = ours(&state, a)?;
    let signer = SignerInfo::new(&state, Chain::Near, a, wallet_core::near_path(a));
    let c = ctx(&state);
    let (summary, context) = prepare_sign(&c, &me, &pk, &tx).await?;
    let seed = seed_from_password(&state, Zeroizing::new(password)).await?;
    let lang = crate::i18n::current();
    confirm_native(
        &app,
        lang.pick("Confirmer l'envoi NEAR", "Confirm the NEAR send"),
        signer.body(
            lang,
            &describe_near(lang, &summary, &context, state.network),
        ),
    )
    .await?;
    confirm_signer(&app, &signer).await?;
    if summary.requires_extra_confirmation {
        confirm_native(
            &app,
            lang.pick(
                "Attention : transfert à vérifier",
                "Warning: transfer to check",
            ),
            describe_near_extra(lang, &summary),
        )
        .await?;
    }
    let t = tx.clone();
    let (signed, hash, again) = blocking(move || Ok(wallet_core::near_sign(&seed, a, &t)?)).await?;
    if again != summary {
        return Err(AppError::Internal(
            "résumé différent entre l'aperçu et la signature".into(),
        ));
    }
    state.touch();
    Ok(NearSigned {
        signed,
        hash,
        summary,
        context,
    })
}

/// Checks the signed transaction (strict decoding, signature by our key, our account) then
/// sends it.
pub(crate) async fn broadcast_checked(
    c: &NearCtx<'_>,
    me: &str,
    signed_hex: &str,
) -> AppResult<NearTxOutcome> {
    let (tx, hash) = wallet_core::near_verify_signed(signed_hex)?;
    if tx.signer_id != me {
        return Err(AppError::InvalidInput(
            "cette transaction n'est pas signée par ton compte".into(),
        ));
    }
    let raw = hex::decode(signed_hex.trim())
        .map_err(|_| AppError::InvalidInput("transaction : hexadécimal attendu".into()))?;
    near_backend::send(c, &raw, &hash).await
}

#[tauri::command]
pub async fn near_broadcast(
    state: State<'_, AppState>,
    signed: String,
    account: Option<u32>,
) -> AppResult<NearTxOutcome> {
    let (me, _) = ours(&state, account_arg(account)?)?;
    broadcast_checked(&ctx(&state), &me, &signed).await
}

/// Status of a sent transaction of account `account` (`pending` until executed).
#[tauri::command]
pub async fn near_tx_status(
    state: State<'_, AppState>,
    hash: String,
    account: Option<u32>,
) -> AppResult<NearTxOutcome> {
    let h = hash.trim();
    wallet_core::near_parse_hash(h)?;
    let (me, _) = ours(&state, account_arg(account)?)?;
    near_backend::tx_status(&ctx(&state), h, &me).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summary(kind: NearAccountKind, warnings: Vec<NearWarning>) -> NearTxSummary {
        NearTxSummary {
            signer_id: "5510e2b44cae6eb807e3e0e45d579dda058c274abcba15e5cb84636f5d1ee412".into(),
            public_key: "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp".into(),
            nonce: "187000000000001".into(),
            receiver_id: "bob.testnet".into(),
            receiver_kind: kind,
            deposit: "1500000000000000000000000".into(),
            block_hash: "244ZQ9cgj3CQ6bWBdytfrJMuMQ1jdXLFGnr4HhvtCTnM".into(),
            hash: "4XTVLd3z94Rjfp5rpNcKNqqfXbKNhf1bwtonhj77uvPs".into(),
            requires_extra_confirmation: !warnings.is_empty(),
            warnings,
        }
    }

    fn context(creates: bool) -> NearContext {
        NearContext {
            account: NearAccountInfo {
                exists: true,
                balance: "10000000000000000000000000".into(),
                storage_reserve: "1820000000000000000000".into(),
                spendable: "9998180000000000000000000".into(),
                ..Default::default()
            },
            receiver: NearAccountInfo {
                exists: !creates,
                ..Default::default()
            },
            creates_account: creates,
            gas_price: "100000000".into(),
            fee_estimate: "44636512500000000000".into(),
            fee_bound: "892730250000000000000".into(),
        }
    }

    #[test]
    fn dialog_shows_receiver_amount_fee_bound_and_key() {
        let d = describe_near(
            Lang::Fr,
            &summary(NearAccountKind::Named, vec![]),
            &context(false),
            Network::Testnet,
        );
        for needle in [
            "Envoi NEAR (testnet)",
            "À : bob.testnet\n(compte nommé)",
            "Montant : 1,5 NEAR (1500000000000000000000000 yoctoNEAR)",
            "Frais : ≈ 0,0000446365125 NEAR — au plus 0,00089273025 NEAR",
            "disponible : 9,99818 NEAR",
            "nonce 187000000000001",
            "Hash de la transaction : 4XTVLd3z94Rjfp5rpNcKNqqfXbKNhf1bwtonhj77uvPs",
        ] {
            assert!(d.contains(needle), "{needle} missing in:\n{d}");
        }
        assert!(!d.contains("n'existe pas encore"));
        let d = describe_near(
            Lang::Fr,
            &summary(NearAccountKind::Implicit, vec![]),
            &context(true),
            Network::Mainnet,
        );
        assert!(d.starts_with("Envoi NEAR\n"));
        assert!(d.contains("ce transfert le crée"));
        assert!(d.contains("compte implicite"));
        let x = describe_near_extra(
            Lang::Fr,
            &summary(
                NearAccountKind::EthImplicit,
                vec![NearWarning::EthImplicitReceiver],
            ),
        );
        assert!(x.contains("style Ethereum") && x.contains("Signer quand même"));
        let d = describe_near(
            Lang::En,
            &summary(NearAccountKind::Named, vec![]),
            &context(false),
            Network::Testnet,
        );
        assert!(
            d.contains("Amount: 1.5 NEAR")
                && d.contains(
                    "To: bob.testnet
(named account)"
                )
        );
    }

    #[test]
    fn amounts() {
        assert_eq!(parse_yocto("1").unwrap(), 1);
        assert_eq!(
            parse_yocto(" 1500000000000000000000000 ").unwrap(),
            1_500_000_000_000_000_000_000_000
        );
        for bad in ["", "0", "-1", "1.5", "1e24", "x", &"9".repeat(41)] {
            assert!(parse_yocto(bad).is_err(), "{bad:?}");
        }
        assert_eq!(near(Lang::Fr, "1"), "0,000000000000000000000001 NEAR");
    }
}
