// Demo backend: several accounts per chain (docs/IPC.md §2.9), mirroring accounts.rs.
import { beforeEach, describe, expect, it } from 'vitest';
import { call, IpcError, setBackend, type EvmTxRequest } from '../src';
import { createMockBackend } from '../src/mock';

let dialogs: string[];

beforeEach(() => {
  dialogs = [];
  const mock = createMockBackend({
    network: 'testnet',
    confirm: (t) => {
      dialogs.push(t);
      return true;
    },
    preset: { password: 'correct horse', unlocked: true },
  });
  setBackend(mock.invoke);
});

async function rejectCode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(IpcError);
    return (e as IpcError).code;
  }
  throw new Error('expected rejection');
}

const tx: EvmTxRequest = {
  chainId: 11155111,
  nonce: 0,
  to: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
  valueWei: '1000',
  data: '0x',
  gasLimit: 21_000,
  maxFeePerGas: '2000000000',
  maxPriorityFeePerGas: '1000000000',
};

describe('vault account lists (demo)', () => {
  it('account 0 always exists, cannot be removed, can be renamed', async () => {
    const l = await call('vault_accounts_get');
    expect(l.btc).toEqual([{ index: 0, name: 'Bitcoin 1' }]);
    expect(Object.keys(l).sort()).toEqual(['ada', 'bch', 'btc', 'dash', 'doge', 'evm', 'ltc', 'near', 'sol', 'sui', 'tron', 'xlm', 'xrp']);
    expect(await rejectCode(call('vault_account_remove', { chain: 'btc', account: 0 }))).toBe('INVALID_INPUT');
    const r = await call('vault_account_rename', { chain: 'btc', account: 0, name: '  Épargne ' });
    expect(r.btc).toEqual([{ index: 0, name: 'Épargne' }]);
  });

  it('adds, refuses duplicates and bad names, removes, re-adds the same index', async () => {
    await call('vault_account_add', { chain: 'evm', account: 2, name: 'Pro' });
    let l = await call('vault_account_add', { chain: 'evm', account: 1, name: 'Ethereum 2' });
    expect(l.evm.map((e) => e.index)).toEqual([0, 1, 2]);
    expect(l.sol).toHaveLength(1);
    expect(await rejectCode(call('vault_account_add', { chain: 'evm', account: 1, name: 'x' }))).toBe('INVALID_INPUT');
    expect(await rejectCode(call('vault_account_add', { chain: 'evm', account: 3, name: 'a\nb' }))).toBe('INVALID_INPUT');
    expect(await rejectCode(call('vault_account_add', { chain: 'evm', account: 101, name: 'x' }))).toBe('INVALID_INPUT');
    l = await call('vault_account_remove', { chain: 'evm', account: 2 });
    expect(l.evm.map((e) => e.index)).toEqual([0, 1]);
    l = await call('vault_account_add', { chain: 'evm', account: 2, name: 'Pro' });
    expect(l.evm.map((e) => e.index)).toEqual([0, 1, 2]);
  });

  it('accounts_get: account 0 unchanged, account 1 different with its paths', async () => {
    const a0 = await call('accounts_get');
    expect(await call('accounts_get', { account: 0 })).toEqual(a0);
    expect(a0.account).toBe(0);
    expect(a0.evm.path).toBe("m/44'/60'/0'/0/0");
    const a1 = await call('accounts_get', { account: 1 });
    expect(a1.account).toBe(1);
    expect(a1.btc.segwit.path).toBe("m/84'/1'/1'");
    expect(a1.evm.path).toBe("m/44'/60'/0'/0/1");
    expect(a1.tron.path).toBe("m/44'/195'/1'/0/0");
    for (const k of ['evm', 'sol', 'tron', 'xrp', 'cardano', 'stellar', 'sui'] as const) expect(a1[k].address).not.toBe(a0[k].address);
    expect(a1.ltc.address).not.toBe(a0.ltc.address);
    expect(await call('tron_address', { account: 1 })).toBe(a1.tron.address);
    expect(await call('xrp_address', { account: 1 })).toBe(a1.xrp.address);
    expect((await call('ada_address', { index: 0, account: 1 })).address).toBe(a1.cardano.address);
    expect(await call('ltc_address', { change: false, index: 0, account: 1 })).toBe(a1.ltc.address);
    expect(await call('btc_address', { kind: 'segwit', change: false, index: 0, account: 1 })).toBe(a1.btc.segwit.address);
  });

  it('the dialog names the signing account; an account outside the list is « inconnu » + reinforced', async () => {
    await call('vault_account_add', { chain: 'evm', account: 1, name: 'Ethereum 2' });
    await call('evm_sign_tx', { tx, password: 'correct horse', account: 1 });
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]).toContain("Compte signataire : Ethereum 2 — m/44'/60'/0'/0/1");
    dialogs = [];
    await call('evm_sign_tx', { tx, password: 'correct horse', account: 5 });
    expect(dialogs).toHaveLength(2);
    expect(dialogs[0]).toContain('« inconnu »');
    expect(dialogs[1]).toContain('PAS dans ta liste');
  });

  it('TRON / XRP / Cardano sends and staking are simulated for account 0 only', async () => {
    expect(await rejectCode(call('tron_build_tx', { to: 'TJmka325yjJKeFpQDwKSQAoNwEyNGhsaEV', amount: '1', account: 1 }))).toBe('INVALID_INPUT');
    expect(await rejectCode(call('sol_stake_overview', { account: 1 }))).toBe('INVALID_INPUT');
  });
});
