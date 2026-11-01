// SPDX-License-Identifier: GPL-3.0-or-later
//
// What Kyro checks in an aggregator's EVM answer BEFORE it is shown, and again on the fresh quote
// right before signing. The aggregator builds the transaction; Rust only decodes « contract call »
// for it. So the TypeScript side decodes the calldata itself and refuses anything that does not
// match what the user asked for:
//
// - `to` and the ERC-20 spender are the provider's OFFICIAL entry contract on this chain (fixed
//   list below, from the providers' own deployment records) — never an address taken from the
//   answer alone;
// - the native value sent is 0 for an ERC-20 sale and exactly the amount for a native sale;
// - the recipient written in the calldata is the taker (us), the minimum written in the calldata
//   is at least `buyAmount` minus the chosen slippage;
// - the Kyro fee goes to the configured recipient, at most at the configured rate.
//
// Sources (checked 01/11/2026):
// - 0x: docs.0x.org « Contracts » (AllowanceHolder on Cancun chains), 0x-settler README and
//   interfaces (`IAllowanceHolder.exec`, `ISettlerTakerSubmitted.execute`, `AllowedSlippage`,
//   deployer/registry `ownerOf(2)` / `prev(2)` for the current taker-submitted Settler).
// - LI.FI: github.com/lifinance/contracts `deployments/<chain>.json` (LiFiDiamond, FeeForwarder),
//   `GenericSwapFacetV3.sol`, `LibSwap.SwapData`, `Periphery/FeeForwarder.sol`; calldata checked
//   against two live li.quest quotes (Arbitrum USDC → ETH, Base ETH → USDC).

import { decodeFunctionData, getAddress, isAddress, parseAbi, type Hex } from 'viem';
import type { ProviderFee } from './fees';
import { applySlippage } from './compare';
import { NATIVE_EVM, ZERO_ADDRESS, isNative } from './providers/common';
import type { ProviderId, SwapToken } from './types';

/** 0x AllowanceHolder on Cancun chains (Ethereum, Arbitrum, Optimism, Base, Polygon, BSC, Avalanche, Sonic, HyperEVM). */
export const ZEROX_ALLOWANCE_HOLDER = '0x0000000000001fF3684f28c67538d4D072C22734';
/** 0x deployer / Settler registry (ERC-721-like: `ownerOf(featureId)` is the current Settler), same address on all chains. */
export const ZEROX_SETTLER_REGISTRY = '0x00000000000004533Fe15556B1E086BB1A72cEae';
/** Feature id of the taker-submitted Settler (the one AllowanceHolder.exec targets). */
export const ZEROX_TAKER_SETTLER_FEATURE = 2n;
/** LI.FI Diamond (`LiFiDiamond` in deployments/<chain>.json) on every chain listed in {@link LIFI_CHECKED_CHAINS}. */
export const LIFI_DIAMOND = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE';
/** LI.FI FeeForwarder (`FeeForwarder` in deployments/<chain>.json): pays `distributionFees`. Mantle has its own. */
export const LIFI_FEE_FORWARDER = '0xCE40449B773a3E6E5e769ADb4e567179d4828cbd';
/** LI.FI FeeForwarder on Mantle (deployments/mantle.json; the default address has no code there). */
export const LIFI_FEE_FORWARDER_MANTLE = '0x79C3F5B651Ee5782Ba15d968B088458cd5f1f4EF';

/*
 * Mainnet chains where those addresses were checked (01/11/2026: deployment records above, plus
 * `eth_getCode` non-empty at each address on the chain's registry RPC). Anything else (testnets,
 * chains not listed) has no known contract and its quotes are refused.
 * - 0x: also Sonic (docs.0x.org « Contracts », Cancun list) and HyperEVM (0x-settler README,
 *   Cancun list). Not Mantle: it is a Shanghai chain with another AllowanceHolder
 *   (0x0000000000005E88410CcDFaDe4a5EfaE4b49562), not offered rather than trusted on one reading.
 * - LI.FI: also Cronos, Mantle, Sonic, Gnosis, Sei (same Diamond; Mantle's FeeForwarder differs).
 *   Not Flare, Kaia nor HyperEVM: their Diamond is another address (0x198F…, 0x1255…, 0x0a07…).
 */
