// SPDX-License-Identifier: GPL-3.0-or-later
import { AssetListsCard, type ListTab } from '../components/AssetLists';
import { usePortfolio } from '../state/portfolio';
import { fmtAgo } from '../lib/format';
import { useNow } from '../lib/useAsync';

export function Assets({ initialTab }: { initialTab: ListTab }) {
  const pf = usePortfolio();
  const now = useNow(5000);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 px-7 pt-6 pb-5">
      <header className="flex items-end justify-between border-b border-line pb-4">
        <h1 className="screen-title">Actifs</h1>
        <span className="font-mono text-[11px] text-faint">{pf.marketUpdatedAt ? `CoinGecko · ${fmtAgo(pf.marketUpdatedAt, now)}` : 'CoinGecko'}</span>
      </header>
      <AssetListsCard initialTab={initialTab} className="min-h-0 flex-1" />
    </div>
  );
}
