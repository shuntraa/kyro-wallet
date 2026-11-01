// Algorand tokens (ASA): registry ids, balances of enabled tokens only, the opt-in and token
// transfer checks the adapter makes on what Rust built, history rows of known assets.
import { describe, expect, it } from 'vitest';
import type { AlgoAccountInfo, AlgoBuilt, AlgoHistoryEntry, AlgoHolding, AlgoTxSummary } from '@kyro/shared';
import { ALGO_ASSETS, AlgorandAdapter, algorandChain, assetsFor, findAsset, type AlgoBackend } from '../src';

const ME = 'BX63ZW4O5PWWFDH3J33QEB5YN7IN5XOKPDUQ5DCZ232EDY4DWN3XKUQRCA';
const OTHER = 'PNWOET7LLOWMBMLE4KOCELCX6X3D3Q4H2Q4QJASYIEOF7YIPPQBG3YQ5YI';
const USDC = 31566704;
const USDT = 312769;

const account: AlgoAccountInfo = { address: ME, exists: true, balance: '5000000', minBalance: '200000', spendable: '4800000', assets: 1, authAddr: null, round: 1 };

function summary(over: Partial<AlgoTxSummary> = {}): AlgoTxSummary {
  return { sender: ME, receiver: ME, amount: '0', fee: '1000', firstValid: 1, lastValid: 201, genesisId: 'mainnet-v1.0', genesisHash: 'x', noteLen: 0, noteHex: null, noteText: null, txid: 'T'.repeat(52), warnings: [], requiresExtraConfirmation: false, asset: { assetId: USDC, symbol: 'USDC', name: 'USD Coin', decimals: 6, amount: '0', optIn: true }, ...over };
}

function backend(over: Partial<AlgoBackend> = {}, built?: (assetId: number, to: string, amount: string) => AlgoTxSummary): AlgoBackend {
  const ctx = { account, destination: account, round: 1 };
  const wrap = (s: AlgoTxSummary): AlgoBuilt => ({ blob: '00', summary: s, context: ctx });
  return {
    account: async () => account,
    txs: async () => [],
    build: async () => {
      throw new Error('no ALGO payment here');
    },
    sign: async () => ({ blob: '00', txid: 'T'.repeat(52), summary: summary(), context: ctx }),
    broadcast: async () => 'T'.repeat(52),
    txStatus: async () => ({ confirmed: true, round: 2, error: null }),
    holdings: async (): Promise<AlgoHolding[]> => [
      { assetId: USDC, optedIn: true, amount: '12500000', frozen: false },
      { assetId: USDT, optedIn: false, amount: '0', frozen: false },
      { assetId: 1234, optedIn: true, amount: '99', frozen: false },
    ],
    buildOptIn: async (id) => wrap(built ? built(id, ME, '0') : summary({ asset: { assetId: id, symbol: 'USDC', name: 'USD Coin', decimals: 6, amount: '0', optIn: true } })),
    buildAsset: async (id, to, amount) => wrap(built ? built(id, to, amount) : summary({ receiver: to, asset: { assetId: id, symbol: 'USDT', name: 'Tether', decimals: 6, amount, optIn: false } })),
    ...over,
  };
}

const adapter = (b: AlgoBackend) => new AlgorandAdapter({ chain: algorandChain('mainnet'), address: ME, backend: b });

