// SPDX-License-Identifier: GPL-3.0-or-later
// Litecoin: BIP84 native SegWit (P2WPKH), `m/84'/2'/0'` (testnet4: `m/84'/1'/0'`), `ltc1…` / `tltc1…`.

import type * as bitcoin from 'bitcoinjs-lib';
import type { Network } from '@kyro/shared';
import { UtxoAdapter, type UtxoAdapterOptions, type UtxoCoinSpec, type UtxoScriptType, OUTPUT_BYTES } from '../utxo/utxo';

export const LITECOIN_NETWORKS: Record<Network, bitcoin.Network> = {
  mainnet: {
    messagePrefix: '\x19Litecoin Signed Message:\n',
    bech32: 'ltc',
    bip32: { public: 0x0488b21e, private: 0x0488ade4 },
    pubKeyHash: 0x30,
    // `M…`. The legacy `3…` form (version 5, Bitcoin's) is refused on purpose: a Bitcoin address pasted here would otherwise be accepted.
    scriptHash: 0x32,
    wif: 0xb0,
  },
  testnet: {
    messagePrefix: '\x19Litecoin Signed Message:\n',
    bech32: 'tltc',
    bip32: { public: 0x043587cf, private: 0x04358394 },
    pubKeyHash: 0x6f,
    scriptHash: 0x3a,
    wif: 0xef,
  },
};

/** Litecoin Core `DUST_RELAY_TX_FEE` = 30 000 litoshis/kvB: `GetDustThreshold` per output type. */
export const LITECOIN_DUST_RELAY_PER_KVB = 30_000n;

export function litecoinDust(t: UtxoScriptType): bigint {
  const spend = t === 'p2pkh' || t === 'p2sh' ? 148n : 67n;
  return ((BigInt(OUTPUT_BYTES[t]) + spend) * LITECOIN_DUST_RELAY_PER_KVB) / 1000n;
}

export const LITECOIN_SPEC: UtxoCoinSpec = {
  prefix: 'ltc',
  own: 'p2wpkh',
  network: (n) => LITECOIN_NETWORKS[n],
  model: { overhead: 10.5, input: 68 },
  minOutput: litecoinDust,
  needsPrevTx: false,
  unit: 'litoshis',
  // Litecoin Core minimum relay fee: 1 000 litoshis/kvB.
  minRate: 1,
  rateHint: (r) => `${r} litoshi/vB`,
};

export class LitecoinAdapter extends UtxoAdapter {
  declare readonly family: 'ltc';
  constructor(opts: UtxoAdapterOptions) {
    super(LITECOIN_SPEC, opts);
  }
}
