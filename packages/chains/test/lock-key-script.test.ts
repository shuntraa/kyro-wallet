// scripts/btc-lock-key.mjs must refuse what the wallet refuses: a typo must never give a key to an
// empty wallet. The regtest proof also runs phrases like these through Kyro's `Mnemonic::parse`.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../scripts/btc-lock-key.mjs');
const GOOD = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const T = 1_804_982_400;
const dir = mkdtempSync(join(tmpdir(), 'kyro-lock-key-'));
let n = 0;

function run(input: string, args: string[] = []) {
  const out = join(dir, `import-${n++}.json`);
  const r = spawnSync(process.execPath, [SCRIPT, '--network', 'mainnet', '--t', String(T), '--out', out, ...args], { input, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, out };
}

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('the phrase', () => {
  it('gives the frozen lock of Kyro, and only a public descriptor on screen', () => {
    const r = run(`${GOOD}\n\n`);
    expect(r.status).toBe(0);
    // crates/wallet-core/src/btc_lock.rs, frozen_vectors_never_change.
    expect(r.stdout).toContain("m/84'/0'/0'/2/20891");
    expect(r.stdout).toContain('02b0c411138f37419cab5225f3f4735a9127e648b683c12846fc4d0de2d5002594');
    expect(r.stdout).not.toMatch(/xprv|tprv/);
    const [request] = JSON.parse(readFileSync(r.out, 'utf8'));
    const wif = /v:pk\((\w+)\)/.exec(request.desc)?.[1] ?? '';
    expect(wif).toMatch(/^[KL]/);
    expect(r.stdout).not.toContain(wif);
    expect(request.desc).toMatch(/#[a-z0-9]{8}$/);
  });

  it('normalises like Mnemonic::parse', () => {
    const plain = run(`${GOOD}\n`);
    const messy = run(`  ${GOOD.toUpperCase().split(' ').join('   ')}\t\n`);
    expect(messy.status).toBe(0);
    expect(messy.stdout.split('\n')[1]).toBe(plain.stdout.split('\n')[1]);
  });

  it('refuses a typo, a wrong checksum and a wrong length, and writes nothing', () => {
    const words = GOOD.split(' ');
    const typo = [...words.slice(0, 11), 'abaut'].join(' ');
    const checksum = [...words.slice(0, 11), 'abandon'].join(' ');
    const swapped = [words[11], ...words.slice(0, 11)].join(' ');
    for (const phrase of [typo, checksum, swapped, words.slice(0, 11).join(' '), [...words, 'about'].join(' '), '']) {
      const r = run(`${phrase}\n`);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('invalid recovery phrase');
      expect(r.stderr).not.toContain('abaut');
      expect(existsSync(r.out)).toBe(false);
    }
  });

  it('agrees with BIP39 on every word count', () => {
    const lengths: Record<number, string> = {
      12: GOOD,
      15: `${'abandon '.repeat(14)}address`,
      18: `${'abandon '.repeat(17)}agent`,
      21: `${'abandon '.repeat(20)}admit`,
      24: `${'abandon '.repeat(23)}art`,
    };
    for (const phrase of Object.values(lengths)) {
      expect(run(`${phrase}\n`).status).toBe(0);
    }
  });

  it('the passphrase changes the key, and is not read from the environment', () => {
    const none = run(`${GOOD}\n\n`);
    const pass = run(`${GOOD}\nTREZOR\n`);
    expect(pass.stdout.split('\n')[1]).not.toBe(none.stdout.split('\n')[1]);
    const out = join(dir, 'env.json');
    const r = spawnSync(process.execPath, [SCRIPT, '--network', 'mainnet', '--t', String(T), '--out', out], { input: `${GOOD}\n`, encoding: 'utf8', env: { ...process.env, KYRO_BIP39_PASSPHRASE: 'TREZOR' } });
    expect(r.stdout.split('\n')[1]).toBe(none.stdout.split('\n')[1]);
  });

  it('refuses a date that is no lock, and never writes over a file', () => {
    expect(spawnSync(process.execPath, [SCRIPT, '--network', 'mainnet', '--t', String(T + 1), '--out', join(dir, 'x.json')], { input: GOOD, encoding: 'utf8' }).status).toBe(1);
    expect(spawnSync(process.execPath, [SCRIPT, '--network', 'mainnet', '--t', '2147558400', '--out', join(dir, 'x.json')], { input: GOOD, encoding: 'utf8' }).status).toBe(1);
    const first = run(`${GOOD}\n`);
    const again = spawnSync(process.execPath, [SCRIPT, '--network', 'mainnet', '--t', String(T), '--out', first.out], { input: GOOD, encoding: 'utf8' });
    expect(again.status).not.toBe(0);
  });
});
