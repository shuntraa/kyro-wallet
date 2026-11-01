import { describe, expect, it } from 'vitest';
import { call, setBackend } from '@kyro/shared';
import { createMockBackend } from '@kyro/shared/mock';
import { cosmosChain, createAdapters, nativeAssetId, outgoingHosts, WATCH_ONLY_CHAINS } from '@kyro/chains';
import { EXCHANGE_MEMO_HINT } from '../components/CosmosSend';
import { accountChainHint, ACCOUNT_CHAIN_LABEL, accountAddress, defaultAccountName, familyAdapters } from '../lib/accounts';

describe('Cosmos Hub in the UI', () => {
  it('is a regular chain: native asset `cosmos`, its own account list, exchange memo hint', () => {
    expect(WATCH_ONLY_CHAINS.some((w) => w.key === 'cosmos')).toBe(false);
    expect(nativeAssetId(cosmosChain('mainnet'))).toBe('cosmos');
    expect(ACCOUNT_CHAIN_LABEL.cosmos).toBe('Cosmos');
    expect(accountChainHint('cosmos')).toMatch(/ATOM/);
    expect(defaultAccountName('cosmos', 1)).toBe('Cosmos 2');
    expect(EXCHANGE_MEMO_HINT).toMatch(/mémo/);
    expect(outgoingHosts('mainnet').some((h) => h.host === 'cosmos-rest.publicnode.com')).toBe(true);
  });

  it('the vault account set has a Cosmos adapter and address with its path', async () => {
    const mock = createMockBackend({ network: 'testnet', torEnabled: false, preset: { password: 'correct horse', unlocked: true } });
    setBackend(mock.invoke);
    const acc = await call('accounts_get');
    const ad = createAdapters(acc);
    expect(familyAdapters(ad, 'cosmos').map((a) => a.family)).toEqual(['cosmos']);
    expect(accountAddress(acc, 'cosmos')).toEqual({ address: ad.cosmos!.getAddress(), path: "m/44'/118'/0'/0/0" });
    const lists = await call('vault_accounts_get');
    expect(lists.cosmos).toEqual([{ index: 0, name: 'Cosmos 1' }]);
  });
});
