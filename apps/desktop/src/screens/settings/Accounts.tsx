// SPDX-License-Identifier: GPL-3.0-or-later
// Réglages › Comptes: several accounts per chain in the vault (docs/IPC.md §2.9), like Ledger Live.

import { useEffect, useState } from 'react';
import { ACCOUNT_CHAINS, MAX_ACCOUNTS_PER_CHAIN, MAX_VAULT_ACCOUNT, call, toIpcError, type AccountChain, type VaultAccountEntry } from '@kyro/shared';
import { assetsFor, createAdapters, isHiddenFamily, type Balance } from '@kyro/chains';
import { useApp } from '../../state/app';
import { useAsync } from '../../lib/useAsync';
import { fmtCrypto, shortAddress } from '../../lib/format';
import { ACCOUNT_CHAIN_LABEL, accountAddress, accountChainHint, accountNameProblem, defaultAccountName, familyAdapters, nextAccountIndex, planNewAccounts } from '../../lib/accounts';
import { useAccountBalanceText, useCreateAccounts } from '../../components/AccountPicker';
import { CopyButton } from '../../components/kit';
import { Dialog } from '../../components/ui/dialog';
import { Badge, Button, Input, Label, Notice, Spinner } from '../../components/ui/primitives';
import { IconPlus, IconTrash } from '../../components/icons';
import { useT } from '../../i18n';

export function AccountsSection({ family }: { family?: AccountChain }) {
  const { vaultLists, hwOnly, activeHw, refreshVaultAccounts } = useApp();
  const [adding, setAdding] = useState<AccountChain | null>(family ?? null);
  const [bulk, setBulk] = useState<AccountChain | null>(null);
  const [renaming, setRenaming] = useState<{ family: AccountChain; entry: VaultAccountEntry } | null>(null);
  const [removing, setRemoving] = useState<{ family: AccountChain; entry: VaultAccountEntry } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { t } = useT();

  if (hwOnly) {
    return <Notice tone="info">{t('settings.accountsHwOnly')}</Notice>;
  }
  if (!vaultLists) {
    return (
      <span className="flex items-center gap-2 text-[13px] text-mute">
        <Spinner /> {t('settings.accountsLoading')}
      </span>
    );
  }
  return (
    <>
      <section className="flex flex-col gap-3 rounded-[22px] border border-line bg-card px-[22px] py-[18px]">
        <div className="flex items-center justify-between">
          <span className="text-[15px] font-semibold">{t('settings.vaultAccounts')}</span>
          <Badge tone="ice">{t('settings.recoveryPhrase')}</Badge>
        </div>
        <p className="m-0 text-[13px] leading-[1.55] text-text2">{t('settings.vaultAccountsIntro')}</p>
        {activeHw && <Notice tone="info">{t('settings.accountsActiveHw')}</Notice>}
        {error && <Notice tone="error">{error}</Notice>}
      </section>
      {ACCOUNT_CHAINS.filter((c) => !isHiddenFamily(c)).map((c) => (
        <ChainAccounts key={c} family={c} list={vaultLists[c]} onAdd={() => setAdding(c)} onBulk={() => setBulk(c)} onRename={(entry) => setRenaming({ family: c, entry })} onRemove={(entry) => setRemoving({ family: c, entry })} />
      ))}
      {adding && <AddAccountDialog family={adding} list={vaultLists[adding]} onClose={() => setAdding(null)} />}
      {bulk && <BulkCreateDialog family={bulk} list={vaultLists[bulk]} onClose={() => setBulk(null)} />}
      {renaming && <RenameDialog {...renaming} onClose={() => setRenaming(null)} />}
      {removing && (
        <Dialog open onOpenChange={(v) => !v && setRemoving(null)} title={t('settings.removeAccountTitle', { name: removing.entry.name })}>
          <p className="m-0 text-[13px] leading-[1.55] text-text2">{t('settings.removeAccountBody', { n: removing.entry.index + 1 })}</p>
          <div className="flex justify-end gap-2">
            <Button onClick={() => setRemoving(null)}>{t('common.cancel')}</Button>
            <Button
              variant="dangerOutline"
              onClick={() => {
                const r = removing;
                setRemoving(null);
                setError(null);
                void call('vault_account_remove', { chain: r.family, account: r.entry.index })
                  .then(() => refreshVaultAccounts())
                  .catch((e: unknown) => setError(toIpcError(e).message));
              }}
            >
              <IconTrash size={14} /> {t('common.remove')}
            </Button>
          </div>
        </Dialog>
      )}
    </>
  );
}

