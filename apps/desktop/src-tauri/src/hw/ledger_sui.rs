//! Ledger « Sui » app (LedgerHQ/app-sui, host library `@mysten/ledgerjs-hw-app-sui`).

use std::collections::HashMap;

use sha2::{Digest, Sha256};

use super::ledger_apdu::{self as apdu, SwContext};
use super::ledger_apps::App;
use super::{HwError, HwResult};

const CLA: u8 = 0x00;
const INS_VERIFY_ADDRESS: u8 = 0x01;
const INS_GET_PUBKEY: u8 = 0x02;
const INS_SIGN_TX: u8 = 0x03;
const CHUNK: usize = 180;

// Device → host.
const RESULT_ACCUMULATING: u8 = 0;
const RESULT_FINAL: u8 = 1;
const GET_CHUNK: u8 = 2;
const PUT_CHUNK: u8 = 3;
// Host → device.
const START: u8 = 0;
const GET_CHUNK_OK: u8 = 1;
const GET_CHUNK_FAIL: u8 = 2;
const PUT_CHUNK_OK: u8 = 3;
const RESULT_ACK: u8 = 4;

const MAX_ROUNDS: usize = 4096;

pub fn path_payload(path: &[u32]) -> Vec<u8> {
    let mut out = vec![path.len() as u8];
    for p in path {
        out.extend_from_slice(&p.to_le_bytes());
    }
    out
}

/// `START || hash of each parameter's first block`, and the blocks by hash.
pub fn blocks(params: &[Vec<u8>]) -> (Vec<u8>, HashMap<[u8; 32], Vec<u8>>) {
    let mut start = vec![START];
    let mut store = HashMap::new();
    for p in params {
        let mut next = [0u8; 32];
        for chunk in p.chunks(CHUNK).rev() {
            let mut block = next.to_vec();
            block.extend_from_slice(chunk);
            next = Sha256::digest(&block).into();
            store.insert(next, block);
        }
        start.extend_from_slice(&next);
    }
    (start, store)
}

/// Runs one command of the block protocol, returns the device's result.
pub fn run(app: &App<'_>, ins: u8, params: &[Vec<u8>], ctx: SwContext) -> HwResult<Vec<u8>> {
    let (mut payload, mut store) = blocks(params);
    let mut result = Vec::new();
    for _ in 0..MAX_ROUNDS {
        let resp = app.call(&apdu::apdu(CLA, ins, 0, 0, &payload)?, ctx)?;
        let (&kind, rest) = resp
            .split_first()
            .ok_or_else(|| HwError::bad("empty Sui response"))?;
        payload = match kind {
            RESULT_ACCUMULATING | RESULT_FINAL => {
                result.extend_from_slice(rest);
                if kind == RESULT_FINAL {
                    return Ok(result);
                }
                vec![RESULT_ACK]
            }
            GET_CHUNK => {
                let key: [u8; 32] = rest
                    .try_into()
                    .map_err(|_| HwError::bad("malformed Sui block request"))?;
                match store.get(&key) {
                    Some(b) => [&[GET_CHUNK_OK][..], b].concat(),
                    None => vec![GET_CHUNK_FAIL],
                }
            }
            PUT_CHUNK => {
                store.insert(Sha256::digest(rest).into(), rest.to_vec());
                vec![PUT_CHUNK_OK]
            }
            _ => return Err(HwError::bad("unknown instruction from the Sui app")),
        };
    }
    Err(HwError::bad("Sui app: conversation too long"))
}

pub fn parse_pubkey(data: &[u8]) -> HwResult<Vec<u8>> {
    let bad = || HwError::bad("malformed Sui public key");
    let (&n, rest) = data.split_first().ok_or_else(bad)?;
    if n != 32 || rest.len() < 32 {
        return Err(bad());
    }
    let pk: [u8; 32] = rest[..32].try_into().map_err(|_| bad())?;
    let tail = &rest[32..];
    if !tail.is_empty() {
        let (&m, addr) = tail.split_first().ok_or_else(bad)?;
        if m != 32 || addr.len() != 32 || addr != wallet_core::sui_address_bytes_of_pubkey(&pk) {
            return Err(HwError::bad(
                "Sui address from the device does not match its key",
            ));
        }
    }
    Ok(pk.to_vec())
}

