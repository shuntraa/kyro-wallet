//! Ledger « Cosmos » app (Zondax ledger-cosmos, host library `@zondax/ledger-cosmos-js`).

use super::ledger_apdu::{self as apdu, SwContext};
use super::ledger_apps::App;
use super::{HwError, HwResult};

const CLA: u8 = 0x55;
const INS_SIGN_SECP256K1: u8 = 0x02;
const INS_GET_ADDR_SECP256K1: u8 = 0x04;
const P1_INIT: u8 = 0x00;
const P1_ADD: u8 = 0x01;
const P1_LAST: u8 = 0x02;
const P2_JSON: u8 = 0x00;
const CHUNK: usize = 250;
const HRP: &str = "cosmos";

fn path_bytes(path: &[u32]) -> HwResult<Vec<u8>> {
    if path.len() != 5 {
        return Err(HwError::bad("Cosmos app: five-level path expected"));
    }
    Ok(path.iter().flat_map(|p| p.to_le_bytes()).collect())
}

pub fn get_address(path: &[u32], display: bool) -> HwResult<Vec<u8>> {
    let mut data = vec![HRP.len() as u8];
    data.extend_from_slice(HRP.as_bytes());
    data.extend(path_bytes(path)?);
    apdu::apdu(CLA, INS_GET_ADDR_SECP256K1, u8::from(display), 0, &data)
}

pub fn parse_address(data: &[u8]) -> HwResult<Vec<u8>> {
    if data.len() <= 33 {
        return Err(HwError::bad("malformed Cosmos address"));
    }
    let (pk, addr) = data.split_at(33);
    let ours =
        wallet_core::cosmos_address_of_pubkey(pk).map_err(|e| HwError::bad(e.to_string()))?;
    if addr != ours.as_bytes() {
        return Err(HwError::bad(
            "Cosmos address from the device does not match its key",
        ));
    }
    Ok(pk.to_vec())
}

pub fn sign_apdus(path: &[u32], json: &[u8]) -> HwResult<Vec<Vec<u8>>> {
    let mut chunks = vec![path_bytes(path)?];
    chunks.extend(json.chunks(CHUNK).map(<[u8]>::to_vec));
    let n = chunks.len();
    chunks
        .iter()
        .enumerate()
        .map(|(i, c)| {
            let p1 = match i {
                0 => P1_INIT,
                i if i + 1 == n => P1_LAST,
                _ => P1_ADD,
            };
            apdu::apdu(CLA, INS_SIGN_SECP256K1, p1, P2_JSON, c)
        })
        .collect()
}

pub fn pubkey(app: &App<'_>, path: &[u32], display: bool) -> HwResult<Vec<u8>> {
    let ctx = if display {
        SwContext::Signing
    } else {
        SwContext::General
    };
    parse_address(&app.call(&get_address(path, display)?, ctx)?)
}

pub fn sign(app: &App<'_>, path: &[u32], json: &[u8]) -> HwResult<Vec<u8>> {
    let mut last = Vec::new();
    for a in sign_apdus(path, json)? {
        last = app.call(&a, SwContext::Signing)?;
    }
    if last.len() < 8 || last.len() > 72 || last[0] != 0x30 {
        return Err(HwError::bad("malformed Cosmos (DER) signature"));
    }
    Ok(last)
}

#[cfg(test)]
mod tests {
    use super::super::ledger_apps::replay::*;
    use super::*;
    use wallet_core::HwKeyChain;

    const PK: &str = "02baa4ef93f2ce84592a49b1d729c074eab640112522a7a89f7d03ebab21ded7b6";

    #[test]
    fn get_address_vector() {
        let path = HwKeyChain::Cosmos.path(0);
        let cmd = get_address(&path, false).unwrap();
        assert_eq!(
            hex::encode(&cmd),
            "550400001b06636f736d6f732c00008076000080000000800000000000000000"
        );
        let addr = wallet_core::cosmos_address_of_pubkey(&hex::decode(PK).unwrap()).unwrap();
        let resp = [hex::decode(PK).unwrap(), addr.into_bytes()].concat();
        let mut lines = app("Cosmos", "2.38.1").to_vec();
        lines.push(format!("=> {}", hex::encode(&cmd)));
        lines.push(format!("<= {}9000", hex::encode(&resp)));
        let r = Replay::new(&lines);
        let c = ctl();
        let a = App::open(&r, &c, HwKeyChain::Cosmos).unwrap();
        assert_eq!(hex::encode(pubkey(&a, &path, false).unwrap()), PK);
        let mut bad = resp.clone();
        let n = bad.len();
        bad[n - 1] = b'q';
        assert!(parse_address(&bad).is_err());
    }

    #[test]
    fn sign_init_add_last() {
        let path = HwKeyChain::Cosmos.path(0);
        let json = vec![b'{'; 300];
        let apdus = sign_apdus(&path, &json).unwrap();
        assert_eq!(apdus.len(), 3);
        assert_eq!(&apdus[0][..5], &[0x55, 0x02, 0x00, 0x00, 20]);
        assert_eq!(&apdus[1][..5], &[0x55, 0x02, 0x01, 0x00, 250]);
        assert_eq!(&apdus[2][..5], &[0x55, 0x02, 0x02, 0x00, 50]);
        let two = sign_apdus(&path, b"{}").unwrap();
        assert_eq!((two[0][2], two[1][2]), (P1_INIT, P1_LAST));
        let der = "3044022012345678901234567890123456789012345678901234567890123456789002201234567890123456789012345678901234567890123456789012345678";
        let mut lines = app("Cosmos", "2.38.1").to_vec();
        for (i, a) in apdus.iter().enumerate() {
            lines.push(format!("=> {}", hex::encode(a)));
            lines.push(if i == 2 {
                format!("<= {der}9000")
            } else {
                "<= 9000".into()
            });
        }
        let r = Replay::new(&lines);
        let c = ctl();
        let a = App::open(&r, &c, HwKeyChain::Cosmos).unwrap();
        assert_eq!(hex::encode(sign(&a, &path, &json).unwrap()), der);
        assert!(r.done());
    }
}
