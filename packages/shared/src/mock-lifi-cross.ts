// SPDX-License-Identifier: GPL-3.0-or-later
//
// DEMO ONLY — cross-chain swaps as LI.FI builds them through NEAR Intents (live shapes of
// 01/11/2026), so the demo runs Kyro's real checks (packages/swap: verify.ts NEARIntentsFacet,
// lifi-cross.ts Solana source, near-intents.ts 1Click confirmation) end to end:
// - EVM source: `swapAndStartBridgeTokensViaNEARIntents` (FeeForwarder step + NEAR data);
// - Solana source: a legacy transaction (ComputeBudget, LI.FI TrackV1, fee transfers, deposit);
// - `1click.chaindefuser.com`: `/v0/status` of every deposit address handed out, `/v0/tokens`.

import { base58, base64, bech32 } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';
import type { NetResponse } from './ipc';
import { encodeCall, type AbiValue } from './mock-abi';
import { demoAta } from './mock-jupiter';
import { DEMO_TOKENS, demoPrice } from './mock-data';

const LIFI_SOLANA = 1151111081099710;
const LIFI_BITCOIN = 20000000000001;
const LIFI_FEE_FORWARDER = '0xce40449b773a3e6e5e769adb4e567179d4828cbd';
const LIFI_EVM_FEE = '0xc06ebbefd94032b85424d51906e2a335efae264b';
const LIFI_SOL_FEE = '34FKjAdVcTax2DHqV2XnbXa9J3zmyKcFuFKWbcmgxjgm';
const NON_EVM = '0x11f111f111f111f111f111f111f111f111f111f1';
const NATIVE_EEEE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const ZERO = '0x0000000000000000000000000000000000000000';
const SOL_NATIVE = '11111111111111111111111111111111';
const WSOL = 'So11111111111111111111111111111111111111112';
const TRACKER = '3i5JeuZuUxeKtVysUnwQNGerJP2bSMX9fTFfS4Nxe3Br';
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
const CLOCK = 'SysvarC1ock11111111111111111111111111111111';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const ONE_CLICK: Record<string, string> = { '1': 'eth', '10': 'op', '56': 'bsc', '137': 'pol', '8453': 'base', '42161': 'arb', '43114': 'avax', [String(LIFI_SOLANA)]: 'sol', [String(LIFI_BITCOIN)]: 'btc' };

const json = (status: number, body: unknown): NetResponse => ({ status, body: JSON.stringify(body) });
const hash = (s: string) => sha256(new TextEncoder().encode(s));
const isEvmNative = (t: string) => t.toLowerCase() === NATIVE_EEEE || t === ZERO;

interface Deposit {
  quoteRequest: Record<string, unknown>;
  quote: Record<string, unknown>;
}
/** Deposit addresses handed out by the demo, as 1Click would know them. */
const deposits = new Map<string, Deposit>();
const assets = new Map<string, { assetId: string; blockchain: string; contractAddress?: string; decimals: number; symbol: string }>();

function tokenInfo(chain: number, token: string): { coin: string; decimals: number } {
  if (chain === LIFI_BITCOIN) return { coin: 'bitcoin', decimals: 8 };
  if (chain === LIFI_SOLANA) return DEMO_TOKENS[token === SOL_NATIVE ? WSOL : token] ?? { coin: 'usd-coin', decimals: 6 };
  return DEMO_TOKENS[isEvmNative(token) ? ZERO : token.toLowerCase()] ?? { coin: chain === 137 ? 'polygon-ecosystem-token' : chain === 56 ? 'binancecoin' : chain === 43114 ? 'avalanche-2' : 'ethereum', decimals: 18 };
}

function asset(chain: number, token: string): string {
  const blockchain = ONE_CLICK[String(chain)] ?? 'eth';
  const native = chain === LIFI_BITCOIN || (chain === LIFI_SOLANA ? token === SOL_NATIVE || token === WSOL : isEvmNative(token));
  const assetId = native ? `nep141:${blockchain}.omft.near` : `nep141:${blockchain}-${bytesToHex(hash(token)).slice(0, 40)}.omft.near`;
  const info = tokenInfo(chain, token);
  assets.set(assetId, { assetId, blockchain, decimals: info.decimals, symbol: info.coin, ...(native ? {} : { contractAddress: token }) });
  return assetId;
}