function ChainAccounts({ family, list, onAdd, onBulk, onRename, onRemove }: { family: AccountChain; list: VaultAccountEntry[]; onAdd: () => void; onBulk: () => void; onRename: (e: VaultAccountEntry) => void; onRemove: (e: VaultAccountEntry) => void }) {
  const { accountSources, selectedAccounts, selectChainAccount } = useApp();
  const balance = useAccountBalanceText();
  const { t } = useT();
  const full = list.length >= MAX_ACCOUNTS_PER_CHAIN || nextAccountIndex(list, MAX_VAULT_ACCOUNT) === null;
  return (
    <section aria-label={t('settings.chainAccounts', { chain: ACCOUNT_CHAIN_LABEL[family] })} className="flex flex-col gap-2.5 rounded-[22px] border border-line bg-card px-[22px] py-[16px]">
      <div className="flex items-center justify-between gap-3">
        <span className="flex flex-col">
          <span className="text-[14px] font-semibold">{ACCOUNT_CHAIN_LABEL[family]}</span>
          <span className="text-[12px] text-mute">{accountChainHint(family)}</span>
        </span>
        <span className="flex shrink-0 gap-1.5">
          <Button size="sm" variant="ghost" onClick={onBulk} disabled={full} aria-label={t('settings.bulkTitle', { chain: ACCOUNT_CHAIN_LABEL[family] })}>
            {t('settings.bulkButton')}
          </Button>
          <Button size="sm" variant="outline" onClick={onAdd} disabled={full}>
            <IconPlus size={14} /> {t('settings.addAccount')}
          </Button>
        </span>
      </div>
      {list.map((e) => {
        const src = accountSources.find((s) => s.family === family && s.index === e.index);
        const bal = balance(family, e.index);
        const active = list.length > 1 && selectedAccounts[family] === e.index;
        return (
          <div key={e.index} className="flex items-center justify-between gap-3 border-t border-line pt-2.5">
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="flex items-center gap-2 text-[13px] font-semibold">
                {e.name}
                <span className="text-[12px] font-normal text-faint">{t('settings.accountNumber', { n: e.index + 1 })}</span>
                {active && <Badge tone="up">{t('settings.accountUsed')}</Badge>}
              </span>
              <span className="truncate font-mono text-[12px] text-mute">{src ? `${shortAddress(src.addresses[0] ?? '', 10, 6)} · ${src.path}` : t('settings.loadingLower')}</span>
              {bal && <span className="text-[12px] text-text2">{bal}</span>}
            </span>
            <span className="flex shrink-0 gap-1.5">
              {list.length > 1 && !active && (
                <Button size="sm" variant="ghost" onClick={() => selectChainAccount(family, e.index)}>
                  {t('settings.useAccount')}
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => onRename(e)}>
                {t('common.rename')}
              </Button>
              {e.index !== 0 && (
                <Button size="sm" variant="ghost" aria-label={t('settings.removeNamed', { name: e.name })} onClick={() => onRemove(e)}>
                  <IconTrash size={14} />
                </Button>
              )}
            </span>
          </div>
        );
      })}
    </section>
  );
}

function RenameDialog({ family, entry, onClose }: { family: AccountChain; entry: VaultAccountEntry; onClose: () => void }) {
  const { refreshVaultAccounts } = useApp();
  const [name, setName] = useState(entry.name);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { t } = useT();
  const problem = accountNameProblem(name);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await call('vault_account_rename', { chain: family, account: entry.index, name: name.trim() });
      await refreshVaultAccounts();
      onClose();
    } catch (e) {
      setError(toIpcError(e).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()} title={t('settings.renameTitle', { name: entry.name })}>
      <Label htmlFor="account-name">{t('settings.accountName')}</Label>
      <Input id="account-name" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !problem && void save()} />
      {problem && name.length > 0 && <span className="text-[12px] text-warn">{problem}</span>}
      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button variant="primary" disabled={!!problem || busy} onClick={() => void save()}>
          {busy ? <Spinner /> : t('common.save')}
        </Button>
      </div>
    </Dialog>
  );
}

