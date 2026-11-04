// The UI never round-trips an API key: what it sends to settings_set carries a key value only when
// the user just typed it, and never anything read back from the shell.
import { describe, expect, it } from 'vitest';
import { call, setBackend, type Settings } from '@kyro/shared';
import { createMockBackend } from '@kyro/shared/mock';
import { settingsPayload } from './settingsPayload';

const SECRET = 'zx-SECRET-abcdef';

describe('settings_set payload', () => {
  it('drops apiKeysSet and any stray apiKeys; adds only the explicit update', () => {
    const s = { currency: 'EUR', autoLockSecs: 900, hideBalancesOnStart: false, captureProtection: true, clipboardGuard: true, servers: { bitcoin: {}, evm: {}, solana: {}, litecoin: {}, dogecoin: {}, bitcoincash: {}, dash: {}, tron: {}, xrp: {}, cardano: {} }, apiKeysSet: { zerox: true }, tor: { enabled: true }, language: 'auto', autoUpdate: true, weeklyCount: true, closeToTray: false, lockOnHide: true, startMinimized: false } satisfies Settings;
    // An object that (wrongly) carries a key value, e.g. from an older shell: never re-sent.
    const leaky = { ...s, apiKeys: { zerox: SECRET } } as Settings;
    expect(settingsPayload(leaky)).not.toHaveProperty('apiKeys');
    expect(settingsPayload(leaky)).not.toHaveProperty('apiKeysSet');
    expect(JSON.stringify(settingsPayload(leaky))).not.toContain(SECRET);
    expect(settingsPayload(s, { trongrid: ' tg ' }).apiKeys).toEqual({ trongrid: 'tg' });
    expect(settingsPayload(s, { coingecko: '' }).apiKeys).toEqual({ coingecko: '' });
    expect(settingsPayload(s, {})).not.toHaveProperty('apiKeys');
  });

  it('the weekly count toggle is on by default and saved when turned off', async () => {
    const mock = createMockBackend({ network: 'testnet', torEnabled: true, preset: { password: 'correct horse', unlocked: true } });
    setBackend(async (cmd, args) => mock.invoke(cmd, args));
    let settings = await call('settings_get');
    expect(settings.weeklyCount).toBe(true);
    expect(settingsPayload({ ...settings, weeklyCount: false }).weeklyCount).toBe(false);
    settings = await call('settings_set', { settings: settingsPayload({ ...settings, weeklyCount: false }) });
    expect(settings.weeklyCount).toBe(false);
    expect((await call('settings_get')).weeklyCount).toBe(false);
  });

  it('end to end: after a key is saved, every later save sends no key at all', async () => {
    const sent: unknown[] = [];
    const mock = createMockBackend({ network: 'testnet', torEnabled: false, preset: { password: 'correct horse', unlocked: true } });
    setBackend(async (cmd, args) => {
      if (cmd === 'settings_set') sent.push(structuredClone(args));
      return mock.invoke(cmd, args);
    });
    let settings = await call('settings_get');
    settings = await call('settings_set', { settings: settingsPayload(settings, { zerox: SECRET }) });
    expect(settings.apiKeysSet.zerox).toBe(true);
    settings = await call('settings_set', { settings: settingsPayload({ ...settings, currency: 'USD' }) });
    settings = await call('settings_set', { settings: settingsPayload({ ...settings, tor: { enabled: false } }) });
    expect(settings.apiKeysSet.zerox).toBe(true);
    expect(sent).toHaveLength(3);
    // The value left the UI exactly once (the explicit save), never again.
    expect(sent.filter((p) => JSON.stringify(p).includes(SECRET))).toHaveLength(1);
    expect((sent[1] as { settings: object }).settings).not.toHaveProperty('apiKeys');
    expect((sent[2] as { settings: object }).settings).not.toHaveProperty('apiKeys');
    expect(JSON.stringify(settings)).not.toContain(SECRET);
  });
});
