// SPDX-License-Identifier: GPL-3.0-or-later
// Swap screen helpers: which chains a swap can start from / arrive on, our own address there
// (never typed: the destination of a cross-chain swap is always one of your accounts), the
// « Tu reçois » list grouped by chain, the label of a cross-chain transfer's status, and the
// check of the ordinary transfer Kyro builds for a NEAR Intents deposit (before the password).

import { checkSolSummary, NATIVE_EVM_TOKEN, NATIVE_SOL_MINT, tronCoverage, type AdapterSet, type AnyAdapter, type AnyUnsigned, type AssetDef, type Chain } from '@kyro/chains';
import type { EvmTxSummary, Network, SolTxSummary } from '@kyro/shared';
import type { DepositPlan, SwapChain } from '@kyro/swap';

/** Swap id of the chains only NEAR Intents 1Click reaches (docs/SWAP_FEES.md). */
const NEAR_ONLY: Partial<Record<Chain['family'], SwapChain>> = { btc: 'bitcoin', ltc: 'litecoin', doge: 'dogecoin', tron: 'tron', xrp: 'xrp', ada: 'cardano' };

/** The swap id of a chain: EVM chain id, 'solana', 'bitcoin', 'litecoin'…; null when swaps don't serve it. */
export function swapChainOf(chain: Chain | undefined): SwapChain | null {
  if (!chain) return null;
  if (chain.family === 'evm') return chain.chainId;
  if (chain.family === 'sol') return 'solana';
  return NEAR_ONLY[chain.family] ?? null;
}

/** EVM / Solana: same-chain swaps (0x, LI.FI, Jupiter) on every network. */
const sameChainSwaps = (chain: Chain | undefined) => chain?.family === 'evm' || chain?.family === 'sol';

/**
 * Can a swap START on this chain? EVM / Solana: always (testnet: same chain only). Bitcoin,
 * Litecoin, Dogecoin, TRON, XRP, Cardano: mainnet only, through NEAR Intents (no testnet routes).
 */
export function canSwapFrom(chain: Chain | undefined, network: Network = 'mainnet'): boolean {
  if (sameChainSwaps(chain)) return true;
  return network === 'mainnet' && swapChainOf(chain) !== null;
}

/**
 * Can a swap from `from` ARRIVE on `to`? Same chain: EVM / Solana always, TRON (TRX ⇄ USDT) on
 * mainnet. Another chain: mainnet only (LI.FI and NEAR Intents have no testnet routes).
 */
export function canSwapTo(network: Network, from: Chain | undefined, to: Chain | undefined): boolean {
  if (!from || !to || !canSwapFrom(from, network)) return false;
  if (from.key === to.key) return sameChainSwaps(from) || network === 'mainnet';
  return network === 'mainnet' && swapChainOf(to) !== null;
}

export interface OwnAccounts {
  evm?: { address: string };
  sol?: { address: string };
  btc?: { segwit: { address: string } };
  ltc?: { address: string };
  doge?: { address: string };
  tron?: { address: string };
  xrp?: { address: string };
  cardano?: { address: string };
}

/**
 * Our own receiving address on `chain` (the selected account). Bitcoin: the native SegWit
 * (`bc1q…`) receive address, the only form a cross-chain bridge call can carry unambiguously.
 * Litecoin: `ltc1…`; Dogecoin: `D…`; TRON: `T…`; XRP: the classic `r…` address (no tag: your own
 * account); Cardano: the base address `addr1…`.
 */
export function ownAddressOn(accounts: OwnAccounts, chain: Chain | undefined): string | null {
  if (!chain) return null;
  switch (chain.family) {
    case 'evm':
      return accounts.evm?.address || null;
    case 'sol':
      return accounts.sol?.address || null;
    case 'btc':
      return accounts.btc?.segwit.address || null;
    case 'ltc':
      return accounts.ltc?.address || null;
    case 'doge':
      return accounts.doge?.address || null;
    case 'tron':
      return accounts.tron?.address || null;
    case 'xrp':
      return accounts.xrp?.address || null;
    case 'ada':
      return accounts.cardano?.address || null;
    default:
      // Chains NEAR Intents / LI.FI routes do not cover in Kyro yet.
      return null;
  }
}

/**
 * Token id as the swap providers name it: ERC-20 / mint / TRC-20 contract, `0xEeee…`, the wSOL
 * mint, or the chain's name for the native coin of the NEAR-only chains (`bitcoin`, `tron`…).
 */
export function swapTokenAddress(a: AssetDef): string {
  if (a.kind === 'native') {
    if (a.family === 'evm') return NATIVE_EVM_TOKEN;
    if (a.family === 'sol') return NATIVE_SOL_MINT;
    return String(NEAR_ONLY[a.family] ?? a.family);
  }
  return a.contract ?? '';
}

export interface BuyGroup {
  chain: Chain;
  assets: AssetDef[];
}

/**
 * « Tu reçois » list: the sell chain first, then every other chain a swap can arrive on, each
 * with its assets (read-only assets and the sold asset left out).
 */
