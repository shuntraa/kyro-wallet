import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setLanguage } from '../i18n';
import {
  MINUS,
  NNBSP,
  addressChunks,
  chunkAddress,
  fmtAgo,
  fmtCountdown,
  fmtCrypto,
  fmtEta,
  fmtFiat,
  fmtPct,
  sanitizeDecimalInput,
  shortAddress,
  splitFiat,
  toInputDecimal,
} from './format';
import { areaPath, downsample, fitSeries, smoothPath } from './smooth';
import { guardAllowsSend, guardOnInput, guardVerify, handedOverGuard, initialGuard, pickedGuard } from './clipboardGuard';
import { portfolioSeries, priceAt } from './portfolioSeries';
import { toCsv } from './csv';

describe('format: fiat & numbers (fr-FR)', () => {
  it('formats euros with narrow NBSP grouping and comma decimals', () => {
    expect(fmtFiat(12480.32, 'EUR')).toBe(`12${NNBSP}480,32${NNBSP}€`);
    expect(fmtFiat(-3.5, 'EUR')).toBe(`${MINUS}3,50${NNBSP}€`);
    expect(fmtFiat(291.14, 'EUR', { sign: true })).toBe(`+291,14${NNBSP}€`);
    expect(fmtFiat(1234.5, 'USD')).toBe(`1${NNBSP}234,50${NNBSP}$`);
  });
  it('splits fiat for faint decimals', () => {
    expect(splitFiat(12480.32, 'EUR')).toEqual({ int: `12${NNBSP}480`, rest: `,32${NNBSP}€` });
  });
  it('formats percentages with sign and U+2212', () => {
    expect(fmtPct(1.823)).toBe(`+1,82${NNBSP}%`);
    expect(fmtPct(-0.64)).toBe(`${MINUS}0,64${NNBSP}%`);
    expect(fmtPct(0.001)).toBe(`0,00${NNBSP}%`);
    expect(fmtPct(null)).toBe('—');
  });
});

describe('format: English (en-US)', () => {
  beforeAll(() => setLanguage('en'));
  afterAll(() => setLanguage('fr'));
  it('formats fiat, percentages and crypto the English way', () => {
    expect(fmtFiat(1234.56, 'EUR')).toBe('€1,234.56');
    expect(fmtFiat(1234.5, 'USD')).toBe('$1,234.50');
    expect(fmtFiat(-3.5, 'EUR')).toBe(`${MINUS}€3.50`);
    expect(splitFiat(12480.32, 'EUR')).toEqual({ int: '€12,480', rest: '.32' });
    expect(fmtPct(1.823)).toBe('+1.82%');
    expect(fmtPct(-0.64)).toBe(`${MINUS}0.64%`);
    expect(fmtCrypto(1_234_567_890_000n, 6)).toBe('1,234,567.89');
    expect(fmtCrypto(9_780_000n, 8, 'BTC')).toBe(`0.0978${NNBSP}BTC`);
  });
  it('edits decimals with a dot, accepting a comma while typing', () => {
    expect(sanitizeDecimalInput('0,5', 8)).toBe('0.5');
    expect(sanitizeDecimalInput('1,234.56', 8)).toBe('1234.56');
    expect(toInputDecimal(25_000_000n, 8)).toBe('0.25');
    expect(fmtAgo(Date.now() - 180_000)).toBe('3 min ago');
  });
});

describe('format: crypto amounts (bigint, truncated)', () => {
  it('uses adaptive precision', () => {
    expect(fmtCrypto(1_604_200_000_000_000_000n, 18, 'ETH')).toBe(`1,6042${NNBSP}ETH`);
    expect(fmtCrypto(9_780_000n, 8, 'BTC')).toBe(`0,0978${NNBSP}BTC`);
    expect(fmtCrypto(812_400_000n, 6)).toBe('812,4');
    expect(fmtCrypto(1_234_567_890_000n, 6)).toBe(`1${NNBSP}234${NNBSP}567,89`);
  });
  it('never rounds up', () => {
    expect(fmtCrypto(19_999n, 4, undefined, 2)).toBe('1,99');
  });
  it('shows significant digits for dust and handles zero / negatives', () => {
    expect(fmtCrypto(168_000_000_000_000n, 18)).toBe('0,000168');
    expect(fmtCrypto(5n, 18)).toBe('0,000000000000000005');
    expect(fmtCrypto(0n, 8)).toBe('0');
    expect(fmtCrypto(-25_000_000n, 8)).toBe(`${MINUS}0,25`);
  });
});

