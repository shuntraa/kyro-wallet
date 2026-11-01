// SPDX-License-Identifier: GPL-3.0-or-later
//
// Typed contract between the React UI and the Tauri shell.
// Source of truth: docs/IPC.md (§2). Any change starts there.
//
// Conventions (Tauri): command names in snake_case, argument keys in camelCase.
// Amounts travel as decimal strings in the smallest unit (sats, wei, lamports).

import type { Lang, LanguagePref } from './i18n';
import { l10n } from './i18n';

export type Network = 'mainnet' | 'testnet';
export type BtcKind = 'segwit' | 'taproot';
export type { Currency } from './fiat';
import type { Currency } from './fiat';

export interface VaultStatus {
  exists: boolean;
  unlocked: boolean;
  autoLockSecs: number;
  /** Seconds left before auto-lock, `null` when locked. */
  lockInSecs: number | null;
}

export interface BtcAccountInfo {
  address: string;
  xpub: string;
  /** Master key fingerprint, 8 hex chars. */
  fingerprint: string;
  /** Account path, e.g. `m/84'/1'/0'`. */
  path: string;
}

/** An address and the derivation path of its key. */
export interface AddressInfo {
  address: string;
  /** e.g. `m/44'/60'/0'/0/1`. */
  path: string;
}

/**
 * `accounts_get({ account? })`: public data of account `account` (0 = the historical one) on
 * every chain (§2.9). Paths below are for account `a`.
 */
export interface Accounts {
  network: Network;
  /** Account index of everything below. */
  account: number;
  btc: { segwit: BtcAccountInfo; taproot: BtcAccountInfo };
  /** `m/44'/60'/0'/0/a` (address index, MetaMask / Trezor Suite layout). */
  evm: AddressInfo;
  /** `m/44'/501'/a'/0'`. */
  sol: AddressInfo;
  /** Litecoin BIP84 `m/84'/2'/a'` (testnet `m/84'/1'/a'`); `address` = `…/0/0` (§2.4). */
  ltc: UtxoAccountInfo;
  /** Dogecoin BIP44 P2PKH `m/44'/3'/a'` (testnet `m/44'/1'/a'`). */
  doge: UtxoAccountInfo;
  /** Bitcoin Cash BIP44 P2PKH `m/44'/145'/a'` (chipnet `m/44'/1'/a'`), CashAddr `bitcoincash:q…` / `bchtest:q…`. */
  bch: UtxoAccountInfo;
  /** Dash BIP44 P2PKH `m/44'/5'/a'` (testnet `m/44'/1'/a'`), `X…` / `y…`. */
  dash: UtxoAccountInfo;
  /** TRON `m/44'/195'/a'/0/0` (same path on Nile), `T…` (§2.5). */
  tron: AddressInfo;
  /** XRP Ledger `m/44'/144'/a'/0/0` (same path on testnet), classic `r…` (§2.6). */
  xrp: AddressInfo;
  /** Stellar `m/44'/148'/a'` (SEP-0005, same key on testnet), `G…` (§2.11). */
  stellar: AddressInfo;
  /**
   * Cardano CIP-1852 (Icarus) base address `m/1852'/1815'/a'/0/0`. Single-address mode: receive
   * and change both use it; Rust signs with index 0 of the account only (§2.7).
   */
  cardano: AddressInfo;
  /** NEAR `m/44'/397'/a'` (SLIP-10 ed25519), implicit account = 64 hex of the public key (§2.11). */
  near: AddressInfo;
  /** Sui `m/44'/784'/a'/0'/0'` (SLIP-10 ed25519, same path on testnet), `0x` + 64 hex (§2.11). */
  sui: AddressInfo;
  /**
   * Hedera: EVM address (EIP-55) of the ECDSA key `m/44'/3030'/0'/0/a` (SDK standard path); the
   * account `0.0.x` is created by the first transfer to it and read with `hbar_account` (§2.11).
   */
  hbar: AddressInfo;
  /**
   * Kaspa receive address `m/44'/111111'/a'/0/0` (same path on testnet-10, `kaspatest:`). Change
   * goes to `…/1/0`; balance and history read the first 20 addresses of both chains (§2.11).
   * Absent from hardware-wallet accounts.
   */
  kas?: AddressInfo;
  /**
   * Polkadot Asset Hub, sr25519 from the phrase's entropy (substrate-bip39, like Polkadot.js,
   * Nova, Talisman): account 0 = root key, account a = `//a`; SS58 prefix 0 (testnet: 42) (§2.11).
   */
  polkadot: AddressInfo;
  /**
   * Algorand `m/44'/283'/a'/0/0`, derived like the Ledger Algorand app (same path on testnet),
   * 58-character base32 address (§2.11). Not Pera's 25-word format.
   */
  algo: AddressInfo;
  /**
   * Monero primary address (stagenet on testnet), spend key `sc_reduce32(keccak256(k))` of the
   * BIP32 key `m/44'/128'/a'/0/0` (§2.11). Subaddresses: `xmr_new_subaddress`.
   */
  xmr: AddressInfo;
  /**
   * TON `m/44'/607'/a'` (SLIP-10 ed25519, Trust Wallet's route), wallet v4R2, non-bounceable
   * `UQ…` (testnet `0Q…`, another wallet id: another address) (§2.11).
   */
  ton: AddressInfo;
  /** Cosmos Hub `m/44'/118'/a'/0/0` (same path on testnet), `cosmos1…` (§2.11). */
  cosmos: AddressInfo;
  /** Aptos `m/44'/637'/a'/0'/0'` (Petra, SLIP-10 ed25519), `0x` + 64 hex (§2.11). */
  aptos: AddressInfo;
  /**
   * Zcash, transparent addresses only: BIP44 P2PKH `m/44'/133'/a'` (testnet `m/44'/1'/a'`),
   * `address` = `…/0/0` (`t1…` / `tm…`) (§2.4b).
   */
  zec: UtxoAccountInfo;
}

/** Chains with an account list in the vault (§2.9). EVM chains share one list. */
export type AccountChain = 'btc' | 'evm' | 'sol' | 'ltc' | 'doge' | 'tron' | 'xrp' | 'ada' | 'xlm' | 'near' | 'bch' | 'dash' | 'sui' | 'hbar' | 'kas' | 'dot' | 'algo' | 'xmr' | 'ton' | 'cosmos' | 'apt' | 'zec';
export const ACCOUNT_CHAINS: readonly AccountChain[] = ['btc', 'evm', 'sol', 'ltc', 'doge', 'tron', 'xrp', 'ada', 'xlm', 'near', 'bch', 'dash', 'sui', 'hbar', 'kas', 'dot', 'algo', 'xmr', 'ton', 'cosmos', 'apt', 'zec'];

/** One account of the user's list: a public bookmark (keys come from the seed). */
export interface VaultAccountEntry {
  index: number;
  name: string;
}

/** `vault_accounts_get`: per chain, sorted by index, account 0 always first. */
export type VaultAccountLists = Record<AccountChain, VaultAccountEntry[]>;

/** Highest vault account index accepted by Rust; at most this many accounts per chain. */
export const MAX_VAULT_ACCOUNT = 100;
export const MAX_ACCOUNTS_PER_CHAIN = 20;
/** Account names: 1–32 characters, no control character (trimmed by Rust). */
export const MAX_ACCOUNT_NAME = 32;

/** Optional vault account of a command (absent = 0). */
export interface WithAccount {
  account?: number;
}

/** One Litecoin / Dogecoin / Bitcoin Cash / Dash account (standard `xpub` / `tpub` encoding for all). */
export interface UtxoAccountInfo {
  address: string;
  xpub: string;
  fingerprint: string;
  path: string;
}

/** API keys the shell knows. `trongrid`: TronGrid `TRON-PRO-API-KEY` (optional, higher rate limits). */
export type ApiKeyName = 'coingecko' | 'zerox' | 'trongrid';
export const API_KEY_NAMES: readonly ApiKeyName[] = ['coingecko', 'zerox', 'trongrid'];

/**
 * Write-only API key changes in `settings_set`: name absent or `null` = unchanged, `""` = remove,
 * non-empty = set after trim (blank after trim or a control character → INVALID_INPUT). The UI
 * only ever sends a value the user just typed.
 */
export type ApiKeysUpdate = Partial<Record<ApiKeyName, string | null>>;

/** What `settings_set` takes: the settings without `apiKeysSet`, plus optional key changes. */
export type SettingsInput = Omit<Settings, 'apiKeysSet'> & { apiKeys?: ApiKeysUpdate };

export interface Settings {
  currency: Currency;
  autoLockSecs: number;
  hideBalancesOnStart: boolean;
  captureProtection: boolean;
  clipboardGuard: boolean;
  /** Custom server per chain (B2b). Replaces the old `rpc` (still accepted by Rust on input, never returned). */
  servers: Servers;
  /**
   * Which API keys are saved. The values are NEVER returned by `settings_get` / `settings_set`
   * (redacted); a key is only ever written through `SettingsInput.apiKeys`.
   */
  apiKeysSet: Partial<Record<ApiKeyName, boolean>>;
  /** Embedded Tor for every `net_fetch`. Default `{ enabled: true }`; turning it off needs an explicit UI confirmation. */
  tor: { enabled: boolean };
  /**
   * Display language of the interface AND of the native dialogs (signing, warnings, phrase).
   * `auto` (default) follows the computer: French if its language is French, English otherwise.
   */
  language: LanguagePref;
  /** Automatic updates from Kyro's signed GitHub releases (default `true`, docs/IPC.md `update_status`). */
  autoUpdate: boolean;
}

/** `update_status`: the running version, and (once, after a start that applied an update) the new one. */
export interface UpdateStatus {
  version: string;
  updatedTo: string | null;
}

// ---------------------------------------------------------------- custom servers (B2b, docs/IPC.md §2–2.2)

/** Bitcoin network key of `servers.bitcoin` (≠ `Network`: testnet is testnet4). */
export type BtcNetworkKey = 'mainnet' | 'testnet4';
export type SolanaCluster = 'devnet' | 'mainnet-beta';

export type ElectrumTls = 'webpki' | 'pinned' | 'none';

export type CoreAuth =
  | { kind: 'cookie'; cookiePath: string }
  /**
   * `password` is NEVER returned by `settings_get` (`hasPassword` instead). In `settings_set`:
   * absent = keep the stored one (same URL and same user), `""` = clear it, a value = replace it.
   */
  | { kind: 'userpass'; user: string; password?: string; hasPassword?: boolean };

/** Bitcoin server. Key absent in `servers.bitcoin` = default. */
export type BtcServer =
  | { kind: 'default' }
  | { kind: 'esplora'; url: string }
  | { kind: 'electrum'; host: string; port: number; tls: ElectrumTls; /** 64 hex, required when `pinned`. */ certSha256?: string }
  | { kind: 'core'; url: string; auth: CoreAuth }
  /**
   * Compact block filters BIP157/158 (cargo feature `cbf`). `peers`: extra peers "onion:port"
   * or "ip:port", never a host name. `birthHeight`: first block to scan (wallet birthday).
   * In a build without the feature, `settings_set` / `server_test` answer `FEATURE_DISABLED`.
   */
  | { kind: 'cbf'; peers?: string[]; birthHeight?: number };

export type BtcServerKind = BtcServer['kind'];

export interface RpcServer {
  url: string;
}

/**
 * Absent key = default server. Once a custom server is set for a chain, Rust REFUSES that
 * chain's default (`DEFAULT_SERVER_DISABLED`): never a silent fallback.
 */
export interface Servers {
  bitcoin: { mainnet?: BtcServer; testnet4?: BtcServer };
  /** Key: decimal chain id, e.g. `"11155111"`. */
  evm: Record<string, RpcServer>;
  solana: Partial<Record<SolanaCluster, RpcServer>>;
  /** Litecoin (`testnet` = Litecoin testnet4). Default: litecoinspace.org. */
  litecoin: { mainnet?: UtxoServer; testnet?: UtxoServer };
  /** Dogecoin. Default: public ElectrumX servers on mainnet; none on testnet (SERVER_INVALID until one is set). */
  dogecoin: { mainnet?: UtxoServer; testnet?: UtxoServer };
  /** Bitcoin Cash (`testnet` = chipnet). Default: public Fulcrum servers on both. */
  bitcoincash: { mainnet?: UtxoServer; testnet?: UtxoServer };
  /** Dash. Default: public ElectrumX servers on mainnet; none on testnet. */
  dash: { mainnet?: UtxoServer; testnet?: UtxoServer };
  /** TRON (`testnet` = Nile). Default: TronGrid (api.trongrid.io / nile.trongrid.io). */
  tron: { mainnet?: TronServer; testnet?: TronServer };
  /** XRP Ledger (`testnet` = XRPL Testnet). Default: s.altnet.rippletest.net / xrplcluster.com. */
  xrp: { mainnet?: XrpServer; testnet?: XrpServer };
  /** Cardano (`testnet` = preprod). Default: Koios (preprod.koios.rest / api.koios.rest). */
  cardano: { mainnet?: CardanoServer; testnet?: CardanoServer };
  /** Monero (`testnet` = stagenet). Default: xmr-node.cakewallet.com:18081 / monero-stagenet.stackwallet.com:38081. */
  monero?: { mainnet?: MoneroServer; testnet?: MoneroServer };
}

/** Monero server: the default public node, or the user's `monerod` RPC (restricted RPC is enough). */
export type MoneroServer = { kind: 'default' } | { kind: 'node'; url: string };

/** Cardano server: Koios by default, or a Koios-compatible REST API (`…/api/v1`). */
export type CardanoServer = { kind: 'default' } | { kind: 'koios'; url: string };

/** XRP Ledger server: the default rippled, or the user's rippled JSON-RPC endpoint. */
export type XrpServer = { kind: 'default' } | { kind: 'jsonRpc'; url: string };

/**
 * TRON server: TronGrid by default, or a java-tron HTTP API (FullNode). History (`tron_txs`)
 * needs TronGrid's `/v1` API in addition: a plain java-tron node has none.
 */
export type TronServer = { kind: 'default' } | { kind: 'http'; url: string };

/** Litecoin / Dogecoin / Bitcoin Cash / Dash server: Kyro's default (see `Servers`) or an Esplora-compatible API. */
export type UtxoServer = { kind: 'default' } | { kind: 'esplora'; url: string };
export type UtxoCoinKey = 'litecoin' | 'dogecoin' | 'bitcoincash' | 'dash';
/** Network key of `servers.{litecoin,dogecoin,bitcoincash,dash}`. */
export type UtxoNetworkKey = 'mainnet' | 'testnet';

export type ServerTestTarget =
  | { family: 'bitcoin'; network: BtcNetworkKey; server: BtcServer }
  | { family: 'evm'; chainId: number; server: RpcServer }
  | { family: 'solana'; cluster: SolanaCluster; server: RpcServer }
  | { family: 'litecoin'; network: UtxoNetworkKey; server: UtxoServer }
  | { family: 'dogecoin'; network: UtxoNetworkKey; server: UtxoServer }
  /** `testnet` = chipnet. */
  | { family: 'bitcoincash'; network: UtxoNetworkKey; server: UtxoServer }
  | { family: 'dash'; network: UtxoNetworkKey; server: UtxoServer }
  /** `testnet` = Nile. */
  | { family: 'tron'; network: UtxoNetworkKey; server: TronServer }
  /** `testnet` = XRPL Testnet (network_id 1). */
  | { family: 'xrp'; network: UtxoNetworkKey; server: XrpServer }
  /** `testnet` = preprod (network magic 1). */
  | { family: 'cardano'; network: UtxoNetworkKey; server: CardanoServer }
  /** `testnet` = Monero stagenet (block 0 and `nettype` checked). */
  | { family: 'monero'; network: UtxoNetworkKey; server: MoneroServer };

export interface ServerTestResult {
  latencyMs: number;
  detected: { network?: string; genesisHash?: string; chainId?: number; serverVersion?: string; blockHeight?: number };
}

export interface ElectrumCertInfo {
  /** SHA-256 of the DER certificate, lowercase hex: pin it as `certSha256`. */
  sha256: string;
  /** Whether normal (CA) validation accepts it for this host name. */
  webpkiValid: boolean;
}

export interface BtcBackendInfo {
  kind: BtcServerKind;
  network: BtcNetworkKey;
  /** Host (or host:port), never credentials. */
  label: string;
  tor: boolean;
}

/** `not-configured`: no Bitcoin Core server for this network (a normal answer, not an error). */
export type CoreState = 'not-configured' | 'idle' | 'importing' | 'ready' | 'error';

export interface CoreStatus {
  /** `kyro-watch-<fingerprint8>` */
  wallet: string;
  state: CoreState;
  walletLoaded: boolean;
  /** 0..1 while a rescan runs. */
  scanProgress?: number;
  scanDurationSecs?: number;
  error?: string;
}

/** `'now'` (no rescan, new wallet) or a UNIX timestamp in seconds. */
export type CoreRescanFrom = 'now' | number;

// Esplora shapes returned by the btc_* commands, whatever the backend (§2.2).
export interface EsploraStats {
  funded_txo_sum: number;
  spent_txo_sum: number;
  tx_count: number;
}
export interface EsploraAddressInfo {
  address: string;
  /** With Electrum / Core: funded = net balance, spent = 0 (or the negative part). `tx_count` is exact. */
  chain_stats: EsploraStats;
  mempool_stats: EsploraStats;
}
export interface EsploraUtxo {
  txid: string;
  vout: number;
  value: number;
  status: { confirmed: boolean; block_height?: number };
}
export interface EsploraTxOut {
  scriptpubkey: string;
  scriptpubkey_address?: string;
  value: number;
}
export interface EsploraTx {
  txid: string;
  /** Absent when an input's prevout is unknown. */
  fee?: number;
  status: { confirmed: boolean; block_height?: number; block_time?: number };
  /** `prevout: null` when the server does not have the funding tx (Core: outside the wallet). */
  vin: Array<{ txid: string; vout: number; prevout: EsploraTxOut | null }>;
  vout: EsploraTxOut[];
}
export interface BtcFeeRates {
  fastestFee: number;
  halfHourFee: number;
  hourFee: number;
  economyFee: number;
  minimumFee: number;
  /** Compact filters: average of the fees paid in the last blocks, not a mempool estimate. */
  source?: 'block-average';
}

