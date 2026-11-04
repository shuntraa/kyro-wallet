//! Aptos delegation pools: `0x1::delegation_pool::{add_stake, unlock, withdraw}`, the only calls
//! outside payments Kyro signs on Aptos. Same strict BCS as [`crate::aptos`]:
//!
//! ```text
//! RawTransaction {
//!   sender, sequence_number,
//!   payload: EntryFunction(0x1::delegation_pool::<function>, ty_args: [],
//!            args: [bcs(address pool), bcs(u64 amount)]),
//!   max_gas_amount, gas_unit_price, expiration_timestamp_secs, chain_id,
//! }
//! ```
//!
//! The pool is framework code at `0x1`: there is no third-party contract to trust. `withdraw` pays
//! the sender (the function has no recipient argument). The payment path ([`crate::AptosTransfer`])
//! keeps refusing these calls.

use ed25519_dalek::Signer as _;
use serde::{Deserialize, Serialize};

use crate::aptos::{
    aptos_address_bytes_of_pubkey, aptos_address_string, aptos_parse_address,
    aptos_signing_message, aptos_tx_hash, bad, put_bytes, put_uleb, signing_key, unhex, Reader,
    MAX_BCS,
};
use crate::error::{Error, Result};
use crate::mnemonic::Seed;

const MODULE: &[u8] = b"delegation_pool";

/// The pool function called.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AptosStakeCall {
    /// `add_stake`: delegates `amount` to the pool.
    AddStake,
    /// `unlock`: active stake becomes pending until the pool's lockup ends.
    Unlock,
    /// `withdraw`: inactive stake returns to the sender.
    Withdraw,
}

impl AptosStakeCall {
    fn name(self) -> &'static str {
        match self {
            AptosStakeCall::AddStake => "add_stake",
            AptosStakeCall::Unlock => "unlock",
            AptosStakeCall::Withdraw => "withdraw",
        }
    }

    fn parse(name: &[u8]) -> Result<AptosStakeCall> {
        match name {
            b"add_stake" => Ok(AptosStakeCall::AddStake),
            b"unlock" => Ok(AptosStakeCall::Unlock),
            b"withdraw" => Ok(AptosStakeCall::Withdraw),
            other => Err(bad(format!(
                "delegation_pool::{} refused: Kyro only stakes, unlocks and withdraws",
                String::from_utf8_lossy(other)
            ))),
        }
    }
}

/// A delegation-pool transaction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AptosStakeTx {
    /// Sender (pays the gas: no fee payer).
    pub sender: [u8; 32],
    /// Sender's sequence number.
    pub sequence_number: u64,
    /// The function.
    pub call: AptosStakeCall,
    /// Pool address.
    pub pool: [u8; 32],
    /// Octas.
    pub amount: u64,
    /// Gas units at most.
    pub max_gas_amount: u64,
    /// Octas per gas unit.
    pub gas_unit_price: u64,
    /// UNIX seconds after which the transaction is void.
    pub expiration_timestamp_secs: u64,
    /// 1 mainnet, 2 testnet.
    pub chain_id: u8,
}

impl AptosStakeTx {
    fn check(&self) -> Result<()> {
        if self.amount == 0 {
            return Err(bad("zero amount"));
        }
        if self.max_gas_amount == 0 || self.gas_unit_price == 0 {
            return Err(bad("zero gas"));
        }
        if self
            .max_gas_amount
            .checked_mul(self.gas_unit_price)
            .is_none()
        {
            return Err(bad("max fee out of range"));
        }
        if self.chain_id == 0 {
            return Err(bad("zero chain ID"));
        }
        Ok(())
    }

    /// Max fee in octas.
    pub fn max_fee(&self) -> u64 {
        self.max_gas_amount.saturating_mul(self.gas_unit_price)
    }

