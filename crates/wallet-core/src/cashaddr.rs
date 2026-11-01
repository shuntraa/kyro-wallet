//! CashAddr, the Bitcoin Cash address format
//! (spec: <https://github.com/bitcoincashorg/bitcoincash.org/blob/master/spec/cashaddr.md>,
//! read 2026-11-01).
//!
//! `prefix:payload`, the payload being base32 (bech32's alphabet) of `version byte || hash`
//! followed by an 8-character (40-bit) BCH-code checksum computed over the prefix's lower
//! 5 bits, a zero separator and the payload. Nothing here is cryptography: the checksum is
//! run by the audited `bech32` crate's generic checksum engine (re-exported by `bitcoin`),
//! configured with the CashAddr generator from the spec, and the 8↔5-bit regrouping is the
//! crate's own. Every vector of the spec is checked below (all sizes, types 0, 1 and 15).
//!
//! Appending the target residue `0…01` (what the engine does) is the spec's
//! `PolyMod(… ‖ 0×8) ^ 1`: the last symbol only enters the low 5 bits, after the reduction.

use bitcoin::bech32::primitives::checksum::{Checksum, Engine};
use bitcoin::bech32::primitives::iter::{ByteIterExt, Fe32IterExt};
use bitcoin::bech32::Fe32;

use crate::error::{Error, Result};

/// The CashAddr checksum: degree-8 generator over GF(32) (spec `PolyMod`, constants
/// `0x98f2bc8e61 … 0x1e4f43e470`); a valid string has residue 1.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CashAddrCk {}

impl Checksum for CashAddrCk {
    type MidstateRepr = u64;
    /// BCH code length 2^20 − 1 (spec, "Checksum"); only checksum length and generator are
    /// used by the engine.
    const CODE_LENGTH: usize = 1_048_575;
    const CHECKSUM_LENGTH: usize = 8;
    const GENERATOR_SH: [u64; 5] = [
        0x98f2bc8e61,
        0x79b76d99e2,
        0xf33e5fb3c4,
        0xae2eabe2a8,
        0x1e4f43e470,
    ];
    const TARGET_RESIDUE: u64 = 1;
}

/// Hash sizes in bits, indexed by the version byte's size bits (0–2).
const SIZES: [usize; 8] = [160, 192, 224, 256, 320, 384, 448, 512];

/// Address types Kyro uses (version byte bits 3–6).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CashKind {
    /// Type 0 (`q…`), or 2 (`z…`, CashTokens-aware): pay to public key hash.
    P2pkh,
    /// Type 1 (`p…`), or 3 (`r…`, CashTokens-aware): pay to script hash.
    P2sh,
}

fn engine_with_prefix(prefix: &str) -> Result<Engine<CashAddrCk>> {
    if prefix.is_empty()
        || !prefix
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
    {
        return Err(Error::input("invalid CashAddr prefix"));
    }
    let mut e = Engine::<CashAddrCk>::new();
    for b in prefix.bytes() {
        e.input_fe(Fe32::try_from(b & 0x1f).map_err(|_| Error::input("invalid prefix"))?);
    }
    e.input_fe(Fe32::Q); // separator
    Ok(e)
}

/// Encodes `payload` (a hash of one of the spec's sizes) with address type `kind_type`
/// (0–15) as `prefix:…`, lower case.
pub(crate) fn encode_raw(prefix: &str, kind_type: u8, payload: &[u8]) -> Result<String> {
    let size = SIZES
        .iter()
        .position(|s| *s == payload.len() * 8)
        .ok_or_else(|| Error::input("invalid CashAddr hash size"))?;
    if kind_type > 15 {
        return Err(Error::input("invalid CashAddr type"));
    }
    let version = (kind_type << 3) | size as u8;
    let data: Vec<Fe32> = core::iter::once(version)
        .chain(payload.iter().copied())
        .bytes_to_fes()
        .collect();
    let mut e = engine_with_prefix(prefix)?;
    for fe in &data {
        e.input_fe(*fe);
    }
    e.input_target_residue();
    let residue = *e.residue();
    let mut out = String::with_capacity(prefix.len() + 1 + data.len() + 8);
    out.push_str(prefix);
    out.push(':');
    for fe in &data {
        out.push(fe.to_char());
    }
    for i in (0..CashAddrCk::CHECKSUM_LENGTH).rev() {
        let fe = Fe32::try_from(((residue >> (5 * i)) & 0x1f) as u8)
            .map_err(|_| Error::crypto("checksum encoding failed"))?;
        out.push(fe.to_char());
    }
    Ok(out)
}

