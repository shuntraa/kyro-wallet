// SPDX-License-Identifier: GPL-3.0-or-later
//
// NEAR Intents (1Click) deposit-address check. The source tx only funds a one-time deposit address;
// where the funds go is bound off-chain, so before the password we ask 1Click's public
// `/v0/status` (docs.near-intents.org "1Click API") and require: fresh PENDING_DEPOSIT, our
// recipient and refund addresses, exact amount in, the chosen destination token, minimum out ≥ ours.

import { fetchJson, l10n, netFetch, type NetFetch } from '@kyro/shared';
import { SwapCheckError } from './verify';
import { isNative } from './providers/common';
import type { SwapChain } from './types';

export const NEAR_INTENTS_HOST = '1click.chaindefuser.com';

/** 1Click `blockchain` key per chain Kyro can route to (`GET /v0/tokens`). */
export const ONE_CLICK_CHAINS: Readonly<Record<string, string>> = {
  '1': 'eth',
  '10': 'op',
  '56': 'bsc',
  '137': 'pol',
  '8453': 'base',
  '42161': 'arb',
  '43114': 'avax',
  // Gnosis: LI.FI's NEAR Intents facet is deployed there too (deployments/gnosis.json).
  '100': 'gnosis',
  solana: 'sol',
  bitcoin: 'btc',
  litecoin: 'ltc',
  dogecoin: 'doge',
  tron: 'tron',
  xrp: 'xrp',
  cardano: 'cardano',
  bitcoincash: 'bch',
  dash: 'dash',
  zcash: 'zec',
  sui: 'sui',
  ton: 'ton',
  aptos: 'aptos',
  // Arrival only: 1Click refuses a simple deposit from Stellar (it wants a memo).
  stellar: 'stellar',
};

/** Chains 1Click delivers to but Kyro never leaves from (the deposit would need a memo). */
export const ONE_CLICK_ARRIVAL_ONLY: ReadonlySet<SwapChain> = new Set<SwapChain>(['stellar']);

