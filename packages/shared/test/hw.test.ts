import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { call, errorData, IpcError, onHwPrompt, setBackend, toIpcError, type HwPrompt } from '../src';
import { createMockBackend, DEMO_HW_DELAYS, DEMO_TREZOR_LAYOUT, demoDecodePin, demoThpCode, TREZOR_KEYPAD, type DemoHwScenario } from '../src/mock';

let prompts: HwPrompt[] = [];
let unlisten: (() => void) | null = null;

beforeEach(async () => {
  vi.useFakeTimers();
  prompts = [];
  unlisten = await onHwPrompt((p) => prompts.push(p));
});
afterEach(() => {
  unlisten?.();
  vi.clearAllTimers();
  vi.useRealTimers();
});

function setup(hw: DemoHwScenario, confirm: (s: string) => boolean = () => true) {
  const mock = createMockBackend({ network: 'testnet', hw, confirm, preset: { password: 'correct horse', unlocked: true } });
  setBackend(mock.invoke);
  return mock;
}

/** Runs a call while advancing the fake clock (device delays). */
async function settle<T>(p: Promise<T>, ms = 4000): Promise<T> {
  const guarded = p.then(
    (v) => ({ ok: true as const, v }),
    (e: unknown) => ({ ok: false as const, e }),
  );
  await vi.advanceTimersByTimeAsync(ms);
  const r = await guarded;
  if (!r.ok) throw r.e;
  return r.v;
}

async function code(p: Promise<unknown>, ms = 4000): Promise<IpcError> {
  try {
    await settle(p, ms);
  } catch (e) {
    expect(e).toBeInstanceOf(IpcError);
    return e as IpcError;
  }
  throw new Error('expected rejection');
}