/// Why a string is not a CashAddr of the expected prefix.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum DecodeError {
    /// A valid-looking string with another prefix (another network).
    OtherPrefix(String),
    /// Anything else: mixed case, bad characters, bad checksum, bad padding, bad size, bad
    /// version byte.
    Invalid,
}

/// Decodes a CashAddr string for `prefix` into `(type, hash)`. The prefix may be omitted (it is
/// then assumed, and the checksum proves it). Mixed case, a bad checksum, non-zero padding, a
/// reserved version bit, or a hash whose length disagrees with the size bits are refused.
pub(crate) fn decode_raw(
    address: &str,
    prefix: &str,
) -> core::result::Result<(u8, Vec<u8>), DecodeError> {
    let a = address.trim();
    let has_lower = a.bytes().any(|b| b.is_ascii_lowercase());
    let has_upper = a.bytes().any(|b| b.is_ascii_uppercase());
    if has_lower && has_upper {
        return Err(DecodeError::Invalid);
    }
    let a = a.to_ascii_lowercase();
    let (found, payload) = match a.split_once(':') {
        Some((p, rest)) => (p, rest),
        None => (prefix, a.as_str()),
    };
    if found != prefix {
        return Err(DecodeError::OtherPrefix(found.to_owned()));
    }
    let fes: Vec<Fe32> = payload
        .chars()
        .map(Fe32::from_char)
        .collect::<core::result::Result<_, _>>()
        .map_err(|_| DecodeError::Invalid)?;
    if fes.len() <= CashAddrCk::CHECKSUM_LENGTH || fes.len() > 112 {
        return Err(DecodeError::Invalid);
    }
    let mut e = engine_with_prefix(prefix).map_err(|_| DecodeError::Invalid)?;
    for fe in &fes {
        e.input_fe(*fe);
    }
    if *e.residue() != CashAddrCk::TARGET_RESIDUE {
        return Err(DecodeError::Invalid);
    }
    let data = &fes[..fes.len() - CashAddrCk::CHECKSUM_LENGTH];
    let bits = data.len() * 5;
    let bytes: Vec<u8> = data.iter().copied().fes_to_bytes().collect();
    // Padding: fewer than 5 bits, all zero.
    let pad = bits - bytes.len() * 8;
    let last = data.last().map_or(0, |fe| fe.to_u8());
    if pad >= 5 || last & ((1u8 << pad) - 1) != 0 {
        return Err(DecodeError::Invalid);
    }
    let (&version, hash) = bytes.split_first().ok_or(DecodeError::Invalid)?;
    if version & 0x80 != 0 || hash.len() * 8 != SIZES[usize::from(version & 0x07)] {
        return Err(DecodeError::Invalid);
    }
    Ok(((version >> 3) & 0x0f, hash.to_vec()))
}

/// Encodes a 20-byte hash as `prefix:q…` / `prefix:p…`.
pub(crate) fn encode(prefix: &str, kind: CashKind, hash: &[u8; 20]) -> Result<String> {
    let t = match kind {
        CashKind::P2pkh => 0,
        CashKind::P2sh => 1,
    };
    encode_raw(prefix, t, hash)
}

