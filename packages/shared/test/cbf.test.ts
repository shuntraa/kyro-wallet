import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { call, checkBtcServer, checkCbfPeer, IpcError, onCbfStatus, setBackend, type CbfStatus, type Settings } from '../src';
import { createMockBackend, DEMO_CBF_CONNECT_MS, DEMO_CBF_FILTERS_MS, DEMO_CBF_HEADERS_MS } from '../src/mock';

const ADDR_FROM_ACCOUNTS = async () => (await call('accounts_get')).btc.segwit.address;
const ONION = `${'a'.repeat(56)}.onion:48333`;

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(IpcError);
    return (e as IpcError).code;
  }
  throw new Error('expected rejection');
}

const withCbf = (s: Settings, server: { peers?: string[]; birthHeight?: number } = {}): Settings => ({ ...s, servers: { ...s.servers, bitcoin: { testnet4: { kind: 'cbf', ...server } } } });

let events: CbfStatus[] = [];
let unlisten: (() => void) | null = null;

beforeEach(async () => {
  events = [];
  unlisten = await onCbfStatus((s) => events.push(s));
});
afterEach(() => {
  unlisten?.();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('compact filters: peer rules', () => {
  it('ip:port, [v6]:port and onion v3 only, never a host name', () => {
    expect(checkCbfPeer('203.0.113.5:48333')).toBeNull();
    expect(checkCbfPeer('[2001:db8::1]:8333')).toBeNull();
    expect(checkCbfPeer(ONION)).toBeNull();
    expect(checkCbfPeer('node.example:8333')).toMatch(/nom d’hôte/);
    expect(checkCbfPeer('abc.onion:8333')).toMatch(/v3/);
    expect(checkCbfPeer('203.0.113.5')).toMatch(/hôte:port/);
    expect(checkCbfPeer('203.0.113.5:0')).toMatch(/port/);
    expect(checkBtcServer({ kind: 'cbf', peers: [ONION] }, false)).toMatch(/Tor/);
    expect(checkBtcServer({ kind: 'cbf', peers: [ONION, '203.0.113.5:48333'] }, false)).toBeNull();
    expect(checkBtcServer({ kind: 'cbf', birthHeight: -1 }, true)).toMatch(/hauteur/);
  });
});

describe('compact filters in a build without the `cbf` feature (default)', () => {
  it('answers FEATURE_DISABLED everywhere and saves nothing', async () => {
    setBackend(createMockBackend({ network: 'testnet', preset: { password: 'correct horse', unlocked: true } }).invoke);
    expect(await code(call('btc_cbf_status'))).toBe('FEATURE_DISABLED');
    expect(await code(call('btc_cbf_sync'))).toBe('FEATURE_DISABLED');
    const s = await call('settings_get');
    expect(await code(call('settings_set', { settings: withCbf(s) }))).toBe('FEATURE_DISABLED');
    expect(await code(call('server_test', { target: { family: 'bitcoin', network: 'testnet4', server: { kind: 'cbf' } } }))).toBe('FEATURE_DISABLED');
    expect((await call('settings_get')).servers.bitcoin.testnet4).toBeUndefined();
  });
});

describe('compact filters with ?cbf=on', () => {
  it('sync: connecting → headers → filters → synced, then reads come from the local state', async () => {
    vi.useFakeTimers();
    const mock = createMockBackend({ network: 'testnet', cbf: true, preset: { password: 'correct horse', unlocked: true } });
    setBackend(mock.invoke);
    const settle = async <T>(p: Promise<T>, ms = 400) => {
      await vi.advanceTimersByTimeAsync(ms);
      return p;
    };
    const s = await call('settings_get');
    await settle(call('settings_set', { settings: withCbf(s, { birthHeight: 90_000 }) }));
    expect((await call('btc_backend_info')).kind).toBe('cbf');
    expect((await call('btc_cbf_status')).state).toBe('idle');

    // Before the first sync: SERVER_UNREACHABLE, and the read starts a background sync.
    const address = await ADDR_FROM_ACCOUNTS();
    expect(await code(call('btc_address_info', { address }))).toBe('SERVER_UNREACHABLE');
    expect(events[0]?.state).toBe('connecting');

    await vi.advanceTimersByTimeAsync(DEMO_CBF_CONNECT_MS + DEMO_CBF_HEADERS_MS / 2);
    expect((await call('btc_cbf_status')).state).toBe('headers');
    await vi.advanceTimersByTimeAsync(DEMO_CBF_HEADERS_MS / 2 + DEMO_CBF_FILTERS_MS / 2);
    const mid = await call('btc_cbf_status');
    expect(mid.state).toBe('filters');
    expect(mid.progress).toBeGreaterThan(0.2);
    expect(mid.progress).toBeLessThan(0.9);
    expect(mid.birthHeight).toBe(90_000);
    expect(mid.scannedHeight).toBeGreaterThanOrEqual(90_000);
    expect(mid.peers.length).toBeGreaterThan(0);
    expect(mid.peers.every((p) => p.includes('.onion'))).toBe(true); // Tor: onion peers
    await vi.advanceTimersByTimeAsync(DEMO_CBF_FILTERS_MS);
    const done = await call('btc_cbf_status');
    expect(done).toMatchObject({ state: 'synced', progress: 1, tor: true });
    expect(done.lastSyncUnix).toBeGreaterThan(0);

    // Event order, at most 2 per second.
    const states = [...new Set(events.map((e) => e.state))];
    expect(states).toEqual(['connecting', 'headers', 'filters', 'synced']);
    const total = DEMO_CBF_CONNECT_MS + DEMO_CBF_HEADERS_MS + DEMO_CBF_FILTERS_MS;
    expect(events.length).toBeLessThanOrEqual(Math.ceil(total / 500) + 2);

    expect((await settle(call('btc_address_info', { address }), 50)).chain_stats.funded_txo_sum).toBeGreaterThan(0);
    expect(await settle(call('btc_fee_rates'), 50)).toMatchObject({ source: 'block-average' });
    expect(await settle(call('btc_tip_height'), 50)).toBe(98_430);
  });

  it('btc_cbf_sync needs the CBF server and an unlocked vault', async () => {
    const mock = createMockBackend({ network: 'testnet', cbf: true, preset: { password: 'correct horse', unlocked: true } });
    setBackend(mock.invoke);
    expect(await code(call('btc_cbf_sync'))).toBe('INVALID_INPUT');
    const s = await call('settings_get');
    await call('settings_set', { settings: withCbf(s) });
    await call('vault_lock');
    expect(await code(call('btc_cbf_sync'))).toBe('LOCKED');
  });
});
