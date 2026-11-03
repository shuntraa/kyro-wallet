//! Real-device Ledger check (ignored test, see `docs/LEDGER_CHECK.md`):
//! `cargo test -p kyro-desktop --lib ledger_device_check -- --ignored --nocapture`.
//!
//! For each chain Kyro supports on Ledger: opens its app from the dashboard (the user approves),
//! reads the account key, re-derives the address in Rust from the returned key and compares;
//! for EVM, Solana, Bitcoin and Litecoin it also has the device sign a dummy message or a
//! transaction with a fake blockhash (never broadcast, nothing goes online) and verifies the
//! signature against the key read. Every step prints OK / FAIL with the last status word.

use std::str::FromStr;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::Arc;
use std::time::Duration;

use bitcoin::bip32::{ChildNumber, DerivationPath, Xpub};
use bitcoin::hashes::{sha256d, Hash};
use bitcoin::secp256k1::{ecdsa, Message, PublicKey, Secp256k1};
use bitcoin::{CompressedPublicKey, ScriptBuf};
use ledger_bitcoin_client::apdu::{APDUCommand, StatusWord};
use ledger_bitcoin_client::BitcoinClient;
use sha3::{Digest, Keccak256};
use wallet_core::{BtcKind, Network, UtxoCoin};

use super::ledger::{self, ApduLink, HidLink, Ledger};
use super::ledger_apdu::{self as apdu, SwContext, SW_OK};
use super::{
    chains, evm_path, ledger_apps, ledger_utxo_v2, sol_path, version_at_least, Chain, Ctl,
    HardwareWallet, HwError, HwResult, Locator, Prompt,
};

const NET: Network = Network::Mainnet;
/// Per chain: time to approve the app, then every prompt.
const STEP: Duration = Duration::from_secs(600);
const MESSAGE: &[u8] = b"Kyro device check. Not a transaction.";

/// The HID link, remembering the last status word.
struct LogLink {
    inner: HidLink,
    last: Arc<AtomicU16>,
}

impl ApduLink for LogLink {
    fn exchange(&self, ctl: &Ctl, a: &[u8]) -> HwResult<(Vec<u8>, u16)> {
        self.last.store(0, Ordering::Relaxed);
        let r = self.inner.exchange(ctl, a);
        if let Ok((_, sw)) = &r {
            self.last.store(*sw, Ordering::Relaxed);
        }
        r
    }

    fn reconnect(&self, ctl: &Ctl) -> HwResult<()> {
        self.inner.reconnect(ctl)
    }
}

struct Report {
    last: Arc<AtomicU16>,
    ok: usize,
    fail: usize,
    skipped: Vec<String>,
}

impl Report {
    fn sw(&self) -> String {
        match self.last.load(Ordering::Relaxed) {
            0 => "no SW".into(),
            sw => format!("SW {sw:04X}"),
        }
    }

    fn step<T>(&mut self, name: &str, r: HwResult<T>) -> Option<T> {
        match r {
            Ok(v) => {
                println!("  OK   {name} ({})", self.sw());
                self.ok += 1;
                Some(v)
            }
            Err(e) => {
                println!("  FAIL {name}: {e:?} ({})", self.sw());
                self.fail += 1;
                None
            }
        }
    }

    fn check(&mut self, name: &str, ok: bool, detail: &str) {
        let r = if ok {
            Ok(())
        } else {
            Err(HwError::bad(detail.to_string()))
        };
        if self.step(name, r).is_some() {
            println!("       {detail}");
        }
    }
}

fn ctl() -> Ctl {
    Ctl::new(
        STEP,
        Arc::new(|p| match p {
            Prompt::OpenApp(a) => println!("    -> approve opening \"{a}\" on the Ledger"),
            Prompt::ConfirmOnDevice => println!("    -> approve on the Ledger"),
            other => println!("    -> device: {other:?}"),
        }),
    )
}

