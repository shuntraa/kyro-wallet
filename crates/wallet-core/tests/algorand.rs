//! Algorand vectors.

mod common;

use base64::Engine as _;
use common::{seed, ABANDON};
use ed25519_dalek::Signer as _;
use wallet_core::{
    algo_address, algo_address_bytes, algo_address_of_pubkey, algo_decode_signed, algo_decode_tx,
    algo_encode_signed, algo_genesis, algo_known_asset, algo_path, algo_public_key, algo_sign,
    algo_verify_signed, AlgoAssetTransfer, AlgoPayment, AlgoWarning, Error, Network,
};

const ZONDAX_SEED: &str = "glory promote mansion idle axis finger extra february uncover one trip resource lawn turtle enact monster seven myth punch hobby comfort wild raise skin";

fn b64(s: &str) -> Vec<u8> {
    base64::engine::general_purpose::STANDARD.decode(s).unwrap()
}

/// Algorand's own 25-word format (py-algorand-sdk `mnemonic.to_private_key`): 24 words of 11
/// bits, little-endian bit order, = the 32-byte ed25519 secret key; the 25th is a checksum.
fn algorand_25_words_to_secret(phrase: &str) -> [u8; 32] {
    let list = bip39::Language::English.word_list();
    let words: Vec<&str> = phrase.split_whitespace().collect();
    assert_eq!(words.len(), 25);
    let (mut acc, mut bits, mut out) = (0u32, 0u32, Vec::new());
    for w in &words[..24] {
        let i = list.iter().position(|x| x == w).unwrap() as u32;
        acc |= i << bits;
        bits += 11;
        while bits >= 8 {
            out.push((acc & 0xFF) as u8);
            acc >>= 8;
            bits -= 8;
        }
    }
    if bits > 0 {
        out.push((acc & 0xFF) as u8);
    }
    assert_eq!(out.len(), 33);
    assert_eq!(out[32], 0);
    out[..32].try_into().unwrap()
}

#[test]
fn ledger_app_vector_account_123() {
    let s = seed(ZONDAX_SEED);
    assert_eq!(
        hex::encode(algo_public_key(&s, 123).unwrap()),
        "0dfdbcdb8eebed628cfb4ef70207b86fd0deddca78e90e8c59d6f441e383b377"
    );
    assert_eq!(
        algo_address(&s, 123).unwrap(),
        "BX63ZW4O5PWWFDH3J33QEB5YN7IN5XOKPDUQ5DCZ232EDY4DWN3XKUQRCA"
    );
    assert_eq!(algo_path(123), "m/44'/283'/123'/0/0");
}

#[test]
fn account_0_is_frozen() {
    // No independent vector for this phrase: frozen so that no future change moves addresses.
    let s = seed(ABANDON);
    let a0 = algo_address(&s, 0).unwrap();
    assert_eq!(a0.len(), 58);
    assert_eq!(algo_address(&s, 0).unwrap(), a0, "deterministic");
    assert_ne!(algo_address(&s, 1).unwrap(), a0);
    assert_eq!(a0, algo_address_of_pubkey(&algo_public_key(&s, 0).unwrap()));
    assert_eq!(a0, FROZEN_ABANDON_0);
    assert!(algo_address(&s, 1 << 31).is_err());
}

const FROZEN_ABANDON_0: &str = "PSHLIWQKDEETIIBQEOTLGCT5IF7BTTOKCUULONOGVGF2HYDT2IHW3H4CCI";

#[test]
fn addresses_parse_strictly() {
    let a = "BX63ZW4O5PWWFDH3J33QEB5YN7IN5XOKPDUQ5DCZ232EDY4DWN3XKUQRCA";
    assert_eq!(algo_address_of_pubkey(&algo_address_bytes(a).unwrap()), a);
    assert_eq!(
        algo_address_bytes(&format!("  {a} ")).unwrap(),
        algo_address_bytes(a).unwrap()
    );
    assert_eq!(
        algo_address_bytes("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ").unwrap(),
        [0u8; 32]
    );
    for bad in [
        "BX63ZW4O5PWWFDH3J33QEB5YN7IN5XOKPDUQ5DCZ232EDY4DWN3XKUQRCB", // checksum
        "bx63zw4o5pwwfdh3j33qeb5yn7in5xokpduq5dcz232edy4dwn3xkuqrca", // lower case
        "BX63ZW4O5PWWFDH3J33QEB5YN7IN5XOKPDUQ5DCZ232EDY4DWN3XKUQRC",  // length
        "BX63ZW4O5PWWFDH3J33QEB5YN7IN5XOKPDUQ5DCZ232EDY4DWN3XKUQRCAA",
        "0x9858EfFD232B4033E47d90003D41EC34EcaEda94",
        "",
    ] {
        assert!(algo_address_bytes(bad).is_err(), "{bad}");
    }
}

