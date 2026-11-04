//! Paying a BOLT11 invoice through a submarine swap (Boltz API v2 backend): decoding the invoice,
//! checking the provider's lockup terms, the refund key, and the script-path refund.
//!
//! No network and no files here. The lockup address is rebuilt from what the provider sent: the
//! claim leaf needs the invoice's preimage, the refund leaf needs our key after the timeout, and
//! the internal key is a MuSig2 aggregate that includes our key, so the provider cannot use the key
//! path alone. Key aggregation is the `musig2` crate; Kyro never signs a MuSig2 session.

use core::str::FromStr;

use bitcoin::absolute::LockTime;
use bitcoin::bip32::ChildNumber;
use bitcoin::consensus::encode::serialize_hex;
use bitcoin::hashes::{ripemd160, Hash};
use bitcoin::key::{Keypair, XOnlyPublicKey};
use bitcoin::opcodes::all::{OP_CHECKSIG, OP_CHECKSIGVERIFY, OP_CLTV, OP_EQUALVERIFY, OP_HASH160};
use bitcoin::script::Builder;
use bitcoin::secp256k1::{Message, PublicKey};
use bitcoin::sighash::{Prevouts, SighashCache, TapSighashType};
use bitcoin::taproot::{LeafVersion, Signature, TaprootBuilder, TaprootSpendInfo};
use bitcoin::transaction::Version;
use bitcoin::{
    Address, Amount, KnownHrp, OutPoint, ScriptBuf, Sequence, TapLeafHash, Transaction, TxIn,
    TxOut, Txid, Witness,
};
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use lightning_invoice::{Bolt11Invoice, Bolt11InvoiceDescriptionRef, Currency};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::display::sanitize_text;
use crate::error::{Error, Result};
use crate::keys::{hardened, random32, secp, XprivGuard};
use crate::mnemonic::Seed;
use crate::network::Network;

/// Least life an invoice must have left when the swap is accepted. Providers refuse under 30
/// minutes (measured 2026-11-04); the deposit needs one confirmation, so Kyro asks for an hour.
pub const LN_MIN_INVOICE_MARGIN_SECS: u64 = 3_600;
/// Blocks between the tip and the refund timeout: providers gave 1,008 on 2026-11-04.
pub const LN_MIN_TIMEOUT_BLOCKS: u64 = 144;
pub const LN_MAX_TIMEOUT_BLOCKS: u64 = 1_440;
/// Hard cap on the provider's fee, whatever the interface says: 3% + 3,000 sat.
pub const LN_MAX_FEE_BPS: u64 = 300;
pub const LN_MAX_FEE_BASE_SAT: u64 = 3_000;
/// Highest refund fee rate, sat per vB.
pub const LN_MAX_REFUND_FEE_RATE: u64 = 500;
const MAX_INVOICE_LEN: usize = 4_096;
const DUST_SAT: u64 = 546;
const MAX_REFUND_INPUTS: usize = 20;
/// Not a registered BIP43 purpose: 9735 is Lightning's port, used here only to keep these keys
/// apart from every account path. Refund keys: purpose / coin / 0 / index, state key: purpose /
/// coin / 1, all hardened.
const LN_PURPOSE: u32 = 9_735;

/// What Rust read in an invoice, signature checked.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LnInvoice {
    /// The invoice as it was parsed, lowercase, without `lightning:`.
    pub invoice: String,
    /// Amount of the invoice, millisatoshis.
    pub amount_msat: u64,
    /// Rounded up to a whole satoshi.
    pub amount_sat: u64,
    /// SHA-256 of the preimage, hex.
    pub payment_hash: String,
    /// Node the payment goes to (hex).
    pub payee: String,
    /// Sanitized free text from the invoice's author, if any.
    pub description: Option<String>,
    /// Creation time, Unix seconds.
    pub created_at: u64,
    /// Expiry time, Unix seconds.
    pub expires_at: u64,
}

fn currency(net: Network) -> Currency {
    match net {
        Network::Mainnet => Currency::Bitcoin,
        Network::Testnet => Currency::BitcoinTestnet,
    }
}

fn parse_invoice(text: &str) -> Result<Bolt11Invoice> {
    let t = text.trim().to_ascii_lowercase();
    let t = t.strip_prefix("lightning:").unwrap_or(&t);
    if t.is_empty() || t.len() > MAX_INVOICE_LEN {
        return Err(Error::input("not a Lightning invoice"));
    }
    // Parsing checks the checksum and the node's signature.
    Bolt11Invoice::from_str(t).map_err(|_| Error::input("not a valid Lightning invoice"))
}

