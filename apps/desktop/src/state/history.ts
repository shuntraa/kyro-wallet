// SPDX-License-Identifier: GPL-3.0-or-later
// Unified history: adapters (Esplora, ERC-20 logs, Solana signatures) merged with the transactions
// sent from this device (local records).

import { useCallback, useEffect, useRef, useState } from 'react';
import { findAsset, findChain, nativeAssetId, type AssetDef, type HistoryItem } from '@kyro/chains';
import { netFetch } from '@kyro/shared';
import { exolixOrderStatus, lifiTransferStatus, nearDepositStatus, type SwapChain } from '@kyro/swap';
import { getLocalTxs, updateLocalTx, type LocalTx } from '../lib/storage';
import { crossStatusLabel } from '../lib/crossSwap';
import type { AsyncState } from '../lib/useAsync';
import { fingerprint, historyKey, loadHistory, mergeHistory, saveHistory, type HistoryCache } from '../lib/balanceCache';
import { Dedupe, settleWithin } from '../lib/dedupe';
import { useVault } from './app';
import { recordNetErrors } from '../lib/netErrors';

export interface HistoryEntry extends HistoryItem {
  asset: AssetDef | undefined;
  chainLabel: string;
  feeAsset: AssetDef | undefined;
  label?: string;
  local: boolean;
}

const swapChain = (c: string): SwapChain => (/^\d+$/.test(c) ? Number(c) : (c as SwapChain));
const FINAL = new Set(['DONE', 'FAILED', 'SUCCESS', 'REFUNDED']);

function fromLocal(t: LocalTx, network: LocalTx['network']): HistoryItem & { label?: string } {
  const item: HistoryItem & { label?: string } = {
    id: t.id,
    chainKey: t.chainKey,
    assetId: t.assetId,
    direction: t.direction,
    amount: BigInt(t.amount),
    time: t.time,
    status: t.status,
    kind: t.kind,
  };
  if (t.fee) item.fee = BigInt(t.fee);
  if (t.counterparty) item.counterparty = t.counterparty;
  if (t.label) item.label = t.label;
  if (t.cross && t.label) item.label = `${t.label} · ${crossStatusLabel(t.cross.status, findChain(network, t.cross.toChainKey)?.label ?? t.cross.toChainKey)}`;
  return item;
}

export interface HistoryData {
  entries: HistoryEntry[];
  errors: Record<string, string>;
  btcCapped: boolean;
  dotHistory: 'ok' | 'partial' | 'unavailable' | null;
  /** Chains with a known answer (cached, even empty, or fetched): « No activity » is final for them. */
  known: string[];
  /** Chains whose request is still running (a background refresh when they are also `known`). */
  pending: string[];
}

type Source = ReturnType<typeof useVault>['accountSources'][number];
interface Job {
  a: Source['adapters'][number];
  src: Source;
  key: string;
}

