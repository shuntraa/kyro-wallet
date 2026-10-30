// SPDX-License-Identifier: GPL-3.0-or-later
//
// ERC-20 approval helper. Exact amount by default; unlimited only on explicit
// request (the UI asks for a separate confirmation before passing it).

import { encodeFunctionData, erc20Abi, getAddress, maxUint256, type Hex } from 'viem';

export interface ApprovalParams {
  token: string;
  spender: string;
  /** Exact amount needed, base units. */
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
  if (p.amount <= 0n && !p.unlimited) throw new Error('Montant d’autorisation invalide');
  const unlimited = p.unlimited === true;
  const amount = unlimited ? maxUint256 : p.amount;
  const spender = getAddress(p.spender);
  return { to: getAddress(p.token), data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] }), value: 0n, spender, amount, unlimited };
}

/** `approve(spender, 0)` — revoke an allowance. */
export function buildRevoke(token: string, spender: string): ApprovalCall {
  const s = getAddress(spender);
  return { to: getAddress(token), data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [s, 0n] }), value: 0n, spender: s, amount: 0n, unlimited: false };
}

/** True when an allowance should be treated as "unlimited" (≥ 2^255). */
export function isUnlimitedAllowance(amount: bigint): boolean {
  return amount >= 1n << 255n;
}
