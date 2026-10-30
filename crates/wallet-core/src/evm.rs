//! EVM: `m/44'/60'/0'/0/i` addresses (EIP-55), EIP-1559 signing and calldata decoding.
//!
//! - ECDSA: libsecp256k1 (`bitcoin::secp256k1`, constant-time, RFC6979, low-S).
//! - Keccak-256: RustCrypto `sha3`.
//! - RLP: `alloy-rlp` primitives; the EIP-1559 field layout is checked against a real
//!   mainnet transaction in the unit tests.
//!
//! The RustCrypto `k256`/`crypto-bigint` stack is deliberately absent from the dependency graph.

use alloy_rlp::{Encodable, Header};
use bitcoin::secp256k1::{All, Message, PublicKey, Secp256k1};
use serde::{Deserialize, Serialize};
use sha3::{Digest, Keccak256};

use crate::error::{Error, Result};
use crate::keys::{hardened, normal, secp, XprivGuard};
use crate::mnemonic::Seed;

#[allow(clippy::all, clippy::pedantic, missing_docs, unexpected_cfgs)]
mod u256 {
    uint::construct_uint! {
        /// 256-bit unsigned integer.
        pub struct U256(4);
    }
}
use u256::U256;

const SELECTOR_TRANSFER: [u8; 4] = [0xa9, 0x05, 0x9c, 0xbb];
const SELECTOR_APPROVE: [u8; 4] = [0x09, 0x5e, 0xa7, 0xb3];
const EIP1559_TX_TYPE: u8 = 0x02;

fn keccak256(data: &[u8]) -> [u8; 32] {
    Keccak256::digest(data).into()
}

/// 20-byte account address.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Address([u8; 20]);

impl Address {
    /// `keccak256(uncompressed_pubkey[1..65])[12..32]`.
    fn from_pubkey(pk: &PublicKey) -> Self {
        let uncompressed = pk.serialize_uncompressed(); // 0x04 || X || Y
        let hash = keccak256(&uncompressed[1..]);
        let mut a = [0u8; 20];
        a.copy_from_slice(&hash[12..]);
        Address(a)
    }

    fn from_word(word: &[u8]) -> Option<Self> {
        // ABI-encoded address: 12 zero bytes then 20 address bytes.
        if word.len() != 32 || word[..12].iter().any(|b| *b != 0) {
            return None;
        }
        let mut a = [0u8; 20];
        a.copy_from_slice(&word[12..]);
        Some(Address(a))
    }

    /// EIP-55 mixed-case checksum encoding.
    fn to_checksum(self) -> String {
        let lower = hex::encode(self.0);
        let hash = keccak256(lower.as_bytes());
        let mut out = String::with_capacity(42);
        out.push_str("0x");
        for (i, c) in lower.chars().enumerate() {
            let nibble = if i % 2 == 0 {
                hash[i / 2] >> 4
            } else {
                hash[i / 2] & 0x0f
            };
            out.push(if nibble >= 8 {
                c.to_ascii_uppercase()
            } else {
                c
            });
        }
        out
    }
}

/// Unsigned EIP-1559 transaction as requested by the frontend. Amounts are decimal strings
/// in wei; `data` is `0x`-prefixed hex (empty or `0x` for none).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvmTxRequest {
    /// EIP-155 chain id (1 = mainnet, 11155111 = Sepolia, ...).
    pub chain_id: u64,
    /// Sender nonce.
    pub nonce: u64,
    /// Recipient / contract, `0x` + 40 hex. Contract creation is not supported.
    pub to: String,
    /// Native value in wei (decimal string).
    pub value_wei: String,
    /// Calldata, `0x`-prefixed hex.
    pub data: String,
    /// Gas limit.
    pub gas_limit: u64,
    /// Max fee per gas in wei (decimal string).
    pub max_fee_per_gas: String,
    /// Max priority fee per gas in wei (decimal string).
    pub max_priority_fee_per_gas: String,
}

/// What a transaction does, as far as the core can tell.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum EvmTxKind {
    /// Plain native-coin transfer (empty calldata).
    NativeTransfer,
    /// ERC-20 `transfer(address,uint256)`.
    Erc20Transfer,
    /// ERC-20 `approve(address,uint256)`.
    Erc20Approve,
    /// Any other contract interaction.
    ContractCall,
}

