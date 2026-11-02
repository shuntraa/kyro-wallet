// SPDX-License-Identifier: GPL-3.0-or-later
// Swap: best quote after the Kyro fee (0x, LI.FI, Jupiter — the provider is not shown on the main
// screen, only in the confirmation before signing), slippage, exact approval by default (unlimited
// only after explicit confirmation), simulation, "En clair".

import { useEffect, useMemo, useState } from 'react';
import { call, toIpcError, type AccountChain } from '@kyro/shared';
import { allChains, assetsFor, evmChains, findChain, signAndBroadcast, solChain, tryParseUnits, unitsToNumber, type AssetDef, type Chain, type EvmAdapter } from '@kyro/chains';
import {
  buildApproval,
  buildRevoke,
  compareFreshQuote,
  fetchQuotes,
  isCurrentZeroExSettler,
  isNative,
  isUnlimitedAllowance,
  knownSwapContract,
  requiresZeroAllowanceFirst,
  verifyJupiterSwap,
  ZEROX_REGISTRY_ABI,
  ZEROX_SETTLER_REGISTRY,
  ZEROX_TAKER_SETTLER_FEATURE,
  type DepositPlan,
  type Quote,
  type QuoteParams,
  type QuoteResult,
  type SwapToken,
} from '@kyro/swap';
import { useApp, useVault } from '../state/app';
import { usePortfolio } from '../state/portfolio';
import { cn } from '../lib/cn';
import { fmtCrypto, fmtEta, fmtFiat, fmtPct, sanitizeDecimalInput, shortAddress, toInputDecimal } from '../lib/format';
import { addApproval, addLocalTx } from '../lib/storage';
import { buildDepositTx, buildKyroFeeTx, buyGroups, canSwapFrom, depositAdapterFor, ownAddressOn, sellChoices, swapChainOf, swapTokenAddress, type PreparedDeposit } from '../lib/crossSwap';
import { TokenPicker, type TokenPickerItem } from '../components/TokenPicker';
import { useAsync, useDebounced } from '../lib/useAsync';
import { CoinIcon, EmptyState, EnClair, PasswordField } from '../components/kit';
import { SecondConfirmNotice } from '../components/SecondConfirm';
import { TorWait, useTorBlocked } from '../components/Tor';
import { useOnTorReady } from '../state/tor';
import { Menu } from '../components/ui/menu';
import { AccountPicker } from '../components/AccountPicker';
import { Dialog } from '../components/ui/dialog';
import { Button, Notice, Segmented, Spinner, Switch } from '../components/ui/primitives';
import { IconCheck, IconChevronDown, IconDown, IconWarn } from '../components/icons';
import { t as tr, useT } from '../i18n';
import { rt } from '../i18n/rich';

type Slip = 10 | 50 | 100 | 'custom';
type Phase = 'idle' | 'approving' | 'waiting' | 'simulating' | 'checking' | 'swapping' | 'done';

const MAX_SLIPPAGE_BPS = 1_500;

function tokenOf(a: AssetDef, price?: number): SwapToken {
  const t: SwapToken = { address: swapTokenAddress(a), symbol: a.symbol, decimals: a.decimals };
  if (price !== undefined) t.priceFiat = price;
  return t;
}

async function simulateSwap(ad: EvmAdapter, tx: { to: string; data: `0x${string}`; value: bigint } | null, buy: AssetDef | null): Promise<{ ok: true; received: bigint | null } | { ok: false; reason: string }> {
  if (!tx) return { ok: false, reason: tr('swap.simNoTx') };
  const call = { to: tx.to, data: tx.data, value: tx.value };
  if (!buy) {
    const s = await ad.simulate(call);
    return s.ok ? { ok: true, received: null } : s;
  }
  return ad.simulateReceived(call, buy.kind === 'native' || isNative(swapTokenAddress(buy)) ? 'native' : swapTokenAddress(buy));
}

const accountChainOf = (c: Chain | undefined): AccountChain => (c ? c.family : 'evm');

/** Swaps sign through the vault only for now: a hardware-wallet account gets a clear note. */
export function Swap({ sellAssetId }: { sellAssetId?: string }) {
  const { activeHw, navigate } = useApp();
  const { t } = useT();
  if (activeHw) {
    return (
      <div className="flex flex-1 items-center justify-center px-10">
        <EmptyState
          title={t('swap.hwTitle')}
          action={
            <button type="button" onClick={() => navigate({ name: 'send' })} className="text-[13px] font-semibold text-ice hover:underline">
              {t('swap.hwSendFromAccount')}
            </button>
          }
        >
          {t('swap.hwBody', { device: activeHw.device === 'ledger' ? 'Ledger' : 'Trezor' })}
        </EmptyState>
      </div>
    );
  }
  return <SwapVault {...(sellAssetId ? { sellAssetId } : {})} />;
}

