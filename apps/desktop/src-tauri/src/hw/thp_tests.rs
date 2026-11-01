//! Unit tests of the THP host side ([`super`]): reference vectors from python-trezorlib, Trezor
//! Suite and the firmware tests, and the Alternating Bit Protocol behaviour.

use super::*;
use std::collections::VecDeque;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

fn h(s: &str) -> Vec<u8> {
    hex::decode(s).unwrap()
}

fn h32(s: &str) -> [u8; 32] {
    h(s).try_into().unwrap()
}

fn limit(ms: u64) -> Mutex<Limit> {
    let mut l = Limit::idle();
    l.deadline = Instant::now() + Duration::from_millis(ms);
    Mutex::new(l)
}

#[test]
fn crc32_and_wire_vectors() {
    assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
    let nonce = h("639ba57ff4e0c234");
    let p = packets(CB_ALLOC_REQ, BROADCAST, &nonce).unwrap();
    assert_eq!(p.len(), 1);
    assert_eq!(
        hex::encode(&p[0][..17]),
        "40ffff000c639ba57ff4e0c2348189a406"
    );
    assert!(p[0][17..].iter().all(|b| *b == 0));
    assert_eq!(
        hex::encode(&packets(CB_ACK, 0x1234, &[]).unwrap()[0][..9]),
        "2012340004d9fcce58"
    );
    assert_eq!(
        hex::encode(&packets(CB_ACK | ACK_BIT, 0x1234, &[]).unwrap()[0][..9]),
        "2812340004e98c8599"
    );
    let data: Vec<u8> = (0..150u8).collect();
    let got: Vec<String> = packets(ENCRYPTED | SEQ_BIT, 0x0042, &data)
        .unwrap()
        .iter()
        .map(hex::encode)
        .collect();
    assert_eq!(
        got,
        [
            "140042009a000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a",
            "8000423b3c3d3e3f404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f606162636465666768696a6b6c6d6e6f7071727374757677",
            "80004278797a7b7c7d7e7f808182838485868788898a8b8c8d8e8f9091929394959e96cb22000000000000000000000000000000000000000000000000000000",
        ]
    );
    let mut init = vec![7u8; 32];
    init.push(0);
    assert_eq!(
        hex::encode(&packets(HS_INIT_REQ, 0x1234, &init).unwrap()[0][..42]),
        "0012340025070707070707070707070707070707070707070707070707070707070707070700b93a27f7"
    );
}

#[test]
fn reassembly_crc_and_garbage() {
    let data: Vec<u8> = (0..150u8).collect();
    let pk = packets(ENCRYPTED | SEQ_BIT, 0x0042, &data).unwrap();
    let mut r = Reassembler::default();
    assert_eq!(r.push(&pk[0]), None);
    assert_eq!(r.push(&pk[1]), None);
    let f = r.push(&pk[2]).unwrap();
    assert_eq!((f.cb, f.cid, f.data), (0x14, 0x0042, data.clone()));
    // A damaged payload is dropped (never ACKed, so the peer resends it).
    let mut bad = pk[1];
    bad[10] ^= 0x80;
    assert_eq!(r.push(&pk[0]), None);
    assert_eq!(r.push(&bad), None);
    assert_eq!(r.push(&pk[2]), None);
    assert_eq!(r.push(&pk[1]), None);
    let mut v1 = [0u8; PACKET];
    v1[..3].copy_from_slice(b"?##");
    assert_eq!(r.push(&v1), None);
    assert_eq!(r.push(&pk[0]), None);
    let mut other = pk[1];
    other[1..3].copy_from_slice(&0x0043u16.to_be_bytes());
    assert_eq!(r.push(&other), None);
    let ack = packets(CB_ACK, 0x0042, &[]).unwrap();
    let f = r.push(&ack[0]).unwrap();
    assert_eq!((f.cb, f.data.len()), (CB_ACK, 0));
    let mut e = [0u8; PACKET];
    e[..10].copy_from_slice(&h("42122200050270303cfa"));
    let f = Reassembler::default().push(&e).unwrap();
    assert_eq!((f.cb, f.cid, f.data.clone()), (CB_ERROR, 0x1222, vec![2]));
    assert_eq!(
        transport_error(f.data.first().copied()),
        HwError::Disconnected
    );
    assert_eq!(transport_error(Some(ERR_LOCKED)), HwError::Locked);
}