const ZEROX_CHECKED_CHAINS = [1, 10, 56, 137, 8_453, 42_161, 43_114, 146, 999] as const;
const LIFI_CHECKED_CHAINS = [1, 10, 56, 137, 8_453, 42_161, 43_114, 25, 5_000, 146, 100, 1_329] as const;

export interface SwapContracts {
  zerox?: { allowanceHolder: string };
  lifi?: { diamond: string; feeForwarder: string };
}

export const SWAP_CONTRACTS: Readonly<Record<number, SwapContracts>> = (() => {
  const t: Record<number, SwapContracts> = {};
  for (const id of ZEROX_CHECKED_CHAINS) t[id] = { ...t[id], zerox: { allowanceHolder: ZEROX_ALLOWANCE_HOLDER } };
  for (const id of LIFI_CHECKED_CHAINS) t[id] = { ...t[id], lifi: { diamond: LIFI_DIAMOND, feeForwarder: id === 5_000 ? LIFI_FEE_FORWARDER_MANTLE : LIFI_FEE_FORWARDER } };
  return t;
})();

/** The provider's entry contract (also the ERC-20 spender) on `chainId`, or null when Kyro knows none. */
export function knownSwapContract(provider: ProviderId, chainId: number): string | null {
  const c = SWAP_CONTRACTS[chainId];
  if (provider === 'zerox') return c?.zerox?.allowanceHolder ?? null;
  if (provider === 'lifi') return c?.lifi?.diamond ?? null;
  return null;
}

export const ZEROX_ABI = parseAbi([
  'function exec(address operator, address token, uint256 amount, address target, bytes data) payable returns (bytes)',
  'function execute((address recipient, address buyToken, uint256 minAmountOut) slippage, bytes[] actions, bytes32 zid) payable returns (bool)',
]);
export const ZEROX_REGISTRY_ABI = parseAbi(['function ownerOf(uint256 tokenId) view returns (address)', 'function prev(uint128 featureId) view returns (address)']);

const SWAP_DATA = '(address callTo, address approveTo, address sendingAssetId, address receivingAssetId, uint256 fromAmount, bytes callData, bool requiresDeposit)';
export const LIFI_ABI = parseAbi([
  `function swapTokensSingleV3ERC20ToERC20(bytes32 transactionId, string integrator, string referrer, address receiver, uint256 minAmountOut, ${SWAP_DATA} swapData)`,
  `function swapTokensSingleV3ERC20ToNative(bytes32 transactionId, string integrator, string referrer, address receiver, uint256 minAmountOut, ${SWAP_DATA} swapData)`,
  `function swapTokensSingleV3NativeToERC20(bytes32 transactionId, string integrator, string referrer, address receiver, uint256 minAmountOut, ${SWAP_DATA} swapData)`,
  `function swapTokensMultipleV3ERC20ToERC20(bytes32 transactionId, string integrator, string referrer, address receiver, uint256 minAmountOut, ${SWAP_DATA}[] swapData)`,
  `function swapTokensMultipleV3ERC20ToNative(bytes32 transactionId, string integrator, string referrer, address receiver, uint256 minAmountOut, ${SWAP_DATA}[] swapData)`,
  `function swapTokensMultipleV3NativeToERC20(bytes32 transactionId, string integrator, string referrer, address receiver, uint256 minAmountOut, ${SWAP_DATA}[] swapData)`,
  `function swapTokensGeneric(bytes32 transactionId, string integrator, string referrer, address receiver, uint256 minAmountOut, ${SWAP_DATA}[] swapData)`,
]);
export const LIFI_FEE_FORWARDER_ABI = parseAbi([
  'function forwardERC20Fees(address token, (address recipient, uint256 amount)[] distributions)',
  'function forwardNativeFees((address recipient, uint256 amount)[] distributions) payable',
]);

