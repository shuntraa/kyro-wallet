//! Bitcoin: BIP84 (P2WPKH) and BIP86 (P2TR key-path) accounts, PSBT signing and decoding.

use core::str::FromStr;

use bitcoin::bip32::{ChildNumber, DerivationPath, Fingerprint, Xpub};
use bitcoin::key::{CompressedPublicKey, Keypair, TapTweak};
use bitcoin::psbt::{Output as PsbtOutput, Psbt};
use bitcoin::secp256k1::{All, Message, Secp256k1};
use bitcoin::sighash::{EcdsaSighashType, Prevouts, SighashCache, TapSighashType};
use bitcoin::{Address, KnownHrp, Script, ScriptBuf, TxOut};
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::keys::{hardened, normal, path_string, random32, secp, XprivGuard};
use crate::mnemonic::Seed;
use crate::network::{BtcKind, Network};

/// Public description of a Bitcoin account (safe to show / export as watch-only).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BtcAccount {
    /// Account kind.
    pub kind: BtcKind,
    /// Account-level extended public key, standard `xpub`/`tpub` encoding.
    pub xpub: String,
    /// Master key fingerprint, 8 lowercase hex chars.
    pub fingerprint: String,
    /// Account derivation path, e.g. `m/84'/0'/0'`.
    pub path: String,
}

/// Fee rate above which a Bitcoin transaction needs the reinforced confirmation: 100 sat/vB,
/// i.e. 100 × the 1 sat/vB relay minimum (same rule as Litecoin's `HighFee`).
pub const BTC_HIGH_FEE_SAT_PER_VB: u64 = 100;

/// Reasons for caution in a Bitcoin PSBT (each one requires the reinforced confirmation).
/// A sighash other than ALL / DEFAULT on one of our inputs is not a warning: it is refused.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum BtcWarning {
    /// Output whose script is not a standard address (`script:<hex>`).
    UnknownScript {
        /// Output index.
        output: usize,
    },
    /// `OP_RETURN` output (data, burns its value).
    OpReturn {
        /// Output index.
        output: usize,
    },
    /// Input that does not belong to this wallet (not signed by Kyro; someone else adds funds
    /// or co-signs — coinjoin, payjoin, or a trap).
    ForeignInput {
        /// Input index.
        input: usize,
    },
    /// Fee rate above [`BTC_HIGH_FEE_SAT_PER_VB`], or fee larger than all outputs together.
    HighFee {
        /// Estimated fee rate, sat/vB.
        sat_per_vb: u64,
    },
}

/// Plain-language summary of a PSBT.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BtcTxSummary {
    /// Every output in order: (address, amount in sats, is_change).
    ///
    /// Non-address outputs are rendered as `op_return:<hex payload script>` or
    /// `script:<hex script>`.
    pub outputs: Vec<(String, u64, bool)>,
    /// Sum of inputs (from `witness_utxo`) minus sum of outputs.
    pub fee_sats: u64,
    /// Reasons for caution.
    #[serde(default)]
    pub warnings: Vec<BtcWarning>,
    /// The native dialog must be followed by a reinforced one.
    #[serde(default)]
    pub requires_extra_confirmation: bool,
}

/// Estimated virtual size once signed: P2WPKH inputs 108 weight units of witness, P2TR
/// key-path 66 (a lower bound for other scripts, so the fee rate is never underestimated).
fn estimated_vsize(psbt: &Psbt, prevouts: &[TxOut]) -> u64 {
    let base = psbt.unsigned_tx.base_size() as u64;
    let witness: u64 = prevouts
        .iter()
        .map(|p| if p.script_pubkey.is_p2tr() { 66 } else { 108 })
        .sum();
    (base * 4 + 2 + witness).div_ceil(4)
}

pub(crate) fn account_path(net: Network, kind: BtcKind, account: u32) -> Result<[ChildNumber; 3]> {
    Ok([
        hardened(kind.purpose())?,
        hardened(net.btc_coin_type())?,
        hardened(account)?,
    ])
}

