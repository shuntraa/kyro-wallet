//! Cardano: CIP-0003 **Icarus** master key, CIP-1852 derivation `m/1852'/1815'/account'/role/i`
//! (BIP32-Ed25519, Khovratovich–Law "V2"), CIP-19 Shelley addresses, and Conway-era transaction
//! bodies restricted to **plain payments** (ADA + native tokens, optional CIP-20 memo).
//!
//! Cryptography (none written here):
//! - Icarus: PBKDF2-HMAC-SHA512 (RustCrypto `pbkdf2`), 4096 iterations, salt = BIP39 entropy,
//!   password = passphrase, 96 bytes, then `XPrv::normalize_bytes_force3rd` (clamping);
//! - derivation: `ed25519-bip32` (IOHK lineage; the scheme used by CML, CSL, pallas-wallet);
//! - signatures: **ed25519-dalek** `hazmat::raw_sign` with the extended scalar `kL` and nonce
//!   prefix `kR`, then `verify_strict`; the public key from dalek must equal ed25519-bip32's;
//! - hashes: RustCrypto `blake2` (blake2b-224 key hashes, blake2b-256 transaction id).
//!
//! CBOR: hand-written for the subset used here (unsigned ints, byte/text strings, arrays,
//! maps, tag 258, `true`/`null`), definite lengths only. A transaction is accepted only if
//! re-encoding what was decoded gives back the same bytes — canonical integer/length forms,
//! canonical key order, no duplicate, no unknown field — tested against Trezor's firmware
//! fixtures (transaction hashes and signatures) and real preprod transactions. `minicbor`
//! (the CBOR library of pallas) was not used: its BlueOak-1.0.0 licence is not on the project's
//! allow list, and pallas-primitives would add a second, older cryptoxide.

use bitcoin::bech32::{self, primitives::decode::CheckedHrpstring, Bech32, Hrp};
use blake2::digest::{consts::U28, consts::U32, Digest};
use blake2::Blake2b;
use ed25519_bip32::{DerivationScheme, XPrv};
use ed25519_dalek::hazmat::{raw_sign, ExpandedSecretKey};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::error::{Error, Result};
use crate::mnemonic::Mnemonic;
use crate::network::Network;

const HARDENED: u32 = 0x8000_0000;
/// CIP-1852 purpose and Cardano coin type.
const PURPOSE: u32 = 1852;
const COIN: u32 = 1815;
/// Role 0 = external payment keys, 1 = change, 2 = stake key.
const ROLE_EXTERNAL: u32 = 0;
const ROLE_STAKE: u32 = 2;
/// Transactions larger than this are refused (protocol maximum is 16 384 bytes).
const MAX_TX: usize = 16_384;
/// CIP-20 transaction message label.
const CIP20_LABEL: u64 = 674;
/// Fees above 5 ADA need a reinforced confirmation (a payment costs ~0.17–0.3 ADA).
const HIGH_FEE: u64 = 5_000_000;

fn blake2b224(data: &[u8]) -> [u8; 28] {
    Blake2b::<U28>::digest(data).into()
}

/// blake2b-256.
pub fn cardano_blake2b256(data: &[u8]) -> [u8; 32] {
    Blake2b::<U32>::digest(data).into()
}

// ---------------------------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------------------------

/// Icarus root key (`XPrv`, 96 bytes: kL ‖ kR ‖ chain code), erased on drop.
pub struct CardanoRoot(XPrv);

impl core::fmt::Debug for CardanoRoot {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("CardanoRoot(…)")
    }
}