/** Cached + fetched remote items of every account, merged with the local records. */
function assemble(jobs: Job[], remoteByJob: HistoryCache, errors: Record<string, string>, network: LocalTx['network'], isMultiAccount: (f: Source['family']) => boolean, pending: ReadonlySet<string>): HistoryData {
  // Every account of every chain (§2.9); with several accounts on a chain, each entry says which
  // one (« Sepolia · Ethereum 2 ») and keeps a distinct id (a transfer between two of your
  // accounts appears in both).
  const remote: Array<HistoryItem & { account?: string }> = [];
  for (const j of jobs) {
    const items = remoteByJob.get(j.key);
    if (!items) continue;
    const multi = isMultiAccount(j.src.family);
    remote.push(...items.map((x) => (multi ? { ...x, id: j.src.index ? `${x.id}@${j.src.index}` : x.id, account: j.src.name } : x)));
  }
  const remoteIds = new Set(remote.map((x) => x.id.split(/[:@]/)[0]));
  const local = getLocalTxs(network)
    .filter((t) => !remoteIds.has(t.id) || t.kind !== 'transfer')
    .map((t) => fromLocal(t, network));
  // Local swap/approval records replace the raw ERC-20 log of the same tx.
  const localIds = new Set(local.map((l) => l.id));
  const merged: Array<HistoryItem & { label?: string; account?: string }> = [...remote.filter((x) => !localIds.has(x.id.split(/[:@]/)[0] ?? '')), ...local];
  const entries: HistoryEntry[] = merged.map(({ account, ...x }) => {
    const chain = findChain(network, x.chainKey);
    const asset = findAsset(network, x.assetId);
    const feeAsset = chain ? findAsset(network, nativeAssetId(chain)) : undefined;
    const chainLabel = chain?.label ?? x.chainKey;
    return { ...x, asset, feeAsset, chainLabel: account ? `${chainLabel} · ${account}` : chainLabel, local: localIds.has(x.id) };
  });
  const now = Date.now();
  entries.sort((a, b) => (b.time ?? now) - (a.time ?? now));
  const dotStatuses = jobs.filter((j) => j.a.family === 'dot').map((j) => (j.a as { historyStatus?: string | null }).historyStatus);
  const dotHistory: HistoryData['dotHistory'] = dotStatuses.length === 0 ? null : dotStatuses.includes('unavailable') ? 'unavailable' : dotStatuses.includes('partial') ? 'partial' : 'ok';
  const known = [...new Set(jobs.filter((j) => remoteByJob.has(j.key)).map((j) => j.a.chain.key))];
  const pendingChains = [...new Set(jobs.filter((j) => pending.has(j.key)).map((j) => j.a.chain.key))];
  return { entries, errors, known, pending: pendingChains, btcCapped: jobs.some((j) => j.a.family === 'btc' && (j.a as { historyCapped?: boolean }).historyCapped), dotHistory };
}

const REFRESH_MS = 60_000;
/** A chain's history request: joined while in flight, its answer reused this long by other screens. */
const HISTORY_REUSE_MS = 20_000;
/** Past this, a chain's round ends without it (its request keeps running and is merged next time). */
const CHAIN_TIMEOUT_MS = 25_000;
const historyRequests = new Dedupe(HISTORY_REUSE_MS);

/**
 * Unified history. The last known activity (local cache, `balanceCache.ts`) renders at once; every
 * account and chain then refreshes in the background and is merged in as soon as it answers (a
 * slow chain never holds back the others). `loading` stays true until every chain has answered.
 */
