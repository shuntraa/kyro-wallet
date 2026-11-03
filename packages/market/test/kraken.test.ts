import { describe, expect, it } from 'vitest';
import { krakenPair, mergeLongHistory, parseKrakenOhlc } from '../src/kraken';

describe('Kraken long history', () => {
  it('maps CoinGecko ids to Kraken pairs, none for unlisted coins', () => {
    expect(krakenPair('bitcoin')).toBe('XBTUSD');
    expect(krakenPair('dogecoin')).toBe('XDGUSD');
    expect(krakenPair('kaspa')).toBeNull();
    expect(krakenPair('toString')).toBeNull();
  });

  it('parses OHLC closes, whatever the result key', () => {
    const raw = { error: [], result: { XXBTZUSD: [[1381017600, '120', '130', '110', '125.5', '0', '1', 3], ['bad']], last: 1 } };
    expect(parseKrakenOhlc(raw)).toEqual([[1381017600000, 125.5]]);
    expect(parseKrakenOhlc({ error: ['EQuery:Unknown asset pair'] })).toEqual([]);
  });

  it('joins the long series before the recent one, scaled at the junction', () => {
    const long: Array<[number, number]> = [[1, 10], [2, 20], [3, 40], [5, 50]];
    const recent: Array<[number, number]> = [[4, 36], [6, 45]];
    expect(mergeLongHistory(long, recent)).toEqual([[1, 9], [2, 18], [3, 36], [4, 36], [6, 45]]);
    expect(mergeLongHistory([], recent)).toEqual(recent);
  });
});