impl CardanoRoot {
    /// CIP-0003 Icarus: PBKDF2-HMAC-SHA512(password = passphrase, salt = entropy, 4096, 96 B),
    /// then clamping. Same result as Yoroi / Eternl / Lace and Trezor's "ICARUS" derivation.
    pub fn from_mnemonic(mnemonic: &Mnemonic, passphrase: &str) -> CardanoRoot {
        let entropy = mnemonic.entropy();
        let mut out = Zeroizing::new([0u8; 96]);
        pbkdf2::pbkdf2_hmac::<sha2::Sha512>(passphrase.as_bytes(), &entropy, 4096, &mut out[..]);
        CardanoRoot(XPrv::normalize_bytes_force3rd(*out))
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
            return Err(Error::input("numéro de compte trop grand"));
        }
        Ok(self.derive(&[PURPOSE | HARDENED, COIN | HARDENED, account | HARDENED]))
    }

    fn key(&self, account: u32, role: u32, index: u32) -> Result<XPrv> {
        if index >= HARDENED {
            return Err(Error::input("index d'adresse trop grand"));
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

/// Account-level extended public key `m/1852'/1815'/account'`: public key ‖ chain code, hex.
pub fn cardano_account_xpub(root: &CardanoRoot, account: u32) -> Result<String> {
    let x = root.account(account)?.public();
    Ok(format!(
        "{}{}",
        hex::encode(x.public_key()),
        hex::encode(x.chain_code())
    ))
}

// ---------------------------------------------------------------------------------------------
// Addresses (CIP-19)
// ---------------------------------------------------------------------------------------------

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
    let h = Hrp::parse(hrp_s).map_err(|_| Error::crypto("préfixe bech32"))?;
    bech32::encode::<Bech32>(h, data).map_err(|_| Error::crypto("encodage bech32 impossible"))
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

/// Stake address of the account (`…/2/0`), for display (staking itself is not supported).
pub fn cardano_account_stake_address(
    root: &CardanoRoot,
    net: Network,
    account: u32,
) -> Result<String> {
    cardano_stake_address(net, &public(&root.key(account, ROLE_STAKE, 0)?))
}

/// Raw bytes of a recipient address valid for `net`. Accepted: base addresses with a **key**
/// payment part (types 0 and 2) and enterprise key addresses (type 6). Refused: Byron
/// (bootstrap, base58) addresses, script payment addresses (types 1, 3, 5, 7: sending without a
/// datum can lock the funds for ever), pointer addresses (4, 5: deprecated in Conway), reward
/// addresses (14, 15: they cannot receive outputs), and the other network.
pub fn cardano_address_bytes(address: &str, net: Network) -> Result<Vec<u8>> {
    let a = address.trim();
    if a.starts_with("Ae2") || a.starts_with("DdzFF") || a.starts_with("37btjrVyb4K") {
        return Err(Error::input(
            "les adresses Byron ne sont pas prises en charge : demande au destinataire une adresse Shelley (addr1…)",
        ));
    }
    let checked =
        CheckedHrpstring::new::<Bech32>(a).map_err(|_| Error::input("adresse Cardano invalide"))?;
    let h = checked.hrp();
    let data: Vec<u8> = checked.byte_iter().collect();
    if h.as_str() != hrp(net) {
        return Err(Error::input(
            "adresse Cardano d'un autre réseau, ou pas une adresse de paiement",
        ));
    }
    check_address_bytes(&data, net)?;
    Ok(data)
}

fn check_address_bytes(data: &[u8], net: Network) -> Result<()> {
    let header = *data.first().ok_or_else(|| Error::input("adresse vide"))?;
    let (kind, nid) = (header >> 4, header & 0x0F);
    if nid != network_id(net) {
        return Err(Error::input("adresse Cardano d'un autre réseau"));
    }
    match (kind, data.len()) {
        (0 | 2, 57) | (6, 29) => Ok(()),
        (1 | 3 | 7, _) => Err(Error::input(
            "adresses de script refusées : un paiement sans datum pourrait bloquer les fonds",
        )),
        (4 | 5, _) => Err(Error::input(
            "adresses pointeur obsolètes (Conway) : refusées",
        )),
        (14 | 15, _) => Err(Error::input(
            "une adresse de staking (stake…) ne peut pas recevoir de paiement",
        )),
        (8, _) => Err(Error::input(
            "les adresses Byron ne sont pas prises en charge",
        )),
        _ => Err(Error::input("adresse Cardano mal formée")),
    }
}

/// bech32 form of raw address bytes (for display), or `None` for an unsupported type.
pub fn cardano_address_string(data: &[u8], net: Network) -> Option<String> {
    check_address_bytes(data, net).ok()?;
    bech32_encode(hrp(net), data).ok()
}

// ---------------------------------------------------------------------------------------------
// CBOR (subset)
// ---------------------------------------------------------------------------------------------

/// A decoded CBOR item (definite lengths only).
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
    Error::input(format!("transaction Cardano : {}", msg.into()))
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
            return Err(bad("imbrication trop profonde"));
        }
        let (&first, rest) = b.split_first().ok_or_else(|| bad("tronquée"))?;
        *b = rest;
        let (major, info) = (first >> 5, first & 0x1F);
        if major == 7 {
            return match info {
                21 => Ok(Cbor::True),
                22 => Ok(Cbor::Null),
                _ => Err(bad("valeur simple ou flottant non pris en charge")),
            };
        }
        let v = match info {
            0..=23 => u64::from(info),
            24..=27 => {
                let n = 1usize << (info - 24);
                if b.len() < n {
                    return Err(bad("tronquée"));
                }
                let mut x = 0u64;
                for byte in &b[..n] {
                    x = (x << 8) | u64::from(*byte);
                }
                *b = &b[n..];
                x
            }
            31 => return Err(bad("longueurs indéfinies refusées")),
            _ => return Err(bad("valeur CBOR réservée")),
        };
        let len = |v: u64, b: &[u8]| -> Result<usize> {
            let l = usize::try_from(v).map_err(|_| bad("longueur"))?;
            if l > b.len() {
                return Err(bad("tronquée"));
            }
            Ok(l)
        };
        Ok(match major {
            0 => Cbor::Uint(v),
            1 => return Err(bad("entiers négatifs refusés")),
            2 => {
                let l = len(v, b)?;
                let x = b[..l].to_vec();
                *b = &b[l..];
                Cbor::Bytes(x)
            }
            3 => {
                let l = len(v, b)?;
                let x =
                    String::from_utf8(b[..l].to_vec()).map_err(|_| bad("texte UTF-8 invalide"))?;
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
            _ => return Err(bad("type CBOR non pris en charge")),
        })
    }
}

