//! Speed up and cancel: the BIP125 rules and the same-nonce rules Rust holds a replacement to.

use std::str::FromStr;

use bitcoin::consensus::encode::serialize_hex;
use bitcoin::psbt::Psbt;
use bitcoin::transaction::Version;
use bitcoin::{
    absolute::LockTime, Amount, OutPoint, ScriptBuf, Sequence, Transaction, TxIn, TxOut, Txid,
    Witness,
};
use wallet_core::{
    evm_check_replacement, evm_min_replacement_fee, rbf_min_fee, utxo_check_replacement,
    EvmReplaceRequest, EvmTxRequest, ReplaceMode, UtxoReplaceRequest, RBF_SEQUENCE,
};

const IN_VALUE: u64 = 100_000;
const PAY: u64 = 60_000;
const OLD_FEE: u64 = 500;

fn wpkh(byte: u8) -> ScriptBuf {
    let mut raw = vec![0x00, 0x14];
    raw.extend_from_slice(&[byte; 20]);
    ScriptBuf::from_bytes(raw)
}

fn input(byte: u8, sequence: u32) -> TxIn {
    TxIn {
        previous_output: OutPoint {
            txid: Txid::from_str(&format!("{byte:02x}").repeat(32)).unwrap(),
            vout: 0,
        },
        script_sig: ScriptBuf::new(),
        sequence: Sequence(sequence),
        witness: Witness::new(),
    }
}

fn out(script: ScriptBuf, sats: u64) -> TxOut {
    TxOut {
        value: Amount::from_sat(sats),
        script_pubkey: script,
    }
}

fn tx(input: Vec<TxIn>, output: Vec<TxOut>) -> Transaction {
    Transaction {
        version: Version::TWO,
        lock_time: LockTime::ZERO,
        input,
        output,
    }
}

/// One input of `IN_VALUE`: a payment to `wpkh(0xaa)` and change to `wpkh(0xcc)`.
fn original(sequence: u32) -> Transaction {
    tx(
        vec![input(1, sequence)],
        vec![
            out(wpkh(0xaa), PAY),
            out(wpkh(0xcc), IN_VALUE - PAY - OLD_FEE),
        ],
    )
}

fn psbt_of(t: Transaction) -> String {
    let n = t.input.len();
    let mut p = Psbt::from_unsigned_tx(t).unwrap();
    for i in 0..n {
        p.inputs[i].witness_utxo = Some(out(wpkh(0x11), IN_VALUE));
    }
    p.to_string()
}

fn request(o: &Transaction, mode: ReplaceMode) -> UtxoReplaceRequest {
    UtxoReplaceRequest {
        txid: o.compute_txid().to_string(),
        raw_tx: serialize_hex(o),
        mode,
    }
}

/// The original with its change lowered by `extra`.
fn bumped(extra: u64) -> Transaction {
    tx(
        vec![input(1, RBF_SEQUENCE)],
        vec![
            out(wpkh(0xaa), PAY),
            out(wpkh(0xcc), IN_VALUE - PAY - OLD_FEE - extra),
        ],
    )
}

fn refused(psbt: &str, req: &UtxoReplaceRequest, change: &[bool], why: &str) {
    let e = utxo_check_replacement(psbt, req, change)
        .unwrap_err()
        .to_string();
    assert!(e.contains(why), "{e}");
}

#[test]
fn a_speed_up_takes_the_fee_from_the_change() {
    let o = original(RBF_SEQUENCE);
    let r = utxo_check_replacement(
        &psbt_of(bumped(1_000)),
        &request(&o, ReplaceMode::SpeedUp),
        &[false, true],
    )
    .unwrap();
    assert_eq!(
        (r.old_fee, r.new_fee, r.extra_fee),
        (OLD_FEE, OLD_FEE + 1_000, 1_000)
    );
    assert_eq!(r.txid, o.compute_txid().to_string());
}

#[test]
fn the_fee_must_pay_for_the_replacement_relay() {
    let o = original(RBF_SEQUENCE);
    let req = request(&o, ReplaceMode::SpeedUp);
    // 1 input, 2 P2WPKH outputs: 141 vB once signed.
    let vsize = 141;
    let min = rbf_min_fee(OLD_FEE, vsize).unwrap() - OLD_FEE;
    assert!(utxo_check_replacement(&psbt_of(bumped(min)), &req, &[false, true]).is_ok());
    refused(
        &psbt_of(bumped(min - 1)),
        &req,
        &[false, true],
        "does not rise",
    );
    refused(&psbt_of(bumped(0)), &req, &[false, true], "does not rise");
}

