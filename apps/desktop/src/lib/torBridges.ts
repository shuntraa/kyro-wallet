// SPDX-License-Identifier: GPL-3.0-or-later
// First look at pasted bridge lines, for a clear message. Rust checks them again with arti's parser.

export type BridgeProblem = { line: number; kind: 'transport' | 'format' };

const FINGERPRINT = /^[0-9a-f]{40}$/i;

export function splitBridgeLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** The first line that cannot work, numbered from 1 among the non-empty lines. */
export function bridgeProblem(lines: readonly string[]): BridgeProblem | null {
  for (const [i, raw] of lines.entries()) {
    const words = raw.split(/\s+/);
    if (words[0]?.toLowerCase() === 'bridge') words.shift();
    const [first = '', second = ''] = words;
    if (!first.includes(':')) return { line: i + 1, kind: 'transport' };
    if (!FINGERPRINT.test(second)) return { line: i + 1, kind: 'format' };
  }
  return null;
}
