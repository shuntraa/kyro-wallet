// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useMemo, useState } from 'react';
import { BTC_TXS_CAP, toIpcError, type ReplaceMode } from '@kyro/shared';
import { assetsFor, canReplace, findAsset, findChain, unitsToNumber } from '@kyro/chains';
import { buildRevoke, isUnlimitedAllowance } from '@kyro/swap';
import { useApp, useVault } from '../state/app';
import { usePortfolio } from '../state/portfolio';
import { unreachable, useHistory, type HistoryEntry } from '../state/history';
import { useOnTorReady } from '../state/tor';
import { useOnCbfSynced } from '../state/cbf';
import { cn } from '../lib/cn';
import { fmtCrypto, fmtDate, fmtDayGroup, fmtFiat, fmtMonth, shortAddress } from '../lib/format';
import { addLocalTx, getApprovals, removeApproval, type ApprovalRecord } from '../lib/storage';
import { downloadText, toCsv } from '../lib/csv';
import { useAsync } from '../lib/useAsync';
import { EmptyState, ErrorLine, PasswordField } from '../components/kit';
import { TronNoHistoryLine, tronNoHistory } from '../components/ServerDown';
import { HistoryRow, LoadingLine, entryTitle } from '../components/HistoryRow';
import { ReplaceDialog } from '../components/ReplaceTx';
import { Dialog } from '../components/ui/dialog';
import { Badge, Button, Notice, Segmented, Skeleton, Spinner } from '../components/ui/primitives';
import { IconImport } from '../components/icons';
import { idx } from '../components/motion';
import { getLanguage, useT } from '../i18n';
import { rt } from '../i18n/rich';

function csvAmount(s: string): string {
  return getLanguage() === 'fr' ? s.replace(/\u202f/g, '') : s.replace(/,/g, '');
}

type Filter = 'all' | 'out' | 'in' | 'swap' | 'approval';

function matches(e: HistoryEntry, f: Filter): boolean {
  if (f === 'all') return true;
  if (f === 'swap') return e.kind === 'swap';
  if (f === 'approval') return e.kind === 'approval';
  if (e.kind !== 'transfer') return false;
  return f === 'in' ? e.direction === 'in' : e.direction !== 'in';
}

