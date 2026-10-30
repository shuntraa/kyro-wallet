// SPDX-License-Identifier: GPL-3.0-or-later
//
// Typed contract between the React UI and the Tauri shell.
// Source of truth: docs/IPC.md (§2). Any change starts there.
//
// Conventions (Tauri): command names in snake_case, argument keys in camelCase.
// Amounts travel as decimal strings in the smallest unit (sats, wei, lamports).

export type Network = 'mainnet' | 'testnet';
export type BtcKind = 'segwit' | 'taproot';
export type Currency = 'EUR' | 'USD';

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

export interface Accounts {
  network: Network;
  btc: { segwit: BtcAccountInfo; taproot: BtcAccountInfo };
  evm: { address: string };
  sol: { address: string };
  /** Litecoin BIP84 `m/84'/2'/0'` (testnet `m/84'/1'/0'`); `address` = `…/0/0` (§2.4). */
  ltc: UtxoAccountInfo;
  /** Dogecoin BIP44 P2PKH `m/44'/3'/0'` (testnet `m/44'/1'/0'`). */
  doge: UtxoAccountInfo;
  /** TRON `m/44'/195'/0'/0/0` (same path on Nile), `T…` (§2.5). */
  tron: { address: string };
}

/** One Litecoin / Dogecoin account (standard `xpub` / `tpub` encoding, also for Dogecoin). */
export interface UtxoAccountInfo {
  address: string;
  xpub: string;
  fingerprint: string;
  path: string;
}

export interface Settings {
  currency: Currency;
  autoLockSecs: number;
  hideBalancesOnStart: boolean;
  captureProtection: boolean;
  clipboardGuard: boolean;
  /** Custom server per chain (B2b). Replaces the old `rpc` (still accepted by Rust on input, never returned). */
  servers: Servers;
  apiKeys: { coingecko?: string; zerox?: string; oneinch?: string };
  /** Embedded Tor for every `net_fetch`. Default `{ enabled: true }`; turning it off needs an explicit UI confirmation. */
  tor: { enabled: boolean };
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
  /** Dogecoin. NO default public server: reads fail with SERVER_INVALID until one is set. */
  dogecoin: { mainnet?: UtxoServer; testnet?: UtxoServer };
  /** TRON (`testnet` = Nile). Default: TronGrid (api.trongrid.io / nile.trongrid.io). */
  tron: { mainnet?: TronServer; testnet?: TronServer };
}

/**
 * TRON server: TronGrid by default, or a java-tron HTTP API (FullNode). History (`tron_txs`)
 * needs TronGrid's `/v1` API in addition: a plain java-tron node has none.
 */
export type TronServer = { kind: 'default' } | { kind: 'http'; url: string };

/** Litecoin / Dogecoin server: the default (Litecoin: litecoinspace.org; Dogecoin: none) or an Esplora. */
export type UtxoServer = { kind: 'default' } | { kind: 'esplora'; url: string };
export type UtxoCoinKey = 'litecoin' | 'dogecoin';
/** Network key of `servers.litecoin` / `servers.dogecoin`. */
export type UtxoNetworkKey = 'mainnet' | 'testnet';

export type ServerTestTarget =
  | { family: 'bitcoin'; network: BtcNetworkKey; server: BtcServer }
  | { family: 'evm'; chainId: number; server: RpcServer }
  | { family: 'solana'; cluster: SolanaCluster; server: RpcServer }
  | { family: 'litecoin'; network: UtxoNetworkKey; server: UtxoServer }
  | { family: 'dogecoin'; network: UtxoNetworkKey; server: UtxoServer }
  /** `testnet` = Nile. */
  | { family: 'tron'; network: UtxoNetworkKey; server: TronServer };

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

// ---------------------------------------------------------------- Litecoin, Dogecoin (§2.4)

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
  /** Smallest unit per vbyte: litoshis/vB, koinus/byte. */
  fastestFee: number;
  halfHourFee: number;
  hourFee: number;
  economyFee: number;
  minimumFee: number;
  /** Dogecoin server without estimates: Dogecoin Core's recommended 0.01 DOGE/kB. */
  source?: 'policy';
}

export type UtxoWarning =
  | { kind: 'unknownOutput'; index: number }
  | { kind: 'opReturn'; index: number }
  | { kind: 'foreignInput'; index: number }
  | { kind: 'softDust'; index: number }
  | { kind: 'highFee' }
  | { kind: 'feeBelowMinimum'; minimum: string };

