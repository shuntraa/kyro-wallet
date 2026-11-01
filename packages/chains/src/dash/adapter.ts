// SPDX-License-Identifier: GPL-3.0-or-later
// Dash: BIP44 legacy P2PKH, `m/44'/5'/0'` (testnet: `m/44'/1'/0'`), `X…` / `y…` (P2SH `7…` / `8…`).

import * as bitcoin from 'bitcoinjs-lib';
import type { Network } from '@kyro/shared';
import { UtxoAdapter, type UtxoAdapterOptions, type UtxoCoinSpec } from '../utxo/utxo';
import { bchDashDust } from '../bitcoincash/adapter';

export const DASH_NETWORKS: Record<Network, bitcoin.Network> = {
  mainnet: {
    messagePrefix: '\x19DarkCoin Signed Message:\n',
    // Dash has no bech32 addresses; `acceptAddress` refuses anything that is not base58.
    bech32: 'xdash',
    bip32: { public: 0x0488b21e, private: 0x0488ade4 },
    pubKeyHash: 0x4c,
    scriptHash: 0x10,
    wif: 0xcc,
  },
  testnet: {
    messagePrefix: '\x19DarkCoin Signed Message:\n',
    bech32: 'tdash',
    bip32: { public: 0x043587cf, private: 0x04358394 },
    pubKeyHash: 0x8c,
    scriptHash: 0x13,
    wif: 0xef,
  },
};

export const DASH_SPEC: UtxoCoinSpec = {
  prefix: 'dash',
  own: 'p2pkh',
  network: (n) => DASH_NETWORKS[n],
  model: { overhead: 10, input: 148 },
  minOutput: bchDashDust,
  needsPrevTx: true,
  unit: 'duffs',
  minRate: 1,
  rateHint: (r) => `${r} duff/octet`,
  acceptAddress: (address, net) => {
    try {
      const { version } = bitcoin.address.fromBase58Check(address);
      return version === net.pubKeyHash || version === net.scriptHash;
    } catch {
      return false;
    }
  },
};

export class DashAdapter extends UtxoAdapter {
  declare readonly family: 'dash';
  constructor(opts: UtxoAdapterOptions) {
    super(DASH_SPEC, opts);
  }
}
