// Hardware-wallet accounts against the demo backend: public derivation from the stored xpubs,
// the device input rules (SegWit needs the previous tx, Ledger never mixes kinds), hw signing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as bitcoin from 'bitcoinjs-lib';
import { call, setBackend, type InvokeFn, type WatchOnlyAccount } from '@kyro/shared';
import { createMockBackend, type DemoHwScenario, type MockBackend } from '@kyro/shared/mock';
import { createAdapters, evmHwDisplay, hwToAccounts, signAndBroadcastHw, type AdapterSet } from '../src';

let mock: MockBackend;
let sent: string[];

/** Drives the fake clock until `p` settles (device delays, demo network latency). */
async function drive<T>(p: Promise<T>): Promise<T> {
  let done = false;
  const settled = p.then(
    (v) => ((done = true), { ok: true as const, v }),
    (e: unknown) => ((done = true), { ok: false as const, e }),
  );
  for (let i = 0; i < 400 && !done; i++) await vi.advanceTimersByTimeAsync(250);
  const r = await settled;
  if (!r.ok) throw r.e;
  return r.v;
}

function setup(hw: DemoHwScenario) {
  mock = createMockBackend({ network: 'testnet', hw, confirm: () => true });
  const invoke: InvokeFn = (cmd, args) => {
    sent.push(cmd);
    return mock.invoke(cmd, args);
  };
  setBackend(invoke);
}

async function addAccount(id: string, chains: Array<'btc' | 'evm' | 'sol'>): Promise<WatchOnlyAccount> {
  let acc: WatchOnlyAccount | null = null;
  for (const chain of chains) {
    // Ledger: the first try on another app is HW_WRONG_APP (the demo user then opens it).
    acc = await drive(call('hw_account_add', { id, chain, account: 0, ...(acc ? { accountId: acc.id } : {}) })).catch(() =>
      drive(call('hw_account_add', { id, chain, account: 0, ...(acc ? { accountId: acc.id } : {}) })),
    );
  }
  if (!acc) throw new Error('no account');
  return acc;
}

