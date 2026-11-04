// SPDX-License-Identifier: GPL-3.0-or-later
// Watch addresses (docs/IPC.md §2.3b): a public address or xpub the user follows. Nothing here can
// sign: the adapters built from it refuse every build, sign and broadcast (`sealWatchAdapters`).

import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from '@bitcoinerlab/secp256k1';
import { isAddress as isEvmAddress } from 'viem';
import { isAddress as isSolAddress } from '@solana/kit';
import { isAlgoAddress, isCosmosAddress, isKaspaAddress, isStellarAddress, l10n, zecDestinationKind, zecP2pkhAddress, zecShieldedRefusal, type AccountChain, type Network, type WatchAddress } from '@kyro/shared';
import { watchScriptOutput, type WatchScript, type WatchSource } from './watchScan';
import { derivePubkey, parseXpub } from './bitcoin/xpub';
import { scriptTypeOf, utxoAddressValid, type UtxoCoinSpec } from './utxo/utxo';
import { LITECOIN_SPEC } from './litecoin/adapter';
import { DOGECOIN_SPEC } from './dogecoin/adapter';
import { BITCOINCASH_SPEC } from './bitcoincash/adapter';
import { DASH_SPEC } from './dash/adapter';
import { isTronAddress } from './tron/adapter';
import { isXrpAddress } from './xrp/adapter';
import { isCardanoAddress } from './cardano/adapter';
import { nearAccountKind } from './near/adapter';
import { isSuiAddress } from './sui/adapter';
import { isDotAddress } from './polkadot/adapter';
import { isAptosAddress } from './aptos/adapter';
import { tonRecipientProblem } from './ton/adapter';
import type { BtcAccountView, WalletAccounts } from './hw';

bitcoin.initEccLib(ecc);

/** Networks that can be watched. Monero needs a private view key; Hedera is hidden. Same list as Rust's `WATCH_FAMILIES`. */
export const WATCH_FAMILIES: readonly AccountChain[] = ['btc', 'evm', 'sol', 'ltc', 'doge', 'bch', 'dash', 'zec', 'tron', 'xrp', 'ada', 'xlm', 'near', 'sui', 'kas', 'dot', 'algo', 'ton', 'cosmos', 'apt'];

const XPUB_FAMILIES: Record<Network, Record<string, readonly AccountChain[]>> = {
  mainnet: { xpub: ['btc', 'ltc', 'bch', 'dash', 'zec'], ypub: ['btc'], zpub: ['btc', 'ltc'], Ltub: ['ltc'], Mtub: ['ltc'], dgub: ['doge'] },
  testnet: { tpub: ['btc', 'ltc', 'doge', 'bch', 'dash', 'zec'], upub: ['btc'], vpub: ['btc', 'ltc'] },
};

const UTXO_SPECS: Partial<Record<AccountChain, UtxoCoinSpec>> = { ltc: LITECOIN_SPEC, doge: DOGECOIN_SPEC, bch: BITCOINCASH_SPEC, dash: DASH_SPEC };

/** True when `value` is a public extended key usable for `family` on `network`. */
export function isWatchXpub(family: AccountChain, value: string, network: Network): boolean {
  const v = value.trim();
  if (!XPUB_FAMILIES[network][v.slice(0, 4)]?.includes(family)) return false;
  try {
    parseXpub(v);
    return true;
  } catch {
    return false;
  }
}

function isBtcAddress(value: string, network: Network): boolean {
  try {
    return scriptTypeOf(bitcoin.address.toOutputScript(value, network === 'testnet' ? bitcoin.networks.testnet : bitcoin.networks.bitcoin)) !== null;
  } catch {
    return false;
  }
}

/** The same checks as Send, without needing an adapter of that network. */
export function isWatchable(family: AccountChain, value: string, network: Network): boolean {
  const a = value.trim();
  if (!a || !WATCH_FAMILIES.includes(family)) return false;
  if (isWatchXpub(family, a, network)) return true;
  const spec = UTXO_SPECS[family];
  if (spec) return utxoAddressValid(spec, network, a);
  switch (family) {
    case 'btc':
      return isBtcAddress(a, network);
    case 'evm':
      return isEvmAddress(a, { strict: true });
    case 'sol':
      return isSolAddress(a);
    case 'zec':
      return (zecDestinationKind(a, network) ?? 'tex') !== 'tex';
    case 'tron':
      return isTronAddress(a);
    case 'xrp':
      return isXrpAddress(a);
    case 'ada':
      return isCardanoAddress(a, network);
    case 'xlm':
      return isStellarAddress(a);
    case 'near':
      return nearAccountKind(a) !== null;
    case 'sui':
      return isSuiAddress(a);
    case 'kas':
      return isKaspaAddress(a, network);
    case 'dot':
      return isDotAddress(a, network);
    case 'algo':
      return isAlgoAddress(a);
    case 'ton':
      return tonRecipientProblem(a, network) === null;
    case 'cosmos':
      return isCosmosAddress(a);
    case 'apt':
      return isAptosAddress(a);
    default:
      return false;
  }
}