/** `idle` | `connecting` | `headers` | `filters` (blocks matching our scripts are fetched during this phase) | `synced` | `error`. */
export type CbfState = 'idle' | 'connecting' | 'headers' | 'filters' | 'synced' | 'error';

/** Compact-filter sync state (`btc_cbf_status`, `btc_cbf_sync`, `cbf-status` event). */
export interface CbfStatus {
  state: CbfState;
  /** Rust serializes absent values as `null`. */
  tipHeight?: number | null;
  scannedHeight?: number | null;
  birthHeight: number;
  /** 0..1 over the filter range being scanned. */
  progress: number;
  /** Connected peers (onion name or ip:port). */
  peers: string[];
  tor: boolean;
  lastSyncUnix?: number | null;
  watchedScripts: number;
  /** Blocks whose filter matched our scripts (downloaded in full). */
  matchedBlocks: number;
  message?: string;
}

// ---------------------------------------------------------------- Litecoin, Dogecoin, Bitcoin Cash, Dash (§2.4)

export interface UtxoBackendInfo {
  kind: 'default' | 'esplora';
  network: UtxoNetworkKey;
  /** Host, `""` when there is none (Dogecoin without a configured server). */
  label: string;
  /** `false`: no server at all, every read fails with SERVER_INVALID until one is set. */
  available: boolean;
  tor: boolean;
}

export interface UtxoFeeRates {
  /** Smallest unit per vbyte: litoshis/vB, koinus/byte, sat/byte (Bitcoin Cash), duffs/byte (Dash). */
  fastestFee: number;
  halfHourFee: number;
  hourFee: number;
  economyFee: number;
  minimumFee: number;
  /** Server without estimates: the chain's floor (0.01 DOGE/kB; 1 sat/B for Bitcoin Cash and Dash). */
  source?: 'policy';
}

export type UtxoWarning =
  | { kind: 'unknownOutput'; index: number }
  | { kind: 'opReturn'; index: number }
  | { kind: 'foreignInput'; index: number }
  | { kind: 'softDust'; index: number }
  | { kind: 'highFee' }
  /** Our key beyond MAX_CHANGE_INDEX (1000): counted as a payment, not change. */
  | { kind: 'changeIndexOutOfRange'; index: number }
  | { kind: 'feeBelowMinimum'; minimum: string };

/** Rust's decoding of the PSBT it signs (`wallet_core::UtxoTxSummary`). Amounts: decimal strings. */
export interface UtxoTxSummary {
  coin: UtxoCoinKey;
  outputs: Array<{ address: string | null; script: string; amount: string; isChange: boolean; kind: 'address' | 'opReturn' | 'unknown' }>;
  inputs: number;
  ourInputs: number;
  fee: string;
  /** vbytes (Litecoin) or bytes (Dogecoin, Bitcoin Cash, Dash), worst-case signature. */
  size: number;
  feePerKb: number;
  /** `false`: what is not sent is fee (a remainder below the dust limit cannot be change). */
  hasChange: boolean;
  warnings: UtxoWarning[];
  requiresExtraConfirmation: boolean;
}

/** Command prefix of each UTXO chain and the `coin` of its Rust summary. */
export type UtxoPrefix = 'ltc' | 'doge' | 'bch' | 'dash';
export const UTXO_COIN_KEY: Record<UtxoPrefix, UtxoCoinKey> = { ltc: 'litecoin', doge: 'dogecoin', bch: 'bitcoincash', dash: 'dash' };
type CoinOf<P extends UtxoPrefix> = P extends 'ltc' ? 'litecoin' : P extends 'doge' ? 'dogecoin' : P extends 'bch' ? 'bitcoincash' : 'dash';

/** The `{ltc,doge,bch,dash}_*` commands, same shapes (§2.4). */
export interface UtxoCommands<P extends UtxoPrefix> {
  backend_info: { args: undefined; ret: UtxoBackendInfo };
  /** Vault unlocked. */
  address: { args: { change: boolean; index: number } & WithAccount; ret: string };
  address_info: { args: { address: string }; ret: EsploraAddressInfo };
  address_utxos: { args: { address: string }; ret: EsploraUtxo[] };
  /** At most `BTC_TXS_CAP`, unconfirmed first. */
  address_txs: { args: { address: string }; ret: EsploraTx[] };
  /** Raw transaction, txid recomputed by Rust (no witness for Dogecoin / Bitcoin Cash / Dash; a Dash special transaction is refused). */
  tx_hex: { args: { txid: string }; ret: string };
  fee_rates: { args: undefined; ret: UtxoFeeRates };
  tip_height: { args: undefined; ret: number };
  broadcast: { args: { hex: string }; ret: string };
  /**
   * Password → Rust summary → native dialog (+ reinforced) → signed. NOT finalized, except
   * Bitcoin Cash: a FORKID signature cannot be a PSBT partial signature, Rust finalizes it.
   */
  sign_psbt: { args: { psbt: string; password: string } & WithAccount; ret: { psbt: string; summary: UtxoTxSummary & { coin: CoinOf<P> } } };
}

type Prefixed<P extends UtxoPrefix> = { [K in keyof UtxoCommands<P> as `${P}_${K & string}`]: UtxoCommands<P>[K] };

// ---------------------------------------------------------------- Zcash, transparent only (§2.4b)

/** Zcash backend: Kyro's default Electrum servers only (mainnet); none on testnet. */
export interface ZecBackendInfo {
  kind: 'default';
  network: Network;
  /** Host, `""` on testnet (no public server). */
  label: string;
  /** `false`: no server, every read fails with SERVER_INVALID. */
  available: boolean;
  tor: boolean;
}

/** A coin the interface proposes: outpoint and which address of the account it pays. No amount: Rust reads it from the previous transaction. */
export interface ZecCandidate {
  txid: string;
  vout: number;
  change: boolean;
  index: number;
}

/** A Zcash send as the interface describes it; Rust builds the transaction. `amount` in zatoshis. */
export interface ZecSendArgs {
  to: string;
  amount: string;
  max: boolean;
  coins: ZecCandidate[];
  /** Our change address `m/44'/133'/a'/1/changeIndex`. */
  changeIndex: number;
}

export type ZecWarning = { kind: 'highFee' } | { kind: 'expiryCapped'; nextUpgradeHeight: number };

/** Rust's construction and decoding (`wallet_core::ZecTxSummary`). Amounts: zatoshis, decimal strings. */
export interface ZecTxSummary {
  to: string;
  toKind: 'p2pkh' | 'p2sh' | 'tex';
  /** For a TEX recipient (ZIP 320), the `t1…` address it encodes. */
  toAddress: string;
  amount: string;
  change: { address: string; amount: string; index: number } | null;
  fee: string;
  zip317Fee: string;
  /** Remainder too small for a change output, included in `fee`. */
  folded: string;
  inputs: number;
  inputTotal: string;
  /** e.g. `NU6.3`. */
  upgrade: string;
  branchId: string;
  targetHeight: number;
  expiryHeight: number;
  txid: string;
  warnings: ZecWarning[];
  requiresExtraConfirmation: boolean;
}

export interface ZecCommands {
  zec_backend_info: { args: undefined; ret: ZecBackendInfo };
  /** Vault unlocked. */
  zec_address: { args: { change: boolean; index: number } & WithAccount; ret: string };
  zec_address_info: { args: { address: string }; ret: EsploraAddressInfo };
  /** Each UTXO checked by Rust against its previous transaction (`coinbase`: mined coin, not spendable by Kyro). */
  zec_address_utxos: { args: { address: string }; ret: Array<EsploraUtxo & { coinbase?: boolean }> };
  /** At most `BTC_TXS_CAP`, unconfirmed first; `shielded: true` = the transaction also moves shielded value (no transparent fee). */
  zec_address_txs: { args: { address: string }; ret: Array<EsploraTx & { shielded?: boolean }> };
  zec_tip_height: { args: undefined; ret: number };
  /** The server's txid must equal the one Rust computes (ZIP 244). */
  zec_broadcast: { args: { hex: string }; ret: string };
  /** Vault unlocked; no password. What `zec_sign` would sign (same construction). */
  zec_send_preview: { args: { request: ZecSendArgs } & WithAccount; ret: ZecTxSummary };
  /** Password → Rust builds and decodes → native dialog (+ reinforced) → signed v5 transaction. */
  zec_sign: { args: { request: ZecSendArgs; password: string } & WithAccount; ret: { hex: string; txid: string; summary: ZecTxSummary } };
}

// ---------------------------------------------------------------- TRON (§2.5)

export interface TronBackendInfo {
  kind: 'default' | 'http';
  /** `testnet` = Nile. */
  network: UtxoNetworkKey;
  /** Host of the server in use. */
  label: string;
  tor: boolean;
}

/** `tron_account`: `getaccount` + `getaccountresource`. */
export interface TronAccountInfo {
  address: string;
  /** Has received TRX at least once. Sending TRX to a non-existing account activates it (≈ 1.1 TRX burned). */
  exists: boolean;
  /** Sun, decimal string. */
  balance: string;
  /** Daily free bandwidth (bytes) and what is used of it. */
  freeBandwidthLimit: number;
  freeBandwidthUsed: number;
  /** Bandwidth / energy from staked TRX. */
  bandwidthLimit: number;
  bandwidthUsed: number;
  energyLimit: number;
  energyUsed: number;
}

/** wallet-core `TronAction` (serde tag `type`). Amounts: decimal strings (sun or raw token units). */
export type TronAction =
  | { type: 'trxTransfer'; to: string; amount: string }
  | { type: 'trc20Transfer'; contract: string; to: string; amount: string; callValue: string }
  | { type: 'contractCall'; contract: string; selector: string; data: string; callValue: string };

/** Every warning → reinforced confirmation. */
export type TronWarning = { kind: 'unknownCall'; selector: string } | { kind: 'callValue' } | { kind: 'memo' } | { kind: 'highFeeLimit' } | { kind: 'unusualText' };

/** Rust's decoding of `raw_data` (`wallet_core::TronTxSummary`). */
export interface TronTxSummary {
  txid: string;
  owner: string;
  action: TronAction;
  /** Sun: the most the energy may burn. */
  feeLimit: string;
  /** ms epoch. */
  expiration: number;
  timestamp: number;
  refBlockBytes: string;
  refBlockHash: string;
  /** Hex. */
  memo: string;
  /** Memo as sanitized text (wallet-core `sanitize_text`), null when not UTF-8. */
  memoText?: string | null;
  rawSize: number;
  warnings: TronWarning[];
  requiresExtraConfirmation: boolean;
}

/** Resources and TRX burned (`tron_backend::TronEstimate`). Amounts: sun, decimal strings. */
export interface TronEstimate {
  /** Bytes charged: signed size + 64. */
  bandwidthNeeded: number;
  freeBandwidth: number;
  stakedBandwidth: number;
  /** Burned for bandwidth when neither free nor staked bandwidth covers it. */
  bandwidthBurn: string;
  /** TRX to an account that does not exist yet: creation fee (+ bandwidth of the creation); 0 otherwise. */
  activationFee: string;
  recipientExists: boolean;
  /** TRC-20: simulated energy (`energy_used + energy_penalty`), energy from staking. */
  energyNeeded: number;
  energyAvailable: number;
  /** Sun per energy unit. */
  energyFee: number;
  /** Expected burn for energy (not covered × energyFee, at most feeLimit). */
  energyBurn: string;
  /** `fee_limit`: most the energy may burn. */
  feeLimit: string;
  /** Expected total burn: bandwidth + activation + energy. */
  totalBurn: string;
  /** Upper bound: bandwidth + activation + fee_limit. */
  totalBurnMax: string;
  /** Our TRX balance, sun. */
  balance: string;
}

/** `tron_txs` entry (TronGrid `/v1`, newest first, 50 TRX + 50 TRC-20 at most). */
export interface TronHistoryEntry {
  txid: string;
  kind: 'trx' | 'trc20';
  from: string | null;
  to: string | null;
  /** Sun or raw token units. */
  amount: string;
  token?: { contract: string; symbol: string; decimals: number };
  timestamp: number | null;
  status: 'confirmed' | 'failed';
}

// ---------------------------------------------------------------- XRP Ledger (§2.6)

export interface XrpBackendInfo {
  kind: 'default' | 'jsonRpc';
  network: UtxoNetworkKey;
  label: string;
  tor: boolean;
}

/** `xrp_account`: `account_info` + reserves of `server_info.validated_ledger`. Amounts: drops. */
export interface XrpAccountInfo {
  address: string;
  /** Activated (funded with at least the base reserve). `false`: never funded. */
  exists: boolean;
  balance: string;
  sequence: number;
  ownerCount: number;
  flags: number;
  /** `lsfRequireDestTag`: payments without a destination tag are refused. */
  requireDestTag: boolean;
  /** `lsfDisallowXRP` (advisory). */
  disallowXrp: boolean;
  /** Locked: base reserve + owner reserve × owned objects. */
  reserve: string;
  /** Balance − reserve (0 if negative): what can be sent. */
  spendable: string;
}

/** serde tag `kind`. */
export type XrpAmountView = { kind: 'xrp'; drops: string } | { kind: 'issued'; value: string; currency: string; issuer: string };

/** Every warning → reinforced confirmation. */
export type XrpWarning = { kind: 'sendMax' } | { kind: 'pathFlags' } | { kind: 'memo' } | { kind: 'highFee' } | { kind: 'invoiceId' } | { kind: 'unusualText' };

/** wallet-core `XrpTxSummary`: Rust's strict decoding of the Payment. */
export interface XrpTxSummary {
  account: string;
  destination: string;
  /** null = no tag. */
  destinationTag: number | null;
  amount: XrpAmountView;
  /** Drops. */
  fee: string;
  sequence: number;
  lastLedgerSequence: number | null;
  flags: number;
  sendMax: XrpAmountView | null;
  sourceTag: number | null;
  invoiceId: string | null;
  memos: Array<{ memoType: string | null; memoData: string | null; memoFormat: string | null; text: string | null }>;
  warnings: XrpWarning[];
  requiresExtraConfirmation: boolean;
}

/** Live context Rust read for the dialog: both accounts and the reserves (drops). */
export interface XrpContext {
  account: XrpAccountInfo;
  destination: XrpAccountInfo;
  reserveBase: string;
  reserveInc: string;
}

/** `xrp_txs` entry: last 50 Payments; `amount` = delivered amount. */
export interface XrpHistoryEntry {
  hash: string;
  from: string;
  to: string;
  destinationTag: number | null;
  amount: XrpAmountView | null;
  fee: string;
  ledger: number | null;
  /** ms epoch. */
  time: number | null;
  result: string;
}

export interface XrpTrustLine {
  currency: string;
  issuer: string;
  balance: string;
  limit: string;
}

// ---------------------------------------------------------------- Stellar (§2.11)

export interface StellarBackendInfo {
  /** SDF's public Horizon only (no custom server yet). */
  kind: 'default';
  network: UtxoNetworkKey;
  label: string;
  tor: boolean;
}

/** An issued asset held by the account (trustline). Amounts: stroops, decimal strings. */
export interface StellarTrustline {
  code: string;
  issuer: string;
  balance: string;
  limit: string;
}

/** `stellar_account`: Horizon `/accounts/{id}` + base reserve of the latest ledger. Amounts: stroops. */
export interface StellarAccountInfo {
  address: string;
  /** Created (funded with at least 2 × the base reserve). `false`: never funded. */
  exists: boolean;
  balance: string;
  /** Current sequence number (decimal string: exceeds JavaScript's safe integers). */
  sequence: string;
  /** Trustlines, offers, signers, data entries: one base reserve each. */
  subentryCount: number;
  numSponsoring: number;
  numSponsored: number;
  sellingLiabilities: string;
  /** Locked: (2 + subentries + sponsoring − sponsored) × base reserve + selling liabilities. */
  reserve: string;
  /** Balance − reserve (0 if negative): what can be sent. */
  spendable: string;
  /** SEP-0029 `config.memo_required`: a payment without a memo is refused before building. */
  memoRequired: boolean;
  trustlines: StellarTrustline[];
  /** The network's base reserve (0.5 XLM). */
  baseReserve: string;
}

/** serde tag `kind`. */
export type StellarAssetView = { kind: 'native' } | { kind: 'credit'; code: string; issuer: string };

/** `text: null` = not UTF-8 (only `hex`); text is cleaned for display (wallet-core sanitize_text). */
export type StellarMemoView =
  | { kind: 'none' }
  | { kind: 'text'; text: string | null; hex: string }
  | { kind: 'id'; id: string }
  | { kind: 'hash'; hex: string }
  | { kind: 'return'; hex: string };

/** The only operation, decoded by Rust. Amounts: stroops, decimal strings. */
export type StellarOpView =
  | { kind: 'createAccount'; destination: string; startingBalance: string }
  | { kind: 'payment'; destination: string; asset: StellarAssetView; amount: string }
  | { kind: 'changeTrust'; asset: StellarAssetView; limit: string };

/** Every warning → reinforced confirmation. */
export type StellarWarning = { kind: 'highFee' } | { kind: 'unusualText' } | { kind: 'memoReturn' } | { kind: 'removeTrustline' };

/** wallet-core `StellarTxSummary`: Rust's strict decoding of the envelope. */
export interface StellarTxSummary {
  /** Network whose passphrase is in the signed payload. */
  network: Network;
  source: string;
  /** Maximum fee, stroops. */
  fee: string;
  sequence: string;
  /** UNIX seconds; `maxTime` is never 0 (Rust refuses a transaction valid for ever). */
  minTime: number;
  maxTime: number;
  memo: StellarMemoView;
  operation: StellarOpView;
  warnings: StellarWarning[];
  requiresExtraConfirmation: boolean;
}

