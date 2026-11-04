// SPDX-License-Identifier: GPL-3.0-or-later
// Global search over what is already on this device: contacts, history, settings sections.

export const MIN_QUERY = 2;
export const MAX_PER_GROUP = 4;

const has = (text: string | undefined, q: string): boolean => !!text && text.toLowerCase().includes(q);

/** Up to {@link MAX_PER_GROUP} items whose fields contain the query (case ignored). */
export function matchAny<T>(query: string, items: readonly T[], fields: (item: T) => Array<string | undefined>): T[] {
  const q = query.trim().toLowerCase();
  if (q.length < MIN_QUERY) return [];
  const out: T[] = [];
  for (const item of items) {
    if (fields(item).some((f) => has(f, q))) out.push(item);
    if (out.length === MAX_PER_GROUP) break;
  }
  return out;
}
