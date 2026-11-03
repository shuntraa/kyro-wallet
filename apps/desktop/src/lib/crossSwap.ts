// SPDX-License-Identifier: GPL-3.0-or-later
// Swap screen helpers: which chains a swap can start from / arrive on, our own address there (never
// typed: the destination of a cross-chain swap is always one of your accounts), the « Tu reçois »
// list grouped by chain, the label of a cross-chain transfer's status, and the check of the
// ordinary transfer Kyro builds for a NEAR Intents deposit (before the password).

import { checkSolSummary, NATIVE_EVM_TOKEN, NATIVE_SOL_MINT, tronCoverage, type AdapterSet, type AnyAdapter, type AnyUnsigned, type AssetDef, type Chain } from '@kyro/chains';
import { sameTonAccount, type EvmTxSummary, type Network, type SolTxSummary } from '@kyro/shared';
import { evmSwapSupported, EXOLIX_ARRIVAL_ONLY, EXOLIX_CHAINS, EXOLIX_ONLY, exolixFeeRecipients, exolixRoute, ONE_CLICK_ARRIVAL_ONLY, ONE_CLICK_CHAINS, type DepositPlan, type SwapChain } from '@kyro/swap';
import { t } from '../i18n';

const NEAR_ONLY: Partial<Record<Chain['family'], SwapChain>> = {
  btc: 'bitcoin',
  ltc: 'litecoin',
  doge: 'dogecoin',
  bch: 'bitcoincash',
  dash: 'dash',
  zec: 'zcash',
  tron: 'tron',
  xrp: 'xrp',
  ada: 'cardano',
  sui: 'sui',
  ton: 'ton',
  apt: 'aptos',
  xlm: 'stellar',
  // Exolix only (1Click does not list them). Kaspa, Algorand, NEAR: arrival only.
  xmr: 'monero',
  kas: 'kaspa',
  algo: 'algorand',
  near: 'near',
};

const oneClickServes = (c: SwapChain | null) => c !== null && ONE_CLICK_CHAINS[String(c)] !== undefined;
/** Exolix: an Exolix-only chain (Monero, Kaspa…) on one side, a mapped chain on the other. */
const exolixPair = exolixRoute;

/** The swap id of a chain: EVM chain id, 'solana', 'bitcoin', 'litecoin'…; null when swaps don't serve it. */
export function swapChainOf(chain: Chain | undefined): SwapChain | null {
  if (!chain) return null;
  if (chain.family === 'evm') return chain.chainId;
  if (chain.family === 'sol') return 'solana';
  return NEAR_ONLY[chain.family] ?? null;
}

/**
 * Same-chain swaps: Solana (Jupiter) and the EVM chains where 0x or LI.FI has a contract Kyro
 * checks (`evmSwapSupported`; on testnet every EVM chain is listed, its quotes are refused).
 */
const sameChainSwaps = (chain: Chain | undefined, network: Network) => chain?.family === 'sol' || (chain?.family === 'evm' && (network === 'testnet' || evmSwapSupported(chain.chainId)));

/** Can a swap START on this chain? */
export function canSwapFrom(chain: Chain | undefined, network: Network = 'mainnet'): boolean {
  if (sameChainSwaps(chain, network)) return true;
  const c = swapChainOf(chain);
  // Monero (Exolix): source only once Kyro has a Monero fee address (never fee-free).
  if (c === 'monero') return network === 'mainnet' && !!exolixFeeRecipients().monero;
  return network === 'mainnet' && c !== null && !ONE_CLICK_ARRIVAL_ONLY.has(c) && !EXOLIX_ARRIVAL_ONLY.has(c) && (chain?.family !== 'evm' || oneClickServes(c) || EXOLIX_CHAINS.has(c));
}

/** Can a swap from `from` ARRIVE on `to`? */
export function canSwapTo(network: Network, from: Chain | undefined, to: Chain | undefined): boolean {
  if (!from || !to || !canSwapFrom(from, network)) return false;
  if (from.key === to.key) return sameChainSwaps(from, network) || (network === 'mainnet' && from.family === 'tron');
  const a = swapChainOf(from);
  const b = swapChainOf(to);
  return network === 'mainnet' && ((oneClickServes(a) && oneClickServes(b)) || exolixPair(a, b));
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
  bch?: { address: string };
  dash?: { address: string };
  zec?: { address: string };
  sui?: { address: string };
  ton?: { address: string };
  aptos?: { address: string };
  stellar?: { address: string };
  xmr?: { address: string };
  kas?: { address: string };
  algo?: { address: string };
  near?: { address: string };
}

