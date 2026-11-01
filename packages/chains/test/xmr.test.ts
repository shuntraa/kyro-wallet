// SPDX-License-Identifier: GPL-3.0-or-later
//
// Monero: XmrAdapter against a fake Rust backend (shape checks, what Rust built = what was asked,
// sign = publish), then end to end against the demo backend (scan, unlock rule, subaddresses,
// prepare / send, servers). The demo addresses are well-formed but NOT derived from the seed:
// the real mapping is tested in Rust (crates/wallet-core/tests/monero.rs).

import { beforeEach, describe, expect, it } from 'vitest';
import { call, EMPTY_SERVERS, IpcError, setBackend, type Accounts, type XmrStatus, type XmrTxSummary } from '@kyro/shared';
import { checkXmrAddress, createMockBackend, demoXmrAddress, demoXmrIntegrated, type MockBackend } from '@kyro/shared/mock';
import { addressParts, createAdapters, findAsset, isLookalike, isXmrAddress, outgoingHosts, xmrChain, xmrHeightAt, XmrAdapter, type XmrBackend } from '../src';

// Real addresses (wallet-core vectors, mnemonic « abandon … about », account 0).
const MAIN = '49vDbkSo7eve3J41sBdjvjaBUyz8qHohsQcGtRf63qEUTMBvmA45fpp5pSacMdSg7A3b71RejLzB8EkGbfjp5PELVF2N4Zn';
const STAGE = '5A8FgbMkmG2e3J41sBdjvjaBUyz8qHohsQcGtRf63qEUTMBvmA45fpp5pSacMdSg7A3b71RejLzB8EkGbfjp5PELVHCRUaE';
const SUB_MAIN = '8AB7PQPtducdkghYFN2prK3rZ7zPeL9f2REEdqE4WXYbSZr3797Aqti5xAjRsVy4jTdcwMW11GWejQtqk2kNXxj2QZxJwPZ';
const SUB_STAGE = '79y5JZUvzJWdkghYFN2prK3rZ7zPeL9f2REEdqE4WXYbSZr3797Aqti5xAjRsVy4jTdcwMW11GWejQtqk2kNXxj2QWJ9bkP';

const status = (over: Partial<XmrStatus> = {}): XmrStatus => ({
  running: false, restoreHeight: 2_000_000, scanned: 2_000_100, tip: 2_000_100, tipTime: 1_793_000_000, progress: 1, balance: '3000000000000', unlocked: '2500000000000',
  syncedAt: 1_793_000_000, error: null, subaddresses: 1, ignoredOutputs: 0, node: 'monero-stagenet.stackwallet.com', ...over,
});

function summary(to: string, amount: string, over: Partial<XmrTxSummary> = {}): XmrTxSummary {
  return {
    network: 'stagenet', account: 0, destination: { address: to, kind: 'subaddress' }, amount, fee: '120000000', change: '1', inputsTotal: '2500000000000', inputCount: 1, ringSize: 16,
    feePerWeight: '80000', warnings: [], requiresExtraConfirmation: false, ...over,
  };
}

function backend(over: Partial<XmrBackend> = {}): XmrBackend & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    status: async () => (calls.push('status'), status()),
    sync: async () => (calls.push('sync'), status()),
    txs: async () => [
      { txid: 'aa'.repeat(32), direction: 'out', amount: '1000000000000', fee: '120000000', to: SUB_STAGE, height: 0, time: 1_793_000_000, confirmations: 0 },
      { txid: 'bb'.repeat(32), direction: 'in', amount: '2500000000000', fee: null, to: null, height: 2_000_095, time: 1_792_999_000, confirmations: 5 },
    ],
    subaddresses: async () => [],
    newSubaddress: async () => ({ index: 1, address: SUB_STAGE, received: '0' }),
    validate: async (address) => ({ address, kind: 'subaddress' }),
    setRestoreHeight: async () => status(),
    prepare: async (to, amount) => (calls.push(`prepare:${amount ?? 'max'}`), { id: 'id1', summary: summary(to, amount ?? '2499880000000') }),
    send: async (id) => (calls.push(`send:${id}`), { txid: 'cd'.repeat(32), summary: summary(SUB_STAGE, '1000000000000') }),
    showSeed: async () => undefined,
    ...over,
  };
}