const PY_SDK_MNEMONIC: &str = "advice pudding treat near rule blouse same whisper inner electric quit surface sunny dismiss leader blood seat clown cost exist hospital century reform able sponsor";

const PY_SDK_SIGNED: &str = concat!(
    "gqNzaWfEQPhUAZ3xkDDcc8FvOVo6UinzmKBCqs0woYSfodlmBMfQvGbeUx3Srxy3d",
    "yJDzv7rLm26BRv9FnL2/AuT7NYfiAWjdHhui6NhbXTNA+ilY2xvc2XEIEDpNJKIJW",
    "TLzpxZpptnVCaJ6aHDoqnqW2Wm6KRCH/xXo2ZlZc0EmKJmds0wsqNnZW6sZGV2bmV",
    "0LXYzMy4womdoxCAmCyAJoJOohot5WHIvpeVG7eftF+TYXEx4r7BFJpDt0qJsds00",
    "mqRub3RlxAjqABVHQ2y/lqNyY3bEIHts4k/rW6zAsWTinCIsV/X2PcOH1DkEglhBH",
    "F/hD3wCo3NuZMQg5/D4TQaBHfnzHI2HixFV9GcdUaGFwgCQhmf0SVhwaKGkdHlwZa",
    "NwYXk="
);

#[test]
fn py_sdk_signed_payment_is_reproduced_byte_for_byte() {
    let raw = b64(PY_SDK_SIGNED);
    let (p, sig) = algo_decode_signed(&raw).unwrap();
    assert_eq!(p.amount, 1000);
    assert_eq!(p.first_valid, 12466);
    assert_eq!(p.last_valid, 13466);
    assert_eq!(p.genesis_id, "devnet-v33.0");
    assert_eq!(
        p.genesis_hash.to_vec(),
        b64("JgsgCaCTqIaLeVhyL6XlRu3n7Rfk2FxMeK+wRSaQ7dI=")
    );
    assert_eq!(
        algo_address_of_pubkey(&p.receiver),
        "PNWOET7LLOWMBMLE4KOCELCX6X3D3Q4H2Q4QJASYIEOF7YIPPQBG3YQ5YI"
    );
    assert_eq!(
        algo_address_of_pubkey(&p.close_remainder_to.unwrap()),
        "IDUTJEUIEVSMXTU4LGTJWZ2UE2E6TIODUKU6UW3FU3UKIQQ77RLUBBBFLA"
    );
    assert_eq!(p.note, b64("6gAVR0Nsv5Y="));
    assert_eq!(
        p.txid(),
        "5FJDJD5LMZC3EHUYYJNH5I23U4X6H2KXABNDGPIL557ZMJ33GZHQ"
    );
    let sk = ed25519_dalek::SigningKey::from_bytes(&algorand_25_words_to_secret(PY_SDK_MNEMONIC));
    assert_eq!(sk.verifying_key().to_bytes(), p.sender);
    let again = sk.sign(&p.signing_bytes()).to_bytes();
    assert_eq!(again, sig);
    assert_eq!(algo_encode_signed(&p, &again), raw);
    let me = algo_address_of_pubkey(&p.sender);
    let e = algo_decode_tx(&hex::encode(p.encode()), Network::Testnet, &me).unwrap_err();
    assert!(e.to_string().contains("close-remainder-to"), "{e}");
    assert!(algo_verify_signed(&hex::encode(&raw), Network::Testnet, &me).is_err());
}

