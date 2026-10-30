// SPDX-License-Identifier: GPL-3.0-or-later
//
// DEMO ONLY — fake answers for every allowlisted host, so the real adapters
// (Esplora, EVM JSON-RPC, Solana RPC, CoinGecko, swap APIs) can run end to end
// in a plain browser without any network access.

import { base58, base64 } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';
import { IpcError, type Accounts, type EvmTxRequest, type Network, type NetRequest, type NetResponse } from './ipc';
import { DEMO_COINS, DEMO_EUR_USD, DEMO_TOKENS, demoPrice, demoSeries } from './mock-data';

export interface DemoUtxo {
  txid: string;
  vout: number;
  value: number;
  height: number;
}

export interface DemoChainState {
  network: Network;
  accounts: Accounts;
  tipHeight: number;
  btcUtxos: Map<string, DemoUtxo[]>;
  /** `${chainId}:${owner}` → wei */
  evmNative: Map<string, bigint>;
  /** `${chainId}:${token}:${owner}` → base units */
  evmTokens: Map<string, bigint>;
  /** `${chainId}:${token}:${owner}:${spender}` → base units */
  allowances: Map<string, bigint>;
  nonces: Map<number, number>;
  /** rawTx → request (filled by evm_sign_tx, applied on eth_sendRawTransaction) */
  signedEvm: Map<string, { hash: string; tx: EvmTxRequest; from: string }>;
  minedEvm: Map<string, { blockNumber: number }>;
  solLamports: bigint;
  solTokens: Map<string, bigint>;
}

const EVM_HOSTS: Record<string, number> = {
  'ethereum-sepolia-rpc.publicnode.com': 11155111,
  'ethereum-rpc.publicnode.com': 1,
  'arbitrum-one-rpc.publicnode.com': 42161,
  'optimism-rpc.publicnode.com': 10,
  'base-rpc.publicnode.com': 8453,
  'polygon-bor-rpc.publicnode.com': 137,
  'bsc-rpc.publicnode.com': 56,
  'avalanche-c-chain-rpc.publicnode.com': 43114,
};

const BASE_FEE_GWEI: Record<number, number> = {
  1: 4.2, 11155111: 4.2, 42161: 0.01, 10: 0.002, 8453: 0.004, 137: 32, 56: 1, 43114: 25,
};

const SOL_HOSTS = new Set(['api.devnet.solana.com', 'api.mainnet-beta.solana.com']);
const ALLOWANCE_HOLDER = '0x0000000000001ff3684f28c67538d4d072c22734';
const ONEINCH_ROUTER = '0x111111125421ca6dc452d289314280a0f8842a65';
const LIFI_DIAMOND = '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae';

const json = (status: number, body: unknown): NetResponse => ({ status, body: JSON.stringify(body) });
const text = (status: number, body: string): NetResponse => ({ status, body });
const hex = (n: bigint | number): string => '0x' + BigInt(n).toString(16);
const pad32 = (n: bigint): string => n.toString(16).padStart(64, '0');

export function demoHash(seed: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(seed)));
}

function rpcResult(id: unknown, result: unknown): NetResponse {
  return json(200, { jsonrpc: '2.0', id, result });
}
function rpcError(id: unknown, code: number, message: string): NetResponse {
  return json(200, { jsonrpc: '2.0', id, error: { code, message } });
}

/** Route a `net_fetch` request to the matching fake service. */
export async function handleDemoNet(req: NetRequest, s: DemoChainState): Promise<NetResponse> {
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    throw new IpcError('INVALID_INPUT', 'URL invalide.');
  }
  if (url.protocol !== 'https:') throw new IpcError('HOST_NOT_ALLOWED', 'Seules les connexions HTTPS sont autorisées.');
  // Small artificial latency so loading states are visible in the demo.
  await new Promise((r) => setTimeout(r, 60 + Math.random() * 120));
  const host = url.host;
  if (host === 'api.coingecko.com' || host === 'pro-api.coingecko.com') return coingecko(url);
  if (host === 'mempool.space') return esplora(url, req, s);
  if (host in EVM_HOSTS) return evmRpc(EVM_HOSTS[host] ?? 1, req, s);
  if (SOL_HOSTS.has(host)) return solRpc(req, s);
  if (host === 'api.0x.org') return zerox(url);
  if (host === 'api.1inch.dev') return oneinch(url);
  if (host === 'li.quest') return lifi(url);
  if (host === 'lite-api.jup.ag') return jupiter(url, req, s);
  throw new IpcError('HOST_NOT_ALLOWED', `Hôte non autorisé : ${host}`);
}

