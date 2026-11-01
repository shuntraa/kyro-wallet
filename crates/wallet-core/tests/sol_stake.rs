//! Solana native staking: decoder rules, Kyro's message builder, stake-account parsing and the
//! activation (warm-up / cool-down) computation.

use base64::Engine as _;
use wallet_core::{
    sol_create_with_seed, sol_decode_message, sol_parse_stake_account, sol_parse_stake_history,
    sol_sign_message, sol_stake_activation, sol_stake_message, sol_stake_withdrawable, Mnemonic,
    SolDelegation, SolInstruction, SolStakeActivation, SolStakeHistoryEntry, SolStakeOp,
    SOL_STAKE_PROGRAM,
};

const ALL: &str = "all all all all all all all all all all all all";
const ME: &str = "14CCvQzQzHCVgZM3j9soPnXuJXh1RmCfwLVUcdfbZVBS";
const OTHER: &str = "AeDJ1BqA7ruBbd6mEcS1QNxFbT8FQbiBVuN9NqK94Taq";
const VOTE: &str = "ETxHeBBcuw9Yu4dGuP3oXrD12V5RECvmi8ogQ9PkjyVF";
const BLOCKHASH: &str = "2p4rYZAaFfV5Uk5ugdG5KPNty9Uda9B3b4gWB8qnNqak";

struct Vector {
    name: &'static str,
    header: [u8; 3],
    accounts: &'static [&'static str],
    blockhash: &'static str,
    instructions: &'static [(u8, &'static [u8], &'static str)],
    signature: &'static str,
}

fn key(s: &str) -> [u8; 32] {
    bitcoin::base58::decode(s).unwrap().try_into().unwrap()
}

fn sv(n: usize, out: &mut Vec<u8>) {
    let mut n = n;
    loop {
        let mut b = (n & 0x7f) as u8;
        n >>= 7;
        if n != 0 {
            b |= 0x80;
        }
        out.push(b);
        if n == 0 {
            return;
        }
    }
}

fn message(v: &Vector) -> Vec<u8> {
    let mut m = v.header.to_vec();
    sv(v.accounts.len(), &mut m);
    for a in v.accounts {
        m.extend_from_slice(&key(a));
    }
    m.extend_from_slice(&key(v.blockhash));
    sv(v.instructions.len(), &mut m);
    for (p, accs, data) in v.instructions {
        m.push(*p);
        sv(accs.len(), &mut m);
        m.extend_from_slice(accs);
        let d = hex::decode(data).unwrap();
        sv(d.len(), &mut m);
        m.extend_from_slice(&d);
    }
    m
}

fn seed() -> wallet_core::Seed {
    Mnemonic::parse(ALL).unwrap().to_seed("")
}

