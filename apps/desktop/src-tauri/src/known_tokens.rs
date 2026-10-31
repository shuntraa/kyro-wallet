//! Tokens Kyro names itself in the native signing dialogs (symbol, name, decimals).
//!
//! The dialog never uses a symbol or decimals given by the interface: a fake `decimals` could
//! hide a huge amount and a symbol could carry fake lines. A token that is not in this table is
//! shown as « jeton inconnu » with its contract and the raw amount, and needs the reinforced
//! second dialog.
//!
//! Same tokens as `packages/chains/src/registry.ts` (ERC20_TOKENS, SPL_TOKENS, TRC20_TOKENS),
//! plus QNT on Ethereum. EVM contracts are compared case-insensitively (EIP-55 checksum or not),
//! Solana mints and TRON contracts exactly (base58 is case-sensitive).

use wallet_core::Network;

/// Where a token lives.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenChain {
    /// EVM chain id (ERC-20 contract).
    Evm(u64),
    /// SPL / Token-2022 mint.
    Solana,
    /// TRC-20 contract (`T…`).
    Tron,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KnownToken {
    pub symbol: &'static str,
    pub name: &'static str,
    pub decimals: u8,
}

const USDC: KnownToken = KnownToken {
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
};
const USDC18: KnownToken = KnownToken {
    symbol: "USDC",
    name: "USD Coin",
    decimals: 18,
};
const USDT: KnownToken = KnownToken {
    symbol: "USDT",
    name: "Tether",
    decimals: 6,
};
const USDT18: KnownToken = KnownToken {
    symbol: "USDT",
    name: "Tether",
    decimals: 18,
};
const DAI: KnownToken = KnownToken {
    symbol: "DAI",
    name: "Dai",
    decimals: 18,
};
const WBTC: KnownToken = KnownToken {
    symbol: "WBTC",
    name: "Wrapped Bitcoin",
    decimals: 8,
};
const QNT: KnownToken = KnownToken {
    symbol: "QNT",
    name: "Quant",
    decimals: 18,
};
const ARB: KnownToken = KnownToken {
    symbol: "ARB",
    name: "Arbitrum",
    decimals: 18,
};
const OP: KnownToken = KnownToken {
    symbol: "OP",
    name: "Optimism",
    decimals: 18,
};

/// (network, chain, contract or mint, token).
const TOKENS: &[(Network, TokenChain, &str, KnownToken)] = &[
    // ---- EVM testnet: Sepolia (Circle's test USDC)
    (
        Network::Testnet,
        TokenChain::Evm(11_155_111),
        "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
        USDC,
    ),
    // ---- Ethereum
    (
        Network::Mainnet,
        TokenChain::Evm(1),
        "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        USDC,
    ),
    (
        Network::Mainnet,
        TokenChain::Evm(1),
        "0xdAC17F958D2ee523a2206206994597C13D831ec7",
        USDT,
    ),
    (
        Network::Mainnet,
        TokenChain::Evm(1),
        "0x6B175474E89094C44Da98b954EedeAC495271d0F",
        DAI,
    ),
    (
        Network::Mainnet,
        TokenChain::Evm(1),
        "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
        WBTC,
    ),
    (
        Network::Mainnet,
        TokenChain::Evm(1),
        "0x4a220E6096B25EADb88358cb44068A3248254675",
        QNT,
    ),
    // ---- Arbitrum One
    (
        Network::Mainnet,
        TokenChain::Evm(42_161),
        "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
        USDC,
    ),
    (
        Network::Mainnet,
        TokenChain::Evm(42_161),
        "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
        USDT,
    ),
    (
        Network::Mainnet,
        TokenChain::Evm(42_161),
        "0x912CE59144191C1204E64559FE8253a0e49E6548",
        ARB,
    ),
    // ---- Optimism
    (
        Network::Mainnet,
        TokenChain::Evm(10),
        "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
        USDC,
    ),
    (
        Network::Mainnet,
        TokenChain::Evm(10),
        "0x4200000000000000000000000000000000000042",
        OP,
    ),
    // ---- Base
    (
        Network::Mainnet,
        TokenChain::Evm(8_453),
        "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        USDC,
    ),
    // ---- Polygon
    (
        Network::Mainnet,
        TokenChain::Evm(137),
        "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
        USDC,
    ),
    (
        Network::Mainnet,
        TokenChain::Evm(137),
        "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
        USDT,
    ),
    // ---- BNB Chain (Binance-Peg tokens have 18 decimals)
    (
        Network::Mainnet,
        TokenChain::Evm(56),
        "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
        USDC18,
    ),
    (
        Network::Mainnet,
        TokenChain::Evm(56),
        "0x55d398326f99059fF775485246999027B3197955",
        USDT18,
    ),
    // ---- Avalanche C-Chain
    (
        Network::Mainnet,
        TokenChain::Evm(43_114),
        "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
        USDC,
    ),
    (
        Network::Mainnet,
        TokenChain::Evm(43_114),
        "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7",
        USDT,
    ),
    // ---- Solana (devnet: Circle's test USDC)
    (
        Network::Testnet,
        TokenChain::Solana,
        "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
        USDC,
    ),
    (
        Network::Mainnet,
        TokenChain::Solana,
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        USDC,
    ),
    (
        Network::Mainnet,
        TokenChain::Solana,
        "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
        USDT,
    ),
    // ---- TRON. Nile has its own test USDT (checked on chain 2026-10-30: `symbol()` = USDT,
    // `decimals()` = 6), unrelated to mainnet's.
    (
        Network::Mainnet,
        TokenChain::Tron,
        "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
        USDT,
    ),
    (
        Network::Testnet,
        TokenChain::Tron,
        "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf",
        USDT,
    ),
];

