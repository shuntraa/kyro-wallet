//! Cardano: CIP-0003 Icarus root, CIP-1852 paths (BIP32-Ed25519 V2), CIP-19 addresses,
//! Conway bodies for payments (ADA, tokens, CIP-20 memo) and own-key staking (certs 7/8/2/9).

use bitcoin::bech32::{self, primitives::decode::CheckedHrpstring, Bech32, Hrp};
use blake2::digest::{consts::U28, consts::U32, Digest};
use blake2::Blake2b;
use ed25519_bip32::{DerivationScheme, XPrv};
use ed25519_dalek::hazmat::{raw_sign, ExpandedSecretKey};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::display::sanitize_text;
use crate::error::{Error, Result};
use crate::mnemonic::Mnemonic;
use crate::network::Network;

const HARDENED: u32 = 0x8000_0000;
/// CIP-1852 purpose and Cardano coin type.
const PURPOSE: u32 = 1852;
const COIN: u32 = 1815;
const ROLE_EXTERNAL: u32 = 0;
const ROLE_STAKE: u32 = 2;
const MAX_TX: usize = 16_384;
/// CIP-20 transaction message label.
const CIP20_LABEL: u64 = 674;
/// A CIP-20 line is at most 64 bytes, hence at most 64 characters.
const MAX_CIP20_LINE: usize = 64;
const MAX_TOKEN_NAME: usize = 32;
const HIGH_FEE: u64 = 5_000_000;

fn blake2b224(data: &[u8]) -> [u8; 28] {
    Blake2b::<U28>::digest(data).into()
}

/// blake2b-256.
pub fn cardano_blake2b256(data: &[u8]) -> [u8; 32] {
    Blake2b::<U32>::digest(data).into()
}

/// Icarus root key (`XPrv`, 96 bytes: kL ‖ kR ‖ chain code), erased on drop.
pub struct CardanoRoot(XPrv);

impl core::fmt::Debug for CardanoRoot {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("CardanoRoot(…)")
    }
}

impl CardanoRoot {
    /// CIP-0003 Icarus: PBKDF2-HMAC-SHA512(passphrase, entropy, 4096, 96 B) then clamping.
    pub fn from_mnemonic(mnemonic: &Mnemonic, passphrase: &str) -> CardanoRoot {
        let entropy = mnemonic.entropy();
        let mut out = Zeroizing::new([0u8; 96]);
        pbkdf2::pbkdf2_hmac::<sha2::Sha512>(passphrase.as_bytes(), &entropy, 4096, &mut out[..]);
        // Clamp in place: `normalize_bytes_force3rd` by value would leave an unerased root copy.
        out[0] &= 0b1111_1000;
        out[31] &= 0b0001_1111;
        out[31] |= 0b0100_0000;
        // Only checks length and the clamping set above: cannot fail here.
        #[allow(clippy::expect_used)]
        let root = XPrv::from_slice_verified(&out[..]).expect("clamped 96-byte key");
        CardanoRoot(root)
    }

    /// The 96-byte root key, hex (tests only: compared with CIP-0003 vectors).
    #[doc(hidden)]
    pub fn to_hex_for_tests(&self) -> String {
        hex::encode(self.0.as_ref())
    }

    fn derive(&self, path: &[u32]) -> XPrv {
        let mut k = self.0.clone();
        for i in path {
            k = k.derive(DerivationScheme::V2, *i);
        }
        k
    }

    fn account(&self, account: u32) -> Result<XPrv> {
        if account >= HARDENED {
            return Err(Error::input("account number too large"));
        }
        Ok(self.derive(&[PURPOSE | HARDENED, COIN | HARDENED, account | HARDENED]))
    }

    fn key(&self, account: u32, role: u32, index: u32) -> Result<XPrv> {
        if index >= HARDENED {
            return Err(Error::input("address index too large"));
        }
        Ok(self
            .account(account)?
            .derive(DerivationScheme::V2, role)
            .derive(DerivationScheme::V2, index))
    }
}

fn public(k: &XPrv) -> [u8; 32] {
    k.public().public_key()
}

/// Path `m/1852'/1815'/account'` (payment key `…/0/0`, stake key `…/2/0`).
pub fn cardano_account_path(account: u32) -> String {
    format!("m/1852'/1815'/{account}'")
}

/// Account-level extended public key `m/1852'/1815'/account'`: public key ‖ chain code, hex.
pub fn cardano_account_xpub(root: &CardanoRoot, account: u32) -> Result<String> {
    let x = root.account(account)?.public();
    Ok(format!(
        "{}{}",
        hex::encode(x.public_key()),
        hex::encode(x.chain_code())
    ))
}

fn network_id(net: Network) -> u8 {
    match net {
        Network::Mainnet => 1,
        Network::Testnet => 0,
    }
}

fn hrp(net: Network) -> &'static str {
    match net {
        Network::Mainnet => "addr",
        Network::Testnet => "addr_test",
    }
}

fn bech32_encode(hrp_s: &str, data: &[u8]) -> Result<String> {
    let h = Hrp::parse(hrp_s).map_err(|_| Error::crypto("bech32 prefix"))?;
    bech32::encode::<Bech32>(h, data).map_err(|_| Error::crypto("bech32 encoding failed"))
}

/// Base address (type 0: payment key hash ‖ stake key hash) from two Ed25519 public keys.
pub fn cardano_base_address(
    net: Network,
    payment_pk: &[u8; 32],
    stake_pk: &[u8; 32],
) -> Result<String> {
    let mut b = Vec::with_capacity(57);
    b.push(network_id(net));
    b.extend_from_slice(&blake2b224(payment_pk));
    b.extend_from_slice(&blake2b224(stake_pk));
    bech32_encode(hrp(net), &b)
}

/// Enterprise address (type 6: payment key hash only).
pub fn cardano_enterprise_address(net: Network, payment_pk: &[u8; 32]) -> Result<String> {
    let mut b = Vec::with_capacity(29);
    b.push(0x60 | network_id(net));
    b.extend_from_slice(&blake2b224(payment_pk));
    bech32_encode(hrp(net), &b)
}

/// Reward (stake) address (type 14) of a stake public key.
pub fn cardano_stake_address(net: Network, stake_pk: &[u8; 32]) -> Result<String> {
    let mut b = Vec::with_capacity(29);
    b.push(0xE0 | network_id(net));
    b.extend_from_slice(&blake2b224(stake_pk));
    bech32_encode(
        match net {
            Network::Mainnet => "stake",
            Network::Testnet => "stake_test",
        },
        &b,
    )
}

/// Base address at `m/1852'/1815'/account'/0/index` with the stake key `…/2/0`.
pub fn cardano_address(
    root: &CardanoRoot,
    net: Network,
    account: u32,
    index: u32,
) -> Result<String> {
    let pay = public(&root.key(account, ROLE_EXTERNAL, index)?);
    let stake = public(&root.key(account, ROLE_STAKE, 0)?);
    cardano_base_address(net, &pay, &stake)
}

/// Ed25519 public key of the payment key `m/1852'/1815'/account'/0/index` (witness check).
pub fn cardano_payment_public_key(
    root: &CardanoRoot,
    account: u32,
    index: u32,
) -> Result<[u8; 32]> {
    Ok(public(&root.key(account, ROLE_EXTERNAL, index)?))
}

/// Stake (reward) address of the account (`…/2/0`).
pub fn cardano_account_stake_address(
    root: &CardanoRoot,
    net: Network,
    account: u32,
) -> Result<String> {
    cardano_stake_address(net, &public(&root.key(account, ROLE_STAKE, 0)?))
}

/// Raw bytes of a recipient address valid for `net`.
pub fn cardano_address_bytes(address: &str, net: Network) -> Result<Vec<u8>> {
    let a = address.trim();
    if a.starts_with("Ae2") || a.starts_with("DdzFF") || a.starts_with("37btjrVyb4K") {
        return Err(Error::input(
            "Byron addresses are not supported: ask the recipient for a Shelley address (addr1…)",
        ));
    }
    let checked =
        CheckedHrpstring::new::<Bech32>(a).map_err(|_| Error::input("invalid Cardano address"))?;
    let h = checked.hrp();
    let data: Vec<u8> = checked.byte_iter().collect();
    if h.as_str() != hrp(net) {
        return Err(Error::input(
            "Cardano address from another network, or not a payment address",
        ));
    }
    check_address_bytes(&data, net)?;
    Ok(data)
}

fn check_address_bytes(data: &[u8], net: Network) -> Result<()> {
    let header = *data.first().ok_or_else(|| Error::input("empty address"))?;
    let (kind, nid) = (header >> 4, header & 0x0F);
    if nid != network_id(net) {
        return Err(Error::input("Cardano address from another network"));
    }
    match (kind, data.len()) {
        (0 | 2, 57) | (6, 29) => Ok(()),
        (1 | 3 | 7, _) => Err(Error::input(
            "script addresses refused: a payment without a datum could lock the funds",
        )),
        (4 | 5, _) => Err(Error::input("obsolete pointer addresses (Conway): refused")),
        (14 | 15, _) => Err(Error::input(
            "a staking address (stake…) cannot receive a payment",
        )),
        (8, _) => Err(Error::input("Byron addresses are not supported")),
        _ => Err(Error::input("malformed Cardano address")),
    }
}