export function useHistory(): AsyncState<HistoryData> {
  const { adapters, accounts, accountSources, isMultiAccount } = useVault();
  const network = accounts.network;
  const sourcesKey = accountSources.map((x) => `${x.family}:${x.index}:${x.name}:${x.addresses.join(',')}`).join('|');
  const fp = fingerprint(sourcesKey);
  const jobsFor = (): Job[] => accountSources.flatMap((src) => src.adapters.map((a) => ({ a, src, key: historyKey(src.family, src.index, a.chain.key) })));
  const fromCache = (): HistoryData | undefined => {
    const cache = loadHistory(network, fp);
    // Empty answers are cached too: « No activity » shows at once, then refreshes silently.
    const jobs = jobsFor();
    return cache && cache.size > 0 ? assemble(jobs, cache, {}, network, isMultiAccount, new Set(jobs.map((j) => j.key))) : undefined;
  };

  const [state, setState] = useState<{ id: string; data: HistoryData | undefined }>(() => ({ id: `${network}|${fp}`, data: fromCache() }));
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  const lastErrors = useRef<Record<string, string>>({});
  const id = `${network}|${fp}`;
  // Another wallet or network: its own cache, never the previous one's entries.
  const data = state.id === id ? state.data : undefined;

  useEffect(() => {
    let alive = true;
    const jobs = jobsFor();
    const cache: HistoryCache = loadHistory(network, fp) ?? new Map();
    const errors: Record<string, string> = {};
    const pending = new Set(jobs.map((j) => j.key));
    const publish = (errs: Record<string, string>) => {
      if (alive) setState({ id, data: assemble(jobs, cache, errs, network, isMultiAccount, pending) });
    };
    const persist = () => saveHistory(network, fp, new Map(jobs.flatMap((j) => (cache.has(j.key) ? [[j.key, cache.get(j.key) ?? []] as const] : []))));
    // Each chain's answer reaches the disk without waiting for the slowest one (batched).
    let saveTimer: number | undefined;
    const saveSoon = () => {
      window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(persist, 500);
    };
    if (state.id !== id) {
      lastErrors.current = {};
      setState({ id, data: fromCache() });
    }
    setLoading(true);
    // Every chain in parallel, each merged in as it answers; requests are shared by every screen
    // showing history (and reused for a few seconds). The round ends at `CHAIN_TIMEOUT_MS` even if
    // a chain is still busy: its late answer is merged when it comes, without an error.
    void settleWithin(
      jobs.map(async (j) => {
        try {
          const fresh = await historyRequests.run(`${network}|${j.key}|${j.src.addresses.join(',')}`, () => j.a.getHistory());
          cache.set(j.key, mergeHistory(cache.get(j.key), fresh));
          if (alive) saveSoon();
        } catch (e) {
          errors[j.a.chain.key] ??= e instanceof Error ? e.message : String(e);
        }
        pending.delete(j.key);
        publish(lastErrors.current);
      }),
      CHAIN_TIMEOUT_MS,
    ).then(() => {
      if (!alive) return;
      window.clearTimeout(saveTimer);
      persist();
      recordNetErrors('history', errors);
      lastErrors.current = errors;
      publish(errors);
      setLoading(false);
      setUpdatedAt(Date.now());
    });
    return () => {
      alive = false;
      if (saveTimer !== undefined) {
        window.clearTimeout(saveTimer);
        persist();
      }
    };
  }, [sourcesKey, network, tick]);

  useEffect(() => {
    const t = window.setInterval(reload, REFRESH_MS);
    return () => window.clearInterval(t);
  }, [reload]);

  const result: AsyncState<HistoryData> = { data, error: null, loading, updatedAt, reload };
  useEffect(() => {
    const pending = getLocalTxs(network).filter((t) => t.status === 'pending' && findChain(network, t.chainKey)?.family === 'evm');
    if (pending.length === 0) return;
    let changed = false;
    void Promise.all(
      pending.map(async (t) => {
        const ad = adapters.evm.get(t.chainKey);
        if (!ad) return;
        try {
          const r = await ad.client.getTransactionReceipt({ hash: t.id as `0x${string}` });
          updateLocalTx(network, t.id, { status: r.status === 'success' ? 'confirmed' : 'failed' });
          changed = true;
        } catch {
          /* not mined yet */
        }
      }),
    ).then(() => changed && reload());
  }, [updatedAt, adapters, network]);

  // Follow cross-chain swaps until they arrive (li.quest `/v1/status`, read-only, same Tor family as the quotes).
  useEffect(() => {
    const open = getLocalTxs(network).filter((t) => t.cross && t.status !== 'failed' && !FINAL.has(t.cross.status ?? '') && Date.now() - t.time < 7 * 86_400_000);
    if (open.length === 0) return;
    let changed = false;
    void Promise.all(
      open.map(async (t) => {
        const c = t.cross;
        if (!c) return;
        try {
          const st = c.bridge === 'exolix' && c.orderId
            ? await exolixOrderStatus(netFetch, c.orderId).then((r) => ({ status: r.status, ...(r.destinationTxHash ? { receivingTxHash: r.destinationTxHash } : {}) }))
            : c.bridge === '1click' && c.depositAddress
            ? await nearDepositStatus(netFetch, c.depositAddress).then((r) => ({ status: r.status, ...(r.destinationTxHash ? { receivingTxHash: r.destinationTxHash } : {}) }))
            : await lifiTransferStatus(netFetch, { txHash: t.id, fromChain: swapChain(c.fromChain), toChain: swapChain(c.toChain), bridge: c.bridge });
          if (st.status === c.status && st.receivingTxHash === c.receivingTxHash) return;
          updateLocalTx(network, t.id, { cross: { ...c, status: st.status, ...(st.receivingTxHash ? { receivingTxHash: st.receivingTxHash } : {}) } });
          changed = true;
        } catch {
          /* not indexed yet, or offline: next refresh */
        }
      }),
    ).then(() => changed && reload());
  }, [updatedAt, network]);

  return result;
}
