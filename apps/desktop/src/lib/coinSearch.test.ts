import { describe, expect, it } from 'vitest';
import { findAsset } from '@kyro/chains';
import { coinSearch } from './coinSearch';

describe('title-bar coin search', () => {
  const btc = findAsset('mainnet', 'btc');
  const markets = [
    { id: 'bitcoin', name: 'Bitcoin', symbol: 'BTC', rank: 1 },
    { id: 'wrapped-bitcoin', name: 'Wrapped Bitcoin', symbol: 'WBTC', rank: 20 },
  ];

  it('one row per coin: a held coin is not listed again from the market list, held first', () => {
    if (!btc) throw new Error('no btc asset');
    const r = coinSearch('btc', [{ asset: btc, units: 0.5 }], markets);
    expect(r.map((x) => x.id)).toEqual(['btc', 'cg:wrapped-bitcoin']);
    expect(r[0]).toMatchObject({ units: 0.5, rank: 1 });
    expect(r[1]).toMatchObject({ units: null, rank: 20 });
  });

  it('not held: the market row with its rank', () => {
    expect(coinSearch('bitcoin', [], markets)[0]).toMatchObject({ id: 'cg:bitcoin', units: null, rank: 1 });
  });
});
