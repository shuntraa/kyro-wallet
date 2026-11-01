// SPDX-License-Identifier: GPL-3.0-or-later
//
// Chain & asset registry. Same seed / same EVM address on every EVM chain.
// RPC hosts must match the net_fetch allowlist (docs/IPC.md §3).

import { bitcoinServerFor, EMPTY_SERVERS, type Network, type Servers } from '@kyro/shared';

/**
 * `ltc` / `doge`: Bitcoin-derived UTXO chains (Rust `ltc_*` / `doge_*`, docs/IPC.md §2.4).
 * `tron`: TRX + TRC-20, everything built and signed by Rust (`tron_*`, §2.5).
 */
/** `ada`: Cardano (ADA + native tokens, `ada_*`, §2.7). */
/** `near`: NEAR Protocol (implicit accounts, `near_*`, §2.11). */
export type Family = 'btc' | 'evm' | 'sol' | 'ltc' | 'doge' | 'tron' | 'xrp' | 'ada' | 'near';

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

export type Chain = BtcChain | EvmChain | SolChain | UtxoChain | TronChain | XrpChain | CardanoChain | NearChain;

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

/** Phase 4: listed with their price, shown as "Bientôt". Empty now: Litecoin, Dogecoin, TRON, XRP and Cardano all have a full send path. */
export const WATCH_ONLY_CHAINS: WatchOnlyChain[] = [
];

/**
 * Phase 4 UTXO chains with a full send path: Rust `ltc_*` / `doge_*` commands and the
 * `LitecoinAdapter` / `DogecoinAdapter`. Part of `allChains()` / `assetsFor()` like Bitcoin.
 * Hardware wallets: not supported yet (HW_UNSUPPORTED), the UI hides them for such accounts.
 */