pub fn pubkey(app: &App<'_>, path: &[u32], display: bool) -> HwResult<Vec<u8>> {
    let (ins, ctx) = if display {
        (INS_VERIFY_ADDRESS, SwContext::Signing)
    } else {
        (INS_GET_PUBKEY, SwContext::General)
    };
    parse_pubkey(&run(app, ins, &[path_payload(path)], ctx)?)
}

/// Transaction, path and, for a token transfer, the objects the app reads the coin type and
/// amounts from (it only trusts an object whose digest is the one in the transaction): count,
/// then each length-prefixed, all little-endian (`SuiLedgerClient`, `WithObjectData` in the app).
pub fn sign_params(path: &[u32], intent_message: &[u8], objects: &[Vec<u8>]) -> Vec<Vec<u8>> {
    let mut tx = (intent_message.len() as u32).to_le_bytes().to_vec();
    tx.extend_from_slice(intent_message);
    let mut params = vec![tx, path_payload(path)];
    if !objects.is_empty() {
        let mut list = (objects.len() as u32).to_le_bytes().to_vec();
        for o in objects {
            list.extend_from_slice(&(o.len() as u32).to_le_bytes());
            list.extend_from_slice(o);
        }
        params.push(list);
    }
    params
}

pub fn sign(
    app: &App<'_>,
    path: &[u32],
    intent_message: &[u8],
    objects: &[Vec<u8>],
) -> HwResult<Vec<u8>> {
    let sig = run(
        app,
        INS_SIGN_TX,
        &sign_params(path, intent_message, objects),
        SwContext::SuiSigning,
    )?;
    if sig.len() != 64 {
        return Err(HwError::bad("Sui signature of unexpected length"));
    }
    Ok(sig)
}

#[cfg(test)]
mod tests {
    use super::super::ledger_apps::replay::*;
    use super::*;
    use wallet_core::HwKeyChain;

    #[test]
    fn path_is_little_endian() {
        assert_eq!(
            hex::encode(path_payload(&HwKeyChain::Sui.path(0))),
            "052c00008010030080000000800000008000000080"
        );
    }

    #[test]
    fn blocks_chain_by_sha256() {
        let p: Vec<u8> = (0..200u8).collect();
        let (start, store) = blocks(&[p.clone(), vec![9]]);
        assert_eq!(start.len(), 1 + 64);
        let first: [u8; 32] = start[1..33].try_into().unwrap();
        let b1 = &store[&first];
        assert_eq!(&b1[32..], &p[..180]);
        let second: [u8; 32] = b1[..32].try_into().unwrap();
        let b2 = &store[&second];
        assert_eq!(&b2[..32], &[0u8; 32]);
        assert_eq!(&b2[32..], &p[180..]);
        assert_eq!(<[u8; 32]>::from(Sha256::digest(b2)), second);
        let last: [u8; 32] = start[33..].try_into().unwrap();
        assert_eq!(store[&last], [[0u8; 32].as_slice(), &[9]].concat());
    }

    fn exchange(lines: &mut Vec<String>, sent: &[u8], got: &[u8]) {
        lines.push(format!("=> {}", hex::encode(sent)));
        lines.push(format!("<= {}9000", hex::encode(got)));
    }

    fn cmd(ins: u8, data: &[u8]) -> Vec<u8> {
        apdu::apdu(CLA, ins, 0, 0, data).unwrap()
    }