fn parse_one(raw: &[u8]) -> Result<Cbor> {
    let mut b = raw;
    let c = Cbor::decode(&mut b, 0)?;
    if !b.is_empty() {
        return Err(bad("octets en trop à la fin"));
    }
    if c.to_vec() != raw {
        return Err(bad(
            "CBOR non canonique (entier ou longueur pas sous sa forme la plus courte)",
        ));
    }
    Ok(c)
}

// ---------------------------------------------------------------------------------------------
// Transaction model (plain payments only)
// ---------------------------------------------------------------------------------------------

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

/// A Conway transaction body restricted to keys 0 (inputs), 1 (outputs), 2 (fee), 3 (ttl),
/// 7 (auxiliary data hash) and 8 (validity interval start, accepted and shown; Kyro does not set
/// it).
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

/// Babbage/Conway minimum lovelace of an output: `(160 + size) × coinsPerUTxOByte`, computed
/// with the coin field at its final width (iterated to a fixed point).
pub fn cardano_min_utxo(address: &[u8], assets: &CardanoAssets, coins_per_byte: u64) -> u64 {
    let mut coin = 1_000_000u64;
    for _ in 0..4 {
        let o = CardanoOutput {
            address: address.to_vec(),
            coin,
            assets: assets.clone(),
            map_form: false,
        };
        let need = (160 + o.size() as u64) * coins_per_byte;
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
            return Err(bad("le corps doit être une table CBOR"));
        };
        let (mut inputs, mut tagged, mut outputs, mut fee, mut ttl, mut aux, mut start) =
            (None, false, None, None, None, None, None);
        for (k, v) in m {
            let Cbor::Uint(k) = k else {
                return Err(bad("clé du corps"));
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
                        return Err(bad("entrées"));
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
                                _ => return Err(bad("entrée")),
                            },
                            _ => return Err(bad("entrée")),
                        }
                    }
                    inputs = Some(list);
                }
                1 => {
                    let Cbor::Array(a) = v else {
                        return Err(bad("sorties"));
                    };
                    outputs = Some(a.iter().map(decode_output).collect::<Result<Vec<_>>>()?);
                }
                2 => match v {
                    Cbor::Uint(f) => fee = Some(*f),
                    _ => return Err(bad("frais")),
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
                    _ => return Err(bad("hash des métadonnées")),
                },
                4 => return Err(bad("certificats (staking, délégation) : refusés")),
                5 => return Err(bad("retraits de récompenses : refusés")),
                6 => return Err(bad("mises à jour de paramètres de protocole : refusées")),
                8 => match v {
                    Cbor::Uint(t) => start = Some(*t),
                    _ => return Err(bad("début de validité")),
                },
                9 => return Err(bad("création / destruction de tokens (mint) : refusée")),
                11 => return Err(bad("hash de données de script (Plutus) : refusé")),
                13 | 16 | 17 => return Err(bad("collatéral : refusé")),
                14 => return Err(bad("signataires requis : refusés")),
                15 => return Err(bad("champ network id non pris en charge")),
                18 => return Err(bad("entrées de référence : refusées")),
                19 => return Err(bad("votes : refusés")),
                20 => return Err(bad("propositions de gouvernance : refusées")),
                21 | 22 => return Err(bad("don au trésor : refusé")),
                other => return Err(bad(format!("champ du corps inconnu {other}"))),
            }
        }
        let body = CardanoBody {
            inputs: inputs.ok_or_else(|| bad("entrées absentes"))?,
            tagged_sets: tagged,
            outputs: outputs.ok_or_else(|| bad("sorties absentes"))?,
            fee: fee.ok_or_else(|| bad("frais absents"))?,
            ttl,
            aux_hash: aux,
            validity_start: start,
        };
        if &body.cbor() != c {
            return Err(bad("corps non canonique (ordre des champs, doublons)"));
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
                return Err(bad("montant ADA"));
            };
            let Cbor::Map(pol) = &a[1] else {
                return Err(bad("multi-asset"));
            };
            let mut assets = Vec::with_capacity(pol.len());
            for (p, names) in pol {
                let (Cbor::Bytes(p), Cbor::Map(names)) = (p, names) else {
                    return Err(bad("entrée multi-asset"));
                };
                let policy: [u8; 28] = p
                    .as_slice()
                    .try_into()
                    .map_err(|_| bad("policy id : 28 octets"))?;
                let mut list = Vec::with_capacity(names.len());
                for (n, q) in names {
                    let (Cbor::Bytes(n), Cbor::Uint(q)) = (n, q) else {
                        return Err(bad("entrée de token"));
                    };
                    if n.len() > 32 || *q == 0 {
                        return Err(bad("nom de token de plus de 32 octets, ou quantité nulle"));
                    }
                    list.push((n.clone(), *q));
                }
                if list.is_empty() {
                    return Err(bad("policy vide"));
                }
                assets.push((policy, list));
            }
            Ok((c, assets))
        }
        _ => Err(bad("montant")),
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
            [_, _, _] => Err(bad("sorties avec hash de datum : refusées")),
            _ => Err(bad("sortie")),
        },
        Cbor::Map(m) => {
            let (mut addr, mut val) = (None, None);
            for (k, v) in m {
                match (k, v) {
                    (Cbor::Uint(0), Cbor::Bytes(a)) => addr = Some(a.clone()),
                    (Cbor::Uint(1), v) => val = Some(decode_value(v)?),
                    (Cbor::Uint(2), _) => return Err(bad("sorties avec datum : refusées")),
                    (Cbor::Uint(3), _) => {
                        return Err(bad("sorties avec script de référence : refusées"))
                    }
                    _ => return Err(bad("champ de sortie inconnu")),
                }
            }
            let (coin, assets) = val.ok_or_else(|| bad("montant de sortie"))?;
            Ok(CardanoOutput {
                address: addr.ok_or_else(|| bad("adresse de sortie"))?,
                coin,
                assets,
                map_form: true,
            })
        }
        _ => Err(bad("sortie")),
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
        return Err(Error::input("message vide"));
    }
    if message.len() > 1024 {
        return Err(Error::input("message trop long (1 024 octets max.)"));
    }
    Ok(Cbor::Map(vec![(
        Cbor::Uint(CIP20_LABEL),
        Cbor::Map(vec![(Cbor::Text("msg".into()), Cbor::Array(lines))]),
    )])
    .to_vec())
}

