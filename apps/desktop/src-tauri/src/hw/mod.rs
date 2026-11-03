//! Hardware wallets (Ledger over USB HID, Trezor over WebUSB).

pub mod chains;
#[cfg(test)]
mod device_check;
pub mod ledger;
pub mod ledger_algo;
pub mod ledger_apdu;
pub mod ledger_apps;
pub mod ledger_aptos;
pub mod ledger_cardano;
pub mod ledger_coins;
pub mod ledger_cosmos;
pub mod ledger_hbar;
pub mod ledger_near;
pub mod ledger_sui;
pub mod ledger_ton;
pub mod ledger_utxo;
pub mod ledger_utxo_v2;
pub mod store;
pub mod thp;
#[cfg(test)]
mod thp_sim;
pub mod thp_store;
pub mod trezor;
pub mod trezor_btc;
pub mod trezor_cardano;
pub mod trezor_coins;
pub mod trezor_zcash;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, RecvTimeoutError, SyncSender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use wallet_core::{
    BtcAccount, BtcKind, EvmTxKind, EvmTxRequest, HwBtcPlan, HwBtcSignature, HwDeviceKind,
    LedgerErc20Descriptor, Network, Zeroizing,
};

use crate::error::AppError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Chain {
    Btc,
    Evm,
    Sol,
    Ltc,
    Doge,
    Tron,
    Cardano,
    Xrp,
    Bch,
    Dash,
    Stellar,
    Zec,
    Sui,
    Apt,
    Algo,
    Near,
    Cosmos,
    Dot,
    Hbar,
    Kas,
    Ton,
}

impl Chain {
    pub const ALL: [Chain; 21] = [
        Chain::Btc,
        Chain::Evm,
        Chain::Sol,
        Chain::Ltc,
        Chain::Doge,
        Chain::Tron,
        Chain::Cardano,
        Chain::Xrp,
        Chain::Bch,
        Chain::Dash,
        Chain::Stellar,
        Chain::Zec,
        Chain::Sui,
        Chain::Apt,
        Chain::Algo,
        Chain::Near,
        Chain::Cosmos,
        Chain::Dot,
        Chain::Hbar,
        Chain::Kas,
        Chain::Ton,
    ];

    pub fn implemented(self) -> bool {
        matches!(
            self,
            Chain::Btc
                | Chain::Evm
                | Chain::Sol
                | Chain::Ltc
                | Chain::Doge
                | Chain::Bch
                | Chain::Dash
                | Chain::Xrp
                | Chain::Tron
                | Chain::Stellar
                | Chain::Cardano
                | Chain::Zec
        ) || ledger_apps::key_chain(self).is_some()
    }