function SwapVault({ sellAssetId }: { sellAssetId?: string }) {
  const { settings, network, swapProviders, navigate } = useApp();
  const { t } = useT();
  const { adapters, accounts } = useVault();
  const pf = usePortfolio();
  const cur = settings.currency;

  // EVM (where 0x / LI.FI has a checked contract, or 1Click serves it) and Solana first, then the
  // chains swaps leave through NEAR Intents (mainnet).
  const chains = useMemo(
    () => [...evmChains(network).filter((c) => canSwapFrom(c, network)), solChain(network), ...allChains(network).filter((c) => c.family !== 'evm' && c.family !== 'sol' && canSwapFrom(c, network))].map((c) => ({ key: c.key, label: c.label })),
    [network],
  );
  const initialSell = sellAssetId ? assetsFor(network).find((a) => a.id === sellAssetId) : undefined;
  const [chainKey, setChainKey] = useState(initialSell && chains.some((c) => c.key === initialSell.chainKey) ? initialSell.chainKey : chains[0]?.key ?? 'sepolia');
  const tokens = useMemo(() => assetsFor(network).filter((a) => a.chainKey === chainKey), [network, chainKey]);
  const [sellId, setSellId] = useState(initialSell?.id ?? tokens.find((t) => t.kind !== 'native')?.id ?? tokens[0]?.id ?? '');
  const [buyId, setBuyId] = useState(tokens.find((t) => t.id !== (initialSell?.id ?? sellId))?.id ?? '');
  const sell = tokens.find((t) => t.id === sellId) ?? tokens[0];
  const groups = useMemo(() => buyGroups(network, allChains(network), assetsFor(network), sell), [network, sell]);
  const buyOptions = useMemo(() => groups.flatMap((g) => g.assets), [groups]);
  const buy = buyOptions.find((t) => t.id === buyId) ?? buyOptions.find((t) => t.chainKey === chainKey) ?? buyOptions[0];
  const buyChain = buy ? findChain(network, buy.chainKey) : undefined;
  const cross = !!buy && buy.chainKey !== chainKey;
  const toChain = swapChainOf(buyChain);
  const recipient = cross ? ownAddressOn(accounts, buyChain) : null;
  const [amountStr, setAmountStr] = useState('');
  const [slip, setSlip] = useState<Slip>(50);
  const [slipCustom, setSlipCustom] = useState('2');
  const slippageBps = slip === 'custom' ? Math.round(Number(slipCustom.replace(',', '.')) * 100) : slip;
  const slipValid = Number.isInteger(slippageBps) && slippageBps > 0 && slippageBps <= MAX_SLIPPAGE_BPS;
  const [unlimited, setUnlimited] = useState(false);
  const [confirmUnlimited, setConfirmUnlimited] = useState(false);
  const [password, setPassword] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [execError, setExecError] = useState<string | null>(null);
  const [wrongPw, setWrongPw] = useState(0);
  const [doneId, setDoneId] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [reviewed, setReviewed] = useState<Quote | null>(null);

  useEffect(() => {
    if (!tokens.some((t) => t.id === sellId)) setSellId(tokens.find((t) => t.kind !== 'native')?.id ?? tokens[0]?.id ?? '');
    if (!buyOptions.some((t) => t.id === buyId)) setBuyId(buyOptions.find((t) => t.chainKey === chainKey)?.id ?? buyOptions[0]?.id ?? '');
  }, [tokens, sellId, buyId, buyOptions, chainKey]);

  const sellPrice = sell ? pf.price(sell.coingeckoId)?.price : undefined;
  const buyPrice = buy ? pf.price(buy.coingeckoId)?.price : undefined;
  const chain = findChain(network, chainKey);
  const native = tokens.find((t) => t.kind === 'native');
  const nativePrice = native ? pf.price(native.coingeckoId)?.price : undefined;
  const balance = sell ? pf.balances.get(sell.id) ?? 0n : 0n;
  const sellAmount = sell && amountStr ? tryParseUnits(amountStr, sell.decimals) : null;
  const over = sellAmount !== null && sellAmount > balance;
  const taker = ownAddressOn(accounts, chain) ?? '';
  const evmAdapter: EvmAdapter | undefined = chain?.family === 'evm' ? adapters.evm.get(chainKey) : undefined;
  const sourceAdapter = sell ? depositAdapterFor(sell, adapters) : undefined;
  const [deposit, setDeposit] = useState<PreparedDeposit | null>(null);

  const params: QuoteParams | null = useMemo(() => {
    const from = swapChainOf(chain);
    if (!sell || !buy || !chain || from === null || !taker || !sellAmount || sellAmount <= 0n || !slipValid) return null;
    if (cross && (toChain === null || !recipient)) return null;
    const p: QuoteParams = {
      chain: from,
      ...(cross && toChain !== null && recipient ? { toChain, recipient } : {}),
      sell: tokenOf(sell, sellPrice),
      buy: tokenOf(buy, buyPrice),
      sellAmount,
      taker,
      slippageBps,
      usdToFiat: cur === 'USD' ? 1 : (pf.price('usd-coin')?.price ?? pf.price('tether')?.price ?? 0.92),
    };
    if (nativePrice !== undefined) p.nativePriceFiat = nativePrice;
    return p;
  }, [sell, buy, chain, sellAmount, slipValid, sellPrice, buyPrice, taker, slippageBps, cur, pf, nativePrice, cross, toChain, recipient]);
  const debouncedKey = useDebounced(params ? JSON.stringify({ ...params, sellAmount: params.sellAmount.toString() }) : null, 600);

  const quotes = useAsync<{ quotes: Quote[]; results: QuoteResult[] }>(params && debouncedKey ? () => fetchQuotes(swapProviders, params) : null, [debouncedKey], { intervalMs: 30_000 });
  const list = quotes.data?.quotes ?? [];
  const chosen = list[0];
  const failures = (quotes.data?.results ?? []).filter((r) => r.error);
  useOnTorReady(quotes.reload);
  // Quotes blocked by Tor: one inline "waiting for Tor" line instead of a red error per provider.
  const quotesTorBlocked = useTorBlocked(quotes.error ?? (failures.length > 0 && failures.length === (quotes.data?.results.length ?? 0) ? failures.map((f) => f.error).join(' ') : undefined));

  const needsAllowanceCheck = !!chosen && !!evmAdapter && sell?.kind === 'erc20' && !!chosen.allowanceTarget && !!sell.contract;
  const allowance = useAsync<bigint>(needsAllowanceCheck ? () => evmAdapter!.allowance(sell!.contract!, chosen!.allowanceTarget!) : null, [needsAllowanceCheck, chosen?.provider, chosen?.allowanceTarget, sell?.id, phase === 'idle']);
  const needsApproval = needsAllowanceCheck && sellAmount !== null && (allowance.data ?? 0n) < sellAmount;
  const existingUnlimited = allowance.data !== undefined && isUnlimitedAllowance(allowance.data);

  const simKey = chosen && chosen.tx.kind === 'evm' && !needsApproval && allowance.data !== undefined ? `${chosen.provider}:${chosen.tx.data.slice(0, 66)}:${chosen.buyAmount}` : chosen && chosen.tx.kind === 'evm' && !needsAllowanceCheck ? `${chosen.provider}:${chosen.buyAmount}` : null;
  const sim = useAsync(
    simKey && evmAdapter && chosen?.tx.kind === 'evm' && buy ? () => simulateSwap(evmAdapter, chosen.tx.kind === 'evm' ? chosen.tx : null, chosen.cross ? null : buy) : null,
    [simKey],
  );

  const buyAmount = chosen?.buyAmount ?? null;
  const feeReasons = [...new Set(failures.map((f) => f.error ?? '').filter((e) => e.includes('Kyro')))];
  const busy = phase !== 'idle' && phase !== 'done';
  const shown = confirmOpen ? reviewed ?? chosen : chosen;
  const canSwap = !!shown && !!password && !over && !busy && (shown.tx.kind !== 'evm' || (!!evmAdapter && !!shown.evmCheck)) && (shown.tx.kind !== 'deposit' || (!!deposit && !!sourceAdapter));

  const dialogFees = useAsync(confirmOpen && evmAdapter ? () => evmAdapter.estimateFees() : null, [confirmOpen, evmAdapter]);
  const dialogFee = dialogFees.data?.options.normal.params;
  const swapGas = shown?.tx.kind === 'evm' && shown.tx.gas ? (shown.tx.gas * 12n) / 10n : null;
  const swapMaxFee = dialogFee?.family === 'evm' && swapGas !== null ? swapGas * dialogFee.maxFeePerGas : null;
  const approvalMaxFee = dialogFee?.family === 'evm' && needsApproval ? 120_000n * dialogFee.maxFeePerGas : 0n;

  const buildDeposit = (plan: DepositPlan): Promise<PreparedDeposit> => {
    if (!sell) throw new Error(t('swap.errNothingToSell'));
    return buildDepositTx(sell, adapters, plan);
  };

  const prepareDeposit = async (q: Quote) => {
    if (q.tx.kind !== 'deposit') return;
    setDeposit(null);
    setPhase('checking');
    try {
      const plan = await q.tx.prepare();
      const prepared = await buildDeposit(plan);
      setDeposit(prepared);
      setReviewed({ ...q, buyAmount: plan.amountOut, minBuyAmount: plan.minAmountOut });
    } catch (e) {
      setExecError(toIpcError(e).message);
    } finally {
      setPhase('idle');
    }
  };

  const openConfirm = () => {
    setReviewed(chosen ?? null);
    setExecError(null);
    setDeposit(null);
    setConfirmOpen(true);
    if (chosen?.tx.kind === 'deposit') void prepareDeposit(chosen);
  };

  /** 0x: the Settler that AllowanceHolder calls must be the registry's current (or previous) one. */
  const assertSettler = async (settler: string) => {
    if (!evmAdapter) throw new Error(t('swap.errNoEvmNetwork'));
    const ok = await isCurrentZeroExSettler(settler, (fn) =>
      evmAdapter.client.readContract({ address: ZEROX_SETTLER_REGISTRY, abi: ZEROX_REGISTRY_ABI, functionName: fn, args: [ZEROX_TAKER_SETTLER_FEATURE] }) as Promise<string>,
    );
    if (!ok) throw new Error(t('swap.errSettler'));
  };

  const execute = async () => {
    const quote = shown;
    if (!quote || !sell || !buy || !sellAmount || !params) return;
    setExecError(null);
    try {
      if (quote.tx.kind === 'deposit') {
        if (!deposit || !sourceAdapter) throw new Error(t('swap.errDepositNotPrepared'));
        setPhase('checking');
        const plan = await quote.tx.reconfirm(deposit.plan);
        if (plan.depositAddress !== deposit.plan.depositAddress || plan.minAmountOut < deposit.plan.minAmountOut) throw new Error(t('swap.errBridgeChanged'));
        const fresh = await buildDeposit(plan);
        setPhase('swapping');
        const id = await signAndBroadcast(sourceAdapter, fresh.unsigned, password);
        recordSwap(id, quote, { fee: fresh.unsigned.maxFee.toString(), counterparty: plan.depositAddress }, plan.depositAddress, plan.orderId);
        // Exolix: Kyro's service fee, a second plain transfer of the same coin (checked like the deposit).
        const feeTx = await buildKyroFeeTx(sell, adapters, plan);
        if (feeTx) await signAndBroadcast(sourceAdapter, feeTx.unsigned, password);
        setDoneId(id);
        setPhase('done');
        setPassword('');
        setConfirmOpen(false);
        setDeposit(null);
        pf.refresh();
        return;
      }
      if (quote.tx.kind === 'solana') {
        if (!adapters.sol) throw new Error(t('swap.errNoSolAccount'));
        setPhase('checking');
        const wire = await quote.tx.build();
        if (quote.tx.verify) {
          // LI.FI cross-chain: Rust decodes, Kyro checks the transfers, NEAR Intents confirms the deposit — BEFORE the password.
          const routeCheck = await quote.tx.verify(wire, await adapters.sol.decodeWire(wire));
          setPhase('swapping');
          const signed = await adapters.sol.signWireTransaction(wire, password);
          const signedCheck = await quote.tx.verify(wire, signed.summary);
          if (signedCheck.depositAddress !== routeCheck.depositAddress) throw new Error(t('swap.errSignedMismatch'));
          const id = await adapters.sol.broadcast(signed);
          recordSwap(id, quote);
          setDoneId(id);
          setPhase('done');
          setPassword('');
          setConfirmOpen(false);
          pf.refresh();
          return;
        }
        // Third-party transaction: decoded by Rust, then checked against what you reviewed, BEFORE the password is used.
        const check = {
          wire,
          taker,
          sellMint: tokenOf(sell).address,
          buyMint: tokenOf(buy).address,
          sellAmount,
          slippageBps,
          quotedOut: quote.buyAmount,
          fee: quote.kyroFeeBps > 0 ? { bps: quote.kyroFeeBps, account: quote.solFeeAccount ?? '' } : null,
        };
        await verifyJupiterSwap({ ...check, summary: await adapters.sol.decodeWire(wire) });
        setPhase('swapping');
        const signed = await adapters.sol.signWireTransaction(wire, password);
        await verifyJupiterSwap({ ...check, summary: signed.summary });
        const id = await adapters.sol.broadcast(signed);
        recordSwap(id, quote);
        setDoneId(id);
        setPhase('done');
        setPassword('');
        setConfirmOpen(false);
        pf.refresh();
        return;
      }
      if (!evmAdapter || chain?.family !== 'evm') throw new Error(t('swap.errNoEvmNetwork'));
      const known = knownSwapContract(quote.provider, chain.chainId);
      const check0 = quote.evmCheck;
      if (!check0 || !known || check0.contract.toLowerCase() !== known.toLowerCase()) throw new Error(t('swap.errQuoteUnverified'));
      setPhase('checking');
      if (check0.settler) await assertSettler(check0.settler);
      const fee = dialogFee ?? (await evmAdapter.estimateFees()).options.normal.params;
      if (fee.family !== 'evm') throw new Error(t('swap.errNoEvmFees'));

      if (needsApproval && quote.allowanceTarget && sell.contract) {
        if (quote.allowanceTarget.toLowerCase() !== known.toLowerCase()) throw new Error(t('swap.errUnknownSpender'));
        setPhase('approving');
        if (requiresZeroAllowanceFirst(chain.chainId, sell.contract, allowance.data ?? 0n)) {
          const reset = buildRevoke(sell.contract, quote.allowanceTarget);
          const u0 = await evmAdapter.buildCall({ to: reset.to, data: reset.data, fee, kind: 'approval', asset: sell, amount: 0n, token: { symbol: sell.symbol, decimals: sell.decimals } });
          const h0 = await evmAdapter.broadcast(await evmAdapter.signTx(u0, password));
          setPhase('waiting');
          if (!(await evmAdapter.waitForReceipt(h0))) throw new Error(t('swap.errResetFailed'));
          setPhase('approving');
        }
        const approval = buildApproval({ token: sell.contract, spender: quote.allowanceTarget, amount: sellAmount, unlimited });
        const unsigned = await evmAdapter.buildCall({ to: approval.to, data: approval.data, fee, kind: 'approval', asset: sell, amount: approval.amount, token: { symbol: sell.symbol, decimals: sell.decimals } });
        const decoded = await evmAdapter.decode(unsigned);
        if (decoded.kind !== 'Erc20Approve' || decoded.spender?.toLowerCase() !== approval.spender.toLowerCase() || decoded.unlimitedApproval !== unlimited) {
          throw new Error(t('swap.errApprovalDecode'));
        }
        const signed = await evmAdapter.signTx(unsigned, password);
        const hash = await evmAdapter.broadcast(signed);
        addApproval({ network, chainId: chain.chainId, chainKey, token: sell.contract, tokenSymbol: sell.symbol, tokenDecimals: sell.decimals, spender: approval.spender, spenderLabel: quote.providerName, amount: approval.amount.toString(), unlimited, time: Date.now(), txHash: hash });
        addLocalTx({ id: hash, network, chainKey, assetId: sell.id, kind: 'approval', direction: 'self', amount: unlimited ? '0' : sellAmount.toString(), label: t(unlimited ? 'swap.txApprovalLabelUnlimited' : 'swap.txApprovalLabel', { symbol: sell.symbol, provider: quote.providerName }), time: Date.now(), status: 'pending' });
        setPhase('waiting');
        const ok = await evmAdapter.waitForReceipt(hash);
        if (!ok) throw new Error(t('swap.errApprovalFailed'));
      }

      // Fresh quote (calldata may depend on the allowance / block): checked again by the provider
      // (verify.ts), then against the reviewed one, then simulated.
      setPhase('simulating');
      const provider = swapProviders.find((p) => p.id === quote.provider);
      if (!provider) throw new Error(t('swap.errNoProvider'));
      const fresh = await provider.quote(params);
      if (fresh.tx.kind !== 'evm' || quote.tx.kind !== 'evm' || !fresh.evmCheck) throw new Error(t('swap.errUnexpectedTx'));
      const cmp = compareFreshQuote({ ...quote, tx: quote.tx }, { ...fresh, tx: fresh.tx });
      if (!cmp.ok) throw new Error(cmp.reason);
      if (cmp.degraded) {
        // Never accepted silently: show the new minimum and ask again.
        setReviewed(fresh);
        setPhase('idle');
        allowance.reload();
        setExecError(t('swap.errPriceMoved', { fresh: fmtCrypto(fresh.minBuyAmount, buy.decimals, buy.symbol, 6), old: fmtCrypto(quote.minBuyAmount, buy.decimals, buy.symbol, 6) }));
        return;
      }
      if (fresh.evmCheck.settler && fresh.evmCheck.settler !== check0.settler) await assertSettler(fresh.evmCheck.settler);
      if (!!quote.cross !== !!fresh.cross || (fresh.cross && fresh.cross.recipient !== quote.cross?.recipient)) throw new Error(t('swap.errDestinationChanged'));
      const s = await simulateSwap(evmAdapter, fresh.tx, fresh.cross ? null : buy);
      if (!s.ok) throw new Error(t('swap.errSimFails', { reason: s.reason }));
      if (s.received !== null && s.received < fresh.minBuyAmount) throw new Error(t('swap.errSimBelowMin', { amount: fmtCrypto(s.received, buy.decimals, buy.symbol, 6) }));

      setPhase('swapping');
      const unsigned = await evmAdapter.buildCall({ to: fresh.tx.to, data: fresh.tx.data, value: fresh.tx.value, fee, kind: 'swap', asset: sell, amount: sellAmount, ...(fresh.tx.gas ? { gas: (fresh.tx.gas * 12n) / 10n } : {}) });
      if (swapMaxFee !== null && unsigned.maxFee > (swapMaxFee * 12n) / 10n) {
        setReviewed(fresh);
        setPhase('idle');
        setExecError(t('swap.errFeesRose', { fee: native ? fmtCrypto(unsigned.maxFee, native.decimals, native.symbol) : unsigned.maxFee.toString() }));
        return;
      }
      // Rust's decoding must be exactly the call that was checked (contract from Kyro's list, same data and value).
      const decoded = await evmAdapter.decode(unsigned);
      if (decoded.to.toLowerCase() !== known.toLowerCase() || unsigned.tx.data !== fresh.tx.data || unsigned.tx.valueWei !== fresh.tx.value.toString()) throw new Error(t('swap.errTxMismatch'));
      const signed = await evmAdapter.signTx(unsigned, password);
      const hash = await evmAdapter.broadcast(signed);
      recordSwap(hash, fresh, { fee: unsigned.maxFee.toString(), counterparty: fresh.tx.to });
      setDoneId(hash);
      setPhase('done');
      setPassword('');
      setConfirmOpen(false);
      pf.refresh();
    } catch (e) {
      const err = toIpcError(e);
      if (err.code === 'WRONG_PASSWORD') setWrongPw((n) => n + 1);
      else setExecError(err.code === 'USER_REJECTED' ? t('swap.signCancelled') : err.message);
      setPhase('idle');
      allowance.reload();
    }
  };

  function recordSwap(id: string, q: Quote, extra: { fee?: string; counterparty?: string } = {}, depositAddress?: string, orderId?: string) {
    if (!sell || !buy || !sellAmount) return;
    const arrival = q.cross && buyChain ? t('swap.historyArrival', { chain: buyChain.label }) : '';
    addLocalTx({
      id,
      network,
      chainKey,
      assetId: sell.id,
      kind: 'swap',
      direction: 'out',
      amount: sellAmount.toString(),
      ...extra,
      label: `Swap ${fmtCrypto(sellAmount, sell.decimals)} ${sell.symbol} → ${buy.symbol}${arrival}`,
      time: Date.now(),
      status: 'pending',
      ...(q.cross && buyChain ? { cross: { fromChain: String(q.cross.fromChain), toChain: String(q.cross.toChain), toChainKey: buyChain.key, bridge: q.cross.bridge, ...(depositAddress ? { depositAddress } : {}), ...(orderId ? { orderId } : {}) } } : {}),
    });
  }

  const ctaLabel = needsApproval ? t('swap.ctaApproveThenSwap') : t('swap.ctaSwap');
  const phaseLabel: Record<Phase, string> = { idle: '', approving: t('swap.phaseApproving'), waiting: t('swap.phaseWaiting'), simulating: t('swap.phaseSimulating'), checking: t('swap.phaseChecking'), swapping: t('swap.phaseSwapping'), done: '' };

  if (!sell || !buy || !chain) return <EmptyState title={t('swap.noAssets')} />;

  const pickerItem = (a: AssetDef, c: Chain, comingSoon = false): TokenPickerItem => {
    const held = pf.balances.get(a.id) ?? 0n;
    return { id: a.id, symbol: a.symbol, name: a.name, network: c.label, networkName: c.name, coingeckoId: a.coingeckoId, held: held > 0n, disabled: comingSoon, ...(comingSoon ? { note: t('swap.sourceComingSoon') } : {}), hint: `${a.name} · ${fmtCrypto(held, a.decimals)}`, icon: <CoinIcon asset={a} size={24} /> };
  };
  const sellList = sellChoices(network, allChains(network), assetsFor(network));
  const sellItems = sellList.map((c) => pickerItem(c.asset, c.chain, c.comingSoon));
  const buyItems = groups.flatMap((g) => g.assets.map((a) => pickerItem(a, g.chain)));
  const selectSell = (id: string) => {
    const c = sellList.find((x) => x.asset.id === id && !x.comingSoon);
    if (!c) return;
    if (id === buy.id) setBuyId(sell.id);
    if (c.chain.key !== chainKey) {
      setChainKey(c.chain.key);
      setAmountStr('');
    }
    setSellId(id);
  };
  const canInvert = !cross || canSwapFrom(buyChain, network);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 px-8 pt-7 pb-6">
      <header className="flex items-center justify-between gap-4 border-b border-line pb-4">
        <div className="flex items-center gap-4">
          <h1 className="screen-title">{t('swap.title')}</h1>
          <Menu
            value={chainKey}
            onSelect={(k) => {
              setChainKey(k);
              setAmountStr('');
            }}
            items={[...chains.map((c) => ({ value: c.key, label: c.label })), ...sellList.filter((c) => c.comingSoon && c.asset.kind === 'native').map((c) => ({ value: c.chain.key, label: c.chain.label, hint: t('swap.sourceComingSoon'), disabled: true }))]}
            trigger={
              <button type="button" className="press flex h-9 items-center gap-2 rounded-ctl border border-line-2 px-3.5 text-[13px] text-text2 hover:border-line-3 hover:bg-raised hover:text-text">
                {chain.name} <IconChevronDown size={13} />
              </button>
            }
          />
          <AccountPicker family={accountChainOf(chain)} />
        </div>
        <div className="flex items-center gap-2.5">
          <span className="eyebrow">{t('swap.slippageMax')}</span>
          <Segmented<Slip>
            label={t('swap.slippage')}
            value={slip}
            onChange={setSlip}
            options={[
              { value: 10, label: fmtPct(0.1, { sign: false, decimals: 1 }) },
              { value: 50, label: fmtPct(0.5, { sign: false, decimals: 1 }) },
              { value: 100, label: fmtPct(1, { sign: false, decimals: 0 }) },
              { value: 'custom', label: t('swap.slippageCustom') },
            ]}
          />
          {slip === 'custom' && (
            <label className="pop-in flex h-9 items-center gap-1 rounded-ctl border border-line-2 bg-bg px-2.5 focus-within:border-ice-line">
              <span className="sr-only">{t('swap.slippageCustomLabel')}</span>
              <input value={slipCustom} inputMode="decimal" onChange={(e) => setSlipCustom(sanitizeDecimalInput(e.target.value, 2))} className="w-10 bg-transparent text-right text-[13px]" />
              <span className="text-[12px] text-mute">%</span>
            </label>
          )}
        </div>
      </header>
      {slip === 'custom' && !slipValid && <span className="-mt-2 text-right text-[12px] text-down">{t('swap.slippageRange')}</span>}
      {slip === 'custom' && slipValid && slippageBps > 300 && <span className="-mt-2 text-right text-[12px] text-warn">{t('swap.slippageHigh')}</span>}

      <div className="flex min-h-0 flex-1 gap-5">
        <section className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto rounded-panel border border-line bg-card p-[22px] scroll-thin">
          <div className="relative flex flex-col gap-2">
            <TokenPanel
              label={t('swap.youGive')}
              right={
                <>
                  {t('swap.balance', { amount: fmtCrypto(balance, sell.decimals) })} ·{' '}
                  <button type="button" className="font-semibold text-ice" onClick={() => setAmountStr(toInputDecimal(sell.kind === 'native' ? (balance * 97n) / 100n : balance, sell.decimals))}>
                    {t('swap.maxButton')}
                  </button>
                </>
              }
              amount={
                <input
                  aria-label={t('swap.amountGiven')}
                  value={amountStr}
                  inputMode="decimal"
                  placeholder="0"
                  onChange={(e) => setAmountStr(sanitizeDecimalInput(e.target.value, sell.decimals))}
                  className={cn('figure w-full min-w-0 bg-transparent text-[42px] tracking-[-0.035em]', over && 'text-down')}
                />
              }
              sub={sellAmount && sellPrice !== undefined ? `≈ ${fmtFiat(unitsToNumber(sellAmount, sell.decimals) * sellPrice, cur)}` : over ? t('swap.insufficient') : ' '}
              token={<TokenButton title={t('swap.pickGive')} asset={sell} items={sellItems} onSelect={selectSell} />}
            />
            <button
              type="button"
              aria-label={t('swap.swapDirection')}
              disabled={!canInvert}
              title={canInvert ? undefined : t('swap.noSwapFrom', { chain: buyChain?.label ?? t('swap.thisNetwork') })}
              onClick={() => {
                if (cross) setChainKey(buy.chainKey);
                setSellId(buy.id);
                setBuyId(sell.id);
                setAmountStr('');
              }}
              className="group absolute top-1/2 left-1/2 z-10 flex size-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-ctl border border-line-3 bg-card text-text shadow-[0_0_0_4px_var(--color-card)] transition-colors hover:border-ice-line hover:bg-raised active:scale-95"
            >
              <IconDown size={15} />
            </button>
            <TokenPanel
              label={cross ? t('swap.youReceiveOnEstimated', { chain: buyChain?.label ?? buy.chainKey }) : t('swap.youReceiveEstimated')}
              right={<>{t('swap.balance', { amount: fmtCrypto(pf.balances.get(buy.id) ?? 0n, buy.decimals) })}</>}
              amount={<span key={buyAmount ? String(buyAmount) : 'none'} className={cn('figure fade-in block truncate text-[42px]', !buyAmount && 'text-faint')}>{buyAmount ? fmtCrypto(buyAmount, buy.decimals, undefined, 6) : quotes.loading ? '…' : '0'}</span>}
              sub={buyAmount && buyPrice !== undefined ? `≈ ${fmtFiat(unitsToNumber(buyAmount, buy.decimals) * buyPrice, cur)}` : ' '}
              note={<FeesIncludedLink />}
              token={<TokenButton title={t('swap.pickReceive')} asset={buy} items={buyItems} onSelect={setBuyId} />}
            />
          </div>

          {chosen && (
            <div className="fade-in flex flex-col rounded-box border border-line bg-bg px-4 text-[13px]">
              <div className="flex h-9 items-center justify-between border-b border-line">
                <span className="text-mute">{t('swap.minGuaranteed')}</span>
                <span className="font-medium">{fmtCrypto(chosen.minBuyAmount, buy.decimals, buy.symbol, 6)}</span>
              </div>
              <div className="flex h-9 items-center justify-between">
                <span className="text-mute">{t('swap.networkFees')}</span>
                <span className="text-text2">{chosen.gasFeeFiat !== null ? `≈ ${fmtFiat(chosen.gasFeeFiat, cur)}` : t('swap.networkFeesAtReview')}</span>
              </div>
            </div>
          )}

          {chosen && needsAllowanceCheck && (
            <div className="fade-in flex flex-col gap-2.5 rounded-box border border-line border-l-2 border-l-ice/60 bg-bg px-4 py-3.5">
              <div className="flex items-center justify-between">
                <span className="text-[14px] font-medium">{t('swap.approvalOf', { symbol: sell.symbol })}</span>
                <span className="text-[12px] text-mute">{needsApproval ? t('swap.step1of2') : allowance.loading ? t('swap.checking') : t('swap.alreadyApproved')}</span>
              </div>
              <div className="flex items-center justify-between text-[13px]">
                <span className="text-mute">{t('swap.approvedAmount')}</span>
                <span className="font-semibold">{needsApproval ? (unlimited ? <span className="text-down">{t('swap.unlimited')}</span> : t('swap.exactAmount', { amount: fmtCrypto(sellAmount ?? 0n, sell.decimals, sell.symbol) })) : existingUnlimited ? <span className="text-down">{t('swap.unlimitedInPlace')}</span> : t('swap.inPlace', { amount: fmtCrypto(allowance.data ?? 0n, sell.decimals, sell.symbol) })}</span>
              </div>
              {needsApproval && (
                <div className="flex items-center justify-between text-[13px]">
                  <span className="text-text2">{t('swap.approveUnlimited')}</span>
                  <Switch label={t('swap.approveUnlimited')} checked={unlimited} onCheckedChange={(v) => (v ? setConfirmUnlimited(true) : setUnlimited(false))} />
                </div>
              )}
            </div>
          )}

          <div className="flex-1" />
          {chosen && chosen.tx.kind === 'evm' && (
            <div className="flex items-center gap-2 text-[13px]">
              {needsApproval ? (
                <span className="text-mute">{t('swap.simAfterApproval')}</span>
              ) : sim.loading ? (
                <span className="flex items-center gap-2 text-mute"><Spinner /> {t('swap.simulating')}</span>
              ) : sim.data?.ok && sim.data.received !== null && chosen.minBuyAmount > 0n && sim.data.received < chosen.minBuyAmount ? (
                <span className="flex items-center gap-2 text-down"><IconWarn size={15} /> {t('swap.simBelowMin')}</span>
              ) : sim.data?.ok ? (
                <span className="flex items-center gap-2 text-up">
                  <IconCheck size={15} /> {sim.data.received !== null ? t('swap.simOkReceived', { amount: fmtCrypto(sim.data.received, buy.decimals, buy.symbol, 6) }) : t('swap.simOkUnmeasured')}
                </span>
              ) : sim.data && !sim.data.ok ? (
                <span className="flex items-center gap-2 text-down"><IconWarn size={15} /> {t('swap.simFails', { reason: sim.data.reason })}</span>
              ) : null}
            </div>
          )}
          {phase !== 'idle' && phase !== 'done' && (
            <span className="flex items-center gap-2 text-[13px] text-ice-text2">
              <Spinner /> {phaseLabel[phase]}
            </span>
          )}
          {execError && <Notice tone="error">{execError}</Notice>}
          {phase === 'done' && doneId && (
            <Notice tone="success">
              {rt('swap.broadcast', {}, { id: <span className="font-mono">{shortAddress(doneId, 10, 8)}</span> })}{' '}
              <button type="button" className="font-semibold underline" onClick={() => navigate({ name: 'history' })}>
                {t('swap.viewHistory')}
              </button>
            </Notice>
          )}
          <Button variant="primary" size="xl" className="h-[46px] self-end px-10" disabled={!chosen || over || busy || (chosen.tx.kind === 'evm' && !evmAdapter) || (chosen.tx.kind === 'deposit' && !sourceAdapter)} onClick={openConfirm}>
            {t('swap.review')}
          </Button>
        </section>

        <div className="rise flex w-[400px] shrink-0 flex-col gap-4">
          <section className="flex flex-col gap-2.5 rounded-panel border border-line bg-card p-[18px]">
            <div className="flex items-center justify-between px-1">
              <span className="text-[15px] font-medium tracking-[-0.01em]">{t('swap.bestPrice')}</span>
              <span className="text-[12px] text-faint">{quotes.loading ? t('swap.refreshing') : ''}</span>
            </div>
            {!params && <p className="m-0 px-1 py-2 text-[13px] text-mute">{t('swap.enterAmount')}</p>}
            {params && quotes.loading && !quotes.data && <div className="skeleton h-[62px] rounded-box" />}
            {params && quotes.data && list.length === 0 && !quotesTorBlocked && (
              <p className="m-0 px-1 text-[13px] text-mute">{network === 'testnet' ? t('swap.noPriceTestnet') : t('swap.noPrice')}</p>
            )}
            {cross && !recipient && <Notice tone="warn">{t('swap.noAccountToReceive', { chain: buyChain?.label ?? '' })}</Notice>}
            {list.length === 0 && feeReasons.map((r) => <Notice key={r} tone="warn">{r}</Notice>)}
            {quotesTorBlocked && (failures.length > 0 || quotes.error) && <TorWait className="px-1" />}
            {quotes.error && !quotesTorBlocked && <Notice tone="error">{quotes.error.message}</Notice>}
          </section>
        </div>
      </div>

      {/* Confirmation before signing: the only place that names the contract (security), then the native dialog. */}
      <Dialog open={confirmOpen && !!shown && !!sellAmount} onOpenChange={(o) => !busy && setConfirmOpen(o)} title={t('swap.confirmTitle')}>
        {shown && sellAmount && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col rounded-box border border-line bg-bg px-4 text-[13px]">
              <div className="flex h-10 items-center justify-between border-b border-line">
                <span className="text-mute">{t('swap.youGive')}</span>
                <span className="font-medium">{fmtCrypto(sellAmount, sell.decimals, sell.symbol)}</span>
              </div>
              <div className="flex h-10 items-center justify-between border-b border-line">
                <span className="text-mute">{t('swap.youReceive')}</span>
                <span className="flex flex-col items-end">
                  <span className="font-medium">≈ {fmtCrypto(shown.buyAmount, buy.decimals, buy.symbol, 6)}</span>
                  <FeesIncludedLink />
                </span>
              </div>
              <div className="flex h-10 items-center justify-between border-b border-line">
                <span className="text-mute">{t('swap.minGuaranteed')}</span>
                <span className="font-medium">{fmtCrypto(shown.minBuyAmount, buy.decimals, buy.symbol, 6)}</span>
              </div>
              {shown.tx.kind === 'solana' && (
                <div className="flex h-10 items-center justify-between border-b border-line">
                  <span className="text-mute">{t('swap.networkFees')}</span>
                  <span className="font-medium">{shown.gasFeeFiat !== null ? `≈ ${fmtFiat(shown.gasFeeFiat, cur)}` : '—'}</span>
                </div>
              )}
              {shown.tx.kind === 'deposit' && (
                <div className="flex h-10 items-center justify-between border-b border-line">
                  <span className="text-mute">{t('swap.maxNetworkFees')}</span>
                  <span className="font-medium">
                    {deposit && native ? `${fmtCrypto(deposit.unsigned.maxFee, native.decimals, native.symbol)}${nativePrice !== undefined ? ` · ${fmtFiat(unitsToNumber(deposit.unsigned.maxFee, native.decimals) * nativePrice, cur)}` : ''}` : phase === 'checking' ? '…' : '—'}
                  </span>
                </div>
              )}
              {shown.tx.kind === 'evm' && (
                <div className="flex h-10 items-center justify-between border-b border-line">
                  <span className="text-mute">{t('swap.maxNetworkFees')}</span>
                  <span className="font-medium">
                    {swapMaxFee !== null && native ? `${fmtCrypto(swapMaxFee + approvalMaxFee, native.decimals, native.symbol)}${nativePrice !== undefined ? ` · ${fmtFiat(unitsToNumber(swapMaxFee + approvalMaxFee, native.decimals) * nativePrice, cur)}` : ''}${needsApproval ? t('swap.withApproval') : ''}` : dialogFees.loading ? '…' : '—'}
                  </span>
                </div>
              )}
              <div className="flex h-10 items-center justify-between border-b border-line">
                <span className="text-mute">{t('swap.recipient')}</span>
                <span className="text-text2">
                  {shown.cross
                    ? t('swap.recipientCross', { chain: buyChain?.label ?? '', address: shortAddress(shown.cross.recipient) })
                    : shown.tx.kind === 'evm'
                      ? shown.evmCheck
                        ? t('swap.recipientEvm')
                        : '—'
                      : t('swap.recipientSol')}
                </span>
              </div>
              {shown.tx.kind === 'deposit' && (
                <div className="flex h-10 items-center justify-between border-b border-line">
                  <span className="text-mute">{t('swap.depositAddress')}</span>
                  <span className="font-mono text-[12px] text-text2">{deposit ? shortAddress(deposit.plan.depositAddress, 8, 6) : phase === 'checking' ? t('swap.depositAddressRequested') : '—'}</span>
                </div>
              )}
              {shown.cross && (
                <div className="flex h-10 items-center justify-between border-b border-line">
                  <span className="text-mute">{t('swap.bridge')}</span>
                  <span className="text-text2">
                    {shown.cross.bridgeName}
                    {shown.etaSecs !== undefined ? t('swap.arrivalEta', { eta: fmtEta(shown.etaSecs) }) : ''}
                  </span>
                </div>
              )}
              <div className="flex h-10 items-center justify-between">
                <span className="text-mute">{t('swap.contract')}</span>
                <span className="font-mono text-[12px] font-medium">
                  {shown.tx.kind === 'deposit' ? t('swap.contractNone') : `${shown.providerName} · ${shown.tx.kind === 'evm' ? shortAddress(shown.evmCheck?.contract ?? shown.tx.to) : shown.cross ? t('swap.lifiTransaction') : t('swap.jupiterProgram')}`}
                </span>
              </div>
            </div>
            <EnClair tone={needsApproval && unlimited ? 'warn' : 'ice'}>
              {shown.cross
                ? t('swap.plainGiveCross', { sell: fmtCrypto(sellAmount, sell.decimals, sell.symbol), min: fmtCrypto(shown.minBuyAmount, buy.decimals, buy.symbol, 6), chain: buyChain?.label ?? '', bridge: shown.cross.bridgeName })
                : t('swap.plainGive', { sell: fmtCrypto(sellAmount, sell.decimals, sell.symbol), min: fmtCrypto(shown.minBuyAmount, buy.decimals, buy.symbol, 6) })}
              {needsApproval
                ? unlimited
                  ? t('swap.plainUnlimited', { provider: shown.providerName, symbol: sell.symbol })
                  : t('swap.plainExact', { provider: shown.providerName, amount: fmtCrypto(sellAmount, sell.decimals, sell.symbol) })
                : ''}
            </EnClair>
            {shown.tx.kind === 'evm' && (
              <SecondConfirmNotice
                lines={[
                  ...(needsApproval ? [t('swap.secondApproval', { provider: shown.providerName, spender: shortAddress(shown.allowanceTarget ?? ''), what: unlimited ? t('swap.secondApprovalUnlimited', { symbol: sell.symbol }) : fmtCrypto(sellAmount, sell.decimals, sell.symbol) })] : []),
                  shown.cross
                    ? t('swap.secondSwapCross', { provider: shown.providerName, deposit: shortAddress(shown.cross.depositAddress ?? ''), bridge: shown.cross.bridgeName, chain: buyChain?.label ?? '' })
                    : t('swap.secondSwap', { provider: shown.providerName }),
                  ...(sell.kind === 'native' ? [t('swap.secondNative', { amount: fmtCrypto(sellAmount, sell.decimals, sell.symbol) })] : []),
                ]}
              />
            )}
            {shown.tx.kind === 'deposit' && <DepositChecks sell={sell} buy={buy} chainLabel={chain.label} buyChainLabel={buyChain?.label ?? ''} sellAmount={sellAmount} quote={shown} deposit={deposit} />}
            {shown.tx.kind === 'solana' && !shown.cross && <span className="text-[13px] text-mute">{t('swap.solBuiltBy', { provider: shown.providerName })}</span>}
            {shown.tx.kind === 'solana' && shown.cross && (
              <SecondConfirmNotice
                lines={[
                  t('swap.solCrossTransfers', { provider: shown.providerName, symbol: sell.symbol, bridge: shown.cross.bridgeName, amount: fmtCrypto(sellAmount, sell.decimals, sell.symbol) }),
                  t('swap.solCrossBridgeConfirms', { bridge: shown.cross.bridgeName, chain: buyChain?.label ?? '', recipient: shortAddress(shown.cross.recipient), symbol: buy.symbol, min: fmtCrypto(shown.minBuyAmount, buy.decimals, buy.symbol, 6) }),
                  t('swap.solCrossTracker'),
                ]}
              />
            )}
            {phase !== 'idle' && phase !== 'done' && (
              <span className="flex items-center gap-2 text-[13px] text-ice-text2">
                <Spinner /> {phaseLabel[phase]}
              </span>
            )}
            {execError && <Notice tone="error">{execError}</Notice>}
            <PasswordField id="swap-pw" value={password} onChange={setPassword} wrong={wrongPw} onEnter={() => canSwap && void execute()} />
            <div className="flex justify-end gap-2">
              <Button disabled={busy} onClick={() => setConfirmOpen(false)}>{t('common.cancel')}</Button>
              <Button variant="primary" disabled={!canSwap} onClick={() => void execute()}>
                {busy && <Spinner />} {ctaLabel}
              </Button>
            </div>
          </div>
        )}
      </Dialog>

      <Dialog open={confirmUnlimited} onOpenChange={setConfirmUnlimited} title={t('swap.unlimitedTitle')}>
        <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />}>
          {t('swap.unlimitedWarn', { contract: shown ? `${shown.providerName} (${shortAddress(shown.allowanceTarget ?? '')})` : '', symbol: sell.symbol })}
        </Notice>
        <p className="m-0 text-[13px] leading-[1.55] text-mute">{t('swap.unlimitedExplain')}</p>
        <div className="flex justify-end gap-2">
          <Button onClick={() => setConfirmUnlimited(false)}>{t('swap.keepExact')}</Button>
          <Button
            variant="danger"
            onClick={() => {
              setUnlimited(true);
              setConfirmUnlimited(false);
            }}
          >
            {t('swap.yesUnlimited')}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