/** Rust's decoding of the PSBT it signs (`wallet_core::UtxoTxSummary`). Amounts: decimal strings. */
export interface UtxoTxSummary {
  coin: UtxoCoinKey;
  outputs: Array<{ address: string | null; script: string; amount: string; isChange: boolean; kind: 'address' | 'opReturn' | 'unknown' }>;
  inputs: number;
  ourInputs: number;
  fee: string;
  /** vbytes (Litecoin) or bytes (Dogecoin), worst-case signature. */
  size: number;
  feePerKb: number;
  /** `false`: what is not sent is fee (a remainder below the dust limit cannot be change). */
  hasChange: boolean;
  warnings: UtxoWarning[];
  requiresExtraConfirmation: boolean;
}

/** The `{ltc,doge}_*` commands, same shapes (§2.4). */
export interface UtxoCommands<P extends 'ltc' | 'doge'> {
  backend_info: { args: undefined; ret: UtxoBackendInfo };
  /** Vault unlocked. */
  address: { args: { change: boolean; index: number }; ret: string };
  address_info: { args: { address: string }; ret: EsploraAddressInfo };
  address_utxos: { args: { address: string }; ret: EsploraUtxo[] };
  /** At most `BTC_TXS_CAP`, unconfirmed first. */
  address_txs: { args: { address: string }; ret: EsploraTx[] };
  /** Raw transaction, txid recomputed by Rust (and no witness for Dogecoin). */
  tx_hex: { args: { txid: string }; ret: string };
  fee_rates: { args: undefined; ret: UtxoFeeRates };
  tip_height: { args: undefined; ret: number };
  broadcast: { args: { hex: string }; ret: string };
  /** Password → Rust summary → native dialog (+ reinforced) → signed, NOT finalized. */
  sign_psbt: { args: { psbt: string; password: string }; ret: { psbt: string; summary: UtxoTxSummary & { coin: P extends 'ltc' ? 'litecoin' : 'dogecoin' } } };
}

type Prefixed<P extends 'ltc' | 'doge'> = { [K in keyof UtxoCommands<P> as `${P}_${K & string}`]: UtxoCommands<P>[K] };

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
export type TronWarning = { kind: 'unknownCall'; selector: string } | { kind: 'callValue' } | { kind: 'memo' } | { kind: 'highFeeLimit' };

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
}

/** `[address, sats, isChange]` */
export type BtcSummaryOutput = [address: string, sats: number, isChange: boolean];

export interface BtcTxSummary {
  outputs: BtcSummaryOutput[];
  feeSats: number;
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
  hasOneinchKey: boolean;
  hasCoingeckoKey: boolean;
  /** TronGrid API key configured in the shell (not yet sent by every build). */
  hasTrongridKey?: boolean;
}

/** Token metadata passed to `evm_sign_tx` so the native dialog can show a readable amount. */
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
  | { type: 'unknown'; programId: string; accounts: number; accountKeys: string[]; dataLen: number };

/** Reasons for caution, tagged by `kind`. */
export type SolWarning =
  | { kind: 'feePayerNotUs'; feePayer: string }
  | { kind: 'extraWritableSigner'; address: string }
  | { kind: 'authorityNotUs'; instruction: number; authority: string }
  | { kind: 'delegation'; instruction: number }
  | { kind: 'unknownInstruction'; instruction: number; programId: string }
  | { kind: 'token2022ExtensionsUnverified'; instruction: number }
  | { kind: 'priorityFeeEstimated' };

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
/** Phase 4 chains (`ltc`…`xrp`) answer HW_UNSUPPORTED. */
export type HwChain = 'btc' | 'evm' | 'sol' | 'ltc' | 'doge' | 'tron' | 'cardano' | 'xrp';
/** The chains Kyro implements today. */
export type HwImplementedChain = 'btc' | 'evm' | 'sol';

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
}

/** Event `hw-prompt`: what to tell the user while a device call is pending. */
export interface HwPrompt {
  id: string;
  kind: 'confirm-on-device' | 'pin-on-device' | 'passphrase-on-device' | 'pin-matrix';
}

/** Highest account number accepted by Rust (`MAX_HW_ACCOUNT`). */
export const MAX_HW_ACCOUNT = 100;

