// SPDX-License-Identifier: GPL-3.0-or-later
//
// DEMO ONLY — cross-chain swaps as LI.FI builds them through NEAR Intents (live shapes of
// 01/11/2026), so the demo runs Kyro's real checks (packages/swap: verify.ts NEARIntentsFacet,
// lifi-cross.ts Solana source, near-intents.ts 1Click confirmation) end to end:
// - EVM source: `swapAndStartBridgeTokensViaNEARIntents` (FeeForwarder step + NEAR data);
// - Solana source: a legacy transaction (ComputeBudget, LI.FI TrackV1, fee transfers, deposit);
// - `1click.chaindefuser.com`: `/v0/status` of every deposit address handed out, `/v0/tokens`,
//   and `POST /v0/quote` for the DIRECT 1Click routes (from / to Bitcoin, Litecoin, Dogecoin, TRON,
//   XRP, Cardano: packages/swap providers/near.ts), app fees split 50/50 like the live service.

import { base58, base64, bech32, createBase58check } from '@scure/base';
import * as bitcoin from 'bitcoinjs-lib';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';
import type { NetResponse } from './ipc';
import { encodeCall, type AbiValue } from './mock-abi';
import { demoAta } from './mock-jupiter';
import { DEMO_TOKENS, demoPrice } from './mock-data';
import { xrpAddressOfId } from './mock-xrp';
import { cardanoAddressOf } from './mock-cardano';
import { cashaddrEncode } from './cashaddr';
import { tonFriendly } from './ton-address';

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
const ONE_CLICK: Record<string, string> = { '1': 'eth', '10': 'op', '56': 'bsc', '137': 'pol', '8453': 'base', '42161': 'arb', '43114': 'avax', '100': 'gnosis', [String(LIFI_SOLANA)]: 'sol', [String(LIFI_BITCOIN)]: 'btc' };

const json = (status: number, body: unknown): NetResponse => ({ status, body: JSON.stringify(body) });
const hash = (s: string) => sha256(new TextEncoder().encode(s));
const isEvmNative = (t: string) => t.toLowerCase() === NATIVE_EEEE || t === ZERO;

