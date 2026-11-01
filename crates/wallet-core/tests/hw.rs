//! Hardware wallets, device-independent part: independent verification of device signatures
//! (a wrong signature must always be rejected), watch-only records, vault compatibility.
//!
//! "Device" signatures are produced here by the software signer of the same seed (they are
//! exactly what an honest device returns), then tampered with.

mod common;

use std::str::FromStr;

use bitcoin::bip32::{DerivationPath, Fingerprint, Xpriv};
use bitcoin::psbt::Psbt;
use bitcoin::secp256k1::Secp256k1;
use bitcoin::transaction::Version;
use bitcoin::{
    absolute::LockTime, Address, Amount, NetworkKind, OutPoint, ScriptBuf, Sequence, Transaction,
    TxIn, TxOut, Txid, Witness,
};
use common::{seed, ABANDON, LEGAL};
use wallet_core::{
    btc_account, btc_address, btc_hw_finalize, btc_hw_own_addresses, btc_hw_plan, btc_sign_psbt,
    evm_address, evm_address_from_xpub, evm_hw_finalize, evm_signing_payload, evm_xpub_from_node,
    open, sol_address, sol_path, sol_sign_message, sol_verify_signature, BtcKind, Error,
    EvmTxRequest, HwBtcSignature, HwDeviceKind, Network, VaultFile, WatchEvm, WatchOnlyAccount,
    WatchOnlyStore, WatchSol, EVM_NODE_PATH,
};

// ------------------------------------------------------------------------------------------
// Bitcoin
// ------------------------------------------------------------------------------------------

struct Wallet {
    master: Xpriv,
    fp: Fingerprint,
}

impl Wallet {
    fn new(phrase: &str) -> Self {
        let secp = Secp256k1::new();
        let master = Xpriv::new_master(NetworkKind::Test, &seed(phrase)[..]).unwrap();
        Wallet {
            fp: master.fingerprint(&secp),
            master,
        }
    }

    fn pubkey(&self, path: &DerivationPath) -> bitcoin::secp256k1::PublicKey {
        let secp = Secp256k1::new();
        self.master
            .derive_priv(&secp, path)
            .unwrap()
            .private_key
            .public_key(&secp)
    }
}

fn script_of(addr: &str) -> ScriptBuf {
    Address::from_str(addr)
        .unwrap()
        .require_network(bitcoin::Network::Testnet)
        .unwrap()
        .script_pubkey()
}

fn txin(byte: u8) -> TxIn {
    TxIn {
        previous_output: OutPoint {
            txid: Txid::from_str(&format!("{byte:02x}").repeat(32)).unwrap(),
            vout: 1,
        },
        script_sig: ScriptBuf::new(),
        sequence: Sequence::ENABLE_RBF_NO_LOCKTIME,
        witness: Witness::new(),
    }
}

fn path(s: &str) -> DerivationPath {
    DerivationPath::from_str(s).unwrap()
}

fn accounts(phrase: &str) -> Vec<wallet_core::BtcAccount> {
    let s = seed(phrase);
    vec![
        btc_account(&s, Network::Testnet, BtcKind::Segwit, 0).unwrap(),
        btc_account(&s, Network::Testnet, BtcKind::Taproot, 0).unwrap(),
    ]
}

