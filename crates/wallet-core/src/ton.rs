//! TON: ed25519 `m/44'/607'/account'` (SLIP-10, Trust Wallet's route), wallet v4R2,
//! user-friendly addresses, TON transfers with optional comment.

use base64::Engine as _;
use ed25519_dalek::Signer as _;
use ed25519_dalek_bip32::{ChildIndex, ExtendedSigningKey};
use serde::{Deserialize, Serialize};
use tycho_types::boc::ser::BocHeader;
use tycho_types::boc::Boc;
use tycho_types::cell::{Cell, CellBuilder, CellFamily, CellSlice, HashBytes};
use zeroize::Zeroize;

use crate::display::sanitize_text;
use crate::error::{Error, Result};
use crate::mnemonic::Seed;

mod jetton;
pub use jetton::{
    ton_jetton_wallet_address, ton_known_jetton, ton_known_jettons, TonJettonBody, TonJettonInfo,
    TonJettonSummary, TON_JETTON_ATTACHED_NANOTON, TON_JETTON_FORWARD_NANOTON,
    TON_JETTON_TRANSFER_OP,
};

/// Standard v4R2 wallet id (`698983191 + workchain`), mainnet.
pub const TON_WALLET_ID_MAINNET: u32 = 698_983_191;
/// Kyro's testnet v4R2 wallet id (`"KYRO"`): differs from mainnet, so no cross-net replay.
pub const TON_WALLET_ID_TESTNET: u32 = 0x4B59_524F;
/// Representation hash of the official wallet v4R2 code.
pub const TON_V4R2_CODE_HASH: &str =
    "feb5ff6820e2ff0d9483e7e0d62c817d846789fb4ae580c878866d959dabd5c0";
/// `PAY_FEES_SEPARATELY (1) + IGNORE_ERRORS (2)`: the amount arrives in full, fees on top.
pub const TON_MODE_PAY_FEES: u8 = 3;
/// `CARRY_ALL_REMAINING_BALANCE (128) + IGNORE_ERRORS (2)`: the whole balance (minus fees).
pub const TON_MODE_ALL_BALANCE: u8 = 130;
/// Longest comment: what fits in one cell after the 32-bit text opcode (1023 bits → 123 bytes).
pub const TON_MAX_COMMENT_BYTES: usize = 123;
const MAX_COMMENT_CHARS: usize = 123;
const MAX_NANOTON: u64 = 5_200_000_000_000_000_000;
const MAX_BOC_BASE64: usize = 4096;

const V4R2_CODE_BOC: &str = "te6ccgECFAEAAtQAART/APSkE/S88sgLAQIBIAIDAgFIBAUE+PKDCNcYINMf0x/THwL4I7vyZO1E0NMf0x/T//QE0VFDuvKhUVG68qIF+QFUEGT5EPKj+AAkpMjLH1JAyx9SMMv/UhD0AMntVPgPAdMHIcAAn2xRkyDXSpbTB9QC+wDoMOAhwAHjACHAAuMAAcADkTDjDQOkyMsfEssfy/8QERITAubQAdDTAyFxsJJfBOAi10nBIJJfBOAC0x8hghBwbHVnvSKCEGRzdHK9sJJfBeAD+kAwIPpEAcjKB8v/ydDtRNCBAUDXIfQEMFyBAQj0Cm+hMbOSXwfgBdM/yCWCEHBsdWe6kjgw4w0DghBkc3RyupJfBuMNBgcCASAICQB4AfoA9AQw+CdvIjBQCqEhvvLgUIIQcGx1Z4MesXCAGFAEywUmzxZY+gIZ9ADLaRfLH1Jgyz8gyYBA+wAGAIpQBIEBCPRZMO1E0IEBQNcgyAHPFvQAye1UAXKwjiOCEGRzdHKDHrFwgBhQBcsFUAPPFiP6AhPLassfyz/JgED7AJJfA+ICASAKCwBZvSQrb2omhAgKBrkPoCGEcNQICEekk30pkQzmkD6f+YN4EoAbeBAUiYcVnzGEAgFYDA0AEbjJftRNDXCx+AA9sp37UTQgQFA1yH0BDACyMoHy//J0AGBAQj0Cm+hMYAIBIA4PABmtznaiaEAga5Drhf/AABmvHfaiaEAQa5DrhY/AAG7SB/oA1NQi+QAFyMoHFcv/ydB3dIAYyMsFywIizxZQBfoCFMtrEszMyXP7AMhAFIEBCPRR8qcCAHCBAQjXGPoA0z/IVCBHgQEI9FHyp4IQbm90ZXB0gBjIywXLAlAGzxZQBPoCFMtqEssfyz/Jc/sAAgBsgQEI1xj6ANM/MFIkgQEI9Fnyp4IQZHN0cnB0gBjIywXLAlAFzxZQA/oCE8tqyx8Syz/Jc/sAAAr0AMntVA==";

fn hardened(index: u32) -> Result<ChildIndex> {
    ChildIndex::hardened(index).map_err(|_| Error::input("derivation index must be < 2^31"))
}

fn signing_key(seed: &Seed, account: u32) -> Result<ed25519_dalek::SigningKey> {
    let path = [hardened(44)?, hardened(607)?, hardened(account)?];
    let root = ExtendedSigningKey::from_seed(&seed[..])
        .map_err(|_| Error::crypto("SLIP-10 master derivation failed"))?;
    let mut child = root
        .derive(&path)
        .map_err(|_| Error::crypto("SLIP-10 derivation failed"))?;
    // `SigningKey` zeroizes itself on drop; the chain codes do not, so wipe them here.
    let mut root = root;
    root.chain_code.zeroize();
    child.chain_code.zeroize();
    Ok(child.signing_key.clone())
}

/// Path of the key of TON account `account`: `m/44'/607'/account'`.
pub fn ton_path(account: u32) -> String {
    format!("m/44'/607'/{account}'")
}

/// Ed25519 public key of TON account `account`.
pub fn ton_public_key(seed: &Seed, account: u32) -> Result<[u8; 32]> {
    Ok(signing_key(seed, account)?.verifying_key().to_bytes())
}

/// v4R2 wallet id Kyro uses on `testnet` / mainnet.
pub fn ton_wallet_id(testnet: bool) -> u32 {
    if testnet {
        TON_WALLET_ID_TESTNET
    } else {
        TON_WALLET_ID_MAINNET
    }
}

/// A TON account: workchain and 256-bit account id (`wc:hex`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct TonAddress {
    /// 0 = basechain, -1 = masterchain.
    pub workchain: i8,
    /// Account id (hash of the contract's `StateInit`).
    pub hash: [u8; 32],
}

/// A user-friendly address and its flags.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TonFriendly {
    /// The account.
    pub address: TonAddress,
    /// `EQ…` (bounceable) rather than `UQ…` (non-bounceable).
    pub bounceable: bool,
    /// Testnet-only flag (`kQ…` / `0Q…`).
    pub testnet: bool,
}

fn crc16(data: &[u8]) -> u16 {
    let mut crc: u16 = 0;
    for &b in data {
        crc ^= u16::from(b) << 8;
        for _ in 0..8 {
            crc = if crc & 0x8000 != 0 {
                (crc << 1) ^ 0x1021
            } else {
                crc << 1
            };
        }
    }
    crc
}

