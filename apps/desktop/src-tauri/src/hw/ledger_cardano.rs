//! APDUs of Ledger's "Cardano ADA" app (CLA `D7`), from the official host library
//! `@cardano-foundation/ledgerjs-hw-app-cardano` 8.1.0 (`src/interactions/v7`, `v8`; read
//! 2026-11-01) and the app's `src/*.h` wire constants it mirrors:
//!
//! | ins | what | v7 (app 7.x) | v8 (app ≥ 8) |
//! |---|---|---|---|
//! | `10` | account public key | P1 `00`, path → 32-byte key ‖ 32-byte chain code | same bytes |
//! | `11` | address | P1 `01` return / `02` show, address parameters | same bytes |
//! | `21` | sign transaction | one APDU per body item: init `01`, aux data `08`, inputs `02`, outputs `03` (P2 `30` basic, `31` asset group, `32` token, `33` confirm), fee `04`, ttl `05`, validity start `09`, confirm `0A` → body hash, witness `0F` → signature | init `10` (counts + raw length), the body items serialized in one stream, 250-byte chunks `11` / last `12` → body hash, witness `0F` |
//!
//! Only what Kyro's Cardano payments contain is encoded: inputs, outputs (ADA and native
//! tokens, legacy array or Babbage map form, no datum / reference script), fee, ttl, the
//! CIP-20 memo as an "arbitrary hash" of auxiliary data, validity start, Conway tag-258 sets.
//! Signing mode: ordinary transaction. Our change goes as the device's own base address
//! (payment `…/0/0`, stake `…/2/0`): the app derives it itself and shows it as change.
//!
//! The device rebuilds and hashes the body from these items: the hash it returns must be
//! Kyro's transaction id, and its signature must verify with the stored key
//! (`wallet_core::cardano_hw_assemble`).
//!
//! Status words (`deviceStatusError.ts`): v7 `6E09` refused, `6E10` refused by the app's
//! policy, `6E11` locked, `6E07` invalid data, `6E04` still in a previous call; v8 `6985`
//! refused, `6982` policy, `6Bxx` parsing errors.

use wallet_core::{CardanoHwDestination, CardanoHwOutput, CardanoHwPlan, Network};

use super::ledger_apdu::{apdu, encode_path};
use super::{HwError, HwResult, H};

pub const APP: &str = "Cardano ADA";
/// Conway (tag-258 sets, which Kyro's bodies use) since app 7.0.
pub const MIN_VERSION: &str = "7.0.0";

const CLA: u8 = 0xD7;
const INS_GET_EXT_PUBLIC_KEY: u8 = 0x10;
const INS_DERIVE_ADDRESS: u8 = 0x11;
const INS_SIGN_TX: u8 = 0x21;

const P1_ADDRESS_RETURN: u8 = 0x01;
const P1_ADDRESS_DISPLAY: u8 = 0x02;

/// `sign_tx_signingmode_t` ORDINARY_TRANSACTION.
const SIGNING_MODE_ORDINARY: u8 = 3;
/// `flag_included_e`.
const NO: u8 = 0x01;
const YES: u8 = 0x02;
/// Option flag: CDDL sets with tag 258.
const OPTION_TAG_CBOR_SETS: u64 = 1;
/// Address type BASE_PAYMENT_KEY_STAKE_KEY; staking choice "key path".
const ADDRESS_BASE_KEY_KEY: u8 = 0x00;
const STAKING_KEY_PATH: u8 = 0x22;
/// Output destinations.
const DEST_THIRD_PARTY: u8 = 0x01;
const DEST_DEVICE_OWNED: u8 = 0x02;
/// Auxiliary data type "arbitrary hash".
const AUX_ARBITRARY_HASH: u8 = 0x00;

