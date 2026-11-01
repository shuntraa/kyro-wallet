//! Monero vectors.

mod common;

use std::future::Future;
use std::ops::RangeBounds;
use std::pin::pin;
use std::task::{Context, Poll, Waker};

use common::{seed, ABANDON};
use wallet_core::monero_wallet::address::{MoneroAddress, Network as XNet, SubaddressIndex};
use wallet_core::monero_wallet::ed25519::{Point, Scalar};
use wallet_core::monero_wallet::interface::{
    EvaluateUnlocked, FeeRate, InterfaceError, ProvidesBlockchainMeta, ProvidesUnvalidatedDecoys,
    TransactionsError,
};
use wallet_core::monero_wallet::transaction::{Input, Pruned, Transaction};
use wallet_core::monero_wallet::{GuaranteedViewPair, OutputWithDecoys, WalletOutput};
use wallet_core::{
    xmr_address, xmr_addresses, xmr_build, xmr_cache_open, xmr_cache_seal, xmr_key_images,
    xmr_parse_address, xmr_path, xmr_public_keys, xmr_seed_words, xmr_sign, xmr_tx_fee,
    xmr_view_pair, xmr_words_to_key, Network, XmrAddressKind, XmrWarning, XMR_RING_LEN,
};

const A0_MAIN: &str = "49vDbkSo7eve3J41sBdjvjaBUyz8qHohsQcGtRf63qEUTMBvmA45fpp5pSacMdSg7A3b71RejLzB8EkGbfjp5PELVF2N4Zn";
const A0_STAGE: &str = "5A8FgbMkmG2e3J41sBdjvjaBUyz8qHohsQcGtRf63qEUTMBvmA45fpp5pSacMdSg7A3b71RejLzB8EkGbfjp5PELVHCRUaE";
const A0_SUB1_MAIN: &str = "8AB7PQPtducdkghYFN2prK3rZ7zPeL9f2REEdqE4WXYbSZr3797Aqti5xAjRsVy4jTdcwMW11GWejQtqk2kNXxj2QZxJwPZ";
const A0_SUB1_STAGE: &str = "79y5JZUvzJWdkghYFN2prK3rZ7zPeL9f2REEdqE4WXYbSZr3797Aqti5xAjRsVy4jTdcwMW11GWejQtqk2kNXxj2QWJ9bkP";
const A0_SUB2_MAIN: &str = "8696JpJ6Yvw8VtJqpQ7V8gNLBdgwLK5xYLQPfE7DpzdQGo4gKPWMJSubTt8rvvTrWagePa2q1P3k3TvRkGiHZGGUL1cuAwo";
const A0_SUB2_STAGE: &str = "75w4DyP8uKq8VtJqpQ7V8gNLBdgwLK5xYLQPfE7DpzdQGo4gKPWMJSubTt8rvvTrWagePa2q1P3k3TvRkGiHZGGUKzpnHb6";
const A0_WORDS: &str = "tavern judge beyond bifocals deepest mural onward dummy eagle diode gained vacation rally cause firm idled jerseys moat vigilant upload bobsled jobs cunning doing jobs";
const A0_SPEND: &str = "3b094ca7218f175e91fa2402b4ae239a2fe8262792a3e718533a1a357a1e4109";
const A1_MAIN: &str = "43Fg836idZj8vopbDfcjx1Uf65B8Ai7i9TaQEzZm2xskJb3rJoboUSWAvGAfbYLkqi9NTRJXoApfYjmmEwowmHSyH7EKQo9";
const A1_STAGE: &str = "53TiCt1gHAq8vopbDfcjx1Uf65B8Ai7i9TaQEzZm2xskJb3rJoboUSWAvGAfbYLkqi9NTRJXoApfYjmmEwowmHSyH5wa8ek";
const A1_SUB1_MAIN: &str = "8C6hBobq7eUGgr4dajXZtVgP1mB8TpGZ3dMpCJ2s9mp4D1JVynYam4T5m3Hd9SrXf6ULQEm67zpGGhWfyNwV4ZQqDVXEMoP";
const A1_WORDS: &str = "keep depth salads jukebox fowls fuming incur vague rally jittery arises weird heels hire knuckle dogs origin utmost bounced gymnast language oxidant smelting stunning bounced";

