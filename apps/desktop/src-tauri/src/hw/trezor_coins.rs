//! Litecoin, Dogecoin, Bitcoin Cash, Dash and Stellar on a Trezor (messages of Trezor's
//! `messages-bitcoin.proto` / `messages-stellar.proto`, through `trezor-client`'s bindings).
//!
//! - Bitcoin-like coins: same `SignTx` / `TxRequest` / `TxAck*` protocol as Bitcoin
//!   (`trezor_btc.rs`), with the firmware's coin name ("Litecoin", "Dogecoin", "Bcash", "Dash";
//!   testnets "Litecoin Testnet", "Bcash Testnet", "Dash Testnet" — Trezor has no Dogecoin
//!   testnet). Inputs are ours only (`address_n` checked against the account xpub by
//!   `wallet_core::utxo_hw_plan`), `SPENDWITNESS` (Litecoin) or `SPENDADDRESS`; change outputs
//!   go as `address_n` (the firmware re-derives them), other outputs as the address Kyro decoded
//!   (CashAddr for Bitcoin Cash); previous transactions from the PSBT, txid recomputed. The
//!   firmware signs Bitcoin Cash with `SIGHASH_ALL|FORKID` itself. Returned DER signatures are
//!   checked by `wallet_core::utxo_hw_finalize`.
//! - Stellar: `StellarSignTx` (source, fee, sequence, time bounds, memo, operation count) then
//!   one operation message per `StellarTxOpRequest`; the firmware rebuilds the XDR itself and
//!   returns an ed25519 signature, which Kyro verifies over **its own** transaction hash
//!   (`wallet_core::stellar_hw_assemble`): any difference in the firmware's rebuild fails there.
//!
//! XRP is not offered on Trezor: the firmware gives no public key before signing (only the
//! address), and Kyro builds and checks the Payment with its `SigningPubKey`.

use bitcoin::hashes::Hash;
use bitcoin::psbt::Psbt;
use bitcoin::script::Instruction;
use bitcoin::{Transaction, Txid};
use protobuf::{Message, MessageField};
use trezor_client::protos::{self, tx_request::RequestType, MessageType};
use wallet_core::{HwBtcSignature, Network, StellarEnvelope, StellarMemo, StellarOperation};
use wallet_core::{UtxoCoin, UtxoHwPlan};

use super::trezor::{decode, TrezorIo};
use super::{Ctl, HwError, HwResult, Prompt};

const MAX_STEPS: usize = 20_000;

/// The firmware's coin name (`common/defs/bitcoin/*.json`).
pub fn coin_name(coin: UtxoCoin, net: Network) -> HwResult<&'static str> {
    Ok(match (coin, net) {
        (UtxoCoin::Litecoin, Network::Mainnet) => "Litecoin",
        (UtxoCoin::Litecoin, Network::Testnet) => "Litecoin Testnet",
        (UtxoCoin::Dogecoin, Network::Mainnet) => "Dogecoin",
        (UtxoCoin::BitcoinCash, Network::Mainnet) => "Bcash",
        (UtxoCoin::BitcoinCash, Network::Testnet) => "Bcash Testnet",
        (UtxoCoin::Dash, Network::Mainnet) => "Dash",
        (UtxoCoin::Dash, Network::Testnet) => "Dash Testnet",
        (UtxoCoin::Dogecoin, Network::Testnet) => {
            return Err(HwError::unsupported(
                "Dogecoin testnet is not available on Trezor",
            ))
        }
    })
}

pub fn input_script_type(coin: UtxoCoin) -> protos::InputScriptType {
    match coin {
        UtxoCoin::Litecoin => protos::InputScriptType::SPENDWITNESS,
        _ => protos::InputScriptType::SPENDADDRESS,
    }
}

fn output_script_type(coin: UtxoCoin) -> protos::OutputScriptType {
    match coin {
        UtxoCoin::Litecoin => protos::OutputScriptType::PAYTOWITNESS,
        _ => protos::OutputScriptType::PAYTOADDRESS,
    }
}

fn encode<M: Message>(m: &M) -> HwResult<Vec<u8>> {
    m.write_to_bytes()
        .map_err(|e| HwError::bad(format!("protobuf encoding: {e}")))
}

