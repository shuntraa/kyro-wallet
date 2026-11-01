// SPDX-License-Identifier: GPL-3.0-or-later
//
// Kyro swap fee: the ONE place where it is configured.
//
// Kyro is open source: this fee is public, and anyone building Kyro from source can change it,
// set it to 0 or remove it. It is already deducted from the amount shown, counted in the
// confirmation's « Frais inclus » total before signing, and is collected on-chain by each provider's OFFICIAL integrator-fee mechanism, never by an extra
// transfer added by Kyro. Details, parameters and doc links: docs/SWAP_FEES.md.
//
// Rule: every swap carries the fee. A provider that cannot collect it with the current settings
// (missing recipient, Solana pair without a fee mint…) is left out of the quotes, with the reason; it is never used fee-free behind the user's
// back, and Kyro never sends a fee to an address it cannot validate.

import { isAddress, sha256 } from 'viem';
import { base58, base58xrp, bech32, createBase58check } from '@scure/base';
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
    /**
     * Addresses on the other chains Kyro holds. Each is used ONLY where a provider's official fee
     * mechanism pays the fee to an address on that (source) chain; none does today (docs/SWAP_FEES.md,
     * « Autres chaînes »): LI.FI refuses a non-EVM/non-Solana `distributionFees` receiver, and
     * THORChain / NEAR Intents pay their affiliate / app fees to a THORName / NEAR Intents account
     * (swaps from these chains go through NEAR Intents, fee to the NEAR Intents account of `evm`:
     * `nearIntentsAppFee`). They are validated anyway (`feeRecipientFor`), so a route added later
     * can never pay a malformed one.
     */
    bitcoin?: string;
    litecoin?: string;
    dogecoin?: string;
    tron?: string;
    xrp?: string;
    cardano?: string;
  };
  /**
   * THORChain affiliate (THORName, e.g. `kyro`): THORChain pays `affiliate_bps` to a THORName or a
   * `thor1…` address, not to an address on the source chain. Empty ⇒ no THORChain route (never fee-free).
   */
  thorname?: string;
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
    bitcoin: 'bc1qta8efdy72ge9qy8yj8s0ckwar0lg44ggwnaard',
    litecoin: 'LWePW8iwa8RxxYB6av4KBriBNkRgLWvNyw',
    dogecoin: 'DKCSjtypvD9qg3R175YdijmwvKh5FnAU14',
    tron: 'TT9j25bsbBAgxCDEXTN1cpjcD54Jz51pES',
    // Self-custody account: no destination tag.
    xrp: 'rBxjMcoZ3X6Q89MjBxvuJBrZq6CctimSZf',
    cardano: 'addr1qy9d3jctafj2cgfm8sgllfjkrxrgxn9mz9dy0qzxuwscx6c2mr9sh6ny4ssnk0q3l7n9vxvxsdxtky26g7qydcapsd4sux3dj3',
  },
  // Not registered yet: THORChain stays out.
  thorname: '',
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

const b58check = createBase58check((d) => sha256(d, 'bytes'));
const xrpCheck = (a: string) => {
  // Same double-SHA256 checksum as base58check, over the Ripple alphabet.
  const raw = base58xrp.decode(a);
  if (raw.length !== 25) return null;
  const body = raw.slice(0, 21);
  const sum = sha256(sha256(body, 'bytes'), 'bytes').slice(0, 4);
  return sum.every((b, i) => b === raw[21 + i]) ? body : null;
};
const versioned = (a: string, version: number) => {
  try {
    const raw = b58check.decode(a);
    return raw.length === 21 && raw[0] === version;
  } catch {
    return false;
  }
};
const segwit = (a: string, hrp: string) => {
  try {
    const d = bech32.decode(a as `${string}1${string}`);
    if (d.prefix !== hrp || d.words[0] !== 0) return false;
    const program = bech32.fromWords(d.words.slice(1));
    return program.length === 20 || program.length === 32;
  } catch {
    return false;
  }
};

