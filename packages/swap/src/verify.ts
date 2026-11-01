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

import { decodeFunctionData, getAddress, isAddress, pad, parseAbi, toHex, type Hex } from 'viem';
import { base58, bech32 } from '@scure/base';
import type { ProviderFee } from './fees';
import { applySlippage } from './compare';
import { NATIVE_EVM, WSOL_MINT, ZERO_ADDRESS, isNative } from './providers/common';
import type { ProviderId, SwapChain, SwapToken } from './types';

/** 0x AllowanceHolder, same address on every Cancun chain (Ethereum, Arbitrum, Optimism, Base, Polygon, BSC, Avalanche). */
export const ZEROX_ALLOWANCE_HOLDER = '0x0000000000001fF3684f28c67538d4D072C22734';
/** 0x deployer / Settler registry (ERC-721-like: `ownerOf(featureId)` is the current Settler). */
export const ZEROX_SETTLER_REGISTRY = '0x00000000000004533Fe15556B1E086BB1A72cEae';
/** Feature id of the taker-submitted Settler (the one AllowanceHolder.exec targets). */
export const ZEROX_TAKER_SETTLER_FEATURE = 2n;
/** LI.FI Diamond (`LiFiDiamond` in deployments/<chain>.json, same on all 7 chains). */
export const LIFI_DIAMOND = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE';
/** LI.FI FeeForwarder (`FeeForwarder` in deployments/<chain>.json): pays `distributionFees`. */
export const LIFI_FEE_FORWARDER = '0xCE40449B773a3E6E5e769ADb4e567179d4828cbd';

/** Mainnet chains where those addresses were checked. Anything else (testnets…) has no known contract. */
const CHECKED_CHAINS = [1, 10, 56, 137, 8453, 42161, 43114] as const;

export interface SwapContracts {
  zerox?: { allowanceHolder: string };
  lifi?: { diamond: string; feeForwarder: string };
}

export const SWAP_CONTRACTS: Readonly<Record<number, SwapContracts>> = Object.fromEntries(
  CHECKED_CHAINS.map((id) => [id, { zerox: { allowanceHolder: ZEROX_ALLOWANCE_HOLDER }, lifi: { diamond: LIFI_DIAMOND, feeForwarder: LIFI_FEE_FORWARDER } }]),
);

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
const BRIDGE_DATA = '(bytes32 transactionId, string bridge, string integrator, address referrer, address sendingAssetId, address receiver, uint256 minAmount, uint256 destinationChainId, bool hasSourceSwaps, bool hasDestinationCall)';
const NEAR_DATA = '(bytes32 nonEVMReceiver, bytes32 destinationAsset, address depositAddress, bytes32 quoteId, uint256 deadline, uint256 minAmountOut, address refundRecipient, bytes signature)';
/**
 * LI.FI `NEARIntentsFacet` v3 (lifinance/contracts `src/Facets/NEARIntentsFacet.sol`): the only
 * bridge facet Kyro decodes. Selector checked against live li.quest calldata (01/11/2026):
 * `swapAndStartBridgeTokensViaNEARIntents` = 0x02631b09.
 */
export const LIFI_NEAR_ABI = parseAbi([
  `function startBridgeTokensViaNEARIntents(${BRIDGE_DATA} bridgeData, ${NEAR_DATA} nearData) payable`,
  `function swapAndStartBridgeTokensViaNEARIntents(${BRIDGE_DATA} bridgeData, ${SWAP_DATA}[] swapData, ${NEAR_DATA} nearData) payable`,
]);
/** LI.FI chain ids of the non-EVM chains Kyro bridges to (li.quest `/v1/chains`). */
export const LIFI_CHAIN_SOLANA = 1151111081099710;
export const LIFI_CHAIN_BITCOIN = 20000000000001;
/** `BridgeData.receiver` sentinel for a non-EVM destination (LiFiData.sol `NON_EVM_ADDRESS`); the real receiver is in the facet data. */
export const LIFI_NON_EVM_ADDRESS = '0x11f111f111f111F111f111f111F111f111f111F1';

