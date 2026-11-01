//! NEAR: SLIP-10 ed25519 at `m/44'/397'/account'` (near-seed-phrase), implicit hex accounts, and
//! a strict Borsh codec for the only tx Kyro signs: **one NEAR `Transfer`** (`TransactionV0`).

use ed25519_dalek::Signer as _;
use ed25519_dalek_bip32::{ChildIndex, ExtendedSigningKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::Zeroize;

use crate::error::{Error, Result};
use crate::mnemonic::Seed;

/// 1 NEAR = 10^24 yoctoNEAR.
pub const NEAR_DECIMALS: u32 = 24;
const MAX_DEPOSIT: u128 = 10_000_000_000 * 1_000_000_000_000_000_000_000_000;
const ED25519: u8 = 0;
const ACTION_TRANSFER: u8 = 3;
const ACTION_FUNCTION_CALL: u8 = 2;
/// Gas attached to each call to a token contract (30 Tgas, what NEAR wallets attach).
pub const NEAR_FT_GAS: u64 = 30_000_000_000_000;
/// Max storage deposit to register a token recipient (0.0125 NEAR; usual min 0.00125 NEAR).
pub const NEAR_MAX_STORAGE_DEPOSIT: u128 = 12_500_000_000_000_000_000_000;

/// A NEP-141 token Kyro knows (issuer's list, cross-checked, `ft_metadata` read on chain).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NearKnownToken {
    /// Token contract account.
    pub contract: &'static str,
    /// Ticker.
    pub symbol: &'static str,
    /// Display name.
    pub name: &'static str,
    /// Decimals (`ft_metadata.decimals`).
    pub decimals: u8,
}

const NEAR_MAINNET_TOKENS: &[NearKnownToken] = &[
    NearKnownToken {
        contract: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
        symbol: "USDC",
        name: "USD Coin",
        decimals: 6,
    },
    NearKnownToken {
        contract: "usdt.tether-token.near",
        symbol: "USDT",
        name: "Tether",
        decimals: 6,
    },
];
const NEAR_TESTNET_TOKENS: &[NearKnownToken] = &[NearKnownToken {
    contract: "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af",
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
}];

/// The tokens Kyro knows on mainnet (`testnet = false`) or testnet.
pub fn near_known_tokens(testnet: bool) -> &'static [NearKnownToken] {
    if testnet {
        NEAR_TESTNET_TOKENS
    } else {
        NEAR_MAINNET_TOKENS
    }
}

/// The known token of contract `contract` and the network it belongs to (`true` = testnet).
pub fn near_known_token(contract: &str) -> Option<(&'static NearKnownToken, bool)> {
    [false, true].into_iter().find_map(|tn| {
        near_known_tokens(tn)
            .iter()
            .find(|t| t.contract == contract)
            .map(|t| (t, tn))
    })
}

