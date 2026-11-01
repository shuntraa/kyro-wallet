// SPDX-License-Identifier: GPL-3.0-or-later
// DEMO ONLY — a minimal Solidity ABI encoder, so the fake swap answers (mock-net.ts) carry real

import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';

export type AbiValue =
  | { t: 'address'; v: string }
  | { t: 'uint256'; v: bigint }
  | { t: 'bytes32'; v: string }
  | { t: 'bool'; v: boolean }
  | { t: 'bytes'; v: string }
  | { t: 'string'; v: string }
  | { t: 'tuple'; items: AbiValue[] }
  | { t: 'array'; items: AbiValue[] };

const word = (hex: string) => hex.padStart(64, '0');
const strip = (h: string) => (h.startsWith('0x') ? h.slice(2) : h).toLowerCase();

function dynamic(v: AbiValue): boolean {
  if (v.t === 'bytes' || v.t === 'string' || v.t === 'array') return true;
  if (v.t === 'tuple') return v.items.some(dynamic);
  return false;
}

function encodeOne(v: AbiValue): string {
  switch (v.t) {
    case 'address':
      return word(strip(v.v));
    case 'uint256':
      return word(v.v.toString(16));
    case 'bytes32':
      return strip(v.v).padEnd(64, '0');
    case 'bool':
      return word(v.v ? '1' : '0');
    case 'bytes':
    case 'string': {
      const hex = v.t === 'string' ? bytesToHex(new TextEncoder().encode(v.v)) : strip(v.v);
      const len = hex.length / 2;
      return word(len.toString(16)) + hex.padEnd(Math.ceil(len / 32) * 64, '0');
    }
    case 'tuple':
      return encodeList(v.items);
    case 'array':
      return word(v.items.length.toString(16)) + encodeList(v.items);
  }
}

/** Head/tail encoding of a list of values (function arguments, tuple members, array items). */
export function encodeList(values: AbiValue[]): string {
  // A static tuple sits in the head in full (not as one 32-byte word).
  const statics = values.map((v) => (dynamic(v) ? null : encodeOne(v)));
  let offset = statics.reduce((n, s) => n + (s === null ? 32 : s.length / 2), 0);
  const heads: string[] = [];
  const tails: string[] = [];
  values.forEach((v, i) => {
    const s = statics[i];
    if (s !== null && s !== undefined) {
      heads.push(s);
      return;
    }
    const enc = encodeOne(v);
    heads.push(word(offset.toString(16)));
    tails.push(enc);
    offset += enc.length / 2;
  });
  return heads.join('') + tails.join('');
}

/** `0x` + selector(signature) + encoded arguments. `signature`: canonical, e.g. `transfer(address,uint256)`. */
export function encodeCall(signature: string, args: AbiValue[]): string {
  const selector = bytesToHex(keccak_256(new TextEncoder().encode(signature))).slice(0, 8);
  return '0x' + selector + encodeList(args);
}
