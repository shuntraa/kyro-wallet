//! Trezor over WebUSB (libusb via rusb, vendored and statically linked), protocol v1
//! (`?##` framing), messages from Trezor's official `trezor-client` protobuf bindings.
//!
//! Supported: Trezor One (firmware ≥ 1.10.4), Model T, Safe 3, Safe 5 (≥ 2.4.3; Solana ≥ 2.6.4,
//! not on the One). Not supported: Safe 7 (THP channel protocol, not implemented by the Rust
//! client), bootloader mode, uninitialized devices, Trezor One firmware < 1.7 (HID only).
//!
//! PIN: on the device for T/Safe (Kyro only shows "enter your PIN on the device"); Trezor One
//! uses the blind 3×3 matrix (event `hw-prompt: pin-matrix`, then `hw_pin_matrix` with the
//! *positions*, which reveal nothing without the device's scrambled layout).
//! Passphrase: entered on the device (T/Safe). A Trezor One with passphrase protection would
//! need the passphrase typed on the computer: refused (`HW_UNSUPPORTED`), because the
//! webview must never handle a secret.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use protobuf::Message;
use rusb::{DeviceHandle, GlobalContext};
use trezor_client::protos::{self, MessageType};
use trezor_client::transport::error::Error as TErr;
use trezor_client::transport::protocol::{Link, Protocol, ProtocolV1};
use trezor_client::transport::ProtoMessage;
use trezor_client::TrezorMessage;
use wallet_core::{BtcAccount, BtcKind, EvmTxKind, HwBtcSignature, HwDeviceKind, Network};

use super::{
    btc_account_path, evm_path, lock, path_string, sol_path, version_at_least, BtcSignRequest,
    Chain, ChainState, ChainStatus, Ctl, DeviceStatus, EvmSignRequest, Found, HardwareWallet,
    HwError, HwResult, Locator as AnyLocator, Prompt, POLL,
};

const TREZOR: (u16, u16) = (0x1209, 0x53C1);
const TREZOR_ONE: (u16, u16) = (0x534C, 0x0001);
const TREZOR_BOOTLOADER: (u16, u16) = (0x1209, 0x53C0);
const IFACE: u8 = 0;
const EP_OUT: u8 = 0x01;
const EP_IN: u8 = 0x81;
const CHUNK: usize = 64;

#[derive(Debug, Clone)]
pub struct Locator {
    bus: u8,
    ports: Vec<u8>,
}

pub fn enumerate() -> Vec<Found> {
    let Ok(list) = rusb::devices() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for dev in list.iter() {
        let Ok(desc) = dev.device_descriptor() else {
            continue;
        };
        let id = (desc.vendor_id(), desc.product_id());
        if ![TREZOR, TREZOR_ONE, TREZOR_BOOTLOADER].contains(&id) {
            continue;
        }
        // WebUSB devices expose a vendor-specific interface 0 (old HID-only Ones do not).
        let webusb = dev.config_descriptor(0).ok().is_some_and(|c| {
            c.interfaces()
                .find(|i| i.number() == IFACE)
                .and_then(|i| i.descriptors().next())
                .is_some_and(|d| d.class_code() == 0xff)
        });
        if !webusb {
            continue;
        }
        let ports = dev.port_numbers().unwrap_or_default();
        let model = match id {
            TREZOR_ONE => "Trezor One",
            TREZOR_BOOTLOADER => "Trezor (bootloader)",
            _ => "Trezor",
        };
        out.push(Found {
            kind: HwDeviceKind::Trezor,
            model: model.into(),
            transport: "webusb",
            key: format!("trezor:{}:{:?}:{}", dev.bus_number(), ports, dev.address()),
            locator: AnyLocator::Trezor(Locator {
                bus: dev.bus_number(),
                ports,
            }),
        });
    }
    out
}

fn usb_err(e: rusb::Error) -> HwError {
    match e {
        rusb::Error::Busy => HwError::Busy(
            "l'appareil est utilisé par une autre application (ferme Trezor Suite)".into(),
        ),
        rusb::Error::Access => {
            HwError::Busy("accès USB refusé (Linux : installe les règles udev de Trezor)".into())
        }
        rusb::Error::NotFound | rusb::Error::NoDevice => HwError::NotFound,
        _ => HwError::Disconnected,
    }
}