// v7 stages (P1) and output sub-steps (P2).
const V7_INIT: u8 = 0x01;
const V7_AUX_DATA: u8 = 0x08;
const V7_INPUTS: u8 = 0x02;
const V7_OUTPUTS: u8 = 0x03;
const V7_FEE: u8 = 0x04;
const V7_TTL: u8 = 0x05;
const V7_VALIDITY_START: u8 = 0x09;
const V7_CONFIRM: u8 = 0x0A;
const V7_OUT_BASIC: u8 = 0x30;
const V7_OUT_ASSET_GROUP: u8 = 0x31;
const V7_OUT_TOKEN: u8 = 0x32;
const V7_OUT_CONFIRM: u8 = 0x33;
// v8 stages.
const V8_INIT: u8 = 0x10;
const V8_CHUNK: u8 = 0x11;
const V8_CONFIRM: u8 = 0x12;
const V8_CHUNK_SIZE: usize = 250;
/// Witness request (v7 and v8).
const WITNESS: u8 = 0x0F;

/// Kyro's account path `m/1852'/1815'/account'`.
pub fn account_path(account: u32) -> [u32; 3] {
    [1852 | H, 1815 | H, account | H]
}

/// Payment key `…/0/0` (the only key Kyro's payments spend from).
pub fn payment_path(account: u32) -> [u32; 5] {
    [1852 | H, 1815 | H, account | H, 0, 0]
}

/// Stake key `…/2/0`.
pub fn stake_path(account: u32) -> [u32; 5] {
    [1852 | H, 1815 | H, account | H, 2, 0]
}

fn network_id(net: Network) -> u8 {
    match net {
        Network::Mainnet => 1,
        Network::Testnet => 0,
    }
}

/// Mainnet 764824073, preprod 1.
pub fn protocol_magic(net: Network) -> u32 {
    match net {
        Network::Mainnet => 764_824_073,
        Network::Testnet => 1,
    }
}

/// The app is v8 (one-stream signing protocol) from major version 8.
pub fn is_v8(version: &str) -> bool {
    version
        .split('.')
        .next()
        .and_then(|m| m.parse::<u32>().ok())
        .is_some_and(|m| m >= 8)
}

pub fn get_ext_public_key(account: u32) -> HwResult<Vec<u8>> {
    apdu(
        CLA,
        INS_GET_EXT_PUBLIC_KEY,
        0x00,
        0x00,
        &encode_path(&account_path(account)),
    )
}

/// 32-byte public key ‖ 32-byte chain code.
pub fn parse_ext_public_key(data: &[u8]) -> HwResult<[u8; 64]> {
    data.try_into()
        .map_err(|_| HwError::bad("clé publique Cardano : 64 octets attendus"))
}

/// Base address parameters: type, network id, payment path, "staking key path", stake path.
fn base_address_params(net: Network, account: u32) -> Vec<u8> {
    let mut out = vec![ADDRESS_BASE_KEY_KEY, network_id(net)];
    out.extend(encode_path(&payment_path(account)));
    out.push(STAKING_KEY_PATH);
    out.extend(encode_path(&stake_path(account)));
    out
}

/// DERIVE ADDRESS of Kyro's base address, returned (`display` false) or shown on the device.
pub fn derive_address(net: Network, account: u32, display: bool) -> HwResult<Vec<u8>> {
    apdu(
        CLA,
        INS_DERIVE_ADDRESS,
        if display {
            P1_ADDRESS_DISPLAY
        } else {
            P1_ADDRESS_RETURN
        },
        0x00,
        &base_address_params(net, account),
    )
}

fn flag(b: bool) -> u8 {
    if b {
        YES
    } else {
        NO
    }
}

fn u16_be(n: usize, what: &str) -> HwResult<[u8; 2]> {
    u16::try_from(n)
        .map(u16::to_be_bytes)
        .map_err(|_| HwError::unsupported(format!("{what} : trop grand pour l'app Cardano")))
}

fn u32_be(n: usize, what: &str) -> HwResult<[u8; 4]> {
    u32::try_from(n)
        .map(u32::to_be_bytes)
        .map_err(|_| HwError::unsupported(format!("{what} : trop grand pour l'app Cardano")))
}

fn input_index(i: u64) -> HwResult<[u8; 4]> {
    u32::try_from(i)
        .map(u32::to_be_bytes)
        .map_err(|_| HwError::unsupported("index d'entrée au-delà de 2³²"))
}

