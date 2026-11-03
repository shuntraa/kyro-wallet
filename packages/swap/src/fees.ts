// SPDX-License-Identifier: GPL-3.0-or-later
//
// Kyro swap fee config. Public and editable by anyone building from source (docs/SWAP_FEES.md).
// Collected only via each provider's official integrator-fee mechanism. A provider that cannot
// collect it is left out of the quotes: never fee-free, never to an unvalidated address.

import { isAddress, sha256 } from 'viem';
import { base32, base58, base58xrp, bech32, createBase58check } from '@scure/base';
import { keccak_256 } from '@noble/hashes/sha3';
import { sha512_256 } from '@noble/hashes/sha2';
import type { ProviderId, QuoteParams } from './types';
import { intlLocale, l10n } from '@kyro/shared';

/** One point of the fee curve: a swap worth `usd` US dollars pays `bps` basis points (70 = 0,7 %). */
export interface FeePoint {
  usd: number;
  bps: number;
}

/** Declining rate vs swap value in USD; log-interpolated between points, rounded to nearest bps. */
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
  curve: readonly FeePoint[];
  unknownPriceBps: number;
}

export interface SwapFeeConfig extends FeeSchedule {
  recipients: {
    /** EVM address (0x…) paid on every EVM chain by 0x and LI.FI. */
    evm: string;
    /** Solana WALLET address (not a token account). It must own an initialised token account for each mint in `solanaFeeMints`. */
    solana: string;
    /** Held for later routes; no provider pays fees on these chains today (docs/SWAP_FEES.md). Validated anyway. */
    bitcoin?: string;
    litecoin?: string;
    dogecoin?: string;
    tron?: string;
    xrp?: string;
    cardano?: string;
    /** Exolix sends FROM these chains (a second transfer on the source chain). Empty: no route from it (never fee-free). */
    monero?: string;
    kaspa?: string;
    algorand?: string;
    /** NEAR implicit account (64 lowercase hex). */
    near?: string;
  };
  /** THORChain affiliate THORName. Empty means no THORChain route (never fee-free). */
  thorname?: string;
  /**
   * Mints Jupiter may pay the fee in: `feeAccount` must be an initialised token account of `recipients.solana`.
   * To accept wSOL, create the fee wallet's wSOL token account first.
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
    xrp: 'rBxjMcoZ3X6Q89MjBxvuJBrZq6CctimSZf',
    cardano: 'addr1qy9d3jctafj2cgfm8sgllfjkrxrgxn9mz9dy0qzxuwscx6c2mr9sh6ny4ssnk0q3l7n9vxvxsdxtky26g7qydcapsd4sux3dj3',
    monero: '49DAQ21kb2eAjpNKAYsg6hJVJGqoj3fRdHBEyUqG1zydPbCvLmt3WyxUKVYKYMpjSqUKeruBo3YuSdyjoFG5TvQ3JcBze6A',
    kaspa: 'kaspa:qqxazzgtyn5352uzj2nzugg6cr3pct8rzpxphc2q73m67km7zrdv6dh8ctekt',
    algorand: 'F6X4KFXUPNMILGKMTDRT3CN76DJFKMOJYVV7ENOAZPCUAZCGWCDPR2HLL4',
    near: '8a8b179c1ac354da90b8d16bf7661ab7fe60de3fd7c99cd37f1150cd884cfbc4',
  },
  thorname: '',
  solanaFeeMints: [
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC (token account checked on-chain 31/10/2026)
  ],
};

/** What a provider must do about the Kyro fee (built once, from the config). */
export type ProviderFee =
  | { kind: 'none' }
  | { kind: 'fee'; bps: number; recipient: string }
  /** Per-quote rate from the curve, clamped to the provider's documented maximum. */
  | { kind: 'curve'; recipient: string; schedule: FeeSchedule; maxBps: number }
  | { kind: 'unavailable'; reason: string };

/** The fee of ONE quote: what is asked for in the request AND demanded back when verifying it. */
export type QuoteFee = Exclude<ProviderFee, { kind: 'curve' }>;

/** Hard cap of any Kyro rate (the curve's highest point). Above it, the configuration is refused. */
export const MAX_FEE_BPS = 500;

/**
 * Max each provider's fee mechanism accepts (docs/SWAP_FEES.md). Jupiter's `platform_fee_bps` is a u8;
 * 1Click gets twice our rate (it keeps half) with a 500 bps total cap.
 */
export const PROVIDER_MAX_FEE_BPS: Readonly<Record<ProviderId, number>> = { zerox: 1_000, lifi: 4_999, jupiter: 255, near: 250, exolix: 500 };

const validBps = (b: number) => Number.isInteger(b) && b >= 0 && b <= MAX_FEE_BPS;

export function validFeeSchedule(s: FeeSchedule): boolean {
  if (!Array.isArray(s.curve) || s.curve.length === 0 || !validBps(s.unknownPriceBps)) return false;
  return s.curve.every((pt, i) => Number.isFinite(pt.usd) && pt.usd > 0 && validBps(pt.bps) && (i === 0 || pt.usd > (s.curve[i - 1] as FeePoint).usd));
}

const feeOff = (s: FeeSchedule) => s.unknownPriceBps === 0 && s.curve.every((pt) => pt.bps === 0);
const scheduleOf = (cfg: FeeSchedule): FeeSchedule => ({ curve: cfg.curve, unknownPriceBps: cfg.unknownPriceBps });

/** Kyro rate in bps for a swap worth `usd`; unknown value uses `unknownPriceBps`. */
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

/** USD value of the sold amount, or null when the price is unknown. */
export function sellValueUsd(p: Pick<QuoteParams, 'sell' | 'sellAmount' | 'usdToFiat'>): number | null {
  const price = p.sell.priceFiat;
  const fx = p.usdToFiat ?? 1;
  if (price === undefined || !Number.isFinite(price) || price < 0 || !Number.isFinite(fx) || fx <= 0) return null;
  return (Number(p.sellAmount) / 10 ** p.sell.decimals) * (price / fx);
}

/** Fee of one quote, computed once: the same value goes in the request and in every check of the answer. */
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

export type FeeChain = 'evm' | 'solana' | 'bitcoin' | 'litecoin' | 'dogecoin' | 'tron' | 'xrp' | 'cardano' | 'monero' | 'kaspa' | 'algorand' | 'near';

const XMR_B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** Encoded length (chars) of a Monero base58 block of `i` bytes. */
const XMR_BLOCK_CHARS = [0, 2, 3, 5, 6, 7, 9, 10, 11];

/** Monero base58 (8-byte blocks of 11 chars, the last one shorter), `null` when malformed. */
function xmrBase58(a: string): Uint8Array | null {
  const out: number[] = [];
  for (let i = 0; i < a.length; i += 11) {
    const chunk = a.slice(i, i + 11);
    const bytes = XMR_BLOCK_CHARS.indexOf(chunk.length);
    if (bytes <= 0) return null;
    let n = 0n;
    for (const ch of chunk) {
      const d = XMR_B58.indexOf(ch);
      if (d < 0) return null;
      n = n * 58n + BigInt(d);
    }
    if (n >> BigInt(bytes * 8) !== 0n) return null;
    for (let b = bytes - 1; b >= 0; b--) out.push(Number((n >> BigInt(b * 8)) & 0xffn));
  }
  return Uint8Array.from(out);
}

/** Standard (18) or subaddress (42) mainnet Monero address, keccak-256 checksum. */
function validMonero(a: string): boolean {
  if (a.length !== 95) return false;
  const b = xmrBase58(a);
  if (!b || b.length !== 69 || (b[0] !== 18 && b[0] !== 42)) return false;
  const h = keccak_256(b.subarray(0, 65));
  return h.subarray(0, 4).every((x, i) => x === b[65 + i]);
}

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const CASHADDR_GEN = [0x98f2bc8e61n, 0x79b76d99e2n, 0xf33e5fb3c4n, 0xae2eabe2a8n, 0x1e4f43e470n];

/** Kaspa mainnet address (`kaspa:` + cashaddr-style 40-bit checksum): Schnorr, ECDSA or P2SH payload. */
function validKaspa(a: string): boolean {
  const m = /^kaspa:([qpzry9x8gf2tvdw0s3jn54khce6mua7l]+)$/.exec(a);
  if (!m?.[1]) return false;
  const data = [...m[1]].map((c) => BECH32_CHARSET.indexOf(c));
  let c = 1n;
  for (const d of [...[...'kaspa'].map((ch) => ch.charCodeAt(0) & 31), 0, ...data]) {
    const c0 = c >> 35n;
    c = ((c & 0x07ffffffffn) << 5n) ^ BigInt(d);
    CASHADDR_GEN.forEach((g, i) => {
      if ((c0 >> BigInt(i)) & 1n) c ^= g;
    });
  }
  if ((c ^ 1n) !== 0n) return false;
  const version = (data[0] ?? 0) >> 2;
  const bytes = Math.floor(((data.length - 8) * 5) / 8) - 1;
  return ((version === 0 || version === 8) && bytes === 32) || (version === 1 && bytes === 33);
}

/** Algorand address: base32 of the public key (32 B) + the last 4 bytes of its SHA-512/256. */
function validAlgorand(a: string): boolean {
  if (!/^[A-Z2-7]{58}$/.test(a)) return false;
  try {
    const b = base32.decode(`${a}======`);
    if (b.length !== 36) return false;
    const h = sha512_256(b.subarray(0, 32));
    return h.subarray(28).every((x, i) => x === b[32 + i]);
  } catch {
    return false;
  }
}

/** Mainnet address check (format + checksum) per chain. */
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
    case 'monero':
      return validMonero(a);
    case 'kaspa':
      return validKaspa(a);
    case 'algorand':
      return validAlgorand(a);
    case 'near':
      // Implicit account only: 64 lowercase hex (an ed25519 public key).
      return /^[0-9a-f]{64}$/.test(a);
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

/** Fee recipient on `chain`, or null when missing or malformed (the provider is then left out). */
export function feeRecipientFor(chain: FeeChain, cfg: SwapFeeConfig = KYRO_SWAP_FEE): string | null {
  const a = cfg.recipients[chain];
  return a && validFeeAddress(chain, a) ? a : null;
}

/** THORName check (THORChain rules: 1–30 chars, a-z 0-9 _ + - .); null when unset or invalid. */
export function thornameFor(cfg: SwapFeeConfig = KYRO_SWAP_FEE): string | null {
  const n = cfg.thorname ?? '';
  return /^[a-z0-9_+\-.]{1,30}$/.test(n) ? n : null;
}

export function providerFee(id: ProviderId, cfg: SwapFeeConfig = KYRO_SWAP_FEE): ProviderFee {
  if (!validFeeSchedule(cfg)) return { kind: 'unavailable', reason: l10n('Frais Kyro mal configurés', 'Kyro fees misconfigured') };
  if (feeOff(cfg)) return { kind: 'none' };
  const fee = (recipient: string): ProviderFee => ({ kind: 'curve', recipient, schedule: scheduleOf(cfg), maxBps: PROVIDER_MAX_FEE_BPS[id] });
  switch (id) {
    case 'zerox':
      return validEvm(cfg.recipients.evm) ? fee(cfg.recipients.evm) : { kind: 'unavailable', reason: l10n('Adresse EVM des frais Kyro non configurée', 'EVM address for Kyro fees not configured') };
    case 'lifi':
      return validEvm(cfg.recipients.evm) ? fee(cfg.recipients.evm) : { kind: 'unavailable', reason: l10n('Adresse EVM des frais Kyro non configurée', 'EVM address for Kyro fees not configured') };
    case 'jupiter':
      return validSolanaAddress(cfg.recipients.solana) ? fee(cfg.recipients.solana) : { kind: 'unavailable', reason: l10n('Adresse Solana des frais Kyro non configurée', 'Solana address for Kyro fees not configured') };
    case 'near':
      // NEAR Intents account of the EVM fee address (lower case, as NEAR account ids are).
      return validEvm(cfg.recipients.evm) ? fee(cfg.recipients.evm.toLowerCase()) : { kind: 'unavailable', reason: l10n('Adresse EVM des frais Kyro non configurée', 'EVM address for Kyro fees not configured') };
    case 'exolix':
      // No affiliate: paid by a second transfer to Kyro's address on the SOURCE chain (`exolixFeeRecipients`).
      return fee('');
  }
}

/** Kyro fee addresses Exolix routes pay on their source chain (only the valid ones). */
export type ExolixFeeChain = 'evm' | 'solana' | 'bitcoin' | 'litecoin' | 'tron' | 'dogecoin' | 'monero' | 'kaspa' | 'algorand' | 'near';
export function exolixFeeRecipients(cfg: SwapFeeConfig = KYRO_SWAP_FEE): Partial<Record<ExolixFeeChain, string>> {
  const out: Partial<Record<ExolixFeeChain, string>> = {};
  for (const c of ['evm', 'solana', 'bitcoin', 'litecoin', 'tron', 'dogecoin', 'monero', 'kaspa', 'algorand', 'near'] as const) {
    const a = feeRecipientFor(c, cfg);
    if (a) out[c] = a;
  }
  return out;
}

/**
 * NEAR Intents 1Click `appFees` (docs.near-intents.org "Fee configuration"): 1Click splits the
 * requested fee 50/50, so Kyro requests twice its rate and checks the echoed split (providers/near.ts).
 */
export const ONE_CLICK_FEE_REQUEST_FACTOR = 2;
export const ONE_CLICK_MAX_TOTAL_BPS = 500;
export function nearIntentsAppFee(cfg: SwapFeeConfig = KYRO_SWAP_FEE): ProviderFee & { requestBps?: number } {
  return providerFee('near', cfg);
}

/** LI.FI pays `distributionFees` on the source chain, so the receiver must be our address there (no bc1… receivers). */
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

export function feeLabel(bps: number): string {
  return `${(bps / 100).toLocaleString(intlLocale(), { maximumFractionDigits: 2 })}${l10n(' %', '%')}`;
}
