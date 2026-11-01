//! Trezor Host Protocol (THP, "protocol v2"), host side: the encrypted channel spoken by the
//! Trezor Safe 7 (T3W1) and later models, over the same WebUSB interface and 64-byte packets
//! as the older models.
//!
//! Specification: trezor-firmware `docs/common/thp/specification.md` and `sessions.md`.
//! Cross-checked against python-trezorlib (`trezorlib/thp/`), Trezor Suite
//! (`@trezor/protocol`, `protocol-thp`) and, in the tests, Trezor's own device-side Rust crate
//! `trezor-thp` (the code that runs in the firmware, see `thp_sim.rs`).
//!
//! Layers, as implemented here:
//! - **Transport**: control byte + channel id + length, CRC-32 (IEEE) over each payload,
//!   segmentation into 64-byte packets, Alternating Bit Protocol (1-bit sequence number, explicit
//!   ACKs, retransmission). Kyro never asks for ACK piggybacking (protocol 2.1 option), so the
//!   device stays in the simpler half-duplex 2.0 mode.
//! - **Handshake**: `Noise_XX_25519_AESGCM_SHA256` (crate `snow`), prologue = the device
//!   properties of the channel allocation response. The device presents a *masked* static key
//!   `X25519(SHA-256(S ‖ e), S)`, so a credential can only be matched by a host that already
//!   knows `S`.
//! - **Pairing**: Code Entry only (the only method production firmware offers): the device shows
//!   a 6-digit code, the user types it into Kyro, CPace over Curve25519 proves both sides know
//!   it, and the device's commitment/secret proves the code was not chosen after seeing Kyro's
//!   challenge.
//! - **Credentials**: after pairing, the device issues an opaque credential bound to Kyro's
//!   static key; stored by [`super::thp_store`]. With it, later connections skip the code (the
//!   device still asks to confirm the connection, Kyro never requests "autoconnect").
//! - **Application**: session byte + message type + protobuf: the same messages as protocol v1
//!   (`GetPublicKey`, `SignTx`, `EthereumSignTxEIP1559`, `SolanaSignTx`…).
//!
//! Every wait is bounded by the caller's deadline and cancellation flag (checked between
//! 100 ms reads) and by a retransmission budget.

use std::sync::atomic::Ordering;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use curve25519_dalek::edwards::EdwardsPoint;
use curve25519_dalek::montgomery::MontgomeryPoint;
use curve25519_dalek::scalar::Scalar;
use curve25519_dalek::traits::IsIdentity;
use protobuf::Message;
use sha2::{Digest, Sha256, Sha512};
use trezor_client::protos;
use wallet_core::Zeroizing;

use super::thp_store::{Pairing, ThpEnv};
use super::trezor::Limit;
use super::{lock, Ctl, HwError, HwResult, Prompt};

/// USB packet size (spec "USB packet size").
pub const PACKET: usize = 64;
pub type Packet = [u8; PACKET];

const BROADCAST: u16 = 0xFFFF;

// Control bytes (spec "Transport packet structure").
const CB_CONTINUATION: u8 = 0x80;
const CB_ALLOC_REQ: u8 = 0x40;
const CB_ALLOC_RES: u8 = 0x41;
const CB_ERROR: u8 = 0x42;
const CB_CODEC_V1: u8 = 0x3F;
const CB_ACK: u8 = 0x20;
const ACK_MASK: u8 = 0xF7;
const DATA_DETECT_MASK: u8 = 0xE0;
const DATA_MASK: u8 = 0xE7;
const SEQ_BIT: u8 = 0x10;
const ACK_BIT: u8 = 0x08;
const HS_INIT_REQ: u8 = 0x00;
const HS_INIT_RES: u8 = 0x01;
const HS_COMP_REQ: u8 = 0x02;
const HS_COMP_RES: u8 = 0x03;
const ENCRYPTED: u8 = 0x04;

// Transport error codes (spec "Allocation layer").
const ERR_BUSY: u8 = 1;
const ERR_UNALLOCATED: u8 = 2;
const ERR_DECRYPTION: u8 = 3;
const ERR_LOCKED: u8 = 5;

/// Wait for an ACK this long before retransmitting (trezorlib uses 0.5 s; shorter in tests).
pub const ACK_TIMEOUT: Duration = Duration::from_millis(if cfg!(test) { 60 } else { 500 });
/// Retransmissions of one message before the channel is declared dead (spec suggests ≤ 50).
pub const MAX_RETRANSMISSIONS: u32 = 10;
/// Channel allocation: attempts, and wait per attempt (no ACK on the broadcast channel).
const ALLOC_ATTEMPTS: u32 = 3;
const ALLOC_WAIT: Duration = Duration::from_secs(2);

/// Application message types used outside the regular protobuf mapping
/// (`messages-thp.proto`, `ThpMessageType`; 2, 3, 20, 26, 27 are shared with protocol v1).
pub mod mt {
    pub const FAILURE: u16 = 3;
    pub const CANCEL: u16 = 20;
    pub const BUTTON_REQUEST: u16 = 26;
    pub const BUTTON_ACK: u16 = 27;
    pub const PAIRING_REQUEST: u16 = 1008;
    pub const PAIRING_REQUEST_APPROVED: u16 = 1009;
    pub const SELECT_METHOD: u16 = 1010;
    pub const CREDENTIAL_REQUEST: u16 = 1016;
    pub const CREDENTIAL_RESPONSE: u16 = 1017;
    pub const END_REQUEST: u16 = 1018;
    pub const END_RESPONSE: u16 = 1019;
    pub const CODE_ENTRY_COMMITMENT: u16 = 1024;
    pub const CODE_ENTRY_CHALLENGE: u16 = 1025;
    pub const CODE_ENTRY_CPACE_TREZOR: u16 = 1026;
    pub const CODE_ENTRY_CPACE_HOST_TAG: u16 = 1027;
    pub const CODE_ENTRY_SECRET: u16 = 1028;
}

