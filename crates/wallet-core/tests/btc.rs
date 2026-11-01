//! BIP84 / BIP86 official vectors and PSBT signing/decoding.

mod common;

use std::str::FromStr;

use bitcoin::bip32::{DerivationPath, Fingerprint, Xpriv};
use bitcoin::psbt::{Psbt, PsbtSighashType};
use bitcoin::secp256k1::{Message, Secp256k1, XOnlyPublicKey};
use bitcoin::sighash::{EcdsaSighashType, Prevouts, SighashCache, TapSighashType};
use bitcoin::transaction::Version;
use bitcoin::{
    absolute::LockTime, Address, Amount, NetworkKind, OutPoint, ScriptBuf, Sequence, Transaction,
    TxIn, TxOut, Txid, Witness,
};
use common::{seed, ABANDON, LEGAL};
use wallet_core::{
    btc_account, btc_address, btc_address_from_xpub, btc_decode_psbt, btc_descriptors,
    btc_sign_psbt, BtcKind, Error, Network,
};

/// BIP84 publishes SLIP-132 `zpub`s; re-encode with the standard xpub version bytes.
fn zpub_to_xpub(zpub: &str) -> String {
    let mut data = bitcoin::base58::decode_check(zpub).unwrap();
    assert_eq!(&data[..4], &[0x04, 0xb2, 0x47, 0x46], "zpub version");
    data[..4].copy_from_slice(&[0x04, 0x88, 0xb2, 0x1e]);
    bitcoin::base58::encode_check(&data)
}

#[test]
fn bip84_vector() {
    let s = seed(ABANDON);
    let acct = btc_account(&s, Network::Mainnet, BtcKind::Segwit, 0).unwrap();
    assert_eq!(
        acct.xpub,
        zpub_to_xpub("zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs")
    );
    assert_eq!(acct.path, "m/84'/0'/0'");
    assert_eq!(acct.fingerprint, "73c5da0a");
    assert_eq!(acct.kind, BtcKind::Segwit);

    let addr =
        |change, i| btc_address(&s, Network::Mainnet, BtcKind::Segwit, 0, change, i).unwrap();
    assert_eq!(addr(false, 0), "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu");
    assert_eq!(addr(false, 1), "bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g");
    assert_eq!(addr(true, 0), "bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el");
}

#[test]
fn bip84_testnet() {
    let s = seed(ABANDON);
    let acct = btc_account(&s, Network::Testnet, BtcKind::Segwit, 0).unwrap();
    assert!(acct.xpub.starts_with("tpub"));
    assert_eq!(acct.path, "m/84'/1'/0'");
    assert_eq!(
        btc_address(&s, Network::Testnet, BtcKind::Segwit, 0, false, 0).unwrap(),
        "tb1q6rz28mcfaxtmd6v789l9rrlrusdprr9pqcpvkl"
    );
}

#[test]
fn bip86_vector() {
    let s = seed(ABANDON);
    let acct = btc_account(&s, Network::Mainnet, BtcKind::Taproot, 0).unwrap();
    assert_eq!(
        acct.xpub,
        "xpub6BgBgsespWvERF3LHQu6CnqdvfEvtMcQjYrcRzx53QJjSxarj2afYWcLteoGVky7D3UKDP9QyrLprQ3VCECoY49yfdDEHGCtMMj92pReUsQ"
    );
    assert_eq!(acct.path, "m/86'/0'/0'");
    assert_eq!(acct.fingerprint, "73c5da0a");

    let addr =
        |change, i| btc_address(&s, Network::Mainnet, BtcKind::Taproot, 0, change, i).unwrap();
    assert_eq!(
        addr(false, 0),
        "bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr"
    );
    assert_eq!(
        addr(false, 1),
        "bc1p4qhjn9zdvkux4e44uhx8tc55attvtyu358kutcqkudyccelu0was9fqzwh"
    );
    assert_eq!(
        addr(true, 0),
        "bc1p3qkhfews2uk44qtvauqyr2ttdsw7svhkl9nkm9s9c3x4ax5h60wqwruhk7"
    );
}

