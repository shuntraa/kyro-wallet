// SPDX-License-Identifier: GPL-3.0-or-later
//
// DEMO ONLY — Litecoin, Dogecoin, Bitcoin Cash and Dash (`ltc_*` / `doge_*` / `bch_*` /
// `dash_*`, docs/IPC.md §2.4), mirroring apps/desktop/src-tauri/src/commands_utxo.rs. Same
// Esplora shapes as Bitcoin, the server is picked here (Litecoin: litecoinspace.org by default;
// Dogecoin and Dash mainnet: Komodo's public ElectrumX servers; Bitcoin Cash: public Fulcrum
// servers on mainnet and chipnet; Dogecoin and Dash testnets: NO default, every read fails
// with SERVER_INVALID until an Esplora server is set), fake signatures. Like Rust, a legacy
// (Dogecoin / Bitcoin Cash / Dash) input is signed only if its previous transaction hashes to
// the outpoint's txid and its output pays one of our addresses; the amount (fee of the dialog)
// comes from that transaction. Bitcoin Cash: CashAddr addresses, and the signed PSBT comes back
// finalized (FORKID), as from Rust.
//
// Scenario words in a custom Esplora URL, like Bitcoin: « down » / « flaky » → SERVER_UNREACHABLE,
// « wrong » → SERVER_WRONG_NETWORK.

import { HDKey } from '@scure/bip32';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from '@bitcoinerlab/secp256k1';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';
import {
  IpcError,
  type Network,
  type ServerTestResult,
  type Settings,
  type UtxoAccountInfo,
  type UtxoBackendInfo,
  type UtxoCoinKey,
  type UtxoFeeRates,
  type UtxoServer,
  type UtxoTxSummary,
  type UtxoWarning,
} from './ipc';
import { checkServerUrl } from './servers';
import { CASHADDR_PREFIX, cashaddrToScript, scriptToCashaddr } from './cashaddr';
import { demoEsploraAddress, demoEsploraTxs, demoEsploraUtxos, type DemoChainState } from './mock-net';
import type { DemoTor } from './mock-tor';
import type { DemoAccountHooks } from './mock-accounts';
import { l10n } from './i18n';

bitcoin.initEccLib(ecc);

/** Same parameters as packages/chains (litecoin/dogecoin adapters) and wallet-core `utxo.rs`. */
export const DEMO_LTC_NETWORKS: Record<Network, bitcoin.Network> = {
  mainnet: { messagePrefix: '\x19Litecoin Signed Message:\n', bech32: 'ltc', bip32: { public: 0x0488b21e, private: 0x0488ade4 }, pubKeyHash: 0x30, scriptHash: 0x32, wif: 0xb0 },
  testnet: { messagePrefix: '\x19Litecoin Signed Message:\n', bech32: 'tltc', bip32: { public: 0x043587cf, private: 0x04358394 }, pubKeyHash: 0x6f, scriptHash: 0x3a, wif: 0xef },
};
export const DEMO_DOGE_NETWORKS: Record<Network, bitcoin.Network> = {
  mainnet: { messagePrefix: '\x19Dogecoin Signed Message:\n', bech32: 'doge', bip32: { public: 0x02facafd, private: 0x02fac398 }, pubKeyHash: 0x1e, scriptHash: 0x16, wif: 0x9e },
  testnet: { messagePrefix: '\x19Dogecoin Signed Message:\n', bech32: 'tdge', bip32: { public: 0x043587cf, private: 0x04358394 }, pubKeyHash: 0x71, scriptHash: 0xc4, wif: 0xf1 },
};

