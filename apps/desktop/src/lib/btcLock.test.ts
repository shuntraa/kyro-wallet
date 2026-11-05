// A lock's date must not move with the computer's time zone: these tests run under several.
import { afterEach, describe, expect, it } from 'vitest';
import { addDays, confirmWord, dateOfLockTime, isHeld, localToday, lockDateError, lockTimeLeft, lockTimeOf, maxLockDate, minLockDate, shortcutDate, unlockLocal, unlockUtc, utcToday } from './btcLock';

const ZONES = ['UTC', 'Europe/Paris', 'America/Los_Angeles', 'Asia/Tokyo', 'Pacific/Auckland', 'Pacific/Kiritimati', 'Pacific/Pago_Pago'];
const original = process.env.TZ;

function inZone(zone: string) {
  process.env.TZ = zone;
}

afterEach(() => {
  if (original === undefined) delete process.env.TZ;
  else process.env.TZ = original;
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

describe('words and figures', () => {
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