const TREZOR: &[Vector] = &[
    Vector {
        name: "Initialize Stake Account",
        header: [1, 0, 2],
        accounts: &["14CCvQzQzHCVgZM3j9soPnXuJXh1RmCfwLVUcdfbZVBS", "ATFXMD5cYiw9yHkvexgx3nf9LNSouEViB5BZBsgwunAv", "Stake11111111111111111111111111111111111111", "SysvarRent111111111111111111111111111111111"],
        blockhash: "2p4rYZAaFfV5Uk5ugdG5KPNty9Uda9B3b4gWB8qnNqak",
        instructions: &[
            (2, &[1, 3], "0000000000d1699dcb1811b50bb0055f13044463128242e37a463b52f6c97a1f6eef88ad00d1699dcb1811b50bb0055f13044463128242e37a463b52f6c97a1f6eef88ad14000000000000004a0100000000000000d1699dcb1811b50bb0055f13044463128242e37a463b52f6c97a1f6eef88ad"),
        ],
        signature: "196037eae9f57396938a8c673d255a8f34f1d79200fb439a1bcc551484b0a79716e8db42af041f23207f9e9e7603e567ba8fb9b6ffa4f20dad64e1277453530d",
    },
    Vector {
        name: "Authorize",
        header: [1, 0, 1],
        accounts: &["14CCvQzQzHCVgZM3j9soPnXuJXh1RmCfwLVUcdfbZVBS", "ATFXMD5cYiw9yHkvexgx3nf9LNSouEViB5BZBsgwunAv", "SysvarC1ock11111111111111111111111111111111", "Stake11111111111111111111111111111111111111"],
        blockhash: "2p4rYZAaFfV5Uk5ugdG5KPNty9Uda9B3b4gWB8qnNqak",
        instructions: &[
            (3, &[1, 2, 0], "01000000c80f8b50107e9f3e3c16a661b8c806df454a6deb293d5e8730a9d28f2f4998c600000000"),
        ],
        signature: "e1c3a670771b50cb1a503ec46fd5674191753eaeb76c6c38a84417123887374e5873c0d27a0e3bf26b745a591ca540dba79113856441e7f606683aecba5cfa00",
    },
    Vector {
        name: "Delegate",
        header: [1, 0, 5],
        accounts: &["14CCvQzQzHCVgZM3j9soPnXuJXh1RmCfwLVUcdfbZVBS", "ETxHeBBcuw9Yu4dGuP3oXrD12V5RECvmi8ogQ9PkjyVF", "Stake11111111111111111111111111111111111111", "StakeConfig11111111111111111111111111111111", "SysvarC1ock11111111111111111111111111111111", "SysvarStakeHistory1111111111111111111111111"],
        blockhash: "2p4rYZAaFfV5Uk5ugdG5KPNty9Uda9B3b4gWB8qnNqak",
        instructions: &[
            (2, &[0, 1, 4, 5, 3, 0], "02000000"),
        ],
        signature: "05d5bbece41d3ff7b330e17112a1249f2dee18ce07df8350ca904e64f9f2bab8b3590b91390f9cb773b9b53262663261d7ea734ef688c1c5fcfc6712310b7000",
    },
    Vector {
        name: "Split",
        header: [2, 0, 2],
        accounts: &["14CCvQzQzHCVgZM3j9soPnXuJXh1RmCfwLVUcdfbZVBS", "ETxHeBBcuw9Yu4dGuP3oXrD12V5RECvmi8ogQ9PkjyVF", "11111111111111111111111111111111", "Stake11111111111111111111111111111111111111"],
        blockhash: "2p4rYZAaFfV5Uk5ugdG5KPNty9Uda9B3b4gWB8qnNqak",
        instructions: &[
            (2, &[0, 1], "000000000000000000000000c80000000000000006a1d8179137542a983437bdfe2a7ab2557f535c8a78722b68a49dc000000000"),
            (3, &[0, 1, 0], "0300000040420f0000000000"),
        ],
        signature: "999ba80a6183a2c99b43880190572e457a0398eb8acfa806d2c284cf2ebf9a0878239e8d1e62ac061a568db866424ccc0175c075536e325cb1f14968c0fbdc05",
    },
    Vector {
        name: "Withdraw",
        header: [1, 0, 3],
        accounts: &["14CCvQzQzHCVgZM3j9soPnXuJXh1RmCfwLVUcdfbZVBS", "ATFXMD5cYiw9yHkvexgx3nf9LNSouEViB5BZBsgwunAv", "Stake11111111111111111111111111111111111111", "SysvarC1ock11111111111111111111111111111111", "SysvarStakeHistory1111111111111111111111111"],
        blockhash: "2p4rYZAaFfV5Uk5ugdG5KPNty9Uda9B3b4gWB8qnNqak",
        instructions: &[
            (2, &[1, 0, 3, 4, 0, 0], "0400000040420f0000000000"),
        ],
        signature: "2da1355daca8802daddb33bd79767ca7c4c4f3e79b4949cde10559a1836acbbd409f2227040d6b502d84292e91910ad0f12dc8a151b42e39b130a1dcd165860a",
    },
    Vector {
        name: "Deactivate",
        header: [1, 0, 2],
        accounts: &["14CCvQzQzHCVgZM3j9soPnXuJXh1RmCfwLVUcdfbZVBS", "ATFXMD5cYiw9yHkvexgx3nf9LNSouEViB5BZBsgwunAv", "Stake11111111111111111111111111111111111111", "SysvarC1ock11111111111111111111111111111111"],
        blockhash: "2p4rYZAaFfV5Uk5ugdG5KPNty9Uda9B3b4gWB8qnNqak",
        instructions: &[
            (2, &[1, 3, 0], "05000000"),
        ],
        signature: "6320fa5c4ced21216459f85cc180d9bb69b9f335ba6e9c71ea0482184b41020c0145f72cb0306e7f33967be8828cf4bcbfd960381e87ff0871bf1e4688bef505",
    },
    Vector {
        name: "Set Lockup - with epoch only",
        header: [1, 0, 1],
        accounts: &["14CCvQzQzHCVgZM3j9soPnXuJXh1RmCfwLVUcdfbZVBS", "ATFXMD5cYiw9yHkvexgx3nf9LNSouEViB5BZBsgwunAv", "Stake11111111111111111111111111111111111111"],
        blockhash: "6Tq9obRZkiwPGQv7bX8FbMNHFBVKCXsWd5MJqSWw884Z",
        instructions: &[
            (2, &[1, 0], "060000000001140000000000000000"),
        ],
        signature: "6b21c7f625ff58ab64d9f3c54169565a1960d1612b2d5d9f51db1e17a23f3ec76955aac25fce636302c0b8db61c932e80d4031fd019a89aa6ad10c59d8a0f00b",
    },
    Vector {
        name: "Set Lockup - with all params set",
        header: [1, 0, 1],
        accounts: &["14CCvQzQzHCVgZM3j9soPnXuJXh1RmCfwLVUcdfbZVBS", "ATFXMD5cYiw9yHkvexgx3nf9LNSouEViB5BZBsgwunAv", "Stake11111111111111111111111111111111111111"],
        blockhash: "ENP1bFTWGR7GiPcPg7TB9ekX82xaham8aFkB7vQeoNaZ",
        instructions: &[
            (2, &[1, 0], "060000000152babd1c000000000114000000000000000100d1699dcb1811b50bb0055f13044463128242e37a463b52f6c97a1f6eef88ad"),
        ],
        signature: "b92c3f408965ceee6512ede6dec12b0436eb62e9631b5f9a4eef33384a745f0d57d583cb808ae41f2cfb24ffa768738724269a3f528be491e64162b016cbce03",
    },
    Vector {
        name: "Set Lockup - clear lockup with zero values",
        header: [1, 0, 1],
        accounts: &["14CCvQzQzHCVgZM3j9soPnXuJXh1RmCfwLVUcdfbZVBS", "ATFXMD5cYiw9yHkvexgx3nf9LNSouEViB5BZBsgwunAv", "Stake11111111111111111111111111111111111111"],
        blockhash: "ENP1bFTWGR7GiPcPg7TB9ekX82xaham8aFkB7vQeoNaZ",
        instructions: &[
            (2, &[1, 0], "0600000001000000000000000001000000000000000000"),
        ],
        signature: "cdfb4dee4c413b9538196b41bc7d97325e3b7f2042eee9b0d3b1c374512f1af9e0f8f5f5f5453441fee3fdda917aff75399b9a87b2c993912f5c9a2087eb000a",
    },
    Vector {
        name: "Merge",
        header: [1, 0, 3],
        accounts: &["14CCvQzQzHCVgZM3j9soPnXuJXh1RmCfwLVUcdfbZVBS", "AeDJ1BqA7ruBbd6mEcS1QNxFbT8FQbiBVuN9NqK94Taq", "ATFXMD5cYiw9yHkvexgx3nf9LNSouEViB5BZBsgwunAv", "Stake11111111111111111111111111111111111111", "SysvarC1ock11111111111111111111111111111111", "SysvarStakeHistory1111111111111111111111111"],
        blockhash: "2p4rYZAaFfV5Uk5ugdG5KPNty9Uda9B3b4gWB8qnNqak",
        instructions: &[
            (3, &[2, 1, 4, 5, 0], "07000000"),
        ],
        signature: "e2035c812b38b6524698c1e77fff5470471dc5c0a9a163e6a0d236b41f3ccf5ab0c03b2e5694f3776f5cf8c1838e47b429f4e52389e118665e6d609db4e0d30c",
    },
    Vector {
        name: "Authorize With Seed",
        header: [1, 0, 2],
        accounts: &["14CCvQzQzHCVgZM3j9soPnXuJXh1RmCfwLVUcdfbZVBS", "ATFXMD5cYiw9yHkvexgx3nf9LNSouEViB5BZBsgwunAv", "Stake11111111111111111111111111111111111111", "SysvarC1ock11111111111111111111111111111111"],
        blockhash: "2p4rYZAaFfV5Uk5ugdG5KPNty9Uda9B3b4gWB8qnNqak",
        instructions: &[
            (2, &[1, 0, 3], "08000000c80f8b50107e9f3e3c16a661b8c806df454a6deb293d5e8730a9d28f2f4998c60100000007000000000000007374616b653a300000000000000000000000000000000000000000000000000000000000000000"),
        ],
        signature: "2cfb0d5ad4e2674d20ee7c5dc64c5d7068ae2a31019662b940239394769843f7df77d596ff8f9dfac78ab0f264bacc9c38b806d210eddd5870d68d923c558c0b",
    },
    Vector {
        name: "Initialize Checked",
        header: [1, 0, 3],
        accounts: &["14CCvQzQzHCVgZM3j9soPnXuJXh1RmCfwLVUcdfbZVBS", "GpX913B4PeKzzukWw4zyqz76smpExLysTTDR4rYUiijM", "11111111111111111111111111111111", "Stake11111111111111111111111111111111111111", "SysvarRent111111111111111111111111111111111"],
        blockhash: "2NuqEwZcMwFQyQaKGaLiFSFBpJaW1er26cni1sBDAeKw",
        instructions: &[
            (2, &[0, 1, 0], "0300000000d1699dcb1811b50bb0055f13044463128242e37a463b52f6c97a1f6eef88ad07000000000000007374616b653a31c0c62d0000000000c80000000000000006a1d8179137542a983437bdfe2a7ab2557f535c8a78722b68a49dc000000000"),
            (3, &[1, 4, 0, 0], "09000000"),
        ],
        signature: "f34b9eb5f586a320b919ad6dcc3f51553d3d08f5a1260279973d9fa4250bc61658a38a51322c0586b0e73b7e66325a46b8f4b60828d35e7da1013e84fa12540e",
    },
    Vector {
        name: "Authorize Checked",
        header: [1, 0, 2],
        accounts: &["14CCvQzQzHCVgZM3j9soPnXuJXh1RmCfwLVUcdfbZVBS", "ATFXMD5cYiw9yHkvexgx3nf9LNSouEViB5BZBsgwunAv", "Stake11111111111111111111111111111111111111", "SysvarC1ock11111111111111111111111111111111"],
        blockhash: "5AMCR1wLcR4nVUn3w6h4cK6UYjkdKc6SXNGP9Hj8vNUc",
        instructions: &[
            (2, &[1, 3, 0, 0], "0a00000000000000"),
            (2, &[1, 3, 0, 0], "0a00000001000000"),
        ],
        signature: "fc71a9bb988196ed145373531e9b2bcd590177a398a102779290d665c8cbd5dbc5e8c9144ff1165d98f241ebc0747c0715b1e43056fabf85f15fc594d5460c0b",
    },
    Vector {
        name: "Authorize Checked with Seed",
        header: [1, 0, 2],
        accounts: &["14CCvQzQzHCVgZM3j9soPnXuJXh1RmCfwLVUcdfbZVBS", "ATFXMD5cYiw9yHkvexgx3nf9LNSouEViB5BZBsgwunAv", "Stake11111111111111111111111111111111111111", "SysvarC1ock11111111111111111111111111111111"],
        blockhash: "5AMCR1wLcR4nVUn3w6h4cK6UYjkdKc6SXNGP9Hj8vNUc",
        instructions: &[
            (2, &[1, 0, 3, 0], "0b000000000000000b00000000000000617574686f726974793a3100d1699dcb1811b50bb0055f13044463128242e37a463b52f6c97a1f6eef88ad"),
        ],
        signature: "01e7a9a28036b36b8dbe8a68823c03330558dd8c0627fd5f25d2fa1556b43e47e23885cb71790ad444ab8e603dedbe759faa7312d5ff8921025307c42d8a3100",
    },
    Vector {
        name: "Set Lockup Checked",
        header: [1, 0, 1],
        accounts: &["14CCvQzQzHCVgZM3j9soPnXuJXh1RmCfwLVUcdfbZVBS", "ATFXMD5cYiw9yHkvexgx3nf9LNSouEViB5BZBsgwunAv", "Stake11111111111111111111111111111111111111"],
        blockhash: "2UZYH9e662w7SoLiwnGyGZY1Mn5YjEkWEozZGm5ViR6Q",
        instructions: &[
            (2, &[1, 0, 0], "0c0000000152babd1c00000000011400000000000000"),
        ],
        signature: "42b06682b7cc946143dece29c7014e408d37768d8dcd28c5293c0b13c35000cbf771886dfd4a2f1cad487621b46167d4b32ecc51c605bef0f450da6761952e05",
    },
    Vector {
        name: "Set Lockup Checked - clear lockup with zero values",
        header: [1, 0, 1],
        accounts: &["14CCvQzQzHCVgZM3j9soPnXuJXh1RmCfwLVUcdfbZVBS", "ATFXMD5cYiw9yHkvexgx3nf9LNSouEViB5BZBsgwunAv", "Stake11111111111111111111111111111111111111"],
        blockhash: "2UZYH9e662w7SoLiwnGyGZY1Mn5YjEkWEozZGm5ViR6Q",
        instructions: &[
            (2, &[1, 0], "0c000000010000000000000000010000000000000000"),
        ],
        signature: "f243707a5c71ad44c9dd13530403a1ed5d9936dafe0b95c6e368dbd2023feebd47447a510c0453afe4eb35ee5dcebe62454730b11b63d2f8b1500a2fec717202",
    },
    Vector {
        name: "Create Stake Account",
        header: [2, 0, 3],
        accounts: &["14CCvQzQzHCVgZM3j9soPnXuJXh1RmCfwLVUcdfbZVBS", "ATFXMD5cYiw9yHkvexgx3nf9LNSouEViB5BZBsgwunAv", "11111111111111111111111111111111", "Stake11111111111111111111111111111111111111", "SysvarRent111111111111111111111111111111111"],
        blockhash: "2p4rYZAaFfV5Uk5ugdG5KPNty9Uda9B3b4gWB8qnNqak",
        instructions: &[
            (2, &[0, 1], "00000000002d310100000000e80300000000000006a1d8179137542a983437bdfe2a7ab2557f535c8a78722b68a49dc000000000"),
            (3, &[1, 4], "0000000000d1699dcb1811b50bb0055f13044463128242e37a463b52f6c97a1f6eef88ad00d1699dcb1811b50bb0055f13044463128242e37a463b52f6c97a1f6eef88ad000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"),
        ],
        signature: "e99a383ce8f9fcd0ebbb03fce2c47db188734bd36613d226110dfa9d95ba28ad55c4e3ff36d1c4936538350d96d7aeff024c3e6afbb5c45dfe921a18e981ea0c",
    },
    Vector {
        name: "Stake instructions",
        header: [1, 0, 2],
        accounts: &["14CCvQzQzHCVgZM3j9soPnXuJXh1RmCfwLVUcdfbZVBS", "ATFXMD5cYiw9yHkvexgx3nf9LNSouEViB5BZBsgwunAv", "ETxHeBBcuw9Yu4dGuP3oXrD12V5RECvmi8ogQ9PkjyVF", "Stake11111111111111111111111111111111111111", "SysvarC1ock11111111111111111111111111111111", "ComputeBudget111111111111111111111111111111", "11111111111111111111111111111111", "SysvarRent111111111111111111111111111111111", "SysvarStakeHistory1111111111111111111111111", "StakeConfig11111111111111111111111111111111"],
        blockhash: "2p4rYZAaFfV5Uk5ugdG5KPNty9Uda9B3b4gWB8qnNqak",
        instructions: &[
            (5, &[], "03401f000000000000"),
            (6, &[0, 1], "0300000000d1699dcb1811b50bb0055f13044463128242e37a463b52f6c97a1f6eef88ad0600000000000000736565643a31002d310100000000000000000000000006a1d8179137542a983437bdfe2a7ab2557f535c8a78722b68a49dc000000000"),
            (3, &[1, 7], "0000000000d1699dcb1811b50bb0055f13044463128242e37a463b52f6c97a1f6eef88ad00d1699dcb1811b50bb0055f13044463128242e37a463b52f6c97a1f6eef88ad000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"),
            (3, &[1, 2, 4, 8, 9, 0], "02000000"),
        ],
        signature: "a04d014846ded6ae99271f082492550dcb65bd8876634fe6713c49ce19b1f09e32e0866a3efd1decfc0e6b0935a7c95476b2b646e47f529e3e7a76909d17bb09",
    },
    Vector {
        name: "Stake instructions on Everstake",
        header: [1, 0, 2],
        accounts: &["14CCvQzQzHCVgZM3j9soPnXuJXh1RmCfwLVUcdfbZVBS", "ATFXMD5cYiw9yHkvexgx3nf9LNSouEViB5BZBsgwunAv", "9QU2QSxhb24FUX3Tu2FpczXjpK3VYrvRudywSZaM29mF", "Stake11111111111111111111111111111111111111", "SysvarC1ock11111111111111111111111111111111", "ComputeBudget111111111111111111111111111111", "11111111111111111111111111111111", "SysvarRent111111111111111111111111111111111", "SysvarStakeHistory1111111111111111111111111", "StakeConfig11111111111111111111111111111111"],
        blockhash: "2p4rYZAaFfV5Uk5ugdG5KPNty9Uda9B3b4gWB8qnNqak",
        instructions: &[
            (5, &[], "03401f000000000000"),
            (6, &[0, 1], "0300000000d1699dcb1811b50bb0055f13044463128242e37a463b52f6c97a1f6eef88ad0600000000000000736565643a31002d310100000000000000000000000006a1d8179137542a983437bdfe2a7ab2557f535c8a78722b68a49dc000000000"),
            (3, &[1, 7], "0000000000d1699dcb1811b50bb0055f13044463128242e37a463b52f6c97a1f6eef88ad00d1699dcb1811b50bb0055f13044463128242e37a463b52f6c97a1f6eef88ad000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"),
            (3, &[1, 2, 4, 8, 9, 0], "02000000"),
        ],
        signature: "31beb28077266f9c58aef5d081c20740629b5b3f92100cef807b50d80e2983275a0f50c691fcb9a7a7015ff95497376e10da1577e2acfb6458e9a4bd260d2c0b",
    },
    Vector {
        name: "Stake instructions with warning",
        header: [1, 0, 2],
        accounts: &["14CCvQzQzHCVgZM3j9soPnXuJXh1RmCfwLVUcdfbZVBS", "ATFXMD5cYiw9yHkvexgx3nf9LNSouEViB5BZBsgwunAv", "ETxHeBBcuw9Yu4dGuP3oXrD12V5RECvmi8ogQ9PkjyVF", "Stake11111111111111111111111111111111111111", "SysvarC1ock11111111111111111111111111111111", "ComputeBudget111111111111111111111111111111", "11111111111111111111111111111111", "SysvarRent111111111111111111111111111111111", "SysvarStakeHistory1111111111111111111111111", "StakeConfig11111111111111111111111111111111"],
        blockhash: "2p4rYZAaFfV5Uk5ugdG5KPNty9Uda9B3b4gWB8qnNqak",
        instructions: &[
            (5, &[], "03401f000000000000"),
            (6, &[0, 1], "0300000000d1699dcb1811b50bb0055f13044463128242e37a463b52f6c97a1f6eef88ad0600000000000000736565643a31002d310100000000000000000000000006a1d8179137542a983437bdfe2a7ab2557f535c8a78722b68a49dc000000000"),
            (3, &[1, 7], "0000000000d1699dcb1811b50bb0055f13044463128242e37a463b52f6c97a1f6eef88ad8f41927b2e58cbc31ed3aa5163a7b8ca4eb5590e8dc1dc682426cd2895aa9c0a000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"),
            (3, &[1, 2, 4, 8, 9, 0], "02000000"),
        ],
        signature: "4e40dec9765719cd36ba8e882e6a41399f424e48e3a4697f36ef4aec94bad16c7ab961ac75f7ee6de3b7d76f30aa0e694a8a94878226431a1ffc79f1c204e701",
    },
    Vector {
        name: "Unstake instructions",
        header: [1, 0, 2],
        accounts: &["14CCvQzQzHCVgZM3j9soPnXuJXh1RmCfwLVUcdfbZVBS", "ATFXMD5cYiw9yHkvexgx3nf9LNSouEViB5BZBsgwunAv", "Stake11111111111111111111111111111111111111", "SysvarC1ock11111111111111111111111111111111", "ComputeBudget111111111111111111111111111111"],
        blockhash: "2p4rYZAaFfV5Uk5ugdG5KPNty9Uda9B3b4gWB8qnNqak",
        instructions: &[
            (4, &[], "03401f000000000000"),
            (2, &[1, 3, 0], "05000000"),
        ],
        signature: "c0a704d4702248f2f9c9c5a6e5f17523ac7bf12546d1a1447a5af22b56fe1a62901fd0074f5d7560cfecea635aa7d3594c9c5fb124bf47ab376fae487bdedd0e",
    },
    Vector {
        name: "Multiple unstake instructions",
        header: [1, 0, 2],
        accounts: &["14CCvQzQzHCVgZM3j9soPnXuJXh1RmCfwLVUcdfbZVBS", "ATFXMD5cYiw9yHkvexgx3nf9LNSouEViB5BZBsgwunAv", "Stake11111111111111111111111111111111111111", "SysvarC1ock11111111111111111111111111111111", "ComputeBudget111111111111111111111111111111", "AeDJ1BqA7ruBbd6mEcS1QNxFbT8FQbiBVuN9NqK94Taq"],
        blockhash: "2p4rYZAaFfV5Uk5ugdG5KPNty9Uda9B3b4gWB8qnNqak",
        instructions: &[
            (4, &[], "03401f000000000000"),
            (2, &[1, 3, 0], "05000000"),
            (2, &[5, 3, 0], "05000000"),
        ],
        signature: "b60391297924981ff312647ac63902b39fb22f76fd134c6ba57ffdd36966706c6ce5675d4ee82a1cdc567d15b0b4b4f6cdd6f98e4c0ab390013ff98d5fb39200",
    },
    Vector {
        name: "Claim instructions",
        header: [1, 0, 3],
        accounts: &["14CCvQzQzHCVgZM3j9soPnXuJXh1RmCfwLVUcdfbZVBS", "ATFXMD5cYiw9yHkvexgx3nf9LNSouEViB5BZBsgwunAv", "Stake11111111111111111111111111111111111111", "SysvarC1ock11111111111111111111111111111111", "ComputeBudget111111111111111111111111111111"],
        blockhash: "2p4rYZAaFfV5Uk5ugdG5KPNty9Uda9B3b4gWB8qnNqak",
        instructions: &[
            (4, &[], "03401f000000000000"),
            (2, &[1, 0, 3, 4, 0, 0], "0400000040420f0000000000"),
        ],
        signature: "4edf71d1b4d075c6717617ef43cd896a80153f418dbe4cca5e66ee9f27bd5652bec67d30ee9a14e3bd7062dd72ed619cf238e6f5538b150dae34d24bee650303",
    },
    Vector {
        name: "Multiple claim instructions",
        header: [1, 0, 3],
        accounts: &["14CCvQzQzHCVgZM3j9soPnXuJXh1RmCfwLVUcdfbZVBS", "ATFXMD5cYiw9yHkvexgx3nf9LNSouEViB5BZBsgwunAv", "Stake11111111111111111111111111111111111111", "SysvarC1ock11111111111111111111111111111111", "ComputeBudget111111111111111111111111111111", "AeDJ1BqA7ruBbd6mEcS1QNxFbT8FQbiBVuN9NqK94Taq"],
        blockhash: "2p4rYZAaFfV5Uk5ugdG5KPNty9Uda9B3b4gWB8qnNqak",
        instructions: &[
            (4, &[], "03401f000000000000"),
            (2, &[1, 0, 3, 4, 0, 0], "0400000040420f0000000000"),
            (2, &[5, 0, 3, 4, 0, 0], "0400000040420f0000000000"),
        ],
        signature: "87a376794de2e69b6bd46b2f48081aa915d97139706a1fa9aef9d5efd95615bb1f71c8bc64155b2d602cb259a2ac5d3a91a0cc6d95afc0d573bcf17f2bbc2e09",
    },
    Vector {
        name: "Claim instructions with warning",
        header: [1, 0, 3],
        accounts: &["14CCvQzQzHCVgZM3j9soPnXuJXh1RmCfwLVUcdfbZVBS", "ATFXMD5cYiw9yHkvexgx3nf9LNSouEViB5BZBsgwunAv", "Stake11111111111111111111111111111111111111", "SysvarC1ock11111111111111111111111111111111", "ComputeBudget111111111111111111111111111111", "AeDJ1BqA7ruBbd6mEcS1QNxFbT8FQbiBVuN9NqK94Taq"],
        blockhash: "2p4rYZAaFfV5Uk5ugdG5KPNty9Uda9B3b4gWB8qnNqak",
        instructions: &[
            (4, &[], "03401f000000000000"),
            (2, &[1, 5, 3, 4, 0, 0], "0400000040420f0000000000"),
        ],
        signature: "53e953033988f8ce3cca4f7d1f94da41d8f3d1467724785f5cd9c4d16250198429a5d27bc474a66d4c1bf4a936c680f51973d54a3b16a2b73e62ecbb1f062104",
    },
];

