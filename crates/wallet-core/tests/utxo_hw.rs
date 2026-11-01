//! Hardware-wallet signing of Litecoin / Dogecoin / Bitcoin Cash / Dash PSBTs
//! (`utxo_hw_plan`, `utxo_hw_finalize`): only the account xpub is known, the device returns raw
//! signatures, Kyro verifies them against the xpub and its own sighash.
//!
//! The "device" signatures are the ones Kyro's software signer produces for the same seed
//! (`abandon … about`): a correct device returns exactly those (RFC 6979 is deterministic, but
//! only validity matters here); a tampered one must be refused.

mod common;

use std::str::FromStr;

use bitcoin::bip32::{DerivationPath, Xpriv};
use bitcoin::psbt::Psbt;
use bitcoin::secp256k1::Secp256k1;
use bitcoin::transaction::Version;
use bitcoin::{
    absolute::LockTime, Amount, NetworkKind, OutPoint, ScriptBuf, Sequence, Transaction, TxIn,
    TxOut, Witness,
};
use common::{seed, ABANDON, LEGAL};
use wallet_core::{
    utxo_account, utxo_address, utxo_hw_finalize, utxo_hw_plan, utxo_script_pubkey, utxo_sign_psbt,
    HwBtcSignature, Network, UtxoCoin,
};

const T: Network = Network::Testnet;

fn purpose(coin: UtxoCoin) -> u32 {
    if coin == UtxoCoin::Litecoin {
        84
    } else {
        44
    }
}

fn spk_of(coin: UtxoCoin, phrase: &str, change: bool, index: u32) -> ScriptBuf {
    let a = utxo_address(&seed(phrase), T, coin, 0, change, index).unwrap();
    utxo_script_pubkey(&a, T, coin).unwrap()
}

/// 1 input of ours (`…/0/0`, 1 000 000 units), a payment to another wallet and change to
/// `…/1/0`; the previous transaction is always included (devices need it).
fn psbt(coin: UtxoCoin) -> Psbt {
    let secp = Secp256k1::new();
    let master = Xpriv::new_master(NetworkKind::Test, &seed(ABANDON)[..]).unwrap();
    let fp = master.fingerprint(&secp);
    let key = |p: &str| {
        let path = DerivationPath::from_str(p).unwrap();
        let pk = master
            .derive_priv(&secp, &path)
            .unwrap()
            .private_key
            .public_key(&secp);
        (pk, path)
    };
    let prev = Transaction {
        version: Version::ONE,
        lock_time: LockTime::ZERO,
        input: vec![TxIn {
            previous_output: OutPoint::from_str(
                "7618443203806e0d93f7cfd2fc1c3d29ddce290b1d049e12a454ce442238539d:1",
            )
            .unwrap(),
            script_sig: ScriptBuf::from_bytes(vec![0x51]),
            sequence: Sequence::MAX,
            witness: Witness::new(),
        }],
        output: vec![
            TxOut {
                value: Amount::from_sat(5_000),
                script_pubkey: spk_of(coin, LEGAL, false, 0),
            },
            TxOut {
                value: Amount::from_sat(100_000_000),
                script_pubkey: spk_of(coin, ABANDON, false, 0),
            },
        ],
    };
    let tx = Transaction {
        version: Version::TWO,
        lock_time: LockTime::ZERO,
        input: vec![TxIn {
            previous_output: OutPoint {
                txid: prev.compute_txid(),
                vout: 1,
            },
            script_sig: ScriptBuf::new(),
            sequence: Sequence::MAX,
            witness: Witness::new(),
        }],
        output: vec![
            TxOut {
                value: Amount::from_sat(10_000_000),
                script_pubkey: spk_of(coin, LEGAL, false, 1),
            },
            TxOut {
                value: Amount::from_sat(89_000_000),
                script_pubkey: spk_of(coin, ABANDON, true, 0),
            },
        ],
    };
    let mut p = Psbt::from_unsigned_tx(tx).unwrap();
    if coin == UtxoCoin::Litecoin {
        p.inputs[0].witness_utxo = Some(prev.output[1].clone());
    }
    p.inputs[0].non_witness_utxo = Some(prev);
    let pp = purpose(coin);
    let (pk, path) = key(&format!("m/{pp}'/1'/0'/0/0"));
    p.inputs[0].bip32_derivation.insert(pk, (fp, path));
    let (pk, path) = key(&format!("m/{pp}'/1'/0'/1/0"));
    p.outputs[1].bip32_derivation.insert(pk, (fp, path));
    p
}

