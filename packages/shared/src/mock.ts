// SPDX-License-Identifier: GPL-3.0-or-later
//
// MODE DÉMO — in-memory backend used automatically when the UI runs outside
// Tauri (plain `vite` in a browser, unit tests). It emulates every command of
// docs/IPC.md with a fake vault and fake chains, so all screens are demoable.
//
// ⚠ The demo "keys" come from a hard-coded, public seed. They protect nothing
// and are never used by the real application, which derives and signs in Rust.

import { HDKey } from '@scure/bip32';
import { generateMnemonic, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { base58, base64 } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from '@bitcoinerlab/secp256k1';
import {
  API_KEY_NAMES,
  IpcError,
  type Accounts,
  type ApiKeyName,
  type AppConfig,
  type BtcKind,
  type BtcTxSummary,
  type Commands,
  type EvmTxRequest,
  type EvmTxSummary,
  type Network,
  type NetworkSource,
  type Settings,
  type SettingsInput,
  type VaultStatus,
} from './ipc';
import { emitDemoEvent } from './events';
import { createDemoServers } from './mock-servers';
import { createDemoCbf, detectDemoCbf } from './mock-cbf';
import { createDemoUtxo, demoUtxoAccount, demoUtxoScript, DEMO_DASH_NETWORKS, DEMO_DOGE_NETWORKS, DEMO_LTC_NETWORKS } from './mock-utxo';
import { createDemoTron, demoTronAddress, type DemoTronState } from './mock-tron';
export { demoTronAddress } from './mock-tron';
import { createDemoXrp, demoXrpAddress, type DemoXrpState } from './mock-xrp';
import { createDemoSui, demoSuiAddress, type DemoSuiState } from './mock-sui';
export { demoSuiAddress, suiAddressOf } from './mock-sui';
import { createDemoHbar, demoHbarAddress, type DemoHbarState } from './mock-hbar';
import { createDemoTon, demoTonAddress, type DemoTonState } from './mock-ton';
export { demoTonAddress } from './mock-ton';
export { demoXrpAddress, xrpAddressOfId } from './mock-xrp';
import { createDemoStellar, demoStellarAddress, type DemoStellarState } from './mock-stellar';
export { demoStellarAddress } from './mock-stellar';
import { createDemoNear, demoNearAddress, type DemoNearState } from './mock-near';
export { demoNearAddress } from './mock-near';
export { demoHbarAddress, hbarChecksum, parseHbarRecipient } from './mock-hbar';
import { createDemoAlgo, demoAlgoAddress, type DemoAlgoState } from './mock-algo';
export { algoAddressOf, demoAlgoAddress } from './mock-algo';
import { createDemoCardano, demoCardanoAddress, type DemoCardanoState } from './mock-cardano';
export { cardanoAddressOf, demoCardanoAddress } from './mock-cardano';
import { createDemoKaspa, demoKaspaAddress, type DemoKaspaState } from './mock-kaspa';
export { demoKaspaAddress, demoKaspaMass } from './mock-kaspa';
import { createDemoDot, demoDotAddress, type DemoDotState } from './mock-dot';
export { demoDotAddress, dotSs58Decode, dotSs58Encode } from './mock-dot';
import { createDemoXmr, demoXmrAddress, type DemoXmrState } from './mock-xmr';
export { checkXmrAddress, demoXmrAddress, demoXmrIntegrated, xmrText } from './mock-xmr';
import { demoFund } from './mock-tx';
import { createDemoHw, detectDemoHwScenario, type DemoHw, type DemoHwScenario } from './mock-hw';
import { EMPTY_SERVERS, redactServers } from './servers';
import { createDemoTor, detectDemoTorDisabled, detectDemoTorScenario, type DemoTor, type DemoTorScenario } from './mock-tor';
export { DEMO_TOR_BOOTSTRAP_MS, type DemoTor, type DemoTorScenario } from './mock-tor';
export { DEMO_RESCAN_MS, demoElectrumCert } from './mock-servers';
export { DEMO_HW_DELAYS, DEMO_TREZOR_LAYOUT, DEMO_TREZOR_PIN, TREZOR_KEYPAD, demoDecodePin, demoThpCode, type DemoHwScenario } from './mock-hw';
export { DEMO_CBF_CONNECT_MS, DEMO_CBF_FILTERS_MS, DEMO_CBF_HEADERS_MS } from './mock-cbf';
import { demoHash, handleDemoNet, type DemoChainState } from './mock-net';
import { btcWarnings, evmWarnings } from './warnings';
import { l10n, navigatorLang, type Lang } from './i18n';
import { demoRenderScript, demoVsize } from './mock-tx';
import { demoDecodeSolMessage, demoSolSummaryText } from './mock-sol';
import { createDemoStake } from './mock-stake';
import { createDemoAccounts } from './mock-accounts';
import { createDemoNetwork, demoNetworkParam, demoNetworkStore, resolveDemoNetwork, type DemoNetworkStore } from './mock-network';
export { DEMO_DEFAULT_NETWORK, DEMO_NETWORK_STORAGE_KEY, resolveDemoNetwork, type DemoNetworkStore } from './mock-network';
export { ACCOUNT_CHAIN_LABEL, defaultAccountName } from './mock-accounts';

bitcoin.initEccLib(ecc);

export const demoPasswordHint = (): string => l10n('Mode démo : n’importe quel mot de passe de 8 caractères ou plus.', 'Demo mode: any password of 8 characters or more.');

/** Demo address-poisoning scenario (Sepolia): the colleague paid before, and its look-alike. */
export const DEMO_EVM_COLLEAGUE = '0x5e1f9b3c8a2d47e6b0c19f4a7d23e8c6b5a2d4c7';
export const DEMO_EVM_LOOKALIKE = '0x5e1f00aa77ee11bb33cc99dd22ff44889a13d4c7';

/** Demo « system language »: `?lang=fr|en` in the URL (to try both), else the browser's. */
export function demoSystemLanguage(): Lang {
  const param = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('lang');
  return param === 'fr' || param === 'en' ? param : navigatorLang();
}

export const DEFAULT_SETTINGS: Settings = {
  currency: 'EUR',
  autoLockSecs: 900,
  hideBalancesOnStart: false,
  captureProtection: true,
  clipboardGuard: true,
  servers: EMPTY_SERVERS,
  apiKeysSet: {},
  tor: { enabled: true },
  language: 'auto',
};

const TESTNET_VERSIONS = { private: 0x04358394, public: 0x043587cf };
const MAX_UINT256 = (1n << 256n) - 1n;

interface DemoKeys {
  accounts: Accounts;
  /** Every address we own (receive + change, both kinds), for change detection. */
  ownBtc: Set<string>;
  receive: Record<BtcKind, HDKey>;
  /** Litecoin / Dogecoin / Bitcoin Cash / Dash account nodes. */
  utxo: { ltc: HDKey; doge: HDKey; bch: HDKey; dash: HDKey };
}

function demoSeed(): Uint8Array {
  const a = sha256(new TextEncoder().encode('kyro-demo-seed-public-do-not-use'));
  const out = new Uint8Array(64);
  out.set(a, 0);
  out.set(sha256(a), 32);
  return out;
}

function toChecksumAddress(addrHexNo0x: string): string {
  const lower = addrHexNo0x.toLowerCase();
  const hash = bytesToHex(keccak_256(new TextEncoder().encode(lower)));
  let out = '0x';
  for (let i = 0; i < lower.length; i++) {
    const c = lower[i] ?? '';
    out += parseInt(hash[i] ?? '0', 16) >= 8 ? c.toUpperCase() : c;
  }
  return out;
}

function btcAddressFor(kind: BtcKind, pubkey: Uint8Array, net: bitcoin.Network): string {
  const p = kind === 'segwit' ? bitcoin.payments.p2wpkh({ pubkey, network: net }) : bitcoin.payments.p2tr({ internalPubkey: pubkey.slice(1, 33), network: net });
  if (!p.address) throw new IpcError('INTERNAL', l10n('Adresse démo introuvable', 'Demo address not found'));
  return p.address;
}

export function deriveDemoKeys(network: Network): DemoKeys {
  const testnet = network === 'testnet';
  const master = HDKey.fromMasterSeed(demoSeed(), testnet ? TESTNET_VERSIONS : undefined);
  const net = testnet ? bitcoin.networks.testnet : bitcoin.networks.bitcoin;
  const coin = testnet ? 1 : 0;
  const fingerprint = master.fingerprint.toString(16).padStart(8, '0');
  const ownBtc = new Set<string>();
  const receive = {} as Record<BtcKind, HDKey>;
  const info = (kind: BtcKind) => {
    const purpose = kind === 'segwit' ? 84 : 86;
    const path = `m/${purpose}'/${coin}'/0'`;
    const acct = master.derive(path);
    for (const change of [0, 1]) {
      const branch = acct.deriveChild(change);
      for (let i = 0; i < 20; i++) {
        const pk = branch.deriveChild(i).publicKey;
        if (pk) ownBtc.add(btcAddressFor(kind, pk, net));
      }
    }
    receive[kind] = acct.deriveChild(0);
    const first = acct.deriveChild(0).deriveChild(0).publicKey;
    if (!first) throw new IpcError('INTERNAL', l10n('Clé démo introuvable', 'Demo key not found'));
    return { address: btcAddressFor(kind, first, net), xpub: acct.publicExtendedKey, fingerprint, path };
  };
  const evmKey = master.derive("m/44'/60'/0'/0/0").publicKey;
  if (!evmKey) throw new IpcError('INTERNAL', l10n('Clé démo introuvable', 'Demo key not found'));
  const uncompressed = ecc.pointCompress(evmKey, false);
  const evmAddr = toChecksumAddress(bytesToHex(keccak_256(uncompressed.slice(1))).slice(-40));
  const solAddr = base58.encode(sha256(new TextEncoder().encode('kyro-demo-solana-account')));
  const ltc = demoUtxoAccount(demoSeed(), network, 'ltc');
  const doge = demoUtxoAccount(demoSeed(), network, 'doge');
  const bch = demoUtxoAccount(demoSeed(), network, 'bch');
  const dash = demoUtxoAccount(demoSeed(), network, 'dash');
  return {
    utxo: { ltc: ltc.node, doge: doge.node, bch: bch.node, dash: dash.node },
    accounts: {
      network,
      account: 0,
      btc: { segwit: info('segwit'), taproot: info('taproot') },
      evm: { address: evmAddr, path: "m/44'/60'/0'/0/0" },
      sol: { address: solAddr, path: "m/44'/501'/0'/0'" },
      ltc: ltc.info,
      doge: doge.info,
      bch: bch.info,
      dash: dash.info,
      tron: { address: demoTronAddress(demoSeed(), 0), path: "m/44'/195'/0'/0/0" },
      xrp: { address: demoXrpAddress(demoSeed(), 0), path: "m/44'/144'/0'/0/0" },
      stellar: { address: demoStellarAddress(demoSeed(), 0), path: "m/44'/148'/0'" },
      cardano: { address: demoCardanoAddress(network), path: "m/1852'/1815'/0'/0/0" },
      near: { address: demoNearAddress(0), path: "m/44'/397'/0'" },
      sui: { address: demoSuiAddress(0), path: "m/44'/784'/0'/0'/0'" },
      hbar: { address: demoHbarAddress(demoSeed(), 0), path: "m/44'/3030'/0'/0/0" },
      kas: { address: demoKaspaAddress(demoSeed(), network, 0), path: "m/44'/111111'/0'/0/0" },
      polkadot: { address: demoDotAddress(demoSeed(), 0, network), path: 'sr25519 · phrase (compte racine, comme Polkadot.js)' },
      algo: { address: demoAlgoAddress(0), path: "m/44'/283'/0'/0/0" },
      xmr: { address: demoXmrAddress(network, 0), path: "m/44'/128'/0'/0/0" },
      ton: { address: demoTonAddress(0, network), path: "m/44'/607'/0'" },
    },
    ownBtc,
    receive,
  };
}

function seedChainState(keys: DemoKeys, network: Network): DemoChainState {
  const a = keys.accounts;
  const me = a.evm.address.toLowerCase();
  const testnet = network === 'testnet';
  const net = testnet ? bitcoin.networks.testnet : bitcoin.networks.bitcoin;
  const addrAt = (kind: BtcKind, i: number) => {
    const pk = keys.receive[kind].deriveChild(i).publicKey;
    return pk ? btcAddressFor(kind, pk, net) : '';
  };
  const tip = testnet ? 98_430 : 871_402;
  // Every demo UTXO comes from a real funding transaction (raw hex kept for *_tx_hex).
  const rawTx = new Map<string, string>();
  const btcUtxos = new Map<string, Array<{ txid: string; vout: number; value: number; height: number }>>();
  demoFund(btcUtxos, rawTx, a.btc.segwit.address, net, 'u1', 4_120_000, tip - 1_200);
  demoFund(btcUtxos, rawTx, a.btc.segwit.address, net, 'u2', 890_000, tip - 300);
  demoFund(btcUtxos, rawTx, addrAt('segwit', 1), net, 'u3', 210_000, tip - 40);
  demoFund(btcUtxos, rawTx, a.btc.taproot.address, net, 'u4', 350_000, tip - 12);
  const ltcTip = testnet ? 121_640 : 2_905_118;
  const dogeTip = testnet ? 6_120_448 : 5_471_902;
  const ltcUtxos = new Map<string, Array<{ txid: string; vout: number; value: number; height: number }>>();
  const dogeUtxos = new Map<string, Array<{ txid: string; vout: number; value: number; height: number }>>();
  demoFund(ltcUtxos, rawTx, a.ltc.address, DEMO_LTC_NETWORKS[network], 'l1', 125_000_000, ltcTip - 900);
  demoFund(ltcUtxos, rawTx, a.ltc.address, DEMO_LTC_NETWORKS[network], 'l2', 30_500_000, ltcTip - 120);
  demoFund(dogeUtxos, rawTx, a.doge.address, DEMO_DOGE_NETWORKS[network], 'd1', 420_000_000_000, dogeTip - 4_000);
  demoFund(dogeUtxos, rawTx, a.doge.address, DEMO_DOGE_NETWORKS[network], 'd2', 150_000_000, dogeTip - 60);
  const bchTip = testnet ? 330_200 : 975_400;
  const dashTip = testnet ? 1_250_300 : 2_564_800;
  const bchUtxos = new Map<string, Array<{ txid: string; vout: number; value: number; height: number }>>();
  const dashUtxos = new Map<string, Array<{ txid: string; vout: number; value: number; height: number }>>();
  demoFund(bchUtxos, rawTx, a.bch.address, demoUtxoScript('bch', network, a.bch.address), 'b1', 84_000_000, bchTip - 700);
  demoFund(bchUtxos, rawTx, a.bch.address, demoUtxoScript('bch', network, a.bch.address), 'b2', 6_250_000, bchTip - 30);
  demoFund(dashUtxos, rawTx, a.dash.address, DEMO_DASH_NETWORKS[network], 'x1', 312_000_000, dashTip - 2_000);
  demoFund(dashUtxos, rawTx, a.dash.address, DEMO_DASH_NETWORKS[network], 'x2', 45_000_000, dashTip - 90);
  const evmNative = new Map<string, bigint>();
  const evmTokens = new Map<string, bigint>();
  if (testnet) {
    evmNative.set(`11155111:${me}`, 842_100_000_000_000_000n);
    evmTokens.set(`11155111:0x1c7d4b196cb0c7b01d743fbc6116a902379c7238:${me}`, 250_500_000n);
  } else {
    evmNative.set(`1:${me}`, 842_100_000_000_000_000n);
    evmNative.set(`42161:${me}`, 120_000_000_000_000_000n);
    evmTokens.set(`1:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48:${me}`, 250_500_000n);
    evmTokens.set(`42161:0x912ce59144191c1204e64559fe8253a0e49e6548:${me}`, 150_000_000_000_000_000_000n);
  }
  const usdcMint = testnet ? '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' : 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  return {
    network,
    accounts: a,
    tipHeight: tip,
    btcUtxos,
    rawTx,
    ltcUtxos,
    dogeUtxos,
    ltcTip,
    dogeTip,
    bchUtxos,
    dashUtxos,
    bchTip,
    dashTip,
    evmNative,
    evmTokens,
    allowances: new Map(),
    nonces: new Map(),
    signedEvm: new Map(),
    minedEvm: new Map(),
    evmLogs: testnet
      ? [
          // Address-poisoning demo: a real USDC payment to a colleague, then a zero-value
          // « transfer » from an address forged to share its first and last characters.
          { chainId: 11155111, token: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', from: me, to: DEMO_EVM_COLLEAGUE, value: 25_000_000n, blocksAgo: 3_600, txHash: '0x' + demoHash('evm-log-colleague') },
          { chainId: 11155111, token: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', from: DEMO_EVM_LOOKALIKE, to: me, value: 0n, blocksAgo: 400, txHash: '0x' + demoHash('evm-log-poison') },
          // The same attacker's free « outgoing » lure: transferFrom(you, look-alike, 0), sent by
          // the attacker. The log says « from you »; the transaction was not signed by you.
          { chainId: 11155111, token: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', from: me, to: DEMO_EVM_LOOKALIKE, value: 0n, blocksAgo: 390, txHash: '0x' + demoHash('evm-log-poison-out'), sender: DEMO_EVM_LOOKALIKE },
        ]
      : [],
    solLamports: 3_200_000_000n,
    solTokens: new Map([[usdcMint, 42_000_000n]]),
  };
}

function fakeDerSignature(seed: string): Uint8Array {
  // Canonical-looking DER (r, s < 2^255) + SIGHASH_ALL. Not a valid signature.
  const r = sha256(new TextEncoder().encode(`r:${seed}`));
  const s = sha256(new TextEncoder().encode(`s:${seed}`));
  r[0] = (r[0] ?? 0) & 0x3f | 0x01;
  s[0] = (s[0] ?? 0) & 0x3f | 0x01;
  return new Uint8Array([0x30, 0x44, 0x02, 0x20, ...r, 0x02, 0x20, ...s, 0x01]);
}

export interface MockOptions {
  /** Running network. Default: `?network=` (forced, like KYRO_NETWORK), else the saved choice, else testnet. */
  network?: Network;
  /** With `network`: where it comes from (default `'default'`; `'env'` refuses `network_set`). */
  networkSource?: NetworkSource;
  /** Saved network choice (default: localStorage, in memory without storage). */
  networkStore?: DemoNetworkStore;
  /** Called by `network_set` instead of reloading the page (tests). */
  onNetworkRestart?: (n: Network) => void;
  /** Emulates the native confirmation dialog. Default: `window.confirm` when available, else accept. */
  confirm?: (summary: string) => boolean;
  /** Start with an existing vault (tests). */
  preset?: { password: string; words?: string[]; unlocked?: boolean };
  /** Simulated Tor (see mock-tor.ts). Default: `?tor=…` in a browser, `ready` without `window`. */
  tor?: DemoTorScenario;
  /** Initial `settings.tor.enabled`. Default: true (`?tor=off` → false). */
  torEnabled?: boolean;
  /** Compact filters available (cargo feature `cbf`). Default: false, like today's build (`?cbf=on` → true). */
  cbf?: boolean;
  /** Simulated hardware wallet (see mock-hw.ts). Default: `?hw=…`, else none plugged in. */
  hw?: DemoHwScenario;
}

export interface MockBackend {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  /** Exposed for tests. */
  chain: DemoChainState;
  /** Advance the fake clock (tests). */
  advance(ms: number): void;
  /** Simulated hardware wallet (tests). */
  hw: DemoHw;
  /** Simulated Tor (tests). */
  tor: DemoTor;
  /** TRON demo chain (tests). */
  tron: DemoTronState;
  /** XRP Ledger demo chain (tests). */
  xrp: DemoXrpState;
  /** Stellar demo chain (tests). */
  stellar: DemoStellarState;
  /** NEAR demo chain (tests). */
  near: DemoNearState;
  /** Sui demo chain (tests). */
  sui: DemoSuiState;
  /** Hedera demo chain (tests). */
  hbar: DemoHbarState;
  /** TON demo chain (tests). */
  ton: DemoTonState;
  /** Cardano demo chain (tests). */
  cardano: DemoCardanoState;
  /** Kaspa demo chain (tests). */
  kaspa: DemoKaspaState;
  /** Polkadot Asset Hub demo chain (tests). */
  dot: DemoDotState;
  /** Algorand demo chain (tests). */
  algo: DemoAlgoState;
  /** Monero demo chain (tests). */
  xmr: DemoXmrState;
  /** Staking demo (tests). */
  stake: ReturnType<typeof createDemoStake>;
}

export function createMockBackend(opts: MockOptions = {}): MockBackend {
  // Network choice (§2.10): same precedence as the shell (`?network=` = KYRO_NETWORK).
  const networkStore = opts.networkStore ?? demoNetworkStore();
  const resolved = opts.network ? { network: opts.network, source: opts.networkSource ?? ('default' as const) } : resolveDemoNetwork(demoNetworkParam(), networkStore.get());
  const network: Network = resolved.network;
  const keys = deriveDemoKeys(network);
  const chain = seedChainState(keys, network);
  let clockOffset = 0;
  const now = () => Date.now() + clockOffset;

  let vault: { password: string; words: string[] } | null = opts.preset
    ? { password: opts.preset.password, words: opts.preset.words ?? generateMnemonic(wordlist, 256).split(' ') }
    : null;
  let unlocked = opts.preset?.unlocked ?? false;
  let lastTouch = now();
  let failed = 0;
  let blockedUntil = 0;
  let reveals: number[] = [];
  /** Phrase of the vault just created, until the 3-word check passes (commands.rs PendingBackup). */
  let pendingBackup: { words: string[]; checks: [number, number, number]; failures: number } | null = null;
  const randomChecks = (n: number): [number, number, number] => {
    const out = new Set<number>();
    const buf = new Uint32Array(1);
    while (out.size < 3) {
      crypto.getRandomValues(buf);
      out.add((buf[0] ?? 0) % n);
    }
    const [a = 0, b = 1, c = 2] = [...out].sort((x, y) => x - y);
    return [a, b, c];
  };
  /** Custom server `host:port` approved in the (simulated) native dialog (server_approval.rs). */
  const approvedHosts = new Set<string>();
  /** `.cookie` chosen with the (simulated) native picker. */
  let pickedCookie: string | null = null;
  let settings: Settings = structuredClone(DEFAULT_SETTINGS);
  /** API key values: write-only, never returned (settings_get / settings_set give `apiKeysSet`). */
  let apiKeys: Partial<Record<ApiKeyName, string>> = {};
  const publicSettings = (): Settings => ({
    ...structuredClone(settings),
    servers: redactServers(settings.servers),
    apiKeysSet: Object.fromEntries(API_KEY_NAMES.map((n) => [n, !!apiKeys[n]])),
  });
  let captureProtected = false;
  settings.tor.enabled = opts.torEnabled ?? !detectDemoTorDisabled();
  // Like the shell's setup: Tor starts in the background when enabled.
  const tor = createDemoTor(opts.tor ?? detectDemoTorScenario());
  if (settings.tor.enabled) tor.start();
  const networkChoice = createDemoNetwork({
    network,
    source: resolved.source,
    store: networkStore,
    lock: () => {
      unlocked = false;
    },
    ...(opts.onNetworkRestart ? { onRestart: opts.onNetworkRestart } : {}),
  });
  // Several accounts per chain (§2.9): lists, accounts_get({ account }), signer line.
  const accts = createDemoAccounts({ network, seed: demoSeed(), base: keys.accounts, baseOwnBtc: keys.ownBtc, chain, requireUnlocked: () => requireUnlocked() });
  // Litecoin / Dogecoin / Bitcoin Cash / Dash (§2.4): `ltc_*` / `doge_*` / `bch_*` / `dash_*`.
  const utxoChains = createDemoUtxo({
    chain,
    network,
    nodes: keys.utxo,
    accounts: accts,
    tor,
    settings: () => settings,
    requireUnlocked: () => requireUnlocked(),
    checkPassword: (p) => checkPassword(p),
    confirm: (text) => confirmFn(text),
  });
  // TRON (§2.5): `tron_*`, resources estimated like Rust.
  const tronChain = createDemoTron({
    network,
    seed: demoSeed(),
    tor,
    settings: () => settings,
    requireUnlocked: () => requireUnlocked(),
    checkPassword: (p) => checkPassword(p),
    confirm: (text) => confirmFn(text),
    now: () => now(),
    stakeBroadcast: (raw, sig) => stake.tronStakeBroadcast(raw, sig),
  });
  // XRP Ledger (§2.6): `xrp_*`, reserves and destination-tag rules like Rust.
  const xrpChain = createDemoXrp({
    network,
    seed: demoSeed(),
    tor,
    settings: () => settings,
    requireUnlocked: () => requireUnlocked(),
    checkPassword: (p) => checkPassword(p),
    confirm: (text) => confirmFn(text),
    now: () => now(),
  });
  // Stellar (§2.11): `stellar_*`, reserve, CreateAccount and memo-required rules like Rust.
  const stellarChain = createDemoStellar({
    network,
    seed: demoSeed(),
    tor,
    settings: () => settings,
    requireUnlocked: () => requireUnlocked(),
    checkPassword: (p) => checkPassword(p),
    confirm: (text) => confirmFn(text),
    now: () => now(),
  });
  // NEAR (§2.11): `near_*`, storage reserve and fee bound like Rust.
  const nearChain = createDemoNear({
    network,
    tor,
    settings: () => settings,
    requireUnlocked: () => requireUnlocked(),
    checkPassword: (p) => checkPassword(p),
    confirm: (text) => confirmFn(text),
    now: () => now(),
  });
  // Sui (§2.11): `sui_*`, gas budget / coin rules like Rust.
  const suiChain = createDemoSui({
    network,
    tor,
    settings: () => settings,
    requireUnlocked: () => requireUnlocked(),
    checkPassword: (p) => checkPassword(p),
    confirm: (text) => confirmFn(text),
    now: () => now(),
  });
  // Hedera (§2.11): `hbar_*`, mirror-node facts and max-fee rules like Rust.
  const hbarChain = createDemoHbar({
    network,
    seed: demoSeed(),
    tor,
    settings: () => settings,
    requireUnlocked: () => requireUnlocked(),
    checkPassword: (p) => checkPassword(p),
    confirm: (text) => confirmFn(text),
    now: () => now(),
  });
  // Algorand (§2.11): `algo_*`, minimum balance and refusals like Rust.
  const algoChain = createDemoAlgo({
    network,
    tor,
    settings: () => settings,
    requireUnlocked: () => requireUnlocked(),
    checkPassword: (p) => checkPassword(p),
    confirm: (text) => confirmFn(text),
    now: () => now(),
  });
  // TON (§2.11): `ton_*`, bounce, deployment and comment rules like Rust.
  const tonChain = createDemoTon({
    network,
    tor,
    settings: () => settings,
    requireUnlocked: () => requireUnlocked(),
    checkPassword: (p) => checkPassword(p),
    confirm: (text) => confirmFn(text),
    now: () => now(),
  });
  // Cardano (§2.7): `ada_*`, min-UTxO / fee / coin selection like Rust.
  const cardanoChain = createDemoCardano({
    network,
    tor,
    settings: () => settings,
    requireUnlocked: () => requireUnlocked(),
    checkPassword: (p) => checkPassword(p),
    confirm: (text) => confirmFn(text),
    now: () => now(),
  });
  // Kaspa (§2.11): `kas_*`, coin selection / KIP-9 mass / fee like Rust.
  const kaspaChain = createDemoKaspa({
    network,
    seed: demoSeed(),
    tor,
    settings: () => settings,
    requireUnlocked: () => requireUnlocked(),
    checkPassword: (p) => checkPassword(p),
    confirm: (text) => confirmFn(text),
    now: () => now(),
  });
  // Polkadot (§2.11): `dot_*`, existential deposit / keep-alive rules like Rust.
  const dotChain = createDemoDot({
    network,
    seed: demoSeed(),
    tor,
    settings: () => settings,
    requireUnlocked: () => requireUnlocked(),
    checkPassword: (p) => checkPassword(p),
    confirm: (text) => confirmFn(text),
    now: () => now(),
  });
  // Monero (§2.10): `xmr_*`, scan, unlock and transfer rules like Rust (nothing real).
  const xmrChain = createDemoXmr({
    network,
    tor,
    settings: () => settings,
    requireUnlocked: () => requireUnlocked(),
    checkPassword: (p) => checkPassword(p),
    confirm: (text) => confirmFn(text),
    now: () => now(),
  });
  // Staking (§2.8): Solana, Cardano, TRON.
  const stake = createDemoStake({
    network,
    now: () => now(),
    requireUnlocked: () => requireUnlocked(),
    checkPassword: (p) => checkPassword(p),
    confirm: (text) => confirmFn(text),
    sol: { address: keys.accounts.sol.address, lamports: () => chain.solLamports, setLamports: (v) => (chain.solLamports = v) },
    ada: { address: cardanoChain.state.me, account: () => cardanoChain.stakeHooks.account(), spend: (l) => cardanoChain.stakeHooks.spend(l) },
    tron: { address: tronChain.state.me, trx: () => tronChain.state.trx.get(tronChain.state.me) ?? 0n, setTrx: (v) => tronChain.state.trx.set(tronChain.state.me, v) },
  });
  // Custom servers (B2b): live checks, Bitcoin backends, Core watch wallet.
  const servers = createDemoServers({
    utxo: utxoChains,
    tron: tronChain,
    xrp: xrpChain,
    cardano: cardanoChain,
    xmr: xmrChain,
    chain,
    network,
    fingerprint: keys.accounts.btc.segwit.fingerprint,
    tor,
    settings: () => settings,
    requireUnlocked: () => requireUnlocked(),
    cbf: createDemoCbf({
      enabled: opts.cbf ?? detectDemoCbf(),
      network,
      tor,
      torOn: () => settings.tor.enabled,
      tipHeight: () => chain.tipHeight,
      server: () => {
        const s = settings.servers.bitcoin[network === 'mainnet' ? 'mainnet' : 'testnet4'];
        return s?.kind === 'cbf' ? s : null;
      },
      requireUnlocked: () => requireUnlocked(),
    }),
  });

  const confirmFn =
    opts.confirm ??
    ((summary: string) => (typeof window !== 'undefined' && typeof window.confirm === 'function' ? window.confirm(l10n(`[MODE DÉMO — fenêtre système simulée]\n\n${summary}`, `[DEMO MODE — simulated system window]\n\n${summary}`)) : true));

  /** Every `host:port` of the servers in `v` (URLs, Electrum host/port), lower-cased. */
  const hostsOf = (v: unknown): string[] => {
    const out: string[] = [];
    const walk = (x: unknown) => {
      if (!x || typeof x !== 'object') return;
      const o = x as Record<string, unknown>;
      if (typeof o.url === 'string') {
        try {
          const u = new URL(o.url.trim());
          out.push(`${u.hostname.toLowerCase()}:${u.port || (u.protocol === 'http:' ? '80' : '443')}`);
        } catch {
          /* invalid URL: refused later by validation */
        }
      }
      if (typeof o.host === 'string' && typeof o.port === 'number') out.push(`${o.host.trim().toLowerCase()}:${o.port}`);
      for (const val of Object.values(o)) walk(val);
    };
    walk(v);
    return [...new Set(out)];
  };
  /** server_approval.rs: a host neither saved nor approved this session needs the native dialog. */
  const approveHosts = (incoming: unknown, saved: unknown) => {
    const known = new Set(hostsOf(saved));
    const pending = hostsOf(incoming).filter((h) => !known.has(h) && !approvedHosts.has(h));
    if (pending.length === 0) return;
    if (!confirmFn(l10n(`Nouveau serveur\nKyro va contacter :\n${pending.map((h) => `• ${h}`).join('\n')}\nSi tu n’as pas saisi toi-même cette adresse, refuse.`, `New server\nKyro will contact:\n${pending.map((h) => `• ${h}`).join('\n')}\nIf you did not type this address yourself, refuse.`))) throw new IpcError('USER_REJECTED', l10n('Action annulée.', 'Action cancelled.'));
    for (const h of pending) approvedHosts.add(h);
  };
  /** commands_servers.rs check_cookie_paths: a new `.cookie` path must come from the picker. */
  const checkPickedCookie = (incoming: unknown, saved: unknown) => {
    const paths = (v: unknown): string[] => {
      const out: string[] = [];
      const walk = (x: unknown) => {
        if (!x || typeof x !== 'object') return;
        const o = x as Record<string, unknown>;
        if (o.kind === 'cookie' && typeof o.cookiePath === 'string') out.push(o.cookiePath);
        for (const val of Object.values(o)) walk(val);
      };
      walk(v);
      return out;
    };
    const known = new Set(paths(saved));
    for (const p of paths(incoming)) {
      if (!known.has(p) && p !== pickedCookie) throw new IpcError('SERVER_INVALID', l10n('Serveur invalide : fichier .cookie : choisis-le avec le bouton « Choisir le fichier .cookie »', 'Invalid server: .cookie file: choose it with the “Choose the .cookie file” button'));
    }
  };

  const lockIfExpired = () => {
    if (unlocked && now() - lastTouch >= settings.autoLockSecs * 1000) {
      unlocked = false;
      emitDemoEvent('vault-locked');
    }
  };
  if (typeof window !== 'undefined') window.setInterval(lockIfExpired, 1000);

  const requireUnlocked = () => {
    lockIfExpired();
    if (!vault) throw new IpcError('LOCKED', l10n('Aucun coffre sur cet appareil.', 'No vault on this device.'));
    if (!unlocked) throw new IpcError('LOCKED', l10n('Le coffre est verrouillé.', 'The vault is locked.'));
  };

  const checkPassword = (password: unknown) => {
    if (!vault) throw new IpcError('LOCKED', l10n('Aucun coffre sur cet appareil.', 'No vault on this device.'));
    if (now() < blockedUntil) {
      throw new IpcError('RATE_LIMITED', l10n(`Trop d’essais. Réessaie dans ${Math.ceil((blockedUntil - now()) / 1000)} s.`, `Too many attempts. Try again in ${Math.ceil((blockedUntil - now()) / 1000)} s.`));
    }
    if (password !== vault.password) {
      failed += 1;
      if (failed >= 5) blockedUntil = now() + 5000 * 2 ** (failed - 5);
      throw new IpcError('WRONG_PASSWORD', l10n('Mot de passe incorrect.', 'Wrong password.'));
    }
    failed = 0;
  };

  const validPassword = (p: unknown): string => {
    if (typeof p !== 'string' || p.length < 8) throw new IpcError('INVALID_INPUT', l10n('Le mot de passe doit faire au moins 8 caractères.', 'The password must be at least 8 characters long.'));
    return p;
  };

  const status = (): VaultStatus => {
    lockIfExpired();
    const left = Math.max(0, Math.ceil((lastTouch + settings.autoLockSecs * 1000 - now()) / 1000));
    return { exists: vault !== null, unlocked, autoLockSecs: settings.autoLockSecs, lockInSecs: unlocked ? left : null };
  };

  const decodeEvm = (tx: EvmTxRequest): EvmTxSummary => {
    const s = decodeEvmKind(tx);
    return { ...s, valueWei: BigInt(tx.valueWei).toString(), ...evmWarnings(s, tx) };
  };
  const decodeEvmKind = (tx: EvmTxRequest): Omit<EvmTxSummary, 'warnings' | 'requiresExtraConfirmation' | 'valueWei'> => {
    const data = tx.data.toLowerCase();
    const maxFeeWei = (BigInt(tx.gasLimit) * BigInt(tx.maxFeePerGas)).toString();
    const word = (i: number) => data.slice(10 + i * 64, 10 + (i + 1) * 64);
    const base = { tokenContract: null, spender: null, unlimitedApproval: false, maxFeeWei, chainId: tx.chainId };
    if (data === '0x' || data === '') return { ...base, kind: 'NativeTransfer', to: tx.to, amount: BigInt(tx.valueWei).toString() };
    if (data.startsWith('0xa9059cbb') && data.length >= 138) {
      return { ...base, kind: 'Erc20Transfer', to: toChecksumAddress(word(0).slice(24)), tokenContract: tx.to, amount: BigInt('0x' + word(1)).toString() };
    }
    if (data.startsWith('0x095ea7b3') && data.length >= 138) {
      const amount = BigInt('0x' + word(1));
      return { ...base, kind: 'Erc20Approve', to: tx.to, tokenContract: tx.to, spender: toChecksumAddress(word(0).slice(24)), amount: amount.toString(), unlimitedApproval: amount >= MAX_UINT256 / 2n };
    }
    return { ...base, kind: 'ContractCall', to: tx.to, amount: BigInt(tx.valueWei).toString() };
  };

  const signPsbt = (psbtB64: string, account: number): { psbt: string; summary: BtcTxSummary } => {
    const own = accts.ownBtc(account);
    const net = network === 'testnet' ? bitcoin.networks.testnet : bitcoin.networks.bitcoin;
    const psbt = bitcoin.Psbt.fromBase64(psbtB64, { network: net });
    let inSum = 0n;
    psbt.data.inputs.forEach((input, i) => {
      inSum += input.witnessUtxo?.value ?? 0n;
      if (input.tapInternalKey || input.tapBip32Derivation?.length) {
        const h = sha256(new TextEncoder().encode(`tap:${i}:${psbtB64}`));
        const tapKeySig = new Uint8Array(64);
        tapKeySig.set(h, 0);
        tapKeySig.set(sha256(h), 32);
        psbt.updateInput(i, { tapKeySig });
      } else {
        const pubkey = input.bip32Derivation?.[0]?.pubkey;
        if (!pubkey) throw new IpcError('INVALID_INPUT', l10n(`Entrée ${i} sans dérivation BIP32.`, `Input ${i} without a BIP32 derivation.`));
        psbt.updateInput(i, { partialSig: [{ pubkey, signature: fakeDerSignature(`${i}:${psbtB64}`) }] });
      }
    });
    const outputs = psbt.txOutputs.map((o) => {
      const address = demoRenderScript(o.script, net);
      return [address, Number(o.value), own.has(address)] as [string, number, boolean];
    });
    const outSum = psbt.txOutputs.reduce((a, o) => a + o.value, 0n);
    const feeSats = Number(inSum - outSum);
    const vsize = demoVsize(psbt);
    return { psbt: psbt.toBase64(), summary: { outputs, feeSats, ...btcWarnings({ outputs, feeSats, vsize }) } };
  };

  // Hardware wallets: keys from a separate public demo seed, same native-dialog emulation.
  const hw = createDemoHw(opts.hw ?? detectDemoHwScenario(), {
    network,
    guard: () => {
      lockIfExpired();
      if (vault && !unlocked) throw new IpcError('LOCKED', l10n('Le coffre est verrouillé.', 'The vault is locked.'));
    },
    confirm: (text) => confirmFn(text),
    decodeEvm: (tx) => decodeEvm(tx),
    registerEvm: (raw, hash, tx, from) => chain.signedEvm.set(raw, { hash, tx, from }),
    fund: (_acc, addr) => {
      const tip = chain.tipHeight;
      const net = network === 'testnet' ? bitcoin.networks.testnet : bitcoin.networks.bitcoin;
      if (addr.taproot && !chain.btcUtxos.has(addr.taproot)) demoFund(chain.btcUtxos, chain.rawTx, addr.taproot, net, 'hw-tap', 640_000, tip - 30);
      if (addr.segwit && !chain.btcUtxos.has(addr.segwit)) demoFund(chain.btcUtxos, chain.rawTx, addr.segwit, net, 'hw-seg', 310_000, tip - 80);
      if (addr.evm) {
        const key = `${network === 'testnet' ? 11155111 : 1}:${addr.evm.toLowerCase()}`;
        if (!chain.evmNative.has(key)) chain.evmNative.set(key, 312_000_000_000_000_000n);
      }
    },
  });

  const handlers: { [K in keyof Commands]: (args: Record<string, unknown>) => unknown } = {
    vault_status: () => status(),
    vault_create: (a) => {
      if (vault) throw new IpcError('INVALID_INPUT', l10n('Un coffre existe déjà sur cet appareil.', 'A vault already exists on this device.'));
      const password = validPassword(a.password);
      const count = a.words === 12 ? 12 : 24;
      const words = generateMnemonic(wordlist, count === 12 ? 128 : 256).split(' ');
      vault = { password, words };
      unlocked = true;
      lastTouch = now();
      // Like Rust: the words are never returned, only shown in the native dialog.
      pendingBackup = { words: [...words], checks: randomChecks(words.length), failures: 0 };
      return { wordCount: words.length };
    },
    vault_backup_show: () => {
      if (!pendingBackup) throw new IpcError('INVALID_INPUT', l10n('Entrée invalide : aucune phrase de récupération en attente de sauvegarde', 'Invalid input: no recovery phrase waiting to be backed up'));
      const w = pendingBackup.words;
      confirmFn(l10n(`Ta phrase de récupération\n\n${w.map((x, i) => `${String(i + 1).padStart(2, ' ')}. ${x}`).join('   ')}`, `Your recovery phrase\n\n${w.map((x, i) => `${String(i + 1).padStart(2, ' ')}. ${x}`).join('   ')}`));
      pendingBackup.checks = randomChecks(w.length);
      return { checks: pendingBackup.checks };
    },
    vault_backup_verify: (a) => {
      if (!pendingBackup) throw new IpcError('INVALID_INPUT', l10n('Entrée invalide : aucune phrase de récupération en attente de sauvegarde', 'Invalid input: no recovery phrase waiting to be backed up'));
      const answers = Array.isArray(a.answers) ? (a.answers as unknown[]).map((x) => String(x).trim().toLowerCase()) : [];
      const p = pendingBackup;
      const ok = answers.length === 3 && p.checks.every((idx, i) => p.words[idx] === answers[i]);
      if (ok) {
        pendingBackup = null;
        return { ok: true, attemptsLeft: 0 };
      }
      p.failures += 1;
      const left = Math.max(0, 5 - p.failures);
      if (left === 0) pendingBackup = null;
      return { ok: false, attemptsLeft: left };
    },
    vault_import: (a) => {
      if (vault) throw new IpcError('INVALID_INPUT', l10n('Un coffre existe déjà sur cet appareil.', 'A vault already exists on this device.'));
      const password = validPassword(a.password);
      const phrase = String(a.phrase ?? '').trim().toLowerCase().split(/\s+/).join(' ');
      if (!validateMnemonic(phrase, wordlist)) throw new IpcError('INVALID_INPUT', l10n('Phrase de récupération invalide (mot inconnu ou somme de contrôle fausse).', 'Invalid recovery phrase (unknown word or wrong checksum).'));
      vault = { password, words: phrase.split(' ') };
      unlocked = true;
      lastTouch = now();
    },
    vault_unlock: (a) => {
      checkPassword(a.password);
      unlocked = true;
      lastTouch = now();
    },
    vault_lock: () => {
      unlocked = false;
      pendingBackup = null;
    },
    vault_reveal_mnemonic: (a) => {
      requireUnlocked();
      reveals = reveals.filter((t) => now() - t < 60_000);
      if (reveals.length >= 3) throw new IpcError('RATE_LIMITED', l10n('Trop de demandes. Réessaie dans une minute.', 'Too many requests. Try again in a minute.'));
      checkPassword(a.password);
      reveals.push(now());
      // Like Rust: native confirmation, then the words in a native dialog; nothing returned.
      if (!confirmFn(l10n('Afficher la phrase de récupération ?\nVérifie que personne ne regarde ton écran.', 'Show the recovery phrase?\nMake sure nobody is watching your screen.'))) throw new IpcError('USER_REJECTED', l10n('Action annulée.', 'Action cancelled.'));
      confirmFn(l10n(`Ta phrase de récupération\n\n${(vault?.words ?? []).map((x, i) => `${i + 1}. ${x}`).join('   ')}`, `Your recovery phrase\n\n${(vault?.words ?? []).map((x, i) => `${i + 1}. ${x}`).join('   ')}`));
    },
    session_touch: () => {
      lockIfExpired();
      if (unlocked) lastTouch = now();
    },
    accounts_get: (a) => {
      requireUnlocked();
      return accts.get(accts.arg(a.account));
    },
    vault_accounts_get: () => accts.lists(),
    vault_account_add: (a) => accts.add(a.chain, a.account, a.name),
    vault_account_rename: (a) => accts.rename(a.chain, a.account, a.name),
    vault_account_remove: (a) => accts.remove(a.chain, a.account),
    btc_address: (a) => {
      requireUnlocked();
      const kind: BtcKind = a.kind === 'taproot' ? 'taproot' : 'segwit';
      const index = Number(a.index);
      if (!Number.isInteger(index) || index < 0 || index > 2 ** 31 - 1) throw new IpcError('INVALID_INPUT', l10n('Index invalide.', 'Invalid index.'));
      const testnet = network === 'testnet';
      const master = HDKey.fromMasterSeed(demoSeed(), testnet ? TESTNET_VERSIONS : undefined);
      const path = `m/${kind === 'segwit' ? 84 : 86}'/${testnet ? 1 : 0}'/${accts.arg(a.account)}'/${a.change ? 1 : 0}/${index}`;
      const pk = master.derive(path).publicKey;
      if (!pk) throw new IpcError('INTERNAL', l10n('Dérivation impossible.', 'Derivation failed.'));
      return btcAddressFor(kind, pk, testnet ? bitcoin.networks.testnet : bitcoin.networks.bitcoin);
    },
    evm_decode_tx: (a) => decodeEvm(a.tx as EvmTxRequest),
    evm_sign_tx: (a) => {
      requireUnlocked();
      const account = accts.arg(a.account);
      checkPassword(a.password);
      const tx = a.tx as EvmTxRequest;
      const s = decodeEvm(tx);
      // No token hint from the interface (Rust names tokens from its own table only).
      const from = accts.get(account).evm;
      const signer = accts.signer('evm', account, from.path);
      if (!confirmFn(l10n(`${signer.line}\n\nDe : ${from.address}\nSigner une transaction ${s.kind} sur la chaîne ${tx.chainId}\nVers : ${s.to}\nMontant : ${s.amount} (unités brutes)\nFrais max. : ${s.maxFeeWei} wei`, `${signer.line}\n\nFrom: ${from.address}\nSign a ${s.kind} transaction on chain ${tx.chainId}\nTo: ${s.to}\nAmount: ${s.amount} (raw units)\nMax fee: ${s.maxFeeWei} wei`))) {
        throw new IpcError('USER_REJECTED', l10n('Signature refusée.', 'Signature refused.'));
      }
      if (signer.unknown && !confirmFn(signer.unknownText)) throw new IpcError('USER_REJECTED', l10n('Signature refusée.', 'Signature refused.'));
      // Rust: reinforced 2nd dialog when the summary says so (contract call, approval…).
      if (s.requiresExtraConfirmation && !confirmFn(l10n(`Attention : transaction à vérifier\n${s.warnings.map((w) => `• ${w.kind}`).join('\n')}\nNe signe que si tu sais exactement pourquoi. Signer quand même ?`, `Warning: transaction to check\n${s.warnings.map((w) => `• ${w.kind}`).join('\n')}\nOnly sign if you know exactly why. Sign anyway?`))) {
        throw new IpcError('USER_REJECTED', l10n('Signature refusée.', 'Signature refused.'));
      }
      const raw = '0x02' + bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(tx) + Math.random()))) + '00'.repeat(40);
      const hash = '0x' + demoHash(raw);
      chain.signedEvm.set(raw, { hash, tx, from: from.address });
      return { rawTx: raw, hash };
    },
    btc_sign_psbt: (a) => {
      requireUnlocked();
      const account = accts.arg(a.account);
      checkPassword(a.password);
      const out = signPsbt(String(a.psbt ?? ''), account);
      const lines = out.summary.outputs.map(([ad, v, ch]) => l10n(`${ch ? '(monnaie) ' : ''}${ad} : ${v} sats`, `${ch ? '(change) ' : ''}${ad}: ${v} sats`)).join('\n');
      const c = network === 'testnet' ? 1 : 0;
      const signer = accts.signer('btc', account, `m/84'/${c}'/${account}' (SegWit), m/86'/${c}'/${account}' (Taproot)`);
      if (!confirmFn(l10n(`${signer.line}\n\nSigner cette transaction Bitcoin ?\n${lines}\nFrais : ${out.summary.feeSats} sats`, `${signer.line}\n\nSign this Bitcoin transaction?\n${lines}\nFees: ${out.summary.feeSats} sats`))) throw new IpcError('USER_REJECTED', l10n('Signature refusée.', 'Signature refused.'));
      if (signer.unknown && !confirmFn(signer.unknownText)) throw new IpcError('USER_REJECTED', l10n('Signature refusée.', 'Signature refused.'));
      if (out.summary.requiresExtraConfirmation && !confirmFn(l10n(`Attention : transaction à vérifier\n${out.summary.warnings.map((w) => `• ${w.kind}`).join('\n')}\nNe signe que si tu sais exactement pourquoi. Signer quand même ?`, `Warning: transaction to check\n${out.summary.warnings.map((w) => `• ${w.kind}`).join('\n')}\nOnly sign if you know exactly why. Sign anyway?`))) {
        throw new IpcError('USER_REJECTED', l10n('Signature refusée.', 'Signature refused.'));
      }
      return out;
    },
    sol_decode_tx: (a) => {
      requireUnlocked();
      return demoDecodeSolMessage(decodeSolMessageArg(a.message), accts.get(accts.arg(a.account)).sol.address);
    },
    sol_sign_tx: (a) => {
      requireUnlocked();
      const account = accts.arg(a.account);
      const me = accts.get(account).sol;
      const message = decodeSolMessageArg(a.message);
      const summary = demoDecodeSolMessage(message, me.address);
      if (summary.ourSignerIndex === null) throw new IpcError('INVALID_INPUT', l10n('Ce compte ne signe pas cette transaction.', 'This account does not sign this transaction.'));
      checkPassword(a.password);
      const signer = accts.signer('sol', account, me.path);
      if (!confirmFn(l10n(`${signer.line}

Signer cette transaction Solana ?
${demoSolSummaryText(summary)}`, `${signer.line}

Sign this Solana transaction?
${demoSolSummaryText(summary)}`))) throw new IpcError('USER_REJECTED', l10n('Signature refusée.', 'Signature refused.'));
      if (signer.unknown && !confirmFn(signer.unknownText)) throw new IpcError('USER_REJECTED', l10n('Signature refusée.', 'Signature refused.'));
      if (summary.requiresExtraConfirmation && !confirmFn(l10n(`Instruction non reconnue ou inhabituelle : signer quand même ?
${summary.warnings.map((w) => w.kind).join(', ')}`, `Unrecognized or unusual instruction: sign anyway?
${summary.warnings.map((w) => w.kind).join(', ')}`))) {
        throw new IpcError('USER_REJECTED', l10n('Signature refusée.', 'Signature refused.'));
      }
      const sig = new Uint8Array(64);
      sig.set(sha256(message), 0);
      sig.set(sha256(sha256(message)), 32);
      return { signature: base64.encode(sig), summary };
    },
    net_fetch: async (a) => {
      // Fail closed, like net.rs: over Tor only when enabled, never retried in clear.
      if (settings.tor.enabled) await tor.waitReady();
      return servers.netFetch(a.req as Parameters<typeof handleDemoNet>[0]);
    },
    tor_status: () => tor.status(),
    tor_retry: () => {
      if (!settings.tor.enabled) throw new IpcError('INVALID_INPUT', l10n('Tor est désactivé dans les réglages.', 'Tor is disabled in the settings.'));
      tor.restart();
      return tor.status();
    },
    // Never the Core password: `hasPassword` instead (servers.rs `redacted`).
    settings_get: () => publicSettings(),
    settings_set: async (a) => {
      const next = a.settings as (SettingsInput & { apiKeysSet?: unknown }) | undefined;
      if (!next || (next.currency !== 'EUR' && next.currency !== 'USD')) throw new IpcError('INVALID_INPUT', l10n('Réglages invalides.', 'Invalid settings.'));
      if (!Number.isInteger(next.autoLockSecs) || next.autoLockSecs < 60 || next.autoLockSecs > 4 * 3600) {
        throw new IpcError('INVALID_INPUT', l10n('Délai de verrouillage invalide (1 min à 4 h).', 'Invalid lock delay (1 min to 4 h).'));
      }
      const langIn: unknown = (next as { language?: unknown }).language;
      if (langIn !== undefined && langIn !== 'auto' && langIn !== 'fr' && langIn !== 'en') throw new IpcError('INVALID_INPUT', l10n('Entrée invalide : langue : auto, fr ou en', 'Invalid input: language: auto, fr or en'));
      const torIn: unknown = (next as { tor?: unknown }).tor;
      if (torIn !== undefined && (typeof torIn !== 'object' || torIn === null || typeof (torIn as { enabled?: unknown }).enabled !== 'boolean')) {
        throw new IpcError('INVALID_INPUT', l10n('Réglages invalides (tor).', 'Invalid settings (tor).'));
      }
      const wasEnabled = settings.tor.enabled;
      // Missing `tor` → default (enabled), like serde's `#[serde(default)]`.
      const torEnabled = torIn === undefined ? true : (torIn as { enabled: boolean }).enabled;
      // No `servers` key (older caller) → keep the stored ones. Legacy `rpc` is ignored here:
      // Rust migrates it once at load, the UI never sends it.
      const incoming = 'servers' in next && next.servers ? next.servers : settings.servers;
      const { rpc: _legacy, apiKeys: keyUpdate, apiKeysSet: _ignored, ...rest } = next as SettingsInput & { rpc?: unknown; apiKeysSet?: unknown };
      // API keys (settings.rs ApiKeys::apply_patch): absent or null = unchanged, "" = remove,
      // non-empty = set after trim; blank after trim or a control character → INVALID_INPUT.
      const nextKeys = { ...apiKeys };
      if (keyUpdate !== undefined) {
        if (typeof keyUpdate !== 'object' || keyUpdate === null) throw new IpcError('INVALID_INPUT', l10n('Entrée invalide : apiKeys : objet attendu', 'Invalid input: apiKeys: object expected'));
        for (const [name, v] of Object.entries(keyUpdate as Record<string, unknown>)) {
          if (!(API_KEY_NAMES as readonly string[]).includes(name)) throw new IpcError('INVALID_INPUT', l10n(`Entrée invalide : clé API inconnue « ${name} »`, `Invalid input: unknown API key “${name}”`));
          if (v === null) continue;
          if (typeof v !== 'string') throw new IpcError('INVALID_INPUT', l10n(`Entrée invalide : clé API « ${name} » : texte attendu`, `Invalid input: API key “${name}”: text expected`));
          if (v === '') {
            delete nextKeys[name as ApiKeyName];
            continue;
          }
          const t = v.trim();
          if (!t || /\p{Cc}/u.test(t)) throw new IpcError('INVALID_INPUT', l10n(`Entrée invalide : clé API « ${name} » invalide (vide ou caractères de contrôle)`, `Invalid input: API key “${name}” invalid (empty or control characters)`));
          nextKeys[name as ApiKeyName] = t;
        }
      }
      // Like server_approval.rs: native confirmations before any request.
      if (wasEnabled && !torEnabled && !confirmFn(l10n('Désactiver Tor ?\nSans Tor, chaque serveur contacté verra ton adresse IP.', 'Turn off Tor?\nWithout Tor, every server contacted will see your IP address.'))) throw new IpcError('USER_REJECTED', l10n('Action annulée.', 'Action cancelled.'));
      checkPickedCookie(incoming, settings.servers);
      approveHosts(incoming, settings.servers);
      const storedServers = await servers.prepareSave({ ...EMPTY_SERVERS, ...structuredClone(incoming) }, settings.servers, torEnabled);
      apiKeys = nextKeys;
      settings = { ...structuredClone(rest), servers: storedServers, tor: { enabled: torEnabled }, language: (langIn as Settings['language'] | undefined) ?? 'auto', apiKeysSet: {} };
      if (!wasEnabled && settings.tor.enabled) tor.start();
      if (wasEnabled && !settings.tor.enabled) tor.stop();
      return publicSettings();
    },
    set_capture_protection: (a) => {
      captureProtected = Boolean(a.enabled);
    },
    server_test: (a) => {
      const target = a.target as Parameters<typeof servers.serverTest>[0];
      const probe = { server: (target as { server?: unknown }).server };
      checkPickedCookie(probe, settings.servers);
      approveHosts(probe, settings.servers);
      return servers.serverTest(target);
    },
    electrum_fetch_cert: (a) => {
      approveHosts({ host: a.host, port: a.port }, settings.servers);
      return servers.electrumFetchCert(a.host, a.port);
    },
    btc_core_pick_cookie: () => {
      // Demo: the simulated picker always returns the same file.
      pickedCookie = network === 'testnet' ? '/home/demo/.bitcoin/testnet4/.cookie' : '/home/demo/.bitcoin/.cookie';
      return { path: pickedCookie };
    },
    btc_backend_info: () => servers.btc.info(),
    btc_address_info: (a) => servers.btc.addressInfo(a.address),
    btc_address_utxos: (a) => servers.btc.addressUtxos(a.address),
    btc_address_txs: (a) => servers.btc.addressTxs(a.address),
    btc_fee_rates: () => servers.btc.feeRates(),
    btc_tip_height: () => servers.btc.tipHeight(),
    btc_broadcast: (a) => servers.btc.broadcast(a.hex),
    btc_tx_hex: (a) => servers.btc.txHex(a.txid),
    ...tronChain.handlers,
    ...xrpChain.handlers,
    ...stellarChain.handlers,
    ...nearChain.handlers,
    ...suiChain.handlers,
    ...hbarChain.handlers,
    ...tonChain.handlers,
    ...cardanoChain.handlers,
    ...kaspaChain.handlers,
    ...dotChain.handlers,
    ...algoChain.handlers,
    ...xmrChain.handlers,
    ...stake.handlers,
    btc_core_setup: (a) => servers.coreSetup(a.rescanFrom),
    btc_core_status: () => servers.coreStatus(),
    btc_cbf_status: () => servers.cbf.status(),
    btc_cbf_sync: () => servers.cbf.sync(),
    hw_list: () => hw.list(),
    hw_open: (a) => hw.open(a.id),
    hw_cancel: (a) => hw.cancel(a.id),
    hw_pin_matrix: (a) => hw.pinMatrix(a.id, a.positions),
    hw_thp_pairing_code: (a) => hw.thpPairingCode(a.id, a.code),
    hw_thp_pairings: () => hw.thpPairings(),
    hw_thp_forget: (a) => hw.thpForget(a.key),
    hw_get_xpub: (a) => hw.getXpub(a),
    hw_accounts_get: () => hw.accountsGet(),
    hw_account_add: (a) => hw.accountAdd(a),
    hw_account_remove: (a) => hw.accountRemove(a.accountId),
    hw_verify_address: (a) => hw.verifyAddress(a),
    hw_sign_btc_psbt: (a) => hw.signBtc(a),
    hw_sign_evm_tx: (a) => hw.signEvm(a),
    hw_sign_sol_tx: (a) => hw.signSol(a),
    config_get: (): AppConfig => ({ network, hasZeroxKey: true, hasCoingeckoKey: false, hasTrongridKey: Boolean(apiKeys.trongrid), systemLanguage: demoSystemLanguage() }),
    ...networkChoice.handlers,
  };

  return {
    chain,
    tor,
    hw,
    tron: tronChain.state,
    xrp: xrpChain.state,
    stellar: stellarChain.state,
    near: nearChain.state,
    sui: suiChain.state,
    hbar: hbarChain.state,
    ton: tonChain.state,
    cardano: cardanoChain.state,
    kaspa: kaspaChain.state,
    dot: dotChain.state,
    algo: algoChain.state,
    xmr: xmrChain.state,
    stake,
    advance(ms: number) {
      clockOffset += ms;
    },
    invoke: async (cmd, args = {}) => {
      const h = (handlers as Record<string, ((a: Record<string, unknown>) => unknown) | undefined>)[cmd] ?? utxoChains.handlers[cmd];
      if (!h) throw new IpcError('INVALID_INPUT', l10n(`Commande inconnue : ${cmd}`, `Unknown command: ${cmd}`));
      // §2.9: the TRON, XRP, Stellar, NEAR, TON, Cardano, Algorand and staking demo modules simulate account 0 only.
      if (cmd === 'ada_address' && accts.arg(args.account) !== 0) {
        requireUnlocked();
        if (Number(args.index ?? 0) !== 0) throw new IpcError('INVALID_INPUT', l10n('Entrée invalide : démo : seule l’adresse d’index 0 existe (Kyro ne signe que celle-là)', 'Invalid input: demo: only the address at index 0 exists (Kyro only signs that one)'));
        return accts.adaAddress(accts.arg(args.account));
      }
      if (DEMO_ACCOUNT0_ONLY.test(cmd) && accts.arg(args.account) !== 0) {
        throw new IpcError('INVALID_INPUT', l10n('Mode démo : les comptes supplémentaires TRON, XRP, Stellar, NEAR, Hedera, Polkadot, Algorand, Monero, TON et Cardano et le staking ne sont simulés que pour le premier compte (l’application réelle les gère tous).', 'Demo mode: extra TRON, XRP, Stellar, NEAR, Hedera, Polkadot, Algorand, Monero and Cardano accounts and staking are only simulated for the first account (the real app handles all of them).'));
      }
      void captureProtected;
      return await h(args);
    },
  };
}

/** Demo commands simulated for account 0 only (§2.9). */
const DEMO_ACCOUNT0_ONLY = /^(tron_(build_tx|sign_tx|broadcast)|xrp_(build_tx|sign_tx|broadcast)|ton_(build_tx|sign_tx|broadcast)|hbar_(build_tx|sign_tx|broadcast)|stellar_(build_tx|sign_tx|broadcast)|near_(build_tx|sign_tx|broadcast|tx_status)|ada_(build_tx|sign_tx|broadcast)|dot_(build_tx|sign_tx|broadcast)|algo_(build_tx|sign_tx|broadcast)|xmr_(prepare_tx|send_tx|txs|new_subaddress|set_restore_height)|(sol|ada|tron)_stake_(overview|build|sign|broadcast))$/;

function decodeSolMessageArg(m: unknown): Uint8Array {
  try {
    const bytes = base64.decode(String(m ?? ''));
    if (bytes.length === 0) throw new Error('vide');
    return bytes;
  } catch {
    throw new IpcError('INVALID_INPUT', l10n('Message Solana invalide (base64 attendu).', 'Invalid Solana message (base64 expected).'));
  }
}

let singleton: MockBackend | null = null;
export function getMockBackend(): MockBackend {
  singleton ??= createMockBackend();
  return singleton;
}
