// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeBalances, decodePrices, encodeBalances, ERROR_GRACE_MS, fingerprint, loadBalances, saveBalances, settleErrors } from './balanceCache';

describe('balance cache', () => {
  const m = new Map([
    ['btc:0', new Map([['btc', 123_456_789n]])],
    ['evm:1', new Map([['eth', 10n ** 30n], ['erc20:1:0xabc', 0n]])],
  ]);

  it('round-trips amounts (bigint, beyond 2^53)', () => {
    const fp = fingerprint('btc:0:bc1q…|evm:1:0x…');
    const back = decodeBalances(JSON.parse(JSON.stringify(encodeBalances(fp, m))), fp);
    expect(back).toEqual(m);
  });

  it('ignores the cache of another wallet', () => {
    expect(decodeBalances(encodeBalances(fingerprint('a'), m), fingerprint('b'))).toBeNull();
  });

  it('drops malformed entries instead of throwing', () => {
    const fp = 'deadbeef';
    expect(decodeBalances(null, fp)).toBeNull();
    expect(decodeBalances('x', fp)).toBeNull();
    const back = decodeBalances({ fp, b: { 'btc:0': { btc: '12', bad: -1, neg: '-5', frac: '1.5' }, '../x': { a: '1' } } }, fp);
    expect(back).toEqual(new Map([['btc:0', new Map([['btc', 12n]])]]));
  });

  it('fingerprint is stable and distinguishes inputs', () => {
    expect(fingerprint('abc')).toBe(fingerprint('abc'));
    expect(fingerprint('abc')).not.toBe(fingerprint('abd'));
    expect(fingerprint('abc')).toMatch(/^[0-9a-f]{8}$/);
  });

  it('decodes prices, keeping only finite numbers', () => {
    expect(decodePrices({ bitcoin: { price: 60000, change24h: -1.5 }, eth: { price: 'x' }, sol: { price: 150, change24h: null }, inf: { price: Infinity } })).toEqual({
      bitcoin: { price: 60000, change24h: -1.5 },
      sol: { price: 150, change24h: null },
    });
  });

  describe('storage', () => {
    let store: Record<string, string>;
    beforeEach(() => {
      store = {};
      vi.stubGlobal('window', { localStorage: { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => void (store[k] = v) } });
    });
    afterEach(() => vi.unstubAllGlobals());

    it('saves per network and restores for the same wallet only', () => {
      saveBalances('mainnet', 'aaaa0000', m);
      expect(loadBalances('mainnet', 'aaaa0000')).toEqual(m);
      expect(loadBalances('testnet', 'aaaa0000')).toBeNull();
      expect(loadBalances('mainnet', 'bbbb0000')).toBeNull();
      expect(Object.keys(store)).toEqual(['kyro.cache.balances.mainnet']);
    });
  });
});

describe('settleErrors', () => {
  it('stays silent during the grace period, then shows the error', () => {
    const t0 = 1_000_000;
    let r = settleErrors({ bitcoin: 'timeout' }, {}, t0);
    expect(r.visible).toEqual({});
    r = settleErrors({ bitcoin: 'timeout' }, r.since, t0 + ERROR_GRACE_MS - 1);
    expect(r.visible).toEqual({});
    r = settleErrors({ bitcoin: 'timeout 2' }, r.since, t0 + ERROR_GRACE_MS);
    expect(r.visible).toEqual({ bitcoin: 'timeout 2' });
  });

  it('a chain that answers again resets its clock', () => {
    const t0 = 0;
    let r = settleErrors({ bitcoin: 'x', solana: 'y' }, {}, t0);
    r = settleErrors({ solana: 'y' }, r.since, t0 + 60_000);
    expect(r.since).toEqual({ solana: t0 });
    r = settleErrors({ bitcoin: 'x', solana: 'y' }, r.since, t0 + ERROR_GRACE_MS);
    expect(r.visible).toEqual({ solana: 'y' });
    expect(r.since.bitcoin).toBe(t0 + ERROR_GRACE_MS);
  });
});
