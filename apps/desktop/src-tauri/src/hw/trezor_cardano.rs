//! Cardano on a Trezor (Model T, Safe 3 / 5; not the One): messages of Trezor's
//! `messages-cardano.proto` through `trezor-client`'s bindings, in the order of the official
//! host library (`python/src/trezorlib/cardano.py`, `sign_tx`, read 2026-11-01):
//!
//! Keys use the ICARUS derivation (CIP-3, the one of Kyro's own vault and Trezor Suite's default),
//! so a Trezor and Kyro's vault give the same Cardano account for the same mnemonic (without
//! passphrase).

use protobuf::{Message, MessageField};
use trezor_client::protos::{self, MessageType};
use trezor_client::TrezorMessage;
use wallet_core::{CardanoCert, CardanoDrep, CardanoHwDestination, CardanoHwPlan, Network};

use super::ledger_cardano::{account_path, payment_path, protocol_magic, stake_path};
use super::trezor::{decode, TrezorIo};
use super::{Ctl, HwError, HwResult, Prompt};

/// Tag-258 sets (Conway), which Kyro's bodies use.
pub const MIN_FIRMWARE: &str = "2.7.2";
/// A withdrawal alone is confirmed on the screen since this firmware (`SIMPLE_STAKE_WITHDRAW`);
/// before, or next to a certificate, it depends on a "show details" choice.
pub const MIN_FIRMWARE_WITHDRAWAL: &str = "2.8.5";

fn network_id(net: Network) -> u32 {
    match net {
        Network::Mainnet => 1,
        Network::Testnet => 0,
    }
}

fn icarus() -> protobuf::EnumOrUnknown<protos::CardanoDerivationType> {
    protos::CardanoDerivationType::ICARUS.into()
}

fn call<M: TrezorMessage, R: TrezorMessage>(
    io: &mut dyn TrezorIo,
    ctl: &Ctl,
    m: &M,
) -> HwResult<R> {
    let bytes = m
        .write_to_bytes()
        .map_err(|e| HwError::bad(format!("protobuf encoding: {e}")))?;
    decode(io.call(ctl, M::MESSAGE_TYPE, bytes)?)
}

pub fn get_public_key(account: u32) -> protos::CardanoGetPublicKey {
    let mut m = protos::CardanoGetPublicKey::new();
    m.address_n = account_path(account).to_vec();
    m.set_show_display(false);
    m.derivation_type = Some(icarus());
    m
}

/// Account public key (public key ‖ chain code, 64 bytes), from the `node` (the `xpub` hex
/// string must say the same).
pub fn read_account_key(io: &mut dyn TrezorIo, ctl: &Ctl, account: u32) -> HwResult<[u8; 64]> {
    let pk: protos::CardanoPublicKey = call(io, ctl, &get_public_key(account))?;
    let node = pk
        .node
        .as_ref()
        .ok_or_else(|| HwError::bad("missing node"))?;
    let mut out = [0u8; 64];
    let key = node.public_key();
    if key.len() != 32 || node.chain_code().len() != 32 {
        return Err(HwError::bad("malformed Cardano public key"));
    }
    out[..32].copy_from_slice(key);
    out[32..].copy_from_slice(node.chain_code());
    if pk.xpub.as_deref().is_some_and(|x| x != hex::encode(out)) {
        return Err(HwError::bad("Cardano xpub and node differ"));
    }
    Ok(out)
}

fn base_params(account: u32) -> protos::CardanoAddressParametersType {
    let mut p = protos::CardanoAddressParametersType::new();
    p.set_address_type(protos::CardanoAddressType::BASE);
    p.address_n = payment_path(account).to_vec();
    p.address_n_staking = stake_path(account).to_vec();
    p
}

pub fn get_address(net: Network, account: u32, display: bool) -> protos::CardanoGetAddress {
    let mut m = protos::CardanoGetAddress::new();
    m.set_show_display(display);
    m.set_protocol_magic(protocol_magic(net));
    m.set_network_id(network_id(net));
    m.address_parameters = MessageField::some(base_params(account));
    m.derivation_type = Some(icarus());
    m
}

/// Kyro's base address as the firmware derives it (shown on the screen when `display`).
pub fn address(
    io: &mut dyn TrezorIo,
    ctl: &Ctl,
    net: Network,
    account: u32,
    display: bool,
) -> HwResult<String> {
    if display {
        ctl.prompt(Prompt::ConfirmOnDevice);
    }
    let a: protos::CardanoAddress = call(io, ctl, &get_address(net, account, display))?;
    a.address
        .ok_or_else(|| HwError::bad("missing Cardano address"))
}

