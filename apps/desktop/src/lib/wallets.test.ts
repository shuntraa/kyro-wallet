// Several wallets: the demo backend's flow, and local records kept apart per wallet.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { call, setBackend } from '@kyro/shared';
import { createMockBackend } from '@kyro/shared/mock';
import { addApproval, addLocalTx, getApprovals, getBackupState, getLocalTxs, scoped, setBackupState, setWalletScope, type ApprovalRecord, type LocalTx } from './storage';

const FIRST = 'correct horse battery';
const SECOND = 'another good password';
const PHRASE = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

beforeEach(() => {
  setBackend(createMockBackend({ network: 'testnet', confirm: () => true, preset: { password: FIRST, unlocked: true } }).invoke);
});

describe('wallet flow', () => {
  const addSecond = async () => {
    await call('wallet_new', { name: 'Savings' });
    await call('vault_import', { password: SECOND, phrase: PHRASE });
    return (await call('wallets_get')).active;
  };

  it('adding locks the open wallet, then runs the usual import on a new vault', async () => {
    await call('wallet_new', { name: 'Savings' });
    const s = await call('vault_status');
    expect(s).toMatchObject({ exists: false, unlocked: false, creating: 'Savings' });
    await call('vault_import', { password: SECOND, phrase: PHRASE });
    const after = await call('vault_status');
    expect(after).toMatchObject({ exists: true, unlocked: true, creating: null });
    expect(after.walletId).not.toBe('main');
    expect((await call('wallets_get')).wallets.map((w) => w.name)).toEqual(['', 'Savings']);
  });

  it('cancelling goes back to the first wallet, locked, with nothing added', async () => {
    await call('wallet_new', { name: 'Savings' });
    await call('wallet_new_cancel');
    expect(await call('vault_status')).toMatchObject({ exists: true, unlocked: false, walletId: 'main', creating: null });
    expect((await call('wallets_get')).wallets).toHaveLength(1);
    await call('vault_unlock', { password: FIRST });
  });

  it('switching ends the session and each wallet takes its own password', async () => {
    const id = await addSecond();
    await call('wallet_switch', { id: 'main' });
    expect(await call('vault_status')).toMatchObject({ unlocked: false, walletId: 'main' });
    await expect(call('vault_unlock', { password: SECOND })).rejects.toMatchObject({ code: 'WRONG_PASSWORD' });
    await call('vault_unlock', { password: FIRST });
    await call('wallet_switch', { id });
    await expect(call('vault_unlock', { password: FIRST })).rejects.toMatchObject({ code: 'WRONG_PASSWORD' });
    await call('vault_unlock', { password: SECOND });
  });

  it('removing needs the password of the open added wallet, and never the first one', async () => {
    const id = await addSecond();
    await expect(call('wallet_remove', { id: 'main', password: FIRST })).rejects.toThrow();
    await expect(call('wallet_remove', { id, password: 'wrong password' })).rejects.toMatchObject({ code: 'WRONG_PASSWORD' });
    const left = await call('wallet_remove', { id, password: SECOND });
    expect(left).toMatchObject({ active: 'main' });
    expect(left.wallets).toHaveLength(1);
  });

  it('refuses two wallets with the same name', async () => {
    await addSecond();
    await expect(call('wallet_new', { name: 'savings' })).rejects.toThrow();
  });
});

describe('local records', () => {
  const tx: LocalTx = { id: '0x1', network: 'testnet', chainKey: 'sepolia', assetId: 'eth', kind: 'transfer', direction: 'out', amount: '1', time: 1, status: 'pending' };
  const approval: ApprovalRecord = { network: 'testnet', chainId: 1, chainKey: 'sepolia', token: '0xa', tokenSymbol: 'T', tokenDecimals: 6, spender: '0xb', spenderLabel: 'B', amount: '1', unlimited: true, time: 1, txHash: '0x2' };

  beforeEach(() => {
    const m = new Map<string, string>();
    vi.stubGlobal('window', { localStorage: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => m.set(k, v) } });
  });
  afterEach(() => {
    setWalletScope('');
    vi.unstubAllGlobals();
  });

  it('the first wallet keeps its historical keys', () => {
    setWalletScope('');
    expect(scoped('txs.testnet')).toBe('txs.testnet');
  });

  it('transactions, approvals and backup state stay in their wallet', () => {
    addLocalTx(tx);
    addApproval(approval);
    setBackupState('confirmed');
    setWalletScope('w-0000000000000002');
    expect(getLocalTxs('testnet')).toEqual([]);
    expect(getApprovals('testnet')).toEqual([]);
    expect(getBackupState()).toBe('unknown');
    addLocalTx({ ...tx, id: '0x3' });
    setWalletScope('');
    expect(getLocalTxs('testnet').map((t) => t.id)).toEqual(['0x1']);
    expect(getBackupState()).toBe('confirmed');
  });

  it('a watch address sees no local record', () => {
    addLocalTx(tx);
    setWalletScope('wa-0000000000000001');
    expect(getLocalTxs('testnet')).toEqual([]);
  });
});
