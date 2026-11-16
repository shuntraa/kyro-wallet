// SPDX-License-Identifier: GPL-3.0-or-later
// Top of the Earn screen, built like the Portfolio's: one large figure and its curve. It shows what
// an amount, or what the wallet holds, would earn at today's rates, one risk level at a time.

import { useMemo, useState } from 'react';
import { assetsFor, unitsToNumber } from '@kyro/chains';
import { useApp } from '../state/app';
import { usePortfolio } from '../state/portfolio';
import { earnRowName, EARN_OPTIONS, rewardsWaitForClaim, type EarnOption, type EarnRisk, type RateStore } from '../lib/earn';
import { bestByRisk, earnAsset, gainCurve, projectedGain, type CalcMonths } from '../lib/earnCalc';
import { cn } from '../lib/cn';
import { fmtFiat, fmtPct, sanitizeDecimalInput } from '../lib/format';
import { readJson, writeJson } from '../lib/storage';
import { useT } from '../i18n';
import { SmoothChart } from './charts';
import { HIDDEN } from './kit';
import { BIG, GLASS_ROW, LABEL, Segmented, THIN } from './kyro';
import { SplitFiat } from './kyroParts';

const RISKS: EarnRisk[] = ['low', 'medium', 'high'];
const DOT = { low: 'bg-up shadow-[0_0_8px_#3ddc97]', medium: 'bg-warn shadow-[0_0_8px_#f5b544]', high: 'bg-down shadow-[0_0_8px_#ff6b6b]' } as const;
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
      const gain = projectedGain(amountOf(o), rate, months, rewardsWaitForClaim(o));
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
  const points = pick ? gainCurve(pick.amount, pick.rate, months, rewardsWaitForClaim(pick.option)) : [];
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
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 pb-3">
        <span className={LABEL}>{t('earn.calcTitle')}</span>
        <span className="ml-auto flex flex-wrap items-center gap-3">
          {source === 'amount' && (
            <label className={cn('flex h-9 w-[150px] items-center gap-2 rounded-[12px] px-3 transition-shadow focus-within:ring-ice/40', GLASS_ROW)}>
              <span className="sr-only">{t('earn.calcAmountIn', { currency: cur })}</span>
              <input className="figure min-w-0 flex-1 bg-transparent text-right text-[13px] text-text" inputMode="decimal" value={calc.amount} onChange={(e) => calc.setAmount(sanitizeDecimalInput(e.target.value, 2))} />
              <span className="text-[12px] text-faint">{cur}</span>
            </label>
          )}
          <Segmented
            label={t('earn.calcSource')}
            value={source}
            onChange={calc.setSource}
            items={[
              { id: 'amount', label: t('earn.calcAmount') },
              { id: 'mine', label: t('earn.calcMine') },
            ]}
          />
          <Segmented
            label={t('earn.calcPeriod')}
            value={String(months) as `${CalcMonths}`}
            onChange={(v) => calc.setMonths(Number(v) as CalcMonths)}
            items={[
              { id: '1', label: t('earn.calc1Month') },
              { id: '12', label: t('earn.calc1Year') },
              { id: '60', label: t('earn.calc5Years') },
            ]}
          />
        </span>
      </div>
      <div className={cn('flex flex-col rounded-[20px] px-6 pt-5', GLASS_ROW)}>
        <div className="relative h-[220px]">
          <div className="relative z-10 flex min-w-0 flex-col gap-2.5">
            <span className="text-[12.5px] text-mute">{t(GAIN[months])}</span>
            <div className="text-[44px] leading-none" style={pick && !hidden ? { ...THIN, ...BIG('#8fe3b8') } : THIN}>
              {pick ? (
                hidden ? (
                  HIDDEN
                ) : (
                  <>
                    +<SplitFiat value={pick.gain} currency={cur} restClass="text-[22px]" />
                  </>
                )
              ) : (
                <span className="text-faint">—</span>
              )}
            </div>
            <div className="flex h-6 min-w-0 items-center gap-2 text-[13px] text-mute">
              {pick && row ? (
                <>
                  <button type="button" className="press truncate font-medium text-text2 underline decoration-white/20 underline-offset-4" title={t('earn.riskWhy')} onClick={() => onPick(pick.option)}>
                    {row.name}
                    {row.network ? ` · ${row.network}` : ''}
                  </button>
                  <span className="figure shrink-0">· {fmtPct(pick.rate, { decimals: 2, sign: false })}</span>
                  <span className="figure truncate">· {t('earn.calcTotal', { amount: money(pick.amount + pick.gain) })}</span>
                </>
              ) : (
                <span>{source === 'mine' ? t('earn.calcNothing') : t('earn.calcNoRate')}</span>
              )}
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
                stroke="#8fe3b8"
                glow
                ariaLabel={t(GAIN[months])}
                renderTooltip={(i) => ({ label: when(i), value: money(points[i]?.value ?? 0) })}
              />
            )}
          </div>
        </div>
        <div className="grid grid-cols-3 border-t border-white/[.06]" role="group" aria-label={t('earn.risk')}>
          {RISKS.map((risk, i) => {
            const p = picks[risk];
            const on = risk === level;
            return (
              <button key={risk} type="button" aria-pressed={on} disabled={!p} onClick={() => setWanted(risk)} className={cn('-mt-px flex min-w-0 flex-col gap-1 border-t py-3.5 text-left transition-colors duration-150', on ? 'border-ice' : 'border-transparent', i > 0 && 'pl-5', p && !on && 'cursor-pointer hover:border-white/20')}>
                <span className="flex items-center gap-2 text-[12px] text-mute">
                  <span aria-hidden className={cn('size-[5px]', DOT[risk])} />
                  {t(LEVEL[risk])}
                </span>
                <span className={cn('figure text-[17px] leading-tight', on ? 'text-text' : 'text-text2', !p && 'text-faint')} style={THIN}>
                  {p ? (hidden ? HIDDEN : fmtFiat(p.gain, cur, { sign: true })) : '—'}
                </span>
              </button>
            );
          })}
        </div>
      </div>
      <p className="m-0 mt-3 px-1 text-[12px] leading-[1.5] text-faint">{t('earn.calcNote')}</p>
    </section>
  );
}