pub fn open(loc: &Locator) -> HwResult<Box<dyn HardwareWallet>> {
    let list = rusb::devices().map_err(usb_err)?;
    let dev = list
        .iter()
        .find(|d| d.bus_number() == loc.bus && d.port_numbers().unwrap_or_default() == loc.ports)
        .ok_or(HwError::NotFound)?;
    let handle = dev.open().map_err(usb_err)?;
    handle.claim_interface(IFACE).map_err(usb_err)?;
    let limit = Arc::new(Mutex::new(Limit::idle()));
    let mut t = Trezor {
        proto: ProtocolV1 {
            link: UsbLink {
                handle,
                limit: limit.clone(),
            },
        },
        limit,
        features: None,
    };
    t.initialize()?;
    Ok(Box::new(t))
}

/// Deadline/cancellation shared with the link (the `Link` trait has no context argument).
struct Limit {
    deadline: Instant,
    cancel: Option<Arc<AtomicBool>>,
    /// Why the last read gave up (`Timeout` or `Cancelled`).
    stopped: Option<HwError>,
}

impl Limit {
    fn idle() -> Self {
        Limit {
            deadline: Instant::now() + Duration::from_secs(10),
            cancel: None,
            stopped: None,
        }
    }
}

pub struct UsbLink {
    handle: DeviceHandle<GlobalContext>,
    limit: Arc<Mutex<Limit>>,
}

impl Link for UsbLink {
    fn write_chunk(&mut self, chunk: Vec<u8>) -> Result<(), TErr> {
        self.handle
            .write_interrupt(EP_OUT, &chunk, Duration::from_secs(2))
            .map(|_| ())
            .map_err(TErr::Usb)
    }

    fn read_chunk(&mut self) -> Result<Vec<u8>, TErr> {
        let mut buf = vec![0u8; CHUNK];
        loop {
            match self.handle.read_interrupt(EP_IN, &mut buf, POLL) {
                Ok(CHUNK) => return Ok(buf),
                Ok(n) => return Err(TErr::UnexpectedChunkSizeFromDevice(n)),
                Err(rusb::Error::Timeout) => {
                    let mut l = lock(&self.limit);
                    let cancelled = l.cancel.as_ref().is_some_and(|c| c.load(Ordering::SeqCst));
                    if cancelled || Instant::now() >= l.deadline {
                        l.stopped = Some(if cancelled {
                            HwError::Cancelled
                        } else {
                            HwError::Timeout
                        });
                        return Err(TErr::DeviceReadTimeout);
                    }
                }
                Err(e) => return Err(TErr::Usb(e)),
            }
        }
    }
}

/// Message-level exchange used by the Bitcoin signing flow (and mocked in its tests).
pub trait TrezorIo {
    /// Sends one message and returns the device's answer after all user interaction
    /// (button, PIN, passphrase) has been handled. `Failure` is returned as an error.
    fn call(&mut self, ctl: &Ctl, mt: MessageType, payload: Vec<u8>) -> HwResult<ProtoMessage>;
}

pub struct Trezor<L: Link> {
    proto: ProtocolV1<L>,
    limit: Arc<Mutex<Limit>>,
    features: Option<protos::Features>,
}

fn encode<M: Message>(m: &M) -> HwResult<Vec<u8>> {
    m.write_to_bytes()
        .map_err(|e| HwError::bad(format!("encodage protobuf : {e}")))
}

pub fn decode<M: TrezorMessage>(resp: ProtoMessage) -> HwResult<M> {
    if resp.message_type() != M::MESSAGE_TYPE {
        return Err(HwError::bad(format!(
            "message inattendu {:?} (attendu {:?})",
            resp.message_type(),
            M::MESSAGE_TYPE
        )));
    }
    resp.into_message()
        .map_err(|e| HwError::bad(format!("protobuf invalide : {e}")))
}

fn map_failure(f: &protos::Failure) -> HwError {
    use protos::failure::FailureType as F;
    match f.code() {
        F::Failure_ActionCancelled | F::Failure_PinCancelled => HwError::Rejected,
        F::Failure_PinInvalid | F::Failure_PinExpected => HwError::Locked,
        F::Failure_Busy | F::Failure_InProgress => HwError::Busy("l'appareil est occupé".into()),
        F::Failure_NotInitialized => HwError::unsupported("appareil non initialisé"),
        F::Failure_InvalidProtocol | F::Failure_ThpUnallocatedSession => {
            HwError::unsupported("protocole THP (Trezor Safe 7) non pris en charge")
        }
        code => HwError::bad(format!("Trezor : {code:?} « {} »", f.message())),
    }
}