/// `ThpPairingMethod.CodeEntry`.
pub const METHOD_CODE_ENTRY: u8 = 2;
/// `trezor_state` in the handshake completion response.
pub const STATE_UNPAIRED: u8 = 0;
pub const STATE_PAIRED: u8 = 1;
pub const STATE_PAIRED_AUTOCONNECT: u8 = 2;

const NOISE_PARAMS: &str = "Noise_XX_25519_AESGCM_SHA256";
/// Largest handshake message on the wire (init response: 32 + 48 + 16; completion request
/// carries a credential of at most a few hundred bytes).
const HANDSHAKE_BUF: usize = 4096;
/// Maximum credential size: the device-side limit of Trezor's `trezor-thp` (firmware
/// credentials are ~50 bytes: metadata + 32-byte MAC).
pub const MAX_CREDENTIAL_LEN: usize = 128;

// ---------------------------------------------------------------- packet I/O

/// 64-byte packet link (WebUSB interrupt endpoints, or a simulated device in tests).
pub trait PacketIo: Send {
    fn write_packet(&mut self, packet: &Packet) -> HwResult<()>;
    /// Waits at most one short slice (≤ [`super::POLL`]); `None` when nothing arrived.
    fn read_packet(&mut self) -> HwResult<Option<Packet>>;
}

/// CRC-32/ISO-HDLC ("CRC-32-IEEE", reflected polynomial 0xEDB88320), as THP specifies. This is
/// the transport's error-detection code, not a security measure (AES-GCM authenticates the
/// encrypted traffic). Bitwise implementation: messages are small, speed is irrelevant.
pub fn crc32(data: &[u8]) -> u32 {
    let mut crc = !0u32;
    for &b in data {
        crc ^= u32::from(b);
        for _ in 0..8 {
            crc = (crc >> 1) ^ (0xEDB8_8320 & (crc & 1).wrapping_neg());
        }
    }
    !crc
}

/// One reassembled, CRC-checked transport payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub cb: u8,
    pub cid: u16,
    pub data: Vec<u8>,
}

/// Segments one transport payload: initiation packet (control byte, channel id, length of
/// payload + CRC), then continuation packets (0x80, channel id); null-padded.
pub fn packets(cb: u8, cid: u16, data: &[u8]) -> HwResult<Vec<Packet>> {
    let len = u16::try_from(data.len() + 4).map_err(|_| HwError::bad("THP message too long"))?;
    let mut body = Vec::with_capacity(5 + data.len() + 4);
    body.push(cb);
    body.extend(cid.to_be_bytes());
    body.extend(len.to_be_bytes());
    body.extend(data);
    let crc = crc32(&body);
    body.extend(crc.to_be_bytes());
    let mut out = Vec::new();
    let first = body.len().min(PACKET);
    let mut p = [0u8; PACKET];
    p[..first].copy_from_slice(&body[..first]);
    out.push(p);
    for chunk in body[first..].chunks(PACKET - 3) {
        let mut p = [0u8; PACKET];
        p[0] = CB_CONTINUATION;
        p[1..3].copy_from_slice(&cid.to_be_bytes());
        p[3..3 + chunk.len()].copy_from_slice(chunk);
        out.push(p);
    }
    Ok(out)
}

/// Reassembles packets into frames (spec "Segmenting layer"): a new initiation packet
/// restarts reassembly, stray continuations are dropped, a bad CRC drops the payload (the
/// peer retransmits it since it is never acknowledged).
#[derive(Default)]
pub struct Reassembler {
    cur: Option<(u8, u16, usize, Vec<u8>)>,
}

impl Reassembler {
    pub fn push(&mut self, p: &Packet) -> Option<Frame> {
        let cb = p[0];
        let cid = u16::from_be_bytes([p[1], p[2]]);
        if cb & CB_CONTINUATION != 0 {
            let (_, want, _, got) = self.cur.as_mut()?;
            if *want != cid {
                return None;
            }
            got.extend_from_slice(&p[3..]);
        } else {
            if cb == CB_CODEC_V1 {
                // A protocol-v1 packet: never addressed to a THP host.
                return None;
            }
            let len = usize::from(u16::from_be_bytes([p[3], p[4]]));
            if len < 4 {
                self.cur = None;
                return None;
            }
            self.cur = Some((cb, cid, len, p[5..].to_vec()));
        }
        let done = self
            .cur
            .as_ref()
            .is_some_and(|(_, _, len, got)| got.len() >= *len);
        if !done {
            return None;
        }
        let (cb, cid, len, mut got) = self.cur.take()?;
        got.truncate(len);
        let crc = u32::from_be_bytes(got[len - 4..].try_into().ok()?);
        got.truncate(len - 4);
        let mut checked = Vec::with_capacity(5 + got.len());
        checked.push(cb);
        checked.extend(cid.to_be_bytes());
        checked.extend((len as u16).to_be_bytes());
        checked.extend(&got);
        if crc32(&checked) != crc {
            return None;
        }
        Some(Frame { cb, cid, data: got })
    }
}

fn is_data(cb: u8) -> bool {
    cb & DATA_DETECT_MASK == 0
}

