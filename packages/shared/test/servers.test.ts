import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  call,
  checkBtcServer,
  checkServerUrl,
  coreIsLocal,
  fingerprintGroups,
  IpcError,
  isCustomServerDown,
  isPrivateHost,
  mergeServerSecrets,
  normalizeFingerprint,
  redactServers,
  setBackend,
  type Servers,
} from '../src';
import { createMockBackend, DEMO_RESCAN_MS } from '../src/mock';

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('server rules (mirror of servers.rs)', () => {
  it('private hosts', () => {
    for (const h of ['127.0.0.1', '10.0.0.5', '172.16.3.4', '192.168.1.10', '::1', '[::1]', 'fd12::1', 'fe80::1', 'localhost', '169.254.1.1', '::ffff:192.168.1.2']) expect(isPrivateHost(h), h).toBe(true);
    for (const h of ['8.8.8.8', '172.32.0.1', 'mempool.space', '2001:db8::1', 'example.onion']) expect(isPrivateHost(h), h).toBe(false);
  });

  it('URL rules: https; http only for .onion over Tor, or a local Core', () => {
    expect(checkServerUrl('https://node.example/api', false)).toBeNull();
    expect(checkServerUrl('https://u:p@node.example/api', true)).toMatch(/identifiants/);
    const onion = 'http://abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuv.onion/api';
    expect(checkServerUrl(onion, true)).toBeNull();
    expect(checkServerUrl(onion, false)).toMatch(/Tor/);
    expect(checkServerUrl('http://node.example/api', true)).not.toBeNull();
    expect(checkServerUrl('http://127.0.0.1:8332/', false, true)).toBeNull();
    expect(checkServerUrl('http://127.0.0.1:8332/', false, false)).not.toBeNull();
    expect(checkServerUrl('http://8.8.8.8:8332/', false, true)).not.toBeNull();
    expect(checkServerUrl('ftp://node.example/', true, true)).toMatch(/schéma/);
    expect(checkServerUrl('not a url', true)).toMatch(/invalide/);
    expect(coreIsLocal('http://192.168.1.5:48332')).toBe(true);
    expect(coreIsLocal('https://node.example:8332')).toBe(false);
  });

  it('Electrum: TLS off only for a .onion over Tor; pinned needs a 64-hex fingerprint', () => {
    const e = (host: string, tls: 'webpki' | 'pinned' | 'none', certSha256?: string) => ({ kind: 'electrum' as const, host, port: 50002, tls, ...(certSha256 ? { certSha256 } : {}) });
    expect(checkBtcServer(e('electrum.example', 'webpki'), false)).toBeNull();
    expect(checkBtcServer(e('electrum.example', 'none'), true)).toMatch(/onion/);
    expect(checkBtcServer(e('x.onion', 'none'), true)).toBeNull();
    expect(checkBtcServer(e('x.onion', 'none'), false)).toMatch(/Tor/);
    expect(checkBtcServer(e('electrum.example', 'pinned'), true)).toMatch(/64/);
    expect(checkBtcServer(e('electrum.example', 'pinned', 'AB:'.repeat(31) + 'AB'), true)).toBeNull();
    expect(checkBtcServer(e('bad host/x', 'webpki'), true)).toMatch(/hôte/);
  });

  it('fingerprints: normalized to 64 lowercase hex, shown as 16 groups of 4', () => {
    const hex = 'ab'.repeat(32);
    expect(normalizeFingerprint('AB:'.repeat(31) + 'AB')).toBe(hex);
    expect(normalizeFingerprint('abc')).toBeNull();
    const g = fingerprintGroups(hex);
    expect(g).toHaveLength(16);
    expect(g[0]).toBe('ABAB');
  });

  it('password: redacted for the UI; omitted = kept (same URL + user), "" = cleared, other user = dropped', () => {
    const stored: Servers = { bitcoin: { testnet4: { kind: 'core', url: 'http://127.0.0.1:48332', auth: { kind: 'userpass', user: 'kyro', password: 's3cret' } } }, evm: {}, solana: {} };
    const ui = redactServers(stored);
    expect(JSON.stringify(ui)).not.toContain('s3cret');
    expect(ui.bitcoin.testnet4).toMatchObject({ auth: { hasPassword: true } });
    expect(mergeServerSecrets(ui, stored).bitcoin.testnet4).toMatchObject({ auth: { password: 's3cret', hasPassword: true } });
    const cleared = structuredClone(ui);
    if (cleared.bitcoin.testnet4?.kind === 'core' && cleared.bitcoin.testnet4.auth.kind === 'userpass') cleared.bitcoin.testnet4.auth.password = '';
    expect(mergeServerSecrets(cleared, stored).bitcoin.testnet4).toMatchObject({ auth: { hasPassword: false } });
    const other = structuredClone(ui);
    if (other.bitcoin.testnet4?.kind === 'core' && other.bitcoin.testnet4.auth.kind === 'userpass') other.bitcoin.testnet4.auth.user = 'someone';
    expect(JSON.stringify(mergeServerSecrets(other, stored))).not.toContain('s3cret');
  });

  it('isCustomServerDown: codes and shell messages', () => {
    expect(isCustomServerDown(new IpcError('SERVER_UNREACHABLE', 'x'))).toBe(true);
    expect(isCustomServerDown(new IpcError('DEFAULT_SERVER_DISABLED', 'x'))).toBe(true);
    expect(isCustomServerDown(new IpcError('SERVER_INVALID', 'x'))).toBe(false);
    expect(isCustomServerDown('An unknown RPC error occurred.\n\nDetails: Serveur injoignable : rpc.example : délai')).toBe(true);
    expect(isCustomServerDown(new Error('HTTP 500'))).toBe(false);
  });
});

