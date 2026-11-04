// SPDX-License-Identifier: GPL-3.0-or-later
// Réglages › Comptes: the wallets of this device (docs/IPC.md §2.9b). One phrase and password each.

import { useState, type FormEvent } from 'react';
import { call, toIpcError, type WalletEntry } from '@kyro/shared';
import { useApp } from '../../state/app';
import { PasswordField } from '../../components/kit';
import { Dialog } from '../../components/ui/dialog';
import { Badge, Button, Input, Label, Notice } from '../../components/ui/primitives';
import { useT } from '../../i18n';

export function WalletsSection() {
  const { wallets, walletLabel, refreshWallets, switchWallet, addWallet, enterVault } = useApp();
  const { t } = useT();
  const [name, setName] = useState('');
  const [renaming, setRenaming] = useState<WalletEntry | null>(null);
  const [label, setLabel] = useState('');
  const [removing, setRemoving] = useState<WalletEntry | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (job: () => Promise<unknown>) => {
    setError(null);
    setBusy(true);
    try {
      await job();
    } catch (e) {
      setError(toIpcError(e).message);
    } finally {
      setBusy(false);
    }
  };
  const add = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) void run(() => addWallet(name.trim()));
  };
  return (
    <section className="flex flex-col gap-3 rounded-[22px] border border-line bg-card px-[22px] py-[18px]">
      <span className="text-[15px] font-semibold">{t('wallets.title')}</span>
      <p className="m-0 text-[13px] leading-[1.55] text-text2">{t('wallets.intro')}</p>
      {error && <Notice tone="error">{error}</Notice>}
      {wallets?.wallets.map((w) => {
        const active = w.id === wallets.active;
        return (
          <div key={w.id} className="flex items-center gap-3 rounded-ctl bg-raised px-4 py-2.5">
            <span className="min-w-0 flex-1 truncate text-[14px] font-semibold">{walletLabel(w.id)}</span>
            {active ? (
              <Badge tone="up">{t('wallets.inUse')}</Badge>
            ) : (
              <Button size="sm" onClick={() => void run(() => switchWallet(w.id))}>
                {t('wallets.open')}
              </Button>
            )}
            <Button
              size="sm"
              onClick={() => {
                setLabel(walletLabel(w.id));
                setRenaming(w);
              }}
            >
              {t('wallets.rename')}
            </Button>
            {active && w.id !== 'main' && (
              <Button size="sm" variant="dangerOutline" onClick={() => setRemoving(w)}>
                {t('wallets.remove')}
              </Button>
            )}
          </div>
        );
      })}
      <form onSubmit={add} className="flex flex-col gap-2 border-t border-line pt-4">
        <Label htmlFor="wallet-name">{t('wallets.add')}</Label>
        <div className="flex items-center gap-2">
          <Input id="wallet-name" value={name} maxLength={32} placeholder={t('wallets.namePlaceholder')} onChange={(e) => setName(e.target.value)} className="min-w-0 flex-1" />
          <Button type="submit" variant="primary" disabled={!name.trim() || busy}>
            {t('wallets.addButton')}
          </Button>
        </div>
        <span className="text-[12px] text-faint">{t('wallets.addNote')}</span>
      </form>
      {renaming && (
        <Dialog open onOpenChange={(v) => !v && setRenaming(null)} title={t('wallets.renameTitle', { name: walletLabel(renaming.id) })}>
          <Input value={label} maxLength={32} aria-label={t('wallets.nameLabel')} onChange={(e) => setLabel(e.target.value)} />
          <div className="flex justify-end gap-2">
            <Button onClick={() => setRenaming(null)}>{t('common.cancel')}</Button>
            <Button
              variant="primary"
              disabled={!label.trim()}
              onClick={() => {
                const { id } = renaming;
                setRenaming(null);
                void run(async () => {
                  await call('wallet_rename', { id, name: label.trim() });
                  await refreshWallets();
                });
              }}
            >
              {t('wallets.rename')}
            </Button>
          </div>
        </Dialog>
      )}
      {removing && (
        <Dialog open onOpenChange={(v) => !v && setRemoving(null)} title={t('wallets.removeTitle', { name: walletLabel(removing.id) })}>
          <p className="m-0 text-[13px] leading-[1.55] text-text2">{t('wallets.removeBody')}</p>
          <Label htmlFor="wallet-remove-pw">{t('wallets.removePassword')}</Label>
          <PasswordField id="wallet-remove-pw" value={password} onChange={setPassword} />
          <div className="flex justify-end gap-2">
            <Button onClick={() => setRemoving(null)}>{t('common.cancel')}</Button>
            <Button
              variant="dangerOutline"
              disabled={!password || busy}
              onClick={() => {
                const { id } = removing;
                const pw = password;
                setRemoving(null);
                setPassword('');
                void run(async () => {
                  await call('wallet_remove', { id, password: pw });
                  await enterVault();
                });
              }}
            >
              {t('wallets.remove')}
            </Button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