/// Token side: `ft_transfer` to `recipient`, after our `storage_deposit` if it isn't registered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NearFtTransfer {
    /// Who receives the tokens.
    pub recipient: String,
    /// Token units.
    pub amount: u128,
    /// yoctoNEAR attached to `storage_deposit({ account_id: recipient, registration_only: true })`.
    pub storage_deposit: Option<u128>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FtTransferArgs {
    receiver_id: String,
    amount: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StorageDepositArgs {
    account_id: String,
    registration_only: bool,
}

fn ft_transfer_args(recipient: &str, amount: u128) -> String {
    format!("{{\"receiver_id\":\"{recipient}\",\"amount\":\"{amount}\"}}")
}

fn storage_deposit_args(recipient: &str) -> String {
    format!("{{\"account_id\":\"{recipient}\",\"registration_only\":true}}")
}

fn put_call(o: &mut Vec<u8>, method: &str, args: &str, deposit: u128) {
    o.push(ACTION_FUNCTION_CALL);
    put_string(o, method);
    put_string(o, args); // Vec<u8>: u32 length + bytes, like a string
    o.extend_from_slice(&NEAR_FT_GAS.to_le_bytes());
    o.extend_from_slice(&deposit.to_le_bytes());
}

fn read_call(b: &mut &[u8]) -> Result<(String, Vec<u8>, u64, u128)> {
    let tag = read_u8(b)?;
    if tag != ACTION_FUNCTION_CALL {
        return Err(bad(format!(
            "action {} ({tag}) refused in a token transfer",
            action_name(tag)
        )));
    }
    let n = read_u32(b)? as usize;
    if n > 32 {
        return Err(bad("method name too long"));
    }
    let method = core::str::from_utf8(take(b, n)?)
        .map_err(|_| bad("method name: invalid UTF-8"))?
        .to_owned();
    let n = read_u32(b)? as usize;
    if n > 512 {
        return Err(bad("arguments too long"));
    }
    let args = take(b, n)?.to_vec();
    Ok((method, args, read_u64(b)?, read_u128(b)?))
}
const MAX_TX: usize = 1024;

fn hardened(index: u32) -> Result<ChildIndex> {
    ChildIndex::hardened(index).map_err(|_| Error::input("derivation index must be < 2^31"))
}

/// Path of NEAR account `account`: `m/44'/397'/account'` (three hardened levels, SLIP-10).
pub fn near_path(account: u32) -> String {
    format!("m/44'/397'/{account}'")
}

fn signing_key(seed: &Seed, account: u32) -> Result<ed25519_dalek::SigningKey> {
    let path = [hardened(44)?, hardened(397)?, hardened(account)?];
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

/// Raw ed25519 public key of NEAR account `account`.
pub fn near_public_key(seed: &Seed, account: u32) -> Result<[u8; 32]> {
    Ok(signing_key(seed, account)?.verifying_key().to_bytes())
}

/// Implicit account id (64 lowercase hex characters of the public key) of account `account`.
pub fn near_address(seed: &Seed, account: u32) -> Result<String> {
    Ok(hex::encode(near_public_key(seed, account)?))
}

/// `ed25519:<base58>`, how NEAR writes public keys (RPC, explorers).
pub fn near_public_key_string(public_key: &[u8; 32]) -> String {
    format!("ed25519:{}", bs58::encode(public_key).into_string())
}

/// Parses `ed25519:<base58>` (32 bytes, valid curve point).
pub fn near_parse_public_key(s: &str) -> Result<[u8; 32]> {
    let b58 = s
        .trim()
        .strip_prefix("ed25519:")
        .ok_or_else(|| Error::input("NEAR public key: ed25519: prefix expected"))?;
    let key: [u8; 32] = bs58::decode(b58)
        .into_vec()
        .ok()
        .and_then(|v| v.try_into().ok())
        .ok_or_else(|| Error::input("invalid NEAR public key"))?;
    ed25519_dalek::VerifyingKey::from_bytes(&key)
        .map_err(|_| Error::input("invalid NEAR public key"))?;
    Ok(key)
}

/// A 32-byte hash written in base58 (block hash, transaction hash).
pub fn near_parse_hash(s: &str) -> Result<[u8; 32]> {
    bs58::decode(s.trim())
        .into_vec()
        .ok()
        .and_then(|v| v.try_into().ok())
        .ok_or_else(|| Error::input("invalid NEAR hash (32 bytes in base58 expected)"))
}

/// Base58 form of a 32-byte hash.
pub fn near_hash_string(hash: &[u8; 32]) -> String {
    bs58::encode(hash).into_string()
}

/// What kind of account id a valid id is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NearAccountKind {
    /// 64 lowercase hex characters: an ed25519 public key (created by a first transfer).
    Implicit,
    /// `0x` + 40 lowercase hex: NEP-518 implicit account controlled by an **Ethereum** key.
    EthImplicit,
    /// A named account (`alice.near`, `bob.testnet`, `aurora`…): it must already exist.
    Named,
}

fn is_lower_hex(s: &str) -> bool {
    s.bytes()
        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Validates an account id (nearcore rules): 2–64 of `a-z0-9-_.`, no edge or doubled separators.
pub fn near_account_kind(id: &str) -> Result<NearAccountKind> {
    let b = id.as_bytes();
    if !(2..=64).contains(&b.len()) {
        return Err(Error::input("NEAR account ID: 2 to 64 characters"));
    }
    let sep = |c: u8| matches!(c, b'-' | b'_' | b'.');
    let mut prev_sep = true; // no separator first
    for &c in b {
        if sep(c) {
            if prev_sep {
                return Err(Error::input(
                    "invalid NEAR account ID (leading or doubled separator)",
                ));
            }
            prev_sep = true;
        } else if c.is_ascii_lowercase() || c.is_ascii_digit() {
            prev_sep = false;
        } else {
            return Err(Error::input(
                "invalid NEAR account ID (lowercase letters, digits, - _ . only)",
            ));
        }
    }
    if prev_sep {
        return Err(Error::input("invalid NEAR account ID (trailing separator)"));
    }
    if b.len() == 64 && is_lower_hex(id) {
        return Ok(NearAccountKind::Implicit);
    }
    if b.len() == 42 && id.starts_with("0x") && is_lower_hex(&id[2..]) {
        return Ok(NearAccountKind::EthImplicit);
    }
    Ok(NearAccountKind::Named)
}

fn bad(msg: impl Into<String>) -> Error {
    Error::input(format!("NEAR transaction: {}", msg.into()))
}

fn take<'a>(b: &mut &'a [u8], n: usize) -> Result<&'a [u8]> {
    if b.len() < n {
        return Err(bad("truncated"));
    }
    let (head, rest) = b.split_at(n);
    *b = rest;
    Ok(head)
}

