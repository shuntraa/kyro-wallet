// SPDX-License-Identifier: GPL-3.0-or-later
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import type { Currency } from '@kyro/shared';
import { isTinyLure } from '@kyro/chains';
import { cn } from '../lib/cn';
import { fmtCrypto, fmtFiat, fmtWhen, shortAddress, MINUS } from '../lib/format';
import type { HistoryEntry } from '../state/history';
import { findContact, type ContactFamily } from '../lib/storage';
import { Badge, Spinner } from './ui/primitives';
import { IconCheck, IconDown, IconSwap, IconUp } from './icons';
import { CoinIcon, HIDDEN } from './kit';
import { GLOW } from './kyro';
import { coinTint } from './kyroParts';
import { motion } from 'motion/react';
import { idx } from './motion';
import { t } from '../i18n';

export function entryTitle(e: HistoryEntry, tiny = false): string {
  if (e.label) return e.label;
  const family = (e.asset?.family ?? 'evm') as ContactFamily;
  const who = e.counterparty ? findContact(e.counterparty, family)?.name ?? shortAddress(e.counterparty) : null;
  if (e.kind === 'approval') return e.asset?.symbol ? t('history.approvalOf', { symbol: e.asset.symbol }) : t('history.approval');
  if (e.kind === 'swap') return t('history.swap');
  // Address-poisoning lure: never « sent to X » / « received from X » (that is the bait).
  if (e.suspect === 'notSigned') return who ? t('history.suspectTo', { who }) : t('history.suspect');
  if (e.suspect === 'zero') return who ? t('history.suspectZeroWho', { who }) : t('history.suspectZero');
  if (tiny) return who ? t('history.suspectTinyWho', { who }) : t('history.suspectTiny');
  if (e.direction === 'in') return who ? t('history.receivedFrom', { who }) : t('history.received');
  if (e.direction === 'self') return t('history.toSelf');
  return who ? t('history.sentTo', { who }) : t('history.sendShort');
}

export function statusBadge(e: HistoryEntry, tiny = false) {
  if (e.suspect || tiny) return <Badge tone="warn">{t('history.badgeSuspect')}</Badge>;
  if (e.status === 'pending') return <Badge tone="warn">{t('history.badgePending')}</Badge>;
  if (e.status === 'failed') return <Badge tone="down">{t('history.badgeFailed')}</Badge>;
  return <Badge tone="mute">{e.asset?.family === 'sol' ? t('history.badgeFinalized') : t('history.badgeConfirmed')}</Badge>;
}

/** Pending: a small ice bar running (no confirmation count is known here). */
export function PendingBar({ label }: { label: string }) {
  return (
    <span className="flex shrink-0 flex-col gap-1" role="status">
      <span className="text-[11px] text-mute">{label}</span>
      <span className="relative block h-[3px] w-[110px] overflow-hidden rounded-full bg-white/[.07]">
        <motion.span className="absolute inset-y-0 left-0 block w-1/3 rounded-full bg-ice shadow-[0_0_8px_#7cc4ff]" initial={{ x: '-100%' }} animate={{ x: '300%' }} transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }} />
      </span>
    </span>
  );
}

export function HistoryRow({ e, price, currency, hidden, compact, timeline, i = 0, action, extra, onOpen }: { e: HistoryEntry; price: number | null; currency: Currency; hidden: boolean; compact?: boolean; /** In the History timeline: the time sits in its own column. */ timeline?: boolean; /** Buttons of a pending transaction (History). */ action?: ReactNode; /** Row index, for the staggered entrance. */ i?: number; /** A line under the details (History: the private note). */ extra?: ReactNode; /** Click on the row (outside its own buttons): opens the transaction's details. */ onOpen?: () => void }) {
  const icon = e.kind === 'swap' ? <IconSwap size={15} sw={2.1} /> : e.kind === 'approval' ? <IconCheck size={15} /> : e.direction === 'in' ? <IconDown size={15} sw={2.2} /> : <IconUp size={15} sw={2.2} />;
  const incoming = e.direction === 'in' && e.kind === 'transfer';
  const decimals = e.asset?.decimals ?? 18;
  const symbol = e.asset?.symbol ?? '';
  const units = Number(e.amount) / 10 ** decimals;
  const tiny = isTinyLure(e, e.asset?.family, price === null ? null : units * price);
  const sign = e.kind === 'approval' ? '' : e.direction === 'in' ? '+' : MINUS;
  const sub = [timeline ? null : e.time ? fmtWhen(e.time) : t('history.rowInProgress'), e.chainLabel, e.fee && e.feeAsset && e.direction !== 'in' ? t('history.rowFee', { fee: fmtCrypto(e.fee, e.feeAsset.decimals, e.feeAsset.symbol) }) : null, e.note ?? null].filter(Boolean).join(' · ');
  // Coin light on what comes in (or moves inside the wallet); what leaves stays plain.
  const c = e.asset?.color ? coinTint(e.asset.color) : null;
  const lit = !hidden && c && e.direction !== 'out' && e.kind !== 'approval' && !tiny && !e.suspect && e.status !== 'failed';
  const warn = e.suspect || tiny || e.status === 'failed';
  return (
    <div
      style={idx(i)}
      className={cn('group flex items-center gap-3.5 border-b border-white/[.04] transition-colors duration-150', compact ? 'min-h-[58px] px-5 py-2' : 'py-2.5', onOpen && '-mx-2 cursor-pointer rounded-[12px] px-2 hover:bg-white/[.03] focus-visible:bg-white/[.04] focus-visible:outline-none')}
      {...(onOpen
        ? {
            role: 'button',
            tabIndex: 0,
            'aria-haspopup': 'dialog',
            title: t('history.openDetails'),
            onClick: (ev: ReactMouseEvent) => {
              if (!(ev.target as HTMLElement).closest('button,input,textarea,a')) onOpen();
            },
            onKeyDown: (ev: ReactKeyboardEvent) => {
              if ((ev.key === 'Enter' || ev.key === ' ') && ev.target === ev.currentTarget) {
                ev.preventDefault();
                onOpen();
              }
            },
          }
        : {})}
    >
      <span className={cn('grid size-9 shrink-0 place-items-center rounded-full', incoming ? 'bg-up/[.1] text-up' : 'bg-white/[.06] text-text2')}>{icon}</span>
      {e.asset && <CoinIcon asset={{ ...e.asset, chainKey: undefined }} size={22} />}
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate text-[13.5px] font-semibold">{entryTitle(e, tiny)}</span>
        <span className="truncate text-[11.5px] text-faint">{sub}</span>
        {extra}
      </span>
      {e.status === 'pending' && !warn && <span className="ml-4"><PendingBar label={t('history.badgePending')} /></span>}
      {warn && <span className="shrink-0">{statusBadge(e, tiny)}</span>}
      {action && <span className="flex shrink-0 items-center gap-1.5">{action}</span>}
      <span className="ml-auto flex shrink-0 flex-col items-end leading-tight">
        <span className={cn('figure text-[13.5px] font-semibold', !lit && (incoming && !warn ? 'text-up' : 'text-text'))} style={lit && c ? GLOW(c) : undefined}>
          {hidden ? HIDDEN : `${sign}${fmtCrypto(e.amount, decimals, symbol)}`}
        </span>
        <span className="figure text-[11.5px] text-faint">{hidden ? HIDDEN : price !== null && e.asset ? fmtFiat(units * price, currency) : compact ? (e.status === 'pending' ? t('history.rowPending') : '') : '—'}</span>
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