fn call(link: &dyn ApduLink, c: &Ctl, cmd: &[u8]) -> HwResult<Vec<u8>> {
    let (data, sw) = link.exchange(c, cmd)?;
    if sw == SW_OK {
        Ok(data)
    } else {
        Err(apdu::sw_error(sw, SwContext::Signing))
    }
}

/// `ledger_bitcoin_client` over the logged link (Bitcoin and Litecoin v2 apps).
struct Tx<'a> {
    link: &'a dyn ApduLink,
    ctl: &'a Ctl,
}

impl ledger_bitcoin_client::Transport for Tx<'_> {
    type Error = HwError;

    fn exchange(&self, cmd: &APDUCommand) -> Result<(StatusWord, Vec<u8>), HwError> {
        let bytes = apdu::apdu(cmd.cla, cmd.ins, cmd.p1, cmd.p2, &cmd.data)?;
        let (data, sw) = self.link.exchange(self.ctl, &bytes)?;
        match sw {
            SW_OK => Ok((StatusWord::OK, data)),
            0xE000 => Ok((StatusWord::InterruptedExecution, data)),
            other => Err(apdu::sw_error(other, SwContext::Signing)),
        }
    }
}

/// Signed-message hash: `sha256d(varint(len magic) || magic || varint(len msg) || msg)`.
fn signed_msg_hash(magic: &str, msg: &[u8]) -> [u8; 32] {
    let mut buf = vec![magic.len() as u8];
    buf.extend_from_slice(magic.as_bytes());
    buf.push(msg.len() as u8);
    buf.extend_from_slice(msg);
    sha256d::Hash::hash(&buf).to_byte_array()
}

/// Bitcoin / Litecoin (v2 app): leaf key `account/0/0` from the device vs Kyro's derivation
/// from the account xpub, the address of both, then a signed message checked with the leaf key
/// under the coin's message `magic`.
#[allow(clippy::too_many_arguments)]
fn check_v2(
    r: &mut Report,
    magic: &str,
    link: &dyn ApduLink,
    c: &Ctl,
    xpub: &str,
    account_path: &str,
    kyro_address: &str,
    address_of: &dyn Fn(&ScriptBuf) -> Option<String>,
) {
    let secp = Secp256k1::verification_only();
    let Ok(leaf) = DerivationPath::from_str(&format!("{account_path}/0/0")) else {
        r.check("leaf path", false, account_path);
        return;
    };
    let path: Vec<u32> = leaf.into_iter().map(|n| u32::from(*n)).collect();
    let dev_leaf = ledger_utxo_v2::extended_pubkey_apdu(&path, false)
        .and_then(|cmd| call(link, c, &cmd))
        .and_then(|d| ledger_utxo_v2::parse_xpub(&d).map(|(x, _)| x));
    let Some(dev_leaf) = r.step(&format!("read key {leaf}"), dev_leaf) else {
        return;
    };
    let zero = ChildNumber::Normal { index: 0 };
    let kyro_leaf = Xpub::from_str(xpub)
        .ok()
        .and_then(|x| x.derive_pub(&secp, &[zero, zero]).ok());
    r.check(
        "re-derive key from account xpub",
        kyro_leaf.map(|k| k.public_key) == Some(dev_leaf.public_key),
        &hex::encode(dev_leaf.public_key.serialize()),
    );
    let script = ScriptBuf::new_p2wpkh(&CompressedPublicKey(dev_leaf.public_key).wpubkey_hash());
    let from_key = address_of(&script).unwrap_or_default();
    r.check(
        "address from device key = Kyro address",
        from_key == kyro_address,
        kyro_address,
    );
    println!("    -> approve the message on the Ledger");
    let client = BitcoinClient::new(Tx { link, ctl: c });
    let sig = client.sign_message(MESSAGE, &leaf).map_err(|e| {
        use ledger_bitcoin_client::error::BitcoinClientError as E;
        match e {
            E::Transport(e) => e,
            other => HwError::bad(format!("{other:?}")),
        }
    });
    let Some((_, mut sig)) = r.step("sign message (never broadcast)", sig) else {
        return;
    };
    sig.normalize_s();
    let msg = Message::from_digest(signed_msg_hash(magic, MESSAGE));
    r.check(
        "signature verifies with the read key",
        secp.verify_ecdsa(&msg, &sig, &dev_leaf.public_key).is_ok(),
        &format!("magic {magic:?}"),
    );
}