/// Input 0: P2WPKH m/84'/1'/0'/0/0 (100 000 sats). Input 1: P2TR m/86'/1'/0'/0/2 (50 000).
/// Outputs: 120 000 to a foreign address, 28 000 change to m/84'/1'/0'/1/0. Fee 2 000.
fn mixed_psbt() -> Psbt {
    let us = Wallet::new(ABANDON);
    let s = seed(ABANDON);
    let wpkh = btc_address(&s, Network::Testnet, BtcKind::Segwit, 0, false, 0).unwrap();
    let tr = btc_address(&s, Network::Testnet, BtcKind::Taproot, 0, false, 2).unwrap();
    let change = btc_address(&s, Network::Testnet, BtcKind::Segwit, 0, true, 0).unwrap();
    let external =
        btc_address(&seed(LEGAL), Network::Testnet, BtcKind::Segwit, 0, false, 0).unwrap();
    let tx = Transaction {
        version: Version::TWO,
        lock_time: LockTime::ZERO,
        input: vec![txin(0xaa), txin(0xbb)],
        output: vec![
            TxOut {
                value: Amount::from_sat(120_000),
                script_pubkey: script_of(&external),
            },
            TxOut {
                value: Amount::from_sat(28_000),
                script_pubkey: script_of(&change),
            },
        ],
    };
    let mut psbt = Psbt::from_unsigned_tx(tx).unwrap();
    psbt.inputs[0].witness_utxo = Some(TxOut {
        value: Amount::from_sat(100_000),
        script_pubkey: script_of(&wpkh),
    });
    let p0 = path("m/84'/1'/0'/0/0");
    psbt.inputs[0]
        .bip32_derivation
        .insert(us.pubkey(&p0), (us.fp, p0));
    psbt.inputs[1].witness_utxo = Some(TxOut {
        value: Amount::from_sat(50_000),
        script_pubkey: script_of(&tr),
    });
    let p1 = path("m/86'/1'/0'/0/2");
    let xonly = us.pubkey(&p1).x_only_public_key().0;
    psbt.inputs[1].tap_internal_key = Some(xonly);
    psbt.inputs[1]
        .tap_key_origins
        .insert(xonly, (vec![], (us.fp, p1)));
    let pc = path("m/84'/1'/0'/1/0");
    psbt.outputs[1]
        .bip32_derivation
        .insert(us.pubkey(&pc), (us.fp, pc));
    psbt
}

/// What an honest device returns for `psbt`: the software signer's signatures.
fn honest_sigs(psbt: &Psbt) -> Vec<HwBtcSignature> {
    let (signed, _) =
        btc_sign_psbt(&seed(ABANDON), Network::Testnet, 0, &psbt.to_string()).unwrap();
    let signed = Psbt::from_str(&signed).unwrap();
    let mut out = Vec::new();
    for (i, input) in signed.inputs.iter().enumerate() {
        for (pk, sig) in &input.partial_sigs {
            out.push(HwBtcSignature {
                input: i,
                pubkey: Some(pk.inner.serialize().to_vec()),
                signature: sig.to_vec(), // DER + sighash byte (Ledger form)
            });
        }
        if let Some(ts) = input.tap_key_sig {
            out.push(HwBtcSignature {
                input: i,
                pubkey: None, // Trezor form: no key reported
                signature: ts.signature.as_ref().to_vec(),
            });
        }
    }
    out
}

#[test]
fn btc_plan_matches_inputs_and_change_against_xpubs() {
    let psbt = mixed_psbt();
    let plan = btc_hw_plan(Network::Testnet, &psbt.to_string(), &accounts(ABANDON)).unwrap();
    assert_eq!(plan.inputs.len(), 2);
    assert_eq!(plan.inputs[0].kind, BtcKind::Segwit);
    assert_eq!(
        plan.inputs[0].path,
        vec![0x8000_0054, 0x8000_0001, 0x8000_0000, 0, 0]
    );
    assert_eq!(plan.inputs[0].pubkey.len(), 33);
    assert!(!plan.inputs[0].has_prev_tx);
    assert_eq!(plan.inputs[1].kind, BtcKind::Taproot);
    assert_eq!(plan.inputs[1].pubkey.len(), 32);
    assert!(plan.external_inputs.is_empty());
    assert_eq!(plan.change.len(), 1);
    assert_eq!(plan.change[0].index, 1);
    assert_eq!(plan.summary.fee_sats, 2_000);
    assert!(!plan.summary.outputs[0].2 && plan.summary.outputs[1].2);

    // Same change flags as the address-based decoder used for the native dialog.
    let own = btc_hw_own_addresses(Network::Testnet, &accounts(ABANDON), 20).unwrap();
    let decoded = wallet_core::btc_decode_psbt(Network::Testnet, &psbt.to_string(), &own).unwrap();
    assert_eq!(decoded, plan.summary);

    // Another wallet's xpubs: nothing is ours.
    assert!(matches!(
        btc_hw_plan(Network::Testnet, &psbt.to_string(), &accounts(LEGAL)),
        Err(Error::Psbt(_))
    ));
    // Wrong network.
    assert!(btc_hw_plan(Network::Mainnet, &psbt.to_string(), &accounts(ABANDON)).is_err());
}

