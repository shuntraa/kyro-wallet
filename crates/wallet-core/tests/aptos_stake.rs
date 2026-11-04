//! Aptos delegation pools: real mainnet transactions rebuilt, strict refusals, signing.

mod common;

use common::{seed, ABANDON};
use serde_json::Value;
use wallet_core::{
    aptos_address, aptos_decode_tx, aptos_parse_address, aptos_public_key, aptos_signing_message,
    aptos_stake_decode, aptos_stake_sign, aptos_stake_simulation_bytes, aptos_stake_verify_signed,
    aptos_tx_hash, AptosStakeCall, AptosStakeTx, AptosTransfer,
};

// `/v1/transactions/by_version/…` of api.mainnet.aptoslabs.com, read on 2026-11-04.
const REAL: &str = include_str!("data/aptos_delegation_txs.json");

fn num(v: &Value) -> u64 {
    v.as_str().unwrap().parse().unwrap()
}

fn hex32(v: &Value) -> [u8; 32] {
    hex::decode(v.as_str().unwrap().trim_start_matches("0x"))
        .unwrap()
        .try_into()
        .unwrap()
}

fn tx(sender: [u8; 32], call: AptosStakeCall) -> AptosStakeTx {
    AptosStakeTx {
        sender,
        sequence_number: 3,
        call,
        pool: [0xab; 32],
        amount: 1_100_000_000,
        max_gas_amount: 20_000,
        gas_unit_price: 100,
        expiration_timestamp_secs: 1_793_800_000,
        chain_id: 1,
    }
}

#[test]
fn real_mainnet_transactions_verify_and_hash_with_our_bytes() {
    let list: Vec<Value> = serde_json::from_str(REAL).unwrap();
    let mut seen = Vec::new();
    for v in &list {
        let call = match v["function"].as_str().unwrap() {
            "0x1::delegation_pool::add_stake" => AptosStakeCall::AddStake,
            "0x1::delegation_pool::unlock" => AptosStakeCall::Unlock,
            "0x1::delegation_pool::withdraw" => AptosStakeCall::Withdraw,
            f => panic!("{f}"),
        };
        seen.push(call);
        let t = AptosStakeTx {
            sender: hex32(&v["sender"]),
            sequence_number: num(&v["sequence_number"]),
            call,
            pool: hex32(&v["arguments"][0]),
            amount: num(&v["arguments"][1]),
            max_gas_amount: num(&v["max_gas_amount"]),
            gas_unit_price: num(&v["gas_unit_price"]),
            expiration_timestamp_secs: num(&v["expiration_timestamp_secs"]),
            chain_id: 1,
        };
        let raw = t.encode().unwrap();
        assert_eq!(AptosStakeTx::decode(&raw).unwrap(), t);
        let pk = hex32(&v["public_key"]);
        let sig: [u8; 64] = hex::decode(v["signature"].as_str().unwrap().trim_start_matches("0x"))
            .unwrap()
            .try_into()
            .unwrap();
        // The chain accepted this signature: our bytes are what the sender signed.
        ed25519_dalek::VerifyingKey::from_bytes(&pk)
            .unwrap()
            .verify_strict(
                &aptos_signing_message(&raw),
                &ed25519_dalek::Signature::from_bytes(&sig),
            )
            .unwrap();
        let signed = t.signed_bytes(&pk, &sig).unwrap();
        assert_eq!(aptos_tx_hash(&signed), v["hash"].as_str().unwrap());
        assert_eq!(
            aptos_stake_verify_signed(&hex::encode(&signed)).unwrap().1,
            t
        );
    }
    assert_eq!(
        seen,
        [
            AptosStakeCall::AddStake,
            AptosStakeCall::Withdraw,
            AptosStakeCall::Unlock
        ]
    );
}

#[test]
fn only_three_functions_of_the_framework_pass() {
    let good = tx([1; 32], AptosStakeCall::Unlock).encode().unwrap();
    assert!(AptosStakeTx::decode(&good).is_ok());
    let swap = |from: &[u8], to: &[u8]| {
        assert_eq!(from.len(), to.len());
        let i = good.windows(from.len()).position(|w| w == from).unwrap();
        let mut b = good.clone();
        b[i..i + to.len()].copy_from_slice(to);
        b
    };
    assert!(AptosStakeTx::decode(&swap(b"unlock", b"unlocj")).is_err());
    assert!(AptosStakeTx::decode(&swap(b"delegation_pool", b"delegation_poom")).is_err());
    // `reactivate_stake`, `set_operator`… are refused by name.
    let other = {
        let mut b = good[..41].to_vec();
        b.extend_from_slice(&good[41..41 + 32]);
        b.push(15);
        b.extend_from_slice(b"delegation_pool");
        b.push(16);
        b.extend_from_slice(b"reactivate_stake");
        b.extend_from_slice(&good[41 + 32 + 16 + 7..]);
        b
    };
    let e = AptosStakeTx::decode(&other).unwrap_err().to_string();
    assert!(e.contains("reactivate_stake"), "{e}");
    let mut b = good.clone();
    b.push(0);
    assert!(AptosStakeTx::decode(&b).is_err());
    // Another package: framework address byte 31.
    let mut b = good.clone();
    b[40 + 32] = 2;
    assert!(AptosStakeTx::decode(&b).is_err());
}

#[test]
fn the_payment_path_refuses_pool_calls_and_the_stake_path_refuses_payments() {
    let raw = hex::encode(tx([1; 32], AptosStakeCall::AddStake).encode().unwrap());
    let me = wallet_core::aptos_address_string(&[1; 32]);
    assert!(aptos_decode_tx(&raw, &me).is_err());
    let pay = AptosTransfer {
        sender: [1; 32],
        sequence_number: 3,
        recipient: [2; 32],
        amount: 5,
        max_gas_amount: 1000,
        gas_unit_price: 100,
        expiration_timestamp_secs: 1,
        chain_id: 1,
        token: None,
    };
    assert!(AptosStakeTx::decode(&pay.encode().unwrap()).is_err());
}

#[test]
fn signs_verifies_and_keeps_to_the_sender() {
    let s = seed(ABANDON);
    let me = aptos_address(&s, 0).unwrap();
    let raw = hex::encode(
        tx(aptos_parse_address(&me).unwrap(), AptosStakeCall::Withdraw)
            .encode()
            .unwrap(),
    );
    let summary = aptos_stake_decode(&raw, &me).unwrap();
    assert_eq!(summary.call, AptosStakeCall::Withdraw);
    assert_eq!(summary.pool, format!("0x{}", "ab".repeat(32)));
    assert_eq!(summary.max_fee, "2000000");
    let (signed, hash, again) = aptos_stake_sign(&s, 0, &raw).unwrap();
    assert_eq!(again, summary);
    assert_eq!(aptos_stake_verify_signed(&signed).unwrap().0, hash);

    assert!(aptos_stake_sign(&s, 1, &raw).is_err());
    assert!(aptos_stake_decode(&raw, &aptos_address(&s, 1).unwrap()).is_err());
    let mut tampered = hex::decode(&signed).unwrap();
    let n = tampered.len();
    tampered[n - 1] ^= 1;
    assert!(aptos_stake_verify_signed(&hex::encode(tampered)).is_err());

    let pk = aptos_public_key(&s, 0).unwrap();
    let sim = aptos_stake_simulation_bytes(&raw, &pk).unwrap();
    assert!(sim.ends_with(&[0u8; 64]));
    let mut zero = tx(aptos_parse_address(&me).unwrap(), AptosStakeCall::AddStake);
    zero.amount = 0;
    assert!(zero.encode().is_err());
}