/// Decodes `text` and refuses what Kyro cannot pay: wrong network, no amount, expired.
pub fn ln_decode_invoice(text: &str, net: Network, now_secs: u64) -> Result<LnInvoice> {
    let inv = parse_invoice(text)?;
    if inv.currency() != currency(net) {
        return Err(Error::input("this invoice is for another network"));
    }
    let amount_msat = inv
        .amount_milli_satoshis()
        .filter(|a| *a > 0)
        .ok_or_else(|| Error::input("this invoice has no amount"))?;
    let created_at = inv.duration_since_epoch().as_secs();
    let expires_at = created_at.saturating_add(inv.expiry_time().as_secs());
    if expires_at <= now_secs {
        return Err(Error::input("this invoice has expired"));
    }
    let description = match inv.description() {
        Bolt11InvoiceDescriptionRef::Direct(d) => {
            let s = d.to_string();
            (!s.is_empty()).then(|| sanitize_text(&s, 120).text)
        }
        Bolt11InvoiceDescriptionRef::Hash(_) => None,
    };
    Ok(LnInvoice {
        invoice: inv.to_string(),
        amount_msat,
        amount_sat: amount_msat.div_ceil(1_000),
        payment_hash: inv.payment_hash().to_string(),
        payee: inv.get_payee_pub_key().to_string(),
        description,
        created_at,
        expires_at,
    })
}

fn derive(seed: &Seed, net: Network, path: &[ChildNumber]) -> Result<XprivGuard> {
    let secp = secp()?;
    XprivGuard::master(seed, net.btc_kind())?.derive(&secp, path)
}

fn refund_key(seed: &Seed, net: Network, index: u32) -> Result<XprivGuard> {
    derive(
        seed,
        net,
        &[
            hardened(LN_PURPOSE)?,
            hardened(net.btc_coin_type())?,
            hardened(0)?,
            hardened(index)?,
        ],
    )
}

/// Compressed refund public key number `index`, hex.
pub fn ln_refund_public_key(seed: &Seed, net: Network, index: u32) -> Result<String> {
    let secp = secp()?;
    let key = refund_key(seed, net, index)?;
    Ok(key.xpriv().private_key.public_key(&secp).to_string())
}

fn state_cipher(seed: &Seed, net: Network) -> Result<XChaCha20Poly1305> {
    let key = derive(
        seed,
        net,
        &[
            hardened(LN_PURPOSE)?,
            hardened(net.btc_coin_type())?,
            hardened(1)?,
        ],
    )?;
    let bytes = Zeroizing::new(key.xpriv().private_key.secret_bytes());
    XChaCha20Poly1305::new_from_slice(&bytes[..]).map_err(|_| Error::crypto("bad key length"))
}

/// Encrypts the swap list with a key derived from the seed: nonce (24 bytes), then the ciphertext.
pub fn ln_seal_state(seed: &Seed, net: Network, plain: &[u8]) -> Result<Vec<u8>> {
    let cipher = state_cipher(seed, net)?;
    let mut nonce = [0u8; 24];
    getrandom::getrandom(&mut nonce).map_err(|_| Error::crypto("OS randomness unavailable"))?;
    let ct = cipher
        .encrypt(XNonce::from_slice(&nonce), plain)
        .map_err(|_| Error::crypto("encryption failed"))?;
    Ok([nonce.as_slice(), ct.as_slice()].concat())
}

/// Opposite of [`ln_seal_state`]. A modified file or another wallet's file gives an error.
pub fn ln_open_state(seed: &Seed, net: Network, data: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    if data.len() < 24 {
        return Err(Error::crypto("swap state unreadable"));
    }
    let (nonce, ct) = data.split_at(24);
    state_cipher(seed, net)?
        .decrypt(XNonce::from_slice(nonce), ct)
        .map(Zeroizing::new)
        .map_err(|_| Error::crypto("swap state unreadable"))
}

/// The provider's answer to `POST /v2/swap/submarine`, in the shape Kyro keeps it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LnSwapTerms {
    /// The provider's swap id.
    pub id: String,
    /// Lockup address.
    pub address: String,
    /// Satoshis to deposit at the lockup address.
    pub expected_amount: u64,
    /// The provider's key, compressed, hex.
    pub claim_public_key: String,
    /// Claim script, hex.
    pub claim_leaf: String,
    /// Refund script, hex.
    pub refund_leaf: String,
    /// Height from which the refund leaf can be spent.
    pub timeout_block_height: u64,
}

