//! Solana transaction preview: decoding in Rust (wallet-core), address-lookup-table resolution
//! by the shell itself (never from the UI), and the text of the native confirmation dialogs.

use std::collections::BTreeSet;

use base64::Engine as _;
use serde_json::{json, Value};
use wallet_core::{
    Network, SolInstruction, SolLookupTable, SolTokenProgram, SolTxSummary, SolWarning,
    SOL_LOOKUP_TABLE_PROGRAM,
};

use crate::error::{AppError, AppResult};
use crate::i18n::Lang;
use crate::net::FetchRequest;
use crate::state::AppState;

const MAX_TX_SIZE: usize = 1232;
const MAX_LOOKUP_TABLES: usize = 16;
const DEFAULT_RPC_MAINNET: &str = "https://api.mainnet-beta.solana.com";
const DEFAULT_RPC_DEVNET: &str = "https://api.devnet.solana.com";

pub(crate) fn rpc_url(state: &AppState) -> String {
    match state.settings().servers.solana_for(state.network) {
        Some(s) => s.url.clone(),
        None => match state.network {
            Network::Mainnet => DEFAULT_RPC_MAINNET,
            Network::Testnet => DEFAULT_RPC_DEVNET,
        }
        .to_owned(),
    }
}

pub fn network_label(net: Network) -> &'static str {
    match net {
        Network::Mainnet => "Solana (mainnet)",
        Network::Testnet => "Solana devnet (test)",
    }
}

/// Base64 message from the UI -> bytes, with a size cap.
pub fn message_bytes(message_b64: &str) -> AppResult<Vec<u8>> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(message_b64.trim().as_bytes())
        .map_err(|_| AppError::InvalidInput("invalid Solana message (base64)".into()))?;
    if bytes.is_empty() || bytes.len() > MAX_TX_SIZE {
        return Err(AppError::InvalidInput(
            "Solana message empty or too long".into(),
        ));
    }
    Ok(bytes)
}

async fn fetch_lookup_table(state: &AppState, url: &str, key: &str) -> AppResult<SolLookupTable> {
    let body = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "getAccountInfo",
        "params": [key, { "encoding": "base64", "commitment": "confirmed" }],
    });
    let settings = state.settings();
    let resp = state
        .net
        .fetch(
            FetchRequest {
                url: url.to_owned(),
                method: "POST".into(),
                headers: [("content-type".to_owned(), "application/json".to_owned())].into(),
                body: Some(body.to_string()),
            },
            &settings,
            &state.env_keys,
            state.network,
        )
        .await?;
    let fail = |why: &str| AppError::InvalidInput(format!("address table {key}: {why}"));
    if resp.status != 200 {
        return Err(fail(&format!("RPC response {}", resp.status)));
    }
    let v: Value = serde_json::from_str(&resp.body).map_err(|_| fail("unreadable RPC response"))?;
    let account = &v["result"]["value"];
    if account.is_null() {
        return Err(fail("account not found"));
    }
    if account["owner"].as_str() != Some(SOL_LOOKUP_TABLE_PROGRAM) {
        return Err(fail("this account is not an address table"));
    }
    let (Some(data), Some("base64")) = (account["data"][0].as_str(), account["data"][1].as_str())
    else {
        return Err(fail("unexpected encoding"));
    };
    let raw = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|_| fail("invalid base64 data"))?;
    Ok(SolLookupTable {
        key: key.to_owned(),
        addresses: wallet_core::sol_parse_lookup_table(&raw)?,
    })
}

/// A decoded message plus what the dialog must say about where its accounts come from.
#[derive(Debug, Clone)]
pub struct SolDecoded {
    pub summary: SolTxSummary,
    /// Accounts used by an instruction that are NOT written in the message but were loaded
    /// from an address lookup table, i.e. given by the RPC that served the table.
    pub from_tables: BTreeSet<String>,
}

/// Decodes `message` (raw bytes), resolving v0 lookup tables from the chain.
pub async fn decode(state: &AppState, message: &[u8], our_address: &str) -> AppResult<SolDecoded> {
    let keys = wallet_core::sol_message_lookup_tables(message)?;
    if keys.len() > MAX_LOOKUP_TABLES {
        return Err(AppError::InvalidInput("too many address tables".into()));
    }
    let mut tables = Vec::with_capacity(keys.len());
    if !keys.is_empty() {
        let url = rpc_url(state);
        for key in &keys {
            tables.push(fetch_lookup_table(state, &url, key).await?);
        }
    }
    let summary = wallet_core::sol_decode_message(message, &tables, our_address)?;
    let statics = if keys.is_empty() {
        Vec::new()
    } else {
        wallet_core::sol_message_static_keys(message)?
    };
    Ok(mark_tables(summary, !keys.is_empty(), &statics))
}

