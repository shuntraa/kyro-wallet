// SPDX-License-Identifier: GPL-3.0-or-later
// Kyro header (56 px): wordmark and account, sections marked by the ice square, search, Tor,
// hide balances, settings, lock, window controls. Replaces the left rail and the bottom bar.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { KyroMark } from '../components/kit';
import { IconEye, IconEyeOff, IconLock, IconSearch, IconSliders } from '../components/icons';
import { TorIndicator } from '../components/Tor';
import { DISPLAY } from '../components/kyro';
import { cn } from '../lib/cn';
import { useApp } from '../state/app';
import { torIndicator, useTor } from '../state/tor';
import { useT } from '../i18n';
import { railKeyOf } from './NavRail';
import { onBarMouseDown, SearchBox, WindowControls, type SearchResult } from './TitleBar';

function Section({ on, label, onClick }: { on: boolean; label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-current={on ? 'page' : undefined} className={cn('flex h-9 items-center gap-2 text-[13px] font-medium transition-colors duration-150', on ? 'text-text' : 'text-mute hover:text-text2')}>
      <span aria-hidden="true" className={cn('size-[5px] transition-[background,box-shadow] duration-200', on ? 'bg-ice shadow-[0_0_8px_#7cc4ff]' : 'bg-transparent')} />
      {label}
    </button>
  );
}

function IconBtn({ label, onClick, on, children }: { label: string; onClick: () => void; on?: boolean; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className={cn('grid size-8 place-items-center rounded-[10px] transition-colors duration-150 hover:bg-white/[.06] hover:text-text', on ? 'text-text' : 'text-mute')}>
      {children}
    </button>
  );
}

function HeaderTor() {
  const tor = useTor();
  if (torIndicator(tor) === 'ready')
    return (
      <span role="status" className="flex items-center gap-2 text-[12.5px] text-mute">
        <span aria-hidden="true" className="size-[5px] bg-ice shadow-[0_0_8px_#7cc4ff]" /> Tor
      </span>
    );
  return (
    <span className="text-[12.5px]">
      <TorIndicator />
    </span>
  );
}

/** Search icon that opens the search box in place (Ctrl+K opens it too). */
function SearchSlot({ search }: { search: (q: string) => SearchResult[] }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') setOpen(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    if (open) window.setTimeout(() => box.current?.querySelector('input')?.focus(), 0);
  }, [open]);
  if (!open)
    return (
      <IconBtn label={t('shell.search')} onClick={() => setOpen(true)}>
        <IconSearch size={17} />
      </IconBtn>
    );
  return (
    <span ref={box} className="mr-1" onBlur={() => window.setTimeout(() => { if (!box.current?.contains(document.activeElement)) setOpen(false); }, 200)}>
      <SearchBox search={search} />
    </span>
  );
}

export function KyroBar({ search, account }: { search?: (q: string) => SearchResult[]; account?: ReactNode }) {
  const { route, navigate, lock, hwOnly, hideBalances, setHideBalances, demo, network } = useApp();
  const { t } = useT();
  const k = railKeyOf(route);
  return (
    <header onMouseDown={onBarMouseDown} className="relative z-20 flex h-14 shrink-0 cursor-default items-center border-b border-white/[.045] pl-6 select-none">
      <span className="flex shrink-0 items-center gap-2.5">
        <KyroMark size={22} />
        <span className="text-[15px] leading-none" style={{ ...DISPLAY, fontWeight: 600 }}>
          Kyro
        </span>
        {account && <span className="ml-1 flex max-w-[120px] min-w-0 items-center text-[12.5px] text-mute xl:max-w-[200px]">{account}</span>}
      </span>

      <nav aria-label={t('shell.navigation')} className="ml-6 flex min-w-0 items-center gap-4 xl:ml-10 xl:gap-7">
        <Section on={k === 'portfolio'} label={t('shell.portfolio')} onClick={() => navigate({ name: 'portfolio' })} />
        <Section on={k === 'assets'} label={t('shell.assets')} onClick={() => navigate({ name: 'assets' })} />
        <Section on={k === 'swap'} label={t('shell.swap')} onClick={() => navigate({ name: 'swap' })} />
        <Section on={k === 'staking'} label={t('shell.earn')} onClick={() => navigate({ name: 'staking' })} />
        <Section on={k === 'history'} label={t('common.history')} onClick={() => navigate({ name: 'history' })} />
      </nav>

      <span className="ml-auto flex shrink-0 items-center gap-1 pr-[148px] xl:gap-2">
        {search && <SearchSlot search={search} />}
        {demo && <span className="rounded-full bg-ice/[.08] px-2 py-[3px] text-[11.5px] leading-none text-ice-text2">{t('shell.demoMode')}</span>}
        {network === 'testnet' && <span className="rounded-full bg-warn/[.08] px-2 py-[3px] text-[11.5px] leading-none text-warn">Testnet</span>}
        <span className="mx-1.5">
          <HeaderTor />
        </span>
        <IconBtn label={hideBalances ? t('portfolio.showBalances') : t('portfolio.hideBalances')} onClick={() => setHideBalances(!hideBalances)} on={hideBalances}>
          {hideBalances ? <IconEyeOff size={17} /> : <IconEye size={17} />}
        </IconBtn>
        <IconBtn label={t('common.settings')} onClick={() => navigate({ name: 'settings' })} on={k === 'settings'}>
          <IconSliders size={17} />
        </IconBtn>
        {!hwOnly && (
          <IconBtn label={t('shell.lockVault')} onClick={() => void lock()}>
            <IconLock size={16} />
          </IconBtn>
        )}
      </span>
      <span className="absolute top-0 right-0">
        <WindowControls />
      </span>
    </header>
  );
}
