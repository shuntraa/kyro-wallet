// SPDX-License-Identifier: GPL-3.0-or-later
// Per-chain vault account picker (docs/IPC.md §2.9): shown only when the chain has several
// accounts in the user's list, so a single-account wallet looks exactly as before. Choosing an
// account changes the adapters every screen uses for that chain (Envoyer, Recevoir, Swap,
// Staking, Actif). Public data only.

import { assetsFor } from '@kyro/chains';
import type { AccountChain } from '@kyro/shared';
import { useApp } from '../state/app';
import { usePortfolio } from '../state/portfolio';
import { fmtCrypto, shortAddress } from '../lib/format';
import { cn } from '../lib/cn';
import { Menu } from './ui/menu';
import { IconChevronDown, IconPlus } from './icons';
import { HIDDEN } from './kit';

const ADD = '__add__';

/** Native balance of one account of `family` (not for EVM: one native per chain). */
export function useAccountBalanceText(): (family: AccountChain, index: number) => string | null {
  const { network, hideBalances } = useApp();
  const pf = usePortfolio();
  return (family, index) => {
    if (family === 'evm') return null;
    const native = assetsFor(network).find((a) => a.family === family && a.kind === 'native');
    if (!native) return null;
    const m = pf.accountBalances.get(`${family}:${index}`);
    if (!m?.has(native.id)) return null;
    return hideBalances ? HIDDEN : fmtCrypto(m.get(native.id) ?? 0n, native.decimals, native.symbol);
  };
}

export function AccountPicker({ family, className, label = 'Compte' }: { family: AccountChain; className?: string; label?: string }) {
  const { isMultiAccount, vaultLists, selectedAccounts, selectChainAccount, navigate, accountSources } = useApp();
  const balance = useAccountBalanceText();
  if (!isMultiAccount(family) || !vaultLists) return null;
  const list = vaultLists[family];
  const current = list.find((e) => e.index === selectedAccounts[family]) ?? list[0];
  const source = (i: number) => accountSources.find((s) => s.family === family && s.index === i);
  const items = [
    ...list.map((e) => {
      const src = source(e.index);
      const bal = balance(family, e.index);
      return {
        value: String(e.index),
        label: e.name,
        hint: [src?.addresses[0] ? shortAddress(src.addresses[0]) : null, bal, `n° ${e.index + 1}`].filter(Boolean).join(' · '),
        disabled: !src,
      };
    }),
    { value: ADD, label: 'Ajouter un compte…', hint: 'Réglages › Comptes', icon: <IconPlus size={15} className="text-mute" /> },
  ];
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <span className="text-[12px] font-medium text-mute">{label}</span>
      <Menu
        label="Compte utilisé"
        value={String(current?.index ?? 0)}
        items={items}
        onSelect={(v) => (v === ADD ? navigate({ name: 'settings', section: 'accounts', family }) : selectChainAccount(family, Number(v)))}
        trigger={
          <button type="button" aria-label={`Changer de compte ${family}`} className="flex min-w-0 items-center gap-1.5 rounded-[10px] border border-line-2 bg-raised px-2.5 py-1 text-[13px] hover:border-ice-line">
            <span className="truncate font-semibold">{current?.name ?? 'Compte'}</span>
            <IconChevronDown size={13} className="shrink-0 text-mute" />
          </button>
        }
      />
    </div>
  );
}
