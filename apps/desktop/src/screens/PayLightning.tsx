// SPDX-License-Identifier: GPL-3.0-or-later
//
// Send › Lightning: paying a BOLT11 invoice from a Bitcoin account through a submarine swap, and
// the refund when a payment fails. The checks are Rust's (`commands_ln.rs`); see docs/LIGHTNING.md.

import { useCallback, useEffect, useState } from 'react';
import { call, netFetch, toIpcError, type LnInvoice, type LnSwapRecord } from '@kyro/shared';
import { signAndBroadcast, type AnyAdapter, type AssetDef } from '@kyro/chains';
import { lnBridgeOf, lnProviderOfBridge, lnSwapStatus, LN_PROVIDERS, type LnProviderId } from '@kyro/swap';
import { useApp, useVault } from '../state/app';
import { usePortfolio } from '../state/portfolio';
import { fmtCrypto, fmtFiat, shortAddress } from '../lib/format';
import { addLocalTx, getLocalTxs, updateLocalTx } from '../lib/storage';
import { buildDepositTx, buildKyroFeeTx } from '../lib/crossSwap';
import { daysUntil, invoiceProblem, lnMessage, prepareLnPayment, type LnPrepared } from '../lib/lightning';
import { PasswordField } from '../components/kit';
import { Button, IconButton, Notice, Spinner } from '../components/ui/primitives';
import { IconBack } from '../components/icons';
import { useT } from '../i18n';

const sat = (n: bigint | number) => `${Number(n).toLocaleString()} sat`;

function Line({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 text-[13.5px]">
      <span className="text-mute">{k}</span>
      <span className={strong ? 'font-medium text-text' : 'text-text2'}>{v}</span>
    </div>
  );
}