/// The signature of input 0 as a device returns it (DER ‖ sighash byte).
fn device_signature(coin: UtxoCoin, signed: &Psbt) -> Vec<u8> {
    let input = &signed.inputs[0];
    if coin == UtxoCoin::BitcoinCash {
        let script = input.final_script_sig.as_ref().unwrap();
        match script.instructions().next().unwrap().unwrap() {
            bitcoin::script::Instruction::PushBytes(b) => b.as_bytes().to_vec(),
            _ => panic!("unexpected scriptSig"),
        }
    } else {
        input.partial_sigs.values().next().unwrap().to_vec()
    }
}

#[test]
fn device_signatures_are_verified_and_stored_like_kyro_s_own() {
    for coin in [
        UtxoCoin::Litecoin,
        UtxoCoin::Dogecoin,
        UtxoCoin::BitcoinCash,
        UtxoCoin::Dash,
    ] {
        let s = seed(ABANDON);
        let account = utxo_account(&s, T, coin, 0).unwrap();
        let b64 = psbt(coin).to_string();
        let plan = utxo_hw_plan(T, coin, &account, &b64).unwrap();
        assert_eq!(plan.inputs.len(), 1, "{coin:?}");
        let pp = purpose(coin);
        assert_eq!(
            plan.inputs[0].path,
            vec![pp | 0x8000_0000, 0x8000_0001, 0x8000_0000, 0, 0]
        );
        assert_eq!(plan.inputs[0].amount, 100_000_000);
        assert_eq!(plan.change.len(), 1);
        assert_eq!(plan.change[0].index, 1);
        assert_eq!(plan.change[0].path[3..], [1, 0]);

        let (soft, soft_summary) = utxo_sign_psbt(&s, T, coin, 0, &b64).unwrap();
        assert_eq!(plan.summary, soft_summary, "{coin:?}");
        let sig = device_signature(coin, &Psbt::from_str(&soft).unwrap());
        let dev = vec![HwBtcSignature {
            input: 0,
            pubkey: Some(plan.inputs[0].pubkey.to_vec()),
            signature: sig.clone(),
        }];
        let (hw, summary) = utxo_hw_finalize(T, coin, &account, &b64, &dev).unwrap();
        assert_eq!(hw, soft, "{coin:?}: same PSBT as the software signer");
        assert_eq!(summary, soft_summary);
        // Without the sighash byte (Trezor's form): same result.
        let der = vec![HwBtcSignature {
            input: 0,
            pubkey: None,
            signature: sig[..sig.len() - 1].to_vec(),
        }];
        assert_eq!(
            utxo_hw_finalize(T, coin, &account, &b64, &der).unwrap().0,
            soft
        );

        // A tampered signature, a wrong sighash byte, a missing or duplicated one: refused.
        let mut bad = dev.clone();
        bad[0].signature[8] ^= 1;
        assert!(utxo_hw_finalize(T, coin, &account, &b64, &bad).is_err());
        let mut ty = dev.clone();
        *ty[0].signature.last_mut().unwrap() ^= 0x40;
        assert!(utxo_hw_finalize(T, coin, &account, &b64, &ty).is_err());
        assert!(utxo_hw_finalize(T, coin, &account, &b64, &[]).is_err());
        let twice = vec![dev[0].clone(), dev[0].clone()];
        assert!(utxo_hw_finalize(T, coin, &account, &b64, &twice).is_err());

        // Another account's xpub: the input is not ours.
        let other = utxo_account(&seed(LEGAL), T, coin, 0).unwrap();
        assert!(utxo_hw_plan(T, coin, &other, &b64).is_err());
        // An xpub moved to another path is refused.
        let mut moved = account.clone();
        moved.path = format!("m/{pp}'/1'/1'");
        assert!(utxo_hw_plan(T, coin, &moved, &b64).is_err());
    }
}

#[test]
fn litecoin_needs_the_previous_transaction_for_devices() {
    let account = utxo_account(&seed(ABANDON), T, UtxoCoin::Litecoin, 0).unwrap();
    let mut p = psbt(UtxoCoin::Litecoin);
    p.inputs[0].non_witness_utxo = None;
    let err = utxo_hw_plan(T, UtxoCoin::Litecoin, &account, &p.to_string()).unwrap_err();
    assert!(err.to_string().contains("non_witness_utxo"), "{err}");
}
