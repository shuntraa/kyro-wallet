// SPDX-License-Identifier: GPL-3.0-or-later
// Swap screen helpers: which chains a swap can start from / arrive on, our own address there
// (never typed: the destination of a cross-chain swap is always one of your accounts), the
// « Tu reçois » list grouped by chain, and the label of a cross-chain transfer's status.

import { NATIVE_EVM_TOKEN, NATIVE_SOL_MINT, type AssetDef, type Chain } from '@kyro/chains';
import type { Accounts, Network } from '@kyro/shared';
import type { SwapChain } from '@kyro/swap';

/** The swap id of a chain: EVM chain id, 'solana', 'bitcoin' (arrival only); null when swaps don't serve it. */
export function swapChainOf(chain: Chain | undefined): SwapChain | null {
  if (!chain) return null;
  if (chain.family === 'evm') return chain.chainId;
  if (chain.family === 'sol') return 'solana';
  if (chain.family === 'btc') return 'bitcoin';
  return null;
}

/** Can a swap START on this chain? (Bitcoin: not yet, no provider pays the Kyro fee there.) */
export const canSwapFrom = (chain: Chain | undefined) => chain?.family === 'evm' || chain?.family === 'sol';

/**
 * Can a swap from `from` ARRIVE on `to`? Same chain: always. Another chain: mainnet only (LI.FI and
 * NEAR Intents have no testnet routes), EVM / Solana / Bitcoin, never from Bitcoin.
 */
export function canSwapTo(network: Network, from: Chain | undefined, to: Chain | undefined): boolean {
  if (!from || !to || !canSwapFrom(from)) return false;
  if (from.key === to.key) return true;
  return network === 'mainnet' && swapChainOf(to) !== null;
}

/**
 * Our own receiving address on `chain` (the selected account). Bitcoin: the native SegWit
 * (`bc1q…`) receive address, the only form a cross-chain bridge call can carry unambiguously.
 */
export function ownAddressOn(accounts: Pick<Accounts, 'evm' | 'sol' | 'btc'>, chain: Chain | undefined): string | null {
  if (!chain) return null;
  if (chain.family === 'evm') return accounts.evm.address || null;
  if (chain.family === 'sol') return accounts.sol.address || null;
  if (chain.family === 'btc') return accounts.btc.segwit.address || null;
  return null;
}

/** Token id as the swap providers name it: ERC-20 / mint, `0xEeee…`, the wSOL mint, `bitcoin`. */
export function swapTokenAddress(a: AssetDef): string {
  if (a.kind === 'native') return a.family === 'sol' ? NATIVE_SOL_MINT : a.family === 'btc' ? 'bitcoin' : NATIVE_EVM_TOKEN;
  return a.contract ?? '';
}

export interface BuyGroup {
  chain: Chain;
  assets: AssetDef[];
}

/**
 * « Tu reçois » list: the sell chain first, then every other chain a swap can arrive on, each
 * with its assets (read-only assets and the sold asset left out).
 */
export function buyGroups(network: Network, chains: Chain[], assets: AssetDef[], sell: AssetDef | undefined): BuyGroup[] {
  const from = chains.find((c) => c.key === sell?.chainKey);
  const ordered = [...chains].sort((a, b) => (a.key === from?.key ? -1 : b.key === from?.key ? 1 : 0));
  return ordered
    .filter((c) => canSwapTo(network, from, c))
    .map((chain) => ({ chain, assets: assets.filter((a) => a.chainKey === chain.key && a.id !== sell?.id && !a.readOnly) }))
    .filter((g) => g.assets.length > 0);
}

/** History label of a cross-chain transfer (li.quest `/v1/status`). */
export function crossStatusLabel(status: string | undefined, toChainLabel: string): string {
  switch (status) {
    case 'DONE':
      return `arrivé sur ${toChainLabel}`;
    case 'FAILED':
      return 'échec du pont, remboursement prévu sur ton adresse de départ';
    default:
      return `en route vers ${toChainLabel}`;
  }
}
