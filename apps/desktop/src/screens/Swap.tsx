// SPDX-License-Identifier: GPL-3.0-or-later
// Swap: quotes compared (0x, 1inch, LI.FI, Jupiter), slippage, exact approval
// by default (unlimited only after explicit confirmation), simulation, "En clair".

import { useEffect, useMemo, useState } from 'react';
import { toIpcError } from '@kyro/shared';
import { assetsFor, evmChains, findChain, solChain, tryParseUnits, unitsToNumber, type AssetDef, type EvmAdapter } from '@kyro/chains';
import { buildApproval, fetchQuotes, isUnlimitedAllowance, NATIVE_EVM, netValueFiat, WSOL_MINT, type Quote, type QuoteParams, type QuoteResult, type SwapToken } from '@kyro/swap';
import { useApp, useVault } from '../state/app';
import { usePortfolio } from '../state/portfolio';
import { useCoinChart } from '../state/charts';
import { cn } from '../lib/cn';
import { fmtAgo, fmtCrypto, fmtEta, fmtFiat, fmtNumber, fmtPct, sanitizeDecimalInput, shortAddress, toInputDecimal } from '../lib/format';
import { addApproval, addLocalTx } from '../lib/storage';
import { priceAt } from '../lib/portfolioSeries';
import { useAsync, useDebounced, useNow } from '../lib/useAsync';
import { CoinIcon, EmptyState, EnClair, PasswordField } from '../components/kit';
import { SmoothChart } from '../components/charts';
import { Menu } from '../components/ui/menu';
import { Dialog } from '../components/ui/dialog';
import { Badge, Button, Notice, Segmented, Spinner, Switch } from '../components/ui/primitives';
import { IconCheck, IconChevronDown, IconDown, IconWarn } from '../components/icons';

type Slip = 10 | 50 | 100 | 'custom';
type Phase = 'idle' | 'approving' | 'waiting' | 'simulating' | 'swapping' | 'done';

function tokenOf(a: AssetDef, price?: number): SwapToken {
  const address = a.kind === 'native' ? (a.family === 'sol' ? WSOL_MINT : NATIVE_EVM) : a.contract ?? '';
  const t: SwapToken = { address, symbol: a.symbol, decimals: a.decimals };
  if (price !== undefined) t.priceFiat = price;
  return t;
}