/// Plain-language summary of an [`EvmTxRequest`]. Addresses are EIP-55 checksummed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvmTxSummary {
    /// Detected kind.
    pub kind: EvmTxKind,
    /// Beneficiary: the recipient for transfers (token recipient for ERC-20 transfers),
    /// the called contract for approvals and contract calls.
    pub to: String,
    /// The ERC-20 contract, for `Erc20Transfer` / `Erc20Approve`.
    pub token_contract: Option<String>,
    /// Token amount (raw units) for ERC-20 kinds, native value in wei otherwise.
    pub amount: String,
    /// Spender, for `Erc20Approve`.
    pub spender: Option<String>,
    /// `true` for an approval of at least 2^255 (including `uint256::MAX`).
    pub unlimited_approval: bool,
    /// Worst-case fee: `gas_limit * max_fee_per_gas`, in wei.
    pub max_fee_wei: String,
    /// Chain id.
    pub chain_id: u64,
    /// Native value attached to the transaction, in wei (always present, even for ERC-20 calls).
    pub value_wei: String,
}

fn parse_decimal_u256(field: &str, s: &str) -> Result<U256> {
    if s.is_empty() || s.len() > 78 || !s.bytes().all(|b| b.is_ascii_digit()) {
        return Err(Error::input(format!(
            "{field} must be a decimal integer string"
        )));
    }
    U256::from_dec_str(s).map_err(|_| Error::input(format!("{field} overflows uint256")))
}

fn parse_decimal_u128(field: &str, s: &str) -> Result<u128> {
    if s.is_empty() || s.len() > 39 || !s.bytes().all(|b| b.is_ascii_digit()) {
        return Err(Error::input(format!(
            "{field} must be a decimal integer string"
        )));
    }
    s.parse::<u128>()
        .map_err(|_| Error::input(format!("{field} overflows uint128")))
}

/// Parses `0x` + 40 hex chars. Mixed-case input must carry a valid EIP-55 checksum.
fn parse_address(s: &str) -> Result<Address> {
    let hex_part = s
        .strip_prefix("0x")
        .or_else(|| s.strip_prefix("0X"))
        .ok_or_else(|| Error::input("address must start with 0x"))?;
    if hex_part.len() != 40 || !hex_part.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(Error::input("address must be 20 bytes of hex"));
    }
    let mut bytes = [0u8; 20];
    hex::decode_to_slice(hex_part, &mut bytes).map_err(|_| Error::input("invalid address"))?;
    let addr = Address(bytes);
    let has_lower = hex_part.bytes().any(|b| b.is_ascii_lowercase());
    let has_upper = hex_part.bytes().any(|b| b.is_ascii_uppercase());
    if has_lower && has_upper && addr.to_checksum()[2..] != *hex_part {
        return Err(Error::input("address has an invalid EIP-55 checksum"));
    }
    Ok(addr)
}

fn parse_data(s: &str) -> Result<Vec<u8>> {
    let hex_part = s
        .strip_prefix("0x")
        .or_else(|| s.strip_prefix("0X"))
        .unwrap_or(s);
    hex::decode(hex_part).map_err(|_| Error::input("data must be 0x-prefixed hex"))
}

/// Validated EIP-1559 transaction fields.
struct Eip1559 {
    chain_id: u64,
    nonce: u64,
    max_priority_fee_per_gas: u128,
    max_fee_per_gas: u128,
    gas_limit: u64,
    to: Address,
    value: U256,
    data: Vec<u8>,
}

/// ECDSA signature in EIP-1559 form.
struct EcdsaSig {
    y_parity: bool,
    r: [u8; 32],
    s: [u8; 32],
}

/// Big-endian bytes without leading zeros (RLP integer encoding; zero becomes empty).
fn trim_be(bytes: &[u8]) -> &[u8] {
    let first = bytes.iter().position(|b| *b != 0).unwrap_or(bytes.len());
    &bytes[first..]
}

