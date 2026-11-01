// SPDX-License-Identifier: GPL-3.0-or-later
// Hardware-wallet accounts, TS side (docs/IPC.md §2.3). No key, no signature here: signing is Rust `hw_sign_*`.

import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from '@bitcoinerlab/secp256k1';
import { publicKeyToAddress } from 'viem/accounts';
import { bytesToHex } from 'viem';
import type { BtcKind, EvmTxSummary, HwChain, HwDeviceKind, HwKeyChain, Network, WatchOnlyAccount } from '@kyro/shared';
import { derivePubkey, parseXpub } from './bitcoin/xpub';
import { unsignedFamilyOf, type AnyAdapter, type AnyUnsigned } from './types';
import { utxoAddressFromXpub, type UtxoCoinSpec } from './utxo/utxo';
import { LITECOIN_SPEC } from './litecoin/adapter';
import { DOGECOIN_SPEC } from './dogecoin/adapter';
import { BITCOINCASH_SPEC } from './bitcoincash/adapter';
import { DASH_SPEC } from './dash/adapter';

import { l10n, zecP2pkhAddress } from '@kyro/shared';
bitcoin.initEccLib(ecc);

/** Accounts of the active wallet: the vault or a hardware-wallet account (each chain optional). */
export interface WalletAccounts {
  network: Network;
  btc?: { segwit: BtcAccountView; taproot: BtcAccountView };
  /** `path`: derivation path of the chosen vault account (Rust `accounts_get`), for display. */
  evm?: { address: string; path?: string };
  sol?: { address: string; path?: string };
  ltc?: { address: string; xpub: string; fingerprint: string; path: string };
  doge?: { address: string; xpub: string; fingerprint: string; path: string };
  bch?: { address: string; xpub: string; fingerprint: string; path: string };
  dash?: { address: string; xpub: string; fingerprint: string; path: string };
  tron?: { address: string; path?: string };
  xrp?: { address: string; path?: string };
  hbar?: { address: string; path?: string };
  cardano?: { address: string; path?: string };
  stellar?: { address: string; path?: string };
  /** NEAR implicit account (Ledger: key at `m/44'/397'/0'/0'/(account+1)'`, not the vault's path). */
  near?: { address: string; path?: string };
  sui?: { address: string; path?: string };
  kas?: { address: string; path?: string };
  polkadot?: { address: string; path?: string };
  algo?: { address: string; path?: string };
  xmr?: { address: string; path?: string };
  /** TON v4R2 wallet (vault, or Ledger « TON » app: key at `m/44'/607'/0'/0'/account'/0'`, another wallet than the vault's). */
  ton?: { address: string; path?: string };
  cosmos?: { address: string; path?: string };
  aptos?: { address: string; path?: string };
  zec?: { address: string; xpub: string; fingerprint: string; path: string };
}

export interface BtcAccountView {
  address: string;
  xpub: string;
  fingerprint: string;
  path: string;
}

/** Hardware-wallet signer of an adapter. */
export interface HwSigner {
  accountId: string;
  device: HwDeviceKind;
}

/** First receive address (`0/0`) of a BIP84 / BIP86 account xpub. */
export function btcAddressFromXpub(xpub: string, network: Network, kind: BtcKind, change: 0 | 1 = 0, index = 0): string {
  const net = network === 'testnet' ? bitcoin.networks.testnet : bitcoin.networks.bitcoin;
  const pubkey = derivePubkey(parseXpub(xpub), change, index);
  const p = kind === 'segwit' ? bitcoin.payments.p2wpkh({ pubkey, network: net }) : bitcoin.payments.p2tr({ internalPubkey: pubkey.slice(1, 33), network: net });
  if (!p.address) throw new Error(l10n('Adresse Bitcoin introuvable', 'Bitcoin address not found'));
  return p.address;
}