impl TonAddress {
    /// User-friendly base64url form (48 characters).
    pub fn to_friendly(&self, bounceable: bool, testnet: bool) -> String {
        let mut b = [0u8; 36];
        b[0] = (if bounceable { 0x11 } else { 0x51 }) | (if testnet { 0x80 } else { 0 });
        b[1] = self.workchain.to_be_bytes()[0];
        b[2..34].copy_from_slice(&self.hash);
        let crc = crc16(&b[..34]);
        b[34..].copy_from_slice(&crc.to_be_bytes());
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b)
    }

    /// Raw form `wc:hex` (lower case).
    pub fn to_raw(&self) -> String {
        format!("{}:{}", self.workchain, hex::encode(self.hash))
    }
}

/// Parses a 48-char user-friendly address; checksum, tag and workchain (0/-1) verified.
pub fn ton_parse_address(s: &str) -> Result<TonFriendly> {
    let s = s.trim();
    if s.contains(':') {
        return Err(Error::input(
            "raw TON address (0:…) refused: use the user-friendly EQ… / UQ… form, which has a checksum",
        ));
    }
    if s.len() != 48 {
        return Err(Error::input("invalid TON address (48 characters expected)"));
    }
    let url = s.contains(['-', '_']);
    if url && s.contains(['+', '/']) {
        return Err(Error::input("invalid TON address (mixed base64)"));
    }
    let engine = if url {
        &base64::engine::general_purpose::URL_SAFE_NO_PAD
    } else {
        &base64::engine::general_purpose::STANDARD_NO_PAD
    };
    let b: [u8; 36] = engine
        .decode(s)
        .ok()
        .and_then(|v| v.try_into().ok())
        .ok_or_else(|| Error::input("invalid TON address"))?;
    if crc16(&b[..34]).to_be_bytes() != b[34..] {
        return Err(Error::input("invalid TON address (checksum)"));
    }
    let testnet = b[0] & 0x80 != 0;
    let bounceable = match b[0] & 0x7f {
        0x11 => true,
        0x51 => false,
        _ => return Err(Error::input("invalid TON address (unknown flag)")),
    };
    let workchain = i8::from_be_bytes([b[1]]);
    if workchain != 0 && workchain != -1 {
        return Err(Error::input("invalid TON address (unknown workchain)"));
    }
    let mut hash = [0u8; 32];
    hash.copy_from_slice(&b[2..34]);
    Ok(TonFriendly {
        address: TonAddress { workchain, hash },
        bounceable,
        testnet,
    })
}

/// Parses a raw `wc:hex` address as servers return it (workchain 0 or -1, 64 hex digits).
pub fn ton_parse_raw_address(s: &str) -> Result<TonAddress> {
    let (wc, h) = s
        .trim()
        .split_once(':')
        .ok_or_else(|| Error::input("invalid raw TON address"))?;
    let workchain = match wc {
        "0" => 0,
        "-1" => -1,
        _ => return Err(Error::input("invalid raw TON address (workchain)")),
    };
    let hash: [u8; 32] = (h.len() == 64)
        .then(|| hex::decode(h).ok())
        .flatten()
        .and_then(|v| v.try_into().ok())
        .ok_or_else(|| Error::input("invalid raw TON address"))?;
    Ok(TonAddress { workchain, hash })
}

fn cell_err(_: tycho_types::error::Error) -> Error {
    Error::input("invalid TON cell")
}

fn v4r2_code() -> Result<Cell> {
    let (_, code) = decode_boc_b64(V4R2_CODE_BOC).map_err(|_| Error::crypto("v4R2 code"))?;
    if hex::encode(code.repr_hash().0) != TON_V4R2_CODE_HASH {
        return Err(Error::crypto("v4R2 code hash mismatch"));
    }
    Ok(code)
}

fn v4r2_data(public_key: &[u8; 32], wallet_id: u32) -> Result<Cell> {
    let mut b = CellBuilder::new();
    b.store_u32(0).map_err(cell_err)?; // seqno
    b.store_u32(wallet_id).map_err(cell_err)?;
    b.store_u256(&HashBytes(*public_key)).map_err(cell_err)?;
    b.store_bit_zero().map_err(cell_err)?; // plugins: empty dictionary
    b.build().map_err(cell_err)
}

fn state_init(public_key: &[u8; 32], wallet_id: u32) -> Result<Cell> {
    let mut b = CellBuilder::new();
    b.store_small_uint(0b00110, 5).map_err(cell_err)?;
    b.store_reference(v4r2_code()?).map_err(cell_err)?;
    b.store_reference(v4r2_data(public_key, wallet_id)?)
        .map_err(cell_err)?;
    b.build().map_err(cell_err)
}

/// Address of the v4R2 wallet of `public_key` (workchain 0).
pub fn ton_wallet_address(public_key: &[u8; 32], wallet_id: u32) -> Result<TonAddress> {
    Ok(TonAddress {
        workchain: 0,
        hash: state_init(public_key, wallet_id)?.repr_hash().0,
    })
}

/// Our non-bounceable user-friendly address (`UQ…`, testnet `0Q…`) for account `account`.
pub fn ton_address(seed: &Seed, account: u32, testnet: bool) -> Result<String> {
    let pk = ton_public_key(seed, account)?;
    Ok(ton_wallet_address(&pk, ton_wallet_id(testnet))?.to_friendly(false, testnet))
}

fn store_addr(b: &mut CellBuilder, a: &TonAddress) -> Result<()> {
    b.store_small_uint(0b100, 3).map_err(cell_err)?;
    b.store_u8(a.workchain.to_be_bytes()[0]).map_err(cell_err)?;
    b.store_u256(&HashBytes(a.hash)).map_err(cell_err)
}

fn load_addr(s: &mut CellSlice<'_>) -> Result<TonAddress> {
    if s.load_small_uint(3).map_err(cell_err)? != 0b100 {
        return Err(Error::input(
            "TON address expected (addr_std without anycast)",
        ));
    }
    let workchain = i8::from_be_bytes([s.load_u8().map_err(cell_err)?]);
    Ok(TonAddress {
        workchain,
        hash: s.load_u256().map_err(cell_err)?.0,
    })
}

fn store_grams(b: &mut CellBuilder, v: u64) -> Result<()> {
    let bytes = v.to_be_bytes();
    let skip = bytes.iter().take_while(|x| **x == 0).count();
    let len = 8 - skip;
    b.store_small_uint(len as u8, 4).map_err(cell_err)?;
    b.store_raw(&bytes[skip..], (len * 8) as u16)
        .map_err(cell_err)
}

fn load_grams(s: &mut CellSlice<'_>) -> Result<u64> {
    let len = s.load_small_uint(4).map_err(cell_err)?;
    if len > 8 {
        return Err(Error::input("TON amount too large"));
    }
    let mut v = 0u64;
    for _ in 0..len {
        v = (v << 8) | u64::from(s.load_u8().map_err(cell_err)?);
    }
    Ok(v)
}

fn comment_cell(text: &str) -> Result<Cell> {
    let mut b = CellBuilder::new();
    b.store_u32(0).map_err(cell_err)?;
    b.store_raw(text.as_bytes(), (text.len() * 8) as u16)
        .map_err(cell_err)?;
    b.build().map_err(cell_err)
}

