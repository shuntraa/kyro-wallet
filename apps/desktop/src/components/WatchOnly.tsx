// SPDX-License-Identifier: GPL-3.0-or-later
// What a watch address shows where a wallet would act: no key, so Send, Swap and Earn stop here.

import { useMemo, useState, type FormEvent } from 'react';
import { isWatchable, isWatchXpub, watchFirstAddress, watchRefusal } from '@kyro/chains';
import { call, toIpcError, type AccountChain, type Network, type WatchAddress } from '@kyro/shared';
import { useApp } from '../state/app';
import { CONTACT_FAMILY_META, detectFamilies } from '../lib/contactDetect';
import type { ContactFamily } from '../lib/storage';
import { CoinIcon } from './coins/CoinIcon';
import { CopyButton, EmptyState } from './kit';
import { Button, Input, Label, Notice } from './ui/primitives';
import { useT } from '../i18n';

export type WatchBlocked = 'send' | 'swap' | 'staking' | 'receive';

/** First address of a watch entry (the entry itself for an address). */
export function watchShownAddress(w: WatchAddress, network: Network): string {
  try {
    return watchFirstAddress(w, network);
  } catch {
    return w.value;
  }
}

/** Full-screen state of an action a watch address cannot do. */
export function WatchOnlyScreen({ watch, what }: { watch: WatchAddress; what: WatchBlocked }) {
  const { network, navigate } = useApp();
  const { t } = useT();
  if (what === 'receive') {
    const address = watchShownAddress(watch, network);
    return (
      <div className="flex flex-1 items-center justify-center px-10">
        <EmptyState title={t('watch.receiveTitle', { name: watch.label })}>
          <span className="flex flex-col items-center gap-3">
            <span className="flex items-center gap-2">
              <span className="font-mono text-[13px] break-all text-text">{address}</span>
              <CopyButton text={address} />
            </span>
            <span>{t('watch.receiveBody')}</span>
            {isWatchXpub(watch.family, watch.value, network) && <span>{t('watch.xpubBody')}</span>}
          </span>
        </EmptyState>
      </div>
    );
  }
  const title = what === 'send' ? t('watch.blockedSend') : what === 'swap' ? t('watch.blockedSwap') : t('watch.blockedEarn');
  return (
    <div className="flex flex-1 items-center justify-center px-10">
      <EmptyState
        title={title}
        action={
          <button type="button" onClick={() => navigate({ name: 'settings', section: 'accounts' })} className="text-[13px] font-semibold text-ice hover:underline">
            {t('watch.title')}
          </button>
        }
      >
        {t('watch.blockedBody', { name: watch.label })}
      </EmptyState>
    </div>
  );
}

/** The add form: paste, the network is detected like in the address book, name it. */
export function WatchAddForm({ onAdded }: { onAdded: (w: WatchAddress) => void | Promise<void> }) {
  const { network } = useApp();
  const { t } = useT();
  const [value, setValue] = useState('');
  const [name, setName] = useState('');
  const [pick, setPick] = useState<AccountChain | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const a = value.trim();
  const refusal = a ? watchRefusal(a) : null;
  const candidates = useMemo(() => (refusal ? [] : detectFamilies(a, (f, x) => isWatchable(f as AccountChain, x, network))), [a, refusal, network]);
  const family: ContactFamily | undefined = pick && candidates.includes(pick as ContactFamily) ? (pick as ContactFamily) : candidates[0];
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!family || !name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await call('watch_address_add', { family: family as AccountChain, value: a, label: name.trim() });
      setValue('');
      setName('');
      setPick(null);
      await onAdded(saved);
    } catch (err) {
      setError(toIpcError(err).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-2.5">
      <Label htmlFor="watch-value">{t('watch.addressLabel')}</Label>
      <div className="flex items-center gap-2">
        <Input id="watch-value" value={value} onChange={(e) => setValue(e.target.value)} placeholder={t('watch.addressPlaceholder')} autoComplete="off" spellCheck={false} className="min-w-0 flex-1 font-mono text-[13px]" />
        {family && candidates.length === 1 && (
          <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-raised py-1 pr-2.5 pl-1 text-[12px] font-semibold">
            <CoinIcon symbol={CONTACT_FAMILY_META[family].symbol} size={20} />
            {CONTACT_FAMILY_META[family].label}
          </span>
        )}
        {family && candidates.length > 1 && (
          <select value={family} onChange={(e) => setPick(e.target.value as AccountChain)} aria-label={t('common.network')} className="h-[42px] shrink-0 rounded-ctl border border-line-3 bg-bg px-2 text-[13px]">
            {candidates.map((f) => (
              <option key={f} value={f}>
                {CONTACT_FAMILY_META[f].label}
              </option>
            ))}
          </select>
        )}
      </div>
      {refusal && <span className="text-[12px] text-down">{t(`watch.${refusal}`)}</span>}
      {a && !refusal && !family && <span className="text-[12px] text-down">{t('watch.invalid')}</span>}
      <Label htmlFor="watch-name">{t('watch.nameLabel')}</Label>
      <Input id="watch-name" value={name} maxLength={32} onChange={(e) => setName(e.target.value)} placeholder={t('watch.namePlaceholder')} />
      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex justify-end">
        <Button type="submit" variant="primary" disabled={!family || !name.trim() || busy}>
          {t('watch.add')}
        </Button>
      </div>
    </form>
  );
}
