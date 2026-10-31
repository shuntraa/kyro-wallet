//! Solana decoder against REAL devnet transactions.
//!
//! Message bytes come from `getTransaction` (`"encoding":"base64"`, signatures stripped) on
//! https://api.devnet.solana.com; every expected value comes from the same RPC's `jsonParsed`
//! encoding of the same transaction (compute-budget values from its raw `data` field, unknown
//! instructions from its `accounts`/`data`). The lookup table comes from `getAccountInfo`
//! (base64) and its expected addresses from `getAccountInfo` (`jsonParsed`). Fetched 2026-10-30.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use wallet_core::{
    sanitize_text, sol_decode_message, sol_message_lookup_tables, sol_parse_lookup_table, Error,
    SolInstruction, SolLookupTable, SolTokenProgram, SolTxSummary, SolWarning,
};

fn b64(s: &str) -> Vec<u8> {
    B64.decode(s).unwrap()
}

/// Lookup table `6V3VBaaX5tLD49eRgaY7TjWBPtgkmEC7sirA4NDVkLBQ` (owner
/// `AddressLookupTab1e1111111111111111111111111`), raw account data.
const ALT_KEY: &str = "6V3VBaaX5tLD49eRgaY7TjWBPtgkmEC7sirA4NDVkLBQ";
const ALT_DATA: &str = "AQAAAP//////////WJkqHgAAAAAUAb4Zt7ub+89GK+HzDTCm5loLP95YNXDNzKvXK5RdjzT6AABoDr6j/Gam4NoLQOODHpdfFniFRp6utQouyf90FZKyPsdkI4qjcI6bOnbG7StmtDuB+xBbzU/p7+iQfQczY/ibjzp9k1u+Qnx/G/z7sdzOwVcTCnFw7rpGEFqB0/IEnOeSoH5UmPWFJoQfCP1ZAtC0f5QeyQKXSYnJX5uMR850IBQ23NPvrQlkM/AQnimMx4LEjH86Wtzb47VMXNfJRBhpyNGTDKttEkYNAt2cY8pqz3GKZE6EOCxvs3j+x2yuLcfGsMlGwj5+tGnjCMX7VdswfxjwTUyGC1xlaAl3PGNRxdh/R/Uz4JefK6VDFBGUrovrjGvousOE4pST5ilkYOk16pPmG/Iehx1BEWsCUpEjoXUin+b+arx7TN47edE/M12nxKuJG1d0K5BbggvgeLeQoXrUCxQUSUVXSmWok8JL8lBr53wdHtTh4M2QQWCdZHPgRsjaDZ3WofjMyqFnn0M6Xe2CSae9qwZKxICaHvGUQYqw4B2CIhZr73r8KyCLOiPSZEaXMbfkDMGCZD/XYmwZG/ps20QJTX+GQZjvADYSGI8WyHYu2zHA5o05ZPoI4g+liAuGpNpKtrDhGFGRei/3VWbiEw5Uixm8MopASmCzi4ZYepgpHg84LdQ55Uq1ea0fSfMToqcxIvCn4/ZHbAVcg3H4tPcmNMI/JnW/cuuJ7H+eDKgTRE+uuMcUTgtWxOGR+wSKc8Yf9vWeBBm1P9xbYyi31lvNzwTnZC59pQ5bSE/knYWGApEMek1JtU+QCW4Wc3yyAuZFSvk5CMq5uwX/uD3cLSRt33XaAVIZwxCWtbj8or+D6faqu6ZpOLdAC2NvbcAbFjFfIjWF9vm6omzPV2AEJv+aYN5LWNH5/ig5TS+SLf/z2yFi3XJP48Dd1Ko=";
/// `jsonParsed` addresses of the same account.
const ALT_ADDRESSES: &[&str] = &[
    "81CSa1FTbc75dmZ9kEaFrb4fYzdxG8bVA533cQRMhdid",
    "ERLhKUYPMfiTM2946xjJEPwMNaF5taHjAw9wpUdqSMmk",
    "Ae72kG3bNWNqTewhAjFG4nYbuhFN5ty4oAz8LwsrMS9c",
    "AsNTyfJKyFt1YUC57JJqiwWau8sZzoijcwvwCEPxPo6f",
    "2Mug8msmZLQPffVesxN8Mznj24QGtfzuPHzEPGNg2XMr",
    "EWutWzJG3uFzgqa2GzKGcAbRE3mfQM37fPAKpFd3fLM4",
    "ENc5LdNosDxw2f9Z4UWdfvPtVWdUEQRfJngPVcGqZMSk",
    "Fa7darZyMVRHi4zego9DqPWHVSJY5w2gJ8cKtWXdnSbv",
    "GnhCpX9Rgj8gpJVqdQzAyvgXmV22dYxJWjquakq1FHji",
    "CHu2FQmjGushzpAXxFJMVbZxVBZtzLGshXBAvYXxErjK",
    "6Qw3igzkx77V8XziqT5oNkqHA3NP9NZkdoK7DfqC4wJZ",
    "7KeyG5Ue4SJC8FhvqTjPCNXyFvnZuY6tK1BcauUzrvh8",
    "FAHJTFW8B6A8HyYRG8XFvejdBtX1cD7kX1ubJxnteuGB",
    "AdZT7ZqBp5eRF75Hn7MKPEjuiE9BiYtZM6Scxmo3jCBx",
    "6kNePbXAfpunhMKHjQC9SRV5zrhqjkG83djmu2VHqAPn",
    "3793KRahrxLME2YhPyG8yXpj4WG6kyFWkq3JXKrBmZbR",
    "9bAZKtyYNu5QjS4zhXfGxJKMsCV59p9VMb3xppVEidQW",
    "7g5Nf4xdy2D51vR2yGXLkw9H3vKCzWxR5HefGd6wDnvy",
    "2We7C1HtxCe7woL1iHPTvEqGY43jRCEh6sWgvJqyY1CY",
    "DT7T2UDdm82VSjvpBXLBFckLPdUvrCTQKWysT6BjPJpv",
    "6t5PSf421e1ak63GRzxJZWduGxe2GiqPBkZQG7nbpZGm",
];

