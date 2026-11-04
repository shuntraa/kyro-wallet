//! Ledger « TON » app (LedgerHQ/app-ton 2.x, `doc/COMMANDS.md`; host library
//! `@ton-community/ton-ledger`).

use super::ledger_apdu::{self as apdu, SwContext};
use super::ledger_apps::App;
use super::{HwError, HwResult};

const CLA: u8 = 0xE0;
const INS_GET_PUBLIC_KEY: u8 = 0x05;
const INS_SIGN_TX: u8 = 0x06;
const P2_TESTNET: u8 = 0x01;
const P2_WALLET_SPECIFIERS: u8 = 0x04;
const P2_FIRST_MORE: u8 = 0x03;
const P2_MORE: u8 = 0x02;
const P2_LAST: u8 = 0x00;
const CHUNK: usize = 255;
const MAX_REQUEST: usize = 510;
/// Hint "jetton transfer" of a request.
const HINT_JETTON: u32 = 0x01;
/// First app with its own jetton table (ticker and decimals on the screen; `src/jetton.c`).
const MIN_KNOWN_JETTON: &str = "2.2.0";

fn path_bytes(path: &[u32]) -> HwResult<Vec<u8>> {
    if path.len() < 3 || path.len() > 10 {
        return Err(HwError::bad("TON app: path of 3 to 10 levels expected"));
    }
    let mut out = vec![path.len() as u8];
    out.extend(path.iter().flat_map(|p| p.to_be_bytes()));
    Ok(out)
}

/// GET_PUBLIC_KEY; with `display`, the address of the v4R2 wallet with `wallet_id` is shown.
pub fn get_pubkey(path: &[u32], display: Option<(bool, u32)>) -> HwResult<Vec<u8>> {
    let mut data = path_bytes(path)?;
    let (p1, p2) = match display {
        None => (0x00, 0x00),
        Some((testnet, wallet_id)) => {
            data.push(0x00); // is_v3r2 = false: v4R2
            data.extend_from_slice(&wallet_id.to_be_bytes());
            let p2 = P2_WALLET_SPECIFIERS | if testnet { P2_TESTNET } else { 0 };
            (0x01, p2)
        }
    };
    apdu::apdu(CLA, INS_GET_PUBLIC_KEY, p1, p2, &data)
}

pub fn sign_apdus(path: &[u32], request: &[u8]) -> HwResult<Vec<Vec<u8>>> {
    if request.is_empty() || request.len() > MAX_REQUEST {
        return Err(HwError::bad("TON transfer request of unexpected length"));
    }
    let mut out = vec![apdu::apdu(
        CLA,
        INS_SIGN_TX,
        0,
        P2_FIRST_MORE,
        &path_bytes(path)?,
    )?];
    let chunks: Vec<&[u8]> = request.chunks(CHUNK).collect();
    for (i, c) in chunks.iter().enumerate() {
        let p2 = if i + 1 == chunks.len() {
            P2_LAST
        } else {
            P2_MORE
        };
        out.push(apdu::apdu(CLA, INS_SIGN_TX, 0, p2, c)?);
    }
    Ok(out)
}

/// Hint of a request built by `wallet_core::ton_hw_request` (tag 1, no state init), if any.
fn hint_of(request: &[u8]) -> Option<u32> {
    let value = 1 + 4 + 1 + 4 + 4;
    // value, address, bounce, send mode: then `has_state_init`.
    let flags = value + 1 + usize::from(*request.get(value)?) + 33 + 2;
    if *request.get(flags)? != 0 || *request.get(flags + 1)? != 1 {
        return None;
    }
    let hints = flags + 2 + 34;
    if *request.get(hints)? != 1 {
        return None;
    }
    Some(u32::from_be_bytes(
        request.get(hints + 1..hints + 5)?.try_into().ok()?,
    ))
}

pub fn pubkey(app: &App<'_>, path: &[u32], display: Option<(bool, u32)>) -> HwResult<Vec<u8>> {
    let ctx = if display.is_some() {
        SwContext::Signing
    } else {
        SwContext::General
    };
    let pk = app.call(&get_pubkey(path, display)?, ctx)?;
    if pk.len() != 32 {
        return Err(HwError::bad("TON public key of unexpected length"));
    }
    Ok(pk)
}

/// Signature and hash returned by SIGN_TX, as `hash (32) ‖ signature (64)`.
pub fn sign(app: &App<'_>, path: &[u32], request: &[u8]) -> HwResult<Vec<u8>> {
    if hint_of(request) == Some(HINT_JETTON) {
        app.require(MIN_KNOWN_JETTON)?;
    }
    let mut last = Vec::new();
    for a in sign_apdus(path, request)? {
        last = app.call(&a, SwContext::Signing)?;
    }
    if last.len() != 98 || last[0] != 64 || last[65] != 32 {
        return Err(HwError::bad("unexpected TON signature response"));
    }
    Ok([&last[66..98], &last[1..65]].concat())
}

#[cfg(test)]
mod tests {
    use super::super::ledger_apps::replay::*;
    use super::*;
    use wallet_core::HwKeyChain;

    const PATH0: &str = "068000002c8000025f80000000800000008000000080000000";

