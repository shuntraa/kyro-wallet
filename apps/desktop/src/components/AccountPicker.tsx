// SPDX-License-Identifier: GPL-3.0-or-later
// Per-chain vault account picker (docs/IPC.md §2.9), always shown for the vault (even with one
// account) so creating another account is one click away: « Nouveau compte » adds the next
// account with its default name (« Bitcoin 2 »), selects it, and the trigger shows its address.
// Choosing an account changes the adapters every screen uses for that chain (Envoyer, Recevoir,
// Swap, Staking, Actif). Hardware-wallet accounts: not shown (unchanged). Public data only.

import { useCallback, useState } from 'react';
import { assetsFor } from '@kyro/chains';
import { call, MAX_ACCOUNTS_PER_CHAIN, MAX_VAULT_ACCOUNT, toIpcError, type AccountChain } from '@kyro/shared';
import { useApp } from '../state/app';
import { usePortfolio } from '../state/portfolio';
import { fmtCrypto, shortAddress } from '../lib/format';
import { ACCOUNT_CHAIN_LABEL, defaultAccountName, planNewAccounts } from '../lib/accounts';
import { cn } from '../lib/cn';
import { Menu } from './ui/menu';
import { Button, Spinner } from './ui/primitives';
import { IconChevronDown, IconPlus } from './icons';
import { HIDDEN } from './kit';

const NEW = '__new__';
const MANAGE = '__manage__';

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

/**
 * Creates the next `count` accounts of a chain with their default names (one `vault_account_add`
 * each, Rust checks every rule), then re-reads the lists. `select`: activate the first created.
 * Returns the created indices; on a failure midway, the accounts already created stay.
 */
export function useCreateAccounts(): (family: AccountChain, count: number, opts?: { select?: boolean }) => Promise<number[]> {
  const { vaultLists, refreshVaultAccounts } = useApp();
  return useCallback(
    async (family, count, opts = {}) => {
      if (!vaultLists) throw new Error('Comptes en cours de chargement.');
      const plan = planNewAccounts(vaultLists[family], count, MAX_ACCOUNTS_PER_CHAIN, MAX_VAULT_ACCOUNT);
      if (plan.length === 0) throw new Error(`Au plus ${MAX_ACCOUNTS_PER_CHAIN} comptes ${ACCOUNT_CHAIN_LABEL[family]}.`);
      const created: number[] = [];
      try {
        for (const index of plan) {
          await call('vault_account_add', { chain: family, account: index, name: defaultAccountName(family, index) });
          created.push(index);
        }
      } finally {
        const first = created[0];
        await refreshVaultAccounts(opts.select && first !== undefined ? { family, index: first } : undefined);
      }
      return created;
    },
    [vaultLists, refreshVaultAccounts],
  );
}

/** Index the next « Nouveau compte » would create, or null when the chain is full. */
function useNextAccount(family: AccountChain): number | null {
  const { vaultLists } = useApp();
  return vaultLists ? (planNewAccounts(vaultLists[family], 1, MAX_ACCOUNTS_PER_CHAIN, MAX_VAULT_ACCOUNT)[0] ?? null) : null;
}

export function AccountPicker({ family, className, label = 'Compte' }: { family: AccountChain; className?: string; label?: string }) {
  const { activeHw, vaultLists, selectedAccounts, selectChainAccount, navigate, accountSources } = useApp();
  const balance = useAccountBalanceText();
  const create = useCreateAccounts();
  const next = useNextAccount(family);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (activeHw || !vaultLists) return null;
  const list = vaultLists[family];
  const current = list.find((e) => e.index === selectedAccounts[family]) ?? list[0];
  const source = (i: number) => accountSources.find((s) => s.family === family && s.index === i);
  const currentAddress = current ? source(current.index)?.addresses[0] : undefined;
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
    {
      value: NEW,
      label: 'Nouveau compte',
      hint: next === null ? `Limite de ${MAX_ACCOUNTS_PER_CHAIN} comptes atteinte` : `${defaultAccountName(family, next)} · créé en un clic, issu de ta phrase`,
      icon: <IconPlus size={15} className="text-ice" />,
      disabled: next === null || busy,
    },
    { value: MANAGE, label: 'Gérer les comptes…', hint: 'Renommer, retirer, en créer plusieurs' },
  ];
  const onSelect = (v: string) => {
    if (v === MANAGE) return navigate({ name: 'settings', section: 'accounts', family });
    if (v !== NEW) return selectChainAccount(family, Number(v));
    setBusy(true);
    setError(null);
    create(family, 1, { select: true })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : toIpcError(e).message))
      .finally(() => setBusy(false));
  };
  return (
    <div className={cn('flex min-w-0 items-center gap-2', className)}>
      <span className="text-[12px] font-medium text-mute">{label}</span>
      <Menu
        label="Compte utilisé"
        value={String(current?.index ?? 0)}
        items={items}
        onSelect={onSelect}
        trigger={
          <button type="button" aria-label={`Changer de compte ${ACCOUNT_CHAIN_LABEL[family]}`} className="flex min-w-0 items-center gap-1.5 rounded-[10px] border border-line-2 bg-raised px-2.5 py-1 text-[13px] hover:border-ice-line">
            <span className="truncate font-semibold">{current?.name ?? 'Compte'}</span>
            {currentAddress && <span className="hidden truncate font-mono text-[11px] text-mute sm:inline">{shortAddress(currentAddress)}</span>}
            {busy ? <Spinner /> : <IconChevronDown size={13} className="shrink-0 text-mute" />}
          </button>
        }
      />
      {error && (
        <span role="alert" className="truncate text-[12px] text-down">
          {error}
        </span>
      )}
    </div>
  );
}

/** « Nouveau compte » as a visible button (Recevoir): creates, selects, and the screen shows its address. */
export function NewAccountButton({ family, className }: { family: AccountChain; className?: string }) {
  const { activeHw, vaultLists } = useApp();
  const create = useCreateAccounts();
  const next = useNextAccount(family);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (activeHw || !vaultLists) return null;
  return (
    <span className={cn('flex items-center gap-2', className)}>
      <Button
        size="sm"
        variant="ghost"
        disabled={next === null || busy}
        title={next === null ? `Limite de ${MAX_ACCOUNTS_PER_CHAIN} comptes atteinte` : `Crée « ${defaultAccountName(family, next)} » (issu de ta phrase de récupération) et affiche son adresse`}
        onClick={() => {
          setBusy(true);
          setError(null);
          create(family, 1, { select: true })
            .catch((e: unknown) => setError(e instanceof Error ? e.message : toIpcError(e).message))
            .finally(() => setBusy(false));
        }}
      >
        {busy ? <Spinner /> : <IconPlus size={14} />} Nouveau compte
      </Button>
      {error && (
        <span role="alert" className="text-[12px] text-down">
          {error}
        </span>
      )}
    </span>
  );
}
