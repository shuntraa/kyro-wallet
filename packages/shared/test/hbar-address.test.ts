// Hedera demo derivation and helpers against official vectors (same vectors as wallet-core's
// tests/hedera.rs): hiero-sdk-java MnemonicTest (toStandardECDSAsecp256k1PrivateKey) and HIP-15.
import { describe, expect, it } from 'vitest';
import { mnemonicToSeedSync } from '@scure/bip39';
import { HDKey } from '@scure/bip32';
import { demoHbarAddress, hbarChecksum, parseHbarRecipient } from '../src/mock-hbar';

const W24 = 'inmate flip alley wear offer often piece magnet surge toddler submit right radio absent pear floor belt raven price stove replace reduce plate home';
const W12 = 'finish furnace tomorrow wine mass goose festival air palm easy region guilt';
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

describe('Hedera demo keys', () => {
  it('m/44’/3030’/0’/0/i gives the SDK reference public keys', () => {
    const pk = (phrase: string, pass: string, i: number) => hex(HDKey.fromMasterSeed(mnemonicToSeedSync(phrase, pass)).derive(`m/44'/3030'/0'/0/${i}`).publicKey!);
    expect(pk(W24, '', 0)).toBe('03b1c064b4d04d52e51f6c8e8bb1bff75d62fa7b1446412d5901d424f6aedd6fd4');
    expect(pk(W24, 'some pass', 0)).toBe('0357d69bb36fee569838fe7b325c07ca511e8c1b222873cde93fc6bb541eb7ecea');
    expect(pk(W12, '', 0)).toBe('0294bf84a54806989a74ca4b76291d386914610b40b610d303162b9e495bc06416');
    const seed = mnemonicToSeedSync(W24);
    expect(demoHbarAddress(seed, 0)).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(demoHbarAddress(seed, 0)).not.toBe(demoHbarAddress(seed, 1));
  });

  it('HIP-15 checksums and recipients, like wallet-core', () => {
    expect(hbarChecksum('mainnet', 123)).toBe('vfmkw');
    expect(hbarChecksum('testnet', 123)).toBe('esxsf');
    expect(parseHbarRecipient('0.0.123-vfmkw', 'mainnet')).toEqual({ to: '0.0.123', isEvm: false, num: 123 });
    expect(() => parseHbarRecipient('0.0.123-esxsf', 'mainnet')).toThrow(/somme de contrôle/);
    expect(() => parseHbarRecipient('0.0.0123', 'mainnet')).toThrow();
    expect(() => parseHbarRecipient('0x0000000000000000000000000000000000000000', 'mainnet')).toThrow(/nulle/);
    expect(parseHbarRecipient('0xd8da6bf26964af9d7eed9e03e53415d37aa96045', 'mainnet')).toEqual({ to: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', isEvm: true, num: null });
  });
});
