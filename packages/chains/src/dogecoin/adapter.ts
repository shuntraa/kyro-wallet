// SPDX-License-Identifier: GPL-3.0-or-later
// Dogecoin: BIP44 legacy P2PKH, `m/44'/3'/0'` (testnet: `m/44'/1'/0'`), `D…` / `n…`. Kyro never creates an output under the soft limit: the recipient is refused, a smaller change is folded into the fee.

import * as bitcoin from 'bitcoinjs-lib';
import { intlLocale, type Network } from '@kyro/shared';
import { UtxoAdapter, type UtxoAdapterOptions, type UtxoCoinSpec } from '../utxo/utxo';

export const DOGECOIN_NETWORKS: Record<Network, bitcoin.Network> = {
  mainnet: {
    messagePrefix: '\x19Dogecoin Signed Message:\n',
    // Dogecoin has no bech32 addresses; `acceptAddress` refuses anything that is not base58.
    bech32: 'doge',
    bip32: { public: 0x02facafd, private: 0x02fac398 },
    pubKeyHash: 0x1e,
    scriptHash: 0x16,
    wif: 0x9e,
  },
  testnet: {
    messagePrefix: '\x19Dogecoin Signed Message:\n',
    bech32: 'tdge',
    bip32: { public: 0x043587cf, private: 0x04358394 },
    pubKeyHash: 0x71,
    scriptHash: 0xc4,
    wif: 0xf1,
  },
};

/** 0.01 DOGE/kB in koinus per byte. */
export const DOGE_RECOMMENDED_RATE = 1_000;
/** Soft dust limit, 0.01 DOGE. */
export const DOGE_SOFT_DUST = 1_000_000n;

export const DOGECOIN_SPEC: UtxoCoinSpec = {
  prefix: 'doge',
  own: 'p2pkh',
  network: (n) => DOGECOIN_NETWORKS[n],
  model: { overhead: 10, input: 148 },
  minOutput: () => DOGE_SOFT_DUST,
  needsPrevTx: true,
  unit: 'koinus',
  minRate: DOGE_RECOMMENDED_RATE,
  rateHint: (r) => `${(r / 100_000).toLocaleString(intlLocale(), { maximumFractionDigits: 5 })} DOGE/kB`,
  acceptAddress: (address, net) => {
    try {
      const { version } = bitcoin.address.fromBase58Check(address);
      return version === net.pubKeyHash || version === net.scriptHash;
    } catch {
      return false;
    }
  },
};

export class DogecoinAdapter extends UtxoAdapter {
  declare readonly family: 'doge';
  constructor(opts: UtxoAdapterOptions) {
    super(DOGECOIN_SPEC, opts);
  }
}
