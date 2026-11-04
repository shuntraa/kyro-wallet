//! Ledger « Aptos » app (LedgerHQ/app-aptos, host library `@ledgerhq/hw-app-aptos`).

use super::ledger_apdu::{self as apdu, SwContext};
use super::ledger_apps::App;
use super::{HwError, HwResult};

const CLA: u8 = 0x5B;
const INS_GET_PUBLIC_KEY: u8 = 0x05;
const INS_SIGN_TX: u8 = 0x06;
const P2_MORE: u8 = 0x80;
const P2_LAST: u8 = 0x00;
const CHUNK: usize = 255;
/// `primary_fungible_store::transfer`, in the message of a fungible-asset transfer.
const FA_MODULE: &[u8] = b"primary_fungible_store";
/// First app showing the right amount for an asset without 8 decimals (`CHANGELOG.md`, 0.10.1).
const MIN_FA_DECIMALS: &str = "0.10.1";

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
    match data {
        [33, 0x04, rest @ ..] if rest.len() == 32 + 1 + 32 && rest[32] == 32 => {
            Ok(rest[..32].to_vec())
        }
        _ => Err(HwError::bad("malformed Aptos public key")),
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
        return Err(HwError::bad("Aptos transaction too large"));
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
    if message.windows(FA_MODULE.len()).any(|w| w == FA_MODULE) {
        app.require(MIN_FA_DECIMALS)?;
    }
    let mut last = Vec::new();
    for a in sign_apdus(path, message)? {
        last = app.call(&a, SwContext::Signing)?;
    }
    match last.as_slice() {
        [64, sig @ ..] if sig.len() == 64 => Ok(sig.to_vec()),
        _ => Err(HwError::bad("malformed Aptos signature")),
    }
}

#[cfg(test)]
mod tests {
    use super::super::ledger_apps::replay::*;
    use super::*;
    use wallet_core::HwKeyChain;

    #[test]
    fn get_public_key() {
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

    /// USDC through the app, then checked as an Aptos signature; refused on an app that would
    /// show a wrong amount.
    #[test]
    fn fungible_asset_transfer() {
        use ed25519_dalek::Signer;
        let k = ed25519_dalek::SigningKey::from_bytes(&[8; 32]);
        let pk = k.verifying_key().to_bytes();
        let usdc = wallet_core::aptos_known_assets(1)[0].metadata;
        let t = wallet_core::AptosTransfer {
            sender: wallet_core::aptos_address_bytes_of_pubkey(&pk),
            sequence_number: 3,
            recipient: [2; 32],
            amount: 1_500_000,
            max_gas_amount: 2_000,
            gas_unit_price: 100,
            expiration_timestamp_secs: 1_800_000_000,
            chain_id: 1,
            token: Some(hex::decode(&usdc[2..]).unwrap().try_into().unwrap()),
        };
        let raw = hex::encode(t.encode().unwrap());
        let msg = wallet_core::aptos_hw_message(&raw).unwrap();
        let path = HwKeyChain::Aptos.path(0);
        let sig = k.sign(&msg).to_bytes();
        let mut lines = app("Aptos", "0.10.1").to_vec();
        let apdus = sign_apdus(&path, &msg).unwrap();
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
        let got = sign(&a, &path, &msg).unwrap();
        assert!(r.done());
        wallet_core::aptos_hw_signed(&raw, &pk, &got).unwrap();

        let r = Replay::new(&app("Aptos", "0.9.14"));
        let a = App::open(&r, &c, HwKeyChain::Aptos).unwrap();
        assert!(matches!(
            sign(&a, &path, &msg),
            Err(HwError::Unsupported { .. })
        ));
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