fn account_xpub(
    secp: &Secp256k1<All>,
    seed: &Seed,
    net: Network,
    kind: BtcKind,
    account: u32,
) -> Result<(Xpub, Fingerprint, [ChildNumber; 3])> {
    let path = account_path(net, kind, account)?;
    let master = XprivGuard::master(seed, net.btc_kind())?;
    let acct = master.derive(secp, &path)?;
    Ok((
        Xpub::from_priv(secp, acct.xpriv()),
        master.fingerprint(secp),
        path,
    ))
}

/// Account descriptor for `m/purpose'/coin'/account'`.
pub fn btc_account(seed: &Seed, net: Network, kind: BtcKind, account: u32) -> Result<BtcAccount> {
    let secp = secp()?;
    let (xpub, fingerprint, path) = account_xpub(&secp, seed, net, kind, account)?;
    Ok(BtcAccount {
        kind,
        xpub: xpub.to_string(),
        fingerprint: fingerprint.to_string(),
        path: path_string(&path),
    })
}

fn address_for(
    secp: &Secp256k1<All>,
    pk: bitcoin::secp256k1::PublicKey,
    net: Network,
    kind: BtcKind,
) -> Address {
    let hrp = KnownHrp::from(net.btc());
    match kind {
        BtcKind::Segwit => Address::p2wpkh(&CompressedPublicKey(pk), hrp),
        BtcKind::Taproot => Address::p2tr(secp, pk.x_only_public_key().0, None, hrp),
    }
}

/// Address at `m/purpose'/coin'/account'/change/index` (`change` = internal chain 1).
pub fn btc_address(
    seed: &Seed,
    net: Network,
    kind: BtcKind,
    account: u32,
    change: bool,
    index: u32,
) -> Result<String> {
    let secp = secp()?;
    let (xpub, _, _) = account_xpub(&secp, seed, net, kind, account)?;
    let child = xpub
        .derive_pub(&secp, &[normal(u32::from(change))?, normal(index)?])
        .map_err(|_| Error::crypto("public derivation failed"))?;
    Ok(address_for(&secp, child.public_key, net, kind).to_string())
}

// ---------------------------------------------------------------------------------------------
// PSBT
// ---------------------------------------------------------------------------------------------

pub(crate) fn parse_psbt(psbt_b64: &str) -> Result<Psbt> {
    Psbt::from_str(psbt_b64.trim()).map_err(|_| Error::psbt("not a valid base64 PSBT"))
}

/// Spent outputs of every input, from `witness_utxo` (mandatory). When a `non_witness_utxo`
/// is also present it must be consistent with the outpoint and the `witness_utxo`.
pub(crate) fn prevouts(psbt: &Psbt) -> Result<Vec<TxOut>> {
    if psbt.inputs.len() != psbt.unsigned_tx.input.len() {
        return Err(Error::psbt("input count mismatch"));
    }
    let mut out = Vec::with_capacity(psbt.inputs.len());
    for (i, (input, txin)) in psbt.inputs.iter().zip(&psbt.unsigned_tx.input).enumerate() {
        let utxo = input
            .witness_utxo
            .as_ref()
            .ok_or_else(|| Error::psbt(format!("input {i} lacks witness_utxo")))?;
        if let Some(prev_tx) = &input.non_witness_utxo {
            let consistent = prev_tx.compute_txid() == txin.previous_output.txid
                && usize::try_from(txin.previous_output.vout)
                    .ok()
                    .and_then(|vout| prev_tx.output.get(vout))
                    == Some(utxo);
            if !consistent {
                return Err(Error::psbt(format!(
                    "input {i}: non_witness_utxo inconsistent with witness_utxo"
                )));
            }
        }
        out.push(utxo.clone());
    }
    Ok(out)
}

