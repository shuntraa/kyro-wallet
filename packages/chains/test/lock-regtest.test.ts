// Helper of the real-node proof: `btc_lock_regtest` in apps/desktop/src-tauri drives this file so
// that a lock is funded by the same TypeScript the app runs (coin selection, PSBT, finalisation).
// Skipped unless that test starts it.
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { setBackend } from '@kyro/shared';
import { BitcoinAdapter, btcChain } from '../src/index';

const job = process.env.KYRO_LOCK_JOB;

describe.skipIf(!job)('lock funding against a real node', () => {
  it('runs one stage', async () => {
    const j = JSON.parse(readFileSync(job as string, 'utf8'));
    const coins: Record<string, Array<{ txid: string; vout: number; value: number }>> = j.utxos ?? {};
    const answers: Record<string, (a: { address: string }) => unknown> = {
      btc_address_info: ({ address }) => {
        const sum = (coins[address] ?? []).reduce((s, c) => s + c.value, 0);
        const count = coins[address]?.length ?? 0;
        return { address, chain_stats: { funded_txo_sum: sum, spent_txo_sum: 0, tx_count: count }, mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: 0 } };
      },
      btc_address_utxos: ({ address }) => (coins[address] ?? []).map((c) => ({ ...c, status: { confirmed: true } })),
      btc_address_txs: () => [],
      btc_lock_sign_funding_tx: () => ({ psbt: j.signed }),
    };
    setBackend((async (cmd: string, args: { address: string }) => {
      const answer = answers[cmd];
      if (!answer) throw new Error(`unexpected command ${cmd}`);
      return answer(args);
    }) as Parameters<typeof setBackend>[0]);
    const adapter = new BitcoinAdapter({ chain: btcChain('testnet'), accounts: j.accounts });
    if (j.stage === 'build') {
      const unsigned = await adapter.buildTx({ to: j.to, amount: BigInt(j.amount), fee: { family: 'btc', satPerVb: j.satPerVb } } as Parameters<typeof adapter.buildTx>[0]);
      writeFileSync(j.out, JSON.stringify({ psbt: unsigned.psbt, amount: Number(unsigned.amount), fee: Number(unsigned.fee) }));
    } else {
      const signed = await adapter.signLockFunding({ psbt: j.psbt, amount: BigInt(j.amount) } as Parameters<typeof adapter.signLockFunding>[0], 'unused', j.t, 'LOCK');
      writeFileSync(j.out, JSON.stringify({ hex: signed.hex, txid: signed.txid }));
    }
  }, 60_000);
});