#[test]
fn allocation_response_and_prologue() {
    let mut p = [0u8; PACKET];
    let wire = h("41ffff0020639ba57ff4e0c2343c830a0454335731180220002802280328042801c0171551");
    p[..wire.len()].copy_from_slice(&wire);
    let f = Reassembler::default().push(&p).unwrap();
    assert_eq!(f.cb, CB_ALLOC_RES);
    assert_eq!(&f.data[..8], &h("639ba57ff4e0c234")[..]);
    assert_eq!(u16::from_be_bytes([f.data[8], f.data[9]]), 0x3c83);
    let props = parse_props(&f.data[10..]).unwrap();
    assert_eq!(props.internal_model, "T3W1");
    assert_eq!((props.protocol_major, props.protocol_minor), (2, 0));
    assert_eq!(props.pairing_methods, vec![2, 3, 4, 1]);
    let mut hsh = Sha256::new();
    hsh.update(b"Noise_XX_25519_AESGCM_SHA256\0\0\0\0");
    hsh.update(&props.raw);
    assert_eq!(
        hex::encode(hsh.finalize()),
        "a1615c6dc1c2a2df8155ea5b54d0f39c320d4908e4b1eaf8d24ab5c4b466e947"
    );
}

#[test]
fn sequence_bits() {
    assert!(!seq_bit(HS_INIT_RES));
    assert!(seq_bit(HS_COMP_RES), "trezorlib HANDSHAKE_SEQ_BITS");
    assert!(seq_bit(HS_COMP_RES | SEQ_BIT));
    assert!(!seq_bit(ENCRYPTED | ACK_BIT));
    assert!(seq_bit(ENCRYPTED | SEQ_BIT));
    assert!(is_data(ENCRYPTED | SEQ_BIT | ACK_BIT));
    assert!(!is_data(CB_ACK) && !is_data(CB_ERROR) && !is_data(CB_ALLOC_RES));
}

/// Vectors computed with python-trezorlib's own pure-Python CPace (`thp/cpace.py`,
/// `thp/curve25519.py`: RFC 9380 Elligator2 + RFC 7748 X25519): code, handshake hash, host
/// private key, device CPace key → host CPace key, tag.
const CPACE: [(&str, &str, &str, &str, &str, &str); 4] = [
    (
        "123456",
        "9b80e7d2a2978473c4b0b06b934010db620fefba6d449627eb38f0fb5d87c84e",
        "117abb82e9da82ef5135f375205a243df7137c5fc7891799602e4fe31af35de1",
        "86d1eb870ce5908a5b04f978166e91b795b14342f074b91fb46f43f4b040526b",
        "e0c778a9320a7b16e48baf46256e3f292afbda2490b3ff22a380e975552c025c",
        "c04b495163f18df5b1c78cec079c1c96176b6315a98046d573304a8adf0f3737",
    ),
    (
        "246912",
        "5a56a177fae1b31823ae3599b3752de6edc004e961eaffcd3dbbfd0ede0461f8",
        "b930962dbd208acf4046e736e7755749be70df8aa4b440d1b7c53eac659f2780",
        "d7ad02c363c86a21984c5632d54618e7979d58bef3926304817ff52151b0ef05",
        "9ebe56552bc8ead44a9de0c7546d958e62a840f4774a6cb05412b11e33a5c76b",
        "b19c6d608320f8b925e4af7c1891022b26f2674ff3d387898e808a71380d2539",
    ),
    (
        "370368",
        "47bda54fef34d99dab44a72118cb7269b688ead9f24adc42f53146bd0b7fd59c",
        "75defc8f39d36969539d4a7f168694cc4a02c482fe8ab14636254ccdc29f1ba1",
        "98b8f8c010d24c58691307f0f2b05947ca513407fc43187fda7579b5f8990442",
        "f30b545b6d767f11fa667b81ba637689d88c86ce5042cf6ac8adfb1b2ac39e41",
        "fccf7a15c8abee68ab864f667dea1d7cc9a92c78e0758589d40fc6e8a0be39e1",
    ),
    (
        "493824",
        "15cac8f0cadd4aa2e2a617e1fae5ba7f5bb901ec1860cbeda6e2d26de8261ce7",
        "a586464f605ba3b9f192c0d1a05466a16523094caee2580790b9483ea4adb097",
        "48e4dca071276826c0e49ef989e4abfee950dc53a487bf872f0c1cb335c45405",
        "bce04b97ca9bf45a77af1d75f7530f4fdb46693c3a6e3487043aafe7c417b324",
        "8e1187b2e2f03d5ded263cfeedd60fec4bca206e22f0c079fa53e78f48a6526e",
    ),
];