/** Same account on `chain`? Hex forms compare case-insensitively, others exactly. */
export function sameChainAddress(chain: SwapChain, a: string | undefined, b: string): boolean {
  if (!a) return false;
  return typeof chain === 'number' || chain === 'sui' || chain === 'aptos' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export interface OneClickToken {
  assetId: string;
  blockchain: string;
  symbol?: string;
  decimals?: number;
  contractAddress?: string;
}

export interface OneClickStatus {
  status: string;
  quoteResponse?: {
    quoteRequest?: {
      swapType?: string;
      originAsset?: string;
      destinationAsset?: string;
      amount?: string;
      recipient?: string;
      recipientType?: string;
      refundTo?: string;
      refundType?: string;
      deadline?: string;
      depositMode?: string;
      /** `fee` in bps, `recipient` a NEAR Intents account (an EVM address in lower case for Kyro). */
      appFees?: Array<{ recipient?: string; fee?: number }>;
    };
    quote?: { depositAddress?: string; depositMemo?: string; amountIn?: string; minAmountIn?: string; amountOut?: string; minAmountOut?: string; deadline?: string; timeEstimate?: number };
  };
}

export interface NearDepositExpect {
  depositAddress: string;
  amountIn: bigint;
  fromChain: SwapChain;
  toChain: SwapChain;
  /** Token received: ERC-20 / mint, `0xEeee…` / `0x0…` / wSOL mint / `bitcoin` for the native coin. */
  buyToken: string;
  recipient: string;
  refundTo: string;
  /** Lowest minimum Kyro accepts (what it shows as « Minimum garanti »). */
  minAmountOut: bigint;
  now?: number;
  /** Direct 1Click route: the app fee that must be echoed, and a simple deposit (no memo). Absent for LI.FI routes. */
  appFee?: { recipient: string; bps: number; oneClickMaxBps: number };
  /** Least time left before the deposit deadline (ms; default: any time in the future). */
  minTimeLeftMs?: number;
}

export interface NearDepositCheck {
  minAmountOut: bigint;
  amountOut: bigint;
  destinationAsset: string;
  timeEstimateSecs: number | null;
  deadline: number;
  /** Echoed app fees (direct route): Kyro's share and the rest (1Click's). */
  kyroFeeBps: number;
  otherFeeBps: number;
}

const WSOL = 'So11111111111111111111111111111111111111112';
const fail = (why: string): never => {
  throw new SwapCheckError(l10n(`NEAR Intents : ${why} — devis refusé, rien n’a été signé.`, `NEAR Intents: ${why} — quote refused, nothing was signed.`));
};
const sameAddr = sameChainAddress;
const chainKey = (c: SwapChain) => ONE_CLICK_CHAINS[String(c)];
const nativeToken = (chain: SwapChain, t: string) => (chain === 'solana' ? t === WSOL || t === '11111111111111111111111111111111' : typeof chain === 'string' ? t === chain : isNative(t));
const big = (v: string | undefined): bigint | null => {
  try {
    return v !== undefined && /^\d+$/.test(v) ? BigInt(v) : null;
  } catch {
    return null;
  }
};

export function oneClickAssetIs(asset: OneClickToken | undefined, chain: SwapChain, token: string): boolean {
  if (!asset || asset.blockchain !== chainKey(chain)) return false;
  if (nativeToken(chain, token)) return !asset.contractAddress;
  if (!asset.contractAddress) return false;
  return sameAddr(chain, asset.contractAddress, token);
}

/** Checks a 1Click status answer against what the source transaction does. Throws `SwapCheckError`. */
export function checkNearDeposit(s: OneClickStatus, tokens: readonly OneClickToken[], e: NearDepositExpect): NearDepositCheck {
  const req = s.quoteResponse?.quoteRequest;
  const q = s.quoteResponse?.quote;
  if (!req || !q) return fail(l10n('adresse de dépôt inconnue du pont', 'deposit address unknown to the bridge'));
  if (s.status !== 'PENDING_DEPOSIT') fail(l10n(`adresse de dépôt déjà utilisée ou expirée (${s.status})`, `deposit address already used or expired (${s.status})`));
  if (!sameAddr(e.fromChain, q.depositAddress, e.depositAddress)) fail(l10n('adresse de dépôt différente de celle de la transaction', 'deposit address differs from the one in the transaction'));
  // Exact or flex input: the deposit must equal the quoted `amountIn`; the solver enforces `minAmountOut`.
  if (req.swapType !== 'EXACT_INPUT' && req.swapType !== 'FLEX_INPUT') fail(l10n('type d’échange inattendu', 'unexpected swap type'));
  if (req.recipientType !== 'DESTINATION_CHAIN' || !sameAddr(e.toChain, req.recipient, e.recipient)) fail(l10n(`destinataire ${req.recipient ?? '?'} au lieu de ton adresse`, `recipient ${req.recipient ?? '?'} instead of your address`));
  if (req.refundType !== 'ORIGIN_CHAIN' || !sameAddr(e.fromChain, req.refundTo, e.refundTo)) fail(l10n('remboursement prévu vers une autre adresse que la tienne', 'refund planned to an address other than yours'));
  const amountIn = big(q.amountIn);
  if (amountIn === null || amountIn !== e.amountIn || big(req.amount) !== e.amountIn) fail(l10n('montant déposé différent de celui attendu par le pont', 'deposited amount differs from the one the bridge expects'));
  const min = big(q.minAmountOut);
  const out = big(q.amountOut);
  if (min === null || out === null || min <= 0n) return fail(l10n('minimum garanti absent', 'guaranteed minimum missing'));
  if (min < e.minAmountOut) fail(l10n('minimum garanti par le pont plus bas que celui affiché', 'minimum guaranteed by the bridge lower than the one shown'));
  // Earlier of 1Click's deadline and ours, so a slow confirmation cannot land after either.
  const deadline = e.appFee ? Math.min(Date.parse(q.deadline ?? ''), Date.parse(req.deadline ?? '')) : Date.parse(q.deadline ?? req.deadline ?? '');
  if (!Number.isFinite(deadline) || deadline <= (e.now ?? Date.now()) + (e.minTimeLeftMs ?? 0)) fail(l10n('devis du pont expiré ou trop proche de son échéance', 'bridge quote expired or too close to its deadline'));
  const asset = tokens.find((t) => t.assetId === req.destinationAsset);
  if (!oneClickAssetIs(asset, e.toChain, e.buyToken)) fail(l10n(`token reçu (${req.destinationAsset ?? '?'}) différent de celui demandé`, `received token (${req.destinationAsset ?? '?'}) differs from the requested one`));
  let fees = { kyro: 0, other: 0 };
  if (e.appFee) {
    if ((req.depositMode ?? 'SIMPLE') !== 'SIMPLE' || q.depositMemo) fail(l10n('dépôt avec mémo demandé (Kyro n’envoie qu’un transfert simple)', 'deposit with memo requested (Kyro only sends a plain transfer)'));
    if (req.swapType !== 'EXACT_INPUT') fail(l10n('type d’échange inattendu', 'unexpected swap type'));
    fees = checkAppFees(req.appFees, e.appFee);
  }
  return { minAmountOut: min, amountOut: out, destinationAsset: req.destinationAsset ?? '', timeEstimateSecs: typeof q.timeEstimate === 'number' ? q.timeEstimate : null, deadline, kyroFeeBps: fees.kyro, otherFeeBps: fees.other };
}

/** `appFees` echo: exactly one entry for Kyro (`bps` to `recipient`), 1Click's share at most `oneClickMaxBps`. */
export function checkAppFees(fees: ReadonlyArray<{ recipient?: string; fee?: number }> | undefined, want: { recipient: string; bps: number; oneClickMaxBps: number }): { kyro: number; other: number } {
  const list = fees ?? [];
  const r = want.recipient.toLowerCase();
  const ours = list.filter((f) => (f.recipient ?? '').toLowerCase() === r);
  if (want.bps > 0) {
    if (ours.length !== 1) fail(ours.length === 0 ? l10n('frais Kyro absents du devis', 'Kyro fees missing from the quote') : l10n('frais Kyro en double', 'duplicate Kyro fees'));
    if (ours[0]?.fee !== want.bps) fail(l10n(`frais Kyro de ${ours[0]?.fee ?? '?'} bps au lieu de ${want.bps}`, `Kyro fees of ${ours[0]?.fee ?? '?'} bps instead of ${want.bps}`));
  } else if (ours.length > 0) fail(l10n('frais inattendus', 'unexpected fees'));
  let other = 0;
  for (const f of list) {
    if ((f.recipient ?? '').toLowerCase() === r) continue;
    if (!Number.isInteger(f.fee) || (f.fee as number) < 0) fail(l10n('frais du pont illisibles', 'unreadable bridge fees'));
    other += f.fee as number;
  }
  if (other > want.oneClickMaxBps) fail(l10n(`part de NEAR Intents (${other} bps) plus élevée que prévu`, `NEAR Intents share (${other} bps) higher than expected`));
  return { kyro: want.bps, other };
}

/** Reads NEAR Intents' public status + token list (cached 10 min). */
export class NearIntentsClient {
  private tokens: { at: number; list: OneClickToken[] } | null = null;
  constructor(private readonly fetcher: NetFetch = netFetch) {}

  async tokenList(force = false): Promise<OneClickToken[]> {
    if (!force && this.tokens && Date.now() - this.tokens.at < 600_000) return this.tokens.list;
    const list = await fetchJson<OneClickToken[]>(this.fetcher, `https://${NEAR_INTENTS_HOST}/v0/tokens`);
    if (!Array.isArray(list)) throw new Error(l10n('NEAR Intents : liste de tokens illisible', 'NEAR Intents: unreadable token list'));
    this.tokens = { at: Date.now(), list };
    return list;
  }

  status(depositAddress: string): Promise<OneClickStatus> {
    return fetchJson<OneClickStatus>(this.fetcher, `https://${NEAR_INTENTS_HOST}/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`);
  }

  /** Fetches and checks; network errors are reported as a refusal (fail closed). */
  async confirm(e: NearDepositExpect): Promise<NearDepositCheck> {
    let s: OneClickStatus;
    let tokens: OneClickToken[];
    try {
      [s, tokens] = await Promise.all([this.status(e.depositAddress), this.tokenList()]);
      const id = s.quoteResponse?.quoteRequest?.destinationAsset;
      if (id && !tokens.some((t) => t.assetId === id)) tokens = await this.tokenList(true);
    } catch (err) {
      return fail(l10n(`confirmation du pont impossible (${err instanceof Error ? err.message : String(err)})`, `bridge confirmation impossible (${err instanceof Error ? err.message : String(err)})`));
    }
    return checkNearDeposit(s, tokens, e);
  }
}
