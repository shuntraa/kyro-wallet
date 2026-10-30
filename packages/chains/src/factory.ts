// SPDX-License-Identifier: GPL-3.0-or-later

import { solanaCluster, type NetFetch, type Servers } from '@kyro/shared';
import type { HwSigner, WalletAccounts } from './hw';
import { BitcoinAdapter } from './bitcoin/adapter';
import { EvmAdapter } from './evm/adapter';
import { SolanaAdapter } from './solana/adapter';
import { btcChain, evmChains, solChain } from './registry';
import type { AnyAdapter } from './types';
import { LitecoinAdapter } from './litecoin/adapter';
import { DogecoinAdapter } from './dogecoin/adapter';
import type { UtxoAccountView, UtxoBackend } from './litecoin/utxo';
import { dogeChain, ltcChain } from './registry';
import type { Network } from '@kyro/shared';

export interface AdapterSet {
  /** Null for a hardware-wallet account without Bitcoin keys. */
  btc: BitcoinAdapter | null;
  /** Keyed by chain key (`sepolia`, `ethereum`, `arbitrum`…). Empty without EVM keys. */
  evm: Map<string, EvmAdapter>;
  /** Null for a hardware-wallet account without Solana keys (e.g. Trezor One). */
  sol: SolanaAdapter | null;
  all: AnyAdapter[];
  /** Set when the active account is a hardware wallet: every signature goes through `hw_sign_*`. */
  hw: HwSigner | null;
}

/**
 * Build every adapter for the vault's network.
 *
 * - Bitcoin: no URL here, Rust picks the user's server (`btc_*` commands).
 * - EVM / Solana: the user's RPC (`servers.evm[chainId]`, `servers.solana[cluster]`) when set,
 *   else the registry default. Never both: Rust refuses a replaced default
 *   (`DEFAULT_SERVER_DISABLED`), so there is no fallback to retry against.
 */
export function createAdapters(accounts: WalletAccounts, servers?: Pick<Servers, 'evm' | 'solana'>, fetch?: NetFetch, hw?: HwSigner): AdapterSet {
  const network = accounts.network;
  const f = fetch ? { fetch } : {};
  const h = hw ? { hw } : {};
  // Hardware wallet: no source of full previous transactions yet (no raw-tx command), so the
  // Bitcoin adapter spends Taproot coins only (see BitcoinAdapterOptions.hw).
  const btc = accounts.btc ? new BitcoinAdapter({ chain: btcChain(network), accounts: accounts.btc, ...h }) : null;
  const evm = new Map<string, EvmAdapter>();
  if (accounts.evm) {
    for (const chain of evmChains(network)) {
      const custom = servers?.evm[String(chain.chainId)]?.url;
      evm.set(chain.key, new EvmAdapter({ chain, address: accounts.evm.address, ...(custom ? { rpcUrl: custom } : {}), ...f, ...h }));
    }
  }
  const solCustom = servers?.solana[solanaCluster(network)]?.url;
  const sol = accounts.sol ? new SolanaAdapter({ chain: solChain(network), address: accounts.sol.address, ...(solCustom ? { rpcUrl: solCustom } : {}), ...f, ...h }) : null;
  const all: AnyAdapter[] = [...(btc ? [btc] : []), ...evm.values(), ...(sol ? [sol] : [])];
  return { btc, evm, sol, all, hw: hw ?? null };
}

// ---------------------------------------------------------------- phase 4: Litecoin, Dogecoin

export { LitecoinAdapter, LITECOIN_NETWORKS, LITECOIN_SPEC, litecoinDust } from './litecoin/adapter';
export { DogecoinAdapter, DOGECOIN_NETWORKS, DOGECOIN_SPEC, DOGE_RECOMMENDED_RATE, DOGE_SOFT_DUST } from './dogecoin/adapter';
export {
  UtxoAdapter,
  UtxoInsufficientFundsError,
  rustUtxoBackend,
  scriptTypeOf,
  selectUtxoCoins,
  selectAllUtxoCoins,
  estimateSize,
  type UtxoAccountView,
  type UtxoBackend,
  type UtxoCoinSpec,
  type UtxoFeeRates,
  type UtxoTxSummary,
  type UtxoWarning,
  type UtxoUnsigned,
  type UtxoSigned,
  type UtxoScriptType,
  type DerivedUtxoAddress,
} from './litecoin/utxo';

export interface UtxoAdapterSet {
  ltc: LitecoinAdapter | null;
  doge: DogecoinAdapter | null;
}

/**
 * Litecoin and Dogecoin adapters from the `ltc` / `doge` entries of `accounts_get` (vault only:
 * hardware wallets answer `HW_UNSUPPORTED` for these chains). Kept apart from `createAdapters`
 * (and its `all` list) until the UI knows these families; Rust picks their servers
 * (`servers.litecoin` / `servers.dogecoin`), so nothing here depends on the settings.
 */
export function createUtxoAdapters(
  accounts: { network: Network; ltc?: UtxoAccountView; doge?: UtxoAccountView },
  backends: { ltc?: UtxoBackend; doge?: UtxoBackend } = {},
): UtxoAdapterSet {
  const n = accounts.network;
  return {
    ltc: accounts.ltc ? new LitecoinAdapter({ chain: ltcChain(n), account: accounts.ltc, ...(backends.ltc ? { backend: backends.ltc } : {}) }) : null,
    doge: accounts.doge ? new DogecoinAdapter({ chain: dogeChain(n), account: accounts.doge, ...(backends.doge ? { backend: backends.doge } : {}) }) : null,
  };
}
