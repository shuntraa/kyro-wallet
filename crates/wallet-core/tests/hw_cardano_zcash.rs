//! Hardware wallets, device-independent part, Cardano and Zcash: keys of a watch-only account,
//! the data the device is given, and the independent check of what it returns (a wrong
//! signature, body hash or key must always be rejected).
//!
//! "Device" signatures are made here with the software keys of the same seed (exactly what an
//! honest device returns: Ed25519 and RFC 6979 ECDSA are deterministic), then tampered with.
//! Trezor's Cardano vector (`tests/fixtures/cardano/sign_tx.json`, "simple transaction with
//! change", ICARUS derivation of `all all … all`) pins the body hash and the signature.

mod common;

use bitcoin::bip32::{DerivationPath, Xpriv};
use bitcoin::secp256k1::{Message, Secp256k1};
use bitcoin::NetworkKind;
use common::{seed, ABANDON, LEGAL};
use std::str::FromStr;
use wallet_core::{
    cardano_account_path, cardano_account_xpub, cardano_address, cardano_address_bytes,
    cardano_address_from_xpub, cardano_hw_assemble, cardano_hw_plan, cardano_payment_public_key,
    cardano_sign, cardano_stake_public_key, cardano_unsigned_tx, cardano_xpub_child, zec_account,
    zec_address, zec_hw_finalize, zec_hw_plan, zec_input_sighash, zec_parse_address, zec_sign,
    CardanoBody, CardanoContext, CardanoHwDestination, CardanoInput, CardanoOutput, CardanoRoot,
    HwDeviceKind, Mnemonic, Network, WatchKey, WatchOnlyAccount, ZecCoin, ZecSendRequest,
};

const ALL: &str = "all all all all all all all all all all all all";
const TZ_PREV: &str = "3b40265111d8bb3c3c608d95b3a0bf83461ace32d79336579a1939b3aad1c0b7";
const TZ_DEST: &str = "addr1q84sh2j72ux0l03fxndjnhctdg7hcppsaejafsa84vh7lwgmcs5wgus8qt4atk45lvt4xfxpjtwfhdmvchdf2m3u3hlsd5tq5r";

fn root(phrase: &str) -> CardanoRoot {
    CardanoRoot::from_mnemonic(&Mnemonic::parse(phrase).unwrap(), "")
}

fn h32(s: &str) -> [u8; 32] {
    hex::decode(s).unwrap().try_into().unwrap()
}

#[test]
fn cardano_public_derivation_matches_the_private_one() {
    for (phrase, account) in [(ALL, 0), (ABANDON, 3)] {
        let r = root(phrase);
        let xpub = cardano_account_xpub(&r, account).unwrap();
        assert_eq!(
            cardano_xpub_child(&xpub, 0, 0).unwrap(),
            cardano_payment_public_key(&r, account, 0).unwrap()
        );
        assert_eq!(
            cardano_xpub_child(&xpub, 2, 0).unwrap(),
            cardano_stake_public_key(&r, account).unwrap()
        );
        for net in [Network::Mainnet, Network::Testnet] {
            assert_eq!(
                cardano_address_from_xpub(&xpub, net, 0).unwrap(),
                cardano_address(&r, net, account, 0).unwrap()
            );
        }
    }
    let xpub = cardano_account_xpub(&root(ALL), 0).unwrap();
    assert!(cardano_xpub_child(&xpub, 0x8000_0000, 0).is_err());
    assert!(cardano_xpub_child(&xpub[..126], 0, 0).is_err());
}

fn cardano_watch(phrase: &str, net: Network) -> WatchOnlyAccount {
    let r = root(phrase);
    let xpub = cardano_account_xpub(&r, 0).unwrap();
    WatchOnlyAccount {
        id: "hw-00000000000000cd".into(),
        label: "Ledger".into(),
        device: HwDeviceKind::Ledger,
        model: "Nano X".into(),
        network: net,
        account: 0,
        btc: vec![],
        evm: None,
        sol: None,
        utxo: vec![],
        xrp: None,
        tron: None,
        stellar: None,
        cardano: Some(WatchKey {
            address: cardano_address_from_xpub(&xpub, net, 0).unwrap(),
            pubkey: xpub,
            path: cardano_account_path(0),
        }),
        zec: None,
    }
}