fn instruction_accounts(ins: &SolInstruction) -> Vec<&str> {
    match ins {
        SolInstruction::SystemTransfer { from, to, .. } => vec![from, to],
        SolInstruction::SystemTransferWithSeed { from, base, to, .. } => vec![from, base, to],
        SolInstruction::SystemCreateAccount {
            from, new_account, ..
        } => vec![from, new_account],
        SolInstruction::SystemCreateAccountWithSeed {
            from,
            new_account,
            base,
            ..
        } => vec![from, new_account, base],
        SolInstruction::TokenTransfer {
            source,
            destination,
            authority,
            mint,
            multisig_signers,
            ..
        } => {
            let mut v: Vec<&String> = vec![source, destination, authority];
            v.extend(mint);
            v.extend(multisig_signers);
            v
        }
        SolInstruction::TokenApprove {
            source,
            delegate,
            owner,
            mint,
            multisig_signers,
            ..
        } => {
            let mut v: Vec<&String> = vec![source, delegate, owner];
            v.extend(mint);
            v.extend(multisig_signers);
            v
        }
        SolInstruction::AtaCreate {
            payer,
            account,
            owner,
            mint,
            ..
        } => vec![payer, account, owner, mint],
        SolInstruction::StakeInitialize {
            stake_account,
            staker,
            withdrawer,
        } => vec![stake_account, staker, withdrawer],
        SolInstruction::StakeDelegate {
            stake_account,
            vote_account,
            authority,
        } => vec![stake_account, vote_account, authority],
        SolInstruction::StakeDeactivate {
            stake_account,
            authority,
        } => vec![stake_account, authority],
        SolInstruction::StakeWithdraw {
            stake_account, to, ..
        } => vec![stake_account, to],
        SolInstruction::Unknown { account_keys, .. } => account_keys.iter().collect(),
        SolInstruction::ComputeUnitLimit { .. }
        | SolInstruction::ComputeUnitPrice { .. }
        | SolInstruction::Memo { .. } => Vec::new(),
    }
    .into_iter()
    .map(String::as_str)
    .collect()
}

/// Pure part of [`decode`]: which instruction accounts are not static keys of a v0 message
/// with lookups, and the reinforced dialog if a recognised instruction uses one.
pub fn mark_tables(mut summary: SolTxSummary, has_lookups: bool, statics: &[String]) -> SolDecoded {
    let mut from_tables = BTreeSet::new();
    if has_lookups {
        for ins in &summary.instructions {
            for a in instruction_accounts(ins) {
                if !statics.iter().any(|k| k == a) {
                    from_tables.insert(a.to_owned());
                }
            }
        }
        if !from_tables.is_empty() {
            summary.requires_extra_confirmation = true;
        }
    }
    SolDecoded {
        summary,
        from_tables,
    }
}

fn sol(lang: Lang, lamports: &str) -> String {
    format!(
        "{} SOL",
        crate::commands::format_units_in(lang, lamports, 9)
    )
}

fn token_program_label(p: SolTokenProgram) -> &'static str {
    match p {
        SolTokenProgram::Token => "SPL Token",
        SolTokenProgram::Token2022 => "Token-2022",
    }
}

fn token_amount(lang: Lang, amount: &str, decimals: Option<u8>) -> String {
    match (decimals, lang) {
        (Some(d), Lang::Fr) => format!(
            "{} (unités brutes : {amount}, {d} décimales)",
            crate::commands::format_units_in(lang, amount, usize::from(d))
        ),
        (Some(d), Lang::En) => format!(
            "{} (raw units: {amount}, {d} decimals)",
            crate::commands::format_units_in(lang, amount, usize::from(d))
        ),
        (None, Lang::Fr) => format!("{amount} unités brutes (décimales non indiquées)"),
        (None, Lang::En) => format!("{amount} raw units (decimals not given)"),
    }
}

struct Names<'a> {
    lang: Lang,
    me: &'a str,
    from_tables: &'a BTreeSet<String>,
    net: Network,
}

impl Names<'_> {
    fn who(&self, a: &str) -> String {
        if a == self.me {
            self.lang.pick("toi", "you").to_owned()
        } else {
            self.addr(a)
        }
    }

    fn addr(&self, a: &str) -> String {
        if self.from_tables.contains(a) {
            format!("{a} {}", table_mark(self.lang))
        } else {
            a.to_owned()
        }
    }

    fn mint(&self, mint: Option<&str>) -> String {
        match mint {
            None => self.lang.pick("non indiqué", "not given").into(),
            Some(m) => {
                let known = crate::known_tokens::lookup(
                    self.net,
                    crate::known_tokens::TokenChain::Solana,
                    m,
                )
                .map_or_else(
                    || {
                        self.lang
                            .pick(" (jeton inconnu)", " (unknown token)")
                            .to_owned()
                    },
                    |t| format!(" ({})", t.symbol),
                );
                format!("{}{known}", self.addr(m))
            }
        }
    }
}

fn table_mark(lang: Lang) -> &'static str {
    lang.pick(
        "[lu dans une table d'adresses]",
        "[read from an address table]",
    )
}

