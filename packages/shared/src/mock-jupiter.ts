// SPDX-License-Identifier: GPL-3.0-or-later
//
// DEMO ONLY — a Jupiter-shaped swap transaction (legacy message, no lookup table) with the same
// instructions and account layout as a live lite-api.jup.ag `route`, so that Kyro's check
// (packages/swap/src/jupiter-verify.ts) runs on it exactly as on a real one. Includes the
// program-derived address (ATA) derivation, with the ed25519 « off curve » test it needs.

import { base58, base64 } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2';

const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const SYSTEM = '11111111111111111111111111111111';
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
const JUP6 = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const JUP_EVENT_AUTHORITY = 'D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf';
export const DEMO_WSOL = 'So11111111111111111111111111111111111111112';

// ---------------------------------------------------------------- ed25519 curve test

const P = 2n ** 255n - 19n;
const mod = (a: bigint) => ((a % P) + P) % P;
function pow(b: bigint, e: bigint): bigint {
  let r = 1n;
  let x = mod(b);
  while (e > 0n) {
    if (e & 1n) r = mod(r * x);
    x = mod(x * x);
    e >>= 1n;
  }
  return r;
}
const D = mod(-121665n * pow(121666n, P - 2n));

/** Same rule as curve25519-dalek's `decompress().is_some()`: (y² − 1) / (d·y² + 1) is a square. */
export function onCurve(bytes: Uint8Array): boolean {
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(bytes[i] ?? 0);
  y = mod(y & ((1n << 255n) - 1n));
  const y2 = mod(y * y);
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);
  if (u === 0n) return true;
  const w = mod(u * pow(v, P - 2n));
  return pow(w, (P - 1n) / 2n) === 1n;
}

/** `findProgramAddress`: highest bump whose hash is off the curve. */
export function demoFindPda(seeds: Uint8Array[], program: string): string {
  const prog = base58.decode(program);
  const marker = new TextEncoder().encode('ProgramDerivedAddress');
  for (let bump = 255; bump >= 0; bump--) {
    const h = sha256(new Uint8Array([...seeds.flatMap((s) => [...s]), bump, ...prog, ...marker]));
    if (!onCurve(h)) return base58.encode(h);
  }
  throw new Error('no PDA');
}

export function demoAta(owner: string, mint: string, tokenProgram = TOKEN): string {
  return demoFindPda([base58.decode(owner), base58.decode(tokenProgram), base58.decode(mint)], ATA);
}

// ---------------------------------------------------------------- transaction

const u32 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const u64 = (n: bigint) => Array.from({ length: 8 }, (_, i) => Number((n >> BigInt(8 * i)) & 0xffn));
const shortvec = (n: number): number[] => {
  const out: number[] = [];
  let v = n;
  for (;;) {
    const b = v & 0x7f;
    v >>= 7;
    if (v === 0) return [...out, b];
    out.push(b | 0x80);
  }
};

export interface DemoJupiterSwap {
  taker: string;
  inputMint: string;
  outputMint: string;
  inAmount: bigint;
  outAmount: bigint;
  slippageBps: number;
  platformFeeBps: number;
  feeAccount: string | null;
}

/** Base64 wire transaction (one empty signature slot), Jupiter `route` layout. */
export function demoJupiterWireTx(p: DemoJupiterSwap): string {
  const wsolAta = demoAta(p.taker, DEMO_WSOL);
  const source = demoAta(p.taker, p.inputMint);
  const destination = demoAta(p.taker, p.outputMint);
  const writable = [...new Set([source, destination, ...(p.feeAccount ? [p.feeAccount] : []), ...(p.inputMint === DEMO_WSOL || p.outputMint === DEMO_WSOL ? [wsolAta] : [])])];
  const readonly = [TOKEN, JUP6, COMPUTE_BUDGET, SYSTEM, p.outputMint, JUP_EVENT_AUTHORITY].filter((k) => !writable.includes(k));
  const keys = [p.taker, ...writable, ...readonly];
  const at = (k: string) => {
    const i = keys.indexOf(k);
    if (i < 0) throw new Error(`demo: key ${k}`);
    return i;
  };
  const ix = (program: string, accounts: string[], data: number[]) => [at(program), ...shortvec(accounts.length), ...accounts.map(at), ...shortvec(data.length), ...data];
  const ixs: number[][] = [ix(COMPUTE_BUDGET, [], [2, ...u32(300_000)])];
  if (p.inputMint === DEMO_WSOL) {
    ixs.push(ix(SYSTEM, [p.taker, wsolAta], [...u32(2), ...u64(p.inAmount)]));
    ixs.push(ix(TOKEN, [wsolAta], [17]));
  }
  const route = [0xe5, 0x17, 0xcb, 0x97, 0x7a, 0xe3, 0xad, 0x2a, ...u32(1), 0x1a, 100, 0, 1, ...u64(p.inAmount), ...u64(p.outAmount), p.slippageBps & 0xff, (p.slippageBps >> 8) & 0xff, p.platformFeeBps];
  ixs.push(ix(JUP6, [TOKEN, p.taker, source, destination, JUP6, p.outputMint, p.feeAccount ?? JUP6, JUP_EVENT_AUTHORITY, JUP6], route));
  if (p.outputMint === DEMO_WSOL) ixs.push(ix(TOKEN, [wsolAta, p.taker, p.taker], [9]));
  const blockhash = sha256(new TextEncoder().encode('demo-blockhash'));
  const msg = [1, 0, readonly.length, ...shortvec(keys.length), ...keys.flatMap((k) => [...base58.decode(k)]), ...blockhash, ...shortvec(ixs.length), ...ixs.flat()];
  const wire = new Uint8Array(1 + 64 + msg.length);
  wire[0] = 1;
  wire.set(msg, 65);
  return base64.encode(wire);
}