fn take_array<const N: usize>(b: &mut &[u8]) -> Result<[u8; N]> {
    take(b, N)?.try_into().map_err(|_| bad("truncated"))
}

fn read_u8(b: &mut &[u8]) -> Result<u8> {
    Ok(take(b, 1)?[0])
}

fn read_u32(b: &mut &[u8]) -> Result<u32> {
    Ok(u32::from_le_bytes(take_array(b)?))
}

fn read_u64(b: &mut &[u8]) -> Result<u64> {
    Ok(u64::from_le_bytes(take_array(b)?))
}

fn read_u128(b: &mut &[u8]) -> Result<u128> {
    Ok(u128::from_le_bytes(take_array(b)?))
}

fn read_account_id(b: &mut &[u8], what: &str) -> Result<String> {
    let len = read_u32(b)? as usize;
    if len > 64 {
        return Err(bad(format!("{what}: ID longer than 64 bytes")));
    }
    let raw = take(b, len)?;
    let s = core::str::from_utf8(raw).map_err(|_| bad(format!("{what}: invalid UTF-8")))?;
    near_account_kind(s).map_err(|e| bad(format!("{what}: {e}")))?;
    Ok(s.to_owned())
}

fn put_string(out: &mut Vec<u8>, s: &str) {
    out.extend_from_slice(&(s.len() as u32).to_le_bytes());
    out.extend_from_slice(s.as_bytes());
}

fn action_name(tag: u8) -> &'static str {
    match tag {
        0 => "CreateAccount",
        1 => "DeployContract",
        2 => "FunctionCall",
        3 => "Transfer",
        4 => "Stake",
        5 => "AddKey",
        6 => "DeleteKey",
        7 => "DeleteAccount",
        8 => "Delegate",
        9 => "DeployGlobalContract",
        10 => "UseGlobalContract",
        _ => "unknown",
    }
}

/// A NEAR `TransactionV0` carrying exactly one `Transfer` action: what Kyro builds and signs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NearTransfer {
    /// `signer_id`: the sending account.
    pub signer_id: String,
    /// `public_key`: the ed25519 access key that signs (its nonce is used).
    pub public_key: [u8; 32],
    /// `nonce`: the access key's nonce + 1 (or more).
    pub nonce: u64,
    /// `receiver_id`: the recipient account.
    pub receiver_id: String,
    /// `block_hash`: a recent block; the transaction expires ≈ 24 h after it.
    pub block_hash: [u8; 32],
    /// `Transfer.deposit`, yoctoNEAR (0 for a token transfer).
    pub deposit: u128,
    /// Token transfer: `receiver_id` = known contract, actions `[storage_deposit?, ft_transfer]`.
    pub ft: Option<NearFtTransfer>,
}