/// Trezor's expected signatures: our serialization of each fixture is byte for byte the message
/// Trezor signed (Ed25519 is deterministic).
#[test]
fn trezor_stake_fixtures_serialize_identically() {
    let s = seed();
    assert_eq!(wallet_core::sol_address(&s, 0).unwrap(), ME);
    for v in TREZOR {
        let m = message(v);
        let sig = sol_sign_message(&s, 0, &m).unwrap();
        assert_eq!(hex::encode(sig), v.signature, "{}", v.name);
    }
}

/// What Kyro's decoder does with each fixture: only Initialize (zero lockup, us as both
/// authorities), DelegateStake, Deactivate and Withdraw (to us) pass; authority changes,
/// lockups, split, merge, checked variants, a foreign withdrawer or recipient, and stake accounts
/// of the wrong size are refused.
#[test]
fn trezor_stake_fixtures_accepted_or_refused() {
    let accepted = [
        "Delegate",
        "Withdraw",
        "Deactivate",
        "Unstake instructions",
        "Multiple unstake instructions",
    ];
    for v in TREZOR {
        let r = sol_decode_message(&message(v), &[], ME);
        if accepted.contains(&v.name) {
            let s = r.unwrap_or_else(|e| panic!("{}: {e}", v.name));
            assert!(
                !s.requires_extra_confirmation,
                "{}: {:?}",
                v.name, s.warnings
            );
            assert_eq!(s.our_signer_index, Some(0));
        } else {
            let e = r.expect_err(v.name).to_string();
            assert!(
                e.contains("Solana staking") || e.contains("not derived"),
                "{}: {e}",
                v.name
            );
        }
    }
    let by_name = |n: &str| TREZOR.iter().find(|v| v.name == n).unwrap();
    let s = sol_decode_message(&message(by_name("Delegate")), &[], ME).unwrap();
    assert_eq!(
        s.instructions,
        vec![SolInstruction::StakeDelegate {
            stake_account: ME.into(),
            vote_account: VOTE.into(),
            authority: ME.into()
        }]
    );
    let s = sol_decode_message(&message(by_name("Withdraw")), &[], ME).unwrap();
    assert!(matches!(
        &s.instructions[0],
        SolInstruction::StakeWithdraw { to, lamports, authority, .. }
            if to == ME && lamports == "1000000" && authority == ME
    ));
    for (n, needle) in [
        ("Authorize", "Authorize"),
        ("Set Lockup - with epoch only", "SetLockup"),
        ("Merge", "Merge"),
        ("Split", "Split"),
        ("Initialize Stake Account", "lockup"),
        ("Stake instructions with warning", "authorities"),
        ("Create Stake Account", "1000 bytes"),
        ("Claim instructions", "StakeHistory"),
        ("Multiple claim instructions", "StakeHistory"),
        ("Claim instructions with warning", "StakeHistory"),
    ] {
        let e = sol_decode_message(&message(by_name(n)), &[], ME)
            .unwrap_err()
            .to_string();
        assert!(e.contains(needle), "{n}: {e}");
    }
    assert!(sol_decode_message(&message(by_name("Deactivate")), &[], OTHER).is_err());
}