#[test]
fn py_sdk_zero_receiver_payment() {
    let raw = b64(concat!(
        "iKNhbXTNA+ijZmVlzQPoomZ2AaJnaMQgJgsgCaCTqIaLeVhyL6XlRu3n7Rfk2FxMe",
        "K+wRSaQ7dKibHZkpG5vdGXEAwEgyKNzbmTEIP5oQQPnKvM7kbGuuSOunAVfSbJzHQ",
        "tAtCP3Bf2XdDxmpHR5cGWjcGF5"
    ));
    let p = AlgoPayment::decode(&raw).unwrap();
    assert_eq!(
        (p.amount, p.fee, p.first_valid, p.last_valid),
        (1000, 1000, 1, 100)
    );
    assert_eq!(p.note, vec![1, 32, 200]);
    assert_eq!(p.receiver, [0u8; 32], "zero receiver omitted on the wire");
    assert!(p.genesis_id.is_empty());
    assert_eq!(
        algo_address_of_pubkey(&p.sender),
        "7ZUECA7HFLZTXENRV24SHLU4AVPUTMTTDUFUBNBD64C73F3UHRTHAIOF6Q"
    );
    assert_eq!(p.encode(), raw);
}

const ZONDAX_TX_PAYMENT: [u8; 221] = [
    139, 163, 97, 109, 116, 205, 3, 232, 165, 99, 108, 111, 115, 101, 196, 32, 64, 233, 52, 146,
    136, 37, 100, 203, 206, 156, 89, 166, 155, 103, 84, 38, 137, 233, 161, 195, 162, 169, 234, 91,
    101, 166, 232, 164, 66, 31, 252, 87, 163, 102, 101, 101, 205, 3, 232, 162, 102, 118, 205, 48,
    57, 163, 103, 101, 110, 172, 100, 101, 118, 110, 101, 116, 45, 118, 51, 56, 46, 48, 162, 103,
    104, 196, 32, 254, 179, 108, 57, 16, 20, 57, 0, 195, 218, 85, 66, 202, 24, 54, 176, 15, 210,
    248, 25, 89, 18, 87, 205, 35, 246, 4, 47, 152, 200, 54, 157, 162, 108, 118, 205, 246, 253, 164,
    110, 111, 116, 101, 196, 8, 69, 38, 34, 0, 24, 82, 134, 251, 163, 114, 99, 118, 196, 32, 123,
    108, 226, 79, 235, 91, 172, 192, 177, 100, 226, 156, 34, 44, 87, 245, 246, 61, 195, 135, 212,
    57, 4, 130, 88, 65, 28, 95, 225, 15, 124, 2, 163, 115, 110, 100, 196, 32, 141, 146, 180, 137,
    144, 1, 115, 160, 77, 250, 67, 89, 163, 102, 106, 106, 252, 234, 44, 66, 160, 93, 217, 193,
    247, 62, 235, 165, 71, 128, 55, 233, 164, 116, 121, 112, 101, 163, 112, 97, 121,
];

#[test]
fn ledger_app_payment_fixture_round_trips() {
    let p = AlgoPayment::decode(&ZONDAX_TX_PAYMENT).unwrap();
    assert_eq!(
        (p.amount, p.fee, p.first_valid, p.last_valid),
        (1000, 1000, 12345, 63229)
    );
    assert_eq!(p.genesis_id, "devnet-v38.0");
    assert!(p.close_remainder_to.is_some());
    assert_eq!(p.encode(), ZONDAX_TX_PAYMENT.to_vec());
}

fn kyro_payment(net: Network, sender: [u8; 32]) -> AlgoPayment {
    let (gen, gh) = algo_genesis(net).unwrap();
    AlgoPayment {
        amount: 1_500_000,
        close_remainder_to: None,
        fee: 1_000,
        first_valid: 50_000_000,
        genesis_id: gen.into(),
        genesis_hash: gh,
        group: None,
        last_valid: 50_000_200,
        lease: None,
        note: Vec::new(),
        receiver: algo_address_bytes("BX63ZW4O5PWWFDH3J33QEB5YN7IN5XOKPDUQ5DCZ232EDY4DWN3XKUQRCA")
            .unwrap(),
        rekey_to: None,
        sender,
        asset: None,
    }
}

