// SPDX-License-Identifier: GPL-3.0-or-later
import { AssetListsCard, type ListTab } from '../components/AssetLists';
import { usePortfolio } from '../state/portfolio';
import { fmtAgo } from '../lib/format';
import { useNow } from '../lib/useAsync';

export function Assets({ initialTab }: { initialTab: ListTab }) {
  const pf = usePortfolio();
  const now = useNow(5000);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 px-[26px] py-[22px]">
      <header className="flex items-end justify-between">
        <h1 className="m-0 text-[28px] font-semibold tracking-[-0.03em]">Actifs</h1>
        <span className="text-[12px] text-faint">{pf.marketUpdatedAt ? `CoinGecko · ${fmtAgo(pf.marketUpdatedAt, now)}` : 'CoinGecko'}</span>
      </header>
      <AssetListsCard initialTab={initialTab} className="min-h-0 flex-1" />
    </div>
  );
}
