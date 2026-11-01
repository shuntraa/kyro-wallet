import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIAT_CURRENCIES } from '@kyro/shared';
import { setLanguage } from '../i18n';
import { compactFiat } from '../components/AssetLists';
import { NNBSP, fiatDigits, fiatSymbol, fmtFiat, splitFiat } from './format';

describe('fiat currencies', () => {
  beforeAll(() => setLanguage('en'));
  afterAll(() => setLanguage('fr'));

  it('formats every offered currency with its own decimals and symbol', () => {
    for (const c of FIAT_CURRENCIES) {
      const s = fmtFiat(1234.5, c);
      expect(s, c).not.toMatch(/NaN/);
      expect(fiatSymbol(c).length, c).toBeGreaterThan(0);
      expect(fiatDigits(c), c).toBe(c === 'JPY' || c === 'KRW' ? 0 : 2);
    }
  });

  it('shows no decimals for JPY / KRW, except for tiny values', () => {
    expect(fmtFiat(12480.32, 'JPY')).toBe('¥12,480');
    expect(fmtFiat(12480.32, 'JPY', { decimals: 2 })).toBe('¥12,480');
    expect(fmtFiat(0.37, 'JPY')).toBe('¥0.37');
    expect(fmtFiat(1500, 'KRW')).toBe('₩1,500');
    expect(splitFiat(12480.32, 'JPY')).toEqual({ int: '¥12,480', rest: '' });
    expect(fmtFiat(0.004, 'EUR')).toBe('€0.0040');
    expect(fmtFiat(1234.5, 'GBP')).toBe('£1,234.50');
  });

  it('compacts market caps with the right symbol', () => {
    expect(compactFiat(2.5e9, 'GBP')).toBe('£2.5B');
    expect(compactFiat(2.5e9, 'CHF')).toBe(`CHF${NNBSP}2.5B`);
    setLanguage('fr');
    expect(compactFiat(2.5e9, 'EUR')).toBe(`2,5${NNBSP}Md€`);
    setLanguage('en');
  });
});