describe('mock: Bitcoin Core watch wallet', () => {
  it('setup with a date runs a rescan whose progress btc_core_status reports, then ready', async () => {
    vi.useFakeTimers();
    const mock = createMockBackend({ network: 'testnet', preset: { password: 'correct horse', unlocked: true } });
    setBackend(mock.invoke);
    const settle = async <T>(p: Promise<T>) => {
      await vi.advanceTimersByTimeAsync(400);
      return p;
    };
    const s = await call('settings_get');
    await settle(call('settings_set', { settings: { ...s, servers: { ...s.servers, bitcoin: { testnet4: { kind: 'core', url: 'http://127.0.0.1:48332', auth: { kind: 'cookie', cookiePath: '/home/me/.bitcoin/testnet4/.cookie' } } } } } }));
    expect((await settle(call('btc_core_status'))).state).toBe('idle');
    const started = await settle(call('btc_core_setup', { rescanFrom: 1_700_000_000 }));
    expect(started).toMatchObject({ state: 'importing', wallet: expect.stringMatching(/^kyro-watch-[0-9a-f]{8}$/) });
    await vi.advanceTimersByTimeAsync(1200 + DEMO_RESCAN_MS / 2);
    const mid = await settle(call('btc_core_status'));
    expect(mid.state).toBe('importing');
    expect(mid.scanProgress).toBeGreaterThan(0.3);
    expect(mid.scanProgress).toBeLessThan(0.8);
    await vi.advanceTimersByTimeAsync(DEMO_RESCAN_MS);
    const done = await settle(call('btc_core_status'));
    expect(done).toMatchObject({ state: 'ready', walletLoaded: true });
    expect(done.scanProgress).toBeUndefined();
    await expect(call('btc_core_setup', { rescanFrom: 'yesterday' as unknown as 'now' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('btc_core_* without a Core server is refused; locked vault is refused', async () => {
    const mock = createMockBackend({ network: 'testnet', preset: { password: 'correct horse', unlocked: false } });
    setBackend(mock.invoke);
    await expect(call('btc_core_status')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