impl NearTransfer {
    /// Borsh serialization (what is hashed and signed).
    pub fn encode(&self) -> Vec<u8> {
        let mut o = Vec::with_capacity(200);
        put_string(&mut o, &self.signer_id);
        o.push(ED25519);
        o.extend_from_slice(&self.public_key);
        o.extend_from_slice(&self.nonce.to_le_bytes());
        put_string(&mut o, &self.receiver_id);
        o.extend_from_slice(&self.block_hash);
        match &self.ft {
            None => {
                o.extend_from_slice(&1u32.to_le_bytes());
                o.push(ACTION_TRANSFER);
                o.extend_from_slice(&self.deposit.to_le_bytes());
            }
            Some(f) => {
                let n: u32 = if f.storage_deposit.is_some() { 2 } else { 1 };
                o.extend_from_slice(&n.to_le_bytes());
                if let Some(d) = f.storage_deposit {
                    put_call(
                        &mut o,
                        "storage_deposit",
                        &storage_deposit_args(&f.recipient),
                        d,
                    );
                }
                put_call(
                    &mut o,
                    "ft_transfer",
                    &ft_transfer_args(&f.recipient, f.amount),
                    1,
                );
            }
        }
        o
    }

    /// yoctoNEAR attached in total (Transfer deposit, or 1 yocto + the storage deposit).
    pub fn attached(&self) -> u128 {
        match &self.ft {
            None => self.deposit,
            Some(f) => 1 + f.storage_deposit.unwrap_or(0),
        }
    }

    fn read_ft(b: &mut &[u8], n: u32) -> Result<NearFtTransfer> {
        if n != 1 && n != 2 {
            return Err(bad(format!("{n} actions in a token transfer")));
        }
        let mut storage = None;
        if n == 2 {
            let (m, args, gas, deposit) = read_call(b)?;
            let a: StorageDepositArgs = serde_json::from_slice(&args)
                .map_err(|_| bad("unexpected storage_deposit arguments"))?;
            if m != "storage_deposit" || gas != NEAR_FT_GAS || !a.registration_only {
                return Err(bad("first action: storage_deposit expected"));
            }
            if deposit == 0 || deposit > NEAR_MAX_STORAGE_DEPOSIT {
                return Err(bad("storage deposit out of bounds"));
            }
            storage = Some((a.account_id, deposit));
        }
        let (m, args, gas, deposit) = read_call(b)?;
        let a: FtTransferArgs = serde_json::from_slice(&args)
            .map_err(|_| bad("unexpected ft_transfer arguments (memo refused)"))?;
        if m != "ft_transfer" || gas != NEAR_FT_GAS || deposit != 1 {
            return Err(bad("ft_transfer expected (30 Tgas, 1 yoctoNEAR)"));
        }
        near_account_kind(&a.receiver_id).map_err(|e| bad(format!("recipient: {e}")))?;
        if let Some((acc, _)) = &storage {
            if acc != &a.receiver_id {
                return Err(bad(
                    "storage_deposit for an account other than the recipient",
                ));
            }
        }
        let amount: u128 = a.amount.parse().map_err(|_| bad("invalid token amount"))?;
        Ok(NearFtTransfer {
            recipient: a.receiver_id,
            amount,
            storage_deposit: storage.map(|(_, d)| d),
        })
    }

    fn read(b: &mut &[u8]) -> Result<NearTransfer> {
        // First byte: V1 starts with tag 1, V0 with `signer_id` length (u32 LE, ≥ 2 if valid).
        if b.first() == Some(&1) {
            return Err(bad("TransactionV1 (priority fees, gas keys) not supported"));
        }
        let signer_id = read_account_id(b, "signer_id")?;
        let key_type = read_u8(b)?;
        if key_type != ED25519 {
            return Err(bad(format!(
                "key type {key_type} (secp256k1, ML-DSA…) not supported"
            )));
        }
        let public_key = take_array(b)?;
        let nonce = read_u64(b)?;
        let receiver_id = read_account_id(b, "receiver_id")?;
        let block_hash = take_array(b)?;
        let n = read_u32(b)?;
        if b.first() == Some(&ACTION_FUNCTION_CALL) {
            if near_known_token(&receiver_id).is_none() {
                return Err(bad(
                    "contract call (FunctionCall) refused: Kyro only calls the token contracts it knows",
                ));
            }
            let ft = NearTransfer::read_ft(b, n)?;
            return Ok(NearTransfer {
                signer_id,
                public_key,
                nonce,
                receiver_id,
                block_hash,
                deposit: 0,
                ft: Some(ft),
            });
        }
        if n != 1 {
            return Err(bad(format!(
                "{n} actions: Kyro signs a single Transfer only"
            )));
        }
        let tag = read_u8(b)?;
        if tag != ACTION_TRANSFER {
            return Err(bad(format!(
                "action {} ({tag}) refused: Kyro signs Transfer actions only",
                action_name(tag)
            )));
        }
        let deposit = read_u128(b)?;
        Ok(NearTransfer {
            signer_id,
            public_key,
            nonce,
            receiver_id,
            block_hash,
            deposit,
            ft: None,
        })
    }

