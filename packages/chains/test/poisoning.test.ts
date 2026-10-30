// Address-poisoning detection, every chain format: same first 4 / last 4 characters after the
// format's prefix but not identical → look-alike; case-insensitive for hex and bech32.
import { describe, expect, it } from 'vitest';
import { call, setBackend } from '@kyro/shared';
import { createMockBackend, DEMO_EVM_COLLEAGUE, DEMO_EVM_LOOKALIKE } from '@kyro/shared/mock';
import { createAdapters, addressParts, classifyHistoryAddresses, findLookalike, isDustOnlyAddress, isLookalike, lookalikeSegments, sameAddress, type Family, type KnownAddress } from '../src';

/** Same prefix + head + tail, middle replaced. */
const forge = (a: string, family: Family) => {
  const { prefix, head, middle, tail } = lookalikeSegments(a, family);
  const alphabet = family === 'evm' ? '0123456789abcdef' : family === 'btc' || family === 'ltc' || family === 'ada' ? 'qpzry9x8gf2tvdw0s3jn54khce6mua7l' : '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const swapped = [...middle].map((c, i) => alphabet[(alphabet.indexOf(c.toLowerCase() === c ? c : c) + 1 + i) % alphabet.length] ?? c).join('');
  return `${prefix}${head}${swapped}${tail}`;
};

