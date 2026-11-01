// Cardano end to end against the demo backend: typed ada_* commands, accounts_get, the builder's
// rules (min-UTxO, fee a·size + b, coin selection, change keeping every token), refused address
// types with Rust's French messages, CIP-20 memo, live re-checks before signing, servers.
import { beforeEach, describe, expect, it } from 'vitest';
import { call, IpcError, setBackend, type Accounts } from '@kyro/shared';
import { cardanoAddressOf, createMockBackend, type MockBackend } from '@kyro/shared/mock';
import { cardanoAddressProblem, createAdapters, findAsset, outgoingHosts, WATCH_ONLY_CHAINS } from '../src';

const PASSWORD = 'correct horse battery';
let accounts: Accounts;
let mock: MockBackend;
let dialogs: string[];
const ADA = findAsset('testnet', 'ada')!;
const kyro = () => ({ policy: mock.cardano.policies.kyro, name: Array.from(new TextEncoder().encode('KyroTest'), (b) => b.toString(16).padStart(2, '0')).join('') });

async function err(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await p;
  } catch (e) {
    return e instanceof IpcError ? { code: e.code, message: e.message } : { code: 'JS', message: (e as Error).message };
  }
  throw new Error('expected rejection');
}

/** A testnet address with this header (type nibble << 4 | network 0) and fake hashes. */
const addrOfHeader = (header: number, len = 57, hrp = 'addr_test') => cardanoAddressOf(new Uint8Array([header, ...Array.from({ length: len - 1 }, (_, i) => (i * 7 + header) & 0xff)]), hrp);

beforeEach(async () => {
  dialogs = [];
  mock = createMockBackend({ network: 'testnet', torEnabled: false, confirm: (t) => (dialogs.push(t), true), preset: { password: PASSWORD, unlocked: true } });
  setBackend(mock.invoke);
  accounts = await call('accounts_get');
});

