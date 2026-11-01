//! Ledger « NEAR » app (LedgerHQ/app-near, Rust app 2.x; host crate `near-ledger`).

use super::ledger_apdu::{self as apdu, SwContext};
use super::ledger_apps::App;
use super::{HwError, HwResult};

const CLA: u8 = 0x80;
const INS_SIGN_TRANSACTION: u8 = 0x02;
const INS_GET_PUBLIC_KEY: u8 = 0x04;
const INS_GET_VERSION: u8 = 0x06;
const P1_GET_PUB_DISPLAY: u8 = 0x00;
const P1_GET_PUB_SILENT: u8 = 0x01;
const P1_SIGN_LAST_CHUNK: u8 = 0x80;
const NETWORK: u8 = b'W';
const CHUNK: usize = 250;

fn path_bytes(path: &[u32]) -> HwResult<Vec<u8>> {
    if path.len() != 5 {
        return Err(HwError::bad("NEAR app: five-level path expected"));
    }
    Ok(path.iter().flat_map(|p| p.to_be_bytes()).collect())
}

pub fn get_pubkey(path: &[u32], display: bool) -> HwResult<Vec<u8>> {
    let p1 = if display {
        P1_GET_PUB_DISPLAY
    } else {
        P1_GET_PUB_SILENT
    };
    apdu::apdu(CLA, INS_GET_PUBLIC_KEY, p1, NETWORK, &path_bytes(path)?)
}

pub fn sign_apdus(path: &[u32], borsh: &[u8]) -> HwResult<Vec<Vec<u8>>> {
    let all = [path_bytes(path)?, borsh.to_vec()].concat();
    let chunks: Vec<&[u8]> = all.chunks(CHUNK).collect();
    let mut out = Vec::with_capacity(chunks.len());
    for (i, c) in chunks.iter().enumerate() {
        let p1 = if i + 1 == chunks.len() {
            P1_SIGN_LAST_CHUNK
        } else {
            0
        };
        out.push(apdu::apdu(CLA, INS_SIGN_TRANSACTION, p1, NETWORK, c)?);
    }
    Ok(out)
}

pub fn pubkey(app: &App<'_>, path: &[u32], display: bool) -> HwResult<Vec<u8>> {
    let ctx = if display {
        SwContext::Signing
    } else {
        SwContext::General
    };
    let pk = app.call(&get_pubkey(path, display)?, ctx)?;
    if pk.len() != 32 {
        return Err(HwError::bad("NEAR public key of unexpected length"));
    }
    Ok(pk)
}

pub fn sign(app: &App<'_>, path: &[u32], borsh: &[u8]) -> HwResult<Vec<u8>> {
    app.call(
        &apdu::apdu(CLA, INS_GET_VERSION, 0, 0, &[])?,
        SwContext::General,
    )?;
    let mut last = Vec::new();
    for a in sign_apdus(path, borsh)? {
        last = app.call(&a, SwContext::Signing)?;
    }
    if last.len() != 64 {
        return Err(HwError::bad("NEAR signature of unexpected length"));
    }
    Ok(last)
}

#[cfg(test)]
mod tests {
    use super::super::ledger_apps::replay::*;
    use super::*;
    use wallet_core::HwKeyChain;

    /// LedgerHQ/app-near `tests/common.py`: path 44'/397'/0'/0'/1' and the key the app
    /// returns for it with the test seed.
    const DERIV_PATH_DATA: &str = "8000002c8000018d800000008000000080000001";
    const DEFAULT_KEY: &str = "c4f5941e81e071c2fd1dae2e71fd3d859d462484391d9a90bf219211dcbb320f";

    #[test]
    fn official_public_key_vector() {
        let path = HwKeyChain::Near.path(0);
        let cmd = get_pubkey(&path, true).unwrap();
        assert_eq!(hex::encode(&cmd), format!("8004005714{DERIV_PATH_DATA}"));
        assert_eq!(get_pubkey(&path, false).unwrap()[2], P1_GET_PUB_SILENT);
        let mut lines = app("NEAR", "2.4.1").to_vec();
        lines.push(format!("=> {}", hex::encode(&cmd)));
        lines.push(format!("<= {DEFAULT_KEY}9000"));
        let r = Replay::new(&lines);
        let c = ctl();
        let a = App::open(&r, &c, HwKeyChain::Near).unwrap();
        assert_eq!(hex::encode(pubkey(&a, &path, true).unwrap()), DEFAULT_KEY);
        assert!(get_pubkey(&[1, 2, 3], false).is_err());
    }

    #[test]
    fn sign_chunks_path_then_borsh() {
        let path = HwKeyChain::Near.path(0);
        let tx = vec![0x11u8; 240];
        let apdus = sign_apdus(&path, &tx).unwrap();
        assert_eq!(apdus.len(), 2);
        assert_eq!(&apdus[0][..5], &[0x80, 0x02, 0x00, b'W', 250]);
        assert_eq!(hex::encode(&apdus[0][5..25]), DERIV_PATH_DATA);
        assert_eq!(&apdus[1][..5], &[0x80, 0x02, 0x80, b'W', 10]);
        let sig = [4u8; 64];
        let mut lines = app("NEAR", "2.4.1").to_vec();
        lines.push("=> 8006000000".into());
        lines.push("<= 0204019000".into());
        lines.push(format!("=> {}", hex::encode(&apdus[0])));
        lines.push("<= 9000".into());
        lines.push(format!("=> {}", hex::encode(&apdus[1])));
        lines.push(format!("<= {}9000", hex::encode(sig)));
        let r = Replay::new(&lines);
        let c = ctl();
        let a = App::open(&r, &c, HwKeyChain::Near).unwrap();
        assert_eq!(sign(&a, &path, &tx).unwrap(), sig.to_vec());
        assert!(r.done());
    }
}