/// What the checks established.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LnSwapChecked {
    /// Lockup address.
    pub address: String,
    /// Satoshis to deposit at the lockup address.
    pub expected_amount: u64,
    /// Amount of the invoice, satoshis.
    pub invoice_sat: u64,
    /// The provider's fee and miner fee, satoshis.
    pub provider_fee_sat: u64,
    /// Height from which the refund leaf can be spent.
    pub timeout_block_height: u64,
    /// Expiry time, Unix seconds.
    pub expires_at: u64,
}

fn hex_bytes(s: &str, what: &str) -> Result<Vec<u8>> {
    hex::decode(s).map_err(|_| Error::input(format!("swap {what} is not hexadecimal")))
}

fn claim_key(hex_key: &str) -> Result<PublicKey> {
    PublicKey::from_slice(&hex_bytes(hex_key, "claim key")?)
        .map_err(|_| Error::input("swap claim key is invalid"))
}

fn x_only(k: &PublicKey) -> XOnlyPublicKey {
    k.x_only_public_key().0
}

fn expected_claim_leaf(payment_hash: &[u8; 32], claim: &PublicKey) -> ScriptBuf {
    let h = ripemd160::Hash::hash(payment_hash).to_byte_array();
    Builder::new()
        .push_opcode(OP_HASH160)
        .push_slice(h)
        .push_opcode(OP_EQUALVERIFY)
        .push_x_only_key(&x_only(claim))
        .push_opcode(OP_CHECKSIG)
        .into_script()
}

fn expected_refund_leaf(refund: &PublicKey, timeout: u64) -> Result<ScriptBuf> {
    let t = i64::try_from(timeout).map_err(|_| Error::input("swap timeout out of range"))?;
    Ok(Builder::new()
        .push_x_only_key(&x_only(refund))
        .push_opcode(OP_CHECKSIGVERIFY)
        .push_int(t)
        .push_opcode(OP_CLTV)
        .into_script())
}

fn spend_info(
    claim: &PublicKey,
    refund: &PublicKey,
    claim_leaf: ScriptBuf,
    refund_leaf: ScriptBuf,
) -> Result<TaprootSpendInfo> {
    let point = |k: &PublicKey| {
        musig2::secp::Point::try_from(k.serialize().as_slice())
            .map_err(|_| Error::input("swap key is invalid"))
    };
    // The order is the provider's: claim key, then refund key (checked on live answers).
    let agg = musig2::KeyAggContext::new([point(claim)?, point(refund)?])
        .map_err(|_| Error::input("swap keys cannot be aggregated"))?;
    let internal: musig2::secp::Point = agg.aggregated_pubkey();
    let internal = XOnlyPublicKey::from_slice(&internal.serialize_xonly())
        .map_err(|_| Error::crypto("aggregate key"))?;
    let secp = secp()?;
    TaprootBuilder::new()
        .add_leaf(1, claim_leaf)
        .and_then(|b| b.add_leaf(1, refund_leaf))
        .map_err(|_| Error::crypto("taproot tree"))?
        .finalize(&secp, internal)
        .map_err(|_| Error::crypto("taproot tree"))
}

fn hrp(net: Network) -> KnownHrp {
    match net {
        Network::Mainnet => KnownHrp::Mainnet,
        Network::Testnet => KnownHrp::Testnets,
    }
}

