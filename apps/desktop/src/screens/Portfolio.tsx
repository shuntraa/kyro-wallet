// SPDX-License-Identifier: GPL-3.0-or-later
import { useState } from 'react';
import { useApp } from '../state/app';
import { usePortfolio } from '../state/portfolio';
import { PERIODS, usePortfolioChart, type Period } from '../state/charts';
import { fmtChartTime, fmtFiat, fmtPct } from '../lib/format';
import { BigFiat, HIDDEN, TrendPill } from '../components/kit';
import { AllocationBar, SmoothChart } from '../components/charts';
import { AssetListsCard } from '../components/AssetLists';
import { VaultCard } from '../components/VaultCard';
import { Button, Segmented, Skeleton } from '../components/ui/primitives';
import { useTorBlocked } from '../components/Tor';
import { useOnTorReady } from '../state/tor';
import { idx, useMedia } from '../components/motion';
import { IconDown, IconEye, IconEyeOff, IconSwap, IconUp } from '../components/icons';
import { useT } from '../i18n';

export function Portfolio() {
  const { settings, hideBalances, setHideBalances, navigate, network } = useApp();
  const pf = usePortfolio();
  const { t, tp } = useT();
  const [period, setPeriod] = useState<Period>('1J');
  const chart = usePortfolioChart(period);
  useOnTorReady(chart.reload);
  const torBlocked = useTorBlocked(chart.error);
  const cur = settings.currency;
  const series = chart.data ?? [];
  const values = series.map((p) => p[1]);
  const first = values[0];
  const periodDelta = first !== undefined && values.length > 1 ? pf.total - first : null;
  const delta = period === '1J' ? pf.change24hFiat : periodDelta;
  const deltaPct = period === '1J' ? pf.change24hPct : first ? ((pf.total - first) / first) * 100 : null;
  // At the 720 px minimum height the hero gives room back to the asset list.
  const tall = useMedia('(min-height: 820px)');
  const chartH = tall ? 170 : 120;
  const periodLabel = t(`portfolio.periodLabel${period}`);

  const alloc = pf.holdings.filter((h) => (h.value ?? 0) > 0);
  const top = alloc.slice(0, 5);
  const rest = alloc.slice(5).reduce((s, h) => s + (h.value ?? 0), 0);
  const slices = [...top.map((h) => ({ id: h.asset.id, label: top.filter((x) => x.asset.name === h.asset.name).length > 1 ? `${h.asset.name} · ${h.asset.kind === 'spl' ? 'Solana' : h.asset.kind === 'erc20' ? 'ERC-20' : h.asset.kind === 'trc20' ? 'TRC-20' : h.asset.symbol}` : h.asset.name, value: h.value ?? 0, color: h.asset.color })), ...(rest > 0 ? [{ id: 'other', label: t('portfolio.others'), value: rest, color: '#5E6470' }] : [])];

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 px-7 pt-6 pb-5">
      {/* The balance sits on the page, not in a box: figure, then the curve on a ruled baseline. */}
      <section aria-label={t('portfolio.valueAria')} className={`relative flex shrink-0 flex-col border-b border-line ${tall ? 'h-[300px]' : 'h-[250px]'}`}>
        <div className="relative z-10 flex items-start justify-between gap-6">
          <div className="flex min-w-0 flex-col gap-3">
            <div className="flex items-center gap-2">
              <span className="eyebrow">{t('portfolio.totalValue')}</span>
              <button type="button" aria-label={hideBalances ? t('portfolio.showBalances') : t('portfolio.hideBalances')} onClick={() => setHideBalances(!hideBalances)} className="press flex size-[24px] items-center justify-center rounded-[5px] text-faint hover:bg-raised hover:text-text">
                {hideBalances ? <IconEyeOff size={14} /> : <IconEye size={14} />}
              </button>
              {network === 'testnet' && <span className="text-[11px] text-faint">{t('portfolio.testnetPrices')}</span>}
            </div>
            <div className="figure text-[clamp(56px,5.4vw,76px)] leading-[0.92] tracking-[-0.05em]">
              {pf.balancesLoaded && pf.markets ? <BigFiat value={pf.total} currency={cur} hidden={hideBalances} tick className="fade-in inline-block" /> : <Skeleton className="h-[64px] w-[340px]" />}
            </div>
            <div className="flex h-6 items-center gap-2.5 text-[13px]">
              {delta !== null && pf.total > 0 ? (
                <span key={period} className="fade-in flex items-center gap-2.5">
                  <TrendPill change={delta}>
                    {hideBalances ? HIDDEN : fmtFiat(Math.abs(delta), cur)} · {fmtPct(deltaPct === null ? null : Math.abs(deltaPct), { sign: false })}
                  </TrendPill>
                  <span className="text-mute">{periodLabel}</span>
                </span>
              ) : (
                <span className="text-mute">{pf.balancesLoaded ? (pf.total === 0 ? t('portfolio.noFundsYet') : '') : t('portfolio.loadingBalances')}</span>
              )}
            </div>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-4">
            <Segmented label={t('portfolio.period')} value={period} onChange={setPeriod} options={PERIODS.map((p) => ({ value: p, label: t(`portfolio.period${p}`) }))} />
            <div className="flex gap-2">
              <Button variant="primary" size="lg" onClick={() => navigate({ name: 'send' })}>
                <IconUp size={16} /> {t('common.send')}
              </Button>
              <Button size="lg" onClick={() => navigate({ name: 'receive' })}>
                <IconDown size={16} /> {t('common.receive')}
              </Button>
              <Button size="lg" onClick={() => navigate({ name: 'swap' })}>
                <IconSwap size={16} sw={2.2} /> Swap
              </Button>
            </div>
          </div>
        </div>
        <div className="absolute right-0 bottom-0 left-0" style={{ height: chartH }}>
          {values.length > 1 ? (
            <SmoothChart
              key={period}
              values={values}
              height={chartH}
              defaultPoint="last"
              padBottom={10}
              ariaLabel={t('portfolio.chartAria', { period: periodLabel })}
              renderTooltip={(i) => ({ label: fmtChartTime(series[i]?.[0] ?? Date.now()), value: hideBalances ? HIDDEN : fmtFiat(values[i] ?? 0, cur) })}
            />
          ) : (
            <div className="flex h-full items-end">
              <svg width="100%" height="60" viewBox="0 0 1000 60" preserveAspectRatio="none" aria-hidden="true">
                <path d="M0,40 L1000,40" stroke="#22252B" strokeWidth="1.5" strokeDasharray="3 6" vectorEffect="non-scaling-stroke" />
              </svg>
              <span className="absolute bottom-14 left-0 text-[12px] text-faint">{chart.loading ? t('portfolio.loadingChart') : chart.error ? (torBlocked ? t('shell.waitingTor') : t('portfolio.chartUnavailable', { error: chart.error.message })) : t('portfolio.chartLater')}</span>
            </div>
          )}
        </div>
      </section>

      <div className="flex min-h-0 flex-1 gap-5">
        <AssetListsCard className="rise flex-1" />
        {/* One column, two ruled sections: allocation, then the vault. */}
        <div className="rise flex w-[340px] shrink-0 flex-col overflow-y-auto rounded-panel border border-line bg-card scroll-thin" style={idx(1)}>
          <section aria-label={t('portfolio.allocation')} className="flex flex-col gap-3.5 border-b border-line px-5 pt-4 pb-[18px]">
            <div className="flex items-baseline justify-between">
              <span className="eyebrow">{t('portfolio.allocation')}</span>
              <span className="font-mono text-[11px] text-mute">
                {tp('portfolio.assetCount', alloc.length)}
              </span>
            </div>
            <AllocationBar slices={slices} />
            <div className="grid grid-cols-2 gap-x-5 gap-y-[7px] text-[13px]">
              {slices.length === 0 && <span className="col-span-2 text-mute">{t('portfolio.allocationLater')}</span>}
              {slices.map((s) => (
                <span key={s.id} className="flex min-w-0 items-center gap-2">
                  <span className="size-[7px] shrink-0 rounded-[1.5px]" style={{ background: s.color }} />
                  <span className="min-w-0 flex-1 truncate text-text2">{s.label}</span>
                  <span className="font-mono text-[12px] text-text">
                    {fmtPct(pf.total ? (s.value / pf.total) * 100 : 0, { sign: false, decimals: 0 })}
                  </span>
                </span>
              ))}
            </div>
          </section>
          <VaultCard />
        </div>
      </div>
    </div>
  );
}
