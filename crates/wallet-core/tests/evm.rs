//! EVM derivation, EIP-1559 signing and calldata decoding.
//!
//! The signed transaction is re-parsed here with alloy-rlp's decoder (independent of the
//! encoder in the crate), its signing hash recomputed, and the signer recovered with
//! libsecp256k1.

mod common;

use alloy_rlp::Header;
use bitcoin::secp256k1::ecdsa::{RecoverableSignature, RecoveryId};
use bitcoin::secp256k1::{Message, Secp256k1};
use common::{seed, ABANDON};
use sha3::{Digest, Keccak256};
use wallet_core::{evm_address, Error, EvmTxKind, EvmTxRequest, Network};

/// Every request below is on Sepolia: decoded and signed by a testnet wallet.
fn evm_decode(tx: &EvmTxRequest) -> wallet_core::Result<wallet_core::EvmTxSummary> {
    wallet_core::evm_decode(tx, Network::Testnet)
}

fn evm_sign_tx(
    s: &wallet_core::Seed,
    index: u32,
    tx: &EvmTxRequest,
) -> wallet_core::Result<(String, String)> {
    wallet_core::evm_sign_tx(s, index, tx, Network::Testnet)
}

#[allow(clippy::all, missing_docs)]
mod u256 {
    uint::construct_uint! {
        pub struct U256(4);
    }
}
use u256::U256;

const OUR_ADDR: &str = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
const TOKEN: &str = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238"; // Sepolia USDC
const BOB: &str = "0x00000000000000000000000000000000000000B0"; // EIP-55 form

fn keccak256(data: &[u8]) -> [u8; 32] {
    Keccak256::digest(data).into()
}

#[test]
fn address_index_0() {
    assert_eq!(evm_address(&seed(ABANDON), 0).unwrap(), OUR_ADDR);
    assert_ne!(evm_address(&seed(ABANDON), 1).unwrap(), OUR_ADDR);
}

fn req(to: &str, value: &str, data: &str) -> EvmTxRequest {
    EvmTxRequest {
        chain_id: 11_155_111,
        nonce: 7,
        to: to.into(),
        value_wei: value.into(),
        data: data.into(),
        gas_limit: 21_000,
        max_fee_per_gas: "30000000000".into(),
        max_priority_fee_per_gas: "1500000000".into(),
    }
}

fn calldata(selector: &str, addr: &str, amount: U256) -> String {
    let addr = addr.trim_start_matches("0x").to_lowercase();
    format!(
        "0x{selector}{:0>64}{}",
        addr,
        hex::encode(amount.to_big_endian())
    )
}

fn be_int(bytes: &[u8]) -> u128 {
    assert!(
        bytes.first() != Some(&0),
        "RLP integers have no leading zero"
    );
    bytes
        .iter()
        .fold(0u128, |acc, b| (acc << 8) | u128::from(*b))
}

