// SPDX-License-Identifier: GPL-3.0-or-later
// The part of a backup kept in this interface's storage: address book, favorites, alerts. Rust
// encrypts and decrypts the file (`backup.rs`); this module reads what goes in and merges what comes
// out. A merge adds, and changes an existing name only when asked.

import { isLookalike, sameAddress } from '@kyro/chains';
import type { BackupContact, BackupLocal, BackupPriceAlert, Currency } from '@kyro/shared';
import { getAlertSettings, MAX_PRICE_ALERTS, saveAlertSettings, type PriceAlert } from './alerts';
import { CONTACT_FAMILIES } from './contactDetect';
import { getContacts, getFavorites, saveContacts, setFavorites, type Contact, type ContactFamily } from './storage';

const COIN_ID = /^[a-z0-9._-]{1,100}$/;
const ADDRESS = /^[\x21-\x7e]{1,200}$/;
/** What Rust refuses in a name: control, format and direction characters. */
const UNSAFE = /[\p{Cc}\p{Cf}]/gu;
const MAX_NAME = 200;

const cleanName = (name: string): string => [...name.replace(UNSAFE, '').trim()].slice(0, MAX_NAME).join('');

/** What this device has, in the shape Rust checks. An entry Rust would refuse stays out. */
export function collectLocal(): BackupLocal {
  const alerts = getAlertSettings();
  return {
    contacts: getContacts()
      .map((c) => ({ name: cleanName(c.name), address: c.address, family: c.family, sends: Math.max(0, Math.trunc(c.sends ?? 0)) }))
      .filter((c) => c.name && ADDRESS.test(c.address)),
    favorites: getFavorites().filter((f) => COIN_ID.test(f)),
    alerts: {
      received: alerts.received,
      prices: alerts.prices.filter((p) => COIN_ID.test(p.coinId)).map(({ coinId, symbol, direction, level, currency }) => ({ coinId, symbol, direction, level, currency })),
    },
  };
}

export interface ContactRename {
  id: string;
  address: string;
  current: string;
  backup: string;
}

export interface LocalPlan {
  addContacts: BackupContact[];
  renameContacts: ContactRename[];
  /** Left out: not a valid address of its network. */
  invalidContacts: number;
  /** Left out: almost the same address as a known one. The address book is trusted by Send. */
  lookalikeContacts: number;
  addFavorites: string[];
  addAlerts: BackupPriceAlert[];
  /** The backup has « funds received » on and this device has it off. */
  turnOnReceived: boolean;
}

const sameRule = (a: BackupPriceAlert, b: BackupPriceAlert) => a.coinId === b.coinId && a.direction === b.direction && a.level === b.level && a.currency === b.currency;

export function planLocal(incoming: BackupLocal, isValid: (family: ContactFamily, address: string) => boolean): LocalPlan {
  const contacts = getContacts();
  const added: BackupContact[] = [];
  const renameContacts: ContactRename[] = [];
  let invalidContacts = 0;
  let lookalikeContacts = 0;
  for (const c of incoming.contacts) {
    const family = c.family as ContactFamily;
    if (!CONTACT_FAMILIES.includes(family) || !isValid(family, c.address)) {
      invalidContacts += 1;
      continue;
    }
    const known = contacts.filter((x) => x.family === family);
    const same = known.find((x) => sameAddress(x.address, c.address, family));
    if (same) {
      if (same.name !== c.name) renameContacts.push({ id: same.id, address: same.address, current: same.name, backup: c.name });
      continue;
    }
    const twin = added.filter((x) => x.family === family);
    if (twin.some((x) => sameAddress(x.address, c.address, family))) continue;
    if ([...known, ...twin].some((x) => isLookalike(x.address, c.address, family))) {
      lookalikeContacts += 1;
      continue;
    }
    added.push(c);
  }
  const favorites = new Set(getFavorites());
  const alerts = getAlertSettings();
  const addAlerts: BackupPriceAlert[] = [];
  for (const a of incoming.alerts.prices) {
    if (alerts.prices.some((p) => sameRule(p, a)) || addAlerts.some((p) => sameRule(p, a))) continue;
    if (alerts.prices.length + addAlerts.length < MAX_PRICE_ALERTS) addAlerts.push(a);
  }
  return {
    addContacts: added,
    renameContacts,
    invalidContacts,
    lookalikeContacts,
    addFavorites: [...new Set(incoming.favorites)].filter((f) => !favorites.has(f)),
    addAlerts,
    turnOnReceived: incoming.alerts.received && !alerts.received,
  };
}

export function applyLocal(plan: LocalPlan, choices: { add: boolean; replaceNames: boolean }, now = Date.now()): void {
  const names = new Map(choices.replaceNames ? plan.renameContacts.map((r) => [r.id, r.backup]) : []);
  const fresh: Contact[] = choices.add ? plan.addContacts.map((c) => ({ id: crypto.randomUUID(), name: c.name, address: c.address, family: c.family as ContactFamily, sends: c.sends })) : [];
  if (names.size > 0 || fresh.length > 0) saveContacts([...getContacts().map((c) => ({ ...c, name: names.get(c.id) ?? c.name })), ...fresh]);
  if (!choices.add) return;
  if (plan.addFavorites.length > 0) setFavorites([...getFavorites(), ...plan.addFavorites]);
  if (plan.addAlerts.length > 0 || plan.turnOnReceived) {
    const s = getAlertSettings();
    const rules: PriceAlert[] = plan.addAlerts.map((a, i) => ({ ...a, id: `${now}-b${i}`, currency: a.currency as Currency, armed: true }));
    saveAlertSettings({ received: s.received || plan.turnOnReceived, prices: [...s.prices, ...rules].slice(0, MAX_PRICE_ALERTS) });
  }
}
