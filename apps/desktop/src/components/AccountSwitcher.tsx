// SPDX-License-Identifier: GPL-3.0-or-later
// Active wallet picker (title bar): the vault, or one of the hardware-wallet accounts.

import { hwFingerprint } from '@kyro/chains';
import { useApp } from '../state/app';
import { Menu } from './ui/menu';
import { IconChevronDown, IconPlus, IconShield, IconUsbKey } from './icons';
import { BRAND } from '../state/hw';

const ADD = '__add__';

export function AccountSwitcher() {
  const { hwAccounts, activeAccountId, activeHw, selectAccount, navigate, hwOnly } = useApp();
  const items = [
    ...(hwOnly ? [] : [{ value: 'vault', label: 'Compte principal', hint: 'Coffre chiffré sur cet ordinateur', icon: <IconShield size={15} className="text-mute" /> }]),
    ...hwAccounts.map((a) => ({
      value: a.id,
      label: a.label,
      hint: `${BRAND[a.device]} · ${a.model}${hwFingerprint(a) ? ` · ${hwFingerprint(a)}` : ''}`,
      icon: <IconUsbKey size={15} className="text-ice" />,
    })),
    { value: ADD, label: 'Ajouter un appareil', hint: 'Ledger ou Trezor', icon: <IconPlus size={15} className="text-mute" /> },
  ];
  return (
    <Menu
      label="Compte actif"
      value={activeAccountId}
      items={items}
      onSelect={(v) => (v === ADD ? navigate({ name: 'settings', section: 'hardware' }) : selectAccount(v))}
      trigger={
        <button type="button" aria-label="Changer de compte" className="flex min-w-0 items-center gap-1.5 rounded-[8px] px-1.5 py-0.5 text-[13px] text-mute hover:bg-raised hover:text-text">
          {activeHw && <IconUsbKey size={13} className="shrink-0 text-ice" />}
          <span className="truncate">{activeHw ? activeHw.label : 'Compte principal'}</span>
          <IconChevronDown size={13} className="shrink-0" />
        </button>
      }
    />
  );
}