/// bech32 form of raw address bytes (for display), or `None` for an unsupported type.
pub fn cardano_address_string(data: &[u8], net: Network) -> Option<String> {
    check_address_bytes(data, net).ok()?;
    bech32_encode(hrp(net), data).ok()
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Cbor {
    Uint(u64),
    Bytes(Vec<u8>),
    Text(String),
    Array(Vec<Cbor>),
    Map(Vec<(Cbor, Cbor)>),
    Tag(u64, Box<Cbor>),
    True,
    Null,
}

fn bad(msg: impl Into<String>) -> Error {
    Error::input(format!("Cardano transaction: {}", msg.into()))
}

fn put_head(out: &mut Vec<u8>, major: u8, v: u64) {
    let m = major << 5;
    if v < 24 {
        out.push(m | v as u8);
    } else if v <= 0xFF {
        out.extend_from_slice(&[m | 24, v as u8]);
    } else if v <= 0xFFFF {
        out.push(m | 25);
        out.extend_from_slice(&(v as u16).to_be_bytes());
    } else if v <= 0xFFFF_FFFF {
        out.push(m | 26);
        out.extend_from_slice(&(v as u32).to_be_bytes());
    } else {
        out.push(m | 27);
        out.extend_from_slice(&v.to_be_bytes());
    }
}

impl Cbor {
    fn encode(&self, out: &mut Vec<u8>) {
        match self {
            Cbor::Uint(v) => put_head(out, 0, *v),
            Cbor::Bytes(b) => {
                put_head(out, 2, b.len() as u64);
                out.extend_from_slice(b);
            }
            Cbor::Text(t) => {
                put_head(out, 3, t.len() as u64);
                out.extend_from_slice(t.as_bytes());
            }
            Cbor::Array(a) => {
                put_head(out, 4, a.len() as u64);
                for x in a {
                    x.encode(out);
                }
            }
            Cbor::Map(m) => {
                put_head(out, 5, m.len() as u64);
                for (k, v) in m {
                    k.encode(out);
                    v.encode(out);
                }
            }
            Cbor::Tag(t, x) => {
                put_head(out, 6, *t);
                x.encode(out);
            }
            Cbor::True => out.push(0xF5),
            Cbor::Null => out.push(0xF6),
        }
    }

    fn to_vec(&self) -> Vec<u8> {
        let mut v = Vec::new();
        self.encode(&mut v);
        v
    }

    fn decode(b: &mut &[u8], depth: usize) -> Result<Cbor> {
        if depth > 16 {
            return Err(bad("nesting too deep"));
        }
        let (&first, rest) = b.split_first().ok_or_else(|| bad("truncated"))?;
        *b = rest;
        let (major, info) = (first >> 5, first & 0x1F);
        if major == 7 {
            return match info {
                21 => Ok(Cbor::True),
                22 => Ok(Cbor::Null),
                _ => Err(bad("simple value or float not supported")),
            };
        }
        let v = match info {
            0..=23 => u64::from(info),
            24..=27 => {
                let n = 1usize << (info - 24);
                if b.len() < n {
                    return Err(bad("truncated"));
                }
                let mut x = 0u64;
                for byte in &b[..n] {
                    x = (x << 8) | u64::from(*byte);
                }
                *b = &b[n..];
                x
            }
            31 => return Err(bad("indefinite lengths refused")),
            _ => return Err(bad("reserved CBOR value")),
        };
        let len = |v: u64, b: &[u8]| -> Result<usize> {
            let l = usize::try_from(v).map_err(|_| bad("length"))?;
            if l > b.len() {
                return Err(bad("truncated"));
            }
            Ok(l)
        };
        Ok(match major {
            0 => Cbor::Uint(v),
            1 => return Err(bad("negative integers refused")),
            2 => {
                let l = len(v, b)?;
                let x = b[..l].to_vec();
                *b = &b[l..];
                Cbor::Bytes(x)
            }
            3 => {
                let l = len(v, b)?;
                let x =
                    String::from_utf8(b[..l].to_vec()).map_err(|_| bad("invalid UTF-8 text"))?;
                *b = &b[l..];
                Cbor::Text(x)
            }
            4 => {
                let n = len(v, b)?;
                let mut a = Vec::with_capacity(n);
                for _ in 0..n {
                    a.push(Cbor::decode(b, depth + 1)?);
                }
                Cbor::Array(a)
            }
            5 => {
                let n = len(v, b)?;
                let mut m = Vec::with_capacity(n);
                for _ in 0..n {
                    let k = Cbor::decode(b, depth + 1)?;
                    let x = Cbor::decode(b, depth + 1)?;
                    m.push((k, x));
                }
                Cbor::Map(m)
            }
            6 => Cbor::Tag(v, Box::new(Cbor::decode(b, depth + 1)?)),
            _ => return Err(bad("unsupported CBOR type")),
        })
    }
}

fn parse_one(raw: &[u8]) -> Result<Cbor> {
    let mut b = raw;
    let c = Cbor::decode(&mut b, 0)?;
    if !b.is_empty() {
        return Err(bad("trailing bytes"));
    }
    if c.to_vec() != raw {
        return Err(bad(
            "non-canonical CBOR (integer or length not in its shortest form)",
        ));
    }
    Ok(c)
}

/// One input.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct CardanoInput {
    /// Transaction id.
    pub tx_hash: [u8; 32],
    /// Output index.
    pub index: u64,
}

/// Native tokens of a value: policy id → (asset name → quantity), in canonical order.
pub type CardanoAssets = Vec<([u8; 28], Vec<(Vec<u8>, u64)>)>;

/// One output (`[address, value]` legacy array form or `{0: address, 1: value}` map form).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CardanoOutput {
    /// Raw address bytes.
    pub address: Vec<u8>,
    /// Lovelace.
    pub coin: u64,
    /// Native tokens.
    pub assets: CardanoAssets,
    /// Post-Alonzo map form (Kyro builds the array form, like CSL for plain outputs).
    pub map_form: bool,
}

/// Governance vote delegation target (CIP-1694 `drep`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CardanoDrep {
    /// A DRep identified by a key hash.
    Key([u8; 28]),
    /// A DRep identified by a script hash.
    Script([u8; 28]),
    /// Predefined "always abstain".
    AlwaysAbstain,
    /// Predefined "always no confidence".
    AlwaysNoConfidence,
}

/// The only certificates Kyro accepts (Conway forms), always for a **key** stake credential.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CardanoCert {
    /// `reg_cert` (7): registers the stake key, paying `deposit` (protocol `keyDeposit`).
    StakeRegistration {
        /// Stake key hash.
        stake: [u8; 28],
        /// Deposit, lovelace.
        deposit: u64,
    },
    /// `unreg_cert` (8): deregisters the stake key, refunding `refund` (the deposit paid).
    StakeDeregistration {
        /// Stake key hash.
        stake: [u8; 28],
        /// Refund, lovelace.
        refund: u64,
    },
    /// `stake_delegation` (2): delegates the stake to `pool`.
    StakeDelegation {
        /// Stake key hash.
        stake: [u8; 28],
        /// Pool key hash.
        pool: [u8; 28],
    },
    /// `vote_deleg_cert` (9): delegates the governance vote to `drep`.
    VoteDelegation {
        /// Stake key hash.
        stake: [u8; 28],
        /// DRep.
        drep: CardanoDrep,
    },
}

impl CardanoCert {
    /// The stake key hash the certificate is about.
    pub fn stake(&self) -> &[u8; 28] {
        match self {
            CardanoCert::StakeRegistration { stake, .. }
            | CardanoCert::StakeDeregistration { stake, .. }
            | CardanoCert::StakeDelegation { stake, .. }
            | CardanoCert::VoteDelegation { stake, .. } => stake,
        }
    }

    fn cbor(&self) -> Cbor {
        let cred = |h: &[u8; 28]| Cbor::Array(vec![Cbor::Uint(0), Cbor::Bytes(h.to_vec())]);
        match self {
            CardanoCert::StakeRegistration { stake, deposit } => {
                Cbor::Array(vec![Cbor::Uint(7), cred(stake), Cbor::Uint(*deposit)])
            }
            CardanoCert::StakeDeregistration { stake, refund } => {
                Cbor::Array(vec![Cbor::Uint(8), cred(stake), Cbor::Uint(*refund)])
            }
            CardanoCert::StakeDelegation { stake, pool } => {
                Cbor::Array(vec![Cbor::Uint(2), cred(stake), Cbor::Bytes(pool.to_vec())])
            }
            CardanoCert::VoteDelegation { stake, drep } => {
                let d = match drep {
                    CardanoDrep::Key(h) => {
                        Cbor::Array(vec![Cbor::Uint(0), Cbor::Bytes(h.to_vec())])
                    }
                    CardanoDrep::Script(h) => {
                        Cbor::Array(vec![Cbor::Uint(1), Cbor::Bytes(h.to_vec())])
                    }
                    CardanoDrep::AlwaysAbstain => Cbor::Array(vec![Cbor::Uint(2)]),
                    CardanoDrep::AlwaysNoConfidence => Cbor::Array(vec![Cbor::Uint(3)]),
                };
                Cbor::Array(vec![Cbor::Uint(9), cred(stake), d])
            }
        }
    }
}

