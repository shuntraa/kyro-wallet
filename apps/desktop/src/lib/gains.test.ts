// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { computeGains, netOfOwnMoves, priceOfDay, totalGains, type GainEvent, type GainsInput } from './gains';

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const day = (n: number) => NOW - n * DAY;
let seq = 0;
const ev = (direction: GainEvent['direction'], units: number, ago: number, over: Partial<GainEvent> = {}): GainEvent => ({ id: `tx${seq++}`, direction, units, time: day(ago), status: 'confirmed', kind: 'transfer', ...over });

/** 100 before day 50, 200 after, nothing before day 300. */
const priceAt = (t: number): number | null => (t < day(300) ? null : t < day(50) ? 100 : 200);
const gains = (over: Partial<GainsInput>) => computeGains({ events: [], balance: 0, price: 300, priceAt, historyComplete: true, ...over });

describe('average cost', () => {
  it('uses the price of each day', () => {
    const g = gains({ events: [ev('in', 1, 100), ev('in', 1, 10)], balance: 2 });
    expect(g.cost).toBe(300);
    expect(g.averageCost).toBe(150);
    expect(g.gain).toBe(300);
    expect(g.gainPct).toBe(100);
    expect(g.coverage).toBe(1);
    expect(g.partial).toBe(false);
  });

  it('a send takes its share at the average, it does not change the average', () => {
    const g = gains({ events: [ev('in', 1, 100), ev('in', 1, 10), ev('out', 1, 5)], balance: 1 });
    expect(g.cost).toBe(150);
    expect(g.averageCost).toBe(150);
    expect(g.gain).toBe(150);
  });

  it('replays in time order, whatever the order of the list', () => {
    const a = [ev('in', 2, 100), ev('out', 1, 60), ev('in', 1, 10)];
    expect(gains({ events: [...a].reverse(), balance: 2 })).toEqual(gains({ events: a, balance: 2 }));
    expect(gains({ events: a, balance: 2 }).cost).toBe(300);
  });

  it('fees missing from the history come out of the pool, the average stays', () => {
    const g = gains({ events: [ev('in', 1, 100)], balance: 0.99 });
    expect(g.averageCost).toBeCloseTo(100);
    expect(g.cost).toBeCloseTo(99);
    expect(g.partial).toBe(false);
  });

  it('a loss is negative', () => {
    const g = gains({ events: [ev('in', 1, 10)], balance: 1, price: 150 });
    expect(g.gain).toBe(-50);
    expect(g.gainPct).toBe(-25);
  });
});

describe('what is ignored', () => {
  it('pending, failed, approvals, lures, moves to self and empty amounts', () => {
    const events = [ev('in', 1, 100), ev('in', 5, 10, { status: 'pending' }), ev('in', 5, 10, { status: 'failed' }), ev('out', 1, 5, { kind: 'approval' }), ev('in', 5, 5, { suspect: 'zero' }), ev('self', 1, 4), ev('in', 0, 3)];
    expect(gains({ events, balance: 1 }).cost).toBe(100);
  });

  it('a move between two of your accounts is not a sale and a purchase', () => {
    const events = [ev('in', 1, 100), ev('out', 1, 10, { id: 'hash:0' }), ev('in', 1, 10, { id: 'hash:1@1' })];
    const g = gains({ events, balance: 1 });
    expect(g.cost).toBe(100);
    expect(g.gain).toBe(200);
  });

  it('keeps the fee part of such a move as a send', () => {
    const net = netOfOwnMoves([ev('out', 1, 10, { id: 'h' }), ev('in', 0.9, 10, { id: 'h@1' })]);
    expect(net).toHaveLength(1);
    expect(net[0]?.direction).toBe('out');
    expect(net[0]?.units).toBeCloseTo(0.1);
  });
});