export function PayLightning({ asset, adapter, initial, onExit }: { asset: AssetDef; adapter: AnyAdapter; initial: string; onExit: () => void }) {
  const { t } = useT();
  const { settings, navigate, selectedAccounts } = useApp();
  const { adapters, accounts, activeHw } = useVault();
  const pf = usePortfolio();
  const network = accounts.network;
  const cur = settings.currency;
  const price = pf.price(asset.coingeckoId)?.price;
  const account = selectedAccounts.btc ?? 0;

  const [text, setText] = useState(initial);
  const [invoice, setInvoice] = useState<LnInvoice | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<LnPrepared | null>(null);
  const [phase, setPhase] = useState<'idle' | 'checking' | 'sending'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [wrongPw, setWrongPw] = useState(0);
  const [sent, setSent] = useState<{ txid: string; feeError: string | null } | null>(null);

  useEffect(() => {
    setInvoice(null);
    setPrepared(null);
    setError(null);
    const v = text.trim();
    if (!v) {
      setReadError(null);
      return;
    }
    let alive = true;
    call('ln_invoice_decode', { invoice: v })
      .then((i) => {
        if (!alive) return;
        setInvoice(i);
        setReadError(invoiceProblem(i, Math.floor(Date.now() / 1000)));
      })
      .catch((e: unknown) => alive && setReadError(lnMessage(toIpcError(e).message)));
    return () => {
      alive = false;
    };
  }, [text]);

  const fiat = (n: bigint | number) => (price === undefined ? '' : ` · ${fmtFiat((Number(n) / 1e8) * price, cur)}`);

  const review = async () => {
    if (!invoice) return;
    setPhase('checking');
    setError(null);
    try {
      setPrepared(
        await prepareLnPayment({
          invoice,
          asset,
          adapters,
          fetcher: netFetch,
          account,
          balance: pf.balances.get(asset.id) ?? 0n,
          ...(price !== undefined ? { priceFiat: price } : {}),
          usdToFiat: cur === 'USD' ? 1 : (pf.price('usd-coin')?.price ?? pf.price('tether')?.price ?? 0.92),
        }),
      );
    } catch (e) {
      setError(lnMessage(toIpcError(e).message));
    } finally {
      setPhase('idle');
    }
  };

  const pay = async () => {
    if (!prepared) return;
    setError(null);
    setPhase('sending');
    try {
      // The invoice may have aged on this screen: Rust reads it again.
      const again = await call('ln_invoice_decode', { invoice: prepared.invoice.invoice });
      const late = invoiceProblem(again, Math.floor(Date.now() / 1000));
      if (late) throw new Error(late);
      const plan = prepared.deposit.plan;
      const fresh = await buildDepositTx(asset, adapters, plan);
      const txid = await signAndBroadcast(adapter, fresh.unsigned, password);
      await call('ln_swap_deposited', { id: prepared.terms.id, txid });
      addLocalTx({
        id: txid,
        network,
        chainKey: asset.chainKey,
        assetId: asset.id,
        kind: 'swap',
        direction: 'out',
        amount: plan.amountIn.toString(),
        fee: fresh.unsigned.maxFee.toString(),
        counterparty: plan.depositAddress,
        label: t('ln.historyLabel', { amount: sat(prepared.invoice.amountSat), provider: prepared.provider.name }),
        time: Date.now(),
        status: 'pending',
        cross: { fromChain: 'bitcoin', toChain: 'bitcoin', toChainKey: asset.chainKey, bridge: lnBridgeOf(prepared.provider.id as LnProviderId), depositAddress: plan.depositAddress, orderId: prepared.terms.id },
      });
      let feeError: string | null = null;
      try {
        // Kyro's service fee, a second plain transfer, as on Exolix routes.
        const feeTx = await buildKyroFeeTx(asset, adapters, plan);
        if (feeTx) await signAndBroadcast(adapter, feeTx.unsigned, password);
      } catch (e) {
        feeError = toIpcError(e).message;
      }
      setSent({ txid, feeError });
      setPassword('');
      pf.refresh();
    } catch (e) {
      const err = toIpcError(e);
      if (err.code === 'WRONG_PASSWORD') setWrongPw((n) => n + 1);
      setError(err.message);
    } finally {
      setPhase('idle');
    }
  };

  const header = (
    <header className="flex items-center gap-3.5">
      <IconButton label={t('ln.back')} onClick={onExit} className="size-9">
        <IconBack size={16} />
      </IconButton>
      <h1 className="screen-title">{t('ln.title')}</h1>
    </header>
  );

  if (activeHw) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-5 px-8 pt-7 pb-6">
        {header}
        <Notice tone="warn">{t('ln.hwRefused')}</Notice>
      </div>
    );
  }

  if (sent) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-8 pt-7 pb-6">
        {header}
        <Notice tone="success">{t('ln.sent')}</Notice>
        <p className="m-0 text-[13.5px] leading-[1.5] text-mute">{t('ln.sentNext')}</p>
        {sent.feeError && <Notice tone="warn">{t('ln.feeNotSent', { why: sent.feeError })}</Notice>}
        <div className="flex gap-2">
          <Button onClick={() => navigate({ name: 'history' })}>{t('ln.toHistory')}</Button>
          <Button onClick={onExit}>{t('ln.done')}</Button>
        </div>
      </div>
    );
  }

  const busy = phase !== 'idle';
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-8 pt-7 pb-6">
      {header}
      <div className="flex max-w-[620px] flex-col gap-4">
        <div className="flex flex-col gap-2">
          <label htmlFor="ln-invoice" className="eyebrow">
            {t('ln.invoice')}
          </label>
          <textarea
            id="ln-invoice"
            value={text}
            rows={3}
            spellCheck={false}
            autoComplete="off"
            placeholder="lnbc…"
            disabled={busy}
            onChange={(e) => setText(e.target.value)}
            className="w-full resize-none rounded-box border border-line-2 bg-bg px-4 py-3 font-mono text-[13px] text-text2"
          />
        </div>
        {readError && <Notice tone="error">{readError}</Notice>}

        {invoice && !readError && !prepared && (
          <div className="flex flex-col gap-2 rounded-box border border-line-2 px-4 py-3">
            <Line k={t('ln.amount')} v={sat(invoice.amountSat) + fiat(invoice.amountSat)} strong />
            {invoice.description && <Line k={t('ln.description')} v={invoice.description} />}
            <Line k={t('ln.payee')} v={shortAddress(invoice.payee)} />
            <Line k={t('ln.expires')} v={new Date(invoice.expiresAt * 1000).toLocaleString()} />
            <div className="mt-1 flex justify-end">
              <Button variant="primary" disabled={busy} onClick={() => void review()}>
                {phase === 'checking' ? <Spinner /> : t('ln.review')}
              </Button>
            </div>
          </div>
        )}

        {prepared && (
          <div className="flex flex-col gap-3 rounded-box border border-line-2 px-4 py-3">
            <Line k={t('ln.invoiceAmount')} v={sat(prepared.invoice.amountSat) + fiat(prepared.invoice.amountSat)} strong />
            <Line k={t('ln.providerFee', { provider: prepared.provider.name })} v={sat(prepared.checked.providerFeeSat)} />
            <Line k={t('ln.kyroFee')} v={prepared.kyroFee > 0n ? sat(prepared.kyroFee) : '—'} />
            <Line k={t('ln.networkFee')} v={sat(prepared.networkFee)} />
            <Line k={t('ln.total')} v={`${fmtCrypto(prepared.total, asset.decimals, asset.symbol)}${fiat(prepared.total)}`} strong />
            <Notice tone="info">{t('ln.trust', { provider: prepared.provider.name })}</Notice>
            <Notice tone="warn">{t('ln.failure', { days: prepared.lockDays })}</Notice>
            <Notice tone="warn">{t('ln.slow')}</Notice>
            <p className="m-0 text-[12.5px] leading-[1.5] text-mute">{t('ln.twoWindows')}</p>
            <PasswordField id="ln-pw" value={password} onChange={setPassword} wrong={wrongPw} onEnter={() => password && !busy && void pay()} />
            <div className="flex justify-end gap-2">
              <Button disabled={busy} onClick={() => setPrepared(null)}>
                {t('common.cancel')}
              </Button>
              <Button variant="primary" disabled={busy || !password} onClick={() => void pay()}>
                {phase === 'sending' ? <Spinner /> : t('ln.pay')}
              </Button>
            </div>
          </div>
        )}
        {error && <Notice tone="error">{error}</Notice>}
        <LnPayments />
      </div>
    </div>
  );
}