#[test]
fn builder_messages_decode_to_exactly_the_operation() {
    let stake = sol_create_with_seed(ME, "kyro-stake-0", SOL_STAKE_PROGRAM).unwrap();
    let m = sol_stake_message(
        ME,
        &SolStakeOp::CreateAndDelegate {
            seed: "kyro-stake-0".into(),
            lamports: 1_002_282_880,
            vote_account: VOTE.into(),
        },
        BLOCKHASH,
    )
    .unwrap();
    let s = sol_decode_message(&m, &[], ME).unwrap();
    assert_eq!(
        s.instructions,
        vec![
            SolInstruction::SystemCreateAccountWithSeed {
                from: ME.into(),
                new_account: stake.clone(),
                base: ME.into(),
                seed: "kyro-stake-0".into(),
                lamports: "1002282880".into(),
                space: "200".into(),
                owner: SOL_STAKE_PROGRAM.into(),
            },
            SolInstruction::StakeInitialize {
                stake_account: stake.clone(),
                staker: ME.into(),
                withdrawer: ME.into()
            },
            SolInstruction::StakeDelegate {
                stake_account: stake.clone(),
                vote_account: VOTE.into(),
                authority: ME.into()
            },
        ]
    );
    assert!(s.warnings.is_empty() && !s.requires_extra_confirmation);
    assert_eq!(s.signers, vec![ME.to_string()]);
    assert_eq!(s.base_fee_lamports, "5000");

    for (op, want) in [
        (
            SolStakeOp::Deactivate {
                stake_account: stake.clone(),
            },
            SolInstruction::StakeDeactivate {
                stake_account: stake.clone(),
                authority: ME.into(),
            },
        ),
        (
            SolStakeOp::Withdraw {
                stake_account: stake.clone(),
                lamports: 42,
            },
            SolInstruction::StakeWithdraw {
                stake_account: stake.clone(),
                to: ME.into(),
                lamports: "42".into(),
                authority: ME.into(),
            },
        ),
        (
            SolStakeOp::Delegate {
                stake_account: stake.clone(),
                vote_account: VOTE.into(),
            },
            SolInstruction::StakeDelegate {
                stake_account: stake.clone(),
                vote_account: VOTE.into(),
                authority: ME.into(),
            },
        ),
    ] {
        let m = sol_stake_message(ME, &op, BLOCKHASH).unwrap();
        let s = sol_decode_message(&m, &[], ME).unwrap();
        assert_eq!(s.instructions, vec![want]);
        assert!(!s.requires_extra_confirmation);
    }
    for bad_seed in ["", "this seed is definitely longer than 32", "é"] {
        assert!(sol_stake_message(
            ME,
            &SolStakeOp::CreateAndDelegate {
                seed: bad_seed.into(),
                lamports: 1,
                vote_account: VOTE.into()
            },
            BLOCKHASH
        )
        .is_err());
    }
    assert!(sol_stake_message(
        ME,
        &SolStakeOp::Withdraw {
            stake_account: stake,
            lamports: 0
        },
        BLOCKHASH
    )
    .is_err());
}