/// Model name from `Features.internal_model` (T1B1, T2T1, T2B1/T3B1, T3T1, T3W1).
pub fn model_name(internal: &str) -> &'static str {
    match internal {
        "T1B1" => "Trezor One",
        "T2T1" => "Trezor Model T",
        "T2B1" | "T3B1" => "Trezor Safe 3",
        "T3T1" => "Trezor Safe 5",
        "T3W1" => "Trezor Safe 7",
        _ => "Trezor",
    }
}

impl<L: Link> Trezor<L> {
    fn map_terr(&self, e: TErr) -> HwError {
        match e {
            TErr::DeviceReadTimeout => lock(&self.limit).stopped.take().unwrap_or(HwError::Timeout),
            TErr::Usb(rusb::Error::Busy | rusb::Error::Access) => usb_err(rusb::Error::Busy),
            TErr::Usb(_) | TErr::DeviceDisconnected | TErr::IO(_) => HwError::Disconnected,
            other => HwError::bad(format!("transport Trezor : {other}")),
        }
    }

    fn arm(&self, deadline: Instant, cancel: Option<Arc<AtomicBool>>) {
        let mut l = lock(&self.limit);
        l.deadline = deadline;
        l.cancel = cancel;
        l.stopped = None;
    }

    fn write(&mut self, mt: MessageType, payload: Vec<u8>) -> HwResult<()> {
        self.proto
            .write(ProtoMessage::new(mt, payload))
            .map_err(|e| self.map_terr(e))
    }

    fn read(&mut self) -> HwResult<ProtoMessage> {
        self.proto.read().map_err(|e| self.map_terr(e))
    }

    /// Best effort: tell the device to abandon the current workflow (it answers `Failure`).
    fn abort(&mut self) {
        self.arm(Instant::now() + Duration::from_secs(2), None);
        if self
            .write(MessageType::MessageType_Cancel, Vec::new())
            .is_ok()
        {
            for _ in 0..4 {
                match self.read() {
                    Ok(m) if m.message_type() == MessageType::MessageType_Failure => break,
                    Ok(_) => continue,
                    Err(_) => break,
                }
            }
        }
    }

    fn passphrase_on_device(&self) -> bool {
        self.features.as_ref().is_some_and(|f| {
            f.capabilities.iter().any(|c| {
                c.enum_value() == Ok(protos::features::Capability::Capability_PassphraseEntry)
            })
        })
    }

    fn initialize(&mut self) -> HwResult<()> {
        self.arm(Instant::now() + Duration::from_secs(5), None);
        let mut init = protos::Initialize::new();
        if let Some(sid) = self.features.as_ref().and_then(|f| f.session_id.clone()) {
            init.set_session_id(sid);
        }
        self.write(MessageType::MessageType_Initialize, encode(&init)?)?;
        let f: protos::Features = decode(self.read()?)?;
        self.features = Some(f);
        Ok(())
    }

    fn send<M: TrezorMessage, R: TrezorMessage>(&mut self, ctl: &Ctl, msg: &M) -> HwResult<R> {
        decode(self.call(ctl, M::MESSAGE_TYPE, encode(msg)?)?)
    }

    fn features(&self) -> HwResult<&protos::Features> {
        self.features
            .as_ref()
            .ok_or_else(|| HwError::bad("caractéristiques de l'appareil inconnues"))
    }

    fn firmware(&self) -> HwResult<String> {
        let f = self.features()?;
        Ok(format!(
            "{}.{}.{}",
            f.major_version(),
            f.minor_version(),
            f.patch_version()
        ))
    }