export function History() {
  const { settings, hideBalances, network } = useApp();
  const { activeWatch } = useVault();
  const pf = usePortfolio();
  const history = useHistory();
  const [replacing, setReplacing] = useState<{ entry: HistoryEntry; mode: ReplaceMode } | null>(null);
  useOnTorReady(history.reload);
  useOnCbfSynced(history.reload);
  const [filter, setFilter] = useState<Filter>('all');
  const { t, tp, lang } = useT();
  const cur = settings.currency;
  const priceOf = (e: HistoryEntry) => (e.asset ? pf.price(e.asset.coingeckoId)?.price ?? null : null);

  // A lone « Loading… » only for the first seconds; then what is there, with a small « Updating… ».
  const [grace, setGrace] = useState(true);
  useEffect(() => {
    const id = window.setTimeout(() => setGrace(false), 3000);
    return () => window.clearTimeout(id);
  }, []);
  const down = history.data ? unreachable(history.data, tronNoHistory) : null;
  const entries = useMemo(() => (history.data?.entries ?? []).filter((e) => matches(e, filter)), [history.data, filter]);
  const groups = useMemo(() => {
    const out: Array<{ label: string; items: HistoryEntry[] }> = [];
    for (const e of entries) {
      const label = e.time ? fmtDayGroup(e.time) : t('history.inProgress');
      const g = out[out.length - 1];
      if (g && g.label === label) g.items.push(e);
      else out.push({ label, items: [e] });
    }
    return out;
  }, [entries, lang]);

  const month = useMemo(() => {
    const start = new Date();
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
    let received = 0;
    let sent = 0;
    let fees = 0;
    for (const e of history.data?.entries ?? []) {
      if (!e.time || e.time < start.getTime() || !e.asset) continue;
      const p = pf.price(e.asset.coingeckoId)?.price ?? 0;
      const v = unitsToNumber(e.amount, e.asset.decimals) * p;
      if (e.kind === 'transfer' && e.direction === 'in') received += v;
      if (e.kind === 'transfer' && e.direction === 'out') sent += v;
      if (e.fee && e.feeAsset && e.direction !== 'in') fees += unitsToNumber(e.fee, e.feeAsset.decimals) * (pf.price(e.feeAsset.coingeckoId)?.price ?? 0);
    }
    return { received, sent, fees, label: fmtMonth(Date.now()) };
  }, [history.data, pf, lang]);

  const exportCsv = () => {
    const rows: Array<Array<string | number>> = [[t('history.csvDate'), t('history.csvNetwork'), t('history.csvType'), t('history.csvDirection'), t('history.csvAsset'), t('history.csvAmount'), t('history.csvFee'), t('history.csvCounterparty'), t('history.csvStatus'), t('history.csvId')]];
    for (const e of history.data?.entries ?? []) {
      rows.push([
        e.time ? new Date(e.time).toISOString() : '',
        e.chainLabel,
        e.kind,
        e.direction,
        e.asset?.symbol ?? e.assetId,
        e.asset ? csvAmount(fmtCrypto(e.amount, e.asset.decimals, undefined, e.asset.decimals)) : e.amount.toString(),
        e.fee && e.feeAsset ? csvAmount(fmtCrypto(e.fee, e.feeAsset.decimals, undefined, e.feeAsset.decimals)) + ' ' + e.feeAsset.symbol : '',
        e.counterparty ?? '',
        e.status,
        e.id,
      ]);
    }
    downloadText(t('history.csvFileName', { network, date: new Date().toISOString().slice(0, 10) }), toCsv(rows));
  };

  const pending = (history.data?.entries ?? []).filter((e) => e.status === 'pending').length;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 px-8 pt-7 pb-6">
      <header className="flex items-center justify-between gap-4 border-b border-line pb-4">
        <h1 className="screen-title">{t('common.history')}</h1>
        <div className="flex items-center gap-2.5">
          <Segmented<Filter>
            label={t('history.filter')}
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: t('history.filterAll') },
              { value: 'out', label: t('history.filterOut') },
              { value: 'in', label: t('history.filterIn') },
              { value: 'swap', label: t('history.filterSwaps') },
              { value: 'approval', label: t('history.filterApprovals') },
            ]}
          />
          <Button variant="outline" size="lg" onClick={exportCsv} disabled={!history.data?.entries.length}>
            <IconImport size={15} /> {t('history.exportCsv')}
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 gap-5">
        <section className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-panel border border-line bg-card">
          <div key={`${filter}:${history.data ? 'data' : 'loading'}`} className="min-h-0 flex-1 overflow-y-auto pb-2 scroll-thin">
            {history.loading && !(grace && groups.length === 0) && (
              <p role="status" className="m-0 flex items-center gap-2 px-5 pt-3 text-[12px] text-faint">
                <Spinner className="size-3" />
                {t('history.updating')}
              </p>
            )}
            {history.loading && grace && groups.length === 0 ? (
              <LoadingLine />
            ) : groups.length === 0 ? (
              <EmptyState title={t('history.noTransactions')}>
                {history.loading && history.data ? t('history.checking', { done: history.data.known.length, total: history.data.chains.length }) : filter === 'all' ? t('history.noTransactionsHint') : t('history.nothingForFilter')}
              </EmptyState>
            ) : (
              groups.map((g, gi) => (
                <div key={g.label} className="stagger">
                  <div className="eyebrow sticky top-0 z-10 flex items-center gap-3 bg-card/95 px-5 pt-4 pb-2 backdrop-blur-[2px]" style={idx(gi * 3)}>
                    {g.label}
                    <span className="h-px flex-1 bg-line" />
                    <span className="text-faint">{g.items.length}</span>
                  </div>
                  {g.items.map((e, i) => (
                    <HistoryRow
                      key={e.id}
                      i={gi * 3 + i + 1}
                      e={e}
                      price={priceOf(e)}
                      currency={cur}
                      hidden={hideBalances}
                      action={
                        !activeWatch && canReplace(e, e.asset?.family) ? (
                          <>
                            <Button size="sm" onClick={() => setReplacing({ entry: e, mode: 'speedUp' })}>
                              {t('history.speedUp')}
                            </Button>
                            <Button size="sm" variant="outline" onClick={() => setReplacing({ entry: e, mode: 'cancel' })}>
                              {t('history.cancelTx')}
                            </Button>
                          </>
                        ) : undefined
                      }
                    />
                  ))}
                </div>
              ))
            )}
            {history.data && Object.entries(history.data.errors).some(([, v]) => tronNoHistory(v)) && <TronNoHistoryLine className="px-5 py-3" />}
            {down && down.keys.length > 0 && (
              down.all ? (
                <ErrorLine className="px-5 py-3" onRetry={history.reload} error={Object.values(history.data?.errors ?? {}).join(' ')}>
                  {t('history.partial')}
                </ErrorLine>
              ) : (
                <p role="status" className="m-0 px-[22px] pt-3 text-[12px] leading-[1.5] text-faint">
                  {t('history.unreachable', { networks: down.keys.map((k) => findChain(network, k)?.label ?? k).join(', ') })}
                  {' · '}
                  <button type="button" onClick={history.reload} className="text-mute underline-offset-2 hover:text-text hover:underline">
                    {t('history.retry')}
                  </button>
                </p>
              )
            )}
            {history.data?.dotHistory === 'unavailable' && <p className="m-0 px-[22px] pt-3 text-[12px] leading-[1.5] text-mute">{t('history.dotUnavailable')}</p>}
            {history.data?.dotHistory === 'partial' && <p className="m-0 px-[22px] pt-3 text-[12px] leading-[1.5] text-mute">{t('history.dotPartial')}</p>}
            {history.data?.btcCapped && (
              <p className="m-0 px-[22px] pt-3 text-[12px] leading-[1.5] text-mute">
                {t('history.btcCapped', { cap: BTC_TXS_CAP })}
              </p>
            )}
            <p className="m-0 px-[22px] py-3 text-[12px] leading-[1.5] text-faint">{t('history.ethNote')}</p>
          </div>
        </section>

        <div className="rise flex w-[380px] shrink-0 flex-col gap-4" style={idx(1)}>
          <section className="flex flex-col gap-3.5 rounded-panel border border-line bg-card px-[22px] py-[18px]">
            <span className="eyebrow">{month.label}</span>
            <div className="grid grid-cols-3 divide-x divide-line border-y border-line">
              <MonthStat label={t('history.received')} value={hideBalances ? '•••' : `+${fmtFiat(month.received, cur, { decimals: 0 })}`} tone="text-up" />
              <MonthStat label={t('history.sent')} value={hideBalances ? '•••' : `−${fmtFiat(month.sent, cur, { decimals: 0 })}`} />
              <MonthStat label={t('history.fees')} value={hideBalances ? '•••' : fmtFiat(month.fees, cur)} />
            </div>
            {pending > 0 && <span className="text-[12px] text-faint">{tp('history.pendingCount', pending)}</span>}
          </section>
          <Approvals />
        </div>
      </div>
      {replacing && (
        <ReplaceDialog
          entry={replacing.entry}
          mode={replacing.mode}
          onClose={(done) => {
            setReplacing(null);
            if (done) {
              history.reload();
              pf.refresh();
            }
          }}
        />
      )}
    </div>
  );
}