fn tables_for(msg: &[u8]) -> Vec<SolLookupTable> {
    sol_message_lookup_tables(msg)
        .unwrap()
        .into_iter()
        .map(|key| {
            assert_eq!(key, ALT_KEY, "unexpected table");
            SolLookupTable {
                key,
                addresses: sol_parse_lookup_table(&b64(ALT_DATA)).unwrap(),
            }
        })
        .collect()
}

#[test]
fn devnet_lookup_table_account() {
    let data = b64(ALT_DATA);
    assert_eq!(data.len(), 56 + 21 * 32);
    let parsed = sol_parse_lookup_table(&data).unwrap();
    assert_eq!(parsed, ALT_ADDRESSES);
    // Same account marked as deactivated (deactivation slot != u64::MAX) is rejected.
    let mut deactivated = data.clone();
    deactivated[4..12].copy_from_slice(&506_108_248u64.to_le_bytes());
    assert!(sol_parse_lookup_table(&deactivated).is_err());
}

#[test]
fn devnet_v0_unresolved_table_fails_closed() {
    let msg = b64(V0_MSG);
    assert_eq!(
        sol_message_lookup_tables(&msg).unwrap(),
        vec![ALT_KEY.to_string()]
    );
    let owner = "Do5D2qvqDeeYkdcPbaR2H1mNB3GkU4PutngjLtmqu8vV";
    assert!(matches!(
        sol_decode_message(&msg, &[], owner),
        Err(Error::InvalidInput(_))
    ));
    // A truncated table (index 8 missing) also fails.
    let short = SolLookupTable {
        key: ALT_KEY.into(),
        addresses: ALT_ADDRESSES[..8].iter().map(|s| s.to_string()).collect(),
    };
    assert!(sol_decode_message(&msg, &[short], owner).is_err());
    // A table for another key does not count.
    let wrong = SolLookupTable {
        key: "11111111111111111111111111111111".into(),
        addresses: ALT_ADDRESSES.iter().map(|s| s.to_string()).collect(),
    };
    assert!(sol_decode_message(&msg, &[wrong], owner).is_err());
}

#[test]
fn devnet_messages_never_panic_when_truncated() {
    for m in ALL_MSGS {
        let msg = b64(m);
        let tables = tables_for(&msg);
        for n in 0..msg.len() {
            assert!(sol_decode_message(
                &msg[..n],
                &tables,
                "Do5D2qvqDeeYkdcPbaR2H1mNB3GkU4PutngjLtmqu8vV"
            )
            .is_err());
        }
    }
}

fn check_sol_transfer_with_compute_budget(s: &SolTxSummary) {
    assert!(s.warnings.is_empty(), "{:?}", s.warnings);
    assert!(!s.requires_extra_confirmation);
}

fn check_memo_and_sol_transfer(s: &SolTxSummary) {
    // The memo is a 252-character JSON blob: longer than a glance (80 characters), so the
    // reinforced confirmation is required.
    assert_eq!(s.warnings, vec![SolWarning::UnusualText { instruction: 0 }]);
    assert!(s.requires_extra_confirmation);
}

fn check_spl_transfer_checked_ata_memo(s: &SolTxSummary) {
    assert!(s.warnings.is_empty(), "{:?}", s.warnings);
    assert!(!s.requires_extra_confirmation);
}

fn check_spl_transfer_ata_memo_unknown(s: &SolTxSummary) {
    // 3 signers; only the fee payer is writable. Transfer authority is the 2nd signer.
    assert_eq!(
        s.warnings,
        vec![
            SolWarning::AuthorityNotUs {
                instruction: 4,
                authority: "4tvnspM9Af164V6sBLrCB14p4nKUrJeNWTRRDRVUVWHo".into()
            },
            SolWarning::UncheckedTokenTransfer { instruction: 4 },
            SolWarning::UnknownInstruction {
                instruction: 5,
                program_id: "Bz4AoAXL8vkTSFPqR52GwNxFixAbKPJ3VShhgoS2eV2G".into()
            },
        ]
    );
    assert!(s.requires_extra_confirmation);
}

fn check_token2022_transfer_checked_multisig(s: &SolTxSummary) {
    assert_eq!(
        s.warnings,
        vec![
            SolWarning::AuthorityNotUs {
                instruction: 0,
                authority: "AZZa45NGAjk1RjXGD4KfHcdiJGP2XRQbLJ5DZunRaX1H".into()
            },
            SolWarning::Token2022ExtensionsUnverified { instruction: 0 },
        ]
    );
    assert!(s.requires_extra_confirmation);
}

fn check_v0_with_lookup_table(s: &SolTxSummary) {
    assert!(s.requires_extra_confirmation);
    assert_eq!(
        s.warnings
            .iter()
            .filter(|w| matches!(w, SolWarning::UnknownInstruction { .. }))
            .count(),
        2
    );
}