/** EVM address `m/44'/60'/0'/0/{index}` from the stored node xpub (EIP-55). */
export function evmAddressFromNode(nodeXpub: string, index: number): string {
  const pk = parseXpub(nodeXpub).deriveChild(index).publicKey;
  if (!pk) throw new Error(l10n('Dérivation EVM impossible', 'EVM derivation failed'));
  const uncompressed = ecc.pointCompress(pk, false);
  return publicKeyToAddress(bytesToHex(uncompressed));
}

/** Accounts of a hardware-wallet account (derived locally from its public keys). */
export function hwToAccounts(acc: WatchOnlyAccount): WalletAccounts {
  const out: WalletAccounts = { network: acc.network };
  const seg = acc.btc?.find((b) => b.kind === 'segwit');
  const tap = acc.btc?.find((b) => b.kind === 'taproot');
  if (seg && tap) {
    const view = (b: typeof seg): BtcAccountView => ({ address: btcAddressFromXpub(b.xpub, acc.network, b.kind), xpub: b.xpub, fingerprint: b.fingerprint, path: b.path });
    out.btc = { segwit: view(seg), taproot: view(tap) };
  }
  if (acc.evm) out.evm = { address: evmAddressFromNode(acc.evm.xpub, acc.account) };
  if (acc.sol) out.sol = { address: acc.sol.address };
  for (const u of acc.utxo ?? []) {
    const prefix = UTXO_PREFIX[u.coin];
    const address = utxoAddressFromXpub(UTXO_SPECS[prefix], acc.network, u.xpub);
    out[prefix] = { address, xpub: u.xpub, fingerprint: u.fingerprint, path: u.path };
  }
  if (acc.xrp) out.xrp = { address: acc.xrp.address, path: acc.xrp.path };
  if (acc.tron) out.tron = { address: acc.tron.address, path: acc.tron.path };
  if (acc.stellar) out.stellar = { address: acc.stellar.address, path: acc.stellar.path };
  for (const k of acc.keys ?? []) {
    const view = { address: k.address, path: k.path };
    if (k.chain === 'sui') out.sui = view;
    else if (k.chain === 'apt') out.aptos = view;
    else if (k.chain === 'algo') out.algo = view;
    else if (k.chain === 'near') out.near = view;
    else if (k.chain === 'cosmos') out.cosmos = view;
    else if (k.chain === 'ton') out.ton = view;
    else out.hbar = view;
  }
  // Cardano: Rust checked that the address is the one of the stored account key (base `…/0/0` + `…/2/0`).
  if (acc.cardano) out.cardano = { address: acc.cardano.address, path: `${acc.cardano.path}/0/0` };
  if (acc.zec) {
    const address = zecP2pkhAddress(derivePubkey(parseXpub(acc.zec.xpub), 0, 0), acc.network);
    out.zec = { address, xpub: acc.zec.xpub, fingerprint: acc.zec.fingerprint, path: acc.zec.path };
  }
  return out;
}

const UTXO_PREFIX = { litecoin: 'ltc', dogecoin: 'doge', bitcoincash: 'bch', dash: 'dash' } as const;
const UTXO_SPECS: Record<'ltc' | 'doge' | 'bch' | 'dash', UtxoCoinSpec> = { ltc: LITECOIN_SPEC, doge: DOGECOIN_SPEC, bch: BITCOINCASH_SPEC, dash: DASH_SPEC };

/** Single-key chains a Ledger can add to a hardware-wallet account (`hw_key_add`). */
export const HW_KEY_CHAINS: readonly HwKeyChain[] = ['sui', 'apt', 'algo', 'near', 'cosmos', 'ton', 'hbar'];

/** Chains a hardware-wallet brand can hold (mirror of `hw/chains.rs`). */
export const HW_CHAINS: Record<HwDeviceKind, readonly HwChain[]> = {
  ledger: ['btc', 'evm', 'sol', 'ltc', 'doge', 'bch', 'dash', 'xrp', 'tron', 'stellar', 'cardano', ...HW_KEY_CHAINS],
  trezor: ['btc', 'evm', 'sol', 'ltc', 'doge', 'bch', 'dash', 'stellar', 'cardano', 'zec'],
};

