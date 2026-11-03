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

const SOL_ATA_PROGRAM: &str = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

fn sol_key(s: &str) -> Result<[u8; 32]> {
    bs58::decode(s.trim())
        .into_vec()
        .ok()
        .and_then(|v| v.try_into().ok())
        .ok_or_else(|| Error::input("invalid Solana address"))
}

/// Associated token account of `owner` for `mint` under `token_program` (base58 in and out):
/// `find_program_address([owner, token_program, mint], ATA program)`.
pub fn sol_associated_token_address(
    owner: &str,
    mint: &str,
    token_program: &str,
) -> Result<String> {
    use sha2::Digest as _;
    let (owner, program, mint, ata) = (
        sol_key(owner)?,
        sol_key(token_program)?,
        sol_key(mint)?,
        sol_key(SOL_ATA_PROGRAM)?,
    );
    for bump in (0..=255u8).rev() {
        let mut h = sha2::Sha256::new();
        for s in [&owner[..], &program[..], &mint[..], &[bump][..]] {
            h.update(s);
        }
        h.update(ata);
        h.update(b"ProgramDerivedAddress");
        let k: [u8; 32] = h.finalize().into();
        if curve25519_dalek::edwards::CompressedEdwardsY(k)
            .decompress()
            .is_none()
        {
            return Ok(bs58::encode(k).into_string());
        }
    }
    Err(Error::input("no associated token address"))
}

#[cfg(test)]
mod ata_tests {
    use super::*;

    #[test]
    fn ata_matches_devnet_vector() {
        // Same vector as packages/chains/test/solana.test.ts (a real devnet token account).
        let wallet = "Cf9abfrZbkkcKthpkKqwmA8H3LiGtGZ2ZL8NsfQzYLQP";
        let mint = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
        let token = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
        let ata = sol_associated_token_address(wallet, mint, token).unwrap();
        assert_eq!(ata, "5iv62nJJJHsV7pgJcA3sf9kp98uWaQcjyKtxFZ5dEbcW");
        let t22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
        assert_ne!(
            sol_associated_token_address(wallet, mint, t22).unwrap(),
            ata
        );
        assert!(sol_associated_token_address("bad", mint, token).is_err());
    }
}