#[test]
fn sign_eip1559_and_recover() {
    let s = seed(ABANDON);
    let tx = EvmTxRequest {
        data: "0xdeadbeef".into(),
        gas_limit: 60_000,
        ..req(BOB, "1000000000000000", "")
    };
    let (raw, hash) = evm_sign_tx(&s, 0, &tx).unwrap();
    assert!(raw.starts_with("0x02"));
    let raw_bytes = hex::decode(&raw[2..]).unwrap();
    assert_eq!(hash, format!("0x{}", hex::encode(keccak256(&raw_bytes))));

    // Parse 0x02 || rlp([12 items]) with alloy-rlp's decoder.
    assert_eq!(raw_bytes[0], 0x02);
    let mut body = &raw_bytes[1..];
    let outer = Header::decode(&mut body).unwrap();
    assert!(outer.list);
    assert_eq!(body.len(), outer.payload_length);
    let list = body;
    let mut rest = list;
    let mut items: Vec<(bool, &[u8])> = Vec::new();
    let mut ends = Vec::new();
    while !rest.is_empty() {
        let h = Header::decode(&mut rest).unwrap();
        items.push((h.list, &rest[..h.payload_length]));
        rest = &rest[h.payload_length..];
        ends.push(list.len() - rest.len());
    }
    assert_eq!(items.len(), 12);
    assert!(items[..8].iter().all(|(is_list, _)| !is_list));
    assert_eq!(be_int(items[0].1), 11_155_111); // chain id
    assert_eq!(be_int(items[1].1), 7); // nonce
    assert_eq!(be_int(items[2].1), 1_500_000_000); // max priority fee
    assert_eq!(be_int(items[3].1), 30_000_000_000); // max fee
    assert_eq!(be_int(items[4].1), 60_000); // gas limit
    assert_eq!(hex::encode(items[5].1), BOB[2..].to_lowercase()); // to
    assert_eq!(be_int(items[6].1), 1_000_000_000_000_000); // value
    assert_eq!(items[7].1, &[0xde, 0xad, 0xbe, 0xef]); // data
    assert_eq!(items[8], (true, &[][..])); // empty access list
    let y_parity = be_int(items[9].1);
    assert!(y_parity <= 1);
    let (r, s_) = (items[10].1, items[11].1);
    assert!(r.len() <= 32 && s_.len() <= 32);

    // Recompute the signing hash: keccak256(0x02 || rlp(first 9 items)).
    let unsigned = &list[..ends[8]];
    let mut preimage = vec![0x02];
    Header {
        list: true,
        payload_length: unsigned.len(),
    }
    .encode(&mut preimage);
    preimage.extend_from_slice(unsigned);
    let sighash = keccak256(&preimage);

    // Low-S (EIP-2) and recovery with libsecp256k1.
    let mut compact = [0u8; 64];
    compact[32 - r.len()..32].copy_from_slice(r);
    compact[64 - s_.len()..].copy_from_slice(s_);
    let half_n =
        hex::decode("7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0").unwrap();
    assert!(compact[32..] <= half_n[..]);
    let recid = RecoveryId::from_i32(y_parity as i32).unwrap();
    let rsig = RecoverableSignature::from_compact(&compact, recid).unwrap();
    let pk = Secp256k1::verification_only()
        .recover_ecdsa(&Message::from_digest(sighash), &rsig)
        .unwrap();
    let recovered = &keccak256(&pk.serialize_uncompressed()[1..])[12..];
    assert_eq!(hex::encode(recovered), OUR_ADDR[2..].to_lowercase());

    // RFC6979: deterministic.
    assert_eq!(evm_sign_tx(&s, 0, &tx).unwrap(), (raw, hash));
}

#[test]
fn sign_rejects_bad_input() {
    let s = seed(ABANDON);
    for bad in [
        req("0x1234", "1", ""),
        req(BOB, "-1", ""),
        req(BOB, "1.0", ""),
        req(BOB, "1", "0xzz"),
        req(BOB, "1", "0x123"),
        EvmTxRequest {
            max_priority_fee_per_gas: "40000000000".into(),
            ..req(BOB, "1", "")
        },
        EvmTxRequest {
            chain_id: 0,
            ..req(BOB, "1", "")
        },
        EvmTxRequest {
            max_fee_per_gas: "340282366920938463463374607431768211456".into(),
            ..req(BOB, "1", "")
        },
    ] {
        assert!(
            matches!(evm_sign_tx(&s, 0, &bad), Err(Error::InvalidInput(_))),
            "{bad:?}"
        );
        assert!(
            matches!(evm_decode(&bad), Err(Error::InvalidInput(_))),
            "{bad:?}"
        );
    }
}

#[test]
fn decode_native_transfer() {
    let sum = evm_decode(&req(BOB, "1000000000000000000", "0x")).unwrap();
    assert_eq!(sum.kind, EvmTxKind::NativeTransfer);
    assert_eq!(sum.to, BOB);
    assert_eq!(sum.amount, "1000000000000000000");
    assert_eq!(sum.token_contract, None);
    assert_eq!(
        sum.max_fee_wei,
        (21_000u128 * 30_000_000_000u128).to_string()
    );
    assert_eq!(sum.chain_id, 11_155_111);
    assert!(!sum.unlimited_approval);
}

#[test]
fn decode_erc20_transfer() {
    let data = calldata("a9059cbb", OUR_ADDR, U256::from(2_500_000u64));
    let sum = evm_decode(&req(TOKEN, "0", &data)).unwrap();
    assert_eq!(sum.kind, EvmTxKind::Erc20Transfer);
    assert_eq!(sum.to, OUR_ADDR);
    assert_eq!(sum.token_contract.as_deref(), Some(TOKEN));
    assert_eq!(sum.amount, "2500000");
    assert_eq!(sum.value_wei, "0");
    assert_eq!(sum.spender, None);
}