/// Sequence bit of a data frame. The exact handshake control bytes without the bit set map
/// like python-trezorlib does (`HANDSHAKE_SEQ_BITS`), for early Safe 7 firmware that did not
/// toggle it on the handshake (fixed in 2.9.4, `#6138`).
pub fn seq_bit(cb: u8) -> bool {
    match cb {
        HS_INIT_REQ | HS_INIT_RES => false,
        HS_COMP_REQ | HS_COMP_RES => true,
        _ => cb & SEQ_BIT != 0,
    }
}

fn check(limit: &Mutex<Limit>) -> HwResult<()> {
    let l = lock(limit);
    if l.cancel.as_ref().is_some_and(|c| c.load(Ordering::SeqCst)) {
        return Err(HwError::Cancelled);
    }
    if Instant::now() >= l.deadline {
        return Err(HwError::Timeout);
    }
    Ok(())
}

fn transport_error(code: Option<u8>) -> HwError {
    match code {
        Some(ERR_LOCKED) => HwError::Locked,
        Some(ERR_BUSY) => HwError::Busy("the device is busy with another channel".into()),
        // The device dropped the channel (restart, too many hosts) or could not decrypt.
        Some(ERR_UNALLOCATED) | Some(ERR_DECRYPTION) => HwError::Disconnected,
        other => HwError::bad(format!("THP transport error {other:?}")),
    }
}

fn random<const N: usize>() -> HwResult<Zeroizing<[u8; N]>> {
    let mut out = Zeroizing::new([0u8; N]);
    getrandom::getrandom(&mut out[..])
        .map_err(|_| HwError::Internal("system randomness unavailable".into()))?;
    Ok(out)
}

fn snow_err(e: snow::Error) -> HwError {
    HwError::bad(format!("THP handshake: {e}"))
}

// ---------------------------------------------------------------- crypto helpers

/// `X25519(SHA-256(S ‖ e), S) == masked`: does stored device key `S` explain the masked static
/// key presented with ephemeral key `e` (spec state HH1, step 11)?
pub fn mask_matches(trezor_static: &[u8; 32], ephemeral: &[u8; 32], masked: &[u8; 32]) -> bool {
    let mut h = Sha256::new();
    h.update(trezor_static);
    h.update(ephemeral);
    let mask: [u8; 32] = h.finalize().into();
    MontgomeryPoint(*trezor_static).mul_clamped(mask).to_bytes() == *masked
}

/// CPace generator string (draft-irtf-cfrg-cpace, CPace255, symmetric setting, empty sid and
/// associated data): `lv(DSI) ‖ lv(code) ‖ lv(zpad) ‖ lv(handshake hash) ‖ lv(sid)`.
fn cpace_generator_string(code: &[u8; 6], handshake_hash: &[u8; 32]) -> Vec<u8> {
    let mut s = vec![0x08, b'C', b'P', b'a', b'c', b'e', b'2', b'5', b'5', 0x06];
    s.extend(code);
    s.push(0x6f);
    s.extend([0u8; 111]);
    s.push(0x20);
    s.extend(handshake_hash);
    s.push(0x00);
    s
}

/// `X25519(k, G)` for the CPace generator `G = ELLIGATOR2(SHA-512(gen_str)[..32])`.
///
/// curve25519-dalek 4.1.3 exposes its Elligator2 map (`montgomery::elligator_encode`, the
/// RFC 9380 `map_to_curve_elligator2` for Curve25519) only through
/// `EdwardsPoint::nonspec_map_to_curve::<Sha512>(bytes)`, which hashes `bytes` with SHA-512,
/// maps the first 32 bytes (top bit ignored, as RFC 7748 `decodeUCoordinate`) and returns
/// `8·G`. Because X25519 clamps `k` to a multiple of 8, `X25519(k, G) = u((clamp(k) / 8) · 8G)`
/// exactly; `clamp(k) / 8 < 2^252 < ℓ`, so it is a canonical scalar and `8G` has order ℓ (or is
/// the identity, rejected). No field arithmetic is done here; checked against trezorlib's own
/// pure-Python CPace (tests).
fn cpace_public(gen_str: &[u8], k: &[u8; 32]) -> HwResult<[u8; 32]> {
    #[allow(deprecated)] // the "nonspec" name refers to the hashing step, which matches CPace
    let g8 = EdwardsPoint::nonspec_map_to_curve::<Sha512>(gen_str);
    if g8.is_identity() {
        return Err(HwError::bad("low-order CPace generator"));
    }
    let mut c = *k;
    c[0] &= 248;
    c[31] &= 127;
    c[31] |= 64;
    let mut div8 = Zeroizing::new([0u8; 32]);
    for i in 0..32 {
        div8[i] = (c[i] >> 3) | c.get(i + 1).map_or(0, |n| n << 5);
    }
    c.fill(0);
    let s = Option::<Scalar>::from(Scalar::from_canonical_bytes(*div8))
        .ok_or_else(|| HwError::bad("invalid CPace scalar"))?;
    let public = (g8.to_montgomery() * s).to_bytes();
    if public.iter().all(|b| *b == 0) {
        return Err(HwError::bad("zero CPace key"));
    }
    Ok(public)
}

pub struct CpaceHost {
    pub public_key: [u8; 32],
    /// SHA-256 of the shared secret (`ThpCodeEntryCpaceHostTag.tag`).
    pub tag: [u8; 32],
}

