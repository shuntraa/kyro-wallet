// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { NetRequest, NetResponse } from '@kyro/shared';
import { BALANCE_BATCH, EvmAdapter, ERC20_TOKENS, evmChains, LOG_ADDRESSES } from '../src';

const ME = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const eth = evmChains('mainnet').find((c) => c.key === 'ethereum')!;
const pad = (n: bigint) => '0x' + n.toString(16).padStart(64, '0');

type Rpc = { id: number; method: string; params: unknown[] };

/** Fake node: native 1 ETH, token #i holds i units, token #1 has no code, token #2 reverts. */
function node(opts: { batches: boolean; perItemErrors?: boolean }) {
  const seen: NetRequest[] = [];
  const contracts = (ERC20_TOKENS.ethereum ?? []).map((t) => t.contract.toLowerCase());
  const answer = (r: Rpc) => {
    if (r.method === 'eth_getBalance') return { jsonrpc: '2.0', id: r.id, result: '0xde0b6b3a7640000' };
    if (r.method === 'eth_call') {
      const i = contracts.indexOf(((r.params[0] as { to: string }).to ?? '').toLowerCase());
      if (i === 1) return { jsonrpc: '2.0', id: r.id, result: '0x' };
      if (i === 2) return { jsonrpc: '2.0', id: r.id, error: { code: 3, message: 'execution reverted' } };
      return { jsonrpc: '2.0', id: r.id, result: pad(BigInt(i)) };
    }
    return { jsonrpc: '2.0', id: r.id, error: { code: -32601, message: 'method not found' } };
  };
  const fetch = async (req: NetRequest): Promise<NetResponse> => {
    seen.push(req);
    const body = JSON.parse(req.body ?? 'null') as Rpc | Rpc[];
    if (Array.isArray(body)) {
      if (!opts.batches) return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'batch not supported' } }) };
      if (opts.perItemErrors) return { status: 200, body: JSON.stringify(body.map((r) => ({ jsonrpc: '2.0', id: r.id, error: { code: -32062, message: 'Batch size too large' } }))) };
      // Answers in reverse order: matched by id, not by position.
      return { status: 200, body: JSON.stringify(body.map(answer).reverse()) };
    }
    return { status: 200, body: JSON.stringify(answer(body)) };
  };
  return { fetch, seen, contracts };
}

