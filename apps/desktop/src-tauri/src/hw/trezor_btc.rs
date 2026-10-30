//! Bitcoin signing on a Trezor. Trezor does not take a PSBT: the firmware asks for the
//! transaction piece by piece (`TxRequest`) and Kyro answers from the PSBT (`TxAck*`).
//!
//! Mapping (protocol of `messages-bitcoin.proto`, typed acks wire-compatible with `TxAck`):
//! - `TXINPUT` (current tx): our inputs only, with `address_n` from the key origin already
//!   checked against the account xpub (`wallet_core::btc_hw_plan`), `SPENDWITNESS` (BIP84) or
//!   `SPENDTAPROOT` (BIP86), amount from `witness_utxo`. External inputs are refused.
//! - `TXOUTPUT` (current tx): change outputs (verified against the xpub) as `address_n` +
//!   `PAYTOWITNESS`/`PAYTOTAPROOT` (the firmware re-derives and hides them only if they
//!   belong to the same account), `OP_RETURN` as `PAYTOOPRETURN`, everything else as an
//!   address shown on the device.
//! - `TXMETA` / `TXINPUT` / `TXOUTPUT` with `tx_hash`: the previous transaction, from the
//!   PSBT's `non_witness_utxo`, whose txid is recomputed here. The firmware requires it for
//!   SegWit v0 inputs (amount attack); it skips it when all our inputs are Taproot (≥ 2.4.3 /
//!   1.10.4).
//! - Signatures arrive in `serialized.signature` (DER for SegWit, 64-byte BIP340 for Taproot)
//!   and are verified by `wallet_core::btc_hw_finalize` before anything is returned.
//! - Replacement (`TXORIGINPUT`/`TXORIGOUTPUT`), payment requests and extra data are refused.

use bitcoin::hashes::Hash;
use bitcoin::script::Instruction;
use bitcoin::{Address, Transaction, Txid};
use protobuf::{Message, MessageField};
use trezor_client::protos::{self, tx_request::RequestType, MessageType};
use wallet_core::{BtcKind, HwBtcSignature, Network};

use super::trezor::{decode, TrezorIo};
use super::{BtcSignRequest, Ctl, HwError, HwResult, Prompt};

/// Hard cap on request/ack rounds (a 100-input transaction needs well under this).
const MAX_STEPS: usize = 20_000;

fn display_bytes(txid: &Txid) -> Vec<u8> {
    let mut b = txid.to_byte_array();
    b.reverse();
    b.to_vec()
}

fn encode<M: Message>(m: &M) -> HwResult<Vec<u8>> {
    m.write_to_bytes()
        .map_err(|e| HwError::bad(format!("encodage protobuf : {e}")))
}

/// The previous transaction with display-order txid `hash`, from `non_witness_utxo`.
fn prev_tx<'a>(req: &'a BtcSignRequest<'_>, hash: &[u8]) -> HwResult<&'a Transaction> {
    for (txin, input) in req.psbt.unsigned_tx.input.iter().zip(&req.psbt.inputs) {
        if display_bytes(&txin.previous_output.txid) != hash {
            continue;
        }
        let tx = input.non_witness_utxo.as_ref().ok_or_else(|| {
            HwError::unsupported(
                "la PSBT doit contenir la transaction précédente (non_witness_utxo) de \
                 chaque entrée SegWit",
            )
        })?;
        if tx.compute_txid() != txin.previous_output.txid {
            return Err(HwError::bad("transaction précédente incohérente"));
        }
        return Ok(tx);
    }
    Err(HwError::bad("l'appareil demande une transaction inconnue"))
}

fn idx(details: &protos::tx_request::TxRequestDetailsType) -> HwResult<usize> {
    details
        .request_index
        .map(|i| i as usize)
        .ok_or_else(|| HwError::bad("TxRequest sans index"))
}

