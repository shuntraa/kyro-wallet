// SPDX-License-Identifier: GPL-3.0-or-later

export type ProviderId = 'zerox' | 'jupiter' | 'lifi';

/** EVM chain id, or 'solana'. */
export type SwapChain = number | 'solana';

export interface SwapToken {
  /** ERC-20 address, `0xEeee…` for the native coin, or a Solana mint. */
  address: string;
  symbol: string;
  decimals: number;
  /** Fiat price per whole token, if known (used for fee/net comparison). */
  priceFiat?: number;
}

export interface QuoteParams {
  chain: SwapChain;
  /** Cross-chain destination (LI.FI only). Defaults to `chain`. */
  toChain?: SwapChain;
  sell: SwapToken;
  buy: SwapToken;
  /** Base units of `sell`. */
  sellAmount: bigint;
  /** Our address (taker / fee payer). */
  taker: string;
  /** e.g. 50 = 0.5 %. */
  slippageBps: number;
  /** Fiat price of the chain's native coin (gas). */
  nativePriceFiat?: number;
  /** USD → user currency rate for providers that report fees in USD. Default 1. */
  usdToFiat?: number;
}

export type SwapTx =
  | { kind: 'evm'; chainId: number; to: string; data: `0x${string}`; value: bigint; gas?: bigint }
  /** Built on demand (the transaction embeds a recent blockhash). Returns a base64 wire transaction. */
  | { kind: 'solana'; build: () => Promise<string> };

export interface Quote {
  provider: ProviderId;
  providerName: string;
  /** Expected amount received, base units of `buy`. */
  buyAmount: bigint;
  /** Guaranteed minimum after slippage. */
  minBuyAmount: bigint;
  gasFeeFiat: number | null;
  providerFeeFiat: number | null;
  /** True when the provider fee is already deducted from buyAmount. */
  providerFeeIncluded: boolean;
  /** Kyro fee applied to this quote (bps, 0 = none). Already deducted from buyAmount / minBuyAmount. */
  kyroFeeBps: number;
  /** Fraction (0.0003 = 0.03 %), null when unknown. */
  priceImpact: number | null;
  /** Contract that needs an ERC-20 allowance; null for native sells / Solana. */
  allowanceTarget: string | null;
  tx: SwapTx;
  /** Human route ("Uniswap V3 + Curve"). */
  route?: string;
  etaSecs?: number;
}

export interface SwapProvider {
  readonly id: ProviderId;
  readonly name: string;
  readonly host: string;
  /** False when the provider needs an API key that isn't configured. */
  available(): boolean;
  /** Why it can't be used right now (missing key, Kyro fee not collectable…), or null. */
  unavailableReason(): string | null;
  supports(params: QuoteParams): boolean;
  quote(params: QuoteParams): Promise<Quote>;
}

export class SwapUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SwapUnavailableError';
  }
}
