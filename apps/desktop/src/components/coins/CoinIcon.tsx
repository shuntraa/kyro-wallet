// SPDX-License-Identifier: GPL-3.0-or-later
// Coin icon: Kyro's own drawn mark when the asset has one, otherwise a lit monogram disc.

import { createElement, useId, useMemo, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { MARKS, iconTree, monogram, resolveMark, tickerColor, type El, type IconSpec, type MarkKey } from './marks';

const camel = (k: string) => k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

function toReact(el: El, key?: number): ReactNode {
  const props: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(el.a)) props[camel(k)] = v;
  const children: ReactNode[] = [];
  if (el.text !== undefined) children.push(el.text);
  (el.c ?? []).forEach((c, i) => children.push(toReact(c, i)));
  return createElement(el.t, key === undefined ? props : { ...props, key }, ...children);
}

function Disc({ spec, size, uid }: { spec: IconSpec; size: number; uid: string }) {
  const tree = useMemo(() => iconTree(spec, uid), [spec, uid]);
  return toReact({ ...tree, a: { ...tree.a, width: size, height: size, focusable: 'false' } });
}

interface Query {
  id?: string | undefined;
  symbol?: string | undefined;
  glyph?: string | undefined;
  color?: string | undefined;
  fg?: string | undefined;
}

function specFor(q: Query, size: number): { spec: IconSpec; key: MarkKey | undefined } {
  const key = resolveMark(q);
  if (key) return { key, spec: { mark: MARKS[key], color: MARKS[key].color } };
  const text = q.symbol ?? q.glyph ?? '?';
  return { key, spec: { label: monogram(text, size), color: q.color ?? tickerColor(text), ink: q.fg } };
}

/** The registry fields CoinIcon reads from an asset. */
export interface CoinIconAsset {
  id: string;
  symbol: string;
  chainKey?: string | undefined;
  glyph?: string | undefined;
  color?: string | undefined;
}

export interface CoinIconProps {
  glyph?: string | undefined;
  color?: string | undefined;
  size?: number;
  fg?: string | undefined;
  className?: string | undefined;
  /** Corner badge: a chain key (`arbitrum`, `tron`…) or the legacy glyph + colour pair. */
  badge?: { glyph: string; color: string } | string | undefined;
  /** Ticker (`BTC`, `USDC`…): main lookup key. */
  symbol?: string | undefined;
  /** Asset id (`btc`, `eth:42161`, `cg:bitcoin`), CoinGecko id or chain key. */
  id?: string | undefined;
  chain?: string | undefined;
  asset?: CoinIconAsset | undefined;
}

/** Coin disc with a gradient, light and Kyro's own mark (or a monogram), plus an optional chain badge. */
export function CoinIcon({ asset, glyph = asset?.glyph, color = asset?.color, size = 34, fg, className, badge, symbol = asset?.symbol, id = asset?.id, chain = asset?.chainKey }: CoinIconProps) {
  const uid = 'ci' + useId().replace(/[^a-zA-Z0-9]/g, '');
  const main = useMemo(() => specFor({ id, symbol, glyph, color, fg }, size), [id, symbol, glyph, color, fg, size]);
  const badgeSize = Math.max(10, Math.round(size * 0.42));
  const badgeSpec = useMemo((): IconSpec | null => {
    if (badge && typeof badge === 'object') return specFor({ glyph: badge.glyph, color: badge.color }, badgeSize).spec;
    const key = typeof badge === 'string' ? badge : chain;
    if (!key) return null;
    const chainMark = resolveMark({ id: key });
    if (typeof badge !== 'string' && (chainMark ? chainMark === main.key : main.key === undefined)) return null;
    return chainMark ? { mark: MARKS[chainMark], color: MARKS[chainMark].color } : { label: key.slice(0, 1).toUpperCase(), color: tickerColor(key) };
  }, [badge, chain, main.key, badgeSize]);

  return (
    <span className={cn('relative inline-flex shrink-0', className)} style={{ width: size, height: size }} aria-hidden="true">
      <Disc spec={main.spec} size={size} uid={uid} />
      {badgeSpec && (
        <span className="absolute -right-1 -bottom-1 inline-flex rounded-full border-2 border-card bg-card">
          <Disc spec={badgeSpec} size={badgeSize} uid={`${uid}b`} />
        </span>
      )}
    </span>
  );
}