// ---------------------------------------------------------------- CoinGecko

function coingecko(url: URL): NetResponse {
  const path = url.pathname.replace(/^\/api\/v3/, '');
  const cur = (url.searchParams.get('vs_currency') ?? url.searchParams.get('vs_currencies') ?? 'eur').toLowerCase();
  const fx = cur === 'usd' ? DEMO_EUR_USD : 1;
  if (path === '/coins/markets') {
    return json(
      200,
      DEMO_COINS.map((c, i) => ({
        id: c.id,
        symbol: c.symbol,
        name: c.name,
        image: '',
        current_price: c.price * fx,
        market_cap: c.marketCapEur * fx,
        market_cap_rank: i + 1,
        total_volume: c.marketCapEur * fx * 0.04,
        high_24h: c.price * fx * 1.015,
        low_24h: c.price * fx * 0.982,
        price_change_percentage_24h: c.change24h,
        price_change_percentage_24h_in_currency: c.change24h,
        price_change_percentage_7d_in_currency: c.change7d,
        last_updated: new Date().toISOString(),
        sparkline_in_7d: { price: demoSeries(`${c.id}:7d`, 168, c.price * fx, c.change7d) },
      })),
    );
  }
  const chart = /^\/coins\/([^/]+)\/market_chart$/.exec(path);
  if (chart) {
    const coin = DEMO_COINS.find((c) => c.id === chart[1]);
    if (!coin) return json(404, { error: 'coin not found' });
    const daysParam = url.searchParams.get('days') ?? '1';
    const days = daysParam === 'max' ? 2000 : Math.max(1, Number(daysParam) || 1);
    const points = days <= 1 ? 96 : days <= 7 ? 168 : days <= 30 ? 180 : 365;
    const change = days <= 1 ? coin.change24h : days <= 7 ? coin.change7d : coin.change7d * Math.sqrt(days / 7);
    const series = demoSeries(`${coin.id}:${daysParam}`, points, coin.price * fx, change);
    const now = Date.now();
    const step = (days * 86_400_000) / (points - 1);
    return json(200, { prices: series.map((p, i) => [Math.round(now - (points - 1 - i) * step), p]) });
  }
  if (path === '/simple/price') {
    const ids = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean);
    const out: Record<string, Record<string, number>> = {};
    for (const id of ids) {
      const c = DEMO_COINS.find((x) => x.id === id);
      if (c) out[id] = { [cur]: c.price * fx, [`${cur}_24h_change`]: c.change24h };
    }
    return json(200, out);
  }
  if (path === '/ping') return json(200, { gecko_says: '(V3) To the Moon! (demo)' });
  return json(404, { error: 'not found' });
}

// ---------------------------------------------------------------- Esplora