describe('Cardano in the app', () => {
  it('is a full chain: nothing left « Bientôt », ADA asset, Koios in the outgoing list', () => {
    expect(WATCH_ONLY_CHAINS).toHaveLength(0);
    expect(ADA).toMatchObject({ family: 'ada', kind: 'native', symbol: 'ADA', decimals: 6, chainKey: 'cardano' });
    expect(outgoingHosts('testnet').map((h) => h.host)).toContain('preprod.koios.rest');
    expect(outgoingHosts('mainnet').map((h) => h.host)).toContain('api.koios.rest');
    const custom = outgoingHosts('testnet', { bitcoin: {}, evm: {}, solana: {}, litecoin: {}, bitcoincash: {}, dash: {}, dogecoin: {}, tron: {}, xrp: {}, cardano: { testnet: { kind: 'koios', url: 'https://my-koios.example/api/v1' } } });
    expect(custom.find((h) => h.host === 'my-koios.example')).toMatchObject({ custom: true });
  });

  it('single address (index 0), balance, tokens and the ADA they tie up', async () => {
    const info = await call('ada_address', { index: 0 });
    expect(info).toMatchObject({ address: accounts.cardano.address, path: "m/1852'/1815'/0'/0/0" });
    expect(info.stakeAddress.startsWith('stake_test1')).toBe(true);
    const ada = createAdapters(accounts).cardano!;
    expect(await ada.getBalance()).toEqual([{ assetId: 'ada', amount: 1_254_400_000n }]);
    const b = await ada.balances();
    expect(b.tokens.map((t) => [t.nameText, t.quantity, t.verified])).toEqual(
      expect.arrayContaining([
        ['KyroTest', '5000', false],
        ['tHOSKY', '1000000', false],
      ]),
    );
    // Two token-carrying UTxOs: each ties up its min-UTxO.
    expect(b.ada.spendable).toBe(b.ada.amount - BigInt((await ada.account()).lockedWithTokens));
    expect(b.ada.spendable < b.ada.amount).toBe(true);
  });

  it('hardware-wallet accounts have no Cardano adapter (HW_UNSUPPORTED)', () => {
    const { cardano: _c, xrp: _x, tron: _t, ltc: _l, doge: _d, ...hw } = accounts;
    const ad = createAdapters(hw, undefined, undefined, { accountId: 'hw-1', device: 'trezor' });
    expect(ad.cardano).toBeNull();
  });

  it('ADA payment: min-UTxO, fee = a·size + b, change back to our address', async () => {
    const ada = createAdapters(accounts).cardano!;
    const low = await err(ada.buildTx({ asset: ADA, to: mock.cardano.friend, amount: 500_000n, fee: { family: 'ada' } }));
    expect(low.message).toBe('Entrée invalide : montant trop faible : cette sortie doit porter au moins 0,96975 ADA (min-UTxO)');
    const u = await ada.buildTx({ asset: ADA, to: mock.cardano.friend, amount: 10_000_000n, fee: { family: 'ada' } });
    const [dest, change] = u.summary.outputs;
    expect(dest).toMatchObject({ address: mock.cardano.friend, isChange: false, lovelace: '10000000', tokens: [], minLovelace: '969750' });
    expect(change).toMatchObject({ address: accounts.cardano.address, isChange: true, tokens: [] });
    const fee = BigInt(u.summary.fee);
    expect(fee > 155_381n && fee < 200_000n).toBe(true);
    expect((fee - 155_381n) % 44n).toBe(0n);
    expect(BigInt(u.context.leaving)).toBe(10_000_000n + fee);
    expect(u.summary.requiresExtraConfirmation).toBe(false);
    const s = await ada.signTx(u, PASSWORD);
    expect(dialogs[0]).toContain('Sortie 1 — DESTINATAIRE');
    expect(dialogs[0]).toContain('Sortie 2 — monnaie rendue (ton adresse)');
    expect(dialogs[0]).toContain(`Total qui quitte le portefeuille : ${(Number(10_000_000n + fee) / 1e6).toString().replace('.', ',')} ADA`);
    const id = await ada.broadcast(s);
    expect(await ada.txStatus(id)).toEqual({ confirmations: null });
    mock.advance(11_000);
    expect((await ada.txStatus(id)).confirmations).toBe(2);
  });

  it('token payment: its output carries exactly the min-ADA, every other token stays in the change', async () => {
    const ada = createAdapters(accounts).cardano!;
    const t = kyro();
    const u = await ada.buildTx({ asset: ADA, to: mock.cardano.friend, amount: 0n, fee: { family: 'ada' }, cardanoToken: { ...t, quantity: '100' } });
    const [dest, change] = u.summary.outputs;
    expect(dest?.lovelace).toBe(dest?.minLovelace);
    expect(BigInt(dest!.minLovelace) > 969_750n).toBe(true);
    expect(dest?.tokens).toEqual([{ policy: t.policy, name: t.name, nameText: 'KyroTest', quantity: '100', verified: false }]);
    expect(change?.tokens.find((k) => k.nameText === 'KyroTest')?.quantity).toBe('4900');
    expect(u.summary.warnings).toContainEqual({ kind: 'unknownToken', policy: t.policy, name: t.name });
    await ada.signTx(u, PASSWORD);
    expect(dialogs[0]).toContain('minimum obligatoire avec les tokens');
    expect(dialogs[0]).toContain('⚠ NON VÉRIFIÉ');
    expect(dialogs[1]).toMatch(/Signer quand même/);
    expect((await err(ada.buildTx({ asset: ADA, to: mock.cardano.friend, amount: 0n, fee: { family: 'ada' }, cardanoToken: { ...t, quantity: '6000' } }))).message).toBe('Entrée invalide : token insuffisant : 5000 disponible(s), 6000 demandé(s)');
  });

  it('CIP-20 memo: public, in the summary and the dialog, reinforced confirmation', async () => {
    const ada = createAdapters(accounts).cardano!;
    const u = await ada.buildTx({ asset: ADA, to: mock.cardano.friend, amount: 2_000_000n, fee: { family: 'ada' }, memo: 'Facture 42' });
    expect(u.summary.memo).toEqual(['Facture 42']);
    expect(u.summary.warnings).toContainEqual({ kind: 'memo' });
    await ada.signTx(u, PASSWORD);
    expect(dialogs[0]).toContain('Message (CIP-20, public à jamais) : Facture 42');
    expect((await err(ada.buildTx({ asset: ADA, to: mock.cardano.friend, amount: 2_000_000n, fee: { family: 'ada' }, memo: 'x'.repeat(1025) }))).message).toBe('Message trop long (1 024 octets max.)');
  });

  it('refused recipients, with Rust’s messages (and the same ones before calling Rust)', async () => {
    const cases: Array<[string, string]> = [
      ['Ae2tdPwUPEZCanmBz5g2GEwFqKTKpNJcGYPKfDxoNeKZ8bRHr8366kseiK2', 'les adresses Byron ne sont pas prises en charge : demande au destinataire une adresse Shelley (addr1…)'],
      [addrOfHeader(0x10), 'adresses de script refusées : un paiement sans datum pourrait bloquer les fonds'],
      [addrOfHeader(0x70, 29), 'adresses de script refusées : un paiement sans datum pourrait bloquer les fonds'],
      [addrOfHeader(0x40, 34), 'adresses pointeur obsolètes (Conway) : refusées'],
      [addrOfHeader(0xe0, 29, 'stake_test'), 'une adresse de staking (stake…) ne peut pas recevoir de paiement'],
      [addrOfHeader(0x01, 57, 'addr'), "adresse Cardano d'un autre réseau, ou pas une adresse de paiement"],
    ];
    for (const [to, msg] of cases) {
      expect(cardanoAddressProblem(to, 'testnet')).toBe(msg);
      expect((await err(call('ada_build_tx', { to, lovelace: '2000000' }))).message).toBe(`Entrée invalide : ${msg}`);
    }
    // Enterprise addresses are accepted.
    const enterprise = addrOfHeader(0x60, 29);
    expect(cardanoAddressProblem(enterprise, 'testnet')).toBeNull();
    const u = await createAdapters(accounts).cardano!.buildTx({ asset: ADA, to: enterprise, amount: 2_000_000n, fee: { family: 'ada' } });
    expect(u.summary.outputs[0]?.kind).toBe('enterprise');
  });

  it('balance rules: not enough ADA; spent inputs refused at signing (live re-check); MAX keeps the change', async () => {
    const ada = createAdapters(accounts).cardano!;
    expect((await err(ada.buildTx({ asset: ADA, to: mock.cardano.friend, amount: 2_000_000_000n, fee: { family: 'ada' } }))).message).toMatch(/^Entrée invalide : solde insuffisant : .* ADA en entrée, il faut .* ADA \(montant \+ frais\)$/);
    const first = await ada.buildTx({ asset: ADA, to: mock.cardano.friend, amount: 5_000_000n, fee: { family: 'ada' } });
    const second = await ada.buildTx({ asset: ADA, to: mock.cardano.friend, amount: 6_000_000n, fee: { family: 'ada' } });
    await ada.broadcast(await ada.signTx(second, PASSWORD));
    expect((await err(ada.signTx(first, PASSWORD))).message).toMatch(/inconnue ou déjà dépensée : reconstruis la transaction/);
    const max = await ada.buildTx({ asset: ADA, to: mock.cardano.friend, amount: 0n, fee: { family: 'ada' }, max: true });
    const change = max.summary.outputs.find((o) => o.isChange)!;
    expect(BigInt(change.lovelace) >= BigInt(change.minLovelace)).toBe(true);
    expect(change.tokens.length).toBe(2);
  });

  it('history: ADA delta, tokens and the message in the note', async () => {
    const h = await createAdapters(accounts).cardano!.getHistory();
    expect(h[0]).toMatchObject({ assetId: 'ada', direction: 'in', amount: 1_400_000n, chainKey: 'cardano' });
    expect(h[0]?.note).toBe('+1000000 tHOSKY · « airdrop de test »');
  });

  it('servers: Koios default, wrong network refused, custom Koios saved', async () => {
    expect((await call('server_test', { target: { family: 'cardano', network: 'testnet', server: { kind: 'default' } } })).detected).toMatchObject({ network: 'preprod', chainId: 1 });
    expect((await err(call('server_test', { target: { family: 'cardano', network: 'testnet', server: { kind: 'koios', url: 'https://wrong-koios.example/api/v1' } } }))).code).toBe('SERVER_WRONG_NETWORK');
    const st = await call('settings_get');
    const { apiKeysSet: _s, ...rest } = st;
    await call('settings_set', { settings: { ...rest, servers: { ...st.servers, cardano: { testnet: { kind: 'koios', url: 'https://my-koios.example/api/v1' } } } } });
    expect(await call('ada_backend_info')).toMatchObject({ kind: 'koios', label: 'my-koios.example' });
  });
});