fn display_bytes(txid: &Txid) -> Vec<u8> {
    let mut b = txid.to_byte_array();
    b.reverse();
    b.to_vec()
}

/// `GetPublicKey` of an account (`node` + `root_fingerprint` are used, not the coin-specific
/// `xpub` string, whose version bytes vary: Ltub, dgub…).
pub fn get_public_key(
    coin: UtxoCoin,
    net: Network,
    path: &[u32],
) -> HwResult<protos::GetPublicKey> {
    let mut req = protos::GetPublicKey::new();
    req.address_n = path.to_vec();
    req.set_coin_name(coin_name(coin, net)?.into());
    req.set_script_type(input_script_type(coin));
    req.set_ignore_xpub_magic(true);
    req.set_show_display(false);
    Ok(req)
}

/// Standard `xpub`/`tpub` of a `PublicKey` answer, and the master fingerprint.
pub fn account_xpub(pk: &protos::PublicKey, net: Network) -> HwResult<(String, String)> {
    let node = pk
        .node
        .as_ref()
        .ok_or_else(|| HwError::bad("missing node"))?;
    let key = bitcoin::secp256k1::PublicKey::from_slice(node.public_key())
        .map_err(|_| HwError::bad("invalid public key"))?;
    let chain_code: [u8; 32] = node
        .chain_code()
        .try_into()
        .map_err(|_| HwError::bad("invalid chain code"))?;
    let xpub = bitcoin::bip32::Xpub {
        network: match net {
            Network::Mainnet => bitcoin::NetworkKind::Main,
            Network::Testnet => bitcoin::NetworkKind::Test,
        },
        depth: u8::try_from(node.depth()).map_err(|_| HwError::bad("invalid depth"))?,
        parent_fingerprint: node.fingerprint().to_be_bytes().into(),
        child_number: node.child_num().into(),
        public_key: key,
        chain_code: chain_code.into(),
    };
    let fp = pk
        .root_fingerprint
        .ok_or_else(|| HwError::too_old("master fingerprint not provided", "2.4.3"))?;
    Ok((xpub.to_string(), format!("{fp:08x}")))
}

pub fn get_address(
    coin: UtxoCoin,
    net: Network,
    path: &[u32],
    display: bool,
) -> HwResult<protos::GetAddress> {
    let mut req = protos::GetAddress::new();
    req.address_n = path.to_vec();
    req.set_coin_name(coin_name(coin, net)?.into());
    req.set_script_type(input_script_type(coin));
    req.set_show_display(display);
    Ok(req)
}

struct Utxo<'a> {
    coin: UtxoCoin,
    net: Network,
    psbt: &'a Psbt,
    plan: &'a UtxoHwPlan,
}