/// Everything that must hold before a single satoshi goes to the lockup address.
pub fn ln_check_swap(
    invoice: &LnInvoice,
    terms: &LnSwapTerms,
    refund_public_key: &str,
    net: Network,
    tip_height: u64,
    now_secs: u64,
) -> Result<LnSwapChecked> {
    if invoice.expires_at < now_secs.saturating_add(LN_MIN_INVOICE_MARGIN_SECS) {
        return Err(Error::input(
            "this invoice expires too soon to be paid from the chain",
        ));
    }
    if terms.id.is_empty()
        || terms.id.len() > 64
        || !terms.id.chars().all(|c| c.is_ascii_alphanumeric())
    {
        return Err(Error::input("swap id is invalid"));
    }
    let lock = terms.timeout_block_height;
    if lock < tip_height.saturating_add(LN_MIN_TIMEOUT_BLOCKS)
        || lock > tip_height.saturating_add(LN_MAX_TIMEOUT_BLOCKS)
    {
        return Err(Error::input("swap timeout outside the accepted range"));
    }
    if terms.expected_amount <= invoice.amount_sat {
        return Err(Error::input("swap amount is below the invoice"));
    }
    let fee = terms.expected_amount - invoice.amount_sat;
    let cap = invoice.amount_sat.saturating_mul(LN_MAX_FEE_BPS) / 10_000 + LN_MAX_FEE_BASE_SAT;
    if fee > cap {
        return Err(Error::input("swap fee is too high"));
    }
    let hash: [u8; 32] = hex_bytes(&invoice.payment_hash, "hash")?
        .try_into()
        .map_err(|_| Error::input("payment hash is invalid"))?;
    let claim = claim_key(&terms.claim_public_key)?;
    let refund = PublicKey::from_slice(&hex_bytes(refund_public_key, "refund key")?)
        .map_err(|_| Error::input("refund key is invalid"))?;
    if x_only(&claim) == x_only(&refund) {
        return Err(Error::input("swap claim key is our own key"));
    }
    let claim_leaf = expected_claim_leaf(&hash, &claim);
    if hex_bytes(&terms.claim_leaf, "claim leaf")? != claim_leaf.as_bytes() {
        return Err(Error::input(
            "the provider's claim script is not tied to this invoice",
        ));
    }
    let refund_leaf = expected_refund_leaf(&refund, lock)?;
    if hex_bytes(&terms.refund_leaf, "refund leaf")? != refund_leaf.as_bytes() {
        return Err(Error::input(
            "the provider's refund script does not pay your key",
        ));
    }
    let info = spend_info(&claim, &refund, claim_leaf, refund_leaf)?;
    let address = Address::p2tr_tweaked(info.output_key(), hrp(net));
    if address.to_string() != terms.address {
        return Err(Error::input(
            "the deposit address does not match the swap's scripts",
        ));
    }
    Ok(LnSwapChecked {
        address: terms.address.clone(),
        expected_amount: terms.expected_amount,
        invoice_sat: invoice.amount_sat,
        provider_fee_sat: fee,
        timeout_block_height: lock,
        expires_at: invoice.expires_at,
    })
}

/// A coin sitting at the lockup address.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct LnLockedCoin {
    /// Transaction id.
    pub txid: String,
    /// Output index.
    pub vout: u32,
    /// Amount, satoshis.
    pub value: u64,
}

/// A signed refund, ready to broadcast.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LnRefund {
    /// Signed transaction, hex.
    pub hex: String,
    /// Transaction id.
    pub txid: String,
    /// Address the refund pays.
    pub destination: String,
    /// Satoshis paid back.
    pub amount_sat: u64,
    /// Network fee, satoshis.
    pub fee_sat: u64,
    /// Virtual size, vB.
    pub vsize: u64,
}

fn refund_shell(coins: &[OutPoint], lock: LockTime, out: TxOut) -> Transaction {
    Transaction {
        version: Version::TWO,
        lock_time: lock,
        input: coins
            .iter()
            .map(|o| TxIn {
                previous_output: *o,
                script_sig: ScriptBuf::new(),
                // Below final, so `lock_time` applies.
                sequence: Sequence::ENABLE_RBF_NO_LOCKTIME,
                witness: Witness::new(),
            })
            .collect(),
        output: vec![out],
    }
}

