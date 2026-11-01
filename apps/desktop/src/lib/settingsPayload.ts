// SPDX-License-Identifier: GPL-3.0-or-later
// What the UI sends to `settings_set`.

import { API_KEY_NAMES, type ApiKeysUpdate, type Settings, type SettingsInput } from '@kyro/shared';

export function settingsPayload(next: Settings, apiKeys?: ApiKeysUpdate): SettingsInput {
  // Drop `apiKeysSet` and any stray `apiKeys` the object may carry: never re-sent.
  const { apiKeysSet: _set, apiKeys: _stray, ...rest } = next as Settings & { apiKeys?: unknown };
  const update: ApiKeysUpdate = {};
  for (const name of API_KEY_NAMES) {
    const v = apiKeys?.[name];
    if (v !== undefined && v !== null) update[name] = v.trim();
  }
  return Object.keys(update).length > 0 ? { ...rest, apiKeys: update } : rest;
}
