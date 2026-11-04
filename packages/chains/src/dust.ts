// SPDX-License-Identifier: GPL-3.0-or-later
// Dust protection (SECURITY.md): a tiny coin sent by a stranger to an address already in use is
// bait. Spent with other coins, it ties them together. Such coins stay in the balance but are left
// out of sends unless the user includes them. Reads server data: a lying server can only change
// which tiny coins are set aside, never what is signed.

import type { EsploraTx } from '@kyro/shared';
import { dustUnits } from './poisoning';
import type { Family } from './registry';

export interface OwnedCoin {
  txid: string;
  vout: number;
  value: bigint;
  /** Our address holding the coin. */
  address: string;
}

/** What is left out of sends. It still counts in the balance. */
export interface SetAside {
  count: number;
  amount: bigint;
}

const isEarlier = (a: EsploraTx, b: EsploraTx): boolean => {
  const h = a.status.block_height;
  if (!a.status.confirmed || h === undefined) return false;
  if (!b.status.confirmed) return true;
  return b.status.block_height !== undefined && h < b.status.block_height;
};

/**
 * Tiny, paid by someone else, and the address had seen a transaction before.
 * When the history cannot show that (transaction not in it, same block), the coin stays spendable.
 * @param txs history of the coin's address
 * @param own every address of the account: our own change is never dust
 */
export function isUnsolicitedDust(coin: OwnedCoin, family: Family, txs: EsploraTx[], own: ReadonlySet<string>): boolean {
  const limit = dustUnits(family);
  if (limit === undefined || coin.value > limit) return false;
  const tx = txs.find((t) => t.txid === coin.txid);
  if (!tx) return false;
  if (tx.vin.some((v) => v.prevout?.scriptpubkey_address !== undefined && own.has(v.prevout.scriptpubkey_address))) return false;
  return txs.some((t) => t.txid !== tx.txid && isEarlier(t, tx));
}

/** Splits an account's coins. Only addresses holding a tiny coin have their history read. */
export async function splitDust<C extends OwnedCoin>(coins: C[], family: Family, txsOf: (address: string) => Promise<EsploraTx[]>, own: ReadonlySet<string>): Promise<{ spend: C[]; aside: C[] }> {
  const limit = dustUnits(family);
  if (limit === undefined) return { spend: coins, aside: [] };
  const addresses = [...new Set(coins.filter((c) => c.value <= limit).map((c) => c.address))];
  const histories = new Map(await Promise.all(addresses.map(async (a) => [a, await txsOf(a)] as const)));
  const spend: C[] = [];
  const aside: C[] = [];
  for (const c of coins) (isUnsolicitedDust(c, family, histories.get(c.address) ?? [], own) ? aside : spend).push(c);
  return { spend, aside };
}

export function setAsideOf(aside: Array<{ value: bigint }>): SetAside {
  return { count: aside.length, amount: aside.reduce((s, c) => s + c.value, 0n) };
}
