// SPDX-License-Identifier: GPL-3.0-or-later
// Unified history: adapters (Esplora, ERC-20 logs, Solana signatures) merged
// with the transactions sent from this device (local records).

import { useEffect } from 'react';
import { findAsset, findChain, type AssetDef, type HistoryItem } from '@kyro/chains';
import { getLocalTxs, updateLocalTx, type LocalTx } from '../lib/storage';
import { useAsync } from '../lib/useAsync';
import { useVault } from './app';

export interface HistoryEntry extends HistoryItem {
  asset: AssetDef | undefined;
  chainLabel: string;
  feeAsset: AssetDef | undefined;
  label?: string;
  local: boolean;
}

function fromLocal(t: LocalTx): HistoryItem & { label?: string } {
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
  return item;
}

export function useHistory() {
  const { adapters, accounts } = useVault();
  const network = accounts.network;

  const state = useAsync(
    async () => {
      const results = await Promise.allSettled(adapters.all.map((a) => a.getHistory()));
      const errors: Record<string, string> = {};
      const remote: HistoryItem[] = [];
      results.forEach((r, i) => {
        const a = adapters.all[i];
        if (!a) return;
        if (r.status === 'fulfilled') remote.push(...r.value);
        else errors[a.chain.key] = r.reason instanceof Error ? r.reason.message : String(r.reason);
      });
      const remoteIds = new Set(remote.map((x) => x.id.split(':')[0]));
      const local = getLocalTxs(network)
        .filter((t) => !remoteIds.has(t.id) || t.kind !== 'transfer')
        .map(fromLocal);
      // Local swap/approval records replace the raw ERC-20 log of the same tx.
      const localIds = new Set(local.map((l) => l.id));
      const merged = [...remote.filter((x) => !localIds.has(x.id.split(':')[0] ?? '')), ...local];
      const entries: HistoryEntry[] = merged.map((x) => {
        const chain = findChain(network, x.chainKey);
        const asset = findAsset(network, x.assetId);
        const feeAsset = chain ? findAsset(network, chain.family === 'btc' ? 'btc' : chain.family === 'sol' ? 'sol' : `eth:${chain.chainId}`) : undefined;
        return { ...x, asset, feeAsset, chainLabel: chain?.label ?? x.chainKey, local: localIds.has(x.id) };
      });
      entries.sort((a, b) => (b.time ?? Date.now()) - (a.time ?? Date.now()));
      // Bitcoin servers return at most BTC_TXS_CAP transactions per address: say so.
      return { entries, errors, btcCapped: adapters.btc.historyCapped };
    },
    [adapters, network],
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

  return state;
}