    #[test]
    fn public_key_apdus() {
        let path = HwKeyChain::Ton.path(0);
        assert_eq!(
            hex::encode(get_pubkey(&path, None).unwrap()),
            format!("e005000019{PATH0}")
        );
        assert_eq!(
            hex::encode(get_pubkey(&path, Some((true, 0x4B59_524F))).unwrap()),
            format!("e00501051e{PATH0}004b59524f")
        );
        assert_eq!(
            get_pubkey(&path, Some((false, 698_983_191))).unwrap()[3],
            P2_WALLET_SPECIFIERS
        );
        let pk = [7u8; 32];
        let mut lines = app("TON", "2.9.0").to_vec();
        lines.push(format!("=> e005000019{PATH0}"));
        lines.push(format!("<= {}9000", hex::encode(pk)));
        let r = Replay::new(&lines);
        let c = ctl();
        let a = App::open(&r, &c, HwKeyChain::Ton).unwrap();
        assert_eq!(pubkey(&a, &path, None).unwrap(), pk.to_vec());
        assert!(r.done());
        assert!(get_pubkey(&[1, 2], None).is_err());
    }

    /// A jetton request from `wallet_core`: replayed on a recent app, refused before any APDU
    /// on an app without the jetton table.
    #[test]
    fn jetton_request_needs_the_jetton_table() {
        let k = ed25519_dalek::SigningKey::from_bytes(&[3; 32]);
        let pk = k.verifying_key().to_bytes();
        let id = wallet_core::ton_wallet_id(false);
        let me = wallet_core::ton_wallet_address(&pk, id).unwrap();
        let master = wallet_core::ton_known_jettons(false)[0].master;
        let t = wallet_core::TonTransfer {
            public_key: pk,
            wallet_id: id,
            valid_until: 1_800_000_000,
            seqno: 4,
            mode: wallet_core::TON_MODE_PAY_FEES,
            destination: wallet_core::ton_jetton_wallet_address(&master, &me, false).unwrap(),
            bounce: true,
            amount: wallet_core::TON_JETTON_ATTACHED_NANOTON,
            comment: None,
            with_state_init: false,
            inline_empty_body: false,
            jetton: Some(wallet_core::TonJettonBody {
                query_id: 1_800_000_000,
                amount: 1_000_000,
                destination: master,
                response_destination: me,
                forward_ton_amount: wallet_core::TON_JETTON_FORWARD_NANOTON,
                comment: None,
            }),
        };
        let boc = wallet_core::ton_unsigned_transfer(&t).unwrap();
        let (req, hash) = wallet_core::ton_hw_request(&boc, &pk, false).unwrap();
        assert_eq!(hint_of(&req), Some(HINT_JETTON));
        let path = HwKeyChain::Ton.path(0);
        let sig = {
            use ed25519_dalek::Signer;
            k.sign(&hash).to_bytes()
        };
        let mut lines = app("TON", "2.9.0").to_vec();
        let apdus = sign_apdus(&path, &req).unwrap();
        for (i, a) in apdus.iter().enumerate() {
            lines.push(format!("=> {}", hex::encode(a)));
            lines.push(if i + 1 == apdus.len() {
                format!("<= 40{}20{}9000", hex::encode(sig), hex::encode(hash))
            } else {
                "<= 9000".into()
            });
        }
        let r = Replay::new(&lines);
        let c = ctl();
        let a = App::open(&r, &c, HwKeyChain::Ton).unwrap();
        let out = sign(&a, &path, &req).unwrap();
        assert!(r.done());
        let s = wallet_core::ton_hw_signed(&boc, &pk, false, &out[32..], &out[..32]).unwrap();
        assert_eq!(s.summary.jetton.unwrap().symbol, "USDT");

        let r = Replay::new(&app("TON", "2.1.0"));
        let a = App::open(&r, &c, HwKeyChain::Ton).unwrap();
        assert!(matches!(
            sign(&a, &path, &req),
            Err(HwError::Unsupported { .. })
        ));
        assert!(r.done());
        // A plain transfer does not need it.
        assert_eq!(hint_of(&[1u8; 10]), None);
    }

    #[test]
    fn sign_sends_path_then_request() {
        let path = HwKeyChain::Ton.path(0);
        let req = vec![0x01u8; 300];
        let apdus = sign_apdus(&path, &req).unwrap();
        assert_eq!(apdus.len(), 3);
        assert_eq!(hex::encode(&apdus[0]), format!("e006000319{PATH0}"));
        assert_eq!(&apdus[1][..5], &[0xE0, 0x06, 0x00, P2_MORE, 255]);
        assert_eq!(&apdus[2][..5], &[0xE0, 0x06, 0x00, P2_LAST, 45]);
        assert!(sign_apdus(&path, &[0u8; 511]).is_err());
        let (sig, hash) = ([5u8; 64], [9u8; 32]);
        let mut lines = app("TON", "2.9.0").to_vec();
        for (i, a) in apdus.iter().enumerate() {
            lines.push(format!("=> {}", hex::encode(a)));
            if i + 1 == apdus.len() {
                lines.push(format!(
                    "<= 40{}20{}9000",
                    hex::encode(sig),
                    hex::encode(hash)
                ));
            } else {
                lines.push("<= 9000".into());
            }
        }
        let r = Replay::new(&lines);
        let c = ctl();
        let a = App::open(&r, &c, HwKeyChain::Ton).unwrap();
        assert_eq!(
            sign(&a, &path, &req).unwrap(),
            [hash.to_vec(), sig.to_vec()].concat()
        );
        assert!(r.done());
    }
}
