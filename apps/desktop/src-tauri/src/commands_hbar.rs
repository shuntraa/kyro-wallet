//! IPC commands for Hedera (`hbar_*`): EVM address (alias) of the key, our account (found on
//! the mirror node by alias or public key), recipient facts, history, HBAR transfers built **by
//! Kyro** (one copy per consensus node, same transaction ID), signing behind the password and
//! the native dialog (memo framed, balance and recipient re-read live), and submission to the
//! nodes' gRPC-web proxies. Contract: docs/IPC.md §2.11.

use serde::Serialize;
use tauri::{AppHandle, State};
use wallet_core::{HbarKind, HbarRecipient, HbarTransfer, HbarTxSummary, HbarWarning, Network};
use zeroize::Zeroizing;

use crate::accounts::{account_arg, confirm_signer, Chain, SignerInfo};
use crate::commands::{blocking, confirm_native, format_units_in, seed_from_password};
use crate::error::{AppError, AppResult};
use crate::hbar_backend::{
    self, HbarAccountInfo, HbarCtx, HbarTokenHolding, START_SKEW, VALID_DURATION,
};
use crate::i18n::Lang;
use crate::state::AppState;

pub(crate) fn ctx(state: &AppState) -> HbarCtx<'_> {
    HbarCtx {
        net_client: &state.net,
        network: state.network,
        tor: state.settings().tor.enabled,
    }
}

/// EVM address and public key of Hedera account `account` (`m/44'/3030'/0'/0/account`).
fn ours(state: &AppState, account: u32) -> AppResult<(String, [u8; 33])> {
    state.with_seed(|seed| {
        Ok((
            wallet_core::hbar_evm_address(seed, account)?,
            wallet_core::hbar_public_key(seed, account)?,
        ))
    })
}

/// The key of the account that sends: the vault's ECDSA key (and its EVM address), or a
/// hardware account's ED25519 key (Ledger, `commands_hw_hbar.rs`).
#[derive(Clone, Copy)]
pub(crate) enum OurKey<'a> {
    Ecdsa { evm: &'a str, pk: &'a [u8; 33] },
    Ed25519(&'a [u8; 32]),
}

impl OurKey<'_> {
    async fn account(self, c: &HbarCtx<'_>) -> AppResult<HbarAccountInfo> {
        match self {
            OurKey::Ecdsa { evm, pk } => hbar_backend::our_account(c, evm, pk).await,
            OurKey::Ed25519(pk) => hbar_backend::our_account_ed25519(c, pk).await,
        }
    }

    /// Hardware (ED25519) accounts: HBAR only, token transfers and associations are refused.
    fn decode(
        self,
        net: Network,
        bodies: &[String],
        num: u64,
        nodes: &[u64],
    ) -> AppResult<HbarTxSummary> {
        Ok(match self {
            OurKey::Ecdsa { pk, .. } => wallet_core::hbar_decode_tx_on(net, bodies, num, pk, nodes)?,
            OurKey::Ed25519(_) => wallet_core::hbar_decode_tx_ed25519(bodies, num, nodes)?,
        })
    }

    /// Strict check of a signed copy: body, and signed by this key.
    fn verify(self, signed: &str) -> AppResult<HbarTransfer> {
        let (t, ours) = match self {
            OurKey::Ecdsa { pk, .. } => {
                let v = wallet_core::hbar_verify_signed(signed)?;
                (v.transfer, v.public_key == *pk)
            }
            OurKey::Ed25519(pk) => {
                let (t, k) = wallet_core::hbar_verify_signed_ed25519(signed)?;
                (t, k == *pk)
            }
        };
        if !ours {
            return Err(AppError::InvalidInput(
                "ce transfert n'est pas signé par ton compte".into(),
            ));
        }
        Ok(t)
    }

    fn no_account(self) -> &'static str {
        match self {
            OurKey::Ecdsa { .. } => "ton compte Hedera n'existe pas encore : il est créé par le premier HBAR reçu sur ton adresse EVM",
            OurKey::Ed25519(_) => "aucun compte Hedera n'a cette clé ED25519 : crée d'abord le compte (Ledger Live, HashPack…) avec ce Ledger",
        }
    }
}

