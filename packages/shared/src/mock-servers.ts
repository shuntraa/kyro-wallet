// SPDX-License-Identifier: GPL-3.0-or-later
//
// DEMO ONLY — custom servers (B2b): live checks, Electrum certificates, Bitcoin data in
// Esplora shapes whatever the backend, Bitcoin Core watch-only wallet. Mirrors
// apps/desktop/src-tauri/src/{servers,commands_servers,btc_backend}.rs.
//
// Scenarios are chosen by the URL / host the user types (like `?tor=fail` for Tor):
//   - contains « down »    → SERVER_UNREACHABLE (connection, TLS, timeout);
//   - contains « flaky »   → passes the check at save, then SERVER_UNREACHABLE on every data
//     request (a server that went down later: the UI must say so, never fall back);
//   - contains « wrong »   → SERVER_WRONG_NETWORK (other genesis / chainId);
//   - Electrum host with « self » → self-signed certificate (webpkiValid = false, must be pinned);
//   - Core: user/password « wrong » → SERVER_INVALID (RPC auth refused); a cookie path
//     containing « missing » → SERVER_INVALID (unreadable .cookie).
// Once a custom server is set for a chain, the default host of that chain is refused
// (DEFAULT_SERVER_DISABLED), exactly like Rust: never a silent fallback.

import * as bitcoin from 'bitcoinjs-lib';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';
import {
  IpcError,
  type BtcNetworkKey,
  type BtcServer,
  type CoreRescanFrom,
  type CoreStatus,
  type ElectrumCertInfo,
  type Network,
  type NetRequest,
  type NetResponse,
  type RpcServer,
  type ServerTestResult,
  type ServerTestTarget,
  type Servers,
  type Settings,
  type SolanaCluster,
} from './ipc';
import { EMPTY_SERVERS, bitcoinServerFor, btcNetworkKey, checkBtcServer, checkServerUrl, coreIsLocal, isOnion, mergeServerSecrets, solanaCluster } from './servers';
import { DEMO_FEE_RATES, EVM_HOSTS, demoEsploraAddress, demoEsploraTxs, demoEsploraUtxos, handleDemoNet, type DemoChainState, type DemoRoute } from './mock-net';
import type { DemoTor } from './mock-tor';
import { cbfDisabled, type DemoCbf } from './mock-cbf';
import type { createDemoUtxo } from './mock-utxo';
import type { createDemoTron } from './mock-tron';
import type { createDemoXrp } from './mock-xrp';
import type { createDemoCardano } from './mock-cardano';
import { l10n } from './i18n';

const BTC_GENESIS: Record<BtcNetworkKey, string> = {
  mainnet: '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f',
  testnet4: '00000000da84f2bafbbc53dee25a72ae507ff4914b867c565be350b0da8bf043',
};
const SOL_GENESIS: Record<SolanaCluster, string> = {
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
};
const SOL_DEFAULT_HOST: Record<SolanaCluster, string> = { devnet: 'api.devnet.solana.com', 'mainnet-beta': 'api.mainnet-beta.solana.com' };
const EVM_DEFAULT_HOST = new Map(Object.entries(EVM_HOSTS).map(([host, id]) => [id, host]));

/** Simulated rescan duration of `btc_core_setup` with a date (a real one can take hours). */
export const DEMO_RESCAN_MS = 8000;
const IMPORT_MS = 1200;

const invalid = (m: string) => new IpcError('SERVER_INVALID', l10n(`Serveur invalide : ${m}`, `Invalid server: ${m}`));
const wrongNet = (m: string) => new IpcError('SERVER_WRONG_NETWORK', l10n(`Mauvais réseau : ${m}`, `Wrong network: ${m}`));
const unreachable = (m: string) => new IpcError('SERVER_UNREACHABLE', l10n(`Serveur injoignable : ${m}`, `Server unreachable: ${m}`));

const hostOfUrl = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};
const has = (s: string, word: string) => s.toLowerCase().includes(word);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Down for data requests (not for the live check when only « flaky »). */
const downLater = (s: string) => has(s, 'down') || has(s, 'flaky');

