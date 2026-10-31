// Demo backend: network choice (docs/IPC.md §2.10), mirroring src-tauri/src/network.rs.
import { describe, expect, it } from 'vitest';
import { call, IpcError, setBackend, type Network } from '../src';
import { createMockBackend, DEMO_DEFAULT_NETWORK, resolveDemoNetwork, type DemoNetworkStore } from '../src/mock';

function memoryStore(initial: Network | null = null): DemoNetworkStore & { value: Network | null } {
  return {
    value: initial,
    get() {
      return this.value;
    },
    set(n) {
      this.value = n;
    },
  };
}

async function rejectCode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(IpcError);
    return (e as IpcError).code;
  }
  throw new Error('expected rejection');
}

describe('network choice (demo)', () => {
  it('same precedence as the shell: forced > saved > default (testnet, like a debug build)', () => {
    expect(DEMO_DEFAULT_NETWORK).toBe('testnet');
    expect(resolveDemoNetwork(null, null)).toEqual({ network: 'testnet', source: 'default' });
    expect(resolveDemoNetwork(null, 'mainnet')).toEqual({ network: 'mainnet', source: 'saved' });
    expect(resolveDemoNetwork('testnet', 'mainnet')).toEqual({ network: 'testnet', source: 'env' });
    expect(resolveDemoNetwork(' MAINNET ', null)).toEqual({ network: 'mainnet', source: 'env' });
    // Unknown forced value: ignored, never a silent pick.
    expect(resolveDemoNetwork('regtest', 'mainnet')).toEqual({ network: 'mainnet', source: 'saved' });
  });

  it('network_get describes the running network', async () => {
    const store = memoryStore();
    setBackend(createMockBackend({ network: 'testnet', networkStore: store, confirm: () => true }).invoke);
    expect(await call('network_get')).toEqual({ network: 'testnet', source: 'default', saved: null, default: 'testnet', canSwitch: true, otherVaultExists: false });
  });

  it('network_set saves the choice, locks and restarts only for another network', async () => {
    const store = memoryStore();
    const restarts: Network[] = [];
    const mock = createMockBackend({ network: 'testnet', networkStore: store, onNetworkRestart: (n) => restarts.push(n), confirm: () => true, preset: { password: 'correct horse', unlocked: true } });
    setBackend(mock.invoke);
    // Same network: saved, no restart, still unlocked.
    expect(await call('network_set', { network: 'testnet' })).toBe(false);
    expect(store.value).toBe('testnet');
    expect(restarts).toEqual([]);
    expect((await call('vault_status')).unlocked).toBe(true);
    // Other network: saved, session locked, restart requested.
    expect(await call('network_set', { network: 'mainnet' })).toBe(true);
    expect(store.value).toBe('mainnet');
    expect(restarts).toEqual(['mainnet']);
    expect((await call('vault_status')).unlocked).toBe(false);
    expect((await call('network_get')).saved).toBe('mainnet');
    // The next start picks the saved choice.
    const next = createMockBackend({ networkStore: store, confirm: () => true });
    setBackend(next.invoke);
    expect(await call('network_get')).toMatchObject({ network: 'mainnet', source: 'saved' });
    expect((await call('config_get')).network).toBe('mainnet');
  });

  it('refuses an unknown network, and any switch when the network is forced', async () => {
    const store = memoryStore();
    setBackend(createMockBackend({ network: 'testnet', networkStore: store, confirm: () => true }).invoke);
    expect(await rejectCode(call('network_set', { network: 'regtest' as Network }))).toBe('INVALID_INPUT');
    expect(store.value).toBeNull();

    const restarts: Network[] = [];
    setBackend(createMockBackend({ network: 'testnet', networkSource: 'env', networkStore: store, onNetworkRestart: (n) => restarts.push(n), confirm: () => true }).invoke);
    expect((await call('network_get')).canSwitch).toBe(false);
    expect(await rejectCode(call('network_set', { network: 'mainnet' }))).toBe('INVALID_INPUT');
    expect(store.value).toBeNull();
    expect(restarts).toEqual([]);
  });
});