/** Live context Rust read for the dialog. */
export interface StellarContext {
  account: StellarAccountInfo;
  destination: StellarAccountInfo;
  /** Stroops. */
  baseReserve: string;
  /** Stroops per operation (what is usually charged). */
  baseFee: number;
  /** Close time of the latest ledger, UNIX seconds. */
  ledgerTime: number;
}

/** Memo asked by the interface (serde tag `kind`): text ≤ 28 bytes, id = u64 decimal, hash = 64 hex. */
export type StellarMemoSpec = { kind: 'text'; value: string } | { kind: 'id'; value: string } | { kind: 'hash'; value: string };

/** `stellar_txs` entry: last 50 payments (Payment, CreateAccount, path payments: amount received). */
export interface StellarHistoryEntry {
  id: string;
  hash: string;
  type: 'payment' | 'create_account' | 'path_payment_strict_send' | 'path_payment_strict_receive';
  from: string;
  to: string;
  amount: { kind: 'native'; stroops: string | null } | { kind: 'credit'; code: string; issuer: string; stroops: string | null };
  /** Fee charged to the transaction source, stroops. */
  fee: string | null;
  /** ms epoch. */
  time: number | null;
  successful: boolean;
  memo: { kind: 'none' } | { kind: 'text'; text: string } | { kind: 'id'; id: string } | { kind: 'hash'; value: string } | { kind: 'return'; value: string };
  /** Source account of the transaction (who signed it). */
  txSource: string;
}

// ---------------------------------------------------------------- NEAR (§2.11)

export interface NearBackendInfo {
  kind: 'default';
  network: UtxoNetworkKey;
  /** RPC host (FastNEAR). */
  label: string;
  /** History host (FastNEAR explorer API). */
  history: string;
  tor: boolean;
}

/** `near_account`: `view_account` (finality final). Amounts: yoctoNEAR, decimal strings. */
export interface NearAccountInfo {
  accountId: string;
  /** On chain. An implicit account is created by the first NEAR it receives. */
  exists: boolean;
  /** Liquid balance (`amount`). */
  balance: string;
  /** Locked by validator staking. */
  locked: string;
  storageUsage: number;
  /** What the account must keep for its storage (`storage_usage` × price per byte − locked). */
  storageReserve: string;
  /** Balance − storage reserve: what can be sent (before fees). */
  spendable: string;
  hasContract: boolean;
}

/** `implicit`: 64 hex (ed25519 key); `ethImplicit`: `0x` + 40 hex (NEP-518); `named`: must exist. */
export type NearAccountKind = 'implicit' | 'ethImplicit' | 'named';

/** Every warning → reinforced confirmation. */
export type NearWarning = { kind: 'ethImplicitReceiver' };

/** wallet-core `NearTxSummary`: Rust's strict decoding of the transfer (one `Transfer` action). */
export interface NearTxSummary {
  signerId: string;
  /** `ed25519:…`. */
  publicKey: string;
  nonce: string;
  receiverId: string;
  receiverKind: NearAccountKind;
  /** yoctoNEAR. */
  deposit: string;
  blockHash: string;
  /** Transaction hash (base58), known before broadcast. */
  hash: string;
  warnings: NearWarning[];
  requiresExtraConfirmation: boolean;
}

/** Live context Rust read for the dialog. Fees are not in a NEAR transaction: `feeBound` is Kyro's bound. */
export interface NearContext {
  account: NearAccountInfo;
  receiver: NearAccountInfo;
  /** The transfer creates the receiver (implicit account not on chain yet). */
  createsAccount: boolean;
  gasPrice: string;
  feeEstimate: string;
  feeBound: string;
}

/** `near_txs` entry (last 20, newest first). `deposit`: the transaction's own Transfer actions. */
export interface NearHistoryEntry {
  hash: string;
  from: string;
  to: string;
  kind: 'transfer' | 'other';
  deposit: string;
  fee: string;
  height: number | null;
  /** ms epoch. */
  time: number | null;
  success: boolean;
}

export interface NearTxOutcome {
  hash: string;
  status: 'success' | 'failure' | 'pending';
  message: string;
}

// ---------------------------------------------------------------- Sui (§2.11)

/** Sui: default server only (Sui Foundation GraphQL RPC). */
export interface SuiBackendInfo {
  kind: 'default';
  network: UtxoNetworkKey;
  /** `graphql.testnet.sui.io` / `graphql.mainnet.sui.io`. */
  label: string;
  tor: boolean;
}

/** `sui_balance`, MIST (1 SUI = 10⁹ MIST), decimal strings. */
export interface SuiBalance {
  address: string;
  /** `coin + addressBalance`. */
  total: string;
  /** Held in SUI coin objects: what Kyro can spend. */
  coin: string;
  /** Held in Sui's address-balance accumulator: shown, not spendable by Kyro yet. */
  addressBalance: string;
}

/** serde tag `kind`. Every warning → reinforced confirmation. */
export type SuiWarning = { kind: 'sendAll' } | { kind: 'selfTransfer' } | { kind: 'highGasBudget' } | { kind: 'noExpiration' };

/** wallet-core `SuiTxSummary`: Rust's strict BCS decoding of the transfer. */
export interface SuiTxSummary {
  sender: string;
  recipient: string;
  /** Always `0x2::sui::SUI`. */
  coinType: string;
  /** MIST; null = the whole balance of the gas coins minus the gas used. */
  amount: string | null;
  /** MIST. */
  gasBudget: string;
  /** MIST per gas unit. */
  gasPrice: string;
  gasCoins: Array<{ objectId: string; version: string; digest: string }>;
  expirationEpoch: number | null;
  /** Transaction digest (base58). */
  digest: string;
  warnings: SuiWarning[];
  requiresExtraConfirmation: boolean;
}

/** Live context Rust read for the dialog (MIST): balance, gas coins, simulation. */
export interface SuiContext {
  balance: string;
  gasCoinsTotal: string;
  /** MIST of each gas coin, same order as `summary.gasCoins` (read live). */
  gasCoinBalances: string[];
  referenceGasPrice: string;
  epoch: number;
  computationCost: string;
  storageCost: string;
  storageRebate: string;
  /** `computation + storage − rebate`, signed decimal. */
  fee: string;
  /** Whole-balance transfer: what the recipient receives according to the simulation. */
  receives: string | null;
}

/** `sui_txs` entry: last 20 transactions touching the address, newest first. */
export interface SuiHistoryEntry {
  digest: string;
  /** RFC 3339, null if unknown. */
  timestamp: string | null;
  checkpoint: number | null;
  success: boolean;
  sender: string;
  /** Net SUI change of the address, MIST, signed decimal (fees included). */
  change: string;
  /** Net gas paid (MIST) when the address sent it. */
  fee: string | null;
  counterparty: string | null;
  /** Other coin types moved for the address (not detailed). */
  otherCoins: boolean;
}

export interface SuiTxStatus {
  found: boolean;
  success: boolean;
  error: string | null;
  checkpoint: number | null;
}

export interface SuiBuilt {
  /** Unsigned TransactionData, BCS base64 (what `sui_sign_tx` signs). */
  bcs: string;
  summary: SuiTxSummary;
  context: SuiContext;
}

// ---------------------------------------------------------------- Hedera (§2.11)

export interface HbarBackendInfo {
  network: UtxoNetworkKey;
  /** Mirror node host. */
  label: string;
  tor: boolean;
}

/** What the mirror node says about an account. Amounts: tinybars (10⁻⁸ HBAR). */
export interface HbarAccountInfo {
  exists: boolean;
  /** `0.0.x`. */
  accountId: string | null;
  /** Lower case, as the mirror node says (alias, or long-zero form). */
  evmAddress: string | null;
  balance: string;
  /** Created by a transfer to an EVM address, no key yet: our first transfer sets it. */
  hollow: boolean;
  deleted: boolean;
  /** The account must sign incoming transfers: a plain transfer fails (Rust refuses). */
  receiverSigRequired: boolean;
  /**
   * Our own account only: `alias` (EVM address = our key's) or `publicKey` (account with our key
   * but another EVM address — then **only** `0.0.x` may be used to receive).
   */
  foundBy: 'alias' | 'publicKey' | null;
}

/** `hbar_account`: our account, plus our EVM address from the key (EIP-55) and `0.0.x-checksum`. */
export interface HbarOwnAccount extends HbarAccountInfo {
  address: string;
  accountIdChecksum: string | null;
}

/** `hbar_recipient`: `to` as it will be signed (`0.0.x` or EIP-55). */
export interface HbarRecipientInfo extends HbarAccountInfo {
  to: string;
  isEvm: boolean;
}

/** Every warning → reinforced confirmation. */
export type HbarWarning = { kind: 'highFee' } | { kind: 'unusualText' };

/** wallet-core `HbarTxSummary`: Rust's strict decoding of the CryptoTransfer. */
export interface HbarTxSummary {
  from: string;
  to: string;
  toIsEvm: boolean;
  /** Tinybars. */
  amount: string;
  /** Tinybars: maximum (only the actual fee is charged). */
  maxFee: string;
  memo: string | null;
  memoHex: string | null;
  transactionId: string;
  mirrorTransactionId: string;
  validStart: number;
  validDuration: number;
  nodes: string[];
  warnings: HbarWarning[];
  requiresExtraConfirmation: boolean;
}

export interface HbarContext {
  account: HbarAccountInfo;
  recipient: HbarAccountInfo;
  /** Transfer to an EVM address without account: the network creates it (≈ $0.05, paid by us). */
  createsAccount: boolean;
}

/** `hbar_txs` entry (mirror node, last 50, newest first). Amounts: tinybars. */
export interface HbarHistoryEntry {
  /** `0.0.payer-secs-nanos`. */
  id: string;
  /** `CRYPTOTRANSFER`, `CRYPTOCREATEACCOUNT`… */
  name: string;
  /** `SUCCESS`… */
  result: string;
  /** ms epoch. */
  time: number | null;
  /** Fee we paid (0 if another account paid). */
  fee: string;
  memo: string | null;
  /** Signed change of our balance, fees included. */
  delta: string;
  /** HBAR moved to / from the counterparty (fees excluded for outgoing transfers). */
  amount: string;
  counterparty: string | null;
  outgoing: boolean;
}

export interface HbarBuilt {
  /** Unsigned `TransactionBody` per consensus node (hex): what `hbar_sign_tx` signs. */
  bodies: string[];
  summary: HbarTxSummary;
  context: HbarContext;
}

// ---------------------------------------------------------------- Kaspa (§2.11)

export interface KaspaBackendInfo {
  /** No custom Kaspa server yet. */
  kind: 'default';
  network: UtxoNetworkKey;
  /** `api.kaspa.org` / `api-tn10.kaspa.org`. */
  label: string;
  tor: boolean;
}

/** `kas_account`: the whole account (receive + change chains, `scanned` addresses each). Sompi. */
export interface KaspaAccountInfo {
  /** Receive address shown (`…/0/0`). */
  address: string;
  balance: string;
  /** Coins spendable now (immature coinbase excluded). */
  spendable: string;
  utxoCount: number;
  scanned: number;
}

/** wallet-core `KaspaMass` (grams). */
export interface KaspaMass {
  compute: number;
  transient: number;
  storage: number;
  /** max(compute, transient ÷ 2): the minimum relay fee is 100 sompi per gram of it. */
  relay: number;
  /** max(compute, storage, transient ÷ 2): at most 100 000. */
  total: number;
}

export interface KaspaOutputView {
  address: string | null;
  script: string;
  /** Sompi. */
  amount: string;
  /** Pays one of this account's addresses. */
  isChange: boolean;
  kind: 'address' | 'unknown';
}

/** serde tag `kind`. Every warning → reinforced confirmation. */
export type KaspaWarning = { kind: 'unknownOutput'; index: number } | { kind: 'highFee' };

/** wallet-core `KaspaTxSummary`: Rust's strict decoding (amounts: sompi, decimal strings). */
export interface KaspaTxSummary {
  txId: string;
  outputs: KaspaOutputView[];
  inputs: number;
  inputTotal: string;
  /** Outputs that do not come back to us. */
  sent: string;
  fee: string;
  mass: KaspaMass;
  minimumFee: string;
  /** fee ÷ relay mass, sompi/gram. */
  feeRate: number;
  hasChange: boolean;
  warnings: KaspaWarning[];
  requiresExtraConfirmation: boolean;
}

export interface KaspaContext {
  /** Server estimate, sompi/gram. */
  feerateEstimate: number;
  /** Applied to the whole mass; 0 = network not busy (minimum relay fee only). */
  priorityFeerate: number;
  spendable: string;
}

/** `kas_txs` entry, seen from the whole account. */
export interface KaspaHistoryEntry {
  txid: string;
  /** ms epoch. */
  time: number;
  /** Received − spent, sompi (negative: sent). */
  delta: string;
  fee: string | null;
  counterparty: string | null;
  accepted: boolean;
}

// ---------------------------------------------------------------- Polkadot (§2.11)

export interface DotBackendInfo {
  network: 'mainnet' | 'testnet';
  /** "Polkadot Asset Hub" / "Westend Asset Hub". */
  chain: string;
  symbol: string;
  decimals: number;
  ss58: number;
  label: string;
  tor: boolean;
}

/** One native DOT transfer of `dot_txs` (Statescan; planck, decimal string; `time` in ms). */
export interface DotHistoryEntry {
  /** Extrinsic hash when known, else `ahp:{block}-{index}` / `relay:{block}-{index}`. */
  id: string;
  hash?: string;
  chain: 'assetHub' | 'relay';
  blockHeight: number;
  extrinsicIndex?: number;
  eventIndex?: number;
  time: number;
  from: string;
  to: string;
  amount: string;
  direction: 'in' | 'out' | 'self';
}

/** `dot_txs`: never an error. `available: false` = nothing reliable to show (testnet, indexer down). */
export interface DotHistory {
  available: boolean;
  /** One of the two chains (Asset Hub, relay) could not be read. */
  partial: boolean;
  items: DotHistoryEntry[];
}

/** `dot_account`: `System.Account` of the address. Amounts: planck, decimal strings. */
export interface DotAccountInfo {
  address: string;
  /** Exists on chain (≥ existential deposit). `false`: never funded or reaped. */
  exists: boolean;
  free: string;
  reserved: string;
  /** Part of `free` locked (staking, vesting, governance). */
  frozen: string;
  /** What can be sent, fee included: free − max(frozen − reserved, existential deposit). */
  spendable: string;
  nonce: number;
  existentialDeposit: string;
}

/** wallet-core `DotTxSummary`: Rust's strict decoding of the signing payload. */
export interface DotTxSummary {
  chain: string;
  from: string;
  to: string;
  /** Planck. */
  amount: string;
  symbol: string;
  decimals: number;
  /** `Balances.transfer_keep_alive`, or `Assets.transfer_keep_alive` for a token (`amount`, `symbol`, `decimals` are then the token's). */
  call: string;
  nonce: number;
  /** Always "0". */
  tip: string;
  eraPeriod: number;
  eraPhase: number;
  blockHash: string;
  specVersion: number;
  txVersion: number;
  /** Token transfer: the token as Kyro's table knows it (fees still in DOT). */
  asset?: DotAssetSummary | null;
}

/** wallet-core `DotAssetSummary`. */
export interface DotAssetSummary {
  /** Verified asset id (pallet Assets). */
  assetId: number;
  symbol: string;
  name: string;
  decimals: number;
}

/** `dot_asset_balances` line (known tokens only). */
export interface DotAssetBalance {
  assetId: number;
  /** Base units. */
  balance: string;
  /** Frozen or blocked by the issuer. */
  frozen: boolean;
  /** Smallest holding: a keep-alive send always leaves at least this much. */
  minBalance: string;
}

type DotAccountView = Omit<DotAccountInfo, 'existentialDeposit'>;

/** Live context Rust read for the dialog. */
export interface DotContext {
  account: DotAccountView;
  destination: DotAccountView;
  existentialDeposit: string;
  /** Fee estimate of the node (planck). */
  fee: string;
  eraBirth: number;
  /** First block where the transaction is no longer valid. */
  validUntil: number;
  finalized: number;
  /** Token transfer: both holdings (base units) and the token's minimum balance, read live. */
  asset?: { assetId: number; ours: string; destination: string; minBalance: string; frozen: boolean } | null;
}

// ---------------------------------------------------------------- Algorand (§2.11)

export interface AlgoBackendInfo {
  /** Always the default (AlgoNode / Nodely): no custom Algorand server yet. */
  kind: 'default';
  network: UtxoNetworkKey;
  /** algod host. */
  label: string;
  /** Indexer host (history). */
  indexer: string;
  tor: boolean;
}

/** `algo_account`: algod `/v2/accounts/{address}`. Amounts: µALGO (1 ALGO = 1 000 000). */
export interface AlgoAccountInfo {
  address: string;
  /** Holds ALGO. `false`: an empty account (it does not exist on chain until it receives ≥ 0.1 ALGO). */
  exists: boolean;
  balance: string;
  /** What must stay on the account: 0.1 ALGO + 0.1 per asset / application opted in (algod). */
  minBalance: string;
  /** Balance − minimum balance (0 if negative): what can be sent. */
  spendable: string;
  /** Assets opted in. */
  assets: number;
  /** Rekeyed to this address: Kyro's key no longer signs for the account (sending refused). */
  authAddr: string | null;
  round: number;
}

/** Every warning → reinforced confirmation. */
export type AlgoWarning = { kind: 'note' } | { kind: 'binaryNote' } | { kind: 'unusualText' } | { kind: 'highFee' };

