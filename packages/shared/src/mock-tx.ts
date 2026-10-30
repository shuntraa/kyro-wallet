// SPDX-License-Identifier: GPL-3.0-or-later
//
// DEMO ONLY — real (unsigned-input) funding transactions for the fake chains, so that every
// demo UTXO has a raw transaction whose txid (double SHA-256 of the serialization) is the
// UTXO's txid. `btc_tx_hex` / `ltc_tx_hex` / `doge_tx_hex` return them, and a PSBT can carry
// them as `non_witness_utxo` (bitcoinjs checks the hash, like Rust does).

import * as bitcoin from 'bitcoinjs-lib';
import { sha256 } from '@noble/hashes/sha2';

export interface DemoUtxo {
  txid: string;
  vout: number;
  value: number;
  height: number;
}

/** A transaction paying `value` to `script` at output 0 (plus a foreign output 1). */
export function demoFundingTx(seed: string, script: Uint8Array, value: number): { txid: string; hex: string } {
  const tx = new bitcoin.Transaction();
  tx.version = 1;
  const prev = sha256(new TextEncoder().encode(`kyro-demo-funding:${seed}`));
  tx.addInput(prev, 0, 0xffffffff, new Uint8Array([0x51]));
  tx.addOutput(script, BigInt(value));
  // A foreign output, like a real payment's change (P2WPKH of a hash: nobody we know).
  const other = sha256(new TextEncoder().encode(`kyro-demo-other:${seed}`)).slice(0, 20);
  tx.addOutput(new Uint8Array([0x00, 0x14, ...other]), 4_859n);
  return { txid: tx.getId(), hex: tx.toHex() };
}

/** Adds a funded UTXO for `address` (`net` = its network) to `utxos`, and its raw tx to `raw`. */
export function demoFund(utxos: Map<string, DemoUtxo[]>, raw: Map<string, string>, address: string, net: bitcoin.Network, seed: string, value: number, height: number): DemoUtxo {
  const { txid, hex } = demoFundingTx(`${seed}:${address}`, bitcoin.address.toOutputScript(address, net), value);
  raw.set(txid, hex);
  const u: DemoUtxo = { txid, vout: 0, value, height };
  utxos.set(address, [...(utxos.get(address) ?? []), u]);
  return u;
}