#[test]
fn bip39_to_monero_matches_the_independent_reference() {
    let s = seed(ABANDON);
    assert_eq!(xmr_path(0), "m/44'/128'/0'/0/0");
    assert_eq!(xmr_path(3), "m/44'/128'/3'/0/0");
    assert_eq!(xmr_address(&s, Network::Mainnet, 0, 0).unwrap(), A0_MAIN);
    assert_eq!(xmr_address(&s, Network::Testnet, 0, 0).unwrap(), A0_STAGE);
    assert_eq!(
        xmr_address(&s, Network::Mainnet, 0, 1).unwrap(),
        A0_SUB1_MAIN
    );
    assert_eq!(
        xmr_address(&s, Network::Testnet, 0, 1).unwrap(),
        A0_SUB1_STAGE
    );
    assert_eq!(
        xmr_address(&s, Network::Mainnet, 0, 2).unwrap(),
        A0_SUB2_MAIN
    );
    assert_eq!(
        xmr_address(&s, Network::Testnet, 0, 2).unwrap(),
        A0_SUB2_STAGE
    );
    assert_eq!(xmr_address(&s, Network::Mainnet, 1, 0).unwrap(), A1_MAIN);
    assert_eq!(xmr_address(&s, Network::Testnet, 1, 0).unwrap(), A1_STAGE);
    assert_eq!(
        xmr_address(&s, Network::Mainnet, 1, 1).unwrap(),
        A1_SUB1_MAIN
    );
    assert_eq!(
        xmr_addresses(&s, Network::Mainnet, 0, 0..=2).unwrap(),
        vec![A0_MAIN, A0_SUB1_MAIN, A0_SUB2_MAIN]
    );
    assert_eq!(xmr_seed_words(&s, 0).unwrap().join(" "), A0_WORDS);
    assert_eq!(xmr_seed_words(&s, 1).unwrap().join(" "), A1_WORDS);
    assert_eq!(hex::encode(*xmr_words_to_key(A0_WORDS).unwrap()), A0_SPEND);
    let (spend_pub, view_pub) = xmr_public_keys(&s, 0).unwrap();
    let a = MoneroAddress::from_str(XNet::Mainnet, A0_MAIN).unwrap();
    assert_eq!(spend_pub, hex::encode(a.spend().compress().to_bytes()));
    assert_eq!(view_pub, hex::encode(a.view().compress().to_bytes()));
    assert!(xmr_address(&s, Network::Mainnet, 0, 100_001).is_err());
}

#[test]
fn official_english_seed_vectors() {
    for (words, spend) in [
        (
            "washing thirsty occur lectures tuesday fainted toxic adapt abnormal memoir nylon mostly building shrugged online ember northern ruby woes dauntless boil family illness inroads northern",
            "c0af65c0dd837e666b9d0dfed62745f4df35aed7ea619b2798a709f0fe545403",
        ),
        (
            "plus plus plus plus plus plus plus plus plus plus plus plus plus plus plus plus plus plus plus plus plus plus plus plus plus",
            "3b0400003b0400003b0400003b0400003b0400003b0400003b0400003b040000",
        ),
        (
            "audio audio audio audio audio audio audio audio audio audio audio audio audio audio audio audio audio audio audio audio audio audio audio audio audio",
            "7900000079000000790000007900000079000000790000007900000079000000",
        ),
    ] {
        assert_eq!(hex::encode(*xmr_words_to_key(words).unwrap()), spend);
    }
    let mut w: Vec<&str> = A0_WORDS.split(' ').collect();
    w[24] = "abbey";
    assert!(xmr_words_to_key(&w.join(" ")).is_err());
    assert!(xmr_words_to_key(&A0_WORDS.replace("tavern", "zzzzzz")).is_err());
    assert!(xmr_words_to_key("plus plus").is_err());
}