fn check_comment(text: &str) -> Result<()> {
    if text.is_empty() {
        return Err(Error::input("empty comment: leave it out"));
    }
    if text.len() > TON_MAX_COMMENT_BYTES {
        return Err(Error::input(format!(
            "comment too long ({} bytes, {TON_MAX_COMMENT_BYTES} at most)",
            text.len()
        )));
    }
    Ok(())
}

fn ensure_empty(s: &CellSlice<'_>) -> Result<()> {
    if s.size_bits() != 0 || s.size_refs() != 0 {
        return Err(Error::input("unexpected TON fields (trailing data)"));
    }
    Ok(())
}

fn slice(c: &Cell) -> Result<CellSlice<'_>> {
    // Refuses exotic cells (pruned branches, library references…).
    CellSlice::new(c.as_ref()).map_err(|_| Error::input("special TON cell refused"))
}

fn encode_boc(c: &Cell) -> Vec<u8> {
    let mut out = Vec::new();
    let header: BocHeader<'_> = BocHeader::with_root(c.as_ref());
    header.with_crc(true).encode(&mut out);
    out
}

fn decode_boc_b64(text: &str) -> Result<(Vec<u8>, Cell)> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(text)
        .map_err(|_| Error::input("TON BOC: base64 expected"))?;
    let root = Boc::decode(&bytes).map_err(|_| Error::input("invalid TON BOC"))?;
    Ok((bytes, root))
}

/// A v4R2 transfer: one internal message, in an external message to our wallet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TonTransfer {
    /// Our wallet's public key (wallet address, `StateInit`).
    pub public_key: [u8; 32],
    /// v4R2 wallet id ([`ton_wallet_id`]).
    pub wallet_id: u32,
    /// UNIX time after which the wallet refuses the message.
    pub valid_until: u32,
    /// Wallet sequence number (replay protection).
    pub seqno: u32,
    /// [`TON_MODE_PAY_FEES`] (with `amount > 0`) or [`TON_MODE_ALL_BALANCE`] (with `amount = 0`).
    pub mode: u8,
    /// Recipient.
    pub destination: TonAddress,
    /// Internal message bounce flag: funds return if the recipient fails or is undeployed.
    pub bounce: bool,
    /// Nanotons.
    pub amount: u64,
    /// Text comment (UTF-8, ≤ [`TON_MAX_COMMENT_BYTES`] bytes).
    pub comment: Option<String>,
    /// Carries our wallet's `StateInit` (first transfer, wallet not deployed yet).
    pub with_state_init: bool,
    /// Jetton transfer: `destination` = our jetton wallet, `amount` = TON for its fees.
    pub jetton: Option<TonJettonBody>,
    /// No comment: empty body inline, as the Ledger TON app rebuilds it (app-ton `hash.c`).
    pub inline_empty_body: bool,
}

impl TonTransfer {
    fn check(&self) -> Result<()> {
        match (self.mode, self.amount) {
            (TON_MODE_PAY_FEES, a) if a > 0 => {}
            (TON_MODE_ALL_BALANCE, 0) => {}
            _ => return Err(Error::input(
                "TON transfer: send mode or amount refused (mode 3 with an amount, or 130 without)",
            )),
        }
        if self.amount > MAX_NANOTON {
            return Err(Error::input("invalid TON amount"));
        }
        if self.destination.workchain != 0 {
            return Err(Error::input(
                "recipient on the masterchain (-1) refused: only basechain (0) accounts are supported",
            ));
        }
        if self.inline_empty_body && (self.comment.is_some() || self.jetton.is_some()) {
            return Err(Error::input(
                "TON transfer: inline body only without a comment or token",
            ));
        }
        if self.with_state_init && self.seqno != 0 {
            return Err(Error::input(
                "StateInit only for the first transfer (seqno 0)",
            ));
        }
        if let Some(c) = &self.comment {
            check_comment(c)?;
        }
        if let Some(j) = &self.jetton {
            if self.mode != TON_MODE_PAY_FEES || !self.bounce || self.comment.is_some() {
                return Err(Error::input(
                    "token transfer: mode 3, bounce, and the comment in the token only",
                ));
            }
            j.check(self.amount, &self.wallet_address()?)?;
        }
        Ok(())
    }

    /// Address of the wallet that sends (ours).
    pub fn wallet_address(&self) -> Result<TonAddress> {
        ton_wallet_address(&self.public_key, self.wallet_id)
    }

    fn internal_message(&self) -> Result<Cell> {
        let mut b = CellBuilder::new();
        // int_msg_info$0 ihr_disabled:Bool bounce:Bool bounced:Bool src:addr_none$00
        b.store_small_uint(0b0100 | (u8::from(self.bounce) << 1), 4)
            .map_err(cell_err)?;
        b.store_small_uint(0b00, 2).map_err(cell_err)?;
        store_addr(&mut b, &self.destination)?;
        store_grams(&mut b, self.amount)?;
        b.store_bit_zero().map_err(cell_err)?; // no extra currency
        store_grams(&mut b, 0)?; // ihr_fee
        store_grams(&mut b, 0)?; // fwd_fee
        b.store_u64(0).map_err(cell_err)?; // created_lt
        b.store_u32(0).map_err(cell_err)?; // created_at
        b.store_bit_zero().map_err(cell_err)?; // init: nothing
        if self.inline_empty_body && self.comment.is_none() && self.jetton.is_none() {
            b.store_bit_zero().map_err(cell_err)?; // body: inline, empty
            return b.build().map_err(cell_err);
        }
        b.store_bit_one().map_err(cell_err)?; // body: in a reference (empty when no comment)
        b.store_reference(match (&self.jetton, &self.comment) {
            (Some(j), _) => j.cell()?,
            (None, Some(c)) => comment_cell(c)?,
            (None, None) => Cell::empty_cell(),
        })
        .map_err(cell_err)?;
        b.build().map_err(cell_err)
    }

    fn signing_builder(&self) -> Result<CellBuilder> {
        self.check()?;
        let mut b = CellBuilder::new();
        b.store_u32(self.wallet_id).map_err(cell_err)?;
        b.store_u32(self.valid_until).map_err(cell_err)?;
        b.store_u32(self.seqno).map_err(cell_err)?;
        b.store_u8(0).map_err(cell_err)?; // op: simple send
        b.store_u8(self.mode).map_err(cell_err)?;
        b.store_reference(self.internal_message()?)
            .map_err(cell_err)?;
        Ok(b)
    }

    /// What the wallet checks the signature against: the hash of the signed part.
    pub fn signing_hash(&self) -> Result<[u8; 32]> {
        Ok(self
            .signing_builder()?
            .build()
            .map_err(cell_err)?
            .repr_hash()
            .0)
    }

    fn body(&self, signature: &[u8; 64]) -> Result<Cell> {
        let mut b = CellBuilder::new();
        b.store_raw(signature, 512).map_err(cell_err)?;
        b.store_builder(&self.signing_builder()?)
            .map_err(cell_err)?;
        b.build().map_err(cell_err)
    }

    fn external(&self, signature: &[u8; 64]) -> Result<Cell> {
        let mut b = CellBuilder::new();
        // ext_in_msg_info$10 src:addr_none$00
        b.store_small_uint(0b1000, 4).map_err(cell_err)?;
        store_addr(&mut b, &self.wallet_address()?)?;
        store_grams(&mut b, 0)?; // import_fee
        if self.with_state_init {
            // init: just (Either StateInit ^StateInit) = right: in a reference
            b.store_small_uint(0b11, 2).map_err(cell_err)?;
            b.store_reference(state_init(&self.public_key, self.wallet_id)?)
                .map_err(cell_err)?;
        } else {
            b.store_bit_zero().map_err(cell_err)?;
        }
        b.store_bit_one().map_err(cell_err)?; // body in a reference
        b.store_reference(self.body(signature)?).map_err(cell_err)?;
        b.build().map_err(cell_err)
    }

