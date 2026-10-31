// Fiat entry only with a plausible price (Envoyer).
import { describe, expect, it } from 'vitest';
import { checkPricePlausible, LAST_PRICE_MAX_AGE_MS } from '../src';

describe('checkPricePlausible', () => {
  const now = 1_800_000_000_000;
  it('refuses a missing, zero, negative or non-finite price', () => {
    for (const p of [null, undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(checkPricePlausible(p, {}).ok).toBe(false);
  });

  it('accepts a first price without reference, and a price close to its references', () => {
    expect(checkPricePlausible(3000, {})).toEqual({ ok: true, deviation: null });
    expect(checkPricePlausible(3000, { sparkline7d: [2900, 3050, 3100], lastKnown: { price: 2950, at: now - 3600_000 }, now }).ok).toBe(true);
  });

  it('refuses a price far from the last one seen or from the 7-day median (either way)', () => {
    const r = checkPricePlausible(30, { lastKnown: { price: 3000, at: now - 60_000 }, now });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/99 %/);
    expect(checkPricePlausible(9000, { sparkline7d: [2900, 3000, 3100], now }).ok).toBe(false);
  });

  it('ignores a last price that is too old', () => {
    expect(checkPricePlausible(30, { lastKnown: { price: 3000, at: now - LAST_PRICE_MAX_AGE_MS - 1 }, now }).ok).toBe(true);
  });
});
