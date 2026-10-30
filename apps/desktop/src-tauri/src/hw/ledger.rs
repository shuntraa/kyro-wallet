//! Ledger over USB HID (hidapi): Bitcoin app v2 (Ledger's `ledger_bitcoin_client`, PSBT +
//! default wallet policies), Ethereum app (EIP-1559, ERC-20 descriptors), Solana app.
//!
//! The right app must be open on the device: "Bitcoin Test" on testnet / "Bitcoin" on
//! mainnet, "Ethereum" (all EVM chains), "Solana". Kyro checks it with GET APP AND VERSION
//! before every operation and answers `HW_WRONG_APP { expected, open }` otherwise.

use std::ffi::CString;
use std::str::FromStr;
use std::sync::{Mutex, OnceLock};

use bitcoin::bip32::{DerivationPath, Fingerprint, Xpub};
use hidapi::{HidApi, HidDevice};
use ledger_bitcoin_client::apdu::{APDUCommand, StatusWord};
use ledger_bitcoin_client::psbt::PartialSignature;
use ledger_bitcoin_client::wallet::{Version, WalletPubKey};
use ledger_bitcoin_client::{BitcoinClient, SignPsbtYieldedObject, WalletPolicy};
use wallet_core::{BtcAccount, BtcKind, EvmTxKind, HwBtcSignature, HwDeviceKind, Network};

use super::ledger_apdu::{self as apdu, SwContext, DASHBOARD, SW_OK};
use super::{
    btc_account_path, evm_path, lock, path_string, sol_path, version_at_least, AppInfo,
    BtcSignRequest, Chain, ChainState, ChainStatus, Ctl, DeviceStatus, EvmSignRequest, Found,
    HardwareWallet, HwError, HwResult, Locator as AnyLocator, POLL,
};

pub const VENDOR_ID: u16 = 0x2c97;
const USAGE_PAGE: u16 = 0xffa0;

/// Minimum app versions (see SECURITY.md): Bitcoin 2.1.0 (PSBT protocol v1 used by
/// `ledger_bitcoin_client`), Ethereum 1.9.0 (EIP-1559), Solana 1.3.1 (v0 messages).
pub fn app_for(chain: Chain, net: Network) -> Option<(&'static str, &'static str)> {
    match chain {
        Chain::Btc => Some((
            match net {
                Network::Mainnet => "Bitcoin",
                Network::Testnet => "Bitcoin Test",
            },
            "2.1.0",
        )),
        Chain::Evm => Some(("Ethereum", "1.9.0")),
        Chain::Sol => Some(("Solana", "1.3.1")),
        _ => None,
    }
}

/// Ledger apps for the phase-4 chains (informative, shown by `hw_open`).
fn phase4_app(chain: Chain) -> Option<&'static str> {
    match chain {
        Chain::Ltc => Some("Litecoin"),
        Chain::Doge => Some("Dogecoin"),
        Chain::Tron => Some("Tron"),
        Chain::Cardano => Some("Cardano ADA"),
        Chain::Xrp => Some("XRP"),
        _ => None,
    }
}

#[derive(Debug, Clone)]
pub struct Locator {
    path: CString,
}

/// Model from the USB product id (high byte on current firmware, legacy ids otherwise),
/// as listed in Ledger's `@ledgerhq/devices`.
pub fn model_of(pid: u16) -> &'static str {
    match pid >> 8 {
        0x10 => "Nano S",
        0x40 => "Nano X",
        0x50 => "Nano S Plus",
        0x60 => "Stax",
        0x70 => "Flex",
        _ => match pid {
            0x0001 => "Nano S",
            0x0004 => "Nano X",
            0x0005 => "Nano S Plus",
            0x0006 => "Stax",
            0x0007 => "Flex",
            _ => "Ledger",
        },
    }
}

/// hidapi allows a single `HidApi` per process.
fn hidapi() -> &'static Mutex<Option<HidApi>> {
    static API: OnceLock<Mutex<Option<HidApi>>> = OnceLock::new();
    API.get_or_init(|| Mutex::new(None))
}

