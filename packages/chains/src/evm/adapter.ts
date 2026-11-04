// SPDX-License-Identifier: GPL-3.0-or-later
// One EVM adapter, parametrised by the chain registry. JSON-RPC goes through a viem *custom transport* that calls `net_fetch` — viem never touches fetch.

import { accountArg } from '../types';
import {
  createPublicClient,
  custom,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  isAddress,
  parseAbiItem,
  type Hex,
  type PublicClient,
} from 'viem';
import { call, HttpError, jsonRpc, jsonRpcBatch, JsonRpcError, netFetch, type EvmReplaceRequest, type EvmTokenHint, type JsonRpcOutcome, type EvmTxRequest, type EvmTxSummary, type NetFetch, type ReplaceMode, l10n } from '@kyro/shared';
import { ERC20_TOKENS, nativeAssetId, type AssetDef, type EvmChain } from '../registry';
import { evmFeeOptionsFromHistory } from '../fees';
import { evmReplacementFees, ReplaceRefused, type EvmFees, type EvmReplacementPlan } from '../replace';
import type { Balance, BuildParams, ChainAdapter, EvmSigned, EvmUnsigned, FeeEstimates, FeeParams, HistoryItem } from '../types';
import type { HwSigner } from '../hw';
import { simulateCall, type SimBackend, type SimCall, type SimLog, type SimReport, type SimTrace } from './simulate';

export interface EvmAdapterOptions {
  chain: EvmChain;
  address: string;
  /** RPC override (Settings › RPC), else the registry's publicnode URL. */
  rpcUrl?: string;
  fetch?: NetFetch;
  /** Blocks scanned for ERC-20 Transfer logs in getHistory. */
  logRange?: bigint;
  /** Hardware-wallet account (signing through `hw_sign_evm_tx`). */
  hw?: HwSigner;
  /** Vault account (docs/IPC.md §2.9) passed to every signing command; absent = 0. */
  account?: number;
}

export interface ContractCallParams {
  to: string;
  data: Hex;
  value?: bigint;
  fee: Extract<FeeParams, { family: 'evm' }>;
  gas?: bigint;
  kind: EvmUnsigned['kind'];
  asset: AssetDef;
  amount?: bigint;
  token?: EvmTokenHint;
}

/** Calls per JSON-RPC batch for balances (publicnode answers 100 per batch; kept below). */
export const BALANCE_BATCH = 50;

const hexToBigInt = (v: unknown): bigint => {
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]+$/.test(v)) throw new Error(l10n('solde natif illisible', 'unreadable native balance'));
  return BigInt(v);
};

/** `eth_getTransactionByHash`: what a replacement needs (hex quantities). */
interface RpcTx {
  from: string;
  to: string | null;
  nonce: string;
  gas: string;
  value: string;
  input: string;
  type?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  blockNumber: string | null;
  yParity?: string;
  v?: string;
  r: string;
  s: string;
}

/** keccak256('Transfer(address,address,uint256)'). */
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/** Contracts per `eth_getLogs` (publicnode: « A maximum of 10 addresses is allowed »). */
export const LOG_ADDRESSES = 10;

interface RawLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber?: string | null;
  transactionHash?: string | null;
  logIndex?: string | null;
}
const isRawLog = (x: unknown): x is RawLog => {
  const l = x as RawLog;
  return !!l && typeof l.address === 'string' && Array.isArray(l.topics) && l.topics.length >= 3 && l.topics[0] === TRANSFER_TOPIC && typeof l.data === 'string';
};
const topicAddress = (t: string | undefined): `0x${string}` | undefined => (t && /^0x[0-9a-fA-F]{64}$/.test(t) ? getAddress('0x' + t.slice(26)) : undefined);

/** OP-stack chains of the registry (L1 data fee charged on top of gas). */
const OP_STACK_CHAINS = new Set([10, 8453]);
const GAS_PRICE_ORACLE = '0x420000000000000000000000000000000000000F';
const GAS_PRICE_ORACLE_ABI = [parseAbiItem('function getL1FeeUpperBound(uint256 unsignedTxSize) view returns (uint256)')] as const;
const L1_FEE_FALLBACK = 100_000_000_000_000n;

