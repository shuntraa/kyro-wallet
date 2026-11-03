import { describe, expect, it } from 'vitest';
import { EXOLIX_ARRIVAL_ONLY, exolixFeeRecipients, exolixRoute, feeRecipientFor, KYRO_SWAP_FEE, validFeeAddress } from '../src';

const ADDR = {
  monero: '49DAQ21kb2eAjpNKAYsg6hJVJGqoj3fRdHBEyUqG1zydPbCvLmt3WyxUKVYKYMpjSqUKeruBo3YuSdyjoFG5TvQ3JcBze6A',
  kaspa: 'kaspa:qqxazzgtyn5352uzj2nzugg6cr3pct8rzpxphc2q73m67km7zrdv6dh8ctekt',
  algorand: 'F6X4KFXUPNMILGKMTDRT3CN76DJFKMOJYVV7ENOAZPCUAZCGWCDPR2HLL4',
  near: '8a8b179c1ac354da90b8d16bf7661ab7fe60de3fd7c99cd37f1150cd884cfbc4',
} as const;

/** Changes one character (keeps the alphabet), so only the checksum can catch it. */
const corrupt = (a: string, i: number, alphabet: string): string => {
  const c = a[i] ?? '';
  const next = alphabet[(alphabet.indexOf(c) + 1) % alphabet.length] ?? c;
  return a.slice(0, i) + next + a.slice(i + 1);
};

describe('Kyro fee addresses: Monero, Kaspa, Algorand, NEAR', () => {
  it('each configured address validates and is used by Exolix', () => {
    for (const [c, a] of Object.entries(ADDR)) {
      const chain = c as keyof typeof ADDR;
      expect(KYRO_SWAP_FEE.recipients[chain], c).toBe(a);
      expect(validFeeAddress(chain, a), c).toBe(true);
      expect(feeRecipientFor(chain), c).toBe(a);
      expect(exolixFeeRecipients()[chain], c).toBe(a);
    }
  });

  it('rejects a corrupted address (checksum)', () => {
    expect(validFeeAddress('monero', corrupt(ADDR.monero, 40, '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'))).toBe(false);
    expect(validFeeAddress('kaspa', corrupt(ADDR.kaspa, 20, 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'))).toBe(false);
    expect(validFeeAddress('algorand', corrupt(ADDR.algorand, 10, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'))).toBe(false);
    expect(validFeeAddress('near', ADDR.near.toUpperCase())).toBe(false);
    expect(validFeeAddress('near', 'kyro.near')).toBe(false);
    expect(validFeeAddress('monero', ADDR.monero.slice(0, 94))).toBe(false);
  });

  it('opens Exolix routes FROM these chains', () => {
    expect(EXOLIX_ARRIVAL_ONLY.size).toBe(0);
    for (const c of ['monero', 'kaspa', 'algorand', 'near'] as const) expect(exolixRoute(c, 'bitcoin'), c).toBe(true);
  });
});
