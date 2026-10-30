// SPDX-License-Identifier: GPL-3.0-or-later
//
// Simple, predictable coin selection: largest-first, change back to our own
// change address, dust folded into the fee. Pure (no I/O), unit-tested.

export type ScriptType = 'p2wpkh' | 'p2tr' | 'p2pkh' | 'p2sh' | 'p2wsh';

export interface SelectableUtxo {
  txid: string;
  vout: number;
  value: bigint;
  type: 'p2wpkh' | 'p2tr';
}

/** Virtual sizes (vB) — witness discount applied. */
export const VBYTES = {
  overhead: 10.5,
  input: { p2wpkh: 68, p2tr: 57.5 },
  output: { p2wpkh: 31, p2tr: 43, p2pkh: 34, p2sh: 32, p2wsh: 43 },
} as const;

/** Below this, an output is uneconomical / non-standard. */
export const DUST_SATS = 546n;

export function outputTypeOf(address: string): ScriptType {
  const a = address.toLowerCase();
  if (/^(bc|tb|bcrt)1p/.test(a)) return 'p2tr';
  if (/^(bc|tb|bcrt)1q/.test(a)) return a.length > 50 ? 'p2wsh' : 'p2wpkh';
  if (/^[32]/.test(address)) return 'p2sh';
  return 'p2pkh';
}

export function estimateVsize(inputs: Array<SelectableUtxo['type']>, outputs: ScriptType[]): number {
  const ins = inputs.reduce((s, t) => s + VBYTES.input[t], 0);
  const outs = outputs.reduce((s, t) => s + VBYTES.output[t], 0);
  return Math.ceil(VBYTES.overhead + ins + outs);
}

export interface Selection {
  inputs: SelectableUtxo[];
  /** Amount paid to the recipient. */
  amount: bigint;
  /** 0n when no change output. */
  change: bigint;
  fee: bigint;
  vsize: number;
}

export class InsufficientFundsError extends Error {
  readonly needed: bigint;
  readonly available: bigint;
  constructor(needed: bigint, available: bigint) {
    super('Solde insuffisant pour couvrir le montant et les frais.');
    this.name = 'InsufficientFundsError';
    this.needed = needed;
    this.available = available;
  }
}

const feeFor = (vsize: number, feeRate: number) => BigInt(Math.ceil(vsize * feeRate));

/**
 * Largest-first selection.
 * @param target   amount for the recipient (sats)
 * @param feeRate  sat/vB
 */
export function selectCoins(utxos: SelectableUtxo[], target: bigint, feeRate: number, recipient: ScriptType, changeType: ScriptType = 'p2wpkh'): Selection {
  if (target <= 0n) throw new Error('Montant invalide');
  if (target < DUST_SATS) throw new Error(`Montant sous le seuil de poussière (${DUST_SATS} sats)`);
  const sorted = [...utxos].sort((a, b) => (a.value > b.value ? -1 : a.value < b.value ? 1 : 0));
  const chosen: SelectableUtxo[] = [];
  let sum = 0n;
  for (const u of sorted) {
    chosen.push(u);
    sum += u.value;
    const types = chosen.map((c) => c.type);
    const vsizeChange = estimateVsize(types, [recipient, changeType]);
    const feeChange = feeFor(vsizeChange, feeRate);
    if (sum >= target + feeChange) {
      const change = sum - target - feeChange;
      if (change >= DUST_SATS) return { inputs: chosen, amount: target, change, fee: feeChange, vsize: vsizeChange };
    }
    const vsizeNoChange = estimateVsize(types, [recipient]);
    const feeNoChange = feeFor(vsizeNoChange, feeRate);
    if (sum >= target + feeNoChange) {
      // The leftover is dust: it goes to the miners instead of a change output.
      return { inputs: chosen, amount: target, change: 0n, fee: sum - target, vsize: vsizeNoChange };
    }
  }
  const all = estimateVsize(sorted.map((u) => u.type), [recipient]);
  throw new InsufficientFundsError(target + feeFor(all, feeRate), sum);
}

/** Spend every UTXO to one output (MAX button). */
export function selectAll(utxos: SelectableUtxo[], feeRate: number, recipient: ScriptType): Selection {
  const sum = utxos.reduce((s, u) => s + u.value, 0n);
  const vsize = estimateVsize(utxos.map((u) => u.type), [recipient]);
  const fee = feeFor(vsize, feeRate);
  const amount = sum - fee;
  if (utxos.length === 0 || amount < DUST_SATS) throw new InsufficientFundsError(fee + DUST_SATS, sum);
  return { inputs: [...utxos], amount, change: 0n, fee, vsize };
}
