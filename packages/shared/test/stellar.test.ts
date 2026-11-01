// Stellar strkeys (SEP-0023 vectors, same rules as wallet-core) and the demo `stellar_*` commands.
import { beforeEach, describe, expect, it } from 'vitest';
import { hexToBytes } from '@noble/hashes/utils';
import { call, crc16Xmodem, IpcError, isStellarAddress, setBackend, stellarAccountKey, stellarAddressKind, stellarAddressOfKey } from '../src';
import { createMockBackend, type MockBackend } from '../src/mock';

const G = 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ';

describe('Stellar strkeys (SEP-0023)', () => {
  it('encodes and decodes the valid vectors', () => {
    expect(crc16Xmodem(new TextEncoder().encode('123456789'))).toBe(0x31c3);
    const key = hexToBytes('3f0c34bf93ad0d9971d04ccc90f705511c838aad9734a4a2fb0d7a03fc7fe89a');
    expect(stellarAddressOfKey(key)).toBe(G);
    expect(stellarAccountKey(G)).toEqual(key);
    expect(isStellarAddress(G)).toBe(true);
    expect(isStellarAddress(` ${G}\n`)).toBe(true);
    // SEP-0005 test 1, account 0 (address and secret key).
    expect(stellarAddressKind('GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6')).toBe('account');
    expect(stellarAddressKind('SBGWSG6BTNCKCOB3DIFBGCVMUPQFYPA2G4O34RMTB343OYPXU5DJDVMN')).toBe('secret');
    expect(stellarAddressKind('MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAAAAAAAAAAACJUQ')).toBe('muxed');
    expect(stellarAddressKind('MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVAAAAAAAAAAAAAJLK')).toBe('muxed');
  });

  it('refuses every invalid vector of SEP-0023', () => {
    for (const bad of [
      'GAAAAAAAACGC6',
      'MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAAAAAAAAAAACJUR',
      'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZA',
      'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUACUSI',
      'G47QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVP2I',
      'MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVAAAAAAAAAAAAAJLKA',
      'MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVAAAAAAAAAAAAAAV75I',
      'M47QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAAAAAAAAAAACJUQ',
      'MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAAAAAAAAAAACJUK===',
      'MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAAAAAAAAAAACJUO',
      'PA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAAAAQACAQDAQCQMBYIBEFAWDANBYHRAEISCMKBKFQXDAMRUGY4DUPB6IAAAAAAAAPM',
      'BAAD6DBUX6J22DMZOHIEZTEQ64CVCHEDRKWZONFEUL5Q26QD7R76RGR4TV',
      'WA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAAAAAAAAAAAAWWA',
      G.toLowerCase(),
      '',
    ]) {
      expect(isStellarAddress(bad), bad).toBe(false);
      expect(['invalid', 'muxed'], bad).toContain(stellarAddressKind(bad));
    }
  });
});

describe('demo stellar_* commands', () => {
  let mock: MockBackend;
  let dialogs: string[];
  beforeEach(() => {
    dialogs = [];
    mock = createMockBackend({ network: 'testnet', torEnabled: false, confirm: (t) => (dialogs.push(t), true), preset: { password: 'correct horse battery', unlocked: true } });
    setBackend(mock.invoke);
  });

  const code = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      expect(e).toBeInstanceOf(IpcError);
      return (e as IpcError).message;
    }
    throw new Error('expected rejection');
  };

  it('account 0 in accounts_get, reserve (2 + 1) × 0.5 XLM, refusals with wallet-core messages', async () => {
    const a = await call('accounts_get');
    expect(a.stellar.path).toBe("m/44'/148'/0'");
    expect(isStellarAddress(a.stellar.address)).toBe(true);
    expect(await call('stellar_address')).toBe(a.stellar.address);
    expect(await call('stellar_account', { address: a.stellar.address })).toMatchObject({ exists: true, balance: '1250000000', reserve: '15000000', spendable: '1235000000', baseReserve: '5000000' });
    expect(await code(call('stellar_account', { address: 'MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAAAAAAAAAAACJUQ' }))).toMatch(/adresses M…/);
    expect(await code(call('stellar_account', { address: 'SBGWSG6BTNCKCOB3DIFBGCVMUPQFYPA2G4O34RMTB343OYPXU5DJDVMN' }))).toMatch(/CLÉ SECRÈTE/);
    expect(await call('stellar_backend_info')).toEqual({ kind: 'default', network: 'testnet', label: 'horizon-testnet.stellar.org', tor: false });
  });

  it('memo required, CreateAccount for an unfunded destination, payment, history', async () => {
    const st = mock.stellar;
    expect(await code(call('stellar_build_tx', { to: st.exchange, amount: '10000000' }))).toMatch(/exige un mémo/);
    const built = await call('stellar_build_tx', { to: st.exchange, amount: '10000000', memo: { kind: 'id', value: '804539585' } });
    expect(built.summary.operation).toEqual({ kind: 'payment', destination: st.exchange, asset: { kind: 'native' }, amount: '10000000' });
    expect(built.summary.memo).toEqual({ kind: 'id', id: '804539585' });
    const signed = await call('stellar_sign_tx', { envelope: built.envelope, password: 'correct horse battery' });
    expect(dialogs.at(-1)).toContain('MÉMO (identifiant) : 804539585');
    expect(await call('stellar_broadcast', { envelope: signed.envelope })).toBe(signed.hash);
    expect(await call('stellar_tx_status', { hash: signed.hash })).toEqual({ found: true, successful: true });
    // Same envelope again: the sequence number is used.
    expect(await code(call('stellar_sign_tx', { envelope: built.envelope, password: 'x' }))).toMatch(/séquence périmé/);
    // Unfunded destination: at least 1 XLM, then a CreateAccount.
    const fresh = stellarAddressOfKey(new Uint8Array(32).fill(7));
    expect(await code(call('stellar_build_tx', { to: fresh, amount: '9999999' }))).toMatch(/au moins 1 XLM/);
    const create = await call('stellar_build_tx', { to: fresh, amount: '20000000' });
    expect(create.summary.operation.kind).toBe('createAccount');
    await call('stellar_sign_tx', { envelope: create.envelope, password: 'correct horse battery' });
    expect(dialogs.at(-1)).toMatch(/création de compte[\s\S]*AUCUN MÉMO[\s\S]*1 XLM de réserve y reste bloqué/);
    // Too much: spendable (balance − reserve) minus the fee.
    expect(await code(call('stellar_build_tx', { to: st.friend, amount: '9999999999' }))).toMatch(/solde disponible insuffisant/);
    const h = await call('stellar_txs', { address: (await call('accounts_get')).stellar.address });
    expect(h[0]).toMatchObject({ type: 'payment', to: st.exchange, memo: { kind: 'id', id: '804539585' } });
  });

  it('memo rules like Rust', async () => {
    const st = mock.stellar;
    for (const [memo, msg] of [
      [{ kind: 'text', value: 'é'.repeat(15) }, /28 octets/],
      [{ kind: 'text', value: 'a‮b' }, /invisible/],
      [{ kind: 'id', value: '18446744073709551616' }, /au plus/],
      [{ kind: 'hash', value: 'ab' }, /64 caractères/],
    ] as const) {
      expect(await code(call('stellar_build_tx', { to: st.friend, amount: '1', memo }))).toMatch(msg);
    }
  });
});