/// Host side of the Code Entry CPace exchange (spec state HP4): Kyro's public key on the
/// code-derived generator, and the tag over `X25519(k, trezor_public_key)`.
pub fn cpace_host(
    code: &[u8; 6],
    handshake_hash: &[u8; 32],
    private_key: &[u8; 32],
    trezor_public_key: &[u8; 32],
) -> HwResult<CpaceHost> {
    let public_key = cpace_public(&cpace_generator_string(code, handshake_hash), private_key)?;
    let shared = Zeroizing::new(
        MontgomeryPoint(*trezor_public_key)
            .mul_clamped(*private_key)
            .to_bytes(),
    );
    // A low-order device key gives an all-zero secret: refuse it (the firmware does the same
    // on its side since 2.12.2).
    if shared.iter().all(|b| *b == 0) {
        return Err(HwError::PairingFailed(
            "invalid CPace key from the device".into(),
        ));
    }
    Ok(CpaceHost {
        public_key,
        tag: Sha256::digest(&shared[..]).into(),
    })
}

/// The 6-digit code the device shows: `SHA-256(CodeEntry ‖ h ‖ secret ‖ challenge) mod 10^6`
/// (big-endian integer), formatted with leading zeros.
pub fn code_entry_value(handshake_hash: &[u8; 32], secret: &[u8], challenge: &[u8]) -> [u8; 6] {
    let mut h = Sha256::new();
    h.update([METHOD_CODE_ENTRY]);
    h.update(handshake_hash);
    h.update(secret);
    h.update(challenge);
    let d = h.finalize();
    let v = d
        .iter()
        .fold(0u64, |acc, b| (acc * 256 + u64::from(*b)) % 1_000_000);
    let mut out = [b'0'; 6];
    let mut v = v;
    for i in (0..6).rev() {
        out[i] = b'0' + (v % 10) as u8;
        v /= 10;
    }
    out
}

fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

// ---------------------------------------------------------------- channel

/// What the device advertised in the channel allocation response.
#[derive(Debug, Clone)]
pub struct DeviceProps {
    pub internal_model: String,
    pub protocol_major: u32,
    pub protocol_minor: u32,
    pub pairing_methods: Vec<u8>,
    /// Encoded `ThpDeviceProperties`: the Noise prologue.
    pub raw: Vec<u8>,
}

fn parse_props(raw: &[u8]) -> HwResult<DeviceProps> {
    let p = protos::ThpDeviceProperties::parse_from_bytes(raw)
        .map_err(|e| HwError::bad(format!("invalid THP properties: {e}")))?;
    Ok(DeviceProps {
        internal_model: p.internal_model().to_string(),
        protocol_major: p.protocol_version_major(),
        protocol_minor: p.protocol_version_minor(),
        pairing_methods: p
            .pairing_methods
            .iter()
            .filter_map(|m| u8::try_from(m.value()).ok())
            .collect(),
        raw: raw.to_vec(),
    })
}

/// Result of the Noise handshake.
pub struct Handshake {
    pub trezor_state: u8,
    /// Index into the credentials that matched the device's masked key.
    pub matched: Option<usize>,
    pub masked_static: [u8; 32],
    pub trezor_ephemeral: [u8; 32],
}

/// One THP channel (allocated, then handshaken).
pub struct Channel<P: PacketIo> {
    pub io: P,
    cid: u16,
    send_bit: bool,
    recv_bit: bool,
    reasm: Reassembler,
    noise: Option<snow::TransportState>,
    handshake_hash: [u8; 32],
    pub props: DeviceProps,
    /// The device's (unmasked) static public key, once known (matched credential or newly
    /// issued one).
    pub trezor_static: Option<[u8; 32]>,
}

impl<P: PacketIo> Channel<P> {
    /// Channel allocation on the broadcast channel (spec "Allocation layer").
    pub fn allocate(mut io: P, limit: &Mutex<Limit>) -> HwResult<Self> {
        let mut reasm = Reassembler::default();
        for _ in 0..ALLOC_ATTEMPTS {
            let nonce = random::<8>()?;
            for p in packets(CB_ALLOC_REQ, BROADCAST, &nonce[..])? {
                io.write_packet(&p)?;
            }
            let until = Instant::now() + ALLOC_WAIT;
            while Instant::now() < until {
                check(limit)?;
                let Some(p) = io.read_packet()? else {
                    continue;
                };
                let Some(f) = reasm.push(&p) else {
                    continue;
                };
                if f.cid != BROADCAST
                    || f.cb != CB_ALLOC_RES
                    || f.data.len() < 10
                    || f.data[..8] != nonce[..]
                {
                    continue; // someone else's allocation, or a stale packet
                }
                let cid = u16::from_be_bytes([f.data[8], f.data[9]]);
                if cid == 0 || cid >= 0xFFF0 {
                    return Err(HwError::bad(format!("reserved THP channel id {cid:04x}")));
                }
                let props = parse_props(&f.data[10..])?;
                return Ok(Channel {
                    io,
                    cid,
                    send_bit: false,
                    recv_bit: false,
                    reasm: Reassembler::default(),
                    noise: None,
                    handshake_hash: [0; 32],
                    props,
                    trezor_static: None,
                });
            }
        }
        Err(HwError::Disconnected)
    }

    #[cfg(test)]
    fn for_tests(io: P, cid: u16) -> Self {
        Channel {
            io,
            cid,
            send_bit: false,
            recv_bit: false,
            reasm: Reassembler::default(),
            noise: None,
            handshake_hash: [0; 32],
            props: DeviceProps {
                internal_model: String::new(),
                protocol_major: 2,
                protocol_minor: 0,
                pairing_methods: vec![],
                raw: vec![],
            },
            trezor_static: None,
        }
    }

