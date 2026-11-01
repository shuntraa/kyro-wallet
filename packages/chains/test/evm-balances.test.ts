// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { NetRequest, NetResponse } from '@kyro/shared';
import { BALANCE_BATCH, EvmAdapter, ERC20_TOKENS, evmChains } from '../src';

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

describe('soldes EVM par lots JSON-RPC', () => {
  it('un appel HTTP par lot, ids appariés, contrat absent ou en échec omis', async () => {
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

  it('repli appel par appel si le nœud refuse les lots', async () => {
    const n = node({ batches: false });
    const a = new EvmAdapter({ chain: eth, address: ME, fetch: n.fetch });
    const bal = await a.getBalance();
    expect(bal[0]?.amount).toBe(10n ** 18n);
    expect(bal.length).toBeGreaterThan(1);
    expect(n.seen.length).toBeGreaterThan(a.tokens().length);
  });

  it('repli aussi quand le lot revient avec une erreur par appel (offres gratuites)', async () => {
    const n = node({ batches: true, perItemErrors: true });
    const a = new EvmAdapter({ chain: eth, address: ME, fetch: n.fetch });
    const bal = await a.getBalance();
    expect(bal[0]?.amount).toBe(10n ** 18n);
    expect(bal.length).toBeGreaterThan(1);
  });
});