#[test]
fn destinations_are_decoded_strictly() {
    let s = seed(ABANDON);
    let d = xmr_parse_address(A0_MAIN, Network::Mainnet).unwrap();
    assert_eq!(d.kind, XmrAddressKind::Standard);
    assert_eq!(d.address, A0_MAIN);
    assert_eq!(
        xmr_parse_address(&format!("  {A0_SUB1_MAIN}\n"), Network::Mainnet)
            .unwrap()
            .kind,
        XmrAddressKind::Subaddress
    );
    assert_eq!(
        xmr_parse_address(A0_SUB1_STAGE, Network::Testnet)
            .unwrap()
            .kind,
        XmrAddressKind::Subaddress
    );
    let vp = xmr_view_pair(&s, 0).unwrap();
    let integrated = vp
        .legacy_integrated_address(XNet::Mainnet, [1, 2, 3, 4, 5, 6, 7, 8])
        .to_string();
    assert_eq!(
        xmr_parse_address(&integrated, Network::Mainnet)
            .unwrap()
            .kind,
        XmrAddressKind::Integrated {
            payment_id: "0102030405060708".into()
        }
    );
    assert!(xmr_parse_address(A0_STAGE, Network::Mainnet).is_err());
    assert!(xmr_parse_address(A0_MAIN, Network::Testnet).is_err());
    let testnet = vp.legacy_address(XNet::Testnet).to_string();
    assert!(xmr_parse_address(&testnet, Network::Testnet).is_err());
    let g =
        GuaranteedViewPair::new(vp.spend(), zeroize::Zeroizing::new(Scalar::hash(b"x"))).unwrap();
    let featured = g
        .address(XNet::Mainnet, SubaddressIndex::new(0, 1), None)
        .to_string();
    assert!(xmr_parse_address(&featured, Network::Mainnet)
        .unwrap_err()
        .to_string()
        .contains("featured"));
    let mut bad = A0_MAIN.to_owned();
    bad.replace_range(10..11, if &A0_MAIN[10..11] == "a" { "b" } else { "a" });
    assert!(xmr_parse_address(&bad, Network::Mainnet).is_err());
    for junk in [
        "",
        "4",
        "bc1qxyz",
        "0x52908400098527886E0F7030069857D2E4169EE7",
    ] {
        assert!(xmr_parse_address(junk, Network::Mainnet).is_err(), "{junk}");
    }
}

#[test]
fn cache_is_bound_to_seed_network_and_account() {
    let s = seed(ABANDON);
    let other = seed(common::LEGAL);
    let sealed = xmr_cache_seal(&s, Network::Mainnet, 0, b"scan state").unwrap();
    assert_eq!(
        &xmr_cache_open(&s, Network::Mainnet, 0, &sealed).unwrap()[..],
        b"scan state"
    );
    assert!(xmr_cache_open(&other, Network::Mainnet, 0, &sealed).is_err());
    assert!(xmr_cache_open(&s, Network::Testnet, 0, &sealed).is_err());
    assert!(xmr_cache_open(&s, Network::Mainnet, 1, &sealed).is_err());
    let mut tampered = sealed.clone();
    let last = tampered.len() - 1;
    tampered[last] ^= 1;
    assert!(xmr_cache_open(&s, Network::Mainnet, 0, &tampered).is_err());
    assert_ne!(
        sealed,
        xmr_cache_seal(&s, Network::Mainnet, 0, b"scan state").unwrap()
    );
}

fn block_on<F: Future>(f: F) -> F::Output {
    let mut f = pin!(f);
    let mut cx = Context::from_waker(Waker::noop());
    loop {
        if let Poll::Ready(v) = f.as_mut().poll(&mut cx) {
            return v;
        }
    }
}

