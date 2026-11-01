// SPDX-License-Identifier: GPL-3.0-or-later
// Réglages › Appareils: hardware-wallet accounts (Ledger, Trezor).

import { useState } from 'react';
import { call, toIpcError, type HwThpPairing, type WatchOnlyAccount } from '@kyro/shared';
import { useAsync } from '../../lib/useAsync';
import { useApp } from '../../state/app';
import { DeviceBadge, HwAccountSummary, HwSetup } from '../../components/hw';
import { Dialog } from '../../components/ui/dialog';
import { Badge, Button, Notice, Spinner } from '../../components/ui/primitives';
import { IconPlus, IconTrash, IconWarn } from '../../components/icons';
import { fmtDate } from '../../lib/format';
import { useT } from '../../i18n';
import { rt } from '../../i18n/rich';

export function Devices() {
  const { hwAccounts, refreshHwAccounts, activeAccountId, selectAccount, hwOnly } = useApp();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<WatchOnlyAccount | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { t } = useT();

  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    setError(null);
    try {
      await call('hw_account_remove', { accountId: removing.id });
      setRemoving(null);
      await refreshHwAccounts();
    } catch (e) {
      setError(toIpcError(e).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section className="flex flex-col gap-3.5 rounded-panel border border-line bg-card px-[22px] py-[18px]">
        <div className="flex items-center justify-between">
          <span className="text-[15px] font-medium tracking-[-0.01em]">{t('settings.devices')}</span>
          <Badge tone="ice">Ledger · Trezor</Badge>
        </div>
        <p className="m-0 text-[13px] leading-[1.55] text-text2">{t('settings.devicesIntro')}</p>
        {hwAccounts.length === 0 && <span className="text-[13px] text-faint">{t('settings.noDevice')}</span>}
        <div className="flex flex-col gap-2.5">
          {hwAccounts.map((a) => (
            <HwAccountSummary
              key={a.id}
              acc={a}
              action={
                <div className="flex flex-wrap gap-2">
                  {activeAccountId === a.id ? (
                    <Badge tone="up">{t('settings.activeAccount')}</Badge>
                  ) : (
                    <Button size="sm" variant="outline" onClick={() => selectAccount(a.id)}>
                      {t('settings.useThisAccount')}
                    </Button>
                  )}
                  <Button size="sm" variant="dangerOutline" onClick={() => setRemoving(a)}>
                    <IconTrash size={13} /> {t('common.delete')}
                  </Button>
                </div>
              }
            />
          ))}
        </div>
        {adding ? (
          <div className="rounded-box border border-ice-line bg-bg px-4 py-4">
            <HwSetup
              onCancel={() => setAdding(false)}
              onDone={(acc) => {
                setAdding(false);
                void refreshHwAccounts(acc.id);
              }}
            />
          </div>
        ) : (
          <div>
            <Button variant="primary" onClick={() => setAdding(true)}>
              <IconPlus size={14} /> {t('settings.addDevice')}
            </Button>
          </div>
        )}
      </section>
      <ThpPairings />

      <Dialog open={removing !== null} onOpenChange={(v) => (v ? undefined : setRemoving(null))} title={t('settings.removeHwTitle')} className="w-[520px]">
        {removing && (
          <>
            <div className="flex items-center gap-2">
              <span className="text-[14px] font-semibold">{removing.label}</span>
              <DeviceBadge device={removing.device} model={removing.model} />
            </div>
            <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />}>
              {rt('settings.removeHwBody', { b: (c) => <strong className="font-semibold">{c}</strong> })}
              {hwOnly && hwAccounts.length === 1 ? ` ${t('settings.removeHwLast')}` : ''}
            </Notice>
            {error && <Notice tone="error">{error}</Notice>}
            <div className="flex justify-end gap-2">
              <Button variant="primary" onClick={() => setRemoving(null)} disabled={busy}>
                {t('settings.keep')}
              </Button>
              <Button variant="dangerOutline" onClick={() => void remove()} disabled={busy}>
                {busy && <Spinner />} {t('settings.removeHwConfirm')}
              </Button>
            </div>
          </>
        )}
      </Dialog>
    </>
  );
}

function ThpPairings() {
  const list = useAsync(() => call('hw_thp_pairings'), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { t } = useT();
  const forget = async (key?: string) => {
    setBusy(key ?? 'all');
    setError(null);
    try {
      await call('hw_thp_forget', key ? { key } : {});
      list.reload();
    } catch (e) {
      setError(toIpcError(e).message);
    } finally {
      setBusy(null);
    }
  };
  const items: HwThpPairing[] = list.data ?? [];
  if (!list.data && !list.error) return null;
  return (
    <section className="flex flex-col gap-3 rounded-panel border border-line bg-card px-[22px] py-[18px]">
      <div className="flex items-center justify-between">
        <span className="text-[15px] font-medium tracking-[-0.01em]">{t('settings.thpTitle')}</span>
        <Badge>{t('settings.thpBadge')}</Badge>
      </div>
      <p className="m-0 text-[13px] leading-[1.55] text-text2">{rt('settings.thpIntro', { b: (c) => <strong className="font-semibold text-text">{c}</strong> })}</p>
      {list.error && <Notice tone="error">{list.error.message}</Notice>}
      {list.data && items.length === 0 && <span className="text-[13px] text-faint">{t('settings.thpNone')}</span>}
      {items.map((p) => (
        <div key={p.key} className="flex items-center justify-between gap-3 rounded-box border border-line bg-raised px-4 py-2.5">
          <span className="flex min-w-0 flex-col">
            <span className="text-[13px] font-semibold">{p.model === 'T3W1' ? 'Trezor Safe 7' : p.model}</span>
            <span className="truncate font-mono text-[11px] text-mute">
              {t('settings.thpKey', { key: `${p.key.slice(0, 12)}…${p.key.slice(-6)}`, date: fmtDate(p.added * 1000, { day: '2-digit', month: '2-digit', year: 'numeric' }) })}
            </span>
          </span>
          <Button size="sm" variant="dangerOutline" onClick={() => void forget(p.key)} disabled={busy !== null}>
            {busy === p.key && <Spinner />} {t('settings.forget')}
          </Button>
        </div>
      ))}
      {items.length > 0 && (
        <div>
          <Button size="sm" variant="dangerOutline" onClick={() => void forget()} disabled={busy !== null}>
            {busy === 'all' && <Spinner />} {t('settings.forgetAll')}
          </Button>
        </div>
      )}
      {error && <Notice tone="error">{error}</Notice>}
    </section>
  );
}
