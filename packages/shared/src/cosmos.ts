// SPDX-License-Identifier: GPL-3.0-or-later
//
// Cosmos Hub address shape for the interface (Send screen, adapter, demo). Rust checks the same
// rules again on every command (wallet-core `cosmos_address_bytes`): this is for messages only.

import { bech32 } from '@scure/base';

/**
 * Why `address` is not a Cosmos Hub account address (null = it is): bech32 (not bech32m)
 * checksum, prefix `cosmos`, 20 bytes (key) or 32 bytes (module / interchain account), not mixed
 * case. A validator operator address (`cosmosvaloper1…`) or another chain's (`osmo1…`) is named.
 */
export function cosmosAddressProblem(address: string): string | null {
  const a = address.trim();
  if (a === '') return 'Adresse vide';
  if (a !== a.toLowerCase() && a !== a.toUpperCase()) return 'Adresse Cosmos invalide (majuscules et minuscules mélangées)';
  let dec: { prefix: string; words: number[] };
  try {
    dec = bech32.decode(a.toLowerCase() as `${string}1${string}`, 120);
  } catch {
    return 'Adresse Cosmos invalide (somme de contrôle)';
  }
  if (dec.prefix === 'cosmosvaloper' || dec.prefix === 'cosmosvalcons') return 'C’est l’adresse d’un validateur, pas d’un compte : envoie à une adresse cosmos1…';
  if (dec.prefix !== 'cosmos') return `Adresse d’une autre chaîne (« ${dec.prefix}1… ») : Kyro n’envoie des ATOM que sur Cosmos Hub (cosmos1…)`;
  let len: number;
  try {
    len = bech32.fromWords(dec.words).length;
  } catch {
    return 'Adresse Cosmos invalide (longueur)';
  }
  if (len !== 20 && len !== 32) return 'Adresse Cosmos invalide (longueur)';
  return null;
}

export function isCosmosAddress(address: string): boolean {
  return cosmosAddressProblem(address) === null;
}

/** `cosmos1…` of raw address bytes. */
export function cosmosAddressOfBytes(bytes: Uint8Array): string {
  return bech32.encode('cosmos', bech32.toWords(bytes));
}
