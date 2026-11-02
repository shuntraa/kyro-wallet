// SPDX-License-Identifier: GPL-3.0-or-later
// One network request per key at a time, and a short reuse window: several screens opening at once
// (or a screen reopened a few seconds later) share one answer instead of asking every chain again.

interface Entry {
  p: Promise<unknown>;
  /** When the promise settled successfully (`null` while in flight). */
  at: number | null;
}

export class Dedupe {
  private readonly map = new Map<string, Entry>();
  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** `fn()` once per key: joins a request in flight, reuses a success younger than the TTL. Failures are not kept. */
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const e = this.map.get(key);
    if (e && (e.at === null || this.now() - e.at < this.ttlMs)) return e.p as Promise<T>;
    const entry: Entry = { p: Promise.resolve(), at: null };
    entry.p = fn().then(
      (v) => {
        if (this.map.get(key) === entry) entry.at = this.now();
        return v;
      },
      (err: unknown) => {
        if (this.map.get(key) === entry) this.map.delete(key);
        throw err;
      },
    );
    this.map.set(key, entry);
    return entry.p as Promise<T>;
  }

  /** Forget one key, or all. */
  drop(key?: string): void {
    if (key === undefined) this.map.clear();
    else this.map.delete(key);
  }
}

/**
 * Resolves once every task has settled, or after `ms`, whichever comes first: a slow chain ends the
 * round without being an error (its task keeps running and applies its own result). Returns true
 * when all tasks settled in time.
 */
export function settleWithin(tasks: readonly Promise<unknown>[], ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const id = setTimeout(() => resolve(false), ms);
    void Promise.allSettled(tasks).then(() => {
      clearTimeout(id);
      resolve(true);
    });
  });
}
