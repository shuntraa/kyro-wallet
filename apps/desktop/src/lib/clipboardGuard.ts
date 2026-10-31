// SPDX-License-Identifier: GPL-3.0-or-later
//
// Clipboard guard for the recipient field. We remember exactly what was
// pasted; if the field later holds something else *without the user typing*
// (malware rewriting the field, a script, an extension), sending is blocked.
// Typing by hand disarms the guard (the user then checks the blocks).
//
// LIMIT: this does NOT catch a « clipper » (malware that replaces the address in the clipboard
// BEFORE the paste): the field then holds exactly what was pasted, the attacker's address. Only
// comparing with the source (or the address book) does. So a paste is never shown as « verified ».

export interface GuardState {
  /** Last pasted (or picked) value, null when the field was typed by hand. */
  pasted: string | null;
  /** The value differs from the paste without any keystroke. */
  tampered: boolean;
  /**
   * Origin of the current value. `picked`: chosen in Kyro's own lists (address book, « Mes
   * comptes »), watched like a paste. `typed` also covers an address handed over by another
   * screen (search palette), whose real origin is unknown.
   */
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
  // Unknown origin: compare with what was pasted.
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