/** `nonEVMReceiver`: Solana key, or the 32 program words of a `bc1q…` address. */
function nonEvmReceiver(chain: number, to: string): string {
  if (chain === LIFI_SOLANA) return bytesToHex(base58.decode(to));
  const d = bech32.decode(to as `${string}1${string}`);
  return bytesToHex(Uint8Array.from(d.words.slice(1, 33)));
}
function destinationAsset(chain: number, token: string): string {
  if (chain === LIFI_BITCOIN || (chain === LIFI_SOLANA && (token === SOL_NATIVE || token === WSOL)) || (chain !== LIFI_SOLANA && isEvmNative(token))) return NATIVE_EEEE.slice(2).padStart(64, '0');
  if (chain === LIFI_SOLANA) return bytesToHex(base58.decode(token));
  return token.slice(2).toLowerCase().padStart(64, '0');
}

/** li.quest `/v1/quote` across two chains (allowBridges=near). */
export function demoLifiCross(q: URLSearchParams): NetResponse {
  const fromChain = Number(q.get('fromChain'));
  const toChain = Number(q.get('toChain'));
  const from = q.get('fromToken') ?? '';
  const to = q.get('toToken') ?? '';
  const amount = BigInt(q.get('fromAmount') ?? '0');
  const fromAddress = q.get('fromAddress') ?? '';
  const toAddress = q.get('toAddress') ?? '';
  const slip = Number(q.get('slippage') ?? '0.005');
  const kyroBps = Math.round(Number(q.get('distributionFees[0][percentage]') ?? '0') * 10_000);
  const receiver = q.get('distributionFees[0][receiver]') ?? '';
  const kyro = (amount * BigInt(kyroBps)) / 10_000n;
  const lifiFee = (amount * 25n) / 10_000n;
  const deposit = amount - kyro - lifiFee;
  const s = tokenInfo(fromChain, from);
  const b = tokenInfo(toChain, to);
  const out = BigInt(Math.floor(((Number(deposit) / 10 ** s.decimals) * demoPrice(s.coin) * 0.997 * 10 ** b.decimals) / demoPrice(b.coin)));
  const min = (out * BigInt(Math.round((1 - slip) * 10_000))) / 10_000n;
  const id = bytesToHex(hash(`demo-lifi:${fromChain}:${toChain}:${from}:${to}:${amount}:${Date.now()}`));
  const deadline = new Date(Date.now() + 3 * 86_400_000).toISOString();
  const fromSol = fromChain === LIFI_SOLANA;
  // A fresh one-time deposit address per quote, like 1Click.
  const depositAddress = fromSol ? base58.encode(hash(`deposit:${id}`)) : `0x${id.slice(0, 40)}`;
  deposits.set(depositAddress.toLowerCase(), {
    quoteRequest: { swapType: fromSol ? 'EXACT_INPUT' : 'FLEX_INPUT', originAsset: asset(fromChain, from), destinationAsset: asset(toChain, to), amount: deposit.toString(), refundTo: fromAddress, refundType: 'ORIGIN_CHAIN', recipient: toAddress, recipientType: 'DESTINATION_CHAIN', deadline, referral: 'lifi' },
    quote: { depositAddress, amountIn: deposit.toString(), minAmountIn: deposit.toString(), amountOut: out.toString(), minAmountOut: min.toString(), deadline, timeEstimate: 25 },
  });
  const feeCosts = [
    { name: 'LIFI Fixed Fee', percentage: '0.0025', amount: lifiFee.toString(), amountUSD: '0.05', included: true },
    ...(kyroBps ? [{ name: 'Distributions', percentage: (kyroBps / 10_000).toFixed(4), amount: kyro.toString(), amountUSD: '0.14', included: true, feeSplit: { recipients: [{ name: receiver, type: 'DISTRIBUTION', walletAddress: receiver }] } }] : []),
  ];
  const transactionRequest = fromSol
    ? { data: solanaSourceTx({ taker: fromAddress, mint: from === SOL_NATIVE ? null : from, kyroWallet: receiver, kyro, lifiFee, deposit, depositAddress, id }) }
    : evmSourceTx({ fromAddress, from, toChain, to, toAddress, amount, kyro, kyroReceiver: receiver, lifiFee, deposit, depositAddress, min, id, deadline: BigInt(Math.floor(Date.now() / 1000) + 3 * 86_400) });
  return json(200, {
    type: 'lifi',
    tool: 'near',
    toolDetails: { key: 'near', name: 'NearIntents' },
    action: { fromChainId: fromChain, toChainId: toChain, fromAmount: amount.toString(), fromAddress, toAddress, slippage: slip },
    estimate: { toAmount: out.toString(), toAmountMin: min.toString(), fromAmount: amount.toString(), approvalAddress: '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae', executionDuration: 25, feeCosts, gasCosts: [{ amountUSD: fromSol ? '0.01' : '0.42' }] },
    transactionRequest,
  });
}

