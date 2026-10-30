import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { call, emitDemoEvent, IpcError, onIpcError, onTorStatus, setBackend, torRetry, type InvokeFn, type TorStatus } from '@kyro/shared';
import { createMockBackend, DEMO_TOR_BOOTSTRAP_MS, type DemoTorScenario } from '@kyro/shared/mock';
import { createTorStore, torDetail, torIndicator, torWaiting, type TorStore, type TorStoreDeps } from './tor';

const MARKETS = 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=eur&per_page=10';

const realDeps: TorStoreDeps = {
  fetchStatus: () => call('tor_status'),
  retry: torRetry,
  listen: onTorStatus,
  onIpcError,
};

/** Every command the UI sent, to prove nothing switched Tor off behind the user's back. */
let sent: string[] = [];
let store: TorStore;

function useMock(tor: DemoTorScenario, override?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> | undefined) {
  const mock = createMockBackend({ network: 'testnet', confirm: () => true, tor });
  const invoke: InvokeFn = (cmd, args) => {
    sent.push(cmd);
    return override?.(cmd, args) ?? mock.invoke(cmd, args);
  };
  setBackend(invoke);
  return mock;
}

async function startStore(deps: TorStoreDeps = realDeps, enabled = true): Promise<TorStore> {
  store = createTorStore(deps);
  store.setEnabled(enabled);
  await store.start();
  return store;
}

async function rejects(p: Promise<unknown>): Promise<IpcError> {
  try {
    await p;
  } catch (e) {
    return e as IpcError;
  }
  throw new Error('expected rejection');
}

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
});

