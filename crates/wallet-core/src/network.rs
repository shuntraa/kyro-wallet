//! Network and Bitcoin account-kind selectors.

use serde::{Deserialize, Serialize};

/// Which family of networks the wallet operates on.
///
/// `Testnet` means: Bitcoin testnet (`tb1…` addresses, `tpub`, BIP44 coin type 1 — the
/// encoding is identical for testnet3 and testnet4), Ethereum Sepolia (chain id 11155111)
/// and Solana devnet. Only Bitcoin derivation depends on it; EVM and Solana keys are the
/// same on every network.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Network {
    /// Bitcoin mainnet, Ethereum mainnet, Solana mainnet-beta.
    Mainnet,
    /// Bitcoin testnet, Ethereum Sepolia, Solana devnet.
    Testnet,
}

impl Network {
    pub(crate) fn btc(self) -> bitcoin::Network {
        match self {
            Network::Mainnet => bitcoin::Network::Bitcoin,
            Network::Testnet => bitcoin::Network::Testnet,
        }
    }

    pub(crate) fn btc_kind(self) -> bitcoin::NetworkKind {
        match self {
            Network::Mainnet => bitcoin::NetworkKind::Main,
            Network::Testnet => bitcoin::NetworkKind::Test,
        }
    }

    /// SLIP-44 coin type used for Bitcoin derivation paths.
    pub(crate) fn btc_coin_type(self) -> u32 {
        match self {
            Network::Mainnet => 0,
            Network::Testnet => 1,
        }
    }
}

/// Bitcoin account kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BtcKind {
    /// Native SegWit v0, P2WPKH, BIP84 (`m/84'/coin'/account'/change/index`).
    Segwit,
    /// Taproot key-path, P2TR, BIP86 (`m/86'/coin'/account'/change/index`).
    Taproot,
}

impl BtcKind {
    pub(crate) fn purpose(self) -> u32 {
        match self {
            BtcKind::Segwit => 84,
            BtcKind::Taproot => 86,
        }
    }
}