fn render_script(net: Network, spk: &Script) -> String {
    match Address::from_script(spk, net.btc()) {
        Ok(addr) => addr.to_string(),
        Err(_) if spk.is_op_return() => format!("op_return:{}", spk.to_hex_string()),
        Err(_) => format!("script:{}", spk.to_hex_string()),
    }
}

pub(crate) fn summarize(
    net: Network,
    psbt: &Psbt,
    prevouts: &[TxOut],
    is_own: impl Fn(usize, &Script) -> bool,
    is_own_input: impl Fn(usize) -> bool,
) -> Result<BtcTxSummary> {
    let mut total_in: u64 = 0;
    for p in prevouts {
        total_in = total_in
            .checked_add(p.value.to_sat())
            .ok_or_else(|| Error::psbt("input amount overflow"))?;
    }
    let mut total_out: u64 = 0;
    let mut outputs = Vec::with_capacity(psbt.unsigned_tx.output.len());
    for (j, out) in psbt.unsigned_tx.output.iter().enumerate() {
        let sats = out.value.to_sat();
        total_out = total_out
            .checked_add(sats)
            .ok_or_else(|| Error::psbt("output amount overflow"))?;
        outputs.push((
            render_script(net, &out.script_pubkey),
            sats,
            is_own(j, &out.script_pubkey),
        ));
    }
    let fee_sats = total_in
        .checked_sub(total_out)
        .ok_or_else(|| Error::psbt("outputs exceed inputs (negative fee)"))?;
    let mut warnings = Vec::new();
    for i in 0..prevouts.len() {
        if !is_own_input(i) {
            warnings.push(BtcWarning::ForeignInput { input: i });
        }
    }
    for (j, (addr, _, _)) in outputs.iter().enumerate() {
        if addr.starts_with("op_return:") {
            warnings.push(BtcWarning::OpReturn { output: j });
        } else if addr.starts_with("script:") {
            warnings.push(BtcWarning::UnknownScript { output: j });
        }
    }
    let rate = fee_sats / estimated_vsize(psbt, prevouts).max(1);
    if rate > BTC_HIGH_FEE_SAT_PER_VB || fee_sats > total_out {
        warnings.push(BtcWarning::HighFee { sat_per_vb: rate });
    }
    Ok(BtcTxSummary {
        outputs,
        fee_sats,
        requires_extra_confirmation: !warnings.is_empty(),
        warnings,
    })
}

/// Decodes a PSBT without any secret. `own` lists the wallet's addresses: outputs paying to
/// one of them are flagged `is_change`. Fails if any input lacks `witness_utxo`.
pub fn btc_decode_psbt(net: Network, psbt_b64: &str, own: &[String]) -> Result<BtcTxSummary> {
    let psbt = parse_psbt(psbt_b64)?;
    let prevouts = prevouts(&psbt)?;
    let mut own_scripts = Vec::with_capacity(own.len());
    for a in own {
        let addr = Address::from_str(a.trim())
            .map_err(|_| Error::input("invalid own address"))?
            .require_network(net.btc())
            .map_err(|_| Error::input("own address is for another network"))?;
        own_scripts.push(addr.script_pubkey());
    }
    summarize(
        net,
        &psbt,
        &prevouts,
        |_, spk| own_scripts.iter().any(|s| s.as_script() == spk),
        |i| {
            prevouts
                .get(i)
                .is_some_and(|p| own_scripts.contains(&p.script_pubkey))
        },
    )
}

/// `true` iff `path` is `m/purpose'/coin'/account'/{0,1}/index` for our purpose, coin type and
/// account: keys of the wallet's other accounts are not "ours" for a signature by `account`.
pub(crate) fn is_our_path(path: &DerivationPath, purpose: u32, coin: u32, account: u32) -> bool {
    match path.as_ref() {
        [ChildNumber::Hardened { index: p }, ChildNumber::Hardened { index: c }, ChildNumber::Hardened { index: a }, ChildNumber::Normal { index: change }, ChildNumber::Normal { .. }] => {
            *p == purpose && *c == coin && *a == account && *change <= 1
        }
        _ => false,
    }
}