    #[test]
    fn get_public_key_through_block_protocol() {
        let pk = hex::decode("c4f5941e81e071c2fd1dae2e71fd3d859d462484391d9a90bf219211dcbb320f")
            .unwrap();
        let pk32: [u8; 32] = pk.clone().try_into().unwrap();
        let addr = wallet_core::sui_address_bytes_of_pubkey(&pk32);
        let path = HwKeyChain::Sui.path(0);
        let (start, store) = blocks(&[path_payload(&path)]);
        let first: [u8; 32] = start[1..].try_into().unwrap();
        let mut lines = app("Sui", "1.6.0").to_vec();
        exchange(
            &mut lines,
            &cmd(INS_GET_PUBKEY, &start),
            &[&[GET_CHUNK][..], &first].concat(),
        );
        exchange(
            &mut lines,
            &cmd(
                INS_GET_PUBKEY,
                &[&[GET_CHUNK_OK][..], &store[&first]].concat(),
            ),
            &[&[RESULT_FINAL, 32][..], &pk, &[32], &addr].concat(),
        );
        let r = Replay::new(&lines);
        let c = ctl();
        let a = App::open(&r, &c, HwKeyChain::Sui).unwrap();
        assert_eq!(pubkey(&a, &path, false).unwrap(), pk);
        assert!(r.done());
        let mut bad = [&[32u8][..], &pk, &[32], &addr].concat();
        bad[40] ^= 1;
        assert!(parse_pubkey(&bad).is_err());
        assert!(parse_pubkey(&[&[32u8][..], &pk].concat()).is_ok());
    }

    #[test]
    fn sign_streams_result_and_handles_put_chunk_and_unknown_blocks() {
        let msg = [&[0u8, 0, 0][..], &[7u8; 300]].concat();
        let path = HwKeyChain::Sui.path(1);
        let params = sign_params(&path, &msg, &[]);
        assert_eq!(params.len(), 2);
        assert_eq!(&params[0][..4], &(303u32).to_le_bytes());
        let (start, store) = blocks(&params);
        let first: [u8; 32] = start[1..33].try_into().unwrap();
        let sig = [5u8; 64];
        let mut lines = app("Sui", "1.6.0").to_vec();
        exchange(
            &mut lines,
            &cmd(INS_SIGN_TX, &start),
            &[&[GET_CHUNK][..], &first].concat(),
        );
        exchange(
            &mut lines,
            &cmd(INS_SIGN_TX, &[&[GET_CHUNK_OK][..], &store[&first]].concat()),
            &[&[GET_CHUNK][..], &[0xAB; 32]].concat(),
        );
        exchange(
            &mut lines,
            &cmd(INS_SIGN_TX, &[GET_CHUNK_FAIL]),
            &[PUT_CHUNK, 1, 2, 3],
        );
        exchange(
            &mut lines,
            &cmd(INS_SIGN_TX, &[PUT_CHUNK_OK]),
            &[&[RESULT_ACCUMULATING][..], &sig[..40]].concat(),
        );
        exchange(
            &mut lines,
            &cmd(INS_SIGN_TX, &[RESULT_ACK]),
            &[&[RESULT_FINAL][..], &sig[40..]].concat(),
        );
        let r = Replay::new(&lines);
        let c = ctl();
        let a = App::open(&r, &c, HwKeyChain::Sui).unwrap();
        assert_eq!(sign(&a, &path, &msg, &[]).unwrap(), sig.to_vec());
        assert!(r.done());
    }

    /// A real USDC coin from mainnet: `objectBcs` hashes to the digest of its object reference.
    const USDC_COIN: &str = "AAMH26NGcuMMsGWx+T46tVMYdo/W/vZsFZQsn3y4RuL5AOcEdXNkYwRVU0RDAAEPYWIjAAAAACgAAAA1AXooCjBNp5CZPcjcAWFxFJYN0OKxESEPaw06flkAAAAAAAAAAELNdnXHuBa/YqIU+k8DevneB3OQeB9eCqMMUy/M/DLoIFN39BxuZWvzBYT7quGT+pxubFnlL6I4k9oQNbLUD0sQoC0UAAAAAAA=";

    fn usdc_coin() -> (Vec<u8>, wallet_core::SuiObjectRef) {
        use base64::Engine;
        let bcs = base64::engine::general_purpose::STANDARD
            .decode(USDC_COIN)
            .unwrap();
        let r = wallet_core::SuiObjectRef::parse(
            "0x00000035017a280a304da790993dc8dc01617114960dd0e2b111210f6b0d3a7e",
            593_649_935,
            "Be9RLkGfSh9j1LwXrj9zgZLhZQqBYyJG7kQyGWpqKHUi",
        )
        .unwrap();
        (bcs, r)
    }

