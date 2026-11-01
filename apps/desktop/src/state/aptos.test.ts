import { describe, expect, it } from 'vitest';
import { call, setBackend } from '@kyro/shared';
import { createMockBackend } from '@kyro/shared/mock';
import { aptosChain, createAdapters, nativeAssetId } from '@kyro/chains';
import { ACCOUNT_CHAIN_LABEL, accountAddress, familyAdapters } from '../lib/accounts';

describe('Aptos in the UI', () => {
  it('is a regular vault chain: native asset `apt`, account list « Aptos », one address per account', async () => {
    expect(nativeAssetId(aptosChain('testnet'))).toBe('apt');
    expect(ACCOUNT_CHAIN_LABEL.apt).toBe('Aptos');
    const mock = createMockBackend({ network: 'testnet', torEnabled: false, preset: { password: 'correct horse', unlocked: true } });
    setBackend(mock.invoke);
    const accounts = await call('accounts_get');
    const set = createAdapters(accounts);
    expect(familyAdapters(set, 'apt')).toEqual([set.aptos]);
    expect(accountAddress(accounts, 'apt')).toEqual(accounts.aptos);
    expect(set.all).toContain(set.aptos);
  });

  it('a hardware-wallet account has no Aptos adapter (no hw_* path)', async () => {
    const mock = createMockBackend({ network: 'testnet', torEnabled: false, preset: { password: 'correct horse', unlocked: true } });
    setBackend(mock.invoke);
    const accounts = await call('accounts_get');
    const hw = createAdapters(accounts, undefined, undefined, { accountId: 'x', device: 'ledger' });
    expect(hw.aptos).toBeNull();
  });
});
