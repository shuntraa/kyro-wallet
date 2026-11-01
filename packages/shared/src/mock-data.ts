// SPDX-License-Identifier: GPL-3.0-or-later
//
// DEMO DATA ONLY — used by the in-memory backend when the app runs in a plain
// browser (no Tauri). Nothing here is ever used by the real application.

export interface DemoCoin {
  id: string;
  symbol: string;
  name: string;
  /** EUR price. */
  price: number;
  change24h: number;
  change7d: number;
  marketCapEur: number;
}

export const DEMO_EUR_USD = 1.08;

export const DEMO_COINS: DemoCoin[] = [
  { id: 'bitcoin', symbol: 'btc', name: 'Bitcoin', price: 58_900, change24h: 1.2, change7d: 3.4, marketCapEur: 1.16e12 },
  { id: 'ethereum', symbol: 'eth', name: 'Ethereum', price: 2_310, change24h: -0.8, change7d: 2.1, marketCapEur: 2.78e11 },
  { id: 'tether', symbol: 'usdt', name: 'Tether', price: 0.926, change24h: 0.01, change7d: -0.02, marketCapEur: 1.1e11 },
  { id: 'binancecoin', symbol: 'bnb', name: 'BNB', price: 512, change24h: 0.6, change7d: -1.3, marketCapEur: 7.5e10 },
  { id: 'solana', symbol: 'sol', name: 'Solana', price: 138, change24h: 2.9, change7d: 6.5, marketCapEur: 6.4e10 },
  { id: 'usd-coin', symbol: 'usdc', name: 'USDC', price: 0.926, change24h: 0, change7d: 0.01, marketCapEur: 3.3e10 },
  { id: 'ripple', symbol: 'xrp', name: 'XRP', price: 0.48, change24h: 0.7, change7d: -2.2, marketCapEur: 2.7e10 },
  { id: 'dogecoin', symbol: 'doge', name: 'Dogecoin', price: 0.112, change24h: -1.9, change7d: 4.8, marketCapEur: 1.6e10 },
  { id: 'tron', symbol: 'trx', name: 'TRON', price: 0.141, change24h: 0.3, change7d: 1.1, marketCapEur: 1.2e10 },
  { id: 'cardano', symbol: 'ada', name: 'Cardano', price: 0.33, change24h: -0.4, change7d: -3.1, marketCapEur: 1.17e10 },
  { id: 'stellar', symbol: 'xlm', name: 'Stellar', price: 0.087, change24h: 1.1, change7d: -1.6, marketCapEur: 2.6e9 },
  { id: 'avalanche-2', symbol: 'avax', name: 'Avalanche', price: 23.4, change24h: 1.5, change7d: 0.4, marketCapEur: 9.5e9 },
  { id: 'wrapped-bitcoin', symbol: 'wbtc', name: 'Wrapped Bitcoin', price: 58_850, change24h: 1.2, change7d: 3.3, marketCapEur: 8.9e9 },
  { id: 'chainlink', symbol: 'link', name: 'Chainlink', price: 11.2, change24h: -2.4, change7d: 5.2, marketCapEur: 6.8e9 },
  { id: 'near', symbol: 'near', name: 'NEAR Protocol', price: 2.35, change24h: 1.8, change7d: -2.6, marketCapEur: 2.9e9 },
  { id: 'litecoin', symbol: 'ltc', name: 'Litecoin', price: 64.1, change24h: 0.2, change7d: -0.9, marketCapEur: 4.8e9 },
  { id: 'dai', symbol: 'dai', name: 'Dai', price: 0.925, change24h: 0, change7d: 0, marketCapEur: 4.6e9 },
  { id: 'polygon-ecosystem-token', symbol: 'pol', name: 'POL (ex-MATIC)', price: 0.37, change24h: -1.1, change7d: -4.4, marketCapEur: 3.1e9 },
  { id: 'arbitrum', symbol: 'arb', name: 'Arbitrum', price: 0.52, change24h: -2.1, change7d: -5.6, marketCapEur: 2.1e9 },
  { id: 'optimism', symbol: 'op', name: 'Optimism', price: 1.38, change24h: 0.9, change7d: 2.7, marketCapEur: 1.8e9 },
];

/** Deterministic PRNG (mulberry32) so demo charts are stable between reloads. */
export function seededRandom(seedText: string): () => number {
  let h = 1779033703 ^ seedText.length;
  for (let i = 0; i < seedText.length; i++) {
    h = Math.imul(h ^ seedText.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random walk of `points` values that ends at `end` after a total change of `changePct`. */
export function demoSeries(seed: string, points: number, end: number, changePct: number): number[] {
  const rnd = seededRandom(seed);
  const start = end / (1 + changePct / 100);
  const out: number[] = [];
  let noise = 0;
  for (let i = 0; i < points; i++) {
    const t = points === 1 ? 1 : i / (points - 1);
    noise = noise * 0.9 + (rnd() - 0.5) * 0.012;
    const base = start + (end - start) * t;
    out.push(i === points - 1 ? end : base * (1 + noise));
  }
  return out;
}

/** Known tokens for the demo swap/price engine: lowercase address → coin id + decimals. */
export const DEMO_TOKENS: Record<string, { coin: string; decimals: number }> = {
  '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee': { coin: 'ethereum', decimals: 18 },
  '0x0000000000000000000000000000000000000000': { coin: 'ethereum', decimals: 18 },
  '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238': { coin: 'usd-coin', decimals: 6 },
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { coin: 'usd-coin', decimals: 6 },
  '0xdac17f958d2ee523a2206206994597c13d831ec7': { coin: 'tether', decimals: 6 },
  '0x6b175474e89094c44da98b954eedeac495271d0f': { coin: 'dai', decimals: 18 },
  '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': { coin: 'wrapped-bitcoin', decimals: 8 },
  '0xaf88d065e77c8cc2239327c5edb3a432268e5831': { coin: 'usd-coin', decimals: 6 },
  '0x912ce59144191c1204e64559fe8253a0e49e6548': { coin: 'arbitrum', decimals: 18 },
  So11111111111111111111111111111111111111112: { coin: 'solana', decimals: 9 },
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { coin: 'usd-coin', decimals: 6 },
  '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU': { coin: 'usd-coin', decimals: 6 },
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { coin: 'tether', decimals: 6 },
};

export function demoPrice(coinId: string): number {
  return DEMO_COINS.find((c) => c.id === coinId)?.price ?? 1;
}
