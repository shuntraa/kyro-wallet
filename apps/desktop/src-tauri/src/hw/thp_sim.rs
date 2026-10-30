//! Simulated Trezor Safe 7, for tests only.
//!
//! - Transport, channel allocation, Noise handshake (with the masked static key), ACKs,
//!   retransmissions and encryption: **Trezor's own device-side implementation**, the
//!   `trezor-thp` crate from the trezor-firmware repository (the code the Safe 7 firmware runs
//!   since 2.12.4, "Switch to optimized THP implementation"). Kyro's host side ([`super::thp`])
//!   is written independently (snow + its own framing), so these tests are a real interop check.
//! - Application layer (pairing, credentials, sessions, a few wallet messages): written here
//!   from the THP specification and the firmware's `apps/thp/pairing.py`; keys come from the
//!   public "abandon … about" test phrase, so Kyro's own checks (xpub, signatures) apply.
//!
//! Fault injection: lost and corrupted packets in both directions, locked device, refusal,
//! wrong pairing code, a device that cheats on the code commitment, unplug, silence.

use std::cell::RefCell;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use protobuf::{Enum, Message};
use sha2::{Digest, Sha256};
use trezor_client::protos::{self, MessageType};
use trezor_client::transport::error::Error as TErr;
use trezor_client::transport::protocol::Link;
use trezor_noise_rust_crypto::sensitive::Sensitive;
use trezor_thp::channel::buffered::{Buffered, ChannelExt};
use trezor_thp::channel::device::{self, ChannelOpen, Mux};
use trezor_thp::channel::{PacketInResult, PairingState, Phase, U8Array, DH};
use trezor_thp::credential::CredentialVerifier;
use trezor_thp::{Backend, ChannelIO};
use wallet_core::{BtcKind, Mnemonic, Network};

use super::thp::{self, mt, Packet, PacketIo, PACKET};
use super::{lock, HwError, HwResult};

pub const ABANDON: &str =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

thread_local! {
    /// When set, the simulated device's "random" keys are a deterministic sequence.
    static DETERMINISTIC: RefCell<Option<u32>> = const { RefCell::new(None) };
}

pub fn set_deterministic(on: bool) {
    DETERMINISTIC.with(|d| *d.borrow_mut() = on.then_some(0));
}

fn sim_random(dest: &mut [u8]) {
    let det = DETERMINISTIC.with(|d| {
        d.borrow_mut().as_mut().map(|n| {
            *n += 1;
            *n
        })
    });
    match det {
        Some(n) => {
            let mut out = Vec::new();
            let mut i = 0u32;
            while out.len() < dest.len() {
                out.extend(Sha256::digest(format!("kyro-thp-sim-{n}-{i}").as_bytes()));
                i += 1;
            }
            dest.copy_from_slice(&out[..dest.len()]);
        }
        None => getrandom::getrandom(dest).unwrap(),
    }
}

/// X25519 of `trezor-noise-rust-crypto`, with key generation that can be made deterministic.
pub enum SimX25519 {}

impl DH for SimX25519 {
    type Key = Sensitive<[u8; 32]>;
    type Pubkey = [u8; 32];
    type Output = Sensitive<[u8; 32]>;

    fn name() -> &'static str {
        "25519"
    }

    fn genkey() -> Self::Key {
        let mut k = [0u8; 32];
        sim_random(&mut k);
        Self::Key::from_slice(&k)
    }

    fn pubkey(k: &Self::Key) -> Self::Pubkey {
        trezor_noise_rust_crypto::X25519::pubkey(k)
    }

    fn dh(k: &Self::Key, pk: &Self::Pubkey) -> Result<Self::Output, ()> {
        trezor_noise_rust_crypto::X25519::dh(k, pk)
    }
}

pub struct SimBackend;

impl Backend for SimBackend {
    type DH = SimX25519;
    type Cipher = trezor_noise_rust_crypto::Aes256Gcm;
    type Hash = trezor_noise_rust_crypto::Sha256;

    fn random_bytes(dest: &mut [u8]) {
        sim_random(dest);
    }
}

type Creds = Arc<Mutex<Vec<([u8; 32], Vec<u8>)>>>;

/// The device's credential check: Paired when the handshake payload carries a credential this
/// device issued to that host key.
#[derive(Clone)]
struct SimVerifier(Creds);

impl CredentialVerifier for SimVerifier {
    fn verify(&self, remote_static_pubkey: &[u8], payload: &[u8]) -> PairingState {
        let Ok(p) = protos::ThpHandshakeCompletionReqNoisePayload::parse_from_bytes(payload) else {
            return PairingState::Unpaired;
        };
        if !p.has_host_pairing_credential() {
            return PairingState::Unpaired;
        }
        let known = lock(&self.0)
            .iter()
            .any(|(k, c)| k[..] == *remote_static_pubkey && *c == p.host_pairing_credential());
        if known {
            PairingState::Paired
        } else {
            PairingState::Unpaired
        }
    }
}

/// Encoded `ThpDeviceProperties`: T3W1, protocol 2.1, Code Entry only (production firmware).
pub fn device_properties() -> Vec<u8> {
    let mut p = protos::ThpDeviceProperties::new();
    p.set_internal_model("T3W1".into());
    p.set_model_variant(0);
    p.set_protocol_version_major(2);
    p.set_protocol_version_minor(1);
    p.pairing_methods = vec![protos::ThpPairingMethod::CodeEntry.into()];
    p.write_to_bytes().unwrap()
}

