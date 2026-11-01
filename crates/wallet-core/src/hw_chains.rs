//! Hardware-wallet signatures for XRP and Stellar: a device returns only a signature over the
//! transaction Kyro built; it is checked here against the stored public key and Kyro's own
//! signing hash, then attached to Kyro's unsigned transaction (never to whatever the device
//! may have serialized). TRON needs nothing here: `tron_recover_signer` +
//! `tron_signed_transaction` already do it.

use bitcoin::secp256k1::{ecdsa::Signature, Message, PublicKey, Secp256k1};

use crate::error::{Error, Result};
use crate::network::Network;
use crate::stellar::{StellarEnvelope, StellarSignature};
use crate::xrp::XrpPayment;

fn bad(msg: &str) -> Error {
    Error::input(msg.to_string())
}

/// Attaches a device's DER signature to an unsigned XRP Payment blob (hex). The blob's
/// `SigningPubKey` must be `pubkey` and its `Account` that key's address; the signature is
/// normalised to low-S (the XRP Ledger's canonical form, equally valid) and must verify over
/// the blob's signing hash. Returns `(signed blob hex, transaction hash hex)`.
pub fn xrp_hw_assemble(blob_hex: &str, pubkey: &[u8; 33], der: &[u8]) -> Result<(String, String)> {
    let raw = hex::decode(blob_hex.trim()).map_err(|_| bad("blob: hexadecimal expected"))?;
    let mut p = XrpPayment::decode(&raw)?;
    if p.txn_signature.is_some() {
        return Err(bad("blob already signed"));
    }
    if p.signing_pub_key.as_deref() != Some(&pubkey[..]) {
        return Err(bad("SigningPubKey is not this account's key"));
    }
    if crate::xrp::xrp_address_of_pubkey(pubkey)? != crate::xrp::xrp_address_from_id(&p.account) {
        return Err(bad("Account is not this key's address"));
    }
    let pk = PublicKey::from_slice(pubkey).map_err(|_| bad("invalid public key"))?;
    let mut sig = Signature::from_der(der).map_err(|_| bad("signature: invalid DER"))?;
    sig.normalize_s();
    Secp256k1::verification_only()
        .verify_ecdsa(&Message::from_digest(p.signing_hash()), &sig, &pk)
        .map_err(|_| Error::crypto("the device's signature does not verify"))?;
    p.txn_signature = Some(sig.serialize_der().to_vec());
    let signed = hex::encode_upper(p.encode(true));
    let hash = crate::xrp::xrp_verify_signed(&signed)?;
    Ok((signed, hash))
}

/// Attaches a device's ed25519 signature to an unsigned Stellar envelope (base64) for `net`.
/// The transaction's source must be `pubkey` and the signature must verify (strictly) over
/// Kyro's transaction hash on `net`. Returns `(signed envelope base64, hash hex)`.
pub fn stellar_hw_assemble(
    envelope_b64: &str,
    net: Network,
    pubkey: &[u8; 32],
    signature: &[u8],
) -> Result<(String, String)> {
    let mut env = StellarEnvelope::from_base64(envelope_b64)?;
    if !env.signatures.is_empty() {
        return Err(bad("envelope already signed"));
    }
    if &env.tx.source != pubkey {
        return Err(bad("the source account is not this account's key"));
    }
    let sig: [u8; 64] = signature
        .try_into()
        .map_err(|_| bad("signature: 64 bytes expected"))?;
    let vk = ed25519_dalek::VerifyingKey::from_bytes(pubkey).map_err(|_| bad("invalid key"))?;
    let hash = env.tx.hash(net);
    vk.verify_strict(&hash, &ed25519_dalek::Signature::from_bytes(&sig))
        .map_err(|_| Error::crypto("the device's signature does not verify"))?;
    let mut hint = [0u8; 4];
    hint.copy_from_slice(&pubkey[28..]);
    env.signatures = vec![StellarSignature {
        hint,
        signature: sig.to_vec(),
    }];
    let signed = env.to_base64();
    let h = crate::stellar::stellar_verify_signed(&signed, net)?;
    Ok((signed, h))
}

