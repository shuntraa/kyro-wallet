// SPDX-License-Identifier: GPL-3.0-or-later
// Envoyer: network choice for an asset held on several chains (USDT, USDC, ETH…), with the
// balance on each network, and the reminder that the recipient must receive on that network.

import type { AssetDef } from '@kyro/chains';
import { findChain } from '@kyro/chains';
import type { Network } from '@kyro/shared';
import { fmtCrypto } from '../lib/format';
import { Menu } from './ui/menu';
import { IconChevronDown } from './icons';
import { CoinIcon, HIDDEN } from './kit';
import { useT } from '../i18n';

export function NetworkPicker({ asset, siblings, network, balanceOf, hidden, onSelect }: { asset: AssetDef; siblings: readonly AssetDef[]; network: Network; balanceOf: (a: AssetDef) => bigint; hidden: boolean; onSelect: (id: string) => void }) {
  const { t } = useT();
  if (siblings.length < 2) return null;
  const chain = findChain(network, asset.chainKey);
  const bal = (a: AssetDef) => (hidden ? HIDDEN : fmtCrypto(balanceOf(a), a.decimals, a.symbol));
  return (
    <div className="flex flex-col gap-2">
      <span className="eyebrow">{t('multinet.network')}</span>
      <Menu
        value={asset.id}
        onSelect={onSelect}
        className="w-[520px]"
        label={t('multinet.pickNetwork', { symbol: asset.symbol })}
        items={siblings.map((a) => {
          const c = findChain(network, a.chainKey);
          return { value: a.id, label: c?.name ?? a.chainKey, hint: t('send.availableAmount', { amount: bal(a) }), icon: <CoinIcon glyph={c?.glyph ?? a.glyph} color={c?.color ?? a.color} size={26} /> };
        })}
        trigger={
          <button type="button" aria-label={t('multinet.networkAria', { symbol: asset.symbol, chain: chain?.name ?? asset.chainKey })} className="press flex h-[50px] items-center gap-3 rounded-box border border-line-2 bg-bg px-4 text-left hover:border-line-3 hover:bg-raised/50">
            <CoinIcon glyph={chain?.glyph ?? asset.glyph} color={chain?.color ?? asset.color} size={26} />
            <span className="flex flex-1 flex-col">
              <span className="text-[14px] font-medium">{t('multinet.onNetwork', { symbol: asset.symbol, chain: chain?.name ?? asset.chainKey })}</span>
              <span className="text-[12px] text-mute">{t('send.availableAmount', { amount: bal(asset) })} · {t('multinet.networksCount', { n: siblings.length })}</span>
            </span>
            <IconChevronDown size={16} className="text-mute" />
          </button>
        }
      />
      <span className="text-[12px] leading-[1.45] text-warn">{t('multinet.sameNetwork', { symbol: asset.symbol, chain: chain?.name ?? asset.chainKey })}</span>
    </div>
  );
}

/** « Cette adresse est une adresse TRON, pas Ethereum » under the recipient field. */
export function WrongNetworkLine({ asset, others, network }: { asset: AssetDef; others: readonly AssetDef[]; network: Network }) {
  const { t } = useT();
  if (others.length === 0) return null;
  const names = [...new Set(others.map((a) => findChain(network, a.chainKey)?.name ?? a.chainKey))];
  const list = names.length > 3 ? `${names.slice(0, 3).join(', ')}…` : names.join(', ');
  return <span className="text-[12px] text-down">{t('multinet.wrongNetwork', { networks: list, chain: findChain(network, asset.chainKey)?.name ?? asset.chainKey, symbol: asset.symbol })}</span>;
}
