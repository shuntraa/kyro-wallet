// Token sends from hardware accounts, adapter side: what the device can show decides what the
// adapter accepts; Rust's hw_* builders are stubbed (their signing is covered by replay tests).
import { describe, expect, it } from 'vitest';
import { TON_JETTONS, TonAdapter, tonChain, type BuildParams, type TonBackend, type TonContext, type TonTxSummary } from '../src';

const HW = { accountId: 'acc', device: 'ledger' as const };

describe('TON jettons on a Ledger', () => {
  const me = 'EQBm--PFwDv1yCeS-QTJ-L8oiUpqo9IT1BwgVptlSq3ts90Q';
  const to = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs';
  const usdt = TON_JETTONS.mainnet[0]!;
  const params = (memo?: string): BuildParams =>
    ({ to, amount: 1_000_000n, asset: { kind: 'jetton', contract: usdt.contract, decimals: usdt.decimals, symbol: usdt.symbol }, memo, fee: { family: 'ton' } }) as unknown as BuildParams;
  const backend = (calls: unknown[][]): TonBackend =>
    ({
      buildJetton: (master: string, dest: string, amount: string, comment?: string) => {
        calls.push([master, dest, amount, comment]);
        return Promise.resolve({
          boc: 'boc',
          summary: { jetton: { master, decimals: usdt.decimals, amount, recipient: dest }, wallet: me, sendAll: false, requiresExtraConfirmation: false, amount: '50000000' } as unknown as TonTxSummary,
          context: { fee: '1000' } as unknown as TonContext,
        });
      },
    }) as unknown as TonBackend;

  it('builds through the backend without a comment', async () => {
    const calls: unknown[][] = [];
    const a = new TonAdapter({ chain: tonChain('mainnet'), address: me, hw: HW, backend: backend(calls) });
    const u = await a.buildTx(params());
    expect(calls).toEqual([[usdt.contract, to, '1000000', undefined]]);
    expect(u.amount).toBe(1_000_000n);
  });

  it('refuses a comment the device cannot show', async () => {
    const calls: unknown[][] = [];
    const a = new TonAdapter({ chain: tonChain('mainnet'), address: me, hw: HW, backend: backend(calls) });
    await expect(a.buildTx(params('hello'))).rejects.toThrow(/comment|commentaire/i);
    expect(calls).toEqual([]);
  });
});
