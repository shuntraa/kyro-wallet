// SPDX-License-Identifier: GPL-3.0-or-later
import { isHiddenFamily, type AdapterSet } from '@kyro/chains';
import { familyAdapters } from './accounts';
import type { ContactFamily } from './storage';

/** Address book order: the most common first, so the dropdown of an ambiguous address reads naturally. */
export const CONTACT_FAMILIES: readonly ContactFamily[] = ['evm', 'btc', 'sol', 'tron', 'ltc', 'doge', 'bch', 'dash', 'xrp', 'ada', 'zec', 'sui', 'apt', 'cosmos', 'ton', 'xmr', 'algo', 'dot', 'kas', 'hbar', 'xlm', 'near'];

/** Short network label and coin ticker (for CoinIcon) of a contact family. */
export const CONTACT_FAMILY_META: Record<ContactFamily, { label: string; symbol: string }> = {
  evm: { label: 'EVM', symbol: 'ETH' },
  btc: { label: 'BTC', symbol: 'BTC' },
  sol: { label: 'SOL', symbol: 'SOL' },
  ltc: { label: 'LTC', symbol: 'LTC' },
  doge: { label: 'DOGE', symbol: 'DOGE' },
  bch: { label: 'BCH', symbol: 'BCH' },
  dash: { label: 'DASH', symbol: 'DASH' },
  tron: { label: 'TRON', symbol: 'TRX' },
  xrp: { label: 'XRP', symbol: 'XRP' },
  ada: { label: 'ADA', symbol: 'ADA' },
  zec: { label: 'ZEC', symbol: 'ZEC' },
  apt: { label: 'APT', symbol: 'APT' },
  cosmos: { label: 'ATOM', symbol: 'ATOM' },
  ton: { label: 'TON', symbol: 'TON' },
  xmr: { label: 'XMR', symbol: 'XMR' },
  algo: { label: 'ALGO', symbol: 'ALGO' },
  dot: { label: 'DOT', symbol: 'DOT' },
  kas: { label: 'KAS', symbol: 'KAS' },
  hbar: { label: 'HBAR', symbol: 'HBAR' },
  sui: { label: 'SUI', symbol: 'SUI' },
  xlm: { label: 'XLM', symbol: 'XLM' },
  near: { label: 'NEAR', symbol: 'NEAR' },
};

/** Every visible network whose validator accepts the address (several: 0x + 64 hex is Sui or Aptos). */
export function detectFamilies(address: string, isValid: (family: ContactFamily, address: string) => boolean): ContactFamily[] {
  const a = address.trim();
  if (!a) return [];
  const hits = CONTACT_FAMILIES.filter((f) => !isHiddenFamily(f) && isValid(f, a));
  // NEAR named accounts accept almost any lowercase string (bc1…, cosmos1…, a truncated 0x…): another match, or a 0x, means another network.
  return hits.length > 1 || a.startsWith('0x') ? hits.filter((f) => f !== 'near') : hits;
}

/** The validator of a family, from the live adapter set (the same checks as Send). */
export function adapterValidator(set: AdapterSet): (family: ContactFamily, address: string) => boolean {
  return (family, address) => {
    try {
      return familyAdapters(set, family).some((x) => x.isValidAddress(address));
    } catch {
      return false;
    }
  };
}