fn hash28(c: &Cbor, what: &str) -> Result<[u8; 28]> {
    match c {
        Cbor::Bytes(b) => b
            .as_slice()
            .try_into()
            .map_err(|_| bad(format!("{what}: 28 bytes expected"))),
        _ => Err(bad(format!("{what}: bytes expected"))),
    }
}

fn cert_name(t: u64) -> &'static str {
    match t {
        0 => "legacy stake key registration (implicit deposit)",
        1 => "legacy deregistration",
        3 => "pool registration",
        4 => "pool retirement",
        5 => "genesis delegation",
        6 => "rewards transfer (MIR)",
        10..=13 => "combined certificate (registration / delegation / vote)",
        14 | 15 => "constitutional committee",
        16..=18 => "DRep registration / update",
        _ => "unknown",
    }
}

fn decode_cert(c: &Cbor) -> Result<CardanoCert> {
    let Cbor::Array(a) = c else {
        return Err(bad("certificate"));
    };
    let Some(Cbor::Uint(t)) = a.first() else {
        return Err(bad("certificate type"));
    };
    let cred = |c: &Cbor| -> Result<[u8; 28]> {
        match c {
            Cbor::Array(x) => match x.as_slice() {
                [Cbor::Uint(0), h] => hash28(h, "stake key"),
                [Cbor::Uint(1), _] => Err(bad(
                    "script stake credential: refused (only your stake key is accepted)",
                )),
                _ => Err(bad("stake credential")),
            },
            _ => Err(bad("stake credential")),
        }
    };
    match (*t, a.as_slice()) {
        (7, [_, s, Cbor::Uint(d)]) => Ok(CardanoCert::StakeRegistration {
            stake: cred(s)?,
            deposit: *d,
        }),
        (8, [_, s, Cbor::Uint(r)]) => Ok(CardanoCert::StakeDeregistration {
            stake: cred(s)?,
            refund: *r,
        }),
        (2, [_, s, p]) => Ok(CardanoCert::StakeDelegation {
            stake: cred(s)?,
            pool: hash28(p, "pool")?,
        }),
        (9, [_, s, Cbor::Array(d)]) => {
            let drep = match d.as_slice() {
                [Cbor::Uint(0), h] => CardanoDrep::Key(hash28(h, "DRep")?),
                [Cbor::Uint(1), h] => CardanoDrep::Script(hash28(h, "DRep")?),
                [Cbor::Uint(2)] => CardanoDrep::AlwaysAbstain,
                [Cbor::Uint(3)] => CardanoDrep::AlwaysNoConfidence,
                _ => return Err(bad("DRep")),
            };
            Ok(CardanoCert::VoteDelegation {
                stake: cred(s)?,
                drep,
            })
        }
        (2 | 7 | 8 | 9, _) => Err(bad("malformed certificate")),
        (other, _) => Err(bad(format!(
            "certificate {other} ({}): refused",
            cert_name(other)
        ))),
    }
}

/// Conway tx body limited to keys 0, 1, 2, 3, 4 (staking), 5, 7 and 8 (shown, never set).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CardanoBody {
    /// Inputs.
    pub inputs: Vec<CardanoInput>,
    /// Inputs encoded as a tag-258 set (Conway) rather than a plain array.
    pub tagged_sets: bool,
    /// Outputs.
    pub outputs: Vec<CardanoOutput>,
    /// Lovelace.
    pub fee: u64,
    /// Slot after which the transaction is invalid.
    pub ttl: Option<u64>,
    /// Certificates (staking), in order; encoded as a tag-258 set when `tagged_sets`.
    pub certs: Vec<CardanoCert>,
    /// Reward withdrawals: `(reward address bytes, lovelace)`.
    pub withdrawals: Vec<(Vec<u8>, u64)>,
    /// blake2b-256 of the auxiliary data.
    pub aux_hash: Option<[u8; 32]>,
    /// Slot before which the transaction is invalid.
    pub validity_start: Option<u64>,
}

fn value_cbor(coin: u64, assets: &CardanoAssets) -> Cbor {
    if assets.is_empty() {
        return Cbor::Uint(coin);
    }
    Cbor::Array(vec![
        Cbor::Uint(coin),
        Cbor::Map(
            assets
                .iter()
                .map(|(p, names)| {
                    (
                        Cbor::Bytes(p.to_vec()),
                        Cbor::Map(
                            names
                                .iter()
                                .map(|(n, q)| (Cbor::Bytes(n.clone()), Cbor::Uint(*q)))
                                .collect(),
                        ),
                    )
                })
                .collect(),
        ),
    ])
}

impl CardanoOutput {
    fn cbor(&self) -> Cbor {
        let value = value_cbor(self.coin, &self.assets);
        if self.map_form {
            Cbor::Map(vec![
                (Cbor::Uint(0), Cbor::Bytes(self.address.clone())),
                (Cbor::Uint(1), value),
            ])
        } else {
            Cbor::Array(vec![Cbor::Bytes(self.address.clone()), value])
        }
    }

    /// Serialized size, for the min-UTxO rule.
    pub fn size(&self) -> usize {
        self.cbor().to_vec().len()
    }
}

/// Babbage/Conway min lovelace: `(160 + size) × coinsPerUTxOByte`, iterated to a fixed point.
pub fn cardano_min_utxo(address: &[u8], assets: &CardanoAssets, coins_per_byte: u64) -> u64 {
    let mut coin = 1_000_000u64;
    for _ in 0..4 {
        let o = CardanoOutput {
            address: address.to_vec(),
            coin,
            assets: assets.clone(),
            map_form: false,
        };
        let need = u64::try_from(o.size())
            .ok()
            .and_then(|size| size.checked_add(160))
            .and_then(|bytes| bytes.checked_mul(coins_per_byte))
            .unwrap_or(u64::MAX);
        if need == coin {
            break;
        }
        coin = need;
    }
    coin
}

impl CardanoBody {
    fn cbor(&self) -> Cbor {
        let inputs: Vec<Cbor> = self
            .inputs
            .iter()
            .map(|i| Cbor::Array(vec![Cbor::Bytes(i.tx_hash.to_vec()), Cbor::Uint(i.index)]))
            .collect();
        let inputs = if self.tagged_sets {
            Cbor::Tag(258, Box::new(Cbor::Array(inputs)))
        } else {
            Cbor::Array(inputs)
        };
        let mut m = vec![
            (Cbor::Uint(0), inputs),
            (
                Cbor::Uint(1),
                Cbor::Array(self.outputs.iter().map(CardanoOutput::cbor).collect()),
            ),
            (Cbor::Uint(2), Cbor::Uint(self.fee)),
        ];
        if let Some(t) = self.ttl {
            m.push((Cbor::Uint(3), Cbor::Uint(t)));
        }
        if !self.certs.is_empty() {
            let list = Cbor::Array(self.certs.iter().map(CardanoCert::cbor).collect());
            m.push((
                Cbor::Uint(4),
                if self.tagged_sets {
                    Cbor::Tag(258, Box::new(list))
                } else {
                    list
                },
            ));
        }
        if !self.withdrawals.is_empty() {
            m.push((
                Cbor::Uint(5),
                Cbor::Map(
                    self.withdrawals
                        .iter()
                        .map(|(a, c)| (Cbor::Bytes(a.clone()), Cbor::Uint(*c)))
                        .collect(),
                ),
            ));
        }
        if let Some(h) = self.aux_hash {
            m.push((Cbor::Uint(7), Cbor::Bytes(h.to_vec())));
        }
        if let Some(v) = self.validity_start {
            m.push((Cbor::Uint(8), Cbor::Uint(v)));
        }
        Cbor::Map(m)
    }

    /// Canonical CBOR of the body.
    pub fn encode(&self) -> Vec<u8> {
        self.cbor().to_vec()
    }

    /// Transaction id: blake2b-256 of the body CBOR.
    pub fn tx_id(&self) -> [u8; 32] {
        cardano_blake2b256(&self.encode())
    }

