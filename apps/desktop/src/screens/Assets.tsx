// SPDX-License-Identifier: GPL-3.0-or-later
import { AssetListsCard, type ListTab } from '../components/AssetLists';
import { useT } from '../i18n';

export function Assets({ initialTab }: { initialTab: ListTab }) {
  const { t } = useT();
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 px-8 pt-7 pb-6">
      <header className="flex items-end justify-between">
        <h1 className="screen-title">{t('shell.assets')}</h1>
      </header>
      <AssetListsCard initialTab={initialTab} className="min-h-0 flex-1" />
    </div>
  );
}