/** wallet-core `AlgoTxSummary`: Rust's strict decoding of the payment (`pay`). */
export interface AlgoTxSummary {
  sender: string;
  receiver: string;
  /** µALGO. */
  amount: string;
  /** µALGO (flat). */
  fee: string;
  firstValid: number;
  lastValid: number;
  /** `mainnet-v1.0` / `testnet-v1.0`, checked against the app's network. */
  genesisId: string;
  /** Base64, checked. */
  genesisHash: string;
  noteLen: number;
  noteHex: string | null;
  /** UTF-8 note, cleaned for display. */
  noteText: string | null;
  txid: string;
  warnings: AlgoWarning[];
  requiresExtraConfirmation: boolean;
  /** Asset transfer (`axfer`) of a known asset: `amount` is then "0" (µALGO) and `receiver` the asset receiver (us for an opt-in). */
  asset?: AlgoAssetSummary | null;
}

/** wallet-core `AlgoAssetSummary`: the token as Kyro's table knows it. */
export interface AlgoAssetSummary {
  /** Verified asset id (ASA). */
  assetId: number;
  symbol: string;
  name: string;
  decimals: number;
  /** Base units ("0" for an opt-in). */
  amount: string;
  /** 0-unit transfer to ourselves: enables the asset (+0.1 ALGO of minimum balance). */
  optIn: boolean;
}

/** `algo_asset_holdings` line: algod `/v2/accounts/{a}/assets/{id}`. */
export interface AlgoHolding {
  assetId: number;
  /** Opted in: the account can receive the asset. */
  optedIn: boolean;
  /** Base units. */
  amount: string;
  /** Frozen by the issuer: can neither send nor receive. */
  frozen: boolean;
}

/** Live context Rust read for the dialog. */
export interface AlgoContext {
  account: AlgoAccountInfo;
  destination: AlgoAccountInfo;
  round: number;
  /** Asset transfer / opt-in: both holdings, read live. */
  asset?: { ours: AlgoHolding; destination: AlgoHolding } | null;
}

/** `algo_txs` entry (indexer, last 50). Non-payment types keep `type` and `from`, amount 0. */
export interface AlgoHistoryEntry {
  id: string;
  /** `pay`, `axfer`, `appl`, `keyreg`… */
  type: string;
  from: string;
  to: string | null;
  /** µALGO. */
  amount: string;
  fee: string;
  /** Payment that closed its account (`close-remainder-to`). */
  closeTo: string | null;
  closeAmount: string | null;
  round: number | null;
  /** ms epoch. */
  time: number | null;
  /** UTF-8 note, cleaned (null if none or binary). */
  note: string | null;
  /** `axfer`: asset id and base units (`to` = asset receiver). */
  assetId?: number | null;
  assetAmount?: string | null;
}

export interface AlgoTxStatus {
  confirmed: boolean;
  round: number | null;
  /** `pool-error`: dropped from the pool, never confirmed. */
  error: string | null;
}

export interface AlgoBuilt {
  /** Unsigned transaction (canonical msgpack), hex. */
  blob: string;
  summary: AlgoTxSummary;
  context: AlgoContext;
}

// ---------------------------------------------------------------- Monero (§2.11)

export interface XmrBackendInfo {
  kind: 'default' | 'node';
  network: 'mainnet' | 'stagenet';
  label: string;
  tor: boolean;
}

/** Restore flow: first Monero block scanned for a restored phrase. `kyro` (default) = Kyro's
 * first release (a Kyro-derived Monero wallet cannot be older); `date` (Unix seconds) or
 * `genesis` only if the phrase was used with Monero before (Ledger). */
export type XmrRestoreFrom = { kind: 'kyro' } | { kind: 'date'; date: number } | { kind: 'genesis' };

/** `xmr_status`: background scan and balance. Amounts: piconero (1 XMR = 10^12). */
export interface XmrStatus {
  running: boolean;
  /** First block scanned; null before the first sync. */
  restoreHeight: number | null;
  /** Next block to scan. */
  scanned: number;
  /** Node's chain height, when known. */
  tip: number | null;
  /** UNIX seconds of the latest block seen. */
  tipTime: number | null;
  /** 0 … 1. */
  progress: number;
  /** Everything not spent (locked included). */
  balance: string;
  /** Spendable now (10 confirmations, 60 for a coinbase). */
  unlocked: string;
  /** UNIX seconds of the last completed sync. */
  syncedAt: number | null;
  error: string | null;
  /** Highest subaddress index handed out. */
  subaddresses: number;
  /** Outputs ignored (duplicated key / additional timelock). */
  ignoredOutputs: number;
  node: string;
}

export interface XmrSubaddress {
  index: number;
  address: string;
  /** Piconero received on it. */
  received: string;
}

/** `xmr_txs` entry. `height` 0 = sent by this Kyro, not yet in a block. */
export interface XmrHistoryEntry {
  txid: string;
  direction: 'in' | 'out' | 'self';
  amount: string;
  fee: string | null;
  /** Destination of a transfer signed by this Kyro (the chain does not reveal it). */
  to: string | null;
  height: number;
  /** UNIX seconds. */
  time: number;
  confirmations: number;
}

/** Rust's decoding of a destination (serde tag `kind`). */
export type XmrDestination =
  | { address: string; kind: 'standard' }
  | { address: string; kind: 'subaddress' }
  | { address: string; kind: 'integrated'; paymentId: string };

export type XmrWarning = 'integratedAddress' | 'highFee' | 'feeAboveAmount' | 'ownAddress';

/** wallet-core `XmrTxSummary`: what Rust built (amounts in piconero). */
export interface XmrTxSummary {
  network: 'mainnet' | 'stagenet';
  account: number;
  destination: XmrDestination;
  amount: string;
  fee: string;
  /** Back to the account's primary address. */
  change: string;
  inputsTotal: string;
  inputCount: number;
  ringSize: number;
  feePerWeight: string;
  warnings: XmrWarning[];
  requiresExtraConfirmation: boolean;
}

// ---------------------------------------------------------------- TON (§2.11)

export interface TonBackendInfo {
  network: UtxoNetworkKey;
  /** `toncenter.com` / `testnet.toncenter.com`. */
  label: string;
  tor: boolean;
}

/** Account state as TON Center reports it. `uninit`: never deployed (may hold a balance). */
export type TonStatus = 'active' | 'uninit' | 'frozen' | 'nonexist';

/** `ton_account`. Amounts: nanotons (decimal strings). */
export interface TonAccountInfo {
  /** Non-bounceable form (`UQ…`, testnet `0Q…`). */
  address: string;
  /** `0:hex`. */
  raw: string;
  status: TonStatus;
  balance: string;
  /** Active wallets only. */
  seqno: number | null;
  /** `wallet v4 r2`… when TON Center recognizes the contract. */
  walletType: string | null;
}

/** serde tag `kind`. Every warning → reinforced confirmation. */
export type TonWarning = { kind: 'unusualText' };

/** wallet-core `TonTxSummary`: Rust's strict decoding of the external message. */
export interface TonTxSummary {
  /** Our wallet (non-bounceable). */
  wallet: string;
  /** Recipient in the form matching the bounce flag (`EQ…` bounce, `UQ…` no bounce). */
  destination: string;
  /** Same account, other form. */
  destinationOther: string;
  destinationRaw: string;
  /** Nanotons; `'0'` with `sendAll`. */
  amount: string;
  /** Mode 130: the whole balance (minus fees). */
  sendAll: boolean;
  bounce: boolean;
  /** Cleaned text comment, null = none. */
  comment: string | null;
  seqno: number;
  /** UNIX seconds. */
  validUntil: number;
  /** First transfer: carries the wallet's StateInit. */
  deploysWallet: boolean;
  walletId: number;
  warnings: TonWarning[];
  requiresExtraConfirmation: boolean;
  /** Jetton transfer (known jetton, sent through our jetton wallet computed by Rust); `comment` is then the jetton's forward comment. */
  jetton?: TonJettonSummary | null;
}

/** wallet-core `TonJettonSummary`. */
export interface TonJettonSummary {
  /** Master, bounceable `EQ…`: the jetton's verified id. */
  master: string;
  symbol: string;
  decimals: number;
  /** Jetton units. */
  amount: string;
  /** Recipient, non-bounceable `UQ…`. */
  recipient: string;
  recipientOther: string;
  recipientRaw: string;
  /** Our jetton wallet (computed by Rust), the message's destination. */
  jettonWallet: string;
  forwardTonAmount: string;
}

/** `ton_jetton_balances` line: our jetton wallet as Rust computes it. */
export interface TonJettonBalance {
  master: string;
  wallet: string;
  /** Jetton units. */
  balance: string;
}

/** `ton_jetton_txs` line (fake jetton contracts dropped by Rust). */
export interface TonJettonHistoryEntry {
  hash: string;
  time: number | null;
  direction: 'in' | 'out';
  master: string;
  counterparty: string | null;
  amount: string;
  comment: string | null;
  success: boolean;
}

/** Live context Rust read for the dialog. `fee`: TON Center's emulation, nanotons. */
export interface TonContext {
  account: TonAccountInfo;
  destination: TonAccountInfo;
  fee: string;
}

/** `ton_txs` entry (last 50 transactions of the wallet, newest first). */
export interface TonHistoryEntry {
  /** Transaction hash (hex). */
  hash: string;
  /** ms epoch. */
  time: number | null;
  direction: 'in' | 'out';
  counterparty: string | null;
  /** Nanotons. */
  amount: string;
  /** Total fees of our transaction (outgoing only). */
  fee: string | null;
  comment: string | null;
  /** Funds that came back from a failed earlier transfer. */
  bounced: boolean;
  success: boolean;
}

export interface TonBuilt {
  /** Unsigned external message, BOC base64 (zero signature). */
  boc: string;
  summary: TonTxSummary;
  context: TonContext;
}

/** `ton_tx_status`: the transaction that processed our message, by normalized hash. */
export interface TonTxStatus {
  found: boolean;
  success: boolean;
  txHash: string | null;
}

// ---------------------------------------------------------------- Cosmos Hub (§2.11)

export interface CosmosBackendInfo {
  kind: 'default';
  network: Network;
  /** Host of the LCD (REST) server. */
  label: string;
  /** `cosmoshub-4` (mainnet) or `provider` (testnet). */
  chainId: string;
  tor: boolean;
}

/** `cosmos_account`: auth account + uatom balances. Amounts: uatom (1 ATOM = 1 000 000). */
export interface CosmosAccountInfo {
  address: string;
  /** Known to the auth module (received something at least once). */
  exists: boolean;
  accountNumber: number;
  sequence: number;
  /** Public key recorded on chain (base64), once the account has sent a transaction. */
  pubKey: string | null;
  balance: string;
  /** What can be spent now (balance minus what is still vesting). */
  spendable: string;
}

/** Every warning → reinforced confirmation. */
export type CosmosWarning = { kind: 'highFee' } | { kind: 'unusualText' };

/** wallet-core `CosmosTxSummary`: Rust's strict decoding of the SignDoc (MsgSend of uatom). */
export interface CosmosTxSummary {
  chainId: string;
  accountNumber: number;
  sequence: number;
  from: string;
  to: string;
  /** uatom. */
  amount: string;
  /** uatom. */
  fee: string;
  gasLimit: number;
  /** Cleaned for display; null = no memo. */
  memo: string | null;
  /** Exact memo bytes, hex. */
  memoHex: string | null;
  /** Last block at which the transaction may be included. */
  timeoutHeight: number;
  warnings: CosmosWarning[];
  requiresExtraConfirmation: boolean;
}

/** Live context Rust read for the dialog. */
export interface CosmosContext {
  account: CosmosAccountInfo;
  /** Latest block height when it was read. */
  height: number;
}

/** `cosmos_txs` entry: MsgSend of uatom only, newest first (the public node indexes recent blocks only). */
export interface CosmosHistoryEntry {
  hash: string;
  height: number | null;
  /** ms epoch. */
  time: number | null;
  from: string;
  to: string;
  /** uatom. */
  amount: string;
  /** uatom, `"0"` when we did not pay it. */
  fee: string;
  /** Cleaned, one line. */
  memo: string;
  success: boolean;
}

export interface CosmosTxStatus {
  included: boolean;
  success: boolean;
  code: number | null;
  height: number | null;
  log: string;
}

// ---------------------------------------------------------------- Aptos (§2.11)

export interface AptosBackendInfo {
  network: UtxoNetworkKey;
  label: string;
  tor: boolean;
}

/** `aptos_account`. Amounts: octas (1 APT = 10^8). */
export interface AptosAccountInfo {
  address: string;
  /** Coin store + primary fungible store. */
  balance: string;
  sequenceNumber: string;
  authenticationKey: string;
  /** `false`: the key was rotated, Kyro cannot sign for this address any more. */
  keyMatches: boolean;
}

/** Every warning → reinforced confirmation. */
export type AptosWarning = { kind: 'selfTransfer' } | { kind: 'highFee' };

/** wallet-core `AptosTxSummary`: Rust's strict decoding of the `RawTransaction`. */
export interface AptosTxSummary {
  sender: string;
  recipient: string;
  /** Always `0x1::aptos_account::transfer`. */
  function: string;
  /** Octas. */
  amount: string;
  sequenceNumber: string;
  maxGasAmount: string;
  /** Octas per gas unit. */
  gasUnitPrice: string;
  /** maxGasAmount × gasUnitPrice, octas: what the network reserves up front. */
  maxFee: string;
  expirationTimestampSecs: number;
  chainId: number;
  warnings: AptosWarning[];
  requiresExtraConfirmation: boolean;
}

/** Live context Rust read for the dialog. */
export interface AptosContext {
  account: AptosAccountInfo;
  /** The recipient has nothing yet: the transfer creates its account. */
  recipientNew: boolean;
  /** Simulated gas units (fee ≈ gasUsed × gasUnitPrice). */
  gasUsed: string;
  ledgerTime: number;
}

/** `aptos_txs` entry (indexer, newest first). Amounts: octas. */
export interface AptosHistoryEntry {
  version: string;
  /** Known for the transactions this account sent. */
  hash: string | null;
  /** ms epoch. */
  time: number | null;
  direction: 'in' | 'out' | 'self';
  amount: string;
  fee: string;
  /** Recipient of a transfer we sent; null otherwise. */
  counterparty: string | null;
  success: boolean;
  function: string | null;
  /** This account signed it. */
  sentByUs: boolean;
}

// ---------------------------------------------------------------- Cardano (§2.7)

export interface CardanoBackendInfo {
  kind: 'default' | 'koios';
  network: UtxoNetworkKey;
  label: string;
  tor: boolean;
}

/** `ada_address`. Only index 0 is ever signed: the UI shows that address only. */
export interface CardanoAddressInfo {
  address: string;
  path: string;
  stakeAddress: string;
  /** `m/1852'/1815'/0'` public key ‖ chain code, hex. */
  accountXpub: string;
}

/** A native token in an output (wallet-core `CardanoTokenView`). */
export interface CardanoTokenView {
  policy: string;
  /** Asset name, hex (may be empty). */
  name: string;
  /** Printable UTF-8 form of the name, else null. */
  nameText: string | null;
  quantity: string;
  /** In Kyro's verified table (mainnet: DJED, USDM, iUSD; preprod: none). */
  verified: boolean;
}

export interface CardanoOutputView {
  address: string;
  kind: 'base' | 'enterprise';
  isChange: boolean;
  lovelace: string;
  tokens: CardanoTokenView[];
  /** Minimum lovelace this output must carry (min-UTxO). */
  minLovelace: string;
}

/** serde tag `kind`; every warning → reinforced confirmation. */
export type CardanoWarning = { kind: 'memo' } | { kind: 'unknownToken'; policy: string; name: string } | { kind: 'highFee' } | { kind: 'noTtl' } | { kind: 'unusualText' };

export interface CardanoTxSummary {
  /** blake2b-256 of the body, hex. */
  txId: string;
  /** `txhash#index`. */
  inputs: string[];
  outputs: CardanoOutputView[];
  fee: string;
  ttl: number | null;
  validFrom: number | null;
  /** CIP-20 message lines. */
  memo: string[] | null;
  warnings: CardanoWarning[];
  requiresExtraConfirmation: boolean;
}

export interface CardanoTokenBalance {
  policy: string;
  name: string;
  nameText: string | null;
  quantity: string;
  verified: boolean;
  /** Verified tokens only. */
  ticker?: string;
  decimals?: number;
}

/** `ada_account`. Lovelace amounts are decimal strings. */
export interface CardanoAccount {
  address: string;
  balance: string;
  tokens: CardanoTokenBalance[];
  utxoCount: number;
  /** Lovelace the tokens tie up (their outputs' min-UTxO): cannot leave without them. */
  lockedWithTokens: string;
}

export interface CardanoContext {
  account: CardanoAccount;
  params: { minFeeA: number; minFeeB: number; coinsPerByte: number; maxTxSize: number };
  tip: { slot: number; blockHeight: number; epoch: number };
  /** Lovelace leaving the wallet: outputs to other addresses + fee. */
  leaving: string;
}

export interface CardanoHistoryEntry {
  hash: string;
  time: number | null;
  blockHeight: number | null;
  fee: string;
  /** Received − spent by our address, signed decimal lovelace. */
  lovelaceDelta: string;
  tokenDeltas: { policy: string; name: string; nameText: string | null; delta: string }[];
  /** CIP-20 message. */
  memo: string | null;
}

export interface CardanoTokenSpec {
  policy: string;
  /** Asset name, hex. */
  name: string;
  /** Integer quantity (raw units), decimal string. */
  quantity: string;
}

// ---------------------------------------------------------------- Staking (§2.8)
// Rust builds, decodes, re-reads live and signs; the UI only chooses an operation and shows the
// decoded result with its live context BEFORE the password. Amounts: smallest unit, decimal strings.

// --- Solana (native Stake program; stake accounts createWithSeed(you, "kyro-stake-N", Stake))
export type SolStakeRequest =
  | { kind: 'createAndDelegate'; lamports: string; voteAccount: string }
  | { kind: 'delegate'; stakeAccount: string; voteAccount: string }
  | { kind: 'deactivate'; stakeAccount: string }
  | { kind: 'withdraw'; stakeAccount: string; lamports?: string };
