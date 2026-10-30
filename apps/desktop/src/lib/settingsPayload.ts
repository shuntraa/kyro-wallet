// SPDX-License-Identifier: GPL-3.0-or-later
// What the UI sends to `settings_set`. API keys are write-only: `settings_get` returns only
// `apiKeysSet` (booleans), so the payload never carries a key it did not just receive from the
// user. Anything else that looks like a key (an `apiKeys` field on the settings object, from an
// older shell or a bug) is dropped here, never re-sent.

import { API_KEY_NAMES, type ApiKeysUpdate, type Settings, type SettingsInput } from '@kyro/shared';

export function settingsPayload(next: Settings, apiKeys?: ApiKeysUpdate): SettingsInput {
  // Drop `apiKeysSet` and any stray `apiKeys` the object may carry: never re-sent.
  const { apiKeysSet: _set, apiKeys: _stray, ...rest } = next as Settings & { apiKeys?: unknown };
  const update: ApiKeysUpdate = {};
  for (const name of API_KEY_NAMES) {
    const v = apiKeys?.[name];
    // `null` would mean « unchanged »: simply not sent. "" removes (only ever on « Supprimer »).
    if (v !== undefined && v !== null) update[name] = v.trim();
  }
  return Object.keys(update).length > 0 ? { ...rest, apiKeys: update } : rest;
}