impl Utxo<'_> {
    fn prev_tx(&self, hash: &[u8]) -> HwResult<&Transaction> {
        for (txin, input) in self.psbt.unsigned_tx.input.iter().zip(&self.psbt.inputs) {
            if display_bytes(&txin.previous_output.txid) != hash {
                continue;
            }
            let tx = input.non_witness_utxo.as_ref().ok_or_else(|| {
                HwError::unsupported("the previous transaction of every input is required")
            })?;
            if tx.compute_txid() != txin.previous_output.txid {
                return Err(HwError::bad("inconsistent previous transaction"));
            }
            return Ok(tx);
        }
        Err(HwError::bad("the device requested an unknown transaction"))
    }

    fn ack_input(&self, i: usize) -> HwResult<Vec<u8>> {
        let ours = self
            .plan
            .inputs
            .iter()
            .find(|p| p.index == i)
            .ok_or_else(|| HwError::unsupported("input that does not belong to this account"))?;
        let txin = self
            .psbt
            .unsigned_tx
            .input
            .get(i)
            .ok_or_else(|| HwError::bad("invalid input index"))?;
        let mut input = protos::TxInput::new();
        input.address_n = ours.path.clone();
        input.set_prev_hash(display_bytes(&txin.previous_output.txid));
        input.set_prev_index(txin.previous_output.vout);
        input.set_sequence(txin.sequence.to_consensus_u32());
        input.set_amount(ours.amount);
        input.set_script_type(input_script_type(self.coin));
        let mut ack = protos::TxAckInput::new();
        let mut w = protos::tx_ack_input::TxAckInputWrapper::new();
        w.input = MessageField::some(input);
        ack.tx = MessageField::some(w);
        encode(&ack)
    }

    fn ack_output(&self, j: usize) -> HwResult<Vec<u8>> {
        let out = self
            .psbt
            .unsigned_tx
            .output
            .get(j)
            .ok_or_else(|| HwError::bad("invalid output index"))?;
        let mut o = protos::TxOutput::new();
        o.set_amount(out.value.to_sat());
        if let Some(c) = self.plan.change.iter().find(|c| c.index == j) {
            o.address_n = c.path.clone();
            o.set_script_type(output_script_type(self.coin));
        } else if out.script_pubkey.is_op_return() {
            if out.value.to_sat() != 0 {
                return Err(HwError::unsupported("OP_RETURN with a non-zero amount"));
            }
            let mut it = out.script_pubkey.instructions();
            it.next();
            let data = match (it.next(), it.next()) {
                (None, _) => Vec::new(),
                (Some(Ok(Instruction::PushBytes(b))), None) => b.as_bytes().to_vec(),
                _ => return Err(HwError::unsupported("non-standard OP_RETURN output")),
            };
            o.set_script_type(protos::OutputScriptType::PAYTOOPRETURN);
            o.set_op_return_data(data);
        } else {
            let addr = wallet_core::utxo_address_of_script(
                out.script_pubkey.as_bytes(),
                self.net,
                self.coin,
            )
            .ok_or_else(|| HwError::unsupported("output to a non-standard script"))?;
            o.set_address(addr);
            o.set_script_type(protos::OutputScriptType::PAYTOADDRESS);
        }
        let mut ack = protos::TxAckOutput::new();
        let mut w = protos::tx_ack_output::TxAckOutputWrapper::new();
        w.output = MessageField::some(o);
        ack.tx = MessageField::some(w);
        encode(&ack)
    }
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
        .ok_or_else(|| HwError::bad("invalid previous input index"))?;
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
        .ok_or_else(|| HwError::bad("invalid previous output index"))?;
    let mut p = protos::PrevOutput::new();
    p.set_amount(out.value.to_sat());
    p.set_script_pubkey(out.script_pubkey.to_bytes());
    let mut ack = protos::TxAckPrevOutput::new();
    let mut w = protos::tx_ack_prev_output::TxAckPrevOutputWrapper::new();
    w.output = MessageField::some(p);
    ack.tx = MessageField::some(w);
    encode(&ack)
}

fn idx(details: &protos::tx_request::TxRequestDetailsType) -> HwResult<usize> {
    details
        .request_index
        .map(|i| i as usize)
        .ok_or_else(|| HwError::bad("TxRequest without an index"))
}

