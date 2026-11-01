// SPDX-License-Identifier: GPL-3.0-or-later
//
// Zcash transparent address encoding for the interface (display, validation, demo mode). Rust
// (wallet-core `zcash.rs`) stays the authority: it re-parses every destination before building,
// and refuses shielded and unified addresses itself.
//
// Base58check with Zcash's two-byte prefixes (protocol spec §5.6.1.1): P2PKH `t1…` 0x1cb8 /
// testnet `tm…` 0x1d25, P2SH `t3…` 0x1cbd / testnet `t2…` 0x1cba. TEX (ZIP 320): bech32m,
// HRP `tex` / `textest`, 20-byte key hash. Hashes from @noble/hashes, encodings from @scure/base.

import { bech32m, createBase58check } from '@scure/base';
import { ripemd160 } from '@noble/hashes/legacy';
import { sha256 } from '@noble/hashes/sha2';
import type { Network } from './ipc';

const b58c = createBase58check(sha256);

const PREFIX: Record<Network, { p2pkh: [number, number]; p2sh: [number, number]; tex: string }> = {
  mainnet: { p2pkh: [0x1c, 0xb8], p2sh: [0x1c, 0xbd], tex: 'tex' },
  testnet: { p2pkh: [0x1d, 0x25], p2sh: [0x1c, 0xba], tex: 'textest' },
};

export type ZecDestinationKind = 'p2pkh' | 'p2sh' | 'tex';

/** `t1…` (`tm…`) address of a compressed public key. */
export function zecP2pkhAddress(pubkey: Uint8Array, network: Network): string {
  const hash = ripemd160(sha256(pubkey));
  return b58c.encode(Uint8Array.from([...PREFIX[network].p2pkh, ...hash]));
}

/** P2PKH script (hex) of a compressed public key, as the Esplora shapes carry it. */
export function zecP2pkhScriptHex(pubkey: Uint8Array): string {
  const hash = ripemd160(sha256(pubkey));
  return `76a914${Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('')}88ac`;
}

/**
 * Why Kyro will not pay this address, for an address that looks shielded or unified (Sapling
 * `zs…`, Sprout `zc…`, unified `u1…`); `null` otherwise.
 */
export function zecShieldedRefusal(address: string): string | null {
  const a = address.trim().toLowerCase();
  if (/^(zs1|ztestsapling1|zregtestsapling1)/.test(a)) return 'Adresse protégée Sapling (zs…) : pas encore prise en charge. Kyro n’envoie qu’à des adresses transparentes (t1…, t3…, tex1…).';
  if (/^(u1|utest1|uregtest1)/.test(a)) return 'Adresse unifiée (u1…) : pas encore prise en charge. Demande au destinataire son adresse transparente (t1…).';
  if (/^z[ct][1-9a-hj-np-z]{60,}$/.test(a)) return 'Adresse protégée Sprout (zc…) : pas prise en charge. Kyro n’envoie qu’à des adresses transparentes (t1…, t3…).';
  return null;
}

/** Kind of a Zcash destination Kyro can pay on `network`, `null` if invalid (or shielded). */
export function zecDestinationKind(address: string, network: Network): ZecDestinationKind | null {
  const a = address.trim();
  if (!a || zecShieldedRefusal(a)) return null;
  const p = PREFIX[network];
  if (a.toLowerCase().startsWith(`${p.tex}1`)) {
    try {
      const { prefix, words } = bech32m.decode(a as `${string}1${string}`, 90);
      return prefix.toLowerCase() === p.tex && bech32m.fromWords(words).length === 20 ? 'tex' : null;
    } catch {
      return null;
    }
  }
  try {
    const raw = b58c.decode(a);
    if (raw.length !== 22) return null;
    if (raw[0] === p.p2pkh[0] && raw[1] === p.p2pkh[1]) return 'p2pkh';
    if (raw[0] === p.p2sh[0] && raw[1] === p.p2sh[1]) return 'p2sh';
    return null;
  } catch {
    return null;
  }
}
