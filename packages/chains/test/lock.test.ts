// Bitcoin time lock on the adapter: funding reuses the normal send, and only a software wallet may.
import { beforeAll, describe, expect, it } from 'vitest';
import { call, setBackend, type Accounts } from '@kyro/shared';
import { createMockBackend } from '@kyro/shared/mock';
import { BitcoinAdapter, btcChain, createAdapters, findAsset, type AdapterSet } from '../src/index';

const PASSWORD = 'correct horse battery';
const T = Math.floor(Date.now() / 86_400_000 + 40) * 86_400;

let accounts: Accounts;
let adapters: AdapterSet;

beforeAll(async () => {
  setBackend(createMockBackend({ network: 'testnet', confirm: () => true, preset: { password: PASSWORD, unlocked: true } }).invoke);
  accounts = await call('accounts_get');
  adapters = createAdapters(accounts);
});

describe('funding a lock', () => {
  it('builds a normal send to the lock address, and shows up as locked', async () => {
    const asset = findAsset('testnet', 'btc');
    if (!asset) throw new Error('asset');
    const adapter = adapters.btc!;
    expect(adapter.canLock).toBe(true);
    const info = await call('btc_lock_preview', { t: T });
    expect(adapter.isValidAddress(info.address)).toBe(true);
    const unsigned = await adapter.buildTx({ asset, to: info.address, amount: 100_000n, fee: { family: 'btc', satPerVb: 3 } });
    expect(unsigned.summary.outputs[0]).toEqual([info.address, 100_000, false]);
    const before = (await call('btc_locks_status')).lockedSats;
    const signed = await adapter.signLockFunding(unsigned, PASSWORD, T, 'LOCK');
    expect(signed.hex).toMatch(/^02000000/i);
    const after = await call('btc_locks_status');
    expect(after.lockedSats).toBe(before + 100_000);
    expect(after.locks.find((l) => l.t === T)?.status).toBe('confirming');
  });

  it('needs the word', async () => {
    const asset = findAsset('testnet', 'btc');
    if (!asset) throw new Error('asset');
    const info = await call('btc_lock_preview', { t: T });
    const unsigned = await adapters.btc!.buildTx({ asset, to: info.address, amount: 100_000n, fee: { family: 'btc', satPerVb: 3 } });
    await expect(adapters.btc!.signLockFunding(unsigned, PASSWORD, T, 'yes')).rejects.toThrow();
  });
});

describe('only software wallets', () => {
  it('refuses a watch or hardware account before asking Rust', async () => {
    const chain = btcChain('testnet');
    const watch = new BitcoinAdapter({ chain, accounts: accounts.btc, watch: { kind: 'address', address: accounts.btc.segwit.address } });
    expect(watch.canLock).toBe(false);
    const hw = new BitcoinAdapter({ chain, accounts: accounts.btc, hw: { device: 'ledger', prevTx: async () => '' } as never });
    expect(hw.canLock).toBe(false);
    const unsigned = { psbt: '', amount: 100_000n } as never;
    await expect(watch.signLockFunding(unsigned, PASSWORD, T, 'LOCK')).rejects.toThrow(/software|logiciel/);
    await expect(hw.signLockFunding(unsigned, PASSWORD, T, 'LOCK')).rejects.toThrow(/software|logiciel/);
  });
});
