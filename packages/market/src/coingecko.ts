// SPDX-License-Identifier: GPL-3.0-or-later
//
// CoinGecko client over `net_fetch`, cached with 429 backoff. The API key is injected by Rust, never sent from JS.

import { HttpError, fetchJson, netFetch, type Currency, type NetFetch } from '@kyro/shared';

export interface MarketCoin {
  id: string;
  symbol: string;
  name: string;
  rank: number | null;
  price: number;
  marketCap: number | null;
  volume24h: number | null;
  high24h: number | null;
  low24h: number | null;
  change24h: number | null;
  change7d: number | null;
  sparkline7d: number[];
}

export type ChartDays = 1 | 7 | 30 | 365 | 'max';
export type ChartPoint = [time: number, price: number];

export interface SimplePrice {
  price: number;
  change24h: number | null;
}

export interface CacheStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface CoinGeckoOptions {
  fetch?: NetFetch;
  /** Use pro-api.coingecko.com (paid key). Default: public/demo API. */
  pro?: boolean;
  ttlMs?: number;
  /** Persistent cache; default `window.localStorage` when available. `null` disables it. */
  storage?: CacheStorage | null;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  now?: () => number;
}

interface CacheEntry<T> {
  t: number;
  data: T;
}

interface RawMarket {
  id: string;
  symbol: string;
  name: string;
  market_cap_rank: number | null;
  current_price: number | null;
  market_cap: number | null;
  total_volume: number | null;
  high_24h: number | null;
  low_24h: number | null;
  price_change_percentage_24h_in_currency?: number | null;
  price_change_percentage_24h?: number | null;
  price_change_percentage_7d_in_currency?: number | null;
  sparkline_in_7d?: { price: number[] } | null;
}

const PREFIX = 'kyro.cg.';

function defaultStorage(): CacheStorage | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

export class CoinGeckoClient {
  private readonly fetcher: NetFetch;
  private readonly base: string;
  private readonly ttl: number;
  private readonly storage: CacheStorage | null;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly now: () => number;
  private readonly memory = new Map<string, CacheEntry<unknown>>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  /** Time of the last successful network answer (UI: "il y a 42 s"). */
  lastUpdated: number | null = null;

  constructor(opts: CoinGeckoOptions = {}) {
    this.fetcher = opts.fetch ?? netFetch;
    this.base = opts.pro ? 'https://pro-api.coingecko.com/api/v3' : 'https://api.coingecko.com/api/v3';
    this.ttl = opts.ttlMs ?? 60_000;
    this.storage = opts.storage === undefined ? defaultStorage() : opts.storage;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxRetries = opts.maxRetries ?? 3;
    this.now = opts.now ?? Date.now;
  }

  private read<T>(key: string): CacheEntry<T> | null {
    const mem = this.memory.get(key) as CacheEntry<T> | undefined;
    if (mem) return mem;
    if (!this.storage) return null;
    try {
      const raw = this.storage.getItem(PREFIX + key);
      if (!raw) return null;
      const entry = JSON.parse(raw) as CacheEntry<T>;
      this.memory.set(key, entry);
      return entry;
    } catch {
      return null;
    }
  }

  private write<T>(key: string, data: T): void {
    const entry = { t: this.now(), data };
    this.memory.set(key, entry);
    if (!this.storage) return;
    try {
      this.storage.setItem(PREFIX + key, JSON.stringify(entry));
    } catch {
      // Quota exceeded / storage disabled: memory cache only.
    }
  }

  /** GET with cache, de-duplication and 429 backoff (1 s, 2 s, 4 s…). Serves stale data if the network fails. */
  private async get<T>(key: string, path: string, ttl = this.ttl): Promise<T> {
    const cached = this.read<T>(key);
    if (cached && this.now() - cached.t < ttl) return cached.data;
    const running = this.inflight.get(key) as Promise<T> | undefined;
    if (running) return running;
    const p = (async () => {
      let attempt = 0;
      for (;;) {
        try {
          const data = await fetchJson<T>(this.fetcher, `${this.base}${path}`);
          this.write(key, data);
          this.lastUpdated = this.now();
          return data;
        } catch (e) {
          if (e instanceof HttpError && e.status === 429 && attempt < this.maxRetries) {
            await this.sleep(1000 * 2 ** attempt);
            attempt += 1;
            continue;
          }
          if (cached) return cached.data;
          throw e;
        }
      }
    })();
    this.inflight.set(key, p);
    try {
      return await p;
    } finally {
      this.inflight.delete(key);
    }
  }