export function buyGroups(network: Network, chains: Chain[], assets: AssetDef[], sell: AssetDef | undefined): BuyGroup[] {
  const from = chains.find((c) => c.key === sell?.chainKey);
  const ordered = [...chains].sort((a, b) => (a.key === from?.key ? -1 : b.key === from?.key ? 1 : 0));
  return ordered
    .filter((c) => canSwapTo(network, from, c))
    .map((chain) => ({ chain, assets: assets.filter((a) => a.chainKey === chain.key && a.id !== sell?.id && !a.readOnly && (a.family !== 'ada' || a.kind === 'native')) }))
    .filter((g) => g.assets.length > 0);
}

/** History label of a cross-chain transfer (li.quest `/v1/status`, or 1Click's own status). */
export function crossStatusLabel(status: string | undefined, toChainLabel: string): string {
  switch (status) {
    case 'DONE':
    case 'SUCCESS':
      return `arrivé sur ${toChainLabel}`;
    case 'FAILED':
      return 'échec du pont, remboursement prévu sur ton adresse de départ';
    case 'REFUNDED':
      return 'remboursé sur ton adresse de départ';
    case 'INCOMPLETE_DEPOSIT':
      return 'dépôt incomplet, remboursement prévu sur ton adresse de départ';
    default:
      return `en route vers ${toChainLabel}`;
  }
}

/** The decodings a deposit transfer is checked against (EVM / Solana: Rust's, obtained by the caller). */
export interface DepositDecoded {
  evm?: EvmTxSummary | null;
  sol?: SolTxSummary | null;
}

/**
 * The ordinary transfer Kyro built for a NEAR Intents deposit must do EXACTLY what 1Click
 * confirmed: send `plan.amountIn` of the sold token to `plan.depositAddress`, and nothing else
 * (Bitcoin / Litecoin / Dogecoin: one payment, the rest back to our change, no OP_RETURN, no
 * unknown script; TRON: a plain TRX / TRC-20 transfer of that token, no memo; XRP: no tag, no
 * memo, no path / SendMax; Cardano: ADA only, no token, no message). Returns the problem in
 * French, or null when it matches.
 */
export function depositTxProblem(u: AnyUnsigned, sell: AssetDef, plan: Pick<DepositPlan, 'depositAddress' | 'amountIn'>, decoded: DepositDecoded = {}): string | null {
  const to = plan.depositAddress;
  if (u.recipient !== to && !(u.family === 'evm' && u.recipient.toLowerCase() === to.toLowerCase())) return 'destinataire différent de l’adresse de dépôt confirmée';
  if (u.amount !== plan.amountIn) return 'montant différent de celui confirmé par le pont';
  switch (u.family) {
    case 'btc': {
      const outs = u.summary.outputs;
      if (u.summary.warnings.length > 0 || outs.some(([a]) => a.startsWith('op_return:') || a.startsWith('script:'))) return 'sortie inattendue (OP_RETURN ou script inconnu) : refusée';
      const pay = outs.filter(([, , change]) => !change);
      if (pay.length !== 1 || pay[0]?.[0] !== to || BigInt(pay[0][1]) !== plan.amountIn) return 'la transaction ne paie pas exactement l’adresse de dépôt';
      return null;
    }
    case 'evm': {
      const s = decoded.evm;
      if (!s) return 'décodage du coffre absent';
      const token = sell.kind === 'erc20' ? sell.contract ?? '' : null;
      const kindOk = token ? s.kind === 'Erc20Transfer' && (s.tokenContract ?? '').toLowerCase() === token.toLowerCase() && u.tx.to.toLowerCase() === token.toLowerCase() : s.kind === 'NativeTransfer' && u.tx.to.toLowerCase() === to.toLowerCase();
      if (!kindOk || s.to.toLowerCase() !== to.toLowerCase() || s.amount !== plan.amountIn.toString()) return 'le décodage du coffre ne correspond pas au dépôt confirmé';
      return null;
    }
    case 'sol': {
      const s = decoded.sol;
      if (!s) return 'décodage du coffre absent';
      const moves = s.instructions.filter((i) => i.type === 'systemTransfer' || i.type === 'tokenTransfer');
      const m = moves[0];
      if (moves.length !== 1 || !m) return 'la transaction contient plusieurs transferts';
      if (m.type === 'systemTransfer') return sell.kind === 'native' && m.to === to && m.lamports === plan.amountIn.toString() ? null : 'transfert de SOL différent du dépôt confirmé';
      if (m.type === 'tokenTransfer') return sell.kind === 'spl' && m.checked && m.mint === sell.contract && m.destination === u.destinationTokenAccount && m.amount === plan.amountIn.toString() ? null : 'transfert de token différent du dépôt confirmé';
      return 'transfert inattendu';
    }
    case 'tron': {
      const a = u.summary.action;
      if (u.summary.memo || u.summary.warnings.length > 0) return 'mémo ou avertissement inattendu';
      if (sell.kind === 'trc20') return a.type === 'trc20Transfer' && a.contract === sell.contract && a.to === to && a.amount === plan.amountIn.toString() && a.callValue === '0' ? null : 'transfert TRC-20 différent du dépôt confirmé';
      return a.type === 'trxTransfer' && a.to === to && a.amount === plan.amountIn.toString() ? null : 'transfert TRX différent du dépôt confirmé';
    }
    case 'xrp': {
      const s = u.summary;
      if (s.destination !== to || s.destinationTag !== null || s.memos.length > 0 || s.sendMax || s.warnings.length > 0) return 'paiement XRP différent du dépôt confirmé (tag, mémo ou chemin inattendu)';
      return s.amount.kind === 'xrp' && s.amount.drops === plan.amountIn.toString() ? null : 'montant XRP différent du dépôt confirmé';
    }
    case 'ada': {
      const s = u.summary;
      if (u.token || u.memo || s.memo || s.warnings.length > 0) return 'token, message ou avertissement inattendu';
      const pay = s.outputs.filter((o) => !o.isChange);
      if (pay.length !== 1 || pay[0]?.address !== to || pay[0].lovelace !== plan.amountIn.toString() || pay[0].tokens.length > 0) return 'la transaction ne paie pas exactement l’adresse de dépôt';
      return null;
    }
    default:
      return 'chaîne non prise en charge pour un dépôt NEAR Intents';
  }
}

