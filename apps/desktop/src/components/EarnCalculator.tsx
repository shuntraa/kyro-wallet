// SPDX-License-Identifier: GPL-3.0-or-later
// Top of the Earn screen, built like the Portfolio's: one large figure and its curve. It shows what
// an amount, or what the wallet holds, would earn at today's rates, one risk level at a time.

import { useMemo, useState } from 'react';
import { assetsFor, unitsToNumber } from '@kyro/chains';
import { useApp } from '../state/app';
import { usePortfolio } from '../state/portfolio';
import { earnRowName, EARN_OPTIONS, rateIsApr, type EarnOption, type EarnRisk, type RateStore } from '../lib/earn';
import { bestByRisk, earnAsset, gainCurve, projectedGain, type CalcMonths } from '../lib/earnCalc';
import { cn } from '../lib/cn';
import { fmtFiat, fmtPct, sanitizeDecimalInput } from '../lib/format';
import { readJson, writeJson } from '../lib/storage';
import { useT } from '../i18n';
import { SmoothChart } from './charts';
import { BigFiat, HIDDEN } from './kit';
import { Input, Segmented } from './ui/primitives';

const RISKS: EarnRisk[] = ['low', 'medium', 'high'];
const DOT = { low: 'bg-up', medium: 'bg-warn', high: 'bg-down' } as const;
const LEVEL = { low: 'earn.calcLevelLow', medium: 'earn.calcLevelMedium', high: 'earn.calcLevelHigh' } as const;
const PER = { 1: 'earn.calcPerMonth', 12: 'earn.calcPerYear', 60: 'earn.calcPer5Years' } as const;
const GAIN = { 1: 'earn.calcGain1', 12: 'earn.calcGain12', 60: 'earn.calcGain60' } as const;
const CHART_H = 112;

type Source = 'amount' | 'mine';

export interface EarnCalc {
  /** What this option would earn, as text; null with nothing to show. */
  gainLine: (o: EarnOption, rate: number | null) => string | null;
  panel: { amount: string; setAmount: (v: string) => void; months: CalcMonths; setMonths: (m: CalcMonths) => void; source: Source; setSource: (s: Source) => void; amountOf: (o: EarnOption) => number };
}

export function useEarnCalc(): EarnCalc {
  const { network, settings, hideBalances } = useApp();
  const pf = usePortfolio();
  const { t } = useT();
  const [amount, setAmountState] = useState(() => readJson<string>('earn.calc.amount', '1000'));
  const [months, setMonths] = useState<CalcMonths>(12);
  const [source, setSource] = useState<Source>('amount');
  const assets = useMemo(() => assetsFor(network), [network]);
  const typed = Number(amount.replace(',', '.'));
  const amountOf = (o: EarnOption): number => {
    if (source === 'amount') return Number.isFinite(typed) ? typed : 0;
    const a = earnAsset(o, assets);
    const price = a ? pf.price(a.coingeckoId)?.price : undefined;
    return a && price !== undefined ? unitsToNumber(pf.balances.get(a.id) ?? 0n, a.decimals) * price : 0;
  };
  const setAmount = (v: string) => {
    setAmountState(v);
    writeJson('earn.calc.amount', v);
  };
  return {
    gainLine: (o, rate) => {
      if (rate === null) return null;
      const gain = projectedGain(amountOf(o), rate, months, rateIsApr(o));
      if (!(gain > 0)) return null;
      return `${source === 'mine' && hideBalances ? HIDDEN : fmtFiat(gain, settings.currency, { sign: true })} ${t(PER[months])}`;
    },
    panel: { amount, setAmount, months, setMonths, source, setSource, amountOf },
  };
}

