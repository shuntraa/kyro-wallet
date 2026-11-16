// SPDX-License-Identifier: GPL-3.0-or-later
// Small pieces shared by the Portfolio, Assets, asset page and History in the Kyro look.

import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { Currency } from '@kyro/shared';
import { cn } from '../lib/cn';
import { splitFiat } from '../lib/format';
import { GLASS_ROW, soft } from './kyro';
import { HIDDEN } from './kit';
import { IconSearch } from './icons';
import { useTicker } from './motion';

/** Width of an element, followed on resize (0 until measured). */
export function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setW(Math.round(el.getBoundingClientRect().width));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/** A coin colour for lines and light, a cool ice when the coin has none. */
export function coinTint(color: string | undefined, a = 0.95): string {
  if (!color) return '#8fcaff';
  // Near-black coins (Aptos, Cosmos…) would vanish on the dark glass: pull them further to grey.
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (m) {
    const n = parseInt(m[1]!, 16);
    const lum = (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
    if (lum < 0.3) return soft(color, 0.35);
  }
  return soft(color, a);
}

/** Fiat figure with the decimals smaller and faint (the total, the price). */
export function SplitFiat({ value, currency, hidden, tick, className, style, restClass = 'text-[0.5em] text-mute' }: { value: number; currency: Currency; hidden?: boolean; tick?: boolean; className?: string; style?: CSSProperties; restClass?: string }) {
  const shown = useTicker(value, { duration: 0.6 });
  if (hidden) return <span className={className} style={style}>{HIDDEN}</span>;
  const { int, rest } = splitFiat(tick ? shown : value, currency);
  const real = splitFiat(value, currency);
  return (
    <span className={className} style={style} aria-label={`${real.int}${real.rest}`}>
      <span aria-hidden="true">
        {int}
        <span className={restClass}>{rest}</span>
      </span>
    </span>
  );
}

/** Search field on glass. */
export function GlassSearch({ value, onChange, placeholder, label, className }: { value: string; onChange: (v: string) => void; placeholder: string; label: string; className?: string }) {
  return (
    <label className={cn('flex h-9 items-center gap-2 rounded-[12px] px-3 text-faint transition-shadow focus-within:ring-ice/40', GLASS_ROW, className)}>
      <IconSearch size={14} />
      <span className="sr-only">{label}</span>
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} spellCheck={false} className="min-w-0 flex-1 bg-transparent text-[12.5px] text-text placeholder:text-faint" />
    </label>
  );
}

/** Section label in small spaced capitals, with an optional figure or action on the right. */
export function SectionHead({ label, children, className }: { label: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex min-h-8 items-center gap-3', className)}>
      <span className="text-[11px] font-medium tracking-[0.16em] text-faint uppercase">{label}</span>
      {children}
    </div>
  );
}
