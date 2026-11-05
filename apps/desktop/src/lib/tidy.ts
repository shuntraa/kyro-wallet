// SPDX-License-Identifier: GPL-3.0-or-later
// Tidy up small balances: which balances can be converted into one asset, what each conversion
// costs, and the progress of a run. Each conversion is an ordinary swap signed on its own: there is
// no batch here, only the order of the swaps and what became of them.

import { isTinyLure, unitsToNumber, type AssetDef, type Chain } from '@kyro/chains';
import type { Network } from '@kyro/shared';
import { buyGroups, sellChoices } from './crossSwap';
import { AAVE_MARKETS, LIDO_STETH } from './earn';
import { nativeFloor } from './topUp';

export const TIDY_DEFAULT_THRESHOLD = 5;
/** Above this share of the value going to fees, a conversion starts unticked. */
export const TIDY_MAX_FEE_RATIO = 0.3;

/** Receipts of staked or lent funds: never converted here, even when small. */
const STAKED_CONTRACTS = new Set([LIDO_STETH, ...Object.values(AAVE_MARKETS).map((m) => m.aToken)]);

export type TidyBlock = 'noRoute' | 'noFees';

export interface TidyRow {
  asset: AssetDef;
  chain: Chain;
  /** What would be sold, base units (for a native coin, what remains above its reserve). */
  amount: bigint;
  value: number;
  block: TidyBlock | null;
}

export interface TidyInput {
  network: Network;
  chains: Chain[];
  assets: AssetDef[];
  target: AssetDef;
  threshold: number;
  balanceOf: (assetId: string) => bigint;
  priceOf: (asset: AssetDef) => number | null;
  /** Cost of one swap of `asset` on its chain, in that chain's native coin. */
  feeOf: (asset: AssetDef) => bigint | null;
  /** Assets flagged by the history checks ({@link suspectAssetIds}). */
  suspects: ReadonlySet<string>;
  /** False on hardware and watch-only accounts: swaps sign through the vault only. */
  canSign: (asset: AssetDef) => boolean;
}

interface Held {
  asset: AssetDef;
  chain: Chain;
  balance: bigint;
  price: number;
  routed: boolean;
}

/**
 * The rows of the list: tokens by value, then native coins, last so that the swaps before them
 * still find their gas. On each chain the native coin first pays for the tokens' swaps, then keeps
 * a reserve of one more swap; only what is left of it can be converted.
 */
export function tidyRows(p: TidyInput): TidyRow[] {
  const held: Held[] = [];
  const sellable = new Set(sellChoices(p.network, p.chains, p.assets).filter((c) => !c.comingSoon).map((c) => c.asset.id));
  for (const asset of p.assets) {
    const chain = p.chains.find((c) => c.key === asset.chainKey);
    const balance = p.balanceOf(asset.id);
    const price = p.priceOf(asset);
    if (!chain || balance <= 0n || price === null || price <= 0) continue;
    if (asset.id === p.target.id || asset.readOnly || !p.canSign(asset) || p.suspects.has(asset.id)) continue;
    if (asset.contract && STAKED_CONTRACTS.has(asset.contract.toLowerCase())) continue;
    if (unitsToNumber(balance, asset.decimals) * price > p.threshold) continue;
    const routed = sellable.has(asset.id) && buyGroups(p.network, p.chains, p.assets, asset).some((g) => g.assets.some((a) => a.id === p.target.id));
    held.push({ asset, chain, balance, price, routed });
  }

  const nativeOf = (chainKey: string) => p.assets.find((a) => a.chainKey === chainKey && a.kind === 'native');
  const budget = new Map<string, bigint>();
  const left = (native: AssetDef) => budget.get(native.chainKey) ?? p.balanceOf(native.id) - nativeFloor(native);
  const byValue = (a: Held, b: Held) => unitsToNumber(b.balance, b.asset.decimals) * b.price - unitsToNumber(a.balance, a.asset.decimals) * a.price;

  const rows: TidyRow[] = [];
  for (const h of held.filter((x) => x.asset.kind !== 'native').sort(byValue)) {
    const row: TidyRow = { asset: h.asset, chain: h.chain, amount: h.balance, value: unitsToNumber(h.balance, h.asset.decimals) * h.price, block: h.routed ? null : 'noRoute' };
    if (h.routed) {
      const native = nativeOf(h.asset.chainKey);
      const fee = p.feeOf(h.asset);
      if (!native || fee === null || left(native) < fee) row.block = 'noFees';
      else budget.set(native.chainKey, left(native) - fee);
    }
    rows.push(row);
  }
  for (const h of held.filter((x) => x.asset.kind === 'native').sort(byValue)) {
    const fee = p.feeOf(h.asset);
    if (fee === null) continue;
    const amount = left(h.asset) - fee * 2n; // its own swap, and one more for later
    if (amount <= 0n) continue; // all of it is needed for fees: not a candidate
    rows.push({ asset: h.asset, chain: h.chain, amount, value: unitsToNumber(amount, h.asset.decimals) * h.price, block: h.routed ? null : 'noRoute' });
  }
  return rows;
}

