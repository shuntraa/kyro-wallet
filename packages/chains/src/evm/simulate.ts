// SPDX-License-Identifier: GPL-3.0-or-later
// Dry run of an EVM call before signing, through the chain's own RPC: no third-party service. It
// warns; it never proves safety: the decoded review and the native window stay the source of truth.

import { decodeFunctionData, erc20Abi, getAddress, maxUint256, parseAbi, type Hex } from 'viem';
import { JsonRpcError } from '@kyro/shared';

/** keccak256 of the event signatures read here. */
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const APPROVAL = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';
const APPROVAL_FOR_ALL = '0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31';
/** Where `eth_simulateV1` with `traceTransfers` reports native transfers. */
const NATIVE_LOG = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
/** Above this an approval counts as unlimited (wallets and dApps round `2^256 - 1` down). */
const UNLIMITED_FROM = maxUint256 / 2n;
const NEW_CONTRACT_DAYS = 7;

export interface SimCall {
  from: string;
  to: string;
  data: Hex;
  value: bigint;
}

export interface SimLog {
  address: string;
  topics: string[];
  data: string;
}

/** What a dry run saw, before tokens get their names. */
export interface SimTrace {
  logs: SimLog[];
  /** Native value moved by inner calls (`debug_traceCall` only). */
  internal: Array<{ from: string; to: string; value: bigint }>;
}

export interface SimAsset {
  /** Token contract, or `native`. */
  address: string;
  symbol: string;
  decimals: number;
  /** In Kyro's token list. */
  known: boolean;
}

export interface SimMove {
  asset: SimAsset;
  amount: bigint;
}

export interface SimApproval {
  asset: SimAsset;
  spender: string;
  amount: bigint;
  unlimited: boolean;
  /** `setApprovalForAll`: the spender can move every item of the collection. */
  all: boolean;
}

export type SimWarning = 'fails' | 'unknown-contract' | 'new-contract' | 'not-contract' | 'unlimited-approval' | 'unknown-token' | 'nothing-back';

export interface SimReport {
  /** `traced`: moves were measured. `checked`: the call passes but moves are unknown. `failed`: it would revert. `unavailable`: the node did not answer. */
  status: 'traced' | 'checked' | 'failed' | 'unavailable';
  reason?: string;
  gas?: bigint;
  sends: SimMove[];
  receives: SimMove[];
  approvals: SimApproval[];
  warnings: SimWarning[];
}

/** What the simulation needs from the chain: one method per RPC, so tests need no node. */
export interface SimBackend {
  /** `eth_simulateV1` with transfers, or `null` when the node does not offer it. Throws on a revert. */
  simulateV1(call: SimCall): Promise<SimTrace | null>;
  /** `debug_traceCall` with `callTracer`, or `null` when the node does not offer it. Throws on a revert. */
  traceCall(call: SimCall): Promise<SimTrace | null>;
  /** `eth_call`; throws on a revert. */
  ethCall(call: SimCall): Promise<void>;
  /** `eth_estimateGas`; throws on a revert. */
  estimateGas(call: SimCall): Promise<bigint>;
  /** `eth_getCode` now, or `blocksAgo` back. Throws when the node has no such history. */
  code(address: string, blocksAgo?: bigint): Promise<string>;
  /** Symbol and decimals of a token, read from the chain; `null` when it does not answer. */
  tokenInfo(address: string): Promise<{ symbol: string; decimals: number } | null>;
}

export interface SimContext {
  /** Lowercase addresses Kyro already knows (its tokens, pinned swap and Earn contracts). */
  knownContracts: ReadonlySet<string>;
  /** Tokens of Kyro's list, by lowercase address. */
  knownTokens: ReadonlyMap<string, { symbol: string; decimals: number }>;
  native: { symbol: string; decimals: number };
  blockTimeSecs: number;
}

const addressTopic = (t: string | undefined): string | null => (t && /^0x[0-9a-fA-F]{64}$/.test(t) ? `0x${t.slice(26).toLowerCase()}` : null);
const word = (data: string): bigint | null => (/^0x[0-9a-fA-F]{1,64}$/.test(data) ? BigInt(data) : null);

