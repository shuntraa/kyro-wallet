import { describe, expect, it } from 'vitest';
import {
  evmFeeOptionsFromHistory,
  feeCost,
  formatUnits,
  gweiToWei,
  medianBig,
  parseUnits,
  tryParseUnits,
  validateBtcFeeRate,
  validateEvmCustomFee,
  validateSolPriorityFee,
  weiToGwei,
} from '../src';

const GWEI = 1_000_000_000n;

describe('units', () => {
  it('parses French and English decimals exactly', () => {
    expect(parseUnits('0,25', 18)).toBe(250_000_000_000_000_000n);
    expect(parseUnits('1.5', 6)).toBe(1_500_000n);
    expect(parseUnits(' 12 ', 8)).toBe(1_200_000_000n);
    expect(parseUnits('.5', 2)).toBe(50n);
  });
  it('rejects garbage and too many decimals', () => {
    expect(() => parseUnits('1,2,3', 6)).toThrow();
    expect(() => parseUnits('abc', 6)).toThrow();
    expect(() => parseUnits('0.0000001', 6)).toThrow(/décimales/);
    expect(tryParseUnits('', 6)).toBeNull();
  });
  it('formats without floats', () => {
    expect(formatUnits(1_604_200_000_000_000_000n, 18)).toBe('1.6042');
    expect(formatUnits(5n, 8)).toBe('0.00000005');
    expect(formatUnits(-1_000_000n, 6)).toBe('-1');
  });
});

describe('gwei ↔ wei', () => {
  it('converts integers and decimals', () => {
    expect(gweiToWei('8')).toBe(8n * GWEI);
    expect(gweiToWei('1,5')).toBe(1_500_000_000n);
    expect(gweiToWei('0.000000001')).toBe(1n);
    expect(weiToGwei(4_200_000_000n)).toBe('4.2');
  });
  it('rejects sub-wei precision', () => {
    expect(() => gweiToWei('0.0000000001')).toThrow();
  });
});

describe('feeCost', () => {
  it('EVM: gasLimit × maxFeePerGas', () => {
    expect(feeCost({ family: 'evm', maxFeePerGas: 8n * GWEI, maxPriorityFeePerGas: GWEI }, { family: 'evm', gasLimit: 21_000n })).toBe(168_000_000_000_000n);
  });
  it('BTC: ceil(vsize × rate)', () => {
    expect(feeCost({ family: 'btc', satPerVb: 2.5 }, { family: 'btc', vsize: 141 })).toBe(353n);
  });
  it('Solana: base fee + ceil(µL × CU / 1e6)', () => {
    expect(feeCost({ family: 'sol', microLamports: 10_000n }, { family: 'sol', computeUnits: 600, signatures: 1 })).toBe(5006n);
    expect(feeCost({ family: 'sol', microLamports: 0n }, { family: 'sol', computeUnits: 600, signatures: 1 })).toBe(5000n);
  });
  it('refuses mismatched families', () => {
    expect(() => feeCost({ family: 'btc', satPerVb: 1 }, { family: 'evm', gasLimit: 1n })).toThrow();
  });
});

describe('validateEvmCustomFee', () => {
  const est = evmFeeOptionsFromHistory(4_200_000_000n, [[GWEI, 2n * GWEI, 3n * GWEI]], 12);
  it('accepts a sane custom fee and returns wei params', () => {
    const v = validateEvmCustomFee({ maxFeeGwei: '8', priorityGwei: '1,5' }, est);
    expect(v.ok).toBe(true);
    expect(v.params).toEqual({ family: 'evm', maxFeePerGas: 8n * GWEI, maxPriorityFeePerGas: 1_500_000_000n });
    expect(v.warnings).toEqual([]);
  });
  it('blocks a tip above the max fee', () => {
    const v = validateEvmCustomFee({ maxFeeGwei: '2', priorityGwei: '3' }, est);
    expect(v.ok).toBe(false);
    expect(v.errors.join()).toMatch(/pourboire/i);
  });
  it('blocks zero / invalid values', () => {
    expect(validateEvmCustomFee({ maxFeeGwei: '0', priorityGwei: '0' }).ok).toBe(false);
    expect(validateEvmCustomFee({ maxFeeGwei: 'x', priorityGwei: '1' }).ok).toBe(false);
  });
  it('warns below the network base fee', () => {
    const v = validateEvmCustomFee({ maxFeeGwei: '3', priorityGwei: '1' }, est);
    expect(v.ok).toBe(true);
    expect(v.warnings.join()).toMatch(/minimum du réseau/);
  });
});

