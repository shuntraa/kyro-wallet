// SPDX-License-Identifier: GPL-3.0-or-later
// Same vectors as crates/wallet-core/tests/kaspa.rs (rusty-kaspa v2.1.0 `crypto/addresses`).
import { describe, expect, it } from 'vitest';
import { hexToBytes } from '@noble/hashes/utils';
import { isKaspaAddress, kaspaAddressDecode, kaspaAddressEncode, kaspaAddressProblem } from '../src/kaspa';

describe('Kaspa addresses', () => {
  it('encodes the official vectors', () => {
    expect(kaspaAddressEncode('testnet', 'pubKey', new Uint8Array(32))).toBe('kaspatest:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqhqrxplya');
    expect(kaspaAddressEncode('testnet', 'pubKeyEcdsa', new Uint8Array(33))).toBe('kaspatest:qyqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqhe837j2d');
    expect(kaspaAddressEncode('testnet', 'pubKeyEcdsa', hexToBytes('ba01fc5f4e9d9879599c69a3dafdb835a7255e5f2e934e9322ecd3af190ab0f60e'))).toBe(
      'kaspatest:qxaqrlzlf6wes72en3568khahq66wf27tuhfxn5nytkd8tcep2c0vrse6gdmpks',
    );
    expect(kaspaAddressEncode('mainnet', 'pubKey', new Uint8Array(32))).toBe('kaspa:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkx9awp4e');
    expect(kaspaAddressEncode('mainnet', 'pubKey', hexToBytes('5fff3c4da18f45adcdd499e44611e9fff148ba69db3c4ea2ddd955fc46a59522'))).toBe(
      'kaspa:qp0l70zd5x85ttwd6jv7g3s3a8llzj96d8dncn4zmhv4tlzx5k2jyqh70xmfj',
    );
  });

  it('decodes and refuses like Rust', () => {
    const good = 'kaspa:qp0l70zd5x85ttwd6jv7g3s3a8llzj96d8dncn4zmhv4tlzx5k2jyqh70xmfj';
    expect(kaspaAddressDecode('mainnet', good)?.kind).toBe('pubKey');
    expect(isKaspaAddress('kaspa:qr85gz7hvp76mtws6p236uv5xxdk57dzfe4p06ues0rlqhtqy3rtqqx7eeq3u', 'mainnet')).toBe(true);
    for (const bad of [
      'kaspa:qqqqqqqqqqqqq1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkx9awp4e',
      'kaspa:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkx9awp4l',
      'kaspa:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkx9awp4e',
      good.toUpperCase(),
      good.slice(6),
    ]) {
      expect(isKaspaAddress(bad, 'mainnet')).toBe(false);
    }
    expect(isKaspaAddress(good, 'testnet')).toBe(false);
    expect(kaspaAddressProblem(good, 'testnet')).toContain('réseau principal');
    expect(kaspaAddressProblem(good.toUpperCase(), 'mainnet')).toContain('minuscules');
    expect(kaspaAddressProblem(good, 'mainnet')).toBeNull();
  });
});