fn ack_input(req: &BtcSignRequest<'_>, i: usize) -> HwResult<Vec<u8>> {
    let ours = req
        .plan
        .inputs
        .iter()
        .find(|p| p.index == i)
        .ok_or_else(|| HwError::unsupported("entrée qui n'appartient pas à ce compte"))?;
    let txin = req
        .psbt
        .unsigned_tx
        .input
        .get(i)
        .ok_or_else(|| HwError::bad("index d'entrée invalide"))?;
    let mut input = protos::TxInput::new();
    input.address_n = ours.path.clone();
    input.set_prev_hash(display_bytes(&txin.previous_output.txid));
    input.set_prev_index(txin.previous_output.vout);
    input.set_sequence(txin.sequence.to_consensus_u32());
    input.set_amount(ours.amount);
    input.set_script_type(match ours.kind {
        BtcKind::Segwit => protos::InputScriptType::SPENDWITNESS,
        BtcKind::Taproot => protos::InputScriptType::SPENDTAPROOT,
    });
    let mut ack = protos::TxAckInput::new();
    let mut w = protos::tx_ack_input::TxAckInputWrapper::new();
    w.input = MessageField::some(input);
    ack.tx = MessageField::some(w);
    encode(&ack)
}

/// `OP_RETURN <single push>` payload.
fn op_return_data(spk: &bitcoin::Script) -> HwResult<Vec<u8>> {
    let mut it = spk.instructions();
    it.next(); // OP_RETURN
    let data = match it.next() {
        None => Vec::new(),
        Some(Ok(Instruction::PushBytes(b))) => b.as_bytes().to_vec(),
        _ => return Err(HwError::unsupported("sortie OP_RETURN non standard")),
    };
    if it.next().is_some() {
        return Err(HwError::unsupported("sortie OP_RETURN non standard"));
    }
    Ok(data)
}

fn ack_output(req: &BtcSignRequest<'_>, net: Network, j: usize) -> HwResult<Vec<u8>> {
    let out = req
        .psbt
        .unsigned_tx
        .output
        .get(j)
        .ok_or_else(|| HwError::bad("index de sortie invalide"))?;
    let mut o = protos::TxOutput::new();
    o.set_amount(out.value.to_sat());
    if let Some(c) = req.plan.change.iter().find(|c| c.index == j) {
        o.address_n = c.path.clone();
        o.set_script_type(match c.kind {
            BtcKind::Segwit => protos::OutputScriptType::PAYTOWITNESS,
            BtcKind::Taproot => protos::OutputScriptType::PAYTOTAPROOT,
        });
    } else if out.script_pubkey.is_op_return() {
        if out.value.to_sat() != 0 {
            return Err(HwError::unsupported("OP_RETURN avec un montant non nul"));
        }
        o.set_script_type(protos::OutputScriptType::PAYTOOPRETURN);
        o.set_op_return_data(op_return_data(&out.script_pubkey)?);
    } else {
        let btc_net = match net {
            Network::Mainnet => bitcoin::Network::Bitcoin,
            Network::Testnet => bitcoin::Network::Testnet,
        };
        let addr = Address::from_script(&out.script_pubkey, btc_net)
            .map_err(|_| HwError::unsupported("sortie vers un script non standard"))?;
        o.set_address(addr.to_string());
        o.set_script_type(protos::OutputScriptType::PAYTOADDRESS);
    }
    let mut ack = protos::TxAckOutput::new();
    let mut w = protos::tx_ack_output::TxAckOutputWrapper::new();
    w.output = MessageField::some(o);
    ack.tx = MessageField::some(w);
    encode(&ack)
}

fn ack_prev_meta(tx: &Transaction) -> HwResult<Vec<u8>> {
    let mut p = protos::PrevTx::new();
    p.set_version(tx.version.0 as u32);
    p.set_lock_time(tx.lock_time.to_consensus_u32());
    p.set_inputs_count(tx.input.len() as u32);
    p.set_outputs_count(tx.output.len() as u32);
    p.set_extra_data_len(0);
    let mut ack = protos::TxAckPrevMeta::new();
    ack.tx = MessageField::some(p);
    encode(&ack)
}

