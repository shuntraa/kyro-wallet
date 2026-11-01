// Polkadot end to end against the demo backend: typed dot_* commands, accounts_get, the
// existential deposit and keep-alive spendable, the SS58 prefix of the network, the checks of
// what Rust built, signature + broadcast, follow-up by nonce. Also: the demo SS58 encoder gives
// the same addresses as Polkadot.js (vectors of crates/wallet-core/tests/polkadot.rs).
import { beforeEach, describe, expect, it } from 'vitest';
import { call, IpcError, setBackend, type Accounts } from '@kyro/shared';
import { createMockBackend, dotSs58Decode, dotSs58Encode, type MockBackend } from '@kyro/shared/mock';
import { assetsFor, createAdapters, dotAddressProblem, findAsset, isDotAddress, outgoingHosts, PolkadotAdapter, polkadotChain, rustDotBackend, signAndBroadcast, WATCH_ONLY_CHAINS } from '../src';

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

const hexToBytes = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
const WND = findAsset('testnet', 'dot')!;
const UNIT = 10n ** 12n;

beforeEach(async () => {
  dialogs = [];
  mock = createMockBackend({ network: 'testnet', torEnabled: false, confirm: (t) => (dialogs.push(t), true), preset: { password: PASSWORD, unlocked: true } });
  setBackend(mock.invoke);
  accounts = await call('accounts_get');
});

describe('SS58 (demo encoder = Polkadot.js)', () => {
  it('encodes and decodes the Polkadot.js vectors, refuses a bad checksum', () => {
    const pk = hexToBytes('66933bd1f37070ef87bd1198af3dacceb095237f803f3d32b173e6b425ed7972');
    expect(dotSs58Encode(pk, 0)).toBe('13KVd4f2a4S5pLp4gTTFezyXdPWx27vQ9vS6xBXJ9yWVd7xo');
    expect(dotSs58Encode(pk, 42)).toBe('5EPCUjPxiHAcNooYipQFWr9NmmXJKpNG5RhcntXwbtUySrgH');
    expect(dotSs58Decode('15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5')?.prefix).toBe(0);
    expect(dotSs58Decode('13KVd4f2a4S5pLp4gTTFezyXdPWx27vQ9vS6xBXJ9yWVd7xp')).toBeNull();
  });
});