describe('format: address chunking', () => {
  const evm = '0x4F2a9C83b1E07d6A55c0e91B3d7F28aE6c19D7b2';
  it('keeps 0x on the first 4-char block', () => {
    expect(chunkAddress(evm)).toEqual(['0x4F2a', '9C83', 'b1E0', '7d6A', '55c0', 'e91B', '3d7F', '28aE', '6c19', 'D7b2']);
  });
  it('highlights first two and last two blocks', () => {
    const c = addressChunks(evm);
    expect(c.filter((x) => x.highlight).map((x) => x.text)).toEqual(['0x4F2a', '9C83', '6c19', 'D7b2']);
    expect(c).toHaveLength(10);
  });
  it('chunks bech32 without prefix handling and keeps a short last block', () => {
    const btc = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
    const c = chunkAddress(btc);
    expect(c.join('')).toBe(btc);
    expect(c[0]).toBe('tb1q');
    expect(c.every((x) => x.length <= 4)).toBe(true);
  });
  it('shortens addresses', () => {
    expect(shortAddress('0x9a3E7B12f0C49e8A2D61b5F033aC8E27d90Bc41D')).toBe('0x9a3E…c41D');
  });
});

describe('format: misc', () => {
  it('countdown and ETA', () => {
    expect(fmtCountdown(702)).toBe('11:42');
    expect(fmtCountdown(3723)).toBe('1:02:03');
    expect(fmtEta(30)).toBe('< 1 min');
    expect(fmtEta(180)).toBe('≈ 3 min');
  });
  it('sanitises decimal input', () => {
    expect(sanitizeDecimalInput('0.25', 18)).toBe('0,25');
    expect(sanitizeDecimalInput('1,2,3', 18)).toBe('1,23');
    expect(sanitizeDecimalInput('00012', 8)).toBe('12');
    expect(sanitizeDecimalInput('1,123456789', 6)).toBe('1,123456');
    expect(sanitizeDecimalInput('abc', 6)).toBe('');
    // Pasted amounts with thousands grouping: the last separator is the decimal mark.
    expect(sanitizeDecimalInput('1,234.56', 6)).toBe('1234,56');
    expect(sanitizeDecimalInput('1.234,56', 6)).toBe('1234,56');
    expect(sanitizeDecimalInput('12,345,678.9', 6)).toBe('12345678,9');
    expect(sanitizeDecimalInput('1 234,56', 6)).toBe('1234,56');
    // A stray key while typing never multiplies the amount.
    expect(sanitizeDecimalInput('0,5.', 6)).toBe('0,5');
    expect(sanitizeDecimalInput('0,5.3', 6)).toBe('0,53');
    expect(toInputDecimal(250_000_000_000_000_000n, 18)).toBe('0,25');
  });
  it('CSV escaping', () => {
    expect(toCsv([['a;b', 'c"d', 1]])).toBe('"a;b";"c""d";1\r\n');
  });
});