fn describe_instruction(lang: Lang, ins: &SolInstruction, n: &Names<'_>) -> String {
    let sol = |l: &str| sol(lang, l);
    let fr = lang == Lang::Fr;
    match ins {
        SolInstruction::SystemTransfer { from, to, lamports } => {
            if fr {
                format!(
                    "Envoi de {}\n   De : {}\n   À : {}",
                    sol(lamports),
                    n.who(from),
                    n.who(to)
                )
            } else {
                format!(
                    "Sending {}\n   From: {}\n   To: {}",
                    sol(lamports),
                    n.who(from),
                    n.who(to)
                )
            }
        }
        SolInstruction::SystemTransferWithSeed {
            from, to, lamports, ..
        } => {
            if fr {
                format!(
                    "Envoi de {} (compte dérivé)\n   De : {}\n   À : {}",
                    sol(lamports),
                    n.who(from),
                    n.who(to)
                )
            } else {
                format!(
                    "Sending {} (derived account)\n   From: {}\n   To: {}",
                    sol(lamports),
                    n.who(from),
                    n.who(to)
                )
            }
        }
        SolInstruction::SystemCreateAccount {
            from,
            new_account,
            lamports,
            owner,
            ..
        }
        | SolInstruction::SystemCreateAccountWithSeed {
            from,
            new_account,
            lamports,
            owner,
            ..
        } => {
            let derived = if matches!(ins, SolInstruction::SystemCreateAccountWithSeed { .. }) {
                lang.pick(" (dérivé)", " (derived)")
            } else {
                ""
            };
            if fr {
                format!(
                    "Création de compte {}{derived}\n   Financé par : {} ({})\n   Propriétaire (programme) : {owner}",
                    n.addr(new_account),
                    n.who(from),
                    sol(lamports)
                )
            } else {
                format!(
                    "Account creation {}{derived}\n   Funded by: {} ({})\n   Owner (program): {owner}",
                    n.addr(new_account),
                    n.who(from),
                    sol(lamports)
                )
            }
        }
        SolInstruction::TokenTransfer {
            token_program,
            source,
            destination,
            authority,
            mint,
            amount,
            decimals,
            ..
        } => {
            if fr {
                format!(
                    "Envoi de token ({}) : {}\n   Mint : {}\n   Depuis le compte token : {}\n   Vers le compte token : {}\n   Autorité : {}",
                    token_program_label(*token_program),
                    token_amount(lang, amount, *decimals),
                    n.mint(mint.as_deref()),
                    n.addr(source),
                    n.addr(destination),
                    n.who(authority)
                )
            } else {
                format!(
                    "Token transfer ({}): {}\n   Mint: {}\n   From token account: {}\n   To token account: {}\n   Authority: {}",
                    token_program_label(*token_program),
                    token_amount(lang, amount, *decimals),
                    n.mint(mint.as_deref()),
                    n.addr(source),
                    n.addr(destination),
                    n.who(authority)
                )
            }
        }
        SolInstruction::TokenApprove {
            token_program,
            source,
            delegate,
            owner,
            mint,
            amount,
            decimals,
            ..
        } => {
            if fr {
                format!(
                    "⚠ DÉLÉGATION ({}) : {} pourra dépenser jusqu'à {}\n   Depuis le compte token : {}\n   Mint : {}\n   Propriétaire : {}",
                    token_program_label(*token_program),
                    n.who(delegate),
                    token_amount(lang, amount, *decimals),
                    n.addr(source),
                    n.mint(mint.as_deref()),
                    n.who(owner)
                )
            } else {
                format!(
                    "⚠ DELEGATION ({}): {} will be able to spend up to {}\n   From token account: {}\n   Mint: {}\n   Owner: {}",
                    token_program_label(*token_program),
                    n.who(delegate),
                    token_amount(lang, amount, *decimals),
                    n.addr(source),
                    n.mint(mint.as_deref()),
                    n.who(owner)
                )
            }
        }
        SolInstruction::AtaCreate {
            idempotent,
            payer,
            account,
            owner,
            mint,
            ..
        } => {
            let if_missing = if *idempotent {
                lang.pick(" (si absent)", " (if missing)")
            } else {
                ""
            };
            if fr {
                format!(
                    "Création du compte token associé{if_missing}\n   Compte : {}\n   Titulaire : {}\n   Mint : {}\n   Payé par : {}",
                    n.addr(account),
                    n.who(owner),
                    n.mint(Some(mint)),
                    n.who(payer)
                )
            } else {
                format!(
                    "Associated token account creation{if_missing}\n   Account: {}\n   Holder: {}\n   Mint: {}\n   Paid by: {}",
                    n.addr(account),
                    n.who(owner),
                    n.mint(Some(mint)),
                    n.who(payer)
                )
            }
        }
        SolInstruction::ComputeUnitLimit { units } => match lang {
            Lang::Fr => format!("Limite de calcul : {units} unités"),
            Lang::En => format!("Compute limit: {units} units"),
        },
        SolInstruction::ComputeUnitPrice { micro_lamports } => match lang {
            Lang::Fr => format!("Prix du calcul : {micro_lamports} micro-lamports / unité"),
            Lang::En => format!("Compute price: {micro_lamports} micro-lamports / unit"),
        },
        SolInstruction::Memo { .. } => lang
            .pick(
                "Mémo (texte affiché en bas de cette fenêtre)",
                "Memo (text shown at the bottom of this window)",
            )
            .into(),
        SolInstruction::StakeInitialize {
            stake_account,
            staker,
            withdrawer,
        } => {
            if fr {
                format!(
                    "Staking : initialisation du compte {}\n   Autorités : {} (staker), {} (withdrawer), aucun blocage",
                    n.addr(stake_account),
                    n.who(staker),
                    n.who(withdrawer)
                )
            } else {
                format!(
                    "Staking: initialising account {}\n   Authorities: {} (staker), {} (withdrawer), no lockup",
                    n.addr(stake_account),
                    n.who(staker),
                    n.who(withdrawer)
                )
            }
        }
        SolInstruction::StakeDelegate {
            stake_account,
            vote_account,
            authority,
        } => {
            if fr {
                format!(
                    "Staking : délégation du compte {}\n   Au validateur (compte de vote) : {}\n   Autorité : {}",
                    n.addr(stake_account),
                    n.addr(vote_account),
                    n.who(authority)
                )
            } else {
                format!(
                    "Staking: delegating account {}\n   To the validator (vote account): {}\n   Authority: {}",
                    n.addr(stake_account),
                    n.addr(vote_account),
                    n.who(authority)
                )
            }
        }
        SolInstruction::StakeDeactivate {
            stake_account,
            authority,
        } => {
            if fr {
                format!(
                    "Staking : désactivation du compte {}\n   Autorité : {}",
                    n.addr(stake_account),
                    n.who(authority)
                )
            } else {
                format!(
                    "Staking: deactivating account {}\n   Authority: {}",
                    n.addr(stake_account),
                    n.who(authority)
                )
            }
        }
        SolInstruction::StakeWithdraw {
            stake_account,
            to,
            lamports,
            ..
        } => {
            if fr {
                format!(
                    "Staking : retrait de {} du compte {}\n   Vers : {}",
                    sol(lamports),
                    n.addr(stake_account),
                    n.who(to)
                )
            } else {
                format!(
                    "Staking: withdrawing {} from account {}\n   To: {}",
                    sol(lamports),
                    n.addr(stake_account),
                    n.who(to)
                )
            }
        }
        SolInstruction::Unknown {
            program_id,
            accounts,
            data_len,
            ..
        } => match lang {
            Lang::Fr => format!(
                "⚠ Programme NON RECONNU : {program_id}\n   ({accounts} comptes, {data_len} octets de données)"
            ),
            Lang::En => format!(
                "⚠ UNRECOGNISED program: {program_id}\n   ({accounts} accounts, {data_len} bytes of data)"
            ),
        },
    }
}

