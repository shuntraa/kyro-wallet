//! BOLT11 decoding, the checks on a provider's swap, and the script-path refund.

use std::str::FromStr;
use std::time::Duration;

use bitcoin::consensus::encode::deserialize_hex;
use bitcoin::hashes::{sha256, Hash};
use bitcoin::key::XOnlyPublicKey;
use bitcoin::secp256k1::{schnorr, Message, PublicKey, Secp256k1, SecretKey};
use bitcoin::sighash::{Prevouts, SighashCache, TapSighashType};
use bitcoin::taproot::{ControlBlock, LeafVersion, TaprootBuilder};
use bitcoin::{Address, Amount, KnownHrp, Script, ScriptBuf, TapLeafHash, Transaction, TxOut};
use lightning_invoice::{Currency, InvoiceBuilder, PaymentSecret};
use serde_json::Value;
use wallet_core::{
    btc_address, ln_check_swap, ln_decode_invoice, ln_open_state, ln_refund_public_key,
    ln_refund_tx, ln_seal_state, BtcKind, LnInvoice, LnLockedCoin, LnSwapTerms, Mnemonic, Network,
    Seed, WordCount,
};

const SPEC_NO_AMOUNT: &str = include_str!("data/bolt11-no-amount.txt");
const SPEC_2500U: &str = include_str!("data/bolt11-2500u.txt");
const SPEC_TESTNET: &str = include_str!("data/bolt11-testnet.txt");
/// When the BOLT 11 examples were signed.
const SPEC_TIME: u64 = 1_496_314_658;
const OTHER_P2TR: &str = "bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr";

fn seed() -> Seed {
    Mnemonic::parse(
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    )
    .unwrap()
    .to_seed("")
}

fn invoice(msat: u64, description: &str) -> String {
    let secp = Secp256k1::new();
    let key = SecretKey::from_slice(&[0x41; 32]).unwrap();
    InvoiceBuilder::new(Currency::Bitcoin)
        .description(description.into())
        .payment_hash(sha256::Hash::from_byte_array([1; 32]))
        .payment_secret(PaymentSecret([7; 32]))
        .duration_since_epoch(Duration::from_secs(SPEC_TIME))
        .min_final_cltv_expiry_delta(144)
        .expiry_time(Duration::from_secs(7_200))
        .amount_milli_satoshis(msat)
        .build_signed(|m| secp.sign_ecdsa_recoverable(m, &key))
        .unwrap()
        .to_string()
}

#[test]
fn spec_vector_decodes() {
    let i = ln_decode_invoice(SPEC_2500U.trim(), Network::Mainnet, SPEC_TIME).unwrap();
    assert_eq!(i.amount_msat, 250_000_000);
    assert_eq!(i.amount_sat, 250_000);
    assert_eq!(
        i.payment_hash,
        "0001020304050607080900010203040506070809000102030405060708090102"
    );
    assert_eq!(
        i.payee,
        "03e7156ae33b0a208d0744199163177e909e80176e55d97a2f221ede0f934dd9ad"
    );
    assert_eq!(i.description.as_deref(), Some("1 cup coffee"));
    assert_eq!(i.expires_at, SPEC_TIME + 60);
}

#[test]
fn accepts_uppercase_and_uri_prefix() {
    let t = SPEC_2500U.trim();
    let upper = format!("LIGHTNING:{}", t.to_uppercase());
    let i = ln_decode_invoice(&upper, Network::Mainnet, SPEC_TIME).unwrap();
    assert_eq!(i.invoice, t);
}

#[test]
fn refuses_what_cannot_be_paid() {
    let err = |t: &str, n, now| ln_decode_invoice(t, n, now).unwrap_err().to_string();
    assert!(err(SPEC_NO_AMOUNT.trim(), Network::Mainnet, SPEC_TIME).contains("no amount"));
    assert!(err(SPEC_2500U.trim(), Network::Mainnet, SPEC_TIME + 60).contains("expired"));
    assert!(err(SPEC_TESTNET.trim(), Network::Mainnet, SPEC_TIME).contains("another network"));
    assert!(err(SPEC_2500U.trim(), Network::Testnet, SPEC_TIME).contains("another network"));
    assert!(err(OTHER_P2TR, Network::Mainnet, 0).contains("valid"));
    assert!(err("", Network::Mainnet, 0).contains("not a Lightning"));
    assert!(err(&"lnbc1".repeat(1_000), Network::Mainnet, 0).contains("not a Lightning"));
    // One changed character: the checksum fails.
    let t = SPEC_2500U.trim().replacen("zyg3", "zyg4", 1);
    assert!(err(&t, Network::Mainnet, SPEC_TIME).contains("valid"));
}