  async markets(currency: Currency, perPage = 250): Promise<MarketCoin[]> {
    const vs = currency.toLowerCase();
    const raw = await this.get<RawMarket[]>(
      `markets:${vs}:${perPage}`,
      `/coins/markets?vs_currency=${vs}&order=market_cap_desc&per_page=${perPage}&page=1&sparkline=true&price_change_percentage=24h,7d`,
    );
    return raw.map(normaliseMarket);
  }

  /** Price history: `days` = 1, 7, 30, 365 or 'max'. */
  async chart(id: string, currency: Currency, days: ChartDays): Promise<ChartPoint[]> {
    const vs = currency.toLowerCase();
    const ttl = days === 1 ? this.ttl : days === 7 ? this.ttl * 5 : this.ttl * 30;
    const res = await this.get<{ prices: ChartPoint[] }>(`chart:${id}:${vs}:${days}`, `/coins/${encodeURIComponent(id)}/market_chart?vs_currency=${vs}&days=${days}`, ttl);
    return res.prices.filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  }

  async simplePrice(ids: string[], currency: Currency): Promise<Record<string, SimplePrice>> {
    if (ids.length === 0) return {};
    const vs = currency.toLowerCase();
    const sorted = [...new Set(ids)].sort();
    const raw = await this.get<Record<string, Record<string, number>>>(
      `simple:${vs}:${sorted.join(',')}`,
      `/simple/price?ids=${sorted.map(encodeURIComponent).join(',')}&vs_currencies=${vs}&include_24hr_change=true`,
    );
    const out: Record<string, SimplePrice> = {};
    for (const [id, v] of Object.entries(raw)) {
      const price = v[vs];
      // A price that is not a finite positive number is no price at all.
      if (typeof price === 'number' && Number.isFinite(price) && price > 0) out[id] = { price, change24h: v[`${vs}_24h_change`] ?? null };
    }
    return out;
  }

  clear(): void {
    this.memory.clear();
    if (!this.storage) return;
    try {
      const keys: string[] = [];
      const s = this.storage as CacheStorage & { length?: number; key?: (i: number) => string | null };
      if (typeof s.length === 'number' && s.key) {
        for (let i = 0; i < s.length; i++) {
          const k = s.key(i);
          if (k?.startsWith(PREFIX)) keys.push(k);
        }
      }
      keys.forEach((k) => s.removeItem(k));
    } catch {
      /* ignore */
    }
  }
}

function num(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Coins renamed after a cached list could have been made: Toncoin → Gram (GRAM, June 2026). */
const RENAMED: Record<string, { name: string; symbol: string }> = {
  'the-open-network': { name: 'Gram', symbol: 'GRAM' },
};

export function normaliseMarket(r: RawMarket): MarketCoin {
  const renamed = RENAMED[r.id];
  return {
    id: r.id,
    symbol: renamed?.symbol ?? r.symbol.toUpperCase(),
    name: renamed?.name ?? r.name,
    rank: r.market_cap_rank ?? null,
    price: r.current_price ?? 0,
    marketCap: num(r.market_cap),
    volume24h: num(r.total_volume),
    high24h: num(r.high_24h),
    low24h: num(r.low_24h),
    change24h: num(r.price_change_percentage_24h_in_currency ?? r.price_change_percentage_24h),
    change7d: num(r.price_change_percentage_7d_in_currency),
    sparkline7d: (r.sparkline_in_7d?.price ?? []).filter((x) => Number.isFinite(x)),
  };
}
