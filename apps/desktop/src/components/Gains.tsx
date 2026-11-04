// SPDX-License-Identifier: GPL-3.0-or-later
// Gains and losses: the card of the Portfolio and the block of an asset page.

import type { Currency } from '@kyro/shared';
import { fmtFiat, fmtPct } from '../lib/format';
import type { CoinGains } from '../lib/gains';
import { useApp } from '../state/app';
import { useGains } from '../state/gains';
import { CoinIcon, HIDDEN, TrendPill, trendColor } from './kit';
import { useT } from '../i18n';

const ROWS = 5;

/** The amount and the percentage, or a dash: never a figure that is not known. */
function Figure({ gain, pct, hidden, currency }: { gain: number | null; pct: number | null; hidden: boolean; currency: Currency }) {
  if (gain === null) return <span className="text-[14px] text-mute">—</span>;
  return <TrendPill change={gain}>{hidden ? HIDDEN : `${fmtFiat(Math.abs(gain), currency)} · ${fmtPct(pct === null ? null : Math.abs(pct), { sign: false })}`}</TrendPill>;
}

export function GainsCard() {
  const { settings, hideBalances, navigate } = useApp();
  const { rows, total } = useGains();
  const { t } = useT();
  const cur = settings.currency;
  if (rows.length === 0) return null;
  const top = [...rows].sort((a, b) => (b.holding.value ?? 0) - (a.holding.value ?? 0)).slice(0, ROWS);
  return (
    <section aria-label={t('portfolio.gains')} className="flex flex-col gap-3 border-b border-line px-6 pt-5 pb-5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[15px] font-medium tracking-[-0.01em]">{t('portfolio.gains')}</span>
        <Figure gain={total.gain} pct={total.gainPct} hidden={hideBalances} currency={cur} />
      </div>
      <div className="flex flex-col">
        {top.map(({ holding: h, gains: g }) => (
          <button key={h.key} type="button" onClick={() => navigate({ name: 'asset', id: h.asset.id })} className="flex h-9 items-center gap-2.5 border-t border-line text-left text-[13px] hover:text-text">
            <CoinIcon asset={h.asset} size={20} />
            <span className="min-w-0 flex-1 truncate text-text2">{h.asset.symbol}</span>
            {g.partial && g.gain !== null && <span className="text-[12px] text-faint">{t('portfolio.gainsPartialTag')}</span>}
            <span className={g.gain === null ? 'text-mute' : `font-medium ${trendColor(g.gain)}`}>{g.gain === null ? '—' : hideBalances ? HIDDEN : `${g.gain < 0 ? '−' : '+'}${fmtFiat(Math.abs(g.gain), cur)}`}</span>
          </button>
        ))}
      </div>
      {total.partial && <p className="m-0 text-[12px] leading-[1.5] text-faint">{total.gain === null ? t('portfolio.gainsNone') : t('portfolio.gainsPartialTotal', { pct: hideBalances ? HIDDEN : fmtPct(total.coverage * 100, { sign: false, decimals: 0 }) })}</p>}
    </section>
  );
}

export function AssetGains({ gains, symbol }: { gains: CoinGains | undefined; symbol: string }) {
  const { settings, hideBalances } = useApp();
  const { t } = useT();
  const cur = settings.currency;
  if (!gains) return null;
  return (
    <div className="mt-2 flex flex-col items-start gap-1.5 border-t border-line pt-3 text-[13px]">
      <span className="eyebrow">{t('portfolio.gains')}</span>
      <Figure gain={gains.gain} pct={gains.gainPct} hidden={hideBalances} currency={cur} />
      <div className="flex w-full items-center justify-between">
        <span className="text-mute">{t('portfolio.gainsAverage', { symbol })}</span>
        <span className="font-medium">{gains.averageCost === null ? '—' : hideBalances ? HIDDEN : fmtFiat(gains.averageCost, cur)}</span>
      </div>
      {gains.partial && <span className="text-[12px] leading-[1.5] text-faint">{gains.gain === null ? t('portfolio.gainsNone') : t('portfolio.gainsPartial', { pct: hideBalances ? HIDDEN : fmtPct(gains.coverage * 100, { sign: false, decimals: 0 }) })}</span>}
    </div>
  );
}
