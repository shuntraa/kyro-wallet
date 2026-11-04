import { describe, expect, it } from 'vitest';
import { krakenPair, mergeLongHistory, parseKrakenOhlc } from '../src/kraken';

describe('Kraken long history', () => {
  it('maps CoinGecko ids to Kraken pairs, none for unlisted coins', () => {
    expect(krakenPair('bitcoin')).toBe('XBTUSD');
    expect(krakenPair('dogecoin')).toBe('XDGUSD');
    expect(krakenPair('kaspa')).toBeNull();
    expect(krakenPair('toString')).toBeNull();
  });

  it('parses OHLC opens (the price at the candle time), whatever the result key', () => {
    const raw = { error: [], result: { XXBTZUSD: [[1381017600, '120', '130', '110', '125.5', '0', '1', 3], ['bad']], last: 1 } };
    expect(parseKrakenOhlc(raw)).toEqual([[1381017600000, 120]]);
    expect(parseKrakenOhlc({ error: ['EQuery:Unknown asset pair'] })).toEqual([]);
  });

  it('joins the long series before the recent one, scaled at the junction', () => {
    const long: Array<[number, number]> = [[1, 10], [2, 20], [3, 40], [5, 50]];
    const recent: Array<[number, number]> = [[4, 36], [6, 45]];
    // The long price at t = 4 is 45 (between 40 and 50): the ratio is 0.8.
    expect(mergeLongHistory(long, recent)).toEqual([[1, 8], [2, 16], [3, 32], [4, 36], [6, 45]]);
    expect(mergeLongHistory([], recent)).toEqual(recent);
  });

  it('keeps USD history at its real price, whatever the day of the junction', () => {
    const long: Array<[number, number]> = [[0, 100], [7, 200], [14, 300]];
    const at10 = 200 + (100 * 3) / 7;
    const out = mergeLongHistory(long, [[10, at10], [20, 400]]);
    expect(out[0]?.[1]).toBeCloseTo(100, 6);
    expect(out[1]?.[1]).toBeCloseTo(200, 6);
    expect(out.map((p) => p[0])).toEqual([0, 7, 10, 20]);
  });

  it('shows the recent series alone when the long one does not reach before it', () => {
    expect(mergeLongHistory([[9, 1]], [[4, 36]])).toEqual([[4, 36]]);
    expect(mergeLongHistory([[1, 1]], [])).toEqual([]);
  });
});
