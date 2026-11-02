// SPDX-License-Identifier: GPL-3.0-or-later
// Cardano pieces (docs/IPC.md §2.7): the ADA asset's native tokens, the Send fields (token from the
// balance, raw quantity, CIP-20 memo, refused address types), the Rust-decoded transaction (every
// output, min-ADA riding with tokens, fee, total leaving, validity) and the confirmation follow-up
// after broadcast.

import { useEffect, useState } from 'react';
import type { CardanoAccount, CardanoTokenBalance, Currency } from '@kyro/shared';
import { cardanoTokenLabel, type CardanoAdapter, type CardanoUnsigned } from '@kyro/chains';
import { fmtCrypto, fmtFiat, shortAddress } from '../lib/format';
import { cn } from '../lib/cn';
import { Badge, Notice, Spinner } from './ui/primitives';
import { IconCheck, IconInfo, IconWarn } from './icons';
import { t, tp, useT } from '../i18n';
import { rt } from '../i18n/rich';

const ADA = (lovelace: bigint | string) => fmtCrypto(BigInt(lovelace), 6, 'ADA', 6);
export const tokenKey = (k: { policy: string; name: string }) => `${k.policy}.${k.name}`;
export const shortenHex = (h: string) => (h.length > 16 ? `${h.slice(0, 8)}…${h.slice(-6)}` : h);

/** « non vérifié » unless the token is in Rust's verified table (mainnet: DJED, USDM, iUSD). */
export function TokenBadge({ verified }: { verified: boolean }) {
  const { t } = useT();
  return verified ? <Badge tone="up">{t('send.adaVerified')}</Badge> : <Badge tone="warn">{t('send.adaUnverified')}</Badge>;
}

/** ADA asset page: spendable vs tied to tokens, and every native token with its policy id. */
export function CardanoTokensPanel({ account, hidden }: { account: CardanoAccount | undefined; hidden: boolean }) {
  const { t } = useT();
  if (!account) return null;
  const locked = BigInt(account.lockedWithTokens);
  const spendable = BigInt(account.balance) - locked;
  return (
    <div className="flex shrink-0 flex-col gap-1 pt-2">
      <span className="flex justify-between gap-2 text-[12px]" title={locked > 0n ? t('send.adaLockedTitle', { amount: ADA(locked) }) : undefined}>
        <span className="truncate text-mute">{t('send.adaSpendableExTokens')}</span>
        <span className="font-semibold">{hidden ? '•••••' : ADA(spendable)}</span>
      </span>
      <span className="border-t border-line pt-1.5 text-[12px] text-faint" title={t('send.adaTokensTitle')}>
        {t('send.adaNativeTokens', { n: account.tokens.length })}
        {account.tokens.some((x) => !x.verified) ? ` · ${t('send.adaOnlyPolicy')}` : ''}
      </span>
      {account.tokens.length === 0 && <span className="text-[12px] text-mute">{t('send.adaNoTokens')}</span>}
      <div className="flex max-h-[46px] shrink-0 flex-col gap-1 overflow-y-auto pr-1 scroll-thin">
      {account.tokens.map((tk) => (
        <div key={tokenKey(tk)} className="flex h-[20px] shrink-0 items-center justify-between gap-2 text-[12px]" title={t('send.adaTokenTitle', { policy: tk.policy, name: tk.name || t('send.adaEmpty') })}>
          <span className="min-w-0 truncate">
            <span className="font-semibold text-text2">{cardanoTokenLabel(tk)}</span> <span className="font-mono text-[12px] text-faint">{shortenHex(tk.policy)}</span>
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            <span className="font-mono">{hidden ? '•••••' : tokenAmount(tk)}</span>
            <TokenBadge verified={tk.verified} />
          </span>
        </div>
      ))}
      </div>
    </div>
  );
}

/** Verified tokens with known decimals: decimal amount; others: raw units. */
export function tokenAmount(tk: Pick<CardanoTokenBalance, 'quantity' | 'decimals' | 'verified'>): string {
  return tk.verified && tk.decimals !== undefined ? fmtCrypto(BigInt(tk.quantity), tk.decimals, undefined, tk.decimals) : t('send.adaUnits', { n: tk.quantity });
}

