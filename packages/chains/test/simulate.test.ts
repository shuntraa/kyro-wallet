// Dry run before signing: reading what moves, approvals, warnings, and honest failure modes.
import { describe, expect, it } from 'vitest';
import { JsonRpcError } from '@kyro/shared';
import { encodeFunctionData, erc20Abi, maxUint256, parseAbi, type Hex } from 'viem';
import { approvalsOfCalldata, isMethodMissing, readTrace, simulateCall, type SimBackend, type SimCall, type SimContext, type SimLog, type SimTrace } from '../src/evm/simulate';

const ME = '0x1111111111111111111111111111111111111111';
const ROUTER = '0x2222222222222222222222222222222222222222';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const SCAM = '0x3333333333333333333333333333333333333333';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const APPROVAL = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';
const NATIVE_LOG = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const topic = (a: string) => `0x${a.slice(2).padStart(64, '0')}`;
const amount = (v: bigint) => `0x${v.toString(16).padStart(64, '0')}`;
const transfer = (token: string, from: string, to: string, v: bigint): SimLog => ({ address: token, topics: [TRANSFER, topic(from), topic(to)], data: amount(v) });
const call: SimCall = { from: ME, to: ROUTER, data: '0x12345678', value: 0n };
const ctx: SimContext = {
  knownContracts: new Set([ROUTER, USDC]),
  knownTokens: new Map([[USDC, { symbol: 'USDC', decimals: 6 }]]),
  native: { symbol: 'ETH', decimals: 18 },
  blockTimeSecs: 12,
};

function backend(over: Partial<SimBackend> = {}): SimBackend {
  return {
    simulateV1: async () => ({ logs: [], internal: [] }),
    traceCall: async () => null,
    ethCall: async () => undefined,
    estimateGas: async () => 21_000n,
    code: async () => '0x6080',
    tokenInfo: async () => ({ symbol: 'SCAM', decimals: 18 }),
    ...over,
  };
}
const missing = () => Promise.reject(new JsonRpcError(-32601, 'the method debug_traceCall does not exist/is not available'));
const reverted = () => Promise.reject(new JsonRpcError(3, 'execution reverted: STF'));

describe('reading a trace', () => {
  it('nets each asset: what goes out and what comes back', () => {
    const trace: SimTrace = {
      logs: [transfer(USDC, ME, ROUTER, 100n), transfer(USDC, ROUTER, ME, 30n), transfer(SCAM, ROUTER, ME, 7n), transfer(USDC, ROUTER, SCAM, 999n)],
      internal: [],
    };
    const r = readTrace(trace, call);
    expect(r.sends.get(USDC)).toBe(70n);
    expect(r.receives.get(SCAM)).toBe(7n);
    expect(r.approvals).toEqual([]);
  });

  it('counts the value of the call once, with eth_simulateV1 native logs', () => {
    const c = { ...call, value: 5n };
    const r = readTrace({ logs: [transfer(NATIVE_LOG, ME, ROUTER, 5n), transfer(NATIVE_LOG, ROUTER, ME, 2n)], internal: [] }, c);
    expect(r.sends.get('native')).toBe(3n);
  });

  it('counts native refunds from a debug trace', () => {
    const r = readTrace({ logs: [], internal: [{ from: ROUTER, to: ME, value: 2n }] }, { ...call, value: 5n });
    expect(r.sends.get('native')).toBe(3n);
  });

  it('reads approvals from our address only', () => {
    const mine: SimLog = { address: USDC, topics: [APPROVAL, topic(ME), topic(ROUTER)], data: amount(9n) };
    const other: SimLog = { address: USDC, topics: [APPROVAL, topic(SCAM), topic(ROUTER)], data: amount(9n) };
    expect(readTrace({ logs: [mine, other], internal: [] }, call).approvals).toEqual([{ token: USDC, spender: ROUTER, amount: 9n, all: false }]);
  });

  it('ignores an NFT transfer rather than reading its id as an amount', () => {
    const nft: SimLog = { address: SCAM, topics: [TRANSFER, topic(ME), topic(ROUTER), amount(5n)], data: '0x' };
    expect(readTrace({ logs: [nft], internal: [] }, call).sends.size).toBe(0);
  });
});

