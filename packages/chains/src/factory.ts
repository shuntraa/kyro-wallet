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
import { BitcoinCashAdapter } from './bitcoincash/adapter';
import { DashAdapter } from './dash/adapter';
import type { UtxoAccountView, UtxoBackend } from './utxo/utxo';
import { bchChain, dashChain, dogeChain, ltcChain, TRC20_TOKENS, tronChain } from './registry';
import { TronAdapter } from './tron/adapter';
import { XrpAdapter } from './xrp/adapter';

// ---------------------------------------------------------------- phase 4: Hedera

export {
  HbarAdapter,
  rustHbarBackend,
  isHbarRecipient,
  isHbarAccountId,
  isHbarEvmAddress,
  normalizeHbarRecipient,
  hbarMemoError,
  type HbarAdapterOptions,
  type HbarBackend,
  type HbarAccountInfo,
  type HbarOwnAccount,
  type HbarRecipientInfo,
  type HbarTxSummary,
  type HbarWarning,
  type HbarContext,
  type HbarHistoryEntry,
  type HbarUnsigned,
  type HbarSigned,
} from './hedera/adapter';
import { CardanoAdapter } from './cardano/adapter';
import { cardanoChain } from './registry';
import { stellarChain, xrpChain, nearChain, hbarChain, xmrChain } from './registry';
import { StellarAdapter } from './stellar/adapter';
import { NearAdapter } from './near/adapter';
import { SuiAdapter } from './sui/adapter';
import { suiChain } from './registry';
import { HbarAdapter } from './hedera/adapter';
import { KaspaAdapter } from './kaspa/adapter';
import { kaspaChain } from './registry';
import { PolkadotAdapter } from './polkadot/adapter';
import { polkadotChain } from './registry';
import { AlgorandAdapter } from './algorand/adapter';
import { algorandChain } from './registry';
import { XmrAdapter } from './xmr/adapter';
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
  /** Bitcoin Cash / Dash: vault only, like Litecoin / Dogecoin. */
  bch: BitcoinCashAdapter | null;
  dash: DashAdapter | null;
  /** TRON: vault only (hardware wallets: HW_UNSUPPORTED for now). */
  tron: TronAdapter | null;
  /** XRP Ledger: vault only (hardware wallets: HW_UNSUPPORTED for now). */
  xrp: XrpAdapter | null;
  /** Cardano: vault only (hardware wallets: HW_UNSUPPORTED for now). */
  cardano: CardanoAdapter | null;
  /** Stellar: vault only (hardware wallets: HW_UNSUPPORTED for now). */
  stellar: StellarAdapter | null;
  /** NEAR: vault only (hardware wallets: not supported). */
  near: NearAdapter | null;
  /** Sui: vault only (hardware wallets: not supported). */
  sui: SuiAdapter | null;
  /** Hedera: vault only (hardware wallets: HW_UNSUPPORTED for now). */
  hbar: HbarAdapter | null;
  /** Kaspa: vault only (not offered on hardware wallets). */
  kaspa: KaspaAdapter | null;
  /** Polkadot Asset Hub: vault only (hardware wallets: HW_UNSUPPORTED for now). */
  polkadot: PolkadotAdapter | null;
  /** Algorand: vault only (not offered on hardware wallets). */
  algo: AlgorandAdapter | null;
  /** Monero: vault only (hardware wallets: HW_UNSUPPORTED). */
  xmr: XmrAdapter | null;
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
  // Litecoin / Dogecoin / Bitcoin Cash / Dash: Rust picks their servers (servers.litecoin…).
  const { ltc, doge, bch, dash } = createUtxoAdapters(accounts, {}, hw ? 0 : account);
  // TRON: Rust picks the server (servers.tron, default TronGrid).
  const tronTokens = TRC20_TOKENS[network].map((t) => ({ contract: t.contract, symbol: t.symbol, name: t.name, decimals: t.decimals }));
  const tron = accounts.tron ? new TronAdapter({ chain: tronChain(network), address: accounts.tron.address, tokens: tronTokens, ...a }) : null;
  // XRP Ledger: Rust picks the server (servers.xrp, default rippled).
  const xrp = accounts.xrp ? new XrpAdapter({ chain: xrpChain(network), address: accounts.xrp.address, ...a }) : null;
  // Cardano: Rust picks the server (servers.cardano, default Koios).
  const cardano = accounts.cardano ? new CardanoAdapter({ chain: cardanoChain(network), address: accounts.cardano.address, ...a }) : null;
  // Stellar: SDF's Horizon, reached by Rust only.
  const stellar = accounts.stellar ? new StellarAdapter({ chain: stellarChain(network), address: accounts.stellar.address, ...a }) : null;
  // NEAR: Rust picks the server (default FastNEAR).
  const near = accounts.near ? new NearAdapter({ chain: nearChain(network), address: accounts.near.address, ...a }) : null;
  // Sui: Rust picks the server (Sui Foundation GraphQL RPC).
  const sui = accounts.sui ? new SuiAdapter({ chain: suiChain(network), address: accounts.sui.address, ...a }) : null;
  // Hedera: Rust reads the mirror node and submits to the nodes (no custom server).
  const hbar = accounts.hbar ? new HbarAdapter({ chain: hbarChain(network), address: accounts.hbar.address, ...a }) : null;
  // Kaspa: Rust reads the account's 20 receive + 20 change addresses (api.kaspa.org).
  const kaspa = accounts.kas && !hw ? new KaspaAdapter({ chain: kaspaChain(network), address: accounts.kas.address, ...a }) : null;
  // Polkadot: Rust picks the node (Parity's public Asset Hub RPC; no custom server yet).
  const polkadot = accounts.polkadot ? new PolkadotAdapter({ chain: polkadotChain(network), address: accounts.polkadot.address, ...a }) : null;
  // Algorand: Rust picks the server (AlgoNode / Nodely algod + indexer).
  const algo = accounts.algo ? new AlgorandAdapter({ chain: algorandChain(network), address: accounts.algo.address, ...a }) : null;
  // Monero: Rust picks the node (servers.monero) and scans locally.
  const xmr = accounts.xmr && !hw ? new XmrAdapter({ chain: xmrChain(network), address: accounts.xmr.address, ...a }) : null;
  const all: AnyAdapter[] = [
    ...(btc ? [btc] : []),
    ...evm.values(),
    ...(sol ? [sol] : []),
    ...(ltc ? [ltc] : []),
    ...(doge ? [doge] : []),
    ...(bch ? [bch] : []), ...(dash ? [dash] : []), ...(tron ? [tron] : []),
    ...(xrp ? [xrp] : []),
    ...(cardano ? [cardano] : []), ...(stellar ? [stellar] : []), ...(near ? [near] : []), ...(sui ? [sui] : []), ...(hbar ? [hbar] : []),
    ...(kaspa ? [kaspa] : []),
    ...(polkadot ? [polkadot] : []),
    ...(algo ? [algo] : []),
    ...(xmr ? [xmr] : []),
  ];
  return { btc, evm, sol, ltc, doge, bch, dash, tron, xrp, cardano, stellar, near, sui, hbar, kaspa, polkadot, algo, xmr, all, hw: hw ?? null };
}

