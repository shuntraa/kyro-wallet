// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { createMockBackend } from '@kyro/shared/mock';
import { setBackend, call } from '@kyro/shared';
import { createAdapters, isHiddenFamily } from '@kyro/chains';
import { accountAddress } from './accounts';
import { adapterValidator, CONTACT_FAMILIES, detectFamilies } from './contactDetect';

describe('address book: network detected from the address', () => {
  it('finds the family of each sample address; 0x + 64 hex stays ambiguous', async () => {
    setBackend(createMockBackend({ network: 'testnet', confirm: () => true, preset: { password: 'correct horse', unlocked: true } }).invoke);
    const acc = await call('accounts_get', { account: 0 });
    const valid = adapterValidator(createAdapters(acc));
    for (const f of CONTACT_FAMILIES.filter((x) => !isHiddenFamily(x))) {
      const found = detectFamilies(accountAddress(acc, f).address, valid);
      if (f === 'sui' || f === 'apt') expect(found).toEqual(['sui', 'apt']);
      else expect(found, f).toEqual([f]);
    }
    expect(detectFamilies(`  ${acc.evm.address}  `, valid)).toEqual(['evm']);
    expect(detectFamilies('0x1234', valid)).toEqual([]);
    expect(detectFamilies('Not An Address!', valid)).toEqual([]);
    expect(detectFamilies('', valid)).toEqual([]);
  });

  it('keeps every candidate the validators accept, in book order', () => {
    expect(detectFamilies('x', (f) => f === 'apt' || f === 'sui')).toEqual(['sui', 'apt']);
    expect(detectFamilies('x', (f) => f === 'near')).toEqual(['near']);
    expect(detectFamilies('x', (f) => f === 'btc' || f === 'near')).toEqual(['btc']);
  });
});
