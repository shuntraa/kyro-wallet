// SPDX-License-Identifier: GPL-3.0-or-later
//
// One asset on several networks (USDT on Ethereum, TRON, Solana, BNB Chain…; ETH on Ethereum,
// Arbitrum, Base…). Envoyer shows such an asset once in « Depuis », then asks for the network,
// with the balance on each one. Pure helpers: no network, no React.

import type { AssetDef } from '@kyro/chains';

/** Same coin on different chains: same CoinGecko id and same ticker (USDT ≠ USDT0 price feeds stay apart). */
export function assetGroupKey(a: AssetDef): string {
  return a.coingeckoId ? `${a.coingeckoId}|${a.symbol.toUpperCase()}` : `id|${a.id}`;
}

/** Every asset of `pool` in the same group as `asset` (itself included), in `pool` order. */
export function networkSiblings(asset: AssetDef, pool: readonly AssetDef[]): AssetDef[] {
  const k = assetGroupKey(asset);
  const out = pool.filter((a) => assetGroupKey(a) === k);
  return out.some((a) => a.id === asset.id) ? out : [asset, ...out];
}

/**
 * One entry per group, for the « Depuis » list: the selected asset stands for its own group,
 * otherwise the network with the largest balance (first in `list` order on a tie).
 */
export function dedupeByGroup(list: readonly AssetDef[], balanceOf: (a: AssetDef) => bigint, selectedId?: string): AssetDef[] {
  const best = new Map<string, AssetDef>();
  const order: string[] = [];
  for (const a of list) {
    const k = assetGroupKey(a);
    const cur = best.get(k);
    if (!cur) {
      best.set(k, a);
      order.push(k);
    } else if (cur.id !== selectedId && (a.id === selectedId || balanceOf(a) > balanceOf(cur))) {
      best.set(k, a);
    }
  }
  return order.map((k) => best.get(k) as AssetDef);
}

/** Sum of the balances of a group (same decimals is NOT assumed: BNB Chain USDC has 18). */
export function groupTotal(siblings: readonly AssetDef[], balanceOf: (a: AssetDef) => bigint): { amount: bigint; decimals: number } {
  const decimals = Math.max(0, ...siblings.map((a) => a.decimals));
  let amount = 0n;
  for (const a of siblings) amount += balanceOf(a) * 10n ** BigInt(decimals - a.decimals);
  return { amount, decimals };
}

/**
 * The recipient does not fit the chosen network: the other networks of the same asset whose
 * address format accepts it (« ceci est une adresse TRON »). Empty when it fits, or fits nothing.
 */
export function otherNetworksForAddress(address: string, asset: AssetDef, siblings: readonly AssetDef[], isValidOn: (a: AssetDef, address: string) => boolean): AssetDef[] {
  const to = address.trim();
  if (!to || isValidOn(asset, to)) return [];
  return siblings.filter((a) => a.id !== asset.id && a.family !== asset.family && isValidOn(a, to));
}