    fn decode_cbor(c: &Cbor) -> Result<CardanoBody> {
        let Cbor::Map(m) = c else {
            return Err(bad("the body must be a CBOR map"));
        };
        let (mut inputs, mut tagged, mut outputs, mut fee, mut ttl, mut aux, mut start) =
            (None, false, None, None, None, None, None);
        let (mut certs, mut withdrawals) = (Vec::new(), Vec::new());
        for (k, v) in m {
            let Cbor::Uint(k) = k else {
                return Err(bad("body key"));
            };
            match k {
                0 => {
                    let arr = match v {
                        Cbor::Tag(258, inner) => {
                            tagged = true;
                            inner.as_ref()
                        }
                        other => other,
                    };
                    let Cbor::Array(a) = arr else {
                        return Err(bad("inputs"));
                    };
                    let mut list = Vec::with_capacity(a.len());
                    for i in a {
                        match i {
                            Cbor::Array(x) if x.len() == 2 => match (&x[0], &x[1]) {
                                (Cbor::Bytes(h), Cbor::Uint(ix)) if h.len() == 32 => {
                                    let mut tx_hash = [0u8; 32];
                                    tx_hash.copy_from_slice(h);
                                    list.push(CardanoInput {
                                        tx_hash,
                                        index: *ix,
                                    });
                                }
                                _ => return Err(bad("input")),
                            },
                            _ => return Err(bad("input")),
                        }
                    }
                    inputs = Some(list);
                }
                1 => {
                    let Cbor::Array(a) = v else {
                        return Err(bad("outputs"));
                    };
                    outputs = Some(a.iter().map(decode_output).collect::<Result<Vec<_>>>()?);
                }
                2 => match v {
                    Cbor::Uint(f) => fee = Some(*f),
                    _ => return Err(bad("fee")),
                },
                3 => match v {
                    Cbor::Uint(t) => ttl = Some(*t),
                    _ => return Err(bad("ttl")),
                },
                7 => match v {
                    Cbor::Bytes(h) if h.len() == 32 => {
                        let mut x = [0u8; 32];
                        x.copy_from_slice(h);
                        aux = Some(x);
                    }
                    _ => return Err(bad("metadata hash")),
                },
                4 => {
                    let list = match v {
                        Cbor::Tag(258, inner) => inner.as_ref(),
                        other => other,
                    };
                    let Cbor::Array(a) = list else {
                        return Err(bad("certificates"));
                    };
                    if a.is_empty() || a.len() > 8 {
                        return Err(bad("certificate list empty or too long"));
                    }
                    certs = a.iter().map(decode_cert).collect::<Result<Vec<_>>>()?;
                }
                5 => {
                    let Cbor::Map(w) = v else {
                        return Err(bad("withdrawals"));
                    };
                    if w.is_empty() {
                        return Err(bad("empty withdrawal list"));
                    }
                    for (a, c) in w {
                        match (a, c) {
                            (Cbor::Bytes(a), Cbor::Uint(c)) => withdrawals.push((a.clone(), *c)),
                            _ => return Err(bad("withdrawal")),
                        }
                    }
                }
                6 => return Err(bad("protocol parameter updates: refused")),
                8 => match v {
                    Cbor::Uint(t) => start = Some(*t),
                    _ => return Err(bad("validity start")),
                },
                9 => return Err(bad("token minting / burning (mint): refused")),
                11 => return Err(bad("script data hash (Plutus): refused")),
                13 | 16 | 17 => return Err(bad("collateral: refused")),
                14 => return Err(bad("required signers: refused")),
                15 => return Err(bad("network id field not supported")),
                18 => return Err(bad("reference inputs: refused")),
                19 => return Err(bad("votes: refused")),
                20 => return Err(bad("governance proposals: refused")),
                21 | 22 => return Err(bad("treasury donation: refused")),
                other => return Err(bad(format!("unknown body field {other}"))),
            }
        }
        let body = CardanoBody {
            inputs: inputs.ok_or_else(|| bad("inputs missing"))?,
            tagged_sets: tagged,
            outputs: outputs.ok_or_else(|| bad("outputs missing"))?,
            fee: fee.ok_or_else(|| bad("fee missing"))?,
            ttl,
            certs,
            withdrawals,
            aux_hash: aux,
            validity_start: start,
        };
        if &body.cbor() != c {
            return Err(bad("non-canonical body (field order, duplicates)"));
        }
        Ok(body)
    }

    /// Strict decoding of a body (see [`cardano_decode_tx`] for what is refused).
    pub fn decode(raw: &[u8]) -> Result<CardanoBody> {
        CardanoBody::decode_cbor(&parse_one(raw)?)
    }
}

fn decode_value(v: &Cbor) -> Result<(u64, CardanoAssets)> {
    match v {
        Cbor::Uint(c) => Ok((*c, Vec::new())),
        Cbor::Array(a) if a.len() == 2 => {
            let Cbor::Uint(c) = a[0] else {
                return Err(bad("ADA amount"));
            };
            let Cbor::Map(pol) = &a[1] else {
                return Err(bad("multi-asset"));
            };
            let mut assets = Vec::with_capacity(pol.len());
            for (p, names) in pol {
                let (Cbor::Bytes(p), Cbor::Map(names)) = (p, names) else {
                    return Err(bad("multi-asset entry"));
                };
                let policy: [u8; 28] = p
                    .as_slice()
                    .try_into()
                    .map_err(|_| bad("policy id: 28 bytes"))?;
                let mut list = Vec::with_capacity(names.len());
                for (n, q) in names {
                    let (Cbor::Bytes(n), Cbor::Uint(q)) = (n, q) else {
                        return Err(bad("token entry"));
                    };
                    if n.len() > 32 || *q == 0 {
                        return Err(bad("token name longer than 32 bytes, or zero quantity"));
                    }
                    list.push((n.clone(), *q));
                }
                if list.is_empty() {
                    return Err(bad("empty policy"));
                }
                assets.push((policy, list));
            }
            Ok((c, assets))
        }
        _ => Err(bad("amount")),
    }
}

fn decode_output(o: &Cbor) -> Result<CardanoOutput> {
    match o {
        Cbor::Array(a) => match a.as_slice() {
            [Cbor::Bytes(addr), v] => {
                let (coin, assets) = decode_value(v)?;
                Ok(CardanoOutput {
                    address: addr.clone(),
                    coin,
                    assets,
                    map_form: false,
                })
            }
            [_, _, _] => Err(bad("outputs with a datum hash: refused")),
            _ => Err(bad("output")),
        },
        Cbor::Map(m) => {
            let (mut addr, mut val) = (None, None);
            for (k, v) in m {
                match (k, v) {
                    (Cbor::Uint(0), Cbor::Bytes(a)) => addr = Some(a.clone()),
                    (Cbor::Uint(1), v) => val = Some(decode_value(v)?),
                    (Cbor::Uint(2), _) => return Err(bad("outputs with a datum: refused")),
                    (Cbor::Uint(3), _) => {
                        return Err(bad("outputs with a reference script: refused"))
                    }
                    _ => return Err(bad("unknown output field")),
                }
            }
            let (coin, assets) = val.ok_or_else(|| bad("output amount"))?;
            Ok(CardanoOutput {
                address: addr.ok_or_else(|| bad("output address"))?,
                coin,
                assets,
                map_form: true,
            })
        }
        _ => Err(bad("output")),
    }
}

/// CIP-20 auxiliary data: `{674: {"msg": [text ≤ 64 bytes, …]}}` (Shelley metadata form).
pub fn cardano_cip20_aux(message: &str) -> Result<Vec<u8>> {
    let mut lines = Vec::new();
    let mut cur = String::new();
    for ch in message.chars() {
        if cur.len() + ch.len_utf8() > 64 {
            lines.push(Cbor::Text(std::mem::take(&mut cur)));
        }
        cur.push(ch);
    }
    if !cur.is_empty() {
        lines.push(Cbor::Text(cur));
    }
    if lines.is_empty() {
        return Err(Error::input("empty message"));
    }
    if message.len() > 1024 {
        return Err(Error::input("message too long (1,024 bytes max.)"));
    }
    Ok(Cbor::Map(vec![(
        Cbor::Uint(CIP20_LABEL),
        Cbor::Map(vec![(Cbor::Text("msg".into()), Cbor::Array(lines))]),
    )])
    .to_vec())
}

fn decode_cip20(c: &Cbor) -> Result<Vec<String>> {
    let bad_meta = || bad("metadata other than a CIP-20 message: refused");
    let Cbor::Map(m) = c else {
        return Err(bad_meta());
    };
    match m.as_slice() {
        [(Cbor::Uint(CIP20_LABEL), Cbor::Map(inner))] => match inner.as_slice() {
            [(Cbor::Text(k), Cbor::Array(lines))] if k == "msg" && !lines.is_empty() => lines
                .iter()
                .map(|l| match l {
                    Cbor::Text(t) if t.len() <= 64 => Ok(t.clone()),
                    _ => Err(bad_meta()),
                })
                .collect(),
            _ => Err(bad_meta()),
        },
        _ => Err(bad_meta()),
    }
}

fn tx_cbor(body: &Cbor, witnesses: Cbor, aux: Option<&Cbor>) -> Vec<u8> {
    Cbor::Array(vec![
        body.clone(),
        witnesses,
        Cbor::True,
        aux.cloned().unwrap_or(Cbor::Null),
    ])
    .to_vec()
}