#[test]
fn cpace_matches_trezorlib() {
    for (code, hh, k, tpub, want_pub, want_tag) in CPACE {
        let code: [u8; 6] = code.as_bytes().try_into().unwrap();
        let r = cpace_host(&code, &h32(hh), &h32(k), &h32(tpub)).unwrap();
        assert_eq!(hex::encode(r.public_key), want_pub);
        assert_eq!(hex::encode(r.tag), want_tag);
    }
    let s = cpace_generator_string(b"000000", &[0xAA; 32]);
    assert_eq!(s.len(), 9 + 7 + 112 + 33 + 1);
    assert_eq!(&s[..10], b"\x08CPace255\x06");
}

/// Property-style cross-check of Kyro's CPace (composed from curve25519-dalek primitives) on 200
/// random exchanges (fixed seed 20261030), in **both roles**.
#[test]
fn cpace_matches_trezorlib_on_200_random_exchanges() {
    let v: Vec<[String; 7]> =
        serde_json::from_str(include_str!("testdata/thp_cpace_trezorlib.json")).unwrap();
    assert_eq!(v.len(), 200);
    for [code, hh, k, t, trezor_pub, host_pub, tag] in &v {
        let code: [u8; 6] = code.as_bytes().try_into().unwrap();
        let hh = h32(hh);
        let gen = cpace_generator_string(&code, &hh);
        assert_eq!(
            hex::encode(cpace_public(&gen, &h32(t)).unwrap()),
            *trezor_pub
        );
        let r = cpace_host(&code, &hh, &h32(k), &h32(trezor_pub)).unwrap();
        assert_eq!(hex::encode(r.public_key), *host_pub);
        assert_eq!(hex::encode(r.tag), *tag);
        let mut other = code;
        other[5] = b'0' + (other[5] - b'0' + 1) % 10;
        let r2 = cpace_host(&other, &hh, &h32(k), &h32(trezor_pub)).unwrap();
        assert_ne!(r2.public_key, r.public_key);
    }
}

#[test]
fn cpace_rejects_low_order_device_keys() {
    for p in [
        "0000000000000000000000000000000000000000000000000000000000000000",
        "0100000000000000000000000000000000000000000000000000000000000000",
        "e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800",
        "5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157",
        "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
    ] {
        assert!(matches!(
            cpace_host(b"123456", &[1; 32], &[2; 32], &h32(p)),
            Err(HwError::PairingFailed(_))
        ));
    }
}

#[test]
fn pairing_code_matches_trezorlib() {
    // SHA-256(CodeEntry ‖ h ‖ secret ‖ challenge) mod 10^6, as in trezorlib
    // `CodeEntry.send_code` (vectors generated with that code).
    for (hh, secret, challenge, code) in [
        (
            "9b80e7d2a2978473c4b0b06b934010db620fefba6d449627eb38f0fb5d87c84e",
            "ec18eac8d758b1eba52d3c10d39adc6d",
            "122c597083bd438b7f6d72af75d02594",
            "942297",
        ),
        (
            "5a56a177fae1b31823ae3599b3752de6edc004e961eaffcd3dbbfd0ede0461f8",
            "e8bc163c82eee18733288c7d4ac636db",
            "d0f631ca1ddba8db3bcfcb9e057cdc98",
            "474511",
        ),
        (
            "47bda54fef34d99dab44a72118cb7269b688ead9f24adc42f53146bd0b7fd59c",
            "ad328846aa18b32a335816374511cac1",
            "9c0abe51c6e6655d81de2d044d4fb194",
            "165835",
        ),
        (
            "15cac8f0cadd4aa2e2a617e1fae5ba7f5bb901ec1860cbeda6e2d26de8261ce7",
            "41242b9fae56fad4e6e77dfe33cb18d1",
            "7c1c97df17c066924822b0af09a65251",
            "596619",
        ),
    ] {
        assert_eq!(
            &code_entry_value(&h32(hh), &h(secret), &h(challenge)),
            code.as_bytes()
        );
    }
}

#[test]
fn masked_static_key_matching() {
    let masked = h32("be8d024bbcd5ac116e041035fcc6243ce1d77d7075e351c87aa0831fbf46ce66");
    let eph = h32("f817f577f24d7ec08c1ea397df2da916e0ee81423961763dc45395e18fc02121");
    assert!(!mask_matches(
        &h32("1317c99c16fce04935782ed250cf0cacb12216f739cea55257258a2ff9440763"),
        &eph,
        &masked
    ));
    assert!(mask_matches(
        &h32("2bcdbc9fd7949c3f37aa80a53801f52ec554facfe76118030926294250fd6838"),
        &eph,
        &masked
    ));
}