/** Why `value` cannot be watched at all, before any network is detected. */
export function watchRefusal(value: string): 'private' | 'monero' | 'shielded' | null {
  const a = value.trim();
  // Recovery phrases (words) and extended private keys: Rust refuses them too.
  if (/\s/.test(a) || /^(xprv|yprv|zprv|tprv|uprv|vprv|Ltpv|Mtpv|dgpv)/.test(a)) return 'private';
  if (/^[0-9][1-9A-HJ-NP-Za-km-z]{94,105}$/.test(a) || /^[0-9A-B][1-9A-HJ-NP-Za-km-z]{94}$/.test(a)) return 'monero';
  if (zecShieldedRefusal(a)) return 'shielded';
  return null;
}

/** Script types to scan for an xpub: the prefix says it when it can, otherwise every type used on that network. */
export function watchScripts(family: AccountChain, xpub: string): WatchScript[] {
  const p = xpub.trim().slice(0, 4);
  if (p === 'zpub' || p === 'vpub') return ['wpkh'];
  if (p === 'ypub' || p === 'upub' || p === 'Mtub') return ['sh-wpkh'];
  if (family === 'btc') return ['wpkh', 'tr', 'sh-wpkh', 'pkh'];
  if (family === 'ltc') return ['wpkh', 'pkh'];
  return ['pkh'];
}

/** First receive address of an xpub, for display. */
function firstAddress(family: AccountChain, xpub: string, script: WatchScript, network: Network): string {
  const pubkey = derivePubkey(parseXpub(xpub), 0, 0);
  if (family === 'zec') return zecP2pkhAddress(pubkey, network);
  const spec = UTXO_SPECS[family];
  const net = spec ? spec.network(network) : network === 'testnet' ? bitcoin.networks.testnet : bitcoin.networks.bitcoin;
  const { output, address } = watchScriptOutput(script, pubkey, net);
  return spec?.codec?.toAddress(output, network) ?? address;
}

/** The address a watch entry shows: itself, or the first receive address of an xpub. */
export function watchFirstAddress(w: Pick<WatchAddress, 'family' | 'value'>, network: Network): string {
  return isWatchXpub(w.family, w.value, network) ? firstAddress(w.family, w.value, watchScripts(w.family, w.value)[0] ?? 'pkh', network) : w.value;
}

/** The accounts of a watch address: one chain family, with no key behind it. */
export function watchToAccounts(w: Pick<WatchAddress, 'family' | 'value'>, network: Network): WalletAccounts {
  const family = w.family;
  const xpub = isWatchXpub(family, w.value, network);
  const source: WatchSource = xpub ? { kind: 'xpub', xpub: w.value, scripts: watchScripts(family, w.value) } : { kind: 'address', address: w.value };
  const address = watchFirstAddress(w, network);
  const view: BtcAccountView = { address, xpub: '', fingerprint: '00000000', path: '' };
  const out: WalletAccounts = { network, watch: source };
  const plain = { address };
  switch (family) {
    case 'btc':
      out.btc = { segwit: view, taproot: view };
      break;
    case 'ltc':
    case 'doge':
    case 'bch':
    case 'dash':
    case 'zec':
      out[family] = view;
      break;
    case 'evm':
    case 'sol':
    case 'tron':
    case 'xrp':
    case 'near':
    case 'sui':
    case 'kas':
    case 'algo':
    case 'ton':
    case 'cosmos':
      out[family] = plain;
      break;
    case 'ada':
      out.cardano = plain;
      break;
    case 'xlm':
      out.stellar = plain;
      break;
    case 'dot':
      out.polkadot = plain;
      break;
    case 'apt':
      out.aptos = plain;
      break;
    default:
      throw new Error(l10n('Ce réseau ne peut pas être suivi', 'This network cannot be watched'));
  }
  return out;
}

const REFUSED = /^(build|sign|broadcast|prepare|send|submit)/;

/** Every method of `adapter` that could lead to a signature now throws: fail closed, whatever a screen calls. */
export function sealWatchAdapter(adapter: object): void {
  const refuse = () => Promise.reject(new Error(l10n('Adresse suivie : rien à signer ici.', 'Watch address: nothing can be signed here.')));
  const a = adapter as Record<string, unknown>;
  for (let p: object | null = adapter; p && p !== Object.prototype; p = Object.getPrototypeOf(p) as object | null) {
    for (const k of Object.getOwnPropertyNames(p)) {
      if (REFUSED.test(k) && typeof a[k] === 'function') a[k] = refuse;
    }
  }
}
