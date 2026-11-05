// SPDX-License-Identifier: GPL-3.0-or-later
// Getting the native coin of a chain when it is too low to pay a network fee. A swap on that chain
// would need that same coin for gas, so the source is always something held on ANOTHER chain, with
// enough of that chain's own coin for its fees, through a route the swap screen really offers.
// Nothing here signs: the result only prefills the normal Swap screen.

import { tryParseUnits, unitsToNumber, type AssetDef, type Chain, type FeeEstimates } from '@kyro/chains';
import type { Network } from '@kyro/shared';
import { exolixRoute, ONE_CLICK_CHAINS, type Quote, type QuoteResult } from '@kyro/swap';
import { buyGroups, sellChoices, swapChainOf } from './crossSwap';

/** Asked on top of what is missing: fees move between the quote and the send. */
export const TOP_UP_MARGIN = 0.3;
/** Room for the Kyro fee, the provider's share and slippage, all taken from what is sold. */
export const TOP_UP_COST = 0.1;
/** Least value proposed. Under it most routes refuse the quote, and the fee rate is at its highest. */
export const TOP_UP_MIN_USD = 10;
/** 1Click's minimum when departing from TRON (docs/SWAP_FEES.md). */
const TRON_MIN_USD = 100;
/** Sources tried against live quotes before giving up. */
const MAX_PROBES = 4;

const SWAP_GAS = 350_000n;
const APPROVAL_GAS = 120_000n;
/** A plain token transfer: what a deposit route costs. */
const TRANSFER_GAS = 80_000n;
/** EVM, when the fee level could not be read. */
const EVM_FALLBACK_FEE_FIAT = 3;
const STABLES = new Set(['tether', 'usd-coin', 'dai', 'first-digital-usd', 'paypal-usd', 'usds']);

/** A plain swap or deposit on each non-EVM chain, in the native coin (Solana: with a token account's rent). */
const USUAL_FEE: Partial<Record<Chain['family'], string>> = {
  btc: '0.0001',
  ltc: '0.001',
  doge: '2',
  bch: '0.0001',
  dash: '0.001',
  zec: '0.0001',
  sol: '0.003',
  tron: '30',
  xrp: '0.01',
  ada: '0.5',
  xlm: '0.01',
  near: '0.01',
  sui: '0.02',
  hbar: '0.1',
  kas: '0.1',
  dot: '0.05',
  algo: '0.01',
  xmr: '0.001',
  ton: '0.1',
  cosmos: '0.01',
  apt: '0.01',
};

/** What a chain keeps out of reach on an account: reserve, rent, minimum change. */
const NATIVE_FLOOR: Partial<Record<Chain['family'], string>> = {
  sol: '0.001',
  xrp: '1',
  xlm: '1',
  algo: '0.1',
  ada: '1',
  near: '0.05',
  dot: '0.02',
  kas: '0.2',
  ton: '0.01',
};

const units = (v: string | undefined, decimals: number): bigint => (v ? tryParseUnits(v, decimals) ?? 0n : 0n);

/** Base units of the native coin a chain never lets you spend. */
export const nativeFloor = (native: AssetDef): bigint => units(NATIVE_FLOOR[native.family], native.decimals);

/** Estimated cost of one swap on a chain, in its native coin (null: unknown, never treated as free). */
export function swapFeeOn(native: AssetDef, opts: { token: boolean; plain?: boolean; estimates?: FeeEstimates | null | undefined; nativePrice?: number | null | undefined }): bigint | null {
  const params = opts.estimates?.options.normal.params;
  if (native.family === 'evm') {
    if (params?.family === 'evm') return (opts.plain ? TRANSFER_GAS : SWAP_GAS + (opts.token ? APPROVAL_GAS : 0n)) * params.maxFeePerGas;
    if (!opts.nativePrice || opts.nativePrice <= 0) return null;
    return tryParseUnits((EVM_FALLBACK_FEE_FIAT / opts.nativePrice).toFixed(Math.min(native.decimals, 12)), native.decimals);
  }
  // One input, two outputs at most for a deposit.
  if (params?.family === 'btc') return BigInt(Math.ceil(params.satPerVb * 250));
  const usual = USUAL_FEE[native.family];
  return usual ? units(usual, native.decimals) : null;
}

export const missingFee = (need: bigint, have: bigint): bigint => (need > have ? need - have : 0n);

/** Least value a route is expected to take, in the display currency. */
export function minSwapFiat(chain: Chain, usdToFiat: number): number {
  return (chain.family === 'tron' ? TRON_MIN_USD : TOP_UP_MIN_USD) * usdToFiat;
}

/** How much to sell so that `missing` arrives with its margin, null without both prices. */
export function topUpSellAmount(p: { missing: bigint; target: Pick<AssetDef, 'decimals'>; targetPrice: number | null; sell: Pick<AssetDef, 'decimals'>; sellPrice: number | null; minFiat: number }): bigint | null {
  if (p.missing <= 0n || !p.targetPrice || !p.sellPrice || p.targetPrice <= 0 || p.sellPrice <= 0) return null;
  const wanted = (unitsToNumber(p.missing, p.target.decimals) * p.targetPrice * (1 + TOP_UP_MARGIN)) / (1 - TOP_UP_COST);
  const fiat = Math.max(wanted, p.minFiat);
  return tryParseUnits((fiat / p.sellPrice).toFixed(Math.min(p.sell.decimals, 12)), p.sell.decimals);
}

export interface TopUpSource {
  asset: AssetDef;
  chain: Chain;
  /** Proposed amount, base units of `asset`. */
  sellAmount: bigint;
  /** Most that can be sold: the balance, less the fees and floor for a native coin. */
  maxSell: bigint;
  sellFiat: number;
  /** Network fee of the swap on the source chain, in the display currency. */
  feeFiat: number;
}

