//! IPC commands for Cardano (`ada_*`): base address (CIP-1852, Icarus), balance and native tokens,
//! history, payment building **by Kyro** (UTxOs and protocol parameters from Koios, encoded by
//! wallet-core), signing behind the password and the native dialog (every output with its ADA,
//! tokens and min-ADA; fee, ttl, memo), and `submittx` with transaction-id check.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, State};
use wallet_core::{CardanoContext, CardanoTxSummary, CardanoWarning, Network};
use zeroize::Zeroizing;

use crate::accounts::{account_arg, confirm_signer, Chain, SignerInfo};
use crate::cardano_backend::{
    self, CardanoAccount, CardanoCtx, Params, PaymentSpec, Tip, Utxo, TTL_OFFSET,
};
use crate::commands::{blocking, cardano_root_from_password, confirm_native, format_units_in};
use crate::error::{AppError, AppResult};
use crate::i18n::Lang;
use crate::servers::{host_of, utxo_network_key, CardanoServer};
use crate::state::AppState;

const INDEX: u32 = 0;

pub(crate) fn ctx(state: &AppState) -> CardanoCtx<'_> {
    let s = state.settings();
    CardanoCtx {
        net_client: &state.net,
        network: state.network,
        tor: s.tor.enabled,
        server: s.servers.cardano.for_network(state.network),
    }
}

fn ours(state: &AppState, account: u32) -> AppResult<(String, [u8; 32])> {
    let net = state.network;
    state.with_cardano(|r| {
        Ok((
            wallet_core::cardano_address(r, net, account, INDEX)?,
            wallet_core::cardano_payment_public_key(r, account, INDEX)?,
        ))
    })
}

pub(crate) fn payment_path(account: u32) -> String {
    format!("{}/0/{INDEX}", wallet_core::cardano_account_path(account))
}

fn ada(lang: Lang, lovelace: &str) -> String {
    format!("{} ADA", format_units_in(lang, lovelace, 6))
}

/// Live context shown in the dialog.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardanoContextOut {
    pub account: CardanoAccount,
    pub params: Params,
    pub tip: Tip,
    /// Lovelace leaving the wallet: outputs to other addresses + fee.
    pub leaving: String,
}

fn token_line(lang: Lang, t: &wallet_core::CardanoTokenView) -> String {
    let name = match &t.name_text {
        Some(text) => format!(
            "{} (hex {})",
            crate::dialog_text::field(text, 40),
            if t.name.is_empty() {
                lang.pick("vide", "empty")
            } else {
                &t.name
            }
        ),
        None if t.name.is_empty() => lang.pick("(nom vide)", "(empty name)").to_owned(),
        None => format!("hex {}", t.name),
    };
    format!(
        "    + {} × {name}{}\n      policy {}\n",
        t.quantity,
        if t.verified {
            lang.pick("  ✓ vérifié", "  ✓ verified")
        } else {
            lang.pick("  ⚠ NON VÉRIFIÉ", "  ⚠ NOT VERIFIED")
        },
        t.policy
    )
}