#[test]
fn btc_plan_rejects_lying_key_origin() {
    // Key origin says m/84'/1'/0'/0/0 but the key is the one at /0/1.
    let mut psbt = mixed_psbt();
    let us = Wallet::new(ABANDON);
    psbt.inputs[0].bip32_derivation.clear();
    psbt.inputs[0].bip32_derivation.insert(
        us.pubkey(&path("m/84'/1'/0'/0/1")),
        (us.fp, path("m/84'/1'/0'/0/0")),
    );
    assert!(matches!(
        btc_hw_plan(Network::Testnet, &psbt.to_string(), &accounts(ABANDON)),
        Err(Error::Psbt(_))
    ));
    // A change output whose key origin lies is shown as a recipient, not as change.
    let mut psbt = mixed_psbt();
    psbt.outputs[1].bip32_derivation.clear();
    psbt.outputs[1].bip32_derivation.insert(
        us.pubkey(&path("m/84'/1'/0'/1/1")),
        (us.fp, path("m/84'/1'/0'/1/0")),
    );
    let plan = btc_hw_plan(Network::Testnet, &psbt.to_string(), &accounts(ABANDON)).unwrap();
    assert!(plan.change.is_empty());
    assert!(!plan.summary.outputs[1].2);
}

#[test]
fn btc_finalize_accepts_honest_device_signatures() {
    let psbt = mixed_psbt();
    let sigs = honest_sigs(&psbt);
    assert_eq!(sigs.len(), 2);
    let (signed, summary) = btc_hw_finalize(
        Network::Testnet,
        &psbt.to_string(),
        &accounts(ABANDON),
        &sigs,
    )
    .unwrap();
    assert_eq!(summary.fee_sats, 2_000);
    let signed = Psbt::from_str(&signed).unwrap();
    assert_eq!(signed.unsigned_tx, psbt.unsigned_tx);
    assert_eq!(signed.inputs[0].partial_sigs.len(), 1);
    assert!(signed.inputs[1].tap_key_sig.is_some());

    // Trezor form: DER without the sighash byte, no pubkey.
    let mut trezor = sigs.clone();
    let der = trezor[0].signature.clone();
    trezor[0].signature = der[..der.len() - 1].to_vec();
    trezor[0].pubkey = None;
    btc_hw_finalize(
        Network::Testnet,
        &psbt.to_string(),
        &accounts(ABANDON),
        &trezor,
    )
    .unwrap();
}