/** Master fingerprint of the account (Bitcoin keys), for display. */
export function hwFingerprint(acc: WatchOnlyAccount): string | null {
  return acc.btc?.[0]?.fingerprint ?? null;
}

/** Derivation paths shown / verified on the device. */
export const hwPaths = {
  btc: (acc: WatchOnlyAccount, kind: BtcKind, change: 0 | 1, index: number): string | null => {
    const b = acc.btc?.find((x) => x.kind === kind);
    return b ? `${b.path}/${change}/${index}` : null;
  },
  evm: (acc: WatchOnlyAccount): string => `m/44'/60'/0'/0/${acc.account}`,
  sol: (acc: WatchOnlyAccount): string | null => acc.sol?.path ?? null,
  /** Litecoin / Dogecoin / Bitcoin Cash / Dash address `change/index` of the stored account. */
  utxo: (acc: WatchOnlyAccount, coin: 'litecoin' | 'dogecoin' | 'bitcoincash' | 'dash', change: 0 | 1, index: number): string | null => {
    const u = acc.utxo?.find((x) => x.coin === coin);
    return u ? `${u.path}/${change}/${index}` : null;
  },
  /** XRP / TRON / Stellar key path, or the stored key of a single-key chain (Sui, Aptos, Algorand, NEAR, Cosmos). */
  key: (acc: WatchOnlyAccount, chain: 'xrp' | 'tron' | 'stellar' | HwKeyChain): string | null =>
    chain === 'xrp' || chain === 'tron' || chain === 'stellar' ? (acc[chain]?.path ?? null) : (acc.keys?.find((k) => k.chain === chain)?.path ?? null),
  /** Cardano: Kyro's single address, payment key `…/0/0` (+ stake key `…/2/0`). */
  cardano: (acc: WatchOnlyAccount): string | null => (acc.cardano ? `${acc.cardano.path}/0/0` : null),
  /** Zcash transparent address `change/index` of the stored account. */
  zec: (acc: WatchOnlyAccount, change: 0 | 1, index: number): string | null => (acc.zec ? `${acc.zec.path}/${change}/${index}` : null),
};

/** ERC-20 tokens for which Kyro ships a Ledger-signed descriptor (wallet-core `ledger_cal.rs`). */
const LEDGER_CLEAR_TOKENS: Array<[number, string]> = [
  [1, '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'], // USDC
  [1, '0xdac17f958d2ee523a2206206994597c13d831ec7'], // USDT
  [11155111, '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238'], // tUSDC Sepolia
];

/** What the device can show (mirror of `evm_clear_signs`): `blind` gets a reinforced Rust dialog. */
export function evmHwDisplay(device: HwDeviceKind, chainId: number, summary: Pick<EvmTxSummary, 'kind' | 'tokenContract'>): 'clear' | 'blind' {
  switch (summary.kind) {
    case 'NativeTransfer':
      return 'clear';
    case 'ContractCall':
      return 'blind';
    case 'Erc20Transfer':
      if (device === 'trezor') return 'clear';
      break;
    case 'Erc20Approve':
      if (device === 'trezor') return 'blind';
      break;
  }
  const c = summary.tokenContract?.toLowerCase();
  return LEDGER_CLEAR_TOKENS.some(([id, addr]) => id === chainId && addr === c) ? 'clear' : 'blind';
}

/** Sign on the hardware wallet `deviceId` (Rust `hw_sign_*`), then broadcast. */
export async function signAndBroadcastHw(adapter: AnyAdapter, unsigned: AnyUnsigned, deviceId: string): Promise<string> {
  if (unsignedFamilyOf(adapter.family) !== unsigned.family) throw new Error(l10n('Famille de transaction incohérente', 'Inconsistent transaction family'));
  const a = adapter as unknown as { hw: HwSigner | null; signTxHw(u: never, id: string): Promise<never>; broadcast(s: never): Promise<string> };
  if (!a.hw) throw new Error(l10n('Ce compte n’est pas un hardware wallet', 'This account is not a hardware wallet'));
  return a.broadcast(await a.signTxHw(unsigned as never, deviceId));
}