pub const DEVICE_STATIC_KEY: [u8; 32] = [0x42; 32];

#[derive(Default)]
pub struct Faults {
    /// Device → host packets to drop (by index, counting every packet sent).
    pub drop_out: Vec<usize>,
    /// Device → host packets to corrupt (one bit flipped in the payload).
    pub corrupt_out: Vec<usize>,
    /// Host → device packets to drop.
    pub drop_in: Vec<usize>,
    pub locked: bool,
    pub reject_pairing: bool,
    /// Reveal a secret that does not match the commitment.
    pub cheat_secret: bool,
    /// Show "Allow connection?" to a paired host (firmware default for non-autoconnect).
    pub confirm_connection: bool,
    pub reject_signing: bool,
    /// Stop answering after this many host messages (application level).
    pub mute_after: Option<usize>,
    /// The USB device disappears after this many application messages from the host.
    pub unplug_after: Option<usize>,
}

pub struct Sim {
    mux: Buffered<Mux<SimBackend>>,
    open: Option<Buffered<ChannelOpen<SimVerifier, SimBackend>>>,
    chan: Option<Buffered<device::Channel<SimBackend>>>,
    next_cid: u16,
    out: VecDeque<Packet>,
    sent: usize,
    received: usize,
    idle: u32,
    creds: Creds,
    pending: VecDeque<(u8, u16, Vec<u8>)>,
    after_ack: Vec<(u8, u16, Vec<u8>)>,
    end_after_flush: bool,
    // pairing state
    secret: Option<Vec<u8>>,
    cpace_priv: [u8; 32],
    pub shown_code: Option<String>,
    sessions: Vec<u8>,
    seed: wallet_core::Seed,
    pub faults: Faults,
    /// Application message types received (in order), for assertions.
    pub log: Vec<(u8, u16)>,
    pub unplugged: bool,
}

impl Sim {
    pub fn shared() -> Arc<Mutex<Sim>> {
        Arc::new(Mutex::new(Sim {
            mux: Mux::new(&device_properties()).unwrap().into_buffered(),
            open: None,
            chan: None,
            next_cid: 0x1230,
            out: VecDeque::new(),
            sent: 0,
            received: 0,
            idle: 0,
            creds: Arc::new(Mutex::new(Vec::new())),
            pending: VecDeque::new(),
            after_ack: Vec::new(),
            end_after_flush: false,
            secret: None,
            cpace_priv: [0; 32],
            shown_code: None,
            sessions: Vec::new(),
            seed: Mnemonic::parse(ABANDON).unwrap().to_seed(""),
            faults: Faults::default(),
            log: Vec::new(),
            unplugged: false,
        }))
    }

    /// The device "forgets" every host (wipe / new credential key).
    pub fn forget_hosts(&mut self) {
        lock(&self.creds).clear();
    }

    /// As if this host had paired earlier and received `credential`.
    pub fn preset_credential(&mut self, host_public: [u8; 32], credential: Vec<u8>) {
        lock(&self.creds).push((host_public, credential));
    }

    pub fn trezor_public_key() -> [u8; 32] {
        curve25519_dalek::montgomery::MontgomeryPoint::mul_base_clamped(DEVICE_STATIC_KEY)
            .to_bytes()
    }

    fn packet_in(&mut self, p: &[u8]) {
        let idx = self.received;
        self.received += 1;
        if self.faults.drop_in.contains(&idx) {
            return;
        }
        self.idle = 0;
        match self.mux.packet_in(p) {
            PacketInResult::ChannelAllocation => {
                let cid = self.next_cid;
                self.next_cid += 1;
                let open = self
                    .mux
                    .channel_alloc(cid, SimVerifier(self.creds.clone()))
                    .unwrap()
                    .into_buffered();
                self.open = Some(open);
                self.chan = None;
                self.pending.clear();
                self.after_ack.clear();
                self.secret = None;
                self.shown_code = None;
                self.sessions.clear();
            }
            PacketInResult::Route { channel_id, .. } => self.route(channel_id, p),
            _ => {}
        }
        self.drain();
    }

    fn route(&mut self, cid: u16, p: &[u8]) {
        if let Some(o) = self.open.as_mut().filter(|o| o.channel_id() == cid) {
            if let PacketInResult::HandshakeKeyRequired { try_to_unlock } = o.packet_in(p) {
                if self.faults.locked && !try_to_unlock {
                    o.send_device_locked().unwrap();
                } else {
                    self.faults.locked = false; // the user typed the PIN on the device
                    o.set_static_key(&DEVICE_STATIC_KEY).unwrap();
                }
            }
            if o.handshake_done() {
                let o = self.open.take().unwrap();
                self.chan = Some(o.map(|c| c.complete()).unwrap());
            } else if o.handshake_failed() {
                self.open = None;
            }
            return;
        }
        let Some(c) = self.chan.as_mut().filter(|c| c.channel_id() == cid) else {
            let _ = self.mux.send_unallocated_channel(cid);
            return;
        };
        let _ = c.packet_in(p);
        if c.message_out_ready() {
            if let Ok((sid, t, data)) = c.message_out() {
                self.handle(sid, t, data);
            }
        }
        self.flush_pending();
    }

