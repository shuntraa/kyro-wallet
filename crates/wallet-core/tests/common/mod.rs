#![allow(dead_code)]

use wallet_core::{Mnemonic, Seed};

/// Mnemonic used by the BIP84 / BIP86 test vectors (and most wallets' test suites).
pub const ABANDON: &str =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

/// A second, unrelated wallet (Trezor BIP39 vector, entropy 7f7f…).
pub const LEGAL: &str =
    "legal winner thank year wave sausage worth useful legal winner thank yellow";

pub fn seed(phrase: &str) -> Seed {
    Mnemonic::parse(phrase).unwrap().to_seed("")
}
