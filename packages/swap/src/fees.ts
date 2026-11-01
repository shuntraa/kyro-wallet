// SPDX-License-Identifier: GPL-3.0-or-later
//
// Kyro swap fee: the ONE place where it is configured.
//
// Kyro is open source: this fee is public, and anyone building Kyro from source can change it,
// set it to 0 or remove it. Its rate follows a declining curve of the swap value in USD
// (`KYRO_FEE_CURVE`). It is already deducted from the amount shown (« Frais de service inclus »,
// linked to kyrowallet.com/frais), and is collected on-chain by each provider's OFFICIAL
// integrator-fee mechanism, never by an extra transfer added by Kyro. Details, parameters and doc links: docs/SWAP_FEES.md.
//
// Rule: every swap carries the fee. A provider that cannot collect it with the current settings
// (missing recipient, Solana pair without a fee mint…) is left out of the quotes, with the reason; it is never used fee-free behind the user's
// back, and Kyro never sends a fee to an address it cannot validate.

import { isAddress, sha256 } from 'viem';
import { base58, base58xrp, bech32, createBase58check } from '@scure/base';
import type { ProviderId, QuoteParams } from './types';
import { intlLocale, l10n } from '@kyro/shared';

/** One point of the fee curve: a swap worth `usd` US dollars pays `bps` basis points (70 = 0,7 %). */
export interface FeePoint {
  usd: number;
  bps: number;
}

/**
 * Kyro fee curve (docs/SWAP_FEES.md): a declining rate as the swap value in USD grows.
 * - at or below the first point (5 $): its rate (500 bps); at or above the last (10 000 $): its rate (70 bps, flat);
 * - between two points: linear interpolation on log(amount), rounded to the NEAREST integer bps
 *   (`Math.round`, .5 rounded up), see `swapFeeBps`.
 */
export const KYRO_FEE_CURVE: readonly FeePoint[] = [
  { usd: 5, bps: 500 },
  { usd: 10, bps: 200 },
  { usd: 25, bps: 180 },
  { usd: 50, bps: 160 },
  { usd: 80, bps: 140 },
  { usd: 100, bps: 120 },
  { usd: 1_000, bps: 90 },
  { usd: 10_000, bps: 70 },
];

/** Rate when the sold token has no price (its USD value is unknown). */
export const UNKNOWN_PRICE_FEE_BPS = 90;

/** What decides the Kyro rate of one swap. Every rate at 0 turns the Kyro fee off everywhere. */
export interface FeeSchedule {
  /** Points sorted by strictly increasing `usd` (> 0), integer `bps` in 0…MAX_FEE_BPS. */
  curve: readonly FeePoint[];
  /** Rate applied when the swap value in USD is unknown (no price for the sold token). */
  unknownPriceBps: number;
}

