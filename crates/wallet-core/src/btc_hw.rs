//! Bitcoin with a hardware wallet: what the device is asked to sign, and independent checks of
//! what it returns. Nothing here holds a private key; the device is never trusted.
//!
//! - [`btc_hw_plan`] matches every PSBT input and output against the stored watch-only
//!   accounts (account xpub + master fingerprint + path). A key origin that claims to be ours
//!   must derive, from the xpub, to the very key and script in the PSBT, otherwise it is an
//!   error (inputs) or treated as a foreign output (outputs, shown as a recipient).
//! - [`btc_hw_finalize`] recomputes each sighash (BIP143 for P2WPKH, BIP341 key-path for P2TR)
//!   and verifies every signature returned by the device against the key derived from the xpub
//!   (tweaked output key for Taproot) before writing it into the PSBT. A missing, duplicated,
//!   extra or invalid signature fails the whole operation.

use core::str::FromStr;

use bitcoin::bip32::{ChildNumber, DerivationPath, Fingerprint, Xpub};
use bitcoin::key::{CompressedPublicKey, TapTweak};
use bitcoin::psbt::Psbt;
use bitcoin::secp256k1::{ecdsa, Message, PublicKey, Secp256k1, VerifyOnly, XOnlyPublicKey};
use bitcoin::sighash::{EcdsaSighashType, Prevouts, SighashCache, TapSighashType};
use bitcoin::ScriptBuf;

use crate::btc::{account_path, parse_psbt, prevouts, summarize, BtcAccount, BtcTxSummary};
use crate::error::{Error, Result};
use crate::network::{BtcKind, Network};

/// One PSBT input that belongs to a stored hardware-wallet account.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HwBtcInput {
    /// Input index in the transaction.
    pub index: usize,
    /// Account kind (P2WPKH or P2TR key path).
    pub kind: BtcKind,
    /// Full derivation path, e.g. `m/84'/1'/0'/0/3` as raw BIP32 indices.
    pub path: Vec<u32>,
    /// Expected public key: 33-byte compressed (SegWit) or 32-byte x-only internal key (Taproot).
    pub pubkey: Vec<u8>,
    /// Amount of the spent output, in sats.
    pub amount: u64,
    /// Whether the PSBT carries the full previous transaction (`non_witness_utxo`).
    pub has_prev_tx: bool,
}

/// One PSBT output that provably pays back to a stored account (change).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HwBtcChange {
    /// Output index in the transaction.
    pub index: usize,
    /// Account kind.
    pub kind: BtcKind,
    /// Full derivation path as raw BIP32 indices.
    pub path: Vec<u32>,
}

/// What a hardware wallet will be asked to sign.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HwBtcPlan {
    /// Inputs that belong to the accounts (at least one).
    pub inputs: Vec<HwBtcInput>,
    /// Indices of inputs that do not belong to the accounts.
    pub external_inputs: Vec<usize>,
    /// Outputs that provably pay back to the accounts.
    pub change: Vec<HwBtcChange>,
    /// Plain-language summary; `is_change` is set only for outputs listed in `change`.
    pub summary: BtcTxSummary,
}

/// A signature returned by a device for one input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HwBtcSignature {
    /// Input index the device says it signed.
    pub input: usize,
    /// Public key the device says it used (33 bytes, or 32 x-only), when it reports one.
    pub pubkey: Option<Vec<u8>>,
    /// DER ECDSA signature (optionally followed by the sighash byte, which must be ALL), or a
    /// 64-byte BIP340 signature (65 bytes with an explicit sighash byte, which must be ALL).
    pub signature: Vec<u8>,
}

struct Account {
    kind: BtcKind,
    xpub: Xpub,
    fingerprint: Fingerprint,
    path: [ChildNumber; 3],
}

fn device_err(msg: impl Into<String>) -> Error {
    Error::Device(msg.into())
}

fn parse_accounts(net: Network, accounts: &[BtcAccount]) -> Result<Vec<Account>> {
    let mut out = Vec::with_capacity(accounts.len());
    for a in accounts {
        let xpub =
            Xpub::from_str(a.xpub.trim()).map_err(|_| Error::input("invalid account xpub"))?;
        if xpub.network != net.btc_kind() {
            return Err(Error::input("account xpub is for another network"));
        }
        let fingerprint = Fingerprint::from_str(&a.fingerprint)
            .map_err(|_| Error::input("invalid master fingerprint"))?;
        let account = match xpub.child_number {
            ChildNumber::Hardened { index } if xpub.depth == 3 => index,
            _ => return Err(Error::input("xpub is not an account-level (depth 3) key")),
        };
        let path = account_path(net, a.kind, account)?;
        let declared =
            DerivationPath::from_str(&a.path).map_err(|_| Error::input("invalid account path"))?;
        if declared.as_ref() != path.as_slice() {
            return Err(Error::input("account path does not match the xpub"));
        }
        out.push(Account {
            kind: a.kind,
            xpub,
            fingerprint,
            path,
        });
    }
    Ok(out)
}

