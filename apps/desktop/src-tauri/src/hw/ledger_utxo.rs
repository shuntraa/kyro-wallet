//! Litecoin, Dogecoin, Bitcoin Cash and Dash on a Ledger: the coin apps built on Ledger's
//! `lib-app-bitcoin` (the legacy Bitcoin app code base, apps "Litecoin", "Dogecoin",
//! "Bitcoin Cash", "Dash"), which speak the **legacy Bitcoin APDU protocol** (CLA `E0`), not the
//! PSBT protocol of the Bitcoin app v2. Reference: `doc/btc.asc` of LedgerHQ/ledger-app-btc
//! (1.6.5) and `@ledgerhq/hw-app-btc` (`getTrustedInput`, `startUntrustedHashTransactionInput`,
//! `hashOutputFull`, `signTransaction`), read 2026-11-01.
//!
//! - GET WALLET PUBLIC KEY (`40`): uncompressed key + chain code (+ the address, shown on the
//!   screen with P1 = `01`). P2 = address format: `00` legacy, `02` bech32, `03` CashAddr.
//! - GET TRUSTED INPUT (`42`): each previous transaction, streamed element by element; the app
//!   returns a 56-byte trusted input (txid, index, **amount**, HMAC) that proves the amount.
//! - UNTRUSTED HASH TRANSACTION INPUT START (`44`), FINALIZE FULL (`4A`, the user checks the
//!   outputs there; change path first with P1 = `FF`), HASH SIGN (`48`): BIP143 flow (Litecoin
//!   P2 = `02`, Bitcoin Cash `03` + `SIGHASH_ALL|FORKID`) — all inputs once, outputs once, then
//!   one pseudo-transaction per input — or legacy flow (Dogecoin, Dash, P2 = `00`) — the whole
//!   transaction per input, the script only on the input being signed.
//!
//! Every input uses a trusted input (prefix `01`), as the apps require since 1.4.0 for SegWit.
//! Signatures come back as DER ‖ sighash type, first byte masked with `0xFE`; they are checked
//! by `wallet_core::utxo_hw_finalize` before anything leaves Rust.

use bitcoin::consensus::Encodable;
use bitcoin::hashes::{hash160, Hash};
use bitcoin::psbt::Psbt;
use bitcoin::{Transaction, VarInt};
use wallet_core::{HwBtcSignature, UtxoCoin, UtxoHwPlan};

use super::ledger::ApduLink;
use super::ledger_apdu::{self as apdu, encode_path, SwContext};
use super::{Ctl, HwError, HwResult, Prompt};

const CLA: u8 = 0xE0;
const INS_GET_WALLET_PUBLIC_KEY: u8 = 0x40;
const INS_GET_TRUSTED_INPUT: u8 = 0x42;
const INS_HASH_INPUT_START: u8 = 0x44;
const INS_HASH_SIGN: u8 = 0x48;
const INS_HASH_INPUT_FINALIZE_FULL: u8 = 0x4A;
/// hw-app-btc's `MAX_SCRIPT_BLOCK`: scripts (and outputs) are sent in blocks of this size.
const BLOCK: usize = 50;

/// Sends one APDU, returns its data (status word checked by the caller's transport).
pub type Call<'a> = dyn FnMut(&[u8], SwContext) -> HwResult<Vec<u8>> + 'a;

/// Address format of GET WALLET PUBLIC KEY for each coin's receive addresses.
pub fn address_format(coin: UtxoCoin) -> u8 {
    match coin {
        UtxoCoin::Litecoin => 0x02,
        UtxoCoin::BitcoinCash => 0x03,
        UtxoCoin::Dogecoin | UtxoCoin::Dash => 0x00,
    }
}

/// UNTRUSTED HASH TRANSACTION INPUT START mode (P2) of a new transaction.
fn start_mode(coin: UtxoCoin) -> u8 {
    match coin {
        UtxoCoin::Litecoin => 0x02,
        UtxoCoin::BitcoinCash => 0x03,
        UtxoCoin::Dogecoin | UtxoCoin::Dash => 0x00,
    }
}

fn bip143(coin: UtxoCoin) -> bool {
    matches!(coin, UtxoCoin::Litecoin | UtxoCoin::BitcoinCash)
}

