//! Sui: SLIP-10 ed25519 keys at `m/44'/784'/account'/0'/0'` (the path of Sui Wallet / Slush,
//! `sui keytool` and the official SDKs; account 0 = their default `m/44'/784'/0'/0'/0'`) and
//! `0x…` addresses.

use blake2::digest::{consts::U32, Digest};
use blake2::Blake2b;
use ed25519_dalek_bip32::{ChildIndex, ExtendedSigningKey};
use zeroize::Zeroize;

use crate::error::{Error, Result};
use crate::mnemonic::Seed;

/// Signature scheme flag of ed25519 (first byte of an address preimage and of a signature).
pub const SUI_ED25519_FLAG: u8 = 0x00;

pub(crate) fn blake2b256(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Blake2b::<U32>::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

/// Digest of an object: BLAKE2b-256 of `Object::` and its BCS, as in its object reference.
pub fn sui_object_digest(object_bcs: &[u8]) -> [u8; 32] {
    blake2b256(&[b"Object::", object_bcs])
}

fn hardened(index: u32) -> Result<ChildIndex> {
    ChildIndex::hardened(index).map_err(|_| Error::input("derivation index must be < 2^31"))
}

/// Path of Sui account `account`: `m/44'/784'/account'/0'/0'` (every level hardened, SLIP-10).
pub fn sui_path(account: u32) -> String {
    format!("m/44'/784'/{account}'/0'/0'")
}

pub(crate) fn signing_key(seed: &Seed, account: u32) -> Result<ed25519_dalek::SigningKey> {
    let path = [
        hardened(44)?,
        hardened(784)?,
        hardened(account)?,
        hardened(0)?,
        hardened(0)?,
    ];
    let root = ExtendedSigningKey::from_seed(&seed[..])
        .map_err(|_| Error::crypto("SLIP-10 master derivation failed"))?;
    let mut child = root
        .derive(&path)
        .map_err(|_| Error::crypto("SLIP-10 derivation failed"))?;
    // `SigningKey` zeroizes itself on drop; the chain codes do not, so wipe them here.
    let mut root = root;
    root.chain_code.zeroize();
    child.chain_code.zeroize();
    Ok(child.signing_key.clone())
}

/// 32-byte account address of an ed25519 public key.
pub fn sui_address_bytes_of_pubkey(pubkey: &[u8; 32]) -> [u8; 32] {
    blake2b256(&[&[SUI_ED25519_FLAG], pubkey])
}

/// `0x` + 64 lower-case hex characters.
pub fn sui_address_string(bytes: &[u8; 32]) -> String {
    format!("0x{}", hex::encode(bytes))
}

/// Address of a raw 32-byte ed25519 public key. Fails if the bytes are not a valid curve point.
pub fn sui_address_of_pubkey(pubkey: &[u8]) -> Result<String> {
    let bytes: [u8; 32] = pubkey
        .try_into()
        .map_err(|_| Error::input("ed25519 public key: 32 bytes expected"))?;
    ed25519_dalek::VerifyingKey::from_bytes(&bytes)
        .map_err(|_| Error::input("invalid ed25519 public key"))?;
    Ok(sui_address_string(&sui_address_bytes_of_pubkey(&bytes)))
}

/// Public key of account `account` (`m/44'/784'/account'/0'/0'`).
pub fn sui_public_key(seed: &Seed, account: u32) -> Result<[u8; 32]> {
    Ok(signing_key(seed, account)?.verifying_key().to_bytes())
}

/// Address of account `account` (`m/44'/784'/account'/0'/0'`, see [`sui_path`]).
pub fn sui_address(seed: &Seed, account: u32) -> Result<String> {
    Ok(sui_address_string(&sui_address_bytes_of_pubkey(
        &sui_public_key(seed, account)?,
    )))
}

/// Parses a recipient address: `0x` followed by exactly 64 hexadecimal characters (either case).
pub fn sui_parse_address(address: &str) -> Result<[u8; 32]> {
    let a = address.trim();
    if a.ends_with(".sui") || a.starts_with('@') {
        return Err(Error::input(
            "SuiNS names are not supported: paste the full 0x… address",
        ));
    }
    let h = a.strip_prefix("0x").ok_or_else(|| {
        Error::input("invalid Sui address: 0x followed by 64 hexadecimal characters expected")
    })?;
    if h.len() != 64 {
        return Err(Error::input(
            "invalid Sui address: 64 hexadecimal characters expected after 0x (short form refused)",
        ));
    }
    let mut out = [0u8; 32];
    hex::decode_to_slice(h, &mut out)
        .map_err(|_| Error::input("invalid Sui address (non-hexadecimal character)"))?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_addresses() {
        let a = "0xa2d14fad60c56049ecf75246a481934691214ce413e6a8ae2fe6834c173a6133";
        assert_eq!(sui_address_string(&sui_parse_address(a).unwrap()), a);
        assert_eq!(
            sui_address_string(&sui_parse_address(&a.to_uppercase().replace("0X", "0x")).unwrap()),
            a
        );
        for bad in [
            "0x2",
            "a2d14fad60c56049ecf75246a481934691214ce413e6a8ae2fe6834c173a6133",
            "0xa2d14fad60c56049ecf75246a481934691214ce413e6a8ae2fe6834c173a61",
            "0xg2d14fad60c56049ecf75246a481934691214ce413e6a8ae2fe6834c173a6133",
            "kyro.sui",
            "@kyro",
            "",
        ] {
            assert!(sui_parse_address(bad).is_err(), "{bad}");
        }
    }
}
