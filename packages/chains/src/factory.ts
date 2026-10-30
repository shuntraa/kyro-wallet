// SPDX-License-Identifier: GPL-3.0-or-later

import type { Accounts, NetFetch, Settings } from '@kyro/shared';
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

/** Build every adapter for the vault's network, honouring RPC overrides. */
export function createAdapters(accounts: Accounts, rpc: Settings['rpc'] = {}, fetch?: NetFetch): AdapterSet {
  const network = accounts.network;
  const f = fetch ? { fetch } : {};
  const btc = new BitcoinAdapter({ chain: btcChain(network), accounts: accounts.btc, ...(rpc.esplora ? { esploraUrl: rpc.esplora } : {}), ...f });
  const evm = new Map<string, EvmAdapter>();
  evmChains(network).forEach((chain, i) => {
    const override = i === 0 && rpc.ethereum ? { rpcUrl: rpc.ethereum } : {};
    evm.set(chain.key, new EvmAdapter({ chain, address: accounts.evm.address, ...override, ...f }));
  });
  const sol = new SolanaAdapter({ chain: solChain(network), address: accounts.sol.address, ...(rpc.solana ? { rpcUrl: rpc.solana } : {}), ...f });
  return { btc, evm, sol, all: [btc, ...evm.values(), sol] };
}