    fn chain_status(&self, chain: Chain) -> HwResult<ChainStatus> {
        use protos::features::Capability as C;
        let f = self.features()?;
        let internal = f.internal_model();
        let one = internal == "T1B1" || f.major_version() == 1;
        let fw = self.firmware()?;
        let has = |c: C| f.capabilities.iter().any(|x| x.enum_value() == Ok(c));
        let mut st = ChainStatus::new(chain, ChainState::Ready);
        let refuse = |mut st: ChainStatus, reason: &str, min: Option<&str>| {
            st.state = ChainState::Unsupported;
            st.reason = Some(reason.to_string());
            st.min = min.map(str::to_string);
            st
        };
        if f.bootloader_mode() {
            return Ok(refuse(st, "appareil en mode bootloader", None));
        }
        if !f.initialized() {
            return Ok(refuse(st, "appareil non initialisé", None));
        }
        if internal == "T3W1" {
            return Ok(refuse(
                st,
                "Trezor Safe 7 : protocole THP pas encore pris en charge par Kyro",
                None,
            ));
        }
        let (cap, min) = match chain {
            Chain::Btc => (C::Capability_Bitcoin, if one { "1.10.4" } else { "2.4.3" }),
            Chain::Evm => (C::Capability_Ethereum, if one { "1.10.4" } else { "2.4.2" }),
            Chain::Sol if one => {
                return Ok(refuse(st, "Solana n'existe pas sur la Trezor One", None))
            }
            Chain::Sol => (C::Capability_Solana, "2.6.4"),
            other => {
                // Trezor apps exist for LTC, DOGE (Bitcoin-like coins), XRP, Cardano (T/Safe),
                // Tron (recent firmware): not implemented in Kyro yet.
                return Ok(ChainStatus::not_yet(other, None));
            }
        };
        st.min = Some(min.into());
        if !version_at_least(&fw, min) {
            st.state = ChainState::Unsupported;
            st.reason = Some(format!("firmware {fw} trop ancien"));
        } else if !has(cap) {
            st.state = ChainState::Unsupported;
            st.reason = Some("non disponible sur ce firmware (version Bitcoin-only ?)".into());
        } else if f.unlocked.is_some_and(|u| !u) {
            st.state = ChainState::Unlock;
        }
        Ok(st)
    }

    fn ensure(&self, chain: Chain) -> HwResult<()> {
        let st = self.chain_status(chain)?;
        match st.state {
            ChainState::Ready | ChainState::Unlock => Ok(()),
            _ => Err(HwError::Unsupported {
                what: st.reason.unwrap_or_else(|| chain.label().into()),
                min: st.min,
            }),
        }
    }

    fn coin(net: Network) -> &'static str {
        match net {
            Network::Mainnet => "Bitcoin",
            Network::Testnet => "Testnet",
        }
    }
}

fn script_type(kind: BtcKind) -> protos::InputScriptType {
    match kind {
        BtcKind::Segwit => protos::InputScriptType::SPENDWITNESS,
        BtcKind::Taproot => protos::InputScriptType::SPENDTAPROOT,
    }
}

impl<L: Link> TrezorIo for Trezor<L> {
    fn call(&mut self, ctl: &Ctl, mt: MessageType, payload: Vec<u8>) -> HwResult<ProtoMessage> {
        use protos::button_request::ButtonRequestType as B;
        ctl.check()?;
        self.arm(ctl.deadline(), Some(ctl.cancel_flag()));
        self.write(mt, payload)?;
        loop {
            let resp = match self.read() {
                Ok(r) => r,
                Err(e) => {
                    if matches!(e, HwError::Timeout | HwError::Cancelled) {
                        self.abort();
                    }
                    return Err(e);
                }
            };
            match resp.message_type() {
                MessageType::MessageType_ButtonRequest => {
                    let br: protos::ButtonRequest = decode(resp)?;
                    ctl.prompt(match br.code() {
                        B::ButtonRequest_PinEntry => Prompt::PinOnDevice,
                        B::ButtonRequest_PassphraseEntry => Prompt::PassphraseOnDevice,
                        _ => Prompt::ConfirmOnDevice,
                    });
                    self.write(
                        MessageType::MessageType_ButtonAck,
                        encode(&protos::ButtonAck::new())?,
                    )?;
                }
                MessageType::MessageType_PinMatrixRequest => {
                    ctl.prompt(Prompt::PinMatrix);
                    let positions = match ctl.wait_pin() {
                        Ok(p) => p,
                        Err(e) => {
                            self.abort();
                            return Err(e);
                        }
                    };
                    let mut ack = protos::PinMatrixAck::new();
                    ack.set_pin(positions.to_string());
                    self.write(MessageType::MessageType_PinMatrixAck, encode(&ack)?)?;
                }
                MessageType::MessageType_PassphraseRequest => {
                    if !self.passphrase_on_device() {
                        self.abort();
                        return Err(HwError::unsupported(
                            "passphrase à saisir sur l'ordinateur (Trezor One) : Kyro ne \
                             fait jamais passer une passphrase par l'interface",
                        ));
                    }
                    ctl.prompt(Prompt::PassphraseOnDevice);
                    let mut ack = protos::PassphraseAck::new();
                    ack.set_on_device(true);
                    self.write(MessageType::MessageType_PassphraseAck, encode(&ack)?)?;
                }
                MessageType::MessageType_Failure => {
                    let f: protos::Failure = decode(resp)?;
                    return Err(map_failure(&f));
                }
                _ => return Ok(resp),
            }
        }
    }
}

