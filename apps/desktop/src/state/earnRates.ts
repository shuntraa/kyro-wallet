// SPDX-License-Identifier: GPL-3.0-or-later
// Earn rates, loaded in the background once the wallet is open, so the screen has them when it
// opens. Public figures: no address goes out. The last rate read stays, across launches too.

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { call } from '@kyro/shared';
import type { EvmAdapter } from '@kyro/chains';
import { AAVE_MARKETS, SEL_GET_RESERVE_DATA, aaveApyPercent, addrArg, keepRate, lidoAprPercent, parseReserveData, ratesDue, type RateStore } from '../lib/earn';
import { readJson, writeJson } from '../lib/storage';
import { useVault } from './app';

export type EvmGet = (chainKey: string) => EvmAdapter | undefined;

/** Reads go through Tor and some servers answer in tens of seconds: past this, the read counts as failed. */
const RATE_TIMEOUT_MS = 90_000;
/** After the unlock: balances go first. */
const START_DELAY_MS = 20_000;
const TICK_MS = 300_000;
/** In the background a rate younger than this is left alone: Solana's read is a heavy one. */
const BACKGROUND_MAX_AGE_MS = 1_800_000;

function rateReaders(evm: EvmGet): Record<string, () => Promise<number | null>> {
  const onChain = (chain: 'sol' | 'ada' | 'trx' | 'apt') => () => call('earn_rate', { chain });
  const out: Record<string, () => Promise<number | null>> = {
    'eth-lido': lidoAprPercent,
    near: () => call('near_stake_validators').then((v) => v.grossApy),
    sui: () => call('sui_stake_validators').then((v) => v.networkApy),
    sol: onChain('sol'),
    ada: onChain('ada'),
    trx: onChain('trx'),
    apt: onChain('apt'),
  };
  for (const [id, m] of Object.entries(AAVE_MARKETS)) {
    const a = evm(m.chainKey);
    if (!a) continue;
    out[id] = async () => {
      const { data } = await a.client.call({ to: m.pool as `0x${string}`, data: `${SEL_GET_RESERVE_DATA}${addrArg(m.asset)}` as `0x${string}` });
      const d = parseReserveData(data ?? '0x');
      // Pinning check: the pool must report the aToken Kyro expects.
      return d.aToken === m.aToken ? aaveApyPercent(d.liquidityRate) : null;
    };
  }
  return out;
}

const orNull = (job: Promise<number | null>): Promise<number | null> =>
  Promise.race([job.catch(() => null), new Promise<null>((r) => window.setTimeout(() => r(null), RATE_TIMEOUT_MS))]);

interface Snapshot {
  store: RateStore;
  waiting: ReadonlySet<string>;
}

const storageKey = (network: string) => `earn.rates.${network}`;
let loaded: string | null = null;
let snapshot: Snapshot = { store: {}, waiting: new Set() };
const listeners = new Set<() => void>();

function publish(next: Snapshot) {
  snapshot = next;
  for (const l of listeners) l();
}

function load(network: string) {
  if (loaded === network) return;
  loaded = network;
  snapshot = { store: readJson<RateStore>(storageKey(network), {}), waiting: new Set() };
}

/** Reads what is due, each rate on its own: it shows as soon as it is in. */
export function refreshRates(network: string, evm: EvmGet, maxAgeMs: number) {
  load(network);
  const readers = rateReaders(evm);
  const due = ratesDue(Object.keys(readers), snapshot.store, snapshot.waiting, Date.now(), maxAgeMs);
  if (due.length === 0) return;
  publish({ ...snapshot, waiting: new Set([...snapshot.waiting, ...due]) });
  for (const id of due) {
    void orNull(readers[id]!()).then((value) => {
      const store = keepRate(snapshot.store, id, value, Date.now());
      if (store !== snapshot.store) writeJson(storageKey(network), store);
      publish({ store, waiting: new Set([...snapshot.waiting].filter((x) => x !== id)) });
    });
  }
}

export function useEarnRates(network: string): Snapshot {
  load(network);
  return useSyncExternalStore(
    useCallback((l: () => void) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    }, []),
    () => snapshot,
  );
}

/** Mounted with the open wallet, whichever screen is showing. A failed read comes back at the next tick. */
export function useEarnRatesInBackground() {
  const { network, adapters } = useVault();
  useEffect(() => {
    const run = () => refreshRates(network, (k) => (network === 'mainnet' ? adapters.evm.get(k) : undefined), BACKGROUND_MAX_AGE_MS);
    const first = window.setTimeout(run, START_DELAY_MS);
    const tick = window.setInterval(run, TICK_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(tick);
    };
  }, [network, adapters]);
}
