// SPDX-License-Identifier: GPL-3.0-or-later
//
// Réglages › Comptes: several accounts per chain in the vault (docs/IPC.md §2.9), like Ledger
// Live. Keys come from the recovery phrase: an account is a public bookmark (number + name).
// « Ajouter un compte » scans the next account number (address, path, balance), then adds it
// with an editable name; renaming and removing only touch the bookmark (re-adding a removed
// account gives back the same addresses and funds). « Créer plusieurs… » adds up to 10 accounts
// at once with their default names (same command, one call per account, Rust checks each).

import { useEffect, useState } from 'react';
import { ACCOUNT_CHAINS, MAX_ACCOUNTS_PER_CHAIN, MAX_VAULT_ACCOUNT, call, toIpcError, type AccountChain, type VaultAccountEntry } from '@kyro/shared';
import { assetsFor, createAdapters, type Balance } from '@kyro/chains';
import { useApp } from '../../state/app';
import { useAsync } from '../../lib/useAsync';
import { fmtCrypto, shortAddress } from '../../lib/format';
import { ACCOUNT_CHAIN_HINT, ACCOUNT_CHAIN_LABEL, accountAddress, accountNameProblem, defaultAccountName, familyAdapters, nextAccountIndex, planNewAccounts } from '../../lib/accounts';
import { useAccountBalanceText, useCreateAccounts } from '../../components/AccountPicker';
import { CopyButton } from '../../components/kit';
import { Dialog } from '../../components/ui/dialog';
import { Badge, Button, Input, Label, Notice, Spinner } from '../../components/ui/primitives';
import { IconPlus, IconTrash } from '../../components/icons';

