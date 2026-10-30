// SPDX-License-Identifier: GPL-3.0-or-later
// shadcn/ui-style primitives, restyled with the Kyro tokens.

import { forwardRef, useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import { motion } from 'motion/react';
import { cn } from '../../lib/cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'outline' | 'danger' | 'dangerOutline' | 'ice';
type Size = 'sm' | 'md' | 'lg' | 'xl';

// One solid action colour (frosted white on ink); everything else is a quiet outline.
const variants: Record<Variant, string> = {
  primary: 'bg-primary text-on-primary hover:bg-primary-hover disabled:bg-control-2 disabled:text-faint',
  secondary: 'border border-line-2 bg-control/60 text-text hover:border-line-3 hover:bg-control disabled:text-faint',
  ghost: 'bg-transparent text-mute hover:text-text hover:bg-raised',
  outline: 'bg-transparent text-text border border-line-2 hover:border-line-3 hover:bg-raised',
  danger: 'bg-down text-[#1a0b0b] hover:brightness-110',
  dangerOutline: 'bg-transparent text-down border border-down/50 hover:bg-down/10',
  ice: 'border border-ice/25 bg-ice/[.07] text-ice-text hover:border-ice/40 hover:bg-ice/[.12]',
};
const sizes: Record<Size, string> = {
  sm: 'h-8 px-3 text-[12px] gap-1.5',
  md: 'h-9 px-3.5 text-[13px] gap-2',
  lg: 'h-10 pl-3.5 pr-4 text-[13.5px] gap-2',
  xl: 'h-11 px-5 text-[14px] gap-2',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  /** Pill (rare: inline chips) vs the default squared control. */
  pill?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = 'secondary', size = 'md', pill = false, className, type = 'button', ...rest }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn('press inline-flex shrink-0 items-center justify-center font-medium whitespace-nowrap disabled:opacity-45', pill ? 'rounded-full' : 'rounded-ctl', variants[variant], sizes[size], className)}
      {...rest}
    />
  );
});

export function IconButton({ className, label, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button type="button" aria-label={label} title={label} className={cn('press flex items-center justify-center rounded-ctl border border-line-2 bg-transparent text-text hover:border-line-3 hover:bg-raised', className)} {...rest}>
      {children}
    </button>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return (
    <input
      ref={ref}
      spellCheck={false}
      autoComplete="off"
      className={cn('h-10 w-full rounded-ctl border border-line-2 bg-bg px-3 text-[14px] text-text transition-colors placeholder:text-faint hover:border-line-3 focus:border-ice-line', className)}
      {...rest}
    />
  );
});

export function Label({ children, className, htmlFor }: { children: ReactNode; className?: string; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className={cn('text-[12px] font-medium text-mute', className)}>
      {children}
    </label>
  );
}

export function Card({ children, className, as: As = 'section', ...rest }: { children: ReactNode; className?: string; as?: 'section' | 'div' | 'aside' | 'form'; 'aria-label'?: string }) {
  return (
    <As className={cn('rounded-panel border border-line bg-card', className)} {...rest}>
      {children}
    </As>
  );
}

type Tone = 'up' | 'down' | 'warn' | 'ice' | 'mute' | 'primary';
// Tags, not pills: a hairline frame, mono small caps, the tone carried by the text.
const tones: Record<Tone, string> = {
  up: 'border-up/30 text-up',
  down: 'border-down/40 text-down bg-down/[.06]',
  warn: 'border-warn/35 text-warn bg-warn/[.05]',
  ice: 'border-ice/30 text-ice-text2',
  mute: 'border-line-3 text-mute',
  primary: 'border-primary bg-primary text-on-primary',
};
export function Badge({ tone = 'mute', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex h-5 shrink-0 items-center gap-1 rounded-[4px] border px-1.5 font-mono text-[10px] leading-none font-medium tracking-[0.06em] whitespace-nowrap uppercase', tones[tone], className)}>
      {children}
    </span>
  );
}

export function Switch({ checked, onCheckedChange, disabled, label }: { checked: boolean; onCheckedChange?: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <SwitchPrimitive.Root
      checked={checked}
      {...(onCheckedChange ? { onCheckedChange } : {})}
      {...(disabled !== undefined ? { disabled } : {})}
      aria-label={label}
      className={cn('relative h-[22px] w-[38px] shrink-0 rounded-full border transition-colors duration-200 data-[state=checked]:border-ice data-[state=checked]:bg-ice data-[state=unchecked]:border-line-3 data-[state=unchecked]:bg-control', disabled && 'opacity-70')}
    >
      <SwitchPrimitive.Thumb className="block size-4 translate-x-[2px] rounded-full transition-[translate,background-color] duration-200 ease-[cubic-bezier(.22,1,.36,1)] data-[state=checked]:translate-x-[18px] data-[state=checked]:bg-[#08090b] data-[state=unchecked]:bg-[#6b727d]" />
    </SwitchPrimitive.Root>
  );
}

export interface SegmentOption<T extends string | number> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
}

/** Segmented control ("1J 1S 1M", "5 min 15 min"…): the selection slides between options. */
export function Segmented<T extends string | number>({ options, value, onChange, label, className, size = 'md' }: { options: SegmentOption<T>[]; value: T; onChange: (v: T) => void; label: string; className?: string; size?: 'sm' | 'md' }) {
  const id = useId();
  return (
    <div role="group" aria-label={label} className={cn('flex rounded-[7px] border border-line bg-bg p-[2px]', className)}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            aria-pressed={active}
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
            className={cn('relative rounded-[5px] whitespace-nowrap transition-colors duration-150', size === 'sm' ? 'h-7 px-2.5 text-[12px]' : 'h-8 px-3 text-[12px]', active ? 'font-medium text-text' : 'font-medium text-mute hover:text-text2', o.disabled && 'opacity-40')}
          >
            {active && <motion.span layoutId={`seg-${id}`} aria-hidden="true" className="absolute inset-0 rounded-[5px] border border-line-3 bg-control-2" transition={{ type: 'spring', stiffness: 520, damping: 40, mass: 0.7 }} />}
            <span className="relative">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cn('skeleton inline-block', className)} />;
}

export function Spinner({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cn('inline-block size-4 animate-spin rounded-full border-[1.5px] border-current border-t-transparent', className)} />;
}

/** Inline notice: info / warn / error / success. A left rule carries the tone. */
export function Notice({ tone = 'info', children, className, icon }: { tone?: 'info' | 'warn' | 'error' | 'success'; children: ReactNode; className?: string; icon?: ReactNode }) {
  const cls = {
    info: 'border-line-2 border-l-line-3 bg-raised/60 text-text2',
    warn: 'border-warn/25 border-l-warn bg-warn/[.06] text-[#f7d9a4]',
    error: 'border-down/30 border-l-down bg-down/[.07] text-[#ffc2c2]',
    success: 'border-up/25 border-l-up bg-up/[.05] text-[#b8f3d8]',
  }[tone];
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={cn('fade-in flex items-start gap-3 rounded-box border border-l-2 px-4 py-3 text-[13px] leading-[1.5]', cls, className)}>
      {icon}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
