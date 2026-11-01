//! Ledger « Algorand » app (Zondax ledger-algorand, host library `@zondax/ledger-algorand`).
//!
//! CLA 80. The app derives `m/44'/283'/account'/0/0` itself from a 4-byte big-endian account
//! number (Kyro's software derivation is the same, see `wallet_core::algorand`).
//! - GET_ADDRESS (04), P1 = 01 to show the address → `pubkey (32) || address (58 ASCII)`.
//! - SIGN_MSGPACK (08): `[account (u32 BE), only if ≠ 0] || msgpack` in 250-byte chunks; P1 =
//!   00 (first chunk, account 0) / 01 (first chunk with account) / 80 (next ones), P2 = 80
//!   while more chunks follow, 00 on the last → 64-byte signature of `"TX" || msgpack`.

use super::ledger_apdu::{self as apdu, SwContext};
use super::ledger_apps::App;
use super::{HwError, HwResult};

const CLA: u8 = 0x80;
const INS_GET_ADDRESS: u8 = 0x04;
const INS_SIGN_MSGPACK: u8 = 0x08;
const P1_FIRST: u8 = 0x00;
const P1_FIRST_ACCOUNT_ID: u8 = 0x01;
const P1_MORE: u8 = 0x80;
const P2_MORE: u8 = 0x80;
const P2_LAST: u8 = 0x00;
const CHUNK: usize = 250;

pub fn get_address(account: u32, display: bool) -> HwResult<Vec<u8>> {
    apdu::apdu(CLA, INS_GET_ADDRESS, u8::from(display), 0, &account.to_be_bytes())
}

pub fn parse_address(data: &[u8]) -> HwResult<Vec<u8>> {
    if data.len() != 32 + 58 {
        return Err(HwError::bad("adresse Algorand mal formée"));
    }
    let pk: [u8; 32] = data[..32].try_into().map_err(|_| HwError::bad("clé"))?;
    if data[32..] != *wallet_core::algo_address_of_pubkey(&pk).as_bytes() {
        return Err(HwError::bad("adresse Algorand de l'appareil incohérente avec sa clé"));
    }
    Ok(pk.to_vec())
}

pub fn sign_apdus(account: u32, msgpack: &[u8]) -> HwResult<Vec<Vec<u8>>> {
    let mut buf = Vec::with_capacity(msgpack.len() + 4);
    if account != 0 {
        buf.extend_from_slice(&account.to_be_bytes());
    }
    buf.extend_from_slice(msgpack);
    let chunks: Vec<&[u8]> = buf.chunks(CHUNK).collect();
    let mut out = Vec::with_capacity(chunks.len());
    for (i, c) in chunks.iter().enumerate() {
        let p1 = match (i, account) {
            (0, 0) => P1_FIRST,
            (0, _) => P1_FIRST_ACCOUNT_ID,
            _ => P1_MORE,
        };
        let p2 = if i + 1 == chunks.len() { P2_LAST } else { P2_MORE };
        out.push(apdu::apdu(CLA, INS_SIGN_MSGPACK, p1, p2, c)?);
    }
    Ok(out)
}

pub fn pubkey(app: &App<'_>, account: u32, display: bool) -> HwResult<Vec<u8>> {
    let ctx = if display {
        SwContext::Signing
    } else {
        SwContext::General
    };
    parse_address(&app.call(&get_address(account, display)?, ctx)?)
}

pub fn sign(app: &App<'_>, account: u32, msgpack: &[u8]) -> HwResult<Vec<u8>> {
    let mut last = Vec::new();
    for a in sign_apdus(account, msgpack)? {
        last = app.call(&a, SwContext::Signing)?;
    }
    if last.len() != 64 {
        return Err(HwError::bad("signature Algorand de longueur inattendue"));
    }
    Ok(last)
}

#[cfg(test)]
mod tests {
    use super::super::ledger_apps::replay::*;
    use super::*;
    use wallet_core::HwKeyChain;

    #[test]
    fn get_address_vector() {
        // Account 123 of the Zondax emulator tests (also used by wallet-core's derivation
        // tests): key and address as the app returns them.
        let cmd = get_address(123, true).unwrap();
        assert_eq!(hex::encode(&cmd), "800401000400007b");
        let pk = [0x42u8; 32];
        let addr = wallet_core::algo_address_of_pubkey(&pk);
        let resp = [&pk[..], addr.as_bytes()].concat();
        let mut lines = app("Algorand", "2.1.15").to_vec();
        lines.push(format!("=> {}", hex::encode(&cmd)));
        lines.push(format!("<= {}9000", hex::encode(&resp)));
        let r = Replay::new(&lines);
        let c = ctl();
        let a = App::open(&r, &c, HwKeyChain::Algo).unwrap();
        assert_eq!(pubkey(&a, 123, true).unwrap(), pk.to_vec());
        let mut bad = resp.clone();
        bad[0] ^= 1;
        assert!(parse_address(&bad).is_err());
    }

    #[test]
    fn sign_chunks_like_zondax() {
        let msg = vec![0x8a; 260];
        // Account 0: no account prefix, P1 00 then 80.
        let a0 = sign_apdus(0, &msg).unwrap();
        assert_eq!(a0.len(), 2);
        assert_eq!(&a0[0][..5], &[0x80, 0x08, 0x00, 0x80, 250]);
        assert_eq!(&a0[1][..5], &[0x80, 0x08, 0x80, 0x00, 10]);
        // Account 7: 4-byte prefix in the first chunk, P1 01.
        let a7 = sign_apdus(7, &msg[..10]).unwrap();
        assert_eq!(hex::encode(&a7[0][..9]), "8008010000e0000000");
        assert_eq!(a7[0][4], 14);
        let sig = [1u8; 64];
        let mut lines = app("Algorand", "2.1.15").to_vec();
        lines.push(format!("=> {}", hex::encode(&a0[0])));
        lines.push("<= 9000".into());
        lines.push(format!("=> {}", hex::encode(&a0[1])));
        lines.push(format!("<= {}9000", hex::encode(sig)));
        let r = Replay::new(&lines);
        let c = ctl();
        let a = App::open(&r, &c, HwKeyChain::Algo).unwrap();
        assert_eq!(sign(&a, 0, &msg).unwrap(), sig.to_vec());
    }
}