fn raw_message(keys: &[[u8; 32]], readonly: u8, ixs: &[(u8, Vec<u8>, Vec<u8>)]) -> Vec<u8> {
    let mut m = vec![1, 0, readonly];
    sv(keys.len(), &mut m);
    for k in keys {
        m.extend_from_slice(k);
    }
    m.extend_from_slice(&key(BLOCKHASH));
    sv(ixs.len(), &mut m);
    for (p, accs, data) in ixs {
        m.push(*p);
        sv(accs.len(), &mut m);
        m.extend_from_slice(accs);
        sv(data.len(), &mut m);
        m.extend_from_slice(data);
    }
    m
}

#[test]
fn tampered_stake_messages_are_refused() {
    let seed_s = "kyro-stake-7";
    let m = sol_stake_message(
        ME,
        &SolStakeOp::CreateAndDelegate {
            seed: seed_s.into(),
            lamports: 1_002_282_880,
            vote_account: VOTE.into(),
        },
        BLOCKHASH,
    )
    .unwrap();
    let pos = m
        .windows(seed_s.len())
        .position(|w| w == seed_s.as_bytes())
        .unwrap();
    let mut t = m.clone();
    t[pos + seed_s.len() - 1] = b'8';
    let e = sol_decode_message(&t, &[], ME).unwrap_err().to_string();
    assert!(e.contains("derived"), "{e}");
    assert!(sol_decode_message(&m, &[], OTHER).is_err());

    let stake = key(&sol_create_with_seed(ME, seed_s, SOL_STAKE_PROGRAM).unwrap());
    let mut create = 3u32.to_le_bytes().to_vec();
    create.extend_from_slice(&key(ME));
    create.extend_from_slice(&(seed_s.len() as u64).to_le_bytes());
    create.extend_from_slice(seed_s.as_bytes());
    create.extend_from_slice(&1_002_282_880u64.to_le_bytes());
    create.extend_from_slice(&200u64.to_le_bytes());
    create.extend_from_slice(&key(SOL_STAKE_PROGRAM));
    let only_create = raw_message(
        &[key(ME), stake, key("11111111111111111111111111111111")],
        1,
        &[(2, vec![0, 1], create)],
    );
    let e = sol_decode_message(&only_create, &[], ME)
        .unwrap_err()
        .to_string();
    assert!(e.contains("without being initialized"), "{e}");

    let other = key(OTHER);
    let delegate_other = raw_message(
        &[
            key(ME),
            stake,
            other,
            key(VOTE),
            key("SysvarC1ock11111111111111111111111111111111"),
            key("SysvarStakeHistory1111111111111111111111111"),
            key("StakeConfig11111111111111111111111111111111"),
            key(SOL_STAKE_PROGRAM),
        ],
        6,
        &[(7, vec![1, 3, 4, 5, 6, 2], 2u32.to_le_bytes().to_vec())],
    );
    let e = sol_decode_message(&delegate_other, &[], ME)
        .unwrap_err()
        .to_string();
    assert!(e.contains("stake authority"), "{e}");

    let mut wd = 4u32.to_le_bytes().to_vec();
    wd.extend_from_slice(&1_000u64.to_le_bytes());
    let to_other = raw_message(
        &[
            key(ME),
            stake,
            other,
            key("SysvarC1ock11111111111111111111111111111111"),
            key("SysvarStakeHistory1111111111111111111111111"),
            key(SOL_STAKE_PROGRAM),
        ],
        3,
        &[(5, vec![1, 2, 3, 4, 0], wd)],
    );
    let e = sol_decode_message(&to_other, &[], ME)
        .unwrap_err()
        .to_string();
    assert!(e.contains("withdrawal recipient"), "{e}");

    let d = sol_stake_message(
        ME,
        &SolStakeOp::Deactivate {
            stake_account: bitcoin::base58::encode(&stake),
        },
        BLOCKHASH,
    )
    .unwrap();
    let clock = key("SysvarC1ock11111111111111111111111111111111");
    let rent = key("SysvarRent111111111111111111111111111111111");
    let at = d.windows(32).position(|w| w == clock).unwrap();
    let mut t = d.clone();
    t[at..at + 32].copy_from_slice(&rent);
    let e = sol_decode_message(&t, &[], ME).unwrap_err().to_string();
    assert!(e.contains("Clock"), "{e}");
    let mut t = d.clone();
    let n = t.len();
    t[n - 4..].copy_from_slice(&17u32.to_le_bytes());
    let e = sol_decode_message(&t, &[], ME).unwrap_err().to_string();
    assert!(e.contains("MoveLamports"), "{e}");
}