/// Zondax `ledger-algorand` `tests_zemu/tests/common.ts` `txAssetXfer` (fetched 2026-11-01): a
/// msgpack asset transfer (asset 1234, 10 units, receiver = sender).
const ZONDAX_TX_ASSET_XFER: &[u8] = &[
    137, 164, 97, 97, 109, 116, 10, 164, 97, 114, 99, 118, 196, 32, 86, 149, 120, 43, 210, 87, 218,
    245, 240, 34, 71, 114, 243, 188, 72, 116, 212, 242, 145, 254, 132, 88, 187, 108, 72, 154, 171,
    40, 86, 45, 162, 57, 163, 102, 101, 101, 205, 9, 16, 162, 102, 118, 205, 3, 232, 162, 103, 104,
    196, 32, 72, 99, 181, 24, 164, 179, 200, 78, 200, 16, 242, 45, 79, 16, 129, 203, 15, 113, 240,
    89, 167, 172, 32, 222, 198, 47, 127, 112, 229, 9, 58, 34, 162, 108, 118, 205, 7, 208, 163, 115,
    110, 100, 196, 32, 86, 149, 120, 43, 210, 87, 218, 245, 240, 34, 71, 114, 243, 188, 72, 116,
    212, 242, 145, 254, 132, 88, 187, 108, 72, 154, 171, 40, 86, 45, 162, 57, 164, 116, 121, 112,
    101, 165, 97, 120, 102, 101, 114, 164, 120, 97, 105, 100, 205, 4, 210,
];

#[test]
fn ledger_app_asset_transfer_fixture_round_trips() {
    let p = AlgoPayment::decode(ZONDAX_TX_ASSET_XFER).unwrap();
    let a = p.asset.as_ref().unwrap();
    assert_eq!((a.asset_id, a.amount, p.fee), (1234, 10, 2320));
    assert_eq!((p.first_valid, p.last_valid), (1000, 2000));
    assert_eq!(a.receiver, p.sender);
    assert_eq!((p.amount, p.receiver), (0, [0u8; 32]));
    assert_eq!(p.encode(), ZONDAX_TX_ASSET_XFER.to_vec());
}

fn usdc_opt_in(sender: [u8; 32]) -> AlgoPayment {
    let mut p = kyro_payment(Network::Mainnet, sender);
    p.amount = 0;
    p.receiver = [0; 32];
    p.asset = Some(AlgoAssetTransfer {
        asset_id: 31_566_704,
        amount: 0,
        receiver: sender,
        close_to: None,
        asset_sender: None,
    });
    p
}

#[test]
fn known_assets_are_the_verified_ones() {
    let m = |id| algo_known_asset(Network::Mainnet, id).map(|a| (a.symbol, a.decimals));
    assert_eq!(m(31_566_704), Some(("USDC", 6)));
    assert_eq!(m(312_769), Some(("USDT", 6)));
    assert_eq!(m(10_458_941), None);
    assert_eq!(
        algo_known_asset(Network::Testnet, 10_458_941).map(|a| a.symbol),
        Some("USDC")
    );
    assert_eq!(algo_known_asset(Network::Testnet, 31_566_704), None);
}

#[test]
fn opt_in_and_asset_transfer_are_signed_with_their_summary() {
    let s = seed(ABANDON);
    let me = algo_address(&s, 0).unwrap();
    let pk = algo_public_key(&s, 0).unwrap();
    let opt = usdc_opt_in(pk);
    let raw = opt.encode();
    assert_eq!(raw[0], 0x89, "9 fields");
    assert_eq!(AlgoPayment::decode(&raw).unwrap(), opt);
    let blob = hex::encode(&raw);
    let sm = algo_decode_tx(&blob, Network::Mainnet, &me).unwrap();
    let a = sm.asset.clone().unwrap();
    assert!(a.opt_in);
    assert_eq!(
        (a.asset_id, a.symbol.as_str(), a.decimals, a.amount.as_str()),
        (31_566_704, "USDC", 6, "0")
    );
    assert_eq!(
        (sm.receiver.as_str(), sm.amount.as_str()),
        (me.as_str(), "0")
    );
    let (signed, txid, again) = algo_sign(&s, 0, Network::Mainnet, &blob).unwrap();
    assert_eq!(again, sm);
    assert_eq!(
        algo_verify_signed(&signed, Network::Mainnet, &me)
            .unwrap()
            .0,
        txid
    );
    let other =
        algo_address_bytes("BX63ZW4O5PWWFDH3J33QEB5YN7IN5XOKPDUQ5DCZ232EDY4DWN3XKUQRCA").unwrap();
    let mut x = opt.clone();
    x.asset = Some(AlgoAssetTransfer {
        asset_id: 312_769,
        amount: 12_500_000,
        receiver: other,
        close_to: None,
        asset_sender: None,
    });
    let sm = algo_decode_tx(&hex::encode(x.encode()), Network::Mainnet, &me).unwrap();
    let a = sm.asset.unwrap();
    assert!(!a.opt_in);
    assert_eq!((a.symbol.as_str(), a.amount.as_str()), ("USDT", "12500000"));
    assert_eq!(
        sm.receiver,
        "BX63ZW4O5PWWFDH3J33QEB5YN7IN5XOKPDUQ5DCZ232EDY4DWN3XKUQRCA"
    );
    assert!(wallet_core::algo_hw_message(&blob).is_err());
}