#[test]
fn btc_finalize_rejects_wrong_signatures() {
    let psbt = mixed_psbt();
    let b64 = psbt.to_string();
    let accts = accounts(ABANDON);
    let good = honest_sigs(&psbt);
    let device = |sigs: &[HwBtcSignature]| {
        matches!(
            btc_hw_finalize(Network::Testnet, &b64, &accts, sigs),
            Err(Error::Device(_))
        )
    };

    for which in 0..2 {
        // One bit flipped in r (ECDSA) / in the nonce point (Schnorr).
        let mut bad = good.clone();
        let pos = if which == 0 { 8 } else { 5 };
        bad[which].signature[pos] ^= 0x01;
        assert!(device(&bad), "flipped signature {which} accepted");
        // Missing signature for one of our inputs.
        let mut missing = good.clone();
        missing.remove(which);
        assert!(device(&missing), "missing signature {which} accepted");
    }
    // Signatures swapped between inputs, duplicated, or for a foreign index.
    let mut swapped = good.clone();
    swapped[0].input = 1;
    swapped[1].input = 0;
    assert!(device(&swapped));
    let mut dup = good.clone();
    dup.push(good[0].clone());
    assert!(device(&dup));
    let mut extra = good.clone();
    extra.push(HwBtcSignature {
        input: 7,
        ..good[0].clone()
    });
    assert!(device(&extra));
    // Device reports another key.
    let mut other_key = good.clone();
    other_key[0].pubkey = Some(
        Wallet::new(ABANDON)
            .pubkey(&path("m/84'/1'/0'/0/1"))
            .serialize()
            .to_vec(),
    );
    assert!(device(&other_key));
    // SIGHASH_NONE byte instead of ALL.
    let mut none = good.clone();
    *none[0].signature.last_mut().unwrap() = 0x02;
    assert!(device(&none));
    // Signature by another wallet over the same transaction.
    let mut foreign = mixed_psbt();
    let them = Wallet::new(LEGAL);
    let p = path("m/84'/1'/0'/0/0");
    foreign.inputs[0].bip32_derivation.clear();
    foreign.inputs[0]
        .bip32_derivation
        .insert(them.pubkey(&p), (them.fp, p));
    foreign.inputs[0]
        .witness_utxo
        .as_mut()
        .unwrap()
        .script_pubkey = script_of(
        &btc_address(&seed(LEGAL), Network::Testnet, BtcKind::Segwit, 0, false, 0).unwrap(),
    );
    let (their_signed, _) =
        btc_sign_psbt(&seed(LEGAL), Network::Testnet, 0, &foreign.to_string()).unwrap();
    let their_sig = Psbt::from_str(&their_signed).unwrap().inputs[0]
        .partial_sigs
        .values()
        .next()
        .unwrap()
        .to_vec();
    let mut forged = good.clone();
    forged[0].signature = their_sig;
    forged[0].pubkey = None;
    assert!(device(&forged));
}

// ------------------------------------------------------------------------------------------
// EVM
// ------------------------------------------------------------------------------------------

/// Ethereum mainnet tx 0x0ec0b6a2df4d87424e5f6ad2a654e27aaeb7dac20ae9e8385cc09087ad532ee0
/// (also used by alloy-consensus' tests): public on-chain fields and signature.
fn mainnet_tx() -> EvmTxRequest {
    EvmTxRequest {
        chain_id: 1,
        nonce: 0x42,
        to: "0x6069a6c32cf691f5982febae4faf8a6f3ab2f0f6".into(),
        value_wei: "0".into(),
        data: concat!(
            "0xa22cb465",
            "0000000000000000000000005eee75727d804a2b13038928d36f8b188945a57a",
            "0000000000000000000000000000000000000000000000000000000000000000"
        )
        .into(),
        gas_limit: 44386,
        max_fee_per_gas: "20000000000".into(),
        max_priority_fee_per_gas: "1000000000".into(),
    }
}
const MAINNET_R: &str = "840cfc572845f5786e702984c2a582528cad4b49b2a10b9db1be7fca90058565";
const MAINNET_S: &str = "25e7109ceb98168d95b09b18bbf6b685130e0562f233877d492b94eee0c5b6d1";
const MAINNET_FROM: &str = "0xdd6b8b3dc6b7ad97db52f08a275ff4483e024cea";

