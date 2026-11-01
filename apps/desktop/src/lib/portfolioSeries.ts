// SPDX-License-Identifier: GPL-3.0-or-later
// Portfolio value over time = current holdings × historical prices ("composition constante"): we
// don't know past balances without an indexer.

export type Series = Array<[time: number, price: number]>;

/** Price at `t` from a time-sorted series (nearest earlier point, else first). */
export function priceAt(series: Series, t: number): number | null {
  if (series.length === 0) return null;
  let lo = 0;
  let hi = series.length - 1;
  const first = series[0] as [number, number];
  if (t <= first[0]) return first[1];
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((series[mid] as [number, number])[0] <= t) lo = mid;
    else hi = mid - 1;
  }
  return (series[lo] as [number, number])[1];
}

/** Combine holdings (units per coin) with their price series. */
export function portfolioSeries(holdings: Array<{ coinId: string; units: number; currentPrice: number }>, charts: Record<string, Series>): Series {
  const base = Object.values(charts).reduce<Series>((a, s) => (s.length > a.length ? s : a), []);
  if (base.length === 0) return [];
  return base.map(([t]) => [
    t,
    holdings.reduce((sum, h) => {
      const s = charts[h.coinId];
      const p = s && s.length ? priceAt(s, t) : h.currentPrice;
      return sum + h.units * (p ?? h.currentPrice);
    }, 0),
  ]);
}