type React = Box<dyn FnMut(&Frame, &mut VecDeque<Packet>) + Send>;

struct Peer {
    reasm: Reassembler,
    out: VecDeque<Packet>,
    react: React,
    writes: Arc<Mutex<Vec<Frame>>>,
}

impl PacketIo for Peer {
    fn write_packet(&mut self, p: &Packet) -> HwResult<()> {
        if let Some(f) = self.reasm.push(p) {
            lock(&self.writes).push(f.clone());
            (self.react)(&f, &mut self.out);
        }
        Ok(())
    }
    fn read_packet(&mut self) -> HwResult<Option<Packet>> {
        let p = self.out.pop_front();
        if p.is_none() {
            std::thread::sleep(Duration::from_millis(2));
        }
        Ok(p)
    }
}

fn peer(react: React) -> (Channel<Peer>, Arc<Mutex<Vec<Frame>>>) {
    let writes = Arc::new(Mutex::new(Vec::new()));
    let p = Peer {
        reasm: Reassembler::default(),
        out: VecDeque::new(),
        react,
        writes: writes.clone(),
    };
    (Channel::for_tests(p, 0x1234), writes)
}

fn pk(cb: u8, data: &[u8]) -> Vec<Packet> {
    packets(cb, 0x1234, data).unwrap()
}

fn ack_for(cb: u8) -> u8 {
    CB_ACK | if seq_bit(cb) { ACK_BIT } else { 0 }
}

#[test]
fn sender_retransmits_until_the_right_ack() {
    let mut n = 0;
    let (mut ch, writes) = peer(Box::new(move |f, out| {
        n += 1;
        match n {
            1 | 2 => {} // lost
            3 => out.extend(pk(ack_for(f.cb), &[])),
            4 => {
                out.extend(pk(CB_ACK, &[])); // stale ACK of the previous message
                out.extend(pk(CB_ERROR, &[ERR_BUSY])); // busy: back off, resend
            }
            _ => out.extend(pk(ack_for(f.cb), &[])),
        }
    }));
    let l = limit(10_000);
    ch.send_reliable(&l, ENCRYPTED, b"one").unwrap();
    ch.send_reliable(&l, ENCRYPTED, b"two").unwrap();
    let w: Vec<u8> = lock(&writes).iter().map(|f| f.cb).collect();
    assert_eq!(w, vec![0x04, 0x04, 0x04, 0x14, 0x14]);
    assert!(!ch.send_bit);
}

#[test]
fn sender_gives_up_or_fails_fast() {
    let (mut ch, writes) = peer(Box::new(|_, _| {}));
    let started = Instant::now();
    assert_eq!(
        ch.send_reliable(&limit(60_000), ENCRYPTED, b"x"),
        Err(HwError::Disconnected)
    );
    assert_eq!(lock(&writes).len() as u32, MAX_RETRANSMISSIONS + 1);
    assert!(started.elapsed() < Duration::from_secs(5));
    let (mut ch, _) = peer(Box::new(|_, out| {
        out.extend(pk(CB_ERROR, &[ERR_UNALLOCATED]))
    }));
    assert_eq!(
        ch.send_reliable(&limit(60_000), ENCRYPTED, b"x"),
        Err(HwError::Disconnected)
    );
    let (mut ch, _) = peer(Box::new(|_, _| {}));
    assert_eq!(ch.recv(&limit(150)), Err(HwError::Timeout));
    let l = limit(60_000);
    lock(&l).cancel = Some(Arc::new(AtomicBool::new(true)));
    assert_eq!(ch.recv(&l), Err(HwError::Cancelled));
}

#[test]
fn receiver_acks_and_drops_duplicates() {
    let (mut ch, writes) = peer(Box::new(|_, _| {}));
    ch.io.out.extend(pk(ENCRYPTED, b"A"));
    ch.io.out.extend(pk(ENCRYPTED, b"A")); // our ACK was lost: resent
    ch.io.out.extend(pk(CB_ACK, &[])); // stray ACK: ignored
    ch.io
        .out
        .extend(packets(ENCRYPTED | SEQ_BIT, 0x9999, b"X").unwrap());
    ch.io.out.extend(pk(ENCRYPTED | SEQ_BIT, b"B"));
    let l = limit(5_000);
    assert_eq!(ch.recv(&l).unwrap().data, b"A");
    assert_eq!(ch.recv(&l).unwrap().data, b"B");
    let acks: Vec<u8> = lock(&writes).iter().map(|f| f.cb).collect();
    assert_eq!(acks, vec![CB_ACK, CB_ACK, CB_ACK | ACK_BIT]);
}
