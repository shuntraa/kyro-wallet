// Cosmos Hub end to end against the demo backend: typed cosmos_* commands, accounts_get, the
// memo (always passed through and framed), simulated fee, sequence and timeout checks, inclusion
// follow-up, history, address checks.
import { beforeEach, describe, expect, it } from 'vitest';
import { call, cosmosAddressOfBytes, IpcError, setBackend, type Accounts } from '@kyro/shared';
import { createMockBackend, type MockBackend } from '@kyro/shared/mock';
import { atomToUatom, cosmosAddressProblem, cosmosChain, cosmosMemoProblem, createAdapters, findAsset, isCosmosAddress, nativeAssetId, outgoingHosts, sameAddress, WATCH_ONLY_CHAINS } from '../src';

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

const ATOM = findAsset('testnet', 'cosmos')!;
const fresh = (label: string) => cosmosAddressOfBytes(new TextEncoder().encode(label.padEnd(20, '.')).slice(0, 20));

beforeEach(async () => {
  dialogs = [];
  mock = createMockBackend({ network: 'testnet', torEnabled: false, confirm: (t) => (dialogs.push(t), true), preset: { password: PASSWORD, unlocked: true } });
  setBackend(mock.invoke);
  accounts = await call('accounts_get');
});

describe('Cosmos Hub in the app', () => {
  it('is a full chain: ATOM asset, chain ids, LCD hosts in the outgoing list', () => {
    expect(WATCH_ONLY_CHAINS.map((w) => w.key)).not.toContain('cosmos');
    expect(ATOM).toMatchObject({ family: 'cosmos', kind: 'native', symbol: 'ATOM', decimals: 6, chainKey: 'cosmos', coingeckoId: 'cosmos' });
    expect(nativeAssetId(cosmosChain('mainnet'))).toBe('cosmos');
    expect(cosmosChain('mainnet').chainId).toBe('cosmoshub-4');
    expect(cosmosChain('testnet').chainId).toBe('provider');
    expect(outgoingHosts('mainnet').map((h) => h.host)).toContain('cosmos-rest.publicnode.com');
    expect(outgoingHosts('testnet').map((h) => h.host)).toContain('rest.provider-sentry-01.hub-testnet.polypore.xyz');
  });

  it('addresses: bech32 cosmos1…, validator and other-chain addresses named, mixed case refused', () => {
    // Real vectors (cosmjs, and « abandon … about », cross-checked in wallet-core's tests).
    expect(isCosmosAddress('cosmos1jhg0e7s6gn44tfc5k37kr04sznyhedtc9rzys5')).toBe(true);
    expect(isCosmosAddress('COSMOS19RL4CM2HMR8AFY4KLDPXZ3FKA4JGUQ0AUQDAL4')).toBe(true);
    expect(cosmosAddressProblem('cosmos19rl4cm2hmr8afy4kldpxz3fka4jguq0auqdal5')).toMatch(/somme de contrôle/);
    expect(cosmosAddressProblem('Cosmos19rl4cm2hmr8afy4kldpxz3fka4jguq0auqdal4')).toMatch(/mélangées/);
    expect(cosmosAddressProblem('osmo19rl4cm2hmr8afy4kldpxz3fka4jguq0a3jf0ss')).toMatch(/somme de contrôle|autre chaîne/);
    expect(cosmosAddressProblem(fresh('x').replace(/^cosmos/, 'cosmos'))).toBeNull();
    expect(cosmosAddressProblem('')).toBe('Adresse vide');
    expect(sameAddress('COSMOS19RL4CM2HMR8AFY4KLDPXZ3FKA4JGUQ0AUQDAL4', 'cosmos19rl4cm2hmr8afy4kldpxz3fka4jguq0auqdal4', 'cosmos')).toBe(true);
    expect(atomToUatom('1.5')).toBe(1_500_000n);
    expect(atomToUatom('0,000001')).toBe(1n);
    expect(() => atomToUatom('0.0000001')).toThrow();
    expect(cosmosMemoProblem('a'.repeat(256))).toBeNull();
    expect(cosmosMemoProblem('a'.repeat(257))).toMatch(/trop long/);
    expect(cosmosMemoProblem('a\nb')).toMatch(/contrôle/);
  });

  it('vault account: address, balance, history, backend info', async () => {
    expect(isCosmosAddress(accounts.cosmos.address)).toBe(true);
    expect(accounts.cosmos.path).toBe("m/44'/118'/0'/0/0");
    expect(await call('cosmos_address', {})).toBe(accounts.cosmos.address);
    const atom = createAdapters(accounts).cosmos!;
    expect(atom.getAddress()).toBe(accounts.cosmos.address);
    expect(await atom.getBalance()).toEqual([{ assetId: 'cosmos', amount: 42_350_000n, spendable: 42_350_000n }]);
    const h = await atom.getHistory();
    expect(h).toHaveLength(2);
    expect(h[0]).toMatchObject({ assetId: 'cosmos', direction: 'in', amount: 30_000_000n, status: 'confirmed' });
    expect(h[1]?.note).toBe('Mémo : merci !');
    expect(await call('cosmos_backend_info')).toMatchObject({ kind: 'default', chainId: 'provider', label: 'rest.provider-sentry-01.hub-testnet.polypore.xyz' });
  });

  it('hardware-wallet accounts have no Cosmos adapter (HW_UNSUPPORTED)', () => {
    const { cosmos: _c, xrp: _x, tron: _t, ltc: _l, doge: _d, cardano: _a, ...hw } = accounts;
    const ad = createAdapters(hw, undefined, undefined, { accountId: 'hw-1', device: 'ledger' });
    expect(ad.cosmos).toBeNull();
    expect(ad.all.some((a) => a.family === 'cosmos')).toBe(false);
  });

  it('send with a memo: built and decoded by « Rust », memo framed after amount and fee, included', async () => {
    const atom = createAdapters(accounts).cosmos!;
    const to = mock.cosmos.exchange;
    const u = await atom.buildTx({ asset: ATOM, to, amount: 1_500_000n, fee: { family: 'cosmos' }, memo: '104857' });
    expect(u.summary).toMatchObject({ to, amount: '1500000', memo: '104857', chainId: 'provider', sequence: 7, accountNumber: 30_881 });
    expect(u.maxFee).toBe(BigInt(u.summary.fee));
    expect(u.size).toEqual({ family: 'cosmos', gasLimit: u.summary.gasLimit });
    const s = await atom.signTx(u, PASSWORD);
    const d = dialogs[0]!;
    expect(d).toContain('Montant : 1,5 ATOM (1500000 uatom)');
    expect(d).toContain('MÉMO (public à jamais) : « 104857 »');
    expect(d.indexOf('MÉMO')).toBeGreaterThan(d.indexOf('Frais'));
    expect(await atom.broadcast(s)).toBe(s.hash);
    expect((await atom.txStatus(s.hash)).included).toBe(false);
    mock.advance(7_000);
    expect(await atom.txStatus(s.hash)).toMatchObject({ included: true, success: true, code: 0 });
    const after = await atom.getBalance();
    expect(after[0]!.amount).toBe(42_350_000n - 1_500_000n - u.maxFee);
    expect((await atom.getHistory())[0]).toMatchObject({ direction: 'out', amount: 1_500_000n, note: 'Mémo : 104857' });
  });

  it('no memo: « AUCUN MÉMO » with the exchange warning; MAX = spendable − fee', async () => {
    const atom = createAdapters(accounts).cosmos!;
    const u = await atom.buildTx({ asset: ATOM, to: fresh('friend'), amount: 0n, fee: { family: 'cosmos' }, max: true });
    expect(u.amount + u.maxFee).toBe(42_350_000n);
    await atom.signTx(u, PASSWORD);
    expect(dialogs[0]).toContain('AUCUN MÉMO');
  });

  it('refusals: self-send, over balance, stale sequence, wrong password, rejected dialog', async () => {
    const atom = createAdapters(accounts).cosmos!;
    expect((await err(atom.buildTx({ asset: ATOM, to: accounts.cosmos.address, amount: 1n, fee: { family: 'cosmos' } }))).message).toMatch(/soi-même/);
    expect((await err(atom.buildTx({ asset: ATOM, to: fresh('a'), amount: 42_350_000n, fee: { family: 'cosmos' } }))).message).toMatch(/insuffisant/);
    const u = await atom.buildTx({ asset: ATOM, to: fresh('a'), amount: 1_000n, fee: { family: 'cosmos' } });
    expect((await err(atom.signTx(u, 'wrong password!'))).code).toBe('WRONG_PASSWORD');
    // Another send consumes the sequence: the first one is stale.
    const v = await atom.buildTx({ asset: ATOM, to: fresh('b'), amount: 1_000n, fee: { family: 'cosmos' } });
    await atom.broadcast(await atom.signTx(v, PASSWORD));
    expect((await err(atom.signTx(u, PASSWORD))).message).toMatch(/séquence périmé/);
    // Timeout height passed (100 blocks ≈ 10 min).
    const w = await atom.buildTx({ asset: ATOM, to: fresh('c'), amount: 1_000n, fee: { family: 'cosmos' } });
    mock.advance(11 * 60_000);
    expect((await err(atom.signTx(w, PASSWORD))).message).toMatch(/expirée/);
    // Rejected in the native dialog.
    const rejecting = createMockBackend({ network: 'testnet', torEnabled: false, confirm: () => false, preset: { password: PASSWORD, unlocked: true } });
    setBackend(rejecting.invoke);
    const r = createAdapters(await call('accounts_get')).cosmos!;
    const x = await r.buildTx({ asset: ATOM, to: fresh('d'), amount: 1_000n, fee: { family: 'cosmos' } });
    expect((await err(r.signTx(x, PASSWORD))).code).toBe('USER_REJECTED');
    // A memo with a line break never reaches Rust.
    expect((await err(atom.buildTx({ asset: ATOM, to: fresh('e'), amount: 1n, fee: { family: 'cosmos' }, memo: 'a\nb' }))).message).toMatch(/contrôle/);
  });

  it('a failed transaction in its block is reported (fee taken, amount not delivered)', async () => {
    const atom = createAdapters(accounts).cosmos!;
    mock.cosmos.failNext = 11;
    const u = await atom.buildTx({ asset: ATOM, to: fresh('f'), amount: 5_000_000n, fee: { family: 'cosmos' } });
    const s = await atom.signTx(u, PASSWORD);
    await atom.broadcast(s);
    mock.advance(7_000);
    expect(await atom.txStatus(s.hash)).toMatchObject({ included: true, success: false, code: 11 });
    expect((await atom.getBalance())[0]!.amount).toBe(42_350_000n - u.maxFee);
  });

  it('demo: other accounts are not simulated for signing', async () => {
    const e = await err(call('cosmos_build_tx', { to: fresh('g'), amount: '1', account: 1 }));
    expect(e.message).toMatch(/Cosmos/);
  });
});