/** Deterministic demo certificate of `host:port`. */
export function demoElectrumCert(host: string, port: number): ElectrumCertInfo {
  return { sha256: bytesToHex(sha256(new TextEncoder().encode(`kyro-demo-cert:${host.toLowerCase()}:${port}`))), webpkiValid: !has(host, 'self') };
}

/** Text of a server for scenario words (url, or host for Electrum). */
function scenarioText(s: BtcServer | RpcServer): string {
  if ('kind' in s) {
    if (s.kind === 'electrum') return s.host;
    if (s.kind === 'default' || s.kind === 'cbf') return '';
  }
  return (s as { url: string }).url;
}

export interface DemoServersDeps {
  chain: DemoChainState;
  network: Network;
  /** Master fingerprint (8 hex) → `kyro-watch-<fp>`. */
  fingerprint: string;
  tor: DemoTor;
  settings: () => Settings;
  requireUnlocked: () => void;
  /** Compact filters (feature `cbf`: FEATURE_DISABLED unless enabled). */
  cbf: DemoCbf;
  /** Litecoin / Dogecoin servers (checks and probes). */
  utxo: Pick<ReturnType<typeof createDemoUtxo>, 'probe' | 'validate'>;
  /** TRON servers (checks and probes). */
  tron: Pick<ReturnType<typeof createDemoTron>, 'probe' | 'validate'>;
  /** XRP Ledger servers (checks and probes). */
  xrp: Pick<ReturnType<typeof createDemoXrp>, 'probe' | 'validate'>;
  /** Cardano servers (checks and probes). */
  cardano: Pick<ReturnType<typeof createDemoCardano>, 'probe' | 'validate'>;
}