fn options(plan: &CardanoHwPlan) -> [u8; 8] {
    (if plan.tagged_sets {
        OPTION_TAG_CBOR_SETS
    } else {
        0
    })
    .to_be_bytes()
}

fn sign(p1: u8, p2: u8, data: &[u8]) -> HwResult<Vec<u8>> {
    apdu(CLA, INS_SIGN_TX, p1, p2, data)
}

/// The APDUs of one signature, and which answer carries what.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignApdus {
    /// Sent in order; the answer of the last one is the body hash.
    pub body: Vec<Vec<u8>>,
    /// Witness request for the payment key (answer: 64-byte signature).
    pub witness: Vec<u8>,
}

fn witness(account: u32) -> HwResult<Vec<u8>> {
    sign(WITNESS, 0x00, &encode_path(&payment_path(account)))
}

// ---------------------------------------------------------------- v7

/// `serializeTxInit` for an app ≥ 7.0 (every Conway-era field present).
fn v7_init(plan: &CardanoHwPlan, net: Network) -> HwResult<Vec<u8>> {
    let mut d = options(plan).to_vec();
    d.push(network_id(net));
    d.extend(protocol_magic(net).to_be_bytes());
    d.push(flag(plan.ttl.is_some()));
    d.push(flag(plan.aux_hash.is_some()));
    d.push(flag(plan.validity_start.is_some()));
    // mint, script data hash, network id, collateral output, total collateral, treasury,
    // donation: never in a Kyro payment.
    d.extend([NO; 7]);
    d.push(SIGNING_MODE_ORDINARY);
    d.extend(u32_be(plan.inputs.len(), "entrées")?);
    d.extend(u32_be(plan.outputs.len(), "sorties")?);
    // certificates, withdrawals, collateral inputs, required signers, reference inputs,
    // voting procedures.
    d.extend([0u8; 4 * 6]);
    // One witness: the payment key.
    d.extend(1u32.to_be_bytes());
    Ok(d)
}

fn v7_output(o: &CardanoHwOutput, net: Network, account: u32) -> HwResult<Vec<Vec<u8>>> {
    let mut basic = vec![u8::from(o.map_form)];
    match &o.destination {
        CardanoHwDestination::Address(a) => {
            basic.push(DEST_THIRD_PARTY);
            basic.extend(u32_be(a.len(), "adresse")?);
            basic.extend(a);
        }
        CardanoHwDestination::Own => {
            basic.push(DEST_DEVICE_OWNED);
            basic.extend(base_address_params(net, account));
        }
    }
    basic.extend(o.coin.to_be_bytes());
    basic.extend(u32_be(o.assets.len(), "policies")?);
    basic.push(NO); // datum
    basic.push(NO); // reference script
    let mut out = vec![sign(V7_OUTPUTS, V7_OUT_BASIC, &basic)?];
    for (policy, tokens) in &o.assets {
        let mut g = policy.to_vec();
        g.extend(u32_be(tokens.len(), "tokens")?);
        out.push(sign(V7_OUTPUTS, V7_OUT_ASSET_GROUP, &g)?);
        for (name, qty) in tokens {
            let mut t = u32_be(name.len(), "nom de token")?.to_vec();
            t.extend(name);
            t.extend(qty.to_be_bytes());
            out.push(sign(V7_OUTPUTS, V7_OUT_TOKEN, &t)?);
        }
    }
    out.push(sign(V7_OUTPUTS, V7_OUT_CONFIRM, &[])?);
    Ok(out)
}