/** Bitcoin Cash: bitcoinjs only needs the base58 versions for its own checks; Kyro speaks CashAddr. */
export const DEMO_BCH_NETWORKS: Record<Network, bitcoin.Network> = {
  mainnet: { messagePrefix: '\x18Bitcoin Signed Message:\n', bech32: 'bitcoincash', bip32: { public: 0x0488b21e, private: 0x0488ade4 }, pubKeyHash: 0x00, scriptHash: 0x05, wif: 0x80 },
  testnet: { messagePrefix: '\x18Bitcoin Signed Message:\n', bech32: 'bchtest', bip32: { public: 0x043587cf, private: 0x04358394 }, pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef },
};
export const DEMO_DASH_NETWORKS: Record<Network, bitcoin.Network> = {
  mainnet: { messagePrefix: '\x19DarkCoin Signed Message:\n', bech32: 'xdash', bip32: { public: 0x0488b21e, private: 0x0488ade4 }, pubKeyHash: 0x4c, scriptHash: 0x10, wif: 0xcc },
  testnet: { messagePrefix: '\x19DarkCoin Signed Message:\n', bech32: 'tdash', bip32: { public: 0x043587cf, private: 0x04358394 }, pubKeyHash: 0x8c, scriptHash: 0x13, wif: 0xef },
};

/** Soft dust of Dogecoin (0.01 DOGE) and its hard limit (0.001 DOGE, non-standard below). */
const DOGE_SOFT_DUST = 1_000_000;
const DOGE_HARD_DUST = 100_000;
/** Bitcoin Cash / Dash dust limit of a P2PKH output (relay dust fee 3 000 per kB). */
const BCH_DASH_DUST = 546;

/** First default Dogecoin mainnet server (Rust: `net::ELECTRUM_HOSTS`). */
export const DOGE_DEFAULT_ELECTRUM = 'doge.electrum1.cipig.net';
/** First default servers of Bitcoin Cash (mainnet / chipnet) and Dash mainnet. */
export const BCH_DEFAULT_ELECTRUM: Record<Network, string> = { mainnet: 'bch.imaginary.cash', testnet: 'chipnet.imaginary.cash' };
export const DASH_DEFAULT_ELECTRUM = 'dash.electrum1.cipig.net';

export type DemoUtxoCoin = 'ltc' | 'doge' | 'bch' | 'dash';
type Coin = DemoUtxoCoin;
export const DEMO_UTXO_COINS: readonly Coin[] = ['ltc', 'doge', 'bch', 'dash'];
const KEY: Record<Coin, UtxoCoinKey> = { ltc: 'litecoin', doge: 'dogecoin', bch: 'bitcoincash', dash: 'dash' };
const NAME: Record<Coin, string> = { ltc: 'Litecoin', doge: 'Dogecoin', bch: 'Bitcoin Cash', dash: 'Dash' };
const UNIT: Record<Coin, string> = { ltc: 'litoshis', doge: 'koinus', bch: 'satoshis', dash: 'duffs' };
const COIN_TYPE: Record<Coin, number> = { ltc: 2, doge: 3, bch: 145, dash: 5 };

const netsOf = (coin: Coin) => ({ ltc: DEMO_LTC_NETWORKS, doge: DEMO_DOGE_NETWORKS, bch: DEMO_BCH_NETWORKS, dash: DEMO_DASH_NETWORKS })[coin];

/** scriptPubKey of an address of `coin` (Bitcoin Cash: CashAddr; others: bitcoinjs). Throws if invalid. */
export function demoUtxoScript(coin: Coin, network: Network, address: string): Uint8Array {
  if (coin === 'bch') return cashaddrToScript(address, CASHADDR_PREFIX[network]);
  const net = netsOf(coin)[network];
  // Dogecoin / Dash have no bech32: base58 only.
  if (coin !== 'ltc') bitcoin.address.fromBase58Check(address);
  return bitcoin.address.toOutputScript(address, net);
}

/** Address of a script on `coin`, `null` if it is not a standard address script. */
export function demoUtxoAddressOf(coin: Coin, network: Network, script: Uint8Array): string | null {
  if (coin === 'bch') return scriptToCashaddr(script, CASHADDR_PREFIX[network]);
  try {
    return bitcoin.address.fromOutputScript(script, netsOf(coin)[network]);
  } catch {
    return null;
  }
}

/** Account path of `coin` (`m/84'/2'/a'`, `m/44'/3'/a'`, `m/44'/145'/a'`, `m/44'/5'/a'`; testnet coin type 1), like Rust. */
export function demoUtxoPath(network: Network, coin: Coin, account: number): string {
  const ct = network === 'testnet' ? 1 : COIN_TYPE[coin];
  return `m/${coin === 'ltc' ? 84 : 44}'/${ct}'/${account}'`;
}