    /// BCS of the `RawTransaction`.
    pub fn encode(&self) -> Result<Vec<u8>> {
        self.check()?;
        let mut o = Vec::with_capacity(160);
        o.extend_from_slice(&self.sender);
        o.extend_from_slice(&self.sequence_number.to_le_bytes());
        o.push(2); // TransactionPayload::EntryFunction
        let mut module_address = [0u8; 32];
        module_address[31] = 1;
        o.extend_from_slice(&module_address);
        put_bytes(&mut o, MODULE);
        put_bytes(&mut o, self.call.name().as_bytes());
        put_uleb(&mut o, 0); // no type argument
        put_uleb(&mut o, 2);
        put_bytes(&mut o, &self.pool);
        put_bytes(&mut o, &self.amount.to_le_bytes());
        o.extend_from_slice(&self.max_gas_amount.to_le_bytes());
        o.extend_from_slice(&self.gas_unit_price.to_le_bytes());
        o.extend_from_slice(&self.expiration_timestamp_secs.to_le_bytes());
        o.push(self.chain_id);
        Ok(o)
    }

    /// Strict decoding; the result re-encodes to exactly `bcs` (checked).
    pub fn decode(bcs: &[u8]) -> Result<AptosStakeTx> {
        if bcs.len() > MAX_BCS {
            return Err(bad("too large"));
        }
        let mut r = Reader(bcs);
        let sender = r.arr32()?;
        let sequence_number = r.u64()?;
        if r.uleb()? != 2 {
            return Err(bad("entry function expected"));
        }
        let mut framework = [0u8; 32];
        framework[31] = 1;
        if r.arr32()? != framework || r.bytes(128)? != MODULE {
            return Err(bad("module other than 0x1::delegation_pool: refused"));
        }
        let call = AptosStakeCall::parse(r.bytes(128)?)?;
        if r.uleb()? != 0 {
            return Err(bad("type arguments: not supported"));
        }
        if r.uleb()? != 2 {
            return Err(bad("unexpected number of arguments"));
        }
        let pool: [u8; 32] = r
            .bytes(64)?
            .try_into()
            .map_err(|_| bad("pool: 32 bytes expected"))?;
        let amount = u64::from_le_bytes(
            r.bytes(64)?
                .try_into()
                .map_err(|_| bad("amount: u64 expected"))?,
        );
        let max_gas_amount = r.u64()?;
        let gas_unit_price = r.u64()?;
        let expiration_timestamp_secs = r.u64()?;
        let chain_id = r.u8()?;
        if !r.0.is_empty() {
            return Err(bad("trailing bytes after the transaction"));
        }
        let t = AptosStakeTx {
            sender,
            sequence_number,
            call,
            pool,
            amount,
            max_gas_amount,
            gas_unit_price,
            expiration_timestamp_secs,
            chain_id,
        };
        if t.encode()? != bcs {
            return Err(bad("re-encoding differs"));
        }
        Ok(t)
    }

    /// Signed transaction bytes with a single ed25519 authenticator.
    pub fn signed_bytes(&self, pubkey: &[u8; 32], signature: &[u8; 64]) -> Result<Vec<u8>> {
        let mut o = self.encode()?;
        o.push(0); // TransactionAuthenticator::Ed25519
        put_bytes(&mut o, pubkey);
        put_bytes(&mut o, signature);
        Ok(o)
    }
}

/// Decoded staking transaction, for the dialog and the UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AptosStakeSummary {
    /// Sender (checked: ours).
    pub sender: String,
    /// The function.
    pub call: AptosStakeCall,
    /// Pool, full `0x` + 64 hex.
    pub pool: String,
    /// Octas, decimal.
    pub amount: String,
    /// Decimal.
    pub sequence_number: String,
    /// Gas units at most, decimal.
    pub max_gas_amount: String,
    /// Octas per gas unit, decimal.
    pub gas_unit_price: String,
    /// `max_gas_amount × gas_unit_price`, octas, decimal.
    pub max_fee: String,
    /// UNIX seconds.
    pub expiration_timestamp_secs: u64,
    /// 1 mainnet, 2 testnet.
    pub chain_id: u8,
}