    pub fn label(self) -> &'static str {
        match self {
            Chain::Btc => "Bitcoin",
            Chain::Evm => "Ethereum / EVM",
            Chain::Sol => "Solana",
            Chain::Ltc => "Litecoin",
            Chain::Doge => "Dogecoin",
            Chain::Tron => "Tron",
            Chain::Cardano => "Cardano",
            Chain::Xrp => "XRP",
            Chain::Bch => "Bitcoin Cash",
            Chain::Dash => "Dash",
            Chain::Stellar => "Stellar",
            Chain::Zec => "Zcash",
            Chain::Sui => "Sui",
            Chain::Apt => "Aptos",
            Chain::Algo => "Algorand",
            Chain::Near => "NEAR",
            Chain::Cosmos => "Cosmos Hub",
            Chain::Dot => "Polkadot",
            Chain::Hbar => "Hedera",
            Chain::Kas => "Kaspa",
            Chain::Ton => "TON",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HwError {
    NotFound,
    Locked,
    WrongApp {
        expected: String,
        open: String,
    },
    /// The Ledger has no app of this name.
    AppMissing(String),
    Rejected,
    Disconnected,
    Unsupported {
        what: String,
        min: Option<String>,
    },
    Busy(String),
    Timeout,
    Cancelled,
    BadResponse(String),
    PairingRequired,
    PairingFailed(String),
    Internal(String),
}

pub type HwResult<T> = Result<T, HwError>;

impl HwError {
    pub fn unsupported(what: impl Into<String>) -> Self {
        HwError::Unsupported {
            what: what.into(),
            min: None,
        }
    }

    pub fn too_old(what: impl Into<String>, min: &str) -> Self {
        HwError::Unsupported {
            what: what.into(),
            min: Some(min.to_string()),
        }
    }

    pub fn bad(msg: impl Into<String>) -> Self {
        HwError::BadResponse(msg.into())
    }

    /// The connection is in an unknown state afterwards and must be reopened.
    fn poisons_connection(&self) -> bool {
        matches!(
            self,
            HwError::Disconnected
                | HwError::Timeout
                | HwError::Cancelled
                | HwError::BadResponse(_)
                | HwError::PairingRequired
                | HwError::PairingFailed(_)
        )
    }
}

impl From<HwError> for AppError {
    fn from(e: HwError) -> Self {
        match e {
            HwError::NotFound => AppError::HwNotFound,
            HwError::Locked => AppError::HwLocked,
            HwError::WrongApp { expected, open } => AppError::HwWrongApp { expected, open },
            HwError::AppMissing(app) => AppError::HwAppMissing { app },
            HwError::Rejected => AppError::HwRejected,
            HwError::Disconnected => AppError::HwDisconnected,
            HwError::Unsupported { what, min } => AppError::HwUnsupported { what, min },
            HwError::Busy(m) => AppError::HwBusy(m),
            HwError::Timeout => AppError::HwTimeout,
            HwError::Cancelled => AppError::UserRejected,
            HwError::BadResponse(m) => AppError::HwBadResponse(m),
            HwError::PairingRequired => AppError::HwPairingRequired,
            HwError::PairingFailed(m) => AppError::HwPairingFailed(m),
            HwError::Internal(m) => AppError::Internal(m),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Prompt {
    ConfirmOnDevice,
    /// Ledger: approve opening this app on the device.
    OpenApp(&'static str),
    PinOnDevice,
    PassphraseOnDevice,
    /// Trezor One: show the 3×3 blind matrix, then call `hw_pin_matrix`.
    PinMatrix,
    ThpConfirmPairing,
    ThpPairingCode,
    ThpConfirmConnection,
}

pub type PromptFn = Arc<dyn Fn(Prompt) + Send + Sync>;

pub struct Ctl {
    deadline: Instant,
    cancel: Arc<AtomicBool>,
    prompt: PromptFn,
    pin: Mutex<Option<Receiver<Zeroizing<String>>>>,
    code: Mutex<Option<Receiver<Zeroizing<String>>>>,
    pairing: bool,
}

pub const POLL: Duration = Duration::from_millis(100);

impl Ctl {
    pub fn new(timeout: Duration, prompt: PromptFn) -> Self {
        Ctl {
            deadline: Instant::now() + timeout,
            cancel: Arc::new(AtomicBool::new(false)),
            prompt,
            pin: Mutex::new(None),
            code: Mutex::new(None),
            pairing: false,
        }
    }

    pub fn allow_pairing(mut self) -> Self {
        self.pairing = true;
        self
    }

    pub fn pairing_allowed(&self) -> bool {
        self.pairing
    }

    pub fn wait_pairing_code(&self) -> HwResult<Zeroizing<String>> {
        let guard = lock(&self.code);
        let rx = guard
            .as_ref()
            .ok_or_else(|| HwError::bad("no pairing-code channel"))?;
        loop {
            self.check()?;
            match rx.recv_timeout(POLL) {
                Ok(c) => return Ok(c),
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => return Err(HwError::Cancelled),
            }
        }
    }

    #[cfg(test)]
    pub fn for_pairing_tests(
        timeout: Duration,
        prompt: PromptFn,
    ) -> (Self, SyncSender<Zeroizing<String>>) {
        let (tx, rx) = sync_channel(1);
        let ctl = Ctl::new(timeout, prompt).allow_pairing();
        *lock(&ctl.code) = Some(rx);
        (ctl, tx)
    }

    pub fn check(&self) -> HwResult<()> {
        if self.cancel.load(Ordering::SeqCst) {
            return Err(HwError::Cancelled);
        }
        if Instant::now() >= self.deadline {
            return Err(HwError::Timeout);
        }
        Ok(())
    }

    pub fn prompt(&self, p: Prompt) {
        (self.prompt)(p);
    }

    pub fn deadline(&self) -> Instant {
        self.deadline
    }

    pub fn cancel_flag(&self) -> Arc<AtomicBool> {
        self.cancel.clone()
    }

    /// Waits for `hw_pin_matrix` (positions, never the PIN itself).
    pub fn wait_pin(&self) -> HwResult<Zeroizing<String>> {
        let guard = lock(&self.pin);
        let rx = guard
            .as_ref()
            .ok_or_else(|| HwError::bad("no PIN channel"))?;
        loop {
            self.check()?;
            match rx.recv_timeout(POLL) {
                Ok(p) => return Ok(p),
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => return Err(HwError::Cancelled),
            }
        }
    }

    #[cfg(test)]
    pub fn for_tests(timeout: Duration) -> Self {
        Ctl::new(timeout, Arc::new(|_| {}))
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub id: String,
    pub kind: HwDeviceKind,
    pub model: String,
    pub transport: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: String,
    pub version: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ChainState {
    Ready,
    OpenApp,
    Unlock,
    Unsupported,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChainStatus {
    pub chain: Chain,
    pub state: ChainState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl ChainStatus {
    pub fn new(chain: Chain, state: ChainState) -> Self {
        ChainStatus {
            chain,
            state,
            app: None,
            min: None,
            reason: None,
        }
    }

    pub fn not_yet(chain: Chain, app: Option<&str>) -> Self {
        ChainStatus {
            reason: Some(format!(
                "{}: not yet supported by Kyro (phase 4)",
                chain.label()
            )),
            app: app.map(str::to_string),
            ..ChainStatus::new(chain, ChainState::Unsupported)
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStatus {
    pub id: String,
    pub kind: HwDeviceKind,
    pub model: String,
    pub locked: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app: Option<AppInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub firmware: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub passphrase: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protocol: Option<&'static str>,
    pub chains: Vec<ChainStatus>,
}

pub struct BtcSignRequest<'a> {
    pub psbt: &'a bitcoin::psbt::Psbt,
    pub plan: &'a HwBtcPlan,
    pub accounts: &'a [BtcAccount],
}

pub struct EvmSignRequest<'a> {
    pub tx: &'a EvmTxRequest,
    pub index: u32,
    pub token: Option<&'a LedgerErc20Descriptor>,
}

/// An associated token account a Solana transaction sends to: `token_account` =
/// ATA(`base_address`, `token_program`, `token_mint`), checked by Rust before use.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SolTokenAccount {
    pub base_address: String,
    pub token_program: String,
    pub token_mint: String,
    pub token_account: String,
}

/// One connected device. Implementations never decide what is safe: they talk to the device,
/// map its errors, and return raw results that the caller verifies.
pub trait HardwareWallet: Send {
    fn status(&mut self, ctl: &Ctl, net: Network) -> HwResult<DeviceStatus>;

    fn btc_account(
        &mut self,
        ctl: &Ctl,
        net: Network,
        kind: BtcKind,
        account: u32,
    ) -> HwResult<BtcAccount>;

    fn btc_display_address(
        &mut self,
        ctl: &Ctl,
        net: Network,
        account: &BtcAccount,
        change: bool,
        index: u32,
    ) -> HwResult<String>;

    fn btc_sign(
        &mut self,
        ctl: &Ctl,
        net: Network,
        req: &BtcSignRequest<'_>,
    ) -> HwResult<Vec<HwBtcSignature>>;

    fn evm_node(&mut self, ctl: &Ctl) -> HwResult<String>;

    fn evm_address(&mut self, ctl: &Ctl, index: u32, display: bool) -> HwResult<String>;

    /// `(r, s)` of an EIP-1559 signature.
    fn evm_sign(&mut self, ctl: &Ctl, req: &EvmSignRequest<'_>) -> HwResult<([u8; 32], [u8; 32])>;

    /// Whether the device screen shows the decoded details of this kind of transaction
    /// (otherwise it is blind signing on the device and Kyro asks a reinforced confirmation).
    fn evm_clear_signs(&self, kind: EvmTxKind, has_descriptor: bool) -> bool;

    fn sol_address(&mut self, ctl: &Ctl, account: u32, display: bool) -> HwResult<String>;

    fn sol_sign(&mut self, ctl: &Ctl, account: u32, message: &[u8]) -> HwResult<Vec<u8>>;

    /// Same as [`Self::sol_sign`], with the token accounts the transaction pays to (verified
    /// associated token accounts), so a device that can use them shows the recipient wallet
    /// instead of its token account. Default: ignored (Ledger's Solana app needs none).
    fn sol_sign_tokens(
        &mut self,
        ctl: &Ctl,
        account: u32,
        message: &[u8],
        tokens: &[SolTokenAccount],
    ) -> HwResult<Vec<u8>> {
        let _ = tokens;
        self.sol_sign(ctl, account, message)
    }

    fn raw(&mut self) -> RawDevice<'_> {
        RawDevice::None
    }

    fn apdu_link(&self) -> Option<&dyn ledger::ApduLink> {
        None
    }
}

pub enum RawDevice<'a> {
    Ledger(&'a dyn ledger::ApduLink),
    Trezor(&'a mut dyn trezor::TrezorDevice),
    None,
}

#[derive(Debug, Clone)]
pub enum Locator {
    Ledger(ledger::Locator),
    Trezor(trezor::Locator),
    #[cfg(test)]
    Test,
}

pub struct Found {
    pub kind: HwDeviceKind,
    pub model: String,
    pub transport: &'static str,
    pub key: String,
    pub locator: Locator,
}

struct Slot {
    info: DeviceInfo,
    key: String,
    locator: Locator,
    conn: Mutex<Option<Box<dyn HardwareWallet>>>,
    busy: AtomicBool,
    cancel: Mutex<Arc<AtomicBool>>,
    pin_tx: Mutex<Option<SyncSender<Zeroizing<String>>>>,
    code_tx: Mutex<Option<SyncSender<Zeroizing<String>>>>,
}

impl Slot {
    fn new(info: DeviceInfo, key: String, locator: Locator) -> Self {
        Slot {
            info,
            key,
            locator,
            conn: Mutex::new(None),
            busy: AtomicBool::new(false),
            cancel: Mutex::new(Arc::new(AtomicBool::new(false))),
            pin_tx: Mutex::new(None),
            code_tx: Mutex::new(None),
        }
    }
}

struct BusyGuard(Arc<Slot>);

impl Drop for BusyGuard {
    fn drop(&mut self) {
        *lock(&self.0.pin_tx) = None;
        *lock(&self.0.code_tx) = None;
        self.0.busy.store(false, Ordering::SeqCst);
    }
}

#[derive(Default)]
pub struct HwManager {
    slots: Mutex<HashMap<String, Arc<Slot>>>,
    counter: AtomicU32,
    thp: Arc<thp_store::ThpEnv>,
}

impl HwManager {
    pub fn any_busy(&self) -> bool {
        lock(&self.slots)
            .values()
            .any(|s| s.busy.load(Ordering::SeqCst))
    }

    pub fn list(&self) -> Vec<DeviceInfo> {
        let mut found = Vec::new();
        found.extend(ledger::enumerate());
        found.extend(trezor::enumerate());
        let mut slots = lock(&self.slots);
        slots.retain(|_, s| s.busy.load(Ordering::SeqCst) || found.iter().any(|f| f.key == s.key));
        let mut out = Vec::new();
        for f in found {
            if let Some(s) = slots.values().find(|s| s.key == f.key) {
                out.push(s.info.clone());
                continue;
            }
            let n = self.counter.fetch_add(1, Ordering::SeqCst) + 1;
            let prefix = match f.kind {
                HwDeviceKind::Ledger => "ledger",
                HwDeviceKind::Trezor => "trezor",
            };
            let info = DeviceInfo {
                id: format!("{prefix}-{n}"),
                kind: f.kind,
                model: f.model,
                transport: f.transport,
            };
            slots.insert(
                info.id.clone(),
                Arc::new(Slot::new(info.clone(), f.key, f.locator)),
            );
            out.push(info);
        }
        out.sort_by(|a, b| a.id.cmp(&b.id));
        out
    }

    pub fn info(&self, id: &str) -> HwResult<DeviceInfo> {
        lock(&self.slots)
            .get(id)
            .map(|s| s.info.clone())
            .ok_or(HwError::NotFound)
    }

    pub fn set_thp_store(&self, path: std::path::PathBuf) {
        self.thp.set_path(path);
    }

    pub async fn run<T: Send + 'static>(
        &self,
        id: &str,
        timeout: Duration,
        prompt: PromptFn,
        f: impl FnOnce(&mut dyn HardwareWallet, &Ctl) -> HwResult<T> + Send + 'static,
    ) -> HwResult<T> {
        self.run_inner(id, timeout, prompt, false, f).await
    }

    pub async fn run_pairing<T: Send + 'static>(
        &self,
        id: &str,
        timeout: Duration,
        prompt: PromptFn,
        f: impl FnOnce(&mut dyn HardwareWallet, &Ctl) -> HwResult<T> + Send + 'static,
    ) -> HwResult<T> {
        self.run_inner(id, timeout, prompt, true, f).await
    }

    async fn run_inner<T: Send + 'static>(
        &self,
        id: &str,
        timeout: Duration,
        prompt: PromptFn,
        pairing: bool,
        f: impl FnOnce(&mut dyn HardwareWallet, &Ctl) -> HwResult<T> + Send + 'static,
    ) -> HwResult<T> {
        let slot = lock(&self.slots)
            .get(id)
            .cloned()
            .ok_or(HwError::NotFound)?;
        if slot.busy.swap(true, Ordering::SeqCst) {
            return Err(HwError::Busy(
                "another operation is in progress on this device".into(),
            ));
        }
        let mut ctl = Ctl::new(timeout, prompt);
        if pairing {
            ctl = ctl.allow_pairing();
        }
        *lock(&slot.cancel) = ctl.cancel.clone();
        let (tx, rx) = sync_channel(1);
        *lock(&slot.pin_tx) = Some(tx);
        *lock(&ctl.pin) = Some(rx);
        let (tx, rx) = sync_channel(1);
        *lock(&slot.code_tx) = Some(tx);
        *lock(&ctl.code) = Some(rx);
        let cancel = ctl.cancel.clone();
        let worker = slot.clone();
        let thp = self.thp.clone();
        let handle = tauri::async_runtime::spawn_blocking(move || {
            let _busy = BusyGuard(worker.clone());
            let mut conn = lock(&worker.conn);
            if conn.is_none() {
                *conn = Some(open(&worker.locator, &worker.info, &ctl, &thp)?);
            }
            let Some(dev) = conn.as_mut() else {
                return Err(HwError::Disconnected);
            };
            let result = f(dev.as_mut(), &ctl);
            if let Err(e) = &result {
                if e.poisons_connection() {
                    *conn = None;
                }
            }
            result
        });
        match tokio::time::timeout(timeout + Duration::from_secs(3), handle).await {
            Ok(Ok(result)) => result,
            Ok(Err(e)) => Err(HwError::bad(format!("task interrupted: {e}"))),
            Err(_) => {
                cancel.store(true, Ordering::SeqCst);
                Err(HwError::Timeout)
            }
        }
    }

    #[cfg(test)]
    fn insert_for_tests(&self, id: &str, dev: Box<dyn HardwareWallet>) {
        let info = DeviceInfo {
            id: id.into(),
            kind: HwDeviceKind::Ledger,
            model: "fake".into(),
            transport: "hid",
        };
        let slot = Slot::new(info, id.into(), Locator::Test);
        *lock(&slot.conn) = Some(dev);
        lock(&self.slots).insert(id.into(), Arc::new(slot));
    }

    pub fn cancel(&self, id: &str) -> HwResult<bool> {
        let slot = lock(&self.slots)
            .get(id)
            .cloned()
            .ok_or(HwError::NotFound)?;
        let pending = slot.busy.load(Ordering::SeqCst);
        if pending {
            lock(&slot.cancel).store(true, Ordering::SeqCst);
        }
        Ok(pending)
    }

    pub fn submit_pin(&self, id: &str, positions: Zeroizing<String>) -> HwResult<()> {
        let slot = lock(&self.slots)
            .get(id)
            .cloned()
            .ok_or(HwError::NotFound)?;
        let tx = lock(&slot.pin_tx);
        let tx = tx
            .as_ref()
            .ok_or_else(|| HwError::bad("no PIN entry pending"))?;
        tx.try_send(positions)
            .map_err(|_| HwError::bad("no PIN entry pending"))
    }

    pub fn submit_pairing_code(&self, id: &str, code: Zeroizing<String>) -> HwResult<()> {
        let slot = lock(&self.slots)
            .get(id)
            .cloned()
            .ok_or(HwError::NotFound)?;
        let tx = lock(&slot.code_tx);
        let tx = tx
            .as_ref()
            .ok_or_else(|| HwError::bad("no pairing pending"))?;
        tx.try_send(code)
            .map_err(|_| HwError::bad("no pairing pending"))
    }

    pub fn thp_pairings(&self) -> HwResult<Vec<thp_store::PairingInfo>> {
        self.thp.list()
    }

    pub fn thp_forget(&self, key: Option<&[u8; 32]>) -> HwResult<usize> {
        let n = self.thp.forget(key)?;
        for slot in lock(&self.slots).values() {
            if slot.info.kind == HwDeviceKind::Trezor && !slot.busy.load(Ordering::SeqCst) {
                if let Ok(mut conn) = slot.conn.try_lock() {
                    *conn = None;
                }
            }
        }
        Ok(n)
    }
}

fn open(
    locator: &Locator,
    info: &DeviceInfo,
    ctl: &Ctl,
    thp: &thp_store::ThpEnv,
) -> HwResult<Box<dyn HardwareWallet>> {
    match locator {
        Locator::Ledger(l) => ledger::open(l, &info.model),
        Locator::Trezor(t) => trezor::open(t, ctl, thp),
        #[cfg(test)]
        Locator::Test => {
            let _ = (ctl, thp);
            Err(HwError::NotFound)
        }
    }
}

pub(crate) fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

pub fn version_at_least(v: &str, min: &str) -> bool {
    let parse = |s: &str| -> Vec<u64> {
        s.split(|c: char| !c.is_ascii_digit())
            .filter(|p| !p.is_empty())
            .take(3)
            .map(|p| p.parse().unwrap_or(0))
            .collect()
    };
    let (a, b) = (parse(v), parse(min));
    for i in 0..3 {
        let (x, y) = (
            a.get(i).copied().unwrap_or(0),
            b.get(i).copied().unwrap_or(0),
        );
        if x != y {
            return x > y;
        }
    }
    true
}

pub fn path_string(path: &[u32]) -> String {
    let mut s = String::from("m");
    for p in path {
        if p & 0x8000_0000 != 0 {
            s.push_str(&format!("/{}'", p & 0x7fff_ffff));
        } else {
            s.push_str(&format!("/{p}"));
        }
    }
    s
}

pub const H: u32 = 0x8000_0000;

pub fn btc_purpose(kind: BtcKind) -> u32 {
    match kind {
        BtcKind::Segwit => 84,
        BtcKind::Taproot => 86,
    }
}

pub fn btc_coin(net: Network) -> u32 {
    match net {
        Network::Mainnet => 0,
        Network::Testnet => 1,
    }
}

pub fn btc_account_path(net: Network, kind: BtcKind, account: u32) -> [u32; 3] {
    [btc_purpose(kind) | H, btc_coin(net) | H, account | H]
}

pub fn evm_path(index: u32) -> [u32; 5] {
    [44 | H, 60 | H, H, 0, index]
}

pub fn sol_path(account: u32) -> [u32; 4] {
    [44 | H, 501 | H, account | H, H]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions() {
        assert!(version_at_least("2.1.0", "2.1.0"));
        assert!(version_at_least("2.10.0", "2.9.9"));
        assert!(version_at_least("1.10", "1.9.0"));
        assert!(!version_at_least("1.9.17", "1.10.0"));
        assert!(!version_at_least("2.0.9", "2.1.0"));
        assert!(version_at_least("2.1.0-rc1", "2.1.0"));
    }

    #[test]
    fn paths() {
        assert_eq!(
            path_string(&btc_account_path(Network::Testnet, BtcKind::Taproot, 3)),
            "m/86'/1'/3'"
        );
        assert_eq!(path_string(&evm_path(7)), "m/44'/60'/0'/0/7");
        assert_eq!(path_string(&sol_path(0)), "m/44'/501'/0'/0'");
    }

    #[test]
    fn errors_map_to_ipc_codes() {
        let code = |e: HwError| {
            serde_json::to_value(AppError::from(e)).unwrap()["code"]
                .as_str()
                .unwrap()
                .to_string()
        };
        assert_eq!(code(HwError::NotFound), "HW_NOT_FOUND");
        assert_eq!(code(HwError::Locked), "HW_LOCKED");
        assert_eq!(code(HwError::Rejected), "HW_REJECTED");
        assert_eq!(code(HwError::Disconnected), "HW_DISCONNECTED");
        assert_eq!(code(HwError::Busy(String::new())), "HW_BUSY");
        assert_eq!(code(HwError::Timeout), "HW_TIMEOUT");
        assert_eq!(code(HwError::Cancelled), "USER_REJECTED");
        assert_eq!(code(HwError::bad("x")), "HW_BAD_RESPONSE");
        assert_eq!(code(HwError::PairingRequired), "HW_PAIRING_REQUIRED");
        assert_eq!(
            code(HwError::PairingFailed("x".into())),
            "HW_PAIRING_FAILED"
        );
        assert_eq!(code(HwError::Internal("x".into())), "INTERNAL");
        let v = serde_json::to_value(AppError::from(HwError::WrongApp {
            expected: "Bitcoin Test".into(),
            open: "Ethereum".into(),
        }))
        .unwrap();
        assert_eq!(v["code"], "HW_WRONG_APP");
        assert_eq!(v["data"]["expected"], "Bitcoin Test");
        assert_eq!(v["data"]["open"], "Ethereum");
        let v =
            serde_json::to_value(AppError::from(HwError::too_old("EIP-1559", "2.4.2"))).unwrap();
        assert_eq!(v["code"], "HW_UNSUPPORTED");
        assert_eq!(v["data"]["min"], "2.4.2");
    }

    struct Waiting;

    impl HardwareWallet for Waiting {
        fn status(&mut self, _: &Ctl, _: Network) -> HwResult<DeviceStatus> {
            Err(HwError::unsupported("fake"))
        }
        fn btc_account(&mut self, _: &Ctl, _: Network, _: BtcKind, _: u32) -> HwResult<BtcAccount> {
            Err(HwError::unsupported("fake"))
        }
        fn btc_display_address(
            &mut self,
            _: &Ctl,
            _: Network,
            _: &BtcAccount,
            _: bool,
            _: u32,
        ) -> HwResult<String> {
            Err(HwError::unsupported("fake"))
        }
        fn btc_sign(
            &mut self,
            _: &Ctl,
            _: Network,
            _: &BtcSignRequest<'_>,
        ) -> HwResult<Vec<HwBtcSignature>> {
            Err(HwError::unsupported("fake"))
        }
        fn evm_node(&mut self, _: &Ctl) -> HwResult<String> {
            Err(HwError::unsupported("fake"))
        }
        fn evm_address(&mut self, _: &Ctl, _: u32, _: bool) -> HwResult<String> {
            Err(HwError::unsupported("fake"))
        }
        fn evm_sign(&mut self, _: &Ctl, _: &EvmSignRequest<'_>) -> HwResult<([u8; 32], [u8; 32])> {
            Err(HwError::unsupported("fake"))
        }
        fn evm_clear_signs(&self, _: EvmTxKind, _: bool) -> bool {
            false
        }
        fn sol_address(&mut self, _: &Ctl, _: u32, _: bool) -> HwResult<String> {
            Ok("ready".into())
        }
        fn sol_sign(&mut self, ctl: &Ctl, _: u32, _: &[u8]) -> HwResult<Vec<u8>> {
            loop {
                ctl.check()?;
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    }

    fn quiet() -> PromptFn {
        Arc::new(|_| {})
    }

    #[test]
    fn manager_lock_timeout_cancel() {
        tauri::async_runtime::block_on(async {
            let m = Arc::new(HwManager::default());
            m.insert_for_tests("ledger-9", Box::new(Waiting));
            assert_eq!(
                m.run("nope", Duration::from_secs(1), quiet(), |d, c| d
                    .sol_address(c, 0, false))
                    .await,
                Err(HwError::NotFound)
            );
            // Timeout: the pending signature ends at the deadline, not "never".
            let t = Instant::now();
            let r = m
                .run("ledger-9", Duration::from_millis(300), quiet(), |d, c| {
                    d.sol_sign(c, 0, &[1])
                })
                .await;
            assert_eq!(r, Err(HwError::Timeout));
            assert!(t.elapsed() < Duration::from_secs(2));
            assert_eq!(
                m.run("ledger-9", Duration::from_secs(1), quiet(), |d, c| d
                    .sol_address(c, 0, false))
                    .await,
                Err(HwError::NotFound)
            );

            m.insert_for_tests("ledger-9", Box::new(Waiting));
            let m2 = m.clone();
            let first = tauri::async_runtime::spawn(async move {
                m2.run("ledger-9", Duration::from_secs(30), quiet(), |d, c| {
                    d.sol_sign(c, 0, &[1])
                })
                .await
            });
            while !lock(&m.slots)["ledger-9"].busy.load(Ordering::SeqCst) {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            assert!(matches!(
                m.run("ledger-9", Duration::from_secs(1), quiet(), |d, c| d
                    .sol_address(c, 0, false))
                    .await,
                Err(HwError::Busy(_))
            ));
            assert!(m.cancel("ledger-9").unwrap());
            assert_eq!(first.await.unwrap(), Err(HwError::Cancelled));
            assert!(m
                .submit_pin("ledger-9", Zeroizing::new("123".into()))
                .is_err());
        });
    }

    /// READ-ONLY test against a real plugged-in device (never signs, never displays): `cargo test
    /// -p kyro-desktop --lib real_device_read_only -- --ignored --nocapture`.
    #[test]
    #[ignore = "needs a real Ledger or Trezor plugged in"]
    fn real_device_read_only() {
        tauri::async_runtime::block_on(async {
            let m = HwManager::default();
            let list = m.list();
            println!("devices: {list:?}");
            assert!(!list.is_empty(), "no Ledger/Trezor found");
            for d in list {
                let st = m
                    .run(&d.id, Duration::from_secs(60), quiet(), |dev, c| {
                        dev.status(c, Network::Testnet)
                    })
                    .await;
                println!("{}: status {st:?}", d.id);
                let acc = m
                    .run(&d.id, Duration::from_secs(60), quiet(), |dev, c| {
                        dev.btc_account(c, Network::Testnet, BtcKind::Segwit, 0)
                    })
                    .await;
                println!("{}: m/84'/1'/0' {acc:?}", d.id);
                if let Ok(a) = acc {
                    let addr = wallet_core::btc_address_from_xpub(
                        &a.xpub,
                        Network::Testnet,
                        BtcKind::Segwit,
                        false,
                        0,
                    );
                    println!("{}: first receive address (Kyro derivation) {addr:?}", d.id);
                }
            }
        });
    }

    /// READ-ONLY test against a real Trezor Safe 7 (THP), never signs or displays an address:
    /// `cargo test -p kyro-desktop --lib real_thp_device_read_only -- --ignored --nocapture`.
    #[test]
    #[ignore = "needs a real Trezor Safe 7 plugged in and a person to type the code"]
    fn real_thp_device_read_only() {
        tauri::async_runtime::block_on(async {
            let m = Arc::new(HwManager::default());
            m.set_thp_store(std::env::temp_dir().join("kyro-thp-real-test.json"));
            let list = m.list();
            println!("devices: {list:?}");
            let d = list
                .iter()
                .find(|d| d.kind == HwDeviceKind::Trezor)
                .expect("no Trezor found")
                .clone();
            let (m2, id) = (m.clone(), d.id.clone());
            let prompt: PromptFn = Arc::new(move |p| {
                println!("hw-prompt: {p:?}");
                if p == Prompt::ThpPairingCode {
                    let (m3, id) = (m2.clone(), id.clone());
                    std::thread::spawn(move || {
                        println!("type the 6-digit code shown on the Trezor, then Enter:");
                        let mut line = String::new();
                        let _ = std::io::stdin().read_line(&mut line);
                        let r = m3.submit_pairing_code(&id, Zeroizing::new(line.trim().into()));
                        println!("code submitted: {r:?}");
                    });
                }
            });
            let st = m
                .run_pairing(&d.id, Duration::from_secs(180), prompt.clone(), |dev, c| {
                    dev.status(c, Network::Testnet)
                })
                .await;
            println!("status: {st:?}");
            println!("pairings: {:?}", m.thp_pairings());
            let acc = m
                .run(&d.id, Duration::from_secs(60), prompt, |dev, c| {
                    dev.btc_account(c, Network::Testnet, BtcKind::Segwit, 0)
                })
                .await;
            println!("m/84'/1'/0': {acc:?}");
            assert!(acc.is_ok());
        });
    }

    #[test]
    fn ctl_deadline_and_cancel() {
        let ctl = Ctl::for_tests(Duration::from_secs(30));
        assert!(ctl.check().is_ok());
        ctl.cancel.store(true, Ordering::SeqCst);
        assert_eq!(ctl.check(), Err(HwError::Cancelled));
        let ctl = Ctl::for_tests(Duration::from_millis(0));
        assert_eq!(ctl.check(), Err(HwError::Timeout));
        let ctl = Ctl::for_tests(Duration::from_millis(250));
        let (_tx, rx) = sync_channel::<Zeroizing<String>>(1);
        *lock(&ctl.pin) = Some(rx);
        let t = Instant::now();
        assert_eq!(ctl.wait_pin().map(|_| ()), Err(HwError::Timeout));
        assert!(t.elapsed() < Duration::from_secs(2));
    }
}