    fn flush_pending(&mut self) {
        let Some(c) = self.chan.as_mut() else {
            return;
        };
        while c.message_in_ready() {
            let Some((sid, t, data)) = self.pending.pop_front() else {
                break;
            };
            c.message_in(sid, t, &data).unwrap();
        }
        if self.end_after_flush && self.pending.is_empty() {
            c.end_pairing();
            self.end_after_flush = false;
        }
    }

    fn drain(&mut self) {
        let mut pkts = Vec::new();
        while self.mux.packet_out_ready() {
            pkts.push(self.mux.packet_out().unwrap());
        }
        if let Some(o) = self.open.as_mut() {
            while o.packet_out_ready() {
                pkts.push(o.packet_out().unwrap());
            }
        }
        if let Some(c) = self.chan.as_mut() {
            while c.packet_out_ready() {
                pkts.push(c.packet_out().unwrap());
            }
        }
        for p in pkts {
            let idx = self.sent;
            self.sent += 1;
            if self.faults.drop_out.contains(&idx) {
                continue;
            }
            let mut packet: Packet = p.try_into().unwrap();
            if self.faults.corrupt_out.contains(&idx) {
                packet[7] ^= 0x01;
            }
            self.out.push_back(packet);
        }
    }

    /// Called when the host finds nothing to read: the device retransmits unacknowledged
    /// messages after a while, like the firmware's event loop.
    fn tick(&mut self) {
        self.idle += 1;
        if self.idle % 15 != 0 {
            return;
        }
        if let Some(o) = self.open.as_mut() {
            if o.sending_retry().is_some() {
                let _ = o.message_retransmit();
            }
        }
        if let Some(c) = self.chan.as_mut() {
            if c.sending_retry().is_some() {
                let _ = c.message_retransmit();
            }
        }
        self.drain();
    }

    fn handshake_hash(&self) -> [u8; 32] {
        *self.chan.as_ref().unwrap().handshake_hash()
    }

    fn paired_handshake(&self) -> bool {
        matches!(
            self.chan.as_ref().map(|c| c.phase()),
            Some(Phase::PairingCredential { handshake_pairing_state }) if handshake_pairing_state.is_paired()
        )
    }

    fn reply<M: Message>(&mut self, sid: u8, t: MessageType, m: &M) {
        self.pending
            .push_back((sid, t.value() as u16, m.write_to_bytes().unwrap()));
    }

    fn failure(&mut self, sid: u8, code: protos::failure::FailureType, msg: &str) {
        let mut f = protos::Failure::new();
        f.set_code(code);
        f.set_message(msg.into());
        self.reply(sid, MessageType::MessageType_Failure, &f);
    }

    fn button_then(&mut self, sid: u8, name: &str, then: Vec<(u8, u16, Vec<u8>)>) {
        let mut br = protos::ButtonRequest::new();
        br.set_code(protos::button_request::ButtonRequestType::ButtonRequest_Other);
        br.set_name(name.into());
        self.reply(sid, MessageType::MessageType_ButtonRequest, &br);
        self.after_ack = then;
    }