/** LI.FI chain id of a Kyro swap chain. */
export function lifiChainId(c: SwapChain): number {
  if (typeof c === 'number') return c;
  if (c === 'solana') return LIFI_CHAIN_SOLANA;
  if (c === 'bitcoin') return LIFI_CHAIN_BITCOIN;
  throw new SwapCheckError(`LI.FI : chaîne ${c} non prise en charge`);
}

/**
 * `nonEVMReceiver` LI.FI writes for our address (live calldata, 01/11/2026): Solana = the 32-byte
 * public key; Bitcoin SegWit v0 P2WPKH = its 32 five-bit program words (`bc1q` + 32 characters),
 * one byte each. Other forms (Taproot…) are not representable unambiguously: null ⇒ refused.
 */
export function nonEvmReceiverWord(chain: 'solana' | 'bitcoin', address: string): Hex | null {
  try {
    if (chain === 'solana') {
      const b = base58.decode(address);
      return b.length === 32 ? toHex(b) : null;
    }
    const d = bech32.decode(address as `${string}1${string}`);
    if (d.prefix !== 'bc' || d.words[0] !== 0 || d.words.length !== 33) return null;
    return toHex(Uint8Array.from(d.words.slice(1)));
  } catch {
    return null;
  }
}

/** `destinationAsset` LI.FI binds into the NEAR signature: padded token address, padded `0xEeee…` for a native coin, the mint bytes on Solana. */
export function nearDestinationAsset(chain: SwapChain, token: string): Hex | null {
  const native = chain === 'solana' ? token === WSOL_MINT || token === '11111111111111111111111111111111' : chain === 'bitcoin' ? token === 'bitcoin' : isNative(token);
  if (native) return pad(NATIVE_EVM.toLowerCase() as Hex, { size: 32 });
  if (chain === 'bitcoin') return null;
  if (chain === 'solana') {
    try {
      const b = base58.decode(token);
      return b.length === 32 ? toHex(b) : null;
    } catch {
      return null;
    }
  }
  return isAddress(token, { strict: false }) ? pad(token.toLowerCase() as Hex, { size: 32 }) : null;
}

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
  /**
   * LI.FI cross-chain route: destination chain and OUR address there. The calldata must then be a
   * NEAR Intents bridge call (`LIFI_NEAR_ABI`) instead of a GenericSwapFacetV3 swap.
   */
  cross?: { toChain: SwapChain; recipient: string };
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
  /** Cross-chain (NEAR Intents): deposit address and amount, confirmed with NEAR Intents before signing. */
  bridge?: { tool: 'near'; depositAddress: string; amountIn: bigint; deadline: bigint };
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
  if (i.provider === 'zerox') return checkZeroEx(i, name, entry);
  return i.cross ? checkLifiBridge(i, i.cross, name, entry) : checkLifi(i, name, entry);
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
  const kyro = lifiFees(i, steps, name);
  if (kyro !== null) out.kyroFee = kyro;
  return out;
}

/** FeeForwarder steps of a LI.FI call: Kyro's share (null when the fee is off), total capped. */
function lifiFees(i: EvmSwapCheckInput, steps: readonly SwapData[], name: string): bigint | null {
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
  }
  const kyroBps = i.fee.kind === 'fee' ? BigInt(i.fee.bps) : 0n;
  if (total > (i.sellAmount * (kyroBps + LIFI_OWN_FEE_CAP_BPS) + 9_999n) / 10_000n) fail(name, 'frais prélevés au total plus élevés que prévu');
  return i.fee.kind === 'fee' ? kyro : null;
}

interface BridgeData {
  transactionId: Hex;
  bridge: string;
  integrator: string;
  referrer: string;
  sendingAssetId: string;
  receiver: string;
  minAmount: bigint;
  destinationChainId: bigint;
  hasSourceSwaps: boolean;
  hasDestinationCall: boolean;
}
interface NearData {
  nonEVMReceiver: Hex;
  destinationAsset: Hex;
  depositAddress: string;
  quoteId: Hex;
  deadline: bigint;
  minAmountOut: bigint;
  refundRecipient: string;
  signature: Hex;
}

