// SPDX-License-Identifier: GPL-3.0-or-later
import { AssetListsCard, type ListTab } from '../components/AssetLists';
import { DISPLAY } from '../components/kyro';
import { useApp } from '../state/app';
import { useT } from '../i18n';

export function Assets({ initialTab }: { initialTab: ListTab }) {
  const { t } = useT();
  const { navigate, activeWatch, activeHw } = useApp();
  return (
    <div className="min-h-0 flex-1 overflow-y-auto scroll-thin">
      <div className="mx-auto mt-7 w-full max-w-[1184px] px-8 pb-10">
        <AssetListsCard
          initialTab={initialTab}
          layout="tiles"
          title={
            <h1 className="m-0 text-[22px] leading-none font-normal" style={{ ...DISPLAY, fontWeight: 400, letterSpacing: '-0.03em' }}>
              {t('shell.assets')}
            </h1>
          }
          extra={
            !activeWatch && !activeHw ? (
              <button type="button" className="press h-9 px-2 text-[12.5px] text-faint hover:text-text" onClick={() => navigate({ name: 'tidy' })}>
                {t('tidy.title')}
              </button>
            ) : undefined
          }
        />
      </div>
    </div>
  );
}
