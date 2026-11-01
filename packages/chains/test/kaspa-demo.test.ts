// Kaspa end to end against the demo backend: typed kas_* commands, accounts_get, balance of the
// receive + change chains, the 0.2 KAS minimum (KIP-9), mass / fee like Rust, the live re-read at
// signing, broadcast, history, the adapter's checks and the address rules (same vectors as Rust).
import { beforeEach, describe, expect, it } from 'vitest';
import { call, IpcError, isKaspaAddress, setBackend, type Accounts } from '@kyro/shared';
import { createMockBackend, demoKaspaMass, type MockBackend } from '@kyro/shared/mock';
import { addressParts, assetsFor, createAdapters, findAsset, findLookalike, kasToSompi, KaspaAdapter, kaspaChain, outgoingHosts, type KaspaBackend } from '../src';

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

const KAS = findAsset('testnet', 'kas')!;
const FRIEND_TESTNET = 'kaspatest:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqhqrxplya';

beforeEach(async () => {
  dialogs = [];
  mock = createMockBackend({ network: 'testnet', torEnabled: false, confirm: (t) => (dialogs.push(t), true), preset: { password: PASSWORD, unlocked: true } });
  setBackend(mock.invoke);
  accounts = await call('accounts_get');
});

describe('Kaspa in the app', () => {
  it('is a full chain: KAS asset, testnet-10, api.kaspa.org hosts in the outgoing list', () => {
    expect(KAS).toMatchObject({ family: 'kas', kind: 'native', symbol: 'KAS', decimals: 8, chainKey: 'kaspa', coingeckoId: 'kaspa' });
    expect(assetsFor('mainnet').some((a) => a.id === 'kas')).toBe(true);
    expect(kaspaChain('testnet').name).toBe('Kaspa testnet-10');
    expect(outgoingHosts('testnet').map((h) => h.host)).toContain('api-tn10.kaspa.org');
    expect(outgoingHosts('mainnet').map((h) => h.host)).toContain('api.kaspa.org');
  });

  it('vault address m/44’/111111’/0’/0/0, balance of both chains', async () => {
    expect(accounts.kas?.path).toBe("m/44'/111111'/0'/0/0");
    expect(isKaspaAddress(accounts.kas!.address, 'testnet')).toBe(true);
    expect(await call('kas_address')).toBe(accounts.kas!.address);
    const kas = createAdapters(accounts).kaspa!;
    expect(kas.getAddress()).toBe(accounts.kas!.address);
    // 125.5 + 30 KAS on …/0/0 and 4.2 KAS on the change address …/1/0.
    expect(await kas.getBalance()).toEqual([{ assetId: 'kas', amount: 15_970_000_000n, spendable: 15_970_000_000n }]);
    expect(await call('kas_backend_info')).toMatchObject({ kind: 'default', label: 'api-tn10.kaspa.org', network: 'testnet' });
  });

  it('hardware-wallet accounts have no Kaspa adapter', () => {
    const ad = createAdapters(accounts, undefined, undefined, { accountId: 'hw-1', device: 'ledger' });
    expect(ad.kaspa).toBeNull();
  });

  it('builds, signs after the live re-read, broadcasts; change on …/1/0; history and status', async () => {
    const kas = createAdapters(accounts).kaspa!;
    const u = await kas.buildTx({ asset: KAS, to: FRIEND_TESTNET, amount: kasToSompi('10'), fee: { family: 'kas' } });
    expect(u.amount).toBe(1_000_000_000n);
    expect(u.summary.inputs).toBe(1);
    expect(u.summary.mass.compute).toBe(2036);
    expect(u.summary.fee).toBe('203600');
    expect(u.maxFee).toBe(203_600n);
    expect(u.summary.outputs[1]).toMatchObject({ isChange: true });
    const signed = await kas.signTx(u, PASSWORD);
    expect(dialogs[0]).toContain('Envoi Kaspa (testnet-10)');
    expect(dialogs[0]).toContain(`À : ${FRIEND_TESTNET}\nMontant : 10 KAS`);
    expect(dialogs[0]).toContain('Frais : 0,002036 KAS (203600 sompi)');
    const id = await kas.broadcast(signed);
    expect(id).toBe(u.summary.txId);
    expect((await kas.getHistory())[0]).toMatchObject({ id, direction: 'out', amount: 1_000_000_000n, fee: 203_600n, status: 'pending' });
    expect(await kas.txStatus(id)).toEqual({ found: true, accepted: false });
    mock.advance(3_000);
    expect(await kas.txStatus(id)).toEqual({ found: true, accepted: true });
    // The spent coin is gone: signing the same transaction again is refused (live re-read).
    expect((await err(kas.signTx(u, PASSWORD))).message).toContain('déjà dépensée');
  });

  it('refuses before building: tiny amounts (KIP-9), other network, over balance', async () => {
    const kas = createAdapters(accounts).kaspa!;
    expect((await err(kas.buildTx({ asset: KAS, to: FRIEND_TESTNET, amount: 10_000_000n, fee: { family: 'kas' } }))).message).toContain('0,2 KAS');
    const mainnet = 'kaspa:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkx9awp4e';
    expect((await err(kas.buildTx({ asset: KAS, to: mainnet, amount: kasToSompi('1'), fee: { family: 'kas' } }))).message).toContain('réseau principal');
    expect((await err(kas.buildTx({ asset: KAS, to: FRIEND_TESTNET, amount: kasToSompi('500'), fee: { family: 'kas' } }))).message).toContain('insufficient funds');
    expect((await err(call('kas_build_tx', { to: FRIEND_TESTNET, amount: '1.5' }))).code).toBe('INVALID_INPUT');
  });

  it('max: one output, no change, fee = minimum', async () => {
    const kas = createAdapters(accounts).kaspa!;
    const u = await kas.buildTx({ asset: KAS, to: FRIEND_TESTNET, amount: 0n, max: true, fee: { family: 'kas' } });
    expect(u.summary.outputs).toHaveLength(1);
    expect(u.summary.hasChange).toBe(false);
    expect(u.summary.fee).toBe(u.summary.minimumFee);
    expect(u.amount + u.maxFee).toBe(15_970_000_000n);
  });

  it('the adapter refuses what Rust built if it is not what was asked', async () => {
    const real = createAdapters(accounts).kaspa!;
    const built = await real.buildTx({ asset: KAS, to: FRIEND_TESTNET, amount: kasToSompi('2'), fee: { family: 'kas' } });
    const lying: KaspaBackend = {
      account: () => call('kas_account'),
      txs: () => call('kas_txs'),
      build: async () => ({ tx: built.tx, summary: { ...built.summary, outputs: built.summary.outputs.map((o, i) => (i === 0 ? { ...o, amount: '300000000' } : o)) }, context: built.context }),
      sign: () => Promise.reject(new Error('unused')),
      broadcast: () => Promise.reject(new Error('unused')),
      txStatus: () => Promise.reject(new Error('unused')),
    };
    const a = new KaspaAdapter({ chain: kaspaChain('testnet'), address: accounts.kas!.address, backend: lying });
    expect((await err(a.buildTx({ asset: KAS, to: FRIEND_TESTNET, amount: kasToSompi('2'), fee: { family: 'kas' } }))).message).toContain('ne correspond pas');
  });

  it('mass like wallet-core: 1 → 2 is 2 036 g, KIP-9 storage for small outputs', () => {
    expect(demoKaspaMass([5_000_000_000n], [{ amount: 1_000_000_000n, scriptLen: 34 }, { amount: 3_999_796_400n, scriptLen: 34 }])).toMatchObject({ compute: 2036, storage: 1050, total: 2036 });
    expect(demoKaspaMass([1_000_000_000n], [{ amount: 20_000_000n, scriptLen: 34 }, { amount: 979_000_000n, scriptLen: 34 }])?.storage).toBe(50_000 + 1021 - 1000);
  });

  it('KAS amounts and address poisoning prefix', () => {
    expect(kasToSompi('1,5')).toBe(150_000_000n);
    expect(kasToSompi('0.00000001')).toBe(1n);
    expect(() => kasToSompi('1.123456789')).toThrow();
    expect(addressParts(FRIEND_TESTNET, 'kas').prefix).toBe('kaspatest:q');
    const me = accounts.kas!.address;
    const lookalike = `${me.slice(0, 15)}${'q'.repeat(me.length - 23)}${me.slice(-8)}`;
    expect(findLookalike(lookalike, [{ address: me, source: 'own' }], 'kas')?.known.address).toBe(me);
  });
});