function MonthStat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex flex-col gap-1 px-3 py-3 first:pl-0">
      <span className="text-[12px] text-mute">{label}</span>
      <span className={cn('figure truncate text-[18px] tracking-[-0.03em]', tone)}>{value}</span>
    </div>
  );
}

interface LiveApproval extends ApprovalRecord {
  current: bigint;
}

function Approvals() {
  const { network } = useApp();
  const { adapters } = useVault();
  const pf = usePortfolio();
  const [revoking, setRevoking] = useState<LiveApproval | null>(null);
  const state = useAsync<LiveApproval[]>(
    async () => {
      const recs = getApprovals(network);
      const live = await Promise.all(
        recs.map(async (r) => {
          const ad = adapters.evm.get(r.chainKey);
          if (!ad) return { ...r, current: BigInt(r.amount) };
          try {
            return { ...r, current: await ad.allowance(r.token, r.spender) };
          } catch {
            return { ...r, current: BigInt(r.amount) };
          }
        }),
      );
      return live.filter((x) => x.current > 0n);
    },
    [network, adapters],
  );
  const list = state.data ?? [];
  const { t } = useT();
  const risky = list.filter((a) => isUnlimitedAllowance(a.current)).length;

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto rounded-panel border border-line bg-card px-[22px] py-[18px] scroll-thin">
      <div className="flex items-center justify-between">
        <span className="text-[15px] font-medium tracking-[-0.01em]">{t('history.activeApprovals')}</span>
        {risky > 0 && <Badge tone="down">{t('history.atRisk', { count: risky })}</Badge>}
      </div>
      {list.length > 0 && <p className="m-0 text-[13px] leading-[1.55] text-mute">{t('history.approvalsHint')}</p>}
      {state.loading && !state.data && <Skeleton className="h-24 w-full" />}
      {state.data && list.length === 0 && <EmptyState className="py-6" title={t('history.noApprovals')} />}
      {list.map((a) => {
        const unlimited = isUnlimitedAllowance(a.current);
        const asset = assetsFor(network).find((x) => x.contract?.toLowerCase() === a.token.toLowerCase());
        return (
          <div key={`${a.chainId}:${a.token}:${a.spender}`} className={cn('fade-in flex flex-col gap-2.5 rounded-box border border-l-2 px-4 py-3.5', unlimited ? 'border-down/35 border-l-down bg-down/[.04]' : 'border-line border-l-line-3')}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[14px] font-semibold">
                {a.tokenSymbol} → {a.spenderLabel}
              </span>
              <span className={cn('text-[13px] font-semibold', unlimited ? 'text-down' : 'text-text2')}>{unlimited ? t('history.unlimited') : fmtCrypto(a.current, a.tokenDecimals, a.tokenSymbol)}</span>
            </div>
            <span className="text-[12px] text-mute">
              {shortAddress(a.spender)} · {t('history.grantedOn', { date: fmtDate(a.time, { day: 'numeric', month: 'short' }) })} · {asset ? pf.holdings.find((h) => h.asset.id === asset.id) ? t('history.balanceExposed') : '' : ''}
            </span>
            <Button variant={unlimited ? 'danger' : 'outline'} size="md" onClick={() => setRevoking(a)}>
              {t('history.revoke')}
            </Button>
          </div>
        );
      })}
      {revoking && <RevokeDialog approval={revoking} onClose={(done) => { setRevoking(null); if (done) state.reload(); }} />}
    </section>
  );
}

