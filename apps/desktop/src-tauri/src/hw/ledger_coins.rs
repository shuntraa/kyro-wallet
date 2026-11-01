//! APDUs of the Ledger XRP, Stellar and Tron apps (all CLA `E0`), from Ledger's own host
//! libraries `@ledgerhq/hw-app-xrp`, `hw-app-str` and `hw-app-trx` (ledger-live repository,
//! read 2026-11-01):
//!
//! | app | get key (`02`) | sign (`04`) |
//! |---|---|---|
//! | XRP | P1 `01` = show, P2 `40` = secp256k1 (`80` ed25519) → `len‖key‖len‖address` | path ‖ tx in 150-byte APDUs, P1 = (`00` first / `01` next) ∣ `80` if more, P2 `40` → DER |
//! | Stellar | P1 `00`, P2 `01` = show → 32-byte key | path ‖ signature base in 255-byte APDUs, P1 `00` first / `80` next, P2 `80` more / `00` last → 64-byte ed25519 |
//! | Tron | P1 `01` = show, P2 `00` → `len‖key(65)‖len‖address` | path ‖ `raw_data` split between protobuf fields, ≤ 250 bytes per APDU, P1 `10` single / `00` first / `80` middle / `90` last → 65-byte `r‖s‖v` |
//!
//! Status words: `6985` = refused on the device (all three apps); Stellar `6C66` = hash signing
//! disabled, `B004` data too large, `B005` parsing failed.

use super::ledger_apdu::{apdu, encode_path};
use super::{HwError, HwResult};

const CLA: u8 = 0xE0;
const INS_GET: u8 = 0x02;
const INS_SIGN: u8 = 0x04;

// ---------------------------------------------------------------- XRP

const XRP_SECP256K1: u8 = 0x40;
const XRP_CHUNK: usize = 150;

pub fn xrp_get_address(path: &[u32], display: bool) -> HwResult<Vec<u8>> {
    apdu(
        CLA,
        INS_GET,
        u8::from(display),
        XRP_SECP256K1,
        &encode_path(path),
    )
}

/// `len ‖ key ‖ len ‖ address` → (key, address). Shared by the XRP and Tron apps.
pub fn parse_key_and_address(data: &[u8]) -> HwResult<(Vec<u8>, String)> {
    let bad = || HwError::bad("malformed “key and address” response");
    let n = usize::from(*data.first().ok_or_else(bad)?);
    let key = data.get(1..1 + n).ok_or_else(bad)?.to_vec();
    let m = usize::from(*data.get(1 + n).ok_or_else(bad)?);
    let addr = data.get(2 + n..2 + n + m).ok_or_else(bad)?;
    let addr = String::from_utf8(addr.to_vec()).map_err(|_| bad())?;
    Ok((key, addr))
}

/// Path ‖ unsigned transaction (binary, without the `STX\0` prefix the app adds).
pub fn xrp_sign(path: &[u32], tx: &[u8]) -> HwResult<Vec<Vec<u8>>> {
    let mut payload = encode_path(path);
    payload.extend_from_slice(tx);
    let mut out = Vec::new();
    let mut offset = 0;
    while offset < payload.len() {
        let n = (payload.len() - offset).min(XRP_CHUNK);
        let first = offset == 0;
        let more = offset + n < payload.len();
        let p1 = (if first { 0x00 } else { 0x01 }) | if more { 0x80 } else { 0x00 };
        out.push(apdu(
            CLA,
            INS_SIGN,
            p1,
            XRP_SECP256K1,
            &payload[offset..offset + n],
        )?);
        offset += n;
    }
    Ok(out)
}

// ---------------------------------------------------------------- Stellar

const STELLAR_CHUNK: usize = 255;

pub fn stellar_get_public_key(path: &[u32], display: bool) -> HwResult<Vec<u8>> {
    apdu(CLA, INS_GET, 0x00, u8::from(display), &encode_path(path))
}

pub fn stellar_parse_public_key(data: &[u8]) -> HwResult<[u8; 32]> {
    data.try_into()
        .map_err(|_| HwError::bad("Stellar key: 32 bytes expected"))
}

