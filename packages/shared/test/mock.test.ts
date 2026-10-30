import { beforeEach, describe, expect, it } from 'vitest';
import { validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { call, IpcError, setBackend } from '../src';
import { createMockBackend, type MockBackend } from '../src/mock';

let mock: MockBackend;

beforeEach(() => {
  mock = createMockBackend({ network: 'testnet', confirm: () => true });
  setBackend(mock.invoke);
});

async function rejectCode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(IpcError);
    return (e as IpcError).code;
  }
  throw new Error('expected rejection');
}

describe('mock IPC backend', () => {
  it('starts without a vault, creates one and shows 24 valid words once', async () => {
    expect(await call('vault_status')).toEqual({ exists: false, unlocked: false, autoLockSecs: 900, lockInSecs: null });
    const { words } = await call('vault_create', { password: 'correct horse', words: 24 });
    expect(words).toHaveLength(24);
    expect(validateMnemonic(words.join(' '), wordlist)).toBe(true);
    const st = await call('vault_status');
    expect(st.exists && st.unlocked).toBe(true);
    expect(st.lockInSecs).toBeGreaterThan(890);
    expect(await rejectCode(call('vault_create', { password: 'another one', words: 12 }))).toBe('INVALID_INPUT');
  });

  it('rejects short passwords and invalid phrases on import', async () => {
    expect(await rejectCode(call('vault_create', { password: 'short', words: 24 }))).toBe('INVALID_INPUT');
    expect(await rejectCode(call('vault_import', { password: 'long enough', phrase: 'abandon abandon abandon' }))).toBe('INVALID_INPUT');
    await call('vault_import', { password: 'long enough', phrase: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about' });
    expect((await call('vault_status')).unlocked).toBe(true);
  });

  it('locks, refuses accounts while locked, rate-limits wrong passwords', async () => {
    await call('vault_create', { password: 'correct horse', words: 12 });
    await call('vault_lock');
    expect(await rejectCode(call('accounts_get'))).toBe('LOCKED');
    for (let i = 0; i < 5; i++) expect(await rejectCode(call('vault_unlock', { password: 'nope nope' }))).toBe('WRONG_PASSWORD');
    expect(await rejectCode(call('vault_unlock', { password: 'correct horse' }))).toBe('RATE_LIMITED');
    mock.advance(6000);
    await call('vault_unlock', { password: 'correct horse' });
    const acc = await call('accounts_get');
    expect(acc.network).toBe('testnet');
    expect(acc.btc.segwit.address.startsWith('tb1q')).toBe(true);
    expect(acc.btc.taproot.address.startsWith('tb1p')).toBe(true);
    expect(acc.btc.segwit.xpub.startsWith('tpub')).toBe(true);
    expect(acc.btc.segwit.path).toBe("m/84'/1'/0'");
    expect(acc.evm.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it('auto-locks after inactivity; session_touch postpones it', async () => {
    await call('vault_create', { password: 'correct horse', words: 12 });
    mock.advance(800_000);
    await call('session_touch');
    mock.advance(800_000);
    expect((await call('vault_status')).unlocked).toBe(true);
    mock.advance(200_000);
    expect((await call('vault_status')).unlocked).toBe(false);
  });

  it('decodes EVM transfers and approvals like the Rust core', async () => {
    const base = { chainId: 11155111, nonce: 0, gasLimit: 50_000, maxFeePerGas: '10', maxPriorityFeePerGas: '1', valueWei: '0' };
    const spender = '0000000000001ff3684f28c67538d4d072c22734';
    const approve = await call('evm_decode_tx', { tx: { ...base, to: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', data: '0x095ea7b3' + spender.padStart(64, '0') + 'f'.repeat(64) } });
    expect(approve.kind).toBe('Erc20Approve');
    expect(approve.unlimitedApproval).toBe(true);
    expect(approve.maxFeeWei).toBe('500000');
    const native = await call('evm_decode_tx', { tx: { ...base, to: '0x0000000000000000000000000000000000000001', data: '0x', valueWei: '25' } });
    expect(native).toMatchObject({ kind: 'NativeTransfer', amount: '25', tokenContract: null, spender: null });
  });

  it('signing requires the password and honours a rejected native dialog', async () => {
    const rejecting = createMockBackend({ network: 'testnet', confirm: () => false, preset: { password: 'correct horse', unlocked: true } });
    setBackend(rejecting.invoke);
    const tx = { chainId: 11155111, nonce: 0, to: '0x0000000000000000000000000000000000000001', valueWei: '1', data: '0x', gasLimit: 21000, maxFeePerGas: '1', maxPriorityFeePerGas: '1' };
    expect(await rejectCode(call('evm_sign_tx', { tx, password: 'wrong password' }))).toBe('WRONG_PASSWORD');
    expect(await rejectCode(call('evm_sign_tx', { tx, password: 'correct horse' }))).toBe('USER_REJECTED');
  });

  it('net_fetch enforces the allowlist and HTTPS', async () => {
    expect(await rejectCode(call('net_fetch', { req: { url: 'https://evil.example.com/x', method: 'GET' } }))).toBe('HOST_NOT_ALLOWED');
    expect(await rejectCode(call('net_fetch', { req: { url: 'http://api.coingecko.com/api/v3/ping', method: 'GET' } }))).toBe('HOST_NOT_ALLOWED');
    const res = await call('net_fetch', { req: { url: 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=eur&per_page=200', method: 'GET' } });
    expect(res.status).toBe(200);
    expect((JSON.parse(res.body) as unknown[]).length).toBeGreaterThan(5);
  });

  it('settings round-trip with validation; config never exposes keys', async () => {
    const s = await call('settings_get');
    const next = await call('settings_set', { settings: { ...s, currency: 'USD', autoLockSecs: 300 } });
    expect(next.currency).toBe('USD');
    expect(await rejectCode(call('settings_set', { settings: { ...s, rpc: { ethereum: 'http://insecure' } } }))).toBe('INVALID_INPUT');
    const cfg = await call('config_get');
    expect(Object.keys(cfg).sort()).toEqual(['hasCoingeckoKey', 'hasOneinchKey', 'hasZeroxKey', 'network']);
  });

  it('reveal is password-gated and rate-limited', async () => {
    const { words } = await call('vault_create', { password: 'correct horse', words: 12 });
    expect((await call('vault_reveal_mnemonic', { password: 'correct horse' })).words).toEqual(words);
    await call('vault_reveal_mnemonic', { password: 'correct horse' });
    await call('vault_reveal_mnemonic', { password: 'correct horse' });
    expect(await rejectCode(call('vault_reveal_mnemonic', { password: 'correct horse' }))).toBe('RATE_LIMITED');
  });
});
