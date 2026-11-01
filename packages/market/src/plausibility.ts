// SPDX-License-Identifier: GPL-3.0-or-later
//
// A network price changes how much crypto a fiat-entered send moves, so compare it with the last
// price seen locally and the 7-day sparkline median; too far off is refused.

import { l10n } from '@kyro/shared';

/** Largest accepted gap with a reference (0,25 = 25 %). Beyond it, fiat entry is turned off. */
export const PRICE_MAX_DEVIATION = 0.25;
/** A « last known price » older than this is ignored. */
export const LAST_PRICE_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

export interface PriceCheck {
  ok: boolean;
  /** Largest relative gap found (0,4 = 40 %), null without any reference. */
  deviation: number | null;
  /** Why it is refused (French), when `ok` is false. */
  reason?: string;
}

function median(xs: number[]): number | null {
  const v = xs.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? (v[m] as number) : ((v[m - 1] as number) + (v[m] as number)) / 2;
}

/** Checks `price` against the references; accepted without any, but never if not finite and positive. */
export function checkPricePlausible(price: number | null | undefined, refs: { sparkline7d?: number[]; lastKnown?: { price: number; at: number } | null; now?: number }): PriceCheck {
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) return { ok: false, deviation: null, reason: l10n('Prix indisponible ou invalide.', 'Price unavailable or invalid.') };
  const now = refs.now ?? Date.now();
  const ref: number[] = [];
  const spark = median(refs.sparkline7d ?? []);
  if (spark !== null) ref.push(spark);
  if (refs.lastKnown && Number.isFinite(refs.lastKnown.price) && refs.lastKnown.price > 0 && now - refs.lastKnown.at <= LAST_PRICE_MAX_AGE_MS) ref.push(refs.lastKnown.price);
  if (ref.length === 0) return { ok: true, deviation: null };
  const deviation = Math.max(...ref.map((r) => Math.abs(price / r - 1)));
  if (deviation > PRICE_MAX_DEVIATION) return { ok: false, deviation, reason: l10n(`Prix douteux : ${Math.round(deviation * 100)} % d’écart avec le dernier prix connu.`, `Doubtful price: ${Math.round(deviation * 100)}% away from the last known price.`) };
  return { ok: true, deviation };
}
