import { describe, expect, it } from 'vitest';
import { call, setBackend } from '@kyro/shared';
import { createMockBackend } from '@kyro/shared/mock';
import { createAdapters, isXAddress, nativeAssetId, WATCH_ONLY_CHAINS, xrpChain } from '@kyro/chains';
import { exchangeTagHint, XRP_ACTIVATION } from '../components/XrpSend';

describe('XRP Ledger in the UI', () => {
  it('is a regular chain: not « Bientôt », native asset `xrp`, 1 XRP activation, exchange hint', () => {
    expect(WATCH_ONLY_CHAINS.some((w) => w.key === 'xrp')).toBe(false);
    expect(nativeAssetId(xrpChain('testnet'))).toBe('xrp');
    expect(XRP_ACTIVATION).toBe(1_000_000n);
    expect(exchangeTagHint()).toBe('Les plateformes d’échange exigent presque toujours un tag : sans lui, les fonds peuvent être perdus.');
  });

  it('X-addresses are detected before Rust (the Send screen explains them)', () => {
    expect(isXAddress('XVLhHMPHU98es4dbozjVtdWzVrDjtV18pX8yuPT7y4xaEHi')).toBe(true);
    expect(isXAddress('rNaqKtKrMSwpwZSzRckPf7S96DkimjkF4H')).toBe(false);
    expect(isXAddress('TFz2CJn9CJb8C4i1Gke3jmZX2fRMJxniH2')).toBe(false);
  });

  it('the vault has an XRP adapter whose destination info drives the tag field', async () => {
    const mock = createMockBackend({ network: 'testnet', torEnabled: false, preset: { password: 'correct horse', unlocked: true } });
    setBackend(mock.invoke);
    const ad = createAdapters(await call('accounts_get'));
    expect((await ad.xrp!.destinationInfo(mock.xrp.exchange)).requireDestTag).toBe(true);
    expect((await ad.xrp!.destinationInfo(mock.xrp.friend)).requireDestTag).toBe(false);
  });
});