function esplora(url: URL, req: NetRequest, s: DemoChainState): NetResponse {
  const path = url.pathname.replace(/^\/(testnet4\/|testnet\/|signet\/)?api/, '');
  if (path === '/blocks/tip/height') return text(200, String(s.tipHeight));
  if (path === '/v1/fees/recommended') {
    return json(200, { fastestFee: 12, halfHourFee: 6, hourFee: 3, economyFee: 2, minimumFee: 1 });
  }
  if (path === '/tx' && req.method === 'POST') {
    const raw = (req.body ?? '').trim();
    if (!/^[0-9a-f]+$/i.test(raw)) return text(400, 'sendrawtransaction RPC error: TX decode failed');
    return text(200, demoHash(raw));
  }
  const m = /^\/address\/([^/]+)(\/utxo|\/txs)?$/.exec(path);
  if (m) {
    const addr = m[1] ?? '';
    const utxos = s.btcUtxos.get(addr) ?? [];
    if (m[2] === '/utxo') {
      return json(200, utxos.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, status: { confirmed: true, block_height: u.height } })));
    }
    if (m[2] === '/txs') {
      return json(
        200,
        utxos.map((u, i) => ({
          txid: u.txid,
          fee: 141 + i * 12,
          status: { confirmed: true, block_height: u.height, block_time: Math.floor(Date.now() / 1000) - (i + 1) * 86_400 * 3 },
          vin: [{ txid: demoHash(`${u.txid}:in`), vout: 0, prevout: { scriptpubkey_address: 'tb1qdemoexternalsender0000000000000000000', value: u.value + 5000 } }],
          vout: [
            { scriptpubkey_address: addr, value: u.value },
            { scriptpubkey_address: 'tb1qdemoexternalchange000000000000000000', value: 4859 },
          ],
        })),
      );
    }
    const sum = utxos.reduce((a, u) => a + u.value, 0);
    const stats = { funded_txo_count: utxos.length, funded_txo_sum: sum, spent_txo_count: 0, spent_txo_sum: 0, tx_count: utxos.length };
    return json(200, { address: addr, chain_stats: stats, mempool_stats: { funded_txo_count: 0, funded_txo_sum: 0, spent_txo_count: 0, spent_txo_sum: 0, tx_count: 0 } });
  }
  return text(404, 'Not found');
}

// ---------------------------------------------------------------- EVM