/// The v7 APDU sequence (`signTransactionV7`, ordinary transaction, Kyro's items only).
pub fn sign_apdus_v7(plan: &CardanoHwPlan, net: Network, account: u32) -> HwResult<SignApdus> {
    let mut body = vec![sign(V7_INIT, 0x00, &v7_init(plan, net)?)?];
    if let Some(h) = plan.aux_hash {
        let mut d = vec![AUX_ARBITRARY_HASH];
        d.extend(h);
        body.push(sign(V7_AUX_DATA, 0x00, &d)?);
    }
    for i in &plan.inputs {
        let mut d = i.tx_hash.to_vec();
        d.extend(input_index(i.index)?);
        body.push(sign(V7_INPUTS, 0x00, &d)?);
    }
    for o in &plan.outputs {
        body.extend(v7_output(o, net, account)?);
    }
    body.push(sign(V7_FEE, 0x00, &plan.fee.to_be_bytes())?);
    if let Some(t) = plan.ttl {
        body.push(sign(V7_TTL, 0x00, &t.to_be_bytes())?);
    }
    if let Some(v) = plan.validity_start {
        body.push(sign(V7_VALIDITY_START, 0x00, &v.to_be_bytes())?);
    }
    body.push(sign(V7_CONFIRM, 0x00, &[])?);
    Ok(SignApdus {
        body,
        witness: witness(account)?,
    })
}

// ---------------------------------------------------------------- v8

fn v8_output(o: &CardanoHwOutput, net: Network, account: u32) -> HwResult<Vec<u8>> {
    let mut d = Vec::new();
    match &o.destination {
        CardanoHwDestination::Address(a) => {
            d.push(DEST_THIRD_PARTY);
            d.extend(u16_be(a.len(), "adresse")?);
            d.extend(a);
        }
        CardanoHwDestination::Own => {
            d.push(DEST_DEVICE_OWNED);
            d.extend(base_address_params(net, account));
        }
    }
    d.extend(o.coin.to_be_bytes());
    d.push(u8::from(o.map_form));
    d.push(NO); // datum
    d.push(NO); // reference script
    d.extend(u16_be(o.assets.len(), "policies")?);
    for (policy, tokens) in &o.assets {
        d.extend(policy);
        d.extend(u16_be(tokens.len(), "tokens")?);
        for (name, qty) in tokens {
            d.push(
                u8::try_from(name.len())
                    .map_err(|_| HwError::unsupported("nom de token trop long"))?,
            );
            d.extend(name);
            d.extend(qty.to_be_bytes());
        }
    }
    Ok(d)
}

/// `serializeTransactionRaw` of Kyro's items.
pub fn v8_raw_tx(plan: &CardanoHwPlan, net: Network, account: u32) -> HwResult<Vec<u8>> {
    let mut raw = Vec::new();
    for i in &plan.inputs {
        raw.extend(i.tx_hash);
        raw.extend(input_index(i.index)?);
    }
    for o in &plan.outputs {
        let b = v8_output(o, net, account)?;
        raw.extend(u16_be(b.len(), "sortie")?);
        raw.extend(b);
    }
    raw.extend(plan.fee.to_be_bytes());
    if let Some(t) = plan.ttl {
        raw.extend(t.to_be_bytes());
    }
    if let Some(v) = plan.validity_start {
        raw.extend(v.to_be_bytes());
    }
    Ok(raw)
}

/// `serializeTxInitData`.
fn v8_init(plan: &CardanoHwPlan, net: Network, raw_len: usize) -> HwResult<Vec<u8>> {
    let mut d = options(plan).to_vec();
    d.push(network_id(net));
    d.extend(protocol_magic(net).to_be_bytes());
    d.push(SIGNING_MODE_ORDINARY);
    d.extend(u16_be(plan.inputs.len(), "entrées")?);
    d.extend(u16_be(plan.outputs.len(), "sorties")?);
    d.push(flag(plan.ttl.is_some()));
    d.extend([0, 0, 0, 0]); // certificates, withdrawals
    d.push(flag(plan.aux_hash.is_some()));
    if let Some(h) = plan.aux_hash {
        d.push(AUX_ARBITRARY_HASH);
        d.extend(h);
    }
    d.push(flag(plan.validity_start.is_some()));
    d.extend([0, 0]); // mint
    d.push(NO); // script data hash
    d.extend([0, 0, 0, 0]); // collateral inputs, required signers
    d.extend([NO, NO, NO]); // network id, collateral output, total collateral
    d.extend([0, 0, 0, 0]); // reference inputs, voters
    d.extend([NO, NO]); // treasury, donation
    d.extend(1u16.to_be_bytes()); // one witness
    d.extend(u16_be(raw_len, "transaction")?);
    Ok(d)
}

