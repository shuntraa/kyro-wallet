// SPDX-License-Identifier: GPL-3.0-or-later
// Kyro controls: frosted primary button, glass button, coin-lit buttons, switch, period picker,
// filter tabs marked by the ice square.

import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { FROST_STYLE } from './frost';
import { GLASS_ROW } from './brand';

type Btn = ButtonHTMLAttributes<HTMLButtonElement> & { children?: ReactNode };

/** Primary action: frosted white, as on the unlock screen. */
export function Frost({ className, children, style, ...rest }: Btn) {
  return (
    <button type="button" {...rest} className={cn('press flex h-12 items-center justify-center gap-2 rounded-[15px] px-5 text-[14.5px] font-semibold transition-[filter,opacity] duration-150 hover:brightness-[1.04] disabled:cursor-not-allowed disabled:opacity-45', className)} style={{ ...FROST_STYLE, ...style }}>
      {children}
    </button>
  );
}

/** Secondary action on glass. */
export function GlassButton({ className, children, ...rest }: Btn) {
  return (
    <button type="button" {...rest} className={cn('press flex h-11 items-center justify-center gap-2 rounded-[14px] px-4 text-[13.5px] font-semibold text-text transition-colors duration-150 hover:bg-white/[.08] disabled:cursor-not-allowed disabled:opacity-45', GLASS_ROW, className)}>
      {children}
    </button>
  );
}

/** Coin page action: a lit outline in the coin's colour. */
export function CoinPill({ c, className, children, style, ...rest }: Btn & { c: string }) {
  return (
    <button
      type="button"
      {...rest}
      className={cn('press flex h-11 min-w-[170px] items-center justify-center gap-2 rounded-full px-6 text-[14px] font-semibold text-white transition-[filter] duration-150 hover:brightness-125 disabled:cursor-not-allowed disabled:opacity-45', className)}
      style={{ background: `linear-gradient(180deg, ${c}2b, ${c}10)`, boxShadow: `inset 0 0 0 1.5px ${c}cc, 0 0 22px ${c}33`, ...style }}
    >
      {children}
    </button>
  );
}

/** Round coin-lit icon button. */
export function CoinRound({ c, className, children, style, ...rest }: Btn & { c: string }) {
  return (
    <button
      type="button"
      {...rest}
      className={cn('press grid size-11 shrink-0 place-items-center rounded-full transition-[filter] duration-150 hover:brightness-125 disabled:cursor-not-allowed disabled:opacity-45', className)}
      style={{ color: c, background: `${c}14`, boxShadow: `inset 0 0 0 1.5px ${c}aa, 0 0 18px ${c}33`, ...style }}
    >
      {children}
    </button>
  );
}

/** On/off switch. */
export function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={cn('flex h-[18px] w-8 shrink-0 items-center rounded-full p-[2px] transition-colors duration-150 disabled:opacity-45', on ? 'justify-end bg-ice/80 shadow-[0_0_10px_#7cc4ff66]' : 'bg-white/[.1]')}
    >
      <span className={cn('size-[14px] rounded-full', on ? 'bg-[#06121f]' : 'bg-text2')} />
    </button>
  );
}

/** Small segmented picker (chart periods, durations). `accent` lights the chosen one in a coin colour. */
export function Segmented<T extends string>({ items, value, onChange, accent, label }: { items: Array<{ id: T; label: ReactNode }>; value: T; onChange: (v: T) => void; accent?: string; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex gap-1 text-[12px] font-medium text-faint">
      {items.map((it) => {
        const on = it.id === value;
        return (
          <button
            key={it.id}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(it.id)}
            className={cn('rounded-[9px] px-3 py-1.5 transition-colors duration-150', on ? (accent ? '' : 'bg-white/[.07] text-text ring-1 ring-white/[.06]') : 'hover:text-text2')}
            style={on && accent ? { color: accent, background: `${accent}1c`, boxShadow: `inset 0 0 0 1px ${accent}55, 0 0 14px ${accent}22` } : undefined}
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}

/** Filter tabs: the chosen one is marked by the glowing ice square. */
export function Tabs<T extends string>({ items, value, onChange, label }: { items: Array<{ id: T; label: ReactNode }>; value: T; onChange: (v: T) => void; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="flex items-center gap-5 text-[12.5px] font-medium">
      {items.map((it) => {
        const on = it.id === value;
        return (
          <button key={it.id} type="button" role="tab" aria-selected={on} onClick={() => onChange(it.id)} className={cn('flex items-center gap-1.5 transition-colors duration-150', on ? 'text-text' : 'text-faint hover:text-text2')}>
            {on && <span aria-hidden="true" className="size-[5px] bg-ice shadow-[0_0_8px_#7cc4ff]" />}
            {it.label}
          </button>
        );
      })}
    </div>
  );
}