function useAccountPreview(family: AccountChain, index: number | null) {
  const { settings } = useApp();
  return useAsync(
    index === null
      ? null
      : async () => {
          const acc = await call('accounts_get', { account: index });
          const { address, path } = accountAddress(acc, family);
          const ads = familyAdapters(createAdapters(acc, settings.servers, undefined, undefined, index), family);
          const results = await Promise.allSettled(ads.map((a) => a.getBalance()));
          const balances: Balance[] = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
          const failed = results.some((r) => r.status === 'rejected');
          return { address, path, balances, failed };
        },
    [family, index, JSON.stringify(settings.servers)],
  );
}

function AddAccountDialog({ family, list, onClose }: { family: AccountChain; list: VaultAccountEntry[]; onClose: () => void }) {
  const { refreshVaultAccounts, network } = useApp();
  const { t } = useT();
  const suggested = nextAccountIndex(list, MAX_VAULT_ACCOUNT);
  const [numberStr, setNumberStr] = useState(suggested === null ? '' : String(suggested + 1));
  const parsed = /^\d{1,3}$/.test(numberStr.trim()) ? Number(numberStr.trim()) - 1 : NaN;
  const index = Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_VAULT_ACCOUNT && !list.some((e) => e.index === parsed) ? parsed : null;
  const [name, setName] = useState(suggested === null ? '' : defaultAccountName(family, suggested));
  const [nameEdited, setNameEdited] = useState(false);
  useEffect(() => {
    if (!nameEdited && index !== null) setName(defaultAccountName(family, index));
  }, [index, family, nameEdited]);
  const preview = useAccountPreview(family, index);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = accountNameProblem(name);
  const assets = assetsFor(network);
  const nonZero = (preview.data?.balances ?? []).filter((b) => b.amount > 0n);

  const add = async () => {
    if (index === null || problem) return;
    setBusy(true);
    setError(null);
    try {
      await call('vault_account_add', { chain: family, account: index, name: name.trim() });
      await refreshVaultAccounts({ family, index });
      onClose();
    } catch (e) {
      setError(toIpcError(e).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()} title={t('settings.addTitle', { chain: ACCOUNT_CHAIN_LABEL[family] })} description={t('settings.addDesc')}>
      <div className="flex gap-3">
        <div className="flex w-[120px] flex-col gap-1.5">
          <Label htmlFor="account-number">{t('settings.accountNumberLabel')}</Label>
          <Input id="account-number" inputMode="numeric" value={numberStr} onChange={(e) => setNumberStr(e.target.value)} />
        </div>
        <div className="flex flex-1 flex-col gap-1.5">
          <Label htmlFor="account-new-name">{t('settings.name')}</Label>
          <Input
            id="account-new-name"
            value={name}
            maxLength={40}
            onChange={(e) => {
              setName(e.target.value);
              setNameEdited(true);
            }}
          />
        </div>
      </div>
      {index === null && <span className="text-[12px] text-warn">{numberStr.trim() === '1' ? t('settings.firstAccountAlways') : list.some((e) => e.index === parsed) ? t('settings.accountAlreadyListed') : t('settings.numberRange', { max: MAX_VAULT_ACCOUNT + 1 })}</span>}
      {problem && name.length > 0 && <span className="text-[12px] text-warn">{problem}</span>}
      {index !== null && (
        <div className="flex flex-col gap-1.5 rounded-[14px] border border-line-2 bg-raised px-4 py-3">
          {preview.loading && !preview.data ? (
            <span className="flex items-center gap-2 text-[13px] text-mute">
              <Spinner /> {t('settings.searchingAccount')}
            </span>
          ) : preview.error ? (
            <span className="text-[13px] text-warn">{preview.error.message}</span>
          ) : preview.data ? (
            <>
              <span className="flex items-center justify-between gap-2">
                <span className="truncate font-mono text-[12px]">{preview.data.address}</span>
                <CopyButton text={preview.data.address} />
              </span>
              <span className="font-mono text-[12px] text-mute">{preview.data.path}</span>
              <span className="text-[13px] text-text2">
                {nonZero.length > 0
                  ? nonZero
                      .map((b) => {
                        const a = assets.find((x) => x.id === b.assetId);
                        return a ? fmtCrypto(b.amount, a.decimals, a.symbol) : null;
                      })
                      .filter(Boolean)
                      .join(' · ')
                  : preview.data.failed
                    ? t('settings.balanceUnavailable')
                    : t('settings.noFundsYet')}
              </span>
            </>
          ) : null}
        </div>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button variant="primary" disabled={index === null || !!problem || busy} onClick={() => void add()}>
          {busy ? <Spinner /> : t('settings.addAccountConfirm')}
        </Button>
      </div>
    </Dialog>
  );
}

const BULK_MAX = 10;

function BulkCreateDialog({ family, list, onClose }: { family: AccountChain; list: VaultAccountEntry[]; onClose: () => void }) {
  const create = useCreateAccounts();
  const { t, tp } = useT();
  const room = Math.min(BULK_MAX, planNewAccounts(list, BULK_MAX, MAX_ACCOUNTS_PER_CHAIN, MAX_VAULT_ACCOUNT).length);
  const [countStr, setCountStr] = useState(String(Math.min(5, room)));
  const n = /^\d{1,2}$/.test(countStr.trim()) ? Number(countStr.trim()) : NaN;
  const count = Number.isInteger(n) && n >= 1 && n <= room ? n : null;
  const planned = count === null ? [] : planNewAccounts(list, count, MAX_ACCOUNTS_PER_CHAIN, MAX_VAULT_ACCOUNT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    if (count === null) return;
    setBusy(true);
    setError(null);
    try {
      await create(family, count);
      onClose();
    } catch (e) {
      setError(`${toIpcError(e).message} ${t('settings.bulkPartial')}`);
    } finally {
      setBusy(false);
    }
  };
  const names = planned.map((i) => defaultAccountName(family, i));
  return (
    <Dialog open onOpenChange={(v) => !v && !busy && onClose()} title={t('settings.bulkTitle', { chain: ACCOUNT_CHAIN_LABEL[family] })} description={t('settings.bulkDesc', { max: MAX_ACCOUNTS_PER_CHAIN, have: list.length })}>
      <div className="flex w-[160px] flex-col gap-1.5">
        <Label htmlFor="bulk-count">{t('settings.bulkCount')}</Label>
        <Input id="bulk-count" inputMode="numeric" value={countStr} onChange={(e) => setCountStr(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && count !== null && !busy && void run()} />
      </div>
      {count === null && <span className="text-[12px] text-warn">{room === 0 ? t('settings.bulkLimit', { max: MAX_ACCOUNTS_PER_CHAIN }) : t('settings.bulkRange', { max: room })}</span>}
      {names.length > 0 && (
        <p className="m-0 text-[13px] leading-[1.55] text-text2">
          {names.length === 1 ? t('settings.bulkNewOne', { name: names[0] ?? '' }) : t('settings.bulkNewMany', { names: names.length <= 4 ? names.join(', ') : `${names.slice(0, 3).join(', ')}… ${names[names.length - 1]}` })} {t('settings.bulkRenameLater')}
        </p>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex justify-end gap-2">
        <Button onClick={onClose} disabled={busy}>
          {t('common.cancel')}
        </Button>
        <Button variant="primary" disabled={count === null || busy} onClick={() => void run()}>
          {busy ? <Spinner /> : tp('settings.bulkCreate', count ?? 1)}
        </Button>
      </div>
    </Dialog>
  );
}