export function createDemoServers(d: DemoServersDeps) {
  const wallets = new Set<string>(); // Core watch wallets created (per node URL)
  let job: { url: string; state: 'importing' | 'ready' | 'error'; started: number; rescanMs: number; error?: string } | null = null;
  const walletName = `kyro-watch-${d.fingerprint}`;

  const torOn = () => d.settings().tor.enabled;
  /** Through Tor when enabled (fail closed), except a local/LAN Bitcoin Core reached directly. */
  const gate = async (direct = false) => {
    if (torOn() && !direct) await d.tor.waitReady();
    await wait(80 + Math.random() * 180);
  };

  const checkElectrumCert = (s: Extract<BtcServer, { kind: 'electrum' }>) => {
    if (s.tls === 'none') return;
    const cert = demoElectrumCert(s.host, s.port);
    if (s.tls === 'pinned' && cert.sha256 !== (s.certSha256 ?? '').replace(/[:\s]/g, '').toLowerCase()) {
      throw unreachable(l10n(`${s.host}:${s.port} : le certificat ne correspond pas à l’empreinte épinglée`, `${s.host}:${s.port}: the certificate does not match the pinned fingerprint`));
    }
    if (s.tls === 'webpki' && !cert.webpkiValid) throw unreachable(l10n(`${s.host}:${s.port} : certificat non reconnu par les autorités (auto-signé ?) — épingle-le`, `${s.host}:${s.port}: certificate not recognized by the authorities (self-signed?) — pin it`));
  };

  const checkCoreAuth = (s: Extract<BtcServer, { kind: 'core' }>) => {
    if (s.auth.kind === 'cookie' && has(s.auth.cookiePath, 'missing')) throw invalid(l10n(`fichier .cookie illisible (${s.auth.cookiePath})`, `unreadable .cookie file (${s.auth.cookiePath})`));
    if (s.auth.kind === 'userpass') {
      if (!s.auth.password) throw invalid(l10n('mot de passe RPC manquant', 'RPC password missing'));
      if (s.auth.user === 'wrong' || s.auth.password === 'wrong') throw invalid(l10n('authentification RPC refusée par le nœud (HTTP 401)', 'RPC authentication refused by the node (HTTP 401)'));
    }
  };

  /** Live check of a Bitcoin server on `net` (btc_backend::probe). */
  const probeBtc = async (net: BtcNetworkKey, s: BtcServer): Promise<ServerTestResult['detected']> => {
    if (s.kind === 'default') return { network: net, genesisHash: BTC_GENESIS[net], blockHeight: d.chain.tipHeight };
    if (s.kind === 'cbf') {
      // Peers are checked at sync time (no server to probe): the intended Rust behaviour.
      if (!d.cbf.enabled) throw cbfDisabled();
      return { network: net, genesisHash: BTC_GENESIS[net] };
    }
    await gate(s.kind === 'core' && coreIsLocal(s.url));
    const text = scenarioText(s);
    if (has(text, 'down')) throw unreachable(l10n(`${s.kind === 'electrum' ? `${s.host}:${s.port}` : hostOfUrl(text)} : délai de connexion dépassé`, `${s.kind === 'electrum' ? `${s.host}:${s.port}` : hostOfUrl(text)}: connection timed out`));
    if (s.kind === 'electrum') checkElectrumCert(s);
    if (s.kind === 'core') checkCoreAuth(s);
    const other: BtcNetworkKey = net === 'mainnet' ? 'testnet4' : 'mainnet';
    if (has(text, 'wrong')) {
      throw wrongNet(s.kind === 'core' ? l10n(`le nœud est sur « ${other === 'mainnet' ? 'main' : 'testnet4'} », pas sur « ${net === 'mainnet' ? 'main' : 'testnet4'} »`, `the node is on “${other === 'mainnet' ? 'main' : 'testnet4'}”, not on “${net === 'mainnet' ? 'main' : 'testnet4'}”`) : l10n(`genesis de ${other} au lieu de ${net}`, `${other} genesis instead of ${net}`));
    }
    const out: ServerTestResult['detected'] = { network: net, genesisHash: BTC_GENESIS[net], blockHeight: d.chain.tipHeight };
    if (s.kind === 'electrum') out.serverVersion = l10n('ElectrumX 1.18.0 (démo)', 'ElectrumX 1.18.0 (demo)');
    if (s.kind === 'core') out.serverVersion = l10n('/Satoshi:28.1.0/ (démo)', '/Satoshi:28.1.0/ (demo)');
    return out;
  };

  const probeEvm = async (chainId: number, s: RpcServer): Promise<ServerTestResult['detected']> => {
    await gate();
    if (has(s.url, 'down')) throw unreachable(l10n(`${hostOfUrl(s.url)} : délai de connexion dépassé`, `${hostOfUrl(s.url)}: connection timed out`));
    if (has(s.url, 'wrong')) throw wrongNet(l10n(`chainId ${chainId === 1 ? 11155111 : 1} au lieu de ${chainId}`, `chainId ${chainId === 1 ? 11155111 : 1} instead of ${chainId}`));
    return { chainId };
  };

  const probeSol = async (cluster: SolanaCluster, s: RpcServer): Promise<ServerTestResult['detected']> => {
    await gate();
    if (has(s.url, 'down')) throw unreachable(l10n(`${hostOfUrl(s.url)} : délai de connexion dépassé`, `${hostOfUrl(s.url)}: connection timed out`));
    if (has(s.url, 'wrong')) throw wrongNet(l10n(`ce RPC est sur ${cluster === 'devnet' ? 'mainnet-beta' : 'devnet'}, pas sur ${cluster}`, `this RPC is on ${cluster === 'devnet' ? 'mainnet-beta' : 'devnet'}, not on ${cluster}`));
    return { network: cluster, genesisHash: SOL_GENESIS[cluster] };
  };

  /** Syntax validation of all servers (servers.rs `validate`), SERVER_INVALID prefixed by the slot. */
  const validate = (servers: Servers, tor: boolean) => {
    for (const key of ['mainnet', 'testnet4'] as const) {
      const s = servers.bitcoin[key];
      if (!s) continue;
      if (s.kind === 'cbf' && !d.cbf.enabled) throw cbfDisabled();
      const bad = checkBtcServer(s, tor) ?? (s.kind === 'core' && s.auth.kind === 'userpass' && !s.auth.password ? l10n('mot de passe RPC manquant', 'RPC password missing') : null);
      if (bad) throw invalid(l10n(`bitcoin ${key} : ${bad}`, `bitcoin ${key}: ${bad}`));
    }
    for (const [chain, s] of Object.entries(servers.evm)) {
      if (!/^[1-9]\d*$/.test(chain)) throw invalid(l10n(`evm : chainId invalide « ${chain} »`, `evm: invalid chainId “${chain}”`));
      const bad = checkServerUrl(s.url, tor);
      if (bad) throw invalid(l10n(`evm ${chain} : ${bad}`, `evm ${chain}: ${bad}`));
    }
    for (const [cluster, s] of Object.entries(servers.solana)) {
      if (cluster !== 'devnet' && cluster !== 'mainnet-beta') throw invalid(l10n(`solana : cluster inconnu « ${cluster} » (devnet ou mainnet-beta)`, `solana: unknown cluster “${cluster}” (devnet or mainnet-beta)`));
      const bad = s ? checkServerUrl(s.url, tor) : null;
      if (bad) throw invalid(l10n(`solana ${cluster} : ${bad}`, `solana ${cluster}: ${bad}`));
    }
    d.utxo.validate(servers, tor);
    d.tron.validate(servers, tor);
    d.xrp.validate(servers, tor);
    d.cardano.validate(servers, tor);
  };

  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

  /** `settings_set` server part: merge secrets, validate, live-check what changed. Returns the servers to store. */
  const prepareSave = async (next: Servers, stored: Servers, tor: boolean): Promise<Servers> => {
    const merged = mergeServerSecrets(next, stored);
    validate(merged, tor);
    for (const key of ['mainnet', 'testnet4'] as const) {
      const s = merged.bitcoin[key];
      if (s && s.kind !== 'default' && !same(s, stored.bitcoin[key])) await probeBtc(key, s);
    }
    for (const [chain, s] of Object.entries(merged.evm)) if (!same(s, stored.evm[chain])) await probeEvm(Number(chain), s);
    for (const cluster of ['devnet', 'mainnet-beta'] as const) {
      const s = merged.solana[cluster];
      if (s && !same(s, stored.solana[cluster])) await probeSol(cluster, s);
    }
    for (const [coin, key] of [['ltc', 'litecoin'], ['doge', 'dogecoin'], ['bch', 'bitcoincash'], ['dash', 'dash']] as const) {
      for (const nk of ['mainnet', 'testnet'] as const) {
        const s = merged[key]?.[nk];
        if (s && s.kind !== 'default' && !same(s, stored[key]?.[nk])) await d.utxo.probe(coin, nk, s);
      }
    }
    for (const nk of ['mainnet', 'testnet'] as const) {
      const s = merged.tron?.[nk];
      if (s && s.kind !== 'default' && !same(s, stored.tron?.[nk])) await d.tron.probe(nk, s);
      const x = merged.xrp?.[nk];
      if (x && x.kind !== 'default' && !same(x, stored.xrp?.[nk])) await d.xrp.probe(nk, x);
      const c = merged.cardano?.[nk];
      if (c && c.kind !== 'default' && !same(c, stored.cardano?.[nk])) await d.cardano.probe(nk, c);
    }
    return merged;
  };

  const serverTest = async (target: ServerTestTarget): Promise<ServerTestResult> => {
    const tor = torOn();
    const t0 = Date.now();
    let detected: ServerTestResult['detected'];
    if (target.family === 'bitcoin') {
      if (target.network !== 'mainnet' && target.network !== 'testnet4') throw invalid(l10n(`réseau Bitcoin inconnu « ${String(target.network)} » (mainnet ou testnet4)`, `unknown Bitcoin network “${String(target.network)}” (mainnet or testnet4)`));
      const probe: Servers = { ...EMPTY_SERVERS, bitcoin: { [target.network]: target.server } };
      const merged = mergeServerSecrets(probe, d.settings().servers);
      validate(merged, tor);
      detected = await probeBtc(target.network, merged.bitcoin[target.network] ?? { kind: 'default' });
    } else if (target.family === 'litecoin' || target.family === 'dogecoin' || target.family === 'bitcoincash' || target.family === 'dash') {
      if (target.server.kind === 'esplora') {
        const bad = checkServerUrl(target.server.url, tor);
        if (bad) throw invalid(l10n(`${target.family} ${target.network} : ${bad}`, `${target.family} ${target.network}: ${bad}`));
      }
      const coin = ({ litecoin: 'ltc', dogecoin: 'doge', bitcoincash: 'bch', dash: 'dash' } as const)[target.family];
      detected = await d.utxo.probe(coin, target.network, target.server);
    } else if (target.family === 'tron') {
      detected = await d.tron.probe(target.network, target.server);
    } else if (target.family === 'xrp') {
      detected = await d.xrp.probe(target.network, target.server);
    } else if (target.family === 'cardano') {
      detected = await d.cardano.probe(target.network, target.server);
    } else if (target.family === 'evm') {
      validate({ ...EMPTY_SERVERS, evm: { [String(target.chainId)]: target.server } }, tor);
      detected = await probeEvm(target.chainId, target.server);
    } else {
      validate({ ...EMPTY_SERVERS, solana: { [target.cluster]: target.server } }, tor);
      detected = await probeSol(target.cluster, target.server);
    }
    return { latencyMs: Math.max(1, Date.now() - t0), detected };
  };

  const electrumFetchCert = async (host: unknown, port: unknown): Promise<ElectrumCertInfo> => {
    const h = String(host ?? '').trim();
    const p = Number(port);
    if (!h || /[/@\s]/.test(h) || !Number.isInteger(p) || p < 1 || p > 65535) throw invalid(l10n('hôte ou port Electrum invalide', 'invalid Electrum host or port'));
    if (isOnion(h) && !torOn()) throw invalid(l10n('adresse .onion : exige Tor activé', '.onion address: requires Tor enabled'));
    await gate();
    if (has(h, 'down')) throw unreachable(l10n(`${h}:${p} : délai de connexion dépassé`, `${h}:${p}: connection timed out`));
    return demoElectrumCert(h, p);
  };

  // ------------------------------------------------------------ Bitcoin data (Esplora shapes)

  const current = (): BtcServer => bitcoinServerFor(d.settings().servers, d.network);

  /** Gate + checks of the active backend before a read or a broadcast. */
  const backend = async (): Promise<BtcServer> => {
    const s = current();
    if (s.kind === 'default') {
      await gate();
      return s;
    }
    if (s.kind === 'cbf') {
      // Answered from the local store, never a network request during the call.
      if (!d.cbf.enabled) throw cbfDisabled();
      d.cbf.refreshIfStale();
      if (!d.cbf.synced()) throw unreachable(l10n('filtres compacts : pas encore synchronisé (synchronisation en cours)', 'compact filters: not synced yet (sync in progress)'));
      await wait(20);
      return s;
    }
    await gate(s.kind === 'core' && coreIsLocal(s.url));
    const text = scenarioText(s);
    if (downLater(text)) throw unreachable(l10n(`${s.kind === 'electrum' ? `${s.host}:${s.port}` : hostOfUrl(text)} : délai de connexion dépassé`, `${s.kind === 'electrum' ? `${s.host}:${s.port}` : hostOfUrl(text)}: connection timed out`));
    if (s.kind === 'electrum') checkElectrumCert(s);
    if (s.kind === 'core') {
      checkCoreAuth(s);
      if (!wallets.has(s.url)) throw invalid(l10n(`portefeuille de surveillance « ${walletName} » absent sur le nœud : lance la configuration (btc_core_setup)`, `watch-only wallet “${walletName}” missing on the node: run the setup (btc_core_setup)`));
    }
    return s;
  };

  const checkAddress = (a: unknown): string => {
    const addr = String(a ?? '');
    try {
      bitcoin.address.toOutputScript(addr, d.network === 'testnet' ? bitcoin.networks.testnet : bitcoin.networks.bitcoin);
    } catch {
      throw new IpcError('INVALID_INPUT', l10n(`Entrée invalide : adresse Bitcoin invalide pour ce réseau « ${addr} »`, `Invalid input: invalid Bitcoin address for this network “${addr}”`));
    }
    return addr;
  };

  const btc = {
    async addressInfo(a: unknown) {
      const addr = checkAddress(a);
      await backend();
      return demoEsploraAddress(d.chain, addr);
    },
    async addressUtxos(a: unknown) {
      const addr = checkAddress(a);
      await backend();
      return demoEsploraUtxos(d.chain, addr);
    },
    async addressTxs(a: unknown) {
      const addr = checkAddress(a);
      const s = await backend();
      const txs = demoEsploraTxs(d.chain, addr);
      // Core only knows wallet transactions: inputs from outside the wallet have no prevout.
      return s.kind === 'core' ? txs.map(({ fee: _fee, ...t }) => ({ ...t, vin: t.vin.map((i) => ({ ...i, prevout: null })) })) : txs;
    },
    async feeRates() {
      const s = await backend();
      // CBF: no mempool, average of the fees paid in the last blocks.
      return s.kind === 'cbf' ? { fastestFee: 8, halfHourFee: 5, hourFee: 3, economyFee: 1, minimumFee: 1, source: 'block-average' as const } : { ...DEMO_FEE_RATES };
    },
    async tipHeight() {
      await backend();
      return d.chain.tipHeight;
    },
    /** Raw transaction, as Rust returns it after checking its txid. */
    async txHex(txid: unknown) {
      const t = String(txid ?? '');
      if (!/^[0-9a-f]{64}$/.test(t)) throw new IpcError('INVALID_INPUT', l10n('Entrée invalide : txid : 64 caractères hexadécimaux attendus', 'Invalid input: txid: 64 hexadecimal characters expected'));
      await backend();
      const hex = d.chain.rawTx.get(t);
      if (!hex) throw new IpcError('INVALID_INPUT', l10n(`Entrée invalide : transaction ${t.slice(0, 10)}… inconnue du serveur`, `Invalid input: transaction ${t.slice(0, 10)}… unknown to the server`));
      return hex;
    },
    async broadcast(hex: unknown) {
      const raw = String(hex ?? '').trim();
      let txid: string;
      try {
        txid = bitcoin.Transaction.fromHex(raw).getId();
      } catch {
        throw new IpcError('INVALID_INPUT', l10n('Entrée invalide : transaction hexadécimale invalide', 'Invalid input: invalid hexadecimal transaction'));
      }
      await backend();
      return txid;
    },
    info() {
      const s = current();
      const label = s.kind === 'default' ? 'mempool.space' : s.kind === 'cbf' ? l10n('P2P (filtres compacts)', 'P2P (compact filters)') : s.kind === 'electrum' ? `${s.host}:${s.port}` : hostOfUrl(s.url);
      return { kind: s.kind, network: btcNetworkKey(d.network), label, tor: torOn() };
    },
  };

  // ------------------------------------------------------------ Bitcoin Core watch-only wallet

  const coreServer = (): Extract<BtcServer, { kind: 'core' }> => {
    const s = current();
    if (s.kind !== 'core') throw new IpcError('INVALID_INPUT', l10n('Entrée invalide : aucun nœud Bitcoin Core n’est configuré pour ce réseau', 'Invalid input: no Bitcoin Core node is configured for this network'));
    return s;
  };

  const coreStatus = async (): Promise<CoreStatus> => {
    const cur = current();
    // No Core server for this network: a normal answer, not an error.
    if (cur.kind !== 'core') return { wallet: '', state: 'not-configured', walletLoaded: false };
    const s = cur;
    d.requireUnlocked();
    await gate(coreIsLocal(s.url));
    if (has(s.url, 'down')) throw unreachable(l10n(`${hostOfUrl(s.url)} : délai de connexion dépassé`, `${hostOfUrl(s.url)}: connection timed out`));
    checkCoreAuth(s);
    const loaded = wallets.has(s.url);
    const st: CoreStatus = { wallet: walletName, state: loaded ? 'ready' : 'idle', walletLoaded: loaded };
    if (job && job.url === s.url) {
      const elapsed = Date.now() - job.started;
      if (job.state === 'importing' && elapsed >= IMPORT_MS + job.rescanMs) job.state = 'ready';
      st.state = job.state;
      if (job.error) st.error = job.error;
      if (job.state === 'importing' && job.rescanMs > 0 && elapsed >= IMPORT_MS) {
        st.scanProgress = Math.min(0.999, (elapsed - IMPORT_MS) / job.rescanMs);
        st.scanDurationSecs = Math.floor((elapsed - IMPORT_MS) / 1000);
      }
    }
    return st;
  };

  const coreSetup = async (rescanFrom: unknown): Promise<CoreStatus> => {
    const s = coreServer();
    d.requireUnlocked();
    if (rescanFrom !== 'now' && !(typeof rescanFrom === 'number' && Number.isInteger(rescanFrom) && rescanFrom >= 0)) {
      throw new IpcError('INVALID_INPUT', l10n(`Entrée invalide : rescanFrom : « now » ou un horodatage UNIX attendu (reçu « ${String(rescanFrom)} »)`, `Invalid input: rescanFrom: “now” or a UNIX timestamp expected (got “${String(rescanFrom)}”)`));
    }
    // Synchronous pre-flight, like Rust: reachable, auth, chain, watch wallet. Only the import runs in the background.
    await gate(coreIsLocal(s.url));
    if (downLater(s.url)) throw unreachable(l10n(`${hostOfUrl(s.url)} : délai de connexion dépassé`, `${hostOfUrl(s.url)}: connection timed out`));
    checkCoreAuth(s);
    if (has(s.url, 'wrong')) throw wrongNet(l10n('le nœud n’est pas sur le réseau de l’app', 'the node is not on the app’s network'));
    wallets.add(s.url);
    job = { url: s.url, state: 'importing', started: Date.now(), rescanMs: (rescanFrom as CoreRescanFrom) === 'now' ? 0 : DEMO_RESCAN_MS };
    return { wallet: walletName, state: 'importing', walletLoaded: false };
  };

  // ------------------------------------------------------------ net_fetch routing

  /** Custom-server policy of `net_fetch`: replaced defaults refused, custom hosts served (or down). */
  const routeNet = (req: NetRequest): DemoRoute | undefined => {
    const host = hostOfUrl(req.url);
    const servers = d.settings().servers;
    const disabled = (what: string) => new IpcError('DEFAULT_SERVER_DISABLED', l10n(`Serveur par défaut désactivé : ${what} (un serveur personnalisé est configuré pour cette chaîne)`, `Default server disabled: ${what} (a custom server is configured for this chain)`));
    const btcSrv = bitcoinServerFor(servers, d.network);
    if (host === 'mempool.space' && btcSrv.kind !== 'default') throw disabled(host);
    for (const [chain, s] of Object.entries(servers.evm)) {
      if (EVM_DEFAULT_HOST.get(Number(chain)) === host) throw disabled(host);
      if (hostOfUrl(s.url) === host) {
        if (downLater(s.url)) throw unreachable(l10n(`${host} : délai de connexion dépassé`, `${host}: connection timed out`));
        return { kind: 'evm', chainId: Number(chain) };
      }
    }
    for (const cluster of ['devnet', 'mainnet-beta'] as const) {
      const s = servers.solana[cluster];
      if (!s) continue;
      if (SOL_DEFAULT_HOST[cluster] === host) throw disabled(host);
      if (hostOfUrl(s.url) === host) {
        if (downLater(s.url)) throw unreachable(l10n(`${host} : délai de connexion dépassé`, `${host}: connection timed out`));
        return { kind: 'sol' };
      }
    }
    if (btcSrv.kind === 'esplora' && hostOfUrl(btcSrv.url) === host) {
      if (downLater(btcSrv.url)) throw unreachable(l10n(`${host} : délai de connexion dépassé`, `${host}: connection timed out`));
      return { kind: 'esplora' };
    }
    return undefined;
  };

  const netFetch = (req: NetRequest): Promise<NetResponse> => handleDemoNet(req, d.chain, routeNet(req));

  return { prepareSave, serverTest, electrumFetchCert, btc, coreSetup, coreStatus, netFetch, cbf: d.cbf, solanaCluster: () => solanaCluster(d.network) };
}
