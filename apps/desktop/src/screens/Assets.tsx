// SPDX-License-Identifier: GPL-3.0-or-later
import { AssetListsCard, type ListTab } from '../components/AssetLists';
import { Button } from '../components/ui/primitives';
import { useApp } from '../state/app';
import { useT } from '../i18n';

export function Assets({ initialTab }: { initialTab: ListTab }) {
  const { t } = useT();
  const { navigate, activeWatch, activeHw } = useApp();
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 px-8 pt-7 pb-6">
      <header className="flex items-end justify-between">
        <h1 className="screen-title">{t('shell.assets')}</h1>
        {!activeWatch && !activeHw && <Button onClick={() => navigate({ name: 'tidy' })}>{t('tidy.title')}</Button>}
      </header>
      <AssetListsCard initialTab={initialTab} className="min-h-0 flex-1" />
    </div>
  );
}