export function AccountsSection({ family }: { family?: AccountChain }) {
  const { vaultLists, hwOnly, activeHw, refreshVaultAccounts } = useApp();
  const [adding, setAdding] = useState<AccountChain | null>(family ?? null);
  const [bulk, setBulk] = useState<AccountChain | null>(null);
  const [renaming, setRenaming] = useState<{ family: AccountChain; entry: VaultAccountEntry } | null>(null);
  const [removing, setRemoving] = useState<{ family: AccountChain; entry: VaultAccountEntry } | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (hwOnly) {
    return <Notice tone="info">Les comptes multiples concernent le coffre Kyro. Pour un hardware wallet, ajoute un compte par numéro dans Réglages › Appareils.</Notice>;
  }
  if (!vaultLists) {
    return (
      <span className="flex items-center gap-2 text-[13px] text-mute">
        <Spinner /> Chargement des comptes…
      </span>
    );
  }
  return (
    <>
      <section className="flex flex-col gap-3 rounded-[22px] border border-line bg-card px-[22px] py-[18px]">
        <div className="flex items-center justify-between">
          <span className="text-[15px] font-semibold">Comptes du coffre</span>
          <Badge tone="ice">Phrase de récupération</Badge>
        </div>
        <p className="m-0 text-[13px] leading-[1.55] text-text2">
          Chaque chaîne peut avoir plusieurs comptes, tous issus de ta phrase de récupération : retirer un compte ne le retire que de cette liste, tu peux le rajouter plus tard et retrouver ses fonds. Le premier compte de chaque chaîne est celui que tu as toujours eu.
        </p>
        {activeHw && <Notice tone="info">Le compte actif est un hardware wallet : ces comptes s’appliquent au « Compte principal » (le coffre).</Notice>}
        {error && <Notice tone="error">{error}</Notice>}
      </section>
      {ACCOUNT_CHAINS.map((c) => (
        <ChainAccounts key={c} family={c} list={vaultLists[c]} onAdd={() => setAdding(c)} onBulk={() => setBulk(c)} onRename={(entry) => setRenaming({ family: c, entry })} onRemove={(entry) => setRemoving({ family: c, entry })} />
      ))}
      {adding && <AddAccountDialog family={adding} list={vaultLists[adding]} onClose={() => setAdding(null)} />}
      {bulk && <BulkCreateDialog family={bulk} list={vaultLists[bulk]} onClose={() => setBulk(null)} />}
      {renaming && <RenameDialog {...renaming} onClose={() => setRenaming(null)} />}
      {removing && (
        <Dialog open onOpenChange={(v) => !v && setRemoving(null)} title={`Retirer « ${removing.entry.name} » ?`}>
          <p className="m-0 text-[13px] leading-[1.55] text-text2">
            Le compte disparaît de tes listes (Portefeuille, Envoyer, Recevoir…). Ses clés viennent de ta phrase : ses fonds restent à lui, et tu peux le rajouter à tout moment (compte n° {removing.entry.index + 1}).
          </p>
          <div className="flex justify-end gap-2">
            <Button onClick={() => setRemoving(null)}>Annuler</Button>
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
              <IconTrash size={14} /> Retirer
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
  const full = list.length >= MAX_ACCOUNTS_PER_CHAIN || nextAccountIndex(list, MAX_VAULT_ACCOUNT) === null;
  return (
    <section aria-label={`Comptes ${ACCOUNT_CHAIN_LABEL[family]}`} className="flex flex-col gap-2.5 rounded-[22px] border border-line bg-card px-[22px] py-[16px]">
      <div className="flex items-center justify-between gap-3">
        <span className="flex flex-col">
          <span className="text-[14px] font-semibold">{ACCOUNT_CHAIN_LABEL[family]}</span>
          <span className="text-[12px] text-mute">{ACCOUNT_CHAIN_HINT[family]}</span>
        </span>
        <span className="flex shrink-0 gap-1.5">
          <Button size="sm" variant="ghost" onClick={onBulk} disabled={full} aria-label={`Créer plusieurs comptes ${ACCOUNT_CHAIN_LABEL[family]}`}>
            Créer plusieurs…
          </Button>
          <Button size="sm" variant="outline" onClick={onAdd} disabled={full}>
            <IconPlus size={14} /> Ajouter un compte
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
                <span className="text-[11px] font-normal text-faint">n° {e.index + 1}</span>
                {active && <Badge tone="up">Utilisé</Badge>}
              </span>
              <span className="truncate font-mono text-[11px] text-mute">{src ? `${shortAddress(src.addresses[0] ?? '', 10, 6)} · ${src.path}` : 'chargement…'}</span>
              {bal && <span className="text-[12px] text-text2">{bal}</span>}
            </span>
            <span className="flex shrink-0 gap-1.5">
              {list.length > 1 && !active && (
                <Button size="sm" variant="ghost" onClick={() => selectChainAccount(family, e.index)}>
                  Utiliser
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => onRename(e)}>
                Renommer
              </Button>
              {e.index !== 0 && (
                <Button size="sm" variant="ghost" aria-label={`Retirer ${e.name}`} onClick={() => onRemove(e)}>
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
    <Dialog open onOpenChange={(v) => !v && onClose()} title={`Renommer « ${entry.name} »`}>
      <Label htmlFor="account-name">Nom du compte</Label>
      <Input id="account-name" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !problem && void save()} />
      {problem && name.length > 0 && <span className="text-[12px] text-warn">{problem}</span>}
      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Annuler</Button>
        <Button variant="primary" disabled={!!problem || busy} onClick={() => void save()}>
          {busy ? <Spinner /> : 'Enregistrer'}
        </Button>
      </div>
    </Dialog>
  );
}

/** Scans account `index` of `family`: address, path and balances (read through the usual servers). */
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
    <Dialog open onOpenChange={(v) => !v && onClose()} title={`Ajouter un compte ${ACCOUNT_CHAIN_LABEL[family]}`} description="Kyro dérive le compte depuis ta phrase de récupération et lit son solde. Rien n’est signé.">
      <div className="flex gap-3">
        <div className="flex w-[120px] flex-col gap-1.5">
          <Label htmlFor="account-number">Compte n°</Label>
          <Input id="account-number" inputMode="numeric" value={numberStr} onChange={(e) => setNumberStr(e.target.value)} />
        </div>
        <div className="flex flex-1 flex-col gap-1.5">
          <Label htmlFor="account-new-name">Nom</Label>
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
      {index === null && <span className="text-[12px] text-warn">{numberStr.trim() === '1' ? 'Le compte n° 1 est toujours dans ta liste.' : list.some((e) => e.index === parsed) ? 'Ce compte est déjà dans ta liste.' : `Numéro entre 2 et ${MAX_VAULT_ACCOUNT + 1}.`}</span>}
      {problem && name.length > 0 && <span className="text-[12px] text-warn">{problem}</span>}
      {index !== null && (
        <div className="flex flex-col gap-1.5 rounded-[14px] border border-line-2 bg-raised px-4 py-3">
          {preview.loading && !preview.data ? (
            <span className="flex items-center gap-2 text-[13px] text-mute">
              <Spinner /> Recherche du compte…
            </span>
          ) : preview.error ? (
            <span className="text-[13px] text-warn">{preview.error.message}</span>
          ) : preview.data ? (
            <>
              <span className="flex items-center justify-between gap-2">
                <span className="truncate font-mono text-[12px]">{preview.data.address}</span>
                <CopyButton text={preview.data.address} />
              </span>
              <span className="font-mono text-[11px] text-mute">{preview.data.path}</span>
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
                    ? 'Solde indisponible pour l’instant (serveur ou Tor).'
                    : 'Aucun fonds sur ce compte pour l’instant.'}
              </span>
            </>
          ) : null}
        </div>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Annuler</Button>
        <Button variant="primary" disabled={index === null || !!problem || busy} onClick={() => void add()}>
          {busy ? <Spinner /> : 'Ajouter le compte'}
        </Button>
      </div>
    </Dialog>
  );
}

/** Highest number of accounts « Créer plusieurs… » adds in one go. */
const BULK_MAX = 10;

function BulkCreateDialog({ family, list, onClose }: { family: AccountChain; list: VaultAccountEntry[]; onClose: () => void }) {
  const create = useCreateAccounts();
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
      setError(`${toIpcError(e).message} Les comptes déjà créés restent dans ta liste.`);
    } finally {
      setBusy(false);
    }
  };
  const names = planned.map((i) => defaultAccountName(family, i));
  return (
    <Dialog open onOpenChange={(v) => !v && !busy && onClose()} title={`Créer plusieurs comptes ${ACCOUNT_CHAIN_LABEL[family]}`} description={`Chaque compte vient de ta phrase de récupération, avec ses propres adresses. Au plus ${MAX_ACCOUNTS_PER_CHAIN} comptes par chaîne (tu en as ${list.length}). Rien n’est signé.`}>
      <div className="flex w-[160px] flex-col gap-1.5">
        <Label htmlFor="bulk-count">Nombre de comptes</Label>
        <Input id="bulk-count" inputMode="numeric" value={countStr} onChange={(e) => setCountStr(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && count !== null && !busy && void run()} />
      </div>
      {count === null && <span className="text-[12px] text-warn">{room === 0 ? `Limite de ${MAX_ACCOUNTS_PER_CHAIN} comptes atteinte.` : `Entre 1 et ${room}.`}</span>}
      {names.length > 0 && (
        <p className="m-0 text-[13px] leading-[1.55] text-text2">
          {names.length === 1 ? `Nouveau compte : ${names[0]}.` : `Nouveaux comptes : ${names.length <= 4 ? names.join(', ') : `${names.slice(0, 3).join(', ')}… ${names[names.length - 1]}`}.`} Tu pourras les renommer ici.
        </p>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex justify-end gap-2">
        <Button onClick={onClose} disabled={busy}>
          Annuler
        </Button>
        <Button variant="primary" disabled={count === null || busy} onClick={() => void run()}>
          {busy ? <Spinner /> : count !== null && count > 1 ? `Créer ${count} comptes` : 'Créer le compte'}
        </Button>
      </div>
    </Dialog>
  );
}
