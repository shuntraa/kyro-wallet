import { describe, expect, it } from 'vitest';
import type { NetRequest, NetResponse } from '@kyro/shared';
import { CoinGeckoClient } from '../src';

function memStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
}

const market = [{ id: 'bitcoin', symbol: 'btc', name: 'Bitcoin', market_cap_rank: 1, current_price: 60000, market_cap: 1, total_volume: 1, high_24h: 1, low_24h: 1, price_change_percentage_24h_in_currency: 1.5, price_change_percentage_7d_in_currency: -2, sparkline_in_7d: { price: [1, 2, 3] } }];

describe('CoinGeckoClient', () => {
  it('requests the top 250 with sparkline and caches for the TTL', async () => {
    const urls: string[] = [];
    let now = 1_000;
    const fetch = async (req: NetRequest): Promise<NetResponse> => {
      urls.push(req.url);
      return { status: 200, body: JSON.stringify(market) };
    };
    const cg = new CoinGeckoClient({ fetch, storage: null, now: () => now });
    const a = await cg.markets('EUR');
    expect(a[0]).toMatchObject({ id: 'bitcoin', symbol: 'BTC', price: 60000, change24h: 1.5, change7d: -2, sparkline7d: [1, 2, 3] });
    expect(urls[0]).toContain('/coins/markets?vs_currency=eur');
    expect(urls[0]).toContain('per_page=250');
    expect(urls[0]).toContain('sparkline=true');
    expect(urls[0]).toContain('price_change_percentage=24h,7d');
    await cg.markets('EUR');
    expect(urls).toHaveLength(1);
    now += 61_000;
    await cg.markets('EUR');
    expect(urls).toHaveLength(2);
  });

  it('backs off exponentially on 429 then succeeds', async () => {
    const waits: number[] = [];
    let calls = 0;
    const fetch = async (): Promise<NetResponse> => (++calls < 3 ? { status: 429, body: '' } : { status: 200, body: JSON.stringify({ bitcoin: { eur: 1, eur_24h_change: 2 } }) });
    const cg = new CoinGeckoClient({ fetch, storage: null, sleep: async (ms) => void waits.push(ms) });
    const p = await cg.simplePrice(['bitcoin'], 'EUR');
    expect(p.bitcoin).toEqual({ price: 1, change24h: 2 });
    expect(waits).toEqual([1000, 2000]);
  });

  it('gives up after maxRetries and serves stale cache on failure', async () => {
    const storage = memStorage();
    let now = 0;
    let fail = false;
    const fetch = async (): Promise<NetResponse> => (fail ? { status: 429, body: '' } : { status: 200, body: JSON.stringify(market) });
    const cg = new CoinGeckoClient({ fetch, storage, now: () => now, sleep: async () => {}, maxRetries: 2 });
    await cg.markets('USD');
    fail = true;
    now = 10 * 60_000;
    const stale = await cg.markets('USD');
    expect(stale[0]?.id).toBe('bitcoin');
    const cold = new CoinGeckoClient({ fetch, storage: null, sleep: async () => {}, maxRetries: 1 });
    await expect(cold.markets('USD')).rejects.toThrow(/429/);
  });

  it('survives a broken localStorage', async () => {
    const storage = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('quota'); }, removeItem: () => {} };
    const cg = new CoinGeckoClient({ fetch: async () => ({ status: 200, body: JSON.stringify(market) }), storage });
    expect(await cg.markets('EUR')).toHaveLength(1);
  });
});
