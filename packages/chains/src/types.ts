// SPDX-License-Identifier: GPL-3.0-or-later

import type { BtcTxSummary, EvmTokenHint, EvmTxRequest, EvmTxSummary } from '@kyro/shared';
import type { AssetDef, Chain, Family } from './registry';
import type { UtxoSigned, UtxoUnsigned } from './utxo/utxo';
import type { TronSigned, TronUnsigned } from './tron/adapter';
import type { XrpSigned, XrpUnsigned } from './xrp/adapter';
import type { CardanoSigned, CardanoUnsigned } from './cardano/adapter';
import type { CardanoTokenSpec } from '@kyro/shared';

import { l10n } from '@kyro/shared';
export type FeeLevel = 'slow' | 'normal' | 'fast';
export type FeeChoice = FeeLevel | 'custom';

/** Fee parameters, per family. Custom fees use the same shapes. */
export type FeeParams =
  | { family: 'evm'; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }
  | { family: 'btc'; satPerVb: number }
  | { family: 'sol'; microLamports: bigint }
  /** TRON: no fee to choose. Rust burns bandwidth / energy (estimate shown, `fee_limit` caps it). */
  | { family: 'tron' }
  /** XRP Ledger: no fee to choose. Rust sets `Fee` from the open ledger (≈ 12 drops). */
  | { family: 'xrp' }
  /** Cardano: no fee to choose. Rust computes min_fee_a × size + min_fee_b. */
  | { family: 'ada' };

export interface FeeOption {
  level: FeeLevel;
  params: FeeParams;
  /** Rough confirmation delay. */
  etaSecs: number;
}

export interface FeeEstimates {
  options: Record<FeeLevel, FeeOption>;
  /** Network floor: EVM next base fee, BTC minimum relay fee, Solana 0. */
  minimum: FeeParams;
  /** Human hint ("4,2 gwei", "3 sat/vB"). */
  hint: string;
  fetchedAt: number;
  /**
   * Bitcoin compact filters: rates are the average of the fees paid in the last blocks, not a
   * mempool estimate. The UI says so and suggests the custom rate.
   */
  source?: 'block-average';
}

/** What the size of a tx is, so fee options can be priced without rebuilding. */
export type SizeHint =
  | { family: 'evm'; gasLimit: bigint }
  | { family: 'btc'; vsize: number }
  | { family: 'sol'; computeUnits: number; signatures: number }
  /** TRON: bandwidth bytes charged, energy simulated (TRC-20). */
  | { family: 'tron'; bandwidth: number; energy: number }
  | { family: 'xrp' }
  | { family: 'ada' };

export interface Balance {
  assetId: string;
  amount: bigint;
}

export interface BuildParams {
  asset: AssetDef;
  to: string;
  /** Base units. Ignored when `max` is true. */
  amount: bigint;
  fee: FeeParams;
  /** Send everything (native: balance minus fee). */
  max?: boolean;
  /** XRP Ledger only: destination tag (0 … 4 294 967 295). */
  destinationTag?: number;
  /** Cardano only: native token to send (its output carries the min-ADA; `amount` is then ignored). */
  cardanoToken?: CardanoTokenSpec;
  /** Cardano only: CIP-20 message, public and permanent. */
  memo?: string;
}

export interface EvmUnsigned {
  family: 'evm';
  tx: EvmTxRequest;
  asset: AssetDef;
  amount: bigint;
  /** Recipient (for ERC-20, the token recipient, not the contract). */
  recipient: string;
  maxFee: bigint;
  size: SizeHint;
  /** Shown by the interface only (the native dialog uses Rust's own token table). */
  token?: EvmTokenHint;
  kind: 'transfer' | 'approval' | 'swap' | 'contract';
}
export interface BtcUnsigned {
  family: 'btc';
  psbt: string;
  amount: bigint;
  recipient: string;
  fee: bigint;
  maxFee: bigint;
  /** Computed locally from the PSBT, before signing (Rust re-decodes it for the native dialog). */
  summary: BtcTxSummary;
  size: SizeHint;
}
export interface SolUnsigned {
  family: 'sol';
  /** base64 compiled message bytes (what Rust decodes and signs). */
  message: string;
  /** base64 wire transaction with empty signature slots. */
  wire: string;
  amount: bigint;
  /** Recipient wallet (owner of the destination token account for SPL). */
  recipient: string;
  /** Base fee + priority fee, lamports (rent for a new token account excluded). */
  maxFee: bigint;
  /** Rent deposit for the recipient's new token account, lamports (0n if it exists / SOL send). */
  ataRent: bigint;
  createsAta: boolean;
  /** SPL only. */
  mint?: string;
  destinationTokenAccount?: string;
  tokenProgram?: 'token' | 'token2022';
  /** Local one-liner (logs only; the UI shows the Rust decoding). */
  summary: string;
  size: SizeHint;
}