const XMR = findAsset('testnet', 'xmr')!;

describe('XmrAdapter', () => {
  it('address shapes per network (Rust decodes the rest)', () => {
    expect(isXmrAddress(MAIN, 'mainnet')).toBe(true);
    expect(isXmrAddress(SUB_MAIN, 'mainnet')).toBe(true);
    expect(isXmrAddress(STAGE, 'mainnet')).toBe(false);
    expect(isXmrAddress(STAGE, 'testnet')).toBe(true);
    expect(isXmrAddress(SUB_STAGE, 'testnet')).toBe(true);
    expect(isXmrAddress(MAIN, 'testnet')).toBe(false);
    expect(isXmrAddress(MAIN.slice(0, -1), 'mainnet')).toBe(false);
    expect(isXmrAddress(`${MAIN.slice(0, -1)}0`, 'mainnet')).toBe(false); // '0' is not base58
    expect(isXmrAddress(demoXmrIntegrated('mainnet', 0, new Uint8Array(8)), 'mainnet')).toBe(true);
    expect(isXmrAddress('bc1qxyz', 'mainnet')).toBe(false);
    expect(() => new XmrAdapter({ chain: xmrChain('testnet'), address: MAIN, backend: backend() })).toThrow(/invalide/);
  });

  it('balance = everything not spent, spendable = unlocked; a scanned account is caught up', async () => {
    const b = backend();
    const a = new XmrAdapter({ chain: xmrChain('testnet'), address: STAGE, backend: b });
    expect(await a.getBalance()).toEqual([{ assetId: 'xmr', amount: 3_000_000_000_000n, spendable: 2_500_000_000_000n }]);
    expect(b.calls).toEqual(['status', 'sync']);
    const never = backend({ status: async () => status({ restoreHeight: null, balance: '0', unlocked: '0' }) });
    await new XmrAdapter({ chain: xmrChain('testnet'), address: STAGE, backend: never }).getBalance();
    expect(never.calls).not.toContain('sync');
  });

  it('buildTx checks what Rust built; sign publishes, broadcast only returns the txid', async () => {
    const b = backend();
    const a = new XmrAdapter({ chain: xmrChain('testnet'), address: STAGE, backend: b });
    const fee = (await a.estimateFees()).options.normal.params;
    const u = await a.buildTx({ asset: XMR, to: SUB_STAGE, amount: 1_000_000_000_000n, fee });
    expect(u).toMatchObject({ family: 'xmr', id: 'id1', amount: 1_000_000_000_000n, maxFee: 120_000_000n, recipient: SUB_STAGE });
    const max = await a.buildTx({ asset: XMR, to: SUB_STAGE, amount: 0n, fee, max: true });
    expect(max.amount).toBe(2_499_880_000_000n);
    expect(b.calls).toContain('prepare:max');
    const s = await a.signTx(u, 'pw');
    expect(await a.broadcast(s)).toBe('cd'.repeat(32));
    expect(b.calls.filter((c) => c.startsWith('send'))).toEqual(['send:id1']);
    // Rust built something else: refused.
    const liar = new XmrAdapter({ chain: xmrChain('testnet'), address: STAGE, backend: backend({ prepare: async (to) => ({ id: 'x', summary: summary(to, '999') }) }) });
    await expect(liar.buildTx({ asset: XMR, to: SUB_STAGE, amount: 1_000n, fee })).rejects.toThrow(/ne correspond pas/);
    const other = new XmrAdapter({ chain: xmrChain('testnet'), address: STAGE, backend: backend({ prepare: async () => ({ id: 'x', summary: summary(STAGE, '1000') }) }) });
    await expect(other.buildTx({ asset: XMR, to: SUB_STAGE, amount: 1_000n, fee })).rejects.toThrow(/ne correspond pas/);
    await expect(a.buildTx({ asset: XMR, to: MAIN, amount: 1n, fee })).rejects.toThrow(/invalide/);
  });

  it('history: pending sends, locked receptions', async () => {
    const a = new XmrAdapter({ chain: xmrChain('testnet'), address: STAGE, backend: backend() });
    const h = await a.getHistory();
    expect(h[0]).toMatchObject({ direction: 'out', status: 'pending', counterparty: SUB_STAGE, fee: 120_000_000n, time: 1_793_000_000_000 });
    expect(h[1]).toMatchObject({ direction: 'in', status: 'confirmed', amount: 2_500_000_000_000n });
    expect(h[1]!.note).toMatch(/5\/10/);
    expect(h[1]!.fee).toBeUndefined();
  });

  it('restore height from a date (2 min per block); poisoning check skips the first char', () => {
    expect(xmrHeightAt(1_793_000_000 - 86_400, 2_000_000, 1_793_000_000)).toBe(2_000_000 - 720);
    expect(xmrHeightAt(0, 100, 1_793_000_000)).toBe(0);
    expect(addressParts(MAIN, 'xmr').prefix).toBe('4');
    const twin = `${MAIN.slice(0, 5)}${'1'.repeat(MAIN.length - 9)}${MAIN.slice(-4)}`;
    expect(isLookalike(twin, MAIN, 'xmr')).toBe(true);
    expect(isLookalike(SUB_MAIN, MAIN, 'xmr')).toBe(false);
  });
});

