// SPDX-License-Identifier: GPL-3.0-or-later
//
// Chain & asset registry. Same seed / same EVM address on every EVM chain.
// RPC hosts must match the net_fetch allowlist (docs/IPC.md §3).

import { bitcoinServerFor, EMPTY_SERVERS, type Network, type Servers, l10n } from '@kyro/shared';

/**
 * `ltc` / `doge` / `bch` / `dash`: Bitcoin-derived UTXO chains (Rust `ltc_*` / `doge_*` / `bch_*` /
 * `dash_*`, docs/IPC.md §2.4).
 * `tron`: TRX + TRC-20, everything built and signed by Rust (`tron_*`, §2.5).
 */
/** `ada`: Cardano (ADA + native tokens, `ada_*`, §2.7). `xlm`: Stellar (XLM, `stellar_*`, §2.11). */
/** `near`: NEAR Protocol (implicit accounts, `near_*`, §2.11). `sui`: Sui (SUI, `sui_*`, §2.11). */
export type Family = 'btc' | 'evm' | 'sol' | 'ltc' | 'doge' | 'bch' | 'dash' | 'tron' | 'xrp' | 'ada' | 'xlm' | 'near' | 'sui';
/** The Bitcoin-derived UTXO families (one `UtxoAdapter` each, Bitcoin's PSBT shapes). */
export type UtxoFamily = 'ltc' | 'doge' | 'bch' | 'dash';
export const UTXO_FAMILIES: readonly UtxoFamily[] = ['ltc', 'doge', 'bch', 'dash'];
export const isUtxoFamily = (f: Family): f is UtxoFamily => (UTXO_FAMILIES as readonly Family[]).includes(f);

interface ChainBase {
  key: string;
  name: string;
  /** Short network label for status bar / badges. */
  label: string;
  network: Network;
  color: string;
  glyph: string;
  nativeSymbol: string;
  nativeName: string;
  nativeDecimals: number;
  coingeckoId: string;
  /** 1 = launch chains, 2 = other EVM chains on the same address. */
  phase: 1 | 2;
  /** Average block / slot time, for ETA estimates. */
  blockTimeSecs: number;
}

/** Bitcoin: no URL in the registry, Rust picks the server (default mempool.space, or the user's). */
export interface BtcChain extends ChainBase {
  family: 'btc';
}

export interface EvmChain extends ChainBase {
  family: 'evm';
  chainId: number;
  rpcUrl: string;
}

export interface SolChain extends ChainBase {
  family: 'sol';
  rpcUrl: string;
  cluster: 'devnet' | 'mainnet-beta';
}

export type Chain = BtcChain | EvmChain | SolChain | UtxoChain | TronChain | XrpChain | CardanoChain | StellarChain | NearChain | SuiChain;

/** Chains that are listed (price, "Bientôt") but not wired yet. */
export interface WatchOnlyChain {
  key: string;
  name: string;
  symbol: string;
  coingeckoId: string;
  color: string;
  glyph: string;
  watchOnly: true;
  phase: 4;
}

export type AssetKind = 'native' | 'erc20' | 'spl' | 'trc20';

export interface AssetDef {
  /** Unique id, e.g. `btc`, `eth:1`, `erc20:11155111:0x1c7d…`. */
  id: string;
  chainKey: string;
  family: Family;
  kind: AssetKind;
  symbol: string;
  name: string;
  decimals: number;
  coingeckoId: string;
  color: string;
  glyph: string;
  /** Contract (ERC-20, TRC-20 `T…`) or mint (SPL). */
  contract?: string;
  /** Balance shown, but sending not supported yet. */
  readOnly?: boolean;
}

export const NATIVE_EVM_TOKEN = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
export const NATIVE_SOL_MINT = 'So11111111111111111111111111111111111111112';

export const CHAIN_COLORS = {
  bitcoin: '#F7931A',
  ethereum: '#627EEA',
  solana: '#35D0BA',
  usdc: '#2F8BE6',
  arbitrum: '#9FD8FF',
} as const;

const BTC: Record<Network, BtcChain> = {
  testnet: {
    family: 'btc', key: 'bitcoin', name: 'Bitcoin testnet4', label: 'BTC testnet', network: 'testnet', color: CHAIN_COLORS.bitcoin, glyph: '₿',
    nativeSymbol: 'BTC', nativeName: 'Bitcoin', nativeDecimals: 8, coingeckoId: 'bitcoin', phase: 1, blockTimeSecs: 600,
  },
  mainnet: {
    family: 'btc', key: 'bitcoin', name: 'Bitcoin', label: 'BTC', network: 'mainnet', color: CHAIN_COLORS.bitcoin, glyph: '₿',
    nativeSymbol: 'BTC', nativeName: 'Bitcoin', nativeDecimals: 8, coingeckoId: 'bitcoin', phase: 1, blockTimeSecs: 600,
  },
};

const evm = (c: Omit<EvmChain, 'family' | 'nativeDecimals'> & { nativeDecimals?: number }): EvmChain => ({ family: 'evm', nativeDecimals: 18, ...c });