/** Send: what to send (ADA or a token from the balance), raw quantity, optional CIP-20 memo. */
export function CardanoSendFields({
  account,
  tokenSel,
  onTokenSel,
  quantity,
  onQuantity,
  memo,
  onMemo,
}: {
  account: CardanoAccount | undefined;
  tokenSel: string;
  onTokenSel: (key: string) => void;
  quantity: string;
  onQuantity: (v: string) => void;
  memo: string;
  onMemo: (v: string) => void;
}) {
  const { t } = useT();
  const tokens = account?.tokens ?? [];
  const selected = tokens.find((x) => tokenKey(x) === tokenSel);
  const memoBytes = new TextEncoder().encode(memo).length;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="ada-what" className="eyebrow">
          {t('send.adaWhat')}
        </label>
        <select id="ada-what" value={tokenSel} onChange={(e) => onTokenSel(e.target.value)} className="h-11 rounded-ctl border border-line-2 bg-raised px-3 text-[14px] text-text">
          <option value="">ADA</option>
          {tokens.map((tk) => (
            <option key={tokenKey(tk)} value={tokenKey(tk)}>
              {cardanoTokenLabel(tk)} · {tokenAmount(tk)}
              {tk.verified ? '' : ` · ${t('send.adaUnverified')}`}
            </option>
          ))}
        </select>
      </div>
      {selected && (
        <div className="flex flex-col gap-1.5 rounded-box border border-line-2 bg-bg px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            <label htmlFor="ada-qty" className="text-[13px] font-semibold text-text">
              {t('send.adaQuantityOf', { token: cardanoTokenLabel(selected) })} <TokenBadge verified={selected.verified} />
            </label>
            <button type="button" onClick={() => onQuantity(selected.quantity)} className="text-[12px] font-semibold text-ice hover:underline">
              {t('send.adaAll', { n: selected.quantity })}
            </button>
          </div>
          <input id="ada-qty" inputMode="numeric" value={quantity} onChange={(e) => onQuantity(e.target.value.replace(/\D/g, ''))} placeholder="0" className="h-11 rounded-ctl border border-line-3 bg-bg px-3 font-mono text-[16px] font-semibold text-text focus:border-ice-line" />
          <span className="text-[12px] leading-[1.45] text-mute">
            {selected.verified ? '' : `${t('send.adaRawUnits')} `}
            {rt('send.adaPolicyNote', {}, { policy: <span className="font-mono">{selected.policy}</span> })}
          </span>
          {!selected.verified && (
            <span className="flex items-start gap-1.5 text-[12px] text-warn">
              <IconWarn size={13} className="mt-0.5 shrink-0" />
              {t('send.adaUnverifiedWarn')}
            </span>
          )}
        </div>
      )}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="ada-memo" className="flex justify-between text-[12px] font-medium text-mute">
          <span>{t('send.adaMemoLabel')}</span>
          <span className={memoBytes > 1024 ? 'text-down' : 'text-faint'}>{t('send.adaMemoBytes', { n: memoBytes })}</span>
        </label>
        <input id="ada-memo" value={memo} onChange={(e) => onMemo(e.target.value)} placeholder={t('send.adaMemoPlaceholder')} className="h-11 rounded-ctl border border-line-2 bg-bg px-3 text-[14px] text-text focus:border-ice-line" />
        {memo.trim() && <span className="text-[12px] leading-[1.45] text-warn">{t('send.adaMemoPublic')}</span>}
      </div>
    </div>
  );
}