fn sighash_type(coin: UtxoCoin) -> u8 {
    if coin == UtxoCoin::BitcoinCash {
        wallet_core::BCH_SIGHASH_ALL_FORKID as u8
    } else {
        0x01
    }
}

fn varint(n: usize) -> Vec<u8> {
    let mut v = Vec::new();
    // Writing to a Vec cannot fail.
    let _ = VarInt(n as u64).consensus_encode(&mut v);
    v
}

/// GET WALLET PUBLIC KEY.
pub fn get_wallet_public_key(path: &[u32], display: bool, format: u8) -> HwResult<Vec<u8>> {
    apdu::apdu(
        CLA,
        INS_GET_WALLET_PUBLIC_KEY,
        u8::from(display),
        format,
        &encode_path(path),
    )
}

/// `len ‖ uncompressed key ‖ len ‖ address (ASCII) ‖ chain code (32)`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WalletPublicKey {
    /// Compressed form of the returned key.
    pub pubkey: [u8; 33],
    pub address: String,
    pub chain_code: [u8; 32],
}

pub fn parse_wallet_public_key(data: &[u8]) -> HwResult<WalletPublicKey> {
    let bad = || HwError::bad("réponse GET WALLET PUBLIC KEY mal formée");
    let n = usize::from(*data.first().ok_or_else(bad)?);
    let key = data.get(1..1 + n).ok_or_else(bad)?;
    let pk = bitcoin::secp256k1::PublicKey::from_slice(key).map_err(|_| bad())?;
    let m = usize::from(*data.get(1 + n).ok_or_else(bad)?);
    let addr = data.get(2 + n..2 + n + m).ok_or_else(bad)?;
    let cc = data.get(2 + n + m..2 + n + m + 32).ok_or_else(bad)?;
    Ok(WalletPublicKey {
        pubkey: pk.serialize(),
        address: String::from_utf8(addr.to_vec()).map_err(|_| bad())?,
        chain_code: cc.try_into().map_err(|_| bad())?,
    })
}

/// Script + sequence in blocks of [`BLOCK`] bytes, the sequence appended to the last one.
fn script_blocks(script: &[u8], sequence: u32) -> Vec<Vec<u8>> {
    let mut out: Vec<Vec<u8>> = script.chunks(BLOCK).map(<[u8]>::to_vec).collect();
    match out.last_mut() {
        Some(last) if last.len() + 4 <= 255 => last.extend_from_slice(&sequence.to_le_bytes()),
        _ => out.push(sequence.to_le_bytes().to_vec()),
    }
    out
}

/// GET TRUSTED INPUT for output `vout` of `prev` (serialized without witness data): index ‖
/// version ‖ input count, then each input (outpoint ‖ script length, script blocks ‖
/// sequence), output count, each output (amount ‖ script length ‖ script, in blocks), lock time.
pub fn trusted_input_apdus(prev: &Transaction, vout: u32) -> HwResult<Vec<Vec<u8>>> {
    let mut parts: Vec<Vec<u8>> = Vec::new();
    let mut first = vout.to_be_bytes().to_vec();
    first.extend_from_slice(&prev.version.0.to_le_bytes());
    first.extend(varint(prev.input.len()));
    parts.push(first);
    for i in &prev.input {
        let mut d = Vec::with_capacity(41);
        let _ = i.previous_output.consensus_encode(&mut d);
        d.extend(varint(i.script_sig.len()));
        parts.push(d);
        parts.extend(script_blocks(
            i.script_sig.as_bytes(),
            i.sequence.to_consensus_u32(),
        ));
    }
    parts.push(varint(prev.output.len()));
    for o in &prev.output {
        let mut d = o.value.to_sat().to_le_bytes().to_vec();
        d.extend(varint(o.script_pubkey.len()));
        let script = o.script_pubkey.as_bytes();
        let head = script.len().min(BLOCK);
        d.extend_from_slice(&script[..head]);
        parts.push(d);
        parts.extend(script[head..].chunks(BLOCK).map(<[u8]>::to_vec));
    }
    parts.push(prev.lock_time.to_consensus_u32().to_le_bytes().to_vec());
    parts
        .iter()
        .enumerate()
        .map(|(k, d)| {
            apdu::apdu(
                CLA,
                INS_GET_TRUSTED_INPUT,
                if k == 0 { 0x00 } else { 0x80 },
                0x00,
                d,
            )
        })
        .collect()
}

