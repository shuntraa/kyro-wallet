// SPDX-License-Identifier: GPL-3.0-or-later
// Kyro signature components: mark, coin icons, address blocks, "En clair",
// big amounts, copy button, password field, empty / error states.

import { useEffect, useState, type ReactNode } from 'react';
import type { Currency } from '@kyro/shared';
import { cn } from '../lib/cn';
import { addressChunks, splitFiat } from '../lib/format';
import { copyText } from '../lib/copy';
import { IconCheck, IconCopy, IconEye, IconEyeOff, IconWarn } from './icons';
import { Button } from './ui/primitives';
import { TorWait, useTorBlocked } from './Tor';
import { ServerDownLine, ServerMissingLine, cbfPending, serverDown, serverMissing } from './ServerDown';

export function KyroMark({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" className={className}>
      <path d="M47.32 44.86 A20 20 0 1 1 47.32 19.14" fill="none" stroke="#F5F7FA" strokeWidth={size <= 20 ? 11 : 10} />
      <rect x={size <= 20 ? 25 : 26} y={size <= 20 ? 25 : 26} width={size <= 20 ? 14 : 12} height={size <= 20 ? 14 : 12} fill="#7CC4FF" />
    </svg>
  );
}

function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return 0;
  const n = parseInt(m[1] ?? '0', 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}

/** Round coin badge (glyph + colour): no remote images (CSP, privacy). */
export function CoinIcon({ glyph, color, size = 34, fg, className, badge }: { glyph: string; color: string; size?: number; fg?: string; className?: string; badge?: { glyph: string; color: string } }) {
  const text = fg ?? (luminance(color) > 0.55 ? '#0A0B0D' : '#FFFFFF');
  return (
    <span className={cn('relative inline-flex shrink-0 items-center justify-center rounded-full font-bold', className)} style={{ width: size, height: size, background: color, color: text, fontSize: Math.round(size * 0.46) }} aria-hidden="true">
      {glyph}
      {badge && (
        <span className="absolute -right-1 -bottom-1 flex items-center justify-center rounded-full border-2 border-card font-bold" style={{ width: 16, height: 16, background: badge.color, color: '#fff', fontSize: 8 }}>
          {badge.glyph}
        </span>
      )}
    </span>
  );
}

