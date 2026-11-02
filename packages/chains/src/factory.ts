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
import { stellarChain, xrpChain, nearChain, hbarChain, xmrChain, tonChain, zecChain, isHiddenFamily } from './registry';
import { StellarAdapter } from './stellar/adapter';
import { NearAdapter } from './near/adapter';
import { SuiAdapter } from './sui/adapter';
import { suiChain } from './registry';
import { HbarAdapter, isHbarEd25519Key } from './hedera/adapter';
import { KaspaAdapter } from './kaspa/adapter';
import { kaspaChain } from './registry';
import { PolkadotAdapter } from './polkadot/adapter';
import { polkadotChain } from './registry';
import { AlgorandAdapter } from './algorand/adapter';
import { algorandChain } from './registry';
import { XmrAdapter } from './xmr/adapter';
import { TonAdapter } from './ton/adapter';
import { CosmosAdapter } from './cosmos/adapter';
import { cosmosChain } from './registry';
import { AptosAdapter } from './aptos/adapter';
import { aptosChain } from './registry';
import { ZcashAdapter } from './zcash/adapter';
import type { Network } from '@kyro/shared';

export interface AdapterSet {
  /** Null for a hardware-wallet account without Bitcoin keys. */
  btc: BitcoinAdapter | null;
  /** Keyed by chain key (`sepolia`, `ethereum`, `arbitrum`…). Empty without EVM keys. */
  evm: Map<string, EvmAdapter>;
  /** Null for a hardware-wallet account without Solana keys (e.g. Trezor One). */
  sol: SolanaAdapter | null;
  ltc: LitecoinAdapter | null;
  doge: DogecoinAdapter | null;
  bch: BitcoinCashAdapter | null;
  dash: DashAdapter | null;
  tron: TronAdapter | null;
  xrp: XrpAdapter | null;
  cardano: CardanoAdapter | null;
  stellar: StellarAdapter | null;
  near: NearAdapter | null;
  sui: SuiAdapter | null;
  hbar: HbarAdapter | null;
  kaspa: KaspaAdapter | null;
  polkadot: PolkadotAdapter | null;
  algo: AlgorandAdapter | null;
  xmr: XmrAdapter | null;
  /** TON: vault or Ledger (structured transfer request). */
  ton: TonAdapter | null;
  /** Cosmos Hub: vault or Ledger (amino JSON). */
  cosmos: CosmosAdapter | null;
  aptos: AptosAdapter | null;
  zec: ZcashAdapter | null;
  all: AnyAdapter[];
  /** Set when the active account is a hardware wallet: every signature goes through `hw_sign_*`. */
  hw: HwSigner | null;
}

/** Build every adapter for the vault's network. A user RPC replaces the registry default (Rust refuses a disabled default, no fallback). */
export function createAdapters(accounts: WalletAccounts, servers?: Pick<Servers, 'evm' | 'solana'>, fetch?: NetFetch, hw?: HwSigner, account = 0): AdapterSet {
  const network = accounts.network;
  const f = fetch ? { fetch } : {};
  const h = hw ? { hw } : {};
  // Vault account (§2.9): every signing command of these adapters carries it (absent = 0).
  const a = !hw && account ? { account } : {};
  // Hardware wallet: SegWit v0 inputs carry their full previous tx (`non_witness_utxo`), txid checked by Rust.
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
  const { ltc, doge, bch, dash } = createUtxoAdapters(accounts, {}, hw ? 0 : account, hw);
  const tronTokens = TRC20_TOKENS[network].map((t) => ({ contract: t.contract, symbol: t.symbol, name: t.name, decimals: t.decimals }));
  const tron = accounts.tron ? new TronAdapter({ chain: tronChain(network), address: accounts.tron.address, tokens: tronTokens, ...h, ...a }) : null;
  const xrp = accounts.xrp ? new XrpAdapter({ chain: xrpChain(network), address: accounts.xrp.address, ...h, ...a }) : null;
  const cardano = accounts.cardano ? new CardanoAdapter({ chain: cardanoChain(network), address: accounts.cardano.address, ...h, ...a }) : null;
  const stellar = accounts.stellar ? new StellarAdapter({ chain: stellarChain(network), address: accounts.stellar.address, ...h, ...a }) : null;
  const near = accounts.near ? new NearAdapter({ chain: nearChain(network), address: accounts.near.address, ...h, ...a }) : null;
  const sui = accounts.sui ? new SuiAdapter({ chain: suiChain(network), address: accounts.sui.address, ...h, ...a }) : null;
  // Hedera on a Ledger: only the ED25519 key read with `hw_key_add` (never a vault EVM address).
  const hbar = !isHiddenFamily('hbar') && accounts.hbar && (!hw || isHbarEd25519Key(accounts.hbar.address)) ? new HbarAdapter({ chain: hbarChain(network), address: accounts.hbar.address, ...h, ...a }) : null;
  const kaspa = accounts.kas && !hw ? new KaspaAdapter({ chain: kaspaChain(network), address: accounts.kas.address, ...a }) : null;
  const polkadot = accounts.polkadot ? new PolkadotAdapter({ chain: polkadotChain(network), address: accounts.polkadot.address, ...a }) : null;
  const algo = accounts.algo ? new AlgorandAdapter({ chain: algorandChain(network), address: accounts.algo.address, ...h, ...a }) : null;
  // Monero: scanned locally by Rust.
  const xmr = accounts.xmr && !hw ? new XmrAdapter({ chain: xmrChain(network), address: accounts.xmr.address, ...a }) : null;
  const ton = accounts.ton ? new TonAdapter({ chain: tonChain(network), address: accounts.ton.address, ...h, ...a }) : null;
  const cosmos = accounts.cosmos ? new CosmosAdapter({ chain: cosmosChain(network), address: accounts.cosmos.address, ...h, ...a }) : null;
  const aptos = accounts.aptos ? new AptosAdapter({ chain: aptosChain(network), address: accounts.aptos.address, ...h, ...a }) : null;
  const zec = accounts.zec ? new ZcashAdapter({ chain: zecChain(network), account: accounts.zec, ...(account && !hw ? { vaultAccount: account } : {}), ...h }) : null;
  const all: AnyAdapter[] = [
    ...(btc ? [btc] : []),
    ...evm.values(),
    ...(sol ? [sol] : []),
    ...(ltc ? [ltc] : []),
    ...(doge ? [doge] : []),
    ...(bch ? [bch] : []), ...(dash ? [dash] : []), ...(zec ? [zec] : []), ...(tron ? [tron] : []),
    ...(xrp ? [xrp] : []),
    ...(cardano ? [cardano] : []), ...(stellar ? [stellar] : []), ...(near ? [near] : []), ...(sui ? [sui] : []), ...(hbar ? [hbar] : []),
    ...(kaspa ? [kaspa] : []),
    ...(polkadot ? [polkadot] : []),
    ...(algo ? [algo] : []),
    ...(xmr ? [xmr] : []),
    ...(ton ? [ton] : []),
    ...(cosmos ? [cosmos] : []),
    ...(aptos ? [aptos] : []),
  ];
  return { btc, evm, sol, ltc, doge, bch, dash, tron, xrp, cardano, stellar, near, sui, hbar, kaspa, polkadot, algo, xmr, ton, cosmos, aptos, zec, all, hw: hw ?? null };
}


