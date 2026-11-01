//! Single-key chains of a watch-only hardware-wallet account (Ledger apps Sui, Aptos,
//! Algorand, NEAR, Cosmos, TON, Hedera): one public key per chain and account, read from the
//! device.
//!
//! Each [`HwWatchKey`] stores the public key, the address Kyro derives from it and the path the
//! device used. [`HwWatchKey::validate`] recomputes the address from the key and the path from
//! the account number, so a tampered record cannot pair a key with someone else's address
//! (and the key itself is re-read from the device before every signature, see SECURITY.md).
//!
//! Paths: the same as the software wallet (so one phrase gives the same addresses in Kyro's
//! vault and on the Ledger), **except NEAR**: the Ledger NEAR app only accepts five-level
//! paths, Kyro's vault uses `m/44'/397'/account'`; hardware NEAR accounts therefore use the
//! path of Ledger Live and the NEAR wallets, `m/44'/397'/0'/0'/(account + 1)'` — another key,
//! another implicit account than the vault's. **TON** likewise: the Ledger TON app's path is
//! the six-level one of Ledger Live / `@ton-community/ton-ledger`,
//! `m/44'/607'/0'/0'/account'/0'` (the vault uses `m/44'/607'/account'`), so a hardware TON
//! account is another key and another wallet address than the vault's. Its address also
//! depends on the network (v4R2 wallet id, see `ton.rs`): it is recomputed for the account's
//! network. **Hedera** too: the Ledger Hedera app signs with ED25519 keys at
//! `m/44'/3030'/0'/0'/account'`, the vault uses ECDSA secp256k1 (`m/44'/3030'/0'/0/account`);
//! a hardware Hedera account is an ED25519 account, its account ID (`0.0.x`) is not derived
//! from the key but looked up on the mirror node: the stored « address » is the key's DER
//! form (`302a300506032b6570032100…`, what Hedera wallets show).

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::network::Network;

/// Chains stored as a single public key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HwKeyChain {
    /// Sui (ed25519, Ledger app « Sui »).
    Sui,
    /// Aptos (ed25519, Ledger app « Aptos »), `"apt"` like the other Kyro chain ids.
    #[serde(rename = "apt")]
    Aptos,
    /// Algorand (ed25519, Ledger app « Algorand »).
    Algo,
    /// NEAR (ed25519, Ledger app « NEAR »).
    Near,
    /// Cosmos Hub (secp256k1, Ledger app « Cosmos »).
    Cosmos,
    /// TON (ed25519, Ledger app « TON », wallet v4R2).
    Ton,
    /// Hedera (ed25519 account, Ledger app « Hedera »).
    Hbar,
}

impl HwKeyChain {
    /// Every chain, in display order.
    pub const ALL: [HwKeyChain; 7] = [
        HwKeyChain::Sui,
        HwKeyChain::Aptos,
        HwKeyChain::Algo,
        HwKeyChain::Near,
        HwKeyChain::Cosmos,
        HwKeyChain::Ton,
        HwKeyChain::Hbar,
    ];

    /// BIP32 path (raw indices) used on the device for `account`.
    pub fn path(self, account: u32) -> Vec<u32> {
        const H: u32 = 0x8000_0000;
        let a = account | H;
        match self {
            HwKeyChain::Sui => vec![44 | H, 784 | H, a, H, H],
            HwKeyChain::Aptos => vec![44 | H, 637 | H, a, H, H],
            HwKeyChain::Algo => vec![44 | H, 283 | H, a, 0, 0],
            HwKeyChain::Near => vec![44 | H, 397 | H, H, H, (account + 1) | H],
            HwKeyChain::Cosmos => vec![44 | H, 118 | H, a, 0, 0],
            HwKeyChain::Ton => vec![44 | H, 607 | H, H, H, a, H],
            HwKeyChain::Hbar => vec![44 | H, 3030 | H, H, H, a],
        }
    }

    /// Path as `m/44'/…` text.
    pub fn path_string(self, account: u32) -> String {
        let mut s = String::from("m");
        for i in self.path(account) {
            if i & 0x8000_0000 != 0 {
                s += &format!("/{}'", i & 0x7fff_ffff);
            } else {
                s += &format!("/{i}");
            }
        }
        s
    }

    /// Public key length.
    pub fn key_len(self) -> usize {
        match self {
            HwKeyChain::Cosmos => 33,
            _ => 32,
        }
    }

    /// Address of a public key on `network` (also checks the key's length and, for Cosmos,
    /// that it is a valid compressed secp256k1 point; ed25519 keys are checked by
    /// `ed25519-dalek`). Only TON's address depends on the network.
    pub fn address_of(self, pubkey: &[u8], network: Network) -> Result<String> {
        if pubkey.len() != self.key_len() {
            return Err(Error::input(
                "hardware-wallet public key of the wrong length",
            ));
        }
        if self != HwKeyChain::Cosmos {
            let k: [u8; 32] = pubkey.try_into().map_err(|_| Error::input("public key"))?;
            ed25519_dalek::VerifyingKey::from_bytes(&k)
                .map_err(|_| Error::input("invalid ed25519 public key"))?;
        }
        Ok(match self {
            HwKeyChain::Sui => crate::sui::sui_address_of_pubkey(pubkey)?,
            HwKeyChain::Aptos => crate::aptos::aptos_address_of_pubkey(pubkey)?,
            HwKeyChain::Algo => {
                let k: [u8; 32] = pubkey.try_into().map_err(|_| Error::input("public key"))?;
                crate::algorand::algo_address_of_pubkey(&k)
            }
            HwKeyChain::Near => hex::encode(pubkey),
            HwKeyChain::Cosmos => {
                bitcoin::secp256k1::PublicKey::from_slice(pubkey)
                    .map_err(|_| Error::input("invalid secp256k1 public key"))?;
                crate::cosmos::cosmos_address_of_pubkey(pubkey)?
            }
            HwKeyChain::Ton => {
                let k: [u8; 32] = pubkey.try_into().map_err(|_| Error::input("public key"))?;
                let testnet = network == Network::Testnet;
                crate::ton::ton_wallet_address(&k, crate::ton::ton_wallet_id(testnet))?
                    .to_friendly(false, testnet)
            }
            HwKeyChain::Hbar => {
                let k: [u8; 32] = pubkey.try_into().map_err(|_| Error::input("public key"))?;
                crate::hedera::hbar_ed25519_key_string(&k)
            }
        })
    }
}