describe('mock hardware wallets', () => {
  it('?hw=none: nothing plugged in', async () => {
    setup('none');
    expect(await settle(call('hw_list'))).toEqual([]);
    expect((await code(call('hw_open', { id: 'ledger-1' }))).code).toBe('HW_NOT_FOUND');
  });

  it('Ledger: per-chain state, wrong app with { expected, open }, then the keys', async () => {
    setup('ledger');
    expect(await settle(call('hw_list'))).toEqual([{ id: 'ledger-1', kind: 'ledger', model: 'Ledger Nano S Plus', transport: 'hid' }]);
    const st = await settle(call('hw_open', { id: 'ledger-1' }));
    expect(st.app?.name).toBe('Bitcoin Test');
    expect(st.chains.find((c) => c.chain === 'btc')?.state).toBe('ready');
    expect(st.chains.find((c) => c.chain === 'evm')).toMatchObject({ state: 'open-app', app: 'Ethereum' });
    expect(st.chains.find((c) => c.chain === 'xrp')?.state).toBe('unsupported');

    const btc = await settle(call('hw_get_xpub', { id: 'ledger-1', chain: 'btc', account: 0 }));
    expect(btc.btc?.map((b) => b.kind)).toEqual(['segwit', 'taproot']);
    expect(btc.btc?.[0]?.fingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect(btc.btc?.[0]?.path).toBe("m/84'/1'/0'");

    const wrong = await code(call('hw_get_xpub', { id: 'ledger-1', chain: 'evm', account: 0 }));
    expect(wrong.code).toBe('HW_WRONG_APP');
    expect(errorData(wrong, 'HW_WRONG_APP')).toEqual({ expected: 'Ethereum', open: 'Bitcoin Test' });
    // The user opened the app: retry works.
    const evm = await settle(call('hw_get_xpub', { id: 'ledger-1', chain: 'evm', account: 0 }));
    expect(evm.evm?.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(evm.evm?.path).toBe("m/44'/60'/0'/0");
    expect((await code(call('hw_get_xpub', { id: 'ledger-1', chain: 'ltc', account: 0 }))).code).toBe('HW_UNSUPPORTED');
  });

  it('error data survives toIpcError (as Rust sends it: { code, message, data })', () => {
    const e = toIpcError({ code: 'HW_UNSUPPORTED', message: 'Non pris en charge : x', data: { min: '1.10.4' } });
    expect(errorData(e, 'HW_UNSUPPORTED')).toEqual({ min: '1.10.4' });
    expect(errorData(e, 'HW_WRONG_APP')).toBeNull();
  });

  it('?hw=locked: HW_LOCKED, then usable once unlocked', async () => {
    setup('locked');
    expect((await settle(call('hw_open', { id: 'ledger-1' }))).locked).toBe(true);
    expect((await code(call('hw_get_xpub', { id: 'ledger-1', chain: 'btc', account: 0 }))).code).toBe('HW_LOCKED');
    expect((await settle(call('hw_get_xpub', { id: 'ledger-1', chain: 'btc', account: 0 }))).btc).toHaveLength(2);
  });

  it('?hw=wrongapp: dashboard open', async () => {
    setup('wrongapp');
    const e = await code(call('hw_get_xpub', { id: 'ledger-1', chain: 'btc', account: 0 }));
    expect(errorData(e, 'HW_WRONG_APP')).toEqual({ expected: 'Bitcoin Test', open: 'Tableau de bord' });
  });

  it('Trezor One: pin-matrix prompt, positions in KEYPAD convention (7 8 9 on top), never digits', async () => {
    setup('trezor-one');
    const p = call('hw_get_xpub', { id: 'trezor-1', chain: 'btc', account: 0 });
    const guarded = p.then((v) => v, (e: unknown) => e);
    await vi.advanceTimersByTimeAsync(200);
    expect(prompts.at(-1)).toEqual({ id: 'trezor-1', kind: 'pin-matrix' });
    // The device screen shows DEMO_TREZOR_LAYOUT; the user clicks the cells where 1, 2, 3, 4 are.
    const positionOf = (digit: number) => {
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) if (DEMO_TREZOR_LAYOUT[r]?.[c] === digit) return TREZOR_KEYPAD[r]?.[c] ?? '';
      return '';
    };
    const positions = [1, 2, 3, 4].map(positionOf).join('');
    expect(positions).toBe('9571'); // top-right, centre, top-left, bottom-left
    expect(demoDecodePin(positions)).toBe('1234');
    await call('hw_pin_matrix', { id: 'trezor-1', positions });
    await vi.advanceTimersByTimeAsync(3000);
    const keys = await guarded;
    expect((keys as { btc: unknown[] }).btc).toHaveLength(2);
    // Solana does not exist on the One.
    expect((await code(call('hw_get_xpub', { id: 'trezor-1', chain: 'sol', account: 0 }))).code).toBe('HW_UNSUPPORTED');
  });

  it('Trezor One: wrong positions → HW_LOCKED; positions validated (1–9 only)', async () => {
    setup('trezor-one');
    const p = call('hw_get_xpub', { id: 'trezor-1', chain: 'btc', account: 0 }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(200);
    expect((await code(call('hw_pin_matrix', { id: 'trezor-1', positions: '12a4' }))).code).toBe('INVALID_INPUT');
    await call('hw_pin_matrix', { id: 'trezor-1', positions: '1234' }); // positions of the digits 4, 7, 5, 3: not the PIN
    await vi.advanceTimersByTimeAsync(500);
    expect(((await p) as IpcError).code).toBe('HW_LOCKED');
  });

  it('Trezor One passphrase (typed on the computer) is refused; old firmware gives { min }', async () => {
    setup('trezor-one-passphrase');
    const p = call('hw_get_xpub', { id: 'trezor-1', chain: 'btc', account: 0 }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(200);
    await call('hw_pin_matrix', { id: 'trezor-1', positions: '9571' });
    await vi.advanceTimersByTimeAsync(500);
    const e = (await p) as IpcError;
    expect(e.code).toBe('HW_UNSUPPORTED');
    expect(errorData(e, 'HW_UNSUPPORTED')).toEqual({ min: null });

    setup('old');
    const old = await code(call('hw_get_xpub', { id: 'trezor-1', chain: 'btc', account: 0 }));
    expect(errorData(old, 'HW_UNSUPPORTED')).toEqual({ min: '1.10.4' });
  });

  it('accounts: add (merge per chain), list, remove', async () => {
    setup('trezor');
    const acc = await settle(call('hw_account_add', { id: 'trezor-1', chain: 'btc', account: 0 }));
    expect(acc).toMatchObject({ device: 'trezor', model: 'Trezor Safe 5', network: 'testnet', account: 0, label: 'Trezor Safe 5 1' });
    expect(acc.id).toMatch(/^hw-[0-9a-f]{16}$/);
    expect(prompts.some((p) => p.kind === 'pin-on-device')).toBe(true);
    const merged = await settle(call('hw_account_add', { id: 'trezor-1', chain: 'sol', account: 0, accountId: acc.id }));
    expect(merged.id).toBe(acc.id);
    expect(merged.btc).toHaveLength(2);
    expect(merged.sol?.path).toBe("m/44'/501'/0'/0'");
    expect((await code(call('hw_account_add', { id: 'trezor-1', chain: 'evm', account: 1, accountId: acc.id }))).code).toBe('INVALID_INPUT');
    expect(await call('hw_accounts_get')).toHaveLength(1);
    await call('hw_account_remove', { accountId: acc.id });
    expect(await call('hw_accounts_get')).toEqual([]);
  });

  it('verify address: confirm on device; ?hw=mismatch → HW_ADDRESS_MISMATCH { device, expected }', async () => {
    setup('trezor');
    const acc = await settle(call('hw_account_add', { id: 'trezor-1', chain: 'evm', account: 0 }));
    const ok = await settle(call('hw_verify_address', { id: 'trezor-1', accountId: acc.id, chain: 'evm', path: "m/44'/60'/0'/0/0" }));
    expect(ok.address).toMatch(/^0x/);
    expect(prompts.at(-1)?.kind).toBe('confirm-on-device');
    expect((await code(call('hw_verify_address', { id: 'trezor-1', accountId: acc.id, chain: 'evm', path: "m/44'/60'/0'/0/0/1" }))).code).toBe('INVALID_INPUT');

    setup('mismatch');
    const lacc = await settle(call('hw_account_add', { id: 'ledger-1', chain: 'btc', account: 0 }));
    const e = await code(call('hw_verify_address', { id: 'ledger-1', accountId: lacc.id, chain: 'btc', path: "m/84'/1'/0'/0/0" }));
    expect(e.code).toBe('HW_ADDRESS_MISMATCH');
    const d = errorData(e, 'HW_ADDRESS_MISMATCH');
    expect(d?.device).not.toBe(d?.expected);
  });

  it('signing scenarios: reject, unplug mid-signing, timeout, cancel, busy', async () => {
    const tx = { chainId: 11155111, nonce: 0, to: '0x0000000000000000000000000000000000000001', valueWei: '1', data: '0x', gasLimit: 21000, maxFeePerGas: '1', maxPriorityFeePerGas: '1' };
    for (const [scenario, expected] of [['reject', 'HW_REJECTED'], ['unplug', 'HW_DISCONNECTED'], ['timeout', 'HW_TIMEOUT']] as const) {
      setup(scenario);
      await settle(call('hw_open', { id: 'ledger-1' })); // dashboard? no: Bitcoin Test open
      await code(call('hw_get_xpub', { id: 'ledger-1', chain: 'evm', account: 0 })); // HW_WRONG_APP, app opened
      const acc = await settle(call('hw_account_add', { id: 'ledger-1', chain: 'evm', account: 0 }));
      expect((await code(call('hw_sign_evm_tx', { id: 'ledger-1', accountId: acc.id, tx }), 6000)).code).toBe(expected);
    }
    // Native dialog refused: USER_REJECTED, the device is never asked.
    setup('trezor', () => false);
    const acc = await settle(call('hw_account_add', { id: 'trezor-1', chain: 'evm', account: 0 }));
    prompts = [];
    expect((await code(call('hw_sign_evm_tx', { id: 'trezor-1', accountId: acc.id, tx }))).code).toBe('USER_REJECTED');
    expect(prompts.some((p) => p.kind === 'confirm-on-device')).toBe(false);

    // hw_cancel ends the pending call in USER_REJECTED; a 2nd call meanwhile is HW_BUSY.
    setup('trezor');
    const acc2 = await settle(call('hw_account_add', { id: 'trezor-1', chain: 'evm', account: 0 }));
    const pending = call('hw_sign_evm_tx', { id: 'trezor-1', accountId: acc2.id, tx }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(100);
    expect(((await call('hw_get_xpub', { id: 'trezor-1', chain: 'btc', account: 0 }).catch((e: unknown) => e)) as IpcError).code).toBe('HW_BUSY');
    expect(await call('hw_cancel', { id: 'trezor-1' })).toBe(true);
    expect(((await pending) as IpcError).code).toBe('USER_REJECTED');
    expect(await call('hw_cancel', { id: 'trezor-1' })).toBe(false);
  });

  it('Safe 7 (THP): first pairing asks to allow Kyro, a 6-digit code, then the connection; status says thp', async () => {
    setup('safe7');
    expect((await settle(call('hw_list')))[0]).toMatchObject({ id: 'trezor-1', kind: 'trezor', model: 'Trezor' });
    // Not paired yet: any command but hw_open → HW_PAIRING_REQUIRED.
    expect((await code(call('hw_get_xpub', { id: 'trezor-1', chain: 'btc', account: 0 }))).code).toBe('HW_PAIRING_REQUIRED');
    const p = call('hw_open', { id: 'trezor-1' }).then((v) => v, (e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1100);
    expect(prompts.at(-1)).toEqual({ id: 'trezor-1', kind: 'thp-confirm-pairing' });
    await vi.advanceTimersByTimeAsync(1600);
    expect(prompts.at(-1)).toEqual({ id: 'trezor-1', kind: 'thp-pairing-code' });
    const shown = demoThpCode();
    expect(shown).toMatch(/^[0-9]{6}$/);
    // Malformed: INVALID_INPUT, the pairing keeps waiting.
    expect((await code(call('hw_thp_pairing_code', { id: 'trezor-1', code: '12345' }))).code).toBe('INVALID_INPUT');
    await call('hw_thp_pairing_code', { id: 'trezor-1', code: shown! });
    await vi.advanceTimersByTimeAsync(300);
    expect(prompts.some((x) => x.kind === 'thp-confirm-connection')).toBe(true);
    await vi.advanceTimersByTimeAsync(4000);
    const st = (await p) as { model: string; protocol?: string };
    expect(st).toMatchObject({ model: 'Trezor Safe 7', protocol: 'thp' });
    const list = await call('hw_thp_pairings');
    expect(list).toHaveLength(1);
    expect(list[0]?.model).toBe('T3W1');
    expect((await settle(call('hw_get_xpub', { id: 'trezor-1', chain: 'btc', account: 0 }))).btc?.length).toBeTruthy();
    // Forget: the next command needs pairing again.
    expect(await call('hw_thp_forget', { key: list[0]!.key })).toBe(1);
    expect(await call('hw_thp_pairings')).toEqual([]);
    expect((await code(call('hw_get_xpub', { id: 'trezor-1', chain: 'btc', account: 0 }))).code).toBe('HW_PAIRING_REQUIRED');
  });

  it('Safe 7: a wrong code → HW_PAIRING_FAILED, nothing stored; a retry shows a new code', async () => {
    setup('safe7');
    const p = call('hw_open', { id: 'trezor-1' }).then((v) => v, (e: unknown) => e);
    await vi.advanceTimersByTimeAsync(2700);
    const first = demoThpCode()!;
    await call('hw_thp_pairing_code', { id: 'trezor-1', code: first === '000000' ? '111111' : '000000' });
    await vi.advanceTimersByTimeAsync(300);
    expect(((await p) as IpcError).code).toBe('HW_PAIRING_FAILED');
    expect(await call('hw_thp_pairings')).toEqual([]);
    // No pairing pending any more.
    expect((await code(call('hw_thp_pairing_code', { id: 'trezor-1', code: '123456' }))).code).toBe('HW_BAD_RESPONSE');
    // hw_cancel during the code entry ends hw_open in USER_REJECTED.
    const again = call('hw_open', { id: 'trezor-1' }).then((v) => v, (e: unknown) => e);
    await vi.advanceTimersByTimeAsync(2700);
    expect(demoThpCode()).toMatch(/^[0-9]{6}$/);
    expect(await call('hw_cancel', { id: 'trezor-1' })).toBe(true);
    await vi.advanceTimersByTimeAsync(200);
    expect(((await again) as IpcError).code).toBe('USER_REJECTED');
  });

  it('?hw=safe7-paired: only the connection is confirmed; « Tout oublier » clears the list', async () => {
    setup('safe7-paired');
    expect(await call('hw_thp_pairings')).toHaveLength(1);
    const p = call('hw_open', { id: 'trezor-1' }).then((v) => v, (e: unknown) => e);
    await vi.advanceTimersByTimeAsync(5000);
    expect(prompts.some((x) => x.kind === 'thp-pairing-code' || x.kind === 'thp-confirm-pairing')).toBe(false);
    expect(prompts.some((x) => x.kind === 'thp-confirm-connection')).toBe(true);
    expect(((await p) as { protocol?: string }).protocol).toBe('thp');
    expect(await call('hw_thp_forget', {})).toBe(1);
    expect(await call('hw_thp_pairings')).toEqual([]);
  });

  it('delays are in the 1–3 s range', () => {
    for (const ms of [DEMO_HW_DELAYS.open, DEMO_HW_DELAYS.keys, DEMO_HW_DELAYS.verify, DEMO_HW_DELAYS.sign]) {
      expect(ms).toBeGreaterThanOrEqual(1000);
      expect(ms).toBeLessThanOrEqual(3000);
    }
  });
});