/** Our own receiving address on `chain` (the selected account). */
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
    case 'bch':
      return accounts.bch?.address || null;
    case 'dash':
      return accounts.dash?.address || null;
    case 'zec':
      return accounts.zec?.address || null;
    case 'sui':
      return accounts.sui?.address || null;
    case 'ton':
      return accounts.ton?.address || null;
    case 'apt':
      return accounts.aptos?.address || null;
    case 'xlm':
      return accounts.stellar?.address || null;
    case 'xmr':
      return accounts.xmr?.address || null;
    case 'kas':
      return accounts.kas?.address || null;
    case 'algo':
      return accounts.algo?.address || null;
    case 'near':
      return accounts.near?.address || null;
    default:
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

/** Exolix-only chains (Monero, Kaspa, Algorand, NEAR): only the native coin is mapped, both ways. */
const nativeOnlyArrival = (c: Chain) => {
  const id = swapChainOf(c);
  return id !== null && EXOLIX_ONLY.has(id);
};

/**
 * « Tu reçois » list: the sell chain first, then every other chain a swap can arrive on, each with
 * its assets (read-only assets and the sold asset left out).
 */
export function buyGroups(network: Network, chains: Chain[], assets: AssetDef[], sell: AssetDef | undefined): BuyGroup[] {
  const from = chains.find((c) => c.key === sell?.chainKey);
  const ordered = [...chains].sort((a, b) => (a.key === from?.key ? -1 : b.key === from?.key ? 1 : 0));
  return ordered
    .filter((c) => canSwapTo(network, from, c))
    .map((chain) => ({ chain, assets: assets.filter((a) => a.chainKey === chain.key && a.id !== sell?.id && !a.readOnly && ((a.family !== 'ada' && !nativeOnlyArrival(chain)) || a.kind === 'native')) }))
    .filter((g) => g.assets.length > 0);
}

/** A « Tu donnes » choice: an asset a swap can start from, or one shown greyed (« Bientôt »). */
export interface SellChoice {
  chain: Chain;
  asset: AssetDef;
  comingSoon: boolean;
}

/**
 * « Tu donnes » list across chains: every asset of a chain a swap can start from, then Monero greyed
 * while Kyro has no Monero fee address (Exolix source routes need one: never fee-free).
 */
export function sellChoices(network: Network, chains: Chain[], assets: AssetDef[]): SellChoice[] {
  const out: SellChoice[] = [];
  for (const chain of chains) {
    const open = canSwapFrom(chain, network);
    const soon = !open && network === 'mainnet' && chain.family === 'xmr';
    if (!open && !soon) continue;
    const nativeOnly = soon || nativeOnlyArrival(chain);
    for (const asset of assets) if (asset.chainKey === chain.key && !asset.readOnly && (!nativeOnly || asset.kind === 'native')) out.push({ chain, asset, comingSoon: soon });
  }
  return out;
}

/** A « You send » row of the unified picker: any of your assets, on any network, with its balance. */
export interface SendChoice extends SellChoice {
  balance: bigint;
}

/**
 * Unified « You send » list (Exodus-like, no network dropdown): every asset a swap can start from,
 * across all networks, with its balance; held assets first (stable order otherwise), greyed last.
 */
export function sendChoices(network: Network, chains: Chain[], assets: AssetDef[], balanceOf: (assetId: string) => bigint): SendChoice[] {
  const rank = (c: SendChoice) => (c.comingSoon ? 2 : c.balance > 0n ? 0 : 1);
  return sellChoices(network, chains, assets)
    .map((c) => ({ ...c, balance: balanceOf(c.asset.id) }))
    .map((c, i) => ({ c, i }))
    .sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i)
    .map(({ c }) => c);
}

/** A pick in the unified list sets the network implicitly: its chain and asset (null when greyed / unknown). */
export function pickSend(choices: SendChoice[], assetId: string): { chain: Chain; asset: AssetDef } | null {
  const c = choices.find((x) => x.asset.id === assetId && !x.comingSoon);
  return c ? { chain: c.chain, asset: c.asset } : null;
}

