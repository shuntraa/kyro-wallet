// The demo XRP address derivation matches the Trezor firmware fixtures (`all ×12`,
// m/44'/144'/0'/0/0 = rNaqKtKr…, /0/1 = rBKz5MC2…), i.e. wallet-core's.
import { describe, expect, it } from 'vitest';
import { mnemonicToSeedSync } from '@scure/bip39';
import { checkXrpAddress, demoXrpAddress } from '../src/mock-xrp';

describe('demo XRP address', () => {
  it('derives like wallet-core (Trezor fixtures)', () => {
    const seed = mnemonicToSeedSync(Array(12).fill('all').join(' '));
    expect(demoXrpAddress(seed, 0)).toBe('rNaqKtKrMSwpwZSzRckPf7S96DkimjkF4H');
    expect(demoXrpAddress(seed, 1)).toBe('rBKz5MC2iXdoS3XgnNSYmF69K1Yo4NS3Ws');
  });

  it('checks the checksum and refuses X-addresses with the French messages of wallet-core', () => {
    expect(checkXrpAddress('rNaqKtKrMSwpwZSzRckPf7S96DkimjkF4H')).toBe('rNaqKtKrMSwpwZSzRckPf7S96DkimjkF4H');
    expect(() => checkXrpAddress('rNaqKtKrMSwpwZSzRckPf7S96DkimjkF4J')).toThrow(/adresse XRP invalide \(somme de contrôle\)/);
    expect(() => checkXrpAddress('XVLhHMPHU98es4dbozjVtdWzVrDjtV18pX8yuPT7y4xaEHi')).toThrow(/les X-addresses ne sont pas prises en charge/);
  });
});