const MSG_SOL_TRANSFER_WITH_COMPUTE_BUDGET: &str = "AQADBWz1L82TicKBknZrEsoRh+qXaheRmNxFH6t5rtkqIe77iT9FI7hLysj4HbtS1/AcWyxWcpcOV/OnYCS/PdQRDpQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMGRm/lIRcy/+ytunLDm+e8jOW7xfcSayxDmzpAAAAABUpTWpkpIQZNJOhxYNo4fHw1td28kruB5B+oQEEFRI1+7yD9KnthGquvKNUZB7chMC+OmJdcbQdch3Gejf2OAQMDAAUC0AcAAAMACQPoAwAAAAAAAAICAAEMAgAAAOgDAAAAAAAA";
const MSG_MEMO_AND_SOL_TRANSFER: &str = "AQACBHxeTfDoLmo1XcYaxOjI7VPVr0K7Lwo8+U9ofgXRuIPtgViHAgoRlxih4nZFMOWBG0EYT0NxpaDnew0TfPfp3UcFSlNamSkhBk0k6HFg2jh8fDW13bySu4HkH6hAQQVEjQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAF9DI7SeTXeApwizBmhOP2rE3q1U2INkfqywcEgOpDVQCAgEA/AF7ImEiOiJzcHVnLTE2My03LTAtMTI2QGEyNDczMzc4ZTdmMCIsImFyY2giOiJhbWQ2NCIsImJ2IjoiMi4wLjAiLCJlcnIiOjAsImltcGwiOiJnbyIsIm9rIjp0cnVlLCJvcCI6Imtub2NrIiwib3MiOiJsaW51eCIsInB2IjoyLCJyZCI6MCwic2lnIjoic0FlcmlGdmlSbVpxQUQ5TkxzQnlibVNoNXFVcGRlWVJWRjhFcnFwVnFMNDhjb2RoQVZRdGFMMVdhb2NBWDFiOXZ4YzRKTG8yZkc5aThjeFdDNzRKQWdOIiwidCI6MTc5MzMzMzQyOSwidiI6MX0DAgABDAIAAAABAAAAAAAAAA==";
const MSG_SPL_TRANSFER_CHECKED_ATA_MEMO: &str = "AQAHCu+eUs85K/aGB+hQVs4UdVF54rhkRCr7GWMe0iCozAUnNtH0rpbfB9FYlLg6LMIkf4x3FCoVRzPFe4V+OP9vPM+9Pcvd4J4i2Lqc9VDdokNPZdlSZCJsWVpwEr1J5U1HKwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwZGb+UhFzL/7K26csOb57yM5bvF9xJrLEObOkAAAAAFSlNamSkhBk0k6HFg2jh8fDW13bySu4HkH6hAQQVEjQbd9uHXZaGT2cvhRs7reawctIXtX1s3kTqM9YV+/wCpjJclj04kifG7PRApFI4NgwtaE5na/xCEBI572Nvp+FnUiTeeuMjnbqjXjrchUQQhr0urR+nsRL8yBhqWnjAM3/OjOQ3rgfbQCBTOIKLGIg/usxc0tgSnn+tycEi9b60tWQFZXVbz90C8DgoY7K6AEn0i2Pd94kxsR+cCCaZIP40FBAAFAqCGAQAEAAkDIE4AAAAAAAAHBgABCAkDBgEBBgQCCQEACgwAkC9QCQAAAAkFAEJtaWRlYXJ0aDpwbGF0Zm9ybV9mZWU6c2VuZGluZzpiYzJkMDViNy01MzIyLTRkMmYtODg1MS02MGNmODI0ZDFjNzk=";
const MSG_SPL_TRANSFER_ATA_MEMO_UNKNOWN: &str = "AwIKE40XNuQf8SUxa/9K7Bj2Ilc4xmCKIUlqigKWCuP4feywOeCA8WN6+XWWgqTaTP1kjsWYCFeUGuKFV5KEekgdd3LTt7fyYoCdV1gm27V5L7rj38DgF3dWJvs1bJ5StESOqgVL77k0XjBLnSHwQxuc/zfh6e4lNUERNM2d7ZD1E0clNdJDZ/f1aIrupMpYTTFbFNnbBxzLiq995ZBJP1NKDmZqg9yZYijIB6tW0aWpY812JjuJ52uMdWaXiiQ0QVldEY1QWIovPoQBGU/DbNepVwdL7b/VvRzD/86neswfxm9LkieykruLaJlF4YYkwGLc35o0nlfV4XXlbPsjAVV8HOGw7tyGzVrQEK6wjR64ok5iEb3EWS1t164dO3pYUjQPIwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwZGb+UhFzL/7K26csOb57yM5bvF9xJrLEObOkAAAAAFSlNamSkhBk0k6HFg2jh8fDW13bySu4HkH6hAQQVEjQbd9uHXZaGT2cvhRs7reawctIXtX1s3kTqM9YV+/wCpDNCDV/AR0zu5AoG9IdgxsHZYlUiwrO4Hqoidf9wstRIO3PyarwIxf/Aj44ZCLydgT2xYEG7Bw/kA9kB/H8XJpIyXJY9OJInxuz0QKRSODYMLWhOZ2v8QhASOe9jb6fhZkHyH+x+hnpaXqaMRFuaXBwrxx7tTLXZ92F8B7hukWL+jMo73YjMX3BRsHyrsDcYb5auWHvC/IhyWrSPsy7k2sef57lPYGIaYffH23MOYZHMz2pXaElHYdugkrTHMCJDfu96LpFhvby4ELFgMvjPFiB0qTkD58dSs2RCnksg4hMQGCgAFAsBcFQAKAAkD1gIAAAAAAAALACBmNWEwMzkyY2NhYzU0MjRkOTcyNDg3MjQ3YTVlYjcxMA8GAAYCEAkMAQEMAwUGAQkDAOH1BQAAAAARFgACDRIDCAcGBBAPDAkRERERERERDhEuZgY9EgHa6+rlV94BNzjeDADh9QUAAAAAAAAAAc8HVwIAAAAAAAAAAAAAAAABAA==";
const MSG_TOKEN2022_TRANSFER_CHECKED_MULTISIG: &str = "AgEGC5AOzlqxOfWyqB7uZgbTsjWtKexhC2zbtRG82dvtekrbjhCYWP6SaLZyjJfd/DjBZQ6wBqxpGBCTlwPVNgM4VRCJNg1U/QAqglTulTu8Y2p8TgaMp1MgfQJqrDi7Z/ecAs+/AL7+msLWhOmCF02tv/rDw76p11nOYGnf6mb87Sw1B0vkY3+4mv60NhB1U9/svBV0J3l5HIgD3iKd/iGcxspncCXh9JgxA3ROlWaEB5K39zsbFsRE7hOjfZtzZf/q7GgKvl/rHJqf8ARpo4nxDW5vB61hICVKkao+GE3MWK6mbB4OQuJK9Ip12Ru4WHZsuId4tcAIV1Xkut4eAbjagdTYc9BXo3/o/pJTLykdSIkYGFAkYWdoUtHj3vbqcJQ6z+I6cadhYc3W9bPWPRYhBhI8s/hBcu+teqxwc/ffgMtSBt324e51j94YQl285GzN2rYa/E2DuQ0n/r35KNihi/yHNWjivDqeFJahxekIBhx68Gs6X1RkCdmHbX2AlA0CqgEKCQIJAwEIBgQFBwoMAOQLVAIAAAAG";
const MSG_V0_WITH_LOOKUP_TABLE: &str = "gAEABAW+Gbe7m/vPRivh8w0wpuZaCz/eWDVwzcyr1yuUXY80+gMGRm/lIRcy/+ytunLDm+e8jOW7xfcSayxDmzpAAAAAciadoXAmjQnrS9dXAEa/e/6JdSSPsRrpaXdzADTO2vYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAO7HTS/nMQRoCQZtAZcYS1T1GbElFmH2yxNMnL9LynFSF9DI7SeTXeApwizBmhOP2rE3q1U2INkfqywcEgOpDVQDAQAFAgA1DAACAwUAAzUA7w2Lb9os66QdoV1AldHaOSoNL47Qxse8D0z6yMKAtW0A4fUFAAAAAAEAAAAAAAAA+v///wQHCQYHCAUKCwxXARIALRfkagAAAAABUXmCEzgfHzGl9N2uFScVpNfLjWev9qIbr+/PQeK8K78ECAECAwMABAY=";

