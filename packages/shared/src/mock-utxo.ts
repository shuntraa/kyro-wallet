// SPDX-License-Identifier: GPL-3.0-or-later
//
// DEMO ONLY — Litecoin and Dogecoin (`ltc_*` / `doge_*`, docs/IPC.md §2.4), mirroring
// apps/desktop/src-tauri/src/commands_utxo.rs. Same Esplora shapes as Bitcoin, the server is
// picked here (Litecoin: litecoinspace.org by default; Dogecoin: NO default, every read
// fails with SERVER_INVALID until an Esplora server is set), fake signatures.
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
import { demoEsploraAddress, demoEsploraTxs, demoEsploraUtxos, type DemoChainState } from './mock-net';
import type { DemoTor } from './mock-tor';
import type { DemoAccountHooks } from './mock-accounts';

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

/** Soft dust of Dogecoin (0.01 DOGE) and its hard limit (0.001 DOGE, non-standard below). */
const DOGE_SOFT_DUST = 1_000_000;
const DOGE_HARD_DUST = 100_000;

type Coin = 'ltc' | 'doge';
const KEY: Record<Coin, UtxoCoinKey> = { ltc: 'litecoin', doge: 'dogecoin' };
const NAME: Record<Coin, string> = { ltc: 'Litecoin', doge: 'Dogecoin' };

const netsOf = (coin: Coin) => (coin === 'ltc' ? DEMO_LTC_NETWORKS : DEMO_DOGE_NETWORKS);