/** Address in 4-char blocks, first/last two highlighted in ice blue. */
export function AddressBlocks({ address, size = 'lg', className, wrap = true }: { address: string; size?: 'sm' | 'md' | 'lg' | 'xl'; className?: string; wrap?: boolean }) {
  const fs = { sm: 'text-[13px]', md: 'text-[15px]', lg: 'text-[19px]', xl: 'text-[23px]' }[size];
  return (
    <div className={cn('flex gap-1.5 font-mono', wrap ? 'flex-wrap' : 'flex-nowrap', fs, className)} aria-label={`Adresse ${address}`}>
      {addressChunks(address).map((c, i) => (
        <span key={i} className={cn('rounded-[6px] px-1.5 py-[3px]', c.highlight ? 'bg-ice/14 text-ice-text' : 'text-mute')}>
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
  return (
    <div className={cn('flex flex-col gap-1.5 rounded-[14px] border px-4 py-3.5', tone === 'ice' ? 'border-ice/22 bg-ice/8' : 'border-warn/35 bg-warn/8', className)}>
      <span className={cn('text-[11px] font-semibold tracking-[0.06em]', tone === 'ice' ? 'text-ice-text2' : 'text-warn')}>EN CLAIR</span>
      <p className="m-0 text-[14px] leading-[1.5]">{children}</p>
    </div>
  );
}

export const HIDDEN = '•••••';

/** Big fiat amount: integer bright, decimals + symbol faint. */
export function BigFiat({ value, currency, hidden, className }: { value: number; currency: Currency; hidden?: boolean; className?: string }) {
  if (hidden) return <span className={className}>{HIDDEN}</span>;
  const { int, rest } = splitFiat(value, currency);
  return (
    <span className={className}>
      {int}
      <span className="text-faint">{rest}</span>
    </span>
  );
}

export function CopyButton({ text, label = 'Copier', className, variant = 'secondary', size = 'sm' }: { text: string; label?: string; className?: string; variant?: 'primary' | 'secondary' | 'ghost'; size?: 'sm' | 'md' | 'lg' | 'xl' }) {
  const [done, setDone] = useState<null | boolean>(null);
  useEffect(() => {
    if (done === null) return;
    const id = window.setTimeout(() => setDone(null), 1800);
    return () => window.clearTimeout(id);
  }, [done]);
  return (
    <Button variant={variant} size={size} className={className} onClick={async () => setDone(await copyText(text))}>
      {done ? <IconCheck size={15} /> : <IconCopy size={15} />}
      {done === null ? label : done ? 'Copié' : 'Échec de la copie'}
    </Button>
  );
}

export function PasswordField({
  value,
  onChange,
  id,
  label = 'Mot de passe du coffre',
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
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-[12px] font-medium text-mute">
        {label}
      </label>
      <div className={cn('flex h-[46px] items-center rounded-[12px] border bg-bg pr-1.5 pl-3.5 focus-within:border-ice-line', invalid ? 'border-down/60' : 'border-line-2')}>
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
        <button type="button" onClick={() => setShow((s) => !s)} aria-label={show ? 'Masquer le mot de passe' : 'Afficher le mot de passe'} className="flex size-8 items-center justify-center rounded-[8px] text-mute hover:text-text">
          {show ? <IconEyeOff size={16} /> : <IconEye size={16} />}
        </button>
      </div>
    </div>
  );
}

export function EmptyState({ title, children, action, className }: { title: string; children?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 px-6 py-10 text-center', className)}>
      <span className="text-[14px] font-semibold text-text2">{title}</span>
      {children && <span className="max-w-[360px] text-[13px] leading-[1.5] text-mute">{children}</span>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/**
 * Network data error. While Tor (enabled) is not ready, or when `error` is TOR_UNAVAILABLE,
 * it shows "En attente de Tor…" instead: nothing failed, Kyro is refusing to go out in clear.
 * When `error` says the user's own server is down, it shows « Ton serveur ne répond pas »
 * with a way to the settings (never a fallback to the default).
 */
export function ErrorLine({ children, onRetry, className, error }: { children: ReactNode; onRetry?: () => void; className?: string; error?: unknown }) {
  const torBlocked = useTorBlocked(error);
  if (torBlocked) return <TorWait {...(className ? { className } : {})} />;
  if (serverMissing(error)) return <ServerMissingLine {...(className ? { className } : {})} />;
  if (serverDown(error)) return <ServerDownLine {...(className ? { className } : {})} />;
  if (cbfPending(error)) {
    return (
      <div role="status" className={cn('flex items-center gap-2 text-[12px] text-mute', className)}>
        <span aria-hidden="true" className="inline-block size-3 shrink-0 animate-spin rounded-full border-[1.5px] border-current border-t-transparent" />
        Bitcoin : synchronisation des filtres compacts en cours, les données arrivent ensuite.
      </div>
    );
  }
  return (
    <div role="alert" className={cn('flex items-center gap-2 text-[12px] text-down', className)}>
      <IconWarn size={14} />
      <span className="min-w-0 flex-1">{children}</span>
      {onRetry && (
        <button type="button" onClick={onRetry} className="font-semibold text-ice hover:underline">
          Réessayer
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
    <span className={cn('inline-flex h-6 items-center gap-[5px] rounded-full px-[9px] text-[13px] font-semibold', flat ? 'bg-control-2 text-mute' : up ? 'bg-up/12 text-up' : 'bg-down/12 text-down')}>
      {!flat && (
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d={up ? 'M5 1l4 6H1z' : 'M5 9l4-6H1z'} fill="currentColor" />
        </svg>
      )}
      {children}
    </span>
  );
}
