//! NEAR staking-pool calls: Borsh layout, strict decoding, signing.

mod common;

use common::{seed, ABANDON};
use wallet_core::{
    near_address, near_parse_hash, near_parse_public_key, near_public_key, near_stake_code_ok,
    near_stake_decode, near_stake_pool_network, near_stake_sign, near_stake_verify_signed,
    NearStakeAction, NearStakeCall, NearStakeTx, NearTransfer, NEAR_STAKE_GAS,
};

const POOL: &str = "astro-stakers.poolv1.near";
const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;

fn tx(signer: &str, pk: [u8; 32], call: NearStakeCall) -> NearStakeTx {
    NearStakeTx {
        signer_id: signer.into(),
        public_key: pk,
        nonce: 7,
        pool_id: POOL.into(),
        block_hash: near_parse_hash("244ZQ9cgj3CQ6bWBdytfrJMuMQ1jdXLFGnr4HhvtCTnM").unwrap(),
        call,
    }
}

fn vector_key() -> [u8; 32] {
    near_parse_public_key("ed25519:Anu7LYDfpLtkP7E16LT9imXF694BdQaa9ufVkQiwTQxC").unwrap()
}

/// The Borsh layout written out field by field (nearcore `TransactionV0` / `FunctionCallAction`).
fn by_hand(method: &str, args: &str, deposit: u128) -> Vec<u8> {
    let s = |o: &mut Vec<u8>, v: &[u8]| {
        o.extend_from_slice(&(v.len() as u32).to_le_bytes());
        o.extend_from_slice(v);
    };
    let mut o = Vec::new();
    s(&mut o, b"test.near");
    o.push(0);
    o.extend_from_slice(&vector_key());
    o.extend_from_slice(&7u64.to_le_bytes());
    s(&mut o, POOL.as_bytes());
    o.extend_from_slice(&near_parse_hash("244ZQ9cgj3CQ6bWBdytfrJMuMQ1jdXLFGnr4HhvtCTnM").unwrap());
    o.extend_from_slice(&1u32.to_le_bytes());
    o.push(2);
    s(&mut o, method.as_bytes());
    s(&mut o, args.as_bytes());
    o.extend_from_slice(&125_000_000_000_000u64.to_le_bytes());
    o.extend_from_slice(&deposit.to_le_bytes());
    o
}

#[test]
fn borsh_layout_matches_nearcore() {
    let k = vector_key();
    let cases = [
        (
            NearStakeCall::DepositAndStake(ONE_NEAR),
            by_hand("deposit_and_stake", "{}", ONE_NEAR),
        ),
        (
            NearStakeCall::Unstake(5 * ONE_NEAR),
            by_hand("unstake", "{\"amount\":\"5000000000000000000000000\"}", 0),
        ),
        (NearStakeCall::UnstakeAll, by_hand("unstake_all", "{}", 0)),
        (NearStakeCall::WithdrawAll, by_hand("withdraw_all", "{}", 0)),
    ];
    for (call, raw) in cases {
        let t = tx("test.near", k, call);
        assert_eq!(t.encode(), raw, "{call:?}");
        assert_eq!(NearStakeTx::decode(&raw).unwrap(), t);
    }
    assert_eq!(NEAR_STAKE_GAS, 125_000_000_000_000);
}

#[test]
fn sign_and_verify() {
    let s = seed(ABANDON);
    let me = near_address(&s, 0).unwrap();
    let pk = near_public_key(&s, 0).unwrap();
    let raw = hex::encode(tx(&me, pk, NearStakeCall::DepositAndStake(ONE_NEAR)).encode());
    let summary = near_stake_decode(&raw, &me, &pk).unwrap();
    assert_eq!(
        summary.action,
        NearStakeAction::Stake {
            amount: ONE_NEAR.to_string()
        }
    );
    assert!(!summary.testnet);
    assert_eq!(summary.attached, ONE_NEAR.to_string());
    let (signed, hash, again) = near_stake_sign(&s, 0, &raw).unwrap();
    assert_eq!(again, summary);
    let (back, h2) = near_stake_verify_signed(&signed).unwrap();
    assert_eq!(h2, hash);
    assert_eq!(back.pool_id, POOL);
    // Another account's key: refused.
    assert!(near_stake_decode(&raw, &near_address(&s, 1).unwrap(), &pk).is_err());
    assert!(near_stake_sign(&s, 1, &raw).is_err());
    // A flipped signature byte: refused.
    let mut b = hex::decode(&signed).unwrap();
    let n = b.len();
    b[n - 1] ^= 1;
    assert!(near_stake_verify_signed(&hex::encode(b)).is_err());
}

