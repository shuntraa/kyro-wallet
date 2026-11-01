//! Zcash (transparent, v5 transactions) on a Trezor: the Bitcoin `SignTx` / `TxRequest` /
//! `TxAck*` protocol with coin "Zcash" ("Zcash Testnet"), `version` 5, `version_group_id`
//! `0x26A7270A`, the consensus `branch_id` and `expiry` (firmware 2.5.1 / One 1.11.1, "Support
//! Zcash version 5 transaction format").
//!
//! The firmware's Zcash signer (`core/src/apps/zcash/signer.py`) signs the ZIP-244 digest and,
//! since ZIP 244 commits to the amount and script of every spent output, does not ask for the
//! previous transactions (it runs the taproot-only path of `step3_verify_inputs`): an input is
//! its outpoint, path and amount. A request for a previous transaction is refused here.
//!
//! Inputs are ours only (`address_n` from Kyro's plan, built from the stored xpub), the change
//! goes as `address_n` (the firmware re-derives it), the payment as Kyro's decoded address.
//! The returned DER signatures are verified by `wallet_core::zec_hw_finalize` against Kyro's own
//! ZIP-244 digests and keys before anything is assembled.

use protobuf::{Message, MessageField};
use trezor_client::protos::{self, tx_request::RequestType, MessageType};
use wallet_core::{Network, ZecHwPlan, ZEC_V5_VERSION_GROUP_ID};

use super::trezor::{decode, TrezorIo};
use super::{Ctl, HwError, HwResult, Prompt};

/// Zcash v5 on the Trezor Model T / Safe; the One needs 1.11.1.
pub const MIN_FIRMWARE: &str = "2.5.1";
pub const MIN_FIRMWARE_ONE: &str = "1.11.1";

const MAX_STEPS: usize = 10_000;

/// The firmware's coin name (`common/defs/bitcoin/zcash*.json`).
pub fn coin_name(net: Network) -> &'static str {
    match net {
        Network::Mainnet => "Zcash",
        Network::Testnet => "Zcash Testnet",
    }
}

fn encode<M: Message>(m: &M) -> HwResult<Vec<u8>> {
    m.write_to_bytes()
        .map_err(|e| HwError::bad(format!("protobuf encoding: {e}")))
}

/// `GetPublicKey` of the account `m/44'/133'/a'` (testnet `m/44'/1'/a'`).
pub fn get_public_key(net: Network, path: &[u32]) -> protos::GetPublicKey {
    let mut req = protos::GetPublicKey::new();
    req.address_n = path.to_vec();
    req.set_coin_name(coin_name(net).into());
    req.set_script_type(protos::InputScriptType::SPENDADDRESS);
    req.set_ignore_xpub_magic(true);
    req.set_show_display(false);
    req
}

pub fn get_address(net: Network, path: &[u32], display: bool) -> protos::GetAddress {
    let mut req = protos::GetAddress::new();
    req.address_n = path.to_vec();
    req.set_coin_name(coin_name(net).into());
    req.set_script_type(protos::InputScriptType::SPENDADDRESS);
    req.set_show_display(display);
    req
}

pub fn sign_tx_start(plan: &ZecHwPlan, net: Network) -> HwResult<protos::SignTx> {
    let n = |x: usize| u32::try_from(x).map_err(|_| HwError::unsupported("too many items"));
    let mut start = protos::SignTx::new();
    start.set_inputs_count(n(plan.inputs.len())?);
    start.set_outputs_count(n(plan.outputs.len())?);
    start.set_coin_name(coin_name(net).into());
    start.set_version(5);
    start.set_version_group_id(ZEC_V5_VERSION_GROUP_ID);
    start.set_branch_id(plan.branch_id);
    start.set_expiry(plan.expiry_height);
    start.set_lock_time(plan.lock_time);
    Ok(start)
}

fn ack_input(plan: &ZecHwPlan, i: usize) -> HwResult<Vec<u8>> {
    let inp = plan
        .inputs
        .get(i)
        .ok_or_else(|| HwError::bad("invalid input index"))?;
    let mut hash = inp.prev_hash;
    // Trezor takes the txid in display order.
    hash.reverse();
    let mut input = protos::TxInput::new();
    input.address_n = inp.path.clone();
    input.set_prev_hash(hash.to_vec());
    input.set_prev_index(inp.prev_index);
    input.set_sequence(u32::MAX);
    input.set_amount(inp.amount);
    input.set_script_type(protos::InputScriptType::SPENDADDRESS);
    let mut ack = protos::TxAckInput::new();
    let mut w = protos::tx_ack_input::TxAckInputWrapper::new();
    w.input = MessageField::some(input);
    ack.tx = MessageField::some(w);
    encode(&ack)
}

