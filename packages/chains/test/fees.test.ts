import { afterEach, describe, expect, it } from 'vitest';
import { setLang } from '@kyro/shared';
import {
  EVM_CUSTOM_MAX_FEE,
  evmCustomFeeCeiling,
  evmFeeOptionsFromHistory,
  feeCost,
  feeRateBounds,
  formatUnits,
  gweiToWei,
  medianBig,
  parseUnits,
  SOL_CUSTOM_MAX_MICRO,
  tryParseUnits,
  typicalSize,
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
    expect(() => parseUnits('0.0000001', 6)).toThrow(/décimales/i);
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
  it('refuses a max fee below the network base fee', () => {
    const v = validateEvmCustomFee({ maxFeeGwei: '3', priorityGwei: '1' }, est);
    expect(v.ok).toBe(false);
    expect(v.errors.join()).toMatch(/minimum du réseau/i);
    expect(validateEvmCustomFee({ maxFeeGwei: '4.2', priorityGwei: '1' }, est).ok).toBe(true);
  });
  it('refuses a max fee far above the live Fast level', () => {
    const ceiling = evmCustomFeeCeiling(est);
    expect(ceiling).toBe((est.options.fast.params as { maxFeePerGas: bigint }).maxFeePerGas * 20n);
    expect(validateEvmCustomFee({ maxFeeGwei: weiToGwei(ceiling), priorityGwei: '1' }, est).ok).toBe(true);
    expect(validateEvmCustomFee({ maxFeeGwei: weiToGwei(ceiling + 1n), priorityGwei: '1' }, est).ok).toBe(false);
  });
  it('keeps a usable range on a nearly free chain and an absolute limit everywhere', () => {
    const l2 = evmFeeOptionsFromHistory(10_000_000n, [[1n, 1n, 1n]], 2);
    expect(evmCustomFeeCeiling(l2)).toBe(100n * GWEI);
    const wild = evmFeeOptionsFromHistory(1_000_000n * GWEI, [[GWEI, GWEI, GWEI]], 12);
    expect(evmCustomFeeCeiling(wild)).toBe(EVM_CUSTOM_MAX_FEE);
    expect(evmCustomFeeCeiling()).toBe(EVM_CUSTOM_MAX_FEE);
    expect(validateEvmCustomFee({ maxFeeGwei: '10001', priorityGwei: '1' }).ok).toBe(false);
  });
});

describe('typicalSize', () => {
  it('prices the levels of chains with a fee market, and only those', () => {
    expect(feeCost({ family: 'btc', satPerVb: 10 }, typicalSize('btc', false)!)).toBe(1410n);
    expect(typicalSize('evm', true)).toEqual({ family: 'evm', gasLimit: 65_000n });
    for (const fixed of ['xrp', 'ada', 'zec', 'xmr', 'kas']) expect(typicalSize(fixed, false)).toBeNull();
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
  it('refuses a rate under the mempool minimum', () => {
    const v = validateBtcFeeRate('1', est);
    expect(v.ok).toBe(false);
    expect(v.errors.length).toBe(1);
    expect(validateBtcFeeRate('2', est).ok).toBe(true);
  });
  it('applies the bounds of each coin', () => {
    const doge = feeRateBounds('doge');
    expect(validateBtcFeeRate('999', undefined, doge).ok).toBe(false);
    expect(validateBtcFeeRate('100000', undefined, doge).ok).toBe(true);
    expect(validateBtcFeeRate('100001', undefined, doge).ok).toBe(false);
    expect(validateBtcFeeRate('2000').ok).toBe(true);
    expect(validateBtcFeeRate('2001').ok).toBe(false);
    expect(validateBtcFeeRate('101', undefined, feeRateBounds('dash')).ok).toBe(false);
  });
});

describe('validateSolPriorityFee', () => {
  it('requires an integer', () => {
    expect(validateSolPriorityFee('12.5').ok).toBe(false);
    expect(validateSolPriorityFee('5000').params).toEqual({ family: 'sol', microLamports: 5000n });
    expect(validateSolPriorityFee(SOL_CUSTOM_MAX_MICRO.toString()).ok).toBe(true);
    expect(validateSolPriorityFee((SOL_CUSTOM_MAX_MICRO + 1n).toString()).ok).toBe(false);
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

describe('fee messages follow the display language', () => {
  afterEach(() => setLang('fr'));
  it('French by default, English after setLang("en")', () => {
    expect(validateBtcFeeRate('5000').errors[0]).toBe('Taux absurde (> 2 000 sat/vB).');
    setLang('en');
    expect(validateBtcFeeRate('5000').errors[0]).toBe('Absurd rate (> 2,000 sat/vB).');
    expect(validateBtcFeeRate('0.5').errors[0]).toBe('Minimum 1 sat/vB (node relay rule).');
    expect(() => parseUnits('abc', 8)).toThrow('Invalid amount');
  });
});
