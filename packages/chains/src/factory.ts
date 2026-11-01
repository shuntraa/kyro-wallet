// SPDX-License-Identifier: GPL-3.0-or-later

import { call, solanaCluster, type NetFetch, type Servers } from '@kyro/shared';
import type { HwSigner, WalletAccounts } from './hw';
import { BitcoinAdapter } from './bitcoin/adapter';
import { EvmAdapter } from './evm/adapter';
import { SolanaAdapter } from './solana/adapter';
import { btcChain, evmChains, solChain } from './registry';
import type { AnyAdapter } from './types';
import { LitecoinAdapter } from './litecoin/adapter';
import { DogecoinAdapter } from './dogecoin/adapter';
import type { UtxoAccountView, UtxoBackend } from './utxo/utxo';
import { dogeChain, ltcChain, tronChain } from './registry';
import { TronAdapter } from './tron/adapter';
import { XrpAdapter } from './xrp/adapter';
import { CardanoAdapter } from './cardano/adapter';
import { cardanoChain } from './registry';
import { xrpChain, tonChain } from './registry';
import { TonAdapter } from './ton/adapter';
import type { Network } from '@kyro/shared';

export interface AdapterSet {
  /** Null for a hardware-wallet account without Bitcoin keys. */
  btc: BitcoinAdapter | null;
  /** Keyed by chain key (`sepolia`, `ethereum`, `arbitrum`…). Empty without EVM keys. */
  evm: Map<string, EvmAdapter>;
  /** Null for a hardware-wallet account without Solana keys (e.g. Trezor One). */
  sol: SolanaAdapter | null;
  /** Litecoin / Dogecoin: vault only (hardware wallets: HW_UNSUPPORTED for now). */
  ltc: LitecoinAdapter | null;
  doge: DogecoinAdapter | null;
  /** TRON: vault only (hardware wallets: HW_UNSUPPORTED for now). */
  tron: TronAdapter | null;
  /** XRP Ledger: vault only (hardware wallets: HW_UNSUPPORTED for now). */
  xrp: XrpAdapter | null;
  /** Cardano: vault only (hardware wallets: HW_UNSUPPORTED for now). */
  cardano: CardanoAdapter | null;
  /** TON: vault only (no hardware wallet support). */
  ton: TonAdapter | null;
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
export function createAdapters(accounts: WalletAccounts, servers?: Pick<Servers, 'evm' | 'solana'>, fetch?: NetFetch, hw?: HwSigner, account = 0): AdapterSet {
  const network = accounts.network;
  const f = fetch ? { fetch } : {};
  const h = hw ? { hw } : {};
  // Vault account (§2.9): every signing command of these adapters carries it (absent = 0).
  const a = !hw && account ? { account } : {};
  // Hardware wallet: SegWit v0 inputs carry their full previous transaction (`non_witness_utxo`),
  // fetched by `btc_tx_hex` (Rust checks its txid against the input).
  const btcHw = hw ? { hw: { ...hw, prevTx: (txid: string) => call('btc_tx_hex', { txid }) } } : {};
  const btc = accounts.btc ? new BitcoinAdapter({ chain: btcChain(network), accounts: accounts.btc, ...btcHw, ...a }) : null;
  const evm = new Map<string, EvmAdapter>();
  if (accounts.evm) {
    for (const chain of evmChains(network)) {
      const custom = servers?.evm[String(chain.chainId)]?.url;
      evm.set(chain.key, new EvmAdapter({ chain, address: accounts.evm.address, ...(custom ? { rpcUrl: custom } : {}), ...f, ...h, ...a }));
    }
  }
  const solCustom = servers?.solana[solanaCluster(network)]?.url;
  const sol = accounts.sol ? new SolanaAdapter({ chain: solChain(network), address: accounts.sol.address, ...(solCustom ? { rpcUrl: solCustom } : {}), ...f, ...h, ...a }) : null;
  // Litecoin / Dogecoin: Rust picks their servers (servers.litecoin / servers.dogecoin).
  const { ltc, doge } = createUtxoAdapters(accounts, {}, hw ? 0 : account);
  // TRON: Rust picks the server (servers.tron, default TronGrid).
  const tron = accounts.tron ? new TronAdapter({ chain: tronChain(network), address: accounts.tron.address, ...a }) : null;
  // XRP Ledger: Rust picks the server (servers.xrp, default rippled).
  const xrp = accounts.xrp ? new XrpAdapter({ chain: xrpChain(network), address: accounts.xrp.address, ...a }) : null;
  // Cardano: Rust picks the server (servers.cardano, default Koios).
  const cardano = accounts.cardano ? new CardanoAdapter({ chain: cardanoChain(network), address: accounts.cardano.address, ...a }) : null;
  // TON: Rust picks the server (TON Center).
  const ton = accounts.ton ? new TonAdapter({ chain: tonChain(network), address: accounts.ton.address, ...a }) : null;
  const all: AnyAdapter[] = [...(btc ? [btc] : []), ...evm.values(), ...(sol ? [sol] : []), ...(ltc ? [ltc] : []), ...(doge ? [doge] : []), ...(tron ? [tron] : []), ...(xrp ? [xrp] : []), ...(cardano ? [cardano] : []), ...(ton ? [ton] : [])];
  return { btc, evm, sol, ltc, doge, tron, xrp, cardano, ton, all, hw: hw ?? null };
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
} from './utxo/utxo';

export interface UtxoAdapterSet {
  ltc: LitecoinAdapter | null;
  doge: DogecoinAdapter | null;
}

/**
 * Litecoin and Dogecoin adapters from the `ltc` / `doge` entries of `accounts_get` (vault only:
 * hardware wallets answer `HW_UNSUPPORTED` for these chains). Also part of `createAdapters`;
 * Rust picks their servers, so nothing here depends on the settings.
 */
export function createUtxoAdapters(
  accounts: { network: Network; ltc?: UtxoAccountView; doge?: UtxoAccountView },
  backends: { ltc?: UtxoBackend; doge?: UtxoBackend } = {},
  vaultAccount = 0,
): UtxoAdapterSet {
  const n = accounts.network;
  const a = vaultAccount ? { vaultAccount } : {};
  return {
    ltc: accounts.ltc ? new LitecoinAdapter({ chain: ltcChain(n), account: accounts.ltc, ...(backends.ltc ? { backend: backends.ltc } : {}), ...a }) : null,
    doge: accounts.doge ? new DogecoinAdapter({ chain: dogeChain(n), account: accounts.doge, ...(backends.doge ? { backend: backends.doge } : {}), ...a }) : null,
  };
}

// ---------------------------------------------------------------- phase 4: TRON

export {
  TronAdapter,
  rustTronBackend,
  isTronAddress,
  tronAssetId,
  TRON_USDT,
  type TronAdapterOptions,
  type TronBackend,
  type TronAccountInfo,
  type TronAction,
  type TronWarning,
  type TronTxSummary,
  type TronEstimate,
  type TronHistoryEntry,
  type TronUnsigned,
  type TronSigned,
  type Trc20Token,
  type TronCoverage,
  tronCoverage,
  isKnownTronToken,
} from './tron/adapter';

// ---------------------------------------------------------------- phase 4: XRP Ledger

export {
  XrpAdapter,
  rustXrpBackend,
  isXrpAddress,
  parseDestinationTag,
  type XrpAdapterOptions,
  type XrpBackend,
  type XrpAccountInfo,
  type XrpAmountView,
  type XrpWarning,
  type XrpTxSummary,
  type XrpContext,
  type XrpHistoryEntry,
  type XrpIssued,
  type XrpUnsigned,
  type XrpSigned,
  isXAddress,
} from './xrp/adapter';
export {
  CardanoAdapter,
  rustCardanoBackend,
  isCardanoAddress,
  isByronAddress,
  adaToLovelace,
  type CardanoAdapterOptions,
  type CardanoBackend,
  type CardanoAccount,
  type CardanoAddressInfo,
  type CardanoContext,
  type CardanoHistoryEntry,
  type CardanoOutputView,
  type CardanoSigned,
  type CardanoTokenBalance,
  type CardanoTokenSpec,
  type CardanoTokenView,
  type CardanoTxSummary,
  type CardanoUnsigned,
  type CardanoWarning,
  cardanoAddressProblem,
  cardanoTokenLabel,
} from './cardano/adapter';

// ---------------------------------------------------------------- phase 4: TON

export {
  TonAdapter,
  rustTonBackend,
  isTonAddress,
  tonRecipientProblem,
  tonCommentProblem,
  TON_MAX_COMMENT_BYTES,
  type TonAdapterOptions,
  type TonBackend,
  type TonAccountInfo,
  type TonContext,
  type TonHistoryEntry,
  type TonTxStatus,
  type TonTxSummary,
  type TonWarning,
  type TonUnsigned,
  type TonSigned,
} from './ton/adapter';