/** Fee recipient chains: the two used today and the ones held for later routes. */
export type FeeChain = 'evm' | 'solana' | 'bitcoin' | 'litecoin' | 'dogecoin' | 'tron' | 'xrp' | 'cardano';

/**
 * Mainnet address check per chain (format + checksum), as strict as the chain allows: Bitcoin
 * SegWit v0 `bc1q…`, Litecoin `L…`/`M…` or `ltc1q…`, Dogecoin `D…` (P2PKH), TRON `T…` (0x41),
 * XRP classic `r…` (double-SHA256 checksum, Ripple alphabet), Cardano Shelley `addr1…` (bech32).
 */
export function validFeeAddress(chain: FeeChain, a: string): boolean {
  if (!a) return false;
  switch (chain) {
    case 'evm':
      return validEvm(a);
    case 'solana':
      return validSolanaAddress(a);
    case 'bitcoin':
      return segwit(a.toLowerCase() === a ? a : '', 'bc');
    case 'litecoin':
      return versioned(a, 0x30) || versioned(a, 0x32) || segwit(a.toLowerCase() === a ? a : '', 'ltc');
    case 'dogecoin':
      return versioned(a, 0x1e);
    case 'tron':
      return versioned(a, 0x41);
    case 'xrp':
      try {
        const body = xrpCheck(a);
        return body !== null && body[0] === 0x00;
      } catch {
        return false;
      }
    case 'cardano':
      try {
        const d = bech32.decode(a as `${string}1${string}`, 200);
        const bytes = bech32.fromWords(d.words);
        // Shelley mainnet: network id 1 in the header's low nibble, payment+stake (57 B) or enterprise (29 B).
        return d.prefix === 'addr' && ((bytes[0] ?? 0) & 0x0f) === 1 && (bytes.length === 57 || bytes.length === 29);
      } catch {
        return false;
      }
  }
}

/**
 * The Kyro fee recipient on `chain`, or null when it is missing or malformed (that route's
 * provider is then left out, never used fee-free).
 */
export function feeRecipientFor(chain: FeeChain, cfg: SwapFeeConfig = KYRO_SWAP_FEE): string | null {
  const a = cfg.recipients[chain];
  return a && validFeeAddress(chain, a) ? a : null;
}

/** THORName check (THORChain rules: 1–30 chars, a-z 0-9 _ + - .); null when unset or invalid. */
export function thornameFor(cfg: SwapFeeConfig = KYRO_SWAP_FEE): string | null {
  const n = cfg.thorname ?? '';
  return /^[a-z0-9_+\-.]{1,30}$/.test(n) ? n : null;
}

/** Fee instructions for one provider under a config (default: KYRO_SWAP_FEE). */
export function providerFee(id: ProviderId, cfg: SwapFeeConfig = KYRO_SWAP_FEE): ProviderFee {
  if (!Number.isInteger(cfg.bps) || cfg.bps < 0 || cfg.bps > MAX_FEE_BPS) return { kind: 'unavailable', reason: l10n('Frais Kyro mal configurés', 'Kyro fees misconfigured') };
  if (cfg.bps === 0) return { kind: 'none' };
  const fee = (recipient: string): ProviderFee => ({ kind: 'fee', bps: cfg.bps, recipient });
  switch (id) {
    case 'zerox':
      return validEvm(cfg.recipients.evm) ? fee(cfg.recipients.evm) : { kind: 'unavailable', reason: l10n('Adresse EVM des frais Kyro non configurée', 'EVM address for Kyro fees not configured') };
    case 'lifi':
      // EVM sources; a Solana source uses `lifiFeeFor('solana')`.
      return validEvm(cfg.recipients.evm) ? fee(cfg.recipients.evm) : { kind: 'unavailable', reason: l10n('Adresse EVM des frais Kyro non configurée', 'EVM address for Kyro fees not configured') };
    case 'jupiter':
      return validSolanaAddress(cfg.recipients.solana) ? fee(cfg.recipients.solana) : { kind: 'unavailable', reason: l10n('Adresse Solana des frais Kyro non configurée', 'Solana address for Kyro fees not configured') };
    case 'near':
      // NEAR Intents account of the EVM fee address (lower case, as NEAR account ids are).
      return validEvm(cfg.recipients.evm) ? fee(cfg.recipients.evm.toLowerCase()) : { kind: 'unavailable', reason: l10n('Adresse EVM des frais Kyro non configurée', 'EVM address for Kyro fees not configured') };
  }
}

