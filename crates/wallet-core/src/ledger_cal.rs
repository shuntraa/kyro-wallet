//! Ledger ERC-20 token descriptors (Ethereum app, PROVIDE ERC 20 TOKEN INFORMATION, legacy
//! format `P1 = 00`), so that a Ledger can *clear sign* ERC-20 transfers and approvals.

use bitcoin::hashes::{sha256, Hash};
use bitcoin::secp256k1::{ecdsa, Message, PublicKey, Secp256k1};

use crate::error::{Error, Result};

/// Ledger's ERC-20 descriptor signing key (uncompressed SEC1), as published in the spec.
pub const LEDGER_ERC20_SIGNER: &str = "045e6c1020c14dc46442fe89f97c0b68cdb15976dc24f24c316e7b30fe4e8cc76b1489150c21514ebf440ff5dea5393d83de5358cd098fce8fd0f81daa94979183";

/// A signed token descriptor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LedgerErc20Descriptor {
    /// EIP-155 chain id (legacy format: must fit in 32 bits).
    pub chain_id: u64,
    /// Token contract (20 bytes).
    pub contract: [u8; 20],
    /// Ticker shown on the device.
    pub ticker: String,
    /// Decimals.
    pub decimals: u8,
    /// DER signature by [`LEDGER_ERC20_SIGNER`].
    pub signature: Vec<u8>,
}

const BUNDLED: &[(u64, &str, &str, u8, &str)] = &[
    (
        1,
        "a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        "USDC",
        6,
        "3045022100b2e358726e4e6a6752cf344017c0e9d45b9a904120758d45f61b2804f9ad5299022015161ef28d8c4481bd9432c13562def9cce688bcfec896ef244c9a213f106cdd",
    ),
    (
        1,
        "dac17f958d2ee523a2206206994597c13d831ec7",
        "USDT",
        6,
        "3044022078c66ccea3e4dedb15a24ec3c783d7b582cd260daf62fd36afe9a8212a344aed0220160ba8c1c4b6a8aa6565bed20632a091aeeeb7bfdac67fc6589a6031acbf511c",
    ),
    (
        11_155_111,
        "1c7d4b196cb0c7b01d743fbc6116a902379c7238",
        // The signed ticker is "ttUSDC" (CAL's `descriptor.data`), not the "tUSDC" display name.
        "ttUSDC",
        6,
        "3045022100ba11d54a11392c97812c834d21145308b9b82c9369d08aeeefde31de25a5f5fb022048af074f679bc0e7cd55881db27b4a072222771f12ba87cc032bdee3b158596b",
    ),
];

fn contract_bytes(contract: &str) -> Option<[u8; 20]> {
    let h = contract.trim();
    let h = h
        .strip_prefix("0x")
        .or_else(|| h.strip_prefix("0X"))
        .unwrap_or(h);
    let mut out = [0u8; 20];
    hex::decode_to_slice(h.to_ascii_lowercase(), &mut out).ok()?;
    Some(out)
}

/// The bundled descriptor for `(chain_id, contract)`, if Kyro ships one.
pub fn ledger_erc20_lookup(chain_id: u64, contract: &str) -> Option<LedgerErc20Descriptor> {
    let wanted = contract_bytes(contract)?;
    BUNDLED.iter().find_map(|(c, addr, ticker, decimals, sig)| {
        if *c != chain_id || contract_bytes(addr) != Some(wanted) {
            return None;
        }
        Some(LedgerErc20Descriptor {
            chain_id: *c,
            contract: wanted,
            ticker: (*ticker).to_string(),
            decimals: *decimals,
            signature: hex::decode(sig).ok()?,
        })
    })
}