/// One single-key chain of a watch-only account.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HwWatchKey {
    /// Chain.
    pub chain: HwKeyChain,
    /// Public key, lowercase hex (32 bytes ed25519, 33 bytes compressed secp256k1).
    pub pubkey: String,
    /// Address derived by Kyro from `pubkey`.
    pub address: String,
    /// Path used on the device ([`HwKeyChain::path_string`] of the account number).
    pub path: String,
}

impl HwWatchKey {
    /// Builds the record for `pubkey` read at `account`, for `network`.
    pub fn new(chain: HwKeyChain, account: u32, network: Network, pubkey: &[u8]) -> Result<Self> {
        Ok(HwWatchKey {
            chain,
            address: chain.address_of(pubkey, network)?,
            pubkey: hex::encode(pubkey),
            path: chain.path_string(account),
        })
    }

    /// Public key bytes.
    pub fn pubkey_bytes(&self) -> Result<Vec<u8>> {
        hex::decode(&self.pubkey).map_err(|_| Error::input("public key must be hex"))
    }

    /// The address is the one of the key (on `network`), the path the one of `account`.
    pub fn validate(&self, account: u32, network: Network) -> Result<()> {
        if self.pubkey != self.pubkey.to_ascii_lowercase() {
            return Err(Error::input("public key must be lowercase hex"));
        }
        if self.chain.address_of(&self.pubkey_bytes()?, network)? != self.address {
            return Err(Error::input("address does not match the stored public key"));
        }
        if self.path != self.chain.path_string(account) {
            return Err(Error::input("path does not match the account number"));
        }
        Ok(())
    }
}

/// Checks a list of keys: valid each, at most one per chain.
pub(crate) fn validate_keys(keys: &[HwWatchKey], account: u32, network: Network) -> Result<()> {
    for (i, k) in keys.iter().enumerate() {
        k.validate(account, network)?;
        if keys[..i].iter().any(|o| o.chain == k.chain) {
            return Err(Error::input("at most one key per chain"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_match_the_software_wallet_except_near() {
        assert_eq!(HwKeyChain::Sui.path_string(2), crate::sui::sui_path(2));
        assert_eq!(
            HwKeyChain::Aptos.path_string(2),
            crate::aptos::aptos_path(2)
        );
        assert_eq!(
            HwKeyChain::Algo.path_string(2),
            crate::algorand::algo_path(2)
        );
        assert_eq!(
            HwKeyChain::Cosmos.path_string(2),
            crate::cosmos::cosmos_path(2)
        );
        // Ledger Live's default NEAR path for account 0.
        assert_eq!(HwKeyChain::Near.path_string(0), "m/44'/397'/0'/0'/1'");
        // `@ton-community/ton-ledger` pathForAccount({ testOnly: false, chain: 0, account: 3 }).
        assert_eq!(HwKeyChain::Ton.path_string(3), "m/44'/607'/0'/0'/3'/0'");
        // Ledger Hedera app: m/44'/3030'/0'/0'/index'.
        assert_eq!(HwKeyChain::Hbar.path_string(2), "m/44'/3030'/0'/0'/2'");
    }

    #[test]
    fn records_are_checked() {
        // NEAR app vector (LedgerHQ/app-near tests/common.py, path 44'/397'/0'/0'/1').
        let pk = hex::decode("c4f5941e81e071c2fd1dae2e71fd3d859d462484391d9a90bf219211dcbb320f")
            .unwrap();
        let m = Network::Mainnet;
        let k = HwWatchKey::new(HwKeyChain::Near, 0, m, &pk).unwrap();
        assert_eq!(k.address, hex::encode(&pk));
        k.validate(0, m).unwrap();
        assert!(k.validate(1, m).is_err());
        let mut bad = k.clone();
        bad.address = "f".repeat(64);
        assert!(bad.validate(0, m).is_err());
        assert!(HwWatchKey::new(HwKeyChain::Cosmos, 0, m, &pk).is_err());
        assert!(validate_keys(&[k.clone(), k], 0, m).is_err());
        // TON: the address depends on the network (wallet id and testnet flag).
        let t = HwWatchKey::new(HwKeyChain::Ton, 0, m, &pk).unwrap();
        assert!(t.address.starts_with("UQ"));
        t.validate(0, m).unwrap();
        assert!(t.validate(0, Network::Testnet).is_err());
        let tt = HwWatchKey::new(HwKeyChain::Ton, 0, Network::Testnet, &pk).unwrap();
        assert!(tt.address.starts_with("0Q"));
    }
}