/** LI.FI's own service fee (0,25 %, docs/SWAP_FEES.md) + margin: the most the FeeForwarder may pay out in total, on top of the Kyro fee. */
const LIFI_OWN_FEE_CAP_BPS = 50n;

export class SwapCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SwapCheckError';
  }
}

export interface EvmSwapCheckInput {
  provider: Extract<ProviderId, 'zerox' | 'lifi'>;
  chainId: number;
  sell: SwapToken;
  buy: SwapToken;
  sellAmount: bigint;
  taker: string;
  slippageBps: number;
  /** Amount announced by the provider (after fees). */
  buyAmount: bigint;
  tx: { to: string; data: Hex; value: bigint };
  /** ERC-20 spender the answer asks to approve (null for a native sale). */
  allowanceTarget: string | null;
  fee: ProviderFee;
  /** 0x only: `fees.integratorFee` of the answer. */
  integratorFee?: { amount: bigint; token: string } | null;
}

export interface EvmSwapCheck {
  /** Entry contract = `to` = ERC-20 spender (checksummed). */
  contract: string;
  /** Recipient written in the calldata (= taker). */
  recipient: string;
  /** Minimum written in the calldata, the one the contract enforces. */
  minBuyAmount: bigint;
  /** 0x: Settler targeted by AllowanceHolder.exec, to confirm against the on-chain registry before signing. */
  settler?: string;
  /** Kyro fee read from the calldata (LI.FI) or the answer (0x), base units of the sold token. */
  kyroFee?: bigint;
}

const same = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && isAddress(a, { strict: false }) && isAddress(b, { strict: false }) && getAddress(a) === getAddress(b);
const fail = (provider: string, why: string): never => {
  throw new SwapCheckError(`${provider} : ${why} — devis refusé.`);
};
/** Most the Kyro fee may be: ceil(sellAmount × bps / 10 000). */
export const maxKyroFee = (sellAmount: bigint, bps: number) => (sellAmount * BigInt(bps) + 9_999n) / 10_000n;
/** min ≥ buyAmount − slippage, with 1 bp of rounding tolerance. */
const minOk = (min: bigint, buyAmount: bigint, slippageBps: number) => min > 0n && min >= applySlippage(buyAmount, Math.min(10_000, slippageBps + 1));

function decode<A extends Parameters<typeof decodeFunctionData>[0]['abi']>(abi: A, data: Hex) {
  try {
    return decodeFunctionData({ abi, data });
  } catch {
    return null;
  }
}

/** Checks one EVM swap answer. Throws `SwapCheckError` (French message) on any mismatch. */
export function verifyEvmSwap(i: EvmSwapCheckInput): EvmSwapCheck {
  const name = i.provider === 'zerox' ? '0x' : 'LI.FI';
  const contract = knownSwapContract(i.provider, i.chainId);
  if (!contract) fail(name, `aucun contrat ${name} connu de Kyro sur ce réseau (chaîne ${i.chainId})`);
  const entry = contract as string;
  if (!same(i.tx.to, entry)) fail(name, `contrat inattendu (${i.tx.to}) au lieu de ${entry}`);
  const nativeSell = isNative(i.sell.address);
  if (nativeSell) {
    if (i.allowanceTarget !== null) fail(name, 'autorisation demandée pour une vente native');
    if (i.tx.value !== i.sellAmount) fail(name, `valeur envoyée (${i.tx.value}) différente du montant vendu`);
  } else {
    if (!same(i.allowanceTarget, entry)) fail(name, `autorisation demandée pour ${i.allowanceTarget ?? '?'} au lieu de ${entry}`);
    if (i.tx.value !== 0n) fail(name, 'valeur native envoyée avec une vente de token');
  }
  return i.provider === 'zerox' ? checkZeroEx(i, name, entry) : checkLifi(i, name, entry);
}

