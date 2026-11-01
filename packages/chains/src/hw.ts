// SPDX-License-Identifier: GPL-3.0-or-later
//
// Hardware-wallet accounts, TS side (docs/IPC.md §2.3): public derivation from the stored
// xpubs, the input rules of the devices, and the clear-signing table. No key, no signature
// here: signing is the Rust `hw_sign_*` commands (native dialog, device, verification).

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

import { l10n } from '@kyro/shared';
bitcoin.initEccLib(ecc);

/**
 * Accounts of the active wallet: the vault (all chains) or a hardware-wallet account (only the
 * chains read from the device). Same shape as `Accounts`, each chain optional.
 */
export interface WalletAccounts {
  network: Network;
  btc?: { segwit: BtcAccountView; taproot: BtcAccountView };
  /** `path`: derivation path of the chosen vault account (Rust `accounts_get`), for display. */
  evm?: { address: string; path?: string };
  sol?: { address: string; path?: string };
  /** Vault, or a hardware wallet (Ledger mainnet / Trezor): `hw_sign_utxo_psbt`. */
  ltc?: { address: string; xpub: string; fingerprint: string; path: string };
  doge?: { address: string; xpub: string; fingerprint: string; path: string };
  /** Vault or hardware wallet, like Litecoin / Dogecoin. */
  bch?: { address: string; xpub: string; fingerprint: string; path: string };
  dash?: { address: string; xpub: string; fingerprint: string; path: string };
  /** Vault, or a Ledger (`hw_sign_tron_tx`; not in Trezor's firmware). */
  tron?: { address: string; path?: string };
  /** Vault, or a Ledger (`hw_sign_xrp_tx`). */
  xrp?: { address: string; path?: string };
  /** Vault only: Hedera on a hardware wallet is HW_UNSUPPORTED. EVM address of the ECDSA key. */
  hbar?: { address: string; path?: string };
  /** Vault only: Cardano on a hardware wallet is HW_UNSUPPORTED. */
  cardano?: { address: string; path?: string };
  /** Vault, or a Ledger / Trezor (`hw_sign_stellar_tx`). */
  stellar?: { address: string; path?: string };
  /** NEAR implicit account (Ledger: key at `m/44'/397'/0'/0'/(account+1)'`, not the vault's path). */
  near?: { address: string; path?: string };
  /** Sui (vault, or Ledger « Sui » app). */
  sui?: { address: string; path?: string };
  /** Vault only: Kaspa is not offered on hardware wallets. */
  kas?: { address: string; path?: string };
  /** Vault only: Polkadot on a hardware wallet is HW_UNSUPPORTED. */
  polkadot?: { address: string; path?: string };
  /** Algorand (vault, or Ledger « Algorand » app). */
  algo?: { address: string; path?: string };
  /** Vault only: Monero on a hardware wallet is HW_UNSUPPORTED. */
  xmr?: { address: string; path?: string };
  /** Vault only: no hardware wallet signs TON in Kyro. */
  ton?: { address: string; path?: string };
  /** Cosmos Hub (vault, or Ledger « Cosmos » app, amino JSON signing). */
  cosmos?: { address: string; path?: string };
  /** Aptos (vault, or Ledger « Aptos » app). */
  aptos?: { address: string; path?: string };
  /** Vault only: Zcash (transparent) on a hardware wallet is HW_UNSUPPORTED. */
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
    else out.cosmos = view;
  }
  return out;
}

const UTXO_PREFIX = { litecoin: 'ltc', dogecoin: 'doge', bitcoincash: 'bch', dash: 'dash' } as const;
const UTXO_SPECS: Record<'ltc' | 'doge' | 'bch' | 'dash', UtxoCoinSpec> = { ltc: LITECOIN_SPEC, doge: DOGECOIN_SPEC, bch: BITCOINCASH_SPEC, dash: DASH_SPEC };

/** Single-key chains a Ledger can add to a hardware-wallet account (`hw_key_add`). */
export const HW_KEY_CHAINS: readonly HwKeyChain[] = ['sui', 'apt', 'algo', 'near', 'cosmos'];

/**
 * Chains a hardware-wallet brand can hold in Kyro (mirror of `hw/chains.rs`; the device and
 * its firmware / apps decide in the end, see `hw_open` → `chains`).
 */
export const HW_CHAINS: Record<HwDeviceKind, readonly HwChain[]> = {
  ledger: ['btc', 'evm', 'sol', 'ltc', 'doge', 'bch', 'dash', 'xrp', 'tron', 'stellar', ...HW_KEY_CHAINS],
  trezor: ['btc', 'evm', 'sol', 'ltc', 'doge', 'bch', 'dash', 'stellar'],
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
};

/** ERC-20 tokens for which Kyro ships a Ledger-signed descriptor (wallet-core `ledger_cal.rs`). */
const LEDGER_CLEAR_TOKENS: Array<[number, string]> = [
  [1, '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'], // USDC
  [1, '0xdac17f958d2ee523a2206206994597c13d831ec7'], // USDT
  [11155111, '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238'], // tUSDC Sepolia
];

/**
 * What the device will be able to show (mirror of `evm_clear_signs` in hw/ledger.rs and
 * hw/trezor.rs): `clear`, or `blind` (raw data / hash only: Rust adds a reinforced dialog).
 */
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