#[test]
fn rounds_millisatoshis_up() {
    let t = invoice(100_000_001, "coffee");
    let i = ln_decode_invoice(&t, Network::Mainnet, SPEC_TIME).unwrap();
    assert_eq!(i.amount_sat, 100_001);
}

#[test]
fn sanitizes_the_description() {
    let t = invoice(1_000_000, "To: bc1q\u{202e}evil\nline");
    let i = ln_decode_invoice(&t, Network::Mainnet, SPEC_TIME).unwrap();
    let d = i.description.unwrap();
    assert!(!d.contains('\n') && !d.contains('\u{202e}'));
}

struct Live {
    invoice: LnInvoice,
    terms: LnSwapTerms,
    refund: String,
    tip: u64,
    now: u64,
}

fn live() -> Vec<Live> {
    let v: Value = serde_json::from_str(include_str!("data/lightning-swaps.json")).unwrap();
    let tip = v["tipHeight"].as_u64().unwrap();
    let text = |x: &Value| x.as_str().unwrap().to_owned();
    v["swaps"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| {
            let r = &s["response"];
            let invoice = ln_decode_invoice(&text(&s["invoice"]), Network::Mainnet, 0).unwrap();
            let now = invoice.created_at;
            Live {
                invoice,
                terms: LnSwapTerms {
                    id: text(&r["id"]),
                    address: text(&r["address"]),
                    expected_amount: r["expectedAmount"].as_u64().unwrap(),
                    claim_public_key: text(&r["claimPublicKey"]),
                    claim_leaf: text(&r["swapTree"]["claimLeaf"]["output"]),
                    refund_leaf: text(&r["swapTree"]["refundLeaf"]["output"]),
                    timeout_block_height: r["timeoutBlockHeight"].as_u64().unwrap(),
                },
                refund: text(&s["refundPublicKey"]),
                tip,
                now,
            }
        })
        .collect()
}

fn check(l: &Live, t: &LnSwapTerms) -> Result<u64, String> {
    ln_check_swap(&l.invoice, t, &l.refund, Network::Mainnet, l.tip, l.now)
        .map(|c| c.provider_fee_sat)
        .map_err(|e| e.to_string())
}

#[test]
fn accepts_the_real_answers() {
    let l = live();
    assert_eq!(check(&l[0], &l[0].terms).unwrap(), 402);
    assert_eq!(check(&l[1], &l[1].terms).unwrap(), 667);
}

#[test]
fn refuses_tampered_terms() {
    for l in live() {
        let t = &l.terms;
        let mut x = t.clone();
        x.address = OTHER_P2TR.into();
        assert!(check(&l, &x).unwrap_err().contains("deposit address"));

        // Another payment hash in the claim leaf.
        let mut x = t.clone();
        x.claim_leaf = x.claim_leaf.replacen("a914", "a915", 1);
        assert!(check(&l, &x).unwrap_err().contains("claim script"));

        // A refund to another key.
        let mut x = t.clone();
        x.refund_leaf = x.refund_leaf.replacen("20a5", "20a6", 1);
        assert!(check(&l, &x).unwrap_err().contains("refund script"));

        // The claim key changed: the leaf no longer matches it.
        let mut x = t.clone();
        x.claim_public_key =
            "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798".into();
        assert!(check(&l, &x).unwrap_err().contains("claim script"));

        let mut x = t.clone();
        x.timeout_block_height = l.tip + 143;
        assert!(check(&l, &x).unwrap_err().contains("timeout"));
        x.timeout_block_height = l.tip + 1_441;
        assert!(check(&l, &x).unwrap_err().contains("timeout"));

        let mut x = t.clone();
        x.expected_amount = l.invoice.amount_sat;
        assert!(check(&l, &x).unwrap_err().contains("below"));
        x.expected_amount = l.invoice.amount_sat + l.invoice.amount_sat * 3 / 100 + 3_001;
        assert!(check(&l, &x).unwrap_err().contains("too high"));

        let mut x = t.clone();
        x.id = "../../etc".into();
        assert!(check(&l, &x).unwrap_err().contains("id"));
    }
}

