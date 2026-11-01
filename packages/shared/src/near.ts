// SPDX-License-Identifier: GPL-3.0-or-later
//
// NEAR account ids: the same rules as wallet-core `near_account_kind` (nearcore's
// `near-account-id`), so the UI can explain a mistake before asking Rust. Rust re-checks
// everything on every command.

import type { NearAccountKind } from './ipc';
import { l10n } from './i18n';

/** 1 NEAR = 10^24 yoctoNEAR. */
export const NEAR_DECIMALS = 24;

const isLowerHex = (s: string) => /^[0-9a-f]*$/.test(s);

/**
 * Kind of a valid NEAR account id, or `null`: 2–64 characters, lowercase letters, digits and the
 * separators `-` `_` `.`, never at either end nor two in a row. Uppercase is refused (NEAR ids
 * are case-sensitive: an uppercase id is another account, or none).
 */
export function nearAccountKind(id: string): NearAccountKind | null {
  if (id.length < 2 || id.length > 64) return null;
  if (!/^[a-z0-9]+([-_.][a-z0-9]+)*$/.test(id)) return null;
  if (id.length === 64 && isLowerHex(id)) return 'implicit';
  if (id.length === 42 && id.startsWith('0x') && isLowerHex(id.slice(2))) return 'ethImplicit';
  return 'named';
}

export function isNearAccountId(id: string): boolean {
  return nearAccountKind(id) !== null;
}

/** Explanation (current language) of why `id` is not a NEAR account id (`null` when it is one). */
export function nearAccountIdProblem(input: string): string | null {
  const id = input.trim();
  if (id === '') return l10n('Saisis un compte NEAR (nom.near, nom.testnet ou 64 caractères hexadécimaux)', 'Enter a NEAR account (name.near, name.testnet or 64 hexadecimal characters)');
  if (id !== id.toLowerCase()) return l10n('Un compte NEAR s’écrit en minuscules (les majuscules désignent un autre compte, ou aucun)', 'A NEAR account is written in lowercase (uppercase means another account, or none)');
  if (id.length < 2 || id.length > 64) return l10n('Un compte NEAR fait de 2 à 64 caractères', 'A NEAR account is 2 to 64 characters long');
  if (nearAccountKind(id) === null) return l10n('Compte NEAR invalide : minuscules, chiffres et - _ . seulement, jamais au début, à la fin ni deux à la suite', 'Invalid NEAR account: lowercase letters, digits and - _ . only, never at the start, at the end or two in a row');
  return null;
}