fn ack_prev_input(tx: &Transaction, i: usize) -> HwResult<Vec<u8>> {
    let txin = tx
        .input
        .get(i)
        .ok_or_else(|| HwError::bad("index d'entrée précédente invalide"))?;
    let mut p = protos::PrevInput::new();
    p.set_prev_hash(display_bytes(&txin.previous_output.txid));
    p.set_prev_index(txin.previous_output.vout);
    p.set_script_sig(txin.script_sig.to_bytes());
    p.set_sequence(txin.sequence.to_consensus_u32());
    let mut ack = protos::TxAckPrevInput::new();
    let mut w = protos::tx_ack_prev_input::TxAckPrevInputWrapper::new();
    w.input = MessageField::some(p);
    ack.tx = MessageField::some(w);
    encode(&ack)
}

fn ack_prev_output(tx: &Transaction, j: usize) -> HwResult<Vec<u8>> {
    let out = tx
        .output
        .get(j)
        .ok_or_else(|| HwError::bad("index de sortie précédente invalide"))?;
    let mut p = protos::PrevOutput::new();
    p.set_amount(out.value.to_sat());
    p.set_script_pubkey(out.script_pubkey.to_bytes());
    let mut ack = protos::TxAckPrevOutput::new();
    let mut w = protos::tx_ack_prev_output::TxAckPrevOutputWrapper::new();
    w.output = MessageField::some(p);
    ack.tx = MessageField::some(w);
    encode(&ack)
}

