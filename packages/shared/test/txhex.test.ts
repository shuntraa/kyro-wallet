import { describe, expect, it } from 'vitest';
import * as bitcoin from 'bitcoinjs-lib';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';
import { call, IpcError, setBackend } from '../src';
import { createMockBackend } from '../src/mock';

/** txid = double SHA-256 of the serialization (demo txs have no witness), byte-reversed. */
const txidOf = (hex: string) => bytesToHex(sha256(sha256(bitcoin.Transaction.fromHex(hex).toBuffer())).reverse());

describe('mock *_tx_hex: raw transactions whose hash matches the txid', () => {
  it('btc_tx_hex / ltc_tx_hex / doge_tx_hex for every demo UTXO', async () => {
    const mock = createMockBackend({ network: 'testnet', preset: { password: 'correct horse', unlocked: true } });
    setBackend(mock.invoke);
    const a = await call('accounts_get');
    const btcUtxos = await call('btc_address_utxos', { address: a.btc.segwit.address });
    expect(btcUtxos.length).toBeGreaterThan(0);
    for (const u of btcUtxos) {
      const hex = await call('btc_tx_hex', { txid: u.txid });
      expect(txidOf(hex)).toBe(u.txid);
      expect(Number(bitcoin.Transaction.fromHex(hex).outs[u.vout]?.value)).toBe(u.value);
    }
    for (const u of await call('ltc_address_utxos', { address: a.ltc.address })) expect(txidOf(await call('ltc_tx_hex', { txid: u.txid }))).toBe(u.txid);
    // Dogecoin needs a server first.
    await expect(call('doge_tx_hex', { txid: 'ab'.repeat(32) })).rejects.toMatchObject({ code: 'SERVER_INVALID' });
    const s = await call('settings_get');
    await call('settings_set', { settings: { ...s, servers: { ...s.servers, dogecoin: { testnet: { kind: 'esplora', url: 'https://my-doge.example/api' } } } } });
    for (const u of await call('doge_address_utxos', { address: a.doge.address })) expect(txidOf(await call('doge_tx_hex', { txid: u.txid }))).toBe(u.txid);
    const bad = await call('btc_tx_hex', { txid: 'xyz' }).catch((e: unknown) => e);
    expect((bad as IpcError).code).toBe('INVALID_INPUT');
  });
});
