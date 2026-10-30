// SPDX-License-Identifier: GPL-3.0-or-later
//
// One EVM adapter, parametrised by the chain registry. JSON-RPC goes through a
// viem *custom transport* that calls `net_fetch` — viem never touches fetch.

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
import { call, jsonRpc, netFetch, type EvmTokenHint, type EvmTxRequest, type EvmTxSummary, type NetFetch } from '@kyro/shared';
import { ERC20_TOKENS, nativeAssetId, type AssetDef, type EvmChain } from '../registry';
import { evmFeeOptionsFromHistory } from '../fees';
import type { Balance, BuildParams, ChainAdapter, EvmSigned, EvmUnsigned, FeeEstimates, FeeParams, HistoryItem } from '../types';

export interface EvmAdapterOptions {
  chain: EvmChain;
  address: string;
  /** RPC override (Settings › RPC), else the registry's publicnode URL. */
  rpcUrl?: string;
  fetch?: NetFetch;
  /** Blocks scanned for ERC-20 Transfer logs in getHistory. */
  logRange?: bigint;
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

const TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

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

  constructor(opts: EvmAdapterOptions) {
    this.chain = opts.chain;
    this.address = getAddress(opts.address);
    this.fetcher = opts.fetch ?? netFetch;
    this.rpcUrl = opts.rpcUrl || opts.chain.rpcUrl;
    this.logRange = opts.logRange ?? 5_000n;
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

  async getBalance(): Promise<Balance[]> {
    const native = await this.client.getBalance({ address: this.address });
    const tokens = await Promise.all(
      this.tokens().map(async (t) => {
        try {
          const amount = await this.client.readContract({ address: getAddress(t.contract ?? ''), abi: erc20Abi, functionName: 'balanceOf', args: [this.address] });
          return { assetId: t.id, amount };
        } catch {
          return null;
        }
      }),
    );
    return [{ assetId: nativeAssetId(this.chain), amount: native }, ...tokens.filter((t): t is Balance => t !== null)];
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
    const args: { tx: EvmTxRequest; password: string; token?: EvmTokenHint } = { tx: unsigned.tx, password };
    if (unsigned.token) args.token = unsigned.token;
    const res = await call('evm_sign_tx', args);
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
   * ERC-20 transfers of the curated tokens over the last `logRange` blocks.
   * Native ETH transfers can't be listed without an indexer: the UI merges
   * them from its local record of transactions sent from Kyro.
   */
  async getHistory(): Promise<HistoryItem[]> {
    const tokens = this.tokens();
    if (tokens.length === 0) return [];
    const latest = await this.client.getBlockNumber();
    const fromBlock = latest > this.logRange ? latest - this.logRange : 0n;
    const addresses = tokens.map((t) => getAddress(t.contract ?? ''));
    const [incoming, outgoing] = await Promise.all([
      this.client.getLogs({ address: addresses, event: TRANSFER_EVENT, args: { to: this.address }, fromBlock, toBlock: latest }),
      this.client.getLogs({ address: addresses, event: TRANSFER_EVENT, args: { from: this.address }, fromBlock, toBlock: latest }),
    ]);
    const all = [...incoming.map((l) => ({ l, dir: 'in' as const })), ...outgoing.map((l) => ({ l, dir: 'out' as const }))]
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