/** A JSON-RPC answer that means « no such method here », as opposed to a revert. */
export function isMethodMissing(e: unknown): boolean {
  if (!(e instanceof JsonRpcError)) return false;
  const m = e.message.toLowerCase();
  return e.code === -32601 || e.code === -32600 || /not (found|supported|available|allowed|exist)|unsupported|whitelist|disabled|unknown method/.test(m);
}

/**
 * JSON-RPC « internal error »: the node broke, it says nothing about the call (BSC's public node
 * answers `eth_simulateV1` with « global signer not initialized »). The next method decides, and
 * `eth_call` still reports a real revert.
 */
function isNodeFault(e: unknown): boolean {
  return e instanceof JsonRpcError && e.code === -32603;
}

/** Short reason of a failure, on one line. */
export function simFailure(e: unknown): string {
  const raw = e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : String(e);
  return (raw.split('\n')[0] ?? raw).slice(0, 160);
}

const APPROVE_ABI = parseAbi(['function increaseAllowance(address spender, uint256 amount)', 'function setApprovalForAll(address operator, bool approved)']);

/** Approvals asked by the calldata itself: known even when the node gives no trace. */
export function approvalsOfCalldata(call: Pick<SimCall, 'to' | 'data'>): Array<{ token: string; spender: string; amount: bigint; all: boolean }> {
  try {
    const d = decodeFunctionData({ abi: [...erc20Abi, ...APPROVE_ABI], data: call.data });
    const token = call.to.toLowerCase();
    if (d.functionName === 'approve' || d.functionName === 'increaseAllowance') {
      const [spender, amount] = d.args as readonly [string, bigint];
      return [{ token, spender: spender.toLowerCase(), amount, all: false }];
    }
    if (d.functionName === 'setApprovalForAll') {
      const [spender, on] = d.args as readonly [string, boolean];
      return on ? [{ token, spender: spender.toLowerCase(), amount: maxUint256, all: true }] : [];
    }
  } catch {
    /* Not one of these calls. */
  }
  return [];
}

interface RawMoves {
  sends: Map<string, bigint>;
  receives: Map<string, bigint>;
  approvals: Array<{ token: string; spender: string; amount: bigint; all: boolean }>;
}

/** Net effect on `me`: a token both sent and received counts once, on the side that wins. */
export function readTrace(trace: SimTrace, call: SimCall): RawMoves {
  const me = call.from.toLowerCase();
  const delta = new Map<string, bigint>();
  const add = (token: string, v: bigint) => delta.set(token, (delta.get(token) ?? 0n) + v);
  const approvals: RawMoves['approvals'] = [];
  if (call.value > 0n) add('native', -call.value);
  for (const l of trace.logs) {
    const token = l.address.toLowerCase();
    const topic = l.topics[0]?.toLowerCase();
    const a = addressTopic(l.topics[1]);
    const b = addressTopic(l.topics[2]);
    if (topic === TRANSFER && l.topics.length === 3 && a && b) {
      const v = word(l.data);
      if (v === null) continue;
      if (token === NATIVE_LOG) {
        // The top-level value is counted above, from the call itself.
        if (a === me && b === call.to.toLowerCase() && v === call.value) continue;
        if (a === me) add('native', -v);
        if (b === me) add('native', v);
      } else {
        if (a === me) add(token, -v);
        if (b === me) add(token, v);
      }
    } else if (topic === APPROVAL && a === me && b) {
      const v = word(l.data);
      if (v !== null) approvals.push({ token, spender: b, amount: v, all: false });
    } else if (topic === APPROVAL_FOR_ALL && a === me && b && word(l.data) === 1n) {
      approvals.push({ token, spender: b, amount: maxUint256, all: true });
    }
  }
  for (const m of trace.internal) {
    if (m.from.toLowerCase() === me) add('native', -m.value);
    if (m.to.toLowerCase() === me) add('native', m.value);
  }
  const sends = new Map<string, bigint>();
  const receives = new Map<string, bigint>();
  delta.forEach((v, k) => {
    if (v < 0n) sends.set(k, -v);
    else if (v > 0n) receives.set(k, v);
  });
  return { sends, receives, approvals };
}

