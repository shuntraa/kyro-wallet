// SPDX-License-Identifier: GPL-3.0-or-later
// Send's two recipient rules: the warning on a first send to an address, and « send only to my
// contacts ». Both read what this device already knows (history, address book); no request.

import { sameAddress, type Family } from '@kyro/chains';

/** `previous`: recipients of earlier sends of this wallet (failed ones left out by the caller). */
export function sentBefore(address: string, family: Family, previous: readonly string[]): boolean {
  const a = address.trim();
  return a.length > 0 && previous.some((p) => sameAddress(p, a, family));
}

export interface RecipientFacts {
  /** In the address book. */
  contact: boolean;
  /** One of the user's own addresses or accounts. */
  own: boolean;
  sentBefore: boolean;
}

/** First send to a stranger: warn in the review. */
export function isFirstSend(f: RecipientFacts): boolean {
  return !f.contact && !f.own && !f.sentBefore;
}

/** « Send only to my contacts » on: anything but a contact or an own address is refused. */
export function blockedByContactsOnly(on: boolean | undefined, f: RecipientFacts): boolean {
  return on === true && !f.contact && !f.own;
}