/** Rate of a quote: how many `buy` units for 1 `sell` unit (null without amounts). */
export function swapRate(sellAmount: bigint, sellDecimals: number, buyAmount: bigint, buyDecimals: number): number | null {
  if (sellAmount <= 0n || buyAmount <= 0n) return null;
  const r = Number(buyAmount) / 10 ** buyDecimals / (Number(sellAmount) / 10 ** sellDecimals);
  return Number.isFinite(r) && r > 0 ? r : null;
}

/** History label of a cross-chain transfer (li.quest `/v1/status`, or 1Click's own status). */
export function crossStatusLabel(status: string | undefined, toChainLabel: string): string {
  switch (status) {
    case 'DONE':
    case 'SUCCESS':
      return t('history.crossArrived', { chain: toChainLabel });
    case 'FAILED':
      return t('history.crossFailed');
    case 'REFUNDED':
      return t('history.crossRefunded');
    case 'INCOMPLETE_DEPOSIT':
      return t('history.crossIncompleteDeposit');
    default:
      return t('history.crossOnTheWay', { chain: toChainLabel });
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
 * unknown script; TRON: a plain TRX / TRC-20 transfer of that token, no memo; XRP: no tag, no memo,
 * no path / SendMax; Cardano: ADA only, no token, no message; Bitcoin Cash / Dash: like Bitcoin;
 * Zcash: one transparent payment, the rest back to our change; Sui / Aptos: one plain transfer of
 * the native coin; TON: no comment, not « whole balance »).
 */
export function depositTxProblem(u: AnyUnsigned, sell: AssetDef, plan: Pick<DepositPlan, 'depositAddress' | 'amountIn'>, decoded: DepositDecoded = {}): string | null {
  const to = plan.depositAddress;
  const hex = u.family === 'evm' || u.family === 'sui' || u.family === 'apt';
  if (u.recipient !== to && !(hex && u.recipient.toLowerCase() === to.toLowerCase())) return t('swap.depRecipientMismatch');
  if (u.amount !== plan.amountIn) return t('swap.depAmountMismatch');
  switch (u.family) {
    case 'btc': {
      const outs = u.summary.outputs;
      if (u.summary.warnings.length > 0 || outs.some(([a]) => a.startsWith('op_return:') || a.startsWith('script:'))) return t('swap.depUnexpectedOutput');
      const pay = outs.filter(([, , change]) => !change);
      if (pay.length !== 1 || pay[0]?.[0] !== to || BigInt(pay[0][1]) !== plan.amountIn) return t('swap.depNotExactPayment');
      return null;
    }
    case 'evm': {
      const s = decoded.evm;
      if (!s) return t('swap.depNoDecode');
      const token = sell.kind === 'erc20' ? sell.contract ?? '' : null;
      const kindOk = token ? s.kind === 'Erc20Transfer' && (s.tokenContract ?? '').toLowerCase() === token.toLowerCase() && u.tx.to.toLowerCase() === token.toLowerCase() : s.kind === 'NativeTransfer' && u.tx.to.toLowerCase() === to.toLowerCase();
      if (!kindOk || s.to.toLowerCase() !== to.toLowerCase() || s.amount !== plan.amountIn.toString()) return t('swap.depDecodeMismatch');
      return null;
    }
    case 'sol': {
      const s = decoded.sol;
      if (!s) return t('swap.depNoDecode');
      const moves = s.instructions.filter((i) => i.type === 'systemTransfer' || i.type === 'tokenTransfer');
      const m = moves[0];
      if (moves.length !== 1 || !m) return t('swap.depSeveralTransfers');
      if (m.type === 'systemTransfer') return sell.kind === 'native' && m.to === to && m.lamports === plan.amountIn.toString() ? null : t('swap.depSolMismatch');
      if (m.type === 'tokenTransfer') return sell.kind === 'spl' && m.checked && m.mint === sell.contract && m.destination === u.destinationTokenAccount && m.amount === plan.amountIn.toString() ? null : t('swap.depTokenMismatch');
      return t('swap.depUnexpectedTransfer');
    }
    case 'tron': {
      const a = u.summary.action;
      if (u.summary.memo || u.summary.warnings.length > 0) return t('swap.depUnexpectedMemo');
      if (sell.kind === 'trc20') return a.type === 'trc20Transfer' && a.contract === sell.contract && a.to === to && a.amount === plan.amountIn.toString() && a.callValue === '0' ? null : t('swap.depTrc20Mismatch');
      return a.type === 'trxTransfer' && a.to === to && a.amount === plan.amountIn.toString() ? null : t('swap.depTrxMismatch');
    }
    case 'xrp': {
      const s = u.summary;
      if (s.destination !== to || s.destinationTag !== null || s.memos.length > 0 || s.sendMax || s.warnings.length > 0) return t('swap.depXrpMismatch');
      return s.amount.kind === 'xrp' && s.amount.drops === plan.amountIn.toString() ? null : t('swap.depXrpAmountMismatch');
    }
    case 'ada': {
      const s = u.summary;
      if (u.token || u.memo || s.memo || s.warnings.length > 0) return t('swap.depAdaUnexpected');
      const pay = s.outputs.filter((o) => !o.isChange);
      if (pay.length !== 1 || pay[0]?.address !== to || pay[0].lovelace !== plan.amountIn.toString() || pay[0].tokens.length > 0) return t('swap.depNotExactPayment');
      return null;
    }
    case 'zec': {
      const s = u.summary;
      // ExpiryCapped (near a network upgrade) is informational; anything needing the 2nd window is refused.
      if (s.requiresExtraConfirmation || s.toKind === 'tex') return t('swap.depUnexpectedOutput');
      return s.to === to && s.toAddress === to && s.amount === plan.amountIn.toString() ? null : t('swap.depNotExactPayment');
    }
    case 'sui': {
      const s = u.summary;
      if (u.all || s.amount === null || s.warnings.length > 0) return t('swap.depUnexpectedTransfer');
      return s.recipient.toLowerCase() === to.toLowerCase() && s.coinType === '0x2::sui::SUI' && s.amount === plan.amountIn.toString() ? null : t('swap.depDecodeMismatch');
    }
    case 'apt': {
      const s = u.summary;
      if (s.warnings.length > 0) return t('swap.depUnexpectedTransfer');
      return s.recipient.toLowerCase() === to.toLowerCase() && s.function === '0x1::aptos_account::transfer' && s.amount === plan.amountIn.toString() ? null : t('swap.depDecodeMismatch');
    }
    case 'kas': {
      // One payment to the deposit address, the rest back to us as change; nothing else.
      const s = u.summary;
      if (s.warnings.length > 0 || s.requiresExtraConfirmation) return t('swap.depUnexpectedOutput');
      const pay = s.outputs.filter((o) => !o.isChange);
      return pay.length === 1 && pay[0]?.address === to && pay[0].amount === plan.amountIn.toString() ? null : t('swap.depNotExactPayment');
    }
    case 'algo': {
      // A plain ALGO payment: no note (a deposit memo is never needed by Exolix), no asset transfer.
      const s = u.summary;
      if (u.note || s.noteLen > 0 || s.asset || s.warnings.length > 0) return t('swap.depUnexpectedTransfer');
      return s.receiver === to && s.amount === plan.amountIn.toString() ? null : t('swap.depDecodeMismatch');
    }
    case 'near': {
      // One `Transfer` action of exactly the amount, no token call.
      const s = u.summary;
      if (s.token || s.warnings.length > 0) return t('swap.depUnexpectedTransfer');
      return s.receiverId === to && s.deposit === plan.amountIn.toString() ? null : t('swap.depDecodeMismatch');
    }
    case 'xmr': {
      // One payment to the deposit address (Rust built it; Rust decodes it again in the native dialog).
      const s = u.summary;
      return s.destination.address === to && s.amount === plan.amountIn.toString() ? null : t('swap.depNotExactPayment');
    }
    case 'ton': {
      const s = u.summary;
      if (u.comment || s.comment !== null || s.warnings.length > 0) return t('swap.depUnexpectedMemo');
      if (u.sendAll || s.sendAll) return t('swap.depUnexpectedTransfer');
      return sameTonAccount(s.destination, to) && s.amount === plan.amountIn.toString() ? null : t('swap.depDecodeMismatch');
    }
    default:
      return t('swap.depUnsupportedChain');
  }
}

/** The adapters a NEAR Intents deposit may go through. */
export type DepositAdapters = Pick<AdapterSet, 'btc' | 'evm' | 'sol' | 'ltc' | 'doge' | 'bch' | 'dash' | 'zec' | 'tron' | 'xrp' | 'cardano' | 'sui' | 'ton' | 'aptos' | 'xmr'> & Partial<Pick<AdapterSet, 'kaspa' | 'algo' | 'near'>>;

/** The vault adapter that sends `asset` (a NEAR Intents deposit is an ordinary transfer). */
export function depositAdapterFor(asset: AssetDef, adapters: DepositAdapters): AnyAdapter | undefined {
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
    case 'bch':
      return adapters.bch ?? undefined;
    case 'dash':
      return adapters.dash ?? undefined;
    case 'zec':
      return adapters.zec ?? undefined;
    case 'sui':
      return adapters.sui ?? undefined;
    case 'ton':
      return adapters.ton ?? undefined;
    case 'apt':
      return adapters.aptos ?? undefined;
    case 'xmr':
      return adapters.xmr ?? undefined;
    case 'kas':
      return adapters.kaspa ?? undefined;
    case 'algo':
      return adapters.algo ?? undefined;
    case 'near':
      return adapters.near ?? undefined;
    case 'evm':
      return adapters.evm.get(asset.chainKey);
    default:
      return undefined;
  }
}

