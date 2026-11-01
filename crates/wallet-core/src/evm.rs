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
use crate::network::Network;

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

/// The one list of EVM chains Kyro knows, with the network family each belongs to. A chain of
/// the other family is refused ([`evm_decode`], [`evm_sign_tx`]): a wallet in test mode never
/// signs a mainnet transaction, and the other way round. Any chain id not listed needs the
/// reinforced confirmation ([`EvmWarning::UnknownChain`]).
pub const EVM_KNOWN_CHAINS: &[(u64, Network)] = &[
    (1, Network::Mainnet),          // Ethereum
    (42_161, Network::Mainnet),     // Arbitrum One
    (10, Network::Mainnet),         // OP Mainnet
    (8_453, Network::Mainnet),      // Base
    (137, Network::Mainnet),        // Polygon PoS
    (56, Network::Mainnet),         // BNB Smart Chain
    (43_114, Network::Mainnet),     // Avalanche C-Chain
    (25, Network::Mainnet),         // Cronos
    (5_000, Network::Mainnet),      // Mantle
    (146, Network::Mainnet),        // Sonic
    (14, Network::Mainnet),         // Flare
    (8_217, Network::Mainnet),      // Kaia
    (100, Network::Mainnet),        // Gnosis
    (999, Network::Mainnet),        // HyperEVM
    (1_329, Network::Mainnet),      // Sei
    (1_030, Network::Mainnet),      // Conflux eSpace
    (11_155_111, Network::Testnet), // Sepolia
];

/// Network family of a known chain id (see [`EVM_KNOWN_CHAINS`]), `None` if unknown.
pub fn evm_chain_network(chain_id: u64) -> Option<Network> {
    EVM_KNOWN_CHAINS
        .iter()
        .find(|(id, _)| *id == chain_id)
        .map(|(_, n)| *n)
}

/// Refuses a chain id that Kyro knows as belonging to the other network family.
fn check_chain_family(chain_id: u64, net: Network) -> Result<()> {
    match evm_chain_network(chain_id) {
        Some(n) if n != net => Err(Error::input(match net {
            Network::Mainnet => {
                format!("chainId {chain_id} is a test network: refused by a mainnet wallet")
            }
            Network::Testnet => {
                format!("chainId {chain_id} is a main network (real money): refused in test mode")
            }
        })),
        _ => Ok(()),
    }
}

/// Approval amounts with more than 128 significant bits (≥ 2^128) are shown as ILLIMITÉ: no
/// token has that much supply; it is `uint256::MAX` or close to it.
fn is_unlimited(amount: U256) -> bool {
    amount.bits() > 128
}

/// Worst-case fee (`gas_limit × max_fee_per_gas`, native units in wei) above which the
/// reinforced confirmation is required: 0.05 of the native coin on ETH-native chains (Ethereum,
/// Sepolia, Arbitrum, Optimism, Base), BNB Chain and HyperEVM, 50 POL on Polygon, 1 AVAX on
/// Avalanche, 0.05 elsewhere. A plain transfer costs ~0.0005 ETH at 20 gwei; a swap ~0.005–0.02 ETH.
/// Chains with a low-priced native coin get a threshold of roughly 10 USD (prices of 2026-10-31):
/// 200 CRO (Cronos, ~380 gwei), 20 MNT (Mantle), 250 S (Sonic), 2 000 FLR (Flare, ~650 gwei),
/// 300 KAIA, 10 XDAI (Gnosis), 200 SEI, 200 CFX (Conflux eSpace); 0.05 of those coins would flag
/// ordinary token transfers.
pub fn evm_high_fee_threshold_wei(chain_id: u64) -> U256 {
    let milli = U256::exp10(15); // 0.001 native
    match chain_id {
        137 => milli * 50_000u64,
        43_114 => milli * 1_000u64,
        25 | 1_329 | 1_030 => milli * 200_000u64,
        5_000 => milli * 20_000u64,
        146 => milli * 250_000u64,
        14 => milli * 2_000_000u64,
        8_217 => milli * 300_000u64,
        100 => milli * 10_000u64,
        _ => milli * 50u64,
    }
}

