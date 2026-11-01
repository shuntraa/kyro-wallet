// SPDX-License-Identifier: GPL-3.0-or-later
//
// Writes every drawn coin mark as a standalone SVG (one file per ticker, lowercase) plus an
// index.json, from the same source as the app's CoinIcon.
// Usage (Node ≥ 22.18, type stripping): node apps/desktop/scripts/export-coin-icons.ts <out-dir>

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MARKS, iconTree, toSvgString, type MarkKey } from '../src/components/coins/marks.ts';

/** File name per mark: its ticker (Base has no token, Sonic's ticker is S). */
const FILE: Partial<Record<MarkKey, string>> = { sonic: 's' };

const out = process.argv[2];
if (!out) {
  console.error('usage: export-coin-icons.ts <out-dir>');
  process.exit(1);
}
mkdirSync(out, { recursive: true });
const index: Record<string, { name: string; color: string }> = {};
for (const key of Object.keys(MARKS) as MarkKey[]) {
  const mark = MARKS[key];
  const file = FILE[key] ?? key;
  const svg = toSvgString({ ...iconTree({ mark, color: mark.color }, `k${file}`), a: { viewBox: '0 0 64 64', width: 64, height: 64 } });
  writeFileSync(join(out, `${file}.svg`), `${svg}\n`);
  index[file] = { name: mark.name, color: mark.color };
}
writeFileSync(join(out, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
console.log(`${Object.keys(index).length} icônes écrites dans ${out}`);
