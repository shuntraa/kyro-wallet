// SPDX-License-Identifier: GPL-3.0-or-later
// Kyro signature components: mark, coin icons, address blocks, "En clair", big amounts, copy
// button, password field, empty / error states.

import { useEffect, useState, type ReactNode } from 'react';
import type { Currency } from '@kyro/shared';
import { cn } from '../lib/cn';
import { addressChunks, splitFiat } from '../lib/format';
import { copyText } from '../lib/copy';
import { IconCheck, IconCopy, IconEye, IconEyeOff, IconWarn } from './icons';
import { Button } from './ui/primitives';
import { useTicker } from './motion';
import { TorWait, useTorBlocked } from './Tor';
import { NetworkDownLine, ServerDownLine, ServerMissingLine, TronNoHistoryLine, cbfPending, networkDown, serverDown, serverMissing, tronNoHistory, useCustomServer } from './ServerDown';
import { useT } from '../i18n';

export function KyroMark({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" className={className}>
      <path d="M47.32 44.86 A20 20 0 1 1 47.32 19.14" fill="none" stroke="#F5F7FA" strokeWidth={size <= 20 ? 11 : 10} />
      <rect x={size <= 20 ? 25 : 26} y={size <= 20 ? 25 : 26} width={size <= 20 ? 14 : 12} height={size <= 20 ? 14 : 12} fill="#7CC4FF" />
    </svg>
  );
}

/** Coin disc: Kyro's own drawn mark (components/coins), monogram fallback; inline SVG, no remote images. */
export { CoinIcon, type CoinIconProps } from './coins/CoinIcon';

/** Address in 4-char blocks, first/last two highlighted in ice blue. */
export function AddressBlocks({ address, size = 'lg', className, wrap = true }: { address: string; size?: 'sm' | 'md' | 'lg' | 'xl'; className?: string; wrap?: boolean }) {
  const fs = { sm: 'text-[13px]', md: 'text-[15px]', lg: 'text-[19px]', xl: 'text-[23px]' }[size];
  const { t } = useT();
  return (
    <div className={cn('flex gap-1.5 font-mono', wrap ? 'flex-wrap' : 'flex-nowrap', fs, className)} aria-label={t('shell.addressAria', { address })}>
      {addressChunks(address).map((c, i) => (
        <span key={i} className={cn('rounded-[4px] px-1.5 py-[3px]', c.highlight ? 'bg-ice/[.12] text-ice-text shadow-[inset_0_-1px_0_rgba(124,196,255,.35)]' : 'text-mute')}>
          {c.text}
        </span>
      ))}
    </div>
  );
}

/** Compact address: first two and last two blocks only. */
export function AddressShort({ address, className }: { address: string; className?: string }) {
  const c = addressChunks(address);
  const head = c.slice(0, 2);
  const tail = c.slice(-2);
  return (
    <span className={cn('font-mono text-[13px]', className)}>
      <span className="text-text">{head[0]?.text}</span> <span className="text-mute">{head[1]?.text}</span> <span className="text-faint">…</span> <span className="text-mute">{tail[0]?.text}</span>{' '}
      <span className="text-text">{tail[1]?.text}</span>
    </span>
  );
}

/** "En clair" box: one plain-language sentence before any signature. */
export function EnClair({ children, className, tone = 'ice' }: { children: ReactNode; className?: string; tone?: 'ice' | 'warn' }) {
  const { t } = useT();
  return (
    <div className={cn('fade-in flex flex-col gap-1.5 rounded-box border border-l-2 px-4 py-3.5', tone === 'ice' ? 'border-ice/20 border-l-ice bg-ice/[.05]' : 'border-warn/30 border-l-warn bg-warn/[.06]', className)}>
      <span className={cn('text-[12px] font-medium', tone === 'ice' ? 'text-ice-text2' : 'text-warn')}>{t('shell.inPlainWords')}</span>
      <p className="m-0 text-[14px] leading-[1.5]">{children}</p>
    </div>
  );
}

export const HIDDEN = '•••••';

/** Big fiat amount: integer bright, decimals + symbol faint. */
export function BigFiat({ value, currency, hidden, className, tick }: { value: number; currency: Currency; hidden?: boolean; className?: string; /** Count to the value (number ticker). */ tick?: boolean }) {
  if (hidden) return <span className={className}>{HIDDEN}</span>;
  if (tick) return <TickingFiat value={value} currency={currency} {...(className ? { className } : {})} />;
  const { int, rest } = splitFiat(value, currency);
  return (
    <span className={className}>
      {int}
      <span className="text-faint">{rest}</span>
    </span>
  );
}

function TickingFiat({ value, currency, className }: { value: number; currency: Currency; className?: string }) {
  // No made-up starting value: first paint is the real total, the ticker only runs between real values.
  const shown = useTicker(value, { duration: 0.6 });
  const { int, rest } = splitFiat(shown, currency);
  const real = splitFiat(value, currency);
  return (
    <span className={className} aria-label={`${real.int}${real.rest}`}>
      <span aria-hidden="true">
        {int}
        <span className="text-faint">{rest}</span>
      </span>
    </span>
  );
}