fn signed_data(d: &LedgerErc20Descriptor) -> Result<Vec<u8>> {
    let chain = u32::try_from(d.chain_id)
        .map_err(|_| Error::input("chain id does not fit the legacy descriptor format"))?;
    if d.ticker.is_empty() || d.ticker.len() > 32 || !d.ticker.is_ascii() {
        return Err(Error::input("invalid ticker"));
    }
    let mut data = Vec::with_capacity(d.ticker.len() + 28);
    data.extend_from_slice(d.ticker.as_bytes());
    data.extend_from_slice(&d.contract);
    data.extend_from_slice(&u32::from(d.decimals).to_be_bytes());
    data.extend_from_slice(&chain.to_be_bytes());
    Ok(data)
}

/// Checks the descriptor's signature against [`LEDGER_ERC20_SIGNER`] (libsecp256k1).
pub fn ledger_erc20_verify(d: &LedgerErc20Descriptor) -> Result<()> {
    let data = signed_data(d)?;
    let key = hex::decode(LEDGER_ERC20_SIGNER)
        .ok()
        .and_then(|k| PublicKey::from_slice(&k).ok())
        .ok_or_else(|| Error::crypto("invalid built-in Ledger key"))?;
    let mut sig = ecdsa::Signature::from_der(&d.signature)
        .map_err(|_| Error::input("malformed descriptor signature"))?;
    // Authenticity only: S-malleability is irrelevant here, libsecp256k1 wants low-S.
    sig.normalize_s();
    let digest = sha256::Hash::hash(&data).to_byte_array();
    Secp256k1::verification_only()
        .verify_ecdsa(&Message::from_digest(digest), &sig, &key)
        .map_err(|_| Error::input("descriptor is not signed by Ledger"))
}

/// APDU data for PROVIDE ERC 20 TOKEN INFORMATION (legacy): `len(ticker) || ticker ||
/// address || decimals (u32 BE) || chainId (u32 BE) || signature`.
pub fn ledger_erc20_payload(d: &LedgerErc20Descriptor) -> Result<Vec<u8>> {
    ledger_erc20_verify(d)?;
    let data = signed_data(d)?;
    let mut out = Vec::with_capacity(1 + data.len() + d.signature.len());
    out.push(d.ticker.len() as u8);
    out.extend_from_slice(&data);
    out.extend_from_slice(&d.signature);
    if out.len() > 255 {
        return Err(Error::input("descriptor too long for one APDU"));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every bundled descriptor verifies against Ledger's documented key, and the signed data
    /// matches the `descriptor.data` field returned by the CAL service.
    #[test]
    fn bundled_descriptors_verify() {
        let cal_data = [
            "55534443a0b86991c6218b36c1d19d4a2e9eb0ce3606eb480000000600000001",
            "55534454dac17f958d2ee523a2206206994597c13d831ec70000000600000001",
            "7474555344431c7d4b196cb0c7b01d743fbc6116a902379c72380000000600aa36a7",
        ];
        for ((chain, addr, ..), expected) in BUNDLED.iter().zip(cal_data) {
            let d = ledger_erc20_lookup(*chain, &format!("0x{}", addr.to_uppercase())).unwrap();
            assert_eq!(hex::encode(signed_data(&d).unwrap()), expected);
            ledger_erc20_verify(&d).unwrap();
            let p = ledger_erc20_payload(&d).unwrap();
            assert_eq!(p[0] as usize, d.ticker.len());
            assert_eq!(hex::encode(&p[1..1 + expected.len() / 2]), expected);
        }
    }

    #[test]
    fn tampered_descriptor_is_rejected() {
        let usdc = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
        let mut d = ledger_erc20_lookup(1, usdc).unwrap();
        d.decimals = 18;
        assert!(ledger_erc20_verify(&d).is_err());
        let mut d = ledger_erc20_lookup(1, usdc).unwrap();
        d.chain_id = 11_155_111; // replaying a mainnet descriptor on Sepolia
        assert!(ledger_erc20_verify(&d).is_err());
        let mut d = ledger_erc20_lookup(1, usdc).unwrap();
        d.ticker = "USDT".into();
        assert!(ledger_erc20_payload(&d).is_err());
        assert!(ledger_erc20_lookup(5, usdc).is_none());
        assert!(ledger_erc20_lookup(1, "0x00").is_none());
    }
}