    /// Strict decode: one Transfer, ed25519 key, no trailing byte, identical re-encoding.
    pub fn decode(raw: &[u8]) -> Result<NearTransfer> {
        if raw.len() > MAX_TX {
            return Err(bad("too large"));
        }
        let mut b = raw;
        let tx = NearTransfer::read(&mut b)?;
        if !b.is_empty() {
            return Err(bad("trailing bytes after the transaction"));
        }
        if tx.encode() != raw {
            return Err(bad("non-canonical encoding"));
        }
        Ok(tx)
    }

    /// `SHA-256(borsh(tx))`: the transaction hash, and what ed25519 signs.
    pub fn hash(&self) -> [u8; 32] {
        Sha256::digest(self.encode()).into()
    }

    /// `SignedTransaction { transaction, signature: ed25519 }`, Borsh.
    pub fn encode_signed(&self, signature: &[u8; 64]) -> Vec<u8> {
        let mut o = self.encode();
        o.push(ED25519);
        o.extend_from_slice(signature);
        o
    }

    /// Strict decoding of a `SignedTransaction` (same rules as [`NearTransfer::decode`]).
    pub fn decode_signed(raw: &[u8]) -> Result<(NearTransfer, [u8; 64])> {
        if raw.len() > MAX_TX + 65 {
            return Err(bad("too large"));
        }
        let mut b = raw;
        let tx = NearTransfer::read(&mut b)?;
        if read_u8(&mut b)? != ED25519 {
            return Err(bad("signature: key type not supported"));
        }
        let sig: [u8; 64] = take_array(&mut b)?;
        if !b.is_empty() {
            return Err(bad("trailing bytes after the signature"));
        }
        if tx.encode_signed(&sig) != raw {
            return Err(bad("non-canonical encoding"));
        }
        Ok((tx, sig))
    }
}

/// Reasons for caution (each one requires the reinforced confirmation).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum NearWarning {
    /// Recipient is a NEP-518 `0x…` account; an exchange's EVM deposit address is NOT one.
    EthImplicitReceiver,
}

/// Plain-language summary of a NEAR transfer, decoded by Rust.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NearTxSummary {
    /// Sender (always our implicit account, checked).
    pub signer_id: String,
    /// `ed25519:…` signing key (always ours, checked).
    pub public_key: String,
    /// Access-key nonce, decimal string.
    pub nonce: String,
    /// Recipient.
    pub receiver_id: String,
    /// Kind of recipient id.
    pub receiver_kind: NearAccountKind,
    /// yoctoNEAR, decimal string.
    pub deposit: String,
    /// Base58.
    pub block_hash: String,
    /// Transaction hash, base58 (what explorers show).
    pub hash: String,
    /// Reasons for caution.
    pub warnings: Vec<NearWarning>,
    /// The confirmation must be followed by a reinforced one.
    pub requires_extra_confirmation: bool,
    /// Token transfer; `deposit` is then the total NEAR attached (1 yocto + any storage deposit).
    pub token: Option<NearTokenSummary>,
}

/// The token side of a NEP-141 transfer, decoded by Rust.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NearTokenSummary {
    /// Token contract (verified id).
    pub contract: String,
    /// Ticker.
    pub symbol: String,
    /// Display name.
    pub name: String,
    /// Decimals.
    pub decimals: u8,
    /// The contract is Kyro's testnet one (the app checks it against its network).
    pub testnet: bool,
    /// Who receives the tokens.
    pub recipient: String,
    /// Kind of recipient id.
    pub recipient_kind: NearAccountKind,
    /// Token units, decimal string.
    pub amount: String,
    /// yoctoNEAR paid to register the recipient with the token, when it was not yet.
    pub storage_deposit: Option<String>,
}