describe('Polkadot in the app', () => {
  it('is a full chain: DOT / WND asset, Parity node in the outgoing list', () => {
    expect(WATCH_ONLY_CHAINS.map((w) => w.key)).not.toContain('polkadot');
    expect(WND).toMatchObject({ family: 'dot', kind: 'native', symbol: 'WND', decimals: 12, chainKey: 'polkadot', coingeckoId: 'polkadot' });
    expect(findAsset('mainnet', 'dot')).toMatchObject({ symbol: 'DOT', decimals: 10 });
    expect(assetsFor('mainnet').some((a) => a.id === 'dot')).toBe(true);
    expect(outgoingHosts('testnet').map((h) => h.host)).toContain('westend-asset-hub-rpc.polkadot.io');
    expect(outgoingHosts('mainnet').map((h) => h.host)).toContain('polkadot-asset-hub-rpc.polkadot.io');
  });

  it('addresses: prefix of the network only', () => {
    expect(isDotAddress(accounts.polkadot.address, 'testnet')).toBe(true);
    expect(isDotAddress('13KVd4f2a4S5pLp4gTTFezyXdPWx27vQ9vS6xBXJ9yWVd7xo', 'testnet')).toBe(false);
    expect(isDotAddress('13KVd4f2a4S5pLp4gTTFezyXdPWx27vQ9vS6xBXJ9yWVd7xo', 'mainnet')).toBe(true);
    expect(dotAddressProblem('5EPCUjPxiHAcNooYipQFWr9NmmXJKpNG5RhcntXwbtUySrgH', 'mainnet')).toMatch(/format générique/);
    expect(dotAddressProblem('13KVd4f2a4S5pLp4gTTFezyXdPWx27vQ9vS6xBXJ9yWVd7xo', 'testnet')).toMatch(/mainnet/);
  });

  it('balance, spendable = free − max(frozen, ED), backend info', async () => {
    const dot = createAdapters(accounts).polkadot!;
    expect(dot.getAddress()).toBe(accounts.polkadot.address);
    expect(await call('dot_address')).toBe(accounts.polkadot.address);
    expect(await dot.getBalance()).toEqual([{ assetId: 'dot', amount: 12_500_000_000_000n, spendable: 10_500_000_000_000n }]);
    expect(await call('dot_backend_info')).toMatchObject({ chain: 'Westend Asset Hub', symbol: 'WND', decimals: 12, ss58: 42, label: 'westend-asset-hub-rpc.polkadot.io' });
    expect(await dot.getHistory()).toEqual([]);
  });

  it('hardware-wallet accounts have no Polkadot adapter (HW_UNSUPPORTED)', () => {
    const { polkadot: _p, xrp: _x, tron: _t, ltc: _l, doge: _d, cardano: _c, ...hw } = accounts;
    const ad = createAdapters(hw, undefined, undefined, { accountId: 'hw-1', device: 'ledger' });
    expect(ad.polkadot).toBeNull();
  });

  it('refusals before building: existential deposit, balance, own address, other network', async () => {
    const dot = createAdapters(accounts).polkadot!;
    const stranger = dotSs58Encode(new Uint8Array(32).fill(7), 42);
    expect((await err(dot.buildTransfer(stranger, UNIT / 10_000n))).message).toMatch(/dépôt existentiel \(0,001 WND\)/);
    expect((await err(dot.buildTransfer(mock.dot.friend, 11n * UNIT))).message).toMatch(/solde disponible insuffisant/);
    expect((await err(dot.buildTransfer(accounts.polkadot.address, UNIT))).message).toMatch(/soi-même/);
    expect((await err(dot.buildTransfer('13KVd4f2a4S5pLp4gTTFezyXdPWx27vQ9vS6xBXJ9yWVd7xo', UNIT))).message).toMatch(/mainnet/);
    expect((await err(call('dot_build_tx', { to: '13KVd4f2a4S5pLp4gTTFezyXdPWx27vQ9vS6xBXJ9yWVd7xo', amount: '1' }))).message).toMatch(/préfixe SS58 0/);
  });

  it('build → sign (native dialog) → broadcast → finalized; max = spendable − fee', async () => {
    const dot = createAdapters(accounts).polkadot!;
    const u = await dot.buildTransfer(mock.dot.friend, 2n * UNIT);
    expect(u.summary).toMatchObject({ call: 'Balances.transfer_keep_alive', to: mock.dot.friend, amount: (2n * UNIT).toString(), tip: '0', nonce: 3 });
    expect(u.maxFee).toBe(155n * UNIT / 10_000n);
    const id = await signAndBroadcast(dot, u, PASSWORD);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(dialogs[0]).toMatch(/Envoi Polkadot — Westend Asset Hub \(testnet\)/);
    expect(dialogs[0]).toMatch(/Montant : 2 WND/);
    expect((await dot.txStatus(3, u.context.validUntil)).state).toBe('pending');
    mock.advance(6_000);
    expect((await dot.txStatus(3, u.context.validUntil)).state).toBe('finalized');
    expect((await dot.account()).nonce).toBe(4);
    // Same payload again: the nonce is stale.
    expect((await err(dot.signTx(u, PASSWORD))).message).toMatch(/nonce périmé/);
    // MAX: everything spendable minus the fee.
    const all = await dot.buildTx({ asset: WND, to: mock.dot.friend, amount: 0n, fee: { family: 'dot' }, max: true });
    const me = await dot.account();
    expect(all.amount + all.maxFee).toBe(BigInt(me.spendable));
  });

  it('history: unavailable on Westend; Statescan entries mapped; any failure = unavailable, never an error', async () => {
    const dot = createAdapters(accounts).polkadot!;
    expect(await dot.getHistory()).toEqual([]);
    expect(dot.historyStatus).toBe('unavailable');
    expect(outgoingHosts('mainnet').map((h) => h.host)).toEqual(expect.arrayContaining(['ahp-api.statescan.io', 'polkadot-api.statescan.io']));
    expect(outgoingHosts('testnet').map((h) => h.host)).not.toContain('ahp-api.statescan.io');
    const me = '13KVd4f2a4S5pLp4gTTFezyXdPWx27vQ9vS6xBXJ9yWVd7xo';
    const other = '15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5';
    const items = [
      { id: '0xab', hash: '0xab', chain: 'assetHub' as const, blockHeight: 9, extrinsicIndex: 2, eventIndex: 3, time: 2000, from: other, to: me, amount: '25000000000', direction: 'in' as const },
      { id: 'relay:5-1', chain: 'relay' as const, blockHeight: 5, extrinsicIndex: 1, time: 1000, from: me, to: other, amount: '7', direction: 'out' as const },
      { id: 'bad', chain: 'assetHub' as const, blockHeight: 1, time: 1, from: me, to: other, amount: '-1', direction: 'out' as const },
    ];
    const withTxs = (txs: () => Promise<unknown>) => new PolkadotAdapter({ chain: polkadotChain('mainnet'), address: me, backend: { ...rustDotBackend(), txs: txs as never } });
    const ok = withTxs(() => Promise.resolve({ available: true, partial: true, items }));
    const h = await ok.getHistory();
    expect(ok.historyStatus).toBe('partial');
    expect(h).toHaveLength(2);
    expect(h[0]).toMatchObject({ id: '0xab', assetId: 'dot', direction: 'in', amount: 25_000_000_000n, counterparty: other, time: 2000, status: 'confirmed', kind: 'transfer' });
    expect(h[1]).toMatchObject({ direction: 'out', counterparty: other });
    expect(h[1]?.note).toBeTruthy();
    const down = withTxs(() => Promise.reject(new Error('boom')));
    expect(await down.getHistory()).toEqual([]);
    expect(down.historyStatus).toBe('unavailable');
    const odd = withTxs(() => Promise.resolve({ available: true, partial: false, items: 'nope' }));
    expect(await odd.getHistory()).toEqual([]);
    expect(odd.historyStatus).toBe('unavailable');
  });

  it('refuses a transfer Rust built differently from the request', async () => {
    const real = await call('dot_build_tx', { to: mock.dot.friend, amount: '1000000000000' });
    const backend = { ...rustDotBackend(), build: () => Promise.resolve({ ...real, summary: { ...real.summary, amount: '9' } }) };
    const lying = new PolkadotAdapter({ chain: polkadotChain('testnet'), address: accounts.polkadot.address, backend });
    expect((await err(lying.buildTransfer(mock.dot.friend, UNIT))).message).toMatch(/ne correspond pas/);
  });
});
