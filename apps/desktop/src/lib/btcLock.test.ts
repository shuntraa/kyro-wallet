// A lock's date must not move with the computer's time zone: these tests run under several.
import { afterEach, describe, expect, it } from 'vitest';
import { addDays, confirmWord, lockElapsed, lockFeeRate, lockStartMs, lockScanStart, runLockScan, type LockScanProgress, dateOfLockTime, isHeld, localToday, lockDateError, lockTimeLeft, lockTimeOf, maxLockDate, minLockDate, shortcutDate, unlockLocal, unlockUtc, utcToday, lockTimeline } from './btcLock';

const ZONES = ['UTC', 'Europe/Paris', 'America/Los_Angeles', 'Asia/Tokyo', 'Pacific/Auckland', 'Pacific/Kiritimati', 'Pacific/Pago_Pago'];
const original = process.env.TZ;

function inZone(zone: string) {
  process.env.TZ = zone;
}

afterEach(() => {
  if (original === undefined) delete process.env.TZ;
  else process.env.TZ = original;
});

describe('the timeline', () => {
  const now = 1_800_000_000;
  const day = 86_400;

  it('puts the last date at the end and a nearer one before it', () => {
    const { marks } = lockTimeline([{ t: now + 100 * day, sats: 1 }, { t: now + 25 * day, sats: 2 }], null, now);
    expect(marks.map((m) => Math.round(m.pos))).toEqual([50, 100]);
  });

  it('gathers what can be withdrawn at the start of the line', () => {
    const { marks, today } = lockTimeline([{ t: now - 5 * day, sats: 1 }, { t: now - day, sats: 2 }, { t: now + 30 * day, sats: 3 }], null, now);
    expect(marks[0]).toMatchObject({ past: true, sats: 3, pos: 0, labeled: true });
    expect(today).toBe(false);
  });

  it('adds the date being chosen to one that already exists', () => {
    const { marks } = lockTimeline([{ t: now + 30 * day, sats: 5 }], { t: now + 30 * day, sats: 2 }, now);
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({ sats: 7, draft: true });
  });

  it('dates too close share one label, and the one being chosen keeps it', () => {
    const far = { t: now + 1000 * day, sats: 1 };
    const a = { t: now + 400 * day, sats: 1 };
    const b = { t: now + 402 * day, sats: 1 };
    expect(lockTimeline([far, a, b], null, now).marks.map((m) => m.labeled)).toEqual([false, true, true]);
    expect(lockTimeline([far, b], a, now).marks.map((m) => m.labeled)).toEqual([true, false, true]);
  });

  it('gives up "today" before anything else', () => {
    expect(lockTimeline([{ t: now + 365 * day, sats: 1 }], null, now).today).toBe(true);
    expect(lockTimeline([{ t: now + 2000 * day, sats: 1 }], { t: now + day, sats: 1 }, now).today).toBe(false);
    expect(lockTimeline([], null, now).today).toBe(true);
  });
});

describe('the date never moves', () => {
  it('reads T off the calendar day alone, in every zone', () => {
    for (const zone of ZONES) {
      inZone(zone);
      expect(lockTimeOf('2027-03-14')).toBe(1_804_982_400);
      expect(dateOfLockTime(1_804_982_400)).toBe('2027-03-14');
      // Daylight saving days: Europe, then the USA, then New Zealand.
      for (const date of ['2027-03-28', '2027-10-31', '2027-03-14', '2027-11-07', '2027-04-04', '2027-09-26']) {
        const t = lockTimeOf(date) ?? 0;
        expect(t % 86_400).toBe(0);
        expect(dateOfLockTime(t)).toBe(date);
      }
    }
  });

  it('walks days without drifting over a daylight saving change', () => {
    for (const zone of ZONES) {
      inZone(zone);
      expect(addDays('2027-03-27', 1)).toBe('2027-03-28');
      expect(addDays('2027-03-28', 1)).toBe('2027-03-29');
      expect(addDays('2027-10-30', 2)).toBe('2027-11-01');
      expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    }
  });

  it('refuses what is not a date', () => {
    for (const bad of ['', '2027-02-30', '2027-13-01', '2027-3-14', '14/03/2027', '2027-03-14T00:00:00Z']) {
      expect(lockTimeOf(bad)).toBeNull();
    }
  });
});

