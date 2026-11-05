// SPDX-License-Identifier: GPL-3.0-or-later
// Earn calculator: what an amount would earn at today's rate. An estimate at a constant rate and a
// constant price, nothing more; the screen says so.

import type { AssetDef } from '@kyro/chains';
import { AAVE_MARKETS, earnRisk, rateIsApr, type EarnOption, type EarnRisk } from './earn';

export type CalcMonths = 1 | 12 | 60;

/** An APY compounds over the period; an APR is simple interest. */
export function projectedGain(amount: number, ratePct: number, months: number, apr: boolean): number {
  if (!(amount > 0) || !(ratePct > 0) || !(months > 0)) return 0;
  const rate = ratePct / 100;
  const years = months / 12;
  return apr ? amount * rate * years : amount * (Math.pow(1 + rate, years) - 1);
}

export interface CurvePoint {
  months: number;
  value: number;
}

/** Amount plus gain along the period, for the curve: by day over a month, else by month. */
export function gainCurve(amount: number, ratePct: number, months: CalcMonths, apr: boolean): CurvePoint[] {
  const steps = months === 1 ? 30 : months;
  return Array.from({ length: steps + 1 }, (_, i) => {
    const at = (months * i) / steps;
    return { months: at, value: amount + projectedGain(amount, ratePct, at, apr) };
  });
}

export interface CalcPick {
  option: EarnOption;
  rate: number;
  amount: number;
  gain: number;
}

/** The option that earns the most at each risk level, among those with a rate and an amount. */
export function bestByRisk(options: EarnOption[], rateOf: (o: EarnOption) => number | null, amountOf: (o: EarnOption) => number, months: number): Partial<Record<EarnRisk, CalcPick>> {
  const out: Partial<Record<EarnRisk, CalcPick>> = {};
  for (const option of options) {
    const rate = rateOf(option);
    const amount = amountOf(option);
    if (rate === null || !(amount > 0)) continue;
    const gain = projectedGain(amount, rate, months, rateIsApr(option));
    const risk = earnRisk(option);
    const best = out[risk];
    if (!best || gain > best.gain) out[risk] = { option, rate, amount, gain };
  }
  return out;
}

const TAB_CHAIN = { sol: 'solana', ada: 'cardano', tron: 'tron', near: 'near', sui: 'sui', apt: 'aptos' } as const;

/** The coin this option puts to work. */
export function earnAsset(o: EarnOption, assets: AssetDef[]): AssetDef | undefined {
  if (o.target.kind === 'aave') {
    const m = AAVE_MARKETS[o.target.market];
    return assets.find((a) => a.chainKey === m?.chainKey && a.contract?.toLowerCase() === m?.asset);
  }
  const chainKey = o.target.kind === 'lido' ? 'ethereum' : TAB_CHAIN[o.target.chain];
  return assets.find((a) => a.chainKey === chainKey && a.kind === 'native');
}