#[test]
fn evm_payload_and_device_signature_on_mainnet_vector() {
    use sha3::{Digest, Keccak256};
    let tx = mainnet_tx();
    let payload = evm_signing_payload(&tx).unwrap();
    assert_eq!(payload[0], 0x02);
    assert_eq!(
        hex::encode(Keccak256::digest(&payload)),
        "0d5688ac3897124635b6cf1bc0e29d6dfebceebdc10a54d74f2ef8b56535b682"
    );
    let r = hex::decode(MAINNET_R).unwrap();
    let s = hex::decode(MAINNET_S).unwrap();
    let (raw, hash) = evm_hw_finalize(&tx, &r, &s, MAINNET_FROM).unwrap();
    assert_eq!(
        hash,
        "0x0ec0b6a2df4d87424e5f6ad2a654e27aaeb7dac20ae9e8385cc09087ad532ee0"
    );
    assert!(raw.starts_with("0x02"));
}

#[test]
fn evm_rejects_wrong_signatures() {
    let tx = mainnet_tx();
    let r = hex::decode(MAINNET_R).unwrap();
    let s = hex::decode(MAINNET_S).unwrap();
    let device = |tx: &EvmTxRequest, r: &[u8], s: &[u8], from: &str| {
        matches!(evm_hw_finalize(tx, r, s, from), Err(Error::Device(_)))
    };
    // Expected key is someone else.
    assert!(device(
        &tx,
        &r,
        &s,
        "0x9858EfFD232B4033E47d90003D41EC34EcaEda94"
    ));
    // Flipped bit in s.
    let mut s2 = s.clone();
    s2[31] ^= 1;
    assert!(device(&tx, &r, &s2, MAINNET_FROM));
    // Signature for another transaction (nonce changed).
    let mut other = tx.clone();
    other.nonce += 1;
    assert!(device(&other, &r, &s, MAINNET_FROM));
    // High-S twin (n - s) recovers the same key but is invalid under EIP-2.
    let n =
        hex::decode("fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141").unwrap();
    let mut high = [0u8; 32];
    let mut borrow = 0i16;
    for i in (0..32).rev() {
        let v = n[i] as i16 - s[i] as i16 - borrow;
        borrow = i16::from(v < 0);
        high[i] = (v + 256 * borrow) as u8;
    }
    assert!(device(&tx, &r, &high, MAINNET_FROM));
    // Wrong lengths.
    assert!(device(&tx, &r[..31], &s, MAINNET_FROM));
}

#[test]
fn evm_xpub_node_derives_same_addresses_as_seed() {
    let secp = Secp256k1::new();
    let master = Xpriv::new_master(NetworkKind::Main, &seed(ABANDON)[..]).unwrap();
    let node = master.derive_priv(&secp, &path("m/44'/60'/0'/0")).unwrap();
    let pk = node.private_key.public_key(&secp);
    let xpub =
        evm_xpub_from_node(&pk.serialize_uncompressed(), node.chain_code.as_bytes()).unwrap();
    for i in 0..3 {
        assert_eq!(
            evm_address_from_xpub(&xpub, i).unwrap(),
            evm_address(&seed(ABANDON), i).unwrap()
        );
    }
    assert_eq!(
        evm_address_from_xpub(&xpub, 0).unwrap(),
        "0x9858EfFD232B4033E47d90003D41EC34EcaEda94"
    );
    assert!(evm_xpub_from_node(&pk.serialize(), &[0u8; 31]).is_err());
}

// ------------------------------------------------------------------------------------------
// Solana
// ------------------------------------------------------------------------------------------

#[test]
fn sol_verifies_device_signature() {
    let s = seed(ABANDON);
    let me = sol_address(&s, 0).unwrap();
    let msg = b"\x01\x00\x01\x02solana message bytes";
    let sig = sol_sign_message(&s, 0, msg).unwrap();
    assert_eq!(sol_verify_signature(&me, msg, &sig).unwrap(), sig);
    let mut bad = sig;
    bad[10] ^= 1;
    assert!(matches!(
        sol_verify_signature(&me, msg, &bad),
        Err(Error::Device(_))
    ));
    assert!(matches!(
        sol_verify_signature(&sol_address(&s, 1).unwrap(), msg, &sig),
        Err(Error::Device(_))
    ));
    assert!(matches!(
        sol_verify_signature(&me, b"another message", &sig),
        Err(Error::Device(_))
    ));
    assert!(matches!(
        sol_verify_signature(&me, msg, &sig[..63]),
        Err(Error::Device(_))
    ));
}

