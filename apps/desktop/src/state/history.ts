// SPDX-License-Identifier: GPL-3.0-or-later
// Unified history: adapters (Esplora, ERC-20 logs, Solana signatures) merged
// with the transactions sent from this device (local records).

import { useEffect } from 'react';
import { findAsset, findChain, nativeAssetId, type AssetDef, type HistoryItem } from '@kyro/chains';
import { netFetch } from '@kyro/shared';
import { lifiTransferStatus } from '@kyro/swap';
import { getLocalTxs, updateLocalTx, type LocalTx } from '../lib/storage';
import { crossStatusLabel } from '../lib/crossSwap';
import { useAsync } from '../lib/useAsync';
import { useVault } from './app';

export interface HistoryEntry extends HistoryItem {
  asset: AssetDef | undefined;
  chainLabel: string;
  feeAsset: AssetDef | undefined;
  label?: string;
  local: boolean;
}

const swapChain = (c: string) => (/^\d+$/.test(c) ? Number(c) : (c as 'solana' | 'bitcoin'));

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
  // Cross-chain: the source transaction may be confirmed while the bridge is still delivering.
  if (t.cross && t.label) item.label = `${t.label} · ${crossStatusLabel(t.cross.status, findChain(network, t.cross.toChainKey)?.label ?? t.cross.toChainKey)}`;
  return item;
}

export function useHistory() {
  const { adapters, accounts, accountSources, isMultiAccount } = useVault();
  const network = accounts.network;
  const sourcesKey = accountSources.map((x) => `${x.family}:${x.index}:${x.name}:${x.addresses.join(',')}`).join('|');

  const state = useAsync(
    async () => {
      // Every account of every chain (§2.9); with several accounts on a chain, each entry says
      // which one (« Sepolia · Ethereum 2 ») and keeps a distinct id (a transfer between two of
      // your accounts appears in both).
      const jobs = accountSources.flatMap((src) => src.adapters.map((a) => ({ a, src })));
      const results = await Promise.allSettled(jobs.map((j) => j.a.getHistory()));
      const errors: Record<string, string> = {};
      const remote: Array<HistoryItem & { account?: string }> = [];
      results.forEach((r, i) => {
        const j = jobs[i];
        if (!j) return;
        const multi = isMultiAccount(j.src.family);
        if (r.status === 'fulfilled') remote.push(...r.value.map((x) => (multi ? { ...x, id: j.src.index ? `${x.id}@${j.src.index}` : x.id, account: j.src.name } : x)));
        else errors[j.a.chain.key] ??= r.reason instanceof Error ? r.reason.message : String(r.reason);
      });
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
      entries.sort((a, b) => (b.time ?? Date.now()) - (a.time ?? Date.now()));
      // Bitcoin servers return at most BTC_TXS_CAP transactions per address: say so.
      return { entries, errors, btcCapped: jobs.some((j) => j.a.family === 'btc' && (j.a as { historyCapped?: boolean }).historyCapped) };
    },
    [sourcesKey, network],
    { intervalMs: 60_000 },
  );

  // Resolve pending EVM transactions sent from this device.
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
    ).then(() => changed && state.reload());
  }, [state.data, adapters, network]);

  // Follow cross-chain swaps until they arrive (li.quest `/v1/status`, read-only, same Tor family as the quotes).
  useEffect(() => {
    const open = getLocalTxs(network).filter((t) => t.cross && t.status !== 'failed' && t.cross.status !== 'DONE' && t.cross.status !== 'FAILED' && Date.now() - t.time < 7 * 86_400_000);
    if (open.length === 0) return;
    let changed = false;
    void Promise.all(
      open.map(async (t) => {
        const c = t.cross;
        if (!c) return;
        try {
          const st = await lifiTransferStatus(netFetch, { txHash: t.id, fromChain: swapChain(c.fromChain), toChain: swapChain(c.toChain), bridge: c.bridge });
          if (st.status === c.status && st.receivingTxHash === c.receivingTxHash) return;
          updateLocalTx(network, t.id, { cross: { ...c, status: st.status, ...(st.receivingTxHash ? { receivingTxHash: st.receivingTxHash } : {}) } });
          changed = true;
        } catch {
          /* not indexed yet, or offline: next refresh */
        }
      }),
    ).then(() => changed && state.reload());
  }, [state.data, network]);

  return state;
}
