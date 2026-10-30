import { describe, expect, it } from 'vitest';
import { DUST_SATS, InsufficientFundsError, estimateVsize, outputTypeOf, selectAll, selectCoins, type SelectableUtxo } from '../src';

const u = (value: number, type: SelectableUtxo['type'] = 'p2wpkh', i = 0): SelectableUtxo => ({ txid: `tx${value}-${i}`, vout: 0, value: BigInt(value), type });

describe('outputTypeOf', () => {
  it('detects script types from addresses', () => {
    expect(outputTypeOf('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx')).toBe('p2wpkh');
    expect(outputTypeOf('bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3')).toBe('p2wsh');
    expect(outputTypeOf('bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297')).toBe('p2tr');
    expect(outputTypeOf('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy')).toBe('p2sh');
    expect(outputTypeOf('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2')).toBe('p2pkh');
  });
});

describe('estimateVsize', () => {
  it('matches the classic 1-in 2-out P2WPKH size (≈141 vB)', () => {
    expect(estimateVsize(['p2wpkh'], ['p2wpkh', 'p2wpkh'])).toBe(141);
  });
  it('accounts for taproot inputs', () => {
    expect(estimateVsize(['p2tr'], ['p2tr'])).toBe(Math.ceil(10.5 + 57.5 + 43));
  });
});

describe('selectCoins (largest-first)', () => {
  it('picks the largest UTXO first and returns change', () => {
    const s = selectCoins([u(10_000), u(500_000), u(80_000)], 100_000n, 2, 'p2wpkh');
    expect(s.inputs.map((i) => i.value)).toEqual([500_000n]);
    expect(s.fee).toBe(BigInt(Math.ceil(141 * 2)));
    expect(s.change).toBe(500_000n - 100_000n - s.fee);
    expect(s.amount).toBe(100_000n);
  });

  it('adds inputs until the target + fee is covered', () => {
    const s = selectCoins([u(60_000), u(50_000), u(40_000)], 100_000n, 1, 'p2wpkh');
    expect(s.inputs.map((i) => i.value)).toEqual([60_000n, 50_000n]);
    expect(s.amount + s.change + s.fee).toBe(110_000n);
  });

  it('drops dust change into the fee', () => {
    // 1 in / 1 out at 1 sat/vB = 110 vB → leftover 300 sats < dust
    const s = selectCoins([u(100_410)], 100_000n, 1, 'p2wpkh');
    expect(s.change).toBe(0n);
    expect(s.fee).toBe(410n);
    expect(s.amount).toBe(100_000n);
  });

  it('conserves value: inputs = amount + change + fee', () => {
    const utxos = [u(123_456), u(98_765), u(55_555, 'p2tr'), u(1_000_000, 'p2tr')];
    const s = selectCoins(utxos, 777_777n, 7.5, 'p2tr');
    const total = s.inputs.reduce((a, i) => a + i.value, 0n);
    expect(total).toBe(s.amount + s.change + s.fee);
    expect(s.change === 0n || s.change >= DUST_SATS).toBe(true);
  });

  it('throws InsufficientFundsError with the shortfall', () => {
    try {
      selectCoins([u(1_000), u(2_000)], 50_000n, 1, 'p2wpkh');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(InsufficientFundsError);
      expect((e as InsufficientFundsError).available).toBe(3_000n);
    }
  });

  it('refuses dust amounts', () => {
    expect(() => selectCoins([u(100_000)], 100n, 1, 'p2wpkh')).toThrow(/poussière/);
  });
});

describe('selectAll (MAX)', () => {
  it('sweeps every UTXO with no change', () => {
    const s = selectAll([u(10_000), u(20_000, 'p2tr')], 2, 'p2wpkh');
    expect(s.change).toBe(0n);
    expect(s.inputs).toHaveLength(2);
    expect(s.amount + s.fee).toBe(30_000n);
  });
  it('fails when fees eat everything', () => {
    expect(() => selectAll([u(600)], 10, 'p2wpkh')).toThrow(InsufficientFundsError);
  });
});
