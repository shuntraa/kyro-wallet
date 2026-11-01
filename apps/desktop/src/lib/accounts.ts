// SPDX-License-Identifier: GPL-3.0-or-later
//
// Several vault accounts per chain (docs/IPC.md §2.9): pure helpers shared by the app state,
// the portfolio and the account screens. Public data only (indices, names, addresses).

import { sameTonAccount, type AccountChain, type Accounts, type VaultAccountEntry } from '@kyro/shared';
import type { AdapterSet, AnyAdapter } from '@kyro/chains';

/** Chain names used in default account names (same as Rust's `Chain::label`). */
export const ACCOUNT_CHAIN_LABEL: Record<AccountChain, string> = {
  btc: 'Bitcoin',
  evm: 'Ethereum',
  sol: 'Solana',
  ltc: 'Litecoin',
  doge: 'Dogecoin',
  tron: 'TRON',
  xrp: 'XRP',
  ada: 'Cardano',
  ton: 'TON',
};

/** What a chain's account list covers (EVM: one list, the same address on every EVM chain). */
export const ACCOUNT_CHAIN_HINT: Record<AccountChain, string> = {
  btc: 'SegWit et Taproot',
  evm: 'Ethereum et toutes les chaînes EVM (même adresse)',
  sol: 'SOL et tokens SPL',
  ltc: 'SegWit',
  doge: 'P2PKH',
  tron: 'TRX et TRC-20',
  xrp: 'XRP et monnaies émises',
  ada: 'ADA et tokens',
  ton: 'Toncoin (portefeuille v4R2)',
};

/** « Bitcoin 1 » for index 0, « Bitcoin 2 » for index 1… */
export function defaultAccountName(chain: AccountChain, index: number): string {
  return `${ACCOUNT_CHAIN_LABEL[chain]} ${index + 1}`;
}

/** The adapters of `family` in an adapter set (EVM: one per chain). */
export function familyAdapters(set: AdapterSet, family: AccountChain): AnyAdapter[] {
  switch (family) {
    case 'evm':
      return [...set.evm.values()];
    case 'ada':
      return set.cardano ? [set.cardano] : [];
    default: {
      const a = set[family];
      return a ? [a] : [];
    }
  }
}

/** Smallest index ≥ 1 not in the list: the next account to scan (a removed one comes back first). */
export function nextAccountIndex(list: VaultAccountEntry[], max = 100): number | null {
  for (let i = 1; i <= max; i++) if (!list.some((e) => e.index === i)) return i;
  return null;
}

/** Address and derivation path of `family` in `accounts_get({ account })`. */
export function accountAddress(acc: Accounts, family: AccountChain): { address: string; path: string } {
  switch (family) {
    case 'btc':
      return { address: acc.btc.segwit.address, path: `${acc.btc.segwit.path} · ${acc.btc.taproot.path}` };
    case 'ltc':
      return { address: acc.ltc.address, path: acc.ltc.path };
    case 'doge':
      return { address: acc.doge.address, path: acc.doge.path };
    case 'ada':
      return acc.cardano;
    default:
      return acc[family];
  }
}

/** Account name check, same rule as Rust (1–32 characters after trim, no control character). */
export function accountNameProblem(name: string): string | null {
  const n = name.trim();
  if (!n) return 'Donne un nom au compte.';
  if ([...n].length > 32) return '32 caractères au plus.';
  if (/\p{Cc}/u.test(n)) return 'Caractère non autorisé.';
  return null;
}

/**
 * The next `count` account indices to create on a chain (smallest free indices ≥ 1), capped by
 * the per-chain limit (Rust: 20 accounts, account 0 included) and the highest index (100).
 */
export function planNewAccounts(list: VaultAccountEntry[], count: number, maxPerChain = 20, maxIndex = 100): number[] {
  const room = Math.max(0, Math.min(Math.floor(count), maxPerChain - list.length));
  const taken = new Set(list.map((e) => e.index));
  const out: number[] = [];
  for (let i = 1; i <= maxIndex && out.length < room; i++) if (!taken.has(i)) out.push(i);
  return out;
}

/** What an own account looks like to the send screen (public data). */
export interface OwnAccountRef {
  family: AccountChain;
  index: number;
  name: string;
  addresses: string[];
}

const sameAddress = (family: AccountChain, a: string, b: string) => (family === 'evm' ? a.toLowerCase() === b.toLowerCase() : family === 'ton' ? sameTonAccount(a, b) : a === b);

/** The user's OTHER accounts of `family` (not `current`), for « Mes comptes » in Envoyer. */
export function otherOwnAccounts<T extends OwnAccountRef>(sources: T[], family: AccountChain, current: number): T[] {
  return sources.filter((s) => s.family === family && s.index !== current && s.addresses.length > 0);
}

/** The account of `family` that owns `address`, if it is one of the user's. */
export function ownAccountOf<T extends OwnAccountRef>(sources: T[], family: AccountChain, address: string): T | undefined {
  const a = address.trim();
  if (!a) return undefined;
  return sources.find((s) => s.family === family && s.addresses.some((x) => sameAddress(family, x, a)));
}

/** Review label of a recipient that is one of the user's accounts. */
export function ownAccountLabel(name: string): string {
  return `Ton compte « ${name} »`;
}
