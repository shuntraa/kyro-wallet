// NEAR end to end against the demo backend: typed near_* commands, accounts_get, the storage
// reserve and spendable, receiver rules (named must exist, implicit is created), the fee bound,
// the dialog text, history and the multi-account wiring.
import { beforeEach, describe, expect, it } from 'vitest';
import { call, IpcError, nearAccountIdProblem, nearAccountKind, setBackend, type Accounts } from '@kyro/shared';
import { createMockBackend, demoNearAddress, type MockBackend } from '@kyro/shared/mock';
import { addressParts, assetsFor, createAdapters, findAsset, isLookalike, outgoingHosts } from '../src';

const PASSWORD = 'correct horse battery';
const YOCTO = 10n ** 24n;
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

const NEAR = findAsset('testnet', 'near')!;
const fee = { family: 'near' as const };

beforeEach(async () => {
  dialogs = [];
  mock = createMockBackend({ network: 'testnet', torEnabled: false, confirm: (t) => (dialogs.push(t), true), preset: { password: PASSWORD, unlocked: true } });
  setBackend(mock.invoke);
  accounts = await call('accounts_get');
});

describe('NEAR account ids (same rules as wallet-core)', () => {
  it('kinds and refusals', () => {
    expect(nearAccountKind('alice.near')).toBe('named');
    expect(nearAccountKind('a-b_c.d')).toBe('named');
    expect(nearAccountKind('98793cd91a3f870fb126f66285808c7e094afcfc4eda8a970f6648cdf0dbd6de')).toBe('implicit');
    expect(nearAccountKind('0x2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe('ethImplicit');
    for (const bad of ['a', '', 'Alice.near', '.near', 'alice.', 'alice..near', 'a-.b', '_a', 'alice near', 'alicé.near', 'a'.repeat(65), 'A'.repeat(64)]) {
      expect(nearAccountKind(bad), bad).toBeNull();
    }
    expect(nearAccountIdProblem('Bob.near')).toMatch(/minuscules/i);
    expect(nearAccountIdProblem('bob..near')).toMatch(/invalide/i);
    expect(nearAccountIdProblem('bob.near')).toBeNull();
  });

  it('poisoning: implicit look-alikes are caught, case-insensitively', () => {
    const a = '5510e2b44cae6eb807e3e0e45d579dda058c274abcba15e5cb84636f5d1ee412';
    const b = '5510ffffffffffffffffffffffffffffffffffffffffffffffffffffffffe412';
    expect(addressParts(a, 'near').prefix).toBe('');
    expect(isLookalike(a, b, 'near')).toBe(true);
    expect(isLookalike(a, a, 'near')).toBe(false);
  });
});

describe('NEAR in the app', () => {
  it('chain, asset (24 decimals, CoinGecko near) and FastNEAR hosts', () => {
    expect(NEAR).toMatchObject({ family: 'near', kind: 'native', symbol: 'NEAR', decimals: 24, coingeckoId: 'near', chainKey: 'near' });
    expect(assetsFor('mainnet').some((a) => a.id === 'near')).toBe(true);
    const t = outgoingHosts('testnet').map((h) => h.host);
    expect(t).toEqual(expect.arrayContaining(['test.rpc.fastnear.com', 'tx.test.fastnear.com']));
    const m = outgoingHosts('mainnet').map((h) => h.host);
    expect(m).toEqual(expect.arrayContaining(['free.rpc.fastnear.com', 'tx.main.fastnear.com']));
  });

  it('implicit account, storage reserve, spendable', async () => {
    expect(accounts.near).toEqual({ address: demoNearAddress(0), path: "m/44'/397'/0'" });
    expect(await call('near_address', {})).toBe(accounts.near.address);
    const near = createAdapters(accounts).near!;
    const me = await near.account();
    expect(me).toMatchObject({ exists: true, storageUsage: 182, storageReserve: '1820000000000000000000' });
    expect(await near.getBalance()).toEqual([{ assetId: 'near', amount: 42n * YOCTO + YOCTO / 2n, spendable: 42n * YOCTO + YOCTO / 2n - 1_820_000_000_000_000_000_000n }]);
    expect(await call('near_backend_info')).toMatchObject({ kind: 'default', label: 'test.rpc.fastnear.com', history: 'tx.test.fastnear.com', network: 'testnet' });
    const second = await call('accounts_get', { account: 1 });
    expect(second.near).toEqual({ address: demoNearAddress(1), path: "m/44'/397'/1'" });
    expect(second.near.address).not.toBe(accounts.near.address);
  });

  it('hardware-wallet accounts have no NEAR adapter', () => {
    const { near: _n, xrp: _x, tron: _t, ltc: _l, doge: _d, cardano: _c, ...hw } = accounts;
    const ad = createAdapters(hw, undefined, undefined, { accountId: 'hw-1', device: 'ledger' });
    expect(ad.near).toBeNull();
    expect(ad.all.some((a) => a.family === 'near')).toBe(false);
  });

  it('a named receiver must exist; an implicit one is created (higher fee bound)', async () => {
    const near = createAdapters(accounts).near!;
    const e = await err(near.buildTx({ asset: NEAR, to: 'personne-ici.testnet', amount: YOCTO, fee }));
    expect(e.message).toMatch(/n’existe pas : un compte nommé doit déjà exister/i);
    const named = await near.buildTx({ asset: NEAR, to: mock.near.friend, amount: YOCTO, fee });
    expect(named.context.createsAccount).toBe(false);
    expect(named.maxFee).toBe(892_730_250_000_000_000_000n);
    const fresh = 'ab'.repeat(32);
    const implicit = await near.buildTx({ asset: NEAR, to: fresh, amount: YOCTO, fee });
    expect(implicit.context.createsAccount).toBe(true);
    expect(implicit.maxFee).toBeGreaterThan(named.maxFee);
    const e2 = await err(near.buildTx({ asset: NEAR, to: `0x${'2a'.repeat(20)}`, amount: YOCTO, fee }));
    expect(e2.message).toMatch(/style Ethereum/i);
    expect((await err(near.buildTx({ asset: NEAR, to: 'Bob.testnet', amount: YOCTO, fee }))).message).toMatch(/minuscules/i);
    expect((await err(near.buildTx({ asset: NEAR, to: accounts.near.address, amount: YOCTO, fee }))).message).toMatch(/soi-même/i);
  });

  it('amount + fee bound must fit in spendable; MAX leaves exactly the bound', async () => {
    const near = createAdapters(accounts).near!;
    const spendable = BigInt((await near.account()).spendable);
    const e = await err(near.buildTx({ asset: NEAR, to: mock.near.friend, amount: spendable, fee }));
    expect(e.message).toMatch(/solde disponible insuffisant/i);
    const max = await near.buildTx({ asset: NEAR, to: mock.near.friend, amount: 0n, fee, max: true });
    expect(max.amount + max.maxFee).toBe(spendable);
  });

  it('sign → dialog (receiver, amount, fee bound, key) → broadcast → executed, in the history', async () => {
    const near = createAdapters(accounts).near!;
    const u = await near.buildTx({ asset: NEAR, to: mock.near.friend, amount: 3n * YOCTO / 2n, fee });
    expect(u.summary).toMatchObject({ receiverId: mock.near.friend, receiverKind: 'named', deposit: '1500000000000000000000000', signerId: accounts.near.address });
    const s = await near.signTx(u, PASSWORD);
    expect(dialogs[0]).toContain('Envoi NEAR (testnet)');
    expect(dialogs[0]).toContain(`À : ${mock.near.friend}\n(compte nommé)`);
    expect(dialogs[0]).toContain('Montant : 1,5 NEAR (1500000000000000000000000 yoctoNEAR)');
    expect(dialogs[0]).toMatch(/Frais : ≈ 0,0000446365125 NEAR — au plus 0,00089273025 NEAR/i);
    expect(await near.broadcast(s)).toBe(s.hash);
    expect(await near.txStatus(s.hash)).toMatchObject({ status: 'success' });
    const h = await near.getHistory();
    expect(h[0]).toMatchObject({ id: s.hash, direction: 'out', amount: 3n * YOCTO / 2n, counterparty: mock.near.friend, status: 'confirmed' });
    expect(h.some((x) => x.direction === 'in')).toBe(true);
    // The same transaction again: stale nonce.
    expect((await err(near.signTx(u, PASSWORD))).message).toMatch(/nonce périmé/i);
  });

  it('wrong password and a rejected dialog sign nothing', async () => {
    const near = createAdapters(accounts).near!;
    const u = await near.buildTx({ asset: NEAR, to: mock.near.friend, amount: YOCTO, fee });
    expect((await err(near.signTx(u, 'nope'))).code).toBe('WRONG_PASSWORD');
    const m2 = createMockBackend({ network: 'testnet', torEnabled: false, confirm: () => false, preset: { password: PASSWORD, unlocked: true } });
    setBackend(m2.invoke);
    const a2 = await call('accounts_get');
    const n2 = createAdapters(a2).near!;
    const u2 = await n2.buildTx({ asset: NEAR, to: m2.near.friend, amount: YOCTO, fee });
    expect((await err(n2.signTx(u2, PASSWORD))).code).toBe('USER_REJECTED');
  });
});
