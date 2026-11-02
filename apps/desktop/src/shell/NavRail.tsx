// SPDX-License-Identifier: GPL-3.0-or-later
// Navigation rail (84 px).

import type { ReactNode } from 'react';
import { motion } from 'motion/react';
import { cn } from '../lib/cn';
import { useApp, type Route } from '../state/app';
import { IconClock, IconLayers, IconLock, IconSliders, IconStake, IconSwap, IconWallet } from '../components/icons';
import { useT } from '../i18n';

type RailKey = 'portfolio' | 'assets' | 'swap' | 'staking' | 'history' | 'settings';

export function railKeyOf(r: Route): RailKey {
  switch (r.name) {
    case 'asset':
    case 'assets':
      return 'assets';
    case 'send':
    case 'receive':
    case 'portfolio':
      return 'portfolio';
    default:
      return r.name;
  }
}

function RailItem({ active, label, icon, onClick }: { active: boolean; label: string; icon: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn('group press relative flex h-[66px] w-[80px] flex-col items-center justify-center gap-[7px] rounded-[14px] transition-colors duration-150', active ? 'text-text' : 'text-mute hover:bg-white/[.035] hover:text-text')}
    >
      {active && (
        <motion.span layoutId="rail-active" aria-hidden="true" className="absolute inset-0 rounded-[14px] border border-white/[.07] bg-[linear-gradient(180deg,rgba(124,196,255,.10),rgba(124,196,255,.03))] shadow-[inset_0_1px_0_rgba(255,255,255,.05)]" transition={{ type: 'spring', stiffness: 480, damping: 38, mass: 0.8 }}>
          <span className="absolute top-1/2 -left-[8px] h-6 w-[3px] -translate-y-1/2 rounded-full bg-ice shadow-[0_0_12px_rgba(124,196,255,.7)]" />
        </motion.span>
      )}
      <span className={cn('relative z-10 transition-transform duration-200 ease-[cubic-bezier(.22,1,.36,1)] group-hover:-translate-y-px', active && 'text-ice')}>{icon}</span>
      <span className={cn('relative z-10 text-[12.5px] leading-none tracking-[-0.005em]', active ? 'font-semibold' : 'font-medium')}>{label}</span>
    </button>
  );
}

export function NavRail() {
  const { route, navigate, lock, hwOnly } = useApp();
  const k = railKeyOf(route);
  const { t } = useT();
  return (
    <nav aria-label={t('shell.navigation')} className="flex w-[96px] shrink-0 flex-col items-center gap-1 border-r border-rail bg-bg-deep/80 py-3.5">
      <RailItem active={k === 'portfolio'} label={t('shell.portfolio')} icon={<IconWallet size={23} sw={1.7} />} onClick={() => navigate({ name: 'portfolio' })} />
      <RailItem active={k === 'assets'} label={t('shell.assets')} icon={<IconLayers size={23} sw={1.7} />} onClick={() => navigate({ name: 'assets' })} />
      <RailItem active={k === 'swap'} label="Swap" icon={<IconSwap size={23} sw={1.7} />} onClick={() => navigate({ name: 'swap' })} />
      <RailItem active={k === 'staking'} label={t('shell.earn')} icon={<IconStake size={23} sw={1.7} />} onClick={() => navigate({ name: 'staking' })} />
      <RailItem active={k === 'history'} label={t('common.history')} icon={<IconClock size={23} sw={1.7} />} onClick={() => navigate({ name: 'history' })} />
      <div className="flex-1" />
      <RailItem active={k === 'settings'} label={t('common.settings')} icon={<IconSliders size={23} sw={1.7} />} onClick={() => navigate({ name: 'settings' })} />
      {!hwOnly && (
      <button
        type="button"
        aria-label={t('shell.lockVault')}
        title={t('shell.lockVault')}
        onClick={() => void lock()}
        className="press group mt-2 mb-1 flex size-12 items-center justify-center rounded-[14px] border border-line-2 bg-white/[.02] text-mute hover:border-line-3 hover:bg-white/[.06] hover:text-text"
      >
        <IconLock size={20} />
      </button>
      )}
    </nav>
  );
}