/**
 * LI.FI cross-chain call through NEAR Intents: `BridgeData` (destination chain, receiver = us or
 * the non-EVM sentinel with OUR address in `nonEVMReceiver`, no destination call), source steps
 * (first = the token and amount sold, last = the bridged token, Kyro fee step), and the NEAR data
 * (refund to us, minimum ≥ slippage bound, destination token = the one asked). The deposit address
 * is then confirmed with NEAR Intents itself (near-intents.ts) before signing.
 */
function checkLifiBridge(i: EvmSwapCheckInput, cross: { toChain: SwapChain; recipient: string }, name: string, entry: string): EvmSwapCheck {
  const d = decode(LIFI_NEAR_ABI, i.tx.data);
  if (!d) return fail(name, 'fonction du Diamond inconnue de Kyro (pont NEAR Intents attendu)');
  const withSwaps = d.functionName === 'swapAndStartBridgeTokensViaNEARIntents';
  const bd = d.args[0] as BridgeData;
  const steps: readonly SwapData[] = withSwaps ? (d.args[1] as readonly SwapData[]) : [];
  const nd = (withSwaps ? d.args[2] : d.args[1]) as NearData;
  if (bd.destinationChainId !== BigInt(lifiChainId(cross.toChain)) || cross.toChain === i.chainId) fail(name, 'chaîne de destination différente de celle demandée');
  if (bd.hasDestinationCall) fail(name, 'appel de contrat à l’arrivée non autorisé');
  if (typeof cross.toChain === 'number') {
    if (!same(bd.receiver, cross.recipient)) fail(name, `destinataire ${bd.receiver} au lieu de ton adresse`);
  } else {
    const want = cross.toChain === 'solana' || cross.toChain === 'bitcoin' ? nonEvmReceiverWord(cross.toChain, cross.recipient) : null;
    if (!same(bd.receiver, LIFI_NON_EVM_ADDRESS)) fail(name, 'destinataire hors EVM mal indiqué');
    if (!want || nd.nonEVMReceiver.toLowerCase() !== want.toLowerCase()) fail(name, 'destinataire à l’arrivée différent de ton adresse');
  }
  if (!same(nd.refundRecipient, i.taker)) fail(name, 'remboursement prévu vers une autre adresse que la tienne');
  if (!minOk(nd.minAmountOut, i.buyAmount, i.slippageBps)) fail(name, 'minimum garanti plus bas que le slippage choisi');
  const asset = nearDestinationAsset(cross.toChain, i.buy.address);
  if (!asset || nd.destinationAsset.toLowerCase() !== asset.toLowerCase()) fail(name, 'token reçu différent de celui demandé');
  if (withSwaps !== bd.hasSourceSwaps) fail(name, 'étapes de swap incohérentes');
  const sold = isNative(i.sell.address) ? ZERO_ADDRESS : i.sell.address;
  if (steps.length > 0) {
    const first = steps[0] as SwapData;
    const last = steps[steps.length - 1] as SwapData;
    if (!same(first.sendingAssetId, sold) || first.fromAmount !== i.sellAmount) fail(name, 'première étape différente du token ou du montant vendus');
    if (!same(last.receivingAssetId, bd.sendingAssetId)) fail(name, 'dernière étape différente du token envoyé au pont');
    // Without a DEX step, the bridged amount is what is left after the fees: never more than sold.
    if (same(bd.sendingAssetId, sold) && bd.minAmount > i.sellAmount) fail(name, 'montant envoyé au pont incohérent');
  } else if (!same(bd.sendingAssetId, sold) || bd.minAmount !== i.sellAmount) fail(name, 'montant ou token envoyé au pont différent de ta saisie');
  if (bd.minAmount <= 0n) fail(name, 'montant envoyé au pont nul');
  if (same(nd.depositAddress, ZERO_ADDRESS)) fail(name, 'adresse de dépôt du pont invalide');
  const kyro = lifiFees(i, steps, name);
  const out: EvmSwapCheck = {
    contract: getAddress(entry),
    recipient: cross.recipient,
    minBuyAmount: nd.minAmountOut,
    bridge: { tool: 'near', depositAddress: getAddress(nd.depositAddress), amountIn: bd.minAmount, deadline: nd.deadline },
  };
  if (kyro !== null) out.kyroFee = kyro;
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
