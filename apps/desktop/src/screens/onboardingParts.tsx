// SPDX-License-Identifier: GPL-3.0-or-later
// Onboarding frame in the unlock-screen language: ice light, the title bar, a centred column, the
// step indicator (small squares, the active one lit) and the glass button.

import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '../lib/cn';
import { TitleBar } from '../shell/TitleBar';
import { DISPLAY, IceLight } from '../components/kyro';
import { IconBack } from '../components/icons';
import { idx } from '../components/motion';
import { useT } from '../i18n';

/** Glass surface of the mock's secondary buttons (the `Glass` look, as a button). */
const GLASS_STYLE = {
  background: 'linear-gradient(180deg, rgba(255,255,255,.055), rgba(255,255,255,.025))',
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,.08), inset 0 0 0 1px rgba(255,255,255,.06), 0 24px 60px -30px rgba(0,0,0,.8)',
  backdropFilter: 'blur(22px) saturate(1.2)',
} as const;

export function GlassBig({ className, children, style, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...rest}
      className={cn('press flex h-[52px] items-center justify-center gap-2.5 rounded-[16px] px-5 text-[15px] font-semibold text-text transition-[filter,opacity] duration-150 hover:brightness-150 disabled:cursor-not-allowed disabled:opacity-45', className)}
      style={{ ...GLASS_STYLE, ...style }}
    >
      {children}
    </button>
  );
}

/** Home and unlock-like screens: strong light behind the object. Steps: a dimmer light at the top. */
export function OnboardingFrame({ children, home, onBack }: { children: ReactNode; home?: boolean; onBack?: () => void }) {
  const { t } = useT();
  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-[#05070a] text-text">
      {home ? <IceLight x="50%" y="30%" size={900} strength={0.8} id="welcome" /> : <IceLight x="50%" y="8%" size={900} strength={0.35} id="steps" />}
      <div className="relative z-20">
        <TitleBar bordered={false} />
      </div>
      {onBack && (
        <button
          type="button"
          aria-label={t('common.back')}
          onClick={onBack}
          className="press absolute top-[52px] left-6 z-20 grid size-10 place-items-center rounded-full bg-white/[.045] text-mute ring-1 ring-white/[.07] backdrop-blur-xl transition-colors hover:bg-white/[.08] hover:text-text"
        >
          <IconBack size={16} />
        </button>
      )}
      <main className={cn('relative z-10 flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 pb-10 scroll-thin', home ? 'pt-[min(48px,6vh)]' : 'pt-2')}>{children}</main>
    </div>
  );
}

/** Step indicator of the mock: the steps by name, the current one lit in ice. */
export function Steps({ steps, at }: { steps: string[]; at: number }) {
  const { t } = useT();
  return (
    <ol aria-label={t('welcome.stepOf', { step: at + 1, total: steps.length })} className="m-0 flex list-none items-center gap-6 p-0 text-[12px]">
      {steps.map((s, i) => (
        <li key={s} aria-current={i === at ? 'step' : undefined} className={cn('flex items-center gap-2', i === at ? 'text-text' : i < at ? 'text-mute' : 'text-faint')}>
          <span aria-hidden="true" className={cn('size-[7px]', i === at ? 'bg-ice shadow-[0_0_10px_#7cc4ff]' : i < at ? 'bg-ice/40' : 'bg-white/[.15]')} />
          {s}
        </li>
      ))}
    </ol>
  );
}

/** Step indicator, title in the display face and its line, as on the recovery-phrase mock. */
export function StepHead({ steps, at, title, children }: { steps?: string[]; at?: number; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center text-center">
      {steps && <Steps steps={steps} at={at ?? 0} />}
      <h1 className={cn('rise m-0 text-[28px] leading-[1.1]', steps ? 'mt-10' : 'mt-4')} style={{ ...DISPLAY, fontWeight: 500, ...idx(0) }}>
        {title}
      </h1>
      {children && (
        <p className="rise m-0 mt-4 max-w-[600px] text-[13.5px] leading-[1.55] text-mute" style={idx(1)}>
          {children}
        </p>
      )}
    </div>
  );
}

/** Small ice-square choice (12 / 24 words…), like the filter tabs. */
export function SquareChoice<T extends string | number>({ items, value, onChange, label }: { items: Array<{ id: T; label: string }>; value: T; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex gap-1 rounded-[12px] bg-white/[.03] p-1 text-[12.5px] font-medium ring-1 ring-white/[.06]">
      {items.map((it) => {
        const on = it.id === value;
        return (
          <button key={String(it.id)} type="button" role="radio" aria-checked={on} onClick={() => onChange(it.id)} className={cn('flex items-center gap-1.5 rounded-[9px] px-3 py-1.5 transition-colors duration-150', on ? 'bg-white/[.07] text-text ring-1 ring-white/[.06]' : 'text-faint hover:text-text2')}>
            {on && <span aria-hidden="true" className="size-[5px] bg-ice shadow-[0_0_8px_#7cc4ff]" />}
            {it.label}
          </button>
        );
      })}
    </div>
  );
}