describe('smooth path (Catmull-Rom → Bézier)', () => {
  it('passes through every point with one cubic per segment', () => {
    const pts = [{ x: 0, y: 10 }, { x: 10, y: 0 }, { x: 20, y: 5 }, { x: 30, y: 2 }];
    const d = smoothPath(pts);
    expect(d.startsWith('M0,10')).toBe(true);
    expect(d.match(/C/g)).toHaveLength(3);
    for (const p of pts.slice(1)) expect(d).toContain(` ${p.x},${p.y}`);
  });
  it('computes the classic control points', () => {
    const d = smoothPath([{ x: 0, y: 0 }, { x: 6, y: 6 }, { x: 12, y: 0 }], { clamp: false });
    // p0 duplicated at the start: c1 = p1 + (p2 − p0)/6 = (1,1); c2 = p2 − (p3 − p1)/6 = (6 − 2, 6 − 0) = (4,6)
    expect(d).toBe('M0,0 C1,1 4,6 6,6 C8,6 11,1 12,0');
  });
  it('clamps control points inside the data range (no overshoot)', () => {
    const d = smoothPath([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 10 }, { x: 30, y: 10 }]);
    const ys = [...d.matchAll(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g)].map((m) => Number(m[2]));
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...ys)).toBeLessThanOrEqual(10);
  });
  it('handles degenerate input', () => {
    expect(smoothPath([])).toBe('');
    expect(smoothPath([{ x: 1, y: 2 }])).toBe('M1,2');
    expect(smoothPath([{ x: 0, y: NaN }, { x: 1, y: 1 }])).toBe('M1,1');
  });
  it('fits a series in a box; flat series are centred', () => {
    const pts = fitSeries([1, 2, 3], { width: 100, height: 50, padTop: 10, padBottom: 0 });
    expect(pts.map((p) => p.x)).toEqual([0, 50, 100]);
    expect(pts[0]?.y).toBe(50);
    expect(pts[2]?.y).toBe(10);
    expect(fitSeries([5, 5], { width: 10, height: 20 }).map((p) => p.y)).toEqual([10, 10]);
    expect(areaPath('M0,0 C1,1 2,2 3,3', [{ x: 0, y: 0 }, { x: 3, y: 3 }], 20)).toBe('M0,0 C1,1 2,2 3,3 L3,20 L0,20 Z');
  });
  it('downsamples but keeps endpoints', () => {
    const v = Array.from({ length: 1000 }, (_, i) => i);
    const d = downsample(v, 100);
    expect(d).toHaveLength(100);
    expect(d[0]).toBe(0);
    expect(d[99]).toBe(999);
  });
});

describe('clipboard guard', () => {
  const addr = '0x4F2a9C83b1E07d6A55c0e91B3d7F28aE6c19D7b2';
  it('accepts a paste and keeps it while unchanged', () => {
    const s = guardOnInput(initialGuard, addr, 'insertFromPaste');
    expect(s).toEqual({ pasted: addr, tampered: false, source: 'paste' });
    expect(guardAllowsSend(guardVerify(s, addr, addr), true)).toBe(true);
  });
  it('blocks when the field changes without typing', () => {
    let s = guardOnInput(initialGuard, addr, 'insertFromPaste');
    s = guardOnInput(s, '0xBAD0000000000000000000000000000000000000', undefined);
    expect(s.tampered).toBe(true);
    expect(guardAllowsSend(s, true)).toBe(false);
    expect(guardAllowsSend(s, false)).toBe(true);
  });
  it('blocks when the DOM value no longer matches the paste', () => {
    const s = guardOnInput(initialGuard, addr, 'insertFromPaste');
    expect(guardVerify(s, addr.replace('D7b2', 'D7b3'), addr).tampered).toBe(true);
  });
  it('typing by hand disarms the guard', () => {
    let s = guardOnInput(initialGuard, addr, 'insertFromPaste');
    s = guardOnInput(s, addr.slice(0, -1), 'deleteContentBackward');
    expect(s).toEqual({ pasted: null, tampered: false, source: 'typed' });
    expect(guardOnInput(s, '', 'deleteContentBackward')).toEqual(initialGuard);
  });
  it('an address picked from Kyro\'s lists is watched like a paste, a handed-over one is « typed »', () => {
    const picked = pickedGuard(addr);
    expect(picked.source).toBe('picked');
    expect(guardOnInput(picked, '0xBAD0000000000000000000000000000000000000', undefined).tampered).toBe(true);
    // The search palette's address: origin unknown, never shown as pasted.
    expect(handedOverGuard).toEqual({ pasted: null, tampered: false, source: 'typed' });
  });
});

describe('portfolio series', () => {
  it('values current holdings at historical prices', () => {
    const charts = {
      bitcoin: [[0, 100], [10, 110], [20, 120]] as Array<[number, number]>,
      ethereum: [[0, 10], [20, 20]] as Array<[number, number]>,
    };
    const s = portfolioSeries([{ coinId: 'bitcoin', units: 2, currentPrice: 120 }, { coinId: 'ethereum', units: 1, currentPrice: 20 }, { coinId: 'usd-coin', units: 5, currentPrice: 1 }], charts);
    expect(s).toEqual([[0, 215], [10, 235], [20, 265]]);
    expect(priceAt(charts.ethereum, 15)).toBe(10);
    expect(priceAt([], 1)).toBeNull();
  });
});