function adaptersFor(acc: WatchOnlyAccount, prevTx?: (txid: string) => Promise<string | null>): AdapterSet {
  const set = createAdapters(hwToAccounts(acc), undefined, undefined, { accountId: acc.id, device: acc.device });
  if (prevTx && set.btc) (set.btc as unknown as { hw: { prevTx?: unknown } }).hw.prevTx = prevTx;
  return set;
}

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('hardware-wallet accounts', () => {
  it('derives the same addresses as the device (EVM, Solana) and only its chains', async () => {
    setup('trezor-one');
    // Trezor One: PIN matrix first.
    const p = drive(call('hw_get_xpub', { id: 'trezor-1', chain: 'evm', account: 0 }));
    await vi.advanceTimersByTimeAsync(300);
    await call('hw_pin_matrix', { id: 'trezor-1', positions: '9571' });
    const keys = await p;
    const acc = await addAccount('trezor-1', ['btc', 'evm']);
    const view = hwToAccounts(acc);
    expect(view.evm?.address).toBe(keys.evm?.address);
    expect(view.btc?.segwit.address.startsWith('tb1q')).toBe(true);
    expect(view.btc?.taproot.address.startsWith('tb1p')).toBe(true);
    expect(view.sol).toBeUndefined();
    const ad = adaptersFor(acc);
    expect(ad.sol).toBeNull();
    expect(ad.all.map((a) => a.family).sort()).toEqual(['btc', 'evm']);
    expect(ad.hw).toEqual({ accountId: acc.id, device: 'trezor' });
  });

  it('Bitcoin without previous transactions: spends Taproot only, never SegWit', async () => {
    setup('ledger');
    const acc = await addAccount('ledger-1', ['btc']);
    const btc = adaptersFor(acc).btc!;
    expect((await drive(btc.getBalance()))[0]?.amount).toBe(640_000n + 310_000n);
    const unsigned = await drive(btc.buildTx({ asset: { id: 'btc' } as never, to: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', amount: 200_000n, fee: { family: 'btc', satPerVb: 2 } }));
    const psbt = bitcoin.Psbt.fromBase64(unsigned.psbt, { network: bitcoin.networks.testnet });
    expect(psbt.data.inputs.every((i) => (i.tapBip32Derivation?.length ?? 0) > 0)).toBe(true);
    // More than the Taproot funds: refused with the explanation (SegWit needs the previous tx).
    await expect(drive(btc.buildTx({ asset: { id: 'btc' } as never, to: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', amount: 800_000n, fee: { family: 'btc', satPerVb: 2 } }))).rejects.toThrow(/transaction précédente complète/);
  });

  it('with previous transactions: SegWit inputs carry non_witness_utxo; a Ledger never mixes kinds, a Trezor may', async () => {
    setup('ledger');
    const acc = await addAccount('ledger-1', ['btc']);
    const view = hwToAccounts(acc);
    // A real previous transaction paying our SegWit address, so its txid matches.
    const prev = new bitcoin.Transaction();
    prev.version = 2;
    prev.addInput(new Uint8Array(32).fill(7), 0);
    prev.addOutput(bitcoin.address.toOutputScript(view.btc!.segwit.address, bitcoin.networks.testnet), 310_000n);
    mock.chain.btcUtxos.set(view.btc!.segwit.address, [{ txid: prev.getId(), vout: 0, value: 310_000, height: mock.chain.tipHeight - 10 }]);
    const prevTx = async (txid: string) => (txid === prev.getId() ? prev.toHex() : null);

    const ledger = adaptersFor(acc, prevTx).btc!;
    const to = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
    const small = await drive(ledger.buildTx({ asset: { id: 'btc' } as never, to, amount: 250_000n, fee: { family: 'btc', satPerVb: 2 } }));
    const kinds = (b64: string) => new Set(bitcoin.Psbt.fromBase64(b64, { network: bitcoin.networks.testnet }).data.inputs.map((i) => (i.tapBip32Derivation?.length ? 'taproot' : 'segwit')));
    expect(kinds(small.psbt).size).toBe(1);
    // 800k needs both kinds: impossible on a Ledger (one kind per transaction)…
    await expect(drive(ledger.buildTx({ asset: { id: 'btc' } as never, to, amount: 800_000n, fee: { family: 'btc', satPerVb: 2 } }))).rejects.toThrow();
    // …fine on a Trezor, with non_witness_utxo on the SegWit input.
    const trezorAcc: WatchOnlyAccount = { ...acc, device: 'trezor' };
    const trezor = adaptersFor(trezorAcc, prevTx).btc!;
    const big = await drive(trezor.buildTx({ asset: { id: 'btc' } as never, to, amount: 800_000n, fee: { family: 'btc', satPerVb: 2 } }));
    const inputs = bitcoin.Psbt.fromBase64(big.psbt, { network: bitcoin.networks.testnet }).data.inputs;
    expect(kinds(big.psbt).size).toBe(2);
    expect(inputs.filter((i) => i.bip32Derivation?.length).every((i) => i.nonWitnessUtxo !== undefined)).toBe(true);
  });

  it('signs on the device (hw_sign_*), no password command, then broadcasts', async () => {
    setup('trezor');
    const acc = await addAccount('trezor-1', ['btc', 'evm']);
    const ad = adaptersFor(acc);
    const unsigned = await drive(ad.btc!.buildTx({ asset: { id: 'btc' } as never, to: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', amount: 100_000n, fee: { family: 'btc', satPerVb: 2 } }));
    const txid = await drive(signAndBroadcastHw(ad.btc!, unsigned, 'trezor-1'));
    expect(txid).toMatch(/^[0-9a-f]{64}$/);
    expect(sent).toContain('hw_sign_btc_psbt');
    expect(sent).not.toContain('btc_sign_psbt');
  });

  it('clear vs blind signing table (mirror of Rust evm_clear_signs + bundled Ledger descriptors)', () => {
    const t = (kind: 'NativeTransfer' | 'Erc20Transfer' | 'Erc20Approve' | 'ContractCall', c: string | null = null) => ({ kind, tokenContract: c });
    const tusdc = '0x1C7D4B196Cb0C7B01d743Fbc6116a902379C7238';
    const unknown = '0x0000000000000000000000000000000000000abc';
    expect(evmHwDisplay('ledger', 11155111, t('NativeTransfer'))).toBe('clear');
    expect(evmHwDisplay('ledger', 11155111, t('Erc20Transfer', tusdc))).toBe('clear');
    expect(evmHwDisplay('ledger', 11155111, t('Erc20Transfer', unknown))).toBe('blind');
    expect(evmHwDisplay('ledger', 1, t('Erc20Transfer', tusdc))).toBe('blind'); // other chain
    expect(evmHwDisplay('trezor', 1, t('Erc20Transfer', unknown))).toBe('clear');
    expect(evmHwDisplay('trezor', 1, t('Erc20Approve', unknown))).toBe('blind');
    expect(evmHwDisplay('trezor', 1, t('ContractCall'))).toBe('blind');
  });
});
