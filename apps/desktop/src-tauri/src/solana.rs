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

/// Real devnet sends through the Rust path of `sol_sign_tx`: `decode` (lookup tables read by
/// Rust), dialog text (+ reinforced text), `sol_sign_message`, signature verification, then
/// `sendTransaction` through `net_fetch` (`NetClient::fetch`, the UI's path), signature check
/// and confirmation. Messages are built here (the TS `SolanaAdapter` is not exercised).
/// Key: a NEW random devnet mnemonic in the gitignored `.env.solana-devnet`; funding:
/// `requestAirdrop` (plain RPC, no captcha). Run with
/// `cargo test -p kyro-desktop --lib -- --ignored --nocapture sol_live`
/// (`KYRO_SOL_CLEAR=yes`: clear mode, if devnet rate-limits Tor exits).
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

    /// Program-derived address (`find_program_address`).
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

    /// Legacy message, one signer (`payer`): keys = payer, `writable`, `readonly`.
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
        // The RPC faucet of devnet answers 410 "closed" (2026-10-30); the web faucet has a
        // captcha. Fallback: the public "abandon … about" wallet, which holds devnet SOL.
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

        /// What `sol_sign_tx` does, then `sendTransaction` and confirmation. Returns the
        /// signature (transaction id).
        async fn send(&self, label: &str, message: Vec<u8>, expect_extra: bool) -> String {
            let summary = decode(&self.state, &message, &self.me).await.unwrap();
            eprintln!(
                "--- {label}: dialog ---\n{}",
                describe(&summary, &self.me, Network::Testnet)
            );
            if summary.requires_extra_confirmation {
                eprintln!("--- {label}: reinforced ---\n{}", describe_extra(&summary));
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

    /// `seed_str` + create + initialize mint, our ATA, mint 1 000 units, then a TransferChecked
    /// of 250 to the ATA of our address #1. `program`: Token or Token-2022.
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
        // InitializeMint2 and MintTo are not decoded by Kyro: reinforced confirmation.
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

            // 1. SOL to our own address #1.
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

            // 2. SPL Token and Token-2022: our own test mint, then a transfer.
            let tag = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs()
                % 1_000_000;
            let (m1, t1) = spl_round(&l, &a, &b, TOKEN, &format!("kyro-spl-{tag}")).await;
            eprintln!("SPL MINT: {m1}\nSPL TRANSFER: {t1}");
            let (m2, t2) = spl_round(&l, &a, &b, TOKEN22, &format!("kyro-t22-{tag}")).await;
            eprintln!("TOKEN-2022 MINT: {m2}\nTOKEN-2022 TRANSFER: {t2}");

            // 3. Address lookup table (create + extend), then a v0 SOL transfer through it.
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
            let t = l.send("v0 + lookup table", v0, false).await;
            eprintln!("V0 TRANSFER: {t}");
            eprintln!(
                "final balance {} / {}",
                l.balance(&me).await,
                l.balance(&other).await
            );
        });
    }
}