fn describe_warning(lang: Lang, w: &SolWarning) -> String {
    let fr = lang == Lang::Fr;
    match w {
        SolWarning::FeePayerNotUs { fee_payer } => {
            if fr {
                format!("Les frais sont payés par un autre compte : {fee_payer}")
            } else {
                format!("The network fee is paid by another account: {fee_payer}")
            }
        }
        SolWarning::ExtraWritableSigner { address } => {
            if fr {
                format!("Un autre signataire est requis : {address}")
            } else {
                format!("Another signer is required: {address}")
            }
        }
        SolWarning::AuthorityNotUs {
            instruction,
            authority,
        } => {
            if fr {
                format!(
                    "Instruction {} : l'autorité n'est pas ton adresse ({authority})",
                    instruction + 1
                )
            } else {
                format!(
                    "Instruction {}: the authority is not your address ({authority})",
                    instruction + 1
                )
            }
        }
        SolWarning::Delegation { instruction } => {
            if fr {
                format!(
                    "Instruction {} : délégation de dépense à un tiers",
                    instruction + 1
                )
            } else {
                format!(
                    "Instruction {}: spending delegated to a third party",
                    instruction + 1
                )
            }
        }
        SolWarning::UnknownInstruction {
            instruction,
            program_id,
        } => {
            if fr {
                format!(
                    "Instruction {} : programme non reconnu {program_id}",
                    instruction + 1
                )
            } else {
                format!(
                    "Instruction {}: unrecognised program {program_id}",
                    instruction + 1
                )
            }
        }
        SolWarning::Token2022ExtensionsUnverified { instruction } => {
            if fr {
                format!(
                    "Instruction {} : token Token-2022 — extensions du mint (frais de transfert, hook) non vérifiées",
                    instruction + 1
                )
            } else {
                format!(
                    "Instruction {}: Token-2022 token — mint extensions (transfer fee, hook) not verified",
                    instruction + 1
                )
            }
        }
        SolWarning::PriorityFeeEstimated => lang
            .pick(
                "Frais prioritaires estimés au maximum (pas de limite de calcul explicite)",
                "Priority fee estimated at its maximum (no explicit compute limit)",
            )
            .into(),
        SolWarning::UnknownOwnerProgram {
            instruction, owner, ..
        } => {
            if fr {
                format!(
                    "Instruction {} : le compte créé appartient à un programme inconnu ({owner}) : il pourra dépenser ces SOL",
                    instruction + 1
                )
            } else {
                format!(
                    "Instruction {}: the created account belongs to an unknown program ({owner}): it will be able to spend these SOL",
                    instruction + 1
                )
            }
        }
        SolWarning::UncheckedTokenTransfer { instruction } => {
            if fr {
                format!(
                    "Instruction {} : envoi de token sans mint ni décimales (Transfer non vérifié)",
                    instruction + 1
                )
            } else {
                format!(
                    "Instruction {}: token transfer without mint or decimals (unchecked Transfer)",
                    instruction + 1
                )
            }
        }
        SolWarning::UnusualText { instruction } => {
            if fr {
                format!(
                    "Instruction {} : texte long ou contenant des caractères invisibles / de contrôle (affiché nettoyé)",
                    instruction + 1
                )
            } else {
                format!(
                    "Instruction {}: long text or text with invisible / control characters (shown cleaned)",
                    instruction + 1
                )
            }
        }
    }
}

fn tables_line(lang: Lang, d: &SolDecoded) -> String {
    match lang {
        Lang::Fr => format!(
            "{} adresse(s) de cette transaction ne sont pas écrites dans le message : elles ont été lues dans une table d'adresses fournie par le serveur Solana (marquées « [lu dans une table d'adresses] »). Un serveur menteur pourrait y mettre d'autres comptes.",
            d.from_tables.len()
        ),
        Lang::En => format!(
            "{} address(es) of this transaction are not written in the message: they were read from an address table provided by the Solana server (marked “[read from an address table]”). A lying server could put other accounts there.",
            d.from_tables.len()
        ),
    }
}

/// Main confirmation text, built only from the Rust-side decode.
pub fn describe(lang: Lang, d: &SolDecoded, me: &str, net: Network) -> String {
    let s = &d.summary;
    let names = Names {
        lang,
        me,
        from_tables: &d.from_tables,
        net,
    };
    let mut out = match lang {
        Lang::Fr => format!(
            "Réseau : {}\nTransaction {} — {} instruction(s)\n\n",
            network_label(net),
            s.version,
            s.instructions.len()
        ),
        Lang::En => format!(
            "Network: {}\nTransaction {} — {} instruction(s)\n\n",
            network_label(net),
            s.version,
            s.instructions.len()
        ),
    };
    for (i, ins) in s.instructions.iter().enumerate() {
        out += &format!("{}. {}\n", i + 1, describe_instruction(lang, ins, &names));
    }
    out += &format!(
        "\n{}{}",
        lang.pick("Frais de base : ", "Base fee: "),
        sol(lang, &s.base_fee_lamports)
    );
    if let Some(p) = &s.priority_fee_lamports {
        out += &format!(
            "\n{}{}",
            lang.pick("Frais prioritaires : ", "Priority fee: "),
            sol(lang, p)
        );
    }
    if !s.warnings.is_empty() || !d.from_tables.is_empty() {
        out += lang.pick("\n\nPoints d'attention :", "\n\nPoints to watch:");
        for w in &s.warnings {
            out += &format!("\n• {}", describe_warning(lang, w));
        }
        if !d.from_tables.is_empty() {
            out += &format!("\n• {}", tables_line(lang, d));
        }
    }
    let memos: Vec<&String> = s
        .instructions
        .iter()
        .filter_map(|i| match i {
            SolInstruction::Memo { text } => Some(text),
            _ => None,
        })
        .collect();
    for m in memos {
        out += &format!(
            "\n\n{}{}",
            lang.pick(
                "Mémo (texte libre, non vérifié) : ",
                "Memo (free text, not verified): "
            ),
            crate::dialog_text::field(m, crate::dialog_text::MAX_FIELD)
        );
    }
    out
}