#[test]
fn refuses_a_swap_for_another_invoice() {
    let l = live();
    let mut other = l[0].invoice.clone();
    other.payment_hash = "11".repeat(32);
    let e = ln_check_swap(
        &other,
        &l[0].terms,
        &l[0].refund,
        Network::Mainnet,
        l[0].tip,
        l[0].now,
    );
    assert!(e.unwrap_err().to_string().contains("claim script"));
}

#[test]
fn refuses_a_key_that_is_not_ours() {
    let l = live();
    let other = ln_refund_public_key(&seed(), Network::Mainnet, 0).unwrap();
    let e = ln_check_swap(
        &l[0].invoice,
        &l[0].terms,
        &other,
        Network::Mainnet,
        l[0].tip,
        l[0].now,
    );
    assert!(e.unwrap_err().to_string().contains("refund script"));
}

#[test]
fn refuses_an_invoice_too_close_to_expiry() {
    let l = live();
    let mut i = l[0].invoice.clone();
    let now = l[0].now;
    let at = |i: &LnInvoice| {
        ln_check_swap(
            i,
            &l[0].terms,
            &l[0].refund,
            Network::Mainnet,
            l[0].tip,
            now,
        )
    };
    i.expires_at = now + 3_599;
    assert!(at(&i).unwrap_err().to_string().contains("expires too soon"));
    i.expires_at = now + 3_600;
    assert!(at(&i).is_ok());
}

#[test]
fn state_round_trip_and_tamper() {
    let s = seed();
    let sealed = ln_seal_state(&s, Network::Mainnet, b"swaps").unwrap();
    assert_eq!(
        &ln_open_state(&s, Network::Mainnet, &sealed).unwrap()[..],
        b"swaps"
    );
    let mut bad = sealed.clone();
    let last = bad.len() - 1;
    bad[last] ^= 1;
    assert!(ln_open_state(&s, Network::Mainnet, &bad).is_err());
    assert!(ln_open_state(&s, Network::Testnet, &sealed).is_err());
    let other = Mnemonic::generate(WordCount::W12).unwrap().to_seed("");
    assert!(ln_open_state(&other, Network::Mainnet, &sealed).is_err());
    assert!(ln_open_state(&s, Network::Mainnet, &sealed[..10]).is_err());
}

fn lockup_address(t: &LnSwapTerms, refund: &str) -> String {
    let point = |h: &str| {
        let k = PublicKey::from_slice(&hex::decode(h).unwrap()).unwrap();
        musig2::secp::Point::try_from(k.serialize().as_slice()).unwrap()
    };
    let agg = musig2::KeyAggContext::new([point(&t.claim_public_key), point(refund)]).unwrap();
    let a: musig2::secp::Point = agg.aggregated_pubkey();
    let internal = XOnlyPublicKey::from_slice(&a.serialize_xonly()).unwrap();
    let leaf = |h: &str| ScriptBuf::from_bytes(hex::decode(h).unwrap());
    let info = TaprootBuilder::new()
        .add_leaf(1, leaf(&t.claim_leaf))
        .unwrap()
        .add_leaf(1, leaf(&t.refund_leaf))
        .unwrap()
        .finalize(&Secp256k1::new(), internal)
        .unwrap();
    Address::p2tr_tweaked(info.output_key(), KnownHrp::Mainnet).to_string()
}

/// A real answer's terms with our own refund key in place of the throwaway one.
fn own_terms(s: &Seed, index: u32) -> LnSwapTerms {
    let lives = live();
    let l = &lives[0];
    let refund = ln_refund_public_key(s, Network::Mainnet, index).unwrap();
    let mut t = l.terms.clone();
    t.refund_leaf = t.refund_leaf.replacen(&l.refund[2..], &refund[2..], 1);
    t.address = lockup_address(&t, &refund);
    t
}

