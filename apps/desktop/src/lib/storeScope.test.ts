// SPDX-License-Identifier: GPL-3.0-or-later
// The records of the second password's session live apart from the real ones (docs/IPC.md §2.9c).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CoinGeckoClient } from '@kyro/market';
import { fr } from '../i18n/fr';
import { en } from '../i18n/en';

const SCOPE = 'p-testnet';

type Mods = {
  storage: typeof import('./storage');
  balances: typeof import('./balanceCache');
  charts: typeof import('./chartCache');
  alerts: typeof import('./alerts');
};

/** A fresh webview: the modules start again, the disk stays. */
async function boot(scope: string | null): Promise<Mods> {
  vi.resetModules();
  const storage = await import('./storage');
  storage.applyStoreScope(scope);
  return { storage, balances: await import('./balanceCache'), charts: await import('./chartCache'), alerts: await import('./alerts') };
}

let disk: Map<string, string>;

const tx = (id: string) => ({ id, network: 'testnet' as const, chainKey: 'btc', assetId: 'btc', kind: 'transfer' as const, direction: 'out' as const, amount: '1', time: 1, status: 'pending' as const });
const contact = (name: string) => ({ id: name, name, address: `addr-${name}`, family: 'btc' as const, sends: 0 });

beforeEach(() => {
  disk = new Map();
  const localStorage = {
    get length() {
      return disk.size;
    },
    key: (i: number) => [...disk.keys()][i] ?? null,
    getItem: (k: string) => disk.get(k) ?? null,
    setItem: (k: string, v: string) => void disk.set(k, v),
    removeItem: (k: string) => void disk.delete(k),
  };
  vi.stubGlobal('window', { localStorage });
});

