// SPDX-License-Identifier: GPL-3.0-or-later
import { useMemo, useState } from 'react';
import { useApp } from '../state/app';
import { usePortfolio } from '../state/portfolio';
import { PERIODS, usePortfolioChart, type Period } from '../state/charts';
import { cn } from '../lib/cn';
import { hiddenAsSmall } from '../lib/hideSmall';
import { fmtChartTime, fmtCrypto, fmtFiat, fmtPct } from '../lib/format';
import { CoinIcon, HIDDEN, trendColor } from '../components/kit';
import { AllocationBar, SmoothChart } from '../components/charts';
import { AssetListsCard } from '../components/AssetLists';
import { GainsCard } from '../components/Gains';
import { useGains } from '../state/gains';
import { VaultCard } from '../components/VaultCard';
import { useBtcLocks } from './BtcLocks';
import { Annotated, Frost, GLOW, Glass, GlassButton, IceSquare, LABEL, Segmented, Side, THIN, midAngle, type Note, type Seg } from '../components/kyro';
import { SplitFiat, coinTint, useWidth } from '../components/kyroParts';
import { useOnTorReady } from '../state/tor';
import { idx } from '../components/motion';
import { IconDown, IconSwap, IconUp } from '../components/icons';
import { useT } from '../i18n';

const OTHER = '#8a93a0';