impl Eip1559 {
    /// RLP list payload: `chain_id, nonce, max_priority_fee_per_gas, max_fee_per_gas,
    /// gas_limit, to, value, data, access_list (empty) [, y_parity, r, s]`.
    fn payload(&self, sig: Option<&EcdsaSig>) -> Vec<u8> {
        let mut out = Vec::new();
        self.chain_id.encode(&mut out);
        self.nonce.encode(&mut out);
        self.max_priority_fee_per_gas.encode(&mut out);
        self.max_fee_per_gas.encode(&mut out);
        self.gas_limit.encode(&mut out);
        self.to.0.as_slice().encode(&mut out);
        trim_be(&self.value.to_big_endian()).encode(&mut out);
        self.data.as_slice().encode(&mut out);
        Header {
            list: true,
            payload_length: 0,
        }
        .encode(&mut out); // empty access list
        if let Some(sig) = sig {
            u8::from(sig.y_parity).encode(&mut out);
            trim_be(&sig.r).encode(&mut out);
            trim_be(&sig.s).encode(&mut out);
        }
        out
    }

    /// EIP-2718 typed envelope: `0x02 || rlp(list)`.
    fn envelope(&self, sig: Option<&EcdsaSig>) -> Vec<u8> {
        let payload = self.payload(sig);
        let mut out = vec![EIP1559_TX_TYPE];
        Header {
            list: true,
            payload_length: payload.len(),
        }
        .encode(&mut out);
        out.extend_from_slice(&payload);
        out
    }

    /// Hash that is signed: `keccak256(0x02 || rlp(unsigned fields))`.
    fn signing_hash(&self) -> [u8; 32] {
        keccak256(&self.envelope(None))
    }
}

fn parse_request(tx: &EvmTxRequest) -> Result<Eip1559> {
    if tx.chain_id == 0 {
        return Err(Error::input("chain_id must be non-zero"));
    }
    if tx.gas_limit == 0 {
        return Err(Error::input("gas_limit must be non-zero"));
    }
    let max_fee_per_gas = parse_decimal_u128("max_fee_per_gas", &tx.max_fee_per_gas)?;
    let max_priority_fee_per_gas =
        parse_decimal_u128("max_priority_fee_per_gas", &tx.max_priority_fee_per_gas)?;
    if max_priority_fee_per_gas > max_fee_per_gas {
        return Err(Error::input(
            "max_priority_fee_per_gas exceeds max_fee_per_gas",
        ));
    }
    Ok(Eip1559 {
        chain_id: tx.chain_id,
        nonce: tx.nonce,
        max_priority_fee_per_gas,
        max_fee_per_gas,
        gas_limit: tx.gas_limit,
        to: parse_address(&tx.to)?,
        value: parse_decimal_u256("value_wei", &tx.value_wei)?,
        data: parse_data(&tx.data)?,
    })
}

/// Decodes a request into a plain-language summary (no secret needed).
pub fn evm_decode(tx: &EvmTxRequest) -> Result<EvmTxSummary> {
    let p = parse_request(tx)?;
    let max_fee_wei = U256::from(tx.gas_limit)
        .checked_mul(U256::from(p.max_fee_per_gas))
        .ok_or_else(|| Error::input("fee overflow"))?;
    let mut summary = EvmTxSummary {
        kind: EvmTxKind::ContractCall,
        to: p.to.to_checksum(),
        token_contract: None,
        amount: p.value.to_string(),
        spender: None,
        unlimited_approval: false,
        max_fee_wei: max_fee_wei.to_string(),
        chain_id: tx.chain_id,
        value_wei: p.value.to_string(),
    };

    if p.data.is_empty() {
        summary.kind = EvmTxKind::NativeTransfer;
        return Ok(summary);
    }
    // Strict ABI shape: selector + exactly two 32-byte words; anything else is a ContractCall.
    if p.data.len() == 4 + 64 {
        let (selector, args) = p.data.split_at(4);
        let (w1, w2) = args.split_at(32);
        let amount = U256::from_big_endian(w2);
        if let Some(addr) = Address::from_word(w1) {
            if selector == SELECTOR_TRANSFER {
                summary.kind = EvmTxKind::Erc20Transfer;
                summary.token_contract = Some(p.to.to_checksum());
                summary.to = addr.to_checksum();
                summary.amount = amount.to_string();
            } else if selector == SELECTOR_APPROVE {
                summary.kind = EvmTxKind::Erc20Approve;
                summary.token_contract = Some(p.to.to_checksum());
                summary.spender = Some(addr.to_checksum());
                summary.amount = amount.to_string();
                // >= 2^255 (covers uint256::MAX).
                summary.unlimited_approval = amount.bit(255);
            }
        }
    }
    Ok(summary)
}