/** Is `to` a contract, and how old? */
async function readContract(b: SimBackend, to: string, ctx: SimContext): Promise<SimWarning[]> {
  const code = await b.code(to).catch(() => null);
  if (code === null) return [];
  if (code === '0x' || code === '') return ['not-contract'];
  const out: SimWarning[] = [];
  const blocks = BigInt(Math.ceil((NEW_CONTRACT_DAYS * 86_400) / Math.max(1, ctx.blockTimeSecs)));
  // Pruned nodes refuse old state: the age is then simply unknown, nothing is claimed.
  const old = await b.code(to, blocks).catch(() => null);
  if (old === '0x' || old === '') out.push('new-contract');
  return out;
}

/** Runs every check the node allows. Never throws: a failed simulation is a report, not an error. */
export async function simulateCall(b: SimBackend, call: SimCall, ctx: SimContext): Promise<SimReport> {
  const to = call.to.toLowerCase();
  const warnings = new Set<SimWarning>();
  const known = ctx.knownContracts.has(to);
  const [contract, gasResult] = await Promise.all([
    readContract(b, to, ctx),
    b.estimateGas(call).then(
      (gas) => ({ gas }),
      (e: unknown) => ({ error: e }),
    ),
  ]);
  contract.forEach((w) => warnings.add(w));
  if (!known && !contract.includes('not-contract')) warnings.add('unknown-contract');

  let trace: SimTrace | null = null;
  let failure: string | null = null;
  let answered = false;
  for (const run of [b.simulateV1, b.traceCall]) {
    try {
      trace = await run.call(b, call);
      if (trace) {
        answered = true;
        break;
      }
    } catch (e) {
      if (isMethodMissing(e) || isNodeFault(e)) continue;
      if (e instanceof JsonRpcError) {
        answered = true;
        failure = simFailure(e);
        break;
      }
      // Network trouble on this method: try the next way.
    }
  }
  if (!trace && !failure) {
    try {
      await b.ethCall(call);
      answered = true;
    } catch (e) {
      if (e instanceof JsonRpcError || (e as { shortMessage?: string }).shortMessage) {
        answered = true;
        failure = simFailure(e);
      }
    }
  }
  // Reached only through `estimateGas`: a node may still refuse the call, say so.
  if (!failure && 'error' in gasResult && gasResult.error instanceof JsonRpcError && !isMethodMissing(gasResult.error)) {
    answered = true;
    failure = simFailure(gasResult.error);
  }

  const raw = trace ? readTrace(trace, call) : { sends: new Map<string, bigint>(call.value > 0n ? [['native', call.value]] : []), receives: new Map<string, bigint>(), approvals: [] };
  const fromData = approvalsOfCalldata(call);
  const approvals = [...raw.approvals];
  for (const a of fromData) if (!approvals.some((x) => x.token === a.token && x.spender === a.spender)) approvals.push(a);

  const infos = new Map<string, SimAsset>();
  const asset = async (address: string): Promise<SimAsset> => {
    const cached = infos.get(address);
    if (cached) return cached;
    const listed = address === 'native' ? ctx.native : ctx.knownTokens.get(address);
    const info = listed ?? (await b.tokenInfo(address).catch(() => null));
    const a: SimAsset = { address, symbol: info?.symbol ?? `${getAddress(address).slice(0, 8)}…`, decimals: info?.decimals ?? 18, known: !!listed };
    if (!listed) warnings.add('unknown-token');
    infos.set(address, a);
    return a;
  };
  const moves = async (m: Map<string, bigint>) => Promise.all([...m].map(async ([k, amount]) => ({ asset: await asset(k), amount })));
  const sends = await moves(raw.sends);
  const receives = await moves(raw.receives);
  const shown: SimApproval[] = await Promise.all(
    approvals.map(async (a) => {
      const unlimited = a.all || a.amount >= UNLIMITED_FROM;
      if (unlimited) warnings.add('unlimited-approval');
      return { asset: await asset(a.token), spender: a.spender, amount: a.amount, unlimited, all: a.all };
    }),
  );
  if (failure) warnings.add('fails');
  if (trace && !failure && sends.length > 0 && receives.length === 0 && shown.length === 0) warnings.add('nothing-back');

  const status = failure ? 'failed' : trace ? 'traced' : answered ? 'checked' : 'unavailable';
  return {
    status,
    ...(failure ? { reason: failure } : {}),
    ...('gas' in gasResult ? { gas: gasResult.gas } : {}),
    sends: status === 'failed' ? [] : sends,
    receives: status === 'failed' ? [] : receives,
    approvals: shown,
    warnings: [...warnings],
  };
}
