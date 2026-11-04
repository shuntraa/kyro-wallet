// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyReceived, evaluatePrices, evaluateReceived, getAlertSettings, MAX_RECEIVED_PER_PASS, parseLevel, saveAlertSettings, type PriceAlert, type ReceivableEntry } from './alerts';

const rule = (over: Partial<PriceAlert> = {}): PriceAlert => ({ id: 'a', coinId: 'bitcoin', symbol: 'BTC', direction: 'above', level: 100, currency: 'USD', armed: true, ...over });
const at = (price: number | null) => () => price;

describe('price alerts', () => {
  it('fires once past the level, in both directions', () => {
    const up = evaluatePrices([rule()], at(100), 'USD');
    expect(up.hits).toHaveLength(1);
    expect(up.rules[0]?.armed).toBe(false);
    expect(evaluatePrices(up.rules, at(120), 'USD').hits).toHaveLength(0);
    expect(evaluatePrices([rule({ direction: 'below' })], at(100), 'USD').hits).toHaveLength(1);
    expect(evaluatePrices([rule({ direction: 'below' })], at(101), 'USD').hits).toHaveLength(0);
    expect(evaluatePrices([rule()], at(99.99), 'USD').hits).toHaveLength(0);
  });

  it('fires again only after the price came back past the margin', () => {
    let rules = evaluatePrices([rule()], at(101), 'USD').rules;
    rules = evaluatePrices(rules, at(99.5), 'USD').rules; // jitter around the level
    expect(rules[0]?.armed).toBe(false);
    expect(evaluatePrices(rules, at(101), 'USD').hits).toHaveLength(0);
    rules = evaluatePrices(rules, at(98), 'USD').rules;
    expect(rules[0]?.armed).toBe(true);
    expect(evaluatePrices(rules, at(101), 'USD').hits).toHaveLength(1);
  });

  it('sleeps without a usable price or in another currency', () => {
    for (const p of [null, 0, -1, Number.NaN]) expect(evaluatePrices([rule()], at(p), 'USD').hits).toHaveLength(0);
    const other = evaluatePrices([rule()], at(500), 'EUR');
    expect(other.hits).toHaveLength(0);
    expect(other.rules[0]?.armed).toBe(true);
  });

  it('reads the levels people type', () => {
    expect(parseLevel('70 000,50')).toBe(70000.5);
    expect(parseLevel('0.00001')).toBe(0.00001);
    for (const bad of ['', '0', 'abc', '1e9', '-5', '1.2.3']) expect(parseLevel(bad)).toBeNull();
  });
});

const NOW = 1_000_000;
const tx = (id: string, over: Partial<ReceivableEntry> = {}): ReceivableEntry => ({ id, chainKey: 'bitcoin', kind: 'transfer', direction: 'in', status: 'confirmed', amount: 5n, time: NOW + 10, ...over });

describe('received alerts', () => {
  it('treats what a chain already holds as the past', () => {
    const first = evaluateReceived([tx('old', { time: NOW - 5 })], ['bitcoin'], emptyReceived(), NOW);
    expect(first.hits).toHaveLength(0);
    const second = evaluateReceived([tx('old', { time: NOW - 5 }), tx('new')], ['bitcoin'], first.state, NOW + 60);
    expect(second.hits.map((h) => h.id)).toEqual(['new']);
    expect(evaluateReceived([tx('new')], ['bitcoin'], second.state, NOW + 120).hits).toHaveLength(0);
  });

  it('waits for an unreachable chain, then keeps its past quiet', () => {
    const a = evaluateReceived([tx('x', { chainKey: 'ethereum' })], ['bitcoin'], emptyReceived(), NOW);
    expect(a.hits).toHaveLength(0);
    expect(a.state.seen).toHaveLength(0);
    const b = evaluateReceived([tx('x', { chainKey: 'ethereum' })], ['bitcoin', 'ethereum'], a.state, NOW + 1);
    expect(b.hits).toHaveLength(0);
    expect(b.state.seen).toEqual(['x']);
  });

  it('never announces a send, a lure, a zero or something unconfirmed', () => {
    const base = evaluateReceived([], ['bitcoin'], emptyReceived(), NOW).state;
    const noise = [tx('a', { direction: 'out' }), tx('b', { suspect: 'zero' }), tx('c', { amount: 0n }), tx('d', { kind: 'swap' }), tx('e', { status: 'pending' })];
    expect(evaluateReceived(noise, ['bitcoin'], base, NOW + 1).hits).toHaveLength(0);
  });

  it('announces a pending payment once it confirms', () => {
    const base = evaluateReceived([], ['bitcoin'], emptyReceived(), NOW).state;
    const pending = evaluateReceived([tx('p', { status: 'pending' })], ['bitcoin'], base, NOW + 1);
    expect(evaluateReceived([tx('p')], ['bitcoin'], pending.state, NOW + 2).hits).toHaveLength(1);
  });

  it('caps a pass and does not repeat the rest later', () => {
    const base = evaluateReceived([], ['bitcoin'], emptyReceived(), NOW).state;
    const many = Array.from({ length: 10 }, (_, i) => tx(`t${i}`));
    const r = evaluateReceived(many, ['bitcoin'], base, NOW + 1);
    expect(r.hits).toHaveLength(MAX_RECEIVED_PER_PASS);
    expect(evaluateReceived(many, ['bitcoin'], r.state, NOW + 2).hits).toHaveLength(0);
  });
});

describe('alert settings', () => {
  beforeEach(() => {
    const store: Record<string, string> = {};
    vi.stubGlobal('window', { localStorage: { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => void (store[k] = v) } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('are off by default and drop damaged rules', () => {
    expect(getAlertSettings()).toEqual({ received: false, prices: [] });
    saveAlertSettings({ received: true, prices: [rule(), { ...rule(), level: -1 }, { nope: 1 } as unknown as PriceAlert] });
    const s = getAlertSettings();
    expect(s.received).toBe(true);
    expect(s.prices).toHaveLength(1);
  });
});