/** A NEAR Intents deposit ready to sign: 1Click's confirmed plan and the transfer Kyro built for it. */
export interface PreparedDeposit {
  plan: DepositPlan;
  unsigned: AnyUnsigned;
  decoded: DepositDecoded;
}

const stop = (why: string) => new Error(t('swap.depStop', { why }));

/**
 * NEAR Intents: the ordinary transfer of `plan.amountIn` to the deposit address 1Click confirmed,
 * built by the chain's own adapter, decoded by Rust (EVM / Solana: `evm_decode_tx` /
 * `sol_decode_tx`; the other chains are decoded again by Rust in the native dialog) and checked
 * against the plan (`depositTxProblem`).
 */
export async function buildDepositTx(sell: AssetDef, adapters: DepositAdapters, plan: DepositPlan): Promise<PreparedDeposit> {
  if (plan.kyroFee && (plan.kyroFee.amount <= 0n || plan.kyroFee.recipient === plan.depositAddress)) throw stop(t('swap.depProblem', { problem: t('swap.depUnexpectedTransfer') }));
  return buildPlainTransfer(sell, adapters, plan);
}

/**
 * Exolix (no affiliate program): Kyro's fee, a second ordinary transfer of the sold coin to Kyro's
 * fee address on that chain, built and checked exactly like the deposit (sent right after it).
 */