export function Portfolio() {
  const { settings, hideBalances, navigate, network, activeWatch } = useApp();
  const pf = usePortfolio();
  const { t, tp } = useT();
  const [period, setPeriod] = useState<Period>('1A');
  const chart = usePortfolioChart(period);
  useOnTorReady(chart.reload);
  const locks = useBtcLocks();
  const gains = useGains();
  const [stageRef, stageW] = useWidth<HTMLDivElement>();
  const cur = settings.currency;
  const series = chart.data ?? [];
  const values = useMemo(() => series.map((p) => p[1]), [series]);
  const times = useMemo(() => series.map((p) => p[0]), [series]);
  const first = values[0];
  const periodDelta = first !== undefined && values.length > 1 ? pf.total - first : null;
  const delta = period === '1J' ? pf.change24hFiat : periodDelta;
  const deltaPct = period === '1J' ? pf.change24hPct : first ? ((pf.total - first) / first) * 100 : null;
  const periodLabel = t(`portfolio.periodLabel${period}`);
  const lockedSats = locks.status?.lockedSats ?? 0;

  const alloc = pf.holdings.filter((h) => (h.value ?? 0) > 0 && !hiddenAsSmall(h, settings.hideSmall));
  const top = alloc.slice(0, 5);
  const restRows = alloc.slice(5);
  const rest = restRows.reduce((s, h) => s + (h.value ?? 0), 0);
  const labelOf = (h: (typeof top)[number]) => (top.filter((x) => x.asset.name === h.asset.name).length > 1 ? `${h.asset.name} · ${h.asset.kind === 'spl' ? 'Solana' : h.asset.kind === 'erc20' ? 'ERC-20' : h.asset.kind === 'trc20' ? 'TRC-20' : h.asset.symbol}` : h.asset.name);
  const slices = [...top.map((h) => ({ id: h.asset.id, label: labelOf(h), value: h.value ?? 0, color: h.asset.color })), ...(rest > 0 ? [{ id: 'other', label: t('portfolio.others'), value: rest, color: '#5E6470' }] : [])];
  const share = (v: number) => fmtPct(pf.total ? (v / pf.total) * 100 : 0, { sign: false, decimals: 0 });

  // The ring: the largest five holdings, then the others together; an empty ring before any funds.
  const segs: Seg[] = slices.length ? slices.map((s) => ({ color: s.id === 'other' ? OTHER : s.color, part: s.value, mute: s.id === 'other' })) : [{ color: '#9fb4c8', part: 1, mute: true }];
  const notes: Note[] = slices.map((s, i) => {
    const a = ((midAngle(segs, i) % 360) + 360) % 360;
    const side: 'L' | 'R' = a > 180 && a < 330 ? 'L' : 'R';
    const h = top.find((x) => x.asset.id === s.id);
    const c = coinTint(s.id === 'other' ? OTHER : s.color);
    return {
      seg: i,
      side,
      dot: c,
      node: (
        <button type="button" onClick={() => (h ? navigate({ name: 'asset', id: h.asset.id }) : navigate({ name: 'assets' }))} className="press text-left">
          <Side side={side} icon={h ? <CoinIcon asset={h.asset} size={30} /> : <span className="grid size-[30px] place-items-center"><span className="size-[9px] rounded-[2px]" style={{ background: c }} /></span>}>
            <span className="text-[13.5px] font-semibold">
              {s.label} <span className="figure ml-1 font-normal text-faint">{share(s.value)}</span>
            </span>
            <span className="figure text-[12.5px] text-mute">
              {h ? (
                <>
                  <span style={hideBalances ? undefined : GLOW(c)}>{hideBalances ? HIDDEN : fmtCrypto(h.amount, h.asset.decimals, h.asset.symbol)}</span> · {hideBalances ? HIDDEN : fmtFiat(s.value, cur)} <span className={cn('ml-1', trendColor(h.change24h))}>{fmtPct(h.change24h)}</span>
                </>
              ) : (
                <>
                  {tp('portfolio.assetCount', restRows.length)} · {hideBalances ? HIDDEN : fmtFiat(s.value, cur)}
                </>
              )}
            </span>
          </Side>
        </button>
      ),
    };
  });

  const W = Math.min(1200, Math.max(stageW, 0));
  const ring = W >= 1000 ? 250 : 220;

  // An empty wallet has no curve to show: the asset lists move up into its place (no empty band).
  const noChart = pf.balancesLoaded && pf.total === 0 && !values.some((v) => v > 0);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto scroll-thin">
      <section aria-label={t('portfolio.valueAria')} className={cn('flex flex-col', !noChart && 'min-h-full')}>
        <div ref={stageRef} className="mt-4 w-full">
          {W > 0 && (
            <Annotated W={W} H={300} size={ring} segs={segs} notes={W >= 960 ? notes : []}>
              <IceSquare size={ring * 0.2} />
            </Annotated>
          )}
        </div>

        <div className="mt-3 flex flex-col items-center px-8">
          {/* Last known total (or 0) right away, updated in place: the first load over Tor stays invisible. */}
          <SplitFiat value={pf.total} currency={cur} hidden={hideBalances} tick className="fade-in text-[52px] leading-none" style={{ ...THIN, textShadow: '0 0 36px rgba(124,196,255,.38), 0 0 2px rgba(124,196,255,.3)' }} />
          <span className="mt-3 flex min-h-5 flex-wrap items-center justify-center gap-x-2.5 gap-y-1 text-[13px]">
            {pf.total > 0 && pf.change24hPct !== null ? (
              <>
                <span className={cn('figure font-medium', trendColor(pf.change24hFiat))}>
                  {pf.change24hFiat >= 0 ? '+' : '−'}
                  {hideBalances ? HIDDEN : fmtFiat(Math.abs(pf.change24hFiat), cur)} · {fmtPct(pf.change24hPct)}
                </span>
                <span className="text-faint">{t('portfolio.periodLabel1J')}</span>
              </>
            ) : (
              <span className="text-faint">{pf.balancesLoaded && pf.total === 0 ? t('portfolio.noFundsYet') : ''}</span>
            )}
            {lockedSats > 0 && (
              <>
                <span className="text-faint">·</span>
                <button type="button" aria-label={t('lock.lineAria')} onClick={() => navigate({ name: 'btcLocks' })} className="press flex items-center gap-1.5 text-faint hover:text-text2">
                  <span className="size-[5px] bg-ice shadow-[0_0_8px_#7cc4ff]" />
                  <span className="figure">{t('portfolio.lockedBtc', { amount: hideBalances ? HIDDEN : fmtCrypto(BigInt(lockedSats), 8, 'BTC') })}</span>
                </button>
              </>
            )}
            {network === 'testnet' && (
              <>
                <span className="text-faint">·</span>
                <span className="text-faint">{t('portfolio.testnetPrices')}</span>
              </>
            )}
          </span>
          <div className="mt-5 flex gap-2.5">
            <Frost className="h-11 w-[156px] rounded-[14px] text-[14px]" disabled={!!activeWatch} title={activeWatch ? t('watch.noSign') : undefined} onClick={() => navigate({ name: 'send' })}>
              <IconUp size={17} sw={2.2} /> {t('common.send')}
            </Frost>
            <GlassButton className="w-[156px] text-[14px]" onClick={() => navigate({ name: 'receive' })}>
              <IconDown size={17} sw={2.2} /> {t('common.receive')}
            </GlassButton>
            <GlassButton className="w-[156px] text-[14px]" disabled={!!activeWatch} title={activeWatch ? t('watch.noSign') : undefined} onClick={() => navigate({ name: 'swap' })}>
              <IconSwap size={17} sw={2.1} /> {t('shell.swap')}
            </GlassButton>
          </div>
        </div>

        {!noChart && (
          <section className="mx-8 mt-auto flex flex-col pt-6 pb-2">
            <div className="flex flex-wrap items-center gap-3">
              <span className={LABEL}>{t('portfolio.evolution')}</span>
              {delta !== null && pf.total > 0 && (
                <span key={period} className="fade-in figure text-[12.5px] text-mute">
                  <span title={hideBalances ? undefined : `${delta >= 0 ? '+' : '−'}${fmtFiat(Math.abs(delta), cur)}`}>{fmtPct(deltaPct)}</span> {periodLabel}
                </span>
              )}
              <span className="ml-auto">
                <Segmented label={t('portfolio.period')} value={period} onChange={setPeriod} items={PERIODS.map((p) => ({ id: p, label: t(`portfolio.period${p}`) }))} />
              </span>
            </div>
            <div className="mt-1 h-[170px]">
              {values.length > 1 ? (
                <SmoothChart
                  key={period}
                  values={values}
                  times={times}
                  height={170}
                  stroke="#8fcaff"
                  glow
                  defaultPoint="none"
                  padTop={36}
                  padBottom={4}
                  ariaLabel={t('portfolio.chartAria', { period: periodLabel })}
                  renderTooltip={(i) => ({ label: fmtChartTime(series[i]?.[0] ?? Date.now(), Date.now(), (series[series.length - 1]?.[0] ?? 0) - (series[0]?.[0] ?? 0)), value: hideBalances ? HIDDEN : fmtFiat(values[i] ?? 0, cur) })}
                />
              ) : null}
            </div>
          </section>
        )}
      </section>

      <div className={cn('mx-8 mb-10 flex gap-6 max-[1180px]:flex-col', noChart ? 'mt-10' : 'mt-6')}>
        <AssetListsCard className="rise min-w-0 flex-1" />
        <div className="rise flex w-[340px] shrink-0 flex-col gap-4 pt-[52px] max-[1180px]:w-full max-[1180px]:pt-0" style={idx(1)}>
          <Glass className="rounded-[20px]">
            <section aria-label={t('portfolio.allocation')} className="flex flex-col gap-4 px-6 pt-5 pb-6">
              <div className="flex items-baseline justify-between">
                <span className={LABEL}>{t('portfolio.allocation')}</span>
                <span className="figure text-[12px] text-faint">{tp('portfolio.assetCount', alloc.length)}</span>
              </div>
              <AllocationBar slices={slices} />
              <div className="grid grid-cols-2 gap-x-5 gap-y-2.5 text-[13px]">
                {slices.length === 0 && <span className="col-span-2 text-mute">{t('portfolio.allocationLater')}</span>}
                {slices.map((s) => (
                  <span key={s.id} className="flex min-w-0 items-center gap-2">
                    <span className="size-[7px] shrink-0" style={{ background: s.color, boxShadow: `0 0 8px ${s.color}88` }} />
                    <span className="min-w-0 flex-1 truncate text-text2">{s.label}</span>
                    <span className="figure text-[12.5px] font-medium text-text">{share(s.value)}</span>
                  </span>
                ))}
              </div>
            </section>
          </Glass>
          {gains.rows.length > 0 && (
            <Glass className="rounded-[20px] [&>section]:border-b-0">
              <GainsCard />
            </Glass>
          )}
          <Glass className="flex rounded-[20px]">
            <VaultCard />
          </Glass>
        </div>
      </div>
    </div>
  );
}
