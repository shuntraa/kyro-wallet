// SPDX-License-Identifier: GPL-3.0-or-later
import { useState } from 'react';
import { useApp } from '../state/app';
import { usePortfolio } from '../state/portfolio';
import { PERIODS, usePortfolioChart, type Period } from '../state/charts';
import { fmtChartTime, fmtFiat, fmtNumber, fmtPct } from '../lib/format';
import { BigFiat, HIDDEN, TrendPill } from '../components/kit';
import { AllocationRing, SmoothChart } from '../components/charts';
import { AssetListsCard } from '../components/AssetLists';
import { VaultCard } from '../components/VaultCard';
import { Button, Segmented, Skeleton } from '../components/ui/primitives';
import { useTorBlocked } from '../components/Tor';
import { useOnTorReady } from '../state/tor';
import { IconDown, IconEye, IconEyeOff, IconSwap, IconUp } from '../components/icons';

export function Portfolio() {
  const { settings, hideBalances, setHideBalances, navigate, network } = useApp();
  const pf = usePortfolio();
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
  const periodLabel = { '1J': 'aujourd’hui', '1S': 'sur 7 jours', '1M': 'sur 30 jours', '1A': 'sur un an', Tout: 'depuis le début' }[period];

  const alloc = pf.holdings.filter((h) => (h.value ?? 0) > 0);
  const top = alloc.slice(0, 5);
  const rest = alloc.slice(5).reduce((s, h) => s + (h.value ?? 0), 0);
  const slices = [...top.map((h) => ({ id: h.asset.id, label: top.filter((x) => x.asset.name === h.asset.name).length > 1 ? `${h.asset.name} · ${h.asset.kind === 'spl' ? 'Solana' : h.asset.kind === 'erc20' ? 'ERC-20' : h.asset.symbol}` : h.asset.name, value: h.value ?? 0, color: h.asset.color })), ...(rest > 0 ? [{ id: 'other', label: 'Autres', value: rest, color: '#5E6470' }] : [])];

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 px-[26px] py-[22px]">
      <section aria-label="Valeur du portefeuille" className="relative h-[340px] shrink-0 overflow-hidden rounded-[22px] border border-line bg-card-hero">
        <div aria-hidden="true" className="absolute -top-40 -right-30 size-[520px] rounded-full border border-[#1A1D23]" />
        <div aria-hidden="true" className="absolute -top-20 -right-10 size-[360px] rounded-full border border-[#1A1D23]" />
        <div className="relative flex items-start justify-between px-7 pt-[26px]">
          <div className="flex flex-col gap-2.5">
            <div className="flex items-center gap-2 text-[13px] text-mute">
              Valeur totale
              <button type="button" aria-label={hideBalances ? 'Afficher les soldes' : 'Masquer les soldes'} onClick={() => setHideBalances(!hideBalances)} className="flex size-[26px] items-center justify-center rounded-[6px] hover:bg-raised hover:text-text">
                {hideBalances ? <IconEyeOff size={15} /> : <IconEye size={15} />}
              </button>
              {network === 'testnet' && <span className="text-[11px] text-faint">· prix mainnet, valeur indicative</span>}
            </div>
            <div className="text-[64px] leading-[0.95] font-semibold tracking-[-0.045em]">
              {pf.balancesLoaded && pf.markets ? <BigFiat value={pf.total} currency={cur} hidden={hideBalances} /> : <Skeleton className="h-[60px] w-[340px]" />}
            </div>
            <div className="flex h-6 items-center gap-2.5 text-[13px]">
              {delta !== null && pf.total > 0 ? (
                <>
                  <TrendPill change={delta}>
                    {hideBalances ? HIDDEN : fmtFiat(Math.abs(delta), cur)} · {fmtPct(deltaPct === null ? null : Math.abs(deltaPct), { sign: false })}
                  </TrendPill>
                  <span className="text-mute">{periodLabel}</span>
                </>
              ) : (
                <span className="text-mute">{pf.balancesLoaded ? (pf.total === 0 ? 'Aucun fonds pour l’instant' : '') : 'Chargement des soldes…'}</span>
              )}
            </div>
          </div>
          <div className="flex flex-col items-end gap-4">
            <Segmented label="Période" value={period} onChange={setPeriod} options={PERIODS.map((p) => ({ value: p, label: p }))} />
            <div className="flex gap-2">
              <Button variant="primary" size="lg" onClick={() => navigate({ name: 'send' })}>
                <IconUp size={16} /> Envoyer
              </Button>
              <Button size="lg" onClick={() => navigate({ name: 'receive' })}>
                <IconDown size={16} /> Recevoir
              </Button>
              <Button size="lg" onClick={() => navigate({ name: 'swap' })}>
                <IconSwap size={16} sw={2.2} /> Swap
              </Button>
            </div>
          </div>
        </div>
        <div className="absolute right-0 bottom-0 left-0 h-[190px]">
          {values.length > 1 ? (
            <SmoothChart
              values={values}
              height={190}
              defaultPoint="last"
              ariaLabel={`Courbe du portefeuille ${periodLabel}`}
              renderTooltip={(i) => ({ label: fmtChartTime(series[i]?.[0] ?? Date.now()), value: hideBalances ? HIDDEN : fmtFiat(values[i] ?? 0, cur) })}
            />
          ) : (
            <div className="flex h-full items-end">
              <svg width="100%" height="60" viewBox="0 0 1000 60" preserveAspectRatio="none" aria-hidden="true">
                <path d="M0,40 L1000,40" stroke="#22252B" strokeWidth="2" strokeDasharray="6 8" vectorEffect="non-scaling-stroke" />
              </svg>
              <span className="absolute bottom-16 left-7 text-[12px] text-faint">{chart.loading ? 'Chargement de la courbe…' : chart.error ? (torBlocked ? 'En attente de Tor…' : `Courbe indisponible : ${chart.error.message}`) : 'La courbe apparaîtra avec tes premiers fonds.'}</span>
            </div>
          )}
        </div>
      </section>

      <div className="flex min-h-0 flex-1 gap-4">
        <AssetListsCard className="flex-1" />
        <div className="flex w-[352px] shrink-0 flex-col gap-4">
          <section aria-label="Répartition" className="flex items-center gap-5 rounded-[20px] border border-line bg-card px-5 py-[18px]">
            <AllocationRing
              slices={slices}
              center={
                <>
                  <span className="text-[20px] font-semibold">{alloc.length}</span>
                  <span className="text-[11px] text-mute">actif{alloc.length > 1 ? 's' : ''}</span>
                </>
              }
            />
            <div className="flex flex-1 flex-col gap-[7px] text-[13px]">
              {slices.length === 0 && <span className="text-mute">La répartition s’affichera avec tes premiers fonds.</span>}
              {slices.map((s) => (
                <span key={s.id} className="flex items-center gap-2">
                  <span className="size-2 shrink-0 rounded-full" style={{ background: s.color }} />
                  <span className="min-w-0 flex-1 truncate text-text2">{s.label}</span>
                  <span className="font-semibold">{fmtNumber(pf.total ? (s.value / pf.total) * 100 : 0, 0)}{' '}%</span>
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
