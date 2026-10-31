// SPDX-License-Identifier: GPL-3.0-or-later
//
// Reinforced-confirmation triggers of the Bitcoin and EVM summaries (docs/IPC.md §1, wallet-core
// btc.rs / evm.rs `with_warnings`). Rust is the authority: these mirror its rules so the demo
// backend and the locally built Bitcoin summary say the same as the shell before signing.

import type { BtcSummaryOutput, BtcWarning, EvmTxRequest, EvmWarning } from './ipc';

/** wallet-core `BTC_HIGH_FEE_SAT_PER_VB` (100 × the minimum relay fee). */
export const BTC_HIGH_FEE_SAT_PER_VB = 100;

/** wallet-core `EVM_KNOWN_CHAINS`. */
export const EVM_KNOWN_CHAINS: readonly number[] = [1, 11_155_111, 42_161, 10, 8_453, 137, 56, 43_114, 25, 5_000, 146, 14, 8_217, 100, 999, 1_329, 1_030];

/** wallet-core `evm_high_fee_threshold_wei`, in thousandths of the native coin (default 0.05). */
const HIGH_FEE_MILLI: Record<number, bigint> = {
  137: 50_000n, // 50 POL
  43_114: 1_000n, // 1 AVAX
  25: 200_000n, // 200 CRO
  1_329: 200_000n, // 200 SEI
  1_030: 200_000n, // 200 CFX
  5_000: 20_000n, // 20 MNT
  146: 250_000n, // 250 S
  14: 2_000_000n, // 2 000 FLR
  8_217: 300_000n, // 300 KAIA
  100: 10_000n, // 10 XDAI
};

/** wallet-core `evm_high_fee_threshold_wei`: 0.05 native, more on chains whose coin is cheap. */
export function evmHighFeeThresholdWei(chainId: number): bigint {
  return 10n ** 15n * (HIGH_FEE_MILLI[chainId] ?? 50n);
}

/**
 * Bitcoin: unknown script, OP_RETURN, foreign input, fee > 100 sat/vB or fee > outputs total.
 * Output addresses follow Rust's rendering: `op_return:<hex>` / `script:<hex>` for non-address
 * outputs. `vsize`: estimated virtual size (Rust: fee ÷ estimated vsize, integer division).
 */
export function btcWarnings(p: { outputs: BtcSummaryOutput[]; feeSats: number; vsize: number; foreignInputs?: number[] }): { warnings: BtcWarning[]; requiresExtraConfirmation: boolean } {
  const warnings: BtcWarning[] = [];
  for (const input of p.foreignInputs ?? []) warnings.push({ kind: 'foreignInput', input });
  p.outputs.forEach(([addr], output) => {
    if (addr.startsWith('op_return:')) warnings.push({ kind: 'opReturn', output });
    else if (addr.startsWith('script:')) warnings.push({ kind: 'unknownScript', output });
  });
  const totalOut = p.outputs.reduce((s, [, v]) => s + v, 0);
  const rate = Math.floor(p.feeSats / Math.max(1, p.vsize));
  if (rate > BTC_HIGH_FEE_SAT_PER_VB || p.feeSats > totalOut) warnings.push({ kind: 'highFee', satPerVb: rate });
  return { warnings, requiresExtraConfirmation: warnings.length > 0 };
}

/**
 * EVM: any call that is not a decoded ERC-20 transfer, every approval (ILLIMITÉ when ≥ 2^128),
 * native value with calldata, unknown chain id, worst-case fee above the chain's threshold.
 */
export function evmWarnings(
  s: { kind: 'NativeTransfer' | 'Erc20Transfer' | 'Erc20Approve' | 'ContractCall'; spender: string | null; amount: string; unlimitedApproval: boolean; chainId: number; maxFeeWei: string },
  tx: Pick<EvmTxRequest, 'data' | 'valueWei'>,
): { warnings: EvmWarning[]; requiresExtraConfirmation: boolean } {
  const warnings: EvmWarning[] = [];
  if (s.kind === 'ContractCall') warnings.push({ kind: 'contractCall' });
  if (s.kind === 'Erc20Approve') {
    const amount = BigInt(s.amount || '0');
    warnings.push({ kind: 'approval', spender: s.spender ?? '', amount: s.amount, unlimited: s.unlimitedApproval || amount >= 1n << 128n });
  }
  const data = tx.data.replace(/^0x/i, '');
  if (data.length > 0 && BigInt(tx.valueWei || '0') !== 0n) warnings.push({ kind: 'valueToContract', valueWei: BigInt(tx.valueWei).toString() });
  if (!EVM_KNOWN_CHAINS.includes(s.chainId)) warnings.push({ kind: 'unknownChain', chainId: s.chainId });
  if (BigInt(s.maxFeeWei) > evmHighFeeThresholdWei(s.chainId)) warnings.push({ kind: 'highFee', maxFeeWei: s.maxFeeWei });
  return { warnings, requiresExtraConfirmation: warnings.length > 0 };
}