const EVM_TESTNET: EvmChain[] = [
  evm({ key: 'sepolia', name: 'Ethereum Sepolia', label: 'Sepolia', network: 'testnet', color: CHAIN_COLORS.ethereum, glyph: 'Ξ', nativeSymbol: 'ETH', nativeName: 'Ethereum',
    coingeckoId: 'ethereum', phase: 1, blockTimeSecs: 12, chainId: 11155111, rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com' }),
];

const EVM_MAINNET: EvmChain[] = [
  evm({ key: 'ethereum', name: 'Ethereum', label: 'Ethereum', network: 'mainnet', color: CHAIN_COLORS.ethereum, glyph: 'Ξ', nativeSymbol: 'ETH', nativeName: 'Ethereum',
    coingeckoId: 'ethereum', phase: 1, blockTimeSecs: 12, chainId: 1, rpcUrl: 'https://ethereum-rpc.publicnode.com' }),
  evm({ key: 'arbitrum', name: 'Arbitrum One', label: 'Arbitrum', network: 'mainnet', color: CHAIN_COLORS.arbitrum, glyph: 'A', nativeSymbol: 'ETH', nativeName: 'Ethereum',
    coingeckoId: 'ethereum', phase: 2, blockTimeSecs: 0.25, chainId: 42161, rpcUrl: 'https://arbitrum-one-rpc.publicnode.com' }),
  evm({ key: 'optimism', name: 'Optimism', label: 'Optimism', network: 'mainnet', color: '#FF0420', glyph: 'O', nativeSymbol: 'ETH', nativeName: 'Ethereum',
    coingeckoId: 'ethereum', phase: 2, blockTimeSecs: 2, chainId: 10, rpcUrl: 'https://optimism-rpc.publicnode.com' }),
  evm({ key: 'base', name: 'Base', label: 'Base', network: 'mainnet', color: '#3C6CF0', glyph: 'B', nativeSymbol: 'ETH', nativeName: 'Ethereum',
    coingeckoId: 'ethereum', phase: 2, blockTimeSecs: 2, chainId: 8453, rpcUrl: 'https://base-rpc.publicnode.com' }),
  evm({ key: 'polygon', name: 'Polygon', label: 'Polygon', network: 'mainnet', color: '#8247E5', glyph: 'P', nativeSymbol: 'POL', nativeName: 'POL',
    coingeckoId: 'polygon-ecosystem-token', phase: 2, blockTimeSecs: 2, chainId: 137, rpcUrl: 'https://polygon-bor-rpc.publicnode.com' }),
  evm({ key: 'bsc', name: 'BNB Chain', label: 'BNB Chain', network: 'mainnet', color: '#F0B90B', glyph: 'B', nativeSymbol: 'BNB', nativeName: 'BNB',
    coingeckoId: 'binancecoin', phase: 2, blockTimeSecs: 3, chainId: 56, rpcUrl: 'https://bsc-rpc.publicnode.com' }),
  evm({ key: 'avalanche', name: 'Avalanche C-Chain', label: 'Avalanche', network: 'mainnet', color: '#E84142', glyph: 'A', nativeSymbol: 'AVAX', nativeName: 'Avalanche',
    coingeckoId: 'avalanche-2', phase: 2, blockTimeSecs: 2, chainId: 43114, rpcUrl: 'https://avalanche-c-chain-rpc.publicnode.com' }),
  // Other EVM-compatible chains (same address and key). Each RPC was checked on 2026-10-31:
  // `eth_chainId` matches, EIP-1559 (type 2) transactions accepted by the pool (an unfunded
  // type-2 transfer is refused for « insufficient funds », not for its type), JSON-RPC batches
  // answered; reachable over Tor (Flare's and Kaia's own public RPCs answer 403 to Tor exits, hence
  // Ankr for Flare and Pocket Network for Kaia). Not added: Ethereum Classic (61, type 2 refused: « pool not yet in London », Kyro
  // only signs EIP-1559), XDC (50, `xdc…` address format; public RPCs answering 502/520).
  evm({ key: 'cronos', name: 'Cronos', label: 'Cronos', network: 'mainnet', color: '#1D2D5C', glyph: 'C', nativeSymbol: 'CRO', nativeName: 'Cronos',
    coingeckoId: 'crypto-com-chain', phase: 2, blockTimeSecs: 1, chainId: 25, rpcUrl: 'https://cronos-evm-rpc.publicnode.com' }),
  evm({ key: 'mantle', name: 'Mantle', label: 'Mantle', network: 'mainnet', color: '#3F8F87', glyph: 'M', nativeSymbol: 'MNT', nativeName: 'Mantle',
    coingeckoId: 'mantle', phase: 2, blockTimeSecs: 2, chainId: 5000, rpcUrl: 'https://mantle-rpc.publicnode.com' }),
  evm({ key: 'sonic', name: 'Sonic', label: 'Sonic', network: 'mainnet', color: '#24477A', glyph: 'S', nativeSymbol: 'S', nativeName: 'Sonic',
    coingeckoId: 'sonic-3', phase: 2, blockTimeSecs: 1, chainId: 146, rpcUrl: 'https://sonic-rpc.publicnode.com' }),
  evm({ key: 'flare', name: 'Flare', label: 'Flare', network: 'mainnet', color: '#C4234F', glyph: 'F', nativeSymbol: 'FLR', nativeName: 'Flare',
    coingeckoId: 'flare-networks', phase: 2, blockTimeSecs: 1.8, chainId: 14, rpcUrl: 'https://rpc.ankr.com/flare' }),
  evm({ key: 'kaia', name: 'Kaia', label: 'Kaia', network: 'mainnet', color: '#5E7A1F', glyph: 'K', nativeSymbol: 'KAIA', nativeName: 'Kaia',
    coingeckoId: 'kaia', phase: 2, blockTimeSecs: 1, chainId: 8217, rpcUrl: 'https://kaia.api.pocket.network' }),
  evm({ key: 'gnosis', name: 'Gnosis', label: 'Gnosis', network: 'mainnet', color: '#3E6957', glyph: 'G', nativeSymbol: 'XDAI', nativeName: 'xDAI',
    coingeckoId: 'xdai', phase: 2, blockTimeSecs: 5, chainId: 100, rpcUrl: 'https://gnosis-rpc.publicnode.com' }),
  evm({ key: 'hyperevm', name: 'HyperEVM', label: 'HyperEVM', network: 'mainnet', color: '#2E8F7C', glyph: 'H', nativeSymbol: 'HYPE', nativeName: 'Hyperliquid',
    coingeckoId: 'hyperliquid', phase: 2, blockTimeSecs: 1, chainId: 999, rpcUrl: 'https://hyperliquid-rpc.publicnode.com' }),
  evm({ key: 'sei', name: 'Sei EVM', label: 'Sei', network: 'mainnet', color: '#8E2A24', glyph: 'S', nativeSymbol: 'SEI', nativeName: 'Sei',
    coingeckoId: 'sei-network', phase: 2, blockTimeSecs: 0.4, chainId: 1329, rpcUrl: 'https://sei-evm-rpc.publicnode.com' }),
  evm({ key: 'conflux', name: 'Conflux eSpace', label: 'Conflux', network: 'mainnet', color: '#2C4C7E', glyph: 'C', nativeSymbol: 'CFX', nativeName: 'Conflux',
    coingeckoId: 'conflux-token', phase: 2, blockTimeSecs: 1, chainId: 1030, rpcUrl: 'https://evm.confluxrpc.com' }),
];

const SOL: Record<Network, SolChain> = {
  testnet: {
    family: 'sol', key: 'solana', name: 'Solana devnet', label: 'Solana devnet', network: 'testnet', color: CHAIN_COLORS.solana, glyph: 'S',
    nativeSymbol: 'SOL', nativeName: 'Solana', nativeDecimals: 9, coingeckoId: 'solana', phase: 1, blockTimeSecs: 0.4,
    rpcUrl: 'https://api.devnet.solana.com', cluster: 'devnet',
  },
  mainnet: {
    family: 'sol', key: 'solana', name: 'Solana', label: 'Solana', network: 'mainnet', color: CHAIN_COLORS.solana, glyph: 'S',
    nativeSymbol: 'SOL', nativeName: 'Solana', nativeDecimals: 9, coingeckoId: 'solana', phase: 1, blockTimeSecs: 0.4,
    rpcUrl: 'https://api.mainnet-beta.solana.com', cluster: 'mainnet-beta',
  },
};

/** Phase 4: listed with their price, shown as "Bientôt". Empty now: Litecoin, Dogecoin, TRON, XRP, Cardano and Stellar all have a full send path. */
export const WATCH_ONLY_CHAINS: WatchOnlyChain[] = [
];

/**
 * Phase 4 UTXO chains with a full send path: Rust `ltc_*` / `doge_*` / `bch_*` / `dash_*`
 * commands and the `LitecoinAdapter` / `DogecoinAdapter` / `BitcoinCashAdapter` /
 * `DashAdapter`. Part of `allChains()` / `assetsFor()` like Bitcoin.
 * Hardware wallets: not supported yet (HW_UNSUPPORTED), the UI hides them for such accounts.
 */
export interface UtxoChain extends Omit<ChainBase, 'phase'> {
  family: UtxoFamily;
  phase: 4;
}

const utxoChain = (c: Omit<UtxoChain, 'phase' | 'nativeDecimals'>): UtxoChain => ({ ...c, phase: 4, nativeDecimals: 8 });

const LTC_CHAINS: Record<Network, UtxoChain> = {
  testnet: utxoChain({ family: 'ltc', key: 'litecoin', name: 'Litecoin testnet4', label: 'LTC testnet', network: 'testnet', color: '#345D9D', glyph: 'Ł',
    nativeSymbol: 'LTC', nativeName: 'Litecoin', coingeckoId: 'litecoin', blockTimeSecs: 150 }),
  mainnet: utxoChain({ family: 'ltc', key: 'litecoin', name: 'Litecoin', label: 'LTC', network: 'mainnet', color: '#345D9D', glyph: 'Ł',
    nativeSymbol: 'LTC', nativeName: 'Litecoin', coingeckoId: 'litecoin', blockTimeSecs: 150 }),
};

const DOGE_CHAINS: Record<Network, UtxoChain> = {
  testnet: utxoChain({ family: 'doge', key: 'dogecoin', name: 'Dogecoin testnet', label: 'DOGE testnet', network: 'testnet', color: '#C2A633', glyph: 'Ð',
    nativeSymbol: 'DOGE', nativeName: 'Dogecoin', coingeckoId: 'dogecoin', blockTimeSecs: 60 }),
  mainnet: utxoChain({ family: 'doge', key: 'dogecoin', name: 'Dogecoin', label: 'DOGE', network: 'mainnet', color: '#C2A633', glyph: 'Ð',
    nativeSymbol: 'DOGE', nativeName: 'Dogecoin', coingeckoId: 'dogecoin', blockTimeSecs: 60 }),
};

export function ltcChain(network: Network): UtxoChain {
  return LTC_CHAINS[network];
}
export function dogeChain(network: Network): UtxoChain {
  return DOGE_CHAINS[network];
}

/** Bitcoin Cash (BIP44 coin 145, CashAddr, `SIGHASH_FORKID`); testnet = chipnet. */
const BCH_CHAINS: Record<Network, UtxoChain> = {
  testnet: utxoChain({ family: 'bch', key: 'bitcoincash', name: 'Bitcoin Cash chipnet', label: 'BCH chipnet', network: 'testnet', color: '#0AC18E', glyph: 'Ƀ',
    nativeSymbol: 'BCH', nativeName: 'Bitcoin Cash', coingeckoId: 'bitcoin-cash', blockTimeSecs: 600 }),
  mainnet: utxoChain({ family: 'bch', key: 'bitcoincash', name: 'Bitcoin Cash', label: 'BCH', network: 'mainnet', color: '#0AC18E', glyph: 'Ƀ',
    nativeSymbol: 'BCH', nativeName: 'Bitcoin Cash', coingeckoId: 'bitcoin-cash', blockTimeSecs: 600 }),
};

/** Dash (BIP44 coin 5, P2PKH `X…`, legacy sighash). */
const DASH_CHAINS: Record<Network, UtxoChain> = {
  testnet: utxoChain({ family: 'dash', key: 'dash', name: 'Dash testnet', label: 'DASH testnet', network: 'testnet', color: '#008DE4', glyph: 'Đ',
    nativeSymbol: 'DASH', nativeName: 'Dash', coingeckoId: 'dash', blockTimeSecs: 150 }),
  mainnet: utxoChain({ family: 'dash', key: 'dash', name: 'Dash', label: 'DASH', network: 'mainnet', color: '#008DE4', glyph: 'Đ',
    nativeSymbol: 'DASH', nativeName: 'Dash', coingeckoId: 'dash', blockTimeSecs: 150 }),
};

export function bchChain(network: Network): UtxoChain {
  return BCH_CHAINS[network];
}
export function dashChain(network: Network): UtxoChain {
  return DASH_CHAINS[network];
}
/** The UTXO chain of a family on `network`. */
export function utxoChainOf(family: UtxoFamily, network: Network): UtxoChain {
  return { ltc: LTC_CHAINS, doge: DOGE_CHAINS, bch: BCH_CHAINS, dash: DASH_CHAINS }[family][network];
}

/**
 * TRON (phase 4): Rust `tron_*` commands and `TronAdapter` (`packages/chains/src/tron/`).
 * Testnet = Nile. Part of `allChains()` / `assetsFor()` (TRX + the network's USDT, TRC-20).
 * Hardware wallets: not supported yet (HW_UNSUPPORTED), the UI disables TRON for such accounts.
 */
export interface TronChain extends Omit<ChainBase, 'phase'> {
  family: 'tron';
  phase: 4;
}

const TRON_CHAINS: Record<Network, TronChain> = {
  testnet: { family: 'tron', key: 'tron', name: 'TRON Nile', label: 'TRON Nile', network: 'testnet', color: '#EB0029', glyph: 'T',
    nativeSymbol: 'TRX', nativeName: 'TRON', nativeDecimals: 6, coingeckoId: 'tron', phase: 4, blockTimeSecs: 3 },
  mainnet: { family: 'tron', key: 'tron', name: 'TRON', label: 'TRON', network: 'mainnet', color: '#EB0029', glyph: 'T',
    nativeSymbol: 'TRX', nativeName: 'TRON', nativeDecimals: 6, coingeckoId: 'tron', phase: 4, blockTimeSecs: 3 },
};

export function tronChain(network: Network): TronChain {
  return TRON_CHAINS[network];
}

/**
 * XRP Ledger (phase 4): Rust `xrp_*` commands and `XrpAdapter` (`packages/chains/src/xrp/`).
 * Testnet = XRPL Testnet. Part of `allChains()` / `assetsFor()` (XRP; issued currencies are read
 * as trust lines). Hardware wallets: HW_UNSUPPORTED, the UI disables XRP for such accounts.
 */
export interface XrpChain extends Omit<ChainBase, 'phase'> {
  family: 'xrp';
  phase: 4;
}

const XRP_CHAINS: Record<Network, XrpChain> = {
  testnet: { family: 'xrp', key: 'xrp', name: 'XRP Ledger testnet', label: 'XRP testnet', network: 'testnet', color: '#22252B', glyph: 'X',
    nativeSymbol: 'XRP', nativeName: 'XRP', nativeDecimals: 6, coingeckoId: 'ripple', phase: 4, blockTimeSecs: 4 },
  mainnet: { family: 'xrp', key: 'xrp', name: 'XRP Ledger', label: 'XRP', network: 'mainnet', color: '#22252B', glyph: 'X',
    nativeSymbol: 'XRP', nativeName: 'XRP', nativeDecimals: 6, coingeckoId: 'ripple', phase: 4, blockTimeSecs: 4 },
};

export function xrpChain(network: Network): XrpChain {
  return XRP_CHAINS[network];
}

/**
 * Cardano (phase 4): Rust `ada_*` commands and `CardanoAdapter` (`packages/chains/src/cardano/`).
 * Testnet = preprod. Part of `allChains()` / `assetsFor()` (ADA; native tokens are read from the
 * balance, not listed). Single-address mode. Hardware wallets: HW_UNSUPPORTED.
 */
export interface CardanoChain extends Omit<ChainBase, 'phase'> {
  family: 'ada';
  phase: 4;
}

const CARDANO_CHAINS: Record<Network, CardanoChain> = {
  testnet: { family: 'ada', key: 'cardano', name: 'Cardano preprod', label: 'ADA preprod', network: 'testnet', color: '#3468D1', glyph: 'A',
    nativeSymbol: 'ADA', nativeName: 'Cardano', nativeDecimals: 6, coingeckoId: 'cardano', phase: 4, blockTimeSecs: 20 },
  mainnet: { family: 'ada', key: 'cardano', name: 'Cardano', label: 'ADA', network: 'mainnet', color: '#3468D1', glyph: 'A',
    nativeSymbol: 'ADA', nativeName: 'Cardano', nativeDecimals: 6, coingeckoId: 'cardano', phase: 4, blockTimeSecs: 20 },
};

export function cardanoChain(network: Network): CardanoChain {
  return CARDANO_CHAINS[network];
}

/**
 * Stellar (phase 4): Rust `stellar_*` commands and `StellarAdapter` (`packages/chains/src/stellar/`).
 * Testnet = SDF's test network (Friendbot). XLM only (asset id `xlm`); issued assets held by the
 * account are listed by `stellar_account` but not sendable yet. Hardware wallets: HW_UNSUPPORTED.
 */
export interface StellarChain extends Omit<ChainBase, 'phase'> {
  family: 'xlm';
  phase: 4;
}

const STELLAR_CHAINS: Record<Network, StellarChain> = {
  testnet: { family: 'xlm', key: 'stellar', name: 'Stellar testnet', label: 'XLM testnet', network: 'testnet', color: '#7D00FF', glyph: '✦',
    nativeSymbol: 'XLM', nativeName: 'Stellar', nativeDecimals: 7, coingeckoId: 'stellar', phase: 4, blockTimeSecs: 6 },
  mainnet: { family: 'xlm', key: 'stellar', name: 'Stellar', label: 'XLM', network: 'mainnet', color: '#7D00FF', glyph: '✦',
    nativeSymbol: 'XLM', nativeName: 'Stellar', nativeDecimals: 7, coingeckoId: 'stellar', phase: 4, blockTimeSecs: 6 },
};

export function stellarChain(network: Network): StellarChain {
  return STELLAR_CHAINS[network];
}

/**
 * NEAR Protocol (phase 4): Rust `near_*` commands and `NearAdapter` (`packages/chains/src/near/`).
 * Testnet = NEAR testnet. Our address is the implicit account (64 hex of the ed25519 key);
 * named accounts are send destinations only. NEP-141 tokens are not listed (no function-call
 * signing). Hardware wallets: not supported, the UI disables NEAR for such accounts.
 */
export interface NearChain extends Omit<ChainBase, 'phase'> {
  family: 'near';
  phase: 4;
}

const NEAR_CHAINS: Record<Network, NearChain> = {
  testnet: { family: 'near', key: 'near', name: 'NEAR testnet', label: 'NEAR testnet', network: 'testnet', color: '#00C08B', glyph: 'N',
    nativeSymbol: 'NEAR', nativeName: 'NEAR', nativeDecimals: 24, coingeckoId: 'near', phase: 4, blockTimeSecs: 1 },
  mainnet: { family: 'near', key: 'near', name: 'NEAR', label: 'NEAR', network: 'mainnet', color: '#00C08B', glyph: 'N',
    nativeSymbol: 'NEAR', nativeName: 'NEAR', nativeDecimals: 24, coingeckoId: 'near', phase: 4, blockTimeSecs: 1 },
};

export function nearChain(network: Network): NearChain {
  return NEAR_CHAINS[network];
}

/**
 * Sui (phase 4): Rust `sui_*` commands and `SuiAdapter` (`packages/chains/src/sui/`). Testnet =
 * Sui testnet. SUI only (other coins are not listed). Server: the Sui Foundation's GraphQL RPC,
 * reached by Rust only. Hardware wallets: not supported, the UI hides Sui for such accounts.
 */
export interface SuiChain extends Omit<ChainBase, 'phase'> {
  family: 'sui';
  phase: 4;
}

const SUI_CHAINS: Record<Network, SuiChain> = {
  testnet: { family: 'sui', key: 'sui', name: 'Sui testnet', label: 'Sui testnet', network: 'testnet', color: '#4DA2FF', glyph: 'S',
    nativeSymbol: 'SUI', nativeName: 'Sui', nativeDecimals: 9, coingeckoId: 'sui', phase: 4, blockTimeSecs: 1 },
  mainnet: { family: 'sui', key: 'sui', name: 'Sui', label: 'Sui', network: 'mainnet', color: '#4DA2FF', glyph: 'S',
    nativeSymbol: 'SUI', nativeName: 'Sui', nativeDecimals: 9, coingeckoId: 'sui', phase: 4, blockTimeSecs: 1 },
};

export function suiChain(network: Network): SuiChain {
  return SUI_CHAINS[network];
}

interface TokenSpec {
  symbol: string;
  name: string;
  decimals: number;
  coingeckoId: string;
  contract: string;
  color: string;
  glyph: string;
}

const USDC = (contract: string, decimals = 6): TokenSpec => ({ symbol: 'USDC', name: 'USD Coin', decimals, coingeckoId: 'usd-coin', contract, color: CHAIN_COLORS.usdc, glyph: '$' });
const USDT = (contract: string, decimals = 6): TokenSpec => ({ symbol: 'USDT', name: 'Tether', decimals, coingeckoId: 'tether', contract, color: '#26A17B', glyph: '₮' });

/** A curated token; the glyph defaults to the first letter of the symbol (no emoji). */
const tok = (symbol: string, name: string, decimals: number, coingeckoId: string, contract: string, color: string, glyph = symbol.charAt(0).toUpperCase()): TokenSpec => ({
  symbol,
  name,
  decimals,
  coingeckoId,
  contract,
  color,
  glyph,
});

/*
 * Curated tokens: the top 250 of CoinGecko by market cap (2026-10-31) that live on a chain Kyro
 * supports, sorted by market cap. Source of each contract: CoinGecko `detail_platforms`, kept only
 * if it is
 * - the token's own chain (CoinGecko `asset_platform_id`), or
 * - on Arbitrum / Optimism / Base / Polygon, the canonical bridge token of the Ethereum contract
 *   (read on chain: `l1Address()`, `l1Token()` / `remoteToken()`, PoS `childToRootToken()`), or
 * - listed by the issuer itself (Circle USDC / EURC, Tether USDT, Paxos PYUSD / USDG pages), or
 * - GNO on Gnosis and the original ERC-20 of ApeCoin (named exceptions).
 * Other bridged copies (Binance-Peg, `.e`, Wormhole, OFT…) are left out. Every entry was checked
 * on chain on 2026-11-01 against the registry RPC: code present (EVM `eth_getCode`, Solana mint
 * owned by Token / Token-2022, TRON contract), `symbol()` and `decimals()` equal to CoinGecko.
 * Excluded: permissioned / RWA / fund / tokenized-stock tokens, A7A5, Pi, Canton.
 * Pre-existing entries are kept (BNB Chain Binance-Peg USDC / USDT, Arbitrum USD₮0, Polygon PoS
 * USDT, WBTC). The Rust table `known_tokens.rs` is generated from these lists.
 */
export const ERC20_TOKENS: Record<string, TokenSpec[]> = {
  sepolia: [USDC('0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238')],
  ethereum: [
    USDT('0xdAC17F958D2ee523a2206206994597C13D831ec7'),
    USDC('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'),
    tok('USDS', 'USDS', 18, 'usds', '0xdC035D45d973E3EC169d2276DDab16f1e407384F', '#6E6E6E'),
    tok('LINK', 'Chainlink', 18, 'chainlink', '0x514910771AF9Ca656af840dff83E8264EcF986CA', '#7A4F5E'),
    tok('WBT', 'WhiteBIT Coin', 8, 'whitebit', '0x925206b8a707096Ed26ae47C84747fE0bb734F59', '#5B6B8C'),
    tok('LEO', 'LEO Token', 18, 'leo-token', '0x2AF5D2aD76741191D15Dfe7bF6aC92d4Bd912Ca3', '#8C4F4F'),
    { symbol: 'DAI', name: 'Dai', decimals: 18, coingeckoId: 'dai', contract: '0x6B175474E89094C44Da98b954EedeAC495271d0F', color: '#F5AC37', glyph: 'D' },
    tok('USDe', 'Ethena USDe', 18, 'ethena-usde', '0x4c9EDD5852cd905f086C759E8383e09bff1E68B3', '#4F5E7A'),
    tok('UNI', 'Uniswap', 18, 'uniswap', '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', '#5B6B8C'),
    tok('XAUt', 'Tether Gold', 6, 'tether-gold', '0x68749665FF8D2d112Fa859AA293F07A622782F38', '#7A5E4F'),
    tok('USDG', 'Global Dollar', 6, 'global-dollar', '0xe343167631d89B6Ffc58B88d6b7fB0228795491D', '#6E6E6E'),
    tok('QNT', 'Quant', 18, 'quant-network', '0x4a220E6096B25EADb88358cb44068A3248254675', '#6B5B8C'),
    tok('PYUSD', 'PayPal USD', 6, 'paypal-usd', '0x6c3ea9036406852006290770BEdFcAbA0e23A0e8', '#4F7A6B'),
    tok('SHIB', 'Shiba Inu', 18, 'shiba-inu', '0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE', '#8C7F4F'),
    tok('CRO', 'Cronos', 8, 'crypto-com-chain', '0xA0b73E1Ff0B80914AB6fe0444E65848C4C34450b', '#5E7A4F'),
    tok('ENA', 'Ethena', 18, 'ethena', '0x57e114B691Db790C35207b2e685D4A43181e6061', '#8C6B4F'),
    tok('OKB', 'OKB', 18, 'okb', '0x75231F58b43240C9718Dd58B4967c5114342a86c', '#4F5E7A'),
    tok('PEPE', 'Pepe', 18, 'pepe', '0x6982508145454Ce325dDbE47a25d4ec3d2311933', '#5B6B8C'),
    tok('AAVE', 'Aave', 18, 'aave', '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9', '#6E6E6E'),
    tok('ONDO', 'Ondo', 18, 'ondo-finance', '0xfAbA6f8e4a5E8Ab82F62fe7C39859FA577269BE3', '#6B5B8C'),
    tok('USDf', 'Falcon USD', 18, 'falcon-finance', '0xFa2B947eEc368f42195f24F36d2aF29f7c24CeC2', '#4F7A6B'),
    tok('PAXG', 'PAX Gold', 18, 'pax-gold', '0x45804880De22913dAFE09f4980848ECE6EcbAf78', '#6E6E6E'), // fee-on-transfer : Paxos annonce des frais de transfert (0,02 %) prélevés par le contrat, le destinataire peut recevoir un peu moins (non mesuré on-chain)
    tok('MORPHO', 'Morpho', 18, 'morpho', '0x58D97B57BB95320F9a05dC918Aef65434969c2B2', '#8C6B4F'),
    tok('WLFI', 'World Liberty Financial', 18, 'world-liberty-financial', '0xdA5e1988097297dCdc1f90D4dFE7909e847CBeF6', '#4F6F7A'),
    tok('SKY', 'Sky', 18, 'sky', '0x56072C95FAA701256059aa122697B133aDEd9279', '#5E7A4F'),
    tok('MNT', 'Mantle', 18, 'mantle', '0x3c3a81e81dc49A522A592e7622A7E711c06bf354', '#4F7A6B'),
    tok('WLD', 'Worldcoin', 18, 'worldcoin-wld', '0x163f8C2467924be0ae7B5347228CABF260318753', '#5B6B8C'),
    tok('BGB', 'Bitget Token', 18, 'bitget-token', '0x54D2252757e1672EEaD234D27B1270728fF90581', '#7A5E4F'),
    tok('ARB', 'Arbitrum', 18, 'arbitrum', '0xB50721BCf8d664c30412Cfbc6cf7a15145234ad1', '#8C6B4F'),
    tok('GT', 'Gate', 18, 'gatechain-token', '0xE66747a101bFF2dBA3697199DCcE5b743b454759', '#4F7A6B'),
    tok('POL', 'POL (ex-MATIC)', 18, 'polygon-ecosystem-token', '0x455e53CBB86018Ac2B8092FdCd39d8444aFFC3F6', '#5E7A4F'),
    tok('OUSD', 'Open USD', 6, 'open-usd', '0x9f6F3991D525015a6F8CaF062C83b62fD3AC4436', '#4F5E7A'),
    tok('LIT', 'Lighter', 18, 'lighter', '0x232CE3bd40fCd6f80f3d55A522d03f25Df784Ee2', '#6B5B8C'),
    tok('NEXO', 'NEXO', 18, 'nexo', '0xB62132e35a6c13ee1EE0f84dC5d40bad8d815206', '#4F5E7A'),
    tok('ZRO', 'LayerZero', 18, 'layerzero', '0x6985884C4392D348587B19cb9eAAf157F13271cd', '#5B6B8C'),
    tok('INJ', 'Injective', 18, 'injective-protocol', '0xe28b3B32B6c345A34Ff64674606124Dd5Aceca30', '#4F5E7A'),
    tok('GHO', 'GHO', 18, 'gho', '0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f', '#6E6E6E'),
    tok('ETHFI', 'Ether.fi', 18, 'ether-fi', '0xFe0c30065B384F05761f15d0CC899D4F9F9Cc0eB', '#5E7A4F'),
    tok('USD0', 'Usual USD', 18, 'usual-usd', '0x73A15FeD60Bf67631dC6cd7Bc5B6e8da8190aCF5', '#6B5B8C'),
    tok('EURC', 'EURC', 6, 'euro-coin', '0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c', '#4F5E7A', '€'),
    tok('TUSD', 'TrueUSD', 18, 'true-usd', '0x0000000000085d4780B73119b644AE5ecd22b376', '#5B6B8C'),
    tok('CRV', 'Curve DAO', 18, 'curve-dao-token', '0xD533a949740bb3306d119CC777fa900bA034cd52', '#7A5E4F'),
    tok('VIRTUAL', 'Virtuals Protocol', 18, 'virtual-protocol', '0x44ff8620b8cA30902395A7bD3F2407e1A091BF73', '#7A4F5E'),
    tok('FET', 'Artificial Superintelligence Alliance', 18, 'fetch-ai', '0xaea46A60368A7bD060eec7DF8CBa43b7EF41Ad85', '#7A5E4F'),
    tok('DRV', 'Derive', 18, 'derive', '0xB1D1eae60EEA9525032a6DCb4c1CE336a1dE71BE', '#7A5E4F'),
    tok('STRK', 'Starknet', 18, 'starknet', '0xCa14007Eff0dB1f8135f4C25B34De49AB0d42766', '#4F7A6B'),
    tok('SPX', 'SPX6900', 8, 'spx6900', '0xE0f63A424a4439cBE457D80E4f4b51aD25b2c56C', '#7A5E4F'),
    tok('PENDLE', 'Pendle', 18, 'pendle', '0x808507121B80c02388fAd14726482e061B8da827', '#5E7A4F'),
    tok('FF', 'Falcon Finance', 18, 'falcon-finance-ff', '0xFA1C09fC8B491B6A4d3Ff53A10CAd29381b3F949', '#7A5E4F'),
    tok('apxUSD', 'apxUSD', 18, 'apxusd', '0x98A878b1Cd98131B271883B390f68D2c90674665', '#7A5E4F'),
    tok('SOFID', 'SoFiUSD', 6, 'sofiusd', '0x0CB6d03B0aC88A463F67B7Ad99f9f3ec4678092E', '#4F7A6B'),
    tok('FDUSD', 'First Digital USD', 18, 'first-digital-usd', '0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409', '#5B6B8C'),
    tok('OHM', 'Olympus', 9, 'olympus', '0x64aa3364F17a4D01c6f1751Fd97C2BD3D7e7f1D5', '#8C4F4F'),
    tok('GNO', 'Gnosis', 18, 'gnosis', '0x6810e776880C02933D47DB1b9fc05908e5386b96', '#6E6E6E'),
    tok('LDO', 'Lido DAO', 18, 'lido-dao', '0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32', '#6B5B8C'),
    tok('KITE', 'Kite', 18, 'kite-2', '0x118B70dF4F06Fa5678E7d543e6066e028C8ea0c0', '#4F7A6B'),
    tok('BEAM', 'Beam', 18, 'beam-2', '0x62D0A8458eD7719FDAF978fe5929C6D342B0bFcE', '#4F7A6B'),
    tok('FLOKI', 'FLOKI', 9, 'floki', '0xcf0C122c6b73ff809C693DB761e7BaeBe62b6a2E', '#4F7A6B'), // taxe possible au transfert : taxHandler() non nul on-chain (0x834f…b67b, 01/11/2026), le destinataire peut recevoir moins
    tok('GRT', 'The Graph', 18, 'the-graph', '0xc944E90C64B2c07662A292be6244BDf05Cda44a7', '#5E7A4F'),
    tok('FRAX', 'Legacy Frax Dollar', 18, 'frax', '0x853d955aCEf822Db058eb8505911ED77F175b99e', '#4F6F7A'),
    tok('BAT', 'Basic Attention', 18, 'basic-attention-token', '0x0D8775F648430679A709E98d2b0Cb6250d2887EF', '#8C4F4F'),
    tok('ENS', 'Ethereum Name Service', 18, 'ethereum-name-service', '0xC18360217D8F7Ab5e7c516566761Ea12Ce7F9D72', '#5B6B8C'),
    tok('COMP', 'Compound', 18, 'compound-governance-token', '0xc00e94Cb662C3520282E6f5717214004A7f26888', '#7A4F5E'),
    tok('SHFL', 'Shuffle', 18, 'shuffle-2', '0x8881562783028F5c1BCB985d2283D5E170D88888', '#8C4F4F'),
    tok('EIGEN', 'EigenCloud (prev. EigenLayer)', 18, 'eigenlayer', '0xec53bF9167f50cDEB3Ae105f56099aaaB9061F83', '#6E6E6E'),
    tok('EURCV', 'EUR CoinVertible', 18, 'societe-generale-forge-eurcv', '0x5F7827FDeb7c20b443265Fc2F40845B715385Ff2', '#6E6E6E'),
    tok('CVX', 'Convex Finance', 18, 'convex-finance', '0x4e3FBD56CD56c3e72c1403e103b45Db9da5B9D2B', '#4F7A6B'),
    tok('SYRUP', 'Maple Finance', 18, 'syrup', '0x643C4E15d7d62Ad0aBeC4a9BD4b001aA3Ef52d66', '#8C4F4F'),
    tok('BTSE', 'BTSE Token', 8, 'btse-token', '0x666d875C600AA06AC1cf15641361dEC3b00432Ef', '#6B5B8C'),
    tok('JASMY', 'JasmyCoin', 18, 'jasmycoin', '0x7420B4b9a0110cdC71fB720908340C03F9Bc03EC', '#7A5E4F'),
    tok('USAT', 'USAT', 6, 'usa', '0x07041776f5007ACa2A54844F50503a18A72A8b68', '#5B6B8C'),
    tok('ZAMA', 'Zama', 18, 'zama', '0xA12CC123ba206d4031D1c7f6223D1C2Ec249f4f3', '#8C4F4F'),
    tok('ANVL', 'Anvil', 18, 'anvil', '0xAEEAa594e7dc112D67b8547fe9767a02c15B5597', '#4F6F7A'),
    tok('crvUSD', 'crvUSD', 18, 'crvusd', '0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E', '#4F7A6B'),
    tok('TRAC', 'OriginTrail', 18, 'origintrail', '0xaA7a9CA87d3694B5755f213B5D04094b8d0F0A6F', '#4F7A6B'),
    tok('Q', 'Quack AI', 18, 'quack-ai', '0xc07e1300dc138601FA6B0b59f8D0FA477e690589', '#6E6E6E'),
    tok('XCN', 'Onyxcoin', 18, 'chain-2', '0xA2cd3D43c775978A96BdBf12d733D5A1ED94fb18', '#8C6B4F'),
    tok('AXS', 'Axie Infinity', 18, 'axie-infinity', '0xBB0E17EF65F82Ab018d8EDd776e8DD940327B28b', '#4F5E7A'),
    tok('FLUID', 'Fluid', 18, 'instadapp', '0x6f40d4A6237C257fff2dB00FA0510DeEECd303eb', '#8C6B4F'),
    tok('AUSD', 'AUSD', 6, 'agora-dollar', '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a', '#6E6E6E'),
    tok('BORG', 'SwissBorg', 18, 'swissborg', '0x64d0f55Cd8C7133a9D7102b13987235F486F2224', '#4F7A6B'),
    tok('MX', 'MX', 18, 'mx-token', '0x11eeF04c884E24d9B7B4760e7476D06ddF797f36', '#6E6E6E'),
    tok('MANA', 'Decentraland', 18, 'decentraland', '0x0F5D2fB29fb7d3CFeE444a200298f468908cC942', '#4F6F7A'),
    tok('VSN', 'Vision', 18, 'vision-3', '0x699Ccf919C1dfdFa4C374292f42CAdC9899BF753', '#5B6B8C'),
    tok('SENT', 'Sentient', 18, 'sentient', '0x56A3BA04E95d34268A19b2a4474DC979baBDaf76', '#4F7A6B'),
    tok('RAIL', 'Railgun', 18, 'railgun', '0xe76C6c83af64e4C60245D8C7dE953DF673a7A33D', '#8C4F4F'),
    tok('SAND', 'The Sandbox', 18, 'the-sandbox', '0x3845badAde8e6dFF049820680d1F14bD3903a5d0', '#6E6E6E'),
    tok('JPYC', 'JPY Coin', 18, 'jpycoin', '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29', '#5B6B8C'),
    tok('JPYSC', 'JPYSC', 18, 'jpysc', '0x6781d5631BFe47432b089e64e3EaB3b6eDd26177', '#8C7F4F'),
    tok('CHZ', 'Chiliz', 18, 'chiliz', '0x3506424F91fD33084466F402d5D97f05F8e3b4AF', '#4F6F7A'),
    tok('NPC', 'Non-Playable Coin', 18, 'non-playable-coin', '0x8eD97a637A790Be1feff5e888d43629dc05408F6', '#5E7A4F'),
    tok('EDGE', 'edgeX', 18, 'edgex', '0xB0076DE78Dc50581770BBa1D211dDc0aD4F2a241', '#6E6E6E'),
    tok('AIOZ', 'AIOZ Network', 18, 'aioz-network', '0x626E8036dEB333b408Be468F951bdB42433cBF18', '#8C7F4F'),
    tok('H', 'Humanity', 18, 'humanity', '0xE76c5b78f93909d34404E9eb4C1f19e7582a5dE1', '#7A4F5E'),
    tok('CAP', 'Cap', 18, 'cap-4', '0x99991c6AAbba5a096f24f250b73580F5179b9999', '#6B5B8C'),
    tok('APE', 'ApeCoin', 18, 'apecoin', '0x4d224452801ACEd8B2F0aebE155379bb5D594381', '#6E6E6E'),
    tok('1INCH', '1INCH', 18, '1inch', '0x111111111117dC0aa78b770fA6A738034120C302', '#4F6F7A'),
    { symbol: 'WBTC', name: 'Wrapped Bitcoin', decimals: 8, coingeckoId: 'wrapped-bitcoin', contract: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', color: '#F09242', glyph: '₿' }, // hors top 250, déjà présent
  ],
  // canonical bridge: `l1Address()` = Ethereum contract; or issuer list.
  arbitrum: [
    USDT('0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9'), // USD₮0 (déjà présent)
    USDC('0xaf88d065e77c8cC2239327C5EDb3A432268e5831'),
    tok('LINK', 'Chainlink', 18, 'chainlink', '0xf97f4df75117a78c1A5a0DBb814Af92458539FB4', '#7A4F5E'),
    tok('RAIN', 'Rain', 18, 'rain', '0x25118290e6A5f4139381D072181157035864099d', '#5B6B8C'),
    tok('UNI', 'Uniswap', 18, 'uniswap', '0xFa7F8980b0f1E64A2062791cc3b0871572f1F7f0', '#5B6B8C'),
    tok('USDG', 'Global Dollar', 6, 'global-dollar', '0x004B506865409877C9fA29bfb1ebA929984B9bbC', '#6E6E6E'),
    tok('PYUSD', 'PayPal USD', 6, 'paypal-usd', '0x46850aD61C2B7d64d08c9C754F45254596696984', '#4F7A6B'),
    tok('AAVE', 'Aave', 18, 'aave', '0xba5DdD1f9d7F570dc94a51479a000E3BCE967196', '#6E6E6E'),
    { symbol: 'ARB', name: 'Arbitrum', decimals: 18, coingeckoId: 'arbitrum', contract: '0x912CE59144191C1204E64559FE8253a0e49E6548', color: '#1B2A44', glyph: 'A' },
    tok('CRV', 'Curve DAO', 18, 'curve-dao-token', '0x11cDb42B0EB46D95f990BeDD4695A6e3fA034978', '#7A5E4F'),
    tok('PENDLE', 'Pendle', 18, 'pendle', '0x0c880f6761F1af8d9Aa9C466984b80DAb9a8c9e8', '#5E7A4F'),
    tok('GNO', 'Gnosis', 18, 'gnosis', '0xa0b862F60edEf4452F25B4160F177db44DeB6Cf1', '#6E6E6E'),
    tok('LDO', 'Lido DAO', 18, 'lido-dao', '0x13Ad51ed4F1B7e9Dc168d8a00cB3f4dDD85EfA60', '#6B5B8C'),
    tok('GRT', 'The Graph', 18, 'the-graph', '0x9623063377AD1B27544C965cCd7342f7EA7e88C7', '#5E7A4F'),
    tok('COMP', 'Compound', 18, 'compound-governance-token', '0x354A6dA3fcde098F8389cad84b0182725c6C91dE', '#7A4F5E'),
    tok('crvUSD', 'crvUSD', 18, 'crvusd', '0x498Bf2B1e120FeD3ad3D42EA2165E9b73f99C1e5', '#4F7A6B'),
    tok('1INCH', '1INCH', 18, '1inch', '0x6314C31A7a1652cE482cffe247E9CB7c3f4BB9aF', '#4F6F7A'),
  ],
  // canonical bridge: `l1Token()` / `remoteToken()` = Ethereum contract.
  optimism: [
    USDC('0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85'),
    tok('LINK', 'Chainlink', 18, 'chainlink', '0x350a791Bfc2C21F9Ed5d10980Dad2e2638ffa7f6', '#7A4F5E'),
    tok('UNI', 'Uniswap', 18, 'uniswap', '0x6fd9d7AD17242c41f7131d257212c54A0e816691', '#5B6B8C'),
    tok('AAVE', 'Aave', 18, 'aave', '0x76FB31fb4af56892A25e32cFC43De717950c9278', '#6E6E6E'),
    tok('WLD', 'Worldcoin', 18, 'worldcoin-wld', '0xdC6fF44d5d932Cbd77B52E5612Ba0529DC6226F1', '#5B6B8C'),
    tok('CRV', 'Curve DAO', 18, 'curve-dao-token', '0x0994206dfE8De6Ec6920FF4D779B0d950605Fb53', '#7A5E4F'),
    tok('PENDLE', 'Pendle', 18, 'pendle', '0xBC7B1Ff1c6989f006a1185318eD4E7b5796e66E1', '#5E7A4F'),
    tok('LDO', 'Lido DAO', 18, 'lido-dao', '0xFdb794692724153d1488CcdBE0C56c252596735F', '#6B5B8C'),
    { symbol: 'OP', name: 'Optimism', decimals: 18, coingeckoId: 'optimism', contract: '0x4200000000000000000000000000000000000042', color: '#FF0420', glyph: 'O' },
    tok('crvUSD', 'crvUSD', 18, 'crvusd', '0xC52D7F23a2e460248Db6eE192Cb23dD12bDDCbf6', '#4F7A6B'),
    tok('1INCH', '1INCH', 18, '1inch', '0xAd42D013ac31486B73b6b059e748172994736426', '#4F6F7A'),
  ],
  // canonical bridge: `l1Token()` / `remoteToken()` = Ethereum contract; or issuer list.
  base: [
    USDC('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'),
    tok('AAVE', 'Aave', 18, 'aave', '0x63706e401c06ac8513145b7687A14804d17f814b', '#6E6E6E'),
    tok('MORPHO', 'Morpho', 18, 'morpho', '0xBAa5CC21fd487B8Fcc2F632f3F4E8D37262a0842', '#8C6B4F'),
    tok('VVV', 'Venice Token', 18, 'venice-token', '0xacfE6019Ed1A7Dc6f7B508C02d1b04ec88cC21bf', '#5B6B8C'),
    tok('AERO', 'Aerodrome Finance', 18, 'aerodrome-finance', '0x940181a94A35A4569E4529A3CDfB74e38FD98631', '#6B5B8C'),
    tok('EURC', 'EURC', 6, 'euro-coin', '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42', '#4F5E7A', '€'),
    tok('CRV', 'Curve DAO', 18, 'curve-dao-token', '0x8Ee73c484A26e0A5df2Ee2a4960B789967dd0415', '#7A5E4F'),
    tok('VIRTUAL', 'Virtuals Protocol', 18, 'virtual-protocol', '0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b', '#7A4F5E'),
    tok('PENDLE', 'Pendle', 18, 'pendle', '0xA99F6e6785Da0F5d6fB42495Fe424BCE029Eeb3E', '#5E7A4F'),
    tok('COMP', 'Compound', 18, 'compound-governance-token', '0x9e1028F5F1D5eDE59748FFceE5532509976840E0', '#7A4F5E'),
    tok('EIGEN', 'EigenCloud (prev. EigenLayer)', 18, 'eigenlayer', '0x2081Ab0D9EC9e4303234Ab26D86b20B3367946ee', '#6E6E6E'),
    tok('crvUSD', 'crvUSD', 18, 'crvusd', '0x417Ac0e078398C154EdFadD9Ef675d30Be60Af93', '#4F7A6B'),
    tok('TRAC', 'OriginTrail', 18, 'origintrail', '0xA81a52B4dda010896cDd386C7fBdc5CDc835ba23', '#4F7A6B'),
    tok('XCN', 'Onyxcoin', 18, 'chain-2', '0x9c632E6Aaa3eA73f91554f8A3cB2ED2F29605e0C', '#8C6B4F'),
    tok('AWE', 'AWE Network', 18, 'stp-network', '0x1B4617734C43F6159F3a70b7E06d883647512778', '#8C6B4F'),
    tok('1INCH', '1INCH', 18, '1inch', '0xc5fecC3a29Fb57B5024eEc8a2239d4621e111CBE', '#4F6F7A'),
  ],
  // PoS bridge: `childToRootToken()` = Ethereum contract; or issuer list.
  polygon: [
    USDT('0xc2132D05D31c914a87C6611C10748AEb04B58e8F'), // pont PoS (déjà présent)
    USDC('0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'),
    tok('LINK', 'Chainlink', 18, 'chainlink', '0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39', '#7A4F5E'),
    tok('UNI', 'Uniswap', 18, 'uniswap', '0xb33EaAd8d922B1083446DC23f610c2567fB5180f', '#5B6B8C'),
    tok('PYUSD', 'PayPal USD', 6, 'paypal-usd', '0x99aF3EeA856556646C98c8B9b2548Fe815240750', '#4F7A6B'),
    tok('AAVE', 'Aave', 18, 'aave', '0xD6DF932A45C0f255f85145f286eA0b292B21C90B', '#6E6E6E'),
    tok('NEXO', 'NEXO', 18, 'nexo', '0x41b3966B4FF7b427969ddf5da3627d6AEAE9a48E', '#4F5E7A'),
    tok('CRV', 'Curve DAO', 18, 'curve-dao-token', '0x172370d5Cd63279eFa6d502DAB29171933a610AF', '#7A5E4F'),
    tok('LDO', 'Lido DAO', 18, 'lido-dao', '0xC3C7d422809852031b44ab29EEC9F1EfF2A58756', '#6B5B8C'),
    tok('APEPE', 'Ape and Pepe', 18, 'ape-and-pepe', '0xA3f751662e282E83EC3cBc387d225Ca56dD63D3A', '#8C7F4F'),
    tok('GRT', 'The Graph', 18, 'the-graph', '0x5fe2B58c013d7601147DcdD68C143A77499f5531', '#5E7A4F'),
    tok('BAT', 'Basic Attention', 18, 'basic-attention-token', '0x3Cef98bb43d732E2F285eE605a8158cDE967D219', '#8C4F4F'),
    tok('COMP', 'Compound', 18, 'compound-governance-token', '0x8505b9d2254A7Ae468c0E9dd10Ccea3A837aef5c', '#7A4F5E'),
    tok('GEOD', 'Geodnet', 18, 'geodnet', '0xAC0F66379A6d7801D7726d5a943356A172549Adb', '#8C4F4F'),
    tok('crvUSD', 'crvUSD', 18, 'crvusd', '0xc4Ce1D6F5D98D65eE25Cf85e9F2E9DcFEe6Cb5d6', '#4F7A6B'),
    tok('MANA', 'Decentraland', 18, 'decentraland', '0xA1c57f48F0Deb89f569dFbE6E2B7f46D33606fD4', '#4F6F7A'),
    tok('SAND', 'The Sandbox', 18, 'the-sandbox', '0xBbba073C31bF03b8ACf7c28EF0738DeCF3695683', '#6E6E6E'),
    tok('APE', 'ApeCoin', 18, 'apecoin', '0xB7b31a6BC18e48888545CE79e83E06003bE70930', '#6E6E6E'),
  ],
  bsc: [
    USDT('0x55d398326f99059fF775485246999027B3197955', 18), // Binance-Peg (déjà présent)
    USDC('0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', 18), // Binance-Peg (déjà présent)
    tok('USD1', 'USD1', 18, 'usd1-wlfi', '0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d', '#7A5E4F'),
    tok('ASTER', 'Aster', 18, 'aster-2', '0x000Ae314E2A2172a039B26378814C252734f556A', '#5E7A4F'),
    tok('BTW', 'Bitway', 18, 'bitway', '0x444045B0EE1ee319A660a5E3d604CA0ffA35ACaA', '#8C7F4F'),
    tok('U', 'United Stables', 18, 'united-stables', '0xcE24439F2D9C6a2289F741120FE202248B666666', '#7A5E4F'),
    tok('Cake', 'PancakeSwap', 18, 'pancakeswap-token', '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82', '#4F6F7A'),
    tok('BDX', 'Beldex', 9, 'beldex', '0x9d10a1ec41Fe7878429BB457e31F9b050D38c633', '#4F7A6B'),
    tok('币安人生', '币安人生 (BinanceLife)', 18, 'bianrensheng', '0x924fa68a0FC644485b8df8AbfA0A41C2e7744444', '#8C4F4F'),
    tok('UB', 'Unibase', 18, 'unibase', '0x40b8129B786D766267A7a118cF8C07E31CDB6Fde', '#5E7A4F'),
    tok('PIEVERSE', 'Pieverse', 18, 'pieverse', '0x0E63B9C287E32A05E6b9AB8ee8dF88A2760225A9', '#4F6F7A'),
    tok('AKE', 'Akedo', 18, 'akedo', '0x2c3a8Ee94dDD97244a93Bc48298f97d2C412F7Db', '#8C4F4F'),
    tok('KOGE', 'KOGE', 18, 'bnb48-club-token', '0xe6DF05CE8C8301223373CF5B969AFCb1498c5528', '#7A4F5E'),
    tok('TWT', 'Trust Wallet', 18, 'trust-wallet-token', '0x4B0F1812e5Df2A09796481Ff14017e6005508003', '#4F5E7A'),
    tok('COCO', 'coco', 18, 'coco-2', '0x80F1fF15B887CB19295D88C8c16F89d47f6D8888', '#4F6F7A'),
    tok('BR', 'Bedrock', 18, 'bedrock-token', '0xFf7d6A96ae471BbCD7713aF9CB1fEeB16cf56B41', '#8C4F4F'),
    tok('B', 'BUILDon', 18, 'build-on', '0x6bdcCe4A559076e37755a78Ce0c06214E59e4444', '#7A5E4F'),
  ],
  avalanche: [
    USDT('0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7'),
    USDC('0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E'),
    tok('EURC', 'EURC', 6, 'euro-coin', '0xC891EB4cbdEFf6e073e859e987815Ed1505c2ACD', '#4F5E7A', '€'),
    tok('avUSD', 'Avant USD', 18, 'avant-usd', '0x24dE8771bC5DdB3362Db529Fc3358F2df3A0E346', '#6B5B8C'),
  ],
  cronos: [
    USDC('0x3D7F2C478aAfdB65542BCB44bCeeC05849999d2D'),
    tok('EURC', 'EURC', 6, 'euro-coin', '0xA6dE01a2d62C6B5f3525d768f34d276652C554c8', '#4F5E7A', '€'),
  ],
  mantle: [
    tok('USDG', 'Global Dollar', 6, 'global-dollar', '0x063C1d1ef6e9099Ce3E8e9AD5C6173d12C49C086', '#6E6E6E'),
  ],
  sonic: [
    USDC('0x29219dd400f2Bf60E5a23d13Be72B486D4038894'),
  ],
  kaia: [
    USDT('0xd077A400968890Eacc75cdc901F0356c943e4fDb'),
  ],
  gnosis: [
    tok('GNO', 'Gnosis', 18, 'gnosis', '0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb', '#6E6E6E'),
  ],
  hyperevm: [
    USDC('0xb88339CB7199b77E23DB6E890353E22632Ba630f'),
    tok('KNTQ', 'Kinetiq', 18, 'kinetiq', '0x000000000000780555bD0BCA3791f89f9542c2d6', '#8C4F4F'),
  ],
  sei: [
    USDC('0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392'),
  ],
};

/** SPL tokens (Token or Token-2022: the program is read from the mint account). Same selection. */
export const SPL_TOKENS: Record<Network, TokenSpec[]> = {
  testnet: [USDC('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU')],
  mainnet: [
    USDT('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'),
    USDC('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
    tok('USDG', 'Global Dollar', 6, 'global-dollar', '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH', '#6E6E6E'),
    tok('PYUSD', 'PayPal USD', 6, 'paypal-usd', '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo', '#4F7A6B'),
    tok('PUMP', 'Pump.fun', 6, 'pump-fun', 'pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn', '#4F7A6B'),
    tok('USDGO', 'USDGO', 6, 'usdgo', '72puLt71H93Z9CzHuBRTwFpL4TG3WZUhnoCC7p8gxigu', '#6E6E6E'),
    tok('JUP', 'Jupiter', 6, 'jupiter-exchange-solana', 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', '#6E6E6E'),
    tok('PYTH', 'Pyth Network', 6, 'pyth-network', 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3', '#7A4F5E'),
    tok('EURC', 'EURC', 6, 'euro-coin', 'HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr', '#4F5E7A', '€'),
    tok('PENGU', 'Pudgy Penguins', 6, 'pudgy-penguins', '2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv', '#6B5B8C'),
    tok('TRUMP', 'Official Trump', 6, 'official-trump', '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN', '#4F7A6B'),
    tok('RAY', 'Raydium', 6, 'raydium', '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', '#7A4F5E'),
    tok('GRASS', 'Grass', 9, 'grass', 'Grass7B4RdKfBCjTKgSqnXkqjwiGvQyFbuSCUJr3XXjs', '#7A4F5E'),
    tok('Bonk', 'Bonk', 5, 'bonk', 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', '#5B6B8C'),
    tok('CARDS', 'Collector Crypt', 6, 'collector-crypt', 'CARDSccUMFKoPRZxt5vt3ksUbxEFEcnZ3H2pd3dKxYjp', '#7A5E4F'),
    tok('USX', 'USX', 6, 'usx', '6FrrzDk5mQARGc1TDYoyVnSyRdds1t4PbtohCD6p3tgG', '#8C6B4F'),
    tok('JTO', 'Jito', 9, 'jito-governance-token', 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL', '#8C4F4F'),
    tok('ZBCN', 'Zebec Network', 6, 'zebec-network', 'ZBCNpuD7YMXzTHB2fhGkGi78MNsHGLRXUhRewNRm9RU', '#8C7F4F'),
    tok('KMNO', 'Kamino', 6, 'kamino', 'KMNo3nJsBXfcpJTVhZcXLW7RmTwTt4GVFE7suUBo9sS', '#6B5B8C'),
    tok('MET', 'Meteora', 6, 'meteora', 'METvsvVRapdj9cFLzq4Tr43xK4tAjQfwX76z3n6mWQL', '#4F6F7A'),
    tok('2Z', 'DoubleZero', 8, 'doublezero', 'J6pQQ3FAcJQeWPPGppWRb4nM8jU3wLyYbRrLh7feMfvd', '#5E7A4F'),
    tok('CASH', 'CASH', 6, 'cash-4', 'CASHx9KJUStyftLFWGvEVf59SGeG9sh5FfcnZMVPCASH', '#6B5B8C'),
    tok('USELESS', 'Useless Coin', 6, 'useless-3', 'Dz9mQ9NzkBcCsuGPFJ3r1bS4wgqKMHBPiVuniW8Mbonk', '#7A4F5E'),
    tok('Fartcoin', 'Fartcoin', 6, 'fartcoin', '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump', '#5B6B8C'),
    tok('BC', 'BCGame Coin', 6, 'bc-token', 'BCNT4t3rv5Hva8RnUtJUJLnxzeFAabcYp8CghC1SmWin', '#7A5E4F'),
  ],
};

export function btcChain(network: Network): BtcChain {
  return BTC[network];
}
export function evmChains(network: Network): EvmChain[] {
  return network === 'testnet' ? EVM_TESTNET : EVM_MAINNET;
}
/** The L1 Ethereum chain for the network (Sepolia / mainnet). */
export function primaryEvmChain(network: Network): EvmChain {
  const c = evmChains(network)[0];
  if (!c) throw new Error('registre EVM vide');
  return c;
}
export function solChain(network: Network): SolChain {
  return SOL[network];
}
export function allChains(network: Network): Chain[] {
  return [btcChain(network), ...evmChains(network), solChain(network), ltcChain(network), dogeChain(network), bchChain(network), dashChain(network), tronChain(network), xrpChain(network), cardanoChain(network), stellarChain(network), nearChain(network), suiChain(network)];
}
export function findChain(network: Network, key: string): Chain | undefined {
  return allChains(network).find((c) => c.key === key);
}

export function nativeAssetId(chain: Chain): string {
  // TRON: `trx` (the adapter's `tronAssetId()`), not the family name.
  return chain.family === 'evm' ? `eth:${chain.chainId}` : chain.family === 'tron' ? 'trx' : chain.family;
}

/**
 * TRC-20 tokens per network (mainnet: same selection as ERC20_TOKENS; Nile has its own test USDT,
 * unrelated to mainnet's). USDT is `TRON_USDT` (tron/adapter.ts) and the only token
 * commands_tron.rs KNOWN_TOKENS names in the dialog today; the others are shown « non vérifié »
 * there until the dialog reads the generated `known_tokens.rs`.
 */
export const TRC20_TOKENS: Record<Network, TokenSpec[]> = {
  testnet: [USDT('TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf')],
  mainnet: [
    USDT('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'),
    tok('USDD', 'USDD', 18, 'usdd', 'TXDk8mbtRbXeYuMNS83CfKPaYYT8XWv9Hz', '#5B6B8C'),
    tok('HTX', 'HTX DAO', 18, 'htx-dao', 'TUPM7K8REVzD2UdV4R5fe5M8XbnR2DdoJ6', '#4F5E7A'),
    tok('JST', 'JUST', 18, 'just', 'TCFLL5dx5ZJdKnWuesXxi1VPwjLVmWZZy9', '#7A4F5E'),
    tok('BTT', 'BitTorrent', 18, 'bittorrent', 'TAFjULxiVgT4qWk6UZwjqwZXTSaGaqnVp4', '#4F5E7A'),
    tok('SUN', 'Sun Token', 18, 'sun-token', 'TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S', '#4F7A6B'),
    tok('NFT', 'AINFT', 6, 'apenft', 'TFczxzPhnThNSqr5by8tvxsdCFRRz6cPNq', '#4F7A6B'),
  ],
};

/** Every asset Kyro tracks on a network, natives first. */
export function assetsFor(network: Network): AssetDef[] {
  const out: AssetDef[] = [];
  for (const chain of allChains(network)) {
    out.push({
      id: nativeAssetId(chain),
      chainKey: chain.key,
      family: chain.family,
      kind: 'native',
      symbol: chain.nativeSymbol,
      name: chain.family === 'evm' && chain.phase === 2 ? `${chain.nativeName} · ${chain.label}` : chain.nativeName,
      decimals: chain.nativeDecimals,
      coingeckoId: chain.coingeckoId,
      color: chain.color,
      glyph: chain.glyph,
    });
    if (chain.family === 'evm') {
      for (const t of ERC20_TOKENS[chain.key] ?? []) {
        out.push({ id: `erc20:${chain.chainId}:${t.contract.toLowerCase()}`, chainKey: chain.key, family: 'evm', kind: 'erc20', symbol: t.symbol, name: t.name, decimals: t.decimals, coingeckoId: t.coingeckoId, color: t.color, glyph: t.glyph, contract: t.contract });
      }
    }
    if (chain.family === 'tron') {
      for (const t of TRC20_TOKENS[network]) {
        out.push({ id: `trc20:${t.contract}`, chainKey: chain.key, family: 'tron', kind: 'trc20', symbol: t.symbol, name: t.name, decimals: t.decimals, coingeckoId: t.coingeckoId, color: t.color, glyph: t.glyph, contract: t.contract });
      }
    }
    if (chain.family === 'sol') {
      for (const t of SPL_TOKENS[network]) {
        out.push({ id: `spl:${t.contract}`, chainKey: chain.key, family: 'sol', kind: 'spl', symbol: t.symbol, name: t.name, decimals: t.decimals, coingeckoId: t.coingeckoId, color: t.color, glyph: t.glyph, contract: t.contract });
      }
    }
  }
  return out;
}

export function findAsset(network: Network, id: string): AssetDef | undefined {
  return assetsFor(network).find((a) => a.id === id);
}

/** Hosts contacted for a network (+ the user's servers) — shown in Settings › Connexions sortantes. */
export function outgoingHosts(network: Network, servers: Servers = EMPTY_SERVERS): { host: string; purpose: string; custom?: boolean }[] {
  const host = (u: string) => {
    try {
      return new URL(u).host;
    } catch {
      return u;
    }
  };
  const btc = bitcoinServerFor(servers, network);
  const btcHost =
    btc.kind === 'default' ? { host: 'mempool.space', purpose: l10n('Bitcoin : soldes, frais, diffusion (service .onion avec Tor)', 'Bitcoin: balances, fees, broadcast (.onion service with Tor)') }
    : btc.kind === 'electrum' ? { host: `${btc.host}:${btc.port}`, purpose: l10n('Bitcoin : ton serveur Electrum', 'Bitcoin: your Electrum server'), custom: true }
    : btc.kind === 'core' ? { host: host(btc.url), purpose: l10n('Bitcoin : ton nœud Bitcoin Core', 'Bitcoin: your Bitcoin Core node'), custom: true }
    : btc.kind === 'cbf' ? { host: l10n('pairs Bitcoin (P2P)', 'Bitcoin peers (P2P)'), purpose: l10n('Bitcoin : filtres compacts, aucun serveur ne voit tes adresses', 'Bitcoin: compact filters, no server sees your addresses'), custom: true }
    : { host: host(btc.url), purpose: l10n('Bitcoin : ton serveur Esplora', 'Bitcoin: your Esplora server'), custom: true };
  const list: { host: string; purpose: string; custom?: boolean }[] = [{ host: 'api.coingecko.com', purpose: l10n('Prix du top 250', 'Top 250 prices') }, btcHost];
  for (const c of evmChains(network)) {
    const custom = servers.evm[String(c.chainId)]?.url;
    list.push(custom ? { host: host(custom), purpose: l10n(`${c.name} : ton nœud RPC`, `${c.name}: your RPC node`), custom: true } : { host: host(c.rpcUrl), purpose: l10n(`${c.name} : nœud RPC`, `${c.name}: RPC node`) });
  }
  const sol = solChain(network);
  const solCustom = servers.solana[sol.cluster]?.url;
  list.push(solCustom ? { host: host(solCustom), purpose: l10n('Solana : ton nœud RPC', 'Solana: your RPC node'), custom: true } : { host: host(sol.rpcUrl), purpose: l10n('Solana : nœud RPC', 'Solana: RPC node') });
  // Litecoin / Dogecoin: reached by Rust only (ltc_* / doge_*), Tor circuits of their family.
  const nk = network === 'mainnet' ? 'mainnet' : 'testnet';
  const ltc = servers.litecoin?.[nk];
  list.push(ltc?.kind === 'esplora' ? { host: host(ltc.url), purpose: l10n('Litecoin : ton serveur Esplora', 'Litecoin: your Esplora server'), custom: true } : { host: 'litecoinspace.org', purpose: l10n('Litecoin : soldes, frais, diffusion', 'Litecoin: balances, fees, broadcast') });
  const doge = servers.dogecoin?.[nk];
  if (doge?.kind === 'esplora') list.push({ host: host(doge.url), purpose: l10n('Dogecoin : ton serveur Esplora', 'Dogecoin: your Esplora server'), custom: true });
  else if (network === 'mainnet') {
    // Komodo's public ElectrumX servers (Rust only, raw TLS sockets; the second one is a
    // fallback). Every UTXO is checked against its previous transaction before signing.
    list.push({ host: 'doge.electrum1.cipig.net:20060', purpose: l10n('Dogecoin : soldes, historique, frais, diffusion (ElectrumX public de Komodo)', 'Dogecoin: balances, history, fees, broadcast (Komodo public ElectrumX)') });
    list.push({ host: 'doge.electrum2.cipig.net:20060', purpose: l10n('Dogecoin : serveur de secours (ElectrumX public de Komodo)', 'Dogecoin: backup server (Komodo public ElectrumX)') });
  } else list.push({ host: l10n('aucun serveur', 'no server'), purpose: l10n('Dogecoin testnet : aucun serveur public gratuit, configure le tien (rien n’est contacté)', 'Dogecoin testnet: no free public server, set up your own (nothing is contacted)') });
  // Bitcoin Cash: public Fulcrum servers (Rust only, raw TLS sockets, tried in order). Genesis
  // and a block after the 2017 split checked on every session; CashTokens coins left out.
  const bch = servers.bitcoincash?.[nk];
  if (bch?.kind === 'esplora') list.push({ host: host(bch.url), purpose: 'Bitcoin Cash : ton serveur Esplora', custom: true });
  else if (network === 'mainnet') {
    list.push({ host: 'bch.imaginary.cash:50002', purpose: 'Bitcoin Cash : soldes, historique, frais, diffusion (Fulcrum public)' });
    list.push({ host: 'bch.loping.net:50002', purpose: 'Bitcoin Cash : serveur de secours (Fulcrum public)' });
    list.push({ host: 'cashnode.bch.ninja:50002', purpose: 'Bitcoin Cash : serveur de secours (Fulcrum public)' });
  } else {
    list.push({ host: 'chipnet.imaginary.cash:50002', purpose: 'Bitcoin Cash chipnet : soldes, historique, frais, diffusion (Fulcrum public)' });
    list.push({ host: 'chipnet.bch.ninja:50002', purpose: 'Bitcoin Cash chipnet : serveur de secours (Fulcrum public)' });
  }
  // Dash: Komodo's public ElectrumX servers on mainnet (Rust only); none on testnet.
  const dash = servers.dash?.[nk];
  if (dash?.kind === 'esplora') list.push({ host: host(dash.url), purpose: 'Dash : ton serveur Esplora', custom: true });
  else if (network === 'mainnet') {
    list.push({ host: 'dash.electrum1.cipig.net:20061', purpose: 'Dash : soldes, historique, frais, diffusion (ElectrumX public de Komodo)' });
    list.push({ host: 'dash.electrum2.cipig.net:20061', purpose: 'Dash : serveur de secours (ElectrumX public de Komodo)' });
  } else list.push({ host: 'aucun serveur', purpose: 'Dash testnet : aucun serveur public gratuit, configure le tien (rien n’est contacté)' });
  // TRON: reached by Rust only (tron_*), Tor circuits of the `tron` family.
  // Cardano: reached by Rust only (ada_*), Tor circuits of the `cardano` family.
  const ada = servers.cardano?.[nk];
  list.push(
    ada?.kind === 'koios'
      ? { host: host(ada.url), purpose: l10n('Cardano : ton serveur Koios', 'Cardano: your Koios server'), custom: true }
      : { host: network === 'mainnet' ? 'api.koios.rest' : 'preprod.koios.rest', purpose: l10n(`Cardano${network === 'mainnet' ? '' : ' preprod'} : UTxO, paramètres, historique, diffusion (Koios)`, `Cardano${network === 'mainnet' ? '' : ' preprod'}: UTxOs, parameters, history, broadcast (Koios)`) },
  );
  // XRP Ledger: reached by Rust only (xrp_*), Tor circuits of the `xrp` family.
  const xrp = servers.xrp?.[nk];
  list.push(
    xrp?.kind === 'jsonRpc'
      ? { host: host(xrp.url), purpose: l10n('XRP Ledger : ton serveur rippled', 'XRP Ledger: your rippled server'), custom: true }
      : { host: network === 'mainnet' ? 'xrplcluster.com' : 's.altnet.rippletest.net', purpose: l10n(`XRP Ledger${network === 'mainnet' ? '' : ' testnet'} : soldes, réserve, historique, diffusion (rippled)`, `XRP Ledger${network === 'mainnet' ? '' : ' testnet'}: balances, reserve, history, broadcast (rippled)`) },
  );
  // Stellar: reached by Rust only (stellar_*), Tor circuits of the `stellar` family; SDF's Horizon.
  list.push({ host: network === 'mainnet' ? 'horizon.stellar.org' : 'horizon-testnet.stellar.org', purpose: l10n(`Stellar${network === 'mainnet' ? '' : ' testnet'} : soldes, réserve, historique, diffusion (Horizon de la SDF)`, `Stellar${network === 'mainnet' ? '' : ' testnet'}: balances, reserve, history, broadcast (SDF Horizon)`) });
  // NEAR: reached by Rust only (near_*), Tor circuits of the `near` family. Defaults only.
  list.push({ host: network === 'mainnet' ? 'free.rpc.fastnear.com' : 'test.rpc.fastnear.com', purpose: `NEAR${network === 'mainnet' ? '' : ' testnet'} : solde, clé d’accès, frais, diffusion (RPC FastNEAR)` });
  list.push({ host: network === 'mainnet' ? 'tx.main.fastnear.com' : 'tx.test.fastnear.com', purpose: `NEAR${network === 'mainnet' ? '' : ' testnet'} : historique des transactions (API FastNEAR)` });
  const tron = servers.tron?.[nk];
  list.push(
    tron?.kind === 'http'
      ? { host: host(tron.url), purpose: l10n('TRON : ton nœud java-tron (l’historique exige l’API /v1 de TronGrid)', 'TRON: your java-tron node (history requires the TronGrid /v1 API)'), custom: true }
      : { host: network === 'mainnet' ? 'api.trongrid.io' : 'nile.trongrid.io', purpose: l10n(`TRON${network === 'mainnet' ? '' : ' Nile'} : soldes, ressources, historique, diffusion (TronGrid)`, `TRON${network === 'mainnet' ? '' : ' Nile'}: balances, resources, history, broadcast (TronGrid)`) },
  );
  // Sui: reached by Rust only (sui_*), Tor circuits of the `sui` family. No custom server yet.
  list.push({ host: network === 'mainnet' ? 'graphql.mainnet.sui.io' : 'graphql.testnet.sui.io', purpose: `Sui${network === 'mainnet' ? '' : ' testnet'} : solde, pièces de gaz, simulation, historique, envoi (GraphQL de la Sui Foundation)` });
  list.push({ host: 'api.0x.org', purpose: l10n('Devis de swap EVM (clé requise)', 'EVM swap quotes (key required)') });
  list.push({ host: 'li.quest', purpose: l10n('Devis de swap (même chaîne et entre chaînes), suivi des swaps entre chaînes', 'Swap quotes (same chain and cross-chain), cross-chain swap tracking') });
  list.push({ host: '1click.chaindefuser.com', purpose: l10n('Swap entre chaînes (NEAR Intents) : devis des routes directes (BTC, LTC, DOGE, TRON, XRP, Cardano), confirmation du dépôt (destinataire, montant, minimum, frais), suivi', 'Cross-chain swaps (NEAR Intents): quotes for direct routes (BTC, LTC, DOGE, TRON, XRP, Cardano), deposit confirmation (recipient, amount, minimum, fees), tracking') });
  list.push({ host: 'lite-api.jup.ag', purpose: l10n('Devis de swap Solana', 'Solana swap quotes') });
  return list;
}