export function Swap({ sellAssetId }: { sellAssetId?: string }) {
  const { settings, network, swapProviders, navigate } = useApp();
  const { adapters, accounts } = useVault();
  const pf = usePortfolio();
  const cur = settings.currency;
  const now = useNow(1000);

  const chains = useMemo(() => [...evmChains(network).map((c) => ({ key: c.key, label: c.label })), { key: 'solana', label: solChain(network).label }], [network]);
  const initialSell = sellAssetId ? assetsFor(network).find((a) => a.id === sellAssetId) : undefined;
  const [chainKey, setChainKey] = useState(initialSell && initialSell.family !== 'btc' ? initialSell.chainKey : chains[0]?.key ?? 'sepolia');
  const tokens = useMemo(() => assetsFor(network).filter((a) => a.chainKey === chainKey), [network, chainKey]);
  const [sellId, setSellId] = useState(initialSell?.id ?? tokens.find((t) => t.kind !== 'native')?.id ?? tokens[0]?.id ?? '');
  const [buyId, setBuyId] = useState(tokens.find((t) => t.id !== (initialSell?.id ?? sellId))?.id ?? '');
  const sell = tokens.find((t) => t.id === sellId) ?? tokens[0];
  const buy = tokens.find((t) => t.id === buyId && t.id !== sell?.id) ?? tokens.find((t) => t.id !== sell?.id);
  const [amountStr, setAmountStr] = useState('');
  const [slip, setSlip] = useState<Slip>(50);
  const [slipCustom, setSlipCustom] = useState('2');
  const slippageBps = slip === 'custom' ? Math.round(Number(slipCustom.replace(',', '.')) * 100) : slip;
  const slipValid = Number.isInteger(slippageBps) && slippageBps > 0 && slippageBps <= 5000;
  const [selected, setSelected] = useState<string | null>(null);
  const [unlimited, setUnlimited] = useState(false);
  const [confirmUnlimited, setConfirmUnlimited] = useState(false);
  const [password, setPassword] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [execError, setExecError] = useState<string | null>(null);
  const [doneId, setDoneId] = useState<string | null>(null);

  useEffect(() => {
    // Keep the pair valid when the chain changes.
    if (!tokens.some((t) => t.id === sellId)) setSellId(tokens.find((t) => t.kind !== 'native')?.id ?? tokens[0]?.id ?? '');
    if (!tokens.some((t) => t.id === buyId) || buyId === sellId) setBuyId(tokens.find((t) => t.id !== sellId)?.id ?? '');
  }, [tokens, sellId, buyId]);

  const sellPrice = sell ? pf.price(sell.coingeckoId)?.price : undefined;
  const buyPrice = buy ? pf.price(buy.coingeckoId)?.price : undefined;
  const chain = findChain(network, chainKey);
  const native = tokens.find((t) => t.kind === 'native');
  const nativePrice = native ? pf.price(native.coingeckoId)?.price : undefined;
  const balance = sell ? pf.balances.get(sell.id) ?? 0n : 0n;
  const sellAmount = sell && amountStr ? tryParseUnits(amountStr, sell.decimals) : null;
  const over = sellAmount !== null && sellAmount > balance;
  const taker = chainKey === 'solana' ? accounts.sol.address : accounts.evm.address;
  const evmAdapter: EvmAdapter | undefined = chain?.family === 'evm' ? adapters.evm.get(chainKey) : undefined;

  const params: QuoteParams | null = useMemo(() => {
    if (!sell || !buy || !chain || !sellAmount || sellAmount <= 0n || !slipValid) return null;
    const p: QuoteParams = {
      chain: chain.family === 'sol' ? 'solana' : chain.family === 'evm' ? chain.chainId : 0,
      sell: tokenOf(sell, sellPrice),
      buy: tokenOf(buy, buyPrice),
      sellAmount,
      taker,
      slippageBps,
      usdToFiat: cur === 'USD' ? 1 : (pf.price('usd-coin')?.price ?? 0.92),
    };
    if (nativePrice !== undefined) p.nativePriceFiat = nativePrice;
    return p;
  }, [sell, buy, chain, sellAmount, slipValid, sellPrice, buyPrice, taker, slippageBps, cur, pf, nativePrice]);
  const debouncedKey = useDebounced(params ? JSON.stringify({ ...params, sellAmount: params.sellAmount.toString() }) : null, 600);

  const quotes = useAsync<{ quotes: Quote[]; results: QuoteResult[] }>(params && debouncedKey ? () => fetchQuotes(swapProviders, params) : null, [debouncedKey], { intervalMs: 30_000 });
  const list = quotes.data?.quotes ?? [];
  const chosen = list.find((q) => q.provider === selected) ?? list[0];
  const failures = (quotes.data?.results ?? []).filter((r) => r.error);

  // Allowance needed?
  const needsAllowanceCheck = !!chosen && !!evmAdapter && sell?.kind === 'erc20' && !!chosen.allowanceTarget && !!sell.contract;
  const allowance = useAsync<bigint>(needsAllowanceCheck ? () => evmAdapter!.allowance(sell!.contract!, chosen!.allowanceTarget!) : null, [needsAllowanceCheck, chosen?.provider, chosen?.allowanceTarget, sell?.id, phase === 'idle']);
  const needsApproval = needsAllowanceCheck && sellAmount !== null && (allowance.data ?? 0n) < sellAmount;
  const existingUnlimited = allowance.data !== undefined && isUnlimitedAllowance(allowance.data);

  // Simulation (only possible once the allowance is in place).
  const simKey = chosen && chosen.tx.kind === 'evm' && !needsApproval && allowance.data !== undefined ? `${chosen.provider}:${chosen.tx.data.slice(0, 66)}:${chosen.buyAmount}` : chosen && chosen.tx.kind === 'evm' && !needsAllowanceCheck ? `${chosen.provider}:${chosen.buyAmount}` : null;
  const sim = useAsync(simKey && evmAdapter && chosen?.tx.kind === 'evm' ? () => evmAdapter.simulate({ to: chosen.tx.kind === 'evm' ? chosen.tx.to : '', data: chosen.tx.kind === 'evm' ? chosen.tx.data : '0x', value: chosen.tx.kind === 'evm' ? chosen.tx.value : 0n }) : null, [simKey]);

  // Rate chart (buy priced in sell units, 24 h).
  const sellChart = useCoinChart(sell?.coingeckoId ?? null, '1J');
  const buyChart = useCoinChart(buy?.coingeckoId ?? null, '1J');
  const rate = useMemo(() => {
    const b = buyChart.data ?? [];
    const s = sellChart.data ?? [];
    if (b.length < 2 || s.length < 2) return [];
    return b.map(([t, p]) => p / (priceAt(s, t) || 1));
  }, [buyChart.data, sellChart.data]);
  const rateChange = rate.length > 1 ? (((rate[rate.length - 1] ?? 0) - (rate[0] ?? 0)) / (rate[0] || 1)) * 100 : null;

  const buyAmount = chosen?.buyAmount ?? null;
  const execRate = chosen && sell && buy && sellAmount ? unitsToNumber(sellAmount, sell.decimals) / unitsToNumber(chosen.buyAmount, buy.decimals) : null;
  const totalFees = chosen ? (chosen.gasFeeFiat ?? 0) + (chosen.providerFeeIncluded ? 0 : chosen.providerFeeFiat ?? 0) : null;
  const busy = phase !== 'idle' && phase !== 'done';
  const canSwap = !!chosen && !!password && !over && !busy && (chosen.tx.kind !== 'evm' || !!evmAdapter);

  const execute = async () => {
    if (!chosen || !sell || !buy || !sellAmount || !params) return;
    setExecError(null);
    try {
      if (chosen.tx.kind === 'solana') {
        setPhase('swapping');
        const wire = await chosen.tx.build();
        // Rust decodes this third-party transaction and shows it in the native dialog (+ 2nd warning if unusual).
        const signed = await adapters.sol.signWireTransaction(wire, password);
        const id = await adapters.sol.broadcast(signed);
        addLocalTx({ id, network, chainKey, assetId: sell.id, kind: 'swap', direction: 'out', amount: sellAmount.toString(), label: `Swap ${sell.symbol} → ${buy.symbol}`, time: Date.now(), status: 'pending' });
        setDoneId(id);
        setPhase('done');
        setPassword('');
        pf.refresh();
        return;
      }
      if (!evmAdapter || chain?.family !== 'evm') throw new Error('Réseau EVM introuvable');
      const fees = await evmAdapter.estimateFees();
      const fee = fees.options.normal.params;
      if (fee.family !== 'evm') throw new Error('Frais EVM indisponibles');

      if (needsApproval && chosen.allowanceTarget && sell.contract) {
        setPhase('approving');
        const approval = buildApproval({ token: sell.contract, spender: chosen.allowanceTarget, amount: sellAmount, unlimited });
        const unsigned = await evmAdapter.buildCall({ to: approval.to, data: approval.data, fee, kind: 'approval', asset: sell, amount: approval.amount, token: { symbol: sell.symbol, decimals: sell.decimals } });
        const decoded = await evmAdapter.decode(unsigned);
        if (decoded.kind !== 'Erc20Approve' || decoded.spender?.toLowerCase() !== approval.spender.toLowerCase() || decoded.unlimitedApproval !== unlimited) {
          throw new Error('Le décodage de l’autorisation ne correspond pas à ce qui est affiché : arrêt.');
        }
        const signed = await evmAdapter.signTx(unsigned, password);
        const hash = await evmAdapter.broadcast(signed);
        addApproval({ network, chainId: chain.chainId, chainKey, token: sell.contract, tokenSymbol: sell.symbol, tokenDecimals: sell.decimals, spender: approval.spender, spenderLabel: chosen.providerName, amount: approval.amount.toString(), unlimited, time: Date.now(), txHash: hash });
        addLocalTx({ id: hash, network, chainKey, assetId: sell.id, kind: 'approval', direction: 'self', amount: unlimited ? '0' : sellAmount.toString(), label: `Autorisation ${sell.symbol} pour ${chosen.providerName}${unlimited ? ' (illimitée)' : ''}`, time: Date.now(), status: 'pending' });
        setPhase('waiting');
        const ok = await evmAdapter.waitForReceipt(hash);
        if (!ok) throw new Error('L’autorisation a échoué on-chain.');
      }

      // Fresh quote (calldata may depend on the allowance / block), then simulate.
      setPhase('simulating');
      const provider = swapProviders.find((p) => p.id === chosen.provider);
      const fresh = provider ? await provider.quote(params) : chosen;
      if (fresh.tx.kind !== 'evm') throw new Error('Transaction de swap inattendue');
      if (fresh.minBuyAmount < chosen.minBuyAmount * 98n / 100n) throw new Error('Le devis a changé de plus de 2 % : vérifie à nouveau avant de signer.');
      const s = await evmAdapter.simulate({ to: fresh.tx.to, data: fresh.tx.data, value: fresh.tx.value });
      if (!s.ok) throw new Error(`La simulation échoue : ${s.reason}`);

      setPhase('swapping');
      const unsigned = await evmAdapter.buildCall({ to: fresh.tx.to, data: fresh.tx.data, value: fresh.tx.value, fee, kind: 'swap', asset: sell, amount: sellAmount, ...(fresh.tx.gas ? { gas: (fresh.tx.gas * 12n) / 10n } : {}) });
      const decoded = await evmAdapter.decode(unsigned);
      if (decoded.to.toLowerCase() !== fresh.tx.to.toLowerCase()) throw new Error('Destinataire décodé inattendu : arrêt.');
      const signed = await evmAdapter.signTx(unsigned, password);
      const hash = await evmAdapter.broadcast(signed);
      addLocalTx({
        id: hash,
        network,
        chainKey,
        assetId: sell.id,
        kind: 'swap',
        direction: 'out',
        amount: sellAmount.toString(),
        fee: unsigned.maxFee.toString(),
        counterparty: fresh.tx.to,
        label: `Swap ${fmtCrypto(sellAmount, sell.decimals)} ${sell.symbol} → ${buy.symbol}`,
        time: Date.now(),
        status: 'pending',
      });
      setDoneId(hash);
      setPhase('done');
      setPassword('');
      pf.refresh();
    } catch (e) {
      const err = toIpcError(e);
      setExecError(err.code === 'USER_REJECTED' ? 'Signature annulée dans la fenêtre système.' : err.message);
      setPhase('idle');
      allowance.reload();
    }
  };

  const ctaLabel = needsApproval ? 'Autoriser puis échanger' : 'Échanger';
  const phaseLabel: Record<Phase, string> = { idle: '', approving: 'Signature de l’autorisation…', waiting: 'Attente de la confirmation de l’autorisation…', simulating: 'Nouveau devis et simulation…', swapping: 'Signature du swap…', done: '' };

  if (!sell || !buy || !chain) return <EmptyState title="Aucun actif échangeable sur ce réseau" />;

  const tokenItems = (exclude?: string) =>
    tokens
      .filter((t) => t.id !== exclude)
      .map((t) => ({ value: t.id, label: t.symbol, hint: `${t.name} · ${fmtCrypto(pf.balances.get(t.id) ?? 0n, t.decimals)}`, icon: <CoinIcon glyph={t.glyph} color={t.color} size={24} /> }));

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 px-[26px] py-[22px]">
      <header className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <h1 className="m-0 text-[28px] font-semibold tracking-[-0.03em]">Swap</h1>
          <Menu
            value={chainKey}
            onSelect={(k) => {
              setChainKey(k);
              setSelected(null);
              setAmountStr('');
            }}
            items={chains.map((c) => ({ value: c.key, label: c.label }))}
            trigger={
              <button type="button" className="flex h-9 items-center gap-2 rounded-full border border-line-2 bg-card px-3.5 text-[13px] text-text2 hover:text-text">
                {chain.name} <IconChevronDown size={13} />
              </button>
            }
          />
        </div>
        <div className="flex items-center gap-2.5">
          <span className="text-[13px] text-mute">Slippage max.</span>
          <Segmented<Slip>
            label="Slippage"
            value={slip}
            onChange={setSlip}
            options={[
              { value: 10, label: `0,1 %` },
              { value: 50, label: `0,5 %` },
              { value: 100, label: `1 %` },
              { value: 'custom', label: 'Perso' },
            ]}
          />
          {slip === 'custom' && (
            <label className="flex h-9 items-center gap-1 rounded-[10px] border border-line-2 bg-bg px-2.5">
              <span className="sr-only">Slippage personnalisé</span>
              <input value={slipCustom} inputMode="decimal" onChange={(e) => setSlipCustom(sanitizeDecimalInput(e.target.value, 2))} className="w-10 bg-transparent text-right text-[13px]" />
              <span className="text-[12px] text-mute">%</span>
            </label>
          )}
        </div>
      </header>
      {slip === 'custom' && !slipValid && <span className="-mt-2 text-right text-[12px] text-down">Slippage entre 0,01 % et 50 %.</span>}
      {slip === 'custom' && slipValid && slippageBps > 300 && <span className="-mt-2 text-right text-[12px] text-warn">Slippage élevé : tu peux recevoir nettement moins que prévu.</span>}

      <div className="flex min-h-0 flex-1 gap-4">
        <section className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto rounded-[22px] border border-line bg-card p-[22px] scroll-thin">
          <div className="relative flex flex-col gap-2">
            <TokenPanel
              label="Tu donnes"
              right={
                <>
                  Solde {fmtCrypto(balance, sell.decimals)} ·{' '}
                  <button type="button" className="font-semibold text-ice" onClick={() => setAmountStr(toInputDecimal(sell.kind === 'native' ? (balance * 97n) / 100n : balance, sell.decimals))}>
                    MAX
                  </button>
                </>
              }
              amount={
                <input
                  aria-label="Montant donné"
                  value={amountStr}
                  inputMode="decimal"
                  placeholder="0"
                  onChange={(e) => setAmountStr(sanitizeDecimalInput(e.target.value, sell.decimals))}
                  className={cn('w-full min-w-0 bg-transparent text-[40px] font-semibold tracking-[-0.03em]', over && 'text-down')}
                />
              }
              sub={sellAmount && sellPrice !== undefined ? `≈ ${fmtFiat(unitsToNumber(sellAmount, sell.decimals) * sellPrice, cur)}` : over ? 'Solde insuffisant' : ' '}
              token={<TokenButton asset={sell} items={tokenItems()} onSelect={(id) => { if (id === buy.id) setBuyId(sell.id); setSellId(id); }} />}
            />
            <button
              type="button"
              aria-label="Inverser"
              onClick={() => {
                setSellId(buy.id);
                setBuyId(sell.id);
                setAmountStr('');
              }}
              className="absolute top-1/2 left-1/2 z-10 flex size-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-[10px] border-4 border-card bg-control-2 text-text hover:bg-control"
            >
              <IconDown size={15} />
            </button>
            <TokenPanel
              label="Tu reçois (estimé)"
              right={<>Solde {fmtCrypto(pf.balances.get(buy.id) ?? 0n, buy.decimals)}</>}
              amount={<span className={cn('block truncate text-[40px] font-semibold tracking-[-0.03em]', !buyAmount && 'text-faint')}>{buyAmount ? fmtCrypto(buyAmount, buy.decimals, undefined, 6) : quotes.loading ? '…' : '0'}</span>}
              sub={buyAmount && buyPrice !== undefined ? `≈ ${fmtFiat(unitsToNumber(buyAmount, buy.decimals) * buyPrice, cur)}${chosen?.priceImpact !== null && chosen?.priceImpact !== undefined ? ` · impact ${fmtPct(chosen.priceImpact * 100, { sign: false })}` : ''}` : ' '}
              token={<TokenButton asset={buy} items={tokenItems(sell.id)} onSelect={setBuyId} />}
            />
          </div>

          {chosen && (
            <div className="flex items-center gap-3 px-1">
              <CoinIcon glyph={sell.glyph} color={sell.color} size={22} />
              <span className="h-0 flex-1 border-t border-dashed border-line-3" />
              <span className="rounded-full bg-ice-deep px-3 py-1 text-[12px] font-semibold text-ice-text">
                via {chosen.providerName}
                {chosen.route ? ` · ${chosen.route}` : ''}
              </span>
              <span className="h-0 flex-1 border-t border-dashed border-line-3" />
              <CoinIcon glyph={buy.glyph} color={buy.color} size={22} />
            </div>
          )}

          {chosen && needsAllowanceCheck && (
            <div className="flex flex-col gap-2.5 rounded-[14px] border border-line bg-raised px-4 py-3.5">
              <div className="flex items-center justify-between">
                <span className="text-[14px] font-semibold">Autorisation {sell.symbol}</span>
                <span className="text-[12px] text-mute">{needsApproval ? 'Étape 1 sur 2' : allowance.loading ? 'Vérification…' : 'Déjà autorisée'}</span>
              </div>
              <div className="flex items-center justify-between text-[13px]">
                <span className="text-mute">Montant autorisé</span>
                <span className="font-semibold">{needsApproval ? (unlimited ? <span className="text-down">Illimité</span> : `${fmtCrypto(sellAmount ?? 0n, sell.decimals, sell.symbol)} · exact`) : existingUnlimited ? <span className="text-down">Illimité (déjà en place)</span> : `${fmtCrypto(allowance.data ?? 0n, sell.decimals, sell.symbol)} en place`}</span>
              </div>
              {needsApproval && (
                <div className="flex items-center justify-between text-[13px]">
                  <span className="text-text2">Autoriser un montant illimité</span>
                  <Switch label="Autoriser un montant illimité" checked={unlimited} onCheckedChange={(v) => (v ? setConfirmUnlimited(true) : setUnlimited(false))} />
                </div>
              )}
            </div>
          )}

          <div className="grid grid-cols-3 gap-2.5">
            <Stat label="Frais totaux" value={totalFees !== null ? `≈ ${fmtFiat(totalFees, cur)}` : '—'} />
            <Stat label="Durée estimée" value={chosen?.etaSecs !== undefined ? (chosen.etaSecs < 60 ? `≈ ${chosen.etaSecs} s` : fmtEta(chosen.etaSecs)) : '—'} />
            <Stat label="Impact sur le prix" value={chosen?.priceImpact !== null && chosen?.priceImpact !== undefined ? fmtPct(chosen.priceImpact * 100, { sign: false }) : '—'} tone={chosen?.priceImpact && chosen.priceImpact > 0.01 ? 'text-down' : chosen?.priceImpact !== null && chosen?.priceImpact !== undefined ? 'text-up' : ''} />
          </div>

          <div className="flex-1" />
          {chosen && chosen.tx.kind === 'evm' && (
            <div className="flex items-center gap-2 text-[13px]">
              {needsApproval ? (
                <span className="text-mute">La simulation sera faite après l’autorisation, juste avant de signer le swap.</span>
              ) : sim.loading ? (
                <span className="flex items-center gap-2 text-mute"><Spinner /> Simulation…</span>
              ) : sim.data?.ok ? (
                <span className="flex items-center gap-2 text-up"><IconCheck size={15} /> Simulation réussie : la transaction passe sur l’état actuel du réseau.</span>
              ) : sim.data && !sim.data.ok ? (
                <span className="flex items-center gap-2 text-down"><IconWarn size={15} /> La simulation échoue : {sim.data.reason}</span>
              ) : null}
            </div>
          )}
          {chosen?.tx.kind === 'solana' && <span className="text-[13px] text-mute">Transaction construite par Jupiter, signée dans le coffre après la fenêtre système.</span>}
          {phase !== 'idle' && phase !== 'done' && (
            <span className="flex items-center gap-2 text-[13px] text-ice-text2">
              <Spinner /> {phaseLabel[phase]}
            </span>
          )}
          {execError && <Notice tone="error">{execError}</Notice>}
          {phase === 'done' && doneId && (
            <Notice tone="success">
              Swap diffusé : <span className="font-mono">{shortAddress(doneId, 10, 8)}</span>.{' '}
              <button type="button" className="font-semibold underline" onClick={() => navigate({ name: 'history' })}>
                Voir l’historique
              </button>
            </Notice>
          )}
          <div className="flex items-end gap-3">
            <div className="min-w-0 flex-1">
              <PasswordField id="swap-pw" value={password} onChange={setPassword} onEnter={() => canSwap && void execute()} />
            </div>
            <Button variant="primary" size="xl" className="h-[46px] w-[300px] text-[15px]" disabled={!canSwap} onClick={() => void execute()}>
              {busy && <Spinner />} {ctaLabel}
            </Button>
          </div>
        </section>

        <div className="flex w-[400px] shrink-0 flex-col gap-4">
          <section className="flex flex-col gap-2.5 rounded-[22px] border border-line bg-card p-[18px]">
            <div className="flex items-center justify-between px-1">
              <span className="text-[15px] font-semibold">Devis comparés</span>
              <span className="text-[12px] text-mute">{quotes.loading ? 'actualisation…' : quotes.updatedAt ? `actualisé ${fmtAgo(quotes.updatedAt, now)}` : ''}</span>
            </div>
            {!params && <p className="m-0 px-1 py-4 text-[13px] text-mute">Saisis un montant pour comparer les devis.</p>}
            {params && quotes.loading && !quotes.data && [0, 1, 2].map((i) => <div key={i} className="skeleton h-[62px] rounded-[14px]" />)}
            {list.map((q, i) => {
              const net = netValueFiat(q, params?.buy ?? tokenOf(buy));
              const active = chosen?.provider === q.provider;
              return (
                <button
                  key={q.provider}
                  type="button"
                  onClick={() => setSelected(q.provider)}
                  className={cn('flex flex-col gap-1 rounded-[14px] px-4 py-3 text-left', active ? 'border-[1.5px] border-ice bg-ice/8' : 'border border-line bg-raised hover:border-line-3')}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2 text-[14px] font-semibold">
                      {q.providerName} {i === 0 && <Badge tone="up">Meilleur net</Badge>}
                    </span>
                    <span className="text-[15px] font-semibold">{fmtCrypto(q.buyAmount, buy.decimals, buy.symbol, 6)}</span>
                  </span>
                  <span className={cn('text-[12px]', active ? 'text-ice-text2' : 'text-mute')}>
                    Réseau {q.gasFeeFiat !== null ? fmtFiat(q.gasFeeFiat, cur) : '—'} · Provider {q.providerFeeFiat !== null ? fmtFiat(q.providerFeeFiat, cur) : '—'}
                    {net !== null ? ` · Net ${fmtFiat(net, cur)}` : ''}
                  </span>
                </button>
              );
            })}
            {params && quotes.data && list.length === 0 && <p className="m-0 px-1 text-[13px] text-mute">Aucun devis disponible pour cette paire{network === 'testnet' ? ' : les agrégateurs fonctionnent surtout en mainnet' : ''}.</p>}
            {failures.map((f) => (
              <div key={f.provider} className="flex items-center justify-between gap-3 rounded-[12px] border border-dashed border-line px-4 py-2 text-[12px]">
                <span className="font-semibold text-mute">{f.providerName}</span>
                <span className="truncate text-faint" title={f.error}>
                  {f.error}
                </span>
              </div>
            ))}
            {quotes.error && <Notice tone="error">{quotes.error.message}</Notice>}
          </section>

          <section className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto rounded-[22px] border border-line bg-card px-[22px] py-[18px] scroll-thin">
            <div className="flex flex-col text-[13px]">
              <div className="flex h-9 items-center justify-between border-b border-line">
                <span className="text-mute">Taux</span>
                <span className="font-semibold">{execRate ? `1 ${buy.symbol} = ${fmtNumber(execRate, execRate >= 100 ? 2 : 6)} ${sell.symbol}` : '—'}</span>
              </div>
              <div className="flex h-9 items-center justify-between border-b border-line">
                <span className="text-mute">Contrat autorisé</span>
                <span className="font-mono text-[12px] font-semibold">{chosen?.allowanceTarget ? <>{shortAddress(chosen.allowanceTarget)} <span className="text-up">✓</span></> : chosen ? 'aucun (actif natif)' : '—'}</span>
              </div>
              <div className="flex h-9 items-center justify-between">
                <span className="text-mute">Minimum reçu</span>
                <span className="font-semibold">{chosen ? fmtCrypto(chosen.minBuyAmount, buy.decimals, buy.symbol, 6) : '—'}</span>
              </div>
            </div>
            {chosen && sellAmount && (
              <EnClair tone={needsApproval && unlimited ? 'warn' : 'ice'}>
                Tu donnes {fmtCrypto(sellAmount, sell.decimals, sell.symbol)} et reçois au moins {fmtCrypto(chosen.minBuyAmount, buy.decimals, buy.symbol, 6)}.
                {needsApproval
                  ? unlimited
                    ? ` Le contrat ${chosen.providerName} pourra dépenser TOUS tes ${sell.symbol}, sans limite, jusqu’à révocation.`
                    : ` Le contrat ${chosen.providerName} pourra dépenser exactement ${fmtCrypto(sellAmount, sell.decimals, sell.symbol)}, une seule fois.`
                  : ''}
              </EnClair>
            )}
            <div className="flex-1" />
            <div className="flex items-center justify-between text-[12px]">
              <span className="text-mute">
                Taux {buy.symbol} / {sell.symbol} · 24 h
              </span>
              <span className={cn((rateChange ?? 0) >= 0 ? 'text-up' : 'text-down')}>{fmtPct(rateChange, { decimals: 1 })}</span>
            </div>
            {rate.length > 1 ? <SmoothChart values={rate} height={70} defaultPoint="none" padTop={8} padBottom={8} ariaLabel="Taux sur 24 heures" /> : <div className="h-[70px]" />}
          </section>
        </div>
      </div>

      <Dialog open={confirmUnlimited} onOpenChange={setConfirmUnlimited} title="Autoriser un montant illimité ?">
        <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />}>
          Le contrat {chosen ? `${chosen.providerName} (${shortAddress(chosen.allowanceTarget ?? '')})` : ''} pourra dépenser tous tes {sell.symbol}, maintenant et plus tard, sans nouvelle signature. Si ce contrat est piraté, tes {sell.symbol} sont exposés.
        </Notice>
        <p className="m-0 text-[13px] leading-[1.55] text-mute">L’autorisation exacte coûte une signature de plus à chaque swap, mais rien ne reste ouvert. Tu pourras révoquer depuis l’Historique.</p>
        <div className="flex justify-end gap-2">
          <Button onClick={() => setConfirmUnlimited(false)}>Garder l’exact</Button>
          <Button
            variant="danger"
            onClick={() => {
              setUnlimited(true);
              setConfirmUnlimited(false);
            }}
          >
            Oui, illimité
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

