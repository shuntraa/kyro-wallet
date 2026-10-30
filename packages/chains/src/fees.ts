// SPDX-License-Identifier: GPL-3.0-or-later
//
// Fee maths shared by all families: unit conversion, custom-fee validation,
// cost of a fee option for a given tx size.

import { formatUnits, GWEI, parseUnits } from './units';
import type { FeeEstimates, FeeParams, SizeHint } from './types';

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
  throw new Error('Paramètres de frais incompatibles avec la transaction');
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
    errors.push('Frais max. par gas invalides.');
  }
  try {
    tip = gweiToWei(input.priorityGwei);
  } catch {
    errors.push('Pourboire prioritaire invalide.');
  }
  if (maxFee !== null && maxFee <= 0n) errors.push('Les frais max. doivent être supérieurs à 0.');
  if (maxFee !== null && tip !== null && tip > maxFee) errors.push('Le pourboire ne peut pas dépasser les frais max.');
  if (maxFee !== null && maxFee > 10_000n * GWEI) warnings.push('Frais très élevés : vérifie le montant en gwei.');
  if (estimates && maxFee !== null && estimates.minimum.family === 'evm') {
    const baseFee = estimates.minimum.maxFeePerGas;
    if (maxFee < baseFee) warnings.push(`Sous le minimum du réseau (${trimGwei(baseFee)} gwei) : la transaction risque de rester bloquée.`);
  }
  if (tip !== null && tip === 0n) warnings.push('Sans pourboire, les validateurs peuvent ignorer ta transaction.');
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
  if (s === '' || !Number.isFinite(rate) || !/^\d*\.?\d*$/.test(s)) return result([`Taux invalide (${unit}).`], []);
  const errors: string[] = [];
  const warnings: string[] = [];
  if (rate < floor) errors.push(`Minimum ${floor.toLocaleString('fr-FR')} ${unit} (règle de relais des nœuds).`);
  if (rate > ceiling) errors.push(`Taux absurde (> ${ceiling.toLocaleString('fr-FR')} ${unit}).`);
  else if (rate > (opts.high ?? 500)) warnings.push('Taux très élevé : vérifie avant de signer.');
  if (estimates?.minimum.family === 'btc' && rate < estimates.minimum.satPerVb) {
    warnings.push(`Sous le minimum actuel (${estimates.minimum.satPerVb.toLocaleString('fr-FR')} ${unit}) : la transaction risque de ne jamais confirmer.`);
  }
  const out = result(errors, warnings);
  return out.ok ? { ...out, params: { family: 'btc', satPerVb: rate } } : out;
}

/** Parse + validate a Solana priority fee (micro-lamports per compute unit). */
export function validateSolPriorityFee(input: string): FeeValidation & { params?: FeeParams } {
  const s = input.trim();
  if (!/^\d+$/.test(s)) return result(['Valeur invalide : entier en micro-lamports.'], []);
  const v = BigInt(s);
  const warnings: string[] = [];
  if (v > 50_000_000n) warnings.push('Priority fee très élevée.');
  if (v === 0n) warnings.push('Sans priority fee, la transaction peut être plus lente en période chargée.');
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
  const p10 = col(0);
  const p50 = col(1);
  const p90 = col(2);
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
