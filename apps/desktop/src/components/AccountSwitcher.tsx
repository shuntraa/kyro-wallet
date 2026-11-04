// SPDX-License-Identifier: GPL-3.0-or-later
// Active wallet picker (title bar): the vault, or one of the hardware-wallet accounts.

import { hwFingerprint } from '@kyro/chains';
import { useApp } from '../state/app';
import { CONTACT_FAMILY_META } from '../lib/contactDetect';
import { shortAddress } from '../lib/format';
import type { ContactFamily } from '../lib/storage';
import { Badge } from './ui/primitives';
import { Menu } from './ui/menu';
import { IconChevronDown, IconEye, IconPlus, IconShield, IconUsbKey } from './icons';
import { BRAND } from '../state/hw';
import { useT } from '../i18n';

const ADD = '__add__';
const ACCOUNTS = '__accounts__';
const WATCH = '__watch__';

export function AccountSwitcher() {
  const { hwAccounts, activeAccountId, activeHw, activeWatch, watchAddresses, selectAccount, navigate, hwOnly } = useApp();
  const { t } = useT();
  const items = [
    ...(hwOnly ? [] : [{ value: 'vault', label: t('settings.mainAccount'), hint: t('shell.vaultHint'), icon: <IconShield size={15} className="text-mute" /> }]),
    ...hwAccounts.map((a) => ({
      value: a.id,
      label: a.label,
      hint: `${BRAND[a.device]} · ${a.model}${hwFingerprint(a) ? ` · ${hwFingerprint(a)}` : ''}`,
      icon: <IconUsbKey size={15} className="text-ice" />,
    })),
    ...watchAddresses.map((w) => ({
      value: w.id,
      label: w.label,
      hint: t('watch.switchHint', { network: CONTACT_FAMILY_META[w.family as ContactFamily]?.label ?? w.family, address: shortAddress(w.value) }),
      icon: <IconEye size={15} className="text-mute" />,
    })),
    ...(hwOnly ? [] : [{ value: ACCOUNTS, label: t('shell.accountsPerChain'), hint: t('shell.accountsPerChainHint'), icon: <IconPlus size={15} className="text-mute" /> }]),
    { value: ADD, label: t('shell.addDevice'), hint: t('shell.addDeviceHint'), icon: <IconPlus size={15} className="text-mute" /> },
    { value: WATCH, label: t('watch.add'), hint: t('watch.addHint'), icon: <IconEye size={15} className="text-mute" /> },
  ];
  return (
    <Menu
      label={t('shell.activeAccount')}
      value={activeAccountId}
      items={items}
      onSelect={(v) => (v === ADD ? navigate({ name: 'settings', section: 'hardware' }) : v === ACCOUNTS || v === WATCH ? navigate({ name: 'settings', section: 'accounts' }) : selectAccount(v))}
      trigger={
        <button type="button" aria-label={t('shell.switchAccount')} className="flex min-w-0 items-center gap-1.5 rounded-[8px] px-1.5 py-0.5 text-[13px] text-mute hover:bg-raised hover:text-text">
          {activeHw && <IconUsbKey size={13} className="shrink-0 text-ice" />}
          <span className="truncate">{activeHw ? activeHw.label : activeWatch ? activeWatch.label : t('settings.mainAccount')}</span>
          {activeWatch && <Badge className="shrink-0">{t('watch.tag')}</Badge>}
          <IconChevronDown size={13} className="shrink-0" />
        </button>
      }
    />
  );
}