#[test]
fn watch_only_cardano_and_zcash_are_validated() {
    let acc = cardano_watch(ALL, Network::Mainnet);
    acc.validate().unwrap();
    let bad = |f: &dyn Fn(&mut WatchOnlyAccount)| {
        let mut a = cardano_watch(ALL, Network::Mainnet);
        f(&mut a);
        a.validate().is_err()
    };
    assert!(bad(
        &|a| a.cardano.as_mut().unwrap().path = cardano_account_path(1)
    ));
    assert!(bad(&|a| a.cardano.as_mut().unwrap().address =
        cardano_address(&root(ABANDON), Network::Mainnet, 0, 0)
            .unwrap()));
    assert!(bad(&|a| a.cardano.as_mut().unwrap().pubkey.truncate(64)));
    // Testnet address for a mainnet record.
    assert!(bad(&|a| a.network = Network::Testnet));

    let s = seed(ABANDON);
    let mut z = cardano_watch(ALL, Network::Mainnet);
    z.cardano = None;
    z.zec = Some(zec_account(&s, Network::Mainnet, 0).unwrap());
    z.validate().unwrap();
    assert_eq!(z.fingerprint(), Some("73c5da0a"));
    let mut w = z.clone();
    w.zec = Some(zec_account(&s, Network::Mainnet, 1).unwrap());
    assert!(w.validate().is_err()); // other account number
    let mut w = z.clone();
    w.zec = Some(zec_account(&s, Network::Testnet, 0).unwrap());
    assert!(w.validate().is_err()); // other network
    let mut w = z.clone();
    w.zec.as_mut().unwrap().fingerprint = "00000000".into();
    w.btc = vec![];
    w.validate().unwrap(); // its own fingerprint when alone…
    w.utxo = vec![
        wallet_core::utxo_account(&s, Network::Mainnet, wallet_core::UtxoCoin::Dash, 0).unwrap(),
    ];
    assert!(w.validate().is_err()); // …but not another device's
}

/// Trezor's "simple transaction with change": the body the device is given is Kyro's, the
/// witness of an honest device is accepted, and every tampering is refused.
#[test]
fn cardano_device_witness_is_checked_before_assembly() {
    let r = root(ALL);
    let xpub = cardano_account_xpub(&r, 0).unwrap();
    let own = cardano_address_from_xpub(&xpub, Network::Mainnet, 0).unwrap();
    let own_b = cardano_address_bytes(&own, Network::Mainnet).unwrap();
    let body = CardanoBody {
        inputs: vec![CardanoInput {
            tx_hash: h32(TZ_PREV),
            index: 0,
        }],
        tagged_sets: false,
        outputs: vec![
            CardanoOutput {
                address: cardano_address_bytes(TZ_DEST, Network::Mainnet).unwrap(),
                coin: 1,
                assets: vec![],
                map_form: false,
            },
            CardanoOutput {
                address: own_b.clone(),
                coin: 7_120_787,
                assets: vec![],
                map_form: false,
            },
        ],
        fee: 42,
        ttl: Some(10),
        certs: vec![],
        withdrawals: vec![],
        aux_hash: None,
        validity_start: None,
    };
    let unsigned = hex::encode(cardano_unsigned_tx(&body, None).unwrap());
    let owns = [own.clone()];
    let ctx = CardanoContext {
        net: Network::Mainnet,
        own: &owns,
        verified_tokens: &[],
        coins_per_byte: 0,
    };
    let plan = cardano_hw_plan(&unsigned, &ctx, &own_b).unwrap();
    let id = "16fe72bb198be423677577e6326f1f648ec5fc11263b072006382d8125a6edda";
    assert_eq!(hex::encode(plan.tx_id), id);
    assert_eq!(plan.outputs.len(), 2);
    assert!(matches!(
        plan.outputs[0].destination,
        CardanoHwDestination::Address(_)
    ));
    assert_eq!(plan.outputs[1].destination, CardanoHwDestination::Own);
    assert_eq!((plan.fee, plan.ttl, plan.aux_hash), (42, Some(10), None));

    // Trezor's recorded signature for that body and key.
    let sig = hex::decode("6a78f07836dcf4a303448d2b16b217265a9226be3984a69a04dba5d04f4dbb2a47b5e1cbb345f474c0b9634a2f37b921ab26e6a65d5dfd015dacb4455fb8430a").unwrap();
    let pk = cardano_xpub_child(&xpub, 0, 0).unwrap();
    let (signed, tx_id, summary) =
        cardano_hw_assemble(&unsigned, &ctx, &pk, &plan.tx_id, &sig).unwrap();
    let (soft, soft_id, soft_summary) = cardano_sign(&r, 0, 0, &unsigned, &ctx).unwrap();
    assert_eq!(
        (signed, tx_id.as_str(), summary),
        (soft, soft_id.as_str(), soft_summary)
    );
    assert_eq!(tx_id, id);

    // Another body hash (the device serialized something else), another key, a bad signature.
    let mut other = plan.tx_id;
    other[0] ^= 1;
    assert!(cardano_hw_assemble(&unsigned, &ctx, &pk, &other, &sig).is_err());
    let other_pk =
        cardano_xpub_child(&cardano_account_xpub(&root(ABANDON), 0).unwrap(), 0, 0).unwrap();
    assert!(cardano_hw_assemble(&unsigned, &ctx, &other_pk, &plan.tx_id, &sig).is_err());
    let mut bad = sig.clone();
    bad[10] ^= 0x40;
    assert!(cardano_hw_assemble(&unsigned, &ctx, &pk, &plan.tx_id, &bad).is_err());
    assert!(cardano_hw_assemble(&unsigned, &ctx, &pk, &plan.tx_id, &sig[..63]).is_err());
}