/// The whole `SignTx` flow; returns the device's raw signatures (unverified).
pub fn sign_utxo(
    io: &mut dyn TrezorIo,
    ctl: &Ctl,
    coin: UtxoCoin,
    net: Network,
    psbt: &Psbt,
    plan: &UtxoHwPlan,
) -> HwResult<Vec<HwBtcSignature>> {
    let tx = &psbt.unsigned_tx;
    if plan.inputs.len() != tx.input.len() {
        return Err(HwError::unsupported(
            "transaction with inputs that do not belong to this account",
        ));
    }
    let u = Utxo {
        coin,
        net,
        psbt,
        plan,
    };
    let mut start = protos::SignTx::new();
    start.set_inputs_count(tx.input.len() as u32);
    start.set_outputs_count(tx.output.len() as u32);
    start.set_coin_name(coin_name(coin, net)?.into());
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
        let ack = match (r.request_type(), details.tx_hash.clone()) {
            (RequestType::TXFINISHED, _) => return Ok(sigs),
            (RequestType::TXINPUT, None) => u.ack_input(idx(&details)?)?,
            (RequestType::TXOUTPUT, None) => u.ack_output(idx(&details)?)?,
            (RequestType::TXMETA, Some(h)) => ack_prev_meta(u.prev_tx(&h)?)?,
            (RequestType::TXINPUT, Some(h)) => ack_prev_input(u.prev_tx(&h)?, idx(&details)?)?,
            (RequestType::TXOUTPUT, Some(h)) => ack_prev_output(u.prev_tx(&h)?, idx(&details)?)?,
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

// ---------------------------------------------------------------- Stellar

/// `StellarSignTx` + the operation message of Kyro's envelope (one XLM payment or account
/// creation, the only transactions Kyro builds and signs).
pub fn stellar_messages(
    path: &[u32],
    net: Network,
    envelope_b64: &str,
) -> HwResult<(protos::StellarSignTx, (MessageType, Vec<u8>))> {
    let env =
        StellarEnvelope::from_base64(envelope_b64).map_err(|e| HwError::bad(e.to_string()))?;
    let tx = &env.tx;
    let mut m = protos::StellarSignTx::new();
    m.address_n = path.to_vec();
    m.set_network_passphrase(wallet_core::stellar_network_passphrase(net).into());
    m.set_source_account(wallet_core::stellar_address_from_key(&tx.source));
    m.set_fee(tx.fee);
    m.set_sequence_number(
        u64::try_from(tx.sequence).map_err(|_| HwError::bad("negative sequence"))?,
    );
    let (start, end) = tx
        .time_bounds
        .ok_or_else(|| HwError::unsupported("Stellar transaction without a time bound"))?;
    let u32_of = |v: u64| {
        u32::try_from(v).map_err(|_| HwError::unsupported("time bound outside the Trezor range"))
    };
    m.set_timebounds_start(u32_of(start)?);
    m.set_timebounds_end(u32_of(end)?);
    use protos::stellar_sign_tx::StellarMemoType as T;
    match &tx.memo {
        StellarMemo::None => m.set_memo_type(T::NONE),
        StellarMemo::Text(t) => {
            m.set_memo_type(T::TEXT);
            m.set_memo_text(
                String::from_utf8(t.clone())
                    .map_err(|_| HwError::unsupported("non-UTF-8 text memo"))?,
            );
        }
        StellarMemo::Id(id) => {
            m.set_memo_type(T::ID);
            m.set_memo_id(*id);
        }
        StellarMemo::Hash(h) => {
            m.set_memo_type(T::HASH);
            m.set_memo_hash(h.to_vec());
        }
        StellarMemo::Return(h) => {
            m.set_memo_type(T::RETURN);
            m.set_memo_hash(h.to_vec());
        }
    }
    let [op] = tx.operations.as_slice() else {
        return Err(HwError::unsupported("a single Stellar operation expected"));
    };
    if op.source.is_some() {
        return Err(HwError::unsupported(
            "operation with its own source account",
        ));
    }
    m.set_num_operations(1);
    let op_msg = match &op.body {
        StellarOperation::Payment {
            destination,
            asset: wallet_core::StellarAsset::Native,
            amount,
        } => {
            let mut p = protos::StellarPaymentOp::new();
            p.set_destination_account(wallet_core::stellar_address_from_key(destination));
            let mut a = protos::StellarAsset::new();
            a.set_type(protos::StellarAssetType::NATIVE);
            p.asset = MessageField::some(a);
            p.set_amount(*amount);
            (MessageType::MessageType_StellarPaymentOp, encode(&p)?)
        }
        StellarOperation::CreateAccount {
            destination,
            starting_balance,
        } => {
            let mut c = protos::StellarCreateAccountOp::new();
            c.set_new_account(wallet_core::stellar_address_from_key(destination));
            c.set_starting_balance(*starting_balance);
            (MessageType::MessageType_StellarCreateAccountOp, encode(&c)?)
        }
        _ => {
            return Err(HwError::unsupported(
                "Kyro only signs XLM payments on Trezor",
            ))
        }
    };
    Ok((m, op_msg))
}

/// Runs `StellarSignTx` → `StellarTxOpRequest` → operation → `StellarSignedTx`; returns the
/// `(public key, signature)` the device reports (verified by the caller).
pub fn sign_stellar(
    io: &mut dyn TrezorIo,
    ctl: &Ctl,
    path: &[u32],
    net: Network,
    envelope_b64: &str,
) -> HwResult<(Vec<u8>, Vec<u8>)> {
    let (start, (op_type, op)) = stellar_messages(path, net, envelope_b64)?;
    ctl.prompt(Prompt::ConfirmOnDevice);
    let r = io.call(ctl, MessageType::MessageType_StellarSignTx, encode(&start)?)?;
    let _: protos::StellarTxOpRequest = decode(r)?;
    let r = io.call(ctl, op_type, op)?;
    let s: protos::StellarSignedTx = decode(r)?;
    Ok((s.public_key().to_vec(), s.signature().to_vec()))
}

pub fn stellar_get_address(path: &[u32], display: bool) -> protos::StellarGetAddress {
    let mut req = protos::StellarGetAddress::new();
    req.address_n = path.to_vec();
    req.set_show_display(display);
    req
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::time::Duration;
    use trezor_client::transport::ProtoMessage;

    /// Simulated firmware: answers each call with the next scripted message, records acks.
    struct Firmware {
        script: VecDeque<(MessageType, Vec<u8>)>,
        acks: Vec<(MessageType, Vec<u8>)>,
    }

    impl TrezorIo for Firmware {
        fn call(&mut self, _c: &Ctl, mt: MessageType, payload: Vec<u8>) -> HwResult<ProtoMessage> {
            self.acks.push((mt, payload));
            let (t, p) = self.script.pop_front().expect("script exhausted");
            Ok(ProtoMessage::new(t, p))
        }
    }

    fn ctl() -> Ctl {
        Ctl::for_tests(Duration::from_secs(5))
    }

    #[test]
    fn coin_names_follow_trezor_definitions() {
        assert_eq!(
            coin_name(UtxoCoin::BitcoinCash, Network::Mainnet).unwrap(),
            "Bcash"
        );
        assert_eq!(
            coin_name(UtxoCoin::Litecoin, Network::Testnet).unwrap(),
            "Litecoin Testnet"
        );
        assert!(coin_name(UtxoCoin::Dogecoin, Network::Testnet).is_err());
        let req = get_public_key(
            UtxoCoin::Litecoin,
            Network::Mainnet,
            &[0x8000_0054, 0x8000_0002, 0x8000_0000],
        )
        .unwrap();
        assert_eq!(req.script_type(), protos::InputScriptType::SPENDWITNESS);
        assert!(req.ignore_xpub_magic());
        let req = get_address(
            UtxoCoin::Dash,
            Network::Mainnet,
            &[0x8000_002c, 0x8000_0005, 0x8000_0000, 0, 0],
            true,
        )
        .unwrap();
        assert_eq!(
            (req.coin_name(), req.script_type(), req.show_display()),
            ("Dash", protos::InputScriptType::SPENDADDRESS, true)
        );
    }

    /// Trezor's `test_msg_getpublickey.py`-style answer for the abandon… seed: the xpub Kyro
    /// rebuilds from `node` equals its own account xpub for the same path.
    #[test]
    fn xpub_is_rebuilt_from_the_node() {
        let seed = wallet_core::Mnemonic::parse(
            "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
        )
        .unwrap()
        .to_seed("");
        let acc =
            wallet_core::utxo_account(&seed, Network::Mainnet, UtxoCoin::Dogecoin, 0).unwrap();
        let x: bitcoin::bip32::Xpub = acc.xpub.parse().unwrap();
        let mut node = protos::HDNodeType::new();
        node.set_depth(u32::from(x.depth));
        node.set_fingerprint(u32::from_be_bytes(x.parent_fingerprint.to_bytes()));
        node.set_child_num(u32::from(x.child_number));
        node.set_chain_code(x.chain_code.to_bytes().to_vec());
        node.set_public_key(x.public_key.serialize().to_vec());
        let mut pk = protos::PublicKey::new();
        pk.node = MessageField::some(node);
        pk.set_xpub("dgub…".into());
        pk.root_fingerprint = Some(u32::from_str_radix(&acc.fingerprint, 16).unwrap());
        let (xpub, fp) = account_xpub(&pk, Network::Mainnet).unwrap();
        assert_eq!((xpub, fp), (acc.xpub, acc.fingerprint));
        pk.root_fingerprint = None;
        assert!(account_xpub(&pk, Network::Mainnet).is_err());
    }

    #[test]
    fn stellar_flow_and_message_fields() {
        let src = [1u8; 32];
        let dest = [2u8; 32];
        let env = StellarEnvelope {
            tx: wallet_core::StellarTransaction {
                source: src,
                fee: 100,
                sequence: 77,
                time_bounds: Some((0, 1_800_000_000)),
                memo: StellarMemo::Text(b"hello".to_vec()),
                operations: vec![wallet_core::StellarOp {
                    source: None,
                    body: StellarOperation::CreateAccount {
                        destination: dest,
                        starting_balance: 20_000_000,
                    },
                }],
            },
            signatures: vec![],
        }
        .to_base64();
        let path = [44 | crate::hw::H, 148 | crate::hw::H, crate::hw::H];
        let mut signed = protos::StellarSignedTx::new();
        signed.set_public_key(src.to_vec());
        signed.set_signature(vec![9u8; 64]);
        let mut fw = Firmware {
            script: VecDeque::from(vec![
                (
                    MessageType::MessageType_StellarTxOpRequest,
                    protos::StellarTxOpRequest::new().write_to_bytes().unwrap(),
                ),
                (
                    MessageType::MessageType_StellarSignedTx,
                    signed.write_to_bytes().unwrap(),
                ),
            ]),
            acks: vec![],
        };
        let (pk, sig) = sign_stellar(&mut fw, &ctl(), &path, Network::Testnet, &env).unwrap();
        assert_eq!((pk, sig), (src.to_vec(), vec![9u8; 64]));
        let start = protos::StellarSignTx::parse_from_bytes(&fw.acks[0].1).unwrap();
        assert_eq!(
            start.network_passphrase(),
            wallet_core::STELLAR_TESTNET_PASSPHRASE
        );
        assert_eq!(
            start.source_account(),
            wallet_core::stellar_address_from_key(&src)
        );
        assert_eq!((start.fee(), start.sequence_number()), (100, 77));
        assert_eq!(
            (start.timebounds_start(), start.timebounds_end()),
            (0, 1_800_000_000)
        );
        assert_eq!(start.memo_text(), "hello");
        assert_eq!(start.num_operations(), 1);
        assert_eq!(
            fw.acks[1].0,
            MessageType::MessageType_StellarCreateAccountOp
        );
        let op = protos::StellarCreateAccountOp::parse_from_bytes(&fw.acks[1].1).unwrap();
        assert_eq!(
            op.new_account(),
            wallet_core::stellar_address_from_key(&dest)
        );
        assert_eq!(op.starting_balance(), 20_000_000);
    }

    /// A Dogecoin send against a simulated firmware: inputs with `address_n` and the verified
    /// amount, the change as `address_n`, the payment as Kyro's address, the previous
    /// transaction streamed, the signature handed back.
    #[test]
    fn utxo_flow_against_simulated_firmware() {
        use bitcoin::{absolute::LockTime, transaction::Version, Amount, OutPoint, ScriptBuf};
        use bitcoin::{Sequence, TxIn, TxOut, Witness};
        let net = Network::Mainnet;
        let coin = UtxoCoin::Dogecoin;
        let seed = wallet_core::Mnemonic::parse(
            "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
        )
        .unwrap()
        .to_seed("");
        let spk = |change: bool, i: u32| {
            let a = wallet_core::utxo_address(&seed, net, coin, 0, change, i).unwrap();
            wallet_core::utxo_script_pubkey(&a, net, coin).unwrap()
        };
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
                value: Amount::from_sat(1_000_000_000),
                script_pubkey: spk(false, 0),
            }],
        };
        let tx = Transaction {
            version: Version::ONE,
            lock_time: LockTime::ZERO,
            input: vec![TxIn {
                previous_output: OutPoint {
                    txid: prev.compute_txid(),
                    vout: 0,
                },
                script_sig: ScriptBuf::new(),
                sequence: Sequence::MAX,
                witness: Witness::new(),
            }],
            output: vec![
                TxOut {
                    value: Amount::from_sat(500_000_000),
                    script_pubkey: spk(false, 5),
                },
                TxOut {
                    value: Amount::from_sat(499_000_000),
                    script_pubkey: spk(true, 0),
                },
            ],
        };
        let mut psbt = Psbt::from_unsigned_tx(tx).unwrap();
        psbt.inputs[0].non_witness_utxo = Some(prev.clone());
        let plan = UtxoHwPlan {
            summary: wallet_core::UtxoTxSummary {
                coin,
                outputs: vec![],
                inputs: 1,
                our_inputs: 1,
                fee: "1000000".into(),
                size: 1,
                fee_per_kb: 1,
                has_change: true,
                warnings: vec![],
                requires_extra_confirmation: false,
            },
            inputs: vec![wallet_core::UtxoHwInput {
                index: 0,
                path: vec![0x8000_002c, 0x8000_0003, 0x8000_0000, 0, 0],
                pubkey: [2u8; 33],
                amount: 1_000_000_000,
                script: spk(false, 0).to_bytes(),
            }],
            change: vec![wallet_core::UtxoHwChange {
                index: 1,
                path: vec![0x8000_002c, 0x8000_0003, 0x8000_0000, 1, 0],
            }],
        };
        let h = display_bytes(&prev.compute_txid());
        let req = |t: RequestType, i: Option<u32>, hash: Option<Vec<u8>>| {
            let mut r = protos::TxRequest::new();
            r.set_request_type(t);
            let mut d = protos::tx_request::TxRequestDetailsType::new();
            d.request_index = i;
            d.tx_hash = hash;
            r.details = MessageField::some(d);
            r
        };
        let mut fin = req(RequestType::TXFINISHED, None, None);
        let mut ser = protos::tx_request::TxRequestSerializedType::new();
        ser.signature_index = Some(0);
        ser.signature = Some(vec![0x30, 1, 2]);
        fin.serialized = MessageField::some(ser);
        let steps = vec![
            req(RequestType::TXINPUT, Some(0), None),
            req(RequestType::TXOUTPUT, Some(0), None),
            req(RequestType::TXOUTPUT, Some(1), None),
            req(RequestType::TXMETA, None, Some(h.clone())),
            req(RequestType::TXINPUT, Some(0), Some(h.clone())),
            req(RequestType::TXOUTPUT, Some(0), Some(h.clone())),
            fin,
        ];
        let mut fw = Firmware {
            script: steps
                .into_iter()
                .map(|r| {
                    (
                        MessageType::MessageType_TxRequest,
                        r.write_to_bytes().unwrap(),
                    )
                })
                .collect(),
            acks: vec![],
        };
        let sigs = sign_utxo(&mut fw, &ctl(), coin, net, &psbt, &plan).unwrap();
        assert_eq!(sigs.len(), 1);
        assert_eq!(sigs[0].signature, vec![0x30, 1, 2]);
        let start = protos::SignTx::parse_from_bytes(&fw.acks[0].1).unwrap();
        assert_eq!(start.coin_name(), "Dogecoin");
        let in0 = protos::TxAckInput::parse_from_bytes(&fw.acks[1].1).unwrap();
        let in0 = in0.tx.input.as_ref().unwrap();
        assert_eq!(in0.address_n, plan.inputs[0].path);
        assert_eq!(in0.amount(), 1_000_000_000);
        assert_eq!(in0.script_type(), protos::InputScriptType::SPENDADDRESS);
        let out0 = protos::TxAckOutput::parse_from_bytes(&fw.acks[2].1).unwrap();
        let out0 = out0.tx.output.as_ref().unwrap();
        assert_eq!(
            out0.address(),
            wallet_core::utxo_address(&seed, net, coin, 0, false, 5).unwrap()
        );
        let out1 = protos::TxAckOutput::parse_from_bytes(&fw.acks[3].1).unwrap();
        let out1 = out1.tx.output.as_ref().unwrap();
        assert!(!out1.has_address());
        assert_eq!(out1.address_n, plan.change[0].path);
        let pout = protos::TxAckPrevOutput::parse_from_bytes(&fw.acks[6].1).unwrap();
        assert_eq!(pout.tx.output.amount(), 1_000_000_000);
    }
}