export interface EvmSigned {
  family: 'evm';
  rawTx: string;
  hash: string;
}
export interface BtcSigned {
  family: 'btc';
  hex: string;
  txid: string;
}
export interface SolSigned {
  family: 'sol';
  wire: string;
  signature: string;
}

export interface FamilyTypes {
  evm: { unsigned: EvmUnsigned; signed: EvmSigned };
  btc: { unsigned: BtcUnsigned; signed: BtcSigned };
  sol: { unsigned: SolUnsigned; signed: SolSigned };
  /** Litecoin / Dogecoin: Bitcoin shapes (PSBT, hex), the unsigned tx tagged `family: 'btc'`. */
  ltc: { unsigned: UtxoUnsigned; signed: UtxoSigned };
  doge: { unsigned: UtxoUnsigned; signed: UtxoSigned };
  /** TRON: `raw_data` built and decoded by Rust, its resource estimate. */
  tron: { unsigned: TronUnsigned; signed: TronSigned };
  /** XRP Ledger: Payment built and strictly decoded by Rust, with the live context. */
  xrp: { unsigned: XrpUnsigned; signed: XrpSigned };
  /** Cardano: transaction built (selection, fee, min-UTxO) and decoded by Rust. */
  ada: { unsigned: CardanoUnsigned; signed: CardanoSigned };
}
export type AnyUnsigned = EvmUnsigned | BtcUnsigned | SolUnsigned | TronUnsigned | XrpUnsigned | CardanoUnsigned;
export type AnySigned = EvmSigned | BtcSigned | SolSigned | TronSigned | XrpSigned | CardanoSigned;

export type HistoryDirection = 'in' | 'out' | 'self';
export type HistoryStatus = 'pending' | 'confirmed' | 'failed';

export interface HistoryItem {
  id: string;
  chainKey: string;
  assetId: string;
  direction: HistoryDirection;
  /** Absolute value, base units. */
  amount: bigint;
  fee?: bigint;
  counterparty?: string;
  /** ms epoch, undefined while pending without timestamp. */
  time?: number;
  status: HistoryStatus;
  kind: 'transfer' | 'swap' | 'approval' | 'contract';
  /** Extra line (Cardano: tokens moved, CIP-20 message). */
  note?: string;
  /**
   * Address-poisoning lure (packages/chains/src/poisoning.ts): `zero` = a transfer of nothing, in
   * any direction (EVM / TRON `transferFrom(you, X, 0)`, a 0-lamport Solana transfer…);
   * `notSigned` = shown as outgoing although this account did not sign the transaction. Its
   * counterparty is never a reference address.
   */
  suspect?: 'zero' | 'notSigned';
}

export interface ChainAdapter<F extends Family = Family> {
  readonly family: F;
  readonly chain: Chain;
  getAddress(): string;
  getBalance(): Promise<Balance[]>;
  estimateFees(): Promise<FeeEstimates>;
  /** Validate an address for this chain (format + checksum). */
  isValidAddress(address: string): boolean;
  buildTx(params: BuildParams): Promise<FamilyTypes[F]['unsigned']>;
  /** Delegates to the Rust `*_sign_*` command (password + native dialog). */
  signTx(unsigned: FamilyTypes[F]['unsigned'], password: string): Promise<FamilyTypes[F]['signed']>;
  broadcast(signed: FamilyTypes[F]['signed']): Promise<string>;
  getHistory(): Promise<HistoryItem[]>;
}

export type AnyAdapter = ChainAdapter<'btc'> | ChainAdapter<'evm'> | ChainAdapter<'sol'> | ChainAdapter<'ltc'> | ChainAdapter<'doge'> | ChainAdapter<'tron'> | ChainAdapter<'xrp'> | ChainAdapter<'ada'>;

/** The `family` tag of the unsigned transactions an adapter builds (Litecoin / Dogecoin: Bitcoin's PSBT shape). */
export function unsignedFamilyOf(family: Family): AnyUnsigned['family'] {
  return family === 'ltc' || family === 'doge' ? 'btc' : family;
}

/** Sign + broadcast with a union-typed adapter. */
export async function signAndBroadcast(adapter: AnyAdapter, unsigned: AnyUnsigned, password: string): Promise<string> {
  if (unsignedFamilyOf(adapter.family) !== unsigned.family) throw new Error(l10n('Famille de transaction incohérente', 'Inconsistent transaction family'));
  const a = adapter as ChainAdapter<Family>;
  const signed = await a.signTx(unsigned as never, password);
  return a.broadcast(signed as never);
}

export type { EvmTxSummary };

/** `{ account }` for a vault command, or nothing for account 0 (the call stays exactly as before). */
export function accountArg(account: number | undefined): { account?: number } {
  return account ? { account } : {};
}