/// Reasons for caution in an EVM transaction (each one requires the reinforced confirmation).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum EvmWarning {
    /// Contract call that is not a decoded ERC-20 transfer: Kyro cannot tell what it does.
    ContractCall,
    /// ERC-20 approval: `spender` may move `amount` of the token at any time.
    Approval {
        /// Spender, EIP-55.
        spender: String,
        /// Raw token units, decimal string.
        amount: String,
        /// `≥ 2^128` (max or close to it): shown as ILLIMITÉ (same as
        /// [`EvmTxSummary::unlimited_approval`]).
        unlimited: bool,
    },
    /// Native value attached to a contract call (non-empty calldata).
    ValueToContract {
        /// Wei, decimal string.
        value_wei: String,
    },
    /// Chain id not in [`EVM_KNOWN_CHAINS`].
    UnknownChain {
        /// Chain id.
        chain_id: u64,
    },
    /// Worst-case fee above [`evm_high_fee_threshold_wei`].
    HighFee {
        /// Wei, decimal string.
        max_fee_wei: String,
    },
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
    /// `true` for an approval of at least 2^128 (including `uint256::MAX`): shown as ILLIMITÉ.
    pub unlimited_approval: bool,
    /// Worst-case fee: `gas_limit * max_fee_per_gas`, in wei.
    pub max_fee_wei: String,
    /// Chain id.
    pub chain_id: u64,
    /// Native value attached to the transaction, in wei (always present, even for ERC-20 calls).
    pub value_wei: String,
    /// Reasons for caution.
    #[serde(default)]
    pub warnings: Vec<EvmWarning>,
    /// The native dialog must be followed by a reinforced one.
    #[serde(default)]
    pub requires_extra_confirmation: bool,
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

/// Decodes a request into a plain-language summary (no secret needed). Refused: a chain id
/// of the other network family than `net` (see [`EVM_KNOWN_CHAINS`]).
pub fn evm_decode(tx: &EvmTxRequest, net: Network) -> Result<EvmTxSummary> {
    let p = parse_request(tx)?;
    check_chain_family(p.chain_id, net)?;
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
        warnings: Vec::new(),
        requires_extra_confirmation: false,
    };

    if p.data.is_empty() {
        summary.kind = EvmTxKind::NativeTransfer;
        return Ok(with_warnings(summary, &p, max_fee_wei));
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
                summary.unlimited_approval = is_unlimited(amount);
            }
        }
    }
    Ok(with_warnings(summary, &p, max_fee_wei))
}