interface Deposit {
  quoteRequest: Record<string, unknown>;
  quote: Record<string, unknown>;
  /** Direct route: status reads so far (the quote check, then the one just before signing). */
  reads?: number;
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

/** 1Click's own share of the app fee (live: half of what is requested, to this account). */
const ONE_CLICK_FEE_ACCOUNT = '5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd';

/** Assets the direct 1Click routes use (same id scheme as `asset()` above). */
const DIRECT_ASSETS: ReadonlyArray<[blockchain: string, contract: string | null, decimals: number, coin: string, symbol: string]> = [
  ['eth', null, 18, 'ethereum', 'ETH'],
  ['eth', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', 6, 'usd-coin', 'USDC'],
  ['eth', '0xdac17f958d2ee523a2206206994597c13d831ec7', 6, 'tether', 'USDT'],
  ['arb', null, 18, 'ethereum', 'ETH'],
  ['arb', '0xaf88d065e77c8cc2239327c5edb3a432268e5831', 6, 'usd-coin', 'USDC'],
  ['base', null, 18, 'ethereum', 'ETH'],
  ['op', null, 18, 'ethereum', 'ETH'],
  ['bsc', null, 18, 'binancecoin', 'BNB'],
  ['pol', null, 18, 'polygon-ecosystem-token', 'POL'],
  ['avax', null, 18, 'avalanche-2', 'AVAX'],
  ['sol', null, 9, 'solana', 'SOL'],
  ['sol', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 6, 'usd-coin', 'USDC'],
  ['btc', null, 8, 'bitcoin', 'BTC'],
  ['ltc', null, 8, 'litecoin', 'LTC'],
  ['doge', null, 8, 'dogecoin', 'DOGE'],
  ['tron', null, 6, 'tron', 'TRX'],
  ['tron', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', 6, 'tether', 'USDT'],
  ['xrp', null, 6, 'ripple', 'XRP'],
  ['cardano', null, 6, 'cardano', 'ADA'],
  ['gnosis', null, 18, 'xdai', 'xDAI'],
  ['bch', null, 8, 'bitcoin-cash', 'BCH'],
  ['dash', null, 8, 'dash', 'DASH'],
  ['zec', null, 8, 'zcash', 'ZEC'],
  ['sui', null, 9, 'sui', 'SUI'],
  ['ton', null, 9, 'the-open-network', 'GRAM'],
  ['aptos', null, 8, 'aptos', 'APT'],
  ['stellar', null, 7, 'stellar', 'XLM'],
];
const directCoin = new Map<string, { coin: string; decimals: number; blockchain: string }>();
function seedDirectAssets() {
  if (directCoin.size > 0) return;
  for (const [blockchain, contract, decimals, coin, symbol] of DIRECT_ASSETS) {
    const assetId = contract ? `nep141:${blockchain}-${bytesToHex(hash(contract)).slice(0, 40)}.omft.near` : `nep141:${blockchain}.omft.near`;
    directCoin.set(assetId, { coin, decimals, blockchain });
    if (!assets.has(assetId)) assets.set(assetId, { assetId, blockchain, decimals, symbol, ...(contract ? { contractAddress: contract } : {}) });
  }
}

/** A fresh one-time deposit address on `blockchain`, valid for Kyro's adapters (mainnet shapes, like 1Click's). */
function depositAddressOn(blockchain: string, id: string): string {
  const h = hash(`deposit:${id}`);
  const h20 = h.slice(0, 20);
  switch (blockchain) {
    case 'btc':
      return bech32.encode('bc', [0, ...bech32.toWords(h20)]);
    case 'ltc':
      return bitcoin.address.toBase58Check(h20, 0x30);
    case 'doge':
      return bitcoin.address.toBase58Check(h20, 0x1e);
    case 'tron':
      return bitcoin.address.toBase58Check(h20, 0x41);
    case 'xrp':
      return xrpAddressOfId(h20);
    case 'cardano':
      // Enterprise address (header 0x61), as 1Click hands out.
      return cardanoAddressOf(new Uint8Array([0x61, ...h.slice(0, 28)]), 'addr');
    case 'bch':
      return cashaddrEncode('bitcoincash', 0, h20);
    case 'dash':
      return bitcoin.address.toBase58Check(h20, 0x4c);
    case 'zec':
      // Transparent P2PKH `t1…` (version 0x1cb8).
      return createBase58check(sha256).encode(Uint8Array.from([0x1c, 0xb8, ...h20]));
    case 'ton':
      return tonFriendly(0, bytesToHex(h), false, false);
    case 'sui':
    case 'aptos':
      return `0x${bytesToHex(h)}`;
    case 'sol':
      return base58.encode(h);
    default:
      return `0x${bytesToHex(h20)}`;
  }
}

/** `POST /v0/quote` (direct route): app fees split 50/50 with 1Click, SIMPLE deposit, EXACT_INPUT. */
function demoOneClickQuote(body: string | undefined): NetResponse {
  seedDirectAssets();
  let r: Record<string, unknown>;
  try {
    r = JSON.parse(body ?? '{}') as Record<string, unknown>;
  } catch {
    return json(400, { message: 'invalid JSON' });
  }
  const origin = directCoin.get(String(r.originAsset));
  const dest = directCoin.get(String(r.destinationAsset));
  if (!origin || !dest) return json(400, { message: 'tokenIn or tokenOut is not valid' });
  const amount = BigInt(/^\d{1,78}$/.test(String(r.amount)) ? String(r.amount) : '0');
  if (amount <= 0n) return json(400, { message: 'amount is not valid' });
  const asked = Array.isArray(r.appFees) ? (r.appFees as Array<{ recipient?: string; fee?: number }>) : [];
  const appFees = asked.map((f) => ({ recipient: f.recipient ?? '', fee: Math.floor((f.fee ?? 0) / 2) }));
  const total = asked.reduce((s, f) => s + (f.fee ?? 0), 0);
  if (total > 0) appFees.push({ recipient: ONE_CLICK_FEE_ACCOUNT, fee: Math.floor(total / 2) });
  const net = amount - (amount * BigInt(total)) / 10_000n;
  const out = BigInt(Math.floor(((Number(net) / 10 ** origin.decimals) * demoPrice(origin.coin) * 0.997 * 10 ** dest.decimals) / demoPrice(dest.coin)));
  const slip = Number(r.slippageTolerance ?? 100);
  const min = (out * BigInt(10_000 - slip)) / 10_000n;
  const dry = r.dry !== false;
  const id = bytesToHex(hash(`demo-1click:${String(r.originAsset)}:${String(r.destinationAsset)}:${amount}:${Date.now()}:${Math.random()}`));
  const depositAddress = dry ? undefined : depositAddressOn(origin.blockchain, id);
  const quoteRequest = { dry, depositMode: r.depositMode ?? 'SIMPLE', swapType: r.swapType, slippageTolerance: slip, originAsset: r.originAsset, depositType: r.depositType, destinationAsset: r.destinationAsset, amount: amount.toString(), refundTo: r.refundTo, refundType: r.refundType, recipient: r.recipient, recipientType: r.recipientType, deadline: r.deadline, appFees };
  const quote = { amountIn: amount.toString(), minAmountIn: amount.toString(), amountOut: out.toString(), minAmountOut: min.toString(), timeEstimate: origin.blockchain === 'btc' ? 812 : 60, deadline: new Date(Date.now() + 3 * 86_400_000).toISOString(), ...(depositAddress ? { depositAddress } : {}) };
  if (depositAddress) deposits.set(depositAddress.toLowerCase(), { quoteRequest, quote, reads: 0 });
  return json(201, { quote, quoteRequest, signature: `ed25519:demo${id.slice(0, 16)}`, timestamp: new Date().toISOString() });
}

/** `1click.chaindefuser.com`: status of a deposit address handed out above, the token list, direct quotes. */
export function demoOneClick(url: URL, req?: { method?: string; body?: string }): NetResponse {
  if (url.pathname === '/v0/quote' && req?.method === 'POST') return demoOneClickQuote(req.body);
  if (url.pathname === '/v0/tokens') {
    seedDirectAssets();
    return json(200, [...assets.values()]);
  }
  if (url.pathname === '/v0/status') {
    const d = deposits.get((url.searchParams.get('depositAddress') ?? '').toLowerCase());
    if (!d) return json(404, { message: 'Deposit address not found' });
    const { reads, ...quoteResponse } = d;
    // Direct route: after Kyro's two checks (quote, then just before signing), the demo swap has
    // « arrived », so the history follows it to SUCCESS like a real one.
    if (reads !== undefined) {
      d.reads = reads + 1;
      if (reads >= 2) return json(200, { status: 'SUCCESS', quoteResponse, swapDetails: { destinationChainTxHashes: [{ hash: bytesToHex(hash(`demo-arrival:${String(quoteResponse.quote.depositAddress)}`)) }] } });
    }
    return json(200, { status: 'PENDING_DEPOSIT', quoteResponse });
  }
  return json(404, { message: 'not found' });
}

/** li.quest `/v1/status`: a demo cross-chain transfer arrives right away. */
export function demoLifiStatus(): NetResponse {
  return json(200, { status: 'DONE', substatus: 'COMPLETED', receiving: { txHash: `0x${bytesToHex(hash(`recv:${Date.now()}`))}` } });
}