#[test]
fn dangerous_or_unknown_asset_transfers_are_refused() {
    let s = seed(ABANDON);
    let me = algo_address(&s, 0).unwrap();
    let pk = algo_public_key(&s, 0).unwrap();
    let m = Network::Mainnet;
    let other =
        algo_address_bytes("BX63ZW4O5PWWFDH3J33QEB5YN7IN5XOKPDUQ5DCZ232EDY4DWN3XKUQRCA").unwrap();
    let with = |f: &dyn Fn(&mut AlgoAssetTransfer)| {
        let mut p = usdc_opt_in(pk);
        f(p.asset.as_mut().unwrap());
        p
    };
    refused(&with(&|a| a.asset_id = 1234), m, &me, "unknown");
    refused(
        &with(&|a| a.close_to = Some(other)),
        m,
        &me,
        "asset-close-to",
    );
    refused(&with(&|a| a.asset_sender = Some(other)), m, &me, "clawback");
    refused(&with(&|a| a.amount = 5), m, &me, "yourself");
    refused(&with(&|a| a.receiver = other), m, &me, "zero amount");
    refused(&with(&|a| a.receiver = [0; 32]), m, &me, "null recipient");
    refused(&usdc_opt_in(pk), Network::Testnet, &me, "network");
    let mut t = kyro_payment(Network::Testnet, pk);
    t.amount = 0;
    t.receiver = [0; 32];
    t.asset = with(&|a| a.asset_id = 31_566_704).asset;
    refused(&t, Network::Testnet, &me, "unknown");
    let mut mixed = usdc_opt_in(pk);
    mixed.amount = 1;
    assert!(AlgoPayment::decode(&mixed.encode())
        .unwrap_err()
        .to_string()
        .contains("ALGO payment fields"));
}

#[test]
fn sign_verify_and_summary() {
    let s = seed(ABANDON);
    let me = algo_address(&s, 0).unwrap();
    let pk = algo_public_key(&s, 0).unwrap();
    let mut p = kyro_payment(Network::Testnet, pk);
    p.note = "Loyer octobre".as_bytes().to_vec();
    let blob = hex::encode(p.encode());
    let summary = algo_decode_tx(&blob, Network::Testnet, &me).unwrap();
    assert_eq!(summary.sender, me);
    assert_eq!(summary.amount, "1500000");
    assert_eq!(summary.fee, "1000");
    assert_eq!(summary.genesis_id, "testnet-v1.0");
    assert_eq!(
        summary.genesis_hash,
        "SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI="
    );
    assert_eq!(summary.note_text.as_deref(), Some("Loyer octobre"));
    assert_eq!(summary.warnings, vec![AlgoWarning::Note]);
    assert!(summary.requires_extra_confirmation);
    assert_eq!(summary.txid, p.txid());

    let (signed, txid, again) = algo_sign(&s, 0, Network::Testnet, &blob).unwrap();
    assert_eq!(again, summary);
    assert_eq!(txid, p.txid());
    let (got, raw) = algo_verify_signed(&signed, Network::Testnet, &me).unwrap();
    assert_eq!(got, txid);
    let (decoded, sig) = algo_decode_signed(&raw).unwrap();
    assert_eq!(decoded, p);
    ed25519_dalek::VerifyingKey::from_bytes(&pk)
        .unwrap()
        .verify_strict(
            &p.signing_bytes(),
            &ed25519_dalek::Signature::from_bytes(&sig),
        )
        .unwrap();
    let mut bad = raw.clone();
    bad[10] ^= 1;
    assert!(algo_verify_signed(&hex::encode(&bad), Network::Testnet, &me).is_err());
    let mut other = p.clone();
    other.amount += 1;
    let forged = algo_encode_signed(&other, &sig);
    assert!(algo_verify_signed(&hex::encode(forged), Network::Testnet, &me).is_err());
    assert!(algo_verify_signed(&signed, Network::Mainnet, &me).is_err());
    assert!(algo_sign(&s, 1, Network::Testnet, &blob).is_err());
    let plain = hex::encode(kyro_payment(Network::Mainnet, pk).encode());
    let sm = algo_decode_tx(&plain, Network::Mainnet, &me).unwrap();
    assert!(!sm.requires_extra_confirmation);
    assert_eq!(sm.note_len, 0);
}