struct MockChain {
    real: (u64, [Point; 2]),
}

impl ProvidesBlockchainMeta for MockChain {
    fn latest_block_number(&self) -> impl Send + Future<Output = Result<usize, InterfaceError>> {
        async { Ok(1_999) }
    }
}

impl ProvidesUnvalidatedDecoys for MockChain {
    fn ringct_output_distribution(
        &self,
        range: impl Send + RangeBounds<usize>,
    ) -> impl Send + Future<Output = Result<Vec<u64>, InterfaceError>> {
        let end = match range.end_bound() {
            std::ops::Bound::Included(e) => *e + 1,
            std::ops::Bound::Excluded(e) => *e,
            std::ops::Bound::Unbounded => 2_000,
        };
        async move { Ok((1..=end as u64).map(|b| b * 10).collect()) }
    }

    fn unlocked_ringct_outputs(
        &self,
        indexes: &[u64],
        _evaluate_unlocked: EvaluateUnlocked,
    ) -> impl Send + Future<Output = Result<Vec<Option<[Point; 2]>>, TransactionsError>> {
        let out = indexes
            .iter()
            .map(|i| {
                if *i == self.real.0 {
                    return Some(self.real.1);
                }
                let mut k = [0u8; 32];
                k[..8].copy_from_slice(&i.to_le_bytes());
                let mut c = k;
                c[31] = 1;
                Some([Point::biased_hash(k), Point::biased_hash(c)])
            })
            .collect();
        async move { Ok(out) }
    }
}

fn our_output(amount: u64, offset: u8) -> WalletOutput {
    let s = seed(ABANDON);
    let vp = xmr_view_pair(&s, 0).unwrap();
    let mut o = [0u8; 32];
    o[0] = offset;
    let off = curve25519_dalek::Scalar::from_bytes_mod_order(o);
    let key = vp.spend().into() + curve25519_dalek::constants::ED25519_BASEPOINT_POINT * off;
    let mut bytes = Vec::new();
    bytes.extend([offset; 32]); // transaction hash
    bytes.extend(0u64.to_le_bytes()); // index in transaction
    bytes.extend((12_345u64 + u64::from(offset)).to_le_bytes()); // global index
    bytes.extend(key.compress().to_bytes());
    bytes.extend(o); // key offset
    let mut mask = [0u8; 32];
    mask[0] = 7;
    bytes.extend(mask);
    bytes.extend(amount.to_le_bytes());
    bytes.extend([0u8, 0, 0, 0]); // no timelock, no subaddress, no payment ID, no data
    WalletOutput::read(&mut bytes.as_slice()).unwrap()
}

fn with_decoys(o: WalletOutput) -> OutputWithDecoys {
    let mut rng = rand_chacha_rng();
    block_on(OutputWithDecoys::new(
        &mut rng,
        &MockChain {
            real: (o.index_on_blockchain(), [o.key(), o.commitment().commit()]),
        },
        XMR_RING_LEN,
        1_999,
        o,
    ))
    .unwrap()
}

fn rand_chacha_rng() -> impl rand_core::RngCore + rand_core::CryptoRng + Send + Sync {
    use rand_core::SeedableRng;
    rand_chacha::ChaCha20Rng::from_seed([9u8; 32])
}