    /// BOC of the external message with an all-zero signature (between build and sign).
    pub fn encode_unsigned(&self) -> Result<String> {
        Ok(base64::engine::general_purpose::STANDARD.encode(encode_boc(&self.external(&[0; 64])?)))
    }

    fn encode_signed(&self, signature: &[u8; 64]) -> Result<(String, [u8; 32])> {
        let ext = self.external(signature)?;
        Ok((
            base64::engine::general_purpose::STANDARD.encode(encode_boc(&ext)),
            ext.repr_hash().0,
        ))
    }

    fn normalized_hash(&self, signature: &[u8; 64]) -> Result<[u8; 32]> {
        let mut b = CellBuilder::new();
        b.store_small_uint(0b1000, 4).map_err(cell_err)?;
        store_addr(&mut b, &self.wallet_address()?)?;
        store_grams(&mut b, 0)?;
        b.store_bit_zero().map_err(cell_err)?;
        b.store_bit_one().map_err(cell_err)?;
        b.store_reference(self.body(signature)?).map_err(cell_err)?;
        Ok(b.build().map_err(cell_err)?.repr_hash().0)
    }

    /// toncenter `estimateFee` inputs: body BOC (zero sig) and `StateInit` BOCs if undeployed.
    pub fn estimate_parts(&self) -> Result<TonEstimateParts> {
        self.estimate_parts_signed(&[0; 64])
    }

    /// [`Self::estimate_parts`] with a given signature (emulates the signed message).
    pub fn estimate_parts_signed(&self, signature: &[u8; 64]) -> Result<TonEstimateParts> {
        let b64 = |c: &Cell| base64::engine::general_purpose::STANDARD.encode(encode_boc(c));
        let (init_code, init_data) = if self.with_state_init {
            (
                b64(&v4r2_code()?),
                b64(&v4r2_data(&self.public_key, self.wallet_id)?),
            )
        } else {
            (String::new(), String::new())
        };
        Ok(TonEstimateParts {
            body: b64(&self.body(signature)?),
            init_code,
            init_data,
        })
    }

    /// Strict decoding of an external-message BOC (standard base64).
    pub fn decode(
        boc_b64: &str,
        public_key: &[u8; 32],
        wallet_id: u32,
    ) -> Result<(Self, [u8; 64])> {
        let text = boc_b64.trim();
        if text.is_empty() || text.len() > MAX_BOC_BASE64 {
            return Err(Error::input("TON BOC missing or too long"));
        }
        let (bytes, root) = decode_boc_b64(text)?;
        let mut s = slice(&root)?;
        if s.load_small_uint(4).map_err(cell_err)? != 0b1000 {
            return Err(Error::input("inbound external message expected"));
        }
        let wallet = load_addr(&mut s)?;
        if load_grams(&mut s)? != 0 {
            return Err(Error::input("non-zero import_fee"));
        }
        let with_state_init = match s.load_bit().map_err(cell_err)? {
            false => false,
            true => {
                if !s.load_bit().map_err(cell_err)? {
                    return Err(Error::input("StateInit expected as a reference"));
                }
                let init = s.load_reference_cloned().map_err(cell_err)?;
                if init.repr_hash().0 != state_init(public_key, wallet_id)?.repr_hash().0 {
                    return Err(Error::input("this StateInit is not your v4R2 wallet's"));
                }
                true
            }
        };
        if !s.load_bit().map_err(cell_err)? {
            return Err(Error::input("body expected as a reference"));
        }
        let body = s.load_reference_cloned().map_err(cell_err)?;
        ensure_empty(&s)?;

        let mut b = slice(&body)?;
        let mut signature = [0u8; 64];
        for x in signature.iter_mut() {
            *x = b.load_u8().map_err(cell_err)?;
        }
        let got_wallet_id = b.load_u32().map_err(cell_err)?;
        if got_wallet_id != wallet_id {
            return Err(Error::input(
                "unexpected wallet id: another network or another wallet",
            ));
        }
        let valid_until = b.load_u32().map_err(cell_err)?;
        let seqno = b.load_u32().map_err(cell_err)?;
        if b.load_u8().map_err(cell_err)? != 0 {
            return Err(Error::input(
                "wallet operation refused (only a simple send is accepted: no plugin)",
            ));
        }
        let mode = b.load_u8().map_err(cell_err)?;
        let msg = b.load_reference_cloned().map_err(cell_err)?;
        ensure_empty(&b)?;

        let mut m = slice(&msg)?;
        // int_msg_info$0, ihr_disabled = 1, bounce, bounced = 0
        let head = m.load_small_uint(4).map_err(cell_err)?;
        if head & 0b1101 != 0b0100 {
            return Err(Error::input(
                "internal message expected (without IHR, not bounced)",
            ));
        }
        let bounce = head & 0b0010 != 0;
        if m.load_small_uint(2).map_err(cell_err)? != 0 {
            return Err(Error::input("unexpected internal message source"));
        }
        let destination = load_addr(&mut m)?;
        let amount = load_grams(&mut m)?;
        if m.load_bit().map_err(cell_err)? {
            return Err(Error::input("extra currencies refused"));
        }
        if load_grams(&mut m)? != 0 || load_grams(&mut m)? != 0 {
            return Err(Error::input("non-zero IHR / forward fees"));
        }
        if m.load_u64().map_err(cell_err)? != 0 || m.load_u32().map_err(cell_err)? != 0 {
            return Err(Error::input("non-zero created_lt / created_at"));
        }
        if m.load_bit().map_err(cell_err)? {
            return Err(Error::input(
                "the message deploys a contract (StateInit): refused",
            ));
        }
        let inline_empty_body = !m.load_bit().map_err(cell_err)?;
        let payload = if inline_empty_body {
            // Inline body: must be empty (what the Ledger TON app signs without payload).
            Cell::empty_cell()
        } else {
            m.load_reference_cloned().map_err(cell_err)?
        };
        ensure_empty(&m)?;

        let mut p = slice(&payload)?;
        let is_jetton = p.size_bits() >= 32
            && p.clone().load_u32().map_err(cell_err)? == TON_JETTON_TRANSFER_OP;
        let jetton = if is_jetton {
            Some(TonJettonBody::parse(&mut p)?)
        } else {
            None
        };
        let comment = if is_jetton || (p.size_bits() == 0 && p.size_refs() == 0) {
            None
        } else {
            if p.size_refs() != 0 || p.size_bits() < 32 || p.size_bits() % 8 != 0 {
                return Err(Error::input(
                    "message content refused (only a text comment is accepted)",
                ));
            }
            if p.load_u32().map_err(cell_err)? != 0 {
                return Err(Error::input(
                    "message content refused (contract operation, not a text comment)",
                ));
            }
            let mut raw = Vec::with_capacity(usize::from(p.size_bits() / 8));
            while p.size_bits() > 0 {
                raw.push(p.load_u8().map_err(cell_err)?);
            }
            Some(String::from_utf8(raw).map_err(|_| Error::input("TON comment: invalid UTF-8"))?)
        };

        let t = TonTransfer {
            public_key: *public_key,
            wallet_id,
            valid_until,
            seqno,
            mode,
            destination,
            bounce,
            amount,
            comment,
            with_state_init,
            jetton,
            inline_empty_body,
        };
        t.check()?;
        if wallet != t.wallet_address()? {
            return Err(Error::input(
                "this message is not addressed to your TON wallet",
            ));
        }
        if encode_boc(&t.external(&signature)?) != bytes {
            return Err(Error::input("non-canonical TON BOC (re-encoding differs)"));
        }
        Ok((t, signature))
    }
}

