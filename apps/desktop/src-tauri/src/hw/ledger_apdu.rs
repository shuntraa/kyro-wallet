//! Ledger wire protocol, pure functions (no I/O): USB HID framing, APDUs of the Ethereum and
//! Solana apps, "get app and version", status words.
//!
//! Specs: HID framing ("Transport protocol"):
//! <https://github.com/LedgerHQ/app-solana/blob/develop/doc/api.md> (same framing for every app:
//! channel `0x0101`, tag `0x05`, 64-byte packets).

use super::{HwError, HwResult};

pub const PACKET: usize = 64;
const CHANNEL: [u8; 2] = [0x01, 0x01];
const TAG_APDU: u8 = 0x05;
const MAX_DATA: usize = 255;

/// Splits an APDU into 64-byte HID packets (without the leading HID report id).
pub fn frames(apdu: &[u8]) -> Vec<[u8; PACKET]> {
    let len = u16::try_from(apdu.len()).unwrap_or(u16::MAX);
    let mut stream = len.to_be_bytes().to_vec();
    stream.extend_from_slice(apdu);
    let mut out = Vec::new();
    let mut seq: u16 = 0;
    let mut rest = stream.as_slice();
    loop {
        let mut p = [0u8; PACKET];
        p[..2].copy_from_slice(&CHANNEL);
        p[2] = TAG_APDU;
        p[3..5].copy_from_slice(&seq.to_be_bytes());
        let n = rest.len().min(PACKET - 5);
        p[5..5 + n].copy_from_slice(&rest[..n]);
        out.push(p);
        rest = &rest[n..];
        seq = seq.wrapping_add(1);
        if rest.is_empty() {
            return out;
        }
    }
}

/// Reassembles a response from HID packets.
#[derive(Default)]
pub struct Deframer {
    expected: Option<usize>,
    seq: u16,
    buf: Vec<u8>,
}

impl Deframer {
    /// Feeds one packet; returns the full response (data followed by the status word) once
    /// complete.
    pub fn push(&mut self, pkt: &[u8]) -> HwResult<Option<Vec<u8>>> {
        if pkt.len() < 5 || pkt[..2] != CHANNEL || pkt[2] != TAG_APDU {
            return Err(HwError::bad("unexpected HID packet"));
        }
        if u16::from_be_bytes([pkt[3], pkt[4]]) != self.seq {
            return Err(HwError::bad("out-of-sequence HID packet"));
        }
        let data = if self.seq == 0 {
            if pkt.len() < 7 {
                return Err(HwError::bad("truncated HID packet"));
            }
            let len = usize::from(u16::from_be_bytes([pkt[5], pkt[6]]));
            if len < 2 {
                return Err(HwError::bad("response without a status"));
            }
            self.expected = Some(len);
            &pkt[7..]
        } else {
            &pkt[5..]
        };
        self.buf.extend_from_slice(data);
        self.seq = self.seq.wrapping_add(1);
        match self.expected {
            Some(len) if self.buf.len() >= len => {
                self.buf.truncate(len);
                Ok(Some(std::mem::take(&mut self.buf)))
            }
            _ => Ok(None),
        }
    }
}

/// `CLA INS P1 P2 Lc data` (short APDU, at most 255 data bytes).
pub fn apdu(cla: u8, ins: u8, p1: u8, p2: u8, data: &[u8]) -> HwResult<Vec<u8>> {
    if data.len() > MAX_DATA {
        return Err(HwError::bad("APDU too long"));
    }
    let mut out = vec![cla, ins, p1, p2, data.len() as u8];
    out.extend_from_slice(data);
    Ok(out)
}

/// Splits `data || SW1 SW2`.
pub fn split_sw(mut resp: Vec<u8>) -> HwResult<(Vec<u8>, u16)> {
    if resp.len() < 2 {
        return Err(HwError::bad("response without a status"));
    }
    let sw = u16::from_be_bytes([resp[resp.len() - 2], resp[resp.len() - 1]]);
    resp.truncate(resp.len() - 2);
    Ok((resp, sw))
}

/// BIP32 path as `n || index_1 (BE) || … || index_n (BE)`.
pub fn encode_path(path: &[u32]) -> Vec<u8> {
    let mut out = vec![path.len() as u8];
    for p in path {
        out.extend_from_slice(&p.to_be_bytes());
    }
    out
}

pub const SW_OK: u16 = 0x9000;
/// Ledger's dashboard reports itself as this app name.
pub const DASHBOARD: &str = "BOLOS";

/// GET APP AND VERSION (`B0 01 00 00`), answered by the OS for whatever app is open.
pub fn get_app_and_version() -> Vec<u8> {
    vec![0xB0, 0x01, 0x00, 0x00, 0x00]
}