describe('partial data', () => {
  it('no history at all: no figure, marked partial', () => {
    const g = gains({ balance: 2 });
    expect([g.cost, g.averageCost, g.gain, g.gainPct]).toEqual([null, null, null, null]);
    expect(g.coverage).toBe(0);
    expect(g.partial).toBe(true);
  });

  it('nothing held: no figure, nothing missing', () => {
    expect(gains({ events: [ev('in', 1, 100), ev('out', 1, 5)], balance: 0 })).toMatchObject({ gain: null, partial: false });
  });

  it('an unknown day price stays out of the cost', () => {
    const g = gains({ events: [ev('in', 1, 400), ev('in', 1, 100)], balance: 2 });
    expect(g.coveredUnits).toBe(1);
    expect(g.cost).toBe(100);
    expect(g.gain).toBe(200);
    expect(g.coverage).toBe(0.5);
    expect(g.partial).toBe(true);
  });

  it('every day price unknown: no figure', () => {
    const g = gains({ events: [ev('in', 1, 400)], balance: 1 });
    expect(g.gain).toBeNull();
    expect(g.partial).toBe(true);
  });

  it('a transaction without a date has no price', () => {
    const g = gains({ events: [ev('in', 1, 100), ev('in', 1, 0, { time: undefined })], balance: 2 });
    expect(g.coveredUnits).toBe(1);
    expect(g.partial).toBe(true);
  });

  it('a send takes its share of the unpriced part too', () => {
    const g = gains({ events: [ev('in', 1, 400), ev('in', 1, 100), ev('out', 1, 5)], balance: 1 });
    expect(g.coveredUnits).toBe(0.5);
    expect(g.cost).toBe(50);
    expect(g.coverage).toBe(0.5);
  });

  it('coins of unknown origin: the balance is more than the history explains', () => {
    const g = gains({ events: [ev('in', 1, 100)], balance: 4 });
    expect(g.coveredUnits).toBe(1);
    expect(g.coverage).toBe(0.25);
    expect(g.partial).toBe(true);
  });

  it('more sent than ever seen: older receipts are missing', () => {
    const g = gains({ events: [ev('in', 1, 100), ev('out', 2, 60), ev('in', 1, 10)], balance: 1 });
    expect(g.cost).toBe(200);
    expect(g.coverage).toBe(1);
    expect(g.partial).toBe(true);
  });

  it('a capped history is partial even when the numbers add up', () => {
    expect(gains({ events: [ev('in', 1, 100)], balance: 1, historyComplete: false }).partial).toBe(true);
  });

  it('no current price: the cost is known, the gain is not', () => {
    const g = gains({ events: [ev('in', 1, 100)], balance: 1, price: null });
    expect(g.cost).toBe(100);
    expect(g.gain).toBeNull();
    expect(g.gainPct).toBeNull();
  });
});

describe('price of the day', () => {
  const series = [[day(500), 10], [day(493), 20], [day(100), 30], [day(99), 40], [day(1), 50]] as const;

  it('takes the nearest point', () => {
    expect(priceOfDay(series, day(99.2), NOW)).toBe(40);
    expect(priceOfDay(series, day(99.8), NOW)).toBe(30);
  });

  it('never reaches past the series or across a hole', () => {
    expect(priceOfDay(series, day(600), NOW)).toBeNull();
    expect(priceOfDay(series, day(50), NOW)).toBeNull();
    expect(priceOfDay([], day(1), NOW)).toBeNull();
  });

  it('allows a week around old points, two days around recent ones', () => {
    expect(priceOfDay(series, day(496), NOW)).toBe(20);
    expect(priceOfDay(series, day(508.5), NOW)).toBeNull();
    expect(priceOfDay(series, day(3.5), NOW)).toBeNull();
    expect(priceOfDay(series, day(2.5), NOW)).toBe(50);
  });

  it('a zero price is no price', () => {
    expect(priceOfDay([[day(1), 0]], day(1), NOW)).toBeNull();
  });
});

describe('total', () => {
  const full = gains({ events: [ev('in', 1, 100)], balance: 1 });
  const none = gains({ balance: 1 });

  it('adds the coins up', () => {
    const t = totalGains([{ gains: full, value: 300, price: 300 }, { gains: full, value: 300, price: 300 }]);
    expect(t).toMatchObject({ gain: 400, cost: 200, gainPct: 200, coverage: 1, partial: false });
  });

  it('leaves out a coin without a figure and says so', () => {
    const t = totalGains([{ gains: full, value: 300, price: 300 }, { gains: none, value: 100, price: 100 }]);
    expect(t).toMatchObject({ gain: 200, coverage: 0.75, partial: true });
  });

  it('a coin without a price makes the total partial', () => {
    expect(totalGains([{ gains: full, value: 300, price: 300 }, { gains: none, value: null, price: null }]).partial).toBe(true);
  });

  it('no figure at all gives no total', () => {
    expect(totalGains([{ gains: none, value: 100, price: 100 }])).toMatchObject({ gain: null, partial: true });
    expect(totalGains([])).toMatchObject({ gain: null, partial: false });
  });
});
