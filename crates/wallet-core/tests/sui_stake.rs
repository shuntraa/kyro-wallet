//! Sui staking: real mainnet transactions rebuilt byte for byte, strict refusals, signing.

mod common;

use base64::Engine as _;
use common::{seed, ABANDON};
use wallet_core::{
    sui_address, sui_decode_tx, sui_parse_address, sui_stake_decode, sui_stake_sign,
    sui_stake_verify_signed, sui_tx_digest, SuiObjectRef, SuiStakeAction, SuiStakeCall, SuiStakeTx,
    SuiTransfer, SUI_MIN_STAKE,
};

// Read from graphql.mainnet.sui.io on 2026-11-04 (`transactionBcs`), built by wallets on the TS SDK.
const ADD_ONE_COIN: (&str, &str) = (
    "Ge5zMXQRojvg1CdC1TEx83EkdAQZnEPjUeSq4QCkY2Xz",
    "AAADAAhAmuTPAgAAAAEBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAUBAAAAAAAAAAEAIALysxAZPPi7qKHgkANIeeKoSqI4Sry8iWbNyjM96G3eAgIAAQEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwpzdWlfc3lzdGVtEXJlcXVlc3RfYWRkX3N0YWtlAAMBAQADAAAAAAECAEyKWTu11DNUO6O96StcsJl6dhRXWa4tq/xCHFAvLrJCAVKZX9fZCHu/QOJYklgMzl2cfo3UzZV/m+mt8RFJo03SZxrePwAAAAAgiqxJjJyVMzBx+zi1O4lpMLgfhSdA3xLs96VEOPR+FdFMilk7tdQzVDujvekrXLCZenYUV1muLav8QhxQLy6yQmQAAAAAAAAAsSYYAAAAAAAA",
);
const ADD_TWO_COINS: (&str, &str) = (
    "42UjA4eStpV8W6RTes8Py6e5b7TcB8eqqjkS3jvUWCU4",
    "AAADAAgAMNUMogAAAAEBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAUBAAAAAAAAAAEAIE//0ABVIr5LwClyTH8PbtcJOmvzoJuQ5i9h3BUYHho+AgIAAQEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwpzdWlfc3lzdGVtEXJlcXVlc3RfYWRkX3N0YWtlAAMBAQADAAAAAAECAHh9RjEuTvwFWyQ2hD6TG9cEikYBQ03u94zHQLPwJkvRAkqR/X0MvuLHyGTdQJUW+J7YiGuhENRtoZVmuj6rAG3kmszYPwAAAAAg6WAPj87dZuQr5O4KvI3wkkyy7Jsg9PPu5tul1TTN3pB0BAzSuWIyM2G4K5GiGK/yKe0yhvSYe9CgCU/DCsmI1j9vFD4AAAAAILQUQNH/SMCpXofUTKfp3fv7lxRE3MtKQDn4TgSqKpSCeH1GMS5O/AVbJDaEPpMb1wSKRgFDTe73jMdAs/AmS9FkAAAAAAAAAADh9QUAAAAAAA==",
);
const WITHDRAW: (&str, &str) = (
    "3WpYf6kMWAxUN8bfaAw5WUR17bC1TVCvA5c4DsBTYqan",
    "AAACAQEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABQEAAAAAAAAAAQEA4q542IMnK5JgfxiNgvUE37+KBOBdr6rDRfThwM2vtjKUgQghAAAAACDD5F3fGrbmwEgg8fRPV3IEGSMGyzcHugc3NQcwwCx+bQEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMKc3VpX3N5c3RlbRZyZXF1ZXN0X3dpdGhkcmF3X3N0YWtlAAIBAAABAQCmVRr2qG9p7ZZnJFmspMyp3Ur+VPNbAe8A9syQmVnatQHmuWbHwqzOuT291TAR5Zv091CC5QvekK5hTvnlYh2YnOazECYAAAAAIK5AhDuuuBsgz+OorOaBPA4Si57rIlfBHi7R73leLDzPplUa9qhvae2WZyRZrKTMqd1K/lTzWwHvAPbMkJlZ2rVkAAAAAAAAAEANAwAAAAAAAA==",
);

fn unb64(s: &str) -> Vec<u8> {
    base64::engine::general_purpose::STANDARD.decode(s).unwrap()
}
fn b64(b: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(b)
}

fn gas(id: u8) -> SuiObjectRef {
    SuiObjectRef {
        object_id: [id; 32],
        version: 7,
        digest: [9; 32],
    }
}

fn add(sender: [u8; 32]) -> SuiStakeTx {
    SuiStakeTx {
        sender,
        call: SuiStakeCall::Add {
            amount: 5 * SUI_MIN_STAKE,
            validator: [0xab; 32],
        },
        gas_payment: vec![gas(1)],
        gas_price: 1000,
        gas_budget: 3_000_000,
        expiration_epoch: Some(1301),
    }
}