struct Signer {
    secp: Secp256k1<All>,
    master: XprivGuard,
    fingerprint: Fingerprint,
    coin: u32,
    account: u32,
}

impl Signer {
    fn new(seed: &Seed, net: Network, account: u32) -> Result<Signer> {
        // Refuse an out-of-range account up front (it could never match a key origin).
        hardened(account)?;
        let secp = secp()?;
        let master = XprivGuard::master(seed, net.btc_kind())?;
        let fingerprint = master.fingerprint(&secp);
        Ok(Signer {
            secp,
            master,
            fingerprint,
            coin: net.btc_coin_type(),
            account,
        })
    }

    fn ours(&self, fp: &Fingerprint, path: &DerivationPath, kind: BtcKind) -> bool {
        *fp == self.fingerprint && is_our_path(path, kind.purpose(), self.coin, self.account)
    }

    fn derive(&self, path: &DerivationPath) -> Result<XprivGuard> {
        self.master.derive(&self.secp, path.as_ref())
    }

    /// Whether Kyro would sign this input: a key origin with our fingerprint and path for the
    /// spent script type (the signing loop then checks key and script, or fails).
    fn input_is_ours(&self, input: &bitcoin::psbt::Input, prevout: &TxOut) -> bool {
        let spk = &prevout.script_pubkey;
        if spk.is_p2wpkh() {
            input
                .bip32_derivation
                .values()
                .any(|(fp, path)| self.ours(fp, path, BtcKind::Segwit))
        } else if spk.is_p2tr() {
            input
                .tap_key_origins
                .iter()
                .any(|(x, (leaves, (fp, path)))| {
                    leaves.is_empty()
                        && input.tap_internal_key == Some(*x)
                        && self.ours(fp, path, BtcKind::Taproot)
                })
        } else {
            false
        }
    }

    /// Whether a PSBT output provably pays to one of our keys (key origin + script match).
    fn output_is_ours(&self, spk: &Script, meta: &PsbtOutput) -> Result<bool> {
        if spk.is_p2wpkh() {
            for (pk, (fp, path)) in &meta.bip32_derivation {
                if self.ours(fp, path, BtcKind::Segwit) {
                    let k = self.derive(path)?;
                    let derived = k.xpriv().private_key.public_key(&self.secp);
                    if derived == *pk
                        && ScriptBuf::new_p2wpkh(&CompressedPublicKey(derived).wpubkey_hash())
                            == *spk
                    {
                        return Ok(true);
                    }
                }
            }
        } else if spk.is_p2tr() {
            for (xonly, (leaves, (fp, path))) in &meta.tap_key_origins {
                if leaves.is_empty()
                    && meta.tap_internal_key == Some(*xonly)
                    && self.ours(fp, path, BtcKind::Taproot)
                {
                    let k = self.derive(path)?;
                    let derived = k.xpriv().private_key.x_only_public_key(&self.secp).0;
                    if derived == *xonly && ScriptBuf::new_p2tr(&self.secp, derived, None) == *spk {
                        return Ok(true);
                    }
                }
            }
        }
        Ok(false)
    }
}

/// Summary as `btc_sign_psbt` computes it (change and own inputs by key origin), without
/// signing: what the native dialog shows before the password-protected signature.
fn sign_summary(
    signer: &Signer,
    net: Network,
    psbt: &Psbt,
    prevouts: &[TxOut],
) -> Result<BtcTxSummary> {
    if psbt.outputs.len() != psbt.unsigned_tx.output.len() {
        return Err(Error::psbt("output count mismatch"));
    }
    let mut own = Vec::with_capacity(psbt.outputs.len());
    for (out, meta) in psbt.unsigned_tx.output.iter().zip(&psbt.outputs) {
        own.push(signer.output_is_ours(&out.script_pubkey, meta)?);
    }
    let own_inputs: Vec<bool> = psbt
        .inputs
        .iter()
        .zip(prevouts)
        .map(|(i, p)| signer.input_is_ours(i, p))
        .collect();
    summarize(
        net,
        psbt,
        prevouts,
        |j, _| own.get(j).copied().unwrap_or(false),
        |i| own_inputs.get(i).copied().unwrap_or(false),
    )
}

