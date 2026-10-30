// SPDX-License-Identifier: GPL-3.0-or-later
//
// Chain & asset registry. Same seed / same EVM address on every EVM chain.
// RPC hosts must match the net_fetch allowlist (docs/IPC.md §3).

import type { Network } from '@kyro/shared';

export type Family = 'btc' | 'evm' | 'sol';

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

export interface BtcChain extends ChainBase {
  family: 'btc';
  esploraUrl: string;
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

export type Chain = BtcChain | EvmChain | SolChain;

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

export type AssetKind = 'native' | 'erc20' | 'spl';

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
  /** Contract (ERC-20) or mint (SPL). */
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
    esploraUrl: 'https://mempool.space/testnet4/api',
  },
  mainnet: {
    family: 'btc', key: 'bitcoin', name: 'Bitcoin', label: 'BTC', network: 'mainnet', color: CHAIN_COLORS.bitcoin, glyph: '₿',
    nativeSymbol: 'BTC', nativeName: 'Bitcoin', nativeDecimals: 8, coingeckoId: 'bitcoin', phase: 1, blockTimeSecs: 600,
    esploraUrl: 'https://mempool.space/api',
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

/** Phase 4: listed with their price, shown as "Bientôt". */
export const WATCH_ONLY_CHAINS: WatchOnlyChain[] = [
  { key: 'litecoin', name: 'Litecoin', symbol: 'LTC', coingeckoId: 'litecoin', color: '#345D9D', glyph: 'Ł', watchOnly: true, phase: 4 },
  { key: 'dogecoin', name: 'Dogecoin', symbol: 'DOGE', coingeckoId: 'dogecoin', color: '#C2A633', glyph: 'Ð', watchOnly: true, phase: 4 },
  { key: 'tron', name: 'TRON', symbol: 'TRX', coingeckoId: 'tron', color: '#EB0029', glyph: 'T', watchOnly: true, phase: 4 },
  { key: 'cardano', name: 'Cardano', symbol: 'ADA', coingeckoId: 'cardano', color: '#3468D1', glyph: 'A', watchOnly: true, phase: 4 },
  { key: 'xrp', name: 'XRP', symbol: 'XRP', coingeckoId: 'ripple', color: '#22252B', glyph: 'X', watchOnly: true, phase: 4 },
];

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

/** SPL tokens (read-only for now). */
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
  return [btcChain(network), ...evmChains(network), solChain(network)];
}
export function findChain(network: Network, key: string): Chain | undefined {
  return allChains(network).find((c) => c.key === key);
}

export function nativeAssetId(chain: Chain): string {
  return chain.family === 'btc' ? 'btc' : chain.family === 'sol' ? 'sol' : `eth:${chain.chainId}`;
}

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
    if (chain.family === 'sol') {
      for (const t of SPL_TOKENS[network]) {
        out.push({ id: `spl:${t.contract}`, chainKey: chain.key, family: 'sol', kind: 'spl', symbol: t.symbol, name: t.name, decimals: t.decimals, coingeckoId: t.coingeckoId, color: t.color, glyph: t.glyph, contract: t.contract, readOnly: true });
      }
    }
  }
  return out;
}

export function findAsset(network: Network, id: string): AssetDef | undefined {
  return assetsFor(network).find((a) => a.id === id);
}

/** Hosts contacted for a network (+ user overrides) — shown in Settings › Connexions sortantes. */
export function outgoingHosts(network: Network, overrides: { ethereum?: string; solana?: string; esplora?: string } = {}): { host: string; purpose: string }[] {
  const host = (u: string) => {
    try {
      return new URL(u).host;
    } catch {
      return u;
    }
  };
  const list: { host: string; purpose: string }[] = [
    { host: 'api.coingecko.com', purpose: 'Prix du top 200' },
    { host: host(overrides.esplora || btcChain(network).esploraUrl), purpose: 'Bitcoin : soldes, frais, diffusion' },
  ];
  evmChains(network).forEach((c, i) => {
    list.push({ host: host(i === 0 && overrides.ethereum ? overrides.ethereum : c.rpcUrl), purpose: `${c.name} : nœud RPC` });
  });
  list.push({ host: host(overrides.solana || solChain(network).rpcUrl), purpose: 'Solana : nœud RPC' });
  list.push({ host: 'api.0x.org', purpose: 'Devis de swap EVM (clé requise)' });
  list.push({ host: 'api.1inch.dev', purpose: 'Devis de swap EVM (clé requise)' });
  list.push({ host: 'li.quest', purpose: 'Devis de swap cross-chain' });
  list.push({ host: 'lite-api.jup.ag', purpose: 'Devis de swap Solana' });
  return list;
}
