// SPDX-License-Identifier: GPL-3.0-or-later
// `name.eth` to an address: ENS registry, then the name's resolver, read with `eth_call` from the
// Ethereum node Kyro already uses. Names are normalized per ENSIP-15 (viem's `normalize`, which is
// @adraffy/ens-normalize, the reference library).
//
// No CCIP-read: a name that answers OffchainLookup would send Kyro to any URL its owner chose,
// outside the host allowlist, so it is refused. The node is trusted for this answer like it is for
// a balance; that is why the review and the native window show the address, not the name.

import { decodeAbiParameters, encodeFunctionData, getAddress, parseAbi, type Hex } from 'viem';
import { namehash, normalize } from 'viem/ens';
import { JsonRpcError } from '@kyro/shared';

/** The ENS registry: same address on mainnet and Sepolia. */
export const ENS_REGISTRY = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e';
/** `OffchainLookup(address,string[],bytes,bytes4,bytes)`: the CCIP-read revert. */
const OFFCHAIN_LOOKUP = '0x556f1830';

const ABI = parseAbi(['function resolver(bytes32 node) view returns (address)', 'function addr(bytes32 node) view returns (address)', 'function addr(bytes32 node, uint256 coinType) view returns (bytes)']);

export type EnsRpc = (method: string, params: unknown[]) => Promise<unknown>;
export type EnsResult = { kind: 'ok'; name: string; address: string } | { kind: 'notFound' } | { kind: 'offchain' };

/** True for what the recipient field should look up: something ending in `.eth`, not an address. */
export function looksLikeEnsName(input: string): boolean {
  const s = input.trim();
  return s.length > 4 && s.length <= 255 && !/\s/.test(s) && s.toLowerCase().endsWith('.eth');
}

/** The ENSIP-15 form of `name`, or null if it is not a valid name. */
export function normalizeEnsName(name: string): string | null {
  try {
    return normalize(name.trim());
  } catch {
    return null;
  }
}

function isOffchainLookup(e: unknown): boolean {
  if (!(e instanceof JsonRpcError)) return false;
  const data = typeof e.data === 'string' ? e.data : '';
  return data.startsWith(OFFCHAIN_LOOKUP) || e.message.includes('OffchainLookup');
}

function isRevert(e: unknown): boolean {
  return e instanceof JsonRpcError && (e.code === 3 || /revert/i.test(e.message));
}

/** 20 bytes in, a checksummed address out; nothing for an empty record or the zero address. */
function usable(bytes: Hex): string | null {
  if (!/^0x[0-9a-f]{40}$/i.test(bytes) || /^0x0{40}$/.test(bytes)) return null;
  return getAddress(bytes);
}

/** ENSIP-11: the coin type of an EVM chain other than Ethereum. */
function chainCoin(chainId: number): bigint {
  return 0x80000000n | BigInt(chainId);
}

/**
 * Resolves `name` for a send on `targetChainId`, reading from the Ethereum chain `ensChainId`. All
 * reads are pinned to one block, and the node must be on the right chain. Throws on a node failure.
 */
export async function resolveEns(rpc: EnsRpc, name: string, ensChainId: number, targetChainId: number): Promise<EnsResult> {
  const normalized = normalizeEnsName(name);
  if (normalized === null) return { kind: 'notFound' };
  if (Number(await rpc('eth_chainId', [])) !== ensChainId) throw new Error('ENS: wrong chain');
  const block = await rpc('eth_blockNumber', []);
  const read = (to: string, data: Hex) => rpc('eth_call', [{ to, data }, block]) as Promise<Hex>;
  const node = namehash(normalized);

  const raw = await read(ENS_REGISTRY, encodeFunctionData({ abi: ABI, functionName: 'resolver', args: [node] }));
  if (raw === '0x') return { kind: 'notFound' };
  const [resolver] = decodeAbiParameters([{ type: 'address' }], raw);
  if (/^0x0{40}$/.test(resolver)) return { kind: 'notFound' };
  if (((await rpc('eth_getCode', [resolver, block])) as string).length <= 2) return { kind: 'notFound' };

  try {
    // A name can hold another address for this chain: a wallet that only exists there, or not on
    // Ethereum. It wins over the Ethereum record.
    if (targetChainId !== ensChainId) {
      try {
        const out = await read(resolver, encodeFunctionData({ abi: ABI, functionName: 'addr', args: [node, chainCoin(targetChainId)] }));
        const [bytes] = out === '0x' ? ['0x' as Hex] : decodeAbiParameters([{ type: 'bytes' }], out);
        const address = usable(bytes);
        if (address) return { kind: 'ok', name: normalized, address };
      } catch (e) {
        if (isOffchainLookup(e) || !isRevert(e)) throw e;
      }
    }
    const out = await read(resolver, encodeFunctionData({ abi: ABI, functionName: 'addr', args: [node] }));
    if (out === '0x') return { kind: 'notFound' };
    const [addr] = decodeAbiParameters([{ type: 'address' }], out);
    const address = usable(addr);
    return address ? { kind: 'ok', name: normalized, address } : { kind: 'notFound' };
  } catch (e) {
    if (isOffchainLookup(e)) return { kind: 'offchain' };
    if (isRevert(e)) return { kind: 'notFound' };
    throw e;
  }
}