/// One input of UNTRUSTED HASH TRANSACTION INPUT START.
pub struct StartInput<'a> {
    pub trusted: &'a [u8],
    pub script: &'a [u8],
    pub sequence: u32,
}

/// UNTRUSTED HASH TRANSACTION INPUT START: version ‖ input count, then per input
/// `01 ‖ len ‖ trusted input ‖ script length`, the script blocks ‖ sequence. P1 `00` on the
/// first APDU only; P2 = `mode` for a new transaction, `80` to continue the current one.
pub fn start_apdus(
    new_tx: bool,
    mode: u8,
    version: i32,
    inputs: &[StartInput<'_>],
) -> HwResult<Vec<Vec<u8>>> {
    let p2 = if new_tx { mode } else { 0x80 };
    let mut parts: Vec<Vec<u8>> = Vec::new();
    let mut first = version.to_le_bytes().to_vec();
    first.extend(varint(inputs.len()));
    parts.push(first);
    for i in inputs {
        if i.trusted.len() != 56 {
            return Err(HwError::bad("trusted input de longueur inattendue"));
        }
        let mut d = vec![0x01, i.trusted.len() as u8];
        d.extend_from_slice(i.trusted);
        d.extend(varint(i.script.len()));
        parts.push(d);
        parts.extend(script_blocks(i.script, i.sequence));
    }
    parts
        .iter()
        .enumerate()
        .map(|(k, d)| {
            apdu::apdu(
                CLA,
                INS_HASH_INPUT_START,
                if k == 0 { 0x00 } else { 0x80 },
                p2,
                d,
            )
        })
        .collect()
}

/// FINALIZE FULL with P1 = `FF`: BIP32 path of the change output.
pub fn change_path_apdu(path: &[u32]) -> HwResult<Vec<u8>> {
    apdu::apdu(
        CLA,
        INS_HASH_INPUT_FINALIZE_FULL,
        0xFF,
        0x00,
        &encode_path(path),
    )
}

/// FINALIZE FULL: output count ‖ outputs, in blocks; P1 `80` on the last block.
pub fn finalize_apdus(tx: &Transaction) -> HwResult<Vec<Vec<u8>>> {
    let mut data = varint(tx.output.len());
    for o in &tx.output {
        let _ = o.consensus_encode(&mut data);
    }
    let n = data.chunks(BLOCK).count();
    data.chunks(BLOCK)
        .enumerate()
        .map(|(k, c)| {
            apdu::apdu(
                CLA,
                INS_HASH_INPUT_FINALIZE_FULL,
                if k + 1 == n { 0x80 } else { 0x00 },
                0x00,
                c,
            )
        })
        .collect()
}

/// UNTRUSTED HASH SIGN: path ‖ `00` (no user validation code) ‖ lock time (BE) ‖ sighash type.
pub fn hash_sign_apdu(path: &[u32], lock_time: u32, sighash: u8) -> HwResult<Vec<u8>> {
    let mut d = encode_path(path);
    d.push(0x00);
    d.extend_from_slice(&lock_time.to_be_bytes());
    d.push(sighash);
    apdu::apdu(CLA, INS_HASH_SIGN, 0x00, 0x00, &d)
}

/// DER ‖ sighash type, first byte masked with `0xFE` (the app may set bit 0 for parity).
pub fn parse_signature(mut resp: Vec<u8>, sighash: u8) -> HwResult<Vec<u8>> {
    if resp.len() < 9 || resp.last() != Some(&sighash) {
        return Err(HwError::bad("signature de longueur ou de type inattendu"));
    }
    resp[0] &= 0xFE;
    if resp[0] != 0x30 {
        return Err(HwError::bad("signature non DER"));
    }
    Ok(resp)
}

/// BIP143 scriptCode of a P2WPKH input: the P2PKH script of its key hash.
fn p2wpkh_script_code(pubkey: &[u8; 33]) -> Vec<u8> {
    let h = hash160::Hash::hash(pubkey);
    let mut s = vec![0x76, 0xa9, 0x14];
    s.extend_from_slice(h.as_byte_array());
    s.extend_from_slice(&[0x88, 0xac]);
    s
}

/// The legacy-protocol signing flow. `call` sends one APDU and returns its data (status word
/// already checked, `SwContext::Signing` for the steps the user can refuse).
pub fn sign(
    call: &mut Call<'_>,
    ctl: &Ctl,
    coin: UtxoCoin,
    psbt: &Psbt,
    plan: &UtxoHwPlan,
) -> HwResult<Vec<HwBtcSignature>> {
    let tx = &psbt.unsigned_tx;
    if plan.inputs.len() != tx.input.len() {
        return Err(HwError::unsupported(
            "transaction avec des entrées qui n'appartiennent pas à ce compte",
        ));
    }
    // 1. A trusted input per input (from the full previous transaction).
    let mut trusted = Vec::with_capacity(tx.input.len());
    for (txin, input) in tx.input.iter().zip(&psbt.inputs) {
        let prev = input.non_witness_utxo.as_ref().ok_or_else(|| {
            HwError::unsupported("la transaction précédente de chaque entrée est nécessaire")
        })?;
        if prev.compute_txid() != txin.previous_output.txid {
            return Err(HwError::bad("transaction précédente incohérente"));
        }
        let mut stripped = prev.clone();
        for i in &mut stripped.input {
            i.witness.clear();
        }
        let mut last = Vec::new();
        for a in trusted_input_apdus(&stripped, txin.previous_output.vout)? {
            last = call(&a, SwContext::General)?;
        }
        if last.len() != 56 {
            return Err(HwError::bad("trusted input de longueur inattendue"));
        }
        trusted.push(last);
    }
    let scripts: Vec<Vec<u8>> = plan
        .inputs
        .iter()
        .map(|i| match coin {
            UtxoCoin::Litecoin => p2wpkh_script_code(&i.pubkey),
            _ => i.script.clone(),
        })
        .collect();
    let mode = start_mode(coin);
    let version = tx.version.0;
    let lock_time = tx.lock_time.to_consensus_u32();
    let sighash = sighash_type(coin);
    let change = plan.change.first().map(|c| c.path.clone());
    let outputs = finalize_apdus(tx)?;
    let send_outputs = |call: &mut Call<'_>, with_change: bool| -> HwResult<()> {
        if let (true, Some(p)) = (with_change, &change) {
            call(&change_path_apdu(p)?, SwContext::General)?;
        }
        for a in &outputs {
            call(a, SwContext::Signing)?;
        }
        Ok(())
    };
    ctl.prompt(Prompt::ConfirmOnDevice);
    let mut sigs = Vec::with_capacity(tx.input.len());
    if bip143(coin) {
        let all: Vec<StartInput<'_>> = tx
            .input
            .iter()
            .zip(&trusted)
            .map(|(i, t)| StartInput {
                trusted: t,
                script: &[],
                sequence: i.sequence.to_consensus_u32(),
            })
            .collect();
        for a in start_apdus(true, mode, version, &all)? {
            call(&a, SwContext::General)?;
        }
        send_outputs(call, true)?;
        for (k, input) in plan.inputs.iter().enumerate() {
            let one = [StartInput {
                trusted: &trusted[k],
                script: &scripts[k],
                sequence: tx.input[k].sequence.to_consensus_u32(),
            }];
            for a in start_apdus(false, mode, version, &one)? {
                call(&a, SwContext::General)?;
            }
            let resp = call(
                &hash_sign_apdu(&input.path, lock_time, sighash)?,
                SwContext::Signing,
            )?;
            sigs.push(HwBtcSignature {
                input: input.index,
                pubkey: Some(input.pubkey.to_vec()),
                signature: parse_signature(resp, sighash)?,
            });
        }
    } else {
        for (k, input) in plan.inputs.iter().enumerate() {
            let all: Vec<StartInput<'_>> = tx
                .input
                .iter()
                .zip(&trusted)
                .enumerate()
                .map(|(j, (i, t))| StartInput {
                    trusted: t,
                    script: if j == k { &scripts[k] } else { &[] },
                    sequence: i.sequence.to_consensus_u32(),
                })
                .collect();
            for a in start_apdus(k == 0, mode, version, &all)? {
                call(&a, SwContext::General)?;
            }
            send_outputs(call, k == 0)?;
            let resp = call(
                &hash_sign_apdu(&input.path, lock_time, sighash)?,
                SwContext::Signing,
            )?;
            sigs.push(HwBtcSignature {
                input: input.index,
                pubkey: Some(input.pubkey.to_vec()),
                signature: parse_signature(resp, sighash)?,
            });
        }
    }
    Ok(sigs)
}

