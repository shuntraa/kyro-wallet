//! Multiple accounts per chain.

mod common;

use common::{seed, ABANDON};
use wallet_core::{
    btc_account, btc_address, cardano_account_path, cardano_account_stake_address, cardano_address,
    evm_address, evm_path, sol_address, sol_path, stellar_address, stellar_path, tron_address,
    tron_path, utxo_account, utxo_address, xrp_address, xrp_path, BtcKind, CardanoRoot, Mnemonic,
    Network, UtxoCoin,
};

fn btc(net: Network, kind: BtcKind, account: u32) -> (String, String, String) {
    let s = seed(ABANDON);
    let a = btc_account(&s, net, kind, account).unwrap();
    (
        a.path,
        a.xpub,
        btc_address(&s, net, kind, account, false, 0).unwrap(),
    )
}

fn utxo(net: Network, coin: UtxoCoin, account: u32) -> (String, String) {
    let s = seed(ABANDON);
    (
        utxo_account(&s, net, coin, account).unwrap().path,
        utxo_address(&s, net, coin, account, false, 0).unwrap(),
    )
}

fn ada_root() -> CardanoRoot {
    CardanoRoot::from_mnemonic(&Mnemonic::parse(ABANDON).unwrap(), "")
}

#[test]
fn account_0_is_unchanged_bitcoin() {
    assert_eq!(
        btc(Network::Mainnet, BtcKind::Segwit, 0),
        (
            "m/84'/0'/0'".into(),
            "xpub6CatWdiZiodmUeTDp8LT5or8nmbKNcuyvz7WyksVFkKB4RHwCD3XyuvPEbvqAQY3rAPshWcMLoP2fMFMKHPJ4ZeZXYVUhLv1VMrjPC7PW6V".into(),
            "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu".into()
        )
    );
    assert_eq!(
        btc(Network::Mainnet, BtcKind::Taproot, 0),
        (
            "m/86'/0'/0'".into(),
            "xpub6BgBgsespWvERF3LHQu6CnqdvfEvtMcQjYrcRzx53QJjSxarj2afYWcLteoGVky7D3UKDP9QyrLprQ3VCECoY49yfdDEHGCtMMj92pReUsQ".into(),
            "bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr".into()
        )
    );
    assert_eq!(
        btc(Network::Testnet, BtcKind::Segwit, 0),
        (
            "m/84'/1'/0'".into(),
            "tpubDC8msFGeGuwnKG9Upg7DM2b4DaRqg3CUZa5g8v2SRQ6K4NSkxUgd7HsL2XVWbVm39yBA4LAxysQAm397zwQSQoQgewGiYZqrA9DsP4zbQ1M".into(),
            "tb1q6rz28mcfaxtmd6v789l9rrlrusdprr9pqcpvkl".into()
        )
    );
    assert_eq!(
        btc(Network::Testnet, BtcKind::Taproot, 0),
        (
            "m/86'/1'/0'".into(),
            "tpubDDfvzhdVV4unsoKt5aE6dcsNsfeWbTgmLZPi8LQDYU2xixrYemMfWJ3BaVneH3u7DBQePdTwhpybaKRU95pi6PMUtLPBJLVQRpzEnjfjZzX".into(),
            "tb1p8wpt9v4frpf3tkn0srd97pksgsxc5hs52lafxwru9kgeephvs7rqlqt9zj".into()
        )
    );
}

#[test]
fn account_0_is_unchanged_litecoin_dogecoin() {
    let p = |a: &str, b: &str| (a.to_string(), b.to_string());
    assert_eq!(
        utxo(Network::Mainnet, UtxoCoin::Litecoin, 0),
        p("m/84'/2'/0'", "ltc1qjmxnz78nmc8nq77wuxh25n2es7rzm5c2rkk4wh")
    );
    assert_eq!(
        utxo(Network::Testnet, UtxoCoin::Litecoin, 0),
        p(
            "m/84'/1'/0'",
            "tltc1q6rz28mcfaxtmd6v789l9rrlrusdprr9pesrjxk"
        )
    );
    assert_eq!(
        utxo(Network::Mainnet, UtxoCoin::Dogecoin, 0),
        p("m/44'/3'/0'", "DBus3bamQjgJULBJtYXpEzDWQRwF5iwxgC")
    );
    assert_eq!(
        utxo(Network::Testnet, UtxoCoin::Dogecoin, 0),
        p("m/44'/1'/0'", "nZVmfmUtKPmskB9Ds4P9GUJy9eYFqPKHqH")
    );
}

#[test]
fn account_0_is_unchanged_single_address_chains() {
    let s = seed(ABANDON);
    assert_eq!(evm_path(0), "m/44'/60'/0'/0/0");
    assert_eq!(
        evm_address(&s, 0).unwrap(),
        "0x9858EfFD232B4033E47d90003D41EC34EcaEda94"
    );
    assert_eq!(sol_path(0), "m/44'/501'/0'/0'");
    assert_eq!(
        sol_address(&s, 0).unwrap(),
        "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk"
    );
    assert_eq!(tron_path(0), "m/44'/195'/0'/0/0");
    assert_eq!(
        tron_address(&s, 0).unwrap(),
        "TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH"
    );
    assert_eq!(xrp_path(0), "m/44'/144'/0'/0/0");
    assert_eq!(
        xrp_address(&s, 0).unwrap(),
        "rHsMGQEkVNJmpGWs8XUBoTBiAAbwxZN5v3"
    );
    // SEP-0005 test 5, account 0 (same on testnet: Stellar keys do not depend on the network).
    assert_eq!(stellar_path(0), "m/44'/148'/0'");
    assert_eq!(
        stellar_address(&s, 0).unwrap(),
        "GB3JDWCQJCWMJ3IILWIGDTQJJC5567PGVEVXSCVPEQOTDN64VJBDQBYX"
    );
}