function evmRpc(chainId: number, req: NetRequest, s: DemoChainState): NetResponse {
  let body: { id?: unknown; method?: string; params?: unknown[] };
  try {
    body = JSON.parse(req.body ?? '{}') as typeof body;
  } catch {
    return json(400, { error: 'bad json' });
  }
  const id = body.id ?? 1;
  const p = body.params ?? [];
  const block = s.tipHeight * 3 + 4_100_000;
  const baseFee = BigInt(Math.round((BASE_FEE_GWEI[chainId] ?? 1) * 1e9));
  switch (body.method) {
    case 'eth_chainId':
      return rpcResult(id, hex(chainId));
    case 'net_version':
      return rpcResult(id, String(chainId));
    case 'eth_blockNumber':
      return rpcResult(id, hex(block));
    case 'eth_getBalance': {
      const owner = String(p[0]).toLowerCase();
      return rpcResult(id, hex(s.evmNative.get(`${chainId}:${owner}`) ?? 0n));
    }
    case 'eth_getTransactionCount':
      return rpcResult(id, hex(s.nonces.get(chainId) ?? 3));
    case 'eth_gasPrice':
      return rpcResult(id, hex(baseFee + baseFee / 4n));
    case 'eth_maxPriorityFeePerGas':
      return rpcResult(id, hex(baseFee / 3n + 1n));
    case 'eth_estimateGas': {
      const call = (p[0] ?? {}) as { data?: string; input?: string };
      const data = call.data ?? call.input ?? '0x';
      if (data === '0x' || data === '') return rpcResult(id, hex(21_000));
      return rpcResult(id, hex(data.startsWith('0x095ea7b3') ? 46_000 : 65_000));
    }
    case 'eth_feeHistory': {
      const count = Math.min(Number(p[0] ?? 10) || 10, 20);
      const pct = (p[2] as number[] | undefined) ?? [10, 50, 90];
      const baseFees = Array.from({ length: count + 1 }, (_, i) => hex(baseFee + (baseFee * BigInt(i % 3)) / 20n));
      const reward = Array.from({ length: count }, () => pct.map((q) => hex((baseFee * BigInt(Math.round(q))) / 200n + 1n)));
      return rpcResult(id, { oldestBlock: hex(block - count), baseFeePerGas: baseFees, gasUsedRatio: Array(count).fill(0.5), reward });
    }
    case 'eth_getBlockByNumber':
    case 'eth_getBlockByHash':
      return rpcResult(id, {
        number: hex(block),
        hash: '0x' + demoHash(`block:${chainId}:${block}`),
        parentHash: '0x' + demoHash(`block:${chainId}:${block - 1}`),
        timestamp: hex(Math.floor(Date.now() / 1000)),
        baseFeePerGas: hex(baseFee),
        gasLimit: hex(30_000_000),
        gasUsed: hex(15_000_000),
        miner: '0x0000000000000000000000000000000000000000',
        transactions: [],
        size: '0x100',
        difficulty: '0x0',
        totalDifficulty: '0x0',
        extraData: '0x',
        logsBloom: '0x' + '0'.repeat(512),
        nonce: '0x0000000000000000',
        sha3Uncles: '0x' + '0'.repeat(64),
        stateRoot: '0x' + '0'.repeat(64),
        receiptsRoot: '0x' + '0'.repeat(64),
        transactionsRoot: '0x' + '0'.repeat(64),
        mixHash: '0x' + '0'.repeat(64),
        uncles: [],
      });
    case 'eth_getCode':
      return rpcResult(id, '0x');
    case 'eth_getLogs':
      return rpcResult(id, []);
    case 'eth_call': {
      const call = (p[0] ?? {}) as { to?: string; data?: string; input?: string; from?: string };
      const to = (call.to ?? '').toLowerCase();
      const data = (call.data ?? call.input ?? '0x').toLowerCase();
      const arg = (i: number) => '0x' + data.slice(10 + 24 + i * 64, 10 + (i + 1) * 64);
      if (data.startsWith('0x70a08231')) return rpcResult(id, '0x' + pad32(s.evmTokens.get(`${chainId}:${to}:${arg(0)}`) ?? 0n));
      if (data.startsWith('0xdd62ed3e')) return rpcResult(id, '0x' + pad32(s.allowances.get(`${chainId}:${to}:${arg(0)}:${arg(1)}`) ?? 0n));
      if (data.startsWith('0x313ce567')) return rpcResult(id, '0x' + pad32(BigInt(DEMO_TOKENS[to]?.decimals ?? 18)));
      // Swap simulations: succeed when the allowance is in place, revert otherwise.
      if (to === ALLOWANCE_HOLDER || to === ONEINCH_ROUTER || to === LIFI_DIAMOND) return rpcResult(id, '0x');
      return rpcResult(id, '0x');
    }
    case 'eth_sendRawTransaction': {
      const raw = String(p[0] ?? '');
      const signed = s.signedEvm.get(raw);
      if (!signed) return rpcError(id, -32000, 'invalid sender (demo: unknown raw transaction)');
      applyEvmTx(chainId, signed.tx, signed.from, s);
      s.minedEvm.set(signed.hash, { blockNumber: block + 1 });
      s.nonces.set(chainId, (s.nonces.get(chainId) ?? 3) + 1);
      return rpcResult(id, signed.hash);
    }
    case 'eth_getTransactionReceipt': {
      const hash = String(p[0] ?? '');
      const mined = s.minedEvm.get(hash);
      if (!mined) return rpcResult(id, null);
      return rpcResult(id, {
        transactionHash: hash,
        transactionIndex: '0x0',
        blockHash: '0x' + demoHash(`block:${mined.blockNumber}`),
        blockNumber: hex(mined.blockNumber),
        from: s.accounts.evm.address.toLowerCase(),
        to: null,
        cumulativeGasUsed: hex(21_000),
        gasUsed: hex(21_000),
        effectiveGasPrice: hex(baseFee),
        contractAddress: null,
        logs: [],
        logsBloom: '0x' + '0'.repeat(512),
        status: '0x1',
        type: '0x2',
      });
    }
    default:
      return rpcError(id, -32601, `Method not found (demo): ${body.method ?? '?'}`);
  }
}

function applyEvmTx(chainId: number, tx: EvmTxRequest, from: string, s: DemoChainState): void {
  const owner = from.toLowerCase();
  const nativeKey = `${chainId}:${owner}`;
  const fee = BigInt(tx.gasLimit) * BigInt(Math.round((BASE_FEE_GWEI[chainId] ?? 1) * 1e9));
  const value = BigInt(tx.valueWei);
  s.evmNative.set(nativeKey, maxZero((s.evmNative.get(nativeKey) ?? 0n) - value - fee));
  const to = tx.to.toLowerCase();
  const data = tx.data.toLowerCase();
  if (data.startsWith('0xa9059cbb')) {
    const amount = BigInt('0x' + data.slice(74, 138));
    const k = `${chainId}:${to}:${owner}`;
    s.evmTokens.set(k, maxZero((s.evmTokens.get(k) ?? 0n) - amount));
  } else if (data.startsWith('0x095ea7b3')) {
    const spender = '0x' + data.slice(34, 74);
    const amount = BigInt('0x' + data.slice(74, 138));
    s.allowances.set(`${chainId}:${to}:${owner}:${spender}`, amount);
  }
}

