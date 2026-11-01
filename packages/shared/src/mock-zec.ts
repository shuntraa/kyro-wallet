// SPDX-License-Identifier: GPL-3.0-or-later
// DEMO ONLY — Zcash, transparent addresses only (`zec_*`, docs/IPC.md §2.4b), mirroring

import { HDKey } from '@scure/bip32';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';
import { IpcError, type Network, type UtxoAccountInfo, type ZecSendArgs, type ZecTxSummary } from './ipc';
import { zecDestinationKind, zecP2pkhAddress, zecShieldedRefusal } from './zcash';
import type { DemoTor } from './mock-tor';
import { intlLocale, l10n } from './i18n';
import type { DemoAccountHooks } from './mock-accounts';

const TESTNET_VERSIONS = { private: 0x04358394, public: 0x043587cf };
/** First default Zcash mainnet server (Rust: `net::ELECTRUM_HOSTS`, family `zcash`). */
export const ZEC_DEFAULT_ELECTRUM = 'zec.electrum1.cipig.net';
/** Branch id the demo chain is on (NU6.3, as mainnet on 2026-11-01). */
const DEMO_BRANCH = { upgrade: 'NU6.3', id: '0x37a5165b' };

export function demoZecPath(network: Network, account: number): string {
  return `m/44'/${network === 'testnet' ? 1 : 133}'/${account}'`;
}

/** Account node `m/44'/133'/a'` (testnet coin type 1), standard xpub/tpub encoding like Rust. */
export function demoZecAccount(seed: Uint8Array, network: Network, account = 0): { info: UtxoAccountInfo; node: HDKey } {
  const master = HDKey.fromMasterSeed(seed, network === 'testnet' ? TESTNET_VERSIONS : undefined);
  const path = demoZecPath(network, account);
  const node = master.derive(path);
  const fingerprint = master.fingerprint.toString(16).padStart(8, '0');
  return { info: { address: demoZecAddress(node, network, 0, 0), xpub: node.publicExtendedKey, fingerprint, path }, node };
}

export function demoZecAddress(node: HDKey, network: Network, change: number, index: number): string {
  const pk = node.deriveChild(change).deriveChild(index).publicKey;
  if (!pk) throw new IpcError('INTERNAL', l10n('dérivation', 'derivation'));
  return zecP2pkhAddress(pk, network);
}

interface Coin {
  txid: string;
  vout: number;
  value: number;
  height: number;
  /** Who paid us (history counterparty). */
  from: string;
}

export interface DemoZecDeps {
  network: Network;
  seed: Uint8Array;
  accounts: DemoAccountHooks;
  tor: DemoTor;
  torOn: () => boolean;
  requireUnlocked: () => void;
  checkPassword: (password: unknown) => void;
  confirm: (text: string) => boolean;
}

const fakeTxid = (tag: string) => bytesToHex(sha256(new TextEncoder().encode(`kyro-demo-zec-${tag}`)));

const zip317 = (inputs: number, outputs: number) => 5_000 * Math.max(2, Math.ceil((inputs * 150) / 150), Math.ceil((outputs * 34) / 34));

const fmt = (z: number) => (z / 1e8).toLocaleString(intlLocale(), { maximumFractionDigits: 8 });