struct Item(MessageType, Vec<u8>);

fn item<M: TrezorMessage>(m: &M) -> HwResult<Item> {
    Ok(Item(
        M::MESSAGE_TYPE,
        m.write_to_bytes()
            .map_err(|e| HwError::bad(format!("protobuf encoding: {e}")))?,
    ))
}

/// `CardanoSignTxInit` of Kyro's transaction (witnesses: the payment key, and the stake key of a
/// staking transaction).
pub fn sign_init(plan: &CardanoHwPlan, net: Network) -> HwResult<protos::CardanoSignTxInit> {
    let n = |x: usize| u32::try_from(x).map_err(|_| HwError::unsupported("too many items"));
    let mut m = protos::CardanoSignTxInit::new();
    m.set_signing_mode(protos::CardanoTxSigningMode::ORDINARY_TRANSACTION);
    m.set_protocol_magic(protocol_magic(net));
    m.set_network_id(network_id(net));
    m.set_inputs_count(n(plan.inputs.len())?);
    m.set_outputs_count(n(plan.outputs.len())?);
    m.set_fee(plan.fee);
    if let Some(t) = plan.ttl {
        m.set_ttl(t);
    }
    if let Some(v) = plan.validity_start {
        m.set_validity_interval_start(v);
    }
    m.set_certificates_count(n(plan.staking.certs.len())?);
    m.set_withdrawals_count(n(plan.staking.withdrawals.len())?);
    m.set_has_auxiliary_data(plan.aux_hash.is_some());
    m.set_witness_requests_count(if plan.staking.is_empty() { 1 } else { 2 });
    m.set_minting_asset_groups_count(0);
    m.derivation_type = Some(icarus());
    m.set_include_network_id(false);
    m.set_collateral_inputs_count(0);
    m.set_required_signers_count(0);
    m.set_has_collateral_return(false);
    m.set_reference_inputs_count(0);
    m.set_tag_cbor_sets(plan.tagged_sets);
    Ok(m)
}

fn body_items(plan: &CardanoHwPlan, net: Network, account: u32) -> HwResult<Vec<Item>> {
    let n = |x: usize| u32::try_from(x).map_err(|_| HwError::unsupported("too many items"));
    let mut out = Vec::new();
    for i in &plan.inputs {
        let mut m = protos::CardanoTxInput::new();
        m.set_prev_hash(i.tx_hash.to_vec());
        m.set_prev_index(u32::try_from(i.index).map_err(|_| HwError::unsupported("input index"))?);
        out.push(item(&m)?);
    }
    for o in &plan.outputs {
        let mut m = protos::CardanoTxOutput::new();
        match &o.destination {
            CardanoHwDestination::Own => {
                m.address_parameters = MessageField::some(base_params(account))
            }
            CardanoHwDestination::Address(a) => m.set_address(
                wallet_core::cardano_address_string(a, net)
                    .ok_or_else(|| HwError::unsupported("unsupported output address"))?,
            ),
        }
        m.set_amount(o.coin);
        m.set_asset_groups_count(n(o.assets.len())?);
        m.set_format(if o.map_form {
            protos::CardanoTxOutputSerializationFormat::MAP_BABBAGE
        } else {
            protos::CardanoTxOutputSerializationFormat::ARRAY_LEGACY
        });
        out.push(item(&m)?);
        for (policy, tokens) in &o.assets {
            let mut g = protos::CardanoAssetGroup::new();
            g.set_policy_id(policy.to_vec());
            g.set_tokens_count(n(tokens.len())?);
            out.push(item(&g)?);
            for (name, qty) in tokens {
                let mut t = protos::CardanoToken::new();
                t.set_asset_name_bytes(name.clone());
                t.set_amount(*qty);
                out.push(item(&t)?);
            }
        }
    }
    for c in &plan.staking.certs {
        out.push(item(&certificate(c, account))?);
    }
    for amount in &plan.staking.withdrawals {
        let mut w = protos::CardanoTxWithdrawal::new();
        w.path = stake_path(account).to_vec();
        w.set_amount(*amount);
        out.push(item(&w)?);
    }
    Ok(out)
}