const maxZero = (n: bigint) => (n < 0n ? 0n : n);

// ---------------------------------------------------------------- Solana

function solRpc(req: NetRequest, s: DemoChainState): NetResponse {
  let body: { id?: unknown; method?: string; params?: unknown[] };
  try {
    body = JSON.parse(req.body ?? '{}') as typeof body;
  } catch {
    return json(400, { error: 'bad json' });
  }
  const id = body.id ?? 1;
  const p = body.params ?? [];
  const slot = 312_000_000 + s.tipHeight;
  const ctx = { slot, apiVersion: '2.0.0' };
  const me = s.accounts.sol.address;
  switch (body.method) {
    case 'getSlot':
    case 'getBlockHeight':
      return rpcResult(id, slot);
    case 'getBalance':
      return rpcResult(id, { context: ctx, value: p[0] === me ? Number(s.solLamports) : 0 });
    case 'getLatestBlockhash':
      return rpcResult(id, { context: ctx, value: { blockhash: base58.encode(sha256(new TextEncoder().encode(`bh:${slot}`))), lastValidBlockHeight: slot + 150 } });
    case 'getRecentPrioritizationFees':
      return rpcResult(id, Array.from({ length: 20 }, (_, i) => ({ slot: slot - i, prioritizationFee: [0, 1000, 5000, 12000, 50000][i % 5] })));
    case 'getFeeForMessage':
      return rpcResult(id, { context: ctx, value: 5000 });
    case 'getTokenAccountsByOwner': {
      const filter = (p[1] ?? {}) as { programId?: string; mint?: string };
      if (p[0] !== me || (filter.programId && filter.programId !== TOKEN_PROGRAM)) return rpcResult(id, { context: ctx, value: [] });
      return rpcResult(id, {
        context: ctx,
        value: [...s.solTokens.entries()]
          .filter(([mint]) => !filter.mint || filter.mint === mint)
          .map(([mint, amount]) => ({
            pubkey: demoTokenAccount(mint),
            account: {
              lamports: 2_039_280,
              owner: TOKEN_PROGRAM,
              executable: false,
              rentEpoch: 0,
              space: 165,
              data: { program: 'spl-token', space: 165, parsed: { type: 'account', info: { mint, owner: me, state: 'initialized', tokenAmount: { amount: amount.toString(), decimals: DEMO_TOKENS[mint]?.decimals ?? 6, uiAmountString: '' } } } },
            },
          })),
      });
    }
    case 'getAccountInfo': {
      const addr = String(p[0] ?? '');
      const acct = (owner: string, data: Uint8Array, lamports: number) => ({ context: ctx, value: { lamports, owner, executable: false, rentEpoch: 0, space: data.length, data: [base64.encode(data), 'base64'] } });
      const token = DEMO_TOKENS[addr];
      if (token && !addr.startsWith('0x')) {
        // SPL Mint layout: COption<authority>(36) supply(8) decimals(1) initialized(1) COption<freeze>(36) = 82 bytes.
        const mint = new Uint8Array(82);
        mint[44] = token.decimals;
        mint[45] = 1;
        return rpcResult(id, acct(TOKEN_PROGRAM, mint, 1_461_600));
      }
      if (addr === me) return rpcResult(id, acct('11111111111111111111111111111111', new Uint8Array(0), Number(s.solLamports)));
      for (const mintAddr of s.solTokens.keys()) if (demoTokenAccount(mintAddr) === addr) return rpcResult(id, acct(TOKEN_PROGRAM, new Uint8Array(165), 2_039_280));
      return rpcResult(id, { context: ctx, value: null });
    }
    case 'getMinimumBalanceForRentExemption':
      return rpcResult(id, (Number(p[0] ?? 0) + 128) * 3480 * 2);
    case 'getSignaturesForAddress': {
      if (p[0] !== me) return rpcResult(id, []);
      return rpcResult(id, [{ signature: demoSig('incoming-1'), slot: slot - 90_000, blockTime: Math.floor(Date.now() / 1000) - 86_400 * 2, err: null, memo: null, confirmationStatus: 'finalized' }]);
    }
    case 'getTransaction': {
      const sender = base58.encode(sha256(new TextEncoder().encode('demo-sol-sender')));
      return rpcResult(id, {
        slot: slot - 90_000,
        blockTime: Math.floor(Date.now() / 1000) - 86_400 * 2,
        meta: { err: null, fee: 5000, preBalances: [5_200_005_000, 0], postBalances: [2_000_000_000, 3_200_000_000] },
        transaction: { message: { accountKeys: [{ pubkey: sender, signer: true, writable: true }, { pubkey: me, signer: false, writable: true }] }, signatures: [String(p[0])] },
      });
    }
    case 'getSignatureStatuses':
      return rpcResult(id, { context: ctx, value: ((p[0] as string[]) ?? []).map(() => ({ slot, confirmations: null, err: null, confirmationStatus: 'confirmed' })) });
    case 'sendTransaction': {
      const wire = base64.decode(String(p[0] ?? ''));
      const sig = wire.slice(1, 65);
      return rpcResult(id, base58.encode(sig));
    }
    default:
      return rpcError(id, -32601, `Method not found (demo): ${body.method ?? '?'}`);
  }
}

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