fn refused(p: &AlgoPayment, net: Network, me: &str, needle: &str) {
    let e = algo_decode_tx(&hex::encode(p.encode()), net, me).unwrap_err();
    assert!(matches!(e, Error::InvalidInput(_)));
    assert!(e.to_string().contains(needle), "{needle} ∉ {e}");
}

#[test]
fn dangerous_or_odd_payments_are_refused() {
    let s = seed(ABANDON);
    let me = algo_address(&s, 0).unwrap();
    let pk = algo_public_key(&s, 0).unwrap();
    let t = Network::Testnet;
    let base = kyro_payment(t, pk);
    let other =
        algo_address_bytes("BX63ZW4O5PWWFDH3J33QEB5YN7IN5XOKPDUQ5DCZ232EDY4DWN3XKUQRCA").unwrap();
    let with = |f: &dyn Fn(&mut AlgoPayment)| {
        let mut p = base.clone();
        f(&mut p);
        p
    };
    refused(
        &with(&|p| p.close_remainder_to = Some(other)),
        t,
        &me,
        "close-remainder-to",
    );
    refused(&with(&|p| p.rekey_to = Some(other)), t, &me, "rekey");
    refused(&with(&|p| p.group = Some([7; 32])), t, &me, "grouped");
    refused(&with(&|p| p.lease = Some([7; 32])), t, &me, "lease");
    refused(&base, Network::Mainnet, &me, "unexpected network");
    refused(
        &with(&|p| p.genesis_id = "testnet-v2.0".into()),
        t,
        &me,
        "unexpected network",
    );
    refused(
        &with(&|p| p.genesis_hash[0] ^= 1),
        t,
        &me,
        "unexpected network",
    );
    refused(&with(&|p| p.sender = other), t, &me, "sender");
    refused(&with(&|p| p.receiver = [0; 32]), t, &me, "null recipient");
    refused(&with(&|p| p.receiver = pk), t, &me, "yourself");
    refused(&with(&|p| p.amount = 0), t, &me, "zero amount");
    refused(&with(&|p| p.fee = 999), t, &me, "minimum");
    refused(
        &with(&|p| p.last_valid = p.first_valid + 1001),
        t,
        &me,
        "1000 rounds",
    );
    refused(
        &with(&|p| p.last_valid = p.first_valid - 1),
        t,
        &me,
        "validity",
    );
    refused(&with(&|p| p.note = vec![b'x'; 1025]), t, &me, "1024");
    let sm = algo_decode_tx(&hex::encode(with(&|p| p.fee = 20_000).encode()), t, &me).unwrap();
    assert_eq!(sm.warnings, vec![AlgoWarning::HighFee]);
    let sm = algo_decode_tx(
        &hex::encode(with(&|p| p.note = vec![0xFF, 0x00]).encode()),
        t,
        &me,
    )
    .unwrap();
    assert_eq!(
        sm.warnings,
        vec![AlgoWarning::Note, AlgoWarning::BinaryNote]
    );
    assert_eq!(sm.note_hex.as_deref(), Some("ff00"));
    let sm = algo_decode_tx(
        &hex::encode(with(&|p| p.note = "a\u{202E}b".as_bytes().to_vec()).encode()),
        t,
        &me,
    )
    .unwrap();
    assert_eq!(
        sm.warnings,
        vec![AlgoWarning::Note, AlgoWarning::UnusualText]
    );
}