type Row = LnSwapRecord & { status: string };

/** Payments sent from this wallet, and the refund of a failed one. */
function LnPayments() {
  const { t } = useT();
  const { accounts } = useVault();
  const network = accounts.network;
  const [rows, setRows] = useState<Row[]>([]);
  const [tip, setTip] = useState<number | null>(null);

  const load = useCallback(async () => {
    const swaps = (await call('ln_swaps')).filter((s) => s.depositTxid);
    const height = await call('btc_tip_height').catch(() => null);
    setTip(height);
    setRows(
      await Promise.all(
        swaps.map(async (s) => {
          const p = LN_PROVIDERS.find((x) => x.id === s.provider);
          if (s.refundTxid) return { ...s, status: 'REFUNDED' };
          const local = getLocalTxs(network).find((x) => x.cross?.orderId === s.terms.id)?.cross?.status;
          if (local === 'SUCCESS') return { ...s, status: local };
          const st = p ? await lnSwapStatus(netFetch, p, s.terms.id).catch(() => null) : null;
          return { ...s, status: st?.status ?? local ?? 'PROCESSING' };
        }),
      ),
    );
  }, [network]);

  useEffect(() => {
    void load().catch(() => undefined);
  }, [load]);

  if (rows.length === 0) return null;
  return (
    <section className="flex flex-col gap-2">
      <h2 className="eyebrow m-0">{t('ln.payments')}</h2>
      {[...rows].reverse().map((r) => (
        <PaymentRow key={r.terms.id} row={r} tip={tip} onChanged={() => void load()} />
      ))}
    </section>
  );
}

function PaymentRow({ row, tip, onChanged }: { row: Row; tip: number | null; onChanged: () => void }) {
  const { t } = useT();
  const { accounts } = useVault();
  const network = accounts.network;
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timeout = row.terms.timeoutBlockHeight;
  const label = row.status === 'SUCCESS' ? t('ln.statusPaid') : row.status === 'REFUNDED' ? t('ln.statusRefunded') : row.status === 'FAILED' ? t('ln.statusFailed') : t('ln.statusWaiting');
  const stuck = row.status === 'FAILED' || (row.status === 'PROCESSING' && tip !== null && tip >= timeout);
  const ready = stuck && tip !== null && tip >= timeout;

  const refund = async () => {
    setBusy(true);
    setError(null);
    try {
      const rates = await call('btc_fee_rates');
      const r = await call('ln_refund', { id: row.terms.id, feeRate: Math.max(1, Math.ceil(rates.halfHourFee)), password });
      await call('ln_refund_broadcast', { id: row.terms.id, hex: r.hex });
      const tx = getLocalTxs(network).find((x) => x.cross?.orderId === row.terms.id);
      if (tx?.cross) updateLocalTx(network, tx.id, { cross: { ...tx.cross, status: 'REFUNDED' } });
      setPassword('');
      setOpen(false);
      onChanged();
    } catch (e) {
      setError(toIpcError(e).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-box border border-line-2 px-4 py-3 text-[13.5px]">
      <div className="flex items-center justify-between gap-3">
        <span className="text-text2">
          {sat(row.invoiceSat)} · {lnProviderOfBridge(lnBridgeOf(row.provider as LnProviderId))?.name ?? row.provider}
        </span>
        <span className="text-mute">{label}</span>
      </div>
      {stuck && !ready && <p className="m-0 text-[12.5px] text-mute">{t('ln.refundFrom', { block: timeout.toLocaleString(), days: tip === null ? '?' : daysUntil(timeout, tip) })}</p>}
      {ready && !open && (
        <div className="flex justify-end">
          <Button onClick={() => setOpen(true)}>{t('ln.refund')}</Button>
        </div>
      )}
      {open && (
        <>
          <PasswordField id={`ln-refund-${row.terms.id}`} value={password} onChange={setPassword} onEnter={() => password && !busy && void refund()} />
          <div className="flex justify-end gap-2">
            <Button disabled={busy} onClick={() => setOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" disabled={busy || !password} onClick={() => void refund()}>
              {busy ? <Spinner /> : t('ln.refund')}
            </Button>
          </div>
        </>
      )}
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}