/** Our demo token account for a mint (stands in for the derived ATA). */
export function demoTokenAccount(mint: string): string {
  return base58.encode(sha256(new TextEncoder().encode(`ata:${mint}`)));
}

function demoSig(seed: string): string {
  const a = sha256(new TextEncoder().encode(seed));
  const b = sha256(a);
  const out = new Uint8Array(64);
  out.set(a, 0);
  out.set(b, 32);
  return base58.encode(out);
}

// ---------------------------------------------------------------- swap APIs

function convert(sellToken: string, buyToken: string, sellAmount: bigint, haircut: number): bigint {
  const norm = (t: string) => (t.startsWith('0x') ? t.toLowerCase() : t);
  const s = DEMO_TOKENS[norm(sellToken)] ?? { coin: 'usd-coin', decimals: 18 };
  const b = DEMO_TOKENS[norm(buyToken)] ?? { coin: 'usd-coin', decimals: 18 };
  const sellUnits = Number(sellAmount) / 10 ** s.decimals;
  const value = sellUnits * demoPrice(s.coin) * (1 - haircut);
  const buyUnits = value / demoPrice(b.coin);
  return BigInt(Math.floor(buyUnits * 10 ** b.decimals));
}

const isNativeEvm = (t: string) => t.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

function zerox(url: URL): NetResponse {
  const q = url.searchParams;
  const sellToken = q.get('sellToken') ?? '';
  const buyToken = q.get('buyToken') ?? '';
  const sellAmount = BigInt(q.get('sellAmount') ?? '0');
  const bps = Number(q.get('slippageBps') ?? '50');
  const buy = convert(sellToken, buyToken, sellAmount, 0.0018);
  const fee = (buy * 15n) / 10_000n;
  const gas = 182_000n;
  const gasPrice = 5_000_000_000n;
  return json(200, {
    liquidityAvailable: true,
    buyAmount: (buy - fee).toString(),
    minBuyAmount: (((buy - fee) * BigInt(10_000 - bps)) / 10_000n).toString(),
    sellAmount: sellAmount.toString(),
    allowanceTarget: ALLOWANCE_HOLDER,
    issues: { allowance: isNativeEvm(sellToken) ? null : { actual: '0', spender: ALLOWANCE_HOLDER }, balance: null, simulationIncomplete: false },
    fees: { zeroExFee: { amount: fee.toString(), token: buyToken, type: 'volume' }, integratorFee: null, gasFee: null },
    totalNetworkFee: (gas * gasPrice).toString(),
    route: { fills: [{ source: 'Uniswap_V3', proportionBps: '7000' }, { source: 'Curve', proportionBps: '3000' }] },
    transaction: { to: ALLOWANCE_HOLDER, data: '0x2213bc0b' + '0'.repeat(256), gas: gas.toString(), gasPrice: gasPrice.toString(), value: isNativeEvm(sellToken) ? sellAmount.toString() : '0' },
  });
}