/// QUIT APP (`B0 A7 00 00`): the open app exits to the dashboard (the USB device re-enumerates).
pub fn quit_app() -> Vec<u8> {
    vec![0xB0, 0xA7, 0x00, 0x00, 0x00]
}

/// OPEN APP (`E0 D8 00 00 Lc name`), sent to the dashboard: the user approves on the device,
/// then the app starts and the USB device re-enumerates.
pub fn open_app(name: &str) -> HwResult<Vec<u8>> {
    apdu(0xE0, 0xD8, 0x00, 0x00, name.as_bytes())
}

/// `format (=1) || len || name || len || version || [len || flags]`.
pub fn parse_app_and_version(data: &[u8]) -> HwResult<(String, String)> {
    let bad = || HwError::bad("malformed “app and version” response");
    if data.first() != Some(&0x01) {
        return Err(bad());
    }
    let mut i = 1;
    let field = |i: &mut usize| -> HwResult<String> {
        let n = usize::from(*data.get(*i).ok_or_else(bad)?);
        let s = data.get(*i + 1..*i + 1 + n).ok_or_else(bad)?;
        *i += 1 + n;
        String::from_utf8(s.to_vec()).map_err(|_| bad())
    };
    let name = field(&mut i)?;
    let version = field(&mut i)?;
    Ok((name, version))
}

/// Where a status word was received: the same code means different things.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SwContext {
    General,
    /// A signing request (the user may refuse on the device).
    Signing,
    /// Ethereum SIGN ETH TRANSACTION: `6A80` means "blind signing disabled".
    EthSigning,
}

/// Whether this status word means "the open app does not understand this command".
pub fn is_wrong_app(sw: u16) -> bool {
    matches!(sw, 0x6E00 | 0x6E01 | 0x6D00 | 0x6D02 | 0x6511 | 0x650F)
}

/// Maps a non-`9000` status word.
pub fn sw_error(sw: u16, ctx: SwContext) -> HwError {
    match sw {
        0x5515 => HwError::Locked,
        0x6982 if ctx == SwContext::General => HwError::Locked,
        0x6985 | 0x5501 | 0x6982 => HwError::Rejected,
        sw if is_wrong_app(sw) => HwError::WrongApp {
            expected: String::new(),
            open: String::new(),
        },
        0x6A80 if ctx == SwContext::EthSigning => HwError::unsupported(
            "this Ledger cannot show the details of this transaction: turn on \
             “Blind signing” in the Ethereum app settings (Kyro showed its \
             own summary), or reject",
        ),
        0x6808 => HwError::unsupported(
            "this Ledger cannot show the details of this transaction: turn on \
             “Blind signing” in the Solana app settings, or reject",
        ),
        0x6807 => HwError::unsupported("app not installed on the device"),
        0xB008 => HwError::bad("signature or HMAC rejected by the device (B008)"),
        other => HwError::bad(format!("device status {other:04X}")),
    }
}

const ETH_CLA: u8 = 0xE0;

/// GET ETH PUBLIC ADDRESS (`E0 02`), with the chain code (`P2 = 01`).
pub fn eth_get_address(path: &[u32], display: bool) -> HwResult<Vec<u8>> {
    apdu(ETH_CLA, 0x02, u8::from(display), 0x01, &encode_path(path))
}

pub struct EthAddress {
    /// 65-byte uncompressed SEC1 key.
    pub pubkey: Vec<u8>,
    /// What the app says the address is (hex, without `0x`, any case).
    pub address_hex: String,
    pub chain_code: Option<[u8; 32]>,
}

/// `len || pubkey || len || ascii address || [chain code 32]`.
pub fn eth_parse_address(data: &[u8]) -> HwResult<EthAddress> {
    let bad = || HwError::bad("malformed “Ethereum address” response");
    let pk_len = usize::from(*data.first().ok_or_else(bad)?);
    let pubkey = data.get(1..1 + pk_len).ok_or_else(bad)?.to_vec();
    let a = 1 + pk_len;
    let addr_len = usize::from(*data.get(a).ok_or_else(bad)?);
    let addr = data.get(a + 1..a + 1 + addr_len).ok_or_else(bad)?;
    let address_hex = String::from_utf8(addr.to_vec()).map_err(|_| bad())?;
    let rest = &data[a + 1 + addr_len..];
    let chain_code = match rest.len() {
        0 => None,
        32 => Some(rest.try_into().map_err(|_| bad())?),
        _ => return Err(bad()),
    };
    if address_hex.len() != 40 || !address_hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(bad());
    }
    Ok(EthAddress {
        pubkey,
        address_hex,
        chain_code,
    })
}