    fn read_frame(&mut self) -> HwResult<Option<Frame>> {
        match self.io.read_packet()? {
            Some(p) => Ok(self.reasm.push(&p)),
            None => Ok(None),
        }
    }

    fn send_ack(&mut self, bit: bool) -> HwResult<()> {
        let cb = CB_ACK | if bit { ACK_BIT } else { 0 };
        for p in packets(cb, self.cid, &[])? {
            self.io.write_packet(&p)?;
        }
        Ok(())
    }

    /// Sends one data payload and waits for its ACK, retransmitting on timeout (ABP sender).
    fn send_reliable(&mut self, limit: &Mutex<Limit>, cb: u8, data: &[u8]) -> HwResult<()> {
        let cb = cb | if self.send_bit { SEQ_BIT } else { 0 };
        let pkts = packets(cb, self.cid, data)?;
        let mut backoff = Duration::from_millis(100);
        for _ in 0..=MAX_RETRANSMISSIONS {
            for p in &pkts {
                self.io.write_packet(p)?;
            }
            let until = Instant::now() + ACK_TIMEOUT;
            'wait: while Instant::now() < until {
                check(limit)?;
                let Some(f) = self.read_frame()? else {
                    continue;
                };
                if f.cid != self.cid {
                    continue;
                }
                if f.cb & ACK_MASK == CB_ACK {
                    if f.data.is_empty() && (f.cb & ACK_BIT != 0) == self.send_bit {
                        self.send_bit = !self.send_bit;
                        return Ok(());
                    }
                    continue; // duplicate ACK of an older message
                }
                if f.cb == CB_ERROR {
                    if f.data.first() == Some(&ERR_BUSY) {
                        let end = Instant::now() + backoff;
                        while Instant::now() < end {
                            check(limit)?;
                            std::thread::sleep(Duration::from_millis(20));
                        }
                        backoff = (backoff * 2).min(Duration::from_millis(500));
                        break 'wait;
                    }
                    return Err(transport_error(f.data.first().copied()));
                }
                if is_data(f.cb) {
                    let s = seq_bit(f.cb);
                    if s != self.recv_bit {
                        // Our ACK of the device's previous message was lost: ACK it again.
                        self.send_ack(s)?;
                    }
                    // Otherwise the device answered before ACKing (impossible in half-duplex
                    // mode): ignore it, the device resends it until we ACK.
                }
            }
        }
        Err(HwError::Disconnected)
    }

    /// Waits for the next data payload from the device (ABP receiver), ACKs it, drops
    /// duplicates.
    fn recv(&mut self, limit: &Mutex<Limit>) -> HwResult<Frame> {
        loop {
            check(limit)?;
            let Some(f) = self.read_frame()? else {
                continue;
            };
            if f.cid != self.cid || f.cb & ACK_MASK == CB_ACK {
                continue;
            }
            if f.cb == CB_ERROR {
                return Err(transport_error(f.data.first().copied()));
            }
            if !is_data(f.cb) {
                continue;
            }
            let s = seq_bit(f.cb);
            self.send_ack(s)?;
            if s != self.recv_bit {
                continue; // retransmission of a message already received
            }
            self.recv_bit = !self.recv_bit;
            return Ok(f);
        }
    }

    /// Noise XX handshake (spec states HH0–HH3). `try_to_unlock` asks a locked device to show
    /// its PIN screen instead of answering `DEVICE_LOCKED`.
    pub fn handshake(
        &mut self,
        limit: &Mutex<Limit>,
        host_key: &[u8; 32],
        known: &[Pairing],
        try_to_unlock: bool,
    ) -> HwResult<Handshake> {
        let params = NOISE_PARAMS
            .parse()
            .map_err(|_| HwError::Internal("Noise parameters".into()))?;
        let builder = snow::Builder::new(params)
            .local_private_key(host_key)
            .map_err(snow_err)?
            .prologue(&self.props.raw)
            .map_err(snow_err)?;
        #[cfg(test)]
        let fixed = test_hooks::EPHEMERAL.with(|e| *e.borrow());
        #[cfg(test)]
        let builder = match &fixed {
            Some(e) => builder.fixed_ephemeral_key_for_testing_only(e),
            None => builder,
        };
        let mut hs = builder.build_initiator().map_err(snow_err)?;
        let mut buf = Zeroizing::new(vec![0u8; HANDSHAKE_BUF]);
        let n = hs
            .write_message(&[u8::from(try_to_unlock)], &mut buf)
            .map_err(snow_err)?;
        test_hooks::record(&buf[..n]);
        self.send_reliable(limit, HS_INIT_REQ, &buf[..n])?;

        let resp = self.recv(limit)?;
        test_hooks::record(&resp.data);
        if resp.cb & DATA_MASK != HS_INIT_RES || resp.data.len() != 32 + 48 + 16 {
            return Err(HwError::bad("unexpected THP initiation response"));
        }
        let mut payload = Zeroizing::new(vec![0u8; HANDSHAKE_BUF]);
        if hs
            .read_message(&resp.data, &mut payload)
            .map_err(snow_err)?
            != 0
        {
            return Err(HwError::bad("unexpected data in the initiation response"));
        }
        let masked: [u8; 32] = hs
            .get_remote_static()
            .and_then(|k| k.try_into().ok())
            .ok_or_else(|| HwError::bad("missing device static key"))?;
        let eph: [u8; 32] = resp.data[..32]
            .try_into()
            .map_err(|_| HwError::bad("ephemeral key"))?;
        let matched = known
            .iter()
            .position(|p| mask_matches(&p.trezor_key, &eph, &masked));

        let mut noise_payload = protos::ThpHandshakeCompletionReqNoisePayload::new();
        if let Some(i) = matched {
            noise_payload.set_host_pairing_credential(known[i].credential.clone());
        }
        let noise_payload = Zeroizing::new(
            noise_payload
                .write_to_bytes()
                .map_err(|e| HwError::bad(e.to_string()))?,
        );
        let n = hs
            .write_message(&noise_payload, &mut buf)
            .map_err(snow_err)?;
        test_hooks::record(&buf[..n]);
        self.send_reliable(limit, HS_COMP_REQ, &buf[..n])?;
        self.handshake_hash = hs
            .get_handshake_hash()
            .try_into()
            .map_err(|_| HwError::bad("handshake hash"))?;
        test_hooks::record(&self.handshake_hash);
        let mut ts = hs.into_transport_mode().map_err(snow_err)?;

        let resp = self.recv(limit)?;
        test_hooks::record(&resp.data);
        if resp.cb & DATA_MASK != HS_COMP_RES {
            return Err(HwError::bad("unexpected THP handshake completion response"));
        }
        let mut state = [0u8; 64];
        let n = ts
            .read_message(&resp.data, &mut state)
            .map_err(|_| HwError::bad("undecryptable THP state"))?;
        if n != 1 || state[0] > STATE_PAIRED_AUTOCONNECT {
            return Err(HwError::bad("invalid THP state"));
        }
        if matched.is_none() && state[0] != STATE_UNPAIRED {
            // HH3: without a credential the device cannot say "paired".
            return Err(HwError::bad(
                "the device claims to be paired without a credential",
            ));
        }
        self.noise = Some(ts);
        Ok(Handshake {
            trezor_state: state[0],
            matched,
            masked_static: masked,
            trezor_ephemeral: eph,
        })
    }

    /// Encrypted application message: `session ‖ type (BE) ‖ protobuf`.
    pub fn send_app(
        &mut self,
        limit: &Mutex<Limit>,
        session: u8,
        msg_type: u16,
        payload: &[u8],
    ) -> HwResult<()> {
        let noise = self.noise.as_mut().ok_or(HwError::Disconnected)?;
        let mut pt = Zeroizing::new(Vec::with_capacity(3 + payload.len()));
        pt.push(session);
        pt.extend(msg_type.to_be_bytes());
        pt.extend(payload);
        if pt.len() + 16 + 4 > usize::from(u16::MAX) {
            return Err(HwError::bad("message too long for THP"));
        }
        let mut ct = vec![0u8; pt.len() + 16];
        let n = noise
            .write_message(&pt, &mut ct)
            .map_err(|e| HwError::bad(format!("THP encryption: {e}")))?;
        self.send_reliable(limit, ENCRYPTED, &ct[..n])
    }

    pub fn recv_app(&mut self, limit: &Mutex<Limit>) -> HwResult<(u8, u16, Vec<u8>)> {
        let f = self.recv(limit)?;
        if f.cb & DATA_MASK != ENCRYPTED {
            return Err(HwError::bad("unencrypted THP message"));
        }
        let noise = self.noise.as_mut().ok_or(HwError::Disconnected)?;
        let mut pt = vec![0u8; f.data.len()];
        let n = noise
            .read_message(&f.data, &mut pt)
            .map_err(|_| HwError::bad("undecryptable THP message"))?;
        if n < 3 {
            return Err(HwError::bad("THP message too short"));
        }
        pt.truncate(n);
        let session = pt[0];
        let msg_type = u16::from_be_bytes([pt[1], pt[2]]);
        Ok((session, msg_type, pt.split_off(3)))
    }
}