    fn handle(&mut self, sid: u8, t: u16, data: Vec<u8>) {
        use protos::failure::FailureType as F;
        self.log.push((sid, t));
        let n = self.log.len();
        if self.faults.unplug_after.is_some_and(|u| n > u) {
            self.unplugged = true;
            return;
        }
        if self.faults.mute_after.is_some_and(|m| n > m) {
            return;
        }
        let transport = matches!(
            self.chan.as_ref().map(|c| c.phase()),
            Some(Phase::EncryptedTransport)
        );
        match t {
            mt::BUTTON_ACK => {
                let next = std::mem::take(&mut self.after_ack);
                self.pending.extend(next);
            }
            mt::CANCEL => {
                self.after_ack.clear();
                self.failure(sid, F::Failure_ActionCancelled, "Cancelled");
            }
            mt::PAIRING_REQUEST if !transport => {
                if self.faults.reject_pairing {
                    self.failure(sid, F::Failure_ActionCancelled, "Cancelled");
                    return;
                }
                let r = protos::ThpPairingRequest::parse_from_bytes(&data).unwrap();
                assert_eq!(r.app_name(), "Kyro Wallet");
                // A fixed label, never the computer's name.
                assert_eq!(r.host_name(), "Kyro Wallet");
                let ok = protos::ThpPairingRequestApproved::new();
                self.button_then(
                    sid,
                    "thp_pairing_request",
                    vec![(
                        sid,
                        mt::PAIRING_REQUEST_APPROVED,
                        ok.write_to_bytes().unwrap(),
                    )],
                );
            }
            mt::SELECT_METHOD if !transport => {
                let s = protos::ThpSelectMethod::parse_from_bytes(&data).unwrap();
                assert_eq!(
                    s.selected_pairing_method(),
                    protos::ThpPairingMethod::CodeEntry
                );
                let mut secret = vec![0u8; 16];
                sim_random(&mut secret);
                let mut c = protos::ThpCodeEntryCommitment::new();
                c.set_commitment(Sha256::digest(&secret).to_vec());
                self.secret = Some(secret);
                self.pending.push_back((
                    sid,
                    mt::CODE_ENTRY_COMMITMENT,
                    c.write_to_bytes().unwrap(),
                ));
            }
            mt::CODE_ENTRY_CHALLENGE if !transport => {
                let ch = protos::ThpCodeEntryChallenge::parse_from_bytes(&data).unwrap();
                let hh = self.handshake_hash();
                let secret = self.secret.clone().unwrap();
                let code = thp::code_entry_value(&hh, &secret, ch.challenge());
                self.shown_code = Some(String::from_utf8(code.to_vec()).unwrap());
                sim_random(&mut self.cpace_priv);
                // The device's key on the same code-derived generator (Kyro's CPace code is
                // checked against trezorlib's own implementation in thp.rs tests).
                let pubkey =
                    thp::cpace_host(&code, &hh, &self.cpace_priv, &Sim::trezor_public_key())
                        .unwrap()
                        .public_key;
                let mut m = protos::ThpCodeEntryCpaceTrezor::new();
                m.set_cpace_trezor_public_key(pubkey.to_vec());
                self.pending.push_back((
                    sid,
                    mt::CODE_ENTRY_CPACE_TREZOR,
                    m.write_to_bytes().unwrap(),
                ));
            }
            mt::CODE_ENTRY_CPACE_HOST_TAG if !transport => {
                let m = protos::ThpCodeEntryCpaceHostTag::parse_from_bytes(&data).unwrap();
                let host_pub: [u8; 32] = m.cpace_host_public_key().try_into().unwrap();
                let shared = curve25519_dalek::montgomery::MontgomeryPoint(host_pub)
                    .mul_clamped(self.cpace_priv)
                    .to_bytes();
                if shared == [0; 32] || Sha256::digest(shared)[..] != *m.tag() {
                    self.failure(sid, F::Failure_DataError, "Unexpected Code Entry Tag");
                    return;
                }
                let mut secret = self.secret.clone().unwrap();
                if self.faults.cheat_secret {
                    secret[0] ^= 1;
                }
                let mut s = protos::ThpCodeEntrySecret::new();
                s.set_secret(secret);
                self.pending
                    .push_back((sid, mt::CODE_ENTRY_SECRET, s.write_to_bytes().unwrap()));
            }
            mt::CREDENTIAL_REQUEST if !transport => {
                let r = protos::ThpCredentialRequest::parse_from_bytes(&data).unwrap();
                assert!(!r.autoconnect(), "Kyro never asks for autoconnect");
                let host: [u8; 32] = r.host_static_public_key().try_into().unwrap();
                let mut cred = vec![0u8; 40];
                sim_random(&mut cred);
                lock(&self.creds).push((host, cred.clone()));
                let mut resp = protos::ThpCredentialResponse::new();
                resp.set_trezor_static_public_key(Sim::trezor_public_key().to_vec());
                resp.set_credential(cred);
                self.pending.push_back((
                    sid,
                    mt::CREDENTIAL_RESPONSE,
                    resp.write_to_bytes().unwrap(),
                ));
            }
            mt::END_REQUEST if !transport => {
                let end = (
                    sid,
                    mt::END_RESPONSE,
                    protos::ThpEndResponse::new().write_to_bytes().unwrap(),
                );
                if self.paired_handshake() && self.faults.confirm_connection {
                    self.button_then(sid, "thp_connection_request", vec![end]);
                } else {
                    self.pending.push_back(end);
                }
                self.end_after_flush = true;
            }
            _ if !transport => {
                self.failure(sid, F::Failure_UnexpectedMessage, "Unexpected message");
            }
            _ => self.handle_app(sid, t, data),
        }
    }

