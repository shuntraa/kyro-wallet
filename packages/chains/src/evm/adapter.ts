// SPDX-License-Identifier: GPL-3.0-or-later
//
// One EVM adapter, parametrised by the chain registry. JSON-RPC goes through a
// viem *custom transport* that calls `net_fetch` — viem never touches fetch.

import { accountArg } from '../types';
import {
  createPublicClient,
  custom,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  isAddress,
  type Hex,
  type PublicClient,
} from 'viem';
import { call, HttpError, jsonRpc, jsonRpcBatch, JsonRpcError, netFetch, type EvmTokenHint, type JsonRpcOutcome, type EvmTxRequest, type EvmTxSummary, type NetFetch } from '@kyro/shared';
import { ERC20_TOKENS, nativeAssetId, type AssetDef, type EvmChain } from '../registry';
import { evmFeeOptionsFromHistory } from '../fees';
import type { Balance, BuildParams, ChainAdapter, EvmSigned, EvmUnsigned, FeeEstimates, FeeParams, HistoryItem } from '../types';
import type { HwSigner } from '../hw';

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
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]+$/.test(v)) throw new Error('solde natif illisible');
  return BigInt(v);
};

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

  /**
   * Native balance + `balanceOf` of every curated token. One JSON-RPC batch per
   * {@link BALANCE_BATCH} calls (100+ tokens on Ethereum, a single host: no new server sees
   * anything); if the node refuses batches, one call per token as before. A token whose call
   * fails is left out (unknown), like a missing contract.
   */
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
    // Some public RPCs answer a too-large batch with one error per call (« batch size too
    // large », free plans): read one by one, the native balance call reports any real outage.
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
    if (params.fee.family !== 'evm') throw new Error('Frais EVM attendus');
    const fee = params.fee;
    const recipient = params.to.trim();
    if (!this.isValidAddress(recipient)) throw new Error('Adresse invalide (format ou somme de contrôle EIP-55)');
    const nonce = await this.nonce();
    if (params.asset.kind === 'native') {
      const gasLimit = await this.gas(getAddress(recipient), '0x', 0n);
      let value = params.amount;
      if (params.max) {
        const bal = await this.client.getBalance({ address: this.address });
        value = bal - gasLimit * fee.maxFeePerGas;
        if (value <= 0n) throw new Error('Solde insuffisant pour couvrir les frais');
      }
      return {
        family: 'evm',
        tx: this.request(recipient, value, '0x', gasLimit, fee, nonce),
        asset: params.asset,
        amount: value,
        recipient: getAddress(recipient),
        maxFee: gasLimit * fee.maxFeePerGas,
        size: { family: 'evm', gasLimit },
        kind: 'transfer',
      };
    }
    if (params.asset.kind !== 'erc20' || !params.asset.contract) throw new Error('Actif non pris en charge sur ce réseau');
    const token = getAddress(params.asset.contract);
    let amount = params.amount;
    if (params.max) amount = await this.client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [this.address] });
    if (amount <= 0n) throw new Error('Montant invalide');
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

  /** Rust-side decoding for the "En clair" preview (before the password). */
  decode(unsigned: EvmUnsigned): Promise<EvmTxSummary> {
    return call('evm_decode_tx', { tx: unsigned.tx });
  }

  async signTx(unsigned: EvmUnsigned, password: string): Promise<EvmSigned> {
    const args: { tx: EvmTxRequest; password: string; token?: EvmTokenHint; account?: number } = { tx: unsigned.tx, password, ...accountArg(this.account) };
    if (unsigned.token) args.token = unsigned.token;
    const res = await call('evm_sign_tx', args);
    return { family: 'evm', rawTx: res.rawTx, hash: res.hash };
  }

  /** Signs on the hardware wallet `deviceId` (native dialog, 2nd one if blind signing, device). */
  async signTxHw(unsigned: EvmUnsigned, deviceId: string): Promise<EvmSigned> {
    if (!this.hw) throw new Error('Ce compte n’est pas un hardware wallet');
    const args: { id: string; accountId: string; tx: EvmTxRequest; token?: EvmTokenHint } = { id: deviceId, accountId: this.hw.accountId, tx: unsigned.tx };
    if (unsigned.token) args.token = unsigned.token;
    const res = await call('hw_sign_evm_tx', args);
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
    throw new Error('Délai dépassé en attendant la confirmation');
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
   * `Transfer` logs to or from us of the given tokens: one `eth_getLogs` per
   * {@link LOG_ADDRESSES} contracts and direction (publicnode refuses more addresses per query),
   * sent as JSON-RPC batches; one call at a time if the node refuses batches.
   */
  private async transferLogs(addresses: string[], fromBlock: bigint, toBlock: bigint): Promise<Array<{ log: RawLog; dir: 'in' | 'out' }>> {
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
        const outcomes = await jsonRpcBatch(this.fetcher, this.rpcUrl, queries.slice(i, i + BALANCE_BATCH).map((q) => ({ method: 'eth_getLogs', params: q.params })));
        for (const o of outcomes) {
          if (!o.ok) throw o.error;
          results.push(Array.isArray(o.result) ? o.result : []);
        }
      }
    } catch (e) {
      if (!(e instanceof JsonRpcError) && !(e instanceof HttpError && e.status >= 400 && e.status < 500)) throw e;
      results.length = 0;
      for (const q of queries) results.push(await jsonRpc<unknown[]>(this.fetcher, this.rpcUrl, 'eth_getLogs', q.params));
    }
    return queries.flatMap((q, i) => (results[i] ?? []).filter(isRawLog).map((log) => ({ log, dir: q.dir })));
  }

  /**
   * ERC-20 transfers of the curated tokens over the last `logRange` blocks.
   * Native transfers can't be listed without an indexer: the UI merges
   * them from its local record of transactions sent from Kyro.
   */
  async getHistory(): Promise<HistoryItem[]> {
    const tokens = this.tokens();
    if (tokens.length === 0) return [];
    const latest = await this.client.getBlockNumber();
    const fromBlock = latest > this.logRange ? latest - this.logRange : 0n;
    const logs = await this.transferLogs(tokens.map((t) => getAddress(t.contract ?? '')), fromBlock, latest);
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
        const b = await this.client.getBlock({ blockNumber: bn });
        blockTimes.set(bn, Number(b.timestamp) * 1000);
      } catch {
        /* time unknown */
      }
    }
    return all.map(({ l, dir }) => {
      const token = tokens.find((t) => t.contract?.toLowerCase() === l.address.toLowerCase());
      const counterparty = dir === 'in' ? l.args.from : l.args.to;
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
      const t = l.blockNumber !== null ? blockTimes.get(l.blockNumber) : undefined;
      if (t !== undefined) item.time = t;
      return item;
    });
  }
}
