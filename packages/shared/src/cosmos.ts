// SPDX-License-Identifier: GPL-3.0-or-later
// Cosmos Hub address shape for the interface (Send screen, adapter, demo).

import { bech32 } from '@scure/base';
import { l10n } from './i18n';

/**
 * Why `address` is not a Cosmos Hub account address (null = it is): bech32 (not bech32m) checksum,
 * prefix `cosmos`, 20 bytes (key) or 32 bytes (module / interchain account), not mixed case.
 */
export function cosmosAddressProblem(address: string): string | null {
  const a = address.trim();
  if (a === '') return l10n('Adresse vide', 'Empty address');
  if (a !== a.toLowerCase() && a !== a.toUpperCase()) return l10n('Adresse Cosmos invalide (majuscules et minuscules mélangées)', 'Invalid Cosmos address (mixed upper and lower case)');
  let dec: { prefix: string; words: number[] };
  try {
    dec = bech32.decode(a.toLowerCase() as `${string}1${string}`, 120);
  } catch {
    return l10n('Adresse Cosmos invalide (somme de contrôle)', 'Invalid Cosmos address (checksum)');
  }
  if (dec.prefix === 'cosmosvaloper' || dec.prefix === 'cosmosvalcons') return l10n('C’est l’adresse d’un validateur, pas d’un compte : envoie à une adresse cosmos1…', 'This is a validator address, not an account: send to a cosmos1… address');
  if (dec.prefix !== 'cosmos') return l10n(`Adresse d’une autre chaîne (« ${dec.prefix}1… ») : Kyro n’envoie des ATOM que sur Cosmos Hub (cosmos1…)`, `Address of another chain (“${dec.prefix}1…”): Kyro only sends ATOM on Cosmos Hub (cosmos1…)`);
  let len: number;
  try {
    len = bech32.fromWords(dec.words).length;
  } catch {
    return l10n('Adresse Cosmos invalide (longueur)', 'Invalid Cosmos address (length)');
  }
  if (len !== 20 && len !== 32) return l10n('Adresse Cosmos invalide (longueur)', 'Invalid Cosmos address (length)');
  return null;
}

export function isCosmosAddress(address: string): boolean {
  return cosmosAddressProblem(address) === null;
}

/** `cosmos1…` of raw address bytes. */
export function cosmosAddressOfBytes(bytes: Uint8Array): string {
  return bech32.encode('cosmos', bech32.toWords(bytes));
}