function checkZeroEx(i: EvmSwapCheckInput, name: string, entry: string): EvmSwapCheck {
  const exec = decode(ZEROX_ABI, i.tx.data);
  if (!exec || exec.functionName !== 'exec') return fail(name, 'calldata illisible (exec AllowanceHolder attendu)');
  const [operator, token, amount, target, inner] = exec.args as readonly [string, string, bigint, string, Hex];
  if (!same(operator, target)) fail(name, 'opérateur différent du contrat appelé');
  if (!isNative(i.sell.address)) {
    if (!same(token, i.sell.address)) fail(name, 'token autorisé différent du token vendu');
    if (amount !== i.sellAmount) fail(name, 'montant autorisé différent du montant vendu');
  }
  const ex = decode(ZEROX_ABI, inner);
  if (!ex || ex.functionName !== 'execute') return fail(name, 'calldata Settler illisible (execute attendu)');
  const [slippage, actions] = ex.args as readonly [{ recipient: string; buyToken: string; minAmountOut: bigint }, readonly Hex[], Hex];
  if (!same(slippage.recipient, i.taker)) fail(name, `destinataire ${slippage.recipient} au lieu de ton adresse`);
  const buyOk = isNative(i.buy.address) ? same(slippage.buyToken, NATIVE_EVM) || same(slippage.buyToken, ZERO_ADDRESS) : same(slippage.buyToken, i.buy.address);
  if (!buyOk) fail(name, 'token reçu différent de celui demandé');
  if (!minOk(slippage.minAmountOut, i.buyAmount, i.slippageBps)) fail(name, 'minimum garanti plus bas que le slippage choisi');
  const out: EvmSwapCheck = { contract: getAddress(entry), recipient: getAddress(slippage.recipient), minBuyAmount: slippage.minAmountOut, settler: getAddress(target) };
  if (i.fee.kind === 'fee') {
    const f = i.integratorFee;
    if (!f || f.amount <= 0n) fail(name, 'frais Kyro non appliqués par le devis');
    const fee = f as { amount: bigint; token: string };
    if (!same(fee.token, i.sell.address) && !(isNative(i.sell.address) && isNative(fee.token))) fail(name, 'frais Kyro pris dans un autre token que le token vendu');
    if (fee.amount > maxKyroFee(i.sellAmount, i.fee.bps)) fail(name, 'frais Kyro supérieurs au taux configuré');
    // The fee recipient must be written somewhere in the Settler actions (the fee transfer).
    const needle = i.fee.recipient.toLowerCase().replace(/^0x/, '');
    if (!actions.some((a) => a.toLowerCase().includes(needle))) fail(name, 'bénéficiaire des frais Kyro absent de la transaction');
    out.kyroFee = fee.amount;
  }
  return out;
}

interface SwapData {
  callTo: string;
  approveTo: string;
  sendingAssetId: string;
  receivingAssetId: string;
  fromAmount: bigint;
  callData: Hex;
  requiresDeposit: boolean;
}