/** Rust's decoding before the password: each output with its ADA, min-ADA and tokens; fee; total. */
export function CardanoSummaryView({ u, adaPrice, currency }: { u: CardanoUnsigned; adaPrice: number | null; currency: Currency }) {
  const { t } = useT();
  const s = u.summary;
  const fiat = (l: string) => {
    const v = adaPrice !== null ? (Number(BigInt(l)) / 1e6) * adaPrice : 0;
    return v >= 0.01 ? ` · ${fmtFiat(v, currency)}` : '';
  };
  const minutes = s.ttl !== null ? Math.max(0, Math.floor((s.ttl - u.context.tip.slot) / 60)) : null;
  return (
    <div className="flex flex-col rounded-box border border-line text-[12px]" aria-label={t('send.adaDecodedAria')}>
      <div className="flex items-center justify-between border-b border-line px-3.5 py-2">
        <span className="font-semibold text-text">{t('send.adaTxTitle')}</span>
        <span className="text-[12px] text-mute">{t('send.adaDecodedByVault')}</span>
      </div>
      {s.outputs.map((o, i) => (
        <div key={i} className="flex flex-col gap-1 border-b border-line px-3.5 py-2">
          <span className="flex justify-between gap-2">
            <span className={o.isChange ? 'text-mute' : 'font-semibold text-text'}>{o.isChange ? t('send.adaChange') : t('send.recipient')}</span>
            <span className={o.isChange ? 'text-text2' : 'font-semibold text-text'}>{ADA(o.lovelace)}</span>
          </span>
          <span className="truncate font-mono text-[12px] text-faint">{shortAddress(o.address)}{o.kind === 'enterprise' ? ` · ${t('send.adaEnterprise')}` : ''}</span>
          {o.tokens.length > 0 && <span className="text-[12px] text-mute">{t('send.adaMinAda', { amount: ADA(o.minLovelace) })}</span>}
          {o.tokens.map((tk) => (
            <span key={tokenKey(tk)} className="flex items-center justify-between gap-2 text-[12px]">
              <span className="truncate">
                + {tk.quantity} × {tk.nameText ?? (tk.name ? `hex ${shortenHex(tk.name)}` : t('send.adaEmptyName'))} <span className="font-mono text-faint">· {shortenHex(tk.policy)}</span>
              </span>
              <TokenBadge verified={tk.verified} />
            </span>
          ))}
        </div>
      ))}
      <Line k={t('common.fees')} v={`${ADA(s.fee)}${fiat(s.fee)}`} />
      <Line k={t('send.adaTotalLeaving')} v={`${ADA(u.context.leaving)}${fiat(u.context.leaving)}`} strong />
      {s.memo && <Line k={t('send.adaMemoLine')} v={t('common.quoted', { text: s.memo.join('') })} warn />}
      <Line k={t('send.adaValid')} v={minutes !== null ? `≈ ${minutes} min (slot ${s.ttl})` : t('send.adaNoLimit')} last />
    </div>
  );
}

function Line({ k, v, strong, warn, last }: { k: string; v: string; strong?: boolean; warn?: boolean; last?: boolean }) {
  return (
    <div className={cn('flex items-start justify-between gap-3 px-3.5 py-1.5', !last && 'border-b border-line')}>
      <span className={strong ? 'font-semibold text-text' : 'text-text2'}>{k}</span>
      <span className={cn('text-right', strong ? 'font-semibold text-text' : warn ? 'text-warn' : 'text-text2')}>{v}</span>
    </div>
  );
}

/** After broadcast: confirmations from Koios (`ada_tx_status`). */
export function CardanoTxStatusLine({ adapter, hash, onConfirmed }: { adapter: CardanoAdapter; hash: string; onConfirmed?: () => void }) {
  const { t } = useT();
  const [confirmations, setConfirmations] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let timer = 0;
    let notified = false;
    const tick = async () => {
      try {
        const s = await adapter.txStatus(hash);
        if (!alive) return;
        setConfirmations(s.confirmations);
        setError(null);
        if (s.confirmations !== null && s.confirmations > 0 && !notified) {
          notified = true;
          onConfirmed?.();
        }
        if (s.confirmations !== null && s.confirmations >= 3) return;
      } catch (e) {
        if (!alive) return;
        setError(e instanceof Error ? e.message : String(e));
      }
      timer = window.setTimeout(() => void tick(), 3_000);
    };
    void tick();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [adapter, hash]);
  if (error) {
    return (
      <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />} className="w-full text-left">
        {t('send.adaStatusError', { error })}
      </Notice>
    );
  }
  if (confirmations === null) {
    return (
      <div role="status" className="flex w-full items-center gap-2 rounded-ctl border border-line bg-raised px-3.5 py-2.5 text-[13px] text-text2">
        <Spinner /> {t('send.adaNotSeen')}
      </div>
    );
  }
  return (
    <Notice tone="success" icon={confirmations >= 3 ? <IconCheck size={16} className="mt-0.5 shrink-0 text-up" /> : <IconInfo size={16} className="mt-0.5 shrink-0 text-ice" />} className="w-full text-left">
      <strong className="font-semibold">{t('send.adaIncluded')}</strong> {tp('send.adaConfirmations', confirmations)}
      {confirmations >= 3 ? '.' : `, ${t('send.adaFollowing')}`}
    </Notice>
  );
}
