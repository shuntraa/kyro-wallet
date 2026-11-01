// SPDX-License-Identifier: GPL-3.0-or-later
//
// Fee maths shared by all families: unit conversion, custom-fee validation,
// cost of a fee option for a given tx size.

import { formatUnits, GWEI, parseUnits } from './units';
import type { FeeEstimates, FeeParams, SizeHint } from './types';

import { intlLocale, l10n } from '@kyro/shared';
/** "8", "1,5", "0.000000001" gwei → wei. Throws on invalid input or > 9 decimals. */
export function gweiToWei(gwei: string): bigint {
  return parseUnits(gwei, 9);
}

/** wei → gwei decimal string ("." separator). */
export function weiToGwei(wei: bigint): string {
  return formatUnits(wei, 9);
}

export const SOL_BASE_FEE_LAMPORTS = 5000n;

/** Maximum cost in the chain's smallest unit (wei, sats, lamports). */
export function feeCost(params: FeeParams, size: SizeHint): bigint {
  if (params.family === 'evm' && size.family === 'evm') return params.maxFeePerGas * size.gasLimit;
  if (params.family === 'btc' && size.family === 'btc') return BigInt(Math.ceil(params.satPerVb * size.vsize));
  if (params.family === 'sol' && size.family === 'sol') {
    const priority = (params.microLamports * BigInt(size.computeUnits) + 999_999n) / 1_000_000n;
    return SOL_BASE_FEE_LAMPORTS * BigInt(size.signatures) + priority;
  }
  throw new Error(l10n('Paramètres de frais incompatibles avec la transaction', 'Fee parameters incompatible with the transaction'));
}

export interface FeeValidation {
  ok: boolean;
  /** Blocking problems. */
  errors: string[];
  /** Non-blocking: shown, the user can still sign. */
  warnings: string[];
}

const result = (errors: string[], warnings: string[]): FeeValidation => ({ ok: errors.length === 0, errors, warnings });

export interface EvmCustomFeeInput {
  maxFeeGwei: string;
  priorityGwei: string;
}

/** Parse + validate an EVM custom fee (EIP-1559). */
export function validateEvmCustomFee(input: EvmCustomFeeInput, estimates?: Pick<FeeEstimates, 'minimum' | 'options'>): FeeValidation & { params?: FeeParams } {
  const errors: string[] = [];
  const warnings: string[] = [];
  let maxFee: bigint | null = null;
  let tip: bigint | null = null;
  try {
    maxFee = gweiToWei(input.maxFeeGwei);
  } catch {
    errors.push(l10n('Frais max. par gas invalides.', 'Invalid max fee per gas.'));
  }
  try {
    tip = gweiToWei(input.priorityGwei);
  } catch {
    errors.push(l10n('Pourboire prioritaire invalide.', 'Invalid priority tip.'));
  }
  if (maxFee !== null && maxFee <= 0n) errors.push(l10n('Les frais max. doivent être supérieurs à 0.', 'The max fee must be greater than 0.'));
  if (maxFee !== null && tip !== null && tip > maxFee) errors.push(l10n('Le pourboire ne peut pas dépasser les frais max.', 'The tip cannot exceed the max fee.'));
  if (maxFee !== null && maxFee > 10_000n * GWEI) warnings.push(l10n('Frais très élevés : vérifie le montant en gwei.', 'Very high fees: check the amount in gwei.'));
  if (estimates && maxFee !== null && estimates.minimum.family === 'evm') {
    const baseFee = estimates.minimum.maxFeePerGas;
    if (maxFee < baseFee) warnings.push(l10n(`Sous le minimum du réseau (${trimGwei(baseFee)} gwei) : la transaction risque de rester bloquée.`, `Below the network minimum (${trimGwei(baseFee)} gwei): the transaction may get stuck.`));
  }
  if (tip !== null && tip === 0n) warnings.push(l10n('Sans pourboire, les validateurs peuvent ignorer ta transaction.', 'Without a tip, validators may ignore your transaction.'));
  const out = result(errors, warnings);
  return out.ok && maxFee !== null && tip !== null ? { ...out, params: { family: 'evm', maxFeePerGas: maxFee, maxPriorityFeePerGas: tip } } : out;
}

/** Parse + validate a Bitcoin fee rate (sat/vB). */
/**
 * Bitcoin-style fee rate in the smallest unit per vbyte. `opts` adapts the bounds and the unit
 * for Litecoin (litoshi/vB) and Dogecoin (koinus/octet: floor 1 000 = 0,01 DOGE/kB, ceiling
 * 100 000 = 1 DOGE/kB, Rust's bounds).
 */