pub(crate) fn describe_ada(
    lang: Lang,
    s: &CardanoTxSummary,
    c: &CardanoContextOut,
    net: Network,
) -> String {
    let ada = |l: &str| ada(lang, l);
    let preprod = if net == Network::Testnet {
        " (preprod)"
    } else {
        ""
    };
    let mut out = match lang {
        Lang::Fr => format!("Envoi Cardano{preprod}\n"),
        Lang::En => format!("Cardano send{preprod}\n"),
    };
    for (i, o) in s.outputs.iter().enumerate() {
        out += &format!(
            "\n{} {} — {}\n  {}\n  {}{}\n",
            lang.pick("Sortie", "Output"),
            i + 1,
            if o.is_change {
                lang.pick(
                    "monnaie rendue (ton adresse)",
                    "change returned (your address)",
                )
            } else {
                lang.pick("DESTINATAIRE", "RECIPIENT")
            },
            o.address,
            ada(&o.lovelace),
            if o.tokens.is_empty() {
                String::new()
            } else {
                match lang {
                    Lang::Fr => format!(
                        " (dont {} minimum obligatoire avec les tokens)",
                        ada(&o.min_lovelace)
                    ),
                    Lang::En => format!(
                        " (including the {} minimum required with the tokens)",
                        ada(&o.min_lovelace)
                    ),
                }
            }
        );
        for t in &o.tokens {
            out += &token_line(lang, t);
        }
        if o.kind == "enterprise" {
            out += lang.pick(
                "  (adresse « enterprise » : sans partie staking)\n",
                "  (“enterprise” address: no staking part)\n",
            );
        }
    }
    out += &match lang {
        Lang::Fr => format!(
            "\nFrais : {} ({} lovelace)\nTotal qui quitte le portefeuille : {}\n",
            ada(&s.fee),
            s.fee,
            ada(&c.leaving)
        ),
        Lang::En => format!(
            "\nFee: {} ({} lovelace)\nTotal leaving the wallet: {}\n",
            ada(&s.fee),
            s.fee,
            ada(&c.leaving)
        ),
    };
    match (s.ttl, lang) {
        (Some(t), Lang::Fr) => {
            out += &format!(
                "Valable jusqu'au slot {t} (≈ {} min)\n",
                t.saturating_sub(c.tip.slot) / 60
            )
        }
        (Some(t), Lang::En) => {
            out += &format!(
                "Valid until slot {t} (≈ {} min)\n",
                t.saturating_sub(c.tip.slot) / 60
            )
        }
        (None, Lang::Fr) => out += "AUCUNE LIMITE DE VALIDITÉ (ttl absent)\n",
        (None, Lang::En) => out += "NO VALIDITY LIMIT (no ttl)\n",
    }
    if let Some(v) = s.valid_from {
        out += &match lang {
            Lang::Fr => format!("Pas valable avant le slot {v}\n"),
            Lang::En => format!("Not valid before slot {v}\n"),
        };
    }
    out += &match lang {
        Lang::Fr => format!(
            "\nSolde : {} · {} entrée(s) · id {}\n",
            ada(&c.account.balance),
            s.inputs.len(),
            s.tx_id
        ),
        Lang::En => format!(
            "\nBalance: {} · {} input(s) · id {}\n",
            ada(&c.account.balance),
            s.inputs.len(),
            s.tx_id
        ),
    };
    if let Some(m) = &s.memo {
        out += &format!(
            "\n{}{}\n",
            lang.pick(
                "Message (CIP-20, public à jamais, texte libre non vérifié) : ",
                "Message (CIP-20, public forever, free text not verified): "
            ),
            crate::dialog_text::field(&m.concat(), crate::dialog_text::MAX_FIELD)
        );
    }
    out
}

