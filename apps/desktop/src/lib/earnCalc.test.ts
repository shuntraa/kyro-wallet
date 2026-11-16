// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { assetsFor } from '@kyro/chains';
import { EARN_OPTIONS, rewardsWaitForClaim } from './earn';
import { bestByRisk, earnAsset, gainCurve, projectedGain } from './earnCalc';

const of = (id: string) => EARN_OPTIONS.find((o) => o.id === id)!;

describe('projected gain', () => {
  it('rewards left in place compound, rewards set aside do not', () => {
    expect(projectedGain(1000, 5, 12, false)).toBeCloseTo(50, 6);
    expect(projectedGain(1000, 5, 60, false)).toBeCloseTo(276.28, 2);
    expect(projectedGain(1000, 5, 60, true)).toBeCloseTo(250, 6);
    expect(projectedGain(1000, 5, 1, false)).toBeCloseTo(4.074, 2);
    expect(projectedGain(1000, 5, 1, true)).toBeCloseTo(4.167, 2);
  });

  it('nothing to show is zero, never NaN', () => {
    expect(projectedGain(0, 5, 12, false)).toBe(0);
    expect(projectedGain(-1, 5, 12, false)).toBe(0);
    expect(projectedGain(Number.NaN, 5, 12, false)).toBe(0);
    expect(projectedGain(1000, Number.NaN, 12, false)).toBe(0);
    expect(projectedGain(1000, 0, 12, false)).toBe(0);
  });
});

describe('which rewards compound', () => {
  it('all of them but TRON, Lido included', () => {
    expect(EARN_OPTIONS.filter(rewardsWaitForClaim).map((o) => o.id)).toEqual(['trx']);
  });

  it('five years on Lido earn more than five times one year', () => {
    const b = bestByRisk([of('eth-lido')], () => 4.25, () => 1000, 60);
    expect(b.medium?.gain).toBeCloseTo(231.35, 1);
  });
});

describe('the curve', () => {
  it('starts at the amount and ends at amount plus gain', () => {
    for (const months of [1, 12, 60] as const) {
      const c = gainCurve(1000, 5, months, false);
      expect(c[0]).toEqual({ months: 0, value: 1000 });
      expect(c.at(-1)?.months).toBeCloseTo(months, 6);
      expect(c.at(-1)?.value).toBeCloseTo(1000 + projectedGain(1000, 5, months, false), 6);
    }
  });

  it('one point a day over a month, one a month otherwise, always rising', () => {
    expect(gainCurve(1000, 5, 1, false)).toHaveLength(31);
    expect(gainCurve(1000, 5, 60, true)).toHaveLength(61);
    const c = gainCurve(1000, 5, 12, false);
    for (let i = 1; i < c.length; i++) expect(c[i]!.value).toBeGreaterThan(c[i - 1]!.value);
  });
});

describe('best at each risk level', () => {
  const rates: Record<string, number> = { sol: 5.2, ada: 2, 'usdt-aave': 5.3, 'usdc-aave': 4, 'usdc-aave-base': 4.7 };
  const rateOf = (o: { id: string }) => rates[o.id] ?? null;

  it('keeps the highest gain of each level, and skips options without a rate', () => {
    const b = bestByRisk(EARN_OPTIONS, rateOf, () => 1000, 12);
    expect(b.low?.option.id).toBe('sol');
    expect(b.low?.gain).toBeCloseTo(52, 6);
    expect(b.medium?.option.id).toBe('usdt-aave');
    expect(b.high?.option.id).toBe('usdc-aave-base');
  });

  it('with your balances a smaller rate can win, and an empty balance does not count', () => {
    const held: Record<string, number> = { ada: 5000, sol: 100 };
    const b = bestByRisk(EARN_OPTIONS, rateOf, (o) => held[o.id] ?? 0, 12);
    expect(b.low?.option.id).toBe('ada');
    expect(b.medium).toBeUndefined();
  });
});

describe('the coin behind each option', () => {
  it('every mainnet option finds its asset, with the right symbol', () => {
    const assets = assetsFor('mainnet');
    // WETH is not a tracked asset: "what I hold" counts nothing for it.
    for (const o of EARN_OPTIONS) expect(earnAsset(o, assets)?.symbol, o.id).toBe(o.id === 'weth-aave' ? undefined : o.symbol);
  });

  it('the same coin on two networks stays apart', () => {
    const assets = assetsFor('mainnet');
    expect(earnAsset(of('usdc-aave-base'), assets)?.chainKey).toBe('base');
    expect(earnAsset(of('usdc-aave'), assets)?.chainKey).toBe('ethereum');
  });
});
