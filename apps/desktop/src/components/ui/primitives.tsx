// SPDX-License-Identifier: GPL-3.0-or-later
// shadcn/ui-style primitives, restyled with the Kyro tokens.

import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import { cn } from '../../lib/cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'outline' | 'danger' | 'dangerOutline' | 'ice';
type Size = 'sm' | 'md' | 'lg' | 'xl';

const variants: Record<Variant, string> = {
  primary: 'bg-primary text-white hover:bg-primary-hover disabled:bg-control-2 disabled:text-faint',
  secondary: 'bg-control text-text hover:bg-control-2 disabled:text-faint',
  ghost: 'bg-transparent text-mute hover:text-text hover:bg-raised',
  outline: 'bg-transparent text-text border border-line-2 hover:bg-raised',
  danger: 'bg-down text-[#1a0b0b] hover:brightness-110',
  dangerOutline: 'bg-transparent text-down border border-down/50 hover:bg-down/10',
  ice: 'bg-ice/12 text-ice-text hover:bg-ice/20',
};
const sizes: Record<Size, string> = {
  sm: 'h-8 px-3 text-[12px] gap-1.5',
  md: 'h-10 px-4 text-[13px] gap-2',
  lg: 'h-11 pl-4 pr-5 text-[14px] gap-2',
  xl: 'h-[50px] px-6 text-[15px] gap-2',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  /** Pill (actions) vs rounded rectangle. */
  pill?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = 'secondary', size = 'md', pill = true, className, type = 'button', ...rest }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn('inline-flex shrink-0 items-center justify-center font-semibold whitespace-nowrap transition-colors disabled:opacity-45', pill ? 'rounded-full' : 'rounded-[10px]', variants[variant], sizes[size], className)}
      {...rest}
    />
  );
});

export function IconButton({ className, label, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button type="button" aria-label={label} title={label} className={cn('flex items-center justify-center rounded-full border border-line-2 bg-raised text-text hover:bg-control', className)} {...rest}>
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
      className={cn('h-11 w-full rounded-[12px] border border-line-2 bg-bg px-3.5 text-[14px] text-text placeholder:text-faint focus:border-ice-line', className)}
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
    <As className={cn('rounded-[20px] border border-line bg-card', className)} {...rest}>
      {children}
    </As>
  );
}

type Tone = 'up' | 'down' | 'warn' | 'ice' | 'mute' | 'primary';
const tones: Record<Tone, string> = {
  up: 'bg-up/12 text-up',
  down: 'bg-down/12 text-down',
  warn: 'bg-warn/14 text-warn',
  ice: 'bg-ice/12 text-ice-text2',
  mute: 'bg-control-2 text-text2',
  primary: 'bg-primary text-white',
};
export function Badge({ tone = 'mute', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <span className={cn('inline-flex h-[22px] shrink-0 items-center gap-1 rounded-full px-2.5 text-[11px] font-semibold whitespace-nowrap', tones[tone], className)}>{children}</span>;
}

export function Switch({ checked, onCheckedChange, disabled, label }: { checked: boolean; onCheckedChange?: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <SwitchPrimitive.Root
      checked={checked}
      {...(onCheckedChange ? { onCheckedChange } : {})}
      {...(disabled !== undefined ? { disabled } : {})}
      aria-label={label}
      className={cn('relative h-[26px] w-11 shrink-0 rounded-full transition-colors data-[state=checked]:bg-ice data-[state=unchecked]:bg-control-2', disabled && 'opacity-70')}
    >
      <SwitchPrimitive.Thumb className="block size-5 translate-x-[3px] rounded-full transition-transform data-[state=checked]:translate-x-[21px] data-[state=checked]:bg-[#0a0b0d] data-[state=unchecked]:bg-[#5e6470]" />
    </SwitchPrimitive.Root>
  );
}

export interface SegmentOption<T extends string | number> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
}

/** Segmented control ("1J 1S 1M", "5 min 15 min"…). */
export function Segmented<T extends string | number>({ options, value, onChange, label, className, size = 'md' }: { options: SegmentOption<T>[]; value: T; onChange: (v: T) => void; label: string; className?: string; size?: 'sm' | 'md' }) {
  return (
    <div role="group" aria-label={label} className={cn('flex rounded-[10px] border border-line bg-bg p-[3px]', className)}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            aria-pressed={active}
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
            className={cn('rounded-[7px] whitespace-nowrap', size === 'sm' ? 'h-7 px-2.5 text-[12px]' : 'h-8 px-3 text-[12px]', active ? 'bg-control-2 font-semibold text-text' : 'font-medium text-mute hover:text-text2', o.disabled && 'opacity-40')}
          >
            {o.label}
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
  return <span aria-hidden="true" className={cn('inline-block size-4 animate-spin rounded-full border-2 border-current border-t-transparent', className)} />;
}

/** Inline notice: info / warn / error / success. */
export function Notice({ tone = 'info', children, className, icon }: { tone?: 'info' | 'warn' | 'error' | 'success'; children: ReactNode; className?: string; icon?: ReactNode }) {
  const cls = {
    info: 'border-line-2 bg-raised text-text2',
    warn: 'border-warn/35 bg-warn/[.07] text-[#f7d9a4]',
    error: 'border-down/40 bg-down/[.08] text-[#ffc2c2]',
    success: 'border-up/35 bg-up/[.07] text-[#b8f3d8]',
  }[tone];
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={cn('flex items-start gap-3 rounded-[14px] border px-4 py-3 text-[13px] leading-[1.5]', cls, className)}>
      {icon}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
