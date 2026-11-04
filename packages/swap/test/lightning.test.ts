// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { NetFetch } from '@kyro/shared';
import { LN_PROVIDERS, lnBridgeOf, lnCreateSwap, lnErrorText, lnKyroFee, lnPairs, lnPairsFor, lnProviderFee, lnProviderOfBridge, lnStatusOf, lnSwapStatus, looksLikeInvoice, parseLnPair, parseLnSwap, type LnPair } from '../src/lightning';
import recorded from './fixtures/lightning/swaps.json';

const [coinos, sats] = LN_PROVIDERS as [(typeof LN_PROVIDERS)[number], (typeof LN_PROVIDERS)[number]];
const pairOf = (percentage: number, minerFees: number, minimal: number, maximal: number) => ({ BTC: { BTC: { hash: 'a'.repeat(64), rate: 1, limits: { minimal, maximal, maximalZeroConf: 0 }, fees: { percentage, minerFees } } } });
// Limits and fees read over Tor on 2026-11-04.
const coinosAnswer = pairOf(0.1, 302, 25_000, 600_000);
const satsAnswer = pairOf(0.5, 167, 50_000, 5_000_000);
const cp = parseLnPair(coinos, coinosAnswer) as LnPair;
const sp = parseLnPair(sats, satsAnswer) as LnPair;
const swaps = recorded.swaps as Array<{ invoice: string; refundPublicKey: string; response: Parameters<typeof parseLnSwap>[1] }>;

describe('pairs', () => {
  it('reads real limits and fees', () => {
    expect(cp).toMatchObject({ minimal: 25_000, maximal: 600_000, percentage: 0.1, minerFees: 302 });
    expect(lnProviderFee(cp, 100_000n)).toBe(402n);
    expect(lnProviderFee(sp, 100_000n)).toBe(667n);
  });
  it('rounds the percentage up', () => {
    expect(lnProviderFee(cp, 100_001n)).toBe(403n);
  });
  it('refuses a malformed pair', () => {
    expect(parseLnPair(coinos, {})).toBeNull();
    expect(parseLnPair(coinos, pairOf(6, 302, 1, 2))).toBeNull();
    expect(parseLnPair(coinos, pairOf(0.1, -1, 1, 2))).toBeNull();
    expect(parseLnPair(coinos, { BTC: { BTC: { ...coinosAnswer.BTC.BTC, hash: 'nope' } } })).toBeNull();
  });
  it('orders by cost and respects limits', () => {
    expect(lnPairsFor([sp, cp], 100_000n).map((p) => p.provider.id)).toEqual(['coinos', 'satsrouting']);
    expect(lnPairsFor([sp, cp], 30_000n).map((p) => p.provider.id)).toEqual(['coinos']);
    expect(lnPairsFor([sp, cp], 1_000_000n).map((p) => p.provider.id)).toEqual(['satsrouting']);
    expect(lnPairsFor([sp, cp], 24_999n)).toEqual([]);
    expect(lnPairsFor([sp, cp], 5_000_001n)).toEqual([]);
  });
  it('leaves out a provider that does not answer', async () => {
    const fetcher: NetFetch = async (r) => (r.url.includes('coinos') ? { status: 502, body: '<html>' } : { status: 200, body: JSON.stringify(satsAnswer) });
    expect((await lnPairs(fetcher)).map((p) => p.provider.id)).toEqual(['satsrouting']);
  });
});

describe('swap answers', () => {
  it('reads the recorded answers', () => {
    const c = parseLnSwap(cp, swaps[0]!.response, 100_000n);
    expect(c.expectedAmount).toBe(100_402);
    expect(c.claimLeaf.startsWith('a914')).toBe(true);
    expect(parseLnSwap(sp, swaps[1]!.response, 100_000n).expectedAmount).toBe(100_667);
  });
  it('refuses another fee than the one announced', () => {
    expect(() => parseLnSwap(cp, { ...swaps[0]!.response, expectedAmount: 100_403 }, 100_000n)).toThrow(/fees announced|frais annoncés/);
  });
  it('refuses a missing field or another leaf version', () => {
    const r = swaps[0]!.response;
    expect(() => parseLnSwap(cp, { ...r, address: undefined }, 100_000n)).toThrow();
    expect(() => parseLnSwap(cp, { ...r, swapTree: { ...r.swapTree, refundLeaf: { version: 193, output: '00' } } }, 100_000n)).toThrow();
  });
  it('posts the invoice, the key and the pair it read', async () => {
    let sent = '';
    const fetcher: NetFetch = async (r) => {
      sent = String(r.body);
      return { status: 201, body: JSON.stringify(swaps[0]!.response) };
    };
    await lnCreateSwap(fetcher, cp, swaps[0]!.invoice, swaps[0]!.refundPublicKey, 100_000n);
    expect(JSON.parse(sent)).toEqual({ from: 'BTC', to: 'BTC', invoice: swaps[0]!.invoice, refundPublicKey: swaps[0]!.refundPublicKey, pairHash: cp.hash });
  });
  it('gives the provider its words', async () => {
    const fetcher: NetFetch = async () => ({ status: 400, body: '{"error":"invoice expiry too short"}' });
    const e = await lnCreateSwap(fetcher, cp, 'x', 'y', 1n).catch((x: unknown) => x);
    expect(lnErrorText(e)).toBe('invoice expiry too short');
  });
});

describe('status', () => {
  it('maps the provider words', () => {
    for (const s of ['invoice.paid', 'transaction.claim.pending', 'transaction.claimed']) expect(lnStatusOf(s)).toBe('SUCCESS');
    for (const s of ['invoice.failedToPay', 'transaction.lockupFailed', 'swap.expired', 'invoice.expired']) expect(lnStatusOf(s)).toBe('FAILED');
    for (const s of ['swap.created', 'invoice.set', 'transaction.mempool', 'transaction.confirmed', 'invoice.pending', '']) expect(lnStatusOf(s)).toBe('PROCESSING');
  });
  it('refuses an id that could change the path', async () => {
    await expect(lnSwapStatus(async () => ({ status: 200, body: '{}' }), coinos, '../x')).rejects.toThrow();
  });
  it('finds the provider back from the bridge name', () => {
    expect(lnProviderOfBridge(lnBridgeOf('satsrouting'))?.name).toBe('SATS Routing');
    expect(lnProviderOfBridge('exolix')).toBeUndefined();
  });
});

describe('Kyro fee', () => {
  it('rounds up, with a floor that can relay', () => {
    expect(lnKyroFee(100_402n, 120)).toBe(1_205n);
    expect(lnKyroFee(25_000n, 180)).toBe(546n);
    expect(lnKyroFee(100_000n, 0)).toBe(0n);
  });
});

describe('looksLikeInvoice', () => {
  it('tells invoices from addresses', () => {
    expect(looksLikeInvoice('lnbc1m1p4whq')).toBe(true);
    expect(looksLikeInvoice(' LIGHTNING:LNBC1M1P ')).toBe(true);
    expect(looksLikeInvoice('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq')).toBe(false);
    expect(looksLikeInvoice('lnurl1dp68')).toBe(false);
  });
});