pub fn enumerate() -> Vec<Found> {
    let mut guard = lock(hidapi());
    if guard.is_none() {
        *guard = HidApi::new().ok();
    } else if let Some(api) = guard.as_mut() {
        let _ = api.refresh_devices();
    }
    let Some(api) = guard.as_ref() else {
        return Vec::new();
    };
    let mut out: Vec<Found> = Vec::new();
    for d in api.device_list() {
        if d.vendor_id() != VENDOR_ID {
            continue;
        }
        // The APDU interface: usage page 0xffa0 (Windows, macOS), interface 0 (Linux hidraw).
        let apdu_iface =
            d.usage_page() == USAGE_PAGE || (d.usage_page() == 0 && d.interface_number() == 0);
        if !apdu_iface {
            continue;
        }
        let key = format!("ledger:{}", d.path().to_string_lossy());
        if out.iter().any(|f| f.key == key) {
            continue;
        }
        out.push(Found {
            kind: HwDeviceKind::Ledger,
            model: model_of(d.product_id()).to_string(),
            transport: "hid",
            key,
            locator: AnyLocator::Ledger(Locator {
                path: d.path().to_owned(),
            }),
        });
    }
    out
}

pub fn open(loc: &Locator, model: &str) -> HwResult<Box<dyn HardwareWallet>> {
    let guard = lock(hidapi());
    let api = guard.as_ref().ok_or(HwError::NotFound)?;
    let dev = api.open_path(&loc.path).map_err(|_| HwError::NotFound)?;
    Ok(Box::new(Ledger {
        link: HidLink { dev },
        model: model.to_string(),
    }))
}

/// Raw APDU exchange. `HidLink` in the app, a recorded replay in tests.
pub trait ApduLink: Send {
    /// Sends one APDU, returns `(data, status word)`.
    fn exchange(&self, ctl: &Ctl, apdu: &[u8]) -> HwResult<(Vec<u8>, u16)>;
}

pub struct HidLink {
    dev: HidDevice,
}

impl ApduLink for HidLink {
    fn exchange(&self, ctl: &Ctl, apdu_bytes: &[u8]) -> HwResult<(Vec<u8>, u16)> {
        ctl.check()?;
        // Drop whatever a previously abandoned exchange left in the input queue.
        let mut junk = [0u8; apdu::PACKET];
        for _ in 0..64 {
            match self.dev.read_timeout(&mut junk, 0) {
                Ok(0) => break,
                Ok(_) => continue,
                Err(_) => return Err(HwError::Disconnected),
            }
        }
        for f in apdu::frames(apdu_bytes) {
            let mut report = [0u8; apdu::PACKET + 1]; // leading HID report id 0
            report[1..].copy_from_slice(&f);
            self.dev.write(&report).map_err(|_| HwError::Disconnected)?;
        }
        let mut d = apdu::Deframer::default();
        loop {
            let mut pkt = [0u8; apdu::PACKET];
            let n = self
                .dev
                .read_timeout(&mut pkt, POLL.as_millis() as i32)
                .map_err(|_| HwError::Disconnected)?;
            if n == 0 {
                ctl.check()?;
                continue;
            }
            if let Some(resp) = d.push(&pkt[..n])? {
                return apdu::split_sw(resp);
            }
        }
    }
}

// SAFETY-free note: `HidDevice` is `Send` in hidapi 2.x; the device is only used behind the
// per-device mutex of `HwManager`.
pub struct Ledger<L: ApduLink> {
    link: L,
    model: String,
}

impl<L: ApduLink> Ledger<L> {
    #[cfg(test)]
    pub fn with_link(link: L) -> Self {
        Ledger {
            link,
            model: "test".into(),
        }
    }

    fn open_app(&self, ctl: &Ctl) -> HwResult<(String, String)> {
        let (data, sw) = self.link.exchange(ctl, &apdu::get_app_and_version())?;
        if sw != SW_OK {
            return Err(apdu::sw_error(sw, SwContext::General));
        }
        apdu::parse_app_and_version(&data)
    }

