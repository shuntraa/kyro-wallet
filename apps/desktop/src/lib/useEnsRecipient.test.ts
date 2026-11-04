import { describe, expect, it } from 'vitest';
import { ensActive, ensAddress, type EnsState } from './useEnsRecipient';

const ok: EnsState = { status: 'ok', input: 'vitalik.eth', name: 'vitalik.eth', address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045' };

describe('ENS in the recipient field', () => {
  it('uses an answer only for the text it answers', () => {
    expect(ensAddress(ok, ' vitalik.eth ')).toBe(ok.status === 'ok' ? ok.address : null);
    expect(ensAddress(ok, 'vitalik2.eth')).toBeNull();
    expect(ensAddress({ status: 'loading', input: 'vitalik.eth' }, 'vitalik.eth')).toBeNull();
    expect(ensAddress({ status: 'notFound', input: 'vitalik.eth' }, 'vitalik.eth')).toBeNull();
  });

  it('is out of the way for anything else', () => {
    expect(ensActive({ status: 'idle' }, '0xabc')).toBe(false);
    expect(ensActive(ok, '0xabc')).toBe(false);
    expect(ensActive({ status: 'failed', input: 'a.eth' }, 'a.eth')).toBe(true);
  });
});