/// Every devnet message above, for the differential and robustness tests.
const ALL_MSGS: &[&str] = &[
    MSG_SOL_TRANSFER_WITH_COMPUTE_BUDGET,
    MSG_MEMO_AND_SOL_TRANSFER,
    MSG_SPL_TRANSFER_CHECKED_ATA_MEMO,
    MSG_SPL_TRANSFER_ATA_MEMO_UNKNOWN,
    MSG_TOKEN2022_TRANSFER_CHECKED_MULTISIG,
    MSG_V0_WITH_LOOKUP_TABLE,
];

const V0_MSG: &str = MSG_V0_WITH_LOOKUP_TABLE;

/// Devnet tx `4rEFgVVU74WT95GdkRE3TDaumZbanAfVUXYMuxg35YH7oVfSU512u7ondVrxD3Ym8XHQ15erMjP2Crar9of9TEiL` (slot 516650528).
#[test]
fn devnet_sol_transfer_with_compute_budget() {
    let msg = b64(MSG_SOL_TRANSFER_WITH_COMPUTE_BUDGET);
    let s = sol_decode_message(
        &msg,
        &tables_for(&msg),
        "8LKso1Vh9kY5KJZCaTrwrAR9FmYqGH5QzTzkSK84XXiz",
    )
    .unwrap();
    assert_eq!(s.version, "legacy");
    assert_eq!(s.fee_payer, "8LKso1Vh9kY5KJZCaTrwrAR9FmYqGH5QzTzkSK84XXiz");
    assert_eq!(
        s.signers,
        vec!["8LKso1Vh9kY5KJZCaTrwrAR9FmYqGH5QzTzkSK84XXiz".into()] as Vec<String>
    );
    assert_eq!(s.our_signer_index, Some(0));
    assert_eq!(
        s.recent_blockhash,
        "9YVrgvnazo4Ka5Ai4dibkahMWCrnqLnL1XsRY1TBGHPE"
    );
    assert_eq!(s.lookup_tables, vec![] as Vec<String>);
    assert_eq!(s.base_fee_lamports, "5000");
    assert_eq!(s.compute_unit_limit, Some(2000));
    assert_eq!(s.compute_unit_price_micro_lamports, Some("1000".into()));
    assert_eq!(s.priority_fee_lamports, Some("2".into()));
    let expected: Vec<SolInstruction> = vec![
        SolInstruction::ComputeUnitLimit { units: 2000 },
        SolInstruction::ComputeUnitPrice {
            micro_lamports: "1000".into(),
        },
        SolInstruction::SystemTransfer {
            from: "8LKso1Vh9kY5KJZCaTrwrAR9FmYqGH5QzTzkSK84XXiz".into(),
            to: "AEkp36t9hYDWEBtZooEwsrpe8hR1PjyJDpranq8fhLsM".into(),
            lamports: "1000".into(),
        },
    ];
    assert_eq!(s.instructions, expected);
    check_sol_transfer_with_compute_budget(&s);
}

/// Devnet tx `3PMYbhTShrVPtNet5WTHSCq51vihP748UBi2Xdfjm1QgszEKxH5efD4HkvNhPutoaL6AVqCiEZUis4Vj6ady9a2m` (slot 516650528).
#[test]
fn devnet_memo_and_sol_transfer() {
    let msg = b64(MSG_MEMO_AND_SOL_TRANSFER);
    let s = sol_decode_message(
        &msg,
        &tables_for(&msg),
        "9NUxZFT68h9nw1vEi1nugK7osFLtfMA1vhtnWEVkm4jn",
    )
    .unwrap();
    assert_eq!(s.version, "legacy");
    assert_eq!(s.fee_payer, "9NUxZFT68h9nw1vEi1nugK7osFLtfMA1vhtnWEVkm4jn");
    assert_eq!(
        s.signers,
        vec!["9NUxZFT68h9nw1vEi1nugK7osFLtfMA1vhtnWEVkm4jn".into()] as Vec<String>
    );
    assert_eq!(s.our_signer_index, Some(0));
    assert_eq!(
        s.recent_blockhash,
        "2by2bKorRfCkXLq8wFyvtidgSdvoKeTaidHYYnioNSnP"
    );
    assert_eq!(s.lookup_tables, vec![] as Vec<String>);
    assert_eq!(s.base_fee_lamports, "5000");
    assert_eq!(s.compute_unit_limit, None);
    assert_eq!(s.compute_unit_price_micro_lamports, None);
    assert_eq!(s.priority_fee_lamports, None);
    let expected: Vec<SolInstruction> = vec![
        SolInstruction::Memo { text: "{\"a\":\"spug-163-7-0-126@a2473378e7f0\",\"arch\":\"amd64\",\"bv\":\"2.0.0\",\"err\":0,\"impl\":\"go\",\"ok\":true,\"op\":\"knock\",\"os\":\"linux\",\"pv\":2,\"rd\":0,\"sig\":\"sAeriFviRmZqAD9NLsBybmSh5qUpdeYRVF8ErqpVqL48codhAVQtaL1WaocAX1b9vxc4JLo2fG9i8cxWC74JAgN\",\"t\":1793333429,\"v\":1}".into() },
        SolInstruction::SystemTransfer { from: "9NUxZFT68h9nw1vEi1nugK7osFLtfMA1vhtnWEVkm4jn".into(), to: "9hutT74eahwabjp15KoHfJ8JxJWvA7vbg9HKo7tqZr14".into(), lamports: "1".into() },
    ];
    assert_eq!(s.instructions, expected);
    check_memo_and_sol_transfer(&s);
}

