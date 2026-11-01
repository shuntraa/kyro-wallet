// SPDX-License-Identifier: GPL-3.0-or-later
// Several vault accounts per chain (docs/IPC.md §2.9): pure helpers shared by the app state, the
// portfolio and the account screens.

import { sameTonAccount, type AccountChain, type Accounts, type VaultAccountEntry } from '@kyro/shared';
import type { AdapterSet, AnyAdapter } from '@kyro/chains';
import { t } from '../i18n';

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
  xlm: 'Stellar',
  near: 'NEAR',
  bch: 'Bitcoin Cash',
  dash: 'Dash',
  sui: 'Sui',
  hbar: 'Hedera',
  kas: 'Kaspa',
  dot: 'Polkadot',
  algo: 'Algorand',
  xmr: 'Monero',
  ton: 'TON',
  cosmos: 'Cosmos',
  apt: 'Aptos',
  zec: 'Zcash',
};

/** What a chain's account list covers (EVM: one list, the same address on every EVM chain). */
export function accountChainHint(chain: AccountChain): string {
  switch (chain) {
    case 'btc':
      return t('settings.hintBtc');
    case 'evm':
      return t('settings.hintEvm');
    case 'sol':
      return t('settings.hintSol');
    case 'ltc':
      return 'SegWit';
    case 'doge':
      return 'P2PKH';
    case 'bch':
      return 'CashAddr (P2PKH)';
    case 'dash':
      return 'P2PKH';
    case 'tron':
      return t('settings.hintTron');
    case 'xrp':
      return t('settings.hintXrp');
    case 'ada':
      return t('settings.hintAda');
    case 'xlm':
      return 'XLM';
    case 'near':
      return t('settings.hintNear');
    case 'sui':
      return 'SUI';
    case 'hbar':
      return t('settings.hintHbar');
    case 'kas':
      return t('settings.hintKas');
    case 'dot':
      return 'DOT (Polkadot Asset Hub)';
    case 'algo':
      return t('settings.hintAlgo');
    case 'xmr':
      return t('settings.hintXmr');
    case 'ton':
      return t('settings.hintTon');
    case 'cosmos':
      return 'ATOM (Cosmos Hub)';
    case 'apt':
      return 'APT';
    case 'zec':
      return t('settings.hintZec');
  }
}

/**
 * « Bitcoin 1 » for index 0, « Bitcoin 2 » for index 1… The same in every language (chain name +
 * number): it is saved as the account's name by Rust.
 */
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
    case 'xlm':
      return set.stellar ? [set.stellar] : [];
    case 'kas':
      return set.kaspa ? [set.kaspa] : [];
    case 'dot':
      return set.polkadot ? [set.polkadot] : [];
    case 'apt':
      return set.aptos ? [set.aptos] : [];
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
    case 'bch':
    case 'dash':
      return { address: acc[family].address, path: acc[family].path };
    case 'zec':
      return { address: acc.zec.address, path: acc.zec.path };
    case 'ada':
      return acc.cardano;
    case 'xlm':
      return acc.stellar;
    case 'kas':
      return acc.kas ?? { address: '', path: '' };
    case 'dot':
      return acc.polkadot;
    case 'apt':
      return acc.aptos;
    default:
      return acc[family];
  }
}

/** Account name check, same rule as Rust (1–32 characters after trim, no control character). */
export function accountNameProblem(name: string): string | null {
  const n = name.trim();
  if (!n) return t('settings.nameEmpty');
  if ([...n].length > 32) return t('settings.nameTooLong');
  if (/\p{Cc}/u.test(n)) return t('settings.nameBadChar');
  return null;
}

/**
 * The next `count` account indices to create on a chain (smallest free indices ≥ 1), capped by the
 * per-chain limit (Rust: 20 accounts, account 0 included) and the highest index (100).
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

const sameAddress = (family: AccountChain, a: string, b: string) => (family === 'evm' || family === 'sui' || family === 'hbar' ? a.toLowerCase() === b.toLowerCase() : family === 'ton' ? sameTonAccount(a, b) : a === b);

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
  return t('settings.ownAccountLabel', { name });
}