export function EarnCalculator({ calc, rates, onPick }: { calc: EarnCalc['panel']; rates: RateStore; onPick: (o: EarnOption) => void }) {
  const { settings, hideBalances } = useApp();
  const { t } = useT();
  const [wanted, setWanted] = useState<EarnRisk>('low');
  const cur = settings.currency;
  const { months, source } = calc;
  const hidden = source === 'mine' && hideBalances;
  const picks = bestByRisk(EARN_OPTIONS, (o) => rates[o.id]?.value ?? null, calc.amountOf, months);
  // A level with nothing to show gives way to the next one that has something.
  const level = picks[wanted] ? wanted : (RISKS.find((r) => picks[r]) ?? wanted);
  const pick = picks[level];
  const row = pick ? earnRowName(pick.option) : null;
  const points = pick ? gainCurve(pick.amount, pick.rate, months, rateIsApr(pick.option)) : [];
  const money = (v: number) => (hidden ? HIDDEN : fmtFiat(v, cur));
  const when = (i: number) => {
    const step = points[i]?.months ?? 0;
    if (step === 0) return t('earn.calcToday');
    if (months === 1) return t('earn.calcInDays', { n: Math.round(step * 30) });
    if (step === 12) return t('earn.calcInOneYear');
    return step % 12 === 0 ? t('earn.calcInYears', { n: step / 12 }) : t('earn.calcInMonths', { n: step });
  };
  return (
    <section aria-label={t('earn.calcTitle')} className="flex shrink-0 flex-col">
      <div className="relative h-[256px]">
        <div className="relative z-10 flex items-start justify-between gap-6">
          <div className="flex min-w-0 flex-col gap-3">
            <span className="text-[14px] font-medium text-mute">{t(GAIN[months])}</span>
            <div className="figure text-[clamp(52px,5vw,72px)] leading-[0.92] font-[500] tracking-[-0.055em]">
              {pick ? (
                <>
                  {!hidden && <span className="text-faint">+</span>}
                  <BigFiat value={pick.gain} currency={cur} hidden={hidden} />
                </>
              ) : (
                <span className="text-faint">—</span>
              )}
            </div>
            <div className="flex h-7 min-w-0 items-center gap-2 text-[14px] text-mute">
              {pick && row ? (
                <>
                  <button type="button" className="press truncate font-medium text-text2 underline decoration-line-3 underline-offset-4" title={t('earn.riskWhy')} onClick={() => onPick(pick.option)}>
                    {row.name}
                    {row.network ? ` · ${row.network}` : ''}
                  </button>
                  <span className="shrink-0 tabular-nums">· {fmtPct(pick.rate, { decimals: 2, sign: false })}</span>
                  <span className="truncate">· {t('earn.calcTotal', { amount: money(pick.amount + pick.gain) })}</span>
                </>
              ) : (
                <span>{source === 'mine' ? t('earn.calcNothing') : t('earn.calcNoRate')}</span>
              )}
            </div>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-3">
            <Segmented
              label={t('earn.calcPeriod')}
              value={months}
              onChange={calc.setMonths}
              options={[
                { value: 1, label: t('earn.calc1Month') },
                { value: 12, label: t('earn.calc1Year') },
                { value: 60, label: t('earn.calc5Years') },
              ]}
            />
            <div className="flex items-center gap-2">
              {source === 'amount' && (
                <span className="relative">
                  <Input className="h-[34px] w-[128px] pr-11 text-right tabular-nums" inputMode="decimal" aria-label={t('earn.calcAmountIn', { currency: cur })} value={calc.amount} onChange={(e) => calc.setAmount(sanitizeDecimalInput(e.target.value, 2))} />
                  <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-[12.5px] text-faint">{cur}</span>
                </span>
              )}
              <Segmented
                size="sm"
                label={t('earn.calcSource')}
                value={source}
                onChange={calc.setSource}
                options={[
                  { value: 'amount', label: t('earn.calcAmount') },
                  { value: 'mine', label: t('earn.calcMine') },
                ]}
              />
            </div>
          </div>
        </div>
        <div className="absolute right-0 bottom-0 left-0" style={{ height: CHART_H }}>
          {points.length > 1 && (
            <SmoothChart
              key={`${level}.${months}.${source}`}
              values={points.map((p) => p.value)}
              height={CHART_H}
              defaultPoint="last"
              padBottom={8}
              ariaLabel={t(GAIN[months])}
              renderTooltip={(i) => ({ label: when(i), value: money(points[i]?.value ?? 0) })}
            />
          )}
        </div>
      </div>
      <div className="grid grid-cols-3 border-t border-line" role="group" aria-label={t('earn.risk')}>
        {RISKS.map((risk, i) => {
          const p = picks[risk];
          const on = risk === level;
          return (
            <button key={risk} type="button" aria-pressed={on} disabled={!p} onClick={() => setWanted(risk)} className={cn('-mt-px flex min-w-0 flex-col gap-1 border-t py-3 text-left transition-colors duration-150', on ? 'border-ice' : 'border-transparent', i > 0 && 'pl-5', p && !on && 'cursor-pointer hover:border-line-3')}>
              <span className="flex items-center gap-2 text-[12.5px] text-mute">
                <span aria-hidden className={cn('size-1.5 rounded-full', DOT[risk])} />
                {t(LEVEL[risk])}
              </span>
              <span className={cn('text-[17px] font-medium tracking-[-0.02em] tabular-nums', on ? 'text-text' : 'text-text2', !p && 'text-faint')}>{p ? (hidden ? HIDDEN : fmtFiat(p.gain, cur, { sign: true })) : '—'}</span>
            </button>
          );
        })}
      </div>
      <p className="m-0 mt-1 text-[12px] leading-[1.5] text-faint">{t('earn.calcNote')}</p>
    </section>
  );
}
