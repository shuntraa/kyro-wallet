#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Applies to a raw app binary the same patch as the Tauri bundler. The bundler replaces the first
// __TAURI_BUNDLE_TYPE_VAR_UNK of the binary with the package type, in the copy that goes into each
// package, so the exe inside the NSIS installer and the one inside the MSI differ from the raw
// build by three bytes. See docs/REPRODUCIBLE.md.
//
//   node scripts/patch-bundle-type.mjs <raw binary> <NSS|MSI|DEB|APP> <output>
import { readFileSync, writeFileSync } from 'node:fs';

const [input, type, output] = process.argv.slice(2);
if (!input || !output || !['NSS', 'MSI', 'DEB', 'APP'].includes(type ?? '')) {
  console.error('usage: patch-bundle-type.mjs <raw binary> <NSS|MSI|DEB|APP> <output>');
  process.exit(2);
}

const token = Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK');
const data = readFileSync(input);
const at = data.indexOf(token);
if (at < 0) {
  console.error(`${input}: no bundle type marker, not a raw Tauri binary`);
  process.exit(1);
}
data.write(type, at + token.length - type.length, 'latin1');
writeFileSync(output, data);
