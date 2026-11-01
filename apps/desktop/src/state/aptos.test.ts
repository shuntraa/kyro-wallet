import { describe, expect, it } from 'vitest';
import { call, setBackend } from '@kyro/shared';
import { createMockBackend } from '@kyro/shared/mock';
import { aptosChain, createAdapters, hwToAccounts, nativeAssetId } from '@kyro/chains';
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

  it('a hardware-wallet account has an Aptos adapter only with a Ledger Aptos key, signing through hw_*', async () => {
    const mock = createMockBackend({ network: 'testnet', torEnabled: false, preset: { password: 'correct horse', unlocked: true } });
    setBackend(mock.invoke);
    const accounts = await call('accounts_get');
    const base = { id: 'hw-0000000000000001', label: 'L', device: 'ledger' as const, model: 'Nano X', network: 'testnet' as const, account: 0 };
    const signer = { accountId: base.id, device: 'ledger' as const };
    expect(createAdapters(hwToAccounts(base), undefined, undefined, signer).aptos).toBeNull();
    const key = { chain: 'apt' as const, pubkey: '00'.repeat(32), address: accounts.aptos!.address, path: "m/44'/637'/0'/0'/0'" };
    const hw = createAdapters(hwToAccounts({ ...base, keys: [key] }), undefined, undefined, signer);
    expect(hw.aptos?.getAddress()).toBe(accounts.aptos!.address);
    expect(hw.aptos?.hw).toEqual(signer);
  });
});