export interface UtxoChain extends Omit<ChainBase, 'phase'> {
  family: 'ltc' | 'doge';
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

/** Curated ERC-20 list per EVM chain (small on purpose: no spam tokens). */
export const ERC20_TOKENS: Record<string, TokenSpec[]> = {
  sepolia: [USDC('0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238')],
  ethereum: [
    USDC('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'),
    USDT('0xdAC17F958D2ee523a2206206994597C13D831ec7'),
    { symbol: 'DAI', name: 'Dai', decimals: 18, coingeckoId: 'dai', contract: '0x6B175474E89094C44Da98b954EedeAC495271d0F', color: '#F5AC37', glyph: 'D' },
    { symbol: 'WBTC', name: 'Wrapped Bitcoin', decimals: 8, coingeckoId: 'wrapped-bitcoin', contract: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', color: '#F09242', glyph: '₿' },
    // Quant: name/symbol/decimals read from the contract on Ethereum mainnet (31/10/2026).
    { symbol: 'QNT', name: 'Quant', decimals: 18, coingeckoId: 'quant-network', contract: '0x4a220E6096B25EADb88358cb44068A3248254675', color: '#5C6670', glyph: 'Q' },
  ],
  arbitrum: [
    USDC('0xaf88d065e77c8cC2239327C5EDb3A432268e5831'),
    USDT('0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9'),
    { symbol: 'ARB', name: 'Arbitrum', decimals: 18, coingeckoId: 'arbitrum', contract: '0x912CE59144191C1204E64559FE8253a0e49E6548', color: '#1B2A44', glyph: 'A' },
  ],
  optimism: [
    USDC('0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85'),
    { symbol: 'OP', name: 'Optimism', decimals: 18, coingeckoId: 'optimism', contract: '0x4200000000000000000000000000000000000042', color: '#FF0420', glyph: 'O' },
  ],
  base: [USDC('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')],
  polygon: [USDC('0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'), USDT('0xc2132D05D31c914a87C6611C10748AEb04B58e8F')],
  bsc: [USDC('0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', 18), USDT('0x55d398326f99059fF775485246999027B3197955', 18)],
  avalanche: [USDC('0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E'), USDT('0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7')],
};

/** SPL tokens (Token or Token-2022: the program is read from the mint account). */
export const SPL_TOKENS: Record<Network, TokenSpec[]> = {
  testnet: [USDC('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU')],
  mainnet: [USDC('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), USDT('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB')],
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
  return [btcChain(network), ...evmChains(network), solChain(network), ltcChain(network), dogeChain(network), tronChain(network), xrpChain(network), cardanoChain(network), nearChain(network)];
}
export function findChain(network: Network, key: string): Chain | undefined {
  return allChains(network).find((c) => c.key === key);
}

export function nativeAssetId(chain: Chain): string {
  // TRON: `trx` (the adapter's `tronAssetId()`), not the family name.
  return chain.family === 'evm' ? `eth:${chain.chainId}` : chain.family === 'tron' ? 'trx' : chain.family;
}

/**
 * TRC-20 tokens shown per network: USDT only (Nile has its own test USDT, unrelated to
 * mainnet's). Same contracts as `TRON_USDT` (tron/adapter.ts) and Rust's KNOWN_TOKENS, the only
 * tokens Rust names in the dialog.
 */
export const TRC20_TOKENS: Record<Network, TokenSpec[]> = {
  testnet: [USDT('TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf')],
  mainnet: [USDT('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t')],
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
    btc.kind === 'default' ? { host: 'mempool.space', purpose: 'Bitcoin : soldes, frais, diffusion (service .onion avec Tor)' }
    : btc.kind === 'electrum' ? { host: `${btc.host}:${btc.port}`, purpose: 'Bitcoin : ton serveur Electrum', custom: true }
    : btc.kind === 'core' ? { host: host(btc.url), purpose: 'Bitcoin : ton nœud Bitcoin Core', custom: true }
    : btc.kind === 'cbf' ? { host: 'pairs Bitcoin (P2P)', purpose: 'Bitcoin : filtres compacts, aucun serveur ne voit tes adresses', custom: true }
    : { host: host(btc.url), purpose: 'Bitcoin : ton serveur Esplora', custom: true };
  const list: { host: string; purpose: string; custom?: boolean }[] = [{ host: 'api.coingecko.com', purpose: 'Prix du top 200' }, btcHost];
  for (const c of evmChains(network)) {
    const custom = servers.evm[String(c.chainId)]?.url;
    list.push(custom ? { host: host(custom), purpose: `${c.name} : ton nœud RPC`, custom: true } : { host: host(c.rpcUrl), purpose: `${c.name} : nœud RPC` });
  }
  const sol = solChain(network);
  const solCustom = servers.solana[sol.cluster]?.url;
  list.push(solCustom ? { host: host(solCustom), purpose: 'Solana : ton nœud RPC', custom: true } : { host: host(sol.rpcUrl), purpose: 'Solana : nœud RPC' });
  // Litecoin / Dogecoin: reached by Rust only (ltc_* / doge_*), Tor circuits of their family.
  const nk = network === 'mainnet' ? 'mainnet' : 'testnet';
  const ltc = servers.litecoin?.[nk];
  list.push(ltc?.kind === 'esplora' ? { host: host(ltc.url), purpose: 'Litecoin : ton serveur Esplora', custom: true } : { host: 'litecoinspace.org', purpose: 'Litecoin : soldes, frais, diffusion' });
  const doge = servers.dogecoin?.[nk];
  if (doge?.kind === 'esplora') list.push({ host: host(doge.url), purpose: 'Dogecoin : ton serveur Esplora', custom: true });
  else if (network === 'mainnet') {
    // Komodo's public ElectrumX servers (Rust only, raw TLS sockets; the second one is a
    // fallback). Every UTXO is checked against its previous transaction before signing.
    list.push({ host: 'doge.electrum1.cipig.net:20060', purpose: 'Dogecoin : soldes, historique, frais, diffusion (ElectrumX public de Komodo)' });
    list.push({ host: 'doge.electrum2.cipig.net:20060', purpose: 'Dogecoin : serveur de secours (ElectrumX public de Komodo)' });
  } else list.push({ host: 'aucun serveur', purpose: 'Dogecoin testnet : aucun serveur public gratuit, configure le tien (rien n’est contacté)' });
  // TRON: reached by Rust only (tron_*), Tor circuits of the `tron` family.
  // Cardano: reached by Rust only (ada_*), Tor circuits of the `cardano` family.
  const ada = servers.cardano?.[nk];
  list.push(
    ada?.kind === 'koios'
      ? { host: host(ada.url), purpose: 'Cardano : ton serveur Koios', custom: true }
      : { host: network === 'mainnet' ? 'api.koios.rest' : 'preprod.koios.rest', purpose: `Cardano${network === 'mainnet' ? '' : ' preprod'} : UTxO, paramètres, historique, diffusion (Koios)` },
  );
  // XRP Ledger: reached by Rust only (xrp_*), Tor circuits of the `xrp` family.
  const xrp = servers.xrp?.[nk];
  list.push(
    xrp?.kind === 'jsonRpc'
      ? { host: host(xrp.url), purpose: 'XRP Ledger : ton serveur rippled', custom: true }
      : { host: network === 'mainnet' ? 'xrplcluster.com' : 's.altnet.rippletest.net', purpose: `XRP Ledger${network === 'mainnet' ? '' : ' testnet'} : soldes, réserve, historique, diffusion (rippled)` },
  );
  // NEAR: reached by Rust only (near_*), Tor circuits of the `near` family. Defaults only.
  list.push({ host: network === 'mainnet' ? 'free.rpc.fastnear.com' : 'test.rpc.fastnear.com', purpose: `NEAR${network === 'mainnet' ? '' : ' testnet'} : solde, clé d’accès, frais, diffusion (RPC FastNEAR)` });
  list.push({ host: network === 'mainnet' ? 'tx.main.fastnear.com' : 'tx.test.fastnear.com', purpose: `NEAR${network === 'mainnet' ? '' : ' testnet'} : historique des transactions (API FastNEAR)` });
  const tron = servers.tron?.[nk];
  list.push(
    tron?.kind === 'http'
      ? { host: host(tron.url), purpose: 'TRON : ton nœud java-tron (l’historique exige l’API /v1 de TronGrid)', custom: true }
      : { host: network === 'mainnet' ? 'api.trongrid.io' : 'nile.trongrid.io', purpose: `TRON${network === 'mainnet' ? '' : ' Nile'} : soldes, ressources, historique, diffusion (TronGrid)` },
  );
  list.push({ host: 'api.0x.org', purpose: 'Devis de swap EVM (clé requise)' });
  list.push({ host: 'li.quest', purpose: 'Devis de swap cross-chain' });
  list.push({ host: 'lite-api.jup.ag', purpose: 'Devis de swap Solana' });
  return list;
}