/// Exchanges through `link` with status-word mapping (`expected` = app name for wrong-app).
pub fn caller<'a>(
    link: &'a dyn ApduLink,
    ctl: &'a Ctl,
    expected: &'a str,
) -> impl FnMut(&[u8], SwContext) -> HwResult<Vec<u8>> + 'a {
    move |cmd, ctx| super::chains::ledger_call(link, ctl, cmd, ctx, expected)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    /// GET TRUSTED INPUT stream (btc.asc: "scripts may span several APDUs, other elements
    /// may not be split"): index, version and input count; outpoint and script length;
    /// script blocks and sequence; output count; each output; lock time. A typical P2PKH
    /// spend: 1 input with a 106-byte scriptSig, 2 P2PKH outputs.
    #[test]
    fn trusted_input_stream_layout() {
        use bitcoin::{absolute::LockTime, transaction::Version, Amount, OutPoint, ScriptBuf};
        use bitcoin::{Sequence, TxIn, TxOut, Witness};
        let p2pkh = |b: u8| {
            ScriptBuf::from_bytes([&[0x76, 0xa9, 0x14][..], &[b; 20], &[0x88, 0xac]].concat())
        };
        let tx = Transaction {
            version: Version::ONE,
            lock_time: LockTime::ZERO,
            input: vec![TxIn {
                previous_output: OutPoint::from_str(
                    "104fa062124438e64349c44fa3d17050d0a10b7e3dbafdf0e8da846423da73c7:1",
                )
                .unwrap(),
                script_sig: ScriptBuf::from_bytes(vec![0xab; 106]),
                sequence: Sequence::MAX,
                witness: Witness::new(),
            }],
            output: vec![
                TxOut {
                    value: Amount::from_sat(100_000),
                    script_pubkey: p2pkh(1),
                },
                TxOut {
                    value: Amount::from_sat(99_990_000),
                    script_pubkey: p2pkh(2),
                },
            ],
        };
        let raw = bitcoin::consensus::encode::serialize_hex(&tx);
        let apdus = trusted_input_apdus(&tx, 1).unwrap();
        let data = |k: usize| &apdus[k][5..];
        // First APDU: P1 00, index 1 (BE), version 1 (LE), 1 input.
        assert_eq!(&apdus[0][..4], &[0xE0, 0x42, 0x00, 0x00]);
        assert_eq!(hex::encode(data(0)), "000000010100000001");
        // Outpoint (36) + script length 0x6a.
        assert_eq!(apdus[1][2], 0x80);
        assert_eq!(data(1).len(), 37);
        assert_eq!(*data(1).last().unwrap(), 0x6a);
        // 106-byte scriptSig in blocks of 50 (50, 50, 6 + sequence).
        assert_eq!((data(2).len(), data(3).len(), data(4).len()), (50, 50, 10));
        assert_eq!(&data(4)[6..], &[0xff; 4]);
        // Output count, two outputs (8 + 1 + 25 → 34 bytes, the script head in the same
        // APDU), lock time.
        assert_eq!(data(5), &[0x02]);
        assert_eq!(data(6).len(), 34);
        assert_eq!(&data(6)[..8], &100_000u64.to_le_bytes());
        assert_eq!(data(7).len(), 34);
        assert_eq!(data(8), &[0, 0, 0, 0]);
        assert_eq!(apdus.len(), 9);
        // Reassembled, the stream is the transaction itself (after the 4-byte index).
        let stream: Vec<u8> = apdus.iter().flat_map(|a| a[5..].to_vec()).collect();
        assert_eq!(hex::encode(&stream[4..]), raw);
    }

    #[test]
    fn start_finalize_sign_encodings() {
        let trusted = [0x32u8; 56];
        let script = hex::decode("76a914c4a4e2b8a5e0f7b6d9c8f7e6d5c4b3a291807f6e88ac").unwrap();
        let inputs = [StartInput {
            trusted: &trusted,
            script: &script,
            sequence: 0xffff_fffd,
        }];
        // New Bitcoin Cash transaction: P2 = 03 on every APDU, P1 00 then 80.
        let a = start_apdus(true, 0x03, 2, &inputs).unwrap();
        assert_eq!(hex::encode(&a[0]), "e0440003050200000001");
        assert_eq!(&a[1][..5], &[0xE0, 0x44, 0x80, 0x03, 59]);
        assert_eq!(&a[1][5..7], &[0x01, 56]);
        assert_eq!(a[1][5 + 58], 25, "script length");
        assert_eq!(
            &a[2][5..],
            &[script.as_slice(), &[0xfd, 0xff, 0xff, 0xff]].concat()[..]
        );
        // Continuing the current transaction: P2 = 80.
        let c = start_apdus(false, 0x03, 2, &inputs).unwrap();
        assert!(c.iter().all(|x| x[3] == 0x80));
        // Change path, then outputs with P1 80 on the last block only.
        let ch =
            change_path_apdu(&[44 | 0x8000_0000, 145 | 0x8000_0000, 0x8000_0000, 1, 0]).unwrap();
        assert_eq!(
            hex::encode(ch),
            "e04aff0015058000002c80000091800000000000000100000000"
        );
        let tx = Transaction {
            version: bitcoin::transaction::Version::TWO,
            lock_time: bitcoin::absolute::LockTime::ZERO,
            input: vec![],
            output: vec![
                bitcoin::TxOut {
                    value: bitcoin::Amount::from_sat(1),
                    script_pubkey: bitcoin::ScriptBuf::from_bytes(script.clone()),
                };
                2
            ],
        };
        let f = finalize_apdus(&tx).unwrap();
        // 1 + 2 × 34 = 69 bytes → blocks of 50 and 19.
        assert_eq!(f.len(), 2);
        assert_eq!((f[0][2], f[0][4]), (0x00, 50));
        assert_eq!((f[1][2], f[1][4]), (0x80, 19));
        // HASH SIGN: path, 00, lock time BE, sighash.
        let s = hash_sign_apdu(
            &[0x8000_002c, 0x8000_0003, 0x8000_0000, 0, 7],
            0x0102_0304,
            0x01,
        )
        .unwrap();
        assert_eq!(
            hex::encode(s),
            "e04800001b058000002c80000003800000000000000000000007000102030401"
        );
    }

    #[test]
    fn wallet_public_key_and_signature_parsing() {
        // Uncompressed key of the abandon… seed at m/44'/3'/0'/0/0 with a made-up address and
        // chain code: the parser keeps the key (compressed), address and chain code.
        let seed = wallet_core::Mnemonic::parse(
            "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
        )
        .unwrap()
        .to_seed("");
        let secp = bitcoin::secp256k1::Secp256k1::new();
        let master =
            bitcoin::bip32::Xpriv::new_master(bitcoin::NetworkKind::Main, &seed[..]).unwrap();
        let k = master
            .derive_priv(
                &secp,
                &bitcoin::bip32::DerivationPath::from_str("m/44'/3'/0'/0/0").unwrap(),
            )
            .unwrap();
        let pk = k.private_key.public_key(&secp);
        let addr = "DBus3bamQjgJULBJtYXpEzDWQRwF5iwxgC";
        let mut data = vec![65u8];
        data.extend(pk.serialize_uncompressed());
        data.push(addr.len() as u8);
        data.extend(addr.as_bytes());
        data.extend([7u8; 32]);
        let w = parse_wallet_public_key(&data).unwrap();
        assert_eq!(w.pubkey, pk.serialize());
        assert_eq!(w.address, addr);
        assert_eq!(w.chain_code, [7u8; 32]);
        assert!(parse_wallet_public_key(&data[..60]).is_err());
        // Parity bit in the first byte is cleared; the sighash type must be the expected one.
        let mut sig = vec![0x31, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01, 0x41];
        assert_eq!(parse_signature(sig.clone(), 0x41).unwrap()[0], 0x30);
        assert!(parse_signature(sig.clone(), 0x01).is_err());
        sig[0] = 0x20;
        assert!(parse_signature(sig, 0x41).is_err());
        assert_eq!(address_format(UtxoCoin::BitcoinCash), 0x03);
        assert_eq!(address_format(UtxoCoin::Litecoin), 0x02);
    }

    /// The whole Litecoin (BIP143) and Dogecoin (legacy) flows against a scripted app: the
    /// order and kind of APDUs, what each input carries, and the signatures handed back.
    #[test]
    fn signing_flows_against_a_scripted_app() {
        use bitcoin::{absolute::LockTime, transaction::Version, Amount, OutPoint, ScriptBuf};
        use bitcoin::{Sequence, TxIn, TxOut, Witness};
        let pk = [2u8; 33];
        let prev = Transaction {
            version: Version::ONE,
            lock_time: LockTime::ZERO,
            input: vec![TxIn {
                previous_output: OutPoint::null(),
                script_sig: ScriptBuf::from_bytes(vec![0x51]),
                sequence: Sequence::MAX,
                witness: Witness::new(),
            }],
            output: vec![TxOut {
                value: Amount::from_sat(1_000),
                script_pubkey: ScriptBuf::from_bytes(vec![0x00, 0x14, 1, 2, 3]),
            }],
        };
        let mk_tx = |n: usize| Transaction {
            version: Version::TWO,
            lock_time: LockTime::ZERO,
            input: (0..n)
                .map(|_| TxIn {
                    previous_output: OutPoint {
                        txid: prev.compute_txid(),
                        vout: 0,
                    },
                    script_sig: ScriptBuf::new(),
                    sequence: Sequence::MAX,
                    witness: Witness::new(),
                })
                .collect(),
            output: vec![TxOut {
                value: Amount::from_sat(900),
                script_pubkey: ScriptBuf::from_bytes(vec![0x6a]),
            }],
        };
        for coin in [UtxoCoin::Litecoin, UtxoCoin::Dogecoin] {
            let tx = mk_tx(2);
            let mut psbt = Psbt::from_unsigned_tx(tx).unwrap();
            for i in &mut psbt.inputs {
                i.non_witness_utxo = Some(prev.clone());
            }
            let plan = UtxoHwPlan {
                summary: wallet_core::UtxoTxSummary {
                    coin,
                    outputs: vec![],
                    inputs: 2,
                    our_inputs: 2,
                    fee: "100".into(),
                    size: 1,
                    fee_per_kb: 1,
                    has_change: false,
                    warnings: vec![],
                    requires_extra_confirmation: false,
                },
                inputs: (0..2)
                    .map(|k| wallet_core::UtxoHwInput {
                        index: k,
                        path: vec![0x8000_002c, 0x8000_0003, 0x8000_0000, 0, k as u32],
                        pubkey: pk,
                        amount: 1_000,
                        script: vec![0x76, 0xa9],
                    })
                    .collect(),
                change: vec![],
            };
            let mut log: Vec<(u8, u8, u8)> = Vec::new();
            let mut call = |a: &[u8], _ctx: SwContext| -> HwResult<Vec<u8>> {
                log.push((a[1], a[2], a[3]));
                Ok(match a[1] {
                    INS_GET_TRUSTED_INPUT if a[2] == 0x80 && a.len() == 9 => vec![0x32; 56],
                    INS_HASH_SIGN => vec![0x31, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01, 0x01],
                    _ => vec![],
                })
            };
            let sigs = sign(
                &mut call,
                &Ctl::for_tests(std::time::Duration::from_secs(5)),
                coin,
                &psbt,
                &plan,
            )
            .unwrap();
            assert_eq!(sigs.len(), 2);
            assert_eq!(sigs[1].input, 1);
            assert_eq!(sigs[0].signature[0], 0x30);
            let starts: Vec<u8> = log
                .iter()
                .filter(|l| l.0 == INS_HASH_INPUT_START && l.1 == 0x00)
                .map(|l| l.2)
                .collect();
            let signs = log.iter().filter(|l| l.0 == INS_HASH_SIGN).count();
            let finals = log
                .iter()
                .filter(|l| l.0 == INS_HASH_INPUT_FINALIZE_FULL)
                .count();
            match coin {
                // BIP143: one new transaction (P2 02), then one pseudo-transaction per input
                // (P2 80), outputs once.
                UtxoCoin::Litecoin => {
                    assert_eq!(starts, vec![0x02, 0x80, 0x80]);
                    assert_eq!(finals, 1);
                }
                // Legacy: the transaction again for each input, outputs each time.
                _ => {
                    assert_eq!(starts, vec![0x00, 0x80]);
                    assert_eq!(finals, 2);
                }
            }
            assert_eq!(signs, 2);
        }
    }
}
