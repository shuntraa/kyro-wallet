import { afterEach, describe, expect, it } from 'vitest';
import { emitDemoEvent, IpcError, onHwPrompt, toIpcError } from '@kyro/shared';
import { DEMO_TREZOR_LAYOUT, demoDecodePin, TREZOR_KEYPAD } from '@kyro/shared/mock';
import { createHwPromptStore, hwErrorView, isAddressMismatch, PIN_MATRIX_KEYPAD, pinPosition, type HwPromptStore } from './hw';

let store: HwPromptStore | null = null;
afterEach(() => {
  store?.stop();
  store = null;
});

describe('Trezor One PIN matrix: positions only, numeric-keypad convention', () => {
  it('pins the cell → position mapping (row 0 = top row as drawn): 7 8 9 / 4 5 6 / 1 2 3', () => {
    expect([0, 1, 2].map((c) => pinPosition(0, c)).join('')).toBe('789');
    expect([0, 1, 2].map((c) => pinPosition(1, c)).join('')).toBe('456');
    expect([0, 1, 2].map((c) => pinPosition(2, c)).join('')).toBe('123');
    expect(pinPosition(0, 0)).toBe('7'); // top-left is NOT '1' (phone layout)
    expect(pinPosition(2, 2)).toBe('3');
    expect(() => pinPosition(3, 0)).toThrow();
    expect(PIN_MATRIX_KEYPAD.map((r) => r.join(''))).toEqual(TREZOR_KEYPAD.map((r) => r.join('')));
  });

  it('clicking the cells where the device shows 1, 2, 3, 4 sends positions that decode to 1234', () => {
    const cellOf = (digit: number): [number, number] => {
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) if (DEMO_TREZOR_LAYOUT[r]?.[c] === digit) return [r, c];
      throw new Error('digit');
    };
    const positions = [1, 2, 3, 4].map((d) => pinPosition(...cellOf(d))).join('');
    expect(positions).not.toBe('1234');
    expect(/^[1-9]+$/.test(positions)).toBe(true);
    expect(demoDecodePin(positions)).toBe('1234');
  });
});

describe('hardware-wallet error messages', () => {
  const v = (code: string, data?: unknown) => hwErrorView(toIpcError({ code, message: 'x', data }));
  it('every HW_* code has a precise French message, with its data', () => {
    expect(v('HW_LOCKED').title).toBe('Appareil verrouillé');
    expect(v('HW_WRONG_APP', { expected: 'Ethereum', open: 'Bitcoin Test' }).detail).toContain('« Ethereum »');
    expect(v('HW_WRONG_APP', { expected: 'Ethereum', open: 'Bitcoin Test' }).detail).toContain('« Bitcoin Test »');
    expect(v('HW_REJECTED').detail).toMatch(/rien n’a été signé/);
    expect(v('HW_DISCONNECTED').detail).toMatch(/[Rr]ien n’a été signé ni envoyé/);
    expect(v('HW_TIMEOUT').title).toMatch(/Pas de réponse/);
    expect(v('HW_UNSUPPORTED', { min: '1.10.4' })).toMatchObject({ title: 'Firmware ou application trop ancien' });
    expect(v('HW_UNSUPPORTED', { min: '1.10.4' }).detail).toContain('1.10.4');
    expect(v('HW_UNSUPPORTED', { min: null }).title).toBe('Non pris en charge');
    expect(v('HW_BUSY').detail).toMatch(/Ledger Live|Trezor Suite/);
    expect(v('HW_WRONG_DEVICE').title).toBe('Pas le bon appareil');
    expect(v('HW_ADDRESS_MISMATCH', { device: 'a', expected: 'b' })).toMatchObject({ safe: false });
    expect(v('HW_NOT_FOUND').title).toBe('Appareil introuvable');
    expect(v('USER_REJECTED').title).toBe('Annulé');
    expect(isAddressMismatch(new IpcError('HW_ADDRESS_MISMATCH', 'x', { device: 'a', expected: 'b' }))).toBe(true);
    expect(isAddressMismatch(new IpcError('HW_REJECTED', 'x'))).toBe(false);
  });
});

describe('hw-prompt store', () => {
  it('tracks the last prompt per device and clears it when the operation ends', async () => {
    store = createHwPromptStore(onHwPrompt);
    await store.start();
    emitDemoEvent('hw-prompt', { id: 'trezor-1', kind: 'pin-matrix' });
    expect(store.getSnapshot().byDevice).toEqual({ 'trezor-1': 'pin-matrix' });
    emitDemoEvent('hw-prompt', { id: 'trezor-1', kind: 'confirm-on-device' });
    emitDemoEvent('hw-prompt', { id: 'ledger-1', kind: 'confirm-on-device' });
    expect(store.getSnapshot().byDevice).toEqual({ 'trezor-1': 'confirm-on-device', 'ledger-1': 'confirm-on-device' });
    store.clear('trezor-1');
    expect(store.getSnapshot().byDevice).toEqual({ 'ledger-1': 'confirm-on-device' });
  });
});