/// Real devnet stake account of the public "abandon … about" wallet.
const DEVNET_STAKE: &str = "AgAAAIDVIgAAAAAA8DYnYkanW53jNJ7UKxXiMvZRj8IPX81PHWToH5vSWPfwNidiRqdbneM0ntQrFeIy9lGPwg9fzU8dZOgfm9JY9wAAAAAAAAAAAAAAAAAAAADwNidiRqdbneM0ntQrFeIy9lGPwg9fzU8dZOgfm9JY9930KgSAClTeLlg/lPF7CJclt3LRMzUmJxJBUyd20v/GS6MfLgEAAACRBAAAAAAAAP//////////AAAAAAAAAACBbeYxMAMAAAAAAAA=";

#[test]
fn real_devnet_stake_account() {
    let data = base64::engine::general_purpose::STANDARD
        .decode(DEVNET_STAKE)
        .unwrap();
    let a = sol_parse_stake_account(&data).unwrap();
    assert_eq!(a.state, "delegated");
    assert_eq!(a.rent_exempt_reserve, 2_282_880);
    assert_eq!(a.staker, "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk");
    assert_eq!(a.withdrawer, a.staker);
    assert_eq!((a.lockup_unix_timestamp, a.lockup_epoch), (0, 0));
    assert_eq!(a.lockup_custodian, a.staker);
    let d = a.delegation.as_ref().unwrap();
    assert_eq!(
        d.vote_account,
        "FwR3PbjS5iyqzLiLugrBqKSa5EKZ4vK9SKs7eQXtT59f"
    );
    assert_eq!(d.stake, 5_068_792_651);
    assert_eq!(d.activation_epoch, 1169);
    assert_eq!(d.deactivation_epoch, u64::MAX);
    assert_eq!(
        sol_stake_activation(d, 1196, &[]),
        SolStakeActivation {
            effective: 5_068_792_651,
            activating: 0,
            deactivating: 0
        }
    );
    let (partial, close) = sol_stake_withdrawable(&a, 5_070_458_891, 1196, &[]);
    assert_eq!((partial, close), (0, false));
    assert_eq!(
        sol_stake_withdrawable(&a, 5_071_075_531 + 7, 1196, &[]),
        (7, false)
    );
    assert!(sol_parse_stake_account(&data[..199]).is_err());
}