/// The v8 APDU sequence (`sendSignTx`, ordinary transaction, Kyro's items only).
pub fn sign_apdus_v8(plan: &CardanoHwPlan, net: Network, account: u32) -> HwResult<SignApdus> {
    let raw = v8_raw_tx(plan, net, account)?;
    let mut body = vec![sign(V8_INIT, 0x00, &v8_init(plan, net, raw.len())?)?];
    let chunks: Vec<&[u8]> = raw.chunks(V8_CHUNK_SIZE).collect();
    for (k, c) in chunks.iter().enumerate() {
        let last = k + 1 == chunks.len();
        body.push(sign(if last { V8_CONFIRM } else { V8_CHUNK }, 0x00, c)?);
    }
    Ok(SignApdus {
        body,
        witness: witness(account)?,
    })
}

/// Runs a signature through `call` (one APDU → its answer, status already checked):
/// returns the body hash and the payment-key signature the device produced (unverified).
pub fn sign_tx(
    call: &mut dyn FnMut(&[u8]) -> HwResult<Vec<u8>>,
    version: &str,
    plan: &CardanoHwPlan,
    net: Network,
    account: u32,
) -> HwResult<([u8; 32], [u8; 64])> {
    let apdus = if is_v8(version) {
        sign_apdus_v8(plan, net, account)?
    } else {
        sign_apdus_v7(plan, net, account)?
    };
    let mut last = Vec::new();
    for a in &apdus.body {
        last = call(a)?;
    }
    let hash: [u8; 32] = last
        .as_slice()
        .try_into()
        .map_err(|_| HwError::bad("hash du corps Cardano : 32 octets attendus"))?;
    let sig: [u8; 64] = call(&apdus.witness)?
        .as_slice()
        .try_into()
        .map_err(|_| HwError::bad("signature Cardano : 64 octets attendus"))?;
    Ok((hash, sig))
}

