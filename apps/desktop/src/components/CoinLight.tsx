// SPDX-License-Identifier: GPL-3.0-or-later
// Coin light for Send, Receive and Swap: the coin's colour (lifted when too dark for the UI), an
// address in groups of four with its ends lit, a scannable QR tile, and a glass info line.

import { useEffect, useMemo, useState, type CSSProperties, type InputHTMLAttributes, type ReactNode } from 'react';
import QRCode from 'qrcode';
import { MARKS, luminance, mix, resolveMark, tickerColor } from './coins/marks';
import { GLASS_ROW, GLOW } from './kyro';
import { addressChunks } from '../lib/format';
import { copyText } from '../lib/copy';
import { cn } from '../lib/cn';
import { t } from '../i18n';

/** The colour a coin lights the screen with. Dark marks (XRP, Hedera, Aptos…) are lifted toward ice. */
export function coinColor(q: { id?: string | undefined; symbol?: string | undefined; glyph?: string | undefined; color?: string | undefined }): string {
  const key = resolveMark(q);
  const base = key ? MARKS[key].color : (q.color ?? tickerColor(q.symbol ?? q.glyph ?? '?'));
  if (!/^#[0-9a-f]{6}$/i.test(base)) return '#7cc4ff';
  const l = luminance(base);
  return l < 0.42 ? mix(base, '#cfe7ff', Math.min(0.78, (0.42 - l) * 2.2 + 0.28)) : base;
}

/** Address in groups of four, first and last two groups in the coin's light. */
export function CoinAddress({ address, color, className }: { address: string; color: string; className?: string }) {
  return (
    <span className={cn('font-mono tracking-[0.04em] text-mute', className)} aria-label={t('shell.addressAria', { address })}>
      {addressChunks(address).map((c, i) => (
        <span key={i} className="mx-[5px] inline-block" style={c.highlight ? GLOW(color) : undefined}>
          {c.text}
        </span>
      ))}
    </span>
  );
}

/** QR code on a light tile: dark modules on a light ground with a quiet zone, no logo (scannable). */
export function QrTile({ value, size, color }: { value: string; size: number; color: string }) {
  const q = useMemo(() => {
    try {
      return QRCode.create(value, { errorCorrectionLevel: 'M' });
    } catch {
      return null;
    }
  }, [value]);
  const n = q?.modules.size ?? 0;
  const pad = Math.max(10, Math.round(size * 0.085));
  const cell = n ? (size - pad * 2) / n : 0;
  let d = '';
  if (q) for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.modules.get(r, c)) d += `M${(pad + c * cell).toFixed(2)},${(pad + r * cell).toFixed(2)}h${(cell + 0.2).toFixed(2)}v${(cell + 0.2).toFixed(2)}h-${(cell + 0.2).toFixed(2)}z`;
  return (
    <span className="block rounded-[14px]" style={{ width: size, height: size, background: 'linear-gradient(145deg, #fbfdff, #e6f0f9)', boxShadow: `0 0 44px ${color}66, inset 0 1px 0 #fff` }}>
      {q ? (
        <svg role="img" aria-label={t('shell.qrAria')} width={size} height={size} viewBox={`0 0 ${size} ${size}`} shapeRendering="crispEdges">
          <path d={d} fill="#07111d" />
        </svg>
      ) : (
        <span className="grid h-full place-items-center px-3 text-center text-[12px] text-[#3a4654]">{t('shell.qrUnavailable')}</span>
      )}
    </span>
  );
}

/** Copy with a short "Copied" state, for buttons drawn by the caller. */
export function useCopy(): [null | boolean, (text: string) => void] {
  const [done, setDone] = useState<null | boolean>(null);
  useEffect(() => {
    if (done === null) return;
    const id = window.setTimeout(() => setDone(null), 1800);
    return () => window.clearTimeout(id);
  }, [done]);
  return [done, (text) => void copyText(text).then(setDone)];
}

/** A real piece of information, warning or error, on glass, marked by a small square. */
export function InfoLine({ tone = 'info', children, className }: { tone?: 'info' | 'warn' | 'error' | 'success'; children: ReactNode; className?: string }) {
  const c = { info: '#7cc4ff', warn: 'var(--color-warn)', error: 'var(--color-down)', success: 'var(--color-up)' }[tone];
  return (
    <div role={tone === 'error' || tone === 'warn' ? 'alert' : undefined} className={cn('flex gap-3 rounded-[14px] px-4 py-3 text-[12.5px] leading-[1.55] text-text2', GLASS_ROW, className)}>
      <span aria-hidden="true" className="mt-[6px] size-[6px] shrink-0" style={{ background: c, boxShadow: `0 0 8px ${c}` }} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** A text input as wide as what it holds (big centred amounts). Font and light come from `style`. */
export function FitInput({ value, className, style, placeholder = '0', ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'style'> & { value: string; style?: CSSProperties }) {
  return (
    <span className="relative inline-block max-w-full min-w-[0.6em]" style={style}>
      <span aria-hidden="true" className={cn('invisible block overflow-hidden whitespace-pre', className)}>
        {value || placeholder}
      </span>
      <input {...rest} value={value} placeholder={placeholder} className={cn('absolute inset-0 w-full min-w-0 bg-transparent p-0 placeholder:text-current placeholder:opacity-40', className)} />
    </span>
  );
}
