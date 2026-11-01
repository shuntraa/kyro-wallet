// SPDX-License-Identifier: GPL-3.0-or-later
// Clipboard guard for the recipient field.

export interface GuardState {
  pasted: string | null;
  /** The value differs from the paste without any keystroke. */
  tampered: boolean;
  source: 'empty' | 'paste' | 'typed' | 'picked';
}

export const initialGuard: GuardState = { pasted: null, tampered: false, source: 'empty' };

/** A value chosen from Kyro's own lists: watched for later changes like a paste. */
export const pickedGuard = (value: string): GuardState => ({ pasted: value, tampered: false, source: 'picked' });

/** A value handed over by another screen (search palette): origin unknown, treated as typed. */
export const handedOverGuard: GuardState = { pasted: null, tampered: false, source: 'typed' };

const TYPED = /^(insertText|insertCompositionText|insertLineBreak|delete|historyUndo|historyRedo|insertReplacementText)/;

/** Reduce an `input` event. `inputType` comes from the native InputEvent (undefined for programmatic changes). */
export function guardOnInput(state: GuardState, value: string, inputType: string | undefined): GuardState {
  if (value === '') return initialGuard;
  if (inputType === 'insertFromPaste' || inputType === 'insertFromDrop' || inputType === 'insertFromPasteAsQuotation') {
    return { pasted: value, tampered: false, source: 'paste' };
  }
  if (inputType && TYPED.test(inputType)) return { pasted: null, tampered: false, source: 'typed' };
  if (state.pasted !== null && value !== state.pasted) return { ...state, tampered: true };
  return state;
}

/** Check the live DOM value against the state right before signing. */
export function guardVerify(state: GuardState, domValue: string, stateValue: string): GuardState {
  if (domValue !== stateValue) return { ...state, tampered: true };
  if (state.pasted !== null && domValue !== state.pasted) return { ...state, tampered: true };
  return state;
}

export function guardAllowsSend(state: GuardState, enabled: boolean): boolean {
  return !enabled || !state.tampered;
}