#[test]
fn decode_erc20_approve_limited_and_unlimited() {
    let limited = evm_decode(&req(
        TOKEN,
        "0",
        &calldata("095ea7b3", BOB, U256::from(1000u64)),
    ))
    .unwrap();
    assert_eq!(limited.kind, EvmTxKind::Erc20Approve);
    assert_eq!(limited.spender.as_deref(), Some(BOB));
    assert_eq!(limited.token_contract.as_deref(), Some(TOKEN));
    assert_eq!(limited.amount, "1000");
    assert!(!limited.unlimited_approval);

    let max = evm_decode(&req(TOKEN, "0", &calldata("095ea7b3", BOB, U256::MAX))).unwrap();
    assert!(max.unlimited_approval);
    assert_eq!(max.amount, U256::MAX.to_string());

    let half = evm_decode(&req(
        TOKEN,
        "0",
        &calldata("095ea7b3", BOB, U256::one() << 255),
    ))
    .unwrap();
    assert!(half.unlimited_approval);
    // Audit finding: the summary flag (2^255) and the warning (2^128) disagreed. One rule now:
    // ≥ 2^128 is ILLIMITÉ, in both.
    for (amount, unlimited) in [
        ((U256::one() << 255) - U256::one(), true),
        (U256::one() << 128, true),
        ((U256::one() << 128) - U256::one(), false),
    ] {
        let s = evm_decode(&req(TOKEN, "0", &calldata("095ea7b3", BOB, amount))).unwrap();
        assert_eq!(s.unlimited_approval, unlimited, "{amount}");
        assert!(matches!(
            &s.warnings[0],
            wallet_core::EvmWarning::Approval { unlimited: u, .. } if *u == unlimited
        ));
    }
}

/// Audit finding: a testnet wallet signed mainnet chain ids (and the other way round) after a
/// mere « unknown chain »-free dialog; the known-chain list was also incomplete.
#[test]
fn chain_of_the_other_network_family_is_refused() {
    let s = seed(ABANDON);
    let on = |chain_id| EvmTxRequest {
        chain_id,
        ..req(BOB, "1", "0x")
    };
    for chain in [
        1, 42_161, 137, 61, 25, 5_000, 146, 14, 8_217, 100, 999, 1_329, 1_030,
    ] {
        let tx = on(chain);
        assert!(
            matches!(
                wallet_core::evm_decode(&tx, Network::Testnet),
                Err(Error::InvalidInput(_))
            ),
            "{chain}"
        );
        assert!(wallet_core::evm_sign_tx(&s, 0, &tx, Network::Testnet).is_err());
        let sum = wallet_core::evm_decode(&tx, Network::Mainnet).unwrap();
        assert!(sum.warnings.is_empty(), "{chain}: {:?}", sum.warnings);
        assert!(wallet_core::evm_sign_tx(&s, 0, &tx, Network::Mainnet).is_ok());
    }
    let sepolia = on(11_155_111);
    assert!(wallet_core::evm_decode(&sepolia, Network::Mainnet).is_err());
    assert!(wallet_core::evm_sign_tx(&s, 0, &sepolia, Network::Mainnet).is_err());
    // Unknown everywhere: allowed on both, with the reinforced confirmation.
    for net in [Network::Mainnet, Network::Testnet] {
        let sum = wallet_core::evm_decode(&on(31_337), net).unwrap();
        assert_eq!(
            sum.warnings,
            vec![wallet_core::EvmWarning::UnknownChain { chain_id: 31_337 }]
        );
    }
}

#[test]
fn decode_contract_call_fallbacks() {
    // Unknown selector.
    let sum = evm_decode(&req(TOKEN, "5", "0x12345678")).unwrap();
    assert_eq!(sum.kind, EvmTxKind::ContractCall);
    assert_eq!(sum.to, TOKEN);
    assert_eq!(sum.amount, "5");
    // transfer() with a dirty (non-ABI-canonical) address word is not trusted as a transfer.
    let mut dirty = calldata("a9059cbb", BOB, U256::from(1u8));
    dirty.replace_range(10..12, "ff");
    assert_eq!(
        evm_decode(&req(TOKEN, "0", &dirty)).unwrap().kind,
        EvmTxKind::ContractCall
    );
    // Wrong length.
    let long = format!("{}00", calldata("a9059cbb", BOB, U256::from(1u8)));
    assert_eq!(
        evm_decode(&req(TOKEN, "0", &long)).unwrap().kind,
        EvmTxKind::ContractCall
    );
}