/// `CardanoTxCertificate` as `trezorlib.cardano.parse_certificate` writes it.
fn certificate(c: &CardanoCert, account: u32) -> protos::CardanoTxCertificate {
    use protos::CardanoCertificateType as T;
    let mut m = protos::CardanoTxCertificate::new();
    m.path = stake_path(account).to_vec();
    match c {
        CardanoCert::StakeRegistration { deposit, .. } => {
            m.set_type(T::STAKE_REGISTRATION_CONWAY);
            m.set_deposit(*deposit);
        }
        CardanoCert::StakeDeregistration { refund, .. } => {
            m.set_type(T::STAKE_DEREGISTRATION_CONWAY);
            m.set_deposit(*refund);
        }
        CardanoCert::StakeDelegation { pool, .. } => {
            m.set_type(T::STAKE_DELEGATION);
            m.set_pool(pool.to_vec());
        }
        CardanoCert::VoteDelegation { drep, .. } => {
            use protos::CardanoDRepType as D;
            m.set_type(T::VOTE_DELEGATION);
            let mut d = protos::CardanoDRep::new();
            match drep {
                CardanoDrep::Key(h) => {
                    d.set_type(D::KEY_HASH);
                    d.set_key_hash(h.to_vec());
                }
                CardanoDrep::Script(h) => {
                    d.set_type(D::SCRIPT_HASH);
                    d.set_script_hash(h.to_vec());
                }
                CardanoDrep::AlwaysAbstain => d.set_type(D::ABSTAIN),
                CardanoDrep::AlwaysNoConfidence => d.set_type(D::NO_CONFIDENCE),
            }
            m.drep = MessageField::some(d);
        }
    }
    m
}

fn host_ack() -> HwResult<Vec<u8>> {
    protos::CardanoTxHostAck::new()
        .write_to_bytes()
        .map_err(|e| HwError::bad(format!("protobuf encoding: {e}")))
}

/// Signature and public key of a device witness.
pub type Witness = ([u8; 64], [u8; 32]);

/// The whole flow; returns the firmware's body hash and payment-key signature (unverified,
/// except that the witness is a Shelley one for the payment key path it was asked for).
pub fn sign_tx(
    io: &mut dyn TrezorIo,
    ctl: &Ctl,
    plan: &CardanoHwPlan,
    net: Network,
    account: u32,
) -> HwResult<([u8; 32], [u8; 64], [u8; 32])> {
    let (hash, witnesses) = sign_all(io, ctl, plan, net, account)?;
    let (sig, pk) = witnesses[0];
    Ok((hash, sig, pk))
}