/** Account node of `coin` (standard xpub/tpub encoding, as Rust serializes them). */
export function demoUtxoAccount(seed: Uint8Array, network: Network, coin: Coin, account = 0): { info: UtxoAccountInfo; node: HDKey } {
  const testnet = network === 'testnet';
  const master = HDKey.fromMasterSeed(seed, testnet ? { private: 0x04358394, public: 0x043587cf } : undefined);
  const path = demoUtxoPath(network, coin, account);
  const node = master.derive(path);
  const fingerprint = master.fingerprint.toString(16).padStart(8, '0');
  return { info: { address: demoUtxoAddress(node, network, coin, 0, 0), xpub: node.publicExtendedKey, fingerprint, path }, node };
}

export function demoUtxoAddress(node: HDKey, network: Network, coin: Coin, change: number, index: number): string {
  const pubkey = node.deriveChild(change).deriveChild(index).publicKey;
  if (!pubkey) throw new IpcError('INTERNAL', l10n('dérivation', 'derivation'));
  const net = netsOf(coin)[network];
  const p = coin === 'ltc' ? bitcoin.payments.p2wpkh({ pubkey, network: net }) : bitcoin.payments.p2pkh({ pubkey, network: net });
  const address = coin === 'bch' && p.output ? scriptToCashaddr(p.output, CASHADDR_PREFIX[network]) : p.address;
  if (!address) throw new IpcError('INTERNAL', l10n('adresse', 'address'));
  return address;
}

export interface DemoUtxoDeps {
  chain: DemoChainState;
  network: Network;
  nodes: Record<Coin, HDKey>;
  /** Vault accounts (§2.9): account node, signer line of the dialog. */
  accounts: DemoAccountHooks;
  tor: DemoTor;
  settings: () => Settings;
  requireUnlocked: () => void;
  checkPassword: (password: unknown) => void;
  confirm: (text: string) => boolean;
}

const invalid = (m: string) => new IpcError('SERVER_INVALID', l10n(`Serveur invalide : ${m}`, `Invalid server: ${m}`));
const unreachable = (m: string) => new IpcError('SERVER_UNREACHABLE', l10n(`Serveur injoignable : ${m}`, `Server unreachable: ${m}`));
const has = (s: string, w: string) => s.toLowerCase().includes(w);
const hostOf = (u: string) => {
  try {
    return new URL(u).hostname;
  } catch {
    return u;
  }
};