describe('approvals in the calldata', () => {
  const data = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [ROUTER, 42n] });
  it('finds approve, increaseAllowance and setApprovalForAll', () => {
    expect(approvalsOfCalldata({ to: USDC, data })).toEqual([{ token: USDC, spender: ROUTER, amount: 42n, all: false }]);
    const inc = encodeFunctionData({ abi: parseAbi(['function increaseAllowance(address, uint256)']), args: [ROUTER, 1n] });
    expect(approvalsOfCalldata({ to: USDC, data: inc })[0]?.amount).toBe(1n);
    const forAll = (on: boolean): Hex => encodeFunctionData({ abi: parseAbi(['function setApprovalForAll(address, bool)']), args: [ROUTER, on] });
    expect(approvalsOfCalldata({ to: SCAM, data: forAll(true) })[0]?.all).toBe(true);
    expect(approvalsOfCalldata({ to: SCAM, data: forAll(false) })).toEqual([]);
  });
  it('sees nothing in another call', () => {
    expect(approvalsOfCalldata({ to: USDC, data: '0xdeadbeef' })).toEqual([]);
  });
});

describe('simulateCall', () => {
  it('reports a clean swap with amounts and names', async () => {
    const trace = { logs: [transfer(USDC, ME, ROUTER, 1_000_000n)], internal: [{ from: ROUTER, to: ME, value: 5n }] };
    const r = await simulateCall(backend({ simulateV1: async () => trace }), call, ctx);
    expect(r.status).toBe('traced');
    expect(r.gas).toBe(21_000n);
    expect(r.sends[0]).toMatchObject({ amount: 1_000_000n, asset: { symbol: 'USDC', decimals: 6, known: true } });
    expect(r.receives[0]).toMatchObject({ amount: 5n, asset: { symbol: 'ETH' } });
    expect(r.warnings).toEqual([]);
  });

  it('falls back to debug_traceCall, then to eth_call, and says what it could not see', async () => {
    const traced = await simulateCall(backend({ simulateV1: missing, traceCall: async () => ({ logs: [transfer(USDC, ME, ROUTER, 1n)], internal: [] }) }), call, ctx);
    expect(traced.status).toBe('traced');
    const blind = await simulateCall(backend({ simulateV1: missing, traceCall: missing }), { ...call, value: 9n }, ctx);
    expect(blind.status).toBe('checked');
    expect(blind.sends[0]?.amount).toBe(9n);
    expect(blind.receives).toEqual([]);
    expect(blind.warnings).not.toContain('nothing-back');
  });

  it('a revert is a failure with its reason, never a clean result', async () => {
    const r = await simulateCall(backend({ simulateV1: reverted, estimateGas: reverted }), call, ctx);
    expect(r.status).toBe('failed');
    expect(r.reason).toContain('STF');
    expect(r.warnings).toContain('fails');
    expect(r.sends).toEqual([]);
  });

  it('eth_estimateGas alone can reveal a failure the trace missed', async () => {
    const r = await simulateCall(backend({ estimateGas: () => Promise.reject(new JsonRpcError(-32000, 'insufficient funds for gas')) }), call, ctx);
    expect(r.status).toBe('failed');
    expect(r.reason).toContain('insufficient funds');
  });

  it('a node fault on eth_simulateV1 is not a revert: eth_call decides', async () => {
    const fault = () => Promise.reject(new JsonRpcError(-32603, 'global signer not initialized'));
    const missing = () => Promise.reject(new JsonRpcError(-32601, 'the method debug_traceCall does not exist'));
    const passes = await simulateCall(backend({ simulateV1: fault, traceCall: missing, ethCall: async () => {} }), call, ctx);
    expect(passes.status).toBe('checked');
    expect(passes.warnings).not.toContain('fails');
    const reverts = await simulateCall(backend({ simulateV1: fault, traceCall: missing, ethCall: () => Promise.reject(new JsonRpcError(3, 'execution reverted')) }), call, ctx);
    expect(reverts.status).toBe('failed');
    expect(reverts.reason).toContain('execution reverted');
  });

  it('a node that answers nothing is unavailable, not safe', async () => {
    const down = () => Promise.reject(new Error('network down'));
    const r = await simulateCall(backend({ simulateV1: down, traceCall: down, ethCall: down, estimateGas: down, code: down }), call, ctx);
    expect(r.status).toBe('unavailable');
    expect(r.warnings).not.toContain('fails');
  });

  it('warns on unknown, brand-new and missing contracts', async () => {
    const unknown = { ...call, to: SCAM };
    const fresh = await simulateCall(backend({ code: async (_a, ago) => (ago ? '0x' : '0x6080') }), unknown, ctx);
    expect(fresh.warnings).toEqual(expect.arrayContaining(['unknown-contract', 'new-contract']));
    const none = await simulateCall(backend({ code: async () => '0x' }), unknown, ctx);
    expect(none.warnings).toContain('not-contract');
    expect(none.warnings).not.toContain('unknown-contract');
  });

  it('claims no age when the node has pruned the old state', async () => {
    const r = await simulateCall(backend({ code: async (_a, ago) => (ago ? Promise.reject(new JsonRpcError(-32000, 'missing trie node')) : '0x6080') }), call, ctx);
    expect(r.warnings).not.toContain('new-contract');
  });

  it('warns on an unlimited approval, from the calldata even without a trace', async () => {
    const data = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [SCAM, maxUint256] });
    const r = await simulateCall(backend({ simulateV1: missing, traceCall: missing }), { ...call, to: USDC, data }, ctx);
    expect(r.approvals[0]).toMatchObject({ unlimited: true, spender: SCAM, asset: { symbol: 'USDC' } });
    expect(r.warnings).toContain('unlimited-approval');
  });

  it('an exact approval is shown without the warning', async () => {
    const data = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [ROUTER, 10n] });
    const r = await simulateCall(backend(), { ...call, to: USDC, data }, ctx);
    expect(r.approvals[0]).toMatchObject({ unlimited: false, amount: 10n });
    expect(r.warnings).not.toContain('unlimited-approval');
  });

  it('flags a token outside the list and funds that do not come back', async () => {
    const r = await simulateCall(backend({ simulateV1: async () => ({ logs: [transfer(SCAM, ME, ROUTER, 1n)], internal: [] }) }), call, ctx);
    expect(r.sends[0]?.asset).toMatchObject({ symbol: 'SCAM', known: false });
    expect(r.warnings).toEqual(expect.arrayContaining(['unknown-token', 'nothing-back']));
  });

  it('a token that hides its name still shows an address', async () => {
    const r = await simulateCall(backend({ tokenInfo: async () => null, simulateV1: async () => ({ logs: [transfer(SCAM, ROUTER, ME, 1n)], internal: [] }) }), call, ctx);
    expect(r.receives[0]?.asset.symbol).toMatch(/^0x33333/);
  });
});

describe('method missing', () => {
  it('tells a missing method from a revert', () => {
    expect(isMethodMissing(new JsonRpcError(-32601, 'Method not found'))).toBe(true);
    expect(isMethodMissing(new JsonRpcError(-32000, 'debug_traceCall is not available on this plan'))).toBe(true);
    expect(isMethodMissing(new JsonRpcError(3, 'execution reverted'))).toBe(false);
    expect(isMethodMissing(new Error('network'))).toBe(false);
  });
});