export async function buildKyroFeeTx(sell: AssetDef, adapters: DepositAdapters, plan: DepositPlan): Promise<PreparedDeposit | null> {
  if (!plan.kyroFee) return null;
  return buildPlainTransfer(sell, adapters, { ...plan, depositAddress: plan.kyroFee.recipient, amountIn: plan.kyroFee.amount });
}

async function buildPlainTransfer(sell: AssetDef, adapters: DepositAdapters, plan: DepositPlan): Promise<PreparedDeposit> {
  const ad = depositAdapterFor(sell, adapters);
  if (!ad) throw new Error(t('swap.depNoAccount'));
  if (!ad.isValidAddress(plan.depositAddress)) throw stop(t('swap.depInvalidAddress'));
  if (ad.family === 'xrp' && adapters.xrp) {
    const dest = await adapters.xrp.destinationInfo(plan.depositAddress);
    if (dest.requireDestTag) throw stop(t('swap.depXrpTagRequired'));
  }
  const fee = (await ad.estimateFees()).options.normal.params;
  const unsigned = (await (ad as { buildTx: (p: unknown) => Promise<AnyUnsigned> }).buildTx({ asset: sell, to: plan.depositAddress, amount: plan.amountIn, fee })) as AnyUnsigned;
  const decoded: DepositDecoded = {};
  const evmAd = unsigned.family === 'evm' ? adapters.evm.get(sell.chainKey) : undefined;
  if (unsigned.family === 'evm' && evmAd) decoded.evm = await evmAd.decode(unsigned);
  if (unsigned.family === 'sol' && adapters.sol) {
    const sol = await adapters.sol.decode(unsigned);
    decoded.sol = sol;
    const problem = checkSolSummary(unsigned, sol, adapters.sol.getAddress());
    if (problem) throw stop(problem);
  }
  const problem = depositTxProblem(unsigned, sell, plan, decoded);
  if (problem) throw stop(t('swap.depProblem', { problem }));
  if (unsigned.family === 'tron' && !tronCoverage(unsigned.estimate, unsigned.token ? 0n : unsigned.amount).expected) throw new Error(t('swap.depTrxFees'));
  return { plan, unsigned, decoded };
}
