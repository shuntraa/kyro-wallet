// Custom servers (B2b) end to end against the demo backend: Bitcoin only through the Rust
// btc_* commands, EVM / Solana on the user's RPC, typed errors and never a fallback.
import { beforeEach, describe, expect, it } from 'vitest';
import { BTC_TXS_CAP, call, IpcError, ipcErrorIn, isCustomServerDown, setBackend, type Accounts, type EsploraTx, type InvokeFn, type Settings } from '@kyro/shared';
import { createMockBackend, demoElectrumCert, type MockBackend } from '@kyro/shared/mock';
import { createAdapters } from '../src';

const PASSWORD = 'correct horse battery';
const EXPECTED_BTC = 4_120_000n + 890_000n + 210_000n + 350_000n;

let mock: MockBackend;
let accounts: Accounts;
/** Every command sent, with the URL for net_fetch. */
let sent: string[];

function install(override?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> | undefined) {
  const invoke: InvokeFn = (cmd, args) => {
    const req = (args as { req?: { url?: string } } | undefined)?.req;
    sent.push(cmd === 'net_fetch' ? `net_fetch ${req?.url ?? ''}` : cmd);
    return override?.(cmd, args) ?? mock.invoke(cmd, args);
  };
  setBackend(invoke);
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    // viem wraps transport errors (UnknownRpcError → cause: IpcError).
    const ipc = ipcErrorIn(e);
    expect(ipc).toBeInstanceOf(IpcError);
    return ipc?.code ?? '';
  }
  throw new Error('expected rejection');
}

async function saveServers(patch: (s: Settings) => Settings['servers']): Promise<Settings> {
  const s = await call('settings_get');
  return call('settings_set', { settings: { ...s, servers: patch(s) } });
}

beforeEach(async () => {
  sent = [];
  mock = createMockBackend({ network: 'testnet', confirm: () => true, preset: { password: PASSWORD, unlocked: true } });
  install();
  accounts = await call('accounts_get');
});