function RevokeDialog({ approval, onClose }: { approval: LiveApproval; onClose: (done: boolean) => void }) {
  const { network } = useApp();
  const { adapters } = useVault();
  const [pw, setPw] = useState('');
  const [wrongPw, setWrongPw] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ad = adapters.evm.get(approval.chainKey);
  const token = findAsset(network, `erc20:${approval.chainId}:${approval.token.toLowerCase()}`);
  const { t } = useT();

  const revoke = async () => {
    if (!ad || !token) return;
    setBusy(true);
    setError(null);
    try {
      const fees = await ad.estimateFees();
      const fee = fees.options.normal.params;
      if (fee.family !== 'evm') throw new Error(t('history.feesUnavailable'));
      const call = buildRevoke(approval.token, approval.spender);
      const unsigned = await ad.buildCall({ to: call.to, data: call.data, fee, kind: 'approval', asset: token, amount: 0n, token: { symbol: token.symbol, decimals: token.decimals } });
      const decoded = await ad.decode(unsigned);
      if (decoded.kind !== 'Erc20Approve' || decoded.amount !== '0' || decoded.spender?.toLowerCase() !== approval.spender.toLowerCase()) throw new Error(t('history.unexpectedDecode'));
      const signed = await ad.signTx(unsigned, pw);
      const hash = await ad.broadcast(signed);
      removeApproval(network, approval.chainId, approval.token, approval.spender);
      addLocalTx({ id: hash, network, chainKey: approval.chainKey, assetId: token.id, kind: 'approval', direction: 'self', amount: '0', label: t('history.revokeLabel', { token: approval.tokenSymbol, spender: approval.spenderLabel }), time: Date.now(), status: 'pending' });
      onClose(true);
    } catch (e) {
      const err = toIpcError(e);
      if (err.code === 'WRONG_PASSWORD') setWrongPw((n) => n + 1);
      else setError(err.code === 'USER_REJECTED' ? t('history.signatureCancelled') : err.message);
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={() => !busy && onClose(false)} title={t('history.revokeTitle', { token: approval.tokenSymbol, spender: approval.spenderLabel })}>
      <p className="m-0 text-[13px] leading-[1.55] text-text2">
        {rt('history.revokeExplain', { code: (c) => <span className="font-mono">{c}</span> })}
      </p>
      <PasswordField id="revoke-pw" value={pw} onChange={setPw} autoFocus wrong={wrongPw} onEnter={() => pw && void revoke()} />
      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex justify-end gap-2">
        <Button onClick={() => onClose(false)} disabled={busy}>
          {t('common.cancel')}
        </Button>
        <Button variant="danger" disabled={!pw || busy || !token} onClick={() => void revoke()}>
          {busy && <Spinner />} {t('history.revoke')}
        </Button>
      </div>
    </Dialog>
  );
}

export { entryTitle };
