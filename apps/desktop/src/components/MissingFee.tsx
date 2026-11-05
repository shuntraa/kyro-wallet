// SPDX-License-Identifier: GPL-3.0-or-later
// A token's network fee is paid in the chain's native coin. When that coin is short, this offers to
// get some through a swap from another chain, on the normal Swap screen (nothing is signed from
// here), or shows the chain's address when nothing held can do it.

import { useCallback, useMemo, useState } from 'react';
import { allChains, assetsFor, findChain, type AssetDef, type Chain, type FeeEstimates } from '@kyro/chains';
import { fetchQuotes } from '@kyro/swap';
import { useApp, useVault, type Route } from '../state/app';
import { usePortfolio } from '../state/portfolio';
import { depositAdapterFor, ownAddressOn, swapQuoteParams, usdRate } from '../lib/crossSwap';
import { fmtCrypto, fmtFiat, toInputDecimal } from '../lib/format';
import { missingFee, pickTopUpRoute, swapFeeOn, topUpSources, type TopUpProbe, type TopUpSource } from '../lib/topUp';
import { useAsync } from '../lib/useAsync';
import { useT } from '../i18n';
import { CopyButton } from './kit';
import { Menu } from './ui/menu';
import { Button, Notice, Spinner } from './ui/primitives';
import { IconChevronDown } from './icons';

/** Slippage of the quote checked here; the Swap screen keeps its own setting. */
const PROBE_SLIPPAGE_BPS = 50;
/** Only these chains have a fee level worth reading: elsewhere the usual cost is close enough. */
const LIVE_FEES = new Set<AssetDef['family']>(['evm', 'btc', 'ltc', 'doge', 'bch', 'dash']);

const nativeOn = (assets: AssetDef[], chainKey: string) => assets.find((a) => a.chainKey === chainKey && a.kind === 'native');

/** Cost of a swap of an asset on its chain, in that chain's native coin (`plain`: a simple transfer). */
export type FeeOf = (asset: AssetDef, plain?: boolean) => bigint | null;

/** Fee levels of `chainKeys`, read once. A chain that does not answer falls back on its usual cost. */
export function useFeeOf(chainKeys: string[]): { feeOf: FeeOf; ready: boolean } {
  const { adapters, network } = useVault();
  const pf = usePortfolio();
  const assets = useMemo(() => assetsFor(network), [network]);
  const levels = useAsync(
    chainKeys.length > 0
      ? async () => {
          const out = new Map<string, FeeEstimates>();
          await Promise.all(
            chainKeys.map(async (k) => {
              const native = nativeOn(assets, k);
              if (!native || !LIVE_FEES.has(native.family)) return;
              const est = await depositAdapterFor(native, adapters)?.estimateFees().catch(() => undefined);
              if (est) out.set(k, est);
            }),
          );
          return out;
        }
      : null,
    [[...chainKeys].sort().join()],
  );
  const feeOf = useCallback<FeeOf>(
    (asset, plain = false) => {
      const native = nativeOn(assets, asset.chainKey);
      return native ? swapFeeOn(native, { token: asset.kind !== 'native', plain, estimates: levels.data?.get(asset.chainKey), nativePrice: pf.price(native.coingeckoId)?.price }) : null;
    },
    [assets, levels.data, pf],
  );
  return { feeOf, ready: !levels.loading };
}

/** Cost of one swap of `asset`, for screens about to spend it. */
export function useSwapFee(asset: AssetDef | undefined, plain = false): bigint | null {
  const { feeOf } = useFeeOf(asset ? [asset.chainKey] : []);
  return asset ? feeOf(asset, plain) : null;
}

/** Shown only while `need` is more than the native coin held on `chainKey`, once balances are known. */
export function MissingFee({ chainKey, need, returnTo }: { chainKey: string; need: bigint; returnTo?: Route }) {
  const { network } = useApp();
  const pf = usePortfolio();
  const native = nativeOn(assetsFor(network), chainKey);
  const chain = findChain(network, chainKey);
  if (!native || !chain || !pf.balancesLoaded || pf.chainErrors[chainKey]) return null;
  const missing = missingFee(need, pf.balances.get(native.id) ?? 0n);
  if (missing <= 0n) return null;
  return <Offer native={native} chain={chain} missing={missing} {...(returnTo ? { returnTo } : {})} />;
}