#[test]
fn pools_and_code_hashes() {
    assert_eq!(near_stake_pool_network("figment.poolv1.near"), Some(false));
    assert_eq!(near_stake_pool_network("liver.pool.near"), Some(false));
    assert_eq!(near_stake_pool_network("kiln.pool.f863973.m0"), Some(true));
    for bad in [
        "poolv1.near",
        "a.b.poolv1.near",
        "lst-pool.near",
        "usdt.tether-token.near",
        "evil.poolv1.near.attacker.near",
        "Figment.poolv1.near",
    ] {
        assert_eq!(near_stake_pool_network(bad), None, "{bad}");
    }
    // Code hashes read from mainnet / testnet on 2026-11-02 (`view_account`).
    assert!(near_stake_code_ok(
        "astro-stakers.poolv1.near",
        "J1arLz48fgXcGyCPVckFwLnewNH6j1uw79thsvwqGYTY"
    ));
    assert!(near_stake_code_ok(
        "liver.pool.near",
        "AjD4YJaXgpiRdiArqnzyDi7Bkr1gJms9Z2w7Ev5esTKB"
    ));
    assert!(near_stake_code_ok(
        "kiln.pool.f863973.m0",
        "J1arLz48fgXcGyCPVckFwLnewNH6j1uw79thsvwqGYTY"
    ));
    assert!(!near_stake_code_ok(
        "metapool01.pool.near",
        "GGfKUF9TuAFN4AzbecPonNGuRTuVqx8UPXmViogN8pRm"
    ));
    assert!(!near_stake_code_ok(
        "liver.pool.near",
        "J1arLz48fgXcGyCPVckFwLnewNH6j1uw79thsvwqGYTY"
    ));
}

#[test]
fn refusals() {
    let k = vector_key();
    let good = by_hand("withdraw_all", "{}", 0);
    let swap = |from: &[u8], to: &[u8]| {
        let h = hex::encode(&good);
        hex::decode(h.replacen(&hex::encode(from), &hex::encode(to), 1)).unwrap()
    };
    // Other pool methods, extra args, attached NEAR, other gas.
    for (m, a, d) in [
        ("withdraw", "{\"amount\":\"1\"}", 0),
        ("deposit", "{}", ONE_NEAR),
        ("stake", "{\"amount\":\"1\"}", 0),
        ("unstake_all", "{}", 1),
        ("withdraw_all", "{}", 1),
        ("unstake", "{\"amount\":\"1\",\"x\":1}", 0),
        ("unstake", "{\"amount\":\"0\"}", 0),
        ("unstake", "{ \"amount\":\"1\"}", 0),
        ("deposit_and_stake", "{}", 0),
        ("deposit_and_stake", "{\"a\":1}", ONE_NEAR),
        ("ft_transfer", "{}", 1),
    ] {
        assert!(
            NearStakeTx::decode(&by_hand(m, a, d)).is_err(),
            "{m} {a} {d}"
        );
    }
    let mut gas = good.clone();
    let at = gas.len() - 24;
    gas[at] ^= 1;
    assert!(NearStakeTx::decode(&gas).is_err());
    // Unknown receiver.
    let other = swap(POOL.as_bytes(), b"astro-stakers.poolv2.near");
    assert!(NearStakeTx::decode(&other)
        .unwrap_err()
        .to_string()
        .contains("pool"));
    // Trailing byte, two actions.
    let mut extra = good.clone();
    extra.push(0);
    assert!(NearStakeTx::decode(&extra).is_err());
    let two = swap(&[1, 0, 0, 0, 2], &[2, 0, 0, 0, 2]);
    assert!(NearStakeTx::decode(&two).is_err());
    // A Transfer to the pool is not a staking tx.
    let t = NearTransfer {
        signer_id: "test.near".into(),
        public_key: k,
        nonce: 7,
        receiver_id: POOL.into(),
        block_hash: [1; 32],
        deposit: ONE_NEAR,
        ft: None,
    };
    assert!(NearStakeTx::decode(&t.encode()).is_err());
    // And the payment path still refuses pool calls.
    assert!(NearTransfer::decode(&good).is_err());
}