/** Every command: its arguments (`undefined` = none) and its resolved value. */
export interface Commands {
  vault_status: { args: undefined; ret: VaultStatus };
  vault_create: { args: { password: string; words: 12 | 24 }; ret: { words: string[] } };
  vault_import: { args: { password: string; phrase: string }; ret: void };
  vault_unlock: { args: { password: string }; ret: void };
  vault_lock: { args: undefined; ret: void };
  vault_reveal_mnemonic: { args: { password: string }; ret: { words: string[] } };
  session_touch: { args: undefined; ret: void };
  accounts_get: { args: undefined; ret: Accounts };
  btc_address: { args: { kind: BtcKind; change: boolean; index: number }; ret: string };
  evm_decode_tx: { args: { tx: EvmTxRequest }; ret: EvmTxSummary };
  evm_sign_tx: {
    args: { tx: EvmTxRequest; password: string; token?: EvmTokenHint };
    ret: { rawTx: string; hash: string };
  };
  btc_sign_psbt: { args: { psbt: string; password: string }; ret: { psbt: string; summary: BtcTxSummary } };
  /** Rust decodes the message (v0 lookup tables fetched by Rust). Unlocked session required. */
  sol_decode_tx: { args: { message: string }; ret: SolTxSummary };
  /** Native dialog (+ a 2nd one when `requiresExtraConfirmation`). Place `signature` at `summary.ourSignerIndex`. */
  sol_sign_tx: { args: { message: string; password: string }; ret: { signature: string; summary: SolTxSummary } };
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
  /** `m/44'/195'/0'/0/{index}`, vault unlocked. */
  tron_address: { args: { index: number }; ret: string };
  tron_account: { args: { address: string }; ret: TronAccountInfo };
  /** Raw units, decimal string. */
  tron_trc20_balance: { args: { contract: string; address: string }; ret: string };
  /** TronGrid `/v1` only: a plain java-tron node → SERVER_UNREACHABLE « …exige l'API /v1 de TronGrid ». */
  tron_txs: { args: { address: string }; ret: TronHistoryEntry[] };
  /** `amount`: sun (TRX) or raw token units. TRC-20: energy simulated, a failing transfer is refused. */
  tron_build_tx: { args: { to: string; amount: string; token?: string }; ret: TronBuilt };
  /** `token`: UI hint for an unknown TRC-20 (shown « selon l'interface, non vérifié »). */
  tron_sign_tx: { args: { raw: string; password: string; token?: { symbol: string; decimals: number } }; ret: { signature: string; txid: string; summary: TronTxSummary; estimate: TronEstimate } };
  /** Signature must recover to our address; server txid = sha256(raw). */
  tron_broadcast: { args: { raw: string; signature: string }; ret: string };
  /**
   * Bitcoin Core only, unlocked. Pre-flight checks are synchronous (reachable, auth, chain, watch
   * wallet created or loaded without private keys); only `importdescriptors` runs in the background.
   */
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
  hw_sign_evm_tx: { args: { id: string; accountId: string; tx: EvmTxRequest; token?: EvmTokenHint }; ret: { rawTx: string; hash: string } };
  hw_sign_sol_tx: { args: { id: string; accountId: string; message: string }; ret: { signature: string; summary: SolTxSummary } };
  /** Restarts the bootstrap (after `error`). `INVALID_INPUT` when Tor is disabled. */
  tor_retry: { args: undefined; ret: TorStatus };
  settings_get: { args: undefined; ret: Settings };
  /**
   * Async: live-checks every changed custom server before saving (`SERVER_INVALID`,
   * `SERVER_WRONG_NETWORK`, `SERVER_UNREACHABLE`, `TOR_UNAVAILABLE`); nothing saved on failure.
   */
  settings_set: { args: { settings: Settings }; ret: Settings };
  set_capture_protection: { args: { enabled: boolean }; ret: void };
  config_get: { args: undefined; ret: AppConfig };
}

/** Every command, including the generated `ltc_*` / `doge_*` ones. */
export interface AllCommands extends Commands, Prefixed<'ltc'>, Prefixed<'doge'> {}

export type CommandName = keyof AllCommands;
export type ArgsOf<K extends CommandName> = AllCommands[K]['args'];
export type RetOf<K extends CommandName> = AllCommands[K]['ret'];
export type CallArgs<K extends CommandName> = ArgsOf<K> extends undefined ? [] : [args: ArgsOf<K>];

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
 * shell's French message for `TOR_UNAVAILABLE` always contains « Tor indisponible ».
 */
export function isTorUnavailable(e: unknown): boolean {
  const ipc = ipcErrorIn(e);
  if (ipc) return ipc.code === 'TOR_UNAVAILABLE';
  if (typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'TOR_UNAVAILABLE') return true;
  const message = typeof e === 'string' ? e : e instanceof Error ? e.message : '';
  return message.includes('Tor indisponible');
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
  return new IpcError('INTERNAL', 'Erreur inconnue');
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
const SERVER_DOWN_PREFIXES = ['Serveur injoignable', 'Serveur par défaut désactivé'];

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