fn with_warnings(mut s: EvmTxSummary, p: &Eip1559, max_fee_wei: U256) -> EvmTxSummary {
    let mut w = Vec::new();
    match s.kind {
        EvmTxKind::ContractCall => w.push(EvmWarning::ContractCall),
        EvmTxKind::Erc20Approve => w.push(EvmWarning::Approval {
            spender: s.spender.clone().unwrap_or_default(),
            amount: s.amount.clone(),
            unlimited: s.unlimited_approval,
        }),
        EvmTxKind::NativeTransfer | EvmTxKind::Erc20Transfer => {}
    }
    if !p.data.is_empty() && !p.value.is_zero() {
        w.push(EvmWarning::ValueToContract {
            value_wei: p.value.to_string(),
        });
    }
    if evm_chain_network(s.chain_id).is_none() {
        w.push(EvmWarning::UnknownChain {
            chain_id: s.chain_id,
        });
    }
    if max_fee_wei > evm_high_fee_threshold_wei(s.chain_id) {
        w.push(EvmWarning::HighFee {
            max_fee_wei: max_fee_wei.to_string(),
        });
    }
    s.requires_extra_confirmation = !w.is_empty();
    s.warnings = w;
    s
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

/// Path of EVM account `index`: `m/44'/60'/0'/0/index`.
///
/// Kyro's EVM accounts are **address indices** below one BIP44 account (MetaMask, Trezor Suite
/// and Kyro's own hardware-wallet accounts), not Ledger Live's `m/44'/60'/index'/0/0`: account 0
/// is the same in both layouts, and this one keeps a seed imported from MetaMask showing the
/// same accounts in the same order.
pub fn evm_path(index: u32) -> String {
    format!("m/44'/60'/0'/0/{index}")
}

/// EIP-55 address at `m/44'/60'/0'/0/index`.
pub fn evm_address(seed: &Seed, index: u32) -> Result<String> {
    let secp = secp()?;
    let key = derive_key(&secp, seed, index)?;
    let pk = key.xpriv().private_key.public_key(&secp);
    Ok(Address::from_pubkey(&pk).to_checksum())
}

/// Signs an EIP-1559 (type 2) transaction with the key at `m/44'/60'/0'/0/index`, for a
/// wallet on `net` (a chain id of the other family is refused, as in [`evm_decode`]).
/// Returns `(raw "0x02..." hex, transaction hash "0x...")`.
pub fn evm_sign_tx(
    seed: &Seed,
    index: u32,
    tx: &EvmTxRequest,
    net: Network,
) -> Result<(String, String)> {
    let unsigned = parse_request(tx)?;
    check_chain_family(unsigned.chain_id, net)?;
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

// ---------------------------------------------------------------------------------------------
// Hardware wallets (no private key): payloads for the device, and checks of what it returns.
// ---------------------------------------------------------------------------------------------

/// Big-endian integer fields of an EIP-1559 transaction, minimal encoding (no leading zero
/// byte, zero is empty), as hardware-wallet protocols expect them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvmTxFields {
    /// Chain id.
    pub chain_id: u64,
    /// Nonce.
    pub nonce: Vec<u8>,
    /// Gas limit.
    pub gas_limit: Vec<u8>,
    /// Max fee per gas (wei).
    pub max_fee_per_gas: Vec<u8>,
    /// Max priority fee per gas (wei).
    pub max_priority_fee_per_gas: Vec<u8>,
    /// Recipient, EIP-55.
    pub to: String,
    /// Raw 20-byte recipient.
    pub to_bytes: [u8; 20],
    /// Native value (wei).
    pub value: Vec<u8>,
    /// Calldata.
    pub data: Vec<u8>,
}

/// Validated fields of `tx` for a device (same validation as [`evm_decode`]).
pub fn evm_tx_fields(tx: &EvmTxRequest) -> Result<EvmTxFields> {
    let p = parse_request(tx)?;
    Ok(EvmTxFields {
        chain_id: p.chain_id,
        nonce: trim_be(&p.nonce.to_be_bytes()).to_vec(),
        gas_limit: trim_be(&p.gas_limit.to_be_bytes()).to_vec(),
        max_fee_per_gas: trim_be(&p.max_fee_per_gas.to_be_bytes()).to_vec(),
        max_priority_fee_per_gas: trim_be(&p.max_priority_fee_per_gas.to_be_bytes()).to_vec(),
        to: p.to.to_checksum(),
        to_bytes: p.to.0,
        value: trim_be(&p.value.to_big_endian()).to_vec(),
        data: p.data,
    })
}

/// The exact bytes whose Keccak-256 is signed: `0x02 || rlp(unsigned fields)` (EIP-2718 /
/// EIP-1559). This is what the Ledger Ethereum app receives in SIGN ETH TRANSACTION.
pub fn evm_signing_payload(tx: &EvmTxRequest) -> Result<Vec<u8>> {
    Ok(parse_request(tx)?.envelope(None))
}

/// EIP-55 address of a SEC1 public key (33-byte compressed or 65-byte uncompressed).
pub fn evm_address_of_pubkey(sec1: &[u8]) -> Result<String> {
    let pk =
        PublicKey::from_slice(sec1).map_err(|_| Error::input("invalid secp256k1 public key"))?;
    Ok(Address::from_pubkey(&pk).to_checksum())
}

/// Encodes the node at `m/44'/60'/0'/0` (public key + chain code, as returned by a device)
/// as a standard `xpub` string, so addresses `…/0/i` can be derived publicly. The parent
/// fingerprint is not known to the device protocol and is left zero; it is unused for
/// derivation.
pub fn evm_xpub_from_node(sec1: &[u8], chain_code: &[u8]) -> Result<String> {
    use bitcoin::bip32::{ChainCode, ChildNumber, Fingerprint, Xpub};
    let public_key =
        PublicKey::from_slice(sec1).map_err(|_| Error::input("invalid secp256k1 public key"))?;
    let chain_code: [u8; 32] = chain_code
        .try_into()
        .map_err(|_| Error::input("chain code must be 32 bytes"))?;
    Ok(Xpub {
        network: bitcoin::NetworkKind::Main,
        depth: 4,
        parent_fingerprint: Fingerprint::default(),
        child_number: ChildNumber::Normal { index: 0 },
        public_key,
        chain_code: ChainCode::from(chain_code),
    }
    .to_string())
}

/// EIP-55 address `index` below a node encoded by [`evm_xpub_from_node`] (`m/44'/60'/0'/0`).
pub fn evm_address_from_xpub(xpub: &str, index: u32) -> Result<String> {
    use bitcoin::bip32::Xpub;
    use core::str::FromStr;
    let xpub = Xpub::from_str(xpub.trim()).map_err(|_| Error::input("invalid EVM xpub"))?;
    if xpub.depth != 4 {
        return Err(Error::input("EVM xpub must be the m/44'/60'/0'/0 node"));
    }
    let child = xpub
        .derive_pub(&Secp256k1::verification_only(), &[normal(index)?])
        .map_err(|_| Error::crypto("public derivation failed"))?;
    Ok(Address::from_pubkey(&child.public_key).to_checksum())
}

/// Checks a signature `(r, s)` returned by a device for `tx` and builds the signed transaction.
///
/// The device's `v` is ignored: both recovery ids are tried and the one that recovers
/// `expected_address` over the signing hash computed here is used. Fails with
/// [`Error::Device`] if `s` is not low (EIP-2) or if no recovery id gives the expected address
/// (wrong key, wrong transaction, forged signature). Returns `(raw "0x02…", tx hash)`.
pub fn evm_hw_finalize(
    tx: &EvmTxRequest,
    r: &[u8],
    s: &[u8],
    expected_address: &str,
) -> Result<(String, String)> {
    use bitcoin::secp256k1::ecdsa::{RecoverableSignature, RecoveryId, Signature};
    let unsigned = parse_request(tx)?;
    let expected = parse_address(expected_address)?;
    let (r, s): ([u8; 32], [u8; 32]) = match (r.try_into(), s.try_into()) {
        (Ok(r), Ok(s)) => (r, s),
        _ => return Err(Error::Device("r and s must be 32 bytes".into())),
    };
    let mut compact = [0u8; 64];
    compact[..32].copy_from_slice(&r);
    compact[32..].copy_from_slice(&s);
    let plain = Signature::from_compact(&compact)
        .map_err(|_| Error::Device("malformed ECDSA signature".into()))?;
    let mut normalized = plain;
    normalized.normalize_s();
    if normalized != plain {
        return Err(Error::Device("high-S signature (EIP-2)".into()));
    }
    let msg = Message::from_digest(unsigned.signing_hash());
    let secp = Secp256k1::verification_only();
    let mut parity = None;
    for (id, y) in [(0, false), (1, true)] {
        let recid = RecoveryId::from_i32(id).map_err(|_| Error::crypto("recovery id"))?;
        let Ok(rs) = RecoverableSignature::from_compact(&compact, recid) else {
            continue;
        };
        if let Ok(pk) = secp.recover_ecdsa(&msg, &rs) {
            if Address::from_pubkey(&pk) == expected {
                parity = Some(y);
                break;
            }
        }
    }
    let y_parity = parity.ok_or_else(|| {
        Error::Device("signature does not match the expected address for this transaction".into())
    })?;
    let raw = unsigned.envelope(Some(&EcdsaSig { y_parity, r, s }));
    let hash = keccak256(&raw);
    Ok((
        format!("0x{}", hex::encode(raw)),
        format!("0x{}", hex::encode(hash)),
    ))
}

/// Normalises and validates an EVM address (EIP-55 output).
pub fn evm_checksum_address(address: &str) -> Result<String> {
    Ok(parse_address(address.trim())?.to_checksum())
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

    #[test]
    fn high_fee_thresholds_follow_the_native_coin() {
        let one = U256::exp10(18);
        assert_eq!(evm_high_fee_threshold_wei(1), one / 20u64);
        assert_eq!(evm_high_fee_threshold_wei(999), one / 20u64);
        assert_eq!(evm_high_fee_threshold_wei(137), one * 50u64);
        assert_eq!(evm_high_fee_threshold_wei(14), one * 2_000u64);
        assert_eq!(evm_high_fee_threshold_wei(25), one * 200u64);
        assert_eq!(evm_high_fee_threshold_wei(100), one * 10u64);
        assert_eq!(evm_high_fee_threshold_wei(424_242), one / 20u64);
        assert_eq!(evm_chain_network(1_030), Some(Network::Mainnet));
        assert_eq!(evm_chain_network(61), None);
    }
}
