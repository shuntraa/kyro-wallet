//! Solana transaction preview: decoding in Rust (wallet-core), address-lookup-table resolution
//! by the shell itself (never from the UI), and the text of the native confirmation dialogs.

use base64::Engine as _;
use serde_json::{json, Value};
use wallet_core::{
    Network, SolInstruction, SolLookupTable, SolTokenProgram, SolTxSummary, SolWarning,
    SOL_LOOKUP_TABLE_PROGRAM,
};

use crate::error::{AppError, AppResult};
use crate::net::FetchRequest;
use crate::state::AppState;

/// Maximum size of a whole Solana transaction on the wire (IPv6 MTU minus headers).
const MAX_TX_SIZE: usize = 1232;
const MAX_LOOKUP_TABLES: usize = 16;
const DEFAULT_RPC_MAINNET: &str = "https://api.mainnet-beta.solana.com";
const DEFAULT_RPC_DEVNET: &str = "https://api.devnet.solana.com";

/// Solana RPC endpoint: the user's override from settings, else the allowlisted default.
fn rpc_url(state: &AppState) -> String {
    // A custom cluster RPC replaces the default (which is then refused by the policy).
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
        .map_err(|_| AppError::InvalidInput("message Solana invalide (base64)".into()))?;
    if bytes.is_empty() || bytes.len() > MAX_TX_SIZE {
        return Err(AppError::InvalidInput(
            "message Solana vide ou trop long".into(),
        ));
    }
    Ok(bytes)
}

/// Fetches one lookup table with `getAccountInfo` (base64) and parses it in wallet-core.
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
    let fail = |why: &str| AppError::InvalidInput(format!("table d'adresses {key} : {why}"));
    if resp.status != 200 {
        return Err(fail(&format!("réponse RPC {}", resp.status)));
    }
    let v: Value = serde_json::from_str(&resp.body).map_err(|_| fail("réponse RPC illisible"))?;
    let account = &v["result"]["value"];
    if account.is_null() {
        return Err(fail("compte introuvable"));
    }
    if account["owner"].as_str() != Some(SOL_LOOKUP_TABLE_PROGRAM) {
        return Err(fail("ce compte n'est pas une table d'adresses"));
    }
    let (Some(data), Some("base64")) = (account["data"][0].as_str(), account["data"][1].as_str())
    else {
        return Err(fail("encodage inattendu"));
    };
    let raw = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|_| fail("données base64 invalides"))?;
    Ok(SolLookupTable {
        key: key.to_owned(),
        addresses: wallet_core::sol_parse_lookup_table(&raw)?,
    })
}

/// Decodes `message` (raw bytes), resolving v0 lookup tables from the chain. Fails closed if
/// any table cannot be fetched or does not contain a referenced index.
pub async fn decode(
    state: &AppState,
    message: &[u8],
    our_address: &str,
) -> AppResult<SolTxSummary> {
    let keys = wallet_core::sol_message_lookup_tables(message)?;
    if keys.len() > MAX_LOOKUP_TABLES {
        return Err(AppError::InvalidInput("trop de tables d'adresses".into()));
    }
    let mut tables = Vec::with_capacity(keys.len());
    if !keys.is_empty() {
        let url = rpc_url(state);
        for key in &keys {
            tables.push(fetch_lookup_table(state, &url, key).await?);
        }
    }
    Ok(wallet_core::sol_decode_message(
        message,
        &tables,
        our_address,
    )?)
}

// ---------------------------------------------------------------- dialog text

fn sol(lamports: &str) -> String {
    format!("{} SOL", crate::commands::format_units(lamports, 9))
}

fn token_program_label(p: SolTokenProgram) -> &'static str {
    match p {
        SolTokenProgram::Token => "SPL Token",
        SolTokenProgram::Token2022 => "Token-2022",
    }
}

fn token_amount(amount: &str, decimals: Option<u8>) -> String {
    match decimals {
        Some(d) => format!(
            "{} (unités brutes : {amount}, {d} décimales)",
            crate::commands::format_units(amount, usize::from(d))
        ),
        None => format!("{amount} unités brutes (décimales non indiquées)"),
    }
}

