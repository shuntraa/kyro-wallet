// Polkadot Asset Hub tokens: registry ids, balances, the checks the adapter makes on what Rust
// built (`Assets.transfer_keep_alive`), `max` = balance − the token's minimum balance.
import { describe, expect, it } from 'vitest';
import type { DotAccountInfo, DotContext, DotTxSummary } from '@kyro/shared';
import { DOT_ASSETS, PolkadotAdapter, findAsset, polkadotChain, type DotBackend } from '../src';

const ME = '13KVd4f2a4S5pLp4gTTFezyXdPWx27vQ9vS6xBXJ9yWVd7xo';
const OTHER = '12ES7PTE9a3DKbs9mCsRA6Wge2DS1XK1xFgbTkp47nPV53yG';

const acc: DotAccountInfo = { address: ME, exists: true, free: '10000000000', reserved: '0', frozen: '0', spendable: '9900000000', nonce: 1, existentialDeposit: '100000000' };
const ctx: DotContext = { account: acc, destination: { ...acc, address: OTHER }, existentialDeposit: '100000000', fee: '20000000', eraBirth: 1, validUntil: 257, finalized: 1, asset: null };

function summary(to: string, amount: string, over: Partial<DotTxSummary> = {}): DotTxSummary {
  return { chain: 'Polkadot Asset Hub', from: ME, to, amount, symbol: 'USDT', decimals: 6, call: 'Assets.transfer_keep_alive', nonce: 1, tip: '0', eraPeriod: 256, eraPhase: 1, blockHash: '00', specVersion: 1, txVersion: 1, asset: { assetId: 1984, symbol: 'USDT', name: 'Tether', decimals: 6 }, ...over };
}

function backend(make: (id: number, to: string, amount: string) => DotTxSummary = (_id, to, amount) => summary(to, amount)): DotBackend {
  return {
    account: async () => acc,
    build: async () => {
      throw new Error('no DOT here');
    },
    sign: async () => {
      throw new Error('unused');
    },
    broadcast: async () => '',
    txStatus: async () => ({ state: 'pending', finalized: 1 }),
    txs: async () => ({ available: false, partial: false, items: [] }),
    assetBalances: async () => [
      { assetId: 1984, balance: '5000000', frozen: false, minBalance: '10000' },
      { assetId: 1337, balance: '0', frozen: false, minBalance: '10000' },
      { assetId: 1985, balance: '7', frozen: false, minBalance: '1' },
    ],
    buildAsset: async (id, to, amount) => ({ payload: '00', summary: make(id, to, amount), context: ctx }),
  };
}

const adapter = (b: DotBackend) => new PolkadotAdapter({ chain: polkadotChain('mainnet'), address: ME, backend: b });
const USDT = () => findAsset('mainnet', 'dotasset:1984')!;

describe('Polkadot Asset Hub tokens', () => {
  it('registry: USD₮ 1984 and USDC 1337 on mainnet, none on Westend', () => {
    expect(DOT_ASSETS.mainnet.map((t) => [t.symbol, t.contract, t.decimals])).toEqual([['USDT', '1984', 6], ['USDC', '1337', 6]]);
    expect(DOT_ASSETS.testnet).toEqual([]);
    expect(USDT()).toMatchObject({ family: 'dot', kind: 'dotasset', symbol: 'USDT' });
  });

  it('balances: known tokens held, spendable keeps the minimum balance', async () => {
    const b = await adapter(backend()).getBalance();
    expect(b.map((x) => [x.assetId, x.amount, x.spendable])).toEqual([['dot', 10_000_000_000n, 9_900_000_000n], ['dotasset:1984', 5_000_000n, 4_990_000n]]);
  });

  it('transfer: checked against what Rust decoded; max leaves the minimum balance', async () => {
    const u = await adapter(backend()).buildTx({ asset: USDT(), to: OTHER, amount: 1_250_000n, fee: { family: 'dot' } } as never);
    expect([u.amount, u.summary.call]).toEqual([1_250_000n, 'Assets.transfer_keep_alive']);
    const max = await adapter(backend()).buildTx({ asset: USDT(), to: OTHER, amount: 0n, max: true, fee: { family: 'dot' } } as never);
    expect(max.amount).toBe(4_990_000n);
    const native = backend((_id, to, amount) => summary(to, amount, { call: 'Balances.transfer_keep_alive', asset: null }));
    await expect(adapter(native).buildTx({ asset: USDT(), to: OTHER, amount: 1n, fee: { family: 'dot' } } as never)).rejects.toThrow();
    const otherToken = backend((_id, to, amount) => summary(to, amount, { asset: { assetId: 1337, symbol: 'USDC', name: 'USD Coin', decimals: 6 } }));
    await expect(adapter(otherToken).buildTx({ asset: USDT(), to: OTHER, amount: 1n, fee: { family: 'dot' } } as never)).rejects.toThrow();
    await expect(adapter(backend()).buildTx({ asset: USDT(), to: ME, amount: 1n, fee: { family: 'dot' } } as never)).rejects.toThrow();
  });
});