/** Recipients that burn the funds, refused before building: the zero address, and the token's own contract (a classic mistake: tokens sent to their contract are lost on almost every token). */
export function evmRecipientProblem(recipient: string, asset: Pick<AssetDef, 'kind' | 'contract'>): string | null {
  const r = recipient.trim().toLowerCase();
  if (/^0x0{40}$/.test(r)) return l10n('Adresse nulle (0x000…000) : les fonds seraient détruits. Envoi refusé.', 'Null address (0x000…000): the funds would be destroyed. Sending refused.');
  if (asset.kind === 'erc20' && asset.contract && asset.contract.toLowerCase() === r) return l10n('Cette adresse est le contrat du token lui-même, pas un portefeuille : les fonds seraient perdus. Envoi refusé.', 'This address is the token contract itself, not a wallet: the funds would be lost. Sending refused.');
  return null;
}

/** One frame of `debug_traceCall`'s `callTracer`. */
interface TraceFrame {
  type?: string;
  from: string;
  to?: string;
  value?: string;
  error?: string;
  revertReason?: string;
  logs?: SimLog[];
  calls?: TraceFrame[];
}

/** Logs and inner native moves of the frames that did not revert. The top frame's value is the call's own. */
function walkTrace(f: TraceFrame, top: boolean, out: SimTrace): void {
  if (f.error) return;
  out.logs.push(...(f.logs ?? []));
  if (!top && f.to && f.value && f.value !== '0x0' && f.type !== 'DELEGATECALL') out.internal.push({ from: f.from, to: f.to, value: BigInt(f.value) });
  for (const c of f.calls ?? []) walkTrace(c, false, out);
}

/** Create a viem transport that sends JSON-RPC through `net_fetch`. */
export function netTransport(url: string, fetcher: NetFetch = netFetch, onLatency?: (ms: number) => void) {
  return custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      const t0 = performance.now();
      try {
        return await jsonRpc(fetcher, url, method, (params as unknown[] | undefined) ?? []);
      } finally {
        onLatency?.(Math.round(performance.now() - t0));
      }
    },
  });
}

export class EvmAdapter implements ChainAdapter<'evm'> {
  readonly family = 'evm' as const;
  readonly chain: EvmChain;
  readonly client: PublicClient;
  readonly rpcUrl: string;
  /** Nodes tried in turn for the history: the RPC, then the registry's fallback (not with a custom RPC). */
  private readonly historyUrls: string[];
  /** Last measured RPC round trip (status bar). */
  latencyMs: number | null = null;
  private readonly address: `0x${string}`;
  private readonly fetcher: NetFetch;
  private readonly logRange: bigint;
  readonly hw: HwSigner | null;
  /** Vault account index: the address index of `m/44'/60'/0'/0/i`. */
  readonly account: number;

  constructor(opts: EvmAdapterOptions) {
    this.chain = opts.chain;
    this.address = getAddress(opts.address);
    this.fetcher = opts.fetch ?? netFetch;
    this.rpcUrl = opts.rpcUrl || opts.chain.rpcUrl;
    this.historyUrls = !opts.rpcUrl && opts.chain.fallbackRpcUrl ? [this.rpcUrl, opts.chain.fallbackRpcUrl] : [this.rpcUrl];
    this.logRange = opts.logRange ?? 5_000n;
    this.hw = opts.hw ?? null;
    this.account = opts.account ?? 0;
    this.client = createPublicClient({
      transport: netTransport(this.rpcUrl, this.fetcher, (ms) => {
        this.latencyMs = ms;
      }),
    });
  }

  getAddress(): string {
    return this.address;
  }

  isValidAddress(address: string): boolean {
    return isAddress(address.trim(), { strict: true });
  }

  tokens(): AssetDef[] {
    return (ERC20_TOKENS[this.chain.key] ?? []).map((t) => ({
      id: `erc20:${this.chain.chainId}:${t.contract.toLowerCase()}`,
      chainKey: this.chain.key,
      family: 'evm',
      kind: 'erc20',
      symbol: t.symbol,
      name: t.name,
      decimals: t.decimals,
      coingeckoId: t.coingeckoId,
      color: t.color,
      glyph: t.glyph,
      contract: t.contract,
    }));
  }

  async blockNumber(): Promise<bigint> {
    return this.client.getBlockNumber({ cacheTime: 0 });
  }