export interface SolEpoch {
  epoch: number;
  slotIndex: number;
  slotsInEpoch: number;
  absoluteSlot: number;
  /** ≈, 400 ms per slot. */
  secondsLeft: number;
}
export type SolStakeState = 'initialized' | 'activating' | 'active' | 'deactivating' | 'inactive';
export interface SolStakePosition {
  address: string;
  lamports: string;
  state: SolStakeState;
  rentExemptReserve: string;
  staker: string;
  withdrawer: string;
  /** staker = withdrawer = you and no lockup in force: Kyro can manage it. */
  ours: boolean;
  lockupInForce: boolean;
  voteAccount: string | null;
  delegated: string | null;
  activationEpoch: number | null;
  deactivationEpoch: number | null;
  effective: string;
  activating: string;
  deactivating: string;
  /** Largest partial withdrawal that keeps the account. */
  withdrawable: string;
  /** The whole balance can be withdrawn (closes the account). */
  canClose: boolean;
}
export interface SolStakeOverview {
  address: string;
  balance: string;
  epoch: SolEpoch;
  minimumDelegation: string;
  rentExemptReserve: string;
  accounts: SolStakePosition[];
}
export interface SolValidator {
  voteAccount: string;
  identity: string;
  /** Declared in validator-info, NOT verified. */
  name: string | null;
  /** %. */
  commission: number;
  activatedStake: string;
  delinquent: boolean;
  lastVote: number;
  epochVoteAccount: boolean;
}
export type SolStakeWarning = { kind: 'delinquent' } | { kind: 'highCommission'; commission: number };
export interface SolStakePreview {
  kind: 'createAndDelegate' | 'delegate' | 'deactivate' | 'withdraw';
  stakeAccount: string;
  seed: string | null;
  /** Paid into the new account, or withdrawn. */
  lamports: string | null;
  delegated: string | null;
  rentExemptReserve: string;
  validator: SolValidator | null;
  /** Current state of an existing account. */
  account: SolStakePosition | null;
  balance: string;
  fee: string;
  epoch: SolEpoch;
  closesAccount: boolean;
  warnings: SolStakeWarning[];
  requiresExtraConfirmation: boolean;
}

// --- Cardano (pool delegation + vote delegation, Conway; stake key m/1852'/1815'/0'/2/0)
export type AdaDrepChoice = 'alwaysAbstain' | 'alwaysNoConfidence' | string;
export type AdaStakeRequest =
  | { kind: 'delegate'; poolId: string; drep?: AdaDrepChoice }
  | { kind: 'voteDelegate'; drep: AdaDrepChoice }
  | { kind: 'withdraw' }
  | { kind: 'deregister' };
export interface AdaStakeAccount {
  stakeAddress: string;
  registered: boolean;
  delegatedPool: string | null;
  /** 'alwaysAbstain' | 'alwaysNoConfidence' | 'drep1…' */
  delegatedDrep: string | null;
  rewardsAvailable: string;
  deposit: string;
  totalBalance: string;
}
export interface AdaEpoch {
  epoch: number;
  slotInEpoch: number;
  epochLength: number;
  secondsLeft: number;
  slot: number;
}
export interface AdaPool {
  poolId: string;
  poolHash: string;
  /** Declared (ticker, name, homepage). */
  ticker: string | null;
  name: string | null;
  homepage: string | null;
  /** 0..1 */
  margin: number;
  fixedCost: string;
  pledge: string;
  activeStake: string | null;
  liveStake: string | null;
  /** %. */
  liveSaturation: number | null;
  liveDelegators: number | null;
  status: 'registered' | 'retiring' | 'retired' | string;
  retiringEpoch: number | null;
}
export interface AdaStakeOverview {
  address: string;
  stake: AdaStakeAccount;
  pool: AdaPool | null;
  keyDeposit: string;
  epoch: AdaEpoch;
  /** Rewards > 0 and the vote is delegated. */
  canWithdraw: boolean;
}
export type CardanoDrepView = { kind: 'key' | 'script'; id: string; hash: string } | { kind: 'alwaysAbstain' } | { kind: 'alwaysNoConfidence' };
export type CardanoCertView =
  | { type: 'stakeRegistration'; deposit: string }
  | { type: 'stakeDeregistration'; refund: string }
  | { type: 'stakeDelegation'; poolId: string; poolHash: string }
  | { type: 'voteDelegation'; drep: CardanoDrepView };
export interface CardanoStakeSummary {
  tx: CardanoTxSummary;
  stakeAddress: string;
  certificates: CardanoCertView[];
  withdrawals: { rewardAddress: string; lovelace: string }[];
  deposit: string;
  refund: string;
  withdrawn: string;
}
export type AdaStakeWarning = { kind: 'poolRetiring'; epoch: number } | { kind: 'highMargin'; margin: number } | { kind: 'poolSaturated'; saturation: number } | { kind: 'drepInactive' };
export interface AdaStakeContext {
  account: CardanoAccount;
  /** Before the transaction. */
  stake: AdaStakeAccount;
  pool: AdaPool | null;
  drep: { drep: CardanoDrepView; registered: boolean; active: boolean } | null;
  params: { minFeeA: number; minFeeB: number; coinsPerByte: number; maxTxSize: number };
  keyDeposit: string;
  epoch: AdaEpoch;
  /** Signed: fee + deposit − refund − withdrawal. */
  netCost: string;
  warnings: AdaStakeWarning[];
  requiresExtraConfirmation: boolean;
}

// --- TRON (Stake 2.0 + SR votes)
export type TronResource = 'BANDWIDTH' | 'ENERGY';
export type TronStakeRequest =
  | { kind: 'freeze'; resource: TronResource; amount: string }
  | { kind: 'unfreeze'; resource: TronResource; amount: string }
  | { kind: 'withdrawUnfrozen' }
  | { kind: 'cancelAllUnfreeze' }
  | { kind: 'vote'; votes: { address: string; count: string }[] }
  | { kind: 'claimRewards' };
export interface TronStakeAccount {
  address: string;
  balance: string;
  stakedBandwidth: string;
  stakedEnergy: string;
  unfreezing: { resource: TronResource; amount: string; expireTime: number }[];
  withdrawableNow: string;
  tronPowerLimit: number;
  /** 1 = 1 staked TRX. */
  tronPowerUsed: number;
  votes: { address: string; count: string }[];
  reward: string;
  /** ms, 0 = now. */
  nextClaimTime: number;
  unfreezeDelayDays: number;
  /** ms. */
  nextMaintenanceTime: number;
  energyLimit: number;
  energyUsed: number;
  bandwidthLimit: number;
  bandwidthUsed: number;
}
export interface TronWitness {
  address: string;
  /** The only « name » of an SR: declared, NOT verified. */
  url: string;
  voteCount: number;
  rank: number;
  /** ≤ 27. */
  isSr: boolean;
  /** ≤ 127 (paid). */
  isPaid: boolean;
  producing: boolean;
  /** % kept by the SR (read for the SRs of a vote). */
  brokerage: number | null;
}
export type TronStakeAction =
  | { type: 'freeze' | 'unfreeze'; resource: TronResource; amount: string }
  | { type: 'withdrawUnfrozen' }
  | { type: 'cancelAllUnfreeze' }
  | { type: 'vote'; votes: { address: string; count: string }[]; total: string }
  | { type: 'claimRewards' };
export interface TronStakeSummary {
  txid: string;
  owner: string;
  action: TronStakeAction;
  expiration: number;
  timestamp: number;
  refBlockBytes: string;
  refBlockHash: string;
  rawSize: number;
}
export type TronStakeWarning = { kind: 'srNotPaid'; address: string; rank: number } | { kind: 'brokerageAll'; address: string } | { kind: 'votesReduced' };
export interface TronStakeContext {
  account: TronStakeAccount;
  estimate: TronEstimate;
  witnesses: TronWitness[];
  warnings: TronStakeWarning[];
  requiresExtraConfirmation: boolean;
}

export interface TronBuilt {
  /** `raw_data` hex: what `tron_sign_tx` signs. */
  raw: string;
  txid: string;
  summary: TronTxSummary;
  estimate: TronEstimate;
}

/**
 * `btc_address_txs` returns at most this many transactions per address, for every backend
 * (most recent first; Rust follows Esplora's pagination). 50 entries = there may be more.
 */
export const BTC_TXS_CAP = 50;

/**
 * State of the embedded Tor client (`tor_status`, `tor-status` event).
 * - `off`: not started (Tor disabled in the settings);
 * - `bootstrapping`: connecting, `progress` 0..99;
 * - `ready`: requests go through Tor (`progress` = 100);
 * - `error`: bootstrap failed, `message` says why. Requests fail with `TOR_UNAVAILABLE`, never in clear.
 */
export type TorState = 'off' | 'bootstrapping' | 'ready' | 'error';

export interface TorStatus {
  state: TorState;
  /** 0..100 */
  progress: number;
  message?: string;
}

export interface EvmTxRequest {
  chainId: number;
  nonce: number;
  to: string;
  valueWei: string;
  /** `0x…` calldata, `0x` for a plain transfer. */
  data: string;
  gasLimit: number;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
}

export type EvmTxKind = 'NativeTransfer' | 'Erc20Transfer' | 'Erc20Approve' | 'ContractCall';

export interface EvmTxSummary {
  kind: EvmTxKind;
  to: string;
  tokenContract: string | null;
  amount: string;
  spender: string | null;
  unlimitedApproval: boolean;
  maxFeeWei: string;
  chainId: number;
  /** Native value attached, wei (always present, also for ERC-20 calls). */
  valueWei: string;
  /** Reasons for the reinforced (2nd) native dialog. */
  warnings: EvmWarning[];
  requiresExtraConfirmation: boolean;
}

/** wallet-core `EvmWarning` (serde tag `kind`); each one → reinforced confirmation. */
export type EvmWarning =
  /** A call that is not a decoded ERC-20 transfer: Kyro cannot tell what it does. */
  | { kind: 'contractCall' }
  /** Every approval; `unlimited` (≥ 2^128) is shown ILLIMITÉ. `amount`: raw token units. */
  | { kind: 'approval'; spender: string; amount: string; unlimited: boolean }
  /** Native value sent with calldata. */
  | { kind: 'valueToContract'; valueWei: string }
  /** Chain id outside EVM_KNOWN_CHAINS. */
  | { kind: 'unknownChain'; chainId: number }
  /** gas_limit × max_fee_per_gas above the chain's threshold (0.05 native, 50 POL, 1 AVAX). */
  | { kind: 'highFee'; maxFeeWei: string };

/** `[address, sats, isChange]`. Non-address outputs: `op_return:<hex>` / `script:<hex>`. */
export type BtcSummaryOutput = [address: string, sats: number, isChange: boolean];

/** wallet-core `BtcWarning` (serde tag `kind`); each one → reinforced confirmation. */
export type BtcWarning =
  | { kind: 'unknownScript'; output: number }
  | { kind: 'opReturn'; output: number }
  /** Input not signed by this wallet (coinjoin, payjoin… or a trap). */
  | { kind: 'foreignInput'; input: number }
  /** Fee rate above 100 sat/vB, or fee larger than all outputs together. */
  | { kind: 'highFee'; satPerVb: number }
  /** Our key beyond MAX_CHANGE_INDEX (1000): counted as a payment, not change. */
  | { kind: 'changeIndexOutOfRange'; output: number };

export interface BtcTxSummary {
  outputs: BtcSummaryOutput[];
  feeSats: number;
  warnings: BtcWarning[];
  requiresExtraConfirmation: boolean;
}

export type HttpMethod = 'GET' | 'POST';

export interface NetRequest {
  url: string;
  method: HttpMethod;
  /** Only `accept`, `content-type` and `0x-version` are forwarded by the shell. API keys are injected by Rust. */
  headers?: Record<string, string>;
  body?: string;
}

export interface NetResponse {
  status: number;
  /** Raw response text — parse JSON yourself. */
  body: string;
}

export interface AppConfig {
  network: Network;
  hasZeroxKey: boolean;
  hasCoingeckoKey: boolean;
  /** TronGrid API key: build environment or a saved `apiKeys.trongrid`. */
  hasTrongridKey: boolean;
  /** The computer's language as Rust detects it (`fr` if French, else `en`): what `language: 'auto'` uses. */
  systemLanguage: Lang;
}

/** Where the running network comes from (docs/IPC.md §2.10). */
export type NetworkSource = 'env' | 'saved' | 'vault' | 'default';

/** `network_get`: the running network and how to change it (applied by restarting the app). */
export interface NetworkInfo {
  network: Network;
  /** `env` = forced by `KYRO_NETWORK` (demo: `?network=` in the URL); `vault` = the only network with a vault. */
  source: NetworkSource;
  /** Saved choice (`network.json`), if any. */
  saved: Network | null;
  /** Build default: mainnet in release builds, testnet in debug builds. */
  default: Network;
  /** False when the environment forces the network. */
  canSwitch: boolean;
  /** A vault already exists on the other network (it is kept when switching). */
  otherVaultExists: boolean;
}

/** Token metadata shown by the interface. Rust ignores it: the native dialog names tokens only
 * from its own table (`known_tokens.rs`), an unknown token is shown in raw units. */
export interface EvmTokenHint {
  symbol: string;
  decimals: number;
}

// ---------------------------------------------------------------- Solana (crates/wallet-core/src/sol_decode.rs)

export type SolTokenProgram = 'token' | 'token2022';

/** Decoded instruction, tagged by `type`. Amounts: decimal strings in base units. */
export type SolInstruction =
  | { type: 'systemTransfer'; from: string; to: string; lamports: string }
  | { type: 'systemTransferWithSeed'; from: string; base: string; to: string; lamports: string; seed: string }
  | { type: 'systemCreateAccount'; from: string; newAccount: string; lamports: string; space: string; owner: string }
  | { type: 'systemCreateAccountWithSeed'; from: string; newAccount: string; base: string; seed: string; lamports: string; space: string; owner: string }
  | {
      type: 'tokenTransfer';
      tokenProgram: SolTokenProgram;
      checked: boolean;
      source: string;
      destination: string;
      authority: string;
      mint: string | null;
      amount: string;
      decimals: number | null;
      multisigSigners: string[];
    }
  | {
      type: 'tokenApprove';
      tokenProgram: SolTokenProgram;
      checked: boolean;
      source: string;
      delegate: string;
      owner: string;
      mint: string | null;
      amount: string;
      decimals: number | null;
      multisigSigners: string[];
    }
  | { type: 'ataCreate'; idempotent: boolean; payer: string; account: string; owner: string; mint: string; tokenProgram: string | null }
  | { type: 'computeUnitLimit'; units: number }
  | { type: 'computeUnitPrice'; microLamports: string }
  | { type: 'memo'; text: string }
  // Stake program (§2.8): every authority is always our address.
  | { type: 'stakeInitialize'; stakeAccount: string; staker: string; withdrawer: string }
  | { type: 'stakeDelegate'; stakeAccount: string; voteAccount: string; authority: string }
  | { type: 'stakeDeactivate'; stakeAccount: string; authority: string }
  | { type: 'stakeWithdraw'; stakeAccount: string; to: string; lamports: string; authority: string }
  | { type: 'unknown'; programId: string; accounts: number; accountKeys: string[]; dataLen: number };

/** Reasons for caution, tagged by `kind`. */
export type SolWarning =
  | { kind: 'feePayerNotUs'; feePayer: string }
  | { kind: 'extraWritableSigner'; address: string }
  | { kind: 'authorityNotUs'; instruction: number; authority: string }
  | { kind: 'delegation'; instruction: number }
  | { kind: 'unknownInstruction'; instruction: number; programId: string }
  | { kind: 'token2022ExtensionsUnverified'; instruction: number }
  | { kind: 'priorityFeeEstimated' }
  /** CreateAccount(WithSeed) for an owner program outside the closed list. */
  | { kind: 'unknownOwnerProgram'; instruction: number; owner: string; space: string }
  /** SPL `Transfer` (tag 3): no mint, no decimals. */
  | { kind: 'uncheckedTokenTransfer'; instruction: number }
  /** Memo / seed text that had to be sanitized, or a long memo. */
  | { kind: 'unusualText'; instruction: number };

export interface SolTxSummary {
  version: 'legacy' | 'v0' | string;
  feePayer: string;
  /** Every required signer, in signature order. */
  signers: string[];
  /** Index of our signature in the transaction's signature list, null if we don't sign. */
  ourSignerIndex: number | null;
  recentBlockhash: string;
  instructions: SolInstruction[];
  lookupTables: string[];
  baseFeeLamports: string;
  computeUnitLimit: number | null;
  computeUnitPriceMicroLamports: string | null;
  /** ceil(price × limit / 1e6) lamports; null without a price. */
  priorityFeeLamports: string | null;
  warnings: SolWarning[];
  requiresExtraConfirmation: boolean;
}

// ---------------------------------------------------------------- hardware wallets (docs/IPC.md §2.3)

export type HwDeviceKind = 'ledger' | 'trezor';
/** `cardano`, `zec`, `xmr`, `dot`, `hbar`, `kas` and `ton` answer HW_UNSUPPORTED. */
export type HwChain = 'btc' | 'evm' | 'sol' | 'ltc' | 'doge' | 'tron' | 'cardano' | 'xrp' | 'bch' | 'dash' | 'stellar' | 'zec' | 'xmr' | HwKeyChain | 'dot' | 'hbar' | 'kas' | 'ton';
/** The chains Kyro implements on hardware wallets (device support: `hw_open` → `chains`). */
export type HwImplementedChain = 'btc' | 'evm' | 'sol' | 'ltc' | 'doge' | 'bch' | 'dash' | 'xrp' | 'tron' | 'stellar';
/** Litecoin / Dogecoin / Bitcoin Cash / Dash account of a hardware wallet (`m/84'/2'/a'`, `m/44'/3'/a'`…). */
export interface HwUtxoKey {
  coin: UtxoCoinKey;
  xpub: string;
  fingerprint: string;
  path: string;
}
/** XRP / TRON / Stellar key of a hardware wallet (public key hex: 33, 65 or 32 bytes). */
export interface HwChainKey {
  address: string;
  pubkey: string;
  path: string;
}
/**
 * Single-key chains (Ledger only): one public key per account, read with `hw_key_add`, shown
 * with `hw_key_verify`, signed with `hw_sign_<chain>_tx`. NEAR uses `m/44'/397'/0'/0'/(account+1)'`
 * on the device (the Ledger app only accepts five-level paths), the others the vault's path.
 */