/// An unsigned transaction: body (+ CIP-20 auxiliary data), with an empty witness set.
pub fn cardano_unsigned_tx(body: &CardanoBody, aux: Option<&[u8]>) -> Result<Vec<u8>> {
    let aux = aux.map(parse_one).transpose()?;
    Ok(tx_cbor(&body.cbor(), Cbor::Map(Vec::new()), aux.as_ref()))
}

/// Size of the transaction once signed by `keys` distinct keys (fee computation).
pub fn cardano_signed_size(body: &CardanoBody, aux: Option<&[u8]>, keys: usize) -> Result<usize> {
    let aux = aux.map(parse_one).transpose()?;
    let wit: Vec<Cbor> = (0..keys)
        .map(|_| Cbor::Array(vec![Cbor::Bytes(vec![0; 32]), Cbor::Bytes(vec![0; 64])]))
        .collect();
    let set = if body.tagged_sets {
        Cbor::Tag(258, Box::new(Cbor::Array(wit)))
    } else {
        Cbor::Array(wit)
    };
    Ok(tx_cbor(
        &body.cbor(),
        Cbor::Map(vec![(Cbor::Uint(0), set)]),
        aux.as_ref(),
    )
    .len())
}

/// A native token in an output, for display.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardanoTokenView {
    /// Policy id, hex.
    pub policy: String,
    /// Asset name, hex.
    pub name: String,
    /// Asset name as text, when it is printable UTF-8.
    pub name_text: Option<String>,
    /// Quantity, decimal string.
    pub quantity: String,
    /// In the small table of verified tokens Kyro names itself.
    pub verified: bool,
}

/// One output, for display.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardanoOutputView {
    /// bech32.
    pub address: String,
    /// `base` | `enterprise`.
    pub kind: String,
    /// Pays one of our addresses.
    pub is_change: bool,
    /// Lovelace, decimal string.
    pub lovelace: String,
    /// Native tokens.
    pub tokens: Vec<CardanoTokenView>,
    /// Minimum lovelace this output must carry (min-UTxO), decimal string.
    pub min_lovelace: String,
}

/// Reasons for caution (all require the reinforced confirmation).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CardanoWarning {
    /// CIP-20 message (public for ever on chain).
    Memo,
    /// A native token not in Kyro's verified table.
    UnknownToken {
        /// Policy id, hex.
        policy: String,
        /// Asset name, hex.
        name: String,
    },
    /// Fee above 5 ADA.
    HighFee,
    /// No validity limit (ttl absent): the transaction stays valid for ever.
    NoTtl,
    /// A CIP-20 line or token name was cleaned or cut (the hex name is exact).
    UnusualText,
}

/// Plain-language summary of a Cardano payment, decoded by Rust.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardanoTxSummary {
    /// blake2b-256 of the body, hex.
    pub tx_id: String,
    /// `txhash#index`.
    pub inputs: Vec<String>,
    /// Outputs.
    pub outputs: Vec<CardanoOutputView>,
    /// Lovelace, decimal string.
    pub fee: String,
    /// Validity limit (slot).
    pub ttl: Option<u64>,
    /// Not valid before this slot.
    pub valid_from: Option<u64>,
    /// CIP-20 message lines.
    pub memo: Option<Vec<String>>,
    /// Reasons for caution.
    pub warnings: Vec<CardanoWarning>,
    /// The confirmation must be followed by a reinforced one.
    pub requires_extra_confirmation: bool,
}

/// What the caller tells the decoder.
pub struct CardanoContext<'a> {
    /// Network.
    pub net: Network,
    /// Our addresses (bech32): outputs paying them are change.
    pub own: &'a [String],
    /// Verified tokens `(policy hex, asset name hex)`.
    pub verified_tokens: &'a [(&'a str, &'a str)],
    /// Current `coinsPerUTxOByte`, for the min-UTxO shown per output.
    pub coins_per_byte: u64,
}

struct Decoded {
    body: CardanoBody,
    body_cbor: Cbor,
    aux: Option<Cbor>,
    summary: CardanoTxSummary,
}

fn decode_full(
    raw_hex: &str,
    ctx: &CardanoContext<'_>,
    stake: Option<&StakeMode>,
) -> Result<Decoded> {
    let raw = hex::decode(raw_hex.trim())
        .map_err(|_| Error::input("transaction: hexadecimal expected"))?;
    if raw.len() > MAX_TX {
        return Err(bad("too large"));
    }
    let tx = parse_one(&raw)?;
    let Cbor::Array(parts) = &tx else {
        return Err(bad("the transaction must be a CBOR array"));
    };
    let [body_c, wit, valid, aux] = parts.as_slice() else {
        return Err(bad("the transaction must have 4 parts"));
    };
    if wit != &Cbor::Map(Vec::new()) {
        return Err(bad("already signed (witnesses present)"));
    }
    if valid != &Cbor::True {
        return Err(bad("is_valid must be true"));
    }
    let body = CardanoBody::decode_cbor(body_c)?;
    match stake {
        None => {
            if !body.certs.is_empty() {
                return Err(bad(
                    "certificates (staking, delegation): refused in a payment (Staking screen)",
                ));
            }
            if !body.withdrawals.is_empty() {
                return Err(bad(
                    "reward withdrawals: refused in a payment (Staking screen)",
                ));
            }
        }
        Some(s) => {
            if !matches!(aux, Cbor::Null) || body.aux_hash.is_some() {
                return Err(bad("metadata in a staking transaction: refused"));
            }
            check_stake(&body, s, ctx)?;
        }
    }
    let aux = match aux {
        Cbor::Null => None,
        other => Some(other.clone()),
    };
    let memo = match (&aux, body.aux_hash) {
        (None, None) => None,
        (Some(a), Some(h)) => {
            if cardano_blake2b256(&a.to_vec()) != h {
                return Err(bad("the metadata hash does not match"));
            }
            Some(decode_cip20(a)?)
        }
        _ => return Err(bad("the metadata and its hash must be present together")),
    };
    if body.inputs.is_empty() || body.outputs.is_empty() {
        return Err(bad("no inputs or no outputs"));
    }
    // A set: order is free (Kyro sorts its own), duplicates are refused.
    let mut sorted = body.inputs.clone();
    sorted.sort();
    sorted.dedup();
    if sorted.len() != body.inputs.len() {
        return Err(bad("duplicate input"));
    }
    let mut warnings = Vec::new();
    let mut unusual_text = false;
    let memo = memo.map(|lines| {
        lines
            .iter()
            .map(|l| {
                let clean = sanitize_text(l, MAX_CIP20_LINE);
                unusual_text |= clean.altered;
                clean.text
            })
            .collect::<Vec<_>>()
    });
    let mut outputs = Vec::with_capacity(body.outputs.len());
    for o in &body.outputs {
        check_address_bytes(&o.address, ctx.net)?;
        let address = bech32_encode(hrp(ctx.net), &o.address)?;
        let min = cardano_min_utxo(&o.address, &o.assets, ctx.coins_per_byte);
        if o.coin < min {
            return Err(bad(format!(
                "an output carries {} lovelace, below its minimum of {min} (min-UTxO)",
                o.coin
            )));
        }
        let mut tokens = Vec::new();
        for (p, names) in &o.assets {
            let mut prev: Option<&Vec<u8>> = None;
            for (n, q) in names {
                if prev.is_some_and(|x| (x.len(), x) >= (n.len(), n)) {
                    return Err(bad("token names out of canonical order"));
                }
                prev = Some(n);
                let (ph, nh) = (hex::encode(p), hex::encode(n));
                let verified = ctx
                    .verified_tokens
                    .iter()
                    .any(|(vp, vn)| *vp == ph && *vn == nh);
                if !verified {
                    warnings.push(CardanoWarning::UnknownToken {
                        policy: ph.clone(),
                        name: nh.clone(),
                    });
                }
                // Names needing cleaning shown as hex only: a cleaned one could mimic another.
                let name_text = core::str::from_utf8(n)
                    .ok()
                    .filter(|t| !t.is_empty())
                    .and_then(|t| {
                        let clean = sanitize_text(t, MAX_TOKEN_NAME);
                        unusual_text |= clean.altered;
                        (!clean.altered).then_some(clean.text)
                    });
                tokens.push(CardanoTokenView {
                    name_text,
                    policy: ph,
                    name: nh,
                    quantity: q.to_string(),
                    verified,
                });
            }
        }
        for w in o.assets.windows(2) {
            if w[0].0 >= w[1].0 {
                return Err(bad("policies out of canonical order"));
            }
        }
        outputs.push(CardanoOutputView {
            is_change: ctx.own.contains(&address),
            kind: if o.address[0] >> 4 == 6 {
                "enterprise"
            } else {
                "base"
            }
            .into(),
            address,
            lovelace: o.coin.to_string(),
            tokens,
            min_lovelace: min.to_string(),
        });
    }
    if memo.is_some() {
        warnings.push(CardanoWarning::Memo);
    }
    if body.fee > HIGH_FEE {
        warnings.push(CardanoWarning::HighFee);
    }
    if body.ttl.is_none() {
        warnings.push(CardanoWarning::NoTtl);
    }
    if unusual_text {
        warnings.push(CardanoWarning::UnusualText);
    }
    let summary = CardanoTxSummary {
        tx_id: hex::encode(cardano_blake2b256(&body_c.to_vec())),
        inputs: body
            .inputs
            .iter()
            .map(|i| format!("{}#{}", hex::encode(i.tx_hash), i.index))
            .collect(),
        outputs,
        fee: body.fee.to_string(),
        ttl: body.ttl,
        valid_from: body.validity_start,
        memo,
        requires_extra_confirmation: !warnings.is_empty(),
        warnings,
    };
    Ok(Decoded {
        body,
        body_cbor: body_c.clone(),
        aux,
        summary,
    })
}