#[test]
fn transfer_is_built_signed_and_checked() {
    let s = seed(ABANDON);
    let o1 = our_output(2_000_000_000_000, 5);
    let o2 = our_output(500_000_000_000, 6);
    let kis = xmr_key_images(&s, 0, &[o1.clone(), o2.clone()]).unwrap();
    let fee_rate = FeeRate::new(20_000, 10_000).unwrap();
    let to = A1_SUB1_MAIN;
    let u = xmr_build(
        &s,
        Network::Mainnet,
        0,
        vec![with_decoys(o1), with_decoys(o2)],
        to,
        1_500_000_000_000,
        fee_rate,
        &[A0_MAIN.into()],
    )
    .unwrap();
    let sum = u.summary.clone();
    assert_eq!(sum.network, "mainnet");
    assert_eq!(sum.destination.address, to);
    assert_eq!(sum.destination.kind, XmrAddressKind::Subaddress);
    assert_eq!(sum.amount, "1500000000000");
    assert_eq!(sum.inputs_total, "2500000000000");
    assert_eq!(sum.input_count, 2);
    assert_eq!(sum.ring_size, 16);
    let fee: u64 = sum.fee.parse().unwrap();
    assert!(fee > 0 && fee < 1_000_000_000, "fee {fee}");
    assert_eq!(
        sum.change.parse::<u64>().unwrap(),
        2_500_000_000_000 - 1_500_000_000_000 - fee
    );
    assert!(sum.warnings.is_empty() && !sum.requires_extra_confirmation);

    let signed = xmr_sign(&s, 0, u).unwrap();
    assert_eq!(signed.summary, sum);
    assert_eq!(signed.txid.len(), 64);
    let pruned = Transaction::<Pruned>::from(signed.tx.clone());
    assert_eq!(xmr_tx_fee(&pruned), Some(fee));
    assert_eq!(pruned.prefix().outputs.len(), 2);
    let mut revealed = signed.key_images.clone();
    revealed.sort_unstable();
    let mut expected = kis.clone();
    expected.sort_unstable();
    assert_eq!(revealed, expected);
    for i in &pruned.prefix().inputs {
        assert!(matches!(i, Input::ToKey { key_offsets, .. } if key_offsets.len() == 16));
    }
    assert_eq!(hex::encode(signed.tx.hash()), signed.txid);
}

#[test]
fn build_refusals_and_warnings() {
    let s = seed(ABANDON);
    let fee_rate = FeeRate::new(20_000, 10_000).unwrap();
    let input = || vec![with_decoys(our_output(1_000_000_000, 5))];
    assert!(xmr_build(
        &s,
        Network::Mainnet,
        0,
        input(),
        A1_MAIN,
        1_000_000_000,
        fee_rate,
        &[]
    )
    .is_err());
    assert!(xmr_build(&s, Network::Mainnet, 0, input(), A1_MAIN, 0, fee_rate, &[]).is_err());
    assert!(xmr_build(
        &s,
        Network::Mainnet,
        0,
        input(),
        A1_STAGE,
        1_000,
        fee_rate,
        &[]
    )
    .is_err());
    assert!(xmr_build(
        &s,
        Network::Mainnet,
        0,
        vec![],
        A1_MAIN,
        1_000,
        fee_rate,
        &[]
    )
    .is_err());
    let u = xmr_build(
        &s,
        Network::Mainnet,
        0,
        input(),
        A0_MAIN,
        1_000,
        fee_rate,
        &[A0_MAIN.into()],
    )
    .unwrap();
    assert!(u.summary.requires_extra_confirmation);
    assert!(u.summary.warnings.contains(&XmrWarning::OwnAddress));
    assert!(u.summary.warnings.contains(&XmrWarning::FeeAboveAmount));
    let vp = xmr_view_pair(&seed(common::LEGAL), 0).unwrap();
    let integrated = vp
        .legacy_integrated_address(XNet::Mainnet, [9; 8])
        .to_string();
    let u = xmr_build(
        &s,
        Network::Mainnet,
        0,
        input(),
        &integrated,
        1_000_000,
        fee_rate,
        &[],
    )
    .unwrap();
    assert!(u.summary.warnings.contains(&XmrWarning::IntegratedAddress));
    assert!(xmr_sign(&s, 1, u).is_err());
    let other = {
        let mut o = our_output(1, 5).serialize();
        o[56] ^= 1; // flip a bit of the output key
        WalletOutput::read(&mut o.as_slice())
    };
    if let Ok(o) = other {
        assert!(xmr_key_images(&s, 0, &[o]).is_err());
    }
}
