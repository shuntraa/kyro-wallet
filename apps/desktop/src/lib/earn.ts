// SPDX-License-Identifier: GPL-3.0-or-later
// Earn screen: the catalogue of options, rate maths and on-chain reads (Lido, Aave v3 on Ethereum).
// Writes never use these addresses: Rust builds every call from its own pinned table (earn_evm.rs).

import { netFetch, type EarnEvmAction } from '@kyro/shared';

export type EarnType = 'staking' | 'liquid' | 'lending';
export type EarnFilter = 'all' | 'staking' | 'stable';
export type AaveAsset = Extract<EarnEvmAction, { kind: 'aaveSupply' }>['asset'];

export interface EarnOption {
  id: string;
  symbol: string;
  name: string;
  type: EarnType;
  stable: boolean;
  /** Where "Start" leads: an existing staking tab, or the EVM flow. */
  target: { kind: 'tab'; chain: 'sol' | 'ada' | 'tron' | 'near' } | { kind: 'lido' } | { kind: 'aave'; market: string };
  decimals: number;
  /** i18n key of the lock / unbond time. */
  lockKey: 'earn.lockNone' | 'earn.lockLido' | 'earn.lockSol' | 'earn.lockTron' | 'earn.lockNear';
  /** Minimum, human text (symbol included), or null when there is none. */
  min: string | null;
}

/** Aave v3 markets offered, by option id (read only; checked on-chain 2026-11-03). Lowercase.
 * Writes use Rust's own table (earn_evm.rs). */