/// Decodes an **unsigned** transaction (hex) for the dialog.
pub fn cardano_decode_tx(raw_hex: &str, ctx: &CardanoContext<'_>) -> Result<CardanoTxSummary> {
    Ok(decode_full(raw_hex, ctx, None)?.summary)
}

/// Body of a decoded unsigned transaction (for the shell's balance check against UTxOs).
pub fn cardano_tx_body(raw_hex: &str, ctx: &CardanoContext<'_>) -> Result<CardanoBody> {
    Ok(decode_full(raw_hex, ctx, None)?.body)
}

struct StakeMode {
    /// blake2b-224 of our stake public key.
    stake_hash: [u8; 28],
    /// Protocol `keyDeposit` (lovelace): the only deposit a registration may carry.
    key_deposit: u64,
}

/// blake2b-224 (key hash of an Ed25519 public key, pool ids, DRep key ids).
pub fn cardano_blake2b224(data: &[u8]) -> [u8; 28] {
    blake2b224(data)
}

/// Ed25519 public key of the stake key `m/1852'/1815'/account'/2/0`.
pub fn cardano_stake_public_key(root: &CardanoRoot, account: u32) -> Result<[u8; 32]> {
    Ok(public(&root.key(account, ROLE_STAKE, 0)?))
}

/// Reward address bytes (type 14, key credential) of a stake key hash.
pub fn cardano_reward_address_bytes(net: Network, stake_hash: &[u8; 28]) -> Vec<u8> {
    let mut b = Vec::with_capacity(29);
    b.push(0xE0 | network_id(net));
    b.extend_from_slice(stake_hash);
    b
}

fn bech32_bytes(s: &str, hrps: &[&str]) -> Result<(String, Vec<u8>)> {
    let checked = CheckedHrpstring::new::<Bech32>(s.trim())
        .map_err(|_| Error::input(format!("invalid bech32 identifier: {}", s.trim())))?;
    let h = checked.hrp().as_str().to_owned();
    if !hrps.contains(&h.as_str()) {
        return Err(Error::input(format!(
            "unexpected prefix \"{h}\" (expected: {})",
            hrps.join(", ")
        )));
    }
    Ok((h, checked.byte_iter().collect()))
}

/// Pool id from `pool1…` (bech32) or 56 hex characters.
pub fn cardano_pool_id(s: &str) -> Result<[u8; 28]> {
    let t = s.trim();
    let bytes = if t.starts_with("pool1") {
        bech32_bytes(t, &["pool"])?.1
    } else {
        hex::decode(t).map_err(|_| Error::input("pool id: pool1… or 56 hex"))?
    };
    bytes
        .try_into()
        .map_err(|_| Error::input("pool id: 28 bytes expected"))
}

/// `pool1…` form of a pool key hash.
pub fn cardano_pool_bech32(hash: &[u8; 28]) -> Result<String> {
    bech32_encode("pool", hash)
}

/// Parses a DRep: `alwaysAbstain`, `alwaysNoConfidence`, CIP-129 or CIP-105 `drep…` ids.
pub fn cardano_drep_parse(s: &str) -> Result<CardanoDrep> {
    match s.trim() {
        "alwaysAbstain" => return Ok(CardanoDrep::AlwaysAbstain),
        "alwaysNoConfidence" => return Ok(CardanoDrep::AlwaysNoConfidence),
        _ => {}
    }
    let (h, b) = bech32_bytes(s, &["drep", "drep_script"])?;
    let h28 = |x: &[u8]| -> Result<[u8; 28]> {
        x.try_into()
            .map_err(|_| Error::input("DRep id: invalid length"))
    };
    match (h.as_str(), b.len()) {
        ("drep", 29) => match b[0] {
            0x22 => Ok(CardanoDrep::Key(h28(&b[1..])?)),
            0x23 => Ok(CardanoDrep::Script(h28(&b[1..])?)),
            _ => Err(Error::input("DRep id (CIP-129): unknown header")),
        },
        ("drep", 28) => Ok(CardanoDrep::Key(h28(&b)?)),
        ("drep_script", 28) => Ok(CardanoDrep::Script(h28(&b)?)),
        _ => Err(Error::input("DRep id: invalid length")),
    }
}

/// CIP-129 `drep1…` id of a DRep (`None` for the predefined ones).
pub fn cardano_drep_id(d: &CardanoDrep) -> Option<String> {
    let (header, h) = match d {
        CardanoDrep::Key(h) => (0x22u8, h),
        CardanoDrep::Script(h) => (0x23u8, h),
        _ => return None,
    };
    let mut b = vec![header];
    b.extend_from_slice(h);
    bech32_encode("drep", &b).ok()
}

/// A DRep for display.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CardanoDrepView {
    /// Key-hash DRep.
    Key {
        /// CIP-129 `drep1…`.
        id: String,
        /// Key hash, hex.
        hash: String,
    },
    /// Script-hash DRep.
    Script {
        /// CIP-129 `drep1…`.
        id: String,
        /// Script hash, hex.
        hash: String,
    },
    /// Always abstain.
    AlwaysAbstain,
    /// Always no confidence.
    AlwaysNoConfidence,
}

impl From<&CardanoDrep> for CardanoDrepView {
    fn from(d: &CardanoDrep) -> Self {
        let id = cardano_drep_id(d).unwrap_or_default();
        match d {
            CardanoDrep::Key(h) => CardanoDrepView::Key {
                id,
                hash: hex::encode(h),
            },
            CardanoDrep::Script(h) => CardanoDrepView::Script {
                id,
                hash: hex::encode(h),
            },
            CardanoDrep::AlwaysAbstain => CardanoDrepView::AlwaysAbstain,
            CardanoDrep::AlwaysNoConfidence => CardanoDrepView::AlwaysNoConfidence,
        }
    }
}

/// A certificate for display.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CardanoCertView {
    /// Registration of our stake key, deposit paid (lovelace).
    StakeRegistration {
        /// Lovelace.
        deposit: String,
    },
    /// Deregistration of our stake key, deposit refunded (lovelace).
    StakeDeregistration {
        /// Lovelace.
        refund: String,
    },
    /// Delegation to a pool.
    StakeDelegation {
        /// `pool1…`.
        pool_id: String,
        /// Pool key hash, hex.
        pool_hash: String,
    },
    /// Governance vote delegation.
    VoteDelegation {
        /// The DRep.
        drep: CardanoDrepView,
    },
}

/// A reward withdrawal for display.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardanoWithdrawalView {
    /// `stake…` / `stake_test…` (always ours).
    pub reward_address: String,
    /// Lovelace.
    pub lovelace: String,
}

/// Staking tx summary: payment part plus every certificate and withdrawal (our stake key).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardanoStakeSummary {
    /// Inputs, outputs, fee, ttl (no memo: refused in staking transactions).
    pub tx: CardanoTxSummary,
    /// Our reward (stake) address.
    pub stake_address: String,
    /// Certificates, in order.
    pub certificates: Vec<CardanoCertView>,
    /// Reward withdrawals (ours only).
    pub withdrawals: Vec<CardanoWithdrawalView>,
    /// Deposit paid by a registration, lovelace.
    pub deposit: String,
    /// Deposit refunded by a deregistration, lovelace.
    pub refund: String,
    /// Rewards withdrawn, lovelace.
    pub withdrawn: String,
}