impl<L: Link + Send> HardwareWallet for Trezor<L> {
    fn status(&mut self, ctl: &Ctl, _net: Network) -> HwResult<DeviceStatus> {
        let f: protos::Features = self.send(ctl, &protos::GetFeatures::new())?;
        self.features = Some(f);
        let mut chains = Vec::new();
        for chain in Chain::ALL {
            chains.push(self.chain_status(chain)?);
        }
        let f = self.features()?;
        Ok(DeviceStatus {
            id: String::new(),
            kind: HwDeviceKind::Trezor,
            model: model_name(f.internal_model()).into(),
            locked: f.unlocked.is_some_and(|u| !u),
            app: None,
            firmware: Some(self.firmware()?),
            passphrase: Some(f.passphrase_protection()),
            chains,
        })
    }

    fn btc_account(
        &mut self,
        ctl: &Ctl,
        net: Network,
        kind: BtcKind,
        account: u32,
    ) -> HwResult<BtcAccount> {
        self.ensure(Chain::Btc)?;
        let path = btc_account_path(net, kind, account);
        let mut req = protos::GetPublicKey::new();
        req.address_n = path.to_vec();
        req.set_coin_name(Self::coin(net).into());
        req.set_script_type(script_type(kind));
        req.set_ignore_xpub_magic(true);
        req.set_show_display(false);
        let pk: protos::PublicKey = self.send(ctl, &req)?;
        let fp = pk
            .root_fingerprint
            .ok_or_else(|| HwError::too_old("empreinte maître non fournie", "2.4.3"))?;
        Ok(BtcAccount {
            kind,
            xpub: pk.xpub().to_string(),
            fingerprint: format!("{fp:08x}"),
            path: path_string(&path),
        })
    }

    fn btc_display_address(
        &mut self,
        ctl: &Ctl,
        net: Network,
        account: &BtcAccount,
        change: bool,
        index: u32,
    ) -> HwResult<String> {
        self.ensure(Chain::Btc)?;
        let mut path = btc_account_path(net, account.kind, account_index(account)?).to_vec();
        path.extend([u32::from(change), index]);
        let mut req = protos::GetAddress::new();
        req.address_n = path;
        req.set_coin_name(Self::coin(net).into());
        req.set_script_type(script_type(account.kind));
        req.set_show_display(true);
        let a: protos::Address = self.send(ctl, &req)?;
        Ok(a.address().to_string())
    }

    fn btc_sign(
        &mut self,
        ctl: &Ctl,
        net: Network,
        req: &BtcSignRequest<'_>,
    ) -> HwResult<Vec<HwBtcSignature>> {
        self.ensure(Chain::Btc)?;
        super::trezor_btc::sign(self, ctl, net, Self::coin(net), req)
    }

    fn evm_node(&mut self, ctl: &Ctl) -> HwResult<String> {
        self.ensure(Chain::Evm)?;
        let mut req = protos::EthereumGetPublicKey::new();
        req.address_n = evm_path(0)[..4].to_vec();
        req.set_show_display(false);
        let pk: protos::EthereumPublicKey = self.send(ctl, &req)?;
        let node = pk
            .node
            .as_ref()
            .ok_or_else(|| HwError::bad("nœud absent"))?;
        wallet_core::evm_xpub_from_node(node.public_key(), node.chain_code())
            .map_err(|e| HwError::bad(e.to_string()))
    }

    fn evm_address(&mut self, ctl: &Ctl, index: u32, display: bool) -> HwResult<String> {
        self.ensure(Chain::Evm)?;
        let mut req = protos::EthereumGetAddress::new();
        req.address_n = evm_path(index).to_vec();
        req.set_show_display(display);
        let a: protos::EthereumAddress = self.send(ctl, &req)?;
        wallet_core::evm_checksum_address(a.address()).map_err(|e| HwError::bad(e.to_string()))
    }

