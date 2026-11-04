// SPDX-License-Identifier: GPL-3.0-or-later
// History › Speed up / Cancel: the review of a replacement. The fee, the recipient and the amount
// shown here come from the transaction actually built; Rust checks it again against the original
// and shows the real figures in its native window.

import { useEffect, useState, type ReactNode } from 'react';
import { toIpcError, type ReplaceMode } from '@kyro/shared';
import { extraCost, findAsset, findChain, nativeAssetId, ReplaceRefused, unitsToNumber, type AnyAdapter, type BitcoinAdapter, type EvmAdapter, type LitecoinAdapter, type ReplacementPlan, type UtxoUnsigned } from '@kyro/chains';
import { useApp, useVault } from '../state/app';
import { usePortfolio } from '../state/portfolio';
import type { HistoryEntry } from '../state/history';
import { pickDevice, withDevice } from '../state/hw';
import { baseTxId, recordReplacement } from '../lib/replaced';
import { fmtCrypto, fmtFiat, shortAddress } from '../lib/format';
import { Dialog } from './ui/dialog';
import { Button, Notice, Spinner } from './ui/primitives';
import { PasswordField } from './kit';
import { DeviceBadge, HwErrorNotice, HwWaiting } from './hw';
import { useT } from '../i18n';

type Replacer = EvmAdapter | BitcoinAdapter | LitecoinAdapter;
/** The level chosen at review, kept for the check just before signing. */
type Level = { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | number;

const canPlan = (a: AnyAdapter): a is Replacer => a.family === 'evm' || a.family === 'btc' || a.family === 'ltc';

async function liveLevel(ad: Replacer): Promise<Level> {
  const p = (await ad.estimateFees()).options.fast.params;
  if (p.family === 'evm') return { maxFeePerGas: p.maxFeePerGas, maxPriorityFeePerGas: p.maxPriorityFeePerGas };
  if (p.family === 'btc') return p.satPerVb;
  throw new ReplaceRefused('unsupported');
}

function planWith(ad: Replacer, txid: string, mode: ReplaceMode, level: Level, network: Parameters<typeof findAsset>[0]): Promise<ReplacementPlan> {
  if (ad.family === 'evm') {
    const asset = findAsset(network, nativeAssetId(ad.chain));
    if (typeof level === 'number' || !asset) throw new ReplaceRefused('unsupported');
    return ad.planReplacement(txid, mode, level, asset);
  }
  if (typeof level !== 'number') throw new ReplaceRefused('unsupported');
  return ad.planReplacement(txid, mode, level);
}

async function sign(ad: Replacer, plan: ReplacementPlan, auth: { password: string } | { deviceId: string }): Promise<string> {
  if (plan.family === 'evm' && ad.family === 'evm') {
    const signed = 'deviceId' in auth ? await ad.signTxHw(plan.unsigned, auth.deviceId, plan.replaces) : await ad.signTx(plan.unsigned, auth.password, plan.replaces);
    return ad.broadcast(signed);
  }
  if (plan.family === 'utxo' && ad.family === 'btc') {
    const signed = 'deviceId' in auth ? await ad.signTxHw(plan.unsigned, auth.deviceId, plan.replaces) : await ad.signTx(plan.unsigned, auth.password, plan.replaces);
    return ad.broadcast(signed);
  }
  if (plan.family === 'utxo' && ad.family === 'ltc') {
    const unsigned = { ...plan.unsigned, dustFolded: 0n } satisfies UtxoUnsigned;
    const signed = 'deviceId' in auth ? await ad.signTxHw(unsigned, auth.deviceId, plan.replaces) : await ad.signTx(unsigned, auth.password, plan.replaces);
    return ad.broadcast(signed);
  }
  throw new ReplaceRefused('unsupported');
}

function Row({ k, children, strong }: { k: string; children: ReactNode; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <dt className="text-[13px] text-mute">{k}</dt>
      <dd className={strong ? 'm-0 text-right text-[14px] font-semibold' : 'm-0 text-right text-[13.5px]'}>{children}</dd>
    </div>
  );
}

interface Ready {
  ad: Replacer;
  plan: ReplacementPlan;
  level: Level;
}

export function ReplaceDialog({ entry, mode, onClose }: { entry: HistoryEntry; mode: ReplaceMode; onClose: (done: boolean) => void }) {
  const { network, settings } = useApp();
  const { accountSources, activeHw } = useVault();
  const pf = usePortfolio();
  const { t } = useT();
  const [ready, setReady] = useState<Ready | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [wrongPw, setWrongPw] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hwError, setHwError] = useState<unknown>(null);
  const [hwDevice, setHwDevice] = useState<string | null>(null);

  const txid = baseTxId(entry.id);
  const cancel = mode === 'cancel';
  const chain = findChain(network, entry.chainKey);
  const feeAsset = chain ? findAsset(network, nativeAssetId(chain)) : undefined;
  const cur = settings.currency;

  useEffect(() => {
    let alive = true;
    const account = /@(\d+)$/.exec(entry.id)?.[1];
    const adapters = accountSources
      .filter((s) => account === undefined || s.index === Number(account))
      .flatMap((s) => s.adapters)
      .filter((a) => a.chain.key === entry.chainKey)
      .filter(canPlan);
    void (async () => {
      let last: unknown = new ReplaceRefused('unsupported');
      for (const ad of adapters) {
        try {
          const level = await liveLevel(ad);
          const plan = await planWith(ad, txid, mode, level, network);
          if (alive) setReady({ ad, plan, level });
          return;
        } catch (e) {
          last = e;
          if (!(e instanceof ReplaceRefused && e.reason === 'notOurs')) break;
        }
      }
      if (alive) setRefusal(last instanceof Error ? last.message : toIpcError(last).message);
    })();
    return () => {
      alive = false;
    };
  }, [entry.id, entry.chainKey, mode, txid, network, accountSources]);

  const money = (v: bigint): string => {
    if (!feeAsset) return v.toString();
    const price = pf.price(feeAsset.coingeckoId)?.price ?? null;
    const fiat = price !== null ? ` · ${fmtFiat(unitsToNumber(v, feeAsset.decimals) * price, cur)}` : '';
    return `${fmtCrypto(v, feeAsset.decimals, feeAsset.symbol, feeAsset.decimals > 8 ? 8 : feeAsset.decimals)}${fiat}`;
  };

  const go = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    setHwError(null);
    try {
      // Read the network again: a transaction confirmed during the review is refused here.
      const fresh = await planWith(ready.ad, txid, mode, ready.level, network);
      if (fresh.newFee !== ready.plan.newFee) {
        setReady({ ...ready, plan: fresh });
        setError(t('history.replaceChanged'));
        return;
      }
      let id: string;
      if (activeHw) {
        const device = await pickDevice(activeHw.device);
        setHwDevice(device.id);
        id = await withDevice(device.id, () => sign(ready.ad, fresh, { deviceId: device.id }));
      } else {
        id = await sign(ready.ad, fresh, { password });
      }
      recordReplacement({ ...entry, network }, id, { cancel, fee: fresh.newFee, label: t('history.cancelLabel') });
      onClose(true);
    } catch (e) {
      const err = toIpcError(e);
      if (activeHw && (err.code.startsWith('HW_') || err.code === 'USER_REJECTED')) setHwError(e);
      else if (err.code === 'WRONG_PASSWORD') setWrongPw((n) => n + 1);
      else setError(err.code === 'USER_REJECTED' ? t('history.signatureCancelled') : e instanceof ReplaceRefused ? e.message : err.message);
    } finally {
      setBusy(false);
      setHwDevice(null);
    }
  };

  const plan = ready?.plan;
  const evm = plan?.family === 'evm';
  const asset = entry.asset;
  return (
    <Dialog open onOpenChange={() => !busy && onClose(false)} title={t(cancel ? 'history.cancelTitle' : 'history.speedUpTitle')}>
      <p className="m-0 text-[13px] leading-[1.55] text-text2">{t(cancel ? 'history.cancelExplain' : 'history.speedUpExplain')}</p>
      {!plan && !refusal && (
        <p role="status" className="m-0 flex items-center gap-2 text-[13px] text-mute">
          <Spinner className="size-3" />
          {t('history.replaceChecking')}
        </p>
      )}
      {refusal && <Notice tone="error">{refusal}</Notice>}
      {plan && (
        <>
          <dl className="m-0 flex flex-col divide-y divide-line rounded-box border border-line bg-bg px-4 py-1">
            {cancel ? (
              <Row k={t('history.replaceBackTo')}>{shortAddress(plan.recipient)}</Row>
            ) : (
              <>
                <Row k={t('history.replaceTo')}>{shortAddress(entry.counterparty ?? plan.recipient)}</Row>
                {asset && <Row k={t('history.replaceAmount')}>{fmtCrypto(entry.amount, asset.decimals, asset.symbol)}</Row>}
              </>
            )}
            <Row k={t(evm ? 'history.replaceOldMax' : 'history.replaceOldFee')}>{money(plan.oldFee)}</Row>
            <Row k={t(evm ? 'history.replaceNewMax' : 'history.replaceNewFee')}>{money(plan.newFee)}</Row>
            <Row k={t('history.replaceExtra')} strong>
              {money(extraCost(plan))}
            </Row>
          </dl>
          {evm && <span className="text-[12px] text-mute">{t('history.replaceMaxNote')}</span>}
          {cancel && <Notice tone="warn">{t('history.cancelWarn')}</Notice>}
          {activeHw ? (
            <div className="flex items-center gap-2 rounded-ctl border border-line bg-bg px-3.5 py-2.5 text-[12px] text-mute">
              <DeviceBadge device={activeHw.device} model={activeHw.model} />
              <span>{t('send.hwNoPassword')}</span>
            </div>
          ) : (
            <PasswordField id="replace-pw" value={password} onChange={setPassword} autoFocus wrong={wrongPw} onEnter={() => password && !busy && void go()} />
          )}
          {busy && activeHw && hwDevice && <HwWaiting deviceId={hwDevice} idle={t('send.hwChecking')} confirm={{ title: t('send.hwConfirmTitle'), detail: t('send.hwConfirmDetail') }} />}
          {hwError !== null && <HwErrorNotice error={hwError} onRetry={() => void go()} />}
        </>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex justify-end gap-2">
        <Button onClick={() => onClose(false)} disabled={busy}>
          {t('history.replaceKeep')}
        </Button>
        {plan && (
          <Button variant={cancel ? 'danger' : 'primary'} disabled={busy || (!activeHw && !password)} onClick={() => void go()}>
            {busy && <Spinner />} {t(cancel ? 'history.cancelConfirm' : 'history.speedUpConfirm')}
          </Button>
        )}
      </div>
    </Dialog>
  );
}