describe('EVM balances via JSON-RPC batches', () => {
  it('one HTTP call per batch, matched ids, missing or failing contract omitted', async () => {
    const n = node({ batches: true });
    const a = new EvmAdapter({ chain: eth, address: ME, fetch: n.fetch });
    const bal = await a.getBalance();
    const tokens = a.tokens();
    expect(n.seen).toHaveLength(Math.ceil((tokens.length + 1) / BALANCE_BATCH));
    expect(n.seen.every((r) => new URL(r.url).host === 'ethereum-rpc.publicnode.com')).toBe(true);
    expect(bal[0]).toEqual({ assetId: 'eth:1', amount: 10n ** 18n });
    const byId = new Map(bal.map((b) => [b.assetId, b.amount]));
    expect(byId.get(tokens[0]!.id)).toBe(0n);
    expect(byId.has(tokens[1]!.id)).toBe(false);
    expect(byId.has(tokens[2]!.id)).toBe(false);
    if (tokens[3]) expect(byId.get(tokens[3].id)).toBe(3n);
    expect(bal).toHaveLength(tokens.length + 1 - 2);
  });

  it('falls back to call by call if the node refuses batches', async () => {
    const n = node({ batches: false });
    const a = new EvmAdapter({ chain: eth, address: ME, fetch: n.fetch });
    const bal = await a.getBalance();
    expect(bal[0]?.amount).toBe(10n ** 18n);
    expect(bal.length).toBeGreaterThan(1);
    expect(n.seen.length).toBeGreaterThan(a.tokens().length);
  });

  it('also falls back when the batch comes back with one error per call (free plans)', async () => {
    const n = node({ batches: true, perItemErrors: true });
    const a = new EvmAdapter({ chain: eth, address: ME, fetch: n.fetch });
    const bal = await a.getBalance();
    expect(bal[0]?.amount).toBe(10n ** 18n);
    expect(bal.length).toBeGreaterThan(1);
  });

  it('history: falls back to the second public node when the first refuses (HTTP 403)', async () => {
    const hosts: string[] = [];
    const fetch = async (req: NetRequest): Promise<NetResponse> => {
      const host = new URL(req.url).host;
      hosts.push(host);
      if (host === 'main.example') return { status: 403, body: 'forbidden' };
      const body = JSON.parse(req.body ?? 'null') as Rpc | Rpc[];
      const answer = (r: Rpc) => ({ jsonrpc: '2.0', id: r.id, result: r.method === 'eth_blockNumber' ? '0x100000' : [] });
      return { status: 200, body: JSON.stringify(Array.isArray(body) ? body.map(answer) : answer(body)) };
    };
    const chain = { ...eth, rpcUrl: 'https://main.example', fallbackRpcUrl: 'https://backup.example' };
    expect(await new EvmAdapter({ chain, address: ME, fetch }).getHistory()).toEqual([]);
    expect(hosts[0]).toBe('main.example');
    expect(hosts).toContain('backup.example');
    // A custom RPC (Settings) is never replaced by the public fallback.
    hosts.length = 0;
    await expect(new EvmAdapter({ chain, address: ME, fetch, rpcUrl: 'https://main.example' }).getHistory()).rejects.toThrow();
    expect(hosts.every((h) => h === 'main.example')).toBe(true);
  });

  it('history: eth_getLogs in groups of at most 10 contracts, sent in batches', async () => {
    const seen: Rpc[][] = [];
    const fetch = async (req: NetRequest): Promise<NetResponse> => {
      const body = JSON.parse(req.body ?? 'null') as Rpc | Rpc[];
      const list = Array.isArray(body) ? body : [body];
      seen.push(list);
      const answer = (r: Rpc) => {
        if (r.method === 'eth_blockNumber') return { jsonrpc: '2.0', id: r.id, result: '0x100000' };
        if (r.method === 'eth_getLogs') {
          const f = r.params[0] as { address: string[]; topics: Array<string | null> };
          if (f.address.length > LOG_ADDRESSES) return { jsonrpc: '2.0', id: r.id, error: { code: -32602, message: 'A maximum of 10 addresses is allowed' } };
          const inbound = f.topics[2] !== undefined && f.topics[2] !== null;
          if (!inbound || f.address[0]!.toLowerCase() !== (ERC20_TOKENS.ethereum ?? [])[0]!.contract.toLowerCase()) return { jsonrpc: '2.0', id: r.id, result: [] };
          return { jsonrpc: '2.0', id: r.id, result: [{ address: f.address[0], topics: [f.topics[0], pad(0xabcn), f.topics[2]], data: pad(5n), blockNumber: '0xfff00', transactionHash: '0x' + '11'.repeat(32), logIndex: '0x2' }] };
        }
        if (r.method === 'eth_getBlockByNumber') return { jsonrpc: '2.0', id: r.id, result: null };
        return { jsonrpc: '2.0', id: r.id, error: { code: -32601, message: 'method not found' } };
      };
      return { status: 200, body: JSON.stringify(Array.isArray(body) ? list.map(answer) : answer(list[0]!)) };
    };
    const a = new EvmAdapter({ chain: eth, address: ME, fetch });
    const h = await a.getHistory();
    const logCalls = seen.flat().filter((r) => r.method === 'eth_getLogs');
    expect(logCalls).toHaveLength(2 * Math.ceil(a.tokens().length / LOG_ADDRESSES));
    expect(seen.filter((b) => b.some((r) => r.method === 'eth_getLogs')).length).toBeLessThanOrEqual(Math.ceil(logCalls.length / BALANCE_BATCH));
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ direction: 'in', amount: 5n, assetId: a.tokens()[0]!.id, counterparty: '0x0000000000000000000000000000000000000aBc' });
  });
});