#[test]
fn real_mainnet_transactions_are_rebuilt_byte_for_byte() {
    for (digest, tx) in [ADD_ONE_COIN, ADD_TWO_COINS, WITHDRAW] {
        let raw = unb64(tx);
        assert_eq!(sui_tx_digest(&raw), digest);
        let t = SuiStakeTx::decode(&raw).unwrap();
        assert_eq!(t.encode().unwrap(), raw);
    }
    let t = SuiStakeTx::decode(&unb64(ADD_ONE_COIN.1)).unwrap();
    assert_eq!(
        t.call,
        SuiStakeCall::Add {
            amount: 12_077_800_000,
            validator: sui_parse_address(
                "0x02f2b310193cf8bba8a1e090034879e2a84aa2384abcbc8966cdca333de86dde"
            )
            .unwrap(),
        }
    );
    let SuiStakeCall::Withdraw { staked } = SuiStakeTx::decode(&unb64(WITHDRAW.1)).unwrap().call
    else {
        panic!("withdraw expected");
    };
    assert_eq!(staked.version, 554_205_588);
    // Without an expiration epoch these are decodable, never signable.
    let me = wallet_core::sui_address_string(&t.sender);
    assert!(sui_stake_decode(ADD_ONE_COIN.1, &me).is_err());
}

#[test]
fn payment_path_still_refuses_every_move_call() {
    let me = wallet_core::sui_address_string(&add([1; 32]).sender);
    for (_, tx) in [ADD_ONE_COIN, WITHDRAW] {
        assert!(SuiTransfer::decode(&unb64(tx)).is_err());
        assert!(sui_decode_tx(tx, &me).is_err());
    }
}

#[test]
fn only_the_two_system_calls_pass() {
    let good = add([1; 32]).encode().unwrap();
    assert!(SuiStakeTx::decode(&good).is_ok());
    // Same-length function name of the system module.
    let swap = |from: &[u8], to: &[u8]| {
        let i = good.windows(from.len()).position(|w| w == from).unwrap();
        let mut b = good.clone();
        b[i..i + to.len()].copy_from_slice(to);
        b
    };
    assert!(SuiStakeTx::decode(&swap(b"request_add_stake", b"request_add_stakf")).is_err());
    assert!(SuiStakeTx::decode(&swap(b"sui_system", b"sui_systen")).is_err());
    // Another package: byte 31 of 0x3 → 0x4.
    let pkg = good
        .windows(11)
        .position(|w| w == b"\x03\x0asui_syste")
        .unwrap();
    let mut b = good.clone();
    b[pkg] = 4;
    assert!(SuiStakeTx::decode(&b).is_err());
    // Trailing byte.
    let mut b = good.clone();
    b.push(0);
    assert!(SuiStakeTx::decode(&b).is_err());
    // Every single-bit change decodes to something else or is refused, never the same value.
    let t = SuiStakeTx::decode(&good).unwrap();
    for i in 0..good.len() {
        let mut b = good.clone();
        b[i] ^= 1;
        if let Ok(o) = SuiStakeTx::decode(&b) {
            assert_ne!(o, t, "byte {i}");
        }
    }
}

#[test]
fn sponsor_low_amount_and_a_staked_gas_coin_are_refused() {
    let mut t = add([1; 32]);
    let raw = t.encode().unwrap();
    // Gas owner: the second copy of the sender.
    let owner = raw.len() - 32 - 8 - 8 - 2 - 7;
    let i = raw[..raw.len() - 8]
        .windows(32)
        .rposition(|w| w == t.sender)
        .unwrap();
    assert!(i <= owner + 7);
    let mut b = raw.clone();
    b[i] ^= 1;
    assert!(SuiStakeTx::decode(&b).is_err());

    t.call = SuiStakeCall::Add {
        amount: SUI_MIN_STAKE - 1,
        validator: [2; 32],
    };
    assert!(t.encode().is_err());
    t.call = SuiStakeCall::Withdraw { staked: gas(1) };
    assert!(t.encode().is_err());
    t.call = SuiStakeCall::Withdraw { staked: gas(2) };
    assert!(t.encode().is_ok());
    t.gas_payment.clear();
    assert!(t.encode().is_err());
}

#[test]
fn signs_verifies_and_keeps_to_the_sender() {
    let s = seed(ABANDON);
    let me = sui_address(&s, 0).unwrap();
    let tx = add(sui_parse_address(&me).unwrap());
    let raw = b64(&tx.encode().unwrap());
    let summary = sui_stake_decode(&raw, &me).unwrap();
    assert_eq!(
        summary.action,
        SuiStakeAction::Add {
            amount: "5000000000".into(),
            validator: format!("0x{}", "ab".repeat(32)),
        }
    );
    assert_eq!(summary.expiration_epoch, 1301);
    let (sig, again) = sui_stake_sign(&s, 0, &raw).unwrap();
    assert_eq!(again, summary);
    let (back, digest) = sui_stake_verify_signed(&raw, &sig).unwrap();
    assert_eq!(back, tx);
    assert_eq!(digest, summary.digest);

    // Another account's key neither signs nor verifies.
    assert!(sui_stake_sign(&s, 1, &raw).is_err());
    let other = sui_address(&s, 1).unwrap();
    assert!(sui_stake_decode(&raw, &other).is_err());
    let foreign = b64(&add(sui_parse_address(&other).unwrap()).encode().unwrap());
    assert!(sui_stake_verify_signed(&foreign, &sig).is_err());
}