fn ack_output(plan: &ZecHwPlan, j: usize) -> HwResult<Vec<u8>> {
    let out = plan
        .outputs
        .get(j)
        .ok_or_else(|| HwError::bad("invalid output index"))?;
    let mut o = protos::TxOutput::new();
    o.set_amount(out.amount);
    match &out.change_path {
        Some(p) => o.address_n = p.clone(),
        None => o.set_address(out.address.clone()),
    }
    o.set_script_type(protos::OutputScriptType::PAYTOADDRESS);
    let mut ack = protos::TxAckOutput::new();
    let mut w = protos::tx_ack_output::TxAckOutputWrapper::new();
    w.output = MessageField::some(o);
    ack.tx = MessageField::some(w);
    encode(&ack)
}

/// The whole `SignTx` flow; returns one DER signature per input, in input order (unverified).
pub fn sign_tx(
    io: &mut dyn TrezorIo,
    ctl: &Ctl,
    plan: &ZecHwPlan,
    net: Network,
) -> HwResult<Vec<Vec<u8>>> {
    ctl.prompt(Prompt::ConfirmOnDevice);
    let mut resp = io.call(
        ctl,
        MessageType::MessageType_SignTx,
        encode(&sign_tx_start(plan, net)?)?,
    )?;
    let mut sigs: Vec<Option<Vec<u8>>> = vec![None; plan.inputs.len()];
    for _ in 0..MAX_STEPS {
        let r: protos::TxRequest = decode(resp)?;
        if let Some(s) = r.serialized.as_ref() {
            if let (Some(i), Some(sig)) = (s.signature_index, s.signature.as_ref()) {
                let slot = sigs
                    .get_mut(i as usize)
                    .ok_or_else(|| HwError::bad("signature of a non-existent input"))?;
                *slot = Some(sig.clone());
            }
        }
        let details = r.details.as_ref().cloned().unwrap_or_default();
        let index = || {
            details
                .request_index
                .map(|i| i as usize)
                .ok_or_else(|| HwError::bad("TxRequest without an index"))
        };
        let ack = match (r.request_type(), details.tx_hash.is_some()) {
            (RequestType::TXFINISHED, _) => {
                return sigs
                    .into_iter()
                    .map(|s| s.ok_or_else(|| HwError::bad("missing signature")))
                    .collect();
            }
            (RequestType::TXINPUT, false) => ack_input(plan, index()?)?,
            (RequestType::TXOUTPUT, false) => ack_output(plan, index()?)?,
            (_, true) => {
                return Err(HwError::unsupported(
                    "this firmware asks for the previous transactions (Zcash v5: not needed): update the Trezor",
                ))
            }
            (other, _) => {
                return Err(HwError::unsupported(format!(
                    "unsupported Trezor request: {other:?}"
                )))
            }
        };
        resp = io.call(ctl, MessageType::MessageType_TxAck, ack)?;
    }
    Err(HwError::bad("too many exchanges with the device"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::time::Duration;
    use trezor_client::transport::ProtoMessage;
    use trezor_client::TrezorMessage;
    use wallet_core::{ZecHwInput, ZecHwOutput};

    struct Firmware {
        script: VecDeque<protos::TxRequest>,
        sent: Vec<(MessageType, Vec<u8>)>,
    }

    impl TrezorIo for Firmware {
        fn call(&mut self, _c: &Ctl, mt: MessageType, payload: Vec<u8>) -> HwResult<ProtoMessage> {
            self.sent.push((mt, payload));
            let r = self.script.pop_front().expect("script exhausted");
            Ok(ProtoMessage::new(
                protos::TxRequest::MESSAGE_TYPE,
                r.write_to_bytes().unwrap(),
            ))
        }
    }

    fn req(t: RequestType, i: Option<u32>, hash: Option<Vec<u8>>) -> protos::TxRequest {
        let mut r = protos::TxRequest::new();
        r.set_request_type(t);
        let mut d = protos::tx_request::TxRequestDetailsType::new();
        d.request_index = i;
        d.tx_hash = hash;
        r.details = MessageField::some(d);
        r
    }

    fn with_sig(mut r: protos::TxRequest, i: u32, sig: Vec<u8>) -> protos::TxRequest {
        let mut s = protos::tx_request::TxRequestSerializedType::new();
        s.signature_index = Some(i);
        s.signature = Some(sig);
        r.serialized = MessageField::some(s);
        r
    }

    fn plan() -> ZecHwPlan {
        let mut prev = [0u8; 32];
        prev[0] = 0xAB;
        ZecHwPlan {
            inputs: vec![ZecHwInput {
                prev_hash: prev,
                prev_index: 3,
                amount: 30_000_000,
                path: vec![0x8000_002c, 0x8000_0085, 0x8000_0000, 0, 0],
                pubkey: [2; 33],
            }],
            outputs: vec![
                ZecHwOutput {
                    amount: 12_345_678,
                    address: "t1VmmGiyjVNeCjxDZzg7vZmd99WyzVby9yC".into(),
                    change_path: None,
                },
                ZecHwOutput {
                    amount: 17_644_322,
                    address: "t1-change".into(),
                    change_path: Some(vec![0x8000_002c, 0x8000_0085, 0x8000_0000, 1, 2]),
                },
            ],
            branch_id: 0x37a5_165b,
            expiry_height: 3_537_825,
            lock_time: 0,
            digests: vec![[0; 32]],
            summary: wallet_core::ZecTxSummary {
                to: String::new(),
                to_kind: wallet_core::ZecAddressKind::P2pkh,
                to_address: String::new(),
                amount: String::new(),
                change: None,
                fee: String::new(),
                zip317_fee: String::new(),
                folded: String::new(),
                inputs: 1,
                input_total: String::new(),
                upgrade: String::new(),
                branch_id: String::new(),
                target_height: 0,
                expiry_height: 0,
                txid: String::new(),
                warnings: vec![],
                requires_extra_confirmation: false,
            },
        }
    }

    /// The flow of the firmware's Zcash signer: inputs, outputs (second pass included), the
    /// signature serialized with a later request, no previous transaction.
    #[test]
    fn flow_against_simulated_firmware() {
        let p = plan();
        let mut fw = Firmware {
            script: VecDeque::from(vec![
                req(RequestType::TXINPUT, Some(0), None),
                req(RequestType::TXOUTPUT, Some(0), None),
                req(RequestType::TXOUTPUT, Some(1), None),
                req(RequestType::TXINPUT, Some(0), None),
                req(RequestType::TXOUTPUT, Some(0), None),
                req(RequestType::TXOUTPUT, Some(1), None),
                with_sig(req(RequestType::TXFINISHED, None, None), 0, vec![0x30, 1]),
            ]),
            sent: vec![],
        };
        let sigs = sign_tx(
            &mut fw,
            &Ctl::for_tests(Duration::from_secs(5)),
            &p,
            Network::Mainnet,
        )
        .unwrap();
        assert_eq!(sigs, vec![vec![0x30, 1]]);
        let start = protos::SignTx::parse_from_bytes(&fw.sent[0].1).unwrap();
        assert_eq!(start.coin_name(), "Zcash");
        assert_eq!(
            (start.version(), start.version_group_id()),
            (5, 0x26A7_270A)
        );
        assert_eq!(
            (start.branch_id(), start.expiry()),
            (0x37a5_165b, 3_537_825)
        );
        assert_eq!((start.inputs_count(), start.outputs_count()), (1, 2));
        let inp = protos::TxAckInput::parse_from_bytes(&fw.sent[1].1).unwrap();
        let i = inp.tx.input.as_ref().unwrap();
        assert_eq!(i.prev_hash()[31], 0xAB); // display order
        assert_eq!((i.prev_index(), i.amount()), (3, 30_000_000));
        assert_eq!(i.address_n, p.inputs[0].path);
        let o0 = protos::TxAckOutput::parse_from_bytes(&fw.sent[2].1).unwrap();
        assert_eq!(
            o0.tx.output.address(),
            "t1VmmGiyjVNeCjxDZzg7vZmd99WyzVby9yC"
        );
        let o1 = protos::TxAckOutput::parse_from_bytes(&fw.sent[3].1).unwrap();
        assert!(!o1.tx.output.has_address());
        assert_eq!(
            o1.tx.output.address_n,
            p.outputs[1].change_path.clone().unwrap()
        );

        // A firmware asking for a previous transaction, or finishing without a signature.
        let mut fw = Firmware {
            script: VecDeque::from(vec![req(RequestType::TXMETA, None, Some(vec![1; 32]))]),
            sent: vec![],
        };
        assert!(matches!(
            sign_tx(
                &mut fw,
                &Ctl::for_tests(Duration::from_secs(5)),
                &p,
                Network::Mainnet
            ),
            Err(HwError::Unsupported { .. })
        ));
        let mut fw = Firmware {
            script: VecDeque::from(vec![req(RequestType::TXFINISHED, None, None)]),
            sent: vec![],
        };
        assert!(sign_tx(
            &mut fw,
            &Ctl::for_tests(Duration::from_secs(5)),
            &p,
            Network::Testnet
        )
        .is_err());
        assert_eq!(coin_name(Network::Testnet), "Zcash Testnet");
    }
}