    fn evm_sign(&mut self, ctl: &Ctl, req: &EvmSignRequest<'_>) -> HwResult<([u8; 32], [u8; 32])> {
        self.ensure(Chain::Evm)?;
        let f = wallet_core::evm_tx_fields(req.tx).map_err(|e| HwError::bad(e.to_string()))?;
        let mut m = protos::EthereumSignTxEIP1559::new();
        m.address_n = evm_path(req.index).to_vec();
        m.set_nonce(f.nonce);
        m.set_max_gas_fee(f.max_fee_per_gas);
        m.set_max_priority_fee(f.max_priority_fee_per_gas);
        m.set_gas_limit(f.gas_limit);
        m.set_to(f.to);
        m.set_value(f.value);
        m.set_chain_id(f.chain_id);
        let data = f.data;
        let first = data.len().min(1024);
        m.set_data_initial_chunk(data[..first].to_vec());
        m.set_data_length(
            u32::try_from(data.len()).map_err(|_| HwError::bad("données trop longues"))?,
        );
        let mut offset = first;
        let mut resp: protos::EthereumTxRequest = self.send(ctl, &m)?;
        while resp.data_length() > 0 {
            let n = resp.data_length() as usize;
            let chunk = data
                .get(offset..offset + n)
                .ok_or_else(|| HwError::bad("l'appareil demande plus de données qu'il n'y en a"))?;
            offset += n;
            let mut ack = protos::EthereumTxAck::new();
            ack.set_data_chunk(chunk.to_vec());
            resp = self.send(ctl, &ack)?;
        }
        if offset != data.len() {
            return Err(HwError::bad("l'appareil n'a pas lu toutes les données"));
        }
        let r: [u8; 32] = resp
            .signature_r()
            .try_into()
            .map_err(|_| HwError::bad("r invalide"))?;
        let s: [u8; 32] = resp
            .signature_s()
            .try_into()
            .map_err(|_| HwError::bad("s invalide"))?;
        Ok((r, s))
    }

    fn evm_clear_signs(&self, kind: EvmTxKind, _has_descriptor: bool) -> bool {
        // ERC-20 transfer: recipient, raw amount and contract are shown ("Unknown token"
        // when not in the firmware's list). Approvals and other calls: data only.
        matches!(kind, EvmTxKind::NativeTransfer | EvmTxKind::Erc20Transfer)
    }

    fn sol_address(&mut self, ctl: &Ctl, account: u32, display: bool) -> HwResult<String> {
        self.ensure(Chain::Sol)?;
        if display {
            let mut req = protos::SolanaGetAddress::new();
            req.address_n = sol_path(account).to_vec();
            req.set_show_display(true);
            let a: protos::SolanaAddress = self.send(ctl, &req)?;
            return Ok(a.address().to_string());
        }
        let mut req = protos::SolanaGetPublicKey::new();
        req.address_n = sol_path(account).to_vec();
        req.set_show_display(false);
        let pk: protos::SolanaPublicKey = self.send(ctl, &req)?;
        wallet_core::sol_address_of_pubkey(pk.public_key()).map_err(|e| HwError::bad(e.to_string()))
    }

    fn sol_sign(&mut self, ctl: &Ctl, account: u32, message: &[u8]) -> HwResult<Vec<u8>> {
        self.ensure(Chain::Sol)?;
        let mut req = protos::SolanaSignTx::new();
        req.address_n = sol_path(account).to_vec();
        req.set_serialized_tx(message.to_vec());
        let sig: protos::SolanaTxSignature = self.send(ctl, &req)?;
        Ok(sig.signature().to_vec())
    }
}