/// Same, with every witness in request order: `(signature, key)` of the payment key, then of
/// the stake key in a staking transaction (unverified).
pub fn sign_all(
    io: &mut dyn TrezorIo,
    ctl: &Ctl,
    plan: &CardanoHwPlan,
    net: Network,
    account: u32,
) -> HwResult<([u8; 32], Vec<Witness>)> {
    ctl.prompt(Prompt::ConfirmOnDevice);
    let _: protos::CardanoTxItemAck = call(io, ctl, &sign_init(plan, net)?)?;
    for Item(mt, bytes) in body_items(plan, net, account)? {
        let _: protos::CardanoTxItemAck = decode(io.call(ctl, mt, bytes)?)?;
    }
    if let Some(h) = plan.aux_hash {
        let mut a = protos::CardanoTxAuxiliaryData::new();
        a.set_hash(h.to_vec());
        let s: protos::CardanoTxAuxiliaryDataSupplement = call(io, ctl, &a)?;
        if s.type_() != protos::CardanoTxAuxiliaryDataSupplementType::NONE {
            return Err(HwError::bad("unexpected metadata supplement"));
        }
        let _: protos::CardanoTxItemAck =
            decode(io.call(ctl, MessageType::MessageType_CardanoTxHostAck, host_ack()?)?)?;
    }
    let mut paths = vec![payment_path(account).to_vec()];
    if !plan.staking.is_empty() {
        paths.push(stake_path(account).to_vec());
    }
    let mut witnesses = Vec::with_capacity(paths.len());
    for path in paths {
        let mut w = protos::CardanoTxWitnessRequest::new();
        w.path = path;
        let r: protos::CardanoTxWitnessResponse = call(io, ctl, &w)?;
        if r.type_() != protos::CardanoTxWitnessType::SHELLEY_WITNESS {
            return Err(HwError::bad("Cardano witness of an unexpected type"));
        }
        let pk: [u8; 32] = r
            .pub_key()
            .try_into()
            .map_err(|_| HwError::bad("witness key: 32 bytes expected"))?;
        let sig: [u8; 64] = r
            .signature()
            .try_into()
            .map_err(|_| HwError::bad("Cardano signature: 64 bytes expected"))?;
        witnesses.push((sig, pk));
    }
    let h: protos::CardanoTxBodyHash =
        decode(io.call(ctl, MessageType::MessageType_CardanoTxHostAck, host_ack()?)?)?;
    let hash: [u8; 32] = h
        .tx_hash()
        .try_into()
        .map_err(|_| HwError::bad("Cardano body hash: 32 bytes expected"))?;
    let _: protos::CardanoSignTxFinished =
        decode(io.call(ctl, MessageType::MessageType_CardanoTxHostAck, host_ack()?)?)?;
    Ok((hash, witnesses))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::time::Duration;
    use trezor_client::transport::ProtoMessage;
    use wallet_core::{CardanoHwOutput, CardanoInput};

    struct Firmware {
        script: VecDeque<(MessageType, Vec<u8>)>,
        sent: Vec<(MessageType, Vec<u8>)>,
    }

    impl TrezorIo for Firmware {
        fn call(&mut self, _c: &Ctl, mt: MessageType, payload: Vec<u8>) -> HwResult<ProtoMessage> {
            self.sent.push((mt, payload));
            let (t, p) = self.script.pop_front().expect("script exhausted");
            Ok(ProtoMessage::new(t, p))
        }
    }

    fn msg<M: TrezorMessage>(m: &M) -> (MessageType, Vec<u8>) {
        (M::MESSAGE_TYPE, m.write_to_bytes().unwrap())
    }

    fn ctl() -> Ctl {
        Ctl::for_tests(Duration::from_secs(5))
    }

    #[test]
    fn staking_flow_against_simulated_firmware() {
        let stake = [0x77; 28];
        let plan = CardanoHwPlan {
            inputs: vec![CardanoInput {
                tx_hash: [0x3b; 32],
                index: 1,
            }],
            outputs: vec![CardanoHwOutput {
                destination: CardanoHwDestination::Own,
                coin: 7_120_787,
                assets: vec![],
                map_form: false,
            }],
            fee: 42,
            ttl: Some(10),
            aux_hash: None,
            validity_start: None,
            tagged_sets: true,
            staking: wallet_core::CardanoHwStaking {
                certs: vec![
                    CardanoCert::StakeRegistration {
                        stake,
                        deposit: 2_000_000,
                    },
                    CardanoCert::StakeDelegation {
                        stake,
                        pool: [0x88; 28],
                    },
                    CardanoCert::VoteDelegation {
                        stake,
                        drep: CardanoDrep::AlwaysAbstain,
                    },
                ],
                withdrawals: vec![],
            },
            tx_id: [7; 32],
            summary: wallet_core::CardanoTxSummary {
                tx_id: String::new(),
                inputs: vec![],
                outputs: vec![],
                fee: "42".into(),
                ttl: Some(10),
                valid_from: None,
                memo: None,
                warnings: vec![],
                requires_extra_confirmation: false,
            },
        };
        let ack = || msg(&protos::CardanoTxItemAck::new());
        let wit = |k: u8| {
            let mut w = protos::CardanoTxWitnessResponse::new();
            w.set_type(protos::CardanoTxWitnessType::SHELLEY_WITNESS);
            w.set_pub_key(vec![k; 32]);
            w.set_signature(vec![k + 1; 64]);
            msg(&w)
        };
        let mut hash = protos::CardanoTxBodyHash::new();
        hash.set_tx_hash(vec![7; 32]);
        let mut fw = Firmware {
            script: VecDeque::from(vec![
                ack(), // init
                ack(), // input
                ack(), // output
                ack(), // registration
                ack(), // delegation
                ack(), // vote delegation
                wit(5),
                wit(9),
                msg(&hash),
                msg(&protos::CardanoSignTxFinished::new()),
            ]),
            sent: Vec::new(),
        };
        let (h, w) = sign_all(&mut fw, &ctl(), &plan, Network::Mainnet, 0).unwrap();
        assert_eq!(h, [7; 32]);
        assert_eq!(w, vec![([6; 64], [5; 32]), ([10; 64], [9; 32])]);
        let init = protos::CardanoSignTxInit::parse_from_bytes(&fw.sent[0].1).unwrap();
        assert_eq!(init.certificates_count(), 3);
        assert_eq!(init.withdrawals_count(), 0);
        assert_eq!(init.witness_requests_count(), 2);
        let cert = |i: usize| {
            assert_eq!(fw.sent[i].0, MessageType::MessageType_CardanoTxCertificate);
            protos::CardanoTxCertificate::parse_from_bytes(&fw.sent[i].1).unwrap()
        };
        use protos::CardanoCertificateType as T;
        let (reg, del, vote) = (cert(3), cert(4), cert(5));
        assert_eq!(reg.type_(), T::STAKE_REGISTRATION_CONWAY);
        assert_eq!(reg.deposit(), 2_000_000);
        assert_eq!(reg.path, stake_path(0).to_vec());
        assert_eq!(del.type_(), T::STAKE_DELEGATION);
        assert_eq!(del.pool(), [0x88; 28]);
        assert_eq!(vote.type_(), T::VOTE_DELEGATION);
        assert_eq!(vote.drep.type_(), protos::CardanoDRepType::ABSTAIN);
        let path = |i: usize| {
            protos::CardanoTxWitnessRequest::parse_from_bytes(&fw.sent[i].1)
                .unwrap()
                .path
        };
        assert_eq!(path(6), payment_path(0).to_vec());
        assert_eq!(path(7), stake_path(0).to_vec());
    }

    #[test]
    fn sign_flow_against_simulated_firmware() {
        let dest = "addr1q84sh2j72ux0l03fxndjnhctdg7hcppsaejafsa84vh7lwgmcs5wgus8qt4atk45lvt4xfxpjtwfhdmvchdf2m3u3hlsd5tq5r";
        let plan = CardanoHwPlan {
            inputs: vec![CardanoInput {
                tx_hash: [0x3b; 32],
                index: 1,
            }],
            outputs: vec![
                CardanoHwOutput {
                    destination: CardanoHwDestination::Address(
                        wallet_core::cardano_address_bytes(dest, Network::Mainnet).unwrap(),
                    ),
                    coin: 1,
                    assets: vec![],
                    map_form: false,
                },
                CardanoHwOutput {
                    destination: CardanoHwDestination::Own,
                    coin: 7_120_787,
                    assets: vec![([0x95; 28], vec![(b"te".to_vec(), 5)])],
                    map_form: true,
                },
            ],
            fee: 42,
            ttl: Some(10),
            aux_hash: Some([0xAA; 32]),
            validity_start: None,
            tagged_sets: true,
            staking: Default::default(),
            tx_id: [7; 32],
            summary: wallet_core::CardanoTxSummary {
                tx_id: String::new(),
                inputs: vec![],
                outputs: vec![],
                fee: "42".into(),
                ttl: Some(10),
                valid_from: None,
                memo: None,
                warnings: vec![],
                requires_extra_confirmation: false,
            },
        };
        let ack = || msg(&protos::CardanoTxItemAck::new());
        let mut supp = protos::CardanoTxAuxiliaryDataSupplement::new();
        supp.set_type(protos::CardanoTxAuxiliaryDataSupplementType::NONE);
        let mut wit = protos::CardanoTxWitnessResponse::new();
        wit.set_type(protos::CardanoTxWitnessType::SHELLEY_WITNESS);
        wit.set_pub_key(vec![5; 32]);
        wit.set_signature(vec![6; 64]);
        let mut hash = protos::CardanoTxBodyHash::new();
        hash.set_tx_hash(vec![7; 32]);
        let mut fw = Firmware {
            script: VecDeque::from(vec![
                ack(), // init
                ack(), // input
                ack(), // output 1
                ack(), // output 2
                ack(), // asset group
                ack(), // token
                msg(&supp),
                ack(), // host ack after aux data
                msg(&wit),
                msg(&hash),
                msg(&protos::CardanoSignTxFinished::new()),
            ]),
            sent: vec![],
        };
        let (h, sig, pk) = sign_tx(&mut fw, &ctl(), &plan, Network::Mainnet, 0).unwrap();
        assert_eq!((h, sig, pk), ([7; 32], [6; 64], [5; 32]));
        let types: Vec<MessageType> = fw.sent.iter().map(|(t, _)| *t).collect();
        use MessageType as T;
        assert_eq!(
            types,
            vec![
                T::MessageType_CardanoSignTxInit,
                T::MessageType_CardanoTxInput,
                T::MessageType_CardanoTxOutput,
                T::MessageType_CardanoTxOutput,
                T::MessageType_CardanoAssetGroup,
                T::MessageType_CardanoToken,
                T::MessageType_CardanoTxAuxiliaryData,
                T::MessageType_CardanoTxHostAck,
                T::MessageType_CardanoTxWitnessRequest,
                T::MessageType_CardanoTxHostAck,
                T::MessageType_CardanoTxHostAck,
            ]
        );
        let init = protos::CardanoSignTxInit::parse_from_bytes(&fw.sent[0].1).unwrap();
        assert_eq!(init.protocol_magic(), 764_824_073);
        assert_eq!(init.network_id(), 1);
        assert_eq!((init.inputs_count(), init.outputs_count()), (1, 2));
        assert_eq!((init.fee(), init.ttl()), (42, 10));
        assert!(init.has_auxiliary_data() && init.tag_cbor_sets());
        assert_eq!(init.witness_requests_count(), 1);
        assert!(!init.has_validity_interval_start());
        assert_eq!(
            init.derivation_type(),
            protos::CardanoDerivationType::ICARUS
        );
        let o1 = protos::CardanoTxOutput::parse_from_bytes(&fw.sent[2].1).unwrap();
        assert_eq!(o1.address(), dest);
        assert_eq!(
            o1.format(),
            protos::CardanoTxOutputSerializationFormat::ARRAY_LEGACY
        );
        let o2 = protos::CardanoTxOutput::parse_from_bytes(&fw.sent[3].1).unwrap();
        assert!(!o2.has_address());
        let p = o2.address_parameters.as_ref().unwrap();
        assert_eq!(p.address_n, payment_path(0).to_vec());
        assert_eq!(p.address_n_staking, stake_path(0).to_vec());
        assert_eq!((o2.amount(), o2.asset_groups_count()), (7_120_787, 1));
        assert_eq!(
            o2.format(),
            protos::CardanoTxOutputSerializationFormat::MAP_BABBAGE
        );
        let t = protos::CardanoToken::parse_from_bytes(&fw.sent[5].1).unwrap();
        assert_eq!((t.asset_name_bytes(), t.amount()), (&b"te"[..], 5));
        let a = protos::CardanoTxAuxiliaryData::parse_from_bytes(&fw.sent[6].1).unwrap();
        assert_eq!(a.hash(), &[0xAA; 32]);
        let w = protos::CardanoTxWitnessRequest::parse_from_bytes(&fw.sent[8].1).unwrap();
        assert_eq!(w.path, payment_path(0).to_vec());

        let mut byron = wit.clone();
        byron.set_type(protos::CardanoTxWitnessType::BYRON_WITNESS);
        let mut plain = plan.clone();
        plain.aux_hash = None;
        plain.outputs.truncate(1);
        let mut fw = Firmware {
            script: VecDeque::from(vec![ack(), ack(), ack(), msg(&byron)]),
            sent: vec![],
        };
        assert!(sign_tx(&mut fw, &ctl(), &plain, Network::Mainnet, 0).is_err());
    }

    #[test]
    fn key_and_address_messages() {
        let m = get_public_key(2);
        assert_eq!(m.address_n, account_path(2).to_vec());
        assert_eq!(m.derivation_type(), protos::CardanoDerivationType::ICARUS);
        let a = get_address(Network::Testnet, 0, true);
        assert_eq!((a.protocol_magic(), a.network_id()), (1, 0));
        assert!(a.show_display());
        // The account key is rebuilt from the node and must agree with the xpub string.
        let mut node = protos::HDNodeType::new();
        node.set_depth(3);
        node.set_fingerprint(0);
        node.set_child_num(0x8000_0000);
        node.set_public_key(vec![1; 32]);
        node.set_chain_code(vec![2; 32]);
        let mut pk = protos::CardanoPublicKey::new();
        pk.node = MessageField::some(node);
        pk.set_xpub(format!("{}{}", "01".repeat(32), "02".repeat(32)));
        let mut fw = Firmware {
            script: VecDeque::from(vec![msg(&pk)]),
            sent: vec![],
        };
        assert_eq!(read_account_key(&mut fw, &ctl(), 0).unwrap()[..2], [1, 1]);
        pk.set_xpub("00".repeat(64));
        let mut fw = Firmware {
            script: VecDeque::from(vec![msg(&pk)]),
            sent: vec![],
        };
        assert!(read_account_key(&mut fw, &ctl(), 0).is_err());
    }
}