fn summarize(t: &AptosStakeTx, ours: &[u8; 32]) -> Result<AptosStakeSummary> {
    if &t.sender != ours {
        return Err(bad("the sender is not this account's address"));
    }
    Ok(AptosStakeSummary {
        sender: aptos_address_string(&t.sender),
        call: t.call,
        pool: aptos_address_string(&t.pool),
        amount: t.amount.to_string(),
        sequence_number: t.sequence_number.to_string(),
        max_gas_amount: t.max_gas_amount.to_string(),
        gas_unit_price: t.gas_unit_price.to_string(),
        max_fee: t.max_fee().to_string(),
        expiration_timestamp_secs: t.expiration_timestamp_secs,
        chain_id: t.chain_id,
    })
}

/// Decodes an unsigned staking transaction (hex BCS) of `our_address`.
pub fn aptos_stake_decode(raw_hex: &str, our_address: &str) -> Result<AptosStakeSummary> {
    let raw = unhex(raw_hex, "transaction")?;
    summarize(
        &AptosStakeTx::decode(&raw)?,
        &aptos_parse_address(our_address)?,
    )
}

/// Signs with `account`'s key: `(signed hex, hash, summary)`.
pub fn aptos_stake_sign(
    seed: &Seed,
    account: u32,
    raw_hex: &str,
) -> Result<(String, String, AptosStakeSummary)> {
    let raw = unhex(raw_hex, "transaction")?;
    let t = AptosStakeTx::decode(&raw)?;
    let key = signing_key(seed, account)?;
    let pk = key.verifying_key();
    let summary = summarize(&t, &aptos_address_bytes_of_pubkey(pk.as_bytes()))?;
    let msg = aptos_signing_message(&raw);
    let sig = key.sign(&msg);
    pk.verify_strict(&msg, &sig)
        .map_err(|_| Error::crypto("signature verification failed"))?;
    let signed = t.signed_bytes(pk.as_bytes(), &sig.to_bytes())?;
    Ok((hex::encode(&signed), aptos_tx_hash(&signed), summary))
}

/// `/transactions/simulate` body: zero signature (nodes refuse to simulate validly signed txs).
pub fn aptos_stake_simulation_bytes(raw_hex: &str, pubkey: &[u8; 32]) -> Result<Vec<u8>> {
    let raw = unhex(raw_hex, "transaction")?;
    AptosStakeTx::decode(&raw)?.signed_bytes(pubkey, &[0u8; 64])
}

/// Pre-send check: strict decode, single ed25519 sender key, strict signature: `(hash, tx)`.
pub fn aptos_stake_verify_signed(signed_hex: &str) -> Result<(String, AptosStakeTx)> {
    let signed = unhex(signed_hex, "signed transaction")?;
    if signed.len() < 99 {
        return Err(bad("truncated signed transaction"));
    }
    let (raw, auth) = signed.split_at(signed.len() - 99);
    if auth[0] != 0 || auth[1] != 32 || auth[34] != 64 {
        return Err(bad("authenticator: a single ed25519 key expected"));
    }
    let t = AptosStakeTx::decode(raw)?;
    let mut pk = [0u8; 32];
    pk.copy_from_slice(&auth[2..34]);
    let mut sig = [0u8; 64];
    sig.copy_from_slice(&auth[35..99]);
    if aptos_address_bytes_of_pubkey(&pk) != t.sender {
        return Err(bad("the signature's key is not the sender's"));
    }
    ed25519_dalek::VerifyingKey::from_bytes(&pk)
        .map_err(|_| bad("invalid public key"))?
        .verify_strict(
            &aptos_signing_message(raw),
            &ed25519_dalek::Signature::from_bytes(&sig),
        )
        .map_err(|_| bad("the signature does not verify"))?;
    Ok((aptos_tx_hash(&signed), t))
}