/// Cardano-specific status words (both protocol generations); `None` for the others.
pub fn sw_error(sw: u16) -> Option<HwError> {
    Some(match sw {
        0x6E09 | 0x6985 => HwError::Rejected,
        0x6E11 => HwError::Locked,
        0x6E10 => HwError::unsupported(
            "l'app Cardano refuse cette transaction (politique de sécurité de l'app) : mets-la à jour ou utilise le coffre Kyro",
        ),
        0x6E07 => HwError::bad("l'app Cardano juge les données invalides (6E07)"),
        0x6E04 => HwError::bad(
            "l'app Cardano était au milieu d'un autre échange : rouvre-la puis réessaie",
        ),
        0x6E12 => HwError::unsupported("type d'adresse non pris en charge par l'app Cardano"),
        sw if (0x6B00..=0x6BFF).contains(&sw) => HwError::bad(format!(
            "l'app Cardano n'a pas pu lire la transaction ({sw:04X})"
        )),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use wallet_core::CardanoInput;

    const TZ_PREV: &str = "3b40265111d8bb3c3c608d95b3a0bf83461ace32d79336579a1939b3aad1c0b7";

    fn h32(s: &str) -> [u8; 32] {
        hex::decode(s).unwrap().try_into().unwrap()
    }

    pub(crate) fn plan(outputs: Vec<CardanoHwOutput>, aux: Option<[u8; 32]>) -> CardanoHwPlan {
        CardanoHwPlan {
            inputs: vec![CardanoInput {
                tx_hash: h32(TZ_PREV),
                index: 0,
            }],
            outputs,
            fee: 42,
            ttl: Some(10),
            aux_hash: aux,
            validity_start: None,
            tagged_sets: false,
            tx_id: [0; 32],
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
        }
    }

    /// Ledger's fixture `outputs.externalShelleyBaseKeyhashKeyhash` (signTx.ts
    /// "Sign_tx_without_change_address": body hash 5268bded…).
    const EXT_ADDR: &str = "017cb05fce110fb999f01abb4f62bc455e217d4a51fde909fa9aea545443ac53c046cf6a42095e3c60310fa802771d0672f8fe2d1861138b09";

    fn ext_output() -> CardanoHwOutput {
        CardanoHwOutput {
            destination: CardanoHwDestination::Address(hex::decode(EXT_ADDR).unwrap()),
            coin: 1,
            assets: vec![],
            map_form: false,
        }
    }

    /// The body Kyro would build for that fixture is byte-identical to Ledger's recorded body,
    /// and its id is the hash the app returned.
    #[test]
    fn ledger_fixture_body_is_kyro_body() {
        let body = wallet_core::CardanoBody {
            inputs: vec![CardanoInput {
                tx_hash: h32(TZ_PREV),
                index: 0,
            }],
            tagged_sets: false,
            outputs: vec![wallet_core::CardanoOutput {
                address: hex::decode(EXT_ADDR).unwrap(),
                coin: 1,
                assets: vec![],
                map_form: false,
            }],
            fee: 42,
            ttl: Some(10),
            certs: vec![],
            withdrawals: vec![],
            aux_hash: None,
            validity_start: None,
        };
        assert_eq!(
            hex::encode(body.encode()),
            format!("a40081825820{TZ_PREV}000181825839{EXT_ADDR}0102182a030a")
        );
        assert_eq!(
            hex::encode(body.tx_id()),
            "5268bdedcdbd3e2bad037cd292b3832ff2c77c8c628c37485da2dd930f5fc32a"
        );
        // "Sign_tx_with_258_tag_on_inputs" (no outputs): the tag-258 form and its hash.
        let tagged = wallet_core::CardanoBody {
            outputs: vec![],
            tagged_sets: true,
            ..body
        };
        assert_eq!(
            hex::encode(tagged.encode()),
            format!("a400d9010281825820{TZ_PREV}00018002182a030a")
        );
        assert_eq!(
            hex::encode(tagged.tx_id()),
            "063d3a3670a43699a2648df93eedc1f93e8fda898ab79d3a795142a4ad573b7b"
        );
    }

    #[test]
    fn key_and_address_apdus() {
        assert_eq!(
            hex::encode(get_ext_public_key(0).unwrap()),
            "d71000000d038000073c8000071780000000"
        );
        // Base address, mainnet, payment 0/0, staking key path 2/0, shown.
        assert_eq!(
            hex::encode(derive_address(Network::Mainnet, 0, true).unwrap()),
            "d71102002d000105\
             8000073c80000717800000000000000000000000\
             22058000073c80000717800000000000000200000000"
        );
        assert_eq!(
            derive_address(Network::Testnet, 1, false).unwrap()[3..7],
            [0x00, 0x2d, 0x00, 0x00]
        );
        assert!(is_v8("8.0.1") && !is_v8("7.1.4") && !is_v8("garbage"));
        assert!(parse_ext_public_key(&[0; 63]).is_err());
    }

    /// v7: INIT (Conway layout), inputs, outputs with their sub-steps, fee, ttl, confirm.
    #[test]
    fn v7_sequence() {
        let token = CardanoHwOutput {
            destination: CardanoHwDestination::Own,
            coin: 2_000_000,
            assets: vec![([0x95; 28], vec![(b"te".to_vec(), 5)])],
            map_form: false,
        };
        let p = plan(vec![ext_output(), token], Some([0xAA; 32]));
        let a = sign_apdus_v7(&p, Network::Mainnet, 0).unwrap();
        let hexes: Vec<String> = a.body.iter().map(hex::encode).collect();
        assert_eq!(
            hexes[0],
            "d72101003c\
             0000000000000000\
             01 2d964a09\
             02 02 01 01010101010101\
             03\
             00000001 00000002\
             000000000000000000000000000000000000000000000000\
             00000001"
                .replace(' ', "")
        );
        assert_eq!(
            hexes[1],
            format!("d721080021 00{}", "aa".repeat(32)).replace(' ', "")
        );
        assert_eq!(hexes[2], format!("d721020024{TZ_PREV}00000000"));
        assert_eq!(
            hexes[3],
            format!("d72103304d 00 01 00000039 {EXT_ADDR} 0000000000000001 00000000 01 01")
                .replace(' ', "")
        );
        assert_eq!(hexes[4], "d721033300");
        // Own output: device-owned base address parameters, one asset group, one token.
        assert_eq!(
            hexes[5],
            "d72103303d 00 02 00 01 058000073c80000717800000000000000000000000 22 058000073c80000717800000000000000200000000 00000000001e8480 00000001 01 01"
                .replace(' ', "")
        );
        assert_eq!(hexes[6], format!("d721033120{}00000001", "95".repeat(28)));
        assert_eq!(
            hexes[7],
            "d72103320e000000027465 0000000000000005".replace(' ', "")
        );
        assert_eq!(hexes[8], "d721033300");
        assert_eq!(hexes[9], "d721040008000000000000002a");
        assert_eq!(hexes[10], "d721050008000000000000000a");
        assert_eq!(hexes[11], "d7210a0000");
        assert_eq!(hexes.len(), 12);
        assert_eq!(
            hex::encode(&a.witness),
            "d7210f0015058000073c80000717800000000000000000000000"
        );
    }

    /// v8: the INIT layout and stream of `test/unit/__fixtures__/v8/signTx.ts`
    /// (`buildInitApduHex`, `serializeTransactionRaw`, 250-byte chunks).
    #[test]
    fn v8_sequence_and_chunks() {
        let p = plan(vec![ext_output()], None);
        let raw = v8_raw_tx(&p, Network::Mainnet, 0).unwrap();
        assert_eq!(
            hex::encode(&raw),
            format!(
                "{TZ_PREV}00000000 0049 01 0039 {EXT_ADDR} 0000000000000001 00 01 01 0000 000000000000002a 000000000000000a"
            )
            .replace(' ', "")
        );
        let a = sign_apdus_v8(&p, Network::Mainnet, 0).unwrap();
        assert_eq!(
            hex::encode(&a.body[0]),
            format!(
                "d72110002d 0000000000000000 01 2d964a09 03 0001 0001 02 0000 0000 01 01 0000 01 0000 0000 01 01 01 0000 0000 01 01 0001 {:04x}",
                raw.len()
            )
            .replace(' ', "")
        );
        assert_eq!(a.body.len(), 2);
        assert_eq!(a.body[1][..5], [0xD7, 0x21, 0x12, 0x00, raw.len() as u8]);
        // A body longer than one chunk: 250-byte CHUNKs, then the CONFIRM with the rest.
        let many: Vec<CardanoHwOutput> = (0..4).map(|_| ext_output()).collect();
        let p = plan(many, Some([1; 32]));
        let raw = v8_raw_tx(&p, Network::Testnet, 0).unwrap();
        let a = sign_apdus_v8(&p, Network::Testnet, 0).unwrap();
        assert_eq!(a.body.len(), 1 + raw.len().div_ceil(250));
        assert_eq!(a.body[1][2], V8_CHUNK);
        assert_eq!(a.body[1][4], 250);
        assert_eq!(a.body.last().unwrap()[2], V8_CONFIRM);
        let stream: Vec<u8> = a.body[1..].iter().flat_map(|x| x[5..].to_vec()).collect();
        assert_eq!(stream, raw);
        // INIT carries the aux hash, preprod network id 0 and protocol magic 1.
        let init = &a.body[0][5..];
        assert_eq!(init[8], 0);
        assert_eq!(init[9..13], 1u32.to_be_bytes());
        assert_eq!(init[24..26], [AUX_ARBITRARY_HASH, 1]);
    }

    #[test]
    fn status_words() {
        assert_eq!(sw_error(0x6E09), Some(HwError::Rejected));
        assert_eq!(sw_error(0x6985), Some(HwError::Rejected));
        assert_eq!(sw_error(0x6E11), Some(HwError::Locked));
        assert!(matches!(sw_error(0x6B21), Some(HwError::BadResponse(_))));
        assert_eq!(sw_error(0x6D00), None);
    }
}