/// The account a key origin points into, with the two unhardened steps below the account.
fn match_origin<'a>(
    accounts: &'a [Account],
    kind: BtcKind,
    fp: &Fingerprint,
    path: &DerivationPath,
) -> Option<(&'a Account, [ChildNumber; 2])> {
    let steps = path.as_ref();
    accounts.iter().find_map(|a| match steps {
        [p0, p1, p2, change @ ChildNumber::Normal { index: c }, index @ ChildNumber::Normal { .. }]
            if a.kind == kind && a.fingerprint == *fp && [*p0, *p1, *p2] == a.path && *c <= 1 =>
        {
            Some((a, [*change, *index]))
        }
        _ => None,
    })
}

fn derive(
    secp: &Secp256k1<VerifyOnly>,
    account: &Account,
    tail: &[ChildNumber],
) -> Result<PublicKey> {
    account
        .xpub
        .derive_pub(secp, &tail)
        .map(|x| x.public_key)
        .map_err(|_| Error::crypto("public derivation failed"))
}

fn raw_path(path: &DerivationPath) -> Vec<u32> {
    path.as_ref().iter().map(|c| u32::from(*c)).collect()
}

/// Matches a PSBT against stored hardware-wallet accounts. Fails if no input is ours, if an
/// input claims one of our key origins but its key or script does not derive from the xpub,
/// if an input of ours uses a sighash type other than ALL (DEFAULT/ALL for Taproot), or for any
/// malformed PSBT (see [`crate::btc_decode_psbt`]).
pub fn btc_hw_plan(net: Network, psbt_b64: &str, accounts: &[BtcAccount]) -> Result<HwBtcPlan> {
    let psbt = parse_psbt(psbt_b64)?;
    plan_of(net, &psbt, accounts)
}