/// Devnet tx `Y64RMd5dw8hYSdkzWNZkeia4zeJJYnkdr4uiPk7TTTdvYtbJD6FhesrBdvxqXmx3dBhetChM3Dw4Ddh5ibJN1UH` (slot 516650981).
#[test]
fn devnet_spl_transfer_checked_ata_memo() {
    let msg = b64(MSG_SPL_TRANSFER_CHECKED_ATA_MEMO);
    let s = sol_decode_message(
        &msg,
        &tables_for(&msg),
        "H8NTnfACuBg3yW93e3pS6GveUhpFVgx2MvDqgMUfrtog",
    )
    .unwrap();
    assert_eq!(s.version, "legacy");
    assert_eq!(s.fee_payer, "H8NTnfACuBg3yW93e3pS6GveUhpFVgx2MvDqgMUfrtog");
    assert_eq!(
        s.signers,
        vec!["H8NTnfACuBg3yW93e3pS6GveUhpFVgx2MvDqgMUfrtog".into()] as Vec<String>
    );
    assert_eq!(s.our_signer_index, Some(0));
    assert_eq!(
        s.recent_blockhash,
        "6zSUjnGVvu5hSDjTMgHRq8eG7tKYMVDKrhhXDekLWue4"
    );
    assert_eq!(s.lookup_tables, vec![] as Vec<String>);
    assert_eq!(s.base_fee_lamports, "5000");
    assert_eq!(s.compute_unit_limit, Some(100000));
    assert_eq!(s.compute_unit_price_micro_lamports, Some("20000".into()));
    assert_eq!(s.priority_fee_lamports, Some("2000".into()));
    let expected: Vec<SolInstruction> = vec![
        SolInstruction::ComputeUnitLimit { units: 100000 },
        SolInstruction::ComputeUnitPrice {
            micro_lamports: "20000".into(),
        },
        SolInstruction::AtaCreate {
            idempotent: true,
            payer: "H8NTnfACuBg3yW93e3pS6GveUhpFVgx2MvDqgMUfrtog".into(),
            account: "4gzhhL2C5TpSf6yCtgTe9Rdiy7amXMpkdvDevZuS6HYr".into(),
            owner: "FJengPW4kXiiyHyssaJhmMtsv9RMjc2nMe4kQh8hYVb4".into(),
            mint: "HQ4Rh1vjADTLLh9Mey8PP3jX4WJCddKqq1Gaf8UNpJLt".into(),
            token_program: Some("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA".into()),
        },
        SolInstruction::TokenTransfer {
            token_program: SolTokenProgram::Token,
            checked: true,
            source: "Djii4L38NMcFyeSQmgJeVsk7FbWYawjWPpyYg1PyFo4N".into(),
            destination: "4gzhhL2C5TpSf6yCtgTe9Rdiy7amXMpkdvDevZuS6HYr".into(),
            authority: "H8NTnfACuBg3yW93e3pS6GveUhpFVgx2MvDqgMUfrtog".into(),
            mint: Some("HQ4Rh1vjADTLLh9Mey8PP3jX4WJCddKqq1Gaf8UNpJLt".into()),
            amount: "40000000000".into(),
            decimals: Some(9),
            multisig_signers: vec![],
        },
        SolInstruction::Memo {
            text: "midearth:platform_fee:sending:bc2d05b7-5322-4d2f-8851-60cf824d1c79".into(),
        },
    ];
    assert_eq!(s.instructions, expected);
    check_spl_transfer_checked_ata_memo(&s);
}

