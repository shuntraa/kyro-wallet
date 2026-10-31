import { describe, expect, it } from 'vitest';
import { createMockBackend } from '@kyro/shared/mock';
import { setBackend, call, MAX_ACCOUNTS_PER_CHAIN, MAX_VAULT_ACCOUNT, IpcError } from '@kyro/shared';
import { createAdapters } from '@kyro/chains';
import { accountAddress, accountNameProblem, defaultAccountName, familyAdapters, nextAccountIndex, otherOwnAccounts, ownAccountLabel, ownAccountOf, planNewAccounts } from './accounts';

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

describe('many accounts, easily (§2.9)', () => {
  const entries = (...idx: number[]) => idx.map((index) => ({ index, name: `n${index}` }));

  it('plans the next free indices, within the 20-per-chain limit', () => {
    expect(planNewAccounts(entries(0), 1)).toEqual([1]);
    expect(planNewAccounts(entries(0), 3)).toEqual([1, 2, 3]);
    // Removed accounts come back first, then the next numbers.
    expect(planNewAccounts(entries(0, 2, 5), 4)).toEqual([1, 3, 4, 6]);
    // 18 accounts: only 2 more fit (account 0 counts).
    const eighteen = entries(...Array.from({ length: 18 }, (_, i) => i));
    expect(planNewAccounts(eighteen, 10)).toEqual([18, 19]);
    expect(planNewAccounts(entries(...Array.from({ length: 20 }, (_, i) => i)), 1)).toEqual([]);
    // Highest index (100) and nonsense counts.
    expect(planNewAccounts(entries(0), 5, 20, 2)).toEqual([1, 2]);
    expect(planNewAccounts(entries(0), 0)).toEqual([]);
    expect(planNewAccounts(entries(0), -3)).toEqual([]);
    expect(planNewAccounts(entries(0), 2.7)).toEqual([1, 2]);
  });

  it('lists the OTHER own accounts of a chain and recognises own recipients', () => {
    const sources = [
      { family: 'btc' as const, index: 0, name: 'Bitcoin 1', addresses: ['tb1qaaa', 'tb1paaa'] },
      { family: 'btc' as const, index: 1, name: 'Épargne', addresses: ['tb1qbbb', 'tb1pbbb'] },
      { family: 'btc' as const, index: 2, name: 'chargement', addresses: [] },
      { family: 'evm' as const, index: 0, name: 'Ethereum 1', addresses: ['0xAbC0000000000000000000000000000000000001'] },
      { family: 'evm' as const, index: 1, name: 'Pro', addresses: ['0xDeF0000000000000000000000000000000000002'] },
    ];
    expect(otherOwnAccounts(sources, 'btc', 0).map((s) => s.name)).toEqual(['Épargne']);
    expect(otherOwnAccounts(sources, 'btc', 1).map((s) => s.name)).toEqual(['Bitcoin 1']);
    expect(otherOwnAccounts(sources, 'sol', 0)).toEqual([]);
    expect(ownAccountOf(sources, 'btc', ' tb1pbbb ')?.name).toBe('Épargne');
    expect(ownAccountOf(sources, 'btc', 'tb1qzzz')).toBeUndefined();
    // EVM: case-insensitive (checksum or not).
    expect(ownAccountOf(sources, 'evm', '0xdef0000000000000000000000000000000000002')?.name).toBe('Pro');
    // Same address string on another family: not matched.
    expect(ownAccountOf(sources, 'sol', 'tb1qbbb')).toBeUndefined();
    expect(ownAccountOf(sources, 'btc', '')).toBeUndefined();
    expect(ownAccountLabel('Épargne')).toBe('Ton compte « Épargne »');
  });

  it('creates many accounts in the demo: default names, limit, account 0 unchanged', async () => {
    setBackend(createMockBackend({ network: 'testnet', confirm: () => true, preset: { password: 'correct horse', unlocked: true } }).invoke);
    const before = await call('accounts_get');
    let lists = await call('vault_accounts_get');
    for (const index of planNewAccounts(lists.btc, 25, MAX_ACCOUNTS_PER_CHAIN, MAX_VAULT_ACCOUNT)) {
      lists = await call('vault_account_add', { chain: 'btc', account: index, name: defaultAccountName('btc', index) });
    }
    expect(lists.btc).toHaveLength(MAX_ACCOUNTS_PER_CHAIN);
    expect(lists.btc[1]).toEqual({ index: 1, name: 'Bitcoin 2' });
    expect(lists.btc[19]).toEqual({ index: 19, name: 'Bitcoin 20' });
    expect(planNewAccounts(lists.btc, 1)).toEqual([]);
    await expect(call('vault_account_add', { chain: 'btc', account: 20, name: 'Bitcoin 21' })).rejects.toBeInstanceOf(IpcError);
    // Every account has its own address; account 0 keeps its historical one.
    const after = await call('accounts_get');
    expect(after.btc.segwit.address).toBe(before.btc.segwit.address);
    expect(after.evm.address).toBe(before.evm.address);
    const addrs = new Set<string>();
    for (const e of lists.btc) addrs.add(accountAddress(await call('accounts_get', { account: e.index }), 'btc').address);
    expect(addrs.size).toBe(MAX_ACCOUNTS_PER_CHAIN);
    // Recevoir shows the path of the chosen account, not account 0's.
    const second = await call('accounts_get', { account: 1 });
    expect(second.evm.path).toBe("m/44'/60'/0'/0/1");
    expect(second.sol.path).toBe("m/44'/501'/1'/0'");
    expect(before.evm.path).toBe("m/44'/60'/0'/0/0");
  });
});