/// Second, explicit warning shown when `requires_extra_confirmation` is set.
pub fn describe_extra(lang: Lang, d: &SolDecoded) -> String {
    let mut out = String::from(lang.pick(
        "Instruction non reconnue ou inhabituelle — signer quand même ?\n\nKyro n'a pas pu tout vérifier :",
        "Unrecognised or unusual instruction — sign anyway?\n\nKyro could not verify everything:",
    ));
    for w in &d.summary.warnings {
        if !matches!(
            w,
            SolWarning::PriorityFeeEstimated | SolWarning::Token2022ExtensionsUnverified { .. }
        ) {
            out += &format!("\n• {}", describe_warning(lang, w));
        }
    }
    if !d.from_tables.is_empty() {
        out += &format!("\n• {}", tables_line(lang, d));
        for a in &d.from_tables {
            out += &format!("\n   – {a}");
        }
    }
    out += lang.pick(
        "\n\nNe signe que si tu sais exactement ce que fait cette transaction.",
        "\n\nOnly sign if you know exactly what this transaction does.",
    );
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summary(instructions: Vec<SolInstruction>, warnings: Vec<SolWarning>) -> SolTxSummary {
        SolTxSummary {
            version: "legacy".into(),
            fee_payer: "ME".into(),
            signers: vec!["ME".into()],
            our_signer_index: Some(0),
            recent_blockhash: "11111111111111111111111111111111".into(),
            instructions,
            lookup_tables: vec![],
            base_fee_lamports: "5000".into(),
            compute_unit_limit: Some(200_000),
            compute_unit_price_micro_lamports: Some("1000".into()),
            priority_fee_lamports: Some("200".into()),
            requires_extra_confirmation: !warnings.is_empty(),
            warnings,
        }
    }

    #[test]
    fn dialog_text_comes_from_decode() {
        let s = summary(
            vec![
                SolInstruction::SystemTransfer {
                    from: "ME".into(),
                    to: "BOB".into(),
                    lamports: "1500000000".into(),
                },
                SolInstruction::Unknown {
                    program_id: "PROG".into(),
                    accounts: 2,
                    account_keys: vec!["A".into(), "B".into()],
                    data_len: 9,
                },
            ],
            vec![SolWarning::UnknownInstruction {
                instruction: 1,
                program_id: "PROG".into(),
            }],
        );
        let d = mark_tables(s, false, &[]);
        let text = describe(Lang::Fr, &d, "ME", Network::Testnet);
        assert!(text.contains("Envoi de 1,5 SOL"));
        assert!(text.contains("À : BOB"));
        assert!(text.contains("De : toi"));
        assert!(text.contains("NON RECONNU : PROG"));
        assert!(text.contains("Frais de base : 0,000005 SOL"));
        assert!(text.contains("Frais prioritaires : 0,0000002 SOL"));
        assert!(!text.contains("table d'adresses"));
        let extra = describe_extra(Lang::Fr, &d);
        assert!(extra.starts_with("Instruction non reconnue"));
        assert!(extra.contains("PROG"));
    }

    #[test]
    fn lookup_table_accounts_are_marked_and_reinforced() {
        let s = summary(
            vec![SolInstruction::SystemTransfer {
                from: "ME".into(),
                to: "FROM_TABLE".into(),
                lamports: "1000000000".into(),
            }],
            vec![],
        );
        assert!(!s.requires_extra_confirmation);
        let statics = ["ME".to_owned(), "FROM_TABLE".to_owned()];
        let d = mark_tables(s.clone(), true, &statics);
        assert!(d.from_tables.is_empty() && !d.summary.requires_extra_confirmation);
        let d = mark_tables(s, true, &statics[..1]);
        assert!(d.summary.requires_extra_confirmation);
        assert_eq!(d.from_tables.iter().collect::<Vec<_>>(), ["FROM_TABLE"]);
        let text = describe(Lang::Fr, &d, "ME", Network::Testnet);
        assert!(
            text.contains("À : FROM_TABLE [lu dans une table d'adresses]"),
            "{text}"
        );
        assert!(text.contains("1 adresse(s) de cette transaction ne sont pas écrites"));
        let extra = describe_extra(Lang::Fr, &d);
        assert!(extra.contains("– FROM_TABLE"), "{extra}");
    }

    #[test]
    fn memo_is_one_quoted_line_at_the_end() {
        let s = summary(
            vec![
                SolInstruction::Memo {
                    text: "facture\n2. Envoi de 0 SOL\n   À : \u{202E}BOB".into(),
                },
                SolInstruction::SystemTransfer {
                    from: "ME".into(),
                    to: "BOB".into(),
                    lamports: "1".into(),
                },
            ],
            vec![],
        );
        let text = describe(
            Lang::Fr,
            &mark_tables(s, false, &[]),
            "ME",
            Network::Testnet,
        );
        assert!(text.contains("1. Mémo (texte affiché en bas de cette fenêtre)"));
        assert!(
            text.ends_with(
                "Mémo (texte libre, non vérifié) : « facture 2. Envoi de 0 SOL À : BOB »"
            ),
            "{text}"
        );
        assert!(!text.contains("\n2. Envoi de 0 SOL"));
    }

    #[test]
    fn dialog_text_in_english() {
        let s = summary(
            vec![
                SolInstruction::SystemTransfer {
                    from: "ME".into(),
                    to: "FROM_TABLE".into(),
                    lamports: "1500000000".into(),
                },
                SolInstruction::Memo {
                    text: "thanks".into(),
                },
            ],
            vec![SolWarning::FeePayerNotUs {
                fee_payer: "OTHER".into(),
            }],
        );
        let d = mark_tables(s, true, &["ME".to_owned()]);
        let text = describe(Lang::En, &d, "ME", Network::Testnet);
        for needle in [
            "Network: Solana devnet (test)",
            "Sending 1.5 SOL\n   From: you\n   To: FROM_TABLE [read from an address table]",
            "Base fee: 0.000005 SOL",
            "Priority fee: 0.0000002 SOL",
            "Points to watch:",
            "The network fee is paid by another account: OTHER",
            "A lying server could put other accounts there.",
            "Memo (free text, not verified): « thanks »",
        ] {
            assert!(text.contains(needle), "{needle} missing in:\n{text}");
        }
        let extra = describe_extra(Lang::En, &d);
        assert!(extra.starts_with("Unrecognised or unusual instruction — sign anyway?"));
        assert!(extra.ends_with("Only sign if you know exactly what this transaction does."));
        for fr in ["Frais", "toi", "Réseau", "Mémo", "signer"] {
            assert!(!text.contains(fr) && !extra.contains(fr), "{fr}");
        }
    }

    #[test]
    fn message_size_limits() {
        assert!(message_bytes("").is_err());
        assert!(message_bytes("***").is_err());
        let big = base64::engine::general_purpose::STANDARD.encode(vec![0u8; MAX_TX_SIZE + 1]);
        assert!(message_bytes(&big).is_err());
        assert_eq!(message_bytes("AQID").unwrap(), vec![1, 2, 3]);
    }
}

