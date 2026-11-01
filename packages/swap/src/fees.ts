// SPDX-License-Identifier: GPL-3.0-or-later
//
// Kyro swap fee: the ONE place where it is configured.
//
// Kyro is open source: this fee is public, and anyone building Kyro from source can change it,
// set it to 0 or remove it. It is shown to the user before every swap (« Frais Kyro 0,7 % ») and
// is collected on-chain by each provider's OFFICIAL integrator-fee mechanism, never by an extra
// transfer added by Kyro. Details, parameters and doc links: docs/SWAP_FEES.md.
//
// Rule: every swap carries the fee. A provider that cannot collect it with the current settings
// (missing recipient, Solana pair without a fee mint…) is left out of the quotes, with the reason; it is never used fee-free behind the user's
// back, and Kyro never sends a fee to an address it cannot validate.

import { isAddress } from 'viem';
import { base58 } from '@scure/base';
import type { ProviderId } from './types';
import { intlLocale, l10n } from '@kyro/shared';

export interface SwapFeeConfig {
  /** Fee in basis points: 70 = 0,7 %. 0 turns the Kyro fee off everywhere. Hard cap: 100 (1 %). */
  bps: number;
  recipients: {
    /** EVM address (0x…) paid on every EVM chain by 0x and LI.FI. */
    evm: string;
    /** Solana WALLET address (not a token account). It must own an initialised token account for each mint in `solanaFeeMints`. */
    solana: string;
  };
  /**
   * Mints Jupiter may pay the fee in (Metis `feeAccount` must be an initialised token account of
   * the input or output mint, owned by `recipients.solana`). Currently USDC only: a Solana pair
   * without USDC on either side cannot carry the fee and gets no Jupiter quote. To also accept
   * wrapped SOL, create the fee wallet's wSOL token account, then add
   * 'So11111111111111111111111111111111111111112' here.
   */
  solanaFeeMints: readonly string[];
}

export const KYRO_SWAP_FEE: SwapFeeConfig = {
  bps: 70,
  recipients: {
    evm: '0x86cD9af8067fF5e0001c709a550cD62b5e968B44',
    solana: 'ptsbLdrhmEfC2eQ9gj4aieF4irdhQqYzK1fdNwHBZcM',
  },
  solanaFeeMints: [
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC (token account checked on-chain 31/10/2026)
  ],
};

/** What a provider must do about the Kyro fee. */
export type ProviderFee =
  /** Fee deliberately at 0: quote without fee parameters. */
  | { kind: 'none' }
  /** `recipient` = EVM address (0x, LI.FI) or Solana owner (Jupiter). */
  | { kind: 'fee'; bps: number; recipient: string }
  /** The fee cannot be collected through this provider: leave it out. */
  | { kind: 'unavailable'; reason: string };

export const MAX_FEE_BPS = 100;

export function validSolanaAddress(a: string): boolean {
  try {
    return base58.decode(a).length === 32;
  } catch {
    return false;
  }
}

const validEvm = (a: string) => isAddress(a, { strict: false });

/** Fee instructions for one provider under a config (default: KYRO_SWAP_FEE). */
export function providerFee(id: ProviderId, cfg: SwapFeeConfig = KYRO_SWAP_FEE): ProviderFee {
  if (!Number.isInteger(cfg.bps) || cfg.bps < 0 || cfg.bps > MAX_FEE_BPS) return { kind: 'unavailable', reason: l10n('Frais Kyro mal configurés', 'Kyro fees misconfigured') };
  if (cfg.bps === 0) return { kind: 'none' };
  const fee = (recipient: string): ProviderFee => ({ kind: 'fee', bps: cfg.bps, recipient });
  switch (id) {
    case 'zerox':
      return validEvm(cfg.recipients.evm) ? fee(cfg.recipients.evm) : { kind: 'unavailable', reason: l10n('Adresse EVM des frais Kyro non configurée', 'EVM address for Kyro fees not configured') };
    case 'lifi':
      return validEvm(cfg.recipients.evm) ? fee(cfg.recipients.evm) : { kind: 'unavailable', reason: l10n('Adresse EVM des frais Kyro non configurée', 'EVM address for Kyro fees not configured') };
    case 'jupiter':
      return validSolanaAddress(cfg.recipients.solana) ? fee(cfg.recipients.solana) : { kind: 'unavailable', reason: l10n('Adresse Solana des frais Kyro non configurée', 'Solana address for Kyro fees not configured') };
  }
}

/** "0,7 %" */
export function feeLabel(bps: number): string {
  return `${(bps / 100).toLocaleString(intlLocale(), { maximumFractionDigits: 2 })}${l10n(' %', '%')}`;
}
