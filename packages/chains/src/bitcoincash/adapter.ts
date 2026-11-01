// SPDX-License-Identifier: GPL-3.0-or-later
// Bitcoin Cash: BIP44 P2PKH, `m/44'/145'/0'` (chipnet: `m/44'/1'/0'`), CashAddr `bitcoincash:q…` / `bchtest:q…` only — the legacy `1…` / `3…` form is refused, it cannot be told apart from a Bitcoin address.

import type * as bitcoin from 'bitcoinjs-lib';
import { CASHADDR_PREFIX, cashaddrToScript, scriptToCashaddr, type Network } from '@kyro/shared';
import { UtxoAdapter, OUTPUT_BYTES, type UtxoAdapterOptions, type UtxoCoinSpec, type UtxoScriptType } from '../utxo/utxo';

/** bitcoinjs only uses these for its own checks; addresses go through CashAddr. */
export const BITCOINCASH_NETWORKS: Record<Network, bitcoin.Network> = {
  mainnet: { messagePrefix: '\x18Bitcoin Signed Message:\n', bech32: 'bitcoincash', bip32: { public: 0x0488b21e, private: 0x0488ade4 }, pubKeyHash: 0x00, scriptHash: 0x05, wif: 0x80 },
  testnet: { messagePrefix: '\x18Bitcoin Signed Message:\n', bech32: 'bchtest', bip32: { public: 0x043587cf, private: 0x04358394 }, pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef },
};

/** Bitcoin Cash Node / Dash Core `DUST_RELAY_TX_FEE`: 3 000 per kB, inputs counted at 148 bytes. */
export const BCH_DASH_DUST_RELAY_PER_KB = 3_000n;

/** `GetDustThreshold` of Bitcoin Cash Node / Dash Core: 546 for P2PKH, 540 for P2SH. */
export function bchDashDust(t: UtxoScriptType): bigint {
  return ((BigInt(OUTPUT_BYTES[t]) + 148n) * BCH_DASH_DUST_RELAY_PER_KB) / 1000n;
}

export const BITCOINCASH_SPEC: UtxoCoinSpec = {
  prefix: 'bch',
  own: 'p2pkh',
  network: (n) => BITCOINCASH_NETWORKS[n],
  model: { overhead: 10, input: 148 },
  minOutput: bchDashDust,
  needsPrevTx: true,
  unit: 'satoshis',
  minRate: 1,
  rateHint: (r) => `${r} sat/octet`,
  codec: {
    toScript: (address, network) => cashaddrToScript(address, CASHADDR_PREFIX[network]),
    toAddress: (script, network) => scriptToCashaddr(script, CASHADDR_PREFIX[network]),
  },
};

export class BitcoinCashAdapter extends UtxoAdapter {
  declare readonly family: 'bch';
  constructor(opts: UtxoAdapterOptions) {
    super(BITCOINCASH_SPEC, opts);
  }
}
