// Watch addresses: detection, reads from one address or an xpub, and no signing path at all.
import { beforeEach, describe, expect, it } from 'vitest';
import { setBackend } from '@kyro/shared';
import { createMockBackend } from '@kyro/shared/mock';
import { HDKey } from '@scure/bip32';
import * as bitcoin from 'bitcoinjs-lib';
import { BitcoinAdapter, createAdapters, isWatchable, isWatchXpub, sealWatchAdapter, watchRefusal, watchScriptOutput, watchScripts, watchToAccounts, btcChain, scanWatchSource } from '../src/index';
import { derivePubkey, parseXpub } from '../src/bitcoin/xpub';

const EVM = '0x000000000000000000000000000000000000dEaD';
const BTC = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
const SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const XPUB = HDKey.fromMasterSeed(SEED).publicExtendedKey;
const XPRV = HDKey.fromMasterSeed(SEED).privateExtendedKey;

beforeEach(() => setBackend(createMockBackend({ network: 'mainnet' }).invoke));

describe('detection', () => {
  it('accepts public values of the right network only', () => {
    expect(isWatchable('evm', EVM, 'mainnet')).toBe(true);
    expect(isWatchable('btc', BTC, 'mainnet')).toBe(true);
    expect(isWatchable('btc', BTC, 'testnet')).toBe(false);
    expect(isWatchable('evm', BTC, 'mainnet')).toBe(false);
    expect(isWatchable('btc', XPUB, 'mainnet')).toBe(true);
    expect(isWatchXpub('btc', XPUB, 'testnet')).toBe(false);
    expect(isWatchXpub('doge', XPUB, 'mainnet')).toBe(false);
  });

  it('never accepts Monero, Hedera or a private key', () => {
    expect(isWatchable('xmr', '44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A', 'mainnet')).toBe(false);
    expect(isWatchable('hbar', '0.0.1234', 'mainnet')).toBe(false);
    expect(isWatchable('btc', XPRV, 'mainnet')).toBe(false);
  });

  it('explains why a value cannot be watched', () => {
    expect(watchRefusal(XPRV)).toBe('private');
    expect(watchRefusal('abandon abandon abandon')).toBe('private');
    expect(watchRefusal('44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A')).toBe('monero');
    expect(watchRefusal(EVM)).toBeNull();
    expect(watchRefusal(XPUB)).toBeNull();
  });

  it('picks the script types of an xpub from its prefix', () => {
    expect(watchScripts('btc', 'zpub123')).toEqual(['wpkh']);
    expect(watchScripts('btc', 'ypub123')).toEqual(['sh-wpkh']);
    expect(watchScripts('btc', 'xpub123')).toEqual(['wpkh', 'tr', 'sh-wpkh', 'pkh']);
    expect(watchScripts('doge', 'dgub123')).toEqual(['pkh']);
  });
});

describe('accounts', () => {
  it('exposes one chain family and no key', () => {
    const acc = watchToAccounts({ family: 'evm', value: EVM }, 'mainnet');
    expect(acc.evm?.address).toBe(EVM);
    expect(acc.btc).toBeUndefined();
    expect(acc.watch).toEqual({ kind: 'address', address: EVM });
  });

  it('shows the first address of an xpub', () => {
    const acc = watchToAccounts({ family: 'btc', value: XPUB }, 'mainnet');
    const want = watchScriptOutput('wpkh', derivePubkey(parseXpub(XPUB), 0, 0), bitcoin.networks.bitcoin).address;
    expect(acc.btc?.segwit.address).toBe(want);
  });

  it('refuses a network that cannot be watched', () => {
    expect(() => watchToAccounts({ family: 'xmr', value: 'x' }, 'mainnet')).toThrow();
  });
});

describe('scan', () => {
  it('reads a single address once', async () => {
    const asked: string[] = [];
    const rows = await scanWatchSource({ kind: 'address', address: BTC }, () => '', async (a) => {
      asked.push(a);
      return { used: true, balance: 7n };
    });
    expect(asked).toEqual([BTC]);
    expect(rows).toEqual([{ address: BTC, change: 0, index: 0, used: true, balance: 7n }]);
  });

  it('walks an xpub per script type and branch until the gap', async () => {
    const seen = new Set<string>();
    const rows = await scanWatchSource(
      { kind: 'xpub', xpub: XPUB, scripts: ['wpkh', 'pkh'] },
      (key, script, change, i) => watchScriptOutput(script, derivePubkey(key, change, i), bitcoin.networks.bitcoin).address,
      async (a) => {
        seen.add(a);
        return { used: false, balance: 0n };
      },
      5,
    );
    // gap 5 on receive, 3 on change, two script types.
    expect(rows).toHaveLength(16);
    expect(seen.size).toBe(16);
  });

  it('sums the balance of a Bitcoin watch adapter from one address', async () => {
    const backend = createMockBackend({ network: 'mainnet' });
    const a = new BitcoinAdapter({
      chain: btcChain('mainnet'),
      accounts: { segwit: { address: BTC, xpub: '', fingerprint: '00000000', path: '' }, taproot: { address: BTC, xpub: '', fingerprint: '00000000', path: '' } },
      watch: { kind: 'address', address: BTC },
    });
    setBackend(backend.invoke);
    expect(a.getAddress()).toBe(BTC);
    const rows = await a.scan();
    expect(rows.map((r) => r.address)).toEqual([BTC]);
  });
});

describe('nothing can be signed', () => {
  const families = [
    { family: 'evm', value: EVM },
    { family: 'btc', value: BTC },
    { family: 'btc', value: XPUB },
  ] as const;

  it.each(families)('every adapter of $family refuses to build, sign or broadcast', async (w) => {
    const set = createAdapters(watchToAccounts(w, 'mainnet'));
    expect(set.watch).toBe(true);
    expect(set.hw).toBeNull();
    expect(set.all.length).toBeGreaterThan(0);
    for (const adapter of set.all) {
      const a = adapter as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
      for (const m of ['buildTx', 'signTx', 'broadcast']) {
        await expect(a[m]!()).rejects.toThrow(/nothing can be signed|rien à signer/i);
      }
    }
  });

  it('also seals the extra builders of an adapter, not the reads', async () => {
    class Fake {
      buildApprove() {
        return Promise.resolve('tx');
      }
      signMessage() {
        return Promise.resolve('sig');
      }
      getBalance() {
        return Promise.resolve([]);
      }
    }
    const f = new Fake();
    sealWatchAdapter(f);
    await expect(f.buildApprove()).rejects.toThrow();
    await expect(f.signMessage()).rejects.toThrow();
    await expect(f.getBalance()).resolves.toEqual([]);
  });

  it('a vault set stays open', () => {
    const set = createAdapters({ network: 'mainnet', evm: { address: EVM } });
    expect(set.watch).toBe(false);
  });
});