fn summarize(tx: &NearTransfer, our_account: &str, our_pubkey: &[u8; 32]) -> Result<NearTxSummary> {
    if tx.signer_id != our_account {
        return Err(bad("the signer is not this wallet's account"));
    }
    if &tx.public_key != our_pubkey {
        return Err(bad("the signing key is not this wallet's"));
    }
    if tx.receiver_id == tx.signer_id {
        return Err(bad("transfer to yourself"));
    }
    if tx.nonce == 0 {
        return Err(bad("zero nonce"));
    }
    let receiver_kind = near_account_kind(&tx.receiver_id)?;
    let mut warnings = Vec::new();
    let token = match &tx.ft {
        None => {
            if tx.deposit == 0 {
                return Err(bad("zero amount"));
            }
            if tx.deposit > MAX_DEPOSIT {
                return Err(bad("implausible amount"));
            }
            if receiver_kind == NearAccountKind::EthImplicit {
                warnings.push(NearWarning::EthImplicitReceiver);
            }
            None
        }
        Some(f) => {
            let (k, testnet) = near_known_token(&tx.receiver_id)
                .ok_or_else(|| bad("token contract unknown to Kyro"))?;
            if f.amount == 0 {
                return Err(bad("zero amount"));
            }
            if f.recipient == tx.signer_id {
                return Err(bad("transfer to yourself"));
            }
            let recipient_kind = near_account_kind(&f.recipient)?;
            if recipient_kind == NearAccountKind::EthImplicit {
                warnings.push(NearWarning::EthImplicitReceiver);
            }
            Some(NearTokenSummary {
                contract: k.contract.into(),
                symbol: k.symbol.into(),
                name: k.name.into(),
                decimals: k.decimals,
                testnet,
                recipient: f.recipient.clone(),
                recipient_kind,
                amount: f.amount.to_string(),
                storage_deposit: f.storage_deposit.map(|d| d.to_string()),
            })
        }
    };
    Ok(NearTxSummary {
        signer_id: tx.signer_id.clone(),
        public_key: near_public_key_string(&tx.public_key),
        nonce: tx.nonce.to_string(),
        receiver_id: tx.receiver_id.clone(),
        receiver_kind,
        deposit: tx.attached().to_string(),
        block_hash: near_hash_string(&tx.block_hash),
        hash: near_hash_string(&tx.hash()),
        requires_extra_confirmation: !warnings.is_empty(),
        warnings,
        token,
    })
}

fn unhex(s: &str) -> Result<Vec<u8>> {
    hex::decode(s.trim()).map_err(|_| Error::input("NEAR transaction: hexadecimal expected"))
}

/// Decodes an **unsigned** transfer (hex Borsh) for the dialog.
pub fn near_decode_tx(
    tx_hex: &str,
    our_account: &str,
    our_pubkey: &[u8; 32],
) -> Result<NearTxSummary> {
    summarize(
        &NearTransfer::decode(&unhex(tx_hex)?)?,
        our_account,
        our_pubkey,
    )
}

/// Signs a transfer (hex Borsh) with `account`'s key after [`near_decode_tx`] for its account.
pub fn near_sign(
    seed: &Seed,
    account: u32,
    tx_hex: &str,
) -> Result<(String, String, NearTxSummary)> {
    let key = signing_key(seed, account)?;
    let pk = key.verifying_key().to_bytes();
    let tx = NearTransfer::decode(&unhex(tx_hex)?)?;
    let summary = summarize(&tx, &hex::encode(pk), &pk)?;
    let hash = tx.hash();
    let sig = key.sign(&hash);
    key.verifying_key()
        .verify_strict(&hash, &sig)
        .map_err(|_| Error::crypto("signature verification failed"))?;
    let signed = tx.encode_signed(&sig.to_bytes());
    Ok((hex::encode(signed), near_hash_string(&hash), summary))
}

