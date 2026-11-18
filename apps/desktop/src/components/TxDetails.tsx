// SPDX-License-Identifier: GPL-3.0-or-later
// One transaction, opened from the History: amount, value then and now, fee, who, the tx id.
// The price at that time is looked up once (same CoinGecko charts as the asset pages) and kept on
// this device: opening it again asks nothing.

import { useEffect, useState, type ReactNode } from 'react';
import type { ChartDays } from '@kyro/market';
import { unitsToNumber } from '@kyro/chains';
import { useApp, useVault } from '../state/app';
import { usePortfolio } from '../state/portfolio';
import type { HistoryEntry } from '../state/history';
import { copyText } from '../lib/copy';
import { cn } from '../lib/cn';
import { fmtCrypto, fmtDate, fmtFiat, fmtPct, MINUS } from '../lib/format';
import { readJson, writeJson } from '../lib/storage';
import { Dialog } from './ui/dialog';
import { CoinIcon, HIDDEN, trendColor } from './kit';
import { BIG, LABEL, THIN } from './kyro';
import { coinTint } from './kyroParts';
import { entryTitle, statusBadge } from './HistoryRow';
import { IconCheck, IconCopy } from './icons';
import { useT } from '../i18n';

const PRICE_KEY = 'history.pricesAt.v1';
const MAX_PRICES = 2000;

/** Price of `coinId` around `time` (nearest chart point), cached forever on this device. */
function usePriceAt(coinId: string | undefined, time: number | undefined): { price: number | null; loading: boolean } {
  const { market, settings } = useApp();
  const cur = settings.currency;
  const key = coinId && time ? `${cur}|${coinId}|${Math.round(time / 3_600_000)}` : null;
  const [state, setState] = useState<{ key: string | null; price: number | null; loading: boolean }>(() => ({ key, price: key ? readJson<Record<string, number>>(PRICE_KEY, {})[key] ?? null : null, loading: false }));
  useEffect(() => {
    if (!key || !coinId || !time) return setState({ key, price: null, loading: false });
    const stored = readJson<Record<string, number>>(PRICE_KEY, {})[key];
    if (stored !== undefined) return setState({ key, price: stored, loading: false });
    let alive = true;
    setState({ key, price: null, loading: true });
    const age = Date.now() - time;
    const days: ChartDays = age < 86_400_000 ? 1 : age < 7 * 86_400_000 ? 7 : age < 30 * 86_400_000 ? 30 : age < 365 * 86_400_000 ? 365 : 'max';
    market
      .chart(coinId, cur, days)
      .then((points) => {
        let best: number | null = null;
        let gap = Infinity;
        for (const [t, p] of points) {
          const d = Math.abs(t - time);
          if (d < gap) {
            gap = d;
            best = p;
          }
        }
        // A point more than two days away says nothing about that moment.
        const price = best !== null && gap < 2 * 86_400_000 ? best : null;
        if (price !== null) {
          const all = readJson<Record<string, number>>(PRICE_KEY, {});
          all[key] = price;
          const keys = Object.keys(all);
          for (const k of keys.slice(0, Math.max(0, keys.length - MAX_PRICES))) delete all[k];
          writeJson(PRICE_KEY, all);
        }
        if (alive) setState({ key, price, loading: false });
      })
      .catch(() => alive && setState({ key, price: null, loading: false }));
    return () => {
      alive = false;
    };
  }, [key]);
  return state.key === key ? state : { price: null, loading: !!key };
}

function CopyRow({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  const { t } = useT();
  const [done, setDone] = useState<boolean | null>(null);
  useEffect(() => {
    if (done === null) return;
    const id = window.setTimeout(() => setDone(null), 1600);
    return () => window.clearTimeout(id);
  }, [done]);
  return (
    <div className="flex flex-col gap-1.5 border-t border-white/[.06] py-3">
      <span className="text-[12px] text-mute">{label}</span>
      <div className="flex items-start gap-3">
        <span className={cn('min-w-0 flex-1 text-[12.5px] leading-[1.55] break-all text-text', mono && 'font-mono')}>{value}</span>
        <button type="button" aria-label={`${t('common.copy')} · ${label}`} title={t('common.copy')} onClick={async () => setDone(await copyText(value))} className="press grid size-8 shrink-0 place-items-center rounded-full bg-[rgba(22,27,35,.72)] text-mute ring-1 ring-[rgba(124,196,255,.2)] hover:text-ice hover:ring-[rgba(124,196,255,.45)]">
          <span key={String(done)} className="pop-in inline-flex">{done ? <IconCheck size={14} className="text-up" /> : <IconCopy size={14} />}</span>
        </button>
      </div>
    </div>
  );
}

function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-t border-white/[.06] py-2.5 text-[13px]">
      <span className="shrink-0 text-mute">{k}</span>
      <span className="figure min-w-0 text-right text-text">{children}</span>
    </div>
  );
}