export type HwKeyChain = 'sui' | 'apt' | 'algo' | 'near' | 'cosmos';

/** Public key of a single-key chain stored in a watch-only account. */
export interface HwWatchKey {
  chain: HwKeyChain;
  /** Lowercase hex (32 bytes ed25519, 33 bytes compressed secp256k1 for Cosmos). */
  pubkey: string;
  address: string;
  path: string;
}

export interface HwDeviceInfo {
  /** Stable for the session while the device stays on the same port (`ledger-1`, `trezor-1`…). */
  id: string;
  kind: HwDeviceKind;
  model: string;
  transport: 'hid' | 'webusb';
}

export type HwChainState = 'ready' | 'open-app' | 'unlock' | 'unsupported';

export interface HwChainStatus {
  chain: HwChain;
  state: HwChainState;
  /** Ledger app to open. */
  app?: string;
  /** Minimum version. */
  min?: string;
  reason?: string;
}

export interface HwDeviceStatus {
  id: string;
  kind: HwDeviceKind;
  model: string;
  locked: boolean;
  /** Ledger: app open right now ("Tableau de bord" = dashboard). */
  app?: { name: string; version: string };
  /** Trezor firmware. */
  firmware?: string;
  /** Trezor: passphrase protection enabled. */
  passphrase?: boolean;
  /** Trezor Safe 7: encrypted, paired THP channel. */
  protocol?: 'thp';
  chains: HwChainStatus[];
}

export interface HwBtcKey {
  kind: BtcKind;
  xpub: string;
  /** Master fingerprint, 8 lowercase hex. */
  fingerprint: string;
  /** Account path, e.g. `m/84'/1'/0'`. */
  path: string;
}

export interface HwXpub {
  chain: HwChain;
  account: number;
  /** BIP84 + BIP86, same fingerprint. */
  btc?: HwBtcKey[];
  /** Node `m/44'/60'/0'/0`; `address` = `…/0/{account}`. */
  evm?: { xpub: string; path: string; address: string };
  sol?: { address: string; path: string };
  utxo?: HwUtxoKey;
  key?: HwChainKey;
}

/** Watch-only account backed by a hardware wallet (public keys only). */
export interface WatchOnlyAccount {
  /** `hw-` + 16 hex. */
  id: string;
  label: string;
  device: HwDeviceKind;
  model: string;
  network: Network;
  /** BIP44 account number (Bitcoin and Solana account, EVM address index). */
  account: number;
  btc?: HwBtcKey[];
  evm?: { xpub: string; path: string };
  sol?: { address: string; path: string };
  /** At most one per coin, same master fingerprint. */
  utxo?: HwUtxoKey[];
  xrp?: HwChainKey;
  /** Ledger only. */
  tron?: HwChainKey;
  stellar?: HwChainKey;
  /** Single-key chains (Sui, Aptos, Algorand, NEAR, Cosmos Hub). */
  keys?: HwWatchKey[];
}

/** Event `hw-prompt`: what to tell the user while a device call is pending. */
export interface HwPrompt {
  id: string;
  /**
   * `thp-*`: Trezor Safe 7 (THP, §2.3). `thp-confirm-pairing`: allow « Kyro Wallet » on the device;
   * `thp-pairing-code`: the device shows a 6-digit code to type (`hw_thp_pairing_code`);
   * `thp-confirm-connection`: confirm the connection on the device.
   */
  kind: 'confirm-on-device' | 'pin-on-device' | 'passphrase-on-device' | 'pin-matrix' | 'thp-confirm-pairing' | 'thp-pairing-code' | 'thp-confirm-connection';
}

/** `hw_thp_pairings` entry: a Trezor Safe 7 paired with this installation (public data). */
export interface HwThpPairing {
  /** Device static public key, hex. */
  key: string;
  /** e.g. `T3W1`. */
  model: string;
  /** UNIX seconds. */
  added: number;
}

/** Highest account number accepted by Rust (`MAX_HW_ACCOUNT`). */
export const MAX_HW_ACCOUNT = 100;