// ------------------------------------------------------------------------------------------
// Watch-only store and vault compatibility
// ------------------------------------------------------------------------------------------

fn watch_account() -> WatchOnlyAccount {
    let secp = Secp256k1::new();
    let master = Xpriv::new_master(NetworkKind::Main, &seed(ABANDON)[..]).unwrap();
    let node = master.derive_priv(&secp, &path(EVM_NODE_PATH)).unwrap();
    WatchOnlyAccount {
        id: "hw-0123456789abcdef".into(),
        label: "Mon Ledger".into(),
        device: HwDeviceKind::Ledger,
        model: "Nano S Plus".into(),
        network: Network::Testnet,
        account: 0,
        btc: accounts(ABANDON),
        evm: Some(WatchEvm {
            xpub: evm_xpub_from_node(
                &node.private_key.public_key(&secp).serialize(),
                node.chain_code.as_bytes(),
            )
            .unwrap(),
            path: EVM_NODE_PATH.into(),
        }),
        keys: Vec::new(),
        sol: Some(WatchSol {
            address: sol_address(&seed(ABANDON), 0).unwrap(),
            path: sol_path(0),
        }),
    }
}

#[test]
fn watch_only_store_roundtrip_and_validation() {
    let acc = watch_account();
    acc.validate().unwrap();
    assert_eq!(acc.fingerprint(), Some("73c5da0a"));
    assert_eq!(
        acc.evm_address().unwrap().as_deref(),
        Some("0x9858EfFD232B4033E47d90003D41EC34EcaEda94")
    );
    let store = WatchOnlyStore {
        version: 1,
        accounts: vec![acc.clone()],
    };
    let json = store.to_json().unwrap();
    assert!(!json.contains("xprv") && !json.contains("tprv"));
    assert_eq!(
        WatchOnlyStore::from_json(&json, Network::Testnet).unwrap(),
        store
    );
    // Per-network file.
    assert!(WatchOnlyStore::from_json(&json, Network::Mainnet).is_err());
    // Unknown fields, unknown version, duplicates.
    assert!(WatchOnlyStore::from_json(
        &json.replacen("\"label\"", "\"seed\": 1, \"label\"", 1),
        Network::Testnet
    )
    .is_err());
    assert!(WatchOnlyStore::from_json(
        &json.replacen("\"version\": 1", "\"version\": 2", 1),
        Network::Testnet
    )
    .is_err());
    let dup = WatchOnlyStore {
        version: 1,
        accounts: vec![acc.clone(), acc.clone()],
    };
    assert!(dup.validate(Network::Testnet).is_err());

    let bad = |f: &dyn Fn(&mut WatchOnlyAccount)| {
        let mut a = watch_account();
        f(&mut a);
        a.validate().is_err()
    };
    assert!(bad(&|a| a.id = "hw-XYZ".into()));
    assert!(bad(&|a| a.label = String::new()));
    assert!(bad(&|a| a.label = "a\u{0007}b".into()));
    assert!(bad(&|a| a.account = 1)); // xpubs are for account 0
    assert!(bad(&|a| a.btc[0].path = "m/84'/0'/0'".into()));
    assert!(bad(&|a| a.btc[1].fingerprint = "00000000".into()));
    assert!(bad(&|a| a.btc[1].kind = BtcKind::Segwit));
    assert!(bad(&|a| a.network = Network::Mainnet));
    assert!(bad(&|a| a.sol.as_mut().unwrap().path = sol_path(1)));
    assert!(bad(&|a| a.sol.as_mut().unwrap().address = "1111".into()));
    assert!(bad(
        &|a| a.evm.as_mut().unwrap().path = "m/44'/60'/0'".into()
    ));
    assert!(bad(&|a| {
        a.btc.clear();
        a.evm = None;
        a.sol = None;
    }));
}