// ---------------------------------------------------------------- pairing & credentials

fn decode<M: Message>(data: &[u8], what: &str) -> HwResult<M> {
    M::parse_from_bytes(data).map_err(|e| HwError::bad(format!("invalid {what}: {e}")))
}

fn encode<M: Message>(m: &M) -> HwResult<Vec<u8>> {
    m.write_to_bytes()
        .map_err(|e| HwError::bad(format!("protobuf encoding: {e}")))
}

fn pairing_failure(data: &[u8], wrong_code: bool) -> HwError {
    use protos::failure::FailureType as F;
    let Ok(f) = protos::Failure::parse_from_bytes(data) else {
        return HwError::bad("unreadable THP failure");
    };
    match f.code() {
        F::Failure_ActionCancelled | F::Failure_PinCancelled => HwError::Rejected,
        F::Failure_DataError if wrong_code => {
            HwError::PairingFailed("wrong code: the device rejected it".into())
        }
        F::Failure_Busy | F::Failure_InProgress => HwError::Busy("the device is busy".into()),
        code => HwError::bad(format!("THP pairing: {code:?} « {} »", f.message())),
    }
}

impl<P: PacketIo> Channel<P> {
    /// One request in the pairing/credential phase (session 0). Button requests are
    /// acknowledged and reported to the UI as `prompt`.
    fn pairing_call(
        &mut self,
        limit: &Mutex<Limit>,
        ctl: &Ctl,
        msg_type: u16,
        payload: &[u8],
        expect: u16,
        prompt: Prompt,
    ) -> HwResult<Vec<u8>> {
        // A data error answering Kyro's CPace tag means the typed code was wrong.
        let wrong_code = msg_type == mt::CODE_ENTRY_CPACE_HOST_TAG;
        self.send_app(limit, 0, msg_type, payload)?;
        loop {
            let (_session, t, data) = self.recv_app(limit)?;
            match t {
                mt::BUTTON_REQUEST => {
                    ctl.prompt(prompt);
                    self.send_app(limit, 0, mt::BUTTON_ACK, &[])?;
                }
                mt::FAILURE => return Err(pairing_failure(&data, wrong_code)),
                t if t == expect => return Ok(data),
                t => return Err(HwError::bad(format!("unexpected THP message {t}"))),
            }
        }
    }