/// toncenter `estimateFee` inputs (base64 BOCs; init parts empty when deployed).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TonEstimateParts {
    /// External message body with a zero signature.
    pub body: String,
    /// v4R2 code (empty if no `StateInit`).
    pub init_code: String,
    /// v4R2 initial data (empty if no `StateInit`).
    pub init_data: String,
}

/// Things that need the reinforced confirmation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TonWarning {
    /// The comment has invisible / control characters (shown cleaned).
    UnusualText,
}

/// What the native dialog shows, decoded by Rust from the BOC that will be signed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TonTxSummary {
    /// Our wallet (non-bounceable form).
    pub wallet: String,
    /// Recipient, in the form matching the bounce flag of the message (`EQ…` bounce / `UQ…`).
    pub destination: String,
    /// The same account in the other form (only the flag and the checksum differ).
    pub destination_other: String,
    /// Recipient, raw `0:hex`.
    pub destination_raw: String,
    /// Nanotons (decimal string); `"0"` with `sendAll`.
    pub amount: String,
    /// Mode 130: the whole balance goes (minus fees).
    pub send_all: bool,
    /// Bounce flag of the message.
    pub bounce: bool,
    /// Comment, cleaned for display.
    pub comment: Option<String>,
    /// Wallet sequence number.
    pub seqno: u32,
    /// UNIX time after which the message is refused.
    pub valid_until: u32,
    /// The message deploys our wallet (first transfer).
    pub deploys_wallet: bool,
    /// v4R2 wallet id.
    pub wallet_id: u32,
    /// Unusual elements.
    pub warnings: Vec<TonWarning>,
    /// At least one warning: second, reinforced confirmation.
    pub requires_extra_confirmation: bool,
    /// Jetton transfer (known jetton, to our computed jetton wallet); comment = forward comment.
    pub jetton: Option<TonJettonSummary>,
}

fn summarize(t: &TonTransfer, testnet: bool) -> Result<TonTxSummary> {
    let comment = t
        .comment
        .as_deref()
        .or(t.jetton.as_ref().and_then(|j| j.comment.as_deref()))
        .map(|c| sanitize_text(c, MAX_COMMENT_CHARS));
    let wallet = t.wallet_address()?;
    let jetton = match &t.jetton {
        Some(j) => Some(jetton::summarize(j, &t.destination, &wallet, testnet)?),
        None => None,
    };
    let mut warnings = Vec::new();
    if comment.as_ref().is_some_and(|c| c.altered) {
        warnings.push(TonWarning::UnusualText);
    }
    Ok(TonTxSummary {
        wallet: wallet.to_friendly(false, testnet),
        destination: t.destination.to_friendly(t.bounce, testnet),
        destination_other: t.destination.to_friendly(!t.bounce, testnet),
        destination_raw: t.destination.to_raw(),
        amount: t.amount.to_string(),
        send_all: t.mode == TON_MODE_ALL_BALANCE,
        bounce: t.bounce,
        comment: comment.map(|c| c.text),
        seqno: t.seqno,
        valid_until: t.valid_until,
        deploys_wallet: t.with_state_init,
        wallet_id: t.wallet_id,
        requires_extra_confirmation: !warnings.is_empty(),
        warnings,
        jetton,
    })
}

/// Strictly decodes an unsigned transfer BOC of `public_key` (network's wallet id required).
pub fn ton_decode_tx(boc_b64: &str, public_key: &[u8; 32], testnet: bool) -> Result<TonTxSummary> {
    let (t, sig) = TonTransfer::decode(boc_b64, public_key, ton_wallet_id(testnet))?;
    if sig != [0u8; 64] {
        return Err(Error::input("this TON transfer is already signed"));
    }
    summarize(&t, testnet)
}

/// Output of [`ton_sign`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TonSigned {
    /// Signed external message, BOC (standard base64): what is broadcast.
    pub boc: String,
    /// Hash of the external message (hex).
    pub hash: String,
    /// Hash of the normalized external message (hex, TEP-467).
    pub normalized_hash: String,
    /// The decoded summary (identical to [`ton_decode_tx`]'s).
    pub summary: TonTxSummary,
}

fn sign_with(key: &ed25519_dalek::SigningKey, t: &TonTransfer, testnet: bool) -> Result<TonSigned> {
    let hash = t.signing_hash()?;
    let signature = key.sign(&hash);
    key.verifying_key()
        .verify_strict(&hash, &signature)
        .map_err(|_| Error::crypto("signature self-check failed"))?;
    let sig = signature.to_bytes();
    let (boc, h) = t.encode_signed(&sig)?;
    Ok(TonSigned {
        boc,
        hash: hex::encode(h),
        normalized_hash: hex::encode(t.normalized_hash(&sig)?),
        summary: summarize(t, testnet)?,
    })
}

/// Strictly decodes then signs an unsigned transfer BOC with TON account `account`'s key.
pub fn ton_sign(seed: &Seed, account: u32, boc_b64: &str, testnet: bool) -> Result<TonSigned> {
    let key = signing_key(seed, account)?;
    let pk = key.verifying_key().to_bytes();
    let (t, sig) = TonTransfer::decode(boc_b64, &pk, ton_wallet_id(testnet))?;
    if sig != [0u8; 64] {
        return Err(Error::input("this TON transfer is already signed"));
    }
    sign_with(&key, &t, testnet)
}

/// Checks a signed BOC before broadcast: strict decode and valid ed25519 sig by `public_key`.
pub fn ton_verify_signed(
    boc_b64: &str,
    public_key: &[u8; 32],
    testnet: bool,
) -> Result<(TonTransfer, String, String)> {
    let (t, sig) = TonTransfer::decode(boc_b64, public_key, ton_wallet_id(testnet))?;
    let key = ed25519_dalek::VerifyingKey::from_bytes(public_key)
        .map_err(|_| Error::input("invalid TON public key"))?;
    key.verify_strict(
        &t.signing_hash()?,
        &ed25519_dalek::Signature::from_bytes(&sig),
    )
    .map_err(|_| Error::input("invalid TON signature"))?;
    let (_, h) = t.encode_signed(&sig)?;
    Ok((
        t.clone(),
        hex::encode(h),
        hex::encode(t.normalized_hash(&sig)?),
    ))
}

/// Builds the unsigned BOC of a transfer (what `ton_decode_tx` / `ton_sign` take back).
pub fn ton_unsigned_transfer(t: &TonTransfer) -> Result<String> {
    t.encode_unsigned()
}

/// Longest comment the Ledger TON app displays (`MAX_MEMO_LEN`, printable ASCII only).
pub const TON_HW_MAX_COMMENT: usize = 120;
const HW_HINT_COMMENT: u32 = 0x00;
const HW_HINT_JETTON: u32 = 0x01;