fn check_stake(body: &CardanoBody, s: &StakeMode, ctx: &CardanoContext<'_>) -> Result<()> {
    let net = ctx.net;
    if body.certs.is_empty() && body.withdrawals.is_empty() {
        return Err(bad("no staking operation in this transaction"));
    }
    // Staking pays no one: the only output is change back to our address.
    let [out] = body.outputs.as_slice() else {
        return Err(bad(
            "a staking transaction must have a single output, to your own address",
        ));
    };
    if !ctx.own.contains(&bech32_encode(hrp(net), &out.address)?) {
        return Err(bad("a staking transaction may only pay your own address"));
    }
    let mut kinds = Vec::new();
    for c in &body.certs {
        if c.stake() != &s.stake_hash {
            return Err(bad("certificate for a stake key other than yours: refused"));
        }
        let k = match c {
            CardanoCert::StakeRegistration { deposit, .. } => {
                if *deposit != s.key_deposit {
                    return Err(bad(format!(
                        "registration deposit of {deposit} lovelace, the protocol requires {}: refused",
                        s.key_deposit
                    )));
                }
                7
            }
            CardanoCert::StakeDeregistration { .. } => 8,
            CardanoCert::StakeDelegation { .. } => 2,
            CardanoCert::VoteDelegation { .. } => 9,
        };
        if kinds.contains(&k) {
            return Err(bad("duplicate certificate: refused"));
        }
        kinds.push(k);
    }
    if kinds.contains(&7) && kinds.contains(&8) {
        return Err(bad(
            "registration and deregistration in the same transaction: refused",
        ));
    }
    if kinds.contains(&8) && (kinds.contains(&2) || kinds.contains(&9)) {
        return Err(bad(
            "delegation and deregistration in the same transaction: refused",
        ));
    }
    if let Some(i) = kinds.iter().position(|k| *k == 7) {
        if i != 0 {
            return Err(bad("the registration must be the first certificate"));
        }
    }
    let ours = cardano_reward_address_bytes(net, &s.stake_hash);
    if body.withdrawals.len() > 1 {
        return Err(bad("multiple withdrawals: refused"));
    }
    for (a, c) in &body.withdrawals {
        if *a != ours {
            return Err(bad(
                "withdrawal from a reward account other than yours: refused",
            ));
        }
        if *c == 0 {
            return Err(bad("withdrawal of 0 lovelace: refused"));
        }
    }
    Ok(())
}

fn stake_views(body: &CardanoBody, net: Network) -> Result<CardanoStakeViews> {
    let (mut deposit, mut refund, mut withdrawn) = (0u64, 0u64, 0u64);
    let mut certificates = Vec::new();
    for c in &body.certs {
        certificates.push(match c {
            CardanoCert::StakeRegistration { deposit: d, .. } => {
                deposit = deposit.saturating_add(*d);
                CardanoCertView::StakeRegistration {
                    deposit: d.to_string(),
                }
            }
            CardanoCert::StakeDeregistration { refund: r, .. } => {
                refund = refund.saturating_add(*r);
                CardanoCertView::StakeDeregistration {
                    refund: r.to_string(),
                }
            }
            CardanoCert::StakeDelegation { pool, .. } => CardanoCertView::StakeDelegation {
                pool_id: cardano_pool_bech32(pool)?,
                pool_hash: hex::encode(pool),
            },
            CardanoCert::VoteDelegation { drep, .. } => {
                CardanoCertView::VoteDelegation { drep: drep.into() }
            }
        });
    }
    let mut withdrawals = Vec::new();
    for (a, c) in &body.withdrawals {
        withdrawn = withdrawn.saturating_add(*c);
        withdrawals.push(CardanoWithdrawalView {
            reward_address: bech32_encode(
                match net {
                    Network::Mainnet => "stake",
                    Network::Testnet => "stake_test",
                },
                a,
            )?,
            lovelace: c.to_string(),
        });
    }
    Ok(CardanoStakeViews {
        certificates,
        withdrawals,
        deposit,
        refund,
        withdrawn,
    })
}

struct CardanoStakeViews {
    certificates: Vec<CardanoCertView>,
    withdrawals: Vec<CardanoWithdrawalView>,
    deposit: u64,
    refund: u64,
    withdrawn: u64,
}

fn stake_summary(d: &Decoded, net: Network, stake_pk: &[u8; 32]) -> Result<CardanoStakeSummary> {
    let v = stake_views(&d.body, net)?;
    Ok(CardanoStakeSummary {
        tx: d.summary.clone(),
        stake_address: cardano_stake_address(net, stake_pk)?,
        certificates: v.certificates,
        withdrawals: v.withdrawals,
        deposit: v.deposit.to_string(),
        refund: v.refund.to_string(),
        withdrawn: v.withdrawn.to_string(),
    })
}

/// Decodes an unsigned **staking** transaction for the dialog.
pub fn cardano_decode_stake_tx(
    raw_hex: &str,
    ctx: &CardanoContext<'_>,
    stake_pk: &[u8; 32],
    key_deposit: u64,
) -> Result<CardanoStakeSummary> {
    let mode = StakeMode {
        stake_hash: blake2b224(stake_pk),
        key_deposit,
    };
    let d = decode_full(raw_hex, ctx, Some(&mode))?;
    stake_summary(&d, ctx.net, stake_pk)
}

/// Body of a decoded staking transaction (for the shell's balance check).
pub fn cardano_stake_tx_body(
    raw_hex: &str,
    ctx: &CardanoContext<'_>,
    stake_pk: &[u8; 32],
    key_deposit: u64,
) -> Result<CardanoBody> {
    let mode = StakeMode {
        stake_hash: blake2b224(stake_pk),
        key_deposit,
    };
    Ok(decode_full(raw_hex, ctx, Some(&mode))?.body)
}

/// Signs a staking tx with payment key `…/0/index` and stake key `…/2/0`, after decoding.
pub fn cardano_sign_stake(
    root: &CardanoRoot,
    account: u32,
    index: u32,
    stake_account: u32,
    raw_hex: &str,
    ctx: &CardanoContext<'_>,
    key_deposit: u64,
) -> Result<(String, String, CardanoStakeSummary)> {
    let stake_key = root.key(stake_account, ROLE_STAKE, 0)?;
    let stake_pk = public(&stake_key);
    let mode = StakeMode {
        stake_hash: blake2b224(&stake_pk),
        key_deposit,
    };
    let d = decode_full(raw_hex, ctx, Some(&mode))?;
    let summary = stake_summary(&d, ctx.net, &stake_pk)?;
    let pay_key = root.key(account, ROLE_EXTERNAL, index)?;
    let pay_pk = public(&pay_key);
    let tx_id = cardano_blake2b256(&d.body_cbor.to_vec());
    let mut wits = Vec::with_capacity(2);
    for (k, pk) in [(&pay_key, &pay_pk), (&stake_key, &stake_pk)] {
        let sig = sign_extended(k, &tx_id, pk)?;
        wits.push(Cbor::Array(vec![
            Cbor::Bytes(pk.to_vec()),
            Cbor::Bytes(sig.to_vec()),
        ]));
    }
    let list = Cbor::Array(wits);
    let set = if d.body.tagged_sets {
        Cbor::Tag(258, Box::new(list))
    } else {
        list
    };
    let signed = tx_cbor(
        &d.body_cbor,
        Cbor::Map(vec![(Cbor::Uint(0), set)]),
        d.aux.as_ref(),
    );
    Ok((hex::encode(signed), hex::encode(tx_id), summary))
}

/// Signs with payment key `m/1852'/1815'/account'/0/index` (Ed25519, `verify_strict`ed).
pub fn cardano_sign(
    root: &CardanoRoot,
    account: u32,
    index: u32,
    raw_hex: &str,
    ctx: &CardanoContext<'_>,
) -> Result<(String, String, CardanoTxSummary)> {
    let d = decode_full(raw_hex, ctx, None)?;
    let key = root.key(account, ROLE_EXTERNAL, index)?;
    let bip32_pk = public(&key);
    let tx_id = cardano_blake2b256(&d.body_cbor.to_vec());
    let sig = sign_extended(&key, &tx_id, &bip32_pk)?;
    let wit = Cbor::Array(vec![
        Cbor::Bytes(bip32_pk.to_vec()),
        Cbor::Bytes(sig.to_vec()),
    ]);
    let set = if d.body.tagged_sets {
        Cbor::Tag(258, Box::new(Cbor::Array(vec![wit])))
    } else {
        Cbor::Array(vec![wit])
    };
    let signed = tx_cbor(
        &d.body_cbor,
        Cbor::Map(vec![(Cbor::Uint(0), set)]),
        d.aux.as_ref(),
    );
    Ok((hex::encode(signed), hex::encode(tx_id), d.summary))
}

fn sign_extended(key: &XPrv, msg: &[u8], expected_pk: &[u8; 32]) -> Result<[u8; 64]> {
    let ext = Zeroizing::new(key.extended_secret_key());
    let mut kl = Zeroizing::new([0u8; 32]);
    kl.copy_from_slice(&ext[..32]);
    // `hash_prefix` filled in place: a moved local `[u8; 32]` would stay unerased on the stack.
    let mut esk = ExpandedSecretKey {
        scalar: curve25519_dalek::Scalar::from_bytes_mod_order(*kl),
        hash_prefix: [0u8; 32],
    };
    esk.hash_prefix.copy_from_slice(&ext[32..]);
    let vk = VerifyingKey::from(&esk);
    if vk.as_bytes() != expected_pk {
        return Err(Error::crypto(
            "public keys differ between ed25519-bip32 and ed25519-dalek",
        ));
    }
    let sig = raw_sign::<sha2::Sha512>(&esk, msg, &vk);
    vk.verify_strict(msg, &sig)
        .map_err(|_| Error::crypto("signature self-check failed"))?;
    Ok(sig.to_bytes())
}