#[test]
fn request_serde_is_camel_case() {
    let json = serde_json::to_value(req(BOB, "1", "0x")).unwrap();
    assert!(json.get("valueWei").is_some());
    assert!(json.get("maxPriorityFeePerGas").is_some());
    let sum = serde_json::to_value(evm_decode(&req(BOB, "1", "0x")).unwrap()).unwrap();
    assert_eq!(sum["kind"], "NativeTransfer");
    assert!(sum.get("maxFeeWei").is_some());
}

// ---------------------------------------------------------------------------------------------
// Reinforced-confirmation triggers
// ---------------------------------------------------------------------------------------------

const OTHER: &str = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";

/// Warnings for a wallet on the chain's own network family (testnet for unknown chains).
fn w(tx: &EvmTxRequest) -> (Vec<wallet_core::EvmWarning>, bool) {
    let net = wallet_core::evm_chain_network(tx.chain_id).unwrap_or(Network::Testnet);
    let s = wallet_core::evm_decode(tx, net).unwrap();
    (s.warnings, s.requires_extra_confirmation)
}

#[test]
fn evm_plain_transfers_need_no_reinforced_dialog() {
    assert_eq!(w(&req(OTHER, "1000", "0x")), (vec![], false));
    let t = req(TOKEN, "0", &calldata("a9059cbb", OTHER, U256::from(5u64)));
    assert_eq!(w(&t), (vec![], false));
}

#[test]
fn evm_approvals_are_reinforced_and_unlimited_flagged() {
    use wallet_core::EvmWarning;
    let approve = |amount: U256| req(TOKEN, "0", &calldata("095ea7b3", OTHER, amount));
    let (warn, extra) = w(&approve(U256::from(1_000_000u64)));
    assert!(extra);
    assert_eq!(
        warn,
        vec![EvmWarning::Approval {
            spender: OTHER.into(),
            amount: "1000000".into(),
            unlimited: false
        }]
    );
    for big in [
        U256::MAX,
        U256::one() << 255,
        U256::one() << 200,
        (U256::one() << 128) + U256::one(),
    ] {
        assert!(
            matches!(
                w(&approve(big)).0.as_slice(),
                [EvmWarning::Approval {
                    unlimited: true,
                    ..
                }]
            ),
            "{big}"
        );
    }
    assert!(matches!(
        w(&approve(U256::one() << 127)).0.as_slice(),
        [EvmWarning::Approval {
            unlimited: false,
            ..
        }]
    ));
}

#[test]
fn evm_contract_call_value_chain_and_fee_triggers() {
    use wallet_core::EvmWarning;
    assert_eq!(
        w(&req(TOKEN, "0", "0xdeadbeef")).0,
        vec![EvmWarning::ContractCall]
    );
    assert_eq!(
        w(&req(TOKEN, "5", "0xdeadbeef")).0,
        vec![
            EvmWarning::ContractCall,
            EvmWarning::ValueToContract {
                value_wei: "5".into()
            }
        ]
    );
    // ERC-20 transfer carrying native value: reinforced too.
    let t = req(TOKEN, "7", &calldata("a9059cbb", OTHER, U256::from(5u64)));
    assert_eq!(
        w(&t).0,
        vec![EvmWarning::ValueToContract {
            value_wei: "7".into()
        }]
    );
    let mut unknown = req(OTHER, "1", "0x");
    unknown.chain_id = 999_999;
    assert_eq!(
        w(&unknown).0,
        vec![EvmWarning::UnknownChain { chain_id: 999_999 }]
    );
    // 1 000 000 gas × 100 gwei = 0.1 ETH > 0.05 ETH.
    let mut fee = req(OTHER, "1", "0x");
    fee.gas_limit = 1_000_000;
    fee.max_fee_per_gas = "100000000000".into();
    assert_eq!(
        w(&fee).0,
        vec![EvmWarning::HighFee {
            max_fee_wei: "100000000000000000".into()
        }]
    );
    // The same 0.1 POL on Polygon is normal (threshold 50 POL).
    fee.chain_id = 137;
    assert_eq!(w(&fee), (vec![], false));
    // Exactly at the threshold: not above it.
    let mut at = req(OTHER, "1", "0x");
    at.gas_limit = 500_000;
    at.max_fee_per_gas = "100000000000".into();
    assert_eq!(w(&at), (vec![], false));
}
