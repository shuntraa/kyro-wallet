// SPDX-License-Identifier: GPL-3.0-or-later

import type { SolTxSummary } from '@kyro/shared';
import type { EvmSwapCheck } from './verify';

export type ProviderId = 'zerox' | 'jupiter' | 'lifi';

/** EVM chain id, 'solana' or 'bitcoin' (Bitcoin: cross-chain destination only, see lifi-cross.ts). */
export type SwapChain = number | 'solana' | 'bitcoin';

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
  /**
   * Cross-chain only: OUR OWN address on `toChain` (the account the UI selected for that chain,
   * never typed by the user). Defaults to `taker` (same EVM address on another EVM chain).
   */
  recipient?: string;
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
  /**
   * Built on demand (the transaction embeds a recent blockhash). Returns a base64 wire transaction.
   * `verify` (LI.FI cross-chain): checks the built transaction against Rust's decoding and confirms
   * the bridge deposit with NEAR Intents; throws on any mismatch. Without it: Jupiter (jupiter-verify.ts).
   */
  | { kind: 'solana'; build: () => Promise<string>; verify?: (wire: string, summary: SolTxSummary) => Promise<SolanaRouteCheck> };

export interface SolanaRouteCheck {
  depositAddress: string;
  amountIn: bigint;
  kyroFee: bigint;
  /** Minimum the bridge guarantees on the destination chain. */
  minAmountOut: bigint;
}

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
  /**
   * EVM: what Kyro decoded and checked in the calldata (verify.ts): entry contract, recipient,
   * enforced minimum, Kyro fee. A quote without it is never signed.
   */
  evmCheck?: EvmSwapCheck;
  /** Jupiter: the fee account the swap transaction must pay (the Kyro fee wallet's token account), null without fee. */
  solFeeAccount?: string | null;
  /** Human route ("Uniswap V3 + Curve"). */
  route?: string;
  etaSecs?: number;
  /** Cross-chain route: what was checked and what the history tracks (lifi-cross.ts). */
  cross?: CrossChainInfo;
}

export interface CrossChainInfo {
  fromChain: SwapChain;
  toChain: SwapChain;
  /** Our address on `toChain` (checked in the transaction and with the bridge). */
  recipient: string;
  /** LI.FI bridge key (`near` = NEAR Intents) and its name. */
  bridge: string;
  bridgeName: string;
  /**
   * NEAR Intents deposit address bound to this quote (EVM source: read in the calldata; Solana
   * source: read in the transaction built at signing time, so absent here).
   */
  depositAddress?: string;
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