/// A v1 vault (frozen bytes, minimum KDF parameters): still opens, and the vault format is
/// untouched by the watch-only store (which lives in its own file).
#[test]
fn vault_v1_fixture_still_opens() {
    let json = r#"{"version":1,"kdf":{"m_cost_kib":65536,"t_cost":2,"p_cost":1},"salt":"rvr2EjvXY8Uu+xmPMYv8KA==","nonce":"pNpbiCLhmKrV/OIth2S7cSTfBYFx1B9N","ciphertext":"Ux7Bfob3SAlWHIsYk2oQFWlk40jn3HixH/QjNRezGCmi+Nyi2+vZuPj2/KlGC72Q3IAcOBkEHvMJ7eIfjDcz/RheqwQneajmzOKgMZmoyIvDK3CTAfwXHAqsKJOaSnCJWoTBxO7LdA6K3ghAgg=="}"#;
    let file = VaultFile::from_json(json).unwrap();
    assert_eq!(file.version, 1);
    let m = open(&file, "correct horse battery staple").unwrap();
    assert_eq!(m.phrase().as_str(), ABANDON);
    // The former fixture of this test (1 MiB, 1 pass: below the KDF floor) is now refused
    // before any key derivation, with the right password.
    let weak = r#"{"version":1,"kdf":{"m_cost_kib":1024,"t_cost":1,"p_cost":1},"salt":"dtXEFQtrVj8HlzwKrxaxKw==","nonce":"3YEMAf1YazFtbLg2G5xKYhPPYZx1X3NQ","ciphertext":"xDqwZSPGiU5aDqx0eryE58S+RqFqM0WtHEdggVXkAvirFVf2E+D0Kg8TuYkygkSOiUO48kX8q+H9WqR8GgFoLHJfCMPnNiwexZ8zvvmY4LG6gcrFwWMe2coO6slOyUk+V5+0Q6ftFCN6RZnbxw=="}"#;
    assert!(matches!(
        open(
            &VaultFile::from_json(weak).unwrap(),
            "correct horse battery staple"
        ),
        Err(Error::InvalidVault(_))
    ));
    // A watch-only store is not a vault and vice versa.
    assert!(VaultFile::from_json(&WatchOnlyStore::default().to_json().unwrap()).is_err());
    assert!(WatchOnlyStore::from_json(json, Network::Testnet).is_err());
}

/// Audit finding: a hardware-wallet change output at any index < 2^31 was labelled change (and
/// sent to the device as change, so the device would not show it either).
#[test]
fn btc_plan_change_beyond_max_index_is_a_payment() {
    use wallet_core::{BtcWarning, MAX_CHANGE_INDEX};
    let us = Wallet::new(ABANDON);
    let s = seed(ABANDON);
    for (index, is_change) in [(MAX_CHANGE_INDEX, true), (MAX_CHANGE_INDEX + 1, false)] {
        let mut psbt = mixed_psbt();
        let change = btc_address(&s, Network::Testnet, BtcKind::Segwit, 0, true, index).unwrap();
        psbt.unsigned_tx.output[1].script_pubkey = script_of(&change);
        let p = path(&format!("m/84'/1'/0'/1/{index}"));
        psbt.outputs[1].bip32_derivation.clear();
        psbt.outputs[1]
            .bip32_derivation
            .insert(us.pubkey(&p), (us.fp, p));
        let plan = btc_hw_plan(Network::Testnet, &psbt.to_string(), &accounts(ABANDON)).unwrap();
        assert_eq!(plan.change.len(), usize::from(is_change), "{index}");
        assert_eq!(plan.summary.outputs[1].2, is_change);
        assert_eq!(
            plan.summary
                .warnings
                .contains(&BtcWarning::ChangeIndexOutOfRange { output: 1 }),
            !is_change
        );
        assert_eq!(plan.summary.requires_extra_confirmation, !is_change);
    }
}