/// SIGN ETH TRANSACTION (`E0 04`): the typed transaction `0x02 || rlp(…)` streamed in chunks of
/// at most 255 bytes, the first one prefixed with the path (`P1 = 00` first, `80` next).
pub fn eth_sign(path: &[u32], payload: &[u8]) -> HwResult<Vec<Vec<u8>>> {
    let prefix = encode_path(path);
    let first = MAX_DATA - prefix.len();
    let mut out = Vec::new();
    let (head, mut rest) = payload.split_at(payload.len().min(first));
    let mut data = prefix;
    data.extend_from_slice(head);
    out.push(apdu(ETH_CLA, 0x04, 0x00, 0x00, &data)?);
    while !rest.is_empty() {
        let (chunk, tail) = rest.split_at(rest.len().min(MAX_DATA));
        out.push(apdu(ETH_CLA, 0x04, 0x80, 0x00, chunk)?);
        rest = tail;
    }
    Ok(out)
}

/// `v (1) || r (32) || s (32)`.
pub fn eth_parse_signature(data: &[u8]) -> HwResult<([u8; 32], [u8; 32])> {
    if data.len() != 65 {
        return Err(HwError::bad("Ethereum signature of unexpected length"));
    }
    let mut r = [0u8; 32];
    let mut s = [0u8; 32];
    r.copy_from_slice(&data[1..33]);
    s.copy_from_slice(&data[33..65]);
    Ok((r, s))
}

/// PROVIDE ERC 20 TOKEN INFORMATION, legacy format (`E0 0A 00 00`).
pub fn eth_provide_erc20(descriptor_payload: &[u8]) -> HwResult<Vec<u8>> {
    apdu(ETH_CLA, 0x0A, 0x00, 0x00, descriptor_payload)
}

const SOL_CLA: u8 = 0xE0;
const P2_EXTEND: u8 = 0x01;
const P2_MORE: u8 = 0x02;

/// GET PUBKEY (`E0 05`), `P1 = 01` to display and confirm on the device.
pub fn sol_get_pubkey(path: &[u32], display: bool) -> HwResult<Vec<u8>> {
    apdu(SOL_CLA, 0x05, u8::from(display), 0x00, &encode_path(path))
}