function checkLifi(i: EvmSwapCheckInput, name: string, entry: string): EvmSwapCheck {
  const d = decode(LIFI_ABI, i.tx.data);
  if (!d) return fail(name, 'fonction du Diamond inconnue de Kyro (swap sur une seule chaîne attendu)');
  const [, , , receiver, minAmountOut, sd] = d.args as readonly [Hex, string, string, string, bigint, SwapData | readonly SwapData[]];
  const steps: readonly SwapData[] = Array.isArray(sd) ? (sd as readonly SwapData[]) : [sd as SwapData];
  if (steps.length === 0) fail(name, 'aucune étape de swap');
  if (!same(receiver, i.taker)) fail(name, `destinataire ${receiver} au lieu de ton adresse`);
  if (!minOk(minAmountOut, i.buyAmount, i.slippageBps)) fail(name, 'minimum garanti plus bas que le slippage choisi');
  const asset = (t: SwapToken) => (isNative(t.address) ? ZERO_ADDRESS : t.address);
  const first = steps[0] as SwapData;
  const last = steps[steps.length - 1] as SwapData;
  if (!same(first.sendingAssetId, asset(i.sell)) || first.fromAmount !== i.sellAmount) fail(name, 'première étape différente du token ou du montant vendus');
  if (!same(last.receivingAssetId, asset(i.buy))) fail(name, 'dernière étape différente du token demandé');
  const out: EvmSwapCheck = { contract: getAddress(entry), recipient: getAddress(receiver), minBuyAmount: minAmountOut };
  const forwarder = SWAP_CONTRACTS[i.chainId]?.lifi?.feeForwarder ?? '';
  const feeSteps = steps.filter((s) => same(s.callTo, forwarder));
  let kyro = 0n;
  let total = 0n;
  for (const s of feeSteps) {
    const f = decode(LIFI_FEE_FORWARDER_ABI, s.callData);
    if (!f) return fail(name, 'étape de frais illisible');
    const dist = (f.functionName === 'forwardERC20Fees' ? f.args[1] : f.args[0]) as readonly { recipient: string; amount: bigint }[];
    if (f.functionName === 'forwardERC20Fees' && !same(f.args[0] as string, i.sell.address)) fail(name, 'frais pris dans un autre token que le token vendu');
    if (f.functionName === 'forwardNativeFees' && !isNative(i.sell.address)) fail(name, 'frais natifs sur une vente de token');
    for (const x of dist) {
      total += x.amount;
      if (i.fee.kind === 'fee' && same(x.recipient, i.fee.recipient)) kyro += x.amount;
    }
  }
  if (i.fee.kind === 'fee') {
    if (kyro <= 0n) fail(name, 'frais Kyro absents de la transaction');
    if (kyro > maxKyroFee(i.sellAmount, i.fee.bps)) fail(name, 'frais Kyro supérieurs au taux configuré');
    out.kyroFee = kyro;
  }
  const kyroBps = i.fee.kind === 'fee' ? BigInt(i.fee.bps) : 0n;
  if (total > (i.sellAmount * (kyroBps + LIFI_OWN_FEE_CAP_BPS) + 9_999n) / 10_000n) fail(name, 'frais prélevés au total plus élevés que prévu');
  return out;
}

/**
 * The fresh quote fetched right before signing, against the one the user reviewed: the contract
 * and the spender must not change (refused); a lower guaranteed minimum is `degraded` (the UI asks
 * again instead of accepting it silently).
 */
export function compareFreshQuote(
  reviewed: { allowanceTarget: string | null; minBuyAmount: bigint; tx: { kind: 'evm'; to: string } },
  fresh: { allowanceTarget: string | null; minBuyAmount: bigint; tx: { kind: 'evm'; to: string } },
): { ok: true; degraded: boolean } | { ok: false; reason: string } {
  if (!same(reviewed.tx.to, fresh.tx.to)) return { ok: false, reason: `Le nouveau devis appelle un autre contrat (${fresh.tx.to}) : arrêt.` };
  if ((reviewed.allowanceTarget ?? null) !== (fresh.allowanceTarget ?? null) && !same(reviewed.allowanceTarget, fresh.allowanceTarget)) {
    return { ok: false, reason: 'Le nouveau devis demande une autorisation pour un autre contrat : arrêt.' };
  }
  return { ok: true, degraded: fresh.minBuyAmount < reviewed.minBuyAmount };
}

/** Is `settler` the registry's current (`ownerOf`) or previous (`prev`) taker-submitted Settler? */
export async function isCurrentZeroExSettler(settler: string, read: (fn: 'ownerOf' | 'prev') => Promise<string>): Promise<boolean> {
  const current = await read('ownerOf');
  if (same(current, settler)) return true;
  try {
    return same(await read('prev'), settler);
  } catch {
    return false;
  }
}