fn decode_cip20(c: &Cbor) -> Result<Vec<String>> {
    let bad_meta = || bad("métadonnées autres qu'un message CIP-20 : refusées");
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

/// Full transaction CBOR `[body, witness set, true, auxiliary data | null]`.
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

// ---------------------------------------------------------------------------------------------
// Summary, signing
// ---------------------------------------------------------------------------------------------

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

fn decode_full(raw_hex: &str, ctx: &CardanoContext<'_>) -> Result<Decoded> {
    let raw = hex::decode(raw_hex.trim())
        .map_err(|_| Error::input("transaction : hexadécimal attendu"))?;
    if raw.len() > MAX_TX {
        return Err(bad("trop grande"));
    }
    let tx = parse_one(&raw)?;
    let Cbor::Array(parts) = &tx else {
        return Err(bad("la transaction doit être un tableau CBOR"));
    };
    let [body_c, wit, valid, aux] = parts.as_slice() else {
        return Err(bad("la transaction doit avoir 4 parties"));
    };
    if wit != &Cbor::Map(Vec::new()) {
        return Err(bad("déjà signée (témoins présents)"));
    }
    if valid != &Cbor::True {
        return Err(bad("is_valid doit valoir true"));
    }
    let body = CardanoBody::decode_cbor(body_c)?;
    let aux = match aux {
        Cbor::Null => None,
        other => Some(other.clone()),
    };
    let memo = match (&aux, body.aux_hash) {
        (None, None) => None,
        (Some(a), Some(h)) => {
            if cardano_blake2b256(&a.to_vec()) != h {
                return Err(bad("le hash des métadonnées ne correspond pas"));
            }
            Some(decode_cip20(a)?)
        }
        _ => {
            return Err(bad(
                "les métadonnées et leur hash doivent être présents ensemble",
            ))
        }
    };
    if body.inputs.is_empty() || body.outputs.is_empty() {
        return Err(bad("aucune entrée ou aucune sortie"));
    }
    // A set: order is free (Kyro sorts its own), duplicates are refused.
    let mut sorted = body.inputs.clone();
    sorted.sort();
    sorted.dedup();
    if sorted.len() != body.inputs.len() {
        return Err(bad("entrée en double"));
    }
    let mut warnings = Vec::new();
    let mut outputs = Vec::with_capacity(body.outputs.len());
    for o in &body.outputs {
        check_address_bytes(&o.address, ctx.net)?;
        let address = bech32_encode(hrp(ctx.net), &o.address)?;
        let min = cardano_min_utxo(&o.address, &o.assets, ctx.coins_per_byte);
        if o.coin < min {
            return Err(bad(format!(
                "une sortie porte {} lovelace, sous son minimum de {min} (min-UTxO)",
                o.coin
            )));
        }
        let mut tokens = Vec::new();
        for (p, names) in &o.assets {
            let mut prev: Option<&Vec<u8>> = None;
            for (n, q) in names {
                if prev.is_some_and(|x| (x.len(), x) >= (n.len(), n)) {
                    return Err(bad("noms de tokens hors de l'ordre canonique"));
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
                tokens.push(CardanoTokenView {
                    name_text: String::from_utf8(n.clone())
                        .ok()
                        .filter(|t| !t.is_empty() && t.chars().all(|c| !c.is_control())),
                    policy: ph,
                    name: nh,
                    quantity: q.to_string(),
                    verified,
                });
            }
        }
        for w in o.assets.windows(2) {
            if w[0].0 >= w[1].0 {
                return Err(bad("policies hors de l'ordre canonique"));
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

/// Decodes an **unsigned** transaction (hex) for the dialog. Refused: certificates,
/// withdrawals, updates, mint, script data hash, collateral, required signers,
/// network id, reference inputs, voting / governance, treasury fields, outputs with datum or
/// reference script, script / pointer / reward / Byron / other-network addresses, outputs under
/// their min-UTxO, zero token quantities, auxiliary data other than a CIP-20 message (or with a
/// wrong hash), duplicated inputs, a non-empty witness set, and any non-canonical
/// encoding.
pub fn cardano_decode_tx(raw_hex: &str, ctx: &CardanoContext<'_>) -> Result<CardanoTxSummary> {
    Ok(decode_full(raw_hex, ctx)?.summary)
}

/// Body of a decoded unsigned transaction (for the shell's balance check against UTxOs).
pub fn cardano_tx_body(raw_hex: &str, ctx: &CardanoContext<'_>) -> Result<CardanoBody> {
    Ok(decode_full(raw_hex, ctx)?.body)
}

/// Signs with the payment key `m/1852'/1815'/account'/0/index`: Ed25519 over the transaction
/// id, by ed25519-dalek from the BIP32-Ed25519 extended key, verified (`verify_strict`) before
/// it is returned. Returns `(signed transaction hex, tx id hex, summary)`.
pub fn cardano_sign(
    root: &CardanoRoot,
    account: u32,
    index: u32,
    raw_hex: &str,
    ctx: &CardanoContext<'_>,
) -> Result<(String, String, CardanoTxSummary)> {
    let d = decode_full(raw_hex, ctx)?;
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
    let mut kr = [0u8; 32];
    kr.copy_from_slice(&ext[32..]);
    let esk = ExpandedSecretKey {
        scalar: curve25519_dalek::Scalar::from_bytes_mod_order(*kl),
        hash_prefix: kr,
    };
    let vk = VerifyingKey::from(&esk);
    if vk.as_bytes() != expected_pk {
        return Err(Error::crypto(
            "clés publiques différentes entre ed25519-bip32 et ed25519-dalek",
        ));
    }
    let sig = raw_sign::<sha2::Sha512>(&esk, msg, &vk);
    vk.verify_strict(msg, &sig)
        .map_err(|_| Error::crypto("auto-vérification de la signature échouée"))?;
    Ok(sig.to_bytes())
}

/// Verifies a vkey witness (`verify_strict`).
pub fn cardano_verify(public_key: &[u8], msg: &[u8], signature: &[u8]) -> Result<()> {
    let pk: [u8; 32] = public_key
        .try_into()
        .map_err(|_| Error::input("clé publique : 32 octets"))?;
    let vk = VerifyingKey::from_bytes(&pk).map_err(|_| Error::input("clé publique invalide"))?;
    let sig =
        Signature::from_slice(signature).map_err(|_| Error::input("signature : 64 octets"))?;
    vk.verify_strict(msg, &sig)
        .or_else(|_| vk.verify(msg, &sig))
        .map_err(|_| Error::input("la signature ne se vérifie pas"))
}

/// Tx id, witness keys and signatures of a signed transaction (hex), each signature verified
/// against the tx id. Used before broadcast and on real transactions in tests.
pub fn cardano_signed_witnesses(raw_hex: &str) -> Result<(String, Vec<[u8; 32]>)> {
    let raw = hex::decode(raw_hex.trim())
        .map_err(|_| Error::input("transaction : hexadécimal attendu"))?;
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
            return Err(bad("témoins"));
        };
        for item in list {
            let Cbor::Array(pair) = item else {
                return Err(bad("témoin"));
            };
            let [Cbor::Bytes(pk), Cbor::Bytes(sig)] = pair.as_slice() else {
                return Err(bad("témoin"));
            };
            cardano_verify(pk, &tx_id, sig)?;
            keys.push(pk.as_slice().try_into().map_err(|_| bad("clé du témoin"))?);
        }
    }
    if keys.is_empty() {
        return Err(bad("aucun témoin de signature"));
    }
    Ok((hex::encode(tx_id), keys))
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
