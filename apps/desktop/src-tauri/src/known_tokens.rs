//! Tokens and EVM chains Kyro names itself in the native signing dialogs (symbol, name,
//! decimals, native coin).
//!
//! The dialog never uses a symbol or decimals given by the interface: a fake `decimals` could
//! hide a huge amount and a symbol could carry fake lines. A token that is not in this table is
//! shown as « JETON INCONNU » with its contract and the raw amount, and needs the reinforced
//! second dialog. EVM contracts are compared case-insensitively (EIP-55 checksum or not), Solana
//! mints and TRON contracts exactly (base58 is case-sensitive).
//!
//! Source of truth: `packages/chains/src/registry.ts` (EVM chains, `ERC20_TOKENS`, `SPL_TOKENS`,
//! `TRC20_TOKENS`, both networks: Sepolia, Solana devnet and TRON Nile test tokens included). The
//! table in `known_tokens/data.rs` and the fixture `apps/desktop/src-tauri/fixtures/known_tokens.json`
//! are **generated** from it by `packages/chains/test/known-tokens-table.test.ts` (`pnpm --filter
//! @kyro/chains exec vitest run -u test/known-tokens-table.test.ts`); that test fails when either
//! file is stale, and the tests below check that the Rust table is exactly the fixture.

use wallet_core::Network;

#[rustfmt::skip]
mod data;

/// Chain of a curated token.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TokenChain {
    /// EVM chain, by EIP-155 chain id (ERC-20).
    Evm(u64),
    /// Solana cluster of the network (SPL / Token-2022 mint).
    Solana,
    /// TRON network (TRC-20, base58 `T…` contract).
    Tron,
}

/// What Kyro knows about a curated token. Symbol and decimals were checked on chain against
/// CoinGecko when the token was added to the registry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KnownToken {
    /// Ticker.
    pub symbol: &'static str,
    /// Display name.
    pub name: &'static str,
    /// Decimals.
    pub decimals: u8,
}

/// An EVM chain Kyro lists.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KnownEvmChain {
    /// Mainnet or testnet registry.
    pub network: Network,
    /// EIP-155 chain id.
    pub chain_id: u64,
    /// Display name.
    pub name: &'static str,
    /// Native coin ticker (ETH, POL, BNB, CRO, …).
    pub native_symbol: &'static str,
}

/// One row of the token table.
#[derive(Debug)]
struct Entry {
    network: Network,
    chain: TokenChain,
    /// EIP-55 for EVM, mint (base58) for Solana, `T…` for TRON.
    contract: &'static str,
    token: KnownToken,
}

/// The curated token at `contract` on `chain` of `network`. EVM contracts are compared without
/// regard to case (hex); Solana mints and TRON addresses are exact (base58 is case-sensitive).
pub fn lookup(network: Network, chain: TokenChain, contract: &str) -> Option<&'static KnownToken> {
    let contract = contract.trim();
    data::TOKENS
        .iter()
        .find(|e| {
            e.network == network
                && e.chain == chain
                && match chain {
                    TokenChain::Evm(_) => e.contract.eq_ignore_ascii_case(contract),
                    TokenChain::Solana | TokenChain::Tron => e.contract == contract,
                }
        })
        .map(|e| &e.token)
}

