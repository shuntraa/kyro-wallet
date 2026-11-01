// SPDX-License-Identifier: GPL-3.0-or-later
//
// Aptos end to end against the demo backend: typed aptos_* commands, accounts_get, the max fee
// reserved up front, the native dialog, the commit follow-up, the outgoing hosts.
import { beforeEach, describe, expect, it } from 'vitest';
import { call, IpcError, setBackend, type Accounts } from '@kyro/shared';
import { createMockBackend, type MockBackend } from '@kyro/shared/mock';
import { assetsFor, createAdapters, findAsset, isAptosAddress, outgoingHosts } from '../src';

const PASSWORD = 'correct horse battery';
let accounts: Accounts;
let mock: MockBackend;
let dialogs: string[];

async function err(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await p;
  } catch (e) {
    return e instanceof IpcError ? { code: e.code, message: e.message } : { code: 'JS', message: (e as Error).message };
  }
  throw new Error('expected rejection');
}

const APT = findAsset('testnet', 'apt')!;
const NEW = `0x${'ab'.repeat(32)}`;

beforeEach(async () => {
  dialogs = [];
  mock = createMockBackend({ network: 'testnet', torEnabled: false, confirm: (t) => (dialogs.push(t), true), preset: { password: PASSWORD, unlocked: true } });
  setBackend(mock.invoke);
  accounts = await call('accounts_get');
});

describe('Aptos in the app', () => {
  it('is a full chain: APT asset, Aptos Labs hosts in the outgoing list', () => {
    expect(APT).toMatchObject({ family: 'apt', kind: 'native', symbol: 'APT', decimals: 8, chainKey: 'aptos', coingeckoId: 'aptos' });
    expect(assetsFor('mainnet').some((a) => a.id === 'apt')).toBe(true);
    expect(outgoingHosts('testnet').map((h) => h.host)).toContain('api.testnet.aptoslabs.com');
    expect(outgoingHosts('mainnet').map((h) => h.host)).toContain('api.mainnet.aptoslabs.com');
  });

  it('vault account, balance, send with the native dialog, commit follow-up', async () => {
    expect(isAptosAddress(accounts.aptos.address)).toBe(true);
    expect(accounts.aptos.path).toBe("m/44'/637'/0'/0'/0'");
    expect(await call('aptos_address')).toBe(accounts.aptos.address);
    const apt = createAdapters(accounts).aptos!;
    expect(apt.getAddress()).toBe(accounts.aptos.address);
    expect(await apt.getBalance()).toEqual([{ assetId: 'apt', amount: 1_250_000_000n }]);

    const u = await apt.buildTx({ asset: APT, to: mock.aptos.friend, amount: 100_000_000n, fee: { family: 'apt' } });
    expect(u.summary).toMatchObject({ recipient: mock.aptos.friend, amount: '100000000', chainId: 2, maxGasAmount: '200', gasUnitPrice: '100', maxFee: '20000' });
    expect(u.context.recipientNew).toBe(false);
    expect(await err(apt.signTx(u, 'wrong'))).toMatchObject({ code: 'WRONG_PASSWORD' });
    const signed = await apt.signTx(u, PASSWORD);
    expect(dialogs.at(-1)).toMatch(/Confirmer l'envoi d'APT[\s\S]*Montant : 1 APT[\s\S]*0x1::aptos_account::transfer/);
    const hash = await apt.broadcast(signed);
    expect(hash).toBe(signed.hash);
    expect(await apt.txStatus(hash)).toMatchObject({ committed: false });
    mock.advance(5_000);
    expect(await apt.txStatus(hash)).toMatchObject({ committed: true, success: true });
    // Gas used (11 × 100) and the amount left; the sequence moved: the old transaction is stale.
    expect((await apt.account()).balance).toBe(String(1_250_000_000 - 100_000_000 - 1_100));
    expect(await err(apt.signTx(u, PASSWORD))).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringMatching(/séquence périmé/) });
    const h = await apt.getHistory();
    expect(h[0]).toMatchObject({ id: hash, direction: 'out', amount: 100_000_000n, counterparty: mock.aptos.friend });
  });

  it('a new recipient costs more gas; amount + max fee over the balance is refused', async () => {
    const apt = createAdapters(accounts).aptos!;
    const u = await apt.buildTx({ asset: APT, to: NEW, amount: 1n, fee: { family: 'apt' } });
    expect(u.context.recipientNew).toBe(true);
    expect(u.summary.maxGasAmount).toBe('1500');
    expect(await err(apt.buildTx({ asset: APT, to: NEW, amount: 1_250_000_000n, fee: { family: 'apt' } }))).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringMatching(/solde insuffisant/) });
    const max = await apt.buildTx({ asset: APT, to: NEW, amount: 0n, fee: { family: 'apt' }, max: true });
    expect(max.amount).toBe(1_250_000_000n - 150_000n);
    expect(await err(call('aptos_build_tx', { to: '0x1', amount: '1' }))).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringMatching(/forme courte/) });
  });

  it('a transfer refused in the dialog sends nothing', async () => {
    mock = createMockBackend({ network: 'testnet', torEnabled: false, confirm: () => false, preset: { password: PASSWORD, unlocked: true } });
    setBackend(mock.invoke);
    const apt = createAdapters(await call('accounts_get')).aptos!;
    const u = await apt.buildTx({ asset: APT, to: mock.aptos.friend, amount: 1n, fee: { family: 'apt' } });
    expect(await err(apt.signTx(u, PASSWORD))).toMatchObject({ code: 'USER_REJECTED' });
  });
});