#[test]
fn non_canonical_or_foreign_encodings_are_refused() {
    let s = seed(ABANDON);
    let me = algo_address(&s, 0).unwrap();
    let pk = algo_public_key(&s, 0).unwrap();
    let raw = kyro_payment(Network::Testnet, pk).encode();
    assert_eq!(raw[0], 0x89, "9 fields");
    let dec = |b: &[u8]| AlgoPayment::decode(b);
    let mut x = raw.clone();
    x.push(0);
    assert!(dec(&x).is_err());
    let mut x = raw.clone();
    let at = x
        .windows(4)
        .position(|w| w == [0xA3, b'a', b'm', b't'])
        .unwrap()
        + 4;
    assert_eq!(x[at], 0xCE);
    let v = x[at + 1..at + 5].to_vec();
    let _old: Vec<u8> = x
        .splice(at..at + 5, [&[0xCFu8, 0, 0, 0, 0][..], &v[..]].concat())
        .collect();
    assert!(dec(&x).unwrap_err().to_string().contains("non-canonical"));
    let mut x = vec![0x8A, 0xA3, b'a', b'm', b't', 0x00];
    x.extend_from_slice(&raw[1..]);
    assert!(dec(&x).is_err());
    let mut x = vec![0x8A, 0xA4, b'z', b'a', b'm', b't', 0x01];
    x.extend_from_slice(&raw[1..]);
    assert!(dec(&x).unwrap_err().to_string().contains("unknown field"));
    let mut x = raw.clone();
    let n = x.len();
    assert_eq!(&x[n - 4..], &[0xA3, b'p', b'a', b'y']);
    let _old: Vec<u8> = x
        .splice(n - 4.., [0xA5, b'a', b'x', b'f', b'e', b'r'])
        .collect();
    assert!(dec(&x)
        .unwrap_err()
        .to_string()
        .contains("ALGO payment fields in an asset transfer"));
    let _old: Vec<u8> = x.splice(n - 4.., [0xA4, b'a', b'p', b'p', b'l']).collect();
    assert!(dec(&x)
        .unwrap_err()
        .to_string()
        .contains("\"appl\" refused"));
    let (signed, _, _) = algo_sign(&s, 0, Network::Testnet, &hex::encode(&raw)).unwrap();
    assert!(algo_decode_tx(&signed, Network::Testnet, &me).is_err());
    assert!(algo_verify_signed(&hex::encode(&raw), Network::Testnet, &me).is_err());
    assert!(algo_decode_tx("zz", Network::Testnet, &me).is_err());
}

#[test]
fn hardware_wallet_message_and_signature() {
    let s = seed(ABANDON);
    let me = algo_address(&s, 0).unwrap();
    let pk = algo_public_key(&s, 0).unwrap();
    let p = kyro_payment(Network::Testnet, pk);
    let blob = hex::encode(p.encode());
    let msg = wallet_core::algo_hw_message(&blob).unwrap();
    assert_eq!(msg, p.encode());
    assert_eq!(&p.signing_bytes()[2..], msg.as_slice());
    assert_eq!(
        wallet_core::algo_hw_message(&hex::encode(ZONDAX_TX_PAYMENT)).unwrap(),
        ZONDAX_TX_PAYMENT.to_vec()
    );
    let (signed, txid, _) = algo_sign(&s, 0, Network::Testnet, &blob).unwrap();
    let (_, sig) = algo_decode_signed(&hex::decode(&signed).unwrap()).unwrap();
    assert_eq!(
        wallet_core::algo_hw_signed(&blob, Network::Testnet, &me, &sig).unwrap(),
        (signed, txid)
    );
    let other = algo_address(&s, 1).unwrap();
    assert!(wallet_core::algo_hw_signed(&blob, Network::Testnet, &other, &sig).is_err());
    assert!(wallet_core::algo_hw_signed(&blob, Network::Mainnet, &me, &sig).is_err());
}