fn plan_of(net: Network, psbt: &Psbt, accounts: &[BtcAccount]) -> Result<HwBtcPlan> {
    if psbt.outputs.len() != psbt.unsigned_tx.output.len() {
        return Err(Error::psbt("output count mismatch"));
    }
    let prevouts = prevouts(psbt)?;
    let accounts = parse_accounts(net, accounts)?;
    if accounts.is_empty() {
        return Err(Error::input("no hardware-wallet account"));
    }
    let secp = Secp256k1::verification_only();

    let mut inputs = Vec::new();
    let mut external_inputs = Vec::new();
    for (i, (input, prevout)) in psbt.inputs.iter().zip(&prevouts).enumerate() {
        let spk = &prevout.script_pubkey;
        let mut found = None;
        if spk.is_p2wpkh() {
            for (pk, (fp, path)) in &input.bip32_derivation {
                let Some((acct, tail)) = match_origin(&accounts, BtcKind::Segwit, fp, path) else {
                    continue;
                };
                let derived = derive(&secp, acct, &tail)?;
                if derived != *pk {
                    return Err(Error::psbt(format!(
                        "input {i}: key origin does not match the account xpub"
                    )));
                }
                if ScriptBuf::new_p2wpkh(&CompressedPublicKey(derived).wpubkey_hash()) != *spk {
                    return Err(Error::psbt(format!("input {i}: script is not ours")));
                }
                if !matches!(input.ecdsa_hash_ty(), Ok(EcdsaSighashType::All)) {
                    return Err(Error::psbt(format!(
                        "input {i}: only SIGHASH_ALL is signed"
                    )));
                }
                found = Some(HwBtcInput {
                    index: i,
                    kind: BtcKind::Segwit,
                    path: raw_path(path),
                    pubkey: derived.serialize().to_vec(),
                    amount: prevout.value.to_sat(),
                    has_prev_tx: input.non_witness_utxo.is_some(),
                });
                break;
            }
        } else if spk.is_p2tr() {
            for (xonly, (leaves, (fp, path))) in &input.tap_key_origins {
                if !leaves.is_empty() {
                    continue;
                }
                let Some((acct, tail)) = match_origin(&accounts, BtcKind::Taproot, fp, path) else {
                    continue;
                };
                if input.tap_internal_key != Some(*xonly) {
                    return Err(Error::psbt(format!(
                        "input {i}: our key is not the key-path internal key"
                    )));
                }
                if input.tap_merkle_root.is_some() {
                    return Err(Error::psbt(format!(
                        "input {i}: taproot script trees are not supported"
                    )));
                }
                let derived = derive(&secp, acct, &tail)?.x_only_public_key().0;
                if derived != *xonly {
                    return Err(Error::psbt(format!(
                        "input {i}: key origin does not match the account xpub"
                    )));
                }
                if ScriptBuf::new_p2tr(&secp, derived, None) != *spk {
                    return Err(Error::psbt(format!("input {i}: script is not ours")));
                }
                if !matches!(
                    input.taproot_hash_ty(),
                    Ok(TapSighashType::Default | TapSighashType::All)
                ) {
                    return Err(Error::psbt(format!(
                        "input {i}: only SIGHASH_DEFAULT/ALL is signed"
                    )));
                }
                found = Some(HwBtcInput {
                    index: i,
                    kind: BtcKind::Taproot,
                    path: raw_path(path),
                    pubkey: derived.serialize().to_vec(),
                    amount: prevout.value.to_sat(),
                    has_prev_tx: input.non_witness_utxo.is_some(),
                });
                break;
            }
        }
        match found {
            Some(f) => inputs.push(f),
            None => external_inputs.push(i),
        }
    }
    if inputs.is_empty() {
        return Err(Error::psbt(
            "no input belongs to this hardware-wallet account",
        ));
    }

    let mut change = Vec::new();
    for (j, (out, meta)) in psbt
        .unsigned_tx
        .output
        .iter()
        .zip(&psbt.outputs)
        .enumerate()
    {
        let spk = &out.script_pubkey;
        if spk.is_p2wpkh() {
            for (pk, (fp, path)) in &meta.bip32_derivation {
                if let Some((acct, tail)) = match_origin(&accounts, BtcKind::Segwit, fp, path) {
                    let derived = derive(&secp, acct, &tail)?;
                    if derived == *pk
                        && ScriptBuf::new_p2wpkh(&CompressedPublicKey(derived).wpubkey_hash())
                            == *spk
                    {
                        change.push(HwBtcChange {
                            index: j,
                            kind: BtcKind::Segwit,
                            path: raw_path(path),
                        });
                        break;
                    }
                }
            }
        } else if spk.is_p2tr() {
            for (xonly, (leaves, (fp, path))) in &meta.tap_key_origins {
                if !leaves.is_empty() || meta.tap_internal_key != Some(*xonly) {
                    continue;
                }
                if let Some((acct, tail)) = match_origin(&accounts, BtcKind::Taproot, fp, path) {
                    let derived = derive(&secp, acct, &tail)?.x_only_public_key().0;
                    if derived == *xonly && ScriptBuf::new_p2tr(&secp, derived, None) == *spk {
                        change.push(HwBtcChange {
                            index: j,
                            kind: BtcKind::Taproot,
                            path: raw_path(path),
                        });
                        break;
                    }
                }
            }
        }
    }
    let summary = summarize(net, psbt, &prevouts, |j, _| {
        change.iter().any(|c| c.index == j)
    })?;
    Ok(HwBtcPlan {
        inputs,
        external_inputs,
        change,
        summary,
    })
}

/// Strict DER, with or without a trailing SIGHASH_ALL byte. Any other sighash is refused.
fn parse_ecdsa(bytes: &[u8]) -> Result<ecdsa::Signature> {
    if let Ok(sig) = ecdsa::Signature::from_der(bytes) {
        return Ok(sig);
    }
    match bytes.split_last() {
        Some((&0x01, der)) => {
            ecdsa::Signature::from_der(der).map_err(|_| device_err("malformed ECDSA signature"))
        }
        _ => Err(device_err(
            "malformed ECDSA signature or sighash type other than ALL",
        )),
    }
}

