import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, keccak256, toHex, type Hex } from 'viem';
import { namehash } from 'viem/ens';
import { JsonRpcError } from '@kyro/shared';
import { ENS_REGISTRY, looksLikeEnsName, normalizeEnsName, resolveEns, type EnsRpc } from '../src/evm/ens';

const RESOLVER = '0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63';
const OWNER = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const OTHER = '0x1111111111111111111111111111111111111111';
const ZERO = `0x${'0'.repeat(40)}`;
const word = (a: string) => encodeAbiParameters([{ type: 'address' }], [a as Hex]);
const bytes = (a: Hex) => encodeAbiParameters([{ type: 'bytes' }], [a]);
const selector = (sig: string) => keccak256(toHex(sig)).slice(0, 10);

interface Node {
  chainId?: number;
  resolver?: string;
  code?: string;
  addr?: () => Hex;
  addrCoin?: () => Hex;
}

function fakeNode(n: Node): { rpc: EnsRpc; calls: Array<{ to: string; block: unknown }> } {
  const calls: Array<{ to: string; block: unknown }> = [];
  const rpc: EnsRpc = async (method, params) => {
    if (method === 'eth_chainId') return toHex(n.chainId ?? 1);
    if (method === 'eth_blockNumber') return '0x10';
    if (method === 'eth_getCode') return n.code ?? '0x6000';
    if (method !== 'eth_call') throw new Error(method);
    const [{ to, data }, block] = params as [{ to: string; data: string }, unknown];
    calls.push({ to, block });
    if (to === ENS_REGISTRY) return word(n.resolver ?? RESOLVER);
    if (data.startsWith(selector('addr(bytes32,uint256)'))) return n.addrCoin ? n.addrCoin() : '0x';
    return n.addr ? n.addr() : word(OWNER);
  };
  return { rpc, calls };
}

describe('ENS names', () => {
  it('looks up only what ends in .eth', () => {
    expect(looksLikeEnsName(' vitalik.eth ')).toBe(true);
    expect(looksLikeEnsName('Vitalik.ETH')).toBe(true);
    for (const s of ['', '.eth', 'vitalik', 'vitalik.com', 'a b.eth', OWNER]) expect(looksLikeEnsName(s), s).toBe(false);
  });

  it('normalizes per ENSIP-15 and refuses confusing names', () => {
    expect(normalizeEnsName('VITALIK.eth')).toBe('vitalik.eth');
    // Cyrillic а mixed with Latin: a lookalike, refused by the normalizer.
    expect(normalizeEnsName('vitаlik.eth')).toBeNull();
    expect(normalizeEnsName('a‍b.eth')).toBeNull();
    expect(namehash('vitalik.eth')).toBe('0xee6c4522aab0003e8d14cd40a6af439055fd2577951148c14b6cea9a53475835');
  });

  it('reads the registry, then the resolver, on one block', async () => {
    const { rpc, calls } = fakeNode({});
    await expect(resolveEns(rpc, 'VITALIK.eth', 1, 1)).resolves.toEqual({ kind: 'ok', name: 'vitalik.eth', address: OWNER });
    expect(calls.map((c) => c.to)).toEqual([ENS_REGISTRY, RESOLVER]);
    expect(calls.every((c) => c.block === '0x10')).toBe(true);
  });

  it('refuses a node on another chain', async () => {
    await expect(resolveEns(fakeNode({ chainId: 56 }).rpc, 'vitalik.eth', 1, 1)).rejects.toThrow('wrong chain');
  });

  it('finds nothing without a resolver, without code, or with an empty record', async () => {
    const none = { kind: 'notFound' };
    await expect(resolveEns(fakeNode({ resolver: ZERO }).rpc, 'nobody.eth', 1, 1)).resolves.toEqual(none);
    await expect(resolveEns(fakeNode({ code: '0x' }).rpc, 'nobody.eth', 1, 1)).resolves.toEqual(none);
    await expect(resolveEns(fakeNode({ addr: () => word(ZERO) }).rpc, 'nobody.eth', 1, 1)).resolves.toEqual(none);
    await expect(resolveEns(fakeNode({ addr: () => '0x' }).rpc, 'nobody.eth', 1, 1)).resolves.toEqual(none);
  });

  it('never follows CCIP-read', async () => {
    const addr = () => {
      throw new JsonRpcError(3, 'execution reverted', '0x556f1830aabb');
    };
    await expect(resolveEns(fakeNode({ addr }).rpc, 'offchain.eth', 1, 1)).resolves.toEqual({ kind: 'offchain' });
  });

  it('prefers the record of the target chain (ENSIP-11)', async () => {
    const onBase = fakeNode({ addrCoin: () => bytes(OTHER) });
    await expect(resolveEns(onBase.rpc, 'vitalik.eth', 1, 8453)).resolves.toMatchObject({ address: OTHER });
    await expect(resolveEns(fakeNode({}).rpc, 'vitalik.eth', 1, 8453)).resolves.toMatchObject({ address: OWNER });
    const reverting = fakeNode({
      addrCoin: () => {
        throw new JsonRpcError(3, 'execution reverted');
      },
    });
    await expect(resolveEns(reverting.rpc, 'vitalik.eth', 1, 8453)).resolves.toMatchObject({ address: OWNER });
  });

  it('lets a node failure through', async () => {
    const addr = () => {
      throw new Error('timeout');
    };
    await expect(resolveEns(fakeNode({ addr }).rpc, 'vitalik.eth', 1, 1)).rejects.toThrow('timeout');
  });

  // KYRO_ENS_LIVE=1: the real registry, from a public node.
  it.skipIf(!process.env.KYRO_ENS_LIVE)('resolves a real name', { timeout: 30_000 }, async () => {
    const rpc: EnsRpc = async (method, params) => {
      const res = await fetch('https://ethereum-rpc.publicnode.com', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const j = (await res.json()) as { result?: unknown; error?: { code: number; message: string; data?: unknown } };
      if (j.error) throw new JsonRpcError(j.error.code, j.error.message, j.error.data);
      return j.result;
    };
    await expect(resolveEns(rpc, 'vitalik.eth', 1, 1)).resolves.toEqual({ kind: 'ok', name: 'vitalik.eth', address: OWNER });
    await expect(resolveEns(rpc, 'vitalik.eth', 1, 8453)).resolves.toMatchObject({ kind: 'ok' });
    await expect(resolveEns(rpc, 'kyro-no-such-name-4821.eth', 1, 1)).resolves.toEqual({ kind: 'notFound' });
  });
});