    #[test]
    fn real_coin_object_matches_its_digest() {
        let (bcs, r) = usdc_coin();
        assert_eq!(wallet_core::sui_object_digest(&bcs), r.digest);
    }

    /// USDC transfer signed through the third parameter, then checked as a Sui signature.
    #[test]
    fn token_transfer_sends_the_objects_as_third_parameter() {
        use ed25519_dalek::Signer;
        let (object, coin) = usdc_coin();
        let k = ed25519_dalek::SigningKey::from_bytes(&[5; 32]);
        let pk = k.verifying_key().to_bytes();
        let t = wallet_core::SuiTransfer {
            sender: wallet_core::sui_address_bytes_of_pubkey(&pk),
            recipient: [2; 32],
            amount: wallet_core::SuiTransferAmount::Mist(1_500_000),
            gas_payment: vec![wallet_core::SuiObjectRef {
                object_id: [3; 32],
                version: 9,
                digest: [4; 32],
            }],
            gas_price: 1000,
            gas_budget: 5_000_000,
            expiration_epoch: Some(900),
            coins: vec![coin],
        };
        use base64::Engine;
        let bcs = base64::engine::general_purpose::STANDARD.encode(t.encode().unwrap());
        let msg = wallet_core::sui_hw_message(&bcs).unwrap();
        let path = HwKeyChain::Sui.path(0);
        let objects = vec![object.clone()];
        let params = sign_params(&path, &msg, &objects);
        assert_eq!(params.len(), 3);
        let list = [
            &1u32.to_le_bytes()[..],
            &(object.len() as u32).to_le_bytes(),
            &object,
        ]
        .concat();
        assert_eq!(params[2], list);
        let (start, store) = blocks(&params);
        assert_eq!(start.len(), 1 + 96);
        let mut lines = app("Sui", "1.6.0").to_vec();
        let mut payload = start.clone();
        for i in 0..3 {
            let mut key: [u8; 32] = start[1 + 32 * i..33 + 32 * i].try_into().unwrap();
            loop {
                let block = store[&key].clone();
                exchange(
                    &mut lines,
                    &cmd(INS_SIGN_TX, &payload),
                    &[&[GET_CHUNK][..], &key].concat(),
                );
                payload = [&[GET_CHUNK_OK][..], &block].concat();
                key = block[..32].try_into().unwrap();
                if key == [0; 32] {
                    break;
                }
            }
        }
        let sig = k.sign(&blake2_of(&msg)).to_bytes();
        exchange(
            &mut lines,
            &cmd(INS_SIGN_TX, &payload),
            &[&[RESULT_FINAL][..], &sig].concat(),
        );
        let r = Replay::new(&lines);
        let c = ctl();
        let a = App::open(&r, &c, HwKeyChain::Sui).unwrap();
        assert_eq!(sign(&a, &path, &msg, &objects).unwrap(), sig.to_vec());
        assert!(r.done());
        wallet_core::sui_hw_signature(&bcs, &pk, &sig).unwrap();
    }

    /// What Sui signs: BLAKE2b-256 of the intent message.
    fn blake2_of(msg: &[u8]) -> Vec<u8> {
        use blake2::digest::{consts::U32, Digest};
        blake2::Blake2b::<U32>::digest(msg).to_vec()
    }

    #[test]
    fn undecodable_transfer_names_the_sui_app() {
        let e = apdu::sw_error(0x6808, SwContext::SuiSigning);
        assert!(format!("{e:?}").contains("Sui app"));
    }

    #[test]
    fn refusal_on_device() {
        let path = HwKeyChain::Sui.path(0);
        let (start, _) = blocks(&sign_params(&path, &[0, 0, 0, 1], &[]));
        let mut lines = app("Sui", "1.6.0").to_vec();
        lines.push(format!("=> {}", hex::encode(cmd(INS_SIGN_TX, &start))));
        lines.push("<= 6985".into());
        let r = Replay::new(&lines);
        let c = ctl();
        let a = App::open(&r, &c, HwKeyChain::Sui).unwrap();
        assert_eq!(sign(&a, &path, &[0, 0, 0, 1], &[]), Err(HwError::Rejected));
    }
}
