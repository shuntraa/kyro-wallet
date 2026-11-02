// SPDX-License-Identifier: GPL-3.0-or-later
// Gap-limit address scan with bounded concurrency: each branch asks for a whole window of
// addresses at once (the ones a sequential scan would need if they all turned out unused), so a
// fresh wallet costs one round of parallel requests instead of `gap` round trips in a row. The
// addresses scanned are exactly those of the sequential scan: indices 0 … lastUsed + gap.

/** At most `n` tasks in flight; the others wait their turn (FIFO). */
export function limiter(n: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    if (active >= n) return;
    const run = queue.shift();
    if (run) {
      active++;
      run();
    }
  };
  return <T>(task: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        task()
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          });
      });
      next();
    });
}

/** Requests in flight per scan (all branches together): small, so Tor circuits and public servers are not flooded. */
export const SCAN_CONCURRENCY = 5;

/**
 * Scans one branch: `probe(i)` returns whether address `i` is used. Stops after `gap` unused
 * addresses in a row (or at `max`). Returns the results in index order.
 */
export async function gapScanBranch<R extends { used: boolean }>(gap: number, max: number, probe: (i: number) => Promise<R>, run: <T>(task: () => Promise<T>) => Promise<T>): Promise<R[]> {
  const out: R[] = [];
  let lastUsed = -1;
  for (;;) {
    const target = Math.min(max, lastUsed + 1 + gap);
    if (out.length >= target) return out;
    const start = out.length;
    const batch = await Promise.all(Array.from({ length: target - start }, (_, k) => run(() => probe(start + k))));
    batch.forEach((r, k) => {
      out.push(r);
      if (r.used) lastUsed = start + k;
    });
  }
}