export interface SwapFeeConfig extends FeeSchedule {
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
  curve: KYRO_FEE_CURVE,
  unknownPriceBps: UNKNOWN_PRICE_FEE_BPS,
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

/** What a provider must do about the Kyro fee (built once, from the config). */
export type ProviderFee =
  /** Fee deliberately at 0: quote without fee parameters. */
  | { kind: 'none' }
  /** A FIXED rate (tests, or a fork that wants one). `recipient` = EVM address (0x, LI.FI) or Solana owner (Jupiter). */
  | { kind: 'fee'; bps: number; recipient: string }
  /**
   * The Kyro curve: the rate of each quote is `feeForQuote` (swap value in USD → `swapFeeBps`),
   * at most `maxBps`, the provider's own documented maximum (`PROVIDER_MAX_FEE_BPS`).
   */
  | { kind: 'curve'; recipient: string; schedule: FeeSchedule; maxBps: number }
  /** The fee cannot be collected through this provider: leave it out. */
  | { kind: 'unavailable'; reason: string };

/** The fee of ONE quote: what is asked for in the request AND demanded back when verifying it. */
export type QuoteFee = Exclude<ProviderFee, { kind: 'curve' }>;

/** Hard cap of any Kyro rate (the curve's highest point). Above it, the configuration is refused. */
export const MAX_FEE_BPS = 500;

/**
 * Most each provider's fee mechanism accepts (docs/SWAP_FEES.md, read 01/11/2026). The Kyro rate
 * of a quote is clamped to it:
 * - 0x: `swapFeeBps` « has a default limit of 1000 Bps » → no clamp (Kyro ≤ 500);
 * - LI.FI: `distributionFees` percentage « greater than 0 and less than 0.5 per entry » → no clamp;
 * - Jupiter: `platform_fee_bps` is a `u8` in the on-chain route instruction → 255;
 * - NEAR Intents 1Click: Kyro asks twice its rate (1Click keeps half) and the total may not
 *   exceed 500 bps (`ONE_CLICK_MAX_TOTAL_BPS`) → 250.
 */
export const PROVIDER_MAX_FEE_BPS: Readonly<Record<ProviderId, number>> = { zerox: 1_000, lifi: 4_999, jupiter: 255, near: 250 };

const validBps = (b: number) => Number.isInteger(b) && b >= 0 && b <= MAX_FEE_BPS;

/** Is the schedule usable? (non-empty curve, strictly increasing positive `usd`, integer rates ≤ MAX_FEE_BPS) */
export function validFeeSchedule(s: FeeSchedule): boolean {
  if (!Array.isArray(s.curve) || s.curve.length === 0 || !validBps(s.unknownPriceBps)) return false;
  return s.curve.every((pt, i) => Number.isFinite(pt.usd) && pt.usd > 0 && validBps(pt.bps) && (i === 0 || pt.usd > (s.curve[i - 1] as FeePoint).usd));
}

const feeOff = (s: FeeSchedule) => s.unknownPriceBps === 0 && s.curve.every((pt) => pt.bps === 0);
const scheduleOf = (cfg: FeeSchedule): FeeSchedule => ({ curve: cfg.curve, unknownPriceBps: cfg.unknownPriceBps });

/**
 * Kyro rate (integer bps) for a swap worth `usd` US dollars; null / undefined / NaN / negative =
 * unknown value → `unknownPriceBps`. Flat below the first point and above the last; between two
 * points, linear on log(usd). ROUNDING: to the nearest integer bps (`Math.round`, .5 up).
 */
export function swapFeeBps(usd: number | null | undefined, s: FeeSchedule = KYRO_SWAP_FEE): number {
  if (usd === null || usd === undefined || !Number.isFinite(usd) || usd < 0) return s.unknownPriceBps;
  const pts = s.curve;
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (!first || !last) return s.unknownPriceBps;
  if (usd <= first.usd) return first.bps;
  if (usd >= last.usd) return last.bps;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1] as FeePoint;
    const b = pts[i] as FeePoint;
    if (usd <= b.usd) {
      const t = (Math.log(usd) - Math.log(a.usd)) / (Math.log(b.usd) - Math.log(a.usd));
      return Math.round(a.bps + t * (b.bps - a.bps));
    }
  }
  return last.bps;
}

/**
 * USD value of what is sold: amount × the sold token's price (the app's price source, in the
 * user's currency) ÷ `usdToFiat` (USD → user currency). Null when the price is unknown.
 */
export function sellValueUsd(p: Pick<QuoteParams, 'sell' | 'sellAmount' | 'usdToFiat'>): number | null {
  const price = p.sell.priceFiat;
  const fx = p.usdToFiat ?? 1;
  if (price === undefined || !Number.isFinite(price) || price < 0 || !Number.isFinite(fx) || fx <= 0) return null;
  return (Number(p.sellAmount) / 10 ** p.sell.decimals) * (price / fx);
}

/**
 * The fee of one quote, computed ONCE by the provider from the quote's own parameters: the same
 * value goes into the request (0x `swapFeeBps`, LI.FI `distributionFees`, Jupiter
 * `platformFeeBps`, 1Click `appFees`) and into every check of the answer (echo, calldata,
 * transaction), and is kept as `Quote.kyroFeeBps` for the checks done at signing time.
 */
