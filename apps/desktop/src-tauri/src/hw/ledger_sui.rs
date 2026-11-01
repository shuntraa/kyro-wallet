//! Ledger « Sui » app (LedgerHQ/app-sui, host library `@mysten/ledgerjs-hw-app-sui`).
//!
//! Every command uses the app's **block protocol**: each parameter is cut into 180-byte chunks
//! linked from the last to the first by SHA-256 (`block = hash(next block) || chunk`), the
//! command carries `START || hash(first block)…`, then the device asks for blocks by hash
//! (`GET_CHUNK`), may store some (`PUT_CHUNK`) and streams its result (`RESULT_ACCUMULATING` /
//! `RESULT_FINAL`). CLA 00; INS 01 = verify address (shown on screen), 02 = get public key,
//! 03 = sign. Paths: count then **little-endian** indices.
//!
//! - Public key → `32 || pubkey || 32 || address` (address = BLAKE2b-256(0x00 || pubkey),
//!   checked).
//! - Sign: parameters `len (u32 LE) || intent message` and the path → 64-byte ed25519
//!   signature of BLAKE2b-256(intent message).

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

/// A transaction is a few hundred bytes: bounds the conversation.
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
            .ok_or_else(|| HwError::bad("réponse Sui vide"))?;
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
                    .map_err(|_| HwError::bad("demande de bloc Sui mal formée"))?;
                match store.get(&key) {
                    Some(b) => [&[GET_CHUNK_OK][..], b].concat(),
                    None => vec![GET_CHUNK_FAIL],
                }
            }
            PUT_CHUNK => {
                store.insert(Sha256::digest(rest).into(), rest.to_vec());
                vec![PUT_CHUNK_OK]
            }
            _ => return Err(HwError::bad("instruction inconnue de l'app Sui")),
        };
    }
    Err(HwError::bad("app Sui : conversation trop longue"))
}

pub fn parse_pubkey(data: &[u8]) -> HwResult<Vec<u8>> {
    let bad = || HwError::bad("clé publique Sui mal formée");
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
                "adresse Sui de l'appareil incohérente avec sa clé",
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

pub fn sign_params(path: &[u32], intent_message: &[u8]) -> Vec<Vec<u8>> {
    let mut tx = (intent_message.len() as u32).to_le_bytes().to_vec();
    tx.extend_from_slice(intent_message);
    vec![tx, path_payload(path)]
}

pub fn sign(app: &App<'_>, path: &[u32], intent_message: &[u8]) -> HwResult<Vec<u8>> {
    let sig = run(
        app,
        INS_SIGN_TX,
        &sign_params(path, intent_message),
        SwContext::Signing,
    )?;
    if sig.len() != 64 {
        return Err(HwError::bad("signature Sui de longueur inattendue"));
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
        // Two-chunk parameter: block 2 = zeros || tail, block 1 = hash(block 2) || head.
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
        // Public key of the NEAR app vector reused as an ed25519 key; the address is
        // BLAKE2b-256(0x00 || pk) as the Sui app computes it.
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
        // A device address that is not the key's is refused.
        let mut bad = [&[32u8][..], &pk, &[32], &addr].concat();
        bad[40] ^= 1;
        assert!(parse_pubkey(&bad).is_err());
        assert!(parse_pubkey(&[&[32u8][..], &pk].concat()).is_ok());
    }

    #[test]
    fn sign_streams_result_and_handles_put_chunk_and_unknown_blocks() {
        let msg = [&[0u8, 0, 0][..], &[7u8; 300]].concat();
        let path = HwKeyChain::Sui.path(1);
        let params = sign_params(&path, &msg);
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
        assert_eq!(sign(&a, &path, &msg).unwrap(), sig.to_vec());
        assert!(r.done());
    }

    #[test]
    fn refusal_on_device() {
        let path = HwKeyChain::Sui.path(0);
        let (start, _) = blocks(&sign_params(&path, &[0, 0, 0, 1]));
        let mut lines = app("Sui", "1.6.0").to_vec();
        lines.push(format!("=> {}", hex::encode(cmd(INS_SIGN_TX, &start))));
        lines.push("<= 6985".into());
        let r = Replay::new(&lines);
        let c = ctl();
        let a = App::open(&r, &c, HwKeyChain::Sui).unwrap();
        assert_eq!(sign(&a, &path, &[0, 0, 0, 1]), Err(HwError::Rejected));
    }
}