#[test]
fn bip86_testnet_prefix() {
    let s = seed(ABANDON);
    let a = btc_address(&s, Network::Testnet, BtcKind::Taproot, 0, false, 0).unwrap();
    assert!(a.starts_with("tb1p"), "{a}");
}

#[test]
fn rejects_out_of_range_indices() {
    let s = seed(ABANDON);
    assert!(matches!(
        btc_address(&s, Network::Mainnet, BtcKind::Segwit, 0, false, 1 << 31),
        Err(Error::InvalidInput(_))
    ));
    assert!(matches!(
        btc_account(&s, Network::Mainnet, BtcKind::Segwit, 1 << 31),
        Err(Error::InvalidInput(_))
    ));
}

struct Wallet {
    master: Xpriv,
    fp: Fingerprint,
}

impl Wallet {
    fn new(phrase: &str) -> Self {
        let secp = Secp256k1::new();
        let s = seed(phrase);
        let master = Xpriv::new_master(NetworkKind::Test, &s[..]).unwrap();
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

fn segwit_psbt() -> (Psbt, String, String, String) {
    let us = Wallet::new(ABANDON);
    let s = seed(ABANDON);
    let ours = btc_address(&s, Network::Testnet, BtcKind::Segwit, 0, false, 0).unwrap();
    let change = btc_address(&s, Network::Testnet, BtcKind::Segwit, 0, true, 0).unwrap();
    let external =
        btc_address(&seed(LEGAL), Network::Testnet, BtcKind::Segwit, 0, false, 0).unwrap();

    let tx = Transaction {
        version: Version::TWO,
        lock_time: LockTime::ZERO,
        input: vec![txin(0xaa)],
        output: vec![
            TxOut {
                value: Amount::from_sat(60_000),
                script_pubkey: script_of(&external),
            },
            TxOut {
                value: Amount::from_sat(39_000),
                script_pubkey: script_of(&change),
            },
        ],
    };
    let mut psbt = Psbt::from_unsigned_tx(tx).unwrap();
    psbt.inputs[0].witness_utxo = Some(TxOut {
        value: Amount::from_sat(100_000),
        script_pubkey: script_of(&ours),
    });
    let p_in = path("m/84'/1'/0'/0/0");
    psbt.inputs[0]
        .bip32_derivation
        .insert(us.pubkey(&p_in), (us.fp, p_in));
    let p_change = path("m/84'/1'/0'/1/0");
    psbt.outputs[1]
        .bip32_derivation
        .insert(us.pubkey(&p_change), (us.fp, p_change));
    (psbt, ours, change, external)
}

#[test]
fn psbt_segwit_sign_and_verify() {
    let (psbt, _ours, change, external) = segwit_psbt();
    let s = seed(ABANDON);
    let (signed_b64, summary) = btc_sign_psbt(&s, Network::Testnet, 0, &psbt.to_string()).unwrap();

    assert_eq!(summary.fee_sats, 1_000);
    assert_eq!(
        summary.outputs,
        vec![
            (external.clone(), 60_000, false),
            (change.clone(), 39_000, true)
        ]
    );

    let signed = Psbt::from_str(&signed_b64).unwrap();
    assert_eq!(signed.unsigned_tx, psbt.unsigned_tx);
    let input = &signed.inputs[0];
    assert_eq!(input.partial_sigs.len(), 1);
    assert!(
        input.final_script_witness.is_none(),
        "must not be finalized"
    );

    // Independently recompute the BIP143 sighash and verify the signature.
    let secp = Secp256k1::verification_only();
    let (pk, sig) = input.partial_sigs.iter().next().unwrap();
    assert_eq!(sig.sighash_type, EcdsaSighashType::All);
    let utxo = input.witness_utxo.as_ref().unwrap();
    let sighash = SighashCache::new(&signed.unsigned_tx)
        .p2wpkh_signature_hash(0, &utxo.script_pubkey, utxo.value, EcdsaSighashType::All)
        .unwrap();
    secp.verify_ecdsa(&Message::from(sighash), &sig.signature, &pk.inner)
        .unwrap();
    assert_eq!(*pk.inner.serialize().first().unwrap() & 0xfe, 0x02);

    let decoded = btc_decode_psbt(Network::Testnet, &signed_b64, &[change, _ours]).unwrap();
    assert_eq!(decoded, summary);
}

#[test]
fn psbt_taproot_sign_and_verify() {
    let us = Wallet::new(ABANDON);
    let s = seed(ABANDON);
    let ours = btc_address(&s, Network::Testnet, BtcKind::Taproot, 0, false, 0).unwrap();
    let external = btc_address(
        &seed(LEGAL),
        Network::Testnet,
        BtcKind::Taproot,
        0,
        false,
        0,
    )
    .unwrap();
    let tx = Transaction {
        version: Version::TWO,
        lock_time: LockTime::ZERO,
        input: vec![txin(0xbb)],
        output: vec![TxOut {
            value: Amount::from_sat(49_500),
            script_pubkey: script_of(&external),
        }],
    };
    let mut psbt = Psbt::from_unsigned_tx(tx).unwrap();
    let utxo = TxOut {
        value: Amount::from_sat(50_000),
        script_pubkey: script_of(&ours),
    };
    psbt.inputs[0].witness_utxo = Some(utxo.clone());
    let p = path("m/86'/1'/0'/0/0");
    let xonly = us.pubkey(&p).x_only_public_key().0;
    psbt.inputs[0].tap_internal_key = Some(xonly);
    psbt.inputs[0]
        .tap_key_origins
        .insert(xonly, (vec![], (us.fp, p)));

    let (signed_b64, summary) = btc_sign_psbt(&s, Network::Testnet, 0, &psbt.to_string()).unwrap();
    assert_eq!(summary.fee_sats, 500);
    assert_eq!(summary.outputs, vec![(external, 49_500, false)]);

    let signed = Psbt::from_str(&signed_b64).unwrap();
    let sig = signed.inputs[0].tap_key_sig.expect("tap_key_sig populated");
    assert_eq!(sig.sighash_type, TapSighashType::Default);

    // Verify against the BIP341 key-spend sighash and the tweaked output key in the script.
    let output_key = XOnlyPublicKey::from_slice(&utxo.script_pubkey.as_bytes()[2..34]).unwrap();
    let sighash = SighashCache::new(&signed.unsigned_tx)
        .taproot_key_spend_signature_hash(0, &Prevouts::All(&[utxo]), TapSighashType::Default)
        .unwrap();
    Secp256k1::verification_only()
        .verify_schnorr(&sig.signature, &Message::from(sighash), &output_key)
        .unwrap();
}

#[test]
fn psbt_foreign_inputs_left_untouched() {
    let (mut psbt, ..) = segwit_psbt();
    let them = Wallet::new(LEGAL);
    let foreign =
        btc_address(&seed(LEGAL), Network::Testnet, BtcKind::Segwit, 0, false, 5).unwrap();
    psbt.unsigned_tx.input.push(txin(0xcc));
    psbt.inputs.push(Default::default());
    psbt.inputs[1].witness_utxo = Some(TxOut {
        value: Amount::from_sat(10_000),
        script_pubkey: script_of(&foreign),
    });
    let p = path("m/84'/1'/0'/0/5");
    psbt.inputs[1]
        .bip32_derivation
        .insert(them.pubkey(&p), (them.fp, p));

    let (signed_b64, summary) =
        btc_sign_psbt(&seed(ABANDON), Network::Testnet, 0, &psbt.to_string()).unwrap();
    assert_eq!(summary.fee_sats, 11_000);
    let signed = Psbt::from_str(&signed_b64).unwrap();
    assert_eq!(signed.inputs[0].partial_sigs.len(), 1);
    assert!(signed.inputs[1].partial_sigs.is_empty());
    assert_eq!(signed.inputs[1], psbt.inputs[1]);
}

#[test]
fn psbt_errors() {
    let s = seed(ABANDON);
    let (psbt, ..) = segwit_psbt();

    let mut no_utxo = psbt.clone();
    no_utxo.inputs[0].witness_utxo = None;
    let b64 = no_utxo.to_string();
    assert!(matches!(
        btc_decode_psbt(Network::Testnet, &b64, &[]),
        Err(Error::Psbt(_))
    ));
    assert!(matches!(
        btc_sign_psbt(&s, Network::Testnet, 0, &b64),
        Err(Error::Psbt(_))
    ));

    assert!(matches!(
        btc_sign_psbt(&seed(LEGAL), Network::Testnet, 0, &psbt.to_string()),
        Err(Error::Psbt(_))
    ));
    assert!(matches!(
        btc_sign_psbt(&s, Network::Mainnet, 0, &psbt.to_string()),
        Err(Error::Psbt(_))
    ));

    let mut sighash_none = psbt.clone();
    sighash_none.inputs[0].sighash_type = Some(PsbtSighashType::from(EcdsaSighashType::None));
    assert!(matches!(
        btc_sign_psbt(&s, Network::Testnet, 0, &sighash_none.to_string()),
        Err(Error::Psbt(_))
    ));

    let mut negative = psbt.clone();
    negative.inputs[0].witness_utxo.as_mut().unwrap().value = Amount::from_sat(1_000);
    assert!(matches!(
        btc_decode_psbt(Network::Testnet, &negative.to_string(), &[]),
        Err(Error::Psbt(_))
    ));

    assert!(matches!(
        btc_decode_psbt(Network::Testnet, "not a psbt", &[]),
        Err(Error::Psbt(_))
    ));
    assert!(matches!(
        btc_sign_psbt(&s, Network::Testnet, 0, ""),
        Err(Error::Psbt(_))
    ));

    assert!(matches!(
        btc_decode_psbt(
            Network::Testnet,
            &psbt.to_string(),
            &["bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu".into()]
        ),
        Err(Error::InvalidInput(_))
    ));
}

#[test]
fn psbt_decode_flags_own_outputs_only() {
    let (psbt, _ours, change, external) = segwit_psbt();
    let summary = btc_decode_psbt(Network::Testnet, &psbt.to_string(), &[]).unwrap();
    assert_eq!(
        summary.outputs,
        vec![(external, 60_000, false), (change, 39_000, false)]
    );
    assert_eq!(summary.fee_sats, 1_000);
}

/// Descriptors are built from the official BIP84 / BIP86 account keys and fingerprint.
#[test]
fn watch_only_descriptors_from_bip_vectors() {
    let s = seed(ABANDON);
    let d = btc_descriptors(&s, Network::Mainnet, 0).unwrap();
    let xpub84 = zpub_to_xpub("zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs");
    let xpub86 = "xpub6BgBgsespWvERF3LHQu6CnqdvfEvtMcQjYrcRzx53QJjSxarj2afYWcLteoGVky7D3UKDP9QyrLprQ3VCECoY49yfdDEHGCtMMj92pReUsQ";
    let got: Vec<_> = d
        .iter()
        .map(|x| (x.kind, x.internal, x.descriptor.clone()))
        .collect();
    assert_eq!(
        got,
        vec![
            (
                BtcKind::Segwit,
                false,
                format!("wpkh([73c5da0a/84h/0h/0h]{xpub84}/0/*)")
            ),
            (
                BtcKind::Segwit,
                true,
                format!("wpkh([73c5da0a/84h/0h/0h]{xpub84}/1/*)")
            ),
            (
                BtcKind::Taproot,
                false,
                format!("tr([73c5da0a/86h/0h/0h]{xpub86}/0/*)")
            ),
            (
                BtcKind::Taproot,
                true,
                format!("tr([73c5da0a/86h/0h/0h]{xpub86}/1/*)")
            ),
        ]
    );
    let t = btc_descriptors(&s, Network::Testnet, 0).unwrap();
    assert!(t[0].descriptor.starts_with("wpkh([73c5da0a/84h/1h/0h]tpub"));
    assert!(t.iter().all(|x| !x.descriptor.contains("prv")));
}

#[test]
fn address_from_xpub_matches_seed_derivation() {
    let s = seed(ABANDON);
    for net in [Network::Mainnet, Network::Testnet] {
        for kind in [BtcKind::Segwit, BtcKind::Taproot] {
            let xpub = btc_account(&s, net, kind, 0).unwrap().xpub;
            for change in [false, true] {
                for i in [0, 1, 7, 1000] {
                    assert_eq!(
                        btc_address_from_xpub(&xpub, net, kind, change, i).unwrap(),
                        btc_address(&s, net, kind, 0, change, i).unwrap()
                    );
                }
            }
        }
    }
    // BIP86 vector, from the account xpub alone.
    let xpub86 = "xpub6BgBgsespWvERF3LHQu6CnqdvfEvtMcQjYrcRzx53QJjSxarj2afYWcLteoGVky7D3UKDP9QyrLprQ3VCECoY49yfdDEHGCtMMj92pReUsQ";
    assert_eq!(
        btc_address_from_xpub(xpub86, Network::Mainnet, BtcKind::Taproot, false, 0).unwrap(),
        "bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr"
    );
    assert!(btc_address_from_xpub(xpub86, Network::Testnet, BtcKind::Taproot, false, 0).is_err());
    assert!(
        btc_address_from_xpub("xpubnope", Network::Mainnet, BtcKind::Segwit, false, 0).is_err()
    );
}

fn warnings_of(psbt: &Psbt) -> (Vec<wallet_core::BtcWarning>, bool) {
    let s = seed(ABANDON);
    let preview =
        wallet_core::btc_psbt_summary(&s, Network::Testnet, 0, &psbt.to_string()).unwrap();
    let (_, signed) = btc_sign_psbt(&s, Network::Testnet, 0, &psbt.to_string()).unwrap();
    assert_eq!(preview, signed, "dialog summary = signature summary");
    (signed.warnings, signed.requires_extra_confirmation)
}

#[test]
fn btc_plain_payment_needs_no_reinforced_dialog() {
    let (psbt, ..) = segwit_psbt();
    assert_eq!(warnings_of(&psbt), (vec![], false));
}

#[test]
fn btc_op_return_and_unknown_script_are_reinforced() {
    use wallet_core::BtcWarning;
    let (mut psbt, ..) = segwit_psbt();
    psbt.unsigned_tx.output.push(TxOut {
        value: Amount::ZERO,
        script_pubkey: ScriptBuf::new_op_return([0x6b, 0x79, 0x72, 0x6f]),
    });
    psbt.outputs.push(Default::default());
    psbt.unsigned_tx.output.push(TxOut {
        value: Amount::from_sat(500),
        script_pubkey: ScriptBuf::from_bytes(vec![0x51]),
    });
    psbt.outputs.push(Default::default());
    let (w, extra) = warnings_of(&psbt);
    assert!(extra);
    assert_eq!(
        w,
        vec![
            BtcWarning::OpReturn { output: 2 },
            BtcWarning::UnknownScript { output: 3 }
        ]
    );
}

#[test]
fn btc_foreign_input_is_reinforced() {
    let (mut psbt, ..) = segwit_psbt();
    let foreign =
        btc_address(&seed(LEGAL), Network::Testnet, BtcKind::Segwit, 0, false, 5).unwrap();
    psbt.unsigned_tx.input.push(txin(0xcc));
    psbt.inputs.push(Default::default());
    psbt.inputs[1].witness_utxo = Some(TxOut {
        value: Amount::from_sat(1_000),
        script_pubkey: script_of(&foreign),
    });
    let (w, extra) = warnings_of(&psbt);
    assert!(extra);
    assert_eq!(w, vec![wallet_core::BtcWarning::ForeignInput { input: 1 }]);
}

#[test]
fn btc_high_fee_is_reinforced() {
    let (mut psbt, ..) = segwit_psbt();
    psbt.unsigned_tx.output[1].value = Amount::from_sat(10_000);
    let (w, extra) = warnings_of(&psbt);
    assert!(extra);
    assert!(
        matches!(w.as_slice(), [wallet_core::BtcWarning::HighFee { sat_per_vb }] if *sat_per_vb > 100)
    );
    psbt.unsigned_tx.output[1].value = Amount::from_sat(27_000);
    assert_eq!(warnings_of(&psbt), (vec![], false));
}

#[test]
fn btc_sighash_other_than_all_is_refused_not_just_warned() {
    let (mut psbt, ..) = segwit_psbt();
    psbt.inputs[0].sighash_type = Some(PsbtSighashType::from(
        EcdsaSighashType::SinglePlusAnyoneCanPay,
    ));
    assert!(btc_sign_psbt(&seed(ABANDON), Network::Testnet, 0, &psbt.to_string()).is_err());
}

/// Accounts are separate wallets: a PSBT spending one input of account 0 and one of account 1,
/// with change to account 1.
#[test]
fn psbt_signs_only_the_requested_account() {
    let us = Wallet::new(ABANDON);
    let s = seed(ABANDON);
    let a0 = btc_address(&s, Network::Testnet, BtcKind::Segwit, 0, false, 0).unwrap();
    let a1 = btc_address(&s, Network::Testnet, BtcKind::Segwit, 1, false, 0).unwrap();
    let change1 = btc_address(&s, Network::Testnet, BtcKind::Segwit, 1, true, 0).unwrap();
    let external =
        btc_address(&seed(LEGAL), Network::Testnet, BtcKind::Segwit, 0, false, 0).unwrap();
    let tx = Transaction {
        version: Version::TWO,
        lock_time: LockTime::ZERO,
        input: vec![txin(0xa0), txin(0xa1)],
        output: vec![
            TxOut {
                value: Amount::from_sat(150_000),
                script_pubkey: script_of(&external),
            },
            TxOut {
                value: Amount::from_sat(49_000),
                script_pubkey: script_of(&change1),
            },
        ],
    };
    let mut psbt = Psbt::from_unsigned_tx(tx).unwrap();
    for (i, (addr, p)) in [(&a0, "m/84'/1'/0'/0/0"), (&a1, "m/84'/1'/1'/0/0")]
        .into_iter()
        .enumerate()
    {
        psbt.inputs[i].witness_utxo = Some(TxOut {
            value: Amount::from_sat(100_000),
            script_pubkey: script_of(addr),
        });
        let p = path(p);
        psbt.inputs[i]
            .bip32_derivation
            .insert(us.pubkey(&p), (us.fp, p));
    }
    let pc = path("m/84'/1'/1'/1/0");
    psbt.outputs[1]
        .bip32_derivation
        .insert(us.pubkey(&pc), (us.fp, pc));
    let b64 = psbt.to_string();

    let (signed, summary) = btc_sign_psbt(&s, Network::Testnet, 1, &b64).unwrap();
    assert_eq!(
        summary.warnings,
        vec![wallet_core::BtcWarning::ForeignInput { input: 0 }]
    );
    assert!(summary.requires_extra_confirmation);
    assert!(summary.outputs[1].2, "account 1's change");
    let signed = Psbt::from_str(&signed).unwrap();
    assert!(
        signed.inputs[0].partial_sigs.is_empty(),
        "account 0 untouched"
    );
    assert_eq!(signed.inputs[1].partial_sigs.len(), 1);
    assert_eq!(
        wallet_core::btc_psbt_summary(&s, Network::Testnet, 1, &b64).unwrap(),
        summary
    );

    let (signed0, summary0) = btc_sign_psbt(&s, Network::Testnet, 0, &b64).unwrap();
    assert_eq!(
        summary0.warnings,
        vec![wallet_core::BtcWarning::ForeignInput { input: 1 }]
    );
    assert!(!summary0.outputs[1].2, "not account 0's change");
    let signed0 = Psbt::from_str(&signed0).unwrap();
    assert_eq!(signed0.inputs[0].partial_sigs.len(), 1);
    assert!(signed0.inputs[1].partial_sigs.is_empty());

    assert!(btc_sign_psbt(&s, Network::Testnet, 2, &b64)
        .unwrap_err()
        .to_string()
        .contains("no input"));
    assert!(btc_sign_psbt(&s, Network::Testnet, 1 << 31, &b64).is_err());
}

fn psbt_with_change_at(index: u32) -> (Psbt, String) {
    let us = Wallet::new(ABANDON);
    let s = seed(ABANDON);
    let (mut psbt, ..) = segwit_psbt();
    let change = btc_address(&s, Network::Testnet, BtcKind::Segwit, 0, true, index).unwrap();
    psbt.unsigned_tx.output[1].script_pubkey = script_of(&change);
    let p = path(&format!("m/84'/1'/0'/1/{index}"));
    psbt.outputs[1].bip32_derivation.clear();
    psbt.outputs[1]
        .bip32_derivation
        .insert(us.pubkey(&p), (us.fp, p));
    (psbt, change)
}

/// Audit finding: an output to our key at any index < 2^31 was labelled change, although no
/// wallet scanning with a gap limit would ever see the coins sent there.
#[test]
fn btc_change_beyond_max_index_is_a_reinforced_payment() {
    use wallet_core::{BtcWarning, MAX_CHANGE_INDEX};
    let s = seed(ABANDON);
    let (psbt, change) = psbt_with_change_at(MAX_CHANGE_INDEX);
    let (_, sum) = btc_sign_psbt(&s, Network::Testnet, 0, &psbt.to_string()).unwrap();
    assert_eq!(sum.outputs[1], (change, 39_000, true));
    assert!(!sum.requires_extra_confirmation);
    for index in [MAX_CHANGE_INDEX + 1, 2_000_000_000] {
        let (psbt, change) = psbt_with_change_at(index);
        let (_, sum) = btc_sign_psbt(&s, Network::Testnet, 0, &psbt.to_string()).unwrap();
        assert_eq!(sum.outputs[1], (change, 39_000, false), "{index}");
        let (w, extra) = warnings_of(&psbt);
        assert_eq!(w, vec![BtcWarning::ChangeIndexOutOfRange { output: 1 }]);
        assert!(extra);
    }
}

#[test]
fn btc_witness_v2_output_is_an_unknown_script() {
    use wallet_core::BtcWarning;
    let (mut psbt, ..) = segwit_psbt();
    let mut v2 = vec![0x52, 0x20];
    v2.extend_from_slice(&[7u8; 32]);
    psbt.unsigned_tx.output[0].script_pubkey = ScriptBuf::from_bytes(v2.clone());
    let s = seed(ABANDON);
    let (_, sum) = btc_sign_psbt(&s, Network::Testnet, 0, &psbt.to_string()).unwrap();
    assert_eq!(sum.outputs[0].0, format!("script:{}", hex::encode(&v2)));
    assert_eq!(
        warnings_of(&psbt),
        (vec![BtcWarning::UnknownScript { output: 0 }], true)
    );
    psbt.unsigned_tx.output[0].script_pubkey = ScriptBuf::from_bytes(vec![0x51, 0x02, 0xab, 0xcd]);
    let (w, _) = warnings_of(&psbt);
    assert_eq!(w, vec![BtcWarning::UnknownScript { output: 0 }]);
}
