import { describe, expect, it } from 'vitest';
import { call, setBackend } from '@kyro/shared';
import { createMockBackend } from '@kyro/shared/mock';
import { algorandChain, createAdapters, nativeAssetId, WATCH_ONLY_CHAINS } from '@kyro/chains';
import { ALGO_ACTIVATION } from '../components/AlgoSend';
import { ACCOUNT_CHAIN_LABEL, accountAddress, defaultAccountName } from '../lib/accounts';

describe('Algorand in the UI', () => {
  it('is a regular chain: native asset `algo`, 0.1 ALGO activation, its own account list', () => {
    expect(WATCH_ONLY_CHAINS.some((w) => w.key === 'algorand')).toBe(false);
    expect(nativeAssetId(algorandChain('testnet'))).toBe('algo');
    expect(ALGO_ACTIVATION).toBe(100_000n);
    expect(ACCOUNT_CHAIN_LABEL.algo).toBe('Algorand');
    expect(defaultAccountName('algo', 1)).toBe('Algorand 2');
  });

  it('the vault has an Algorand adapter and the account list knows its path', async () => {
    const mock = createMockBackend({ network: 'testnet', torEnabled: false, preset: { password: 'correct horse', unlocked: true } });
    setBackend(mock.invoke);
    const acc = await call('accounts_get');
    expect(accountAddress(acc, 'algo')).toEqual({ address: acc.algo.address, path: "m/44'/283'/0'/0/0" });
    const ad = createAdapters(acc);
    expect(ad.all).toContain(ad.algo);
    expect((await ad.algo!.destinationInfo(mock.algo.empty)).exists).toBe(false);
    expect((await ad.algo!.destinationInfo(mock.algo.friend)).exists).toBe(true);
    const lists = await call('vault_accounts_get');
    expect(lists.algo[0]).toEqual({ index: 0, name: 'Algorand 1' });
  });
});