function evmSourceTx(o: { fromAddress: string; from: string; toChain: number; to: string; toAddress: string; amount: bigint; kyro: bigint; kyroReceiver: string; lifiFee: bigint; deposit: bigint; depositAddress: string; min: bigint; id: string; deadline: bigint }) {
  const native = isEvmNative(o.from);
  const sell = native ? ZERO : o.from;
  const dist: AbiValue = { t: 'array', items: [{ t: 'tuple', items: [{ t: 'address', v: LIFI_EVM_FEE }, { t: 'uint256', v: o.lifiFee }] }, ...(o.kyro > 0n ? [{ t: 'tuple' as const, items: [{ t: 'address' as const, v: o.kyroReceiver }, { t: 'uint256' as const, v: o.kyro }] }] : [])] };
  const feeCall = native ? encodeCall('forwardNativeFees((address,uint256)[])', [dist]) : encodeCall('forwardERC20Fees(address,(address,uint256)[])', [{ t: 'address', v: sell }, dist]);
  const evmDest = o.toChain !== LIFI_SOLANA && o.toChain !== LIFI_BITCOIN;
  const BD = '(bytes32,string,string,address,address,address,uint256,uint256,bool,bool)';
  const SD = '(address,address,address,address,uint256,bytes,bool)';
  const ND = '(bytes32,bytes32,address,bytes32,uint256,uint256,address,bytes)';
  const data = encodeCall(`swapAndStartBridgeTokensViaNEARIntents(${BD},${SD}[],${ND})`, [
    { t: 'tuple', items: [{ t: 'bytes32', v: o.id }, { t: 'string', v: 'near' }, { t: 'string', v: 'lifi-api' }, { t: 'address', v: ZERO }, { t: 'address', v: sell }, { t: 'address', v: evmDest ? o.toAddress : NON_EVM }, { t: 'uint256', v: o.deposit }, { t: 'uint256', v: BigInt(o.toChain) }, { t: 'bool', v: true }, { t: 'bool', v: false }] },
    { t: 'array', items: [{ t: 'tuple', items: [{ t: 'address', v: LIFI_FEE_FORWARDER }, { t: 'address', v: LIFI_FEE_FORWARDER }, { t: 'address', v: sell }, { t: 'address', v: sell }, { t: 'uint256', v: o.amount }, { t: 'bytes', v: feeCall }, { t: 'bool', v: true }] }] },
    {
      t: 'tuple',
      items: [
        { t: 'bytes32', v: evmDest ? '00' : nonEvmReceiver(o.toChain, o.toAddress) },
        { t: 'bytes32', v: destinationAsset(o.toChain, o.to) },
        { t: 'address', v: o.depositAddress },
        { t: 'bytes32', v: o.id },
        { t: 'uint256', v: o.deadline },
        { t: 'uint256', v: o.min },
        { t: 'address', v: o.fromAddress },
        { t: 'bytes', v: '00'.repeat(65) },
      ],
    },
  ]);
  return { to: '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae', data, value: native ? `0x${o.amount.toString(16)}` : '0x0', gasLimit: '0x61a80', gasPrice: '0x12a05f200' };
}

const u32 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const u64 = (n: bigint) => Array.from({ length: 8 }, (_, i) => Number((n >> BigInt(8 * i)) & 0xffn));