#[cfg(test)]
mod live {
    use super::*;
    use crate::settings::Settings;
    use crate::tor::TorState;
    use sha2::{Digest, Sha256};

    const SYSTEM: &str = "11111111111111111111111111111111";
    const TOKEN: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
    const TOKEN22: &str = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
    const ATA: &str = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
    const ALT: &str = "AddressLookupTab1e1111111111111111111111111";

    type Key = [u8; 32];

    fn key(s: &str) -> Key {
        bitcoin::base58::decode(s).unwrap().try_into().unwrap()
    }
    fn b58(k: &Key) -> String {
        bitcoin::base58::encode(k)
    }

    fn compact(n: usize, out: &mut Vec<u8>) {
        let mut n = n;
        loop {
            let mut b = (n & 0x7f) as u8;
            n >>= 7;
            if n != 0 {
                b |= 0x80;
            }
            out.push(b);
            if n == 0 {
                break;
            }
        }
    }

    fn pda(seeds: &[&[u8]], program: &Key) -> (Key, u8) {
        for bump in (0..=255u8).rev() {
            let mut h = Sha256::new();
            for s in seeds {
                h.update(s);
            }
            h.update([bump]);
            h.update(program);
            h.update(b"ProgramDerivedAddress");
            let k: Key = h.finalize().into();
            if curve25519_dalek::edwards::CompressedEdwardsY(k)
                .decompress()
                .is_none()
            {
                return (k, bump);
            }
        }
        panic!("no PDA")
    }

    fn ata(owner: &Key, mint: &Key, program: &str) -> Key {
        pda(&[owner, &key(program), mint], &key(ATA)).0
    }

    struct Ix {
        program: Key,
        accounts: Vec<Key>,
        data: Vec<u8>,
    }

    fn legacy(
        payer: &Key,
        writable: &[Key],
        readonly: &[Key],
        blockhash: &Key,
        ixs: &[Ix],
    ) -> Vec<u8> {
        let mut keys = vec![*payer];
        keys.extend_from_slice(writable);
        keys.extend_from_slice(readonly);
        let mut m = vec![1, 0, readonly.len() as u8];
        compact(keys.len(), &mut m);
        for k in &keys {
            m.extend_from_slice(k);
        }
        m.extend_from_slice(blockhash);
        compact(ixs.len(), &mut m);
        let idx = |k: &Key| keys.iter().position(|x| x == k).expect("key in message") as u8;
        for ix in ixs {
            m.push(idx(&ix.program));
            compact(ix.accounts.len(), &mut m);
            for a in &ix.accounts {
                m.push(idx(a));
            }
            compact(ix.data.len(), &mut m);
            m.extend_from_slice(&ix.data);
        }
        m
    }

    fn transfer_data(lamports: u64) -> Vec<u8> {
        let mut d = 2u32.to_le_bytes().to_vec();
        d.extend_from_slice(&lamports.to_le_bytes());
        d
    }

    fn seed() -> wallet_core::Seed {
        if std::env::var("KYRO_SOL_WALLET").as_deref() == Ok("abandon") {
            return wallet_core::Mnemonic::parse(
                "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
            )
            .unwrap()
            .to_seed("");
        }
        let path =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../.env.solana-devnet");
        let words = match std::fs::read_to_string(&path) {
            Ok(s) => s
                .lines()
                .find_map(|l| l.strip_prefix("KYRO_SOL_TEST_MNEMONIC="))
                .expect("mnemonic line")
                .trim()
                .to_owned(),
            Err(_) => {
                let m = wallet_core::Mnemonic::generate(wallet_core::WordCount::W12).unwrap();
                let w = m.words().join(" ");
                std::fs::write(
                    &path,
                    format!("# SOLANA DEVNET ONLY - random test mnemonic generated by the Kyro live test (solana.rs).\n# Never use it for real funds. This file is gitignored (.env.*).\nKYRO_SOL_TEST_MNEMONIC={w}\n"),
                )
                .unwrap();
                eprintln!("new test mnemonic written to {}", path.display());
                w
            }
        };
        wallet_core::Mnemonic::parse(&words).unwrap().to_seed("")
    }