fn describe_instruction(ins: &SolInstruction, me: &str) -> String {
    let who = |a: &str| {
        if a == me {
            "toi".to_owned()
        } else {
            a.to_owned()
        }
    };
    match ins {
        SolInstruction::SystemTransfer { from, to, lamports } => {
            format!("Envoi de {}\n   De : {}\n   À : {to}", sol(lamports), who(from))
        }
        SolInstruction::SystemTransferWithSeed {
            from, to, lamports, ..
        } => format!(
            "Envoi de {} (compte dérivé)\n   De : {from}\n   À : {to}",
            sol(lamports)
        ),
        SolInstruction::SystemCreateAccount {
            from,
            new_account,
            lamports,
            owner,
            ..
        } => format!(
            "Création de compte {new_account}\n   Financé par : {} ({})\n   Propriétaire (programme) : {owner}",
            who(from),
            sol(lamports)
        ),
        SolInstruction::SystemCreateAccountWithSeed {
            from,
            new_account,
            lamports,
            owner,
            ..
        } => format!(
            "Création de compte {new_account} (dérivé)\n   Financé par : {} ({})\n   Propriétaire (programme) : {owner}",
            who(from),
            sol(lamports)
        ),
        SolInstruction::TokenTransfer {
            token_program,
            source,
            destination,
            authority,
            mint,
            amount,
            decimals,
            ..
        } => format!(
            "Envoi de token ({}) : {}\n   Mint : {}\n   Depuis le compte token : {source}\n   Vers le compte token : {destination}\n   Autorité : {}",
            token_program_label(*token_program),
            token_amount(amount, *decimals),
            mint.as_deref().unwrap_or("non indiqué"),
            who(authority)
        ),
        SolInstruction::TokenApprove {
            token_program,
            source,
            delegate,
            owner,
            mint,
            amount,
            decimals,
            ..
        } => format!(
            "⚠ DÉLÉGATION ({}) : {delegate} pourra dépenser jusqu'à {}\n   Depuis le compte token : {source}\n   Mint : {}\n   Propriétaire : {}",
            token_program_label(*token_program),
            token_amount(amount, *decimals),
            mint.as_deref().unwrap_or("non indiqué"),
            who(owner)
        ),
        SolInstruction::AtaCreate {
            idempotent,
            payer,
            account,
            owner,
            mint,
            ..
        } => format!(
            "Création du compte token associé{}\n   Compte : {account}\n   Titulaire : {}\n   Mint : {mint}\n   Payé par : {}",
            if *idempotent { " (si absent)" } else { "" },
            who(owner),
            who(payer)
        ),
        SolInstruction::ComputeUnitLimit { units } => {
            format!("Limite de calcul : {units} unités")
        }
        SolInstruction::ComputeUnitPrice { micro_lamports } => {
            format!("Prix du calcul : {micro_lamports} micro-lamports / unité")
        }
        SolInstruction::Memo { text } => {
            let t: String = text.chars().take(200).collect();
            format!("Mémo : « {t} »")
        }
        SolInstruction::Unknown {
            program_id,
            accounts,
            data_len,
            ..
        } => format!(
            "⚠ Programme NON RECONNU : {program_id}\n   ({accounts} comptes, {data_len} octets de données)"
        ),
    }
}

fn describe_warning(w: &SolWarning) -> String {
    match w {
        SolWarning::FeePayerNotUs { fee_payer } => {
            format!("Les frais sont payés par un autre compte : {fee_payer}")
        }
        SolWarning::ExtraWritableSigner { address } => {
            format!("Un autre signataire est requis : {address}")
        }
        SolWarning::AuthorityNotUs {
            instruction,
            authority,
        } => format!(
            "Instruction {} : l'autorité n'est pas ton adresse ({authority})",
            instruction + 1
        ),
        SolWarning::Delegation { instruction } => format!(
            "Instruction {} : délégation de dépense à un tiers",
            instruction + 1
        ),
        SolWarning::UnknownInstruction {
            instruction,
            program_id,
        } => format!(
            "Instruction {} : programme non reconnu {program_id}",
            instruction + 1
        ),
        SolWarning::Token2022ExtensionsUnverified { instruction } => format!(
            "Instruction {} : token Token-2022 — extensions du mint (frais de transfert, hook) non vérifiées",
            instruction + 1
        ),
        SolWarning::PriorityFeeEstimated => {
            "Frais prioritaires estimés au maximum (pas de limite de calcul explicite)".into()
        }
    }
}

/// Main confirmation text, built only from the Rust-side decode.
pub fn describe(s: &SolTxSummary, me: &str, net: Network) -> String {
    let mut out = format!(
        "Réseau : {}\nTransaction {} — {} instruction(s)\n\n",
        network_label(net),
        s.version,
        s.instructions.len()
    );
    for (i, ins) in s.instructions.iter().enumerate() {
        out += &format!("{}. {}\n", i + 1, describe_instruction(ins, me));
    }
    out += &format!("\nFrais de base : {}", sol(&s.base_fee_lamports));
    if let Some(p) = &s.priority_fee_lamports {
        out += &format!("\nFrais prioritaires : {}", sol(p));
    }
    if !s.warnings.is_empty() {
        out += "\n\nPoints d'attention :";
        for w in &s.warnings {
            out += &format!("\n• {}", describe_warning(w));
        }
    }
    out
}

/// Second, explicit warning shown when `requires_extra_confirmation` is set.
pub fn describe_extra(s: &SolTxSummary) -> String {
    let mut out = String::from(
        "Instruction non reconnue ou inhabituelle — signer quand même ?\n\nKyro n'a pas pu tout vérifier :",
    );
    for w in &s.warnings {
        if !matches!(
            w,
            SolWarning::PriorityFeeEstimated | SolWarning::Token2022ExtensionsUnverified { .. }
        ) {
            out += &format!("\n• {}", describe_warning(w));
        }
    }
    out += "\n\nNe signe que si tu sais exactement ce que fait cette transaction.";
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
        let text = describe(&s, "ME", Network::Testnet);
        assert!(text.contains("Envoi de 1,5 SOL"));
        assert!(text.contains("À : BOB"));
        assert!(text.contains("De : toi"));
        assert!(text.contains("NON RECONNU : PROG"));
        assert!(text.contains("Frais de base : 0,000005 SOL"));
        assert!(text.contains("Frais prioritaires : 0,0000002 SOL"));
        let extra = describe_extra(&s);
        assert!(extra.starts_with("Instruction non reconnue"));
        assert!(extra.contains("PROG"));
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
