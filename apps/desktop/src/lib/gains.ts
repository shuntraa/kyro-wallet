// SPDX-License-Identifier: GPL-3.0-or-later
// Gains and losses: average cost basis replayed from the history and the price of each day, then
// the gain since on what is still held. Pure logic on data already on this device: no request.
// Nothing is estimated: an amount whose day price or origin is unknown stays out of the figure, and
// the result says how much of the balance it covers. Network fees are not added to the cost.

export type PricePoint = readonly [time: number, price: number];

export interface GainEvent {
  id: string;
  direction: 'in' | 'out' | 'self';
  /** Absolute amount, in coin units. */
  units: number;
  time?: number | undefined;
  status: 'pending' | 'confirmed' | 'failed';
  kind: 'transfer' | 'swap' | 'approval' | 'contract';
  suspect?: string | undefined;
}

export interface CoinGains {
  /** Part of the balance with a known cost. */
  coveredUnits: number;
  /** What that part cost; null when no part of the balance is covered. */
  cost: number | null;
  averageCost: number | null;
  /** Gain on the covered part at the current price; null without a price or a covered part. */
  gain: number | null;
  gainPct: number | null;
  /** Covered share of the balance, 0 to 1. */
  coverage: number;
  /** The figure leaves out part of the balance, or the history behind it is incomplete. */
  partial: boolean;
}

const DAY = 86_400_000;
/** Daily points for the last year; weekly ones before it. */
const DAILY_SPAN = 380 * DAY;
const DAILY_GAP = 2 * DAY;
const WEEKLY_GAP = 8 * DAY;
/** Below this, what is left out is rounding, not a missing origin. */
const FULL_COVERAGE = 0.999;
const EPSILON = 1e-9;

/** Price on the day of `t`: the nearest point if it is close enough, else unknown. */
export function priceOfDay(series: readonly PricePoint[], t: number, now: number): number | null {
  if (series.length === 0) return null;
  let lo = 0;
  let hi = series.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((series[mid] as PricePoint)[0] < t) lo = mid + 1;
    else hi = mid;
  }
  const after = series[lo];
  const before = series[lo - 1];
  const near = !before || (after && after[0] - t < t - before[0]) ? after : before;
  if (!near) return null;
  const limit = now - t > DAILY_SPAN ? WEEKLY_GAP : DAILY_GAP;
  return Math.abs(near[0] - t) <= limit && near[1] > 0 ? near[1] : null;
}

/** A transaction's hash without the output or account suffix of its history ids. */
const txOf = (id: string): string => id.split(/[:@]/)[0] ?? id;

/**
 * One event per transaction: a move between your own accounts appears in both, and must not look
 * like a sale followed by a purchase at that day's price.
 */
export function netOfOwnMoves(events: readonly GainEvent[]): GainEvent[] {
  const byTx = new Map<string, GainEvent[]>();
  for (const e of events) byTx.set(txOf(e.id), [...(byTx.get(txOf(e.id)) ?? []), e]);
  const out: GainEvent[] = [];
  for (const group of byTx.values()) {
    const first = group[0] as GainEvent;
    if (!group.some((e) => e.direction === 'in') || !group.some((e) => e.direction === 'out')) {
      out.push(...group);
      continue;
    }
    const net = group.reduce((s, e) => s + (e.direction === 'in' ? e.units : -e.units), 0);
    if (Math.abs(net) > EPSILON) out.push({ ...first, direction: net > 0 ? 'in' : 'out', units: Math.abs(net) });
  }
  return out;
}

const counts = (e: GainEvent): boolean => e.status === 'confirmed' && e.kind !== 'approval' && !e.suspect && e.units > 0 && (e.direction === 'in' || e.direction === 'out');

export interface GainsInput {
  events: readonly GainEvent[];
  /** Current balance, in coin units. */
  balance: number;
  /** Current price; null when unknown. */
  price: number | null;
  priceAt: (time: number) => number | null;
  /** False when older activity may be missing from `events`. */
  historyComplete: boolean;
}

export function computeGains({ events, balance, price, priceAt, historyComplete }: GainsInput): CoinGains {
  const nothing: CoinGains = { coveredUnits: 0, cost: null, averageCost: null, gain: null, gainPct: null, coverage: 0, partial: balance > 0 };
  if (!(balance > 0)) return nothing;
  let known = 0;
  let cost = 0;
  let unpriced = 0;
  let overdrawn = false;
  const ordered = netOfOwnMoves(events.filter(counts)).sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
  for (const e of ordered) {
    if (e.direction === 'in') {
      const p = e.time === undefined ? null : priceAt(e.time);
      if (p === null || !(p > 0)) unpriced += e.units;
      else {
        known += e.units;
        cost += e.units * p;
      }
      continue;
    }
    // Average cost: a send takes the same share of every part of the pool.
    const held = known + unpriced;
    if (e.units > held * (1 + EPSILON)) overdrawn = true;
    const left = held > 0 ? Math.max(0, 1 - e.units / held) : 0;
    known *= left;
    cost *= left;
    unpriced *= left;
  }
  // The balance decides: fees and unseen sends took the rest, in the same proportions.
  const tracked = known + unpriced;
  if (tracked > balance) {
    const left = balance / tracked;
    known *= left;
    cost *= left;
  }
  if (!(known > 0) || !(cost > 0)) return nothing;
  const coverage = Math.min(1, known / balance);
  const partial = coverage < FULL_COVERAGE || overdrawn || !historyComplete;
  const gain = price !== null && price > 0 ? known * price - cost : null;
  return { coveredUnits: known, cost, averageCost: cost / known, gain, gainPct: gain === null ? null : (gain / cost) * 100, coverage, partial };
}

export interface GainsTotal {
  gain: number | null;
  gainPct: number | null;
  cost: number | null;
  /** Share of the value held that the figure covers, 0 to 1. */
  coverage: number;
  partial: boolean;
}

/** Adds up the coins with a figure; `partial` as soon as any value held is left out. */
export function totalGains(rows: ReadonlyArray<{ gains: CoinGains; value: number | null; price: number | null }>): GainsTotal {
  let gain = 0;
  let cost = 0;
  let covered = 0;
  let held = 0;
  let partial = false;
  let any = false;
  for (const { gains: g, value, price } of rows) {
    if (value === null || price === null) {
      partial = true;
      continue;
    }
    if (!(value > 0)) continue;
    held += value;
    partial ||= g.partial;
    if (g.gain === null || g.cost === null) continue;
    any = true;
    gain += g.gain;
    cost += g.cost;
    covered += g.coveredUnits * price;
  }
  if (!any) return { gain: null, gainPct: null, cost: null, coverage: 0, partial };
  return { gain, gainPct: cost > 0 ? (gain / cost) * 100 : null, cost, coverage: held > 0 ? Math.min(1, covered / held) : 0, partial };
}
