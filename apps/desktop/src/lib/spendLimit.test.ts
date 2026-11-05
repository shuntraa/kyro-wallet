import { describe, expect, it } from 'vitest';
import type { SpendLimitConfig } from '@kyro/shared';
import { changeTiming, fmtTimeLeft, overrideStep, parseLimitAmount, readExceeded, usedShare, WAIT_DAY, WAIT_HOUR } from './spendLimit';

const cfg = (amount: number, waitSecs = WAIT_DAY, currency: SpendLimitConfig['currency'] = 'EUR'): SpendLimitConfig => ({ amount, currency, waitSecs });

describe('overrideStep', () => {
  it('follows the phases Rust reports', () => {
    expect(overrideStep({ override: null })).toBe('request');
    expect(overrideStep({ override: { phase: 'waiting', secsLeft: 10 } })).toBe('waiting');
    expect(overrideStep({ override: { phase: 'ready', secsLeft: 0 } })).toBe('confirm');
    expect(overrideStep({ override: { phase: 'open', secsLeft: 10 } })).toBe('open');
  });
});

describe('changeTiming', () => {
  it('turning on and tightening apply now', () => {
    expect(changeTiming(null, cfg(100))).toBe('now');
    expect(changeTiming(cfg(100), cfg(50))).toBe('now');
    expect(changeTiming(cfg(100), cfg(100))).toBe('now');
    expect(changeTiming(cfg(100, WAIT_HOUR), cfg(100, WAIT_DAY))).toBe('now');
  });
  it('raising, disabling, a shorter wait or a new currency wait', () => {
    expect(changeTiming(cfg(100), cfg(101))).toBe('wait');
    expect(changeTiming(cfg(100), null)).toBe('wait');
    expect(changeTiming(cfg(100, WAIT_DAY), cfg(50, WAIT_HOUR))).toBe('wait');
    expect(changeTiming(cfg(100), cfg(50, WAIT_DAY, 'USD'))).toBe('wait');
  });
});

describe('parseLimitAmount', () => {
  it('takes positive amounts, with a comma too', () => {
    expect(parseLimitAmount('250')).toBe(250);
    expect(parseLimitAmount('12,5')).toBe(12.5);
  });
  it('refuses the rest', () => {
    for (const bad of ['', ' ', '0', '-5', 'abc', 'Infinity', '1e16']) expect(parseLimitAmount(bad)).toBeNull();
  });
});

describe('fmtTimeLeft', () => {
  it('rounds up so it never promises less than what is left', () => {
    expect(fmtTimeLeft(0)).toBe('0 min');
    expect(fmtTimeLeft(30)).toBe('< 1 min');
    expect(fmtTimeLeft(61)).toBe('2 min');
    expect(fmtTimeLeft(3600)).toBe('1 h 00 min');
    expect(fmtTimeLeft(86_399)).toBe('24 h 00 min');
    expect(fmtTimeLeft(7_500)).toBe('2 h 05 min');
  });
});

describe('usedShare', () => {
  it('stays between 0 and 1', () => {
    expect(usedShare(50, 100)).toBe(0.5);
    expect(usedShare(500, 100)).toBe(1);
    expect(usedShare(0, 0)).toBe(1);
  });
});

describe('readExceeded', () => {
  it('reads the error data', () => {
    expect(readExceeded({ spent: 90, limit: 100, amount: 20, currency: 'USD' }, 'EUR')).toEqual({ spent: 90, limit: 100, amount: 20, currency: 'USD' });
  });
  it('an unknown value stays unknown', () => {
    expect(readExceeded({ spent: 1, limit: 100, amount: null, currency: 'USD' }, 'EUR').amount).toBeNull();
    expect(readExceeded(undefined, 'EUR')).toEqual({ spent: 0, limit: 0, amount: null, currency: 'EUR' });
  });
});