fn account_index(a: &BtcAccount) -> HwResult<u32> {
    a.path
        .trim_end_matches('\'')
        .rsplit('/')
        .next()
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| HwError::bad("chemin de compte invalide"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use protobuf::Enum;
    use std::collections::VecDeque;

    /// A fake USB link that records the chunks written and plays back canned chunks.
    struct FakeLink {
        written: Vec<Vec<u8>>,
        replies: VecDeque<Result<Vec<u8>, TErr>>,
    }

    impl Link for FakeLink {
        fn write_chunk(&mut self, chunk: Vec<u8>) -> Result<(), TErr> {
            self.written.push(chunk);
            Ok(())
        }
        fn read_chunk(&mut self) -> Result<Vec<u8>, TErr> {
            self.replies
                .pop_front()
                .unwrap_or(Err(TErr::DeviceReadTimeout))
        }
    }

    /// Protocol v1 framing of one message: `?##` + type (u16 BE) + length (u32 BE) + payload.
    fn frame(mt: MessageType, payload: &[u8]) -> Vec<Vec<u8>> {
        let mut data = vec![0x23, 0x23];
        data.extend((mt.value() as u16).to_be_bytes());
        data.extend((payload.len() as u32).to_be_bytes());
        data.extend(payload);
        data.chunks(63)
            .map(|c| {
                let mut chunk = vec![0x3f];
                chunk.extend(c);
                chunk.resize(CHUNK, 0);
                chunk
            })
            .collect()
    }

    fn trezor(replies: Vec<Result<Vec<u8>, TErr>>) -> Trezor<FakeLink> {
        let mut f = protos::Features::new();
        f.set_major_version(2);
        f.set_minor_version(8);
        f.set_patch_version(9);
        f.set_internal_model("T3T1".into());
        f.set_initialized(true);
        f.set_unlocked(true);
        f.capabilities = vec![
            protos::features::Capability::Capability_Bitcoin.into(),
            protos::features::Capability::Capability_Ethereum.into(),
            protos::features::Capability::Capability_Solana.into(),
            protos::features::Capability::Capability_PassphraseEntry.into(),
        ];
        Trezor {
            proto: ProtocolV1 {
                link: FakeLink {
                    written: Vec::new(),
                    replies: replies.into(),
                },
            },
            limit: Arc::new(Mutex::new(Limit::idle())),
            features: Some(f),
        }
    }

    fn ctl() -> Ctl {
        Ctl::for_tests(Duration::from_secs(5))
    }

    #[test]
    fn wire_framing_matches_protocol_v1() {
        // GetFeatures (type 55, empty payload): "?##" 0037 00000000.
        let mut t = trezor(vec![]);
        t.write(MessageType::MessageType_GetFeatures, Vec::new())
            .unwrap();
        let w = &t.proto.link.written;
        assert_eq!(w.len(), 1);
        assert_eq!(hex::encode(&w[0][..9]), "3f2323003700000000");
        // A 100-byte payload spans two chunks; the second starts with '?' only.
        let mut t = trezor(vec![]);
        t.write(MessageType::MessageType_SignTx, vec![7u8; 100])
            .unwrap();
        assert_eq!(t.proto.link.written.len(), 2);
        assert_eq!(t.proto.link.written[1][0], 0x3f);
        assert_ne!(t.proto.link.written[1][1], 0x23);
    }

    #[test]
    fn button_requests_are_acked_and_prompted() {
        let mut br = protos::ButtonRequest::new();
        br.set_code(protos::button_request::ButtonRequestType::ButtonRequest_SignTx);
        let mut addr = protos::SolanaAddress::new();
        addr.set_address("addr".into());
        let mut replies: Vec<_> = frame(
            MessageType::MessageType_ButtonRequest,
            &br.write_to_bytes().unwrap(),
        )
        .into_iter()
        .map(Ok)
        .collect();
        replies.extend(
            frame(
                MessageType::MessageType_SolanaAddress,
                &addr.write_to_bytes().unwrap(),
            )
            .into_iter()
            .map(Ok),
        );
        let mut t = trezor(replies);
        let prompts = Arc::new(Mutex::new(Vec::new()));
        let p2 = prompts.clone();
        let c = Ctl::new(Duration::from_secs(5), Arc::new(move |p| lock(&p2).push(p)));
        let a = t.sol_address(&c, 0, true).unwrap();
        assert_eq!(a, "addr");
        assert_eq!(*lock(&prompts), vec![Prompt::ConfirmOnDevice]);
        // Written: SolanaGetAddress, then ButtonAck (type 27).
        let w = &t.proto.link.written;
        assert_eq!(u16::from_be_bytes([w[1][3], w[1][4]]), 27);
    }

    #[test]
    fn failures_map_to_typed_errors() {
        let fail = |code: protos::failure::FailureType| {
            let mut f = protos::Failure::new();
            f.set_code(code);
            f.set_message("x".into());
            frame(
                MessageType::MessageType_Failure,
                &f.write_to_bytes().unwrap(),
            )
            .into_iter()
            .map(Ok)
            .collect::<Vec<_>>()
        };
        use protos::failure::FailureType as F;
        for (code, want) in [
            (F::Failure_ActionCancelled, HwError::Rejected),
            (F::Failure_PinCancelled, HwError::Rejected),
            (F::Failure_PinInvalid, HwError::Locked),
        ] {
            let mut t = trezor(fail(code));
            assert_eq!(t.sol_sign(&ctl(), 0, &[1]), Err(want));
        }
        let mut t = trezor(fail(F::Failure_DataError));
        assert!(matches!(
            t.sol_sign(&ctl(), 0, &[1]),
            Err(HwError::BadResponse(_))
        ));
    }

    #[test]
    fn unplug_mid_signing_is_disconnected() {
        let mut br = protos::ButtonRequest::new();
        br.set_code(protos::button_request::ButtonRequestType::ButtonRequest_SignTx);
        let mut replies: Vec<_> = frame(
            MessageType::MessageType_ButtonRequest,
            &br.write_to_bytes().unwrap(),
        )
        .into_iter()
        .map(Ok)
        .collect();
        replies.push(Err(TErr::Usb(rusb::Error::NoDevice)));
        let mut t = trezor(replies);
        assert_eq!(t.sol_sign(&ctl(), 0, &[1]), Err(HwError::Disconnected));
    }

    #[test]
    fn timeout_and_cancel_are_reported_as_such() {
        // The link gives up (deadline) → Timeout; then the abort sends Cancel.
        let mut t = trezor(vec![]);
        lock(&t.limit).stopped = None;
        let c = Ctl::for_tests(Duration::from_secs(5));
        // Simulate the link deciding "timeout" on the first read.
        t.proto.link.replies.push_back(Err(TErr::DeviceReadTimeout));
        let r = {
            let res = t.call(&c, MessageType::MessageType_GetFeatures, Vec::new());
            res.map(|_| ())
        };
        assert_eq!(r, Err(HwError::Timeout));
        // A Cancel message (type 20) was written after the request.
        let types: Vec<u16> = t
            .proto
            .link
            .written
            .iter()
            .map(|w| u16::from_be_bytes([w[3], w[4]]))
            .collect();
        assert_eq!(types, vec![55, 20]);
    }

    #[test]
    fn passphrase_on_host_is_refused_for_trezor_one() {
        let req = protos::PassphraseRequest::new();
        let replies: Vec<_> = frame(
            MessageType::MessageType_PassphraseRequest,
            &req.write_to_bytes().unwrap(),
        )
        .into_iter()
        .map(Ok)
        .collect();
        let mut t = trezor(replies);
        t.features.as_mut().unwrap().capabilities.clear();
        t.features.as_mut().unwrap().capabilities = vec![
            protos::features::Capability::Capability_Bitcoin.into(),
            protos::features::Capability::Capability_Solana.into(),
        ];
        assert!(matches!(
            t.sol_sign(&ctl(), 0, &[1]),
            Err(HwError::Unsupported { .. })
        ));
    }

    #[test]
    fn chain_support_by_model_and_firmware() {
        let t = trezor(vec![]);
        assert_eq!(t.chain_status(Chain::Sol).unwrap().state, ChainState::Ready);
        assert_eq!(
            t.chain_status(Chain::Xrp).unwrap().state,
            ChainState::Unsupported
        );
        let mut one = trezor(vec![]);
        let f = one.features.as_mut().unwrap();
        f.set_internal_model("T1B1".into());
        f.set_major_version(1);
        f.set_minor_version(10);
        f.set_patch_version(3);
        assert_eq!(
            one.chain_status(Chain::Sol).unwrap().state,
            ChainState::Unsupported
        );
        let btc = one.chain_status(Chain::Btc).unwrap();
        assert_eq!(btc.state, ChainState::Unsupported);
        assert_eq!(btc.min.as_deref(), Some("1.10.4"));
        let mut safe7 = trezor(vec![]);
        safe7
            .features
            .as_mut()
            .unwrap()
            .set_internal_model("T3W1".into());
        assert!(matches!(
            safe7.ensure(Chain::Btc),
            Err(HwError::Unsupported { .. })
        ));
        assert_eq!(model_name("T3B1"), "Trezor Safe 3");
    }
}
