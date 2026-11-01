// SPDX-License-Identifier: GPL-3.0-or-later
//
// Kaspa addresses (`kaspa:` mainnet, `kaspatest:` testnet-10): CashAddr-style bech32 with the
// BCH polymod, exactly as rusty-kaspa `crypto/addresses/src/bech32.rs` and wallet-core
// `kaspa_address_decode` (lowercase only, network prefix required, checksum, version byte
// 0 = P2PK Schnorr / 1 = P2PK ECDSA / 8 = P2SH, payload length, canonical form). Used by the UI
// to validate input early and by the demo backend; Rust re-checks everything.

import type { Network } from './ipc';

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

export type KaspaAddressKind = 'pubKey' | 'pubKeyEcdsa' | 'scriptHash';

const VERSION: Record<KaspaAddressKind, number> = { pubKey: 0, pubKeyEcdsa: 1, scriptHash: 8 };
const LENGTH: Record<KaspaAddressKind, number> = { pubKey: 32, pubKeyEcdsa: 33, scriptHash: 32 };

export function kaspaPrefix(network: Network): 'kaspa' | 'kaspatest' {
  return network === 'mainnet' ? 'kaspa' : 'kaspatest';
}

function polymod(values: number[]): bigint {
  const gen = [0x98f2bc8e61n, 0x79b76d99e2n, 0xf33e5fb3c4n, 0xae2eabe2a8n, 0x1e4f43e470n];
  let c = 1n;
  for (const d of values) {
    const c0 = c >> 35n;
    c = ((c & 0x07ffffffffn) << 5n) ^ BigInt(d);
    for (let i = 0; i < 5; i++) if ((c0 >> BigInt(i)) & 1n) c ^= gen[i]!;
  }
  return c ^ 1n;
}

function checksum(prefix: string, payload5: number[]): bigint {
  return polymod([...[...prefix].map((ch) => ch.charCodeAt(0) & 0x1f), 0, ...payload5, 0, 0, 0, 0, 0, 0, 0, 0]);
}

function conv(data: number[], from: number, to: number, pad: boolean): number[] {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const max = (1 << to) - 1;
  for (const v of data) {
    acc = ((acc << from) | v) & 0xffffff;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & max);
    }
  }
  if (pad && bits > 0) out.push((acc << (to - bits)) & max);
  return out;
}

/** Encodes `payload` (32 or 33 bytes) as an address of `kind` on `network`. */
export function kaspaAddressEncode(network: Network, kind: KaspaAddressKind, payload: Uint8Array): string {
  if (payload.length !== LENGTH[kind]) throw new Error('longueur de clé Kaspa invalide');
  const prefix = kaspaPrefix(network);
  const five = conv([VERSION[kind], ...payload], 8, 5, true);
  const sum = checksum(prefix, five);
  const sumBytes: number[] = [];
  for (let i = 4; i >= 0; i--) sumBytes.push(Number((sum >> BigInt(8 * i)) & 0xffn));
  const sum5 = conv(sumBytes, 8, 5, true);
  return `${prefix}:${[...five, ...sum5].map((v) => CHARSET[v]).join('')}`;
}

/** Decodes an address of `network`; `null` if it is not a valid, canonical one. */
export function kaspaAddressDecode(network: Network, address: string): { kind: KaspaAddressKind; payload: Uint8Array } | null {
  const a = address.trim();
  const prefix = kaspaPrefix(network);
  if (!a.startsWith(`${prefix}:`)) return null;
  const data = a.slice(prefix.length + 1);
  const five: number[] = [];
  for (const ch of data) {
    const v = CHARSET.indexOf(ch);
    if (v < 0) return null;
    five.push(v);
  }
  if (five.length < 10) return null;
  const payload5 = five.slice(0, -8);
  const sum8 = conv(five.slice(-8), 5, 8, false);
  if (sum8.length !== 5) return null;
  let want = 0n;
  for (const b of sum8) want = (want << 8n) | BigInt(b);
  if (checksum(prefix, payload5) !== want) return null;
  const raw = conv(payload5, 5, 8, false);
  const kind = (Object.keys(VERSION) as KaspaAddressKind[]).find((k) => VERSION[k] === raw[0]);
  if (!kind || raw.length - 1 !== LENGTH[kind]) return null;
  const payload = new Uint8Array(raw.slice(1));
  return kaspaAddressEncode(network, kind, payload) === a ? { kind, payload } : null;
}

export function isKaspaAddress(address: string, network: Network): boolean {
  return kaspaAddressDecode(network, address) !== null;
}

/** Why `address` cannot receive KAS on `network` (French), or `null` if it can. */
export function kaspaAddressProblem(address: string, network: Network): string | null {
  const a = address.trim();
  if (isKaspaAddress(a, network)) return null;
  const other: Network = network === 'mainnet' ? 'testnet' : 'mainnet';
  if (isKaspaAddress(a, other)) return network === 'mainnet' ? 'adresse Kaspa de testnet (kaspatest:), pas du réseau principal' : 'adresse Kaspa du réseau principal (kaspa:), pas de testnet';
  if (a !== a.toLowerCase() && isKaspaAddress(a.toLowerCase(), network)) return 'adresse Kaspa en majuscules : saisis-la en minuscules';
  return `adresse Kaspa invalide (elle commence par ${kaspaPrefix(network)}:)`;
}