/// Path ‖ `TransactionSignaturePayload`.
pub fn stellar_sign(path: &[u32], signature_base: &[u8]) -> HwResult<Vec<Vec<u8>>> {
    let mut payload = encode_path(path);
    payload.extend_from_slice(signature_base);
    let n = payload.chunks(STELLAR_CHUNK).count();
    payload
        .chunks(STELLAR_CHUNK)
        .enumerate()
        .map(|(k, c)| {
            apdu(
                CLA,
                INS_SIGN,
                if k == 0 { 0x00 } else { 0x80 },
                if k + 1 == n { 0x00 } else { 0x80 },
                c,
            )
        })
        .collect()
}

// ---------------------------------------------------------------- Tron

const TRON_CHUNK: usize = 250;

pub fn tron_get_address(path: &[u32], display: bool) -> HwResult<Vec<u8>> {
    apdu(CLA, INS_GET, u8::from(display), 0x00, &encode_path(path))
}

fn varint(data: &[u8], mut pos: usize) -> HwResult<(u64, usize)> {
    let mut v = 0u64;
    for shift in (0..64).step_by(7) {
        let b = *data
            .get(pos)
            .ok_or_else(|| HwError::bad("truncated raw_data"))?;
        pos += 1;
        v |= u64::from(b & 0x7f) << shift;
        if b & 0x80 == 0 {
            return Ok((v, pos));
        }
    }
    Err(HwError::bad("varint too long"))
}

/// Length of the protobuf field at the start of `tx` (hw-app-trx `getNextLength`: varint
/// fields end after their value, every other wire type is read as length-delimited — Kyro's
/// `raw_data` only has varint and length-delimited fields).
fn next_field_len(tx: &[u8]) -> HwResult<usize> {
    let (tag, p) = varint(tx, 0)?;
    match tag & 7 {
        0 => Ok(varint(tx, p)?.1),
        2 => {
            let (n, q) = varint(tx, p)?;
            let end = q
                .checked_add(usize::try_from(n).map_err(|_| HwError::bad("field too long"))?)
                .filter(|e| *e <= tx.len())
                .ok_or_else(|| HwError::bad("truncated raw_data"))?;
            Ok(end)
        }
        _ => Err(HwError::unsupported(
            "protobuf field not supported by the Tron app",
        )),
    }
}

/// Path ‖ `raw_data`, cut between top-level fields, at most 250 bytes per APDU.
pub fn tron_sign(path: &[u32], raw: &[u8]) -> HwResult<Vec<Vec<u8>>> {
    let mut chunks: Vec<Vec<u8>> = Vec::new();
    let mut cur = encode_path(path);
    let mut rest = raw;
    while !rest.is_empty() {
        let n = next_field_len(rest)?;
        if n > TRON_CHUNK {
            return Err(HwError::unsupported(
                "transaction too large for the Tron app",
            ));
        }
        if cur.len() + n > TRON_CHUNK {
            chunks.push(std::mem::take(&mut cur));
            continue;
        }
        cur.extend_from_slice(&rest[..n]);
        rest = &rest[n..];
    }
    chunks.push(cur);
    let last = chunks.len() - 1;
    chunks
        .iter()
        .enumerate()
        .map(|(k, c)| {
            let p1 = match (k, last) {
                (_, 0) => 0x10,
                (0, _) => 0x00,
                (k, l) if k == l => 0x90,
                _ => 0x80,
            };
            apdu(CLA, INS_SIGN, p1, 0x00, c)
        })
        .collect()
}