export function createDemoUtxo(d: DemoUtxoDeps) {
  const netKey = d.network === 'mainnet' ? 'mainnet' : 'testnet';
  const torOn = () => d.settings().tor.enabled;
  const serverOf = (coin: Coin): UtxoServer => d.settings().servers[KEY[coin]][netKey] ?? { kind: 'default' };
  const utxosOf = (coin: Coin) => ({ ltc: d.chain.ltcUtxos, doge: d.chain.dogeUtxos, bch: d.chain.bchUtxos, dash: d.chain.dashUtxos })[coin];
  const tipOf = (coin: Coin) => ({ ltc: d.chain.ltcTip, doge: d.chain.dogeTip, bch: d.chain.bchTip, dash: d.chain.dashTip })[coin];
  const net = (coin: Coin) => netsOf(coin)[d.network];
  const addressOf = (coin: Coin, script: Uint8Array) => demoUtxoAddressOf(coin, d.network, script);
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** Kyro's default server exists for this coin on this network (not Dogecoin / Dash testnet). */
  const hasDefault = (coin: Coin) => coin === 'ltc' || coin === 'bch' || d.network === 'mainnet';
  const defaultLabel = (coin: Coin): string => {
    if (!hasDefault(coin)) return '';
    return { ltc: 'litecoinspace.org', doge: DOGE_DEFAULT_ELECTRUM, bch: BCH_DEFAULT_ELECTRUM[d.network], dash: DASH_DEFAULT_ELECTRUM }[coin];
  };

  /** Gate of every read: the right server, Tor, no fallback. */
  const backend = async (coin: Coin) => {
    const s = serverOf(coin);
    if (s.kind === 'default' && !hasDefault(coin)) {
      throw invalid(l10n(`${KEY[coin]} : aucun serveur public gratuit — configure ton serveur Esplora (electrs-${KEY[coin]}) dans Réglages › Réseaux et serveurs`, `${KEY[coin]}: no free public server — set up your Esplora server (electrs-${KEY[coin]}) in Settings › Networks and servers`));
    }
    if (torOn()) await d.tor.waitReady();
    await wait(70 + Math.random() * 160);
    if (s.kind === 'esplora' && (has(s.url, 'down') || has(s.url, 'flaky'))) throw unreachable(l10n(`${hostOf(s.url)} : délai de connexion dépassé`, `${hostOf(s.url)}: connection timed out`));
    return s;
  };

  const checkAddress = (coin: Coin, a: unknown): string => {
    const addr = String(a ?? '');
    try {
      demoUtxoScript(coin, d.network, addr);
    } catch {
      throw new IpcError('INVALID_INPUT', l10n(`Entrée invalide : adresse ${NAME[coin]} invalide pour ce réseau « ${addr} »`, `Invalid input: invalid ${NAME[coin]} address for this network “${addr}”`));
    }
    return addr;
  };

  const nodeOf = (coin: Coin, account: number): HDKey => (account === 0 ? d.nodes[coin] : d.accounts.utxoNode(coin, account));
  const own = (coin: Coin, account: number): Set<string> => {
    const out = new Set<string>();
    for (const ch of [0, 1]) for (let i = 0; i < 20; i++) out.add(demoUtxoAddress(nodeOf(coin, account), d.network, coin, ch, i));
    return out;
  };

  const probe = async (coin: Coin, network: string, s: UtxoServer): Promise<ServerTestResult['detected']> => {
    if (network !== 'mainnet' && network !== 'testnet') throw invalid(l10n(`${KEY[coin]} : réseau inconnu « ${network} » (mainnet ou testnet)`, `${KEY[coin]}: unknown network “${network}” (mainnet or testnet)`));
    if (s.kind === 'default') {
      if (!hasDefault(coin)) throw invalid(l10n(`${KEY[coin]} : aucun serveur public gratuit sur testnet, configure ton serveur Esplora`, `${KEY[coin]}: no free public server on testnet, set up your Esplora server`));
      return { network, blockHeight: tipOf(coin) };
    }
    const bad = checkServerUrl(s.url, torOn());
    if (bad) throw invalid(l10n(`${KEY[coin]} ${network} : ${bad}`, `${KEY[coin]} ${network}: ${bad}`));
    if (torOn()) await d.tor.waitReady();
    await wait(100 + Math.random() * 200);
    if (has(s.url, 'down')) throw unreachable(l10n(`${hostOf(s.url)} : délai de connexion dépassé`, `${hostOf(s.url)}: connection timed out`));
    if (has(s.url, 'wrong')) throw new IpcError('SERVER_WRONG_NETWORK', l10n(`Mauvais réseau : ce serveur n’est pas sur ${NAME[coin]} ${network}`, `Wrong network: this server is not on ${NAME[coin]} ${network}`));
    return { network, blockHeight: tipOf(coin) };
  };

  const fakeSig = (seed: string, type = 0x01): Uint8Array => {
    const r = sha256(new TextEncoder().encode(`r:${seed}`));
    const s = sha256(new TextEncoder().encode(`s:${seed}`));
    r[0] = ((r[0] ?? 0) & 0x3f) | 0x01;
    s[0] = ((s[0] ?? 0) & 0x3f) | 0x01;
    return new Uint8Array([0x30, 0x44, 0x02, 0x20, ...r, 0x02, 0x20, ...s, type]);
  };

  const sign = async (coin: Coin, a: Record<string, unknown>) => {
    d.requireUnlocked();
    const account = d.accounts.arg(a.account);
    d.checkPassword(a.password);
    let psbt: bitcoin.Psbt;
    try {
      psbt = bitcoin.Psbt.fromBase64(String(a.psbt ?? ''), { network: net(coin) });
    } catch {
      throw new IpcError('INVALID_INPUT', l10n('Entrée invalide : PSBT invalide', 'Invalid input: invalid PSBT'));
    }
    let inSum = 0n;
    psbt.data.inputs.forEach((input, i) => {
      if (!input.bip32Derivation?.length) throw new IpcError('INVALID_INPUT', l10n(`Entrée invalide : entrée ${i} sans dérivation`, `Invalid input: input ${i} without derivation`));
      if (coin !== 'ltc') {
        if (!input.nonWitnessUtxo || input.witnessUtxo) throw new IpcError('INVALID_INPUT', l10n(`Entrée invalide : ${NAME[coin]}, l’entrée ${i} doit porter la transaction précédente (non_witness_utxo) et pas de witness_utxo`, `Invalid input: ${NAME[coin]}, input ${i} must carry the previous transaction (non_witness_utxo) and no witness_utxo`));
        // Amount and script ONLY from the previous transaction, checked against the outpoint.
        const prev = bitcoin.Transaction.fromBuffer(input.nonWitnessUtxo);
        const txIn = psbt.txInputs[i]!;
        if (prev.getId() !== bytesToHex(Uint8Array.from(txIn.hash).reverse())) throw new IpcError('INVALID_INPUT', l10n(`Entrée invalide : entrée ${i}, la transaction précédente ne correspond pas à l’outpoint`, `Invalid input: input ${i}, the previous transaction does not match the outpoint`));
        const spent = prev.outs[txIn.index];
        if (!spent) throw new IpcError('INVALID_INPUT', l10n(`Entrée invalide : entrée ${i}, sortie précédente absente`, `Invalid input: input ${i}, previous output missing`));
        const payee = addressOf(coin, spent.script);
        if (!payee || !own(coin, d.accounts.arg(a.account)).has(payee)) throw new IpcError('INVALID_INPUT', l10n(`Entrée invalide : entrée ${i}, la pièce dépensée ne paie pas ce portefeuille`, `Invalid input: input ${i}, the spent coin does not pay this wallet`));
        inSum += spent.value;
      } else {
        if (!input.witnessUtxo) throw new IpcError('INVALID_INPUT', l10n(`Entrée invalide : Litecoin, l’entrée ${i} doit porter witness_utxo`, `Invalid input: Litecoin, input ${i} must carry witness_utxo`));
        inSum += input.witnessUtxo.value;
      }
    });
    const mine = own(coin, account);
    const warnings: UtxoWarning[] = [];
    const outputs = psbt.txOutputs.map((o, index) => {
      const address = addressOf(coin, o.script);
      if (!address) warnings.push({ kind: 'unknownOutput', index });
      if ((coin === 'bch' || coin === 'dash') && o.value < BigInt(BCH_DASH_DUST)) throw new IpcError('INVALID_INPUT', l10n(`Entrée invalide : sortie ${index} sous ${BCH_DASH_DUST} ${UNIT[coin]} (poussière, non standard)`, `Invalid input: output ${index} below ${BCH_DASH_DUST} ${UNIT[coin]} (dust, non-standard)`));
      if (coin === 'doge' && o.value < BigInt(DOGE_HARD_DUST)) throw new IpcError('INVALID_INPUT', l10n(`Entrée invalide : sortie ${index} sous 0,001 DOGE (non standard)`, `Invalid input: output ${index} below 0.001 DOGE (non-standard)`));
      if (coin === 'doge' && o.value < BigInt(DOGE_SOFT_DUST)) warnings.push({ kind: 'softDust', index });
      // Rust: change = key origin on the output + derived key + script match (not just « one of our addresses »).
      const isChange = !!address && mine.has(address) && (psbt.data.outputs[index]?.bip32Derivation?.length ?? 0) > 0;
      return { address, script: bytesToHex(o.script), amount: o.value.toString(), isChange, kind: address ? ('address' as const) : ('unknown' as const) };
    });
    const outSum = psbt.txOutputs.reduce((s, o) => s + o.value, 0n);
    const fee = inSum - outSum;
    const n = psbt.inputCount;
    const size = Math.ceil(coin === 'ltc' ? 10.5 + 68 * n + psbt.txOutputs.length * 31 : 10 + 148 * n + psbt.txOutputs.length * 34);
    const summary: UtxoTxSummary = {
      coin: KEY[coin],
      outputs,
      inputs: n,
      ourInputs: n,
      fee: fee.toString(),
      size,
      feePerKb: Number((fee * 1000n) / BigInt(size)),
      hasChange: outputs.some((o) => o.isChange),
      warnings,
      requiresExtraConfirmation: warnings.length > 0,
    };
    const unit = UNIT[coin];
    const lines = outputs.map((o) => l10n(`${o.isChange ? '(monnaie) ' : ''}${o.address ?? 'INCONNUE'} : ${o.amount} ${unit}`, `${o.isChange ? '(change) ' : ''}${o.address ?? 'UNKNOWN'}: ${o.amount} ${unit}`)).join('\n');
    const text = l10n(`Confirmer la transaction ${NAME[coin]}\n${lines}\nFrais : ${summary.fee} ${unit} (${summary.size} ${coin === 'ltc' ? 'vB' : 'octets'})${summary.hasChange ? '' : '\nPas de monnaie : le reste (sous le seuil de poussière) va aux frais.'}`, `Confirm the ${NAME[coin]} transaction\n${lines}\nFees: ${summary.fee} ${unit} (${summary.size} ${coin === 'ltc' ? 'vB' : 'bytes'})${summary.hasChange ? '' : '\nNo change: the rest (below the dust threshold) goes to the fees.'}`);
    const signer = d.accounts.signer(coin, account, demoUtxoPath(d.network, coin, account));
    if (!d.confirm(`${signer.line}

${text}`)) throw new IpcError('USER_REJECTED', l10n('Signature refusée.', 'Signature refused.'));
    if (signer.unknown && !d.confirm(signer.unknownText)) throw new IpcError('USER_REJECTED', l10n('Signature refusée.', 'Signature refused.'));
    if (summary.requiresExtraConfirmation && !d.confirm(l10n('Attention : transaction à vérifier\nNe signe que si tu sais exactement pourquoi. Signer quand même ?', 'Warning: transaction to check\nOnly sign if you know exactly why. Sign anyway?'))) throw new IpcError('USER_REJECTED', l10n('Signature refusée.', 'Signature refused.'));
    psbt.data.inputs.forEach((input, i) => {
      const pubkey = input.bip32Derivation![0]!.pubkey;
      if (coin === 'bch') {
        // Rust finalizes FORKID signatures (type 0x41): scriptSig = <sig> <pubkey>.
        const sig = fakeSig(`${coin}:${i}:${a.psbt}`, 0x41);
        psbt.updateInput(i, { finalScriptSig: Uint8Array.from([sig.length, ...sig, pubkey.length, ...pubkey]) });
      } else {
        psbt.updateInput(i, { partialSig: [{ pubkey, signature: fakeSig(`${coin}:${i}:${a.psbt}`) }] });
      }
    });
    return { psbt: psbt.toBase64(), summary };
  };

  const commands = (coin: Coin) => ({
    backend_info: (): UtxoBackendInfo => {
      const s = serverOf(coin);
      const available = s.kind === 'esplora' || hasDefault(coin);
      const label = s.kind === 'esplora' ? hostOf(s.url) : defaultLabel(coin);
      return { kind: s.kind, network: netKey, label, available, tor: torOn() };
    },
    address: (a: Record<string, unknown>) => {
      d.requireUnlocked();
      const index = Number(a.index);
      if (!Number.isInteger(index) || index < 0 || index > 2 ** 31 - 1) throw new IpcError('INVALID_INPUT', l10n('Index invalide.', 'Invalid index.'));
      return demoUtxoAddress(nodeOf(coin, d.accounts.arg(a.account)), d.network, coin, a.change ? 1 : 0, index);
    },
    address_info: async (a: Record<string, unknown>) => {
      const addr = checkAddress(coin, a.address);
      await backend(coin);
      return demoEsploraAddress(d.chain, addr, utxosOf(coin));
    },
    address_utxos: async (a: Record<string, unknown>) => {
      const addr = checkAddress(coin, a.address);
      await backend(coin);
      return demoEsploraUtxos(d.chain, addr, utxosOf(coin));
    },
    address_txs: async (a: Record<string, unknown>) => {
      const addr = checkAddress(coin, a.address);
      await backend(coin);
      // Sender placeholders in the coin's own address format (tltc1q… / n… / bchtest:q…), never a Bitcoin tb1q….
      const bech = coin === 'ltc' ? /^([a-z]+1)/.exec(addr)?.[1] : undefined;
      const cash = coin === 'bch' ? `${CASHADDR_PREFIX[d.network]}:q` : undefined;
      const foreign = cash
        ? { sender: `${cash}demoexternalsender0000000000000000000`, change: `${cash}demoexternalchange0000000000000000000` }
        : bech
        ? { sender: `${bech}qdemoexternalsender000000000000000000`, change: `${bech}qdemoexternalchange000000000000000000` }
        : { sender: `${addr[0] ?? 'D'}demoExternalSender1111111111111`, change: `${addr[0] ?? 'D'}demoExternalChange1111111111111` };
      return demoEsploraTxs(d.chain, addr, utxosOf(coin), foreign);
    },
    tx_hex: async (a: Record<string, unknown>) => {
      const txid = String(a.txid ?? '');
      if (!/^[0-9a-f]{64}$/.test(txid)) throw new IpcError('INVALID_INPUT', l10n('Entrée invalide : txid : 64 caractères hexadécimaux attendus', 'Invalid input: txid: 64 hexadecimal characters expected'));
      await backend(coin);
      const hex = d.chain.rawTx.get(txid);
      if (!hex) throw new IpcError('INVALID_INPUT', l10n(`Entrée invalide : transaction ${txid.slice(0, 10)}… inconnue du serveur`, `Invalid input: transaction ${txid.slice(0, 10)}… unknown to the server`));
      return hex;
    },
    fee_rates: async (): Promise<UtxoFeeRates> => {
      await backend(coin);
      if (coin === 'ltc') return { fastestFee: 3, halfHourFee: 2, hourFee: 1, economyFee: 1, minimumFee: 1 };
      if (coin === 'doge') return { fastestFee: 1000, halfHourFee: 1000, hourFee: 1000, economyFee: 1000, minimumFee: 1000, source: 'policy' };
      // Bitcoin Cash / Dash public servers answer 0.00001 per kB everywhere: 1 sat (duff) per byte.
      return { fastestFee: 1, halfHourFee: 1, hourFee: 1, economyFee: 1, minimumFee: 1 };
    },
    tip_height: async () => {
      await backend(coin);
      return tipOf(coin);
    },
    broadcast: async (a: Record<string, unknown>) => {
      let txid: string;
      try {
        txid = bitcoin.Transaction.fromHex(String(a.hex ?? '').trim()).getId();
      } catch {
        throw new IpcError('INVALID_INPUT', l10n('Entrée invalide : transaction hexadécimale invalide', 'Invalid input: invalid hexadecimal transaction'));
      }
      await backend(coin);
      return txid;
    },
    sign_psbt: (a: Record<string, unknown>) => sign(coin, a),
  });

  const prefixed = (coin: Coin) => Object.fromEntries(Object.entries(commands(coin)).map(([k, f]) => [`${coin}_${k}`, f])) as Record<string, (a: Record<string, unknown>) => unknown>;

  return {
    handlers: { ...prefixed('ltc'), ...prefixed('doge'), ...prefixed('bch'), ...prefixed('dash') },
    probe,
    /** Syntax check of `servers.{litecoin,dogecoin,bitcoincash,dash}` (SERVER_INVALID prefixed by the slot). */
    validate: (servers: Settings['servers'], tor: boolean) => {
      for (const coin of DEMO_UTXO_COINS) {
        for (const nk of ['mainnet', 'testnet'] as const) {
          const s = servers[KEY[coin]]?.[nk];
          if (s?.kind === 'esplora') {
            const bad = checkServerUrl(s.url, tor);
            if (bad) throw invalid(l10n(`${KEY[coin]} ${nk} : ${bad}`, `${KEY[coin]} ${nk}: ${bad}`));
          }
        }
      }
    },
  };
}
