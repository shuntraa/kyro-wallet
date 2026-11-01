import { describe, expect, it } from 'vitest';
import { call, setBackend } from '@kyro/shared';
import { createMockBackend } from '@kyro/shared/mock';
import { assetsFor, createAdapters, outgoingHosts, WATCH_ONLY_CHAINS } from '@kyro/chains';
import { serverDown, serverMissing } from '../components/ServerDown';

describe('Litecoin / Dogecoin in the UI', () => {
  it('Dogecoin without a server is a missing setting (honest message), not a server down', async () => {
    setBackend(createMockBackend({ network: 'testnet', preset: { password: 'correct horse', unlocked: true } }).invoke);
    const accounts = await call('accounts_get');
    const e = await createAdapters(accounts).doge!.getBalance().catch((x: unknown) => x);
    expect(serverMissing(e)).toBe(true);
    expect(serverDown(e)).toBe(false);
    expect(serverMissing('Serveur injoignable : node.example : délai')).toBe(false);
  });

  it('LTC / DOGE are regular assets, not « Bientôt »; outgoing hosts list litecoinspace.org, Komodo ElectrumX on Dogecoin mainnet, no Dogecoin testnet default', () => {
    expect(WATCH_ONLY_CHAINS.some((w) => w.key === 'litecoin' || w.key === 'dogecoin')).toBe(false);
    expect(assetsFor('mainnet').map((a) => a.id)).toEqual(expect.arrayContaining(['ltc', 'doge']));
    const hosts = outgoingHosts('testnet');
    expect(hosts.find((h) => h.host === 'litecoinspace.org')?.purpose).toMatch(/Litecoin/);
    expect(hosts.find((h) => h.purpose.startsWith('Dogecoin'))?.purpose).toMatch(/aucun serveur public/);
    const main = outgoingHosts('mainnet').filter((h) => h.purpose.startsWith('Dogecoin'));
    // Same list as Rust's `net::ELECTRUM_HOSTS` (Dogecoin family).
    expect(main.map((h) => h.host)).toEqual(['doge.electrum1.cipig.net:20060', 'doge.electrum2.cipig.net:20060']);
    expect(main.some((h) => /aucun serveur/.test(h.purpose))).toBe(false);
    const custom = outgoingHosts('testnet', { bitcoin: {}, evm: {}, solana: {}, litecoin: {}, bitcoincash: {}, dash: {}, tron: {}, xrp: {}, cardano: {}, dogecoin: { testnet: { kind: 'esplora', url: 'https://my-doge.example/api' } } });
    expect(custom.find((h) => h.purpose.startsWith('Dogecoin'))).toMatchObject({ host: 'my-doge.example', custom: true });
  });

  it('hardware-wallet accounts have no Litecoin / Dogecoin adapters (HW_UNSUPPORTED)', () => {
    const ad = createAdapters({ network: 'testnet' }, undefined, undefined, { accountId: 'hw-0000000000000001', device: 'ledger' });
    expect(ad.ltc).toBeNull();
    expect(ad.doge).toBeNull();
  });
});
