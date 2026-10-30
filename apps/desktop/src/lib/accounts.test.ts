import { describe, expect, it } from 'vitest';
import { createMockBackend } from '@kyro/shared/mock';
import { setBackend, call } from '@kyro/shared';
import { createAdapters } from '@kyro/chains';
import { accountAddress, accountNameProblem, defaultAccountName, familyAdapters, nextAccountIndex } from './accounts';

describe('vault account helpers (§2.9)', () => {
  it('default names and the next index to scan', () => {
    expect(defaultAccountName('btc', 0)).toBe('Bitcoin 1');
    expect(defaultAccountName('evm', 1)).toBe('Ethereum 2');
    expect(nextAccountIndex([{ index: 0, name: 'a' }])).toBe(1);
    // A removed account (1) comes back first.
    expect(nextAccountIndex([{ index: 0, name: 'a' }, { index: 2, name: 'b' }])).toBe(1);
    expect(nextAccountIndex([{ index: 0, name: 'a' }, { index: 1, name: 'b' }], 1)).toBeNull();
  });

  it('name rule like Rust: 1–32 characters after trim, no control character', () => {
    expect(accountNameProblem('  Épargne ')).toBeNull();
    expect(accountNameProblem('   ')).not.toBeNull();
    expect(accountNameProblem('x'.repeat(33))).not.toBeNull();
    expect(accountNameProblem('a\tb')).not.toBeNull();
  });

  it('address, path and adapters of one family of an account', async () => {
    setBackend(createMockBackend({ network: 'testnet', confirm: () => true, preset: { password: 'correct horse', unlocked: true } }).invoke);
    const a1 = await call('accounts_get', { account: 1 });
    expect(accountAddress(a1, 'evm')).toEqual({ address: a1.evm.address, path: "m/44'/60'/0'/0/1" });
    expect(accountAddress(a1, 'btc').path).toBe("m/84'/1'/1' · m/86'/1'/1'");
    expect(accountAddress(a1, 'ada').path).toBe("m/1852'/1815'/1'/0/0");
    const set = createAdapters(a1, undefined, undefined, undefined, 1);
    expect(familyAdapters(set, 'evm').length).toBe(set.evm.size);
    expect(familyAdapters(set, 'ada')).toEqual([set.cardano]);
    expect(familyAdapters(set, 'btc')).toEqual([set.btc]);
  });
});
