//! secp256k1 BIP32 key handling shared by the Bitcoin and EVM modules.

use bitcoin::bip32::{ChainCode, ChildNumber, Fingerprint, Xpriv};
use bitcoin::secp256k1::{All, Secp256k1};
use zeroize::Zeroizing;

use crate::error::{Error, Result};
use crate::mnemonic::Seed;

/// Secp256k1 context with side-channel blinding seeded from the OS RNG.
pub(crate) fn secp() -> Result<Secp256k1<All>> {
    let mut secp = Secp256k1::new();
    let mut seed = Zeroizing::new([0u8; 32]);
    getrandom::getrandom(&mut seed[..]).map_err(|_| Error::crypto("OS randomness unavailable"))?;
    secp.seeded_randomize(&seed);
    Ok(secp)
}

/// 32 bytes of OS randomness (BIP340 auxiliary randomness).
pub(crate) fn random32() -> Result<Zeroizing<[u8; 32]>> {
    let mut out = Zeroizing::new([0u8; 32]);
    getrandom::getrandom(&mut out[..]).map_err(|_| Error::crypto("OS randomness unavailable"))?;
    Ok(out)
}

pub(crate) struct XprivGuard(Xpriv);

impl XprivGuard {
    pub(crate) fn master(seed: &Seed, net: bitcoin::NetworkKind) -> Result<Self> {
        Xpriv::new_master(net, &seed[..])
            .map(XprivGuard)
            .map_err(|_| Error::crypto("master key derivation failed"))
    }

    pub(crate) fn derive(&self, secp: &Secp256k1<All>, path: &[ChildNumber]) -> Result<Self> {
        self.0
            .derive_priv(secp, &path)
            .map(XprivGuard)
            .map_err(|_| Error::crypto("key derivation failed"))
    }

    pub(crate) fn fingerprint(&self, secp: &Secp256k1<All>) -> Fingerprint {
        self.0.fingerprint(secp)
    }

    pub(crate) fn xpriv(&self) -> &Xpriv {
        &self.0
    }
}

impl Drop for XprivGuard {
    fn drop(&mut self) {
        self.0.private_key.non_secure_erase();
        self.0.chain_code = ChainCode::from([0u8; 32]);
    }
}

pub(crate) fn hardened(index: u32) -> Result<ChildNumber> {
    ChildNumber::from_hardened_idx(index)
        .map_err(|_| Error::input("derivation index must be < 2^31"))
}

pub(crate) fn normal(index: u32) -> Result<ChildNumber> {
    ChildNumber::from_normal_idx(index).map_err(|_| Error::input("derivation index must be < 2^31"))
}

pub(crate) fn path_string(path: &[ChildNumber]) -> String {
    let mut s = String::from("m");
    for c in path {
        match c {
            ChildNumber::Normal { index } => s.push_str(&format!("/{index}")),
            ChildNumber::Hardened { index } => s.push_str(&format!("/{index}'")),
        }
    }
    s
}
