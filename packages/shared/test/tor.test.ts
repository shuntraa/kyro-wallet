import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { call, IpcError, isTorUnavailable, onIpcError, onTorStatus, setBackend, torRetry, torStatus, type TorStatus } from '../src';
import { createMockBackend, type MockOptions } from '../src/mock';
import { DEMO_TOR_BOOTSTRAP_MS } from '../src/mock-tor';

const MARKETS = 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=eur&per_page=10';

async function rejection(p: Promise<unknown>): Promise<IpcError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(IpcError);
    return e as IpcError;
  }
  throw new Error('expected rejection');
}

/** The demo net adds 60–180 ms of fake latency: advance the fake clock while awaiting. */
async function settle<T>(p: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(500);
  return p;
}

let events: TorStatus[] = [];
let unlisten: (() => void) | null = null;

async function setup(opts: MockOptions = {}) {
  unlisten = await onTorStatus((s) => events.push(s));
  const mock = createMockBackend({ network: 'testnet', confirm: () => true, ...opts });
  setBackend(mock.invoke);
  return mock;
}

beforeEach(() => {
  vi.useFakeTimers();
  events = [];
});

afterEach(() => {
  unlisten?.();
  unlisten = null;
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('mock Tor simulation', () => {
  it('bootstraps from 0 to 100 % in about 2 s, then ready, with one event per step', async () => {
    await setup({ tor: 'bootstrap' });
    expect(await torStatus()).toEqual({ state: 'bootstrapping', progress: 0 });
    await vi.advanceTimersByTimeAsync(DEMO_TOR_BOOTSTRAP_MS / 2);
    const mid = await torStatus();
    expect(mid.state).toBe('bootstrapping');
    expect(mid.progress).toBeGreaterThanOrEqual(40);
    expect(mid.progress).toBeLessThanOrEqual(60);
    await vi.advanceTimersByTimeAsync(DEMO_TOR_BOOTSTRAP_MS / 2 + 50);
    expect(await torStatus()).toEqual({ state: 'ready', progress: 100 });

    // Events: bootstrapping 0 → … (non-decreasing, ≤ 99) → ready 100, nothing after.
    expect(events[0]).toEqual({ state: 'bootstrapping', progress: 0 });
    expect(events.at(-1)).toEqual({ state: 'ready', progress: 100 });
    const booting = events.filter((e) => e.state === 'bootstrapping').map((e) => e.progress);
    expect(booting.length).toBeGreaterThan(10);
    expect(booting.every((p, i) => p <= 99 && (i === 0 || p >= (booting[i - 1] ?? 0)))).toBe(true);
    const count = events.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(events.length).toBe(count);
  });

  it('net_fetch waits for the bootstrap, then goes through (Tor ready)', async () => {
    await setup({ tor: 'bootstrap' });
    let done = false;
    const p = call('net_fetch', { req: { url: MARKETS, method: 'GET' } }).then((r) => {
      done = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(DEMO_TOR_BOOTSTRAP_MS / 2);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(DEMO_TOR_BOOTSTRAP_MS);
    expect((await p).status).toBe(200);
  });

  it('?tor=fail: error state, net_fetch fails closed with TOR_UNAVAILABLE, retry fails again', async () => {
    await setup({ tor: 'fail' });
    const pending = rejection(call('net_fetch', { req: { url: MARKETS, method: 'GET' } }));
    await vi.advanceTimersByTimeAsync(DEMO_TOR_BOOTSTRAP_MS);
    const st = await torStatus();
    expect(st.state).toBe('error');
    expect(st.message).toBeTruthy();
    // The request that was waiting is rejected, not served in clear.
    const waiting = await pending;
    expect(waiting.code).toBe('TOR_UNAVAILABLE');
    expect(isTorUnavailable(waiting)).toBe(true);
    // New requests fail immediately.
    const err = await rejection(call('net_fetch', { req: { url: MARKETS, method: 'GET' } }));
    expect(err.code).toBe('TOR_UNAVAILABLE');
    expect(err.message).toMatch(/^Tor indisponible/);
    // Settings untouched: still Tor.
    expect((await call('settings_get')).tor).toEqual({ enabled: true });

    expect(await torRetry()).toEqual({ state: 'bootstrapping', progress: 0 });
    await vi.advanceTimersByTimeAsync(DEMO_TOR_BOOTSTRAP_MS);
    expect((await torStatus()).state).toBe('error');
  });

  it('?tor=fail-once: the first bootstrap fails, Retry succeeds', async () => {
    await setup({ tor: 'fail-once' });
    await vi.advanceTimersByTimeAsync(DEMO_TOR_BOOTSTRAP_MS);
    expect((await torStatus()).state).toBe('error');
    await torRetry();
    await vi.advanceTimersByTimeAsync(DEMO_TOR_BOOTSTRAP_MS + 50);
    expect((await torStatus()).state).toBe('ready');
    expect((await settle(call('net_fetch', { req: { url: MARKETS, method: 'GET' } }))).status).toBe(200);
  });

  it('disabling Tor in the settings stops it (direct connection); re-enabling bootstraps again', async () => {
    await setup({ tor: 'fail' });
    await vi.advanceTimersByTimeAsync(DEMO_TOR_BOOTSTRAP_MS);
    const s = await call('settings_get');
    expect(s.tor.enabled).toBe(true);
    const off = await call('settings_set', { settings: { ...s, tor: { enabled: false } } });
    expect(off.tor.enabled).toBe(false);
    expect(await torStatus()).toEqual({ state: 'off', progress: 0 });
    expect(events.at(-1)).toEqual({ state: 'off', progress: 0 });
    // Only now (explicit choice) does net_fetch go out directly.
    expect((await settle(call('net_fetch', { req: { url: MARKETS, method: 'GET' } }))).status).toBe(200);
    expect((await rejection(torRetry())).code).toBe('INVALID_INPUT');

    await call('settings_set', { settings: { ...off, tor: { enabled: true } } });
    expect((await torStatus()).state).toBe('bootstrapping');
  });

  it('defaults: Tor enabled, ready at once outside a browser; `?tor=off` equivalent starts disabled', async () => {
    await setup();
    expect((await call('settings_get')).tor).toEqual({ enabled: true });
    expect(await torStatus()).toEqual({ state: 'ready', progress: 100 });
    setBackend(createMockBackend({ network: 'testnet', torEnabled: false }).invoke);
    expect((await call('settings_get')).tor).toEqual({ enabled: false });
    expect((await torStatus()).state).toBe('off');
  });

  it('settings_set rejects a malformed tor field and defaults a missing one to enabled', async () => {
    await setup();
    const s = await call('settings_get');
    expect((await rejection(call('settings_set', { settings: { ...s, tor: { enabled: 'no' as unknown as boolean } } }))).code).toBe('INVALID_INPUT');
    const { tor: _tor, ...withoutTor } = s;
    const saved = await call('settings_set', { settings: withoutTor as typeof s });
    expect(saved.tor).toEqual({ enabled: true });
  });

  it('every rejected command is observable through onIpcError (TOR_UNAVAILABLE included)', async () => {
    await setup({ tor: 'fail' });
    await vi.advanceTimersByTimeAsync(DEMO_TOR_BOOTSTRAP_MS);
    const seen: Array<[string, string]> = [];
    const un = onIpcError((cmd, e) => seen.push([cmd, e.code]));
    await rejection(call('net_fetch', { req: { url: MARKETS, method: 'GET' } }));
    un();
    await rejection(call('net_fetch', { req: { url: MARKETS, method: 'GET' } }));
    expect(seen).toEqual([['net_fetch', 'TOR_UNAVAILABLE']]);
  });
});

describe('isTorUnavailable', () => {
  it('recognises the code and the shell message, nothing else', () => {
    expect(isTorUnavailable(new IpcError('TOR_UNAVAILABLE', 'x'))).toBe(true);
    expect(isTorUnavailable({ code: 'TOR_UNAVAILABLE', message: 'x' })).toBe(true);
    expect(isTorUnavailable(new Error('Solana : Tor indisponible : délai de démarrage dépassé'))).toBe(true);
    expect(isTorUnavailable('Tor indisponible : Tor arrêté')).toBe(true);
    expect(isTorUnavailable(new IpcError('INTERNAL', 'réseau (Tor) : délai dépassé'))).toBe(false);
    expect(isTorUnavailable(new Error('HTTP 500'))).toBe(false);
    expect(isTorUnavailable(null)).toBe(false);
  });
});