/// `r ‖ s ‖ v` with `v` as 27/28 (what Kyro's own signer and TronGrid use).
pub fn tron_parse_signature(data: &[u8]) -> HwResult<[u8; 65]> {
    let mut sig: [u8; 65] = data
        .get(..65)
        .and_then(|s| s.try_into().ok())
        .ok_or_else(|| HwError::bad("Tron signature: 65 bytes expected"))?;
    sig[64] = match sig[64] {
        0 | 27 => 27,
        1 | 28 => 28,
        _ => return Err(HwError::bad("Tron signature: invalid v")),
    };
    Ok(sig)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hw::H;

    #[test]
    fn xrp_apdus() {
        let path = [44 | H, 144 | H, H, 0, 0];
        assert_eq!(
            hex::encode(xrp_get_address(&path, true).unwrap()),
            "e002014015058000002c80000090800000000000000000000000"
        );
        // 21-byte path + 300-byte tx = 321 bytes → 150 + 150 + 21.
        let tx = vec![0x12u8; 300];
        let a = xrp_sign(&path, &tx).unwrap();
        assert_eq!(a.len(), 3);
        assert_eq!((a[0][2], a[0][3], a[0][4]), (0x80, 0x40, 150));
        assert_eq!(&a[0][5..26], encode_path(&path).as_slice());
        assert_eq!((a[1][2], a[1][4]), (0x81, 150));
        assert_eq!((a[2][2], a[2][4]), (0x01, 21));
        // A short transaction fits in one APDU: P1 00.
        assert_eq!(xrp_sign(&path, &[1, 2, 3]).unwrap()[0][2], 0x00);
        let mut resp = vec![33u8];
        resp.extend([2u8; 33]);
        resp.push(3);
        resp.extend(b"rXY");
        assert_eq!(
            parse_key_and_address(&resp).unwrap(),
            (vec![2u8; 33], "rXY".to_string())
        );
        assert!(parse_key_and_address(&resp[..20]).is_err());
    }

    #[test]
    fn stellar_apdus() {
        let path = [44 | H, 148 | H, H];
        assert_eq!(
            hex::encode(stellar_get_public_key(&path, false).unwrap()),
            "e00200000d038000002c8000009480000000"
        );
        assert_eq!(stellar_get_public_key(&path, true).unwrap()[3], 0x01);
        // 13-byte path + 400 bytes = 413 → 255 (P1 00, P2 80) + 158 (P1 80, P2 00).
        let a = stellar_sign(&path, &[7u8; 400]).unwrap();
        assert_eq!(a.len(), 2);
        assert_eq!((a[0][2], a[0][3], a[0][4]), (0x00, 0x80, 255));
        assert_eq!((a[1][2], a[1][3], a[1][4]), (0x80, 0x00, 158));
        let one = stellar_sign(&path, &[7u8; 100]).unwrap();
        assert_eq!((one[0][2], one[0][3]), (0x00, 0x00));
        assert!(stellar_parse_public_key(&[1u8; 31]).is_err());
    }

    #[test]
    fn tron_field_chunking() {
        let path = [44 | H, 195 | H, H, 0, 0];
        // A TransferContract raw_data (Kyro's encoder): fits in one APDU, P1 10.
        let raw = wallet_core::TronRaw {
            ref_block_bytes: [1, 2],
            ref_block_hash: [3; 8],
            expiration: 1_700_000_060_000,
            memo: Vec::new(),
            contract: wallet_core::TronContract::Transfer {
                owner: [0x41; 21],
                to: [0x42; 21],
                amount: 1_000_000,
            },
            timestamp: 1_700_000_000_000,
            fee_limit: 0,
        }
        .encode();
        let a = tron_sign(&path, &raw).unwrap();
        assert_eq!(a.len(), 1);
        assert_eq!(a[0][2], 0x10);
        assert_eq!(
            &a[0][5..],
            [encode_path(&path), raw.clone()].concat().as_slice()
        );
        // Fields are never split: a large contract field goes into its own APDUs.
        let mut big = raw.clone();
        // A 240-byte length-delimited field 10 (data), then varint fields.
        big.extend([0x52, 0xf0, 0x01]);
        big.extend([0u8; 240]);
        let b = tron_sign(&path, &big).unwrap();
        assert_eq!(b.len(), 2);
        assert_eq!((b[0][2], b[1][2]), (0x00, 0x90));
        let reassembled: Vec<u8> = b.iter().flat_map(|x| x[5..].to_vec()).collect();
        assert_eq!(reassembled, [encode_path(&path), big].concat());
        assert!(
            tron_sign(&path, &[0x52, 0x05, 1]).is_err(),
            "truncated field"
        );
        // v normalised to 27/28.
        let mut s = vec![1u8; 64];
        s.push(1);
        assert_eq!(tron_parse_signature(&s).unwrap()[64], 28);
        s[64] = 5;
        assert!(tron_parse_signature(&s).is_err());
    }
}
