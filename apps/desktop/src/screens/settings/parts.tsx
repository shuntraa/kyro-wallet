// SPDX-License-Identifier: GPL-3.0-or-later
// Settings in the Kyro language: groups (spaced caps label + glass panel of rows), pickers with a
// chevron, and the sub-page frame whose older panels take the glass look through the colour tokens.

import type { CSSProperties, ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { DISPLAY, GLASS_ROW, LABEL } from '../../components/kyro';
import { Menu } from '../../components/ui/menu';
import { IconBack, IconChevronDown, IconChevronRight } from '../../components/icons';
import { useT } from '../../i18n';

export function Group({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn('flex flex-col gap-2.5', className)}>
      <h2 className={cn(LABEL, 'm-0')}>{title}</h2>
      <div className={cn('flex flex-col rounded-[18px] [&>*+*]:border-t [&>*+*]:border-white/[.05]', GLASS_ROW)}>{children}</div>
    </section>
  );
}

const ROW = 'flex min-h-[54px] w-full items-center gap-4 px-5 py-2.5 text-left';

/** A row: label (and an optional faint line) on the left, value or control on the right. */
export function Row({ label, sub, children, onClick, chevron, danger }: { label: ReactNode; sub?: ReactNode; children?: ReactNode; onClick?: () => void; chevron?: boolean; danger?: boolean }) {
  const body = (
    <>
      <span className="flex min-w-0 flex-col leading-tight">
        <span className={cn('text-[13.5px] font-medium', danger && 'text-down')}>{label}</span>
        {sub && <span className="mt-0.5 text-[11.5px] text-faint">{sub}</span>}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-2 text-[13px] text-text2">
        {children}
        {chevron && <IconChevronRight size={14} className="text-faint" />}
      </span>
    </>
  );
  if (!onClick) return <div className={ROW}>{body}</div>;
  return (
    <button type="button" onClick={onClick} className={cn(ROW, 'transition-colors duration-150 first:rounded-t-[18px] last:rounded-b-[18px] hover:bg-white/[.03]')}>
      {body}
    </button>
  );
}

/** Value with a down chevron, opening a list. */
export function Pick<T extends string>({ value, label, items, onSelect, className }: { value: T; label: string; items: Array<{ value: T; label: ReactNode; hint?: ReactNode; short?: string }>; onSelect: (v: T) => void; className?: string }) {
  const current = items.find((i) => i.value === value);
  const shown = current?.short ?? current?.label ?? value;
  return (
    <Menu
      value={value}
      onSelect={onSelect}
      align="end"
      {...(className ? { className } : {})}
      items={items.map(({ short: _s, ...it }) => it)}
      trigger={
        <button type="button" aria-label={`${label} : ${typeof shown === 'string' ? shown : value}`} className="press -mr-1 flex items-center gap-2 rounded-[8px] px-1 py-1 text-[13px] text-text2 transition-colors hover:text-text">
          {shown} <IconChevronDown size={14} className="text-faint" />
        </button>
      }
    />
  );
}

/** Text action on the right of a row (« Changer », « Afficher »). */
export function RowAction({ children, onClick, tone }: { children: ReactNode; onClick: () => void; tone?: 'warn' }) {
  return (
    <button type="button" onClick={onClick} className={cn('press -mr-1 rounded-[8px] px-1 py-1 text-[13px] transition-colors', tone === 'warn' ? 'text-warn hover:text-text' : 'text-text2 hover:text-text')}>
      {children}
    </button>
  );
}

/** Older panels (bg-card, border-line…) inside a sub-page take the glass look. */
const GLASS_TOKENS = {
  '--color-card': 'rgba(255,255,255,.045)',
  '--color-card-2': 'rgba(255,255,255,.05)',
  '--color-raised': 'rgba(255,255,255,.04)',
  '--color-control': 'rgba(255,255,255,.07)',
  '--color-control-2': 'rgba(255,255,255,.1)',
  '--color-line': 'rgba(255,255,255,.065)',
  '--color-line-2': 'rgba(255,255,255,.09)',
  '--color-line-3': 'rgba(255,255,255,.16)',
  '--color-bg': 'rgba(0,0,0,.28)',
} as CSSProperties;

const GLASS_CSS = `
.kyro-glass .bg-card{backdrop-filter:blur(22px) saturate(1.2);box-shadow:inset 0 1px 0 rgba(255,255,255,.05)}
.kyro-glass .btn-primary:not(:disabled){background-image:linear-gradient(180deg,#e6f3ff,#c2e0fa);color:#061423;box-shadow:inset 0 1px 0 rgba(255,255,255,.95),inset 0 -1px 0 rgba(53,119,180,.35),inset 0 0 0 1px rgba(255,255,255,.35),0 10px 30px -12px rgba(124,196,255,.85)}
`;

/** Sub-page: back button, title in the display face, then its content on glass. */
export function SubPage({ title, onBack, children, aside }: { title: string; onBack: () => void; children: ReactNode; aside?: ReactNode }) {
  const { t } = useT();
  return (
    <div className="kyro-glass flex flex-col" style={GLASS_TOKENS}>
      <style>{GLASS_CSS}</style>
      <div className="flex items-center gap-4">
        <button type="button" aria-label={t('common.back')} onClick={onBack} className="press grid size-10 shrink-0 place-items-center rounded-full bg-white/[.045] text-mute ring-1 ring-white/[.07] backdrop-blur-xl transition-colors hover:bg-white/[.08] hover:text-text">
          <IconBack size={16} />
        </button>
        <h1 className="m-0 text-[22px] leading-none" style={{ ...DISPLAY, fontWeight: 400, letterSpacing: '-0.03em' }}>
          {title}
        </h1>
      </div>
      <div className="mt-8 flex min-w-0 gap-6">
        <div className="rise flex min-w-0 flex-1 flex-col gap-4">{children}</div>
        {aside && <aside className="hidden w-[360px] shrink-0 xl:block">{aside}</aside>}
      </div>
    </div>
  );
}