describe('the true unlock moment', () => {
  const T = 1_804_982_400; // 2027-03-14 00:00 UTC

  it('shows the day before where it is still the evening before', () => {
    inZone('America/Los_Angeles');
    expect(new Date(T * 1000).getHours()).toBe(16);
    expect(unlockLocal(T, 'en-US')).toContain('March 13, 2027');
    expect(unlockUtc(T, 'en-US')).toBe('March 14, 2027');
  });

  it('shows the same day east of Greenwich', () => {
    inZone('Asia/Tokyo');
    expect(unlockLocal(T, 'en-US')).toContain('March 14, 2027');
    expect(unlockLocal(T, 'en-US')).toContain('9:00');
    expect(unlockUtc(T, 'fr-FR')).toBe('14 mars 2027');
  });
});

describe('what the form offers, against what Rust accepts', () => {
  // Rust: day(T) > day(now) in UTC.
  const rustAccepts = (date: string, now: Date) => (lockTimeOf(date) ?? 0) / 86_400 > Math.floor(now.getTime() / 86_400_000);

  it('never offers a date Rust refuses, at any hour, in any zone', () => {
    for (const zone of ZONES) {
      inZone(zone);
      for (let hour = 0; hour < 48; hour++) {
        const now = new Date(Date.UTC(2027, 2, 27, hour, 30));
        expect(rustAccepts(minLockDate(now), now)).toBe(true);
        for (const days of [7, 30, 90, 365]) expect(lockDateError(shortcutDate(now, days), now)).toBeNull();
      }
    }
  });

  it('counts from the local calendar, then keeps Rust happy', () => {
    inZone('Pacific/Auckland');
    const now = new Date(Date.UTC(2027, 5, 10, 20, 0)); // 8:00 the next day in Auckland
    expect(utcToday(now)).toBe('2027-06-10');
    expect(localToday(now)).toBe('2027-06-11');
    expect(minLockDate(now)).toBe('2027-06-12');
    expect(shortcutDate(now, 7)).toBe('2027-06-18');
    inZone('America/Los_Angeles');
    const evening = new Date(Date.UTC(2027, 5, 11, 2, 0)); // 19:00 the day before in Los Angeles
    expect(localToday(evening)).toBe('2027-06-10');
    expect(minLockDate(evening)).toBe('2027-06-12');
  });

  it('stops at ten years, and at what a descriptor can say', () => {
    inZone('UTC');
    const now = new Date(Date.UTC(2026, 10, 5, 12));
    expect(maxLockDate(now)).toBe('2036-11-05');
    expect(lockDateError('2036-11-05', now)).toBeNull();
    expect(lockDateError('2036-11-06', now)).toBe('tooFar');
    expect(lockDateError('2026-11-05', now)).toBe('tooSoon');
    expect(lockDateError('2026-11-06', now)).toBeNull();
    expect(lockDateError('nope', now)).toBe('invalid');
    const later = new Date(Date.UTC(2030, 0, 1));
    expect(maxLockDate(later)).toBe('2038-01-19');
    expect(lockTimeOf('2038-01-19')).toBeLessThan(2 ** 31);
    expect(lockTimeOf('2038-01-20')).toBeGreaterThan(2 ** 31);
  });
});

