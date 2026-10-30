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
}

export interface Settings {
  currency: Currency;
  autoLockSecs: number;
  hideBalancesOnStart: boolean;
  captureProtection: boolean;
  clipboardGuard: boolean;
  rpc: { ethereum?: string; solana?: string; esplora?: string };
  apiKeys: { coingecko?: string; zerox?: string; oneinch?: string };
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
  net_fetch: { args: { req: NetRequest }; ret: NetResponse };
  settings_get: { args: undefined; ret: Settings };
  settings_set: { args: { settings: Settings }; ret: Settings };
  set_capture_protection: { args: { enabled: boolean }; ret: void };
  config_get: { args: undefined; ret: AppConfig };
}

export type CommandName = keyof Commands;
export type ArgsOf<K extends CommandName> = Commands[K]['args'];
export type RetOf<K extends CommandName> = Commands[K]['ret'];
export type CallArgs<K extends CommandName> = ArgsOf<K> extends undefined ? [] : [args: ArgsOf<K>];

export const ERROR_CODES = [
  'WRONG_PASSWORD',
  'LOCKED',
  'RATE_LIMITED',
  'USER_REJECTED',
  'HOST_NOT_ALLOWED',
  'INVALID_INPUT',
  'INTERNAL',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** Shape of a rejected command promise. `message` is user-facing French. */
export interface IpcErrorPayload {
  code: ErrorCode;
  message: string;
}

export class IpcError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'IpcError';
    this.code = code;
  }
}

export function isIpcError(e: unknown): e is IpcError {
  return e instanceof IpcError;
}

/** Normalise anything a command can reject with into an `IpcError`. */
export function toIpcError(e: unknown): IpcError {
  if (e instanceof IpcError) return e;
  if (typeof e === 'object' && e !== null && 'code' in e) {
    const code = (e as { code: unknown }).code;
    const message = (e as { message?: unknown }).message;
    if (typeof code === 'string' && (ERROR_CODES as readonly string[]).includes(code)) {
      return new IpcError(code as ErrorCode, typeof message === 'string' ? message : code);
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
    throw toIpcError(e);
  }
}