#[test]
fn account_0_is_unchanged_cardano() {
    let r = ada_root();
    assert_eq!(cardano_account_path(0), "m/1852'/1815'/0'");
    assert_eq!(
        cardano_address(&r, Network::Mainnet, 0, 0).unwrap(),
        "addr1qy8ac7qqy0vtulyl7wntmsxc6wex80gvcyjy33qffrhm7sh927ysx5sftuw0dlft05dz3c7revpf7jx0xnlcjz3g69mq4afdhv"
    );
    assert_eq!(
        cardano_address(&r, Network::Testnet, 0, 0).unwrap(),
        "addr_test1qq8ac7qqy0vtulyl7wntmsxc6wex80gvcyjy33qffrhm7sh927ysx5sftuw0dlft05dz3c7revpf7jx0xnlcjz3g69mqkt5dmn"
    );
    assert_eq!(
        cardano_account_stake_address(&r, Network::Testnet, 0).unwrap(),
        "stake_test1urj40zgr2gy4788kl54h6x3gu0pukq5lfr8nflufpg5dzas324ywz"
    );
}

#[test]
fn account_1_bitcoin_litecoin_dogecoin() {
    assert_eq!(
        btc(Network::Mainnet, BtcKind::Segwit, 1),
        (
            "m/84'/0'/1'".into(),
            "xpub6CatWdiZiodmYVtWLtEQsAg1H9ooS1bmsJUBwQ83FE1Fyk386FWcyicJgEZv3quZSJKA5dh5Lo2PbubMGxCfZtRthV6ST2qquL9w3HSzcUn".into(),
            "bc1qku0qh0mc00y8tk0n65x2tqw4trlspak0fnjmfz".into()
        )
    );
    assert_eq!(
        btc(Network::Mainnet, BtcKind::Taproot, 1).2,
        "bc1pkq6ayylfpe5hn05550ry25pkakuf72x9qkjc2sl06dfcet8sg25q9y3j3y"
    );
    assert_eq!(btc(Network::Testnet, BtcKind::Segwit, 1).0, "m/84'/1'/1'");
    assert_eq!(
        utxo(Network::Mainnet, UtxoCoin::Litecoin, 1),
        (
            "m/84'/2'/1'".to_string(),
            "ltc1q6he42udnkdx2m5dctfyjs2z9xl76xcdshd5htt".to_string()
        )
    );
    assert_eq!(
        utxo(Network::Mainnet, UtxoCoin::Dogecoin, 1),
        (
            "m/44'/3'/1'".to_string(),
            "DEiUcV7xvCRdpQmsW3i8T9EVsb7zeiUQRt".to_string()
        )
    );
}

#[test]
fn account_1_single_address_chains() {
    let s = seed(ABANDON);
    assert_eq!(evm_path(1), "m/44'/60'/0'/0/1");
    assert_eq!(
        evm_address(&s, 1).unwrap(),
        "0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0"
    );
    assert_eq!(sol_path(1), "m/44'/501'/1'/0'");
    assert_eq!(
        sol_address(&s, 1).unwrap(),
        "Hh8QwFUA6MtVu1qAoq12ucvFHNwCcVTV7hpWjeY1Hztb"
    );
    assert_eq!(tron_path(1), "m/44'/195'/1'/0/0");
    assert_eq!(
        tron_address(&s, 1).unwrap(),
        "TLrpNTBuCpGMrB9TyVwgEhNVRhtWEQPHh4"
    );
    assert_eq!(xrp_path(1), "m/44'/144'/1'/0/0");
    let all = seed("all all all all all all all all all all all all");
    assert_eq!(
        xrp_address(&all, 1).unwrap(),
        "rJX2KwzaLJDyFhhtXKi3htaLfaUH2tptEX"
    );
    // SEP-0005 test 5, `m/44'/148'/1'`.
    assert_eq!(stellar_path(1), "m/44'/148'/1'");
    assert_eq!(
        stellar_address(&s, 1).unwrap(),
        "GDVSYYTUAJ3ACHTPQNSTQBDQ4LDHQCMNY4FCEQH5TJUMSSLWQSTG42MV"
    );
}

#[test]
fn account_1_cardano() {
    // CIP-0019: the reward address of the test vectors is m/1852'/1815'/1'/2/0.
    let r = CardanoRoot::from_mnemonic(
        &Mnemonic::parse("test walk nut penalty hip pave soap entry language right filter choice")
            .unwrap(),
        "",
    );
    assert_eq!(cardano_account_path(1), "m/1852'/1815'/1'");
    assert_eq!(
        cardano_account_stake_address(&r, Network::Testnet, 1).unwrap(),
        "stake_test1uqehkck0lajq8gr28t9uxnuvgcqrc6070x3k9r8048z8y5gssrtvn"
    );
    let a = ada_root();
    assert_ne!(
        cardano_address(&a, Network::Testnet, 1, 0).unwrap(),
        cardano_address(&a, Network::Testnet, 0, 0).unwrap()
    );
}

#[test]
fn account_index_limits() {
    let s = seed(ABANDON);
    for f in [
        tron_address(&s, 1 << 31),
        xrp_address(&s, 1 << 31),
        sol_address(&s, 1 << 31),
    ] {
        assert!(f.is_err());
    }
    assert!(btc_account(&s, Network::Testnet, BtcKind::Segwit, 1 << 31).is_err());
}
