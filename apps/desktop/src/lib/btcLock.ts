// SPDX-License-Identifier: GPL-3.0-or-later
// Dates of a Bitcoin time lock. A lock ends at 00:00 UTC of a calendar day, and Rust refuses
// anything else, so everything here works on `YYYY-MM-DD` strings and `Date.UTC`: no local
// midnight, so no time zone or daylight saving can move the date (docs/BTC_TIMELOCK.md).

import type { BtcLockScanStep, BtcLockStatus, Lang } from '@kyro/shared';

export const LOCK_DAY_SECS = 86_400;
export const LOCK_MIN_SATS = 50_000n;
/** Rust's limit: 10 years, with their leap days. */
export const LOCK_MAX_DAYS_AHEAD = 3_653;
/** Rust's limit: miniscript's `after()` stops at 2^31, so a later date has no standard descriptor. */
export const LOCK_LAST_DATE = '2038-01-19';
export const LOCK_SHORTCUTS = [7, 30, 90, 365] as const;

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

const ymd = (y: number, m: number, d: number) => `${pad(y, 4)}-${pad(m)}-${pad(d)}`;

/** `T` of a calendar day: 00:00 UTC, whatever the computer's time zone. `null` if it is not a date. */
export function lockTimeOf(date: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return ms / 1000;
}

export function dateOfLockTime(t: number): string {
  const d = new Date(t * 1000);
  return ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

export function addDays(date: string, days: number): string {
  return dateOfLockTime((lockTimeOf(date) ?? 0) + days * LOCK_DAY_SECS);
}

/** Today on the computer's calendar. */
export const localToday = (now: Date) => ymd(now.getFullYear(), now.getMonth() + 1, now.getDate());

export const utcToday = (now: Date) => ymd(now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate());

/** ISO dates compare as strings. */
const later = (a: string, b: string) => (a > b ? a : b);
const earlier = (a: string, b: string) => (a < b ? a : b);

/** Tomorrow for the user and for Rust (which counts in UTC): the later of the two. */
export const minLockDate = (now: Date) => addDays(later(localToday(now), utcToday(now)), 1);

export const maxLockDate = (now: Date) => earlier(addDays(utcToday(now), LOCK_MAX_DAYS_AHEAD), LOCK_LAST_DATE);

/** The date of a shortcut, counted on the user's calendar. */
export const shortcutDate = (now: Date, days: number) => earlier(later(addDays(localToday(now), days), minLockDate(now)), maxLockDate(now));

export function lockDateError(date: string, now: Date): 'invalid' | 'tooSoon' | 'tooFar' | null {
  if (lockTimeOf(date) === null) return 'invalid';
  if (date < minLockDate(now)) return 'tooSoon';
  if (date > maxLockDate(now)) return 'tooFar';
  return null;
}

/** The moment `T` on the computer's clock, which can be the day before the date chosen. */
export function unlockLocal(t: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeStyle: 'short' }).format(new Date(t * 1000));
}

export function unlockUtc(t: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(t * 1000));
}

export function unlockShort(t: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(t * 1000));
}

/** The network's clock runs one to two hours behind: this is when a withdrawal should go through. */
export const LOCK_CLOCK_LAG_SECS = 7_200;

export const withdrawableAt = (t: number, locale: string) => unlockLocal(t + LOCK_CLOCK_LAG_SECS, locale);

export interface TimelineMark {
  t: number;
  sats: number;
  /** From 0 (today) to 100 (the last date). */
  pos: number;
  past: boolean;
  draft: boolean;
  labeled: boolean;
}

const LABEL_GAP = 13;

/**
 * Where each date sits on the line, and which ones keep their label. A square root keeps a week
 * apart from today even next to a date years away. The last date and the one being chosen always
 * keep their label; "today" goes first when space runs out.
 */