describe('Algorand tokens', () => {
  it('registry: USDC 31566704 and USD₮ 312769 on mainnet, Circle test USDC on testnet', () => {
    expect(ALGO_ASSETS.mainnet.map((t) => [t.symbol, t.contract, t.decimals])).toEqual([['USDC', '31566704', 6], ['USDT', '312769', 6]]);
    expect(ALGO_ASSETS.testnet.map((t) => t.contract)).toEqual(['10458941']);
    expect(findAsset('mainnet', 'asa:31566704')).toMatchObject({ family: 'algo', kind: 'asa', symbol: 'USDC', chainKey: 'algorand' });
    expect(assetsFor('testnet').some((a) => a.id === 'asa:31566704')).toBe(false);
  });

  it('balances: ALGO, then enabled known tokens only', async () => {
    const b = await adapter(backend()).getBalance();
    expect(b.map((x) => [x.assetId, x.amount])).toEqual([['algo', 5_000_000n], ['asa:31566704', 12_500_000n]]);
  });

  it('opt-in: Rust must build exactly a 0-unit transfer of that token to ourselves', async () => {
    const u = await adapter(backend()).buildOptIn(USDC);
    expect(u.summary.asset?.optIn).toBe(true);
    expect(u.recipient).toBe(ME);
    await expect(adapter(backend()).buildOptIn(1234)).rejects.toThrow(/inconnu|Unknown/);
    const lying = backend({}, () => summary({ receiver: OTHER }));
    await expect(adapter(lying).buildOptIn(USDC)).rejects.toThrow();
    const otherAsset = backend({}, () => summary({ asset: { assetId: USDT, symbol: 'USDT', name: 'Tether', decimals: 6, amount: '0', optIn: true } }));
    await expect(adapter(otherAsset).buildOptIn(USDC)).rejects.toThrow();
  });

  it('token transfer: amount in token units, checked against what Rust decoded', async () => {
    const asset = findAsset('mainnet', 'asa:312769')!;
    const u = await adapter(backend()).buildTx({ asset, to: OTHER, amount: 2_000_000n, fee: { family: 'algo' } } as never);
    expect([u.amount, u.recipient, u.summary.asset?.amount]).toEqual([2_000_000n, OTHER, '2000000']);
    const max = await adapter(backend({}, (id, to) => summary({ receiver: to, asset: { assetId: id, symbol: 'USDC', name: 'USD Coin', decimals: 6, amount: '12500000', optIn: false } }))).buildTx({ asset: findAsset('mainnet', 'asa:31566704')!, to: OTHER, amount: 0n, max: true, fee: { family: 'algo' } } as never);
    expect(max.amount).toBe(12_500_000n);
    const wrongAmount = backend({}, (id, to) => summary({ receiver: to, asset: { assetId: id, symbol: 'USDT', name: 'Tether', decimals: 6, amount: '1', optIn: false } }));
    await expect(adapter(wrongAmount).buildTx({ asset, to: OTHER, amount: 2_000_000n, fee: { family: 'algo' } } as never)).rejects.toThrow();
    await expect(adapter(backend()).buildTx({ asset, to: ME, amount: 1n, fee: { family: 'algo' } } as never)).rejects.toThrow();
  });

  it('history: known asset transfers and opt-ins, unknown assets left as contract rows', async () => {
    const rows: AlgoHistoryEntry[] = [
      { id: 'A', type: 'axfer', from: OTHER, to: ME, amount: '0', fee: '1000', closeTo: null, closeAmount: null, round: 3, time: 3, note: null, assetId: USDC, assetAmount: '5000000' },
      { id: 'B', type: 'axfer', from: ME, to: ME, amount: '0', fee: '1000', closeTo: null, closeAmount: null, round: 2, time: 2, note: null, assetId: USDT, assetAmount: '0' },
      { id: 'C', type: 'axfer', from: OTHER, to: ME, amount: '0', fee: '1000', closeTo: null, closeAmount: null, round: 1, time: 1, note: null, assetId: 1234, assetAmount: '9' },
    ];
    const h = await adapter(backend({ txs: async () => rows })).getHistory();
    expect(h.map((x) => [x.assetId, x.direction, x.amount])).toEqual([
      ['asa:31566704', 'in', 5_000_000n],
      ['asa:312769', 'self', 0n],
      ['algo', 'in', 0n],
    ]);
    expect(h[1]!.note).toMatch(/USDT/);
  });
});