/// The bytes the Ledger Stellar app signs: `TransactionSignaturePayload` (network id ‖
/// `ENVELOPE_TYPE_TX` ‖ transaction XDR) of an unsigned envelope.
pub fn stellar_signature_base(envelope_b64: &str, net: Network) -> Result<Vec<u8>> {
    Ok(StellarEnvelope::from_base64(envelope_b64)?
        .tx
        .signature_payload(net))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mnemonic::Mnemonic;

    const ABANDON: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    #[test]
    fn stellar_device_signature_is_checked_and_attached() {
        let seed = Mnemonic::parse(ABANDON).unwrap().to_seed("");
        let pk = crate::stellar::stellar_public_key(&seed, 0).unwrap();
        let tx = crate::stellar::StellarTransaction {
            source: pk,
            fee: 100,
            sequence: 42,
            time_bounds: Some((0, 1_900_000_000)),
            memo: crate::stellar::StellarMemo::Id(7),
            operations: vec![crate::stellar::StellarOp {
                source: None,
                body: crate::stellar::StellarOperation::Payment {
                    destination: [9u8; 32],
                    asset: crate::stellar::StellarAsset::Native,
                    amount: 10_000_000,
                },
            }],
        };
        let env = StellarEnvelope {
            tx,
            signatures: Vec::new(),
        }
        .to_base64();
        let net = Network::Testnet;
        let (soft, hash, _) = crate::stellar::stellar_sign(&seed, 0, &env, net).unwrap();
        let soft_env = StellarEnvelope::from_base64(&soft).unwrap();
        let sig = soft_env.signatures[0].signature.clone();
        let (hw, h) = stellar_hw_assemble(&env, net, &pk, &sig).unwrap();
        assert_eq!((hw, h), (soft, hash));
        // Same signature on the other network, tampered, or for another key: refused.
        assert!(stellar_hw_assemble(&env, Network::Mainnet, &pk, &sig).is_err());
        let mut bad = sig.clone();
        bad[3] ^= 1;
        assert!(stellar_hw_assemble(&env, net, &pk, &bad).is_err());
        assert!(stellar_hw_assemble(&env, net, &[1u8; 32], &sig).is_err());
        // The Ledger payload starts with SHA-256(passphrase), then ENVELOPE_TYPE_TX = 2.
        let base = stellar_signature_base(&env, net).unwrap();
        use sha2::Digest;
        let id = sha2::Sha256::digest(crate::stellar::STELLAR_TESTNET_PASSPHRASE);
        assert_eq!(&base[..32], id.as_slice());
        assert_eq!(&base[32..36], &[0, 0, 0, 2]);
    }

    #[test]
    fn xrp_device_signature_is_checked_and_attached() {
        let seed = Mnemonic::parse(ABANDON).unwrap().to_seed("");
        let pk = crate::xrp::xrp_public_key(&seed, 0).unwrap();
        let me = crate::xrp::xrp_address(&seed, 0).unwrap();
        let p = XrpPayment {
            flags: Some(crate::xrp::TF_FULLY_CANONICAL_SIG),
            source_tag: None,
            sequence: 5,
            destination_tag: Some(1),
            last_ledger_sequence: Some(1_000),
            invoice_id: None,
            amount: crate::xrp::XrpAmount::Xrp(1_000_000),
            fee: 12,
            send_max: None,
            signing_pub_key: Some(pk.to_vec()),
            txn_signature: None,
            account: crate::xrp::xrp_account_id(&me).unwrap(),
            destination: crate::xrp::xrp_account_id("rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY").unwrap(),
            memos: Vec::new(),
        };
        let blob = hex::encode_upper(p.encode(false));
        let (soft, hash, _) = crate::xrp::xrp_sign(&seed, 0, &blob).unwrap();
        let der = XrpPayment::decode(&hex::decode(&soft).unwrap())
            .unwrap()
            .txn_signature
            .unwrap();
        assert_eq!(xrp_hw_assemble(&blob, &pk, &der).unwrap(), (soft, hash));
        let mut bad = der.clone();
        let n = bad.len();
        bad[n - 3] ^= 1;
        assert!(xrp_hw_assemble(&blob, &pk, &bad).is_err());
        let other = crate::xrp::xrp_public_key(&seed, 1).unwrap();
        assert!(xrp_hw_assemble(&blob, &other, &der).is_err());
    }
}
