//! Watch addresses: public values only, a private key is never stored.

use wallet_core::{Network, WatchAddress, WatchAddressStore, MAX_WATCH_ADDRESSES};

fn entry(id: u64, family: &str, value: &str) -> WatchAddress {
    WatchAddress {
        id: format!("wa-{id:016x}"),
        label: "Cold".into(),
        family: family.into(),
        value: value.into(),
    }
}

const XPUB: &str = "xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8";
const XPRV: &str = "xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi";
const WIF: &str = "KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn";

#[test]
fn accepts_public_values() {
    let net = Network::Mainnet;
    entry(1, "evm", "0x000000000000000000000000000000000000dEaD")
        .validate(net)
        .unwrap();
    entry(1, "btc", "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4")
        .validate(net)
        .unwrap();
    let x = entry(1, "btc", XPUB);
    x.validate(net).unwrap();
    assert!(x.is_xpub(net));
    assert!(!entry(1, "evm", "0x00").is_xpub(net));
}

#[test]
fn refuses_private_keys_whatever_the_network_field() {
    for family in ["btc", "ltc", "evm", "sui", "doge"] {
        assert!(entry(1, family, XPRV).validate(Network::Mainnet).is_err());
        assert!(entry(1, family, WIF).validate(Network::Mainnet).is_err());
    }
}

#[test]
fn refuses_phrases_bad_networks_and_monero() {
    let net = Network::Mainnet;
    assert!(entry(1, "btc", "abandon abandon abandon")
        .validate(net)
        .is_err());
    assert!(entry(1, "sui", "two words").validate(net).is_err());
    assert!(entry(1, "xmr", "44AFFq5kSiGBoZ").validate(net).is_err());
    assert!(entry(1, "hbar", "0.0.1234").validate(net).is_err());
    assert!(entry(1, "evm", "0x1234").validate(net).is_err());
    // A testnet address or xpub on mainnet.
    assert!(
        entry(1, "btc", "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx")
            .validate(net)
            .is_err()
    );
    assert!(entry(1, "btc", XPUB).validate(Network::Testnet).is_err());
}

#[test]
fn store_round_trip_and_limits() {
    let net = Network::Mainnet;
    let a = "0x000000000000000000000000000000000000dEaD";
    let store = WatchAddressStore {
        addresses: vec![entry(1, "evm", a), entry(2, "sui", "0xabc")],
        ..Default::default()
    };
    let parsed = WatchAddressStore::from_json(&store.to_json().unwrap(), net).unwrap();
    assert_eq!(parsed, store);

    let dup = WatchAddressStore {
        addresses: vec![entry(1, "evm", a), entry(2, "evm", a)],
        ..Default::default()
    };
    assert!(dup.validate(net).is_err());

    let same_id = WatchAddressStore {
        addresses: vec![entry(1, "evm", a), entry(1, "sui", "0xabc")],
        ..Default::default()
    };
    assert!(same_id.validate(net).is_err());

    let full = WatchAddressStore {
        addresses: (0..=MAX_WATCH_ADDRESSES as u64)
            .map(|i| entry(i, "sui", &format!("0x{i:x}")))
            .collect(),
        ..Default::default()
    };
    assert!(full.validate(net).is_err());

    assert!(WatchAddressStore::from_json("{\"version\":9,\"addresses\":[]}", net).is_err());
    assert!(WatchAddressStore::from_json("not json", net).is_err());
}

#[test]
fn a_file_holding_a_private_key_is_refused_on_load() {
    let json = format!(
        "{{\"version\":1,\"addresses\":[{{\"id\":\"wa-0000000000000001\",\"label\":\"x\",\"family\":\"btc\",\"value\":\"{XPRV}\"}}]}}"
    );
    assert!(WatchAddressStore::from_json(&json, Network::Mainnet).is_err());
}