/// Spends the lockup coins back through the refund leaf, once the timeout has passed. Needs no
/// provider. `destination` must come from Rust: one of the wallet's own addresses.
#[allow(clippy::too_many_arguments)]
pub fn ln_refund_tx(
    seed: &Seed,
    net: Network,
    terms: &LnSwapTerms,
    key_index: u32,
    coins: &[LnLockedCoin],
    destination: &str,
    fee_rate: u64,
    tip_height: u64,
) -> Result<LnRefund> {
    if tip_height < terms.timeout_block_height {
        return Err(Error::input("the refund timeout has not passed yet"));
    }
    if coins.is_empty() || coins.len() > MAX_REFUND_INPUTS {
        return Err(Error::input("no coin to refund at this address"));
    }
    if fee_rate == 0 || fee_rate > LN_MAX_REFUND_FEE_RATE {
        return Err(Error::input("refund fee rate out of range"));
    }
    let lock = u32::try_from(terms.timeout_block_height)
        .ok()
        .and_then(|h| LockTime::from_height(h).ok())
        .ok_or_else(|| Error::input("swap timeout out of range"))?;
    let secp = secp()?;
    let key = refund_key(seed, net, key_index)?;
    let sk = &key.xpriv().private_key;
    let refund = sk.public_key(&secp);
    let claim = claim_key(&terms.claim_public_key)?;
    let refund_leaf = ScriptBuf::from_bytes(hex_bytes(&terms.refund_leaf, "refund leaf")?);
    if refund_leaf != expected_refund_leaf(&refund, terms.timeout_block_height)? {
        return Err(Error::input("this swap does not use this refund key"));
    }
    let claim_leaf = ScriptBuf::from_bytes(hex_bytes(&terms.claim_leaf, "claim leaf")?);
    let info = spend_info(&claim, &refund, claim_leaf, refund_leaf.clone())?;
    let lockup = Address::p2tr_tweaked(info.output_key(), hrp(net));
    if lockup.to_string() != terms.address {
        return Err(Error::input("the swap's scripts do not match its address"));
    }
    let control = info
        .control_block(&(refund_leaf.clone(), LeafVersion::TapScript))
        .ok_or_else(|| Error::crypto("control block"))?;
    let dest = Address::from_str(destination)
        .map_err(|_| Error::input("refund address is invalid"))?
        .require_network(net.btc())
        .map_err(|_| Error::input("refund address is for another network"))?;
    let outpoints = coins
        .iter()
        .map(|c| {
            Txid::from_str(&c.txid)
                .map(|txid| OutPoint { txid, vout: c.vout })
                .map_err(|_| Error::input("coin id is invalid"))
        })
        .collect::<Result<Vec<_>>>()?;
    let total = coins
        .iter()
        .try_fold(0u64, |a, c| a.checked_add(c.value))
        .ok_or_else(|| Error::input("coin amounts overflow"))?;
    let prevouts: Vec<TxOut> = coins
        .iter()
        .map(|c| TxOut {
            value: Amount::from_sat(c.value),
            script_pubkey: lockup.script_pubkey(),
        })
        .collect();

    // Size from a transaction with the final witness shape: the fee follows from it.
    let output = |sat: u64| TxOut {
        value: Amount::from_sat(sat),
        script_pubkey: dest.script_pubkey(),
    };
    let mut sized = refund_shell(&outpoints, lock, output(total));
    for i in &mut sized.input {
        i.witness.push([0u8; 64]);
        i.witness.push(refund_leaf.as_bytes());
        i.witness.push(control.serialize());
    }
    let vsize = sized.vsize() as u64;
    let fee = vsize.saturating_mul(fee_rate);
    let amount = total
        .checked_sub(fee)
        .filter(|a| *a >= DUST_SAT)
        .ok_or_else(|| Error::input("these coins cannot pay the refund's network fee"))?;

    let mut tx = refund_shell(&outpoints, lock, output(amount));
    let leaf = TapLeafHash::from_script(&refund_leaf, LeafVersion::TapScript);
    let keypair = Keypair::from_secret_key(&secp, sk);
    let (xonly, _) = keypair.x_only_public_key();
    let mut sigs = Vec::with_capacity(coins.len());
    let mut cache = SighashCache::new(&tx);
    for i in 0..coins.len() {
        let hash = cache
            .taproot_script_spend_signature_hash(
                i,
                &Prevouts::All(&prevouts),
                leaf,
                TapSighashType::Default,
            )
            .map_err(|_| Error::crypto("sighash"))?;
        let msg = Message::from_digest(hash.to_byte_array());
        let aux = random32()?;
        let signature = secp.sign_schnorr_with_aux_rand(&msg, &keypair, &aux);
        secp.verify_schnorr(&signature, &msg, &xonly)
            .map_err(|_| Error::crypto("refund signature did not verify"))?;
        sigs.push(Signature {
            signature,
            sighash_type: TapSighashType::Default,
        });
    }
    for (input, sig) in tx.input.iter_mut().zip(sigs) {
        input.witness.push(sig.to_vec());
        input.witness.push(refund_leaf.as_bytes());
        input.witness.push(control.serialize());
    }
    Ok(LnRefund {
        hex: serialize_hex(&tx),
        txid: tx.compute_txid().to_string(),
        destination: dest.to_string(),
        amount_sat: amount,
        fee_sat: fee,
        vsize,
    })
}
