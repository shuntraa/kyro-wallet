// SPDX-License-Identifier: GPL-3.0-or-later
// What a watch address reads (docs/IPC.md §2.3b): one address, or every address of an xpub.

import * as bitcoin from 'bitcoinjs-lib';
import type { HDKey } from '@scure/bip32';
import { l10n } from '@kyro/shared';
import { gapScanBranch, limiter, SCAN_CONCURRENCY } from './gapScan';
import { parseXpub } from './bitcoin/xpub';

/** Script types an xpub can stand for. */
export type WatchScript = 'pkh' | 'sh-wpkh' | 'wpkh' | 'tr';

/** What a watch account scans: one address, or every address of an xpub. */
export type WatchSource = { kind: 'address'; address: string } | { kind: 'xpub'; xpub: string; scripts: WatchScript[] };

/** One row of a scan. */
export interface WatchRow {
  address: string;
  change: 0 | 1;
  index: number;
  used: boolean;
  balance: bigint;
}

/** Address of `pubkey` for a script type. */
export function watchScriptOutput(script: WatchScript, pubkey: Uint8Array, network: bitcoin.Network): { output: Uint8Array; address: string } {
  const p =
    script === 'pkh'
      ? bitcoin.payments.p2pkh({ pubkey, network })
      : script === 'wpkh'
        ? bitcoin.payments.p2wpkh({ pubkey, network })
        : script === 'tr'
          ? bitcoin.payments.p2tr({ internalPubkey: pubkey.slice(1, 33), network })
          : bitcoin.payments.p2sh({ redeem: bitcoin.payments.p2wpkh({ pubkey, network }), network });
  if (!p.address || !p.output) throw new Error(l10n('Adresse introuvable', 'Address not found'));
  return { output: p.output, address: p.address };
}

const SCAN_MAX = 40;

/** Reads a watch source: one lookup for an address, a gap-limit scan per script type and branch for an xpub. */
export async function scanWatchSource(
  src: WatchSource,
  derive: (key: HDKey, script: WatchScript, change: 0 | 1, index: number) => string,
  info: (address: string) => Promise<{ used: boolean; balance: bigint }>,
  gap = 5,
): Promise<WatchRow[]> {
  if (src.kind === 'address') return [{ address: src.address, change: 0, index: 0, ...(await info(src.address)) }];
  const key = parseXpub(src.xpub);
  const run = limiter(SCAN_CONCURRENCY);
  const lists = await Promise.all(
    src.scripts.flatMap((script) =>
      ([0, 1] as const).map((change) =>
        gapScanBranch(change === 0 ? gap : Math.max(2, gap - 2), SCAN_MAX, async (index) => {
          const address = derive(key, script, change, index);
          return { address, change, index, ...(await info(address)) };
        }, run),
      ),
    ),
  );
  return lists.flat();
}

/** Same rows from Esplora-style stats. */
export function esploraUsage(s: { chain_stats: { tx_count: number; funded_txo_sum: number; spent_txo_sum: number }; mempool_stats: { tx_count: number; funded_txo_sum: number; spent_txo_sum: number } }): { used: boolean; balance: bigint } {
  return {
    used: s.chain_stats.tx_count + s.mempool_stats.tx_count > 0,
    balance: BigInt(s.chain_stats.funded_txo_sum - s.chain_stats.spent_txo_sum + s.mempool_stats.funded_txo_sum - s.mempool_stats.spent_txo_sum),
  };
}