export function feeForQuote(fee: ProviderFee, p: Pick<QuoteParams, 'sell' | 'sellAmount' | 'usdToFiat'>): QuoteFee {
  if (fee.kind !== 'curve') return fee;
  const bps = Math.min(fee.maxBps, swapFeeBps(sellValueUsd(p), fee.schedule));
  return bps > 0 ? { kind: 'fee', bps, recipient: fee.recipient } : { kind: 'none' };
}

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
  if (!validFeeSchedule(cfg)) return { kind: 'unavailable', reason: l10n('Frais Kyro mal configurés', 'Kyro fees misconfigured') };
  if (feeOff(cfg)) return { kind: 'none' };
  const fee = (recipient: string): ProviderFee => ({ kind: 'curve', recipient, schedule: scheduleOf(cfg), maxBps: PROVIDER_MAX_FEE_BPS[id] });
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
 * 1Click's account `5880ad…47dd`; `fee: 140` → 70 + 70). So Kyro requests twice the rate of
 * the quote (from the curve, at most 250 bps so the request stays ≤ 500) to be paid exactly `bps`, and checks the echo: 1Click's share at most `bps` (else refused). The docs
 * (« Fees », 01/11/2026) describe the 50/50 split for API-key holders and « your fee + 25 bps »
 * without a key; if 1Click's echo shows another split, the provider asks once more with the
 * request that pays exactly `bps` (providers/near.ts), and refuses anything else.
 */
export const ONE_CLICK_FEE_REQUEST_FACTOR = 2;
/** 1Click: Kyro's fee + 1Click's share may not exceed 500 bps (hence Kyro ≤ 250 bps there: `PROVIDER_MAX_FEE_BPS.near`). */
export const ONE_CLICK_MAX_TOTAL_BPS = 500;
/** 1Click fee: the curve (rate per quote, clamped to 250 bps). `requestBps` only goes with a fixed rate. */
export function nearIntentsAppFee(cfg: SwapFeeConfig = KYRO_SWAP_FEE): ProviderFee & { requestBps?: number } {
  return providerFee('near', cfg);
}

/**
 * LI.FI takes `distributionFees` from the SENT token on the SOURCE chain and pays them on that
 * chain: the receiver must be our address there (li.quest refuses an EVM receiver for a Solana
 * source: « is not a valid Solana address for chain 1151111081099710 », and a `bc1…` receiver
 * for Bitcoin: only `0x…` or base58 receivers are accepted).
 */
export function lifiFeeFor(source: 'evm' | 'solana' | 'bitcoin', cfg: SwapFeeConfig = KYRO_SWAP_FEE): ProviderFee {
  if (source === 'evm') return providerFee('lifi', cfg);
  if (!validFeeSchedule(cfg)) return { kind: 'unavailable', reason: l10n('Frais Kyro mal configurés', 'Kyro fees misconfigured') };
  if (feeOff(cfg)) return { kind: 'none' };
  if (source === 'solana') {
    const r = feeRecipientFor('solana', cfg);
    return r ? { kind: 'curve', recipient: r, schedule: scheduleOf(cfg), maxBps: PROVIDER_MAX_FEE_BPS.lifi } : { kind: 'unavailable', reason: l10n('Adresse Solana des frais Kyro non configurée', 'Solana address for Kyro fees not configured') };
  }
  return { kind: 'unavailable', reason: l10n('Frais Kyro impossibles depuis Bitcoin avec LI.FI (bénéficiaire bc1… refusé)', 'Kyro fees impossible from Bitcoin with LI.FI (bc1… recipient refused)') };
}

/** "0,7 %" (one quote's rate; the Swap screen never shows it). */
export function feeLabel(bps: number): string {
  return `${(bps / 100).toLocaleString(intlLocale(), { maximumFractionDigits: 2 })}${l10n(' %', '%')}`;
}
