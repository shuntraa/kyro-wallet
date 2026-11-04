// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { matchAny, MAX_PER_GROUP } from './search';

const contacts = [
  { name: 'Alice', address: 'bc1qalice' },
  { name: 'Bob', address: '0xB0b' },
];
const fields = (c: (typeof contacts)[number]) => [c.name, c.address];

describe('matchAny', () => {
  it('finds a name or an address, whatever the case', () => {
    expect(matchAny('ali', contacts, fields)).toEqual([contacts[0]]);
    expect(matchAny('0XB0', contacts, fields)).toEqual([contacts[1]]);
  });

  it('waits for two characters', () => {
    expect(matchAny('a', contacts, fields)).toEqual([]);
    expect(matchAny('  ', contacts, fields)).toEqual([]);
  });

  it('skips missing fields and stops at the group limit', () => {
    expect(matchAny('xy', [{ a: undefined }], (i) => [i.a])).toEqual([]);
    const many = Array.from({ length: 20 }, (_, i) => ({ name: `Alice ${i}`, address: '' }));
    expect(matchAny('alice', many, fields)).toHaveLength(MAX_PER_GROUP);
  });
});