  /** Native balance + `balanceOf` of every curated token. */
  async getBalance(): Promise<Balance[]> {
    const tokens = this.tokens();
    const data = encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [this.address] });
    const calls = [
      { method: 'eth_getBalance', params: [this.address, 'latest'] as unknown[] },
      ...tokens.map((t) => ({ method: 'eth_call', params: [{ to: getAddress(t.contract ?? ''), data }, 'latest'] as unknown[] })),
    ];
    let outcomes: JsonRpcOutcome[];
    try {
      outcomes = [];
      for (let i = 0; i < calls.length; i += BALANCE_BATCH) outcomes.push(...(await jsonRpcBatch(this.fetcher, this.rpcUrl, calls.slice(i, i + BALANCE_BATCH))));
    } catch (e) {
      // Batch refused (not an array, or 4xx such as « batch too large »): single calls.
      if (!(e instanceof JsonRpcError) && !(e instanceof HttpError && e.status >= 400 && e.status < 500)) throw e;
      return this.getBalanceOneByOne(tokens);
    }
    const [native, ...rest] = outcomes;
    // Some public RPCs answer a too-large batch with one error per call (« batch size too large », free plans): read one by one, the native balance call reports any real outage.
    if (!native?.ok) return this.getBalanceOneByOne(tokens);
    const out: Balance[] = [{ assetId: nativeAssetId(this.chain), amount: hexToBigInt(native.result) }];
    tokens.forEach((t, i) => {
      const r = rest[i];
      // `0x` = no code at that address on this chain: unknown, not zero.
      if (r?.ok && typeof r.result === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(r.result)) out.push({ assetId: t.id, amount: BigInt(r.result) });
    });
    return out;
  }

  /** Fallback without batches: one `eth_call` per token, at most 8 in flight. */
  private async getBalanceOneByOne(tokens: AssetDef[]): Promise<Balance[]> {
    const native = await jsonRpc<string>(this.fetcher, this.rpcUrl, 'eth_getBalance', [this.address, 'latest']);
    const data = encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [this.address] });
    const out: (Balance | null)[] = new Array<Balance | null>(tokens.length).fill(null);
    let next = 0;
    const worker = async () => {
      while (next < tokens.length) {
        const i = next++;
        const t = tokens[i]!;
        try {
          const r = await jsonRpc<string>(this.fetcher, this.rpcUrl, 'eth_call', [{ to: getAddress(t.contract ?? ''), data }, 'latest']);
          if (typeof r === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(r)) out[i] = { assetId: t.id, amount: BigInt(r) };
        } catch {
          /* unknown */
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, tokens.length) }, worker));
    return [{ assetId: nativeAssetId(this.chain), amount: hexToBigInt(native) }, ...out.filter((b): b is Balance => b !== null)];
  }

  async estimateFees(): Promise<FeeEstimates> {
    try {
      const h = await this.client.getFeeHistory({ blockCount: 10, rewardPercentiles: [10, 50, 90], blockTag: 'latest' });
      const next = h.baseFeePerGas[h.baseFeePerGas.length - 1] ?? h.baseFeePerGas[0] ?? 0n;
      return evmFeeOptionsFromHistory(next, h.reward ?? [], this.chain.blockTimeSecs);
    } catch {
      // Chains/RPCs without eth_feeHistory: fall back on eth_gasPrice.
      const gp = await this.client.getGasPrice();
      const tip = gp / 10n;
      return evmFeeOptionsFromHistory(gp - tip, [[tip, tip, tip]], this.chain.blockTimeSecs);
    }
  }

  /** OP-stack chains (Optimism, Base): upper bound of the L1 data fee of a simple transfer, from the GasPriceOracle predeploy (`getL1FeeUpperBound`, Fjord), doubled; 0,0001 ETH if the RPC cannot answer. */
  async l1DataFeeMargin(): Promise<bigint> {
    if (!OP_STACK_CHAINS.has(this.chain.chainId)) return 0n;
    try {
      const bound = await this.client.readContract({ address: GAS_PRICE_ORACLE, abi: GAS_PRICE_ORACLE_ABI, functionName: 'getL1FeeUpperBound', args: [200n] });
      return bound > 0n ? bound * 2n : L1_FEE_FALLBACK;
    } catch {
      return L1_FEE_FALLBACK;
    }
  }

  private async nonce(): Promise<number> {
    return this.client.getTransactionCount({ address: this.address, blockTag: 'pending' });
  }

  private async gas(to: `0x${string}`, data: Hex, value: bigint): Promise<bigint> {
    const est = await this.client.estimateGas({ account: this.address, to, data, value });
    return est === 21_000n ? est : (est * 12n) / 10n; // 20 % headroom for contract calls
  }

  private request(to: string, value: bigint, data: Hex, gasLimit: bigint, fee: Extract<FeeParams, { family: 'evm' }>, nonce: number): EvmTxRequest {
    return {
      chainId: this.chain.chainId,
      nonce,
      to: getAddress(to),
      valueWei: value.toString(),
      data,
      gasLimit: Number(gasLimit),
      maxFeePerGas: fee.maxFeePerGas.toString(),
      maxPriorityFeePerGas: fee.maxPriorityFeePerGas.toString(),
    };
  }

  async buildTx(params: BuildParams): Promise<EvmUnsigned> {
    if (params.fee.family !== 'evm') throw new Error(l10n('Frais EVM attendus', 'EVM fees expected'));
    const fee = params.fee;
    const recipient = params.to.trim();
    if (!this.isValidAddress(recipient)) throw new Error(l10n('Adresse invalide (format ou somme de contrôle EIP-55)', 'Invalid address (format or EIP-55 checksum)'));
    const problem = evmRecipientProblem(recipient, params.asset);
    if (problem) throw new Error(problem);
    const nonce = await this.nonce();
    if (params.asset.kind === 'native') {
      const gasLimit = await this.gas(getAddress(recipient), '0x', 0n);
      // OP-stack L2s also charge an L1 data fee, outside gas × maxFee: MAX keeps room for it.
      const l1 = await this.l1DataFeeMargin();
      let value = params.amount;
      if (params.max) {
        const bal = await this.client.getBalance({ address: this.address });
        value = bal - gasLimit * fee.maxFeePerGas - l1;
        if (value <= 0n) throw new Error(l10n('Solde insuffisant pour couvrir les frais', 'Insufficient balance to cover the fees'));
      }
      return {
        family: 'evm',
        tx: this.request(recipient, value, '0x', gasLimit, fee, nonce),
        asset: params.asset,
        amount: value,
        recipient: getAddress(recipient),
        maxFee: gasLimit * fee.maxFeePerGas + l1,
        size: { family: 'evm', gasLimit },
        kind: 'transfer',
      };
    }
    if (params.asset.kind !== 'erc20' || !params.asset.contract) throw new Error(l10n('Actif non pris en charge sur ce réseau', 'Asset not supported on this network'));
    const token = getAddress(params.asset.contract);
    let amount = params.amount;
    if (params.max) amount = await this.client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [this.address] });
    if (amount <= 0n) throw new Error(l10n('Montant invalide', 'Invalid amount'));
    const data = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [getAddress(recipient), amount] });
    const gasLimit = await this.gas(token, data, 0n);
    return {
      family: 'evm',
      tx: this.request(token, 0n, data, gasLimit, fee, nonce),
      asset: params.asset,
      amount,
      recipient: getAddress(recipient),
      maxFee: gasLimit * fee.maxFeePerGas,
      size: { family: 'evm', gasLimit },
      token: { symbol: params.asset.symbol, decimals: params.asset.decimals },
      kind: 'transfer',
    };
  }

  /** Arbitrary call (swap, approve, revoke). */
  async buildCall(p: ContractCallParams): Promise<EvmUnsigned> {
    const to = getAddress(p.to);
    const value = p.value ?? 0n;
    const gasLimit = p.gas ?? (await this.gas(to, p.data, value));
    const out: EvmUnsigned = {
      family: 'evm',
      tx: this.request(to, value, p.data, gasLimit, p.fee, await this.nonce()),
      asset: p.asset,
      amount: p.amount ?? value,
      recipient: to,
      maxFee: gasLimit * p.fee.maxFeePerGas,
      size: { family: 'evm', gasLimit },
      kind: p.kind,
    };
    if (p.token) out.token = p.token;
    return out;
  }

  /**
   * Builds the same-nonce replacement of a pending transaction: same payment with higher fees
   * (speed-up), or a 0-value send to ourselves (cancel). `live` is the wanted level; the node's
   * +10% minimum applies if it is higher. Refused once it is mined or its nonce is used.
   */
  async planReplacement(hash: string, mode: ReplaceMode, live: EvmFees, asset: AssetDef): Promise<EvmReplacementPlan> {
    const t = await jsonRpc<RpcTx | null>(this.fetcher, this.rpcUrl, 'eth_getTransactionByHash', [hash]);
    if (!t) throw new ReplaceRefused('unknown');
    if (t.blockNumber) throw new ReplaceRefused('confirmed');
    if (getAddress(t.from) !== this.address) throw new ReplaceRefused('notOurs');
    if (t.type !== '0x2' || !t.to || !t.maxFeePerGas || !t.maxPriorityFeePerGas) throw new ReplaceRefused('unsupported');
    const nonce = Number(BigInt(t.nonce));
    const mined = await this.client.getTransactionCount({ address: this.address, blockTag: 'latest' });
    if (mined > nonce) throw new ReplaceRefused('confirmed');

    const old: EvmFees = { maxFeePerGas: BigInt(t.maxFeePerGas), maxPriorityFeePerGas: BigInt(t.maxPriorityFeePerGas) };
    const fee = { family: 'evm' as const, ...evmReplacementFees(old, live) };
    const oldGas = BigInt(t.gas);
    const original = this.request(t.to, BigInt(t.value), t.input as Hex, oldGas, { family: 'evm', ...old }, nonce);
    const parity = t.yParity ?? t.v;
    if (parity === undefined) throw new ReplaceRefused('unsupported');
    const replaces: EvmReplaceRequest = { hash, mode, tx: original, yParity: Number(BigInt(parity)), r: t.r, s: t.s };

    const cancel = mode === 'cancel';
    const gasLimit = cancel ? await this.gas(this.address, '0x', 0n) : oldGas;
    const tx = cancel ? this.request(this.address, 0n, '0x', gasLimit, fee, nonce) : this.request(t.to, BigInt(t.value), t.input as Hex, gasLimit, fee, nonce);
    const l1 = await this.l1DataFeeMargin();
    const newFee = gasLimit * fee.maxFeePerGas + l1;
    const amount = BigInt(tx.valueWei);
    return {
      family: 'evm',
      mode,
      replaces,
      recipient: tx.to,
      amount,
      oldFee: oldGas * old.maxFeePerGas + l1,
      newFee,
      unsigned: { family: 'evm', tx, asset, amount, recipient: tx.to, maxFee: newFee, size: { family: 'evm', gasLimit }, kind: t.input === '0x' ? 'transfer' : 'contract' },
    };
  }

  /** Rust-side decoding for the "En clair" preview (before the password). */
  decode(unsigned: EvmUnsigned): Promise<EvmTxSummary> {
    return call('evm_decode_tx', { tx: unsigned.tx });
  }

  async signTx(unsigned: EvmUnsigned, password: string, replaces?: EvmReplaceRequest): Promise<EvmSigned> {
    // No token hint: Rust names tokens from its own table only (unknown = raw units).
    const res = await call('evm_sign_tx', { tx: unsigned.tx, password, ...accountArg(this.account), ...(replaces ? { replaces } : {}) });
    return { family: 'evm', rawTx: res.rawTx, hash: res.hash };
  }

  /** Signs on the hardware wallet `deviceId` (native dialog, 2nd one if blind signing, device). */
  async signTxHw(unsigned: EvmUnsigned, deviceId: string, replaces?: EvmReplaceRequest): Promise<EvmSigned> {
    if (!this.hw) throw new Error(l10n('Ce compte n’est pas un hardware wallet', 'This account is not a hardware wallet'));
    const res = await call('hw_sign_evm_tx', { id: deviceId, accountId: this.hw.accountId, tx: unsigned.tx, ...(replaces ? { replaces } : {}) });
    return { family: 'evm', rawTx: res.rawTx, hash: res.hash };
  }

  async broadcast(signed: EvmSigned): Promise<string> {
    const hash = await jsonRpc<string>(this.fetcher, this.rpcUrl, 'eth_sendRawTransaction', [signed.rawTx]);
    return hash || signed.hash;
  }

  /** Poll for a receipt. Resolves `true` on success, `false` on revert. */
  async waitForReceipt(hash: string, timeoutMs = 180_000, intervalMs = 3_000): Promise<boolean> {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const r = await jsonRpc<{ status: string } | null>(this.fetcher, this.rpcUrl, 'eth_getTransactionReceipt', [hash]);
      if (r) return r.status === '0x1';
      await new Promise((res) => setTimeout(res, intervalMs));
    }
    throw new Error(l10n('Délai dépassé en attendant la confirmation', 'Timed out waiting for confirmation'));
  }

  async allowance(token: string, spender: string): Promise<bigint> {
    return this.client.readContract({ address: getAddress(token), abi: erc20Abi, functionName: 'allowance', args: [this.address, getAddress(spender)] });
  }

  /** eth_call dry-run. */
  async simulate(tx: { to: string; data: Hex; value?: bigint }): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      await this.client.call({ account: this.address, to: getAddress(tx.to), data: tx.data, value: tx.value ?? 0n });
      return { ok: true };
    } catch (e) {
      const msg = e instanceof Error ? (e as { shortMessage?: string }).shortMessage ?? e.message : String(e);
      return { ok: false, reason: msg.split('\n')[0] ?? msg };
    }
  }

  /**
   * What this call would do, read through the chain's own RPC before anything is signed. A warning
   * tool: `known` lists the contracts Kyro pinned for this flow (its tokens are always known).
   */
  simulateBeforeSigning(tx: { to: string; data: Hex; value?: bigint }, known: readonly string[] = []): Promise<SimReport> {
    const tokens = ERC20_TOKENS[this.chain.key] ?? [];
    const knownTokens = new Map(tokens.map((t) => [t.contract.toLowerCase(), { symbol: t.symbol, decimals: t.decimals }]));
    return simulateCall(
      this.simBackend(),
      { from: this.address, to: getAddress(tx.to), data: tx.data, value: tx.value ?? 0n },
      {
        knownContracts: new Set([...knownTokens.keys(), ...known.map((a) => a.toLowerCase())]),
        knownTokens,
        native: { symbol: this.chain.nativeSymbol, decimals: this.chain.nativeDecimals },
        blockTimeSecs: this.chain.blockTimeSecs,
      },
    );
  }

  private simBackend(): SimBackend {
    const rpc = <T>(method: string, params: unknown[]) => jsonRpc<T>(this.fetcher, this.rpcUrl, method, params);
    const callObject = (c: SimCall) => ({ from: c.from, to: c.to, data: c.data, value: `0x${c.value.toString(16)}` });
    return {
      simulateV1: async (c) => {
        type Call = { status: string; logs?: SimLog[]; error?: { message?: string } };
        const blocks = await rpc<Array<{ calls: Call[] }> | null>('eth_simulateV1', [{ blockStateCalls: [{ calls: [callObject(c)] }], traceTransfers: true, validation: false }, 'latest']);
        const r = blocks?.[0]?.calls[0];
        if (!r) return null;
        if (r.status !== '0x1') throw new JsonRpcError(3, r.error?.message ?? 'execution reverted');
        return { logs: r.logs ?? [], internal: [] };
      },
      traceCall: async (c) => {
        const top = await rpc<TraceFrame | null>('debug_traceCall', [callObject(c), 'latest', { tracer: 'callTracer', tracerConfig: { withLog: true } }]);
        if (!top) return null;
        if (top.error) throw new JsonRpcError(3, top.revertReason ?? top.error);
        const out: SimTrace = { logs: [], internal: [] };
        walkTrace(top, true, out);
        return out;
      },
      ethCall: async (c) => {
        await this.client.call({ account: c.from as `0x${string}`, to: c.to as `0x${string}`, data: c.data, value: c.value });
      },
      estimateGas: async (c) => hexToBigInt(await rpc<string>('eth_estimateGas', [callObject(c)])),
      code: async (address, blocksAgo) => {
        const at = blocksAgo === undefined ? 'latest' : `0x${((await this.blockNumber()) - blocksAgo > 0n ? (await this.blockNumber()) - blocksAgo : 0n).toString(16)}`;
        return rpc<string>('eth_getCode', [address, at]);
      },
      tokenInfo: async (address) => {
        const contract = { address: getAddress(address), abi: erc20Abi } as const;
        const [symbol, decimals] = await Promise.all([this.client.readContract({ ...contract, functionName: 'symbol' }), this.client.readContract({ ...contract, functionName: 'decimals' })]);
        // A token writes its own name: printable and short, or nothing.
        return /^[\x21-\x7e]{1,16}$/.test(symbol) && decimals <= 36 ? { symbol, decimals } : null;
      },
    };
  }

  /** Dry-run that also measures what we RECEIVE: `eth_simulateV1` with `traceTransfers` (native transfers then appear as Transfer logs from 0xEeee…), summing the Transfer logs of `token` (`native` for the chain's coin) to our address. */
  async simulateReceived(tx: { to: string; data: Hex; value?: bigint }, token: string | 'native'): Promise<{ ok: true; received: bigint | null } | { ok: false; reason: string }> {
    type SimLog = { address: string; topics: string[]; data: string };
    type SimCall = { status: string; logs?: SimLog[]; error?: { message?: string } };
    let blocks: Array<{ calls: SimCall[] }>;
    try {
      blocks = await jsonRpc<Array<{ calls: SimCall[] }>>(this.fetcher, this.rpcUrl, 'eth_simulateV1', [
        { blockStateCalls: [{ calls: [{ from: this.address, to: getAddress(tx.to), data: tx.data, value: `0x${(tx.value ?? 0n).toString(16)}` }] }], traceTransfers: true, validation: false },
        'latest',
      ]);
    } catch {
      // Method missing or refused (a revert is reported inside the result, not as an error).
      const s = await this.simulate(tx);
      return s.ok ? { ok: true, received: null } : s;
    }
    const c = blocks[0]?.calls[0];
    if (!c) return { ok: false, reason: l10n('Réponse de simulation vide', 'Empty simulation response') };
    if (c.status !== '0x1') return { ok: false, reason: c.error?.message ?? l10n('la transaction échoue', 'the transaction fails') };
    const want = token === 'native' ? '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' : token.toLowerCase();
    const me = this.address.slice(2).toLowerCase().padStart(64, '0');
    const topic0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
    let received = 0n;
    for (const l of c.logs ?? []) {
      if (l.address.toLowerCase() === want && l.topics[0]?.toLowerCase() === topic0 && l.topics[2]?.toLowerCase().slice(2) === me) received += BigInt(l.data === '0x' ? 0 : l.data);
    }
    return { ok: true, received };
  }

  /** `Transfer` logs to or from us of the given tokens: one `eth_getLogs` per {@link LOG_ADDRESSES} contracts and direction (publicnode refuses more addresses per query), sent as JSON-RPC batches; one call at a time if the node refuses batches. */
  private async transferLogs(url: string, addresses: string[], fromBlock: bigint, toBlock: bigint): Promise<Array<{ log: RawLog; dir: 'in' | 'out' }>> {
    const me = '0x' + this.address.slice(2).toLowerCase().padStart(64, '0');
    const range = { fromBlock: '0x' + fromBlock.toString(16), toBlock: '0x' + toBlock.toString(16) };
    const queries: Array<{ dir: 'in' | 'out'; params: unknown[] }> = [];
    for (let i = 0; i < addresses.length; i += LOG_ADDRESSES) {
      const address = addresses.slice(i, i + LOG_ADDRESSES);
      queries.push({ dir: 'in', params: [{ ...range, address, topics: [TRANSFER_TOPIC, null, me] }] });
      queries.push({ dir: 'out', params: [{ ...range, address, topics: [TRANSFER_TOPIC, me] }] });
    }
    const results: unknown[][] = [];
    try {
      for (let i = 0; i < queries.length; i += BALANCE_BATCH) {
        const outcomes = await jsonRpcBatch(this.fetcher, url, queries.slice(i, i + BALANCE_BATCH).map((q) => ({ method: 'eth_getLogs', params: q.params })));
        for (const o of outcomes) {
          if (!o.ok) throw o.error;
          results.push(Array.isArray(o.result) ? o.result : []);
        }
      }
    } catch (e) {
      if (!(e instanceof JsonRpcError) && !(e instanceof HttpError && e.status >= 400 && e.status < 500)) throw e;
      results.length = 0;
      for (const q of queries) results.push(await jsonRpc<unknown[]>(this.fetcher, url, 'eth_getLogs', q.params));
    }
    return queries.flatMap((q, i) => (results[i] ?? []).filter(isRawLog).map((log) => ({ log, dir: q.dir })));
  }

  /** ERC-20 transfers of the curated tokens over the last `logRange` blocks. */
  async getHistory(): Promise<HistoryItem[]> {
    const tokens = this.tokens();
    if (tokens.length === 0) return [];
    const contracts = tokens.map((t) => getAddress(t.contract ?? ''));
    // The first node that answers both the block number and the logs (a fallback node when the
    // main one refuses, e.g. HTTP 403 to some Tor exits).
    let logs: Array<{ log: RawLog; dir: 'in' | 'out' }> | null = null;
    let lastError: unknown = null;
    let okUrl = this.rpcUrl;
    for (const url of this.historyUrls) {
      try {
        const latest = BigInt(await jsonRpc<string>(this.fetcher, url, 'eth_blockNumber', []));
        const fromBlock = latest > this.logRange ? latest - this.logRange : 0n;
        logs = await this.transferLogs(url, contracts, fromBlock, latest);
        okUrl = url;
        break;
      } catch (e) {
        lastError = e;
      }
    }
    if (logs === null) throw lastError;
    const all = logs
      .map(({ log, dir }) => ({
        dir,
        l: {
          address: log.address,
          blockNumber: log.blockNumber ? BigInt(log.blockNumber) : null,
          transactionHash: log.transactionHash ?? null,
          logIndex: log.logIndex ? Number(BigInt(log.logIndex)) : 0,
          args: { from: topicAddress(log.topics[1]), to: topicAddress(log.topics[2]), value: /^0x[0-9a-fA-F]+$/.test(log.data) ? BigInt(log.data) : 0n },
        },
      }))
      .sort((a, b) => Number((b.l.blockNumber ?? 0n) - (a.l.blockNumber ?? 0n)))
      .slice(0, 30);
    const blockTimes = new Map<bigint, number>();
    for (const bn of [...new Set(all.map((x) => x.l.blockNumber).filter((b): b is bigint => b !== null))].slice(0, 12)) {
      try {
        const b = await jsonRpc<{ timestamp?: string } | null>(this.fetcher, okUrl, 'eth_getBlockByNumber', ['0x' + bn.toString(16), false]);
        if (b?.timestamp) blockTimes.set(bn, Number(BigInt(b.timestamp)) * 1000);
      } catch {
        /* time unknown */
      }
    }
    // A Transfer(from = us) log does not prove that we sent it: anyone can call `transferFrom(us, lookalike, 0)` (no allowance needed for 0 on most tokens).
    const outHashes = [...new Set(all.filter((x) => x.dir === 'out' && x.l.transactionHash).map((x) => x.l.transactionHash as `0x${string}`))].slice(0, 15);
    const txFrom = new Map<string, string>();
    await Promise.all(
      outHashes.map(async (hash) => {
        try {
          const tx = await jsonRpc<{ from?: string } | null>(this.fetcher, okUrl, 'eth_getTransactionByHash', [hash]);
          if (tx?.from) txFrom.set(hash.toLowerCase(), tx.from.toLowerCase());
        } catch {
          /* unknown sender: the entry stays unverified (never a trusted address anyway) */
        }
      }),
    );
    const me = this.address.toLowerCase();
    return all.map(({ l, dir }) => {
      const token = tokens.find((t) => t.contract?.toLowerCase() === l.address.toLowerCase());
      const counterparty = dir === 'in' ? l.args.from : l.args.to;
      const sender = l.transactionHash ? txFrom.get(l.transactionHash.toLowerCase()) : undefined;
      const suspect = (l.args.value ?? 0n) === 0n ? ('zero' as const) : dir === 'out' && sender !== undefined && sender !== me ? ('notSigned' as const) : undefined;
      const item: HistoryItem = {
        id: `${l.transactionHash ?? ''}:${l.logIndex ?? 0}`,
        chainKey: this.chain.key,
        assetId: token?.id ?? `erc20:${this.chain.chainId}:${l.address.toLowerCase()}`,
        direction: dir,
        amount: l.args.value ?? 0n,
        status: 'confirmed',
        kind: 'transfer',
      };
      if (counterparty) item.counterparty = counterparty;
      if (suspect) item.suspect = suspect;
      const t = l.blockNumber !== null ? blockTimes.get(l.blockNumber) : undefined;
      if (t !== undefined) item.time = t;
      return item;
    });
  }
}