/// The EVM chain with this chain id, if Kyro lists it (chain ids are unique across networks).
pub fn evm_chain(chain_id: u64) -> Option<&'static KnownEvmChain> {
    data::EVM_CHAINS.iter().find(|c| c.chain_id == chain_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use std::collections::HashSet;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct FixtureChain {
        network: Network,
        chain_id: u64,
        name: String,
        native_symbol: String,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct FixtureToken {
        network: Network,
        chain: String,
        contract: String,
        symbol: String,
        name: String,
        decimals: u8,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Fixture {
        evm_chains: Vec<FixtureChain>,
        tokens: Vec<FixtureToken>,
    }

    fn fixture() -> Fixture {
        serde_json::from_str(include_str!("../fixtures/known_tokens.json")).unwrap()
    }

    fn chain_of(s: &str) -> TokenChain {
        match s {
            "solana" => TokenChain::Solana,
            "tron" => TokenChain::Tron,
            evm => TokenChain::Evm(evm.strip_prefix("evm:").unwrap().parse().unwrap()),
        }
    }

    #[test]
    fn table_is_exactly_the_fixture_generated_from_registry_ts() {
        let f = fixture();
        let chains: Vec<_> = f
            .evm_chains
            .iter()
            .map(|c| {
                (
                    c.network,
                    c.chain_id,
                    c.name.as_str(),
                    c.native_symbol.as_str(),
                )
            })
            .collect();
        let table: Vec<_> = data::EVM_CHAINS
            .iter()
            .map(|c| (c.network, c.chain_id, c.name, c.native_symbol))
            .collect();
        assert_eq!(chains, table);
        let tokens: Vec<_> = f
            .tokens
            .iter()
            .map(|t| {
                (
                    t.network,
                    chain_of(&t.chain),
                    t.contract.as_str(),
                    t.symbol.as_str(),
                    t.name.as_str(),
                    t.decimals,
                )
            })
            .collect();
        let table: Vec<_> = data::TOKENS
            .iter()
            .map(|e| {
                (
                    e.network,
                    e.chain,
                    e.contract,
                    e.token.symbol,
                    e.token.name,
                    e.token.decimals,
                )
            })
            .collect();
        assert_eq!(tokens, table);
    }

    #[test]
    fn known_chains_are_the_registry_chains() {
        let mut ids: Vec<u64> = data::EVM_CHAINS.iter().map(|c| c.chain_id).collect();
        let n = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), n, "chain id en double");
        let mut known: Vec<u64> = wallet_core::EVM_KNOWN_CHAINS
            .iter()
            .map(|(id, _)| *id)
            .collect();
        known.sort_unstable();
        assert_eq!(ids, known);
        // Same network family as wallet-core's (a chain of the other family is refused there).
        for c in data::EVM_CHAINS {
            assert_eq!(
                wallet_core::evm_chain_network(c.chain_id),
                Some(c.network),
                "{c:?}"
            );
        }
    }

    #[test]
    fn tokens_are_unique_checksummed_and_on_listed_chains() {
        let mut seen = HashSet::new();
        for e in data::TOKENS {
            let key = match e.chain {
                TokenChain::Evm(_) => e.contract.to_ascii_lowercase(),
                _ => e.contract.to_string(),
            };
            assert!(seen.insert((e.network, e.chain, key)), "{e:?} en double");
            assert!(
                !e.token.symbol.is_empty() && !e.token.name.is_empty(),
                "{e:?}"
            );
            assert!(e.token.decimals <= 30, "{e:?}");
            // The dialog sanitizer would neutralise them anyway; a curated symbol has none.
            assert!(
                !e.token
                    .symbol
                    .chars()
                    .any(|c| c.is_control() || c.is_whitespace()),
                "{e:?}"
            );
            match e.chain {
                TokenChain::Evm(id) => {
                    assert_eq!(evm_chain(id).unwrap().network, e.network, "{e:?}");
                    let checksummed = wallet_core::evm_checksum_address(e.contract).unwrap();
                    assert_eq!(checksummed, e.contract, "{e:?}");
                }
                TokenChain::Solana => {
                    const B58: &str = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
                    assert!((32..=44).contains(&e.contract.len()), "{e:?}");
                    assert!(e.contract.chars().all(|c| B58.contains(c)), "{e:?}");
                }
                TokenChain::Tron => {
                    wallet_core::tron_address_bytes(e.contract).unwrap();
                }
            }
        }
    }

    #[test]
    fn lookups() {
        let usdc = lookup(
            Network::Mainnet,
            TokenChain::Evm(1),
            "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        )
        .unwrap();
        assert_eq!((usdc.symbol, usdc.decimals), ("USDC", 6));
        // Same contract, other network or chain: not listed there.
        let c = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
        assert!(lookup(Network::Testnet, TokenChain::Evm(1), c).is_none());
        assert!(lookup(Network::Mainnet, TokenChain::Evm(10), c).is_none());
        let usdt = lookup(
            Network::Mainnet,
            TokenChain::Tron,
            "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
        )
        .unwrap();
        assert_eq!((usdt.symbol, usdt.decimals), ("USDT", 6));
        // Base58 is case-sensitive.
        let lower = "tr7nhqjekqxgtci8q8zy4pl8otszgjlj6t";
        assert!(lookup(Network::Mainnet, TokenChain::Tron, lower).is_none());
        let nile = "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf";
        assert_eq!(
            lookup(Network::Testnet, TokenChain::Tron, nile).map(|t| (t.symbol, t.decimals)),
            Some(("USDT", 6))
        );
        assert!(lookup(Network::Mainnet, TokenChain::Tron, nile).is_none());
        // Test tokens of the other networks: Circle's Sepolia and devnet USDC.
        let sepolia = "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238";
        assert_eq!(
            lookup(Network::Testnet, TokenChain::Evm(11_155_111), sepolia).map(|t| t.decimals),
            Some(6)
        );
        let devnet = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
        assert_eq!(
            lookup(Network::Testnet, TokenChain::Solana, devnet).map(|t| t.symbol),
            Some("USDC")
        );
        // Binance-Peg stablecoins have 18 decimals.
        let bsc_usdt = "0x55d398326f99059fF775485246999027B3197955";
        assert_eq!(
            lookup(Network::Mainnet, TokenChain::Evm(56), bsc_usdt).map(|t| t.decimals),
            Some(18)
        );
        let mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
        assert_eq!(
            lookup(Network::Mainnet, TokenChain::Solana, mint).map(|t| t.symbol),
            Some("USDC")
        );
        assert_eq!(evm_chain(137).unwrap().native_symbol, "POL");
        assert_eq!(evm_chain(11_155_111).unwrap().network, Network::Testnet);
        assert!(evm_chain(61).is_none());
    }
}