/// Runs the whole `SignTx` flow and returns the device's raw signatures (unverified).
pub fn sign(
    io: &mut impl TrezorIo,
    ctl: &Ctl,
    net: Network,
    coin: &str,
    req: &BtcSignRequest<'_>,
) -> HwResult<Vec<HwBtcSignature>> {
    if !req.plan.external_inputs.is_empty() {
        return Err(HwError::unsupported(
            "transaction avec des entrées qui n'appartiennent pas à ce compte",
        ));
    }
    let tx = &req.psbt.unsigned_tx;
    let mut start = protos::SignTx::new();
    start.set_inputs_count(tx.input.len() as u32);
    start.set_outputs_count(tx.output.len() as u32);
    start.set_coin_name(coin.into());
    start.set_version(tx.version.0 as u32);
    start.set_lock_time(tx.lock_time.to_consensus_u32());
    ctl.prompt(Prompt::ConfirmOnDevice);
    let mut resp = io.call(ctl, MessageType::MessageType_SignTx, encode(&start)?)?;
    let mut sigs = Vec::new();
    for _ in 0..MAX_STEPS {
        let r: protos::TxRequest = decode(resp)?;
        if let Some(s) = r.serialized.as_ref() {
            if let (Some(i), Some(sig)) = (s.signature_index, s.signature.as_ref()) {
                sigs.push(HwBtcSignature {
                    input: i as usize,
                    pubkey: None,
                    signature: sig.clone(),
                });
            }
        }
        let details = r.details.as_ref().cloned().unwrap_or_default();
        let hash = details.tx_hash.clone();
        let ack = match (r.request_type(), hash) {
            (RequestType::TXFINISHED, _) => return Ok(sigs),
            (RequestType::TXINPUT, None) => ack_input(req, idx(&details)?)?,
            (RequestType::TXOUTPUT, None) => ack_output(req, net, idx(&details)?)?,
            (RequestType::TXMETA, Some(h)) => ack_prev_meta(prev_tx(req, &h)?)?,
            (RequestType::TXINPUT, Some(h)) => ack_prev_input(prev_tx(req, &h)?, idx(&details)?)?,
            (RequestType::TXOUTPUT, Some(h)) => ack_prev_output(prev_tx(req, &h)?, idx(&details)?)?,
            (other, _) => {
                return Err(HwError::unsupported(format!(
                    "requête Trezor non prise en charge : {other:?}"
                )))
            }
        };
        resp = io.call(ctl, MessageType::MessageType_TxAck, ack)?;
    }
    Err(HwError::bad("trop d'échanges avec l'appareil"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hw::trezor::TrezorIo;
    use std::collections::VecDeque;
    use std::str::FromStr;
    use std::time::Duration;
    use trezor_client::transport::ProtoMessage;

    const ABANDON: &str =
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    /// Simulated firmware: issues the TxRequests a real Trezor issues for a 1-input P2WPKH
    /// transaction (phase 1: inputs, outputs, previous tx; phase 2: signing), checks every ack
    /// and returns the given signature on the last input request.
    struct Firmware {
        script: VecDeque<protos::TxRequest>,
        acks: Vec<(MessageType, Vec<u8>)>,
    }

    fn txreq(t: RequestType, index: Option<u32>, hash: Option<Vec<u8>>) -> protos::TxRequest {
        let mut r = protos::TxRequest::new();
        r.set_request_type(t);
        let mut d = protos::tx_request::TxRequestDetailsType::new();
        d.request_index = index;
        d.tx_hash = hash;
        r.details = MessageField::some(d);
        r
    }

    impl TrezorIo for Firmware {
        fn call(&mut self, _c: &Ctl, mt: MessageType, payload: Vec<u8>) -> HwResult<ProtoMessage> {
            self.acks.push((mt, payload));
            let r = self.script.pop_front().expect("script exhausted");
            Ok(ProtoMessage::new(
                MessageType::MessageType_TxRequest,
                r.write_to_bytes().unwrap(),
            ))
        }
    }

    #[test]
    fn segwit_flow_against_simulated_firmware() {
        use bitcoin::bip32::{DerivationPath, Xpriv};
        use bitcoin::psbt::Psbt;
        use bitcoin::secp256k1::Secp256k1;
        use bitcoin::{
            absolute::LockTime, transaction::Version, Amount, OutPoint, ScriptBuf, Sequence, TxIn,
            TxOut, Witness,
        };

        let net = Network::Testnet;
        let m = wallet_core::Mnemonic::parse(ABANDON).unwrap();
        let seed = m.to_seed("");
        let secp = Secp256k1::new();
        let master = Xpriv::new_master(bitcoin::NetworkKind::Test, &seed[..]).unwrap();
        let fp = master.fingerprint(&secp);
        let pk = |p: &str| {
            master
                .derive_priv(&secp, &DerivationPath::from_str(p).unwrap())
                .unwrap()
                .private_key
                .public_key(&secp)
        };
        let spk = |a: &str| {
            bitcoin::Address::from_str(a)
                .unwrap()
                .require_network(bitcoin::Network::Testnet)
                .unwrap()
                .script_pubkey()
        };
        let ours = wallet_core::btc_address(&seed, net, BtcKind::Segwit, 0, false, 0).unwrap();
        let change = wallet_core::btc_address(&seed, net, BtcKind::Segwit, 0, true, 0).unwrap();
        let dest = "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx";
        // Previous transaction paying 100 000 sats to our address (output 1).
        let prev = Transaction {
            version: Version::TWO,
            lock_time: LockTime::ZERO,
            input: vec![TxIn {
                previous_output: OutPoint::null(),
                script_sig: ScriptBuf::from_bytes(vec![0x51]),
                sequence: Sequence::MAX,
                witness: Witness::new(),
            }],
            output: vec![
                TxOut {
                    value: Amount::from_sat(5),
                    script_pubkey: spk(dest),
                },
                TxOut {
                    value: Amount::from_sat(100_000),
                    script_pubkey: spk(&ours),
                },
            ],
        };
        let tx = Transaction {
            version: Version::TWO,
            lock_time: LockTime::ZERO,
            input: vec![TxIn {
                previous_output: OutPoint {
                    txid: prev.compute_txid(),
                    vout: 1,
                },
                script_sig: ScriptBuf::new(),
                sequence: Sequence::ENABLE_RBF_NO_LOCKTIME,
                witness: Witness::new(),
            }],
            output: vec![
                TxOut {
                    value: Amount::from_sat(60_000),
                    script_pubkey: spk(dest),
                },
                TxOut {
                    value: Amount::from_sat(39_000),
                    script_pubkey: spk(&change),
                },
            ],
        };
        let mut psbt = Psbt::from_unsigned_tx(tx).unwrap();
        psbt.inputs[0].witness_utxo = Some(prev.output[1].clone());
        psbt.inputs[0].non_witness_utxo = Some(prev.clone());
        let p0 = DerivationPath::from_str("m/84'/1'/0'/0/0").unwrap();
        psbt.inputs[0]
            .bip32_derivation
            .insert(pk("m/84'/1'/0'/0/0"), (fp, p0));
        let pc = DerivationPath::from_str("m/84'/1'/0'/1/0").unwrap();
        psbt.outputs[1]
            .bip32_derivation
            .insert(pk("m/84'/1'/0'/1/0"), (fp, pc));
        let accounts = vec![wallet_core::btc_account(&seed, net, BtcKind::Segwit, 0).unwrap()];
        let b64 = psbt.to_string();
        let plan = wallet_core::btc_hw_plan(net, &b64, &accounts).unwrap();

        // The signature an honest device returns (DER, no sighash byte).
        let (soft, _) = wallet_core::btc_sign_psbt(&seed, net, &b64).unwrap();
        let soft = Psbt::from_str(&soft).unwrap();
        let der = soft.inputs[0]
            .partial_sigs
            .values()
            .next()
            .unwrap()
            .signature
            .serialize_der()
            .to_vec();

        let h = display_bytes(&prev.compute_txid());
        let last = txreq(RequestType::TXOUTPUT, Some(1), None);
        let mut finished = txreq(RequestType::TXFINISHED, None, None);
        let mut ser = protos::tx_request::TxRequestSerializedType::new();
        ser.signature_index = Some(0);
        ser.signature = Some(der.clone());
        finished.serialized = MessageField::some(ser);
        let mut fw = Firmware {
            script: VecDeque::from(vec![
                txreq(RequestType::TXINPUT, Some(0), None),
                txreq(RequestType::TXOUTPUT, Some(0), None),
                txreq(RequestType::TXOUTPUT, Some(1), None),
                txreq(RequestType::TXMETA, None, Some(h.clone())),
                txreq(RequestType::TXINPUT, Some(0), Some(h.clone())),
                txreq(RequestType::TXOUTPUT, Some(0), Some(h.clone())),
                txreq(RequestType::TXOUTPUT, Some(1), Some(h.clone())),
                txreq(RequestType::TXINPUT, Some(0), None),
                txreq(RequestType::TXOUTPUT, Some(0), None),
                last,
                finished,
            ]),
            acks: Vec::new(),
        };
        let req = BtcSignRequest {
            psbt: &psbt,
            plan: &plan,
            accounts: &accounts,
        };
        let ctl = Ctl::for_tests(Duration::from_secs(5));
        let sigs = sign(&mut fw, &ctl, net, "Testnet", &req).unwrap();
        assert_eq!(sigs.len(), 1);

        // Check what Kyro told the "device".
        assert_eq!(fw.acks[0].0, MessageType::MessageType_SignTx);
        let start = protos::SignTx::parse_from_bytes(&fw.acks[0].1).unwrap();
        assert_eq!(
            (
                start.inputs_count(),
                start.outputs_count(),
                start.coin_name()
            ),
            (1, 2, "Testnet")
        );
        let in0 = protos::TxAckInput::parse_from_bytes(&fw.acks[1].1).unwrap();
        let in0 = in0.tx.input.as_ref().unwrap();
        assert_eq!(
            in0.address_n,
            vec![0x8000_0054, 0x8000_0001, 0x8000_0000, 0, 0]
        );
        assert_eq!(in0.amount(), 100_000);
        assert_eq!(in0.script_type(), protos::InputScriptType::SPENDWITNESS);
        assert_eq!(in0.prev_hash(), h.as_slice());
        let out0 = protos::TxAckOutput::parse_from_bytes(&fw.acks[2].1).unwrap();
        let out0 = out0.tx.output.as_ref().unwrap();
        assert_eq!((out0.address(), out0.amount()), (dest, 60_000));
        assert_eq!(out0.script_type(), protos::OutputScriptType::PAYTOADDRESS);
        let out1 = protos::TxAckOutput::parse_from_bytes(&fw.acks[3].1).unwrap();
        let out1 = out1.tx.output.as_ref().unwrap();
        assert!(!out1.has_address());
        assert_eq!(
            out1.address_n,
            vec![0x8000_0054, 0x8000_0001, 0x8000_0000, 1, 0]
        );
        assert_eq!(out1.script_type(), protos::OutputScriptType::PAYTOWITNESS);
        let meta = protos::TxAckPrevMeta::parse_from_bytes(&fw.acks[4].1).unwrap();
        assert_eq!((meta.tx.inputs_count(), meta.tx.outputs_count()), (1, 2));
        let pin = protos::TxAckPrevInput::parse_from_bytes(&fw.acks[5].1).unwrap();
        assert_eq!(pin.tx.input.script_sig(), &[0x51]);
        let pout = protos::TxAckPrevOutput::parse_from_bytes(&fw.acks[7].1).unwrap();
        assert_eq!(pout.tx.output.amount(), 100_000);
        assert_eq!(pout.tx.output.script_pubkey(), spk(&ours).as_bytes());

        // And the returned signature passes Kyro's independent verification...
        wallet_core::btc_hw_finalize(net, &b64, &accounts, &sigs).unwrap();
        // ...while a tampered one does not.
        let mut bad = sigs.clone();
        bad[0].signature[10] ^= 1;
        assert!(wallet_core::btc_hw_finalize(net, &b64, &accounts, &bad).is_err());

        // Missing previous transaction: refused before anything is answered from nothing.
        let mut no_prev = psbt.clone();
        no_prev.inputs[0].non_witness_utxo = None;
        let req = BtcSignRequest {
            psbt: &no_prev,
            plan: &plan,
            accounts: &accounts,
        };
        let mut fw = Firmware {
            script: VecDeque::from(vec![txreq(RequestType::TXMETA, None, Some(h))]),
            acks: Vec::new(),
        };
        assert!(matches!(
            sign(&mut fw, &ctl, net, "Testnet", &req),
            Err(HwError::Unsupported { .. })
        ));
        // Unsupported request types are refused, not answered.
        let req = BtcSignRequest {
            psbt: &psbt,
            plan: &plan,
            accounts: &accounts,
        };
        let mut fw = Firmware {
            script: VecDeque::from(vec![txreq(RequestType::TXORIGINPUT, Some(0), None)]),
            acks: Vec::new(),
        };
        assert!(sign(&mut fw, &ctl, net, "Testnet", &req).is_err());
    }

    #[test]
    fn op_return_payload() {
        let s = bitcoin::ScriptBuf::from_hex("6a0568656c6c6f").unwrap();
        assert_eq!(op_return_data(&s).unwrap(), b"hello");
        let s = bitcoin::ScriptBuf::from_hex("6a").unwrap();
        assert!(op_return_data(&s).unwrap().is_empty());
        let s = bitcoin::ScriptBuf::from_hex("6a01aa01bb").unwrap();
        assert!(op_return_data(&s).is_err());
    }
}