export { ZcashAdapter, rustZecBackend, zecAddressProblem, type ZecBackend, type ZecUnsigned, type ZecSigned, type DerivedZecAddress } from './zcash/adapter';


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

/** Litecoin / Dogecoin / Bitcoin Cash / Dash adapters from `accounts_get` or a hardware-wallet account. */
export function createUtxoAdapters(
  accounts: { network: Network; ltc?: UtxoAccountView; doge?: UtxoAccountView; bch?: UtxoAccountView; dash?: UtxoAccountView },
  backends: { ltc?: UtxoBackend; doge?: UtxoBackend; bch?: UtxoBackend; dash?: UtxoBackend } = {},
  vaultAccount = 0,
  hw?: HwSigner,
): UtxoAdapterSet {
  const n = accounts.network;
  const a = { ...(vaultAccount ? { vaultAccount } : {}), ...(hw ? { hw } : {}) };
  return {
    ltc: accounts.ltc ? new LitecoinAdapter({ chain: ltcChain(n), account: accounts.ltc, ...(backends.ltc ? { backend: backends.ltc } : {}), ...a }) : null,
    doge: accounts.doge ? new DogecoinAdapter({ chain: dogeChain(n), account: accounts.doge, ...(backends.doge ? { backend: backends.doge } : {}), ...a }) : null,
    bch: accounts.bch ? new BitcoinCashAdapter({ chain: bchChain(n), account: accounts.bch, ...(backends.bch ? { backend: backends.bch } : {}), ...a }) : null,
    dash: accounts.dash ? new DashAdapter({ chain: dashChain(n), account: accounts.dash, ...(backends.dash ? { backend: backends.dash } : {}), ...a }) : null,
  };
}


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


export {
  CosmosAdapter,
  rustCosmosBackend,
  isCosmosAddress,
  cosmosAddressProblem,
  cosmosMemoProblem,
  atomToUatom,
  COSMOS_MAX_MEMO,
  type CosmosAdapterOptions,
  type CosmosBackend,
  type CosmosAccountInfo,
  type CosmosContext,
  type CosmosHistoryEntry,
  type CosmosTxStatus,
  type CosmosTxSummary,
  type CosmosWarning,
  type CosmosUnsigned,
  type CosmosSigned,
} from './cosmos/adapter';


export {
  AptosAdapter,
  rustAptosBackend,
  isAptosAddress,
  aptosAddressProblem,
  APT_NEW_ACCOUNT_GAS_HINT,
  type AptosAdapterOptions,
  type AptosBackend,
  type AptosAccountInfo,
  type AptosContext,
  type AptosHistoryEntry,
  type AptosTxSummary,
  type AptosWarning,
  type AptosUnsigned,
  type AptosSigned,
} from './aptos/adapter';