// ------------------------------------------------------------------------------------------
// Zcash (v5, transparent)
// ------------------------------------------------------------------------------------------

const MAIN: Network = Network::Mainnet;
const NU6_3: u32 = 0x37a5_165b;
const TIP: u32 = 3_537_784;
const DEST: &str = "t1VmmGiyjVNeCjxDZzg7vZmd99WyzVby9yC";

fn fake_prev(value: u64, script: &[u8], salt: u8) -> String {
    let mut b = Vec::new();
    b.extend_from_slice(&0x8000_0005u32.to_le_bytes());
    b.extend_from_slice(&0x26a7_270au32.to_le_bytes());
    b.extend_from_slice(&NU6_3.to_le_bytes());
    b.extend_from_slice(&0u32.to_le_bytes());
    b.extend_from_slice(&0u32.to_le_bytes());
    b.push(1);
    b.extend_from_slice(&[salt; 32]);
    b.extend_from_slice(&0u32.to_le_bytes());
    b.push(0);
    b.extend_from_slice(&u32::MAX.to_le_bytes());
    b.push(1);
    b.extend_from_slice(&value.to_le_bytes());
    b.push(u8::try_from(script.len()).unwrap());
    b.extend_from_slice(script);
    b.extend_from_slice(&[0, 0, 0]);
    hex::encode(b)
}

fn coin(value: u64, salt: u8, change: bool, index: u32) -> ZecCoin {
    let a = zec_address(&seed(ABANDON), MAIN, 0, change, index).unwrap();
    ZecCoin {
        prev_tx: fake_prev(value, &zec_parse_address(&a, MAIN).unwrap().0, salt),
        vout: 0,
        change,
        index,
    }
}

fn request(coins: Vec<ZecCoin>, amount: u64) -> ZecSendRequest {
    ZecSendRequest {
        coins,
        to: DEST.into(),
        amount,
        max: false,
        change_index: 2,
        tip_height: TIP,
        network_branch_height: TIP,
        network_branch_id: NU6_3,
    }
}

fn device_sign(phrase: &str, path: &[u32], digest: &[u8; 32]) -> Vec<u8> {
    let secp = Secp256k1::new();
    let master = Xpriv::new_master(NetworkKind::Main, &seed(phrase)[..]).unwrap();
    let p = DerivationPath::from(
        path.iter()
            .map(|i| bitcoin::bip32::ChildNumber::from(*i))
            .collect::<Vec<_>>(),
    );
    let k = master.derive_priv(&secp, &p).unwrap();
    secp.sign_ecdsa(&Message::from_digest(*digest), &k.private_key)
        .serialize_der()
        .to_vec()
}