function TokenPanel({ label, right, amount, sub, token }: { label: string; right: React.ReactNode; amount: React.ReactNode; sub: string; token: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 rounded-[18px] border border-line bg-raised px-[22px] py-3.5">
      <div className="flex justify-between text-[13px]">
        <span className="text-mute">{label}</span>
        <span className="text-text2">{right}</span>
      </div>
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">{amount}</div>
        {token}
      </div>
      <span className="text-[13px] text-faint">{sub}</span>
    </div>
  );
}

function TokenButton({ asset, items, onSelect }: { asset: AssetDef; items: Array<{ value: string; label: string; hint: string; icon: React.ReactNode }>; onSelect: (id: string) => void }) {
  return (
    <Menu
      align="end"
      value={asset.id}
      onSelect={onSelect}
      items={items}
      trigger={
        <button type="button" className="flex h-11 shrink-0 items-center gap-2 rounded-full border border-line-2 bg-card pr-3 pl-1.5 text-[15px] font-semibold hover:border-line-3">
          <CoinIcon glyph={asset.glyph} color={asset.color} size={30} />
          {asset.symbol}
          <IconChevronDown size={13} className="text-mute" />
        </button>
      }
    />
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-[14px] border border-line bg-raised px-4 py-3">
      <span className="text-[12px] text-mute">{label}</span>
      <span className={cn('text-[17px] font-semibold', tone)}>{value}</span>
    </div>
  );
}