afterEach(() => {
  store?.stop();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('Tor store: state', () => {
  it('reads tor_status at start, then follows tor-status events', async () => {
    useMock('bootstrap');
    const s = await startStore();
    expect(s.getSnapshot().status).toEqual({ state: 'bootstrapping', progress: 0 });
    expect(torIndicator(s.getSnapshot())).toBe('bootstrapping');
    expect(torWaiting(s.getSnapshot())).toBe(true);

    const seen: number[] = [];
    s.subscribe(() => seen.push(s.getSnapshot().status?.progress ?? -1));
    await vi.advanceTimersByTimeAsync(DEMO_TOR_BOOTSTRAP_MS / 2);
    expect(s.getSnapshot().status?.progress).toBeGreaterThanOrEqual(40);
    await vi.advanceTimersByTimeAsync(DEMO_TOR_BOOTSTRAP_MS);
    expect(s.getSnapshot().status).toEqual({ state: 'ready', progress: 100 });
    expect(torIndicator(s.getSnapshot())).toBe('ready');
    expect(torWaiting(s.getSnapshot())).toBe(false);
    expect(seen.length).toBeGreaterThan(10);

    emitDemoEvent('tor-status', { state: 'error', progress: 0, message: 'boom' });
    expect(torIndicator(s.getSnapshot())).toBe('failed');
  });

  it('a late subscriber does not miss `ready` (it is in the tor_status snapshot)', async () => {
    useMock('ready');
    const s = await startStore();
    expect(s.getSnapshot().status).toEqual({ state: 'ready', progress: 100 });
    expect(s.getSnapshot().dialog).toBe('none');
  });

  it('an event received while tor_status is in flight wins over the (older) snapshot', async () => {
    let answer: (s: TorStatus) => void = () => undefined;
    const s = createTorStore({ ...realDeps, fetchStatus: () => new Promise<TorStatus>((r) => (answer = r)) });
    store = s;
    const started = s.start();
    await vi.advanceTimersByTimeAsync(0);
    emitDemoEvent('tor-status', { state: 'ready', progress: 100 });
    answer({ state: 'bootstrapping', progress: 97 });
    await started;
    expect(s.getSnapshot().status).toEqual({ state: 'ready', progress: 100 });
  });

  it('Tor disabled by the user shows the direct-connection state, never a protected one', async () => {
    useMock('ready');
    const s = await startStore(realDeps, false);
    emitDemoEvent('tor-status', { state: 'off', progress: 0 });
    expect(torIndicator(s.getSnapshot())).toBe('direct');
    expect(torWaiting(s.getSnapshot())).toBe(false);
  });

  it('torDetail drops the redundant « Tor indisponible : » prefixes', () => {
    expect(torDetail('Tor indisponible : Tor indisponible : no route')).toBe('no route');
    expect(torDetail('délai de démarrage dépassé')).toBe('délai de démarrage dépassé');
    expect(torDetail(undefined)).toBeNull();
  });
});

describe('Tor store: failure flow (never a silent fallback)', () => {
  it('a failed bootstrap opens the dialog; Cancel stays blocked; the same episode never reopens it', async () => {
    useMock('fail');
    const s = await startStore();
    expect(s.getSnapshot().dialog).toBe('none');
    await vi.advanceTimersByTimeAsync(DEMO_TOR_BOOTSTRAP_MS);
    expect(s.getSnapshot().status?.state).toBe('error');
    expect(s.getSnapshot().dialog).toBe('failure');
    expect(s.getSnapshot().episode?.reason).toBeTruthy();

    s.cancel();
    expect(s.getSnapshot().dialog).toBe('none');
    // Still blocked: requests fail closed, the dialog is not spammed, Tor stays on.
    for (let i = 0; i < 3; i++) expect((await rejects(call('net_fetch', { req: { url: MARKETS, method: 'GET' } }))).code).toBe('TOR_UNAVAILABLE');
    expect(s.getSnapshot().dialog).toBe('none');
    expect(torIndicator(s.getSnapshot())).toBe('failed');
    expect(s.getSnapshot().enabled).toBe(true);
    expect((await call('settings_get')).tor.enabled).toBe(true);
    expect(sent).not.toContain('settings_set');

    // The status bar can reopen it.
    s.openFailure();
    expect(s.getSnapshot().dialog).toBe('failure');
  });

  it('TOR_UNAVAILABLE from any net_fetch opens the dialog, even when the state looked fine', async () => {
    useMock('ready', (cmd) => (cmd === 'net_fetch' ? Promise.reject({ code: 'TOR_UNAVAILABLE', message: 'Tor indisponible : Tor n’est pas prêt' }) : undefined));
    const s = await startStore();
    expect(s.getSnapshot().dialog).toBe('none');
    const results = await Promise.allSettled([1, 2, 3].map(() => call('net_fetch', { req: { url: MARKETS, method: 'GET' } })));
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(s.getSnapshot().dialog).toBe('failure');
    expect(s.getSnapshot().episode?.reason).toMatch(/pas prêt/);
    // One dialog for the burst, and nothing was retried or switched to clear.
    expect(sent.filter((c) => c === 'net_fetch')).toHaveLength(3);
    expect(sent).not.toContain('settings_set');
  });

  it('Retry calls tor_retry and closes the dialog; a new failure is a new episode (dialog again); success closes it', async () => {
    useMock('fail');
    const s = await startStore();
    await vi.advanceTimersByTimeAsync(DEMO_TOR_BOOTSTRAP_MS);
    expect(s.getSnapshot().dialog).toBe('failure');

    await s.retry();
    expect(sent).toContain('tor_retry');
    expect(s.getSnapshot().dialog).toBe('none');
    expect(s.getSnapshot().episode).toBeNull();
    expect(torIndicator(s.getSnapshot())).toBe('bootstrapping');
    await vi.advanceTimersByTimeAsync(DEMO_TOR_BOOTSTRAP_MS);
    expect(s.getSnapshot().dialog).toBe('failure');

    // Tor finally comes up while the dialog is open: it closes by itself.
    emitDemoEvent('tor-status', { state: 'ready', progress: 100 });
    expect(s.getSnapshot().dialog).toBe('none');
    expect(s.getSnapshot().episode).toBeNull();
  });

  it('a failed tor_retry keeps the dialog open with the error', async () => {
    useMock('fail', (cmd) => (cmd === 'tor_retry' ? Promise.reject({ code: 'INTERNAL', message: 'Erreur interne : x' }) : undefined));
    const s = await startStore();
    await vi.advanceTimersByTimeAsync(DEMO_TOR_BOOTSTRAP_MS);
    await s.retry();
    expect(s.getSnapshot().dialog).toBe('failure');
    expect(s.getSnapshot().actionError).toBe('Erreur interne : x');
  });

  it('"Continuer sans Tor" from the failure dialog needs a second confirmation; its Cancel goes back, still blocked', async () => {
    useMock('fail');
    const s = await startStore();
    await vi.advanceTimersByTimeAsync(DEMO_TOR_BOOTSTRAP_MS);
    const save = vi.fn(async () => {
      const cur = await call('settings_get');
      await call('settings_set', { settings: { ...cur, tor: { enabled: false } } });
    });

    s.requestDisable('failure');
    expect(s.getSnapshot().dialog).toBe('confirm-direct');
    expect(save).not.toHaveBeenCalled();
    s.cancelDisable();
    expect(s.getSnapshot().dialog).toBe('failure');
    expect(save).not.toHaveBeenCalled();
    expect(sent).not.toContain('settings_set');

    s.requestDisable('failure');
    await s.confirmDisable(save);
    expect(save).toHaveBeenCalledTimes(1);
    expect(s.getSnapshot()).toMatchObject({ enabled: false, dialog: 'none', episode: null });
    expect(torIndicator(s.getSnapshot())).toBe('direct');
    expect((await call('settings_get')).tor.enabled).toBe(false);

    // Tor off by choice: no more failure dialogs.
    s.reportUnavailable('Tor indisponible : late');
    expect(s.getSnapshot().dialog).toBe('none');
  });
});

describe('Tor store: settings switch', () => {
  it('disabling requires the explicit confirmation; nothing is saved before it', async () => {
    useMock('ready');
    const s = await startStore();
    const save = vi.fn(async () => undefined);

    // confirmDisable without the confirmation dialog is a no-op.
    await s.confirmDisable(save);
    expect(save).not.toHaveBeenCalled();

    s.requestDisable('settings');
    expect(s.getSnapshot().dialog).toBe('confirm-direct');
    expect(save).not.toHaveBeenCalled();
    s.cancelDisable();
    expect(s.getSnapshot().dialog).toBe('none');
    expect(s.getSnapshot().enabled).toBe(true);
    expect(save).not.toHaveBeenCalled();

    s.requestDisable('settings');
    await s.confirmDisable(save);
    expect(save).toHaveBeenCalledTimes(1);
    expect(s.getSnapshot().enabled).toBe(false);
  });

  it('a failed save keeps Tor enabled and shows the error', async () => {
    useMock('ready');
    const s = await startStore();
    s.requestDisable('settings');
    await s.confirmDisable(() => Promise.reject(new IpcError('INVALID_INPUT', 'Réglages invalides.')));
    expect(s.getSnapshot().enabled).toBe(true);
    expect(s.getSnapshot().dialog).toBe('confirm-direct');
    expect(s.getSnapshot().actionError).toBe('Réglages invalides.');
  });

  it('re-enabling needs no confirmation and starts a bootstrap shown as progress', async () => {
    useMock('bootstrap');
    const s = await startStore();
    await vi.advanceTimersByTimeAsync(DEMO_TOR_BOOTSTRAP_MS + 50);
    const cur = await call('settings_get');
    await call('settings_set', { settings: { ...cur, tor: { enabled: false } } });
    s.setEnabled(false);
    expect(torIndicator(s.getSnapshot())).toBe('direct');

    const save = vi.fn(async () => {
      await call('settings_set', { settings: { ...cur, tor: { enabled: true } } });
    });
    await s.enable(save);
    expect(save).toHaveBeenCalledTimes(1);
    expect(s.getSnapshot().dialog).toBe('none');
    expect(torIndicator(s.getSnapshot())).toBe('bootstrapping');
    await vi.advanceTimersByTimeAsync(DEMO_TOR_BOOTSTRAP_MS / 2);
    expect(s.getSnapshot().status?.progress).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(DEMO_TOR_BOOTSTRAP_MS);
    expect(torIndicator(s.getSnapshot())).toBe('ready');
  });
});