pub(crate) fn describe_ada_extra(lang: Lang, s: &CardanoTxSummary) -> String {
    let mut out = String::from(lang.pick(
        "Kyro a trouvé des éléments à vérifier dans cette transaction :\n",
        "Kyro found some things to check in this transaction:\n",
    ));
    for w in &s.warnings {
        out += &match (w, lang) {
            (CardanoWarning::Memo, _) => lang
                .pick(
                    "• un message (métadonnée CIP-20), lisible par tous et pour toujours\n",
                    "• a message (CIP-20 metadata), readable by everyone, forever\n",
                )
                .to_owned(),
            (CardanoWarning::UnknownToken { policy, name }, Lang::Fr) => format!(
                "• token NON VÉRIFIÉ : n'importe qui peut créer un token avec le même nom affiché ; seule la policy compte\n  policy {policy}\n  nom hex {}\n",
                if name.is_empty() { "(vide)" } else { name }
            ),
            (CardanoWarning::UnknownToken { policy, name }, Lang::En) => format!(
                "• token NOT VERIFIED: anyone can create a token with the same displayed name; only the policy counts\n  policy {policy}\n  hex name {}\n",
                if name.is_empty() { "(empty)" } else { name }
            ),
            (CardanoWarning::HighFee, _) => lang
                .pick(
                    "• frais supérieurs à 5 ADA (d'habitude ~0,2 ADA)\n",
                    "• fee above 5 ADA (usually ~0.2 ADA)\n",
                )
                .to_owned(),
            (CardanoWarning::NoTtl, _) => lang
                .pick(
                    "• aucune limite de validité : la transaction resterait valable indéfiniment\n",
                    "• no validity limit: the transaction would stay valid forever\n",
                )
                .to_owned(),
            (CardanoWarning::UnusualText, _) => lang
                .pick(
                    "• message ou nom de token contenant des caractères invisibles / de contrôle (affiché nettoyé)\n",
                    "• message or token name with invisible / control characters (shown cleaned)\n",
                )
                .to_owned(),
        };
    }
    out += "\n";
    out += lang.sign_anyway();
    out
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardanoBackendInfo {
    pub kind: &'static str,
    pub network: &'static str,
    pub label: String,
    pub tor: bool,
}

#[tauri::command]
pub fn ada_backend_info(state: State<'_, AppState>) -> CardanoBackendInfo {
    let c = ctx(&state);
    CardanoBackendInfo {
        kind: c.server.kind_name(),
        network: utxo_network_key(state.network),
        label: cardano_backend::url(&c)
            .ok()
            .as_deref()
            .and_then(host_of)
            .unwrap_or_default(),
        tor: c.tor,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardanoAddressOut {
    pub address: String,
    pub path: String,
    pub stake_address: String,
    /// Account public key `m/1852'/1815'/a'` (public key ‖ chain code, hex).
    pub account_xpub: String,
}

#[tauri::command]
pub fn ada_address(
    state: State<'_, AppState>,
    index: u32,
    account: Option<u32>,
) -> AppResult<CardanoAddressOut> {
    let net = state.network;
    let a = account_arg(account)?;
    state.with_cardano(|r| {
        Ok(CardanoAddressOut {
            address: wallet_core::cardano_address(r, net, a, index)?,
            path: format!("{}/0/{index}", wallet_core::cardano_account_path(a)),
            stake_address: wallet_core::cardano_account_stake_address(r, net, a)?,
            account_xpub: wallet_core::cardano_account_xpub(r, a)?,
        })
    })
}

pub(crate) async fn account_and_utxos(
    c: &CardanoCtx<'_>,
    address: &str,
    p: &Params,
) -> AppResult<(CardanoAccount, Vec<Utxo>)> {
    let u = cardano_backend::utxos(c, address).await?;
    Ok((
        cardano_backend::account_of(c.network, address, &u, p.coins_per_byte)?,
        u,
    ))
}

#[tauri::command]
pub async fn ada_account(state: State<'_, AppState>, address: String) -> AppResult<CardanoAccount> {
    let c = ctx(&state);
    let p = cardano_backend::params(&c).await?;
    Ok(account_and_utxos(&c, &address, &p).await?.0)
}

#[tauri::command]
pub async fn ada_txs(state: State<'_, AppState>, address: String) -> AppResult<Value> {
    cardano_backend::txs(&ctx(&state), &address).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardanoTxStatus {
    /// `None`: not (yet) seen by the indexer.
    pub confirmations: Option<u64>,
}

#[tauri::command]
pub async fn ada_tx_status(state: State<'_, AppState>, hash: String) -> AppResult<CardanoTxStatus> {
    let h = hash.trim().to_ascii_lowercase();
    if h.len() != 64 || !h.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(AppError::InvalidInput(
            "hash: 64 hexadecimal characters".into(),
        ));
    }
    Ok(CardanoTxStatus {
        confirmations: cardano_backend::tx_status(&ctx(&state), &h).await?,
    })
}

/// Native token to send.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenSpec {
    /// Policy id, 56 hex.
    pub policy: String,
    /// Asset name, hex (may be empty).
    pub name: String,
    /// Integer quantity, decimal string.
    pub quantity: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardanoBuilt {
    /// Unsigned transaction (CBOR hex): what `ada_sign_tx` signs.
    pub tx: String,
    pub summary: CardanoTxSummary,
    pub context: CardanoContextOut,
}

fn decode_ctx<'a>(
    net: Network,
    own: &'a [String],
    verified: &'a [(&'static str, &'static str)],
    p: &Params,
) -> CardanoContext<'a> {
    CardanoContext {
        net,
        own,
        verified_tokens: verified,
        coins_per_byte: p.coins_per_byte,
    }
}

pub(crate) async fn build(
    c: &CardanoCtx<'_>,
    me: &str,
    to: &str,
    lovelace: Option<&str>,
    token: Option<&TokenSpec>,
    memo: Option<&str>,
) -> AppResult<CardanoBuilt> {
    let to_b = wallet_core::cardano_address_bytes(to, c.network)?;
    let me_b = wallet_core::cardano_address_bytes(me, c.network)?;
    let lovelace = match lovelace.map(str::trim).filter(|s| !s.is_empty()) {
        None => None,
        Some(s) => Some(
            s.parse::<u64>()
                .ok()
                .filter(|v| *v > 0)
                .ok_or_else(|| AppError::InvalidInput("invalid lovelace amount".into()))?,
        ),
    };
    let token = token
        .map(|t| -> AppResult<(String, String, u64)> {
            let policy = t.policy.trim().to_ascii_lowercase();
            let name = t.name.trim().to_ascii_lowercase();
            if policy.len() != 56
                || hex::decode(&policy).is_err()
                || name.len() > 64
                || hex::decode(&name).is_err()
            {
                return Err(AppError::InvalidInput(
                    "token: policy id (56 hex) and asset name (hex, 32 bytes max)".into(),
                ));
            }
            let q = t
                .quantity
                .trim()
                .parse::<u64>()
                .ok()
                .filter(|q| *q > 0)
                .ok_or_else(|| AppError::InvalidInput("invalid token quantity".into()))?;
            Ok((policy, name, q))
        })
        .transpose()?;
    let p = cardano_backend::params(c).await?;
    let tip = cardano_backend::tip(c).await?;
    let (account, utxos) = account_and_utxos(c, me, &p).await?;
    let plan = cardano_backend::plan(
        &utxos,
        &me_b,
        &PaymentSpec {
            to: to_b,
            lovelace,
            token,
            memo: memo.map(str::to_owned),
        },
        &p,
        tip.slot + TTL_OFFSET,
    )?;
    let leaving = cardano_backend::check_balance(&plan.body, &utxos, &me_b)?;
    let tx = hex::encode(wallet_core::cardano_unsigned_tx(
        &plan.body,
        plan.aux.as_deref(),
    )?);
    let own = [me.to_owned()];
    let verified = cardano_backend::verified_tokens(c.network);
    let summary = wallet_core::cardano_decode_tx(&tx, &decode_ctx(c.network, &own, &verified, &p))?;
    Ok(CardanoBuilt {
        tx,
        summary,
        context: CardanoContextOut {
            account,
            params: p,
            tip,
            leaving: leaving.to_string(),
        },
    })
}

#[tauri::command]
pub async fn ada_build_tx(
    state: State<'_, AppState>,
    to: String,
    lovelace: Option<String>,
    token: Option<TokenSpec>,
    memo: Option<String>,
    account: Option<u32>,
) -> AppResult<CardanoBuilt> {
    let (me, _) = ours(&state, account_arg(account)?)?;
    build(
        &ctx(&state),
        &me,
        &to,
        lovelace.as_deref(),
        token.as_ref(),
        memo.as_deref(),
    )
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardanoSigned {
    /// Signed transaction (CBOR hex): what `ada_broadcast` submits.
    pub tx: String,
    pub tx_id: String,
    pub summary: CardanoTxSummary,
    pub context: CardanoContextOut,
}

pub(crate) async fn prepare_sign(
    c: &CardanoCtx<'_>,
    me: &str,
    tx: &str,
) -> AppResult<(CardanoTxSummary, CardanoContextOut)> {
    let p = cardano_backend::params(c).await?;
    let own = [me.to_owned()];
    let verified = cardano_backend::verified_tokens(c.network);
    let dctx = decode_ctx(c.network, &own, &verified, &p);
    let summary = wallet_core::cardano_decode_tx(tx, &dctx)?;
    let body = wallet_core::cardano_tx_body(tx, &dctx)?;
    let tip = cardano_backend::tip(c).await?;
    if summary.ttl.is_some_and(|t| t <= tip.slot) {
        return Err(AppError::InvalidInput(
            "Cardano transaction expired (ttl passed): rebuild it".into(),
        ));
    }
    let (account, utxos) = account_and_utxos(c, me, &p).await?;
    let me_b = wallet_core::cardano_address_bytes(me, c.network)?;
    let leaving = cardano_backend::check_balance(&body, &utxos, &me_b)?;
    let aux_extra =
        (tx.trim().len() / 2).saturating_sub(wallet_core::cardano_unsigned_tx(&body, None)?.len());
    let size = wallet_core::cardano_signed_size(&body, None, 1)? + aux_extra;
    let min = p.min_fee(size);
    if body.fee < min {
        return Err(AppError::InvalidInput(format!(
            "fee too low ({} lovelace, minimum {min}): the node would reject the transaction",
            body.fee
        )));
    }
    Ok((
        summary,
        CardanoContextOut {
            account,
            params: p,
            tip,
            leaving: leaving.to_string(),
        },
    ))
}

#[tauri::command]
pub async fn ada_sign_tx(
    app: AppHandle,
    state: State<'_, AppState>,
    tx: String,
    password: String,
    account: Option<u32>,
) -> AppResult<CardanoSigned> {
    if !state.is_unlocked() {
        return Err(AppError::Locked);
    }
    let a = account_arg(account)?;
    let (me, _) = ours(&state, a)?;
    let signer = SignerInfo::new(&state, Chain::Ada, a, payment_path(a));
    let c = ctx(&state);
    let (summary, context) = prepare_sign(&c, &me, &tx).await?;
    let root = cardano_root_from_password(&state, Zeroizing::new(password)).await?;
    let lang = crate::i18n::current();
    confirm_native(
        &app,
        lang.pick(
            "Confirmer la transaction Cardano",
            "Confirm the Cardano transaction",
        ),
        signer.body(lang, &describe_ada(lang, &summary, &context, state.network)),
    )
    .await?;
    confirm_signer(&app, &signer).await?;
    if summary.requires_extra_confirmation {
        confirm_native(
            &app,
            lang.check_tx_title(),
            describe_ada_extra(lang, &summary),
        )
        .await?;
    }
    let net = state.network;
    let coins_per_byte = context.params.coins_per_byte;
    let t = tx.clone();
    let m = me.clone();
    let (signed, tx_id, again) = blocking(move || {
        let own = [m];
        let verified = cardano_backend::verified_tokens(net);
        let dctx = CardanoContext {
            net,
            own: &own,
            verified_tokens: &verified,
            coins_per_byte,
        };
        Ok(wallet_core::cardano_sign(&root, a, INDEX, &t, &dctx)?)
    })
    .await?;
    if again != summary {
        return Err(AppError::Internal(
            "summary differs between the preview and the signature".into(),
        ));
    }
    state.touch();
    Ok(CardanoSigned {
        tx: signed,
        tx_id,
        summary,
        context,
    })
}

/// Checks the signed transaction (every vkey witness verifies over the tx id, and the only
/// witness is our payment key) then submits it; Koios must answer the same tx id.
pub(crate) async fn broadcast_checked(
    c: &CardanoCtx<'_>,
    our_key: &[u8; 32],
    tx: &str,
) -> AppResult<String> {
    let (tx_id, keys) = wallet_core::cardano_signed_witnesses(tx)?;
    if keys.as_slice() != [*our_key] {
        return Err(AppError::InvalidInput(
            "this transaction is not signed (only) by your Cardano key".into(),
        ));
    }
    let bytes = hex::decode(tx.trim()).map_err(|_| AppError::InvalidInput("tx hex".into()))?;
    cardano_backend::submit(c, bytes, &tx_id).await
}

#[tauri::command]
pub async fn ada_broadcast(
    state: State<'_, AppState>,
    tx: String,
    account: Option<u32>,
) -> AppResult<String> {
    let (_, pk) = ours(&state, account_arg(account)?)?;
    broadcast_checked(&ctx(&state), &pk, &tx).await
}

pub(crate) async fn probe(
    net: &crate::net::NetClient,
    network: Network,
    server: &CardanoServer,
    tor: bool,
) -> AppResult<crate::btc_backend::Detected> {
    cardano_backend::probe(&CardanoCtx {
        net_client: net,
        network,
        tor,
        server: server.clone(),
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use wallet_core::{CardanoOutputView, CardanoTokenView};

    fn summary() -> CardanoTxSummary {
        CardanoTxSummary {
            tx_id: "ab".repeat(32),
            inputs: vec![format!("{}#0", "cd".repeat(32))],
            outputs: vec![
                CardanoOutputView {
                    address: "addr_test1qz2f…".into(),
                    kind: "base".into(),
                    is_change: false,
                    lovelace: "1189560".into(),
                    tokens: vec![CardanoTokenView {
                        policy: "95a292ffee938be03e9bae5657982a74e9014eb4960108c9e23a5b39".into(),
                        name: "74652474436f696e".into(),
                        name_text: Some("te$tCoin".into()),
                        quantity: "5".into(),
                        verified: false,
                    }],
                    min_lovelace: "1189560".into(),
                },
                CardanoOutputView {
                    address: "addr_test1qrme…".into(),
                    kind: "base".into(),
                    is_change: true,
                    lovelace: "8634927".into(),
                    tokens: vec![],
                    min_lovelace: "969750".into(),
                },
            ],
            fee: "175513".into(),
            ttl: Some(1_003_600),
            valid_from: None,
            memo: Some(vec!["merci".into()]),
            warnings: vec![
                CardanoWarning::UnknownToken {
                    policy: "95a292ffee938be03e9bae5657982a74e9014eb4960108c9e23a5b39".into(),
                    name: "74652474436f696e".into(),
                },
                CardanoWarning::Memo,
            ],
            requires_extra_confirmation: true,
        }
    }

    fn context() -> CardanoContextOut {
        CardanoContextOut {
            account: CardanoAccount {
                address: "addr_test1qrme…".into(),
                balance: "10000000".into(),
                tokens: vec![],
                utxo_count: 1,
                locked_with_tokens: "0".into(),
            },
            params: Params {
                min_fee_a: 44,
                min_fee_b: 155_381,
                coins_per_byte: 4310,
                max_tx_size: 16_384,
            },
            tip: Tip {
                slot: 1_000_000,
                block_height: 1,
                epoch: 1,
            },
            leaving: "1365073".into(),
        }
    }

    #[test]
    fn dialog_lists_every_output_with_tokens_and_min_ada() {
        let d = describe_ada(Lang::Fr, &summary(), &context(), Network::Testnet);
        for needle in [
            "Envoi Cardano (preprod)",
            "Sortie 1 — DESTINATAIRE\n  addr_test1qz2f…\n  1,18956 ADA (dont 1,18956 ADA minimum obligatoire avec les tokens)",
            "+ 5 × « te$tCoin » (hex 74652474436f696e)  ⚠ NON VÉRIFIÉ\n      policy 95a292ffee938be03e9bae5657982a74e9014eb4960108c9e23a5b39",
            "Sortie 2 — monnaie rendue (ton adresse)\n  addr_test1qrme…\n  8,634927 ADA\n",
            "Frais : 0,175513 ADA (175513 lovelace)",
            "Total qui quitte le portefeuille : 1,365073 ADA",
            "Valable jusqu'au slot 1003600 (≈ 60 min)",
            "Message (CIP-20, public à jamais, texte libre non vérifié) : « merci »",
        ] {
            assert!(d.contains(needle), "{needle} missing in:\n{d}");
        }
        let x = describe_ada_extra(Lang::Fr, &summary());
        assert!(x.contains("NON VÉRIFIÉ") && x.contains("policy 95a292ff") && x.contains("CIP-20"));
    }

    #[test]
    fn dialog_in_english() {
        let d = describe_ada(Lang::En, &summary(), &context(), Network::Testnet);
        for needle in [
            "Cardano send (preprod)",
            "Output 1 — RECIPIENT\n  addr_test1qz2f…\n  1.18956 ADA (including the 1.18956 ADA minimum required with the tokens)",
            "  ⚠ NOT VERIFIED",
            "Output 2 — change returned (your address)",
            "Fee: 0.175513 ADA (175513 lovelace)",
            "Total leaving the wallet: 1.365073 ADA",
            "Valid until slot 1003600 (≈ 60 min)",
            "Message (CIP-20, public forever, free text not verified): « merci »",
        ] {
            assert!(d.contains(needle), "{needle} missing in:\n{d}");
        }
        let x = describe_ada_extra(Lang::En, &summary());
        assert!(x.contains("NOT VERIFIED") && x.contains("only the policy counts"));
        for fr in ["Sortie", "Frais", "Solde", "VÉRIFIÉ", "Signer"] {
            assert!(!d.contains(fr) && !x.contains(fr), "{fr}");
        }
    }
}
