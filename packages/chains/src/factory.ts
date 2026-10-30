// SPDX-License-Identifier: GPL-3.0-or-later

import { solanaCluster, type Accounts, type NetFetch, type Servers } from '@kyro/shared';
import { BitcoinAdapter } from './bitcoin/adapter';
import { EvmAdapter } from './evm/adapter';
import { SolanaAdapter } from './solana/adapter';
import { btcChain, evmChains, solChain } from './registry';
import type { AnyAdapter } from './types';

export interface AdapterSet {
  btc: BitcoinAdapter;
  /** Keyed by chain key (`sepolia`, `ethereum`, `arbitrum`…). */
  evm: Map<string, EvmAdapter>;
  sol: SolanaAdapter;
  all: AnyAdapter[];
}

/**
 * Build every adapter for the vault's network.
 *
 * - Bitcoin: no URL here, Rust picks the user's server (`btc_*` commands).
 * - EVM / Solana: the user's RPC (`servers.evm[chainId]`, `servers.solana[cluster]`) when set,
 *   else the registry default. Never both: Rust refuses a replaced default
 *   (`DEFAULT_SERVER_DISABLED`), so there is no fallback to retry against.
 */
export function createAdapters(accounts: Accounts, servers?: Pick<Servers, 'evm' | 'solana'>, fetch?: NetFetch): AdapterSet {
  const network = accounts.network;
  const f = fetch ? { fetch } : {};
  const btc = new BitcoinAdapter({ chain: btcChain(network), accounts: accounts.btc });
  const evm = new Map<string, EvmAdapter>();
  for (const chain of evmChains(network)) {
    const custom = servers?.evm[String(chain.chainId)]?.url;
    evm.set(chain.key, new EvmAdapter({ chain, address: accounts.evm.address, ...(custom ? { rpcUrl: custom } : {}), ...f }));
  }
  const solCustom = servers?.solana[solanaCluster(network)]?.url;
  const sol = new SolanaAdapter({ chain: solChain(network), address: accounts.sol.address, ...(solCustom ? { rpcUrl: solCustom } : {}), ...f });
  return { btc, evm, sol, all: [btc, ...evm.values(), sol] };
}