fn h(epoch: u64, effective: u64, activating: u64, deactivating: u64) -> SolStakeHistoryEntry {
    SolStakeHistoryEntry {
        epoch,
        effective,
        activating,
        deactivating,
    }
}

#[test]
fn warmup_and_cooldown() {
    let d = |act, deact| SolDelegation {
        vote_account: VOTE.into(),
        stake: 1_000,
        activation_epoch: act,
        deactivation_epoch: deact,
    };
    let x = d(10, 10);
    assert_eq!(
        sol_stake_activation(&x, 10, &[]),
        SolStakeActivation::default()
    );
    let acc = wallet_core::SolStakeAccount {
        state: "delegated".into(),
        rent_exempt_reserve: 2_000,
        staker: ME.into(),
        withdrawer: ME.into(),
        lockup_unix_timestamp: 0,
        lockup_epoch: 0,
        lockup_custodian: "11111111111111111111111111111111".into(),
        delegation: Some(x),
    };
    assert_eq!(sol_stake_withdrawable(&acc, 3_000, 10, &[]), (1_000, true));
    assert_eq!(
        sol_stake_activation(&d(10, u64::MAX), 10, &[]).activating,
        1_000
    );
    let hist = [h(10, 1_000_000, 1_000, 0)];
    assert_eq!(
        sol_stake_activation(&d(10, u64::MAX), 11, &hist),
        SolStakeActivation {
            effective: 1_000,
            activating: 0,
            deactivating: 0
        }
    );
    let hist = [h(10, 10_000, 2_000, 0)];
    assert_eq!(
        sol_stake_activation(&d(10, u64::MAX), 11, &hist),
        SolStakeActivation {
            effective: 450,
            activating: 550,
            deactivating: 0
        }
    );
    let x = d(1, 20);
    assert_eq!(sol_stake_activation(&x, 20, &[]).deactivating, 1_000);
    let hist = [h(20, 1_000_000, 0, 1_000)];
    assert_eq!(
        sol_stake_activation(&x, 21, &hist),
        SolStakeActivation::default()
    );
    let mut acc = acc;
    acc.delegation = Some(x);
    assert_eq!(sol_stake_withdrawable(&acc, 3_000, 20, &[]), (0, false));
    assert_eq!(
        sol_stake_withdrawable(&acc, 3_000, 21, &hist),
        (1_000, true)
    );
}