    /// Fails unless the app for `chain` is open, recent enough.
    fn ensure_app(&self, ctl: &Ctl, chain: Chain, net: Network) -> HwResult<()> {
        let (expected, min) = app_for(chain, net)
            .ok_or_else(|| HwError::unsupported(format!("{} sur Ledger", chain.label())))?;
        let (name, version) = self.open_app(ctl)?;
        if name != expected {
            return Err(HwError::WrongApp {
                expected: expected.into(),
                open: name,
            });
        }
        if !version_at_least(&version, min) {
            return Err(HwError::too_old(
                format!("app {expected} {version} trop ancienne : mets-la à jour"),
                min,
            ));
        }
        Ok(())
    }

    /// Exchange + status word check. Wrong-app codes are completed with the open app name.
    fn call(&self, ctl: &Ctl, cmd: &[u8], ctx: SwContext, expected_app: &str) -> HwResult<Vec<u8>> {
        let (data, sw) = self.link.exchange(ctl, cmd)?;
        if sw == SW_OK {
            return Ok(data);
        }
        Err(self.status_error(ctl, sw, ctx, expected_app))
    }

    fn status_error(&self, ctl: &Ctl, sw: u16, ctx: SwContext, expected_app: &str) -> HwError {
        match apdu::sw_error(sw, ctx) {
            HwError::WrongApp { .. } => HwError::WrongApp {
                expected: expected_app.into(),
                open: self
                    .open_app(ctl)
                    .map(|(n, _)| n)
                    .unwrap_or_else(|_| "?".into()),
            },
            e => e,
        }
    }

    fn btc_client<'a>(&'a self, ctl: &'a Ctl, net: Network) -> BitcoinClient<BtcTransport<'a, L>> {
        BitcoinClient::new(BtcTransport {
            ledger: self,
            ctl,
            app: app_for(Chain::Btc, net).map(|a| a.0).unwrap_or("Bitcoin"),
        })
    }
}

/// Adapter for `ledger_bitcoin_client`: only `9000` and `E000` (interrupted, the client's
/// interactive protocol) are passed through; every other status word becomes a typed error
/// here, so locked / wrong app / refused are reported precisely.
struct BtcTransport<'a, L: ApduLink> {
    ledger: &'a Ledger<L>,
    ctl: &'a Ctl,
    app: &'static str,
}

impl<L: ApduLink> ledger_bitcoin_client::Transport for BtcTransport<'_, L> {
    type Error = HwError;

    fn exchange(&self, cmd: &APDUCommand) -> Result<(StatusWord, Vec<u8>), HwError> {
        let bytes = apdu::apdu(cmd.cla, cmd.ins, cmd.p1, cmd.p2, &cmd.data)?;
        let (data, sw) = self.ledger.link.exchange(self.ctl, &bytes)?;
        match sw {
            SW_OK => Ok((StatusWord::OK, data)),
            0xE000 => Ok((StatusWord::InterruptedExecution, data)),
            // SIGN_PSBT (0x04), GET_WALLET_ADDRESS with display (0x03): the user may refuse.
            other => {
                let ctx = if matches!(cmd.ins, 0x03 | 0x04) {
                    SwContext::Signing
                } else {
                    SwContext::General
                };
                Err(self.ledger.status_error(self.ctl, other, ctx, self.app))
            }
        }
    }
}

fn client_err(e: ledger_bitcoin_client::error::BitcoinClientError<HwError>) -> HwError {
    use ledger_bitcoin_client::error::BitcoinClientError as E;
    match e {
        E::Transport(e) => e,
        E::UnsupportedAppVersion => HwError::too_old("app Bitcoin trop ancienne", "2.1.0"),
        other => HwError::bad(format!("app Bitcoin : {other:?}")),
    }
}

fn default_policy(acc: &BtcAccount) -> HwResult<WalletPolicy> {
    let xpub = Xpub::from_str(&acc.xpub).map_err(|_| HwError::bad("xpub enregistrée invalide"))?;
    let fp = Fingerprint::from_str(&acc.fingerprint)
        .map_err(|_| HwError::bad("empreinte enregistrée invalide"))?;
    let path = DerivationPath::from_str(&acc.path)
        .map_err(|_| HwError::bad("chemin enregistré invalide"))?;
    let template = match acc.kind {
        BtcKind::Segwit => "wpkh(@0/**)",
        BtcKind::Taproot => "tr(@0/**)",
    };
    Ok(WalletPolicy::new(
        String::new(),
        Version::V2,
        template.into(),
        vec![WalletPubKey::from(((fp, path), xpub))],
    ))
}