export interface TidyCost {
  /** Everything lost on the way, in the display currency. */
  fees: number;
  net: number;
  /** Share of the value lost: 0.3 = 30 %. */
  ratio: number;
}

/**
 * The cost of a conversion: `received` is net of the Kyro and provider fees, `networkFee` is what
 * the chain charges on top. Null without a received value or a network fee: the cost is unknown.
 */
export function tidyCost(p: { value: number; received: number | null; networkFee: number | null }): TidyCost | null {
  if (p.received === null || p.networkFee === null || p.value <= 0) return null;
  const net = p.received - p.networkFee;
  const fees = Math.max(0, p.value - net);
  return { fees, net, ratio: fees / p.value };
}

/** Unticked by default when the fees eat more than 30 % of the value, or nobody can tell. */
export const tickedByDefault = (cost: TidyCost | null): boolean => cost !== null && cost.ratio <= TIDY_MAX_FEE_RATIO;

/**
 * Assets that only ever reached this wallet through lures: every entry of the asset is a suspect
 * transfer or a tiny incoming one (the poisoning checks of `@kyro/chains`). One real send or swap
 * clears it.
 */
export function suspectAssetIds(entries: ReadonlyArray<{ assetId: string; direction: string; kind: string; amount: bigint; suspect?: unknown; asset?: AssetDef | undefined }>, fiatOf: (e: { amount: bigint; asset?: AssetDef | undefined }) => number | null): Set<string> {
  const lure = new Set<string>();
  const real = new Set<string>();
  for (const e of entries) {
    (e.suspect || isTinyLure(e, e.asset?.family, fiatOf(e)) ? lure : real).add(e.assetId);
  }
  for (const id of real) lure.delete(id);
  return lure;
}

export type TidyOutcome = { status: 'done'; id: string } | { status: 'failed'; reason: string } | { status: 'skipped' };

export interface TidyRun<T> {
  items: T[];
  /** One per item already settled, in order. */
  outcomes: TidyOutcome[];
}

export const startRun = <T>(items: T[]): TidyRun<T> => ({ items, outcomes: [] });

export const currentItem = <T>(run: TidyRun<T>): T | undefined => run.items[run.outcomes.length];

export const runFinished = <T>(run: TidyRun<T>): boolean => run.outcomes.length >= run.items.length;

/** Settles item `index` and moves on, whatever became of it. A late answer for another item is ignored. */
export function settle<T>(run: TidyRun<T>, index: number, outcome: TidyOutcome): TidyRun<T> {
  if (index !== run.outcomes.length || runFinished(run)) return run;
  return { ...run, outcomes: [...run.outcomes, outcome] };
}

/** Settles item `index`, then stops: the rest is skipped. A late answer changes nothing. */
export function settleAndStop<T>(run: TidyRun<T>, index: number, outcome: TidyOutcome): TidyRun<T> {
  const next = settle(run, index, outcome);
  return next === run ? run : stopRun(next);
}

/** Stops here: everything not settled yet is skipped. */
export const stopRun = <T>(run: TidyRun<T>): TidyRun<T> => ({ ...run, outcomes: [...run.outcomes, ...run.items.slice(run.outcomes.length).map((): TidyOutcome => ({ status: 'skipped' }))] });

export interface TidySummary<T> {
  done: T[];
  failed: Array<{ item: T; reason: string }>;
  skipped: T[];
}

export function tidySummary<T>(run: TidyRun<T>): TidySummary<T> {
  const out: TidySummary<T> = { done: [], failed: [], skipped: [] };
  run.outcomes.forEach((o, i) => {
    const item = run.items[i] as T;
    if (o.status === 'done') out.done.push(item);
    else if (o.status === 'failed') out.failed.push({ item, reason: o.reason });
    else out.skipped.push(item);
  });
  return out;
}