function oneinch(url: URL): NetResponse {
  const q = url.searchParams;
  const src = q.get('src') ?? '';
  const dst = q.get('dst') ?? '';
  const amount = BigInt(q.get('amount') ?? '0');
  const buy = convert(src, dst, amount, 0.0024);
  return json(200, {
    dstAmount: buy.toString(),
    tx: { from: q.get('from') ?? '', to: ONEINCH_ROUTER, data: '0x07ed2379' + '0'.repeat(256), value: isNativeEvm(src) ? amount.toString() : '0', gas: 205_000, gasPrice: '5200000000' },
  });
}

function lifi(url: URL): NetResponse {
  const q = url.searchParams;
  const from = q.get('fromToken') ?? '';
  const to = q.get('toToken') ?? '';
  const amount = BigInt(q.get('fromAmount') ?? '0');
  const slip = Number(q.get('slippage') ?? '0.005');
  const buy = convert(from, to, amount, 0.0035);
  return json(200, {
    tool: 'stargate',
    toolDetails: { key: 'stargate', name: 'Stargate' },
    estimate: {
      toAmount: buy.toString(),
      toAmountMin: ((buy * BigInt(Math.round((1 - slip) * 10_000))) / 10_000n).toString(),
      approvalAddress: LIFI_DIAMOND,
      executionDuration: 45,
      gasCosts: [{ amountUSD: '1.21' }],
      feeCosts: [{ amountUSD: '0.95', included: true, name: 'LI.FI fee' }],
    },
    transactionRequest: { to: LIFI_DIAMOND, data: '0x4630a0d8' + '0'.repeat(256), value: isNativeEvm(from) ? hex(amount) : '0x0', gasLimit: hex(240_000), gasPrice: hex(5_100_000_000) },
  });
}

function jupiter(url: URL, req: NetRequest, s: DemoChainState): NetResponse {
  if (url.pathname.endsWith('/quote')) {
    const q = url.searchParams;
    const inputMint = q.get('inputMint') ?? '';
    const outputMint = q.get('outputMint') ?? '';
    const amount = BigInt(q.get('amount') ?? '0');
    const bps = Number(q.get('slippageBps') ?? '50');
    const out = convert(inputMint, outputMint, amount, 0.0012);
    return json(200, {
      inputMint,
      outputMint,
      inAmount: amount.toString(),
      outAmount: out.toString(),
      otherAmountThreshold: ((out * BigInt(10_000 - bps)) / 10_000n).toString(),
      slippageBps: bps,
      priceImpactPct: '0.0004',
      routePlan: [{ swapInfo: { label: 'Orca Whirlpool' }, percent: 100 }],
    });
  }
  if (url.pathname.endsWith('/swap') && req.method === 'POST') {
    return json(200, { swapTransaction: demoSolanaWireTx(s.accounts.sol.address), lastValidBlockHeight: 312_000_150 });
  }
  return json(404, { error: 'not found' });
}

/** A syntactically valid legacy transaction (self-transfer of 0 lamports) with an empty signature slot. */
export function demoSolanaWireTx(payer: string): string {
  const payerBytes = base58.decode(payer);
  const system = new Uint8Array(32);
  const blockhash = sha256(new TextEncoder().encode('demo-blockhash'));
  const data = new Uint8Array(12);
  data[0] = 2; // SystemInstruction::Transfer, lamports = 0
  const msg = [1, 0, 1, 2, ...payerBytes, ...system, ...blockhash, 1, 1, 2, 0, 0, data.length, ...data];
  const wire = new Uint8Array(1 + 64 + msg.length);
  wire[0] = 1;
  wire.set(msg, 65);
  return base64.encode(wire);
}