/** Account path of `coin` (`m/84'/2'/a'`, `m/44'/3'/a'`; testnet coin type 1), like Rust. */
export function demoUtxoPath(network: Network, coin: Coin, account: number): string {
  const testnet = network === 'testnet';
  return coin === 'ltc' ? `m/84'/${testnet ? 1 : 2}'/${account}'` : `m/44'/${testnet ? 1 : 3}'/${account}'`;
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
  if (!pubkey) throw new IpcError('INTERNAL', 'dérivation');
  const net = netsOf(coin)[network];
  const p = coin === 'ltc' ? bitcoin.payments.p2wpkh({ pubkey, network: net }) : bitcoin.payments.p2pkh({ pubkey, network: net });
  if (!p.address) throw new IpcError('INTERNAL', 'adresse');
  return p.address;
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

const invalid = (m: string) => new IpcError('SERVER_INVALID', `Serveur invalide : ${m}`);
const unreachable = (m: string) => new IpcError('SERVER_UNREACHABLE', `Serveur injoignable : ${m}`);
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
  const utxosOf = (coin: Coin) => (coin === 'ltc' ? d.chain.ltcUtxos : d.chain.dogeUtxos);
  const net = (coin: Coin) => netsOf(coin)[d.network];
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** Gate of every read: the right server, Tor, no fallback. */
  const backend = async (coin: Coin) => {
    const s = serverOf(coin);
    if (coin === 'doge' && s.kind === 'default') {
      throw invalid('dogecoin : aucun serveur public gratuit — configure ton serveur Esplora (electrs-dogecoin) dans Réglages › Réseaux et serveurs');
    }
    if (torOn()) await d.tor.waitReady();
    await wait(70 + Math.random() * 160);
    if (s.kind === 'esplora' && (has(s.url, 'down') || has(s.url, 'flaky'))) throw unreachable(`${hostOf(s.url)} : délai de connexion dépassé`);
    return s;
  };

  const checkAddress = (coin: Coin, a: unknown): string => {
    const addr = String(a ?? '');
    try {
      bitcoin.address.toOutputScript(addr, net(coin));
    } catch {
      throw new IpcError('INVALID_INPUT', `Entrée invalide : adresse ${NAME[coin]} invalide pour ce réseau « ${addr} »`);
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
    if (network !== 'mainnet' && network !== 'testnet') throw invalid(`${KEY[coin]} : réseau inconnu « ${network} » (mainnet ou testnet)`);
    if (s.kind === 'default') {
      if (coin === 'doge') throw invalid('dogecoin : aucun serveur public gratuit, configure ton serveur Esplora');
      return { network, blockHeight: d.chain.ltcTip };
    }
    const bad = checkServerUrl(s.url, torOn());
    if (bad) throw invalid(`${KEY[coin]} ${network} : ${bad}`);
    if (torOn()) await d.tor.waitReady();
    await wait(100 + Math.random() * 200);
    if (has(s.url, 'down')) throw unreachable(`${hostOf(s.url)} : délai de connexion dépassé`);
    if (has(s.url, 'wrong')) throw new IpcError('SERVER_WRONG_NETWORK', `Mauvais réseau : ce serveur n’est pas sur ${NAME[coin]} ${network}`);
    return { network, blockHeight: coin === 'ltc' ? d.chain.ltcTip : d.chain.dogeTip };
  };

  const fakeSig = (seed: string): Uint8Array => {
    const r = sha256(new TextEncoder().encode(`r:${seed}`));
    const s = sha256(new TextEncoder().encode(`s:${seed}`));
    r[0] = ((r[0] ?? 0) & 0x3f) | 0x01;
    s[0] = ((s[0] ?? 0) & 0x3f) | 0x01;
    return new Uint8Array([0x30, 0x44, 0x02, 0x20, ...r, 0x02, 0x20, ...s, 0x01]);
  };

  const sign = async (coin: Coin, a: Record<string, unknown>) => {
    d.requireUnlocked();
    const account = d.accounts.arg(a.account);
    d.checkPassword(a.password);
    let psbt: bitcoin.Psbt;
    try {
      psbt = bitcoin.Psbt.fromBase64(String(a.psbt ?? ''), { network: net(coin) });
    } catch {
      throw new IpcError('INVALID_INPUT', 'Entrée invalide : PSBT invalide');
    }
    let inSum = 0n;
    psbt.data.inputs.forEach((input, i) => {
      if (!input.bip32Derivation?.length) throw new IpcError('INVALID_INPUT', `Entrée invalide : entrée ${i} sans dérivation`);
      if (coin === 'doge') {
        if (!input.nonWitnessUtxo || input.witnessUtxo) throw new IpcError('INVALID_INPUT', `Entrée invalide : Dogecoin, l’entrée ${i} doit porter la transaction précédente (non_witness_utxo) et pas de witness_utxo`);
        const prev = bitcoin.Transaction.fromBuffer(input.nonWitnessUtxo);
        inSum += prev.outs[psbt.txInputs[i]?.index ?? 0]?.value ?? 0n;
      } else {
        if (!input.witnessUtxo) throw new IpcError('INVALID_INPUT', `Entrée invalide : Litecoin, l’entrée ${i} doit porter witness_utxo`);
        inSum += input.witnessUtxo.value;
      }
    });
    const mine = own(coin, account);
    const warnings: UtxoWarning[] = [];
    const outputs = psbt.txOutputs.map((o, index) => {
      const address = ((): string | null => {
        try {
          return bitcoin.address.fromOutputScript(o.script, net(coin));
        } catch {
          return null;
        }
      })();
      if (!address) warnings.push({ kind: 'unknownOutput', index });
      if (coin === 'doge' && o.value < BigInt(DOGE_HARD_DUST)) throw new IpcError('INVALID_INPUT', `Entrée invalide : sortie ${index} sous 0,001 DOGE (non standard)`);
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
    const unit = coin === 'ltc' ? 'litoshis' : 'koinus';
    const lines = outputs.map((o) => `${o.isChange ? '(monnaie) ' : ''}${o.address ?? 'INCONNUE'} : ${o.amount} ${unit}`).join('\n');
    const text = `Confirmer la transaction ${NAME[coin]}\n${lines}\nFrais : ${summary.fee} ${unit} (${summary.size} ${coin === 'ltc' ? 'vB' : 'octets'})${summary.hasChange ? '' : '\nPas de monnaie : le reste (sous le seuil de poussière) va aux frais.'}`;
    const signer = d.accounts.signer(coin, account, demoUtxoPath(d.network, coin, account));
    if (!d.confirm(`${signer.line}

${text}`)) throw new IpcError('USER_REJECTED', 'Signature refusée.');
    if (signer.unknown && !d.confirm(signer.unknownText)) throw new IpcError('USER_REJECTED', 'Signature refusée.');
    if (summary.requiresExtraConfirmation && !d.confirm('Attention : transaction à vérifier\nNe signe que si tu sais exactement pourquoi. Signer quand même ?')) throw new IpcError('USER_REJECTED', 'Signature refusée.');
    psbt.data.inputs.forEach((input, i) => {
      const pubkey = input.bip32Derivation![0]!.pubkey;
      psbt.updateInput(i, { partialSig: [{ pubkey, signature: fakeSig(`${coin}:${i}:${a.psbt}`) }] });
    });
    return { psbt: psbt.toBase64(), summary };
  };

  const commands = (coin: Coin) => ({
    backend_info: (): UtxoBackendInfo => {
      const s = serverOf(coin);
      const available = !(coin === 'doge' && s.kind === 'default');
      const label = s.kind === 'esplora' ? hostOf(s.url) : coin === 'ltc' ? 'litecoinspace.org' : '';
      return { kind: s.kind, network: netKey, label, available, tor: torOn() };
    },
    address: (a: Record<string, unknown>) => {
      d.requireUnlocked();
      const index = Number(a.index);
      if (!Number.isInteger(index) || index < 0 || index > 2 ** 31 - 1) throw new IpcError('INVALID_INPUT', 'Index invalide.');
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
      // Sender placeholders in the coin's own address format (tltc1q… / n…), never a Bitcoin tb1q….
      const bech = /^([a-z]+1)/.exec(addr)?.[1];
      const foreign = bech
        ? { sender: `${bech}qdemoexternalsender000000000000000000`, change: `${bech}qdemoexternalchange000000000000000000` }
        : { sender: `${addr[0] ?? 'D'}demoExternalSender1111111111111`, change: `${addr[0] ?? 'D'}demoExternalChange1111111111111` };
      return demoEsploraTxs(d.chain, addr, utxosOf(coin), foreign);
    },
    tx_hex: async (a: Record<string, unknown>) => {
      const txid = String(a.txid ?? '');
      if (!/^[0-9a-f]{64}$/.test(txid)) throw new IpcError('INVALID_INPUT', 'Entrée invalide : txid : 64 caractères hexadécimaux attendus');
      await backend(coin);
      const hex = d.chain.rawTx.get(txid);
      if (!hex) throw new IpcError('INVALID_INPUT', `Entrée invalide : transaction ${txid.slice(0, 10)}… inconnue du serveur`);
      return hex;
    },
    fee_rates: async (): Promise<UtxoFeeRates> => {
      await backend(coin);
      return coin === 'ltc' ? { fastestFee: 3, halfHourFee: 2, hourFee: 1, economyFee: 1, minimumFee: 1 } : { fastestFee: 1000, halfHourFee: 1000, hourFee: 1000, economyFee: 1000, minimumFee: 1000, source: 'policy' };
    },
    tip_height: async () => {
      await backend(coin);
      return coin === 'ltc' ? d.chain.ltcTip : d.chain.dogeTip;
    },
    broadcast: async (a: Record<string, unknown>) => {
      let txid: string;
      try {
        txid = bitcoin.Transaction.fromHex(String(a.hex ?? '').trim()).getId();
      } catch {
        throw new IpcError('INVALID_INPUT', 'Entrée invalide : transaction hexadécimale invalide');
      }
      await backend(coin);
      return txid;
    },
    sign_psbt: (a: Record<string, unknown>) => sign(coin, a),
  });

  const prefixed = (coin: Coin) => Object.fromEntries(Object.entries(commands(coin)).map(([k, f]) => [`${coin}_${k}`, f])) as Record<string, (a: Record<string, unknown>) => unknown>;

  return {
    handlers: { ...prefixed('ltc'), ...prefixed('doge') },
    probe,
    /** Syntax check of `servers.litecoin` / `servers.dogecoin` (SERVER_INVALID prefixed by the slot). */
    validate: (servers: Settings['servers'], tor: boolean) => {
      for (const coin of ['ltc', 'doge'] as const) {
        for (const nk of ['mainnet', 'testnet'] as const) {
          const s = servers[KEY[coin]]?.[nk];
          if (s?.kind === 'esplora') {
            const bad = checkServerUrl(s.url, tor);
            if (bad) throw invalid(`${KEY[coin]} ${nk} : ${bad}`);
          }
        }
      }
    },
  };
}