/// [`btc_sign_psbt`]'s summary without signing (for the dialog shown before signing).
pub fn btc_psbt_summary(
    seed: &Seed,
    net: Network,
    account: u32,
    psbt_b64: &str,
) -> Result<BtcTxSummary> {
    let psbt = parse_psbt(psbt_b64)?;
    let prevouts = prevouts(&psbt)?;
    let signer = Signer::new(seed, net, account)?;
    sign_summary(&signer, net, &psbt, &prevouts)
}

/// Signs every P2WPKH (BIP84) and P2TR key-path (BIP86) input whose key origin
/// (`bip32_derivation` / `tap_key_origins`) carries our master fingerprint and a path
/// `m/purpose'/coin'/account'/{0,1}/index` for this network **and this `account`**. Other
/// inputs — including those of the wallet's other accounts — are left untouched (and reported
/// as [`BtcWarning::ForeignInput`]); change is recognised in this account only.
///
/// Safety checks: every input must have a `witness_utxo`; the derived key must match the key
/// in the PSBT and the spent script; only `SIGHASH_ALL` / `SIGHASH_DEFAULT` are signed;
/// taproot inputs with a script tree are refused. Fails if no input could be signed.
///
/// Returns the signed (not finalized) PSBT in base64 and a summary in which `is_change`
/// marks outputs whose key origin provably belongs to this wallet.
pub fn btc_sign_psbt(
    seed: &Seed,
    net: Network,
    account: u32,
    psbt_b64: &str,
) -> Result<(String, BtcTxSummary)> {
    let mut psbt = parse_psbt(psbt_b64)?;
    let prevouts = prevouts(&psbt)?;
    let signer = Signer::new(seed, net, account)?;
    let secp = &signer.secp;

    let summary = sign_summary(&signer, net, &psbt, &prevouts)?;

    let tx = psbt.unsigned_tx.clone();
    let mut cache = SighashCache::new(&tx);
    let mut signed = 0usize;

    for (i, prevout) in prevouts.iter().enumerate() {
        let spk = &prevout.script_pubkey;
        let input = &mut psbt.inputs[i];

        if spk.is_p2wpkh() {
            let candidates: Vec<_> = input
                .bip32_derivation
                .iter()
                .filter(|(_, (fp, path))| signer.ours(fp, path, BtcKind::Segwit))
                .map(|(pk, (_, path))| (*pk, path.clone()))
                .collect();
            for (pk, path) in candidates {
                let key = signer.derive(&path)?;
                let sk = &key.xpriv().private_key;
                let derived = sk.public_key(secp);
                if derived != pk {
                    return Err(Error::psbt(format!(
                        "input {i}: key origin does not match key"
                    )));
                }
                if ScriptBuf::new_p2wpkh(&CompressedPublicKey(derived).wpubkey_hash()) != *spk {
                    return Err(Error::psbt(format!("input {i}: script is not ours")));
                }
                match input.ecdsa_hash_ty() {
                    Ok(EcdsaSighashType::All) => {}
                    _ => {
                        return Err(Error::psbt(format!(
                            "input {i}: only SIGHASH_ALL is signed"
                        )))
                    }
                }
                let sighash = cache
                    .p2wpkh_signature_hash(i, spk, prevout.value, EcdsaSighashType::All)
                    .map_err(|_| Error::psbt(format!("input {i}: sighash failed")))?;
                let msg = Message::from(sighash);
                let signature = secp.sign_ecdsa(&msg, sk);
                secp.verify_ecdsa(&msg, &signature, &derived)
                    .map_err(|_| Error::crypto("signature self-check failed"))?;
                input.partial_sigs.insert(
                    bitcoin::PublicKey::new(derived),
                    bitcoin::ecdsa::Signature {
                        signature,
                        sighash_type: EcdsaSighashType::All,
                    },
                );
                signed += 1;
            }
        } else if spk.is_p2tr() {
            let candidates: Vec<_> = input
                .tap_key_origins
                .iter()
                .filter(|(_, (leaves, (fp, path)))| {
                    leaves.is_empty() && signer.ours(fp, path, BtcKind::Taproot)
                })
                .map(|(x, (_, (_, path)))| (*x, path.clone()))
                .collect();
            for (xonly, path) in candidates {
                if input.tap_internal_key != Some(xonly) {
                    continue; // our key, but not as key-path internal key: nothing to do
                }
                if input.tap_merkle_root.is_some() {
                    return Err(Error::psbt(format!(
                        "input {i}: taproot script trees are not supported"
                    )));
                }
                let key = signer.derive(&path)?;
                let mut keypair = Keypair::from_secret_key(secp, &key.xpriv().private_key);
                let derived = keypair.x_only_public_key().0;
                if derived != xonly {
                    return Err(Error::psbt(format!(
                        "input {i}: key origin does not match key"
                    )));
                }
                if ScriptBuf::new_p2tr(secp, derived, None) != *spk {
                    return Err(Error::psbt(format!("input {i}: script is not ours")));
                }
                let hash_ty = match input.taproot_hash_ty() {
                    Ok(t @ (TapSighashType::Default | TapSighashType::All)) => t,
                    _ => {
                        return Err(Error::psbt(format!(
                            "input {i}: only SIGHASH_DEFAULT/ALL is signed"
                        )))
                    }
                };
                let sighash = cache
                    .taproot_key_spend_signature_hash(i, &Prevouts::All(&prevouts), hash_ty)
                    .map_err(|_| Error::psbt(format!("input {i}: sighash failed")))?;
                let msg = Message::from(sighash);
                let mut tweaked = keypair.tap_tweak(secp, None).to_keypair();
                let aux = random32()?;
                let signature = secp.sign_schnorr_with_aux_rand(&msg, &tweaked, &aux);
                let verified =
                    secp.verify_schnorr(&signature, &msg, &tweaked.x_only_public_key().0);
                tweaked.non_secure_erase();
                keypair.non_secure_erase();
                verified.map_err(|_| Error::crypto("signature self-check failed"))?;
                input.tap_key_sig = Some(bitcoin::taproot::Signature {
                    signature,
                    sighash_type: hash_ty,
                });
                signed += 1;
            }
        }
    }

    if signed == 0 {
        return Err(Error::psbt("no input belongs to this wallet"));
    }
    Ok((psbt.to_string(), summary))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn our_path_filter() {
        let ok = DerivationPath::from_str("m/84'/1'/0'/1/7").unwrap();
        assert!(is_our_path(&ok, 84, 1, 0));
        assert!(!is_our_path(&ok, 84, 0, 0));
        assert!(!is_our_path(&ok, 86, 1, 0));
        assert!(
            !is_our_path(&ok, 84, 1, 1),
            "another account of the same wallet"
        );
        let acct1 = DerivationPath::from_str("m/84'/1'/1'/0/0").unwrap();
        assert!(is_our_path(&acct1, 84, 1, 1));
        assert!(!is_our_path(&acct1, 84, 1, 0));
        for bad in [
            "m/84'/1'/0'/2/0",
            "m/84'/1'/0/0/0",
            "m/84'/1'/0'/0'/0",
            "m/84'/1'/0'/0",
        ] {
            assert!(
                !is_our_path(&DerivationPath::from_str(bad).unwrap(), 84, 1, 0),
                "{bad}"
            );
        }
    }
}