const CASES: Array<[Family, string, string]> = [
  ['btc', 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh', 'bc1q'],
  ['btc', 'bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297', 'bc1p'],
  ['btc', 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', 'tb1q'],
  ['btc', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', '1'],
  ['ltc', 'ltc1qg82lsrt6zzvg9n4yx0yq36ed2w0cnhytjmerna', 'ltc1q'],
  ['ltc', 'tltc1qml5r3gyw2tqrdxx8s5dd46slz96t9dqmzdym03', 'tltc1q'],
  ['ltc', 'LaMT348PWRnrqeeWArpwQPbuanpXDZGEUz', 'L'],
  ['doge', 'DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L', 'D'],
  ['doge', 'niTrp9gKCW4wwBWPbgMMHWcQpKCfJgokjW', 'n'],
  ['evm', '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', '0x'],
  ['sol', 'EjT55gHT6dDK1q6WqbGj9rVqhfZeHsPHhJxBcDVQqxL1', ''],
  ['tron', 'TFz2CJn9CJb8C4i1Gke3jmZX2fRMJxniH2', 'T'],
  ['xrp', 'rNaqKtKrMSwpwZSzRckPf7S96DkimjkF4H', 'r'],
  ['ada', 'addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x', 'addr1q'],
  ['ada', 'addr_test1qrv42wjda8r6mpfj40d36znlgfdcqp7jtj03ah8skh6u8wnrqua2vw243tmjfjt0h5wsru6appuz8c0pfd75ur7myyeqnsc9fs', 'addr_test1q'],
];

describe('address poisoning: one look-alike per format', () => {
  for (const [family, real, prefix] of CASES) {
    it(`${family} ${prefix || '(sans préfixe)'}…`, () => {
      expect(addressParts(real, family).prefix.toLowerCase()).toBe(prefix.toLowerCase());
      const fake = forge(real, family);
      expect(fake).not.toBe(real);
      expect(fake.slice(0, prefix.length + 4)).toBe(real.slice(0, prefix.length + 4));
      expect(fake.slice(-4)).toBe(real.slice(-4));
      expect(isLookalike(real, fake, family)).toBe(true);
      expect(isLookalike(real, real, family)).toBe(false);
      // One differing character in the head or the tail: not the poisoning pattern.
      const tailChanged = fake.slice(0, -1) + (fake.endsWith('a') ? 'b' : 'a');
      expect(isLookalike(real, tailChanged, family)).toBe(false);
      const known: KnownAddress[] = [{ address: real, source: 'contact', label: 'Alice' }];
      expect(findLookalike(fake, known, family)?.known.label).toBe('Alice');
      expect(findLookalike(real, known, family)).toBeNull();
    });
  }

  it('hex and bech32 are case-insensitive; base58 is not', () => {
    const evm = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
    expect(sameAddress(evm, evm.toLowerCase(), 'evm')).toBe(true);
    expect(findLookalike(evm.toLowerCase(), [{ address: evm, source: 'own' }], 'evm')).toBeNull();
    expect(isLookalike(evm, '0x5AAEB' + '0'.repeat(31) + 'BEAED'.toLowerCase(), 'evm')).toBe(true);
    expect(sameAddress('BC1QXY2KGDYGJRSQTZQ2N0YRF2493P83KKFJHX0WLH', 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh', 'btc')).toBe(true);
    // Base58 (TRON, Solana, XRP, legacy): another case = another address, and not « the same head ».
    const tron = 'TFz2CJn9CJb8C4i1Gke3jmZX2fRMJxniH2';
    expect(isLookalike(tron, 'Tfz2' + tron.slice(5), 'tron')).toBe(false);
    // Different prefixes (mainnet vs testnet, SegWit vs Taproot) are not look-alikes.
    expect(isLookalike('bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh', 'bc1pxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh', 'btc')).toBe(false);
  });

  it('segments give prefix / head / middle / tail for highlighting', () => {
    expect(lookalikeSegments('0x5e1f9b3c8a2d47e6b0c19f4a7d23e8c6b5a2d4c7', 'evm')).toEqual({ prefix: '0x', head: '5e1f', middle: '9b3c8a2d47e6b0c19f4a7d23e8c6b5a2', tail: 'd4c7' });
    expect(lookalikeSegments('rNaqKtKrMSwpwZSzRckPf7S96DkimjkF4H', 'xrp')).toMatchObject({ prefix: 'r', head: 'NaqK', tail: 'kF4H' });
  });

  it('history: senders of incoming dust only are suspects, never trusted references', () => {
    const { trusted, dustOnly } = classifyHistoryAddresses(
      [
        { counterparty: DEMO_EVM_COLLEAGUE, direction: 'out', dust: false },
        { counterparty: DEMO_EVM_LOOKALIKE, direction: 'in', dust: true },
        { counterparty: '0x' + 'ab'.repeat(20), direction: 'in', dust: true },
        { counterparty: '0x' + 'AB'.repeat(20), direction: 'in', dust: false },
      ],
      'evm',
    );
    expect(trusted).toEqual([DEMO_EVM_COLLEAGUE, '0x' + 'ab'.repeat(20)]);
    expect(dustOnly).toEqual([DEMO_EVM_LOOKALIKE]);
    const known = trusted.map((address) => ({ address, source: 'history' as const }));
    // The demo scenario: pasting the planted look-alike warns, the real colleague does not.
    expect(findLookalike(DEMO_EVM_LOOKALIKE, known, 'evm')?.known.address).toBe(DEMO_EVM_COLLEAGUE);
    expect(findLookalike(DEMO_EVM_COLLEAGUE, known, 'evm')).toBeNull();
    expect(isDustOnlyAddress(DEMO_EVM_LOOKALIKE.toUpperCase().replace('0X', '0x'), dustOnly, 'evm')).toBe(true);
  });

  it('priority: an address-book entry wins over history', () => {
    const real = 'TFz2CJn9CJb8C4i1Gke3jmZX2fRMJxniH2';
    const fake = forge(real, 'tron');
    const known: KnownAddress[] = [
      { address: real, source: 'history' },
      { address: real, source: 'contact', label: 'Bob' },
    ];
    expect(findLookalike(fake, known, 'tron')?.known.source).toBe('contact');
  });

  it('demo scenario: the Sepolia history really contains the planted look-alike', async () => {
    setBackend(createMockBackend({ network: 'testnet', torEnabled: false, preset: { password: 'correct horse', unlocked: true } }).invoke);
    const sepolia = createAdapters(await call('accounts_get')).evm.get('sepolia')!;
    const h = await sepolia.getHistory();
    const poison = h.find((x) => x.counterparty?.toLowerCase() === DEMO_EVM_LOOKALIKE);
    expect(poison).toMatchObject({ direction: 'in', amount: 0n });
    expect(h.find((x) => x.counterparty?.toLowerCase() === DEMO_EVM_COLLEAGUE)).toMatchObject({ direction: 'out', amount: 25_000_000n });
    const { trusted, dustOnly } = classifyHistoryAddresses(
      h.map((x) => ({ counterparty: x.counterparty!, direction: x.direction, dust: x.direction === 'in' && x.amount === 0n })),
      'evm',
    );
    expect(findLookalike(DEMO_EVM_LOOKALIKE, trusted.map((address) => ({ address, source: 'history' as const })), 'evm')).not.toBeNull();
    expect(isDustOnlyAddress(DEMO_EVM_LOOKALIKE, dustOnly, 'evm')).toBe(true);
  });
});