fn check_btc(dev: &mut Ledger<LogLink>, r: &mut Report, c: &Ctl) {
    let acc = dev.btc_account(c, NET, BtcKind::Segwit, 0);
    let Some(acc) = r.step("read account key m/84'/0'/0'", acc) else {
        return;
    };
    let kyro = wallet_core::btc_address_from_xpub(&acc.xpub, NET, BtcKind::Segwit, false, 0)
        .unwrap_or_default();
    let net = bitcoin::Network::Bitcoin;
    let addr = |s: &ScriptBuf| {
        bitcoin::Address::from_script(s, net)
            .ok()
            .map(|a| a.to_string())
    };
    let link = dev.apdu_link().expect("Ledger link");
    let magic = "Bitcoin Signed Message:\n";
    check_v2(r, magic, link, c, &acc.xpub, &acc.path, &kyro, &addr);
}

fn check_ltc(dev: &mut Ledger<LogLink>, r: &mut Report, c: &Ctl) {
    let keys = chains::read_keys(dev, c, NET, Chain::Ltc, 0);
    let Some(acc) = r
        .step("read account key m/84'/2'/0'", keys)
        .and_then(|k| k.utxo)
    else {
        return;
    };
    let kyro = wallet_core::utxo_address_from_xpub(&acc.xpub, NET, UtxoCoin::Litecoin, false, 0)
        .unwrap_or_default();
    let addr =
        |s: &ScriptBuf| wallet_core::utxo_address_of_script(s.as_bytes(), NET, UtxoCoin::Litecoin);
    let link = dev.apdu_link().expect("Ledger link");
    let magic = "Litecoin Signed Message:\n";
    check_v2(r, magic, link, c, &acc.xpub, &acc.path, &kyro, &addr);
}

fn check_evm(dev: &mut Ledger<LogLink>, r: &mut Report, c: &Ctl) {
    let link = dev.apdu_link().expect("Ledger link");
    let path = evm_path(0);
    let a = apdu::eth_get_address(&path, false)
        .and_then(|cmd| call(link, c, &cmd))
        .and_then(|d| apdu::eth_parse_address(&d));
    let Some(a) = r.step("read key m/44'/60'/0'/0/0", a) else {
        return;
    };
    let kyro = wallet_core::evm_address_of_pubkey(&a.pubkey).unwrap_or_default();
    r.check(
        "re-derive address from key",
        kyro.len() == 42 && kyro[2..].eq_ignore_ascii_case(&a.address_hex),
        &kyro,
    );
    // SIGN ETH PERSONAL MESSAGE (`E0 08`): path || len (4, BE) || message (EIP-191).
    let mut data = apdu::encode_path(&path);
    data.extend_from_slice(&(MESSAGE.len() as u32).to_be_bytes());
    data.extend_from_slice(MESSAGE);
    println!("    -> approve the message on the Ledger");
    let sig = apdu::apdu(0xE0, 0x08, 0x00, 0x00, &data).and_then(|cmd| call(link, c, &cmd));
    let Some(sig) = r.step("sign message (never broadcast)", sig) else {
        return;
    };
    let mut prefixed = format!("\x19Ethereum Signed Message:\n{}", MESSAGE.len()).into_bytes();
    prefixed.extend_from_slice(MESSAGE);
    let hash: [u8; 32] = Keccak256::digest(&prefixed).into();
    let ok = sig.len() == 65
        && match (
            PublicKey::from_slice(&a.pubkey),
            ecdsa::Signature::from_compact(&sig[1..65]),
        ) {
            (Ok(pk), Ok(mut s)) => {
                s.normalize_s();
                Secp256k1::verification_only()
                    .verify_ecdsa(&Message::from_digest(hash), &s, &pk)
                    .is_ok()
            }
            _ => false,
        };
    r.check(
        "signature verifies with the read key",
        ok,
        &format!("{} bytes", sig.len()),
    );
}