/// Devnet tx `62PCCzTrBs3RVBbRJqUeUKmmzUQ74f71vCvZBjdpQLn44BPoGaRJFnFauesuuqfgV9vkcRCJcnNVay34qfFhu9Xy` (slot 516650528).
#[test]
fn devnet_spl_transfer_ata_memo_unknown() {
    let msg = b64(MSG_SPL_TRANSFER_ATA_MEMO_UNKNOWN);
    let s = sol_decode_message(
        &msg,
        &tables_for(&msg),
        "AVm1wwtnLtsdJSpgz8S2SfC4JDepipEwBpLYuHgQ25Yb",
    )
    .unwrap();
    assert_eq!(s.version, "legacy");
    assert_eq!(s.fee_payer, "AVm1wwtnLtsdJSpgz8S2SfC4JDepipEwBpLYuHgQ25Yb");
    assert_eq!(
        s.signers,
        vec![
            "AVm1wwtnLtsdJSpgz8S2SfC4JDepipEwBpLYuHgQ25Yb".into(),
            "4tvnspM9Af164V6sBLrCB14p4nKUrJeNWTRRDRVUVWHo".into(),
            "FFTWLe1cSs5ZJC8i92f2o3VnRuXRo9FXtkiU5LxehG4q".into()
        ] as Vec<String>
    );
    assert_eq!(s.our_signer_index, Some(0));
    assert_eq!(
        s.recent_blockhash,
        "DeN4UGLZNS3RM1YouU8kRBu9WzEKYeqTcAUJmBg37jDu"
    );
    assert_eq!(s.lookup_tables, vec![] as Vec<String>);
    assert_eq!(s.base_fee_lamports, "15000");
    assert_eq!(s.compute_unit_limit, Some(1400000));
    assert_eq!(s.compute_unit_price_micro_lamports, Some("726".into()));
    assert_eq!(s.priority_fee_lamports, Some("1017".into()));
    let expected: Vec<SolInstruction> = vec![
        SolInstruction::ComputeUnitLimit { units: 1400000 },
        SolInstruction::ComputeUnitPrice {
            micro_lamports: "726".into(),
        },
        SolInstruction::Memo {
            text: "f5a0392ccac5424d972487247a5eb710".into(),
        },
        SolInstruction::AtaCreate {
            idempotent: true,
            payer: "AVm1wwtnLtsdJSpgz8S2SfC4JDepipEwBpLYuHgQ25Yb".into(),
            account: "AWdYXuLBuTNHRwpi1UgSrviFzfSrCa1QXszMPu8Njtpz".into(),
            owner: "FFTWLe1cSs5ZJC8i92f2o3VnRuXRo9FXtkiU5LxehG4q".into(),
            mint: "Aj1qyqJRvi7VFdCriNvLiiCvjkLW3pTRgFCKSyGtAbsk".into(),
            token_program: Some("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA".into()),
        },
        SolInstruction::TokenTransfer {
            token_program: SolTokenProgram::Token,
            checked: false,
            source: "8AnqSPLDLU5gPpEpKs2zGBRHJYW11M1F2EwAwqYt4XbW".into(),
            destination: "AWdYXuLBuTNHRwpi1UgSrviFzfSrCa1QXszMPu8Njtpz".into(),
            authority: "4tvnspM9Af164V6sBLrCB14p4nKUrJeNWTRRDRVUVWHo".into(),
            mint: None,
            amount: "100000000".into(),
            decimals: None,
            multisig_signers: vec![],
        },
        SolInstruction::Unknown {
            program_id: "Bz4AoAXL8vkTSFPqR52GwNxFixAbKPJ3VShhgoS2eV2G".into(),
            accounts: 22,
            account_keys: vec![
                "AVm1wwtnLtsdJSpgz8S2SfC4JDepipEwBpLYuHgQ25Yb".into(),
                "FFTWLe1cSs5ZJC8i92f2o3VnRuXRo9FXtkiU5LxehG4q".into(),
                "s2JYD9gUSLa3ZnUwvG1Y8XhEzsogr41R6NgAWqD6k8h".into(),
                "GcYDfgs2rPoGiGi8YkfsDxpH2Y3BaZmEC4Jy9CRgh7ev".into(),
                "MgCRrXdwbQnLQjTTU42Csxf4ZgiRaf38EZY2N4u1UGL".into(),
                "Cug1J3gUxyJNsYS5C2BV3MnDRrcrfJAJjTHEMD1c2noC".into(),
                "AqXdh2gitJdFdTQNqkop6tGQZ5594hWCVFkTwTgckJpG".into(),
                "AWdYXuLBuTNHRwpi1UgSrviFzfSrCa1QXszMPu8Njtpz".into(),
                "4d6ZpjgYkaMSy6PCx7rqhmiLz7vqYKL9s3JSm9xAPPc1".into(),
                "Aj1qyqJRvi7VFdCriNvLiiCvjkLW3pTRgFCKSyGtAbsk".into(),
                "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL".into(),
                "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA".into(),
                "11111111111111111111111111111111".into(),
                "Bz4AoAXL8vkTSFPqR52GwNxFixAbKPJ3VShhgoS2eV2G".into(),
                "Bz4AoAXL8vkTSFPqR52GwNxFixAbKPJ3VShhgoS2eV2G".into(),
                "Bz4AoAXL8vkTSFPqR52GwNxFixAbKPJ3VShhgoS2eV2G".into(),
                "Bz4AoAXL8vkTSFPqR52GwNxFixAbKPJ3VShhgoS2eV2G".into(),
                "Bz4AoAXL8vkTSFPqR52GwNxFixAbKPJ3VShhgoS2eV2G".into(),
                "Bz4AoAXL8vkTSFPqR52GwNxFixAbKPJ3VShhgoS2eV2G".into(),
                "Bz4AoAXL8vkTSFPqR52GwNxFixAbKPJ3VShhgoS2eV2G".into(),
                "2129g7V5wHFByM2tM3BvPfo4J4QhnmeX4yhz2aQ1mYdZ".into(),
                "Bz4AoAXL8vkTSFPqR52GwNxFixAbKPJ3VShhgoS2eV2G".into(),
            ],
            data_len: 46,
        },
    ];
    assert_eq!(s.instructions, expected);
    check_spl_transfer_ata_memo_unknown(&s);
}

