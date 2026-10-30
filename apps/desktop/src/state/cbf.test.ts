import { afterEach, describe, expect, it, vi } from 'vitest';
import { call, emitDemoEvent, onCbfStatus, setBackend, type CbfStatus } from '@kyro/shared';
import { createMockBackend, DEMO_CBF_CONNECT_MS, DEMO_CBF_FILTERS_MS, DEMO_CBF_HEADERS_MS } from '@kyro/shared/mock';
import { cbfPhaseLabel, createCbfStore, type CbfStore } from './cbf';
import { estimateBirthHeight } from '../screens/settings/Servers';
import { cbfPending, serverDown } from '../components/ServerDown';

const deps = { fetchStatus: () => call('btc_cbf_status'), sync: () => call('btc_cbf_sync'), listen: onCbfStatus };
let store: CbfStore | null = null;

afterEach(() => {
  store?.stop();
  store = null;
  vi.clearAllTimers();
  vi.useRealTimers();
});

const base: CbfStatus = { state: 'idle', birthHeight: 0, progress: 0, peers: [], tor: true, watchedScripts: 40, matchedBlocks: 0 };

describe('CBF store', () => {
  it('today’s build (FEATURE_DISABLED): availability disabled, no status', async () => {
    setBackend(createMockBackend({ network: 'testnet', preset: { password: 'correct horse', unlocked: true } }).invoke);
    store = createCbfStore(deps);
    await store.start();
    expect(store.getSnapshot()).toEqual({ availability: 'disabled', status: null, error: null });
    await store.sync();
    expect(store.getSnapshot().availability).toBe('disabled');
  });

  it('?cbf=on: follows the cbf-status events of a sync up to synced', async () => {
    vi.useFakeTimers();
    setBackend(createMockBackend({ network: 'testnet', cbf: true, preset: { password: 'correct horse', unlocked: true } }).invoke);
    store = createCbfStore(deps);
    await store.start();
    expect(store.getSnapshot()).toMatchObject({ availability: 'available', status: { state: 'idle' } });
    const s = await call('settings_get');
    const saving = call('settings_set', { settings: { ...s, servers: { ...s.servers, bitcoin: { testnet4: { kind: 'cbf' } } } } });
    await vi.advanceTimersByTimeAsync(400);
    await saving;
    await store.sync();
    const seen = new Set<string>();
    store.subscribe(() => seen.add(store?.getSnapshot().status?.state ?? ''));
    await vi.advanceTimersByTimeAsync(DEMO_CBF_CONNECT_MS + DEMO_CBF_HEADERS_MS + DEMO_CBF_FILTERS_MS + 500);
    expect([...seen]).toEqual(['headers', 'filters', 'synced']);
    expect(store.getSnapshot().status).toMatchObject({ state: 'synced', progress: 1 });
    expect(store.getSnapshot().status?.peers.length).toBeGreaterThan(0);
  });

  it('an event received while btc_cbf_status is in flight wins over the older answer', async () => {
    let answer: (s: CbfStatus) => void = () => undefined;
    store = createCbfStore({ ...deps, fetchStatus: () => new Promise<CbfStatus>((r) => (answer = r)) });
    const started = store.start();
    await new Promise((r) => setTimeout(r, 0));
    emitDemoEvent('cbf-status', { ...base, state: 'filters', progress: 0.5 });
    answer({ ...base, state: 'idle' });
    await started;
    expect(store.getSnapshot().status).toMatchObject({ state: 'filters', progress: 0.5 });
    expect(cbfPhaseLabel(store.getSnapshot().status ?? base)).toBe('filtres');
  });
});

describe('CBF helpers', () => {
  it('birth height from a date: reference points minus a one-week margin, never negative', () => {
    expect(estimateBirthHeight('2024-04-20', 'mainnet')).toBeGreaterThan(838_000);
    expect(estimateBirthHeight('2024-04-20', 'mainnet')).toBeLessThan(840_000);
    expect(estimateBirthHeight('2020-01-01', 'testnet')).toBe(0);
    expect(estimateBirthHeight('not a date', 'testnet')).toBeNull();
  });

  it('« pas encore synchronisé » is a running sync, not a server down', () => {
    const m = 'Serveur injoignable : filtres compacts : pas encore synchronisé (synchronisation en cours)';
    expect(cbfPending(m)).toBe(true);
    expect(serverDown(m)).toBe(false);
    expect(serverDown('Serveur injoignable : node.example : délai')).toBe(true);
  });
});