/// Checks a signed tx: strict decode, strict ed25519 sig, key = implicit signer's.
pub fn near_verify_signed(signed_hex: &str) -> Result<(NearTransfer, String)> {
    let (tx, sig) = NearTransfer::decode_signed(&unhex(signed_hex)?)?;
    let key = ed25519_dalek::VerifyingKey::from_bytes(&tx.public_key)
        .map_err(|_| bad("invalid public key"))?;
    let hash = tx.hash();
    key.verify_strict(&hash, &ed25519_dalek::Signature::from_bytes(&sig))
        .map_err(|_| bad("the signature does not verify"))?;
    if near_account_kind(&tx.signer_id)? == NearAccountKind::Implicit
        && tx.signer_id != hex::encode(tx.public_key)
    {
        return Err(bad("the key does not match the signing implicit account"));
    }
    Ok((tx, near_hash_string(&hash)))
}

/// Ledger NEAR app: the strictly decoded Borsh tx (the app signs its SHA-256).
pub fn near_hw_message(tx_hex: &str) -> Result<Vec<u8>> {
    let raw = unhex(tx_hex)?;
    NearTransfer::decode(&raw)?;
    Ok(raw)
}

/// HW: signed tx (hex) and hash (base58) from the device sig, checked by [`near_verify_signed`].
pub fn near_hw_signed(tx_hex: &str, sig: &[u8]) -> Result<(String, String)> {
    let sig: [u8; 64] = sig
        .try_into()
        .map_err(|_| bad("device signature: 64 bytes expected"))?;
    let tx = NearTransfer::decode(&unhex(tx_hex)?)?;
    let signed = hex::encode(tx.encode_signed(&sig));
    let (_, hash) = near_verify_signed(&signed)?;
    Ok((signed, hash))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn account_ids() {
        use NearAccountKind::*;
        for (id, kind) in [
            ("alice.near", Named),
            ("bob.testnet", Named),
            ("aa", Named),
            ("a-b_c.d", Named),
            ("aurora", Named),
            (
                "98793cd91a3f870fb126f66285808c7e094afcfc4eda8a970f6648cdf0dbd6de",
                Implicit,
            ),
            ("0x2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", EthImplicit),
        ] {
            assert_eq!(near_account_kind(id).unwrap(), kind, "{id}");
        }
        for id in [
            "a",
            "",
            "Alice.near",
            ".near",
            "alice.",
            "alice..near",
            "a-.b",
            "_a",
            "alice near",
            "alicé.near",
            &"a".repeat(65),
            "0x2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        ] {
            assert!(near_account_kind(id).is_err(), "{id:?}");
        }
        // Uppercase hex is not an implicit account (nor a valid id at all).
        assert!(near_account_kind(&"A".repeat(64)).is_err());
    }

    #[test]
    fn transaction_v1_and_other_actions_are_refused() {
        let tx = NearTransfer {
            signer_id: "test.near".into(),
            public_key: [7; 32],
            nonce: 1,
            receiver_id: "whatever.near".into(),
            block_hash: [9; 32],
            deposit: 1,
            ft: None,
        };
        let raw = tx.encode();
        assert_eq!(NearTransfer::decode(&raw).unwrap(), tx);
        // V1 prefix.
        let mut v1 = vec![1u8];
        v1.extend_from_slice(&raw);
        let e = NearTransfer::decode(&v1).unwrap_err().to_string();
        assert!(e.contains("TransactionV1"), "{e}");
        // Trailing byte.
        let mut t = raw.clone();
        t.push(0);
        assert!(NearTransfer::decode(&t).is_err());
        // Two actions.
        let actions_at = raw.len() - 1 - 16 - 4;
        let mut two = raw.clone();
        two[actions_at] = 2;
        assert!(NearTransfer::decode(&two).is_err());
        // FunctionCall instead of Transfer.
        let mut fc = raw.clone();
        fc[actions_at + 4] = 2;
        let e = NearTransfer::decode(&fc).unwrap_err().to_string();
        assert!(e.contains("FunctionCall"), "{e}");
        // secp256k1 key type.
        let mut k = raw.clone();
        k[4 + 9] = 1;
        assert!(NearTransfer::decode(&k).is_err());
        // Truncated.
        assert!(NearTransfer::decode(&raw[..raw.len() - 1]).is_err());
    }
}