/// Devnet tx `G9kxDzrCDpWdGBwE3hujmT83w6jZWUU6f9XzhU9ioyGqk3YpjFswWpaWuv3it51Hp2dbqm1YLtB5PxrQZizCCTh` (slot 516650655).
#[test]
fn devnet_token2022_transfer_checked_multisig() {
    let msg = b64(MSG_TOKEN2022_TRANSFER_CHECKED_MULTISIG);
    let s = sol_decode_message(
        &msg,
        &tables_for(&msg),
        "AhLoaSAezhRCN9U5fwsAqSTSBrHCEnjoFf5MUgDHk5kN",
    )
    .unwrap();
    assert_eq!(s.version, "legacy");
    assert_eq!(s.fee_payer, "AhLoaSAezhRCN9U5fwsAqSTSBrHCEnjoFf5MUgDHk5kN");
    assert_eq!(
        s.signers,
        vec![
            "AhLoaSAezhRCN9U5fwsAqSTSBrHCEnjoFf5MUgDHk5kN".into(),
            "AZZa45NGAjk1RjXGD4KfHcdiJGP2XRQbLJ5DZunRaX1H".into()
        ] as Vec<String>
    );
    assert_eq!(s.our_signer_index, Some(0));
    assert_eq!(
        s.recent_blockhash,
        "A6oGx9t3eDx6txDAZHMj6Knm6xRCfpCSaLGNN5xBwAsb"
    );
    assert_eq!(s.lookup_tables, vec![] as Vec<String>);
    assert_eq!(s.base_fee_lamports, "10000");
    assert_eq!(s.compute_unit_limit, None);
    assert_eq!(s.compute_unit_price_micro_lamports, None);
    assert_eq!(s.priority_fee_lamports, None);
    let expected: Vec<SolInstruction> = vec![SolInstruction::TokenTransfer {
        token_program: SolTokenProgram::Token2022,
        checked: true,
        source: "AEcfCHAAuFm8XSb4jSfRYPcDc8TwDcthzhA4QnubmHoP".into(),
        destination: "EyxKQg6SLTmggrfgaUK7u2VzkbA8tL6YNBK1crs2ZrZ2".into(),
        authority: "AZZa45NGAjk1RjXGD4KfHcdiJGP2XRQbLJ5DZunRaX1H".into(),
        mint: Some("GE6q1pL6TjYkrc9jwpdCJAKqZDmAscVR7D9dV7MmXPpd".into()),
        amount: "10000000000".into(),
        decimals: Some(6),
        multisig_signers: vec![
            "FZwVNCiByZTSF4MLcdu6vf19u9qz8xRpufZwGR54y4sY".into(),
            "818uLMrmVcYKFDYQxMxXe1VtvGU7BZm25Wxkd19PXcWR".into(),
            "VUyT7iE2wjedHKnv4FMZ7c6zc7ae56q2vsskudy1fE1".into(),
            "7xnBGoQUVVyf98buswiFg4UamB3FxW4GujXSQoXWyqkX".into(),
            "8H3cYPVmoRJHFqASNjq9AskhzjaWHupqpwC9UH6vbpgb".into(),
        ],
    }];
    assert_eq!(s.instructions, expected);
    check_token2022_transfer_checked_multisig(&s);
}

/// Devnet tx `gSLaSgW4zkYXemrW8M6D2FZgpEJmAwvgiERSCXbuLaD1RCDR3hbxiF7mb1Ffkm4EudCK41ZS7VxPyQQG7QpVg4q` (slot 516650530).
#[test]
fn devnet_v0_with_lookup_table() {
    let msg = b64(MSG_V0_WITH_LOOKUP_TABLE);
    let s = sol_decode_message(
        &msg,
        &tables_for(&msg),
        "Do5D2qvqDeeYkdcPbaR2H1mNB3GkU4PutngjLtmqu8vV",
    )
    .unwrap();
    assert_eq!(s.version, "v0");
    assert_eq!(s.fee_payer, "Do5D2qvqDeeYkdcPbaR2H1mNB3GkU4PutngjLtmqu8vV");
    assert_eq!(
        s.signers,
        vec!["Do5D2qvqDeeYkdcPbaR2H1mNB3GkU4PutngjLtmqu8vV".into()] as Vec<String>
    );
    assert_eq!(s.our_signer_index, Some(0));
    assert_eq!(
        s.recent_blockhash,
        "2by2bKorRfCkXLq8wFyvtidgSdvoKeTaidHYYnioNSnP"
    );
    assert_eq!(
        s.lookup_tables,
        vec!["6V3VBaaX5tLD49eRgaY7TjWBPtgkmEC7sirA4NDVkLBQ".into()] as Vec<String>
    );
    assert_eq!(s.base_fee_lamports, "5000");
    assert_eq!(s.compute_unit_limit, Some(800000));
    assert_eq!(s.compute_unit_price_micro_lamports, None);
    assert_eq!(s.priority_fee_lamports, None);
    let expected: Vec<SolInstruction> = vec![
        SolInstruction::ComputeUnitLimit { units: 800000 },
        SolInstruction::Unknown {
            program_id: "8gbdWezYNGiidNACtJ8ax4k4msDNUebRAqnj3qwR1SKX".into(),
            accounts: 3,
            account_keys: vec![
                "GnhCpX9Rgj8gpJVqdQzAyvgXmV22dYxJWjquakq1FHji".into(),
                "Do5D2qvqDeeYkdcPbaR2H1mNB3GkU4PutngjLtmqu8vV".into(),
                "11111111111111111111111111111111".into(),
            ],
            data_len: 53,
        },
        SolInstruction::Unknown {
            program_id: "H56J8WPAgZX7hctS8Gw2aZDJrVGGqQwiuEa9XuccyaDf".into(),
            accounts: 7,
            account_keys: vec![
                "81CSa1FTbc75dmZ9kEaFrb4fYzdxG8bVA533cQRMhdid".into(),
                "ERLhKUYPMfiTM2946xjJEPwMNaF5taHjAw9wpUdqSMmk".into(),
                "Ae72kG3bNWNqTewhAjFG4nYbuhFN5ty4oAz8LwsrMS9c".into(),
                "AsNTyfJKyFt1YUC57JJqiwWau8sZzoijcwvwCEPxPo6f".into(),
                "GnhCpX9Rgj8gpJVqdQzAyvgXmV22dYxJWjquakq1FHji".into(),
                "2Mug8msmZLQPffVesxN8Mznj24QGtfzuPHzEPGNg2XMr".into(),
                "ENc5LdNosDxw2f9Z4UWdfvPtVWdUEQRfJngPVcGqZMSk".into(),
            ],
            data_len: 12,
        },
    ];
    assert_eq!(s.instructions, expected);
    check_v0_with_lookup_table(&s);
}

// ------------------------------------------------------------------------------------------
// Differential tests against Anza's reference `solana-message` crate (dev-dependency only).
// ------------------------------------------------------------------------------------------

use solana_message::VersionedMessage;