/// Verifies a vkey witness (`verify_strict`).
pub fn cardano_verify(public_key: &[u8], msg: &[u8], signature: &[u8]) -> Result<()> {
    let pk: [u8; 32] = public_key
        .try_into()
        .map_err(|_| Error::input("public key: 32 bytes"))?;
    let vk = VerifyingKey::from_bytes(&pk).map_err(|_| Error::input("invalid public key"))?;
    let sig = Signature::from_slice(signature).map_err(|_| Error::input("signature: 64 bytes"))?;
    vk.verify_strict(msg, &sig)
        .or_else(|_| vk.verify(msg, &sig))
        .map_err(|_| Error::input("the signature does not verify"))
}

/// Tx id, witness keys and signatures of a signed tx (hex), each verified against the id.
pub fn cardano_signed_witnesses(raw_hex: &str) -> Result<(String, Vec<[u8; 32]>)> {
    let raw = hex::decode(raw_hex.trim())
        .map_err(|_| Error::input("transaction: hexadecimal expected"))?;
    let tx = parse_one(&raw)?;
    let Cbor::Array(parts) = &tx else {
        return Err(bad("transaction"));
    };
    let (Some(body), Some(Cbor::Map(w))) = (parts.first(), parts.get(1)) else {
        return Err(bad("transaction"));
    };
    let tx_id = cardano_blake2b256(&body.to_vec());
    let mut keys = Vec::new();
    for (k, v) in w {
        if *k != Cbor::Uint(0) {
            continue;
        }
        let list = match v {
            Cbor::Tag(258, inner) => inner.as_ref(),
            other => other,
        };
        let Cbor::Array(list) = list else {
            return Err(bad("witnesses"));
        };
        for item in list {
            let Cbor::Array(pair) = item else {
                return Err(bad("witness"));
            };
            let [Cbor::Bytes(pk), Cbor::Bytes(sig)] = pair.as_slice() else {
                return Err(bad("witness"));
            };
            cardano_verify(pk, &tx_id, sig)?;
            keys.push(pk.as_slice().try_into().map_err(|_| bad("witness key"))?);
        }
    }
    if keys.is_empty() {
        return Err(bad("no signature witness"));
    }
    Ok((hex::encode(tx_id), keys))
}

fn account_xpub_of_hex(xpub_hex: &str) -> Result<ed25519_bip32::XPub> {
    let b = hex::decode(xpub_hex.trim()).map_err(|_| Error::input("Cardano account key: hex"))?;
    ed25519_bip32::XPub::from_slice(&b)
        .map_err(|_| Error::input("Cardano account key: 64 bytes expected"))
}

/// Public key `<account xpub>/role/index` (soft BIP32-Ed25519 V2 derivation).
pub fn cardano_xpub_child(xpub_hex: &str, role: u32, index: u32) -> Result<[u8; 32]> {
    if role >= HARDENED || index >= HARDENED {
        return Err(Error::input(
            "hardened derivation is not possible from a public key",
        ));
    }
    let x = account_xpub_of_hex(xpub_hex)?
        .derive(DerivationScheme::V2, role)
        .and_then(|k| k.derive(DerivationScheme::V2, index))
        .map_err(|_| Error::crypto("Cardano public derivation failed"))?;
    Ok(x.public_key())
}

/// Base address `…/0/index` + stake `…/2/0` of an account public key (hardware accounts).
pub fn cardano_address_from_xpub(xpub_hex: &str, net: Network, index: u32) -> Result<String> {
    cardano_base_address(
        net,
        &cardano_xpub_child(xpub_hex, ROLE_EXTERNAL, index)?,
        &cardano_xpub_child(xpub_hex, ROLE_STAKE, 0)?,
    )
}

/// Where an output of a hardware-wallet transaction goes, as the device is told.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CardanoHwDestination {
    /// Our base address `…/0/0` + `…/2/0` (the device shows it as change).
    Own,
    /// Any other address, as raw bytes.
    Address(Vec<u8>),
}

/// One output for the device.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CardanoHwOutput {
    /// Destination.
    pub destination: CardanoHwDestination,
    /// Lovelace.
    pub coin: u64,
    /// Native tokens (canonical order, as in the body).
    pub assets: CardanoAssets,
    /// Map (Babbage) form rather than the legacy array.
    pub map_form: bool,
}

/// Body fields (in order) a hardware wallet needs to rebuild, hash and sign a payment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CardanoHwPlan {
    /// Inputs, in body order.
    pub inputs: Vec<CardanoInput>,
    /// Outputs, in body order.
    pub outputs: Vec<CardanoHwOutput>,
    /// Lovelace.
    pub fee: u64,
    /// Validity limit (slot).
    pub ttl: Option<u64>,
    /// blake2b-256 of the auxiliary data (CIP-20 memo), signed as an "arbitrary hash".
    pub aux_hash: Option<[u8; 32]>,
    /// Validity start (slot).
    pub validity_start: Option<u64>,
    /// Sets encoded with CBOR tag 258 (Conway).
    pub tagged_sets: bool,
    /// Transaction id Kyro computed (blake2b-256 of its body encoding).
    pub tx_id: [u8; 32],
    /// The summary shown in the native dialog.
    pub summary: CardanoTxSummary,
}

/// Decodes an unsigned payment like [`cardano_decode_tx`] and lists fields for a device.
pub fn cardano_hw_plan(
    raw_hex: &str,
    ctx: &CardanoContext<'_>,
    own_address: &[u8],
) -> Result<CardanoHwPlan> {
    let d = decode_full(raw_hex, ctx, None)?;
    let tx_id = cardano_blake2b256(&d.body_cbor.to_vec());
    let outputs = d
        .body
        .outputs
        .iter()
        .map(|o| CardanoHwOutput {
            destination: if o.address == own_address {
                CardanoHwDestination::Own
            } else {
                CardanoHwDestination::Address(o.address.clone())
            },
            coin: o.coin,
            assets: o.assets.clone(),
            map_form: o.map_form,
        })
        .collect();
    Ok(CardanoHwPlan {
        inputs: d.body.inputs.clone(),
        outputs,
        fee: d.body.fee,
        ttl: d.body.ttl,
        aux_hash: d.body.aux_hash,
        validity_start: d.body.validity_start,
        tagged_sets: d.body.tagged_sets,
        tx_id,
        summary: d.summary,
    })
}

/// Attaches a device witness after checking its body hash is our tx id and sig verifies.
pub fn cardano_hw_assemble(
    raw_hex: &str,
    ctx: &CardanoContext<'_>,
    payment_pk: &[u8; 32],
    device_tx_hash: &[u8],
    signature: &[u8],
) -> Result<(String, String, CardanoTxSummary)> {
    let d = decode_full(raw_hex, ctx, None)?;
    let tx_id = cardano_blake2b256(&d.body_cbor.to_vec());
    if device_tx_hash != tx_id {
        return Err(Error::crypto(
            "the device signed a different transaction body than Kyro's",
        ));
    }
    let pk =
        VerifyingKey::from_bytes(payment_pk).map_err(|_| Error::input("invalid public key"))?;
    let sig = Signature::from_slice(signature).map_err(|_| Error::input("signature: 64 bytes"))?;
    pk.verify_strict(&tx_id, &sig).map_err(|_| {
        Error::crypto("the device's signature does not verify with the account key")
    })?;
    let wit = Cbor::Array(vec![
        Cbor::Bytes(payment_pk.to_vec()),
        Cbor::Bytes(signature.to_vec()),
    ]);
    let set = if d.body.tagged_sets {
        Cbor::Tag(258, Box::new(Cbor::Array(vec![wit])))
    } else {
        Cbor::Array(vec![wit])
    };
    let signed = tx_cbor(
        &d.body_cbor,
        Cbor::Map(vec![(Cbor::Uint(0), set)]),
        d.aux.as_ref(),
    );
    Ok((hex::encode(signed), hex::encode(tx_id), d.summary))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cbor_shortest_forms_only() {
        for (v, enc) in [
            (0u64, "00"),
            (23, "17"),
            (24, "1818"),
            (255, "18ff"),
            (256, "190100"),
            (65_536, "1a00010000"),
            (u64::MAX, "1bffffffffffffffff"),
        ] {
            let c = Cbor::Uint(v);
            assert_eq!(hex::encode(c.to_vec()), enc);
            assert_eq!(parse_one(&hex::decode(enc).unwrap()).unwrap(), c);
        }
        // 1 written on 2 bytes, indefinite array, negative int, float: refused.
        for bad_cbor in ["1801", "9fff", "20", "f93c00", "00ff"] {
            assert!(
                parse_one(&hex::decode(bad_cbor).unwrap()).is_err(),
                "{bad_cbor}"
            );
        }
    }

    #[test]
    fn cip20_memo_lines() {
        let a = cardano_cip20_aux("hello").unwrap();
        // {674: {"msg": ["hello"]}}
        assert_eq!(hex::encode(&a), "a11902a2a1636d7367816568656c6c6f");
        let long = "x".repeat(65);
        let c = parse_one(&cardano_cip20_aux(&long).unwrap()).unwrap();
        assert_eq!(decode_cip20(&c).unwrap(), vec!["x".repeat(64), "x".into()]);
    }
}
