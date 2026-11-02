// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { gapScanBranch, limiter } from '../src/gapScan';

/** Sequential reference scan (the previous implementation). */
function sequential(gap: number, max: number, used: Set<number>): number[] {
  const out: number[] = [];
  let unused = 0;
  for (let i = 0; i < max && unused < gap; i++) {
    out.push(i);
    unused = used.has(i) ? 0 : unused + 1;
  }
  return out;
}

describe('gapScanBranch', () => {
  const cases: Array<[number, number, number[]]> = [
    [5, 40, []],
    [5, 40, [0]],
    [5, 40, [2, 6, 7]],
    [3, 40, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]],
    [5, 8, [1, 4, 7]],
    [5, 40, [4, 9, 14]],
  ];
  it.each(cases)('gap %i, max %i, used %j: same addresses as a sequential scan', async (gap, max, usedList) => {
    const used = new Set(usedList);
    const run = limiter(5);
    const res = await gapScanBranch(gap, max, async (i) => ({ i, used: used.has(i) }), run);
    expect(res.map((r) => r.i)).toEqual(sequential(gap, max, used));
  });

  it('a fresh branch is probed in one parallel window', async () => {
    let inFlight = 0;
    let peak = 0;
    const run = limiter(6);
    await gapScanBranch(5, 40, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { used: false };
    }, run);
    expect(peak).toBe(5);
  });

  it('propagates a failed probe', async () => {
    await expect(gapScanBranch(3, 40, async (i) => (i === 1 ? Promise.reject(new Error('down')) : { used: false }), limiter(2))).rejects.toThrow('down');
  });
});

describe('limiter', () => {
  it('never runs more than n tasks at once, across callers', async () => {
    const run = limiter(3);
    let inFlight = 0;
    let peak = 0;
    const task = async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
    };
    await Promise.all(Array.from({ length: 12 }, () => run(task)));
    expect(peak).toBe(3);
  });
});