/**
 * NEAR Intents 1Click `appFees` (docs.near-intents.org « Fee configuration », checked against live
 * quotes 01/11/2026): the fee is taken from the DEPOSITED token and credited to a NEAR Intents
 * account (`recipient`: « a named account, an implicit account, or an EVM-style address ») —
 * Kyro uses `recipients.evm` in lower case, the NEAR Intents account its EVM key controls. 1Click
 * then SPLITS the requested fee 50/50 with itself (live answer: `fee: 70` → 35 to us + 35 to
 * 1Click's account `5880ad…47dd`; `fee: 140` → 70 + 70). So Kyro requests twice its rate to be
 * paid exactly `bps`, and checks the echo: 1Click's share at most `bps` (else refused). The docs
 * (« Fees », 01/11/2026) describe the 50/50 split for API-key holders and « your fee + 25 bps »
 * without a key; if 1Click's echo shows another split, the provider asks once more with the
 * request that pays exactly `bps` (providers/near.ts), and refuses anything else.
 */
export const ONE_CLICK_FEE_REQUEST_FACTOR = 2;
/** 1Click: Kyro's fee + 1Click's share may not exceed 500 bps. */
export const ONE_CLICK_MAX_TOTAL_BPS = 500;
export function nearIntentsAppFee(cfg: SwapFeeConfig = KYRO_SWAP_FEE): ProviderFee & { requestBps?: number } {
  const f = providerFee('near', cfg);
  if (f.kind !== 'fee') return f;
  const requestBps = f.bps * ONE_CLICK_FEE_REQUEST_FACTOR;
  if (requestBps > ONE_CLICK_MAX_TOTAL_BPS) return { kind: 'unavailable', reason: l10n('Frais Kyro trop élevés pour NEAR Intents', 'Kyro fees too high for NEAR Intents') };
  return { ...f, requestBps };
}

/**
 * LI.FI takes `distributionFees` from the SENT token on the SOURCE chain and pays them on that
 * chain: the receiver must be our address there (li.quest refuses an EVM receiver for a Solana
 * source: « is not a valid Solana address for chain 1151111081099710 », and a `bc1…` receiver
 * for Bitcoin: only `0x…` or base58 receivers are accepted).
 */
export function lifiFeeFor(source: 'evm' | 'solana' | 'bitcoin', cfg: SwapFeeConfig = KYRO_SWAP_FEE): ProviderFee {
  if (source === 'evm') return providerFee('lifi', cfg);
  if (!Number.isInteger(cfg.bps) || cfg.bps < 0 || cfg.bps > MAX_FEE_BPS) return { kind: 'unavailable', reason: l10n('Frais Kyro mal configurés', 'Kyro fees misconfigured') };
  if (cfg.bps === 0) return { kind: 'none' };
  if (source === 'solana') {
    const r = feeRecipientFor('solana', cfg);
    return r ? { kind: 'fee', bps: cfg.bps, recipient: r } : { kind: 'unavailable', reason: l10n('Adresse Solana des frais Kyro non configurée', 'Solana address for Kyro fees not configured') };
  }
  return { kind: 'unavailable', reason: l10n('Frais Kyro impossibles depuis Bitcoin avec LI.FI (bénéficiaire bc1… refusé)', 'Kyro fees impossible from Bitcoin with LI.FI (bc1… recipient refused)') };
}

/** "0,7 %" */
export function feeLabel(bps: number): string {
  return `${(bps / 100).toLocaleString(intlLocale(), { maximumFractionDigits: 2 })}${l10n(' %', '%')}`;
}