fn same_contract(chain: TokenChain, a: &str, b: &str) -> bool {
    match chain {
        TokenChain::Evm(_) => a.eq_ignore_ascii_case(b),
        TokenChain::Solana | TokenChain::Tron => a == b,
    }
}

/// The token at `contract` on `chain`, if Kyro knows it on `network`.
pub fn lookup(network: Network, chain: TokenChain, contract: &str) -> Option<&'static KnownToken> {
    let contract = contract.trim();
    TOKENS
        .iter()
        .find(|(n, c, addr, _)| {
            *n == network && *c == chain && same_contract(chain, addr, contract)
        })
        .map(|(_, _, _, t)| t)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lookups() {
        let usdc = lookup(
            Network::Mainnet,
            TokenChain::Evm(1),
            "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        )
        .unwrap();
        assert_eq!((usdc.symbol, usdc.decimals), ("USDC", 6));
        // Same contract, wrong chain or wrong network: unknown.
        assert!(lookup(
            Network::Mainnet,
            TokenChain::Evm(137),
            "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
        )
        .is_none());
        assert!(lookup(
            Network::Testnet,
            TokenChain::Evm(1),
            "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
        )
        .is_none());
        assert_eq!(
            lookup(
                Network::Mainnet,
                TokenChain::Evm(56),
                "0x55d398326f99059fF775485246999027B3197955"
            )
            .unwrap()
            .decimals,
            18
        );
        // base58 is case-sensitive.
        assert!(lookup(
            Network::Mainnet,
            TokenChain::Tron,
            "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"
        )
        .is_some());
        assert!(lookup(
            Network::Mainnet,
            TokenChain::Tron,
            "tr7nhqjekqxgtci8q8zy4pl8otszgjlj6t"
        )
        .is_none());
        assert_eq!(
            lookup(
                Network::Testnet,
                TokenChain::Solana,
                "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
            )
            .unwrap()
            .symbol,
            "USDC"
        );
    }

    #[test]
    fn table_is_sane() {
        for (i, (n, c, addr, t)) in TOKENS.iter().enumerate() {
            assert!(!t.symbol.is_empty() && t.symbol.chars().all(|c| c.is_ascii_alphanumeric()));
            assert!(t.decimals <= 36);
            match c {
                TokenChain::Evm(_) => {
                    assert!(addr.len() == 42 && addr.starts_with("0x"), "{addr}");
                    assert!(hex::decode(&addr[2..]).is_ok(), "{addr}");
                }
                TokenChain::Tron => assert!(addr.starts_with('T') && addr.len() == 34),
                TokenChain::Solana => assert!((32..=44).contains(&addr.len())),
            }
            for (n2, c2, addr2, _) in &TOKENS[i + 1..] {
                assert!(
                    !(n == n2 && c == c2 && same_contract(*c, addr, addr2)),
                    "duplicate {addr}"
                );
            }
        }
    }
}