/// Decodes a P2PKH / P2SH CashAddr of `prefix` (20-byte hash, types 0–3). Other types and
/// sizes (P2SH32, unknown types) are [`DecodeError::Invalid`].
pub(crate) fn decode(
    address: &str,
    prefix: &str,
) -> core::result::Result<(CashKind, [u8; 20]), DecodeError> {
    let (t, hash) = decode_raw(address, prefix)?;
    let kind = match t {
        0 | 2 => CashKind::P2pkh,
        1 | 3 => CashKind::P2sh,
        _ => return Err(DecodeError::Invalid),
    };
    let hash: [u8; 20] = hash.try_into().map_err(|_| DecodeError::Invalid)?;
    Ok((kind, hash))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generator_is_consistent() {
        CashAddrCk::sanity_check();
    }

    /// Spec, "Larger test vectors": every size, types 0, 1 and 15, four prefixes.
    #[test]
    fn spec_test_vectors() {
        let v: &[(usize, u8, &str, &str)] = &[
            (20, 0, "bitcoincash:qr6m7j9njldwwzlg9v7v53unlr4jkmx6eylep8ekg2", "F5BF48B397DAE70BE82B3CCA4793F8EB2B6CDAC9"),
            (20, 1, "bchtest:pr6m7j9njldwwzlg9v7v53unlr4jkmx6eyvwc0uz5t", "F5BF48B397DAE70BE82B3CCA4793F8EB2B6CDAC9"),
            (20, 1, "pref:pr6m7j9njldwwzlg9v7v53unlr4jkmx6ey65nvtks5", "F5BF48B397DAE70BE82B3CCA4793F8EB2B6CDAC9"),
            (20, 15, "prefix:0r6m7j9njldwwzlg9v7v53unlr4jkmx6ey3qnjwsrf", "F5BF48B397DAE70BE82B3CCA4793F8EB2B6CDAC9"),
            (24, 0, "bitcoincash:q9adhakpwzztepkpwp5z0dq62m6u5v5xtyj7j3h2ws4mr9g0", "7ADBF6C17084BC86C1706827B41A56F5CA32865925E946EA"),
            (24, 1, "bchtest:p9adhakpwzztepkpwp5z0dq62m6u5v5xtyj7j3h2u94tsynr", "7ADBF6C17084BC86C1706827B41A56F5CA32865925E946EA"),
            (24, 1, "pref:p9adhakpwzztepkpwp5z0dq62m6u5v5xtyj7j3h2khlwwk5v", "7ADBF6C17084BC86C1706827B41A56F5CA32865925E946EA"),
            (24, 15, "prefix:09adhakpwzztepkpwp5z0dq62m6u5v5xtyj7j3h2p29kc2lp", "7ADBF6C17084BC86C1706827B41A56F5CA32865925E946EA"),
            (28, 0, "bitcoincash:qgagf7w02x4wnz3mkwnchut2vxphjzccwxgjvvjmlsxqwkcw59jxxuz", "3A84F9CF51AAE98A3BB3A78BF16A6183790B18719126325BFC0C075B"),
            (28, 1, "bchtest:pgagf7w02x4wnz3mkwnchut2vxphjzccwxgjvvjmlsxqwkcvs7md7wt", "3A84F9CF51AAE98A3BB3A78BF16A6183790B18719126325BFC0C075B"),
            (28, 1, "pref:pgagf7w02x4wnz3mkwnchut2vxphjzccwxgjvvjmlsxqwkcrsr6gzkn", "3A84F9CF51AAE98A3BB3A78BF16A6183790B18719126325BFC0C075B"),
            (28, 15, "prefix:0gagf7w02x4wnz3mkwnchut2vxphjzccwxgjvvjmlsxqwkc5djw8s9g", "3A84F9CF51AAE98A3BB3A78BF16A6183790B18719126325BFC0C075B"),
            (32, 0, "bitcoincash:qvch8mmxy0rtfrlarg7ucrxxfzds5pamg73h7370aa87d80gyhqxq5nlegake", "3173EF6623C6B48FFD1A3DCC0CC6489B0A07BB47A37F47CFEF4FE69DE825C060"),
            (32, 1, "bchtest:pvch8mmxy0rtfrlarg7ucrxxfzds5pamg73h7370aa87d80gyhqxq7fqng6m6", "3173EF6623C6B48FFD1A3DCC0CC6489B0A07BB47A37F47CFEF4FE69DE825C060"),
            (32, 1, "pref:pvch8mmxy0rtfrlarg7ucrxxfzds5pamg73h7370aa87d80gyhqxq4k9m7qf9", "3173EF6623C6B48FFD1A3DCC0CC6489B0A07BB47A37F47CFEF4FE69DE825C060"),
            (32, 15, "prefix:0vch8mmxy0rtfrlarg7ucrxxfzds5pamg73h7370aa87d80gyhqxqsh6jgp6w", "3173EF6623C6B48FFD1A3DCC0CC6489B0A07BB47A37F47CFEF4FE69DE825C060"),
            (40, 0, "bitcoincash:qnq8zwpj8cq05n7pytfmskuk9r4gzzel8qtsvwz79zdskftrzxtar994cgutavfklv39gr3uvz", "C07138323E00FA4FC122D3B85B9628EA810B3F381706385E289B0B25631197D194B5C238BEB136FB"),
            (40, 1, "bchtest:pnq8zwpj8cq05n7pytfmskuk9r4gzzel8qtsvwz79zdskftrzxtar994cgutavfklvmgm6ynej", "C07138323E00FA4FC122D3B85B9628EA810B3F381706385E289B0B25631197D194B5C238BEB136FB"),
            (40, 1, "pref:pnq8zwpj8cq05n7pytfmskuk9r4gzzel8qtsvwz79zdskftrzxtar994cgutavfklv0vx5z0w3", "C07138323E00FA4FC122D3B85B9628EA810B3F381706385E289B0B25631197D194B5C238BEB136FB"),
            (40, 15, "prefix:0nq8zwpj8cq05n7pytfmskuk9r4gzzel8qtsvwz79zdskftrzxtar994cgutavfklvwsvctzqy", "C07138323E00FA4FC122D3B85B9628EA810B3F381706385E289B0B25631197D194B5C238BEB136FB"),
            (48, 0, "bitcoincash:qh3krj5607v3qlqh5c3wq3lrw3wnuxw0sp8dv0zugrrt5a3kj6ucysfz8kxwv2k53krr7n933jfsunqex2w82sl", "E361CA9A7F99107C17A622E047E3745D3E19CF804ED63C5C40C6BA763696B98241223D8CE62AD48D863F4CB18C930E4C"),
            (48, 1, "bchtest:ph3krj5607v3qlqh5c3wq3lrw3wnuxw0sp8dv0zugrrt5a3kj6ucysfz8kxwv2k53krr7n933jfsunqnzf7mt6x", "E361CA9A7F99107C17A622E047E3745D3E19CF804ED63C5C40C6BA763696B98241223D8CE62AD48D863F4CB18C930E4C"),
            (48, 1, "pref:ph3krj5607v3qlqh5c3wq3lrw3wnuxw0sp8dv0zugrrt5a3kj6ucysfz8kxwv2k53krr7n933jfsunqjntdfcwg", "E361CA9A7F99107C17A622E047E3745D3E19CF804ED63C5C40C6BA763696B98241223D8CE62AD48D863F4CB18C930E4C"),
            (48, 15, "prefix:0h3krj5607v3qlqh5c3wq3lrw3wnuxw0sp8dv0zugrrt5a3kj6ucysfz8kxwv2k53krr7n933jfsunqakcssnmn", "E361CA9A7F99107C17A622E047E3745D3E19CF804ED63C5C40C6BA763696B98241223D8CE62AD48D863F4CB18C930E4C"),
            (56, 0, "bitcoincash:qmvl5lzvdm6km38lgga64ek5jhdl7e3aqd9895wu04fvhlnare5937w4ywkq57juxsrhvw8ym5d8qx7sz7zz0zvcypqscw8jd03f", "D9FA7C4C6EF56DC4FF423BAAE6D495DBFF663D034A72D1DC7D52CBFE7D1E6858F9D523AC0A7A5C34077638E4DD1A701BD017842789982041"),
            (56, 1, "bchtest:pmvl5lzvdm6km38lgga64ek5jhdl7e3aqd9895wu04fvhlnare5937w4ywkq57juxsrhvw8ym5d8qx7sz7zz0zvcypqs6kgdsg2g", "D9FA7C4C6EF56DC4FF423BAAE6D495DBFF663D034A72D1DC7D52CBFE7D1E6858F9D523AC0A7A5C34077638E4DD1A701BD017842789982041"),
            (56, 1, "pref:pmvl5lzvdm6km38lgga64ek5jhdl7e3aqd9895wu04fvhlnare5937w4ywkq57juxsrhvw8ym5d8qx7sz7zz0zvcypqsammyqffl", "D9FA7C4C6EF56DC4FF423BAAE6D495DBFF663D034A72D1DC7D52CBFE7D1E6858F9D523AC0A7A5C34077638E4DD1A701BD017842789982041"),
            (56, 15, "prefix:0mvl5lzvdm6km38lgga64ek5jhdl7e3aqd9895wu04fvhlnare5937w4ywkq57juxsrhvw8ym5d8qx7sz7zz0zvcypqsgjrqpnw8", "D9FA7C4C6EF56DC4FF423BAAE6D495DBFF663D034A72D1DC7D52CBFE7D1E6858F9D523AC0A7A5C34077638E4DD1A701BD017842789982041"),
            (64, 0, "bitcoincash:qlg0x333p4238k0qrc5ej7rzfw5g8e4a4r6vvzyrcy8j3s5k0en7calvclhw46hudk5flttj6ydvjc0pv3nchp52amk97tqa5zygg96mtky5sv5w", "D0F346310D5513D9E01E299978624BA883E6BDA8F4C60883C10F28C2967E67EC77ECC7EEEAEAFC6DA89FAD72D11AC961E164678B868AEEEC5F2C1DA08884175B"),
            (64, 1, "bchtest:plg0x333p4238k0qrc5ej7rzfw5g8e4a4r6vvzyrcy8j3s5k0en7calvclhw46hudk5flttj6ydvjc0pv3nchp52amk97tqa5zygg96mc773cwez", "D0F346310D5513D9E01E299978624BA883E6BDA8F4C60883C10F28C2967E67EC77ECC7EEEAEAFC6DA89FAD72D11AC961E164678B868AEEEC5F2C1DA08884175B"),
            (64, 1, "pref:plg0x333p4238k0qrc5ej7rzfw5g8e4a4r6vvzyrcy8j3s5k0en7calvclhw46hudk5flttj6ydvjc0pv3nchp52amk97tqa5zygg96mg7pj3lh8", "D0F346310D5513D9E01E299978624BA883E6BDA8F4C60883C10F28C2967E67EC77ECC7EEEAEAFC6DA89FAD72D11AC961E164678B868AEEEC5F2C1DA08884175B"),
            (64, 15, "prefix:0lg0x333p4238k0qrc5ej7rzfw5g8e4a4r6vvzyrcy8j3s5k0en7calvclhw46hudk5flttj6ydvjc0pv3nchp52amk97tqa5zygg96ms92w6845", "D0F346310D5513D9E01E299978624BA883E6BDA8F4C60883C10F28C2967E67EC77ECC7EEEAEAFC6DA89FAD72D11AC961E164678B868AEEEC5F2C1DA08884175B"),
        ];
        for (size, t, addr, hash) in v {
            let hash = hex::decode(hash).unwrap();
            assert_eq!(hash.len(), *size);
            let prefix = addr.split(':').next().unwrap();
            assert_eq!(encode_raw(prefix, *t, &hash).unwrap(), *addr);
            assert_eq!(
                decode_raw(addr, prefix).unwrap(),
                (*t, hash.clone()),
                "{addr}"
            );
            assert_eq!(decode_raw(&addr.to_uppercase(), prefix).unwrap().1, hash);
            // One flipped character: checksum failure.
            let mut bad: Vec<char> = addr.chars().collect();
            let i = bad.len() - 3;
            bad[i] = if bad[i] == 'q' { 'p' } else { 'q' };
            let bad: String = bad.into_iter().collect();
            assert_eq!(decode_raw(&bad, prefix), Err(DecodeError::Invalid), "{bad}");
        }
    }

    #[test]
    fn prefix_case_padding_and_types() {
        let h = [0x5au8; 20];
        let a = encode("bitcoincash", CashKind::P2pkh, &h).unwrap();
        assert_eq!(decode(&a, "bitcoincash").unwrap(), (CashKind::P2pkh, h));
        let bare = a.trim_start_matches("bitcoincash:");
        assert_eq!(decode(bare, "bitcoincash").unwrap().1, h);
        assert_eq!(
            decode(&a, "bchtest").unwrap_err(),
            DecodeError::OtherPrefix("bitcoincash".into())
        );
        // Without its prefix, a mainnet string checked as testnet fails the checksum.
        assert_eq!(decode(bare, "bchtest").unwrap_err(), DecodeError::Invalid);
        // Mixed case.
        let mixed = format!("bitcoincash:{}", bare.to_uppercase());
        assert_eq!(
            decode(&mixed, "bitcoincash").unwrap_err(),
            DecodeError::Invalid
        );
        // Type 15 and 32-byte hashes (P2SH32) are valid CashAddr but not P2PKH / P2SH.
        let t15 = encode_raw("bitcoincash", 15, &h).unwrap();
        assert_eq!(
            decode(&t15, "bitcoincash").unwrap_err(),
            DecodeError::Invalid
        );
        let p2sh32 = encode_raw("bitcoincash", 1, &[7u8; 32]).unwrap();
        assert_eq!(
            decode(&p2sh32, "bitcoincash").unwrap_err(),
            DecodeError::Invalid
        );
        // Token-aware types 2 / 3 are the same scripts.
        let z = encode_raw("bitcoincash", 2, &h).unwrap();
        assert!(z.starts_with("bitcoincash:z"));
        assert_eq!(decode(&z, "bitcoincash").unwrap(), (CashKind::P2pkh, h));
        let r = encode_raw("bitcoincash", 3, &h).unwrap();
        assert_eq!(decode(&r, "bitcoincash").unwrap(), (CashKind::P2sh, h));
        // Garbage.
        for g in ["", "bitcoincash:", "bitcoincash:b", "bitcoincash:qqqqqqqq"] {
            assert!(decode(g, "bitcoincash").is_err(), "{g:?}");
        }
    }
}