export function lockTimeline(locks: Array<{ t: number; sats: number }>, draft: { t: number; sats: number } | null, now: number): { marks: TimelineMark[]; today: boolean } {
  const byDate = new Map<number, number>();
  for (const l of [...locks, ...(draft ? [draft] : [])]) {
    const key = l.t <= now ? 0 : l.t;
    byDate.set(key, (byDate.get(key) ?? 0) + l.sats);
  }
  const end = Math.max(now + LOCK_DAY_SECS, ...byDate.keys());
  const marks: TimelineMark[] = [...byDate.entries()]
    .sort(([a], [b]) => a - b)
    .map(([t, sats]) => ({ t, sats, pos: t === 0 ? 0 : Math.sqrt((t - now) / (end - now)) * 100, past: t === 0, draft: draft?.t === t, labeled: false }));
  let nearest: TimelineMark | null = null;
  for (const m of [...marks].reverse()) {
    if (!nearest || nearest.pos - m.pos >= LABEL_GAP) {
      m.labeled = true;
      nearest = m;
    } else if (m.draft) {
      nearest.labeled = false;
      m.labeled = true;
      nearest = m;
    }
  }
  return { marks, today: !marks[0]?.past && (!nearest || nearest.pos >= LABEL_GAP) };
}

/** Rust takes whole sat/vB. Fee estimates can have decimals, and the minimum is 1. */
export const lockFeeRate = (rate: number) => (Number.isFinite(rate) && rate >= 1 ? Math.floor(rate) : 0);

/** How far a "Find my locks" run got. Only `finished` means every date was answered. */
export interface LockScanProgress {
  nextDay: number | null;
  /** Last day fully answered. */
  reachedDay: number | null;
  firstDay: number | null;
  lastDay: number | null;
  found: number;
  finished: boolean;
  error: unknown;
}

export const lockScanStart: LockScanProgress = { nextDay: null, reachedDay: null, firstDay: null, lastDay: null, found: 0, finished: false, error: null };

/** Runs or resumes the search. A failure keeps the place, and is never a result. */
export async function runLockScan(step: (fromDay: number | null) => Promise<BtcLockScanStep>, from: LockScanProgress, onStep: (p: LockScanProgress) => void): Promise<LockScanProgress> {
  let p: LockScanProgress = { ...from, error: null };
  for (;;) {
    try {
      const s = await step(p.nextDay);
      if (s.lastDay < s.firstDay) throw new Error('empty range');
      const reachedDay = s.nextDay === null ? s.lastDay : s.nextDay - 1;
      p = { ...p, nextDay: s.nextDay, reachedDay, firstDay: s.firstDay, lastDay: s.lastDay, found: p.found + s.found, finished: s.nextDay === null };
      onStep(p);
      if (p.finished) return p;
    } catch (error) {
      p = { ...p, error };
      onStep(p);
      return p;
    }
  }
}

export const confirmWord = (lang: Lang) => (lang === 'fr' ? 'BLOQUER' : 'LOCK');

/** Coins still held by a lock: they count in the line shown beside the balance. */
export const isHeld = (s: BtcLockStatus) => s === 'confirming' || s === 'locked' || s === 'ready' || s === 'unknown';

/** Days, hours and minutes with the two largest units, in a form both languages read. */
export function lockTimeLeft(secs: number, units: { d: string; h: string; m: string }): string {
  if (secs <= 0) return `0 ${units.m}`;
  const days = Math.floor(secs / LOCK_DAY_SECS);
  const hours = Math.floor((secs % LOCK_DAY_SECS) / 3_600);
  const mins = Math.max(1, Math.ceil((secs % 3_600) / 60));
  if (days > 0) return `${days} ${units.d}${hours > 0 ? ` ${hours} ${units.h}` : ''}`;
  if (hours > 0) return `${hours} ${units.h} ${mins} ${units.m}`;
  return `${mins} ${units.m}`;
}

/** When a lock started, in ms: the funding's block time from the backend (`fundedAt`, seconds),
 *  otherwise the earliest history entry sent to the lock's address (ms). `null` when neither. */
export function lockStartMs(fundedAt: number | null | undefined, historyMs: number[]): number | null {
  if (typeof fundedAt === 'number' && Number.isFinite(fundedAt) && fundedAt > 0) return fundedAt * 1000;
  const ts = historyMs.filter((t) => Number.isFinite(t) && t > 0);
  return ts.length ? Math.min(...ts) : null;
}

/** Part of the lock already behind us (0.02–0.98 so both arcs stay visible), or `null`. */
export function lockElapsed(startMs: number | null, t: number, nowMs: number): number | null {
  if (startMs === null || t * 1000 <= startMs) return null;
  return Math.min(0.98, Math.max(0.02, (nowMs - startMs) / (t * 1000 - startMs)));
}
