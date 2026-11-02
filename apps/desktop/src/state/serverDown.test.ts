import { describe, expect, it } from 'vitest';
import { EMPTY_SERVERS, IpcError, anyCustomServer, hasCustomServer, type Servers } from '@kyro/shared';
import { allChains, findChain } from '@kyro/chains';
import { networkDown, serverDown } from '../components/ServerDown';
import { balanceRetryDelay } from '../lib/retry';

const down = new IpcError('SERVER_UNREACHABLE', 'Server unreachable: api.trongrid.io: network (Tor): timed out');

describe('server down vs network down', () => {
  it('a default server that fails is a neutral network error, never « your server »', () => {
    for (const chain of allChains('mainnet')) expect(hasCustomServer(EMPTY_SERVERS, chain)).toBe(false);
    expect(anyCustomServer(EMPTY_SERVERS, 'mainnet')).toBe(false);
    expect(serverDown(down, false)).toBe(false);
    expect(networkDown(down, false)).toBe(true);
    // Same with only the message left (the portfolio keeps messages), FR and EN.
    expect(networkDown('Serveur injoignable : api.trongrid.io : délai', false)).toBe(true);
    expect(networkDown('Server unreachable: api.trongrid.io: timed out', false)).toBe(true);
    expect(serverDown('Serveur injoignable : api.trongrid.io : délai', false)).toBe(false);
  });

  it('« your server is not responding » only for a chain with a custom server', () => {
    const servers: Servers = {
      ...EMPTY_SERVERS,
      bitcoin: { mainnet: { kind: 'esplora', url: 'https://my-node.example/api' } },
      tron: { mainnet: { kind: 'http', url: 'https://tron.my-node.example' }, testnet: { kind: 'default' } },
      evm: { '42161': { url: 'https://arb.my-node.example' } },
    };
    const custom = (key: string, network: 'mainnet' | 'testnet' = 'mainnet') => hasCustomServer(servers, findChain(network, key)!);
    expect(custom('bitcoin')).toBe(true);
    expect(custom('tron')).toBe(true);
    expect(custom('tron', 'testnet')).toBe(false);
    expect(custom('bitcoin', 'testnet')).toBe(false);
    expect(custom('arbitrum')).toBe(true);
    expect(custom('ethereum')).toBe(false);
    expect(custom('sui')).toBe(false);
    expect(custom('aptos')).toBe(false);
    expect(anyCustomServer(servers, 'mainnet')).toBe(true);
    expect(serverDown(down, true)).toBe(true);
    expect(networkDown(down, true)).toBe(false);
  });

  it('other errors are neither', () => {
    for (const e of [new IpcError('SERVER_INVALID', 'x'), new Error('HTTP 500'), '', undefined]) {
      expect(serverDown(e, true)).toBe(false);
      expect(networkDown(e, false)).toBe(false);
    }
  });

  it('failed balances are retried with backoff before the regular poll', () => {
    expect(balanceRetryDelay(0)).toBeNull();
    expect(balanceRetryDelay(1)).toBe(5_000);
    expect(balanceRetryDelay(2)).toBe(10_000);
    expect(balanceRetryDelay(3)).toBe(20_000);
    expect(balanceRetryDelay(4)).toBeNull();
  });
});