    struct Live {
        state: AppState,
        settings: Settings,
        seed: wallet_core::Seed,
        me: String,
    }

    impl Live {
        async fn rpc(&self, method: &str, params: Value) -> Value {
            let body = json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params });
            for attempt in 0..5 {
                let r = self
                    .state
                    .net
                    .fetch(
                        FetchRequest {
                            url: DEFAULT_RPC_DEVNET.into(),
                            method: "POST".into(),
                            headers: [("content-type".to_owned(), "application/json".to_owned())]
                                .into(),
                            body: Some(body.to_string()),
                        },
                        &self.settings,
                        &self.state.env_keys,
                        Network::Testnet,
                    )
                    .await;
                match r {
                    Ok(resp) if resp.status == 200 => {
                        let v: Value = serde_json::from_str(&resp.body).unwrap();
                        if v.get("error").is_some() && method == "requestAirdrop" && attempt < 4 {
                            eprintln!("{method}: {} (retry)", v["error"]);
                            tokio::time::sleep(std::time::Duration::from_secs(15 * (attempt + 1)))
                                .await;
                            continue;
                        }
                        return v;
                    }
                    other => {
                        eprintln!("{method}: {other:?} (retry {attempt})");
                        tokio::time::sleep(std::time::Duration::from_secs(10 * (attempt + 1)))
                            .await;
                    }
                }
            }
            panic!("{method}: no answer");
        }

        async fn blockhash(&self) -> Key {
            let v = self
                .rpc("getLatestBlockhash", json!([{ "commitment": "confirmed" }]))
                .await;
            key(v["result"]["value"]["blockhash"].as_str().unwrap())
        }

        async fn balance(&self, a: &str) -> u64 {
            self.rpc("getBalance", json!([a, { "commitment": "confirmed" }]))
                .await["result"]["value"]
                .as_u64()
                .unwrap()
        }

        async fn send(&self, label: &str, message: Vec<u8>, expect_extra: bool) -> String {
            let decoded = decode(&self.state, &message, &self.me).await.unwrap();
            eprintln!(
                "--- {label}: dialog ---\n{}",
                describe(Lang::Fr, &decoded, &self.me, Network::Testnet)
            );
            let summary = &decoded.summary;
            if summary.requires_extra_confirmation {
                eprintln!(
                    "--- {label}: reinforced ---\n{}",
                    describe_extra(Lang::Fr, &decoded)
                );
            }
            assert_eq!(
                summary.requires_extra_confirmation, expect_extra,
                "{label}: {:?}",
                summary.warnings
            );
            assert_eq!(summary.our_signer_index, Some(0));
            let sig = wallet_core::sol_sign_message(&self.seed, 0, &message).unwrap();
            wallet_core::sol_verify_signature(&self.me, &message, &sig).unwrap();
            let mut tx = vec![1u8];
            tx.extend_from_slice(&sig);
            tx.extend_from_slice(&message);
            let b64 = base64::engine::general_purpose::STANDARD.encode(&tx);
            let expected = bitcoin::base58::encode(&sig);
            let v = self
                .rpc(
                    "sendTransaction",
                    json!([b64, { "encoding": "base64", "preflightCommitment": "confirmed" }]),
                )
                .await;
            assert_eq!(
                v["result"].as_str(),
                Some(expected.as_str()),
                "{label}: {v}"
            );
            for _ in 0..40 {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                let s = self
                    .rpc(
                        "getSignatureStatuses",
                        json!([[expected], { "searchTransactionHistory": true }]),
                    )
                    .await;
                let st = &s["result"]["value"][0];
                if st["confirmationStatus"] == "confirmed"
                    || st["confirmationStatus"] == "finalized"
                {
                    assert!(st["err"].is_null(), "{label}: {st}");
                    eprintln!("{label}: CONFIRMED {expected} (slot {})", st["slot"]);
                    return expected;
                }
            }
            panic!("{label}: {expected} not confirmed");
        }
    }

    /// `seed_str` + create + initialize mint, our ATA, mint 1 000 units, then a TransferChecked of
    /// 250 to the ATA of our address #1.
    async fn spl_round(
        l: &Live,
        me: &Key,
        other: &Key,
        program: &str,
        seed_str: &str,
    ) -> (String, String) {
        let prog = key(program);
        let mint = {
            let mut h = Sha256::new();
            h.update(me);
            h.update(seed_str.as_bytes());
            h.update(prog);
            let k: Key = h.finalize().into();
            k
        };
        let rent = l
            .rpc("getMinimumBalanceForRentExemption", json!([82]))
            .await["result"]
            .as_u64()
            .unwrap();
        let mut create = 3u32.to_le_bytes().to_vec();
        create.extend_from_slice(me);
        create.extend_from_slice(&(seed_str.len() as u64).to_le_bytes());
        create.extend_from_slice(seed_str.as_bytes());
        create.extend_from_slice(&rent.to_le_bytes());
        create.extend_from_slice(&82u64.to_le_bytes());
        create.extend_from_slice(&prog);
        let mut init = vec![20u8, 2];
        init.extend_from_slice(me);
        init.push(0);
        let my_ata = ata(me, &mint, program);
        let mut mint_to = vec![7u8];
        mint_to.extend_from_slice(&1_000u64.to_le_bytes());
        let (sys, ata_p) = (key(SYSTEM), key(ATA));
        let m1 = legacy(
            me,
            &[mint, my_ata],
            &[sys, prog, ata_p],
            &l.blockhash().await,
            &[
                Ix {
                    program: sys,
                    accounts: vec![*me, mint, *me],
                    data: create,
                },
                Ix {
                    program: prog,
                    accounts: vec![mint],
                    data: init,
                },
                Ix {
                    program: ata_p,
                    accounts: vec![*me, my_ata, *me, mint, sys, prog],
                    data: vec![1],
                },
                Ix {
                    program: prog,
                    accounts: vec![mint, my_ata, *me],
                    data: mint_to,
                },
            ],
        );
        let t1 = l.send(&format!("{program} mint"), m1, true).await;
        let their_ata = ata(other, &mint, program);
        let mut xfer = vec![12u8];
        xfer.extend_from_slice(&250u64.to_le_bytes());
        xfer.push(2);
        let m2 = legacy(
            me,
            &[their_ata, my_ata],
            &[*other, mint, sys, prog, ata_p],
            &l.blockhash().await,
            &[
                Ix {
                    program: ata_p,
                    accounts: vec![*me, their_ata, *other, mint, sys, prog],
                    data: vec![1],
                },
                Ix {
                    program: prog,
                    accounts: vec![my_ata, mint, their_ata, *me],
                    data: xfer,
                },
            ],
        );
        let t2 = l.send(&format!("{program} transfer"), m2, false).await;
        (t1, t2)
    }

    #[test]
    #[ignore]
    fn sol_live_devnet_sends() {
        let dir = std::env::temp_dir().join("kyro-sol-live");
        let _ = std::fs::create_dir_all(&dir);
        let state = AppState::new(dir).unwrap();
        let mut settings = state.settings();
        if std::env::var("KYRO_SOL_CLEAR").as_deref() == Ok("yes") {
            settings.tor.enabled = false;
        }
        let seed = seed();
        let me = wallet_core::sol_address(&seed, 0).unwrap();
        let other = wallet_core::sol_address(&seed, 1).unwrap();
        eprintln!("addresses {me} {other} (tor: {})", settings.tor.enabled);
        let l = Live {
            state,
            settings,
            seed,
            me: me.clone(),
        };
        tauri::async_runtime::block_on(async {
            if l.settings.tor.enabled {
                l.state.net.tor.restart();
                while l.state.net.tor.status().state != TorState::Ready {
                    assert_ne!(l.state.net.tor.status().state, TorState::Error);
                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                }
            }
            let mut bal = l.balance(&me).await;
            if bal < 50_000_000 {
                let v = l.rpc("requestAirdrop", json!([me, 1_000_000_000u64])).await;
                eprintln!("airdrop: {v}");
                for _ in 0..30 {
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                    bal = l.balance(&me).await;
                    if bal >= 200_000_000 {
                        break;
                    }
                }
            }
            eprintln!("balance {bal} lamports");
            assert!(bal >= 50_000_000, "not funded");
            let (a, b) = (key(&me), key(&other));
            let sys = key(SYSTEM);

            let m = legacy(
                &a,
                &[b],
                &[sys],
                &l.blockhash().await,
                &[Ix {
                    program: sys,
                    accounts: vec![a, b],
                    data: transfer_data(10_000_000),
                }],
            );
            let t = l.send("SOL", m, false).await;
            eprintln!("SOL SELF-SEND: {t}");

            let tag = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs()
                % 1_000_000;
            let (m1, t1) = spl_round(&l, &a, &b, TOKEN, &format!("kyro-spl-{tag}")).await;
            eprintln!("SPL MINT: {m1}\nSPL TRANSFER: {t1}");
            let (m2, t2) = spl_round(&l, &a, &b, TOKEN22, &format!("kyro-t22-{tag}")).await;
            eprintln!("TOKEN-2022 MINT: {m2}\nTOKEN-2022 TRANSFER: {t2}");

            let slot = l
                .rpc("getSlot", json!([{ "commitment": "finalized" }]))
                .await["result"]
                .as_u64()
                .unwrap();
            let alt = key(ALT);
            let (table, bump) = pda(&[&a, &slot.to_le_bytes()], &alt);
            let mut create = 0u32.to_le_bytes().to_vec();
            create.extend_from_slice(&slot.to_le_bytes());
            create.push(bump);
            let mut extend = 2u32.to_le_bytes().to_vec();
            extend.extend_from_slice(&1u64.to_le_bytes());
            extend.extend_from_slice(&b);
            let m = legacy(
                &a,
                &[table],
                &[sys, alt],
                &l.blockhash().await,
                &[
                    Ix {
                        program: alt,
                        accounts: vec![table, a, a, sys],
                        data: create,
                    },
                    Ix {
                        program: alt,
                        accounts: vec![table, a, a, sys],
                        data: extend,
                    },
                ],
            );
            let t = l.send("ALT create+extend", m, true).await;
            eprintln!("LOOKUP TABLE {}: {t}", b58(&table));
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            let mut v0 = vec![0x80, 1, 0, 1];
            compact(2, &mut v0);
            v0.extend_from_slice(&a);
            v0.extend_from_slice(&sys);
            v0.extend_from_slice(&l.blockhash().await);
            compact(1, &mut v0);
            v0.push(1);
            compact(2, &mut v0);
            v0.extend_from_slice(&[0, 2]);
            let d = transfer_data(1_000_000);
            compact(d.len(), &mut v0);
            v0.extend_from_slice(&d);
            compact(1, &mut v0);
            v0.extend_from_slice(&table);
            compact(1, &mut v0);
            v0.push(0);
            compact(0, &mut v0);
            let t = l.send("v0 + lookup table", v0, true).await;
            eprintln!("V0 TRANSFER: {t}");
            eprintln!(
                "final balance {} / {}",
                l.balance(&me).await,
                l.balance(&other).await
            );
        });
    }
}