/// Comment the Ledger TON app can show: printable ASCII, ≤ [`TON_HW_MAX_COMMENT`] bytes.
pub fn ton_hw_check_comment(text: &str) -> Result<()> {
    if text.len() > TON_HW_MAX_COMMENT || !text.bytes().all(|b| (0x20..0x7f).contains(&b)) {
        return Err(Error::input(
            "TON comment on Ledger: 120 printable ASCII characters at most (no accents or emoji)",
        ));
    }
    check_comment(text)
}

/// Minimal big-endian amount bytes (app `varuint` / cell `VarUInteger 16`, must be minimal).
fn varuint(v: u128) -> Vec<u8> {
    let b = v.to_be_bytes();
    let skip = b.iter().take_while(|x| **x == 0).count();
    let mut out = vec![(16 - skip) as u8];
    out.extend_from_slice(&b[skip..]);
    out
}

/// Ledger TON app request for an unsigned BOC (app-ton `doc/TRANSACTION.md`, tag 0x01, ≥2.1.0)
/// and the order-cell hash it must sign.
pub fn ton_hw_request(
    boc_b64: &str,
    public_key: &[u8; 32],
    testnet: bool,
) -> Result<(Vec<u8>, [u8; 32])> {
    let (t, sig) = TonTransfer::decode(boc_b64, public_key, ton_wallet_id(testnet))?;
    if sig != [0u8; 64] {
        return Err(Error::input("this TON transfer is already signed"));
    }
    if t.comment.is_none() && t.jetton.is_none() && !t.inline_empty_body {
        return Err(Error::input(
            "TON transfer not built for the Ledger (empty body as a reference)",
        ));
    }
    let mut r = vec![0x01];
    r.extend_from_slice(&t.wallet_id.to_be_bytes());
    r.push(0x01); // include_wallet_op
    r.extend_from_slice(&t.seqno.to_be_bytes());
    r.extend_from_slice(&t.valid_until.to_be_bytes());
    r.extend_from_slice(&varuint(u128::from(t.amount)));
    r.push(t.destination.workchain as u8);
    r.extend_from_slice(&t.destination.hash);
    r.push(u8::from(t.bounce));
    r.push(t.mode);
    r.push(0x00); // no StateInit in the internal message
    let mut payload = |cell: Cell, hint: u32, data: &[u8]| {
        r.push(0x01);
        r.extend_from_slice(&cell.repr_depth().to_be_bytes());
        r.extend_from_slice(&cell.repr_hash().0);
        r.push(0x01);
        r.extend_from_slice(&hint.to_be_bytes());
        r.extend_from_slice(&(data.len() as u16).to_be_bytes());
        r.extend_from_slice(data);
    };
    match (&t.jetton, &t.comment) {
        (Some(j), _) => {
            let wallet = ton_wallet_address(public_key, t.wallet_id)?;
            let hint = j.ledger_hint(&t.destination, &wallet, testnet)?;
            payload(j.cell()?, HW_HINT_JETTON, &hint);
        }
        (None, Some(c)) => {
            ton_hw_check_comment(c)?;
            payload(comment_cell(c)?, HW_HINT_COMMENT, c.as_bytes());
        }
        (None, None) => r.extend_from_slice(&[0x00, 0x00]), // no payload, no hints
    }
    Ok((r, t.signing_hash()?))
}

/// Signed transfer from a Ledger answer: hash must be Kyro's, sig `verify_strict`, then checked.
pub fn ton_hw_signed(
    boc_b64: &str,
    public_key: &[u8; 32],
    testnet: bool,
    signature: &[u8],
    hash: &[u8],
) -> Result<TonSigned> {
    let (t, sig) = TonTransfer::decode(boc_b64, public_key, ton_wallet_id(testnet))?;
    if sig != [0u8; 64] {
        return Err(Error::input("this TON transfer is already signed"));
    }
    let expected = t.signing_hash()?;
    if hash != expected {
        return Err(Error::crypto(
            "the Ledger signed a different message from the one Kyro prepared",
        ));
    }
    let sig: [u8; 64] = signature
        .try_into()
        .map_err(|_| Error::crypto("device signature: 64 bytes expected"))?;
    let key = ed25519_dalek::VerifyingKey::from_bytes(public_key)
        .map_err(|_| Error::input("invalid TON public key"))?;
    key.verify_strict(&expected, &ed25519_dalek::Signature::from_bytes(&sig))
        .map_err(|_| Error::crypto("invalid device signature"))?;
    let (boc, h) = t.encode_signed(&sig)?;
    let (_, hash_hex, normalized) = ton_verify_signed(&boc, public_key, testnet)?;
    if hash_hex != hex::encode(h) {
        return Err(Error::crypto("inconsistent signed message hash"));
    }
    Ok(TonSigned {
        boc,
        hash: hash_hex,
        normalized_hash: normalized,
        summary: summarize(&t, testnet)?,
    })
}

#[cfg(test)]
mod tests {
    //! Trust Wallet Core vectors from raw private keys (via the private `sign_with`).
    use super::*;

    fn key(hex_key: &str) -> ed25519_dalek::SigningKey {
        ed25519_dalek::SigningKey::from_bytes(&hex::decode(hex_key).unwrap().try_into().unwrap())
    }

    fn root_hash(boc_b64: &str) -> [u8; 32] {
        decode_boc_b64(boc_b64).unwrap().1.repr_hash().0
    }

    fn transfer(
        k: &ed25519_dalek::SigningKey,
        dest: &str,
        seqno: u32,
        valid_until: u32,
    ) -> TonTransfer {
        let d = ton_parse_address(dest).unwrap();
        TonTransfer {
            public_key: k.verifying_key().to_bytes(),
            wallet_id: TON_WALLET_ID_MAINNET,
            valid_until,
            seqno,
            mode: TON_MODE_PAY_FEES,
            destination: d.address,
            bounce: d.bounceable,
            amount: 10,
            comment: None,
            with_state_init: seqno == 0,
            jetton: None,
            inline_empty_body: false,
        }
    }

    #[test]
    fn crc16_xmodem_check_value() {
        assert_eq!(crc16(b"123456789"), 0x31C3);
    }

    #[test]
    fn v4r2_code_is_the_official_one() {
        assert_eq!(
            hex::encode(v4r2_code().unwrap().repr_hash().0),
            TON_V4R2_CODE_HASH
        );
    }