struct Reference {
    signers: Vec<String>,
    blockhash: String,
    tables: Vec<String>,
    /// (program id, accounts, data) with lookup-table entries resolved.
    instructions: Vec<(String, Vec<String>, Vec<u8>)>,
}

fn reference(msg: &[u8], tables: &[SolLookupTable]) -> Option<Reference> {
    let vm: VersionedMessage = wincode::deserialize(msg).ok()?;
    vm.sanitize().ok()?;
    let mut keys: Vec<String> = vm
        .static_account_keys()
        .iter()
        .map(|k| k.to_string())
        .collect();
    let mut table_keys = Vec::new();
    if let Some(lookups) = vm.address_table_lookups() {
        let mut writable = Vec::new();
        let mut readonly = Vec::new();
        for l in lookups {
            let key = l.account_key.to_string();
            let t = tables.iter().find(|t| t.key == key)?;
            for i in &l.writable_indexes {
                writable.push(t.addresses.get(usize::from(*i))?.clone());
            }
            for i in &l.readonly_indexes {
                readonly.push(t.addresses.get(usize::from(*i))?.clone());
            }
            table_keys.push(key);
        }
        keys.extend(writable);
        keys.extend(readonly);
    }
    let n_signers = usize::from(vm.header().num_required_signatures);
    let instructions = vm
        .instructions()
        .iter()
        .map(|ix| {
            Some((
                keys.get(usize::from(ix.program_id_index))?.clone(),
                ix.accounts
                    .iter()
                    .map(|a| keys.get(usize::from(*a)).cloned())
                    .collect::<Option<Vec<_>>>()?,
                ix.data.clone(),
            ))
        })
        .collect::<Option<Vec<_>>>()?;
    Some(Reference {
        signers: keys.get(..n_signers)?.to_vec(),
        blockhash: vm.recent_blockhash().to_string(),
        tables: table_keys,
        instructions,
    })
}

/// Checks that every account our decoder reports is the one the reference puts at that slot.
fn assert_matches_reference(ours: &SolTxSummary, r: &Reference) {
    assert_eq!(ours.signers, r.signers);
    assert_eq!(ours.fee_payer, r.signers[0]);
    assert_eq!(ours.recent_blockhash, r.blockhash);
    assert_eq!(ours.lookup_tables, r.tables);
    assert_eq!(ours.instructions.len(), r.instructions.len());
    for (ins, (program, acc, data)) in ours.instructions.iter().zip(&r.instructions) {
        let p = program.as_str();
        match ins {
            SolInstruction::Unknown {
                program_id,
                accounts,
                account_keys,
                data_len,
            } => {
                assert_eq!(
                    (program_id, accounts, account_keys, data_len),
                    (program, &acc.len(), acc, &data.len())
                );
            }
            SolInstruction::SystemTransfer { from, to, .. } => {
                assert_eq!(p, "11111111111111111111111111111111");
                assert_eq!((from, to), (&acc[0], &acc[1]));
            }
            SolInstruction::TokenTransfer {
                token_program,
                checked,
                source,
                destination,
                authority,
                mint,
                multisig_signers,
                ..
            } => {
                let expected_program = match token_program {
                    SolTokenProgram::Token => "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
                    SolTokenProgram::Token2022 => "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
                };
                assert_eq!(p, expected_program);
                if *checked {
                    assert_eq!(data[0], 12);
                    assert_eq!(
                        (source, mint.as_ref(), destination, authority),
                        (&acc[0], Some(&acc[1]), &acc[2], &acc[3])
                    );
                    assert_eq!(multisig_signers, &acc[4..]);
                } else {
                    assert_eq!(data[0], 3);
                    assert_eq!(
                        (source, destination, authority),
                        (&acc[0], &acc[1], &acc[2])
                    );
                    assert_eq!(multisig_signers, &acc[3..]);
                }
            }
            SolInstruction::AtaCreate {
                payer,
                account,
                owner,
                mint,
                token_program,
                ..
            } => {
                assert_eq!(p, "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
                assert_eq!(
                    (payer, account, owner, mint),
                    (&acc[0], &acc[1], &acc[2], &acc[3])
                );
                assert_eq!(token_program.as_ref(), acc.get(5));
            }
            SolInstruction::ComputeUnitLimit { .. } | SolInstruction::ComputeUnitPrice { .. } => {
                assert_eq!(p, "ComputeBudget111111111111111111111111111111");
            }
            SolInstruction::Memo { text } => {
                assert_eq!(p, "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
                let raw = std::str::from_utf8(data).expect("memo decoded from valid UTF-8");
                assert_eq!(text, &sanitize_text(raw, 566).text);
            }
            other => panic!("not covered by the devnet set: {other:?}"),
        }
    }
}

#[test]
fn differential_against_solana_message() {
    for m in ALL_MSGS {
        let msg = b64(m);
        let tables = tables_for(&msg);
        let r = reference(&msg, &tables).expect("reference decodes real devnet messages");
        let ours = sol_decode_message(&msg, &tables, &r.signers[0]).unwrap();
        assert_matches_reference(&ours, &r);
    }
}

/// Deterministic mutation fuzzing: whenever our decoder accepts a mutated message, the
/// reference must accept it too and agree on every account; we never panic.
#[test]
fn differential_mutations() {
    let mut state: u64 = 0x9e37_79b9_7f4a_7c15;
    let mut next = || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        state
    };
    let mut accepted = 0usize;
    for m in ALL_MSGS {
        let original = b64(m);
        let tables = tables_for(&original);
        let owner = reference(&original, &tables).unwrap().signers[0].clone();
        for _ in 0..1500 {
            let mut msg = original.clone();
            for _ in 0..(1 + next() % 3) {
                let pos = (next() as usize) % msg.len();
                msg[pos] = next() as u8;
            }
            if let Ok(ours) = sol_decode_message(&msg, &tables, &owner) {
                accepted += 1;
                let r = reference(&msg, &tables).expect("reference must accept what we accept");
                assert_matches_reference(&ours, &r);
            }
        }
    }
    assert!(accepted > 0);
}