/** The vault adapter that sends `asset` (a NEAR Intents deposit is an ordinary transfer). */
export function depositAdapterFor(asset: AssetDef, adapters: Pick<AdapterSet, 'btc' | 'evm' | 'sol' | 'ltc' | 'doge' | 'tron' | 'xrp' | 'cardano'>): AnyAdapter | undefined {
  switch (asset.family) {
    case 'btc':
      return adapters.btc ?? undefined;
    case 'sol':
      return adapters.sol ?? undefined;
    case 'ltc':
      return adapters.ltc ?? undefined;
    case 'doge':
      return adapters.doge ?? undefined;
    case 'tron':
      return adapters.tron ?? undefined;
    case 'xrp':
      return adapters.xrp ?? undefined;
    case 'ada':
      return adapters.cardano ?? undefined;
    default:
      return adapters.evm.get(asset.chainKey);
  }
}

/** A NEAR Intents deposit ready to sign: 1Click's confirmed plan and the transfer Kyro built for it. */
export interface PreparedDeposit {
  plan: DepositPlan;
  unsigned: AnyUnsigned;
  decoded: DepositDecoded;
}

const stop = (why: string) => new Error(`${why} Arrêt, rien n’a été signé.`);

/**
 * NEAR Intents: the ordinary transfer of `plan.amountIn` to the deposit address 1Click confirmed,
 * built by the chain's own adapter, decoded by Rust (EVM / Solana: `evm_decode_tx` /
 * `sol_decode_tx`; the other chains are decoded again by Rust in the native dialog) and checked
 * against the plan (`depositTxProblem`). Throws in French; nothing is signed here.
 */
export async function buildDepositTx(sell: AssetDef, adapters: Pick<AdapterSet, 'btc' | 'evm' | 'sol' | 'ltc' | 'doge' | 'tron' | 'xrp' | 'cardano'>, plan: DepositPlan): Promise<PreparedDeposit> {
  const ad = depositAdapterFor(sell, adapters);
  if (!ad) throw new Error('Pas de compte sur cette chaîne dans ce portefeuille.');
  if (!ad.isValidAddress(plan.depositAddress)) throw stop('NEAR Intents : adresse de dépôt invalide pour cette chaîne.');
  if (ad.family === 'xrp' && adapters.xrp) {
    const dest = await adapters.xrp.destinationInfo(plan.depositAddress);
    if (dest.requireDestTag) throw stop('NEAR Intents : l’adresse de dépôt XRP exige un tag.');
  }
  const fee = (await ad.estimateFees()).options.normal.params;
  const unsigned = (await (ad as { buildTx: (p: unknown) => Promise<AnyUnsigned> }).buildTx({ asset: sell, to: plan.depositAddress, amount: plan.amountIn, fee })) as AnyUnsigned;
  const decoded: DepositDecoded = {};
  // Rust's decoding (the concrete EVM / Solana adapters of the set; `ad` is the same object).
  const evmAd = unsigned.family === 'evm' ? adapters.evm.get(sell.chainKey) : undefined;
  if (unsigned.family === 'evm' && evmAd) decoded.evm = await evmAd.decode(unsigned);
  if (unsigned.family === 'sol' && adapters.sol) {
    const sol = await adapters.sol.decode(unsigned);
    decoded.sol = sol;
    const problem = checkSolSummary(unsigned, sol, adapters.sol.getAddress());
    if (problem) throw stop(problem);
  }
  const problem = depositTxProblem(unsigned, sell, plan, decoded);
  if (problem) throw stop(`Dépôt NEAR Intents : ${problem}.`);
  if (unsigned.family === 'tron' && !tronCoverage(unsigned.estimate, unsigned.token ? 0n : unsigned.amount).expected) throw new Error('TRX insuffisant pour les frais réseau de ce transfert.');
  return { plan, unsigned, decoded };
}