/// Verifies every signature returned by a device and writes it into the PSBT (`partial_sigs`
/// for P2WPKH, `tap_key_sig` for P2TR). Returns the signed, non-finalized PSBT in base64 and
/// the summary of [`btc_hw_plan`]. Fails with [`Error::Device`] if a signature is for an input
/// that is not ours, uses another key, is malformed, does not verify against the recomputed
/// sighash, is duplicated, or if any of our inputs was left unsigned.
pub fn btc_hw_finalize(
    net: Network,
    psbt_b64: &str,
    accounts: &[BtcAccount],
    sigs: &[HwBtcSignature],
) -> Result<(String, BtcTxSummary)> {
    let mut psbt = parse_psbt(psbt_b64)?;
    let plan = plan_of(net, &psbt, accounts)?;
    let prevouts = prevouts(&psbt)?;
    let tx = psbt.unsigned_tx.clone();
    let mut cache = SighashCache::new(&tx);
    let secp = Secp256k1::verification_only();
    let mut signed = vec![false; psbt.inputs.len()];

    for sig in sigs {
        let ours = plan
            .inputs
            .iter()
            .find(|p| p.index == sig.input)
            .ok_or_else(|| {
                device_err(format!(
                    "signature for input {} which is not ours",
                    sig.input
                ))
            })?;
        let i = ours.index;
        if signed[i] {
            return Err(device_err(format!("two signatures for input {i}")));
        }
        if let Some(pk) = &sig.pubkey {
            if *pk != ours.pubkey {
                return Err(device_err(format!(
                    "input {i} signed with an unexpected key"
                )));
            }
        }
        let prevout = &prevouts[i];
        match ours.kind {
            BtcKind::Segwit => {
                let pk = PublicKey::from_slice(&ours.pubkey)
                    .map_err(|_| Error::crypto("invalid derived key"))?;
                let signature = parse_ecdsa(&sig.signature)?;
                let sighash = cache
                    .p2wpkh_signature_hash(
                        i,
                        &prevout.script_pubkey,
                        prevout.value,
                        EcdsaSighashType::All,
                    )
                    .map_err(|_| Error::psbt(format!("input {i}: sighash failed")))?;
                // libsecp256k1 also rejects non-normalized (high-S) signatures here.
                secp.verify_ecdsa(&Message::from(sighash), &signature, &pk)
                    .map_err(|_| device_err(format!("input {i}: signature does not verify")))?;
                psbt.inputs[i].partial_sigs.insert(
                    bitcoin::PublicKey::new(pk),
                    bitcoin::ecdsa::Signature {
                        signature,
                        sighash_type: EcdsaSighashType::All,
                    },
                );
            }
            BtcKind::Taproot => {
                let xonly = XOnlyPublicKey::from_slice(&ours.pubkey)
                    .map_err(|_| Error::crypto("invalid derived key"))?;
                let ts = bitcoin::taproot::Signature::from_slice(&sig.signature)
                    .map_err(|_| device_err(format!("input {i}: malformed Schnorr signature")))?;
                if !matches!(
                    ts.sighash_type,
                    TapSighashType::Default | TapSighashType::All
                ) {
                    return Err(device_err(format!(
                        "input {i}: sighash type other than DEFAULT/ALL"
                    )));
                }
                let sighash = cache
                    .taproot_key_spend_signature_hash(i, &Prevouts::All(&prevouts), ts.sighash_type)
                    .map_err(|_| Error::psbt(format!("input {i}: sighash failed")))?;
                let (output_key, _) = xonly.tap_tweak(&secp, None);
                secp.verify_schnorr(
                    &ts.signature,
                    &Message::from(sighash),
                    &output_key.to_x_only_public_key(),
                )
                .map_err(|_| device_err(format!("input {i}: signature does not verify")))?;
                psbt.inputs[i].tap_key_sig = Some(ts);
            }
        }
        signed[i] = true;
    }
    if let Some(missing) = plan.inputs.iter().find(|p| !signed[p.index]) {
        return Err(device_err(format!(
            "the device did not sign input {}",
            missing.index
        )));
    }
    Ok((psbt.to_string(), plan.summary))
}

/// Our receive and change addresses (`0..gap` on both chains) for every account, to flag
/// change outputs in [`crate::btc_decode_psbt`] summaries of watch-only accounts.
pub fn btc_hw_own_addresses(
    net: Network,
    accounts: &[BtcAccount],
    gap: u32,
) -> Result<Vec<String>> {
    let mut out = Vec::new();
    for a in accounts {
        for change in [false, true] {
            for i in 0..gap {
                out.push(crate::btc_address_from_xpub(
                    &a.xpub, net, a.kind, change, i,
                )?);
            }
        }
    }
    Ok(out)
}

/// Validates stored Bitcoin accounts (xpub network, depth 3, standard path).
pub(crate) fn check_accounts(net: Network, accounts: &[BtcAccount]) -> Result<()> {
    parse_accounts(net, accounts).map(|_| ())
}