fn coin() -> LnLockedCoin {
    LnLockedCoin {
        txid: "11".repeat(32),
        vout: 1,
        value: 100_402,
    }
}

#[test]
fn refund_spends_the_refund_leaf() {
    let s = seed();
    let t = own_terms(&s, 3);
    let timeout = t.timeout_block_height;
    let dest = btc_address(&s, Network::Mainnet, BtcKind::Segwit, 0, false, 0).unwrap();
    let r = ln_refund_tx(&s, Network::Mainnet, &t, 3, &[coin()], &dest, 2, timeout).unwrap();
    assert_eq!(r.amount_sat + r.fee_sat, 100_402);
    assert_eq!(r.fee_sat, r.vsize * 2);
    let tx: Transaction = deserialize_hex(&r.hex).unwrap();
    assert_eq!(u64::from(tx.lock_time.to_consensus_u32()), timeout);
    assert!(tx.input[0].sequence.is_rbf());
    assert!(tx.input[0].sequence.enables_absolute_lock_time());
    assert_eq!(tx.output.len(), 1);
    let w: Vec<&[u8]> = tx.input[0].witness.iter().collect();
    assert_eq!(w.len(), 3);
    assert_eq!(w[0].len(), 64);
    assert_eq!(hex::encode(w[1]), t.refund_leaf);

    // The control block proves the leaf is committed to by the lockup output.
    let secp = Secp256k1::new();
    let control = ControlBlock::decode(w[2]).unwrap();
    let lockup = Address::from_str(&t.address).unwrap().assume_checked();
    let spk = lockup.script_pubkey();
    let out = XOnlyPublicKey::from_slice(&spk.as_bytes()[2..]).unwrap();
    assert!(control.verify_taproot_commitment(&secp, out, Script::from_bytes(w[1])));

    // The signature is the refund key's, over the script-path sighash.
    let prev = [TxOut {
        value: Amount::from_sat(100_402),
        script_pubkey: spk,
    }];
    let leaf = TapLeafHash::from_script(Script::from_bytes(w[1]), LeafVersion::TapScript);
    let h = SighashCache::new(&tx)
        .taproot_script_spend_signature_hash(
            0,
            &Prevouts::All(&prev),
            leaf,
            TapSighashType::Default,
        )
        .unwrap();
    let msg = Message::from_digest(h.to_byte_array());
    let sig = schnorr::Signature::from_slice(w[0]).unwrap();
    let pk = ln_refund_public_key(&s, Network::Mainnet, 3).unwrap();
    let x = XOnlyPublicKey::from_slice(&hex::decode(&pk[2..]).unwrap()).unwrap();
    secp.verify_schnorr(&sig, &msg, &x).unwrap();
}

#[test]
fn refund_refusals() {
    let s = seed();
    let t = own_terms(&s, 3);
    let timeout = t.timeout_block_height;
    let dest = btc_address(&s, Network::Mainnet, BtcKind::Segwit, 0, false, 0).unwrap();
    let e = |terms: &LnSwapTerms, idx, coins: &[LnLockedCoin], d: &str, rate, tip| {
        ln_refund_tx(&s, Network::Mainnet, terms, idx, coins, d, rate, tip)
            .unwrap_err()
            .to_string()
    };
    assert!(e(&t, 3, &[coin()], &dest, 2, timeout - 1).contains("not passed"));
    assert!(e(&t, 3, &[], &dest, 2, timeout).contains("no coin"));
    assert!(e(&t, 3, &[coin()], &dest, 0, timeout).contains("fee rate"));
    assert!(e(&t, 3, &[coin()], &dest, 501, timeout).contains("fee rate"));
    assert!(e(&t, 4, &[coin()], &dest, 2, timeout).contains("refund key"));
    let small = LnLockedCoin {
        value: 700,
        ..coin()
    };
    assert!(e(&t, 3, &[small], &dest, 5, timeout).contains("network fee"));
    let testnet = "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx";
    assert!(e(&t, 3, &[coin()], testnet, 2, timeout).contains("another network"));
    let mut bad = t.clone();
    bad.address = OTHER_P2TR.into();
    assert!(e(&bad, 3, &[coin()], &dest, 2, timeout).contains("do not match"));
}