/// Legacy System Program transfer of 1 lamport to a dummy key, with a fake blockhash: the
/// network would reject it, and it is never sent anyway.
fn sol_dummy_transfer(from: &[u8]) -> Vec<u8> {
    let mut m = vec![1, 0, 1, 3];
    m.extend_from_slice(from);
    m.extend_from_slice(&[0x11; 32]);
    m.extend_from_slice(&[0; 32]); // System Program
    m.extend_from_slice(&[0x42; 32]); // fake recent blockhash
    m.extend_from_slice(&[1, 2, 2, 0, 1, 12]);
    m.extend_from_slice(&2u32.to_le_bytes());
    m.extend_from_slice(&1u64.to_le_bytes());
    m
}

fn check_sol(dev: &mut Ledger<LogLink>, r: &mut Report, c: &Ctl) {
    let link = dev.apdu_link().expect("Ledger link");
    let pk = apdu::sol_get_pubkey(&sol_path(0), false).and_then(|cmd| call(link, c, &cmd));
    let Some(pk) = r.step("read key m/44'/501'/0'/0'", pk) else {
        return;
    };
    let kyro = wallet_core::sol_address_of_pubkey(&pk).unwrap_or_default();
    let dev_addr = dev.sol_address(c, 0, false).unwrap_or_default();
    r.check(
        "re-derive address from key",
        pk.len() == 32 && !kyro.is_empty() && kyro == dev_addr,
        &kyro,
    );
    let msg = sol_dummy_transfer(&pk);
    println!(
        "    -> approve the transfer of 0.000000001 SOL on the Ledger (fake blockhash, never sent)"
    );
    let Some(sig) = r.step(
        "sign dummy transaction (never broadcast)",
        dev.sol_sign(c, 0, &msg),
    ) else {
        return;
    };
    let ok = match (
        <[u8; 32]>::try_from(pk.as_slice()),
        <[u8; 64]>::try_from(sig.as_slice()),
    ) {
        (Ok(pk), Ok(sig)) => ed25519_dalek::VerifyingKey::from_bytes(&pk)
            .map(|vk| {
                vk.verify_strict(&msg, &ed25519_dalek::Signature::from_bytes(&sig))
                    .is_ok()
            })
            .unwrap_or(false),
        _ => false,
    };
    r.check("signature verifies with the read key", ok, "ed25519");
}

/// Other chains: the key is read through Kyro's own path, which re-derives the address.
fn check_other(dev: &mut Ledger<LogLink>, r: &mut Report, c: &Ctl, chain: Chain) {
    if let Some(k) = ledger_apps::key_chain(chain) {
        let pk = ledger_apps::pubkey(dev, c, k, 0, false, NET);
        if let Some(pk) = r.step(&format!("read key {}", k.path_string(0)), pk) {
            let addr = k.address_of(&pk, NET);
            r.check(
                "address from key",
                addr.is_ok(),
                &addr.unwrap_or_else(|e| e.to_string()),
            );
        }
        return;
    }
    let keys = chains::read_keys(dev, c, NET, chain, 0);
    let Some(keys) = r.step("read account key", keys) else {
        return;
    };
    let addr = match (&keys.utxo, &keys.key) {
        (Some(u), _) => wallet_core::utxo_address_from_xpub(&u.xpub, NET, u.coin, false, 0)
            .map_err(|e| e.to_string()),
        (None, Some(k)) => Ok(k.address.clone()),
        _ => Err("no key returned".into()),
    };
    r.check(
        "address from key",
        addr.is_ok(),
        &addr.unwrap_or_else(|e| e),
    );
}

