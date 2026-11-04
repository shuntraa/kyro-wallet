import { describe, expect, it } from 'vitest';
import type { ReceivedToken } from '@kyro/shared';
import { splitTokens, tokenAmount } from './ReceivedTokens';

const line = (over: Partial<ReceivedToken>): ReceivedToken => ({ id: 'x', symbol: null, decimals: null, amount: '0', known: false, nfts: 0, ...over });

describe('received tokens', () => {
  it('shows raw units unless Rust gave the decimals', () => {
    expect(tokenAmount(line({ amount: '4012524291' }), 'raw units', 'NFT')).toBe('4012524291 raw units');
    expect(tokenAmount(line({ amount: '1500000', decimals: 6, symbol: 'DEEP', known: true }), 'raw units', 'NFT')).toMatch(/^1[.,]5\s*DEEP$/);
  });

  it('counts NFTs, without a zero amount next to them', () => {
    expect(tokenAmount(line({ nfts: 2 }), 'raw units', 'NFT')).toBe('2 NFT');
    expect(tokenAmount(line({ amount: '42', nfts: 1 }), 'raw units', 'NFT')).toBe('42 raw units · 1 NFT');
  });

  it('keeps what Kyro cannot name apart', () => {
    const { known, unknown } = splitTokens([line({ id: 'a', known: true }), line({ id: 'b', symbol: 'USDC' })]);
    expect(known.map((x) => x.id)).toEqual(['a']);
    expect(unknown.map((x) => x.id)).toEqual(['b']);
  });
});