function Offer({ native, chain, missing, returnTo }: { native: AssetDef; chain: Chain; missing: bigint; returnTo?: Route }) {
  const { t } = useT();
  const { navigate, network, swapProviders, settings, activeHw } = useApp();
  const { accounts } = useVault();
  const pf = usePortfolio();
  const assets = useMemo(() => assetsFor(network), [network]);
  const chains = useMemo(() => allChains(network), [network]);
  const heldChains = useMemo(() => [...new Set(assets.filter((a) => (pf.balances.get(a.id) ?? 0n) > 0n).map((a) => a.chainKey))], [assets, pf.balances]);
  const { feeOf, ready } = useFeeOf(heldChains);
  const usdToFiat = usdRate(settings.currency, pf.price('usd-coin')?.price ?? pf.price('tether')?.price);
  const priceOf = useCallback((a: AssetDef) => pf.price(a.coingeckoId)?.price ?? null, [pf]);

  const recipient = ownAddressOn(accounts, chain);
  // Swaps sign through the vault only: a hardware wallet gets the address.
  const sources = useMemo(
    () =>
      activeHw || !recipient
        ? []
        : topUpSources({ network, chains, assets, target: native, missing, balanceOf: (id) => pf.balances.get(id) ?? 0n, priceOf, feeOf, canUse: (c) => !!ownAddressOn(accounts, c), usdToFiat }),
    [activeHw, recipient, network, chains, assets, native, missing, pf.balances, priceOf, feeOf, accounts, usdToFiat],
  );
  const [pickedId, setPickedId] = useState<string | null>(null);
  const picked = sources.find((s) => s.asset.id === pickedId);
  const shown = picked ?? sources[0];
  const [checking, setChecking] = useState(false);
  const [refused, setRefused] = useState<string[]>([]);

  const probe: TopUpProbe = (s, sellAmount) => {
    const params = swapQuoteParams({ sell: s.asset, buy: native, sellChain: s.chain, buyChain: chain, sellAmount, taker: ownAddressOn(accounts, s.chain), recipient, slippageBps: PROBE_SLIPPAGE_BPS, usdToFiat, sellPrice: priceOf(s.asset) ?? undefined, buyPrice: priceOf(native) ?? undefined, nativePrice: priceOf(nativeOn(assets, s.chain.key) ?? s.asset) ?? undefined });
    return params ? fetchQuotes(swapProviders, params) : Promise.resolve({ quotes: [], results: [] });
  };

  const go = async () => {
    setChecking(true);
    const tried: TopUpSource[] = picked ? [picked] : sources.filter((s) => !refused.includes(s.asset.id));
    const route = await pickTopUpRoute(tried, missing, probe);
    setChecking(false);
    if (!route) {
      setRefused((r) => [...r, ...tried.map((s) => s.asset.id)]);
      setPickedId(null);
      return;
    }
    navigate({ name: 'swap', sellAssetId: route.source.asset.id, buyAssetId: native.id, amount: toInputDecimal(route.sellAmount, route.source.asset.decimals), ...(returnTo ? { returnTo } : {}) });
  };

  const short = t('topup.short', { symbol: native.symbol, missing: fmtCrypto(missing, native.decimals, native.symbol, 6) });
  const usable = sources.filter((s) => !refused.includes(s.asset.id));
  if (!ready && sources.length === 0) return <Notice tone="warn">{short}</Notice>;
  if (usable.length === 0 || !shown) {
    return (
      <Notice tone="warn">
        <div className="flex flex-col gap-2">
          <span>{short}</span>
          <span>{t('topup.noSource', { symbol: native.symbol, chain: chain.label })}</span>
          {recipient && (
            <span className="flex items-center gap-2">
              <span className="min-w-0 flex-1 font-mono text-[12px] break-all text-text">{recipient}</span>
              <CopyButton text={recipient} />
            </span>
          )}
          <button type="button" className="self-start font-semibold underline" onClick={() => navigate({ name: 'receive', family: native.family })}>
            {t('topup.openReceive')}
          </button>
        </div>
      </Notice>
    );
  }
  return (
    <Notice tone="warn">
      <div className="flex flex-col gap-2">
        <span>{short}</span>
        {refused.length > 0 && <span>{t('topup.noQuoteSource')}</span>}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-2">
            <span className="text-text">{t('topup.from', { source: shown.asset.symbol, chain: shown.chain.label, fiat: fmtFiat(shown.sellFiat, settings.currency) })}</span>
            {usable.length > 1 && (
              <Menu
                label={t('topup.changeLabel')}
                value={shown.asset.id}
                onSelect={setPickedId}
                items={usable.map((s) => ({ value: s.asset.id, label: `${s.asset.symbol} · ${s.chain.label}`, hint: fmtFiat(s.sellFiat, settings.currency) }))}
                trigger={
                  <button type="button" className="flex items-center gap-1 font-semibold underline">
                    {t('topup.change')} <IconChevronDown size={12} />
                  </button>
                }
              />
            )}
          </span>
          <Button variant="primary" disabled={checking} onClick={() => void go()}>
            {checking ? <Spinner /> : null} {checking ? t('topup.checking') : t('topup.get', { symbol: native.symbol })}
          </Button>
        </div>
      </div>
    </Notice>
  );
}

/** On the Swap screen, when the coin is for something else: the way back, kept in the route. */
export function BackLine({ returnTo, symbol, state }: { returnTo: Route; symbol: string; state: 'before' | 'waiting' | 'arrived' }) {
  const { t } = useT();
  const { navigate } = useApp();
  const back = (
    <button type="button" className="font-semibold underline" onClick={() => navigate(returnTo)}>
      {returnTo.name === 'send' ? t('topup.backToSend') : t('topup.back')}
    </button>
  );
  if (state === 'before') return <span className="text-[13px] text-mute">{back}</span>;
  return (
    <Notice tone={state === 'arrived' ? 'success' : 'info'}>
      <span className="flex flex-wrap items-center gap-2">
        {state === 'waiting' && <Spinner />}
        {state === 'arrived' ? t('topup.arrived', { symbol }) : t('topup.waiting', { symbol })} {back}
      </span>
    </Notice>
  );
}