/** Every command: its arguments (`undefined` = none) and its resolved value. */
export interface Commands {
  vault_status: { args: undefined; ret: VaultStatus };
  /** The words are NOT returned: `vault_backup_show` displays them in a native dialog. */
  vault_create: { args: { password: string; words: 12 | 24 }; ret: { wordCount: number } };
  /** Native dialog with the phrase of the vault just created (resolves when it is closed), then
   * the 0-based positions of the 3 words to type back. Only while that phrase is pending. */
  vault_backup_show: { args: undefined; ret: { checks: [number, number, number] } };
  /** Checks the 3 words (positions from `vault_backup_show`). After 5 wrong tries the pending
   * phrase is dropped (`attemptsLeft: 0`): show it again from Réglages › Sécurité. */
  vault_backup_verify: { args: { answers: string[] }; ret: { ok: boolean; attemptsLeft: number } };
  /** `xmrRestore`: where Monero's first scan starts (default `kyro`: Kyro's first release). */
  vault_import: { args: { password: string; phrase: string; xmrRestore?: XmrRestoreFrom }; ret: void };
  vault_unlock: { args: { password: string }; ret: void };
  vault_lock: { args: undefined; ret: void };
  /** Password, then a native confirmation, then the words in a native dialog. Returns nothing. */
  vault_reveal_mnemonic: { args: { password: string }; ret: void };
  session_touch: { args: undefined; ret: void };
  accounts_get: { args: WithAccount | undefined; ret: Accounts };
  /** Account lists of the vault (§2.9). Add / rename / remove: vault unlocked. */
  vault_accounts_get: { args: undefined; ret: VaultAccountLists };
  vault_account_add: { args: { chain: AccountChain; account: number; name: string }; ret: VaultAccountLists };
  vault_account_rename: { args: { chain: AccountChain; account: number; name: string }; ret: VaultAccountLists };
  /** Account 0 cannot be removed. Removal only drops the bookmark: re-adding gives the same keys. */
  vault_account_remove: { args: { chain: AccountChain; account: number }; ret: VaultAccountLists };
  btc_address: { args: { kind: BtcKind; change: boolean; index: number } & WithAccount; ret: string };
  evm_decode_tx: { args: { tx: EvmTxRequest }; ret: EvmTxSummary };
  evm_sign_tx: {
    args: { tx: EvmTxRequest; password: string } & WithAccount;
    ret: { rawTx: string; hash: string };
  };
  /** Signs only the inputs of `account` (others: `foreignInput`). */
  btc_sign_psbt: { args: { psbt: string; password: string } & WithAccount; ret: { psbt: string; summary: BtcTxSummary } };
  /** Rust decodes the message (v0 lookup tables fetched by Rust). Unlocked session required. */
  sol_decode_tx: { args: { message: string } & WithAccount; ret: SolTxSummary };
  /** Native dialog (+ a 2nd one when `requiresExtraConfirmation`). Place `signature` at `summary.ourSignerIndex`. */
  sol_sign_tx: { args: { message: string; password: string } & WithAccount; ret: { signature: string; summary: SolTxSummary } };
  /** Over Tor when `settings.tor.enabled` (default); fails closed with `TOR_UNAVAILABLE`, never retried in clear. */
  net_fetch: { args: { req: NetRequest }; ret: NetResponse };
  tor_status: { args: undefined; ret: TorStatus };
  /** Tests a server WITHOUT saving it (same checks as `settings_set`). */
  server_test: { args: { target: ServerTestTarget }; ret: ServerTestResult };
  /** TLS certificate fingerprint of an Electrum server, for the trust-on-first-use prompt. */
  electrum_fetch_cert: { args: { host: string; port: number }; ret: ElectrumCertInfo };
  btc_backend_info: { args: undefined; ret: BtcBackendInfo };
  btc_address_info: { args: { address: string }; ret: EsploraAddressInfo };
  btc_address_utxos: { args: { address: string }; ret: EsploraUtxo[] };
  /** At most `BTC_TXS_CAP`, most recent first (unconfirmed first). */
  btc_address_txs: { args: { address: string }; ret: EsploraTx[] };
  btc_fee_rates: { args: undefined; ret: BtcFeeRates };
  btc_tip_height: { args: undefined; ret: number };
  /** Returns the txid; Rust checks it matches the transaction. */
  btc_broadcast: { args: { hex: string }; ret: string };
  /** Raw previous transaction (e.g. `non_witness_utxo` of a SegWit v0 input on a hardware wallet); Rust checks its txid. */
  btc_tx_hex: { args: { txid: string }; ret: string };
  // TRON (§2.5): Rust builds raw_data itself from the latest block, signs behind the password
  // and the native dialog (resources and TRX burned re-read live). Hardware wallets: HW_UNSUPPORTED.
  tron_backend_info: { args: undefined; ret: TronBackendInfo };
  /** `m/44'/195'/{account}'/0/0`, vault unlocked (`index` other than 0 refused). */
  tron_address: { args: { index?: number } & WithAccount; ret: string };
  tron_account: { args: { address: string }; ret: TronAccountInfo };
  /** Raw units, decimal string. */
  tron_trc20_balance: { args: { contract: string; address: string }; ret: string };
  /** TronGrid `/v1` only: a plain java-tron node → SERVER_UNREACHABLE « …exige l'API /v1 de TronGrid ». */
  tron_txs: { args: { address: string }; ret: TronHistoryEntry[] };
  /** `amount`: sun (TRX) or raw token units. TRC-20: energy simulated, a failing transfer is refused. */
  tron_build_tx: { args: { to: string; amount: string; token?: string } & WithAccount; ret: TronBuilt };
  /** A TRC-20 Rust does not know is shown in raw units, « jeton inconnu », with the reinforced dialog. */
  tron_sign_tx: { args: { raw: string; password: string } & WithAccount; ret: { signature: string; txid: string; summary: TronTxSummary; estimate: TronEstimate } };
  /** Signature must recover to our address; server txid = sha256(raw). */
  tron_broadcast: { args: { raw: string; signature: string } & WithAccount; ret: string };
  // XRP Ledger (§2.6): Rust builds the Payment (Sequence, Fee, LastLedgerSequence), decodes it
  // strictly, re-reads both accounts and the reserves live, signs behind the password and the
  // native dialog (destination tag framed). Hardware wallets: HW_UNSUPPORTED.
  xrp_backend_info: { args: undefined; ret: XrpBackendInfo };
  /** `m/44'/144'/{account}'/0/0` (`index` other than 0 refused). */
  xrp_address: { args: { index?: number } & WithAccount; ret: string };
  xrp_account: { args: { address: string }; ret: XrpAccountInfo };
  xrp_lines: { args: { address: string }; ret: XrpTrustLine[] };
  xrp_txs: { args: { address: string }; ret: XrpHistoryEntry[] };
  /**
   * `amount`: drops (XRP) or decimal value (issued). Refused before building: missing tag for a
   * `requireDestTag` destination; unfunded destination with < base reserve; issued to an
   * unfunded account; amount + fee > spendable; our account not activated.
   */
  xrp_build_tx: { args: { to: string; amount: string; destinationTag?: number; issued?: { currency: string; issuer: string } } & WithAccount; ret: { blob: string; summary: XrpTxSummary; context: XrpContext } };
  xrp_sign_tx: { args: { blob: string; password: string } & WithAccount; ret: { blob: string; hash: string; summary: XrpTxSummary; context: XrpContext } };
  /** `tesSUCCESS` / `terQUEUED` accepted, else INVALID_INPUT with the engine code. */
  xrp_broadcast: { args: { blob: string } & WithAccount; ret: string };
  /** `validated: true` + `result: 'tesSUCCESS'` once in a validated ledger; not found yet: `{ false, '' }`. */
  xrp_tx_status: { args: { hash: string }; ret: { validated: boolean; result: string } };
  // Stellar (§2.11): Rust builds the transaction (sequence, fee, 5-minute time bounds; Payment, or
  // CreateAccount for an unfunded destination), decodes it strictly, checks Horizon's network
  // passphrase, re-reads both accounts and the reserve live, signs behind the password and the
  // native dialog (memo framed). XLM only for now. Hardware wallets: HW_UNSUPPORTED.
  stellar_backend_info: { args: undefined; ret: StellarBackendInfo };
  /** `m/44'/148'/{account}'`, vault unlocked. */
  stellar_address: { args: WithAccount | undefined; ret: string };
  stellar_account: { args: { address: string }; ret: StellarAccountInfo };
  stellar_txs: { args: { address: string }; ret: StellarHistoryEntry[] };
  /**
   * `amount`: stroops. Refused before building: missing memo for a `memoRequired` destination;
   * unfunded destination with < 2 × base reserve; amount + fee > spendable; our account not created.
   */
  stellar_build_tx: { args: { to: string; amount: string; memo?: StellarMemoSpec } & WithAccount; ret: { envelope: string; summary: StellarTxSummary; context: StellarContext } };
  stellar_sign_tx: { args: { envelope: string; password: string } & WithAccount; ret: { envelope: string; hash: string; summary: StellarTxSummary; context: StellarContext } };
  /** Horizon waits for the ledger: the hash comes back once included and successful; else INVALID_INPUT with the result codes. */
  stellar_broadcast: { args: { envelope: string } & WithAccount; ret: string };
  stellar_tx_status: { args: { hash: string }; ret: { found: boolean; successful: boolean } };
  // NEAR (§2.11): Rust builds the transfer (nonce = access key nonce + 1, final block hash),
  // decodes it strictly (one Transfer, ed25519, TransactionV0), re-reads both accounts, the
  // access key and the fee parameters live, signs behind the password and the native dialog.
  // Hardware wallets: not supported.
  near_backend_info: { args: undefined; ret: NearBackendInfo };
  /** Implicit account of `m/44'/397'/{account}'`, vault unlocked. */
  near_address: { args: WithAccount; ret: string };
  near_account: { args: { accountId: string }; ret: NearAccountInfo };
  near_txs: { args: { accountId: string }; ret: NearHistoryEntry[] };
  /**
   * `amount`: yoctoNEAR. Refused before building: our account not on chain; a named or `0x…`
   * receiver that does not exist; amount + fee bound > spendable; a key without full access.
   */
  near_build_tx: { args: { to: string; amount: string } & WithAccount; ret: { tx: string; summary: NearTxSummary; context: NearContext } };
  /** Stale nonce or a block older than ≈ 1 h → INVALID_INPUT « reconstruis ». */
  near_sign_tx: { args: { tx: string; password: string } & WithAccount; ret: { signed: string; hash: string; summary: NearTxSummary; context: NearContext } };
  /** Signature verified (ed25519 strict), signer = our account, server hash = ours. */
  near_broadcast: { args: { signed: string } & WithAccount; ret: NearTxOutcome };
  near_tx_status: { args: { hash: string } & WithAccount; ret: NearTxOutcome };
  // Sui (§2.11): Rust picks the gas coins, reads the reference gas price and the epoch, encodes
  // the BCS (wallet-core), simulates the exact bytes, re-checks everything live before signing
  // behind the password and the native dialog. Hardware wallets: not supported.
  sui_backend_info: { args: undefined; ret: SuiBackendInfo };
  /** `m/44'/784'/{account}'/0'/0'`, vault unlocked. */
  sui_address: { args: WithAccount; ret: string };
  sui_balance: { args: { address: string }; ret: SuiBalance };
  sui_txs: { args: { address: string }; ret: SuiHistoryEntry[] };
  /**
   * `amount`: MIST; `all: true` = the whole balance (recipient gets it minus the gas). Refused:
   * invalid / short address or SuiNS name, no SUI coin, amount + gas budget > coins, failing
   * simulation.
   */
  sui_build_tx: { args: { to: string; amount?: string; all?: boolean } & WithAccount; ret: SuiBuilt };
  sui_sign_tx: { args: { bcs: string; password: string } & WithAccount; ret: SuiBuilt & { signature: string; digest: string } };
  /** Signature checked (ed25519 by our key over these bytes), executed, effects digest = ours. */
  sui_broadcast: { args: { bcs: string; signature: string } & WithAccount; ret: string };
  /** Not indexed yet: `found: false`. */
  sui_tx_status: { args: { digest: string }; ret: SuiTxStatus };
  // Hedera (§2.11): Rust builds the CryptoTransfer (one copy per consensus node, same transaction
  // ID), decodes it strictly, re-reads our account and the recipient live (mirror node), signs
  // behind the password and the native dialog (memo framed), submits through the nodes' gRPC-web
  // proxies. Hardware wallets: HW_UNSUPPORTED.
  hbar_backend_info: { args: undefined; ret: HbarBackendInfo };
  /** EVM address (EIP-55) of `m/44'/3030'/0'/0/{account}`. */
  hbar_address: { args: WithAccount; ret: string };
  /** Our account on the mirror node (by alias, else by public key); `exists: false` before the first HBAR received. */
  hbar_account: { args: WithAccount; ret: HbarOwnAccount };
  /** `to`: `0.0.x` (HIP-15 checksum optional, verified) or `0x…` (EIP-55; long-zero → `0.0.x`). */
  hbar_recipient: { args: { to: string }; ret: HbarRecipientInfo };
  hbar_txs: { args: { accountId: string }; ret: HbarHistoryEntry[] };
  /**
   * `amount`: tinybars. `memo`: ≤ 100 bytes, no control / invisible character. Refused before
   * building: our account not created yet, recipient `0.0.x` unknown / deleted / requiring its
   * signature, to ourselves, amount + max fee > balance.
   */
  hbar_build_tx: { args: { to: string; amount: string; memo?: string } & WithAccount; ret: HbarBuilt };
  hbar_sign_tx: { args: { bodies: string[]; password: string } & WithAccount; ret: { signed: string[]; summary: HbarTxSummary; context: HbarContext } };
  /** Signatures re-verified (our key), then node after node until one accepts. Returns `0.0.x@secs.nanos`. */
  hbar_broadcast: { args: { signed: string[] } & WithAccount; ret: string };
  /** `found: true` once on the mirror node (reached consensus); `result: 'SUCCESS'`… */
  hbar_tx_status: { args: { id: string }; ret: { found: boolean; result: string } };
  // Algorand (§2.11): Rust builds the payment (fee, validity window, genesis from algod), decodes
  // it strictly (close-remainder-to, rekey, group, lease refused), re-reads both accounts live,
  // signs behind the password and the native dialog. Hardware wallets: not offered.
  algo_backend_info: { args: undefined; ret: AlgoBackendInfo };
  /** `m/44'/283'/{account}'/0/0`. */
  algo_address: { args: WithAccount | undefined; ret: string };
  algo_account: { args: { address: string }; ret: AlgoAccountInfo };
  algo_txs: { args: { address: string }; ret: AlgoHistoryEntry[] };
  /**
   * `amount`: µALGO; `note`: UTF-8 text, ≤ 1024 bytes, public. Refused before building: rekeyed or
   * empty sender, amount + fee > spendable (balance − minimum balance), receiver left under its
   * minimum balance (an empty account needs ≥ 0.1 ALGO).
   */
  algo_build_tx: { args: { to: string; amount: string; note?: string } & WithAccount; ret: AlgoBuilt };
  algo_sign_tx: { args: { blob: string; password: string } & WithAccount; ret: { blob: string; txid: string; summary: AlgoTxSummary; context: AlgoContext } };
  /** Signature verified by Rust; algod's `txId` must be ours. Node refusal → INVALID_INPUT with its message. */
  algo_broadcast: { args: { blob: string } & WithAccount; ret: string };
  algo_tx_status: { args: { txid: string }; ret: AlgoTxStatus };
  /** Holdings of the known assets of the network (USDC, USD₮ on mainnet; test USDC on testnet). */
  algo_asset_holdings: { args: { address: string }; ret: AlgoHolding[] };
  /** Opt-in to a known asset: 0-unit transfer to ourselves, +0.1 ALGO of minimum balance. Signed with `algo_sign_tx`. */
  algo_build_optin_tx: { args: { assetId: number } & WithAccount; ret: AlgoBuilt };
  /** `amount`: base units of the known asset; the receiver must have opted in. Signed with `algo_sign_tx`. */
  algo_build_asset_tx: { args: { assetId: number; to: string; amount: string; note?: string } & WithAccount; ret: AlgoBuilt };
  // Monero (§2.11): Rust scans the blocks itself (no key sent to the node), builds the transfer
  // (inputs, decoys, fee, change), signs and publishes it behind the password and the native
  // dialog. Hardware wallets: HW_UNSUPPORTED.
  xmr_backend_info: { args: undefined; ret: XmrBackendInfo };
  /** `index` 0 = primary address; n ≥ 1 only once handed out by `xmr_new_subaddress`. */
  xmr_address: { args: { index?: number } & WithAccount; ret: string };
  xmr_new_subaddress: { args: WithAccount | undefined; ret: XmrSubaddress };
  /** Primary address (index 0) and every subaddress handed out. */
  xmr_subaddresses: { args: WithAccount | undefined; ret: XmrSubaddress[] };
  xmr_status: { args: WithAccount | undefined; ret: XmrStatus };
  /** Starts the background scan (no-op if one runs); poll `xmr_status`. */
  xmr_sync: { args: WithAccount | undefined; ret: XmrStatus };
  xmr_txs: { args: WithAccount | undefined; ret: XmrHistoryEntry[] };
  /** Standard, subaddress or integrated only; other network / « featured » refused (INVALID_INPUT). */
  xmr_validate_address: { args: { address: string }; ret: XmrDestination };
  /** Forgets the scan state and scans again from `height`. Refused while a scan runs. */
  xmr_set_restore_height: { args: { height: number } & WithAccount; ret: XmrStatus };
  /** `amount`: piconero; absent = everything unlocked. The transfer stays in Rust (10 min). */
  xmr_prepare_tx: { args: { to: string; amount?: string } & WithAccount; ret: { id: string; summary: XmrTxSummary } };
  /** Password, native dialog, signature, checks, publication. */
  xmr_send_tx: { args: { id: string; password: string } & WithAccount; ret: { txid: string; summary: XmrTxSummary } };
  /** 25-word Monero seed, shown in a native window only. Returns nothing. */
  xmr_seed_show: { args: { password: string } & WithAccount; ret: void };
  // TON (§2.11): Rust builds the v4R2 transfer (seqno and states from TON Center, fee emulated),
  // decodes it strictly (re-encoding identical), re-reads both accounts live, signs behind the
  // password and the native dialog (comment framed, both address forms). HW: not supported.
  ton_backend_info: { args: undefined; ret: TonBackendInfo };
  /** `m/44'/607'/{account}'`, non-bounceable `UQ…` (testnet `0Q…`). */
  ton_address: { args: WithAccount; ret: string };
  /** User-friendly addresses only (raw `0:…` refused); testnet-flagged ones refused on mainnet. */
  ton_account: { args: { address: string }; ret: TonAccountInfo };
  ton_txs: { args: { address: string }; ret: TonHistoryEntry[] };
  /**
   * `amount`: nanotons (ignored with `sendAll`, mode 130). `comment`: text, ≤ 123 bytes UTF-8.
   * Refused before building: frozen recipient, masterchain, amount + estimated fee ≥ balance,
   * our wallet empty or frozen. Bounce = the address's flag, off if the recipient is not active.
   */
  ton_build_tx: { args: { to: string; amount: string; comment?: string; sendAll?: boolean } & WithAccount; ret: TonBuilt };
  /** Known jettons only (`master` `EQ…`); `amount` in jetton units; 0.05 TON attached, the excess comes back. */
  ton_build_jetton_tx: { args: { master: string; to: string; amount: string; comment?: string } & WithAccount; ret: TonBuilt };
  ton_jetton_balances: { args: { address: string }; ret: TonJettonBalance[] };
  ton_jetton_txs: { args: { address: string }; ret: TonJettonHistoryEntry[] };
  ton_sign_tx: { args: { boc: string; password: string } & WithAccount; ret: { boc: string; hash: string; normalizedHash: string; summary: TonTxSummary; context: TonContext } };
  /** Signature verified, message hashes returned by TON Center must be ours. Returns the normalized hash. */
  ton_broadcast: { args: { boc: string } & WithAccount; ret: string };
  ton_tx_status: { args: { hash: string }; ret: TonTxStatus };
  // Cosmos Hub (§2.11): Rust builds the MsgSend (chain id, account number, sequence, timeout
  // height, gas simulated, fee-market price), decodes the SignDoc strictly, re-reads the account
  // live, signs behind the password and the native dialog. Hardware wallets: HW_UNSUPPORTED.
  cosmos_backend_info: { args: undefined; ret: CosmosBackendInfo };
  /** `m/44'/118'/{account}'/0/0`. */
  cosmos_address: { args: WithAccount; ret: string };
  cosmos_account: { args: { address: string }; ret: CosmosAccountInfo };
  cosmos_txs: { args: { address: string }; ret: CosmosHistoryEntry[] };
  /**
   * `amount`: uatom. `memo`: at most 512 characters, public. Refused before building: self-send,
   * our account unknown to the chain, amount + fee > spendable, failed simulation.
   */
  cosmos_build_tx: { args: { to: string; amount: string; memo?: string } & WithAccount; ret: { signDoc: string; summary: CosmosTxSummary; context: CosmosContext } };
  cosmos_sign_tx: { args: { signDoc: string; password: string } & WithAccount; ret: { tx: string; hash: string; summary: CosmosTxSummary; context: CosmosContext } };
  /** Code 0 (or 19, already in the mempool) accepted, else INVALID_INPUT with the code and log. */
  cosmos_broadcast: { args: { tx: string } & WithAccount; ret: string };
  cosmos_tx_status: { args: { hash: string }; ret: CosmosTxStatus };
  // Aptos (§2.11): Rust builds the transfer (0x1::aptos_account::transfer: sequence number, gas
  // price, simulated max gas, expiration), decodes it strictly, re-reads the account and
  // re-simulates live, signs behind the password and the native dialog. Hardware wallets: none.
  aptos_backend_info: { args: undefined; ret: AptosBackendInfo };
  /** `m/44'/637'/{account}'/0'/0'`. */
  aptos_address: { args: WithAccount | undefined; ret: string };
  aptos_account: { args: { address: string }; ret: AptosAccountInfo };
  aptos_txs: { args: { address: string }; ret: AptosHistoryEntry[] };
  /** `amount`: octas. Refused: rotated key, amount + max fee > balance, failing simulation. */
  aptos_build_tx: { args: { to: string; amount: string } & WithAccount; ret: { raw: string; summary: AptosTxSummary; context: AptosContext } };
  aptos_sign_tx: { args: { raw: string; password: string } & WithAccount; ret: { signed: string; hash: string; summary: AptosTxSummary; context: AptosContext } };
  /** Signature checked (single ed25519 key = sender); the node's hash must be ours. */
  aptos_broadcast: { args: { signed: string } & WithAccount; ret: string };
  aptos_tx_status: { args: { hash: string }; ret: { committed: boolean; success: boolean; vmStatus: string } };
  // Cardano (§2.7): Rust selects the UTxOs, computes fee (a·size + b) and min-UTxO, encodes the
  // CBOR, re-reads the UTxOs live before signing, shows every output in the native dialog.
  // Hardware wallets: HW_UNSUPPORTED.
  ada_backend_info: { args: undefined; ret: CardanoBackendInfo };
  /** Vault unlocked. Rust signs index 0 (of the account) only. */
  ada_address: { args: { index: number } & WithAccount; ret: CardanoAddressInfo };
  ada_account: { args: { address: string }; ret: CardanoAccount };
  /** Last 20, newest first. */
  ada_txs: { args: { address: string }; ret: CardanoHistoryEntry[] };
  /** `confirmations: null`: not seen by the indexer yet. */
  ada_tx_status: { args: { hash: string }; ret: { confirmations: number | null } };
  /**
   * `lovelace` absent with a token = exactly the output's min-UTxO. Refused before building:
   * refused address types, amount under the min-UTxO (the message gives it), not enough ADA or
   * token, change under its min-UTxO, transaction > max_tx_size.
   */
  ada_build_tx: { args: { to: string; lovelace?: string; token?: CardanoTokenSpec; memo?: string } & WithAccount; ret: { tx: string; summary: CardanoTxSummary; context: CardanoContext } };
  ada_sign_tx: { args: { tx: string; password: string } & WithAccount; ret: { tx: string; txId: string; summary: CardanoTxSummary; context: CardanoContext } };
  /** Koios `submittx`; id must be blake2b-256(body). Node refusal → INVALID_INPUT with its message. */
  ada_broadcast: { args: { tx: string } & WithAccount; ret: string };
  // Kaspa (§2.11): Rust reads the account's coins (20 receive + 20 change addresses), builds the
  // payment (coin selection, KIP-9 mass, fee), re-reads every spent coin live before signing,
  // shows it in the native dialog, signs (BIP340 Schnorr). Hardware wallets: not offered.
  kas_backend_info: { args: undefined; ret: KaspaBackendInfo };
  /** `m/44'/111111'/{account}'/0/0`, vault unlocked. */
  kas_address: { args: WithAccount | undefined; ret: string };
  kas_account: { args: WithAccount | undefined; ret: KaspaAccountInfo };
  /** Last 50 transactions of the account's active addresses, newest first. */
  kas_txs: { args: WithAccount | undefined; ret: KaspaHistoryEntry[] };
  /** `found: false` until the indexer knows the transaction. */
  kas_tx_status: { args: { txid: string }; ret: { found: boolean; accepted: boolean } };
  /**
   * `amount`: sompi, or `max: true` (everything spendable minus the fee, no change). Refused
   * before building: invalid / other-network address, amount < 0.2 KAS (KIP-9 storage mass),
   * not enough KAS, more than 84 coins needed.
   */
  kas_build_tx: { args: { to: string; amount?: string; max?: boolean } & WithAccount; ret: { tx: string; summary: KaspaTxSummary; context: KaspaContext } };
  kas_sign_tx: { args: { tx: string; password: string } & WithAccount; ret: { tx: string; txId: string; summary: KaspaTxSummary } };
  /** Signatures verified against the live coins; id returned by the server must be ours. */
  kas_broadcast: { args: { tx: string } & WithAccount; ret: string };
  // Polkadot (§2.11): DOT on Polkadot Asset Hub (WND on Westend Asset Hub). Rust builds the
  // `Balances.transfer_keep_alive` (nonce, era, runtime checked against the metadata), decodes
  // it, re-reads balances and fee live, signs behind the password and the native dialog.
  // No history (no keyless public indexer). Hardware wallets: HW_UNSUPPORTED.
  dot_backend_info: { args: undefined; ret: DotBackendInfo };
  /** sr25519 (substrate-bip39): account 0 = the phrase's root key, account a = `//a`. */
  dot_address: { args: WithAccount | undefined; ret: string };
  dot_account: { args: { address: string }; ret: DotAccountInfo };
  /**
   * `amount`: planck. Refused before building: address of another network (SS58 prefix),
   * transfer to oneself, new recipient with < existential deposit, amount + fee > spendable,
   * our account not existing, unknown runtime (metadata that does not confirm the pinned call).
   */
  dot_build_tx: { args: { to: string; amount: string } & WithAccount; ret: { payload: string; summary: DotTxSummary; context: DotContext } };
  dot_sign_tx: { args: { payload: string; password: string } & WithAccount; ret: { extrinsic: string; hash: string; blockHash: string; summary: DotTxSummary; context: DotContext } };
  /** Signature re-verified by Rust (current runtime, `blockHash`); the node's hash must be ours. */
  dot_broadcast: { args: { extrinsic: string; blockHash: string } & WithAccount; ret: string };
  /** `finalized`: the nonce is used in the finalized state (events are not decoded). */
  dot_tx_status: { args: { address: string; nonce: number; validUntil: number }; ret: { state: 'pending' | 'finalized' | 'expired'; finalized: number } };
  /** Native DOT transfers (Statescan, Asset Hub + relay chain, mainnet only). */
  dot_txs: { args: { address: string }; ret: DotHistory };
  /** Known tokens (USD₮ 1984, USDC 1337 on Polkadot Asset Hub; none on Westend). */
  dot_asset_balances: { args: { address: string }; ret: DotAssetBalance[] };
  /** `Assets.transfer_keep_alive` of a known token, `amount` in its base units; fees in DOT. Signed with `dot_sign_tx`. */
  dot_build_asset_tx: { args: { assetId: number; to: string; amount: string } & WithAccount; ret: { payload: string; summary: DotTxSummary; context: DotContext } };
  // Staking (§2.8): not available on hardware-wallet accounts (no hw_* command offers it).
  sol_stake_overview: { args: WithAccount | undefined; ret: SolStakeOverview };
  sol_stake_validators: { args: { withNames?: boolean }; ret: { validators: SolValidator[]; namesAvailable: boolean } };
  sol_stake_build: { args: { action: SolStakeRequest } & WithAccount; ret: { message: string; summary: SolTxSummary; stake: SolStakePreview } };
  sol_stake_sign: { args: { message: string; password: string } & WithAccount; ret: { signature: string; summary: SolTxSummary; stake: SolStakePreview } };
  sol_stake_broadcast: { args: { message: string; signature: string } & WithAccount; ret: string };
  ada_stake_overview: { args: WithAccount | undefined; ret: AdaStakeOverview };
  ada_stake_pools: { args: { limit?: number }; ret: AdaPool[] };
  ada_stake_pool: { args: { poolId: string }; ret: AdaPool };
  ada_stake_build: { args: { action: AdaStakeRequest } & WithAccount; ret: { tx: string; summary: CardanoStakeSummary; context: AdaStakeContext } };
  ada_stake_sign: { args: { tx: string; password: string } & WithAccount; ret: { tx: string; txId: string; summary: CardanoStakeSummary; context: AdaStakeContext } };
  ada_stake_broadcast: { args: { tx: string } & WithAccount; ret: string };
  tron_stake_overview: { args: WithAccount | undefined; ret: TronStakeAccount };
  tron_stake_witnesses: { args: undefined; ret: TronWitness[] };
  tron_stake_build: { args: { action: TronStakeRequest } & WithAccount; ret: { raw: string; txid: string; summary: TronStakeSummary; context: TronStakeContext } };
  /** Broadcast with the existing `tron_broadcast`. */
  tron_stake_sign: { args: { raw: string; password: string } & WithAccount; ret: { signature: string; txid: string; summary: TronStakeSummary; context: TronStakeContext } };
  /**
   * Bitcoin Core only, unlocked. Pre-flight checks are synchronous (reachable, auth, chain, watch
   * wallet created or loaded without private keys); only `importdescriptors` runs in the background.
   */
  /** Native file picker for Bitcoin Core's `.cookie` (checked: name, no symlink, <= 256 bytes,
   * `__cookie__:<64 hex>`). The only new cookie path `settings_set` / `server_test` accept.
   * `path: null` = cancelled. */
  btc_core_pick_cookie: { args: undefined; ret: { path: string | null } };
  btc_core_setup: { args: { rescanFrom: CoreRescanFrom }; ret: CoreStatus };
  /** `{ state: 'not-configured' }` when no Core server is set for this network. */
  btc_core_status: { args: undefined; ret: CoreStatus };
  /** Compact filters (feature `cbf`); `FEATURE_DISABLED` in a build without it. */
  btc_cbf_status: { args: undefined; ret: CbfStatus };
  /** Starts (or joins) a background sync; progress through the `cbf-status` event. */
  btc_cbf_sync: { args: undefined; ret: CbfStatus };
  /** Ledger (HID) and Trezor (WebUSB) plugged in; 10 s max. */
  hw_list: { args: undefined; ret: HwDeviceInfo[] };
  /** Opens the device and reads its state (lock, Ledger app, Trezor firmware, per chain). */
  hw_open: { args: { id: string }; ret: HwDeviceStatus };
  /** Abandons the pending operation on `id` (`true` if there was one); it ends in USER_REJECTED. */
  hw_cancel: { args: { id: string }; ret: boolean };
  /** Trezor One, after `hw-prompt: pin-matrix`: POSITIONS in the blank 3×3 grid, never the PIN. */
  hw_pin_matrix: { args: { id: string; positions: string }; ret: void };
  /**
   * Trezor Safe 7, after `hw-prompt: thp-pairing-code`: the 6 digits shown ON THE DEVICE.
   * Not 6 ASCII digits: INVALID_INPUT (hw_open keeps waiting); none pending: HW_BAD_RESPONSE;
   * wrong code: hw_open fails with HW_PAIRING_FAILED.
   */
  hw_thp_pairing_code: { args: { id: string; code: string }; ret: void };
  hw_thp_pairings: { args: undefined; ret: HwThpPairing[] };
  /** Forgets one pairing (`key`) or all (no key: Kyro's THP key too). Returns how many. The device keeps Kyro until it is reset. */
  hw_thp_forget: { args: { key?: string }; ret: number };
  /** Reads public keys, shows and stores nothing. */
  hw_get_xpub: { args: { id: string; chain: HwChain; account: number }; ret: HwXpub };
  hw_accounts_get: { args: undefined; ret: WatchOnlyAccount[] };
  /** Reads the keys of `chain` and stores them (new account, or merged into `accountId`). */
  hw_account_add: { args: { id: string; chain: HwChain; account: number; accountId?: string; label?: string }; ret: WatchOnlyAccount };
  hw_account_remove: { args: { accountId: string }; ret: void };
  /** Shows the address ON THE DEVICE; must equal Kyro's derivation, else HW_ADDRESS_MISMATCH. */
  hw_verify_address: { args: { id: string; accountId: string; chain: HwChain; path: string }; ret: { address: string; path: string } };
  /** Native dialog → device → each signature verified. Signed, NOT finalized. */
  hw_sign_btc_psbt: { args: { id: string; accountId: string; psbt: string }; ret: { psbt: string; summary: BtcTxSummary } };
  /** 2nd dialog for a contract call or blind signing. Signs for `m/44'/60'/0'/0/{account}`. */
  hw_sign_evm_tx: { args: { id: string; accountId: string; tx: EvmTxRequest }; ret: { rawTx: string; hash: string } };
  hw_sign_sol_tx: { args: { id: string; accountId: string; message: string }; ret: { signature: string; summary: SolTxSummary } };
  /** LTC / DOGE / BCH / DASH: every input of this account with `nonWitnessUtxo`. Partial signatures (BCH: finalized). */
  hw_sign_utxo_psbt: { args: { id: string; accountId: string; chain: 'ltc' | 'doge' | 'bch' | 'dash'; psbt: string }; ret: { psbt: string; summary: UtxoTxSummary } };
  /** Builds with the hardware account's address and key (no vault needed). */
  hw_xrp_build_tx: { args: { accountId: string; to: string; amount: string; destinationTag?: number; issued?: { currency: string; issuer: string } }; ret: { blob: string; summary: XrpTxSummary; context: XrpContext } };
  hw_sign_xrp_tx: { args: { id: string; accountId: string; blob: string }; ret: { blob: string; hash: string; summary: XrpTxSummary; context: XrpContext } };
  hw_xrp_broadcast: { args: { accountId: string; blob: string }; ret: string };
  hw_tron_build_tx: { args: { accountId: string; to: string; amount: string; token?: string }; ret: TronBuilt };
  hw_sign_tron_tx: { args: { id: string; accountId: string; raw: string }; ret: { signature: string; txid: string; summary: TronTxSummary; estimate: TronEstimate } };
  hw_tron_broadcast: { args: { accountId: string; raw: string; signature: string }; ret: string };
  hw_stellar_build_tx: { args: { accountId: string; to: string; amount: string; memo?: StellarMemoSpec }; ret: { envelope: string; summary: StellarTxSummary; context: StellarContext } };
  hw_sign_stellar_tx: { args: { id: string; accountId: string; envelope: string }; ret: { envelope: string; hash: string; summary: StellarTxSummary; context: StellarContext } };
  hw_stellar_broadcast: { args: { accountId: string; envelope: string }; ret: string };
  hw_key_add: { args: { id: string; chain: HwKeyChain; account: number; accountId?: string; label?: string }; ret: WatchOnlyAccount };
  hw_key_verify: { args: { id: string; accountId: string; chain: HwKeyChain }; ret: { address: string; path: string } };
  hw_sui_build_tx: { args: { accountId: string; to: string; amount?: string; all?: boolean }; ret: SuiBuilt };
  hw_sign_sui_tx: { args: { id: string; accountId: string; bcs: string }; ret: SuiBuilt & { signature: string; digest: string } };
  hw_sui_broadcast: { args: { accountId: string; bcs: string; signature: string }; ret: string };
  hw_aptos_build_tx: { args: { accountId: string; to: string; amount: string }; ret: { raw: string; summary: AptosTxSummary; context: AptosContext } };
  hw_sign_aptos_tx: { args: { id: string; accountId: string; raw: string }; ret: { signed: string; hash: string; summary: AptosTxSummary; context: AptosContext } };
  hw_aptos_broadcast: { args: { accountId: string; signed: string }; ret: string };
  hw_algo_build_tx: { args: { accountId: string; to: string; amount: string; note?: string }; ret: AlgoBuilt };
  hw_sign_algo_tx: { args: { id: string; accountId: string; blob: string }; ret: { blob: string; txid: string; summary: AlgoTxSummary; context: AlgoContext } };
  hw_algo_broadcast: { args: { accountId: string; blob: string }; ret: string };
  hw_near_build_tx: { args: { accountId: string; to: string; amount: string }; ret: { tx: string; summary: NearTxSummary; context: NearContext } };
  hw_sign_near_tx: { args: { id: string; accountId: string; tx: string }; ret: { signed: string; hash: string; summary: NearTxSummary; context: NearContext } };
  hw_near_broadcast: { args: { accountId: string; signed: string }; ret: NearTxOutcome };
  hw_near_tx_status: { args: { accountId: string; hash: string }; ret: NearTxOutcome };
  hw_cosmos_build_tx: { args: { accountId: string; to: string; amount: string; memo?: string }; ret: { signDoc: string; summary: CosmosTxSummary; context: CosmosContext } };
  hw_sign_cosmos_tx: { args: { id: string; accountId: string; signDoc: string }; ret: { tx: string; hash: string; summary: CosmosTxSummary; context: CosmosContext } };
  hw_cosmos_broadcast: { args: { accountId: string; tx: string }; ret: string };
  /** Restarts the bootstrap (after `error`). `INVALID_INPUT` when Tor is disabled. */
  tor_retry: { args: undefined; ret: TorStatus };
  settings_get: { args: undefined; ret: Settings };
  /**
   * Async: live-checks every changed custom server before saving (`SERVER_INVALID`,
   * `SERVER_WRONG_NETWORK`, `SERVER_UNREACHABLE`, `TOR_UNAVAILABLE`); nothing saved on failure.
   */
  settings_set: { args: { settings: SettingsInput }; ret: Settings };
  set_capture_protection: { args: { enabled: boolean }; ret: void };
  /** Opens https://kyrowallet.com/frais (URL fixed in Rust) in the system browser. */
  open_fees_page: { args: undefined; ret: void };
  config_get: { args: undefined; ret: AppConfig };
  /** Running version; `updatedTo` is set once after an automatic update was applied. */
  update_status: { args: undefined; ret: UpdateStatus };
  network_get: { args: undefined; ret: NetworkInfo };
  /**
   * Saves the choice; a different network locks the session and restarts the app (`true`).
   * `INVALID_INPUT`: unknown value, forced by the environment, a native signature dialog open,
   * a hardware-wallet call in progress.
   */
  network_set: { args: { network: Network }; ret: boolean };
}

