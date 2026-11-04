import { describe, expect, it } from 'vitest';
import { canReplace, evmMinReplacementFee, evmReplacementFees, extraCost, isRbfSignaled, planCancel, planSpeedUp, rbfMinFee, ReplaceRefused, RBF_SEQUENCE } from '../src';

const pay = { value: 60_000n, own: false, dust: 294n };
const change = (value: bigint) => ({ value, own: true, dust: 294n });

const refusal = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    if (e instanceof ReplaceRefused) return e.reason;
    throw e;
  }
  return 'none';
};

describe('BIP125 fees', () => {
  it('reads the signal', () => {
    expect(isRbfSignaled([RBF_SEQUENCE])).toBe(true);
    expect(isRbfSignaled([0xffffffff, RBF_SEQUENCE])).toBe(true);
    expect(isRbfSignaled([0xffffffff, 0xfffffffe])).toBe(false);
  });

  it('pays the old fee plus the relay of the replacement', () => {
    expect(rbfMinFee(500n, 110)).toBe(610n);
    // A live rate lower than the original still has to clear the rule.
    expect(planSpeedUp([pay, change(39_000n)], 500n, 110, 1).fee).toBe(610n);
    expect(planSpeedUp([pay, change(39_000n)], 500n, 110, 20).fee).toBe(2200n);
    expect(planSpeedUp([pay, change(39_000n)], 500n, 110, 1.5).fee).toBe(610n);
  });

  it('takes the extra fee from the change, never from the payment', () => {
    const p = planSpeedUp([pay, change(39_000n)], 500n, 110, 20);
    expect(p).toEqual({ fee: 2200n, change: 1, newChange: 37_300n });
    expect(planSpeedUp([change(10_000n), pay, change(39_000n)], 500n, 110, 20).change).toBe(2);
  });

  it('refuses without change, or when it would fall under dust', () => {
    expect(refusal(() => planSpeedUp([pay], 500n, 110, 20))).toBe('noChange');
    expect(refusal(() => planSpeedUp([pay, change(1_000n)], 500n, 110, 20))).toBe('noChange');
    expect(refusal(() => planSpeedUp([pay, change(1_994n)], 500n, 110, 20))).toBe('none');
    expect(refusal(() => planSpeedUp([pay, change(1_993n)], 500n, 110, 20))).toBe('noChange');
  });

  it('cancels back to yourself, and refuses when nothing would be left', () => {
    expect(planCancel(100_000n, 500n, 80, 10, 294n)).toEqual({ fee: 800n, value: 99_200n });
    expect(planCancel(100_000n, 500n, 80, 1, 294n)).toEqual({ fee: 580n, value: 99_420n });
    expect(refusal(() => planCancel(800n, 500n, 80, 10, 294n))).toBe('tooSmall');
  });
});

describe('EVM same-nonce fees', () => {
  it('matches Rust on the 10% rule', () => {
    expect(evmMinReplacementFee(100n)).toBe(110n);
    expect(evmMinReplacementFee(101n)).toBe(112n);
    expect(evmMinReplacementFee(0n)).toBe(1n);
  });

  it('uses the live level when it clears the rule', () => {
    expect(evmReplacementFees({ maxFeePerGas: 100n, maxPriorityFeePerGas: 10n }, { maxFeePerGas: 200n, maxPriorityFeePerGas: 20n })).toEqual({ maxFeePerGas: 200n, maxPriorityFeePerGas: 20n });
  });

  it('raises both fields on their own, and keeps the tip under the max fee', () => {
    expect(evmReplacementFees({ maxFeePerGas: 100n, maxPriorityFeePerGas: 10n }, { maxFeePerGas: 50n, maxPriorityFeePerGas: 5n })).toEqual({ maxFeePerGas: 110n, maxPriorityFeePerGas: 11n });
    expect(evmReplacementFees({ maxFeePerGas: 100n, maxPriorityFeePerGas: 100n }, { maxFeePerGas: 200n, maxPriorityFeePerGas: 1n })).toEqual({ maxFeePerGas: 200n, maxPriorityFeePerGas: 110n });
    const f = evmReplacementFees({ maxFeePerGas: 100n, maxPriorityFeePerGas: 100n }, { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n });
    expect(f.maxFeePerGas >= f.maxPriorityFeePerGas).toBe(true);
  });
});

describe('what can be replaced', () => {
  it('only your own pending transactions on chains that allow it', () => {
    const e = { status: 'pending', direction: 'out' };
    for (const f of ['btc', 'ltc', 'evm']) expect(canReplace(e, f)).toBe(true);
    for (const f of ['xmr', 'doge', 'bch', 'dash', 'zec', 'sol', 'tron', undefined]) expect(canReplace(e, f)).toBe(false);
    expect(canReplace({ status: 'confirmed', direction: 'out' }, 'btc')).toBe(false);
    expect(canReplace({ status: 'pending', direction: 'in' }, 'btc')).toBe(false);
    expect(canReplace({ ...e, suspect: 'notSigned' }, 'evm')).toBe(false);
  });

  it('counts only what comes on top', () => {
    expect(extraCost({ oldFee: 100n, newFee: 150n })).toBe(50n);
    expect(extraCost({ oldFee: 100n, newFee: 60n })).toBe(0n);
  });
});
