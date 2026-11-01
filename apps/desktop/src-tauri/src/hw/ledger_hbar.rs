//! Ledger « Hedera » app (LedgerHQ/app-hedera 1.x, `docs/accounts.md`; host library
//! `@ledgerhq/hw-app-hedera`).
//!
//! CLA E0. The app derives `m/44'/3030'/0'/0'/index'` itself from a 4-byte **little-endian**
//! key index (Kyro: index = account number, see `wallet_core::HwKeyChain`).
//! - GET_PUBLIC_KEY (02): P1 = 00 shows « Export public key #index » and waits for the user,
//!   P1 = 01 answers silently → 32-byte ED25519 key.
//! - SIGN_TRANSACTION (04): P1 = P2 = 00, data `index (LE) ‖ TransactionBody` in **one** APDU
//!   (body ≤ 251 bytes): the app decodes the body (nanopb), shows the transfer (accounts,
//!   amount, fee, memo) and, once approved, returns the 64-byte ED25519 signature of the body
//!   bytes, verified by Kyro (`wallet_core::hbar_hw_signed`).

use super::ledger_apdu::{self as apdu, SwContext};
use super::ledger_apps::App;
use super::{HwError, HwResult};

const CLA: u8 = 0xE0;
const INS_GET_PUBLIC_KEY: u8 = 0x02;
const INS_SIGN_TRANSACTION: u8 = 0x04;
const P1_DISPLAY: u8 = 0x00;
const P1_SILENT: u8 = 0x01;
const MAX_BODY: usize = 251;

/// The key index the app expects: the last (hardened) element of Kyro's path.
fn index_of(path: &[u32]) -> HwResult<[u8; 4]> {
    match path {
        [a, b, c, d, i]
            if *a == 0x8000_002c
                && *b == 0x8000_0bd6
                && *c == 0x8000_0000
                && *d == 0x8000_0000
                && *i >= 0x8000_0000 =>
        {
            Ok((*i & 0x7fff_ffff).to_le_bytes())
        }
        _ => Err(HwError::bad(
            "Hedera app: path m/44'/3030'/0'/0'/index' expected",
        )),
    }
}

pub fn get_pubkey(path: &[u32], display: bool) -> HwResult<Vec<u8>> {
    let p1 = if display { P1_DISPLAY } else { P1_SILENT };
    apdu::apdu(CLA, INS_GET_PUBLIC_KEY, p1, 0, &index_of(path)?)
}

pub fn sign_apdu(path: &[u32], body: &[u8]) -> HwResult<Vec<u8>> {
    if body.is_empty() || body.len() > MAX_BODY {
        return Err(HwError::bad("Hedera body too long for the Ledger app"));
    }
    apdu::apdu(
        CLA,
        INS_SIGN_TRANSACTION,
        0,
        0,
        &[&index_of(path)?[..], body].concat(),
    )
}

pub fn pubkey(app: &App<'_>, path: &[u32], display: bool) -> HwResult<Vec<u8>> {
    let ctx = if display {
        SwContext::Signing
    } else {
        SwContext::General
    };
    let pk = app.call(&get_pubkey(path, display)?, ctx)?;
    if pk.len() != 32 {
        return Err(HwError::bad("Hedera public key of unexpected length"));
    }
    Ok(pk)
}

pub fn sign(app: &App<'_>, path: &[u32], body: &[u8]) -> HwResult<Vec<u8>> {
    let sig = app.call(&sign_apdu(path, body)?, SwContext::Signing)?;
    if sig.len() != 64 {
        return Err(HwError::bad("Hedera signature of unexpected length"));
    }
    Ok(sig)
}

#[cfg(test)]
mod tests {
    use super::super::ledger_apps::replay::*;
    use super::*;
    use wallet_core::HwKeyChain;

    #[test]
    fn apdus_use_the_little_endian_index() {
        let path = HwKeyChain::Hbar.path(2);
        assert_eq!(
            hex::encode(get_pubkey(&path, true).unwrap()),
            "e00200000402000000"
        );
        assert_eq!(
            hex::encode(get_pubkey(&path, false).unwrap()),
            "e00201000402000000"
        );
        assert!(get_pubkey(&HwKeyChain::Sui.path(0), false).is_err());
        let body = [0x0au8; 20];
        assert_eq!(
            hex::encode(sign_apdu(&path, &body).unwrap()),
            format!("e004000018{}{}", "02000000", hex::encode(body))
        );
        assert!(sign_apdu(&path, &[0u8; 252]).is_err());

        let (pk, sig) = ([3u8; 32], [4u8; 64]);
        let mut lines = app("Hedera", "1.9.1").to_vec();
        lines.push("=> e00201000402000000".into());
        lines.push(format!("<= {}9000", hex::encode(pk)));
        lines.push(format!(
            "=> {}",
            hex::encode(sign_apdu(&path, &body).unwrap())
        ));
        lines.push(format!("<= {}9000", hex::encode(sig)));
        let r = Replay::new(&lines);
        let c = ctl();
        let a = App::open(&r, &c, HwKeyChain::Hbar).unwrap();
        assert_eq!(pubkey(&a, &path, false).unwrap(), pk.to_vec());
        assert_eq!(sign(&a, &path, &body).unwrap(), sig.to_vec());
        assert!(r.done());
    }
}