describe('validateBtcFeeRate', () => {
  const est = { minimum: { family: 'btc' as const, satPerVb: 2 } };
  it('accepts decimals with comma', () => {
    expect(validateBtcFeeRate('3,5', est).params).toEqual({ family: 'btc', satPerVb: 3.5 });
  });
  it('blocks < 1 sat/vB and absurd rates', () => {
    expect(validateBtcFeeRate('0.5').ok).toBe(false);
    expect(validateBtcFeeRate('5000').ok).toBe(false);
    expect(validateBtcFeeRate('abc').ok).toBe(false);
  });
  it('warns under the mempool minimum', () => {
    const v = validateBtcFeeRate('1', est);
    expect(v.ok).toBe(true);
    expect(v.warnings.length).toBe(1);
  });
});

describe('validateSolPriorityFee', () => {
  it('requires an integer', () => {
    expect(validateSolPriorityFee('12.5').ok).toBe(false);
    expect(validateSolPriorityFee('5000').params).toEqual({ family: 'sol', microLamports: 5000n });
  });
});

describe('evmFeeOptionsFromHistory', () => {
  it('orders slow < normal < fast and keeps base fee as minimum', () => {
    const rewards = [
      [1n * GWEI, 2n * GWEI, 5n * GWEI],
      [1n * GWEI, 3n * GWEI, 4n * GWEI],
      [2n * GWEI, 2n * GWEI, 6n * GWEI],
    ];
    const e = evmFeeOptionsFromHistory(10n * GWEI, rewards, 12);
    const f = (l: 'slow' | 'normal' | 'fast') => e.options[l].params as { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
    expect(f('slow').maxPriorityFeePerGas).toBe(1n * GWEI);
    expect(f('normal').maxPriorityFeePerGas).toBe(2n * GWEI);
    expect(f('fast').maxPriorityFeePerGas).toBe(5n * GWEI);
    expect(f('slow').maxFeePerGas).toBe(12_500_000_000n + GWEI);
    expect(f('fast').maxFeePerGas).toBe(20n * GWEI + 5n * GWEI);
    expect(f('slow').maxFeePerGas < f('normal').maxFeePerGas && f('normal').maxFeePerGas < f('fast').maxFeePerGas).toBe(true);
    expect(e.minimum).toEqual({ family: 'evm', maxFeePerGas: 10n * GWEI, maxPriorityFeePerGas: 0n });
    expect(e.hint).toBe('10 gwei');
  });
  it('caps tips an RPC inflates: fast ≤ 3 × normal ≤ 9 × slow, all ≤ 3 × base fee + 2 gwei', () => {
    const tip = (e: ReturnType<typeof evmFeeOptionsFromHistory>, l: 'slow' | 'normal' | 'fast') => (e.options[l].params as { maxPriorityFeePerGas: bigint }).maxPriorityFeePerGas;
    const e = evmFeeOptionsFromHistory(10n * GWEI, [[1n * GWEI, 2n * GWEI, 500n * GWEI]], 12);
    expect(tip(e, 'fast')).toBe(6n * GWEI);
    const n = evmFeeOptionsFromHistory(10n * GWEI, [[1n * GWEI, 40n * GWEI, 80n * GWEI]], 12);
    expect(tip(n, 'normal')).toBe(3n * GWEI);
    // L2 with a tiny base fee: a « 100 gwei » tip is cut to 3 × base + 2 gwei.
    const l2 = evmFeeOptionsFromHistory(10_000_000n, [[0n, 0n, 100n * GWEI]], 0.25);
    expect(tip(l2, 'fast')).toBe(2_030_000_000n);
  });
  it('median helper', () => {
    expect(medianBig([3n, 1n, 2n])).toBe(2n);
    expect(medianBig([])).toBe(0n);
  });
});
