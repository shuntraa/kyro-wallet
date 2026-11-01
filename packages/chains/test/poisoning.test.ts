// Address-poisoning detection, every chain format: same first 4 / last 4 characters after the
// format's prefix but not identical → look-alike; case-insensitive for hex and bech32.
import { describe, expect, it } from 'vitest';
import { call, setBackend } from '@kyro/shared';
import { createMockBackend, DEMO_EVM_COLLEAGUE, DEMO_EVM_LOOKALIKE } from '@kyro/shared/mock';
import { createAdapters, addressParts, classifyHistoryAddresses, findLookalike, isDustAmount, isLookalike, isSuspectAddress, lookalikeSegments, sameAddress, solHistoryItem, type Family, type KnownAddress } from '../src';

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
    it(`${family} ${prefix || '(no prefix)'}…`, () => {
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

  it('history: suspect counterparties (zero, dust, not signed) are never references', () => {
    const { trusted, references, suspects } = classifyHistoryAddresses(
      [
        { counterparty: DEMO_EVM_COLLEAGUE, suspect: false },
        { counterparty: DEMO_EVM_LOOKALIKE, suspect: true },
        { counterparty: '0x' + 'ab'.repeat(20), suspect: true },
        { counterparty: '0x' + 'AB'.repeat(20), suspect: false },
      ],
      [],
      'evm',
    );
    expect(trusted).toEqual([]);
    expect(references).toEqual([DEMO_EVM_COLLEAGUE, '0x' + 'ab'.repeat(20)]);
    expect(suspects).toEqual([DEMO_EVM_LOOKALIKE]);
    const known = references.map((address) => ({ address, source: 'history' as const }));
    // The demo scenario: pasting the planted look-alike warns, the real colleague does not.
    expect(findLookalike(DEMO_EVM_LOOKALIKE, known, 'evm')?.known.address).toBe(DEMO_EVM_COLLEAGUE);
    expect(findLookalike(DEMO_EVM_COLLEAGUE, known, 'evm')).toBeNull();
    expect(isSuspectAddress(DEMO_EVM_LOOKALIKE.toUpperCase().replace('0X', '0x'), suspects, 'evm')).toBe(true);
  });

  it('only sends signed by this device are trusted; they win over the server history', () => {
    const { trusted, references, suspects } = classifyHistoryAddresses([{ counterparty: DEMO_EVM_COLLEAGUE, suspect: true }], [DEMO_EVM_COLLEAGUE.toUpperCase().replace('0X', '0x')], 'evm');
    expect(trusted).toHaveLength(1);
    expect(references).toEqual([]);
    expect(suspects).toEqual([]);
  });

  it('an exact match with a reference does not end the check (no short-circuit)', () => {
    const real = DEMO_EVM_COLLEAGUE;
    // The look-alike made it into the list (seen in the history, paid once, even saved as a contact).
    for (const source of ['history', 'sent', 'contact'] as const) {
      const known: KnownAddress[] = [
        { address: DEMO_EVM_LOOKALIKE, source, label: 'Collègue ?' },
        { address: real, source: 'contact', label: 'Collègue' },
      ];
      const hit = findLookalike(DEMO_EVM_LOOKALIKE, known, 'evm');
      expect(hit?.known.address).toBe(real);
      expect(hit?.recipientKnown?.address).toBe(DEMO_EVM_LOOKALIKE);
      // Two listed addresses that look alike: sending to the real one warns as well.
      expect(findLookalike(real, known, 'evm')?.known.address).toBe(DEMO_EVM_LOOKALIKE);
    }
    // A single exact reference with nothing alike: no warning.
    expect(findLookalike(real, [{ address: real, source: 'history' }], 'evm')).toBeNull();
  });

  it('vector 1 — EVM transferFrom(you, look-alike, 0): never a trusted « send », flagged suspect', async () => {
    const backend = createMockBackend({ network: 'testnet', torEnabled: false, preset: { password: 'correct horse', unlocked: true } });
    setBackend(backend.invoke);
    const sepolia = createAdapters(await call('accounts_get')).evm.get('sepolia')!;
    const me = sepolia.getAddress().toLowerCase();
    // Non-zero variant: a log « from you » in a transaction someone else sent.
    backend.chain.evmLogs.push({ chainId: 11155111, token: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', from: me, to: DEMO_EVM_LOOKALIKE, value: 5n, blocksAgo: 380, txHash: '0x' + 'ee'.repeat(32), sender: DEMO_EVM_LOOKALIKE });
    const h = await sepolia.getHistory();
    const lures = h.filter((x) => x.counterparty?.toLowerCase() === DEMO_EVM_LOOKALIKE);
    expect(lures.map((x) => [x.direction, x.suspect])).toEqual(expect.arrayContaining([['out', 'zero'], ['out', 'notSigned'], ['in', 'zero']]));
    expect(lures.every((x) => x.suspect)).toBe(true);
    // The real payment to the colleague, sent by us, is not suspect.
    const paid = h.find((x) => x.counterparty?.toLowerCase() === DEMO_EVM_COLLEAGUE);
    expect(paid).toMatchObject({ direction: 'out', amount: 25_000_000n });
    expect(paid?.suspect).toBeUndefined();
    const { references, suspects } = classifyHistoryAddresses(h.map((x) => ({ counterparty: x.counterparty!, suspect: !!x.suspect })), [], 'evm');
    const known = references.map((address) => ({ address, source: 'history' as const }));
    expect(findLookalike(DEMO_EVM_LOOKALIKE, known, 'evm')?.known.address.toLowerCase()).toBe(DEMO_EVM_COLLEAGUE);
    expect(isSuspectAddress(DEMO_EVM_LOOKALIKE, suspects, 'evm')).toBe(true);
  });

  it('vector 2 — Solana 0-lamport transfer: neither received nor sent, counterparty from the instructions', () => {
    const me = 'EjT55gHT6dDK1q6WqbGj9rVqhfZeHsPHhJxBcDVQqxL1';
    const fake = forge(me, 'sol');
    const lure = solHistoryItem({ me, isPayer: false, delta: 0n, fee: 5000n, instructions: [{ program: 'system', parsed: { type: 'transfer', info: { source: fake, destination: me, lamports: 0 } } }] });
    expect(lure).toMatchObject({ direction: 'in', amount: 0n, suspect: 'zero', counterparty: fake });
    // Before the fix: « out », counterparty = the fee payer. Without a decoded transfer: no counterparty at all.
    expect(solHistoryItem({ me, isPayer: false, delta: 0n, fee: 5000n, instructions: [] }).counterparty).toBeUndefined();
    // A real receipt and a real send keep their direction and counterparty.
    expect(solHistoryItem({ me, isPayer: false, delta: 2_000_000n, fee: 5000n, instructions: [{ program: 'system', parsed: { type: 'transfer', info: { source: fake, destination: me } } }] })).toMatchObject({ direction: 'in', amount: 2_000_000n, counterparty: fake });
    const sent = solHistoryItem({ me, isPayer: true, delta: -1_005_000n, fee: 5000n, instructions: [{ programId: '11111111111111111111111111111111', parsed: { type: 'transfer', info: { source: me, destination: fake } } }] });
    expect(sent).toMatchObject({ direction: 'out', amount: 1_000_000n, counterparty: fake, fee: 5000n });
    expect(sent.suspect).toBeUndefined();
  });

  it('vector 3 — UTXO dust: under 1 (fiat) or 10 × the dust limit is suspect, a payment is not', () => {
    // ~0,5 $ of BTC: real dust, used to plant look-alikes (the old threshold was 0,01).
    expect(isDustAmount('btc', 800n, 0.5)).toBe(true);
    expect(isDustAmount('btc', 5_460n, null)).toBe(true);
    expect(isDustAmount('btc', 100_000n, 60)).toBe(false);
    expect(isDustAmount('ltc', 2_000n, null)).toBe(true);
    expect(isDustAmount('doge', 9_000_000n, null)).toBe(true);
    expect(isDustAmount('doge', 500_000_000n, 0.9)).toBe(true);
    expect(isDustAmount('evm', 0n, null)).toBe(true);
    expect(isDustAmount('evm', 1n, null)).toBe(false);
    expect(isDustAmount('sol', 10_000_000n, 1.5)).toBe(false);
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
    const poison = h.filter((x) => x.counterparty?.toLowerCase() === DEMO_EVM_LOOKALIKE);
    expect(poison).toEqual(expect.arrayContaining([expect.objectContaining({ direction: 'in', amount: 0n, suspect: 'zero' }), expect.objectContaining({ direction: 'out', amount: 0n, suspect: 'zero' })]));
    expect(h.find((x) => x.counterparty?.toLowerCase() === DEMO_EVM_COLLEAGUE)).toMatchObject({ direction: 'out', amount: 25_000_000n });
    const { references, suspects } = classifyHistoryAddresses(
      h.map((x) => ({ counterparty: x.counterparty!, suspect: !!x.suspect })),
      [],
      'evm',
    );
    expect(findLookalike(DEMO_EVM_LOOKALIKE, references.map((address) => ({ address, source: 'history' as const })), 'evm')).not.toBeNull();
    expect(isSuspectAddress(DEMO_EVM_LOOKALIKE, suspects, 'evm')).toBe(true);
  });
});
