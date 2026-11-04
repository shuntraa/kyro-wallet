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
import { Button, Segmented } from '../components/ui/primitives';
import { useOnTorReady } from '../state/tor';
import { idx, useMedia } from '../components/motion';
import { IconDown, IconEye, IconEyeOff, IconSwap, IconUp } from '../components/icons';
import { useT } from '../i18n';

export function Portfolio() {
  const { settings, hideBalances, setHideBalances, navigate, network, activeWatch } = useApp();
  const pf = usePortfolio();
  const { t, tp } = useT();
  const [period, setPeriod] = useState<Period>('1J');
  const chart = usePortfolioChart(period);
  useOnTorReady(chart.reload);
  const cur = settings.currency;
  const series = chart.data ?? [];
  const values = series.map((p) => p[1]);
  const first = values[0];
  const periodDelta = first !== undefined && values.length > 1 ? pf.total - first : null;
  const delta = period === '1J' ? pf.change24hFiat : periodDelta;
  const deltaPct = period === '1J' ? pf.change24hPct : first ? ((pf.total - first) / first) * 100 : null;
  const tall = useMedia('(min-height: 820px)');
  const chartH = tall ? 170 : 120;
  const periodLabel = t(`portfolio.periodLabel${period}`);

  const alloc = pf.holdings.filter((h) => (h.value ?? 0) > 0);
  const top = alloc.slice(0, 5);
  const rest = alloc.slice(5).reduce((s, h) => s + (h.value ?? 0), 0);
  const slices = [...top.map((h) => ({ id: h.asset.id, label: top.filter((x) => x.asset.name === h.asset.name).length > 1 ? `${h.asset.name} · ${h.asset.kind === 'spl' ? 'Solana' : h.asset.kind === 'erc20' ? 'ERC-20' : h.asset.kind === 'trc20' ? 'TRC-20' : h.asset.symbol}` : h.asset.name, value: h.value ?? 0, color: h.asset.color })), ...(rest > 0 ? [{ id: 'other', label: t('portfolio.others'), value: rest, color: '#5E6470' }] : [])];

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 px-8 pt-7 pb-6">
      <section aria-label={t('portfolio.valueAria')} className={`relative flex shrink-0 flex-col ${tall ? 'h-[300px]' : 'h-[250px]'}`}>
        <div className="relative z-10 flex items-start justify-between gap-6">
          <div className="flex min-w-0 flex-col gap-3">
            <div className="flex items-center gap-2">
              <span className="text-[14px] font-medium text-mute">{t('portfolio.totalValue')}</span>
              <button type="button" aria-label={hideBalances ? t('portfolio.showBalances') : t('portfolio.hideBalances')} onClick={() => setHideBalances(!hideBalances)} className="press flex size-8 items-center justify-center rounded-full text-mute hover:bg-white/[.06] hover:text-text">
                {hideBalances ? <IconEyeOff size={17} /> : <IconEye size={17} />}
              </button>
              {network === 'testnet' && <span className="text-[12px] text-faint">{t('portfolio.testnetPrices')}</span>}
            </div>
            <div className="figure text-[clamp(60px,5.8vw,84px)] leading-[0.92] font-[500] tracking-[-0.055em]">
              {/* Last known total (or 0) right away, updated in place: the first load over Tor stays invisible. */}
              <BigFiat value={pf.total} currency={cur} hidden={hideBalances} tick className="fade-in inline-block" />
            </div>
            <div className="flex h-7 items-center gap-2.5 text-[14px]">
              {delta !== null && pf.total > 0 ? (
                <span key={period} className="fade-in flex items-center gap-2.5">
                  <TrendPill change={delta}>
                    {hideBalances ? HIDDEN : fmtFiat(Math.abs(delta), cur)} · {fmtPct(deltaPct === null ? null : Math.abs(deltaPct), { sign: false })}
                  </TrendPill>
                  <span className="text-mute">{periodLabel}</span>
                </span>
              ) : (
                <span className="text-mute">{pf.balancesLoaded && pf.total === 0 ? t('portfolio.noFundsYet') : ''}</span>
              )}
            </div>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-5">
            <Segmented label={t('portfolio.period')} value={period} onChange={setPeriod} options={PERIODS.map((p) => ({ value: p, label: t(`portfolio.period${p}`) }))} />
            <div className="flex gap-2">
              <Button variant="primary" size="xl" pill disabled={!!activeWatch} title={activeWatch ? t('watch.noSign') : undefined} onClick={() => navigate({ name: 'send' })}>
                <IconUp size={18} /> {t('common.send')}
              </Button>
              <Button size="xl" pill onClick={() => navigate({ name: 'receive' })}>
                <IconDown size={18} /> {t('common.receive')}
              </Button>
              <Button size="xl" pill disabled={!!activeWatch} title={activeWatch ? t('watch.noSign') : undefined} onClick={() => navigate({ name: 'swap' })}>
                <IconSwap size={18} sw={2.1} /> Swap
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
              renderTooltip={(i) => ({ label: fmtChartTime(series[i]?.[0] ?? Date.now(), Date.now(), (series[series.length - 1]?.[0] ?? 0) - (series[0]?.[0] ?? 0)), value: hideBalances ? HIDDEN : fmtFiat(values[i] ?? 0, cur) })}
            />
          ) : null}
        </div>
      </section>

      <div className="flex min-h-0 flex-1 gap-6">
        <AssetListsCard className="rise flex-1" />
        <div className="rise flex w-[340px] shrink-0 flex-col overflow-y-auto rounded-panel border border-line bg-card scroll-thin" style={idx(1)}>
          <section aria-label={t('portfolio.allocation')} className="flex flex-col gap-4 border-b border-line px-6 pt-5 pb-6">
            <div className="flex items-baseline justify-between">
              <span className="text-[15px] font-medium tracking-[-0.01em]">{t('portfolio.allocation')}</span>
              <span className="text-[13px] text-mute">
                {tp('portfolio.assetCount', alloc.length)}
              </span>
            </div>
            <AllocationBar slices={slices} />
            <div className="grid grid-cols-2 gap-x-5 gap-y-2.5 text-[13.5px]">
              {slices.length === 0 && <span className="col-span-2 text-mute">{t('portfolio.allocationLater')}</span>}
              {slices.map((s) => (
                <span key={s.id} className="flex min-w-0 items-center gap-2">
                  <span className="size-2 shrink-0 rounded-full" style={{ background: s.color }} />
                  <span className="min-w-0 flex-1 truncate text-text2">{s.label}</span>
                  <span className="text-[13px] font-medium text-text">
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
