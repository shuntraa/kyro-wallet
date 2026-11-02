// Hedera USDC (HTS): registry IDs, balances of associated known tokens, the checks the adapter
// makes on what Rust built (association, token transfer), history rows of known tokens.
import { describe, expect, it } from 'vitest';
import type { HbarBuilt, HbarContext, HbarHistoryEntry, HbarOwnAccount, HbarTxSummary } from '@kyro/shared';
import { HBAR_TOKENS, HbarAdapter, findAsset, hbarChain, type HbarBackend } from '../src';

const EVM = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const USDC = '0.0.456858';

const me: HbarOwnAccount = { exists: true, accountId: '0.0.5005', evmAddress: EVM.toLowerCase(), balance: '1000000000', hollow: false, deleted: false, receiverSigRequired: false, foundBy: 'alias', maxAutoAssociations: -1, address: EVM, accountIdChecksum: null };
const ctx: HbarContext = { account: me, recipient: me, createsAccount: false, token: null };

function summary(over: Partial<HbarTxSummary> = {}): HbarTxSummary {
  return { from: '0.0.5005', to: '0.0.7007', toIsEvm: false, amount: '0', maxFee: '6961687', memo: null, memoHex: null, transactionId: '0.0.5005@1.000000001', mirrorTransactionId: '0.0.5005-1-000000001', validStart: 1, validDuration: 180, nodes: ['0.0.3'], warnings: [], requiresExtraConfirmation: false, token: null, ...over };
}

function backend(make?: (kind: 'assoc' | 'token', to: string, amount: string) => HbarTxSummary): HbarBackend {
  const wrap = (s: HbarTxSummary): HbarBuilt => ({ bodies: ['00'], summary: s, context: ctx });
  return {
    account: async () => me,
    recipient: async () => {
      throw new Error('unused');
    },
    txs: async () => [],
    build: async () => {
      throw new Error('no HBAR here');
    },
    sign: async () => {
      throw new Error('unused');
    },
    broadcast: async () => '',
    txStatus: async () => ({ found: false, result: '' }),
    tokenHoldings: async () => [
      { tokenId: USDC, associated: true, balance: '12500000', frozen: false },
      { tokenId: '0.0.731861', associated: true, balance: '5', frozen: false },
    ],
    buildAssociate: async () => wrap(make ? make('assoc', '0.0.5005', '0') : summary({ to: '0.0.5005', token: { tokenId: USDC, symbol: 'USDC', name: 'USD Coin', decimals: 6, associate: true } })),
    buildToken: async (_id, to, amount) => wrap(make ? make('token', to, amount) : summary({ to, amount, token: { tokenId: USDC, symbol: 'USDC', name: 'USD Coin', decimals: 6, associate: false } })),
  };
}

const adapter = (b: HbarBackend) => new HbarAdapter({ chain: hbarChain('mainnet'), address: EVM, backend: b });

describe('Hedera USDC', () => {
  it('registry: Circle USDC on mainnet and testnet', () => {
    expect(HBAR_TOKENS.mainnet.map((t) => [t.symbol, t.contract, t.decimals])).toEqual([['USDC', '0.0.456858', 6]]);
    expect(HBAR_TOKENS.testnet.map((t) => t.contract)).toEqual(['0.0.429274']);
    expect(findAsset('mainnet', `hts:${USDC}`)).toMatchObject({ family: 'hbar', kind: 'hts', symbol: 'USDC' });
  });

  it('balances: HBAR then associated known tokens', async () => {
    const b = await adapter(backend()).getBalance();
    expect(b.map((x) => [x.assetId, x.amount])).toEqual([['hbar', 1_000_000_000n], [`hts:${USDC}`, 12_500_000n]]);
  });

  it('association and token transfer are checked against what Rust decoded', async () => {
    const u = await adapter(backend()).buildAssociate(USDC);
    expect(u.summary.token?.associate).toBe(true);
    await expect(adapter(backend()).buildAssociate('0.0.731861')).rejects.toThrow();
    const lying = backend(() => summary({ to: '0.0.7007', token: { tokenId: USDC, symbol: 'USDC', name: 'USD Coin', decimals: 6, associate: true } }));
    await expect(adapter(lying).buildAssociate(USDC)).rejects.toThrow();
    const asset = findAsset('mainnet', `hts:${USDC}`)!;
    const t = await adapter(backend()).buildTx({ asset, to: '0.0.7007', amount: 2_000_000n, fee: { family: 'hbar' } } as never);
    expect([t.amount, t.summary.token?.tokenId]).toEqual([2_000_000n, USDC]);
    const max = await adapter(backend()).buildTx({ asset, to: '0.0.7007', amount: 0n, max: true, fee: { family: 'hbar' } } as never);
    expect(max.amount).toBe(12_500_000n);
    const hbarInstead = backend((_k, to, amount) => summary({ to, amount, token: null }));
    await expect(adapter(hbarInstead).buildTx({ asset, to: '0.0.7007', amount: 1n, fee: { family: 'hbar' } } as never)).rejects.toThrow();
  });

  it('history: a row per known token change, beside the HBAR fee row', async () => {
    const rows: HbarHistoryEntry[] = [
      { id: '0.0.9-1-1', name: 'CRYPTOTRANSFER', result: 'SUCCESS', time: 2000, fee: '0', memo: null, delta: '0', amount: '0', counterparty: '0.0.9', outgoing: false, tokenTransfers: [{ tokenId: USDC, delta: '3000000' }, { tokenId: '0.0.731861', delta: '1' }] },
      { id: '0.0.5005-1-2', name: 'TOKENASSOCIATE', result: 'SUCCESS', time: 1000, fee: '5000000', memo: null, delta: '-5000000', amount: '0', counterparty: null, outgoing: true, tokenTransfers: [] },
    ];
    const b = backend();
    b.txs = async () => rows;
    const h = await adapter(b).getHistory();
    const usdc = h.filter((x) => x.assetId === `hts:${USDC}`);
    expect(usdc.map((x) => [x.direction, x.amount])).toEqual([['in', 3_000_000n]]);
    expect(h.some((x) => x.assetId.includes('731861'))).toBe(false);
    expect(h.find((x) => x.id === '0.0.5005-1-2')?.note).toMatch(/ssociat/i);
  });
});