#[test]
#[ignore = "needs a real Ledger plugged in, unlocked, and a person to approve on it"]
fn ledger_device_check() {
    let found = ledger::enumerate();
    let f = found
        .first()
        .expect("no Ledger found: plug it in and unlock it");
    let Locator::Ledger(loc) = &f.locator else {
        panic!("not a Ledger");
    };
    println!(
        "Ledger {} found. Keep it unlocked; approve each prompt on it.",
        f.model
    );
    let last = Arc::new(AtomicU16::new(0));
    let link = LogLink {
        inner: ledger::hid_link(loc).expect("cannot open the Ledger (close Ledger Live)"),
        last: last.clone(),
    };
    let mut dev = Ledger::with_link(link);
    let mut r = Report {
        last,
        ok: 0,
        fail: 0,
        skipped: Vec::new(),
    };
    for chain in Chain::ALL {
        let Some((app, min)) = ledger::app_for(chain, NET) else {
            continue;
        };
        println!("\n== {} (app \"{app}\" {min}+)", chain.label());
        let c = ctl();
        let link = dev.apdu_link().expect("Ledger link");
        match ledger::ensure_open(link, &c, app) {
            Ok((name, version)) if name == app => {
                if !version_at_least(&version, min) {
                    println!("  SKIP {app} {version} too old: update it in Ledger Live");
                    r.skipped.push(format!("{} (app too old)", chain.label()));
                    continue;
                }
                println!("  OK   open {app} {version} ({})", r.sw());
                r.ok += 1;
            }
            Ok((name, _)) => {
                r.check("open app", false, &format!("\"{name}\" is still open"));
                continue;
            }
            Err(HwError::AppMissing(_)) => {
                println!(
                    "  SKIP not installed (install \"{app}\" in Ledger Live) ({})",
                    r.sw()
                );
                r.skipped.push(format!("{} (not installed)", chain.label()));
                continue;
            }
            Err(HwError::Rejected) => {
                println!("  SKIP refused on the device ({})", r.sw());
                r.skipped.push(format!("{} (refused)", chain.label()));
                continue;
            }
            Err(e) => {
                r.step::<()>("open app", Err(e));
                continue;
            }
        }
        match chain {
            Chain::Btc => check_btc(&mut dev, &mut r, &c),
            Chain::Ltc => check_ltc(&mut dev, &mut r, &c),
            Chain::Evm => check_evm(&mut dev, &mut r, &c),
            Chain::Sol => check_sol(&mut dev, &mut r, &c),
            other => check_other(&mut dev, &mut r, &c, other),
        }
    }
    println!(
        "\n== Summary: {} OK, {} FAIL, skipped: {}",
        r.ok,
        r.fail,
        if r.skipped.is_empty() {
            "none".to_string()
        } else {
            r.skipped.join(", ")
        }
    );
    assert_eq!(r.fail, 0, "some steps failed (see FAIL lines)");
}

#[test]
fn dummy_messages_are_well_formed() {
    let m = sol_dummy_transfer(&[7; 32]);
    assert_eq!(m.len(), 4 + 4 * 32 + 6 + 12);
    assert_eq!(&m[..4], &[1, 0, 1, 3]);
    assert_eq!(&m[4 + 3 * 32..4 + 4 * 32], &[0x42; 32]);
    // Known vector: Bitcoin Core signed-message hash of "" (magic only + empty message).
    assert_eq!(
        hex::encode(signed_msg_hash("Bitcoin Signed Message:\n", b"")),
        "80e795d4a4caadd7047af389d9f7f220562feb6196032e2131e10563352c4bcc"
    );
}