#[test]
fn an_original_not_marked_replaceable_is_refused() {
    let o = original(Sequence::MAX.0);
    refused(
        &psbt_of(bumped(1_000)),
        &request(&o, ReplaceMode::SpeedUp),
        &[false, true],
        "not marked replaceable",
    );
}

#[test]
fn the_replacement_stays_replaceable() {
    let o = original(RBF_SEQUENCE);
    let mut t = bumped(1_000);
    t.input[0].sequence = Sequence::MAX;
    refused(
        &psbt_of(t),
        &request(&o, ReplaceMode::SpeedUp),
        &[false, true],
        "stay replaceable",
    );
}

#[test]
fn a_forged_original_is_refused() {
    let o = original(RBF_SEQUENCE);
    let mut req = request(&o, ReplaceMode::SpeedUp);
    req.txid = "ab".repeat(32);
    refused(
        &psbt_of(bumped(1_000)),
        &req,
        &[false, true],
        "does not match",
    );
    req.raw_tx = "zz".into();
    refused(&psbt_of(bumped(1_000)), &req, &[false, true], "unreadable");
}

#[test]
fn the_inputs_stay_those_of_the_original() {
    let o = original(RBF_SEQUENCE);
    let req = request(&o, ReplaceMode::SpeedUp);
    let mut other = bumped(1_000);
    other.input[0] = input(2, RBF_SEQUENCE);
    refused(&psbt_of(other), &req, &[false, true], "exactly those");
    let mut more = bumped(1_000);
    more.input.push(input(2, RBF_SEQUENCE));
    refused(&psbt_of(more), &req, &[false, true], "exactly those");
}

#[test]
fn a_speed_up_never_touches_a_payment() {
    let o = original(RBF_SEQUENCE);
    let req = request(&o, ReplaceMode::SpeedUp);
    // The extra fee taken from the recipient.
    let mut cut = bumped(0);
    cut.output[0].value = Amount::from_sat(PAY - 1_000);
    refused(&psbt_of(cut), &req, &[false, true], "only your own change");
    // Another recipient.
    let mut swapped = bumped(1_000);
    swapped.output[0].script_pubkey = wpkh(0xbb);
    refused(&psbt_of(swapped), &req, &[false, true], "every recipient");
    // An output added or dropped.
    let mut added = bumped(2_000);
    added.output.push(out(wpkh(0xbb), 1_000));
    refused(
        &psbt_of(added),
        &req,
        &[false, true, false],
        "keeps every output",
    );
    // « Change » that grows is a payment in disguise.
    let mut grown = bumped(1_000);
    grown.output[0].value = Amount::from_sat(PAY - 2_000);
    grown.output[1].value = Amount::from_sat(IN_VALUE - PAY - OLD_FEE + 1_000);
    refused(&psbt_of(grown), &req, &[true, true], "only your own change");
}

fn cancel(extra: u64) -> Transaction {
    tx(
        vec![input(1, RBF_SEQUENCE)],
        vec![out(wpkh(0xcc), IN_VALUE - OLD_FEE - extra)],
    )
}

#[test]
fn a_cancel_pays_only_yourself() {
    let o = original(RBF_SEQUENCE);
    let req = request(&o, ReplaceMode::Cancel);
    let r = utxo_check_replacement(&psbt_of(cancel(1_000)), &req, &[true]).unwrap();
    assert_eq!(r.extra_fee, 1_000);
    refused(&psbt_of(cancel(1_000)), &req, &[false], "to yourself");
    let two = bumped(1_000);
    refused(&psbt_of(two), &req, &[true, true], "to yourself");
    refused(&psbt_of(cancel(0)), &req, &[true], "does not rise");
}

const OWN: &str = "0x6069a6c32cf691f5982febae4faf8a6f3ab2f0f6";

/// Ethereum mainnet tx 0x0ec0b6a2…, the vector of `evm.rs`: public on-chain data.
fn evm_original(mode: ReplaceMode) -> EvmReplaceRequest {
    EvmReplaceRequest {
        hash: "0x0ec0b6a2df4d87424e5f6ad2a654e27aaeb7dac20ae9e8385cc09087ad532ee0".into(),
        mode,
        tx: EvmTxRequest {
            chain_id: 1,
            nonce: 0x42,
            to: OWN.into(),
            value_wei: "0".into(),
            data: concat!(
                "0xa22cb465",
                "0000000000000000000000005eee75727d804a2b13038928d36f8b188945a57a",
                "0000000000000000000000000000000000000000000000000000000000000000"
            )
            .into(),
            gas_limit: 44_386,
            max_fee_per_gas: 0x4a8_17c800u64.to_string(),
            max_priority_fee_per_gas: 0x3b9a_ca00u64.to_string(),
        },
        y_parity: 0,
        r: "0x840cfc572845f5786e702984c2a582528cad4b49b2a10b9db1be7fca90058565".into(),
        s: "0x25e7109ceb98168d95b09b18bbf6b685130e0562f233877d492b94eee0c5b6d1".into(),
    }
}