export function createDemoZec(d: DemoZecDeps) {
  const mainnet = d.network === 'mainnet';
  const tip = { height: 3_537_784 };
  const nodes = new Map<number, HDKey>();
  const nodeOf = (a: number) => {
    let n = nodes.get(a);
    if (!n) {
      n = demoZecAccount(d.seed, d.network, a).node;
      nodes.set(a, n);
    }
    return n;
  };
  // Demo coins: two on account 0's first receive address.
  const utxos = new Map<string, Coin[]>();
  const sent: Array<{ txid: string; from: string[]; to: string; amount: number; change: { address: string; value: number } | null; fee: number; height: number }> = [];
  const me = demoZecAddress(nodeOf(0), d.network, 0, 0);
  utxos.set(me, [
    { txid: fakeTxid('a'), vout: 0, value: 184_250_000, height: tip.height - 2_400, from: 't1bp8X7reRWwrYvvqVcAHUqVp8iS9TP5yGU' },
    { txid: fakeTxid('b'), vout: 1, value: 12_500_000, height: tip.height - 96, from: 't1WWJ7Mv4R5mk4hbmzh7nBGjfhF38N6fcFp' },
  ]);

  const gate = async () => {
    if (!mainnet) throw new IpcError('SERVER_INVALID', l10n('Serveur invalide : Zcash testnet : Kyro n’a pas de serveur public par défaut (aucun serveur Electrum Zcash testnet public et maintenu n’a été trouvé). Zcash fonctionne sur mainnet.', 'Invalid server: Zcash testnet: Kyro has no default public server (no public, maintained Zcash testnet Electrum server was found). Zcash works on mainnet.'));
    if (d.torOn()) await d.tor.waitReady();
    await new Promise((r) => setTimeout(r, 60 + Math.random() * 140));
  };
  const checkAddress = (a: unknown): string => {
    const addr = String(a ?? '').trim();
    if (zecDestinationKind(addr, d.network) === 'tex' || !zecDestinationKind(addr, d.network)) throw new IpcError('INVALID_INPUT', l10n('Entrée invalide : adresse Zcash invalide', 'Invalid input: invalid Zcash address'));
    return addr;
  };
  const stats = (n: number, sum: number) => ({ funded_txo_count: n, funded_txo_sum: sum, spent_txo_count: 0, spent_txo_sum: 0, tx_count: n });

  const build = (args: Record<string, unknown>): { summary: ZecTxSummary; spend: Array<{ owner: string; coin: Coin }>; account: number } => {
    d.requireUnlocked();
    const account = d.accounts.arg(args.account);
    const req = args.request as ZecSendArgs | undefined;
    if (!req || typeof req.to !== 'string' || !Array.isArray(req.coins)) throw new IpcError('INVALID_INPUT', l10n('Entrée invalide : requête Zcash', 'Invalid input: Zcash request'));
    const refusal = zecShieldedRefusal(req.to);
    if (refusal) throw new IpcError('INVALID_INPUT', l10n(`Entrée invalide : ${refusal}`, `Invalid input: ${refusal}`));
    const kind = zecDestinationKind(req.to, d.network);
    if (!kind) throw new IpcError('INVALID_INPUT', l10n('Entrée invalide : adresse Zcash invalide', 'Invalid input: invalid Zcash address'));
    const node = nodeOf(account);
    const candidates: Array<{ owner: string; coin: Coin }> = [];
    for (const c of req.coins) {
      const owner = demoZecAddress(node, d.network, c.change ? 1 : 0, c.index);
      const coin = (utxos.get(owner) ?? []).find((u) => u.txid === c.txid && u.vout === c.vout);
      if (!coin) throw new IpcError('INVALID_INPUT', l10n(`Entrée invalide : pièce ${c.txid}:${c.vout} : la sortie ne paie pas l’adresse ${c.change ? 1 : 0}/${c.index} de ce compte`, `Invalid input: coin ${c.txid}:${c.vout}: the output does not pay address ${c.change ? 1 : 0}/${c.index} of this account`));
      candidates.push({ owner, coin });
    }
    candidates.sort((a, b) => b.coin.value - a.coin.value);
    const amount = req.max ? 0 : Number(req.amount);
    if (!req.max && (!Number.isSafeInteger(amount) || amount < 54)) throw new IpcError('INVALID_INPUT', l10n('Entrée invalide : montant sous la limite de poussière du réseau (54 zatoshis)', 'Invalid input: amount below the network dust limit (54 zatoshis)'));
    let total = 0;
    const spend: Array<{ owner: string; coin: Coin }> = [];
    let result: { amount: number; change: number; fee: number; folded: number; conv: number } | null = null;
    for (const c of candidates) {
      spend.push(c);
      total += c.coin.value;
      if (req.max) continue;
      const fee2 = zip317(spend.length, 2);
      if (total - amount - fee2 >= 5_000) {
        result = { amount, change: total - amount - fee2, fee: fee2, folded: 0, conv: fee2 };
        break;
      }
      const fee1 = zip317(spend.length, 1);
      if (total - amount - fee1 >= 0) {
        result = { amount, change: 0, fee: total - amount, folded: total - amount - fee1, conv: fee1 };
        break;
      }
    }
    if (req.max) {
      const fee1 = zip317(spend.length, 1);
      if (total - fee1 < 54) throw new IpcError('INVALID_INPUT', l10n('Entrée invalide : solde trop faible pour couvrir les frais du réseau', 'Invalid input: balance too low to cover the network fee'));
      result = { amount: total - fee1, change: 0, fee: fee1, folded: 0, conv: fee1 };
    }
    if (!result) throw new IpcError('INVALID_INPUT', l10n(`Entrée invalide : solde insuffisant : ${total} zatoshis dans ${spend.length} pièce(s), il en faut plus pour le montant et les frais`, `Invalid input: insufficient balance: ${total} zatoshis in ${spend.length} coin(s), more is needed for the amount and the fee`));
    const changeAddress = demoZecAddress(node, d.network, 1, req.changeIndex);
    const highFee = result.fee > result.conv * 10 || result.fee > result.amount;
    const summary: ZecTxSummary = {
      to: req.to.trim(),
      toKind: kind,
      toAddress: req.to.trim(),
      amount: String(result.amount),
      change: result.change > 0 ? { address: changeAddress, amount: String(result.change), index: req.changeIndex } : null,
      fee: String(result.fee),
      zip317Fee: String(result.conv),
      folded: String(result.folded),
      inputs: spend.length,
      inputTotal: String(total),
      upgrade: DEMO_BRANCH.upgrade,
      branchId: DEMO_BRANCH.id,
      targetHeight: tip.height + 1,
      expiryHeight: tip.height + 41,
      txid: fakeTxid(`send-${sent.length}-${req.to}-${result.amount}`),
      warnings: highFee ? [{ kind: 'highFee' }] : [],
      requiresExtraConfirmation: highFee,
    };
    return { summary, spend, account };
  };

  const pending = new Map<string, ReturnType<typeof build>>();

  const handlers: Record<string, (a: Record<string, unknown>) => unknown> = {
    zec_backend_info: () => ({ kind: 'default', network: d.network, label: mainnet ? ZEC_DEFAULT_ELECTRUM : '', available: mainnet, tor: d.torOn() }),
    zec_address: (a) => {
      d.requireUnlocked();
      const account = d.accounts.arg(a.account);
      return demoZecAddress(nodeOf(account), d.network, a.change ? 1 : 0, Number(a.index ?? 0));
    },
    zec_address_info: async (a) => {
      const addr = checkAddress(a.address);
      await gate();
      const list = utxos.get(addr) ?? [];
      const outgoing = sent.filter((s) => s.from.includes(addr) || s.change?.address === addr).length;
      return { address: addr, chain_stats: stats(list.length + outgoing, list.reduce((s, u) => s + u.value, 0)), mempool_stats: stats(0, 0) };
    },
    zec_address_utxos: async (a) => {
      const addr = checkAddress(a.address);
      await gate();
      return (utxos.get(addr) ?? []).map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, status: { confirmed: true, block_height: u.height }, coinbase: false }));
    },
    zec_address_txs: async (a) => {
      const addr = checkAddress(a.address);
      await gate();
      const incoming = (utxos.get(addr) ?? []).map((u) => ({
        txid: u.txid,
        status: { confirmed: true, block_height: u.height, block_time: Math.floor(Date.now() / 1000) - (tip.height - u.height) * 75 },
        vin: [{ txid: fakeTxid(`${u.txid}-prev`), vout: 0, prevout: { scriptpubkey: '76a914', scriptpubkey_address: u.from, value: u.value + 10_000 } }],
        vout: [{ scriptpubkey: '76a914', scriptpubkey_address: addr, value: u.value }],
        fee: 10_000,
      }));
      const outgoing = sent
        .filter((s) => s.from.includes(addr) || s.change?.address === addr)
        .map((s) => ({
          txid: `${s.txid}`,
          status: { confirmed: false },
          vin: s.from.map((f) => ({ txid: fakeTxid(`${s.txid}-in-${f}`), vout: 0, prevout: { scriptpubkey: '76a914', scriptpubkey_address: f, value: Math.floor((s.amount + s.fee + (s.change?.value ?? 0)) / s.from.length) } })),
          vout: [{ scriptpubkey: '76a914', scriptpubkey_address: s.to, value: s.amount }, ...(s.change ? [{ scriptpubkey: '76a914', scriptpubkey_address: s.change.address, value: s.change.value }] : [])],
          fee: s.fee,
        }));
      return [...outgoing, ...incoming];
    },
    zec_tip_height: async () => {
      await gate();
      return tip.height;
    },
    zec_send_preview: async (a) => {
      await gate();
      return build(a).summary;
    },
    zec_sign: async (a) => {
      await gate();
      const b = build(a);
      d.checkPassword(a.password);
      const s = b.summary;
      const signer = d.accounts.signer('zec', b.account, demoZecPath(d.network, b.account));
      const text = [
        signer.line,
        '',
        l10n('Envoi Zcash transparent', 'Transparent Zcash send'),
        l10n(`À : ${s.to}`, `To: ${s.to}`),
        l10n(`Montant : ${fmt(Number(s.amount))} ZEC`, `Amount: ${fmt(Number(s.amount))} ZEC`),
        ...(s.change ? [l10n(`Monnaie (revient chez toi) : ${fmt(Number(s.change.amount))} ZEC`, `Change (comes back to you): ${fmt(Number(s.change.amount))} ZEC`), l10n(`  ${s.change.address} (adresse de monnaie n° ${s.change.index})`, `  ${s.change.address} (change address #${s.change.index})`)] : []),
        l10n(`Frais : ${fmt(Number(s.fee))} ZEC (${s.fee} zatoshis ; ZIP 317 : ${s.zip317Fee} zatoshis)`, `Fee: ${fmt(Number(s.fee))} ZEC (${s.fee} zatoshis; ZIP 317: ${s.zip317Fee} zatoshis)`),
        l10n(`Réseau : ${s.upgrade} (branche ${s.branchId}) · valable jusqu’au bloc ${s.expiryHeight}`, `Network: ${s.upgrade} (branch ${s.branchId}) · valid until block ${s.expiryHeight}`),
        l10n('Transparent : le montant, ton adresse et le destinataire sont publics sur la chaîne.', 'Transparent: the amount, your address and the recipient are public on the chain.'),
      ].join('\n');
      if (!d.confirm(text)) throw new IpcError('USER_REJECTED', l10n('Signature refusée dans la fenêtre de confirmation', 'Signature refused in the confirmation window'));
      if (signer.unknown && !d.confirm(signer.unknownText)) throw new IpcError('USER_REJECTED', l10n('Signature refusée', 'Signature refused'));
      if (s.requiresExtraConfirmation && !d.confirm(l10n('Frais très élevés (plus de 10 fois les frais ZIP 317, ou plus que le montant envoyé). Signer quand même ?', 'Very high fee (more than 10 times the ZIP 317 fee, or more than the amount sent). Sign anyway?'))) {
        throw new IpcError('USER_REJECTED', l10n('Signature refusée', 'Signature refused'));
      }
      const hex = `05000080${bytesToHex(sha256(new TextEncoder().encode(s.txid)))}`;
      pending.set(hex, b);
      return { hex, txid: s.txid, summary: s };
    },
    zec_broadcast: async (a) => {
      await gate();
      const hex = String(a.hex ?? '');
      const b = pending.get(hex);
      if (!b) throw new IpcError('INVALID_INPUT', l10n('Entrée invalide : transaction Zcash mal formée', 'Invalid input: malformed Zcash transaction'));
      pending.delete(hex);
      for (const { owner, coin } of b.spend) utxos.set(owner, (utxos.get(owner) ?? []).filter((u) => u !== coin));
      const s = b.summary;
      if (s.change) {
        const list = utxos.get(s.change.address) ?? [];
        list.push({ txid: s.txid, vout: 1, value: Number(s.change.amount), height: tip.height + 1, from: s.change.address });
        utxos.set(s.change.address, list);
      }
      sent.push({ txid: s.txid, from: b.spend.map((x) => x.owner), to: s.toAddress, amount: Number(s.amount), change: s.change ? { address: s.change.address, value: Number(s.change.amount) } : null, fee: Number(s.fee), height: tip.height + 1 });
      return s.txid;
    },
  };
  return { handlers, me };
}