export function CopyButton({ text, label, className, variant = 'secondary', size = 'sm' }: { text: string; label?: string; className?: string; variant?: 'primary' | 'secondary' | 'ghost'; size?: 'sm' | 'md' | 'lg' | 'xl' }) {
  const [done, setDone] = useState<null | boolean>(null);
  const { t } = useT();
  useEffect(() => {
    if (done === null) return;
    const id = window.setTimeout(() => setDone(null), 1800);
    return () => window.clearTimeout(id);
  }, [done]);
  return (
    <Button variant={variant} size={size} className={className} onClick={async () => setDone(await copyText(text))}>
      <span key={String(done)} className="pop-in inline-flex">{done ? <IconCheck size={15} className="text-up" /> : <IconCopy size={15} />}</span>
      {done === null ? (label ?? t('common.copy')) : done ? t('common.copied') : t('shell.copyFailed')}
    </Button>
  );
}

export function PasswordField({
  value,
  onChange,
  id,
  label,
  autoFocus,
  onEnter,
  placeholder,
  autoComplete = 'current-password',
  invalid,
}: {
  value: string;
  onChange: (v: string) => void;
  id: string;
  label?: string;
  autoFocus?: boolean;
  onEnter?: () => void;
  placeholder?: string;
  autoComplete?: string;
  invalid?: boolean;
}) {
  const [show, setShow] = useState(false);
  const { t } = useT();
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="eyebrow">
        {label ?? t('shell.vaultPassword')}
      </label>
      <div className={cn('flex h-11 items-center rounded-ctl border bg-bg pr-1.5 pl-3.5 transition-colors focus-within:border-ice-line', invalid ? 'border-down/60' : 'border-line-2 hover:border-line-3')}>
        <input
          id={id}
          type={show ? 'text' : 'password'}
          value={value}
          autoFocus={autoFocus}
          autoComplete={autoComplete}
          spellCheck={false}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && onEnter) onEnter();
          }}
          className="min-w-0 flex-1 bg-transparent text-[15px]"
        />
        <button type="button" onClick={() => setShow((s) => !s)} aria-label={show ? t('shell.hidePassword') : t('shell.showPassword')} className="press flex size-8 items-center justify-center rounded-[5px] text-mute hover:bg-raised hover:text-text">
          {show ? <IconEyeOff size={16} /> : <IconEye size={16} />}
        </button>
      </div>
    </div>
  );
}

export function EmptyState({ title, children, action, className }: { title: string; children?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('fade-in flex flex-col items-center justify-center gap-2 px-6 py-10 text-center', className)}>
      <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true" className="mb-1 text-line-3">
        <circle cx="14" cy="14" r="12.5" fill="none" stroke="currentColor" strokeDasharray="2 3" />
        <rect x="11" y="11" width="6" height="6" fill="currentColor" />
      </svg>
      <span className="text-[14px] font-medium text-text2">{title}</span>
      {children && <span className="max-w-[360px] text-[13px] leading-[1.5] text-mute">{children}</span>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/**
 * Network data error. While Tor (enabled) is not ready, or when `error` is TOR_UNAVAILABLE, it
 * shows "En attente de Tor…" instead: nothing failed, Kyro is refusing to go out in clear.
 */
export function ErrorLine({ children, onRetry, className, error, chainKey }: { children: ReactNode; onRetry?: () => void; className?: string; error?: unknown; chainKey?: string }) {
  const torBlocked = useTorBlocked(error);
  const custom = useCustomServer()(chainKey);
  const { t } = useT();
  if (torBlocked) return <TorWait {...(className ? { className } : {})} />;
  if (serverMissing(error)) return <ServerMissingLine {...(className ? { className } : {})} />;
  if (tronNoHistory(error)) return <TronNoHistoryLine {...(className ? { className } : {})} />;
  if (serverDown(error, custom)) return <ServerDownLine {...(className ? { className } : {})} />;
  if (networkDown(error, custom)) return <NetworkDownLine {...(className ? { className } : {})} />;
  if (cbfPending(error)) {
    return (
      <div role="status" className={cn('flex items-center gap-2 text-[12px] text-mute', className)}>
        <span aria-hidden="true" className="inline-block size-3 shrink-0 animate-spin rounded-full border-[1.5px] border-current border-t-transparent" />
        {t('shell.cbfSyncingData')}
      </div>
    );
  }
  return (
    <div role="alert" className={cn('flex items-center gap-2 text-[12px] text-down', className)}>
      <IconWarn size={14} />
      <span className="min-w-0 flex-1">{children}</span>
      {onRetry && (
        <button type="button" onClick={onRetry} className="font-semibold text-ice hover:underline">
          {t('common.retry')}
        </button>
      )}
    </div>
  );
}

/** Up/down/flat colour for a % change. */
export function trendColor(change: number | null | undefined): string {
  if (change === null || change === undefined || Math.abs(change) < 0.005) return 'text-mute';
  return change > 0 ? 'text-up' : 'text-down';
}
export function trendHex(change: number | null | undefined): string {
  if (change === null || change === undefined || Math.abs(change) < 0.05) return '#8C929D';
  return change > 0 ? '#3DDC97' : '#FF6B6B';
}

/** Pill with ▲/▼ + text (mockup: "▲ 291,14 € · 2,39 %"). */
export function TrendPill({ change, children }: { change: number | null; children: ReactNode }) {
  const up = (change ?? 0) >= 0;
  const flat = change === null || Math.abs(change) < 0.005;
  return (
    <span className={cn('inline-flex h-6 items-center gap-[6px] text-[13px] font-medium', flat ? 'text-mute' : up ? 'text-up' : 'text-down')}>
      {!flat && (
        <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true">
          <path d={up ? 'M5 1l4 6H1z' : 'M5 9l4-6H1z'} fill="currentColor" />
        </svg>
      )}
      {children}
    </span>
  );
}