export function TxDetails({ e, note, onClose }: { e: HistoryEntry; note?: string | undefined; onClose: () => void }) {
  const { t } = useT();
  const { settings, hideBalances } = useApp();
  const { accountSources } = useVault();
  const pf = usePortfolio();
  const cur = settings.currency;
  const asset = e.asset;
  const units = asset ? unitsToNumber(e.amount, asset.decimals) : 0;
  const then = usePriceAt(asset?.coingeckoId, e.time);
  const now = asset ? pf.price(asset.coingeckoId)?.price ?? null : null;
  const valueThen = then.price !== null ? units * then.price : null;
  const valueNow = now !== null ? units * now : null;
  const change = valueThen !== null && valueNow !== null && valueThen > 0 ? ((valueNow - valueThen) / valueThen) * 100 : null;
  const feeNow = e.fee && e.feeAsset ? unitsToNumber(e.fee, e.feeAsset.decimals) * (pf.price(e.feeAsset.coingeckoId)?.price ?? 0) : null;
  const txId = e.id.split(/[:@]/)[0] ?? e.id;
  const accountIndex = Number(e.id.split('@')[1] ?? 0);
  const account = accountSources.find((s) => s.index === accountIndex && s.adapters.some((a) => a.chain.key === e.chainKey));
  const c = coinTint(asset?.color, 0.95);
  const sign = e.kind === 'approval' ? '' : e.direction === 'in' ? '+' : MINUS;
  const yours = account ? t('history.txYourWallet', { name: account.name }) : t('history.txYourWalletPlain');
  const from = e.direction === 'in' ? e.counterparty : null;
  const to = e.direction === 'in' ? null : e.counterparty;
  const hide = (s: string) => (hideBalances ? HIDDEN : s);

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()} title={entryTitle(e)} className="w-[520px] bg-[linear-gradient(180deg,#0e1826_0%,#0a0f16_55%,#07090d_100%)] border-[rgba(170,220,255,.12)]">
      <div className="flex items-center gap-3">
        {asset && <CoinIcon asset={{ ...asset, chainKey: undefined }} size={34} />}
        <span className="flex min-w-0 flex-1 items-baseline gap-2 text-[34px] leading-none" style={{ ...THIN, ...(hideBalances ? {} : BIG(c)) }}>
          <span className="truncate">{hide(`${sign}${fmtCrypto(e.amount, asset?.decimals ?? 18)}`)}</span>
          <span className="shrink-0 text-[16px]">{asset?.symbol ?? ''}</span>
        </span>
        <span className="shrink-0">{statusBadge(e)}</span>
      </div>
      <p className="m-0 -mt-1 text-[12.5px] text-mute">
        {e.time ? fmtDate(e.time, { dateStyle: 'full', timeStyle: 'short' }) : t('history.inProgress')} · {e.chainLabel}
      </p>

      {asset && e.kind !== 'approval' && (
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1 rounded-[14px] bg-[rgba(22,27,35,.6)] px-4 py-3 ring-1 ring-white/[.07]">
            <span className={LABEL}>{t('history.txThen')}</span>
            <span className="figure text-[18px] text-text">{then.loading ? '…' : valueThen !== null ? hide(fmtFiat(valueThen, cur)) : '—'}</span>
            <span className="figure text-[11.5px] text-faint">{then.price !== null ? t('history.txUnitPrice', { price: fmtFiat(then.price, cur), symbol: asset.symbol }) : then.loading ? '' : t('history.txNoPrice')}</span>
          </div>
          <div className="flex flex-col gap-1 rounded-[14px] bg-[rgba(124,196,255,.06)] px-4 py-3 ring-1 ring-[rgba(124,196,255,.18)]">
            <span className={LABEL}>{t('history.txNow')}</span>
            <span className="figure text-[18px] text-text">
              {valueNow !== null ? hide(fmtFiat(valueNow, cur)) : '—'}
              {change !== null && !hideBalances && <span className={cn('ml-2 text-[12px]', trendColor(change))}>{fmtPct(change)}</span>}
            </span>
            <span className="figure text-[11.5px] text-faint">{now !== null ? t('history.txUnitPrice', { price: fmtFiat(now, cur), symbol: asset.symbol }) : ''}</span>
          </div>
        </div>
      )}

      <div className="flex flex-col">
        {e.fee !== undefined && e.feeAsset && e.direction !== 'in' && (
          <Row k={t('history.txFee')}>
            {hide(fmtCrypto(e.fee, e.feeAsset.decimals, e.feeAsset.symbol))}
            {feeNow !== null && feeNow >= 0.01 && !hideBalances && <span className="text-faint"> · {fmtFiat(feeNow, cur)}</span>}
          </Row>
        )}
        {from ? <CopyRow label={t('history.txFrom')} value={from} /> : <Row k={t('history.txFrom')}>{e.direction === 'in' ? '—' : yours}</Row>}
        {to ? <CopyRow label={t('history.txTo')} value={to} /> : e.kind === 'transfer' && <Row k={t('history.txTo')}>{e.direction === 'out' ? '—' : yours}</Row>}
        {e.note && <Row k={t('history.txDetails')}>{e.note}</Row>}
        {note && <Row k={t('history.txNote')}>{note}</Row>}
        <CopyRow label={t('history.txTxId')} value={txId} />
      </div>
    </Dialog>
  );
}