#[test]
fn zcash_device_signatures_are_checked_before_assembly() {
    let acc = zec_account(&seed(ABANDON), MAIN, 0).unwrap();
    // Two inputs needed: 3 + 2 ZEC for 4 ZEC.
    let req = request(
        vec![
            coin(300_000_000, 1, false, 0),
            coin(200_000_000, 2, true, 1),
        ],
        400_000_000,
    );
    let plan = zec_hw_plan(&acc, MAIN, &req).unwrap();
    assert_eq!(plan.inputs.len(), 2);
    assert_eq!(plan.branch_id, NU6_3);
    assert_eq!(plan.lock_time, 0);
    assert_eq!(
        plan.inputs[0].path,
        vec![0x8000_002c, 0x8000_0085, 0x8000_0000, 0, 0]
    );
    assert_eq!(
        plan.inputs[1].path,
        vec![0x8000_002c, 0x8000_0085, 0x8000_0000, 1, 1]
    );
    assert_eq!(plan.inputs[0].amount, 300_000_000);
    assert_eq!(plan.outputs[0].address, DEST);
    assert_eq!(plan.outputs[0].change_path, None);
    assert_eq!(
        plan.outputs[1].change_path,
        Some(vec![0x8000_002c, 0x8000_0085, 0x8000_0000, 1, 2])
    );
    assert_eq!(
        plan.outputs[1].address,
        zec_address(&seed(ABANDON), MAIN, 0, true, 2).unwrap()
    );

    let sigs: Vec<Vec<u8>> = plan
        .inputs
        .iter()
        .zip(&plan.digests)
        .map(|(i, d)| device_sign(ABANDON, &i.path, d))
        .collect();
    let (signed, summary) = zec_hw_finalize(&acc, MAIN, &req, &sigs).unwrap();
    let (soft, soft_summary) = zec_sign(&seed(ABANDON), MAIN, 0, &req).unwrap();
    assert_eq!((&signed, &summary), (&soft, &soft_summary));
    assert_eq!(summary, plan.summary);
    // The digests are ZIP-244's, as recomputed from the signed transaction.
    let prevouts: Vec<(u64, Vec<u8>)> = plan
        .inputs
        .iter()
        .map(|i| {
            let a = zec_address(&seed(ABANDON), MAIN, 0, i.path[3] == 1, i.path[4]).unwrap();
            (i.amount, zec_parse_address(&a, MAIN).unwrap().0)
        })
        .collect();
    for (k, d) in plan.digests.iter().enumerate() {
        assert_eq!(&zec_input_sighash(&signed, &prevouts, k).unwrap(), d);
    }
    // With the SIGHASH_ALL byte appended (as some devices return it): same result.
    let with_type: Vec<Vec<u8>> = sigs.iter().map(|s| [s.as_slice(), &[1]].concat()).collect();
    assert_eq!(
        zec_hw_finalize(&acc, MAIN, &req, &with_type).unwrap().0,
        signed
    );

    // Signatures swapped, by another seed, missing, or corrupted: refused.
    let swapped = vec![sigs[1].clone(), sigs[0].clone()];
    assert!(zec_hw_finalize(&acc, MAIN, &req, &swapped).is_err());
    let other: Vec<Vec<u8>> = plan
        .inputs
        .iter()
        .zip(&plan.digests)
        .map(|(i, d)| device_sign(LEGAL, &i.path, d))
        .collect();
    assert!(zec_hw_finalize(&acc, MAIN, &req, &other).is_err());
    assert!(zec_hw_finalize(&acc, MAIN, &req, &sigs[..1]).is_err());
    let mut bad = sigs.clone();
    bad[0][8] ^= 1;
    assert!(zec_hw_finalize(&acc, MAIN, &req, &bad).is_err());
    // A testnet xpub for a mainnet transaction.
    let t = zec_account(&seed(ABANDON), Network::Testnet, 0).unwrap();
    assert!(zec_hw_plan(&t, MAIN, &req).is_err());
    assert!(bitcoin::bip32::Xpub::from_str(&acc.xpub).is_ok());
}