    fn handle_app(&mut self, sid: u8, t: u16, data: Vec<u8>) {
        use protos::failure::FailureType as F;
        let Some(t) = MessageType::from_i32(i32::from(t)) else {
            self.failure(sid, F::Failure_UnexpectedMessage, "?");
            return;
        };
        match t {
            MessageType::MessageType_GetFeatures => {
                let mut f = protos::Features::new();
                f.set_vendor("trezor.io".into());
                f.set_major_version(2);
                f.set_minor_version(13);
                f.set_patch_version(0);
                f.set_internal_model("T3W1".into());
                f.set_initialized(true);
                f.set_unlocked(true);
                f.set_passphrase_protection(false);
                f.capabilities = vec![
                    protos::features::Capability::Capability_Bitcoin.into(),
                    protos::features::Capability::Capability_Ethereum.into(),
                    protos::features::Capability::Capability_Solana.into(),
                    protos::features::Capability::Capability_PassphraseEntry.into(),
                ];
                self.reply(sid, MessageType::MessageType_Features, &f);
            }
            MessageType::MessageType_ThpCreateNewSession => {
                let r = protos::ThpCreateNewSession::parse_from_bytes(&data).unwrap();
                assert_eq!(
                    r.passphrase(),
                    "",
                    "no passphrase protection: empty passphrase"
                );
                assert!(sid != 0, "session 0 is the seedless session");
                self.sessions.push(sid);
                self.reply(
                    sid,
                    MessageType::MessageType_Success,
                    &protos::Success::new(),
                );
            }
            _ if !self.sessions.contains(&sid) => {
                self.failure(sid, F::Failure_InvalidSession, "Seedless session");
            }
            MessageType::MessageType_GetPublicKey => {
                let r = protos::GetPublicKey::parse_from_bytes(&data).unwrap();
                let kind = match r.address_n.first().map(|p| p & 0x7fff_ffff) {
                    Some(84) => BtcKind::Segwit,
                    Some(86) => BtcKind::Taproot,
                    _ => {
                        self.failure(sid, F::Failure_DataError, "path");
                        return;
                    }
                };
                let acc = wallet_core::btc_account(&self.seed, Network::Testnet, kind, 0).unwrap();
                let mut pk = protos::PublicKey::new();
                pk.set_xpub(acc.xpub);
                pk.set_root_fingerprint(u32::from_str_radix(&acc.fingerprint, 16).unwrap());
                let mut node = protos::HDNodeType::new();
                node.set_depth(3);
                node.set_fingerprint(0);
                node.set_child_num(0);
                node.set_chain_code(vec![0; 32]);
                node.set_public_key(vec![2; 33]);
                pk.node = protobuf::MessageField::some(node);
                self.reply(sid, MessageType::MessageType_PublicKey, &pk);
            }
            MessageType::MessageType_SolanaGetAddress => {
                let mut a = protos::SolanaAddress::new();
                a.set_address(wallet_core::sol_address(&self.seed, 0).unwrap());
                let then = vec![(
                    sid,
                    MessageType::MessageType_SolanaAddress.value() as u16,
                    a.write_to_bytes().unwrap(),
                )];
                self.button_then(sid, "show_address", then);
            }
            MessageType::MessageType_SolanaSignTx => {
                let r = protos::SolanaSignTx::parse_from_bytes(&data).unwrap();
                if self.faults.reject_signing {
                    let mut f = protos::Failure::new();
                    f.set_code(F::Failure_ActionCancelled);
                    let then = vec![(sid, mt::FAILURE, f.write_to_bytes().unwrap())];
                    self.button_then(sid, "confirm_output", then);
                    return;
                }
                let sig = wallet_core::sol_sign_message(&self.seed, 0, r.serialized_tx()).unwrap();
                let mut s = protos::SolanaTxSignature::new();
                s.set_signature(sig.to_vec());
                let then = vec![(
                    sid,
                    MessageType::MessageType_SolanaTxSignature.value() as u16,
                    s.write_to_bytes().unwrap(),
                )];
                self.button_then(sid, "confirm_output", then);
            }
            _ => self.failure(sid, F::Failure_UnexpectedMessage, "not simulated"),
        }
    }
}

/// The USB side: both the protocol-v1 `Link` (used by the probe) and THP packets.
pub struct SimUsb(pub Arc<Mutex<Sim>>);

impl Link for SimUsb {
    fn write_chunk(&mut self, chunk: Vec<u8>) -> Result<(), TErr> {
        let mut s = lock(&self.0);
        if s.unplugged {
            return Err(TErr::DeviceDisconnected);
        }
        s.packet_in(&chunk);
        Ok(())
    }

    fn read_chunk(&mut self) -> Result<Vec<u8>, TErr> {
        let mut s = lock(&self.0);
        if s.unplugged {
            return Err(TErr::DeviceDisconnected);
        }
        s.out
            .pop_front()
            .map(|p| p.to_vec())
            .ok_or(TErr::DeviceReadTimeout)
    }
}

impl PacketIo for SimUsb {
    fn write_packet(&mut self, packet: &Packet) -> HwResult<()> {
        let mut s = lock(&self.0);
        if s.unplugged {
            return Err(HwError::Disconnected);
        }
        s.packet_in(packet);
        Ok(())
    }

    fn read_packet(&mut self) -> HwResult<Option<Packet>> {
        let got = {
            let mut s = lock(&self.0);
            if s.unplugged {
                return Err(HwError::Disconnected);
            }
            let p = s.out.pop_front();
            if p.is_none() {
                s.tick();
            }
            p
        };
        if got.is_none() {
            std::thread::sleep(Duration::from_millis(2));
        }
        Ok(got)
    }
}