    #[test]
    fn twc_transfer_and_deploy() {
        // test_ton_sign_transfer_and_deploy: https://tonviewer.com/transaction/6ZzWOFKZt_m3kZjbwfbATwLaVwmUOdDp0xjhuY7PO3k=
        let k = key("63474e5fe9511f1526a50567ce142befc343e71a49b865ac3908f58667319cb8");
        // Seqno 0: Trust Wallet ignores `expire_at` and signs `valid_until = 0xFFFFFFFF`.
        let t = transfer(
            &k,
            "EQDYW_1eScJVxtitoBRksvoV9cCYo4uKGWLVNIHB1JqRR3n0",
            0,
            u32::MAX,
        );
        let s = sign_with(&k, &t, false).unwrap();
        let expected = "te6cckECGgEAA7IAAkWIAM33x4uAd+uQTyXyCZPxflESlNVHpCeoOECtNsqVW9tmHgECAgE0AwQBnOfG8YGGhFeE+iDE1jxCYeWKElbGDm3oqm2pwAhmVWSzWv5n6vVq8JY0J6p4sL+hqJU3iYPH8TX5mGLfcbbmtwgpqaMX/////wAAAAAAAwUBFP8A9KQT9LzyyAsGAFEAAAAAKamjF/Qsd/kxvqIOxdAVBzEna7suKGCUdmEkWyMZ74Ez7o1BQAFiYgBsLf6vJOEq42xW0AoyWX0K+uBMUcXFDLFqmkDg6k1Io4hQAAAAAAAAAAAAAAAAAQcCASAICQAAAgFICgsE+PKDCNcYINMf0x/THwL4I7vyZO1E0NMf0x/T//QE0VFDuvKhUVG68qIF+QFUEGT5EPKj+AAkpMjLH1JAyx9SMMv/UhD0AMntVPgPAdMHIcAAn2xRkyDXSpbTB9QC+wDoMOAhwAHjACHAAuMAAcADkTDjDQOkyMsfEssfy/8MDQ4PAubQAdDTAyFxsJJfBOAi10nBIJJfBOAC0x8hghBwbHVnvSKCEGRzdHK9sJJfBeAD+kAwIPpEAcjKB8v/ydDtRNCBAUDXIfQEMFyBAQj0Cm+hMbOSXwfgBdM/yCWCEHBsdWe6kjgw4w0DghBkc3RyupJfBuMNEBECASASEwBu0gf6ANTUIvkABcjKBxXL/8nQd3SAGMjLBcsCIs8WUAX6AhTLaxLMzMlz+wDIQBSBAQj0UfKnAgBwgQEI1xj6ANM/yFQgR4EBCPRR8qeCEG5vdGVwdIAYyMsFywJQBs8WUAT6AhTLahLLH8s/yXP7AAIAbIEBCNcY+gDTPzBSJIEBCPRZ8qeCEGRzdHJwdIAYyMsFywJQBc8WUAP6AhPLassfEss/yXP7AAAK9ADJ7VQAeAH6APQEMPgnbyIwUAqhIb7y4FCCEHBsdWeDHrFwgBhQBMsFJs8WWPoCGfQAy2kXyx9SYMs/IMmAQPsABgCKUASBAQj0WTDtRNCBAUDXIMgBzxb0AMntVAFysI4jghBkc3Rygx6xcIAYUAXLBVADzxYj+gITy2rLH8s/yYBA+wCSXwPiAgEgFBUAWb0kK29qJoQICga5D6AhhHDUCAhHpJN9KZEM5pA+n/mDeBKAG3gQFImHFZ8xhAIBWBYXABG4yX7UTQ1wsfgAPbKd+1E0IEBQNch9AQwAsjKB8v/ydABgQEI9ApvoTGACASAYGQAZrc52omhAIGuQ64X/wAAZrx32omhAEGuQ64WPwJiaP4Q=";
        assert_eq!(root_hash(&s.boc), root_hash(expected));
        assert_eq!(
            s.hash,
            "b3d9462c13a8c67e19b62002447839c386de51415ace3ff6473b1e6294299819"
        );
        assert!(s.summary.deploys_wallet && s.summary.bounce);
        // Round-trips; Trust Wallet's BOC is refused as non-canonical, never misread.
        let (back, sig) = TonTransfer::decode(
            &t.encode_unsigned().unwrap(),
            &t.public_key,
            TON_WALLET_ID_MAINNET,
        )
        .unwrap();
        assert_eq!((back, sig), (t.clone(), [0; 64]));
        let (signed, _, _) = ton_verify_signed(&s.boc, &t.public_key, false).unwrap();
        assert_eq!(signed, t);
    }

    #[test]
    fn twc_ordinary_and_comments() {
        let k = key("c38f49de2fb13223a9e7d37d5d0ffbdd89a5eb7c8b0ee4d1c299f2cefe7dc4a0");
        let dest = "EQBm--PFwDv1yCeS-QTJ-L8oiUpqo9IT1BwgVptlSq3ts90Q";
        let cases: [(u32, u32, Option<&str>, &str, &str); 3] = [
            // test_ton_sign_transfer_ordinary
            (6, 1671132440, None,
             "te6ccgICAAQAAQAAALAAAAFFiAGwt/q8k4SrjbFbQCjJZfQr64ExRxcUMsWqaQODqTUijgwAAQGcEUPkil2aZ4s8KKparSep/OKHMC8vuXafFbW2HGp/9AcTRv0J5T4dwyW1G0JpHw+g5Ov6QI3Xo0O9RFr3KidICimpoxdjm3UYAAAABgADAAIBYmIAM33x4uAd+uQTyXyCZPxflESlNVHpCeoOECtNsqVW9tmIUAAAAAAAAAAAAAAAAAEAAwAA",
             "3908cf8b570c1d3d261c62620c9f368db11f6e821a07614cff64de2e7319f81b"),
            // test_ton_sign_transfer_with_ascii_comment
            (10, 1681102222, Some("test comment"),
             "te6ccgICAAQAAQAAAMAAAAFFiAGwt/q8k4SrjbFbQCjJZfQr64ExRxcUMsWqaQODqTUijgwAAQGcY4XlvKqu7spxyjL6vyBSKjbskDgqkHhqBsdTe900RGrzExtpvwc04j94v8HOczEWSMCXjTXk0z+CVUXSL54qCimpoxdkM5WOAAAACgADAAIBYmIAM33x4uAd+uQTyXyCZPxflESlNVHpCeoOECtNsqVW9tmIUAAAAAAAAAAAAAAAAAEAAwAgAAAAAHRlc3QgY29tbWVudA==",
             "a8c6943d5587f590c43fcdb0e894046f1965c615e19bcaf0c8407e9ccb74518d"),
            // test_ton_sign_transfer_with_utf8_comment
            (11, 1681102222, Some("тестовый комментарий"),
             "te6ccgICAAQAAQAAANsAAAFFiAGwt/q8k4SrjbFbQCjJZfQr64ExRxcUMsWqaQODqTUijgwAAQGchoDa7EdGQuPuehHy3+0X9WNVEvYxdBtaEWn15oYUX8PEKyzztYy94Xq0T2XdhVvj2H7PTSQ+D/Ny1IBRCxk0BimpoxdkM5WOAAAACwADAAIBYmIAM33x4uAd+uQTyXyCZPxflESlNVHpCeoOECtNsqVW9tmIUAAAAAAAAAAAAAAAAAEAAwBWAAAAANGC0LXRgdGC0L7QstGL0Lkg0LrQvtC80LzQtdC90YLQsNGA0LjQuQ==",
             "1091dfae81583d3972825633592c24eab0d3d74c91f60fda9d4afe7535103633"),
        ];
        for (seqno, until, comment, boc, hash) in cases {
            let mut t = transfer(&k, dest, seqno, until);
            t.comment = comment.map(str::to_owned);
            let s = sign_with(&k, &t, false).unwrap();
            assert_eq!(root_hash(&s.boc), root_hash(boc), "seqno {seqno}");
            assert_eq!(s.hash, hash, "seqno {seqno}");
            assert_eq!(s.summary.comment.as_deref(), comment);
            let (v, h, _) = ton_verify_signed(&s.boc, &t.public_key, false).unwrap();
            assert_eq!((v, h), (t.clone(), hash.to_owned()));
        }
    }