export interface TopUpInput {
  network: Network;
  chains: Chain[];
  assets: AssetDef[];
  /** The native coin to get. */
  target: AssetDef;
  missing: bigint;
  balanceOf: (assetId: string) => bigint;
  priceOf: (asset: AssetDef) => number | null;
  /** Cost of one swap of `asset` on its chain, in that chain's native coin. */
  feeOf: (asset: AssetDef) => bigint | null;
  /** An account of yours can sign on this chain. */
  canUse: (chain: Chain) => boolean;
  usdToFiat: number;
}

/** Exolix is a last resort here: two transfers instead of one, and a slower route. */
function exolixOnly(from: Chain, to: Chain): boolean {
  const a = swapChainOf(from);
  const b = swapChainOf(to);
  return a !== null && b !== null && exolixRoute(a, b) && !(ONE_CLICK_CHAINS[String(a)] !== undefined && ONE_CLICK_CHAINS[String(b)] !== undefined);
}

/** Usable sources, best first: cheapest source chain, stablecoins before volatile coins, then the largest holding. */
export function topUpSources(p: TopUpInput): TopUpSource[] {
  const targetChain = p.chains.find((c) => c.key === p.target.chainKey);
  if (!targetChain || p.missing <= 0n) return [];
  const targetPrice = p.priceOf(p.target);
  const out: Array<TopUpSource & { value: number }> = [];
  for (const { asset, chain, comingSoon } of sellChoices(p.network, p.chains, p.assets)) {
    // Same chain: swapping there needs the very coin that is missing.
    if (comingSoon || chain.key === targetChain.key || !p.canUse(chain)) continue;
    const balance = p.balanceOf(asset.id);
    if (balance <= 0n) continue;
    if (!buyGroups(p.network, p.chains, p.assets, asset).some((g) => g.assets.some((a) => a.id === p.target.id))) continue;
    const native = asset.kind === 'native' ? asset : p.assets.find((a) => a.chainKey === chain.key && a.kind === 'native');
    if (!native) continue;
    const fee = p.feeOf(asset);
    if (fee === null) continue;
    const nativeBalance = p.balanceOf(native.id);
    const floor = nativeFloor(native);
    const maxSell = asset.kind === 'native' ? balance - fee - floor : balance;
    // The source chain must pay for its own swap, or the same problem just moves there.
    if (maxSell <= 0n || nativeBalance < fee + floor) continue;
    const sellPrice = p.priceOf(asset);
    const sellAmount = topUpSellAmount({ missing: p.missing, target: p.target, targetPrice, sell: asset, sellPrice, minFiat: minSwapFiat(chain, p.usdToFiat) });
    if (sellAmount === null || sellAmount <= 0n || sellAmount > maxSell) continue;
    out.push({
      asset,
      chain,
      sellAmount,
      maxSell,
      sellFiat: unitsToNumber(sellAmount, asset.decimals) * (sellPrice ?? 0),
      feeFiat: unitsToNumber(fee, native.decimals) * (p.priceOf(native) ?? 0),
      value: unitsToNumber(balance, asset.decimals) * (sellPrice ?? 0),
    });
  }
  const rank = (s: TopUpSource) => (exolixOnly(s.chain, targetChain) ? 1 : 0);
  // Fee differences under a quarter of a unit are noise next to what is being bought.
  const feeBand = (s: TopUpSource) => Math.floor(s.feeFiat * 4);
  const stable = (s: TopUpSource) => (STABLES.has(s.asset.coingeckoId) ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b) || feeBand(a) - feeBand(b) || stable(a) - stable(b) || b.value - a.value).map(({ value: _value, ...s }) => s);
}

/**
 * The minimum a provider asks for, read from its refusal: 1Click (« try at least 1234 », base
 * units) or Kyro's Exolix message (« minimum (0.5) », whole coins). Null when it gave none.
 */
export function quoteMinimum(error: string | undefined, decimals: number): bigint | null {
  if (!error) return null;
  const raw = /try at least (\d+)/i.exec(error)?.[1];
  if (raw) return BigInt(raw);
  const whole = /minimum[^(]*\(([\d.]+)\)/i.exec(error)?.[1];
  return whole ? tryParseUnits(whole, decimals) : null;
}

export interface TopUpRoute {
  source: TopUpSource;
  sellAmount: bigint;
  quote: Quote;
}

export type TopUpProbe = (source: TopUpSource, sellAmount: bigint) => Promise<{ quotes: Quote[]; results: QuoteResult[] }>;

/**
 * The first source a provider really quotes, with an amount that gets at least `missing` there:
 * a quote refused for being too small, or too small to cover the fee, is asked again once.
 */
export async function pickTopUpRoute(sources: TopUpSource[], missing: bigint, probe: TopUpProbe): Promise<TopUpRoute | null> {
  for (const source of sources.slice(0, MAX_PROBES)) {
    let amount = source.sellAmount;
    for (let attempt = 0; attempt < 2; attempt++) {
      const answer = await probe(source, amount).catch(() => null);
      if (!answer) break;
      const quote = answer.quotes[0];
      let next: bigint | null = null;
      if (quote) {
        if (quote.minBuyAmount >= missing) return { source, sellAmount: amount, quote };
        if (quote.minBuyAmount > 0n) next = (amount * missing * 12n) / (quote.minBuyAmount * 10n);
      } else {
        const least = answer.results.map((r) => quoteMinimum(r.error, source.asset.decimals)).find((m) => m !== null);
        if (least) next = (least * 102n) / 100n;
      }
      if (next === null || next <= amount || next > source.maxSell) break;
      amount = next;
    }
  }
  return null;
}
