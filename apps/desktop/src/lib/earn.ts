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
  target: { kind: 'tab'; chain: 'sol' | 'ada' | 'tron' | 'near' } | { kind: 'lido' } | { kind: 'aave'; asset: AaveAsset };
  decimals: number;
  /** i18n key of the lock / unbond time. */
  lockKey: 'earn.lockNone' | 'earn.lockLido' | 'earn.lockSol' | 'earn.lockTron' | 'earn.lockNear';
  /** Minimum, human text (symbol included), or null when there is none. */
  min: string | null;
}

/** Aave v3 Ethereum reserves: underlying, aToken (read only; checked on-chain 2026-11-03). Lowercase. */
export const AAVE_RESERVES: Record<AaveAsset, { asset: string; aToken: string; decimals: number }> = {
  USDT: { asset: '0xdac17f958d2ee523a2206206994597c13d831ec7', aToken: '0x23878914efe38d27c4d67ab83ed1b93a74d4086a', decimals: 6 },
  USDC: { asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', aToken: '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c', decimals: 6 },
  DAI: { asset: '0x6b175474e89094c44da98b954eedeac495271d0f', aToken: '0x018008bfb33d285247a21d44e50697654f754e63', decimals: 18 },
  WETH: { asset: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', aToken: '0x4d5f47fa6a74757f35c14fd3a6ef8e3c9bc514e8', decimals: 18 },
};
export const AAVE_POOL = '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2';
export const LIDO_STETH = '0xae7ab96520de3a18e5e111b5eaab095312d7fe84';

export const EARN_OPTIONS: EarnOption[] = [
  { id: 'eth-lido', symbol: 'ETH', name: 'Ethereum · Lido', type: 'liquid', stable: false, target: { kind: 'lido' }, decimals: 18, lockKey: 'earn.lockLido', min: null },
  { id: 'usdt-aave', symbol: 'USDT', name: 'Tether · Aave', type: 'lending', stable: true, target: { kind: 'aave', asset: 'USDT' }, decimals: 6, lockKey: 'earn.lockNone', min: null },
  { id: 'usdc-aave', symbol: 'USDC', name: 'USD Coin · Aave', type: 'lending', stable: true, target: { kind: 'aave', asset: 'USDC' }, decimals: 6, lockKey: 'earn.lockNone', min: null },
  { id: 'dai-aave', symbol: 'DAI', name: 'Dai · Aave', type: 'lending', stable: true, target: { kind: 'aave', asset: 'DAI' }, decimals: 18, lockKey: 'earn.lockNone', min: null },
  { id: 'weth-aave', symbol: 'WETH', name: 'Wrapped Ether · Aave', type: 'lending', stable: false, target: { kind: 'aave', asset: 'WETH' }, decimals: 18, lockKey: 'earn.lockNone', min: null },
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