export interface AaveMarket {
  chainKey: 'ethereum' | 'arbitrum' | 'base' | 'polygon';
  chainId: number;
  pool: string;
  symbol: AaveAsset;
  asset: string;
  aToken: string;
  decimals: number;
}
const POOL_ETH = '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2';
const POOL_ARB_POLYGON = '0x794a61358d6845594f94dc1db02a252b5b4814ad';
const POOL_BASE = '0xa238dd80c259a72e81d7e4664a9801593f98d1c5';
export const AAVE_MARKETS: Record<string, AaveMarket> = {
  'usdt-aave': { chainKey: 'ethereum', chainId: 1, pool: POOL_ETH, symbol: 'USDT', asset: '0xdac17f958d2ee523a2206206994597c13d831ec7', aToken: '0x23878914efe38d27c4d67ab83ed1b93a74d4086a', decimals: 6 },
  'usdc-aave': { chainKey: 'ethereum', chainId: 1, pool: POOL_ETH, symbol: 'USDC', asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', aToken: '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c', decimals: 6 },
  'dai-aave': { chainKey: 'ethereum', chainId: 1, pool: POOL_ETH, symbol: 'DAI', asset: '0x6b175474e89094c44da98b954eedeac495271d0f', aToken: '0x018008bfb33d285247a21d44e50697654f754e63', decimals: 18 },
  'weth-aave': { chainKey: 'ethereum', chainId: 1, pool: POOL_ETH, symbol: 'WETH', asset: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', aToken: '0x4d5f47fa6a74757f35c14fd3a6ef8e3c9bc514e8', decimals: 18 },
  'usdt-aave-arb': { chainKey: 'arbitrum', chainId: 42161, pool: POOL_ARB_POLYGON, symbol: 'USDT', asset: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', aToken: '0x6ab707aca953edaefbc4fd23ba73294241490620', decimals: 6 },
  'usdc-aave-arb': { chainKey: 'arbitrum', chainId: 42161, pool: POOL_ARB_POLYGON, symbol: 'USDC', asset: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', aToken: '0x724dc807b04555b71ed48a6896b6f41593b8c637', decimals: 6 },
  'usdc-aave-base': { chainKey: 'base', chainId: 8453, pool: POOL_BASE, symbol: 'USDC', asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', aToken: '0x4e65fe4dba92790696d040ac24aa414708f5c0ab', decimals: 6 },
  'usdt-aave-pol': { chainKey: 'polygon', chainId: 137, pool: POOL_ARB_POLYGON, symbol: 'USDT', asset: '0xc2132d05d31c914a87c6611c10748aeb04b58e8f', aToken: '0x6ab707aca953edaefbc4fd23ba73294241490620', decimals: 6 },
  'usdc-aave-pol': { chainKey: 'polygon', chainId: 137, pool: POOL_ARB_POLYGON, symbol: 'USDC', asset: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', aToken: '0xa4d94019934d8333ef880abffbf2fdd611c762bd', decimals: 6 },
};
export const AAVE_POOL = POOL_ETH;
export const LIDO_STETH = '0xae7ab96520de3a18e5e111b5eaab095312d7fe84';

export const EARN_OPTIONS: EarnOption[] = [
  { id: 'eth-lido', symbol: 'ETH', name: 'Ethereum · Lido', type: 'liquid', stable: false, target: { kind: 'lido' }, decimals: 18, lockKey: 'earn.lockLido', min: null },
  { id: 'usdt-aave', symbol: 'USDT', name: 'Tether · Aave', type: 'lending', stable: true, target: { kind: 'aave', market: 'usdt-aave' }, decimals: 6, lockKey: 'earn.lockNone', min: null },
  { id: 'usdc-aave', symbol: 'USDC', name: 'USD Coin · Aave', type: 'lending', stable: true, target: { kind: 'aave', market: 'usdc-aave' }, decimals: 6, lockKey: 'earn.lockNone', min: null },
  { id: 'dai-aave', symbol: 'DAI', name: 'Dai · Aave', type: 'lending', stable: true, target: { kind: 'aave', market: 'dai-aave' }, decimals: 18, lockKey: 'earn.lockNone', min: null },
  { id: 'weth-aave', symbol: 'WETH', name: 'Wrapped Ether · Aave', type: 'lending', stable: false, target: { kind: 'aave', market: 'weth-aave' }, decimals: 18, lockKey: 'earn.lockNone', min: null },
  { id: 'usdt-aave-arb', symbol: 'USDT', name: 'Tether · Aave · Arbitrum', type: 'lending', stable: true, target: { kind: 'aave', market: 'usdt-aave-arb' }, decimals: 6, lockKey: 'earn.lockNone', min: null },
  { id: 'usdc-aave-arb', symbol: 'USDC', name: 'USD Coin · Aave · Arbitrum', type: 'lending', stable: true, target: { kind: 'aave', market: 'usdc-aave-arb' }, decimals: 6, lockKey: 'earn.lockNone', min: null },
  { id: 'usdc-aave-base', symbol: 'USDC', name: 'USD Coin · Aave · Base', type: 'lending', stable: true, target: { kind: 'aave', market: 'usdc-aave-base' }, decimals: 6, lockKey: 'earn.lockNone', min: null },
  { id: 'usdt-aave-pol', symbol: 'USDT', name: 'Tether · Aave · Polygon', type: 'lending', stable: true, target: { kind: 'aave', market: 'usdt-aave-pol' }, decimals: 6, lockKey: 'earn.lockNone', min: null },
  { id: 'usdc-aave-pol', symbol: 'USDC', name: 'USD Coin · Aave · Polygon', type: 'lending', stable: true, target: { kind: 'aave', market: 'usdc-aave-pol' }, decimals: 6, lockKey: 'earn.lockNone', min: null },
  { id: 'sol', symbol: 'SOL', name: 'Solana', type: 'staking', stable: false, target: { kind: 'tab', chain: 'sol' }, decimals: 9, lockKey: 'earn.lockSol', min: null },
  { id: 'ada', symbol: 'ADA', name: 'Cardano', type: 'staking', stable: false, target: { kind: 'tab', chain: 'ada' }, decimals: 6, lockKey: 'earn.lockNone', min: '2 ADA' },
  { id: 'trx', symbol: 'TRX', name: 'TRON', type: 'staking', stable: false, target: { kind: 'tab', chain: 'tron' }, decimals: 6, lockKey: 'earn.lockTron', min: '1 TRX' },
  { id: 'near', symbol: 'NEAR', name: 'NEAR', type: 'staking', stable: false, target: { kind: 'tab', chain: 'near' }, decimals: 24, lockKey: 'earn.lockNear', min: null },
];

export function filterOptions(opts: EarnOption[], f: EarnFilter): EarnOption[] {
  if (f === 'stable') return opts.filter((o) => o.stable);
  if (f === 'staking') return opts.filter((o) => o.type !== 'lending');
  return opts;
}

const RAY = 10n ** 27n;
const SECONDS_PER_YEAR = 31_536_000;

/** Aave `currentLiquidityRate` (ray, yearly APR) → APY in percent, compounded per second. */
export function aaveApyPercent(liquidityRateRay: bigint): number {
  const apr = Number((liquidityRateRay * 10n ** 9n) / RAY) / 1e9;
  return (Math.pow(1 + apr / SECONDS_PER_YEAR, SECONDS_PER_YEAR) - 1) * 100;
}

/** `getReserveData(address)` → word 2 = currentLiquidityRate, word 8 = aTokenAddress. */
export function parseReserveData(hex: string): { liquidityRate: bigint; aToken: string } {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (h.length < 64 * 9) throw new Error('getReserveData: short answer');
  const word = (i: number) => h.slice(64 * i, 64 * (i + 1));
  return { liquidityRate: BigInt(`0x${word(2)}`), aToken: `0x${word(8).slice(24)}` };
}

export const SEL_GET_RESERVE_DATA = '0x35ea6a75';
export const SEL_BALANCE_OF = '0x70a08231';

/** `balanceOf(owner)` answer → amount. */
export const parseUint = (hex: string | undefined): bigint => (hex && hex !== '0x' ? BigInt(hex.slice(0, 66)) : 0n);

export const addrArg = (a: string) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');

/** Lido API: 7-day average stETH APR, in percent. */
export async function lidoAprPercent(): Promise<number> {
  const r = await netFetch({ url: 'https://eth-api.lido.fi/v1/protocol/steth/apr/sma', method: 'GET' });
  const j = JSON.parse(r.body) as { data?: { smaApr?: unknown } };
  const v = j.data?.smaApr;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100) throw new Error('Lido APR: invalid answer');
  return v;
}