fn hbar(lang: Lang, tinybars: &str) -> String {
    format!("{} HBAR", format_units_in(lang, tinybars, 8))
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn num_of(id: &str) -> Option<u64> {
    id.strip_prefix("0.0.")?.parse().ok()
}

/// Live context shown in the dialog.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HbarContext {
    pub account: HbarAccountInfo,
    pub recipient: HbarAccountInfo,
    /// The transfer auto-creates the recipient's account (EVM address without account).
    pub creates_account: bool,
    /// Token transfer / association: our holding and the recipient's, read live.
    pub token: Option<HbarTokenContext>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HbarTokenContext {
    pub ours: HbarTokenHolding,
    /// `None` for an association (or a recipient without an account yet).
    pub recipient: Option<HbarTokenHolding>,
}

fn token_units(lang: Lang, units: &str, t: &wallet_core::HbarTokenSummary) -> String {
    format!(
        "{} {}",
        format_units_in(lang, units, t.decimals as usize),
        t.symbol
    )
}

/// Dialog of a token association (TokenAssociate).
fn describe_associate(
    lang: Lang,
    s: &HbarTxSummary,
    c: &HbarContext,
    t: &wallet_core::HbarTokenSummary,
    testnet: &str,
) -> String {
    let h = |v: &str| hbar(lang, v);
    match lang {
        Lang::Fr => format!(
            "Associer {sym} à ton compte Hedera{testnet}\n\nJeton : {sym} ({}) · {} (vérifié, table de Kyro) · {} décimales\nCompte : {}\nEffet : ton compte pourra recevoir et détenir des {sym}. Rien n'est envoyé à personne.\n\nFrais maximum : {} (association ≈ 0,05 $, seuls les frais réels sont prélevés)\nSolde : {}\nValable {} s, identifiant {}\nSignée pour {} nœud(s) ({}) : même identifiant, exécutée une seule fois au plus.\n",
            t.name, t.token_id, t.decimals, s.from, h(&s.max_fee), h(&c.account.balance),
            s.valid_duration, s.transaction_id, s.nodes.len(), s.nodes.join(", "),
            sym = t.symbol
        ),
        Lang::En => format!(
            "Associate {sym} with your Hedera account{testnet}\n\nToken: {sym} ({}) · {} (verified, Kyro's table) · {} decimals\nAccount: {}\nEffect: your account can then receive and hold {sym}. Nothing is sent to anyone.\n\nMaximum fee: {} (association ≈ $0.05, only the actual fee is charged)\nBalance: {}\nValid for {} s, ID {}\nSigned for {} node(s) ({}): same ID, executed at most once.\n",
            t.name, t.token_id, t.decimals, s.from, h(&s.max_fee), h(&c.account.balance),
            s.valid_duration, s.transaction_id, s.nodes.len(), s.nodes.join(", "),
            sym = t.symbol
        ),
    }
}

pub(crate) fn describe_hbar(
    lang: Lang,
    s: &HbarTxSummary,
    c: &HbarContext,
    net: Network,
) -> String {
    let line = "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━";
    let h = |v: &str| hbar(lang, v);
    let testnet = if net == Network::Testnet {
        " (testnet)"
    } else {
        ""
    };
    if let Some(t) = s.token.as_ref().filter(|t| t.associate) {
        return describe_associate(lang, s, c, t, testnet);
    }
    let title = match &s.token {
        Some(t) => match lang {
            Lang::Fr => format!(
                "Envoi {} sur Hedera{testnet}\n\nJeton : {} ({}) · {} (vérifié, table de Kyro) · {} décimales",
                t.symbol, t.symbol, t.name, t.token_id, t.decimals
            ),
            Lang::En => format!(
                "{} send on Hedera{testnet}\n\nToken: {} ({}) · {} (verified, Kyro's table) · {} decimals",
                t.symbol, t.symbol, t.name, t.token_id, t.decimals
            ),
        },
        None => format!("{}{testnet}", lang.pick("Envoi Hedera", "Hedera send")),
    };
    let mut out = format!(
        "{}\n\n{}{}{}\n",
        title,
        lang.pick("À : ", "To: "),
        s.to,
        if s.to_is_evm {
            lang.pick(
                " (adresse EVM : l'alias du compte)",
                " (EVM address: the account's alias)",
            )
        } else {
            ""
        }
    );
    if s.to_is_evm {
        if let Some(id) = &c.recipient.account_id {
            out += &match lang {
                Lang::Fr => format!("Compte de cette adresse selon le nœud miroir : {id}\n"),
                Lang::En => format!("Account of this address according to the mirror node: {id}\n"),
            };
        }
    }
    match (&s.token, &c.token) {
        (Some(t), Some(tc)) => {
            out += &format!(
                "{}{} ({} {})\n{}{}\n",
                lang.pick("Montant : ", "Amount: "),
                token_units(lang, &s.amount, t),
                s.amount,
                lang.pick("unités", "units"),
                lang.pick("Ton solde : ", "Your balance: "),
                token_units(lang, &tc.ours.balance, t)
            );
            if tc.recipient.as_ref().is_some_and(|r| !r.associated) {
                out += lang.pick(
                    "Le destinataire n'a pas encore associé ce jeton : il le sera automatiquement (association automatique de son compte).\n",
                    "The recipient has not associated this token yet: it will be associated automatically (their account's automatic association).\n",
                );
            }
        }
        _ => {
            out += &format!(
                "{}{} ({} tinybars)\n",
                lang.pick("Montant : ", "Amount: "),
                h(&s.amount),
                s.amount
            );
        }
    }
    if c.creates_account {
        out += lang.pick(
            "\nCette adresse n'a pas encore de compte Hedera : ce transfert le crée (frais de création ≈ 0,05 $, payés par toi).\n",
            "\nThis address has no Hedera account yet: this transfer creates it (creation fee ≈ $0.05, paid by you).\n",
        );
    }
    out += &match lang {
        Lang::Fr => format!(
            "\nFrais maximum : {} (seuls les frais réels sont prélevés : ≈ 0,0001 $ pour un transfert)\nDepuis : {} · solde : {}\n",
            h(&s.max_fee),
            s.from,
            h(&c.account.balance)
        ),
        Lang::En => format!(
            "\nMaximum fee: {} (only the actual fee is charged: ≈ $0.0001 for a transfer)\nFrom: {} · balance: {}\n",
            h(&s.max_fee),
            s.from,
            h(&c.account.balance)
        ),
    };
    out += &match lang {
        Lang::Fr => format!(
            "Valable {} s, identifiant {}\nSignée pour {} nœud(s) ({}) : même identifiant, exécutée une seule fois au plus.\n",
            s.valid_duration,
            s.transaction_id,
            s.nodes.len(),
            s.nodes.join(", ")
        ),
        Lang::En => format!(
            "Valid for {} s, ID {}\nSigned for {} node(s) ({}): same ID, executed at most once.\n",
            s.valid_duration,
            s.transaction_id,
            s.nodes.len(),
            s.nodes.join(", ")
        ),
    };
    // Free text: after the amounts and fees, framed, one quoted line.
    out += &format!("{line}\n");
    match &s.memo {
        Some(m) => {
            out += &format!(
                "{}{}\n",
                lang.pick("MÉMO (public à jamais) : ", "MEMO (public forever): "),
                crate::dialog_text::field(m, crate::dialog_text::MAX_FIELD)
            )
        }
        None => out += lang.pick(
            "AUCUN MÉMO\n(une plateforme d'échange en exige souvent un : sans lui, les fonds peuvent être perdus)\n",
            "NO MEMO\n(an exchange often requires one: without it, the funds can be lost)\n",
        ),
    }
    out += &format!("{line}\n");
    out
}

pub(crate) fn describe_hbar_extra(lang: Lang, s: &HbarTxSummary) -> String {
    let mut out = String::from(lang.pick(
        "Kyro a trouvé des éléments inhabituels dans ce transfert :\n",
        "Kyro found unusual elements in this transfer:\n",
    ));
    for w in &s.warnings {
        out += match w {
            HbarWarning::HighFee => lang.pick(
                "• frais maximum supérieurs à 2 HBAR (un transfert coûte d'habitude ≈ 0,0001 $)\n",
                "• maximum fee above 2 HBAR (a transfer usually costs ≈ $0.0001)\n",
            ),
            HbarWarning::UnusualText => lang.pick(
                "• mémo contenant des caractères invisibles / de contrôle, ou trop long (affiché nettoyé)\n",
                "• memo containing invisible / control characters, or too long (shown cleaned)\n",
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
pub struct HbarBackendInfo {
    pub network: &'static str,
    pub label: String,
    pub tor: bool,
}

#[tauri::command]
pub fn hbar_backend_info(state: State<'_, AppState>) -> HbarBackendInfo {
    let c = ctx(&state);
    HbarBackendInfo {
        network: crate::servers::utxo_network_key(state.network),
        label: crate::servers::host_of(hbar_backend::mirror_base(state.network))
            .unwrap_or_default(),
        tor: c.tor,
    }
}

/// EVM address (EIP-55) of Hedera account `account` (absent = 0): where the account is
/// auto-created by the first incoming transfer.
#[tauri::command]
pub fn hbar_address(state: State<'_, AppState>, account: Option<u32>) -> AppResult<String> {
    Ok(ours(&state, account_arg(account)?)?.0)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HbarOwnAccount {
    /// Our EVM address (EIP-55), from the key (the mirror's `evmAddress` is in `info`).
    pub address: String,
    /// `0.0.x-checksum` of this network when the account exists.
    pub account_id_checksum: Option<String>,
    #[serde(flatten)]
    pub info: HbarAccountInfo,
}

/// Our account on the mirror node (by alias, else by public key).
#[tauri::command]
pub async fn hbar_account(
    state: State<'_, AppState>,
    account: Option<u32>,
) -> AppResult<HbarOwnAccount> {
    let (evm, pk) = ours(&state, account_arg(account)?)?;
    own_account(
        &ctx(&state),
        OurKey::Ecdsa { evm: &evm, pk: &pk },
        evm.clone(),
    )
    .await
}

/// Our account on the mirror node, with `address` (EVM address, or the hardware account's key).
pub(crate) async fn own_account(
    c: &HbarCtx<'_>,
    key: OurKey<'_>,
    address: String,
) -> AppResult<HbarOwnAccount> {
    let info = key.account(c).await?;
    Ok(HbarOwnAccount {
        account_id_checksum: info
            .account_id
            .as_deref()
            .and_then(num_of)
            .map(|n| format!("0.0.{n}-{}", wallet_core::hbar_checksum(c.network, n))),
        address,
        info,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HbarRecipientInfo {
    /// `0.0.x` or EIP-55 address, as it will be signed.
    pub to: String,
    pub is_evm: bool,
    #[serde(flatten)]
    pub info: HbarAccountInfo,
}

fn mirror_key(r: &HbarRecipient) -> String {
    match r {
        HbarRecipient::Id(n) => format!("0.0.{n}"),
        HbarRecipient::Evm(_) => r.display().to_ascii_lowercase(),
    }
}

/// Recipient facts before building (exists? deleted? signature required?).
#[tauri::command]
pub async fn hbar_recipient(
    state: State<'_, AppState>,
    to: String,
) -> AppResult<HbarRecipientInfo> {
    let r = wallet_core::hbar_parse_recipient(&to, state.network)?;
    let info = hbar_backend::account(&ctx(&state), &mirror_key(&r)).await?;
    Ok(HbarRecipientInfo {
        to: r.display(),
        is_evm: matches!(r, HbarRecipient::Evm(_)),
        info,
    })
}

/// History of `0.0.x` (our account ID, from `hbar_account`).
#[tauri::command]
pub async fn hbar_txs(
    state: State<'_, AppState>,
    account_id: String,
) -> AppResult<serde_json::Value> {
    let n = wallet_core::hbar_parse_account_id(&account_id, state.network)?;
    hbar_backend::txs(&ctx(&state), n).await
}

// ---------------------------------------------------------------- build, sign, broadcast

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HbarBuilt {
    /// Unsigned `TransactionBody` per node, hex: what `hbar_sign_tx` signs.
    pub bodies: Vec<String>,
    pub summary: HbarTxSummary,
    pub context: HbarContext,
}

/// Facts about the recipient, user-facing refusals included.
fn check_recipient(r: &HbarRecipient, info: &HbarAccountInfo) -> AppResult<bool> {
    if info.deleted {
        return Err(AppError::InvalidInput(
            "ce compte Hedera est supprimé : le transfert échouerait".into(),
        ));
    }
    if info.receiver_sig_required {
        return Err(AppError::InvalidInput(
            "ce compte Hedera exige la signature du destinataire pour recevoir : un transfert simple échouerait".into(),
        ));
    }
    match r {
        HbarRecipient::Id(_) if !info.exists => Err(AppError::InvalidInput(
            "ce compte Hedera n'existe pas (identifiant inconnu du nœud miroir)".into(),
        )),
        HbarRecipient::Id(_) => Ok(false),
        HbarRecipient::Evm(_) => Ok(!info.exists),
    }
}

async fn live_context(
    c: &HbarCtx<'_>,
    key: OurKey<'_>,
    to: &HbarRecipient,
) -> AppResult<(u64, HbarContext)> {
    let account = key.account(c).await?;
    let num = match (&account.account_id, account.exists && !account.deleted) {
        (Some(id), true) => num_of(id)
            .ok_or_else(|| AppError::ServerUnreachable("identifiant de compte inattendu".into()))?,
        _ => return Err(AppError::InvalidInput(key.no_account().into())),
    };
    let recipient = hbar_backend::account(c, &mirror_key(to)).await?;
    let creates_account = check_recipient(to, &recipient)?;
    if let (HbarRecipient::Evm(_), Some(id)) = (to, &recipient.account_id) {
        if num_of(id) == Some(num) {
            return Err(AppError::InvalidInput("transfert à soi-même".into()));
        }
    }
    Ok((
        num,
        HbarContext {
            account,
            recipient,
            creates_account,
            token: None,
        },
    ))
}

/// Live token facts for a transfer of `amount` units of known token `num` from `0.0.me` to
/// `to`, or (`to` = None) for its association. User-facing refusals.
async fn token_context(
    c: &HbarCtx<'_>,
    me: u64,
    num: u64,
    to: Option<(&HbarRecipient, &HbarAccountInfo)>,
    amount: u64,
) -> AppResult<HbarTokenContext> {
    let k = wallet_core::hbar_known_token(c.network, num)
        .ok_or_else(|| AppError::InvalidInput(format!("jeton 0.0.{num} inconnu de Kyro")))?;
    let s = k.symbol;
    let ours = hbar_backend::token_holding(c, &format!("0.0.{me}"), num).await?;
    let Some((_, info)) = to else {
        if ours.associated {
            return Err(AppError::InvalidInput(format!("{s} est déjà associé à ce compte")));
        }
        return Ok(HbarTokenContext {
            ours,
            recipient: None,
        });
    };
    if !ours.associated {
        return Err(AppError::InvalidInput(format!(
            "{s} n'est pas associé à ton compte : associe-le d'abord"
        )));
    }
    if ours.frozen {
        return Err(AppError::InvalidInput(format!(
            "ton solde {s} est gelé par l'émetteur : envoi impossible"
        )));
    }
    let have: u64 = ours.balance.parse().unwrap_or(0);
    if amount > have {
        return Err(AppError::InvalidInput(format!(
            "solde {s} insuffisant : {} disponibles",
            crate::commands::format_units(&have.to_string(), k.decimals as usize)
        )));
    }
    let recipient = match info.account_id.as_deref() {
        Some(id) if info.exists => {
            let h = hbar_backend::token_holding(c, id, num).await?;
            if h.frozen {
                return Err(AppError::InvalidInput(format!(
                    "le solde {s} de ce destinataire est gelé par l'émetteur : il ne peut rien recevoir"
                )));
            }
            if !h.associated && info.max_auto_associations == 0 {
                return Err(AppError::InvalidInput(format!(
                    "ce destinataire n'a pas associé {s} et son compte n'a pas d'association automatique : il doit d'abord associer {s}, sinon le transfert échoue"
                )));
            }
            Some(h)
        }
        _ => None,
    };
    Ok(HbarTokenContext { ours, recipient })
}

fn check_balance(amount: u64, max_fee: u64, balance: &str) -> AppResult<()> {
    let bal: u64 = balance.parse().unwrap_or(0);
    let need = amount.saturating_add(max_fee);
    if need > bal {
        return Err(AppError::InvalidInput(format!(
            "solde insuffisant : {} disponibles, il en faut {} (montant + frais maximum)",
            hbar(Lang::Fr, &bal.to_string()),
            hbar(Lang::Fr, &need.to_string())
        )));
    }
    Ok(())
}

/// Builds one copy per node of `nodes` (Kyro's list or a part of it).
pub(crate) async fn build(
    c: &HbarCtx<'_>,
    key: OurKey<'_>,
    to: &str,
    amount: &str,
    memo: Option<&str>,
    nodes: &[u64],
) -> AppResult<HbarBuilt> {
    build_kind(c, key, Some(to), amount, memo, None, nodes).await
}

/// HBAR transfer (`token` None), transfer of known token `token` (`to` set), or its
/// association (`to` None, `amount` "0").
pub(crate) async fn build_kind(
    c: &HbarCtx<'_>,
    key: OurKey<'_>,
    to: Option<&str>,
    amount: &str,
    memo: Option<&str>,
    token: Option<u64>,
    nodes: &[u64],
) -> AppResult<HbarBuilt> {
    let memo = memo.unwrap_or("").to_owned();
    wallet_core::hbar_check_memo(&memo)?;
    let (num, recipient, amount, mut context, kind) = match (to, token) {
        (None, Some(t)) => {
            let account = key.account(c).await?;
            let num = match (&account.account_id, account.exists && !account.deleted) {
                (Some(id), true) => num_of(id).ok_or_else(|| {
                    AppError::ServerUnreachable("identifiant de compte inattendu".into())
                })?,
                _ => return Err(AppError::InvalidInput(key.no_account().into())),
            };
            let context = HbarContext {
                recipient: account.clone(),
                account,
                creates_account: false,
                token: None,
            };
            (num, HbarRecipient::Id(num), 0, context, HbarKind::Associate(t))
        }
        (Some(to), _) => {
            let recipient = wallet_core::hbar_parse_recipient(to, c.network)?;
            let amount: u64 = amount
                .trim()
                .parse()
                .ok()
                .filter(|a| *a > 0)
                .ok_or_else(|| AppError::InvalidInput("montant invalide".into()))?;
            let (num, context) = live_context(c, key, &recipient).await?;
            if recipient == HbarRecipient::Id(num) {
                return Err(AppError::InvalidInput("transfert à soi-même".into()));
            }
            let kind = match token {
                None => HbarKind::Hbar,
                Some(t) => HbarKind::Token {
                    token: t,
                    decimals: wallet_core::hbar_known_token(c.network, t)
                        .ok_or_else(|| AppError::InvalidInput(format!("jeton 0.0.{t} inconnu de Kyro")))?
                        .decimals,
                },
            };
            (num, recipient, amount, context, kind)
        }
        (None, None) => return Err(AppError::InvalidInput("destinataire manquant".into())),
    };
    match kind {
        HbarKind::Token { token, .. } => {
            context.token = Some(
                token_context(c, num, token, Some((&recipient, &context.recipient)), amount).await?,
            );
        }
        HbarKind::Associate(token) => {
            context.token = Some(token_context(c, num, token, None, 0).await?);
        }
        HbarKind::Hbar => {}
    }
    let rate = hbar_backend::exchange_rate(c).await?;
    // An association costs ≈ $0.05: the same budget as an account creation.
    let max_fee = hbar_backend::max_fee(
        rate,
        context.creates_account || matches!(kind, HbarKind::Associate(_)),
    );
    let hbar_amount = if kind == HbarKind::Hbar { amount } else { 0 };
    check_balance(hbar_amount, max_fee, &context.account.balance)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| AppError::Internal("horloge".into()))?;
    let bodies: Vec<String> = nodes
        .iter()
        .map(|node| {
            hex::encode(
                HbarTransfer {
                    payer: num,
                    valid_start_secs: now.as_secs() as i64 - START_SKEW,
                    valid_start_nanos: now.subsec_nanos() as i32,
                    node: *node,
                    max_fee,
                    valid_duration: VALID_DURATION,
                    memo: memo.clone(),
                    to: recipient,
                    amount,
                    kind,
                }
                .encode(),
            )
        })
        .collect();
    let summary = key.decode(c.network, &bodies, num, nodes)?;
    Ok(HbarBuilt {
        bodies,
        summary,
        context,
    })
}

#[tauri::command]
pub async fn hbar_build_tx(
    state: State<'_, AppState>,
    to: String,
    amount: String,
    memo: Option<String>,
    account: Option<u32>,
) -> AppResult<HbarBuilt> {
    let (evm, pk) = ours(&state, account_arg(account)?)?;
    let nodes = hbar_backend::node_ids(state.network);
    build(
        &ctx(&state),
        OurKey::Ecdsa { evm: &evm, pk: &pk },
        &to,
        &amount,
        memo.as_deref(),
        &nodes,
    )
    .await
}

/// Our holdings of the known tokens of the network (USDC), `0.0.x` = our account ID.
#[tauri::command]
pub async fn hbar_token_holdings(
    state: State<'_, AppState>,
    account_id: String,
) -> AppResult<Vec<HbarTokenHolding>> {
    let n = wallet_core::hbar_parse_account_id(&account_id, state.network)?;
    let c = ctx(&state);
    let mut out = Vec::new();
    for t in wallet_core::hbar_known_tokens(c.network) {
        out.push(hbar_backend::token_holding(&c, &format!("0.0.{n}"), t.num).await?);
    }
    Ok(out)
}

/// `TokenAssociate` of known token `0.0.token` for our account (signed with `hbar_sign_tx`).
#[tauri::command]
pub async fn hbar_build_associate_tx(
    state: State<'_, AppState>,
    token_id: String,
    account: Option<u32>,
) -> AppResult<HbarBuilt> {
    let (evm, pk) = ours(&state, account_arg(account)?)?;
    let t = num_of(token_id.trim())
        .ok_or_else(|| AppError::InvalidInput("identifiant de jeton 0.0.x attendu".into()))?;
    build_kind(
        &ctx(&state),
        OurKey::Ecdsa { evm: &evm, pk: &pk },
        None, "0", None, Some(t),
        &hbar_backend::node_ids(state.network),
    )
    .await
}

/// Transfer of `amount` units of known token `0.0.token` to `to` (signed with `hbar_sign_tx`).
#[tauri::command]
pub async fn hbar_build_token_tx(
    state: State<'_, AppState>,
    token_id: String,
    to: String,
    amount: String,
    memo: Option<String>,
    account: Option<u32>,
) -> AppResult<HbarBuilt> {
    let (evm, pk) = ours(&state, account_arg(account)?)?;
    let t = num_of(token_id.trim())
        .ok_or_else(|| AppError::InvalidInput("identifiant de jeton 0.0.x attendu".into()))?;
    build_kind(
        &ctx(&state),
        OurKey::Ecdsa { evm: &evm, pk: &pk },
        Some(&to), &amount, memo.as_deref(), Some(t),
        &hbar_backend::node_ids(state.network),
    )
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HbarSigned {
    /// Signed `Transaction` per node, hex, same order: what `hbar_broadcast` submits.
    pub signed: Vec<String>,
    pub summary: HbarTxSummary,
    pub context: HbarContext,
}

/// Seconds that must remain in the validity window when signing (reading the dialog, sending).
const MIN_REMAINING: i64 = 45;

/// Decoding + live re-checks, i.e. everything `hbar_sign_tx` does before the dialog.
pub(crate) async fn prepare_sign(
    c: &HbarCtx<'_>,
    key: OurKey<'_>,
    bodies: &[String],
    nodes: &[u64],
) -> AppResult<(u64, HbarTxSummary, HbarContext)> {
    let first = bodies
        .first()
        .ok_or_else(|| AppError::InvalidInput("aucun corps de transaction".into()))?;
    let t = HbarTransfer::decode(
        &hex::decode(first.trim())
            .map_err(|_| AppError::InvalidInput("corps : hexadécimal attendu".into()))?,
    )?;
    let (num, mut context) = match t.kind {
        HbarKind::Associate(_) => {
            let account = key.account(c).await?;
            let num = account.account_id.as_deref().and_then(num_of).ok_or_else(|| {
                AppError::InvalidInput("ton compte Hedera n'existe pas encore".into())
            })?;
            (
                num,
                HbarContext {
                    recipient: account.clone(),
                    account,
                    creates_account: false,
                    token: None,
                },
            )
        }
        _ => live_context(c, key, &t.to).await?,
    };
    let summary = key.decode(c.network, bodies, num, nodes)?;
    if now_secs() > summary.valid_start + summary.valid_duration - MIN_REMAINING {
        return Err(AppError::InvalidInput(
            "transfert Hedera expiré ou presque (fenêtre de 180 s) : reconstruis-le".into(),
        ));
    }
    let max_fee: u64 = summary.max_fee.parse().unwrap_or(u64::MAX);
    let amount: u64 = summary.amount.parse().unwrap_or(u64::MAX);
    match t.kind {
        HbarKind::Hbar => check_balance(amount, max_fee, &context.account.balance)?,
        HbarKind::Token { token, .. } => {
            context.token = Some(
                token_context(c, num, token, Some((&t.to, &context.recipient)), amount).await?,
            );
            check_balance(0, max_fee, &context.account.balance)?;
        }
        HbarKind::Associate(token) => {
            context.token = Some(token_context(c, num, token, None, 0).await?);
            check_balance(0, max_fee, &context.account.balance)?;
        }
    }
    Ok((num, summary, context))
}

#[tauri::command]
pub async fn hbar_sign_tx(
    app: AppHandle,
    state: State<'_, AppState>,
    bodies: Vec<String>,
    password: String,
    account: Option<u32>,
) -> AppResult<HbarSigned> {
    if !state.is_unlocked() {
        return Err(AppError::Locked);
    }
    let a = account_arg(account)?;
    let (evm, pk) = ours(&state, a)?;
    let signer = SignerInfo::new(&state, Chain::Hbar, a, wallet_core::hbar_path(a));
    let c = ctx(&state);
    let nodes = hbar_backend::node_ids(state.network);
    let (num, summary, context) =
        prepare_sign(&c, OurKey::Ecdsa { evm: &evm, pk: &pk }, &bodies, &nodes).await?;
    let seed = seed_from_password(&state, Zeroizing::new(password)).await?;
    let lang = crate::i18n::current();
    confirm_native(
        &app,
        match &summary.token {
            Some(t) if t.associate => lang.pick(
                "Associer un jeton Hedera",
                "Associate a Hedera token",
            ),
            Some(_) => lang.pick(
                "Confirmer l'envoi de jetons Hedera",
                "Confirm the Hedera token send",
            ),
            None => lang.pick(
                "Confirmer le transfert Hedera",
                "Confirm the Hedera transfer",
            ),
        },
        signer.body(
            lang,
            &describe_hbar(lang, &summary, &context, state.network),
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
            describe_hbar_extra(lang, &summary),
        )
        .await?;
    }
    let net = state.network;
    let b = bodies.clone();
    let (signed, again) =
        blocking(move || Ok(wallet_core::hbar_sign_on(net, &seed, a, num, &b, &nodes)?)).await?;
    if again != summary {
        return Err(AppError::Internal(
            "résumé différent entre l'aperçu et la signature".into(),
        ));
    }
    state.touch();
    Ok(HbarSigned {
        signed,
        summary,
        context,
    })
}

/// Checks every signed copy (strict decoding, low-S signature by **our** key, copies identical
/// but for distinct known nodes) then submits them one after the other until a node accepts.
/// Returns the transaction ID (`0.0.x@secs.nanos`).
pub(crate) async fn broadcast_checked(
    c: &HbarCtx<'_>,
    key: OurKey<'_>,
    signed: &[String],
) -> AppResult<String> {
    if signed.is_empty() || signed.len() > wallet_core::HBAR_MAX_NODES {
        return Err(AppError::InvalidInput("copies signées : 1 à 4".into()));
    }
    let known = hbar_backend::node_ids(c.network);
    let mut copies: Vec<(u64, Vec<u8>, HbarTransfer)> = Vec::new();
    for s in signed {
        let t = key.verify(s)?;
        if let HbarKind::Token { token, .. } | HbarKind::Associate(token) = t.kind {
            if wallet_core::hbar_known_token(c.network, token).is_none() {
                return Err(AppError::InvalidInput(format!(
                    "jeton 0.0.{token} inconnu sur ce réseau"
                )));
            }
        }
        if !known.contains(&t.node) || copies.iter().any(|(n, _, _)| *n == t.node) {
            return Err(AppError::InvalidInput("nœud inconnu ou en double".into()));
        }
        if let Some((_, _, first)) = copies.first() {
            let mut same = t.clone();
            same.node = first.node;
            if same != *first {
                return Err(AppError::InvalidInput(
                    "les copies signées diffèrent".into(),
                ));
            }
        }
        let raw = hex::decode(s.trim())
            .map_err(|_| AppError::InvalidInput("hexadécimal attendu".into()))?;
        copies.push((t.node, raw, t));
    }
    let id = copies[0].2.transaction_id();
    let mut last = String::new();
    for (node, raw, _) in &copies {
        match hbar_backend::submit_to_node(c, *node, raw).await {
            Ok(p) if p.code == 0 || p.code == 11 => return Ok(id), // OK, DUPLICATE_TRANSACTION
            Ok(p) if hbar_backend::retryable(p.code) => {
                last = wallet_core::hbar_response_name(p.code);
            }
            Ok(p) => {
                return Err(AppError::InvalidInput(format!(
                    "transfert Hedera refusé par le nœud 0.0.{node} : {}",
                    wallet_core::hbar_response_name(p.code)
                )))
            }
            Err(e @ AppError::TorUnavailable(_)) => return Err(e),
            Err(e) => last = e.to_string(),
        }
    }
    Err(AppError::ServerUnreachable(format!(
        "aucun nœud Hedera n'a accepté le transfert ({last})"
    )))
}

#[tauri::command]
pub async fn hbar_broadcast(
    state: State<'_, AppState>,
    signed: Vec<String>,
    account: Option<u32>,
) -> AppResult<String> {
    let (evm, pk) = ours(&state, account_arg(account)?)?;
    broadcast_checked(&ctx(&state), OurKey::Ecdsa { evm: &evm, pk: &pk }, &signed).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HbarTxStatus {
    /// The mirror node has the transaction (it reached consensus).
    pub found: bool,
    /// `SUCCESS`, `INSUFFICIENT_PAYER_BALANCE`…
    pub result: String,
}

/// Status by transaction ID (`0.0.x@secs.nanos` or the mirror form `0.0.x-secs-nanos`).
#[tauri::command]
pub async fn hbar_tx_status(state: State<'_, AppState>, id: String) -> AppResult<HbarTxStatus> {
    let mirror_id = mirror_tx_id(&id)?;
    let (found, result) = hbar_backend::tx_status(&ctx(&state), &mirror_id).await?;
    Ok(HbarTxStatus { found, result })
}

/// `0.0.x@secs.nanos` → `0.0.x-secs-nanos`, strictly.
pub(crate) fn mirror_tx_id(id: &str) -> AppResult<String> {
    let err = || AppError::InvalidInput("identifiant de transaction Hedera invalide".into());
    let id = id.trim();
    let (acc, rest) = id
        .split_once('@')
        .or_else(|| id.split_once('-'))
        .ok_or_else(err)?;
    let (secs, nanos) = rest.split_once(['.', '-']).ok_or_else(err)?;
    let n = num_of(acc).ok_or_else(err)?;
    let digits = |s: &str, max: usize| {
        !s.is_empty() && s.len() <= max && s.bytes().all(|b| b.is_ascii_digit())
    };
    if !digits(secs, 19) || !digits(nanos, 9) {
        return Err(err());
    }
    Ok(format!("0.0.{n}-{secs}-{nanos:0>9}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summary(memo: Option<&str>, to_is_evm: bool) -> HbarTxSummary {
        HbarTxSummary {
            from: "0.0.5005".into(),
            to: if to_is_evm {
                "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045".into()
            } else {
                "0.0.7007".into()
            },
            to_is_evm,
            amount: "150000000".into(),
            max_fee: "6961687".into(),
            memo: memo.map(str::to_owned),
            memo_hex: memo.map(|m| hex::encode(m.as_bytes())),
            transaction_id: "0.0.5005@1793500000.000000001".into(),
            mirror_transaction_id: "0.0.5005-1793500000-000000001".into(),
            valid_start: 1_793_500_000,
            valid_duration: 180,
            nodes: vec!["0.0.3".into(), "0.0.4".into(), "0.0.7".into()],
            warnings: vec![],
            requires_extra_confirmation: false,
            token: None,
        }
    }

    fn usdc(associate: bool) -> wallet_core::HbarTokenSummary {
        wallet_core::HbarTokenSummary {
            token_id: "0.0.456858".into(),
            symbol: "USDC".into(),
            name: "USD Coin".into(),
            decimals: 6,
            associate,
        }
    }

    #[test]
    fn dialog_shows_the_token_its_verified_id_and_decimals() {
        let mut s = summary(None, false);
        s.amount = "12500000".into();
        s.token = Some(usdc(false));
        let mut c = context(false);
        let h = HbarTokenHolding {
            token_id: "0.0.456858".into(),
            associated: true,
            balance: "20000000".into(),
            frozen: false,
        };
        c.token = Some(HbarTokenContext {
            ours: h.clone(),
            recipient: Some(HbarTokenHolding {
                associated: false,
                ..h
            }),
        });
        let d = describe_hbar(Lang::Fr, &s, &c, Network::Mainnet);
        for needle in [
            "Envoi USDC sur Hedera
",
            "Jeton : USDC (USD Coin) · 0.0.456858 (vérifié, table de Kyro) · 6 décimales",
            "À : 0.0.7007
",
            "Montant : 12,5 USDC (12500000 unités)",
            "Ton solde : 20 USDC",
            "association automatique",
        ] {
            assert!(d.contains(needle), "{needle} missing in:
{d}");
        }
        assert!(!d.contains("tinybars)"));
        s.token = Some(usdc(true));
        s.amount = "0".into();
        let d = describe_hbar(Lang::En, &s, &c, Network::Testnet);
        assert!(d.starts_with("Associate USDC with your Hedera account (testnet)
"), "{d}");
        assert!(d.contains("0.0.456858 (verified, Kyro's table) · 6 decimals"));
        assert!(d.contains("Nothing is sent to anyone"));
    }

    #[test]
    fn token_holdings_from_the_mirror() {
        let v = serde_json::json!({"tokens":[{"token_id":"0.0.456858","balance":2500000,"freeze_status":"UNFROZEN","kyc_status":"NOT_APPLICABLE","automatic_association":true}]});
        let h = hbar_backend::parse_holding(Some(&v), 456_858);
        assert_eq!((h.associated, h.balance.as_str(), h.frozen), (true, "2500000", false));
        assert!(!hbar_backend::parse_holding(Some(&v), 429_274).associated);
        assert!(!hbar_backend::parse_holding(None, 456_858).associated);
        let f = serde_json::json!({"tokens":[{"token_id":"0.0.456858","balance":1,"freeze_status":"FROZEN"}]});
        assert!(hbar_backend::parse_holding(Some(&f), 456_858).frozen);
    }

    fn context(creates: bool) -> HbarContext {
        HbarContext {
            account: HbarAccountInfo {
                exists: true,
                account_id: Some("0.0.5005".into()),
                balance: "1000000000".into(),
                ..Default::default()
            },
            recipient: HbarAccountInfo {
                exists: !creates,
                ..Default::default()
            },
            creates_account: creates,
            token: None,
        }
    }

    #[test]
    fn dialog_frames_the_memo_after_the_amounts() {
        let d = describe_hbar(
            Lang::Fr,
            &summary(Some("12345"), false),
            &context(false),
            Network::Testnet,
        );
        for needle in [
            "Envoi Hedera (testnet)",
            "À : 0.0.7007\n",
            "Montant : 1,5 HBAR (150000000 tinybars)",
            "Frais maximum : 0,06961687 HBAR",
            "Depuis : 0.0.5005 · solde : 10 HBAR",
            "Valable 180 s, identifiant 0.0.5005@1793500000.000000001",
            "Signée pour 3 nœud(s) (0.0.3, 0.0.4, 0.0.7)",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nMÉMO (public à jamais) : « 12345 »\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        ] {
            assert!(d.contains(needle), "{needle} missing in:\n{d}");
        }
        assert!(d.find("Montant").unwrap() < d.find("MÉMO").unwrap());
        assert!(!d.contains("crée"));
        let d = describe_hbar(
            Lang::Fr,
            &summary(None, true),
            &context(true),
            Network::Mainnet,
        );
        assert!(d.starts_with("Envoi Hedera\n"));
        assert!(d.contains("AUCUN MÉMO"));
        assert!(d.contains("(adresse EVM : l'alias du compte)"));
        assert!(d.contains("ce transfert le crée"));
        let mut s = summary(None, false);
        s.warnings = vec![HbarWarning::HighFee, HbarWarning::UnusualText];
        let x = describe_hbar_extra(Lang::Fr, &s);
        assert!(x.contains("2 HBAR") && x.contains("mémo"));
        let en = describe_hbar(
            Lang::En,
            &summary(Some("12345"), false),
            &context(false),
            Network::Testnet,
        );
        assert!(
            en.contains("Amount: 1.5 HBAR (150000000 tinybars)")
                && en.contains("MEMO (public forever): ")
        );
    }

    #[test]
    fn recipients_and_ids() {
        let gone = HbarAccountInfo {
            exists: true,
            deleted: true,
            ..Default::default()
        };
        assert!(check_recipient(&HbarRecipient::Id(7), &gone).is_err());
        let sig = HbarAccountInfo {
            exists: true,
            receiver_sig_required: true,
            ..Default::default()
        };
        assert!(check_recipient(&HbarRecipient::Id(7), &sig).is_err());
        let none = HbarAccountInfo::default();
        assert!(check_recipient(&HbarRecipient::Id(7), &none).is_err());
        assert!(check_recipient(&HbarRecipient::Evm([1; 20]), &none).unwrap());
        let ok = HbarAccountInfo {
            exists: true,
            ..Default::default()
        };
        assert!(!check_recipient(&HbarRecipient::Evm([1; 20]), &ok).unwrap());
        assert!(!check_recipient(&HbarRecipient::Id(7), &ok).unwrap());

        assert_eq!(
            mirror_tx_id("0.0.5005@1793500000.1").unwrap(),
            "0.0.5005-1793500000-000000001"
        );
        assert_eq!(
            mirror_tx_id("0.0.5005-1793500000-000000001").unwrap(),
            "0.0.5005-1793500000-000000001"
        );
        for bad in [
            "",
            "0.0.5005",
            "0.0.x@1.2",
            "0.0.5@1.1234567890",
            "1.0.5@1.2",
            "0.0.5@/etc.2",
        ] {
            assert!(mirror_tx_id(bad).is_err(), "{bad}");
        }
        assert!(check_balance(100, 10, "110").is_ok());
        assert!(check_balance(100, 11, "110").is_err());
    }
}