    /// USD₮ transfer: the request carries the body's cell ref and the app's known-jetton hint,
    /// byte for byte what `src/transaction/transaction_hints.c` reads back.
    #[test]
    fn ledger_jetton_request() {
        let k = key("c38f49de2fb13223a9e7d37d5d0ffbdd89a5eb7c8b0ee4d1c299f2cefe7dc4a0");
        let pk = k.verifying_key().to_bytes();
        let me = ton_wallet_address(&pk, TON_WALLET_ID_MAINNET).unwrap();
        let to = ton_parse_address("EQBm--PFwDv1yCeS-QTJ-L8oiUpqo9IT1BwgVptlSq3ts90Q")
            .unwrap()
            .address;
        let master = ton_known_jettons(false)[0].master;
        let mut t = transfer(
            &k,
            "EQBm--PFwDv1yCeS-QTJ-L8oiUpqo9IT1BwgVptlSq3ts90Q",
            6,
            1671132440,
        );
        t.destination = ton_jetton_wallet_address(&master, &me, false).unwrap();
        t.amount = TON_JETTON_ATTACHED_NANOTON;
        let body = TonJettonBody {
            query_id: 1671132440,
            amount: 12_500_000,
            destination: to,
            response_destination: me,
            forward_ton_amount: TON_JETTON_FORWARD_NANOTON,
            comment: None,
        };
        t.jetton = Some(body.clone());
        let boc = t.encode_unsigned().unwrap();
        let (req, hash) = ton_hw_request(&boc, &pk, false).unwrap();
        let cell = body.cell().unwrap();
        let hint = format!(
            "03{:016x}0000{}03bebc20{}{}{}{}{}",
            1671132440u64,
            "00",
            format_args!("00{}", hex::encode(to.hash)),
            format_args!("00{}", hex::encode(me.hash)),
            "00",
            "0101",
            "00",
        );
        let tail = format!(
            "0001{:04x}{}01{:08x}{:04x}{hint}",
            cell.repr_depth(),
            hex::encode(cell.repr_hash().0),
            1,
            hint.len() / 2,
        );
        assert!(hex::encode(&req).ends_with(&tail), "{}", hex::encode(&req));
        assert_eq!(hash, t.signing_hash().unwrap());
        // The value of the message is the 0.05 attached to the jetton wallet, not the tokens.
        assert_eq!(&req[14..19], &[4, 0x02, 0xfa, 0xf0, 0x80]);
        let s = ton_hw_signed(&boc, &pk, false, &k.sign(&hash).to_bytes(), &hash).unwrap();
        let j = s.summary.jetton.unwrap();
        assert_eq!((j.symbol.as_str(), j.amount.as_str()), ("USDT", "12500000"));

        // A comment would be a mere hash on the screen; a foreign contract is no known jetton.
        let mut c = t.clone();
        c.jetton = Some(TonJettonBody {
            comment: Some("hello".into()),
            ..body.clone()
        });
        let e = ton_hw_request(&c.encode_unsigned().unwrap(), &pk, false).unwrap_err();
        assert!(e.to_string().contains("cannot show"), "{e}");
        let mut other = t.clone();
        other.destination = to;
        assert!(other
            .encode_unsigned()
            .and_then(|b| ton_hw_request(&b, &pk, false))
            .is_err());
    }

    #[test]
    fn ledger_request_and_signature() {
        let k = key("c38f49de2fb13223a9e7d37d5d0ffbdd89a5eb7c8b0ee4d1c299f2cefe7dc4a0");
        let pk = k.verifying_key().to_bytes();
        let mut t = transfer(
            &k,
            "EQBm--PFwDv1yCeS-QTJ-L8oiUpqo9IT1BwgVptlSq3ts90Q",
            6,
            1671132440,
        );
        // Software layout (empty body in a reference): not what the app rebuilds.
        assert!(ton_hw_request(&t.encode_unsigned().unwrap(), &pk, false).is_err());
        t.inline_empty_body = true;
        let boc = t.encode_unsigned().unwrap();
        let (req, hash) = ton_hw_request(&boc, &pk, false).unwrap();
        // tag 1, wallet id, op, seqno, timeout, varuint(10), addr, bounce, mode 3 (TRANSACTION.md).
        assert_eq!(
            hex::encode(&req),
            format!(
                "01{:08x}01{:08x}{:08x}010a00{}0103000000",
                TON_WALLET_ID_MAINNET,
                6,
                1671132440,
                hex::encode(t.destination.hash)
            )
        );
        assert_eq!(hash, t.signing_hash().unwrap());
        let sig = k.sign(&hash).to_bytes();
        let s = ton_hw_signed(&boc, &pk, false, &sig, &hash).unwrap();
        ton_verify_signed(&s.boc, &pk, false).unwrap();
        assert!(ton_hw_signed(&boc, &pk, false, &sig, &[0; 32]).is_err());
        let mut bad = sig;
        bad[0] ^= 1;
        assert!(ton_hw_signed(&boc, &pk, false, &bad, &hash).is_err());
        // Testnet: other wallet id, refused on mainnet.
        assert!(ton_hw_request(&boc, &pk, true).is_err());

        // With a comment: payload cell ref + comment hint.
        t.inline_empty_body = false;
        t.comment = Some("test comment".into());
        let boc = t.encode_unsigned().unwrap();
        let (req, hash) = ton_hw_request(&boc, &pk, false).unwrap();
        let cell = comment_cell("test comment").unwrap();
        let tail = format!(
            "0300010000{}0100000000000c{}",
            hex::encode(cell.repr_hash().0),
            hex::encode("test comment")
        );
        assert!(hex::encode(&req).ends_with(&tail), "{}", hex::encode(&req));
        let s = ton_hw_signed(&boc, &pk, false, &k.sign(&hash).to_bytes(), &hash).unwrap();
        assert_eq!(s.summary.comment.as_deref(), Some("test comment"));
        // The app only shows printable ASCII.
        t.comment = Some("тест".into());
        assert!(ton_hw_request(&t.encode_unsigned().unwrap(), &pk, false).is_err());
        assert!(ton_hw_check_comment(&"a".repeat(121)).is_err());
        assert_eq!(varuint(1 << 70), [&[9u8, 0x40][..], &[0; 8]].concat());
        assert_eq!(varuint(0), vec![0]);
        assert_eq!(varuint(0x0100), vec![2, 1, 0]);
    }

    #[test]
    fn twc_all_balance() {
        // all_balance/_non_bounceable: Kyro only emits mode 130, so compare cell layout only.
        let k = key("c38f49de2fb13223a9e7d37d5d0ffbdd89a5eb7c8b0ee4d1c299f2cefe7dc4a0");
        let mut t = transfer(
            &k,
            "EQBm--PFwDv1yCeS-QTJ-L8oiUpqo9IT1BwgVptlSq3ts90Q",
            7,
            1681102222,
        );
        t.mode = TON_MODE_ALL_BALANCE;
        t.amount = 0;
        let s = sign_with(&k, &t, false).unwrap();
        assert!(s.summary.send_all && s.summary.amount == "0");
        t.amount = 10;
        assert!(t.encode_unsigned().is_err(), "mode 130 with a value");
        t.mode = 128;
        t.amount = 0;
        assert!(t.encode_unsigned().is_err(), "mode 128 alone");
    }
}