/** What Kyro checked for a NEAR Intents deposit, in plain French (shown before the password). */
function DepositChecks({ sell, buy, chainLabel, buyChainLabel, sellAmount, quote, deposit }: { sell: AssetDef; buy: AssetDef; chainLabel: string; buyChainLabel: string; sellAmount: bigint; quote: Quote; deposit: PreparedDeposit | null }) {
  const { t } = useT();
  const utxo = sell.family === 'btc' || sell.family === 'ltc' || sell.family === 'doge';
  const lines = [
    deposit
      ? t('swap.depCheckNoContract', { amount: fmtCrypto(sellAmount, sell.decimals, sell.symbol), address: shortAddress(deposit.plan.depositAddress, 8, 6) })
      : t('swap.depCheckNoContractNoAddress', { amount: fmtCrypto(sellAmount, sell.decimals, sell.symbol) }),
    t('swap.depCheckConfirmed', { chain: buyChainLabel, recipient: shortAddress(quote.cross?.recipient ?? ''), symbol: buy.symbol, min: fmtCrypto(quote.minBuyAmount, buy.decimals, buy.symbol, 6), fromChain: chainLabel }),
    t('swap.depCheckFees'),
    ...(utxo
      ? [t('swap.depCheckNoOpReturn', { symbol: sell.symbol })]
      : []),
    ...(sell.family === 'xrp' ? [t('swap.depCheckXrpNoTag')] : []),
    t('swap.depCheckDelivery'),
  ];
  return (
    <div role="status" className="fade-in flex flex-col gap-1.5 rounded-box border border-l-2 border-line-2 border-l-ice/60 bg-raised/60 px-4 py-3 text-[12px] leading-[1.5] text-text2">
      <span className="text-[13px] font-semibold text-text">{t('swap.depCheckTitle')}</span>
      <ul className="m-0 flex list-disc flex-col gap-0.5 pl-5">
        {lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
    </div>
  );
}

function FeesIncludedLink() {
  const { t } = useT();
  return (
    <button type="button" className="self-start text-[12px] text-faint underline decoration-dotted underline-offset-2 hover:text-mute" title={t('swap.feesIncludedHint')} onClick={() => void call('open_fees_page').catch(() => undefined)}>
      {t('swap.feesIncluded')}
    </button>
  );
}

function TokenPanel({ label, right, amount, sub, note, token }: { label: string; right: React.ReactNode; amount: React.ReactNode; sub: string; note?: React.ReactNode; token: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 rounded-box border border-line bg-bg px-[22px] py-3.5 transition-[border-color,box-shadow] duration-150 focus-within:shadow-[0_0_0_1px_rgba(124,196,255,.35)]">
      <div className="flex justify-between text-[13px]">
        <span className="eyebrow">{label}</span>
        <span className="text-text2">{right}</span>
      </div>
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">{amount}</div>
        {token}
      </div>
      <span className="text-[13px] text-faint">{sub}</span>
      {note}
    </div>
  );
}

function TokenButton({ title, asset, items, onSelect }: { title: string; asset: AssetDef; items: TokenPickerItem[]; onSelect: (id: string) => void }) {
  return (
    <TokenPicker
      title={title}
      value={asset.id}
      items={items}
      onSelect={onSelect}
      trigger={(open) => (
        <button type="button" onClick={open} className="press flex h-11 shrink-0 items-center gap-2 rounded-ctl border border-line-2 bg-card pr-3 pl-1.5 text-[15px] font-medium tracking-[-0.01em] hover:border-line-3 hover:bg-raised">
          <CoinIcon asset={asset} size={30} />
          {asset.symbol}
          <IconChevronDown size={13} className="text-mute" />
        </button>
      )}
    />
  );
}