/** Legacy message, LI.FI's `near` layout (live 01/11/2026): budget, TrackV1, fee transfers, deposit. */
function solanaSourceTx(o: { taker: string; mint: string | null; kyroWallet: string; kyro: bigint; lifiFee: bigint; deposit: bigint; depositAddress: string; id: string }): string {
  const epochPda = base58.encode(hash(`lifi-epoch:${o.id.slice(0, 4)}`));
  const SYSTEM = SOL_NATIVE;
  let writable: string[];
  let readonly: string[];
  if (o.mint) {
    const src = demoAta(o.taker, o.mint);
    writable = [src, demoAta(LIFI_SOL_FEE, o.mint), demoAta(o.kyroWallet, o.mint), demoAta(o.depositAddress, o.mint)];
    readonly = [o.depositAddress, SYSTEM, TRACKER, epochPda, ATA, COMPUTE_BUDGET, o.mint, CLOCK, TOKEN];
  } else {
    writable = [LIFI_SOL_FEE, o.kyroWallet, o.depositAddress];
    readonly = [SYSTEM, TRACKER, epochPda, COMPUTE_BUDGET, CLOCK];
  }
  const keys = [o.taker, ...writable, ...readonly];
  const at = (k: string) => keys.indexOf(k);
  const ix = (program: string, accounts: string[], data: number[]) => [at(program), accounts.length, ...accounts.map(at), data.length, ...data];
  const ixs: number[][] = [ix(COMPUTE_BUDGET, [], [2, ...u32(650_000)]), ix(COMPUTE_BUDGET, [], [3, ...u64(33_333n)]), ix(TRACKER, [CLOCK, epochPda], [0, ...Array.from(hash(o.id).slice(0, 8))])];
  if (o.mint) {
    const src = demoAta(o.taker, o.mint);
    const dec = DEMO_TOKENS[o.mint]?.decimals ?? 6;
    const transfer = (dest: string, v: bigint) => ix(TOKEN, [src, o.mint as string, dest, o.taker], [12, ...u64(v), dec]);
    ixs.push(transfer(demoAta(LIFI_SOL_FEE, o.mint), o.lifiFee));
    if (o.kyro > 0n) ixs.push(transfer(demoAta(o.kyroWallet, o.mint), o.kyro));
    ixs.push(ix(ATA, [o.taker, demoAta(o.depositAddress, o.mint), o.depositAddress, o.mint, SYSTEM, TOKEN], [1]));
    ixs.push(transfer(demoAta(o.depositAddress, o.mint), o.deposit));
  } else {
    const transfer = (dest: string, v: bigint) => ix(SYSTEM, [o.taker, dest], [...u32(2), ...u64(v)]);
    ixs.push(transfer(LIFI_SOL_FEE, o.lifiFee));
    if (o.kyro > 0n) ixs.push(transfer(o.kyroWallet, o.kyro));
    ixs.push(transfer(o.depositAddress, o.deposit));
  }
  const blockhash = hash('demo-blockhash');
  const msg = [1, 0, readonly.length, keys.length, ...keys.flatMap((k) => [...base58.decode(k)]), ...blockhash, ixs.length, ...ixs.flat()];
  const wire = new Uint8Array(1 + 64 + msg.length);
  wire[0] = 1;
  wire.set(msg, 65);
  return base64.encode(wire);
}

/** `1click.chaindefuser.com`: status of a deposit address handed out above, and the token list. */
export function demoOneClick(url: URL): NetResponse {
  if (url.pathname === '/v0/tokens') return json(200, [...assets.values()]);
  if (url.pathname === '/v0/status') {
    const d = deposits.get((url.searchParams.get('depositAddress') ?? '').toLowerCase());
    if (!d) return json(404, { message: 'Deposit address not found' });
    return json(200, { status: 'PENDING_DEPOSIT', quoteResponse: d });
  }
  return json(404, { message: 'not found' });
}

/** li.quest `/v1/status`: a demo cross-chain transfer arrives right away. */
export function demoLifiStatus(): NetResponse {
  return json(200, { status: 'DONE', substatus: 'COMPLETED', receiving: { txHash: `0x${bytesToHex(hash(`recv:${Date.now()}`))}` } });
}
