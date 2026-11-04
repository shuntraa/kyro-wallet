// SPDX-License-Identifier: GPL-3.0-or-later
// Réglages › Comptes: public addresses and xpubs followed without a key (docs/IPC.md §2.3b).

import { useState } from 'react';
import { call, toIpcError, type WatchAddress } from '@kyro/shared';
import { useApp } from '../../state/app';
import { shortAddress } from '../../lib/format';
import { CONTACT_FAMILY_META } from '../../lib/contactDetect';
import type { ContactFamily } from '../../lib/storage';
import { CoinIcon } from '../../components/coins/CoinIcon';
import { WatchAddForm } from '../../components/WatchOnly';
import { Dialog } from '../../components/ui/dialog';
import { Badge, Button, Input, Notice } from '../../components/ui/primitives';
import { IconTrash } from '../../components/icons';
import { useT } from '../../i18n';

export function WatchAddressesSection() {
  const { watchAddresses, refreshWatchAddresses, selectAccount, activeAccountId, navigate } = useApp();
  const { t } = useT();
  const [renaming, setRenaming] = useState<WatchAddress | null>(null);
  const [label, setLabel] = useState('');
  const [removing, setRemoving] = useState<WatchAddress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (job: () => Promise<unknown>) => {
    setError(null);
    try {
      await job();
      await refreshWatchAddresses();
    } catch (e) {
      setError(toIpcError(e).message);
    }
  };
  return (
    <section className="flex flex-col gap-3 rounded-[22px] border border-line bg-card px-[22px] py-[18px]">
      <div className="flex items-center justify-between">
        <span className="text-[15px] font-semibold">{t('watch.title')}</span>
        <Badge>{t('watch.tag')}</Badge>
      </div>
      <p className="m-0 text-[13px] leading-[1.55] text-text2">{t('watch.intro')}</p>
      {error && <Notice tone="error">{error}</Notice>}
      {watchAddresses.length === 0 && <span className="text-[13px] text-faint">{t('watch.empty')}</span>}
      {watchAddresses.map((w) => {
        const meta = CONTACT_FAMILY_META[w.family as ContactFamily];
        return (
          <div key={w.id} className="flex items-center gap-3 rounded-ctl bg-raised px-4 py-2.5">
            <CoinIcon symbol={meta?.symbol ?? w.family.toUpperCase()} size={30} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[14px] font-semibold">{w.label}</span>
              <span className="font-mono text-[12px] text-mute">
                {meta?.label ?? w.family} · {shortAddress(w.value)}
              </span>
            </span>
            {activeAccountId !== w.id && (
              <Button
                size="sm"
                onClick={() => {
                  selectAccount(w.id);
                  navigate({ name: 'portfolio' });
                }}
              >
                {t('watch.open')}
              </Button>
            )}
            <Button
              size="sm"
              onClick={() => {
                setLabel(w.label);
                setRenaming(w);
              }}
            >
              {t('watch.rename')}
            </Button>
            <button type="button" aria-label={t('watch.remove', { name: w.label })} onClick={() => setRemoving(w)} className="flex size-8 items-center justify-center rounded-full text-mute hover:text-down">
              <IconTrash size={15} />
            </button>
          </div>
        );
      })}
      <div className="flex flex-col gap-2 border-t border-line pt-4">
        <WatchAddForm onAdded={() => refreshWatchAddresses()} />
      </div>
      {renaming && (
        <Dialog open onOpenChange={(v) => !v && setRenaming(null)} title={t('watch.renameTitle', { name: renaming.label })}>
          <Input value={label} maxLength={32} aria-label={t('watch.nameLabel')} onChange={(e) => setLabel(e.target.value)} />
          <div className="flex justify-end gap-2">
            <Button onClick={() => setRenaming(null)}>{t('common.cancel')}</Button>
            <Button
              variant="primary"
              disabled={!label.trim()}
              onClick={() => {
                const { id } = renaming;
                setRenaming(null);
                void run(() => call('watch_address_rename', { id, label: label.trim() }));
              }}
            >
              {t('watch.rename')}
            </Button>
          </div>
        </Dialog>
      )}
      {removing && (
        <Dialog open onOpenChange={(v) => !v && setRemoving(null)} title={t('watch.removeTitle', { name: removing.label })}>
          <p className="m-0 text-[13px] leading-[1.55] text-text2">{t('watch.removeBody')}</p>
          <div className="flex justify-end gap-2">
            <Button onClick={() => setRemoving(null)}>{t('common.cancel')}</Button>
            <Button
              variant="dangerOutline"
              onClick={() => {
                const { id } = removing;
                setRemoving(null);
                void run(() => call('watch_address_remove', { id }));
              }}
            >
              {t('watch.removeConfirm')}
            </Button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