    /// Code Entry pairing (spec states HP0–HP5). Returns once the device has revealed a
    /// secret that matches both its commitment and the code the user typed.
    pub fn pair_code_entry(&mut self, limit: &Mutex<Limit>, ctl: &Ctl) -> HwResult<()> {
        if !self.props.pairing_methods.contains(&METHOD_CODE_ENTRY) {
            return Err(HwError::unsupported(
                "THP code pairing unavailable on this device",
            ));
        }
        let mut req = protos::ThpPairingRequest::new();
        req.set_host_name(THP_LABEL.into());
        req.set_app_name(THP_LABEL.into());
        self.pairing_call(
            limit,
            ctl,
            mt::PAIRING_REQUEST,
            &encode(&req)?,
            mt::PAIRING_REQUEST_APPROVED,
            Prompt::ThpConfirmPairing,
        )?;

        let mut sel = protos::ThpSelectMethod::new();
        sel.set_selected_pairing_method(protos::ThpPairingMethod::CodeEntry);
        let c: protos::ThpCodeEntryCommitment = decode(
            &self.pairing_call(
                limit,
                ctl,
                mt::SELECT_METHOD,
                &encode(&sel)?,
                mt::CODE_ENTRY_COMMITMENT,
                Prompt::ThpConfirmPairing,
            )?,
            "commitment",
        )?;
        let commitment = c.commitment().to_vec();
        if commitment.len() != 32 {
            return Err(HwError::bad("THP commitment of invalid size"));
        }

        let challenge = random::<16>()?;
        let mut ch = protos::ThpCodeEntryChallenge::new();
        ch.set_challenge(challenge.to_vec());
        let t: protos::ThpCodeEntryCpaceTrezor = decode(
            &self.pairing_call(
                limit,
                ctl,
                mt::CODE_ENTRY_CHALLENGE,
                &encode(&ch)?,
                mt::CODE_ENTRY_CPACE_TREZOR,
                Prompt::ThpConfirmPairing,
            )?,
            "CPace key",
        )?;
        let trezor_cpace: [u8; 32] = t
            .cpace_trezor_public_key()
            .try_into()
            .map_err(|_| HwError::bad("CPace key of invalid size"))?;

        // The device now shows the code: the user types it into Kyro.
        ctl.prompt(Prompt::ThpPairingCode);
        let typed = ctl.wait_pairing_code()?;
        let code: [u8; 6] = typed
            .as_bytes()
            .try_into()
            .ok()
            .filter(|c: &[u8; 6]| c.iter().all(u8::is_ascii_digit))
            .ok_or_else(|| HwError::PairingFailed("the code has 6 digits".into()))?;
        let k = random::<32>()?;
        let cp = cpace_host(&code, &self.handshake_hash, &k, &trezor_cpace)?;
        let mut tag = protos::ThpCodeEntryCpaceHostTag::new();
        tag.set_cpace_host_public_key(cp.public_key.to_vec());
        tag.set_tag(cp.tag.to_vec());
        let s: protos::ThpCodeEntrySecret = decode(
            &self.pairing_call(
                limit,
                ctl,
                mt::CODE_ENTRY_CPACE_HOST_TAG,
                &encode(&tag)?,
                mt::CODE_ENTRY_SECRET,
                Prompt::ThpConfirmPairing,
            )?,
            "secret",
        )?;
        let secret = Zeroizing::new(s.secret().to_vec());
        // HP5: the secret must match the commitment sent *before* Kyro's challenge, and give
        // the code the user typed. Otherwise the peer is not the device that showed the code.
        let committed: [u8; 32] = Sha256::digest(&secret[..]).into();
        if !ct_eq(&committed, &commitment)
            || !ct_eq(
                &code_entry_value(&self.handshake_hash, &secret, &challenge[..]),
                &code,
            )
        {
            return Err(HwError::PairingFailed(
                "the device did not prove the code (different commitment or code)".into(),
            ));
        }
        Ok(())
    }

    /// `ThpCredentialRequest` (non-autoconnect) after pairing; the returned static key must
    /// explain the masked key of this handshake.
    pub fn request_credential(
        &mut self,
        limit: &Mutex<Limit>,
        ctl: &Ctl,
        host_public: &[u8; 32],
        hs: &Handshake,
    ) -> HwResult<([u8; 32], Vec<u8>)> {
        let mut req = protos::ThpCredentialRequest::new();
        req.set_host_static_public_key(host_public.to_vec());
        req.set_autoconnect(false);
        let r: protos::ThpCredentialResponse = decode(
            &self.pairing_call(
                limit,
                ctl,
                mt::CREDENTIAL_REQUEST,
                &encode(&req)?,
                mt::CREDENTIAL_RESPONSE,
                Prompt::ThpConfirmConnection,
            )?,
            "THP credential",
        )?;
        let key: [u8; 32] = r
            .trezor_static_public_key()
            .try_into()
            .map_err(|_| HwError::bad("static key of invalid size"))?;
        if !mask_matches(&key, &hs.trezor_ephemeral, &hs.masked_static) {
            return Err(HwError::bad(
                "the announced static key does not match the handshake",
            ));
        }
        let cred = r.credential().to_vec();
        if cred.is_empty() || cred.len() > MAX_CREDENTIAL_LEN {
            return Err(HwError::bad("THP credential of invalid size"));
        }
        Ok((key, cred))
    }