describe('Find my locks', () => {
  const steps = (answers: Array<{ nextDay: number | null; found?: number } | Error>) => {
    const asked: Array<number | null> = [];
    return {
      asked,
      step: async (fromDay: number | null) => {
        asked.push(fromDay);
        const a = answers.shift();
        if (!a) throw new Error('no more answers');
        if (a instanceof Error) throw a;
        return { nextDay: a.nextDay, firstDay: 100, lastDay: 399, found: a.found ?? 0 };
      },
    };
  };

  it('is finished only when the last stretch answered', async () => {
    const s = steps([{ nextDay: 200 }, { nextDay: 300, found: 1 }, { nextDay: null }]);
    const seen: LockScanProgress[] = [];
    const end = await runLockScan(s.step, lockScanStart, (p) => seen.push(p));
    expect(s.asked).toEqual([null, 200, 300]);
    expect(end.finished).toBe(true);
    expect(end.found).toBe(1);
    expect(end.reachedDay).toBe(399);
    expect(seen.slice(0, 2).every((p) => !p.finished)).toBe(true);
  });

  it('a server failing halfway is no result, says how far it got, and resumes there', async () => {
    const s = steps([{ nextDay: 200, found: 1 }, new Error('429')]);
    const stopped = await runLockScan(s.step, lockScanStart, () => undefined);
    expect(stopped.finished).toBe(false);
    expect(stopped.error).toBeInstanceOf(Error);
    expect(stopped.reachedDay).toBe(199);
    expect(stopped.found).toBe(1);
    const r = steps([{ nextDay: null, found: 1 }]);
    const end = await runLockScan(r.step, stopped, () => undefined);
    expect(r.asked).toEqual([200]);
    expect(end.finished).toBe(true);
    expect(end.found).toBe(2);
    expect(end.error).toBeNull();
  });

  it('failing at once says that nothing was checked', async () => {
    const end = await runLockScan(steps([new Error('down')]).step, lockScanStart, () => undefined);
    expect(end.reachedDay).toBeNull();
    expect(end.finished).toBe(false);
  });

  it('an inverted range is an error, not a success', async () => {
    const end = await runLockScan(async () => ({ nextDay: null, firstDay: 10, lastDay: 5, found: 0 }), lockScanStart, () => undefined);
    expect(end.finished).toBe(false);
    expect(end.error).toBeTruthy();
  });
});

describe('words and figures', () => {
  it('sends whole fee rates to Rust', () => {
    expect(lockFeeRate(3.9)).toBe(3);
    expect(lockFeeRate(1)).toBe(1);
    expect(lockFeeRate(1.2)).toBe(1);
    expect(lockFeeRate(0.5)).toBe(0);
    expect(lockFeeRate(Number.NaN)).toBe(0);
  });

  it('matches what Rust takes', () => {
    expect(confirmWord('fr')).toBe('BLOQUER');
    expect(confirmWord('en')).toBe('LOCK');
  });

  it('counts what is still held, not what left or never arrived', () => {
    expect(['confirming', 'locked', 'ready', 'unknown'].every((s) => isHeld(s as never))).toBe(true);
    expect(['withdrawn', 'notFound'].some((s) => isHeld(s as never))).toBe(false);
  });

  it('says the time left in two units', () => {
    const u = { d: 'j', h: 'h', m: 'min' };
    expect(lockTimeLeft(90 * 86_400 + 3 * 3_600, u)).toBe('90 j 3 h');
    expect(lockTimeLeft(86_400, u)).toBe('1 j');
    expect(lockTimeLeft(3_660, u)).toBe('1 h 1 min');
    expect(lockTimeLeft(30, u)).toBe('1 min');
    expect(lockTimeLeft(0, u)).toBe('0 min');
  });
});

describe('when a lock started', () => {
  it('prefers the funding block time and falls back to the history', () => {
    expect(lockStartMs(1_800_000_000, [1_700_000_000_000])).toBe(1_800_000_000_000);
    expect(lockStartMs(null, [1_800_000_500_000, 1_800_000_100_000])).toBe(1_800_000_100_000);
    expect(lockStartMs(undefined, [])).toBeNull();
    expect(lockStartMs(0, [Number.NaN])).toBeNull();
  });

  it('gives the elapsed part of the ring, clamped', () => {
    const start = 1_800_000_000_000;
    const t = 1_800_000_000 + 100 * 86_400;
    expect(lockElapsed(start, t, start + 25 * 86_400_000)).toBeCloseTo(0.25);
    expect(lockElapsed(start, t, start)).toBe(0.02);
    expect(lockElapsed(start, t, start + 200 * 86_400_000)).toBe(0.98);
    expect(lockElapsed(null, t, start)).toBeNull();
    expect(lockElapsed(t * 1000 + 1, t, start)).toBeNull();
  });
});
