// SPDX-License-Identifier: GPL-3.0-or-later
// Title-bar search: one row per coin (a held coin and its market entry are the same row), held first.

import { matchesCoinQuery, type AssetDef } from '@kyro/chains';

export interface CoinSearchHit {
  /** Route id: the largest holding's asset id, else `cg:<coingeckoId>`. */
  id: string;
  name: string;
  symbol: string;
  asset: AssetDef | undefined;
  /** Total held across chains and accounts (in coin units), `null` when not held. */
  units: number | null;
  rank: number | null;
}

const coinKey = (a: { coingeckoId?: string | undefined; id: string }): string => a.coingeckoId ?? a.id;

export function coinSearch(
  q: string,
  holdings: ReadonlyArray<{ asset: AssetDef; units: number }>,
  markets: ReadonlyArray<{ id: string; name: string; symbol: string; rank?: number | null | undefined }>,
  max = 8,
): CoinSearchHit[] {
  const s = q.toLowerCase();
  const held = new Map<string, CoinSearchHit & { best: number }>();
  for (const h of holdings) {
    if (!matchesCoinQuery(s, h.asset)) continue;
    const k = coinKey(h.asset);
    const cur = held.get(k);
    if (!cur) held.set(k, { id: h.asset.id, name: h.asset.name, symbol: h.asset.symbol, asset: h.asset, units: h.units, rank: null, best: h.units });
    else {
      cur.units = (cur.units ?? 0) + h.units;
      if (h.units > cur.best) Object.assign(cur, { id: h.asset.id, asset: h.asset, best: h.units });
    }
  }
  const out: CoinSearchHit[] = [];
  const ranks = new Map(markets.map((m) => [m.id, m.rank ?? null]));
  for (const [k, { best: _best, ...hit }] of held) out.push({ ...hit, rank: ranks.get(k) ?? null });
  for (const c of markets) {
    if (out.length >= max) break;
    if (held.has(c.id) || !matchesCoinQuery(s, { name: c.name, symbol: c.symbol, coingeckoId: c.id })) continue;
    out.push({ id: `cg:${c.id}`, name: c.name, symbol: c.symbol, asset: undefined, units: null, rank: c.rank ?? null });
  }
  return out.slice(0, max);
}