/** Every command, including the generated `ltc_*` / `doge_*` / `bch_*` / `dash_*` ones and the `zec_*` ones. */
export interface AllCommands extends Commands, Prefixed<'ltc'>, Prefixed<'doge'>, Prefixed<'bch'>, Prefixed<'dash'>, ZecCommands {}

export type CommandName = keyof AllCommands;
export type ArgsOf<K extends CommandName> = AllCommands[K]['args'];
export type RetOf<K extends CommandName> = AllCommands[K]['ret'];
export type CallArgs<K extends CommandName> = ArgsOf<K> extends undefined ? [] : undefined extends ArgsOf<K> ? [args?: ArgsOf<K>] : [args: ArgsOf<K>];

export const ERROR_CODES = [
  'WRONG_PASSWORD',
  'LOCKED',
  'RATE_LIMITED',
  'USER_REJECTED',
  'HOST_NOT_ALLOWED',
  'INVALID_INPUT',
  'INTERNAL',
  /** Tor enabled but not ready (bootstrap too long, failed, stopped): the request was NOT sent. */
  'TOR_UNAVAILABLE',
  /** Configuration refused before any network (URL, scheme, credentials, .onion without Tor, fingerprint, password, cookie, RPC auth, missing watch wallet). */
  'SERVER_INVALID',
  /** The server answers but is on another chain (genesis, chain, chainId). */
  'SERVER_WRONG_NETWORK',
  /** The custom server does not answer. Kyro never falls back to the default. */
  'SERVER_UNREACHABLE',
  /** Request to the default server of a chain that has a custom one (the UI used the wrong URL). */
  'DEFAULT_SERVER_DISABLED',
  /** Feature not in this build (today: compact block filters `cbf`, off until review). */
  'FEATURE_DISABLED',
  // ---- hardware wallets (§2.3) ----
  'HW_NOT_FOUND',
  'HW_LOCKED',
  /** `data: { expected, open }` */
  'HW_WRONG_APP',
  'HW_REJECTED',
  'HW_DISCONNECTED',
  /** `data: { min: string | null }` */
  'HW_UNSUPPORTED',
  'HW_BUSY',
  'HW_TIMEOUT',
  'HW_BAD_RESPONSE',
  /** `data: { device, expected }` — do NOT use the address. */
  'HW_ADDRESS_MISMATCH',
  'HW_WRONG_DEVICE',
  /** Trezor Safe 7 not (or no longer) paired and the command is not hw_open: pair through hw_open first. */
  'HW_PAIRING_REQUIRED',
  /** THP pairing failed: wrong code (or the device did not prove it); nothing stored. */
  'HW_PAIRING_FAILED',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** Shape of a rejected command promise. `message` is user-facing French. */
/** `data` of the hardware-wallet errors that carry details. */
export interface IpcErrorData {
  HW_WRONG_APP: { expected: string; open: string };
  HW_UNSUPPORTED: { min: string | null };
  HW_ADDRESS_MISMATCH: { device: string; expected: string };
}

export interface IpcErrorPayload {
  code: ErrorCode;
  message: string;
  data?: unknown;
}

export class IpcError extends Error {
  readonly code: ErrorCode;
  /** Only for HW_WRONG_APP, HW_UNSUPPORTED, HW_ADDRESS_MISMATCH (see `IpcErrorData`). */
  readonly data: unknown;
  constructor(code: ErrorCode, message: string, data?: unknown) {
    super(message);
    this.name = 'IpcError';
    this.code = code;
    this.data = data;
  }
}

/** Typed `data` of an error, or null when it has none / another code. */
export function errorData<K extends keyof IpcErrorData>(e: unknown, code: K): IpcErrorData[K] | null {
  const err = ipcErrorIn(e);
  if (!err || err.code !== code || typeof err.data !== 'object' || err.data === null) return null;
  return err.data as IpcErrorData[K];
}

export function isIpcError(e: unknown): e is IpcError {
  return e instanceof IpcError;
}

/**
 * True when `e` means "Tor is not ready, nothing was sent". Accepts an `IpcError`, any error
 * or a plain message (adapters sometimes keep only the message, possibly prefixed): the
 * shell's message for `TOR_UNAVAILABLE` always contains « Tor indisponible » (French) or « Tor unavailable » (English).
 */
export function isTorUnavailable(e: unknown): boolean {
  const ipc = ipcErrorIn(e);
  if (ipc) return ipc.code === 'TOR_UNAVAILABLE';
  if (typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'TOR_UNAVAILABLE') return true;
  const message = typeof e === 'string' ? e : e instanceof Error ? e.message : '';
  return message.includes('Tor indisponible') || message.includes('Tor unavailable');
}

/** Normalise anything a command can reject with into an `IpcError`. */
export function toIpcError(e: unknown): IpcError {
  if (e instanceof IpcError) return e;
  if (typeof e === 'object' && e !== null && 'code' in e) {
    const code = (e as { code: unknown }).code;
    const message = (e as { message?: unknown }).message;
    if (typeof code === 'string' && (ERROR_CODES as readonly string[]).includes(code)) {
      return new IpcError(code as ErrorCode, typeof message === 'string' ? message : code, (e as { data?: unknown }).data);
    }
  }
  if (typeof e === 'string') return new IpcError('INTERNAL', e);
  if (e instanceof Error) return new IpcError('INTERNAL', e.message);
  return new IpcError('INTERNAL', l10n('Erreur inconnue', 'Unknown error'));
}

/** Pluggable backend: real Tauri `invoke` or the in-memory demo backend. */
export type InvokeFn = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

let backend: InvokeFn | null = null;
let backendPromise: Promise<InvokeFn> | null = null;
let demo = false;

/** True when running inside the Tauri webview. */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** True when the in-memory demo backend is in use (plain browser / tests). */
export function isDemoMode(): boolean {
  return demo || !isTauri();
}

/** Force a backend (tests, storybook-like harnesses). */
export function setBackend(fn: InvokeFn, opts: { demo: boolean } = { demo: true }): void {
  backend = fn;
  backendPromise = Promise.resolve(fn);
  demo = opts.demo;
}

async function resolveBackend(): Promise<InvokeFn> {
  if (backend) return backend;
  if (!backendPromise) {
    backendPromise = (async () => {
      if (isTauri()) {
        const { invoke } = await import('@tauri-apps/api/core');
        demo = false;
        return (cmd, args) => invoke(cmd, args);
      }
      const { getMockBackend } = await import('./mock');
      demo = true;
      return getMockBackend().invoke;
    })();
  }
  backend = await backendPromise;
  return backend;
}

/**
 * Typed command call.
 *
 * ```ts
 * await call('vault_unlock', { password });
 * const status = await call('vault_status');
 * ```
 * Rejects with an `IpcError`.
 */
export async function call<K extends CommandName>(cmd: K, ...args: CallArgs<K>): Promise<RetOf<K>> {
  const invoke = await resolveBackend();
  try {
    const payload = args[0] as Record<string, unknown> | undefined;
    return (await invoke(cmd, payload)) as RetOf<K>;
  } catch (e) {
    const err = toIpcError(e);
    notifyIpcError(cmd, err);
    throw err;
  }
}

/** Shell message prefixes of the server-down codes (error.rs), for errors reduced to a message. */
const SERVER_DOWN_PREFIXES = ['Serveur injoignable', 'Serveur par défaut désactivé', 'Server unreachable', 'Default server disabled'];

/**
 * True when the user's custom server is down (`SERVER_UNREACHABLE`) or the UI hit a replaced
 * default (`DEFAULT_SERVER_DISABLED`). The fix is in the settings, never a fallback.
 */
export function isCustomServerDown(e: unknown): boolean {
  const ipc = ipcErrorIn(e);
  if (ipc) return ipc.code === 'SERVER_UNREACHABLE' || ipc.code === 'DEFAULT_SERVER_DISABLED';
  const message = typeof e === 'string' ? e : e instanceof Error ? e.message : '';
  return SERVER_DOWN_PREFIXES.some((p) => message.includes(p));
}

/**
 * The `IpcError` behind `e`, following `cause` chains (viem wraps transport errors in its own
 * `UnknownRpcError` whose `cause` is our IpcError). Null when there is none.
 */
export function ipcErrorIn(e: unknown): IpcError | null {
  let cur: unknown = e;
  for (let depth = 0; depth < 6 && cur; depth++) {
    if (cur instanceof IpcError) return cur;
    cur = typeof cur === 'object' && cur !== null ? (cur as { cause?: unknown }).cause : undefined;
  }
  return null;
}

// ---------------------------------------------------------------- error observers

export type IpcErrorListener = (cmd: CommandName, error: IpcError) => void;
const errorListeners = new Set<IpcErrorListener>();

/**
 * Observe every rejected command, whatever the caller does with the error afterwards
 * (adapters may wrap or swallow it). Used to catch `TOR_UNAVAILABLE` from any `net_fetch`.
 */
export function onIpcError(cb: IpcErrorListener): () => void {
  errorListeners.add(cb);
  return () => {
    errorListeners.delete(cb);
  };
}

function notifyIpcError(cmd: CommandName, error: IpcError): void {
  errorListeners.forEach((cb) => {
    try {
      cb(cmd, error);
    } catch {
      /* an observer must never change the caller's outcome */
    }
  });
}

// ---------------------------------------------------------------- Tor

/** Current state of the embedded Tor client. */
export const torStatus = (): Promise<TorStatus> => call('tor_status');
/** Restarts the Tor bootstrap after a failure. Rejects with `INVALID_INPUT` when Tor is disabled. */
export const torRetry = (): Promise<TorStatus> => call('tor_retry');