    /// `ThpEndRequest`: leaves the pairing/credential phase. A paired, non-autoconnect host is
    /// asked to confirm the connection on the device here.
    pub fn end_pairing_phase(&mut self, limit: &Mutex<Limit>, ctl: &Ctl) -> HwResult<()> {
        self.pairing_call(
            limit,
            ctl,
            mt::END_REQUEST,
            &encode(&protos::ThpEndRequest::new())?,
            mt::END_RESPONSE,
            Prompt::ThpConfirmConnection,
        )
        .map(|_| ())
    }

    /// Best effort: ask the device to leave a pending dialog (pairing code screen, PIN…).
    fn abort(&mut self, limit: &Mutex<Limit>) {
        {
            let mut l = lock(limit);
            l.deadline = Instant::now() + Duration::from_secs(2);
            l.cancel = None;
        }
        if self.noise.is_some() {
            let _ = self.send_app(limit, 0, mt::CANCEL, &[]);
        }
    }
}

/// The only thing Kyro tells the device about itself, as both `host_name` and `app_name` of
/// `ThpPairingRequest` (shown on the device's pairing screen and kept in the credential's
/// metadata). Deliberately **not** the computer's name (privacy); the protocol needs no
/// uniqueness here: credentials are bound to Kyro's host key, not to this label.
pub const THP_LABEL: &str = "Kyro Wallet";

/// Allocates a channel, runs the handshake (with the stored credential when the device is
/// known), pairs when needed and allowed, and returns a channel in the encrypted transport
/// state. On failure the device is asked to leave any pending dialog.
pub fn connect<P: PacketIo>(
    io: P,
    limit: &Mutex<Limit>,
    ctl: &Ctl,
    env: &ThpEnv,
) -> HwResult<Channel<P>> {
    let (host_key, known) = env.load_or_init()?;
    let mut ch = Channel::allocate(io, limit)?;
    if ch.props.protocol_major != 2 {
        return Err(HwError::unsupported(format!(
            "THP version {}.{} not supported",
            ch.props.protocol_major, ch.props.protocol_minor
        )));
    }
    let hs = match ch.handshake(limit, &host_key, &known, false) {
        Ok(hs) => hs,
        Err(HwError::Locked) => {
            // Locked device: a new channel, and this time the device shows its PIN screen
            // during the handshake (spec "try_to_unlock").
            ctl.prompt(Prompt::PinOnDevice);
            ch = Channel::allocate(ch.io, limit)?;
            ch.handshake(limit, &host_key, &known, true)?
        }
        Err(e) => return Err(e),
    };
    match finish(&mut ch, limit, ctl, env, &host_key, &known, &hs) {
        Ok(()) => Ok(ch),
        Err(e) => {
            if matches!(e, HwError::Cancelled | HwError::Timeout) {
                ch.abort(limit);
            }
            Err(e)
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn finish<P: PacketIo>(
    ch: &mut Channel<P>,
    limit: &Mutex<Limit>,
    ctl: &Ctl,
    env: &ThpEnv,
    host_key: &[u8; 32],
    known: &[Pairing],
    hs: &Handshake,
) -> HwResult<()> {
    let host_public = MontgomeryPoint::mul_base_clamped(*host_key).to_bytes();
    match (hs.trezor_state, hs.matched) {
        (STATE_PAIRED | STATE_PAIRED_AUTOCONNECT, Some(i)) => {
            ch.trezor_static = Some(known[i].trezor_key);
        }
        (_, matched) => {
            if let Some(i) = matched {
                // The device no longer accepts this credential (reset, hosts forgotten).
                env.remove(&known[i].trezor_key)?;
            }
            if !ctl.pairing_allowed() {
                return Err(HwError::PairingRequired);
            }
            ch.pair_code_entry(limit, ctl)?;
            let (key, cred) = ch.request_credential(limit, ctl, &host_public, hs)?;
            env.add(Pairing {
                trezor_key: key,
                credential: cred,
                model: ch.props.internal_model.clone(),
                added: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or_default(),
            })?;
            ch.trezor_static = Some(key);
        }
    }
    ch.end_pairing_phase(limit, ctl)
}

/// Test-only hooks: a fixed host ephemeral key and a record of the handshake messages (for
/// the fixed-key transcript cross-checked against Trezor Suite). No-ops in normal builds.
mod test_hooks {
    #[cfg(test)]
    use std::cell::RefCell;

    #[cfg(test)]
    thread_local! {
        pub static EPHEMERAL: RefCell<Option<[u8; 32]>> = const { RefCell::new(None) };
        pub static TRANSCRIPT: RefCell<Vec<Vec<u8>>> = const { RefCell::new(Vec::new()) };
    }

    #[cfg(test)]
    pub fn record(bytes: &[u8]) {
        TRANSCRIPT.with(|t| t.borrow_mut().push(bytes.to_vec()));
    }

    #[cfg(not(test))]
    #[inline(always)]
    pub fn record(_: &[u8]) {}
}

#[cfg(test)]
pub use test_hooks::{EPHEMERAL as TEST_EPHEMERAL, TRANSCRIPT as TEST_TRANSCRIPT};

#[cfg(test)]
#[path = "thp_tests.rs"]
mod tests;