impl<L: ApduLink> HardwareWallet for Ledger<L> {
    fn status(&mut self, ctl: &Ctl, net: Network) -> HwResult<DeviceStatus> {
        let (locked, app) = match self.open_app(ctl) {
            Ok((name, version)) => (false, Some(AppInfo { name, version })),
            Err(HwError::Locked) => (true, None),
            Err(e) => return Err(e),
        };
        let mut chains = Vec::new();
        for chain in Chain::ALL {
            let Some((expected, min)) = app_for(chain, net) else {
                chains.push(ChainStatus::not_yet(chain, phase4_app(chain)));
                continue;
            };
            let mut st = ChainStatus::new(chain, ChainState::OpenApp);
            st.app = Some(expected.into());
            st.min = Some(min.into());
            match &app {
                None => st.state = ChainState::Unlock,
                Some(a) if a.name == expected => {
                    if version_at_least(&a.version, min) {
                        st.state = ChainState::Ready;
                    } else {
                        st.state = ChainState::Unsupported;
                        st.reason = Some(format!("app {expected} {} trop ancienne", a.version));
                    }
                }
                Some(_) => {}
            }
            chains.push(st);
        }
        Ok(DeviceStatus {
            id: String::new(),
            kind: HwDeviceKind::Ledger,
            model: self.model.clone(),
            locked,
            app: app.map(|a| {
                if a.name == DASHBOARD {
                    AppInfo {
                        name: "Tableau de bord".into(),
                        version: a.version,
                    }
                } else {
                    a
                }
            }),
            firmware: None,
            passphrase: None,
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
        self.ensure_app(ctl, Chain::Btc, net)?;
        let client = self.btc_client(ctl, net);
        let fp = client.get_master_fingerprint().map_err(client_err)?;
        let raw = btc_account_path(net, kind, account);
        let path = DerivationPath::from(
            raw.iter()
                .map(|i| bitcoin::bip32::ChildNumber::from(*i))
                .collect::<Vec<_>>(),
        );
        let xpub = client
            .get_extended_pubkey(&path, false)
            .map_err(client_err)?;
        Ok(BtcAccount {
            kind,
            xpub: xpub.to_string(),
            fingerprint: fp.to_string(),
            path: path_string(&raw),
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
        self.ensure_app(ctl, Chain::Btc, net)?;
        let policy = default_policy(account)?;
        ctl.prompt(super::Prompt::ConfirmOnDevice);
        let addr = self
            .btc_client(ctl, net)
            .get_wallet_address(&policy, None, change, index, true)
            .map_err(client_err)?;
        Ok(addr.assume_checked().to_string())
    }

    fn btc_sign(
        &mut self,
        ctl: &Ctl,
        net: Network,
        req: &BtcSignRequest<'_>,
    ) -> HwResult<Vec<HwBtcSignature>> {
        self.ensure_app(ctl, Chain::Btc, net)?;
        let kind = req.plan.inputs[0].kind;
        if req.plan.inputs.iter().any(|i| i.kind != kind) {
            return Err(HwError::unsupported(
                "Ledger : une transaction ne peut mélanger des entrées SegWit et Taproot \
                 (une politique de portefeuille par signature)",
            ));
        }
        let account = req
            .accounts
            .iter()
            .find(|a| a.kind == kind)
            .ok_or_else(|| HwError::bad("compte Bitcoin manquant"))?;
        let policy = default_policy(account)?;
        ctl.prompt(super::Prompt::ConfirmOnDevice);
        let yielded = self
            .btc_client(ctl, net)
            .sign_psbt(req.psbt, &policy, None)
            .map_err(client_err)?;
        let mut out = Vec::with_capacity(yielded.len());
        for (input, obj) in yielded {
            match obj {
                SignPsbtYieldedObject::Partial(PartialSignature::Sig(pk, sig)) => {
                    out.push(HwBtcSignature {
                        input,
                        pubkey: Some(pk.to_bytes()),
                        signature: sig.to_vec(),
                    })
                }
                SignPsbtYieldedObject::Partial(PartialSignature::TapScriptSig(x, None, sig)) => out
                    .push(HwBtcSignature {
                        input,
                        pubkey: Some(x.serialize().to_vec()),
                        signature: sig.to_vec(),
                    }),
                _ => return Err(HwError::bad("objet inattendu renvoyé pendant la signature")),
            }
        }
        Ok(out)
    }

    fn evm_node(&mut self, ctl: &Ctl) -> HwResult<String> {
        self.ensure_app(ctl, Chain::Evm, Network::Mainnet)?;
        let path = &evm_path(0)[..4];
        let data = self.call(
            ctl,
            &apdu::eth_get_address(path, false)?,
            SwContext::General,
            "Ethereum",
        )?;
        let a = apdu::eth_parse_address(&data)?;
        check_eth_address(&a)?;
        let cc = a
            .chain_code
            .ok_or_else(|| HwError::bad("code de chaîne absent"))?;
        wallet_core::evm_xpub_from_node(&a.pubkey, &cc).map_err(|e| HwError::bad(e.to_string()))
    }

    fn evm_address(&mut self, ctl: &Ctl, index: u32, display: bool) -> HwResult<String> {
        self.ensure_app(ctl, Chain::Evm, Network::Mainnet)?;
        if display {
            ctl.prompt(super::Prompt::ConfirmOnDevice);
        }
        let ctx = if display {
            SwContext::Signing
        } else {
            SwContext::General
        };
        let data = self.call(
            ctl,
            &apdu::eth_get_address(&evm_path(index), display)?,
            ctx,
            "Ethereum",
        )?;
        check_eth_address(&apdu::eth_parse_address(&data)?)
    }

    fn evm_sign(&mut self, ctl: &Ctl, req: &EvmSignRequest<'_>) -> HwResult<([u8; 32], [u8; 32])> {
        self.ensure_app(ctl, Chain::Evm, Network::Mainnet)?;
        if let Some(token) = req.token {
            let payload = wallet_core::ledger_erc20_payload(token)
                .map_err(|e| HwError::bad(e.to_string()))?;
            self.call(
                ctl,
                &apdu::eth_provide_erc20(&payload)?,
                SwContext::General,
                "Ethereum",
            )?;
        }
        let payload =
            wallet_core::evm_signing_payload(req.tx).map_err(|e| HwError::bad(e.to_string()))?;
        let apdus = apdu::eth_sign(&evm_path(req.index), &payload)?;
        ctl.prompt(super::Prompt::ConfirmOnDevice);
        let mut last = Vec::new();
        for a in &apdus {
            last = self.call(ctl, a, SwContext::EthSigning, "Ethereum")?;
        }
        apdu::eth_parse_signature(&last)
    }

    fn evm_clear_signs(&self, kind: EvmTxKind, has_descriptor: bool) -> bool {
        match kind {
            EvmTxKind::NativeTransfer => true,
            EvmTxKind::Erc20Transfer | EvmTxKind::Erc20Approve => has_descriptor,
            EvmTxKind::ContractCall => false,
        }
    }

    fn sol_address(&mut self, ctl: &Ctl, account: u32, display: bool) -> HwResult<String> {
        self.ensure_app(ctl, Chain::Sol, Network::Mainnet)?;
        if display {
            ctl.prompt(super::Prompt::ConfirmOnDevice);
        }
        let ctx = if display {
            SwContext::Signing
        } else {
            SwContext::General
        };
        let data = self.call(
            ctl,
            &apdu::sol_get_pubkey(&sol_path(account), display)?,
            ctx,
            "Solana",
        )?;
        wallet_core::sol_address_of_pubkey(&data).map_err(|e| HwError::bad(e.to_string()))
    }

    fn sol_sign(&mut self, ctl: &Ctl, account: u32, message: &[u8]) -> HwResult<Vec<u8>> {
        self.ensure_app(ctl, Chain::Sol, Network::Mainnet)?;
        let apdus = apdu::sol_sign(&sol_path(account), message)?;
        ctl.prompt(super::Prompt::ConfirmOnDevice);
        let mut last = Vec::new();
        for a in &apdus {
            last = self.call(ctl, a, SwContext::Signing, "Solana")?;
        }
        if last.len() != 64 {
            return Err(HwError::bad("signature Solana de longueur inattendue"));
        }
        Ok(last)
    }
}

/// The app returns both the public key and its address: they must agree.
fn check_eth_address(a: &apdu::EthAddress) -> HwResult<String> {
    let from_key =
        wallet_core::evm_address_of_pubkey(&a.pubkey).map_err(|e| HwError::bad(e.to_string()))?;
    if !from_key[2..].eq_ignore_ascii_case(&a.address_hex) {
        return Err(HwError::bad(
            "l'adresse renvoyée ne correspond pas à la clé publique renvoyée",
        ));
    }
    Ok(from_key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    type Exchange = (Vec<u8>, Vec<u8>);

    /// Plays back a recorded `=> apdu` / `<= response` script; fails on any deviation.
    struct Replay {
        script: Mutex<Vec<Exchange>>,
    }

    impl Replay {
        fn new(lines: &[&str]) -> Self {
            let mut script = Vec::new();
            for pair in lines.chunks(2) {
                let req = hex::decode(pair[0].trim_start_matches("=> ")).unwrap();
                let resp = hex::decode(pair[1].trim_start_matches("<= ")).unwrap();
                script.push((req, resp));
            }
            script.reverse();
            Replay {
                script: Mutex::new(script),
            }
        }
    }

    impl ApduLink for Replay {
        fn exchange(&self, _ctl: &Ctl, apdu: &[u8]) -> HwResult<(Vec<u8>, u16)> {
            let (req, resp) = lock(&self.script)
                .pop()
                .ok_or_else(|| HwError::bad("script exhausted"))?;
            assert_eq!(hex::encode(apdu), hex::encode(req), "unexpected APDU");
            apdu::split_sw(resp)
        }
    }

    fn ctl() -> Ctl {
        Ctl::for_tests(Duration::from_secs(5))
    }

    const APP_BTC_TEST: [&str; 2] = [
        "=> b001000000",
        "<= 010c426974636f696e205465737405322e312e3001009000",
    ];

    /// Ledger's recorded `get_wallet_address` vector (ledger_bitcoin_client tests,
    /// tests/data/get_wallet_address.json, case 0: default `tr(@0/**)`, address 0, display),
    /// replayed through Kyro's transport adapter and policy builder.
    #[test]
    fn official_taproot_wallet_address_vector() {
        let mut lines = APP_BTC_TEST.to_vec();
        lines.extend_from_slice(OFFICIAL_TR_ADDRESS);
        let mut ledger = Ledger::with_link(Replay::new(&lines));
        let acc = BtcAccount {
            kind: BtcKind::Taproot,
            xpub: "tpubDDKYE6BREvDsSWMazgHoyQWiJwYaDDYPbCFjYxN3HFXJP5fokeiK4hwK5tTLBNEDBwrDXn8cQ4v9b2xdW62Xr5yxoQdMu1v6c7UDXYVH27U".into(),
            fingerprint: "f5acc2fd".into(),
            path: "m/86'/1'/0'".into(),
        };
        let addr = ledger
            .btc_display_address(&ctl(), Network::Testnet, &acc, false, 0)
            .unwrap();
        // Kyro's own derivation from the xpub gives the same address.
        assert_eq!(
            addr,
            wallet_core::btc_address_from_xpub(
                &acc.xpub,
                Network::Testnet,
                BtcKind::Taproot,
                false,
                0
            )
            .unwrap()
        );
    }

    const OFFICIAL_TR_ADDRESS: &[&str] = &include!("testdata/ledger_tr_address.in");
    const OFFICIAL_SIGN_PSBT: &[&str] = &include!("testdata/ledger_sign_psbt_shwpkh.in");

    /// Ledger's recorded SIGN_PSBT vector (sign_psbt.json, case 0, `sh(wpkh(@0/**))`, 448
    /// APDUs of the interactive merkleized-PSBT protocol) replayed through Kyro's transport
    /// adapter: the yielded signature is the recorded one, and it verifies with libsecp256k1
    /// against the BIP143 sighash recomputed here.
    #[test]
    fn official_sign_psbt_vector_through_kyro_transport() {
        use bitcoin::secp256k1::{Message, Secp256k1};
        use bitcoin::sighash::{EcdsaSighashType, SighashCache};
        let ledger = Ledger::with_link(Replay::new(OFFICIAL_SIGN_PSBT));
        let psbt =
            bitcoin::psbt::Psbt::from_str(include_str!("testdata/ledger_sign_psbt_shwpkh.psbt"))
                .unwrap();
        let key = WalletPubKey::from_str("[f5acc2fd/49'/1'/0']tpubDC871vGLAiKPcwAw22EjhKVLk5L98UGXBEcGR8gpcigLQVDDfgcYW24QBEyTHTSFEjgJgbaHU8CdRi9vmG4cPm1kPLmZhJEP17FMBdNheh3").unwrap();
        let policy = WalletPolicy::new(
            String::new(),
            Version::V2,
            "sh(wpkh(@0/**))".into(),
            vec![key],
        );
        let c = ctl();
        let yielded = ledger
            .btc_client(&c, Network::Testnet)
            .sign_psbt(&psbt, &policy, None)
            .unwrap();
        assert_eq!(yielded.len(), 1);
        let (input, SignPsbtYieldedObject::Partial(PartialSignature::Sig(pk, sig))) = &yielded[0]
        else {
            panic!("unexpected yield");
        };
        assert_eq!(
            hex::encode(pk.to_bytes()),
            "024ba3b77d933de9fa3f9583348c40f3caaf2effad5b6e244ece8abbfcc7244f67"
        );
        assert_eq!(hex::encode(sig.to_vec()), "30440220720722b08489c2a50d10edea8e21880086c8e8f22889a16815e306daeea4665b02203fcf453fa490b76cf4f929714065fc90a519b7b97ab18914f9451b5a4b45241201");
        let utxo = psbt.inputs[*input].witness_utxo.as_ref().unwrap();
        let inner =
            bitcoin::ScriptBuf::new_p2wpkh(&bitcoin::CompressedPublicKey(pk.inner).wpubkey_hash());
        let sighash = SighashCache::new(&psbt.unsigned_tx)
            .p2wpkh_signature_hash(*input, &inner, utxo.value, EcdsaSighashType::All)
            .unwrap();
        Secp256k1::verification_only()
            .verify_ecdsa(&Message::from(sighash), &sig.signature, &pk.inner)
            .unwrap();
    }

    #[test]
    fn transport_maps_refusal_inside_bitcoin_protocol() {
        // First SIGN_PSBT APDU of the official vector answered with 6985 (refused).
        let first = OFFICIAL_SIGN_PSBT[0];
        let ledger = Ledger::with_link(Replay::new(&[first, "<= 6985"]));
        let psbt =
            bitcoin::psbt::Psbt::from_str(include_str!("testdata/ledger_sign_psbt_shwpkh.psbt"))
                .unwrap();
        let key = WalletPubKey::from_str("[f5acc2fd/49'/1'/0']tpubDC871vGLAiKPcwAw22EjhKVLk5L98UGXBEcGR8gpcigLQVDDfgcYW24QBEyTHTSFEjgJgbaHU8CdRi9vmG4cPm1kPLmZhJEP17FMBdNheh3").unwrap();
        let policy = WalletPolicy::new(
            String::new(),
            Version::V2,
            "sh(wpkh(@0/**))".into(),
            vec![key],
        );
        let c = ctl();
        let err = ledger
            .btc_client(&c, Network::Testnet)
            .sign_psbt(&psbt, &policy, None)
            .map_err(client_err)
            .unwrap_err();
        assert_eq!(err, HwError::Rejected);
    }

    #[test]
    fn wrong_app_is_reported_with_names() {
        let ledger = Ledger::with_link(Replay::new(&[
            "=> b001000000",
            "<= 0108457468657265756d05312e31322e3001029000", // "Ethereum" 1.12.0
        ]));
        let err = ledger
            .ensure_app(&ctl(), Chain::Btc, Network::Testnet)
            .unwrap_err();
        assert_eq!(
            err,
            HwError::WrongApp {
                expected: "Bitcoin Test".into(),
                open: "Ethereum".into()
            }
        );
    }

    #[test]
    fn locked_and_old_app() {
        let ledger = Ledger::with_link(Replay::new(&["=> b001000000", "<= 5515"]));
        assert_eq!(
            ledger.ensure_app(&ctl(), Chain::Evm, Network::Testnet),
            Err(HwError::Locked)
        );
        // "Bitcoin Test" 2.0.6 < 2.1.0.
        let ledger = Ledger::with_link(Replay::new(&[
            "=> b001000000",
            "<= 010c426974636f696e205465737405322e302e3601009000",
        ]));
        assert!(matches!(
            ledger.ensure_app(&ctl(), Chain::Btc, Network::Testnet),
            Err(HwError::Unsupported { min: Some(_), .. })
        ));
        // Status on a locked device: every chain says "unlock".
        let mut ledger = Ledger::with_link(Replay::new(&["=> b001000000", "<= 5515"]));
        let st = ledger.status(&ctl(), Network::Testnet).unwrap();
        assert!(st.locked);
        assert!(st.chains[..3].iter().all(|c| c.state == ChainState::Unlock));
        assert!(st.chains[3..]
            .iter()
            .all(|c| c.state == ChainState::Unsupported));
    }

    #[test]
    fn refusal_during_signing_and_wrong_app_mid_flow() {
        // User refuses the Solana transaction on the device (6985).
        let path = sol_path(0);
        let sign = apdu::sol_sign(&path, &[1, 2, 3]).unwrap();
        let mut ledger = Ledger::with_link(Replay::new(&[
            "=> b001000000",
            "<= 0106536f6c616e6105312e332e3101009000",
            &format!("=> {}", hex::encode(&sign[0])),
            "<= 6985",
        ]));
        assert_eq!(
            ledger.sol_sign(&ctl(), 0, &[1, 2, 3]),
            Err(HwError::Rejected)
        );
        // Ethereum: blind signing disabled (6A80) → typed "unsupported", not a crash.
        let tx = wallet_core::EvmTxRequest {
            chain_id: 11_155_111,
            nonce: 0,
            to: "0x9858EfFD232B4033E47d90003D41EC34EcaEda94".into(),
            value_wei: "0".into(),
            data: "0x1234".into(),
            gas_limit: 50_000,
            max_fee_per_gas: "2".into(),
            max_priority_fee_per_gas: "1".into(),
        };
        let payload = wallet_core::evm_signing_payload(&tx).unwrap();
        let sign = apdu::eth_sign(&evm_path(0), &payload).unwrap();
        let mut ledger = Ledger::with_link(Replay::new(&[
            "=> b001000000",
            "<= 0108457468657265756d05312e31322e3001029000",
            &format!("=> {}", hex::encode(&sign[0])),
            "<= 6a80",
        ]));
        let req = EvmSignRequest {
            tx: &tx,
            index: 0,
            token: None,
        };
        assert!(matches!(
            ledger.evm_sign(&ctl(), &req),
            Err(HwError::Unsupported { .. })
        ));
    }

    #[test]
    fn eth_address_must_match_its_own_pubkey() {
        let secp = bitcoin::secp256k1::Secp256k1::new();
        let sk = bitcoin::secp256k1::SecretKey::from_slice(&[7u8; 32]).unwrap();
        let pk = sk.public_key(&secp).serialize_uncompressed();
        let right = wallet_core::evm_address_of_pubkey(&pk).unwrap();
        let mk = |addr: &str| apdu::EthAddress {
            pubkey: pk.to_vec(),
            address_hex: addr.to_string(),
            chain_code: None,
        };
        assert_eq!(
            check_eth_address(&mk(&right[2..].to_lowercase())).unwrap(),
            right
        );
        assert!(check_eth_address(&mk("9858EfFD232B4033E47d90003D41EC34EcaEda94")).is_err());
    }

    #[test]
    fn models() {
        assert_eq!(model_of(0x5011), "Nano S Plus");
        assert_eq!(model_of(0x4015), "Nano X");
        assert_eq!(model_of(0x0004), "Nano X");
        assert_eq!(model_of(0x6000), "Stax");
        assert_eq!(model_of(0x7001), "Flex");
        assert_eq!(model_of(0x1234), "Ledger");
    }
}