export function validateBtcFeeRate(
  input: string,
  estimates?: Pick<FeeEstimates, 'minimum'>,
  opts: { unit?: string; floor?: number; ceiling?: number; high?: number } = {},
): FeeValidation & { params?: FeeParams } {
  const unit = opts.unit ?? 'sat/vB';
  const floor = opts.floor ?? 1;
  const ceiling = opts.ceiling ?? 2000;
  const s = input.trim().replace(',', '.');
  const rate = Number(s);
  if (s === '' || !Number.isFinite(rate) || !/^\d*\.?\d*$/.test(s)) return result([l10n(`Taux invalide (${unit}).`, `Invalid rate (${unit}).`)], []);
  const errors: string[] = [];
  const warnings: string[] = [];
  if (rate < floor) errors.push(l10n(`Minimum ${floor.toLocaleString(intlLocale())} ${unit} (règle de relais des nœuds).`, `Minimum ${floor.toLocaleString(intlLocale())} ${unit} (node relay rule).`));
  if (rate > ceiling) errors.push(l10n(`Taux absurde (> ${ceiling.toLocaleString(intlLocale())} ${unit}).`, `Absurd rate (> ${ceiling.toLocaleString(intlLocale())} ${unit}).`));
  else if (rate > (opts.high ?? 500)) warnings.push(l10n('Taux très élevé : vérifie avant de signer.', 'Very high rate: check before signing.'));
  if (estimates?.minimum.family === 'btc' && rate < estimates.minimum.satPerVb) {
    warnings.push(l10n(`Sous le minimum actuel (${estimates.minimum.satPerVb.toLocaleString(intlLocale())} ${unit}) : la transaction risque de ne jamais confirmer.`, `Below the current minimum (${estimates.minimum.satPerVb.toLocaleString(intlLocale())} ${unit}): the transaction may never confirm.`));
  }
  const out = result(errors, warnings);
  return out.ok ? { ...out, params: { family: 'btc', satPerVb: rate } } : out;
}

/** Parse + validate a Solana priority fee (micro-lamports per compute unit). */
export function validateSolPriorityFee(input: string): FeeValidation & { params?: FeeParams } {
  const s = input.trim();
  if (!/^\d+$/.test(s)) return result([l10n('Valeur invalide : entier en micro-lamports.', 'Invalid value: integer in micro-lamports.')], []);
  const v = BigInt(s);
  const warnings: string[] = [];
  if (v > 50_000_000n) warnings.push(l10n('Priority fee très élevée.', 'Very high priority fee.'));
  if (v === 0n) warnings.push(l10n('Sans priority fee, la transaction peut être plus lente en période chargée.', 'Without a priority fee, the transaction may be slower when the network is busy.'));
  return { ...result([], warnings), params: { family: 'sol', microLamports: v } };
}

function trimGwei(wei: bigint): string {
  const g = Number(weiToGwei(wei));
  return g >= 10 ? g.toFixed(0) : g >= 1 ? g.toFixed(1) : g.toPrecision(2);
}

/** Median of bigint list (lower median). */
export function medianBig(values: bigint[]): bigint {
  if (values.length === 0) return 0n;
  const s = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return s[Math.floor((s.length - 1) / 2)] ?? 0n;
}

/**
 * EIP-1559 options from `eth_feeHistory` (percentiles 10/50/90).
 * maxFee = baseFee × headroom + tip, headroom 1.25 / 1.5 / 2.
 */
export function evmFeeOptionsFromHistory(nextBaseFee: bigint, rewards: bigint[][], blockTimeSecs: number): FeeEstimates {
  const col = (i: number) => medianBig(rewards.map((r) => r[i] ?? 0n));
  // The RPC is not trusted: a tip is never above 3 × the next lower percentile (fast ≤ 3 × normal,
  // normal ≤ 3 × slow when slow is not 0), nor above 3 × the base fee + 2 gwei. A server that lies
  // about all of them at once is still bounded by the maximum shown before signing (and Rust's
  // 2nd confirmation above its fee threshold).
  const ceiling = nextBaseFee * 3n + 2_000_000_000n;
  const cap = (v: bigint, below: bigint | null) => {
    const c = below !== null && below > 0n && v > below * 3n ? below * 3n : v;
    return c > ceiling ? ceiling : c;
  };
  const p10 = cap(col(0), null);
  const p50 = cap(col(1), p10);
  const p90 = cap(col(2), p50);
  const mk = (num: bigint, den: bigint, tip: bigint): FeeParams => ({ family: 'evm', maxFeePerGas: (nextBaseFee * num) / den + tip, maxPriorityFeePerGas: tip });
  const block = Math.max(1, blockTimeSecs);
  return {
    options: {
      slow: { level: 'slow', params: mk(5n, 4n, p10), etaSecs: Math.round(block * 15) },
      normal: { level: 'normal', params: mk(3n, 2n, p50 > p10 ? p50 : p10), etaSecs: Math.round(block * 4) },
      fast: { level: 'fast', params: mk(2n, 1n, p90 > p50 ? p90 : p50), etaSecs: Math.round(block * 1.5) },
    },
    minimum: { family: 'evm', maxFeePerGas: nextBaseFee, maxPriorityFeePerGas: 0n },
    hint: `${trimGwei(nextBaseFee)} gwei`,
    fetchedAt: Date.now(),
  };
}
