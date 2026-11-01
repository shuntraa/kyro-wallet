//! Ledger « Aptos » app (LedgerHQ/app-aptos, host library `@ledgerhq/hw-app-aptos`).
//!
//! CLA 5B. Paths: count then big-endian indices.
//! - GET_PUBLIC_KEY (05), P1 = 01 to show the address on the screen, P2 = 00 → `33 || 04 ||
//!   pubkey (32) || 32 || chain code`.
//! - SIGN_TX (06): first the path (P1 = 00, P2 = 80 « more »), then the signing message
//!   (`SHA3-256("APTOS::RawTransaction") || BCS`) in 255-byte chunks, P1 = 1, 2, 3…, P2 = 80
//!   except 00 on the last one → `64 || signature`.

use super::ledger_apdu::{self as apdu, SwContext};
use super::ledger_apps::App;
use super::{HwError, HwResult};

const CLA: u8 = 0x5B;
const INS_GET_PUBLIC_KEY: u8 = 0x05;
const INS_SIGN_TX: u8 = 0x06;
const P2_MORE: u8 = 0x80;
const P2_LAST: u8 = 0x00;
const CHUNK: usize = 255;

pub fn get_pubkey(path: &[u32], display: bool) -> HwResult<Vec<u8>> {
    apdu::apdu(
        CLA,
        INS_GET_PUBLIC_KEY,
        u8::from(display),
        P2_LAST,
        &apdu::encode_path(path),
    )
}

pub fn parse_pubkey(data: &[u8]) -> HwResult<Vec<u8>> {
    // `unpack_get_public_key_response` of the app's tests: 33-byte key (prefix 04), 32-byte
    // chain code, nothing else.
    match data {
        [33, 0x04, rest @ ..] if rest.len() == 32 + 1 + 32 && rest[32] == 32 => {
            Ok(rest[..32].to_vec())
        }
        _ => Err(HwError::bad("clé publique Aptos mal formée")),
    }
}

pub fn sign_apdus(path: &[u32], message: &[u8]) -> HwResult<Vec<Vec<u8>>> {
    let mut out = vec![apdu::apdu(
        CLA,
        INS_SIGN_TX,
        0,
        P2_MORE,
        &apdu::encode_path(path),
    )?];
    let chunks: Vec<&[u8]> = message.chunks(CHUNK).collect();
    if chunks.len() > 254 {
        return Err(HwError::bad("transaction Aptos trop grande"));
    }
    for (i, c) in chunks.iter().enumerate() {
        let p2 = if i + 1 == chunks.len() {
            P2_LAST
        } else {
            P2_MORE
        };
        out.push(apdu::apdu(CLA, INS_SIGN_TX, (i + 1) as u8, p2, c)?);
    }
    Ok(out)
}

pub fn pubkey(app: &App<'_>, path: &[u32], display: bool) -> HwResult<Vec<u8>> {
    let ctx = if display {
        SwContext::Signing
    } else {
        SwContext::General
    };
    parse_pubkey(&app.call(&get_pubkey(path, display)?, ctx)?)
}

pub fn sign(app: &App<'_>, path: &[u32], message: &[u8]) -> HwResult<Vec<u8>> {
    let mut last = Vec::new();
    for a in sign_apdus(path, message)? {
        last = app.call(&a, SwContext::Signing)?;
    }
    match last.as_slice() {
        [64, sig @ ..] if sig.len() == 64 => Ok(sig.to_vec()),
        _ => Err(HwError::bad("signature Aptos mal formée")),
    }
}

#[cfg(test)]
mod tests {
    use super::super::ledger_apps::replay::*;
    use super::*;
    use wallet_core::HwKeyChain;

    #[test]
    fn get_public_key() {
        // m/44'/637'/1'/0'/0', the path of the app's `test_get_public_key_confirm_accepted`.
        let path = HwKeyChain::Aptos.path(1);
        let cmd = get_pubkey(&path, true).unwrap();
        assert_eq!(
            hex::encode(&cmd),
            "5b05010015058000002c8000027d800000018000000080000000"
        );
        let pk = [0x11u8; 32];
        let resp = [&[33u8, 0x04][..], &pk, &[32], &[0x22; 32]].concat();
        let mut lines = app("Aptos", "0.7.11").to_vec();
        lines.push(format!("=> {}", hex::encode(&cmd)));
        lines.push(format!("<= {}9000", hex::encode(&resp)));
        let r = Replay::new(&lines);
        let c = ctl();
        let a = App::open(&r, &c, HwKeyChain::Aptos).unwrap();
        assert_eq!(pubkey(&a, &path, true).unwrap(), pk.to_vec());
        assert!(parse_pubkey(&resp[..resp.len() - 1]).is_err());
        assert!(parse_pubkey(&[&[33u8, 0x02][..], &resp[2..]].concat()).is_err());
    }

    #[test]
    fn sign_is_chunked_like_hw_app_aptos() {
        let path = HwKeyChain::Aptos.path(0);
        let msg = vec![3u8; 300];
        let apdus = sign_apdus(&path, &msg).unwrap();
        assert_eq!(apdus.len(), 3);
        assert_eq!(&apdus[0][..4], &[0x5B, 0x06, 0x00, 0x80]);
        assert_eq!(&apdus[1][..5], &[0x5B, 0x06, 0x01, 0x80, 0xFF]);
        assert_eq!(&apdus[2][..5], &[0x5B, 0x06, 0x02, 0x00, 45]);
        let sig = [9u8; 64];
        let mut lines = app("Aptos", "0.7.11").to_vec();
        for (i, a) in apdus.iter().enumerate() {
            lines.push(format!("=> {}", hex::encode(a)));
            lines.push(if i + 1 == apdus.len() {
                format!("<= 40{}9000", hex::encode(sig))
            } else {
                "<= 9000".into()
            });
        }
        let r = Replay::new(&lines);
        let c = ctl();
        let a = App::open(&r, &c, HwKeyChain::Aptos).unwrap();
        assert_eq!(sign(&a, &path, &msg).unwrap(), sig.to_vec());
        assert!(r.done());
    }
}