describe('Bitcoin adapter over the Rust btc_* commands', () => {
  it('reads, builds, signs and broadcasts without a single net_fetch', async () => {
    const btc = createAdapters(accounts).btc!;
    expect((await btc.getBalance())[0]?.amount).toBe(EXPECTED_BTC);
    expect(await btc.tipHeight()).toBeGreaterThan(0);
    const fees = await btc.estimateFees();
    expect(fees.options.normal.params).toEqual({ family: 'btc', satPerVb: 6 });
    const unsigned = await btc.buildTx({ asset: { id: 'btc' } as never, to: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', amount: 100_000n, fee: { family: 'btc', satPerVb: 3 } });
    const signed = await btc.signTx(unsigned, PASSWORD);
    expect(await btc.broadcast(signed)).toBe(signed.txid);
    expect((await btc.getHistory()).length).toBeGreaterThan(0);

    expect(sent.filter((c) => c.startsWith('net_fetch'))).toEqual([]);
    for (const c of ['btc_address_info', 'btc_address_utxos', 'btc_address_txs', 'btc_fee_rates', 'btc_tip_height', 'btc_broadcast']) expect(sent).toContain(c);
  });

  it('flags a history capped at BTC_TXS_CAP transactions per address', async () => {
    const btc = createAdapters(accounts).btc!;
    await btc.getHistory();
    expect(btc.historyCapped).toBe(false);
    const fake = (i: number): EsploraTx => ({
      txid: i.toString(16).padStart(64, '0'),
      fee: 100,
      status: { confirmed: true, block_height: 1000 - i, block_time: 1_700_000_000 - i },
      vin: [{ txid: 'aa'.repeat(32), vout: 0, prevout: null }],
      vout: [{ scriptpubkey: '00', scriptpubkey_address: accounts.btc.segwit.address, value: 1000 }],
    });
    install((cmd) => (cmd === 'btc_address_txs' ? Promise.resolve(Array.from({ length: BTC_TXS_CAP }, (_, i) => fake(i))) : undefined));
    const capped = createAdapters(accounts).btc!;
    const h = await capped.getHistory();
    expect(capped.historyCapped).toBe(true);
    expect(h).toHaveLength(BTC_TXS_CAP);
    // prevout null (Core: funding tx outside the wallet) is never counted as ours: incoming.
    expect(h.every((x) => x.direction === 'in')).toBe(true);
  });

  it('compact filters: block-average fee rates are flagged for the UI', async () => {
    install((cmd) => (cmd === 'btc_fee_rates' ? Promise.resolve({ fastestFee: 8, halfHourFee: 5, hourFee: 3, economyFee: 1, minimumFee: 1, source: 'block-average' }) : undefined));
    const f = await createAdapters(accounts).btc!.estimateFees();
    expect(f.source).toBe('block-average');
    expect(f.options.normal.params).toEqual({ family: 'btc', satPerVb: 5 });
    install();
    expect((await createAdapters(accounts).btc!.estimateFees()).source).toBeUndefined();
  });

  it('a custom Bitcoin server that goes down fails with SERVER_UNREACHABLE, no net_fetch fallback', async () => {
    install((cmd) => (cmd.startsWith('btc_address') ? Promise.reject({ code: 'SERVER_UNREACHABLE', message: 'Serveur injoignable : node.example : délai dépassé' }) : undefined));
    const btc = createAdapters(accounts).btc!;
    expect(await code(btc.getBalance())).toBe('SERVER_UNREACHABLE');
    expect(sent.filter((c) => c.startsWith('net_fetch'))).toEqual([]);
  });

  it('Electrum (pinned certificate): net balance in funded_txo_sum gives the same total', async () => {
    const cert = demoElectrumCert('electrum-self.example', 50002);
    expect(cert.webpkiValid).toBe(false);
    await saveServers((s) => ({ ...s.servers, bitcoin: { testnet4: { kind: 'electrum', host: 'electrum-self.example', port: 50002, tls: 'pinned', certSha256: cert.sha256 } } }));
    expect(await call('btc_backend_info')).toMatchObject({ kind: 'electrum', network: 'testnet4', label: 'electrum-self.example:50002' });
    expect((await createAdapters(accounts).btc!.getBalance())[0]?.amount).toBe(EXPECTED_BTC);
    // The default (mempool) is now refused for this chain.
    expect(await code(call('net_fetch', { req: { url: 'https://mempool.space/testnet4/api/blocks/tip/height', method: 'GET' } }))).toBe('DEFAULT_SERVER_DISABLED');
  });

  it('Bitcoin Core: SERVER_INVALID until the watch wallet is set up, then reads work', async () => {
    await saveServers((s) => ({ ...s.servers, bitcoin: { testnet4: { kind: 'core', url: 'http://127.0.0.1:48332', auth: { kind: 'cookie', cookiePath: '/home/me/.bitcoin/testnet4/.cookie' } } } }));
    const btc = createAdapters(accounts).btc!;
    expect(await code(btc.getBalance())).toBe('SERVER_INVALID');
    expect((await call('btc_core_status')).state).toBe('idle');
    expect(await call('btc_core_setup', { rescanFrom: 'now' })).toMatchObject({ state: 'importing', wallet: `kyro-watch-${accounts.btc.segwit.fingerprint}` });
    expect((await btc.scan(true)).length).toBeGreaterThan(0);
    expect((await btc.getBalance())[0]?.amount).toBe(EXPECTED_BTC);
    expect((await btc.getHistory()).every((x) => x.direction === 'in')).toBe(true);
  });
});

describe('EVM and Solana on the user RPC', () => {
  it('use the custom URL when set; the replaced default is refused, never retried', async () => {
    const saved = await saveServers((s) => ({ ...s.servers, evm: { '11155111': { url: 'https://my-sepolia.example/rpc' } }, solana: { devnet: { url: 'https://my-devnet.example' } } }));
    const ad = createAdapters(accounts, saved.servers);
    expect(ad.evm.get('sepolia')?.rpcUrl).toBe('https://my-sepolia.example/rpc');
    expect(ad.sol!.rpcUrl).toBe('https://my-devnet.example');
    expect((await ad.evm.get('sepolia')!.getBalance()).length).toBeGreaterThan(0);
    expect((await ad.sol!.getBalance()).length).toBeGreaterThan(0);
    const urls = sent.filter((c) => c.startsWith('net_fetch')).map((c) => new URL(c.slice(10)).host);
    expect(new Set(urls)).toEqual(new Set(['my-sepolia.example', 'my-devnet.example']));

    // An adapter built without the servers would hit the default: Rust (and the demo) refuse it.
    const stale = createAdapters(accounts);
    expect(await code(stale.evm.get('sepolia')!.getBalance())).toBe('DEFAULT_SERVER_DISABLED');
    expect(await code(stale.sol!.getBalance())).toBe('DEFAULT_SERVER_DISABLED');
    // What the UI tests to show « Ton serveur ne répond pas » (also through viem's wrapper).
    expect(isCustomServerDown(await stale.evm.get('sepolia')!.getBalance().catch((e: unknown) => e))).toBe(true);
  });
});

describe('settings_set and server_test validation', () => {
  it('rejects with typed errors and saves nothing on failure', async () => {
    const before = await call('settings_get');
    const tryBtc = (server: Parameters<typeof call<'server_test'>>[1]['target']) => call('server_test', { target: server });
    expect(await code(tryBtc({ family: 'bitcoin', network: 'testnet4', server: { kind: 'esplora', url: 'http://plain.example/api' } }))).toBe('SERVER_INVALID');
    expect(await code(tryBtc({ family: 'bitcoin', network: 'testnet4', server: { kind: 'esplora', url: 'https://u:p@node.example/api' } }))).toBe('SERVER_INVALID');
    expect(await code(tryBtc({ family: 'bitcoin', network: 'testnet4', server: { kind: 'esplora', url: 'https://wrong-net.example/api' } }))).toBe('SERVER_WRONG_NETWORK');
    expect(await code(tryBtc({ family: 'bitcoin', network: 'testnet4', server: { kind: 'esplora', url: 'https://down.example/api' } }))).toBe('SERVER_UNREACHABLE');
    expect(await code(tryBtc({ family: 'bitcoin', network: 'testnet4', server: { kind: 'electrum', host: 'e.example', port: 50001, tls: 'none' } }))).toBe('SERVER_INVALID');
    expect(await code(tryBtc({ family: 'bitcoin', network: 'testnet4', server: { kind: 'electrum', host: 'self-signed.example', port: 50002, tls: 'webpki' } }))).toBe('SERVER_UNREACHABLE');
    expect(await code(tryBtc({ family: 'bitcoin', network: 'testnet4', server: { kind: 'core', url: 'http://8.8.8.8:8332', auth: { kind: 'cookie', cookiePath: '/x/.cookie' } } }))).toBe('SERVER_INVALID');
    expect(await code(tryBtc({ family: 'evm', chainId: 11155111, server: { url: 'https://wrong-chain.example' } }))).toBe('SERVER_WRONG_NETWORK');
    expect(await code(tryBtc({ family: 'solana', cluster: 'devnet', server: { url: 'https://wrong.example' } }))).toBe('SERVER_WRONG_NETWORK');
    const ok = await tryBtc({ family: 'evm', chainId: 11155111, server: { url: 'https://my-sepolia.example' } });
    expect(ok.detected.chainId).toBe(11155111);
    expect(ok.latencyMs).toBeGreaterThan(0);

    expect(await code(saveServers((s) => ({ ...s.servers, evm: { '11155111': { url: 'https://down.example' } } })))).toBe('SERVER_UNREACHABLE');
    expect(await call('settings_get')).toEqual(before);
  });

  it('never returns the Core password; an omitted password is kept, "" clears it', async () => {
    const core = (password?: string) => ({ kind: 'core' as const, url: 'http://192.168.1.20:8332', auth: { kind: 'userpass' as const, user: 'kyro', ...(password !== undefined ? { password } : {}) } });
    const saved = await saveServers((s) => ({ ...s.servers, bitcoin: { testnet4: core('s3cret-demo') } }));
    expect(JSON.stringify(saved)).not.toContain('s3cret-demo');
    expect(saved.servers.bitcoin.testnet4).toMatchObject({ auth: { kind: 'userpass', user: 'kyro', hasPassword: true } });
    expect(JSON.stringify(await call('settings_get'))).not.toContain('s3cret-demo');
    // Round trip of what settings_get returned: password kept.
    const again = await call('settings_set', { settings: saved });
    expect(again.servers.bitcoin.testnet4).toMatchObject({ auth: { hasPassword: true } });
    // Explicit "" clears it → "mot de passe RPC manquant".
    expect(await code(saveServers(() => ({ bitcoin: { testnet4: core('') }, evm: {}, solana: {}, litecoin: {}, dogecoin: {}, tron: {}, xrp: {}, cardano: {} })))).toBe('SERVER_INVALID');
    // Removing the server goes back to the default.
    const back = await saveServers((s) => ({ ...s.servers, bitcoin: {} }));
    expect(back.servers.bitcoin.testnet4).toBeUndefined();
    expect((await call('btc_backend_info')).kind).toBe('default');
  });

  it('electrum_fetch_cert returns a 64-hex fingerprint and the webpki verdict', async () => {
    const c = await call('electrum_fetch_cert', { host: 'electrum.example', port: 50002 });
    expect(c.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(c.webpkiValid).toBe(true);
    expect(await code(call('electrum_fetch_cert', { host: 'down.example', port: 50002 }))).toBe('SERVER_UNREACHABLE');
    expect(await code(call('electrum_fetch_cert', { host: 'bad host', port: 50002 }))).toBe('SERVER_INVALID');
  });
});