/// Derives the key at `m/44'/60'/0'/0/index`. The returned guard erases it on drop.
fn derive_key(secp: &Secp256k1<All>, seed: &Seed, index: u32) -> Result<XprivGuard> {
    let path = [
        hardened(44)?,
        hardened(60)?,
        hardened(0)?,
        normal(0)?,
        normal(index)?,
    ];
    let master = XprivGuard::master(seed, bitcoin::NetworkKind::Main)?;
    master.derive(secp, &path)
}

/// EIP-55 address at `m/44'/60'/0'/0/index`.
pub fn evm_address(seed: &Seed, index: u32) -> Result<String> {
    let secp = secp()?;
    let key = derive_key(&secp, seed, index)?;
    let pk = key.xpriv().private_key.public_key(&secp);
    Ok(Address::from_pubkey(&pk).to_checksum())
}

/// Signs an EIP-1559 (type 2) transaction with the key at `m/44'/60'/0'/0/index`.
/// Returns `(raw "0x02..." hex, transaction hash "0x...")`.
pub fn evm_sign_tx(seed: &Seed, index: u32, tx: &EvmTxRequest) -> Result<(String, String)> {
    let unsigned = parse_request(tx)?;
    let msg = Message::from_digest(unsigned.signing_hash());

    let secp = secp()?;
    let key = derive_key(&secp, seed, index)?;
    let expected = Address::from_pubkey(&key.xpriv().private_key.public_key(&secp));
    let recoverable = secp.sign_ecdsa_recoverable(&msg, &key.xpriv().private_key);
    drop(key);

    // Self-check: recover the signer with libsecp256k1 and compare to the derived address.
    let recovered = secp
        .recover_ecdsa(&msg, &recoverable)
        .map_err(|_| Error::crypto("signature self-check failed"))?;
    if Address::from_pubkey(&recovered) != expected {
        return Err(Error::crypto("signature self-check failed"));
    }

    let (recid, compact) = recoverable.serialize_compact();
    let y_parity = match recid.to_i32() {
        0 => false,
        1 => true,
        // 2/3 only occur when r overflows the group order; not representable in EIP-1559.
        _ => return Err(Error::crypto("unexpected recovery id")),
    };
    let mut sig = EcdsaSig {
        y_parity,
        r: [0u8; 32],
        s: [0u8; 32],
    };
    sig.r.copy_from_slice(&compact[..32]);
    sig.s.copy_from_slice(&compact[32..]);

    let raw = unsigned.envelope(Some(&sig));
    let hash = keccak256(&raw);
    Ok((
        format!("0x{}", hex::encode(raw)),
        format!("0x{}", hex::encode(hash)),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use bitcoin::secp256k1::ecdsa::{RecoverableSignature, RecoveryId};

    fn h32(s: &str) -> [u8; 32] {
        let mut out = [0u8; 32];
        hex::decode_to_slice(s, &mut out).unwrap();
        out
    }

    /// Ethereum mainnet tx 0x0ec0b6a2df4d87424e5f6ad2a654e27aaeb7dac20ae9e8385cc09087ad532ee0
    /// (also the vector of alloy-consensus' own test suite): fields, signature, signing hash,
    /// tx hash and sender are public on-chain data.
    #[test]
    fn eip1559_mainnet_vector() {
        let tx = Eip1559 {
            chain_id: 1,
            nonce: 0x42,
            max_priority_fee_per_gas: 0x3b9aca00,
            max_fee_per_gas: 0x4a817c800,
            gas_limit: 44386,
            to: parse_address("0x6069a6c32cf691f5982febae4faf8a6f3ab2f0f6").unwrap(),
            value: U256::zero(),
            data: hex::decode(concat!(
                "a22cb465",
                "0000000000000000000000005eee75727d804a2b13038928d36f8b188945a57a",
                "0000000000000000000000000000000000000000000000000000000000000000"
            ))
            .unwrap(),
        };
        let sighash = tx.signing_hash();
        assert_eq!(
            hex::encode(sighash),
            "0d5688ac3897124635b6cf1bc0e29d6dfebceebdc10a54d74f2ef8b56535b682"
        );
        let sig = EcdsaSig {
            y_parity: false,
            r: h32("840cfc572845f5786e702984c2a582528cad4b49b2a10b9db1be7fca90058565"),
            s: h32("25e7109ceb98168d95b09b18bbf6b685130e0562f233877d492b94eee0c5b6d1"),
        };
        assert_eq!(
            hex::encode(keccak256(&tx.envelope(Some(&sig)))),
            "0ec0b6a2df4d87424e5f6ad2a654e27aaeb7dac20ae9e8385cc09087ad532ee0"
        );
        // Sender recovered with libsecp256k1 over our signing hash.
        let mut compact = [0u8; 64];
        compact[..32].copy_from_slice(&sig.r);
        compact[32..].copy_from_slice(&sig.s);
        let rsig =
            RecoverableSignature::from_compact(&compact, RecoveryId::from_i32(0).unwrap()).unwrap();
        let pk = Secp256k1::verification_only()
            .recover_ecdsa(&Message::from_digest(sighash), &rsig)
            .unwrap();
        assert_eq!(
            Address::from_pubkey(&pk),
            parse_address("0xdd6b8b3dc6b7ad97db52f08a275ff4483e024cea").unwrap()
        );
    }

    #[test]
    fn rlp_integer_encoding() {
        let mut out = Vec::new();
        for v in [0u64, 0x7f, 0x80, 0x0400] {
            trim_be(&U256::from(v).to_big_endian()).encode(&mut out);
            v.encode(&mut out); // must match alloy-rlp's native integer encoding
        }
        assert_eq!(hex::encode(out), "80807f7f81808180820400820400");
    }

    /// EIP-55 spec vectors (https://eips.ethereum.org/EIPS/eip-55).
    #[test]
    fn eip55_vectors() {
        for a in [
            "0x52908400098527886E0F7030069857D2E4169EE7",
            "0x8617E340B3D01FA5F11F306F4090FD50E238070D",
            "0xde709f2102306220921060314715629080e2fb77",
            "0x27b1fdb04752bbc536007a920d24acb045561c26",
            "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
            "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
            "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB",
            "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb",
        ] {
            let parsed = parse_address(a).unwrap();
            let has_lower = a[2..].bytes().any(|b| b.is_ascii_lowercase());
            let has_upper = a[2..].bytes().any(|b| b.is_ascii_uppercase());
            if has_lower && has_upper {
                assert_eq!(parsed.to_checksum(), a);
            }
            assert_eq!(parse_address(&a.to_lowercase()).unwrap(), parsed);
        }
    }

    #[test]
    fn unlimited_threshold() {
        assert!(!(U256::one() << 254).bit(255));
        assert!((U256::one() << 255).bit(255));
        assert!(U256::MAX.bit(255));
    }

    #[test]
    fn address_validation() {
        assert!(parse_address("0x9858EfFD232B4033E47d90003D41EC34EcaEda94").is_ok());
        assert!(parse_address("0x9858effd232b4033e47d90003d41ec34ecaeda94").is_ok());
        assert!(parse_address("0x9858EFFD232B4033E47D90003D41EC34ECAEDA94").is_ok());
        // Bad checksum (one letter case flipped).
        assert!(parse_address("0x9858EfFD232B4033E47d90003D41EC34EcaEda9A").is_err());
        assert!(parse_address("0x9858efFD232B4033E47d90003D41EC34EcaEda94").is_err());
        assert!(parse_address("9858effd232b4033e47d90003d41ec34ecaeda94").is_err());
        assert!(parse_address("0x9858effd232b4033e47d90003d41ec34ecaeda").is_err());
        assert!(parse_address("0xzz58effd232b4033e47d90003d41ec34ecaeda94").is_err());
    }

    #[test]
    fn decimal_validation() {
        assert!(parse_decimal_u256("v", "0").is_ok());
        assert!(parse_decimal_u256("v", "").is_err());
        assert!(parse_decimal_u256("v", "-1").is_err());
        assert!(parse_decimal_u256("v", "+1").is_err());
        assert!(parse_decimal_u256("v", "1.5").is_err());
        assert!(parse_decimal_u256("v", "0x10").is_err());
        let max = U256::MAX.to_string();
        assert_eq!(parse_decimal_u256("v", &max).unwrap(), U256::MAX);
        // MAX + 1 overflows.
        assert!(parse_decimal_u256(
            "v",
            "115792089237316195423570985008687907853269984665640564039457584007913129639936"
        )
        .is_err());
        assert!(parse_decimal_u128("v", "340282366920938463463374607431768211456").is_err());
    }
}
