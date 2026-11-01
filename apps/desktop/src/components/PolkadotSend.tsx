// SPDX-License-Identifier: GPL-3.0-or-later
// Polkadot pieces of the Send screen (docs/IPC.md §2.11):
// - what Rust will check: a new account needs at least the existential deposit, spendable =
//   free − max(frozen − reserved, existential deposit) (transfer_keep_alive keeps ours alive);
// - the Rust-decoded transfer before the password, and the follow-up by nonce (dot_tx_status).

import { useEffect, useState } from 'react';
import type { Currency, DotAccountInfo } from '@kyro/shared';
import type { DotUnsigned, PolkadotAdapter } from '@kyro/chains';
import { fmtCrypto, fmtFiat, shortAddress } from '../lib/format';
import { Notice, Spinner } from './ui/primitives';
import { IconCheck, IconInfo, IconWarn } from './icons';
import { t, useT } from '../i18n';
import { rt } from '../i18n/rich';

/** What can be sent (fee included), and why it is less than the balance. */
export function DotSpendable({ account, decimals, symbol, hidden }: { account: DotAccountInfo | undefined; decimals: number; symbol: string; hidden: boolean }) {
  useT();
  if (!account) return null;
  const f = (v: string) => (hidden ? '•••••' : fmtCrypto(BigInt(v), decimals, symbol));
  return (
    <span className="text-[12px] leading-[1.45] text-mute">
      {t('dot.spendable', {
        spendable: f(account.spendable),
        free: f(account.free),
        frozen: BigInt(account.frozen) > 0n ? t('dot.frozen', { frozen: f(account.frozen) }) : '',
        ed: fmtCrypto(BigInt(account.existentialDeposit), decimals, symbol),
      })}
    </span>
  );
}

/** Recipient facts, under the address field. */
export function DotDestinationNote({ dest, decimals, symbol }: { dest: DotAccountInfo | undefined; decimals: number; symbol: string }) {
  useT();
  if (!dest || dest.exists) return null;
  return (
    <span className="flex items-start gap-1.5 text-[12px] leading-[1.45] text-warn">
      <IconInfo size={13} className="mt-0.5 shrink-0" />
      <span>{t('dot.destMissing', { ed: fmtCrypto(BigInt(dest.existentialDeposit), decimals, symbol) })}</span>
    </span>
  );
}

/** Rust's decoding of the transfer, before the password. */
export function DotSummaryView({ u, price, currency }: { u: DotUnsigned; price: number | null; currency: Currency }) {
  useT();
  const s = u.summary;
  const c = u.context;
  const f = (v: string) => fmtCrypto(BigInt(v), s.decimals, s.symbol);
  const fee = BigInt(c.fee);
  const feeFiat = price !== null ? (Number(fee) / 10 ** s.decimals) * price : null;
  return (
    <div className="flex flex-col gap-1.5 rounded-box border border-line bg-bg px-3.5 py-3 text-[12px] leading-[1.45] text-text2">
      <span className="font-semibold text-text">{s.call}</span>
      <span>{rt('dot.to', {}, { to: <span className="font-mono">{shortAddress(s.to)}</span>, chain: s.chain })}</span>
      <span>{t('dot.fee', { fee: f(c.fee), fiat: feeFiat !== null ? ` · ${fmtFiat(feeFiat, currency)}` : '', tip: f(s.tip) })}</span>
      <span>{t('dot.validity', { until: c.validUntil, era: s.eraPeriod, nonce: s.nonce, spec: s.specVersion, tx: s.txVersion })}</span>
      {!c.destination.exists && <span className="text-warn">{t('dot.createsAccount', { ed: f(c.existentialDeposit) })}</span>}
    </div>
  );
}

type Status = { state: 'pending' } | { state: 'finalized' } | { state: 'expired' } | { state: 'error'; message: string };

/** Follow-up of a broadcast transfer by its nonce (finalized state of the node). */
export function DotTxStatusLine({ adapter, nonce, validUntil, onFinalized }: { adapter: PolkadotAdapter; nonce: number; validUntil: number; onFinalized?: () => void }) {
  useT();
  const [status, setStatus] = useState<Status>({ state: 'pending' });
  useEffect(() => {
    let alive = true;
    let timer = 0;
    const tick = async () => {
      try {
        const s = await adapter.txStatus(nonce, validUntil);
        if (!alive) return;
        if (s.state === 'finalized') {
          setStatus({ state: 'finalized' });
          onFinalized?.();
          return;
        }
        if (s.state === 'expired') {
          setStatus({ state: 'expired' });
          return;
        }
      } catch (e) {
        if (!alive) return;
        setStatus({ state: 'error', message: e instanceof Error ? e.message : String(e) });
      }
      timer = window.setTimeout(() => void tick(), 4_000);
    };
    void tick();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [adapter, nonce, validUntil]);

  if (status.state === 'pending') {
    return (
      <div role="status" className="flex w-full items-center gap-2 rounded-ctl border border-line bg-raised px-3.5 py-2.5 text-[13px] text-text2">
        <Spinner /> {t('dot.pending')}
      </div>
    );
  }
  if (status.state === 'finalized') {
    return (
      <Notice tone="success" icon={<IconCheck size={16} className="mt-0.5 shrink-0 text-up" />} className="w-full text-left">
        {rt('dot.finalized', { b: (c) => <strong className="font-semibold">{c}</strong> }, { nonce })}
      </Notice>
    );
  }
  if (status.state === 'expired') {
    return (
      <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />} className="w-full text-left">
        {rt('dot.expired', { b: (c) => <strong className="font-semibold">{c}</strong> }, { until: validUntil })}
      </Notice>
    );
  }
  return (
    <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />} className="w-full text-left">
      {t('dot.trackError', { message: status.message })}
    </Notice>
  );
}
