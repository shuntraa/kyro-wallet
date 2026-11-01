// SPDX-License-Identifier: GPL-3.0-or-later
//
// ERC-20 approval. Unlimited only on explicit user request (separate confirmation in the UI).

import { encodeFunctionData, erc20Abi, getAddress, maxUint256, type Hex } from 'viem';

import { l10n } from '@kyro/shared';
export interface ApprovalParams {
  token: string;
  spender: string;
  amount: bigint;
  /** Approve 2^256-1 instead of `amount`. Must come from an explicit user choice. */
  unlimited?: boolean;
}

export interface ApprovalCall {
  to: `0x${string}`;
  data: Hex;
  value: 0n;
  spender: `0x${string}`;
  amount: bigint;
  unlimited: boolean;
}

export function buildApproval(p: ApprovalParams): ApprovalCall {
  if (p.amount <= 0n && !p.unlimited) throw new Error(l10n('Montant d’autorisation invalide', 'Invalid approval amount'));
  const unlimited = p.unlimited === true;
  const amount = unlimited ? maxUint256 : p.amount;
  const spender = getAddress(p.spender);
  return { to: getAddress(p.token), data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] }), value: 0n, spender, amount, unlimited };
}

export function buildRevoke(token: string, spender: string): ApprovalCall {
  const s = getAddress(spender);
  return { to: getAddress(token), data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [s, 0n] }), value: 0n, spender: s, amount: 0n, unlimited: false };
}

/** Tokens (USDT on Ethereum) whose `approve` reverts on non-zero to non-zero: approve 0 first. */
const ZERO_FIRST: Record<number, string[]> = { 1: ['0xdac17f958d2ee523a2206206994597c13d831ec7'] };

export function requiresZeroAllowanceFirst(chainId: number, token: string, current: bigint): boolean {
  return current > 0n && (ZERO_FIRST[chainId] ?? []).includes(token.toLowerCase());
}

/** True when an allowance should be treated as "unlimited" (≥ 2^255). */
export function isUnlimitedAllowance(amount: bigint): boolean {
  return amount >= 1n << 255n;
}
