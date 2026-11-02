// SPDX-License-Identifier: GPL-3.0-or-later
import type { Currency } from '@kyro/shared';
import { cn } from '../lib/cn';
import { fmtCrypto, fmtFiat, fmtWhen, shortAddress, MINUS } from '../lib/format';
import type { HistoryEntry } from '../state/history';
import { findContact, type ContactFamily } from '../lib/storage';
import { Badge, Spinner } from './ui/primitives';
import { IconCheck, IconDown, IconSwap, IconUp } from './icons';
import { CoinIcon, HIDDEN } from './kit';
import { idx } from './motion';
import { t } from '../i18n';

export function entryTitle(e: HistoryEntry): string {
  if (e.label) return e.label;
  const family = (e.asset?.family ?? 'evm') as ContactFamily;
  const who = e.counterparty ? findContact(e.counterparty, family)?.name ?? shortAddress(e.counterparty) : null;
  if (e.kind === 'approval') return e.asset?.symbol ? t('history.approvalOf', { symbol: e.asset.symbol }) : t('history.approval');
  if (e.kind === 'swap') return t('history.swap');
  // Address-poisoning lure: never « sent to X » / « received from X » (that is the bait).
  if (e.suspect === 'notSigned') return who ? t('history.suspectTo', { who }) : t('history.suspect');
  if (e.suspect === 'zero') return who ? t('history.suspectZeroWho', { who }) : t('history.suspectZero');
  if (e.direction === 'in') return who ? t('history.receivedFrom', { who }) : t('history.received');
  if (e.direction === 'self') return t('history.toSelf');
  return who ? t('history.sentTo', { who }) : t('history.sendShort');
}

export function statusBadge(e: HistoryEntry) {
  if (e.suspect) return <Badge tone="warn">{t('history.badgeSuspect')}</Badge>;
  if (e.status === 'pending') return <Badge tone="warn">{t('history.badgePending')}</Badge>;
  if (e.status === 'failed') return <Badge tone="down">{t('history.badgeFailed')}</Badge>;
  return <Badge tone="mute">{e.asset?.family === 'sol' ? t('history.badgeFinalized') : t('history.badgeConfirmed')}</Badge>;
}

export function HistoryRow({ e, price, currency, hidden, compact, i = 0 }: { e: HistoryEntry; price: number | null; currency: Currency; hidden: boolean; compact?: boolean; /** Row index, for the staggered entrance. */ i?: number }) {
  const icon = e.kind === 'swap' ? <IconSwap size={16} sw={2.2} /> : e.kind === 'approval' ? <IconCheck size={16} /> : e.direction === 'in' ? <IconDown size={16} /> : <IconUp size={16} />;
  const color = e.direction === 'in' ? 'text-up' : 'text-text';
  const decimals = e.asset?.decimals ?? 18;
  const symbol = e.asset?.symbol ?? '';
  const units = Number(e.amount) / 10 ** decimals;
  const sign = e.kind === 'approval' ? '' : e.direction === 'in' ? '+' : MINUS;
  const sub = [e.time ? fmtWhen(e.time) : t('history.rowInProgress'), e.chainLabel, e.fee && e.feeAsset && e.direction !== 'in' ? t('history.rowFee', { fee: fmtCrypto(e.fee, e.feeAsset.decimals, e.feeAsset.symbol) }) : null, e.note ?? null].filter(Boolean).join(' · ');
  return (
    <div style={idx(i)} className={cn('flex items-center gap-3.5 border-t border-line/70 px-5 transition-colors duration-150 hover:bg-raised/40', compact ? 'h-[58px]' : 'h-[62px]')}>
      <span className={cn('relative flex size-9 shrink-0 items-center justify-center rounded-full border', e.direction === 'in' && e.kind === 'transfer' ? 'border-up/30 text-up' : 'border-line-2 text-text2')}>
        {icon}
        {e.asset && (
          <span className="absolute -right-1 -bottom-1 inline-flex rounded-full border-2 border-card bg-card">
            <CoinIcon asset={{ ...e.asset, chainKey: undefined }} size={14} />
          </span>
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[14px] font-medium">{entryTitle(e)}</span>
        <span className="truncate text-[12px] text-mute">{sub}</span>
      </span>
      {!compact && <span className="shrink-0">{statusBadge(e)}</span>}
      <span className="flex w-[150px] shrink-0 flex-col items-end">
        <span className={cn('text-[14px] font-medium', color)}>{hidden ? HIDDEN : `${sign}${fmtCrypto(e.amount, decimals, symbol)}`}</span>
        <span className="text-[12px] text-mute">{hidden ? HIDDEN : price !== null && e.asset ? fmtFiat(units * price, currency) : compact ? (e.status === 'pending' ? t('history.rowPending') : '') : '—'}</span>
      </span>
    </div>
  );
}

/** First-ever load (nothing cached yet): one quiet line, never a stack of skeleton bars. */
export function LoadingLine() {
  return (
    <p role="status" className="m-0 flex items-center gap-2.5 px-5 py-4 text-[13px] text-mute">
      <Spinner className="size-3.5" />
      {t('common.loading')}
    </p>
  );
}