// ---------------------------------------------------------------- demo backend

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

beforeEach(async () => {
  dialogs = [];
  mock = createMockBackend({ network: 'testnet', torEnabled: false, confirm: (t) => (dialogs.push(t), true), preset: { password: PASSWORD, unlocked: true } });
  setBackend(mock.invoke);
  accounts = await call('accounts_get');
});

describe('Monero in the app (demo backend)', () => {
  it('is a full chain: XMR asset (12 decimals), stagenet on testnet, node in the outgoing list', () => {
    expect(XMR).toMatchObject({ family: 'xmr', kind: 'native', symbol: 'XMR', decimals: 12, chainKey: 'monero', coingeckoId: 'monero' });
    expect(xmrChain('testnet').name).toBe('Monero stagenet');
    expect(outgoingHosts('testnet').map((h) => h.host)).toContain('monero-stagenet.stackwallet.com:38081');
    expect(outgoingHosts('mainnet').map((h) => h.host)).toContain('xmr-node.cakewallet.com:18081');
    const custom = outgoingHosts('testnet', { ...EMPTY_SERVERS, monero: { testnet: { kind: 'node', url: 'https://my-node.example:38089' } } });
    expect(custom.find((h) => h.host === 'my-node.example:38089')).toMatchObject({ custom: true });
  });

  it('scan, unlock rule, subaddresses, prepare and send', async () => {
    expect(accounts.xmr.path).toBe("m/44'/128'/0'/0/0");
    expect(isXmrAddress(accounts.xmr.address, 'testnet')).toBe(true);
    const xmr = createAdapters(accounts).xmr!;
    expect(xmr.getAddress()).toBe(accounts.xmr.address);
    // Not scanned yet: no restore height, nothing to send.
    expect((await xmr.status()).restoreHeight).toBeNull();
    expect((await err(call('xmr_prepare_tx', { to: demoXmrAddress('testnet', 9, 1), amount: '1' }))).message).toMatch(/synchronisation incomplète/);
    let s = await xmr.sync();
    for (let i = 0; i < 10 && (s.running || s.progress < 1); i++) s = await xmr.status();
    expect(s.progress).toBe(1);
    expect(BigInt(s.balance)).toBe(2_750_000_000_000n);
    // The 0.35 XMR received 4 blocks ago is still locked.
    expect(BigInt(s.unlocked)).toBe(2_400_000_000_000n);
    const subs = await call('xmr_subaddresses');
    expect(subs.map((x) => x.index)).toEqual([0, 1]);
    expect(subs[0]!.address).toBe(accounts.xmr.address);
    const next = await call('xmr_new_subaddress');
    expect(next.index).toBe(2);
    expect(await call('xmr_address', { index: 2 })).toBe(next.address);
    // Destinations decoded like Rust.
    expect(await call('xmr_validate_address', { address: mock.xmr.friend })).toMatchObject({ kind: 'subaddress' });
    expect(checkXmrAddress(demoXmrIntegrated('testnet', 3, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), 'testnet')).toMatchObject({ kind: 'integrated', paymentId: '0102030405060708' });
    expect((await err(call('xmr_validate_address', { address: MAIN }))).message).toMatch(/mainnet : Kyro est sur stagenet/);
    // Above the unlocked balance: refused.
    expect((await err(call('xmr_prepare_tx', { to: mock.xmr.friend, amount: '2600000000000' }))).message).toMatch(/fonds insuffisants/);
    const fee = (await xmr.estimateFees()).options.normal.params;
    const u = await xmr.buildTx({ asset: XMR, to: mock.xmr.friend, amount: 1_000_000_000_000n, fee });
    expect(u.summary).toMatchObject({ inputCount: 1, ringSize: 16, inputsTotal: '2400000000000', change: '1399880000000' });
    const signed = await xmr.signTx(u, PASSWORD);
    expect(dialogs.at(-1)).toMatch(/Envoi Monero \(stagenet\)/);
    expect(await xmr.broadcast(signed)).toBe(signed.txid);
    // Single use.
    expect((await err(call('xmr_send_tx', { id: u.id, password: PASSWORD }))).message).toMatch(/inconnu ou expiré/);
    const h = await xmr.getHistory();
    expect(h[0]).toMatchObject({ direction: 'out', status: 'pending', counterparty: mock.xmr.friend });
    s = await xmr.status();
    expect(BigInt(s.unlocked)).toBe(0n);
    expect(BigInt(s.balance)).toBe(350_000_000_000n + 1_399_880_000_000n);
  });

  it('wrong password and refused dialog: nothing sent', async () => {
    const xmr = createAdapters(accounts).xmr!;
    let s = await xmr.sync();
    for (let i = 0; i < 10 && s.running; i++) s = await xmr.status();
    const prep = await call('xmr_prepare_tx', { to: mock.xmr.friend });
    expect(BigInt(prep.summary.amount)).toBe(2_400_000_000_000n - 120_000_000n);
    expect((await err(call('xmr_send_tx', { id: prep.id, password: 'wrong password' }))).code).toBe('WRONG_PASSWORD');
    expect((await xmr.getHistory()).every((t) => t.direction === 'in')).toBe(true);
  });

  it('servers: probe, wrong network, down; seed only in a native window', async () => {
    const ok = await call('server_test', { target: { family: 'monero', network: 'testnet', server: { kind: 'node', url: 'https://my-node.example:38089' } } });
    expect(ok.detected.network).toBe('stagenet');
    expect((await err(call('server_test', { target: { family: 'monero', network: 'testnet', server: { kind: 'node', url: 'https://wrong.example:38089' } } }))).code).toBe('SERVER_WRONG_NETWORK');
    expect((await err(call('server_test', { target: { family: 'monero', network: 'testnet', server: { kind: 'node', url: 'https://down.example:38089' } } }))).code).toBe('SERVER_UNREACHABLE');
    expect(await call('xmr_seed_show', { password: PASSWORD })).toBeNull();
    expect((await err(call('xmr_seed_show', { password: 'nope nope nope' }))).code).toBe('WRONG_PASSWORD');
  });
});
