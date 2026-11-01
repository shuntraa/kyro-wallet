// SPDX-License-Identifier: GPL-3.0-or-later
//
// NEAR Intents (1Click), the bridge LI.FI routes Kyro's cross-chain swaps through. The source
// transaction only sends the funds to a one-time DEPOSIT ADDRESS; where they go next (recipient,
// destination token, minimum) is the 1Click quote bound to that address, off-chain. So, before the
// password, Kyro asks NEAR Intents itself (`GET 1click.chaindefuser.com/v0/status?depositAddress=…`,
// public, no key; docs.near-intents.org « 1Click API ») what that deposit address will do and
// accepts it only if:
//
// - status = PENDING_DEPOSIT (fresh, not already used), exact input, deadline in the future;
// - recipient = OUR address on the destination chain, delivered there (`DESTINATION_CHAIN`);
// - refund = OUR source address, on the source chain (`ORIGIN_CHAIN`);
// - amount in = exactly what the transaction deposits;
// - destination asset = the token the user picked on the chain the user picked (resolved with
//   `GET /v0/tokens`: blockchain + contract);
// - minimum out ≥ the minimum Kyro shows (calldata / slippage bound).
//
// This is a second, independent party (the bridge, not the aggregator) confirming the route.
// What it cannot prove: that the 1Click solver network will actually deliver (refund otherwise).

import { fetchJson, netFetch, type NetFetch } from '@kyro/shared';
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
  solana: 'sol',
  bitcoin: 'btc',
};

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
    };
    quote?: { depositAddress?: string; amountIn?: string; minAmountIn?: string; amountOut?: string; minAmountOut?: string; deadline?: string; timeEstimate?: number };
  };
}

export interface NearDepositExpect {
  depositAddress: string;
  /** Exact amount the source transaction deposits (base units of the sent token). */
  amountIn: bigint;
  fromChain: SwapChain;
  toChain: SwapChain;
  /** Token received: ERC-20 / mint, `0xEeee…` / `0x0…` / wSOL mint / `bitcoin` for the native coin. */
  buyToken: string;
  /** Our address on `toChain`. */
  recipient: string;
  /** Our address on `fromChain` (refunds). */
  refundTo: string;
  /** Lowest minimum Kyro accepts (what it shows as « Minimum garanti »). */
  minAmountOut: bigint;
  /** Now, ms (tests). */
  now?: number;
}

export interface NearDepositCheck {
  minAmountOut: bigint;
  amountOut: bigint;
  destinationAsset: string;
  timeEstimateSecs: number | null;
}

const WSOL = 'So11111111111111111111111111111111111111112';
const fail = (why: string): never => {
  throw new SwapCheckError(`NEAR Intents : ${why} — devis refusé, rien n’a été signé.`);
};
const sameAddr = (chain: SwapChain, a: string | undefined, b: string) => {
  if (!a) return false;
  return typeof chain === 'number' ? a.toLowerCase() === b.toLowerCase() : a === b;
};
const chainKey = (c: SwapChain) => ONE_CLICK_CHAINS[String(c)];
const nativeToken = (chain: SwapChain, t: string) => (chain === 'solana' ? t === WSOL || t === '11111111111111111111111111111111' : chain === 'bitcoin' ? t === 'bitcoin' : isNative(t));
const big = (v: string | undefined): bigint | null => {
  try {
    return v !== undefined && /^\d+$/.test(v) ? BigInt(v) : null;
  } catch {
    return null;
  }
};

/** Does `asset` (1Click token) stand for `token` on `chain`? */
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
  if (!req || !q) return fail('adresse de dépôt inconnue du pont');
  if (s.status !== 'PENDING_DEPOSIT') fail(`adresse de dépôt déjà utilisée ou expirée (${s.status})`);
  if (!sameAddr(e.fromChain, q.depositAddress, e.depositAddress)) fail('adresse de dépôt différente de celle de la transaction');
  // EXACT_INPUT (Solana source) or FLEX_INPUT (LI.FI's EVM facet): the output is converted from what
  // is deposited, never a fixed output paid by a larger deposit. Either way the deposit must be
  // exactly the quoted `amountIn` (checked below) and `minAmountOut` is enforced by the solver.
  if (req.swapType !== 'EXACT_INPUT' && req.swapType !== 'FLEX_INPUT') fail('type d’échange inattendu');
  if (req.recipientType !== 'DESTINATION_CHAIN' || !sameAddr(e.toChain, req.recipient, e.recipient)) fail(`destinataire ${req.recipient ?? '?'} au lieu de ton adresse`);
  if (req.refundType !== 'ORIGIN_CHAIN' || !sameAddr(e.fromChain, req.refundTo, e.refundTo)) fail('remboursement prévu vers une autre adresse que la tienne');
  const amountIn = big(q.amountIn);
  if (amountIn === null || amountIn !== e.amountIn || big(req.amount) !== e.amountIn) fail('montant déposé différent de celui attendu par le pont');
  const min = big(q.minAmountOut);
  const out = big(q.amountOut);
  if (min === null || out === null || min <= 0n) return fail('minimum garanti absent');
  if (min < e.minAmountOut) fail('minimum garanti par le pont plus bas que celui affiché');
  const deadline = Date.parse(q.deadline ?? req.deadline ?? '');
  if (!Number.isFinite(deadline) || deadline <= (e.now ?? Date.now())) fail('devis du pont expiré');
  const asset = tokens.find((t) => t.assetId === req.destinationAsset);
  if (!oneClickAssetIs(asset, e.toChain, e.buyToken)) fail(`token reçu (${req.destinationAsset ?? '?'}) différent de celui demandé`);
  return { minAmountOut: min, amountOut: out, destinationAsset: req.destinationAsset ?? '', timeEstimateSecs: typeof q.timeEstimate === 'number' ? q.timeEstimate : null };
}

/** Reads NEAR Intents' public status + token list (cached 10 min). */
export class NearIntentsClient {
  private tokens: { at: number; list: OneClickToken[] } | null = null;
  constructor(private readonly fetcher: NetFetch = netFetch) {}

  async tokenList(): Promise<OneClickToken[]> {
    if (this.tokens && Date.now() - this.tokens.at < 600_000) return this.tokens.list;
    const list = await fetchJson<OneClickToken[]>(this.fetcher, `https://${NEAR_INTENTS_HOST}/v0/tokens`);
    if (!Array.isArray(list)) throw new Error('NEAR Intents : liste de tokens illisible');
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
    } catch (err) {
      return fail(`confirmation du pont impossible (${err instanceof Error ? err.message : String(err)})`);
    }
    return checkNearDeposit(s, tokens, e);
  }
}