/// SIGN SOLANA TRANSACTION (`E0 06 01`): `1 (signer count) || path || message`, split in
/// 255-byte APDUs with `P2_MORE` on all but the last and `P2_EXTEND` on all but the first.
pub fn sol_sign(path: &[u32], message: &[u8]) -> HwResult<Vec<Vec<u8>>> {
    let mut payload = vec![1u8];
    payload.extend_from_slice(&encode_path(path));
    payload.extend_from_slice(message);
    let chunks: Vec<&[u8]> = payload.chunks(MAX_DATA).collect();
    let mut out = Vec::with_capacity(chunks.len());
    for (i, c) in chunks.iter().enumerate() {
        let mut p2 = 0;
        if i > 0 {
            p2 |= P2_EXTEND;
        }
        if i + 1 < chunks.len() {
            p2 |= P2_MORE;
        }
        out.push(apdu(SOL_CLA, 0x06, 0x01, p2, c)?);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hid_framing_single_packet() {
        let f = frames(&get_app_and_version());
        assert_eq!(f.len(), 1);
        assert_eq!(
            hex::encode(&f[0][..12]),
            "0101050000".to_owned() + "0005b001000000"
        );
        assert!(f[0][12..].iter().all(|b| *b == 0));
    }

    #[test]
    fn hid_framing_multi_packet_roundtrip() {
        let apdu: Vec<u8> = (0..=200u8).collect();
        let f = frames(&apdu);
        assert_eq!(f.len(), 4);
        assert_eq!(&f[1][..5], &[0x01, 0x01, 0x05, 0x00, 0x01]);
        assert_eq!(&f[3][..5], &[0x01, 0x01, 0x05, 0x00, 0x03]);
        let mut d = Deframer::default();
        let mut out = None;
        for p in &f {
            out = d.push(p).unwrap();
        }
        assert_eq!(out.unwrap(), apdu);
    }

    #[test]
    fn deframer_rejects_foreign_or_out_of_order_packets() {
        let f = frames(&[0u8; 100]);
        let mut d = Deframer::default();
        assert!(d.push(&f[1]).is_err(), "sequence 1 first");
        let mut bad = f[0];
        bad[2] = 0x02; // ping tag
        assert!(Deframer::default().push(&bad).is_err());
        let mut bad = f[0];
        bad[0] = 0x00;
        assert!(Deframer::default().push(&bad).is_err());
        assert!(Deframer::default().push(&[1, 1, 5]).is_err());
    }

    #[test]
    fn app_and_version_official_vector() {
        let resp = hex::decode("010c426974636f696e205465737405322e312e3001009000").unwrap();
        let (data, sw) = split_sw(resp).unwrap();
        assert_eq!(sw, SW_OK);
        assert_eq!(
            parse_app_and_version(&data).unwrap(),
            ("Bitcoin Test".to_string(), "2.1.0".to_string())
        );
        assert!(parse_app_and_version(&[0x01, 0x05, b'B']).is_err());
        assert!(parse_app_and_version(&[0x02]).is_err());
        assert!(split_sw(vec![0x90]).is_err());
    }

    #[test]
    fn status_words() {
        use SwContext::*;
        assert_eq!(sw_error(0x5515, General), HwError::Locked);
        assert_eq!(sw_error(0x5515, Signing), HwError::Locked);
        assert_eq!(sw_error(0x6982, General), HwError::Locked);
        assert_eq!(sw_error(0x6982, Signing), HwError::Rejected);
        assert_eq!(sw_error(0x6985, Signing), HwError::Rejected);
        assert_eq!(sw_error(0x6985, General), HwError::Rejected);
        for sw in [0x6E00, 0x6E01, 0x6D00, 0x6511] {
            assert!(
                matches!(sw_error(sw, General), HwError::WrongApp { .. }),
                "{sw:04x}"
            );
        }
        assert!(matches!(
            sw_error(0x6A80, EthSigning),
            HwError::Unsupported { .. }
        ));
        assert!(matches!(sw_error(0x6A80, General), HwError::BadResponse(_)));
        assert!(matches!(
            sw_error(0x6808, Signing),
            HwError::Unsupported { .. }
        ));
        assert!(matches!(sw_error(0xB007, General), HwError::BadResponse(_)));
    }

    #[test]
    fn eth_get_address_encoding() {
        let a = eth_get_address(&super::super::evm_path(0), true).unwrap();
        assert_eq!(
            hex::encode(a),
            "e002010115058000002c8000003c800000000000000000000000"
        );
        let mut resp = vec![65u8];
        resp.extend([4u8; 65]);
        resp.push(40);
        resp.extend(b"9858EfFD232B4033E47d90003D41EC34EcaEda94");
        resp.extend([7u8; 32]);
        let p = eth_parse_address(&resp).unwrap();
        assert_eq!(p.pubkey.len(), 65);
        assert_eq!(p.address_hex, "9858EfFD232B4033E47d90003D41EC34EcaEda94");
        assert_eq!(p.chain_code, Some([7u8; 32]));
        assert!(eth_parse_address(&resp[..resp.len() - 1]).is_err());
        assert!(eth_parse_address(&resp[..100]).is_err());
    }

    #[test]
    fn eth_sign_chunking() {
        let path = super::super::evm_path(0);
        let payload: Vec<u8> = (0..600u32).map(|i| i as u8).collect();
        let apdus = eth_sign(&path, &payload).unwrap();
        assert_eq!(apdus.len(), 3);
        assert_eq!(&apdus[0][..5], &[0xE0, 0x04, 0x00, 0x00, 0xFF]);
        assert_eq!(apdus[0][5], 5);
        assert_eq!(&apdus[1][..5], &[0xE0, 0x04, 0x80, 0x00, 0xFF]);
        assert_eq!(&apdus[2][..5], &[0xE0, 0x04, 0x80, 0x00, 111]);
        let mut joined = apdus[0][5 + 21..].to_vec();
        joined.extend(&apdus[1][5..]);
        joined.extend(&apdus[2][5..]);
        assert_eq!(joined, payload);
        assert_eq!(eth_sign(&path, &[0x02, 0xc0]).unwrap().len(), 1);
        let mut sig = vec![1u8];
        sig.extend([0xaa; 32]);
        sig.extend([0xbb; 32]);
        assert_eq!(eth_parse_signature(&sig).unwrap(), ([0xaa; 32], [0xbb; 32]));
        assert!(eth_parse_signature(&sig[..64]).is_err());
    }

    #[test]
    fn sol_encoding_and_chunking() {
        let path = super::super::sol_path(0);
        assert_eq!(
            hex::encode(sol_get_pubkey(&path, false).unwrap()),
            "e00500001104".to_owned() + "8000002c800001f58000000080000000"
        );
        let one = sol_sign(&path, &[9u8; 100]).unwrap();
        assert_eq!(one.len(), 1);
        assert_eq!(&one[0][..6], &[0xE0, 0x06, 0x01, 0x00, 118, 0x01]);
        let msg = vec![9u8; 600];
        let many = sol_sign(&path, &msg).unwrap();
        assert_eq!(many.len(), 3);
        assert_eq!(many[0][3], P2_MORE);
        assert_eq!(many[1][3], P2_MORE | P2_EXTEND);
        assert_eq!(many[2][3], P2_EXTEND);
        assert_eq!(many[2][4], 108);
    }

    #[test]
    fn apdu_length_limit() {
        assert!(apdu(0xE0, 0, 0, 0, &[0; 255]).is_ok());
        assert!(apdu(0xE0, 0, 0, 0, &[0; 256]).is_err());
    }
}
