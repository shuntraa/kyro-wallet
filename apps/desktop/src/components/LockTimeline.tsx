// SPDX-License-Identifier: GPL-3.0-or-later
// When the locked bitcoin come back: one line from today to the last date, a point per date.

import { motion } from 'motion/react';
import { intlLocale } from '@kyro/shared';
import { fmtCrypto } from '../lib/format';
import { lockTimeline, unlockShort, type TimelineMark } from '../lib/btcLock';
import { cn } from '../lib/cn';
import { useT } from '../i18n';
import { HIDDEN } from './kit';

const edge = (pos: number) => (pos < 7 ? '0%' : pos > 93 ? '-100%' : '-50%');

function Mark({ mark, hidden }: { mark: TimelineMark; hidden: boolean }) {
  const { t } = useT();
  const date = mark.past ? t('lock.status.ready') : unlockShort(mark.t, intlLocale());
  const amount = hidden ? HIDDEN : fmtCrypto(BigInt(mark.sats), 8, 'BTC');
  const label = cn('absolute whitespace-nowrap text-[12.5px] tabular-nums transition-opacity duration-150', !mark.labeled && 'opacity-0 group-hover:opacity-100');
  const shift = { transform: `translateX(${edge(mark.pos)})` };
  return (
    <div className="group absolute top-1/2 transition-[left] duration-300 ease-out" style={{ left: `${mark.pos}%` }}>
      <span aria-hidden className={cn('absolute top-0 left-0 block -translate-x-1/2 -translate-y-1/2 rounded-full', mark.draft ? 'size-[11px] bg-ice ring-4 ring-ice/15' : mark.past ? 'size-[9px] bg-ice' : 'size-[9px] border-[1.5px] border-ice bg-bg')} />
      <span className={cn(label, 'bottom-3', mark.draft ? 'font-medium text-text' : 'text-text2')} style={shift}>
        {date}
      </span>
      <span className={cn(label, 'top-3 text-mute')} style={shift}>
        {amount}
      </span>
    </div>
  );
}

export function LockTimeline({ locks, draft = null, hidden = false, className }: { locks: Array<{ t: number; sats: number }>; draft?: { t: number; sats: number } | null; hidden?: boolean; className?: string }) {
  const { t } = useT();
  const { marks, today } = lockTimeline(locks, draft, Math.floor(Date.now() / 1000));
  return (
    <div role="img" aria-label={t('lock.timeline')} className={cn('relative h-[76px] shrink-0', className)}>
      <motion.div className="absolute inset-x-0 top-1/2 h-px origin-left bg-ice/40" initial={{ scaleX: 0 }} animate={{ scaleX: 1 }} transition={{ duration: 0.35, ease: 'easeOut' }} />
      <span aria-hidden className="absolute top-1/2 left-0 size-[5px] -translate-y-1/2 rounded-full bg-mute" />
      {today ? <span className="absolute bottom-[calc(50%+12px)] left-0 text-[12.5px] text-mute">{t('lock.today')}</span> : null}
      {marks.map((m) => (
        <Mark key={m.draft ? 'draft' : m.t} mark={m} hidden={hidden} />
      ))}
    </div>
  );
}