const _: () = assert!(PACKET == 64);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hw::thp_store::ThpEnv;
    use crate::hw::trezor::{open_link, Limit};
    use crate::hw::{Chain, ChainState, Ctl, HardwareWallet, Prompt, PromptFn};
    use wallet_core::Zeroizing;

    /// What the simulated user does when the device shows the pairing code.
    #[derive(Clone, Copy)]
    enum User {
        TypesCode,
        TypesWrongCode,
        Away,
    }

    struct Run {
        result: HwResult<Box<dyn HardwareWallet>>,
        prompts: Vec<Prompt>,
    }

    fn connect(
        sim: &Arc<Mutex<Sim>>,
        env: &ThpEnv,
        pairing: bool,
        user: User,
        timeout: Duration,
    ) -> Run {
        let prompts = Arc::new(Mutex::new(Vec::new()));
        let tx_slot: Arc<Mutex<Option<std::sync::mpsc::SyncSender<Zeroizing<String>>>>> =
            Arc::new(Mutex::new(None));
        let (p2, s2, t2) = (prompts.clone(), sim.clone(), tx_slot.clone());
        let prompt: PromptFn = Arc::new(move |p| {
            lock(&p2).push(p);
            if p == Prompt::ThpPairingCode {
                let code = lock(&s2)
                    .shown_code
                    .clone()
                    .expect("code on the device screen");
                let typed = match user {
                    User::TypesCode => code,
                    User::TypesWrongCode => {
                        format!("{:06}", (code.parse::<u32>().unwrap() + 1) % 1_000_000)
                    }
                    User::Away => return,
                };
                lock(&t2)
                    .as_ref()
                    .unwrap()
                    .try_send(Zeroizing::new(typed))
                    .unwrap();
            }
        });
        let ctl = if pairing {
            let (ctl, tx) = Ctl::for_pairing_tests(timeout, prompt);
            *lock(&tx_slot) = Some(tx);
            ctl
        } else {
            Ctl::new(timeout, prompt)
        };
        let limit = Arc::new(Mutex::new(Limit::idle()));
        let result = open_link(SimUsb(sim.clone()), limit, &ctl, env);
        let prompts = lock(&prompts).clone();
        Run { result, prompts }
    }

    fn t() -> Duration {
        Duration::from_secs(20)
    }

    fn ctl() -> Ctl {
        Ctl::for_tests(Duration::from_secs(20))
    }

    #[test]
    fn pairing_then_wallet_operations_then_credential_reconnect() {
        let sim = Sim::shared();
        let env = ThpEnv::default();
        let r = connect(&sim, &env, true, User::TypesCode, t());
        let mut dev = r.result.expect("paired and connected");
        assert_eq!(
            r.prompts,
            vec![Prompt::ThpConfirmPairing, Prompt::ThpPairingCode]
        );
        // Stored: the device's real static key (unmasked), never the masked one.
        let list = env.list().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].key, hex::encode(Sim::trezor_public_key()));
        assert_eq!(list[0].model, "T3W1");

        // Every existing operation goes through the encrypted channel.
        let st = dev.status(&ctl(), Network::Testnet).unwrap();
        assert_eq!(st.model, "Trezor Safe 7");
        assert_eq!(st.protocol, Some("thp"));
        assert_eq!(st.firmware.as_deref(), Some("2.13.0"));
        for chain in [Chain::Btc, Chain::Evm, Chain::Sol] {
            let c = st.chains.iter().find(|c| c.chain == chain).unwrap();
            assert_eq!(c.state, ChainState::Ready, "{chain:?}");
        }
        let seed = Mnemonic::parse(ABANDON).unwrap().to_seed("");
        for kind in [BtcKind::Segwit, BtcKind::Taproot] {
            let acc = dev.btc_account(&ctl(), Network::Testnet, kind, 0).unwrap();
            let want = wallet_core::btc_account(&seed, Network::Testnet, kind, 0).unwrap();
            assert_eq!(acc.xpub, want.xpub);
            assert_eq!(acc.fingerprint, want.fingerprint);
        }
        let prompts = Arc::new(Mutex::new(Vec::new()));
        let p2 = prompts.clone();
        let c = Ctl::new(t(), Arc::new(move |p| lock(&p2).push(p)));
        let shown = dev.sol_address(&c, 0, true).unwrap();
        assert_eq!(shown, wallet_core::sol_address(&seed, 0).unwrap());
        let message = b"solana message bytes (any)".to_vec();
        let sig = dev.sol_sign(&c, 0, &message).unwrap();
        wallet_core::sol_verify_signature(&shown, &message, &sig).expect("valid signature");
        assert_eq!(
            *lock(&prompts),
            vec![Prompt::ConfirmOnDevice, Prompt::ConfirmOnDevice]
        );
        // Wallet messages used session 1, created after GetFeatures on session 0.
        let log = lock(&sim).log.clone();
        let features = log
            .iter()
            .position(|&(s, t)| s == 0 && t == MessageType::MessageType_GetFeatures.value() as u16)
            .unwrap();
        let session = log
            .iter()
            .position(|&(s, t)| {
                s == 1 && t == MessageType::MessageType_ThpCreateNewSession.value() as u16
            })
            .unwrap();
        assert!(features < session);
        assert!(log
            .iter()
            .any(|&(s, t)| s == 1 && t == MessageType::MessageType_SolanaSignTx.value() as u16));
        drop(dev);

        // Reconnect (new channel): the credential skips the code; the device asks to confirm
        // the connection; no pairing permission needed.
        lock(&sim).faults.confirm_connection = true;
        lock(&sim).log.clear();
        let r = connect(&sim, &env, false, User::Away, t());
        let mut dev = r.result.expect("credential accepted");
        assert_eq!(r.prompts, vec![Prompt::ThpConfirmConnection]);
        assert!(!lock(&sim)
            .log
            .iter()
            .any(|&(_, t)| t == mt::PAIRING_REQUEST));
        let acc = dev
            .btc_account(&ctl(), Network::Testnet, BtcKind::Segwit, 0)
            .unwrap();
        assert_eq!(acc.fingerprint, "73c5da0a");
    }

    /// Fixed keys on both sides: Kyro's host key and ephemeral key, the device's static key and
    /// (deterministic) ephemeral key, a known credential. The messages Kyro computes (snow) are
    /// compared with those computed by Trezor Suite's own handshake code (`@trezor/protocol`,
    /// `handleHandshakeInit` / `getTrezorState`, run under Node on the same inputs), and the
    /// device side is Trezor's `trezor-thp`, which accepted them.
    #[test]
    fn fixed_key_handshake_transcript_matches_trezor_suite() {
        set_deterministic(true);
        let host_key = [0x11; 32];
        let host_pub =
            curve25519_dalek::montgomery::MontgomeryPoint::mul_base_clamped(host_key).to_bytes();
        let cred = vec![0xC5; 40];
        let sim = Sim::shared();
        lock(&sim).preset_credential(host_pub, cred.clone());
        let env = ThpEnv::preset(
            host_key,
            vec![crate::hw::thp_store::Pairing {
                trezor_key: Sim::trezor_public_key(),
                credential: cred,
                model: "T3W1".into(),
                added: 0,
            }],
        );
        thp::TEST_EPHEMERAL.with(|e| *e.borrow_mut() = Some([0x22; 32]));
        thp::TEST_TRANSCRIPT.with(|t| t.borrow_mut().clear());
        let r = connect(&sim, &env, false, User::Away, t());
        thp::TEST_EPHEMERAL.with(|e| *e.borrow_mut() = None);
        set_deterministic(false);
        r.result.expect("paired handshake");
        assert!(r.prompts.is_empty());
        let tr: Vec<String> =
            thp::TEST_TRANSCRIPT.with(|t| t.borrow().iter().map(hex::encode).collect());
        assert_eq!(
            hex::encode(device_properties()),
            "0a04543357311000180220012802"
        );
        assert_eq!(
            hex::encode(Sim::trezor_public_key()),
            "132c442be010fbd57e72603328aa76e71fccc1503aae219327d14d9c9993f472"
        );
        assert_eq!(tr.len(), 5);
        assert_eq!(
            &tr[0][..64],
            hex::encode(
                curve25519_dalek::montgomery::MontgomeryPoint::mul_base_clamped([0x22; 32])
                    .to_bytes()
            )
        );
        assert_eq!(&tr[0][64..], "00", "try_to_unlock = 0");
        assert_eq!(tr[2], SUITE_COMP_REQ, "HandshakeCompletionRequest (Suite)");
        assert_eq!(tr[3], SUITE_HANDSHAKE_HASH, "handshake hash (Suite)");
        assert_eq!(tr[1], SIM_INIT_RESP, "deterministic device");
        assert_eq!(tr[4], SIM_COMP_RESP, "encrypted trezor_state = PAIRED");
    }

    // Device side (trezor-thp, deterministic ephemeral key): HandshakeInitiationResponse and the
    // encrypted trezor_state. Given these, Trezor Suite's `handleHandshakeInit` (run under Node
    // 24 on the same host keys and credential) prints exactly SUITE_COMP_REQ and
    // SUITE_HANDSHAKE_HASH, finds the credential (masked key match), and its `getTrezorState`
    // decrypts SIM_COMP_RESP to 1 (PAIRED).
    const SIM_INIT_RESP: &str = "290009952c2d31b1f9737cf07ff8b0076310409899ab630365dd59083c8cca7587fb6326414428b403a440145e3497ad139c3f381673293e2d662635e906ee21f6625a2e1662bc6983ba96f71ebcd7e94af34eb2cf19121f5b4e914a3a8f21a6";
    const SIM_COMP_RESP: &str = "4f1b2d38771ea80003c210a965a5719c6d";
    const SUITE_COMP_REQ: &str = "162fd66675fe10bcb5b40e64e6ba3ffcbc57843fbb095f12eb4dd2c13960db7db445a372957d416e167797fec79c6a23cbd08958b849e1464291ae70746bc6faba7518dfab9b4d571eb8e09ea6c6fcdf0a465431af21b6759f85b2c3eed17178007d8a2746db07c6a259";
    const SUITE_HANDSHAKE_HASH: &str =
        "9a221428e535fc18ea57ea9c6912c635602661a09e88af0155207bf59c225186";

    #[test]
    fn unpaired_device_needs_hw_open() {
        let sim = Sim::shared();
        let env = ThpEnv::default();
        let r = connect(&sim, &env, false, User::Away, t());
        assert_eq!(r.result.err(), Some(HwError::PairingRequired));
        assert!(env.list().unwrap().is_empty());
        assert!(!lock(&sim)
            .log
            .iter()
            .any(|&(_, t)| t == mt::PAIRING_REQUEST));
    }

    #[test]
    fn wrong_code_refusal_and_cheating_device_fail() {
        let sim = Sim::shared();
        let env = ThpEnv::default();
        let r = connect(&sim, &env, true, User::TypesWrongCode, t());
        assert!(matches!(r.result.err(), Some(HwError::PairingFailed(_))));
        assert!(env.list().unwrap().is_empty());

        lock(&sim).faults.reject_pairing = true;
        let r = connect(&sim, &env, true, User::TypesCode, t());
        assert_eq!(r.result.err(), Some(HwError::Rejected));

        // The device reveals a secret that does not match its commitment: whoever answered
        // is not the device that showed the code. Nothing is stored.
        let mut s = lock(&sim);
        s.faults.reject_pairing = false;
        s.faults.cheat_secret = true;
        drop(s);
        let r = connect(&sim, &env, true, User::TypesCode, t());
        assert!(matches!(r.result.err(), Some(HwError::PairingFailed(_))));
        assert!(env.list().unwrap().is_empty());
    }

    #[test]
    fn stale_credential_is_dropped() {
        let sim = Sim::shared();
        let env = ThpEnv::default();
        connect(&sim, &env, true, User::TypesCode, t())
            .result
            .unwrap();
        assert_eq!(env.list().unwrap().len(), 1);
        lock(&sim).forget_hosts();
        let r = connect(&sim, &env, false, User::Away, t());
        assert_eq!(r.result.err(), Some(HwError::PairingRequired));
        assert!(
            env.list().unwrap().is_empty(),
            "rejected credential removed"
        );
        // hw_open pairs again.
        connect(&sim, &env, true, User::TypesCode, t())
            .result
            .unwrap();
        assert_eq!(env.list().unwrap().len(), 1);
    }

    #[test]
    fn locked_device_unlocks_during_handshake() {
        let sim = Sim::shared();
        lock(&sim).faults.locked = true;
        let env = ThpEnv::default();
        let r = connect(&sim, &env, true, User::TypesCode, t());
        r.result.expect("connected after PIN");
        assert_eq!(r.prompts[0], Prompt::PinOnDevice);
    }

    #[test]
    fn lost_and_corrupted_packets_are_recovered() {
        for faults in [
            // init response lost, then a corrupted retransmission
            Faults {
                drop_out: vec![2],
                corrupt_out: vec![3],
                ..Faults::default()
            },
            // host packets lost (handshake init, an application message)
            Faults {
                drop_in: vec![2, 9],
                ..Faults::default()
            },
            // ACKs lost in both directions
            Faults {
                drop_out: vec![1, 6],
                drop_in: vec![4],
                ..Faults::default()
            },
        ] {
            let sim = Sim::shared();
            lock(&sim).faults = faults;
            let env = ThpEnv::default();
            let mut dev = connect(&sim, &env, true, User::TypesCode, t())
                .result
                .expect("recovered");
            let acc = dev
                .btc_account(&ctl(), Network::Testnet, BtcKind::Taproot, 0)
                .unwrap();
            assert_eq!(acc.fingerprint, "73c5da0a");
        }
    }

    #[test]
    fn nobody_types_the_code_timeout_and_device_is_told() {
        let sim = Sim::shared();
        let env = ThpEnv::default();
        let started = std::time::Instant::now();
        let r = connect(&sim, &env, true, User::Away, Duration::from_millis(1500));
        assert_eq!(r.result.err(), Some(HwError::Timeout));
        assert!(started.elapsed() < Duration::from_secs(6));
        // Kyro asked the device to leave its code screen.
        assert_eq!(lock(&sim).log.last().map(|&(_, t)| t), Some(mt::CANCEL));
    }

    #[test]
    fn unplug_refusal_and_silence_during_operations() {
        let sim = Sim::shared();
        let env = ThpEnv::default();
        let mut dev = connect(&sim, &env, true, User::TypesCode, t())
            .result
            .unwrap();
        lock(&sim).faults.reject_signing = true;
        assert_eq!(dev.sol_sign(&ctl(), 0, b"m"), Err(HwError::Rejected));
        lock(&sim).faults.reject_signing = false;
        let n = lock(&sim).log.len();
        lock(&sim).faults.mute_after = Some(n);
        let c = Ctl::for_tests(Duration::from_millis(800));
        assert_eq!(dev.sol_sign(&c, 0, b"m").err(), Some(HwError::Timeout));
        let sim = Sim::shared();
        let mut dev = connect(&sim, &ThpEnv::default(), true, User::TypesCode, t())
            .result
            .unwrap();
        let n = lock(&sim).log.len();
        lock(&sim).faults.unplug_after = Some(n);
        assert_eq!(
            dev.sol_sign(&ctl(), 0, b"m").err(),
            Some(HwError::Disconnected)
        );
    }

    /// Kyro's v1 probe on an older model still gives the v1 path (no THP at all).
    #[test]
    fn v1_device_is_not_treated_as_thp() {
        struct V1Only(VecDeque<Vec<u8>>);
        impl Link for V1Only {
            fn write_chunk(&mut self, chunk: Vec<u8>) -> Result<(), TErr> {
                assert_eq!(&chunk[..3], b"?##", "only protocol v1 is sent");
                let mut f = protos::Features::new();
                f.set_major_version(2);
                f.set_minor_version(8);
                f.set_patch_version(9);
                f.set_internal_model("T3T1".into());
                f.set_initialized(true);
                let payload = f.write_to_bytes().unwrap();
                let mut data = vec![0x23, 0x23, 0x00, 0x11];
                data.extend((payload.len() as u32).to_be_bytes());
                data.extend(payload);
                for c in data.chunks(63) {
                    let mut p = vec![0x3f];
                    p.extend(c);
                    p.resize(64, 0);
                    self.0.push_back(p);
                }
                Ok(())
            }
            fn read_chunk(&mut self) -> Result<Vec<u8>, TErr> {
                self.0.pop_front().ok_or(TErr::DeviceReadTimeout)
            }
        }
        impl PacketIo for V1Only {
            fn write_packet(&mut self, _: &Packet) -> HwResult<()> {
                panic!("no THP packet for a v1 device")
            }
            fn read_packet(&mut self) -> HwResult<Option<Packet>> {
                Ok(None)
            }
        }
        let limit = Arc::new(Mutex::new(Limit::idle()));
        let env = ThpEnv::default();
        let mut dev = open_link(V1Only(VecDeque::new()), limit, &ctl(), &env)
            .unwrap_or_else(|e| panic!("{e:?}"));
        // This fake answers Features to everything: enough for `status`.
        let st = dev.status(&ctl(), Network::Testnet).unwrap();
        assert_eq!(st.model, "Trezor Safe 5");
        assert_eq!(st.protocol, None);
        assert!(env.list().unwrap().is_empty());
    }
}