#[test]
fn stake_history_sysvar_layout() {
    let mut data = 2u64.to_le_bytes().to_vec();
    for (e, a, b, c) in [(5u64, 10u64, 2u64, 1u64), (4, 9, 0, 0)] {
        for x in [e, a, b, c] {
            data.extend_from_slice(&x.to_le_bytes());
        }
    }
    assert_eq!(
        sol_parse_stake_history(&data).unwrap(),
        vec![h(5, 10, 2, 1), h(4, 9, 0, 0)]
    );
    assert!(sol_parse_stake_history(&data[..60]).is_err());
}

#[test]
fn activation_with_extreme_epochs_does_not_wrap() {
    let d = |act, deact| SolDelegation {
        vote_account: VOTE.into(),
        stake: u64::MAX,
        activation_epoch: act,
        deactivation_epoch: deact,
    };
    let m = u64::MAX;
    let hist = [h(m - 2, u64::MAX, 1, 0), h(m - 1, u64::MAX, 1, u64::MAX)];
    let a = sol_stake_activation(&d(m - 2, m), m - 1, &hist);
    assert_eq!(a.effective.checked_add(a.activating), Some(u64::MAX));
    let a = sol_stake_activation(&d(0, m - 1), m, &hist);
    assert_eq!(a.activating, 0);
}
