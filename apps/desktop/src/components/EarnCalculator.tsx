// SPDX-License-Identifier: GPL-3.0-or-later
// Top of the Earn screen: what an amount, or what the wallet holds, would earn at today's rates.

import { useMemo, useState } from 'react';
import { assetsFor, unitsToNumber } from '@kyro/chains';
import { useApp } from '../state/app';
import { usePortfolio } from '../state/portfolio';
import { earnRowName, EARN_OPTIONS, rateIsApr, type EarnOption, type EarnRisk, type RateStore } from '../lib/earn';
import { bestByRisk, earnAsset, projectedGain, type CalcMonths } from '../lib/earnCalc';
import { cn } from '../lib/cn';
import { fmtFiat, fmtPct, sanitizeDecimalInput } from '../lib/format';
import { readJson, writeJson } from '../lib/storage';
import { useT } from '../i18n';
import { HIDDEN } from './kit';
import { Badge, Input, Segmented } from './ui/primitives';

const RISKS: EarnRisk[] = ['low', 'medium', 'high'];
const TONE = { low: 'up', medium: 'warn', high: 'down' } as const;
const LABEL = { low: 'earn.riskLow', medium: 'earn.riskMedium', high: 'earn.riskHigh' } as const;
const PER = { 1: 'earn.calcPerMonth', 12: 'earn.calcPerYear', 60: 'earn.calcPer5Years' } as const;

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
  const cur = settings.currency;
  const picks = bestByRisk(EARN_OPTIONS, (o) => rates[o.id]?.value ?? null, calc.amountOf, calc.months);
  const top = Math.max(...RISKS.map((r) => picks[r]?.gain ?? 0));
  const money = (v: number, sign = false) => (calc.source === 'mine' && hideBalances ? HIDDEN : fmtFiat(v, cur, { sign }));
  return (
    <section aria-label={t('earn.calcTitle')} className="flex flex-col gap-4 rounded-panel border border-line bg-card px-5 py-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5">
        <h2 className="m-0 text-[15px] font-semibold tracking-[-0.01em]">{t('earn.calcTitle')}</h2>
        <span className="flex-1" />
        <Segmented
          size="sm"
          label={t('earn.calcSource')}
          value={calc.source}
          onChange={calc.setSource}
          options={[
            { value: 'amount', label: t('earn.calcAmount') },
            { value: 'mine', label: t('earn.calcMine') },
          ]}
        />
        {calc.source === 'amount' && (
          <label className="flex items-center gap-2 text-[13px] text-mute">
            <Input className="h-9 w-[110px] text-right" inputMode="decimal" aria-label={t('earn.calcAmountIn', { currency: cur })} value={calc.amount} onChange={(e) => calc.setAmount(sanitizeDecimalInput(e.target.value, 2))} />
            {cur}
          </label>
        )}
        <Segmented
          size="sm"
          label={t('earn.calcPeriod')}
          value={calc.months}
          onChange={calc.setMonths}
          options={[
            { value: 1, label: t('earn.calc1Month') },
            { value: 12, label: t('earn.calc1Year') },
            { value: 60, label: t('earn.calc5Years') },
          ]}
        />
      </div>
      <div className="grid grid-cols-3 gap-3">
        {RISKS.map((risk) => {
          const pick = picks[risk];
          const row = pick ? earnRowName(pick.option) : null;
          return (
            <button key={risk} type="button" disabled={!pick} onClick={() => pick && onPick(pick.option)} className={cn('flex min-w-0 flex-col gap-1.5 rounded-box border border-line bg-raised/40 px-4 py-3 text-left', pick && 'cursor-pointer hover:bg-raised/70')}>
              <span className="flex items-center justify-between gap-2">
                <Badge tone={TONE[risk]}>{t(LABEL[risk])}</Badge>
                {pick && <span className="text-[12px] text-mute tabular-nums">{fmtPct(pick.rate, { decimals: 2, sign: false })}</span>}
              </span>
              {pick && row ? (
                <>
                  <span className="truncate text-[12.5px] text-text2">
                    {row.name}
                    {row.network ? ` · ${row.network}` : ''}
                  </span>
                  <span className="text-[22px] leading-tight font-semibold tracking-[-0.02em] text-up tabular-nums">{money(pick.gain, true)}</span>
                  <span className="h-1 overflow-hidden rounded-full bg-black/30">
                    <span className="block h-full rounded-full bg-up/70" style={{ width: `${top > 0 ? Math.max(4, (pick.gain / top) * 100) : 0}%` }} />
                  </span>
                  <span className="truncate text-[12px] text-mute">{t('earn.calcTotal', { amount: money(pick.amount + pick.gain) })}</span>
                </>
              ) : (
                <span className="py-2 text-[12.5px] text-mute">{calc.source === 'mine' ? t('earn.calcNothing') : t('earn.calcNoRate')}</span>
              )}
            </button>
          );
        })}
      </div>
      <p className="m-0 text-[12px] leading-[1.5] text-mute">{t('earn.calcNote')}</p>
    </section>
  );
}