describe('store scope', () => {
  it('keeps the historical keys in a real session', async () => {
    const { storage } = await boot(null);
    storage.saveContacts([contact('a')]);
    expect([...disk.keys()]).toEqual(['kyro.contacts']);
  });

  it('shows nothing of the real records to that session, and the reverse', async () => {
    const real = await boot(null);
    real.storage.saveContacts([contact('real')]);
    real.storage.setFavorites(['bitcoin']);
    real.storage.addLocalTx(tx('real-tx'));
    real.storage.setBackupState('confirmed');
    real.alerts.saveAlertSettings({ received: true, prices: [] });
    real.storage.writeJson('accountSelection.testnet', { btc: 3 });
    real.storage.writeJson('cache.async.staking', ['real pool']);
    real.balances.saveBalances('testnet', 'fp', new Map());
    real.balances.savePrices('eur', { bitcoin: { price: 1, change24h: null } } as never);
    real.charts.saveChart('eur', 'bitcoin', '1S' as never, [
      [1, 1],
      [2, 2],
    ]);
    const before = new Map(disk);

    const other = await boot(SCOPE);
    expect(other.storage.getContacts()).toEqual([]);
    expect(other.storage.getFavorites()).toEqual([]);
    expect(other.storage.getLocalTxs('testnet')).toEqual([]);
    expect(other.storage.getBackupState()).toBe('unknown');
    expect(other.alerts.getAlertSettings().received).not.toBe(true);
    expect(other.storage.readJson('accountSelection.testnet', null)).toBeNull();
    expect(other.storage.readJson('cache.async.staking', null)).toBeNull();
    expect(other.balances.loadPrices('eur')).toEqual({});
    expect(other.charts.loadChart('eur', 'bitcoin', '1S' as never)).toBeNull();

    other.storage.saveContacts([contact('own')]);
    other.storage.setFavorites(['monero']);
    other.storage.addLocalTx(tx('own-tx'));
    other.storage.setBackupState('imported');
    other.alerts.saveAlertSettings({ received: false, prices: [] });
    other.charts.saveChart('eur', 'monero', '1S' as never, [
      [1, 1],
      [2, 2],
    ]);
    for (const [k, v] of before) expect(disk.get(k), k).toBe(v);
    expect([...disk.keys()].filter((k) => !before.has(k)).every((k) => k.startsWith(`kyro@${SCOPE}.`))).toBe(true);

    const back = await boot(null);
    expect(back.storage.getContacts().map((c) => c.name)).toEqual(['real']);
    expect(back.storage.getBackupState()).toBe('confirmed');
    expect(Object.keys(back.balances.loadPrices('eur'))).toEqual(['bitcoin']);
    expect(back.storage.getLocalTxs('testnet').map((t) => t.id)).toEqual(['real-tx']);
    const again = await boot(SCOPE);
    expect(again.storage.getContacts().map((c) => c.name)).toEqual(['own']);
  });

  it('removes a chart from its own side only', async () => {
    const real = await boot(null);
    real.storage.writeJson('cache.chart.eur.bitcoin.1S', [[1, 1]]);
    const other = await boot(SCOPE);
    other.storage.writeJson('cache.chart.eur.bitcoin.1S', [[1, 2]]);
    other.charts.remove('cache.chart.eur.bitcoin.1S');
    expect(disk.has('kyro.cache.chart.eur.bitcoin.1S')).toBe(true);
    expect(disk.has(`kyro@${SCOPE}.cache.chart.eur.bitcoin.1S`)).toBe(false);
  });

  it('asks for a reload when the session changes side, never at the first answer', async () => {
    const { storage } = await boot(null);
    expect(storage.applyStoreScope(SCOPE)).toBe(true);
    const other = await boot(SCOPE);
    expect(other.storage.applyStoreScope(SCOPE)).toBe(false);
    expect(other.storage.applyStoreScope(null)).toBe(true);
    vi.resetModules();
    const fresh = await import('./storage');
    expect(fresh.applyStoreScope(SCOPE)).toBe(false);
    expect(fresh.applyStoreScope(SCOPE)).toBe(false);
  });

  it('keeps the market cache apart too', async () => {
    const real = await boot(null);
    real.storage.scopedStorage.setItem('kyro.cg.x', 'real');
    const other = await boot(SCOPE);
    expect(other.storage.scopedStorage.getItem('kyro.cg.x')).toBeNull();
    other.storage.scopedStorage.setItem('kyro.cg.x', 'own');
    expect(disk.get('kyro.cg.x')).toBe('real');
    // `clear()` of the market client walks the keys it can see.
    new CoinGeckoClient({ storage: other.storage.scopedStorage }).clear();
    expect(other.storage.scopedStorage.getItem('kyro.cg.x')).toBeNull();
    expect(disk.get('kyro.cg.x')).toBe('real');
  });

  it('clears one scope and nothing else', async () => {
    const real = await boot(null);
    real.storage.saveContacts([contact('real')]);
    const other = await boot(SCOPE);
    other.storage.saveContacts([contact('own')]);
    other.storage.scopedStorage.setItem('kyro.cg.x', 'own');
    const after = await boot(null);
    after.storage.purgeStoreScope('');
    expect(disk.size).toBe(3);
    after.storage.purgeStoreScope(SCOPE);
    expect([...disk.keys()]).toEqual(['kyro.contacts']);
  });
});

describe('guard rails', () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(name) && !/\.test\./.test(name) ? [p] : [];
    });

  it('every read and write of local storage goes through storage.ts', () => {
    const root = join(__dirname, '..');
    const direct = files(root).filter((p) => !p.endsWith(join('lib', 'storage.ts')) && /\b(localStorage|sessionStorage|indexedDB)\s*[.[]/.test(readFileSync(p, 'utf8')));
    expect(direct).toEqual([]);
  });

  it('the Settings section never names what it is for', () => {
    const secret = /duress|decoy|leurre|contrainte|coercion/i;
    for (const catalog of [fr, en]) {
      for (const [k, v] of Object.entries(catalog)) {
        if (k.startsWith('wallets.')) expect(secret.test(v), k).toBe(false);
      }
    }
  });
});
