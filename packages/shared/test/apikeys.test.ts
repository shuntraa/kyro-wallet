// API keys are write-only: settings_get / settings_set return `apiKeysSet` (booleans), never a
// value; settings_set `apiKeys.<name>`: absent = unchanged, "" = remove, non-empty = set.
import { beforeEach, describe, expect, it } from 'vitest';
import { call, IpcError, setBackend, type Settings, type SettingsInput } from '../src';
import { createMockBackend } from '../src/mock';

const SECRET = 'cg-SECRET-0123456789';
const input = (s: Settings, apiKeys?: SettingsInput['apiKeys']): SettingsInput => {
  const { apiKeysSet: _set, ...rest } = s;
  return apiKeys ? { ...rest, apiKeys } : rest;
};

beforeEach(() => {
  setBackend(createMockBackend({ network: 'testnet', torEnabled: false, preset: { password: 'correct horse', unlocked: true } }).invoke);
});

describe('redacted API keys', () => {
  it('settings_get never returns key values, only which ones are set', async () => {
    const s = await call('settings_get');
    expect('apiKeys' in s).toBe(false);
    expect(s.apiKeysSet).toEqual({ coingecko: false, zerox: false, trongrid: false });
  });

  it('set, keep when absent, remove with "": the value is never echoed', async () => {
    const saved = await call('settings_set', { settings: input(await call('settings_get'), { coingecko: SECRET }) });
    expect(saved.apiKeysSet.coingecko).toBe(true);
    expect(JSON.stringify(saved)).not.toContain(SECRET);
    expect(JSON.stringify(await call('settings_get'))).not.toContain(SECRET);
    // Another change without apiKeys: the key stays.
    const again = await call('settings_set', { settings: { ...input(await call('settings_get')), currency: 'USD' } });
    expect(again).toMatchObject({ currency: 'USD', apiKeysSet: { coingecko: true } });
    // "" removes it; others untouched.
    await call('settings_set', { settings: input(again, { trongrid: 'tg' }) });
    const removed = await call('settings_set', { settings: input(await call('settings_get'), { coingecko: '' }) });
    expect(removed.apiKeysSet).toMatchObject({ coingecko: false, trongrid: true });
    expect((await call('config_get')).hasTrongridKey).toBe(true);
  });

  it('unknown key names and non-string values are refused', async () => {
    const s = input(await call('settings_get'));
    // null = unchanged (accepted), like Rust.
    await call('settings_set', { settings: { ...s, apiKeys: { zerox: null } } });
    for (const apiKeys of [{ etherscan: 'x' }, { zerox: 42 }, { zerox: '   ' }, { zerox: 'ab\u0007cd' }]) {
      const e = await call('settings_set', { settings: { ...s, apiKeys } as unknown as SettingsInput }).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(IpcError);
      expect((e as IpcError).code).toBe('INVALID_INPUT');
    }
  });
});
