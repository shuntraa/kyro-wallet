// Token sends from hardware accounts, adapter side: what the device can show decides what the
// adapter accepts; Rust's hw_* builders are stubbed (their signing is covered by replay tests).
import { describe, expect, it } from 'vitest';
import { setBackend } from '@kyro/shared';
import { STELLAR_ASSETS, StellarAdapter, TON_JETTONS, TonAdapter, stellarChain, tonChain, type BuildParams, type StellarBackend, type TonBackend, type TonContext, type TonTxSummary } from '../src';
import { rustAlgoHwBackend } from '../src/algorand/adapter';
import { rustAptosHwBackend } from '../src/aptos/adapter';
import { rustNearHwBackend } from '../src/near/adapter';
import { rustSuiHwBackend } from '../src/sui/adapter';

const HW = { accountId: 'acc', device: 'ledger' as const };

describe('token builders of the Ledger backends', () => {
  it('go through the hw_* commands, with the account', async () => {
    const calls: Array<[string, unknown]> = [];
    setBackend(((cmd: string, args: unknown) => (calls.push([cmd, args]), Promise.resolve(null))) as never);
    await rustSuiHwBackend('acc').buildToken!('0xc::usdc::USDC', '0xb', 5n);
    await rustSuiHwBackend('acc').sign('bcs', 'dev', '0xc::usdc::USDC');
    await rustAptosHwBackend('acc').buildToken!('0xm', '0xb', '5');
    await rustNearHwBackend('acc').buildToken!('usdt.tether-token.near', 'bob.near', '5');
    await rustAlgoHwBackend('acc').buildOptIn!(31566704);
    await rustAlgoHwBackend('acc').buildAsset!(31566704, 'B', '5');
    expect(calls).toEqual([
      ['hw_sui_build_token_tx', { accountId: 'acc', coinType: '0xc::usdc::USDC', to: '0xb', amount: '5' }],
      ['hw_sign_sui_tx', { id: 'dev', accountId: 'acc', bcs: 'bcs', coinType: '0xc::usdc::USDC' }],
      ['hw_aptos_build_token_tx', { accountId: 'acc', metadata: '0xm', to: '0xb', amount: '5' }],
      ['hw_near_build_token_tx', { accountId: 'acc', contract: 'usdt.tether-token.near', to: 'bob.near', amount: '5' }],
      ['hw_algo_build_optin_tx', { accountId: 'acc', assetId: 31566704 }],
      ['hw_algo_build_asset_tx', { accountId: 'acc', assetId: 31566704, to: 'B', amount: '5' }],
    ]);
  });
});

describe('Stellar assets on a hardware wallet', () => {
  const me = 'GDVSYYTUAJ3ACHTPQNSTQBDQ4LDHQCMNY4FCEQH5TJUMSSLWQSTG42MV';
  const to = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
  const usdc = STELLAR_ASSETS.mainnet[0]!;
  const [code, issuer] = usdc.contract.split('-');
  const credit = { kind: 'credit', code, issuer };
  const summary = (operation: unknown) => ({ operation, memo: { kind: 'none' }, source: me, network: 'mainnet', fee: '100', warnings: [], requiresExtraConfirmation: false });
  const backend = (calls: unknown[][]): StellarBackend =>
    ({
      buildAsset: (asset: string, dest: string, amount: string) => {
        calls.push(['asset', asset, dest, amount]);
        return Promise.resolve({ envelope: 'e', summary: summary({ kind: 'payment', destination: dest, asset: credit, amount }), context: {} });
      },
      buildTrust: (asset: string, enable: boolean) => {
        calls.push(['trust', asset, enable]);
        return Promise.resolve({ envelope: 'e', summary: summary({ kind: 'changeTrust', asset: credit, limit: '9223372036854775807' }), context: {} });
      },
    }) as unknown as StellarBackend;

  for (const device of ['ledger', 'trezor'] as const) {
    it(`builds the payment and the trustline for a ${device}`, async () => {
      const calls: unknown[][] = [];
      const a = new StellarAdapter({ chain: stellarChain('mainnet'), address: me, hw: { accountId: 'acc', device }, backend: backend(calls) });
      await a.buildTx({ to, amount: 5n, asset: { kind: 'xlmasset', contract: usdc.contract } } as unknown as BuildParams);
      await a.buildTrust(usdc.contract, true);
      expect(calls).toEqual([
        ['asset', usdc.contract, to, '5'],
        ['trust', usdc.contract, true],
      ]);
    });
  }
});

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
