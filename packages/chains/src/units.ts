// SPDX-License-Identifier: GPL-3.0-or-later
//
// Exact decimal ↔ smallest-unit conversion (no floats).

import { l10n } from '@kyro/shared';

/** Parse a user decimal ("0,25", "1.5", " 12 ") into base units. Throws on invalid input or too many decimals. */
export function parseUnits(input: string, decimals: number): bigint {
  const s = input.trim().replace(/\s| | /g, '').replace(',', '.');
  if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') throw new Error(l10n('Montant invalide', 'Invalid amount'));
  const [int = '0', frac = ''] = s.split('.');
  if (frac.length > decimals) throw new Error(l10n(`Maximum ${decimals} décimales`, `Maximum ${decimals} decimals`));
  const base = 10n ** BigInt(decimals);
  return BigInt(int || '0') * base + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0');
}

/** Same as parseUnits but returns null instead of throwing. */
export function tryParseUnits(input: string, decimals: number): bigint | null {
  try {
    return parseUnits(input, decimals);
  } catch {
    return null;
  }
}

/** Base units → plain decimal string with "." separator, trailing zeros trimmed. */
export function formatUnits(value: bigint, decimals: number): string {
  const neg = value < 0n;
  const v = neg ? -value : value;
  const base = 10n ** BigInt(decimals);
  const int = v / base;
  const frac = decimals > 0 ? (v % base).toString().padStart(decimals, '0').replace(/0+$/, '') : '';
  return `${neg ? '-' : ''}${int}${frac ? '.' + frac : ''}`;
}

/** Base units → JS number (display/fiat maths only, never for amounts sent). */
export function unitsToNumber(value: bigint, decimals: number): number {
  return Number(formatUnits(value, decimals));
}

export const GWEI = 1_000_000_000n;
