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
