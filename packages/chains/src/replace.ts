// SPDX-License-Identifier: GPL-3.0-or-later
// Speed up or cancel a pending transaction: the fee maths and the refusals, shared by the Bitcoin,
// Litecoin and EVM adapters. Rust checks the same rules again before its native window
// (`utxo_check_replacement`, `evm_check_replacement`); these exist to say no early and clearly.

import { l10n, type EvmReplaceRequest, type ReplaceMode, type UtxoReplaceRequest } from '@kyro/shared';
import type { BtcUnsigned, EvmUnsigned } from './types';

/** BIP125: an input below `0xfffffffe` lets its transaction be replaced. */
export const RBF_SEQUENCE = 0xfffffffd;
/** Rust's `RBF_INCREMENTAL_PER_VB`. */
export const RBF_INCREMENTAL_PER_VB = 1n;
/** Rust counts worst-case signatures: a signed size can be this much smaller. */
export const RBF_VSIZE_MARGIN = 2;

export type ReplaceRefusal = 'confirmed' | 'notReplaceable' | 'notOurs' | 'unknown' | 'hasChild' | 'noChange' | 'tooSmall' | 'unsupported';

const REFUSALS: Record<ReplaceRefusal, [fr: string, en: string]> = {
  confirmed: ['Cette transaction est déjà confirmée : elle ne peut plus être remplacée.', 'This transaction is already confirmed: it can no longer be replaced.'],
  notReplaceable: ['Cette transaction n’a pas été envoyée comme remplaçable. Attends sa confirmation.', 'This transaction was not sent as replaceable. Wait for it to confirm.'],
  notOurs: ['Cette transaction ne vient pas de ce compte.', 'This transaction does not come from this account.'],
  unknown: ['Le réseau ne voit plus cette transaction. Réessaie dans un moment.', 'The network no longer sees this transaction. Try again in a moment.'],
  hasChild: ['Une autre transaction en attente dépend de celle-ci. Attends sa confirmation.', 'Another pending transaction depends on this one. Wait for it to confirm.'],
  noChange: ['Cette transaction n’a pas de monnaie pour payer plus de frais. Tu peux l’annuler ou attendre.', 'This transaction has no change to pay a higher fee. You can cancel it or wait.'],
  tooSmall: ['Le montant est trop petit pour payer ces frais.', 'The amount is too small to pay this fee.'],
  unsupported: ['Ce type de transaction ne peut pas être remplacé.', 'This kind of transaction cannot be replaced.'],
};

export class ReplaceRefused extends Error {
  constructor(readonly reason: ReplaceRefusal) {
    const [fr, en] = REFUSALS[reason];
    super(l10n(fr, en));
    this.name = 'ReplaceRefused';
  }
}

export interface UtxoReplacementPlan {
  family: 'utxo';
  mode: ReplaceMode;
  unsigned: BtcUnsigned;
  replaces: UtxoReplaceRequest;
  recipient: string;
  amount: bigint;
  oldFee: bigint;
  newFee: bigint;
}

export interface EvmReplacementPlan {
  family: 'evm';
  mode: ReplaceMode;
  unsigned: EvmUnsigned;
  replaces: EvmReplaceRequest;
  recipient: string;
  amount: bigint;
  /** Maximum fees (gas limit × max fee): the real cost is usually lower. */
  oldFee: bigint;
  newFee: bigint;
}

export type ReplacementPlan = UtxoReplacementPlan | EvmReplacementPlan;

/** What this costs on top of the original (a cheaper cancel of a heavy transaction costs nothing more). */
export const extraCost = (p: Pick<ReplacementPlan, 'oldFee' | 'newFee'>): bigint => (p.newFee > p.oldFee ? p.newFee - p.oldFee : 0n);

export const isRbfSignaled = (sequences: readonly number[]): boolean => sequences.some((s) => s < 0xfffffffe);

/** Fee a replacement of `vsize` must pay at least (BIP125 rules 3 and 4). */
export const rbfMinFee = (oldFee: bigint, vsize: number): bigint => oldFee + BigInt(vsize) * RBF_INCREMENTAL_PER_VB;

const feeAtRate = (rate: number, vsize: number): bigint => BigInt(Math.ceil(rate * vsize));

export interface SpeedUpOutput {
  value: bigint;
  /** Pays one of our keys. */
  own: boolean;
  /** Below this the output would not relay. */
  dust: bigint;
}

/**
 * A speed-up: the new fee, and the index of the change output that pays for it. Only our own change
 * ever gives anything; a send with no change, or too little, is refused rather than touching the
 * payment.
 */
export function planSpeedUp(outputs: readonly SpeedUpOutput[], oldFee: bigint, vsize: number, rate: number): { fee: bigint; change: number; newChange: bigint } {
  const min = rbfMinFee(oldFee, vsize);
  const wanted = feeAtRate(rate, vsize);
  const fee = wanted > min ? wanted : min;
  let change = -1;
  outputs.forEach((o, i) => {
    if (o.own && (change < 0 || o.value > (outputs[change]?.value ?? 0n))) change = i;
  });
  const chosen = outputs[change];
  if (!chosen) throw new ReplaceRefused('noChange');
  const newChange = chosen.value - (fee - oldFee);
  if (newChange < chosen.dust) throw new ReplaceRefused('noChange');
  return { fee, change, newChange };
}

/** A cancel: everything back to one of our addresses, minus the new fee. */
export function planCancel(total: bigint, oldFee: bigint, vsize: number, rate: number, dust: bigint): { fee: bigint; value: bigint } {
  const min = rbfMinFee(oldFee, vsize);
  const wanted = feeAtRate(rate, vsize);
  const fee = wanted > min ? wanted : min;
  const value = total - fee;
  if (value < dust) throw new ReplaceRefused('tooSmall');
  return { fee, value };
}

/** Same as Rust's `evm_min_replacement_fee`: +10% rounded up, 1 wei at least. */
export function evmMinReplacementFee(old: bigint): bigint {
  const bump = (old + 9n) / 10n;
  return old + (bump > 0n ? bump : 1n);
}

export interface EvmFees {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/** Fees of a same-nonce replacement: the live level, or the node's minimum if that is higher. */
export function evmReplacementFees(old: EvmFees, live: EvmFees): EvmFees {
  const big = (a: bigint, b: bigint) => (a > b ? a : b);
  const maxPriorityFeePerGas = big(live.maxPriorityFeePerGas, evmMinReplacementFee(old.maxPriorityFeePerGas));
  return { maxPriorityFeePerGas, maxFeePerGas: big(big(live.maxFeePerGas, evmMinReplacementFee(old.maxFeePerGas)), maxPriorityFeePerGas) };
}

/** Pending, not sent to us: what the History screen offers to speed up or cancel. */
export function canReplace(e: { status: string; direction: string; suspect?: unknown }, family: string | undefined): boolean {
  return e.status === 'pending' && e.direction !== 'in' && !e.suspect && (family === 'btc' || family === 'ltc' || family === 'evm');
}
