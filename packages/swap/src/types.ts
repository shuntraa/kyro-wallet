// SPDX-License-Identifier: GPL-3.0-or-later

import type { SolTxSummary } from '@kyro/shared';
import type { EvmSwapCheck } from './verify';

export type ProviderId = 'zerox' | 'jupiter' | 'lifi' | 'near' | 'exolix';

/** EVM chain id, 'solana', or a chain reached only through NEAR Intents 1Click (providers/near.ts). */
export type SwapChain = number | 'solana' | UtxoOrOtherChain;
export type UtxoOrOtherChain = 'bitcoin' | 'litecoin' | 'dogecoin' | 'bitcoincash' | 'dash' | 'zcash' | 'tron' | 'xrp' | 'cardano' | 'sui' | 'ton' | 'aptos' | 'stellar' | 'monero' | 'kaspa' | 'algorand' | 'near';

export interface SwapToken {
  /** ERC-20 address, `0xEeee…` (native), Solana mint, TRC-20 contract, or the chain name for other natives. */
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
  /** Cross-chain only: our own address on `toChain`, never typed by the user. Defaults to `taker`. */
  recipient?: string;
  sell: SwapToken;
  buy: SwapToken;
  sellAmount: bigint;
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
  /** Built on demand (recent blockhash), base64 wire tx. `verify` checks it against Rust's decoding (LI.FI cross-chain). */
  | { kind: 'solana'; build: () => Promise<string>; verify?: (wire: string, summary: SolTxSummary) => Promise<SolanaRouteCheck> }
  /** NEAR Intents 1Click: no third-party tx; we send an ordinary transfer to a checked deposit address. */
  | { kind: 'deposit'; chain: SwapChain; prepare: () => Promise<DepositPlan>; reconfirm: (plan: DepositPlan) => Promise<DepositPlan> };

/** A checked 1Click deposit: send exactly `amountIn` of the sold token to `depositAddress`, nothing else. */
export interface DepositPlan {
  depositAddress: string;
  amountIn: bigint;
  amountOut: bigint;
  /** Minimum 1Click guarantees on the destination chain (else refund to our source address). */
  minAmountOut: bigint;
  deadline: number;
  /** Kyro's app fee echoed by 1Click (bps) and 1Click's own share (bps), both taken from the deposit. */
  kyroFeeBps: number;
  oneClickFeeBps: number;
  timeEstimateSecs: number | null;
  /** Exolix: the order id (status tracking, reconfirmation). */
  orderId?: string;
  /** Exolix (no affiliate program): Kyro's fee, a second ordinary transfer of the sold coin to this address. */
  kyroFee?: { recipient: string; amount: bigint };
  /** Fee speed of the deposit; Lightning asks for `fast`, because the invoice expires. */
  feeLevel?: 'normal' | 'fast';
}

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
  buyAmount: bigint;
  minBuyAmount: bigint;
  gasFeeFiat: number | null;
  providerFeeFiat: number | null;
  providerFeeIncluded: boolean;
  /** Kyro fee applied to this quote (bps, 0 = none). Already deducted from buyAmount / minBuyAmount. */
  kyroFeeBps: number;
  /** Fraction (0.0003 = 0.03 %), null when unknown. */
  priceImpact: number | null;
  allowanceTarget: string | null;
  tx: SwapTx;
  /** EVM: calldata checked by verify.ts. A quote without it is never signed. */
  evmCheck?: EvmSwapCheck;
  /** Jupiter: the fee account the swap transaction must pay (the Kyro fee wallet's token account), null without fee. */
  solFeeAccount?: string | null;
  route?: string;
  etaSecs?: number;
  /** Cross-chain route: what was checked and what the history tracks (lifi-cross.ts). */
  cross?: CrossChainInfo;
}

export interface CrossChainInfo {
  fromChain: SwapChain;
  toChain: SwapChain;
  recipient: string;
  bridge: string;
  bridgeName: string;
  /** NEAR Intents deposit address (EVM source only; Solana reads it at signing time). */
  depositAddress?: string;
}

export interface SwapProvider {
  readonly id: ProviderId;
  readonly name: string;
  readonly host: string;
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