// ---------------------------------------------------------------- phase 4: Litecoin, Dogecoin, Bitcoin Cash, Dash

export { LitecoinAdapter, LITECOIN_NETWORKS, LITECOIN_SPEC, litecoinDust } from './litecoin/adapter';
export { DogecoinAdapter, DOGECOIN_NETWORKS, DOGECOIN_SPEC, DOGE_RECOMMENDED_RATE, DOGE_SOFT_DUST } from './dogecoin/adapter';
export { BitcoinCashAdapter, BITCOINCASH_NETWORKS, BITCOINCASH_SPEC, bchDashDust } from './bitcoincash/adapter';
export { DashAdapter, DASH_NETWORKS, DASH_SPEC } from './dash/adapter';
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
  bch: BitcoinCashAdapter | null;
  dash: DashAdapter | null;
}

/**
 * Litecoin, Dogecoin, Bitcoin Cash and Dash adapters from the `ltc` / `doge` / `bch` / `dash`
 * entries of `accounts_get` (vault only: hardware wallets answer `HW_UNSUPPORTED` for these
 * chains). Also part of `createAdapters`; Rust picks their servers, so nothing here depends on
 * the settings.
 */
export function createUtxoAdapters(
  accounts: { network: Network; ltc?: UtxoAccountView; doge?: UtxoAccountView; bch?: UtxoAccountView; dash?: UtxoAccountView },
  backends: { ltc?: UtxoBackend; doge?: UtxoBackend; bch?: UtxoBackend; dash?: UtxoBackend } = {},
  vaultAccount = 0,
): UtxoAdapterSet {
  const n = accounts.network;
  const a = vaultAccount ? { vaultAccount } : {};
  return {
    ltc: accounts.ltc ? new LitecoinAdapter({ chain: ltcChain(n), account: accounts.ltc, ...(backends.ltc ? { backend: backends.ltc } : {}), ...a }) : null,
    doge: accounts.doge ? new DogecoinAdapter({ chain: dogeChain(n), account: accounts.doge, ...(backends.doge ? { backend: backends.doge } : {}), ...a }) : null,
    bch: accounts.bch ? new BitcoinCashAdapter({ chain: bchChain(n), account: accounts.bch, ...(backends.bch ? { backend: backends.bch } : {}), ...a }) : null,
    dash: accounts.dash ? new DashAdapter({ chain: dashChain(n), account: accounts.dash, ...(backends.dash ? { backend: backends.dash } : {}), ...a }) : null,
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

// ---------------------------------------------------------------- phase 4: NEAR

export {
  NearAdapter,
  rustNearBackend,
  isNearImplicit,
  nearAccountKind,
  nearAccountIdProblem,
  type NearAdapterOptions,
  type NearBackend,
  type NearAccountInfo,
  type NearAccountKind,
  type NearContext,
  type NearHistoryEntry,
  type NearTxOutcome,
  type NearTxSummary,
  type NearWarning,
  type NearUnsigned,
  type NearSigned,
} from './near/adapter';

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
  StellarAdapter,
  rustStellarBackend,
  isStellarAddress,
  stellarAddressKind,
  stellarAddressProblem,
  xlmToStroops,
  parseStellarMemo,
  sameMemo,
  stellarMemoText,
  type StellarAdapterOptions,
  type StellarBackend,
  type StellarAccountInfo,
  type StellarContext,
  type StellarHistoryEntry,
  type StellarMemoSpec,
  type StellarMemoView,
  type StellarOpView,
  type StellarTxSummary,
  type StellarWarning,
  type StellarUnsigned,
  type StellarSigned,
} from './stellar/adapter';
export {
  AlgorandAdapter,
  rustAlgoBackend,
  isAlgoAddress,
  algoNoteBytes,
  ALGO_MIN_BALANCE,
  ALGO_MAX_NOTE,
  type AlgorandAdapterOptions,
  type AlgoBackend,
  type AlgoAccountInfo,
  type AlgoContext,
  type AlgoHistoryEntry,
  type AlgoTxStatus,
  type AlgoTxSummary,
  type AlgoWarning,
  type AlgoUnsigned,
  type AlgoSigned,
} from './algorand/adapter';
export {
  XmrAdapter,
  rustXmrBackend,
  isXmrAddress,
  xmrDestinationLabel,
  xmrHeightAt,
  XMR_DECIMALS,
  XMR_LOCK_BLOCKS,
  type XmrAdapterOptions,
  type XmrBackend,
  type XmrDestination,
  type XmrHistoryEntry,
  type XmrStatus,
  type XmrSubaddress,
  type XmrTxSummary,
  type XmrWarning,
  type XmrUnsigned,
  type XmrSigned,
} from './xmr/adapter';
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

// ---------------------------------------------------------------- phase 4: Sui

export {
  SuiAdapter,
  rustSuiBackend,
  isSuiAddress,
  suiAddressProblem,
  normalizeSuiAddress,
  suiHistoryItem,
  SUI_COIN_TYPE,
  type SuiAdapterOptions,
  type SuiBackend,
  type SuiBalance,
  type SuiContext,
  type SuiHistoryEntry,
  type SuiTxStatus,
  type SuiTxSummary,
  type SuiWarning,
  type SuiUnsigned,
  type SuiSigned,
} from './sui/adapter';

// ---------------------------------------------------------------- phase 4: Kaspa

export {
  KaspaAdapter,
  rustKaspaBackend,
  kasToSompi,
  KASPA_MIN_SEND,
  type KaspaAdapterOptions,
  type KaspaBackend,
  type KaspaAccountInfo,
  type KaspaContext,
  type KaspaHistoryEntry,
  type KaspaTxSummary,
  type KaspaWarning,
  type KaspaUnsigned,
  type KaspaSigned,
} from './kaspa/adapter';
export {
  PolkadotAdapter,
  rustDotBackend,
  isDotAddress,
  dotAddressProblem,
  type PolkadotAdapterOptions,
  type DotBackend,
  type DotAccountInfo,
  type DotContext,
  type DotTxSummary,
  type DotTxState,
  type DotUnsigned,
  type DotSigned,
} from './polkadot/adapter';
