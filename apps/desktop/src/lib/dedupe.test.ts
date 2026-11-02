// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { Dedupe, settleWithin } from './dedupe';

describe('request dedupe', () => {
  it('joins a request in flight and reuses a recent success', async () => {
    let now = 0;
    const d = new Dedupe(1_000, () => now);
    let release!: (v: number) => void;
    const fn = vi.fn(() => new Promise<number>((r) => (release = r)));
    const a = d.run('k', fn);
    const b = d.run('k', fn);
    expect(fn).toHaveBeenCalledTimes(1);
    release(7);
    expect(await a).toBe(7);
    expect(await b).toBe(7);
    now = 500;
    expect(await d.run('k', async () => 8)).toBe(7);
    now = 1_500;
    expect(await d.run('k', async () => 9)).toBe(9);
    expect(await d.run('other', async () => 1)).toBe(1);
  });

  it('never keeps a failure, and a zero TTL only joins in flight', async () => {
    const d = new Dedupe(0);
    await expect(d.run('k', () => Promise.reject(new Error('down')))).rejects.toThrow('down');
    expect(await d.run('k', async () => 2)).toBe(2);
    expect(await d.run('k', async () => 3)).toBe(3);
  });

  it('ends a round at the deadline without waiting for a slow task', async () => {
    vi.useFakeTimers();
    const slow = new Promise<void>(() => {});
    const done = settleWithin([Promise.resolve(), slow], 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await done).toBe(false);
    expect(await settleWithin([Promise.resolve(), Promise.reject(new Error('x'))], 1_000)).toBe(true);
    vi.useRealTimers();
  });
});
