//! Solana: SLIP-10 ed25519 derivation at `m/44'/501'/account'/0'` (Phantom / Solflare
//! convention) and ed25519 message signing.

use ed25519_dalek::Signer as _;
use ed25519_dalek_bip32::{ChildIndex, ExtendedSigningKey};
use zeroize::Zeroize;

use crate::error::{Error, Result};
use crate::mnemonic::Seed;

fn hardened(index: u32) -> Result<ChildIndex> {
    ChildIndex::hardened(index).map_err(|_| Error::input("derivation index must be < 2^31"))
}

fn signing_key(seed: &Seed, account: u32) -> Result<ed25519_dalek::SigningKey> {
    let path = [
        hardened(44)?,
        hardened(501)?,
        hardened(account)?,
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

/// Base58 Solana address (ed25519 public key) at `m/44'/501'/account'/0'`.
pub fn sol_address(seed: &Seed, account: u32) -> Result<String> {
    let key = signing_key(seed, account)?;
    Ok(bs58::encode(key.verifying_key().as_bytes()).into_string())
}

/// Ed25519 signature over the raw `message` bytes (a serialized Solana transaction message).
pub fn sol_sign_message(seed: &Seed, account: u32, message: &[u8]) -> Result<[u8; 64]> {
    if message.is_empty() {
        return Err(Error::input("message must not be empty"));
    }
    let key = signing_key(seed, account)?;
    let signature = key.sign(message);
    key.verifying_key()
        .verify_strict(message, &signature)
        .map_err(|_| Error::crypto("signature self-check failed"))?;
    Ok(signature.to_bytes())
}

/// Base58 address of a raw 32-byte ed25519 public key (as returned by a hardware wallet).
pub fn sol_address_of_pubkey(pubkey: &[u8]) -> Result<String> {
    let bytes: [u8; 32] = pubkey
        .try_into()
        .map_err(|_| Error::input("ed25519 public key must be 32 bytes"))?;
    ed25519_dalek::VerifyingKey::from_bytes(&bytes)
        .map_err(|_| Error::input("invalid ed25519 public key"))?;
    Ok(bs58::encode(bytes).into_string())
}

/// Verifies (strictly: canonical `S`, no small-order key) a 64-byte ed25519 signature returned
/// by a hardware wallet over `message`, against the expected base58 `address`.
pub fn sol_verify_signature(address: &str, message: &[u8], signature: &[u8]) -> Result<[u8; 64]> {
    let key: [u8; 32] = bs58::decode(address.trim())
        .into_vec()
        .ok()
        .and_then(|v| v.try_into().ok())
        .ok_or_else(|| Error::input("invalid Solana address"))?;
    let key = ed25519_dalek::VerifyingKey::from_bytes(&key)
        .map_err(|_| Error::input("invalid Solana address"))?;
    let sig: [u8; 64] = signature
        .try_into()
        .map_err(|_| Error::Device("ed25519 signature must be 64 bytes".into()))?;
    key.verify_strict(message, &ed25519_dalek::Signature::from_bytes(&sig))
        .map_err(|_| Error::Device("signature does not verify for this address".into()))?;
    Ok(sig)
}