/// The same transaction with both fee fields up by 10%, the node's minimum.
fn evm_faster(o: &EvmReplaceRequest) -> EvmTxRequest {
    let up = |v: &str| evm_min_replacement_fee(v.parse().unwrap()).to_string();
    EvmTxRequest {
        max_fee_per_gas: up(&o.tx.max_fee_per_gas),
        max_priority_fee_per_gas: up(&o.tx.max_priority_fee_per_gas),
        ..o.tx.clone()
    }
}

fn evm_refused(tx: &EvmTxRequest, o: &EvmReplaceRequest, why: &str) {
    let e = evm_check_replacement(tx, o, OWN).unwrap_err().to_string();
    assert!(e.contains(why), "{e}");
}

#[test]
fn nodes_want_ten_percent_more_rounded_up() {
    assert_eq!(evm_min_replacement_fee(100), 110);
    assert_eq!(evm_min_replacement_fee(101), 112);
    assert_eq!(evm_min_replacement_fee(0), 1);
    assert_eq!(evm_min_replacement_fee(u128::MAX), u128::MAX);
}

#[test]
fn an_evm_speed_up_changes_only_the_fees() {
    let o = evm_original(ReplaceMode::SpeedUp);
    let t = evm_faster(&o);
    let r = evm_check_replacement(&t, &o, OWN).unwrap();
    assert_eq!(r.nonce, 0x42);
    assert_eq!(r.old_max_fee_wei, (44_386u128 * 0x4a8_17c800).to_string());

    for (field, change) in [
        (
            "to",
            (|t| t.to = "0x0000000000000000000000000000000000000001".into())
                as fn(&mut EvmTxRequest),
        ),
        ("value", |t| t.value_wei = "1".into()),
        ("data", |t| t.data = "0x".into()),
        ("gas", |t| t.gas_limit += 1),
    ] {
        let mut bad = t.clone();
        change(&mut bad);
        assert!(evm_check_replacement(&bad, &o, OWN).is_err(), "{field}");
    }
}

#[test]
fn the_nonce_and_network_cannot_change() {
    let o = evm_original(ReplaceMode::SpeedUp);
    let mut t = evm_faster(&o);
    t.nonce += 1;
    evm_refused(&t, &o, "nonce");
    let mut t = evm_faster(&o);
    t.chain_id = 137;
    evm_refused(&t, &o, "network");
}

#[test]
fn both_fee_fields_must_rise_by_ten_percent() {
    let o = evm_original(ReplaceMode::SpeedUp);
    let less = |v: &str| (v.parse::<u128>().unwrap() - 1).to_string();
    let mut t = evm_faster(&o);
    t.max_fee_per_gas = less(&t.max_fee_per_gas);
    evm_refused(&t, &o, "10%");
    let mut t = evm_faster(&o);
    t.max_priority_fee_per_gas = less(&t.max_priority_fee_per_gas);
    evm_refused(&t, &o, "10%");
}

#[test]
fn a_node_cannot_lie_about_the_original() {
    // A fake low fee would let a replacement look like a bigger rise than it is.
    let mut o = evm_original(ReplaceMode::SpeedUp);
    let t = evm_faster(&o);
    o.tx.max_fee_per_gas = "1000000001".into();
    evm_refused(&t, &o, "does not match");
    let mut o = evm_original(ReplaceMode::SpeedUp);
    o.y_parity = 2;
    evm_refused(&t, &o, "parity");
}

#[test]
fn an_evm_cancel_is_a_zero_value_send_to_yourself() {
    let o = evm_original(ReplaceMode::Cancel);
    let faster = evm_faster(&o);
    let cancel = EvmTxRequest {
        to: OWN.into(),
        value_wei: "0".into(),
        data: "0x".into(),
        gas_limit: 21_000,
        ..faster
    };
    assert!(evm_check_replacement(&cancel, &o, OWN).is_ok());
    let mut t = cancel.clone();
    t.value_wei = "1".into();
    evm_refused(&t, &o, "0-value");
    let mut t = cancel.clone();
    t.data = "0x00".into();
    evm_refused(&t, &o, "0-value");
    let mut t = cancel;
    t.to = "0x0000000000000000000000000000000000000001".into();
    evm_refused(&t, &o, "0-value");
}
