import { describe, expect, it } from 'vitest';
import { call, setBackend } from '@kyro/shared';
import { createMockBackend } from '@kyro/shared/mock';
import { createAdapters, nativeAssetId, tronChain, WATCH_ONLY_CHAINS } from '@kyro/chains';
import { serverDown, tronNoHistory } from '../components/ServerDown';

describe('TRON in the UI', () => {
  it('is a regular chain: not « Bientôt », native asset id `trx` (history fees, portfolio)', () => {
    expect(WATCH_ONLY_CHAINS.some((w) => w.key === 'tron')).toBe(false);
    expect(nativeAssetId(tronChain('testnet'))).toBe('trx');
  });

  it('a java-tron node without /v1: history unavailable, NOT « ton serveur ne répond pas »', async () => {
    setBackend(createMockBackend({ network: 'testnet', torEnabled: false, preset: { password: 'correct horse', unlocked: true } }).invoke);
    const s = await call('settings_get');
    await call('settings_set', { settings: { ...s, servers: { ...s.servers, tron: { testnet: { kind: 'http', url: 'https://tron.my-node.example' } } } } });
    const accounts = await call('accounts_get');
    const e = await createAdapters(accounts).tron!.getHistory().catch((x: unknown) => x);
    expect(tronNoHistory(e)).toBe(true);
    expect(serverDown(e)).toBe(false);
    const down = 'Serveur injoignable : tron-down.example : délai de connexion dépassé';
    expect(tronNoHistory(down)).toBe(false);
  });
});
