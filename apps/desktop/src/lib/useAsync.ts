// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useRef, useState } from 'react';
import { Dedupe } from './dedupe';
import { readJson, writeJson } from './storage';

export interface AsyncState<T> {
  data: T | undefined;
  error: Error | null;
  loading: boolean;
  updatedAt: number | null;
  reload: () => void;
}

/**
 * Run an async loader, keep the previous data while reloading, optionally refresh on an interval.
 */
export function useAsync<T>(loader: (() => Promise<T>) | null, key: unknown[], opts: { intervalMs?: number } = {}): AsyncState<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(loader !== null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    const fn = loaderRef.current;
    if (!fn) {
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    fn()
      .then((d) => {
        if (!alive) return;
        setData(d);
        setError(null);
        setUpdatedAt(Date.now());
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e : new Error(String(e)));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [...key, tick, loader === null]);

  useEffect(() => {
    if (!opts.intervalMs) return;
    const id = window.setInterval(() => setTick((t) => t + 1), opts.intervalMs);
    return () => window.clearInterval(id);
  }, [opts.intervalMs]);

  return { data, error, loading, updatedAt, reload };
}

const lastAnswers = new Map<string, unknown>();
// Joins a load in flight only: a reload after an action always asks again.
const sharedLoads = new Dedupe(0);

/**
 * [`useAsync`] that shows the last answer for `cacheKey` at once (this session's; with `persist`,
 * also the previous launch's, from localStorage: public data only) and refreshes in the
 * background. Screens mounting together share one request.
 */
export function useCachedAsync<T>(cacheKey: string | null, loader: (() => Promise<T>) | null, key: unknown[], opts: { intervalMs?: number; persist?: boolean } = {}): AsyncState<T> {
  const res = useAsync<T>(
    loader && cacheKey
      ? () =>
          sharedLoads.run(cacheKey, loader).then((d) => {
            lastAnswers.set(cacheKey, d);
            if (opts.persist) writeJson(`cache.async.${cacheKey}`, d);
            return d;
          })
      : loader,
    key,
    opts,
  );
  let cached: T | undefined;
  if (cacheKey) {
    if (!lastAnswers.has(cacheKey) && opts.persist) {
      const stored = readJson<T | null>(`cache.async.${cacheKey}`, null);
      if (stored !== null) lastAnswers.set(cacheKey, stored);
    }
    cached = lastAnswers.get(cacheKey) as T | undefined;
  }
  const data = cached ?? res.data;
  return { ...res, data, error: data === undefined ? res.error : null };
}

/** Debounce a value. */
export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return v;
}

/** Re-render every `ms` (countdowns, "il y a N s"). */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return now;
}
